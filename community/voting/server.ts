import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Pool } from 'pg';
import { VotingIdentity } from './identity.ts';
import { parseVotingManifest } from './manifest.ts';
import { initializeVoting, quota, VotingError, VotingStore } from './store.ts';

export interface VotingOptions {
  db: Pool; maps: Map<string, string>; secret: string;
  siteOrigin: string; apiOrigin: string;
  /** Enable only on the private Docker network whose sole ingress is cloudflared. */
  trustCloudflare?: boolean;
}

export function validateOrigin(value: string): string {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('Use an exact HTTP(S) origin without a path or trailing slash');
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Public origins require HTTPS');
  return value;
}

/** Group IPv6 callers by /64 so cycling addresses does not reset their IP quota. */
export function clientNetwork(address: string): string {
  if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4) return address.slice(7);
  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6) throw new VotingError(400, 'Invalid client address');
  const parts = new URL(`http://[${address}]/`).hostname.slice(1, -1).split('::');
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts[1] ? parts[1].split(':') : [];
  const full = parts.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return full.slice(0, 4).join(':') + '::/64';
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json' || request.headers['content-encoding']) throw new VotingError(415, 'Use uncompressed application/json');
  if (Number(request.headers['content-length'] ?? 0) > 2048) throw new VotingError(413, 'Request too large');
  const text = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    const cleanup = () => { request.off('data', data); request.off('end', end); request.off('error', error); request.off('aborted', aborted); };
    const error = (reason: Error) => { cleanup(); request.pause(); reject(reason); };
    const aborted = () => error(new VotingError(400, 'Incomplete request'));
    const data = (chunk: Buffer) => { size += chunk.length; if (size > 2048) error(new VotingError(413, 'Request too large')); else chunks.push(chunk); };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8')); };
    request.on('data', data).on('end', end).on('error', error).on('aborted', aborted);
  });
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new VotingError(400, 'Invalid JSON object'); }
}

