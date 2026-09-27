import type { CatalogEntry } from '../shared/contracts.ts';
import type { ReferenceModuleLoader } from './bootstrap.ts';

interface CatalogScreenOptions {
  loader: ReferenceModuleLoader;
  loadMap(entry: CatalogEntry): Promise<string>;
  show(): Promise<void>;
  hide(): void;
  animateIn(): Promise<unknown>;
  animateOut(): Promise<unknown>;
  keepInputDisabled(): boolean;
  onError(error: Error): void;
}

const identity = (entry: CatalogEntry) => JSON.stringify([entry.revision.id, entry.revision.contentHash, entry.revision.engineHash]);

/** An addon screen sharing the original WorldMap scene with Play, like the native menus. */
export function createCatalogScreen(options: CatalogScreenOptions) {
  const { loader } = options;
  const { app } = loader(55151), { inject } = loader(32070);
  const world = app.scene.worldMap;
  const gameRoot = app.game.canvas.parentElement as HTMLElement;
  let previousInert = gameRoot.inert;
  const { PreviewMode } = loader(28208);
  const contexts = loader(25972).NewGameStateContext;
  const duration = () => matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : loader(56876).config.screenTransitionDuration;
  const cache = new Map<string, Promise<string>>();
  let anchor: HTMLElement | undefined;
  let selectedKey: string | undefined;
  let selection = 0;
  let disposed = false;
  let layout = '';
  let screen: any;

  const loadMap = (entry: CatalogEntry): Promise<string> => {
    const key = identity(entry); let pending = cache.get(key);
    if (!pending) {
      pending = options.loadMap(entry).then(async encoded => {
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encoded)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
        if (hash !== entry.revision.contentHash) throw new Error('The map download does not match its published revision.');
        return encoded;
      }).catch(error => { cache.delete(key); throw error; });
      cache.set(key, pending);
      if (cache.size > 8) cache.delete(cache.keys().next().value!);
    }
    return pending;
  };
  const fit = async (milliseconds = 0): Promise<void> => {
    if (!anchor?.isConnected || app.navigator.currentScreen !== screen) return;
    const rect = anchor.getBoundingClientRect();
    const canvas = app.game.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height || !canvas.width || !canvas.height) return;
    const scaleX = app.game.scale.gameSize.width / canvas.width;
    const scaleY = app.game.scale.gameSize.height / canvas.height;
    const width = rect.width * scaleX, height = rect.height * scaleY;
    const centerX = (rect.left + rect.width / 2 - canvas.left) * scaleX;
    const centerY = (rect.top + rect.height / 2 - canvas.top) * scaleY;
    const controller = world.cameraController, camera = world.cameras.main;
    controller.updateBounds();
    const bounds = controller.worldBounds;
    const inverseZoom = Math.max(bounds.width / width, bounds.height / height) * 1.08;
    const fitted = (0.0952381 + Math.sqrt(Math.max(0, 0.0952381 ** 2 - 4 * 0.0654762 * (0.357143 - inverseZoom)))) / (2 * 0.0654762);
    // Use the native camera's distance curve and never enlarge sprites past normal play scale.
    const distance = Math.max(loader(11537).DEFAULT_CAMERA_ZOOM, fitted);
    const zoom = 1 / (Math.round((distance * distance * .0654762 - .0952381 * distance + .357143) * 100) / 100);
    layout = [rect.x, rect.y, rect.width, rect.height, canvas.width, canvas.height].join(':');
    await controller.center(milliseconds, { zoom: distance,
      offsetX: (camera.x + camera.width / 2 - centerX) / zoom,
      offsetY: (camera.y + camera.height / 2 - centerY) / zoom });
  };

  screen = new (class extends loader(20213).BaseScreen {
    constructor() {
      super('CustomMaps', [loader(9435).Scenes.WorldMap]);
      this.observe.event(loader(43566).UserActions.Escape, () => { void app.navigator.goTo(app.screen.title).catch(options.onError); });
      this.observe.event(loader(43566).UserActions.GoBack, () => { void app.navigator.goTo(app.screen.title).catch(options.onError); });
    }
    async activate(_data: unknown, previous: any) {
      if (previous === app.screen.title) selectedKey = undefined;
      previousInert = gameRoot.inert; gameRoot.inert = true;
      app.game.input.enabled = false; app.game.input.keyboard.enabled = false;
      world.scene.setVisible(true); world.setMode(new PreviewMode());
      // Retain the played board on return. A sync here would snap PreviewMode's camera to center.
      world.overlays.set(inject.currentGameState, loader(91693).OverlayModes.disabled);
      try { await options.show(); } catch (error) { options.onError(error as Error); }
    }
    deactivate() {
      gameRoot.inert = previousInert;
      // The run bridge must finish its recording/checkpoint setup before accepting play input.
      const enabled = !options.keepInputDisabled();
      app.game.input.enabled = enabled; app.game.input.keyboard.enabled = enabled;
    }
    async transitionIn(previous: any) {
      await Promise.all([
        previous === app.screen.title ? loader(72431).titleOutTransition({ keepWorldMap: true }) : Promise.resolve(),
        selectedKey ? fit(duration()) : Promise.resolve(), options.animateIn(),
      ]);
    }
    async transitionOut(_next: any) {
      await options.animateOut(); options.hide();
    }
  })();

  const originalActivate = app.screen.play.activate;
  const activate = function(this: any, context: any, previous: any) {
    // Keep the original import/state initialization. Suppress only its instant presentation reset.
    const presentation = previous === screen && context === contexts.LoadingGame ? { ...context, resetCamera: false } : context;
    return originalActivate.call(this, presentation, previous);
  };
  app.screen.play.activate = activate;
  // Global menu icons otherwise remain visible underneath the non-interactive catalogue.
  // Let their native layout hide them here and restore them on every ordinary screen.
  const sidebar = app.scene.globalUI.sidebarButtons, toggles = app.scene.globalUI.toggleButtons;
  const originalAvailable = sidebar.getAvailableButtons, originalToggles = toggles.getButtonsToShow;
  const available = function(this: any) { return app.navigator.currentScreen === screen ? new Set() : originalAvailable.call(this); };
  const shownToggles = function(this: any) { return app.navigator.currentScreen === screen ? [] : originalToggles.call(this); };
  sidebar.getAvailableButtons = available; toggles.getButtonsToShow = shownToggles;
  const update = () => {
    if (disposed || app.navigator.activeScreen !== screen || app.navigator.transitionInProgress || !anchor?.isConnected) return;
    const rect = anchor.getBoundingClientRect(), canvas = app.game.canvas.getBoundingClientRect();
    if ([rect.x, rect.y, rect.width, rect.height, canvas.width, canvas.height].join(':') !== layout) void fit();
  };
  app.game.events.on('poststep', update);

  return {
    screen, loadMap,
    open: async (): Promise<void> => { await app.navigator.goTo(screen); },
    exit: async (): Promise<void> => { await app.navigator.goTo(app.screen.title); },
    async returnFromPlay(entry: CatalogEntry) { selectedKey = identity(entry); await app.navigator.goTo(screen); },
    mount(container: HTMLElement, entry: CatalogEntry) {
      const token = ++selection; let destroyed = false;
      anchor = container; layout = '';
      const key = identity(entry);
      const ready = (async () => {
        if (selectedKey !== key) {
          world.scene.setVisible(false);
          const encoded = await loadMap(entry);
          // Downloads do not hold Navigator (or Back) hostage. Wait for the menu animation,
          // then render before exposing the new board; never load a preview over live Play.
          while (app.navigator.transitionInProgress && app.navigator.currentScreen === screen && !destroyed && !disposed) {
            await new Promise(resolve => requestAnimationFrame(resolve));
          }
          if (destroyed || disposed || token !== selection || app.navigator.currentScreen !== screen) return;
          const state = loader(47067).decodeGameState(encoded);
          inject.gameStateController.loadState(state, contexts.Preview);
          world.setMode(new PreviewMode()); world.syncState(); selectedKey = key;
          await fit();
          if (!destroyed && token === selection) world.scene.setVisible(true);
        }
        if (!destroyed && token === selection) {
          container.replaceChildren(); container.dataset.livePreviewReady = 'true';
        }
      })();
      void ready.catch(() => {});
      return { ready, destroy() {
        destroyed = true;
        if (token === selection) { anchor = undefined; selection++; }
        delete container.dataset.livePreviewReady;
      } };
    },
    destroy() {
      disposed = true; selection++; cache.clear();
      if (app.navigator.currentScreen === screen) gameRoot.inert = previousInert;
      app.game.events.off('poststep', update);
      if (app.screen.play.activate === activate) app.screen.play.activate = originalActivate;
      if (sidebar.getAvailableButtons === available) sidebar.getAvailableButtons = originalAvailable;
      if (toggles.getButtonsToShow === shownToggles) toggles.getButtonsToShow = originalToggles;
      screen.observe.destroy();
    },
  };
}
