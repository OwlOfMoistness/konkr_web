import type { CatalogEntry, CatalogReader, Difficulty, PublicRunStatus, ReplaySubmission, RunBinding } from '../shared/contracts.ts';
import { bindingMatches } from '../runtime/catalog-bridge.ts';
import type { CatalogRunContext, CatalogSave } from '../runtime/catalog-bridge.ts';
import { LocalRunStore, LocalRunStorageError } from './local-runs.ts';
import type { PendingRun } from './local-runs.ts';
import type { VisitorClient } from './ratings.ts';

export class RunApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export interface ResultsApi {
  issue(entry: CatalogEntry, difficulty: Difficulty): Promise<RunBinding>;
  submit(submission: ReplaySubmission): Promise<PublicRunStatus>;
  read(runId: string): Promise<{ binding: RunBinding; result: PublicRunStatus | null }>;
}
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const record = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The result server returned an invalid response.');
  return value as Record<string, any>;
};
export function readRunStatus(value: unknown, runId: string): PublicRunStatus {
  const result = record(value);
  const turns = Number.isSafeInteger(result.turns) && result.turns >= 0;
  switch (result.status) {
    case 'pending': if (result.runId === runId) return { status: 'pending', runId }; break;
    case 'verified': if (result.outcome === 'victory' && turns && typeof result.finalStateHash === 'string' && /^[a-f0-9]{64}$/.test(result.finalStateHash)) return { status: 'verified', outcome: 'victory', turns: result.turns, finalStateHash: result.finalStateHash }; break;
    case 'non-winning': if (turns && ['unfinished','defeat'].includes(result.outcome)) return { status: 'non-winning', outcome: result.outcome, turns: result.turns }; break;
    case 'invalid': if (typeof result.code === 'string' && (result.decisionIndex === undefined || (Number.isSafeInteger(result.decisionIndex) && result.decisionIndex >= 0))) return { status: 'invalid', code: result.code, ...(result.decisionIndex === undefined ? {} : { decisionIndex: result.decisionIndex }) }; break;
    case 'unsupported': if (typeof result.code === 'string') return { status: 'unsupported', code: result.code }; break;
    case 'error': if (typeof result.code === 'string' && typeof result.retryable === 'boolean') return { status: 'error', code: result.code, retryable: result.retryable }; break;
  }
  throw new Error('The result server returned an invalid response.');
}
function readBinding(value: unknown): RunBinding {
  const binding = record(value);
  if (!identifier(binding.id) || !identifier(binding.mapId) || !identifier(binding.revisionId) || typeof binding.mapHash !== 'string' || typeof binding.engineHash !== 'string' || typeof binding.adapterVersion !== 'string' || !['normal','hard'].includes(binding.difficulty) || !Array.isArray(binding.plugins) || binding.plugins.some((plugin: unknown) => typeof plugin !== 'string') || !Number.isFinite(Date.parse(binding.issuedAt)) || !Number.isFinite(Date.parse(binding.expiresAt))) throw new Error('The server returned an invalid run binding.');
  return structuredClone(binding) as RunBinding;
}

export function createResultsApi(visitor: VisitorClient, fetcher: typeof fetch = fetch): ResultsApi {
  const request = async (path: string, body?: unknown) => {
    const csrf = body === undefined ? undefined : await visitor.csrfToken();
    const response = await fetcher(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(15_000), headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf! }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data: unknown; try { data = await response.json(); } catch { throw new RunApiError(response.status, 'The result service is unavailable. Your recording is retained.'); }
    if (!response.ok) throw new RunApiError(response.status, typeof (data as any)?.error === 'string' ? (data as any).error : 'The result request failed.');
    return record(data);
  };
  const path = (id: string) => { if (!identifier(id)) throw new Error('Invalid run identity'); return '/api/runs/' + encodeURIComponent(id); };
  return {
    async issue(entry, difficulty) { const response = await request('/api/runs', { mapId: entry.map.id, revisionId: entry.revision.id, difficulty }); const binding = readBinding(response.binding); if (!bindingMatches(binding, entry, difficulty)) throw new Error('The server issued a different map configuration. Try again.'); return binding; },
    async submit(submission) { return readRunStatus(await request(path(submission.runId) + '/submission', submission), submission.runId); },
    async read(runId) { const response = await request(path(runId)); const binding = readBinding(response.binding); if (binding.id !== runId) throw new Error('The server returned a different run.'); return { binding, result: response.result === null ? null : readRunStatus(response.result, runId) }; },
  };
}

