# Community extension release proposal

Review date: 2026-09-26. The native and container local builds are ready for a
private review of the community-map flow. Public deployment is not approved.
The integrated code tested is `b8a5e742d3b3f5e33da38b0d51d8c3b9aa123d82`;
subsequent plan/review documentation does not change that tested code.

## Reviewed scope and independence

The approved [execution plan](../../docs/plans/custom-maps-execution-plan.md)
defines the acceptance bar: preserve the original game, provide a separate
anonymous community catalog, validate fewest-turn finishes with the pinned
engine, protect curator actions, and keep the player on one unchanged URL.
It explicitly leaves distribution permission, hosting, operating budget,
maintainer identity, retention and external launch authorization for release.
This review applies that bar; it does not authorize new deployment work.

| Integrated change | Commit reviewed |
| --- | --- |
| Corrected production mutation batching and four-turn regression | `52f814f5107953b537d06dcd5303d43bd4ce5eff` |
| Durable worker and atomic result accounting | `bbefb969` |
| Local HTTP/browser/service assembly | `dc749daf` |
| Rating aggregate updates that preserve edits | `dfa8ef8a4840166c53440addd3579f06f798a474` |
| Final browser assertion for the live rating aggregate | `b8a5e742d3b3f5e33da38b0d51d8c3b9aa123d82` |

The reviewer authored the runtime harness, base browser fixtures and operations
scaffold. Their checks of those files are verification, not independent review
of their own code. The independent review covers the separately authored engine
adapter/command boundary, recorder, worker/accounting and service integration.
A separate agent independently reviewed the packaging/operations files at
`b8a5e742` and reported no material findings; that review was read-only and did
not execute Docker, hosted CI or Jekyll. Coordinator evidence is labeled
separately below. No original release bundle, `_config.yml` or `netlify.toml` changed relative to the implementation foundation.
Untracked repository guidance and personal exports are not release artifacts.

## Acceptance and evidence

The local flow provides the fifth Custom Maps entry, a searchable list/grid,
name/rating/completion sorting, tag filtering, original-renderer previews and
map details. Players select Normal or Hard and return to the catalog after play.
Browser tests preserve the full initial URL, including any existing query and
fragment, across catalog, detail, play, return and reload/resume. Players do not
sign in. Ratings and resumable runs are bound to anonymous browser tokens;
clearing browser storage creates a new identity, so this is not one vote or one
finish per human.

Curators use the separate `/admin/maps` route. The local service covers upload,
metadata editing, preview generation, publication and archival with protected
server routes, roles, same-origin/CSRF checks and audit records. Immutable map
revisions separate changed gameplay from earlier scores. Verified results count
accepted runs once and keep fewest turns within each revision, difficulty and
engine bucket. Pending, non-winning, unsupported, invalid and infrastructure
failures remain distinct.

