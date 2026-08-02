# Query Performance Plan

**Date:** 2026-07-28
**Language:** This document uses Simplified Technical English (ASD-STE100 style).
**Status:** Phase 1 delivered (see the Phase 1 delivery record). Phases 2-10 not started.

## Source of this plan

Four audits examined the query engine and the generated schemas:

1. A static audit read the statement emission code.
2. An empirical audit counted the SQL statements for each operation on PGlite and SQLite.
3. A static audit examined the generated indexes and the predicate spellings.
4. An empirical audit ran EXPLAIN on the emitted SQL at a volume of 100,000 rows, with time measurements. Evidence files: `plan-audit-pglite.json`, `plan-audit-sqlite.json` in the session scratchpad.

The audits agree. The engine emits a correct number of statements for reads and for bulk writes. The problems are in five statement shapes and in the generated schemas.

## Rules for the work

- Each phase uses the standard harness: one implementer, two adversarial reviewers, a maximum of two fix rounds.
- Each phase must keep the full test estate green: `pnpm test:types`, `pnpm test`, `pnpm test:gates`.
- The final gate must run the Docker legs for MySQL (port 3307) and PostgreSQL (port 5434).
- A change must not remove an error message, an error attribution, or a race protection. A reviewer must attack each of these.
- The step vocabulary in `src/query-engine-v2/OperationFragment.ts` is frozen. No phase may grow it.
- If a phase changes pinned SQL in `tests/query-engine/sql-generation.test.ts`, the phase must update the pins deliberately, with a comment.

---

## Phase 1 — Make an index for each foreign-key column

**This phase has the highest value in this plan.**

### Problem

The serializer makes a foreign-key constraint for each to-many relation. The serializer does not make an index for the foreign-key column. MySQL/InnoDB makes an index for each FK constraint automatically. PostgreSQL and SQLite do not. Each include operation, each relation filter, and each nested-write locate reads the child table through this column.

### Context and code locations

- The relation loop in [`src/migrations/serializer.ts:214-289`](../../src/migrations/serializer.ts) pushes only `foreignKeys.push({...})` (lines 257-267). No `indexes.push` exists for these columns.
- The one-to-one case is already correct: a unique constraint is added at `serializer.ts:269-286`.
- The junction case is already correct: the PK covers the first column (`serializer.ts:414`) and an explicit index covers the second column (`serializer.ts:417-423`).
- The user-declared indexes are collected at `serializer.ts:201-212` (note: this block has the defect of Phase 2, Unit 2.1).
- The index DDL emitters per dialect: `src/migrations/drivers/postgres/index.ts:289-299`, `src/migrations/drivers/sqlite/index.ts:404-414`, `src/migrations/drivers/mysql/index.ts:364-398`.
- The consumers of the missing index: `buildCorrelation` in [`src/query-engine/builders/correlation-utils.ts:80-98`](../../src/query-engine/builders/correlation-utils.ts) emits `parent.col = related.col`; used by both include strategies ([`include-builder.ts:112-117, 178-183`](../../src/query-engine/builders/include-builder.ts)), by each relation filter ([`relation-filter-builder.ts:365`](../../src/query-engine/builders/relation-filter-builder.ts)), and by the nested-read window ([`nested-read-window.ts:43-58`](../../src/query-engine/builders/nested-read-window.ts)).

### Measured effect at 100,000 rows

| Operation | Without the index | With the index | Ratio |
| --- | --- | --- | --- |
| Include with 1000 parent rows (PostgreSQL) | 7,232 ms | 24.6 ms | 294× |
| Include with 1000 parent rows (SQLite) | 8,378 ms | 23.2 ms | 361× |
| Relation `every` filter (SQLite) | 43,308 ms | 13.6 ms | 3,185× |
| findMany on the foreign-key column (PostgreSQL) | 7.1 ms | 0.33 ms | 21× |

### Correction

In the serializer relation loop, after the `foreignKeys.push`, add an index for each to-many holder column. Recommendation: emit the index on all dialects, for consistency and for a simple differ (on MySQL the explicit index replaces the implicit InnoDB index; this is harmless). Requirements:

1. Skip the index when the column set is already the prefix of a user-declared index or a unique constraint (read the collected `indexes` and `uniqueConstraints` before the push).
2. Resolve the column names with `model["~"].getFieldName(field).sql`, the same pattern as `serializer.ts:237-242`.
3. Use a stable, deterministic index name (follow the junction index naming at `serializer.ts:417-423`).
4. Compound FK: one composite index over the FK columns in FK order.

