# Batch-Planner Engine — Semantic Map

> **Historical snapshot.** This map documents the deleted pre-unification engines and is not the current runtime contract. `DESIGN.md` and the conformance/behavior suites are authoritative.

Scope of this map: the batch-planner engine for drivers without interactive
transactions. Files:

- `batch-plan.ts` — top-level entry, per-record create/update/upsert planning, PlanState assembly, statement ordering.
- `batch-relations.ts` — relation-level dispatch (FK-holding relations), correlated child updates.
- `batch-relation-links.ts` — connect/disconnect/delete/set on FK relations (link-only, no child creation).
- `batch-many-to-many.ts` — junction-table planner.
- `batch-references.ts` — `PlanState`, `BatchReferenceStore`, value-refs, record-refs, statement collection.
- `batch-updated-primary-keys.ts` — primary-key-change tracking across UPDATEs (literal vs computed).
- `assertions.ts` — plan-time guard emission (`appendAssert*`), plus a few tx-shared helpers.
- `atomic-runner.ts` — dispatcher deciding tx-vs-batch-vs-error.
- Shared (consulted, not owned): `semantic-plan.ts`, `record-access.ts`, `fk.ts`, `set.ts`, `update-plan.ts`, `planned-mutation.ts`, `many-to-many.ts` (its exported helpers `buildConnectedUniqueWhere`, `fetchConnectedTargetPks`), `many-to-many-utils.ts`.
- Substrate: `src/adapters/shared/batch-refs.ts` + `BatchReferenceSqlAdapter` + `adapter.assertions.{exists,notExists}`.

Anchor commit: branch `prisma-parity`. Line numbers are indicative.

---

## 0. Substrate model — what a batch is, and why it differs

A batch driver (`supportsBatch && !supportsTransactions`) executes a flat,
ordered list of prepared SQL statements as one atomic unit (the driver wraps
them however it can; the conformance test's `BatchOnlyPGliteDriver` wraps them
in a real PG transaction and runs them sequentially). The batch engine gets
**one shot**: it emits the entire statement list *before* any of it runs. Three
consequences shape everything:

1. **Execution-generated values (DB ids) are unavailable at plan time.** They
   are represented as `BatchValueRef` symbols and lowered to SQL subqueries that
   read them back from a scratch key/value table at execution time
   (`adapter.batchRefs`). See §3.

2. **Branch decisions that the tx engine makes at runtime (does the upsert
   target exist? did connectOrCreate find a row?) must be decided at PLAN
   time.** The planner issues **eager reads** against the *current committed
   state* (via `driver._execute`, outside the batch, before the batch runs) and
   picks a branch. Because state can change between plan-time read and batch
   execution, each such branch is protected by a **guard**: an
   `assertions.exists` / `assertions.notExists` statement placed at the point in
   the batch where the premise must still hold. If the premise went stale, the
   guard raises a DB error and the whole atomic batch rolls back. This is the
   **explicit staleness contract** (§5).

3. **Ordering is fixed at plan time** and must respect FK direction so no
   statement references a row that does not yet exist / references a column not
   yet populated. See §4.

`atomic-runner.ts` never actually runs the batch — it is the tx-path dispatcher.
The real batch dispatch is in `transaction-flow.ts:runNestedWriteOperation`:
when `!supportsTransactions && supportsBatch && isNestedBatchOperation`, it calls
`executeNestedWriteBatch`. `atomic-runner.runNestedMutationAtomically` throws a
typed `QueryEngineError` (`strategy: "batch"`) if a batch-capable driver ever
reaches the tx-only path — a defensive invariant that the two paths never cross.

---

## 1. PlanState — the mutable accumulator (`batch-references.ts`)

`PlanState` is the plan being built:

```
batchId: string                       // unique per top-level operation
statements: Sql[]                     // the ordered body (writes/reads/guards)
setupStatements: Sql[]                // prepended: create scratch table, clear batchId rows
cleanupStatements: Sql[]              // appended: delete scratch rows for batchId
references: BatchReferenceStore       // value-ref allocator + record-ref registry
registerProducedPrimaryKeyRef(model, record) -> BatchRecordRef
```

`collectPlanStatements` produces the final flat list: `[...setup, ...body,
...cleanup]`. The **result-parse window** (`buildNestedWriteBatchPlan`) slices
results by `setupStatements.length` so the `parse` closure indexes into the body
statements only, ignoring setup/cleanup rows. This is a load-bearing coupling:
setup count offsets the result index of the final `findUnique`.

### 1.1 `BatchReferenceStore` lifecycle

- `allocateValueRef()` returns `{kind:"batchValueRef", batchId, key:"ref_N"}`.
  First allocation triggers `initialize()`, which (if the adapter supports batch
  refs) pushes into setup: `adapter.batchRefs.setup(batchId)` (CREATE TABLE IF
  NOT EXISTS the scratch table) + `adapter.batchRefs.clear(batchId)` (DELETE any
  stale rows for this batchId); and into cleanup: `adapter.batchRefs.cleanup(batchId)`.
  If no ref is ever allocated (fully-static plan, all PKs known), no scratch
  table is touched at all.
