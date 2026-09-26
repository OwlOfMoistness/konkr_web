# Client run recording

`attachRunRecorder({ loader, bridge, onError, onVictory })` must be installed
before the first catalog run starts. The server binding is obtained by the
launch bridge before importing a new game or restart. Resume keeps that binding.
Use `LocalRunStore` as the bridge's store and enqueue `onVictory` submissions
there; the results integration owns network retries and status handling.

The recorder observes original `GameHistory.addPlay` calls. The prior history
step's faction identifies the actor **before** the action; the newly appended
step identifies the phase after it. This distinction keeps the player's End
Turn and excludes the computer's moves, bandits, gifts and other automatic work.
Move and buy payloads become semantic commands without internal `tapUnit` flags.
The server independently derives legality, AI actions, surrender eligibility,
turn counts and victory. Client outcomes and snapshots are not evidence of a win.

Each decision stores its original history index for local branch management.
`rewindTo` discards decisions after the target index, covering undo, undo-all,
cross-turn rewind and the engine's temporary AI planning branches. The submission
contains only the final sequence of semantic decisions; it makes no claim about
the player avoiding rewinds. It has one stable idempotency key per bound run.

Landing selection is a separate original UI operation rather than a Play. Its
valid `PickLandingSpotMode.handleStartInteraction` call is captured as
`choose-landing`; the original history reset becomes index zero on the new
branch. This recording support does not enable that modifier for publication or
validation: the shared tested support policy remains authoritative.

An unexpected history reset/import or unknown player action marks recording
incomplete. Loading a legacy save without recording never upgrades it to a
complete run. It can still be played, but constructing a submission fails with
an actionable error. Restart requests a new binding and starts fresh recording.

Save snapshots retain the full original history, without the original export's
size limit, alongside the complete semantic recording. Speculative states from
inside an AI transaction are never persisted; closing during such a transaction
retains the last complete save. Microtask saves follow committed history changes
and rewinds. Local storage and protocol bounds report failure and preserve the
previous saved value. Local storage is editable and is not a trust boundary.

Pending submissions use a separate local-storage key from playable saves.
Reload, restarting, or beginning another revision therefore does not remove a
pending result. Re-enqueuing an identical run is idempotent; changing its recorded
submission is rejected. Acknowledge only after the results integration confirms
the server received and retained the submission. Network outages must leave
pending entries intact. Public records remain disabled until independent
simulation review passes.

All catalog navigation uses UI/session state; recording adds no paths, hashes,
query strings or history routes. The shared runtime level identity changes only
the in-memory map ID, while the canonical map bytes and hash remain unchanged.

`tests/recording.test.ts` checks branch and incomplete-save handling, local quota
and retry behavior, then uses pinned Chromium with the original release. The
browser check covers undo, buy/move save and reload, replaying the retained
branch to the same gameplay state (excluding only cosmetic region names),
Prison AI-turn exclusion and cross-turn rewind, and all 14 committed reference
cases including six actual victory outcomes. It asserts the URL stays constant
and no remote requests or original-engine errors occur. Landing capture has a
focused interface test; publication still awaits separate modifier parity.
