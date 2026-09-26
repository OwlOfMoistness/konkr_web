# Community protocol v1

The extension lives in `community/`. The compiled release remains the reference;
generated copies and integration patches must not alter the original files.

## Runtime and tooling

Use Node 24 or later, erasable TypeScript and ES modules. Node executes `.ts`
directly; `npm run build` separately checks types. See the official
[Node TypeScript documentation](https://nodejs.org/learn/typescript/run-natively).
`npm test -- tests/contracts.test.ts` runs one suite. `package-lock.json` pins
dependencies; a runtime manifest will pin the reference browser and game assets.

## Maps and catalog

`MapRecord` is stable identity and editorial metadata. `MapRevision` is immutable
gameplay content, addressed by a content hash and an opaque storage key. Embedded
game level IDs are not server identities. Metadata is plain text. Tags normalize
to lowercase without a leading `#`. Queries sort stably and paginate with a
bounded limit/offset; only published supported revisions are public.

Publication and run issuance consume the same injected `SupportedConfigurations`
policy. Each entry approves an exact engine/difficulty/ordered-plugin combination
with test evidence. Plugin registration order is preserved by the original engine;
reordered sequences require their own evidence. No combinations are approved merely because individual plugins
exist in the game. Test policies must never replace the reviewed release policy.

Player views switch within one unchanged URL, including catalog, details, play
and return. Keep filters and navigation state in memory/session storage without
changing the URL path, query or fragment. The curator entry point may be separate.

Storage keys are server-owned and revision-specific. HTTP handlers must never
interpret client strings as filesystem paths. Curator/admin roles protect all
content mutations independently of the anonymous player experience.

## Runs and semantic decisions

Issue a `RunBinding` before the first decision, resolving canonical revision,
content hash, engine, adapter, rules, difficulty and any required seed server-side.
An opaque browser cookie associates runs without public accounts. Resume keeps
the binding; restart obtains a new binding. Issuance failure prevents a new
verifiable start. An already-issued run can continue offline and submit later.

Submit `{version:1, runId, idempotencyKey, decisions}`. Repeated requests with the
same idempotency key and content return the same result; conflicting content is an
error. The backend rechecks the run binding, full history and resource limits.

Decisions describe player intent: move, buy, end turn, accept an offered surrender,
or choose an allowed landing tile. `tapUnit`, AI moves, spawn/editor commands,
claimed scores and snapshots are excluded. Parsing does not establish legality:
the adapter must derive internal flags, verify actor/resources/rules and regenerate
all opponent/script effects. Exact UI-intent mapping is confirmed by runtime tests;
changes to this versioned boundary go through the coordinator.

Undo/rewind preserves the final canonical branch, without claiming no discarded
attempts occurred. Persist the original binding and complete branch through saves
and reloads. A cropped or unsupported record is never upgraded to a verified win.
Raw legacy replays are diagnostic fixture input, not this public command protocol.

## Results and failure states

Only `verified` with engine-derived `victory` and turns contributes to records.
`non-winning` can mean valid unfinished or defeated play; `invalid`, `unsupported`
and retryable/nonretryable infrastructure `error` remain distinct. The UI can show
local victory while a server result is pending. Never label timeouts as cheating.

Count each accepted run once in a transaction. Bucket results by revision,
difficulty and compatible engine; store the lowest turns, with shared ties.
Retain evidence for current records. These are valid solutions, not proof of
human identity, absence of assistance, or elapsed-time authenticity.

Anonymous ratings use one editable 1–5 rating per browser token/revision. Display
count and average, and use quotas/idempotency. Tokens cannot prove unique humans.
Metadata edits retain ratings; new gameplay revisions keep separate ratings.

## Initial limits

`LIMITS` supplies conservative input limits for early development. Enforce bytes
before JSON parsing, decompressed size while decoding, and action/turn/runtime
limits during execution. Benchmark supported maps before the release review;
unsupported size/configuration must produce explicit errors, never partial runs.

## Runtime save identity

The client and server derive the same `cl-community-` level ID from map, revision,
engine and difficulty using `shared/runtime-identity.ts`. Only the in-memory
`map.levelId` is replaced; canonical stored file bytes and their hash remain intact.
This prevents imported IDs from colliding with campaign and unrelated map saves.
The pinned simulation stores this field and includes it in serialization; its
AI and RNG do not read it. Parity fixtures must check renamed starts explicitly.
Browser fixture runs without server bindings can still use the original ID;
production comparisons and final hashes use the derived ID on both sides.
