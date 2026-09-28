/** Rebuild with PLAYWRIGHT_BROWSERS_PATH=/path/to/pinned/browsers
 * KONKR_MAP_FIXTURES=/path/to/supplied/files node scripts/import-fixtures.ts.
 * The corpus keeps only selected replay data; whole profiles stay outside Git.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import type { Difficulty, PlayerDecision } from "../shared/contracts.ts";
import type {} from "../runtime/bootstrap.ts";
import { communityRoot, generatedRoot, prepareRuntime } from "./prepare-runtime.ts";

type State = Record<string, any>;
export interface Checkpoint {
  afterDecision: number;
  phase: "initial" | "player" | "ai-turn" | "neutral-turn";
  factionId: number;
  state: State;
  outcome?: { winner: number | null };
}
export interface ReferenceCase {
  id: string;
  encodedMap: string;
  difficulty: Difficulty;
  decisions: PlayerDecision[];
  expected: "victory" | "defeat" | "unfinished";
  checkpoints: Checkpoint[];
  outcome: { winner: number | null } | null;
  observedSurrenderOffer: boolean;
  repeatHashes: string[];
  rawRepeatHashes: string[];
}
export interface FixtureCorpus {
  version: 1;
  engineHash: string;
  browserVersion: string;
  cases: ReferenceCase[];
  legacy: Array<{ id: string; sourceFilename: string; sourceHash: string; status: "unverified-engine-version"; replay: State }>;
}

export const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
/** Preserve raw evidence; only the comparison projection omits generated labels.
 * Release modules 66810/99999 generate region names from platform RNG (50061),
 * also consumed by UI chatter. Gameplay random helpers reset using turn/hex IDs.
 * Repeated real-browser defeat differed only at regions[2].name.
 */
export function gameplayProjection(checkpoints: Checkpoint[]): Checkpoint[] {
  const copy: Checkpoint[] = JSON.parse(JSON.stringify(checkpoints));
  for (const checkpoint of copy) for (const region of checkpoint.state.regions) delete region.name;
  return copy;
}
const fixtureRoot = path.join(communityRoot, "tests/fixtures");

export async function referenceHarness(): Promise<{ browser: Browser; baseURL: string; close: () => Promise<void> }> {
  await prepareRuntime();
  const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".xml": "text/xml", ".ogg": "audio/ogg", ".mp3": "audio/mpeg", ".css": "text/css" };
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      const file = path.resolve(generatedRoot, "." + (pathname.endsWith("/") ? pathname + "index.html" : pathname));
      if (!file.startsWith(generatedRoot + path.sep)) throw new Error("Invalid path");
      response.setHeader("Content-Type", mime[path.extname(file)] ?? "application/octet-stream");
      response.end(await readFile(file));
    } catch { response.writeHead(404).end("Not found"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
    return { browser, baseURL: `http://127.0.0.1:${address.port}`, async close() {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } };
  } catch (error) { server.close(); throw error; }
}

export async function withReferencePage<T>(browser: Browser, baseURL: string, task: (page: Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 800 } });
  const external: string[] = [];
  const pageErrors: string[] = [];
  try {
    await context.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin !== baseURL) { external.push(route.request().url()); await route.abort(); }
      else await route.continue();
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(baseURL + "/");
    await page.waitForFunction(() => window.communityReference?.ready || window.communityReference?.errors.length);
    assert.deepEqual(await page.evaluate(() => window.communityReference.errors), []);
    assert.equal(await page.evaluate(() => window.communityReference.ready), true);
    const result = await task(page);
    assert.deepEqual(external, [], "Fixture producer attempted external requests");
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(await page.evaluate(() => window.communityReference.errors), []);
    assert.deepEqual(await page.evaluate(() => window.communityReference.blockedRequests), []);
    assert.equal(page.url(), baseURL + "/");
    return result;
  } finally { await context.close(); }
}

