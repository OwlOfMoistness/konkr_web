import { LIMITS } from '../shared/contracts.ts';
import type { Difficulty } from '../shared/contracts.ts';

const protocol = 'konkr-preview-v1';
export interface LivePreviewOptions {
  /** Immutable revision/hash identity; include difficulty when it changes presentation. */
  key: string;
  loadMap: (signal?: AbortSignal) => Promise<string>;
  difficulty?: Difficulty;
  thumbnail?: boolean;
  title?: string;
}
export interface LivePreviewHandle { ready: Promise<void>; destroy(): void }
export interface LivePreviewPoolOptions { frameUrl?: string; layer?: number; cacheSize?: number; idleThumbnailMs?: number }
type Pending = { resolve(bitmap?: ImageBitmap): void; reject(error: Error): void; cleanup(): void };
const aborted = () => new DOMException('Preview no longer needed', 'AbortError');

class PreviewFrame {
  readonly frame: HTMLIFrameElement;
  readonly ready: Promise<void>;
  private window: Window;
  private pending = new Map<string, Pending>();
  private count = 0;
  private closed = false;
  private active = true;
  private receive: (event: MessageEvent) => void;
  private rejectBoot!: (error: Error) => void;
  private timer: ReturnType<typeof setTimeout>;
  constructor(document: Document, url: string, layer: number, kind: string) {
    this.window = document.defaultView!;
    const target = new URL(url, document.location.href);
    if (target.origin !== document.location.origin) throw new Error('Preview renderer must be on this site');
    const frame = this.frame = document.createElement('iframe');
    frame.src = target.href; frame.title = kind === 'live' ? 'Live map preview' : 'Map thumbnail renderer';
    frame.dataset.communityPreview = kind; frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1; frame.referrerPolicy = 'same-origin';
    frame.style.cssText = `position:fixed;left:-10000px;top:0;width:384px;height:256px;border:0;pointer-events:none;z-index:${layer};`;
    let resolveBoot!: () => void;
    this.ready = new Promise<void>((resolve, reject) => { resolveBoot = resolve; this.rejectBoot = reject; });
    void this.ready.catch(() => {});
    this.timer = setTimeout(() => this.rejectBoot(new Error('Map preview took too long to start')), 35_000);
    this.receive = event => {
      if (event.origin !== target.origin || event.source !== frame.contentWindow || !event.data || event.data.protocol !== protocol) return;
      const data = event.data;
      if (data.type === 'ready') { clearTimeout(this.timer); if (!this.active) frame.contentWindow!.postMessage({ protocol, type: 'pause' }, target.origin); resolveBoot(); return; }
      if (data.type === 'error' && data.id === '') { clearTimeout(this.timer); this.rejectBoot(new Error('Map preview engine could not start')); return; }
      const pending = this.pending.get(data.id);
      if (!pending) { if (data.bitmap instanceof ImageBitmap) data.bitmap.close(); return; }
      if (data.type !== 'error' && data.type !== 'rendered') return;
      pending.cleanup(); this.pending.delete(data.id);
      if (data.type === 'error') pending.reject(new Error('This map preview could not be rendered'));
      else if (data.bitmap !== undefined && (!(data.bitmap instanceof ImageBitmap) || data.bitmap.width > 2048 || data.bitmap.height > 2048)) { if (data.bitmap instanceof ImageBitmap) data.bitmap.close(); pending.reject(new Error('Invalid preview frame')); }
      else pending.resolve(data.bitmap);
    };
    this.window.addEventListener('message', this.receive); document.body.append(frame);
  }
  setActive(active: boolean): void {
    if (this.closed || this.active === active) return; this.active = active;
    this.frame.contentWindow?.postMessage({ protocol, type: active ? 'resume' : 'pause' }, this.window.location.origin);
  }
  async render(encoded: string, difficulty: Difficulty, thumbnail: boolean, signal: AbortSignal): Promise<ImageBitmap | undefined> {
    await this.ready;
    if (this.closed || signal.aborted) throw aborted();
    if (typeof encoded !== 'string' || encoded.length > LIMITS.encodedMapBytes) throw new Error('Map preview data is too large');
    const id = `preview-${++this.count}`;
    return new Promise((resolve, reject) => {
      const finish = () => { this.pending.delete(id); clearTimeout(timer); signal.removeEventListener('abort', cancel); };
      const cancel = () => { finish(); reject(aborted()); };
      const timer = setTimeout(() => { finish(); reject(new Error('Map preview took too long to render')); }, 35_000);
      this.pending.set(id, { resolve, reject, cleanup: finish }); signal.addEventListener('abort', cancel, { once: true });
      this.frame.contentWindow!.postMessage({ protocol, type: 'render', id, encoded, difficulty, thumbnail }, this.window.location.origin);
    });
  }
  destroy(): void {
    if (this.closed) return; this.closed = true; clearTimeout(this.timer); this.rejectBoot(aborted());
    for (const pending of [...this.pending.values()]) { pending.cleanup(); pending.reject(aborted()); }
    this.window.removeEventListener('message', this.receive); this.frame.remove();
  }
}

