# Custom Maps community site — execution plan

**Status:** local implementation and release proposal complete; public deployment decisions remain open
**Execution authorization:** approved by the user on 2026-09-26; local implementation, scoped commits, isolated branches/worktrees and reviewed integration may proceed. Public deployment remains separate.
**Prepared:** 2026-09-26

## Outcome and agreed scope

Build a separate community site using a fixed copy of the existing compiled Konkr release. Preserve gameplay, add a fifth **Custom Maps** title-screen button, and let players browse curated maps, inspect previews, play through the existing import path, and return to the catalog. Maintain ratings, verified completion counts and fewest-turn records using server-side simulation.

Decisions already supplied by the user:

- Reuse the compiled frontend and its map-import/session path; do not recreate gameplay or infer AI from examples.
- Keep the public player experience on one unchanged URL across the title screen, catalog, map details, gameplay and return; use internal view state rather than path/query/fragment navigation. The curator access point may remain separate.
- Target an efficient server adapter around the recovered simulation and AI. A browser running the same fixed release is the compatibility reference.
- Public players are anonymous: no sign-up, login or named-player leaderboard in this version.
- Score by fewest turns, separately for equivalent map revision, difficulty and engine/rules.
- Provide protected curator access for uploads, metadata edits, publication and removal.
- Disable or replace the original game's cloud integrations.
- Agents may make scoped Git commits and use isolated branches/worktrees or a repository fork when necessary, then integrate reviewed work.
- The user has reviewed this plan and authorized execution. Keep changes to existing game/website code strictly necessary so the original developer can review and reuse the contribution easily.

The delivered feature must include title/tag search and filtering, sorting by rating/completions/name/newest, list/grid views, map details and preview, creator attribution, automatic catalog return, map curation, anonymous ratings, complete run recording and authoritative result processing.

Out of scope: changes to game rules or AI, multiplayer, public accounts, a replacement map editor, social comments, real-time speed records, proof of human-only/no-rewind play, automatic upstream contribution, and automatic public deployment.

## Evidence and fixture inventory

The following inventory records the initial planning inspection. Implementation
and validation results appear under **Implementation progress** and in the
[simulation review](../../community/docs/validation-review.md); the initial
uncertainties below are retained as provenance, not current gate status.

| Evidence | Planning consequence |
|---|---|
| [Repository README](../../README.md) identifies a Jekyll website; [About](../../pages/01-about.md) says the game is not open source. | Current editable game source/build project is unavailable. Public distribution permission remains a separate release decision. |
| [_includes/game.html](../../_includes/game.html) selects release 2.35.30 and its compiled bundles. | Pin the complete release and keep the originals intact; generate reproducible, guarded adaptations. |
| Current bundle contains map import, title UI, return navigation, simulation, AI and development hooks. | A small frontend bridge is plausible; its operation still needs a real browser proof. |
| Drag/drop calls `parseKonkrData()`, which loads a session, clears existing map progress and recalls difficulty. | Reuse import for new games, but provide explicit difficulty and separate resume handling. |
| Normal difficulty adds an AI modifier; Hard uses baseline behavior. | Reuse the actual AI and prove each mode; do not assume changing only a label changes the simulation correctly. |
| Replay playback can restore submitted snapshots, recover from errors and export cropped history. | Replay viewing is not authoritative adjudication; capture complete player intent and use a strict simulation boundary. |
| Replay schema v7 does not identify a specific engine build. | Format, engine and adapter versions need distinct identifiers. |

User-supplied inputs are local external fixtures, not repository source. Locate them by the filenames below; do not assume a new worktree contains Downloads files, and do not commit the full profile.

| Input | Observed contents | Use and limits |
|---|---|---|
| `prison.konkr` | Schema-v7 map, 24×25, no map plugins. | Ordinary-map import, preview and gameplay fixture. |
| `escalating-quickly.konkr` | Schema-v7 map, 19×22, gift spawning/buying plugins. | Modifier import, preview and parity fixture. |
| `replay-2026-05-16-sherwood-4t.konkr` | Hard, 73 actions and 19 snapshots; ends at the start of turn 4. | Partial gameplay trace, not a victory fixture; engine build unspecified. |
| `player-profile-export-2026-09-26.konkr` | User-data v2: progress/preferences/statistics, one embedded `latestReplay`, and a stored custom-map starting snapshot. | Not a per-game replay archive. Extract only selected replay/map data for tests after implementation is authorized. |
| Profile's embedded latest replay | Prison, Hard, 328 actions; ends with `PLAY.ACCEPT_SURRENDER` on turn 12. | Candidate completed trace, not yet validated. The server must independently establish that surrender was offered. |

The Prison replay's initial state is not byte-identical to the supplied map; inspected region hex-list ordering differs. Diagnose initialization/serialization behavior before treating order as irrelevant. Cosmetic/collection normalization must not hide a gameplay divergence. Fresh pinned-build fixtures are necessary even if supplied recordings load successfully.

## Proposed architecture and contracts

Use a new `community/` workspace in this repository. Keep the existing website and original compiled release as the reference. Proposed implementation language is TypeScript, with a Node API/worker, PostgreSQL for metadata/results/jobs, and a storage abstraction for maps/previews/replays (local filesystem during development; managed object storage at deployment). Exact package versions, HTTP/UI libraries and hosting provider are selected during setup and release planning rather than guessed here.

The community frontend serves the fixed compiled game plus a small bridge. Catalog and curator interfaces can use HTML/CSS/TypeScript around the game surface. Invoke the real import/session path to play; route custom-map exit/victory back into catalog context. Do not depend on controlling a cross-origin tab on the official site.

The backend is one codebase with an API process and an isolated simulation worker. PostgreSQL can initially hold durable jobs as well as metadata. A dedicated queue service is not required unless measurement justifies it.

### Authoritative run boundary

1. The server issues a run binding to map identity/revision/hash, engine/configuration, supported difficulty and any required seeds.
2. The frontend records a complete ordered sequence of semantic player decisions and persists it through allowed undo/rewind/resume.
3. On submission, the server reloads its own canonical start and applies only legal player decisions. AI, bandits, zombies, gifts, other effects and victory are generated by the recovered engine.
4. Uploaded starting/final snapshots, opponent actions, internal tap/spawn flags, claimed turns and claimed victory are never authority. Legacy replay importing is a separate comparison/fixture path.
5. Only engine-confirmed wins update public statistics. Distinguish invalid, incomplete/non-winning, unsupported and infrastructure-error outcomes.
6. A verified run establishes a legal winning solution for this engine/configuration. It does not establish a unique human, absence of external assistance, or honest wall-clock time.

### Proposed product defaults for review

