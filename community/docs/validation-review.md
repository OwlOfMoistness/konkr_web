# Independent simulation and recording review

Initially reviewed on 2026-09-26. The short-corpus simulation, strict
player-command boundary and client recording review passed for the exact matrix
and commits below, permitting dependent service work. That historical approval
is superseded by the open long-trace gate described next; it is not a current
approval for verified statistics or public deployment.

## Follow-up: long-trace gate reopened, 2026-09-26

A fresh current-browser execution of the 79-decision Prison branch differs from
the Node execution at turn 4, faction 2, in gameplay bookkeeping including
`hexHistory` and credit fields. The mismatch is under investigation. The earlier
short traces remain reproducible evidence, but they do not establish parity for
this longer trajectory. Keep submissions and verified statistics disabled by
default. A correction needs repeated current-browser comparisons, the existing
adversarial/regression suite and independent review before this gate closes.
Do not exclude the differing gameplay fields to make the comparison pass.

The diagnostic browser capture also reports missing pawn IDs 245 and 286.
Inspection of the pinned 2.35.30 main bundle identifies these as presentation
warnings: module `54029` (`playPawnMove`) looks up a rendered pawn through
`PawnsManager.getById`; module `74742` implements that lookup against its sprite
dictionary `pawnsById`, not the engine pawn collection. Caller `54231` passes
already-computed `update.stateAfter`. On a missing sprite, the warning path calls
`handleNonFatalError` and, outside the debug overlay, `WorldMapScene.syncState`.
Module `71472` rebuilds presentation objects from that state through a
`StaticGameStateModel`; no controller play, reducer or gameplay-state setter
occurs in this warning/recovery path. The precise animation timing that lost the
sprite is not yet established. These source findings do not explain or excuse
the Node/browser bookkeeping divergence. Keep the warnings visible and retain
them in diagnostic evidence rather than suppressing them.

The production resource envelope also remains open. Docker execution,
container restore drills and actual Jekyll output inspection remain unverified
in the current local environment. No release or deployment pass is issued.

## Reviewed changes

The commit identifiers below identify the authors' changes, before their
coordinator/reviewer cherry-picks. The review used those committed changes in an
isolated worktree, read the tests and implementation, and reran the checks.

| Area | Reviewed commit |
| --- | --- |
| Original-engine Node adapter | `c710fa50fa1446daba52c8560319a2ad2f4dd12f` |
| Strict player-command and worker boundary | `4d7427e472d636bd623d8bdae4285445b0b0e5d7` |
| Exhausted-unit regression | `02772e63e46bdb04933776466292df7e72da9118` |
| Gift evidence and executable support policy | `9796b4a5638d42b6d9b35b2ca6f4fdb6dabeaae9` |
| Client recording and local retry storage | `c9f8f0f6aefb3e10e732c0058b22480eb78982e6` |
| Catalog launch lifecycle dependency | `e7fc08b366843f13d3aae96092f990cc68e35f51` |
| Catalog composition hook dependency | `380c6b676ec234d26831187572f0e188d249e207` |
| Base browser evidence | `6043e4e937b6044df8390d2055ceae6681b09f40` |
| Concurrent runtime preparation dependency | `b83e32669ea94db10f8280c2ea135da657671ce8` |

The reviewer authored the browser harness/base-fixture work, but did not author
the reviewed Node adapter, strict command boundary, modifier policy or client
recorder. The independent work here is review and reproduction of those changes;
the simulation deliberately reuses the original engine rather than a separately
written interpretation of its rules.

## Exact approved matrix

The executable policy is [supported-configurations.json](../shared/supported-configurations.json).

| Ordered map plugins | Normal | Hard |
| --- | --- | --- |
| `[]` | Approved | Approved |
| `["spawn-gifts", "buy-gifts"]` | Approved | Approved |

Approval applies to adapter `konkr-node-1`, release `2.35.30`, main SHA-256
`29377f4e0a30607db86558af7f09cfe546dca5e9993fb87060fdb2eb160cd98a`, and vendor
SHA-256 `e52e1a4f98527997624db96fe72a7d3a2c366c6b8861c8d24371a0b8f39f34c1`.
The browser evidence used Playwright `1.63.0`, Chromium `153.0.8010.12`; the
independent Node checks ran on Node `26.4.0`. See the complete input manifest in
[runtime/manifest.json](../runtime/manifest.json).

The reversed gift order, either gift modifier alone, zombies, landing setup,
always-retreat, buy-towns, capture-towns, low-upkeep and all other combinations
remain unsupported. Scripted/custom-rule maps, custom AI, custom win conditions
and fixed-difficulty imports remain outside the accepted schema. Recognition by
the map parser is not support approval. A changed engine, vendor, adapter,
projection or plugin policy requires renewed evidence and review.

## Evidence and checks actually completed

[Base fixtures](../tests/fixtures/manifest.json) contain 14 cases and 68
checkpoints: both difficulties have complete wins, purchase-then-win, AI defeat,
genuinely offered surrender, unfinished play, Prison's first round and Escalating
Quickly's first two rounds. Each case was captured twice in fresh original-browser
contexts. The fixture integrity/fresh-browser reproduction suite passed all 18
checks. Histories begin at the freshly imported map before any decision; later
snapshots never repair a divergent simulation.

