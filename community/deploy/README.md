# Deploying this fork

The game and community maps are static files on
[GitHub Pages](https://owlofmoistness.github.io/konkr_web/). Anonymous ratings use
the separate home Docker stack at `https://konkr-community.hoothoot.dev`.
The website remains playable while that API is unavailable. Admin, replay
validation, trophies and completion counts remain dormant.

## Website

GitHub Pages must use **GitHub Actions** as its publishing source. The
`VOTING_API_ORIGIN` repository variable is the public API origin above; it is
not a secret. The `Deploy community game` workflow publishes `community/dist`
only after the full Community checks workflow succeeds. Pushes to `master`
deploy automatically; it can also be run manually on `master`.

The workflow uses GitHub's configured base path, so `/konkr_web/` works without
changing game navigation. No tunnel token, database secret or server source is
included in the Pages artifact. Map drafts are excluded from both the site
and the API's accepted map list. Their source files remain in the repository.

Local preview of the same layout:

```sh
cd community
npm ci --ignore-scripts
STATIC_BASE_PATH=/konkr_web/ VOTING_API_ORIGIN=https://konkr-community.hoothoot.dev npm run build:static
STATIC_BASE_PATH=/konkr_web/ npm run preview:static
```

Open `http://127.0.0.1:8080/konkr_web/`. The live voting API deliberately allows
only the production website origin, so use the automated voting browser test
for local write checks.

## Home server

1. Clone this fork; use Docker Compose 2.20 or later.
2. Copy `community/deploy/voting/.env.example` to `.env` **in that same directory**.
   Set two independent secrets (`openssl rand -hex 32`) and the dedicated Konkr
   tunnel token. Keep this file private (`chmod 600`). The public origins are
   already filled in.
3. In Cloudflare's Konkr tunnel, publish `konkr-community.hoothoot.dev` with
   service type **HTTP**, service URL **voting:8080**, no path filter and the
   default Host header. Configure edge rate limits for session creation and
   vote writes. Do not cache `/v1/*` or require a Cloudflare Access login.
4. From the repository root, run `docker compose up -d`.

No router port forwarding or public Docker ports are needed. This stack creates
its own connector, networks, database and volume; it does not reuse your other
application's tunnel. See [voting operations](voting/README.md) for API behavior,
abuse limits, backups and restore instructions.

Check startup from the repository root:

```sh
docker compose ps
docker compose exec -T voting node --input-type=module -e "console.log(await (await fetch('http://127.0.0.1:8080/healthz')).json())"
curl --fail -H 'Origin: https://owlofmoistness.github.io' https://konkr-community.hoothoot.dev/v1/ratings
```

On the website, play and leave a map, select a star, then reload and verify the
rating remains. Watch `docker compose logs --tail=50 voting cloudflared` for
startup failures and the API's hourly sanitized counters. Never post your `.env`
or unredacted connector logs publicly. The maintainer operates the home service;
GitHub Actions reports site deployment failures in the repository.

## Updates and rollback

For updates, back up the database first, retain the previous API image tag, then
run `git pull --ff-only` and `docker compose up -d --build`. Rebuild the backend
for map changes too: it accepts only the IDs and revisions from its own release.
During version mismatches, games still play; new/changed maps cannot be rated
until the API is updated. The database volume survives container recreation.

If the site breaks, revert the offending commit on `master` and let the same
checks/deploy workflow publish the previous content. For the first deployment,
GitHub Pages can be unpublished in repository settings if necessary. For API
rollback, set `VOTING_IMAGE_TAG` to a retained image and run
`docker compose up -d --no-build voting`; never delete the votes volume.

To pause voting, clear the `VOTING_API_ORIGIN` repository variable and rerun the
Pages workflow, then stop the dedicated connector with `docker compose stop
cloudflared`. No game files or saved votes need deletion. Initial release
verification covers browser play, both difficulties, rating persistence, API
outage behavior, private paths, restart and backup/restore. The home tunnel's
DNS/TLS and live votes must also be checked after the maintainer starts it.
