# Semantic Map — Transaction Engine: create / connect / connectOrCreate / dispatch / timing / FK direction

Slice owner scope: the **transaction-path** engine's create family and its shared substrate.
Files fully read for this map:

- `src/query-engine/operations/nested-writes/create.ts` (428 lines) — tx create engine, entry `executeNestedCreate`, `executeRelationCreate`, `executeRelationCreateMany`, `executeSimpleInsert`, before-parent current-FK pass.
- `src/query-engine/operations/nested-writes/connect.ts` (71) — `executeRelationConnect`.
- `src/query-engine/operations/nested-writes/connect-or-create.ts` (93) — `executeConnectOrCreate`.
- `src/query-engine/operations/nested-writes/relation-mutation.ts` (314) — tx dispatch `processRelationMutation`, the `RelationMutationExecutors` injection interface, `txCtx.createdRecords` bookkeeping.
- `src/query-engine/operations/nested-writes/semantic-plan.ts` (373) — the shared step model (`planRelationMutationSteps`, `splitRelationMutationsByFk`, guards, upsert branch planner, dedupe).
- `src/query-engine/operations/nested-writes/fk.ts` (332) — FK direction math for both engines.
- `src/query-engine/operations/nested-writes/atomic-runner.ts` (41) — substrate gate.
- `src/query-engine/operations/nested-writes/assertions.ts` (157) — single-input guards, correlated-rows guard, batch assert helpers.
- `src/query-engine/operations/nested-writes/record-access.ts` (162) — fetch-one helpers + `recordNotFoundError` taxonomy.
- `src/query-engine/operations/nested-writes/planned-mutation.ts` (50) — planned-mutation rejection in create branches.
- `src/query-engine/builders/relation-data-builder.ts` — `separateData`, `parseRelationMutation`, `getFkDirection`, `FkDirection`, `buildConnectFkValues`, `needsTransaction`/`canUseSubqueryOnly`.
- `src/query-engine/transaction-flow.ts` — the top-level entry (`executeWithNestedWrites`, `runNestedWriteOperation`, `executeCreateWithNestedWrites`, upsert/update orchestration, race-retry).

Cross-read for divergence analysis (owned by other mappers, summarized only where they touch create/connect): `batch-plan.ts` (`appendCreateRecord`, `appendUpsertRecord`), `batch-relations.ts` (`appendBeforeParentCreateRelation`, `appendRelationCreate`, `appendConnectOrCreate`), `batch-references.ts` (`PlanState`, `BatchRecordRef`, value-refs), `update.ts`, `upsert.ts`.

---

## 0. The two substrates and the single entry decision

`transaction-flow.ts :: runNestedWriteOperation` is the fork.

```
if (!driver.supportsTransactions && driver.supportsBatch && isNestedBatchOperation(op))
    -> executeNestedWriteBatch   (BATCH substrate; batch-plan.ts)
else
    -> executeCreate/Update/UpsertWithNestedWrites  (TX substrate; my slice)
```

Key first-principles fact: **the choice of substrate is made purely by driver capability**, never by the semantics of the write. Both substrates receive the exact same `args` and must produce the same persisted state (that is what `tests/query-engine/nested-write-conformance.test.ts` asserts on PGlite by driving both paths).

`atomic-runner.ts :: runNestedMutationAtomically(driver, op, run)` is the tx substrate's atomicity primitive:
- `supportsTransactions` → `driver.withTransaction(run)` (interactive tx, real interleaved read/write).
- `supportsBatch` (but no tx) → **throws** `QueryEngineError` "reached the transaction-only nested path, but this driver requires planned atomic batch execution". This is the invariant that the batch driver must never enter the tx path — the fork in `runNestedWriteOperation` already routed it away; this throw is a defense-in-depth assertion.
- neither → throws "cannot execute atomically" `QueryEngineError`.

So the tx engine assumes it can **read a row it just wrote, in the same tx, and branch on the result**. That capability is the entire reason it exists as a separate engine.

---

## 1. Top-level tx create entry: `executeCreateWithNestedWrites` (transaction-flow.ts:212)

Steps:

1. `separateData(ctx, data)` → `{ scalarData, relations }`. `separateData` walks `data`; any key that `isRelation` gets `parseRelationMutation`'d into a `RelationMutation`; everything else is a scalar. Unsupported nested keys on a relation throw `NestedWriteError` at parse time.
2. `assertNoPlannedNestedMutationExecution(relations, "create")` — rejects `update`/`updateMany`/`upsert`/`deleteMany` on any relation of a **create** (message: "not supported in parent create. Only create, createMany, connect, and connectOrCreate are allowed there"). This is a **semantic invariant of the create branch**, not an engine limitation: you cannot update/delete children of a row that does not yet exist.
3. Fast path decision: `canUseSubqueryOnly(relations) && !hasMultipleConnects`.
   - `canUseSubqueryOnly` == `!needsTransaction`. `needsTransaction` returns true if ANY mutation has `create/createMany/connectOrCreate/delete/set/update/updateMany/upsert/deleteMany/connect`, or a `disconnect`. In practice for create, only pure single-`connect` on a current-holds-FK relation survives as subquery-only (because `connect` alone still returns true — see caveat below).
   - **Caveat / subtlety**: `needsTransaction` returns `true` for `mutation.connect` unconditionally (line 678). So a create whose only nested op is a single `connect` **does** report `needsTransaction`, meaning `canUseSubqueryOnly` is false → it goes to `executeNestedCreate`, NOT the subquery fast path. The `hasMultipleConnects` guard and the fast-path `connect` FK-injection code in `executeCreateWithNestedWrites` are effectively dead for the common case *unless* something upstream shortcuts. Any unification MUST preserve the observable result (a single connect assigns FK to the parent insert) regardless of which branch runs. This is a latent redundancy worth flagging but not a behavior bug.
   - Fast path, when taken: for each `connect` step where the relation has `fields` (current holds FK), compute `buildConnectFkValues` and merge into `dataWithFks`, then a single `buildCreate` INSERT (possibly with a correlated subquery for the FK), executed via `executeNonReturningMutation` or direct `_execute`. Result parsed by `parseOperationResult`.
4. Slow path: `createResult = await executeNestedCreate(driver, ctx, data)`.
5. Post: if `args.include || args.select`, refetch by provided PK via `buildFindUniqueQuery`; else Prisma parity → return `createResult.record` (scalars only).

---

## 2. The core tx create engine: `executeNestedCreate` (create.ts:54)

Signature: `(driver, ctx, data) -> { record }`.

```
separated = separateData(ctx, data); scalarData = {...separated.scalarData}
assertNoPlannedNestedMutationExecution(relations, "create")
if no relations:  return { record: executeSimpleInsert(driver, ctx, scalarData) }   // non-atomic, single INSERT

runNestedMutationAtomically(driver, "create", async tx => {
  txCtx = { generatedIds: Map, createdRecords: Map }
  { currentHoldsFk, relatedHoldsFk } = splitRelationMutationsByFk(ctx, relations)

  // PHASE A — BEFORE parent insert (relations whose FK lives on the PARENT row)
  for [name, mutation] of currentHoldsFk:
     processCurrentFkMutationBeforeParentCreate(tx, ctx, name, mutation, scalarData, txCtx)

  // PHASE B — parent insert
  parentRecord = executeSimpleInsert(tx, ctx, scalarData)   // scalarData now carries injected FK columns
  parentId = parentRecord[getPrimaryKeyField(ctx.model)]
  txCtx.generatedIds.set("__parent__", parentId)

  // PHASE C — AFTER parent insert (relations whose FK lives on the CHILD/related row, + m2m)
  for [name, mutation] of relatedHoldsFk:
     processRelationMutation(tx, ctx, name, mutation, "after", parentRecord, txCtx,
        { create: executeRelationCreate, createMany: executeRelationCreateMany })

  return { record: parentRecord }
})
```

### 2.1 Why the before/after split exists (the FK-direction ordering law)

This is the load-bearing ordering rule and it is dictated by **FK direction**, computed by `getFkDirection`:

- **currentHoldsFk (`fkDir.holdsFK === true`)**: the parent row has a NOT-yet-known FK column that must point at the related row. Therefore the related row (or the connect target) MUST exist *before* the parent INSERT, so its PK can be written into the parent's FK column. → Phase A ("before"). The child PK flows **into** `scalarData` via `assignCurrentFkValuesFromRecord`.
- **relatedHoldsFk (`fkDir.holdsFK === false`)**: the child row carries the FK pointing back at the parent. The parent PK is unknown until its INSERT returns. Therefore children MUST be written *after* the parent. → Phase C ("after"). The parent PK flows **from** `parentRecord` into each child via `assignRelatedFkValuesFromParent`.
- **manyToMany**: `splitRelationMutationsByFk` forces m2m into `relatedHoldsFk` (junction rows need the parent PK, so they are written after). `getFkDirection` itself **throws** on m2m — m2m must never be asked for a direction; it is routed to `processManyToManyMutation` inside `processRelationMutation` before any direction query.

