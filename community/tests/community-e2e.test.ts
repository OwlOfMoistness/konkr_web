import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import { createCommunityServer, migrate } from '../api/server.ts';
import { developmentIdentityProvider } from '../api/admin-auth.ts';
import { LocalObjectStorage } from '../api/storage.ts';
import { NodeSimulationAdapter } from '../engine/validate.ts';
import { ValidationWorker } from '../worker/validate-job.ts';
import type { SupportedConfigurations } from '../shared/contracts.ts';

const database=process.env.CATALOG_TEST_DATABASE_URL;
test('pinned help pages load through HTTP and help and isolated preview HTML allow same-origin framing',{timeout:30_000},async()=>{
  // These public static/config routes must not need a database connection.
  const db=new Pool({connectionString:'postgresql://unused@127.0.0.1:1/unused'});
  const directory=await mkdtemp(path.join(tmpdir(),'konkr-community-help-'));
  let app:Awaited<ReturnType<typeof createCommunityServer>>|undefined;
  try{
    const reservation=createServer();await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve));const address=reservation.address();assert(address&&typeof address!=='string');const port=address.port;await new Promise<void>(resolve=>reservation.close(()=>resolve()));
    const origin=`http://127.0.0.1:${port}`;
    app=await createCommunityServer({db,storage:new LocalObjectStorage(directory),origin,csrfSecret:'help-test-csrf-'.repeat(4),identityProvider:developmentIdentityProvider([{id:'local-curator',key:'help-test-curator-'.repeat(4)}]),flags:{customMaps:true,submissions:false,verifiedResults:false}});
    await new Promise<void>(resolve=>app!.server.listen(port,'127.0.0.1',resolve));
    const expected=await readFile(new URL('../../_site/releases/2.35.30/assets/html/help/index.html',import.meta.url),'utf8');
    const help=await fetch(origin+'/assets/html/help/');
    assert.equal(help.status,200);assert.equal(help.headers.get('content-type'),'text/html');assert.equal(await help.text(),expected);
    for(const name of ['', 'index.html','how-to-play.html','advanced.html','modes.html']){
      const response=await fetch(origin+'/assets/html/help/'+name);
      assert.equal(response.status,200);assert.match(response.headers.get('content-security-policy')!,/frame-ancestors 'self';/);
      assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    }
    const animation=await fetch(origin+'/assets/html/help/img/bandits.gif');
    assert.equal(animation.status,200);assert.equal(animation.headers.get('content-type'),'image/gif');
    assert.match(Buffer.from(await animation.arrayBuffer()).subarray(0,6).toString(),/^GIF8[79]a$/);
    for(const [pathname,status]of [['/',200],['/admin/maps',200],['/api/config',200],['/assets/html/login-buttons.html',200],['/assets/html/help/missing.html',404],['/assets/html/',404],['/unknown',404]] as const){
      const response=await fetch(origin+pathname);assert.equal(response.status,status);
      assert.match(response.headers.get('content-security-policy')!,/frame-ancestors 'none';/);
    }
    const preview=await fetch(origin+'/community-preview');assert.equal(preview.status,200);
    assert.match(preview.headers.get('content-security-policy')!,/frame-ancestors 'self';/);
    assert.ok(preview.headers.get('content-security-policy')!.includes(`connect-src ${origin}/assets/;`));
    assert.equal((await fetch(origin+'/api/previews/retired.png')).status,410);
    const rejected=await fetch(origin+'/assets/html/help/',{method:'POST'});
    assert.equal(rejected.status,405);assert.match(rejected.headers.get('content-security-policy')!,/frame-ancestors 'none';/);
  }finally{await app?.close();await db.end();await rm(directory,{recursive:true,force:true});}
});

