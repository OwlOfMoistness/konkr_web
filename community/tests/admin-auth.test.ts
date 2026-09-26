import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { CuratorAuth, developmentIdentityProvider, readJson } from '../api/admin-auth.ts';

const origin = 'http://127.0.0.1:5555';
const databaseUrl = process.env.CATALOG_TEST_DATABASE_URL;
const key = (who: string) => `${who}-` + 'test-credential-'.repeat(3);
function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return new Request(origin + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
}
describe('curator authorization', { skip: !databaseUrl }, () => {
  let admin: Pool; let db: Pool; let auth: CuratorAuth;
  const schema = `auth_test_${process.pid}`;
  const session = async (who: string) => {
    const response = (await auth.route(request('/api/admin/session', 'POST', { credential: key(who) })))!;
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    return { Cookie: cookie.split(';')[0], 'X-CSRF-Token': (await response.json()).csrfToken };
  };
  before(async () => {
    admin = new Pool({ connectionString: databaseUrl, max: 1 }); await admin.query(`CREATE SCHEMA ${schema}`);
    db = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await db.query(await readFile(new URL('../db/002-curators.sql', import.meta.url), 'utf8'));
    await db.query("INSERT INTO curators(id,role) VALUES('owner','admin'),('editor','curator')");
    auth = new CuratorAuth(db, developmentIdentityProvider([{ id: 'owner', key: key('owner') }, { id: 'editor', key: key('editor') }, { id: 'unlisted', key: key('unlisted') }]), origin);
  });
  after(async () => { await db?.end(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } });
  it('denies unknown credentials, client role headers and unlisted provider identities', async () => {
    for (const credential of ['wrong', key('unlisted')]) assert.equal((await auth.route(request('/api/admin/session', 'POST', { credential })))!.status, 401);
    assert.equal((await auth.route(request('/api/admin/curators', 'GET', undefined, { 'X-Curator-Id': 'owner', 'X-Curator-Role': 'admin' })))!.status, 401);
  });
  it('enforces roles and CSRF at direct API boundaries', async () => {
    const editor = await session('editor'); const owner = await session('owner');
    assert.equal((await auth.require(request('/api/admin/maps', 'POST', {}, editor), 'curator', true)).id, 'editor');
    assert.equal((await auth.route(request('/api/admin/curators', 'GET', undefined, editor)))!.status, 403);
    const update = { id: 'next', role: 'curator', enabled: true };
    for (const bad of [{ ...owner, Origin: 'https://evil.invalid' }, { ...owner, 'X-CSRF-Token': 'wrong' }])
      assert.equal((await auth.route(request('/api/admin/curators', 'PUT', update, bad)))!.status, 403);
    assert.equal((await auth.route(request('/api/admin/curators', 'PUT', update, owner)))!.status, 200);
    assert.equal((await db.query("SELECT role FROM curators WHERE id='next'")).rows[0].role, 'curator');
    assert.equal((await auth.route(request('/api/admin/curators', 'PUT', { id: 'owner', role: 'curator', enabled: false }, owner)))!.status, 409);
    const audit = JSON.stringify((await db.query('SELECT * FROM curator_audit')).rows);
    assert.doesNotMatch(audit, /credential/); assert.ok(!audit.includes(owner.Cookie));
  });
  it('serializes concurrent cross-demotions and rechecks administrator access after waiting', { timeout: 10_000 }, async () => {
    await db.query("INSERT INTO curators(id,role) VALUES('alpha','admin'),('beta','admin')");
    const raceAuth = new CuratorAuth(db, developmentIdentityProvider(['alpha','beta'].map(id => ({ id, key: key(id) }))), origin);
    const sessions = await Promise.all(['alpha','beta'].map(async id => {
      const response = (await raceAuth.route(request('/api/admin/session', 'POST', { credential: key(id) })))!;
      assert.equal(response.status, 200);
      return { Cookie: response.headers.get('set-cookie')!.split(';')[0], 'X-CSRF-Token': (await response.json()).csrfToken as string };
    }));
    let waiting = 0; let release!: () => void;
    const bothAuthorized = new Promise<void>(resolve => { release = resolve; });
    const demote = (headers: Record<string,string>, target: string) => {
      // Body reads occur after require(); hold both requests here to reproduce stale authority.
      const body = new ReadableStream<Uint8Array>({ async pull(controller) {
        if (++waiting === 2) release(); await bothAuthorized;
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ id: target, role: 'curator', enabled: true }))); controller.close();
      } }, { highWaterMark: 0 });
      return raceAuth.route(new Request(origin + '/api/admin/curators', { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body, duplex: 'half' } as RequestInit));
    };
    const responses = await Promise.all([demote(sessions[0], 'beta'), demote(sessions[1], 'alpha')]);
    assert.deepEqual(responses.map(response => response!.status).sort(), [200, 403]);
    const remaining = await db.query("SELECT id FROM curators WHERE id IN ('alpha','beta') AND role='admin' AND enabled");
    assert.equal(remaining.rowCount, 1);
    assert.equal((await db.query("SELECT count(*) FROM curator_audit WHERE action='curator-access' AND target_id IN ('alpha','beta')")).rows[0].count, '1');
  });
  it('rejects expired/revoked sessions and safely signs out', async () => {
    let editor = await session('editor');
    await db.query("UPDATE curator_sessions SET expires_at=now()-interval '1 second' WHERE curator_id='editor'");
    assert.equal((await auth.route(request('/api/admin/session', 'GET', undefined, editor)))!.status, 401);
    editor = await session('editor'); await db.query("UPDATE curators SET enabled=false WHERE id='editor'");
    assert.equal((await auth.route(request('/api/admin/session', 'GET', undefined, editor)))!.status, 401);
    const owner = await session('owner');
    assert.equal((await auth.route(request('/api/admin/session', 'DELETE', undefined, owner)))!.status, 200);
    assert.equal((await auth.route(request('/api/admin/session', 'GET', undefined, owner)))!.status, 401);
  });
  it('requires same origin for login and secure remote cookies', async () => {
    assert.equal((await auth.route(request('/api/admin/session', 'POST', { credential: key('owner') }, { Origin: 'https://evil.invalid' })))!.status, 403);
    assert.throws(() => new CuratorAuth(db, developmentIdentityProvider([]), 'http://community.example'), /HTTPS/);
    auth = new CuratorAuth(db, developmentIdentityProvider([{ id: 'owner', key: key('owner') }]), 'https://community.example');
    const response = (await auth.route(request('/api/admin/session', 'POST', { credential: key('owner') }, { Origin: 'https://community.example' })))!;
    assert.match(response.headers.get('set-cookie')!, /Secure/);
  });
});
describe('bounded admin payloads', () => {
  it('refuses oversized and non-object JSON before persistence', async () => {
    await assert.rejects(readJson(request('/api/admin/maps', 'POST', { huge: 'x'.repeat(20) }), 10), /too large/);
    await assert.rejects(readJson(request('/api/admin/maps', 'POST', [])), /object/);
    await assert.rejects(readJson(request('/api/admin/maps', 'POST', {}, { 'Content-Type': 'text/plain' })), /application\/json/);
  });
});