- `registerProducedPrimaryKeyRef(model, record)` builds a `BatchRecordRef`:
  for each PK field, if `record[field]` is already a concrete value it is used
  literally; otherwise a value-ref is allocated and recorded in
  `primaryKeyRefs` (these become "store the produced id" statements later). The
  returned `primaryKey` map mixes literals and value-refs — this is the key
  abstraction: **a record identity that is partly known, partly deferred.**

### 1.2 Value lowering

`lowerBatchResolvableValue(adapter, value)`: if value is a `BatchValueRef`,
returns `adapter.batchRefs.read(batchId, key)` — a scalar subquery `(SELECT
value FROM scratch WHERE batch_id=? AND key=? LIMIT 1)`. Otherwise returns the
value untouched. This is invoked implicitly wherever a resolvable value flows
into SQL via `buildScalarSqlValue` (values-builder recognises the ref shape).

---

## 2. Batch-ref adapter contract (`adapters/shared/batch-refs.ts`)

Shared factory producing a `BatchReferenceSqlAdapter`:

| method | SQL | purpose |
|---|---|---|
| `setup(batchId)` | `CREATE TABLE IF NOT EXISTS scratch(...)` | scratch storage exists |
| `clear(batchId)` | `DELETE FROM scratch WHERE batch_id=?` | drop stale rows for this batchId at start |
| `cleanup(batchId)` | same DELETE | drop rows at end |
| `store(batchId,key,valueSql)` | UPSERT into scratch (`ON CONFLICT`/`ON DUPLICATE KEY`) | persist a computed value under key |
| `read(batchId,key)` | `(SELECT value ... LIMIT 1)` | scalar subquery reading a stored value |
| `storeLastInsertId(batchId,key)` | `store(batchId,key,lastInsertId())` | persist the auto-increment id the previous INSERT produced |

Postgres uses `ON CONFLICT ... DO UPDATE`; MySQL uses `ON DUPLICATE KEY UPDATE`.
`castValue`/`lastInsertId` are dialect hooks. This is the entire "symbol table"
substrate: value-refs are keys, the scratch table is the store, `read` lowers a
symbol to a subquery, `store`/`storeLastInsertId` are the two ways a symbol gets
a value.

---

## 3. Guard mechanism (`assertions.ts` + `adapter.assertions`)

Guards are the batch engine's stand-in for tx-time branch conditions and
"row must exist / must not exist" checks. Two adapter primitives:

- `adapter.assertions.exists(query)` — Postgres: `SELECT 1 / CASE WHEN EXISTS
  (query) THEN 1 ELSE 0 END`. If the query returns no rows, division by zero
  raises, aborting the batch. MySQL: `SELECT CASE WHEN EXISTS(query) THEN 1 ELSE
  JSON_EXTRACT('x','$') END` (the else branch is an invalid JSON path that
  errors). SQLite: analogous.
- `adapter.assertions.notExists(query)` — inverted.

`assertions.ts` wrappers:

- `appendAssertUniqueExists(state, ctx, model, where)` — build where-unique SELECT-1, push `exists`.
- `appendAssertUniqueMissing(...)` — push `notExists` on where-unique SELECT-1.
- `appendAssertWhereExists(state, ctx, model, whereClause: Sql)` — arbitrary Sql where, push `exists`.
- `appendAssertWhereMissing(...)` — push `notExists`.
- `buildSelectOne` builds `SELECT 1 FROM table WHERE <clause> LIMIT 1`.

Semantics of a guard: **it is a no-op on success and a whole-batch abort on
failure.** It carries no data; it only certifies a precondition still holds at
its position in the ordered statement list.

`assertions.ts` also hosts tx-shared helpers that are NOT batch-specific:
`assertUniqueRecordsExist`, `throwIfNoCorrelatedRowsAffected`,
`assertFkCanBeSetNull`, `getNonNullableFkFields`, `normalizeUniqueInputs`,
`assertSingleRelationInput`. These are pure predicate/error helpers used by both
engines — the batch engine uses the `append*` family; the tx engine uses the
`assert*`/`throwIf*` family.

---

## 4. Top-level operations (`batch-plan.ts`)

`prepareNestedWriteBatch` / `executeNestedWriteBatch` are the entry points. Two
modes:

- **Fresh top-level** (`buildNestedWriteBatchPlan`): create a new `PlanState`,
  append the operation, then `collectPlanStatements`.
- **Nested-into-existing** (`appendNestedWriteBatchPlan` with a
  `BatchPreparationContext`): reuse a shared `PlanState` stashed in
  `context.nestedWriteState`. `getSharedPlanState` validates the stash via
  structural `isPlanState`; used when a batch nested write is composed inside a
  larger batch (e.g. `executor.ts`).

