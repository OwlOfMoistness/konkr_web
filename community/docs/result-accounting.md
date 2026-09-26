# Validation jobs and result accounting

`ValidationWorker` consumes accepted submissions from PostgreSQL. HTTP intake
stores immutable run bindings, submission identities and blobs before queueing;
the worker never accepts a client score or a submitted game snapshot as a result.
Public verified statistics must remain behind the adapter parity and strict
validation gate in the execution plan.

## Composition

Construct `new ValidationWorker(db, storage, adapter, options)`, using a fresh,
resource-bounded simulation for every `adapter.validate` call. The production
`NodeSimulationAdapter` provides this isolation; composition configures its
120-second timeout and 512 MB memory limit. Worker defaults are one concurrent
job, a 180-second lease, a one-second idle poll, three attempts and a five-second
retry base. Keep the lease longer than the adapter timeout plus storage and
accounting time. A slow job whose lease expires loses authority to finish.

`start()` launches bounded polling lanes. `runOnce()` processes at most one
available job, returns whether a job was claimed, and respects the same
concurrency limit. `stop()` stops new claims, wakes idle lanes and drains active
jobs. It does not delete accepted jobs or blobs. Injected adapters and storage
operations must finish or enforce their own operational timeouts.

`health()` starts with `healthy: false`, becomes healthy after a successful queue
poll, and becomes unhealthy on a claim or persistence database failure and after
shutdown. It includes active jobs, last poll, a fixed error code and process-local
counters. Readiness should require a healthy worker when submission intake is
enabled. Health describes the worker loop; an individual invalid replay or
unsupported configuration does not make the service unavailable.

## Claims, recovery and fencing

An atomic `FOR UPDATE SKIP LOCKED` claim selects an available queued job or an
expired running job. It installs a fresh random lease token and increments the
attempt count. Multiple processes can claim different jobs concurrently.

Finalization locks the run and checks both its current token and the database
clock **after acquiring the lock**. A superseded or expired claimant returns
`stale` without changing the run or any counter. Holding the row lock prevents
another claimant from taking over while finalization commits. An expired lease
already at the attempt budget is reclaimed only to store a terminal
`lease-attempts-exhausted` infrastructure error; no fourth simulation is started
under the default three-attempt policy.

Explicitly retryable infrastructure errors return the run to the queue with
exponential delay, capped at five minutes. Missing objects, storage read failures
and unexpected adapter exceptions are infrastructure failures. Adapter results
marked `retryable: false` are final immediately. Exhausted retries produce a final
error with `retryable: false`. Invalid, unsupported and non-winning outcomes never
enter the retry loop. Accepted submissions can finish after their issuance window
expires; that window governs intake, not adjudication of already accepted work.

## Input and result integrity

Before simulation, the worker bounds blob sizes, verifies the accepted submission
SHA-256, decodes the semantic commands, and checks the run/idempotency identity.
It loads the immutable revision, compares its map, engine and ordered plugin
identity with the server binding, verifies the canonical map SHA-256, and parses
the map format. The adapter then enforces supported configurations and legal
commands. Missing or corrupted accepted storage is reported as an infrastructure
error rather than an accusation that the player submitted an invalid move.

Adapter output must match a known result shape. Only `verified` with a victory,
bounded integer turns and a valid final state hash can affect public counters.
The run's terminal result and aggregate update commit in one transaction. A win
adds one completion and minimizes best turns in the exact immutable
`(revision_id, difficulty, engine_hash)` bucket. Invalid, unsupported, unfinished,
defeat and infrastructure results add nothing. The row lock and terminal state
prevent duplicate accounting, including retry after an uncertain commit. If
accounting rolls back, the live lease remains available for later crash recovery.
Maps, canonical blobs and accepted submission blobs are retained for review.

Metrics include fixed stages/codes, run ID, attempt, recovery indicator, queue
wait, validation duration and process memory. They exclude command bodies,
canonical map contents, cookies, browser token hashes and exception messages.
Metric callback failures cannot change adjudication.

## Verification

`CATALOG_TEST_DATABASE_URL=... npm test -- tests/verified-results.test.ts` creates
and removes a dedicated PostgreSQL schema. Coverage includes competing workers,
concurrent score updates, revision/difficulty buckets, stale completion after
reclaim, lease expiry while waiting for a lock, bounded crash recovery and
infrastructure retries, permanent outcomes, storage corruption, transactional
rollback, shutdown/concurrency, readiness recovery, and a real isolated tiny
winning replay. `npm run build` separately checks TypeScript types.
