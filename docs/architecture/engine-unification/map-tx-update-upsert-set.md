# Semantic Map — TX Engine: update / upsert / set / disconnect / delete / deleteMany / updateMany + atomic-runner + transaction-flow entry & race retry

Slice owner: MAPPER. Files read completely:
- `src/query-engine/transaction-flow.ts` (entry, dispatch, race retry)
- `src/query-engine/operations/nested-writes/update.ts`
- `src/query-engine/operations/nested-writes/upsert.ts`
- `src/query-engine/operations/nested-writes/set.ts`
- `src/query-engine/operations/nested-writes/disconnect.ts`
- `src/query-engine/operations/nested-writes/delete.ts`
- `src/query-engine/operations/nested-writes/delete-many.ts`
- `src/query-engine/operations/nested-writes/update-many.ts`
- `src/query-engine/operations/nested-writes/atomic-runner.ts`

Supporting files read for context (owned by other slices, cited here only where they define contracts my slice depends on): `relation-mutation.ts`, `semantic-plan.ts`, `fk.ts`, `record-access.ts`, `update-plan.ts`, `assertions.ts`, `relation-data-builder.ts`, `mutation-returns.ts`, `create.ts` (types only), and the batch counterparts `batch-plan.ts`, `batch-relations.ts`, `batch-relation-links.ts`, `batch-references.ts` (for divergence analysis only).

Terminology used below:
- **fkDir** = `FkDirection` from `getFkDirection(ctx, relationInfo)`. `holdsFK` means the *current* (parent) model carries the FK column; otherwise the *target* (child/related) model carries it.
- **parentData** = a mutable `Record<string, unknown>` representing the already-persisted parent row. It is threaded through every executor and is sometimes mutated in place (see INVARIANT-MUT below).
- **"before"/"after" timing** = `NestedWriteTiming`. A step runs relative to the parent INSERT. In the update/upsert TX path the parent already exists, so all steps run with timing `"after"`.
- **txDriver / tx** = an `AnyDriver` already inside a transaction (or the batch atomic driver — but batch never enters this slice; see atomic-runner).

---

## 0. Big picture: how this slice is entered

### 0.1 `transaction-flow.ts` — the single entry `executeWithNestedWrites<T>`

`executeWithNestedWrites(ctx, operation, args, driver)` is the top-level entry for any create/update/upsert that `hasNestedWrites(...)` flagged. It:

1. Resolves `modelName = ctx.model["~"].names.ts ?? "unknown"`.
2. `driver.setContext({ model, operation })` — instrumentation context, cleared in `finally`.
3. Calls `runNestedWriteOperation<T>(...)` inside a try/catch.
4. **Race retry** (the key behavioral contract of this slice — see §7): if the thrown error `isWriteRaceLoserError(error)` AND `hasRaceableCreateBranch(operation, args)`, it re-runs `runNestedWriteOperation` **exactly once more** (single retry, not a loop), then rethrows if that also fails or if the guard is false.
5. `finally { driver.clearContext() }`.

### 0.2 `runNestedWriteOperation` — engine selection (batch vs tx)

```
if (!driver.supportsTransactions && driver.supportsBatch && isNestedBatchOperation(operation))
    → executeNestedWriteBatch  (BATCH engine — NOT this slice)
else switch(operation):
    create → executeCreateWithNestedWrites   (create slice)
    update → executeUpdateWithNestedWrites    (THIS slice)
    upsert → executeUpsertWithNestedWrites     (THIS slice)
```

So the tx engine is chosen when the driver `supportsTransactions`. `isNestedBatchOperation` = operation ∈ {create, update, upsert}. The batch branch is guarded by `!supportsTransactions && supportsBatch`. **A driver that supports both transactions and batch always takes the tx path.**

### 0.3 `atomic-runner.ts` — `runNestedMutationAtomically`

Every tx-engine entry that needs atomicity wraps its work in `runNestedMutationAtomically(driver, operation, run)`:

- `if driver.supportsTransactions → driver.withTransaction(txDriver => run(txDriver))`. The callback body IS the semantic sequence.
- `if driver.supportsBatch → throw QueryEngineError` "reached the transaction-only nested {op} path, but this driver requires planned atomic batch execution" (meta.strategy = "batch"). This is a **guard, not a fallback**: if a batch-only driver ever reaches here it is a routing bug, surfaced as a typed error rather than silent single-statement execution.
- else → throw QueryEngineError "cannot execute nested {op} writes atomically … neither callback transactions nor atomic batch" (meta.strategy = "unsupported").

`NestedMutationOperation` is narrowed to `"create" | "update" | "upsert"` at the type level.

**INVARIANT (atomicity):** every multi-statement nested update/upsert in the tx engine executes inside exactly one transaction. There is no partial-commit path. The only escape hatches are typed errors.

---

## 1. `update.ts` — nested update on relations

Two public entry shapes:
1. `executeUpdateWithNestedWrites` (in `transaction-flow.ts`) — the **top-level** `orm.model.update({ where, data })` when `data` contains nested writes.
2. `executeNestedUpdate` / `executeRelationUpdate` / `executeSingleRelationUpdate` (in `update.ts`) — the **recursive** machinery, entered both from the top-level path and from any parent create/update/upsert that recurses into a child `update`.

### 1.1 Top-level `executeUpdateWithNestedWrites(ctx, args, driver, modelName)` — transaction-flow.ts

Step sequence (only the nested-write branch, i.e. `Object.keys(relations).length > 0 && needsTransaction(relations)`):

