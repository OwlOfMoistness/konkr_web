import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createResultsApi, createResultsController, describeResult, readRunStatus, RunApiError } from '../web/results.ts';
import type { ResultsApi } from '../web/results.ts';
import { LocalRunStore } from '../web/local-runs.ts';
import { parseMap } from '../engine/map-format.ts';
import type { CatalogEntry, PublicRunStatus, RunBinding } from '../shared/contracts.ts';
import type { CatalogRunContext, CatalogSave } from '../runtime/catalog-bridge.ts';
import type { installCustomMaps } from '../web/custom-maps.ts';
import { communityRoot, generatedRoot, prepareRuntime } from '../scripts/prepare-runtime.ts';

function memory() {
  const data = new Map<string, string>();
  return { data, fail: false, get length() { return data.size; }, key: (index: number) => [...data.keys()][index] ?? null, getItem: (key: string) => data.get(key) ?? null, setItem(key: string, value: string) { if (this.fail) throw new Error('Quota'); data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}
const entry: CatalogEntry = { map: { id: 'map', currentRevisionId: 'revision', state: 'published', metadata: { title: '<old map>', description: '', creator: '', tags: [] }, createdAt: '2026-01-01', updatedAt: '2026-01-01' }, revision: { id: 'revision', mapId: 'map', revision: 1, contentHash: 'hash', engineHash: 'engine', plugins: [], objectKey: 'map', width: 5, height: 5, createdAt: '2026-01-01' }, previewUrl: null, rating: { average: null, count: 0 }, scores: [] };
const binding: RunBinding = { id: 'run', mapId: 'map', revisionId: 'revision', mapHash: 'hash', engineHash: 'engine', adapterVersion: 'adapter', difficulty: 'normal', plugins: [], issuedAt: '2026-01-01', expiresAt: '2026-12-31' };
const runContext: CatalogRunContext = { entry, binding, difficulty: 'normal', runtimeLevelId: 'local-map', canonicalMap: 'encoded' };
const submission = { version: 1 as const, runId: 'run', idempotencyKey: 'stable-retry', decisions: [{ kind: 'end-turn' as const }] };
const verified: PublicRunStatus = { status: 'verified', outcome: 'victory', turns: 4, finalStateHash: 'a'.repeat(64) };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('issued binding persists before returning; offline retry and reload preserve exact submission identity', async () => {
  const storage = memory(); const store = new LocalRunStore(storage); let offline = true; const bodies: unknown[] = [];
  const api: ResultsApi = { issue: async () => binding, submit: async body => { bodies.push(structuredClone(body)); if (offline) throw new TypeError('offline'); return { status: 'pending', runId: 'run' }; }, read: async () => ({ binding, result: verified }) };
  let notifications = 0;
  const controller = createResultsController({ api, store, onVerified: () => { notifications++; } });
  storage.fail = true; await assert.rejects(controller.onStart(entry, 'normal'), /could not save/); storage.fail = false;
  assert.deepEqual(await controller.onStart(entry, 'normal'), binding);
  assert([...storage.data.values()].some(value => JSON.parse(value).id === 'run'));
  controller.enqueue(runContext, submission); await tick();
  assert.equal(controller.snapshot()[0].problem?.retryable, true); assert.deepEqual(store.pending()[0].submission, submission);
  offline = false; await Promise.all([controller.retry('run'), controller.retry('run')]);
  assert.equal(bodies.length, 2, 'Simultaneous retries share the same in-flight request'); assert.deepEqual(bodies, [submission, submission]);
  assert.equal(store.pending()[0].acknowledged, true); controller.destroy();
  const reloaded = createResultsController({ api, store: new LocalRunStore(storage), onVerified: () => { notifications++; } });
  assert.equal(reloaded.snapshot()[0].status, null, 'Persisted fields do not certify a result');
  await reloaded.refresh(); assert.equal(reloaded.snapshot()[0].status?.status, 'verified'); assert.equal(notifications, 1);
  reloaded.dismiss('run'); assert.deepEqual(store.pending(), []); reloaded.destroy();
});

test('terminal outcomes and expiry/conflict errors remain distinct and retain recordings', async () => {
  const statuses: PublicRunStatus[] = [verified, { status: 'non-winning', outcome: 'unfinished', turns: 2 }, { status: 'non-winning', outcome: 'defeat', turns: 2 }, { status: 'invalid', code: 'ILLEGAL_MOVE' }, { status: 'unsupported', code: 'RETIRED_ENGINE' }, { status: 'error', code: 'WORKER_FAILED', retryable: false }];
  for (const status of statuses) {
    const store = new LocalRunStore(memory()); store.enqueue(submission);
    const controller = createResultsController({ store, api: { issue: async () => binding, submit: async () => status, read: async () => ({ binding, result: status }) } });
    await controller.refresh(); assert.deepEqual(controller.snapshot()[0].status, status); assert.ok(describeResult(controller.snapshot()[0])); assert.equal(store.pending().length, 1); controller.destroy();
  }
  for (const [code, phrase] of [[410, 'expired'], [409, 'different submission'], [404, 'unavailable'], [503, 'could not be reached']] as const) {
    const store = new LocalRunStore(memory()); store.enqueue(submission);
    const controller = createResultsController({ store, api: { issue: async () => binding, submit: async () => { throw new RunApiError(code, 'failure'); }, read: async () => ({ binding, result: null }) } });
    await controller.refresh(); assert.match(describeResult(controller.snapshot()[0]), new RegExp(phrase)); assert.equal(store.pending().length, 1); controller.destroy();
  }
  assert.throws(() => readRunStatus({ status: 'verified', outcome: 'victory', turns: -1, finalStateHash: 'fake' }, 'run'), /invalid response/);
});

test('HTTP client binds mutations to CSRF and rejects mismatched server identity', async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  let wrong = false;
  const api = createResultsApi({ csrfToken: async () => 'csrf' }, async (url, init) => { seen.push({ url: String(url), init }); return Response.json({ binding: { ...binding, mapId: wrong ? 'different' : 'map' } }); });
  assert.deepEqual(await api.issue(entry, 'normal'), binding);
  assert.equal((seen[0].init?.headers as Record<string,string>)['X-CSRF-Token'], 'csrf');
  assert.deepEqual(JSON.parse(seen[0].init?.body as string), { mapId: 'map', revisionId: 'revision', difficulty: 'normal' });
  wrong = true; await assert.rejects(api.issue(entry, 'normal'), /different map configuration/);
});

test('saved-run enumeration preserves retired entries and isolates corrupt saves', () => {
  const storage = memory(); const store = new LocalRunStore(storage);
  const save: CatalogSave = { version: 1, context: runContext, state: {}, sessionId: 'session', remainingLives: 3, savedAt: '2026-01-02' };
  store.put('older-revision', save); storage.setItem('konkr.community.save.v1:broken', '{bad');
  assert.equal(store.saves().length, 2); assert.deepEqual(store.saves()[0].save?.context.binding, binding); assert.equal(store.saves()[1].save, null);
  assert.equal(storage.getItem('konkr.community.save.v1:broken'), '{bad');
});

declare global { interface Window {
  resultsBrowser: { maps: Awaited<ReturnType<typeof installCustomMaps>>; results: ReturnType<typeof createResultsController>; store: LocalRunStore; archived: boolean; errors: string[] };
} }

test('browser queues offline victories, resumes archived saves, retries after reload and keeps the same URL', { timeout: 120_000 }, async t => {
  await prepareRuntime();
  const corpus = JSON.parse(await readFile(path.join(communityRoot, 'tests/fixtures/base-cases.json'), 'utf8'));
  const fixture = corpus.cases.find((item: { id: string }) => item.id === 'tiny-win-normal');
  const parsed = parseMap(fixture.encodedMap);
  const actualEntry: CatalogEntry = { ...entry, map: { ...entry.map, metadata: { ...entry.map.metadata, title: 'Saved island' } }, revision: { ...entry.revision, contentHash: parsed.contentHash, engineHash: corpus.engineHash, width: parsed.width, height: parsed.height } };
  let issuanceFails = true; let submissionFails = true; let issueCount = 0; let storedBody: string | null = null; let result: PublicRunStatus | null = null;
  const serverBinding: RunBinding = { ...binding, mapHash: parsed.contentHash, engineHash: corpus.engineHash, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() };
  const posted: string[] = [];
  const addon = await build({ stdin: { contents: `
    import {installCustomMaps} from './web/custom-maps.ts';
    import {LocalRunStore} from './web/local-runs.ts';
    import {createResultsApi,createResultsController,mountResults} from './web/results.ts';
    import {attachRunRecorder} from './runtime/recording.ts';
    const entry=${JSON.stringify(actualEntry)};
    const probe=window.resultsBrowser={archived:sessionStorage.getItem('archived')==='yes',errors:[]};
    probe.store=new LocalRunStore(localStorage);
    probe.results=createResultsController({api:createResultsApi({csrfToken:async()=> 'test-csrf'}),store:probe.store,pollIntervalMs:100,onError:error=>probe.errors.push(error.message)});
    const reader={async list(){return {entries:probe.archived?[]:[entry],total:probe.archived?0:1}},async get(){return probe.archived?null:entry}};
    const root=document.createElement('main');root.id='community-panel';document.body.append(root);
    probe.maps=await installCustomMaps({root,engineHash:${JSON.stringify(corpus.engineHash)},reader,store:probe.store,loadMap:async()=>${JSON.stringify(fixture.encodedMap)},onStart:probe.results.onStart,onError:error=>probe.errors.push(error.message),
      renderExtras:container=>mountResults(container,{controller:probe.results,store:probe.store,reader,resumeSaved:save=>probe.maps.resumeSaved(save)})});
    window.communityReference.withEngine(loader=>attachRunRecorder({loader,bridge:probe.maps.bridge,onError:error=>probe.errors.push(error.message),onVictory:probe.results.enqueue}));
  `, loader: 'ts', resolveDir: communityRoot }, bundle: true, write: false, format: 'esm', target: 'es2023', platform: 'browser' });
  const css = await readFile(path.join(communityRoot, 'web/catalog.css'), 'utf8') + await readFile(path.join(communityRoot, 'web/results.css'), 'utf8');
  const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.xml': 'text/xml', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.css': 'text/css' };
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://local').pathname;
      if (pathname === '/api/runs' || pathname.startsWith('/api/runs/')) {
        response.setHeader('Content-Type', 'application/json');
        const chunks = []; for await (const chunk of request) chunks.push(chunk); const body = Buffer.concat(chunks).toString();
        if (request.method === 'POST' && request.headers['x-csrf-token'] !== 'test-csrf') { response.writeHead(403).end(JSON.stringify({ error: 'CSRF' })); return; }
        if (pathname === '/api/runs') { issueCount++; response.writeHead(issuanceFails ? 503 : 201).end(JSON.stringify(issuanceFails ? { error: 'Run server unavailable' } : { binding: serverBinding })); return; }
        if (pathname.endsWith('/submission')) {
          posted.push(body); if (submissionFails) { response.writeHead(503).end(JSON.stringify({ error: 'Offline fixture' })); return; }
          if (storedBody && storedBody !== body) { response.writeHead(409).end(JSON.stringify({ error: 'Changed body' })); return; }
          storedBody = body; result ??= { status: 'pending', runId: 'run' }; response.writeHead(result.status === 'pending' ? 202 : 200).end(JSON.stringify(result)); return;
        }
        response.end(JSON.stringify({ binding: serverBinding, result })); return;
      }
      if (pathname === '/results-addon.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(addon.outputFiles[0].contents); return; }
      if (pathname === '/community.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); return; }
      const file = path.resolve(generatedRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(generatedRoot + path.sep)) throw new Error('Bad path'); response.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
      const data = await readFile(file); response.end(pathname === '/' ? data.toString().replace('</head>', '<link rel="stylesheet" href="community.css"><script type="module" src="results-addon.js"></script></head>') : data);
    } catch { response.writeHead(404).end('Not found'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert(address && typeof address !== 'string'); const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] }); t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 375, height: 812 } }); const external: string[] = [];
  await context.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
  const page = await context.newPage(); page.setDefaultTimeout(15_000); const failures: string[] = []; page.on('pageerror', error => failures.push(error.message));
  const url = `${origin}/?community=1#unchanged`; await page.goto(url); await page.waitForFunction(() => !!window.resultsBrowser?.maps);
  const open = async () => { await page.getByRole('button', { name: 'Custom Maps', exact: true }).click(); await page.getByRole('heading', { name: 'Custom Maps', exact: true }).waitFor(); };
  const ready = () => page.waitForFunction(() => window.communityReference.inspect().screen === 'Play' && !window.resultsBrowser.maps.bridge.isBusy() && window.communityReference.withEngine(load => !load(55151).app.navigator.transitionInProgress && load(55151).app.scene.play.mode.name === 'Play'));
  await open(); await page.getByRole('button', { name: 'Saved island', exact: true }).click(); await page.getByRole('button', { name: 'Play map', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'could not be started' }).waitFor(); assert.equal(await page.evaluate(() => window.resultsBrowser.maps.bridge.current()), null);
  issuanceFails = false; await page.getByRole('button', { name: 'Play map', exact: true }).click(); await ready();
  assert.equal(await page.evaluate(() => [...Array(localStorage.length)].map((_, i) => localStorage.key(i)).some(key => key?.startsWith('konkr.community.issued.v1:'))), true);
  await page.evaluate(() => { window.communityReference.play('MovePawn', { pawnId: 3, destinationHexId: 203, tapUnit: false }); window.resultsBrowser.archived = true; sessionStorage.setItem('archived', 'yes'); window.communityReference.act('ExitLevel'); });
  await page.getByRole('heading', { name: 'Custom Maps', exact: true }).waitFor();
  await page.getByText('Saved games and results', { exact: true }).click();
  await page.getByText('This map is no longer in the catalog. Your saved revision can still be resumed.').waitFor();
  await page.getByRole('button', { name: 'Resume saved game' }).click(); await ready(); assert.equal(issueCount, 2);
  await page.evaluate(() => window.communityReference.play('MovePawn', { pawnId: 3, destinationHexId: 303, tapUnit: false }));
  await page.waitForFunction(() => window.communityReference.inspect().screen === 'Victory' && window.communityReference.withEngine(load => !load(55151).app.navigator.transitionInProgress));
  await page.waitForFunction(() => !!window.resultsBrowser.results.snapshot()[0]?.problem);
  await page.evaluate(() => window.communityReference.act('Escape'));
  await page.getByRole('heading', { name: 'Custom Maps', exact: true }).waitFor();
  await page.getByText(/recording is saved; retry when connected/).waitFor();
  const original = await page.evaluate(() => window.resultsBrowser.store.pending()[0].submission);
  await page.reload(); await page.waitForFunction(() => !!window.resultsBrowser?.maps); await open();
  await page.locator('.community-results summary').click(); await page.getByRole('button', { name: 'Retry result' }).waitFor();
  submissionFails = false; await page.getByRole('button', { name: 'Retry result' }).click();
  await page.getByText('Local win recorded. Server verification pending.').waitFor();
  result = { status: 'verified', outcome: 'victory', turns: 1, finalStateHash: 'b'.repeat(64) };
  await page.getByText('Verified victory · 1 turn.').waitFor();
  assert(posted.length >= 2); assert(posted.every(body => JSON.stringify(JSON.parse(body)) === JSON.stringify(original)));
  assert.equal(page.url(), url); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (process.env.KONKR_RESULTS_SCREENSHOT) await page.screenshot({ path: process.env.KONKR_RESULTS_SCREENSHOT });
  assert.deepEqual(external, []); assert.deepEqual(failures, []); assert.deepEqual(await page.evaluate(() => window.communityReference.errors), []);
});
