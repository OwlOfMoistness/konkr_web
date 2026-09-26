import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { captureCase, gameplayProjection, hash, referenceHarness } from "../scripts/import-fixtures.ts";
import type { Checkpoint, FixtureCorpus } from "../scripts/import-fixtures.ts";

const corpus: FixtureCorpus = JSON.parse(await readFile(new URL("./fixtures/base-cases.json", import.meta.url), "utf8"));
const manifest = JSON.parse(await readFile(new URL("./fixtures/manifest.json", import.meta.url), "utf8"));
const runtime = JSON.parse(await readFile(new URL("../runtime/manifest.json", import.meta.url), "utf8"));

test("reference evidence pins engine/browser, repeats and complete outcome coverage", () => {
  assert.equal(corpus.engineHash, runtime.files[runtime.main]);
  assert.equal(corpus.engineHash, manifest.engineHash);
  assert.equal(corpus.browserVersion, runtime.browser.chromiumVersion);
  assert.equal(corpus.browserVersion, manifest.browserVersion);
  assert.equal(corpus.cases.length, 14);
  assert.equal(new Set(corpus.cases.map((entry) => entry.id)).size, corpus.cases.length);
  for (const fixture of corpus.cases) {
    assert.equal(fixture.checkpoints[0]?.phase, "initial");
    assert.equal(fixture.checkpoints[0]?.afterDecision, -1);
    assert.ok(fixture.checkpoints.every((checkpoint) => Array.isArray(checkpoint.state.regions)));
    const expectedHash = hash({ checkpoints: gameplayProjection(fixture.checkpoints), outcome: fixture.outcome });
    assert.deepEqual(fixture.repeatHashes, [expectedHash, expectedHash]);
    assert.equal(fixture.rawRepeatHashes.length, 2);
    assert.equal(fixture.rawRepeatHashes[0], hash(fixture.checkpoints));
    assert.equal(manifest.cases.find((entry: any) => entry.id === fixture.id)?.traceHash, expectedHash);
    const terminal = fixture.checkpoints.filter((checkpoint) => checkpoint.outcome);
    assert.equal(terminal.length, fixture.expected === "unfinished" ? 0 : 1);
    if (terminal.length) assert.deepEqual(fixture.checkpoints.at(-1)?.outcome, fixture.outcome);
    if (fixture.id.startsWith("tiny-surrender")) assert.equal(fixture.observedSurrenderOffer, true);
  }
  for (const difficulty of ["normal", "hard"]) {
    for (const kind of ["tiny-win", "tiny-buy-win", "tiny-defeat", "tiny-surrender", "tiny-unfinished", "prison-first-turn", "gifts-two-turns"]) {
      assert.ok(corpus.cases.some((entry) => entry.id === `${kind}-${difficulty}`));
    }
    const gifts = corpus.cases.find((entry) => entry.id === `gifts-two-turns-${difficulty}`)!;
    assert.deepEqual(gifts.checkpoints[0].state.map.plugins, ["spawn-gifts", "buy-gifts"]);
    assert.equal(gifts.checkpoints.at(-1)?.state.currentPhase.turnNumber, 3);
  }
});

test("comparison projection removes only cosmetic names and never changes raw evidence/order", () => {
  const raw = [{ afterDecision: -1, phase: "initial", factionId: 1, state: { regions: [{ id: 7, name: "A", hexes: [3, 2] }, { id: 2, name: "B", hexes: [1] }], currentPhase: { turnNumber: 1 }, pawns: [{ id: 1, count: 10 }] } }] as Checkpoint[];
  const projected = gameplayProjection(raw);
  assert.equal(raw[0].state.regions[0].name, "A");
  assert.deepEqual(projected[0].state.regions, [{ id: 7, hexes: [3, 2] }, { id: 2, hexes: [1] }]);
  const renamed = structuredClone(raw);
  renamed[0].state.regions[0].name = "Different";
  assert.deepEqual(gameplayProjection(renamed), projected);
  for (const mutate of [(value: Checkpoint[]) => value[0].state.regions.reverse(), (value: Checkpoint[]) => value[0].state.regions[0].hexes.reverse(), (value: Checkpoint[]) => value[0].state.pawns[0].count++, (value: Checkpoint[]) => value[0].state.currentPhase.turnNumber++]) {
    const changed = structuredClone(raw);
    mutate(changed);
    assert.notDeepEqual(gameplayProjection(changed), projected);
  }
});

test("legacy extracts retain replay-only evidence and are explicitly unverified", () => {
  assert.deepEqual(corpus.legacy.map((entry) => entry.id), ["sherwood-legacy", "prison-profile-latest"]);
  for (const entry of corpus.legacy) {
    assert.equal(entry.status, "unverified-engine-version");
    assert.match(entry.sourceHash, /^[a-f\d]{64}$/);
    assert.deepEqual(Object.keys(entry.replay).sort(), ["meta", "steps"]);
    assert.deepEqual(Object.keys(entry.replay.meta), ["aiDifficulty"]);
    assert.ok(entry.replay.steps.some((step: any) => step.play));
    assert.ok(entry.replay.steps.some((step: any) => step.snapshot));
  }
  const prison = corpus.legacy[1].replay;
  assert.equal(prison.meta.aiDifficulty, "hard");
  assert.equal(prison.steps.at(-1).play.name, "PLAY.ACCEPT_SURRENDER");
  assert.equal(prison.steps.at(-1).snapshot.currentPhase.turnNumber, 12);
  assert.equal(prison.steps.filter((step: any) => step.play).length, 328);
  assert.equal(corpus.legacy[0].replay.steps.filter((step: any) => step.play).length, 73);
  assert.equal(corpus.legacy[0].replay.steps.filter((step: any) => step.snapshot).length, 19);
});

test("fresh isolated browser reproduces every reference checkpoint", { timeout: 240_000 }, async (t) => {
  const harness = await referenceHarness();
  t.after(() => harness.close());
  assert.equal(harness.browser.version(), corpus.browserVersion);
  for (const fixture of corpus.cases) {
    await t.test(fixture.id, async () => {
      const current = await captureCase(harness.browser, harness.baseURL, fixture);
      assert.deepEqual(gameplayProjection(current.checkpoints), gameplayProjection(fixture.checkpoints));
      assert.deepEqual(current.outcome, fixture.outcome);
      if (fixture.decisions.some((decision) => decision.kind === "accept-surrender")) assert.equal(current.observedSurrenderOffer, true);
    });
  }
});
