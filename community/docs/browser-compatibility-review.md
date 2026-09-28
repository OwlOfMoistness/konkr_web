# Original-game compatibility review

Review scope: the community extension's integration with pinned Konkr 2.35.30,
following the reported Oasis mouse-input problem. This is a local compatibility
review, not a claim that every map, browser or possible action is bug-free.

## What is reused

The browser still executes the original renderer, input handling, gameplay
controller, rules, AI, map decoder and import/session machinery. Custom maps use
the original import path with a separate catalogue identity and save. The addon
provides catalogue navigation, server bindings, ratings and optional recording.
Runtime preparation verifies the original files against the pinned manifest;
its bundle changes are limited to the declared initialization hook and local
font fallbacks. Original release files remain unchanged.

## Reproduced integration regressions

| Problem | Correction | Regression coverage |
| --- | --- | --- |
| Clearing the loading message left an invisible element intercepting the center of the board. | Hide the status element when its message is empty, while retaining loading/error messages. | Public HTML with Oasis at desktop and compact sizes; DOM hit-testing and real mouse delivery to original Phaser input. |
| Disabling replay recording also removed catalogue autosave updates between launch and exit. | Mirror the original stable autosave checkpoints into the catalogue save independently of recording. | Turn 2 survives in the catalogue save; speculative AI branches are not saved. |
| Importing a different map/replay left the previous catalogue session attached, so Restart could launch the old map. | Save and detach the catalogue context for a replacement import; retain it on a rejected import. | Original restart/exit/Continue behavior, malformed imports, and replay import with the same runtime map ID. |
| Disabled official statistics and feedback still offered broken or misleading actions. | Show explicit local unavailability notices without sending data. | Isolated service tests and the actual original browser notification components. |
| Removing the remote reporter also removed visible fatal-error recovery. | Restore the original notification/reload mechanism with local-only wording. | Boot failure, gameplay failure and reload callback; real rendered fatal notification. |
| Original information links resolved against the local API, and copied island URLs forced HTTPS on an HTTP preview. | Keep informational links on the original website and build island links with the actual local origin. | Link construction checks; no change to in-game address-bar behavior. |
| Cancelling a drag left the import overlay visible. | Restore the original overlay/child pointer-event behavior in both local page templates. | Real Chromium drag enter/cancel with the pinned original drag handlers and each template's CSS. |

The new tests complement existing coverage for Normal/Hard imports, modifier
maps, custom-map restart/resume/return, original mode navigation, undo/rewind
recording, previews, curator publication, ratings and server validation.
Two agents independently reviewed the runtime and catalogue bridge changes;
the coordinator reviewed the combined diff and runs the integrated checks.

## Verification results

The coordinator ran the complete community suite with the pinned Chromium,
real PostgreSQL test schemas and both supplied-map fixture directories enabled:
**155 tests passed, zero failed, zero skipped** (137.35 seconds).
`npm run build` and `git diff --check` passed. The Docker image also completed its
typecheck and pinned-runtime preparation. No original release or website file
changed relative to the community implementation foundation.

The loading-overlay, autosave, replacement-import, disabled-service and
drag-cancellation regressions were reproduced before their fixes. The new
browser tests cover the real original notification components as well as canvas
input; they do not infer UI correctness solely from programmatic game actions.

## Intended differences and limits

Official cloud accounts/sync, telemetry, feedback delivery and online statistics
remain disabled. The preview opens the title menu instead of automatically
starting the first-visit tutorial; the original Tutorial expedition remains
available. Progress belongs to this local origin. The public player URL remains
unchanged during normal navigation. Validation remains switched off in the
running local preview, and reported played/completed counters are still separate
unfinished work.

Browser automation covers pinned Chromium at desktop and compact viewport sizes.
The in-app browser is also checked manually. This does not establish support for
every Safari/Firefox version, physical touch device or unsupported map ruleset.
