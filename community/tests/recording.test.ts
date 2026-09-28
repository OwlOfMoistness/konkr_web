import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { attachRunRecorder, recordingSubmission, restoreRecording, semanticDecision } from '../runtime/recording.ts';
import type { RunRecording } from '../runtime/recording.ts';
import type { CatalogBridgeEvent, CatalogRunContext, CatalogSave, createCatalogBridge } from '../runtime/catalog-bridge.ts';
import { LocalRunStore } from '../web/local-runs.ts';
import { parseMap } from '../engine/map-format.ts';
import { communityRoot, generatedRoot, prepareRuntime } from '../scripts/prepare-runtime.ts';
import type { CatalogEntry, Difficulty, PlayerDecision } from '../shared/contracts.ts';

type Fixture = { id: string; encodedMap: string; difficulty: Difficulty; decisions: PlayerDecision[]; expected: string };
const runContext = { binding: { id: 'run-1' } } as CatalogRunContext;
const move = { name: 'PLAY.MOVE_PAWN', payload: { pawnId: 3, destinationHexId: 203, tapUnit: false } };
function mockRecorder() {
  let listener: (event: CatalogBridgeEvent) => void = () => {};
  const errors: string[] = [];
  const victories: unknown[] = [];
  const history = {
    data: [{ activeFaction: 1 }],
    get length() { return this.data.length; },
    addPlay(_play: unknown, afterFaction: number) { this.data.push({ activeFaction: afterFaction }); },
    rewindTo(cursor: { currentIndex: number }) { this.data.splice(cursor.currentIndex + 1); },
    reset() { this.data = [{ activeFaction: 1 }]; },
    import() { this.reset(); },
  };
  const controller = { history, eventsPaused: false };
  class Landing {
    isValidLandingSpot(hex: { id: number }) { return hex.id === 202; }
    handleStartInteraction(hex: { id: number }) { if (this.isValidLandingSpot(hex)) history.reset(); }
  }
  const bridge = {
    subscribe(callback: typeof listener) { listener = callback; return () => { listener = () => {}; }; },
    current: () => null,
    save: () => { const save = { context: runContext } as CatalogSave; listener({ type: 'saving', save }); return save; },
  } as ReturnType<typeof createCatalogBridge>;
  const recorder = attachRunRecorder({ loader: id => id === 32070 ? { inject: { gameStateController: controller } } : { PickLandingSpotMode: Landing }, bridge, onError: error => errors.push(error.message), onVictory: (_context, submission) => victories.push(submission) });
  const start = (resume: CatalogSave | null = null) => { listener({ type: 'starting', context: runContext, resume }); listener({ type: 'started', context: runContext, resume }); };
  start();
  return { recorder, history, controller, errors, victories, start, Landing, emit: (event: CatalogBridgeEvent) => listener(event) };
}

test('recording attributes EndTurn to the prior faction, excludes AI, and discards undone branches', () => {
  const m = mockRecorder();
  m.history.addPlay(move, 1);
  m.history.addPlay({ name: 'PLAY.END_TURN' }, 2);
  m.history.addPlay(move, 2);
  m.history.addPlay({ name: 'PLAY.END_TURN' }, 1);
  assert.deepEqual(m.recorder.submission().decisions, [{ kind: 'move', pawnId: 3, destinationHexId: 203 }, { kind: 'end-turn' }]);
  m.history.rewindTo({ currentIndex: 1 });
  m.history.addPlay({ name: 'PLAY.BUY_PAWN', payload: { pawnType: 'villager', destinationHexId: 302, buyerRegionId: 1 } }, 1);
  assert.deepEqual(m.recorder.submission().decisions, [{ kind: 'move', pawnId: 3, destinationHexId: 203 }, { kind: 'buy', pawnType: 'villager', destinationHexId: 302, buyerRegionId: 1 }]);
  const saved = m.recorder.flush();
  const idempotencyKey = m.recorder.submission().idempotencyKey;
  m.start(saved); assert.equal(m.recorder.submission().idempotencyKey, idempotencyKey);
  m.emit({ type: 'outcome', context: runContext, outcome: 'Victory' });
  assert.equal(m.victories.length, 1); assert.deepEqual(m.errors, []);
  m.recorder.destroy();
});