1. `separateData(ctx, data)` → `{ scalarData, relations }`.
2. `assertNestedUpdatePlanIsExecutable(ctx, relations)` — **plan-time guard**, run BEFORE opening the transaction. Recursively walks every nested create/update/upsert/updateMany branch and rejects any branch that carries a `planned:` marker (`assertNoPlannedNestedMutationExecution`) or an unsupported combination. Purpose: fail fast with a `NestedWriteError` before any writes happen.
3. `runNestedMutationAtomically(driver, "update", async txDriver => { ... })`:
   a. **READ (before-image):** `fetchRequiredUniqueRows(txDriver, ctx, { where }, "update", modelName)`. Throws `NotFoundError(modelName, "update")` if the row is absent. `beforeRows[0]` is the before-image.
   b. **Compute refetch key:** `getUpdatedPrimaryKeyWhere(ctx, beforeRows[0], scalarData, modelName)` — the PK the row will have AFTER `scalarData` is applied. Throws `QueryEngineError` if a PK field is updated with a non-literal op (a `Sql` or a non-`{set:literal}` operation), because such a value can't be predicted client-side.
   c. **WRITE scalars (conditional):** if `Object.keys(scalarData).length > 0`, `buildUpdate(ctx, { where, data: scalarData })` and execute. **Scalar update happens BEFORE nested relation writes.**
   d. **READ (after-image):** `buildFindUnique(ctx, { where: refetchWhere })` → `updatedRecord`. If absent → `NotFoundError(modelName, "update")` (the row was deleted concurrently, or the PK prediction was wrong).
   e. **RECURSE:** `executeNestedUpdate(txDriver, ctx, updatedRecord, relations)`.
   f. **RETURN:** if `args.include || args.select`, refetch via `buildFindUnique(ctx, { where: refetchWhere, select, include })` and `parseFindUniqueResult`. Otherwise return `updatedRecord as T` (Prisma parity: no select/include ⇒ scalars only, but here the full row was already fetched).

**Non-nested fast path** (relations empty OR `!needsTransaction`): plain `buildUpdate`, optional `executeNonReturningMutation` for non-returning adapters, `throwIfSingleRecordMutationMiss` (raises `NotFoundError` when 0 rows matched), `parseOperationResult`. No transaction. This path is out of the nested-write scope but shares `buildUpdate` and the miss-detection contract.

### 1.2 `executeNestedUpdate(driver, ctx, parentRecord, relations)` — the recursive fan-out

- Early-out if `relations` empty → `{ record: parentRecord, related: {} }`.
- `assertNestedUpdatePlanIsExecutable(ctx, relations)` — **re-asserted here** (defensive: this function is also called directly from create/upsert paths, not only from 1.1).
- `runNestedMutationAtomically(driver, "update", async txDriver => ...)` — **note:** when called from 1.1 the driver is *already* a txDriver, so this opens a **nested** `withTransaction`. This relies on drivers making nested `withTransaction` a no-op / savepoint that shares the outer tx. (See DIVERGENCE-NEST below — this is a real re-entrancy assumption.)
- Builds `txCtx: TransactionContext = { generatedIds: Map, createdRecords: Map }`. Seeds `generatedIds.set("__parent__", parentId)` where `parentId = parentRecord[getPrimaryKeyField(ctx.model)]`.
- **For each** `[relationName, mutation]` in `relations` (object insertion order): `processRelationMutation(txDriver, ctx, relationName, mutation, "after", parentRecord, txCtx, executors)`. The injected `executors` map wires: `create → executeRelationCreate`, `createMany → executeRelationCreateMany`, `update → executeRelationUpdate`, `updateMany → executeRelationUpdateMany`, `deleteMany → executeRelationDeleteMany`. (Note: `connect`, `connectOrCreate`, `disconnect`, `delete`, `set`, `upsert` are NOT in this executor map — they are handled directly inside `processRelationMutation` via its own imports, see §1.5.)
- Collects `related[name] = txCtx.createdRecords.get(name)` for each relation that produced created records, returns `{ record: parentRecord, related }`.

**Ordering rule & why:** relations are processed in object key order. Within a relation, `planRelationMutationSteps` fixes a canonical step order (create, createMany, connect, connectOrCreate, disconnect, delete, set, update, updateMany, deleteMany, upsert). This order is **shared** with the batch engine (both call the same `planRelationMutationSteps`), which is the anchor keeping the two engines aligned on intra-relation ordering.

### 1.3 `executeRelationUpdate(tx, ctx, relationInfo, updateInput, parentData, _txCtx)`

Splits on cardinality:

- **isToOne:** `executeSingleRelationUpdate(tx, childCtx, relationInfo, updateInput, whereClause)` where `whereClause = buildFkMatchCondition(ctx, fkDir, targetModel, parentData)`. For to-one there is no per-item `where`; the child is located purely by FK correlation to the parent.
- **isToMany:** for each `input` in `normalizeNestedUpdateInputs(updateInput)` (each `{ where, data }`): build `whereClause = combineWithParentCorrelation(ctx, fkDir, targetModel, buildWhereUnique(childCtx, input.where, table), parentData)` — i.e. **child unique-where AND parent-FK correlation**. This is the load-bearing safety property: a to-many update can only touch rows that both match the caller's `where` AND belong to this parent. Then `executeSingleRelationUpdate(tx, childCtx, relationInfo, input.data, whereClause)`.