### Test

1. Push a schema with a to-many relation. Make sure that the index exists in the database on all three dialects (query `pg_indexes`, `sqlite_master`, `information_schema.statistics`).
2. Run an include operation at volume. Make sure that the EXPLAIN plan shows an index scan, not a sequential scan.
3. Push the same schema again. Make sure that the differ reports no change (idempotency).
4. Declare `.index(["authorId"])` on the same column. Make sure that no duplicate index appears.
5. Run the migration suites and the CLI push tests.

### Ordering consequence, found after the phase landed

The index this phase emits is the only index on the column, so MySQL/InnoDB binds the FK constraint to it. `sortOperations` in [`src/migrations/utils.ts`](../../src/migrations/utils.ts) ran every `dropIndex` before every `createIndex` and every `addUniqueConstraint`. The edit the docs recommend above — declare a wider index over the same fields — therefore planned `DROP INDEX` while the constraint had nothing else to bind to: MySQL errno 1553, `HY000`, and the whole transactional push aborted. A compound unique whose first column is the FK failed the same way. Reproduced on the Docker MySQL container; PostgreSQL and SQLite were unaffected.

A `dropIndex` whose replacement is created in the same batch now runs between `createIndex` and `addForeignKey`. Two arrangements keep the early slot: a create that takes the same index *name*, because the name has to be free before it can be taken again; and any table that also drops a column, because the column drop takes that column's indexes with it. Witnesses: [`tests/migrations/superseded-index-ordering.test.ts`](../../tests/migrations/superseded-index-ordering.test.ts) for the order and the emitted DDL, and two live pushes in [`tests/drivers/fk-index-behavior.ts`](../../tests/drivers/fk-index-behavior.ts) wired on all five drivers.

#### Correction from review — the name has to be matched on its own

The same-name exclusion above was first keyed on the pair `(table, index name)`, which is how MySQL scopes an index name — but PostgreSQL and SQLite scope it to the schema. Moving a named index from one model to another therefore looked like an unrelated drop and an unrelated create, the drop was deferred past the create, and the create hit an occupied name: Postgres 42P07, SQLite the same, push aborted. Keying on the name alone can only move a drop earlier, never later, so it cannot reopen the 1553 case — there the created index carries a different name. Witness: `drops first when another table takes the same name`, plus the two live pushes at the bottom of the same file.

### The upgrade path on SQLite, found after the phase landed

SQLite has no `ALTER TABLE ADD FOREIGN KEY`, so every FK change rebuilds the table, and the rebuild read its index list from the snapshot introspected *before* the batch. Since `createIndex` is priority 15 and `addForeignKey` is 16, the rebuild threw away the index the same push had just created. This was not rare: SQLite introspection has no constraint names to read (`PRAGMA foreign_key_list` reports none), so the differ plans an FK drop and add on every push for every `manyToOne`. On any database created before this phase the FK index was created and destroyed in the same transaction, on every push, forever — this phase's deliverable never landed there and `push` never converged. `SQLite3MigrationDriver.getCurrentTable` now replays the batch's preceding `createIndex` / `dropIndex` operations onto the introspected list, so a rebuild carries the indexes the table holds at the moment it runs. Witnesses: [`tests/migrations/sqlite-recreation-indexes.test.ts`](../../tests/migrations/sqlite-recreation-indexes.test.ts) for the emitted DDL, and `runFkIndexUpgradeBehavior` in [`tests/drivers/fk-index-behavior.ts`](../../tests/drivers/fk-index-behavior.ts) wired on PGlite, SQLite3 and LibSQL.

Still open, and pre-existing: the same rebuild reads its *columns*, unique constraints and foreign keys from that stale snapshot too, and SQLite's nameless FK introspection makes the differ plan an FK drop plus add on every push — which appends a duplicate constraint to the table each time. Measured on a schema that emits no FK index at all (the FK columns prefix the primary key), so it is not this phase's doing: three pushes leave `arc_posts` carrying `arc_posts_fk_0`, `arc_posts_fk_1` and `arc_posts_author_id_fkey`, all identical.

### Phase 1 delivery record

**Delivered:** 2026-08-02. Branch `nested-write-boundaries`, four commits from `d9f5c24` (the serializer change) through `e03307c` (the SQLite rebuild fix).

#### What shipped

