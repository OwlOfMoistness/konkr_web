import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { decodeSubmission, LIMITS } from '../shared/contracts.ts';
import type { ObjectStorage, RunBinding, SimulationAdapter, ValidationInput, ValidationResult } from '../shared/contracts.ts';
import { parseMap } from '../engine/map-format.ts';
import { digest } from '../api/runs.ts';
import { parseValidationResult, persistValidationResult } from '../api/results.ts';

export interface ValidationMetric {
  event: 'validation-claim' | 'validation-outcome' | 'validation-retry' | 'validation-stale' | 'validation-worker-error';
  stage: 'claim' | 'load-submission' | 'load-map' | 'validate' | 'persist';
  runId?: string;
  attempt?: number;
  recovered?: boolean;
  queueWaitMs?: number;
  durationMs?: number;
  outcome?: ValidationResult['status'];
  code?: string;
  rssBytes: number;
  heapUsedBytes: number;
}
export interface WorkerOptions {
  concurrency?: number;
  leaseMs?: number;
  pollMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  onMetric?: (metric: ValidationMetric) => void;
}
export interface ClaimedRun {
  id: string;
  leaseToken: string;
  binding: RunBinding;
  revisionId: string;
  submissionKey: string;
  submissionHash: string;
  idempotencyKey: string;
  attempts: number;
  exhausted: boolean;
  recovered: boolean;
  availableAt: string;
}

/** Single-statement atomic claim: replicas never wait behind another claimant's row lock. */
export async function claimValidationRun(db: Pool, leaseMs: number, maxAttempts: number): Promise<ClaimedRun | null> {
  const token = randomUUID();
  const result = await db.query(`WITH candidate AS (
    SELECT id,state AS previous_state,attempts AS previous_attempts FROM runs
    WHERE (state='queued' AND available_at<=clock_timestamp()) OR (state='running' AND lease_until<=clock_timestamp())
    ORDER BY available_at,submitted_at,id FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE runs r SET state='running',lease_token=$1,lease_until=clock_timestamp()+($2::double precision*interval '1 millisecond'),
    attempts=CASE WHEN r.attempts<$3 THEN r.attempts+1 ELSE r.attempts END
    FROM candidate c WHERE r.id=c.id RETURNING r.*,c.previous_state,c.previous_attempts`, [token, leaseMs, maxAttempts]);
  const row = result.rows[0];
  return row ? { id: row.id, leaseToken: token, binding: row.binding, revisionId: row.revision_id,
    submissionKey: row.submission_key, submissionHash: row.submission_hash, idempotencyKey: row.idempotency_key,
    attempts: row.attempts, exhausted: row.previous_attempts >= maxAttempts, recovered: row.previous_state === 'running', availableAt: new Date(row.available_at).toISOString() } : null;
}
class JobFailure extends Error {
  code: string;
  retryable: boolean;
  constructor(code: string, retryable: boolean) { super(code); this.code = code; this.retryable = retryable; }
}
function bounded(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid validation worker configuration'); return value;
}

