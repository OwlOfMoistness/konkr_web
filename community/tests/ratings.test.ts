import assert from 'node:assert/strict';
import { after, before, describe, it, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { Visitors } from '../api/visitors.ts';
import { Ratings } from '../api/ratings.ts';
import type { SupportedConfigurations } from '../shared/contracts.ts';

const url = process.env.CATALOG_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:5555';
describe('anonymous ratings', { skip: !url }, () => {
  let admin: Pool; let db: Pool; let visitors: Visitors; let ratings: Ratings;
  const schema = `ratings_${process.pid}`;
  const policy: SupportedConfigurations = { version: 1, configurations: [{ engineHash:'engine', difficulty:'hard', plugins:[], evidence:'test-only' }] };
  async function session() {
    const response = (await visitors.route(new Request(origin+'/api/visitor')))!;
    assert.equal(response.status,200);
    assert.match(response.headers.get('set-cookie')!,/HttpOnly; SameSite=Strict/);
    return { Cookie:response.headers.get('set-cookie')!.split(';')[0], 'X-CSRF-Token':(await response.json()).csrfToken as string };
  }
  const req = (headers:Record<string,string>, rating:unknown=5, map='map', revisionId='r1', method='PUT') => new Request(`${origin}/api/maps/${map}/ratings`, { method, headers:{Origin:origin,'Content-Type':'application/json',...headers}, body:method==='GET'?undefined:JSON.stringify({revisionId,rating}) });
  before(async () => {
    admin = new Pool({connectionString:url}); await admin.query(`CREATE SCHEMA ${schema}`);
    db = new Pool({connectionString:url,options:`-c search_path=${schema}`,max:5});
    for(const file of ['001-catalog','003-ratings']) await db.query(await readFile(new URL(`../db/${file}.sql`,import.meta.url),'utf8'));
    for(const id of ['map','draft','archived','unsupported']) {
      await db.query('INSERT INTO maps(id,title) VALUES($1,$1)',[id]);
      await db.query('INSERT INTO map_revisions(id,map_id,revision,content_hash,object_key,engine_hash,plugins,width,height) VALUES($1,$2,1,$3,$3,$4,$5,5,5)',[id==='map'?'r1':id+'-r1',id,'hash', 'engine',id==='unsupported'?['zombies']:[]]);
      await db.query("UPDATE maps SET current_revision_id=$2,state=$3,published_at=now() WHERE id=$1",[id,id==='map'?'r1':id+'-r1',id==='draft'?'draft':id==='archived'?'archived':'published']);
    }
    visitors = new Visitors(db,origin,'persistent-test-secret-'.repeat(3)); ratings = new Ratings(db,visitors,policy);
  });
  after(async()=>{await db?.end();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}});
  it('requires server-issued identity and CSRF without public sign-in',async()=>{
    const visitor=await session();
    assert.equal((await ratings.route(req({})))!.status,401);
    assert.equal((await ratings.route(req({...visitor,'X-CSRF-Token':'wrong'})))!.status,403);
    assert.equal((await ratings.route(req({...visitor,Origin:'https://evil.invalid'})))!.status,403);
    assert.equal((await visitors.route(new Request(origin+'/api/visitor',{headers:{'Sec-Fetch-Site':'cross-site'}})))!.status,403);
    const existing=(await visitors.route(new Request(origin+'/api/visitor',{headers:visitor})))!;
    assert.equal(existing.headers.get('set-cookie'),null);
    assert.equal((await existing.json()).csrfToken,visitor['X-CSRF-Token']);
  });
  it('keeps one editable vote per browser and handles concurrent replacements',async()=>{
    const first=await session();const second=await session();
    assert.equal((await ratings.route(req(first,5)))!.status,200);
    assert.equal((await ratings.route(req(first,3)))!.status,200);
    const result=(await ratings.route(req(second,5)))!;assert.deepEqual((await result.json()).rating,{average:4,count:2});
    const duplicate=await Promise.all([ratings.route(req(second,4)),ratings.route(req(second,4))]);assert.deepEqual(duplicate.map(r=>r!.status),[200,200]);
    const mine=(await ratings.route(req(first,null,'map','r1','GET')))!;const body=await mine.json();
    assert.equal(body.mine,3);assert.deepEqual(body.rating,{average:3.5,count:2});
    assert.equal((await db.query('SELECT count(*) FROM map_ratings')).rows[0].count,'2');
  });
  it('validates values, revision and publication/support boundaries',async()=>{
    const visitor=await session();
    for(const value of [0,6,2.5,'5',null])assert.equal((await ratings.route(req(visitor,value)))!.status,400);
    assert.equal((await ratings.route(req(visitor,5,'map','previous-revision')))!.status,409);
    for(const id of ['draft','archived','unsupported'])assert.equal((await ratings.route(req(visitor,5,id,id+'-r1')))!.status,404);
    assert.equal((await new Ratings(db,visitors,{version:1,configurations:[]}).route(req(visitor)))!.status,404);
  });
  it('bounds repeat writes and does not add votes on quota rejection',async()=>{
    const visitor=await session();
    for(let i=0;i<20;i++)assert.equal((await ratings.route(req(visitor)))!.status,200);
    assert.equal((await ratings.route(req(visitor,1)))!.status,429);
    assert.equal((await (await ratings.route(req(visitor,null,'map','r1','GET')))!.json()).mine,5);
  });
  it('keeps previous revision ratings separate from current revision',async()=>{
    const visitor=await session();
    await db.query("INSERT INTO map_revisions(id,map_id,revision,content_hash,object_key,engine_hash,width,height) VALUES('r2','map',2,'hash2','key2','engine',5,5)");
    await db.query("UPDATE maps SET current_revision_id='r2' WHERE id='map'");
    const current=(await ratings.route(req(visitor,null,'map','r2','GET')))!;
    assert.deepEqual((await current.json()).rating,{average:null,count:0});
    assert.equal((await ratings.route(req(visitor,4,'map','r1')))!.status,409);
    assert.equal((await ratings.route(req(visitor,4,'map','r2')))!.status,200);
    assert.equal((await db.query("SELECT count(*) FROM map_ratings WHERE revision_id='r1'")).rows[0].count,'3');
  });
});


