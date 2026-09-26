import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, describe, it, test } from 'node:test';
import { Pool } from 'pg';
import { ValidationWorker, claimValidationRun } from '../worker/validate-job.ts';
import type { ValidationMetric } from '../worker/validate-job.ts';
import { parseValidationResult, persistValidationResult } from '../api/results.ts';
import { digest } from '../api/runs.ts';
import { NodeSimulationAdapter } from '../engine/validate.ts';
import { ADAPTER_VERSION, PINNED_RELEASE } from '../engine/platform.ts';
import type { ObjectStorage, RunBinding, SimulationAdapter, SupportedConfigurations, ValidationResult } from '../shared/contracts.ts';

const url = process.env.CATALOG_TEST_DATABASE_URL;
const win = (turns = 1): ValidationResult => ({ status: 'verified', outcome: 'victory', turns, finalStateHash: 'a'.repeat(64) });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('malformed adapter claims cannot become public wins', () => {
  for (const value of [{status:'verified',outcome:'defeat',turns:1,finalStateHash:'a'.repeat(64)}, {status:'verified',outcome:'victory',turns:-1,finalStateHash:'a'.repeat(64)}, {status:'verified',outcome:'victory',turns:2**40,finalStateHash:'a'.repeat(64)}, {status:'verified',outcome:'victory',turns:1,finalStateHash:'not-a-hash'}, {status:'error',code:'private content <secret>',retryable:true}]) assert.throws(() => parseValidationResult(value), /Invalid adapter result/);
});