These defaults are explicit proposals, not additional user decisions:

- **Ratings:** 1–5 stars, one editable rating per server-issued browser token and gameplay revision; display the vote count. Do not require a win to rate, so difficult maps can receive feedback. Apply quotas; browser data resets can evade identity limits.
- **Completions:** count accepted winning runs once each, not unique people. Deduplicate retries of the same run and flag/rate-limit repeated submissions; do not promise anonymous anti-spam controls identify humans.
- **Best finish:** minimum simulated turn count for the revision/difficulty/compatible engine bucket, with shared ties and supporting replay evidence.
- **Versions:** metadata edits retain the challenge; gameplay edits create an immutable revision. Keep old results readable and in-flight runs pinned. Engine updates do not silently combine incompatible scores.
- **Saves:** local browser save/resume with complete recorded history; no cross-device sync. Keep the original undo/rewind behavior and validate the final canonical branch.
- **Removal:** archive/unpublish rather than destroying historical data. Prevent new starts while continuing to adjudicate eligible previously issued runs.
- **Curation:** private, authenticated curator/admin access is separate from anonymous public play. Draft → validated preview/playtest → published → archived.
- **Publication support:** only tested plugin combinations can be published as supported challenges. Gift rules are required for the supplied sample; zombie tags do not imply support until that ruleset passes parity.
- **Availability:** new catalog runs require a server binding before their first decision; if issuance fails, show retry. Already-issued games can continue offline and submit later. Preserve pending submissions and display honest catalog/verification errors.

### Feasibility and resource policy

T-adapter-core targets direct Node execution. Browser-only dependencies may prevent an efficient extraction. If it fails, deliver reproducible failure evidence plus a measured browser-worker alternative and return that architectural choice to the user. Do not silently rewrite AI, downgrade verification, or declare the entire feature blocked while unrelated catalog work can proceed.

For initial sizing, 1,000 submissions/day at an assumed 200 KB each implies approximately 6 GB/month of incoming replay data before cleanup. This is an illustration, not measured demand or a price estimate. Benchmark CPU, memory, queue delay and corpus sizes before choosing hosting or retention limits. Worker concurrency, time/turn/action limits and supported engine windows must be configured before release.

## Execution and Git discipline

The user approved execution on 2026-09-26. Implement the DAG in verified increments. Keep all addon code, runtime preparation patches, tooling and configuration under `community/` where practical; preserve original bundles and unrelated website files. Any necessary existing-code edit must have a specific integration reason and a small reviewable diff.

- The coordinator owns contract changes, shared dependencies, integration and plan status. Start with the short toolchain/contracts foundation, then run adapter/runtime work alongside catalog work. Use up to the available concurrency; independent review comes from someone other than the implementation author.
- Use `codex/custom-maps-<branch_suffix>` task branches and separate Git worktrees for concurrent writes. Forking when necessary is already authorized; a worktree is normally sufficient for parallel work in this repository. No fork or implementation branch is needed merely to write this plan.
- After user approval, commit the reviewed plan into the integration state before creating task worktrees so every agent receives it. Branch from that state after each declared dependency passes. Make small, task-scoped commits after relevant checks; include commit IDs, changed files, actual test results and limitations in handoff.
- Only the coordinator integrates/cherry-picks or merges reviewed task commits into the integration branch, after checking actual diffs. Serialize overlapping writes and integration. Do not force-push, rewrite unrelated history or merge unreviewed work into the existing default branch.
- The implementation checkout is `codex/custom-maps-integration`; existing untracked `AGENTS.md`, `.agents/` and `.skills-directory/` belong to the user's setup. Preserve them and never include them through broad staging. Downloads fixtures and untracked guidance are not automatically copied into worktrees; provide relevant instructions and approved selected fixtures explicitly.
- `files_write` is the task's ownership boundary. If more files or shared contracts are needed, the coordinator updates the plan/conflict declarations first and splits oversized tasks. Do not expand scope silently.
- Preserve kickoff/design, pre-merge, pre-release and post-release checks appropriate to this new service. No additional permission is needed for already-authorized local implementation and commits.
- Local task commits, necessary isolation/forks and integration of reviewed work are already authorized for the eventual implementation. Public deployment, paid infrastructure and contact with the original developer are separate actions; prepare concrete evidence before seeking any still-missing authorization.

## Execution DAG

Per-task `depends_on` is authoritative. The arrows below are generated from those dependencies; `||` highlights useful parallelism. Task completion is tracked below; unchecked tasks remain outstanding.

```yaml
dag:
  - T-toolchain → T-contracts
  - T-contracts → T-reference-runtime
  - T-contracts → T-catalog
  - T-contracts → T-map-format
  - T-contracts → T-object-storage
  - T-catalog → T-curator-access
  - T-curator-access, T-reference-runtime, T-map-format → T-map-import
  - T-map-import → T-publishing
  - T-reference-runtime → T-fixtures
  - T-fixtures → T-adapter-core
  - T-adapter-core → T-validation-boundary
  - T-validation-boundary → T-modifier-coverage
  - T-catalog, T-reference-runtime → T-game-launch
  - T-game-launch, T-fixtures → T-recording
  - T-modifier-coverage, T-recording → T-validation-review
  - T-catalog, T-curator-access, T-map-import → T-anonymous-ratings
  - T-validation-review, T-anonymous-ratings → T-run-submission
  - T-run-submission → T-verified-results
  - T-verified-results, T-recording → T-results-experience
  - T-publishing, T-results-experience, T-object-storage → T-local-assembly
  - T-local-assembly → T-operations
  - T-operations → T-release-review
  - T-reference-runtime || T-catalog
  - T-fixtures || T-game-launch || T-map-import || T-anonymous-ratings
  - T-adapter-core || T-recording || T-publishing
  - checkpoint: Foundation after [T-contracts]
  - checkpoint: Isolated reference after [T-reference-runtime]
  - checkpoint: Verified simulation after [T-validation-review]
  - checkpoint: Integrated local feature after [T-local-assembly]
  - checkpoint: Release proposal after [T-release-review]
```

Initial ready set after approval: **T-toolchain**. T-contracts follows; runtime and catalog then become independent. Every checkpoint requires actual evidence; failed validation pauses only dependent result-processing tasks.

| Gate | Pass evidence | Effect |
|---|---|---|
| User plan review | Passed: user approved execution with a minimal-existing-code-change constraint. | T-toolchain may proceed. |
| Foundation | Tooling works and shared contracts/defaults are understood. | Unlocks runtime/catalog branches. |
| Isolated reference | Fixed release imports maps and produces states without original-service traffic. | Unlocks adapter fixtures and real frontend integration. |
| Verified simulation | Independent review passes parity, recording round trips and adversarial validation. | Unlocks authoritative run submission and results. |
| Integrated local feature | Curator-to-player-to-verified-result flow passes with saves/navigation intact. | Unlocks release preparation. |
| Release proposal | Operational evidence and explicit distribution/hosting decisions still required before deployment. | Produces a reviewable proposal, not an automatic deployment. |

