# Changelog

All notable changes to VibORM are recorded here. Releases follow Semantic
Versioning.

## Unreleased

- **Recursive relation projections.** A self-relation's node — `parent`,
  `children`, a proven one-to-one inverse or a paired junction graph — takes
  `recurse` in `select` and `include`: `true`/`{}` follow the relation to depth
  100, `{ depth: n }` to `n` levels (1–1000), `{ depth: false }` exhaustively;
  a junction graph prunes cycles path-locally by default and may unfold them
  with `{ preventCycles: false }` under a bounded depth, while a foreign-key
  cycle inside the traversed window is an error. The node's own projection
  repeats at every level, filters prune every hop, each level keeps its
  `orderBy`, and the repeated key is absent at a numeric cutoff and present
  (`[]` or `null`) where the data ends. One provider statement serves any
  depth; the result composes with the cache, `omit`, extensions, arrays and
  callback transactions like any other relation projection, and
  `renderOperationResultType` renders a recursive result as named declarations.
  Output grows with paths, not rows: a graph can return exponentially more
  occurrences than it stores, even with cycle prevention, so depth 100 is not a
  size bound. Executed locally on SQLite, PGlite, native PostgreSQL 16 and
  native MySQL 8.4 (the placement matrix and the hierarchy and graph worlds on
  all four; the composition matrix on SQLite; 300 generated cases each on
  SQLite, native PostgreSQL and native MySQL); hosted providers are not yet
  qualified. Where the provider spells `LATERAL` the carrier's recursive CTE
  lives in a lateral derived table, because MySQL materializes a correlated
  CTE that is read twice once per statement. Providers cap exhaustive
  traversals with their own limits: MySQL's `cte_max_recursion_depth` surfaces
  as the provider's error (errno 3636), never as a truncated result. The
  output key `_distance` has one producer: a relation named `_distance`
  (recursive or not) cannot be projected beside a point's distance, in either
  order — the refusal a scalar of that name already met.
- **A connection must be representable.** An explicit `connect`, and the found
  and the create arm of `connectOrCreate`, establish a relation by writing the
  value the target holds for the referenced field. Every component that
  connection needs must be present and non-NULL. A target whose
  referenced field reads NULL cannot establish the requested relation, so the
  write is refused — `NestedWriteError`, naming the relation and the field —
  instead of writing that NULL and silently disconnecting the holder from
  whatever it pointed at. One requirement covers both directions (a parent-held
  edge and a child-held one), found and produced values, and single and compound
  references; it is checked before the connection is consumed, so nothing is
  written and then discovered. Ordinary nullable scalar writes, an explicit
  `disconnect`, and a NULL field that is not part of the consumed reference are
  unaffected, and a model declaring a nullable referenced unique is not itself
  refused.
- **A selected bulk mutation carries its selector to the
  effect.** An `updateMany` or `deleteMany` that captures an identity set and
  then consumes it sends BOTH the complete captured identity set and that
  statement's original prepared selector in the consuming statement. A row that
  stopped matching the selector between the capture and the effect is therefore
  not mutated, on the batch route as on the interactive one, and the existing
  `selected-row cardinality changed` error is the answer when fewer rows are
  affected than were captured. Failure and commit stay separate facts: on an
  operation-owned interactive transaction its owner rolls back; on an already
  acknowledged atomic batch the acknowledged effects and the result-phase
  failure are both reported truthfully — a check after dispatch cannot undo that
  batch and does not claim to. Compound and mapped keys, `limit` and the
  zero-result answer are unchanged.
  A nested captured series is BOUNDED in the same spirit: the initial filter
  selects the worklist ONCE, and a qualifying row that joins after that boundary
  is not adopted into it. The filter is not re-evaluated before every member —
  an earlier member may legally change the facts a later one was selected by —
  but the actual identity, parent and relation-membership requirements are still
  enforced where they always were, so a member that loses or changes its
  membership is still not consumed. `FOR UPDATE` locks rows; it does not exclude
  phantoms, and nothing here claims otherwise.
- **Native MySQL is part of local release qualification.**
  The `mysql2` driver is qualified against a local MySQL 8.4 — schema push and
  re-push, the migration and namespace boundaries, the read and nested-write
  inventory, and concurrency — rather than inheriting its status from shared
  transport code. A database-selected deadlock victim is a FAILED transaction:
  it is reported as the provider failure it is, with no committed victim
  effects, and it is never treated as an eligible unique-key race or silently
  replayed. The recoverable unique-key race that `upsert` and `connectOrCreate`
  already converge under is unchanged. Hosted MySQL (PlanetScale) qualification
  remains deferred.

- Prepare the V1 release and publication system.
- **The query engine is replaced.** Raptor 3 (the name that appears in some
  engine error messages) is now the only engine behind the public client API,
  which is unchanged: every operation, filter, nested
  write, transaction form and result shape is the same, and the differences
  the cutover surfaced were repaired to the old engine's answers or ruled and
  documented one by one. What changed at the adapter and driver contracts is
  listed below. Every refusal the engine raises is a documented sentence, and
  the sentences fall into three kinds that are easy to confuse:

    - **An invalid request.** The operation asked for something the data cannot
      represent — a connection whose reference value is NULL, a `_distance`
      selection beside a field of that name. Nothing is written; correcting the
      request is the whole remedy.
    - **An operational database failure.** The provider refused the work or
      aborted the transaction — a deadlock victim, a constraint violation, a
      driver that answered a malformed or missing result. The driver normalizes
      it; it is a fact about that run, not a limit of the ORM, and the same
      request can succeed on the next one.
    - **A capability refusal.** The engine will not do this here — building a
      write to one SQL statement, a generated non-increment key on a transport
      with no interactive transaction. This one names a boundary that will not
      move by retrying.

  A failed internal invariant is none of the three: it is thrown as an
  `EngineInvariantError`, carries no `V####` code, and is a defect to report.
  Counting sentences does not measure any of this. The three kinds above are
  this changelog's own reading of what a failure means to a caller; the census
  (`scripts/raptor3-refusal-census.mjs`) separates a different three by
  construction — invariants, private-fit internals and refusals — and reports
  23 distinct candidate sentences this engine spells that the previous one did
  not: a count of SENTENCES, not of operations you can no longer perform, and
  not a coverage figure. What the engine does and does not support is the
  behavioural inventory's fact, one row per admitted fact.
