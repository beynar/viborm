# 1.4.0: measurements

Evidence for the 1.4.0 PR: fewer round trips, statements D1 can run, faster
`distinct` and junction filters, the `undefined` bulk-where refusal and
`$extends({ result })`. Each section was measured by the lane that made the
change, old and new interleaved in one process, with identical answers
checked.

The machine (Apple M4 Pro, Node 24) was shared by five lanes running tests,
with a load average of 15–56. Statement counts, bytes, opcodes and bound
values are exact; times are medians and should be read as ratios.

- **Local databases:** PGlite (PostgreSQL 17), better-sqlite3 3.53, libSQL in
  memory, D1 through Miniflare (workerd). Docker was down: real PostgreSQL and
  MySQL run in CI only.
- **Scripts** lived in a scratch directory; each section names its workload.

## 1. Writes that return relations answer in one statement

A root `create`, `update`, `upsert` or `delete` with `include`, a relation
`select` or `_count` used to locate the row, write it, and read the
projection again, inside a transaction. `OperationContext.answersInStatement`
now decides whether the write's own statement can answer:

- **PostgreSQL:** `WITH "__viborm_mutation" AS (<write> RETURNING *) SELECT
  <projection> FROM "__viborm_mutation" AS "q0"`, the projection built by the
  normal read lowering (`Queries.select` with a `source`).
- **SQLite, libSQL, D1:** the projection inside the write's `RETURNING`,
  correlated by the table's own name.
- **MySQL:** no `RETURNING`; unchanged.

Not found still raises the same `NotFoundError`: the write's own `WHERE`
locates the row.

It declines, keeping the old route, when:

1. the projection's SQL reads the written table (self-relation, a filter or
   a policy reaching it);
2. an UPDATE writes part of a key a foreign key can reference (a cascade
   could change what is read);
3. decoding could refuse the row afterwards (read-gated fields, recursive
   relations, polymorphic slots), since that refusal must roll the write
   back;
4. a DELETE on SQLite (its `RETURNING` reads after the cascade);
5. D1 when the projection repeats a shared body (`RETURNING` takes no `WITH`).

Statements (round trips), standalone, no permissions:

| Operation | PostgreSQL | Neon-shaped batch | SQLite | D1 |
|---|---|---|---|---|
| create + include | 2 + tx (4 RT) → **1** | 2 in 1 batch → **1** | 4 RT → **1** | 2 in 1 batch → **1** |
| update + include / `_count` | 3 + tx (5 RT) → **1** | 4 (2 RT) → **1** | 5 RT → **1** | 2 RT → **1** |
| upsert (found or missing) + include | 5 RT → **1** | 2 RT → **1** | 5 RT → **1** | 2 RT → **1** |
| update of a missing row + include | 3 RT → **1** | 1 | 3 RT → **1** | 1 |
| delete + include | 5 RT → **1** | 3 RT → **1** | unchanged | unchanged |

- With permissions on, the counts are the same. Inside `$transaction`,
  update + include goes from 5 statements to 1 (no savepoint).
- Real Miniflare D1: update + include 4 statements / 2 RT → 1 / 1; upsert +
  include 3 / 2 → 1 / 1.
- In process: PGlite update + include 0.69 → 0.27 ms; SQLite3 0.058 →
  0.031 ms. At 20–50 ms per round trip, update + include saves 80–200 ms on
  pg over Hyperdrive and 20–50 ms on D1 or Neon.
- **Differential check:** 436 cases × 6 profiles (libSQL included),
  permissions on and off, against a snapshot of main. Every answer, error
  class, error message and the database state after each case are
  identical; 56 cases use fewer statements. One difference: on batch-only
  drivers, `$transaction([update({ include })])` used to throw "cannot be
  batched" and now works.
- Unchanged: nested writes with include, scalar-only writes, bulk verbs,
  MySQL.