| Commit | What it does |
| --- | --- |
| `d9f5c24` | The serializer emits one index over the FK columns of each `manyToOne` holder, on all three dialects. Column names resolve through `getFieldName(field).sql`; the index is skipped when a user-declared index or a unique constraint already prefixes the same column set; a compound FK gets one composite index in FK order. |
| `260371d` | `sortOperations` runs a `dropIndex` whose replacement is created in the same batch after `createIndex`, so MySQL/InnoDB never loses the index its FK constraint is bound to (errno 1553). |
| `f80c2c0` | The same-name exclusion is keyed on the index name alone, not on `(table, name)`, because PostgreSQL and SQLite scope index names to the schema (42P07). |
| `e03307c` | `SQLite3MigrationDriver.getCurrentTable` replays the batch's preceding `createIndex`/`dropIndex` onto the introspected list, so an FK-driven table rebuild carries the index the same push created. Without this the deliverable never landed on any pre-existing SQLite database, and `push` never converged. |

#### Measured effect — before and after, same statement, same data

The measurement pushes the schema, seeds 1,000 parents and 100,000 children (100 children per parent), runs `ANALYZE`, then EXPLAINs and times the one statement the client emits for `findMany({ take: 1000, include: { posts: true } })`. It then drops only the FK index, re-`ANALYZE`s, and repeats. Nothing else differs between the two readings.

**PostgreSQL 17 (Docker, port 5434), `pg` driver.**

```
WITH the index (103.4 ms)                    WITHOUT the index (2683.0 ms)
Limit  (cost=272.41..272204.66 rows=1000)    Limit  (cost=1886.78..1886575.54 rows=1000)
  -> Nested Loop Left Join                     -> Nested Loop Left Join
    -> Index Scan using m_plan_users_pkey        -> Index Scan using m_plan_users_pkey
    -> Aggregate                                 -> Aggregate
      -> Bitmap Heap Scan on m_plan_posts t1       -> Seq Scan on m_plan_posts t1
         Recheck Cond: (t0.id = author_id)            Filter: (t0.id = author_id)
        -> Bitmap Index Scan on
           m_plan_posts_author_id_idx
           Index Cond: (author_id = t0.id)
```

26× on the wall clock; the planner's own estimate moves from 1,886,575 to 272,205.

**SQLite (`better-sqlite3`, in-memory).**

```
WITH the index (88.7 ms)                     WITHOUT the index (2592.1 ms)
SCAN t0                                      SCAN t0
CORRELATED SCALAR SUBQUERY 2                 CORRELATED SCALAR SUBQUERY 2
SEARCH t1 USING INDEX                        SCAN t1
  m_plan_posts_author_id_idx (author_id=?)
USE TEMP B-TREE FOR ORDER BY                 USE TEMP B-TREE FOR ORDER BY
```

29× on the wall clock. The child table moves from a full scan to an index search.

These numbers are smaller than the audit table above (294× and 361×) because the audit read 1,000 parents out of a 100,000-row parent table; here the parent side is 1,000 rows, so the sequential scan that the index removes is repeated 1,000 times instead of over a larger table. The shape of the win is the same and the direction of the plan change is identical: sequential scan becomes an index lookup.

#### Witnesses

- [`tests/drivers/fk-index-behavior.ts`](../../tests/drivers/fk-index-behavior.ts) — three suites, wired on the live drivers:
  - `runFkIndexBehavior` reads each database's own catalog (`pg_indexes`, `information_schema.STATISTICS`, `sqlite_master`) and proves the index arrives, that a second push is not a change, that a declared `.index()` on the same column is not duplicated, and that a wider index or a compound unique over the FK columns replaces it in one push. Wired on all five drivers.
  - `runFkIndexUpgradeBehavior` proves a database created before this phase gains the index. Wired on PGlite, SQLite3 and LibSQL.
  - `runFkIndexPlanBehavior` proves the planner uses it: it EXPLAINs the statement the client actually emitted and asserts the index name appears and that neither `Seq Scan on fk_plan_posts` nor `SCAN t1` does. On PostgreSQL it first sets `enable_seqscan = on` and asserts the setting took, so the assertion means the index won on cost. Wired on PGlite and SQLite3.
- [`tests/migrations/superseded-index-ordering.test.ts`](../../tests/migrations/superseded-index-ordering.test.ts) — the operation order and the emitted DDL for the drop-after-create rule, including `drops first when another table takes the same name`.
- [`tests/migrations/sqlite-recreation-indexes.test.ts`](../../tests/migrations/sqlite-recreation-indexes.test.ts) — the DDL a SQLite table rebuild emits when the same batch created an index.

