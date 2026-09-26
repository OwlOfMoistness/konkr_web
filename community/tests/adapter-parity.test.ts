import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createEngineSession, gameplayState } from '../engine/adapter.ts';
import type { EngineSession } from '../engine/adapter.ts';
import { loadEngineSources, guardMainBundle, sha256 } from '../engine/platform.ts';
import { runtimeLevelId } from '../shared/runtime-identity.ts';
import type { Difficulty, PlayerDecision } from '../shared/contracts.ts';

const repositoryRoot = process.env.KONKR_REFERENCE_ROOT;
const sources = () => loadEngineSources(repositoryRoot ? { repositoryRoot } : {});
const tinyMap = () => 'konkrmap.v7.' + Buffer.from(JSON.stringify({
  version: 7, map: { levelId: 'community-tiny-win', width: 6, height: 6, name: 'Tiny victory', plugins: [] },
  regions: [{ id: 1, name: 'West', hexes: [202, 203, 302] }, { id: 2, name: 'East', hexes: [303, 304, 403] }],
  factions: [{ id: 0, name: 'Nature', themeIndex: 0, controller: 'none', regions: [] },
    { id: 1, name: 'Player', themeIndex: 0, controller: 'local-user', regions: [1] },
    { id: 2, name: 'Rival', themeIndex: 1, controller: 'ai', regions: [2] }],
  pawns: [{ id: 1, type: 'town', hex: 202 }, { id: 2, type: 'town', hex: 303 },
    { id: 3, type: 'knight', hex: 302 }, { id: 4, type: 'coins', hex: 202, count: 10 },
    { id: 5, type: 'coins', hex: 303, count: 10 }],
  currentPhase: { type: 'faction-turn', turnNumber: 1, faction: 1, tappedUnits: [] }, hexHistory: {},
})).toString('base64');

test('refuses a changed release before evaluating its module factories', async () => {
  const pinned = await sources();
  assert.throws(() => guardMainBundle(pinned.main + ';', pinned.mainHash), /checksum/);
});

for (const difficulty of ['normal', 'hard'] as const) {
  test(`original ${difficulty} simulation reports a generated victory and retains fresh-run isolation`, async () => {
    const pinned = await sources();
    const first = createEngineSession(pinned, tinyMap(), difficulty);
    const initial = first.snapshot();
    first.executeInternal('MovePawn', { pawnId: 3, destinationHexId: 303, tapUnit: false });
    assert.deepEqual(first.outcome, { winner: 1, turns: 1 });
    assert.equal(first.snapshot().pawns.some((pawn: { id: number }) => pawn.id === 2), false);
    const second = createEngineSession(pinned, tinyMap(), difficulty);
    assert.deepEqual(second.snapshot(), initial);
    assert.equal(second.outcome, undefined);
    assert.equal(second.loadedModules.includes(9332), false);
    assert.equal(second.loadedModules.includes(65606), false);
  });
}

test('original AI advances an unfinished game back to the player', async () => {
  const session = createEngineSession(await sources(), tinyMap(), 'hard');
  session.executeInternal('EndTurn');
  await session.settleOpponents();
  assert.equal(session.model.currentPhase.faction.id, 1);
  assert.equal(session.model.currentPhase.turnNumber, 2);
  assert.equal(session.outcome, undefined);
});

test('namespaced runtime identity changes only the identity field in a legal trajectory', async () => {
  const pinned = await sources();
  const id = await runtimeLevelId({ mapId: 'catalog-map', revisionId: 'rev_1', engineHash: pinned.engineHash, difficulty: 'hard' });
  const original = createEngineSession(pinned, tinyMap(), 'hard');
  const namespaced = createEngineSession(pinned, tinyMap(), 'hard', { runtimeLevelId: id });
  original.executeInternal('EndTurn'); namespaced.executeInternal('EndTurn');
  await original.settleOpponents(); await namespaced.settleOpponents();
  const actual = namespaced.snapshot();
  assert.equal(actual.map.levelId, id);
  actual.map.levelId = original.snapshot().map.levelId;
  assert.deepEqual(actual, original.snapshot());
});

interface ReferenceCheckpoint {
  afterDecision: number;
  phase: 'initial' | 'player' | 'ai-turn' | 'neutral-turn';
  factionId: number;
  state: Record<string, any>;
  outcome?: { winner: number | null };
}
interface ReferenceCase {
  id: string;
  encodedMap: string;
  difficulty: Difficulty;
  decisions: PlayerDecision[];
  expected: 'victory' | 'defeat' | 'unfinished';
  checkpoints: ReferenceCheckpoint[];
  outcome: { winner: number | null } | null;
  repeatHashes: string[];
}
const fixturePath = process.env.KONKR_REFERENCE_FIXTURES ?? new URL('fixtures/base-cases.json', import.meta.url);
const corpus = async (): Promise<{ version: number; engineHash: string; cases: ReferenceCase[] }> => JSON.parse(await readFile(fixturePath, 'utf8'));

