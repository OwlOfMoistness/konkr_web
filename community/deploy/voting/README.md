# Voting beside the static website

Keep this service in the game repository and deploy it independently. The API
image contains Node, PostgreSQL's client and the allowed map IDs/revisions. It
does not contain the original game, Chromium, the curator UI or the validator.
The website and map bytes remain static. The older local server is unchanged.

The Compose project runs `voting`, `db` and
`cloudflared`. No ports are published on the host. The API and database each
have a private Docker network; only the tunnel connector has outbound access.
This setup is for one API instance on a home Docker host. It is independent of
your other app's tunnel and containers.

## Setup

Use the same repository revision for the API image and static website. Both
builds validate `community maps/` with the existing catalogue parser. Duplicate
IDs need explicit IDs in matching metadata JSON files. Unsupported maps must
be reviewed before publishing; the build fails instead of silently omitting
files. Changing only metadata retains votes; changing the gameplay content
creates a separate rating history. Keep metadata IDs stable when renaming maps.

The root `compose.yaml` includes this stack. On a fresh server clone, create
the configuration once:

```sh
cd community/deploy/voting
cp .env.example .env
chmod 600 .env
```

Fill in `.env` locally. Generate **two different** values with `openssl rand
-hex 32`, one for `VOTING_DATABASE_PASSWORD`, the other for `VOTING_SECRET`.
Keep both values across updates. The token is from your new Konkr tunnel:

```dotenv
VOTING_DATABASE_PASSWORD=<first random hexadecimal value>
VOTING_SECRET=<second random hexadecimal value>
VOTING_API_ORIGIN=https://konkr-community.hoothoot.dev
VOTING_SITE_ORIGIN=https://owlofmoistness.github.io
CLOUDFLARE_TUNNEL_TOKEN=<new tunnel token>
VOTING_IMAGE_TAG=<your release or commit identifier>
```

These are **origins**: no trailing slash, `/repository` path, query or fragment.
If the website uses a custom domain, use that HTTPS origin for
`VOTING_SITE_ORIGIN`. `.env` is ignored by Git and excluded from the image's
build context. Never put the database password, signing secret or tunnel token
in the static site's environment or bundle.

After filling the file, return to the repository root and start everything:

```sh
cd ../../..
docker compose up -d
```

Docker builds the API image automatically on the first run. The database, API
and dedicated tunnel start together. Docker Compose 2.20 or newer is required
for `include`. For subsequent code/map updates, use
`git pull --ff-only` followed by `docker compose up -d --build`.

For a staged startup or troubleshooting, first run only the database and API:

```sh
docker compose config --quiet
docker compose up -d --build --wait db voting
docker compose exec -T voting node --input-type=module -e "console.log(await (await fetch('http://127.0.0.1:8080/healthz')).json())"
```

The API creates its own tables on first start; it does not migrate or use the
older community database. PostgreSQL stores votes in the `konkr-voting_votes`
named volume. Recreating containers does not delete votes.

Start the dedicated tunnel connector:

```sh
docker compose up -d
docker compose logs --tail=30 cloudflared
```

In Cloudflare, select your Konkr tunnel and add a **published application**:

| Setting | Value |
| --- | --- |
| Public hostname | The hostname from `VOTING_API_ORIGIN` |
| Service type | HTTP |
| Service URL | `voting:8080` (or `http://voting:8080` in the combined field) |
| Path | Leave empty |

The browser uses HTTPS; Cloudflare carries the request through the encrypted
tunnel to the private Docker service. Leave the origin Host header at its
default: the API checks it against `VOTING_API_ORIGIN`. Do not add a Cloudflare
Access login requirement to the anonymous voting hostname.

## Enable the existing stars on the website

Build the static site with **only the public API origin**:

```sh
cd ../..
STATIC_BASE_PATH=/konkr_web/ VOTING_API_ORIGIN=https://konkr-community.hoothoot.dev npm run build:static
```

Deploy `community/dist/` as usual. The build permits that exact API origin in
its Content Security Policy. It restores ratings, sorting by rating and the
existing post-play five-star widget. It does not restore completion counts,
trophies, the curator dashboard or replay submissions. Player URLs and gameplay
remain unchanged. Building without `VOTING_API_ORIGIN` leaves voting dormant
and makes no voting requests.

`STATIC_BASE_PATH` defaults to `/`. The Pages workflow obtains the repository
path from GitHub automatically. The allowed voting origin is
`https://owlofmoistness.github.io`, without `/konkr_web/`.

