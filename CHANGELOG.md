# Changelog

All notable changes to VibORM are recorded here. Releases follow Semantic
Versioning.

## Unreleased

- Prepare the V1 release and publication system.
- **The query engine is replaced.** Raptor 3 (the name that appears in some
  engine error messages) is now the only engine behind the public client API,
  which is unchanged: every operation, filter, nested
  write, transaction form and result shape is the same, and the differences
  the cutover surfaced were repaired to the old engine's answers or ruled and
  documented one by one. What changed at the adapter and driver contracts is
  listed below. Every refusal the engine raises is a documented sentence; 23 of them are
  new in this release and the rest are sentences the previous engine already
  raised. Each names a capability limit, a provider-integrity fact or a
  transport boundary rather than a defect. A failed internal invariant is
  thrown as an `EngineInvariantError`, which carries no `V####` code and is
  never one of those refusals.
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
  between requests; the live Neon witness runs only where
  `NEON_TEST_DATABASE_URL` is set, and there is no live D1 witness in the
  repository. A failure in a later batch leaves the earlier batches committed,
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
