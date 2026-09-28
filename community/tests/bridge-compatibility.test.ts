import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { parseMap } from '../engine/map-format.ts';
import { communityRoot, generatedRoot, prepareRuntime } from '../scripts/prepare-runtime.ts';
import type { CatalogEntry } from '../shared/contracts.ts';
import type { createCatalogBridge } from '../runtime/catalog-bridge.ts';
import type { LocalRunStore } from '../web/local-runs.ts';
import type { attachRunRecorder } from '../runtime/recording.ts';

declare global { interface Window {
  bridgeCompatibility: {
    bridge: ReturnType<typeof createCatalogBridge>;
    store: LocalRunStore;
    entry: CatalogEntry;
    importedMap: string;
    errors: string[];
    starts: number;
    returns: number;
    attachRecorder(): void;
    recorder?: ReturnType<typeof attachRunRecorder>;
  };
} }

test('catalog lifecycle preserves original autosaves and direct file imports without a recorder', { timeout: 120_000 }, async t => {
  await prepareRuntime();
  const corpus = JSON.parse(await readFile(path.join(communityRoot, 'tests/fixtures/base-cases.json'), 'utf8'));
  const fixture = corpus.cases.find((item: { id: string }) => item.id === 'prison-first-turn-hard');
  const imported = corpus.cases.find((item: { id: string }) => item.id === 'tiny-unfinished-hard');
  const parsed = parseMap(fixture.encodedMap);
  const entry: CatalogEntry = {
    map: { id: 'catalog-prison', metadata: { title: parsed.title, description: parsed.description, creator: parsed.creator, tags: [] }, state: 'published', currentRevisionId: 'prison-r1', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    revision: { id: 'prison-r1', mapId: 'catalog-prison', revision: 1, contentHash: parsed.contentHash, objectKey: 'prison', engineHash: corpus.engineHash, plugins: parsed.plugins, width: parsed.width, height: parsed.height, createdAt: '2026-01-01' },
    previewUrl: null, rating: { average: null, count: 0 }, scores: [],
  };
  const addon = await build({ stdin: { contents: `
    import {waitForCommunityEngine} from './runtime/menu-bridge.ts';
    import {createCatalogBridge} from './runtime/catalog-bridge.ts';
    import {LocalRunStore} from './web/local-runs.ts';
    import {attachRunRecorder} from './runtime/recording.ts';
    const loader=await waitForCommunityEngine();
    const probe={entry:${JSON.stringify(entry)}, importedMap:${JSON.stringify(imported.encodedMap)}, store:new LocalRunStore(localStorage), errors:[], starts:0, returns:0};
    probe.bridge=createCatalogBridge({loader,engineHash:${JSON.stringify(corpus.engineHash)},store:probe.store,
      loadMap:async()=>${JSON.stringify(fixture.encodedMap)},
      onStart:async(entry,difficulty)=>{probe.starts++;return {id:'run-'+crypto.randomUUID(),mapId:entry.map.id,revisionId:entry.revision.id,mapHash:entry.revision.contentHash,engineHash:entry.revision.engineHash,difficulty,plugins:entry.revision.plugins,adapterVersion:'fixture',issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString()};},
      onReturn:()=>{probe.returns++;},onError:error=>probe.errors.push(error.message)});
    probe.attachRecorder=()=>{probe.recorder=attachRunRecorder({loader,bridge:probe.bridge,onError:error=>probe.errors.push(error.message)});};
    window.bridgeCompatibility=probe;
  `, resolveDir: communityRoot, loader: 'ts' }, bundle: true, write: false, format: 'esm', target: 'es2023', platform: 'browser' });
  const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.xml': 'text/xml', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg' };
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://local').pathname;
      if (pathname === '/bridge-compatibility.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(addon.outputFiles[0].contents); return; }
      const file = path.resolve(generatedRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(generatedRoot + path.sep)) throw new Error('Bad path');
      response.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
      const data = await readFile(file);
      response.end(pathname === '/' ? data.toString().replace('</head>', '<script type="module" src="bridge-compatibility.js"></script></head>') : data);
    } catch { response.writeHead(404).end('Not found'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(origin); await page.waitForFunction(() => !!window.bridgeCompatibility);
  const ready = () => page.waitForFunction(() => window.communityReference.withEngine(load => !load(55151).app.navigator.transitionInProgress && !load(32070).inject.gameStateController.eventsPaused && load(55151).app.scene.play.mode.name === 'Play'));
  const start = async () => { await page.evaluate(() => window.bridgeCompatibility.bridge.start(window.bridgeCompatibility.entry, 'hard')); await ready(); };

  await t.test('native turn-start autosaves update the separate catalog save with submissions disabled', async () => {
    await start();
    await page.evaluate(() => { window.communityReference.act('SetSpectatingPlayBackSpeed', 3); window.communityReference.act('EndTurn', { force: true }); });
    await page.waitForFunction(() => window.communityReference.inspect().state.currentPhase.turnNumber === 2); await ready();
    const saved = await page.evaluate(() => ({ turn: window.bridgeCompatibility.store.saves()[0].save?.state.currentPhase.turnNumber, current: window.communityReference.inspect().state.currentPhase.turnNumber }));
    assert.equal(saved.current, 2);
    assert.equal(saved.turn, 2, 'A tab/process loss must retain the native turn-start checkpoint even with no replay recorder attached.');
    const speculativeSave = await page.evaluate(() => window.communityReference.withEngine(load => {
      const store = window.bridgeCompatibility.store;
      const before = JSON.stringify(store.saves());
      const controller = load(32070).inject.gameStateController;
      controller.beginTransaction();
      try { window.bridgeCompatibility.bridge.save(); }
      finally { controller.abortTransaction(); }
      return { before, after: JSON.stringify(store.saves()) };
    }));
    assert.equal(speculativeSave.after, speculativeSave.before, 'AI transactions must not replace a stable catalog checkpoint.');
  });

  await t.test('direct file import detaches the catalog context before original restart and exit', async () => {
    await start();
    const starts = await page.evaluate(() => window.bridgeCompatibility.starts);
    await page.evaluate(async () => { await window.communityReference.withEngine(load => load(20667).parseKonkrData(window.bridgeCompatibility.importedMap)); });
    await ready();
    const importedId = await page.evaluate(() => window.communityReference.inspect().state.map.levelId);
    await page.evaluate(() => window.communityReference.act('RestartLevel', { skipConfirmation: true }));
    await page.waitForFunction(() => !window.bridgeCompatibility.bridge.isBusy()); await ready();
    const actual = await page.evaluate(() => ({ active: window.bridgeCompatibility.bridge.current()?.entry.map.id ?? null, restartedId: window.communityReference.inspect().state.map.levelId, starts: window.bridgeCompatibility.starts }));
    assert.deepEqual(actual, { active: null, restartedId: importedId, starts }, 'Restarting a drag/drop map must restart that map without issuing another catalog run.');
    const ordinarySave = await page.evaluate(() => window.communityReference.withEngine(load => {
      const before = JSON.stringify(window.bridgeCompatibility.store.saves());
      load(32070).inject.userData.saveLevelProgress();
      return { before, after: JSON.stringify(window.bridgeCompatibility.store.saves()), latest: load(32070).inject.userData.current.latestLevelId };
    }));
    assert.equal(ordinarySave.after, ordinarySave.before, 'Original file-import autosaves must not overwrite catalog saves.');
    assert.equal(ordinarySave.latest, importedId, 'The original Continue path must retain the imported map.');
    await page.evaluate(() => window.communityReference.act('ExitLevel'));
    await page.waitForFunction(() => window.communityReference.inspect().screen === 'Title');
    assert.equal(await page.evaluate(() => window.bridgeCompatibility.returns), 0, 'Imported files must use their original return path.');
  });

  await t.test('malformed files retain the active recording and valid replays detach even with the same map ID', async () => {
    await page.evaluate(() => window.bridgeCompatibility.attachRecorder());
    await start();
    const before = await page.evaluate(() => ({ active: window.bridgeCompatibility.bridge.current(), recording: window.bridgeCompatibility.recorder!.submission() }));
    for (const malformed of ['invalid-framing', 'missing-map']) {
      const rejected = await page.evaluate(async malformed => {
        return window.communityReference.withEngine(async load => {
          const value = malformed === 'invalid-framing' ? 'konkrmap.v7.@@@' : load(47067).encodeGameState({});
          try { await load(20667).parseKonkrData(value); return false; } catch { return true; }
        });
      }, malformed);
      assert.equal(rejected, true);
      assert.deepEqual(await page.evaluate(() => ({ active: window.bridgeCompatibility.bridge.current(), recording: window.bridgeCompatibility.recorder!.submission() })), before);
    }
    await page.evaluate(async () => window.communityReference.withEngine(async load => {
      const replay = load(47067).encodeReplay(window.communityReference.exportHistory());
      await load(20667).parseKonkrData(replay);
    }));
    await page.waitForFunction(() => window.communityReference.withEngine(load => !load(55151).app.navigator.transitionInProgress && load(55151).app.screen.play.isReplay));
    assert.equal(await page.evaluate(() => window.bridgeCompatibility.bridge.current()), null);
    await page.evaluate(() => window.communityReference.act('ExitLevel'));
    await page.waitForFunction(() => window.communityReference.inspect().screen === 'Title');
    assert.equal(await page.evaluate(() => window.bridgeCompatibility.returns), 0);
  });
  assert.deepEqual(await page.evaluate(() => window.bridgeCompatibility.errors), []);
});
