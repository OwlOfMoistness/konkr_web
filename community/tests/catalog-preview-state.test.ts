import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import { communityRoot, generatedRoot, prepareRuntime } from '../scripts/prepare-runtime.ts';
import { parseMap } from '../engine/map-format.ts';
import type { CatalogEntry, Difficulty } from '../shared/contracts.ts';
import type { installCustomMaps } from '../web/custom-maps.ts';

interface TraceStep { play: { name: string; payload?: unknown }; state: Record<string, any> }
declare global {
  interface Window {
    previewStateHarness: {
      custom: Awaited<ReturnType<typeof installCustomMaps>>;
      failStart: boolean;
      delayMap: boolean;
      failSave: boolean;
      pendingLoads: number;
      releaseMap(): void;
      startCalls: number;
      counters: Record<string, number>;
      trace: TraceStep[];
      errors: string[];
      notices: string[][];
      ordinarySnapshot(): string;
      seedOrdinary(): Promise<void>;
      importControl(difficulty: Difficulty): Promise<void>;
      instrument(): void;
    };
  }
}

// Region labels consume the original cosmetic RNG. Preserve all gameplay fields,
// including the identical revision namespace, array order and effective rules.
function stateHash(state: Record<string, any>): string {
  const copy = structuredClone(state);
  for (const region of copy.regions ?? []) delete region.name;
  return createHash('sha256').update(JSON.stringify(copy)).digest('hex');
}

async function playable(page: Page, turn: number): Promise<void> {
  await page.waitForFunction(expected => window.communityReference.withEngine(load => {
    const { app } = load(55151), { inject } = load(32070);
    return app.navigator.activeScreen === app.screen.play && !app.navigator.transitionInProgress &&
      !window.previewStateHarness.custom.bridge.isBusy() && !inject.gameStateController.eventsPaused &&
      inject.gameStateModel.currentPhase.turnNumber === expected && inject.gameStateModel.currentPhase.faction.id === 1 &&
      !app.scene.play.gameEventQueue.hasNext() && app.scene.play.mode instanceof load(26990).PlayMode;
  }), turn, { timeout: 45_000 });
}