`childCtx = createChildContext(ctx, relationInfo.targetModel, ctx.nextAlias())`, `fkDir = getFkDirection(ctx, relationInfo)`.

### 1.4 `executeSingleRelationUpdate(tx, childCtx, relationInfo, data, whereClause)` — the atom

Precise sequence:

1. `separateData(childCtx, data)` → `{ scalarData, relations }`.
2. `assertNestedUpdatePlanIsExecutable(childCtx, relations)` — plan-time guard for the grandchild relations.
3. **READ before-image:** `fetchRequiredWhereRecord(tx, childCtx, targetModel, whereClause, { relationName, operation:"update", kind:"correlated" })`. Throws the **"correlated"** not-found message ("target record was not found for this parent") if 0 rows. This is the point that enforces "the child both matches and belongs to the parent".
4. `refetchWhere = getUpdatedPrimaryKeyWhere(childCtx, beforeRecord, scalarData, table)` — post-update PK prediction (same non-literal-PK guard as §1.1b).
5. **WRITE scalars (conditional):** if `scalarData` non-empty: `buildSet`, `adapter.mutations.update(table, setSql, whereClause)`, execute. **If `result.rowCount === 0` → throw `recordNotFoundError({..., kind:"correlated"})`.** (Belt-and-suspenders: step 3 already fetched the row, but a concurrent delete between fetch and update is caught here.)
6. If `relations` empty → return.
7. **READ after-image:** `fetchRequiredUniqueRecord(tx, childCtx, targetModel, refetchWhere, {..., kind:"correlated"})` → `updatedRecord`.
8. **RECURSE:** `executeNestedUpdate(tx, childCtx, updatedRecord, relations)`.

**Value flow:** `beforeRecord` (PK values) + `scalarData` (possible PK overwrite) → `refetchWhere` → `updatedRecord` → parentData for the next recursion level.

**Ordering rule & why (FK direction):** `executeSingleRelationUpdate` itself does not branch on `fkDir.holdsFK` — an UPDATE of a child row by its own where clause is FK-direction-agnostic. FK direction matters only for locating the child (`buildFkMatchCondition` vs `combineWithParentCorrelation`), which is already resolved by the caller. Scalars-before-relations ordering exists because the recursion needs the *updated* PK to correlate grandchildren.

### 1.5 `processRelationMutation` dispatch (relation-mutation.ts, shared)

For non-m2m relations, iterates `planRelationMutationSteps(relationName, mutation, timing)` and dispatches by `step.kind`. **Timing gate:** in the update/upsert path `timing === "after"`, so every case's `if (timing === "after")` / `if (timing !== "after") break` guard passes. The executor map is optional per operation; `assertExecutor` throws `NestedWriteError` "cannot run in this mutation context" if an executor for update/updateMany is missing (this is how create-context vs update-context capability differences surface). `deleteMany`/`upsert` default to `executeRelationDeleteMany`/`executeRelationUpsert` if not injected.

m2m relations bypass all of this and go to `processManyToManyMutation` (other slice).

---

## 2. `upsert.ts` — relation-level upsert (child upsert inside a parent write)

Two distinct upsert concepts live in this slice:
- **Top-level upsert** = `orm.model.upsert({ where, create, update })` → `executeUpsertWithNestedWrites` in transaction-flow.ts (§3).
- **Relation upsert** = a `{ upsert: {...} }` nested inside a parent's `data` → `executeRelationUpsert` in upsert.ts (this section).

### 2.1 `executeRelationUpsert(tx, ctx, relationInfo, upsertInput, parentData, txCtx, executors)`

- `normalizeNestedUpsertInputs(relationInfo, upsertInput)` → array; throws `NestedWriteError` if to-one gets >1 input.
- For each input, dispatch on cardinality:
  - isToOne → `executeToOneRelationUpsert`
  - isToMany → `executeToManyRelationUpsert`

### 2.2 `executeToOneRelationUpsert` — the existence branch

1. `fkDir = getFkDirection`, `childCtx`.
2. **READ:** `currentTargetWhere = buildFkMatchCondition(ctx, fkDir, targetModel, parentData)`; `currentTarget = fetchOptionalWhereRecord(...)` — does a child already sit in this to-one slot?
3. **Branch EXISTS:** `executeUpsertUpdateBranch(tx, ctx, relationInfo, input.update, parentData, txCtx, executors)` → delegates to `executors.update` (i.e. `executeRelationUpdate`). Requires `executors.update` present else `NestedWriteError` "cannot run in this mutation context".
4. **Branch MISSING:** `createdRecord = executors.create(tx, ctx, relationInfo, input.create, timing, parentData)` where `timing = fkDir.holdsFK ? "before" : "after"`.
   - **FK-direction ordering (WHY):** if the parent holds the FK (`holdsFK`), the child must be created FIRST so its PK exists to be written into the parent's FK column ("before"). Then `connectCreatedRecordToCurrentParent(tx, ctx, relationInfo, createdRecord, parentData, "upsert")` writes the FK onto the parent (and mutates `parentData[fkField]`). If the child holds the FK, the parent already exists, so the child is created "after" with the parent PK already stamped into it by the create executor.
   - `txCtx.createdRecords.set(relationInfo.name, createdRecord)`.

### 2.3 `executeToManyRelationUpsert` — the correlated-vs-uncorrelated branch

