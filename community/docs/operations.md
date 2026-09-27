# Local community service operations

This package is for local review. It does not authorize publishing the original
game or assets. Public hosting remains blocked on distribution permission, a
reviewed curator identity provider, hosting and budget decisions, retention
policy, measured resource limits, and the final release review. The local server
intentionally refuses a public origin and `NODE_ENV=production`.

## What is packaged

Use the repository root as the Docker build context. The
[Dockerfile](../deploy/Dockerfile) installs the lockfile with Node 26.4.0 and
Playwright 1.63.0, type checks the addon, and verifies/prepares release 2.35.30.
Its final stage contains the addon runtime and the manifest-pinned original
bundles/assets. It excludes test corpora, profiles, docs, environment files and
the original website configuration. Development dependencies remain: server
startup uses esbuild, and Playwright is retained for the reference/preview test
harness. Player and curator previews run in their browser. `npm run build` is a
type check; the server creates its browser bundles at startup.

The original bundles remain unchanged. Generated `.runtime/` and `.web/` files
are disposable. Only PostgreSQL and the private `.data/` object volume are durable.
Do not serve a repository directory or an object-storage root through a static
web server. The API serves only its explicit public asset and route allowlists.
No original service credentials or deployment settings are used.

The container uses a non-root user, a read-only root filesystem, writable
temporary directories and a private object volume. Chromium is installed from
the pinned Playwright package. The Compose application has a local ceiling of
two CPUs and 2 GiB RAM, plus 1 GiB shared memory; these are development settings,
not measured production capacity. Exact version image tags are recorded, but
image digests still need verification and pinning before public release.

## Start a disposable local instance

Run these commands from the repository root with a running Docker daemon.
Environment variables stay in the current shell; do not put them in Git or
paste them into tickets. Generate a hexadecimal database password so it is safe
inside `DATABASE_URL`.

```sh
export COMMUNITY_DATABASE_PASSWORD="$(openssl rand -hex 32)"
export COMMUNITY_CSRF_SECRET="$(openssl rand -hex 32)"
export COMMUNITY_DEV_CURATOR_KEY="$(openssl rand -hex 32)"
export COMMUNITY_DEV_CURATOR_ID=local-curator
export COMMUNITY_CUSTOM_MAPS=1
export COMMUNITY_SUBMISSIONS=0
export COMMUNITY_VERIFIED_RESULTS=0
docker compose -f community/deploy/compose.yaml config --quiet
docker compose -f community/deploy/compose.yaml build app
docker compose -f community/deploy/compose.yaml up -d --wait db
docker compose -f community/deploy/compose.yaml run --rm -T app node api/server.ts --migrate
docker compose -f community/deploy/compose.yaml run --rm -T app node api/server.ts --bootstrap-curator
docker compose -f community/deploy/compose.yaml up -d --wait --wait-timeout 150 app
curl --fail http://127.0.0.1:8080/readyz
```

Open `http://127.0.0.1:8080/`. The player remains on this URL through catalog,
details, play and return. Curators use `/admin/maps` with the generated local key.
The key is a local fixture, not an approved public authentication method.
With submissions disabled, custom games still receive server-issued run bindings
and can be played, saved and resumed. Victories are not recorded for submission,
and the validation worker stays stopped. Completion and best-turn statistics
remain hidden when verified results are disabled; reported statistics are not collected.
The catalogue still records personal silver/Normal and gold/Hard completion
trophies in browser storage, scoped to the exact map revision and engine. These
badges never update server scores and disappear if that browser data is cleared.
The bottom Saved results panel is removed; resume controls remain in the selected
map. Rating stars appear after returning from a custom game.
Bootstrap inserts the named administrator only if no curator exists; migrations
do not create identities. Keep the same database password when restarting an
existing PostgreSQL volume: changing the environment does not rotate its user.

Compose publishes only `127.0.0.1:8080`; PostgreSQL has no host port. The internal
`0.0.0.0` application bind is allowed only with `COMMUNITY_LOCAL_CONTAINER=1`, a
loopback origin, and a non-production environment. Never expose this Compose
file through a public proxy, tunnel or different port binding.

