# Fixed browser reference

This addon prepares a local copy of release 2.35.30. Original website files,
bundles and assets remain unchanged. It is a compatibility reference, not an
authoritative replay validator or an approved public redistribution.

## Preparation and checks

From `community/`, use the pinned Node/dependencies in `package.json`:

```sh
npm ci --ignore-scripts
PLAYWRIGHT_BROWSERS_PATH=/private/tmp/konkr-playwright npx playwright install chromium
npm run prepare:runtime
npm run build
PLAYWRIGHT_BROWSERS_PATH=/private/tmp/konkr-playwright KONKR_MAP_FIXTURES=/path/to/map-directory npm test -- tests/reference-runtime.test.ts
```

The optional fixture directory must contain `prison.konkr` and
`escalating-quickly.konkr`. They are read in place, never copied into the repo.
Without the variable, the test runs cold boot but explicitly reports that the
four supplied-map/difficulty import cases were not run. Browser tests require
the exact Chromium version in `runtime/manifest.json` and fail if it is missing.
Set `KONKR_REFERENCE_SCREENSHOTS` to an ignored/local output directory to capture
the four actual Play screens. The Prison Hard case also ends one turn through
the original controller and waits for the original AI to return turn 2 to the
player; this is a smoke check, not a determinism or replay-validity proof.

`prepare-runtime.ts` verifies all pinned release inputs before writing ignored
`.runtime/2.35.30/`. It rejects changed bundles, ambiguous insertion anchors and
unlisted assets. Serve that generated directory from a fresh local origin; do
not reuse the upstream release's HTML or service worker.

## The patch and isolation

One required call is inserted into the generated main bundle after its entry
module imports and before platform/Firebase initialization:

```js
globalThis.__konkrCommunityPrepare(i, S);
```

The checksum-bound bootstrap replaces external-service initialization and error
reporting with local adapters. Merely setting configuration flags would not
work: the original Firebase facade unconditionally initializes auth, Firestore,
analytics and recurring remote-config fetches. Rule, AI, reducer, controller and
map-import code are unchanged. The reference skips the first-visit tutorial to
allow explicit map import; this does not alter gameplay.

Two pinned remote font sources in the generated bundle are replaced with local
Arial/Georgia fallbacks. Three external auth-icon URLs are removed from the
generated login HTML template. All five references attempted external loading
in the first browser proof; these explicit cosmetic adaptations eliminate the
requests before CSP, and leave the original assets intact.

The community HTML contains no original update/cache-purge boot code. CSP
restricts resources to this local origin, and browser tests independently deny
external requests, block service workers and start with clean browser storage.
Tests fail on attempted external requests, CSP violations, runtime errors or
game console warnings. Chromium's software-renderer ReadPixels performance
notices and the original PlayUIScene's exact "Updating controls to fit screen
size" notice (which upstream logs at warning level) are counted separately.
The AI smoke check also reports the original SituationExplorer/BlockDefensePlanner
warnings for candidate plans the engine discards before continuing. These known
planning branches remain unchanged; any other warnings or runtime exceptions
fail the test. These controls apply before original startup, not afterward.

## Reference API

After `window.communityReference.ready`, the local harness exposes:

- `importMap(encodedMap, "normal" | "hard")`: selects difficulty before invoking
  the real `parseKonkrData` session/import flow; this starts a new game and must
  not be used for resume.
- `inspect()`: returns a compressed JSON state and session difficulty.
- `play(factoryName, payload)`: invokes an original `Plays` factory through the
  original state controller, for trusted reference tests only.
- `act(factoryName, payload)`: sends an original `UserActions` event through the
  UI event bus. Use `act("EndTurn", {force: true})` to exercise the complete UI/AI
  transition; applying the bare reducer play does not switch the UI to its
  spectator mode or automatically drive all AI turns.
- `exportHistory()`: exports the original history for comparison fixtures.
- `withEngine(callback)`: after readiness, passes the typed
  `ReferenceModuleLoader` to trusted addon code for navigation, subscriptions,
  fixture codecs and session integration. It provides no validation authority;
  the client and its exposed original development hooks are always tamperable.
- `errors`, `blockedRequests`, `disabledServices`: local diagnostics.

The reference play/history hooks are not a security boundary and do not prove
validity, complete recording, deterministic AI parity or an honest win. Those
remain downstream gates. Module IDs and the single insertion belong to this
exact build; an upstream update must fail preparation until explicitly reviewed.

Public gameplay must keep one unchanged URL. The import test checks that the
original map-import path does not change it. Catalog, victory/exit routing and
broader history interception remain the later frontend bridge's responsibility.

## Observed verification

On 2026-09-26, Node 26.4.0 / Playwright 1.63.0 / Chromium 153.0.8010.12 passed
type checking and all six reference tests, including both supplied maps on both
difficulties and the Prison Hard turn-2 smoke. All four imported Play screens
rendered; their screenshots were saved outside tracked files and the Prison
screen was visually inspected. No original-service requests, CSP violations,
local-resource failures or runtime exceptions occurred. The exact upstream
layout/AI planning notices and software-renderer diagnostics described above
were reported separately. This is boot/import/controller evidence, not completed
game validation or independently verified deterministic replay parity.
