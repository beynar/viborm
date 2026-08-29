# Engine unification map: batch value-reference mechanism, SQL guards, and the batch execution contract

> **Historical snapshot.** This map documents the deleted pre-unification engines and is not the current runtime contract. `DESIGN.md` and the conformance/behavior suites are authoritative.

Slice owner: the batch-only lowering substrate. Files read completely:

- `src/query-engine/operations/nested-writes/batch-references.ts` (the symbol/ref model + `PlanState` + adapter capability detection)
- `src/query-engine/operations/nested-writes/batch-updated-primary-keys.ts` (PK-mutation lowering under batch)
- `src/adapters/shared/batch-refs.ts` (the shared temp-table `BatchReferenceSqlAdapter` factory)
- `src/adapters/database-adapter.ts` (the `BatchReferenceSqlAdapter` + `assertions` interfaces)
- `src/adapters/databases/{postgres,mysql,sqlite}/*-adapter.ts` (concrete `batchRefs`, `assertions`, `lastInsertId`)
- `src/query-engine/operations/nested-writes/assertions.ts` (guard lowering to `adapter.assertions.exists/notExists`)
- `src/drivers/driver.ts` (`_executeBatch`, `_prepare`, `executeBatch`, `supportsBatch`/`supportsTransactions`)
- `src/drivers/{d1,d1-http,neon-http}/index.ts` (which drivers are batch-only and how each lowers a batch)
- Cross-cutting consumers: `batch-plan.ts`, `values-builder.ts` (`lowerBatchResolvableValue`, `castBatchRefValue`), `transaction-flow.ts`, `atomic-runner.ts`, `client.ts` (`$transaction([...])` batch assembly), `nested-write-conformance.test.ts` (the oracle).

This document is the semantic contract of the **batch substrate**: how the batch engine represents "a value produced during execution that a later statement needs", how it resolves branches that the tx engine would resolve by reading mid-flight, how it enforces invariants the tx engine enforces by throwing between statements, and exactly what the driver `_executeBatch` contract must guarantee for any of this to be correct. This is one half of the substrate divide the orchestrator named: **the batch engine gets one shot, so every runtime `await` in the tx engine must lower to either (a) a SQL batch-ref that carries a value forward, or (b) a plan-time decision guarded by an assertion that re-checks the premise at commit.**

---

## 0. The core problem this substrate solves

A nested write is an ordered list of row mutations whose values depend on things not known when the plan is built:

1. **Execution-generated values** — an autoincrement id the DB assigns on INSERT, which a child row's FK column must reference.
2. **Reads that decide branches** — upsert (does the row exist?), connectOrCreate (was the target found?).
3. **Invariants that must hold at commit** — target exists, child belongs to parent, FK is nullable.

The **transaction engine** handles all three trivially: it executes a statement, `await`s its result, reads the generated id / branch value in JS, and threads it into the next statement's parameters. It can interleave reads and writes and branch at runtime.

The **batch engine** cannot. It emits a single statement list handed to `driver._executeBatch(queries)` as one atomic unit. It never sees an intermediate result. So it needs three mechanisms, all owned by this slice:

- **Batch value-refs** (`BatchValueRef`) — a symbol standing for a value that only exists *during* batch execution. It lowers to a SQL subquery that reads the value out of a temp side-table (`__viborm_batch_refs`) at the moment the consuming statement runs.
- **Batch-ref store statements** — SQL that *writes* a produced value (a `last_insert_rowid()`, or a computed PK arithmetic result) into that temp table, keyed by `(batchId, refKey)`.
- **SQL assertion guards** — a `SELECT` that divides by zero (or extracts a bad JSON path) when a precondition is false, forcing the whole atomic batch to abort. This replaces the tx engine's ability to `throw` after reading a row mid-flight.

The maintainer's framing is exactly right and the code confirms it: the batch substrate is the tx substrate with every mid-flight `await` replaced by *lower-to-symbol* or *decide-now-plus-guard*. The staleness window that opens because reads happen at *plan* time and the write happens at *commit* time is closed by the guards, which re-assert at commit inside the same atomic unit.

---

## 1. The value-reference model (`batch-references.ts`)

### 1.1 The three ref shapes

```
BatchValueRef        { kind:"batchValueRef", batchId, key }
BatchPrimaryKeyRef   { kind:"batchPrimaryKeyRef", modelName, tableName, fieldName, valueRef: BatchValueRef }
BatchRecordRef       { kind:"batchRecordRef", modelName, tableName,
                       primaryKey: Record<field, BatchResolvableValue>,
                       primaryKeyRefs: BatchPrimaryKeyRef[] }
```

