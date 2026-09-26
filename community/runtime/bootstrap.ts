/** Browser reference adapter for the exact release in manifest.json.
 * This is a local compatibility harness, never the public submission validator.
 */
type Legacy = Record<string, any>;
type RequireModule = (id: number) => Legacy;
type Difficulty = "normal" | "hard";

export interface ReferenceState {
  difficulty: Difficulty;
  state: Legacy;
  engineReady: boolean;
  screen: string;
  effectivePluginCount: number;
}

declare global {
  interface Window {
    __konkrCommunityPrepare: (requireModule: RequireModule, config: Legacy) => void;
    launchGame: () => Promise<void>;
    tStart: number;
    setLoadingStatus: (message: string, loading?: boolean) => void;
    communityReference: {
      ready: boolean;
      errors: string[];
      blockedRequests: string[];
      disabledServices: string[];
      importMap: (encoded: string, difficulty: Difficulty) => Promise<ReferenceState>;
      inspect: () => ReferenceState;
      play: (name: string, payload?: unknown) => void;
      act: (name: string, payload?: unknown) => void;
      exportHistory: () => unknown;
    };
  }
}

const errors: string[] = [];
const blockedRequests: string[] = [];
const disabledServices: string[] = [];
let requireModule: RequireModule;
let prepared = false;
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const diagnostic = (error: unknown) => {
  errors.push(error instanceof Error ? error.message : String(error));
};

window.tStart = performance.now();
window.setLoadingStatus = (message, loading) => {
  const status = document.getElementById("status");
  if (status) status.textContent = message;
  document.getElementById("loader")?.classList.toggle("hidden", loading === false);
  document.getElementById("phaser-game")?.classList.toggle("hidden", loading !== false || !!message);
};
window.addEventListener("error", (event) => diagnostic(event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => diagnostic(event.reason));
document.addEventListener("securitypolicyviolation", (event) => blockedRequests.push(event.blockedURI));

function inspect(): ReferenceState {
  const { inject } = requireModule(32070);
  return {
    engineReady: window.communityReference.ready,
    difficulty: inject.ui.session.aiDifficulty,
    state: plain(requireModule(13524).compressGameState(inject.gameStateController.currentState)),
    screen: requireModule(55151).app.navigator.currentScreen?.name ?? "",
    effectivePluginCount: inject.plugins.plugins.length,
  };
}

async function waitForScreen(): Promise<void> {
  const deadline = performance.now() + 15_000;
  // EngineInitialized precedes the first navigation. Yield before inspecting it.
  do {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const navigator = requireModule(55151).app.navigator;
    if (navigator.currentScreen && !navigator.transitionInProgress) return;
  } while (performance.now() < deadline);
  throw new Error("Reference screen transition did not settle");
}

window.communityReference = {
  ready: false,
  errors,
  blockedRequests,
  disabledServices,
  async importMap(encoded, difficulty) {
    if (!this.ready) throw new Error("Reference engine is not ready");
    if (difficulty !== "normal" && difficulty !== "hard") throw new Error("Unsupported difficulty");
    // Call the original new-map import path; never use this method to resume.
    const { inject } = requireModule(32070);
    const codec = requireModule(47067);
    if (!codec.isEncodedGameState(encoded)) throw new Error("Expected an encoded map, not a replay/profile");
    inject.userData.rememberChoice("aiDifficulty", difficulty);
    await waitForScreen();
    await requireModule(20667).parseKonkrData(encoded);
    await waitForScreen();
    return inspect();
  },
  inspect,
  play(name, payload) {
    if (!this.ready) throw new Error("Reference engine is not ready");
    const factory = requireModule(43566).Plays[name];
    if (typeof factory !== "function") throw new Error("Unknown reference play");
    // Trusted test-driver API, not a security boundary. Validation is a separate task.
    requireModule(32070).inject.gameStateController.executePlay(factory(payload));
  },
  act(name, payload) {
    if (!this.ready) throw new Error("Reference engine is not ready");
    const factory = requireModule(43566).UserActions[name];
    if (typeof factory !== "function") throw new Error("Unknown reference user action");
    requireModule(56876).events.trigger(factory(payload));
  },
  exportHistory() {
    return plain(requireModule(32070).inject.gameStateController.history.export({
      snapshotPolicy: ["initial", "final"], includeRewinds: true,
    }));
  },
};

window.__konkrCommunityPrepare = (loader, config) => {
  if (prepared) throw new Error("Reference bootstrap ran twice");
  prepared = true;
  requireModule = loader;
  // Mutate only external-service configuration; preserve rule, AI and map flags.
  config.flags.cloudSync = false;
  config.flags.telemetry = false;
  config.flags.skipTutorial = true;
  config.serviceWorker.enabled = false;
  config.reporting = {
    slack: { enabled: false, feedbackHook: "" },
    sentry: { enabled: false, dsn: "" },
    googleAnalytics: { enabled: false },
  };
  config.remoteConfigDefaults = { levelTelemetrySampleRate: 0, replaysSampleRate: 0 };
  config.helpPagesBaseUrl = "assets/html/help/";
  config.levelStatsBaseUrl = "unavailable/level-stats/";
  config.cloudFunctionsUrl = "unavailable/cloud-functions/";
  config.serviceWorker.scope = "";

  const disabled = (name: string) => { disabledServices.push(name); };
  loader(65606).Firebase.initialize = () => disabled("firebase");
  loader(92703).SentryErrorHandler = class LocalErrorHandler {
    gameRunning = false;
    hadErrors = false;
    tamperingDetected = false;
    constructor() { disabled("sentry"); }
    initializeContext() {}
    logEvent() {}
    handleException(error: unknown) { this.hadErrors = true; diagnostic(error); }
    handleNonFatalError(error: unknown, context: string) { diagnostic(`${context}: ${String(error)}`); }
  };
  const login = loader(65358).LoginService.prototype;
  login.initialize = function () { this.state.set("Disabled"); disabled("auth"); };
  login.parseUrlParams = async () => {};
  const cloud = loader(71205).CloudSyncService.prototype;
  cloud.initialize = function () { this.status.set("disabled"); disabled("cloud-sync"); };
  cloud.uploadDataWipe = () => {};
  loader(9443).AnalyticsReporter = class LocalAnalytics {
    constructor() { disabled("analytics"); }
    setUserProperties() {}
    setDefaultEventParams() {}
  };
  loader(72758).Reporter = class LocalReporter {
    constructor() { disabled("reporting"); }
    setupTelemetryReporting() {}
    async sendTelemetryEvents() {}
  };
  // Avoid the original analytics warning fallback; retain the same call shape.
  const track = loader(18658).track;
  for (const [key, value] of Object.entries(track)) {
    if (typeof value === "function") track[key] = () => {};
    else if (value && typeof value === "object") {
      for (const nested of Object.keys(value)) (value as Legacy)[nested] = () => {};
    }
  }
  // Register after initPlatform has created its event bus, before launch starts.
};

window.addEventListener("DOMContentLoaded", async () => {
  try {
    if (!prepared) throw new Error("Guarded runtime hook did not execute");
    const platform = requireModule(56876);
    platform.events.on(requireModule(43566).SystemEvents.EngineInitialized, () => {
      void waitForScreen().then(() => { window.communityReference.ready = true; }, diagnostic);
    });
    await window.launchGame();
  } catch (error) { diagnostic(error); }
}, { once: true });