function tinyMap(kind: "win" | "defeat" | "surrender"): State {
  const surrender = kind === "surrender";
  return { version: 7,
    map: { levelId: `community-tiny-${kind}`, name: `Tiny ${kind}`, width: surrender ? 7 : 6, height: surrender ? 7 : 6, plugins: [] },
    regions: [{ id: 1, name: "West", hexes: surrender ? Array.from({ length: 5 }, (_, row) => Array.from({ length: 5 }, (_, col) => (row + 1) * 100 + col + 1)).flat().filter((id) => id !== 504 && id !== 505) : [202, 203, 302] },
      { id: 2, name: "East", hexes: surrender ? [504, 505] : [303, 304, 403] }],
    factions: [{ id: 0, name: "Nature", themeIndex: 0, controller: "none", regions: [] },
      { id: 1, name: "Player", themeIndex: 0, controller: "local-user", regions: [1] },
      { id: 2, name: "Rival", themeIndex: 1, controller: "ai", regions: [2] }],
    pawns: [{ id: 1, type: "town", hex: 202 }, { id: 2, type: "town", hex: surrender ? 505 : 303 },
      { id: 3, type: "knight", hex: surrender ? 403 : kind === "defeat" ? 304 : 302 },
      { id: 4, type: "coins", hex: 202, count: surrender ? 200 : 10 },
      { id: 5, type: "coins", hex: surrender ? 505 : 303, count: surrender ? 1 : kind === "defeat" ? 100 : 10 }],
    currentPhase: { type: "faction-turn", turnNumber: 1, faction: 1, tappedUnits: [] }, hexHistory: {},
  };
}

export async function captureCase(browser: Browser, baseURL: string, spec: Pick<ReferenceCase, "id" | "encodedMap" | "difficulty" | "decisions" | "expected">): Promise<Omit<ReferenceCase, "repeatHashes" | "rawRepeatHashes">> {
  return withReferencePage(browser, baseURL, async (page) => {
    await page.evaluate(() => window.communityReference.withEngine((load) => {
      const notifications = load(55151).app.notifications;
      const claimVictory = notifications.claimVictory.bind(notifications);
      const probe = { offered: false };
      (window as any).__fixtureProbe = probe;
      notifications.claimVictory = (...args: unknown[]) => { probe.offered = true; return claimVictory(...args); };
    }));
    const initial = await page.evaluate(({ encodedMap, difficulty }) => window.communityReference.importMap(encodedMap, difficulty), spec);
    await page.evaluate(() => window.communityReference.act("SetSpectatingPlayBackSpeed", 3));
    const trustedStart = await page.evaluate(() => window.communityReference.withEngine((load) => {
      const history = load(32070).inject.gameStateController.history;
      return { length: history.data.length, state: JSON.parse(JSON.stringify(load(13524).compressGameState(history.getStateAt(0)))) };
    }));
    assert.equal(trustedStart.length, 1, "Reference history must begin at the freshly imported map, before any player/AI action");
    assert.deepEqual(trustedStart.state, initial.state);
    const checkpoints: Checkpoint[] = [{ afterDecision: -1, phase: "initial", factionId: initial.state.currentPhase.faction, state: initial.state }];
    let outcome: { winner: number | null } | null = null;
    for (const [afterDecision, decision] of spec.decisions.entries()) {
      const priorLength = await page.evaluate(() => window.communityReference.withEngine((load) => load(32070).inject.gameStateController.history.data.length));
      assert.equal(outcome, null, "Fixture decisions cannot continue beyond the first engine terminal event");
      if (decision.kind === "accept-surrender") {
        await page.waitForFunction(() => (window as any).__fixtureProbe.offered, undefined, { timeout: 10_000 });
      }
      await page.evaluate((decision) => {
        switch (decision.kind) {
          case "move": window.communityReference.play("MovePawn", { pawnId: decision.pawnId, destinationHexId: decision.destinationHexId, tapUnit: false }); break;
          case "buy": window.communityReference.play("BuyPawn", { pawnType: decision.pawnType, destinationHexId: decision.destinationHexId, buyerRegionId: decision.buyerRegionId, tapUnit: false }); break;
          case "end-turn": window.communityReference.act("EndTurn", { force: true }); break;
          case "accept-surrender": window.communityReference.play("AcceptSurrender"); break;
          default: throw new Error("Unsupported fixture decision");
        }
      }, decision);
      await page.waitForFunction(({ priorLength, endTurn }) => window.communityReference.withEngine((load) => {
        const controller = load(32070).inject.gameStateController;
        const history = controller.history.data;
        if (history.length <= priorLength) return false;
        const over = history.some((entry: any) => entry.events.some((event: any) => event.name.endsWith(".GAME_OVER")));
        const app = load(55151).app;
        return !app.navigator.transitionInProgress && (over || (!controller.eventsPaused && app.scene.play.mode.name === "Play" && (!endTurn || controller.model.currentPhase.faction?.id === 1)));
      }), { priorLength, endTurn: decision.kind === "end-turn" }, { timeout: 30_000 }).catch(async (error) => {
        console.error(spec.id, afterDecision, await page.evaluate(() => window.communityReference.withEngine((load) => ({
          phase: window.communityReference.inspect().state.currentPhase,
          lastPlays: load(32070).inject.gameStateController.history.data.slice(-3).map((entry: any) => entry.play?.name),
          transition: load(55151).app.navigator.transitionInProgress,
          errors: window.communityReference.errors,
        }))));
        throw error;
      });
      const steps = await page.evaluate(({ priorLength, afterDecision }) => window.communityReference.withEngine((load) => {
        const history = load(32070).inject.gameStateController.history;
        const compress = load(13524).compressGameState;
        const result: Checkpoint[] = [];
        for (let index = priorLength; index < history.data.length; index++) {
          const entry = history.data[index];
          const previous = compress(history.getStateAt(index - 1));
          const actor = previous.currentPhase.faction;
          const over = entry.events.find((event: any) => event.name.endsWith(".GAME_OVER"));
          if (index === priorLength || (entry.play?.name === "PLAY.END_TURN" && actor !== 1) || over) {
            result.push({ afterDecision, phase: index === priorLength ? "player" : actor === 0 ? "neutral-turn" : "ai-turn", factionId: actor,
              state: JSON.parse(JSON.stringify(compress(history.getStateAt(index)))),
              ...(over ? { outcome: { winner: over.payload.winningFactionId ?? null } } : {}) });
          }
          if (over) break;
        }
        return result;
      }), { priorLength, afterDecision });
      checkpoints.push(...steps);
      outcome = steps.findLast((step) => step.outcome)?.outcome ?? outcome;
    }
    const observedSurrenderOffer = await page.evaluate(() => (window as any).__fixtureProbe.offered as boolean);
    assert.equal(outcome === null ? "unfinished" : outcome.winner === 1 ? "victory" : "defeat", spec.expected, `${spec.id}: unexpected engine outcome`);
    return { ...spec, checkpoints, outcome, observedSurrenderOffer };
  });
}