## Anonymous voting and abuse boundaries

- `POST /v1/session` issues a signed random browser token. The website stores
  it locally and sends it explicitly as a bearer token; third-party cookies,
  public sign-in and client-side shared secrets are not required.
- `PUT /v1/maps/:id/ratings` accepts an integer from 1 to 5 and the current
  `revisionId`. A browser can replace its vote, including after losing/leaving
  a map. This is not a completion claim. Unknown maps and old revisions fail.
- `GET /v1/maps/:id/ratings` returns that browser's vote and the aggregate.
  `GET /v1/ratings` returns aggregate totals for current catalogue revisions.
- Public summaries are cached inside the API for up to 30 seconds and updates
  invalidate that cache. Identity and individual-vote responses are never
  cached. The browser refreshes totals at most once per 30 seconds and keeps
  the catalogue usable if the service is offline.
- Persistent quotas allow 10 new identities per IP network/hour, 30 vote
  writes per browser/hour and 120 vote writes per IP network/hour. IPv6 is
  grouped by /64. Invalid requests also face bounded in-memory request limits.
  Shared networks can hit the same quota. Quota rows are pruned hourly; raw IPs
  and bearer tokens are not stored in the database or logged by this API.
- The API trusts `CF-Connecting-IP` **only because this deployment has no
  publicly reachable port** and the private ingress network contains only the
  API and its connector. Do not publish its port or attach unrelated containers
  while `VOTING_TRUST_CLOUDFLARE=1`. It ignores `X-Forwarded-For`.
- Origin checks/CORS constrain browsers, not attackers with HTTP clients.
  Clearing browser data can obtain another identity. This is anonymous voting,
  not one verified human per vote. Changing the signing secret invalidates
  existing tokens; old votes remain, but their browsers cannot edit them.

For Internet exposure, configure Cloudflare rate limits for `/v1/session` and
vote writes before traffic reaches your home. These local limits bound API/DB
work; they are not protection against saturating your Internet connection. A
Turnstile challenge can be added later if anonymous vote abuse warrants it.
Do not configure “cache everything” for `/v1/*`.

References: [tunnel routing](https://developers.cloudflare.com/tunnel/concepts/routing/),
[visitor IP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/),
[Cloudflare rate limits](https://developers.cloudflare.com/waf/rate-limiting-rules/).

## Updates, checks and rollback

Rebuild the API and site from the same map release. The GitHub Pages workflow
requires the full Community checks workflow before publishing. Deploy the API first, then
the site. During the brief mismatch, old revisions cannot receive votes but
remain playable. Removed maps' old votes stay in the database; they disappear
from the current public totals.

The image has a readiness health check that verifies the database table is
reachable. Inspect `docker compose ps` and `docker compose logs voting`; the
API emits sanitized error events and hourly request/error/rate-limit counts.
CPU, memory, connection counts, body/header sizes, timeouts and log sizes are
bounded. These are starting limits, not a measured traffic guarantee.

Back up the votes before upgrades (from this directory):

```sh
docker compose exec -T db pg_dump -U voting -Fc --no-owner --no-acl voting > voting.dump
```

Store the backup and `.env` privately outside the repository. Test restores in
a separate database, not over live votes. To restore into a **fresh, empty**
database with the API stopped:

```sh
docker compose up -d --wait db
docker compose exec -T db pg_restore -U voting --no-owner --no-acl --exit-on-error -d voting < voting.dump
docker compose up -d --wait voting
```

For application rollback, retain the previous image tag and matching static
release. Set `VOTING_IMAGE_TAG` back and run `docker compose up -d --no-build
voting`. This first version has only additive tables. Future destructive schema
changes need their own migration/restore plan.

To disable voting immediately, stop `cloudflared`, then rebuild/redeploy the
site without `VOTING_API_ORIGIN`. Playing static maps continues during outages.
`docker compose down` removes containers, not votes. Do not
add `--volumes` unless intentionally deleting the database.

Focused checks use `CATALOG_TEST_DATABASE_URL` pointing at a disposable local
PostgreSQL database, plus Playwright Chromium:

```sh
cd ../..
npm run build
node --test --test-concurrency=1 tests/voting.test.ts tests/voting-client.test.ts tests/voting-browser.test.ts tests/ratings.test.ts
```

The browser check uses a known-good map fixture; a release must also pass
`npm run build:static` on the entire intended catalogue. The new voting database
is separate from dormant local-edition ratings; those records are not imported.