The value that flows between phases is always a **primary key** (single or compound), read from an already-persisted or freshly-inserted row.

### 2.2 `getFkDirection` semantics (relation-data-builder.ts:438) — the shared truth both engines call

```
if type === manyToMany: throw (no FK direction)
holdsFK = !!(relationInfo.fields?.length)     // this relation declared .fields([...])
if holdsFK:
   { holdsFK:true, fkFields: fields, pkFields: references ?? PK(targetModel), fkHolder: ctx.model, referenced: targetModel }
else:
   inverse = findInverseRelationState(ctx.model, relationInfo)   // scans TARGET model for a relation whose getter() === ctx.model AND has .fields
   if !inverse: throw "Cannot determine FK fields"
   { holdsFK:false, fkFields: inverse.fields, pkFields: inverse.references?.length ? inverse.references : PK(ctx.model), fkHolder: targetModel, referenced: ctx.model }
```

Subtleties any unified design MUST preserve:
- The **m2m early throw ordering** (comment lines 442-444): it must run before inverse scanning, otherwise a back-pointing to-one relation on the target (e.g. `tag.featuredIn`) would be mistaken for the inverse FK.
- `pkFields` is **not always the PK**: for related-holds-FK, it prefers the inverse relation's `references` (the fields on `ctx.model` the FK actually points at), falling back to `getPrimaryKeyFields(ctx.model)` only when references are absent. This matters for FK-to-unique-non-PK relations.
- `findInverseRelationState` disambiguates multiple candidate inverses by explicit `.name()`.

### 2.3 Phase A detail: `processCurrentFkMutationBeforeParentCreate` (create.ts:116)

Guards: `if (!fkDir.holdsFK) throw` (defensive — split already guaranteed it). Then walks `planRelationMutationSteps(name, mutation, "before")` and handles ONLY:

- **create**: if to-one, `assertSingleRelationInput`. For each createData, `executeRelationCreate(tx, ctx, relInfo, createData, "before", scalarData)`. Take `createdRecords[0]`, `assignCurrentFkValuesFromRecord(fkDir, firstRecord, scalarData, name)` — writes child PK into parent's FK columns in `scalarData`. Stores into `txCtx.createdRecords` (array if to-many else single).
- **connect**: if to-one, `assertSingleRelationInput`. `fetchRequiredUniqueRecord(tx, ctx, targetModel, inputs[0], {op:"connect", kind:"target"})` (throws `NestedWriteError` "target record was not found" if missing). `assignCurrentFkValuesFromRecord` from the fetched target into `scalarData`.
- **connectOrCreate**: if to-one, `assertSingleRelationInput` on the `.where`s. `executeConnectOrCreate(tx, ctx, relInfo, inputs[0], "before", scalarData, txCtx, executeRelationCreate)`. If a record comes back, assign its PK into `scalarData` and store in `txCtx.createdRecords`.
- **default** → `throwUnsupportedNestedCreate`.

Note the "before" step handling is a **restricted subset** — `disconnect/delete/set/update/...` never legally reach here for currentHoldsFk on a create (planned ones already rejected; the rest only appear on to-many/related-holds-FK which are in Phase C).

### 2.4 Phase C detail: dispatch through `processRelationMutation` with a 2-executor set

For create, Phase C injects only `{ create: executeRelationCreate, createMany: executeRelationCreateMany }`. `processRelationMutation` (see §4) will therefore, for a create context, only ever legally exercise create/createMany/connect/connectOrCreate/(set/disconnect/delete via built-in defaults?) — but note **assertNoPlannedNestedMutationExecution already stripped update/updateMany/upsert/deleteMany**, and `disconnect/delete/set` are semantically meaningful on an existing to-many during *create*? No: they operate on children that would have to pre-exist and be attached to a not-yet-existing parent, which is impossible, so in practice only create/createMany/connect/connectOrCreate flow here. (The dispatch still contains the full switch because the same function serves update.)

---

## 3. `executeRelationCreate` and `executeRelationCreateMany` — the recursive child insert

### 3.1 `executeRelationCreate` (create.ts:241) `(tx, ctx, relInfo, createData, timing, parentData) -> record`

