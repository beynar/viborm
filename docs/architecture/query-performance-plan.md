# Query Performance Plan

**Date:** 2026-07-28
**Language:** This document uses Simplified Technical English (ASD-STE100 style).
**Status:** Phases 1 and 3 delivered (see their delivery records). Phases 2 and 4-10 not started.

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

### Phase 2 delivery record

**Delivered:** 2026-08-02. Branch `nested-write-boundaries`, on top of the Phase 1 record.

#### What shipped

| Change | What it does |
| --- | --- |
| `serializer.ts` index collection | Resolves each declared index field through `getFieldName(field).sql` before the push, so `.index()` on a `.map()`ed field names the column and not the TypeScript field. One resolution now serves both readers — the CREATE INDEX and the Phase 1 foreign-key index's coverage decision, which already resolved the names separately. |
| `sqlite/index.ts` `generateCreateIndex` | Emits ` WHERE <predicate>` for a partial index. |
| `sqlite/introspect.ts` | Reads the predicate back out of `sqlite_master.sql`, so the differ can see the declared and the stored index agree. |
| `mysql/index.ts` `generateCreateIndex` | Refuses a partial index by name, quoting the predicate, instead of building a silently different index. MySQL has no partial index. |
| `differ.ts` `normalizeIndexWhere` | `type`'s and `unique`'s third twin: the one place the two snapshots' predicate spellings are reconciled. |
| `sqlite/introspect.ts` `int()` | Normalizes the pragmas' integer columns. See the LibSQL finding below. |

#### Measured: what each catalog does with a predicate

The plan's ordering note asked whether `indexesEqual` has to normalize a re-spelled predicate. Both catalogs were measured directly.

**SQLite (better-sqlite3 3.51) stores the statement verbatim.** `CREATE INDEX i1 ON t ("title") WHERE  published = 1 ` comes back from `sqlite_master.sql` byte-identical — inner spacing, padding and all; only the statement terminator is dropped. So the round trip needs no spelling normalization, and the read-back is exact. The only gap is padding: the emitter writes ` WHERE ${where}`, and reading past `WHERE\s+` consumes the separating run, so a predicate declared with leading whitespace returns without it. That is what `normalizeIndexWhere` covers, and nothing else.

**PostgreSQL re-spells the predicate, and this is still open.** `pg_get_expr(indpred, indrelid)` deparses: a declared `active = true` reads back as `(active = true)`, and `a = 1 AND b = 2` would read back as `((a = 1) AND (b = 2))`. Since `postgres/introspect.ts:302` already reads `filter_condition` into `where`, **a partial index on PostgreSQL is dropped and re-created on every push, today, and this phase does not fix it.** It is a different defect from the one this unit was scoped to: SQLite's was a silent drop, PostgreSQL's is a deparse mismatch, and no client-side text normalization closes it without failing open. Stripping all whitespace and parentheses would make `a AND (b OR c)` and `(a AND b) OR c` compare equal — a real predicate change that the differ would then miss — which this codebase's fail-closed doctrine forbids. The honest fixes are to canonicalize the declared predicate through the database (a round trip the differ has no access to today) or to compare `indpred` structurally. **Disposition: record, do not paper over.** Phase 7 is where a choice of this shape belongs.

#### Found while testing: LibSQL read every pragma integer wrong

The first test in this repo to push a **two-column** index on LibSQL crashed the introspection outright:

```
TypeError: Cannot convert a BigInt value to a number
  at LibSQLMigrationDriver.introspect (sqlite/introspect.ts, a.seqno - b.seqno)
```

The LibSQL driver runs with `intMode: "bigint"` (`src/drivers/libsql/index.ts:133`), so every pragma integer reaches the shared SQLite introspection as BigInt, while `sqlite/types.ts` declared them `number`. Raw, each read was wrong in its own way: `a.seqno - b.seqno` returns a BigInt that `Array#sort` refuses (the crash — invisible until now because every index the tests pushed had one column, and a one-element sort never calls its comparator); `idx.unique === 1` is false for `1n`, so a UNIQUE index introspected as non-unique; and `col.notnull === 0` is false for `0n`, so every NOT NULL column introspected as nullable. This is pre-existing and unrelated to the two units, but a new test cannot be shipped on top of a crash. One normalization at the read boundary — `int()` — fixes all three, because all three have one cause. The full LibSQL suite is green after it (1078 passed), so nothing depended on the old readings.