## Implementation progress

- [x] T-toolchain — isolated workspace and locked dependencies created.
- [x] T-contracts — strict semantic-input contracts; typecheck and 6 boundary/identity tests passed.
- [x] T-reference-runtime — isolated Chromium imports and player/AI turn smoke, 8 tests passed, including preparation lock/cache guards.
- [x] T-catalog — PostgreSQL queries and responsive same-URL catalog, 9 tests passed.
- [x] T-curator-access — protected local curator sessions, roles, CSRF and audit, 5 tests passed.
- [x] T-map-format — bounded data-only decoder and reference validation; both supplied maps plus malformed/resource-limit cases pass.
- [x] T-map-import — private immutable uploads, metadata/revision editing and concurrency checks, 7 tests passed, including real-browser upload/edit/preview/publish/archive and 320px layout.
- [x] T-publishing — support/preview/playtest gates and archive retention tested; both full-board previews inspected, 4 tests passed.
- [x] T-fixtures — 14 original-browser cases / 68 checkpoints, repeated capture and fresh reproduction, 18 tests passed; legacy exports explicitly unverified.
- [x] T-adapter-core
- [x] T-validation-boundary
- [x] T-modifier-coverage
- [x] T-game-launch — fifth button and binding-aware launch/restart/resume; actual browser navigation and ordinary-mode smoke passed.
- [x] T-recording
- [x] T-validation-review — production mutation batching restored; independent correction review passed and the full Prison comparison matches all 136 checkpoints through victory on turn 12.
- [x] T-anonymous-ratings — opaque browser sessions, editable revision-specific ratings and quotas; 5 database tests passed.
- [x] T-run-submission
- [x] T-verified-results
- [x] T-results-experience
- [x] T-object-storage — atomic private blobs with size/key/integrity checks; 2 filesystem tests passed.
- [x] T-local-assembly
- [x] T-operations — actual Linux container build, preview, verified finish, kill switches, populated backup/restore integrity and restart passed; hosted CI and optional Jekyll output remain unverified.
- [x] T-release-review — concrete local review proposal and remaining public-release conditions recorded with independent review provenance.

At integration commit `b8a5e742`, the complete local suite passed **123 tests,
zero failures and zero skips** in 183.1 seconds, using real PostgreSQL, pinned
Chromium and the supplied map fixtures. The integrated browser test exercises
curator upload/preview/publication, the fifth button, a server-validated win,
live rating totals and archive, while checking an unchanged player URL. Separate
tests cover the full save/rewind/resume and adversarial validation boundaries.
This is local evidence; the new CI workflow has not run on a remote service.

The [release proposal](../../community/docs/release-review.md) records the final
packaging evidence: the hardened container rendered a map, validated a real
finish and preserved its score through a populated database/blob backup and
restore check. All 11 tables and three blobs matched. The app restart used the
original disposable data, not the restored pair; old-image rollback and a timed
disaster-recovery exercise remain unperformed. Task completion here means the
authorized local deliverables and review are finished, not that the unchecked
public-release conditions below have been resolved.

## Task details

All paths below are repository-relative. The isolated `community/` toolchain and shared contracts are implemented; progress above records completed slices. Commands marked **Proposed** must be established by T-toolchain and verified against the actual scripts; they are not claims of existing or passing checks. Each task includes its own tests and should remain small/medium; split it before dispatch if inspection reveals a larger change. Database tests use disposable task-local databases, never shared production state.

### T-toolchain: Establish an isolated community workspace

```yaml
id: T-toolchain
depends_on: []
parallel_safe: false
conflicts_with: []
files_write: ["community/package.json","community/package-lock.json","community/tsconfig.json","community/.gitignore","community/AGENTS.md"]
files_read: ["README.md","_config.yml"]
branch_suffix: toolchain
scope: S
```

**Description:** Create the TypeScript workspace and test/build tooling for the community extension without changing the original game's behavior or build. Select supported dependency versions when execution begins and lock them.

**Acceptance:**

- [x] Provide working build and parameterized test commands used below; document the chosen Node/browser versions in package configuration.
- [x] Ignore generated runtime copies, local profiles, recordings, environment secrets, and scratch outputs. Preserve the original tracked release.
- [x] Keep dependency and lockfile changes owned by this task/coordinator; future agents request additions rather than editing these files concurrently.

**Verification:** Run a clean dependency install, build, and a minimal test-runner smoke check. Confirm existing website instructions still describe the original Jekyll site.

### T-contracts: Define map, run, and adapter contracts

```yaml
id: T-contracts
depends_on: ["T-toolchain"]
parallel_safe: false
conflicts_with: []
files_write: ["community/shared/contracts.ts","community/tests/contracts.test.ts","community/docs/protocol.md","community/shared/runtime-identity.ts"]
files_read: ["docs/plans/custom-maps-execution-plan.md"]
branch_suffix: contracts
scope: S
```

**Description:** Define the small shared interfaces before parallel work: catalog metadata/revisions, storage ports, curator operations, run envelope, high-level player decisions, adapter outcomes, and public result states. Use the trust rules in this plan.

**Acceptance:**

- [x] Separate format version, map revision/hash, engine bundle hash, adapter version, difficulty and rule configuration. The server resolves trusted starting data.
- [x] Specify semantic player decisions and an injectable executable SupportedConfigurations policy for engine/difficulty/plugin eligibility; do not expose arbitrary reducer events or client-controlled internal flags as authority. Record unresolved capture mapping for the runtime investigation.
- [x] Separate verified victory, valid unfinished/defeated play, invalid submission, unsupported configuration, and infrastructure failure. Document idempotency, save/resume, rewind handling and error display.
- [x] Define ratings and aggregate completion semantics without claiming unique human identity. Freeze the versioned contract before consumers start; changes return to the coordinator.

**Verification:** Proposed: npm --prefix community test -- tests/contracts.test.ts. Cover accepted envelopes, malformed data, size bounds, unsupported versions and outcome distinctions.

### T-reference-runtime: Run the fixed browser release in isolation

```yaml
id: T-reference-runtime
depends_on: ["T-contracts"]
parallel_safe: true
conflicts_with: []
files_write: ["community/runtime/manifest.json","community/scripts/prepare-runtime.ts","community/runtime/bootstrap.ts","community/tests/reference-runtime.test.ts","community/docs/reference-runtime.md"]
files_read: ["_includes/game.html","_site/releases/2.35.30/index.html","_site/releases/2.35.30/main.767a81ddb61f928b36d7.bundle.js"]
branch_suffix: reference-runtime
scope: M
```

