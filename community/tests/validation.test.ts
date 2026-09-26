import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sha256, ADAPTER_VERSION, PINNED_RELEASE } from '../engine/platform.ts';
import { parseMap } from '../engine/map-format.ts';
import { gameplayState } from '../engine/adapter.ts';
import { runtimeLevelId } from '../shared/runtime-identity.ts';
import { NodeSimulationAdapter, validateInWorker } from '../engine/validate.ts';
import type { ValidatorOptions } from '../engine/validate.ts';
import type { PlayerDecision, ValidationInput } from '../shared/contracts.ts';

function map(options: { defeat?: boolean; surrender?: boolean; coins?: number } = {}): string {
  const own = options.surrender ? Array.from({ length: 5 }, (_, y) => Array.from({ length: 5 }, (_, x) => (y + 1) * 100 + x + 1)).flat().filter(hex => hex !== 504 && hex !== 505) : [202, 203, 302];
  const enemy = options.surrender ? [504, 505] : [303, 304, 403];
  const enemyTown = options.surrender ? 505 : 303;
  return 'konkrmap.v7.' + Buffer.from(JSON.stringify({
    version: 7, map: { levelId: 'community-validation', width: 7, height: 7, plugins: [] },
    regions: [{ id: 1, name: 'West', hexes: own }, { id: 2, name: 'East', hexes: enemy }],
    factions: [{ id: 0, name: 'Nature', themeIndex: 0, controller: 'none', regions: [] },
      { id: 1, name: 'Player', themeIndex: 0, controller: 'local-user', regions: [1] },
      { id: 2, name: 'Rival', themeIndex: 1, controller: 'ai', regions: [2] }],
    pawns: [{ id: 1, type: 'town', hex: 202 }, { id: 2, type: 'town', hex: enemyTown },
      { id: 3, type: 'knight', hex: options.defeat ? 304 : options.surrender ? 403 : 302 },
      { id: 4, type: 'coins', hex: 202, count: options.coins ?? (options.surrender ? 200 : 10) },
      { id: 5, type: 'coins', hex: enemyTown, count: options.defeat ? 100 : 10 }],
    currentPhase: { type: 'faction-turn', turnNumber: 1, faction: 1, tappedUnits: [] }, hexHistory: {},
  })).toString('base64');
}
function input(canonicalMap: string, decisions: PlayerDecision[] = [], difficulty: 'normal' | 'hard' = 'hard'): ValidationInput {
  return { canonicalMap, decisions, binding: { id: 'run', mapId: 'map', revisionId: 'rev_1', mapHash: sha256(canonicalMap),
    engineHash: PINNED_RELEASE.mainHash, adapterVersion: ADAPTER_VERSION, difficulty, plugins: [],
    issuedAt: '2026-09-26T00:00:00Z', expiresAt: '2026-10-26T00:00:00Z' } };
}
const options: ValidatorOptions = { policy: { version: 1, configurations: ['normal', 'hard'].map(difficulty => ({
  engineHash: PINNED_RELEASE.mainHash, difficulty: difficulty as 'normal' | 'hard', plugins: [], evidence: 'isolated test fixture only',
})) }, sourceOptions: process.env.KONKR_REFERENCE_ROOT ? { repositoryRoot: process.env.KONKR_REFERENCE_ROOT } : {} };

for (const difficulty of ['normal', 'hard'] as const) {
  test(`validates a complete legal ${difficulty} win without a client score`, async () => {
    const result = await new NodeSimulationAdapter(options).validate(input(map(), [{ kind: 'move', pawnId: 3, destinationHexId: 303 }], difficulty));
    assert.equal(result.status, 'verified');
    if (result.status === 'verified') { assert.equal(result.turns, 1); assert.match(result.finalStateHash, /^[a-f0-9]{64}$/); }
  });
  test(`distinguishes ${difficulty} defeat from valid unfinished play`, async () => {
    assert.deepEqual(await validateInWorker(input(map(), [], difficulty), options), { status: 'non-winning', outcome: 'unfinished', turns: 1 });
    assert.deepEqual(await validateInWorker(input(map({ defeat: true }), [{ kind: 'end-turn' }], difficulty), options), { status: 'non-winning', outcome: 'defeat', turns: 1 });
  });
}

test('accepts only a genuine offered surrender', async () => {
  const decision: PlayerDecision[] = [{ kind: 'accept-surrender' }];
  assert.deepEqual(await validateInWorker(input(map(), decision), options), { status: 'invalid', code: 'surrender-not-offered', decisionIndex: 0 });
  assert.equal((await validateInWorker(input(map({ surrender: true }), decision), options)).status, 'verified');
});

test('rejects opposing ownership, unsupported purchases, unaffordable buys and off-map moves', async () => {
  for (const decision of [
    { kind: 'move', pawnId: 2, destinationHexId: 202 },
    { kind: 'buy', pawnType: 'knight', destinationHexId: 203, buyerRegionId: 1 },
    { kind: 'buy', pawnType: 'present', destinationHexId: 203, buyerRegionId: 1 },
    { kind: 'buy', pawnType: 'villager', destinationHexId: 403, buyerRegionId: 2 },
    { kind: 'move', pawnId: 3, destinationHexId: 9090 },
  ] as PlayerDecision[]) assert.equal((await validateInWorker(input(map(), [decision]), options)).status, 'invalid');
});

test('uses real prices and consumes treasury across consecutive legitimate purchases', async () => {
  const one: PlayerDecision = { kind: 'buy', pawnType: 'villager', destinationHexId: 203, buyerRegionId: 1 };
  assert.equal((await validateInWorker(input(map(), [one]), options)).status, 'non-winning');
  assert.deepEqual(await validateInWorker(input(map(), [one, one]), options), { status: 'invalid', code: 'insufficient-funds', decisionIndex: 1 });
});

