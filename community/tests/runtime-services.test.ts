import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { transform } from 'esbuild';
import { chromium } from 'playwright';
import { guardMainBundle, loadEngineSources } from '../engine/platform.ts';

/** Exercise the compatibility bootstrap without network access or live browser data. */
async function harness() {
  const listeners = new Map<string, (event: any) => void>();
  const events: any[] = [], notices: any[] = [], toasts: any[] = [];
  const elements = new Map<string, any>();
  for (const id of ['status', 'loader', 'phaser-game']) {
    const classes = new Set<string>();
    elements.set(id, { textContent: '', classList: {
      toggle(name: string, force: boolean) { if (force) classes.add(name); else classes.delete(name); },
      contains(name: string) { return classes.has(name); },
    } });
  }
  let reloads = 0, endedSessions = 0, feedbackForms = 0;
  const handlers = new Map<string, Array<(payload: any) => void>>();
  const bus = {
    on(factory: any, callback: (payload: any) => void) {
      const key = factory.eventName; handlers.set(key, [...(handlers.get(key) ?? []), callback]);
    },
    trigger(event: any) {
      events.push(event); for (const handler of handlers.get(event.name) ?? []) handler(event.payload);
    },
  };
  const fatal = Object.assign((payload: any) => ({ name: 'SYSTEM.FATAL_ERROR', payload }), { eventName: 'SYSTEM.FATAL_ERROR' });
  const modules: Record<number, any> = {
    65606: { Firebase: {} }, 92703: {}, 65358: { LoginService: class {} },
    71205: { CloudSyncService: class {} }, 9443: {}, 72758: {}, 18658: { track: {} },
    56876: { events: bus }, 43566: { SystemEvents: { FatalError: fatal } },
    38996: { createLevelStatsButton(ui: any) { return ui.outlineButton({ icon: 'ui/button-icons/chart', onClicked() { throw new Error('Disabled remote statistics opened'); } }); } },
    81490: { showFeedbackForm() { feedbackForms++; }, askForLevelFeedback() { feedbackForms++; } },
    54209: {},
    48823: { NotificationStyle: { Alert: 'alert' }, NotificationCategory: { Error: 'error' }, NotificationScope: { Global: 'global' } },
    91034: { CallToActionForm: class { applyProps(props: any) { return { props }; } } },
    32070: { inject: { ui: { session: { end() { endedSessions++; } } } } },
    80149: { HtmlDocs: { about: { url: '/about' }, howToPlay: { url: '/how-to-play' } } },
    71040: { createUrl: (hash: string) => `https://127.0.0.1:8080/#${hash}` },
  };
  const notifications = {
    ui: { image: (name: string) => ({ name }) },
    warning: (...args: any[]) => notices.push(args),
    add: (toast: any) => toasts.push(toast),
    uncaughtError: (id: string) => modules[54209].showErrorNotification({}, id),
  };
  modules[55151] = { app: { notifications, scene: { globalUI: {} } } };
  const location = { href: 'http://127.0.0.1:8080/', origin: 'http://127.0.0.1:8080', pathname: '/', reload() { reloads++; } };
  const window: any = { location, addEventListener(name: string, callback: any) { listeners.set(name, callback); } };
  const context = createContext({ window, performance: { now: () => 0 }, Error, URL,
    document: { getElementById: (id: string) => elements.get(id), addEventListener() {} } });
  const source = await readFile(new URL('../runtime/bootstrap.ts', import.meta.url), 'utf8');
  runInContext((await transform(source, { loader: 'ts', format: 'iife' })).code, context);
  window.__konkrCommunityPrepare((id: number) => {
    if (!modules[id]) throw new Error(`Unmocked module ${id}`);
    return modules[id];
  }, { flags: {}, serviceWorker: {} });
  return { modules, window, elements, events, notices, toasts, listeners,
    counts: () => ({ reloads, endedSessions, feedbackForms }) };
}

test('disabled official statistics and feedback explain unavailability without opening or submitting', async () => {
  const h = await harness();
  const button = h.modules[38996].createLevelStatsButton({ outlineButton: (options: any) => options });
  button.onClicked();
  h.modules[81490].showFeedbackForm();
  assert.equal(h.counts().feedbackForms, 0);
  assert.equal(h.notices.length, 2);
  assert.match(h.notices[0][0], /statistics.*unavailable/i);
  assert.match(h.notices[1][0], /feedback.*unavailable/i);
  assert.equal(h.events.length, 0, 'No feedback submission event is emitted');
});