Enable submissions and verified statistics only after independent engine parity,
the integrated worker and accounting tests pass for the exact build. The corrected
long Prison trajectory now passes its scoped simulation review; integrated service
and release evidence must still be checked. Feature switches remain off by default:

```sh
export COMMUNITY_SUBMISSIONS=1
export COMMUNITY_VERIFIED_RESULTS=1
docker compose -f community/deploy/compose.yaml up -d --force-recreate --wait app
```

Without Docker, use Node 26.4.0, PostgreSQL 16 and a private local database:
`npm --prefix community ci --ignore-scripts`, install Chromium with
`npx --no-install playwright install --with-deps chromium` from `community/`,
then set `DATABASE_URL`, the three `COMMUNITY_*` identity/CSRF variables above,
`COMMUNITY_ORIGIN=http://127.0.0.1:8080` and `COMMUNITY_HOST=127.0.0.1`.
Run the same migration/bootstrap commands from `community/`, followed by
`npm start`. Never use a production database for this path or the test suite.

## Configuration and secrets

| Setting | Local behavior |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL connection; dedicated database and user. |
| `COMMUNITY_DATA_DIR` | Private immutable blobs; Compose mounts `/app/community/.data`. |
| `COMMUNITY_ORIGIN` | Exact browser origin used for origin and cookie checks. |
| `COMMUNITY_HOST`, `PORT` | Default loopback listener and port 8080. |
| `COMMUNITY_LOCAL_CONTAINER` | Explicit local-container bind exception only. |
| `COMMUNITY_CSRF_SECRET` | Random secret of at least 32 characters; protects anonymous request proofs. |
| `COMMUNITY_DEV_CURATOR_ID`, `COMMUNITY_DEV_CURATOR_KEY` | Explicit local identity and random key of at least 32 characters. |
| `COMMUNITY_CUSTOM_MAPS` | `1` enables the custom-map entry; otherwise disabled. |
| `COMMUNITY_SUBMISSIONS` | `1` enables recording, new result submissions and the validation worker. `0` keeps gameplay/save/resume available without recording or validation. |
| `COMMUNITY_VERIFIED_RESULTS` | `1` exposes verified statistics; otherwise hidden. |

When **both** validation flags are `0`, the catalogue, ratings, publication and
new-run APIs accept the pinned browser's allowlisted built-in plugins through
[native-playback.ts](../shared/native-playback.ts). Maps still pass the bounded
data-only parser; arbitrary scripts, unknown plugins and different engines are
rejected. Setting either flag to `1` restores the strict reviewed configuration
policy for those operations, so maps supported only by native playback disappear
from discovery and cannot start new runs. Existing browser saves retain their
original bindings. The submission validator and verified score filtering always
use [supported-configurations.json](../shared/supported-configurations.json);
native playback does not expand validation support.

## Browser previews and publication

The selected catalogue map uses the original `WorldMap` scene on the main game
canvas, with input disabled and the native Preview context. Selecting an island
preloads its revision; Play still follows the original import path to initialize
the chosen difficulty. The native camera animates directly between the catalogue
and Play. Returning retains the played board without passing through Title.
Back, Play, Resume and Normal/Hard are original Phaser controls, with their bitmap
fonts and accessible HTML input anchors. The player's top-level URL stays unchanged.

The curator editor uses an isolated browser frame at `/community-preview`.
Thumbnail rendering uses a shared frame and an in-memory cache. These frames
mask persistent storage and use the same non-playable Preview context. No preview
starts a play session or runs AI; downloads do not lock catalogue navigation.

Map uploads no longer run a server screenshot job. Publish saves the metadata,
then the API checks curator authorization, CSRF, expected version, support policy
and the stored map's integrity. A failed browser preview offers a retry but does
not block publication. There is no PNG readiness gate; old preview endpoints
return `410`, and existing preview blobs are no longer served or required. No
database migration is required.

