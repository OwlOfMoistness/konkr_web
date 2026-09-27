import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createHmac } from 'node:crypto';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Pool } from 'pg';
import { build } from 'esbuild';
import { prepareRuntime, communityRoot } from '../scripts/prepare-runtime.ts';
import { PINNED_RELEASE, ADAPTER_VERSION } from '../engine/platform.ts';
import { NodeSimulationAdapter, DEFAULT_VALIDATOR_RESOURCES } from '../engine/validate.ts';
import { ValidationWorker } from '../worker/validate-job.ts';
import type { ObjectStorage, SupportedConfigurations } from '../shared/contracts.ts';
import { CuratorAuth, developmentIdentityProvider, adminResponse, errorResponse, AdminError } from './admin-auth.ts';
import type { CuratorIdentityProvider } from './admin-auth.ts';
import { MapsAdmin } from './maps-admin.ts';
import { PublicationService } from './publication.ts';
import { BrowserPreviewRenderer } from '../runtime/preview.ts';
import { Visitors } from './visitors.ts';
import { Ratings } from './ratings.ts';
import { Runs, digest } from './runs.ts';
import { LocalObjectStorage } from './storage.ts';
import { PostgresCatalogReader, createCatalogRoute } from './catalog.ts';

export interface CommunityFlags { customMaps: boolean; submissions: boolean; verifiedResults: boolean }
export interface CommunityWorker { start():void; stop():Promise<void>; health():{healthy:boolean} }
export interface ServerOptions {
  db:Pool; storage:ObjectStorage; origin:string; csrfSecret:string; identityProvider:CuratorIdentityProvider;
  flags:CommunityFlags; worker?:CommunityWorker;
}
const CSP="default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self'; frame-src 'self'; frame-ancestors 'none'; worker-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'";
const MIME:Record<string,string>={'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.xml':'application/xml','.wav':'audio/wav','.mp3':'audio/mpeg','.ogg':'audio/ogg','.woff':'font/woff','.woff2':'font/woff2'};

/** Applies only checked-in migrations; marker and DDL commit together. Never rewrites an applied migration. */
export async function migrate(db:Pool):Promise<void> {
  const client=await db.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended('community:migrations:v1',0))");
    await client.query('CREATE TABLE IF NOT EXISTS community_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    const directory=path.join(communityRoot,'db');
    for (const name of (await readdir(directory)).filter(name=>/^\d{3}-[a-z-]+\.sql$/.test(name)).sort()) {
      const sql=await readFile(path.join(directory,name),'utf8');const hash=digest(sql);
      const existing=(await client.query('SELECT sha256 FROM community_migrations WHERE name=$1',[name])).rows[0];
      if (existing) { if(existing.sha256!==hash)throw new Error(`Applied migration checksum changed: ${name}`);continue; }
      // Existing files have their own transaction wrapper; remove only that wrapper.
      if (!/^BEGIN;\s/.test(sql) || !/COMMIT;\s*$/.test(sql)) throw new Error('Migration transaction wrapper missing');
      await client.query('BEGIN');
      try { await client.query(sql.replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,''));await client.query('INSERT INTO community_migrations(name,sha256) VALUES($1,$2)',[name,hash]);await client.query('COMMIT'); }
      catch(error) {await client.query('ROLLBACK');throw error;}
    }
  } finally {await client.query("SELECT pg_advisory_unlock(hashtextextended('community:migrations:v1',0))");client.release();}
}

