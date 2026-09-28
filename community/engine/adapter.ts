import type { Difficulty } from '../shared/contracts.ts';
import { parseMap } from './map-format.ts';
import type { ParsedMap } from './map-format.ts';
import { createModuleLoader, sha256 } from './platform.ts';
import type { EngineRequire, EngineSources, Recovered } from './platform.ts';

export interface SimulationLimits { maxTurns: number; maxInternalPlays: number; maxPhaseTransitions: number }
export const DEFAULT_SIMULATION_LIMITS: SimulationLimits = Object.freeze({ maxTurns: 2_000, maxInternalPlays: 100_000, maxPhaseTransitions: 14_000 });
export class SimulationLimitError extends Error {
  code: string;
  constructor(code: string) { super(code); this.name = 'SimulationLimitError'; this.code = code; }
}
export interface EngineOutcome { winner: number | null; turns: number }
export interface EngineCheckpoint {
  phase: 'initial' | 'player' | 'ai-turn' | 'neutral-turn';
  factionId: number;
  state: Recovered;
  outcome?: EngineOutcome;
}
export interface SessionOptions { seed?: number; runtimeLevelId?: string; limits?: Partial<SimulationLimits>; onCheckpoint?: (checkpoint: EngineCheckpoint) => void }
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Cosmetic region labels consume the UI's shared RNG (66810/99999/50061).
 * Keep raw snapshots for diagnosis; omit only this field from gameplay hashes.
 * No arrays are sorted and the binding-derived level ID remains authoritative.
 */
export function gameplayState(state: Recovered): Recovered {
  const copy = plain(state);
  for (const region of copy.regions) delete region.name;
  return copy;
}

/** Internal simulation surface. Public input goes through player-commands.ts. */
export class EngineSession {
  readonly requireModule: EngineRequire;
  readonly loadedModules: number[];
  readonly parsedMap: ParsedMap;
  readonly controller: Recovered;
  readonly model: Recovered;
  readonly core: Recovered;
  readonly difficulty: Difficulty;
  readonly limits: SimulationLimits;
  outcome?: EngineOutcome;
  internalPlays = 0;
  phaseTransitions = 0;
  surrenderOffered = false;
  private onCheckpoint?: SessionOptions['onCheckpoint'];
  private terminalState?: unknown;

  constructor(sources: EngineSources, encodedMap: string, difficulty: Difficulty, options: SessionOptions = {}) {
    this.parsedMap = parseMap(encodedMap);
    if (!['normal', 'hard'].includes(difficulty)) throw new Error('Unsupported difficulty');
    this.difficulty = difficulty;
    this.limits = { ...DEFAULT_SIMULATION_LIMITS, ...options.limits };
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid simulation limit');
    if (options.seed !== undefined && (!Number.isSafeInteger(options.seed) || options.seed < 0)) throw new Error('Invalid engine seed');
    if (options.runtimeLevelId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(options.runtimeLevelId)) throw new Error('Invalid runtime level ID');
    this.onCheckpoint = options.onCheckpoint;
    const { requireModule: get, loadedModules } = createModuleLoader(sources);
    this.requireModule = get;
    this.loadedModules = loadedModules;
    const fatal = (error: unknown): never => { throw error instanceof Error ? error : new Error(String(error)); };
    get(56876).initPlatform({
      events: new (get(40118).TypedEventBus)(), random: get(50061).createRandomGenerator(options.seed ?? 0),
      // Production config (5964) batches state mutations. This changes which
      // projections capture bookkeeping sees inside a transaction (76223/77022).
      storage: new (get(50080).InMemoryStorage)(),
      config: {
        debug: { ai: false, recordStateChanges: false, integrityChecks: undefined, cheats: false },
        flags: { mergeMutations: true },
      },
      errors: { handleNonFatalError: fatal, handleException: fatal },
    });
    this.controller = new (get(8058).GameStateController)();
    this.model = this.controller.model;
    get(55151).setAppContext({
      // The exact context preserves the original victory checks. Session identity
      // is consumed by the AI's cancellation watcher, not its gameplay decisions.
      screen: { play: { context: get(25972).NewGameStateContext.StartingNewGame } },
      scene: { worldMap: { currentSessionId: 'server-run' } }, audio: { playEffect() {} },
    });
    const controller = this.controller;
    this.core = {
      gameStateController: controller, gameStateModel: this.model,
      get currentGameState() { return controller.model.state; },
      set currentGameState(value: unknown) { controller.model.restore(value); },
      get plugins() { return controller.model.plugins; },
      ui: { session: { id: 'server-run', aiDifficulty: difficulty, dismissedSurrender: false } },
      debugData: { set() {} }, async debugBreakpoint() {}, performance: { async preventFreeze() {} },
    };
    get(32070).setCoreContext(this.core);
    this.core.views = new (get(84165).ViewsManager)();
    this.core.ai = new (get(84989).AIController)();
    // Count attempted engine plays too: speculative AI branches may be discarded.
    const original = controller.executePlay.bind(controller);
    controller.executePlay = (play: Recovered) => {
      if (++this.internalPlays > this.limits.maxInternalPlays) throw new SimulationLimitError('internal-play-limit');
      const value = original(play);
      this.checkLimits();
      return value;
    };
    controller.onEvent((event: Recovered) => {
      if (event.name === get(43566).GameStateEvents.GameOver.eventName && !this.outcome) {
        this.outcome = { winner: event.payload.winningFactionId ?? null,
          turns: get(84911).CurrentPhase.getTurnNumber(event.payload.state) };
        this.terminalState = event.payload.state;
      }
    });
    // parseMap excludes all replay/history snapshots and executable map hooks.
    const initial = plain(this.parsedMap.state);
    if (options.runtimeLevelId) (initial.map as Recovered).levelId = options.runtimeLevelId;
    controller.loadState(initial, get(25972).NewGameStateContext.StartingNewGame);
    if (!this.model.factions.localPlayer?.isAlive()) this.outcome = { winner: null, turns: this.model.currentPhase.turnNumber };
    this.refreshSurrenderOffer();
    this.capture('initial', this.model.currentPhase.faction.id);
  }