test('main-world previews preserve ordinary saves and both Prison AI trajectories', { timeout: 180_000 }, async t => {
  await prepareRuntime();
  const manifest = JSON.parse(await readFile(path.join(communityRoot, 'runtime/manifest.json'), 'utf8'));
  const engineHash = manifest.files[manifest.main];
  const corpus = JSON.parse(await readFile(new URL('fixtures/base-cases.json', import.meta.url), 'utf8'));
  const fixture = (id: string): string => {
    const found = corpus.cases.find((item: { id: string }) => item.id === id);
    assert.ok(found, `Missing committed fixture ${id}`); return found.encodedMap;
  };
  const maps = { prison: fixture('prison-first-turn-hard'), gifts: fixture('gifts-two-turns-hard') };
  const entries: CatalogEntry[] = Object.entries(maps).map(([id, encoded]) => {
    const parsed = parseMap(encoded);
    return {
      map: { id, metadata: { title: id === 'prison' ? 'Prison' : 'Gifts', description: '', creator: '', tags: [] }, state: 'published', currentRevisionId: `${id}-r1`, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', publishedAt: '2026-01-01T00:00:00.000Z' },
      revision: { id: `${id}-r1`, mapId: id, revision: 1, contentHash: parsed.contentHash, objectKey: id, engineHash, plugins: parsed.plugins, width: parsed.width, height: parsed.height, createdAt: '2026-01-01T00:00:00.000Z' },
      previewUrl: null, rating: { average: null, count: 0 }, scores: [],
    };
  });
  const addon = await build({ stdin: { contents: `
    import { installCustomMaps, createCatalogSaveStore } from './web/custom-maps.ts';
    import { initializeNativeAssets } from './web/native-controls.ts';
    import { runtimeLevelId } from './shared/runtime-identity.ts';
    await initializeNativeAssets();
    const entries = ${JSON.stringify(entries)}, maps = ${JSON.stringify(maps)};
    const binding = (entry, difficulty) => ({id:'fixture-'+difficulty,mapId:entry.map.id,revisionId:entry.revision.id,
      mapHash:entry.revision.contentHash,engineHash:entry.revision.engineHash,difficulty,plugins:entry.revision.plugins,
      adapterVersion:'fixture',issuedAt:'2026-01-01T00:00:00.000Z',expiresAt:'2099-01-01T00:00:00.000Z'});
    const root = document.createElement('main'); root.id='preview-state-catalog'; document.body.append(root);
    const h = {failStart:false,delayMap:false,failSave:false,pendingLoads:0,releaseMap:()=>{},startCalls:0,counters:{},trace:[],errors:[],notices:[]};
    const store=createCatalogSaveStore(localStorage),put=store.put;
    store.put=(...args)=>{if(h.failSave)throw new Error('Fixture checkpoint write failed');return put(...args)};
    h.custom = await installCustomMaps({root,engineHash:${JSON.stringify(engineHash)},store,
      reader:{async list(){return {entries,total:entries.length}},async get(id){return entries.find(entry=>entry.map.id===id)??null}},
      loadMap:async entry=>{
        if(h.delayMap){h.pendingLoads++;try{await new Promise(resolve=>{h.releaseMap=resolve})}finally{h.pendingLoads--}}
        return maps[entry.map.id];
      },
      onStart:async(entry,difficulty)=>{h.startCalls++;if(h.failStart)throw new Error('Fixture issuance unavailable');return binding(entry,difficulty)},
      onError:error=>h.errors.push(error.message)});
    window.communityReference.withEngine(load=>{
      const notifications=load(55151).app.notifications,warning=notifications.warning;
      notifications.warning=function(...args){h.notices.push(args.map(String));return warning.apply(this,args)};
    });
    const clone = value => JSON.parse(JSON.stringify(value));
    h.seedOrdinary = async () => {
      const encoded = window.communityReference.withEngine(load => {
        const codec=load(47067), state=codec.decodeGameState(${JSON.stringify(fixture('tiny-unfinished-hard'))});
        state.map.levelId='cl-preview-ordinary';return codec.encodeGameState(state);
      });
      await window.communityReference.importMap(encoded,'hard');
      window.communityReference.act('ExitLevel');
    };
    h.importControl = async difficulty => {
      const id=await runtimeLevelId(binding(entries[0],difficulty));
      const encoded=window.communityReference.withEngine(load=>{
        const codec=load(47067),state=codec.decodeGameState(maps.prison);state.map.levelId=id;return codec.encodeGameState(state);
      });
      await window.communityReference.importMap(encoded,difficulty);
    };
    h.ordinarySnapshot = () => window.communityReference.withEngine(load => {
      const {inject}=load(32070);
      const nativeStorage=Object.fromEntries(Object.keys(localStorage).filter(key=>!key.startsWith('konkr.community.')).sort().map(key=>[key,localStorage.getItem(key)]));
      const history=window.communityReference.exportHistory();
      // Original export stamps the current time on every read; it is not stored history.
      delete history.meta.timestamp;
      return JSON.stringify({profile:clone(inject.userData.current),nativeStorage,session:clone(inject.ui.session.data??null),
        outcome:inject.ui.session.outcome??null,history});
    });
    h.instrument = () => window.communityReference.withEngine(load => {
      const {inject}=load(32070),history=inject.gameStateController.history;
      for (const [object,key,label] of [[inject.ai,'play','ai'],[inject.userData,'saveLevelProgress','save'],
        [inject.userData,'saveCustomLevelStartingState','saveStart'],[inject.ui.session,'startNew','session'],
        [inject.gameStateController,'executePlay','execute'],[history,'reset','reset'],[history,'import','import']]) {
        const original=object[key];h.counters[label]=0;
        object[key]=function(...args){h.counters[label]++;return original.apply(this,args)};
      }
      const original=history.addPlay;h.counters.addPlay=0;
      history.addPlay=function(play,events,state){
        h.counters.addPlay++;const result=original.apply(this,arguments);
        h.trace.push({play:clone(play),state:clone(load(13524).compressGameState(state))});return result;
      };
    });
    window.previewStateHarness=h;
  `, loader: 'ts', resolveDir: communityRoot }, bundle: true, write: false, format: 'esm', target: 'es2023', platform: 'browser' });
  const css = await readFile(path.join(communityRoot, 'web/theme.css'), 'utf8') + await readFile(path.join(communityRoot, 'web/catalog.css'), 'utf8');
  const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.xml': 'text/xml', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.css': 'text/css' };
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://local').pathname;
      if (pathname === '/preview-state-addon.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(addon.outputFiles[0].contents); return; }
      if (pathname === '/catalog.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); return; }
      const file = path.resolve(generatedRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(generatedRoot + path.sep)) throw new Error('Bad path');
      response.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
      const data = await readFile(file);
      response.end(pathname === '/' ? data.toString().replace('</head>', '<link rel="stylesheet" href="catalog.css"><script type="module" src="preview-state-addon.js"></script></head>') : data);
    } catch { response.writeHead(404).end('Not found'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  t.after(() => browser.close());

  for (const difficulty of ['normal', 'hard'] as const) await t.test(difficulty, async () => {
    const runs: Array<{ initial: string; final: string; trace: Array<{ play: TraceStep['play']; state: string }> }> = [];
    for (const preview of [false, true]) {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
      try {
        const external: string[] = [], failures: string[] = [];
        await context.route('**/*', route => {
          if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); }
          return route.continue();
        });
        const page = await context.newPage(); page.on('pageerror', error => failures.push(error.message));
        await page.goto(`${origin}/?community=1#preview-state`);
        await page.waitForFunction(() => !!window.previewStateHarness, undefined, { timeout: 30_000 });
        const url = page.url();
        await page.evaluate(() => window.previewStateHarness.seedOrdinary());
        await page.waitForFunction(() => window.communityReference.withEngine(load => {
          const {app}=load(55151);return app.navigator.activeScreen===app.screen.title&&!app.navigator.transitionInProgress;
        }));
        await page.evaluate(() => window.previewStateHarness.instrument());
        const ordinary = await page.evaluate(() => window.previewStateHarness.ordinarySnapshot());
        assert.ok(JSON.parse(ordinary).profile.levels['cl-preview-ordinary'], 'Seed a real ordinary save before previewing');
        if (preview) {
          await page.getByRole('button', { name: 'Custom Maps', exact: true }).click();
          const select = async (title: string, width: number) => {
            await page.getByRole('button', { name: title, exact: true }).click();
            await page.locator('.catalog-preview-large[data-live-preview-ready="true"]').waitFor();
            await page.waitForFunction(expected => window.communityReference.withEngine(load => {
              const {app}=load(55151),{inject}=load(32070);
              return app.navigator.activeScreen?.name==='CustomMaps'&&!app.navigator.transitionInProgress&&
                inject.gameStateModel.map.width===expected&&app.scene.worldMap.mode instanceof load(28208).PreviewMode;
            }), width);
          };
          await select('Prison', entries[0].revision.width);
          await select('Gifts', entries[1].revision.width);
          await page.setViewportSize({ width: 1120, height: 820 });
          await select('Prison', entries[0].revision.width);
          await page.setViewportSize({ width: 1280, height: 900 });
          await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
          assert.equal(await page.locator('#phaser-game canvas').isVisible(), true);
          assert.equal(await page.locator('.catalog-preview-large iframe, iframe[src*="/community-preview"]').count(), 0, 'The selected preview uses the original main canvas');
          assert.deepEqual(JSON.parse(await page.evaluate(() => window.previewStateHarness.ordinarySnapshot())), JSON.parse(ordinary), 'Browsing and resizing preserve ordinary profile, session, history and native storage');
          assert.ok(Object.values(await page.evaluate(() => window.previewStateHarness.counters)).every(value => value === 0), 'Preview must not call save, session start, history mutation, plays or AI');
          assert.equal(await page.evaluate(() => window.previewStateHarness.startCalls), 0);
          assert.equal(await page.evaluate(() => window.communityReference.withEngine(load => {
            const {app}=load(55151),{inject}=load(32070);
            return !app.scene.play.scene.isActive()&&!inject.gameStateController.eventsPaused&&!app.scene.play.mode.isReadyForMoreGameEvents();
          })), true);
          await page.getByRole('radio', { name: difficulty === 'hard' ? 'Hard' : 'Normal', exact: true }).click();
          await page.evaluate(() => { window.previewStateHarness.failStart = true; });
          await page.getByRole('button', { name: 'Play map', exact: true }).click();
          await page.getByRole('alert').filter({ hasText: 'could not be started' }).waitFor();
          assert.deepEqual(JSON.parse(await page.evaluate(() => window.previewStateHarness.ordinarySnapshot())), JSON.parse(ordinary), 'Rejected issuance must preserve ordinary state');
          assert.ok(Object.values(await page.evaluate(() => window.previewStateHarness.counters)).every(value => value === 0));
          assert.equal(await page.evaluate(() => window.previewStateHarness.custom.bridge.current()), null);
          await page.evaluate(() => { window.previewStateHarness.failStart = false; });
          await page.getByRole('button', { name: 'Play map', exact: true }).click();
        } else await page.evaluate(mode => window.previewStateHarness.importControl(mode), difficulty);
        await playable(page, 1);
        const initial = await page.evaluate(() => window.communityReference.inspect());
        assert.equal(initial.difficulty, difficulty);
        assert.equal(initial.effectivePluginCount, entries[0].revision.plugins.length + (difficulty === 'normal' ? 1 : 0));
        await page.evaluate(() => { window.communityReference.act('SetSpectatingPlayBackSpeed', 3); window.communityReference.act('EndTurn', { force: true }); });
        await playable(page, 2);
        const final = await page.evaluate(() => window.communityReference.inspect());
        const trace = await page.evaluate(() => window.previewStateHarness.trace);
        assert.ok(trace.length > 1, 'Observe committed player and opponent actions, not just initial state');
        runs.push({ initial: stateHash(initial.state), final: stateHash(final.state), trace: trace.map(step => ({ play: step.play, state: stateHash(step.state) })) });
        assert.equal(page.url(), url);
        assert.deepEqual(external, []); assert.deepEqual(failures, []);
        assert.deepEqual(await page.evaluate(() => window.communityReference.errors), []);
        assert.deepEqual(await page.evaluate(() => window.previewStateHarness.errors), []);
      } finally { await context.close(); }
    }
    assert.deepEqual(runs[1], runs[0], `${difficulty}: preview → Play must match original direct import through every committed first-turn action`);
  });

  await t.test('delayed preview cancellation and a post-navigation checkpoint failure keep navigation usable', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    try {
      const external: string[] = [], failures: string[] = [];
      await context.route('**/*', route => {
        if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); }
        return route.continue();
      });
      const page = await context.newPage(); page.on('pageerror', error => failures.push(error.message));
      await page.goto(`${origin}/?community=1#preview-failures`);
      await page.waitForFunction(() => !!window.previewStateHarness, undefined, { timeout: 30_000 });
      const url = page.url();
      const title = () => page.waitForFunction(() => window.communityReference.withEngine(load => {
        const { app } = load(55151);
        return app.navigator.activeScreen === app.screen.title && !app.navigator.transitionInProgress;
      }));
      await page.evaluate(() => window.previewStateHarness.seedOrdinary()); await title();
      await page.evaluate(() => { window.previewStateHarness.instrument(); window.previewStateHarness.delayMap = true; });
      const ordinary = JSON.parse(await page.evaluate(() => window.previewStateHarness.ordinarySnapshot()));
      await page.getByRole('button', { name: 'Custom Maps', exact: true }).click();
      await page.waitForFunction(() => window.previewStateHarness.pendingLoads === 1 && window.communityReference.withEngine(load => {
        const { app } = load(55151);
        return app.navigator.activeScreen?.name === 'CustomMaps' && !app.navigator.transitionInProgress;
      }), undefined, { timeout: 10_000 });
      assert.equal(await page.locator('#preview-state-catalog').evaluate(root => (root as HTMLElement).inert), false, 'An unresolved download must not hold the menu inert');
      await page.getByRole('button', { name: 'Back', exact: true }).click(); await title();
      const titleState = stateHash((await page.evaluate(() => window.communityReference.inspect())).state);
      await page.evaluate(() => { window.previewStateHarness.delayMap = false; window.previewStateHarness.releaseMap(); });
      await page.waitForFunction(() => window.previewStateHarness.pendingLoads === 0);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
      await title();
      assert.equal(stateHash((await page.evaluate(() => window.communityReference.inspect())).state), titleState, 'A late download must not replace the state displayed by Title');
      assert.deepEqual(JSON.parse(await page.evaluate(() => window.previewStateHarness.ordinarySnapshot())), ordinary, 'A cancelled preview must not write saves or history');
      assert.ok(Object.values(await page.evaluate(() => window.previewStateHarness.counters)).every(value => value === 0));
      assert.equal(await page.evaluate(() => window.previewStateHarness.startCalls), 0);

      await page.getByRole('button', { name: 'Custom Maps', exact: true }).click();
      await page.locator('.catalog-preview-large[data-live-preview-ready="true"]').waitFor();
      await page.evaluate(() => { window.previewStateHarness.failSave = true; });
      await page.getByRole('button', { name: 'Play map', exact: true }).click();
      await playable(page, 1);
      await page.waitForFunction(() => window.previewStateHarness.errors.includes('Fixture checkpoint write failed'));
      assert.equal(await page.locator('#preview-state-catalog').evaluate(root => (root as HTMLElement).hidden && !(root as HTMLElement).inert), true);
      assert.equal(await page.evaluate(() => window.communityReference.withEngine(load => {
        const { app } = load(55151); return app.game.input.enabled && app.game.input.keyboard.enabled;
      })), true, 'A checkpoint error after navigation must restore both pointer and keyboard input');
      assert.ok(await page.evaluate(() => window.previewStateHarness.notices.some(notice => notice[0] === 'Custom Maps' && notice[1] === 'Fixture checkpoint write failed')), 'The failure must reach the original visible notification UI while the catalogue is hidden');
      await page.evaluate(() => { window.previewStateHarness.failSave = false; window.communityReference.act('TogglePlayMenu'); });
      await page.waitForFunction(() => window.communityReference.withEngine(load => load(55151).app.screen.play.isPlayMenuOpen));
      assert.equal(page.url(), url);
      assert.deepEqual(external, []); assert.deepEqual(failures, []);
      assert.deepEqual(await page.evaluate(() => window.communityReference.errors), []);
    } finally { await context.close(); }
  });
});