export interface RunProblem { message: string; retryable: boolean }
export interface ResultView { local: PendingRun; status: PublicRunStatus | null; problem?: RunProblem; busy: boolean }
export interface ResultsOptions {
  api: ResultsApi;
  store: LocalRunStore;
  pollIntervalMs?: number;
  onVerified?: (context: PendingRun['context']) => void;
  onError?: (error: Error) => void;
}
const waiting = (status: PublicRunStatus | null) => status === null || status.status === 'pending' || (status.status === 'error' && status.retryable);
function problemFor(error: unknown): RunProblem {
  if (error instanceof LocalRunStorageError) return { message: error.message, retryable: true };
  if (error instanceof RunApiError) {
    if (error.status === 400 || error.status === 413) return { message: 'The server could not accept this recording. It is retained; start a new run with the current game version.', retryable: false };
    if (error.status === 429) return { message: 'Too many result requests. The recording is retained; wait before retrying.', retryable: true };
    if (error.status === 410) return { message: 'This run has expired. Its recording is retained, but it cannot be verified.', retryable: false };
    if (error.status === 409) return { message: 'A different submission is already recorded for this run. This local recording is retained; start a new run for a different attempt.', retryable: false };
    if (error.status === 401 || error.status === 403) return { message: 'This browser session cannot access the run. Reload with the original browser session to retry.', retryable: true };
    if (error.status === 404 || error.status === 422) return { message: 'This run or validator version is unavailable. The saved recording is retained.', retryable: false };
  }
  return { message: 'The result service could not be reached. Your recording is saved; retry when connected.', retryable: true };
}

