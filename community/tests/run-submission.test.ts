import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { Runs, digest } from '../api/runs.ts';
import { Visitors } from '../api/visitors.ts';
import { hashSecret } from '../api/admin-auth.ts';
import { developmentIdentityProvider } from '../api/admin-auth.ts';
import { createCommunityServer } from '../api/server.ts';
import { ValidationWorker } from '../worker/validate-job.ts';
import type { ObjectStorage, RunBinding, SupportedConfigurations } from '../shared/contracts.ts';

const url=process.env.CATALOG_TEST_DATABASE_URL;
const origin='http://127.0.0.1:5555';
describe('server-bound run submission',{skip:!url},()=>{
  const schema=`runs_${process.pid}`;
  let admin:Pool;let db:Pool;let visitors:Visitors;let runs:Runs;
  const objects=new Map<string,{bytes:Uint8Array;contentType:string}>();let failWrite=false;
  const storage:ObjectStorage={async get(key){return objects.get(key)??null;},async put(key,bytes,contentType){if(failWrite)throw new Error('disk failure');objects.set(key,{bytes,contentType});},async delete(key){objects.delete(key);}};
  const policy:SupportedConfigurations={version:1,configurations:[{engineHash:'engine',difficulty:'hard',plugins:[],evidence:'test-only'}]};
  const service=(options={})=>new Runs(db,storage,visitors,policy,{engineHash:'engine',adapterVersion:'adapter',submissionsEnabled:true,...options});
  type Session=Record<string,string>;
  const request=(path:string,headers:Session,body?:unknown,method=body===undefined?'GET':'POST')=>new Request(origin+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  async function session():Promise<Session>{const response=(await visitors.route(new Request(origin+'/api/visitor')))!;return {Cookie:response.headers.get('set-cookie')!.split(';')[0],'X-CSRF-Token':(await response.json()).csrfToken};}
  async function issue(headers:Session):Promise<RunBinding>{const response=(await runs.route(request('/api/runs',headers,{mapId:'map',revisionId:'r1',difficulty:'hard'})))!;assert.equal(response.status,201);return (await response.json()).binding;}
  const submit=(binding:RunBinding,key=binding.id)=>({version:1,runId:binding.id,idempotencyKey:key,decisions:[{kind:'end-turn'}]});
  before(async()=>{
    admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA ${schema}`);
    db=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:10});
    for(const name of ['001-catalog','003-ratings','004-runs'])await db.query(await readFile(new URL(`../db/${name}.sql`,import.meta.url),'utf8'));
    await db.query("INSERT INTO maps(id,title) VALUES('map','Map'),('draft','Draft'),('unsupported','Unsupported')");
    for(const id of ['map','draft','unsupported']){
      await db.query('INSERT INTO map_revisions(id,map_id,revision,content_hash,object_key,engine_hash,plugins,width,height) VALUES($1,$2,1,$3,$4,$5,$6,5,5)',[id==='map'?'r1':id+'-r1',id,digest(id),'maps/'+id,'engine',id==='unsupported'?['zombies']:[]]);
      await db.query("UPDATE maps SET current_revision_id=$2,state=$3,published_at=now() WHERE id=$1",[id,id==='map'?'r1':id+'-r1',id==='draft'?'draft':'published']);
      await storage.put('maps/'+id,Buffer.from(id),'text/plain');
    }
    visitors=new Visitors(db,origin,'test-csrf-secret-'.repeat(4));runs=service();
  });
  after(async()=>{await db?.end();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}});
  it('binds only supported current published revisions, owner and server expiry',async()=>{
    const owner=await session();const binding=await issue(owner);
    assert.deepEqual([binding.mapId,binding.revisionId,binding.mapHash,binding.engineHash,binding.adapterVersion,binding.plugins],['map','r1',digest('map'),'engine','adapter',[]]);
    assert.equal(Date.parse(binding.expiresAt)-Date.parse(binding.issuedAt),30*86400_000);
    assert.equal((await runs.route(request('/api/runs',{},{})))!.status,401);
    assert.equal((await runs.route(request('/api/runs',{...owner,Origin:'https://evil.invalid'},{})))!.status,403);
    for(const [body,status] of [[{mapId:'map',revisionId:'r0',difficulty:'hard'},409],[{mapId:'draft',revisionId:'draft-r1',difficulty:'hard'},404],[{mapId:'unsupported',revisionId:'unsupported-r1',difficulty:'hard'},422],[{mapId:'map',revisionId:'r1',difficulty:'normal'},422],[{mapId:'map',revisionId:'r1',difficulty:'hard',engineHash:'forged'},400]] as const)assert.equal((await runs.route(request('/api/runs',owner,body)))!.status,status);
    const another=await session();assert.equal((await runs.route(request(`/api/runs/${binding.id}`,another)))!.status,404);
    assert.equal((await runs.route(request(`/api/runs/${binding.id}/map`,another)))!.status,404);
    assert.deepEqual(await (await runs.route(request(`/api/runs/${binding.id}`,owner)))!.json(),{binding,result:null});
    await assert.rejects(db.query("UPDATE runs SET binding='{}' WHERE id=$1",[binding.id]),/immutable/);
  });
  it('starts bound gameplay with submissions disabled without accepting results or starting validation',async()=>{
    const owner=await session();const stopped=service({submissionsEnabled:false});
    const response=(await stopped.route(request('/api/runs',owner,{mapId:'map',revisionId:'r1',difficulty:'hard'})))!;
    assert.equal(response.status,201);
    const binding:RunBinding=(await response.json()).binding;
    assert.deepEqual([binding.mapId,binding.revisionId,binding.mapHash,binding.difficulty],['map','r1',digest('map'),'hard']);
    assert.equal(await (await stopped.route(request(`/api/runs/${binding.id}/map`,owner)))!.text(),'map');
    assert.equal((await stopped.route(request(`/api/runs/${binding.id}/submission`,owner,submit(binding))))!.status,503);
    assert.deepEqual((await db.query('SELECT state,submission_key,result,counted FROM runs WHERE id=$1',[binding.id])).rows[0],{state:'issued',submission_key:null,result:null,counted:false});
    assert.equal((await stopped.route(request('/api/runs',{},{})))!.status,401);
    assert.equal((await stopped.route(request('/api/runs',owner,{mapId:'unsupported',revisionId:'unsupported-r1',difficulty:'hard'})))!.status,422);
    // A queued run from an earlier enabled deployment must remain untouched too.
    const queued=await issue(owner);assert.equal((await runs.route(request(`/api/runs/${queued.id}/submission`,owner,submit(queued))))!.status,202);
    const worker=new ValidationWorker(db,storage,{async validate(){throw new Error('Disabled worker must not validate');}},{pollMs:1});
    const app=await createCommunityServer({db,storage,origin,csrfSecret:'test-csrf-secret-'.repeat(4),identityProvider:developmentIdentityProvider([{id:'local-curator',key:'test-curator-key-'.repeat(4)}]),flags:{customMaps:true,submissions:false,verifiedResults:false},worker});
    try{
      app.startWorker();
      await new Promise(resolve=>setTimeout(resolve,20));
      assert.equal(worker.health().running,false);assert.equal(worker.health().lastPollAt,null);
      assert.equal((await db.query('SELECT state FROM runs WHERE id=$1',[queued.id])).rows[0].state,'queued');
      assert.equal((await db.query('SELECT count(*) FROM map_score_buckets')).rows[0].count,'0');
    }finally{await app.close();}
  });
  it('accepts exact concurrent retries once and rejects altered bodies, keys and snapshots',async()=>{
    const owner=await session();const binding=await issue(owner);const body=submit(binding);
    const responses=await Promise.all([runs.route(request(`/api/runs/${binding.id}/submission`,owner,body)),runs.route(request(`/api/runs/${binding.id}/submission`,owner,body))]);
    assert.deepEqual(responses.map(r=>r!.status),[202,202]);
    assert.equal((await db.query('SELECT attempts,state FROM runs WHERE id=$1',[binding.id])).rows[0].state,'queued');
    assert.equal([...objects.keys()].filter(key=>key.startsWith(`submissions/${binding.id}/`)).length,1);
    for(const altered of [{...body,decisions:[]},{...body,idempotencyKey:'changed'}])assert.equal((await runs.route(request(`/api/runs/${binding.id}/submission`,owner,altered)))!.status,409);
    for(const altered of [{...body,snapshot:{}},{...body,decisions:[{kind:'end-turn',noCost:true}]},{...body,runId:'other'}])assert.equal((await runs.route(request(`/api/runs/${binding.id}/submission`,owner,altered)))!.status,400);
    const second=await issue(owner);assert.equal((await runs.route(request(`/api/runs/${second.id}/submission`,owner,submit(second,binding.id))))!.status,409);
    const stopped=service({submissionsEnabled:false});assert.equal((await stopped.route(request(`/api/runs/${binding.id}/submission`,owner,body)))!.status,202);
    assert.equal((await stopped.route(request(`/api/runs/${second.id}/submission`,owner,submit(second))))!.status,503);
    assert.equal((await db.query('SELECT count(*) FROM map_score_buckets')).rows[0].count,'0');
  });
  it('does not enqueue failed blobs or overfull queues; exact retries recover',async()=>{
    const owner=await session();const binding=await issue(owner);const body=submit(binding);
    failWrite=true;try{assert.equal((await runs.route(request(`/api/runs/${binding.id}/submission`,owner,body)))!.status,503);}finally{failWrite=false;}
    assert.equal((await db.query('SELECT state FROM runs WHERE id=$1',[binding.id])).rows[0].state,'issued');
    assert.equal((await service({queueLimit:1}).route(request(`/api/runs/${binding.id}/submission`,owner,body)))!.status,503);
    assert.equal((await runs.route(request(`/api/runs/${binding.id}/submission`,owner,body)))!.status,202);
    await assert.rejects(db.query("UPDATE runs SET submission_hash='changed' WHERE id=$1",[binding.id]),/immutable/);
  });
  it('bounds body/decision payloads and starts per visitor',async()=>{
    const owner=await session();const binding=await issue(owner);
    assert.equal((await runs.route(request(`/api/runs/${binding.id}/submission`,owner,{...submit(binding),decisions:Array(25_001).fill({kind:'end-turn'})})))!.status,400);
    assert.equal((await runs.route(request(`/api/runs/${binding.id}/submission`,owner,{...submit(binding),padding:'x'.repeat(2_000_000)})))!.status,413);
    for(let i=1;i<30;i++)await issue(owner);
    assert.equal((await runs.route(request('/api/runs',owner,{mapId:'map',revisionId:'r1',difficulty:'hard'})))!.status,429);
  });
  it('rejects expired unsubmitted runs but retains readable history',async()=>{
    const owner=await session();const binding=await issue(owner);const old={...binding,id:'expired',issuedAt:'2020-01-01T00:00:00Z',expiresAt:'2020-01-31T00:00:00Z'};
    await db.query('INSERT INTO runs(id,browser_token_hash,revision_id,binding,expires_at) VALUES($1,$2,$3,$4,$5)',[old.id,hashSecret(owner.Cookie.split('=')[1]),old.revisionId,JSON.stringify(old),old.expiresAt]);
    assert.equal((await runs.route(request('/api/runs/expired/submission',owner,submit(old))))!.status,410);
    assert.equal((await runs.route(request('/api/runs/expired/map',owner)))!.status,410);
    assert.equal((await runs.route(request('/api/runs/expired',owner)))!.status,200);
  });
  it('retains owned pinned files after archive while removing public access and new starts',async()=>{
    const owner=await session();const binding=await issue(owner);
    assert.equal(await (await runs.route(request('/api/maps/map/file?revision=r1',owner)))!.text(),'map');
    await db.query("UPDATE maps SET state='archived' WHERE id='map'");
    assert.equal((await runs.route(request('/api/maps/map/file?revision=r1',owner)))!.status,404);
    assert.equal((await runs.route(request('/api/runs',owner,{mapId:'map',revisionId:'r1',difficulty:'hard'})))!.status,404);
    assert.equal(await (await runs.route(request(`/api/runs/${binding.id}/map`,owner)))!.text(),'map');
    assert.equal((await runs.route(request(`/api/runs/${binding.id}/submission`,owner,submit(binding))))!.status,202);
    objects.set('maps/map',{bytes:Buffer.from('changed'),contentType:'text/plain'});
    assert.equal((await runs.route(request(`/api/runs/${binding.id}/map`,owner)))!.status,503);
  });
});