Tests: `tests/contracts/engine/write/write-projection-round-trips.test.ts`
(29), `tests/providers/workers/d1-write-projection.test.ts` (2); re-pinned
`mutation-projection-cte-fold.test.ts`, `g4/unit02/physical-envelope.test.ts`,
`raptor3/generation/relations.ts`. Each guard was removed in turn and its
tests failed (guard 1: 13 failures, guard 2: 4, SQLite delete: 3,
decode refusal: 6, shared bodies: 1, PostgreSQL derived-table wrap: 1, fold
off: 23).

## 2. `findUnique` batching

`findUnique` and `findUniqueOrThrow` calls issued in the same tick become one
`findMany`, and each caller gets its own row
(`src/query-engine/find-unique-batch.ts`, hooked in `PendingOperation`).
The merge sits below request transforms, controls, admission, query
interceptors, the cache and observers: every extension still sees one
operation per call.

Calls share a batch only with the same root client view, model, unique key
spelling, `select`/`include`/`omit` (nested arguments included) and
per-call controls, outside every transaction, with a `where` that is the key
alone and key members of type string, int or bigint. A row goes to a caller
only when its key is exactly equal in JavaScript; a missing string key (a
collation may match what JavaScript does not), a missing
`findUniqueOrThrow` key and a failed merged read run each call alone again,
so a batch can cost a statement but never change an answer. Batches split at
the driver's bind limit (D1: 100).

N = 50 lookups by string id:

| Case | Before | After |
|---|---|---|
| SQLite3 | 1.29 ms, 50 statements | 0.63 ms, 1 statement |
| PGlite | 7.75 ms | 0.60 ms |
| Simulated 20 ms per statement, one connection | ~1,080–1,110 ms | 22–24 ms |
| Simulated 20 ms, unlimited parallel requests | 21–33 ms | 21–24 ms |
| 10 of 50 string keys missing | 50 statements | 11 statements |

A single awaited call costs about +1.2 µs (8.55 → 9.8 µs on SQLite).

**Workers:** checked in workerd through Miniflare (compatibility dates
2024-06-01, 2025-10-11, 2026-03-10; `nodejs_compat` on and off) with a
module-scoped client shared by 20 and 50 concurrent requests, including
requests that resume together and requests that return early. No statement
held two requests' keys, every answer was right, nothing hung and workerd
logged no warning: each request resumes in its own microtask run, so
requests never share a batching window. Forcing a cross-request merge makes
workerd cancel the parked requests, exactly as it does without batching.

Tests: `find-unique-batching-behavior.ts` on SQLite3 (13) and PGlite (12):
order, duplicates, missing keys, `OrThrow`, compound keys, calls that must
not merge, transactions, failure recovery, interceptors and observers,
statement transforms, two permissions actors, bind splitting, a NOCASE
column, a JSON key named `__proto__`. 14 mutations, all caught.

## 3. D1: the four refused permission reads now run

SQLite copies a `WITH` member into every place that reads it, and a nested
member again inside each copy, so sharing shortened the text but not the
compiled program, which is what D1 limits. On SQLite, a member that is not
inlined (a body reading another shared body, and `$exists` bodies) is now
written `AS MATERIALIZED`; leaves stay inline, the rule PostgreSQL already
uses (`createCteBuilders(quoteIdent, { inlining, materializing })`).
PostgreSQL's SQL is byte-identical.

| Read (u02) | Bytes before → after | Opcodes before → after | D1 |
|---|---|---|---|
| roots 3 depths + grants | 89,147 → 89,706 | 63,867 → 14,345 | NOMEM → runs |
| document every relation + `$access` | 84,248 → 84,638 | 42,503 → 13,443 | NOMEM → runs |
| page 3 depths group + grants | 74,913 → 75,472 | 65,111 → 12,034 | NOMEM → runs |
| accessGrant every relation + `$access` | 68,305 → 68,747 | 37,867 → 10,690 | NOMEM → runs |
| the 5 reads that already ran | about +13 B per member | 2–3× fewer | runs |