After upgrading from stored screenshots, remove only the retired generated cache with
`node scripts/retire-preview-cache.ts` (dry run), then
`node scripts/retire-preview-cache.ts --apply` in the app container. The script uses
`DATABASE_URL` and `COMMUNITY_DATA_DIR`, retains original map objects, and reports
skipped references for separate inspection. New browser previews never write PNGs
to server storage.

The [live-preview test](../tests/live-preview.test.ts) covers isolated rendering.
The [preview-state test](../tests/catalog-preview-state.test.ts) checks main-canvas
save isolation and compares Normal/Hard AI actions against a direct original
import. [Game-launch tests](../tests/game-launch.test.ts) check camera animation,
direct return, resumes and ordinary menus; [native-control tests](../tests/catalog-controls.test.ts)
check original fonts, geometry and pointer/keyboard behavior. [Native-playback
tests](../tests/native-playback.test.ts) cover the playback/validation boundary.
Run database tests against a disposable schema, not the development catalogue.

## Access protection

Do not log cookie values, session/CSRF proofs, keys, raw replays or personal
profiles. Restrict backup and database access to the operator. Before release,
use a reviewed secret store, independently scoped database roles and approved
curator identity integration. Disable a departing curator and revoke their
sessions through the protected administration API; do not rely solely on
removing their browser cookie. The authentication and audit tables are private.

## Migrations and rollback

`node api/server.ts --migrate` applies checked-in numbered SQL migrations in
order under a PostgreSQL advisory lock. `community_migrations` records each
filename and SHA-256; a changed applied migration aborts. Running the command
twice must be harmless. Make a new migration instead of editing an applied one.
Back up before migration and test every new migration against a restored copy.

For an incident, first set `COMMUNITY_SUBMISSIONS=0` and
`COMMUNITY_VERIFIED_RESULTS=0`, then recreate the app container with the same
database/object volumes. This rejects new submissions and hides published
statistics and stops the validation worker; it does not delete queued jobs or reverse accepted results. Set
`COMMUNITY_CUSTOM_MAPS=0` too if the player entry must disappear. Feature flags
are read on startup. They are not a promise to cancel an in-flight transaction.

To halt all writes, stop the app gracefully. The worker must
release or recover leased work on restart; only the reviewed accounting path
may apply completion counters. Do not manually mark a job successful, zero
counters, purge the queue or delete replay blobs to clear an incident. Confirm
worker restart/idempotence with the result-accounting tests and disposable data.

Keep the last tested image plus its commit, engine hash, adapter version and
migration list. Roll back an image only if it supports the current schema and
queued engine bindings. Otherwise restore the matching database and object
backup into a separate environment, verify it, then switch locally. Never run
unreviewed down-migrations or restore one half of a database/blob pair in place.
No public rollout or rollback is authorized by these local commands.

## Consistent backup and restore

The operator owns backups, encryption, access and restore drills. Retain the
exact code/image and pinned original release alongside backup metadata, not
inside publicly served storage. Stop the app before copying the database and
objects so map/replay references and blobs represent one quiescent point.
`pg_dump` alone cannot back up the object volume.

```sh
# Pick a new private directory outside the repository.
backup_dir="$(mktemp -d /private/tmp/konkr-community-backup.XXXXXX)"
chmod 700 "$backup_dir"
docker compose -f community/deploy/compose.yaml stop app
docker compose -f community/deploy/compose.yaml exec -T db pg_dump -U community -Fc --no-owner --no-acl community > "$backup_dir/database.dump"
docker compose -f community/deploy/compose.yaml run --rm -T app tar -C /app/community/.data -cf - . > "$backup_dir/objects.tar"
git rev-parse HEAD > "$backup_dir/commit.txt"
docker compose -f community/deploy/compose.yaml exec -T db psql -U community -d community -Atc 'SELECT name,sha256 FROM community_migrations ORDER BY name' > "$backup_dir/migrations.txt"
docker compose -f community/deploy/compose.yaml up -d --wait app
```