test('complete local curator → original game → verified score → rating → archive flow',{skip:!database,timeout:180_000},async()=>{
  const schema=`e2e_${process.pid}`;const admin=new Pool({connectionString:database});let db:Pool|undefined;
  const directory=await mkdtemp(path.join(tmpdir(),'konkr-community-e2e-'));
  let app:Awaited<ReturnType<typeof createCommunityServer>>|undefined;let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);db=new Pool({connectionString:database,options:`-c search_path=${schema}`,max:10});
    const reservation=createServer();await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve));const address=reservation.address();assert(address&&typeof address!=='string');const port=address.port;await new Promise<void>(resolve=>reservation.close(()=>resolve()));
    const origin=`http://127.0.0.1:${port}`;const key='e2e-local-curator-'.repeat(3);
    const policy=JSON.parse(await readFile(new URL('../shared/supported-configurations.json',import.meta.url),'utf8')) as SupportedConfigurations;
    const storage=new LocalObjectStorage(directory);
    const adapter=new NodeSimulationAdapter({policy,timeoutMs:120_000,memoryMb:512});
    const worker=new ValidationWorker(db,storage,adapter,{pollMs:100,retryBaseMs:100});
    app=await createCommunityServer({db,storage,origin,csrfSecret:'e2e-persistent-csrf-'.repeat(3),identityProvider:developmentIdentityProvider([{id:'local-curator',key}]),flags:{customMaps:true,submissions:true,verifiedResults:true},worker});
    await new Promise<void>(resolve=>app!.server.listen(port,'127.0.0.1',resolve));
    assert.equal((await fetch(origin+'/readyz')).status,503,'An empty reachable database is not ready');
    await migrate(db);await migrate(db);assert.equal((await db.query('SELECT count(*) FROM community_migrations')).rows[0].count,'5');
    await db.query("INSERT INTO curators(id,role) VALUES('local-curator','admin')");
    assert.equal((await fetch(origin+'/readyz')).status,503,'An intake service without a healthy worker is not ready');
    worker.start();
    for(let attempt=0;attempt<20;attempt++){if((await fetch(origin+'/readyz')).status===200)break;await new Promise(resolve=>setTimeout(resolve,50));}
    assert.equal((await fetch(origin+'/readyz')).status,200);
    assert.equal((await fetch(origin+'/api/admin/metrics')).status,401);
    for(const privatePath of ['/.env','/tests/fixtures/base-cases.json','/db/004-runs.sql','/node_modules/pg/package.json','/api/server.ts','/.runtime/2.35.30/.preparation.json'])assert.equal((await fetch(origin+privatePath)).status,404);
    const home=await fetch(origin);assert.match(home.headers.get('content-security-policy')!,/connect-src 'self'/);assert.equal(home.headers.get('cache-control'),'no-store');
    browser=await chromium.launch({args:['--enable-unsafe-swiftshader','--use-angle=swiftshader']});
    const errors:string[]=[];const external:string[]=[];
    const curatorContext=await browser.newContext({viewport:{width:1100,height:950},serviceWorkers:'block'});
    const playerContext=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});
    for(const context of [curatorContext,playerContext])await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());return route.abort();}return route.continue();});
    const curator=await curatorContext.newPage();curator.on('pageerror',error=>errors.push(error.message));
    await curator.goto(origin+'/admin/maps');await curator.getByLabel('Curator access key').fill(key);await curator.getByRole('button',{name:'Sign in',exact:true}).click();
    const corpus=JSON.parse(await readFile(new URL('fixtures/base-cases.json',import.meta.url),'utf8'));
    const fixture=corpus.cases.find((entry:any)=>entry.id==='tiny-win-hard');
    await curator.getByLabel('Add .konkr maps').setInputFiles({name:'island.konkr',mimeType:'application/octet-stream',buffer:Buffer.from(fixture.encodedMap)});
    await curator.getByLabel('Title',{exact:true}).fill('Integration island');await curator.getByLabel('Creator',{exact:true}).fill('Community test');await curator.getByLabel('Tags (comma separated)').fill('#island');
    await curator.getByRole('button',{name:'Save metadata',exact:true}).click();await curator.getByRole('heading',{name:'Integration island',exact:true}).waitFor();
    await curator.locator('.admin-preview-frame[data-live-preview-ready="true"]').waitFor({timeout:35_000});
    await curator.locator('iframe[data-community-preview="live"]').waitFor({state:'visible'});
    await curator.frameLocator('iframe[data-community-preview="live"]').locator('#phaser-game canvas').waitFor({state:'visible'});
    assert.equal(await curator.getByRole('checkbox',{name:/I have playtested/}).count(),0);await curator.getByRole('button',{name:'Publish',exact:true}).click();await curator.locator('.admin-map-state').filter({hasText:'Published'}).waitFor();
    if(process.env.KONKR_E2E_SCREENSHOTS)await curator.screenshot({path:path.join(process.env.KONKR_E2E_SCREENSHOTS,'community-workshop-desktop.png')});
    await curator.setViewportSize({width:320,height:740});
    await curator.locator('.admin-preview-frame').scrollIntoViewIfNeeded();
    assert.ok((await curator.locator('.admin-preview-frame').boundingBox())!.height>=180);
    await curator.locator('iframe[data-community-preview="live"]').waitFor({state:'visible'});
    assert.equal(await curator.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    if(process.env.KONKR_E2E_SCREENSHOTS)await curator.screenshot({path:path.join(process.env.KONKR_E2E_SCREENSHOTS,'community-workshop-mobile.png'),fullPage:true});
    await curator.setViewportSize({width:1100,height:950});
    const entry=(await (await fetch(origin+'/api/maps')).json()).entries[0];assert.equal(entry.previewUrl,null);assert.equal((await db.query('SELECT count(*) FROM map_revisions WHERE preview_key IS NOT NULL')).rows[0].count,'0');
    const player=await playerContext.newPage();player.on('pageerror',error=>errors.push(error.message));
    await player.goto(origin+'/?view=community#unchanged');const publicURL=player.url();
    await player.getByRole('button',{name:'Custom Maps',exact:true}).click({timeout:30_000});
    await player.getByRole('button',{name:'Integration island',exact:true}).click();
    await player.locator('.catalog-preview-large[data-live-preview-ready="true"]').waitFor({timeout:35_000});
    await player.locator('iframe[data-community-preview="live"]').waitFor({state:'visible'});
    await player.frameLocator('iframe[data-community-preview="live"]').locator('#phaser-game canvas').waitFor({state:'visible'});
    if(process.env.KONKR_E2E_SCREENSHOTS)await player.screenshot({path:path.join(process.env.KONKR_E2E_SCREENSHOTS,'community-catalog-desktop.png')});
    assert.equal(await player.getByRole('radiogroup',{name:'Your rating'}).count(),0,'Rating is offered only after playing');
    await player.getByRole('radio',{name:'Hard',exact:true}).click();await player.getByRole('button',{name:'Play map',exact:true}).click();
    await player.waitForFunction(()=>window.communityReference.inspect().screen==='Play'&&document.getElementById('catalog-root')!.hidden);
    const binding=(await db.query('SELECT binding FROM runs')).rows[0].binding;
    assert.equal(binding.difficulty,'hard');assert.equal(binding.revisionId,entry.revision.id);
    await player.evaluate(()=>window.communityReference.play('MovePawn',{pawnId:3,destinationHexId:303,tapUnit:false}));
    await player.waitForFunction(()=>window.communityReference.inspect().screen==='Victory'&&window.communityReference.withEngine(load=>!load(55151).app.navigator.transitionInProgress));
    await player.evaluate(()=>window.communityReference.act('Escape'));
    await player.getByRole('heading',{name:'Custom Maps',exact:true}).waitFor();
    assert.equal(await player.getByText(/^Saved games and results/).count(),0);
    await player.locator('.catalog-detail').getByRole('img',{name:'Hard completed on this browser',exact:true}).waitFor();
    await player.waitForFunction(async id=>(await (await fetch('/api/maps/'+id)).json()).scores.some((score:any)=>score.difficulty==='hard'&&score.completions===1),entry.map.id,{timeout:30_000});
    const row=(await db.query('SELECT state,result,counted FROM runs WHERE id=$1',[binding.id])).rows[0];assert.equal(row.state,'complete');assert.equal(row.result.status,'verified');assert.equal(row.result.turns,1);assert.equal(row.counted,true);
    const score=(await (await fetch(origin+'/api/maps/'+entry.map.id)).json()).scores;assert.deepEqual(score,[{difficulty:'hard',engineHash:binding.engineHash,completions:1,bestTurns:1}]);
    await player.getByRole('button',{name:'Integration island',exact:true}).click();
    await player.getByRole('radio',{name:'5 stars',exact:true}).click();await player.getByRole('status').filter({hasText:'5.0 average from 1 rating'}).waitFor();
    await player.locator('.catalog-detail .catalog-rating').filter({hasText:'5.0 / 5 · 1 rating'}).waitFor();
    await player.setViewportSize({width:375,height:812});assert.equal(await player.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    if(process.env.KONKR_E2E_SCREENSHOTS)await player.screenshot({path:path.join(process.env.KONKR_E2E_SCREENSHOTS,'community-detail-mobile.png')});
    assert.equal(player.url(),publicURL);
    const metrics=await curatorContext.request.get(origin+'/api/admin/metrics');assert.equal(metrics.status(),200);assert.ok((await metrics.json()).api.requests>0);
    await curator.getByRole('button',{name:'Archive',exact:true}).click();await curator.locator('.admin-map-state').filter({hasText:'Archived'}).waitFor();
    assert.equal((await fetch(origin+'/api/maps/'+entry.map.id)).status,404);assert.equal(entry.previewUrl,null);
    assert.equal((await db.query('SELECT completions FROM map_score_buckets')).rows[0].completions,'1');
    let limited=0;for(let index=0;index<121;index++){const response=await fetch(origin+'/api/runs',{method:'POST'});if(response.status===429)limited++;else assert.equal(response.status,401);}
    assert.ok(limited>0,'Malformed unauthenticated writes are bounded before body parsing');
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(await player.evaluate(()=>window.communityReference.blockedRequests),[]);
  }finally{await browser?.close();await app?.close();await db?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();await rm(directory,{recursive:true,force:true});}
});