- `BatchValueRef` is the atom: an opaque `(batchId, key)` handle. `key` is `ref_${n}` where `n` is a monotonic counter (`nextRefIndex`) on the `BatchReferenceStore`. Allocation order is meaningful only in that keys are unique within a batch; the actual sequencing that matters is *statement order in the emitted list*, not key numbering.
- `BatchResolvableValue = unknown | Sql | BatchValueRef`. This is the union every value slot in the plan may hold: a literal (`unknown`), an already-built SQL fragment (e.g. a connect subquery), or a deferred ref.
- `BatchRecordRef.primaryKey` is a per-PK-field map where each field is *either* a known literal *or* a `BatchValueRef` (for a generated/computed PK). `primaryKeyRefs` is the subset of fields that are deferred, carrying the metadata needed to emit their store statement. This is the record-identity object that flows to children so they can reference the parent's (possibly not-yet-generated) PK.

### 1.2 `PlanState` — the accumulator

`PlanState` is the mutable plan being built. It holds three ordered statement lists plus the ref store:

- `statements: Sql[]` — the operation body (inserts, updates, deletes, guards, store statements), in execution order.
- `setupStatements: Sql[]` — emitted **once**, before the body: `CREATE TEMP TABLE ...` + a `DELETE` (clear) of the batch id.
- `cleanupStatements: Sql[]` — emitted **once**, after the body: a `DELETE` of the batch id.
- `references: BatchReferenceStore`.
- `registerProducedPrimaryKeyRef(model, record)` — convenience delegating to the store.

`batchId` is a per-plan UUID (`batch_${crypto.randomUUID()}`, with a monotonic fallback). It scopes every temp-table row so concurrent batches on a shared connection do not collide on `ref_key`.

`collectPlanStatements(state)` flattens to `[...setup, ...statements, ...cleanup]` — this is the single-operation path (`executeNestedWriteBatch`). The multi-operation path (`$transaction([...])` in `client.ts`) instead keeps the three lists separate and concatenates `[...setup, ...ops, ...cleanup]` **once for the whole array of operations** (see §6), so setup/cleanup run once even though several operations shared the same `PlanState`.

### 1.3 `BatchReferenceStore` — allocation + lazy setup

- `allocateValueRef()` bumps the counter, pushes to `valueRefs`, returns the ref. **First allocation triggers `initialize()`** (guarded by `initialized`), which — *only if the adapter exposes a valid `batchRefs`* — pushes the setup (`createTable` + `clear`) and cleanup (`cleanup`) statements. This is the load-bearing laziness: **a plan that never defers a value never creates the temp table.** A plan whose PKs are all client-supplied (e.g. ULIDs) emits zero setup/cleanup and needs no temp table at all.
- `registerProducedPrimaryKeyRef(model, record)`: for each PK field, if the value is present in `record` it stays a literal in `primaryKey`; if absent it allocates a `BatchValueRef`, records a `BatchPrimaryKeyRef`, and returns a `BatchRecordRef`. "Absent" means the caller already normalized generated PKs out of the record (see `getBatchPrimaryKeyRef` in `batch-plan.ts`, §5.1).
- `modelName` prefers `model["~"].names.ts` and falls back to table name — used only for error/debug identity, not correctness.

### 1.4 Lowering a ref to SQL — `lowerBatchResolvableValue`

```
lowerBatchResolvableValue(adapter, value):
  if not a BatchValueRef -> return value unchanged
  batchRefs = adapter.batchRefs (must exist, else QueryEngineError)
  return batchRefs.read(value.batchId, value.key)   // a scalar subquery Sql
```

`adapter.batchRefs.read` produces `(SELECT ref_value FROM __viborm_batch_refs WHERE batch_id=? AND ref_key=? LIMIT 1)`. This is a **correlated scalar subquery evaluated at the instant the consuming statement runs** — that is the whole trick: the value is read *from the DB, at commit time, inside the atomic unit*, so it reflects whatever the earlier store statement wrote.

Historically, `values-builder.ts::buildScalarSqlValue` lowered a reference and
cast it through the generic scalar `CastType` table. The unified engine now
routes captured values through `fragment-builders.ts`: ordinary scalars still
use their scalar cast, while a decimal uses
`adapter.expressions.decimalCast(expression, descriptor)`. That distinction is
load-bearing on SQLite, where the captured value is an unscaled coefficient and
must return through `INTEGER`, not a logical numeric cast.