```
fkDir = getFkDirection(ctx, relInfo)
childCtx = createChildContext(ctx, targetModel, nextAlias())
dataWithFk = {...createData}
if timing==="after" && !fkDir.holdsFK:  assignRelatedFkValuesFromParent(fkDir, dataWithFk, parentData)  // stamp parent PK into child FK cols
{ scalarData, relations } = separateData(childCtx, dataWithFk)
record = relations.length>0 ? (await executeNestedCreate(tx, childCtx, dataWithFk)).record   // RECURSION
                            : await executeSimpleInsert(tx, childCtx, scalarData)
if timing==="after" && fkDir.holdsFK:   // parent holds FK, but we are in "after" — only reachable from the update path on an existing parent
   connectCreatedRecordToCurrentParent(tx, ctx, relInfo, record, parentData, "create")   // UPDATE parent row's FK to point at created child
return record
```

Timing × direction matrix for `executeRelationCreate` (this is the crux of the timing contract):

| timing  | fkDir.holdsFK | FK stamping                                                  | when reached |
|---------|---------------|-------------------------------------------------------------|--------------|
| before  | true          | none here (caller `processCurrentFkMutationBefore...` reads returned PK into parent scalarData) | Phase A of create |
| before  | false         | none (contradiction — related holds FK but we create before parent; not produced by create split) | — |
| after   | false         | stamp parent PK into child FK cols before insert            | Phase C of create; update path |
| after   | true          | insert child first, then UPDATE parent row to point FK at child (`connectCreatedRecordToCurrentParent`) | update path on existing parent (parent already exists so "after" is fine), and to-one upsert create branch |

The comment at create.ts:265-266 states plainly: `"after" + parent holds FK only happens for nested writes on an existing parent (update path)`. During a fresh create, parent-holds-FK relations are Phase A ("before").

### 3.2 `executeRelationCreateMany` (create.ts:281) `(tx, ctx, relInfo, createManyInput, parentData) -> record[]`

- `if fkDir.holdsFK: throw` — createMany only for to-many where **related** holds FK (you cannot createMany rows the parent must point a single FK at).
- Empty data → `[]`.
- Stamp parent PK into every row via `assignRelatedFkValuesFromParent`.
- `buildValues` → columns/values; empty → throw "No data to insert".
- INSERT with optional `skipDuplicates` (adapter `mutations.skipDuplicates()` prefix/suffix). If adapter has RETURNING, `_execute` + `translateRowToFieldNames`. If NOT: execute insert, then for each row require a provided PK (`getProvidedPrimaryKeyWhere`, else throw "must provide a primary key when RETURNING is not supported"), refetch each via `fetchRequiredUniqueRows`.

### 3.3 `executeSimpleInsert` (create.ts:372) — the atomic leaf write

- `buildValues(ctx, data)`; empty columns → throw "No data to insert".
- INSERT. If RETURNING supported: `_execute`, empty rows → throw "Insert did not return a record", else `translateRowToFieldNames(model, rows[0])` (RETURNING * yields raw column names; translated at this **choke point** so downstream FK propagation & result read field names).
- If NOT RETURNING: execute; `getCreateRefetchWhere(driver, ctx, data, modelName, insertResult.insertId)` (uses provided PK or lastInsertId); `fetchRequiredUniqueRows`; return row[0].

**Contract: `executeSimpleInsert` always returns a record keyed by field names, with the primary key populated** (whether provided, generated-and-returned, or refetched). Every FK-propagation step downstream relies on this.

---

## 4. Dispatch: `processRelationMutation` (relation-mutation.ts:81)

The single tx dispatcher shared by create (Phase C), update, upsert. Injected `RelationMutationExecutors` decide which ops are legal in the current context (create injects only create+createMany; update injects create/createMany/update/updateMany/deleteMany; connect/connectOrCreate/disconnect/delete/set/upsert use module-level defaults or `??` fallbacks).

Flow:
```
if relInfo.type === manyToMany: processManyToManyMutation(...); return   // BEFORE any getFkDirection
for step of planRelationMutationSteps(name, mutation, timing):
   switch step.kind:
     create:          for each input -> executors.create(..., timing, parentData); setCreatedRecords
     createMany:      if timing!=="after" break; executors.createMany; appendCreatedRecords
     connect:         if timing!=="after" break; for each -> executeRelationConnect
     connectOrCreate: for each -> executeConnectOrCreate(..., timing, ...); appendCreatedRecords
     disconnect:      if after -> executeRelationDisconnect
     delete:          if after -> executeRelationDelete
     set:             if after -> executeRelationSet
     update:          if after -> assertExecutor; executors.update
     updateMany:      if after -> assertExecutor; executors.updateMany
     deleteMany:      if after -> (executors.deleteMany ?? executeRelationDeleteMany)
     upsert:          if after -> (executors.upsert ?? executeRelationUpsert)
```

