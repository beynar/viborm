# Engine Unification Map — Acceptance Oracle & Callers

Scope of this map (the "oracle + callers" slice):

1. **The conformance oracle** — `tests/query-engine/nested-write-conformance.test.ts`: the
   only test that runs *identical* scenarios through *both* engines on the same substrate
   (PGlite) and asserts byte-identical persisted state.
2. **The behavior oracle** — `tests/drivers/nested-write-behavior.ts`,
   `tests/drivers/nested-write-advanced-behavior.ts`, `tests/drivers/many-to-many-behavior.ts`:
   the driver-parameterized suites that every driver class must pass. These define the
   observable Prisma-parity contract each engine must satisfy.
3. **The callers** — the API surface the unified engine must present *upward*:
   `src/query-engine/executor.ts`, `src/query-engine/transaction-flow.ts`, and the client
   dispatch in `src/client/client.ts` / `src/client/pending-operation.ts`.

This document does **not** re-derive the internal mechanics of `create.ts` / `update.ts` /
`batch-relations.ts` etc. (those belong to sibling mapper slices). It maps what those
mechanics must *produce* to satisfy the oracle, and the exact contract the callers depend on.

---

## Part A — The Two Engines and Where They Are Entered

There is one *logical* nested-write operation (create / update / upsert with nested relation
mutations). It has **two substrate implementations**, selected by driver capability at the
single dispatch point `runNestedWriteOperation` (`transaction-flow.ts:132`).

```
runNestedWriteOperation(ctx, operation, args, driver, modelName)
├── if !driver.supportsTransactions && driver.supportsBatch && op ∈ {create,update,upsert}
│      → executeNestedWriteBatch(driver, ctx, operation, args)          [BATCH ENGINE]
└── else
       switch(operation)
         create → executeCreateWithNestedWrites                          [TX ENGINE]
         update → executeUpdateWithNestedWrites                          [TX ENGINE]
         upsert → executeUpsertWithNestedWrites                          [TX ENGINE]
```

