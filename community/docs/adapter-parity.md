# Direct Node adapter

Status: the direct Node adapter matches the repeated pinned-browser corpus at
every recorded player and AI/neutral checkpoint. No release support policy is
granted here; modifier coverage and independent boundary review remain separate.

The adapter evaluates the original hash-pinned 2.35.30 webpack bundles. It removes
only the two application entry dispatches and exposes the existing webpack loader.
Both original files remain unchanged. The manifest and adapter independently check
the expected main/vendor hashes and the exact startup anchor before evaluation.
`engineHash` is the pinned main digest; its adapter implementation additionally
pins the vendor digest. Updating either requires a new reviewed adapter version.

`GameStateController` (8058), `GameStateModel` (66944), reducer (67840),
`AIController` (84989), `DefaultAIDataLayer`, `ViewsManager` (84165), phase logic,
rules, plugin hooks and serialization are the original implementations. The small
phase loop follows the gameplay branches in `handleFactionTurnStarted` (5378),
without constructing its Phaser UI. It captures the first engine GameOver state;
later presentation/spectating continuation cannot alter the result.

Every session receives a fresh module context, caches, original event bus,
original RNG, and in-memory storage. Difficulty is set before map import so the
original Normal modifier is applied correctly. Defaults are an explicit RNG seed
of zero and a fixed per-context session identity. A trusted server seed may replace
zero. No replay snapshot is ever loaded after the canonical initial map.

The platform preserves `flags.mergeMutations: true` from the pinned production
configuration (5964). This is gameplay behavior, not an optional optimization:
`StateEngine` (76223) defers updates until a transaction commits. Capture handling
(52798/20598/77022) reads region liveness inside that transaction before applying
all queued changes. Immediate mutation changes tile history and consequently
diplomacy. The regression test evaluates the original configuration factory with
only its host/presentation dependencies replaced, then checks the adapter's value.

An independent audit followed all 266 modules loaded by both supported map paths
(Prison and the ordered gift modifiers), including bare configuration aliases and
destructuring. The engine reads only the batching flag and these diagnostic
settings: `debug.ai` (controller/AI), `recordStateChanges` and
`integrityChecks?.gameState` (model), and `gameHistory` (history). The adapter
preserves production values: false, false, undefined, and undefined respectively;
the transitively loaded cheat setting also remains false. No other top-level
platform default is consumed by these simulation paths. Transitively imported
`halloween` and `portableMode` references select presentation themes or campaign
unlocking and are not called when simulating imported canonical maps. They remain
absent, as do application URL/reporting, autosave, antialiasing and screen-transition
configuration. New recovered execution paths require another configuration audit.