| Check | Evidence and limit |
| --- | --- |
| Complete integrated regression | Coordinator ran all **123 tests in 10 suites: 123 passed, zero failed, zero skipped**, in 183.065748834 seconds on `b8a5e742`, using real PostgreSQL/Chromium and both supplied-map fixture environments. |
| Independent corrected adapter/boundary/modifier review | Type check and **23 tests passed, zero skipped**. Both supported difficulties and exact plugin sequences passed the committed browser corpus. |
| Longer capture regression | Reviewer compared all **36 compact hashes and 11 decisions** with the saved current-browser evidence. Disabling batching in a fresh Node negative control reproduced checkpoint 30's mismatch. |
| Full longer trajectory | Coordinator reran **136/136 matching checkpoints**, victory on turn 12, approximately 30.5 seconds locally. This is coordinator execution evidence, not a second full rerun by this reviewer. |
| Independent worker and complete service flow | **13 tests passed, zero skipped**, including real Chromium, PostgreSQL, HTTP, preview rendering and the isolated original-engine adapter. |
| Crash/retry/accounting | Independent tests passed duplicate claims, expired/stale lease fencing, lease expiry after row-lock wait, bounded retries, atomic counter rollback, crash recovery and graceful drain. |
| Readiness and privacy | Independent browser/service tests observed empty database 503, unstarted worker 503, healthy service 200; protected metrics, private-file 404s and no external requests. |
| Accessibility/layout checks | Catalog tests exercise keyboard Enter and scroll restoration through named semantic controls; browser checks cover narrow layouts. No screen-reader audit or blanket WCAG certification is claimed. |
| Original assets | Pinned input checks and unchanged-original-file diff passed. Generated copies remain under the addon. |
| Native restore drill | Coordinator restored five migrations and one canonical map/revision/blob into a new PostgreSQL database, reran migrations without changes and verified the content hash. Reviewer inspected the drill and evidence. That native drill did not cover accepted-run evidence, all curator records or a populated queue; the later container drill below adds populated evidence. |
| Operations configuration | Actionlint 1.7.12, YAML parsing, shell syntax, Compose configuration and additive Jekyll exclusions passed. Exact official image tags exist. |
| Actual Docker execution | Passed local image build, final-image allowlist, UID 1000, hardened Compose startup, repeated migrations, curator bootstrap, readiness, private-route denial, real curator preview, verified finish, rating, kill switches, populated restore and restart. Details below. |
| Hosted CI/Jekyll execution | **Unverified:** no hosted workflow run was dispatched, and the repository's locked Bundler is unavailable. Actual Jekyll output inspection has not passed. |

The full current-browser/Node final state hash is
`3daa285fcc827f0ef83b9868ea2c2577326f43980aa49b26a34679c5ad89b47f`.
The two missing-sprite warnings in that browser capture remain visible. Source
review identifies a renderer recovery path, not a gameplay mutation. The
identified bookkeeping divergence was fixed by preserving the original
mutation-batching configuration; no gameplay fields were removed from comparison.
`regions[].name` remains the sole projection exclusion. See the chronological
[validation review](validation-review.md) for exact cause, hashes and scope.

## Actual container and restore checks

Docker Desktop 29.6.1 was available for the final review. The image built from
`b8a5e742` is locally identified as
`sha256:b98e7b5cc66ae0fa897c1417582147ec5a39c767ccb9f5b52e1dd7a55d6966f2`.
This is an observed local image ID, not a published registry digest or permission
to distribute it. The tested image architecture is `linux/arm64`; hosted
`linux/amd64` CI remains unexecuted. The build ran the Linux type check and guarded runtime
preparation. No original bundle edits or product-code fixes were required.

The reviewer reserved the unused loopback port 8080, generated private temporary
credentials, and used only Compose project `konkr-package-review-20260926` with
new database/object volumes. The final image excluded tests, docs, scratch files
and environment files. Its app ran as UID 1000 with the committed read-only root,
tmpfs mounts, dropped capabilities and resource limits; only host loopback was
published, and PostgreSQL had no host port. Migrations ran twice and the explicitly
named local curator was bootstrapped. Health/readiness passed; private paths
returned 404 and unauthenticated metrics returned 401.

A real browser uploaded a tiny map, saved metadata, generated its preview through
Chromium **inside the hardened app container**, published it, played the original
engine, submitted the finish and observed a verified Hard result: one turn, one
completion. Rating and authenticated metrics also worked. The player's initial
query and fragment were unchanged; no page errors or external requests occurred.
The added package-CI preview step was executed against that same running image;
it starts the original renderer and checks its PNG signature. Hosted CI itself
was not dispatched.

Disabling submissions/statistics and recreating the app hid public scores and
returned 503 for an authenticated new-run request while retaining the accepted
record. With the app stopped, `pg_dump -Fc --no-owner --no-acl` and a tar of its
private object directory formed one quiescent backup. `pg_restore --exit-on-error`
restored a new database; the archive was extracted into a fresh temporary object
directory. All rows in all **11 public tables** matched exactly, including five
migration markers, five audit records, the curator/session, map/revision,
rating, visitor data, accepted run and score bucket. Migrations reran twice
without changes. `LocalObjectStorage` verified all three restored objects against
the originals, including map and replay hashes and the PNG preview. The restored
run retained `status: verified`, `counted: true`, turn 1 and one completion.
The app restarted against its **original** disposable database/object volume and
became ready again; it was not started against the restored pair.

