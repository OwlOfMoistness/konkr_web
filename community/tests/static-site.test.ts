import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { buildStatic, staticRoot } from '../scripts/build-static.ts';
import { createStaticServer } from '../scripts/serve-static.ts';
import type { StaticCatalog } from '../shared/static-catalog.ts';

test('the static release browses, previews and plays every map without APIs or statistics', { timeout: 240_000 }, async t => {
  await buildStatic();
  const files = await readdir(staticRoot);
  const catalog: StaticCatalog = JSON.parse(await readFile(path.join(staticRoot, files.find(file => /^maps-.*\.json$/.test(file))!), 'utf8'));
  const server = createStaticServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  for (const route of ['/admin/maps', '/api/config', '/api/maps', '/.env', '/api/server.ts']) {
    assert.equal((await fetch(origin + route)).status, 404);
  }
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const forbidden: string[] = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname.startsWith('/api/') || route.request().method() !== 'GET') { forbidden.push(url.href); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  const failures: string[] = []; page.on('pageerror', error => failures.push(error.message));
  const badResponses: string[] = []; page.on('response', response => { if (response.status() >= 400) badResponses.push(response.url()); });
  await page.goto(origin + '/');
  await page.getByRole('button', { name: 'Custom Maps', exact: true }).click();
  await page.getByRole('heading', { name: 'Custom Maps', exact: true }).waitFor();
  const settled = (screen: string) => page.waitForFunction(name => window.communityReference.withEngine(load => {
    const { app } = load(55151); return app.navigator.currentScreen.name === name && !app.navigator.transitionInProgress;
  }) && !document.querySelector('#catalog-root')?.hasAttribute('inert'), screen);
  await settled('CustomMaps');
  await page.locator('.catalog-card .catalog-preview canvas').first().waitFor();
  assert.deepEqual(await page.getByLabel('Sort by', { exact: true }).locator('option').allTextContents(), ['Newest', 'Name A–Z']);
  assert.equal(await page.locator('.catalog-rating, .community-rating, .catalog-completion [role="img"]').count(), 0);
  await page.getByLabel('Map name', { exact: true }).fill('Twin Continents');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.catalog-card').length === 1);
  await page.getByRole('button', { name: 'Twin Continents', exact: true }).click();
  await page.locator('.catalog-preview-large[data-live-preview-ready="true"]').waitFor();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.waitForFunction(count => document.querySelectorAll('.catalog-card').length === count, Math.min(catalog.entries.length, 24));
  await page.getByRole('button', { name: 'List', exact: true }).click();
  // Native import in each difficulty exercises the curated-only schema additions as well.
  for (const entry of catalog.entries) {
    await page.getByLabel('Map name', { exact: true }).fill(entry.map.metadata.title);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    for (const difficulty of ['Normal', 'Hard']) {
      await page.locator(`button[data-map-id="${entry.map.id}"]`).click();
      await page.getByRole('heading', { name: entry.map.metadata.title, exact: true }).waitFor();
      await page.locator('.catalog-preview-large[data-live-preview-ready="true"]').waitFor();
      await page.getByRole('radio', { name: difficulty, exact: true }).click();
      await page.getByRole('button', { name: 'Play map', exact: true }).click();
      await settled('Play');
      const state = await page.evaluate(() => window.communityReference.inspect());
      assert.equal(state.difficulty, difficulty.toLowerCase(), entry.map.metadata.title);
      assert.deepEqual([state.state.map.width, state.state.map.height], [entry.revision.width, entry.revision.height]);
      await page.evaluate(() => window.communityReference.act('ExitLevel'));
      await settled('CustomMaps');
      assert.equal(page.url(), origin + '/');
    }
  }
  // An outcome event is a UI-only fixture: dormant completion tracking must stay dormant.
  await page.getByRole('button', { name: 'Play map', exact: true }).click(); await settled('Play');
  await page.evaluate(() => window.communityReference.withEngine(load => load(56876).events.trigger(load(43566).SystemEvents.ShowGameOverScreen('Victory'))));
  await settled('Victory');
  await page.evaluate(() => window.communityReference.act('Escape')); await settled('CustomMaps');
  assert.equal(await page.locator('.community-rating, .catalog-completion [role="img"]').count(), 0);
  assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('konkr.community.completed.') || key.startsWith('konkr.community.pending.') || key.startsWith('konkr.community.issued.'))), false);
  await page.reload();
  await page.getByRole('button', { name: 'Custom Maps', exact: true }).click(); await settled('CustomMaps');
  assert.equal(await page.locator('.catalog-rating, .community-rating, .catalog-completion [role="img"]').count(), 0);
  await page.getByRole('button', { name: 'Resume Hard game', exact: true }).click(); await settled('Play');
  assert.equal((await page.evaluate(() => window.communityReference.inspect())).difficulty, 'hard');
  await page.evaluate(() => window.communityReference.act('ExitLevel')); await settled('CustomMaps');
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.getByRole('button', { name: 'Grid', exact: true }).click();
  await page.locator('.catalog-card .catalog-preview canvas').first().waitFor();
  await page.locator('.catalog-preview-large[data-live-preview-ready="true"]').waitFor();
  if (process.env.KONKR_STATIC_SCREENSHOT) await page.screenshot({ path: process.env.KONKR_STATIC_SCREENSHOT });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: 'Play map', exact: true }).click(); await settled('Play');
  await page.evaluate(() => window.communityReference.act('ExitLevel')); await settled('CustomMaps');
  await page.getByRole('button', { name: 'Back', exact: true }).click(); await settled('Title');
  for (const [action, screen] of [['GoToExpeditions', 'Overworld'], ['GoToRandomMapSelect', 'RandomMapSelect']]) {
    await page.evaluate(name => window.communityReference.act(name), action); await settled(screen);
    await page.evaluate(() => window.communityReference.act('Escape')); await settled('Title');
  }
  assert.deepEqual(failures, []); assert.deepEqual(badResponses, []); assert.deepEqual(forbidden, []);
  assert.deepEqual(await page.evaluate(() => window.communityReference.errors), []);
});
