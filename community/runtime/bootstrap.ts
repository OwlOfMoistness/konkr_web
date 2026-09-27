/** Browser reference adapter for the exact release in manifest.json.
 * This is a local compatibility harness, never the public submission validator.
 */
type Legacy = Record<string, any>;
export type ReferenceModuleLoader = (id: number) => Legacy;
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
    __konkrCommunityPrepare: (requireModule: ReferenceModuleLoader, config: Legacy) => void;
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
      withEngine: <T>(operation: (loader: ReferenceModuleLoader) => T) => T;
    };
  }
}

const errors: string[] = [];
const blockedRequests: string[] = [];
const disabledServices: string[] = [];
let requireModule: ReferenceModuleLoader;
let prepared = false;
let localErrors: { handleException(error: unknown): void } | undefined;
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const diagnostic = (error: unknown) => {
  errors.push(error instanceof Error ? error.message : String(error));
};

window.tStart = performance.now();
window.setLoadingStatus = (message, loading) => {
  const status = document.getElementById("status");
  if (status) {
    status.textContent = message;
    status.classList.toggle("hidden", !message);
  }
  document.getElementById("loader")?.classList.toggle("hidden", loading === false);
  document.getElementById("phaser-game")?.classList.toggle("hidden", loading !== false || !!message);
};
const handleException = (error: unknown) => {
  if (localErrors) localErrors.handleException(error);
  else {
    diagnostic(error);
    window.setLoadingStatus("The game could not start. Please reload the page and try again.", false);
  }
};
window.addEventListener("error", (event) => handleException(event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => handleException(event.reason));
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
  withEngine(operation) {
    if (!this.ready) throw new Error("Reference engine is not ready");
    // Trusted addon seam only: client access can never confer server authority.
    return operation(requireModule);
  },
};

window.__konkrCommunityPrepare = (loader, config) => {
  if (prepared) throw new Error("Reference bootstrap ran twice");
  prepared = true;
  requireModule = loader;
  // Preserve rule, AI and map flags. The local preview intentionally opens the
  // title menu instead of automatically launching the first-visit tutorial.
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
    private showingFatalError = false;
    constructor() { localErrors = this; disabled("sentry"); }
    initializeContext() {}
    logEvent() {}
    handleException(error: unknown) {
      this.hadErrors = true;
      diagnostic(error);
      if (!this.gameRunning) {
        window.setLoadingStatus("The game could not start. Please reload the page and try again.", false);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      // These browser failures are suppressed by the pinned release too.
      if (["Failed to start the audio device", "Illegal invocation", "The database connection is closing"].some(value => message.includes(value))) return;
      if (this.showingFatalError) return;
      this.showingFatalError = true;
      loader(56876).events.trigger(loader(43566).SystemEvents.FatalError({
        correlationId: "community-local", message,
      }));
    }
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
    constructor() {
      disabled("reporting");
      // The original reporter also owns the fatal-error UI subscription.
      // Keep that local recovery behavior while excluding delivery and prompts.
      loader(56876).events.on(loader(43566).SystemEvents.FatalError, ({ correlationId }: Legacy) => {
        loader(55151).app.notifications.uncaughtError(correlationId);
      });
    }
    setupTelemetryReporting() {}
    async sendTelemetryEvents() {}
  };
  loader(54209).showErrorNotification = () => {
    const { app } = loader(55151);
    const { NotificationStyle, NotificationCategory, NotificationScope } = loader(48823);
    app.notifications.add({
      style: NotificationStyle.Alert, category: NotificationCategory.Error,
      scope: NotificationScope.Global, icon: app.notifications.ui.image("ui/icons/dead"),
      content: new (loader(91034).CallToActionForm)(app.scene.globalUI).applyProps({
        title: "The game encountered an error",
        content: "Please reload the page to recover. Your latest saved progress will be available. This local preview does not send error reports.",
        action: "RELOAD",
        async onSubmit() {
          loader(32070).inject.ui.session.end({ origin: "error/reload" });
          window.location.reload();
        },
      }),
    });
  };
  const notices = () => loader(55151).app.notifications;
  const statistics = loader(38996);
  const createStatisticsButton = statistics.createLevelStatsButton;
  statistics.createLevelStatsButton = (ui: Legacy, ...args: unknown[]) => {
    const localUi = Object.create(ui);
    localUi.outlineButton = (options: Legacy) => ui.outlineButton({ ...options, onClicked: () => {
      notices().warning("Statistics unavailable", "Official online statistics are disabled in this community preview.");
    } });
    return createStatisticsButton(localUi, ...args);
  };
  loader(81490).showFeedbackForm = () => {
    notices().warning("Feedback unavailable", "Feedback delivery to the original game developer is disabled in this community preview.");
  };
  loader(81490).askForLevelFeedback = () => {};
  // These information pages belong to the original website, not the local API.
  for (const page of Object.values(loader(80149).HtmlDocs) as Legacy[]) {
    page.url = new URL(page.url, "https://www.konkr.io").href;
  }
  // Preserve original share-link semantics on HTTP local previews too. Creating
  // a clipboard URL must not navigate or change the player's current address.
  loader(71040).createUrl = (hash: string) => `${window.location.origin}${window.location.pathname}#${hash}`;
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
      void waitForScreen().then(() => { window.communityReference.ready = true; }, handleException);
    });
    await window.launchGame();
  } catch (error) { handleException(error); }
}, { once: true });
