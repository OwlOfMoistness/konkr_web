import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { Pool } from 'pg';
import { CuratorAuth, developmentIdentityProvider } from '../api/admin-auth.ts';
import { MapsAdmin } from '../api/maps-admin.ts';
import { PublicationService } from '../api/publication.ts';
import { PostgresCatalogReader } from '../api/catalog.ts';
import { decodeKonkrData } from '../engine/map-format.ts';
import type { ObjectStorage } from '../shared/contracts.ts';

const url = process.env.CATALOG_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:5555';
const raw = (id: string) => ({ version: 7, map: { width: 5, height: 5, levelId: id, name: id, plugins: [] }, regions: [{ id: 1, hexes: [101, 102] }], factions: [{ id: 0, controller: 'none', themeIndex: 0, regions: [] }, { id: 1, controller: 'local-user', themeIndex: 0, regions: [1] }], pawns: [{ id: 1, type: 'town', hex: 101 }], currentPhase: { type: 'faction-turn', turnNumber: 1, faction: 1, tappedUnits: [] }, hexHistory: {} });
const encode = (v: unknown) => 'konkrmap.v7.' + Buffer.from(JSON.stringify(v)).toString('base64');

describe('private draft uploads and revision changes', { skip: !url }, () => {
  let admin: Pool; let db: Pool; let service: MapsAdmin; let headers: Record<string,string>;
  const schema = `map_import_${process.pid}`; const objects = new Map<string, { bytes: Uint8Array; contentType: string }>(); let failStorage = false;
  const storage: ObjectStorage = { async put(key, bytes, contentType) { if (failStorage) throw new Error('Storage unavailable'); objects.set(key, { bytes, contentType }); }, async get(key) { return objects.get(key) ?? null; }, async delete(key) { objects.delete(key); } };
  const req = (path: string, method = 'GET', data?: unknown, authenticated = true) => new Request(origin + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', ...(authenticated ? headers : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
  const upload = async (encoded: string) => (await service.route(req('/api/admin/maps', 'POST', { encoded })))!;
  before(async () => {
    admin = new Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    db = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 4 });
    for (const name of ['001-catalog','002-curators','005-map-import']) await db.query(await readFile(new URL(`../db/${name}.sql`, import.meta.url), 'utf8'));
    await db.query("INSERT INTO curators(id,role) VALUES('curator','curator')");
    const key = 'test-curator-credential-'.repeat(3);
    const auth = new CuratorAuth(db, developmentIdentityProvider([{ id: 'curator', key }]), origin);
    const login = (await auth.route(req('/api/admin/session', 'POST', { credential: key }, false)))!;
    headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0], 'X-CSRF-Token': (await login.json()).csrfToken };
    service = new MapsAdmin(db, storage, auth, 'pinned-engine');
  });
  after(async () => { await db?.end(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } });
  it('requires a curator and rejects malformed/executable maps before storage', async () => {
    assert.equal((await service.route(req('/api/admin/maps', 'POST', { encoded: encode(raw('no-auth')) }, false)))!.status, 401);
    const scripted = raw('scripted'); Object.assign(scripted.map, { script: 'fetch("evil")' });
    for (const encoded of ['invalid', encode(scripted)]) assert.equal((await upload(encoded)).status, 400);
    assert.equal(objects.size, 0);
    assert.equal((await service.route(req('/api/admin/maps', 'GET', undefined, false)))!.status, 401);
  });
  it('imports private immutable bytes, rejects duplicates and reports embedded identity collisions', async () => {
    const encoded = encode(raw('one')); const response = await upload(encoded); assert.equal(response.status, 201);
    const first = await response.json(); assert.equal(first.map.state, 'draft'); assert.equal(first.revisions[0].revision, 1);
    assert.equal(Buffer.from(objects.get(first.revisions[0].object_key)!.bytes).toString(), encoded);
    assert.equal((await upload(encoded)).status, 409);
    const copy = raw('one'); copy.map.name = 'A different file with a shared embedded ID';
    const second = await upload(encode(copy)); assert.equal(second.status, 201); assert.equal((await second.json()).warnings.length, 1);
    const concurrent = await Promise.all([upload(encode(raw('concurrent'))), upload(encode(raw('concurrent')))]);
    assert.deepEqual(concurrent.map(r => r.status).sort(), [201,409]);
  });
  it('uploads and publishes Twin Continents without changing its map bytes or dimensions', async () => {
    const fixture = JSON.parse(await readFile(new URL('fixtures/twin-continents.json', import.meta.url), 'utf8'));
    const response = await upload(fixture.encodedMap); assert.equal(response.status, 201);
    const imported = await response.json(); const revision = imported.revisions[0];
    assert.deepEqual([revision.width, revision.height, revision.content_hash], [16, 13, fixture.sha256]);
    assert.equal(Buffer.from(objects.get(revision.object_key)!.bytes).toString('utf8'), fixture.encodedMap);
    const policy = { version: 1 as const, configurations: [{ engineHash: 'pinned-engine', difficulty: 'hard' as const, plugins: [], evidence: 'import regression test only' }] };
    const publication = new PublicationService(service, policy);
    const published = (await publication.route(req(`/api/admin/maps/${imported.map.id}/publication`, 'POST', {
      expectedVersion: imported.map.version, state: 'published',
    })))!;
    assert.equal(published.status, 200);
    assert.equal((await new PostgresCatalogReader(db, policy).get(imported.map.id))?.map.metadata.title, 'Twin Continents');
  });
  it('keeps metadata edits distinct and protects against concurrent stale edits', async () => {
    const data = await (await upload(encode(raw('metadata')))).json(); const id = data.map.id; const revision = data.map.current_revision_id;
    const metadata = { title: '<img onerror=evil>', description: 'literal text', creator: 'Map author', tags: ['#Xmas'] };
    const body = { expectedVersion: data.map.version, metadata };
    const responses = await Promise.all([service.route(req(`/api/admin/maps/${id}`, 'PATCH', body)), service.route(req(`/api/admin/maps/${id}`, 'PATCH', body))]);
    assert.deepEqual(responses.map(r => r!.status).sort(), [200,409]);
    const current = await service.detail(id); assert.equal(current.map.current_revision_id, revision); assert.deepEqual(current.map.tags, ['xmas']);
    assert.equal(current.revisions.length, 1); assert.equal(current.map.creator, 'Map author');
    assert.equal((await db.query('SELECT actor_id FROM curator_audit WHERE target_id=$1', [id])).rows[0].actor_id, 'curator');
  });
  it('revisions return to draft while retaining historical results and rejects stale upload versions', async () => {
    let data = await (await upload(encode(raw('revision')))).json(); const id = data.map.id; const oldRevision = data.map.current_revision_id;
    await db.query("UPDATE maps SET state='published',published_at=now() WHERE id=$1", [id]);
    await db.query('INSERT INTO map_ratings(revision_id,browser_token_hash,rating) VALUES($1,$2,5)', [oldRevision, 'visitor']);
    data = await service.detail(id); const changed = raw('revision'); changed.pawns[0].hex = 102;
    const response = (await service.route(req(`/api/admin/maps/${id}/revisions`, 'POST', { encoded: encode(changed), expectedVersion: data.map.version })))!;
    assert.equal(response.status, 201); const revised = await response.json(); assert.equal(revised.map.state, 'draft');
    assert.equal(revised.revisions.length, 2); assert.equal(revised.revisions[0].revision, 2);
    assert.notEqual(revised.map.current_revision_id, oldRevision);
    assert.equal((await db.query('SELECT count(*) FROM map_ratings WHERE revision_id=$1', [oldRevision])).rows[0].count, '1');
    assert.equal((await service.route(req(`/api/admin/maps/${id}/revisions`, 'POST', { encoded: encode(raw('changed-again')), expectedVersion: data.map.version })))!.status, 409);
  });
  it('rolls back database state when object storage fails', async () => {
    const before = (await db.query('SELECT count(*) FROM maps')).rows[0].count;
    failStorage = true; assert.equal((await upload(encode(raw('storage-failed')))).status, 503); failStorage = false;
    assert.equal((await db.query('SELECT count(*) FROM maps')).rows[0].count, before);
  });
  it('imports both user maps when the explicitly supplied fixture path is available', async t => {
    if (!process.env.KONKR_FIXTURE_DIR) return t.skip('Set KONKR_FIXTURE_DIR for supplied-map tests');
    for (const name of ['prison','escalating-quickly']) {
      const encoded = await readFile(`${process.env.KONKR_FIXTURE_DIR}/${name}.konkr`, 'utf8');
      const response = await upload(encoded); assert.equal(response.status, 201);
      const actual = await response.json(); const expected = decodeKonkrData(encoded) as any;
      assert.deepEqual(actual.revisions[0].plugins, expected.map.plugins ?? []);
      assert.equal(actual.map.title, expected.map.name);
    }
  });
  it('uploads batches without screenshots and keeps browser previews independent of publication', {timeout:60_000}, async () => {
    let auth: CuratorAuth; let browserMaps: MapsAdmin; let publication: PublicationService;
    const policy = {version:1 as const,configurations:[{engineHash:'pinned-engine',difficulty:'hard' as const,plugins:[],evidence:'test-only'}]};
    const source = `import {mountAdmin} from './web/admin.ts'; import {mountMapEditor} from './web/map-editor.ts'; import {publicationControls} from './web/publication.ts';
      const root=document.querySelector('main');mountAdmin(root,(client)=>{
        const back=document.createElement('button');back.textContent='Curated maps';const editor=document.createElement('section');root.replaceChildren(back,editor);
        const maps=mountMapEditor(editor,client,{renderPublication:publicationControls(client,{mountPreview(frame,detail){
          let disposed=false;
          const ready=fetch('/api/admin/maps/'+detail.map.id+'/file').then(async response=>{
            if(!response.ok)throw new Error('Client preview unavailable');const encoded=await response.text();
            if(!encoded.startsWith('konkrmap.v7.'))throw new Error('Invalid map');
            if(!disposed){frame.textContent='Live map preview';frame.setAttribute('role','img');frame.setAttribute('aria-label','Map preview: '+detail.map.title);}
          });return {ready,destroy(){disposed=true;frame.removeAttribute('role');frame.removeAttribute('aria-label');}};
        }})});back.onclick=()=>void maps.showList();
      });`;
    const bundle = await build({stdin:{contents:source,resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'ts'},bundle:true,write:false,format:'iife',platform:'browser'});
    const css = (await Promise.all(['theme','admin'].map(name=>readFile(new URL(`../web/${name}.css`,import.meta.url),'utf8')))).join('\n');
    let previewGate: Promise<void> | undefined; let releasePreview: (() => void) | undefined;
    let uploadGate: Promise<void> | undefined; let releaseUpload: (() => void) | undefined;
    let screenshotRequests=0; const failedPreviewTitles=new Set(['client-preview-fail']);
    const server = createServer((incoming,outgoing)=>{void(async()=>{
      if(!incoming.url?.startsWith('/api/')){outgoing.writeHead(200,{'Content-Type':'text/html'});outgoing.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#193847}${css}</style><main></main><script>${bundle.outputFiles[0].text}</script>`);return;}
      const chunks:Buffer[]=[];for await(const chunk of incoming)chunks.push(Buffer.from(chunk));
      const request = new Request(`http://${incoming.headers.host}${incoming.url}`,{method:incoming.method,headers:incoming.headers as Record<string,string>,body:['GET','HEAD'].includes(incoming.method!)?undefined:Buffer.concat(chunks)});
      if(incoming.url.endsWith('/preview'))screenshotRequests++;
      if(incoming.url.endsWith('/file')&&incoming.method==='GET'){
        const map=await browserMaps.detail(incoming.url.split('/')[4]);
        if(failedPreviewTitles.has(map.map.title)){outgoing.writeHead(503,{'Content-Type':'application/json'});outgoing.end(JSON.stringify({error:'Client preview unavailable'}));return;}
        await previewGate;
      }
      if(incoming.url==='/api/admin/maps'&&incoming.method==='POST'){
        const body=JSON.parse(Buffer.concat(chunks).toString());
        if(typeof body.encoded==='string'&&body.encoded.startsWith('konkrmap.v7.')&&(decodeKonkrData(body.encoded) as any).map.levelId==='batch-hold')await uploadGate;
      }
      const response=await auth.route(request)??await browserMaps.route(request)??await publication.route(request);
      outgoing.writeHead(response?.status??404,response?Object.fromEntries(response.headers):{});outgoing.end(response?Buffer.from(await response.arrayBuffer()):'');
    })().catch(()=>outgoing.writeHead(500).end());});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
    const key='browser-test-curator-'.repeat(3);auth=new CuratorAuth(db,developmentIdentityProvider([{id:'curator',key}]),base);
    browserMaps=new MapsAdmin(db,storage,auth,'pinned-engine');
    publication=new PublicationService(browserMaps,policy);
    const browser=await chromium.launch({headless:true});
    try{
      const page=await browser.newPage({viewport:{width:1024,height:900}});const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
      await page.goto(base+'/admin/maps');await page.getByLabel('Curator access key').fill(key);await page.getByRole('button',{name:'Sign in',exact:true}).click();
      const fixture = (id: string, name = id) => { const data=raw(id); data.map.name=name; return {name:id+'.konkr',mimeType:'application/octet-stream',buffer:Buffer.from(encode(data))}; };
      await page.getByLabel('Add .konkr maps').setInputFiles(fixture('Browser draft'));
      await page.getByText(/Browser draft.konkr: Invalid level ID/).waitFor();
      previewGate = new Promise<void>(resolve => { releasePreview = resolve; });
      await page.getByLabel('Add .konkr maps').setInputFiles(fixture('browser-map','Browser draft'));
      await page.getByRole('heading',{name:'Browser draft',exact:true}).waitFor();
      await page.getByLabel('Title',{exact:true}).fill('Curator browser map');await page.getByLabel('Creator',{exact:true}).fill('Example creator');
      await page.getByLabel('Tags (comma separated)').fill('#Xmas, island');
      assert.equal(await page.getByRole('checkbox').count(),0);
      assert.equal(await page.getByRole('button',{name:'Publish',exact:true}).isEnabled(),true);
      // Publish saves the current fields first and uses the resulting version.
      await page.getByRole('button',{name:'Publish',exact:true}).click();await page.locator('.admin-map-state').getByText('Published',{exact:true}).waitFor();
      await page.getByRole('heading',{name:'Curator browser map',exact:true}).waitFor();
      releasePreview!(); previewGate=undefined;
      await page.getByRole('img',{name:'Map preview: Browser draft'}).waitFor();
      assert.equal(await page.getByLabel('Title',{exact:true}).inputValue(),'Curator browser map');
      const publicEntry=(await new PostgresCatalogReader(db,policy).list({search:'Curator browser map'})).entries[0];assert.ok(publicEntry);assert.deepEqual(publicEntry.map.metadata.tags,['xmas','island']);
      assert.equal(publicEntry.map.metadata.creator,'Example creator');
      await page.getByRole('button',{name:'← Curated maps',exact:true}).click();
      const publishedRow=page.locator('.admin-map-list li').filter({has:page.getByRole('button',{name:'Curator browser map',exact:true})});
      await publishedRow.getByText('Published',{exact:true}).waitFor();
      await publishedRow.getByRole('button').click();await page.getByRole('button',{name:'Archive',exact:true}).click();
      await page.locator('.admin-map-state').getByText('Archived',{exact:true}).waitFor();
      assert.equal(await new PostgresCatalogReader(db,policy).get(publicEntry.map.id),null);
      // Navigating away during preview must not reopen the departed editor.
      await page.getByRole('button',{name:'← Curated maps',exact:true}).click();
      previewGate = new Promise<void>(resolve => { releasePreview = resolve; });
      await page.getByLabel('Add .konkr maps').setInputFiles(fixture('leave-during-preview'));
      await page.getByRole('heading',{name:'leave-during-preview',exact:true}).waitFor();
      await page.getByRole('button',{name:'← Curated maps',exact:true}).click();
      const completedPreview=page.waitForResponse(response=>response.url().endsWith('/file')&&response.request().method()==='GET');
      releasePreview!(); previewGate=undefined; await completedPreview;
      await page.getByRole('heading',{name:'Curated maps',exact:true}).waitFor();
      assert.equal(await page.getByLabel('Title',{exact:true}).count(),0);
      // Each batch item gets a result and a later file still succeeds after errors.
      uploadGate=new Promise<void>(resolve=>{releaseUpload=resolve;});
      await page.getByLabel('Add .konkr maps').setInputFiles([
        fixture('batch-first'),{name:'invalid.konkr',mimeType:'application/octet-stream',buffer:Buffer.from('invalid')},
        fixture('batch-first'),fixture('batch-hold'),fixture('batch-last'),
      ]);
      const results=page.getByRole('list',{name:'Upload results'});
      await results.getByText('batch-hold.konkr: uploading…',{exact:true}).waitFor();
      assert.equal(await results.getByRole('button',{name:'Edit map',exact:true}).first().isDisabled(),true);
      assert.equal(await page.getByRole('button',{name:'Curator browser map',exact:true}).isDisabled(),true);
      await page.getByRole('button',{name:'Curated maps',exact:true}).click();
      releaseUpload!(); uploadGate=undefined;
      await page.getByRole('status').filter({hasText:'Uploads finished.'}).waitFor();
      assert.equal(await results.getByRole('button',{name:'Edit map',exact:true}).first().isEnabled(),true);
      assert.equal(await results.locator('li').count(),5);
      assert.match(await results.innerText(),/batch-first.konkr: draft ready/);
      assert.match(await results.innerText(),/exact file already belongs/);
      assert.match(await results.innerText(),/batch-hold.konkr: draft ready/);
      assert.match(await results.innerText(),/batch-last.konkr: draft ready/);
      assert.equal((await new PostgresCatalogReader(db,policy).list({search:'batch-'})).total,0);
      await page.getByLabel('Add .konkr maps').setInputFiles(fixture('client-preview-fail'));
      await page.getByRole('button',{name:'Retry preview',exact:true}).waitFor();
      assert.equal(await page.getByRole('button',{name:'Publish',exact:true}).isEnabled(),true);
      await page.getByRole('button',{name:'Publish',exact:true}).click();await page.locator('.admin-map-state').getByText('Published',{exact:true}).waitFor();
      failedPreviewTitles.clear(); await page.getByRole('button',{name:'Retry preview',exact:true}).click();
      await page.getByRole('img',{name:'Map preview: client-preview-fail'}).waitFor();
      await page.getByLabel('Creator',{exact:true}).fill('Saved separately');await page.getByRole('button',{name:'Save metadata',exact:true}).click();
      await page.getByRole('status').filter({hasText:'Map details saved.'}).waitFor();
      assert.equal(screenshotRequests,0);
      await page.setViewportSize({width:320,height:800});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      assert.deepEqual(errors,[]);
    }finally{await browser.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
});