Critical timing rule embedded here: **every step except `create` and `connectOrCreate` is gated on `timing === "after"`**. `create` and `connectOrCreate` run in BOTH timings (because they can be Phase A current-holds-FK operations that must precede the parent insert). All link-side operations (connect/disconnect/delete/set/update/...) presuppose the parent row exists, hence after-only.

`connect` is after-only here (line 148) — so during a *create*, `connect` on a currentHoldsFk relation is handled in **Phase A** by `processCurrentFkMutationBeforeParentCreate` (§2.3), NOT here. Here (Phase C / related-holds-FK) connect means "point an existing child's FK at this parent", which legitimately needs the parent to exist first.

### 4.1 `txCtx.createdRecords` bookkeeping (relation-mutation.ts:275-301)
- `setCreatedRecords(txCtx, name, isToMany, records)`: sets `name -> isToMany ? records[] : records[0]`.
- `appendCreatedRecords(txCtx, name, records, isToMany=true)`: to-one → overwrite with `records[0]`; to-many → concat with existing array.
- `TransactionContext` (create.ts:46) = `{ generatedIds: Map<string,unknown>, createdRecords: Map<string, record|record[]> }`. `generatedIds` holds `"__parent__" -> parentId` (set in create.ts:94 and update.ts:60). **`createdRecords` is consumed only by `executeNestedUpdate`** (update.ts:81-90) to build the `related` return map; the tx create path builds `txCtx.createdRecords` but `executeNestedCreate` returns only `{ record: parentRecord }` and **ignores createdRecords entirely**. So during pure create, `createdRecords`/`generatedIds` are written but never read — dead bookkeeping on the create path. Flag for unification: the batch engine has no analog (it tracks PKs via `BatchRecordRef` value-refs), so this Map is a tx-substrate-only artifact.

### 4.2 `assertExecutor` — the context-legality guard
`assertExecutor(name, op, executor)` throws `NestedWriteError` "cannot run in this mutation context" if an executor for update/updateMany is absent. This is how the create context (which injects no `update`) would reject an update step if one slipped past `assertNoPlannedNestedMutationExecution`. Belt-and-suspenders with the planned-mutation guard.

---

## 5. `executeRelationConnect` (connect.ts:16)

`(tx, ctx, relInfo, connectInput, parentData, _txCtx) -> void`. Two branches by direction:

- **holdsFK (parent holds FK)**: `fetchRequiredUniqueRecord(target)` (throws target-not-found if missing) → `buildCurrentFkValueAssignmentsFromRecord` (also mutates `parentData` FK fields in place) → `UPDATE parent SET fk=... WHERE <parent PK match>` via `buildCurrentRecordMatchCondition` → `throwIfNoCorrelatedRowsAffected(result, name, "connect")` (throws correlated-not-found if 0 rows).
- **!holdsFK (child holds FK)**: build `whereClause = buildWhereUnique(childCtx, connectInput, targetTable)`, `buildFkValueAssignments` (parent PK → child FK cols) → `UPDATE targetTable SET fk=<parentPK> WHERE <connectInput unique>` → `throwIfNoCorrelatedRowsAffected`.

Contract subtleties:
- The holdsFK branch **reads the target first** (existence check via required fetch) then updates the parent; the child-holds-FK branch does **not** pre-fetch — it relies on the UPDATE's rowCount==0 to detect a missing target. So a `connect` to a non-existent record throws `target` kind in the parent-holds-FK direction but `correlated` kind in the child-holds-FK direction. Both are `NestedWriteError`; message differs ("target record was not found" vs "...not found for this parent"). Any unification MUST preserve which error kind each direction throws (conformance/behavior suites pin the messages).

---

## 6. `executeConnectOrCreate` (connect-or-create.ts:19)

`(tx, ctx, relInfo, input, timing, parentData, txCtx, createRelation) -> record | undefined`.