export function createVotingServer(options: VotingOptions) {
  const apiOrigin = validateOrigin(options.apiOrigin), siteOrigin = validateOrigin(options.siteOrigin);
  const identity = new VotingIdentity(options.secret), store = new VotingStore(options.db);
  const metrics = { requests: 0, limited: 0, errors: 0 };
  // Hard bounds before body parsing or database work; PostgreSQL quotas also survive restarts.
  const limits = new Map<string, { used: number; until: number }>();
  let globalWindow = 0, globalUsed = 0, active = 0;
  let summary: { until: number; body: string } | undefined;
  let pendingSummary: Promise<{ version: number; body: string }> | undefined;
  let generation = 0;
  function admit(key: string): void {
    const now = Date.now();
    if (now >= globalWindow) { globalWindow = now + 1000; globalUsed = 0; }
    if (++globalUsed > 100 || active > 16) throw new VotingError(429, 'Server busy. Please try again shortly.');
    let entry = limits.get(key);
    if (!entry || entry.until <= now) {
      if (limits.size >= 10000) throw new VotingError(429, 'Server busy. Please try again shortly.');
      entry = { used: 0, until: now + 60000 }; limits.set(key, entry);
    }
    if (++entry.used > 180) throw new VotingError(429, 'Too many requests. Please try again shortly.');
  }
  const cleanup = setInterval(() => {
    for (const [key, entry] of limits) if (entry.until <= Date.now()) limits.delete(key);
  }, 60000); cleanup.unref();
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000 }, (request, response) => {
    const started = performance.now(); active++; metrics.requests++;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Vary', 'Origin');
    const send = (status: number, body: unknown) => { response.statusCode = status; response.end(body === null ? undefined : JSON.stringify(body)); };
    void (async () => {
      const target = request.url ?? '';
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '');
      // Container-only readiness, never forwarded from the public tunnel.
      if (local && target === '/healthz' && request.method === 'GET' && !request.headers['cf-connecting-ip']) {
        await options.db.query('SELECT 1 FROM voting_votes LIMIT 0'); send(200, { status: 'ready', maps: options.maps.size }); return;
      }
      if (!target.startsWith('/') || target.startsWith('//') || request.headers.host !== new URL(apiOrigin).host) throw new VotingError(400, 'Invalid request host');
      const match = /^\/v1\/maps\/([A-Za-z0-9_-]{1,128})\/ratings$/.exec(target);
      const methods = target === '/v1/session' ? ['POST'] : target === '/v1/ratings' ? ['GET'] : match ? ['GET', 'PUT'] : [];
      if (!methods.length) throw new VotingError(404, 'Not found');
      if (request.headers.origin !== siteOrigin) throw new VotingError(403, 'Origin not allowed');
      response.setHeader('Access-Control-Allow-Origin', siteOrigin);
      const source = options.trustCloudflare ? request.headers['cf-connecting-ip'] : request.socket.remoteAddress;
      if (typeof source !== 'string') throw new VotingError(400, 'Missing client address');
      const ip = identity.quotaKey(clientNetwork(source)); admit(ip);
      if (request.method === 'OPTIONS') {
        const headers = String(request.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
        if (!methods.includes(String(request.headers['access-control-request-method'])) || headers.some(value => !['authorization', 'content-type'].includes(value))) throw new VotingError(403, 'Preflight refused');
        response.setHeader('Access-Control-Allow-Methods', methods.join(', '));
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        response.setHeader('Access-Control-Max-Age', '600'); send(204, null); return;
      }
      if (!methods.includes(request.method ?? '')) { response.setHeader('Allow', methods.join(', ')); throw new VotingError(405, 'Method not allowed'); }
      if (target === '/v1/session') {
        const body = await jsonBody(request);
        if (Object.keys(body).length) throw new VotingError(400, 'Session body must be empty');
        await quota(options.db, ip, 'sessions', 10);
        send(200, { token: identity.issue() }); return;
      }
      if (target === '/v1/ratings') {
        if (!summary || summary.until <= Date.now()) {
          const version = generation;
          pendingSummary ??= store.summaries(options.maps).then(ratings => ({ version, body: JSON.stringify({ ratings }) })).finally(() => { pendingSummary = undefined; });
          const result = await pendingSummary;
          if (generation === result.version) summary = { until: Date.now() + 30000, body: result.body };
          response.end(result.body);
        } else response.end(summary.body);
        return;
      }
      const revisionId = options.maps.get(match![1]);
      if (!revisionId) throw new VotingError(404, 'Map unavailable');
      const authorization = request.headers.authorization ?? '';
      const voter = authorization.startsWith('Bearer ') ? identity.verify(authorization.slice(7)) : null;
      if (!voter) throw new VotingError(401, 'Browser identity expired. Reload to retry.');
      if (request.method === 'PUT') {
        const body = await jsonBody(request);
        if (Object.keys(body).length !== 2 || !Object.hasOwn(body, 'rating') || typeof body.revisionId !== 'string' || !Number.isInteger(body.rating) || Number(body.rating) < 1 || Number(body.rating) > 5) throw new VotingError(400, 'Use a rating from 1 to 5 and a revisionId');
        if (body.revisionId !== revisionId) throw new VotingError(409, 'Map revision changed. Reload before rating.');
        await store.vote(match![1], revisionId, voter, Number(body.rating), ip);
        generation++; summary = undefined;
      }
      send(200, { revisionId, ...await store.rating(match![1], revisionId, voter) });
    })().catch(error => {
      const status = error instanceof VotingError ? error.status : 503;
      if (status === 429) { metrics.limited++; response.setHeader('Retry-After', '3600'); }
      if (status >= 500) metrics.errors++;
      // No tokens, IPs, headers, database URLs or user-controlled text in logs.
      response.setHeader('Connection', 'close');
      send(status, { error: error instanceof VotingError ? error.message : 'Voting unavailable. Please try again later.' });
    }).finally(() => {
      active--;
      if (response.statusCode >= 500) console.error(JSON.stringify({ event: 'voting-error', status: response.statusCode, durationMs: Math.round(performance.now() - started) }));
    });
  });
  server.maxConnections = 128; server.keepAliveTimeout = 5000; server.setTimeout(10000);
  server.on('close', () => clearInterval(cleanup));
  return { server, metrics };
}

async function main(): Promise<void> {
  const required = (key: string) => { const value = process.env[key]; if (!value) throw new Error(`${key} is required`); return value; };
  const apiOrigin = validateOrigin(required('VOTING_API_ORIGIN')), siteOrigin = validateOrigin(required('VOTING_SITE_ORIGIN'));
  if (process.env.NODE_ENV === 'production' && (!apiOrigin.startsWith('https:') || !siteOrigin.startsWith('https:'))) throw new Error('Production origins must use HTTPS');
  const secret = required('VOTING_SECRET'); new VotingIdentity(secret);
  const maps = parseVotingManifest(JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8')));
  const db = new Pool({ connectionString: required('DATABASE_URL'), max: 4, connectionTimeoutMillis: 3000, statement_timeout: 5000, idle_in_transaction_session_timeout: 10000 });
  await initializeVoting(db);
  const { server, metrics } = createVotingServer({ db, maps, secret, apiOrigin, siteOrigin, trustCloudflare: process.env.VOTING_TRUST_CLOUDFLARE === '1' });
  const cleanup = () => db.query('DELETE FROM voting_limits WHERE hour<floor(extract(epoch FROM now())/3600)::bigint-1').catch(() => console.error('{"event":"voting-cleanup-error"}'));
  await cleanup();
  const timer = setInterval(() => { void cleanup(); console.log(JSON.stringify({ event: 'voting-metrics', ...metrics })); }, 3600000); timer.unref();
  server.listen(8080, '0.0.0.0', () => console.log(JSON.stringify({ event: 'voting-ready', maps: maps.size })));
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true; clearInterval(timer);
    const deadline = setTimeout(() => server.closeAllConnections(), 10000); deadline.unref();
    server.close(() => { clearTimeout(deadline); void db.end(); });
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => { console.error('Voting startup failed. Check origins, secrets, database connectivity and the map manifest.'); process.exit(1); });
}