The parse closure at the top level always ends with a `buildFindUnique` on the
final `where` (§4.1–4.3 each return that where), and parses via
`parseFindUniqueResult`. The final read is the returned representation.

### 4.1 create (`appendCreateRecord`)

Step sequence:

1. `separateData(ctx, data)` → `{scalarData, relations}`.
2. `assertNoPlannedNestedMutationExecution(relations, "create")` — reject
   `update`/`updateMany`/`upsert`/`deleteMany` nested inside a create branch
   (only create/createMany/connect/connectOrCreate allowed under a create).
   This is a **static** guard (throws at plan time, before any SQL). (`planned-mutation.ts`)
3. `splitRelationMutationsByFk(ctx, relations)` → `{currentHoldsFk,
   relatedHoldsFk}`. M2M always goes to `relatedHoldsFk` (junction rows written
   after the parent exists). (`semantic-plan.ts`)
4. `getBatchPrimaryKeyRef(state, model, scalarData, "create")` — compute the
   record-ref. If all PK values are known → literal record-ref, no value-ref.
   If a single PK field is an auto-increment (undefined or the sentinel
   `isGeneratedIncrementDefault`), it is deleted from the insert data and a
   value-ref is registered for it. **Errors** (`NestedWriteError`, "requires
   primary key field '..' to be known before execution") if a PK is unknown and
   not a single auto-increment, or if generated + compound PK (cannot propagate
   generated compound PKs).
5. **before-parent** loop over `currentHoldsFk`: for each,
   `appendBeforeParentCreateRelation` (§6.1). These must run first because the
   parent row's FK columns are populated *from* the related row's PK. It mutates
   `scalarData` in place (assigns FK values into it).
6. `appendInsert(state, ctx, ctx.model, scalarData)` — the parent INSERT.
7. `appendGeneratedPrimaryKeyStores(state, ctx, recordRef)` — for each PK
   value-ref, push `adapter.batchRefs.storeLastInsertId(batchId, key)` so the
   generated id is captured immediately after the INSERT.
8. **after-parent** loop over `relatedHoldsFk`: for each,
   `appendRelationMutation(..., recordRef.primaryKey)` (§6.2). These run after
   the parent row exists because they write the parent's PK into the child's FK
   column (or into junction rows).

Values flowing between steps: `recordRef.primaryKey` (mix of literals + refs) is
the parent identity threaded into every after-parent relation. `scalarData` is
mutated by before-parent relations to carry the FK to the parent INSERT.

### 4.2 update (`appendUpdateRecord`)

1. `separateData`; `assertNestedUpdatePlanIsExecutable(ctx, relations)` — a
   **deep static** validation walking every nested step to reject anything the
   batch engine can't lower (§7).
2. **Eager read**: `fetchRequiredUniqueRecord(driver, ctx, model, where, ...)` —
   reads the parent row NOW (outside the batch). Throws `nested-write` not-found
   if absent. This read yields concrete PK values used as literals downstream.
3. `appendAssertUniqueExists(state, ctx, model, where)` — guard: the parent must
   still exist when the batch runs. (staleness guard for the eager read.)
4. `getBatchUpdatedPrimaryKeyRef(state, ctx, parentRecord, scalarData, "update")`
   — compute the post-update identity (§8). If scalarData changes a PK, this is
   where literal-vs-computed is decided and value-refs/stores are set up.
5. If `scalarData` non-empty: push `buildUpdate(ctx, {where, data:scalarData})`
   then `appendUpdatedPrimaryKeyStores` (persist any computed PK).
6. `updatedParentData = {...parentRecord, ...updatedRecord.primaryKey}` — the
   parent identity after update (literals from the read overlaid with the
   possibly-changed PK). Threaded into each relation via `appendRelationMutation`.
7. Return `updatedRecord.primaryKey` for the final findUnique.

### 4.3 upsert (`appendUpsertRecord`) — the richest branch resolution

1. **Eager read**: `fetchOptionalUniqueRecord(driver, ctx, model, where)`.
2. **If existing** (update branch):
   - `appendAssertUniqueExists` guard (parent still there).
   - `pkWhere = getStaticPrimaryKeyWhere(model, existingRecord, "upsert")` —
     PK must be fully known (errors if a PK is null/undefined/Sql).
   - Optional **targetWhere** / **setWhere** refinements: if
     `args.targetWhere` has keys, eager-read
     `fetchOptionalUniqueWithWhereRecord(pkWhere ∧ targetWhere)` →
     `targetWhereMatched`. Same for `setWhere`, but only evaluated if
     `targetWhereMatched !== false` (short-circuit).
   - `planExistingUpsertBranch({...})` (`semantic-plan.ts`) computes an
     `ExistingUpsertBranch`:
     - `targetWhereSkipped` — targetWhere present but not matched → emit a
       `uniqueWithWhereMissing` guard and RETURN `pkWhere` (no update). Meaning:
       "the row exists but doesn't satisfy targetWhere; do nothing; and assert at
       batch time it still doesn't satisfy it."
     - `setWhereSkipped` — analogous for setWhere.
     - `update` — proceed to update, carrying optional `targetWhereGuard` /
       `setWhereGuard` (`uniqueWithWhereExists`) asserting the refinement still
       holds.
   - Non-update branches: `appendPlanGuard(state, ctx, branch.guard)` then
     return early. `appendPlanGuard` maps a `NestedWriteGuard` kind to the right
     `appendAssert*` (uniqueExists/uniqueMissing/uniqueWithWhereExists/
     uniqueWithWhereMissing; the latter two build `buildUniqueWithWhere`).
   - Update branch: emit `targetWhereGuard`/`setWhereGuard` if present, then
     `appendUpdateRecordFromExisting` (a variant of §4.2 that skips the eager
     read — it already has `existingRecord` — and uses `pkWhere`).
3. **If not existing** (create branch):
   - `appendAssertUniqueMissing(state, ctx, model, where)` guard — the row must
     STILL be absent when the batch runs (staleness guard: if a concurrent
     writer inserted it, the create branch's INSERT would violate uniqueness and
     the batch aborts; the guard makes the failure explicit and early).
   - `appendCreateRecord(driver, state, ctx, args.create)` (§4.1).

`getStaticPrimaryKeyWhere` and `getBatchPrimaryKeyRef` both enforce the
batch-only constraint: **primary keys entering the plan as literals must be
known before execution** (except a single auto-increment, which is deferred via
a value-ref). This is the core limitation the tx engine does not have.

---

## 5. Staleness contract (explicit)

Every eager read the planner performs is paired with a guard at the position in
the batch where the read's conclusion is consumed. The contract:

| eager read | conclusion used for | paired guard | on staleness |
|---|---|---|---|
| `fetchRequiredUniqueRecord` (update parent) | literal PK values | `appendAssertUniqueExists` | batch aborts (parent vanished) |
| `fetchOptionalUniqueRecord` (upsert) existing? | choose update vs create branch | update: `appendAssertUniqueExists`; create: `appendAssertUniqueMissing` | batch aborts |
| `fetchOptionalUniqueWithWhereRecord` (targetWhere/setWhere) | choose skip vs update | `uniqueWithWhere{Exists,Missing}` | batch aborts |
| `fetchOptionalUniqueRecord` (connectOrCreate, §6.3) existing? | connect vs create | existing: `appendAssertUniqueExists`; missing: `appendAssertUniqueMissing` | batch aborts |
| `fetchOptionalWhereRecord` (relation upsert, §6.5) connected? | update vs create | `appendAssertWhereExists` / `appendAssertUniqueMissing` | batch aborts |
| `fetchConnectedTargetPks` (M2M filtered deleteMany/delete-all, §9) | which junction+child rows to delete | **none** | rows added between plan and execution are silently not covered |

The last row is the one **documented uncovered case**: filtered M2M deleteMany
resolves matching child PKs at plan time (the filter can't be re-evaluated after
junction rows are gone), so rows connected *after* planning but *before*
execution are not deleted. Marked with a `ponytail:` comment in
`batch-many-to-many.ts:528`. Everything else fails closed (aborts) rather than
diverging silently.

The contract's guarantee: **the batch either produces exactly the state the
plan-time reads implied, or it aborts atomically.** It never silently produces a
different state — except the one annotated M2M gap.

---

## 6. Relation dispatch (`batch-relations.ts`)

Two entry points, split by timing (which mirrors FK direction):

- `appendBeforeParentCreateRelation` — used only in create's before-parent loop
  (currentHoldsFk relations). Timing `"before"`. Only create/connect/
  connectOrCreate are legal here; anything else → `throwUnsupportedNestedCreate`.
- `appendRelationMutation` — everything else. If M2M, delegate to
  `appendManyToManyMutation` (§9). Otherwise iterate
  `planRelationMutationSteps(relationName, mutation, "after")` and dispatch by
  `step.kind`.

`planRelationMutationSteps` (`semantic-plan.ts`) is the shared decomposition:
it turns a `RelationMutation` (the union of create/connect/update/... keys the
user supplied) into an ordered `NestedWriteStep[]`. **Both engines call this** —
it is the single semantic ordering of sub-operations within one relation. The
fixed order: create, createMany, connect, connectOrCreate, disconnect, delete,
set, update, updateMany, deleteMany, upsert.

### 6.1 before-parent (create's currentHoldsFk)

- `create` (must be exactly 1 input for to-one): `appendCreateRecord` on the
  child, then `assignCurrentFkValues(ctx, relationInfo, created.primaryKey,
  parentData)` — copies child PK (possibly a value-ref) into parentData's FK
  fields. The parent INSERT (step 6 of §4.1) then carries those FK values.
- `connect`: `appendAssertUniqueExists` (child must exist), then
  `Object.assign(parentData, buildConnectFkValues(...))` — FK literals from the
  connect where.
- `connectOrCreate`: `appendConnectOrCreate(..., updateCurrentRecordAfterCreate=false)`
  returns the target identity; `assignCurrentFkValues` copies it into parentData.
  (false because the parent row doesn't exist yet — FK is set via the INSERT,
  not a later UPDATE.)

### 6.2 after-parent dispatch (`appendRelationMutation` switch)

| step.kind | handler | mechanism |
|---|---|---|
| create | `appendRelationCreate` (per input) | §6.3 |
| createMany | `appendRelationCreateMany` | only when related-holds-FK; assigns parent PK into each row's FK; single multi-row INSERT; `skipDuplicates` via adapter prefix/suffix |
| connect | `appendRelationConnect` (per input, §8-links) | link-only |
| connectOrCreate | `appendConnectOrCreate(..., true)` | §6.3 |
| disconnect | `appendRelationDisconnect` | link-only |
| delete | `appendRelationDelete` | link-only |
| set | `appendRelationSet` | link-only |
| update | `appendRelationUpdate` | §6.4 |
| updateMany | `appendRelationUpdateMany` | correlated bulk UPDATE, no nested relations allowed |
| deleteMany | `appendRelationDeleteMany` | correlated bulk DELETE |
| upsert | `appendRelationUpsert` | §6.5 |

### 6.3 appendRelationCreate / appendConnectOrCreate

`appendRelationCreate`:
- related-holds-FK: `assignRelatedFkValues(childData ← parentData PK)` then
  `appendCreateRecord` (child INSERT already carries the FK).
- current-holds-FK (to-one, but reached as an "after" step, e.g. from an update):
  `appendCreateRecord` for the child, then `buildCurrentFkAssignments` from the
  created child PK and `updateCurrentRecord` — an UPDATE on the parent to set its
  FK. Ordering: child insert → parent FK update.

`appendConnectOrCreate(..., updateCurrentRecordAfterCreate)`:
- **Eager read** `fetchOptionalUniqueRecord(childCtx, targetModel, input.where)`.
- existing:
  - `appendAssertUniqueExists` guard.
  - related-holds-FK: `appendRelationConnect` (UPDATE child.FK = parent.PK), return existing.
  - current-holds-FK + `updateCurrentRecordAfterCreate`: `updateCurrentRecord`
    (UPDATE parent.FK = existing child PK). Return existing.
- missing:
  - `appendAssertUniqueMissing` guard (row still absent at batch time).
  - build child data; if related-holds-FK assign parent PK into child FK;
    `appendCreateRecord`.
  - current-holds-FK + updateCurrentRecordAfterCreate: `updateCurrentRecord` from
    created PK. Return created PK.

Note the `dedupeConnectOrCreateInputs` in `semantic-plan.ts`: repeated
connectOrCreate targets in one array are deduped by `JSON.stringify(where)` so
"first create wins". Without dedup, the batch would emit two create branches for
the same key, the second `appendAssertUniqueMissing` would fail (the first
insert made it exist) and abort — whereas the tx engine's second pass would just
connect. This dedup is an **explicit divergence-avoidance shim** (documented in
the source comment).

### 6.4 appendRelationUpdate → appendCorrelatedChildUpdate

`appendRelationUpdate` builds the correlated where clause:
- to-one: `buildFkMatchCondition` (match child by FK to parent).
- to-many: for each `{where, data}`, `combineWithParentCorrelation(fkMatch ∧
  buildWhereUnique(where))` — the child must be both unique-matched AND belong to
  this parent.

`appendCorrelatedChildUpdate` (shared by relation-update and M2M-update):
1. `separateData(childCtx, data)`; `assertNestedUpdatePlanIsExecutable`.
2. `appendAssertWhereExists(state, ctx, targetModel, whereClause)` — guard: the
   correlated child row exists.
3. `needsUpdatedPrimaryKey = hasPrimaryKeyUpdate(model, scalarData) ||
   Object.keys(relations).length > 0`. If so, **eager read**
   `fetchRequiredWhereRecord` (need concrete child identity to (a) track PK
   change, (b) thread into nested relations). Else skip the read.
4. `getBatchUpdatedPrimaryKeyRef` if a child record was read.
5. If scalarData non-empty: push a `buildSet` UPDATE on the target table by
   `whereClause`; then `appendUpdatedPrimaryKeyStores` (persist computed PK).
6. If relations non-empty: require `updatedRecord && childRecord` (else
   `NestedWriteError` "updated record state was not available"), overlay
   `{...childRecord, ...updatedRecord.primaryKey}` and recurse
   `appendRelationMutation` per nested relation.

### 6.5 appendRelationUpsert

For each input (to-one: single; to-many: array):
- Build correlated `whereClause` (as §6.4).
- **Eager read** `fetchOptionalWhereRecord(whereClause)` (is it connected/present
  under this parent?).
- present: `appendAssertWhereExists` guard, then `appendRelationUpdate` with the
  update payload (recursing to §6.4).
- absent:
  - to-many: additional **eager read** `fetchOptionalUniqueRecord(input.where)`
    (uncorrelated). If it exists uncorrelated → `NestedWriteError` "target record
    was not found for this parent" (a row with that unique key belongs to a
    *different* parent; upsert-create would violate uniqueness). Else
    `appendAssertUniqueMissing` guard.
  - `appendRelationCreate` with `input.create`.