#### Not changed, deliberately

The **default index name** still spells the TypeScript field names (`${table}_${fields.join("_")}_idx`). The defect was that CREATE INDEX named a non-existent *column*; a name is arbitrary, and renaming it would plan a drop and a create on every existing database that has a mapped indexed field, for no gain. An explicit `.name()` is unaffected either way.

#### Witnesses

- [`tests/drivers/index-ddl-behavior.ts`](../../tests/drivers/index-ddl-behavior.ts) — three live suites:
  - `runMappedIndexBehavior` pushes a compound index over two mapped columns (one of them the FK column) and reads the column list back from each database's own catalog. Wired on PGlite, pg, SQLite3, LibSQL and MySQL2.
  - `runPartialIndexBehavior` proves the predicate reaches the database (`sqlite_master.sql` and `PRAGMA index_list`'s `partial`) and that a second push plans no index change — over a table holding a foreign key, so SQLite rebuilds it and re-emits the index from the introspected list. Wired on SQLite3 and LibSQL.
  - `runPartialIndexRefusalBehavior` proves MySQL refuses the declaration, naming the index and quoting the predicate. Wired on MySQL2.
- [`tests/migrations/serializer.test.ts`](../../tests/migrations/serializer.test.ts) — `declared index columns resolve through .map()`: single-field, compound in order, unmapped unchanged, and unique.
- [`tests/migrations/ddl-drivers.test.ts`](../../tests/migrations/ddl-drivers.test.ts) — the SQLite `CREATE INDEX … WHERE` and `CREATE UNIQUE INDEX … WHERE` spellings, and the MySQL refusal message.
- [`tests/migrations/differ.test.ts`](../../tests/migrations/differ.test.ts) — the padding is ignored; a changed predicate and a predicate that disappears are both still real changes.

#### Falsification

Each fix was reverted on its own and the witness that failed was recorded.

| Reverted | What failed |
| --- | --- |
| the serializer resolution (`columns: indexDef.fields`) | 4 serializer unit tests + 3 live SQLite3 tests |
| the SQLite ` WHERE` emission | 2 SQLite DDL unit tests + 2 live SQLite3 tests |
| the introspection read-back only | the live convergence test only — the emission test still passed, so each half has its own witness |
| `normalizeIndexWhere` | the differ padding test only |
| the MySQL refusal | the MySQL DDL unit test only |

#### Gate

| Leg | Result |
| --- | --- |
| `npx tsc --noEmit` (5.9.3) | clean |
| `tests/migrations` | 343 passed |
| `tests/drivers/sqlite3` + `tests/drivers/pglite` | 1840 passed |
| `tests/drivers/libsql` | 1078 passed |
| `tests/cli` | 144 passed |
| `pnpm test:gates` | 72 passed |
| repo-pinned `npx biome check` per changed file | no new diagnostics; the 7 remaining are byte-identical to their `c45e2b5` versions |

Docker MySQL (3307) and PostgreSQL (5434) are left to the gate agent; the MySQL refusal and the mapped-index witnesses are wired on both.

No error message, error attribution, or race protection was removed. The step vocabulary in `OperationFragment.ts` is untouched, and no pinned SQL in `tests/query-engine/sql-generation.test.ts` changed — this phase is a serializer, DDL-emitter and introspection change and does not reach the query emitters.

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

### Phase 3 delivery record

**Delivered:** 2026-08-02. Branch `nested-write-boundaries`.

#### What shipped

One gate and one step in [`src/query-engine-v2/DeleteOperation.ts`](../../src/query-engine-v2/DeleteOperation.ts), mirroring `UpdateOperation`'s `canFold` and `CreateOperation.foldStep`. A delete folds when all four hold: transaction mode, a RETURNING driver, a scalar-only projection, and no `include`. The folded operation has EMPTY planning and one write step, so `OperationExecutor.statementAtomicPlan` runs it directly on the base driver — no transaction envelope — with `affectedRows(1, notFound)` enforced in JS afterwards.

The DELETE already carried a RETURNING clause whose rows were discarded; the snapshot SELECT re-read exactly what the write was handing back. The fold is that clause put to use.

#### Measured effect — PGlite, same payload, statements recorded at the driver seam

| Payload | Before | After |
| --- | --- | --- |
| `delete({ where: { id } })` | 3 payload statements (locate `FOR UPDATE`, snapshot `FOR UPDATE`, DELETE) inside BEGIN/COMMIT — 5 round trips | **1** statement, no envelope — 1 round trip |
| `delete({ where: { email }, select })` | 3 (locate by `email`, snapshot by captured PK, DELETE by captured PK) | **1** (`DELETE … WHERE email … RETURNING label`) |
| `delete({ where, include })` | 3, read-then-delete | 3, unchanged |
| batch substrate | 4 (locate, presence guard, read, DELETE) | 4, unchanged |

#### What the fold does NOT change

- **The race protection.** The multi-statement path located `FOR UPDATE` by the (possibly alternate) unique and then wrote `WHERE id`, because an alternate unique could be rewritten between the two statements. The fold has no such window — one statement matches, locks and removes one row — so the protection is preserved by construction. This is the identical argument the update fold already makes for `UPDATE … WHERE selector RETURNING`.
- **The error.** `failureError` builds the public error from the execution context, not from the step that failed, so moving the assertion from a locate read's `exactlyOneRow` to a write's `affectedRows` cannot change what the caller sees. Witnessed equal across all three paths.
- **The extended-whereUnique filter half.** The filter rides into the folded DELETE's WHERE. It is only wrapped in a derived table on dialects that reject reading the mutated table (MySQL 1093) — and MySQL never folds — so PostgreSQL and SQLite are unaffected. The whole `extended-where-unique` suite is green on both substrates, self-relation filters included.
- **The batch substrate**, **MySQL**, and the frozen `OperationFragment.ts` vocabulary.

#### Witnesses

[`tests/query-engine-v2/delete-fold.test.ts`](../../tests/query-engine-v2/delete-fold.test.ts) — nine, on a recording PGlite driver plus three plan-shape assertions that need no database. Every conjunct of the gate was falsified individually: removing the gate fails the two count witnesses and the plan shape; removing the `include` exclusion fails the include witness; removing the transaction-mode conjunct fails the batch witness; removing the RETURNING conjunct fails the non-returning plan witness.

The delete pin in `tests/query-engine/sql-generation.test.ts` was updated deliberately, with the rationale in place: the old test asserted that `build()` REJECTS a root delete, which pinned the very round-trip count this phase removes. It is replaced by two tests — one folded statement on a RETURNING adapter, and the surviving refusal on MySQL.

#### Gate

| Leg | Result |
| --- | --- |
| `pnpm test:types` (tsc 5.9.3) | clean |
| `tests/query-engine-v2/` | 1026 passed, 0 failed (56 files) |
| `tests/query-engine/` | 1183 passed, 0 failed (48 files) |
| `tests/drivers/sqlite3.test.ts` | 1117 passed, 0 failed |
| `tests/drivers/libsql.test.ts` + `pglite.test.ts` | 1788 passed, 0 failed |
| `pnpm test:gates` | 72 passed |
| repo-pinned `npx biome check` per changed file | clean |

#### Found, not fixed — a pre-existing defect this phase's witnesses surfaced

`delete({ where, select: { …, someRelation: {…} } })` — a relation nested in `select` rather than in `include` — fails on PostgreSQL with `0A000`. The shape-capturing read gates its lock on `forUpdate: txMode && !this.parsedInclude`, and that proxy misses a relation reached through `select`, so `FOR UPDATE` is emitted over a lateral join. Reproduced on the PR tip with this phase reverted; SQLite is unaffected (it omits `FOR UPDATE` entirely). Nothing in the estate covers the shape. It is left alone here on purpose: removing that lock is a locking change on a path this phase deliberately keeps, and it wants its own review and its own witnesses. Filed separately.

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

#### Unit 5.1 delivery record

**Delivered:** 2026-08-02, branch `nested-write-boundaries`.

**The rule that shipped, and why it is one rule.** A NOT NULL column has no null placement to state: `NULLS FIRST`, `NULLS LAST` and the bare direction all name the same order, because no row can sort into either position. `buildNormalizedOrderBy` now emits the bare direction for such a column and keeps the placement only where it is observable. The plan text above reads as an *and* — NOT NULL **and** the requested placement matches the dialect's native one — but that conjunction cannot hold: the engine's default placement for `asc` is `last` (the PostgreSQL default), SQLite and MySQL sort nulls first on `asc`, so `orderBy: { col: "asc" }` on a NOT NULL column never matches native on those two dialects and the measured case would have been skipped. Nullability alone decides it.

This matters more widely than "a user asked for a placement". `normalizeCursorOrder` appends the identity tie-breakers to every windowed read, and those are NOT NULL by construction, so before this change the placement was forced onto the primary key of every `take`, `cursor`, `findFirst` and ordered include in the engine.

**A second, separable defect in the same unit.** For a *nullable* column the placement is real, but on SQLite it was emulated as a leading `(col IS NULL)` sort key — and no index can supply an order whose first key is an expression. SQLite has parsed `NULLS FIRST/LAST` natively since 3.30 (2019), below this adapter's documented 3.35+ floor (`docs/content/docs/internals/adapters.mdx:87`); the shipped drivers measured 3.51.2 (better-sqlite3) and 3.45.1 (libsql). `SQLiteAdapter.orderBy` now emits the native syntax. MySQL keeps the emulation — it has no native spelling at any version.

**Measured — 100,000 rows, an index over the sort columns, `ORDER BY … LIMIT 20`.**

| Case | Before | After | Plan before → after |
| --- | --- | --- | --- |
| SQLite, NOT NULL column | 3.077 ms | 0.005 ms (615×) | `SCAN t` + `USE TEMP B-TREE FOR ORDER BY` → `SCAN t USING INDEX t_k_id` |
| SQLite, nullable column | 3.356 ms | 0.005 ms (670×) | same → `SCAN t USING INDEX t_n_id` |
| PostgreSQL, NOT NULL column, explicit non-default placement | 12.097 ms | 0.194 ms (62×) | `Seq Scan` + `Sort` → `Index Only Scan` |

PostgreSQL's *default* placements already matched its btree order, so the common PostgreSQL path was never the slow one; the win there is confined to an explicitly requested non-default placement. Emitting `NULLS LAST` on a NOT NULL column is not free even on SQLite: it plans `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`, which is why the bare direction — not the native syntax — is what a NOT NULL column gets.

**Witnesses.** [`tests/drivers/ordering-plan-behavior.ts`](../../tests/drivers/ordering-plan-behavior.ts), wired on SQLite3 and PGlite. It EXPLAINs the statement the client actually emitted, with that statement's own parameters, and asserts both halves: the emitted SQL carries no placement for the NOT NULL column, and the plan walks the declared index with no sort. On PostgreSQL it first sets `enable_seqscan = on` and asserts the setting took, so the index in the plan means the index won on cost. A second test holds the nullable column to its placement and to correct null-first / null-last row order.

**Falsification.** Removing the NOT NULL branch from `buildNormalizedOrderBy` fails the witness twice over, and each half was checked alone: the SQL assertion reports `ORDER BY "t0"."bucket" ASC NULLS LAST, "t0"."id" ASC NULLS LAST`, and with the SQL assertions disabled the EXPLAIN assertion still fails on `USE TEMP B-TREE`. The plan assertion had to be widened from `USE TEMP B-TREE FOR ORDER BY` to `USE TEMP B-TREE` to catch it — SQLite reports the narrower `FOR LAST TERM OF ORDER BY` for this shape, and the first spelling passed vacuously.

**Pinned SQL.** `tests/query-engine/cursor-pagination-sql.test.ts` changed deliberately: `expectedOrder` moves SQLite from the emulated to the native branch, and a new `expectedNotNullOrder` states the bare-direction expectation for NOT NULL columns. Five assertions moved; nothing else in the file did.

**Gate.** `tsc` clean; repo-pinned `npx biome check` clean on every changed file; sqlite3 1119, libsql 1073, PGlite + SQL pins 925 — 0 failures. No error message, attribution, or race protection was touched, and `OperationFragment.ts` is untouched.

### Unit 5.2 — Use a tuple comparison for the cursor

**Problem.** The cursor predicate is an OR of null-guarded AND chains. No database serves it with one index range scan. Measured: 44 ms for each page at 100,000 rows on SQLite, with or without an index.

**Code locations.** The EXISTS wrapper at [`cursor-condition.ts:23-80`](../../src/query-engine/operations/cursor-condition.ts); the OR-of-ANDs at `:93-112`; the null-guarded equality at `:114-130`; the strict-after branches at `:132-163`. The cursor row locate at `:49-63` is already sargable.

**Correction.** When every sort column is NOT NULL, emit a row-value comparison: `(a, b, id) > (x, y, z)`. PostgreSQL, MySQL 8, and SQLite (3.15+) all support row values, and all three can serve them with a composite index. Keep the current spelling for nullable sort columns.

**Test.** The plan must show an index range scan for the NOT NULL case with a matching composite index. Page contents must be byte-identical to the current behavior in both spellings (parity test over a seeded data set with duplicates in the sort key).

#### Unit 5.2 delivery record

**Delivered:** 2026-08-02, branch `nested-write-boundaries`.

**The diagnosis in the plan text above is wrong, and the measurement says so.** The unit proposed keeping the EXISTS wrapper at `cursor-condition.ts:23-80` and replacing only the OR-of-ANDs at `:93-163`. Measured at 100,000 rows with a composite index, paging from row 99,000, that change is worth 1.12× on SQLite (14.695 ms → 13.105 ms) and 1.28× on PostgreSQL (18.608 ms → 14.573 ms), and it changes **no plan shape at all** — both spellings still report `SCAN t USING INDEX` on SQLite and a `Nested Loop Semi Join` with a join filter over a full `Index Scan` on PostgreSQL. The stated acceptance test could not have passed.

The blocker is the wrapper, not the predicate. The cursor row arrives as a correlated subquery in the `FROM` of an `EXISTS`, and a co-routine's column cannot be an index seek bound on any of the three engines. Comparing against a **row-valued scalar subquery** instead removes the wrapper and the planner takes the seek:

| | Before | After | Plan after |
| --- | --- | --- | --- |
| PostgreSQL | 18.608 ms | 0.467 ms (40×) | `Index Cond: (ROW(k, id) >= ROW((InitPlan 1).col1, (InitPlan 1).col2))` |
| SQLite | 14.695 ms | 0.004 ms (3,670×) | `SEARCH t USING INDEX t_k_id (k>?)` |

This costs no extra round trip: the cursor row is still located inside the same statement, by its own unique key.

**Two gates, both necessary, both falsified.**

- *Every sort column NOT NULL.* A row value cannot order around SQL NULL — the comparison would be NULL rather than place the nulls.
- *Every sort column the same direction.* `(a, b) > (x, y)` means `a > x OR (a = x AND b > y)`; a mixed order needs `b <` on the second key, which no row value spells.

The second gate binds more often than it looks. `normalizeCursorOrder` appends the identity tie-breaker **ascending** whatever the requested direction, so `orderBy: { col: "desc" }` normalizes to `col DESC, id ASC` — mixed, and it keeps the general predicate. The row-value spelling therefore covers ascending pages, and descending pages reached through a negative `take` (which reverses every key, so an all-ascending order becomes all-descending and stays uniform). Widening it further would mean changing the tie-breaker's direction, which changes the total order and the page contents — a semantics change, not a spelling one, and out of scope here.

**Portability, measured rather than assumed.** All three dialects were probed directly for the four shapes the gate can emit — `>=` and `<=` against a row subquery, the single-column degenerate form, and a cursor row that does not exist. PostgreSQL 17 (PGlite) and SQLite 3.51.2 (better-sqlite3) pass all four; MySQL 8.4.10 (the Docker container on 3307, probed read-only outside the test estate) passes all four and plans `type: index, key: k_id, Using where; Using index`. In particular the empty-window semantics survive on every dialect: a cursor matching no row makes the subquery NULL, the comparison NULL, and the window empty — which is what the EXISTS wrapper did and what Prisma specifies.

**Witnesses** — [`tests/drivers/ordering-plan-behavior.ts`](../../tests/drivers/ordering-plan-behavior.ts), wired on SQLite3 and PGlite:

- *seeks into the index* — EXPLAINs the emitted statement and asserts `Index Cond` / `SEARCH`, and that no `Seq Scan` / `SCAN order_plan_rows` remains.
- *both cursor spellings page identically over duplicate sort keys* — the parity oracle. `bucket` (NOT NULL) and `mirror` (nullable, but holding the same values on every row and never null) carry identical data, so the two columns differ only in what the schema says. Paging both, five rows at a time through seven-row groups so no page edge aligns with a group boundary, must give the same 30 rows in the same order; the test also asserts that the two runs really did take the two different code paths, and that the result is the contiguous head of the total order rather than two matching mistakes.
- *a descending cursor pages in the order an independent sort gives* — a JS sort of the same seed data as the oracle, so the direction gate is answerable in rows.
- *a cursor over a column holding nulls pages through them* — every cursor row in this run has a null sort value, so the nullability gate is answerable in rows too.
- *a cursor that matches no row leaves an empty window*.

**Falsification.** Each of the three code paths was broken in turn and the witnesses caught all three: forcing the general spelling everywhere fails the seek witness and the parity path-divergence check on both dialects; removing the direction half of the gate returns wrong rows from the descending oracle on both dialects; removing the nullability half returns wrong rows from the null-paging oracle and breaks the parity check.

**Pinned SQL.** `tests/query-engine/cursor-pagination-sql.test.ts` gains five deliberate pins across all three dialects for the new spelling and its three fallbacks. Two further pins moved for **Unit 5.1**, not this unit, and are recorded here because they were found late — running only the two SQL files rather than the whole `tests/query-engine` directory left them red at 5.1's commit: `tests/query-engine/operation-equivalence-oracles.test.ts` (frozen read SQL on all three dialects, `views`/`id` both NOT NULL) and `tests/query-engine-v2/located-parent-ref.test.ts` (a guard's `id` tie-breaker). Both are the same NOT NULL placement removal, and both now carry a comment saying so.

