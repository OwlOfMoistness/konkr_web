import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { communityRoot, generatedRoot, guardedPatch, insertion, insertionAnchor, localFontReplacements, prepareRuntime } from "../scripts/prepare-runtime.ts";
import type { ReferenceState } from "../runtime/bootstrap.ts";

const manifest = JSON.parse(await readFile(path.join(communityRoot, "runtime/manifest.json"), "utf8"));

test("runtime preparation rejects changed bundles and ambiguous patch anchors", async () => {
  const original = await readFile(path.join(communityRoot, "..", manifest.sourceDirectory, manifest.main), "utf8");
  const patched = guardedPatch(original, manifest.files[manifest.main]);
  let reversed = patched.replace(insertion, "");
  for (const [remote, local] of localFontReplacements) reversed = reversed.replace(local, remote);
  assert.equal(reversed, original, "Only the declared bootstrap/font adaptations may differ");
  assert.throws(() => guardedPatch(original + " ", manifest.files[manifest.main]), /checksum mismatch/);
  for (const source of ["missing", insertionAnchor + insertionAnchor]) {
    assert.throws(() => guardedPatch(source, createHash("sha256").update(source).digest("hex")), /exactly one/);
  }
});

test("fixed browser runtime imports maps with original services disabled before boot", { timeout: 180_000 }, async (t) => {
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
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseURL = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
  t.after(() => browser.close());
  assert.equal(browser.version(), manifest.browser.chromiumVersion, "Use the pinned Playwright Chromium build");
  const fixtureDirectory = process.env.KONKR_MAP_FIXTURES;
  const cases: Array<{ name: string; width: number; height: number; difficulty: "normal" | "hard" }> = [];
  for (const difficulty of ["normal", "hard"] as const) {
    cases.push({ name: "prison.konkr", width: 24, height: 25, difficulty });
    cases.push({ name: "escalating-quickly.konkr", width: 19, height: 22, difficulty });
  }

  for (const fixture of fixtureDirectory ? cases : [undefined]) {
    await t.test(fixture ? `${fixture.name} ${fixture.difficulty}` : "cold boot without external fixtures", async () => {
      // Block SWs so interception cannot be bypassed. Fresh contexts isolate storage.
      // https://playwright.dev/docs/api/class-browser#browser-new-context-option-service-workers
      const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 800 } });
      try {
        const external: string[] = [];
        const pageErrors: string[] = [];
        const warnings: string[] = [];
        const driverWarnings: string[] = [];
        const layoutNotices: string[] = [];
        const aiPlanningNotices: string[] = [];
        const failedResources: string[] = [];
        // https://playwright.dev/docs/network#handle-requests
        await context.route("**/*", async (route) => {
          const url = route.request().url();
          if (new URL(url).origin !== baseURL) { external.push(url); await route.abort(); }
          else await route.continue();
        });
        const page = await context.newPage();
        page.on("pageerror", (error) => pageErrors.push(error.message));
        page.on("response", (response) => {
          if (response.status() >= 400) failedResources.push(`${response.status()} ${response.url()}`);
        });
        page.on("console", (message) => {
          if (message.type() === "error" || message.type() === "warning") {
            const text = message.text();
            if (/^\[\.WebGL-0x[\da-f]+\]GL Driver Message .*GPU stall due to ReadPixels/.test(text)) driverWarnings.push(text);
            else if (/^\[PlayUIScene\] Updating controls to fit screen size "(?:large|small)"$/.test(text)) layoutNotices.push(text);
            else if (message.type() === "warning" && /^\[(?:SituationExplorer|BlockDefensePlanner)\] (?:Failed to execute |BlockDefense plan creation aborted )/.test(text)) aiPlanningNotices.push(text);
            else warnings.push(text);
          }
        });
        await page.goto(baseURL + "/");
        await page.waitForFunction(() => window.communityReference?.ready || window.communityReference?.errors.length, undefined, { timeout: 40_000 });
        assert.deepEqual(await page.evaluate(() => window.communityReference.errors), []);
        assert.equal(await page.evaluate(() => window.communityReference.ready), true);
        const initialURL = page.url();
        if (fixture) {
          const encoded = await readFile(path.join(fixtureDirectory!, fixture.name), "utf8");
          const result: ReferenceState = await page.evaluate(({ encoded, difficulty }) => window.communityReference.importMap(encoded, difficulty), { encoded, difficulty: fixture.difficulty });
          assert.equal(result.state.map.width, fixture.width);
          assert.equal(result.state.map.height, fixture.height);
          assert.equal(result.difficulty, fixture.difficulty);
          assert.equal(result.screen, "Play");
          assert.equal(result.effectivePluginCount, result.state.map.plugins.length + (fixture.difficulty === "normal" ? 1 : 0));
          assert.equal(await page.locator("#phaser-game canvas").isVisible(), true);
          assert.equal(page.url(), initialURL, "Custom-map import must preserve the visible URL");
          t.diagnostic(JSON.stringify({ fixture: fixture.name, difficulty: result.difficulty, plugins: result.state.map.plugins, phase: result.state.currentPhase }));
          if (process.env.KONKR_REFERENCE_SCREENSHOTS) {
            await mkdir(process.env.KONKR_REFERENCE_SCREENSHOTS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.KONKR_REFERENCE_SCREENSHOTS, `${fixture.name}-${fixture.difficulty}.png`) });
          }
          if (fixture.name === "prison.konkr" && fixture.difficulty === "hard") {
            await page.evaluate(() => window.communityReference.act("SetSpectatingPlayBackSpeed", 3));
            await page.evaluate(() => window.communityReference.act("EndTurn", { force: true }));
            await page.waitForFunction(() => {
              const reference = window.communityReference.inspect();
              return reference.state.currentPhase.turnNumber >= 2 && reference.state.currentPhase.faction === 1;
            }, undefined, { timeout: 20_000 }).catch(async (error) => {
              t.diagnostic(JSON.stringify(await page.evaluate(() => ({ phase: window.communityReference.inspect().state.currentPhase, screen: window.communityReference.inspect().screen, errors: window.communityReference.errors }))));
              throw error;
            });
            const turn = await page.evaluate(() => window.communityReference.inspect().state.currentPhase.turnNumber);
            assert.equal(turn, 2, "Original controller and AI must finish a turn");
            assert.equal(page.url(), initialURL);
            assert.ok(await page.evaluate(() => !!window.communityReference.exportHistory()));
          }
        }
        await page.waitForTimeout(300);
        const diagnostics = await page.evaluate(() => ({ errors: window.communityReference.errors, blockedRequests: window.communityReference.blockedRequests, disabledServices: window.communityReference.disabledServices }));
        assert.deepEqual(external, [], "No original-service request may even be attempted");
        assert.deepEqual(diagnostics.blockedRequests, [], "CSP must not conceal a missed external initialization");
        assert.deepEqual(diagnostics.errors, []);
        assert.deepEqual(pageErrors, []);
        assert.deepEqual(failedResources, []);
        assert.deepEqual(warnings, []);
        if (driverWarnings.length) t.diagnostic(`${driverWarnings.length} Chromium software-renderer ReadPixels performance notices; no game warnings`);
        if (layoutNotices.length) t.diagnostic(`${layoutNotices.length} original PlayUIScene layout notices logged at warning level`);
        if (aiPlanningNotices.length) t.diagnostic(JSON.stringify({ originalAIPlanningNotices: aiPlanningNotices }));
        assert.deepEqual([...new Set(diagnostics.disabledServices)].sort(), ["analytics", "auth", "cloud-sync", "firebase", "reporting", "sentry"]);
      } finally { await context.close(); }
    });
  }
  if (!fixtureDirectory) t.diagnostic("Set KONKR_MAP_FIXTURES to the directory containing the two supplied maps to run four import cases.");
});