---

## 7. Static executability validation (`update-plan.ts`, `planned-mutation.ts`)

Before emitting any SQL for update/upsert, `assertNestedUpdatePlanIsExecutable`
walks the whole nested tree and throws (plan-time, no SQL) for constructs the
batch engine cannot lower:

- `assertNestedCreateBranchesAreExecutable` — nested creates/connectOrCreate-creates
  may not themselves contain planned mutations (update/updateMany/upsert/deleteMany).
- `assertNestedUpdateBranchesAreExecutable` — recurse into nested update data.
- `assertNestedUpsertBranchesAreExecutable` — upsert.create must be create-only;
  upsert.update recurses.
- `assertNestedUpdateManyBranchesAreExecutable` / `assertUpdateManyDataHasNoRelations`
  — updateMany data may not contain nested relation writes.

`assertNoPlannedNestedMutationExecution` (`planned-mutation.ts`) is the shared
predicate: under a create/upsertCreate branch, only create/createMany/connect/
connectOrCreate are allowed; update/updateMany/upsert/deleteMany throw. **This is
also called by the tx engine** (`create.ts`), so the *rejection* set is shared —
but note the batch engine additionally rejects deeper (whole-tree walk), see §11
divergence D5.

---

## 8. Updated-primary-key tracking (`batch-updated-primary-keys.ts`)