  checkLimits(): void {
    if (this.model.currentPhase.turnNumber > this.limits.maxTurns) throw new SimulationLimitError('turn-limit');
  }
  snapshot(): Recovered { return plain(this.requireModule(13524).compressGameState(this.terminalState ?? this.model.state)); }
  stateHash(): string { return sha256(JSON.stringify(gameplayState(this.snapshot()))); }
  capture(phase: EngineCheckpoint['phase'], factionId: number): void {
    this.onCheckpoint?.({ phase, factionId, state: this.snapshot(), ...(this.outcome ? { outcome: { ...this.outcome } } : {}) });
  }
  executeInternal(name: string, payload?: unknown): void {
    const factory = this.requireModule(43566).Plays[name];
    if (typeof factory !== 'function') throw new Error('Unknown internal engine play');
    this.controller.executePlay(factory(payload));
  }
  refreshSurrenderOffer(): void {
    // Original offer is computed on entry to the local turn (module 5378).
    this.surrenderOffered = !this.outcome && this.model.currentPhase.isLocalPlayerTurn() &&
      this.model.currentPhase.tappedUnits().length === 0 && this.core.ai.allowSurrender &&
      !this.core.ui.session.dismissedSurrender && this.requireModule(896).shouldOfferSurrender(this.model.state);
  }
  async settleOpponents(): Promise<void> {
    const { FactionController } = this.requireModule(62928);
    while (!this.outcome) {
      if (!this.model.factions.localPlayer?.isAlive()) {
        this.outcome = { winner: null, turns: this.model.currentPhase.turnNumber };
        break;
      }
      const faction = this.model.currentPhase.faction;
      if (faction?.controller === FactionController.LocalUser) { this.refreshSurrenderOffer(); return; }
      if (!faction) throw new Error('Engine has no active faction');
      if (++this.phaseTransitions > this.limits.maxPhaseTransitions) throw new SimulationLimitError('phase-transition-limit');
      // This is the gameplay part of original module 5378.handleFactionTurnStarted.
      if (faction.controller === FactionController.Ai) {
        const result = await this.core.ai.play(faction);
        if (result !== 'success') throw new Error(`AI did not finish: ${String(result)}`);
      } else if (faction.controller === FactionController.None) {
        if (faction.id === this.requireModule(15006).SpecialFaction.neutral) this.executeInternal('BanditsAct');
      } else throw new Error('Unsupported faction controller');
      if (!this.outcome) this.executeInternal('EndTurn');
      this.capture(faction.controller === FactionController.Ai ? 'ai-turn' : 'neutral-turn', faction.id);
    }
  }
}

export function createEngineSession(sources: EngineSources, encodedMap: string, difficulty: Difficulty, options: SessionOptions = {}): EngineSession {
  return new EngineSession(sources, encodedMap, difficulty, options);
}