- Large reads on better-sqlite3: page 3 depths 357 → 12.6 ms; at 10× the
  rows, 34 s → 0.26 s. D1 suites end to end: entry 50.5 → 46.1 s, verbs
  32.9 → 24.9 s.
- **Cost:** single-row checks pay for the per-action grants member, now
  computed once in full: `can` 17 → 177 µs on the fixture, 0.67 → 4.5 ms at
  7,500 documents and 14,000 grants (and more rows read, which D1 bills).
  PostgreSQL already materializes these members.
- Tried and dropped: materializing every member (no faster, more opcodes).
- PostgreSQL: `pglite-permissions-entry` (W-CAN6) 84/84 in 93.6 s.

## 4. Cheaper shared-body keys; MySQL can share

- `sharedKey` renumbers aliases with a hand-written scan instead of a regex
  and builds the key from length-prefixed parts. On a 7-statement policy
  build (442 bodies, 65 distinct) it groups exactly as before; keying 1,675
  → 1,339 µs; extra build time per statement P1 +215 → +170 µs, P3 +642 →
  +508 µs, `can` +311 → +248 µs. In-process SQLite sharing stays off
  (point reads still lose: `can` 379 → 780 µs).
- Alias renumbering recognises MySQL's backtick quotes. With sharing forced
  on, "roots 3 depths + grants" on MySQL goes from 495 KB and 5,088 bound
  values to 84 KB and 520. No MySQL driver turns sharing on yet (no MySQL
  plan measured); `tests/providers/docker/mysql2-shared-bodies.test.ts` runs
  it in CI.

## 5. `distinct` with one window

Each order term is selected once as `_ord0…N` beside the `_rn` window and the
outer `ORDER BY` reads those columns; the second `_ord` window and its sort
are gone (`assembleDistinctOnEmulation`). SQLite, MySQL, and PostgreSQL when
an `orderBy` is set. 200k rows, the engine's own SQL:

| Case | SQLite | PGlite |
|---|---|---|
| take 10 | 253 → 121 ms | 273 → 127 ms |
| take −10 | 252 → 122 ms | 281 → 141 ms |
| relation orderBy | 334 → 221 ms | 311 → 163 ms |
| nested include | 0.18 → 0.13 ms | 0.57 → 0.49 ms |

Tests: `distinct-window-sql.core.test.ts` (PostgreSQL, MySQL, SQLite nested)
and 8 oracle tests in `distinct-skip-window-behavior.ts` (NULLs, duplicates,
negative take, cursor).

## 6. Many-to-many filters join the junction (SQLite family)

`EXISTS (SELECT 1 FROM junction JOIN target ON … WHERE junction.source =
parent.key AND …)` instead of `target.id IN (correlated junction subquery)`
inside `EXISTS`, behind the adapter capability `joinsJunctionFilters`
(SQLite, so libSQL, Bun and D1 too). SQLite:

| Query | Before → after |
|---|---|
| count, `some` on 99% of tags | 1,240 → 61 ms |
| count, `every` | 2,910 → 65 ms |
| reverse direction (tag → posts) | 146 → 5.8 ms |
| page of 20 / unique lookup / nested include | 0.77× / 0.60× / 0.80× |

All 16 engine shapes and 16 hand-written shapes are faster on SQLite.
PostgreSQL keeps the old form: forced on, scans get much faster (count
273 → 6 ms, OR 1,727 → 24 ms) but bounded reads get slower (page of 20
1.46×, nested include 1.5×), mostly planning time. A 46-check equivalence
script (compound keys, self junction, soft delete on both sides) agreed on
SQLite old, SQLite new and PGlite.

## 7. Rejected: relation filters as `fk IN (SELECT …)`

- PostgreSQL already turns `EXISTS` into the same semi-join, and gives it a
  hashed subplan under `OR`; `NOT IN` cannot become an anti-join (`none`
  1.97× slower); under a unique lookup plus `OR` it is 40–118× slower.
