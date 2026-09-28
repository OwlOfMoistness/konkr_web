import type { CatalogEntry, Difficulty, RunBinding } from '../shared/contracts.ts';
import type { ReferenceModuleLoader } from './bootstrap.ts';
import { runtimeLevelId } from '../shared/runtime-identity.ts';

type EngineState = Record<string, any>;
export interface CatalogRunContext {
  entry: CatalogEntry;
  difficulty: Difficulty;
  binding: RunBinding;
  runtimeLevelId: string;
  canonicalMap: string;
}
export interface CatalogSave {
  version: 1;
  context: CatalogRunContext;
  state: EngineState;
  sessionId: string;
  remainingLives: number;
  savedAt: string;
  recording?: unknown;
}
export interface CatalogSaveStore {
  get(key: string): CatalogSave | null;
  put(key: string, save: CatalogSave): void;
  remove(key: string): void;
}
export type CatalogBridgeEvent =
  | { type: 'starting'; context: CatalogRunContext; resume: CatalogSave | null }
  | { type: 'started'; context: CatalogRunContext; resume: CatalogSave | null }
  | { type: 'saving'; save: CatalogSave }
  | { type: 'leaving'; context: CatalogRunContext; outcome: string | null }
  | { type: 'outcome'; context: CatalogRunContext; outcome: string };
export interface CatalogBridgeOptions {
  loader: ReferenceModuleLoader;
  engineHash: string;
  store: CatalogSaveStore;
  loadMap: (entry: CatalogEntry) => Promise<string>;
  /** Required before importing a fresh game or restart; rejection leaves the prior save intact. */
  onStart: (entry: CatalogEntry, difficulty: Difficulty, reason: 'new' | 'restart') => Promise<RunBinding>;
  onReturn: (context: CatalogRunContext, outcome: string | null) => void | Promise<void>;
  /** Addon navigation can return directly to its own native screen, without visiting Title. */
  navigateOnReturn?: (context: CatalogRunContext, outcome: string | null) => Promise<void>;
  onError: (error: Error) => void;
}

