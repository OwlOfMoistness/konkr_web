import type { Pool } from 'pg';
import { supports } from '../shared/contracts.ts';
import type { SupportedConfigurations } from '../shared/contracts.ts';
import { AdminError, adminResponse, errorResponse, readJson, requireFields } from './admin-auth.ts';
import { inTransaction } from './maps-admin.ts';
import { Visitors, consumeVisitorQuota } from './visitors.ts';

export class Ratings {
  private db:Pool;private visitors:Visitors;private policy:SupportedConfigurations;
  constructor(db:Pool,visitors:Visitors,policy:SupportedConfigurations){this.db=db;this.visitors=visitors;this.policy=policy;}
  async route(request:Request):Promise<Response|null>{
    const match=/^\/api\/maps\/([A-Za-z0-9_-]{1,128})\/ratings$/.exec(new URL(request.url).pathname);if(!match)return null;
    try{
      if(!['GET','PUT'].includes(request.method))return adminResponse({error:'Method not allowed'},405,{Allow:'GET, PUT'});
      const visitor=await this.visitors.require(request,request.method==='PUT');
      const data=request.method==='PUT'?await readJson(request):null;
      if(data){requireFields(data,['revisionId','rating']);if(typeof data.revisionId!=='string'||!Number.isInteger(data.rating)||(data.rating as number)<1||(data.rating as number)>5)throw new AdminError(400,'Use a rating from 1 to 5');}
      const result=await inTransaction(this.db,async client=>{
        const row=(await client.query(`SELECT r.id,r.engine_hash,r.plugins FROM maps m JOIN map_revisions r ON r.id=m.current_revision_id
          WHERE m.id=$1 AND m.state='published' FOR SHARE OF m`,[match[1]])).rows[0];
        if(!row||!(['normal','hard'] as const).some(mode=>supports(this.policy,row.engine_hash,mode,row.plugins)))throw new AdminError(404,'Map unavailable');
        if(data){
          if(data.revisionId!==row.id)throw new AdminError(409,'Map revision changed. Reload before rating.');
          await consumeVisitorQuota(client,visitor.tokenHash,'rating',20,3600);
          await client.query(`INSERT INTO map_ratings(revision_id,browser_token_hash,rating) VALUES($1,$2,$3)
            ON CONFLICT(revision_id,browser_token_hash) DO UPDATE SET rating=$3,updated_at=now()`,[row.id,visitor.tokenHash,data.rating]);
        }
        const aggregate=(await client.query('SELECT avg(rating)::float8 AS average,count(*)::integer AS count FROM map_ratings WHERE revision_id=$1',[row.id])).rows[0];
        const mine=(await client.query('SELECT rating FROM map_ratings WHERE revision_id=$1 AND browser_token_hash=$2',[row.id,visitor.tokenHash])).rows[0]?.rating??null;
        return {revisionId:row.id,rating:aggregate,mine};
      });return adminResponse(result);
    }catch(error){return errorResponse(error);}
  }
}
