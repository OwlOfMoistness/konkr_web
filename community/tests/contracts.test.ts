import { runtimeLevelId } from '../shared/runtime-identity.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContractError, LIMITS, decodeSubmission, normalizeTags, parseDecision, parseSubmission, supports } from '../shared/contracts.ts';

const valid = { version: 1, runId: 'run_1', idempotencyKey: 'retry_1', decisions: [{ kind: 'move', pawnId: 289, destinationHexId: 914 }, { kind: 'end-turn' }] };

test('accepts complete semantic decisions without interpreting them as victory', () => {
  assert.deepEqual(decodeSubmission(JSON.stringify(valid)), valid);
  assert.deepEqual(parseSubmission({ ...valid, decisions: [] }).decisions, []);
});

test('refuses privileged replay fields and invented engine events', () => {
  for (const decision of [
    { kind: 'move', pawnId: 1, destinationHexId: 2, tapUnit: false },
    { kind: 'spawn', pawnType: 'knight' },
    { kind: 'end-turn', faction: 2 },
    { kind: 'accept-surrender', force: true },
  ]) assert.throws(() => parseDecision(decision), ContractError);
  for (const field of ['snapshot', 'engineHash', 'claimedVictory', 'turns'])
    assert.throws(() => parseSubmission({ ...valid, [field]: true }), ContractError);
});

test('rejects malformed, excessive, or ambiguous submissions', () => {
  for (const value of [null, [], { ...valid, version: 7 }, { ...valid, runId: '../escape' }, { ...valid, decisions: new Array(LIMITS.decisions + 1).fill({ kind: 'end-turn' }) }])
    assert.throws(() => parseSubmission(value), ContractError);
  assert.throws(() => decodeSubmission('{'), ContractError);
  assert.throws(() => decodeSubmission(' '.repeat(LIMITS.submissionBytes + 1)), ContractError);
  assert.throws(() => parseDecision({ kind: 'move', pawnId: Number.MAX_SAFE_INTEGER + 1, destinationHexId: 1 }), ContractError);
  assert.throws(() => parseDecision(Object.create({ kind: 'end-turn' })), ContractError);
});

test('support policy requires the exact tested plugin sequence and difficulty', () => {
  const policy = { version: 1 as const, configurations: [{ engineHash: 'abc', difficulty: 'hard' as const, plugins: ['spawn-gifts', 'buy-gifts'], evidence: 'fixture' }] };
  assert.equal(supports(policy, 'abc', 'hard', ['spawn-gifts', 'buy-gifts']), true);
  assert.equal(supports(policy, 'abc', 'hard', ['buy-gifts', 'spawn-gifts']), false);
  assert.equal(supports(policy, 'abc', 'normal', ['buy-gifts', 'spawn-gifts']), false);
  assert.equal(supports(policy, 'other', 'hard', ['buy-gifts', 'spawn-gifts']), false);
  assert.equal(supports(policy, 'abc', 'hard', ['spawn-gifts']), false);
  assert.equal(supports(policy, 'abc', 'hard', ['spawn-gifts', 'spawn-gifts']), false);
});

test('tag normalization handles hashtag input and rejects unsafe names', () => {
  assert.deepEqual(normalizeTags(['#Xmas', ' xmas ', 'zombie']), ['xmas', 'zombie']);
  assert.throws(() => normalizeTags(['<script>']), ContractError);
  assert.throws(() => normalizeTags(['']), ContractError);
});

test('runtime save identity is deterministic and separates revisions, engines and difficulty', async () => {
  const binding = { mapId: 'map', revisionId: 'revision', engineHash: 'engine', difficulty: 'normal' as const };
  const id = await runtimeLevelId(binding);
  assert.match(id, /^cl-community-[0-9a-f]{32}$/);
  assert.equal(await runtimeLevelId({ ...binding }), id);
  for (const different of [{ ...binding, mapId: 'map2' }, { ...binding, revisionId: 'revision2' }, { ...binding, engineHash: 'engine2' }, { ...binding, difficulty: 'hard' as const }]) assert.notEqual(await runtimeLevelId(different), id);
  await assert.rejects(runtimeLevelId({ ...binding, mapId: '../bad' }));
});