```
childCtx; whereClause = buildWhereUnique(childCtx, input.where, alias)
SELECT * FROM target alias WHERE <where> LIMIT 1   // read-branch decision
if rows.length > 0:
   found = translate(rows[0]); fkDir = getFkDirection
   if fkDir.holdsFK && timing==="after":   // parent holds FK, parent exists
        connectCreatedRecordToCurrentParent(...); return found
   if !fkDir.holdsFK && timing==="after":   // child holds FK
        executeRelationConnect(tx, ctx, relInfo, input.where, parentData, txCtx)
        refetch via same selectSql; return refetched ?? found
   return found                             // timing==="before" (parent holds FK, Phase A) — caller reads PK into parent scalarData
else:
   return createRelation(tx, ctx, relInfo, input.create, timing, parentData)   // MISS -> create with same timing
```

The **read decides the branch at runtime** — this is the archetypal "read that decides a branch" the orchestrator frame names. When found + before: it returns the found record and lets Phase A stamp its PK into the parent (no write here). When found + after: it links (parent-side UPDATE or child-side UPDATE). When missing: recurse into `createRelation` (which is `executeRelationCreate`, carrying timing forward — so a missing connectOrCreate in Phase A creates the child before the parent, exactly like a plain create).

---

## 7. Supporting FK math (fk.ts) — shared, used by both engines

Two families, distinguished by call-site substrate:

- **Runtime-value family (tx)**: operate on concrete records/`parentData` values.
  - `assignCurrentFkValuesFromRecord(fkDir, targetRecord, parentData, name)`: parent FK cols ← target PK values (`getRequiredTargetPkValue` reads `record[pkField] ?? record[pkColumn]`, throws if absent).
  - `assignRelatedFkValuesFromParent(fkDir, targetData, parentData)`: child FK cols ← parent PK values (no throw — plain copy).
  - `buildCurrentFkValueAssignmentsFromRecord`: returns `Sql[]` SET assignments AND mutates `parentData[fkField]` — throws if target PK missing.
  - `buildCurrentRecordMatchCondition(ctx, parentData)`: WHERE on `ctx.model` PK from `parentData`; throws "parent record is missing primary key field" if any PK undefined/null. This is the correlation the tx engine uses to re-find the just-inserted parent.
  - `connectCreatedRecordToCurrentParent`: UPDATE parent SET fk=childPK WHERE parentPK; `throwIfNoCorrelatedRowsAffected`.
- **Batch/symbolic family**: `assignCurrentFkValues`, `assignRelatedFkValues`, `buildCurrentFkAssignments`, `buildCurrentFkAssignmentsFromConnect`, `updateCurrentRecord` — operate over `BatchResolvableValue` (may be a `BatchValueRef` symbol resolved to a batch-ref SQL read at execution). These are the batch engine's analog and are NOT used by my slice's tx path, but they read the **same `getFkDirection`** so the field/PK mapping is guaranteed identical. This shared reliance on `getFkDirection` is the single strongest existing unification seam.

`buildFkMatchCondition` / `combineWithParentCorrelation` are used by both (tx update/upsert and batch) to build correlated WHEREs; they are direction-aware and adapter-delegated.

---

## 8. The shared step model: `semantic-plan.ts`

Both engines call `planRelationMutationSteps(name, mutation, timing)` → an ordered `NestedWriteStep[]` derived from which keys are present on the `RelationMutation`, in a **fixed emission order**: create, createMany, connect, connectOrCreate, disconnect, delete, set, update, updateMany, deleteMany, upsert. This ordering is a semantic contract (e.g. within one mutation, create precedes connect precedes set). Any unified compiler MUST preserve this emission order because combined-op end-state depends on it.

Other shared plan pieces:
- `splitRelationMutationsByFk(ctx, relations)` → `{currentHoldsFk, relatedHoldsFk}` (m2m forced to related side; §2.1). Called by BOTH `executeNestedCreate` and batch `appendCreateRecord`.
- `dedupeConnectOrCreateInputs`: repeated connectOrCreate targets in one array collapse to first (comment lines 319-323): the tx engine's second pass would *connect* the dupe, but the batch engine would abort on its `uniqueMissing` assertion — so dedupe up front makes both engines agree ("first create wins"). **This is an existing divergence-avoidance patch living in the shared layer** — strong evidence the maintainer already reaches for a shared semantic model.
- `assertManyToManyStepCombinationIsSupported`: rejects `deleteMany` combined with create/connect/connectOrCreate/set on one m2m relation, precisely *because* "the tx engine executes ... before deleteMany, while the batch engine resolves deleteMany targets at plan time — combining them would silently produce different end states." Another documented divergence, converted into a typed error rather than silent drift.
- `planExistingUpsertBranch` + `NestedWriteGuard` union (`uniqueExists|uniqueMissing|uniqueWithWhereExists|uniqueWithWhereMissing`): the upsert branch decision, shared. The tx engine consumes the branch by *executing* reads/writes; the batch engine consumes the same branch by emitting **guard assertions** (`appendPlanGuard`). Same decision object, two lowerings — a template for what unification should look like everywhere.