test('missing/cropped recordings and unexpected resets cannot silently become complete submissions', () => {
  const m = mockRecorder();
  m.start({ context: runContext } as CatalogSave);
  assert.throws(() => m.recorder.submission(), /no complete run recording/);
  m.start(); m.history.reset();
  assert.throws(() => m.recorder.submission(), /history was replaced/);
  const incomplete = m.recorder.flush();
  const count = m.errors.length; m.start(incomplete); assert.equal(m.errors.length, count + 1);
  const recording: RunRecording = { version: 1, runId: 'run-1', idempotencyKey: 'retry-1', complete: true, decisions: [{ historyIndex: 3, decision: { kind: 'end-turn' } }] };
  assert.throws(() => restoreRecording(recording, 'run-1', 2), /history branch/);
  assert.throws(() => restoreRecording(recording, 'run-2', 5), /does not match/);
  assert.throws(() => recordingSubmission({ ...recording, complete: false }), /missing part/);
  assert.equal(semanticDecision({ name: 'PLAY.TOGGLE_TAPPED' }), null);
  m.recorder.destroy();
});

test('a landing choice survives its original history reset as a semantic first decision', () => {
  const m = mockRecorder(); const landing = new m.Landing();
  landing.handleStartInteraction({ id: 203 }); assert.deepEqual(m.recorder.submission().decisions, []);
  landing.handleStartInteraction({ id: 202 });
  assert.deepEqual(m.recorder.submission().decisions, [{ kind: 'choose-landing', hexId: 202 }]);
  m.history.addPlay(move, 1); m.history.rewindTo({ currentIndex: 0 });
  assert.deepEqual(m.recorder.submission().decisions, [{ kind: 'choose-landing', hexId: 202 }]);
  assert.deepEqual(m.errors, []); m.recorder.destroy();
});