#### Gate

| Leg | Result |
| --- | --- |
| `pnpm test:types` (tsc 5.9.3) | clean |
| full estate, `--minWorkers=1 --maxWorkers=4` | 9197 passed, 0 failed, 2102 skipped (261 files); baseline was 9152 |
| `pnpm test:gates` | 72 passed; the census log is unchanged |
| repo-pinned `npx biome check` per changed file | no new diagnostics; the two `useTopLevelRegex` infos in `src/migrations/utils.ts:87` and `tests/migrations/serializer.test.ts:337,359` are byte-identical to their `47b0847` versions |
| Docker MySQL (3307) | 984 passed, 0 failed; baseline 979. The five `MySQL2 foreign-key index` witnesses executed |
| Docker PostgreSQL (5434) | 1097 passed, 0 failed, 14 skipped; baseline 1092. The five `pg foreign-key index` witnesses executed |

No error message, error attribution, or race protection was removed. The step vocabulary in `OperationFragment.ts` is untouched, and no pinned SQL in `tests/query-engine/sql-generation.test.ts` changed — this phase is a serializer and migration-ordering change and does not reach the query emitters.

---

## Phase 2 — Correct two DDL defects

### Unit 2.1 — The index name for a mapped field

**Problem.** `.index()` on a field with `.map()` writes the TypeScript field name into the DDL. The CREATE INDEX statement points to a column that does not exist.

**Code locations.** The index collection at [`serializer.ts:201-212`](../../src/migrations/serializer.ts) pushes `columns: indexDef.fields` raw. The correct pattern exists twice in the same file: compound uniques resolve through `model["~"].getFieldName(field).sql` at `serializer.ts:190-197`, and FK columns at `serializer.ts:237-242`.

**Correction.** Resolve each index field through `getFieldName(field).sql` before the push.

**Test.** Push a schema with a mapped, indexed field. Make sure that the index exists on the mapped column name. Add the falsification: revert the resolution, and make sure the new test fails.

### Unit 2.2 — The partial index on SQLite

**Problem.** The SQLite driver does not write the WHERE clause of a partial index. The introspection does not read the partial state. The differ compares the declared `where` with the introspected value and sees a difference on each push. The index is re-created forever.

**Code locations.** `generateCreateIndex` in [`src/migrations/drivers/sqlite/index.ts:404-414`](../../src/migrations/drivers/sqlite/index.ts) never reads `index.where`. The introspection at [`introspect.ts:78, 125`](../../src/migrations/drivers/sqlite/introspect.ts) uses `PRAGMA index_list` / `index_info` only (note: `PRAGMA index_list` returns a `partial` column, and `sqlite_master.sql` contains the full CREATE INDEX text with the WHERE clause — both are usable). The differ comparison is at [`differ.ts:72-80`](../../src/migrations/differ.ts). MySQL also ignores `where` silently ([`mysql/index.ts:364-398`](../../src/migrations/drivers/mysql/index.ts)); the loud-refusal precedent is `validateIndexType` at [`base.ts:446-460`](../../src/migrations/drivers/base.ts).

**Correction.** Support the partial index on SQLite: emit the WHERE clause, and read it back from `sqlite_master.sql` in the introspection. On MySQL, refuse a partial index loudly with the `validateIndexType` pattern. Do not drop it silently on any dialect.

**Test.** Declare a partial index on SQLite. Push two times. Make sure that the second push reports no change. Make sure that the index in the database has the WHERE clause. On MySQL, make sure the declaration gets a clear error.

---

## Phase 3 — Fold the delete operation into one statement

### Problem

A delete by primary key sends five round trips: BEGIN, a locate SELECT, a snapshot SELECT, the DELETE, COMMIT. The snapshot SELECT reads data that the `DELETE … RETURNING` statement returns again on RETURNING drivers.

### Context and code locations

- The current sequence: the planning locate at [`DeleteOperation.ts:132-147`](../../src/query-engine-v2/DeleteOperation.ts), the captured-PK write path at `:169-174`, the snapshot SELECT at `:175-190`, the DELETE at `:191-206`.
- The fold pattern exists twice in sibling files: `CreateOperation.foldStep` at [`CreateOperation.ts:344-370`](../../src/query-engine-v2/CreateOperation.ts) and `UpdateOperation.directWrite` with its `canFold` gate at [`UpdateOperation.ts:656-704, 664-672`](../../src/query-engine-v2/UpdateOperation.ts).
- The statement-atomic execution path with JS postconditions: [`OperationExecutor.ts:138-141, 295-340`](../../src/query-engine-v2/OperationExecutor.ts). The `affectedRows(1, notFound)` postcondition produces the byte-identical `NotFoundError`.