/** No arbitrary filesystem serving: all URLs come from the pinned manifest or explicit addon assets. */
export async function createCommunityServer(options:ServerOptions) {
  const origin=new URL(options.origin).origin;
  const runtime=await prepareRuntime();
  const manifest=JSON.parse(await readFile(path.join(communityRoot,'runtime/manifest.json'),'utf8'));
  const policy=JSON.parse(await readFile(path.join(communityRoot,'shared/supported-configurations.json'),'utf8')) as SupportedConfigurations;
  const output=path.join(communityRoot,'.web');await mkdir(output,{recursive:true});
  await build({entryPoints:[path.join(communityRoot,'web/main.ts')],outfile:path.join(output,'community.js'),bundle:true,platform:'browser',format:'iife',target:'es2023'});
  const staticFiles=new Map<string,string>(Object.keys(manifest.files).map(file=>['/'+file,path.join(runtime,file)]));
  staticFiles.set('/bootstrap.js',path.join(runtime,'bootstrap.js'));
  staticFiles.set('/community.js',path.join(output,'community.js'));staticFiles.set('/community.css',path.join(output,'community.css'));
  const adminHTML=await readFile(path.join(communityRoot,'web/index.html'),'utf8');
  const playerHTML=adminHTML.replace('<!-- COMMUNITY_RUNTIME -->',`<script defer src="/bootstrap.js"></script><script defer src="/${manifest.vendor}"></script><script defer src="/${manifest.main}"></script>`);
  const auth=new CuratorAuth(options.db,options.identityProvider,origin);
  const visitors=new Visitors(options.db,origin,options.csrfSecret);
  const maps=new MapsAdmin(options.db,options.storage,auth,PINNED_RELEASE.mainHash);
  const publication=new PublicationService(maps,policy,new BrowserPreviewRenderer(runtime,30_000));
  const ratings=new Ratings(options.db,visitors,policy);
  const runs=new Runs(options.db,options.storage,visitors,policy,{engineHash:PINNED_RELEASE.mainHash,adapterVersion:ADAPTER_VERSION,submissionsEnabled:options.flags.submissions});
  const catalog=new PostgresCatalogReader(options.db,policy,{verifiedResultsEnabled:options.flags.verifiedResults,previewUrl:key=>'/api/previews/'+encodeURIComponent(key)});
  const catalogRoute=createCatalogRoute(catalog);
  const limits=new Map<string,{expires:number;used:number}>();
  const metrics={requests:0,errors:0,totalLatencyMs:0,maxLatencyMs:0,limited:0};
  const migrationNames=(await readdir(path.join(communityRoot,'db'))).filter(name=>/^\d{3}-[a-z-]+\.sql$/.test(name));
  function admit(ip:string,scope:string,maximum:number,seconds:number):boolean {
    const now=Date.now();for(const [key,entry]of limits)if(entry.expires<=now)limits.delete(key);
    const key=createHmac('sha256',options.csrfSecret).update(scope+':'+ip).digest('hex');
    let entry=limits.get(key);if(!entry){if(limits.size>=10_000)return false;entry={expires:now+seconds*1000,used:0};limits.set(key,entry);}
    return ++entry.used<=maximum;
  }
  const dispatch=async(request:Request,ip:string):Promise<Response>=>{
    const url=new URL(request.url);
    if(url.pathname==='/healthz')return adminResponse({status:'ok'});
    if(url.pathname==='/readyz'){
      const migrated=Number((await options.db.query('SELECT count(*) FROM community_migrations WHERE name=ANY($1::text[])',[migrationNames])).rows[0].count)===migrationNames.length;
      // A reachable but unmigrated database is not a usable community service.
      await options.db.query('SELECT r.id FROM runs r JOIN map_revisions m ON m.id=r.revision_id LIMIT 0');
      const workerReady=!options.flags.submissions || options.worker?.health().healthy===true;
      return adminResponse({status:migrated&&workerReady?'ready':'unavailable',worker:workerReady},migrated&&workerReady?200:503);
    }
    if(url.pathname==='/api/admin/metrics'){
      await auth.require(request,'admin');
      const queue=(await options.db.query("SELECT state,count(*)::integer AS count,extract(epoch FROM now()-min(submitted_at)) AS oldest_seconds FROM runs WHERE state IN ('queued','running') GROUP BY state")).rows;
      return adminResponse({api:metrics,queue,worker:options.worker?.health()??null,memory:process.memoryUsage()});
    }
    // Apply before authentication/body parsing as malformed requests never consume transactional quotas.
    if(url.pathname.startsWith('/api/') && !['GET','HEAD'].includes(request.method) && !admit(ip,'api-write',120,60)){
      metrics.limited++;return adminResponse({error:'Too many requests. Please try again shortly.'},429,{'Retry-After':'60'});
    }
    if(url.pathname==='/api/visitor' && !admit(ip,'visitor',60,3600) || url.pathname==='/api/admin/session' && request.method==='POST' && !admit(ip,'login',10,900)){
      metrics.limited++;return adminResponse({error:'Too many requests. Please try again later.'},429,{'Retry-After':'900'});
    }
    if(url.pathname==='/api/config' && request.method==='GET')return adminResponse({flags:options.flags,engineHash:PINNED_RELEASE.mainHash,policy,runtime:{vendor:manifest.vendor,main:manifest.main}});
    if(url.pathname.startsWith('/api/previews/') && request.method==='GET'){
      let key:string;try{key=decodeURIComponent(url.pathname.slice('/api/previews/'.length));}catch{return new Response(null,{status:400});}
      const row=(await options.db.query("SELECT m.id FROM maps m JOIN map_revisions r ON r.id=m.current_revision_id WHERE m.state='published' AND r.preview_key=$1 LIMIT 1",[key])).rows[0];
      if(!row || !(await catalog.get(row.id)))return new Response(null,{status:404});
      const file=await options.storage.get(key);if(!file)return new Response(null,{status:503});
      return new Response(Buffer.from(file.bytes),{headers:{'Content-Type':'image/png','Cache-Control':'no-store'}});
    }
    for(const route of [auth.route.bind(auth),maps.route.bind(maps),publication.route.bind(publication),visitors.route.bind(visitors),ratings.route.bind(ratings),runs.route.bind(runs),catalogRoute]){
      const response=await route(request);if(response)return response;
    }
    if(request.method!=='GET' && request.method!=='HEAD')return new Response(null,{status:405});
    if(url.pathname==='/' || url.pathname==='/admin/maps')return new Response(url.pathname==='/'?playerHTML:adminHTML,{headers:{'Content-Type':'text/html; charset=utf-8'}});
    const filename=staticFiles.get(url.pathname);if(!filename)return new Response(null,{status:404});
    return new Response(await readFile(filename),{headers:{'Content-Type':MIME[path.extname(filename)]??'application/octet-stream'}});
  };
  const server=createServer((incoming,outgoing)=>{
    const start=performance.now();metrics.requests++;
    void (async()=>{
      // Host is never trusted for URL creation or cookie/CSRF policy. No forwarded-IP trust by default.
      const headers=new Headers();for(const [key,value] of Object.entries(incoming.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value);
      const target=incoming.url??'/';
      if(!target.startsWith('/') || target.startsWith('//') || headers.get('host')!==new URL(origin).host){outgoing.writeHead(400).end();return;}
      const method=incoming.method??'GET';
      const request=new Request(origin+target,{method,headers,...(method==='GET'||method==='HEAD'?{}:{body:Readable.toWeb(incoming) as ReadableStream<Uint8Array>,duplex:'half'})} as RequestInit);
      let response:Response;
      try { response=await dispatch(request,incoming.socket.remoteAddress??'unknown'); }
      catch(error) { if(!(error instanceof AdminError))console.error(JSON.stringify({event:'api-error',stage:'route'}));response=errorResponse(error); }
      if(response.status>=500)metrics.errors++;
      response.headers.set('Content-Security-Policy',CSP);response.headers.set('X-Content-Type-Options','nosniff');response.headers.set('Referrer-Policy','no-referrer');response.headers.set('Cache-Control','no-store');
      outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(method==='HEAD'?undefined:Buffer.from(await response.arrayBuffer()));
    })().catch(()=>{metrics.errors++;if(!outgoing.headersSent)outgoing.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});outgoing.end('{"error":"Service unavailable. Please retry."}');console.error(JSON.stringify({event:'api-error',stage:'dispatch'}));})
      .finally(()=>{const ms=performance.now()-start;metrics.totalLatencyMs+=ms;metrics.maxLatencyMs=Math.max(metrics.maxLatencyMs,ms);});
  });
  server.requestTimeout=15_000;server.headersTimeout=10_000;server.keepAliveTimeout=5_000;
  return {server,startWorker(){if(options.flags.submissions)options.worker?.start();},async close(){await options.worker?.stop();server.closeAllConnections();if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));},metrics};
}