/** At most two engines: selected live canvas plus one serial, lazy thumbnail renderer. */
export function createLivePreviewPool(options: LivePreviewPoolOptions = {}, document: Document = window.document) {
  const win = document.defaultView!;
  const handles = new Set<LivePreviewHandle>();
  const cache = new Map<string, HTMLCanvasElement>();
  let live: PreviewFrame | undefined, thumbnails: PreviewFrame | undefined;
  let active: HTMLElement | undefined; let activeToken: object | undefined; let activeReady = false; let disposed = false; let animation = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const queue: Array<() => Promise<void>> = []; let processing = false;
  const engine = (thumbnail: boolean) => thumbnail ? thumbnails ??= new PreviewFrame(document, options.frameUrl ?? '/community-preview', options.layer ?? 21, 'thumbnail') : live ??= new PreviewFrame(document, options.frameUrl ?? '/community-preview', options.layer ?? 21, 'live');
  const position = () => {
    animation = 0;
    if (!active || !live || disposed) return;
    const frame = live.frame; const bounds = active.getBoundingClientRect();
    let left = Math.max(0, bounds.left), right = Math.min(win.innerWidth, bounds.right), top = Math.max(0, bounds.top), bottom = Math.min(win.innerHeight, bounds.bottom), opacity = 1;
    let visible = active.isConnected && bounds.width > 0 && bounds.height > 0;
    for (let node: HTMLElement | null = active; node; node = node.parentElement) {
      const style = win.getComputedStyle(node); opacity *= Number(style.opacity);
      if (style.display === 'none' || style.visibility === 'hidden') visible = false;
      if (node !== active && /(hidden|clip|auto|scroll)/.test(style.overflow + style.overflowX + style.overflowY)) {
        const clip = node.getBoundingClientRect(); left = Math.max(left, clip.left); right = Math.min(right, clip.right); top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom);
      }
    }
    frame.style.visibility = activeReady && visible && right > left && bottom > top ? 'visible' : 'hidden';
    live.setActive(visible && right > left && bottom > top);
    frame.style.left = `${bounds.left}px`; frame.style.top = `${bounds.top}px`; frame.style.width = `${Math.max(1, bounds.width)}px`; frame.style.height = `${Math.max(1, bounds.height)}px`; frame.style.opacity = String(opacity);
    frame.style.clipPath = `inset(${Math.max(0, top - bounds.top)}px ${Math.max(0, bounds.right - right)}px ${Math.max(0, bounds.bottom - bottom)}px ${Math.max(0, left - bounds.left)}px)`;
    animation = win.requestAnimationFrame(position);
  };
  const drain = async () => {
    if (processing || disposed) return; processing = true; clearTimeout(idle);
    while (queue.length && !disposed) await queue.shift()!();
    processing = false;
    idle = setTimeout(() => { thumbnails?.destroy(); thumbnails = undefined; }, options.idleThumbnailMs ?? 15_000);
  };
  const mount = (container: HTMLElement, settings: LivePreviewOptions): LivePreviewHandle => {
    if (disposed) throw new Error('Preview pool was destroyed');
    const controller = new AbortController(); const token = {}; let destroyed = false; let observer: IntersectionObserver | undefined;
    const title = settings.title ?? 'Map preview';
    const status = document.createElement('span'); status.textContent = 'Loading map preview…'; status.setAttribute('role', 'status');
    container.replaceChildren(status); container.setAttribute('aria-label', title);
    const canvas = document.createElement('canvas'); canvas.width = 384; canvas.height = 256; canvas.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain'; canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', title);
    const key = `${settings.key}:${settings.difficulty ?? 'normal'}`;
    let resolveReady!: () => void, rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    void ready.catch(() => {});
    const run = async () => {
      if (destroyed || disposed) return;
      let renderer: PreviewFrame | undefined;
      try {
        const cached = settings.thumbnail ? cache.get(key) : undefined;
        if (cached) { canvas.getContext('2d')!.drawImage(cached, 0, 0); container.replaceChildren(canvas); resolveReady(); return; }
        const encoded = await new Promise<string>((resolve, reject) => {
          const cancel = () => { cleanup(); reject(aborted()); };
          const timer = setTimeout(() => { cleanup(); reject(new Error('Map preview download timed out')); }, 35_000);
          const cleanup = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', cancel); };
          controller.signal.addEventListener('abort', cancel, { once: true });
          Promise.resolve().then(() => settings.loadMap(controller.signal)).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
        });
        if (destroyed || disposed) return;
        renderer = engine(!!settings.thumbnail);
        if (!settings.thumbnail) { active = container; activeToken = token; activeReady = false; renderer.frame.style.visibility = 'hidden'; if (animation) win.cancelAnimationFrame(animation); position(); }
        const bitmap = await renderer.render(encoded, settings.difficulty ?? 'normal', !!settings.thumbnail, controller.signal);
        if (destroyed || disposed) { bitmap?.close(); return; }
        if (settings.thumbnail) {
          if (!bitmap) throw new Error('Thumbnail renderer returned no canvas');
          canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
          cache.delete(key); cache.set(key, canvas);
          while (cache.size > (options.cacheSize ?? 48)) cache.delete(cache.keys().next().value!);
          container.replaceChildren(canvas);
        } else if (activeToken === token) { activeReady = true; status.textContent = ''; container.dataset.livePreviewReady = 'true'; }
        resolveReady();
      } catch (error) {
        if (!destroyed) {
          // A failed ready promise cannot recover. Retire only this mount's renderer;
          // a late error from a superseded selection must not tear down the new live map.
          if (renderer && settings.thumbnail && thumbnails === renderer) { renderer.destroy(); thumbnails = undefined; }
          else if (renderer && live === renderer && activeToken === token) {
            renderer.destroy(); live = undefined; active = undefined; activeToken = undefined;
            if (animation) win.cancelAnimationFrame(animation); animation = 0;
          }
          status.textContent = 'Preview unavailable'; container.replaceChildren(status); rejectReady(error);
        }
      }
    };
    const handle: LivePreviewHandle = { ready, destroy() {
      if (destroyed) return; destroyed = true; controller.abort(); observer?.disconnect(); handles.delete(handle); rejectReady(aborted());
      if (activeToken === token) { active = undefined; activeToken = undefined; if (animation) win.cancelAnimationFrame(animation); animation = 0; if (live) { live.frame.style.visibility = 'hidden'; live.setActive(false); } }
      container.replaceChildren(); container.removeAttribute('aria-label'); delete container.dataset.livePreviewReady;
    } };
    handles.add(handle);
    if (settings.thumbnail) {
      const enqueue = () => { observer?.disconnect(); queue.push(run); void drain(); };
      if ('IntersectionObserver' in win) { observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) enqueue(); }, { rootMargin: '120px' }); observer.observe(container); }
      else enqueue();
    } else void run();
    return handle;
  };
  return { mount, destroy() { if (disposed) return; disposed = true; for (const handle of [...handles]) handle.destroy(); clearTimeout(idle); queue.length = 0; live?.destroy(); thumbnails?.destroy(); cache.clear(); } };
}

const defaultPools = new WeakMap<Document, ReturnType<typeof createLivePreviewPool>>();
export function mountLivePreview(container: HTMLElement, options: LivePreviewOptions): LivePreviewHandle {
  const document = container.ownerDocument;
  let pool = defaultPools.get(document);
  if (!pool) { pool = createLivePreviewPool({}, document); defaultPools.set(document, pool); }
  return pool.mount(container, options);
}