**Description:** Prepare a reproducible local copy of release 2.35.30 and a browser harness. Reuse the exact engine; keep source bundles intact and apply any narrowly scoped changes through checksum-guarded preparation steps.

**Acceptance:**

- [x] Pin/checksum the main/vendor bundles, required assets, map registry, rule inputs and browser version. Fail clearly on an unexpected upstream bundle.
- [x] Disable or replace original authentication, cloud writes, analytics, error reporting, remote configuration/content and service-worker update paths before they can make external requests.
- [x] Prove new-map import through the existing session/import path, explicitly select Normal or Hard, and expose state inspection and player-action entry points.
- [x] Run with isolated storage and denied external network access; keep required resources local. Record cold-boot, import and state-read evidence.

**Verification:** Proposed: npm --prefix community test -- tests/reference-runtime.test.ts. Inspect attempted network requests, repeat cold boots, and import both supplied maps. Do not contact the original developer's services.

### T-catalog: Browse and search curated maps

```yaml
id: T-catalog
depends_on: ["T-contracts"]
parallel_safe: true
conflicts_with: []
files_write: ["community/api/catalog.ts","community/web/catalog.ts","community/web/catalog.css","community/db/001-catalog.sql","community/tests/catalog.test.ts"]
files_read: ["community/shared/contracts.ts"]
branch_suffix: catalog
scope: M
```

**Description:** Deliver a catalog slice from database/query API through list/grid UI using fixture records until the publishing workflow is ready. Include the map/revision/publication schema required by the agreed contracts.

**Acceptance:**

- [x] Search title, filter normalized tags and sort by name, rating, verified completions and newest; use stable pagination and tie-breakers.
- [x] Show list/grid modes, map details, creator attribution, rating count, difficulty-specific best turns and clear unverified/pending/empty states.
- [x] Preserve filters, view mode and scroll position across map detail and return navigation; keep controls usable on small screens and by keyboard.
- [x] Only published, supported revisions appear publicly; drafts and archived maps cannot leak through alternate query paths.

**Verification:** Proposed: npm --prefix community test -- tests/catalog.test.ts. Exercise query combinations, pagination, publication filtering and UI state restoration against isolated fixtures.

### T-curator-access: Provide protected curator access

```yaml
id: T-curator-access
depends_on: ["T-catalog"]
parallel_safe: true
conflicts_with: []
files_write: ["community/api/admin-auth.ts","community/web/admin.ts","community/web/admin.css","community/db/002-curators.sql","community/tests/admin-auth.test.ts"]
files_read: ["community/shared/contracts.ts"]
branch_suffix: curator-access
scope: S
```

**Description:** Provide the separate /admin/maps access point and server-enforced curator/admin roles. Public players remain anonymous. Use a development identity fixture locally and configure the real private-access provider before release.

**Acceptance:**

- [x] Unauthenticated requests cannot mutate maps; curators manage content and administrators manage curator access.
- [x] Protect cookie-backed mutations against CSRF; distinguish creator attribution from the authenticated maintainer.
- [x] Record auditable content actions without exposing credentials or private operator information in public responses.

**Verification:** Proposed: npm --prefix community test -- tests/admin-auth.test.ts. Test the role matrix and direct API attempts, not only whether buttons are hidden.

### T-map-format: Decode and validate data-only maps

```yaml
id: T-map-format
depends_on: ["T-contracts"]
parallel_safe: true
conflicts_with: []
files_write: ["community/engine/map-format.ts","community/tests/map-format.test.ts"]
files_read: ["community/shared/contracts.ts"]
branch_suffix: map-format
scope: S
```

**Description:** Extract bounded format decoding from the later curator workflow so it can be implemented while runtime/catalog work proceeds. Preserve original bytes and reject malformed or unsupported data before any engine execution.

**Acceptance:**

- [x] Decode v7 map data with compressed/decompressed size limits and strict JSON/data validation; reject invalid references and untrusted scripts/resources.
- [x] Preserve game-affecting field/collection order, content hashes and supported built-in plugin names. Format acceptance is distinct from independently proven engine support.
- [x] Both supplied maps pass format checks; malformed and oversized examples fail before reaching the runtime.

**Verification:** `npm --prefix community test -- tests/map-format.test.ts`; compare metadata against known input files without committing profiles.

### T-map-import: Upload and revise draft maps

```yaml
id: T-map-import
depends_on: ["T-curator-access","T-reference-runtime","T-map-format"]
parallel_safe: true
conflicts_with: []
files_write: ["community/api/maps-admin.ts","community/web/map-editor.ts","community/tests/map-import.test.ts","community/db/005-map-import.sql"]
files_read: ["community/shared/contracts.ts","community/runtime/manifest.json","community/db/001-catalog.sql"]
branch_suffix: map-import
scope: M
```

**Description:** Let a curator upload a map, inspect imported metadata, and edit title, description, creator and tags. Preserve original file bytes and separate stable map identity from immutable gameplay revisions.

**Acceptance:**

- [x] Bound compressed/decompressed size, dimensions and entity counts; validate the data schema and allowlisted plugin identifiers without executing uploaded code.
- [x] Keep uploads private until publication; reject unsupported formats/modifiers with actionable messages. Render descriptions as safe text.
- [x] Metadata edits do not overwrite game content. Gameplay changes create a new revision with separate results; record content hashes and maintain historical references.
- [x] Handle duplicate uploads, concurrent edits and conflicting embedded level IDs explicitly.

**Verification:** Proposed: npm --prefix community test -- tests/map-import.test.ts. Use both supplied maps plus malformed, oversized and unsupported fixtures; verify curator permissions and revision isolation.

### T-publishing: Preview, publish and archive maps

```yaml
id: T-publishing
depends_on: ["T-map-import"]
parallel_safe: true
conflicts_with: []
files_write: ["community/runtime/preview.ts","community/api/publication.ts","community/web/publication.ts","community/tests/publication.test.ts"]
files_read: ["community/runtime/bootstrap.ts","community/runtime/manifest.json","community/api/maps-admin.ts"]
branch_suffix: publishing
scope: M
```

**Description:** Generate and cache revision-specific thumbnails with the fixed renderer, then provide the curator's playtest/publish/archive workflow.

**Acceptance:**

