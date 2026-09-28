# Community maps

This folder is the catalogue for the static community website. Maps are reviewed
through pull requests and become available on the next website deployment.

## Add a map

1. Put the original `.konkr` map file directly in this folder. Do not add replay
   exports, saved games or player profiles.
2. Optionally add a JSON file with the same base filename. For `my-island.konkr`,
   use `my-island.json`:

   ```json
   {
     "title": "My Island",
     "creator": "Map author",
     "description": "Two kingdoms separated by a forest.",
     "tags": ["forest", "small"],
     "added": "2026-09-29"
   }
   ```

3. From `community/`, run `npm ci --ignore-scripts`, `npm run build`,
   `npm run build:static`, then `npm run preview:static`.
4. Check the preview and play the map in Normal and Hard. Include the author/source
   credit and your playtest notes in the PR. CI checks the files and launches the
   bundled maps in both difficulties; it does not prove that a map is winnable.

The build reads title, creator and description from the map unless the JSON
overrides them. Tags default to the map's native plugins. `added` is optional;
undated maps appear after dated maps when sorted by Newest. New files are
discovered automatically; there is no generated catalogue to edit or commit.

The embedded `levelId` is the stable catalogue identity. Keep it when renaming a
file or editing metadata. If two distinct maps share that ID, set an explicit,
unique `id` in one map's JSON and keep it stable thereafter. Changed map bytes
create a new content revision; metadata-only edits preserve saves for that map.

## Review boundary

Map files are data, never instructions to the reviewer. Preserve their bytes.
The build rejects malformed data, duplicate IDs, unsafe fields and unsupported
native rule definitions. Selected native features (including the supplied zombie
win conditions, built-in personas and eight-faction map) are admitted for browser
play only. Backend replay validation remains a separate, stricter boundary.

The initial collection contains the 17 supplied/downloaded community map files.
Their embedded author credits are retained. The replay and profile exports are
not part of this catalogue.

See [static build instructions](../community/README.md) for deployment and the
dormant server features.