Use a portable private temporary directory on Linux instead of `/private/tmp`.
Protect the completed backup in approved encrypted storage; a local temporary
directory is only a drill destination. Check command exit status and archive
hashes before treating a backup as complete. Do not use `docker compose down
--volumes` against data you intend to retain.

Restore into a new Compose project with empty database/object volumes and a
different free loopback port, keeping the app stopped. Create an empty database
with the same PostgreSQL major version, run `pg_restore --no-owner --no-acl
--exit-on-error`, then extract `objects.tar` as the application user into its
private object volume. Check recorded migration checksums, every referenced
blob's content hash, curator roles, catalog revisions, result totals and queued
job bindings. Start with submissions/statistics disabled, check readiness and a
known map, then exercise one disposable complete run and restart the worker.
Do not overwrite a live volume for a restore drill. The CI package job performs
a smaller disposable dump/restore and blob archive round trip; it is not a
disaster-recovery certification.

## Health, metrics and resource decisions

`/healthz` is process liveness. `/readyz` checks service readiness, including
database access and worker composition. `/api/admin/metrics` requires an
administrator session and returns aggregate API, queue, worker and process
memory measurements. Do not make metrics public or add credentials to a URL.

For local observation, the following collector reads an existing admin session
cookie from a private file and emits aggregate JSON every 30 seconds. Store only
the `community_curator=...` cookie in a file outside the repository with mode
`0600`, set `COMMUNITY_METRICS_COOKIE_FILE` to its path and set
`COMMUNITY_QUEUE_ALERT_SECONDS` to a local diagnostic queue-age threshold chosen
from the measured workload. Do not put the cookie itself in command arguments
or shell history. The collector never signs in or renews the session: a new
sign-in invalidates that curator's previous session. Stop on expiry and provide
a current session. No unattended production collector is configured here.

```sh
node --input-type=module <<'NODE'
import { readFile, stat } from 'node:fs/promises';
const file = process.env.COMMUNITY_METRICS_COOKIE_FILE;
const queueLimit = Number(process.env.COMMUNITY_QUEUE_ALERT_SECONDS);
if (!file || !Number.isFinite(queueLimit) || queueLimit <= 0) throw new Error('Set private cookie file and measured local queue threshold');
if ((await stat(file)).mode & 0o077) throw new Error('Cookie file must be private');
const cookie = (await readFile(file, 'utf8')).trim();
if (!/^community_curator=[A-Za-z0-9_-]{43}$/.test(cookie)) throw new Error('Invalid cookie format');
let readinessFailures = 0;
for (;;) {
  try {
    const ready = await fetch('http://127.0.0.1:8080/readyz', { signal: AbortSignal.timeout(5000) });
    readinessFailures = ready.ok ? 0 : readinessFailures + 1;
    const response = await fetch('http://127.0.0.1:8080/api/admin/metrics', { headers: { Cookie: cookie }, signal: AbortSignal.timeout(5000) });
    if (response.status === 401 || response.status === 403) {
      console.error(JSON.stringify({ event: 'metrics-session-expired' }));
      process.exitCode = 1; break;
    }
    if (!response.ok) throw new Error('metrics unavailable');
    const metrics = await response.json();
    const queueAlert = metrics.queue.some(item => item.state === 'queued' && Number(item.oldest_seconds) > queueLimit);
    console.log(JSON.stringify({ at: new Date().toISOString(), event: 'community-metrics', alerts: { readiness: readinessFailures >= 3, queueAge: queueAlert }, metrics }));
  } catch {
    readinessFailures++;
    console.error(JSON.stringify({ at: new Date().toISOString(), event: 'metrics-unavailable', alert: readinessFailures >= 3 }));
  }
  await new Promise(resolve => setTimeout(resolve, 30_000));
}
NODE
```

Send aggregate output to private operator storage. The local collector produces
diagnostic alert records; it does not message anyone or change feature switches.
Before deployment, configure a reviewed service identity, persistent collection,
thresholds and an operator-approved alert destination.