**Capability precedence.** A driver that supports *both* transactions and batch takes the
**TX** path (the batch branch requires `!supportsTransactions`). The batch engine is only
reached by batch-only drivers (D1, D1-HTTP, Neon-HTTP) — and, artificially, by the
conformance test's `BatchOnlyPGliteDriver` which forces `supportsTransactions=false,
supportsBatch=true` over a real PGlite so both engines can be diffed on one DB.

### A.1 Substrate primitives each engine builds on

- **TX engine** uses `runNestedMutationAtomically(driver, op, run)` (`atomic-runner.ts:9`).
  It calls `driver.withTransaction(txDriver => run(txDriver))` — a real interactive
  transaction. Inside `run`, the engine may freely **interleave reads and writes** and
  branch at runtime on read results. If it is ever reached with a batch-only driver it
  throws `QueryEngineError` ("reached the transaction-only nested … path, but this driver
  requires planned atomic batch execution") — i.e. the two paths are mutually exclusive by
  construction; this error is a guard against a routing bug, never a user-facing condition.
- **BATCH engine** emits a **single ordered list of SQL statements** (`Sql[]`) plus optional
  `setupStatements` / `cleanupStatements`, and a `parse` closure. The whole list is handed to
  `driver._executeBatch(...)` which runs it as one atomic unit. There are **no runtime reads
  between statements**: every value that a later statement needs from an earlier statement is
  carried by a **batch value-ref** (`src/adapters/shared/batch-refs.ts`), and every branch
  that the TX engine would decide at runtime is either (a) resolved at **plan build time** by
  reads the planner *itself* performs while building the plan, with the premise then **pinned
  by a SQL guard/assertion statement**, or (b) lowered into SQL.

Note the batch engine is **not purely offline**: `prepareNestedWriteBatch` / `appendCreate…`
are `async` and *do* execute reads against the driver **while building the plan** (e.g.
`fetchRequiredUniqueRecord`, `fetchOptionalUniqueRecord`, upsert branch probes). Those reads
happen *before* the atomic batch runs, so their results are a **staleness contract**: the plan
assumes the read state still holds at batch-execution time, and inserts an assertion statement
(`appendAssertUniqueExists` / `appendAssertUniqueMissing` / `appendAssertWhere*`) so that if
the premise has gone stale the batch aborts atomically instead of silently diverging.

---

## Part B — The Upward API Contract (what the callers require)

Any unified engine must keep this contract intact. The callers are decoupled from the engine
by exactly three seams.

### B.1 `QueryMetadata<T>` — the PendingOperation contract (`query-engine/types.ts:57`)

```ts
interface QueryMetadata<T> {
  clientId: symbol;
  args: Record<string, unknown>;
  operation: Operation;
  model: string;
  execute: (driverOverride?: AnyDriver) => Promise<T>;          // ← the "just run it" seam
  prepare?: (driverOverride?) => PreparedQuery;                 // single-statement batchable ops only
  prepareBatch?: (driverOverride?, ctx?: BatchPreparationContext)
                  => Promise<PreparedBatchOperation<T>>;        // ← nested-write batch seam
  parseResult?: (raw: {rows; rowCount}) => T;
  isBatchOperation: boolean;    // createMany/updateMany/deleteMany → {count}
  hasNestedWrites: boolean;     // gates canBatch()
}
```

Constructed in `createPreparedOperation` (`executor.ts:115`). The wiring rules the unified
engine must reproduce (`executor.ts:142-165`):

- `hasNested = hasNestedWrites(baseOperation, args)` — see `transaction-flow.ts:47`.
- `prepare` is provided **only** when the op is *not* nested and *not* a non-returning
  single-record mutation (i.e. can be expressed as one SQL statement that the driver can run
  standalone in a batch). Nested writes set `prepare = undefined`.
- `prepareBatch` is provided **only** when `hasNested && isNestedBatchOperation(op)`
  (op ∈ {create, update, upsert}). It wraps `prepareNestedWriteBatch` (`executor.ts:191`).
- `execute` always points at `createExecutor(...)`. This is what a **direct await** uses.

**Key invariant:** a single logical operation carries *both* an `execute` (used for direct
await and for interactive-transaction dispatch) and a `prepareBatch` (used only inside
`$transaction([...])` on a batch-only driver). Both must yield **identical persisted state**
for the same args — this is precisely what the conformance oracle checks.

### B.2 `PreparedBatchOperation<T>` — the batch flattening contract (`types.ts:96`)

```ts
interface PreparedBatchOperation<T> {
  queries: PreparedQuery[];            // the operation's own statements, in order
  setupQueries?: PreparedQuery[];      // batch-wide prologue (e.g. temp value-ref table)
  cleanupQueries?: PreparedQuery[];    // batch-wide epilogue
  parseResult: (results: QueryResult<unknown>[]) => T;  // slices its own results out
}
interface BatchPreparationContext { nestedWriteState?: unknown; }  // shared across ops in one $transaction
```

This shape exists so that **multiple** logical operations in one `$transaction([...])` can be
flattened into **one** driver batch that shares a single value-ref namespace. The client
concatenates `[...setupQueries, ...allOperationQueries, ...cleanupQueries]` (see B.3).

`BatchPreparationContext.nestedWriteState` is the shared `PlanState` (`batch-plan.ts:185`
`getSharedPlanState`). The first op in the array creates it and stashes it on the context;
subsequent ops reuse it (so value-refs / setup statements are shared, not duplicated). When a
context is present, `prepareNestedWriteBatch` calls `appendNestedWriteBatchPlan` against the
shared state; when absent (single-op direct execute path), it calls `buildNestedWriteBatchPlan`
which creates its own `PlanState` and self-slices setup vs. operation statements.

### B.3 Client `$transaction([...])` dispatch (`client.ts:410-503`)

For a **batch-only** driver (`!supportsTransactions && supportsBatch`), the client:

1. Iterates ops. For each: try `op.prepare(driver)` (single statement). If that returns a
   `PreparedQuery`, push it and register a 1-length parser. Otherwise call
   `await op.prepareBatch(driver, batchContext)`.
2. If any `prepareBatch` returns `undefined`, **break** and fall through to the
   `TransactionError` ("does not support callback transactions and this transaction contains
   operations that cannot be batched atomically"). So `prepareBatch` returning `undefined` is
   the signal "this op cannot be atomically batched" — the unified engine must return
   `undefined` exactly when it cannot honor the atomicity contract.
3. `hasNestedBatchPlan` toggles whether `setupQueries`/`cleanupQueries` are prepended/appended
   and shifts every parser's slice window by `setupOffset = setupQueries.length`. Note
   **only the last-seen** `preparedBatch.setupQueries`/`cleanupQueries` win (`client.ts:449`):
   this is correct **only because** they all reference the *same shared* `PlanState`, so every
   op's `preparedBatch.setupQueries` is the same growing array. A unified engine must preserve
   this "shared setup is monotonic and identical across ops" property.
4. Executes `driver._executeBatch(batchQueries, options)`, then each parser slices
   `results[setupOffset + start : +length]` and calls its `parse`.

For a **transaction** driver, the client executes each op's `execute(txDriver)` inside a real
`withTransaction` (path below `client.ts:517`, outside this excerpt). `pending-operation.ts`
memoizes `execute` per-driver (`executeWith`) and forbids mixing default vs. driver execution.

**Single-await path** (not `$transaction`): `PendingOperation.then` → `getPromise` →
`metadata.execute()` → `createExecutor`'s closure → (if nested) `executeWithNestedWrites` →
`runNestedWriteOperation`. So a *single* nested write on a batch-only driver reaches the batch
engine via `executeNestedWriteBatch` (`transaction-flow.ts:144`), which builds a standalone
plan, runs `driver._executeBatch(batch.queries)`, and parses. `setup/cleanup` for the
single-op path are folded into `queries` by `buildNestedWriteBatchPlan` (they are `undefined`
on the returned `BatchPlan` here — the plan collects them via `collectPlanStatements(state)`).

### B.4 `createExecutor` gating (`executor.ts:323-491`) — the TX/simple decision

`executeCore` validates args, then routes:

```
needsWhereFallback        = needsUpsertWhereFallback(ctx, op, validated)   // upsert targetWhere/setWhere on a
                                                                            // driver without supportsUpsertWhere
