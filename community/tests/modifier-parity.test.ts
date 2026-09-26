import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createEngineSession, gameplayState } from '../engine/adapter.ts';
import { loadEngineSources, ADAPTER_VERSION, PINNED_RELEASE, sha256 } from '../engine/platform.ts';
import { applyPlayerDecision } from '../engine/player-commands.ts';
import { NodeSimulationAdapter, validateInWorker } from '../engine/validate.ts';
import { parseMap } from '../engine/map-format.ts';
import { supports } from '../shared/contracts.ts';
import type { Difficulty, PlayerDecision, SupportedConfigurations, ValidationInput } from '../shared/contracts.ts';
import type { Checkpoint, FixtureCorpus, ReferenceCase } from '../scripts/import-fixtures.ts';

const fixtureFile = new URL('fixtures/modifier-cases.json', import.meta.url);
const policyFile = new URL('../shared/supported-configurations.json', import.meta.url);
const plugins = ['spawn-gifts', 'buy-gifts'];
interface ModifierCorpus {
  version: 1;
  engineHash: string;
  browserVersion: string;
  plugins: string[];
  comparison: string;
  sourceMapHash: string;
  cases: ReferenceCase[];
}

// Reproduction uses the original browser UI phase flow. It is opt-in because it
// writes this task's fixture artifact; ordinary tests consume committed evidence.
async function captureModifiers(): Promise<void> {
  const { referenceHarness, captureCase, gameplayProjection, hash } = await import('../scripts/import-fixtures.ts');
  const base: FixtureCorpus = JSON.parse(await readFile(new URL('fixtures/base-cases.json', import.meta.url), 'utf8'));
  const source = base.cases.find(entry => entry.id === 'gifts-two-turns-hard');
  assert.ok(source, 'Missing supplied Escalating Quickly reference');
  assert.deepEqual(parseMap(source.encodedMap).plugins, plugins);
  const harness = await referenceHarness();
  try {
    assert.equal(harness.browser.version(), base.browserVersion);
    const corpus: ModifierCorpus = { version: 1, engineHash: base.engineHash, browserVersion: base.browserVersion, plugins,
      comparison: 'Raw checkpoints retained; comparisons omit only generated regions[].name, preserving all other fields and array order.',
      sourceMapHash: parseMap(source.encodedMap).contentHash, cases: [] };
    for (const difficulty of ['normal', 'hard'] as const) {
      const spec = { id: `gift-purchase-and-spawning-${difficulty}`, encodedMap: source.encodedMap, difficulty,
        decisions: [{ kind: 'buy', pawnType: 'present', destinationHexId: 704, buyerRegionId: 16 },
          { kind: 'end-turn' }, { kind: 'end-turn' }] as PlayerDecision[], expected: 'unfinished' as const };
      const first = await captureCase(harness.browser, harness.baseURL, spec);
      const second = await captureCase(harness.browser, harness.baseURL, spec);
      assert.deepEqual(gameplayProjection(second.checkpoints), gameplayProjection(first.checkpoints));
      assert.deepEqual(second.outcome, first.outcome);
      corpus.cases.push({ ...first,
        repeatHashes: [first, second].map(run => hash({ checkpoints: gameplayProjection(run.checkpoints), outcome: run.outcome })),
        rawRepeatHashes: [hash(first.checkpoints), hash(second.checkpoints)] });
    }
    await writeFile(fixtureFile, JSON.stringify(corpus, null, 2) + '\n');
  } finally { await harness.close(); }
}
if (process.env.KONKR_CAPTURE_MODIFIERS === '1') await captureModifiers();

const corpus = async (): Promise<ModifierCorpus> => JSON.parse(await readFile(fixtureFile, 'utf8'));
const policy = async (): Promise<SupportedConfigurations> => JSON.parse(await readFile(policyFile, 'utf8'));
function runInput(encodedMap: string, decisions: PlayerDecision[], difficulty: Difficulty): ValidationInput {
  const map = parseMap(encodedMap);
  return { canonicalMap: encodedMap, decisions, binding: { id: 'modifier-run', mapId: 'gifts', revisionId: 'revision_1',
    mapHash: map.contentHash, engineHash: PINNED_RELEASE.mainHash, adapterVersion: ADAPTER_VERSION,
    difficulty, plugins: map.plugins, issuedAt: '2026-09-26T00:00:00Z', expiresAt: '2026-10-26T00:00:00Z' } };
}
const presentIds = (state: Record<string, any>): number[] => state.pawns.filter((pawn: any) => pawn.type === 'present').map((pawn: any) => pawn.id);

