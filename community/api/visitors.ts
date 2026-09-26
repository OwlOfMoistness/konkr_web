import { createHmac, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AdminError, adminResponse, errorResponse, hashSecret } from './admin-auth.ts';

const COOKIE = 'community_visitor';
export interface VisitorIdentity { tokenHash: string }
/** Browser identity is an abuse/retry aid, never a claim of unique human identity. */
export class Visitors {
  private db: Pool;
  private origin: string;
  private secret: string;
  private secure: boolean;
  constructor(db: Pool, origin: string, csrfSecret: string) {
    if (csrfSecret.length < 32) throw new Error('A persistent CSRF secret of at least 32 characters is required');
    this.db=db;this.origin=new URL(origin).origin;this.secret=csrfSecret;this.secure=this.origin.startsWith('https:');
    if (!this.secure && !['127.0.0.1','localhost','[::1]'].includes(new URL(origin).hostname)) throw new Error('Visitor cookies require HTTPS outside localhost');
  }
  private token(request: Request): string | null {
    const matches=(request.headers.get('cookie')??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(COOKIE+'='));
    const token=matches.length===1?matches[0].slice(COOKIE.length+1):'';
    return /^[A-Za-z0-9_-]{43}$/.test(token)?token:null;
  }
  private csrf(token: string): string { return createHmac('sha256',this.secret).update(`visitor-csrf-v1:${token}`).digest('base64url'); }
  async require(request: Request, mutation=false): Promise<VisitorIdentity> {
    const token=this.token(request);
    if (!token) throw new AdminError(401,'Browser session required. Reload to retry.');
    if (mutation && (request.headers.get('origin')!==this.origin || hashSecret(request.headers.get('x-csrf-token')??'')!==hashSecret(this.csrf(token)))) throw new AdminError(403,'Invalid request origin or CSRF token');
    const tokenHash=hashSecret(token);
    if (!(await this.db.query('SELECT 1 FROM visitors WHERE token_hash=$1 AND expires_at>now()',[tokenHash])).rowCount) throw new AdminError(401,'Browser session expired. Reload to retry.');
    return {tokenHash};
  }
  async route(request: Request): Promise<Response|null> {
    if (new URL(request.url).pathname!=='/api/visitor') return null;
    try {
      if (request.method!=='GET') return adminResponse({error:'Method not allowed'},405,{Allow:'GET'});
      const site=request.headers.get('sec-fetch-site');
      if (site && site!=='same-origin' && site!=='none') throw new AdminError(403,'Cross-site session request refused');
      let token=this.token(request);let expiresAt: string|undefined;
      if (token) { const row=(await this.db.query('SELECT expires_at FROM visitors WHERE token_hash=$1 AND expires_at>now()',[hashSecret(token)])).rows[0]; if(row) expiresAt=new Date(row.expires_at).toISOString(); }
      let cookie: Record<string,string>={};
      if (!expiresAt) {
        token=randomBytes(32).toString('base64url');
        const row=(await this.db.query('INSERT INTO visitors(token_hash) VALUES($1) RETURNING expires_at',[hashSecret(token)])).rows[0];expiresAt=new Date(row.expires_at).toISOString();
        cookie={'Set-Cookie':`${COOKIE}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${90*86400}${this.secure?'; Secure':''}`};
      }
      return adminResponse({csrfToken:this.csrf(token!),expiresAt},200,cookie);
    } catch(error) {return errorResponse(error);}
  }
}

/** Atomic PostgreSQL window; callers place this in the mutation transaction. */
export async function consumeVisitorQuota(db: Pick<PoolClient,'query'>, tokenHash:string, scope:string, limit:number, seconds:number):Promise<void> {
  const result=await db.query(`INSERT INTO visitor_limits(token_hash,scope,window_start,used)
    VALUES($1,$2,floor(extract(epoch FROM now())/$3)::bigint,1)
    ON CONFLICT(token_hash,scope,window_start) DO UPDATE SET used=visitor_limits.used+1 WHERE visitor_limits.used<$4 RETURNING used`,[tokenHash,scope,seconds,limit]);
  if(!result.rowCount) throw new AdminError(429,'Too many requests. Please try again later.');
}