- [x] Preview generation uses the exact stored revision in an isolated runtime and respects resource limits. Broken imports/previews cannot be marked ready.
- [x] Publishing requires valid supported content, successful preview generation and a curator's playtest acknowledgment; importing alone does not establish solvability. Test the injected support-policy contract with fixtures here; T-local-assembly supplies the independently reviewed executable policy before real publication.
- [x] Archiving removes discovery/new starts while preserving historical records and the ability to adjudicate already-issued runs against their pinned revision.
- [x] Both list and thumbnail views use the same metadata and cached preview assets; record audit events for publication changes.

**Verification:** Proposed: npm --prefix community test -- tests/publication.test.ts. Inspect previews of both sample maps and exercise draft-to-published-to-archived behavior and failed-preview recovery.

### T-fixtures: Build a reproducible replay comparison corpus

```yaml
id: T-fixtures
depends_on: ["T-reference-runtime"]
parallel_safe: true
conflicts_with: []
files_write: ["community/scripts/import-fixtures.ts","community/tests/fixtures/manifest.json","community/tests/fixtures/base-cases.json","community/tests/fixture-import.test.ts","community/.gitattributes"]
files_read: ["community/runtime/bootstrap.ts","community/runtime/manifest.json"]
branch_suffix: fixtures
scope: M
```

**Description:** Import only the selected map/replay material from the supplied files, and generate fresh reference recordings under the pinned runtime. The full player profile stays outside Git.

**Acceptance:**

- [x] Include Sherwood's partial Hard trace and the profile's latest Prison Hard surrender trace with provenance and compatibility marked unverified until replayed.
- [x] Collect fresh complete wins and non-winning traces for Normal and Hard, including legal surrender, defeat, and an unfinished run. Record exact runtime inputs.
- [x] Compare gameplay-relevant state after player actions and AI turns. Investigate ordering/cosmetic differences before excluding any field from comparisons.
- [x] Confirm history begins at the trusted start. Do not mislabel a cropped replay, a profile completion summary, or a client snapshot as proof of a win.

**Verification:** Proposed: npm --prefix community test -- tests/fixture-import.test.ts. Run the browser reference repeatedly and compare traces; summarize corpus coverage and gaps without committing personal progress/preferences.

### T-adapter-core: Reproduce ordinary gameplay in a server adapter

```yaml
id: T-adapter-core
depends_on: ["T-fixtures"]
parallel_safe: true
conflicts_with: []
files_write: ["community/engine/adapter.ts","community/engine/platform.ts","community/tests/adapter-parity.test.ts","community/docs/adapter-parity.md"]
files_read: ["community/shared/contracts.ts","community/runtime/manifest.json","community/tests/fixtures/base-cases.json"]
branch_suffix: adapter-core
scope: M
```

**Description:** Recover/reuse the actual bundled simulation and AI modules behind the agreed adapter interface, targeting Node.js. Replace browser-only services through explicit platform adapters without altering gameplay decisions.

**Acceptance:**

- [x] Match reference player actions, each AI turn, resulting gameplay state and turn count for Normal and Hard across repeated fresh runs.
- [x] Pin engine/runtime/adapter inputs and account for randomness, iteration order and session-dependent AI behavior. Never load later replay snapshots to repair divergence.
- [x] Document extraction steps, dependency assumptions and unsupported behavior; fail clearly on a changed bundle.
- [x] Measure representative execution time and peak memory. If direct extraction fails, report the smallest blocker and a measured browser-worker alternative; do not silently rewrite AI or change the architecture.

**Verification:** Proposed: npm --prefix community test -- tests/adapter-parity.test.ts. Produce first-divergence diagnostics and a reproducible comparison report. One matching replay is insufficient.

### T-validation-boundary: Validate permitted player decisions strictly

```yaml
id: T-validation-boundary
depends_on: ["T-adapter-core"]
parallel_safe: true
conflicts_with: ["T-modifier-coverage"]
files_write: ["community/engine/validate.ts","community/engine/player-commands.ts","community/tests/validation.test.ts","community/docs/validation-boundary.md"]
files_read: ["community/shared/contracts.ts","community/engine/adapter.ts"]
branch_suffix: validation-boundary
scope: M
```

**Description:** Turn the compatible simulator into a validator. Resolve authoritative map/run inputs server-side, validate semantic player decisions, and let the engine generate every AI/script effect and victory result.

**Acceptance:**

- [x] Check actor, phase, ownership, resources and legal actions; derive internal parameters such as tap flags. Validate that a surrender offer actually exists before accepting it.
- [x] Do not execute submitted AI moves, editor actions or arbitrary spawn events. Treat legacy replay snapshots/events only as comparison input through an explicit importer.
- [x] Reject altered starts/settings, reordered/illegal commands, false claimed victories and incomplete winning records; accept valid unfinished/defeated traces only as non-winning outcomes.
- [x] Enforce deterministic limits for input bytes, decisions, turns and runtime. Unsupported versions and infrastructure timeouts are distinct from cheating/invalid play; compute turns from simulation.

**Verification:** Proposed: npm --prefix community test -- tests/validation.test.ts. Include adversarial mutations of real traces, fabricated surrender, ownership/tap manipulation and false final snapshots; prove no rejected case enters results.

### T-modifier-coverage: Verify modifiers and publish the support matrix

```yaml
id: T-modifier-coverage
depends_on: ["T-validation-boundary"]
parallel_safe: true
conflicts_with: ["T-validation-boundary"]
files_write: ["community/tests/fixtures/modifier-cases.json","community/tests/modifier-parity.test.ts","community/engine/validate.ts","community/docs/plugin-support.md","community/shared/supported-configurations.json"]
files_read: ["community/runtime/manifest.json","community/runtime/bootstrap.ts","community/engine/adapter.ts"]
branch_suffix: modifier-coverage
scope: M
```

**Description:** Expand the comparison corpus and validator support policy to map modifiers. Require gift-rule coverage for Escalating Quickly and ordinary-map coverage for Prison; declare any other supported plugins only after parity checks.

**Acceptance:**

- [x] Generate and compare gift spawning/buying and combined modifiers at meaningful points on Normal and Hard. Exercise all modifiers accepted for publication, including zombies if offered.
- [x] Validate any player-controllable map setup, special purchase or surrender decision through the same strict boundary.
- [x] Publish a machine-readable, tested engine/difficulty/plugin policy plus the human-readable support report. Publication and run-start services must consume this policy through the shared contract at assembly; reject unsupported combinations rather than changing their rules.
- [x] Preserve earlier parity/adversarial results when extending support.

**Verification:** Proposed: npm --prefix community test -- tests/modifier-parity.test.ts tests/validation.test.ts tests/adapter-parity.test.ts. Record exact cases and unsupported combinations.

### T-game-launch: Add Custom Maps to the compiled frontend