The explicit presentation adapters are audio output, diagnostic display and
breakpoints, and the asynchronous rendering-yield hook. The app's genuine play
context and session IDs remain present because victory and cancellation checks
read them. Missing services throw. `window`, `document`, `fetch`, Phaser, browser
storage and application startup are unavailable. The [Node VM documentation](https://nodejs.org/api/vm.html)
describes VM contexts as execution contexts, not security boundaries; the public
validator runs this trusted code inside a separately limited worker.

Canonical map bytes and their content hash remain unchanged. A production run may
replace only the in-memory `map.levelId` with the shared binding-derived identity,
isolating local saves and avoiding campaign registry collisions. Reference
fixtures without a run binding keep their original IDs. The identity equivalence
test compares a legal trajectory while allowing only this expected field change.

Raw snapshots retain every field. `gameplayState` omits only `regions[].name`
when comparing trajectories or hashing a result. The original region-name
generators (66810/99999) consume the platform RNG (50061), also used by UI chatter;
repeated fresh browser runs of the tiny defeat generated different labels with
identical gameplay. Gameplay random helpers seed from turn and hex IDs, and the
region label is not a gameplay seed or ordering key. The fixture manifest records
this evidence. No other field is normalized, and no collection array is sorted.
Changing this projection is an adapter protocol change requiring review.

## Verification

Run `npm test -- tests/adapter-parity.test.ts` and `npm run build` from `community/`.
During isolated branch development `KONKR_REFERENCE_ROOT` may point at the reviewed
runtime worktree. After integration the default is this repository's manifest.

Observed parity covers fresh complete tiny wins, defeat, unfinished play and
genuine surrender in both difficulties, plus Prison's first round and Escalating
Quickly's first two rounds. Each browser case was captured twice in fresh browser
contexts. The test requires both repeat hashes, compares each checkpoint with
first-difference diagnostics, then matches the canonical projected trace digest.
Legacy replay extracts are not accepted as reference wins. Separate tests verify
checksum rejection, import without app/Firebase execution, fresh module isolation,
and namespaced identity equivalence for the tiny case and both supplied maps.

`tests/fixtures/prison-four-turn-checkpoints.json` adds eleven semantic decisions
and 36 complete gameplay-state digests through the end of turn four. These states
were reproduced in two fresh pinned browser sessions: one complete game capture
and one shorter capture containing all 109 committed native states. The canonical
map bytes are reused from the base corpus and checked against the fixture's hash.
The test executes all decisions through the public legality boundary. Disabling
mutation batching reproduces the first mismatch at checkpoint 30, AI faction 2
on turn four; retaining production batching matches every checkpoint. No tile
history, credit, collection ordering or other gameplay field is omitted.

### Initial resource measurements before the context optimization

Fresh Node processes on macOS arm64, Node 26.4.0, produced these illustrative
measurements under local development load. Elapsed time includes loading the
bundles, creating a fresh context and running all decisions. Peak RSS is the
process high-water mark, including Node and bundle memory, not just V8 heap.

| Case | Elapsed | Peak RSS | Attempted native plays |
| --- | ---: | ---: | ---: |
| Tiny Hard victory | 176 ms | 148 MiB | 1 |
| Prison Normal, one round | 2952 ms | 227 MiB | 50 |
| Prison Hard, one round | 2822 ms | 228 MiB | 50 |
| Escalating Quickly Normal, two rounds | 995 ms | 207 MiB | 56 |
| Escalating Quickly Hard, two rounds | 1015 ms | 211 MiB | 56 |

The parity test reports per-case elapsed time and process peak RSS on every run.
Its peak is cumulative across cases, so it must not be mistaken for isolated
per-case memory. To reproduce a fresh-process sample from `community/`:

```sh
node --input-type=module <<'JS'
import { readFile } from 'node:fs/promises';
import { createEngineSession } from './engine/adapter.ts';
import { loadEngineSources } from './engine/platform.ts';
const { cases } = JSON.parse(await readFile('./tests/fixtures/base-cases.json', 'utf8'));
const fixture = cases.find(entry => entry.id === 'prison-first-turn-hard');
const start = performance.now();
const game = createEngineSession(await loadEngineSources(), fixture.encodedMap, fixture.difficulty);
for (const decision of fixture.decisions) {
  if (decision.kind !== 'end-turn') throw Error('This sample measures end-turn fixtures');
  game.executeInternal('EndTurn');
  await game.settleOpponents();
}
console.log({ milliseconds: performance.now() - start,
  peakRssMiB: process.resourceUsage().maxRSS / 1024, plays: game.internalPlays });
JS
```

These short traces establish extraction feasibility, not production throughput
or a worst-case bound. Long winning runs, concurrency and pathological maps still
belong to the release benchmark. Worker limits remain provisional until then.

### Longer workload and isolated-global optimization

A private diagnostic converted only player decisions, identified from each
step's preceding faction, from the selected unverified Prison legacy extract.
It replayed 79 decisions and eleven turn endings from the canonical supplied map.
The current engine completed 1,278 attempted native plays and produced an offered
surrender victory on turn twelve. The earlier context exceeded a 60-second worker
deadline; a CPU-profiled run finished in 70.5 seconds with 386 MiB peak RSS.

The CPU profile located substantial cost in the original engine's repeated
global `Boolean`, `Array` and `Math` calls. Node's contextified object wraps global
lookups. The adapter now creates a fresh realm using
[`vm.constants.DONT_CONTEXTIFY`](https://nodejs.org/api/vm.html#vmconstantsdont_contextify),
then assigns exactly the same explicit platform globals. The engine code,
gameplay, module isolation and disabled string/Wasm generation remain unchanged.
This creates an ordinary realm global, closer to the browser's global behavior.

The full diagnostic then completed in 29.9 seconds with a 512 MiB heap ceiling
(380 MiB peak RSS), and 29.7 seconds with a 256 MiB heap ceiling (363 MiB peak RSS).
Both produced exactly the same current-engine final hash and native-play count
as the earlier context. A separate unprofiled first-turn comparison improved
from 2.23 seconds to 1.25 seconds. Profiling itself adds overhead, so the full-run
times are workload observations, not a controlled speedup claim.

An independent current-browser replay of those 79 decisions exposed a separate
adapter configuration error: the original mutation-batching flag was missing.
The first mismatch occurred at native move 83 (`pawnId: 213` to hex 1913), despite
identical preceding states and native plays. Node applied connected-region changes
too early, omitting dead-hex history for 1814 and 1914; diplomacy then diverged.
Restoring production batching fixes every one of the full trace's 136 checkpoints.
Both the current-browser and Node final gameplay states have SHA256
`3daa285fcc827f0ef83b9868ea2c2577326f43980aa49b26a34679c5ad89b47f`, with victory on
turn twelve. That state also matches the selected legacy final snapshot after the
existing region-name projection. The originating legacy build remains unknown,
and this compatibility evidence does not authenticate or grant a server score to
the old replay. The full current-browser run emitted two missing-sprite renderer
warnings; source review located only presentation recovery from already-computed
engine state, with no simulation mutation in that path.

The corrected full trace completed in 26.3 seconds with a 512 MiB heap ceiling
during the local checkpoint comparison. A separate instrumented run with the
production namespaced map identity finished in 33.3 seconds under concurrent local
test load with 303 MiB peak RSS; its final state also matched the legacy snapshot
after applying the same identity. The original repeated-browser corpus,
the new four-turn regression, and all boundary/modifier checks pass together
(23 tests), including disabled dynamic string generation. Local measurements
support a provisional 120-second worker deadline, 512 MiB V8 heap ceiling and
one concurrent worker. A heap ceiling is not an RSS ceiling; deployment still
needs its separate process/container memory and queue limits. The earlier timing
figures above describe the diagnosed adapter before the batching correction.

Unsupported until reviewed: landing setup, scripted/custom-rule maps, and any
plugin sequence absent from the injected reviewed support policy. The map parser
also rejects fixed-difficulty files because the original file importer ignores
that field while the UI may hide its difficulty switch.

### Happy Present five-turn outcome regression

The user-supplied `happy_present-5t Mein.konkr` is preserved in
[the fixture evidence](../tests/fixtures/happy-present-five-turn-evidence.json),
with its original SHA-256. The [focused test](../tests/happy-present-replay.test.ts)
extracts 42 player decisions, including four turn endings, using the preceding
step's faction. It reconstructs AI actions rather than executing recorded AI
moves, and never restores a later snapshot. The pinned engine independently
reaches player victory on turn 5; the final purchase is required for victory.

This is a **trusted compatibility test, not public validation approval**. The
replay's initial map explicitly specifies `destroy-haunted-towns` and
`defeat-all-rivals` victory conditions. The public map schema currently rejects
`winConditions`, and a separate regression asserts the public adapter returns
`invalid / malformed-input`. The compatibility test initializes the existing
platform and then loads the exact first snapshot with those original conditions
before playing any move. Production code, admission policy and game rules have
not changed.

Two fresh pinned Chromium runs also reached turn-5 victory, each producing 55
checkpoints. They did **not** establish full state parity: their first difference
was checkpoint 10, after player decision 6 (zero-based), in faction 4's diplomacy
credit toward faction 1. The supplied legacy final snapshot also differs from
the Node result in this value. This gameplay field was not filtered out; only
cosmetic region names were excluded from comparison. The cause remains open,
and matching victory/turn count does not resolve it or authenticate the export's
unknown originating build.

Both browser captures retained the original renderer warning about missing pawn
49; there were no page errors or external requests. The strict browser harness
initially rejected that warning. Diagnostic captures retained it explicitly;
these are not claims of warning-free strict-harness passes. The evidence records
both trace hashes, outcomes, warning text and the first differing values.

Reproduce the backend checks with
`npm test -- tests/happy-present-replay.test.ts`; no Downloads files, browser or
database are needed. Explicit victory-condition support and the diplomacy
variation need separate investigation before accepting this map publicly.

### Occupation nineteen-turn worker regression

The supplied `replay-2026-06-18-occupation-19t.konkr` records Normal difficulty,
90 player decisions and 18 turn endings, ending with acceptance of surrender.
[The compact fixture](../tests/fixtures/occupation-nineteen-turns.json) retains
the first snapshot, semantic player decisions, source-file SHA-256 and observed
worker result. AI actions, later snapshots and the filename's claimed score are
not validator inputs; player actions were identified by the preceding faction.

The [regression](../tests/occupation-replay.test.ts) uses the actual
`NodeSimulationAdapter` worker with all normal legality and surrender-offer
checks. With an explicitly test-only `capture-towns` policy, it returns
`verified / victory / turns: 19` and the recorded full gameplay-state hash.
The initial diagnostic completed in approximately 11.8 seconds. Removing the
final acceptance must instead produce an unfinished turn-19 result.

The community service's support policy still rejects this configuration as
`unsupported / configuration-not-reviewed`; the test covers that restriction
separately. No production rules or support list changed. This extends outcome
coverage under Normal difficulty, not public publication eligibility, proof of
the legacy export's originating engine, or fresh browser state-parity coverage.
A full compatibility review is still required before enabling `capture-towns`
in the service. Reproduce with `npm test -- tests/occupation-replay.test.ts`.
