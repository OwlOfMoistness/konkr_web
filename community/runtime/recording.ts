import { LIMITS, parseDecision, parseSubmission } from '../shared/contracts.ts';
import type { PlayerDecision, ReplaySubmission } from '../shared/contracts.ts';
import type { ReferenceModuleLoader } from './bootstrap.ts';
import type { CatalogBridgeEvent, CatalogRunContext, createCatalogBridge } from './catalog-bridge.ts';

export interface RecordedDecision { historyIndex: number; decision: PlayerDecision }
export interface RunRecording {
  version: 1;
  runId: string;
  idempotencyKey: string;
  complete: boolean;
  issue?: string;
  decisions: RecordedDecision[];
}
export interface RecorderOptions {
  loader: ReferenceModuleLoader;
  bridge: ReturnType<typeof createCatalogBridge>;
  onError: (error: Error) => void;
  onVictory?: (context: CatalogRunContext, submission: ReplaySubmission) => void;
}

/** The supplied history index is for branch bookkeeping, never part of the public protocol. */
export function semanticDecision(play: { name: string; payload?: Record<string, unknown> }): PlayerDecision | null {
  const payload = play.payload ?? {};
  switch (play.name) {
    case 'PLAY.MOVE_PAWN': return parseDecision({ kind: 'move', pawnId: payload.pawnId, destinationHexId: payload.destinationHexId });
    case 'PLAY.BUY_PAWN': return parseDecision({ kind: 'buy', pawnType: payload.pawnType, destinationHexId: payload.destinationHexId, buyerRegionId: payload.buyerRegionId });
    case 'PLAY.END_TURN': return { kind: 'end-turn' };
    case 'PLAY.ACCEPT_SURRENDER': return { kind: 'accept-surrender' };
    default: return null;
  }
}

export function restoreRecording(value: unknown, runId: string, historyLength: number): RunRecording {
  if (!value || typeof value !== 'object') throw new Error('This saved game has no complete run recording. Start a new run to submit a result.');
  const source = value as RunRecording;
  if (source.version !== 1 || source.runId !== runId || typeof source.complete !== 'boolean' || typeof source.idempotencyKey !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(source.idempotencyKey) || !Array.isArray(source.decisions) || source.decisions.length > LIMITS.decisions) throw new Error('The saved recording does not match this run.');
  let previous = -1;
  const decisions = source.decisions.map(item => {
    if (!item || !Number.isSafeInteger(item.historyIndex) || item.historyIndex < 0 || item.historyIndex <= previous || item.historyIndex >= historyLength) throw new Error('The saved recording has an invalid history branch.');
    previous = item.historyIndex;
    return { historyIndex: item.historyIndex, decision: parseDecision(item.decision) };
  });
  return { version: 1, runId, idempotencyKey: source.idempotencyKey, complete: source.complete, issue: typeof source.issue === 'string' ? source.issue : undefined, decisions };
}

export function recordingSubmission(recording: RunRecording): ReplaySubmission {
  if (!recording.complete) throw new Error(recording.issue ?? 'This run is missing part of its recording.');
  const submission = parseSubmission({ version: 1, runId: recording.runId, idempotencyKey: recording.idempotencyKey, decisions: recording.decisions.map(item => item.decision) });
  if (new TextEncoder().encode(JSON.stringify(submission)).byteLength > LIMITS.submissionBytes) throw new Error('This run is too large to submit. Your saved game is still available.');
  return submission;
}

