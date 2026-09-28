import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseMap } from '../engine/map-format.ts';
import { createEngineSession } from '../engine/adapter.ts';
import { applyPlayerDecision } from '../engine/player-commands.ts';
import { NodeSimulationAdapter } from '../engine/validate.ts';
import { ADAPTER_VERSION, PINNED_RELEASE, loadEngineSources } from '../engine/platform.ts';
import { runtimeLevelId } from '../shared/runtime-identity.ts';
import type { SupportedConfigurations, ValidationInput, ValidationResult } from '../shared/contracts.ts';

interface ReplayFixture {
  id: string;
  title: string;
  input: ValidationInput;
  legacyFinalStateHash: string;
  expectedResult: ValidationResult;
  syntheticSurrenderProbe?: { expectedResult: ValidationResult };
}
const corpus: { cases: ReplayFixture[] } = JSON.parse(await readFile(new URL('fixtures/four-map-replays.json', import.meta.url), 'utf8'));
const expected = [
  { id: 'furor', turns: 9, decisions: 70, status: 'verified' },
  { id: 'fjords', turns: 6, decisions: 26, status: 'non-winning' },
  { id: 'sherwood', turns: 4, decisions: 14, status: 'non-winning' },
  { id: 'milk-and-honey', turns: 6, decisions: 28, status: 'verified' },
] as const;
assert.deepEqual(corpus.cases.map(item => item.id), expected.map(item => item.id));
// These maps need no test-only rule allowance: use the actual service policy.
const policy: SupportedConfigurations = JSON.parse(await readFile(new URL('../shared/supported-configurations.json', import.meta.url), 'utf8'));
const sourceOptions = process.env.KONKR_REFERENCE_ROOT ? { repositoryRoot: process.env.KONKR_REFERENCE_ROOT } : {};

for (const [index, fixture] of corpus.cases.entries()) {
  const { input } = fixture;
  const expectation = expected[index];
  const map = parseMap(input.canonicalMap);
  assert.equal(input.binding.engineHash, PINNED_RELEASE.mainHash);
  assert.equal(input.binding.adapterVersion, ADAPTER_VERSION);
  assert.equal(input.binding.mapHash, map.contentHash);
  assert.equal(input.binding.difficulty, 'hard');
  assert.deepEqual(input.binding.plugins, []);
  assert.deepEqual(map.plugins, []);
  assert.deepEqual(map.state.currentPhase, { type: 'faction-turn', turnNumber: 1, faction: 1, tappedUnits: [] });
  assert.equal(input.decisions.length, expectation.decisions);
  assert.equal(input.decisions.filter(decision => decision.kind === 'end-turn').length, expectation.turns - 1);

  test(`${fixture.title}: ${expectation.status} on turn ${expectation.turns}, matching the supplied final state`, async () => {
    const result = await new NodeSimulationAdapter({ policy, sourceOptions }).validate(input);
    assert.equal(result.status, expectation.status);
    assert.deepEqual(result, fixture.expectedResult);
    if (result.status === 'verified') {
      assert.equal(result.turns, expectation.turns);
      assert.equal(result.finalStateHash, fixture.legacyFinalStateHash);
    } else {
      assert.deepEqual(result, { status: 'non-winning', outcome: 'unfinished', turns: expectation.turns });
      // Non-winning worker responses omit state hashes. Independently replay the
      // same legal decisions to compare the endpoint with the exported snapshot.
      const session = createEngineSession(await loadEngineSources(sourceOptions), input.canonicalMap, input.binding.difficulty,
        { runtimeLevelId: await runtimeLevelId(input.binding) });
      for (const decision of input.decisions) await applyPlayerDecision(session, decision);
      assert.equal(session.outcome, undefined);
      assert.equal(session.surrenderOffered, false);
      assert.equal(session.stateHash(), fixture.legacyFinalStateHash);
    }
  });

  if (expectation.status === 'non-winning') test(`${fixture.title}: appending a fabricated surrender cannot turn the partial trace into a win`, async () => {
    assert.ok(fixture.syntheticSurrenderProbe);
    const forged: ValidationInput = { ...input, decisions: [...input.decisions, { kind: 'accept-surrender' }] };
    const result = await new NodeSimulationAdapter({ policy, sourceOptions }).validate(forged);
    assert.deepEqual(result, { status: 'invalid', code: 'surrender-not-offered', decisionIndex: expectation.decisions });
    assert.deepEqual(result, fixture.syntheticSurrenderProbe.expectedResult);
  });
}
