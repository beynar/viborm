# Semantic Map — Shared Layer + Many-to-Many

Scope of this slice:

- `src/query-engine/operations/nested-writes/semantic-plan.ts` (the step model both engines consult) and **both** its consumers (`relation-mutation.ts` tx dispatch, `batch-relations.ts` batch dispatch).
- `src/query-engine/operations/nested-writes/record-access.ts` (fetch-one helpers).
- `src/query-engine/operations/nested-writes/fk.ts` (FK correlation / assignment helpers).
- `src/query-engine/operations/nested-writes/many-to-many.ts` (tx M2M executor) + `src/query-engine/operations/nested-writes/batch-many-to-many.ts` (batch M2M planner) + `src/query-engine/builders/many-to-many-utils.ts` (shared junction SQL builders).

Supporting files read for context (not owned by this slice, but load-bearing for it):
`relation-data-builder.ts` (`RelationMutation`, `FkDirection`, `getFkDirection`, `separateData`), `assertions.ts` (batch assert appenders + `throwIfNoCorrelatedRowsAffected`), `batch-references.ts` (`PlanState`, `BatchValueRef`, `BatchRecordRef`), `batch-plan.ts` (`appendCreateRecord`), `batch-relations.ts` (`appendCorrelatedChildUpdate`, `appendRelationMutation`), `adapters/shared/batch-refs.ts`.

The two engines:
- **tx engine** — interactive-transaction path. Entry `transaction-flow.ts` → `processRelationMutation` (`relation-mutation.ts`) → `processManyToManyMutation` (`many-to-many.ts`). Reads and writes interleave; branches resolve at runtime against live DB state.
- **batch engine** — for drivers without interactive transactions. Entry via batch-plan → `appendRelationMutation` (`batch-relations.ts`) → `appendManyToManyMutation` (`batch-many-to-many.ts`). Emits one ordered statement list; execution-time values are `BatchValueRef` symbols lowered to SQL batch-ref subqueries; branches that need live state are resolved at **plan time** by executing probe reads through the same `driver`, and the premise is re-asserted at execution time by SQL guards (`adapter.assertions.exists / notExists`).

---

## PART A — The shared step model (`semantic-plan.ts`)

`semantic-plan.ts` is the ONE place both engines agree on *what steps a relation mutation decomposes into and in what order*. It contains no SQL and no I/O. Both `processRelationMutation` and `appendRelationMutation` (and both M2M handlers) iterate the identical `planRelationMutationSteps(...)` output.

### A.1 `NestedWriteStep` — the step vocabulary

A discriminated union over `kind`:
`create | createMany | connect | connectOrCreate | disconnect | delete | set | update | updateMany | deleteMany | upsert`.

Each step carries a `RelationPlanContext` = `{ relationName, relationInfo, timing }`. Timing is `"before" | "after"` (see A.4). Inputs are already normalized by shape:
- `create` → `inputs: Record[]` (always array, via `normalizeRecordArray`).
- `connect` → `inputs: Record[]` (array).
- `connectOrCreate` → `inputs: ConnectOrCreateInput[]`, **deduped** (see A.3).
- `set` → `input: Record[]` (already an array by parse-time contract).
- `disconnect` / `delete` → `input: boolean | Record | Record[]` (kept raw; each engine normalizes with `normalizeRecordArray` at use).
- `deleteMany` → `input: Record | Record[]`.
- `update` → `input: Record | NestedUpdateInput | NestedUpdateInput[]`.
- `updateMany` → `input: NestedUpdateManyInput | NestedUpdateManyInput[]`.
- `upsert` → `input: NestedUpsertInput | NestedUpsertInput[]`.

### A.2 `planRelationMutationSteps(relationName, mutation, timing)` — deterministic emission order

Steps are pushed in a **fixed source order** regardless of key order in the caller's input object:
`create, createMany, connect, connectOrCreate, disconnect, delete, set, update, updateMany, deleteMany, upsert`.

**Contract (INVARIANT):** this ordering is the *intra-relation* semantic order. Both engines consume it verbatim, so if a single relation mutation combines multiple keys (e.g. `{ disconnect, connect }`), the disconnect step is emitted — and therefore executed/planned — before the connect step. Any unification must preserve this exact emission order because observable end-state can depend on it (e.g. `set`/`disconnect` before `connect`; `delete` before `update`).

### A.3 `dedupeConnectOrCreateInputs` — a divergence-avoidance shim baked into the shared layer

