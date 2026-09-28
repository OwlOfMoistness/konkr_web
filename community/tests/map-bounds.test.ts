import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseMap } from '../engine/map-format.ts';
import { createEngineSession } from '../engine/adapter.ts';
import { applyPlayerDecision } from '../engine/player-commands.ts';
import { loadEngineSources, sha256 } from '../engine/platform.ts';

const encode = (state: unknown) => 'konkrmap.v7.' + Buffer.from(JSON.stringify(state)).toString('base64');
const edgeMap = () => ({
  version: 7, map: { levelId: 'edge-map', width: 3, height: 3, plugins: [] },
  regions: [{ id: 1, hexes: [202, 203, 302] }, { id: 2, hexes: [303, 304, 403] }],
  factions: [{ id: 0, controller: 'none', themeIndex: 0, regions: [] },
    { id: 1, controller: 'local-user', themeIndex: 0, regions: [1] },
    { id: 2, controller: 'ai', themeIndex: 1, regions: [2] }],
  pawns: [{ id: 1, type: 'town', hex: 202 }, { id: 2, type: 'town', hex: 303 },
    { id: 3, type: 'knight', hex: 302 }, { id: 4, type: 'coins', hex: 202, count: 30 },
    { id: 5, type: 'coins', hex: 303, count: 10 }],
  currentPhase: { type: 'faction-turn', turnNumber: 1, faction: 1, tappedUnits: [] }, hexHistory: {},
});

test('Twin Continents imports unchanged, retaining land beyond its declared width', async () => {
  const fixture = JSON.parse(await readFile(new URL('fixtures/twin-continents.json', import.meta.url), 'utf8'));
  const encoded = fixture.encodedMap;
  const parsed = parseMap(encoded);
  assert.equal(parsed.encoded, encoded);
  assert.equal(parsed.contentHash, sha256(encoded));
  assert.equal(parsed.contentHash, fixture.sha256);
  assert.deepEqual([parsed.title, parsed.width, parsed.height], ['Twin Continents', 16, 13]);
  for (const difficulty of ['normal', 'hard'] as const) {
    const session = createEngineSession(await loadEngineSources(), encoded, difficulty);
    assert.deepEqual([session.model.map.width, session.model.map.height], [16, 13]);
    const edge = session.model.regions.byHex(session.requireModule(35326).getHex(816));
    assert.equal(edge.id, 25);
    assert.equal(edge.faction.id, 0);
    assert.equal(session.model.regions.all().reduce((count: number, region: any) => count + region.hexes.length, 0), 106);
  }
});

test('land is bounded by the native coordinate domain, without rewriting declared dimensions', () => {
  const state = edgeMap();
  // More land than the nominal rectangle is valid too, within the fixed native grid.
  state.regions[0].hexes.push(0, 99, 9900, 9999, 201, 204, 301, 305, 404, 405);
  assert.deepEqual(parseMap(encode(state)).state, state);
  for (const hex of [-1, 10000, 101.5]) {
    const invalid = edgeMap(); invalid.regions[0].hexes.push(hex);
    assert.throws(() => parseMap(encode(invalid)), /Invalid hex/);
  }
  for (const sameRegion of [true, false]) {
    const duplicate = edgeMap(); duplicate.regions[sameRegion ? 1 : 0].hexes.push(303);
    assert.throws(() => parseMap(encode(duplicate)), /overlapping hex/i);
  }
});

for (const difficulty of ['normal', 'hard'] as const) {
  test(`${difficulty}: legal moves and purchases on land beyond declared dimensions use native rules`, async () => {
    const sources = await loadEngineSources();
    const moving = createEngineSession(sources, encode(edgeMap()), difficulty);
    await applyPlayerDecision(moving, { kind: 'move', pawnId: 3, destinationHexId: 303 });
    assert.deepEqual(moving.outcome, { winner: 1, turns: 1 });
    const buying = createEngineSession(sources, encode(edgeMap()), difficulty);
    await applyPlayerDecision(buying, { kind: 'buy', pawnType: 'villager', buyerRegionId: 1, destinationHexId: 203 });
    assert.ok(buying.snapshot().pawns.some((pawn: any) => pawn.type === 'villager' && pawn.hex === 203));
  });
}

test('destination checks still reject water, coordinates outside the native grid and illegal land moves', async () => {
  const sources = await loadEngineSources();
  for (const destinationHexId of [0, 404, 9999, 10000]) {
    const session = createEngineSession(sources, encode(edgeMap()), 'hard');
    const before = session.snapshot();
    await assert.rejects(applyPlayerDecision(session, { kind: 'move', pawnId: 3, destinationHexId }), { code: 'invalid-destination' });
    await assert.rejects(applyPlayerDecision(session, { kind: 'buy', pawnType: 'villager', buyerRegionId: 1, destinationHexId }), { code: 'invalid-destination' });
    assert.deepEqual(session.snapshot(), before);
  }
  const remote = edgeMap(); remote.regions[1].hexes.push(9090);
  const session = createEngineSession(sources, encode(remote), 'hard');
  await assert.rejects(applyPlayerDecision(session, { kind: 'move', pawnId: 3, destinationHexId: 9090 }), { code: 'illegal-destination' });
});