### Correction

Emit `DELETE FROM t WHERE <unique where> RETURNING <scalar select>` as one statement when: the driver supports RETURNING, the projection is scalar-only, and no nested relations participate. Keep the multi-statement path for a delete with relation `include`/`select` (the relations of the deleted row must be read before the delete). Mirror the `canFold` gate structure of the update fold.

### Test

1. Count one statement for a scalar delete (extend the statement-count probes).
2. Make sure that the `NotFoundError` for a missing row is byte-identical.
3. Make sure that a delete with `include` keeps the read-then-delete order and correct results.
4. Make sure that MySQL keeps its documented multi-statement path.
5. Update the delete SQL pin in `tests/query-engine/sql-generation.test.ts` (the pin was set at line ~656) deliberately.

---

## Phase 4 — Fold the link operations with IN lists

### Problem

The operations `connect`, `disconnect`, and `set` with N targets send two statements for each target. The measured cost of `connect: [3]` is eight payload statements. The many-to-many code has the same defect, and the same file already contains the consolidated form.

### Context and code locations

- To-many links: `buildToManyLinkParts` at [`RelationLinkPart.ts:363-397`](../../src/query-engine-v2/RelationLinkPart.ts) makes one Part per target. Each Part plans its own `FOR UPDATE` probe (`:108-146`) and emits one single-row UPDATE (`:167-177, 208-218`). The missing-target error is thrown in compile-time JS from the probe rows (`:234-250`). The writes carry `outputs: {}` — no affected-count contract exists in tx mode.
- M2M: the per-target junction INSERT for `connect` at [`RelationJunctionPart.ts:387-405`](../../src/query-engine-v2/RelationJunctionPart.ts); the per-target delete at `:448-470`; the probes at `:318-352`. The consolidated precedents are in the same file: `junctionInsertMany` for `set` at `:436-443` and the IN-list deletes for `deleteMany` at `:473-496`.
- Batch-mode guards are free (in-batch assertions, [`OperationExecutor.ts:477-484`](../../src/query-engine-v2/OperationExecutor.ts)). Keep them per-target in batch mode.
- The `set` orphan guard at [`RelationWritePart.ts:910-947`](../../src/query-engine-v2/RelationWritePart.ts) must stay unchanged.

### Correction

Group the targets by unique key. For each group, send one probe (`SELECT pk, key FROM child WHERE key IN (…) FOR UPDATE`) and one write (`UPDATE … WHERE pk IN (…)` or `junctionInsertMany` / IN-list delete). The probe rows identify each missing target, so the compile-time error text stays identical. Mixed unique keys produce one group per key.

### Test

1. Count two statements for `connect: [N]` with one key shape.
2. Make sure that a missing target produces the same error text as before, and names the correct target.
3. Run the full nested-write conformance suite and the M2M behavior suites, tx and batch.
4. Falsify: remove the grouped probe, and make sure the missing-target witness fails.

---

## Phase 5 — Correct the ordering and the cursor spellings

### Unit 5.1 — Remove the null-placement prefix for NOT NULL columns

**Problem.** Each windowed query (take, cursor, findFirst, ordered includes) adds `(col IS NULL)` sort keys on MySQL and SQLite, also for NOT NULL columns and for the primary-key tie-breakers. A perfect index then cannot supply the order. Measured on SQLite with a correct composite index: 4.59 ms for each page with the prefix, 0.02 ms without it (230×).

**Code locations.** `buildNormalizedOrderBy` forces a placement onto every key at [`cursor-order.ts:62-81, 96-107`](../../src/query-engine/operations/cursor-order.ts); the routing comment is at `:138-142`; the defaults are at `:185-189`. The emulation is emitted by [`standard-sql.ts:129-140`](../../src/adapters/shared/standard-sql.ts), wired at [`mysql-adapter.ts:327-330`](../../src/adapters/databases/mysql/mysql-adapter.ts) and [`sqlite-adapter.ts:337-341`](../../src/adapters/databases/sqlite/sqlite-adapter.ts). PostgreSQL renders native `NULLS FIRST/LAST` at [`postgres-adapter.ts:267-277`](../../src/adapters/databases/postgres/postgres-adapter.ts) and is not affected. Ordered includes route through the same normalization at [`nested-read-window.ts:71-76`](../../src/query-engine/builders/nested-read-window.ts). The nullability of each column is available in the model state (`model["~"].state.scalars[field]` carries `nullable`).

