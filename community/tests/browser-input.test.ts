import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import type { BrowserContext } from 'playwright';
import { createCommunityServer } from '../api/server.ts';
import { developmentIdentityProvider } from '../api/admin-auth.ts';
import { LocalObjectStorage } from '../api/storage.ts';

test('public game page releases its loading overlay and delivers board clicks to the original engine', { timeout: 120_000 }, async (t) => {
  // Static files and config must work without a database. This exercises the public
  // page composition, rather than the separate reference-harness HTML.
  const db = new Pool({ connectionString: 'postgresql://unused@127.0.0.1:1/unused' });
  const directory = await mkdtemp(path.join(tmpdir(), 'konkr-browser-input-'));
  let app: Awaited<ReturnType<typeof createCommunityServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const address = reservation.address();
    assert(address && typeof address !== 'string');
    const port = address.port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`;
    app = await createCommunityServer({
      db, storage: new LocalObjectStorage(directory), origin,
      csrfSecret: 'browser-input-csrf-'.repeat(4),
      identityProvider: developmentIdentityProvider([{ id: 'local-curator', key: 'browser-input-curator-'.repeat(4) }]),
      flags: { customMaps: true, submissions: false, verifiedResults: false },
    });
    await new Promise<void>(resolve => app!.server.listen(port, '127.0.0.1', resolve));
    browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
    const content = JSON.parse(await readFile(new URL('../../_site/releases/2.35.30/assets/content.json', import.meta.url), 'utf8'));
    const oasis: string = content.levels['l-oasis'].data;
    assert.match(oasis, /^konkrmap\.v7\./);
    const routeContext = async (context: BrowserContext, external: string[]) => context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { external.push(route.request().url()); return route.abort(); }
      // Catalogue API correctness has separate integration coverage. Its eager
      // menu fetch gets an empty fixture; HTML/config/scripts remain real HTTP.
      if (url.pathname === '/api/maps' && route.request().method() === 'GET') return route.fulfill({ json: { entries: [], total: 0 } });
      return route.continue();
    });

    for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 812 }]) {
      await t.test(`Oasis input at ${viewport.width} × ${viewport.height}`, async () => {
        const context = await browser!.newContext({ viewport, serviceWorkers: 'block' });
        try {
          const external: string[] = [];
          await routeContext(context, external);
          const page = await context.newPage();
          const errors: string[] = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.goto(origin);
          await page.waitForFunction(() => window.communityReference?.ready, undefined, { timeout: 40_000 });
          await page.getByRole('button', { name: 'Custom Maps', exact: true }).waitFor();
          const publicURL = page.url();
          const state = await page.evaluate(encoded => window.communityReference.importMap(encoded, 'hard'), oasis);
          assert.equal(state.screen, 'Play');
          assert.equal(state.state.map.levelId, 'l-oasis');
          await page.waitForFunction(() => window.communityReference.withEngine(load => !load(55151).app.navigator.transitionInProgress));
          assert.equal(await page.locator('#status').isVisible(), false, 'Empty loading status must not cover the board');
          const canvas = page.locator('#phaser-game canvas');
          const bounds = await canvas.boundingBox();
          assert.ok(bounds, 'Original game canvas is visible');
          const points = [0.25, 0.5, 0.7].map(fraction => ({
            x: bounds.x + bounds.width / 2,
            y: bounds.y + bounds.height * fraction,
          }));
          for (const point of points) {
            assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, point), 'CANVAS', `Board hit at ${point.x},${point.y} must reach the canvas`);
          }
          // Observe the original Phaser input pipeline, then click using the real
          // mouse. Calling reference.play() would bypass the overlay regression.
          await page.evaluate(() => {
            const result = { canvasDowns: 0, engineDowns: 0 };
            (window as any).__inputRegression = result;
            document.querySelector('#phaser-game canvas')!.addEventListener('pointerdown', () => result.canvasDowns++);
            window.communityReference.withEngine(load => {
              for (const scene of load(55151).app.game.scene.getScenes(true)) {
                scene.input.on('pointerdown', () => result.engineDowns++);
              }
            });
          });
          const center = points[1]!;
          await page.mouse.click(center.x, center.y);
          await page.waitForFunction(() => (window as any).__inputRegression.engineDowns > 0);
          const observed = await page.evaluate(() => (window as any).__inputRegression);
          assert.equal(observed.canvasDowns, 1);
          assert.ok(observed.engineDowns > 0, 'The original Phaser scene must receive the center click');
          assert.equal(page.url(), publicURL);
          assert.deepEqual(errors, []);
          assert.deepEqual(external, []);
          assert.deepEqual(await page.evaluate(() => window.communityReference.errors), []);
          assert.deepEqual(await page.evaluate(() => window.communityReference.blockedRequests), []);
        } finally { await context.close(); }
      });
    }

    await t.test('loading and error messages remain visible until status is cleared', async () => {
      const context = await browser!.newContext({ viewport: { width: 900, height: 700 }, serviceWorkers: 'block' });
      try {
        const external: string[] = [];
        await routeContext(context, external);
        // This context is disposable; status transitions must not affect either
        // playable browser context above or the user's actual game tab.
        const page = await context.newPage();
        await page.goto(origin);
        await page.waitForFunction(() => window.communityReference?.ready, undefined, { timeout: 40_000 });
        for (const [message, loading] of [['Loading map…', true], ['The map could not be loaded.', false]] as const) {
          await page.evaluate(({ message, loading }) => window.setLoadingStatus(message, loading), { message, loading });
          assert.equal(await page.locator('#status').isVisible(), true);
          assert.equal(await page.locator('#status').textContent(), message);
          assert.equal(await page.locator('#phaser-game').isVisible(), false);
          assert.equal(await page.locator('#loader').evaluate(element => element.classList.contains('hidden')), !loading);
        }
        await page.evaluate(() => window.setLoadingStatus('', false));
        assert.equal(await page.locator('#status').isVisible(), false);
        await page.locator('#phaser-game canvas').waitFor({ state: 'visible' });
        assert.equal(await page.evaluate(() => document.elementsFromPoint(innerWidth / 2, innerHeight / 2).some(element => element.id === 'status')), false);
        assert.deepEqual(external, []);
      } finally { await context.close(); }
    });

    await t.test('disabled online actions and fatal errors render local original-engine notifications', async () => {
      const context = await browser!.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
      try {
        const external: string[] = [];
        await routeContext(context, external);
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(origin);
        await page.waitForFunction(() => window.communityReference?.ready, undefined, { timeout: 40_000 });
        await page.getByRole('button', { name: 'Custom Maps', exact: true }).waitFor();
        // Read visible original Phaser toast content, including BitmapText. This
        // exercises real NotificationStyle/Scope and CallToActionForm classes.
        const waitForToast = (expected: string) => page.waitForFunction(expected => window.communityReference.withEngine(load => {
          const collect = (object: any): string[] => [typeof object.text === 'string' ? object.text : '',
            ...(Array.isArray(object.list) ? object.list.flatMap(collect) : [])];
          return load(55151).app.scene.globalUI.notifications.displayedToasts.some((toast: any) =>
            toast.visible && toast.alpha > 0 && collect(toast).join('\n').includes(expected));
        }), expected, { timeout: 5_000 });
        await page.evaluate(() => window.communityReference.withEngine(load => load(55151).app.notifications.toggleFeedback()));
        await waitForToast('Feedback unavailable');

        // Activate the actual original statistics button's click signal. This
        // checks the service adaptation, separately from the mouse tests above.
        await page.evaluate(() => window.communityReference.withEngine(load => {
          const { app } = load(55151);
          const button = load(38996).createLevelStatsButton(load(48041).UiBuilder.for(app.scene.globalUI));
          app.scene.globalUI.add.existing(button);
          button.onClicked.fire();
          button.destroy();
        }));
        await waitForToast('Statistics unavailable');
        assert.equal(context.pages().length, 1, 'Statistics must not open a broken remote page');
        assert.deepEqual(errors, []);
        assert.deepEqual(await page.evaluate(() => window.communityReference.errors), []);

        await page.evaluate(() => window.communityReference.withEngine(load => {
          const handler = new (load(92703).SentryErrorHandler)();
          handler.gameRunning = true;
          handler.handleException(new Error('Synthetic local browser regression error'));
        }));
        await waitForToast('The game encountered an error');
        await waitForToast('RELOAD');
        await waitForToast('This local preview does not send error reports.');
        assert.deepEqual(await page.evaluate(() => window.communityReference.errors), ['Synthetic local browser regression error']);
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        assert.deepEqual(await page.evaluate(() => window.communityReference.blockedRequests), []);
      } finally { await context.close(); }
    });
  } finally {
    await browser?.close();
    await app?.close();
    await db.end();
    await rm(directory, { recursive: true, force: true });
  }
});
