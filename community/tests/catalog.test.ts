import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { InMemoryCatalogReader, PostgresCatalogReader, createCatalogRoute, normalizeCatalogQuery, parseCatalogQuery } from '../api/catalog.ts';
import { defaultCatalogState, restoreCatalogState } from '../web/catalog.ts';
import type { CatalogEntry, SupportedConfigurations } from '../shared/contracts.ts';

const policy: SupportedConfigurations = { version: 1, configurations: [
  { engineHash: 'engine-1', difficulty: 'normal', plugins: [], evidence: 'catalog-fixture-only' },
  { engineHash: 'engine-1', difficulty: 'hard', plugins: [], evidence: 'catalog-fixture-only' },
  { engineHash: 'engine-1', difficulty: 'hard', plugins: ['spawn-gifts', 'buy-gifts'], evidence: 'catalog-fixture-only' },
] };
function entry(id: string, title = id): CatalogEntry {
  return {
    map: { id, metadata: { title, description: 'A small island worth defending.', creator: 'Community', tags: ['island'] }, state: 'published', currentRevisionId: `${id}-r1`, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', publishedAt: '2026-01-01T00:00:00.000Z' },
    revision: { id: `${id}-r1`, mapId: id, revision: 1, contentHash: `hash-${id}`, objectKey: `maps/${id}`, engineHash: 'engine-1', plugins: [], width: 24, height: 25, createdAt: '2026-01-01T00:00:00.000Z' },
    rating: { average: null, count: 0 }, scores: [], previewUrl: null,
  };
}
function fixtures(): CatalogEntry[] {
  const a = entry('a', 'Prison'); a.map.metadata.tags.push('zombie'); a.rating = { average: 4, count: 2 }; a.scores = [{ difficulty: 'hard', engineHash: 'engine-1', completions: 7, bestTurns: 12 }, { difficulty: 'normal', engineHash: 'engine-1', completions: 9, bestTurns: 5 }];
  const b = entry('b', 'Escalating Quickly'); b.revision.plugins = ['spawn-gifts', 'buy-gifts']; b.map.metadata.tags.push('xmas'); b.rating = { average: 5, count: 1 }; b.map.publishedAt = '2026-02-01T00:00:00.000Z';
  const c = entry('c', 'Prison'); c.map.metadata.tags.push('zombie'); c.rating = { average: 4, count: 2 };
  const draft = entry('draft'); draft.map.state = 'draft';
  const archived = entry('archived'); archived.map.state = 'archived';
  const unsupported = entry('unsupported'); unsupported.revision.plugins = ['zombies'];
  const reversed = entry('reversed'); reversed.revision.plugins = ['buy-gifts', 'spawn-gifts'];
  const anotherEngine = entry('another-engine'); anotherEngine.revision.engineHash = 'engine-2';
  return [c, draft, b, archived, a, unsupported, reversed, anotherEngine];
}

describe('catalog query boundary', () => {
  it('normalizes tags and rejects unexpected, repeated or oversized input', () => {
    assert.deepEqual(normalizeCatalogQuery({ tags: ['#Xmas', 'xmas'], search: ' Prison ' }).tags, ['xmas']);
    for (const query of ['sort=rating;drop table maps', 'limit=0', 'limit=101', 'offset=-1', 'offset=1.2', 'difficulty=easy', 'search=a&search=b', 'unknown=1', 'tag=%3Cscript%3E']) assert.throws(() => parseCatalogQuery(new URLSearchParams(query)));
  });
  it('filters publication, exact plugin order, title and all selected tags', async () => {
    const reader = new InMemoryCatalogReader(fixtures(), policy, { verifiedResultsEnabled: true });
    assert.equal((await reader.list({})).total, 3);
    assert.deepEqual((await reader.list({ search: 'pRiSoN', tags: ['#Zombie', 'island'], sort: 'name' })).entries.map(e => e.map.id), ['a', 'c']);
    assert.equal((await reader.list({ difficulty: 'normal' })).total, 2);
    for (const id of ['draft', 'archived', 'unsupported', 'reversed', 'another-engine']) assert.equal(await reader.get(id), null);
    assert.equal((await new InMemoryCatalogReader(fixtures(), { version: 1, configurations: [] }).list({})).total, 0);
  });
  it('uses stable tie breakers for pagination and separates score difficulties', async () => {
    const reader = new InMemoryCatalogReader(fixtures(), policy, { verifiedResultsEnabled: true });
    for (const sort of ['name', 'rating', 'completions', 'newest'] as const) {
      const full = await reader.list({ sort });
      const pages = await Promise.all([0, 1, 2].map(offset => reader.list({ sort, offset, limit: 1 })));
      assert.deepEqual(pages.flatMap(page => page.entries.map(e => e.map.id)), full.entries.map(e => e.map.id));
    }
    assert.deepEqual((await reader.list({ difficulty: 'hard', sort: 'completions' })).entries[0].scores.map(s => s.difficulty), ['hard']);
    assert.deepEqual((await new InMemoryCatalogReader(fixtures(), policy).get('a'))!.scores, []);
  });
  it('routes only public GETs with honest errors', async () => {
    const route = createCatalogRoute(new InMemoryCatalogReader(fixtures(), policy));
    assert.equal((await route(new Request('http://local/api/maps/draft')))!.status, 404);
    assert.equal((await route(new Request('http://local/api/maps?limit=no')))!.status, 400);
    assert.equal((await route(new Request('http://local/api/maps', { method: 'POST' })))!.status, 405);
    assert.equal(await route(new Request('http://local/other')), null);
    const response = (await route(new Request('http://local/api/maps')))!;
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).total, 3);
  });
  it('restores bounded UI state without trusting corrupt storage', () => {
    const state = { ...defaultCatalogState(), tags: ['zombie'], search: 'Prison', view: 'list', scrollTop: 300, detailId: 'a' };
    assert.deepEqual(restoreCatalogState(JSON.stringify(state)), state);
    assert.deepEqual(restoreCatalogState('oops'), defaultCatalogState());
    assert.equal(restoreCatalogState(JSON.stringify({ ...state, offset: -50, detailId: '<img>' })).offset, 0);
    assert.equal(restoreCatalogState(JSON.stringify({ ...state, detailId: '<img>' })).detailId, null);
  });
});