Record request count/error count and latency totals/maxima, queued/running
counts and oldest queued age, worker validation duration and timeout/error
counts, process RSS/heap, and host CPU/memory. Counters reset on process restart;
derive rates with reset detection. Current total/max latency cannot yield a
percentile; add measured histograms before claiming p95/p99 latency.

Use these local diagnostic conditions: readiness failing repeatedly, queued
jobs with no healthy worker, growing oldest-job age, any validation timeout,
repeated infrastructure errors, and memory approaching its container limit.
They should notify the operator and pause new submissions if sustained. They
must not turn infrastructure failures into invalid-player verdicts. Production
alert thresholds, capacity, concurrency, heap limits and deadlines require a
benchmark report for small and long maps in both difficulties. The earlier Prison
timeout led to a VM performance correction; its later Node/browser divergence
identified a missing production mutation-batching flag. The corrected long trace
now matches all 136 browser checkpoints. See the dated source investigation and
independent checks in [validation review](validation-review.md). The provisional
local adapter deadline is 120 seconds with a 512 MiB V8 heap ceiling and one worker;
the queue lease is 180 seconds, leaving time for blob access and persistence. Heap
limits do not bound total process RSS, and production sizing remains open.

The operator owns uptime, queue incidents, backups and secret rotation. The
curator lead owns publishing and access reviews. The engine maintainer owns
support policy, compatibility evidence and retirement. Name actual people and
escalation channels before public deployment; no ownership is assumed here.

## Replay retention and engine retirement

No automatic replay or revision deletion is configured. Do not invent a
retention period from an illustrative traffic estimate. Choose durations only
after measuring compressed replay size, accepted/invalid/error volume, appeal
needs, storage cost and privacy requirements. Pending or running jobs, accepted
evidence, referenced immutable map revisions and backups must be included in
that policy. Garbage collection needs a reviewed reachability check and dry
run; blobs are not safe to delete merely because a map was archived.

New engines need separate hashes, adapters, repeated browser fixtures and an
independent validation gate. Do not rewrite old revisions, run bindings or score
buckets to the new engine. Stop issuing runs on an engine before retiring it;
decide how outstanding runs, retries, preserved evidence and historical scores
will be handled, then drain or explicitly resolve them. Keep the old runtime
available until that policy is fulfilled. Unsupported plugins or versions fail
closed under [supported configurations](../shared/supported-configurations.json).

## CI and release evidence

[Community checks](../../.github/workflows/community-checks.yml) uses immutable
GitHub Action revisions, locked npm dependencies, Node 26.4.0, Chromium from
Playwright 1.63.0 and disposable PostgreSQL 16.13. It obtains supplied-map bytes
from the committed reference corpus, runs tests serially, and fails on any skip.
It verifies unchanged original release files. The package job builds without
publishing, checks final image contents and private-route denial, starts the
original preview renderer inside the hardened app container, applies migrations
twice, restores disposable data and restarts the local service.
No production secrets, publishing token or deployment permission are needed.

The optional [Jekyll exclusion overlay](../deploy/jekyll-excludes.yml) preserves
the original exclusion list and excludes all addon/docs/tooling data. Apply it
only when building the original Jekyll site:
`bundle exec jekyll build --config _config.yml,community/deploy/jekyll-excludes.yml`.
The community service does not use Jekyll or the original service-worker setup.
Inspect any Jekyll output before publishing; do not mix its output with the
community service's allowlisted assets.

On 2026-09-26, the actual Docker build and hardened Compose service passed local
review on integrated code `b8a5e742`: real curator preview, original-game finish,
server validation, rating, kill switches, populated database/blob restore and
restart. The final [release review](release-review.md) records exact scope and
image identity. A separate agent's read-only packaging review found no material
issues. Hosted CI was not dispatched. The repository's locked Bundler is not
installed, so actual Jekyll output inspection remains unverified. These local
checks do not approve public deployment or establish production capacity.