test('fatal gameplay errors retain a local reload action without claiming a report was sent', async () => {
  const h = await harness();
  new h.modules[72758].Reporter();
  const handler = new h.modules[92703].SentryErrorHandler();
  handler.gameRunning = true;
  handler.handleException(new Error('Synthetic renderer error'));
  assert.equal(h.events[0]?.name, 'SYSTEM.FATAL_ERROR');
  assert.equal(h.toasts.length, 1);
  const props = h.toasts[0].content.props;
  assert.equal(props.action, 'RELOAD');
  assert.match(props.content, /reload/i);
  assert.doesNotMatch(props.content, /already sent|won.t lose any progress/i);
  await props.onSubmit();
  assert.equal(h.counts().reloads, 1);
  assert.equal(h.counts().endedSessions, 1);
});

test('boot failures stop the loading state and show a useful local error', async () => {
  const h = await harness();
  const handler = new h.modules[92703].SentryErrorHandler();
  handler.handleException(new Error('Missing texture'));
  assert.match(h.elements.get('status').textContent, /could not start.*reload/i);
  assert.equal(h.elements.get('status').classList.contains('hidden'), false);
  assert.equal(h.elements.get('loader').classList.contains('hidden'), true);
  assert.equal(h.elements.get('phaser-game').classList.contains('hidden'), true);
});

test('uncaught errors use the same visible local handler and nonfatal diagnostics stay quiet', async () => {
  const h = await harness();
  new h.modules[72758].Reporter();
  const handler = new h.modules[92703].SentryErrorHandler();
  handler.gameRunning = true;
  handler.handleNonFatalError(new Error('Optional diagnostic'), 'test');
  assert.equal(h.toasts.length, 0);
  h.listeners.get('unhandledrejection')!({ reason: new Error('Rejected gameplay operation') });
  assert.equal(h.toasts.length, 1);
});

test('original information links and copied island URLs resolve without changing player navigation', async () => {
  const h = await harness();
  assert.equal(h.modules[80149].HtmlDocs.about.url, 'https://www.konkr.io/about');
  assert.equal(h.modules[80149].HtmlDocs.howToPlay.url, 'https://www.konkr.io/how-to-play');
  assert.equal(h.modules[71040].createUrl('campaign/l-sherwood'), 'http://127.0.0.1:8080/#campaign/l-sherwood');
  assert.equal(h.window.location.href, 'http://127.0.0.1:8080/');
});

test('cancelling a native drag hides the original import overlay in both local layouts', { timeout: 30_000 }, async (t) => {
  const source = await loadEngineSources();
  const context = createContext({ self: {} });
  runInContext(source.vendor, context);
  runInContext(guardMainBundle(source.main, source.mainHash), context);
  // Use the exact pinned original drag handlers, not a copied implementation.
  const factory = context.__konkrRequire.m[19537].toString();
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (const relative of ['../web/index.html', '../scripts/prepare-runtime.ts']) {
    await t.test(relative, async () => {
      const template = await readFile(new URL(relative, import.meta.url), 'utf8');
      const styles = template.match(/<style>([\s\S]*?)<\/style>/)?.[1];
      assert.ok(styles);
      const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
      try {
        page.setDefaultTimeout(5_000);
        await page.setContent('<div id="source" draggable="true" style="position:absolute;left:10px;top:10px;width:90px;height:70px">Drag</div><iframe style="position:absolute;left:150px;top:10px;width:650px;height:500px;border:0"></iframe>');
        await page.locator('#source').evaluate(element => element.addEventListener('dragstart', event => (event as DragEvent).dataTransfer!.setData('text/plain', 'local regression test')));
        const frame = page.frames()[1];
        await frame.setContent(`<style>${styles}</style><div id="phaser-game"></div><div id="file-drop-zone" class="hidden"><div>Import map</div></div>`);
        await frame.evaluate(source => {
          const exports: any = {};
          // The only evaluated code is the checksum-verified original handler.
          eval('(' + source + ')')({}, exports, (id: number) => id === 62301 ? { assert: { defined() {} } } : {});
          exports.setupFileDropZone('phaser-game');
        }, factory);
        await page.mouse.move(50, 40); await page.mouse.down();
        await page.mouse.move(50, 80, { steps: 3 });
        await page.mouse.move(450, 250, { steps: 15 });
        await frame.locator('#file-drop-zone').waitFor({ state: 'visible' });
        await page.mouse.move(50, 350, { steps: 15 }); await page.mouse.up();
        await frame.locator('#file-drop-zone').waitFor({ state: 'hidden' });
      } finally { await page.close(); }
    });
  }
});