export async function generateFixtures(inputDirectory: string): Promise<FixtureCorpus> {
  const runtimeManifest = JSON.parse(await readFile(path.join(communityRoot, "runtime/manifest.json"), "utf8"));
  const harness = await referenceHarness();
  try {
    assert.equal(harness.browser.version(), runtimeManifest.browser.chromiumVersion);
    const maps = { prison: await readFile(path.join(inputDirectory, "prison.konkr"), "utf8"), gifts: await readFile(path.join(inputDirectory, "escalating-quickly.konkr"), "utf8") };
    const encodedTiny = await withReferencePage(harness.browser, harness.baseURL, (page) => page.evaluate((states) => window.communityReference.withEngine((load) => states.map((state) => load(47067).encodeGameState(state))), [tinyMap("win"), tinyMap("defeat"), tinyMap("surrender")]));
    const corpus: FixtureCorpus = { version: 1, engineHash: runtimeManifest.files[runtimeManifest.main], browserVersion: harness.browser.version(), cases: [], legacy: [] };
    await withReferencePage(harness.browser, harness.baseURL, async (page) => {
      for (const [id, sourceFilename, profile] of [["sherwood-legacy", "replay-2026-05-16-sherwood-4t.konkr", false], ["prison-profile-latest", "player-profile-export-2026-09-26.konkr", true]] as const) {
        const encoded = await readFile(path.join(inputDirectory, sourceFilename), "utf8");
        const replay = await page.evaluate(({ encoded, profile }) => window.communityReference.withEngine((load) => {
          const codec = load(47067);
          let selected = profile ? codec.decodeUserData(encoded).latestReplay : codec.decodeReplay(encoded);
          if (typeof selected === "string") selected = codec.decodeReplay(selected);
          if (!selected?.meta || !Array.isArray(selected?.steps)) throw new Error(`Unexpected selected replay fields: ${Object.keys(selected ?? {}).join(",")}`);
          // Deliberately exclude all profile data and replay metadata except difficulty.
          return { meta: { aiDifficulty: selected.meta.aiDifficulty }, steps: selected.steps };
        }), { encoded, profile });
        corpus.legacy.push({ id, sourceFilename, sourceHash: hash(encoded), status: "unverified-engine-version", replay });
      }
    });
    for (const difficulty of ["normal", "hard"] as const) {
      const specs: Array<Pick<ReferenceCase, "id" | "encodedMap" | "difficulty" | "decisions" | "expected">> = [
        { id: `tiny-win-${difficulty}`, encodedMap: encodedTiny[0], difficulty, decisions: [{ kind: "move", pawnId: 3, destinationHexId: 303 }], expected: "victory" },
        { id: `tiny-buy-win-${difficulty}`, encodedMap: encodedTiny[0], difficulty, decisions: [{ kind: "buy", pawnType: "villager", destinationHexId: 203, buyerRegionId: 1 }, { kind: "move", pawnId: 3, destinationHexId: 303 }], expected: "victory" },
        { id: `tiny-defeat-${difficulty}`, encodedMap: encodedTiny[1], difficulty, decisions: [{ kind: "end-turn" }], expected: "defeat" },
        { id: `tiny-surrender-${difficulty}`, encodedMap: encodedTiny[2], difficulty, decisions: [{ kind: "accept-surrender" }], expected: "victory" },
        { id: `tiny-unfinished-${difficulty}`, encodedMap: encodedTiny[0], difficulty, decisions: [], expected: "unfinished" },
        { id: `prison-first-turn-${difficulty}`, encodedMap: maps.prison, difficulty, decisions: [{ kind: "end-turn" }], expected: "unfinished" },
        { id: `gifts-two-turns-${difficulty}`, encodedMap: maps.gifts, difficulty, decisions: [{ kind: "end-turn" }, { kind: "end-turn" }], expected: "unfinished" },
      ];
      for (const spec of specs) {
        console.log(`Capturing ${spec.id}`);
        const first = await captureCase(harness.browser, harness.baseURL, spec);
        const second = await captureCase(harness.browser, harness.baseURL, spec);
        assert.deepEqual(gameplayProjection(second.checkpoints), gameplayProjection(first.checkpoints), `${spec.id}: repeated browser gameplay states diverged`);
        assert.deepEqual(second.outcome, first.outcome);
        const checksum = hash({ checkpoints: gameplayProjection(first.checkpoints), outcome: first.outcome });
        corpus.cases.push({ ...first, repeatHashes: [checksum, hash({ checkpoints: gameplayProjection(second.checkpoints), outcome: second.outcome })],
          rawRepeatHashes: [hash(first.checkpoints), hash(second.checkpoints)] });
      }
    }
    await mkdir(fixtureRoot, { recursive: true });
    await writeFile(path.join(fixtureRoot, "base-cases.json"), JSON.stringify(corpus, null, 2) + "\n");
    await writeFile(path.join(fixtureRoot, "manifest.json"), JSON.stringify({ version: 1, engineHash: corpus.engineHash, browserVersion: corpus.browserVersion,
      capture: "Original map importer + controller plays + UI EndTurn; checkpoints begin at fresh trusted map start, include each player decision and each AI/neutral completed turn, and stop at first GAME_OVER. Surrender requires observing the original claimVictory notification.",
      mapSources: [{ filename: "prison.konkr", sha256: hash(maps.prison) }, { filename: "escalating-quickly.konkr", sha256: hash(maps.gifts) }],
      comparison: "Raw states retained. Comparison excludes only regions[].name; every other field and array order is preserved.", repetition: 2,
      comparisonEvidence: { excludedPath: "regions[].name", observedDifference: "Repeated tiny-defeat-normal created region3 with different labels; gameplay data matched", sourceModules: [66810, 99999, 50061], rationale: "Region labels use global RNG also consumed by UI chatter; gameplay random helpers reset using turn and hex IDs. No name-derived simulation seed or ordering found." },
      cases: corpus.cases.map((fixture) => ({ id: fixture.id, expected: fixture.expected, difficulty: fixture.difficulty, checkpoints: fixture.checkpoints.length, traceHash: fixture.repeatHashes[0] })),
      legacy: corpus.legacy.map(({ replay, ...entry }) => ({ ...entry, actions: replay.steps.filter((step: any) => step.play).length, snapshots: replay.steps.filter((step: any) => step.snapshot).length, finalTurn: replay.steps.findLast((step: any) => step.snapshot)?.snapshot.currentPhase.turnNumber, finalAction: replay.steps.findLast((step: any) => step.play)?.play.name })),
      limitations: ["Legacy replays have unknown engine builds and remain unverified", "Browser-repeat equality is not independent Node adapter parity", "Gift spawning is covered by supplied-map turns; dedicated gift-buy legality remains modifier coverage"] }, null, 2) + "\n");
    return corpus;
  } finally { await harness.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inputs = process.env.KONKR_MAP_FIXTURES;
  if (!inputs) throw new Error("Set KONKR_MAP_FIXTURES to the supplied map/replay/profile directory");
  const corpus = await generateFixtures(inputs);
  console.log(`Wrote ${corpus.cases.length} repeated reference cases and ${corpus.legacy.length} unverified legacy extracts`);
}