- SQLite builds the whole `IN` set first: unique lookups 72–454× slower, a
  tenancy condition 25–203×, nested includes up to 5.5 s instead of 30 ms.
- Whether a read is unique, paged or nested is not visible where relation
  filters are lowered, so no structural rule was faster on both without a
  regression.

## 8. Bulk writes refuse a `where` that `undefined` emptied

`deleteMany({ where: { tenantId: undefined } })` deleted every row (an
`undefined` member is an absent one). `updateMany` and `deleteMany`, root and
nested in relation writes, now throw `ValidationError` V4001 when the where
matches every row only because members spelled `undefined` were dropped,
naming them. `where: {}`, no where and `{ AND: [] }` still mean every row.
The rule reads the logical skeleton as the engine does: `{ AND: [{ id:
undefined }] }` and `{ NOT: { id: undefined } }` are refused; `{ OR: [{ id:
undefined }] }` (matches nothing) and `{ author: { id: undefined } }` (an
author must exist) are not. A scalar filter whose operators are all
`undefined` was already refused ("Filter must contain at least one
operation"); a test now pins it for bulk writes. Cost: about +40 ns per bulk
call.

Tests: `bulk-where-undefined-behavior.ts` on SQLite3 and PGlite, including a
corpus of wheres checked against the database (refused exactly when the
query returned every row).

## 9. `$extends({ result })`

Prisma-compatible computed fields (`src/extensions/result.ts`): on reads,
row-returning writes, nested relation rows, recursive projections, both
transaction forms and cached reads; selectable and omittable; `needs`
fetched when not selected and stripped; composition across extensions;
`$allModels`; filtering or ordering by a computed field refused. Fields are
lazy, memoized getters, as in Prisma: `compute` runs on first read, over the
`needs` as fetched, so a throwing `compute` never fails a committed write;
query-level `omit` subtracts from a `select` naming computed fields. Types:
`compute` sees exactly its `needs`; root `select`/`omit` accept computed
names; rows gain the fields; clients without `result` keep their types.

Not yet: polymorphic variant rows; types for a nested `select`/`omit` naming
a computed field, `$withCache()` delegates and `ExtendedOperationResult`.

| Measure | Before | After |
|---|---|---|
| Types, `tests/types/client` program | 1,193,346 | 1,204,473 (+0.93%) |
| Instantiations | 6,917,885 | 6,957,677 (+0.58%) |
| `findUnique`, plain extended client | 9.9–11.0 µs | unchanged |
| `findMany` 100 rows + one computed field | ~40–43 µs (no field) | ~46–47 µs |

Tests: `result-fields-behavior.ts` on SQLite3 and PGlite (12 each, 8
mutations), `tests/types/client/result-extensions.core.types.ts` (3
mutations).

## Bundle

| Entry | 1.3.3 | 1.4.0 |
|---|---|---|
| pg application | 183,719 B | 188.39 kB |
| D1 Worker | 183,229 B | 187.91 kB |
| pg application + permissions | 196,634 B | 201.33 kB |

About +1.75 kB is `findUnique` batching (measured by removing its hook),
+2.2 kB the `undefined` refusal and `result`, the rest the write fold, the
D1 materialization and the distinct and junction changes. None can be
loaded on demand: batching runs under every client, and `$extends` is
synchronous.

## Runs

- `tests/contracts/public-client`, `engine`, `drivers`: 8,255 passed, 412
  skipped. `adapters`, `architecture`: 342 passed.
- `tests/raptor3/post-prep`, `recursive-query`, `tests/unit`,
  `tests/validation`: 12,307 passed; the 6 failing files need Docker.
- `tests/providers/local`: 5,383 passed, 1,393 skipped.
- D1 (`vitest.d1.config.ts`, `tests/providers/workers`): 254 passed.
- `pnpm test:types`: clean.
