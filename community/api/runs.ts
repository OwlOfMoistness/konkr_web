import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { LIMITS, parseSubmission, supports } from '../shared/contracts.ts';
import type { Difficulty, ObjectStorage, PublicRunStatus, RunBinding, SupportedConfigurations } from '../shared/contracts.ts';
import { AdminError, adminResponse, errorResponse, readJson, requireFields } from './admin-auth.ts';
import { inTransaction } from './maps-admin.ts';
import { Visitors, consumeVisitorQuota } from './visitors.ts';

export interface RunOptions {
  engineHash: string;
  adapterVersion: string;
  submissionsEnabled: boolean;
  queueLimit?: number;
}
export interface RunView { binding: RunBinding; result: PublicRunStatus | null }
export const RUN_LIFETIME_DAYS = 30;
export const digest = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Only these server rows bind a replay to a challenge; final client claims cannot change them. */
export class Runs {
  private db: Pool;
  private storage: ObjectStorage;
  private visitors: Visitors;
  private policy: SupportedConfigurations;
  private options: RunOptions;
  constructor(db: Pool, storage: ObjectStorage, visitors: Visitors, policy: SupportedConfigurations, options: RunOptions) {
    this.db=db; this.storage=storage; this.visitors=visitors; this.policy=policy; this.options=options;
    if (!options.engineHash || !options.adapterVersion || !Number.isSafeInteger(options.queueLimit ?? 1000) || (options.queueLimit ?? 1000)<1) throw new Error('Invalid run configuration');
  }
  private status(row: any): PublicRunStatus | null {
    return row.state==='issued' ? null : row.state==='complete' ? row.result : {status:'pending',runId:row.id};
  }
  private async mapFile(key: string, hash: string): Promise<Response> {
    const file=await this.storage.get(key);
    if (!file || digest(file.bytes)!==hash) throw new AdminError(503,'Map file unavailable. Please retry.');
    return new Response(Buffer.from(file.bytes),{headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }
  async route(request: Request): Promise<Response|null> {
    const url=new URL(request.url);
    const match=/^\/api\/runs(?:\/([A-Za-z0-9_-]{1,128})(?:\/(submission|map))?)?$/.exec(url.pathname);
    const fileMatch=/^\/api\/maps\/([A-Za-z0-9_-]{1,128})\/file$/.exec(url.pathname);
    if (!match && !fileMatch) return null;
    try {
      if (fileMatch) {
        if (request.method!=='GET') return adminResponse({error:'Method not allowed'},405,{Allow:'GET'});
        if ([...url.searchParams.keys()].some(key=>key!=='revision') || url.searchParams.getAll('revision').length!==1) throw new AdminError(400,'An exact revision is required');
        const row=(await this.db.query(`SELECT r.* FROM maps m JOIN map_revisions r ON r.id=m.current_revision_id
          WHERE m.id=$1 AND m.state='published' AND r.id=$2`,[fileMatch[1],url.searchParams.get('revision')])).rows[0];
        if (!row || !(['normal','hard'] as const).some(d=>supports(this.policy,row.engine_hash,d,row.plugins))) throw new AdminError(404,'Map not found');
        return await this.mapFile(row.object_key,row.content_hash);
      }
      if (url.search) throw new AdminError(400,'Unexpected query parameter');
      const id=match![1]; const action=match![2];
      const visitor=await this.visitors.require(request,request.method!=='GET');
      if (!id && request.method==='POST') {
        // Gameplay and saved revisions remain available while verification is disabled.
        const data=await readJson(request); requireFields(data,['mapId','revisionId','difficulty']);
        if (typeof data.mapId!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.mapId) || typeof data.revisionId!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.revisionId) || !['normal','hard'].includes(data.difficulty as string)) throw new AdminError(400,'Invalid map or difficulty');
        const binding=await inTransaction(this.db,async client=>{
          // Publication/revision edits wait until the binding has been issued.
          const row=(await client.query(`SELECT r.* FROM maps m JOIN map_revisions r ON r.id=m.current_revision_id
            WHERE m.id=$1 AND m.state='published' FOR SHARE OF m`,[data.mapId])).rows[0];
          if (!row) throw new AdminError(404,'Published map not found');
          if (row.id!==data.revisionId) throw new AdminError(409,'The map has a new revision. Refresh before starting.');
          if (row.engine_hash!==this.options.engineHash || !supports(this.policy,row.engine_hash,data.difficulty as Difficulty,row.plugins)) throw new AdminError(422,'This map configuration is not supported');
          await consumeVisitorQuota(client,visitor.tokenHash,'run-start',30,3600);
          const times=(await client.query(`SELECT now() AS issued,now()+interval '30 days' AS expires`)).rows[0];
          const binding:RunBinding={id:randomUUID(),mapId:data.mapId as string,revisionId:row.id,mapHash:row.content_hash,
            engineHash:row.engine_hash,adapterVersion:this.options.adapterVersion,difficulty:data.difficulty as Difficulty,plugins:row.plugins,
            issuedAt:new Date(times.issued).toISOString(),expiresAt:new Date(times.expires).toISOString()};
          await client.query('INSERT INTO runs(id,browser_token_hash,revision_id,binding,expires_at) VALUES($1,$2,$3,$4,$5)',[binding.id,visitor.tokenHash,binding.revisionId,JSON.stringify(binding),binding.expiresAt]);
          return binding;
        });
        return adminResponse({binding},201);
      }
      if (id && request.method==='GET' && action!=='submission') {
        const row=(await this.db.query('SELECT * FROM runs WHERE id=$1 AND browser_token_hash=$2',[id,visitor.tokenHash])).rows[0];
        if (!row) throw new AdminError(404,'Run not found in this browser session');
        if (action==='map') {
          if (new Date(row.expires_at).getTime()<=Date.now()) throw new AdminError(410,'This run has expired');
          const revision=(await this.db.query('SELECT object_key,content_hash FROM map_revisions WHERE id=$1',[row.revision_id])).rows[0];
          return await this.mapFile(revision.object_key,revision.content_hash);
        }
        return adminResponse({binding:row.binding,result:this.status(row)} satisfies RunView);
      }
      if (id && request.method==='POST' && action==='submission') {
        const submission=parseSubmission(await readJson(request,LIMITS.submissionBytes));
        if (submission.runId!==id) throw new AdminError(400,'Submission run does not match the request');
        const encoded=JSON.stringify(submission); const hash=digest(encoded);
        const result=await inTransaction(this.db,async client=>{
          const row=(await client.query('SELECT * FROM runs WHERE id=$1 AND browser_token_hash=$2 FOR UPDATE',[id,visitor.tokenHash])).rows[0];
          if (!row) throw new AdminError(404,'Run not found in this browser session');
          // Stable retries are allowed even after expiry or emergency intake shutdown.
          if (row.submission_hash) {
            if (row.submission_hash!==hash || row.idempotency_key!==submission.idempotencyKey) throw new AdminError(409,'This run already has a different submission');
            return this.status(row)!;
          }
          if (!this.options.submissionsEnabled) throw new AdminError(503,'Submissions are temporarily disabled. Keep this replay and retry later.');
          if (new Date(row.expires_at).getTime()<=Date.now()) throw new AdminError(410,'This run has expired');
          const binding:RunBinding=row.binding;
          if (binding.engineHash!==this.options.engineHash || binding.adapterVersion!==this.options.adapterVersion || !supports(this.policy,binding.engineHash,binding.difficulty,binding.plugins)) throw new AdminError(422,'This run requires a retired validator');
          await consumeVisitorQuota(client,visitor.tokenHash,'run-submit',30,3600);
          // This lock makes queue admission and cross-run idempotency atomic across API instances.
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended('community:queue-admission:v1',0))");
          if ((await client.query('SELECT 1 FROM runs WHERE browser_token_hash=$1 AND idempotency_key=$2',[visitor.tokenHash,submission.idempotencyKey])).rowCount) throw new AdminError(409,'This submission key belongs to another run');
          if (Number((await client.query("SELECT count(*) FROM runs WHERE state IN ('queued','running')")).rows[0].count)>=(this.options.queueLimit??1000)) throw new AdminError(503,'Verification queue is full. Keep this replay and retry later.');
          const key=`submissions/${id}/${hash}.json`;
          // Atomic object write precedes durable reference; a DB failure leaves only a safe orphan.
          await this.storage.put(key,Buffer.from(encoded),'application/json');
          await client.query("UPDATE runs SET state='queued',idempotency_key=$2,submission_hash=$3,submission_key=$4,submitted_at=now(),available_at=now() WHERE id=$1",[id,submission.idempotencyKey,hash,key]);
          return {status:'pending',runId:id} as const;
        });
        return adminResponse(result,result.status==='pending'?202:200);
      }
      return adminResponse({error:'Method not allowed'},405,{Allow:!id || action==='submission'?'POST':'GET'});
    } catch (error) { return errorResponse(error); }
  }
}