/** Observe committed original history and its branch operations; leave gameplay/rules untouched. */
export function attachRunRecorder(options: RecorderOptions) {
  const { loader, bridge } = options;
  const { inject } = loader(32070);
  const controller = inject.gameStateController;
  const history = controller.history;
  const originalAddPlay = history.addPlay;
  const originalRewind = history.rewindTo;
  const originalReset = history.reset;
  const originalImport = history.import;
  const landing = loader(19290).PickLandingSpotMode.prototype;
  const originalLanding = landing.handleStartInteraction;
  let recording: RunRecording | null = null;
  let context: CatalogRunContext | null = null;
  let capturing = false;
  let choosingLanding = false;
  let queued = false;
  let destroyed = false;
  const incomplete = (message: string) => {
    if (recording?.complete) { recording.complete = false; recording.issue = message; options.onError(new Error(message)); }
  };
  const persistSoon = () => {
    if (queued || destroyed) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!capturing || destroyed || controller.eventsPaused) return;
      try { bridge.save(); } catch (error) { options.onError(error instanceof Error ? error : new Error(String(error))); }
    });
  };
  const append = (decision: PlayerDecision, historyIndex: number) => {
    if (!recording || !recording.complete) return;
    if (recording.decisions.length >= LIMITS.decisions) { incomplete('This run has reached the recording limit. It can be played, but cannot be submitted.'); return; }
    recording.decisions.push({ historyIndex, decision }); persistSoon();
  };
  history.addPlay = function (play: { name: string; payload?: Record<string, unknown> }, ...args: unknown[]) {
    // Each existing step describes state AFTER that step, hence the preceding step is our before-state.
    const beforeFaction = this.data.at(-1)?.activeFaction;
    const result = originalAddPlay.call(this, play, ...args);
    if (capturing && recording) {
      if (beforeFaction === 1) {
        try {
          const decision = semanticDecision(play);
          if (decision) append(decision, this.data.length - 1);
          else incomplete('An unsupported game action interrupted this run recording.');
        } catch { incomplete('A game action could not be recorded. Start a new run to submit a result.'); }
      }
      persistSoon();
    }
    return result;
  };
  history.rewindTo = function (cursor: { currentIndex: number }, ...args: unknown[]) {
    const result = originalRewind.call(this, cursor, ...args);
    if (capturing && recording) { recording.decisions = recording.decisions.filter(item => item.historyIndex <= cursor.currentIndex); persistSoon(); }
    return result;
  };
  history.reset = function (...args: unknown[]) {
    const result = originalReset.apply(this, args);
    if (capturing && !choosingLanding) { incomplete('The game history was replaced. Start a new run to submit a result.'); persistSoon(); }
    return result;
  };
  history.import = function (...args: unknown[]) {
    const result = originalImport.apply(this, args);
    if (capturing) { incomplete('A different replay replaced this run recording.'); persistSoon(); }
    return result;
  };
  landing.handleStartInteraction = function (hex: { id: number } | undefined, ...args: unknown[]) {
    const shouldRecord = capturing && !!hex && this.isValidLandingSpot(hex);
    choosingLanding = shouldRecord;
    try {
      const result = originalLanding.call(this, hex, ...args);
      if (shouldRecord && hex) {
        if (recording?.decisions.length) incomplete('The landing choice replaced an existing run branch.');
        else append(parseDecision({ kind: 'choose-landing', hexId: hex.id }), 0);
      }
      return result;
    } finally { choosingLanding = false; }
  };
  const onLifecycle = (event: CatalogBridgeEvent) => {
    switch (event.type) {
      case 'starting': capturing = false; context = event.context; recording = null; break;
      case 'started': {
        context = event.context;
        recording = { version: 1, runId: context.binding.id, idempotencyKey: crypto.randomUUID(), complete: true, decisions: [] };
        if (event.resume) {
          try {
            recording = restoreRecording(event.resume.recording, context.binding.id, history.length);
            if (!recording.complete) options.onError(new Error(recording.issue ?? 'This saved run has an incomplete recording.'));
          }
          catch (error) { incomplete(error instanceof Error ? error.message : 'The saved recording is unavailable.'); }
        }
        capturing = true; break;
      }
      case 'saving':
        if (recording && recording.runId === event.save.context.binding.id) event.save.recording = structuredClone(recording);
        break;
      case 'leaving': capturing = false; break;
      case 'outcome':
        if (event.outcome === 'Victory' && recording) {
          try { options.onVictory?.(event.context, recordingSubmission(recording)); }
          catch (error) { options.onError(error instanceof Error ? error : new Error(String(error))); }
        }
        break;
    }
  };
  const unsubscribe = bridge.subscribe(onLifecycle);
  // Installing after play began cannot retroactively certify that all decisions were captured.
  if (bridge.current()) {
    context = bridge.current();
    recording = { version: 1, runId: context!.binding.id, idempotencyKey: crypto.randomUUID(), complete: false, issue: 'Recording started after this run began. Start a new run to submit a result.', decisions: [] };
    capturing = true; options.onError(new Error(recording.issue));
  }
  return {
    snapshot: () => recording ? structuredClone(recording) : null,
    submission: () => { if (!recording) throw new Error('No recorded run is active.'); return recordingSubmission(recording); },
    flush: () => bridge.save(),
    destroy: () => {
      if (destroyed) return;
      bridge.save(); destroyed = true; capturing = false; unsubscribe();
      history.addPlay = originalAddPlay; history.rewindTo = originalRewind; history.reset = originalReset; history.import = originalImport; landing.handleStartInteraction = originalLanding;
    },
  };
}