declare global { interface Window {
  ratingRaceTest: { deliverVote: () => void; deliverCsrf?: () => void; posted?: { revisionId: string; rating: number } };
} }

test('saving a rating updates the catalog aggregate in place while preserving later edits across delayed requests', async () => {
  const bundle = await build({ stdin: { contents: `
    import {ratingControls} from './web/ratings.ts';
    import {mountCatalog} from './web/catalog.ts';
    const probe=window.ratingRaceTest={}; let sessionCalls=0;
    window.fetch=async (_url,init)=>{
      if(init?.method==='PUT') { probe.posted=JSON.parse(init.body); return Response.json({revisionId:'r1',rating:{average:probe.posted.rating,count:1}}); }
      return new Promise(resolve=>{probe.deliverVote=()=>resolve(Response.json({revisionId:'r1',mine:1}));});
    };
    const visitor={csrfToken(){return ++sessionCalls===1?Promise.resolve('test-csrf'):new Promise(resolve=>{probe.deliverCsrf=()=>resolve('test-csrf');});}};
    const entry={map:{id:'map',metadata:{title:'Rating island',creator:'Community',description:'',tags:[]}},revision:{id:'r1',revision:1,width:6,height:6},rating:{average:null,count:0},scores:[{difficulty:'normal',engineHash:'fixture',completions:1,bestTurns:1}],previewUrl:null};
    mountCatalog(document.querySelector('main'),{reader:{async list(){return {entries:[entry],total:1};},async get(){return entry;}},storage:null,onPlay(){},verifiedResultsEnabled:true,renderDetailActions:ratingControls(visitor)});
  `, loader: 'ts', resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, write: false, format: 'iife', platform: 'browser' });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<main></main>'); await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByRole('button', { name: 'Rating island', exact: true }).click();
    await page.getByText('No ratings yet', { exact: true }).waitFor();
    const originalSelect = await page.getByLabel('Your rating').elementHandle();
    await page.waitForFunction(() => !!window.ratingRaceTest.deliverVote);
    await page.getByLabel('Your rating').selectOption('5');
    await page.evaluate(async () => { window.ratingRaceTest.deliverVote(); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(await page.getByLabel('Your rating').inputValue(), '5', 'A stale existing vote must not overwrite the current edit');
    await page.getByRole('button', { name: 'Save rating' }).click();
    await page.waitForFunction(() => !!window.ratingRaceTest.deliverCsrf);
    await page.getByLabel('Your rating').selectOption('2');
    await page.evaluate(() => window.ratingRaceTest.deliverCsrf!());
    await page.getByRole('status').filter({ hasText: 'Saved.' }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.ratingRaceTest.posted), { revisionId: 'r1', rating: 5 });
    assert.equal(await page.getByLabel('Your rating').inputValue(), '2', 'The later edit remains available for a separate save');
    assert.equal(await originalSelect!.evaluate(node => node.isConnected), true, 'The control is updated without being rebuilt');
    await page.getByText('5.0 / 5 · 1 rating', { exact: true }).waitFor();
    await page.getByText('Saved. 5.0 average from 1 rating.', { exact: true }).waitFor();
    await page.getByText('Normal: 1 finish · best 1 turn', { exact: true }).waitFor();
    await page.getByRole('button', { name: '← All maps', exact: true }).click();
    await page.getByText('5.0 / 5 · 1 rating', { exact: true }).waitFor();
    await page.getByText('1 verified finish', { exact: true }).waitFor();
  } finally { await browser.close(); }
});
