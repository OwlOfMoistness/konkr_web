import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeKonkrData, parseMap } from '../engine/map-format.ts';
import { createEngineSession, gameplayState } from '../engine/adapter.ts';
import { applyPlayerDecision } from '../engine/player-commands.ts';
import { NodeSimulationAdapter } from '../engine/validate.ts';
import { ADAPTER_VERSION, PINNED_RELEASE, loadEngineSources, sha256 } from '../engine/platform.ts';
import type { Difficulty, PlayerDecision, SupportedConfigurations, ValidationInput } from '../shared/contracts.ts';

interface ReplayStep {
  faction: number;
  tags?: string[];
  snapshot?: Record<string, any>;
  play?: { name: string; payload?: Record<string, any> };
}
const evidence = JSON.parse(await readFile(new URL('fixtures/happy-present-five-turn-evidence.json', import.meta.url), 'utf8'));
const raw: string = evidence.encodedReplay;
const replay = decodeKonkrData(raw.trim(), 'konkrreplay.v7.') as unknown as {
  meta: { title: string; aiDifficulty: Difficulty }; steps: ReplayStep[];
};
assert.equal(sha256(raw), evidence.sourceHash);
const initial = replay.steps[0].snapshot!;
assert.ok(replay.steps[0].tags?.includes('gameStart'));
assert.deepEqual(initial.currentPhase, { type: 'faction-turn', turnNumber: 1, faction: 1, tappedUnits: [] });
assert.equal(replay.meta.aiDifficulty, 'hard');
const encode = (state: Record<string, any>) => 'konkrmap.v7.' + Buffer.from(JSON.stringify(state)).toString('base64');

// A fixture-only legacy import. Attribute each action using the PRECEDING
// faction; AI actions, later snapshots and client victory claims are not inputs.
const decisions: PlayerDecision[] = replay.steps.flatMap((step, index): PlayerDecision[] => {
  if (!index || replay.steps[index - 1].faction !== 1 || !step.play) return [];
  const { name, payload } = step.play;
  switch (name) {
    case 'PLAY.MOVE_PAWN':
      assert.equal(payload?.tapUnit, false);
      return [{ kind: 'move', pawnId: payload!.pawnId, destinationHexId: payload!.destinationHexId }];
    case 'PLAY.BUY_PAWN':
      assert.equal(payload?.tapUnit, false);
      return [{ kind: 'buy', pawnType: payload!.pawnType, destinationHexId: payload!.destinationHexId, buyerRegionId: payload!.buyerRegionId }];
    case 'PLAY.END_TURN': return [{ kind: 'end-turn' }];
    default: throw new Error(`Unmapped player decision: ${name}`);
  }
});
assert.equal(decisions.length, 42);
assert.equal(decisions.filter(decision => decision.kind === 'end-turn').length, 4);

test('public validator refuses Happy Present explicit win conditions without weakening map admission', async () => {
  const canonicalMap = encode(initial);
  assert.throws(() => parseMap(canonicalMap), /Unsupported map field: winConditions/);
  const policy: SupportedConfigurations = JSON.parse(await readFile(new URL('../shared/supported-configurations.json', import.meta.url), 'utf8'));
  const input: ValidationInput = { canonicalMap, decisions, binding: {
    id: 'fixture-run', mapId: 'happy-present', revisionId: 'legacy-start', mapHash: sha256(canonicalMap),
    engineHash: PINNED_RELEASE.mainHash, adapterVersion: ADAPTER_VERSION, difficulty: 'hard', plugins: initial.map.plugins,
    issuedAt: '2026-09-26T00:00:00Z', expiresAt: '2026-10-26T00:00:00Z',
  } };
  assert.deepEqual(await new NodeSimulationAdapter({ policy }).validate(input), { status: 'invalid', code: 'malformed-input' });
});

test('trusted Happy Present compatibility fixture reproduces a five-turn win from player decisions', async () => {
  const sources = await loadEngineSources(process.env.KONKR_REFERENCE_ROOT ? { repositoryRoot: process.env.KONKR_REFERENCE_ROOT } : {});
  assert.equal(sources.engineHash, evidence.engineHash);
  const bootstrap = structuredClone(initial);
  delete bootstrap.map.winConditions;
  const session = createEngineSession(sources, encode(bootstrap), 'hard');
  // Trusted test-only compatibility probe, NOT the public validator: initialize
  // the platform, then restore the EXACT first state with its original rules.
  // No moves run with stripped rules, and no later replay snapshot is restored.
  session.controller.loadState(structuredClone(initial), session.requireModule(25972).NewGameStateContext.StartingNewGame);
  session.refreshSurrenderOffer();
  assert.deepEqual(session.snapshot().map.winConditions, initial.map.winConditions);
  assert.deepEqual(gameplayState(session.snapshot()), gameplayState(initial));
  for (const [index, decision] of decisions.entries()) {
    assert.equal(session.outcome, undefined, `No victory before decision ${index}`);
    await applyPlayerDecision(session, decision);
  }
  assert.deepEqual(session.outcome, { winner: 1, turns: 5 });
  // Full state parity is deliberately not claimed: fresh browser captures also
  // differ in diplomacy credit. Preserve that finding in the fixture evidence.
  assert.equal(session.model.currentPhase.turnNumber, 5);
});