/** Runs a fresh bounded injected adapter; original engine processes and trusted map bytes stay outside HTTP handlers. */
export class ValidationWorker {
  private db: Pool;
  private storage: ObjectStorage;
  private adapter: SimulationAdapter;
  private options: Required<Omit<WorkerOptions, 'onMetric'>> & Pick<WorkerOptions, 'onMetric'>;
  private running = false;
  private stopping = false;
  private healthy = false;
  private lastPollAt: string | null = null;
  private lastError: string | null = null;
  private active = new Set<Promise<boolean>>();
  private lanes: Promise<void>[] = [];
  private wakeups = new Set<() => void>();
  private totals = { claimed: 0, completed: 0, retried: 0, stale: 0, errors: 0 };
  constructor(db: Pool, storage: ObjectStorage, adapter: SimulationAdapter, options: WorkerOptions = {}) {
    this.db = db; this.storage = storage; this.adapter = adapter;
    this.options = { concurrency: bounded(options.concurrency ?? 1, 1, 16), leaseMs: bounded(options.leaseMs ?? 180_000, 1, 900_000), pollMs: bounded(options.pollMs ?? 1000, 1, 60_000), maxAttempts: bounded(options.maxAttempts ?? 3, 1, 10), retryBaseMs: bounded(options.retryBaseMs ?? 5000, 0, 300_000), onMetric: options.onMetric };
  }
  private emit(metric: Omit<ValidationMetric, 'rssBytes' | 'heapUsedBytes'>): void {
    const memory = process.memoryUsage();
    try { this.options.onMetric?.({ ...metric, rssBytes: memory.rss, heapUsedBytes: memory.heapUsed }); } catch { /* Instrumentation cannot alter adjudication. */ }
  }
  private async blob(key: string, kind: 'submission' | 'map'): Promise<Uint8Array> {
    let object;
    try { object = await this.storage.get(key); } catch { throw new JobFailure(`${kind}-storage-failure`, true); }
    if (!object) throw new JobFailure(`${kind}-missing`, true);
    if (object.bytes.byteLength > (kind === 'submission' ? LIMITS.submissionBytes : LIMITS.encodedMapBytes)) throw new JobFailure(`${kind}-size`, false);
    return object.bytes;
  }
  private async load(claim: ClaimedRun, stage: (stage: ValidationMetric['stage']) => void): Promise<ValidationInput> {
    stage('load-submission');
    const bytes = await this.blob(claim.submissionKey, 'submission');
    if (digest(bytes) !== claim.submissionHash) throw new JobFailure('submission-integrity', false);
    let submission;
    try { submission = decodeSubmission(Buffer.from(bytes).toString('utf8')); } catch { throw new JobFailure('submission-format', false); }
    if (submission.runId !== claim.id || submission.idempotencyKey !== claim.idempotencyKey) throw new JobFailure('submission-binding', false);
    stage('load-map');
    const revision = (await this.db.query('SELECT map_id,object_key,content_hash,engine_hash,plugins FROM map_revisions WHERE id=$1', [claim.revisionId])).rows[0];
    if (!revision) throw new JobFailure('canonical-map-missing', false);
    const binding = claim.binding;
    if (binding.id !== claim.id || binding.revisionId !== claim.revisionId || binding.mapId !== revision.map_id || binding.mapHash !== revision.content_hash || binding.engineHash !== revision.engine_hash || !Array.isArray(binding.plugins) || binding.plugins.length !== revision.plugins.length || binding.plugins.some((plugin, index) => plugin !== revision.plugins[index])) throw new JobFailure('canonical-binding-integrity', false);
    const canonicalBytes = await this.blob(revision.object_key, 'map');
    if (digest(canonicalBytes) !== binding.mapHash) throw new JobFailure('map-integrity', false);
    const canonicalMap = Buffer.from(canonicalBytes).toString('utf8');
    try { parseMap(canonicalMap); } catch { throw new JobFailure('map-format', false); }
    return { binding, canonicalMap, decisions: submission.decisions };
  }
  private async processOne(): Promise<boolean> {
    let claim: ClaimedRun | null;
    try { claim = await claimValidationRun(this.db, this.options.leaseMs, this.options.maxAttempts); this.lastPollAt = new Date().toISOString(); this.healthy = true; this.lastError = null; }
    catch (error) { this.healthy = false; this.lastError = 'claim-database-failure'; this.totals.errors++; this.emit({ event: 'validation-worker-error', stage: 'claim', code: this.lastError }); throw error; }
    if (!claim) return false;
    this.totals.claimed++;
    const started = performance.now(); let stage: ValidationMetric['stage'] = 'load-submission';
    this.emit({ event: 'validation-claim', stage: 'claim', runId: claim.id, attempt: claim.attempts, recovered: claim.recovered, queueWaitMs: Math.max(0, Date.now() - Date.parse(claim.availableAt)) });
    let result: ValidationResult;
    if (claim.exhausted) result = { status: 'error', code: 'lease-attempts-exhausted', retryable: false };
    else try {
      const input = await this.load(claim, value => { stage = value; }); stage = 'validate';
      let output: unknown;
      try { output = await this.adapter.validate(input); } catch { throw new JobFailure('adapter-exception', true); }
      try { result = parseValidationResult(output); } catch { throw new JobFailure('adapter-result-format', false); }
    } catch (error) {
      result = error instanceof JobFailure ? { status: 'error', code: error.code, retryable: error.retryable } : { status: 'error', code: 'job-infrastructure-failure', retryable: true };
    }
    try {
      const outcome = await persistValidationResult(this.db, claim, result, this.options);
      const timing = { stage, runId: claim.id, attempt: claim.attempts, durationMs: performance.now() - started };
      if (outcome.disposition === 'stale') { this.totals.stale++; this.emit({ event: 'validation-stale', ...timing }); }
      else if (outcome.disposition === 'retry') { this.totals.retried++; this.emit({ event: 'validation-retry', ...timing, code: result.status === 'error' ? result.code : undefined }); }
      else { this.totals.completed++; this.emit({ event: 'validation-outcome', ...timing, outcome: outcome.result.status, code: 'code' in outcome.result ? outcome.result.code : undefined }); }
    } catch (error) {
      this.healthy = false; this.lastError = 'persist-database-failure'; this.totals.errors++;
      this.emit({ event: 'validation-worker-error', stage: 'persist', runId: claim.id, attempt: claim.attempts, durationMs: performance.now() - started, code: this.lastError });
      // Leave the lease for crash recovery; commit uncertainty must never cause a second increment here.
      throw error;
    }
    return true;
  }
  async runOnce(): Promise<boolean> {
    if (this.stopping || this.active.size >= this.options.concurrency) return false;
    const work = this.processOne(); this.active.add(work);
    try { return await work; } finally { this.active.delete(work); }
  }
  private wait(): Promise<void> {
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this.wakeups.delete(finish); resolve(); };
      const timer = setTimeout(finish, this.options.pollMs); this.wakeups.add(finish);
    });
  }
  start(): void {
    if (this.running) return;
    this.running = true; this.stopping = false;
    this.lanes = Array.from({ length: this.options.concurrency }, async () => {
      while (this.running) {
        let worked = false; try { worked = await this.runOnce(); } catch { /* Health and metrics already expose the failed stage. */ }
        if (!worked && this.running) await this.wait();
      }
    });
  }
  async stop(): Promise<void> {
    this.running = false; this.stopping = true;
    for (const wake of [...this.wakeups]) wake();
    await Promise.allSettled([...this.lanes, ...this.active]); this.lanes = []; this.healthy = false;
  }
  health() { return { healthy: this.healthy, running: this.running, active: this.active.size, lastPollAt: this.lastPollAt, lastError: this.lastError, ...this.totals }; }
}
