# Static community catalogue

The current version ships the maps in [`../community maps/`](../community%20maps/)
with the website. Curators add or update maps through reviewed pull requests.
No application server, database, account or admin dashboard is needed to run it.

Optional shared voting runs in a separate Docker deployment in this same repo.
See [voting setup](deploy/voting/README.md) for the dedicated Cloudflare tunnel,
database, backup commands and opt-in static build setting. The default build
continues to work without a backend.

## Build and preview

Use Node 26.4.0 (the CI version). From this directory:

```sh
npm ci --ignore-scripts
npm run build
npm run build:static
npm run preview:static
```

Open `http://127.0.0.1:8080/`. If another local service owns that port, stop it or
use `PORT=8081 npm run preview:static`. Rebuild after changing maps or code.

Deploy **only `community/dist/`**. A
standard static host is sufficient; no API rewrites, SPA fallback, serverless
functions or runtime environment variables are required. For a project path,
set `STATIC_BASE_PATH=/konkr_web/` for both build and local preview. It defaults
to `/`. See the [Pages and Docker deployment guide](deploy/README.md).
Do not deploy the repository or its original `_site` output as this build.
This command prepares local artifacts; the existing distribution and release
review requirements still apply before publishing the original game assets.

For a host that builds from Git, use the repository root as its base directory,
`cd community && npm ci --ignore-scripts && npm run build && npm run build:static`
as its build command, and `community/dist` as its publish directory. Merging a
curator PR then updates the catalogue on the host's next normal deployment.

The player downloads one content-addressed catalogue JSON containing metadata
and all map files when the page loads. The browser then searches that data and
renders previews as needed. Changing any map or metadata produces a new bundle
URL. Configure HTML to revalidate on each visit; hashed catalogue files may be
cached indefinitely. Serve JavaScript with `text/javascript`, JSON with
`application/json`, and keep the generated HTML's Content Security Policy.

The original game bundles in the repository stay unchanged. This build reuses
the existing reproducible runtime preparation, native controls, miniature
previews, Normal/Hard selection and play/return transitions. The player URL
does not change when moving between menus and gameplay.

## Dormant features

Unless voting is explicitly enabled, the static entry point does not include admin code or call `/api/*`. Ratings,
play/completion counts, completion trophies and replay submissions are hidden
and no new catalogue completion progress or ratings are recorded. They remain
implemented in the server edition for a future version. Ordinary game saves
and custom-map resume continue to work in the browser; existing saved data is
not cleared. Difficulty-selector trophy artwork still identifies Normal/Hard.

The Node/PostgreSQL admin and replay validator remain in the repository; their
previous local setup is documented in [operations.md](docs/operations.md).
They do not need to run alongside this static site. Stopping their containers
does not delete their database or object volumes. To resume that edition later,
stop the static preview process and follow those existing start instructions.

## Checks

```sh
npm run build
npm run build:static
npx --no-install playwright install chromium
npm test -- tests/static-catalog.test.ts tests/static-site.test.ts
```

These checks validate the catalogue and use an ordinary static file server to
exercise native browser playback in both difficulties, navigation and disabled
statistics. All API/external requests are blocked by the browser test. This is
a loading/playback check, not a claim of verified completion or game balance.
The existing full backend and browser suite remains in CI for the retained code.
