# Community maps
test
Maps in this folder ship with the website. Curators add or update them through
pull requests; approved changes appear after the next deployment.

1. Add the original `.konkr` map file directly to this folder. Do not include
   replays, saved games or player profiles.
2. Optionally add a JSON file with the same name: `my-island.konkr` can have
   `my-island.json` alongside it:

   ```json
   {
     "title": "My Island",
     "creator": "Map author",
     "description": "Two kingdoms separated by a forest.",
     "tags": ["forest", "small"],
     "added": "2026-09-29"
   }
   ```

3. Preview and play the map in Normal and Hard, then open a PR with its source
   credit and playtest notes. See the [build instructions](../community/README.md).

All metadata fields are optional. Defaults come from the map, with a filename
fallback for missing titles. Tags default to its plugins. `added` uses
`YYYY-MM-DD`.

Keep the map's embedded `levelId` stable when updating it. If two different maps
share that ID, add a unique `"id"` to one JSON file and keep it unchanged.
Files are discovered automatically during the build; no manual catalogue edit
or admin dashboard is needed.