**Correction.** Do not emit the placement key for a NOT NULL column when the requested placement equals the dialect's native placement for that direction. On SQLite 3.30 and later, emit the native `NULLS FIRST/LAST` syntax instead of the expression key.

**Test.** EXPLAIN QUERY PLAN must show an index walk for `orderBy` + `take` on an indexed NOT NULL column on SQLite. The null-ordering behavior suites for nullable columns must stay green on all dialects.

### Unit 5.2 — Use a tuple comparison for the cursor

**Problem.** The cursor predicate is an OR of null-guarded AND chains. No database serves it with one index range scan. Measured: 44 ms for each page at 100,000 rows on SQLite, with or without an index.

**Code locations.** The EXISTS wrapper at [`cursor-condition.ts:23-80`](../../src/query-engine/operations/cursor-condition.ts); the OR-of-ANDs at `:93-112`; the null-guarded equality at `:114-130`; the strict-after branches at `:132-163`. The cursor row locate at `:49-63` is already sargable.

**Correction.** When every sort column is NOT NULL, emit a row-value comparison: `(a, b, id) > (x, y, z)`. PostgreSQL, MySQL 8, and SQLite (3.15+) all support row values, and all three can serve them with a composite index. Keep the current spelling for nullable sort columns.

**Test.** The plan must show an index range scan for the NOT NULL case with a matching composite index. Page contents must be byte-identical to the current behavior in both spellings (parity test over a seeded data set with duplicates in the sort key).

---

## Phase 6 — Reduce the round trips on batch-only drivers (D1, Neon HTTP)

### Problem

The compiled writes ride one atomic batch. The planning reads do not: each planning read is one sequential HTTP round trip ([`OperationExecutor.ts:391-407`](../../src/query-engine-v2/OperationExecutor.ts) calls the linear executor). Also, the fold gates require transaction mode, so a scalar update on these drivers uses two round trips where one is possible.

### Context and code locations

- The batch compiled path: `OperationExecutor.ts:543-582`; the native batch overrides: [`d1/index.ts:233`](../../src/drivers/d1/index.ts), [`neon-http/index.ts:253`](../../src/drivers/neon-http/index.ts).
- The fold gates: `UpdateOperation.canFold` requires tx mode at [`UpdateOperation.ts:664-672`](../../src/query-engine-v2/UpdateOperation.ts); the upsert update-arm gate at [`UpsertOperation.ts:319`](../../src/query-engine-v2/UpsertOperation.ts). The statement-atomic path with JS postconditions runs on any driver ([`OperationExecutor.ts:138-141, 295-309`](../../src/query-engine-v2/OperationExecutor.ts)).
- The planning dependency structure: only technique-#1 refs order the planning steps (a probe refs the locate row, example at `RelationLinkPart.ts:125-146`). Level 0 = steps with no refs; level 1 = steps that ref level-0 outputs.
- The test stand-in: `BatchOnlyPGliteDriver` at `tests/drivers/pglite.test.ts:37`.

### Correction

1. Group the planning reads by dependency level. Send each level through `_executeBatch`. A tree then costs two or three round trips in total.
2. Remove the transaction-mode condition from the fold gates on drivers with RETURNING support. The affected-count check moves to the JS postcondition, which the tx fold already uses.

### Test

1. Count the round trips with the batch-only PGlite driver (a counter subclass): a nested-write update must cost at most three; a scalar update must cost one.
2. Make sure that staleness handling, guards, and error attribution stay identical (run the staleness-injection suite in batch mode).

---

## Phase 7 — Three maintainer decisions

These items need a written disposition. They are choices, not defects.

### Decision 7.1 — The scalar-upsert ON CONFLICT door

ATOM §4 permits a native `INSERT … ON CONFLICT DO UPDATE` for a top-level scalar upsert with an expressible conflict target ([`ATOM.md:243-262`](../../src/query-engine-v2/ATOM.md), the "legal, but observably divergent" note at `:250-254`). The current sequence is at [`UpsertOperation.ts:342-351, 446-492`](../../src/query-engine-v2/UpsertOperation.ts). This changes four or five round trips into one on PostgreSQL and SQLite. MySQL stays on the probe path: its `ON DUPLICATE KEY` fires on any unique collision ([`mysql-adapter.ts:408-414`](../../src/adapters/databases/mysql/mysql-adapter.ts)), which breaks the documented unrelated-collision behavior. The disposition must state the accepted observable divergence against the oracle.