**Gate.** `tsc` clean; repo-pinned `npx biome check` clean on every changed file; `pnpm test:gates` 72/72, census unchanged. Suites run in this worktree, 0 failures throughout: `tests/query-engine` 1201, `tests/query-engine-v2` + `tests/adapters` 1061, `tests/drivers` 3349 (2102 skipped), `tests/client` and the schema/model/relations/scalars/errors/cache/instrumentation set 2569, `tests/migrations` + `tests/cli` + `tests/validation` 1492. The Docker MySQL and PostgreSQL legs belong to the gate agent and were not run here; the MySQL row-value syntax and plan were probed directly instead, as recorded above.

No error message, attribution, or race protection was touched, and `OperationFragment.ts` is untouched.

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

### Decision 7.4 — The PostgreSQL partial-index predicate (raised by Phase 2)

Phase 2 fixed the partial index on SQLite, where the catalog stores the statement verbatim. PostgreSQL does not: `pg_get_expr(indpred, indrelid)` deparses the predicate, so a declared `active = true` reads back as `(active = true)` and never compares equal to what the serializer holds ([`postgres/introspect.ts:302`](../../src/migrations/drivers/postgres/introspect.ts) into `indexesEqual`, [`differ.ts`](../../src/migrations/differ.ts)). Measured on PGlite (PostgreSQL 17). **Consequence: every push drops and re-creates every partial index on PostgreSQL.** No client-side text normalization closes this while staying fail-closed — flattening whitespace and parentheses makes `a AND (b OR c)` equal `(a AND b) OR c`, so a real predicate change would stop being seen. The choice: canonicalize the declared predicate through the database before comparing (the differ has no connection today, so this changes the differ's shape), compare `indpred` structurally, or accept the churn and document it. The disposition must state which.

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
