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

### Initial resource measurements

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

Unsupported until reviewed: landing setup, scripted/custom-rule maps, and any
plugin sequence absent from the injected reviewed support policy. The map parser
also rejects fixed-difficulty files because the original file importer ignores
that field while the UI may hide its difficulty switch.