```yaml
id: T-game-launch
depends_on: ["T-catalog","T-reference-runtime"]
parallel_safe: true
conflicts_with: ["T-results-experience"]
files_write: ["community/runtime/menu-bridge.ts","community/runtime/catalog-bridge.ts","community/web/custom-maps.ts","community/tests/game-launch.test.ts"]
files_read: ["community/runtime/bootstrap.ts","community/shared/contracts.ts","community/web/catalog.ts"]
branch_suffix: game-launch
scope: M
```

**Description:** Add the fifth title-screen button and connect the catalog's Play action to the existing import/session path. Keep gameplay and the other modes unchanged.

**Acceptance:**

- [x] Custom Maps is visible and usable on desktop and compact layouts; list/grid/detail selections open the exact requested map revision.
- [x] Set selected difficulty explicitly before constructing the map's plugins. Distinguish new import, restart and resume; avoid the importer's unconditional progress reset on resume.
- [x] Use revision-aware local identity and origin context so imported IDs cannot overwrite campaign/custom saves or cause a wrong return route.
- [x] Leaving or finishing a catalog game returns through the catalog flow with filters/scroll restored; ordinary modes keep their existing navigation. Verify win, defeat, restart and escape/menu paths.
- [x] The player URL remains exactly unchanged through catalog navigation, filtering, details, import, play, restart, resume and return. Keep state in memory/session storage; do not add history or hash routes.

**Verification:** Proposed: npm --prefix community test -- tests/game-launch.test.ts. Exercise real browser import and mobile/desktop navigation with both supplied maps; smoke-check Expeditions and Conquest.

### T-recording: Record complete runs across undo and resume

```yaml
id: T-recording
depends_on: ["T-game-launch","T-fixtures"]
parallel_safe: true
conflicts_with: ["T-results-experience"]
files_write: ["community/runtime/recording.ts","community/web/local-runs.ts","community/tests/recording.test.ts","community/docs/recording-protocol.md"]
files_read: ["community/shared/contracts.ts","community/runtime/catalog-bridge.ts","community/tests/fixtures/base-cases.json"]
branch_suffix: recording
scope: M
```

**Description:** Capture validated-format player intent before the ordinary replay export can truncate history. Persist a canonical final branch plus the pinned run metadata without changing the game's undo/rewind behavior.

**Acceptance:**

- [x] Record every relevant player decision, including valid surrender/setup choices, with ordered positions and fixed run configuration. Distinguish state-before/state-after faction metadata.
- [x] Undo/rewind replaces the active recorded branch consistently; restart begins a new run. Do not claim the history proves an absence of rewinds or outside assistance.
- [x] Save/reload/resume retains the original map revision, engine and complete canonical history. A missing history cannot be silently upgraded to a verified run.
- [x] Persist pending submissions locally, expose size/support errors and preserve catalog navigation while verification is pending.

**Verification:** Proposed: npm --prefix community test -- tests/recording.test.ts. Feed fresh captured traces back into reference playback; cover undo, cross-turn rewind, reload, restart and session interruption.

### T-validation-review: Independently review replay validation

```yaml
id: T-validation-review
depends_on: ["T-modifier-coverage","T-recording"]
parallel_safe: true
conflicts_with: []
files_write: ["community/docs/validation-review.md"]
files_read: ["community/docs/adapter-parity.md","community/docs/validation-boundary.md","community/docs/plugin-support.md","community/docs/recording-protocol.md"]
branch_suffix: validation-review
scope: S
```

**Description:** An agent other than the adapter author independently reproduces the evidence and reviews the trust boundary. This task is the explicit gate before authoritative result processing.

**Acceptance:**

- [x] Independently run browser-to-adapter comparisons, recording round trips and adversarial cases on the exact reviewed commits.
- [x] Document findings, fixes/rechecks, engine support, measured resource envelope and verdict: pass, changes required, or unsupported approach.
- [x] Require all blocking findings fixed and rechecked; do not equate a client victory claim, replay viewer success or the author's self-report with verification.
- [x] If the Node target fails, return a concrete fallback decision to the user; unrelated catalog/curation work may continue.

**Resolved follow-up:** A longer current-browser Prison comparison exposed an
omitted production mutation-batching flag in the Node adapter. Correction
`52f814f5` restores that configuration without changing the original engine.
Independent review passed 23 adapter/boundary/modifier checks and confirmed a
negative control reproduces the earlier divergence. The coordinator's full
79-decision comparison matches all 136 browser checkpoints and independently
derives offered-surrender victory on turn 12. Two original renderer warnings
remain documented, and only cosmetic region names are excluded from comparison.
See the [review](../../community/docs/validation-review.md) for exact provenance,
support limits and resource measurements. Public feature switches stay off by
default; local review explicitly enables them.

**Verification:** Re-run the commands documented by T-adapter-core, T-validation-boundary, T-modifier-coverage and T-recording. Record actual results and commit hashes, not assumed passes.

### T-anonymous-ratings: Collect anonymous map ratings

```yaml
id: T-anonymous-ratings
depends_on: ["T-catalog","T-curator-access","T-map-import"]
parallel_safe: true
conflicts_with: []
files_write: ["community/api/visitors.ts","community/api/ratings.ts","community/web/ratings.ts","community/db/003-ratings.sql","community/tests/ratings.test.ts"]
files_read: ["community/shared/contracts.ts","community/db/001-catalog.sql"]
branch_suffix: anonymous-ratings
scope: M
```

**Description:** Let anonymous visitors rate a published gameplay revision and revise their rating, with a server-issued browser token and bounded abuse controls. Implement the provisional rating policy below.

**Acceptance:**

- [x] One current rating per browser token/revision, 1-5 stars, with aggregate and count updated consistently; no public accounts or sign-in.
- [x] Issue/verify opaque tokens securely; protect mutations, bound submission rates and avoid invasive fingerprinting. Clearing browser data is an acknowledged limitation.
- [x] Metadata edits retain ratings; gameplay revisions have separate current-revision ratings. The UI states browser-local progress accurately.
- [x] Do not claim verified unique people, one human per vote, or authenticated ownership of a record.

**Verification:** Proposed: npm --prefix community test -- tests/ratings.test.ts. Cover replacement, duplicate requests, aggregation, rate limits, invalid values and archived/draft targets.

### T-run-submission: Accept and queue complete anonymous runs

```yaml
id: T-run-submission
depends_on: ["T-validation-review","T-anonymous-ratings"]
parallel_safe: true
conflicts_with: []
files_write: ["community/api/runs.ts","community/db/004-runs.sql","community/tests/run-submission.test.ts"]
files_read: ["community/shared/contracts.ts","community/api/visitors.ts","community/engine/validate.ts","community/shared/supported-configurations.json"]
branch_suffix: run-submission
scope: M
```

