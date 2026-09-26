# Authoritative player-command boundary

`NodeSimulationAdapter` accepts the service's `ValidationInput`, not a legacy
replay. The HTTP layer must resolve its RunBinding from the opaque submitted run
ID and enforce browser-token ownership, expiry, idempotency and rate limits. Those
database/service responsibilities are not claims made by this simulation layer.

Before starting an engine it validates the canonical map format/content hash,
ordered plugin sequence, difficulty, pinned engine and adapter version, seed and
the explicitly injected reviewed support policy. There is no permissive default
policy. Reference-test policies are isolated test data, not release approvals.
Production derives the runtime level ID from this trusted binding after the raw
content hash check. An unknown, malformed or altered input never becomes a win.

Only the following player intentions can reach the reducer:

- Move a currently movable pawn from the player's live region to a location the
  original warfare rules permit.
- Buy an object exposed by the original shop/plugin rules in the player's live
  region, at the original price, with sufficient treasury and a legal drop.
- End the player's turn; the original AI/neutral logic supplies all other actions.
- Accept a surrender actually offered by the engine at entry to that player turn.

The original shop's base inventory is expressed without importing Phaser UI;
plugin hooks and prices are evaluated by the real engine. Internal tap flags are
always derived as `false`, matching ordinary UI MovePawn/BuyPawn calls. Conquest
and merge effects remain engine-owned. Choosing a landing is structurally known
but explicitly unsupported pending its modifier parity work; it is not converted
to an unchecked spawn command.

The normal browser offers surrender using `shouldOfferSurrender` (896), empty
tapped units and the local-turn/session gates in module 5378. The adapter records
that offer when the turn begins. It never treats the permissive internal
`AcceptSurrender` reducer as proof that an offer existed. The canonical record does
not claim to prove whether a player dismissed a popup or explored other branches.

Trailing decisions after the first terminal GameOver are invalid. A complete
legal winning branch produces engine-derived turns and final-state hash. Valid
unfinished/defeated branches are non-winning; unreviewed configurations and
deterministic limits are unsupported; unexpected engine failures and timeouts are
infrastructure errors. No rejected outcome can be mistaken for `verified`.
The hash uses the original compressed state with only generated region labels
omitted, as documented in `adapter-parity.md`. It retains the binding-derived
runtime level ID and all gameplay fields and array ordering.

## Resource and failure behavior

The parser bounds map and decision sizes before simulation. The session bounds
turns, phase transitions and attempted internal plays, including discarded AI
speculation. Each public validation uses a fresh Node worker with an explicit
heap limit and a parent-enforced deadline. Terminating the worker interrupts even
synchronous engine work. Limits are provisional pending the release benchmark.
See the [Node worker documentation](https://nodejs.org/api/worker_threads.html).

`validateInWorker` is an internal/test entry and does not itself provide a hard
deadline. Production composition must use `NodeSimulationAdapter`. The VM is not
a sandbox for uploaded code: only checked release bundles run, map scripts are
rejected, and engine code receives no network or browser APIs.

## Verification and acceptance

Run `npm test -- tests/validation.test.ts tests/adapter-parity.test.ts` and
`npm run build`. Focused tests exercise genuine engine wins/losses/unfinished play
in both difficulties, genuine versus fabricated surrender, ownership, prices,
unsupported purchases, unreachable destinations, internal/tap payload injection,
trailing decisions, changed bindings, unreviewed policy, turn limits and a hard
worker deadline. Assertions check observable outcomes rather than mocked engine
calls. The public worker also reconstructs all 14 repeated browser cases,
including real multi-action purchase wins. Mutations reverse their order, remove
the final winning move, take an opposing pawn, add a snapshot/tap override, and
attach a false victory claim to an incomplete branch. None becomes verified.
The same tests compare engine-derived winning turns and final-state hashes with
the browser's first terminal state under the binding-derived runtime identity.
Independent boundary review remains required before authoritative statistics are
enabled.