// These trusted reference decisions test engine parity independently of the
// separate authority/legality checks in player-commands.ts.
async function referenceDecision(session: EngineSession, decision: PlayerDecision): Promise<void> {
  switch (decision.kind) {
    case 'move': session.executeInternal('MovePawn', { pawnId: decision.pawnId, destinationHexId: decision.destinationHexId, tapUnit: false }); break;
    case 'buy': session.executeInternal('BuyPawn', { pawnType: decision.pawnType, destinationHexId: decision.destinationHexId, buyerRegionId: decision.buyerRegionId, tapUnit: false }); break;
    case 'end-turn': session.executeInternal('EndTurn'); break;
    case 'accept-surrender': assert.equal(session.surrenderOffered, true); session.executeInternal('AcceptSurrender'); break;
    default: throw new Error('Reference decision requires a new parity contract');
  }
  session.capture('player', 1);
  if (decision.kind === 'end-turn') await session.settleOpponents();
}
function projection(checkpoints: ReferenceCheckpoint[]): ReferenceCheckpoint[] {
  return checkpoints.map(checkpoint => ({ ...checkpoint, state: gameplayState(checkpoint.state) }));
}
function firstDifference(actual: any, expected: any, location = '$'): string | null {
  if (Object.is(actual, expected)) return null;
  if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object') {
    return `${location}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`;
  }
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const key of keys) {
    const difference = firstDifference(actual[key], expected[key], `${location}.${key}`);
    if (difference) return difference;
  }
  return null;
}

test('matches every repeated real-browser player and AI/neutral checkpoint', async (t) => {
  const pinned = await sources();
  const reference = await corpus();
  assert.equal(reference.version, 1);
  assert.equal(reference.engineHash, pinned.engineHash);
  for (const difficulty of ['normal', 'hard']) for (const expected of ['victory', 'defeat', 'unfinished']) {
    assert.ok(reference.cases.some(fixture => fixture.difficulty === difficulty && fixture.expected === expected), `${difficulty} ${expected} fixture missing`);
  }
  for (const fixture of reference.cases) {
    const started = performance.now();
    assert.equal(fixture.repeatHashes.length, 2, `${fixture.id}: repeat evidence missing`);
    assert.equal(fixture.repeatHashes[0], fixture.repeatHashes[1], `${fixture.id}: browser runs diverged`);
    let afterDecision = -1;
    const actual: ReferenceCheckpoint[] = [];
    const session = createEngineSession(pinned, fixture.encodedMap, fixture.difficulty, {
      onCheckpoint(checkpoint) {
        actual.push({ afterDecision, phase: checkpoint.phase, factionId: checkpoint.factionId, state: checkpoint.state,
          ...(checkpoint.outcome ? { outcome: { winner: checkpoint.outcome.winner } } : {}) });
      },
    });
    for (const [index, decision] of fixture.decisions.entries()) { afterDecision = index; await referenceDecision(session, decision); }
    const projected = projection(actual);
    const expected = projection(fixture.checkpoints);
    assert.equal(firstDifference(projected, expected), null, `${fixture.id}: first gameplay difference`);
    const outcome = session.outcome ? { winner: session.outcome.winner } : null;
    assert.deepEqual(outcome, fixture.outcome, `${fixture.id}: outcome differs`);
    assert.equal(sha256(JSON.stringify({ checkpoints: projected, outcome })), fixture.repeatHashes[0], `${fixture.id}: canonical serialization differs`);
    t.diagnostic(`${fixture.id}: ${(performance.now() - started).toFixed(1)} ms; process peak RSS ${Math.ceil(process.resourceUsage().maxRSS / 1024)} MiB`);
  }
});

test('sample-map namespaced identities preserve each reference gameplay trajectory', async () => {
  const pinned = await sources();
  const reference = await corpus();
  const samples = reference.cases.filter(fixture => fixture.id.startsWith('prison-') || fixture.id.startsWith('gifts-'));
  assert.ok(samples.length >= 4, 'Both supplied maps and difficulties are required');
  for (const fixture of samples) {
    const id = await runtimeLevelId({ mapId: 'catalog-map', revisionId: fixture.id, engineHash: pinned.engineHash, difficulty: fixture.difficulty });
    const original = createEngineSession(pinned, fixture.encodedMap, fixture.difficulty);
    const namespaced = createEngineSession(pinned, fixture.encodedMap, fixture.difficulty, { runtimeLevelId: id });
    for (const decision of fixture.decisions) {
      await referenceDecision(original, decision); await referenceDecision(namespaced, decision);
      const actual = namespaced.snapshot();
      assert.equal(actual.map.levelId, id);
      actual.map.levelId = original.snapshot().map.levelId;
      assert.equal(firstDifference(actual, original.snapshot()), null, `${fixture.id}: identity changed gameplay`);
    }
  }
});