1. Require `input.where` else `NestedWriteError` (to-many upsert needs a locator).
2. `uniqueWhere = buildWhereUnique(childCtx, input.where, "")`.
3. **READ correlated:** `correlatedWhere = combineWithParentCorrelation(...)`; `correlatedRecord = fetchOptionalWhereRecord(...)` — does a row matching `where` AND belonging to this parent exist?
4. **Branch CORRELATED-EXISTS:** `executeUpsertUpdateBranch(..., { where: input.where, data: input.update }, ...)` → update.
5. **Branch NOT-CORRELATED:** `existingUncorrelatedRecord = fetchOptionalWhereRecord(tx, childCtx, targetModel, uniqueWhere)` — does a row matching `where` exist but belong to *another* parent (or no parent)?
   - **If uncorrelated row EXISTS → throw `NestedWriteError`** "target record was not found for this parent." This is the crucial Prisma-parity rule: you cannot upsert-create over a unique key that is already taken by a foreign row; you'd get a unique violation, so it's surfaced as a clear typed error instead.
   - **Else → `executors.create(tx, ctx, relationInfo, input.create, "after", parentData)`.** (For to-many the parent always exists and the child holds the FK, so "after" and no explicit connect step — the create executor stamps the FK.)

### 2.4 `executeUpsertUpdateBranch` & `normalizeNestedUpsertInputs`

- `executeUpsertUpdateBranch`: guard `executors.update` present, then delegate. Single responsibility: route the "existing" branch through the update executor with the right input shape (to-one passes `input.update` bare, to-many wraps as `{ where, data }`).
- `normalizeNestedUpsertInputs`: array-normalize + reject multiple inputs for to-one.

**Existence-decides-branch contract:** the upsert branch is decided by a **READ at execution time** (`fetchOptionalWhereRecord`). This is the fundamental thing the batch engine cannot do the same way — it must resolve the branch at plan time and emit a SQL guard (see §8, DIVERGENCE-UPSERT-BRANCH).

---

## 3. Top-level `executeUpsertWithNestedWrites` (transaction-flow.ts)

Runs entirely inside `runNestedMutationAtomically(driver, "upsert", ...)`.

1. **READ with lock:** `selectSql = buildFindUnique(ctx, { where, forUpdate: true })`; execute. `forUpdate:true` appends `FOR UPDATE` on PG/MySQL, is a **no-op on SQLite** (SQLite uses DB-level locking; see adapter). This SELECT-FOR-UPDATE is the concurrency primitive whose *failure to lock absent rows* is exactly what the race-retry compensates for (§7).
2. **Branch EXISTS (`rows.length > 0`):** `executeExistingUpsert(...)`.
3. **Branch MISSING:** `executeMissingUpsert(...)`.

### 3.1 `executeExistingUpsert` (update branch of top-level upsert, with targetWhere/setWhere)

1. `pkWhere = getPrimaryKeyWhereFromRecord(ctx.model, existingRecord, modelName)`.
2. **Conditional guard reads (targetWhere / setWhere):** these are the `supportsUpsertWhere` fallback fields.
   - `targetWhereMatched = hasRecordKeys(targetWhere) ? Boolean(fetchOptionalUniqueWithWhereRecord(txDriver, ctx, model, pkWhere, targetWhere)) : undefined`.
   - `setWhereMatched = (targetWhereMatched !== false && hasRecordKeys(setWhere)) ? Boolean(fetchOptionalUniqueWithWhereRecord(...)) : undefined`. Note short-circuit: setWhere is only checked if targetWhere didn't already fail.
3. `branch = planExistingUpsertBranch({ model, existingRecord, pkWhere, targetWhere, targetWhereMatched, setWhere, setWhereMatched })` — pure function (semantic-plan.ts) returning `targetWhereSkipped | setWhereSkipped | update`.
4. `finalWhere = branch.pkWhere` initially.
5. **If `branch.kind === "update"`:**
   - `separateData(ctx, args.update)`, `assertNestedUpdatePlanIsExecutable`.
   - `finalWhere = getUpdatedPrimaryKeyWhere(ctx, existingRecord, scalarData, modelName)`.
   - WRITE scalars (conditional): `buildUpdate(ctx, { where: pkWhere, data: scalarData })`.
   - **READ after-image by finalWhere:** if absent → `QueryEngineError` "Record was deleted by another transaction during upsert".
   - **RECURSE:** if relations non-empty, `executeNestedUpdate(txDriver, ctx, updatedRecord, relations)`.
   - (branches `targetWhereSkipped`/`setWhereSkipped` fall through with `finalWhere = pkWhere` and DO NOT update — the record is returned unchanged.)
6. **RETURN:** refetch by `finalWhere` with select/include → `parseFindUniqueResult`.

### 3.2 `executeMissingUpsert` (create branch of top-level upsert)

1. `separateData(ctx, args.create)`; `assertNoPlannedNestedMutationExecution(relations, "upsertCreate")`.
2. `createResult = executeNestedCreate(txDriver, ctx, createData)` (create slice).
3. **RETURN:** if select/include, `getProvidedPrimaryKeyWhere` → refetch → `parseFindUniqueResult`; else return `createResult.record as T` (Prisma parity: scalars only).

