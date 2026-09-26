import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { communityRoot, generatedRoot, prepareRuntime } from '../scripts/prepare-runtime.ts';
import { parseMap } from '../engine/map-format.ts';
import type { CatalogEntry } from '../shared/contracts.ts';
import type { installCustomMaps } from '../web/custom-maps.ts';

declare global {
  interface Window {
    customMapsTest: Awaited<ReturnType<typeof installCustomMaps>>;
    testReady: boolean;
    failStart: boolean;
    startCalls: number;
    bridgeErrors: string[];
  }
}

test('catalog launch, isolated resume, restart and original mode navigation use one URL', { timeout: 180_000 }, async t => {
  const fixtureDirectory = process.env.KONKR_MAP_FIXTURES;
  if (!fixtureDirectory) { t.skip('Set KONKR_MAP_FIXTURES to the directory containing the two supplied maps.'); return; }
  await prepareRuntime();
  const manifest = JSON.parse(await readFile(path.join(communityRoot, 'runtime/manifest.json'), 'utf8'));
  const engineHash = manifest.files[manifest.main];
  const encodedMaps: Record<string, string> = {};
  const entries: CatalogEntry[] = [];
  for (const [id, filename] of [['prison', 'prison.konkr'], ['gifts', 'escalating-quickly.konkr']]) {
    const encoded = await readFile(path.join(fixtureDirectory, filename), 'utf8');
    const parsed = parseMap(encoded); encodedMaps[id] = encoded;
    entries.push({ map: { id, metadata: { title: parsed.title, description: parsed.description, creator: parsed.creator, tags: [] }, state: 'published', currentRevisionId: `${id}-r1`, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', publishedAt: '2026-01-01T00:00:00.000Z' }, revision: { id: `${id}-r1`, mapId: id, revision: 1, contentHash: parsed.contentHash, objectKey: id, engineHash, plugins: parsed.plugins, width: parsed.width, height: parsed.height, createdAt: '2026-01-01T00:00:00.000Z' }, previewUrl: null, rating: { average: null, count: 0 }, scores: [] });
  }
  const addon = await build({ stdin: { contents: `
    import { installCustomMaps, createCatalogSaveStore } from './web/custom-maps.ts';
    const entries = ${JSON.stringify(entries)};
    const maps = ${JSON.stringify(encodedMaps)};
    window.startCalls = 0; window.failStart = false; window.bridgeErrors = [];
    const root = document.createElement('main'); root.id = 'catalog'; document.body.append(root);
    window.customMapsTest = await installCustomMaps({root, engineHash:${JSON.stringify(engineHash)}, store:createCatalogSaveStore(localStorage),
      reader:{async list(){return {entries,total:entries.length}},async get(id){return entries.find(entry=>entry.map.id===id)??null}},
      loadMap:async entry=>maps[entry.map.id],
      onStart:async(entry,difficulty)=>{window.startCalls++;if(window.failStart)throw new Error('Run server unavailable');
        return {id:'run-'+crypto.randomUUID(),mapId:entry.map.id,revisionId:entry.revision.id,mapHash:entry.revision.contentHash,engineHash:entry.revision.engineHash,difficulty,plugins:entry.revision.plugins,adapterVersion:'fixture',issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString()};},
      onError:error=>window.bridgeErrors.push(error.message)});
    window.testReady = true;
  `, loader: 'ts', resolveDir: communityRoot }, bundle: true, write: false, format: 'esm', target: 'es2023', platform: 'browser' });
  const css = await readFile(path.join(communityRoot, 'web/catalog.css'));
  const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.xml': 'text/xml', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.css': 'text/css' };
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://local').pathname;
      if (pathname === '/community-addon.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(addon.outputFiles[0].contents); return; }
      if (pathname === '/catalog.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); return; }
      const file = path.resolve(generatedRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(generatedRoot + path.sep)) throw new Error('Bad path');
      response.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
      const data = await readFile(file);
      response.end(pathname === '/' ? data.toString().replace('</head>', '<link rel="stylesheet" href="catalog.css"><script type="module" src="community-addon.js"></script></head>') : data);
    } catch { response.writeHead(404).end('Not found'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  const external: string[] = [];
  await context.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
  const page = await context.newPage();
  const failures: string[] = []; page.on('pageerror', error => failures.push(error.message));
  await page.goto(`${origin}/?community=1#keep-this-url`);
  await page.waitForFunction(() => window.testReady, undefined, { timeout: 30_000 });
  if (process.env.KONKR_LAUNCH_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.KONKR_LAUNCH_SCREENSHOTS, 'menu-desktop.png') });
  const initialURL = page.url();
  const screen = async (name: string) => page.waitForFunction(value => window.communityReference.inspect().screen === value && !window.customMapsTest.bridge.isBusy() && (value !== 'Play' || document.getElementById('catalog')!.hidden) && window.communityReference.withEngine(loader => !loader(55151).app.navigator.transitionInProgress), name);
  const open = async () => { await page.getByRole('button', { name: 'Custom Maps', exact: true }).click(); await page.getByRole('heading', { name: 'Custom Maps', exact: true }).waitFor(); };
  const details = async (title: string) => { await page.getByRole('button', { name: title, exact: true }).click(); await page.getByRole('heading', { name: title, exact: true }).waitFor(); };
  await open(); await details(entries[0].map.metadata.title);
  await page.getByLabel('Play difficulty').selectOption('hard');
  await page.evaluate(() => { window.failStart = true; });
  await page.getByRole('button', { name: 'Play map', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'could not be started' }).waitFor();
  assert.equal(await page.evaluate(() => window.customMapsTest.bridge.current()), null);
  assert.equal(await page.evaluate(() => window.communityReference.inspect().screen), 'Title');
  await page.evaluate(() => { window.failStart = false; });
  await page.getByRole('button', { name: 'Play map', exact: true }).click(); await screen('Play');
  let state = await page.evaluate(() => window.communityReference.inspect());
  assert.equal(state.difficulty, 'hard'); assert.equal(state.state.map.width, 24); assert.match(state.state.map.levelId, /^cl-community-[0-9a-f]{32}$/);
  const binding = await page.evaluate(() => window.customMapsTest.bridge.current()!.binding.id);
  await page.evaluate(() => { window.communityReference.act('SetSpectatingPlayBackSpeed', 3); window.communityReference.act('EndTurn', { force: true }); });
  await page.waitForFunction(() => { const { state } = window.communityReference.inspect(); return state.currentPhase.turnNumber === 2 && state.currentPhase.faction === 1; }, undefined, { timeout: 30_000 });
  await page.evaluate(() => window.communityReference.act('ExitLevel'));
  await page.getByRole('heading', { name: 'Custom Maps', exact: true }).waitFor();
  await details(entries[0].map.metadata.title);
  await page.getByRole('button', { name: 'Resume Hard game', exact: true }).click(); await screen('Play');
  state = await page.evaluate(() => window.communityReference.inspect());
  assert.equal(state.state.currentPhase.turnNumber, 2);
  assert.equal(await page.evaluate(() => window.customMapsTest.bridge.current()!.binding.id), binding);
  assert.equal(await page.evaluate(() => window.startCalls), 2, 'Resume keeps its original issuance');
  await page.evaluate(() => window.communityReference.act('RestartLevel', { skipConfirmation: true }));
  await page.waitForFunction(previous => window.customMapsTest.bridge.current()!.binding.id !== previous && window.communityReference.inspect().state.currentPhase.turnNumber === 1, binding);
  await screen('Play');
  assert.equal(page.url(), initialURL);
  // These injected outcomes test original result-screen routing only, not victory validity.
  await page.evaluate(() => window.communityReference.withEngine(loader => loader(56876).events.trigger(loader(43566).SystemEvents.ShowGameOverScreen('Defeat')))); await screen('Defeat');
  await page.evaluate(() => window.communityReference.act('RestartLevel')); await screen('Play');
  await page.evaluate(() => window.communityReference.withEngine(loader => loader(56876).events.trigger(loader(43566).SystemEvents.ShowGameOverScreen('Victory')))); await screen('Victory');
  await page.evaluate(() => window.communityReference.act('Escape'));
  await page.getByRole('heading', { name: 'Custom Maps', exact: true }).waitFor();
  assert.equal(page.url(), initialURL);
  // Reload must find the separate revision save, without using the native title Continue path.
  await page.reload(); await page.waitForFunction(() => window.testReady, undefined, { timeout: 30_000 });
  await open(); await details(entries[0].map.metadata.title);
  assert.equal(await page.getByRole('button', { name: 'Resume Hard game', exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Resume Hard game', exact: true }).click(); await screen('Play');
  assert.equal(await page.evaluate(() => window.startCalls), 0, 'Reload/resume must retain its old binding');
  await page.evaluate(() => window.communityReference.act('ExitLevel'));
  await page.getByRole('heading', { name: 'Custom Maps', exact: true }).waitFor();
  await page.getByRole('button', { name: '← Main menu', exact: true }).click();
  for (const [event, expected] of [['GoToExpeditions', 'Overworld'], ['GoToRandomMapSelect', 'RandomMapSelect']]) {
    await page.evaluate(name => window.communityReference.act(name), event); await screen(expected);
    assert.equal(page.url(), initialURL);
    await page.evaluate(() => window.communityReference.act('Escape')); await screen('Title');
  }
  // Both supplied maps, both difficulties, and the fifth button remain usable on a compact screen.
  await page.setViewportSize({ width: 375, height: 812 });
  if (process.env.KONKR_LAUNCH_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.KONKR_LAUNCH_SCREENSHOTS, 'menu-mobile.png') });
  for (const entry of entries) for (const difficulty of ['normal', 'hard'] as const) {
    const button = page.getByRole('button', { name: 'Custom Maps', exact: true }); await button.waitFor();
    const bounds = await button.boundingBox(); assert(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 812);
    await open(); await details(entry.map.metadata.title); await page.getByLabel('Play difficulty').selectOption(difficulty);
    await page.getByRole('button', { name: 'Play map', exact: true }).click(); await screen('Play');
    const current = await page.evaluate(() => window.communityReference.inspect());
    assert.equal(current.difficulty, difficulty); assert.equal(current.state.map.width, entry.revision.width);
    assert.equal(current.effectivePluginCount, entry.revision.plugins.length + (difficulty === 'normal' ? 1 : 0));
    await page.evaluate(() => window.communityReference.act('TogglePlayMenu'));
    await page.evaluate(() => window.communityReference.act('GoBack'));
    await page.getByRole('heading', { name: 'Custom Maps', exact: true }).waitFor();
    await page.getByRole('button', { name: '← Main menu', exact: true }).click(); await screen('Title');
    assert.equal(page.url(), initialURL);
  }
  assert.deepEqual(external, []); assert.deepEqual(failures, []);
  assert.deepEqual(await page.evaluate(() => window.communityReference.errors), []);
  assert.deepEqual(await page.evaluate(() => window.communityReference.blockedRequests), []);
});