### Decision 7.2 — Multi-row `INSERT … RETURNING` for `createMany` with select

The per-row emission exists for an exact input ordinal ([`create.ts:116-119`](../../src/query-engine/operations/create.ts); [`ManyAndReturnOperation.ts:451-467`](../../src/query-engine-v2/ManyAndReturnOperation.ts)). One multi-row statement replaces N statements. PostgreSQL does not contractually guarantee the RETURNING row order. The choice: accept the implementation guarantee (Prisma does), or match the returned rows by key.

### Decision 7.3 — The `startsWith` spelling

The current spellings can never use an index: `LEFT(col, LENGTH($1)) = $1` on PostgreSQL ([`postgres-adapter.ts:109-110`](../../src/adapters/databases/postgres/postgres-adapter.ts)), `LEFT(BINARY col, OCTET_LENGTH(?))` on MySQL (`mysql-adapter.ts:160-161`), `substr(col,1,length(?)) COLLATE BINARY` on SQLite (`sqlite-adapter.ts:171-172`). Measured price: 54× on PostgreSQL and approximately 300× on SQLite against an indexed `LIKE 'x%'` control. The spellings also blind the PostgreSQL row estimator, which changes plan shapes. A `LIKE` spelling with escaped `%`, `_`, and escape characters is portable and index-friendly, and keeps the literal-wildcard semantics that [`prisma-parity-behavior.ts:227`](../../tests/drivers/prisma-parity-behavior.ts) pins. The choice: keep the current spelling, or move to the escaped LIKE spelling (recommendation: move; the semantics are identical and the price is now known).

---

## Phase 8 — PostgreSQL CTE folds (large)

### Problem

Each mutation with an include sends a separate terminal SELECT. A nested-create tree sends one INSERT for each node plus one re-read.

### Context and code locations

- The terminal reads: [`UpdateOperation.ts:951`](../../src/query-engine-v2/UpdateOperation.ts), [`CreateOperation.ts:399-401`](../../src/query-engine-v2/CreateOperation.ts).
- The capability flag `supportsCteWithMutations` is declared at [`adapter-capabilities.ts:6`](../../src/adapters/adapter-capabilities.ts), true on PostgreSQL (`postgres-adapter.ts:393`) and true on SQLite (`sqlite-adapter.ts:502`). **The SQLite value is false in fact:** SQLite CTEs cannot contain DML. Correct the flag in this phase (or in Phase 10 if this phase runs later).
- The guard-free fresh-parent ladder that makes the fold legal: [`ATOM.md:886-899`](../../src/query-engine-v2/ATOM.md) (fresh-parent elision) and the Pin Rule class 2 note at [`OperationFragment.ts:128-134`](../../src/query-engine-v2/OperationFragment.ts).
- The select builder needs the RETURNING columns as its alias root (study [`select-builder.ts:158-185`](../../src/query-engine/builders/select-builder.ts)).

### Correction (PostgreSQL only)

1. Fold the terminal read: `WITH u AS (UPDATE … RETURNING <scalars>) SELECT u.*, <correlated relation subqueries> FROM u`. Legal because the relation subqueries read tables the statement does not change.
2. Fold a guard-free nested-create tree: `WITH p AS (INSERT … RETURNING *), c AS (INSERT INTO child … SELECT p.id, … FROM p) SELECT <scalars> FROM p`. Constraints: a scalar-only root projection (sibling CTE effects are invisible in the same statement), no adopt-family members in the tree (probes need client-side rows).

The fold is an emitter change. It produces one write step. It does not grow the frozen vocabulary.

### Test

Byte-identical results against the unfolded path (dual-run comparison). Failure attribution through constraint names. Statement-atomic postconditions. The census and the gates stay unchanged.

---

## Phase 9 — Transport: PostgreSQL pipelining (orthogonal)

### Problem

The transaction path executes statements one at a time in a sequential loop ([`driver-transaction-base.ts:478-529, 644-659`](../../src/drivers/driver-transaction-base.ts)). The PostgreSQL extended-protocol pipeline is unused. Pipelining reduces every transaction-mode round-trip count in this plan without a change to any fragment.

### Context and code locations