test('real gift purchases and two rounds of spawning match repeated browser states in both difficulties', async () => {
  const reference = await corpus();
  const reviewed = await policy();
  const sources = await loadEngineSources();
  assert.equal(reference.version, 1);
  assert.equal(reference.engineHash, sources.engineHash);
  assert.deepEqual(reference.plugins, plugins);
  assert.deepEqual(reference.cases.map(entry => entry.difficulty), ['normal', 'hard']);
  for (const fixture of reference.cases) {
    assert.equal(parseMap(fixture.encodedMap).contentHash, reference.sourceMapHash);
    assert.equal(fixture.repeatHashes.length, 2);
    assert.equal(fixture.repeatHashes[0], fixture.repeatHashes[1]);
    let afterDecision = -1;
    const checkpoints: Checkpoint[] = [];
    const session = createEngineSession(sources, fixture.encodedMap, fixture.difficulty, {
      onCheckpoint(checkpoint) {
        checkpoints.push({ afterDecision, phase: checkpoint.phase, factionId: checkpoint.factionId, state: checkpoint.state,
          ...(checkpoint.outcome ? { outcome: { winner: checkpoint.outcome.winner } } : {}) });
      },
    });
    const startingTreasury = session.model.economy.treasuryOf(session.model.regions.byId(16));
    const originalPrice = session.model.rules.pawns('present').cost;
    assert.equal(originalPrice, 10);
    assert.deepEqual(presentIds(session.snapshot()), []);
    for (const [index, decision] of fixture.decisions.entries()) {
      afterDecision = index;
      await applyPlayerDecision(session, decision);
      if (index === 0) {
        assert.equal(session.model.economy.treasuryOf(session.model.regions.byId(16)), startingTreasury - originalPrice);
        assert.equal(session.snapshot().pawns.filter((pawn: any) => pawn.type === 'present' && pawn.hex === 704).length, 1);
      }
    }
    const projected = checkpoints.map(checkpoint => ({ ...checkpoint, state: gameplayState(checkpoint.state) }));
    const expected = fixture.checkpoints.map(checkpoint => ({ ...checkpoint, state: gameplayState(checkpoint.state) }));
    // Compact first-checkpoint diagnostics avoid dumping the entire supplied map.
    assert.equal(projected.length, expected.length);
    for (const [index, checkpoint] of projected.entries()) {
      assert.equal(sha256(JSON.stringify(checkpoint)), sha256(JSON.stringify(expected[index])), `${fixture.id}: checkpoint ${index}`);
    }
    assert.equal(sha256(JSON.stringify({ checkpoints: projected, outcome: null })), fixture.repeatHashes[0]);
    const purchased = presentIds(checkpoints.find(checkpoint => checkpoint.afterDecision === 0)!.state);
    const neutral = checkpoints.filter(checkpoint => checkpoint.phase === 'neutral-turn');
    assert.equal(neutral.length, 2, 'Both neutral phases must be covered');
    for (const checkpoint of neutral) assert.ok(presentIds(checkpoint.state).some(id => !purchased.includes(id)), 'No automatic gift spawning was exercised');
    assert.ok(presentIds(neutral[1].state).some(id => !presentIds(neutral[0].state).includes(id)), 'Second round did not exercise additional spawning');
    assert.deepEqual(await new NodeSimulationAdapter({ policy: reviewed }).validate(runInput(fixture.encodedMap, fixture.decisions, fixture.difficulty)),
      { status: 'non-winning', outcome: 'unfinished', turns: 3 });
  }
});

test('special purchases still require the real shop, ownership, treasury and drop legality', async () => {
  const reference = await corpus();
  const reviewed = await policy();
  const base: FixtureCorpus = JSON.parse(await readFile(new URL('fixtures/base-cases.json', import.meta.url), 'utf8'));
  for (const fixture of reference.cases) {
    const valid = fixture.decisions[0];
    const cases: Array<{ decisions: PlayerDecision[]; code: string }> = [
      { decisions: [valid, valid], code: 'insufficient-funds' },
      { decisions: [{ kind: 'buy', pawnType: 'present', destinationHexId: 704, buyerRegionId: 130 }], code: 'region-not-controllable' },
      { decisions: [{ kind: 'buy', pawnType: 'present', destinationHexId: 808, buyerRegionId: 16 }], code: 'illegal-destination' },
      { decisions: [{ kind: 'buy', pawnType: 'town', destinationHexId: 704, buyerRegionId: 16 }], code: 'pawn-not-buyable' },
      { decisions: [{ ...valid, cost: 0 } as unknown as PlayerDecision], code: 'malformed-input' },
    ];
    for (const mutation of cases) {
      const result = await validateInWorker(runInput(fixture.encodedMap, mutation.decisions, fixture.difficulty), { policy: reviewed });
      assert.equal(result.status, 'invalid');
      if (result.status === 'invalid') assert.equal(result.code, mutation.code);
    }
    const ordinary = base.cases.find(entry => entry.id === `tiny-win-${fixture.difficulty}`)!;
    const result = await validateInWorker(runInput(ordinary.encodedMap,
      [{ kind: 'buy', pawnType: 'present', destinationHexId: 203, buyerRegionId: 1 }], fixture.difficulty), { policy: reviewed });
    assert.deepEqual(result, { status: 'invalid', code: 'pawn-not-buyable', decisionIndex: 0 });
  }
});

test('the published policy admits only exact proven plugin sequences and engine versions', async () => {
  const reviewed = await policy();
  assert.equal(reviewed.configurations.length, 4);
  for (const difficulty of ['normal', 'hard'] as const) {
    assert.equal(supports(reviewed, PINNED_RELEASE.mainHash, difficulty, []), true);
    assert.equal(supports(reviewed, PINNED_RELEASE.mainHash, difficulty, plugins), true);
    assert.equal(supports(reviewed, 'future-engine', difficulty, plugins), false);
    for (const unsupported of [['buy-gifts', 'spawn-gifts'], ['spawn-gifts'], ['buy-gifts'], ['zombies'], ['pick-landing-spot'],
      ['always-retreat'], ['buy-towns'], ['capture-towns'], ['low-upkeep'], [...plugins, 'zombies']]) {
      assert.equal(supports(reviewed, PINNED_RELEASE.mainHash, difficulty, unsupported), false);
    }
  }
  const fixture = (await corpus()).cases[0];
  const changed = structuredClone(parseMap(fixture.encodedMap).state);
  (changed.map as Record<string, unknown>).plugins = [...plugins].reverse();
  const encoded = 'konkrmap.v7.' + Buffer.from(JSON.stringify(changed)).toString('base64');
  assert.deepEqual(await validateInWorker(runInput(encoded, [], 'normal'), { policy: reviewed }),
    { status: 'unsupported', code: 'configuration-not-reviewed' });
});