test('local saves retain pending result retries independently, and quota failures keep previous data', () => {
  const data = new Map<string, string>(); let fail = false;
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { if (fail) throw new Error('Quota'); data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  const store = new LocalRunStore(storage);
  const save = { version: 1, context: runContext, state: { replay: {} }, sessionId: 'session-1', remainingLives: 3, savedAt: '2026-01-01' } as CatalogSave;
  store.put('map-r1-normal', save); fail = true;
  assert.throws(() => store.put('map-r1-normal', { ...save, savedAt: 'later' }), /could not save/);
  assert.equal(store.get('map-r1-normal')?.savedAt, save.savedAt); fail = false;
  const submission = { version: 1 as const, runId: 'run-1', idempotencyKey: 'retry-1', decisions: [{ kind: 'end-turn' as const }] };
  store.enqueue(submission); store.enqueue(submission);
  store.remove('map-r1-normal');
  const reloaded = new LocalRunStore(storage);
  assert.deepEqual(reloaded.pending().map(entry => entry.submission), [submission]);
  assert.throws(() => reloaded.enqueue({ ...submission, decisions: [] }), /different result/);
  reloaded.setStatus('run-1', { status: 'invalid', code: 'NOT_LEGAL' });
  assert.equal(reloaded.pending()[0].status.status, 'invalid');
  reloaded.acknowledge('run-1'); assert.deepEqual(reloaded.pending(), []);
});

declare global { interface Window {
  recordingTest: { bridge: ReturnType<typeof createCatalogBridge>; recorder: ReturnType<typeof attachRunRecorder>; store: LocalRunStore; entries: CatalogEntry[]; fixtures: Fixture[]; errors: string[]; victories: unknown[]; startCalls: number };
} }

test('real browser records canonical undo/rewind branches, resumes across reload, and captures actual terminal outcomes', { timeout: 240_000 }, async t => {
  const corpusPath = process.env.KONKR_RECORDING_CORPUS ?? path.join(communityRoot, 'tests/fixtures/base-cases.json');
  const corpus: { engineHash: string; cases: Fixture[] } = JSON.parse(await readFile(corpusPath, 'utf8'));
  await prepareRuntime();
  const entries: CatalogEntry[] = corpus.cases.map(fixture => {
    const map = parseMap(fixture.encodedMap);
    return { map: { id: fixture.id, metadata: { title: map.title, description: map.description, creator: map.creator, tags: [] }, state: 'published', currentRevisionId: fixture.id + '-r1', createdAt: '2026-01-01', updatedAt: '2026-01-01' }, revision: { id: fixture.id + '-r1', mapId: fixture.id, revision: 1, contentHash: map.contentHash, objectKey: fixture.id, engineHash: corpus.engineHash, plugins: map.plugins, width: map.width, height: map.height, createdAt: '2026-01-01' }, previewUrl: null, rating: { average: null, count: 0 }, scores: [] };
  });
  const addon = await build({ stdin: { contents: `
    import { waitForCommunityEngine, preservePlayerUrl } from './runtime/menu-bridge.ts';
    import { createCatalogBridge } from './runtime/catalog-bridge.ts';
    import { attachRunRecorder } from './runtime/recording.ts';
    import { LocalRunStore } from './web/local-runs.ts';
    const loader=await waitForCommunityEngine(); preservePlayerUrl(loader);
    const entries=${JSON.stringify(entries)}, fixtures=${JSON.stringify(corpus.cases.map(({ id, encodedMap, difficulty, decisions, expected }) => ({ id, encodedMap, difficulty, decisions, expected })))};
    const store=new LocalRunStore(localStorage), errors=[], victories=[];
    const test={store,entries,fixtures,errors,victories,startCalls:0};
    test.bridge=createCatalogBridge({loader,engineHash:${JSON.stringify(corpus.engineHash)},store,
      loadMap:async entry=>fixtures.find(item=>item.id===entry.map.id).encodedMap,
      onStart:async(entry,difficulty)=>{test.startCalls++;return {id:'run-'+crypto.randomUUID(),mapId:entry.map.id,revisionId:entry.revision.id,mapHash:entry.revision.contentHash,engineHash:entry.revision.engineHash,difficulty,plugins:entry.revision.plugins,adapterVersion:'fixture',issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString()}},
      onReturn:()=>{},onError:error=>errors.push(error.message)});
    test.recorder=attachRunRecorder({loader,bridge:test.bridge,onError:error=>errors.push(error.message),onVictory:(_context,submission)=>{victories.push(submission);store.enqueue(submission)}});
    window.recordingTest=test;
  `, loader: 'ts', resolveDir: communityRoot }, bundle: true, write: false, format: 'esm', target: 'es2023', platform: 'browser' });
  const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.xml': 'text/xml', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.css': 'text/css' };
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://local').pathname;
      if (pathname === '/recording-addon.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(addon.outputFiles[0].contents); return; }
      const file = path.resolve(generatedRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(generatedRoot + path.sep)) throw new Error('Bad path');
      response.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
      const data = await readFile(file);
      response.end(pathname === '/' ? data.toString().replace('</head>', '<script type="module" src="recording-addon.js"></script></head>') : data);
    } catch { response.writeHead(404).end('Not found'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); assert(address && typeof address !== 'string'); const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] }); t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const external: string[] = [];
  await context.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
  const page = await context.newPage(); const failures: string[] = []; page.on('pageerror', error => failures.push(error.message));
  page.on('console', message => { if (message.type() === 'error') t.diagnostic(message.text()); });
  const url = `${origin}/?recording=1#constant`;
  await page.goto(url); await page.waitForFunction(() => !!window.recordingTest);
  const start = async (id: string) => { await page.evaluate(async id => { const test = window.recordingTest; const fixture = test.fixtures.find(item => item.id === id)!; await test.bridge.start(test.entries.find(entry => entry.map.id === id)!, fixture.difficulty); window.communityReference.act('SetSpectatingPlayBackSpeed', 3); }, id); };
  const ready = () => page.waitForFunction(() => window.communityReference.withEngine(load => !load(55151).app.navigator.transitionInProgress && !load(32070).inject.gameStateController.eventsPaused && load(55151).app.scene.play.mode.name === 'Play'));
  const submission = () => page.evaluate(() => window.recordingTest.recorder.submission());
  const play = async (decision: PlayerDecision) => {
    await ready();
    await page.evaluate(decision => {
      switch (decision.kind) {
        case 'move': window.communityReference.play('MovePawn', { pawnId: decision.pawnId, destinationHexId: decision.destinationHexId, tapUnit: false }); break;
        case 'buy': window.communityReference.play('BuyPawn', { pawnType: decision.pawnType, destinationHexId: decision.destinationHexId, buyerRegionId: decision.buyerRegionId, tapUnit: false }); break;
        case 'end-turn': window.communityReference.act('EndTurn', { force: true }); break;
        case 'accept-surrender': window.communityReference.act('AcceptSurrender'); break;
      }
    }, decision);
  };
  const state = () => page.evaluate(() => { const result = window.communityReference.inspect().state; for (const region of result.regions) delete region.name; return result; });
  await start('tiny-win-normal');
  await play({ kind: 'move', pawnId: 3, destinationHexId: 203 });
  await page.evaluate(() => window.communityReference.act('Undo'));
  assert.deepEqual((await submission()).decisions, []);
  await play({ kind: 'move', pawnId: 3, destinationHexId: 203 });
  await play({ kind: 'buy', pawnType: 'villager', destinationHexId: 302, buyerRegionId: 1 });
  const beforeReload = await submission(); const beforeState = await state();
  await page.evaluate(() => window.recordingTest.recorder.flush());
  await page.reload(); await page.waitForFunction(() => !!window.recordingTest);
  await page.evaluate(() => window.recordingTest.bridge.resume(window.recordingTest.entries.find(entry => entry.map.id === 'tiny-win-normal')!, 'normal'));
  assert.deepEqual(await submission(), beforeReload); assert.deepEqual(await state(), beforeState);
  assert.equal(await page.evaluate(() => window.recordingTest.startCalls), 0);
  // Replaying the surviving branch from the original map reaches the same gameplay state.
  await start('tiny-win-normal'); for (const decision of beforeReload.decisions) await play(decision);
  assert.deepEqual(await state(), beforeState);
  await start('prison-first-turn-hard'); await play({ kind: 'end-turn' }); await ready();
  await page.waitForFunction(() => window.communityReference.inspect().state.currentPhase.turnNumber === 2);
  assert.deepEqual((await submission()).decisions, [{ kind: 'end-turn' }]);
  await page.evaluate(() => window.communityReference.withEngine(load => { const controller = load(32070).inject.gameStateController; controller.rewindTo(controller.history.getCursor().goTo(0)); }));
  assert.deepEqual((await submission()).decisions, []);
  // Each actual fixture outcome must be recorded without including automatic AI decisions.
  for (const fixture of corpus.cases) {
    await start(fixture.id);
    for (const decision of fixture.decisions) { await play(decision); if (fixture.expected === 'unfinished') await ready(); }
    if (fixture.expected !== 'unfinished') await page.waitForFunction(expected => window.communityReference.inspect().screen === (expected === 'victory' ? 'Victory' : 'Defeat'), fixture.expected);
    else await ready();
    assert.deepEqual((await submission()).decisions, fixture.decisions, fixture.id);
    assert.equal(page.url(), url);
  }
  const winningCases = corpus.cases.filter(fixture => fixture.expected === 'victory').length;
  assert.equal(await page.evaluate(() => window.recordingTest.victories.length), winningCases);
  assert.equal(await page.evaluate(() => window.recordingTest.store.pending().length), winningCases);
  assert.deepEqual(await page.evaluate(() => window.recordingTest.errors), []);
  assert.deepEqual(await page.evaluate(() => window.communityReference.errors), []);
  assert.deepEqual(await page.evaluate(() => window.communityReference.blockedRequests), []);
  assert.deepEqual(external, []); assert.deepEqual(failures, []);
});