When an UPDATE changes a PK, downstream correlations and the final findUnique
need the *new* PK, which may itself be execution-computed (e.g. `increment`).
`getBatchUpdatedPrimaryKeyRef`:

- For each PK field: `beforeValue` from the eager-read record (errors if
  unknown/null/Sql). If `data[pkField] === undefined`, PK is unchanged → literal
  beforeValue.
- Else `getUpdatedPrimaryKeyValue`:
  - plain literal or `{set: v}` → literal new value.
  - numeric op (`increment`/`decrement`/`multiply`/`divide`) on a numeric scalar
    → **computed**: `valueSql = adapter.expressions.<op>(oldSql, operandSql)`; a
    value-ref is allocated and a `computedStores` entry records `{valueRef,
    valueSql}`.
  - `push`/`unshift`/array/unsupported op on a PK → `NestedWriteError`.
- `appendUpdatedPrimaryKeyStores` emits `adapter.batchRefs.store(batchId, key,
  valueSql)` for each computed store — persisting the recomputed PK so later
  statements read it via the value-ref.

So a PK-mutating update produces: the UPDATE statement, then one `store`
statement per computed PK field; subsequent correlations reference the value-ref.
The literal-vs-computed split keeps static PK changes as plain literals (no
scratch round-trip) and only defers the genuinely-execution-dependent ones.