const databaseUrl = process.env.CATALOG_TEST_DATABASE_URL;
describe('catalog PostgreSQL integration', { skip: !databaseUrl }, () => {
  let admin: Pool;
  let db: Pool;
  const schema = `catalog_test_${process.pid}`;
  before(async () => {
    admin = new Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 });
    await db.query(await readFile(new URL('../db/001-catalog.sql', import.meta.url), 'utf8'));
    for (const item of fixtures()) {
      await db.query('INSERT INTO maps(id,title,description,creator,tags,state,created_at,updated_at,published_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [item.map.id, item.map.metadata.title, item.map.metadata.description, item.map.metadata.creator, item.map.metadata.tags, 'draft', item.map.createdAt, item.map.updatedAt, item.map.publishedAt]);
      await db.query('INSERT INTO map_revisions(id,map_id,revision,content_hash,object_key,engine_hash,plugins,width,height) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [item.revision.id, item.map.id, 1, item.revision.contentHash, item.revision.objectKey, item.revision.engineHash, item.revision.plugins, 24, 25]);
      await db.query('UPDATE maps SET current_revision_id=$1,state=$2 WHERE id=$3', [item.revision.id, item.map.state, item.map.id]);
      for (let index = 0; index < item.rating.count; index++) await db.query('INSERT INTO map_ratings(revision_id,browser_token_hash,rating) VALUES($1,$2,$3)', [item.revision.id, `token${index}`, item.rating.average]);
      for (const score of item.scores) await db.query('INSERT INTO map_score_buckets(revision_id,difficulty,engine_hash,completions,best_turns) VALUES($1,$2,$3,$4,$5)', [item.revision.id, score.difficulty, score.engineHash, score.completions, score.bestTurns]);
    }
  });
  after(async () => { await db?.end(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } });
  it('matches fixture repository sorting/filtering and empty-page totals', async () => {
    const memory = new InMemoryCatalogReader(fixtures(), policy, { verifiedResultsEnabled: true });
    const pg = new PostgresCatalogReader(db, policy, { verifiedResultsEnabled: true });
    for (const query of [{}, { search: 'PRISON' }, { tags: ['#xmas'] }, { tags: ['island', 'zombie'] }, { difficulty: 'normal' as const }, { difficulty: 'hard' as const }, { offset: 100 }]) {
      for (const sort of ['name', 'rating', 'completions', 'newest'] as const) {
        const expected = await memory.list({ ...query, sort });
        const actual = await pg.list({ ...query, sort });
        assert.equal(actual.total, expected.total);
        assert.deepEqual(actual.entries.map(e => [e.map.id, e.rating, e.scores]), expected.entries.map(e => [e.map.id, e.rating, [...e.scores].sort((a, b) => a.difficulty.localeCompare(b.difficulty))]));
      }
    }
    for (const id of ['draft', 'archived', 'unsupported', 'reversed', 'another-engine']) assert.equal(await pg.get(id), null);
  });
  it('keeps SQL metacharacters as literal search data and gates results', async () => {
    const pg = new PostgresCatalogReader(db, policy);
    for (const search of ["'; DROP TABLE maps; --", '%', '_']) assert.equal((await pg.list({ search })).total, 0);
    assert.equal((await pg.list({})).total, 3);
    assert.deepEqual((await pg.get('a'))!.scores, []);
    assert.equal(await pg.get("a' OR 1=1 --"), null);
    assert.equal((await new PostgresCatalogReader(db, { version: 1, configurations: [] }).list({})).total, 0);
  });
  it('protects immutable revisions and map/revision ownership while allowing a derived preview', async () => {
    await assert.rejects(db.query("UPDATE map_revisions SET width=30 WHERE id='a-r1'"), /immutable/);
    await assert.rejects(db.query("DELETE FROM map_revisions WHERE id='a-r1'"), /retained/);
    await assert.rejects(db.query("UPDATE maps SET current_revision_id='b-r1' WHERE id='a'"), /foreign key/);
    await db.query("UPDATE map_revisions SET preview_key='previews/a.png' WHERE id='a-r1'");
    const pg = new PostgresCatalogReader(db, policy, { previewUrl: key => `/media/${key}` });
    assert.equal((await pg.get('a'))!.previewUrl, '/media/previews/a.png');
  });
});