### 1.5 Adapter capability detection

`getBatchReferenceSqlAdapter(adapter)` structurally validates `adapter.batchRefs` (must have `setup/clear/cleanup/read/store/storeLastInsertId` as functions). If the adapter lacks it, `lowerBatchResolvableValue` throws `QueryEngineError("Batch reference SQL support is not available...")` and `initialize()` silently skips temp-table setup. **Contract:** any adapter driving a batch-only driver MUST provide a complete `batchRefs`. All three shipped adapters (pg, mysql, sqlite) do, and the three batch-only drivers all use one of these adapters.

---

## 2. The temp-table `BatchReferenceSqlAdapter` (`shared/batch-refs.ts` + adapters)

The shared factory produces the six-method `BatchReferenceSqlAdapter` against a table config. Two variants differ only in `store`'s upsert clause:

- `createOnConflictBatchRefs` (pg, sqlite): `INSERT ... ON CONFLICT (batch_id, ref_key) DO UPDATE SET ref_value = EXCLUDED.ref_value`.
- `createMySqlBatchRefs` (mysql): `INSERT ... ON DUPLICATE KEY UPDATE ref_value = VALUES(ref_value)`.

Method contracts:

| method | SQL | purpose |
|---|---|---|
| `setup(batchId)` | `[createTable]` | create the temp side-table (idempotent, `IF NOT EXISTS`) |
| `clear(batchId)` | `DELETE FROM t WHERE batch_id=?` | pre-body cleanup so a reused connection/temp table can't leak a prior batch's rows |
| `cleanup(batchId)` | `DELETE FROM t WHERE batch_id=?` | post-body cleanup (same SQL as clear) |
| `store(batchId,key,valueSql)` | upsert `(batchId,key) -> CAST(valueSql AS TEXT/CHAR)` | write a produced value; **castValue forces TEXT storage** |
| `read(batchId,key)` | `(SELECT ref_value FROM t WHERE batch_id=? AND ref_key=? LIMIT 1)` | scalar subquery a consumer embeds |
| `storeLastInsertId(batchId,key)` | `store(batchId,key, lastInsertId())` | write the DB's just-generated id |

Per-dialect specifics that are load-bearing:

- **Temp-table lifetime.** PG: `CREATE TEMP TABLE ... ON COMMIT DROP`. SQLite: `CREATE TEMP TABLE IF NOT EXISTS` (session-lifetime; the explicit `clear` at setup + `cleanup` at teardown handle reuse). MySQL: `CREATE TEMPORARY TABLE IF NOT EXISTS` (connection-lifetime; same clear/cleanup discipline). PG's `ON COMMIT DROP` means the table vanishes at commit, so the `cleanup` DELETE is redundant on PG but harmless; on SQLite/MySQL it is *not* redundant because the table persists across batches on the same connection. **This is why clear-at-setup exists**: a reused connection could still hold rows from an aborted prior batch whose `ON COMMIT DROP` never fired (or from a non-PG dialect).
- **`lastInsertId`.** PG `lastval()`, SQLite `last_insert_rowid()`, MySQL `LAST_INSERT_ID()`. All session/connection-scoped and read "the last generated id", so `storeLastInsertId` must be emitted **immediately after** the INSERT that produced it and **before any other INSERT** that would clobber the session's last-insert state. This ordering is enforced by `batch-plan.ts::appendCreateRecord` emitting `appendGeneratedPrimaryKeyStores` directly after `appendInsert` (§5.2). Violating it is a silent-corruption bug class.
- **TEXT round-trip.** `store` casts to TEXT/CHAR; `read` returns TEXT; the consumer casts back to the column type (§1.4). Numeric FKs therefore survive a `int -> TEXT -> int` round-trip. Precision-sensitive types (decimal, bigint) depend on TEXT being lossless — it is, for these dialects' TEXT/CHAR.

`assertions` (also adapter-owned, per §3) live beside `batchRefs`/`lastInsertId` in each adapter, all three sharing the same "abort the atomic batch" purpose.

---

## 3. SQL assertion guards (`assertions.ts` + `adapter.assertions`)

The batch engine cannot `throw` between statements, so a precondition that the tx engine would enforce by reading-then-throwing becomes a **guard statement**: a `SELECT` that *errors at execution time* when the premise is false, aborting the whole atomic batch (and thus rolling back every write in it).