---

## 9. `separateData` / `parseRelationMutation` (shared parse) — invariants

- Ignores `undefined` values.
- A relation value that isn't a supported nested-write envelope but IS a non-empty object → throws `NestedWriteError` "Unsupported nested write operation". Empty/`null`/array → returns `undefined` (dropped).
- Parses each supported key with per-op validation (`parseNestedUpdateInput` etc.), throwing typed `NestedWriteError` on malformed envelopes and on to-one/to-many mismatch (e.g. `updateMany`/`deleteMany` rejected for to-one via `rejectToOneOperation`; to-one `upsert`/`update` require object envelope not array).
- Both engines call `separateData` identically at every nesting level, so parse-time validation is already unified. **Invariant: parse errors are engine-independent** and thrown before any substrate branch.

---

## 10. Error taxonomy (record-access.ts + assertions.ts) — must be preserved exactly

`recordNotFoundError({relationName, operation, kind})` produces three distinct messages:
- `target`: "Cannot {op} relation '{name}': target record was not found." — referenced record absent.
- `correlated`: "...: target record was not found for this parent." — exists but not attached to this parent.
- `nested-write`: "Cannot {op} nested write: target record was not found." — top-level batch target missing.

`throwIfNoCorrelatedRowsAffected(result, name, op)`: `rowCount>0` ok, else `correlated`. Used by connect (child-holds-FK), `connectCreatedRecordToCurrentParent`.

`assertSingleRelationInput(name, op, inputs)`: >1 input on a to-one → throw. `assertFkCanBeSetNull` / `getNonNullableFkFields`: disconnect-time NOT-NULL FK check (used by disconnect, not create, but shared).

**Contract**: the *kind* of not-found error is determined by direction and by whether a correlation was involved. Both engines must throw the same kind for the same scenario. The `assertions.ts` batch helpers (`appendAssertUniqueExists/Missing`, `appendAssertWhere...`) are the batch engine's way to reproduce these as `adapter.assertions.exists/notExists` SQL guards that raise at execution — meaning the *same premise* is checked, but the tx engine checks it with a pre-read + typed throw while the batch engine defers it to an in-SQL assertion. See divergences.

---

## 11. Race-retry semantics (transaction-flow.ts:108-129) — tx-substrate-only contract

`executeWithNestedWrites` wraps `runNestedWriteOperation` in try/catch:
- If `isWriteRaceLoserError(error)` (UniqueConstraintError, or DEADLOCK / SERIALIZATION_FAILURE VibORM codes) **and** `hasRaceableCreateBranch(op, args)` (upsert always; create iff args.data contains a `connectOrCreate` or `upsert` anywhere) → **re-run the whole operation once**.
- Rationale (verbatim comment): `SELECT ... FOR UPDATE` cannot lock absent rows, so two concurrent upserts/connectOrCreates of a missing key can both take the create branch; the loser rolls back with a unique violation (PG/SQLite) or gap-lock deadlock (MySQL); rerun sees the winner's committed row and takes the update/found branch.

This retry lives **only in the tx entry**. The batch substrate has no interactive FOR UPDATE and no such retry loop — it emits guard assertions that would fail the batch atomically. **Divergence**: concurrent-create-of-same-unique behavior differs by substrate (tx retries and converges; batch fails the atomic batch). Any unification must decide where this retry lives and whether the batch path needs an equivalent (currently it does not have one; the conformance suite runs single-threaded so it does not catch this).

---

## 12. DIVERGENCES between the two engines (create/connect slice)