- `DatabaseAdapter["expressions"]["integerDivide"](left, right)` is a
  **required** adapter member: the portable integer quotient the engine uses when it has to state in SQL
  the value an integer or bigint column will hold after a `{ divide }` (PostgreSQL integer
  division, `TRUNCATE(a / b, 0)` on MySQL, `a / CAST(b AS INTEGER)` on SQLite).
  A third-party adapter must add it; this is a compile-time change for adapter
  authors and invisible to client code.
- `PendingOperation.buildStatement()` (and the engine's internal
  `QueryEngine.build()`, which backs it) answers the one SQL statement a
  **read** compiles to, taken from the prepared read the execution itself
  runs. Every write now answers the `does not compile to one SQL statement`
  refusal — including a write the previous engine could fold into a single
  statement, such as a scalar `delete` on a driver with `RETURNING`. Run the
  operation instead of building it.
- A nested write that must observe its own earlier writes — a member that
  reads a row an earlier member wrote, a series of dependent members — now
  runs on a **batch-only** transport that keeps no session between requests
  (Neon HTTP, D1) as a succession of atomic batches, each committing as it
  completes. A key the database generated in one batch is read back at the
  end of that batch and carried into the next as a literal, so such a write
  no longer fails with a bare provider error once its first batch has
  committed. This is verified on a batch-only fixture that keeps no session
  between requests; the live Neon suite is credential-gated on
  `NEON_TEST_DATABASE_URL` and was not run for this release, and the D1 driver
  is exercised on the Workers runtime's own local D1 and on no hosted
  Cloudflare D1. A failure in a later batch leaves the earlier batches committed,
  and the error says so (`atomicity: "segment"`, `committedSegments`). Nothing
  changes on a transport with an interactive transaction, where the whole
  write is one transaction.
- The transport facts each driver guarantees for a nested write — how it runs,
  what a mid-way failure leaves behind and how it is reported, the bind
  capacity per statement, and which of these are verified live — are stated
  per driver in the [drivers overview](/docs/drivers)
  under "Nested writes and failures per driver".
- The SQLite drivers (`sqlite3`, `bun-sqlite`, `d1`, `libsql`) no longer
  normalize `count`/`exist` results in their driver-level `parseResult`
  middleware. The query engine's decoder owns the meaning of a count and an
  exists answer — it asks for its own `_count` alias and reads it back — so
  those answers are unchanged on every SQLite driver. The
  `DriverResultParser.parseResult` contract itself is untouched: a consumer
  that wrapped `driver.result.parseResult` is still asked once per operation
  with the provider's raw result, and is unaffected in outcome. The shipped
  `parseResult` function itself no longer exists on those drivers: a wrapper
  that captured it before installing its own must check for its absence
  before calling it.
- The MySQL adapter no longer normalizes `count`/`exist` results in its
  adapter-level `parseResult`. The query engine's decoder owns the meaning of a
  count and an exists answer — it asks for its own `_count` alias and reads it
  back, and a count carried under any other column was refused before this
  deletion exactly as it is after it — so those answers are unchanged, on the
  live route and inside `$transaction([…])`.
- The PostgreSQL adapter no longer converts a bigint in its adapter-level
  `parseResult`. That leg was offered the operation's row array rather than a
  value, and an integer's width is owned by the query engine's own scalar
  codec, which turns a bigint or an integer text into a number and refuses one
  outside the safe integer range. Count answers are unchanged on both the `pg`
  and the `postgres.js` transport.
- `DatabaseAdapter["result"]["parseResult"]` is untouched: it remains a
  required member, still asked once per operation with the provider's raw
  result, and on all three shipped adapters it is now the pass-through the
  SQLite adapter has always installed.
- A nested write under a parent with a generated increment key now runs on a
  PostgreSQL-family transport that has no callback transaction (Neon HTTP, a
  batch-only PGlite) as one native batch: the parent's INSERT is a
  data-modifying CTE whose own RETURNING stores the key in the batch
  reference table, and every later statement of the same batch reads it back. Such writes were
  refused before ("Raptor 3 G1 atomic output requires exact identity scratch
  or segmented RETURNING"). A generated key that is not an increment key on
  such a transport keeps that refusal.
- The batch reference contract (`@internal` `BatchReferenceSqlAdapter`) gains
  an optional `storeReturning(batchId, key, insert, column)`, present on the
  PostgreSQL adapter; the PostgreSQL batch reference table is no longer
  declared `ON COMMIT DROP`, so the table survives the batch that created it;
  each dispatched batch makes its own reference rows and drops them at its own
  end. The logical `CastType` gains `"bigint"` (`BIGINT` on
  PostgreSQL, the 64-bit integer cast the other dialects already had), so a
  `bigint` increment key is read back at its own width.

## 0.1.0 - 2026-01-24

- Published the initial development package.