---

## 9. Many-to-many planner (`batch-many-to-many.ts`)

`appendManyToManyMutation` mirrors `processManyToManyMutation` (tx) statement for
statement, differing only in substrate. `assertManyToManyStepCombinationIsSupported`
(shared, `semantic-plan.ts`) rejects combining deleteMany with
create/connect/connectOrCreate/set in one nested write — because the tx engine
orders those before deleteMany while the batch resolves deleteMany at plan time,
so combining would diverge; explicitly forbidden.

`joinInfo = getManyToManyJoinInfo`; `parentValue = buildJunctionParentValue`
(the parent PK as a junction source value, may be a value-ref lowered to a read).

Per step.kind:

- **create**: `appendChildCreateWithJunctionRow` — `appendCreateRecord` for the
  child, then `buildJunctionInsert(parentValue, buildJunctionTargetValue(created
  PK))`. Child insert first, then junction row.
- **connect**: `appendAssertUniqueExists` (target exists), then
  `buildJunctionInsert(parentValue, buildTargetPkSubquery(where))`. The target PK
  is a scalar subquery on the target table (not read at plan time) — so a
  connect needs no eager read, only the existence guard.
- **connectOrCreate**: **eager read** `fetchOptionalUniqueRecord(input.where)`.
  existing → guard exists + junction insert via subquery. missing → guard missing
  + `appendChildCreateWithJunctionRow`.
- **disconnect**: DELETE junction rows. `true` → delete all source-matching
  junction rows. Else per item, delete junction rows where source matches AND
  target IN subquery. No child rows touched.
- **set**: DELETE all source junction rows, then per item `appendAssertUniqueExists`
  + junction insert via subquery. (Replace membership wholesale.)
- **delete**: `true` → `appendJunctionDeleteMany({})` (resolve all connected PKs
  at plan time). Else per item `appendJunctionDelete`.