describe('durable validation leases and atomic accounting', { skip: !url }, () => {
  const schema = `validation_jobs_${process.pid}`;
  let admin: Pool; let db: Pool; let canonical: string; let canonicalHash: string;
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const storage: ObjectStorage = { async get(key) { return objects.get(key) ?? null; }, async put(key, bytes, contentType) { objects.set(key, { bytes, contentType }); }, async delete(key) { objects.delete(key); } };
  const metrics: ValidationMetric[] = [];
  const adapter: SimulationAdapter = { async validate() { return win(); } };
  const create = (simulation: SimulationAdapter = adapter, options = {}) => new ValidationWorker(db, storage, simulation, { retryBaseMs: 0, onMetric: metric => metrics.push(metric), ...options });
  async function enqueue(id: string, options: { revision?: string; difficulty?: 'normal'|'hard'; body?: string } = {}) {
    const revisionId = options.revision ?? 'r1';
    const binding: RunBinding = { id, mapId: 'map', revisionId, mapHash: canonicalHash, engineHash: PINNED_RELEASE.mainHash, adapterVersion: ADAPTER_VERSION, difficulty: options.difficulty ?? 'normal', plugins: [], issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() };
    const body = options.body ?? JSON.stringify({ version: 1, runId: id, idempotencyKey: 'key-' + id, decisions: [{ kind: 'move', pawnId: 3, destinationHexId: 303 }] });
    const key = 'submissions/' + id + '.json'; await storage.put(key, Buffer.from(body), 'application/json');
    await db.query(`INSERT INTO runs(id,browser_token_hash,revision_id,binding,expires_at,state,idempotency_key,submission_hash,submission_key,submitted_at)
      VALUES($1,'private-browser-token',$2,$3,$4,'queued',$5,$6,$7,now())`, [id, revisionId, JSON.stringify(binding), binding.expiresAt, 'key-' + id, digest(body), key]);
    return { binding, key, body };
  }
  const row = async (id: string) => (await db.query('SELECT * FROM runs WHERE id=$1', [id])).rows[0];
  const scores = async () => (await db.query('SELECT revision_id,difficulty,completions,best_turns FROM map_score_buckets ORDER BY revision_id,difficulty')).rows;
  const expire = async (id: string) => { await db.query("UPDATE runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [id]); };
  before(async () => {
    admin = new Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    db = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 10 });
    for (const file of ['001-catalog','003-ratings','004-runs']) await db.query(await readFile(new URL(`../db/${file}.sql`, import.meta.url), 'utf8'));
    const corpus = JSON.parse(await readFile(new URL('fixtures/base-cases.json', import.meta.url), 'utf8'));
    canonical = corpus.cases.find((fixture: { id: string }) => fixture.id === 'tiny-win-normal').encodedMap; canonicalHash = digest(canonical);
    await db.query("INSERT INTO visitors(token_hash) VALUES('private-browser-token')");
    await db.query("INSERT INTO maps(id,title) VALUES('map','Accounting fixture')");
    for (const revision of ['r1','r2']) await db.query(`INSERT INTO map_revisions(id,map_id,revision,content_hash,object_key,engine_hash,plugins,width,height)
      VALUES($1,'map',$2,$3,$4,$5,'{}',6,6)`, [revision, revision === 'r1' ? 1 : 2, canonicalHash, 'maps/' + revision, PINNED_RELEASE.mainHash]);
  });
  beforeEach(async () => {
    await db.query('DELETE FROM runs'); await db.query('DELETE FROM map_score_buckets'); objects.clear(); metrics.length = 0;
    for (const revision of ['r1','r2']) await storage.put('maps/' + revision, Buffer.from(canonical), 'text/plain');
  });
  after(async () => { await db?.end(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } });

  it('separate workers claim one job once, preserve blobs and expose only safe metric fields', async () => {
    const input = await enqueue('one'); let calls = 0;
    const simulation = { async validate() { calls++; await tick(); return win(4); } };
    const a = create(simulation), b = create(simulation);
    assert.deepEqual((await Promise.all([a.runOnce(), b.runOnce()])).sort(), [false, true]);
    assert.equal(calls, 1); assert.equal((await row('one')).counted, true);
    assert.deepEqual(await scores(), [{ revision_id: 'r1', difficulty: 'normal', completions: '1', best_turns: 4 }]);
    assert.equal(await a.runOnce(), false); assert.ok(objects.has(input.key)); assert.ok(objects.has('maps/r1'));
    assert(metrics.some(metric => metric.event === 'validation-claim' && metric.queueWaitMs! >= 0));
    assert(metrics.some(metric => metric.event === 'validation-outcome' && metric.outcome === 'verified' && metric.durationMs! >= 0));
    assert.doesNotMatch(JSON.stringify(metrics), /private-browser-token|konkrmap|pawnId|canonicalMap|decisions/);
  });

  it('concurrent wins count once each and minimize turns only within the exact score bucket', async () => {
    for (const [id, revision, difficulty] of [['slow','r1','normal'],['fast','r1','normal'],['hard','r1','hard'],['new','r2','normal']] as const) await enqueue(id, { revision, difficulty });
    const turns: Record<string,number> = { slow: 9, fast: 3, hard: 7, new: 2 };
    const worker = create({ async validate(input) { return win(turns[input.binding.id]); } }, { concurrency: 4 });
    assert.deepEqual(await Promise.all(Array.from({ length: 4 }, () => worker.runOnce())), [true,true,true,true]);
    assert.deepEqual(await scores(), [
      { revision_id: 'r1', difficulty: 'hard', completions: '1', best_turns: 7 },
      { revision_id: 'r1', difficulty: 'normal', completions: '2', best_turns: 3 },
      { revision_id: 'r2', difficulty: 'normal', completions: '1', best_turns: 2 },
    ]);
  });

  it('fences a slow stale worker after another worker reclaims and completes its expired lease', async () => {
    await enqueue('reclaim'); const entered = deferred<void>(); const release = deferred<ValidationResult>();
    const slow = create({ async validate() { entered.resolve(); return release.promise; } });
    const processing = slow.runOnce(); await entered.promise; const oldToken = (await row('reclaim')).lease_token;
    await expire('reclaim'); const replacement = create({ async validate() { return win(5); } }); await replacement.runOnce();
    release.resolve(win(1)); await processing;
    assert.equal((await row('reclaim')).result.turns, 5); assert.equal((await row('reclaim')).attempts, 2);
    assert.equal((await scores())[0].completions, '1'); assert.equal((await scores())[0].best_turns, 5);
    assert.equal(slow.health().stale, 1);
    assert.deepEqual(await persistValidationResult(db, { id: 'reclaim', leaseToken: oldToken }, win(0), { maxAttempts: 3, retryBaseMs: 0 }), { disposition: 'stale' });
  });

  it('an expired unreclaimed lease cannot finish, and crash recovery stops at the attempt budget', async () => {
    await enqueue('crashed'); const first = (await claimValidationRun(db, 60_000, 2))!; await expire('crashed');
    assert.deepEqual(await persistValidationResult(db, first, win(), { maxAttempts: 2, retryBaseMs: 0 }), { disposition: 'stale' });
    const second = (await claimValidationRun(db, 60_000, 2))!; assert.equal(second.attempts, 2); assert.notEqual(second.leaseToken, first.leaseToken); await expire('crashed');
    let calls = 0; const worker = create({ async validate() { calls++; return win(); } }, { maxAttempts: 2 });
    assert.equal(await worker.runOnce(), true); assert.equal(calls, 0);
    assert.deepEqual((await row('crashed')).result, { status: 'error', code: 'lease-attempts-exhausted', retryable: false });
    assert.equal((await row('crashed')).attempts, 2); assert.equal(await worker.runOnce(), false); assert.deepEqual(await scores(), []);
  });

  it('rechecks lease time after waiting for an unchanged row lock', async () => {
    await enqueue('lock-wait'); const claim = (await claimValidationRun(db, 500, 3))!;
    const leaseUntil = (await row('lock-wait')).lease_until;
    const blocker = await db.connect(); const accounting = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 1 });
    const pid = (await accounting.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN'); await blocker.query("SELECT id FROM runs WHERE id='lock-wait' FOR UPDATE");
      pending = persistValidationResult(accounting, claim, win(), { maxAttempts: 3, retryBaseMs: 0 });
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        waiting = (await db.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.waiting;
        if (!waiting) await tick();
      }
      assert.equal(waiting, true, 'accounting must be waiting on the row lock before the lease expires');
      await blocker.query("SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM($1::timestamptz-clock_timestamp())))+0.01)", [leaseUntil]);
      await blocker.query('COMMIT');
      assert.deepEqual(await pending, { disposition: 'stale' }); assert.deepEqual(await scores(), []);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await pending?.catch(() => {}); await accounting.end(); }
  });

  it('retries transient failures with a bound but preserves invalid, unsupported and non-winning outcomes', async () => {
    await enqueue('transient'); let calls = 0;
    const worker = create({ async validate() { if (++calls < 3) throw new Error('private-browser-token raw engine content'); return win(2); } });
    await worker.runOnce(); assert.equal((await row('transient')).state, 'queued');
    await worker.runOnce(); assert.equal((await row('transient')).state, 'queued');
    await worker.runOnce(); assert.equal((await row('transient')).result.status, 'verified'); assert.equal(calls, 3);
    const outcomes: ValidationResult[] = [{ status: 'invalid', code: 'illegal-move', decisionIndex: 0 }, { status: 'unsupported', code: 'retired-version' }, { status: 'non-winning', outcome: 'unfinished', turns: 1 }, { status: 'non-winning', outcome: 'defeat', turns: 2 }, { status: 'error', code: 'permanent-engine-error', retryable: false }];
    for (const [index, outcome] of outcomes.entries()) {
      const id = 'outcome-' + index; await enqueue(id); await create({ async validate() { return outcome; } }).runOnce();
      assert.deepEqual((await row(id)).result, outcome); assert.equal((await row(id)).attempts, 1); assert.equal((await row(id)).counted, false);
    }
    assert.equal((await scores())[0].completions, '1'); assert.doesNotMatch(JSON.stringify(metrics), /private-browser-token|raw engine content/);
  });

  it('storage/decode/integrity failures remain infrastructure errors and never reach the adapter', async () => {
    let calls = 0; const never = { async validate() { calls++; return win(); } };
    const missing = await enqueue('missing'); objects.delete(missing.key); const worker = create(never);
    for (let attempt = 0; attempt < 3; attempt++) await worker.runOnce();
    assert.deepEqual((await row('missing')).result, { status: 'error', code: 'submission-missing', retryable: false });
    const corrupt = await enqueue('corrupt'); objects.set(corrupt.key, { bytes: Buffer.from('altered'), contentType: 'application/json' }); await create(never).runOnce();
    assert.equal((await row('corrupt')).result.code, 'submission-integrity');
    await enqueue('malformed', { body: '{"snapshot":"untrusted"}' }); await create(never).runOnce(); assert.equal((await row('malformed')).result.code, 'submission-format');
    await enqueue('bad-map'); objects.set('maps/r1', { bytes: Buffer.from('changed map'), contentType: 'text/plain' }); await create(never).runOnce(); assert.equal((await row('bad-map')).result.code, 'map-integrity');
    assert.equal(calls, 0); assert.deepEqual(await scores(), []);
  });

  it('a persistence failure rolls back the counter and crash recovery later counts exactly once', async () => {
    await enqueue('atomic');
    await db.query("CREATE FUNCTION fail_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='complete' THEN RAISE EXCEPTION 'injected completion failure'; END IF; RETURN NEW; END; $$");
    await db.query('CREATE TRIGGER fail_completion BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION fail_completion()');
    const worker = create();
    try { await assert.rejects(worker.runOnce(), /injected completion failure/); }
    finally { await db.query('DROP TRIGGER fail_completion ON runs'); await db.query('DROP FUNCTION fail_completion()'); }
    assert.deepEqual(await scores(), []); assert.equal((await row('atomic')).state, 'running'); assert.equal(worker.health().healthy, false);
    await expire('atomic'); await create().runOnce(); assert.equal((await scores())[0].completions, '1'); assert.equal((await row('atomic')).counted, true);
  });

  it('concurrency is bounded and stop drains active jobs without starting queued work', async () => {
    for (const id of ['a','b','c']) await enqueue(id);
    let entered = 0; const two = deferred<void>(); const release = deferred<ValidationResult>();
    const worker = create({ async validate() { if (++entered === 2) two.resolve(); return release.promise; } }, { concurrency: 2 });
    assert.equal(worker.health().healthy, false); worker.start(); await two.promise;
    assert.equal(worker.health().active, 2); assert.equal(await worker.runOnce(), false);
    let stopped = false; const stop = worker.stop().then(() => { stopped = true; }); await tick(); assert.equal(stopped, false);
    release.resolve(win()); await stop;
    assert.equal(entered, 2); assert.equal(worker.health().healthy, false); assert.equal(worker.health().active, 0);
    assert.equal((await db.query("SELECT count(*) FROM runs WHERE state='queued'")).rows[0].count, '1');
  });

  it('health becomes unhealthy on polling failure and recovers after a successful poll', async () => {
    let fail = true;
    const proxy = { query: (...args: unknown[]) => { if (fail) throw new Error('database secret'); return (db.query as Function).apply(db, args); } } as unknown as Pool;
    const worker = new ValidationWorker(proxy, storage, adapter, { onMetric() { throw new Error('metrics exporter failure'); } });
    assert.equal(worker.health().healthy, false); await assert.rejects(worker.runOnce(), /database secret/); assert.equal(worker.health().healthy, false);
    fail = false; assert.equal(await worker.runOnce(), false); assert.equal(worker.health().healthy, true); assert.equal(worker.health().lastError, null); await worker.stop();
  });

  it('a real isolated tiny winning replay commits the observed turn count and exact bucket', { timeout: 130_000 }, async () => {
    await enqueue('real-engine');
    const policy = JSON.parse(await readFile(new URL('../shared/supported-configurations.json', import.meta.url), 'utf8')) as SupportedConfigurations;
    const worker = create(new NodeSimulationAdapter({ policy, timeoutMs: 120_000, memoryMb: 512 }));
    assert.equal(await worker.runOnce(), true);
    const actual = await row('real-engine'); assert.equal(actual.result.status, 'verified'); assert.equal(actual.result.turns, 1); assert.equal(actual.counted, true);
    assert.deepEqual(await scores(), [{ revision_id: 'r1', difficulty: 'normal', completions: '1', best_turns: 1 }]);
  });
});