Repeated `connectOrCreate` entries with the **same `where`** in one array are collapsed to the first (`JSON.stringify(where)` keyed `Set`). Documented rationale in the file: *"the tx engine's second pass would connect, but the batch engine would abort on its uniqueMissing assertion."* This is a shared-layer patch that exists **only to keep the two engines from diverging**. In a unified engine this dedup becomes either unnecessary (single semantics) or an explicit, first-class rule — flag it as a smell that encodes the divergence it papers over.

### A.4 Timing (`"before" | "after"`)

`splitRelationMutationsByFk(ctx, relations)` partitions a parent's relation mutations into:
- `currentHoldsFk` — parent row holds the FK → these are processed **before** the parent row is written (the parent needs the child's PK to fill its FK column). Timing `"before"`.
- `relatedHoldsFk` — child/junction holds the FK → processed **after** the parent row exists (child needs the parent's PK). Timing `"after"`.

**M2M special case (INVARIANT):** `manyToMany` mutations are *always* pushed to `relatedHoldsFk` — "M2M has no FK direction; junction rows are written after the parent row exists, like related-holds-FK mutations." Consistent with `getFkDirection` throwing on `manyToMany` (see B.3). Both M2M handlers hard-gate on `timing === "after"` (tx: early `return` if not after; batch: `appendManyToManyMutation` always passes `"after"` literally).

### A.5 Upsert branch model — `planExistingUpsertBranch` / `ExistingUpsertBranch`

Shared decision logic for the *existing-record* arm of a nested upsert. Given `{ existingRecord, pkWhere, targetWhere?, targetWhereMatched?, setWhere?, setWhereMatched? }` it returns one of:
- `targetWhereSkipped` — a `targetWhere` was supplied but didn't match the existing record; carries a `uniqueWithWhereMissing` guard.
- `setWhereSkipped` — a `setWhere` was supplied but didn't match; carries a `uniqueWithWhereMissing` guard.
- `update` — proceed; optionally carries `targetWhereGuard` / `setWhereGuard` (`uniqueWithWhereExists`) so the batch engine can re-assert the match at execution time.

Guards are constructed by `createUniqueWithWhereGuard` (`UniqueWithWhereGuard = { kind, model, uniqueWhere, where }`). **Note:** this branch model is defined and exported here but is **not consumed by the M2M handlers** in this slice — M2M upsert is implemented inline (see D.10). It is consumed by the to-one/to-many upsert paths (`upsert.ts` / batch upsert), i.e. the sibling slice. It is included here because it is part of the shared step model. The M2M inline upsert re-implements a *different, simpler* branch decision (connected? → update; uncorrelated-but-exists? → throw; else → create), which is itself a **divergence risk surface** any unification must reconcile with this shared branch model.

### A.6 `NestedWriteGuard` — the guard vocabulary

`uniqueExists | uniqueMissing` (bare `{model, where}`) and `uniqueWithWhereExists | uniqueWithWhereMissing` (`{model, uniqueWhere, where}`). These are the *plan-time* description of an invariant the batch engine must assert as SQL. In the tx engine the same invariants are enforced by *reading then branching* at runtime; there is no explicit guard object on the tx side. This asymmetry (guard-as-data vs guard-as-control-flow) is the central structural divergence a unified IR must absorb (see PART F).

### A.7 `assertManyToManyStepCombinationIsSupported` — a shared *typed error*, not a divergence

Both M2M handlers call this first. It throws `NestedWriteError` if `deleteMany` is combined with any of `create | connect | connectOrCreate | set` in one M2M mutation. Rationale in-file: *"The tx engine executes connect/create/set before deleteMany, while the batch engine resolves deleteMany targets at plan time — combining them in one nested write would silently produce different end states per engine."*

**This is the maintainer's values made executable:** rather than let the two engines silently diverge, the shared layer raises a *clear typed error* for the one combination they cannot agree on. A unified engine ideally makes this combination *well-defined* (removing the need for the guard) — but until then, the error is the correct behavior and MUST be preserved. It is an explicit, documented staleness/ordering contract.

### A.8 Normalizers

`normalizeRecordArray` / `normalizeArray` — single-or-array → array. Trivial but load-bearing: both engines must normalize identically, so these live shared.

---

## PART B — `fk.ts` and FK correlation (shared value/SQL helpers)

`fk.ts` is the shared library of FK-correlation SQL and in-memory FK assignment. It is used by the **to-one/to-many** paths of both engines (not by M2M, which uses junction rows instead of FK columns). Included in this slice because it is shared infrastructure both engines consume identically; it is the FK analogue of what `many-to-many-utils.ts` is for junctions.

### B.1 Two families of helpers, split by value substrate

The file contains **near-duplicate pairs** that differ only in whether the value is a concrete JS value (tx) or a `BatchResolvableValue` that may be a `BatchValueRef` (batch):

| Concept | tx-shaped (concrete values) | batch-shaped (may hold `BatchValueRef`) |
|---|---|---|
| assign current-model FK fields from target record | `assignCurrentFkValuesFromRecord` (reads `targetRecord[pkField]`, throws if undefined) | `assignCurrentFkValues` (copies `targetData[pkField]` — may be a ref, no undefined check) |
| assign related-model FK fields from parent | `assignRelatedFkValuesFromParent` | `assignRelatedFkValues` |
| build FK `SET col = value` assignments | `buildCurrentFkValueAssignmentsFromRecord` (also mutates `parentData[fkField]`, throws if undefined) | `buildCurrentFkAssignments` (lowers via `buildScalarSqlValue`) |

**Observation:** this is the same structural duplication the whole project suffers, localized. `buildScalarSqlValue` is the lowering primitive that *already* accepts both a raw JS value and a `BatchValueRef` (it delegates to the adapter's batch-ref read). So the batch/tx value distinction is *already abstracted at the leaf* — the duplication above is at the *assignment-orchestration* layer, not the value-lowering layer. This is a strong hint for unification: express FK assignment once over `Expr = literal | symbol(BatchValueRef) | columnRef`, and the leaf lowering already handles both substrates.

### B.2 Correlation-condition builders (shared, engine-agnostic)

- `buildFkMatchCondition(ctx, fkDir, targetModel, parentData)` — builds the WHERE that correlates a child row to its parent via the FK, honoring FK direction (`holdsFK` branch compares target PK to `parentData[fkField]`; else compares target FK to `parentData[pkField]`). Values go through `buildScalarSqlValue`, so this is substrate-agnostic already.
- `buildCurrentRecordMatchCondition(ctx, parentData)` — WHERE on the parent's own PK(s); **throws `NestedWriteError`** if a parent PK value is `undefined`/`null`. This is the "match the parent row I just / am about to write" condition.
- `combineWithParentCorrelation(...)` — `AND(fkCondition, childCondition)`.
- `buildFkNullAssignments` — `SET fk = NULL` for disconnect.
- `buildFkValueAssignments` — `SET fk = parentData[pk]` (substrate-agnostic via `buildScalarSqlValue`).
- `updateCurrentRecord(ctx, assignments, parentData)` — `UPDATE parentTable SET ... WHERE <parentPkMatch>`. Shared by both engines.
- `buildCurrentFkAssignmentsFromConnect` — FK assignments from a `connect` where-unique input, via `buildConnectFkValues` (which itself emits subqueries when PK not directly supplied).

### B.3 `getFkDirection` throws on M2M (INVARIANT)

`getFkDirection` (in `relation-data-builder.ts`) **throws `QueryEngineError`** for `type === "manyToMany"` *before* any inverse-FK scanning. Rationale in-file: a to-one relation on the target pointing back (e.g. `tag.featuredIn`) would otherwise be mistaken for this relation's FK and silently overwritten. This is why M2M is a completely separate code path in both engines and never touches `fk.ts`. INVARIANT: M2M associations are junction-row writes, never FK-column writes.

### B.4 The one tx-only execute in `fk.ts`

`connectCreatedRecordToCurrentParent(tx, ...)` is the only function in `fk.ts` that *executes* (all others build SQL/mutate in-memory). It runs an `UPDATE parent SET fk=... WHERE parentPk=...` then calls `throwIfNoCorrelatedRowsAffected` (from `assertions.ts`) — i.e. the tx engine enforces "the correlated row existed" by *checking `rowCount` after the fact*, and throws `recordNotFoundError({kind:"correlated"})` on zero rows. The batch engine enforces the same invariant *before* the write with `appendAssertWhereExists`. Same invariant, opposite side of the write. (INVARIANT to preserve; DIVERGENCE in mechanism — see F.)

---

## PART C — `record-access.ts` (shared fetch-one helpers)

The single home for "SELECT * … WHERE … LIMIT 1, execute, translate columns→fields, optionally throw not-found."

### C.1 The `RecordNotFound` error taxonomy (INVARIANT — exact messages)

`recordNotFoundError({relationName, operation, kind})` produces three distinct messages by `kind`:
- `"target"` → *"Cannot {op} relation '{rel}': target record was not found."* (referenced target absent)
- `"correlated"` → *"Cannot {op} relation '{rel}': target record was not found for this parent."* (target exists but not attached to this parent)
- `"nested-write"` → *"Cannot {op} nested write: target record was not found."* (top-level batch nested-write target missing)

These strings are observable behavior; the M2M handlers throw them (sometimes inline, sometimes via these helpers — see D). A unified engine MUST preserve the exact kind→message mapping.

### C.2 The fetch helpers (both engines call these identically)

- `buildSelectOneSql(ctx, model, whereClause)` — `SELECT * FROM t WHERE <clause> LIMIT 1`.
- `buildUniqueWithWhere(ctx, model, uniqueWhere, where)` — `AND(whereUnique, where)`, creating a child context if `model !== ctx.model`.
- `fetchOptionalWhereRecord(driver, ...)` → row or undefined, **translated to field names** (`translateRowToFieldNames`).
- `fetchOptionalUniqueRecord(driver, ...)` → by where-unique.
- `fetchOptionalUniqueWithWhereRecord(...)` → by unique+extra-where.
- `fetchRequiredWhereRecord` / `fetchRequiredUniqueRecord` → same but throw via `recordNotFoundError` when absent.

**Key semantic:** these take a `driver` and *execute a read immediately*. In the tx engine that read observes live in-transaction state. In the batch engine the **same helpers are called at plan time** — the read observes state *before the batch runs*. This is the batch engine's staleness surface: a `connectOrCreate` / `upsert` existence probe reads now, decides a branch now, then emits a guard so the batch aborts if the premise changed by execution time. Both engines call the identical helper; the difference is purely *when* the read happens relative to the writes it informs. (See F for the staleness contract.)

---

## PART D — Many-to-Many, step by step, tx vs batch

Both `processManyToManyMutation` (tx) and `appendManyToManyMutation` (batch) share the exact same skeleton:

1. `assertManyToManyStepCombinationIsSupported(relationName, mutation)` (A.7).
2. `joinInfo = getManyToManyJoinInfo(ctx, relationInfo)` — resolves junction table name, source/target field names, source/target PK field+column, target table name. Uses `getRequiredSinglePrimaryKeyField` for both sides → **INVARIANT: M2M requires a single-column PK on both source and target** (compound PKs unsupported through junctions).
3. `parentValue = buildJunctionParentValue(...)` — the parent PK value as `Sql`, read from `parentData[sourcePkField] ?? parentData[sourcePkColumn]`. Throws `NestedWriteError` "parent record is missing primary key" if null/undefined. In the batch engine `parentData` may hold a `BatchValueRef` for the parent PK (parent row not yet inserted) — `buildScalarSqlValue` lowers it to a batch-ref subquery; the value is NOT eagerly resolved.
4. `for (step of planRelationMutationSteps(relationName, mutation, "after"))` — iterate the **same** shared step list, dispatch by `kind`.

Below, each `kind` — tx mechanism vs batch mechanism vs shared invariant.

### D.1 `create`
- **Shared junction SQL:** `buildJunctionInsert` (`INSERT (source,target) VALUES (parentValue, targetValue)` with `skipDuplicates()` prefix/suffix — connect/create through a junction is idempotent because junction PK is `(source,target)`).
- **tx:** `createChildWithJunctionRow` → `executeNestedCreate(tx, childCtx, createData)` returns the concrete created `record`; `buildJunctionTargetValue(record)` reads a concrete PK; insert junction row now. Created records appended to `txCtx.createdRecords[relationName]` (array, for result assembly).
- **batch:** `appendChildCreateWithJunctionRow` → `appendCreateRecord(driver, state, childCtx, {...createData})` returns a `BatchRecordRef` whose `.primaryKey` may contain a `BatchValueRef`; **that ref record is passed to `buildJunctionTargetValue` as the `targetRecord`**, and `buildScalarSqlValue` lowers the ref to a batch-ref subquery inside the junction INSERT. No `createdRecords` bookkeeping (batch result assembly differs).
- **INVARIANT:** child row inserted first, junction row second, target PK flows from child insert → junction insert. **DIVERGENCE (mechanism only):** concrete PK (tx) vs `BatchValueRef` symbol lowered to SQL (batch). Same helper `buildJunctionTargetValue` absorbs both because its `raw` value is fed through `buildScalarSqlValue`.

### D.2 `connect`
- **tx:** `fetchRequiredUniqueRecord(tx, ..., {operation:"connect", kind:"target"})` — reads the target row NOW, throws `target`-kind not-found if absent; then `insertJunctionRow` with the concrete target record.
- **batch:** `appendAssertUniqueExists(state, ..., connectInput)` (emits a SQL `assertions.exists` guard) + push `buildJunctionInsert(parentValue, buildTargetPkSubquery(...))` — the target PK is resolved by a **scalar subquery** `(SELECT pk FROM target WHERE <unique>)` embedded in the junction INSERT; no read at plan time.
- **INVARIANT:** connect requires the target to exist; a missing target aborts the whole write. **DIVERGENCE:** tx = read-then-throw (`NestedWriteError` `target` kind); batch = SQL exists-guard (adapter assertion error). *Different error object/message shape* between engines for the same failure — a unification target: the batch guard raises the adapter assertion error, not `recordNotFoundError`.

### D.3 `connectOrCreate`
- **Shared:** deduped inputs from `semantic-plan` (A.3).
- **tx:** `fetchOptionalUniqueRecord` NOW; if found → `insertJunctionRow(existing)`; else → `createChildWithJunctionRow(input.create)`.
- **batch:** `fetchOptionalUniqueRecord` at **plan time** to pick the branch; then:
  - found branch → `appendAssertUniqueExists` guard + junction insert via `buildTargetPkSubquery`.
  - not-found branch → `appendAssertUniqueMissing` guard + `appendChildCreateWithJunctionRow`.
- **INVARIANT:** exactly one of {connect existing, create new} per input; the create side must only fire if the target genuinely doesn't exist. **DIVERGENCE + STALENESS:** batch decides the branch from a plan-time read and *pins* that decision with a guard (`uniqueExists`/`uniqueMissing`). If the row is created/deleted by a concurrent writer between plan and execution, the guard aborts the batch (documented staleness contract). tx has no such window (read and write in the same transaction). This is the exact case `dedupeConnectOrCreateInputs` exists to keep aligned.

### D.4 `disconnect`
- **Shared junction SQL:** `buildJunctionSourceMatch` (`junction.source = parentValue`), `buildJunctionTargetIn(subquery)`.
- **tx & batch identical shape:** `disconnect === true` → `DELETE FROM junction WHERE source = parent`. Otherwise, per item, `DELETE FROM junction WHERE source = parent AND target IN (SELECT pk FROM target WHERE <unique>)`.
- **DIVERGENCE:** tx executes each delete; batch pushes each delete statement. No read, no guard — pure junction DML. **This step is essentially already unified** (identical logic modulo execute-vs-push). A good template for what unified backends look like.
- **INVARIANT:** disconnect only removes junction rows, never child rows.

### D.5 `set`
- **tx:** *Resolve every target first* via `fetchRequiredUniqueRecord` (kind `target`) into a `targets[]` array — so a missing target aborts **before** any junction row is deleted; then `DELETE FROM junction WHERE source=parent`; then re-insert a junction row per resolved target.
- **batch:** `DELETE FROM junction WHERE source=parent` first; then per item `appendAssertUniqueExists` guard + junction insert via `buildTargetPkSubquery`.
- **INVARIANT (ordering + atomicity):** `set` = replace the entire connected set; on any missing target the operation must not partially apply. **DIVERGENCE (subtle, important):** tx resolves-all-then-deletes-then-inserts (delete happens *after* validation); batch deletes-first-then-guards-inserts (delete happens *before* the exists guards). Both are atomic w.r.t. their substrate (tx transaction; batch all-or-nothing statement list with assertion aborts), so observable end-state is identical — but the *internal ordering of the DELETE relative to the existence check is inverted between engines*. A unified engine must pick one ordering and prove it preserves the "all-or-nothing on missing target" invariant on both substrates.

### D.6 `delete` (by unique) and `delete: true` (all connected)
- **Shared deletion primitive (tx):** `deleteChildrenAndJunctionRows(tx, ctx, relationInfo, joinInfo, pks)` — deletes junction rows **first** (so the child delete can't trip FK constraints), then child rows by PK `IN (...)`. On **self-referential** relations it also deletes junction rows where the child is the *source* (`OR source IN (pks)`), because the child ceases to exist from either side. `pks` come from `fetchConnectedTargetPks` (SELECT target PKs joined through junction membership).
- **tx `delete:true`:** `fetchConnectedTargetPks(..., undefined)` (all connected) → `deleteChildrenAndJunctionRows`.
- **tx `delete: unique`:** per item, build where-unique, `fetchConnectedTargetPks(..., uniqueWhere)`; if `pks.length === 0` throw inline `NestedWriteError` "target record was not found for this parent" (correlated-kind message, **hand-written inline, not via `recordNotFoundError`**); else delete.
- **batch `delete:true`:** routed through `appendJunctionDeleteMany(..., filter={})` — i.e. treated as *unfiltered deleteMany* (resolve target set at plan time while junction rows still exist).
- **batch `delete: unique`:** `appendJunctionDelete` per item: emit `assertions.exists` guard (connected-check subquery: `SELECT 1 FROM junction WHERE source=parent AND target IN (subquery) LIMIT 1`), then `DELETE FROM junction WHERE <buildJunctionDeleteCondition>`, then `DELETE FROM target WHERE <where-unique>`. **Note (documented in-file):** the child is deleted by its *own where-unique* — NOT a subquery on the child table — because "MySQL rejects a mutation target appearing in its own subquery."
- **Shared self-ref junction condition (batch):** `buildJunctionDeleteCondition` mirrors the tx self-ref `OR source IN (...)` logic.
- **INVARIANT:** delete removes both the child row and every junction row referencing it (from any parent), junction-first for FK safety; self-referential relations also clear source-side junction rows. **DIVERGENCE:** tx resolves connected PKs then bulk-deletes; batch (unique) uses a per-row exists-guard + delete-by-unique to avoid MySQL self-subquery limits and to avoid needing the PK set at plan time. Missing-target error differs: tx throws `NestedWriteError` inline; batch aborts on the `assertions.exists` guard.

### D.7 `deleteMany`
- **tx:** per input, `buildWhere(childCtx-with-mutationTable, input, targetTable)` → `fetchConnectedTargetPks(..., filterWhere)` → `deleteChildrenAndJunctionRows`.
- **batch:** `appendJunctionDeleteMany` per input. **Critical batch precondition:** `if (isBatchValueRef(rawParentPk)) throw NestedWriteError("...requires the parent primary key to be known before execution.")` — filtered M2M deleteMany **cannot** run when the parent PK is still a batch ref, because the filter must be evaluated (via `fetchConnectedTargetPks`) at plan time. Then it resolves matching target PKs at plan time (`// ponytail:` comment: rows added between planning and execution are NOT covered), and pushes `DELETE junction WHERE target IN (pks)` + `DELETE target WHERE pk IN (pks)`. Empty result → no statements.
- **INVARIANT:** deleteMany deletes child rows (and their junction rows) matching a filter among rows connected to this parent. **DIVERGENCE + STALENESS:** tx evaluates the filter against live state at execution; batch evaluates it at plan time and materializes a fixed PK list (staleness window: rows connected after planning are missed; a `BatchValueRef` parent PK is an outright error). This is the single largest observable-behavior gap in the M2M slice and the reason `assertManyToManyStepCombinationIsSupported` forbids mixing deleteMany with create/connect/set.

### D.8 `update` (by where-unique)
- **Shared correlation:** `buildConnectedUniqueWhere(ctx, childCtx, joinInfo, parentValue, whereUnique)` = `AND(whereUnique-on-target, buildJunctionMembership)` — i.e. "the target row identified by this unique input AND it is currently connected to this parent." `buildJunctionMembership` = `target.pk IN (SELECT junction.target FROM junction WHERE source=parent)`.
- **tx:** per normalized `{where,data}`, `executeSingleRelationUpdate(tx, childCtx, relationInfo, data, connectedWhere)` (from `update.ts`, sibling slice) — runs the update against the correlated where.
- **batch:** `appendCorrelatedChildUpdate(driver, state, ctx, childCtx, relationInfo, data, connectedWhere)` (from `batch-relations.ts`) — emits `appendAssertWhereExists` guard on the correlated where, may `fetchRequiredWhereRecord` at plan time if the update touches the PK or has further nested relations (to obtain the child's identity / batch-updated-PK ref), then emits the `UPDATE` and recurses into nested relations on the updated child.
- **INVARIANT:** a nested M2M update only affects rows *both* matching the unique input *and* connected to this parent; a row connected to a different parent (or unconnected) is invisible. **DIVERGENCE:** tx updates live-correlated rows directly; batch guards the correlation with an exists-assert and (when needed) a plan-time read to capture the child identity for downstream refs.

### D.9 `updateMany`
- **Nearly identical in both engines.** Per normalized `{where?,data}`: `separateData` the data, `assertUpdateManyDataHasNoRelations` (updateMany data must be scalar-only), build `membership = buildJunctionMembership`, build `filterWhere = buildWhere(childCtx-with-mutationTable, where, targetTable)`, then `UPDATE target SET <buildSet(scalarData)> WHERE membership [AND filterWhere]`.
- **DIVERGENCE:** only execute (tx) vs push (batch). **This step is effectively already unified.**
- **INVARIANT:** updateMany affects all connected rows matching the filter; data is scalar-only (no nested relations); no read needed because it's a set-based UPDATE with a membership subquery.

### D.10 `upsert` (M2M-specific, INLINE branch logic — divergence-prone)
- **Shared precondition:** M2M upsert requires `input.where` (throws `NestedWriteError` "requires 'where'" otherwise). This differs from to-one upsert (which uses FK match, no where).
- **Branch decision (both engines, same shape):**
  1. Build `connectedWhere = buildConnectedUniqueWhere(...)`.
  2. Check if a *connected* row exists (tx: `buildSelectOneSql` execute; batch: `fetchOptionalWhereRecord`) → if yes, **update** the connected row (tx: `executeSingleRelationUpdate`; batch: `appendCorrelatedChildUpdate`) and continue.
  3. Else check if the row exists *uncorrelated* (`fetchOptionalUniqueRecord` by `input.where`) → if it exists but isn't connected, **throw** `NestedWriteError` "target record was not found for this parent." (correlated failure — you cannot upsert-connect an existing-but-unconnected row).
  4. Else (row doesn't exist at all) → **create** the child + junction row (tx: `createChildWithJunctionRow`; batch: `appendAssertUniqueMissing` guard + `appendChildCreateWithJunctionRow`).
- **INVARIANT:** M2M upsert semantics = "update if connected; error if exists-but-unconnected; create-and-connect if absent." Note this is *stricter* than Prisma's generic upsert and does NOT reuse `planExistingUpsertBranch` (A.5). **DIVERGENCE + STALENESS:** batch adds an `appendAssertUniqueMissing` guard on the create branch (pins the plan-time "not found" decision); tx has no guard. If the row is created concurrently between plan and execution, batch aborts on the guard; tx would have seen it in-transaction. The branch logic is duplicated *inline* in both handlers — the highest-risk divergence surface in this slice because there is no shared decision function (unlike A.5 for the sibling paths).

### D.11 Unsupported step → typed error
Both handlers' `default:` case throws `NestedWriteError` "Nested operation '{kind}' is not supported for many-to-many relation" — e.g. `createMany` on M2M (which is emitted by the shared planner but rejected by both M2M handlers). INVARIANT: identical rejection in both engines.

---

## PART E — `many-to-many-utils.ts` (the shared junction SQL layer — the good abstraction)

This file is the *already-unified* substrate for M2M: both engines call the identical builders, and every value flows through `buildScalarSqlValue` so the same function handles concrete values (tx) and `BatchValueRef`s (batch) transparently. It is the model of what unification should look like for the rest of nested writes.

Builders and their contracts:
- `getManyToManyJoinInfo` — junction metadata. Requires single-column PK on both sides (`getRequiredSinglePrimaryKeyField`).
- `buildManyToManyJoinParts` — read-path join (used by select/include/filter builders, out of write scope but shares the file).
- `buildJunctionParentValue` / `buildJunctionTargetValue` — resolve source/target PK to `Sql`, accepting field-key OR column-key OR batch-ref; throw `NestedWriteError` "missing primary key" on null/undefined. **These two functions are the exact seam where tx concrete values and batch refs converge** — the single most important evidence that a unified `Expr(literal|symbol|columnRef)` model is viable.
- `buildJunctionInsert` — idempotent junction insert with `skipDuplicates()` (INVARIANT: connect is idempotent; junction PK = `(source,target)`).
- `buildJunctionSourceMatch` / `buildJunctionTargetIn` — junction DML conditions.
- `buildTargetPkSubquery` — `(SELECT target.pk FROM target WHERE <unique>)`; used by the batch engine (and tx disconnect) to resolve a target PK inside a statement without a separate read.
- `buildJunctionMembership` — `target.pk IN (SELECT junction.target FROM junction WHERE source=parent)`; the "is connected to this parent" predicate shared by update/updateMany/upsert/deleteMany correlation.

**Note:** `NestedWriteError` is imported from `../types` here (this file lives in `builders/`), whereas the nested-writes files import it from `../../types` — same class, just path depth. No semantic difference.

---

## PART F — The core divergence: substrate, and the staleness contract

The two engines differ in **substrate only**, exactly as the orchestrator framed it, and this slice confirms it concretely:

1. **Value substrate.** tx uses concrete JS values read from live rows; batch uses `BatchValueRef` symbols (allocated in `batch-references.ts`, lowered to SQL batch-ref subqueries via the adapter `batchRefs.read`). The convergence point is `buildScalarSqlValue` + the junction value builders (E) + the FK assignment helpers (B.1). Because the leaf lowering already handles both, a unified `Expr` language over `literal | symbol | columnRef` is well-motivated.

2. **Branch substrate.** tx branches at runtime after a read; batch reads at **plan time** to choose a branch, then emits a SQL **guard** (`assertions.exists` / `notExists`, or the `NestedWriteGuard` objects) to re-assert the premise at execution time. Guard-as-control-flow (tx) vs guard-as-data-then-SQL (batch).

3. **The staleness contract (must become explicit, not accidental, in a unified engine):** every batch branch decided from a plan-time read is pinned by a guard so the batch aborts (adapter assertion error) if the premise changed before execution. Enumerated staleness surfaces in this slice:
   - `connectOrCreate` branch (D.3) — guarded by `uniqueExists`/`uniqueMissing`.
   - M2M `upsert` create branch (D.10) — guarded by `uniqueMissing`.
   - M2M `deleteMany` / `delete:true` (D.6/D.7) — target PK set materialized at plan time; **rows connected after planning are silently missed** (documented `ponytail:` comment), and a `BatchValueRef` parent PK is a hard error. This one is NOT guard-pinned (it's a materialized set, not a re-checkable premise) — the sharpest staleness gap.
   - Correlated `update`/`upsert` existence (D.8/D.10) — guarded by `appendAssertWhereExists`.

4. **Error-shape divergence.** For the same logical failure, tx typically throws `NestedWriteError` (with the exact C.1 messages) via read-then-throw, while batch aborts on an *adapter assertion error* raised by the guard SQL. A unified engine must decide the canonical error surface (likely: keep `NestedWriteError` semantics, have the batch backend map its assertion aborts back to the typed error, or make guards carry the intended `NestedWriteError` message).

5. **Ordering divergence within a step.** `set` (D.5) inverts DELETE-vs-existence-check ordering between engines; `delete` (D.6) uses different resolution strategies. Same end-state, different internal order — a unified compiler picks one order and must preserve the all-or-nothing invariant on both substrates.

---

## PART G — The acceptance oracle for THIS slice (important correction to the brief)

The brief states the conformance suite `tests/query-engine/nested-write-conformance.test.ts` runs identical scenarios through both engines. **It does — but as of this commit its `scenarios[]` contains ONLY to-one / to-many FK cases (nested create/connectOrCreate on FK-holding parent, nested create on inverse relation). It contains ZERO many-to-many scenarios.**

The M2M dual-engine oracle is instead `tests/drivers/many-to-many-behavior.ts` (`runManyToManyBehavior`), run per-driver from `tests/drivers/{pglite,sqlite3,mysql2,libsql}.test.ts` against the `tests/fixtures/many-to-many-schema.ts` fixture. It exercises connect / create-through-junction / disconnect / set / delete / deleteMany (e.g. `deleteMany: { name: { in: [...] } }`) etc. — but per-driver, i.e. it validates whichever engine that driver selects, NOT a head-to-head tx-vs-batch equivalence for M2M.

**Consequence for unification (INVARIANT for the process, not the code):** M2M has *weaker* dual-engine conformance protection than the FK paths. Before or during unification, the conformance suite SHOULD gain M2M scenarios (connect, create-through-junction, set, disconnect, delete, deleteMany, upsert connected/uncorrelated/create, self-referential delete) so the tx-vs-batch equivalence the brief relies on actually covers this slice. The staleness divergences in F.3 are precisely the cases most likely to be exercised only weakly today.
