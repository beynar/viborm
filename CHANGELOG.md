# Changelog

All notable changes to VibORM are recorded here. Releases follow Semantic
Versioning.

## Unreleased

- Prepare the V1 release and publication system.
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
  reference table, and every later statement reads it back. Such writes were
  refused before ("Raptor 3 G1 atomic output requires exact identity scratch
  or segmented RETURNING"). A generated key that is not an increment key on
  such a transport keeps that refusal.
- The batch reference contract (`@internal` `BatchReferenceSqlAdapter`) gains
  an optional `storeReturning(batchId, key, insert, column)`, present on the
  PostgreSQL adapter; the PostgreSQL batch reference table is no longer
  declared `ON COMMIT DROP`, because a record series commits member by member
  on a batch-only transport and its later segments still read the references
  the first one stored. The logical `CastType` gains `"bigint"` (`BIGINT` on
  PostgreSQL, the 64-bit integer cast the other dialects already had), so a
  `bigint` increment key is read back at its own width.

## 0.1.0 - 2026-01-24

- Published the initial development package.