async function main():Promise<void> {
  const db=new Pool({connectionString:process.env.DATABASE_URL,max:8,connectionTimeoutMillis:5_000,statement_timeout:15_000});
  if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');
  if(process.argv.includes('--migrate')){try{await migrate(db);console.log('Community database migrations applied.');}finally{await db.end();}return;}
  const origin=process.env.COMMUNITY_ORIGIN??'http://127.0.0.1:8080';const host=process.env.COMMUNITY_HOST??'127.0.0.1';
  const localOrigin=['127.0.0.1','localhost','[::1]'].includes(new URL(origin).hostname);
  const localBind=['127.0.0.1','localhost','::1'].includes(host) || (host==='0.0.0.0' && process.env.COMMUNITY_LOCAL_CONTAINER==='1');
  if(!localOrigin || !localBind || process.env.NODE_ENV==='production')throw new Error('This local entry point requires loopback hosting. Configure a reviewed private identity provider before public deployment.');
  const id=process.env.COMMUNITY_DEV_CURATOR_ID??'local-curator';const key=process.env.COMMUNITY_DEV_CURATOR_KEY??'';
  const provider=developmentIdentityProvider([{id,key}]);
  if(process.argv.includes('--bootstrap-curator')){
    try{await db.query("INSERT INTO curators(id,role) SELECT $1,'admin' WHERE NOT EXISTS(SELECT 1 FROM curators)",[id]);console.log('Initial local curator bootstrap complete.');}finally{await db.end();}return;
  }
  const storage=new LocalObjectStorage(process.env.COMMUNITY_DATA_DIR??path.join(communityRoot,'.data'));
  const flags:CommunityFlags={customMaps:process.env.COMMUNITY_CUSTOM_MAPS==='1',submissions:process.env.COMMUNITY_SUBMISSIONS==='1',verifiedResults:process.env.COMMUNITY_VERIFIED_RESULTS==='1'};
  const policy=JSON.parse(await readFile(path.join(communityRoot,'shared/supported-configurations.json'),'utf8')) as SupportedConfigurations;
  const worker=new ValidationWorker(db,storage,new NodeSimulationAdapter({policy,...DEFAULT_VALIDATOR_RESOURCES}),{onMetric:event=>console.log(JSON.stringify(event))});
  const app=await createCommunityServer({db,storage,origin,csrfSecret:process.env.COMMUNITY_CSRF_SECRET??'',identityProvider:provider,flags,worker});
  const port=Number(process.env.PORT??8080);await new Promise<void>((resolve,reject)=>{app.server.once('error',reject);app.server.listen(port,host,resolve);});
  app.startWorker();console.log(JSON.stringify({event:'community-ready',origin,flags}));
  const stop=()=>{void app.close().then(()=>db.end()).then(()=>process.exit(0));};process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))void main().catch(()=>{console.error('Community startup failed. Check required configuration, database migrations and pinned runtime inputs.');process.exitCode=1;});