needsUpsertReturnFallback = op==="upsert" && !supportsReturning && !canRefetchNativeUpsert
if hasNestedWrites(op,validated) || needsWhereFallback || needsUpsertReturnFallback:
   → executeWithNestedWrites(...)      // the "engine" path (TX or BATCH per B.A)
else:
   → single buildOperation(...) + driver._execute, with refetch shims for
     non-returning drivers (needsMutationRefetch / needsManyReturnRefetch)
```

So the engine is entered not only for literal nested writes but also for **upsert
`targetWhere`/`setWhere` fallback** and **non-returning upsert refetch** — the unified engine
owns all three. `hasNestedWrites` (`transaction-flow.ts:47`) restricts to {create, update,
upsert} and inspects `args.data` (or `args.create`/`args.update` for upsert) via
`hasNestedWritesInData`.

### B.5 `executeWithNestedWrites` — the write-race retry contract (`transaction-flow.ts:90`)

Wraps `runNestedWriteOperation` in one catch: if `isWriteRaceLoserError(error)` **and**
`hasRaceableCreateBranch(operation, args)`, it re-runs the whole operation **once**.

- `isWriteRaceLoserError`: `UniqueConstraintError`, or VibORM error code `DEADLOCK` /
  `SERIALIZATION_FAILURE`.
- `hasRaceableCreateBranch`: `true` for upsert always; for create/update, true iff the data
  tree contains any `connectOrCreate` or `upsert` (`containsRaceableNestedWrite`, recursive).

Rationale (verbatim from source): `SELECT … FOR UPDATE` cannot lock absent rows, so two
concurrent upserts/connectOrCreates of a missing key can both take the create branch; the
loser rolls back and, on retry, sees the winner's committed row and takes the update/found
branch. **This retry wraps *both* engines** (it lives above `runNestedWriteOperation`), so the
batch engine's assertion-driven abort (uniqueMissing failing because the row now exists) must
surface as a *retryable* `NestedWriteAssertionError`/`UniqueConstraintError` — see Divergence D7.

---

## Part C — Per-Operation Semantic Map (from the oracle's perspective)

Below, each nested mutation kind is mapped to: the FK direction that dictates ordering, the
step sequence, what values flow between steps, and the exact observable contract the oracle
pins. The **shared step vocabulary** both engines consume is `NestedWriteStep`
(`semantic-plan.ts:46`), produced by `planRelationMutationSteps`. The FK split both engines
consume is `splitRelationMutationsByFk` (`semantic-plan.ts:131`).

### C.0 The ordering law (why FK direction matters)

A row that *holds* a foreign key can only be written once the *referenced* row's key value is
known. Therefore:

- **Parent holds FK** (`manyToOne` where parent is the FK side; e.g. `post.author`): the
  related (target) row must exist **before** the parent row is written, so the parent's FK
  column can be populated. `splitRelationMutationsByFk` → `currentHoldsFk`. On **create**,
  these are handled by `appendBeforeParentCreateRelation` (**before** the parent INSERT); the
  resulting target PK flows into the parent's scalar FK columns.
- **Related holds FK** (`oneToMany`, `oneToOne` inverse; e.g. `user.posts`): the child rows
  hold the FK back to the parent, so the parent must exist **first** and its PK flows **down**
  into each child's FK. `splitRelationMutationsByFk` → `relatedHoldsFk`; handled **after** the
  parent row exists, keyed by the parent's (possibly generated) PK.
- **Many-to-many**: no FK direction; junction rows are written **after** the parent row exists
  (`semantic-plan.ts:145` forces m2m into `relatedHoldsFk`).

This law is the single most important invariant; every conformance scenario is a probe of it.

### C.1 `create` (nested)

**Conformance scenario** "update with nested create on inverse relation links the child"
covers the related-holds-FK direction; behavior test "create derives to-one and to-many
foreign keys" covers both directions in one create.

Step sequence for `X.create({ data })`:
1. `separateData` → `{ scalarData, relations }`. `assertNoPlannedNestedMutationExecution` —
   create data may **not** contain update-only nested keys (see C.9 rejection contract).
2. `splitRelationMutationsByFk(relations)`.
3. For each `currentHoldsFk` relation (before parent): resolve the target (create it, or
   connect an existing unique). Its PK value(s) → parent FK columns in `scalarData`.
4. INSERT the parent row with `scalarData` (now including derived FKs). Capture its PK
   (literal if provided, or generated: `lastInsertId` value-ref on the batch side).
5. For each `relatedHoldsFk` / m2m relation (after parent): write children / junction rows,
   flowing the parent PK into each child FK / junction column.

Observable contract (behavior test lines 58-92): `profile.userId === parent id`,
`posts[*].userId === parent id`. **createMany** children (`post.createMany`) all inherit the
same parent PK.

TX-engine detail: there's an *inline fast path* in `executeCreateWithNestedWrites`
(`transaction-flow.ts:228`): if `canUseSubqueryOnly(relations) && !hasMultipleConnects`, it
folds connect-derived FKs into the INSERT and emits a **single** statement (no transaction).
Multiple connects, or any related-holds-FK writes, drop to the full `executeNestedCreate`.
The unified engine must preserve this fast path's *observable* result (it is purely an
optimization; the conformance oracle does not distinguish it, but it changes statement count).

### C.2 `update` (nested)

**Conformance scenarios** cover parent-holds-FK create/connectOrCreate (linking the parent)
and inverse-relation create (linking the child).

Step sequence for `X.update({ where, data })` when `needsTransaction(relations)`
(`transaction-flow.ts:308`):
1. `separateData`; `assertNestedUpdatePlanIsExecutable(ctx, relations)`.
2. **Read** the target row (`fetchRequiredUniqueRows` / batch: `fetchRequiredUniqueRecord`
   + `appendAssertUniqueExists`). This read both (a) supplies the current PK for correlation
   and (b) is the premise the batch engine pins with a `uniqueExists` assertion.
3. Compute `refetchWhere` = updated PK (`getUpdatedPrimaryKeyWhere`) — the PK may itself change
   if `scalarData` sets a PK column; the batch engine tracks this via
   `getBatchUpdatedPrimaryKeyRef` + `appendUpdatedPrimaryKeyStores` (a value-ref that captures
   the *new* PK so later child correlation uses the post-update key).
4. If `scalarData` non-empty: UPDATE the parent.
5. Re-`SELECT` the updated parent (TX) to get the current record; the batch engine composes
   `updatedParentData = { ...parentRecord, ...updatedRecord.primaryKey }` from the pre-read row
   plus the updated-PK ref instead of re-selecting.
6. For each relation: `executeNestedUpdate` (TX) / `appendRelationMutation` (batch), keyed by
   the updated parent record.
7. If `include`/`select`: final refetch by `refetchWhere`. Otherwise return the updated record
   scalars (Prisma parity: mutations without select/include return scalars only).

**Parent-correlation contract** (behavior "update and updateMany keep child mutations
parent-correlated", lines 230-278; "to-many updates cannot target another parent's child",
lines 485-541): a nested `update`/`updateMany`/`delete`/`deleteMany` may only touch children
**owned by this parent**. Enforced by correlating the child WHERE with the parent FK. When a
nested `update` targets another parent's child:
- **TX engine** throws `NestedWriteError("Cannot update relation 'posts' …")` at plan/execute
  time (the correlated UPDATE affects 0 rows → `throwIfNoCorrelatedRowsAffected`).
- **BATCH engine** cannot detect a 0-row UPDATE mid-batch, so it emits an **assertion
  statement** that fails the batch; the raw dialect error normalizes to
  `NestedWriteAssertionError("Nested write assertion failed…")`. **This is Divergence D1 —
  different error type, same rejection + same rollback.** The behavior test explicitly asserts
  the two different messages by branching on `driver.supportsTransactions` (lines 518-528).

### C.3 `upsert` (top-level, nested) and the `targetWhere`/`setWhere` guards

**Advanced behavior** "top-level upsert guards gate nested update branch" (lines 91-162) is the
canonical oracle. `client.user.upsert({ where, targetWhere?, setWhere?, create, update })`.

TX engine (`executeUpsertWithNestedWrites` → `executeExistingUpsert` / `executeMissingUpsert`):
1. `SELECT … FOR UPDATE` by `where` (locks the row if it exists).
2. **Exists** → `executeExistingUpsert`:
   - `pkWhere` from the locked record.
   - If `targetWhere` present: probe `fetchOptionalUniqueWithWhereRecord(pkWhere ∧ targetWhere)`
     → `targetWhereMatched`.
   - If `targetWhereMatched !== false` and `setWhere` present: probe similarly →
     `setWhereMatched`.
   - `planExistingUpsertBranch(...)` (`semantic-plan.ts:232`) decides:
     - `targetWhereSkipped` — targetWhere didn't match → **no-op** (skip update), guard
       `uniqueWithWhereMissing`.
     - `setWhereSkipped` — setWhere didn't match → **no-op**, guard `uniqueWithWhereMissing`.
     - `update` — apply the update branch; carries `targetWhereGuard`/`setWhereGuard`
       (`uniqueWithWhereExists`) so the batch engine can pin the "matched" premise.
   - On `update`: split update data, apply scalar update, refetch by (possibly changed) PK,
     run nested update relations.
3. **Missing** → `executeMissingUpsert`: `assertNoPlannedNestedMutationExecution(create)`, then
   `executeNestedCreate(create)`.
4. Always refetch by final PK for the return value.

BATCH engine (`appendUpsertRecord`, `batch-plan.ts:314`) mirrors this: it performs the same
plan-time probes, then encodes the chosen branch, converting each `NestedWriteGuard` into an
assertion statement (`appendPlanGuard`, `batch-plan.ts:403`) so the *premise the planner read*
is re-checked atomically at batch time:
- `uniqueExists`  → `appendAssertUniqueExists`
- `uniqueMissing` → `appendAssertUniqueMissing`
- `uniqueWithWhereExists`  → `appendAssertWhereExists(buildUniqueWithWhere(...))`
- `uniqueWithWhereMissing` → `appendAssertWhereMissing(buildUniqueWithWhere(...))`

**Observable contract:** targetWhere no-match and setWhere no-match are silent no-ops (record
unchanged, nested update skipped); both matching applies the update. The oracle asserts the
skipped cases leave `name`/`title` unchanged and the matched case applies them.

**to-one upsert** (behavior "to-one upsert creates and updates the current target", 360-396)
and **to-many upsert** (321-358) and **m2m upsert** (many-to-many 355-422) are the *nested*
`upsert` relation step (`kind: "upsert"`), distinct from top-level upsert. Contract: nested
upsert on a to-many/m2m relation creates-and-connects when the child is missing and
updates-the-connected-child when present; upsert of an existing-but-**unconnected** record on
m2m **fails** (many-to-many 401-422).

### C.4 `connect`

Behavior "create connects and connect-or-creates nullable children" (94-141), m2m connect
tests (67-108). `NestedWriteStep{kind:"connect", inputs}`.

- Parent-holds-FK: connect resolves the target's PK and writes it into the parent's FK column
  (inline fast path exists — `processConnectOperations` in `executor.ts:527` even folds a
  single connect into a plain build for the non-nested single-SQL path).
- Related-holds-FK: connect updates the child row's FK to point at the parent (correlated by
  child unique WHERE). The target **must exist** — `assertUniqueRecordsExist` (TX) /
  `appendAssertUniqueExists` (batch). Missing target → error (m2m "connect of a missing record
  fails", 97-108).
- m2m: connect **inserts a junction row** `(parentPk, targetPk)`. **Idempotent** (test 82-95):
  connecting the same pair twice yields one association. Must not touch unrelated FKs
  (test 67-80: `tag.featuredPostId` stays null).

### C.5 `connectOrCreate`

Behavior 94-141; advanced "connectOrCreate create branch accepts recursive nested writes"
(50-89); conformance scenarios 2 & 3 (connect existing vs. create missing). Also m2m 129-147
and dedupe 447-465.

`NestedWriteStep{kind:"connectOrCreate", inputs}`. Inputs are **deduped by `where`** at plan
time (`dedupeConnectOrCreateInputs`, `semantic-plan.ts:324`) — first entry wins.

- If the `where` target exists → behave as `connect` (existing row's fields untouched;
  conformance scenario 2 asserts `name` stays "Existing", the `create` payload ignored).
- If missing → `create` the target (recursively — the create branch accepts full nested
  writes, advanced test 50-89 nests a m2m through it), then connect.
- Batch staleness: the "missing" decision is read at plan time; the batch plan pins it with a
  `uniqueMissing` assertion so a concurrent insert aborts the batch (retryable — D7).

**Dedupe divergence rationale** (verbatim comment): the TX engine's second pass would connect
the duplicate, but the batch engine's `uniqueMissing` assertion would abort — so the shared
planner dedupes to keep them identical. **This is an invariant baked into the shared layer.**

### C.6 `disconnect`

Behavior "update disconnects and sets nullable children" (179-228); m2m 149-163; "non-nullable
child foreign keys reject disconnect atomically" (543-581).

- Related-holds-FK, **nullable** FK → set child FK column to null (correlated by parent).
- Related-holds-FK, **non-nullable** FK → **reject**: `assertFkCanBeSetNull`
  (`assertions.ts:44`) throws `NestedWriteError("Cannot disconnect relation '…' because
  foreign key field(s) … are required.")`. The oracle (543-581) asserts the message
  `"foreign key field(s) postId are required"` and that the row is untouched.
- m2m → **delete the junction row** (row survives, association removed; test 149-163). Boolean
  disconnect on m2m is **rejected** (467-484).

### C.7 `set`

Behavior "update disconnects and sets nullable children" (uses `set` at 211-218) and the three
dedicated `set` tests (644-779); m2m 165-184. `NestedWriteStep{kind:"set", input}`.

`set` = replace the association set with exactly the given members:
- Members entering the set that aren't connected → connect them.
- Members leaving the set:
  - nullable FK → disconnect (null the FK). Test "set disconnects only nullable-FK children
    leaving the set" (743-779).
  - non-nullable FK → **reject only if rows would actually be orphaned** (`set.ts:180`
    `throwIfOrphansRemain`): message `"Cannot set relation '…' because foreign key field(s) …
    are required: rows removed from the set cannot be disconnected. Delete them instead."`
    Test "set on required-FK children rejects only when rows would be orphaned" (686-741) and
    the no-op case "set keeping all required-FK children is a no-op and succeeds" (644-684).
  - m2m → delete departing junction rows.
- **Empty set** = disconnect all (or no-op if empty & no children).

**Set orphan-rejection is another D1-class divergence:** TX throws `NestedWriteError` with the
specific message; batch emits an assertion → `NestedWriteAssertionError`. The oracle branches
on `supportsTransactions` (721-731) exactly as in C.2.

### C.8 `delete` / `deleteMany` / `update` / `updateMany` (nested)

Behavior "delete and deleteMany keep child mutations parent-correlated" (280-319); m2m
delete/deleteMany/update/updateMany (186-353).

- All four are **parent-correlated**: the child WHERE is intersected with the parent FK so only
  this parent's children are affected. `delete`/`deleteMany` remove child rows; `update`/
  `updateMany` mutate them. m2m `delete` removes the child row **and all its junction rows**
  across all parents (test 186-206: shared association from another parent is gone too);
  `deleteMany` deletes only *connected* rows matching the filter (221-239).
- `delete` of a not-connected record **fails** (m2m 208-219). `update` of a not-connected
  record **fails** (m2m 294-325).
- **m2m `deleteMany` cannot be combined** with `create`/`connect`/`connectOrCreate`/`set` in
  one nested write: `assertManyToManyStepCombinationIsSupported` (`semantic-plan.ts:346`)
  throws `NestedWriteError` (m2m "connect combined with deleteMany in one update is rejected",
  424-445, message matches `/deleteMany/`). **Rationale (verbatim):** the TX engine executes
  connect/create/set before deleteMany, while the batch engine resolves deleteMany targets at
  plan time — combining them would silently produce different end states per engine. This is a
  shared-layer guard that forbids the only construct the two engines *cannot* be made to agree
  on. **This is a preserved invariant, not a divergence.**

### C.9 Rejection & atomicity contracts (both engines must match)

- **Unknown nested key on create** ("unsupported nested create keys reject before parent
  mutation", 437-455): a create data tree containing an update-only key (`deleteMany`) throws
  `"Unknown key: deleteMany"` at **validation** time — *before any row is written*
  (`assertNoPlannedNestedMutationExecution`, and upstream schema validation). Oracle asserts
  0 users persisted.
- **Nested child failure rolls back parent + prior children** (457-483): a duplicate-PK
  `createMany` inside a create must leave **0 users, 0 posts**. TX: transaction rollback.
  BATCH: the whole statement list is one atomic `_executeBatch`, so a mid-list failure rolls
  the entire batch back. **This is the atomicity invariant the entire two-engine design
  exists to uphold.**
- **m2m rows deletable directly** (279-292): junction FKs default to `ON DELETE CASCADE`
  (Prisma parity), so deleting a parent that participates in a m2m does **not** throw
  `ForeignKeyError`.

---

## Part D — Divergences (mechanism and/or observable) Between the Two Engines

These are the exact points where the engines differ. A unified design must either eliminate
the divergence or make it an *explicit, documented* property. Ranked by risk.

**D1 — Correlation/orphan rejection error type.** TX throws a typed `NestedWriteError` with a
*specific message* ("Cannot update relation 'posts'…", "Cannot set relation 'postTags' because
foreign key field(s) postId are required…"). BATCH raises a SQL assertion whose raw dialect
error is normalized to a *generic* `NestedWriteAssertionError` ("Nested write assertion
failed…"). Same rejection, same rollback, **different error class and message**. The behavior
suite encodes this divergence directly by branching on `driver.supportsTransactions`
(nested-write-behavior 518-528, 721-731). **A unified engine should collapse this to one error
type — the divergence is purely an artifact of the two substrates.**

**D2 — When branches are decided.** TX decides every branch (upsert exists/missing,
connectOrCreate found/missing, targetWhere/setWhere matched) at **runtime**, between statements.
BATCH decides them at **plan build time** using reads the planner performs eagerly, then pins
the premise with an assertion statement. Observationally identical under no concurrency;
under concurrency the batch premise can go stale (see D7).

**D3 — Value flow substrate.** TX flows generated IDs / updated PKs / read records as **live JS
values** between `await`ed statements. BATCH flows them as **driver batch value-refs**
(`batch-refs.ts`: `storeLastInsertId`, updated-PK stores) that lower into SQL. The batch engine
therefore imposes constraints the TX engine does not: e.g. `getStaticPrimaryKeyWhere` /
`getBatchPrimaryKeyRef` (`batch-plan.ts:492,511`) throw `NestedWriteError` if a nested create's
PK is neither literal nor a single auto-increment ("Batch-only nested … requires primary key
field '…' to be known before execution" / "cannot propagate generated compound primary keys").
**The TX engine has no such restriction** — it can create a child with any generated PK and read
it back. This is an observable capability gap: some nested creates that succeed on a TX driver
throw on a batch-only driver.

**D4 — Refetch of the updated parent.** TX **re-SELECTs** the parent after the scalar UPDATE to
get the current record (`transaction-flow.ts:329`). BATCH **synthesizes** the updated record as
`{ ...preReadParent, ...updatedPkRef }` (`batch-plan.ts:299,464`) without a re-select. If a
scalar update changes a column that a subsequent child-correlation depends on *other than the
PK*, the two engines could differ — the batch engine only overlays the PK, not arbitrary
updated columns. (No current oracle scenario exercises a non-PK correlation column changing
mid-update, but this is a latent divergence a unified design must reason about.)

**D5 — Inline fast paths exist only on the TX side.** `processConnectOperations`
(`executor.ts:527`) and the `canUseSubqueryOnly` fast path (`transaction-flow.ts:228`) collapse
simple connect/disconnect nested writes into a **single** SQL statement with no transaction.
The batch engine always emits the full plan. Observationally identical; different statement
counts and different failure granularity (a fast-path single statement can't partially apply).

**D6 — Statement-count / setup-cleanup structure.** BATCH introduces `setupQueries` (value-ref
scaffolding, e.g. a temp table) and `cleanupQueries` and self-slices results by offset; TX has
no such notion. This is why `PreparedBatchOperation` carries setup/cleanup/parseResult and the
client tracks `setupOffset`. A unified engine that keeps a batch backend inherits this.

**D7 — Concurrency: lock vs. assertion.** TX uses `SELECT … FOR UPDATE` to lock existing rows;
its documented weakness is that absent rows can't be locked, so two concurrent creates race →
handled by the **single retry** in `executeWithNestedWrites` (B.5). BATCH has no row locks at
all; its plan-time reads are *unlocked*, and every stale premise (uniqueExists/uniqueMissing/
uniqueWithWhere*) aborts the atomic batch via assertion → `NestedWriteAssertionError` /
`UniqueConstraintError`, which the *same* retry wrapper re-runs. So both engines converge on
"retry once on a write-race loser," but via **different detection mechanisms** (lock rollback
vs. assertion abort). The unified engine must keep both the retry wrapper *and* the
assertion-error → retryable-error classification (`isWriteRaceLoserError` must recognize
`NestedWriteAssertionError`-caused unique violations). **Verify:** the batch uniqueMissing
assertion, when it loses a race, must surface an error `isWriteRaceLoserError` accepts;
currently it accepts `UniqueConstraintError` and DEADLOCK/SERIALIZATION, and the batch abort on
a concurrent insert of the same key would be a real `UniqueConstraintError` from the INSERT
(not the assertion) — this coupling must be preserved.

**D8 — connectOrCreate dedupe is a *convergence hack*, not native behavior.** The shared planner
dedupes duplicate `connectOrCreate` `where` targets (`semantic-plan.ts:324`) **specifically so
the two engines agree** (comment: TX would connect the dup, batch would abort). This is a place
where the "one semantic source of truth" already had to reach down and normalize behavior to
paper over the substrate difference. A unified design should make first-create-wins a
first-class rule, not a dedupe workaround.

---

## Part E — Invariants Any Unified Design MUST Preserve

1. **FK-direction ordering law (C.0).** Parent-holds-FK targets resolved *before* the parent
   INSERT (their PK → parent FK); related-holds-FK / m2m children/junctions written *after*
   the parent exists (parent PK → child FK / junction). Non-negotiable; every conformance
   scenario probes it.

2. **Atomicity of the whole logical operation.** A single nested create/update/upsert is all-
   or-nothing: any failure (duplicate PK, correlation miss, assertion, constraint) rolls back
   the parent and every prior child. (Oracle 457-483; the raison d'être of both engines.)

3. **Identical persisted end-state across substrates.** For the same validated args, TX and
   BATCH must produce byte-identical `dumpState`. This is the literal conformance assertion
   (`expect(transactionState).toEqual(scenario.expected)` **and** `batchState` too). The
   unified engine's two backends (if kept) must be provably state-equivalent.

4. **Prisma-parity branch semantics.** connectOrCreate: existing→connect (create payload
   ignored, target fields untouched); missing→create+connect. Upsert: exists→update branch,
   missing→create branch. targetWhere/setWhere no-match → silent no-op (skip update).
   First-create-wins for duplicate connectOrCreate `where`.

5. **Parent-correlation of nested update/updateMany/delete/deleteMany.** A nested child
   mutation may only affect children owned by the current parent; targeting another parent's
   child is rejected (not silently ignored, not applied) and rolls back. (C.2, C.8.)

6. **FK-nullability guards.** disconnect / set-departure on a **non-nullable** child FK is
   rejected (can't null a required column) — and set-departure is rejected **only when rows
   would actually be orphaned** (no-op when the removed member wasn't connected or is kept).
   (C.6, C.7.)

7. **m2m junction semantics.** connect = insert junction row (idempotent, unrelated FKs
   untouched); disconnect = delete junction row (child survives); delete = delete child +
   all its junction rows; junction FKs `ON DELETE CASCADE`. Boolean disconnect rejected;
   `deleteMany` + `{create|connect|connectOrCreate|set}` combination rejected (the one
   construct the substrates provably cannot agree on).

8. **Return-shape parity.** Mutations without `select`/`include` return **scalars only**
   (Prisma parity, `transaction-flow.ts:294`). With select/include → refetch by final PK
   (which may differ from the input PK if a scalar update changed a PK column —
   `getUpdatedPrimaryKeyWhere`). Mapped columns (`.map()`) must be translated back to field
   names in the returned record (behavior 583-606).

9. **Write-race retry (B.5).** Exactly-once retry of the whole operation when the failure is a
   write-race loser (`UniqueConstraintError` / DEADLOCK / SERIALIZATION) *and* the op has a
   raceable create branch (upsert always; create/update iff data contains connectOrCreate or
   upsert). Any unified engine must keep this wrapper and keep its error-classification aligned
   with how each backend signals a lost race (lock rollback vs. assertion/constraint abort).

10. **The three upward seams (B.1-B.3) stay stable.** `metadata.execute` (direct await +
    interactive-tx dispatch), `metadata.prepareBatch` returning a `PreparedBatchOperation` with
    shared `setup/cleanup` via `BatchPreparationContext`, and `prepareBatch → undefined` as the
    "cannot batch atomically" signal that trips the client's `TransactionError`. A unified
    engine may change *how* these are produced but must keep the shapes and the
    `hasNested/prepare/prepareBatch` gating in `createPreparedOperation`.

11. **Batch-only capability gap must remain a *typed error*, never silent divergence.** Where
    the batch substrate genuinely cannot express something the TX substrate can (non-literal /
    compound generated PK propagation — D3), it throws `NestedWriteError` at plan time. The
    maintainer's rule ("identical behavior or a clear typed error — never silent divergence")
    means a unified design must keep enumerating and typing these gaps, not paper over them.

---

## Part F — Quick Reference: Oracle Scenario → Contract Coverage Matrix

| Suite / scenario | Kind | FK direction | Contract pinned |
|---|---|---|---|
| conformance: update+nested create on FK-holder | create-in-update | parent holds FK | target created before parent link; `authorId` set |
| conformance: update+connectOrCreate existing | connectOrCreate | parent holds FK | existing connected, create ignored |
| conformance: update+connectOrCreate missing | connectOrCreate | parent holds FK | missing created + connected |
| conformance: update+nested create on inverse | create | child holds FK | child gets parent PK |
| behavior: create derives to-one & to-many FKs | create/createMany | both | parent PK → children; target PK → parent |
| behavior: create connect + connectOrCreate | connect/connectOrCreate | child holds FK | connect existing, coc existing ignored, coc missing created |
| behavior: update create/createMany/connect | mixed | child holds FK | all children correlated to parent |
| behavior: disconnect & set nullable | disconnect/set | child holds FK | nullable FK nulled |
| behavior: update/updateMany correlated | update/updateMany | child holds FK | only this parent's children mutated |
| behavior: delete/deleteMany correlated | delete/deleteMany | child holds FK | only this parent's children removed |
| behavior: to-many upsert | nested upsert | child holds FK | create-missing / update-connected |
| behavior: to-one upsert | nested upsert | parent holds FK | create-target / update-target |
| behavior: unknown nested create key | validation | — | reject before any write |
| behavior: nested child failure rollback | atomicity | — | 0 parent, 0 children |
| behavior: update other parent's child | correlation | child holds FK | **D1**: TX vs BATCH error msg |
| behavior: non-nullable disconnect | disconnect guard | child holds FK | required-FK reject, row untouched |
| behavior: mapped FK propagation | create | both | mapped columns → field names |
| behavior: set no-op / orphan reject / partial | set | mixed | **D1** orphan reject; no-op success |
| advanced: coc create branch recursive | connectOrCreate | mixed + m2m | nested writes inside create branch |
| advanced: upsert targetWhere/setWhere guards | top-level upsert | child holds FK | no-op skip vs. apply update |
| m2m: connect/idempotent/missing | connect | m2m | junction insert, idempotent, unrelated FK untouched |
| m2m: connectOrCreate / dedupe | connectOrCreate | m2m | existing connected, dup collapses |
| m2m: disconnect / set / delete / deleteMany | mixed | m2m | junction semantics, cascade |
| m2m: deleteMany + connect combined | guard | m2m | **rejected** (invariant 7) |
| m2m: bare-side / implicit junction / self-ref / named-dup | resolution | m2m | junction resolution parity |