This proves the tested populated database/blob pair restores correctly; it does
not claim a timed disaster recovery, recovery of a populated pending queue,
restore into a different provider, or rollback to an older image/schema.
Worker failure/retry tests cover queue recovery separately. The disposable
Compose containers, volumes and private credentials were removed after the
checks; the user's native review service and Docker Desktop were left running.

## Supported local matrix

The verified engine is release 2.35.30, with the exact main/vendor hashes in
[the runtime manifest](../runtime/manifest.json). The support policy admits only
`[]` and ordered `['spawn-gifts', 'buy-gifts']`, each in Normal and Hard.
Other modifier combinations, scripted rules, custom AI/win conditions and
fixed-difficulty imports remain unsupported. The old Sherwood/profile replay
exports are compatibility evidence; their unknown originating builds are not
authenticated wins and do not receive server scores.

Observed tooling is Node 26.4.0, PostgreSQL 16.13, Playwright 1.63.0 and Chromium
153.0.8010.12 (revision 1243). Safari, Firefox and physical mobile devices have
not been validated. The local worker runs one job at a time with a 120-second
adapter deadline, 512 MiB V8 heap ceiling and 180-second queue lease. These limits
leave operational room around the observed long run but are not production
throughput or memory guarantees; a V8 heap ceiling does not bound process RSS.

## Concrete local review proposal

Use either the native Node/PostgreSQL setup or local Compose instructions in
[operations](operations.md). Bind to `127.0.0.1`, use a fresh private
database/object directory and a generated local curator key, apply the checked
migrations and bootstrap the named curator. Enable Custom Maps for the review.
Enable submissions/statistics only for the reviewed local build and disposable
review data; all three switches default off. Review Prison and Escalating Quickly
in both difficulties and a tiny known finish, then inspect the public result.
Keep personal exports and credentials outside the served tree and Git.

For a local rollback, disable submissions and verified statistics, restart with
the same durable storage, and verify that public statistics disappear and new
submissions are refused. Existing work must remain queued or complete through
the reviewed worker; stopping the app drains active jobs. The worker tests prove
drain/recovery/accounting behavior, but a complete old-image rollback on populated
data remains unperformed. Use a compatible image/schema pair or restore both
database and blobs into a new private environment. Never clear the queue or
counters to simulate recovery.

## Conditions before a public release

1. Resolve permission to distribute the frozen game/assets and agree the
   upstream collaboration route. This report makes no legal conclusion.
2. Select hosting, budget and named operator; benchmark representative long and
   worst-case jobs, queue delay and complete process/container memory. Set public
   rate limits, retention periods, backup objectives and restore frequency from
   those measurements.
3. Replace local development curator credentials with reviewed private identity
   integration, scoped secrets/database access and an access-revocation process.
4. Reproduce the verified local package on the selected deployment platform,
   measure recovery against agreed backup objectives and include pending work
   in a recovery drill. Pin verified deployment image digests. If the original
   Jekyll site is packaged, inspect its real output with the optional exclusion
   overlay. The local populated restore above is evidence, not a provider-level
   disaster-recovery guarantee.
5. Define engine retirement and outstanding-run behavior, replay retention and
   reviewed garbage collection. Preserve historical challenge/score identities.
6. Complete the intended public browser and accessibility matrix, agree the
   rollout/rollback owner and obtain explicit external launch authorization.

These are the plan's unresolved release gates, not authorization to provision,
publish a pull request, push a branch, contact upstream or deploy.

After an authorized launch, the operator should inspect readiness, real API and
renderer errors, queue age, validation retries/timeouts, process memory, database
and blob growth, cost and user reports. The curator lead should review publication
and access changes; the engine maintainer should triage unsupported-map reports
and compatibility failures. Name those people, thresholds and escalation channels
before launch. No monitoring automation or external notification was created by
this review.