**Description:** Issue server-bound run records and accept complete submissions into a durable PostgreSQL job queue. Keep public results unchanged until validation succeeds.

**Acceptance:**

- [x] Bind run IDs to canonical revision/hash, difficulty, engine/rules and an anonymous browser token; never take those bindings from an unchecked final submission. Enforce the reviewed executable support policy at issuance.
- [x] Support submission retry with idempotency keys and immutable content fingerprints. A run is counted at most once; rate limits and byte/queue limits apply.
- [x] Persist submission blobs and job metadata with recoverable failure handling; handle missing/orphaned blobs explicitly. Server-issued runs remain resumable for the declared support window.
- [x] Return pending/accepted/error states and retain old revision references for in-flight games; client final snapshots and score claims carry no authority.

**Verification:** Proposed: npm --prefix community test -- tests/run-submission.test.ts. Exercise duplicate/concurrent requests, interrupted blob writes, wrong bindings and unavailable queue/storage.

### T-verified-results: Adjudicate jobs and update public statistics

```yaml
id: T-verified-results
depends_on: ["T-run-submission"]
parallel_safe: true
conflicts_with: []
files_write: ["community/worker/validate-job.ts","community/api/results.ts","community/tests/verified-results.test.ts","community/docs/result-accounting.md"]
files_read: ["community/engine/validate.ts","community/db/004-runs.sql","community/docs/validation-review.md"]
branch_suffix: verified-results
scope: M
```

**Description:** Run bounded, isolated validation jobs and update verified finishes and best turns transactionally. The database owns job state and aggregates; the worker operates through the backend's shared service layer.

**Acceptance:**

- [x] Use job claims/leases, bounded concurrency, retries and crash recovery. Give each simulation clean state/storage and no arbitrary network access.
- [x] Only engine-confirmed victories update public statistics. Atomically ensure exactly one contribution per accepted run; infrastructure retries cannot multiply counts.
- [x] Keep results partitioned by map revision, difficulty and gameplay engine compatibility. Equal turn counts share the record; expose best-known verified solution and finish counts without named player rankings.
- [x] Retain supporting replay/engine evidence for current records; report invalid/unsupported/error distinctly and provide an operator path to investigate failures.
- [x] Emit structured job outcome, queue-wait, duration, retry/timeout and resource metrics without logging raw profiles/replays or visitor secrets; expose enough evidence to diagnose the first failing stage.

**Verification:** Proposed: npm --prefix community test -- tests/verified-results.test.ts. Kill/retry a worker around persistence boundaries, submit simultaneous wins, and verify exact counters and minimum-turn results.

### T-results-experience: Bind new runs before play and show verification status

```yaml
id: T-results-experience
depends_on: ["T-verified-results","T-recording"]
parallel_safe: true
conflicts_with: ["T-game-launch","T-recording"]
files_write: ["community/web/results.ts","community/web/local-runs.ts","community/tests/results-experience.test.ts","community/web/custom-maps.ts","community/web/results.css"]
files_read: ["community/shared/contracts.ts","community/api/results.ts","community/runtime/recording.ts"]
branch_suffix: results-experience
scope: M
```

**Description:** Wire server run issuance into the catalog bridge before the first player decision, then connect recorded completions to submission/status APIs without delaying return to the catalog.

**Acceptance:**

- [x] For new games and restarts, obtain and persist the exact server-bound revision/difficulty/engine configuration before enabling player decisions. Resume retains its original binding. If a new run cannot be issued, offer retry without launching a falsely verifiable session; already-issued runs may continue offline.
- [x] A local win is immediately visible while public verification remains pending; background status updates refresh only the relevant map/revision.
- [x] Retry after network interruption or reload without double counting; retain unacknowledged recordings and show actionable storage/compatibility errors.
- [x] Do not discard saves on navigation or silently change the difficulty/build of a resumed run. Handle archived maps and retired validator versions explicitly.

**Verification:** Proposed: npm --prefix community test -- tests/results-experience.test.ts tests/game-launch.test.ts. Test failed run issuance, binding before first action, restart/new binding, resume/original binding, offline completion, reconnect, reload, duplicate requests and unsupported runs.

### T-object-storage: Persist private blobs atomically

```yaml
id: T-object-storage
depends_on: ["T-contracts"]
parallel_safe: true
conflicts_with: []
files_write: ["community/api/storage.ts","community/tests/storage.test.ts"]
files_read: ["community/shared/contracts.ts"]
branch_suffix: object-storage
scope: S
```

**Description:** Extract the independent storage port implementation from composition. Store maps, previews and submissions privately with bounded reads and atomic writes; only API authorization decides which blobs are public.

**Acceptance:**

- [x] Preserve bytes and MIME types with an integrity checksum and atomic replacement.
- [x] Reject invalid/traversal keys, symlink escapes and oversized objects; detect stored corruption.
- [x] Distinguish missing objects from corrupt/unavailable storage for retry/recovery.

**Verification:** `npm --prefix community test -- tests/storage.test.ts` covers concurrent replacement, corruption, traversal and symlinks using disposable directories.

### T-local-assembly: Integrate the complete local community service

```yaml
id: T-local-assembly
depends_on: ["T-publishing","T-results-experience","T-object-storage"]
parallel_safe: false
conflicts_with: []
files_write: ["community/api/server.ts","community/web/index.html","community/web/main.ts","community/tests/community-e2e.test.ts","community/web/assets.d.ts"]
files_read: ["community/runtime/bootstrap.ts","community/api/catalog.ts","community/api/publication.ts","community/worker/validate-job.ts","community/shared/supported-configurations.json"]
branch_suffix: local-assembly
scope: M
```

**Description:** Wire the slices into one local site/API and worker with PostgreSQL plus local object storage behind the agreed storage interface. Resolve composition centrally so feature agents do not race on entry points.

**Acceptance:**

- [x] Complete curator upload/preview/publish, fifth-button catalog browse, play, verified finish, return, rating and archive flows in real browsers. Wire the same reviewed support policy into publication, run issuance and validation; a permissive test policy must never reach the packaged service.
- [x] Verify new/resumed runs, both difficulties, small-screen layouts and keyboard catalog/admin controls; preserve existing modes.
- [x] Use feature switches for custom-map entry, submissions and verified stats. Keep the original developer's services unreachable.
- [x] Run database changes against isolated local databases; preserve current workspace files, personal exports and unrelated website content.
- [x] Expose API latency/error, readiness and queue/worker health instrumentation from the owned server composition; verify metrics do not disclose submitted content or credentials.

**Verification:** Proposed: npm --prefix community run build; npm --prefix community test -- tests/community-e2e.test.ts. Run the integrated smoke and full relevant test set once after composition.