- **deleteMany**: per filter `appendJunctionDeleteMany(filter)`.
- **update**: per `normalizeNestedUpdateInputs`, `appendCorrelatedChildUpdate`
  with `buildConnectedUniqueWhere` (child unique ∧ junction membership).
- **updateMany**: per input, UPDATE target table where `buildJunctionMembership ∧
  filterWhere`. No nested relations (`assertUpdateManyDataHasNoRelations`).
- **upsert**: per input (requires `where`), correlated
  `buildConnectedUniqueWhere`, **eager read** `fetchOptionalWhereRecord`:
  connected → `appendCorrelatedChildUpdate`. Not connected → **eager read**
  uncorrelated `fetchOptionalUniqueRecord`: exists elsewhere → `NestedWriteError`;
  else guard missing + `appendChildCreateWithJunctionRow`.

`appendJunctionDelete` (single item by where-unique): emits an `adapter.assertions.exists`
guard (the record is connected to this parent), then DELETE junction rows
referencing the target PK subquery, then DELETE the child row by its own
where-unique (no self-subquery — MySQL forbids a mutation target in its own
subquery). Junction-first so the child DELETE doesn't trip FK constraints.

`appendJunctionDeleteMany` (filtered): errors if the parent PK is a value-ref
(`Nested 'deleteMany' ... requires the parent primary key to be known before
execution`). Then **eager read** `fetchConnectedTargetPks(parentValue,
filterWhere)` — resolves matching child PKs NOW. If none, no-op. Else DELETE
junction rows for those PKs, then DELETE the children by PK IN list. **This is
the one un-guarded plan-time read** (§5, last row).

`buildJunctionDeleteCondition` handles self-referential relations: also delete
junction rows where the *source* is the deleted child.

---

## 10. Invariants any unified design MUST preserve

I1. **PK-known-before-execution constraint.** Batch plans require every primary
key entering the plan as a literal to be known at plan time, with the single
exception of one auto-increment PK field (deferred via a value-ref +
storeLastInsertId). Compound generated PKs and unknown PKs throw a typed
`NestedWriteError`. A unified IR must preserve the ability to *represent* a
partly-known identity (literal + deferred symbol) and to *reject* what cannot be
lowered.

I2. **Every branch decision is either static, or backed by a plan-time read
paired with a guard at the consumption point.** No branch may be resolved at plan
time without a guard asserting the premise at batch execution — except the one
annotated M2M filtered-delete gap. The unified compiler must attach guards to
reads, not leave them implicit.

I3. **Guards are semantic no-ops that abort atomically on staleness.** They carry
no data. Their only observable effect is "batch aborts if precondition false".
`exists`/`notExists` are the only two guard shapes; every higher-level guard
(`uniqueExists`, `uniqueMissing`, `uniqueWithWhere{Exists,Missing}`) lowers to
one of them via `appendPlanGuard`.

