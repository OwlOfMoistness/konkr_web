import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseMap } from '../engine/map-format.ts';
import { NodeSimulationAdapter } from '../engine/validate.ts';
import { ADAPTER_VERSION, PINNED_RELEASE } from '../engine/platform.ts';
import type { SupportedConfigurations, ValidationInput } from '../shared/contracts.ts';

const fixture: { input: ValidationInput; legacyFinalStateHash: string } = JSON.parse(
  await readFile(new URL('fixtures/orchard-eight-turns.json', import.meta.url), 'utf8'));
const input = fixture.input;
const map = parseMap(input.canonicalMap);
assert.equal(input.binding.engineHash, PINNED_RELEASE.mainHash);
assert.equal(input.binding.adapterVersion, ADAPTER_VERSION);
assert.equal(input.binding.mapHash, map.contentHash);
assert.equal(input.binding.difficulty, 'hard');
assert.deepEqual(input.binding.plugins, []);
assert.deepEqual(map.plugins, []);
assert.deepEqual(map.state.currentPhase, { type: 'faction-turn', turnNumber: 1, faction: 1, tappedUnits: [] });
assert.equal(input.decisions.length, 43);
assert.equal(input.decisions.filter(decision => decision.kind === 'end-turn').length, 7);
assert.deepEqual(input.decisions.at(-1), { kind: 'accept-surrender' });

// Use the service's actual reviewed policy, with no fixture-only rule allowance.
const policy: SupportedConfigurations = JSON.parse(await readFile(new URL('../shared/supported-configurations.json', import.meta.url), 'utf8'));
const sourceOptions = process.env.KONKR_REFERENCE_ROOT ? { repositoryRoot: process.env.KONKR_REFERENCE_ROOT } : {};

test('Orchard Hard validates an eight-turn win under the existing service policy and matches the exported final state', async () => {
  const result = await new NodeSimulationAdapter({ policy, sourceOptions }).validate(input);
  assert.deepEqual(result, { status: 'verified', outcome: 'victory', turns: 8,
    finalStateHash: fixture.legacyFinalStateHash });
});

test('Orchard without its final surrender acceptance remains unfinished on turn eight', async () => {
  const incomplete = { ...input, decisions: input.decisions.slice(0, -1) };
  assert.deepEqual(await new NodeSimulationAdapter({ policy, sourceOptions }).validate(incomplete),
    { status: 'non-winning', outcome: 'unfinished', turns: 8 });
});