### T-operations: Prepare reproducible builds and release operations

```yaml
id: T-operations
depends_on: ["T-local-assembly"]
parallel_safe: false
conflicts_with: []
files_write: [".github/workflows/community-checks.yml","community/deploy/compose.yaml","community/deploy/Dockerfile","community/docs/operations.md","community/deploy/jekyll-excludes.yml"]
files_read: ["community/package.json","community/runtime/manifest.json","community/docs/validation-review.md"]
branch_suffix: operations
scope: M
```

**Description:** Prepare build/CI, local deployment configuration and an operations runbook. No external provisioning or deployment is part of this task without release authorization.

**Acceptance:**

- [x] Configure CI for locked installs, build, compatibility/adversarial/UI tests, guarded runtime preparation and a container preview check. Local tests and the exact added preview step passed; hosted CI has not been dispatched.
- [x] Supply an optional community-owned Jekyll exclusion overlay without editing `_config.yml`; cache/service-worker isolation pins runtime inputs. Actual optional Jekyll output remains unverified because the locked Bundler is unavailable.
- [x] Document backup/restore, migrations, rollback, replay retention, engine retirement, curator access, secret configuration and owner responsibilities.
- [x] Provide protected queue, validation/resource and API metrics plus a local diagnostic collector. Persistent production collection, alert destinations and benchmark-derived thresholds remain public-release decisions before choosing hosting size.
- [x] Prepare safe launch and rollback steps and exercise disabling submissions/stats without losing stored results. No original credentials or paid services were used.

**Verification:** Build and run the packaged service locally; exercise backup/restore and worker restart/rollback using disposable data. Confirm generated static output contains no profiles, secrets or test corpora.

### T-release-review: Review release readiness without publishing

```yaml
id: T-release-review
depends_on: ["T-operations"]
parallel_safe: true
conflicts_with: []
files_write: ["community/docs/release-review.md"]
files_read: ["community/docs/operations.md","community/docs/validation-review.md","docs/plans/custom-maps-execution-plan.md"]
branch_suffix: release-review
scope: S
```

**Description:** Review the integrated change and operational evidence independently of the principal implementation authors. Produce a concrete release proposal for the user; do not deploy.

**Acceptance:**

- [x] Confirm feature acceptance, independent validator review, tests, keyboard/layout checks, the observed browser/runtime matrix and rollback evidence; distinguish untested browsers, screen-reader coverage and old-image rollback in the report.
- [ ] Resolve permission/distribution of the game and assets, target hosting, operating budget, maintainer access and engine/retention policies before public deployment.
- [x] Record remaining risks and actual blockers. Keep any external launch, paid provisioning, remote push/PR publication or upstream contact separately authorized.
- [x] Define post-launch checks for real errors, queue delay, cost and user reports by operator, curator-lead and engine-maintainer role. Naming the people and escalation channels remains a deployment decision; no monitoring automation was created.

**Verification:** Review final diffs and CI/local evidence at exact commits; reproduce critical user journeys and the proposed rollback. Deliver a release-readiness report for review.

## Risks and decisions remaining before release

| Risk or decision | Response and owner |
|---|---|
| Untested engine/configuration changes introduce divergent AI | The direct adapter passed the reviewed matrix and corrected long trace. Any expansion requires fresh browser evidence and independent review; public feature switches remain off by default. |
| A successful replay hides an invalid action or snapshot reset | Independent validation review, adversarial fixtures and strict semantic commands are required. |
| Engine/plugin changes invalidate old recordings | Pin complete inputs, use a tested support matrix and retain compatible validators/evidence for the declared window. |
| Anonymous ratings/completion counts can be inflated | Browser tokens, quotas and idempotency reduce abuse; product wording must not imply unique people or authenticated credit. |
| Public use of proprietary game/assets is unresolved | Resolve a collaboration/permission/distribution path before public hosting; do not infer a license from accessible JavaScript. This does not stop local planning. |
| Map/replay parsing or simulation exhausts resources | Bound upload/decompression/entity/decision/turn sizes and isolate jobs with time/memory/concurrency limits. |
| Untrusted descriptions, map resources or hooks reach code/network | Render metadata safely, accept a data-only map schema, allowlist built-in plugins and deny arbitrary external resource loading. |
| Player export contains unrelated personal progress/preferences | Keep the raw profile outside Git; extract only necessary fixture material during authorized execution. |
| Hosting, budget, expected traffic, operator and retention unspecified | Resolve before deployment using measured adapter workload. No provider purchase or external provisioning is authorized by this document. |
| Curator access provider and engine support window unspecified | Choose before release; local tests use explicit fixtures. Do not introduce public-player sign-in. |

## Completion criteria

- [x] Fifth Custom Maps button opens a usable catalog on desktop and compact layouts.
- [x] Both supplied maps import and preview correctly; all published plugin combinations are tested.
- [x] Catalog title/tag queries, sorting, list/grid views and map details work against real stored data.
- [x] Curators can draft, revise, preview, publish and archive maps through server-protected operations.
- [x] Playing uses the fixed original engine; leaving/winning returns to preserved catalog context.
- [x] Undo, rewind, restart and save/resume retain correct complete run recordings.
- [x] Normal/Hard adapter outcomes match the pinned browser reference; illegal/tampered submissions cannot enter verified statistics.
- [x] Anonymous ratings, once-per-run completion accounting and revision/difficulty-specific fewest-turn records behave as specified.
- [x] Network/worker/storage failures preserve retryable data and display honest status.
- [x] Original cloud integrations are disabled/replaced; local and packaged browser checks reported no external requests.
- [x] Reviewed commits, compatibility evidence, CI configuration, passing local checks and an operational/release proposal are available. Hosted CI itself remains unexecuted.
- [ ] Public release decisions and any required authorization are resolved before deployment.

## Plan-writing verification

This section records the original plan-writing checks. Implementation evidence
is recorded above and in the linked reports.

- [x] Task IDs, dependency references and the DAG agree; the graph forms an acyclic graph, with T-map-format extracted as an independent task during execution with T-toolchain initially ready after user review.
- [x] All tasks declare owned files, dependencies, parallel/conflict rules, scope, acceptance and verification.
- [x] Overlapping file ownership has symmetric conflicts; task scope is small/medium and no task declares more than five writable files. Reads of planned files have a completed upstream owner.
- [x] At the plan-only checkpoint, local evidence links resolved, input files were referenced rather than copied, and only this plan was added.
- [x] Independent read-only plan review checked support-policy ownership, run binding before play, instrumentation ownership, validation gates and plan-only scope; its reported issues were corrected and rechecked.