- The postgres.js driver ([`src/drivers/postgres/index.ts`](../../src/drivers/postgres/index.ts)): postgres.js pipelines statements inside `sql.begin` automatically when statements are issued without intermediate awaits. This is the realistic first target.
- The pg driver ([`src/drivers/pg/index.ts`](../../src/drivers/pg/index.ts)): node-postgres has no true pipeline mode. Document this limit; do not force it.
- The dependency structure decides what can pipeline: steps without refs to earlier step outputs can be issued together; a step that refs an earlier output must wait.

### Correction

Implement pipelining in the postgres.js driver for ref-free statement runs inside one transaction. Measure first, then adopt the measured winner. Statement order and error attribution must stay identical.

### Test

Count the wire round trips for a multi-statement transaction before and after. Run the full transaction-lifecycle and savepoint suites. Make sure that a mid-pipeline failure produces the same error, the same rollback, and the same AggregateError contract as before.

---

## Phase 10 — Small corrections and documentation

1. **The false capability flag.** Set `supportsCteWithMutations` to false for SQLite ([`sqlite-adapter.ts:502`](../../src/adapters/databases/sqlite/sqlite-adapter.ts)), or remove the flag if no phase uses it. Nothing reads it today, so nothing catches the false value.
2. **The MySQL BINARY wrap.** `equals`, `in`, and `notIn` on string and enum columns wrap the column: `BINARY col = ?` ([`where-builder.ts:415-427`](../../src/query-engine/builders/where-builder.ts) with [`mysql-adapter.ts:189`](../../src/adapters/databases/mysql/mysql-adapter.ts)). The wrap prevents index use. Tables that viborm creates use the collation `utf8mb4_0900_bin` ([`mysql/index.ts:298`](../../src/migrations/drivers/mysql/index.ts)), which makes the wrap redundant there. The unique-locate path already bypasses the wrap ([`where-unique-builder.ts:224-236`](../../src/query-engine/builders/where-unique-builder.ts)). Remove the wrap for viborm-created tables, or document the cost and the manual collation requirement.
3. **Documentation: composite indexes for ordered includes.** The lateral include shape needs `(foreignKey, orderColumn)` for an ordered, limited include. Add this to [`docs/content/docs/schema/model.mdx`](../../docs/content/docs/schema/model.mdx) near the `.index()` section (lines 46-64), and add an FK-index note to [`many-to-one.mdx`](../../docs/content/docs/schema/relations/many-to-one.mdx) (until Phase 1 ships).
4. **Documentation: PGlite runs with `enable_seqscan=off` by default** (PostgreSQL 17 WASM). Users who benchmark on PGlite must know this. Add a note to the PGlite driver docs page.
5. **Schema API gaps, record or implement.** Expression indexes are not declarable (`IndexDefinition.fields` is a plain name array, [`model.ts:75-81`](../../src/schema/model/model.ts)); this closes the only index escape for the insensitive-mode predicates. ANN vector indexes (ivfflat, hnsw) are not declarable while vector `orderBy` ships ([`vector-distance-builder.ts:97`](../../src/query-engine/builders/vector-distance-builder.ts)) — each vector similarity query is a full scan.
6. **The index-type union.** The MySQL driver validates `fulltext` and `spatial` ([`mysql/index.ts:62`](../../src/migrations/drivers/mysql/index.ts)) but the type union `"btree" | "hash" | "gin" | "gist"` ([`model.ts:66`](../../src/schema/model/model.ts)) cannot spell them. Align the union or remove the driver validation.

---

## Order of the phases

```
Phase 1 (FK index)  →  the highest value; run first
Phase 2 (DDL defects)  ∥  Phase 3 (delete fold)  ∥  Phase 5 (ordering/cursor)   — independent
Phase 4 (IN-list folds)  — after Phase 3 (shared reviewer context)
Phase 6 (batch drivers)  — independent
Phase 7 (decisions)  — maintainer input; blocks nothing else, but Decision 7.3 gates a where-builder change
Phase 8, Phase 9  — largest effort; run last, but they are part of the plan, not optional
Phase 10  — small items; attach to any phase or run together
```

## What this plan does not change

- The Pin Rule. A subquery locate stays forbidden where `compile(known)` consumes the located row.
- The MySQL non-returning mechanics. The capability forces them.
- The probe-first upsert semantics, unless Decision 7.1 changes them.
- The read path. It is one statement at every include depth and stays unchanged.
- The frozen step vocabulary in `OperationFragment.ts`.