/** Only responses observed from the API populate status; cached local fields never certify a result. */
export function createResultsController(options: ResultsOptions) {
  const views = new Map<string, Omit<ResultView, 'local'>>();
  const listeners = new Set<() => void>();
  const active = new Map<string, Promise<void>>();
  const announced = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  const report = (error: unknown) => options.onError?.(error instanceof Error ? error : new Error(String(error)));
  const notify = () => { for (const listener of listeners) listener(); };
  const snapshot = (): ResultView[] => options.store.pending().map(local => ({ local, ...(views.get(local.submission.runId) ?? { status: null, busy: false }) }));
  const schedule = () => {
    if (destroyed || timer) return;
    if (!snapshot().some(view => view.status !== null && waiting(view.status) && !view.problem)) return;
    timer = setTimeout(() => { timer = undefined; void refresh(); }, options.pollIntervalMs ?? 3_000);
  };
  const update = async (runId: string, retry = false): Promise<void> => {
    if (destroyed) return;
    if (active.has(runId)) return active.get(runId)!;
    const local = options.store.pending().find(entry => entry.submission.runId === runId);
    if (!local) return;
    views.set(runId, { status: views.get(runId)?.status ?? null, busy: true }); notify();
    const operation = Promise.resolve().then(async () => {
      try {
        let status: PublicRunStatus | null;
        if (!local.acknowledged || retry) status = await options.api.submit(local.submission);
        else status = (await options.api.read(runId)).result;
        // A stored acknowledgement with no server submission can be recovered by the same immutable retry.
        if (status === null) status = await options.api.submit(local.submission);
        if (destroyed) return;
        options.store.setStatus(runId, status);
        views.set(runId, { status, busy: false });
        if (status.status === 'verified' && !announced.has(runId)) { announced.add(runId); options.onVerified?.(local.context); }
      } catch (error) {
        if (destroyed) return;
        views.set(runId, { status: views.get(runId)?.status ?? null, busy: false, problem: problemFor(error) });
      } finally { active.delete(runId); if (!destroyed) { notify(); schedule(); } }
    });
    active.set(runId, operation); return operation;
  };
  const refresh = async () => {
    try { await Promise.all(snapshot().filter(view => !view.problem && waiting(view.status)).map(view => update(view.local.submission.runId))); }
    catch (error) { report(error); }
  };
  const online = () => { for (const view of snapshot()) if (view.problem?.retryable) void update(view.local.submission.runId, !view.local.acknowledged); void refresh(); };
  if (typeof window !== 'undefined') window.addEventListener('online', online);
  return {
    async onStart(entry: CatalogEntry, difficulty: Difficulty): Promise<RunBinding> {
      const binding = await options.api.issue(entry, difficulty); options.store.rememberIssued(binding); return binding;
    },
    enqueue(context: CatalogRunContext, submission: ReplaySubmission) {
      if (submission.runId !== context.binding.id) throw new Error('The recording belongs to a different run.');
      options.store.enqueue(submission, { title: context.entry.map.metadata.title, mapId: context.binding.mapId, revisionId: context.binding.revisionId, revision: context.entry.revision.revision, difficulty: context.difficulty });
      notify(); void update(submission.runId);
    },
    snapshot, refresh,
    retry: (runId: string) => update(runId, true),
    dismiss(runId: string) {
      const view = views.get(runId);
      if (!view?.status || waiting(view.status) || view.busy) throw new Error('Wait for a final server result before dismissing this recording.');
      options.store.acknowledge(runId); views.delete(runId); notify();
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    destroy() { destroyed = true; if (timer) clearTimeout(timer); if (typeof window !== 'undefined') window.removeEventListener('online', online); listeners.clear(); },
  };
}
export type ResultsController = ReturnType<typeof createResultsController>;

export function describeResult(view: ResultView): string {
  if (view.problem) return view.problem.message;
  const status = view.status;
  if (!status) return view.busy ? 'Checking server status…' : 'Local win recorded. Waiting to send for verification.';
  switch (status.status) {
    case 'pending': return 'Local win recorded. Server verification pending.';
    case 'verified': return `Verified victory · ${status.turns} ${status.turns === 1 ? 'turn' : 'turns'}.`;
    case 'non-winning': return status.outcome === 'defeat' ? 'The server replay ended in defeat. No completion counted.' : 'The server replay is unfinished. No completion counted.';
    case 'invalid': return `Recording rejected (${status.code}). No completion counted.`;
    case 'unsupported': return `This validator cannot check the saved rules (${status.code}). The recording is retained.`;
    case 'error': return status.retryable ? 'Validation infrastructure failed. The server is retrying; the recording is retained.' : `Validation infrastructure failed (${status.code}). The recording is retained for investigation.`;
  }
}

export function mountResults(root: HTMLElement, options: { controller: ResultsController; store: LocalRunStore; reader?: Pick<CatalogReader, 'get'>; resumeSaved: (save: CatalogSave) => Promise<void> }) {
  root.classList.add('community-results');
  const details = document.createElement('details');
  const summary = document.createElement('summary'); summary.textContent = 'Saved games and results';
  const content = document.createElement('div'); content.className = 'community-results-content'; details.append(summary, content); root.replaceChildren(details);
  let destroyed = false; let generation = 0;
  const text = (tag: 'h2'|'h3'|'p', value: string) => { const element = document.createElement(tag); element.textContent = value; return element; };
  const button = (label: string, action: () => void | Promise<void>) => {
    const element = document.createElement('button'); element.type = 'button'; element.textContent = label;
    element.onclick = () => { element.disabled = true; void Promise.resolve().then(action).catch(error => { const message = text('p', error instanceof Error ? error.message : 'The action failed.'); message.setAttribute('role', 'alert'); content.prepend(message); }).finally(() => { element.disabled = false; }); };
    return element;
  };
  const render = () => {
    const token = ++generation; content.replaceChildren();
    try {
      let results: ResultView[] = [];
      try { results = options.controller.snapshot(); } catch (error) { const message = text('p', error instanceof Error ? error.message : 'Pending results could not be read.'); message.setAttribute('role', 'alert'); content.append(message); }
      summary.textContent = `Saved games and results${results.length ? ` (${results.length} ${results.length === 1 ? 'result' : 'results'})` : ''}`;
      content.append(text('h2', 'Results'));
      if (!results.length) content.append(text('p', 'Completed runs awaiting or receiving a server result will appear here.'));
      for (const view of results) {
        const article = document.createElement('article');
        article.append(text('h3', view.local.context?.title ?? `Run ${view.local.submission.runId}`));
        const status = text('p', describeResult(view)); status.setAttribute('role', 'status'); article.append(status);
        if (view.local.context) article.append(text('p', `${view.local.context.difficulty === 'normal' ? 'Normal' : 'Hard'} · ${view.local.context.revision === undefined ? 'saved revision' : `revision ${view.local.context.revision}`}`));
        if (view.problem?.retryable) { const retry = button('Retry result', () => options.controller.retry(view.local.submission.runId)); retry.disabled = view.busy; article.append(retry); }
        if (view.status && !waiting(view.status) && !view.problem) article.append(button('Dismiss result', () => options.controller.dismiss(view.local.submission.runId)));
        content.append(article);
      }
      content.append(text('h2', 'Saved games'));
      const saves = options.store.saves();
      if (!saves.length) content.append(text('p', 'No saved custom games on this browser yet.'));
      for (const item of saves) {
        const article = document.createElement('article');
        if (!item.save) { const status = text('p', item.error); status.setAttribute('role', 'alert'); article.append(status); content.append(article); continue; }
        const save = item.save;
        article.append(text('h3', save.context.entry.map.metadata.title), text('p', `${save.context.difficulty === 'normal' ? 'Normal' : 'Hard'} · saved revision ${save.context.entry.revision.revision}`));
        const availability = text('p', 'Resumes this saved revision and its original run.'); article.append(availability);
        if (Date.parse(save.context.binding.expiresAt) <= Date.now()) article.append(text('p', 'This run has expired. You can continue playing locally, but cannot submit a new verified result.'));
        article.append(button('Resume saved game', () => options.resumeSaved(save))); content.append(article);
        if (options.reader) void options.reader.get(save.context.binding.mapId).then(current => {
          if (destroyed || generation !== token) return;
          availability.textContent = !current ? 'This map is no longer in the catalog. Your saved revision can still be resumed.' : current.revision.id !== save.context.binding.revisionId ? 'An updated revision is published. Resume keeps your original revision and run.' : 'Resumes this saved revision and its original run.';
        }).catch(() => { if (!destroyed && generation === token) availability.textContent = 'Catalog unavailable. Your saved revision can still be resumed offline.'; });
      }
    } catch (error) { const message = text('p', error instanceof Error ? error.message : 'Saved runs could not be loaded.'); message.setAttribute('role', 'alert'); content.append(message); }
  };
  const unsubscribe = options.controller.subscribe(render); render(); void options.controller.refresh();
  return { refresh: () => { render(); void options.controller.refresh(); }, destroy() { destroyed = true; generation++; unsubscribe(); root.replaceChildren(); } };
}
