import type { Pool } from 'pg';
import { LIMITS } from '../shared/contracts.ts';
import type { ValidationResult } from '../shared/contracts.ts';
import { inTransaction } from './maps-admin.ts';

export interface ValidationLease { id: string; leaseToken: string }
export interface AccountingOptions { maxAttempts: number; retryBaseMs: number }
export type AccountingOutcome = { disposition: 'stale' } | { disposition: 'retry'; availableAt: string } | { disposition: 'complete'; result: ValidationResult };
const code = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const turns = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 2_147_483_647;

/** Reject malformed adapter output instead of allowing an accidental success to reach counters. */
export function parseValidationResult(value: unknown): ValidationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid adapter result');
  const result = value as Record<string, unknown>;
  switch (result.status) {
    case 'verified':
      if (result.outcome === 'victory' && turns(result.turns) && typeof result.finalStateHash === 'string' && /^[a-f0-9]{64}$/.test(result.finalStateHash)) return { status: 'verified', outcome: 'victory', turns: result.turns, finalStateHash: result.finalStateHash };
      break;
    case 'non-winning':
      if ((result.outcome === 'unfinished' || result.outcome === 'defeat') && turns(result.turns)) return { status: 'non-winning', outcome: result.outcome, turns: result.turns };
      break;
    case 'invalid':
      if (code(result.code) && (result.decisionIndex === undefined || (Number.isSafeInteger(result.decisionIndex) && (result.decisionIndex as number) >= 0 && (result.decisionIndex as number) <= LIMITS.decisions))) return { status: 'invalid', code: result.code, ...(result.decisionIndex === undefined ? {} : { decisionIndex: result.decisionIndex as number }) };
      break;
    case 'unsupported': if (code(result.code)) return { status: 'unsupported', code: result.code }; break;
    case 'error': if (code(result.code) && typeof result.retryable === 'boolean') return { status: 'error', code: result.code, retryable: result.retryable }; break;
  }
  throw new Error('Invalid adapter result');
}

/** The live lease, terminal outcome and public counters commit together, or none of them do. */
export async function persistValidationResult(db: Pool, lease: ValidationLease, value: ValidationResult, options: AccountingOptions): Promise<AccountingOutcome> {
  const result = parseValidationResult(value);
  return inTransaction(db, async client => {
    const row = (await client.query(`SELECT * FROM runs WHERE id=$1 AND state='running' AND lease_token=$2
      FOR UPDATE`, [lease.id, lease.leaseToken])).rows[0];
    if (!row) return { disposition: 'stale' };
    // A WHERE time predicate can pass before FOR UPDATE waits. Check the database clock
    // again after acquiring the lock so an expired holder cannot finalize late.
    const live = (await client.query('SELECT $1::timestamptz>clock_timestamp() AS live', [row.lease_until])).rows[0].live;
    if (!live) return { disposition: 'stale' };
    if (result.status === 'error' && result.retryable && row.attempts < options.maxAttempts) {
      const delay = Math.min(options.retryBaseMs * 2 ** (row.attempts - 1), 300_000);
      const updated = await client.query(`UPDATE runs SET state='queued',lease_token=NULL,lease_until=NULL,
        available_at=clock_timestamp()+($2::double precision*interval '1 millisecond') WHERE id=$1 RETURNING available_at`, [row.id, delay]);
      return { disposition: 'retry', availableAt: new Date(updated.rows[0].available_at).toISOString() };
    }
    const terminal: ValidationResult = result.status === 'error' ? { ...result, retryable: false } : result;
    const counted = terminal.status === 'verified';
    if (counted) {
      // Use only the immutable database binding, never a worker/client-supplied score bucket.
      const binding = row.binding;
      if (binding.revisionId !== row.revision_id || !['normal','hard'].includes(binding.difficulty) || typeof binding.engineHash !== 'string') throw new Error('Stored run binding is inconsistent');
      await client.query(`INSERT INTO map_score_buckets(revision_id,difficulty,engine_hash,completions,best_turns)
        VALUES($1,$2,$3,1,$4) ON CONFLICT(revision_id,difficulty,engine_hash) DO UPDATE
        SET completions=map_score_buckets.completions+1,best_turns=LEAST(map_score_buckets.best_turns,EXCLUDED.best_turns),updated_at=now()`,
      [row.revision_id, binding.difficulty, binding.engineHash, terminal.turns]);
    }
    await client.query(`UPDATE runs SET state='complete',lease_token=NULL,lease_until=NULL,result=$2,completed_at=clock_timestamp(),counted=$3 WHERE id=$1`, [row.id, JSON.stringify(terminal), counted]);
    return { disposition: 'complete', result: terminal };
  });
}