I4. **FK-direction ordering.** Within a create: currentHoldsFk relations before
the parent INSERT (their PKs flow into the parent's FK columns), relatedHoldsFk
and M2M after (they receive the parent's PK). Within a relation: child insert
before the FK-carrying UPDATE (current-holds-FK) or child insert already carries
the FK (related-holds-FK). Junction rows always after the child row. deleteMany
resolves and deletes junction rows before child rows. Any reordering breaks FK
constraints.

I5. **Sub-operation order within a relation is fixed and shared.**
`planRelationMutationSteps` defines it (create, createMany, connect,
connectOrCreate, disconnect, delete, set, update, updateMany, deleteMany,
upsert). Both engines consume it; a unified compiler must keep exactly this order
because observable end-state can depend on it.

I6. **The nested-into-create rejection set is Prisma-parity.** Under a create /
upsert-create branch only create/createMany/connect/connectOrCreate are legal;
update/updateMany/upsert/deleteMany throw. Shared via
`assertNoPlannedNestedMutationExecution`.

I7. **connectOrCreate de-dup by unique where within one array** ("first create
wins"). Must be preserved or the two engines diverge (I3 abort vs tx connect).

I8. **M2M deleteMany cannot be combined with create/connect/connectOrCreate/set
in one nested write** — typed error, both engines.

I9. **Adapter delegation (Golden Rule).** Every piece of dialect SQL (INSERT,
UPDATE, DELETE, assertions, batch-refs, operators, expressions, identifiers)
comes from `ctx.adapter.*`. The batch engine never emits raw dialect SQL. Guards,
scratch-table ops, and value-ref reads/stores are all adapter methods. A unified
backend must keep this boundary.

I10. **Result window.** The parsed result is the final `buildFindUnique`, and its
index into the raw results is offset by `setupStatements.length`. Setup/cleanup
statements must not be counted in the result-parse window.

I11. **Atomicity + fail-closed.** The whole statement list is one atomic unit;
any guard failure or constraint violation rolls the whole thing back. The engine
never partially applies. The unified design must not introduce a lowering that
can partially commit.

---

## 11. Divergences from the transaction engine

D1. **Branch timing: plan-time reads vs runtime reads.** The tx engine reads and
branches interleaved with writes (SELECT ... FOR UPDATE inside the transaction,
so it locks rows and sees its own prior writes). The batch engine reads once,
before any write, against committed state, then guards. Observable difference on
concurrency: tx engine *serializes* concurrent upserts via row locks (loser
retries — see D2); batch engine *aborts* the loser via a guard (no automatic
retry at the batch layer). End state under contention can differ (retry vs
error) though both are Prisma-valid outcomes for the winning transaction.

D2. **Write-race retry.** `transaction-flow.ts` wraps the tx path in a retry:
`isWriteRaceLoserError` (UniqueConstraintError / DEADLOCK / SERIALIZATION_FAILURE)
+ `hasRaceableCreateBranch` → re-run the whole operation, which re-reads and now
takes the update/found branch. **The batch path has no such retry** — a stale
create-branch guard (`appendAssertUniqueMissing`) simply aborts. This is a real
behavioral divergence: concurrent `upsert`/`connectOrCreate` of a missing key
succeeds (after retry) on tx drivers, but aborts on batch drivers. A unified
design must decide whether batch drivers get an equivalent replan-and-retry.

D3. **Self-visibility of writes.** In the tx engine a later read sees earlier
writes in the same operation. In the batch engine the planner's reads never see
the plan's own not-yet-executed writes (they read committed state). Wherever the
tx engine relies on read-after-write within one operation, the batch engine
instead threads values symbolically (value-refs) or resolves via the eager read +
guard. The M2M filtered-deleteMany gap (I2 exception) is exactly where this
substrate difference leaks observably.

D4. **Generated-id propagation mechanism.** tx: `executeNestedCreate` reads the
inserted row (RETURNING or lastInsertId) into a JS value, threads it as a literal.
batch: `storeLastInsertId` writes it to the scratch table; downstream statements
read it via a `(SELECT ... LIMIT 1)` subquery. Same semantics, different
mechanism; the batch mechanism imposes the single-auto-increment / no-compound
constraint (I1) the tx engine does not have.

D5. **Depth of static validation.** Batch validates the *entire* nested tree up
front (`assertNestedUpdatePlanIsExecutable` walks all branches) because it must
know the whole plan is lowerable before emitting anything. The tx engine validates
incrementally as it descends (it can afford to fail mid-transaction and roll
back). Result: some inputs that the tx engine would begin executing (and then
error partway) are rejected by the batch engine *before any write*. Same final
"rejected", earlier and whole-tree for batch.

D6. **set / disconnect skip-already-connected.** tx `set.ts` reads each target
record and skips rewriting rows already connected (MySQL 0-affected-rows would
trip the guard) and asserts departing rows per-row. batch `set` (in
`batch-relation-links.ts`) cannot read per-row at plan time: it emits a single
`appendAssertWhereMissing` on the departing-rows condition (required FK) or a
single bulk null-UPDATE on departing rows (nullable FK), then re-connects all set
items unconditionally. The end state matches, but the batch path re-writes
already-connected rows (no per-row skip) and uses a set-based departing check
rather than per-row rows-affected assertions. `buildDepartingRowsCondition` is
shared, so the *definition* of "departing" is identical.

D7. **PK-change value flow.** tx reads the updated row back to get the new PK.
batch computes it (literal or `adapter.expressions` arithmetic) and, when
computed, stores it to scratch (`batch-updated-primary-keys.ts`). tx has no
literal-vs-computed distinction — it just reads the result.

D8. **Correlated-child update read avoidance.** batch `appendCorrelatedChildUpdate`
skips the child eager-read entirely when `!hasPrimaryKeyUpdate && no nested
relations` (nothing downstream needs the child identity). The tx engine's
equivalent path structure differs; this is a batch-only optimization that must be
preserved semantically (guard still asserts existence) but is an implementation
divergence to reconcile.

D9. **Dispatch entry.** tx: `executeCreate/Update/UpsertWithNestedWrites` via
`runNestedMutationAtomically` (opens a real transaction). batch:
`executeNestedWriteBatch` via `transaction-flow.runNestedWriteOperation`
short-circuit. `atomic-runner` enforces that a batch driver never falls into the
tx path (typed error) — a guardrail the unified design should keep or subsume.

---

## 12. Acceptance oracle

`tests/query-engine/nested-write-conformance.test.ts` runs each scenario through
both engines on PGlite (`BatchOnlyPGliteDriver` forces `supportsTransactions=false,
supportsBatch=true`, wrapping the batch in a real PG transaction executed
sequentially) and asserts `batchState toEqual txState toEqual scenario.expected`.
Any unified design must keep this green: identical persisted state from both
lowerings for every non-concurrent scenario. Concurrency divergences (D1/D2) are
outside this oracle's scope (it runs scenarios serially), which is why they are
called out separately as behavioral divergences a unification must consciously
decide on.
