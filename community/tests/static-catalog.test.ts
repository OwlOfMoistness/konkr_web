import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { collectMaps } from '../scripts/collect-maps.ts';
import { decodeKonkrData, parseCuratedMap, parseMap } from '../engine/map-format.ts';
import { createStaticCatalogReader } from '../web/static-catalog.ts';

const directory = new URL('../../community maps/', import.meta.url);
const encode = (state: unknown) => 'konkrmap.v7.' + Buffer.from(JSON.stringify(state)).toString('base64');

test('the curated folder produces a deterministic catalogue with all supplied maps unchanged', async () => {
  const { fileURLToPath } = await import('node:url');
  const catalog = await collectMaps(fileURLToPath(directory), 'pinned-engine');
  assert.ok(catalog.entries.length >= 17);
  assert.deepEqual(catalog, await collectMaps(fileURLToPath(directory), 'pinned-engine'));
  const twin = catalog.entries.find(entry => entry.map.metadata.title === 'Twin Continents')!;
  assert.deepEqual([twin.revision.width, twin.revision.height], [16, 13]);
  assert.equal(catalog.maps[twin.revision.contentHash], await readFile(new URL('twin-continents.konkr', directory), 'utf8'));
  for (const entry of catalog.entries) {
    assert.equal(entry.map.currentRevisionId, entry.revision.id);
    assert.equal(parseCuratedMap(catalog.maps[entry.revision.contentHash]).contentHash, entry.revision.contentHash);
    assert.deepEqual(entry.scores, []);
  }
});

test('static search, tag filters, sorting and pagination need no backend or scores', async () => {
  const { fileURLToPath } = await import('node:url');
  const catalog = await collectMaps(fileURLToPath(directory), 'engine');
  const reader = createStaticCatalogReader(catalog);
  const twin = await reader.list({ search: 'tWiN', limit: 1 });
  assert.equal(twin.total, 1); assert.equal(twin.entries[0].map.metadata.title, 'Twin Continents');
  assert.deepEqual(await reader.get(twin.entries[0].map.id), twin.entries[0]);
  assert.equal(await reader.get('unknown'), null);
  const zombies = await reader.list({ tags: ['#zombies'], difficulty: 'hard' });
  assert.ok(zombies.total >= 3);
  assert.ok(zombies.entries.every(entry => entry.map.metadata.tags.includes('zombies')));
  const all = await reader.list({ sort: 'name', limit: 100 });
  assert.deepEqual((await reader.list({ sort: 'name', offset: 2, limit: 2 })).entries, all.entries.slice(2, 4));
  twin.entries[0].map.metadata.title = 'Mutated copy';
  assert.equal((await reader.get(twin.entries[0].map.id))!.map.metadata.title, 'Twin Continents');
});

test('curated native features do not widen the backend validator or allow executable fields', async () => {
  for (const file of ['apocalypse now2.konkr', 'cosmic-rift-2.konkr', 'ankhten2-3(1).konkr']) {
    const encoded = await readFile(new URL(file, directory), 'utf8');
    assert.doesNotThrow(() => parseCuratedMap(encoded));
    assert.throws(() => parseMap(encoded));
  }
  const state: any = decodeKonkrData(await readFile(new URL('prison.konkr', directory), 'utf8'));
  state.map.winConditions = [{ type: 'execute-script', code: 'alert(1)' }];
  assert.throws(() => parseCuratedMap(encode(state)), /win condition/);
  delete state.map.winConditions;
  state.factions[2].persona = 'arbitrary-code';
  assert.throws(() => parseCuratedMap(encode(state)), /support review/);
  delete state.factions[2].persona;
  state.map.script = 'alert(1)';
  assert.throws(() => parseCuratedMap(encode(state)), /Unsupported map field/);
});

test('metadata edits preserve revision identity; changed bytes, duplicate IDs and bad metadata are detected', async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'konkr-static-maps-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const encoded = await readFile(new URL('prison.konkr', directory), 'utf8');
  await writeFile(path.join(temp, 'map.konkr'), encoded);
  const original = (await collectMaps(temp, 'engine')).entries[0];
  await writeFile(path.join(temp, 'map.json'), JSON.stringify({ title: 'Edited title', tags: ['#Xmas'], added: '2026-09-29' }));
  const edited = (await collectMaps(temp, 'engine')).entries[0];
  assert.equal(edited.map.id, original.map.id);
  assert.equal(edited.revision.id, original.revision.id);
  assert.deepEqual(edited.map.metadata.tags, ['xmas']);
  const state: any = decodeKonkrData(encoded); state.map.name = 'Changed map';
  await writeFile(path.join(temp, 'map.konkr'), encode(state));
  assert.notEqual((await collectMaps(temp, 'engine')).entries[0].revision.id, original.revision.id);
  await writeFile(path.join(temp, 'duplicate.konkr'), encoded);
  await assert.rejects(collectMaps(temp, 'engine'), /duplicate map ID/);
  await rm(path.join(temp, 'duplicate.konkr'));
  await writeFile(path.join(temp, 'map.json'), JSON.stringify({ script: 'unreviewed' }));
  await assert.rejects(collectMaps(temp, 'engine'), /Unknown metadata field/);
  await rm(path.join(temp, 'map.json'));
  await writeFile(path.join(temp, 'orphan.json'), '{}');
  await assert.rejects(collectMaps(temp, 'engine'), /no matching map/);
});