describe('catalog browser experience', () => {
  it('preserves filters/view/scroll across details, play and reload on one URL; fits small screens', async () => {
    const records = Array.from({ length: 55 }, (_, index) => {
      const item = entry(`map-${String(index).padStart(2, '0')}`, `Island ${String(index).padStart(2, '0')}`);
      item.map.metadata.tags = [index % 2 ? 'zombie' : 'xmas']; return item;
    });
    records[1].map.metadata.description = '<img src=x onerror="window.injected=true">';
    const route = createCatalogRoute(new InMemoryCatalogReader(records, policy));
    const source = `import { mountCatalog, createHttpCatalogReader } from ${JSON.stringify(fileURLToPath(new URL('../web/catalog.ts', import.meta.url)))};
      const root = document.querySelector('#catalog');
      const back = document.querySelector('#return');
      window.catalog = mountCatalog(root, {reader:createHttpCatalogReader(), renderPreview:(container)=>{const canvas=document.createElement('canvas');canvas.width=900;canvas.height=675;container.replaceChildren(canvas);return {ready:Promise.resolve(),destroy:()=>canvas.remove()};}, onPlay:async()=>{window.catalog.suspend();root.hidden=true;back.hidden=false;}});
      back.onclick=()=>{root.hidden=false;back.hidden=true;window.catalog.resume();};`;
    const bundle = await build({ stdin: { contents: source, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' }, bundle: true, write: false, format: 'iife', platform: 'browser' });
    const css = await readFile(new URL('../web/theme.css', import.meta.url), 'utf8') + await readFile(new URL('../web/catalog.css', import.meta.url), 'utf8');
    const server = createServer((req, res) => {
      void (async () => {
        if (req.url?.startsWith('/api/')) {
          const response = await route(new Request(`http://localhost${req.url}`));
          res.writeHead(response?.status ?? 404, { 'Content-Type': 'application/json' }); res.end(response ? await response.text() : '{}'); return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}${css}</style><main id="catalog"></main><button id="return" hidden>Return to maps</button><script>${bundle.outputFiles[0].text}</script>`);
      })().catch(error => { res.writeHead(500); res.end(String(error)); });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/`;
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      await page.getByRole('status').filter({ hasText: '55 maps' }).waitFor();
      await page.locator('.catalog-detail h2').filter({ hasText: 'Island 00' }).waitFor();
      assert.equal(await page.locator('[data-map-id="map-00"]').getAttribute('aria-pressed'), 'true');
      for (const width of [320, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `No page overflow at ${width}`);
        assert.equal(await page.locator('#catalog').evaluate(node => node.scrollWidth > node.clientWidth), false, `No catalog overflow at ${width}`);
        const layout = await page.evaluate(() => ({ stage: document.querySelector('.catalog-stage')!.getBoundingClientRect().toJSON(), browser: document.querySelector('.catalog-browser')!.getBoundingClientRect().toJSON() }));
        if (width >= 900) {
          assert.equal(layout.browser.width, 400); assert(layout.stage.right <= layout.browser.left);
          const play = await page.getByRole('button', { name: 'Play map', exact: true }).boundingBox(); assert(play && play.y + play.height <= 900, 'Play stays visible beside the preview');
        }
        else assert(layout.stage.bottom <= layout.browser.top, 'Mobile preview is above map browser');
        if (process.env.CATALOG_SCREENSHOTS && [320, 1440].includes(width)) await page.screenshot({ path: `${process.env.CATALOG_SCREENSHOTS}/catalog-${width}.png` });
      }
      // A later selection during the outgoing animation must supersede the first.
      await page.evaluate(() => {
        (document.querySelector('[data-map-id="map-01"]') as HTMLButtonElement).click();
        (document.querySelector('[data-map-id="map-02"]') as HTMLButtonElement).click();
      });
      await page.getByRole('heading', { name: 'Island 02', exact: true }).waitFor();
      assert.equal(await page.locator('[data-map-id="map-02"]').getAttribute('aria-pressed'), 'true');
      // A post-play rating footer reduces available height on landscape screens.
      await page.locator('#catalog').evaluate(node => { (node as HTMLElement).style.height = 'calc(100dvh - 180px)'; });
      for (const viewport of [{ width: 900, height: 400 }, { width: 1280, height: 500 }]) {
        await page.setViewportSize(viewport);
        const available = await page.locator('#catalog').evaluate(node => node.clientHeight);
        assert.equal(available, viewport.height - 180);
        assert(await page.locator('.catalog-browser-scroll').evaluate(node => node.clientHeight) >= 160, `Map list remains usable at ${viewport.width}×${viewport.height}`);
        await page.getByRole('button', { name: 'Island 02', exact: true }).click();
        await page.getByRole('heading', { name: 'Island 02', exact: true }).waitFor();
        assert.equal(await page.locator('[data-map-id="map-02"]').getAttribute('aria-pressed'), 'true');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.getByLabel('Map name', { exact: true }).fill('');
      }
      await page.locator('#catalog').evaluate(node => { (node as HTMLElement).style.height = ''; });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByLabel('Map name', { exact: true }).fill('Island');
      await page.getByLabel('Tags', { exact: true }).fill('#zombie');
      await page.getByLabel('Tags', { exact: true }).press('Enter');
      await page.getByRole('status').filter({ hasText: '27 maps' }).waitFor();
      await page.getByLabel('Sort by', { exact: true }).selectOption('name');
      await page.getByRole('button', { name: 'List', exact: true }).click();
      await page.locator('.catalog-list').waitFor();
      const chosen = page.getByRole('button', { name: 'Island 25', exact: true });
      await chosen.scrollIntoViewIfNeeded();
      const scroll = await page.locator('.catalog-browser-scroll').evaluate(node => node.scrollTop);
      assert(scroll > 0);
      await chosen.focus();
      await chosen.press('Enter');
      await page.getByRole('heading', { name: 'Island 25', exact: true }).waitFor();
      assert.equal(await page.getByRole('complementary', { name: 'Browse maps' }).isVisible(), true, 'Selection keeps the browser on screen');
      assert.equal(await chosen.getAttribute('aria-pressed'), 'true');
      await page.evaluate(item => document.querySelector('#catalog')!.dispatchEvent(new CustomEvent('community:rating-updated', { detail: item })), { ...records[1], rating: { average: 5, count: 1 } });
      assert.equal(await page.locator('[data-entry-id="map-01"] .catalog-rating').textContent(), '★ 5.0 · 1 rating', 'A post-play rating updates its card while another map is selected');
      assert.equal(await page.locator('.catalog-detail .catalog-rating').textContent(), 'No ratings yet', 'The other selected map keeps its own aggregate');
      await page.evaluate(item => document.querySelector('#catalog')!.dispatchEvent(new CustomEvent('community:rating-updated', { detail: item })), { ...records[1], revision: { ...records[1].revision, id: 'older-revision' }, rating: { average: 1, count: 1 } });
      assert.equal(await page.locator('[data-entry-id="map-01"] .catalog-rating').textContent(), '★ 5.0 · 1 rating', 'Old-revision ratings cannot overwrite current cards');
      await page.waitForFunction(expected => Math.abs(document.querySelector('.catalog-browser-scroll')!.scrollTop - expected) < 2, scroll);
      assert.equal(page.url(), url);
      assert.equal(await page.getByRole('button', { name: '← All maps', exact: true }).isVisible(), false);
      await page.locator('.catalog-list').waitFor();
      await page.waitForFunction(expected => Math.abs(document.querySelector('.catalog-browser-scroll')!.scrollTop - expected) < 2, scroll);
      assert.equal(await page.getByLabel('Tags', { exact: true }).inputValue(), '#zombie');
      assert.equal(await page.getByRole('button', { name: 'List', exact: true }).getAttribute('aria-pressed'), 'true');
      await chosen.click();
      await page.getByRole('heading', { name: 'Island 25', exact: true }).waitFor();
      await page.route('**/api/maps/map-25', route => route.fulfill({ status: 404, body: '{}' }));
      await page.getByRole('button', { name: 'Play map', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'no longer available' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Return to maps', exact: true }).isVisible(), false, 'A withdrawn selection cannot launch');
      await page.unroute('**/api/maps/map-25');
      await page.route('**/api/maps/map-25', route => route.fulfill({ json: { ...records[25], revision: { ...records[25].revision, id: 'changed-revision' } } }));
      await page.getByRole('button', { name: 'Play map', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'has changed' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Return to maps', exact: true }).isVisible(), false, 'A replaced revision requires a fresh selection');
      await page.unroute('**/api/maps/map-25');
      await page.getByRole('button', { name: 'Play map', exact: true }).click();
      await page.getByRole('button', { name: 'Return to maps', exact: true }).click();
      await page.locator('.catalog-list').waitFor();
      assert.equal(page.url(), url);
      await page.reload();
      await page.locator('.catalog-list').waitFor();
      await page.getByRole('heading', { name: 'Island 25', exact: true }).waitFor();
      assert.equal(await page.getByLabel('Tags', { exact: true }).inputValue(), '#zombie');
      await page.getByRole('button', { name: 'Next →', exact: true }).click();
      await page.getByText('Page 2 of 2', { exact: true }).waitFor();
      assert.equal(page.url(), url);
      await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
      await page.setViewportSize({ width: 320, height: 900 });
      await page.getByRole('button', { name: '← All maps', exact: true }).click();
      assert(await page.locator('#catalog').evaluate(node => node.scrollTop) > 0, 'Browse moves to the mobile map list');
      await page.getByRole('button', { name: 'Island 01', exact: true }).click();
      await page.getByRole('heading', { name: 'Island 01', exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector('#catalog')!.scrollTop === 0);
      await page.getByText('<img src=x onerror="window.injected=true">', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => (window as unknown as { injected?: boolean }).injected), undefined);
      await page.getByRole('button', { name: '← All maps', exact: true }).click();
      await page.getByLabel('Map name', { exact: true }).fill('Nothing matches this title');
      await page.getByLabel('Map name', { exact: true }).press('Enter');
      await page.getByText('No maps match these filters. Try another name or remove a tag.', { exact: true }).waitFor();
      await page.route('**/api/maps?**', route => route.fulfill({ status: 503, body: '{}' }));
      await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Check your connection' }).waitFor();
      await page.unroute('**/api/maps?**');
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '55 maps' }).waitFor();
      assert.equal(page.url(), url);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