test('a legal nonterminal conquest exhausts the unit before a second conquest', async () => {
  for (const difficulty of ['normal', 'hard'] as const) {
    const decisions: PlayerDecision[] = [{ kind: 'move', pawnId: 3, destinationHexId: 304 },
      { kind: 'move', pawnId: 3, destinationHexId: 303 }];
    assert.equal((await validateInWorker(input(map(), decisions.slice(0, 1), difficulty), options)).status, 'non-winning');
    assert.deepEqual(await validateInWorker(input(map(), decisions, difficulty), options),
      { status: 'invalid', code: 'pawn-not-movable', decisionIndex: 1 });
  }
});

test('refuses tap flags, privileged native commands, trailing commands and changed bindings', async () => {
  for (const decision of [
    { kind: 'move', pawnId: 3, destinationHexId: 303, tapUnit: false },
    { kind: 'SpawnUnits', factionId: 1 }, { kind: 'end-turn', snapshot: {} },
  ]) assert.equal((await validateInWorker(input(map(), [decision as PlayerDecision]), options)).status, 'invalid');
  assert.deepEqual(await validateInWorker(input(map(), [{ kind: 'move', pawnId: 3, destinationHexId: 303 }, { kind: 'end-turn' }]), options),
    { status: 'invalid', code: 'decision-after-game-over', decisionIndex: 1 });
  const changed = input(map()); changed.binding.mapHash = '0'.repeat(64);
  assert.deepEqual(await validateInWorker(changed, options), { status: 'invalid', code: 'map-binding-mismatch' });
  const newer = input(map()); newer.binding.adapterVersion = 'future-adapter';
  assert.deepEqual(await validateInWorker(newer, options), { status: 'unsupported', code: 'engine-version' });
  assert.deepEqual(await validateInWorker(input(map()), { ...options, policy: { version: 1, configurations: [] } }), { status: 'unsupported', code: 'configuration-not-reviewed' });
});

test('separates deterministic simulation limits and worker deadlines from invalid play', async () => {
  const run = input(map(), [{ kind: 'end-turn' }]);
  assert.deepEqual(await validateInWorker(run, { ...options, limits: { maxTurns: 1 } }), { status: 'unsupported', code: 'turn-limit' });
  assert.deepEqual(await new NodeSimulationAdapter({ ...options, timeoutMs: 1 }).validate(run), { status: 'error', code: 'simulation-timeout', retryable: true });
});

test('reconstructs genuine browser traces through the public worker boundary', async () => {
  const fixturePath = process.env.KONKR_REFERENCE_FIXTURES ?? new URL('fixtures/base-cases.json', import.meta.url);
  const corpus = JSON.parse(await readFile(fixturePath, 'utf8'));
  assert.equal(corpus.engineHash, PINNED_RELEASE.mainHash);
  let mutatedMultiActionCases = 0;
  for (const fixture of corpus.cases) {
    const parsed = parseMap(fixture.encodedMap);
    const run = input(fixture.encodedMap, fixture.decisions, fixture.difficulty);
    run.binding.plugins = parsed.plugins;
    // This explicitly local test policy must never become deployment approval.
    const validator = new NodeSimulationAdapter({ ...options, policy: { version: 1, configurations: [{
      engineHash: PINNED_RELEASE.mainHash, difficulty: fixture.difficulty, plugins: parsed.plugins, evidence: 'browser fixture test only',
    }] } });
    const result = await validator.validate(run);
    const final = fixture.checkpoints.at(-1).state;
    if (fixture.expected === 'victory') {
      const expectedState = structuredClone(final);
      expectedState.map.levelId = await runtimeLevelId(run.binding);
      assert.deepEqual(result, { status: 'verified', outcome: 'victory', turns: final.currentPhase.turnNumber,
        finalStateHash: sha256(JSON.stringify(gameplayState(expectedState))) }, fixture.id);
    } else {
      assert.deepEqual(result, { status: 'non-winning', outcome: fixture.expected, turns: final.currentPhase.turnNumber }, fixture.id);
    }
    if (fixture.id.startsWith('tiny-buy-win-')) {
      mutatedMultiActionCases++;
      assert.deepEqual(await validator.validate({ ...run, decisions: [...run.decisions].reverse() }),
        { status: 'invalid', code: 'decision-after-game-over', decisionIndex: 1 }, `${fixture.id}: reordered win`);
      const incomplete = { ...run, decisions: run.decisions.slice(0, -1) };
      assert.deepEqual(await validator.validate(incomplete), { status: 'non-winning', outcome: 'unfinished', turns: 1 });
      const enemy = structuredClone(run);
      enemy.decisions[1] = { kind: 'move', pawnId: 2, destinationHexId: 202 };
      assert.deepEqual(await validator.validate(enemy), { status: 'invalid', code: 'pawn-not-movable', decisionIndex: 1 });
      const injected = structuredClone(run);
      injected.decisions[1] = { ...injected.decisions[1], snapshot: final, tapUnit: false } as unknown as PlayerDecision;
      assert.equal((await validator.validate(injected)).status, 'invalid');
      // Internal callers accidentally carrying a client claim cannot turn a
      // cropped, otherwise legal trace into a completed game either.
      const falseClaim = { ...incomplete, claimedOutcome: 'victory', finalSnapshot: final };
      assert.deepEqual(await validator.validate(falseClaim), { status: 'non-winning', outcome: 'unfinished', turns: 1 });
    }
  }
  assert.equal(mutatedMultiActionCases, 2, 'Genuine multi-action wins in both difficulties are required');
});
