import type { ReferenceModuleLoader } from './bootstrap.ts';
import { LIMITS } from '../shared/contracts.ts';

const protocol = 'konkr-preview-v1';
type Command = { protocol: typeof protocol; type: 'render'; id: string; encoded: string; difficulty: 'normal' | 'hard'; thumbnail: boolean };

/** Check compressed framing and expansion size before invoking the pinned original codec. */
function boundedMap(encoded: string): void {
  if (encoded.length > LIMITS.encodedMapBytes || !encoded.startsWith('konkrmap.v7.')) throw new Error('Expected a supported map');
  const payload = encoded.slice(12);
  if (!payload || payload.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)) throw new Error('Invalid map framing');
  const bytes = atob(payload); let length = 0;
  for (let index = 0; index < bytes.length;) {
    const byte = bytes.charCodeAt(index++);
    if (byte >>> 6 === 3 && index < bytes.length && bytes.charCodeAt(index) >>> 7 === 0) {
      const count = byte & 31; let distance = bytes.charCodeAt(index++);
      if (byte >>> 5 !== 6) { if (index >= bytes.length) throw new Error('Invalid compression'); distance = distance << 8 | bytes.charCodeAt(index++); }
      if (!count || !distance || distance > length) throw new Error('Invalid compression');
      length += count;
    } else length++;
    if (length > LIMITS.decodedMapBytes) throw new Error('Map expands beyond the preview limit');
  }
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(String(key)) ?? null, setItem: (key, value) => { values.set(String(key), String(value)); },
    removeItem: key => { values.delete(String(key)); }, clear: () => values.clear() };
}

/** Runs between bootstrap.js and the original vendor/main scripts, only in the preview document. */
function install(): void {
  if (window.parent === window) throw new Error('Map previews require an enclosing page');
  for (const key of ['localStorage', 'sessionStorage']) Object.defineProperty(window, key, { value: memoryStorage(), configurable: false });
  Object.defineProperty(document, 'cookie', { get: () => '', set: () => {}, configurable: false });
  Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: false });
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith(new URL('assets/', document.baseURI).pathname)) return Promise.reject(new Error('Preview network request blocked'));
    return fetchOriginal(input, { ...options, credentials: 'omit' });
  };
  let loader: ReferenceModuleLoader;
  const prepare = window.__konkrCommunityPrepare;
  if (!prepare) throw new Error('Preview bootstrap script order is invalid');
  window.__konkrCommunityPrepare = (load, config) => {
    prepare(load, config); loader = load;
    load(93742).hasLocalStorage = () => false;
    config.autoSaveOnTurnStart = false; config.debug.overlay = false; config.screenTransitionDuration = 0;
  };
  let currentId = ''; let busy = false; let queued: Command | null = null; let hasMap = false; let paused = false;
  const send = (type: string, id = '', extra: Record<string, unknown> = {}, transfer: Transferable[] = []) => window.parent.postMessage({ protocol, type, id, ...extra }, location.origin, transfer);
  const ready = async () => {
    const deadline = performance.now() + 30_000;
    while (!window.communityReference?.ready) {
      if (performance.now() > deadline || window.communityReference?.errors.length) throw new Error('Preview engine could not start');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const { app } = loader!(55151); app.game.input.enabled = false; app.game.input.keyboard.enabled = false; app.game.sound.mute = true;
    if (paused) app.game.loop.sleep();
  };
  const fit = () => {
    if (!hasMap) return;
    const { app } = loader(55151); const world = app.scene.worldMap;
    app.game.scale.setGameSize(Math.max(1, window.innerWidth), Math.max(1, window.innerHeight));
    // The production host starts display:none while loading. FIT can retain a
    // zero CSS display size even with a valid framebuffer until explicitly refreshed.
    app.game.scale.refresh();
    world.cameraController.setViewportMargins({}); world.cameraController.updateBounds();
    const bounds = world.cameraController.worldBounds, camera = world.cameras.main;
    const inverseZoom = Math.max(bounds.width / camera.width, bounds.height / camera.height) * 1.08;
    const distance = (0.0952381 + Math.sqrt(Math.max(0, 0.0952381 ** 2 - 4 * 0.0654762 * (0.357143 - inverseZoom)))) / (2 * 0.0654762);
    world.cameraController.zoomController.zoomTo(distance, 'instant'); void world.cameraController.center(0);
  };
  const render = async (command: Command) => {
    currentId = command.id; await ready(); boundedMap(command.encoded);
    const codec = loader(47067);
    if (!codec.isEncodedGameState(command.encoded)) throw new Error('Expected a map');
    const state = codec.decodeGameState(command.encoded);
    const { app } = loader(55151), { inject } = loader(32070);
    app.game.loop.wake();
    // Preview context never starts a faction turn or a play session in either difficulty.
    inject.gameStateController.loadState(state, loader(25972).NewGameStateContext.Preview);
    const world = app.scene.worldMap; world.setMode(new (loader(28208).PreviewMode)());
    for (const scene of app.game.scene.getScenes(true)) scene.scene.setVisible(scene === world);
    world.syncState(); hasMap = true; fit();
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (currentId !== command.id) return;
    if (command.thumbnail) {
      // WebGL's buffer can be cleared outside this callback. Capture the original canvas immediately after rendering.
      const bitmap = await new Promise<ImageBitmap>((resolve, reject) => app.game.events.once('postrender', () => { createImageBitmap(app.game.canvas).then(resolve, reject); }));
      send('rendered', command.id, { bitmap }, [bitmap]);
    } else send('rendered', command.id);
  };
  const drain = async () => {
    if (busy) return; busy = true;
    while (queued) {
      const command = queued; queued = null;
      try { await render(command); } catch { send('error', command.id, { message: 'This map preview could not be rendered.' }); }
      finally { if (window.communityReference?.ready && (command.thumbnail || paused)) loader(55151).app.game.loop.sleep(); }
    }
    busy = false;
  };
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.protocol !== protocol) return;
    if (data.type === 'pause' || data.type === 'resume') {
      paused = data.type === 'pause';
      if (window.communityReference?.ready) { const loop = loader(55151).app.game.loop; if (paused && !busy) loop.sleep(); else if (!paused) loop.wake(); }
      return;
    }
    if (data.type !== 'render' || typeof data.id !== 'string' || !/^[a-z0-9-]{1,100}$/i.test(data.id) || typeof data.encoded !== 'string' || data.encoded.length > LIMITS.encodedMapBytes || !['normal', 'hard'].includes(data.difficulty) || typeof data.thumbnail !== 'boolean') return;
    currentId = data.id; queued = data; void drain();
  });
  window.addEventListener('resize', fit);
  void ready().then(() => send('ready'), () => send('error', '', { message: 'The map preview engine could not start.' }));
}
install();