**targetWhere/setWhere semantics (invisible knowledge):** `targetWhere` gates whether the update branch is even taken (if the existing row doesn't match targetWhere, the upsert becomes a no-op returning the existing row — `targetWhereSkipped`). `setWhere` similarly. These exist to emulate Postgres/SQLite `ON CONFLICT ... WHERE` on adapters that lack it (`supportsUpsertWhere:false`, i.e. MySQL). `needsUpsertWhereFallback` / `hasUpsertWhereOptions` in transaction-flow decide when this fallback machinery is needed.

---

## 4. `set.ts` — replace the entire to-many membership

`executeRelationSet(tx, ctx, relationInfo, setItems, parentData)`.

**Precondition guards (fail fast, before any write):**
- If `fkDir.holdsFK` → `NestedWriteError` "'set' not supported … where current model holds FK. Use 'connect' instead." (set is inherently a to-many op; a to-one FK-holder should use connect/disconnect.)
- For each `pkField` in `fkDir.pkFields`: if `parentData[pkField]` is null/undefined → `NestedWriteError` "parent record is missing primary key field" (can't correlate children without the parent PK).

**Sequence:**
1. **READ every target up front (existence assertion):** for each `setItem`, `fetchRequiredUniqueRecord(tx, ctx, targetModel, setItem, { kind:"target" })` → `targetRecords[]`. Throws **"target"** not-found ("target record was not found") if any set member doesn't exist. This also yields each target's current FK values so already-connected rows can be skipped later.
2. **Compute departing rows:** `departingWhere = buildDepartingRowsCondition(...)` = `fkMatch AND NOT(COALESCE(memberWhere, FALSE))`. I.e. rows currently connected to the parent that are NOT in the new set. The `COALESCE(..., FALSE)` before `NOT` is critical for SQL three-valued logic: without it, a connected row with NULL in a unique column referenced by a set item would make `memberWhere` NULL, `NOT(NULL)` NULL, and the row would silently stay connected. (When `setItems` empty, departing = all currently-connected rows = `fkMatch`.)
3. **Disconnect departing rows — branch on FK nullability:**
   - `requiredFkFields = getNonNullableFkFields(fkDir)`. If non-empty (required FK): `assertNoDepartingRows(...)` — runs `SELECT 1 FROM target WHERE departingWhere LIMIT 1`; if any row returned → `NestedWriteError` "rows removed from the set cannot be disconnected. Delete them instead." **Crucially: a no-op set (nothing departs) succeeds** — the error only fires when rows would actually be orphaned (Prisma parity).
   - Else (nullable FK): `UPDATE target SET fk=NULL WHERE departingWhere`. No rows-affected assertion here (departing set may legitimately be empty).
4. **Connect each set member — skipping already-connected rows:**
   - `valueAssignments = buildFkValueAssignments(ctx, fkDir, targetModel, parentData)` (SET fk = parent PK).
   - For each index: if `isAlreadyConnected(fkDir, targetRecords[index], parentData)` → **skip** (rewriting is wasted work, and MySQL reports a no-change UPDATE as 0 affected rows, which would trip the rows-affected guard). Else `UPDATE target SET fk=parentPK WHERE buildWhereUnique(childCtx, setItem)`, then `throwIfNoCorrelatedRowsAffected(result, name, "set")` → **"correlated"** not-found if 0 affected.

`isAlreadyConnected`: compares every `fkField` current value to the corresponding parent PK, using `===` OR `String(a)===String(b)` (bridges number vs bigint driver id representations). Returns false if either side is null/undefined.

**Ordering rule & why:** disconnect departing rows BEFORE connecting new ones. If a required-FK relation, the disconnect step is replaced by an assertion (can't null a required FK). Existence of all targets is asserted first so a partially-applied set is impossible (all-or-nothing within the transaction).

`buildDepartingRowsCondition` is **exported and shared** with the batch engine (`batch-relation-links.ts` imports it), keeping the departing-row semantics identical.

---

## 5. `disconnect.ts`

`executeRelationDisconnect(tx, ctx, relationInfo, disconnectInput, parentData)`. `disconnectInput` ∈ `boolean | Record | Record[]`.

**Branch on FK direction:**

### 5.1 `fkDir.holdsFK` (parent holds FK — to-one disconnect)
1. `assertFkCanBeSetNull(name, fkDir)` — if any FK field is non-nullable → `NestedWriteError` "foreign key field(s) … are required."
2. `UPDATE parent SET fk=NULL WHERE buildCurrentRecordMatchCondition(ctx, parentData)` (locate parent by its PK).
3. `throwIfNoCorrelatedRowsAffected(result, name, "disconnect")` → "correlated" if 0.
4. **MUTATE parentData:** `for fkField in fkDir.fkFields: parentData[fkField] = null`. (Keeps in-memory parentData consistent so later steps see the disconnected state.)

### 5.2 `!holdsFK` (child holds FK — to-many disconnect)
1. `assertFkCanBeSetNull(name, fkDir)`.
2. Build `whereClause`:
   - `disconnectInput === true` → `buildFkMatchCondition(...)` (disconnect ALL children of this parent). **No rows-affected assertion** in this case (disconnecting an empty set is legal).
   - else → normalize to array, for each object build `buildWhereUnique(childCtx, input, table)`, OR them together, then `combineWithParentCorrelation(...)`. If `conditions.length === 0` → `NestedWriteError` "Invalid disconnect input."
3. `UPDATE target SET fk=NULL WHERE whereClause`.
4. If `disconnectInput !== true` → `throwIfNoCorrelatedRowsAffected(...)` (explicit targets must exist & belong to parent).

**Asymmetry contract:** `disconnect: true` is best-effort (no error if nothing to disconnect); `disconnect: {where}` is strict (error if the named target isn't correlated). This asymmetry is mirrored in `delete.ts`.

---

## 6. `delete.ts`, `delete-many.ts`, `update-many.ts`

### 6.1 `executeRelationDelete(tx, ctx, relationInfo, deleteInput, parentData)`

`deleteInput` ∈ `boolean | Record | Record[]`. `shouldRequireAffectedRow` starts false.
1. Build `whereClause`:
   - `=== true` → `buildFkMatchCondition` (delete all children of parent), `shouldRequireAffectedRow` stays false.
   - else → array of `buildWhereUnique` OR'd, then `combineWithParentCorrelation`; `shouldRequireAffectedRow = true`. Empty conditions → `NestedWriteError` "Invalid delete input."
2. **If `fkDir.holdsFK` (parent holds FK):** the parent's FK must be nulled BEFORE deleting the child (else the FK would dangle / RESTRICT-violate). `assertFkCanBeSetNull`; `UPDATE parent SET fk=NULL WHERE buildCurrentRecordMatchCondition`; **MUTATE parentData[fkField]=null**. (WHY the ordering: for a to-one where the parent points at the child, you can't delete the child while the parent still references it.)
3. `DELETE FROM target WHERE whereClause`.
4. If `shouldRequireAffectedRow` → `throwIfNoCorrelatedRowsAffected(..., "delete")`.

Same true-is-lax / explicit-is-strict asymmetry as disconnect.

### 6.2 `executeRelationDeleteMany(tx, ctx, relationInfo, deleteManyInput, parentData)`

- **Guard:** isToOne → `NestedWriteError` "'deleteMany' not supported for to-one relation."
- For each input (array-normalized): `whereClause = buildDeleteManyWhere` = `parentFkMatch AND buildWhere(childCtx, where, table)` (a *filter* `where`, not unique). `DELETE FROM target WHERE whereClause`. **No rows-affected assertion** — deleteMany is set-based and matching zero rows is valid.
- `buildWhere` uses `{ ...childCtx, mutationTable: targetTable }` so the filter columns resolve against the target table without alias qualification.

### 6.3 `executeRelationUpdateMany(tx, ctx, relationInfo, updateManyInput, parentData)`

- **Guard:** isToOne → `NestedWriteError` "'updateMany' not supported for to-one relation."
- For each `input` in `normalizeNestedUpdateManyInputs`: `separateData(childCtx, input.data)`; **`assertUpdateManyDataHasNoRelations(relationName, relations)`** — updateMany data is scalar-only; any nested relation write → `NestedWriteError`. `setSql = buildSet(childCtx, scalarData)`. `whereClause = buildUpdateManyWhere` = `parentFkMatch AND buildWhere(childCtx, input.where, table)`. `UPDATE target SET ... WHERE whereClause`. **No rows-affected assertion** (set-based).

**deleteMany/updateMany contract:** both are set-based, filter-`where` (not unique), correlated to the parent FK, and never assert rows-affected. Both reject to-one. updateMany additionally forbids nested relations in `data`.

---

## 7. Race retry — `isWriteRaceLoserError` & `hasRaceableCreateBranch`

The single most subtle behavioral contract in this slice (transaction-flow.ts).

**Why races happen:** `SELECT ... FOR UPDATE` cannot lock rows that don't exist yet. Two concurrent upserts (or connectOrCreates) of a *missing* unique key can both read "absent" and both take the create branch. Exactly one commits; the loser hits:
- a **unique violation** (Postgres / SQLite), or
- a **gap-lock deadlock** (MySQL).

**Detection — `isWriteRaceLoserError(error)`:** true iff
- `error instanceof UniqueConstraintError`, OR
- `isVibORMError(error) && (error.code === DEADLOCK || error.code === SERIALIZATION_FAILURE)`.

**Applicability — `hasRaceableCreateBranch(operation, args)`:**
- upsert → always true (upsert inherently has a create branch).
- else (create/update) → `containsRaceableNestedWrite(args.data)`: recursive scan for any nested object containing `"connectOrCreate"` or `"upsert"` keys (these are the only nested ops whose branch is decided by a "missing?" read that can race).

**Retry semantics:** on a caught raceable error with a raceable branch, `runNestedWriteOperation` is invoked **once more**. The rerun's `SELECT FOR UPDATE` now sees the winner's committed row and takes the update/found branch instead of create. This is a **single retry, not a loop** — if the rerun also fails (or the error isn't raceable, or the branch isn't raceable), it rethrows. The retry re-enters the whole operation from the top (new transaction via `runNestedMutationAtomically`).

**INVARIANT (idempotent-on-retry):** the operation must be safe to re-run from scratch. This is why all writes live inside a transaction that fully rolled back on the loser's failure — the rerun starts from clean committed state.

---

## 8. DIVERGENCES between the tx engine (this slice) and the batch engine

These are the observable/mechanistic differences the conformance suite pins, and that any unified design must reconcile.

### DIVERGENCE-UPSERT-BRANCH (relation upsert & top-level upsert)
- **TX:** branch chosen by a live `fetchOptionalWhereRecord` at execution time; the update/create path then runs directly.
- **Batch:** `appendRelationUpsert` / `appendUpsertRecord` also `fetchOptionalWhereRecord` at *plan* time (during `driver` reads before batch assembly), pick the branch, then **emit a SQL guard** (`appendAssertWhereExists` / `appendAssertUniqueMissing` / `appendPlanGuard`) asserting the premise (row present / unique-key still absent) still holds when the batch runs. If a concurrent write invalidated the premise, the batch's guard statement raises inside the atomic batch → the operation aborts (and, for top-level upsert, the race-retry in transaction-flow catches it). The tx engine instead re-reads and re-decides. **Observable difference:** under contention the batch engine surfaces a guard-assertion failure (mapped to a raceable error) where the tx engine may silently take the other branch. Same *end state* on success; different failure mechanism.

### DIVERGENCE-UPSERT-EXISTING-WHERE (top-level upsert branch selection)
- Both engines call the SAME pure `planExistingUpsertBranch`, so branch *selection* (targetWhereSkipped/setWhereSkipped/update) is identical. But:
  - **TX** (`executeExistingUpsert`) computes `finalWhere = getUpdatedPrimaryKeyWhere(existingRecord, scalarData)` and refetches; a concurrent delete of the row mid-update → `QueryEngineError` "Record was deleted by another transaction during upsert."
  - **Batch** (`appendUpsertRecord` → `appendUpdateRecordFromExisting`) uses `getStaticPrimaryKeyWhere` (requires PK known before execution; throws `NestedWriteError` "requires primary key … known before execution" if a PK is Sql/absent) and emits `appendAssertUniqueExists` guard instead of a live "was it deleted?" check. **Different error type & timing** for the concurrent-delete case.

### DIVERGENCE-SCALAR-UPDATE-REFETCH (nested update after-image)
- **TX** (`executeSingleRelationUpdate`): always fetches before-image (`fetchRequiredWhereRecord`) and, when relations follow, an after-image (`fetchRequiredUniqueRecord`). It also runs a redundant `rowCount === 0` check after the scalar UPDATE.
- **Batch** (`appendCorrelatedChildUpdate`): only fetches the child record when `needsUpdatedPrimaryKey` (PK is being updated OR there are grandchild relations); otherwise emits an `appendAssertWhereExists` guard and skips the read entirely. **Fewer reads in batch**; the existence check becomes a guard rather than a throwing fetch. Same end state; the not-found *timing* differs (batch fails at guard-execution, tx fails at fetch).

### DIVERGENCE-PARENTDATA-MUTATION vs BATCH-REF (disconnect/delete FK nulling)
- **TX** disconnect/delete on a parent-held FK mutate `parentData[fkField] = null` in place after the UPDATE, so subsequent in-tx steps see the change.
- **Batch** never mutates a live parentData with resolved values; it threads `BatchResolvableValue` / `BatchValueRef` symbols and lowers them to `batchRefs.read(...)` SQL. The FK-null is expressed purely as SQL; there is no in-memory mirror. A unified design's Expr layer must represent "this column is now NULL for downstream correlation" abstractly (symbol or literal) rather than by mutating a JS record.

### DIVERGENCE-SET-MEMBER-SKIP (set already-connected optimization)
- **TX** (`executeRelationSet`) reads each target up front (`targetRecords[]`) and **skips** re-connecting rows already connected (`isAlreadyConnected`) to avoid MySQL's 0-affected-rows-on-no-op-UPDATE tripping the guard.
- **Batch** (`appendRelationSet`) does NOT skip: it `appendAssertUniqueExists` for each member then `appendRelationConnect` for **every** member unconditionally (re-writing the FK even for already-connected rows). Batch connect has no rows-affected assertion, so re-writing is harmless there. **Observable:** batch issues an UPDATE for every set member; tx issues UPDATEs only for newly-connected members. Same end state; different statement count / write amplification.

### DIVERGENCE-SET-DISCONNECT-ERROR (set with required FK)
- **TX** (`assertNoDepartingRows`): runs a live `SELECT 1 … LIMIT 1` and throws `NestedWriteError` if any departing row exists.
- **Batch** (`appendRelationSet`): emits `appendAssertWhereMissing(departingWhere)` — an in-batch SQL assertion that raises if departing rows exist. Same predicate (`buildDepartingRowsCondition`, shared), different failure surface (live throw vs batch guard). The `COALESCE(...,FALSE)` three-valued-logic fix is shared because the condition builder is shared.

### DIVERGENCE-DELETE/DISCONNECT-STRICTNESS (true vs explicit)
- Both engines: `delete:true`/`disconnect:true` are lax (no rows-required). But the **mechanism** differs: TX gates on `shouldRequireAffectedRow` + `throwIfNoCorrelatedRowsAffected` (rows-affected count), whereas batch gates via `buildRelationTargetWhere(..., requireRows=true)` which appends `appendAssertWhereExists` only when `input !== true`. Same rule ("explicit targets must exist"), enforced by rows-affected in tx vs a pre-guard in batch.

### DIVERGENCE-RECURSION-ATOMICITY (nested withTransaction)
- **TX** `executeNestedUpdate` opens a fresh `runNestedMutationAtomically` (→ `withTransaction`) at every recursion level, relying on nested `withTransaction` being a savepoint/no-op that joins the outer tx.
- **Batch** has no nesting of transactions — it appends statements to one flat `PlanState.statements` list executed as a single batch. A unified design must pick one atomicity model; the tx engine's re-entrant `withTransaction` is an implicit assumption that must be made explicit.

### DIVERGENCE-TOONE-UPDATE-LOCATION
- **TX** `executeRelationUpdate` (isToOne) locates the child by `buildFkMatchCondition` only (no per-item where — to-one update input is bare `data`).
- **Batch** `appendRelationUpdate` matches the same way (`buildFkMatchCondition` for isToOne). Aligned — noted here only to confirm no divergence.

### DIVERGENCE-M2M-DELETEMANY-COMBINATION (plan-time rejection)
- `assertManyToManyStepCombinationIsSupported` (semantic-plan.ts) rejects combining create/connect/connectOrCreate/set with deleteMany on an m2m relation, **specifically because** the tx engine executes those before deleteMany while the batch engine resolves deleteMany targets at plan time — combining them would silently produce different end states. This is a divergence the code *defends against* rather than reconciles. Any unified design that fixes the ordering could lift this restriction.

### DIVERGENCE-CONNECTORCREATE-DEDUPE
- `dedupeConnectOrCreateInputs` (semantic-plan.ts) dedupes repeated connectOrCreate targets in one array because the tx engine's second pass would connect the dup while the batch engine would abort on its uniqueMissing assertion. Another defended divergence, shared via the common planner.

---

## 9. INVARIANTS any unified design MUST preserve

1. **Atomicity:** every multi-statement nested update/upsert commits all-or-nothing. No partial-commit observable state. Escape hatches are typed errors only (`QueryEngineError`, `NestedWriteError`, `NotFoundError`).

2. **Parent-correlation on every to-many mutation:** any update/updateMany/delete/deleteMany/disconnect/set targeting to-many children MUST AND the caller's `where` with the parent-FK match (`combineWithParentCorrelation` / `buildFkMatchCondition`). A nested write can never touch a row that doesn't belong to the parent, even if its `where` would match globally.

3. **FK-direction ordering:**
   - Parent-holds-FK to-one create/upsert-create: child created BEFORE parent FK is written ("before" timing) then `connectCreatedRecordToCurrentParent`.
   - Parent-holds-FK delete/disconnect: parent FK nulled BEFORE child delete.
   - Child-holds-FK: parent exists first, child stamped with parent PK ("after").

4. **Scalars-before-nested-relations, with after-image refetch:** at every level, scalar columns are updated first, then the post-update PK is computed (`getUpdatedPrimaryKeyWhere`, rejecting non-literal PK updates), the updated row is refetched, and that becomes the parentData for recursion.

5. **Existence semantics & the true/explicit asymmetry:**
   - `set`/relation-upsert/connect: all named targets MUST exist (`kind:"target"` not-found).
   - Correlated update/single-delete/single-disconnect with explicit `where`: the row must exist AND be correlated (`kind:"correlated"` not-found or rows-affected==0).
   - `delete:true` / `disconnect:true`: lax, no rows-required.
   - deleteMany / updateMany: set-based, never rows-required.

6. **Distinct not-found messages preserved:** "target" ("… was not found"), "correlated" ("… was not found for this parent"), "nested-write" ("Cannot {op} nested write: …"). These are asserted by the conformance/behavior suites.

7. **Required-FK guards:** disconnect/delete/set on a non-nullable FK that would orphan a row MUST raise `NestedWriteError` (`assertFkCanBeSetNull` / `assertNoDepartingRows` / `getNonNullableFkFields`) — never emit `SET fk=NULL` on a required column. **A no-op set/disconnect (nothing departs) succeeds** even with required FK.

8. **Three-valued-logic safety:** the departing-rows predicate MUST `COALESCE(memberWhere, FALSE)` before negation so NULL unique columns don't silently retain membership. (Shared `buildDepartingRowsCondition`.)

9. **Upsert branch decided by an existence check + premise guard:** whichever substrate, the branch (update-existing vs create-missing vs skip) is a function of a read; and if the substrate defers execution (batch), the premise of that read MUST be re-asserted at execution time (guard) so a concurrent change causes a typed abort, not silent wrong-branch persistence.

10. **Race compensation for FOR-UPDATE's absent-row blind spot:** the create/found branch of upsert/connectOrCreate MUST be retryable exactly once on `UniqueConstraintError`/`DEADLOCK`/`SERIALIZATION_FAILURE`, because SELECT FOR UPDATE cannot lock a not-yet-existing key. The retry re-reads and takes the other branch. This requires the whole operation to be idempotent-on-clean-rerun (implied by invariant 1).

11. **Plan-time executability guard is mandatory and runs before writes:** `assertNestedUpdatePlanIsExecutable` / `assertNoPlannedNestedMutationExecution` / `assertUpdateManyDataHasNoRelations` reject unsupported nesting (planned markers, relations inside updateMany data) BEFORE any statement executes. A unified compiler must keep a static validation pass ahead of execution.

12. **Batch-only PK-known-before-execution constraint:** when a substrate cannot observe generated values mid-plan (batch), PKs used for correlation MUST be known ahead of time or represented as a symbol/ref; the code raises `NestedWriteError "requires primary key … known before execution"` / "cannot propagate generated compound primary keys" rather than guessing. The unified Expr layer must model "generated value not yet known" as a first-class symbol.

13. **Shared canonical step order:** intra-relation step order (create → createMany → connect → connectOrCreate → disconnect → delete → set → update → updateMany → deleteMany → upsert) is defined once (`planRelationMutationSteps`) and MUST remain the single source of truth so both substrates agree on ordering. Any unified IR must lower from this one ordering.

14. **In-memory parentData mutations are a substrate detail, not semantics:** the tx engine mutates `parentData[fk]=null` and stamps FK values into `parentData`/records; these are how it threads state between statements. The *semantic* content is "downstream correlation must observe the post-mutation FK state." A unified design may represent this via symbols/refs (batch style) but must guarantee the same downstream observation.
