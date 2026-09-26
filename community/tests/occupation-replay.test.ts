import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseMap } from '../engine/map-format.ts';
import { NodeSimulationAdapter } from '../engine/validate.ts';
import { ADAPTER_VERSION, PINNED_RELEASE } from '../engine/platform.ts';
import type { SupportedConfigurations, ValidationInput, ValidationResult } from '../shared/contracts.ts';

const fixture: { input: ValidationInput; expectedResult: ValidationResult } = JSON.parse(
  await readFile(new URL('fixtures/occupation-nineteen-turns.json', import.meta.url), 'utf8'));
const input = fixture.input;
const map = parseMap(input.canonicalMap);
assert.equal(input.binding.engineHash, PINNED_RELEASE.mainHash);
assert.equal(input.binding.adapterVersion, ADAPTER_VERSION);
assert.equal(input.binding.mapHash, map.contentHash);
assert.equal(input.binding.difficulty, 'normal');
assert.deepEqual(input.binding.plugins, ['capture-towns']);
assert.deepEqual(map.plugins, ['capture-towns']);
assert.deepEqual(map.state.currentPhase, { type: 'faction-turn', turnNumber: 1, faction: 1, tappedUnits: [] });
assert.equal(input.decisions.length, 90);
assert.equal(input.decisions.filter(decision => decision.kind === 'end-turn').length, 18);
assert.deepEqual(input.decisions.at(-1), { kind: 'accept-surrender' });
const sourceOptions = process.env.KONKR_REFERENCE_ROOT ? { repositoryRoot: process.env.KONKR_REFERENCE_ROOT } : {};

// Exercise the actual strict worker with an explicitly local fixture policy.
// This must not add capture-towns to the community service's reviewed policy.
const fixturePolicy: SupportedConfigurations = { version: 1, configurations: [{
  engineHash: PINNED_RELEASE.mainHash, difficulty: 'normal', plugins: ['capture-towns'],
  evidence: 'Occupation replay regression only; not public support approval',
}] };

test('community submission policy still excludes the unreviewed Occupation rule', async () => {
  const policy: SupportedConfigurations = JSON.parse(await readFile(new URL('../shared/supported-configurations.json', import.meta.url), 'utf8'));
  assert.deepEqual(await new NodeSimulationAdapter({ policy, sourceOptions }).validate(input),
    { status: 'unsupported', code: 'configuration-not-reviewed' });
});

test('Occupation Normal replay independently validates a victory on turn 19', async () => {
  const result = await new NodeSimulationAdapter({ policy: fixturePolicy, sourceOptions }).validate(input);
  assert.equal(result.status, 'verified');
  if (result.status === 'verified') {
    assert.equal(result.outcome, 'victory');
    assert.equal(result.turns, 19);
  }
  assert.deepEqual(result, fixture.expectedResult, 'The complete gameplay-state hash must remain stable');
});

test('Occupation does not claim victory when the final acceptance of surrender is missing', async () => {
  const incomplete = { ...input, decisions: input.decisions.slice(0, -1) };
  assert.deepEqual(await new NodeSimulationAdapter({ policy: fixturePolicy, sourceOptions }).validate(incomplete),
    { status: 'non-winning', outcome: 'unfinished', turns: 19 });
});