### 3.1 The adapter primitive

`adapter.assertions.exists(subquery)` / `.notExists(subquery)` return a self-aborting `SELECT`:

- **PostgreSQL**: `SELECT 1 / CASE WHEN [NOT] EXISTS (q) THEN 1 ELSE 0 END AS "__viborm_assert__"` — division by zero raises when the premise fails.
- **SQLite / MySQL**: `SELECT CASE WHEN [NOT] EXISTS (q) THEN 1 ELSE json_extract('x','$') END` — `json_extract('x','$')` on invalid JSON raises (division by zero is not reliably an error on these dialects, hence the JSON trick).

Each is a full statement appended to `state.statements`; when embedded in an atomic batch its failure aborts the batch. The `AS "__viborm_assert__"` alias is cosmetic/identifying.

### 3.2 The query-engine wrappers (`assertions.ts`)

`buildSelectOne(ctx, model, whereClause)` builds `SELECT 1 FROM <table> WHERE <where> LIMIT 1` via adapter clause methods (never hardcoded SQL — Golden Rule). The append helpers wrap it:

- `appendAssertUniqueExists(state, ctx, model, where)` → builds a unique-where, then `appendAssertWhereExists` → `assertions.exists(SELECT 1 ...)`. Premise: "row with this unique key still exists."
- `appendAssertUniqueMissing(...)` → `assertions.notExists(...)`. Premise: "no row with this unique key exists" (used before an upsert's create branch).
- `appendAssertWhereExists` / `appendAssertWhereMissing` — the whereClause-taking forms, used for compound `uniqueWith + where` guards.

These are consumed by `batch-plan.ts` at exactly the points where the tx engine did a read + conditional throw:

- **update path** (`appendUpdateRecord`): after the JS `fetchRequiredUniqueRecord` succeeds, `appendAssertUniqueExists` is emitted. The JS read decided the plan (the target's PK values, whether children apply); the guard re-checks at commit that the row still exists, closing the staleness window between plan and commit.
- **upsert path** (`appendUpsertRecord`): the branch chosen in JS (`planExistingUpsertBranch` from `semantic-plan.ts`) is guarded. Existing → `appendAssertUniqueExists`; not-existing → `appendAssertUniqueMissing`; plus `targetWhereGuard`/`setWhereGuard` for conditional-update premises. `appendPlanGuard` dispatches on `guard.kind` (`uniqueExists|uniqueMissing|uniqueWithWhereExists|uniqueWithWhereMissing`).

### 3.3 Guards that are NOT in my slice but share the mechanism

`throwIfNoCorrelatedRowsAffected` and `assertUniqueRecordsExist` are the **tx-engine** analogues (they run in JS against live results). Their batch counterparts are the `append*` guards above. `getNonNullableFkFields` / `assertFkCanBeSetNull` are shared invariant checks (FK-nullable-for-disconnect) used by both engines at plan/JS time; they throw a `NestedWriteError` synchronously regardless of substrate.

---

## 4. Batch PK-mutation lowering (`batch-updated-primary-keys.ts`)

This is the hardest lowering: an `update` that mutates the parent's own primary key, whose new value children must then reference. The tx engine would run the UPDATE, read the new PK back, and thread it into child FKs. The batch engine must produce a `BatchRecordRef` for the *post-update* PK before the UPDATE runs, and either carry a literal forward or defer through a stored computed value.

`getBatchUpdatedPrimaryKeyRef(state, ctx, beforeRecord, data, operation)` — for each PK field:

1. **`getBeforePrimaryKeyValue`**: read the pre-update PK from `beforeRecord` (by field name or column name). If missing/null/`Sql` → `NestedWriteError` ("PK must be known before execution"). The before-value must be a concrete literal because it seeds both the `WHERE` and any arithmetic.
2. If `data[pkField] === undefined` (PK not mutated) → `primaryKey[pkField] = beforeValue` (literal, no ref).
3. Else `getUpdatedPrimaryKeyValue` classifies the mutation:
   - **`set` / raw literal / a `BatchValueRef`** → `{kind:"literal", value}`. Stored directly in `primaryKey`; no store statement needed (the child gets the literal or the pre-existing ref).
   - **numeric op** (`increment/decrement/multiply/divide`) → `{kind:"computed", valueSql}`, an adapter arithmetic expression (`adapter.expressions.add/subtract/multiply/divide`) over `CAST`-ed before-value and operand. This value is not known at plan time, so it **allocates a fresh `BatchValueRef`**, records a `BatchPrimaryKeyRef`, and pushes a `BatchComputedPrimaryKeyStore { valueRef, valueSql }`.
   - **`push`/`unshift`** (array ops) → hard error (can't be a PK).
   - unknown op / non-numeric scalar / unsafe operand → `NestedWriteError`.

`appendUpdatedPrimaryKeyStores(state, ctx, recordRef)` — for each computed store, emits `adapter.batchRefs.store(batchId, key, valueSql)`. **Ordering (load-bearing):** `batch-plan.ts` emits the UPDATE first, *then* the stores. The stores recompute the arithmetic (they embed `valueSql` = `before ± operand`, using the *before* value as a literal, not re-reading the row) and write the result to the temp table so children can `read` it. Because the store's `valueSql` is built from the *before* literal, it does not depend on the UPDATE having run — but it must be emitted after the UPDATE so the emitted-order semantics match the tx engine's "PK is now the new value" world when children are appended afterward.

Guard/validation contracts here (all throw `NestedWriteError`, both plan-time):
- `assertSafePrimaryKeyUpdateValue`: rejects undefined/null/`Sql`/array PK update values.
- `assertNumericPrimaryKeyScalar`: numeric ops require a non-array numeric scalar PK.
- `assertSafeNumericPrimaryKeyOperand`: operand must be number/bigint/`BatchValueRef`.
- Operation envelope must have exactly one key (can't `{increment, set}` together).

`hasPrimaryKeyUpdate(model, data)` is the cheap predicate used upstream to decide whether any of this is needed.

`buildPrimaryKeyArithmeticOperand` casts operands via `getScalarCastType` before arithmetic so mixed int/decimal arithmetic is well-typed in-DB.

---

## 5. How the plan is assembled (`batch-plan.ts`) — step sequences per operation

This ties the refs/guards to concrete ordered statement lists. Every append function mutates `state.statements`.

### 5.1 PK-ref creation for a create — `getBatchPrimaryKeyRef`

Decides, per PK field, whether the value is (a) client-supplied literal → kept; (b) an autoincrement to be generated → deleted from the insert data and registered as a deferred ref; (c) otherwise → `NestedWriteError`. **Compound generated PKs are rejected** (`generatedFields.length>0 && pkFields.length!==1`) — the substrate can only propagate a single generated column via `last_insert_rowid()`. `isGeneratedIncrementDefault` recognizes the sentinel default. The normalized record (generated fields stripped) is passed to `registerProducedPrimaryKeyRef`.

### 5.2 create — `appendCreateRecord`

Ordered:
1. `separateData` → scalars vs relations.
2. `assertNoPlannedNestedMutationExecution` (planned-mutation guard, not my slice).
3. `splitRelationMutationsByFk` → `currentHoldsFk` (parent's FK points to child; child must exist first) vs `relatedHoldsFk` (child's FK points to parent; parent must exist first). **This FK-direction split is the ordering law.**
4. `getBatchPrimaryKeyRef` → `recordRef`.
5. For each `currentHoldsFk` relation: `appendBeforeParentCreateRelation` — create/connect the child, obtain its PK (possibly a ref), and inject it into `scalarData` as the parent's FK **before** the parent insert.
6. `appendInsert(state, ctx, model, scalarData)` — the parent INSERT (FKs to already-created children are literals or `read()` subqueries).
7. `appendGeneratedPrimaryKeyStores` — **immediately** emit `storeLastInsertId` for each deferred PK ref (must directly follow the INSERT so `last_insert_rowid()` is still the parent's).
8. For each `relatedHoldsFk` relation: `appendRelationMutation` with `recordRef.primaryKey` — children reference the parent PK (literal or `read()` subquery).

Why the ordering: FK constraints demand the referenced row exist first. `currentHoldsFk` children are inserted pre-parent; `relatedHoldsFk` children post-parent. Values flow via `BatchRecordRef.primaryKey` — a map whose entries are literals or `read()` subqueries.

### 5.3 update — `appendUpdateRecord`

1. `separateData`; `assertNestedUpdatePlanIsExecutable`.
2. **JS read** `fetchRequiredUniqueRecord` (must exist, else throws now) — decides `parentRecord`.
3. `appendAssertUniqueExists` — the staleness guard re-checking existence at commit.
4. `getBatchUpdatedPrimaryKeyRef(parentRecord, scalarData)` → `updatedRecord` (§4).
5. If any scalar data: `buildUpdate` statement, then `appendUpdatedPrimaryKeyStores` (computed-PK stores after the UPDATE).
6. `updatedParentData = {...parentRecord, ...updatedRecord.primaryKey}` — merges post-update PK (literal or ref) over the read row.
7. Each relation: `appendRelationMutation` with `updatedParentData`.
8. Returns `updatedRecord.primaryKey` as the `finalWhere` for the trailing `buildFindUnique`.

### 5.4 upsert — `appendUpsertRecord`

1. **JS read** `fetchOptionalUniqueRecord`.
2. If existing:
   - `appendAssertUniqueExists` guard.
   - Compute `pkWhere` (static, from the read row).
   - Optionally **JS-read** `targetWhere`/`setWhere` matches to decide the branch.
   - `planExistingUpsertBranch` → branch. If not `update` (i.e. a guard-only no-op branch), emit `appendPlanGuard(branch.guard)` and return `branch.pkWhere`. Else emit `targetWhereGuard`/`setWhereGuard` then `appendUpdateRecordFromExisting`.
3. If not existing: `appendAssertUniqueMissing` guard, then `appendCreateRecord(createData)`.

The guards are the entire staleness-safety story for upsert: the branch was chosen from a read at plan time; the guard re-asserts that premise (existence / conditional match) at commit inside the atomic unit. If a concurrent writer changed the row between plan and commit, the guard's `SELECT` aborts the batch.

### 5.5 Trailing read + parse

Every op appends `buildFindUnique(ctx, {where: finalWhere, select, include})` as the last body statement. `parseFindUniqueResult` reads its rows. The parse-index math accounts for the setup-statement offset (single-op path slices `[setupLen, setupLen+bodyLen)`; multi-op path uses per-parser `start/length` plus a `setupOffset`).

---

## 6. Driver `_executeBatch` contract (`driver.ts`) and the batch-only drivers

### 6.1 The base `_executeBatch(queries)` dispatch

```
if a second argument is supplied -> reject INVALID_TRANSACTION_INPUT
if queries.length === 0 -> []
client = getClient()
if supportsBatch:                        // native atomic batch (D1, Neon-HTTP)
    join sql with "; " for the ONE instrumentation span,
    pass the queries ARRAY (not the joined string) to executeBatch(client, queries)
else if supportsTransactions:            // wrap in a tx (or reuse current one)
    if inTransaction: executeBatch(client, queries)
    else: _transaction(tx => executeBatch(tx, queries))
else:                                     // neither -> hard reject
    throw TransactionError("supports neither transactions nor atomic batch execution")
```

**Contract the batch engine relies on:**
- **All-or-nothing.** Every statement in `queries` commits together or none do. This is what makes the guards work (a mid-list guard failure rolls back earlier writes) and what makes the temp-table refs safe (stores and reads live in one atomic unit).
- **In-order sequential execution.** Statements run in array order. The ref mechanism *requires* this: a `store` must run before the `read` that consumes it; `storeLastInsertId` must run before the next INSERT. Native batch APIs (D1 `batch()`, Neon `transaction()`) guarantee ordered sequential execution within the batch.
- **Shared session/connection.** `last_insert_rowid()`/`LAST_INSERT_ID()`/`lastval()` and the temp table are session-scoped; the whole batch must run on one connection. Both native paths satisfy this (one HTTP request / one binding call).
- **One result row per statement, in order.** The parse offset math (`slice(start, start+length)`) assumes `results[i]` corresponds to `queries[i]`.
- **Empty portable option subset.** `_executeBatch` accepts no second options
  argument. Any supplied value rejects before the empty-array fast path,
  capability checks, client lookup, or provider work.

The default (non-native) `executeBatch` loops `executeRaw` per statement — used only when `supportsTransactions` wraps it in a real tx. Batch-only drivers **must override** `executeBatch` with a genuinely atomic primitive.

### 6.2 Which drivers are batch-only

| driver | `supportsTransactions` | `supportsBatch` | atomic primitive | notes |
|---|---|---|---|---|
| **d1** | false | **true** | `client.batch(statements)` (Workers binding) | true atomicity per Cloudflare; params SQLite-converted; `rowCount = meta.changes \|\| results.length` |
| **neon-http** | false | **true** | `client.transaction(txFn => queries.map(...))` | full PG tx semantics over one HTTP request; no portable isolation or timeout option |
| **d1-http** | false | **false** | — | **NOT batch-capable.** REST API documents no atomicity for batched queries, so it declares `supportsBatch=false` to avoid silent partial writes. Nested writes and `$transaction([...])` **reject loudly** on d1-http. |

So the batch-nested-write engine is reachable **only on d1 and neon-http** in production. d1-http is the deliberate negative case: `atomic-runner` / `transaction-flow` / `client.$transaction` all route it into the "neither transactions nor atomic batch" rejection rather than emitting a non-atomic plan.

`TransactionBoundDriver` copies `supportsBatch`/`supportsTransactions` from its base, so a batch inside a callback tx (on a tx-capable driver) still dispatches correctly.

### 6.3 Two entry points into the batch plan

1. **Single nested write** (`transaction-flow.ts::runNestedWriteOperation`): when `!supportsTransactions && supportsBatch && isNestedBatchOperation(op)` → `executeNestedWriteBatch(driver, ctx, op, args)` → `prepareNestedWriteBatch` (no `context`) → `buildNestedWriteBatchPlan` → `collectPlanStatements` (setup+body+cleanup inline) → `driver._executeBatch(batch.queries)` → parse slices out the setup offset.
2. **`$transaction([...])`** (`client.ts`, lines 405–503): for a batch-only driver, iterate operations; each either `prepare`s to a single query or `prepareBatch(driver, batchContext)` producing a `PreparedBatchOperation { queries, setupQueries?, cleanupQueries?, parseResult }`. **All nested-write ops share one `PlanState`** via `BatchPreparationContext.nestedWriteState` (see `getSharedPlanState`), so they share one `batchId` and one temp table; `setupQueries`/`cleanupQueries` are taken once (last writer wins, but they are identical per batch) and the final batch is `[...setup, ...allOps, ...cleanup]`, executed as one `_executeBatch`. If any op can be neither prepared nor batched, the whole `$transaction` rejects.

`atomic-runner.runNestedMutationAtomically` is the tx-engine sibling: it asserts that a batch-only driver never reaches the *transaction* nested path (it should have been routed to the batch plan), throwing `QueryEngineError` if it does — a guard against mis-routing.

---

## 7. DIVERGENCES between the tx engine and the batch substrate

These are the exact places the two engines differ in *mechanism*, and where behavior could silently diverge if a unified design is careless.

1. **Generated-id propagation.** Tx: `await` the INSERT, read the returned/`RETURNING` id (or `last_insert_rowid()` via a follow-up), thread the JS value into child params. Batch: emit `storeLastInsertId` right after the INSERT, and children embed a `read()` scalar subquery. *Mechanism differs; observable result must be identical.* Fragile point: last-insert-id ordering (§5.2) — the batch path is corruptible if a store is not emitted immediately after its INSERT.

2. **Reads-that-branch (upsert/connectOrCreate).** Tx: read mid-flight, branch in JS, no guard needed (the read and the write are in the same open transaction, serialized). Batch: read at *plan* time (before the batch runs at all), branch in JS, then **emit a guard** that re-checks the premise at commit. *The batch path has a plan→commit staleness window the tx path does not; the guard is what makes them observably equivalent.* If the guard is ever omitted for a branch, the batch engine would silently persist against a stale premise where the tx engine would not.

3. **Failure signaling.** Tx: `throw NestedWriteError`/`recordNotFoundError` in JS between statements; the open tx rolls back. Batch: the guard `SELECT` raises a *driver-level* SQL error (division-by-zero / bad-json-path), which surfaces as a normalized driver error, **not** the typed `NestedWriteError` the tx path throws. **Observable divergence in error type/message.** Any unification must decide whether to normalize the guard failure back into the domain error type (the tx engine's `record not found` vs the batch engine's raw `division by zero` are not the same error object today).

4. **PK-mutation with children.** Tx: UPDATE, read new PK, thread to children. Batch: precompute the new PK as literal-or-computed-ref, store computed values after the UPDATE, children reference via `read()`. Compound generated PKs: **tx can (in principle) read them all back; batch hard-rejects** compound generated PKs (`getBatchPrimaryKeyRef`) and can only carry a single `last_insert_rowid()`. *Observable divergence: a compound-autoincrement scenario errors on batch-only drivers but might not on tx drivers.*

5. **Value storage round-trip.** Batch stores every ref as TEXT and casts back per column type; tx keeps native JS values. Precision/format edge cases (bigint, decimal, datetime) only exist on the batch path. Tx never TEXT-round-trips a threaded value.

6. **Temp-table lifecycle & connection affinity.** Batch requires a session-scoped temp table and single-connection execution; tx has no such artifact. A driver that "supports batch" but does not guarantee single-connection ordered execution would break the batch engine while leaving the tx engine fine.

7. **d1-http.** Neither engine can serve nested writes on d1-http; it is the one driver class where both engines *agree to reject*, but only because it declares `supportsBatch=false`. This is a divergence in *capability*, not mechanism.

8. **Guard cost.** The batch engine issues extra `SELECT` guard statements and extra `store`/`read` round-trips that the tx engine does not. Same observable state, different statement count / cost profile.

---

## 8. INVARIANTS any unified design MUST preserve

1. **Atomicity is the substrate boundary, not a feature.** Every statement the plan emits — setup, stores, guards, mutations, cleanup, trailing read — must commit as one all-or-nothing unit. Guards and refs are only correct inside atomicity. A unified IR must lower to something the backend can execute atomically or must refuse (as d1-http does).

2. **Ordered sequential execution.** `store` before its `read`; `storeLastInsertId` immediately after its INSERT and before any other INSERT; guard before the write it protects (for missing-guards) or the write it validates; parent-before-child or child-before-parent per FK direction. The plan is a *sequence*, and reordering is a correctness bug.

3. **FK-direction determines mutation order.** `currentHoldsFk` (parent FK → child) ⇒ child first; `relatedHoldsFk` (child FK → parent) ⇒ parent first. This is dialect-independent and both engines obey it; a unified plan must encode it explicitly (it is the split in `splitRelationMutationsByFk`).

4. **Deferred values are opaque symbols until lowered.** A produced value the plan cannot know (generated id, computed PK) is a `BatchValueRef` (symbol) that flows through the plan and only becomes SQL at lowering. The tx engine's equivalent is a JS value threaded post-`await`. A unified design needs one symbol abstraction that both backends can resolve — the tx backend by reading a result, the batch backend by emitting store+read.

5. **Every branch decided at plan time must be guarded at commit time.** The staleness contract is explicit and documented, not accidental. Any read-driven branch (upsert exists/missing, conditional target/set where, connectOrCreate found) must emit a re-check guard on the batch backend. Dropping a guard = silent divergence from Prisma parity.

6. **Guard failure must abort the atomic unit.** The guard primitive is adapter-owned (`assertions.exists/notExists`) because the *SQL trick* to force an abort is dialect-specific (PG div-by-zero vs SQLite/MySQL json-path). A unified design must keep this dialect-specific abort SQL behind the adapter and must ensure the abort actually rolls back the batch.

7. **TEXT round-trip fidelity + mandatory cast-back.** If refs are stored as TEXT, the consumer MUST cast back to the column's logical type (`getScalarCastType`), and the storage format MUST be lossless for every scalar type that can be a FK/PK. A unified design either preserves this cast discipline or uses a typed storage that removes the need.

8. **Capability honesty.** `supportsBatch` must mean *genuinely atomic, ordered, single-connection batch*. A driver that cannot guarantee that must declare `false` and be rejected loudly (d1-http), never emit a non-atomic plan. The portable transaction option subset is empty; any second argument rejects before dispatch.

9. **Adapter completeness gate.** A batch-only driver's adapter must expose a full `batchRefs` (six methods) and `assertions` (two methods) and `lastInsertId`. The unified design must fail fast (as `lowerBatchResolvableValue` does) if a backend lacks the primitives, rather than silently degrade.

10. **Lazy setup.** The temp table / setup+cleanup must only materialize when at least one value is actually deferred. Plans with all-known PKs emit no batch-refs scaffolding. A unified design should preserve this zero-overhead-when-unneeded property.

11. **Compound-generated-PK limitation is a real semantic edge, not an accident.** The batch substrate can propagate exactly one generated column (`last_insert_rowid()`). A unified design must either lift this limitation uniformly on both backends or reject it uniformly — it must not let tx and batch disagree on whether a compound-autoincrement nested write is legal.

12. **Error-type parity is currently a gap, and unification must decide it deliberately.** Today the batch guard raises a raw driver SQL error while the tx path raises typed `NestedWriteError`/`recordNotFoundError`. A unified design should normalize both to the same domain error, or the maintainer's "clear typed error, never silent divergence" value is violated on the batch path.
