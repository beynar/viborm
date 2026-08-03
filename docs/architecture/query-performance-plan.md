# Query Performance Plan

**Date:** 2026-07-28
**Language:** This document uses Simplified Technical English (ASD-STE100 style).
**Status:** Phases 1, 2, 3, 4 and 5 delivered (see their delivery records, and the wave gate that follows Phase 5). Phase 4 folded the probe and the write for `connect`/`disconnect`, the write only for `set` and M2M `connect`, and recorded why the other probes stay per target. Phase 6 delivered its measurement and pinned it as a baseline; both of its units hit a blocker that is a decision rather than a defect, and neither shipped. Phase 7's decisions 7.1, 7.2 and 7.3 are delivered, each with the disposition the maintainer asked for written into its own section, and all three are certified together by the Phase 7 wave gate that follows Decision 7.4; **7.4 is the one Phase 7 decision still open**, and it is the debt Phase 2 raised. Phases 8, 9 and 10 not started.

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

```text
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

```text
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

```text
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

#### Correction from review — a partial index is not coverage

Making the predicate real made two of the serializer's claims false. `serializer.ts` pushed **every** declared index into `declaredIndexColumns`, and two decisions read that list as total coverage: Phase 1's foreign-key index was skipped when a declared index covered the columns, and a 1:1 relation accepted a declared UNIQUE index as its uniqueness. A partial index holds only the rows its predicate keeps, so it answers neither question — but until the emitters wrote the `WHERE`, the index the database built really was total and both claims held by accident.

Measured live on SQLite3 before the fix. A `manyToOne` on `authorId` plus `.index(["authorId"], { where: … })` left one index on the column, and it was partial: every include, relation filter and nested-write locate reading an excluded child was back to the sequential scan Phase 1 exists to remove. A `oneToOne` on `userId` plus `.index(["userId"], { unique: true, where: … })` serialized `uniqueConstraints: []`, and two profiles naming one user were both accepted — the exact degradation to N:1 that the branch's own comment forbids.

One predicate, `isTotalIndex`, now answers both readers: an index carrying a `where` neither joins `declaredIndexColumns` nor satisfies the 1:1 scan. Fail-open in both places, and silent in both.

The automatic index needed a name of its own as a consequence. A partial index over exactly the foreign-key columns auto-names itself `${table}_${fields}_idx` — the name Phase 1's index generates — and a database keeps one index per name, so the two would collide and the push would abort. The automatic index now falls back on the constraint's name, `${table}_${columns}_fkey_idx`, and only when the preferred one is taken. Nothing that has the index today is renamed: the fallback can only be reached by a schema that has no foreign-key index at all, which is precisely the schema this correction repairs. This keeps the naming decision recorded two sections above — a rename plans a drop and a create for no gain.

PostgreSQL was silently wrong the same way before this wave (its emitter already carried `where` at `c45e2b5`), and MySQL cannot hold the declaration at all. Decision 7.4 is now the only open partial-index debt.

Witnesses: `runPartialIndexCoverageBehavior` in [`tests/drivers/index-ddl-behavior.ts`](../../tests/drivers/index-ddl-behavior.ts) — the whole-column index exists and is not partial, a second push does not touch it, and two rows the predicate excludes cannot share the 1:1 key — wired on PGlite, SQLite3 and LibSQL, every dialect that builds a predicate. Four serializer unit tests carry the same claims plus the accepted case (a *total* declared UNIQUE index still is the 1:1 uniqueness) and the no-collision case (a mapped field spells the two names apart, so the preferred name stands).

| Reverted | What failed |
| --- | --- |
| the `isTotalIndex` gate on `declaredIndexColumns` | 2 serializer unit tests + 2 live SQLite3 tests |

#### Second correction from review (PR #20) — the fallback name, and the foreign keys the rebuild carried

Two defects in the machinery the two sections above built, both found by reviewing this
PR, both reproduced live before they were touched.

**(1) The fallback name covered half its invariant.** The correction above gives the
automatic index a second name when the preferred one is taken — but both names are
ordinary strings a schema may declare, and `.index([...], { name: "<table>_<cols>_fkey_idx" })`
is legal. With both spent, the index was pushed anyway and the snapshot carried two
entries under one name; the differ emitted two `CREATE INDEX` for it and the second failed
the whole push (`index post_authorId_fkey_idx already exists`, better-sqlite3). The index
is a read optimization, not a correctness requirement, so it now yields: when the schema
holds both candidate names, no foreign-key index is emitted. Witness:
*"emits no FK index when the schema holds both candidate names"* in
[`tests/migrations/serializer.test.ts`](../../tests/migrations/serializer.test.ts).

**(2) A SQLite table rebuild resurrected the foreign key the same batch had dropped.**
`getCurrentTable` replayed the batch's preceding `createIndex`/`dropIndex` so a recreation
would not destroy the indexes the batch had just made — and did not replay the two
operations that move a FOREIGN KEY. The differ plans `dropForeignKey` (priority 2) then
`addForeignKey` (priority 16) for every changed key, which on SQLite is the pair every
`manyToOne` push plans, forever, because `PRAGMA foreign_key_list` carries no constraint
name and introspection has to synthesise one. The add rebuilt the table from the pre-batch
list — which still held the key the drop had removed — and appended the replacement.
Measured on better-sqlite3: an unchanged schema pushed three times left `zz_posts` holding
**1, then 2, then 3** identical foreign keys, growing without bound, each separately
enforced. `getCurrentTable` now replays all four operations. Witnesses, and the live count,
in [`tests/migrations/sqlite-recreation-indexes.test.ts`](../../tests/migrations/sqlite-recreation-indexes.test.ts).

| Reverted | What failed |
| --- | --- |
| the both-names-taken skip in `serializer.ts` | the new serializer unit test (the FK index reappears under the declared name) |
| the `addForeignKey`/`dropForeignKey` replay in `getCurrentTable` | 3 tests — both rebuild witnesses, and the live push count reads `[1, 2, 3]` |
| the `isTotalIndex` conjunct in the 1:1 unique scan | 1 serializer unit test + 1 live SQLite3 test |
| the fallback index name | 2 serializer unit tests + 3 live tests (the push itself aborts on the duplicate name) |

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

One gate and one step in [`src/query-engine-v2/DeleteOperation.ts`](../../src/query-engine-v2/DeleteOperation.ts), mirroring `UpdateOperation`'s `canFold` and `CreateOperation.foldStep`. A delete folds when all four hold: transaction mode, a RETURNING driver, a scalar-only projection (see the `_count` correction below), and no `include`. The folded operation has EMPTY planning and one write step, so `OperationExecutor.statementAtomicPlan` runs it directly on the base driver — no transaction envelope — with `affectedRows(1, notFound)` enforced in JS afterwards.

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

#### The `_count` correction (review, 2026-08-03)

**The first spelling of "scalar-only" let `_count` fold, and a folded delete answered a WRONG relation count.** `selectIsScalarOnly` asked `model["~"].relationSet.has(field)`, and `_count` is a relation-derived projection that is **not a member of that set** — while `getDeleteArgs` validates `select` against the full `core.select`, which does include it. So `delete({ where, select: { id: true, _count: { select: { posts: true } } } })` folded, and measured on PGlite (PG 17) and better-sqlite3 3.51 with an author owning three posts:

| Path | Answer |
| --- | --- |
| `findUnique` (the control) | `{ id: 1, _count: { posts: 3 } }` |
| `delete`, folded (transaction substrate) | `{ id: 1, _count: { posts: 0 } }` — **wrong** |
| `delete`, unfolded (batch substrate) | `{ id: 1, _count: { posts: 3 } }` |

One payload, two substrates, two different answers. **The cause is name capture, not a cascade and not a read-after-write** — reproduced with a nullable FK and no cascade, the children surviving the delete. A `DELETE` has no table alias, so the count correlation is emitted BARE: `… json_build_object($2, (SELECT COUNT(*) FROM "f_post" AS "t1" WHERE "id" = "t1"."authorId"))`. Inside a subquery whose `FROM` is the child table — which has its own `id` — the bare `"id"` binds to `"t1"."id"` and the predicate silently becomes `t1.id = t1.authorId`. The unfolded read emits `"t0"."id" = "t1"."authorId"` and is right. This is the identical defect `restrictToScalarProjection` ([`bulk-write-projection.ts`](../../src/validation/model/args/bulk-write-projection.ts)) already refuses outright on bulk writes, and its doc comment already said `_count` counts as a relation there.

**Fix.** The predicate has one home now — `shared.selectProjectsRelation` — and it answers `_count` as a relation. The **three sibling folds carried the same defect and are corrected in the same commit**, because they read the same gate off the same helper: `update`'s `directWrite` and `upsert`'s `canFoldUpdateArm` also answered 0 where the read said 3, and `create`'s `foldStep` — whose truth is necessarily 0, since nothing can reference a row that did not exist — answered **1** whenever some child row's own `id` equalled its foreign key. All four now match `findUnique`.

**Why nothing caught it.** The full estate was green, `pnpm test:gates` 72/72, `tests/query-engine` + `tests/query-engine-v2` exit 0. Nothing in the estate exercised a relation projection on a delete against a database: this phase's own `select`-with-relation witness is pinned at the PLAN level only, deliberately, because that path has a separate PostgreSQL 0A000 defect — and that deliberate narrowing is exactly what let the `_count` sibling through. The new witnesses are therefore stated as **read-equality**, not fold-equality: a delete's projection must equal what `findUnique` answers for the SAME projection on the SAME row, on BOTH substrates, so the property keeps biting whatever the gate decides.

#### Witnesses

[`tests/query-engine-v2/delete-fold.test.ts`](../../tests/query-engine-v2/delete-fold.test.ts) — nine, on a recording PGlite driver plus three plan-shape assertions that need no database; four more added by the `_count` correction (two live `_count` spellings against the read on both substrates, one live create/update/upsert oracle whose seed includes a child row whose own `id` equals its foreign key so a wrong answer is a wrong NUMBER rather than an empty one, and one plan-level decline for both `_count` spellings). Each of the four fails when the `_count` conjunct is removed: live, 0 (delete) and 1 (create/update/upsert) against a truth of 3; at the plan level, empty planning where one locate step is required. Every conjunct of the gate was falsified individually: removing the gate fails the two count witnesses and the plan shape; removing the `include` exclusion fails the include witness; removing the transaction-mode conjunct fails the batch witness; removing the RETURNING conjunct fails the non-returning plan witness.

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

#### Phase 4 delivery record

**Delivered:** 2026-08-03, branch `nested-write-boundaries`. Baseline for every number below is `1e67bab`.

**What shipped, and what did not.** The child-held-FK `connect` and `disconnect` families fold **probe and write**. `set` and the M2M `connect` fold their **write only** — their probes stay per target, for one reason stated at the end of this record. M2M `disconnect` does not fold at all.

`src/query-engine-v2/link-target-groups.ts` is the grouped-probe fold's one home: `groupLinkTargets` splits a relation's targets into key-shape GROUPS, `linkGroupSelector` builds a group's one `WHERE`, `countDistinctTargets` says how many rows that `WHERE` can name. Two call sites read it — `RelationLinkPart` (the update family's connect/disconnect) and `ChildConnectPart` in `CreateOperation.ts` (the create tree's own child-held connect, which is a separate Part and would otherwise have kept the per-target shape).

**Measured — PGlite, three targets, statements counted at the driver's `execute`/`executeRaw` seam (which sees both substrates).**

| Operation | Before | After |
| --- | --- | --- |
| `update` + `connect: [a,b,c]`, transaction | 8 | **4** |
| `update` + `connect: [a,b,c]`, atomic batch | 12 | **8** |
| `update` + `disconnect: [a,b,c]`, transaction | 8 | **4** |
| `update` + `disconnect: [a,b,c]`, atomic batch | 12 | **8** |
| `create` + `connect: [a,b,c]`, transaction | 8 | **4** |
| `update` + `connect` over TWO key shapes (2 + 1) | 8 | **6** |
| `update` + `set: [a,b,c]`, transaction | 9 | **7** |
| `update` + `set: [a,b,c]`, atomic batch | 13 | **11** |
| M2M `connect: [a,b,c]`, transaction | 8 | **6** |
| M2M `disconnect: [a,b,c]`, transaction | 5 | unchanged |

The link's own traffic is what moved: six statements became two. The other two in the transaction row are the root's locate and terminal read, which this phase does not touch. In batch mode the probe and the write fold and the three presence guards stay, which is the plan's own instruction and is why the batch row lands on eight rather than five.

**A one-target group keeps the arity-1 statements verbatim.** `connect: [{ id: 10 }]` still emits `WHERE "id" = $1` and `UPDATE … WHERE "id" = $2 RETURNING`, not a one-element `IN`. That is deliberate: the single-target spelling is what the overwhelming majority of the estate and every existing plan exercises, and widening it would have made the fold's blast radius the whole engine rather than the list case. A witness pins it.

**What decides a group.** Three clauses, all in `groupLinkTargets`, all of them the fold's PRECONDITION rather than a guard against observed input:

1. *The same discriminator columns.* `{ id }` and `{ email }` are different IN lists.
2. *No extra filter half.* An extended selector carries a predicate as well as an identity, and two targets' predicates need not agree.
3. *Primitive key values only.* The missing-target verdict counts distinct keys, and that count must agree with what SQL calls one row.

Clauses 2 and 3 are **not reachable through the client today**, and that was measured rather than assumed: nested `connect`/`disconnect` take the STRICT `core.whereUnique` at the parse boundary (`{ id, archived: false }` is rejected with `Unknown key: archived`), and no scalar that admits `.unique()` validates to an object — `blob` refuses `.unique()` outright, and a `dateTime` unique key arrives as a primitive, so it folds. They are kept because `partitionWhereUnique` is the shared extractor and the alternative to reading its `filters` half is *silently dropping* it; and because the count algorithm is simply wrong for object values, so the clause states what it needs rather than guarding against what it fears. Both are exercised directly on the rule (a unit test on `groupLinkTargets`), not left as an unfalsifiable branch.

**The missing-target error keeps its text, its attribution and its phase.** It is decided by a COUNT, and the count is exact rather than approximate: a complete unique key names at most one row, so the grouped probe returns exactly as many rows as there are distinct keys that exist, and fewer means one of the named targets is absent. **Nothing compares a decoded column value against an input value** — which is why `connect: [{ id: 1 }, { id: 1 }]` (two entries, one row) still succeeds, and why clause 3 above exists. A witness takes the arity-1 path's message and byte-compares the grouped path's against it rather than against a literal copied from the source; another puts the absent target first, middle and last in the list; another puts a satisfiable relation beside an unsatisfiable one in the same update and asserts the message and `meta.relation` name the relation that actually failed.

**The write addresses rows by the CALLER's key, not by the probe's primary keys.** The plan text above suggests `UPDATE … WHERE pk IN (…)`. In batch mode the probe runs before the atomic unit while the presence guard runs inside it, so a primary key read at planning time is older than the assertion that admits the write: a row deleted and re-inserted under the same unique key between the two would satisfy the guard and be missed by a pk-addressed write. The key columns are exactly what the guard re-asserts, so the write uses them. For the common `connect: [{ id }]` case the two spellings are the same statement.

**The Pin Rule is untouched.** The probe is still a planning read whose rows `compile(known)` consumes; only its `WHERE` is wider. `OperationFragment.ts` is byte-identical to `1e67bab`, no error message or attribution was removed, and the `set` orphan guard was not touched.

**A note on locking.** N separate `FOR UPDATE` probes acquired their locks in input order, so two transactions connecting `[10, 11]` and `[11, 10]` could deadlock. One IN-list `FOR UPDATE` lets the database choose a scan order, which is consistent across transactions. The fold reduces that exposure; it does not create any.

**Witnesses.** [`tests/query-engine-v2/link-in-list-fold.test.ts`](../../tests/query-engine-v2/link-in-list-fold.test.ts) — 25 tests over three groups: the statement traffic (counts and the emitted `IN`/`OR`, tx and batch, update root and create root, compound unique, mixed shapes, `set`'s folded reparent, the M2M `junctionInsertMany` with its idempotence and its absent-target rejection), what may share a group (the rule exercised directly, plus the repeated-target and date-key readings), and the missing-target error. Five cases were added to [`tests/drivers/nested-write-behavior.ts`](../../tests/drivers/nested-write-behavior.ts), which is already wired on every driver, so the SQL the fold newly emits — an `IN` list inside a locked read and inside a bulk UPDATE — runs on all of them. MySQL matters most there: it is non-returning, so the folded write goes out as a plain `UPDATE … WHERE key IN (…)` with no RETURNING clause to confirm it.

**Falsification — nine mutations, each applied alone, each caught.**

| Mutation | What failed |
| --- | --- |
| The count check becomes `rows.length === 0` | all 5 missing-target witnesses |
| The shape key stops distinguishing key shapes | the mixed-shape witness |
| The grouped disconnect probe loses its correlation half | the disconnect count witness and the another-parent witness |
| The batch guards collapse from per-target to one per group | the batch guard witness |
| The distinct count stops deduplicating | the repeated-target witness and its unit test |
| Clause 3 (primitive values) removed | the object-key unit test |
| Clause 2 (filter half) removed | the predicate-half unit test |
| `set`'s folded write addresses by SELECTOR, not captured PK | the two `set` witnesses — **and nothing else in the estate**, see the gap noted below |
| M2M `connect` goes back to one INSERT per target | the M2M insert-count witness |

**Gate.** `tsc` clean. Repo-pinned `npx biome check` (2.3.11) clean on all seven changed files. `pnpm test:gates` **72 passed**, census unchanged. Suites run in this worktree, 0 failures: `tests/query-engine-v2` + `tests/query-engine` + `tests/adapters` **2301**, `tests/drivers` **3393** (2124 skipped, and the three local legs — PGlite tx + batch, SQLite3, LibSQL — carry the five new behavior cases). No pinned SQL file changed — `sql-generation.test.ts` holds no connect/disconnect pin, and the arity-1 spelling did not move. The Docker MySQL (3307) and PostgreSQL (5434) legs belong to the gate agent.

#### The probes that stay per target — `set` and the M2M junction

Their WRITES fold; their PROBES do not, and the reason is one mechanism.

Both families' batch guard is a **split-witness** guard: it pairs each selector with the primary key that selector's OWN probe captured (`RelationWritePart.ts` `RelationSetPart.compile`, `RelationJunctionPart.ts` `targetPresenceGuard` / `connectedPresenceGuard`). It exists so a concurrent write that moves a selector onto a replacement row is rejected rather than adopting the replacement. A grouped probe destroys the pairing: recovering which returned row answers which selector means comparing a DECODED column value against an input value — exactly the comparison this phase's missing-target verdict was built to avoid, because its failure mode is a false rejection of a legitimate operation. The two weaker group-wide restatements were considered and rejected: an `exists` over the group is satisfied by one row, and `notExists(group ∧ pk NOT IN captured)` accepts a concurrent swap between two members of the same group that the paired guards reject.

The writes need no pairing, because both families **already address rows by the captured primary key** rather than by the caller's selector:

- **`set`'s reparent** is one `UPDATE … SET fk = parent WHERE pk IN (all captured pks)` (`buildUpdateMany`), taking `set: [3]` from nine statements to seven in a transaction and from thirteen to eleven in a batch. The guards moved ahead of the single write, which changes nothing: inside an atomic unit a failed assertion aborts the whole unit, and in transaction mode there are no guards.
- **M2M `connect`** is one `junctionInsertMany` — the consolidated form the `set` arm at `RelationJunctionPart.ts:436-443` already used. `buildJunctionInsert` IS `buildJunctionInsertMany` over a one-element list, so the duplicate-skip clause that makes `connect` idempotent is byte-identical; a witness re-connects an existing member alongside a new one and asserts no conflict. M2M `connect: [3]` goes from eight statements to six.

**M2M `disconnect` was left alone.** Its N `junctionDelete` statements each build their own target subquery from one unique `where` (`ManyToManyStatements.materialize`, the `junctionDelete` arm through `buildTargetPkSubquery`). Folding needs that statement to take a LIST of unique wheres, which is a change to a query-engine builder shared beyond this phase — out of scope here, and recorded so the next reader does not have to rediscover it.

**A coverage gap found while falsifying, and not closed here.** Forcing `set`'s folded write to address rows by the caller's SELECTOR instead of the captured primary key — which discards V1's mutation-identity and lets a concurrent selector move redirect the write — was caught by NOTHING in the estate except the two new SQL-shape assertions in the witness file. The property is pre-existing and the per-target spelling had exactly the same hole; a behavioral witness needs a second connection to commit the concurrent move, so it belongs with the Docker-gated driver tests beside `m2m-deletemany-staleness-behavior.ts`. Filed, not fixed.

Phase 6's premise — that the tx-mode condition can come off some fold gates on batch-only drivers — is the natural place to revisit whether the split-witness guard can be restated so these probes fold as well.

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

- *seeks into the index* — EXPLAINs the emitted statement and asserts that the **outer relation, named by its alias `t0`**, is the thing that seeks: `Index Scan using order_plan_rows_bucket_id_idx on order_plan_rows t0` immediately followed by `Index Cond: (ROW(…` on PostgreSQL, `SEARCH t0 USING INDEX order_plan_rows_bucket_id_idx (…` on SQLite, plus no `Seq Scan` (PostgreSQL) and no `SCAN t0` (SQLite).

  **Corrected after review; the first spelling of this witness was vacuous, exactly as 5.1's was.** It asserted a bare `Index Cond` / `SEARCH` and the absence of `Seq Scan` / `SCAN order_plan_rows`. Measured on the PR tip with the row-value spelling forced off (`const sargable = false && …`) and the two SQL-string assertions disabled, all four of those assertions **passed on both dialects** — because the cursor row's own primary-key lookup is a seek in BOTH spellings (it supplies the `Index Cond` and the `SEARCH`), and because SQLite prints the alias `SCAN t0` and never the table name, so `SCAN order_plan_rows` could not fail on any plan at all. The regressed plans that satisfied it: PostgreSQL `Nested Loop Semi Join` with the OR-of-ANDs in a `Join Filter` over a full `Index Scan … t0`; SQLite `SCAN t0 USING INDEX order_plan_rows_bucket_id_idx` with a `CO-ROUTINE`. The entire falsification power of the unit was therefore the SQL-string assertions, and nothing in the estate would have failed if the row-value spelling stopped seeking (a different adapter, a CTE-wrapping `subqueries.scalar`, another dialect). The corrected assertions were re-falsified the way that would have caught it: with the SQL half disabled and the mutation in place, the plan half now fails on **both** dialects.
- *both cursor spellings page identically over duplicate sort keys* — the parity oracle. `bucket` (NOT NULL) and `mirror` (nullable, but holding the same values on every row and never null) carry identical data, so the two columns differ only in what the schema says. Paging both, five rows at a time through seven-row groups so no page edge aligns with a group boundary, must give the same 30 rows in the same order; the test also asserts that the two runs really did take the two different code paths, and that the result is the contiguous head of the total order rather than two matching mistakes.
- *a descending cursor pages in the order an independent sort gives* — a JS sort of the same seed data as the oracle, so the direction gate is answerable in rows.
- *a cursor over a column holding nulls pages through them* — every cursor row in this run has a null sort value, so the nullability gate is answerable in rows too.
- *a cursor that matches no row leaves an empty window*.

**Falsification.** Each of the three code paths was broken in turn and the witnesses caught all three: forcing the general spelling everywhere fails the seek witness and the parity path-divergence check on both dialects; removing the direction half of the gate returns wrong rows from the descending oracle on both dialects; removing the nullability half returns wrong rows from the null-paging oracle and breaks the parity check.

**Pinned SQL.** `tests/query-engine/cursor-pagination-sql.test.ts` gains five deliberate pins across all three dialects for the new spelling and its three fallbacks. Two further pins moved for **Unit 5.1**, not this unit, and are recorded here because they were found late — running only the two SQL files rather than the whole `tests/query-engine` directory left them red at 5.1's commit: `tests/query-engine/operation-equivalence-oracles.test.ts` (frozen read SQL on all three dialects, `views`/`id` both NOT NULL) and `tests/query-engine-v2/located-parent-ref.test.ts` (a guard's `id` tie-breaker). Both are the same NOT NULL placement removal, and both now carry a comment saying so.

**Gate.** `tsc` clean; repo-pinned `npx biome check` clean on every changed file; `pnpm test:gates` 72/72, census unchanged. Suites run in this worktree, 0 failures throughout: `tests/query-engine` 1201, `tests/query-engine-v2` + `tests/adapters` 1061, `tests/drivers` 3349 (2102 skipped), `tests/client` and the schema/model/relations/scalars/errors/cache/instrumentation set 2569, `tests/migrations` + `tests/cli` + `tests/validation` 1492. The Docker MySQL and PostgreSQL legs belong to the gate agent and were not run here; the MySQL row-value syntax and plan were probed directly instead, as recorded above.

No error message, attribution, or race protection was touched, and `OperationFragment.ts` is untouched.

---

## Wave gate — Phases 2, 3 and 5 together

**Run:** 2026-08-03, main checkout, branch `nested-write-boundaries`, tip `61fc227` (eleven commits from `484cc6c`, the serializer index-name resolution, through `61fc227`, the corrected cursor-seek witness). Baseline for every number below is `c45e2b5`, the Phase 1 tip.

### The legs

| Leg | Result | Baseline |
| --- | --- | --- |
| `pnpm test:types` (tsc 5.9.3) | clean | clean |
| full estate, `npx vitest run --minWorkers=1 --maxWorkers=4`, run alone | **9279 passed, 0 failed**, 2109 skipped (262 files, 4 skipped) | 9197 / 0 |
| `pnpm test:gates` | **72 passed** (5 files) | 72 |
| repo-pinned `npx biome check` (2.3.11) per changed file | **no new diagnostics** — see below | — |
| Docker MySQL 8, port 3307 | **988 passed, 0 failed** | 984 |
| Docker PostgreSQL, port 5434 | **1100 passed, 0 failed**, 14 skipped | 1097 |

**Biome.** Seven diagnostics survive across the 33 changed files, and all seven are the `c45e2b5` versions of the same lines: two in `src/migrations/drivers/sqlite/introspect.ts` (`noUselessSwitchCase`, `noUselessTernary` — at `44`/`97` before, `130`/`197` now), three `useTopLevelRegex` in `tests/migrations/ddl-drivers.test.ts` (`94`, `928`, `949` before; `94`, `970`, `991` now) and two in `tests/migrations/serializer.test.ts` (`337`, `359`, unmoved). The `c45e2b5` blobs were extracted and re-checked side by side to establish this; the kind and the count match exactly, only line numbers moved.

**Witnesses executed by name on the Docker legs.** Phase 2: `MySQL2 declared index on a mapped field` — *push creates the index over the mapped column names*, *re-pushing the schema is not an index change*, *the declared index leaves the FK index nothing to add*; and `MySQL2 partial index refusal > push refuses the declaration by name`. Phase 3's MySQL path: the live non-returning delete (`MySQL2 upsert atomicity behavior > delete with include returns the relation payload`, wired on mysql2 at `mysql2.test.ts:360`), with the plan-level MySQL declines — *a NON-RETURNING driver keeps the locate, the read, and the delete* in `delete-fold.test.ts` and the surviving MySQL refusal pin in `sql-generation.test.ts:776` — carried by the estate leg.

### Measured at the gate, not copied

The delivery records above were written by the implementers. These readings were taken independently at the gate, on the tip, through the driver seam and the instrumentation seam.

**Phase 3 — the delete costs one statement and no envelope.** Statements recorded at the PGlite `execute`/`executeRaw` seam, which sees both substrates:

```text
delete({ where: { id } })                  → 1 statement, no BEGIN/COMMIT
  DELETE FROM "g_accounts" WHERE "g_accounts"."id" = $1
    RETURNING "id" AS "id", "email" AS "email", "label" AS "label"

delete({ where: { email }, select: { label } }) → 1 statement, no BEGIN/COMMIT
  DELETE FROM "g_accounts" WHERE "g_accounts"."email" = $1
    RETURNING "label" AS "label"
```

Five round trips (BEGIN, locate, snapshot, DELETE, COMMIT) became one. The alternate-unique form folds too: the selector rides into the DELETE rather than being resolved to a PK first.

**Phase 5 — both spellings reach the index.** SQLite (better-sqlite3, 4,000 rows, `ANALYZE`d, one composite index `(bucket, id)`), EXPLAIN QUERY PLAN over the statement the client emitted, with that statement's own parameters:

```text
5.1  ORDER BY "t0"."bucket" ASC, "t0"."id" ASC LIMIT ?
     SCAN t0 USING INDEX g_rows_bucket_id_idx

5.2  WHERE ("t0"."bucket", "t0"."id") >= (SELECT "t1"."bucket", "t1"."id"
            FROM "g_rows" AS "t1" WHERE "t1"."id" = ? LIMIT ?)
     SEARCH t0 USING INDEX g_rows_bucket_id_idx (bucket>?)
     SCALAR SUBQUERY 1
       SEARCH t1 USING INDEX sqlite_autoindex_g_rows_1 (id=?)
```

`bucket` is NOT NULL, so 5.1 emits the bare direction — no `NULLS FIRST/LAST` anywhere in the ORDER BY — and the read walks the index with no `USE TEMP B-TREE`. 5.2 is the row-value comparison against a scalar subquery, and the outer relation `t0` **seeks** (`bucket>?`) rather than scanning under a filter; the cursor row is still located inside the same statement, by its own unique key.

Phase 2 is a DDL change and has no statement count or plan to read; its evidence is the catalog read-back, taken live on all five drivers by `runMappedIndexBehavior`, `runPartialIndexBehavior`, `runPartialIndexRefusalBehavior` and `runPartialIndexCoverageBehavior`, every one of which executed in the legs above.

### Standing rules

No error message, no error attribution and no race protection was removed anywhere in the wave. The step vocabulary in `OperationFragment.ts` is byte-identical to `c45e2b5`. Three pinned-SQL files changed, each deliberately and each with its rationale in place: `sql-generation.test.ts` (Phase 3 — the old pin asserted the very refusal the fold removes), `cursor-pagination-sql.test.ts` (Units 5.1 and 5.2), and two further pins moved by 5.1 in `operation-equivalence-oracles.test.ts` and `located-parent-ref.test.ts`.

**Open and recorded, not fixed here:** Decision 7.4 (the PostgreSQL partial-index predicate churn, raised by Phase 2), and the `0A000` on `delete({ select: { relation } })` on PostgreSQL that Phase 3's witnesses surfaced — both pre-existing, both filed above.

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

### Measured starting line, and two blockers the plan text does not account for

**Delivered here: the measurement, not the change.** Both units were implemented and
measured live on the batch-only PGlite stand-in, and each ran into a blocker that is a
decision rather than a defect. The counts below are pinned by
[`tests/query-engine-v2/batch-round-trip-baseline.test.ts`](../../tests/query-engine-v2/batch-round-trip-baseline.test.ts),
which counts every call reaching a driver execution seam — on D1 and Neon HTTP that is
one HTTP request each. It is a harness, not an endorsement: every number in it is a
target this phase exists to lower, and a change that raises one is a regression.

| Payload (batch-only driver) | Today | 6.1 measured | 6.2 measured |
| --- | --- | --- | --- |
| scalar `update` | 2 | 2 | **1** |
| scalar `delete` / `upsert` update-arm | 2 | 2 | not reached |
| nested update, one child target | 3 | 3 | — |
| nested update, two sibling targets | 4 | **3** | — |
| nested update, four sibling targets | 6 | **3** | — |
| `update` with a nested `upsert` | 3 | **2** | — |

6.1 behaves exactly as the plan predicts: only a technique-#1 reference orders planning
steps, so grouping by level makes the planning cost one round trip per LEVEL rather than
per READ, and the total stops growing with the fan-out. The falsification bites as
specified — ignoring the references and sending every planning read in one batch fails
with `Operation reference 'user.locate.id' is unresolved`, because the correlated probe's
parameter is the locate's output.

**Blocker 6.1 — the race-injection harness assumes the first batch is the write batch.**
Nine test files carry the same one-shot `beforeBatch` driver hook, whose contract is
stated as "runs between planning and the atomic batch — the deterministic staleness
window". It is implemented as "fire on the first `executeBatch`". Once planning reads
also travel by batch, that hook fires on a PLANNING batch and the injected concurrent
mutation lands before planning instead of between planning and the write, so the window
under test is never opened: **12 tests across 4 files go red**, every one of them a race
premise (`staleness-injection`, `upsert-family`, `create-family`,
`produced-identity-race-pin`). No guard, error or attribution changes — the compiled
write unit and `compileToEntries` are untouched, and grouping READS under one batch makes
planning see a single snapshot rather than several, which is a strengthening. The
harness's timing assumption is what breaks. Making 6.1 shippable therefore means editing
the race-protection net in nine files so this phase's own optimization goes green, which
is the one thing this plan's rules single out for a reviewer's attack. **Disposition: the
harness change wants its own review and its own authorization; it is not a step to fold
into a performance phase.**

**Blocker 6.2 — a JS postcondition cannot abort a batch that has already committed.**
Removing the `txMode` conjunct from `UpdateOperation.canFold` does deliver the plan's
number: a scalar update on a batch-only driver drops from 2 round trips to **1**, running
through `statementAtomicPlan` with `affectedRows(1, notFound)` enforced in JS, exactly as
the plan describes. But the folded fragment is then one step carrying a postcondition, and
`$transaction([...])` on a batch-only driver reaches `prepareSharedBatch` →
`compileToEntries`, which fails closed on precisely that:

```text
QueryEngineError: Step 'user.update' carries a postcondition
that is not yet enforced in batch mode.
```

That refusal is correct and must stay. The array seam merges several operations into ONE
driver batch, so a JS check that runs after the batch returns cannot un-commit the
siblings; the presence assertion has to be IN the batch, which is what the unfolded path's
guard already is. So `$transaction([client.user.update(…)])` — working today, and pinned
by the baseline harness — would become a typed refusal. The fold is legal exactly where the
operation is its OWN atomic unit and illegal where it is merged with siblings, and the
operation is constructed before either seam is known. **Disposition: 6.2 needs a seam
decision first.** The shape that satisfies both is not the plan's ("move the check to the
JS postcondition") but its batch-mode analogue: emit `[presence guard, UPDATE … RETURNING]`
with no postcondition, which is also one round trip, keeps the array seam working, and
reuses the existing `attributeGuardFailure` attribution unchanged.

---

## Wave gate — Phases 4 and 6 together

**Run:** 2026-08-03, main checkout, branch `nested-write-boundaries`, tip `f0450cc` (four
commits from `1886518`, the grouped link probe and write, through `f0450cc`, the Phase 6
round-trip harness). Baseline for every number below is `1e67bab`.

### The legs

| Leg | Result | Baseline |
| --- | --- | --- |
| `pnpm test:types` (tsc 5.9.3) | clean | clean |
| full estate, `npx vitest run --minWorkers=1 --maxWorkers=4`, run alone | **9338 passed, 0 failed**, 2124 skipped (264 files, 4 skipped) | 9279 / 0 |
| `pnpm test:gates` | **72 passed** (5 files); census pin 39, unchanged | 72 |
| repo-pinned `npx biome check` (2.3.11) per changed file | **clean — zero diagnostics on all eight** | — |
| Docker MySQL 8, port 3307 | **993 passed, 0 failed** | 990 |
| Docker PostgreSQL, port 5434 | **1110 passed, 0 failed**, 14 skipped | 1102 |

**Biome.** The wave changed eight TypeScript files. Unlike the Phases 2/3/5 wave, none of
them carries a surviving diagnostic: `npx biome check` reports nothing on any of the eight,
so "no new diagnostics" holds by construction and needed no baseline comparison.

**The Docker PostgreSQL leg has to run serially, and the gate proved why.** Run as
`npx vitest run tests/drivers/pg.test.ts tests/drivers/postgres.test.ts` — without
`--no-file-parallelism`, which `pnpm test:pg` supplies — the two files push the same schema
into the same database concurrently and all ten Phase 4 witnesses fail in about 4 ms, before
any statement of the operation under test runs. Re-run under the script's own flag they are
green. This is a harness constraint, not a product finding, and it is recorded so the next
gate does not read it as one.

**Phase 4's grouped-link witnesses, executed by name.** The five cases added to
`tests/drivers/nested-write-behavior.ts` ran green on all three gated legs:
*connect with a list of targets reparents every one of them*, *a connect list with one
absent target writes nothing*, *disconnect with a list nulls every one of them*, *a
disconnect list naming ANOTHER parent's child nulls nothing*, and *a create tree's connect
list reparents every one of them* — on `MySQL2 nested write behavior`, on
`pg nested write behavior` and on `postgres.js nested write behavior`. MySQL is the leg
that matters most: it is non-returning, so the folded write goes out as a plain
`UPDATE … WHERE key IN (…)` with no RETURNING clause to confirm it.

### Measured at the gate, not copied

Taken independently at the tip through the PGlite `execute`/`executeRaw` seam (which sees
both substrates) and through the batch-only stand-in's `_execute` / `_executeBatch` seams,
on a schema written for this reading rather than on the witness files' own.

**Phase 4 — statements for a three-target link.** Every "after" number in the delivery
record reproduced exactly:

```text
update + connect: [a,b,c]     transaction      4 statements   (2 are the link)
update + connect: [a,b,c]     atomic batch     8 statements   (5 are the link)
update + disconnect: [a,b,c]  transaction      4 statements   (2 are the link)
create + connect: [a,b,c]     transaction      4 statements   (2 are the link)
update + set: [a,b,c]         transaction      7 statements
M2M    connect: [a,b,c]       transaction      6 statements
```

Six link statements became two for `connect`/`disconnect`: one IN-list `FOR UPDATE` probe
and one IN-list UPDATE. The remaining two in each transaction row are the root's own locate
and terminal read, which this phase does not touch. The batch row keeps its three per-target
presence guards, which is the plan's own instruction, and is why it lands on eight rather
than five. `set` and the M2M junction fold their write only, for the split-witness reason
recorded above.

**Phase 6 — round trips on the batch-only driver, at the tip.** Phase 6 shipped the
measurement and not the change, so the gate's job is to confirm the starting line still
reads as the harness pins it:

```text
scalar update              2 round trips
scalar delete              2 round trips
nested update, 1 target    3 round trips
nested update, 2 targets   4 round trips
nested update, 4 targets   6 round trips
```

These are the "Today" column of the Phase 6 table, unchanged — which is the correct reading:
6.1 and 6.2 were both measured and both parked on a blocker, and neither landed. Every number
is a target the phase exists to lower.

### Standing rules

`src/query-engine-v2/OperationFragment.ts` is byte-identical to `1e67bab` — the frozen step
vocabulary did not grow. No pinned SQL changed: `tests/query-engine/sql-generation.test.ts`
is not in the wave's diff at all, and the arity-1 link spelling did not move, which is what
keeps every existing single-target pin unmoved. No error message and no error attribution was
removed — no message literal is deleted anywhere in the wave's `src` diff. No race protection
was removed: `presenceGuard` occurs the same number of times at the tip as at the baseline in
each of the four Parts that carry one (`RelationLinkPart` 2, `RelationJunctionPart` 2,
`RelationWritePart` 3, `CreateOperation` 2), and the `set` orphan guard was not touched — the
only hunks in `RelationWritePart.ts` are inside `RelationSetPart.compile`.

**Open and recorded, not fixed here:** both Phase 6 blockers (the race-injection harness's
first-batch assumption, and the batch-seam decision a postcondition-carrying fold needs),
M2M `disconnect`'s unfolded per-target deletes, and the `set` selector-addressing coverage
gap Phase 4's falsification surfaced. All four are dispositions, not defects, and all four
are stated above.

---

## Phase 7 — Four maintainer decisions

These items need a written disposition. They are choices, not defects.

### Decision 7.1 — The scalar-upsert ON CONFLICT door

ATOM §4 permits a native `INSERT … ON CONFLICT DO UPDATE` for a top-level scalar upsert with an expressible conflict target ([`ATOM.md:243-262`](../../src/query-engine-v2/ATOM.md), the "legal, but observably divergent" note at `:250-254`). The current sequence is at [`UpsertOperation.ts:342-351, 446-492`](../../src/query-engine-v2/UpsertOperation.ts). This changes four or five round trips into one on PostgreSQL and SQLite. MySQL stays on the probe path: its `ON DUPLICATE KEY` fires on any unique collision ([`mysql-adapter.ts:408-414`](../../src/adapters/databases/mysql/mysql-adapter.ts)), which breaks the documented unrelated-collision behavior. The disposition must state the accepted observable divergence against the oracle.

#### DISPOSITION — TAKE the door. Delivered 2026-08-03, branch `nested-write-boundaries`.

**The measured baseline** (PGlite, statements counted at the driver's `execute`/`executeRaw` seam, which sees both substrates):

| Shape | Before | After |
| --- | --- | --- |
| `upsert` → create arm, transaction | 3 payload statements (locate `FOR UPDATE`, INSERT, terminal SELECT) inside BEGIN/COMMIT — 5 round trips | **1**, no envelope — 1 round trip |
| `upsert` → update arm, transaction | 2 (locate `FOR UPDATE`, `UPDATE … RETURNING`) — 4 round trips | **1** |
| `upsert` → create arm, atomic batch | 3 | **1** |
| `upsert` → update arm, atomic batch | 3 (locate, presence guard, `UPDATE … RETURNING`) | **1** |

The gate is in `UpsertOperation.buildOnConflictFold`. It has **seven** conjuncts, and every one of them has coverage no other has — each was removed on its own and the witness that failed is recorded below.

1. `canFoldUpdateArm` — the update arm's existing fold gate, reused rather than restated, so `supportsReturning` is read in ONE place in the class. It carries a RETURNING driver, a scalar update arm, and a scalar-only projection with no `include`.
2. `supportsTargetedUpsert` — a NEW adapter capability naming the arbiter property.
3. no `targetWhere` / `setWhere`.
4. a plain unique `where` (no extended-selector filter half).
5. the `where`'s discriminator names exactly ONE constraint.
6. the create data spells every conflict-target column with the `where`'s own value.
7. a `set`-only update payload.

**Conjunct 5 was MISSING at first delivery, and it was a regression** — recorded rather than quietly patched, because it is the shape of mistake this door invites. A `whereUnique` may name several independent single-field uniques at once (`where: { id: 1, email: 'a1@x' }`, legal since Prisma 4.5 and answered by `findUnique` and `update`), and `partitionWhereUnique` flattens the discriminator to one entry per constrained COLUMN with no bound of one. `buildConflictTarget` joins every entry, so that selector emitted `ON CONFLICT ("id", "email")` — a column pair with no unique index behind it. Measured on PGlite: `V2001` / `providerCode 42P10`, "there is no unique or exclusion constraint matching the ON CONFLICT specification", on BOTH arms, with SQLite3 rejecting the same shape; flipping `supportsTargetedUpsert` off made all of it succeed, so the probe path had always answered it. Neither conjunct 4 nor conjunct 6 covers it: two uniques are both DISCRIMINATORS, so there is no filter half to see, and the create data spelling both is the natural spelling. The fix counts the discriminator's own KEYS, not the flattened entries, so a compound (one key, several columns) still folds; the control test asserts `ON CONFLICT ("org", "slot")` on a compound-unique model and fails on the entries-counting spelling.

**Why the arbiter is a capability and not an inference.** `ON DUPLICATE KEY UPDATE` carries no target and fires on ANY unique collision, so it would silently ADOPT a row the caller never named — a wrong answer, not a missing optimization. It reads `false` on exactly the same adapters as `supportsReturning` today; that is a coincidence of the three adapters shipped, not an implication (MariaDB has `RETURNING` on `INSERT` and still arbitrates on any key), and the capability's doc comment says so, so it is not "simplified" away later.

**The ACCEPTED divergence against the oracle — one, and it is measured.**

> **The update path burns one sequence value the probe path did not.** `INSERT … ON CONFLICT DO UPDATE` evaluates the INSERT's column defaults before it detects the conflict, so a database-generated identity the create data omits consumes a value even when the row already existed. Measured: PostgreSQL `last_value` **100 → 101**; SQLite `sqlite_sequence` **2 → 3**. Probe-first runs no INSERT on that path and consumes nothing. Sequences are documented as non-gap-free on both dialects, and ATOM §4 names this burn as the divergence a written disposition covers. **Pinned** as `DIVERGENCE 1` in [`tests/query-engine-v2/upsert-on-conflict-fold.test.ts`](../../tests/query-engine-v2/upsert-on-conflict-fold.test.ts), which asserts the probe path's delta is 1 and the folded path's is 2 — so the number stays measured rather than becoming prose.

**What was FEARED and does NOT diverge — each checked by the dual-run oracle, not by argument.** The oracle runs the same payload twice from the same seeded state and compares the answer, the persisted rows, the thrown error's class/code/`meta`, and the statement count. The two paths are selected by flipping the gate's OWN arbiter conjunct, so "the old path" is literally the shipped probe-first sequence; a meta-test asserts the lever really does select two different paths.

| Feared divergence | Measured verdict |
| --- | --- |
| unrelated-unique collision on the CREATE arm (`where` absent, create data collides on another unique) | **identical** — `UniqueConstraintError`, `V3001`, `providerCode 23505`, `constraint: <table>_email_key`, on both paths. The arbiter is `id`; the `email` index is not the arbiter, so its violation is raised as itself. |
| unrelated collision produced by the UPDATE payload | **identical** — probe-first runs the same `UPDATE`, so both raise. |
| a collision carried by the create half when the UPDATE arm is taken | **identical, neither raises** — probe-first never runs an INSERT; the fold's speculative insertion is rolled back into `DO UPDATE`. Measured, because this was the case most likely to differ. |
| affected-count reporting | **identical** — `ON CONFLICT` affects exactly one row on both arms (`affectedRows: 1`, one RETURNING row). It cannot affect zero, so no postcondition was moved or dropped. |
| the pinned-abort error class disappearing (ATOM §4's phrase) | **not observable.** The create arm's `racePin` only ever classified a violation so the routed layer could retry ONCE and converge. The folded statement converges without retrying, to the same answer. |

**Race semantics: atomic where probe-first retried.** Structurally, the folded fragment has EMPTY planning and exactly one step carrying no `racePin` — there is no window between a decision and the write that acts on it. Behaviourally, a competitor on its **own connection** (a file-backed SQLite database, because an in-process PGlite cannot be raced against itself without deadlocking its own serialization queue) commits the contested key in the window between decision and write: probe-first loses its INSERT, the `racePin` classifies it, the routed retry re-plans into the update arm and converges — paying a second full round of statements. The folded statement takes its `DO UPDATE` arm and answers the same thing in one. **The race protection is not removed; it is discharged by the database**, which is what makes the absent `racePin` sound rather than a hole.

**What the gate excludes, and why each exclusion is correctness rather than caution.**

- **`targetWhere`/`setWhere`** — their contract is V1's silent no-op: no write, and the terminal read still answers with the UNCHANGED row. `DO UPDATE … WHERE <no match>` returns ZERO rows (measured on PG 17), so a folded upsert would answer nothing where the contract says it answers the row.
- **an extended selector** — the filter half decides WHICH row the operation means and `ON CONFLICT` has nowhere to put it; the conflict would arbitrate on the unique half alone and adopt the very row the filter EXCLUDED. This is the same rule `childRacePin` already applies when it withholds the create arm's pin for an extended selector.
- **a selector naming two independent uniques** — `ON CONFLICT` takes ONE arbiter index and the target is spelled from every column the discriminator constrains, so `{ id, email }` emits a column pair no index covers (`42P10`, measured, both arms). There is no folding it by electing one of the two either: the other unique is a second condition on the row the caller named, and arbitrating on `id` alone would adopt a row whose `email` the selector excluded — the extended-selector failure again, in a different spelling.
- **`create` that does not satisfy `where`** — Prisma does not require it to, and `ON CONFLICT` arbitrates on the VALUES row rather than on the caller's `where` (measured: `where: { id: 10 }` with `create: { id: 20 }` conflicts on 20, inserting a second row where probe-first would have updated row 10).
- **atomic arithmetic / `push` / `unshift` in the update payload** — `buildSet` spells these `col = <col> op x` with ONE column expression on both sides, and inside `DO UPDATE SET` PostgreSQL rejects every spelling it can produce: bare on both sides is `42702` ("column reference is ambiguous" — the proposed row and the existing row both offer the name), and qualifying the assignment target is `42703`. Only "bare target, qualified source" parses, and no emitter in this codebase writes that. **Recorded residual:** the common counter idiom `update: { count: { increment: 1 } }` therefore keeps the probe path. Closing it needs a SET emitter that qualifies only the source — a new adapter-surface spelling, deliberately out of this decision's scope.
- **a relation projection or `include`** — carried by conjunct 1; `_count` off a RETURNING subquery binds by name, the defect Phase 3 already corrected once.

**A conjunct that was written and then REMOVED.** An eighth conjunct, `!createHasRelations`, was in the first spelling. Falsification found **nothing in the estate that could tell it apart from conjunct 6**: `createData` is `{}` for a relation-bearing payload, so every conflict-target column reads `undefined` and the fold already declines. That is a check whose unique coverage cannot be named, which this codebase forbids, so it went — and the coupling it relied on is written down at conjunct 6 instead, together with the instruction to restore it in the same edit if `createData` ever holds the scalar half of a relation-bearing payload.

**Falsification — twelve mutations, each applied alone.**

| Mutation | What failed |
| --- | --- |
| the gate forced CLOSED (`permitted = false`) | 10 — every traffic witness, both divergence measurements, the oracle's lever meta-test, and both fold controls |
| conjunct 1 removed (`canFoldUpdateArm`) | the `include` witness and the `_count` witness |
| conjunct 2 removed **and** a target-ignoring arbiter substituted (the MySQL semantic, live) | 5 — including the unrelated-collision witness, which stops raising and adopts a row the caller never named |
| MySQL declared `supportsTargetedUpsert: true` (the brief's literal falsification) | the arbiter witness |
| conjunct 3 removed | both conditional witnesses |
| conjunct 4 removed | the extended-selector witness |
| conjunct 5 removed | all three two-independent-uniques witnesses (both PGlite arms and the SQLite one) — `42P10` returns |
| conjunct 5 spelled on the FLATTENED entries (`entries.length === 1`) instead of the discriminator's keys | the compound-unique control — the fold silently stops applying to every compound `where` |
| conjunct 6 removed | the create-does-not-satisfy-where witness **and** the relation-bearing create-arm witness |
| conjunct 6 WEAKENED to "the key is present", dropping the value comparison | the create-does-not-satisfy-where witness |
| conjunct 7 removed | the atomic-arithmetic witness |
| `!createHasRelations` removed | **nothing** — which is why it is no longer there |

**Witnesses.** [`tests/query-engine-v2/upsert-on-conflict-fold.test.ts`](../../tests/query-engine-v2/upsert-on-conflict-fold.test.ts) — 35 tests in four groups: the traffic (counts on both arms and both substrates, the alternate-unique conflict target, and the plan shape without a database), the dual-run oracle (ten payloads plus the lever meta-test), the accepted and rejected divergences, and one case per excluded shape. Four more in [`upsert-family-behavior.ts`](../../tests/query-engine-v2/upsert-family-behavior.ts), which is wired on **every** driver leg, so the folded shape's answer is certified on SQLite3, LibSQL, PGlite, Docker PostgreSQL **and Docker MySQL** — the dialect the door is closed to, where the same payloads must answer identically through the unchanged probe path.

**One pinned baseline moved, deliberately.** `batch-round-trip-baseline.test.ts`'s *"a scalar upsert update-arm costs two"* was Phase 6's measurement of this exact shape. It now costs ONE, which is this decision's deliverable, so the number moves with it and the round-trip KIND is pinned alongside (one round trip would also be true of an operation that planned nothing and wrote nothing). A second test was added holding the OLD number for an upsert the door excludes, so Phase 6's baseline is still measured on a shape that still has it. No pinned SQL in `tests/query-engine/sql-generation.test.ts` changed — it holds no root-upsert pin.

**Gate.** `npx tsc --noEmit` (5.9.3) clean. `pnpm test:gates` **72 passed**, census unchanged. Repo-pinned `npx biome check` clean on all changed files. Suites in this worktree, 0 failures: `tests/query-engine-v2` **1108** (59 files), `tests/query-engine` + `tests/adapters` **2339** (110 files), `tests/drivers/sqlite3` + `tests/drivers/libsql` **2240**, `tests/drivers/pglite` + `tests/drivers/libsql` **1833**. No error message, error attribution or race protection was removed. `OperationFragment.ts` is byte-identical. The Docker MySQL (3307) and PostgreSQL (5434) legs belong to the gate agent; the four cross-dialect cases are wired on both.

### Decision 7.2 — Multi-row `INSERT … RETURNING` for `createMany` with select

The per-row emission exists for an exact input ordinal ([`create.ts:116-119`](../../src/query-engine/operations/create.ts); [`ManyAndReturnOperation.ts:451-467`](../../src/query-engine-v2/ManyAndReturnOperation.ts)). One multi-row statement replaces N statements. PostgreSQL does not contractually guarantee the RETURNING row order. The choice: accept the implementation guarantee (Prisma does), or match the returned rows by key.

#### DISPOSITION — TAKEN. Accept the implementation order (2026-08-03)

**The decision.** Fold. `createMany` with a `select` now emits ONE multi-row `INSERT … VALUES (…),(…),(…) RETURNING …` per contiguous same-shape run of input rows, on every driver that has a RETURNING clause. The returned rows map to the run's input rows POSITIONALLY. The rows are not matched back by key.

**The guarantee being trusted, and its bound.** Neither the SQL standard nor the PostgreSQL manual orders a `RETURNING` result. What is relied on is the implementation behaviour of a single `INSERT` over a literal `VALUES` list: the executor's ModifyTable node pulls rows from the VALUES scan in the order they are written and projects each row's RETURNING list as it inserts it, so the result rows arrive in VALUES order. **The bound is exactly that shape:** one `INSERT` whose source is a literal `VALUES` list; no `INSERT … SELECT` (whose source may be reordered by the planner), no parallel plan (PostgreSQL never parallelises the source of a data-modifying statement), no `ORDER BY`, no `ON CONFLICT DO UPDATE` re-processing. The emitter builds no other INSERT shape, so nothing in the engine can leave the bound without a source change. This is the same stance Prisma takes for `createManyAndReturn`. SQLite is inside the same bound for the same reason.

**Measured, before and after, PGlite (PostgreSQL 17) and SQLite3.** `createMany({ data: [4 rows], select })`: four `INSERT … RETURNING` statements became ONE. The result is byte-identical. A payload whose input order disagrees with every storage order — descending primary keys `40,10,30,20` and non-monotonic unique values — comes back in input order on both dialects, from the folded statement and from a bare `INSERT … VALUES (90,'a'),(10,'b'),(50,'c'),(1,'d') RETURNING` probe alike.

**`skipDuplicates` is IN the fold, and the contract it pins.** `INSERT … VALUES (…),(…) ON CONFLICT DO NOTHING RETURNING` was measured on PGlite and SQLite against a payload carrying both a collision with a pre-existing row and a collision BETWEEN two rows of the same statement. Both dialects skip both and return only the inserted row. That is exactly what the per-row path produced, statement for statement, because the operation's answer is a row LIST, not an input-indexed slot map: a skipped row is ABSENT from the result and does not shift the rows that survive. The `createMany … select` result has always been "the rows actually inserted, in input order" — the existing driver witness at [`implicit-returning-behavior.ts`](../../tests/drivers/implicit-returning-behavior.ts) already returned one row for two inputs. The fold keeps that contract and now spends one statement on it. The refusal for `skipDuplicates` + `select` on a NON-returning driver is untouched.

**What did not change.** MySQL — no RETURNING clause — keeps its documented path byte-identically: one `INSERT` per input row, each interleaved with the refetch that reads the created identity back, because that refetch needs one INSERT to address. `buildCreateManyPlan` splits a run into rows for exactly two reasons now, both named in its doc comment: that non-returning refetch, and the `recoverableUniqueError` skip strategy (each row behind a savepoint). The `{ count }` arm never split in the first place and is unchanged.

**The ordinal contract is guarded, not assumed.** `ManyAndReturnOperation.buildCreateManyReturn` checks that the statements' `inputIndexes` concatenate to `0 … N-1` in order before it returns the fragment. A regrouping that dropped, duplicated or reordered a row fails closed there instead of returning a plausible row list addressed to the wrong inputs.

**One authorised test retarget.** `tests/query-engine/bulk-insert-row-shapes.test.ts` asserted that ANY multi-row return refuses on a driver with neither transactions nor atomic batch, because N statements cannot be made atomic. A folded same-shape payload is ONE statement and is atomic by itself, so it must not be refused. The test now asserts both halves: the same-shape payload runs, and a two-shape payload — still two statements — still gets the unchanged refusal message.

**Witnesses.** [`tests/drivers/create-many-return-fold-behavior.ts`](../../tests/drivers/create-many-return-fold-behavior.ts), wired on all five driver legs (pg, PGlite, SQLite3, LibSQL, MySQL2): the statement COUNT, the input ORDER against a payload that disagrees with every storage order, the per-run split, the `skipDuplicates` contract, and MySQL's unchanged 2N interleaving. [`tests/query-engine-v2/create-many-return-fold.test.ts`](../../tests/query-engine-v2/create-many-return-fold.test.ts) pins the compiled plan shape without a database.

**Falsified.** Forcing the returning arm back to per-row statements fails five witnesses on the COUNT. Reversing the VALUES rows inside the folded statement — count unchanged at one — fails the ORDER witnesses only. Reversing a statement's `inputIndexes` makes the ordinal guard throw on every folded shape.

### Decision 7.3 — The `startsWith` spelling

The current spellings can never use an index: `LEFT(col, LENGTH($1)) = $1` on PostgreSQL ([`postgres-adapter.ts:109-110`](../../src/adapters/databases/postgres/postgres-adapter.ts)), `LEFT(BINARY col, OCTET_LENGTH(?))` on MySQL (`mysql-adapter.ts:160-161`), `substr(col,1,length(?)) COLLATE BINARY` on SQLite (`sqlite-adapter.ts:171-172`). Measured price: 54× on PostgreSQL and approximately 300× on SQLite against an indexed `LIKE 'x%'` control. The spellings also blind the PostgreSQL row estimator, which changes plan shapes. A `LIKE` spelling with escaped `%`, `_`, and escape characters is portable and index-friendly, and keeps the literal-wildcard semantics that [`prisma-parity-behavior.ts:227`](../../tests/drivers/prisma-parity-behavior.ts) pins. The choice: keep the current spelling, or move to the escaped LIKE spelling (recommendation: move; the semantics are identical and the price is now known).

**DISPOSITION (delivered): MOVE `startsWith`, per dialect. `endsWith` stays.** The maintainer's decision was to move both to "the escaped LIKE spelling". Measurement changed two things about that: the spelling is not portable, and `endsWith` has nothing to gain. What shipped is a new operator, `startsWithPrefix(column, value: string)`, taking the raw string so the adapter can escape it into its own pattern language and bind the finished pattern — a pattern assembled in SQL from the operand (`REPLACE(...) || '%'`) is non-constant and gives the range straight back. Only the default-mode, literal-string path routes to it ([`where-builder.ts`](../../src/query-engine/builders/where-builder.ts), `case "startsWith"`); a field-reference or SQL-fragment operand has no client-side string to escape and keeps `startsWithText`, losing nothing because its operand is a column.

| dialect | shipped spelling | startsWith plan, 20k rows + plain index | why not plain escaped LIKE |
| --- | --- | --- | --- |
| PostgreSQL | `col LIKE $1 ESCAPE '\'` | **only on a C-collated database**: `LEFT(...)`: Seq Scan, 20000 → **Bitmap Index Scan, 111**. On a default-locale cluster both spellings Seq Scan and what improves instead is the row estimate — see the precondition below | it *is* the escaped LIKE; `LIKE` is case-sensitive natively |
| SQLite | `col GLOB ?` | `substr(...)`: SCAN, 20000 → **index SEARCH, 111** | escaped LIKE is *also* a SCAN here, and answers case-insensitively |
| MySQL | `(col LIKE ? ESCAPE '\\' AND LEFT(BINARY col, OCTET_LENGTH(?)) = BINARY ?)` | `LEFT(BINARY ...)`: full `index` scan, 20248 → **`range`, 111** | LIKE alone is collation-dependent, so it cannot carry the contract on a table viborm did not create |

**The PostgreSQL row's precondition is the database collation, and the project's own PostgreSQL does not meet it.** The `Bitmap Index Scan` above was measured on PGlite, which reports `datcollate = 'C'`; under `C` a plain btree stores raw byte order, so `match_pattern_prefix` can hand the index `title >= 'name123' AND title < 'name124'`. Re-measured on `viborm-pg-test-2` (postgres:16, port 5434 — the leg [the Rules](#rules-for-the-work) make mandatory), `datcollate = en_US.utf8`, same 20k rows, same plain btree index:

| statement | plan on `en_US.utf8` |
| --- | --- |
| `title LIKE 'name123%' ESCAPE '\'` (shipped) | `Seq Scan (cost=0.00..378.00 rows=202)` |
| `LEFT(title, LENGTH('name123')) = 'name123'` (replaced) | `Seq Scan (cost=0.00..428.00 rows=100)` |
| shipped, after `CREATE INDEX … (title text_pattern_ops)` | `Bitmap Index Scan`, `Index Cond: ((title ~>=~ 'name123') AND (title ~<~ 'name124'))` |

viborm can never emit that third index: [`generateCreateIndex`](../../src/migrations/drivers/postgres/index.ts) writes `CREATE [UNIQUE] INDEX name ON table [USING type] (cols) [WHERE …]` and has no opclass in its vocabulary. So on any cluster `initdb`'d with a non-`C` locale — the default, and what this project's container uses — **7.3 buys PostgreSQL no index range at all.** The `54×` in the problem statement above is a ratio against an *indexed* `LIKE 'x%'` control and therefore carries the same precondition.

**What survives without the collation, and why the spelling still stands.** The estimator half is real, and larger than the `202` against a true `111` suggests. Measured on the same `en_US.utf8` table, sweeping the prefix width:

| prefix | true rows | `LIKE` estimate | `LEFT(...)` estimate |
| --- | --- | --- | --- |
| `name123%` | 111 | 202 | 100 |
| `name12%` | 1111 | 1010 | 100 |
| `name1%` | 11111 | 11111 | 100 |
| `name%` | 20000 | 19998 | 100 |

`LEFT(...)` is an opaque function call, so the planner falls back to a flat 0.5% guess at *every* width — off by 111× at `name1%` — and that estimate propagates: the same join reads `rows=11111` under the shipped spelling and `rows=100` under the one it replaced. **ACCEPTED as shipped:** the predicate is exact everywhere, ranges wherever the collation or an operator-class index allows, and on the measured non-`C` leg costs less than what it replaced (378 vs 428) while never planning worse. Nothing is reverted.

**Recorded residual (open, not fixed here): a `text_pattern_ops` companion index would make the range unconditional.** It is deliberately out of 7.3's scope because it is a Phase-1 emitter change with its own costs and its own decision: it doubles the index count on every indexed string column (storage and write amplification on tables that never filter by prefix), and to stay fail-closed the differ would have to read the opclass back through [`postgres/introspect.ts`](../../src/migrations/drivers/postgres/introspect.ts) or re-create the companion on every push — the same shape as the churn Decision 7.4 is about. Whether to spend that belongs to the maintainer, not to a spelling decision.

**Where the "portable escaped LIKE" premise failed — SQLite.** Both preconditions of SQLite's LIKE optimization are violated at once: an `ESCAPE` clause disqualifies it outright, and with `case_sensitive_like` off (the default, and connection-global, so not ours to set) it additionally wants a NOCASE-collated index while `push()` only ever emits BINARY ones. Measured on better-sqlite3: `col LIKE ? ESCAPE '\'` is a `SCAN` — no better than the `substr` spelling it would have replaced — *and* it answers case-insensitively, so it would have broken the pinned case-sensitivity contract for nothing. `GLOB` has neither problem: it compares bytes (case- and accent-sensitive by construction, which is what the dropped `COLLATE BINARY` bought) and it ranges on the ordinary BINARY index. Its wildcards are `*`/`?`/`[` and it has no `ESCAPE` clause, so they are quoted as one-character classes (`escapeGlobLiteral`).

**MySQL is two conjuncts, and the second one's coverage is nameable.** No single MySQL predicate is both exact and index-usable, because the index stores the column's own collation's sort keys and any comparison forced to `BINARY` cannot range on it. So the collation-native `LIKE` leads as an index accelerator and the `BINARY` predicate — byte-identical to `startsWithText` — follows as the semantics. The accelerator can never drop a row the `BINARY` conjunct keeps (byte-equal strings compare equal under every collation), so it decides no row's membership, only how many rows the server examines. Its partner is not redundant either, and the reason is specific: viborm's own DDL declares `COLLATE=utf8mb4_0900_bin` ([`mysql/index.ts:298`](../../src/migrations/drivers/mysql/index.ts)), so on a `push()`-created table `LIKE` is already byte-exact and the conjunct changes no answer — but on a table viborm did not create, carrying MySQL's default `utf8mb4_0900_ai_ci`, it is the whole of the adapter header's promise that "portable string filters override the database collation explicitly". Witnessed live at [`mysql2.test.ts`](../../tests/drivers/mysql2.test.ts), "prefix predicate on a collation viborm did not choose": on an `ai_ci` column the accelerator alone returns 3 rows where the shipped conjunction returns 1.

**`endsWith` did not move, and the plan's second argument for moving it did not survive.** No dialect can range an index on a suffix, so the spelling change buys nothing there. The "blinds the row estimator" claim is real for `startsWith` (PG estimates 202 against a true 111, versus a flat 100 for `LEFT`) but *inverts* for `endsWith`: against a true 2000, `RIGHT(col, LENGTH($1)) = $1` estimates 100 and `col LIKE '%…'` estimates 2 — the LIKE spelling is the worse estimate. Both seq-scan. Moving it would have been churn carrying real escaping risk, so `endsWith`, `contains`, insensitive mode, the JSON-path operand and the field-reference operand all keep their existing spellings unchanged.

**One thing the falsification could not break, recorded rather than claimed.** Dropping the `ESCAPE '\'` clause from the PostgreSQL predicate fails no witness: backslash is already PostgreSQL's default `LIKE` escape character, so the clause restates the default. It is kept for uniformity with the sibling `like`/`notLike`/`ilike` operators, which all carry it, and because it pins the escape character against a server default rather than inheriting one — not because it is load-bearing here. What *is* load-bearing is the client-side escaper: neutering `escapeLikeLiteral` fails four witnesses on PostgreSQL, and neutering `escapeGlobLiteral` fails the GLOB-metacharacter witness on SQLite. On MySQL a neutered `escapeLikeLiteral` fails only the two backslash cases — the `%`/`_` cases are absorbed by the `BINARY` conjunct, since over-permissive wildcards leave the accelerator a superset while a mis-escaped backslash does not. Dropping the `BINARY` conjunct fails the `ai_ci` witness above.

**Pinned SQL updated deliberately** in [`starts-with-prefix-sql.test.ts`](../../tests/query-engine/starts-with-prefix-sql.test.ts) (three dialects, plus the complements proving `startsWith` is the only operation that moved) and the index-range claim is re-run as a test in [`starts-with-prefix-plan.test.ts`](../../tests/query-engine/starts-with-prefix-plan.test.ts), which asserts both halves: the new spelling ranges and the old one scans. That file is split by substrate for the reason above — its PGlite describe now asserts `datcollate = 'C'` before claiming anything, so it can never silently certify the general case, and a second describe gated on `PG_TEST_CONNECTION_STRING` pins the `en_US.utf8` truth (neither spelling ranges; the estimate is what survives; only `text_pattern_ops` restores the range). The file is wired into `pnpm test:pg` so it runs on the mandated leg rather than only where the claim happens to hold. Adversarial values (`50%`, `a_b`, `x\`, escape-char-only, empty, `a%b_c\d`, plus `*`/`?`/`[`) run live on all four drivers in [`like-escape-behavior.ts`](../../tests/drivers/like-escape-behavior.ts).

**Re-gated after the collation correction** (2026-08-03, main checkout, branch `nested-write-boundaries`, on top of `db9d975`). No production behavior changed — the correction is to the claim, the adapter comment, and the witness's substrate coverage. `tsc` 5.9.3 clean; full estate **9480 passed, 0 failed** (2163 skipped, 268 files) run alone; `pnpm test:gates` **72 passed**, census pin unchanged; `npx biome check` (2.3.11) clean on all three changed files; Docker MySQL 3307 **1016 passed, 0 failed**; Docker PostgreSQL 5434, now including the wired-in plan witness, **1135 passed, 0 failed**, 14 skipped. Each new assertion was falsified individually: pinning PGlite's expected collation to `en_US.utf8` fails the precondition test (so it reads the real value, not a constant); routing the tracking assertions at `LEFT(...)` fails the estimator test (so the claim is about the shipped spelling); and dropping `text_pattern_ops` from the companion index leaves a `Seq Scan` (so it is the operator class that restores the range, not merely a second index).

### Decision 7.4 — The PostgreSQL partial-index predicate (raised by Phase 2)

Phase 2 fixed the partial index on SQLite, where the catalog stores the statement verbatim. PostgreSQL does not: `pg_get_expr(indpred, indrelid)` deparses the predicate, so a declared `active = true` reads back as `(active = true)` and never compares equal to what the serializer holds ([`postgres/introspect.ts:302`](../../src/migrations/drivers/postgres/introspect.ts) into `indexesEqual`, [`differ.ts`](../../src/migrations/differ.ts)). Measured on PGlite (PostgreSQL 17). **Consequence: every push drops and re-creates every partial index on PostgreSQL.** No client-side text normalization closes this while staying fail-closed — flattening whitespace and parentheses makes `a AND (b OR c)` equal `(a AND b) OR c`, so a real predicate change would stop being seen. The choice: canonicalize the declared predicate through the database before comparing (the differ has no connection today, so this changes the differ's shape), compare `indpred` structurally, or accept the churn and document it. The disposition must state which.

---

## Wave gate — Phase 7 (Decisions 7.1, 7.2 and 7.3)

**Run:** 2026-08-03, main checkout, branch `nested-write-boundaries`, tip `d523808` — nine
commits from `7240208` (the per-dialect prefix predicate) through `d523808` (the collation
correction). Baseline for every number below is `d28c339`, the Phases 4/6 wave-gate tip.

### The legs

| Leg | Result | Baseline |
| --- | --- | --- |
| `pnpm test:types` (tsc 5.9.3) | clean | clean |
| full estate, `npx vitest run --minWorkers=1 --maxWorkers=4`, run alone | **9480 passed, 0 failed**, 2163 skipped (268 files, 4 skipped) | 9338 / 0 |
| `pnpm test:gates` | **72 passed** (5 files); census pin 39, unchanged | 72 |
| repo-pinned `npx biome check` (2.3.11) per changed file | **clean — zero diagnostics** on all 14 TypeScript files in the diff | — |
| Docker MySQL 8, port 3307 | **1016 passed, 0 failed** | 993 |
| Docker PostgreSQL, port 5434 | **1135 passed, 0 failed**, 14 skipped | 1110 |

The PostgreSQL leg is three files now, not two: 7.3 wired
`tests/query-engine/starts-with-prefix-plan.test.ts` into `pnpm test:pg`, because its
`en_US.utf8` claims can only be made on the container. That is the one `package.json` edit
in the wave.

**The named witnesses, executed by name at the gate.**

- 7.1's *MySQL-unchanged* witnesses — `MySQL2 transaction upsert family` and
  `MySQL2 atomic batch upsert family`, four each: *the create arm writes the row and answers
  it*, *the update arm mutates the existing row and answers it*, *running it twice converges*,
  *an UNRELATED unique collision is a constraint error on every dialect*. Eight passed, on the
  dialect the door is CLOSED to, through the untouched probe path.
- 7.3's *BINARY-preserving* witnesses — `MySQL2 Driver > prefix predicate on a collation
  viborm did not choose`: *the accelerator alone would answer case-insensitively* and *the
  shipped conjunction keeps the case-sensitivity contract*. Both passed on the `ai_ci` column.
- 7.2's fold on the non-returning dialect — `MySQL2 createMany select fold`, three tests
  including the unchanged interleaved refetch path.
- 7.3's plan file, all 14 tests, including the `default-locale substrate` describe that only
  runs when the container is present.

### Measured at the gate, not copied

Taken independently at the tip through the PGlite `execute`/`executeRaw` seam (which sees
both substrates) and, for 7.3, straight through `pg` against the Docker container — on a
schema written for this reading rather than on the witness files' own.

**7.1 — statements for a top-level scalar upsert.** Every "after" number in the disposition
reproduced exactly:

```text
upsert → create arm    transaction     1 statement    (ON CONFLICT … DO UPDATE … RETURNING)
upsert → update arm    transaction     1 statement
upsert → create arm    atomic batch    1 statement
upsert → update arm    atomic batch    1 statement
```

**7.1 — the ACCEPTED divergence, re-measured.** One update-arm upsert against the same
identity sequence, the path selected by the gate's own `supportsTargetedUpsert` lever:

| path | `p7g_gauges_id_seq.last_value` delta |
| --- | --- |
| folded (`INSERT … ON CONFLICT DO UPDATE`) | **+1** |
| probe-first (the shipped pre-7.1 sequence) | **+0** |

That is DIVERGENCE 1 exactly as the disposition states it: the folded statement evaluates the
INSERT's defaults before it detects the conflict, so an update that changes nothing about the
identity column still burns one sequence value. Both dialects document their sequences as
non-gap-free.

**7.2 — statements for `createMany` with `select`.**

```text
4 same-shape rows        1 statement    rows answered in INPUT order (m1,m2,m3,m4)
2 + 2 shapes (id given
  on the last two)       2 statements   one per contiguous same-shape run
```

One reading worth recording, because it is not obvious from the disposition: a NULLABLE column
that some rows omit does **not** split the run — the payload normalizes to one shape and folds
into a single statement. What splits a run is a genuinely different column set, which here
means naming the generated primary key on some rows and not others.

**7.3 — the estimator table, re-measured on the mandated leg.** 20,000 rows, plain btree, on
`viborm-pg-test-2`; the collation was read from the server (`en_US.utf8`) rather than assumed:

| prefix | true rows | shipped `LIKE … ESCAPE` estimate | replaced `LEFT(...)` estimate |
| --- | --- | --- | --- |
| `name123%` | 111 | 202 | 100 |
| `name12%` | 1111 | 1010 | 100 |
| `name1%` | 11111 | **11111** | 100 |
| `name%` | 20000 | 19998 | 100 |

Both spellings seq-scan on this cluster, as 7.3's own correction says. The shipped spelling
costs `0.00..378.00` against the replaced spelling's `0.00..428.00`, so it never plans worse,
and its estimate tracks the data at every width while `LEFT(...)` stays flat at the planner's
0.5 % guess. Every number in the disposition's table reproduced to the digit.

### Standing rules

`src/query-engine-v2/OperationFragment.ts` is byte-identical to `d28c339` — the frozen step
vocabulary did not grow; the file is not in the wave's diff at all. `tests/query-engine/sql-
generation.test.ts` is not in the diff either, so no pin in it moved; the pins 7.3 updated
deliberately live in its own `starts-with-prefix-sql.test.ts`, and the one baseline 7.1 moved
is named in its disposition. No error message and no error attribution was removed: the two
`throw new QueryEngineError` hunks the `src` diff deletes are both RELOCATIONS inside
`ManyAndReturnOperation` — the per-statement input check moved below the returning arm, and
the ordinal check's message survives as *"…left an input row without a result in its input
ordinal."* No race protection was removed: `racePin`/`presenceGuard` occurrences in
`UpsertOperation.ts` number the same at the tip as at the baseline (17), and 7.1's absent
`racePin` on the folded step is discharged by the database, which its disposition measures
against a live competitor on its own connection.

**Open and recorded, not fixed here:** Decision 7.4 (the only Phase 7 decision still awaiting
the maintainer), 7.1's atomic-arithmetic residual (`{ count: { increment: 1 } }` keeps the
probe path, because `DO UPDATE SET` cannot spell the emitter's `col = col op x`), and 7.3's
`text_pattern_ops` companion index, which would make the PostgreSQL range unconditional and
is a Phase-1 emitter decision with the same churn shape as 7.4.

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

```text
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