[Modifier fixtures](../tests/fixtures/modifier-cases.json) contain two additional
cases with 16 checkpoints each. In each difficulty, the player buys a present at
hex 704 from region 16 for the original price of ten coins, then ends two turns.
The evidence includes treasury reduction and new gifts in both neutral phases.
Each case was captured twice by the author. The reviewer separately replayed
both cases in fresh pinned browsers without rewriting the fixtures; every
projected checkpoint and complete trace hash matched the committed evidence.

The independent combined adapter/boundary/modifier suite passed **21 checks**.
It compares the initial state, every recorded player decision and AI/neutral
turn, and the first engine terminal state. Public worker results agree with the
browser's winning turn count and final gameplay-state hash. Namespaced catalog
identities preserve the tested trajectories apart from the intended map ID.

The command-boundary review covered strict semantic parsing, current player
ownership and phase, native movement/drop rules, original shop inventory/prices,
treasury, tapped units, genuine surrender offers, rejected trailing commands,
map/version/plugin bindings, worker termination and failure classification.
Adversarial checks reject reordered winning sequences, opposing pawns, internal
commands, snapshot/tap/price injection, fabricated surrender and illegal special
purchases. Removing a final winning move produces an unfinished result. A separate reviewer counterexample
confirmed that a legal nonterminal knight conquest exhausts the pawn and rejects
a second conquest; the author retained it as the exhausted-unit regression.

The independent recorder suite passed **5 checks**, including a real browser
run across the 14 base cases. It verified prior-faction attribution, AI exclusion,
undo and cross-turn rewind, surviving-branch replay equality, reload/resume,
stable submission identity, six actual victories queued, and unchanged player
URL. It also checked incomplete/cropped saves, unexpected history replacement,
local-storage failures and pending-result persistence. Client saves, outcomes
and recordings remain untrusted inputs to server validation.

Original release files were not modified. Browser runs used fresh storage,
blocked service workers, denied external requests before boot, and reported no
unexpected game errors or external-service requests.

## Deliberate exclusions and remaining gates

Raw checkpoints preserve their fields and order. The only gameplay comparison
exclusion is `regions[].name`: the original label generators consume the shared
UI RNG, and repeated browser defeat traces differed at that label while all
gameplay fields matched. The source-backed rationale is recorded in
[adapter-parity.md](adapter-parity.md). No arrays are sorted; no money, units,
turns, factions or plugin ordering is excluded.

The selected Sherwood and profile Prison replays are compatibility material,
not validated wins. Their originating engine builds are unknown. Only selected
replay steps and difficulty metadata are committed, not profile progress,
preferences or statistics. The Prison extract ends in accepted surrender on
turn 12; that observation alone does not prove a valid complete run.

The production resource envelope is **not closed**. After this review, the
coordinator reported that the selected legacy Prison trace, reduced to 79 player
decisions, exceeded a 60-second local validation deadline; the adapter author is
investigating. This report did not independently reproduce or classify that long
trace. The timeout neither invalidates the completed differential comparisons nor
establishes correctness through the uncompleted trace. Production time, memory,
concurrency, queue and retention limits require representative long-run and
worst-case measurements. Timeouts must remain infrastructure errors, not wins or
allegations of invalid play.

The service must still resolve authoritative run/map bindings, enforce anonymous
token ownership, expiry, quotas and idempotency, and count an accepted run once.
Publication, run issuance and validation must receive the same reviewed policy;
permissive test policies must not reach assembly. Database/job atomicity,
operational metrics, backup/restore, packaged isolation, full end-to-end flows,
release sizing, distribution permission and public deployment authorization
remain separate execution-plan gates.

## Reproduction

From `community/`, with the pinned dependencies installed:

```sh
npm run build
npm test -- tests/adapter-parity.test.ts tests/validation.test.ts tests/modifier-parity.test.ts
PLAYWRIGHT_BROWSERS_PATH=/path/to/pinned-cache npm test -- tests/recording.test.ts tests/fixture-import.test.ts
```

The first two commands reproduced the independent combined check. The recorder
and fixture suites were run separately during review; the final command groups
the same suites for convenience. The runtime preparation lock permits their
concurrent use of unchanged generated files.

To repeat the reviewer's additional browser comparison without changing fixtures:

```sh
PLAYWRIGHT_BROWSERS_PATH=/path/to/pinned-cache node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { referenceHarness, captureCase, gameplayProjection, hash } from './scripts/import-fixtures.ts';
const corpus = JSON.parse(await readFile('tests/fixtures/modifier-cases.json', 'utf8'));
const harness = await referenceHarness();
try {
  assert.equal(harness.browser.version(), corpus.browserVersion);
  for (const fixture of corpus.cases) {
    const actual = await captureCase(harness.browser, harness.baseURL, fixture);
    assert.deepEqual(gameplayProjection(actual.checkpoints), gameplayProjection(fixture.checkpoints));
    assert.equal(hash({ checkpoints: gameplayProjection(actual.checkpoints), outcome: actual.outcome }), fixture.repeatHashes[0]);
  }
} finally { await harness.close(); }
JS
```
