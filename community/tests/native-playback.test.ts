import assert from 'node:assert/strict';
import { after, before, describe, it, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { CuratorAuth, developmentIdentityProvider } from '../api/admin-auth.ts';
import { MapsAdmin } from '../api/maps-admin.ts';
import { PublicationService } from '../api/publication.ts';
import { InMemoryCatalogReader, PostgresCatalogReader } from '../api/catalog.ts';
import { Ratings } from '../api/ratings.ts';
import { Runs } from '../api/runs.ts';
import { Visitors } from '../api/visitors.ts';
import { parseMap } from '../engine/map-format.ts';
import { NATIVE_MAP_PLUGINS, supportsPlayback } from '../shared/native-playback.ts';
import type { NativePlaybackPolicy } from '../shared/native-playback.ts';
import type { ObjectStorage, SupportedConfigurations } from '../shared/contracts.ts';

const origin = 'http://127.0.0.1:5555';
const strict: SupportedConfigurations = { version: 1, configurations: [{ engineHash: 'engine', difficulty: 'hard', plugins: [], evidence: 'test-only' }] };
const native: NativePlaybackPolicy = { engineHash: 'engine', plugins: NATIVE_MAP_PLUGINS };
const sample = (plugins: readonly string[]) => ({ version: 7, map: { width: 5, height: 5, levelId: 'native-test', name: 'Native map', plugins }, regions: [{ id: 1, hexes: [101, 102] }], factions: [{ id: 0, controller: 'none', themeIndex: 0, regions: [] }, { id: 1, controller: 'local-user', themeIndex: 0, regions: [1] }], pawns: [{ id: 1, type: 'town', hex: 101 }], currentPhase: { type: 'faction-turn', turnNumber: 1, faction: 1, tappedUnits: [] }, hexHistory: {} });
const encode = (value: unknown) => 'konkrmap.v7.' + Buffer.from(JSON.stringify(value)).toString('base64');

test('native playback allows only pinned browser rules without widening replay support', () => {
  assert.equal(NATIVE_MAP_PLUGINS.length, 8);
  assert.deepEqual(parseMap(encode(sample(NATIVE_MAP_PLUGINS))).plugins, [...NATIVE_MAP_PLUGINS]);
  for (const mode of ['normal','hard'] as const) assert.equal(supportsPlayback(strict, 'engine', mode, ['capture-towns'], native), true);
  assert.equal(supportsPlayback(strict, 'engine', 'hard', ['capture-towns']), false);
  assert.equal(supportsPlayback(strict, 'other-engine', 'hard', ['capture-towns'], native), false);
  assert.equal(supportsPlayback(strict, 'engine', 'hard', ['capture-towns','capture-towns'], native), false);
  assert.equal(supportsPlayback(strict, 'engine', 'hard', ['unknown'], { engineHash: 'engine', plugins: ['unknown'] }), false);
  assert.throws(() => parseMap(encode(sample(['unknown']))), /Unsupported plugin/);
});

const url = process.env.CATALOG_TEST_DATABASE_URL;
describe('native browser play while replay verification is parked', { skip: !url }, () => {
  const schema = `native_playback_${process.pid}`;
  let admin: Pool; let db: Pool; let maps: MapsAdmin; let visitors: Visitors; let curator: Record<string,string>; let player: Record<string,string>;
  const objects = new Map<string,{bytes:Uint8Array;contentType:string}>();
  const storage: ObjectStorage = { async get(key) { return objects.get(key) ?? null; }, async put(key,bytes,contentType) { objects.set(key,{bytes,contentType}); }, async delete(key) { objects.delete(key); } };
  const request = (path: string, headers: Record<string,string>, body?: unknown, method = body === undefined ? 'GET' : 'POST') => new Request(origin+path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  before(async () => {
    admin = new Pool({connectionString:url}); await admin.query(`CREATE SCHEMA ${schema}`);
    db = new Pool({connectionString:url,options:`-c search_path=${schema}`});
    for (const name of ['001-catalog','002-curators','003-ratings','004-runs','005-map-import']) await db.query(await readFile(new URL(`../db/${name}.sql`,import.meta.url),'utf8'));
    await db.query("INSERT INTO curators(id,role) VALUES('curator','curator')");
    const key='native-test-credential-'.repeat(3); const auth = new CuratorAuth(db,developmentIdentityProvider([{id:'curator',key}]),origin);
    const login=(await auth.route(request('/api/admin/session',{}, {credential:key})))!;
    curator={Cookie:login.headers.get('set-cookie')!.split(';')[0],'X-CSRF-Token':(await login.json()).csrfToken};
    maps=new MapsAdmin(db,storage,auth,'engine'); visitors=new Visitors(db,origin,'native-test-csrf-'.repeat(4));
    const session=(await visitors.route(new Request(origin+'/api/visitor')))!;
    player={Cookie:session.headers.get('set-cookie')!.split(';')[0],'X-CSRF-Token':(await session.json()).csrfToken};
  });
  after(async()=>{await db?.end();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}});
  it('publishes, lists, rates and starts capture-towns without PNGs, but never validates those runs',async()=>{
    const encoded=encode(sample(['capture-towns']));
    const upload=(await maps.route(request('/api/admin/maps',curator,{encoded})))!;assert.equal(upload.status,201);
    const detail=await upload.json();const id=detail.map.id;const revisionId=detail.map.current_revision_id;
    const publicationBody={expectedVersion:detail.map.version,state:'published'};
    assert.equal((await new PublicationService(maps,strict).route(request(`/api/admin/maps/${id}/publication`,curator,publicationBody)))!.status,422);
    assert.equal((await new PublicationService(maps,strict,native).route(request(`/api/admin/maps/${id}/publication`,curator,publicationBody)))!.status,200);
    assert.equal((await maps.detail(id)).revisions[0].preview_key,null);
    assert.equal([...objects.keys()].some(key=>key.startsWith('previews/')),false);
    assert.equal(await new PostgresCatalogReader(db,strict).get(id),null);
    const catalog=new PostgresCatalogReader(db,strict,{nativePlayback:native,verifiedResultsEnabled:true});
    const entry=(await catalog.get(id))!;assert.ok(entry);assert.equal(entry.previewUrl,null);
    for(const difficulty of ['normal','hard'] as const)assert.equal((await catalog.list({difficulty})).total,1);
    await db.query('INSERT INTO map_score_buckets(revision_id,difficulty,engine_hash,completions,best_turns) VALUES($1,$2,$3,9,1)',[revisionId,'hard','engine']);
    assert.deepEqual((await catalog.get(id))!.scores,[]);
    entry.scores=[{difficulty:'hard',engineHash:'engine',completions:9,bestTurns:1}];
    assert.deepEqual((await new InMemoryCatalogReader([entry],strict,{nativePlayback:native,verifiedResultsEnabled:true}).get(id))!.scores,[]);
    const rating={revisionId,rating:5};
    assert.equal((await new Ratings(db,visitors,strict).route(request(`/api/maps/${id}/ratings`,player,rating,'PUT')))!.status,404);
    assert.equal((await new Ratings(db,visitors,strict,native).route(request(`/api/maps/${id}/ratings`,player,rating,'PUT')))!.status,200);
    const stopped=new Runs(db,storage,visitors,strict,{engineHash:'engine',adapterVersion:'adapter',submissionsEnabled:false,nativePlayback:native});
    const enabled=new Runs(db,storage,visitors,strict,{engineHash:'engine',adapterVersion:'adapter',submissionsEnabled:true,nativePlayback:native});
    for(const difficulty of ['normal','hard'] as const){
      const body={mapId:id,revisionId,difficulty};
      assert.equal((await enabled.route(request('/api/runs',player,body)))!.status,422);
      const issued=(await stopped.route(request('/api/runs',player,body)))!;assert.equal(issued.status,201);const binding=(await issued.json()).binding;
      const submission={version:1,runId:binding.id,idempotencyKey:binding.id,decisions:[{kind:'end-turn'}]};
      assert.equal((await stopped.route(request(`/api/runs/${binding.id}/submission`,player,submission)))!.status,503);
      assert.equal((await enabled.route(request(`/api/runs/${binding.id}/submission`,player,submission)))!.status,422);
      assert.equal(await (await stopped.route(request(`/api/runs/${binding.id}/map`,player)))!.text(),encoded);
    }
    assert.equal(await (await stopped.route(request(`/api/maps/${id}/file?revision=${revisionId}`,{})))!.text(),encoded);
    assert.equal((await enabled.route(request(`/api/maps/${id}/file?revision=${revisionId}`,{})))!.status,404);
    assert.equal((await db.query("SELECT count(*) FROM runs WHERE state <> 'issued' OR counted")).rows[0].count,'0');
    assert.equal([...objects.keys()].some(key=>key.startsWith('submissions/')),false);
  });
  it('SQL catalogue and run files reject unknown engines, plugins and duplicate plugins',async()=>{
    for(const [id,engine,plugins] of [['wrong-engine','other',['capture-towns']],['unknown','engine',['unknown']],['duplicate','engine',['capture-towns','capture-towns']]] as const){
      await db.query('INSERT INTO maps(id,title) VALUES($1,$1)',[id]);
      await db.query('INSERT INTO map_revisions(id,map_id,revision,content_hash,object_key,engine_hash,plugins,width,height) VALUES($1,$2,1,$3,$3,$4,$5,5,5)',[id+'-revision',id,'hash',engine,plugins]);
      await db.query("UPDATE maps SET current_revision_id=$2,state='published',published_at=now() WHERE id=$1",[id,id+'-revision']);
      assert.equal(await new PostgresCatalogReader(db,strict,{nativePlayback:native}).get(id),null);
      const runs=new Runs(db,storage,visitors,strict,{engineHash:'engine',adapterVersion:'adapter',submissionsEnabled:false,nativePlayback:native});
      assert.equal((await runs.route(request('/api/runs',player,{mapId:id,revisionId:id+'-revision',difficulty:'hard'})))!.status,422);
      assert.equal((await runs.route(request(`/api/maps/${id}/file?revision=${id}-revision`,{})))!.status,404);
    }
    assert.equal((await new PostgresCatalogReader(db,strict,{nativePlayback:native}).list({})).total,1);
  });
});