export function catalogSaveKey(entry: CatalogEntry, difficulty: Difficulty): string {
  return JSON.stringify([entry.map.id, entry.revision.id, entry.revision.contentHash, entry.revision.engineHash, difficulty]);
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function bindingMatches(binding: RunBinding, entry: CatalogEntry, difficulty: Difficulty): boolean {
  return binding.mapId === entry.map.id && binding.revisionId === entry.revision.id && binding.mapHash === entry.revision.contentHash && binding.engineHash === entry.revision.engineHash && binding.difficulty === difficulty &&
    binding.plugins.length === entry.revision.plugins.length && binding.plugins.every((plugin, index) => plugin === entry.revision.plugins[index]);
}

/** Trusted client lifecycle adapter. Its snapshots, state and local outcomes never authorize a result. */
export function createCatalogBridge(options: CatalogBridgeOptions) {
  const { loader } = options;
  const { inject } = loader(32070);
  const { app } = loader(55151);
  const platform = loader(56876);
  const codec = loader(47067);
  const contexts = loader(25972).NewGameStateContext;
  const returnModule = loader(37585);
  const importModule = loader(20667);
  const originalImport = importModule.parseKonkrData;
  const originalReturn = returnModule.returnToMenuFromGame;
  const originalTrigger = platform.events.trigger;
  const originalSaveProgress = inject.userData.saveLevelProgress;
  const listeners = new Set<(event: CatalogBridgeEvent) => void>();
  let active: CatalogRunContext | null = null;
  let outcome: string | null = null;
  let busy = false;
  let destroyed = false;
  const emit = (event: CatalogBridgeEvent) => { for (const listener of listeners) listener(event); };
  const report = (error: unknown) => options.onError(error instanceof Error ? error : new Error(String(error)));
  const settle = async () => {
    const deadline = performance.now() + 20_000;
    while (app.navigator.transitionInProgress) {
      if (performance.now() > deadline) throw new Error('The game is still changing screens. Please try again.');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const save = (): CatalogSave | null => {
    if (!active || inject.gameStateModel.map.levelId !== active.runtimeLevelId) return null;
    // AI exploration mutates speculative branches inside a transaction. Never persist one.
    if (inject.gameStateController.eventsPaused) return options.store.get(catalogSaveKey(active.entry, active.difficulty));
    const state = inject.gameStateController.exportStateWithHistory({ snapshotPolicy: ['initial', 'p1-rewind-checkpoints', 'final'], includeRewinds: true });
    const record: CatalogSave = { version: 1, context: copy(active), state: copy(state), sessionId: inject.ui.session.id, remainingLives: inject.ui.session.remainingLives, savedAt: new Date().toISOString() };
    emit({ type: 'saving', save: record });
    options.store.put(catalogSaveKey(active.entry, active.difficulty), record);
    return record;
  };
  const detach = () => {
    if (!active) return;
    const context = active; const result = outcome;
    active = null; outcome = null;
    emit({ type: 'leaving', context, outcome: result });
  };
  const detachReplacedMap = () => {
    if (active && !busy && inject.gameStateModel.map.levelId !== active.runtimeLevelId) detach();
  };
  const leave = async (): Promise<void> => {
    if (!active || busy) return;
    busy = true;
    try {
      const context = active; const result = outcome;
      save(); emit({ type: 'leaving', context, outcome: result });
      active = null; outcome = null;
      if (inject.ui.session.active) inject.ui.session.end({ origin: 'community/catalog-return' });
      await settle();
      if (options.navigateOnReturn) await options.navigateOnReturn(context, result);
      else await app.navigator.goTo(app.screen.title);
      await settle();
      await options.onReturn(context, result);
    } finally { busy = false; }
  };
  const launch = async (entry: CatalogEntry, difficulty: Difficulty, reason: 'new' | 'restart', resume: CatalogSave | null = null): Promise<void> => {
    if (destroyed || busy) throw new Error('A map is already starting. Please wait.');
    if (entry.revision.engineHash !== options.engineHash) throw new Error('This map needs a different game version.');
    busy = true;
    const previousInput = app.game.input.enabled;
    const previousKeyboard = app.game.input.keyboard.enabled;
    app.game.input.enabled = false; app.game.input.keyboard.enabled = false;
    try {
      await settle();
      const canonicalMap = resume?.context.canonicalMap ?? await options.loadMap(entry);
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalMap)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (digest !== entry.revision.contentHash) throw new Error('The map download does not match its published revision.');
      const binding = resume?.context.binding ?? await options.onStart(entry, difficulty, reason);
      if (!bindingMatches(binding, entry, difficulty)) throw new Error('The run does not match this map revision and difficulty.');
      const levelId = await runtimeLevelId(binding);
      if (resume && (resume.version !== 1 || resume.context.runtimeLevelId !== levelId || resume.state.map?.levelId !== levelId || !resume.state.replay?.steps?.[0]?.snapshot)) throw new Error('This save is incomplete or incompatible. Start a new game to continue.');
      const next: CatalogRunContext = { entry: copy(entry), difficulty, binding: copy(binding), runtimeLevelId: levelId, canonicalMap };
      // All checks and server issuance precede mutation of the game or existing save.
      if (active) save();
      emit({ type: 'starting', context: next, resume });
      active = next; outcome = null;
      inject.userData.rememberChoice('aiDifficulty', difficulty);
      if (resume) {
        const state = copy(resume.state);
        inject.ui.session.startNew({ origin: 'community/resume', levelId, sessionId: resume.sessionId, remainingLives: resume.remainingLives, turnNumber: state.currentPhase.turnNumber, aiDifficulty: difficulty });
        inject.gameStateController.loadState(state, contexts.LoadingGame);
        await app.navigator.goTo(app.screen.play, contexts.LoadingGame);
        app.scene.worldMap.syncState();
      } else {
        const state = codec.decodeGameState(canonicalMap); state.map.levelId = levelId;
        await window.communityReference.importMap(codec.encodeGameState(state), difficulty);
        inject.ui.session.data.origin = 'community/catalog';
      }
      await settle();
      emit({ type: 'started', context: next, resume });
      save();
    } catch (error) { throw error; }
    finally { app.game.input.enabled = previousInput; app.game.input.keyboard.enabled = previousKeyboard; busy = false; }
  };
  returnModule.returnToMenuFromGame = function (...args: unknown[]) {
    detachReplacedMap();
    return active ? leave().catch(report) : originalReturn.apply(this, args);
  };
  importModule.parseKonkrData = async function (encoded: string, ...args: unknown[]) {
    if (!active || busy || (!codec.isEncodedGameState(encoded) && !codec.isEncodedReplay(encoded))) return originalImport.call(this, encoded, ...args);
    // Validate framing before detaching. Profile/chatter imports do not replace gameplay.
    if (codec.isEncodedGameState(encoded)) codec.decodeGameState(encoded);
    else codec.decodeReplay(encoded);
    const previous = active; const previousOutcome = outcome; const saved = save();
    detach();
    try { return await originalImport.call(this, encoded, ...args); }
    catch (error) {
      // An import rejected before replacement must keep the original run/recording usable.
      if (inject.gameStateModel.map.levelId === previous.runtimeLevelId) {
        active = previous; outcome = previousOutcome;
        emit({ type: 'started', context: previous, resume: saved });
      }
      throw error;
    }
  };
  inject.userData.saveLevelProgress = function (...args: unknown[]) {
    const ordinaryLatest = this.current.latestLevelId;
    const result = originalSaveProgress.apply(this, args);
    // The original title's Continue action must never bypass a catalog run binding/recording.
    if (active && this.current.latestLevelId === active.runtimeLevelId) {
      this.current.latestLevelId = ordinaryLatest; this.writeUserData();
    }
    // Native turn/rewind checkpoints must survive even when replay recording is disabled.
    if (active && !busy) { try { save(); } catch (error) { report(error); } }
    return result;
  };
  platform.events.trigger = function (event: EngineState) {
    detachReplacedMap();
    if (active && !busy) {
      if (event.name === 'USER_ACTION.EXIT_LEVEL') { void leave().catch(report); return; }
      if (event.name === 'UI_EVENT.RESTART_CONFIRMED' || (event.name === 'USER_ACTION.PLAY_LEVEL' && event.payload?.levelId === active.runtimeLevelId)) {
        const difficulty = event.payload?.aiDifficulty ?? active.difficulty;
        void launch(active.entry, difficulty, 'restart').catch(report); return;
      }
      if (event.name === 'SYSTEM.SHOW_GAME_OVER_SCREEN') { outcome = event.payload; emit({ type: 'outcome', context: active, outcome: String(outcome) }); }
      if (outcome && event.name === 'USER_ACTION.GOTO_RANDOM_MAP_SELECT') { void leave().catch(report); return; }
    }
    return originalTrigger.call(this, event);
  };
  return {
    start: (entry: CatalogEntry, difficulty: Difficulty) => launch(entry, difficulty, 'new'),
    restart: () => active ? launch(active.entry, active.difficulty, 'restart') : Promise.reject(new Error('No custom map is active.')),
    resume: (entry: CatalogEntry, difficulty: Difficulty) => {
      const stored = options.store.get(catalogSaveKey(entry, difficulty));
      if (!stored) return Promise.reject(new Error('There is no saved game for this map revision and difficulty.'));
      return launch(entry, difficulty, 'new', stored);
    },
    hasSave: (entry: CatalogEntry, difficulty: Difficulty) => !!options.store.get(catalogSaveKey(entry, difficulty)),
    current: () => active ? copy(active) : null,
    isBusy: () => busy,
    save,
    leave,
    subscribe: (listener: (event: CatalogBridgeEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    destroy: () => { save(); destroyed = true; platform.events.trigger = originalTrigger; returnModule.returnToMenuFromGame = originalReturn; importModule.parseKonkrData = originalImport; inject.userData.saveLevelProgress = originalSaveProgress; listeners.clear(); },
  };
}
