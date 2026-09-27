import assert from 'node:assert/strict';
import { after, before, describe, it, test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { CuratorAuth, developmentIdentityProvider } from '../api/admin-auth.ts';
import { MapsAdmin } from '../api/maps-admin.ts';
import { PublicationService } from '../api/publication.ts';
import { PostgresCatalogReader } from '../api/catalog.ts';
import { BrowserPreviewRenderer } from '../runtime/preview.ts';
import { prepareRuntime } from '../scripts/prepare-runtime.ts';
import type { ObjectStorage, SupportedConfigurations } from '../shared/contracts.ts';

const url = process.env.CATALOG_TEST_DATABASE_URL; const origin = 'http://127.0.0.1:5555';
const sample = { version: 7, map: { width: 5, height: 5, levelId: 'publish-test', name: 'Publish test', plugins: [] }, regions: [{ id: 1, hexes: [101, 102] }], factions: [{ id: 0, controller: 'none', themeIndex: 0, regions: [] }, { id: 1, controller: 'local-user', themeIndex: 0, regions: [1] }], pawns: [{ id: 1, type: 'town', hex: 101 }], currentPhase: { type: 'faction-turn', turnNumber: 1, faction: 1, tappedUnits: [] }, hexHistory: {} };
const encode = (value: unknown) => 'konkrmap.v7.' + Buffer.from(JSON.stringify(value)).toString('base64');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==','base64');

describe('publication gates and retained history', { skip: !url }, () => {
  let admin: Pool; let db: Pool; let maps: MapsAdmin; let service: PublicationService; let headers: Record<string,string>;
  let rendererFails = false; const schema = `publication_${process.pid}`;
  const objects = new Map<string,{bytes:Uint8Array;contentType:string}>();
  const storage: ObjectStorage = { async put(key,bytes,contentType) { objects.set(key,{bytes,contentType}); }, async get(key) { return objects.get(key) ?? null; }, async delete(key) { objects.delete(key); } };
  const policy: SupportedConfigurations = { version:1,configurations:[{engineHash:'engine',difficulty:'hard',plugins:[],evidence:'test-only'}] };
  const req = (id: string, action: string, data?: unknown) => new Request(`${origin}/api/admin/maps/${id}/${action}`, { method: data === undefined ? 'GET' : 'POST', headers: { Origin:origin,'Content-Type':'application/json',...headers }, body:data === undefined ? undefined : JSON.stringify(data) });
  const upload = async (value = sample) => {
    const response = await maps.route(new Request(origin+'/api/admin/maps',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify({encoded:encode(value)})}));
    assert.equal(response!.status,201); return (await response!.json()).map;
  };
  before(async () => {
    admin = new Pool({ connectionString:url }); await admin.query(`CREATE SCHEMA ${schema}`);
    db = new Pool({ connectionString:url,options:`-c search_path=${schema}` });
    for (const file of ['001-catalog','002-curators','005-map-import']) await db.query(await readFile(new URL(`../db/${file}.sql`,import.meta.url),'utf8'));
    await db.query("INSERT INTO curators(id,role) VALUES('editor','curator')");
    const key = 'publication-editor-'.repeat(3); const auth = new CuratorAuth(db,developmentIdentityProvider([{id:'editor',key}]),origin);
    const login = (await auth.route(new Request(origin+'/api/admin/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({credential:key})})))!;
    headers = {Cookie:login.headers.get('set-cookie')!.split(';')[0],'X-CSRF-Token':(await login.json()).csrfToken};
    maps = new MapsAdmin(db,storage,auth,'engine'); service = new PublicationService(maps,policy,{async render() { if(rendererFails) throw new Error('render failed'); return png; }});
  });
  after(async () => { await db?.end(); if(admin) {await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();} });
  it('publishes supported previewed maps directly without claiming manual playtesting',async () => {
    const map = await upload(); const publish = {expectedVersion:map.version,state:'published'};
    assert.equal((await service.route(req(map.id,'publication',publish)))!.status,409);
    rendererFails = true; assert.equal((await service.route(req(map.id,'preview',{expectedVersion:map.version})))!.status,503);
    assert.equal((await maps.detail(map.id)).revisions[0].preview_key,null);
    rendererFails = false; assert.equal((await service.route(req(map.id,'preview',{expectedVersion:map.version})))!.status,200);
    assert.equal((await service.route(req(map.id,'publication',{...publish,playtested:true})))!.status,400);
    const published = (await service.route(req(map.id,'publication',publish)))!;
    assert.equal(published.status,200); assert.equal((await published.json()).map.state,'published');
    assert.equal((await service.route(req(map.id,'publication',publish)))!.status,409);
    assert.equal((await new PostgresCatalogReader(db,policy).list({})).total,1);
    assert.equal((await service.route(req(map.id,'preview')))!.headers.get('content-type'),'image/png');
    assert.equal(await (await service.route(req(map.id,'file')))!.text(),encode(sample));
    const current = (await maps.detail(map.id)).map;
    assert.equal((await service.route(req(map.id,'publication',{expectedVersion:current.version,state:'archived'})))!.status,200);
    assert.equal((await new PostgresCatalogReader(db,policy).list({})).total,0);
    assert.ok(objects.has((await maps.detail(map.id)).revisions[0].object_key));
    const audit = (await db.query("SELECT details FROM curator_audit WHERE action='publish'")).rows;
    assert.equal(audit.length,1); assert.equal(Object.hasOwn(audit[0].details,'playtested'),false);
  });
  it('fails closed with empty support policy and refuses stale versions',async () => {
    const map = await upload({...sample,map:{...sample.map,name:'unsupported'}});
    const closed = new PublicationService(maps,{version:1,configurations:[]},{async render(){throw new Error('must not render');}});
    assert.equal((await closed.route(req(map.id,'preview',{expectedVersion:map.version})))!.status,422);
    assert.equal((await service.route(req(map.id,'preview',{expectedVersion:'0'})))!.status,409);
    assert.equal((await closed.route(req(map.id,'publication',{expectedVersion:map.version,state:'published'})))!.status,422);
    assert.equal((await service.route(req(map.id,'publication',{expectedVersion:'0',state:'published'})))!.status,409);
    const missingCsrf = req(map.id,'publication',{expectedVersion:map.version,state:'published'}); missingCsrf.headers.delete('X-CSRF-Token');
    assert.equal((await service.route(missingCsrf))!.status,403);
    const stranger = new Request(origin+`/api/admin/maps/${map.id}/file`); assert.equal((await service.route(stranger))!.status,401);
  });
  it('refuses damaged stored content before runtime import',async () => {
    const map = await upload({...sample,map:{...sample.map,name:'damaged'}}); const revision = (await maps.detail(map.id)).revisions[0];
    await storage.put(revision.object_key,Buffer.from(encode({...sample,map:{...sample.map,name:'tampered'}})),'application/vnd.konkr.map');
    assert.equal((await service.route(req(map.id,'preview',{expectedVersion:map.version})))!.status,503);
  });
});

test('fixed renderer makes local previews for both supplied maps without external traffic', {timeout:100_000}, async t => {
  const directory = process.env.KONKR_FIXTURE_DIR; if(!directory) return t.skip('Set KONKR_FIXTURE_DIR for actual sample preview generation');
  const runtime = await prepareRuntime(); const renderer = new BrowserPreviewRenderer(runtime,30_000);
  for (const name of ['prison','escalating-quickly']) {
    const bytes = await renderer.render(await readFile(`${directory}/${name}.konkr`,'utf8'),'hard');
    assert.ok(bytes.length > 10_000); assert.ok(bytes.length < 2_000_000); assert.deepEqual([...bytes.subarray(0,8)],[137,80,78,71,13,10,26,10]);
    if(process.env.KONKR_PREVIEW_OUTPUT) await writeFile(`${process.env.KONKR_PREVIEW_OUTPUT}/${name}-preview.png`,bytes);
  }
});
