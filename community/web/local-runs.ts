import { LIMITS, parseSubmission } from '../shared/contracts.ts';
import type { PublicRunStatus, ReplaySubmission } from '../shared/contracts.ts';
import type { CatalogSave, CatalogSaveStore } from '../runtime/catalog-bridge.ts';

const SAVE_PREFIX = 'konkr.community.save.v1:';
const PENDING_KEY = 'konkr.community.pending.v1';
const MAX_SAVE_BYTES = 8_000_000;
export interface PendingRun {
  submission: ReplaySubmission;
  createdAt: string;
  status: PublicRunStatus;
}
type LocalStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

/** Saves and pending submissions use different keys; restarting a map cannot erase its pending result. */
export class LocalRunStore implements CatalogSaveStore {
  private storage: LocalStorage;
  constructor(storage: LocalStorage) { this.storage = storage; }
  private write(key: string, value: unknown, limit = MAX_SAVE_BYTES): void {
    const encoded = JSON.stringify(value);
    if (byteLength(encoded) > limit) throw new Error('This recording is too large for local storage. Keep this tab open; your previous save is unchanged.');
    try { this.storage.setItem(key, encoded); }
    catch { throw new Error('Your browser could not save this run. Free some storage and try again before closing this tab.'); }
  }
  get(key: string): CatalogSave | null {
    const value = this.storage.getItem(SAVE_PREFIX + key);
    if (!value) return null;
    try {
      if (byteLength(value) > MAX_SAVE_BYTES) throw new Error();
      const save = JSON.parse(value) as CatalogSave;
      if (save.version !== 1 || !save.context?.binding || !save.state || typeof save.savedAt !== 'string') throw new Error();
      return save;
    } catch { throw new Error('This saved run is damaged or incompatible. Your other saves are unchanged.'); }
  }
  put(key: string, save: CatalogSave): void { this.write(SAVE_PREFIX + key, save); }
  remove(key: string): void { this.storage.removeItem(SAVE_PREFIX + key); }
  pending(): PendingRun[] {
    const value = this.storage.getItem(PENDING_KEY);
    if (!value) return [];
    try {
      if (byteLength(value) > MAX_SAVE_BYTES) throw new Error();
      const entries = JSON.parse(value) as PendingRun[];
      if (!Array.isArray(entries) || entries.length > 50) throw new Error();
      return entries.map(entry => {
        if (!entry || typeof entry.createdAt !== 'string' || !entry.status || typeof entry.status.status !== 'string') throw new Error();
        return { ...entry, submission: parseSubmission(entry.submission) };
      });
    } catch { throw new Error('The pending results could not be read. They have been preserved for recovery.'); }
  }
  enqueue(submission: ReplaySubmission): void {
    const parsed = parseSubmission(submission);
    if (byteLength(JSON.stringify(parsed)) > LIMITS.submissionBytes) throw new Error('This run exceeds the submission size limit.');
    const pending = this.pending();
    const previous = pending.find(entry => entry.submission.runId === parsed.runId);
    if (previous) {
      if (JSON.stringify(previous.submission) !== JSON.stringify(parsed)) throw new Error('A different result is already pending for this run.');
      return;
    }
    if (pending.length >= 50) throw new Error('There are too many pending results. Retry their submissions before adding another.');
    pending.push({ submission: parsed, createdAt: new Date().toISOString(), status: { status: 'pending', runId: parsed.runId } });
    this.write(PENDING_KEY, pending);
  }
  setStatus(runId: string, status: PublicRunStatus): void {
    const pending = this.pending();
    const run = pending.find(entry => entry.submission.runId === runId);
    if (!run) throw new Error('The pending run was not found.');
    run.status = status; this.write(PENDING_KEY, pending);
  }
  acknowledge(runId: string): void {
    this.write(PENDING_KEY, this.pending().filter(entry => entry.submission.runId !== runId));
  }
}
