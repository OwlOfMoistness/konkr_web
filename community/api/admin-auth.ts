import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ContractError } from '../shared/contracts.ts';
import type { CuratorRole } from '../shared/contracts.ts';

export interface CuratorIdentity { id: string; role: CuratorRole }
/** Composition must supply a private-access provider. Never trust a client identity header. */
export interface CuratorIdentityProvider { authenticate(credential: string): Promise<string | null> }
export class AdminError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export const hashSecret = (value: string): string => createHash('sha256').update(value).digest('hex');
const opaque = () => randomBytes(32).toString('base64url');
const COOKIE = 'community_curator';
const HOURS = 8;

/** Explicit local fixture only. A deployment must supply its reviewed identity provider. */
export function developmentIdentityProvider(credentials: { id: string; key: string }[]): CuratorIdentityProvider {
  const identities = new Map<string, string>();
  for (const { id, key } of credentials) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || key.length < 32) throw new Error('Development curator keys need at least 32 characters and a valid identity');
    if (identities.has(hashSecret(key))) throw new Error('Duplicate development curator key');
    identities.set(hashSecret(key), id);
  }
  return { async authenticate(key) { return identities.get(hashSecret(key)) ?? null; } };
}

export async function readJson(request: Request, maxBytes = 16_384): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new AdminError(415, 'Use application/json');
  const reader = request.body?.getReader();
  if (!reader) throw new AdminError(400, 'Missing request body');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new AdminError(413, 'Request body too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let data: unknown;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AdminError(400, 'Invalid JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AdminError(400, 'Expected an object');
  return data as Record<string, unknown>;
}
export function requireFields(data: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(data).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(data, key))) throw new AdminError(400, 'Unexpected or missing field');
}
export function adminResponse(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}
export function errorResponse(error: unknown): Response {
  if (error instanceof AdminError) return adminResponse({ error: error.message }, error.status);
  if (error instanceof ContractError) return adminResponse({ error: error.message }, 400);
  return adminResponse({ error: 'Service unavailable. Please retry.' }, 503);
}
export async function audit(db: Pick<PoolClient, 'query'>, actor: CuratorIdentity, action: string, target: string, details: Record<string, unknown> = {}): Promise<void> {
  await db.query('INSERT INTO curator_audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [actor.id, action, target, JSON.stringify(details)]);
}

export class CuratorAuth {
  db: Pool;
  private provider: CuratorIdentityProvider;
  private origin: string;
  private secure: boolean;
  constructor(db: Pool, provider: CuratorIdentityProvider, origin: string) {
    this.db = db; this.provider = provider; this.origin = new URL(origin).origin; this.secure = this.origin.startsWith('https:');
    if (!this.secure && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error('Curator sessions require HTTPS outside localhost');
  }
  sameOrigin(request: Request): void {
    if (request.headers.get('origin') !== this.origin) throw new AdminError(403, 'Cross-origin mutation refused');
  }
  private token(request: Request): string {
    const values = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
    const token = values.length === 1 ? values[0].slice(COOKIE.length + 1) : '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AdminError(401, 'Curator sign-in required');
    return token;
  }
  async require(request: Request, role: CuratorRole = 'curator', mutation = false): Promise<CuratorIdentity> {
    if (mutation) this.sameOrigin(request);
    const token = this.token(request);
    const result = await this.db.query(`SELECT c.id,c.role,s.csrf_hash FROM curators c JOIN curator_sessions s ON s.curator_id=c.id
      WHERE s.token_hash=$1 AND s.expires_at>now() AND c.enabled`, [hashSecret(token)]);
    const identity = result.rows[0];
    if (!identity) throw new AdminError(401, 'Curator session expired');
    if (role === 'admin' && identity.role !== 'admin') throw new AdminError(403, 'Administrator access required');
    if (mutation) {
      const csrf = request.headers.get('x-csrf-token') ?? '';
      if (!/^[A-Za-z0-9_-]{43}$/.test(csrf) || hashSecret(csrf) !== identity.csrf_hash) throw new AdminError(403, 'Invalid CSRF token');
    }
    return { id: identity.id, role: identity.role };
  }
  async route(request: Request): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    if (path !== '/api/admin/session' && path !== '/api/admin/curators') return null;
    try {
      if (path === '/api/admin/session') {
        if (request.method === 'POST') {
          this.sameOrigin(request);
          const data = await readJson(request); requireFields(data, ['credential']);
          if (typeof data.credential !== 'string' || data.credential.length > 4096) throw new AdminError(400, 'Invalid credential');
          const id = await this.provider.authenticate(data.credential);
          if (!id) throw new AdminError(401, 'Invalid curator credential');
          const result = await this.db.query('SELECT id,role FROM curators WHERE id=$1 AND enabled', [id]);
          if (!result.rows.length) throw new AdminError(401, 'Invalid curator credential');
          const token = opaque(); const csrf = opaque();
          const client = await this.db.connect();
          try {
            await client.query('BEGIN');
            await client.query('DELETE FROM curator_sessions WHERE curator_id=$1 OR expires_at<now()', [id]);
            await client.query("INSERT INTO curator_sessions(token_hash,curator_id,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '8 hours')", [hashSecret(token), id, hashSecret(csrf)]);
            await audit(client, result.rows[0], 'sign-in', id);
            await client.query('COMMIT');
          } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
          return adminResponse({ identity: result.rows[0], csrfToken: csrf }, 200, { 'Set-Cookie': `${COOKIE}=${token}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${HOURS * 3600}${this.secure ? '; Secure' : ''}` });
        }
        if (request.method === 'GET') return adminResponse({ identity: await this.require(request) });
        if (request.method === 'DELETE') {
          await this.require(request, 'curator', true);
          await this.db.query('DELETE FROM curator_sessions WHERE token_hash=$1', [hashSecret(this.token(request))]);
          return adminResponse({ signedOut: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0${this.secure ? '; Secure' : ''}` });
        }
      } else {
        const actor = await this.require(request, 'admin', request.method !== 'GET');
        if (request.method === 'GET') return adminResponse({ curators: (await this.db.query('SELECT id,role,enabled FROM curators ORDER BY id')).rows });
        if (request.method === 'PUT') {
          const data = await readJson(request); requireFields(data, ['id', 'role', 'enabled']);
          if (typeof data.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.id) || !['curator', 'admin'].includes(data.role as string) || typeof data.enabled !== 'boolean') throw new AdminError(400, 'Invalid curator');
          if (data.id === actor.id && (data.role !== 'admin' || !data.enabled)) throw new AdminError(409, 'An administrator cannot remove their own access');
          const client = await this.db.connect();
          try {
            await client.query('BEGIN');
            // All access changes share one lock; authority may change while a request reads its body or waits.
            await client.query("SELECT pg_advisory_xact_lock(hashtextextended('community:curator-access:v1',0))");
            const authorized = await client.query(`SELECT 1 FROM curators c JOIN curator_sessions s ON s.curator_id=c.id
              WHERE c.id=$1 AND c.enabled AND c.role='admin' AND s.token_hash=$2 AND s.expires_at>now()`, [actor.id, hashSecret(this.token(request))]);
            if (!authorized.rowCount) throw new AdminError(403, 'Administrator access changed. Sign in again before editing access.');
            await client.query('INSERT INTO curators(id,role,enabled) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET role=$2,enabled=$3,updated_at=now()', [data.id, data.role, data.enabled]);
            if (!(await client.query("SELECT 1 FROM curators WHERE enabled AND role='admin' LIMIT 1")).rowCount) throw new AdminError(409, 'At least one enabled administrator is required');
            await audit(client, actor, 'curator-access', data.id, { role: data.role, enabled: data.enabled });
            await client.query('COMMIT');
          } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
          return adminResponse({ updated: true });
        }
      }
      return adminResponse({ error: 'Method not allowed' }, 405, { Allow: path.endsWith('session') ? 'GET, POST, DELETE' : 'GET, PUT' });
    } catch (error) { return errorResponse(error); }
  }
}