1. **Branch resolution time**. TX: reads happen at execution and branch at runtime (`executeConnectOrCreate` SELECT decides found/miss; upsert SELECT ... FOR UPDATE decides existing/missing). Batch: the SAME reads happen at **plan build time** (via `fetchOptional*` against the live driver), the branch is baked into the emitted statement list, and a **guard assertion** (`appendAssertUnique*`, `appendPlanGuard`) is emitted to fail the batch if the premise went stale between planning and execution. Observable behavior is meant to match; the staleness window is the risk.
2. **Existence enforcement mechanism**. TX connect/connectOrCreate enforce target existence with a required pre-read (`fetchRequiredUniqueRecord` → typed `NestedWriteError`) or via UPDATE rowCount==0 (`throwIfNoCorrelatedRowsAffected`). Batch enforces the same via `adapter.assertions.exists/notExists` SQL guards. Same premise, different failure surface (typed error thrown by engine vs adapter assertion SQL raising mid-batch). The error *message* for a batch guard failure is adapter-defined, not `recordNotFoundError` — potential message divergence to verify.
3. **PK propagation carrier**. TX carries a concrete inserted record (`executeSimpleInsert` returns real PK, possibly refetched / lastInsertId). Batch carries a symbolic `BatchRecordRef`/`BatchValueRef` resolved via `batchRefs.storeLastInsertId`/`read` (`getBatchPrimaryKeyRef`, `appendGeneratedPrimaryKeyStores`). Consequence: batch **cannot propagate generated compound PKs** (`getBatchPrimaryKeyRef` throws) and requires known-before-execution PKs for `getStaticPrimaryKeyWhere`; TX has no such restriction (it reads the generated value). This is a real capability gap, currently surfaced as a typed `NestedWriteError` on the batch side.
4. **connect fast-path**. TX create has a subquery-only fast path (`executeCreateWithNestedWrites`) that folds a single current-holds-FK connect into the parent INSERT via `buildConnectFkValues` (possibly a correlated subquery). The batch engine always plans connect as an assert-exists + FK injection (`appendBeforeParentCreateRelation` connect case). Same end state; different statement shape. (Also note §1's caveat that `needsTransaction` makes this fast path rarely taken.)
5. **`txCtx.createdRecords`/`generatedIds`** exist only in the tx substrate and are largely dead on the create path (consumed only by `executeNestedUpdate`). Batch has no equivalent — it needs none because PKs are value-refs. Unification should drop this artifact, not port it.
6. **Race retry** (§11) is tx-only.
7. **connectOrCreate "found + after, child-holds-FK" refetch**: TX refetches after linking to return the post-link record (connect-or-create.ts:74-79). Batch returns the pre-link `existing` primaryKey (batch-relations.ts:390) without refetch. Observable state identical (link is deterministic) but the returned record object differs; only matters if a caller reads returned columns beyond PK.

---

## 13. INVARIANTS any unified design MUST preserve

1. **FK-direction ordering law**: current-holds-FK relations resolve (create/connect/connectOrCreate) and yield a PK *before* the parent INSERT; related-holds-FK and m2m resolve *after*, consuming the parent PK. Derived solely from `getFkDirection`; must remain the single source of direction, with its m2m-throw-before-inverse-scan ordering and its `pkFields = inverse.references ?? PK` rule intact.
2. **The value that crosses phase boundaries is always a primary key** (single or compound), read from a persisted row. A unified IR's "symbol" must be exactly this.
3. **Step emission order** from `planRelationMutationSteps` (create→...→upsert) is semantic and fixed.
4. **`assertNoPlannedNestedMutationExecution` in every create branch**: update/updateMany/upsert/deleteMany are illegal under a fresh create (and under an upsert's create branch, context `upsertCreate`). Only create/createMany/connect/connectOrCreate allowed.
5. **Timing gate**: create and connectOrCreate may run in "before"; every other relation op requires the parent to exist ("after" only).
6. **Error-kind taxonomy** (`target` vs `correlated` vs `nested-write`) is determined by direction + correlation, and each direction of connect throws its specific kind. Messages are pinned by the behavior suites.
7. **Field-name normalization choke point**: any raw DB row (RETURNING *, refetch) is passed through `translateRowToFieldNames` before it becomes `parentData`/a returned record, so all FK propagation and result assembly operate on field names.
8. **Atomicity + substrate gate**: create with relations is atomic (tx or single batch). A tx driver never reaches the batch planner and vice-versa; `runNestedMutationAtomically` enforces this with a throw.
9. **connectOrCreate dedupe ("first create wins")** and **m2m deleteMany-combination rejection** are cross-engine parity guarantees already encoded in the shared plan layer; a unified engine must keep them (ideally as inherent properties, not patches).
10. **Prisma-parity return shape**: create without select/include returns scalars-only (`createResult.record`); with select/include, refetch by provided PK via findUnique. Same for the upsert create branch.
11. **Concurrent create-of-same-unique convergence** (race retry) is currently a tx-only guarantee; a unified design must consciously decide to preserve it uniformly (batch has no equivalent today — a latent parity gap).
