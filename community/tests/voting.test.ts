import assert from 'node:assert/strict';
import { after, before, describe, it, test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { Pool } from 'pg';
import { VotingIdentity } from '../voting/identity.ts';
import { parseVotingManifest } from '../voting/manifest.ts';
import { initializeVoting } from '../voting/store.ts';
import { clientNetwork, createVotingServer, validateOrigin } from '../voting/server.ts';

const secret = 'a'.repeat(64), site = 'https://owl.example', api = 'https://votes.example';
const revision = 'r-' + '1'.repeat(64), nextRevision = 'r-' + '2'.repeat(64);
test('voting identities cannot be invented, altered or reused with another signing key', () => {
  const identity = new VotingIdentity(secret), token = identity.issue();
  assert.match(identity.verify(token)!, /^[a-f0-9]{64}$/);
  assert.equal(identity.verify(token + 'a'), null);
  assert.equal(identity.verify('v1.' + 'a'.repeat(43) + '.' + 'b'.repeat(43)), null);
  assert.equal(new VotingIdentity('b'.repeat(64)).verify(token), null);
  assert.throws(() => new VotingIdentity('placeholder'));
});
test('only explicit secure origins and valid map revisions enter the deployment', () => {
  assert.equal(validateOrigin(site), site);
  for (const value of ['*', 'https://owl.example/', 'https://owl.example/path', 'http://owl.example', 'https://user:pass@owl.example']) assert.throws(() => validateOrigin(value));
  assert.equal(parseVotingManifest({ version: 1, maps: [{ id: 'map', revisionId: revision }] }).get('map'), revision);
  for (const maps of [[], [{ revisionId: revision }], [{ id: '../evil', revisionId: revision }], [{ id: 'map', revisionId: 'random' }], [{ id: 'map', revisionId: revision }, { id: 'map', revisionId: revision }]]) assert.throws(() => parseVotingManifest({ version: 1, maps }));
  assert.equal(clientNetwork('2001:db8:1:2::1'), clientNetwork('2001:0db8:0001:0002:ffff::3'));
  assert.equal(clientNetwork('::ffff:192.0.2.1'), '192.0.2.1');
  assert.throws(() => clientNetwork('192.0.2.1, 192.0.2.2'));
});

const database = process.env.CATALOG_TEST_DATABASE_URL;
describe('standalone voting HTTP API', { skip: !database }, () => {
  let admin: Pool, db: Pool, service: ReturnType<typeof createVotingServer>, base: string;
  const schema = `voting_${process.pid}`, maps = new Map([['map', revision]]);
  let ipNumber = 0;
  const ip = () => `192.0.2.${++ipNumber}`;
  async function start(trustCloudflare = true) {
    service = createVotingServer({ db, maps, secret, siteOrigin: site, apiOrigin: api, trustCloudflare });
    await new Promise<void>(resolve => service.server.listen(0, '127.0.0.1', resolve));
    const address = service.server.address(); assert(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
  }
  async function stop() {
    service.server.closeAllConnections(); await new Promise<void>(resolve => service.server.close(() => resolve()));
  }
  const send = (route: string, method = 'GET', body?: unknown, token?: string, address = '192.0.2.250', headers = {}) => new Promise<Response>((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest(base + route, {
      method, headers: { Host: 'votes.example', Origin: site, 'CF-Connecting-IP': address, ...(text !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk)).on('error', reject).on('end', () => resolve(new Response(response.statusCode === 204 ? null : Buffer.concat(chunks), { status: response.statusCode, headers: response.headers as Record<string, string> })));
    });
    request.on('error', reject); request.end(text);
  });
  const session = async (address = ip()) => {
    const response = await send('/v1/session', 'POST', {}, undefined, address);
    assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null);
    return (await response.json()).token as string;
  };
  before(async () => {
    admin = new Pool({ connectionString: database }); await admin.query(`CREATE SCHEMA ${schema}`);
    db = new Pool({ connectionString: database, options: `-c search_path=${schema}`, max: 5 });
    await initializeVoting(db); await start();
  });
  after(async () => { if (service) await stop(); await db?.end(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } });
  it('allows the configured site with preflight; rejects foreign origins, hosts and dormant routes', async () => {
    const response = await send('/v1/maps/map/ratings', 'OPTIONS', undefined, undefined, ip(), { 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,content-type' });
    assert.equal(response.status, 204); assert.equal(response.headers.get('access-control-allow-origin'), site);
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
    assert.equal((await send('/v1/session', 'POST', {}, undefined, ip(), { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await send('/v1/session', 'POST', {}, undefined, ip(), { Host: 'evil.example' })).status, 400);
    assert.equal((await send('/v1/session', 'OPTIONS', undefined, undefined, ip(), { 'Access-Control-Request-Method': 'DELETE' })).status, 403);
    for (const route of ['/api/admin/session', '/api/runs', '/admin/maps', '/.env', '/healthz', '/v1/ratings?unbounded=1']) assert.equal((await send(route)).status, 404);
    assert.equal((await fetch(base + '/healthz')).status, 200);
    assert.equal((await send('/v1/session', 'POST', {}, undefined, 'not-an-ip')).status, 400);
  });
  it('replaces votes atomically, reads only its own vote and survives service restarts', async () => {
    const first = await session(), second = await session();
    const vote = (token: string, rating: number) => send('/v1/maps/map/ratings', 'PUT', { revisionId: revision, rating }, token);
    assert.equal((await vote(first, 5)).status, 200);
    assert.equal((await vote(first, 3)).status, 200);
    assert.deepEqual((await (await vote(second, 5)).json()).rating, { average: 4, count: 2 });
    const duplicates = await Promise.all([vote(second, 4), vote(second, 4)]);
    assert.deepEqual(duplicates.map(result => result.status), [200, 200]);
    await stop(); await start();
    const response = await send('/v1/maps/map/ratings', 'GET', undefined, first);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { revisionId: revision, rating: { average: 3.5, count: 2 }, mine: 3 });
    const summaries = await (await send('/v1/ratings')).json();
    assert.deepEqual(summaries.ratings.map, { revisionId: revision, rating: { average: 3.5, count: 2 } });
    assert.equal((await db.query('SELECT count(*) FROM voting_votes')).rows[0].count, '2');
  });
  it('rejects invalid values, unknown maps, forged identities, old revisions and oversized bodies', async () => {
    const token = await session();
    for (const rating of [0, 6, 2.5, '5', null]) assert.equal((await send('/v1/maps/map/ratings', 'PUT', { revisionId: revision, rating }, token)).status, 400);
    assert.equal((await send('/v1/maps/map/ratings', 'PUT', { revisionId: revision, rating: 5, extra: true }, token)).status, 400);
    assert.equal((await send('/v1/maps/map/ratings', 'PUT', { revisionId: nextRevision, rating: 5 }, token)).status, 409);
    assert.equal((await send('/v1/maps/missing/ratings', 'GET', undefined, token)).status, 404);
    assert.equal((await send('/v1/maps/map/ratings', 'GET', undefined, token + 'x')).status, 401);
    assert.equal((await send('/v1/maps/map/ratings')).status, 401);
    assert.equal((await send('/v1/session', 'POST', { data: 'x'.repeat(3000) })).status, 413);
    // Exercise the streaming bound too, without a Content-Length header.
    const status = await new Promise<number>(resolve => {
      const request = httpRequest(base + '/v1/session', { method: 'POST', headers: { Host: 'votes.example', Origin: site, 'CF-Connecting-IP': ip(), 'Content-Type': 'application/json' } }, response => { response.resume(); resolve(response.statusCode!); });
      request.write('{"data":"' + 'x'.repeat(2100)); request.end('"}');
    });
    assert.equal(status, 413);
  });
  it('preserves old votes but separates new gameplay revisions and rejects removed maps', async () => {
    const token = await session(); maps.set('map', nextRevision);
    const current = await send('/v1/maps/map/ratings', 'GET', undefined, token);
    assert.deepEqual((await current.json()).rating, { average: null, count: 0 });
    maps.delete('map'); assert.equal((await send('/v1/maps/map/ratings', 'GET', undefined, token)).status, 404);
    maps.set('map', revision);
  });
  it('enforces persistent IP session quotas and browser vote quotas', async () => {
    const address = ip();
    for (let index = 0; index < 10; index++) await session(address);
    await stop(); await start();
    assert.equal((await send('/v1/session', 'POST', {}, undefined, address)).status, 429);
    const token = await session();
    for (let index = 0; index < 30; index++) assert.equal((await send('/v1/maps/map/ratings', 'PUT', { revisionId: revision, rating: 4 }, token, ip())).status, 200);
    assert.equal((await send('/v1/maps/map/ratings', 'PUT', { revisionId: revision, rating: 1 }, token, ip())).status, 429);
    assert.equal((await (await send('/v1/maps/map/ratings', 'GET', undefined, token)).json()).mine, 4);
  });
  it('ignores forged proxy headers unless the deployment explicitly trusts its private tunnel', async () => {
    await stop(); await start(false);
    for (let index = 0; index < 10; index++) await session(ip());
    assert.equal((await send('/v1/session', 'POST', {}, undefined, ip())).status, 429);
  });
});
