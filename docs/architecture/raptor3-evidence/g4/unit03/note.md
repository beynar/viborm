# G4-03 — client lifecycle and public type integration (unit note)

Revision r1 — written 2026-09-14T20:55Z, **before the first production edit**
(§7 decision-elimination gate). Author: G4-03 (sole production author for this
unit). Working tree `/Users/arnaud/code/viborm`, branch `pattern-engine`, start
commit `0cc61e61`.

Every claim below that is not backed by a receipt in
`docs/architecture/raptor3-evidence/g4/unit03/receipts/` is marked
**unverified**. Later revisions append; they do not rewrite earlier findings.

---

## 1. Required behavior

Inventory rows LX-01–LX-18, NS-03–NS-05, RF-09/RF-10 observed through a
**private, non-public** client whose model operations execute through
`createCommandEngine(...).execute / .prepareBatch`, while the shipped default
client route stays exactly as it is until the separately authorized C-01
cutover.

Reconciled against current source (2026-09-14), the shipped owners are:

| Fact | Current owner (file:symbol) |
| --- | --- |
| Lazy operation, once-only request preparation, memoized value *and* failure | `src/query-engine/pending-operation.ts:PendingOperation.#resolveArgs` + `#inputPreparation` |
| Request transforms, default omit, mutation cache input, unique-where guard | `src/client/client.ts:VibORM.prepareModelOperation` (`prepareInput` closure) |
| Extension chain composition/ordering/collision | `@extensions/chain` (untouched by this unit) |
| Query interceptors, `proceed()`, write-outcome staging | `pending-operation.ts:#runExecution` + `transactionOperationOwner.startInterception` → `@extensions/query:executePreparedQuery` |
| Interceptor `input` snapshot | `pending-operation.ts` → `snapshotQueryInput(preparedOperation.validatedArgs)` |
| Statement transforms / observed statements | driver `_prepare` / `_execute` boundary (untouched) |
| Official cache read | `client.ts:wrapOfficialCachedRead` → `attachPendingCacheExecution` + `readPendingCacheResult` (`cacheKeyArgs()`, `createRoutedCacheResultCodec`) |
| Official cache invalidation | `client.ts:prepareWriteOutcomeRegistration` → `prepareMutationCacheWriteOutcome`, published from the executor's `committedWriteSegment` / `writeMayBeVisible` notifications |
| Raw bypass | `src/client/raw.ts` (untouched; never reaches a model operation) |
| Callback / nested transactions | `client.ts:createTransaction` → `driver.withTransaction` + `engine.bind(txDriver)` |
| Array transactions | `client/array-transaction*.ts` through `TransactionOperationOwner` (`prepare` → `prepareBatch` → sequential `executeWith`) |
| Observers | `@extensions/observation` via `pending-operation.ts` and the driver |
| `$connect` / `$disconnect` / dispose / `$driver` / `$schema` | `client.ts:createRootView` |
| Introspection | `src/client/schema-introspection.ts` (untouched) |
| Public types | `src/client/types.ts`, `result-types.ts` (untouched) |
| **Payload admission** | `pending-operation.ts:#resolveOperation` → `write-engine/routing.ts:constructRoutedOperation` → the per-operation constructors, which parse through `write-engine/parse-boundary.ts` |
| Execution | `routing.ts:executeRoutedOperation` → `write-engine/OperationExecutor.ts:execute` |

The candidate's equivalent owners are `commands/index.ts:createCommandEngine`
(`execute`, `prepareBatch`), `shared/schema.ts:EngineSchema.admit` (the same
registry schemas through the same `parse-boundary.ts`), and
`shared/operation-context.ts:OperationContext` (`ExecutionBinding`, `run`,
`preparedBatch`, `isIncompletePreparation`).

## 2. Smallest proposed change

1. **One candidate-owned route module** under
   `src/query-engine/raptor3/route/` that implements exactly the operation
   facts `PendingOperation` asks its current owners for — admitted payload,
   cache result codec, single-statement plan, batch package, result parse,
   execute — and answers them from `createCommandEngine`. No second entry into
   the candidate: the route calls only the private `execute` / `prepareBatch`
   boundary.
2. **One selection seam**: `VibORM.create(config, route?)` (non-public second
   parameter) → `new VibORM(config, index, route)` → `new QueryEngine(…, route)`
   → `PendingOperation` consults `engine.route` at the exact points where it
   would otherwise call `constructRoutedOperation` / `executeRoutedOperation` /
   `OperationExecutor`. Nothing else in the shipped route changes; with no
   `route` every one of those points is byte-for-byte the current code.
3. **The private client constructor** lives in the route module
   (`createCandidateClient`), so no public surface, config key, environment
   variable or exported type changes.

## 3. What disappears, and the invariant that replaces it

**In the shipped route: nothing.** This unit deletes no shipped decision; the
old path is retained until C-01 by explicit plan instruction (§6.1 C-01,
`g4.md`). Per §7 question 2 this unit therefore says **"no deletion in the
shipped graph"** and justifies its additions as integration of an existing
owner, not as a new semantic rule.

**Inside the candidate**, one decision disappears:

- *Removed decision*: "a candidate operation is reached by a test-only
  direct-driver invocation" — the pattern every G1–G3 suite uses
  (`overrideTransactionOperation(client.x.findMany(), { executeWith })` in
  `tests/raptor3/g3/transaction-array-contract.test.ts`, and the bare
  `candidate.execute(model, op, args, binding)` calls in
  `tests/raptor3/ownership/*`). Its *mechanism* is a test fixture that fabricates
  a transaction operation and hands it a driver; its *consumers* are every G1–G3
  lifecycle-adjacent witness.
- *Replacing invariant*: **the candidate is reached only through the ordinary
  client lifecycle** — one `PendingOperation` per public call, whose request
  preparation, extension chain, cache, transaction ownership and observation are
  the existing owners'. The route adds no lifecycle of its own: it owns exactly
  one decision, *which owner answers this operation's six facts*.
- *Falsifier*: `tests/raptor3/g4/route-lifecycle.test.ts` runs the candidate
  through a real `$transaction(callback)`, a real `$transaction([...])`, a real
  `$extends` chain and real observers, and asserts the **same** observer unit
  kinds and the same error identities as the shipped client on the same world. A
  lifecycle event the candidate route fails to produce fails that oracle.

**Invariant that keeps admission single**: the route never parses a payload. It
passes the client-prepared payload (post request transform, post default omit,
post unique-where guard) to `createCommandEngine`, which admits it exactly once
through `EngineSchema.admit`. The route *may not* call `admit` itself, because
`parse-boundary` admission is measured non-idempotent and the adjudicated
contract (plan §2.3, 2026-09-08) is **one evaluation per admitted input**. Every
fact the shipped route derives from its *validated* payload must therefore come
from that one admission — see blocker B-1.

## 4. Blockers (recorded, with reproducers)

### B-1 — the frozen candidate boundary cannot publish an admitted payload or a read shape before execution

`createCommandEngine().execute(model, operation, rawArgs, binding?)` fuses
admission and execution: `commands/index.ts` calls `schema.admit(...)` inside
`run(...)` and returns only the decoded result. The shipped route has the split
(`#resolveOperation()` constructs and *retains* `validatedArgs` + the result
shape, and execution consumes that same construction), and three client-lifecycle
consumers depend on it:

| Consumer | Shipped source | Needs |
| --- | --- | --- |
| Query-interceptor `context.input` (LX-12) | `snapshotQueryInput(preparedOperation.validatedArgs)` | the admitted payload, before the child runs |
| Official cache key (LX-07, NS-04) | `PendingOperation.cacheKeyArgs()` | the admitted payload (deliberately, so an operand callback keys stably) |
| Official cache result codec (LX-07, RF-10) | `createRoutedCacheResultCodec` → `compileCacheResultCodec(model, operation, requested, ExpectedResultShape)` | the prepared read shape |

Neither can be obtained today without admitting a second time (forbidden) or
building a second projection/codec authority (forbidden: §7 "G4 reviewers
specifically reject … per-operation codec implementations, duplicate result-shape
preparation"). `src/query-engine/raptor3/commands/index.ts` and
`shared/schema.ts` are owned by G4-01 in a separate worktree, so this unit does
not edit them.

**Exact requested change (to G4-01, `src/query-engine/raptor3/commands/index.ts`,
inside `createCommandEngine`'s returned object):** factor the existing
admission+dispatch into one prepared handle and keep the two current entries as
its callers.

```ts
export interface PreparedOperation {
  /** The ONE admission of this input. */
  readonly args: Arguments;
  /** Present for read verbs: the one prepared projection shape and cardinality. */
  readonly read?: { readonly shape: ProjectionShape; readonly single: boolean };
  execute(binding?: ExecutionBinding): Promise<unknown>;
  prepareBatch(): Promise<PreparedBatchOperation<unknown> | undefined>;
}

// createCommandEngine(config) additionally returns:
prepare(modelName: string, operation: Operations, rawArgs: unknown): PreparedOperation
// and the existing entries become:
//   execute(m, o, a, b)   -> this.prepare(m, o, a).execute(b)
//   prepareBatch(m, o, a) -> this.prepare(m, o, a).prepareBatch()
```

Reason: the client lifecycle is admission-first by construction (the cache must
key before it can look up; an interceptor must see the payload before it calls
`proceed()`), and after C-01 there is no other authority left to ask. It adds no
second admission and no second dispatch: `prepare` *is* the current `run`'s first
half.

**Reproducer for the current limitation** (fails today, passes with the seam):
`tests/raptor3/g4/route-admission.test.ts` →
`"a cached read through the candidate route refuses at the codec boundary"` and
`"a query interceptor sees the client-prepared payload, not the admitted one"`.

**Consequence taken in r1** (recorded divergence, not a silent choice):

- The route answers the interceptor `input` and the cache key with the
  **client-prepared payload** (the exact object the candidate is about to
  admit). For payloads that admission does not rewrite this is identical to the
  shipped route; where admission applies a default or a transform it differs.
  This is one authority per route, not a second parse.
- The route **refuses** the cache *result codec* with a typed
  `UnsupportedOperationError` naming this handoff, rather than inventing a
  value-directed codec that would become a second scalar-meaning authority. The
  cache **bypass** rules (transaction / raw / statement-transform paths) and the
  whole **invalidation** half (LX-08) never touch the codec and are verified.

### B-2 — no member-rollback grant exists on the array sequential fallback

`TransactionOperationOwner.executeWith(operation, driver)`
(`src/query-engine/transaction-operation.ts`, owned by nobody in G4) has no
capability parameter, so the array owner's sequential fallback cannot grant the
candidate a `memberRollback` region. Per the private guide a plain
`borrowed-transaction` binding is refused for root-conflict suppression even on a
savepoint-capable driver, and transport capability may not be used as the grant.
This unit therefore **preserves that refusal** in the array fallback
(`"Raptor 3 borrowed createMany skipDuplicates requires an operation-owned member
rollback region."`). Requested change, if a future unit wants it: add an optional
`capabilities?: { memberRollback?: MemberRollback }` argument to
`TransactionOperationOwner.executeWith`, supplied only by
`src/client/array-transaction-legacy.ts`'s `withTransaction` fallback, which is
the owner of that region.

### B-3 — the candidate re-resolves the schema per client

`new EngineSchema(schema)` hydrates, validates and builds a second resolved
registry although `VibORM.create` already produced both. It is factory-lifetime,
not per operation, so it is a cutover cost item rather than a correctness
problem. Requested change (G4-01, `shared/schema.ts`): let `EngineSchema` accept
the already-resolved index/registry. Not required for this unit.

## 5. Binding mapping (what the route decides, and why it is the only decision)

> **Superseded by FU.3/FU.7** (follow-up after G4-02): the write/read split and
> the route-opened region are gone; the route now states the situation through
> the two grant fields and the candidate decides the envelope. The mapping below
> is r1–r4's record, kept as written.


The candidate engine is factory-bound to the client's **root** driver, so any
other driver reaching an operation is a scope some existing owner opened. One
comparison answers the binding:

| Situation | How it reaches the route | Binding | Mirrors shipped |
| --- | --- | --- | --- |
| Root operation | `engine.driver === factoryDriver`, no `driverOverride` | none (standalone); the candidate's own `OperationContext.run` opens one `withTransaction` for every non-read | `OperationExecutor.execute` → `runTransaction` / `runAtomicBatch` on `engine.driver` for a MULTI-statement write, and `runStatementAtomic` (no envelope) for a statement-atomic one — **divergence D-1 at the root, where it is unobserved (B-4) and costs one extra BEGIN/COMMIT; see §G.1** |
| Inside `$transaction(callback)` / nested savepoint | `engine.driver !== factoryDriver` (`engine.bind(txDriver)`), no `driverOverride` | `borrowed-transaction` on the tx driver, inside **one route-opened `withTransaction` on that same tx driver** for **every** write, which also supplies `memberRollback` | **Mirrors shipped only for a MULTI-statement write** (`OperationExecutor.execute` → `runTransaction` → `runTransactionScope` → `engine.driver.withTransaction`, a savepoint on the tx driver). A statement-atomic write runs **envelope-free** on the shipped route (`runStatementAtomic`, `OperationExecutor.ts:347–357`), so the route opens one region the shipped route does not — **divergence D-1, corrected in r3 §R.1**, original cell quoted there. **Extended in repair 2 (§R.10):** that region is not only observed, it also changes committed state and the caller-visible outcome when such a write FAILS (shipped: the caller's transaction is poisoned and nothing commits; candidate: only the member rolls back and the caller's transaction commits) |
| Array transaction sequential fallback / intercepted array | `driverOverride` supplied by `executeWith` / `executeCore` | `borrowed-transaction`, **no** envelope, **no** `memberRollback` | `OperationExecutor.execute` → `if (driverOverride) runLinearOn` (no second envelope) |
| Array transaction on a batch-only driver | `prepare()` → `undefined`, then `prepareBatch()` | preparation-owned context (`prepareBatch`) | the array owner merges the package windows exactly as it does for the shipped route **for WRITE members only**; the candidate cannot package a READ, so an array containing one is refused where the shipped route succeeds — **divergence D-2, added in r3 §R.2** |
| `$transaction([...])` refused substrate | unchanged client refusal before any candidate work | — | unchanged |

**Corrected in r3 §R.1** (the original sentence is quoted there). The route
opens the operation-scoped region **unconditionally** for a write inside a
caller transaction, where the shipped route opens it only for a multi-statement
write. That is divergence **D-1**: an extra `savepoint` unit and two extra
`statement` units are visible to an observer (the region's own SAVEPOINT/RELEASE
control statements — **inferred**, since a lifecycle unit carries no SQL, from
the fact that the candidate's own statements are unobserved at the root by the
same B-4 mechanism), and a transaction-capable driver without savepoint support
would fail
a single-statement write the shipped route runs envelope-free.

**Extended in repair 2 (review follow-up finding 9; full record §R.10).** D-1 is
not only an observability difference. For a statement-atomic write that FAILS
inside `$transaction(callback)` the two routes commit different rows and return
different caller-visible outcomes, because the driver tracks the two shapes
differently: a direct statement on a transaction-scoped driver is tracked with
`poisonOnFailure = true` (`src/drivers/driver.ts:665-667`), which marks the
caller's scope rollback-only unconditionally (`markCurrentScopeRollbackOnly`,
`driver.ts:564-566`, reached at `:649`), while a nested `withTransaction` — what
the route opens — is tracked with `poisonOnFailure = false` (`driver.ts:797-799`)
and poisons the caller only if nobody observes the rejection
(`driver.ts:642-648`); the route awaits it, so nobody is left unobserved. Today,
measured on both routes (§R.10):

| | shipped | candidate |
| --- | --- | --- |
| the failing member's error | `UniqueConstraintError` | `UniqueConstraintError` (same) |
| the NEXT operation in the same callback | rejects with the same `UniqueConstraintError` | succeeds |
| `$transaction(callback)` | rejects | resolves |
| committed rows | only what was written before the transaction | the pre-transaction row plus both callback members |

This is a different *semantics*, not a cost: with the region removed, the
candidate reproduces the shipped outcome exactly (falsifier §R.10). It does not
touch the MULTI-statement member the LX-02 oracle covers, where the shipped
route opens its own `runTransactionScope` savepoint and the two routes agree.

Apart from that
region the route closes no transaction, retries nothing, and never falls back to
the shipped engine. `atomic-array` stays a candidate refusal: it is unreachable
from this route
because the array owner never hands a candidate operation an `atomic-array`
binding — it either packages `prepareBatch` or borrows a transaction driver.

## 6. Unsupported verbs

The frozen candidate supports `create`, `createMany`, `update`, `upsert`,
`updateMany`, `deleteMany`, `findMany`, `findUnique`, `groupBy`. Every other
verb (`findFirst`, `count`, `aggregate`, `exist`, `delete`, and every `OrThrow`
form) reaches `createCommandEngine` and throws its own
`Raptor 3 G1 operation is not implemented: <verb>` refusal. The route surfaces
that refusal unchanged and never routes the operation to the shipped engine.
Lifecycle oracles are written against the supported verbs; the rest are pinned
as *refusal* cases that flip to behavior cases when G4-01/G4-02 land.

## 7. Cutover (C-01) diff this seam is shaped for

1. `src/client/client.ts:VibORM.create` — delete the optional `route` parameter
   and build the candidate route unconditionally (1 line changed, 1 deleted).
2. `src/query-engine/query-engine.ts` — `route` stops being optional; delete
   `operationExecutor` / `cacheOperationExecutor` / `resolveConsumableResultCandidate`
   and the `OperationExecutor` import.
3. `src/query-engine/pending-operation.ts` — delete the **else** arm of every
   route branch this unit adds (the shipped calls to `constructRoutedOperation`,
   `executeRoutedOperation`, `createRoutedCacheResultCodec`, `isRecordSeries`,
   `#operationExecutor`, `#singlePlan`, `#statementOperation`).
4. Delete `src/query-engine/write-engine/**` except `parse-boundary.ts` (named
   retention), `src/query-engine/result/**` and `src/query-engine/context/**` as
   the structure census then re-measures.

No public export, config key or type changes in that diff; that is the property
this unit is buying.

## 8. Benchmark reachability (protocol note, no shipped switch)

`benchmarks/operation-pipeline-fixtures.mjs` imports `../dist/index.mjs`, i.e.
the built package's public `createClient`. A candidate-only comparison therefore
cannot be reached by a flag in shipped code, and this unit adds none. The
protocol is: in an **isolated worktree** at the qualified identity, apply the
C-01 cutover diff of §7 (make the candidate route the default inside
`VibORM.create`), run `pnpm build`, and point the existing benchmark at that
`dist`. Both sides then use the same fixtures, the same driver versions and the
same public entry; the only difference is which route `dist` was built with.
Recorded as protocol, **unverified** — this unit runs no benchmark.

## 9. §7 answers at completion

Recorded in revision r2 at the end of the unit, against the actual diff.

## 10. Registration requests (to the witness author — do not edit the manifest here)

Recorded in revision r2 once the files and their test counts are final.

---

# Revision r2 — completion record (2026-09-14T21:33Z)

r1 above is unchanged. This revision answers §7 against the actual diff, records
the evidence, and lists what remains blocked. Elapsed implementation +
validation time for the unit: ~2.9 h wall (orientation ~1.0 h of it).

## A. What was built

| File | Kind | Δ physical | Δ token-lines | Δ bytes |
| --- | --- | --- | --- | --- |
| `src/query-engine/raptor3/route/client-route.ts` | new, candidate-owned | +219 | +143 | +8,330 |
| `src/query-engine/pending-operation.ts` | seam | +106 | +73 | +4,168 |
| `src/client/client.ts` | seam | +22 | +20 | +515 |
| `src/query-engine/query-engine.ts` | seam | +10 | +5 | +430 |
| **Total charged to the candidate perimeter** | | **+357** | **+241** | **+13,443** |

**Superseded by r3 §R.6**: the `parseResult` guard deletion (§R.4) lowers the
charged total to **+236 token-lines / +357 physical / +13,532 bytes**, and the
r2 byte/physical columns for `client-route.ts` were one edit stale (review
finding 7). The table below is r2's measurement, kept as written.

Measured with the census's exact `countTokenLines` definition
(`scripts/query-engine-structure.mjs`) against `HEAD` (`0cc61e61`);
receipt [`receipts/unit-cost.json`](receipts/unit-cost.json), whole-directory
census receipt [`receipts/structure-census.log`](receipts/structure-census.log).
No line was added to `commands/`, `shared/` or any other candidate kernel file,
so the unit's **incremental core semantic cost is 0**: every added line is
integration glue or a seam. (Figures are post-`biome format`; an earlier
pre-format measurement of the same diff read +361 / +245 / +13,450.)

### Every line added to a shipped owner, and why

`src/query-engine/query-engine.ts` (+5 token-lines)

1. `import type { ClientOperationRoute }` — type-only; no runtime edge into the
   candidate from the shipped graph.
2. `readonly route: ClientOperationRoute | undefined` + its doc — the selection
   the client lineage was constructed with.
3. `route?: ClientOperationRoute` constructor parameter and `this.route = route`.
4. `this.route` forwarded in `bind()` — a transaction- or extension-bound engine
   is the same lineage and must keep its route.

`src/client/client.ts` (+20 token-lines)

1. `import type { ClientOperationRouteFactory }`.
2. `VibORM` constructor third parameter `route?: ClientOperationRouteFactory`,
   and `new QueryEngine(driver, registry, undefined, undefined, undefined,
   undefined, route?.(this.schema, config.driver))` — the ONE line that can
   install a route. A public `createClient` never reaches it.
3. `VibORM.create(config, route?)` and forwarding it to the constructor.

`src/query-engine/pending-operation.ts` (+73 token-lines)

1. `import type { ClientOperationRoute, RoutedCandidateOperation }` — type-only.
2. `OperationResolution.routed?` — the cache-wrapped copy and its source name
   ONE routed operation, exactly as they already share `operation`.
3. `readonly #route` (from `engine.route`) and `#routedInstance` memo.
4. `#resolveRouted()` — the route's mirror of `#resolveOperation()`: one
   construction per operation, shared through `#operationResolution`.
5. `#preparedInput()` — one accessor for "the payload this operation runs",
   replacing three direct reads of `#resolveOperation().validatedArgs`
   (`prepareAdmission`, `startInterception`, `#runExecution`). On the shipped
   route it is literally `this.#resolveOperation().validatedArgs`, a pure
   property read after the same construction, so the default path is unchanged.
6. `#cacheResultCodec()` — same shape for the cache codec.
7. `#cacheKeyPayload()` — extracted from `cacheKeyArgs()` so the route branch
   does not become a nested ternary.
8. `#runRouted()` and the `if (this.#route)` guard at the top of `#run()`.
9. Route branches (one `if`/ternary each) in `#resolveSinglePlan`,
   `buildStatement`, `prepareBatch`. **(r3: the fourth branch, in `parseResult`,
   was deleted — it was unreachable; see §R.4.)**

Each of 8 and 9 is an EARLY branch whose `else` arm is the untouched shipped
code; the C-01 cutover deletes the `else` arms, not the branches.

**UNCONDITIONAL edit count (r3, from review finding 3).** Items 5–7 above are
the accessors; they are read from **five** unconditional call sites in
`pending-operation.ts`, not three: `#preparedInput()` at `prepareAdmission`,
`startInterception` and `#runExecution`; `#cacheResultCodec()` from
`readPendingCacheResultFriend`; and `#cacheKeyPayload()` from `cacheKeyArgs()`.
All five are pure property reads after the same construction on the shipped
route. The unit's returned summary said "three"; §A.5–7 already listed all five
accessors, so this is a summary-accuracy correction only (r3 §R.3).

## B. §7 decision-elimination answers

**1. Necessary decision or representation repair?** Every added rule expresses a
real boundary: which owner answers an operation's facts (`#route`), which driver
an existing transaction owner supplied (`driverOverride` / `engineDriver`
versus the factory driver), and the durable phase of a failed write (the trusted
record-series progress the candidate already attached at the `@errors`
boundary). Nothing reconciles two representations of the same fact: the route
holds no state, no cache, no lifecycle and no payload interpretation. The one
place it could have grown a second authority — a value-directed cache result
codec — was deliberately refused instead (B-1), because the candidate's prepared
projection is the only legitimate owner of scalar result meaning.

**2. Exact deletion and replacement obligation?** No shipped decision is deleted;
the old route is retained by plan instruction until C-01, and §A above names the
exact lines a cutover deletes. Inside the candidate one decision does disappear:
*"a candidate operation is reached by a test-only direct-driver invocation"*
(`overrideTransactionOperation(...)` + a hand-made binding, the entry every
G1–G3 witness uses). Its replacing invariant is **the candidate is reached only
through the ordinary client lifecycle**, and the falsifier is
`tests/raptor3/g4/route-transactions.test.ts`: it runs real `$transaction`
callbacks, nested savepoints and array transactions with no fixture in the path.
No equivalent mechanism moved elsewhere — the route owns no `executeWith`, no
driver fabrication and no operation shell.

**3. One rule across uses?** The same binding rule is exercised through four
different owners in one file: the root standalone path, the callback-transaction
path, the nested-savepoint path, and the array owner's two paths (native package
and sequential fallback), plus the cached and intercepted paths in the other two
files. The single comparison `driver === factoryDriver` (plus "who supplied it")
answers all of them; there is no per-verb, per-depth or per-substrate branch.

**4. What actually grew?** +241 charged token-lines, of which 143 are the route
module and 98 are seam lines in three shipped files. **No new semantic rule** was
added to the candidate: the route adds integration and one execution-ownership
decision. Against the unit's own expectation (r1 §2: "one private executor
adapter behind the existing `PendingOperation` protocol") the outcome matches,
with one deviation: `pending-operation.ts` needed 73 token-lines rather than the
~40 expected, because `validatedArgs` is read at three separate lifecycle sites
and the memoized routed operation has to be shared with the cache-wrapped copy.
Tests and evidence are counted separately: 26 behavior tests (four files) and
one type-probe file.

## C. Evidence

All receipts are under `receipts/` in this directory.

| Claim | Receipt | Result |
| --- | --- | --- |
| The four route suites pass in the registered `raptor3` project | [`route-suites.log`](receipts/route-suites.log) | 26/26 passed, 5.18 s wall, 680.7 MiB peak RSS, teardown verified |
| The transaction-envelope oracle is sensitive (falsification: the operation-scoped region removed from `client-route.ts`, restored from a scratchpad copy) | [`falsifier-envelope-removed.log`](receipts/falsifier-envelope-removed.log) | exactly 1 failure, "a failed operation inside a callback transaction rolls back only itself"; the other 7 stayed green |
| Shipped client contracts, batch 1 (pending-operation, extensions, request transforms, query interceptors ×2, statement transforms) | [`shipped-suites-1.log`](receipts/shipped-suites-1.log) | 182/182 passed |
| Shipped nested-transaction + legacy array boundaries (core) | [`shipped-suites-2.log`](receipts/shipped-suites-2.log) | 13/13 passed |
| Shipped observers, client-construction boundaries, schema introspection | [`shipped-suites-4.log`](receipts/shipped-suites-4.log) | 34/34 passed |
| Shipped PGlite client lane, shards 1–5 (includes `raw-sql`, `batch-transaction`, `nested-transaction-contract`) | [`shipped-shared-family.log`](receipts/shipped-shared-family.log) | shards 1–5: 15/15 suites each |
| Shipped PGlite shard 7 (`engine/write/pending-operation-contract`) | [`shipped-shared-family-shard7.log`](receipts/shipped-shared-family-shard7.log) | 213/213 passed |
| Shipped PGlite shard 10 (`official-cache-invalidation`) | [`shipped-shared-family-shard10.log`](receipts/shipped-shared-family-shard10.log) | 174/174 passed |
| Shipped PGlite shard 11 (`official-cache-reads`) | [`shipped-shared-family-shard11.log`](receipts/shipped-shared-family-shard11.log) | 367/367 passed |
| Whole-estate typecheck | [`typecheck-final.log`](receipts/typecheck-final.log) | only the two permitted `pattern/pack.ts` TS2345 diagnostics plus in-flight witness-stream files; no diagnostic in any file this unit owns. 7.43 s wall, 5,742 MiB peak |
| Incremental cost | [`unit-cost.json`](receipts/unit-cost.json) | §A table |

Failed attempts are retained and NOT relabelled:

- [`shipped-suites-3.log`](receipts/shipped-suites-3.log),
  [`shipped-batch-transaction.log`](receipts/shipped-batch-transaction.log),
  [`shipped-raw-sql.log`](receipts/shipped-raw-sql.log) — run through
  `run-vitest-safe.mjs`, which caps at the ordinary 1,536 MiB ceiling. These
  PGlite suites peak at 1,560–1,592 MiB and were killed by the ceiling, not by a
  test failure (`batch-transaction` reported 70/70 passed before the kill).
  Their correct owner is `run-credential-free-tests.mjs`, whose shared-family
  stage runs them under the allowlisted 2,560 MiB isolated-PGlite ceiling; that
  is the green receipt above.
- [`typecheck-1.log`](receipts/typecheck-1.log) … `typecheck-4.log` — the
  intermediate typechecks whose diagnostics this unit then fixed.

### Pre-existing red, verified at HEAD

`tests/contracts/engine/write/junction-adopt-create-relations.test.ts` fails 2 of
19 ("E2-U2 the missing-premise race pin survives the absorption", both
substrates) in shared-family shard 6. It was re-run on a clean worktree detached
at `0cc61e61` with no part of this unit's diff:
[`head-baseline-shard6.log`](receipts/head-baseline-shard6.log) shows the same 2
failures, same assertion (`racePin.constraints` missing the `PRIMARY` spelling),
1 failed | 14 passed. The test constructs `UpdateOperation` directly and never
touches `PendingOperation`, so it is outside this unit's perimeter. The worktree
was removed after the run.

## D. Rows covered, pending, and why

> **Superseded for the pending half by the follow-up after G4-02** — see FU.11,
> which moves LX-02, LX-04's read half, LX-13, LX-14, LX-15 and NS-04's key half
> to covered and restates what remains. **Corrected in repair 3:** LX-12 is
> PARTIAL, not covered (the `upsert` payload diverges — D-6), and LX-04's
> coverage is the READ half only (a multi-statement write member diverges on a
> batch-only driver — D-5). The table below is r1–r4's record, kept as written.

**Covered (verified by a receipt above).**

| Row | Where |
| --- | --- |
| LX-01 lazy operation, once-only memoized preparation of value AND failure | `route-lifecycle.test.ts` |
| LX-02 callback transaction: commit, whole rollback, and per-operation rollback inside it | `route-transactions.test.ts` (×2). **Qualified in repair 2**, exactly as LX-04 and LX-14 were in r3: the "per-operation rollback inside a callback transaction" half holds for a MULTI-statement member and **diverges for a statement-atomic one** — see the pending table and §R.10 |
| LX-03 nested transaction = savepoint, outer effects retained | `route-transactions.test.ts` |
| LX-04 array transaction **write half**: admission order, per-member results, atomicity, native packaging through `prepareBatch` | `route-transactions.test.ts` (×2). The READ half is **partial** — see the pending table and r3 §R.2 |
| LX-05/LX-06 raw bypass | `route-transactions.test.ts`, `route-cache.test.ts` |
| LX-08 cache invalidation: published once after commit, never after rollback, staged inside a transaction | `route-cache.test.ts` (×3) |
| LX-09/LX-11 request transforms before admission, official `defaultOmit()` | `route-lifecycle.test.ts`, `route-admission.test.ts` |
| LX-10 extension chain order and collision refusal | `route-lifecycle.test.ts` |
| LX-12 `proceed()` authority, read short-circuit, write-must-proceed refusal, no statement while short-circuited | `route-lifecycle.test.ts` (input payload: see B-1) |
| LX-14 **operation** observer units, exact sequence, matched against the shipped route at the ROOT | `route-lifecycle.test.ts` (statement units: see B-4). Inside a caller transaction the non-operation units diverge — **partial**, see the pending table and r3 §R.1 |
| LX-16 `$connect`, `$disconnect`, async disposal identity, `$driver`, `$schema` | `route-lifecycle.test.ts` |
| LX-17 introspection (`getOperationPayloadSchema`, `validateOperationPayload`, `renderOperationResultType`) is schema-owned and never reaches a route | `route-lifecycle.test.ts` |
| LX-18 public contextual types | `tests/types/raptor3/route-public-types.core.types.ts` — `expectTypeOf(candidate).toEqualTypeOf<typeof shipped>()` plus typo-beside-a-real-key probes at every guarded level, held and optional clause values, and transaction result types |
| NS-03 caller-authored raw is never interpreted or qualified by the route | `route-transactions.test.ts` (the route is never consulted for a raw call) |
| NS-05 the exact bound driver executes; two clients over one database cannot cross | `route-transactions.test.ts` (×2) |
| RF-09 callback transactions refused on a non-interactive transport | `route-transactions.test.ts` |
| RF-10 cached reads bypass transaction/raw/statement-transform paths | `route-cache.test.ts` (×2) |
| Admission-once (plan §2.3 adjudicated contract) | `route-admission.test.ts`: the field transform runs exactly once per admitted row, and the same number of times as on the shipped route |
| Unsupported verbs refuse without a fallback | `route-admission.test.ts`: `findFirst`, `count`, `aggregate`, `exist`, `delete`, `findUniqueOrThrow` all raise the candidate's own refusal and issue no statement |
| Result and error identity | `route-admission.test.ts`: fresh containers per execution, `UniqueConstraintError`, `ValidationError`, `findUnique` miss = `null` on both routes |

**Pending, with the blocker that owns them.**

| Row | Pending part | Blocker |
| --- | --- | --- |
| LX-07 | the cached-READ store/materialize half (the bypass half is covered) | B-1 — pinned by `route-cache.test.ts` "PENDING blocker B-1" |
| LX-12 | the interceptor `input` is the client-prepared payload, not the admitted one | B-1 — pinned exactly in `route-lifecycle.test.ts` |
| NS-04 | cache-entry identity for a candidate read (the invalidation half is covered) | B-1 |
| LX-13 | statement transforms never see candidate statements | B-4 (new, below) — pinned by `route-lifecycle.test.ts` "PENDING blocker B-4" |
| LX-14/LX-15 | statement, transaction, savepoint and connection UNITS for candidate statements, and official instrumentation over them | B-4 — pinned in the same test |
| LX-14 (r3) | inside `$transaction(callback)` an observer sees ONE EXTRA `savepoint` unit and two extra `statement` units that the shipped route never produces for a statement-atomic write | **divergence D-1**, OBSERVABILITY half, owner B-1 — pinned by `route-transactions.test.ts` "LX-14 DIVERGENCE PIN blocker B-1 …"; the state/outcome half is the row below |
| LX-02 (repair 2) | a statement-atomic write that FAILS inside `$transaction(callback)` rolls back only its own member: the caller's next operation succeeds, `$transaction` RESOLVES and both members COMMIT, where the shipped route poisons the caller's transaction, rejects and commits nothing | **divergence D-1**, STATE/OUTCOME half (mechanism: `poisonOnFailure` true for a direct statement, false for a nested transaction — §5, §R.10), owner B-1 — pinned by `route-transactions.test.ts` "LX-02 DIVERGENCE PIN blocker B-1 …". **Resolved by design** in the G4-02 brief item 11, not a decision for Arnaud: §R.10 |
| LX-04 (r3) | on a batch-only driver an array transaction containing a READ member is refused where the shipped route succeeds | **divergence D-2**, owner B-1 (the candidate's `prepareBatch` publishes no prepared read shape) — pinned by `route-transactions.test.ts` "LX-04 DIVERGENCE PIN blocker B-1 …" |
| LX-04 (r3) | the route's `prepareBatch()` takes no driver, so a candidate package is `_prepare`d on the FACTORY driver while the array owner executes it on the transaction-scoped driver it supplied | **divergence D-3**, owner G4-01 (`commands/index.ts:prepareBatch` has no driver/binding parameter). Unobservable today because B-4 keeps statement transforms and observation off candidate statements; observable the day B-4 lands. Requested change in r3 §R.5 |
| — (r3) | `PendingOperation.buildStatement()` answers `undefined` for every routed operation, so `QueryEngine.build(model, op, args)` throws "does not compile to one SQL statement" for an operation that plainly does | **divergence D-4**, owner B-1 (no statement exists before the candidate runs). Internal only: `grep -rn "\.build(" src/client` is empty, so no client surface reaches it |

Every pending ROW has a self-falsifying pin: the test asserts today's exact
absence (or, for D-1, today's exact extra unit shape and today's two exact
caller outcomes, and for D-2 today's exact refusal), so it goes red the day the
seam lands and must then be rewritten into
the real oracle. **Exception, stated plainly (r3):** divergences **D-3** and
**D-4** carry NO pin. D-3 has nothing observable to assert until the B-4 seam
lands (its whole content is that an unobserved `_prepare` happens on the wrong
driver object), and D-4's only consumer is `QueryEngine.build`, which no client
surface reaches. Both are recorded here and in `handoff.md` instead.

### B-4 (new) — the candidate's execution context carries no extension chain

`applyTrustedStatementTransforms` and the driver's observation helpers read the
resolved chain from `getExecutionExtensionChain(context) ??
getExecutionExtensionChain(this.boundContext)`
(`src/drivers/driver-instrumentation.ts:452`, `:483`). The chain lives in a
WeakMap keyed by the exact TRUSTED context object
(`src/drivers/execution-context.ts`), so only the client's own context can carry
it. `OperationContext.attribution` builds a fresh plain
`{ model, operation, correlationId }` on every read, which carries none — so a
candidate statement is transformed by nothing and observed by nobody, while the
same operation's OPERATION-level observation (owned by `PendingOperation`) is
unaffected and matches the shipped route exactly.

This cannot be repaired from any file this unit owns: a driver wrapper would be
a second driver authority, and a per-client bound context would be wrong for
`$extends`, which derives a new chain over the SAME driver.

**Exact requested change**, to the two owners:

- `src/query-engine/raptor3/shared/operation-context.ts` (G4-02):
  ```ts
  constructor(
    readonly schema: EngineSchema,
    factoryDriver: AnyDriver,
    readonly modelName: string,
    readonly operation: Operation,
    binding?: ExecutionBinding,
    prepareBatch = false,
    private readonly callerAttribution?: QueryExecutionContext   // NEW
  ) { … }
  get attribution() {
    return (
      this.callerAttribution ?? {
        model: this.modelName,
        operation: this.operation,
        correlationId: this.correlationId,
      }
    );
  }
  ```
  The caller's context already carries `model`, `operation`, a correlation id,
  instrumentation and the chain; accepting it adds no second authority and
  removes the candidate's need to mint attribution when a client owns one.
- `src/query-engine/raptor3/commands/index.ts` (G4-01): thread an optional
  `attribution?: QueryExecutionContext` through `execute` and `prepareBatch`
  into that constructor.

With both, `client-route.ts` passes `execution.context` (the operation's own
immutable attribution, created by `createPendingOperationContext`) and LX-13,
LX-15 and the statement/transaction/savepoint halves of LX-14 become ordinary
oracles. **Reproducer:** `route-lifecycle.test.ts` →
`"LX-13 PENDING blocker B-4 …"` asserts `observed === []` today and fails as soon
as the chain reaches the candidate's statements.

## E. Registration requests (to the witness author — manifest owner)

**Superseded by r3 §R.7, and again by repair 2 (§R.7 as corrected)**:
`route-transactions.test.ts` now holds **11** tests (two divergence pins added by
the r3 repair, one more by repair 2), so the manifest count 8 must become 11. The
table below is r2's request, kept as written.

The manifest already carries all four files with the counts below (observed at
`scripts/raptor3-manifest.mjs:500–532`, added by the witness author while this
unit was running). Confirmed as correct and final for this unit:

| File | Expected tests | Credential-free? | Project |
| --- | --- | --- | --- |
| `tests/raptor3/g4/route-lifecycle.test.ts` | 7 | yes (better-sqlite3 in memory) | `raptor3` |
| `tests/raptor3/g4/route-transactions.test.ts` | 8 | yes | `raptor3` |
| `tests/raptor3/g4/route-cache.test.ts` | 6 | yes (MemoryCache) | `raptor3` |
| `tests/raptor3/g4/route-admission.test.ts` | 5 | yes | `raptor3` |

One addition is requested: nothing registers
`tests/types/raptor3/route-public-types.core.types.ts`. It is covered by
`node scripts/run-typecheck.mjs` (the root tsconfig includes `tests/**/*.ts`),
which is the check the brief names, and it is deliberately NOT a layer type-core
file: `scripts/run-layer-core.mjs` shards `tests/types/<layer>/*.core.types.ts`
for the layers in its `LAYERS` set, and `raptor3` is not one. If the integrator
wants it inside a layer lane, the layer owner adds
`tests/types/raptor3/tsconfig.json` and a `raptor3` layer entry; this unit does
not add either.

## F. Cutover (C-01) diff, precisely

1. `src/client/client.ts` — delete the `route` parameter from `VibORM.create`
   and from the `VibORM` constructor; build the candidate route unconditionally
   at the `new QueryEngine(…)` call (1 line changed, ~8 deleted).
2. `src/query-engine/query-engine.ts` — `route` becomes required; delete
   `operationExecutor`, `cacheOperationExecutor`,
   `resolveConsumableResultCandidate` and the `OperationExecutor` import;
   `prepare`/`prepareCacheManaged` stop passing an executor.
3. `src/query-engine/pending-operation.ts` — delete the `else` arm of each route
   branch listed in §A.9 plus `#resolveOperation`, `#statementOperation`,
   `#resolveSinglePlan`, `#singlePlan`, `#operationInstance`,
   `#operationResolved`, `#operationExecutor`, and the imports of
   `constructRoutedOperation`, `executeRoutedOperation`,
   `createRoutedCacheResultCodec`, `isRecordSeries`, `ROUTED_OPERATIONS` and
   `OperationExecutor`. `#preparedInput`, `#cacheResultCodec`,
   `#cacheKeyPayload`, `#resolveRouted` and `#runRouted` lose their branches and
   become the only implementation.
4. Delete `src/query-engine/write-engine/**` except `parse-boundary.ts` (named
   retention), plus the result and context owners the census then reports as
   unreferenced.
5. `src/query-engine/raptor3/route/client-route.ts` loses
   `createCandidateClient` (the public `createClient` is the entry) and keeps
   `createCandidateRoute`.

No public export, configuration key, environment variable or type changes in
that diff. The route's own behavior does not change at cutover, which is the
property this unit exists to buy.

**LANDED (follow-up after G4-02, see FU.3/FU.7).** The paragraph below is the
plan; it was carried out, and the route now passes `operationRegion` +
`memberRollback` instead of wrapping every write. The cutover diff above is
unaffected, exactly as predicted.

**Added in repair 2 — one route-side change lands BEFORE cutover, not in it.**
When G4-02 item 11 moves the envelope decision into `OperationContext`,
`runCandidate`'s write arm stops wrapping every write and instead passes
`memberRollback` as a capability on the borrowed binding (the candidate invokes
it for a multi-statement operation and runs a single-statement one directly on
the borrowed driver). That is a bounded follow-up for this unit, it removes
divergence D-1 in both halves, and it turns the **two D-1** `DIVERGENCE PIN`
cases in `route-transactions.test.ts` into ordinary equality oracles (the third
pin is D-2's, owned by G4-02 item 12, packageable reads). The cutover diff
above is unaffected by it.

## G. Unverified claims

1. **Performance.** No benchmark was run. The candidate opens its own
   transaction envelope for every standalone write (`OperationContext.run`),
   where the shipped executor has a statement-atomic fast path, so a candidate
   `create` costs an extra BEGIN/COMMIT round trip; inside a callback
   transaction the route's operation-scoped region costs a SAVEPOINT/RELEASE
   pair that the shipped route also pays for multi-statement writes but not for
   single-statement ones. Neither figure is measured here; both belong to
   G4-02/G4-04. **Repair 2:** that region is not only a cost — it is also a
   semantic difference for a FAILING statement-atomic write (§R.10); the cost
   half stays unmeasured.
2. **Commit-ambiguity publication on the interactive route.** The route
   publishes a failed write's outcome from the trusted record-series progress the
   candidate attaches (`committedSegments > 0` → committed;
   `mayHaveCommittedSegment` → may-have-committed). The shipped route ALSO
   derives certainty from `bindExecutionTransactionPhases` around its own
   `withTransaction`; the candidate opens that transaction internally, so the
   route cannot observe its phases. A driver whose COMMIT outcome is ambiguous
   on the standalone interactive route would therefore publish nothing where the
   shipped route publishes `writeMayBeVisible`. No witness exercises that case
   here; it is a consequence of B-4's sibling (the candidate owning its own
   attribution) and is resolved by the same seam.
3. **Array admission ordering with request handlers.** `prepareAdmission` forces
   request preparation on the route (it resolves `#preparedInput`), but not
   candidate admission, because admission happens inside `execute`. For an array
   transaction whose members carry request handlers, a payload that fails SCHEMA
   validation therefore surfaces when its member runs rather than before the
   first member runs. Inside a transaction every member rolls back either way,
   so no effect differs; the observable difference is which error surfaces first
   when two members are both invalid. Not witnessed; same owner as B-1.
4. **Native providers.** Nothing in this unit ran against native PostgreSQL or
   MySQL (the environment blocker recorded in `g4.md` stands). Every receipt here
   is SQLite (better-sqlite3) or PGlite.
5. **B-2's preserved refusal is unreachable on every substrate this environment
   can run** (added in r3, from review finding 8).
   `OperationContext.suppressionRefusal()` fires only when
   `adapter.mutations.skipDuplicatesStrategy === "recoverableUniqueError"`,
   which is **MySQL only** (`src/adapters/databases/mysql/mysql-adapter.ts:851`;
   SQLite `:711` and PostgreSQL `:513` both use `"sql"`). So B-2's claim — "this
   unit therefore preserves that refusal in the array fallback" — is **untested**
   here, and on MySQL it would be an observable array-transaction behavior change
   for a supported verb (`createMany({ skipDuplicates: true })` inside
   `$transaction([...])`: shipped succeeds, candidate refuses). Registered as a
   MySQL-lane pin request in §E; it cannot be witnessed in this environment.
6. **The multi-statement branch of the decided D-1 resolution mirrors shipped
   OBSERVABILITY** (added in repair 2). Its state half is witnessed — LX-02's
   multi-statement oracle compares committed rows and error identity on both
   routes and passes — but no probe in this unit compares the observed UNIT
   sequence of a multi-statement write inside a callback transaction between the
   two routes, so "the `memberRollback` region produces the same units as the
   shipped `runTransactionScope`" is **unverified here**. G4-02 item 11 requires
   pinning both D-1 outcomes against the shipped engine; that is where it lands.
7. **D-1's savepoint-less-driver consequence** (§R.1) stays unwitnessed: nesting
   is implemented once in the base driver (`src/drivers/driver.ts:688`), so no
   driver in this repository is known to lack savepoint support.

---

# Revision r3 — Repair record (2026-09-15, after independent review returned REVISE)

Input: [`../unit03-review.md`](../unit03-review.md) (8 findings: 3 must-fix,
5 note). r1 and r2 above are unchanged except where a sentence they contained
was **false** about the code — those are corrected **in place** and the original
wording is quoted here, so the decision record reads true and the change stays
auditable. Every corrected location carries an explicit "corrected in r3"
marker.

All r3 receipts are under
[`receipts/repair/`](receipts/repair/). One production line was deleted; nothing
else in `src/` changed.

## R.0 Summary table (finding → change → receipt)

| # | Severity | Change | Receipt |
| --- | --- | --- | --- |
| 1 | must-fix | Divergence **D-1** named in §5 (sentence + two table rows) and §D; self-falsifying pin added to `route-transactions.test.ts`; LX-14 moved to **partial**. No production change — the shipped condition is undecidable before admission (§R.1) | [`review-probes-before.log`](receipts/repair/review-probes-before.log), [`route-suites-after.log`](receipts/repair/route-suites-after.log), [`falsifier-envelope-removed-r3.log`](receipts/repair/falsifier-envelope-removed-r3.log) |
| 2 | must-fix | Divergence **D-2** named in §5/§D; self-falsifying pin added; LX-04 moved to **partial** with the read half and its owner named. No production change | [`route-suites-after.log`](receipts/repair/route-suites-after.log), [`falsifier-array-read-pin-r3.log`](receipts/repair/falsifier-array-read-pin-r3.log) |
| 3 | must-fix | §5 sentence + all three §5 table rows corrected; `handoff.md` §1 binding rule now states the condition; the "three unconditional edits" count corrected to **five** in §A | this file + [`handoff.md`](handoff.md) r2 |
| 4 | note | **Deleted** the unreachable `parseResult` route guard in `pending-operation.ts` (−5 charged token-lines) | [`shipped-suites-r3-1.log`](receipts/repair/shipped-suites-r3-1.log), [`shipped-suites-r3-2.log`](receipts/repair/shipped-suites-r3-2.log), shards 3/7/9 |
| 5 | note | Divergence **D-3** recorded in §D with its owner and a requested change (§R.5). Not repairable here: `commands/index.ts` is G4-01's | §R.5 |
| 6 | note | Divergence **D-4** (`buildStatement()` answers `undefined`) recorded in §D | §R.5 |
| 7 | note | `receipts/unit-cost.json` regenerated against the final files | [`unit-cost.json`](receipts/unit-cost.json) |
| 8 | note | B-2 added to §G as **native-only / unverified**, with a MySQL-lane pin request | §G.5, §R.7 |

## R.1 Finding 1 — the operation-scoped region (divergence D-1)

**Reproduced.** `route-envelope.review.test.ts` →
*"an observer sees the same non-operation unit kinds inside
$transaction(callback) on both routes"*, receipt
[`review-probes-before.log`](receipts/repair/review-probes-before.log):

```
candidate = ["transaction:$transaction(callback)","operation:create",
             "savepoint:create","statement:create","statement:create"]
shipped   = ["transaction:$transaction(callback)","operation:create",
             "statement:create"]
```

**The shipped condition cannot be taken by the route, and here is why.** The
shipped decision is `compileSingleStatementCandidate(operation) &&
canExecuteDirectly(directCandidate)` (`OperationExecutor.ts:347–348`), a
property of the **compiled** operation: whether its single fragment has exactly
one non-guard step whose SQL carries no unresolved reference, scratch or
savepoint-skip effect. The candidate boundary
(`createCommandEngine().execute`) **admits, plans, compiles and executes in one
call** — nothing is compiled when the route picks the binding, and re-deriving
statement-atomicity outside that call would be either a second admission
(forbidden, plan §2.3) or a second planning authority (forbidden, §7). So this
is B-1's family, and I say so rather than inventing a predicate:

> **the route cannot mirror the shipped condition until the candidate boundary
> publishes a prepared handle (blocker B-1 / handoff §2).**

The region itself is **load-bearing** and is not removed: it is what gives a
failed multi-statement candidate write inside a caller transaction a scope to
roll back to, and it is where `memberRollback` comes from. Falsification proof:
with the region removed, `route-transactions.test.ts` fails exactly the two
cases that depend on it and nothing else —
[`falsifier-envelope-removed-r3.log`](receipts/repair/falsifier-envelope-removed-r3.log)
(`2 failed | 8 passed`: "LX-02 a failed operation … rolls back only itself" and
the new D-1 pin).

**What was corrected.** §5's table row for "Inside `$transaction(callback)` /
nested savepoint" and this sentence, quoted verbatim as it stood in r1:

> "The route never opens a transaction the shipped route would not open, never
> closes one, never retries, and never falls back to the shipped engine."

The §5 "Root operation" row was corrected in the same way: the shipped route has
`runStatementAtomic` there too, so the candidate's own `OperationContext.run`
envelope is the same divergence at the root — unobserved (B-4), costing one
extra BEGIN/COMMIT (§G.1).

**What was added.** `tests/raptor3/g4/route-transactions.test.ts` →
*"LX-14 DIVERGENCE PIN blocker B-1: a statement-atomic write inside a callback
transaction opens one extra observed region"*, which asserts **today's exact
sequence on both routes** and therefore goes red the day either shape changes,
including the day B-1's seam lets the route mirror the shipped condition.

**Row status.** LX-14 is now **partial**: the operation units match the shipped
route exactly (root and inside a transaction); the non-operation units do not
(one extra `savepoint`, two extra `statement`), and the statement units of the
candidate's own SQL are still absent (B-4).

**Substrate consequence, recorded.** A transaction-capable driver whose
transactions do not nest (no savepoint support) would now fail a
single-statement write inside `$transaction(callback)` that the shipped route
runs envelope-free. Nesting is implemented once in the base driver
(`src/drivers/driver.ts:688` — "a nested `$transaction` is a SAVEPOINT inside an
already-open transaction"), so no driver in this repository is known to lack it
and nothing witnesses the consequence here — **unverified**. It disappears with
the B-1 seam.

**Extended in repair 2 (review follow-up finding 9) — D-1 also changes committed
state and the caller-visible outcome.** What r3 recorded above (extra units, plus
the unwitnessed savepoint-less-driver consequence) is true but incomplete. The
region is a NESTED transaction, and the base driver tracks the two shapes with
different failure policies:

| shape | tracked as | on failure |
| --- | --- | --- |
| direct statement on a transaction-scoped driver — what the SHIPPED route does for a statement-atomic write (`runStatementAtomic`) | `trackTransactionOperation(…, poisonOnFailure = true)`, `src/drivers/driver.ts:665-667` | `markCurrentScopeRollbackOnly(error)` runs unconditionally (`driver.ts:649` → `:564-566`): the caller's scope is rollback-only |
| nested `withTransaction` — what the ROUTE opens for every write | `trackTransactionOperation(…, poisonOnFailure = false)`, `driver.ts:797-799` | an observation is registered and the caller is poisoned only `if (this.transactionClosed && !observation.isRejectionObserved)` (`driver.ts:642-648`); the route awaits the rejection, so the caller is never poisoned |

So a statement-atomic write that FAILS inside `$transaction(callback)` ends
differently on the two routes — same error identity for the failing member,
different everything after it (§5's table; measured side by side in §R.10). The
r3 record and the r2 handoff called D-1 an observability difference with an
unmeasured SAVEPOINT/RELEASE cost; a reader of those could not learn that
switching the default route changes whether a caught failure inside a user's
transaction aborts that transaction. That is the half repair 2 adds.

**Row status, repair 2.** LX-02's "per-operation rollback inside a callback
transaction" coverage is qualified the way LX-04 and LX-14 were: it holds for a
MULTI-statement member (the shipped route opens its own `runTransactionScope`
savepoint there, which is why that oracle passes) and diverges for a
statement-atomic one.

## R.2 Finding 2 — a read member in an array transaction (divergence D-2)

**Reproduced** on a batch-only driver
([`review-probes-before.log`](receipts/repair/review-probes-before.log)):

```
read-only array      shipped = ok:[[{"email":"read-array@example.test"}]]
                     candidate = TransactionError: Driver "sqlite3" does not
                       support callback transactions and this transaction
                       contains operations that cannot be batched atomically.
mixed read + write   same refusal
```

**Owner.** Two facts compose: `#resolveSinglePlan` answers `undefined` for every
routed operation (so `owner.prepare` never publishes a single statement), and
the candidate's `prepareBatch` cannot package a READ — `batch-preparation`
ownership throws `incompletePreparation`
(`shared/operation-context.ts:314–316`), converted to `undefined` at
`commands/index.ts:93–98`, after which `array-transaction-legacy.ts` raises
`unbatchableArrayError`. That is B-1's family again: **no prepared read shape at
the candidate boundary**, here in its `prepareBatch` half. An interactive driver
is unaffected (the review's own control case passes).

**What was added.** `route-transactions.test.ts` →
*"LX-04 DIVERGENCE PIN blocker B-1: an array transaction containing a read is
refused on a batch-only driver"*, asserting **today's refusal** and the shipped
success side by side.

**Sensitivity.** Falsified by simulating the read half landing (a deliberately
illegal mutation: `#resolveSinglePlan` allowed to answer for routed READS). The
pin is the **only** case that flips —
[`falsifier-array-read-pin-r3.log`](receipts/repair/falsifier-array-read-pin-r3.log)
(`1 failed | 9 passed`). The mutation was reverted from a scratchpad copy and
the file re-verified by SHA-256 (`bc3e1191b946…fab6e795a`, identical before and
after).

**Row status.** LX-04 is now **partial**: the write half (admission order,
per-member results, atomicity, native packaging) is covered on both substrates;
the read half is refused on a batch-only substrate and pinned.

## R.3 Finding 3 — decision-record accuracy

- §5's sentence and all three of its table rows now state the condition
  (see §R.1 for the verbatim originals).
- `handoff.md` §1 "Binding rule" now says the write arm's `withTransaction`
  mirrors the shipped route **only for a multi-statement write**, and names D-1.
- The **"three unconditional edits"** claim in the unit's returned summary is
  corrected to **five** in §A (the three `#preparedInput()` sites plus
  `readPendingCacheResultFriend`'s codec and `cacheKeyArgs()`). §A.5–7 already
  listed all five accessors; the claim was a summary undercount, not a
  behavioral one. All five remain pure property reads on the shipped route —
  re-verified by 853 shipped tests green in r3 (§R.8).

## R.4 Finding 4 — the unreachable `parseResult` guard (the one production change)

Deleted from `src/query-engine/pending-operation.ts`
(`pendingOperationTransactionOwner.parseResult`):

```ts
        if (operation.#route) {
          // The candidate publishes a complete package and its parser; the
          // array owner never holds one of its statements on its own.
          throw new QueryEngineError(
            `Operation '…' on model '…' runs through the Raptor 3 route and parses no single driver result.`
          );
        }
```

**Why it cannot be reached.** `#resolveSinglePlan()` answers `undefined` for
every routed operation, so `owner.prepare` (`pending-operation.ts:362–370`)
always answers `undefined` for one; and all three array-owner call sites read a
result through `parseResult` **only** inside the `kind === "single"` branch they
take when `prepare` answered a statement (`array-transaction-legacy.ts:80–88`
and `:208–216`, `array-transaction-native.ts:73–86`). No path reaches the throw.

Per the repository's standing rule (one guard per invariant; never a check whose
unique coverage cannot be named) the guard is deleted and the short-circuit —
which is already load-bearing, and is what D-2 pins — is the invariant. A
comment at the seam names that invariant in one line. Cost: **−5 charged
token-lines** in a shipped file.

## R.5 Findings 5 and 6 — two divergences recorded, one requested change

- **D-3 — `prepareBatch` drops the supplied driver.** `owner.prepareBatch`
  receives the array owner's driver (the transaction-scoped one at
  `array-transaction-legacy.ts:204`) and the route branch discards it:
  `RoutedCandidateOperation.prepareBatch()` takes none, and
  `engine.prepareBatch(model, op, args)` builds its `OperationContext` on the
  **factory** driver (`commands/index.ts:85–92`, `operation-context.ts:114`).
  Unobservable today (B-4 keeps transforms and observation off candidate
  statements); observable the day B-4 lands.
  **Requested change (G4-01, `src/query-engine/raptor3/commands/index.ts`):**
  accept an optional driver on `prepareBatch` and pass it into the
  `OperationContext` constructor, exactly as `execute` already does through its
  binding —
  `prepareBatch(modelName, operation, rawArgs, driver?: AnyDriver)` →
  `new OperationContext(schema, driver ?? config.driver, …, undefined, true)`.
  This unit does not edit that file. When it lands, `client-route.ts` threads
  the driver and `pending-operation.ts`'s route branch stops ignoring its
  `driver` parameter — one line each.
- **D-4 — `buildStatement()` answers `undefined` for every routed operation**
  (`pending-operation.ts:859–863`), so `QueryEngine.build(model, op, args)`
  throws its existing "does not compile to one SQL statement" for an operation
  that plainly does. Internal only — no client surface reaches `build`
  (`grep -rn "\.build(" src/client` is empty) — but it was in no row and no
  divergence list, and now is (§D).

## R.6 Finding 7 — cost regenerated against the final files

`receipts/unit-cost.json` recomputed with the census's verbatim
`countTokenLines` against `git show 0cc61e61:<file>`
(script: `<scratchpad>/unit-cost.mjs`):

| File | Δ bytes | Δ physical | Δ token-lines |
| --- | --- | --- | --- |
| `src/query-engine/raptor3/route/client-route.ts` | +8,534 | +222 | +143 |
| `src/query-engine/pending-operation.ts` | +4,053 | +103 | **+68** |
| `src/client/client.ts` | +515 | +22 | +20 |
| `src/query-engine/query-engine.ts` | +430 | +10 | +5 |
| **Total charged to the candidate perimeter** | **+13,532** | **+357** | **+236** |

Incremental **core** semantic cost stays **0**: no line was added to
`commands/`, `shared/` or any other candidate kernel file.

## R.7 Registration requests, updated (to the witness author — manifest owner)

> **Historical.** This table is the repair-2 state. The CURRENT request — all
> four counts, measured on the tree after repair 3 — is **FU.12**. Read FU.12,
> not this section, before touching `scripts/raptor3-manifest.mjs`.

**Superseded by repair 2** for `route-transactions.test.ts`: the r3 request for
**10** is now **11** (one pin added for follow-up finding 9), and the line
reference below was stale. The table and the sentence are corrected in place.

| File | Expected tests | Was | Credential-free? | Project |
| --- | --- | --- | --- | --- |
| `tests/raptor3/g4/route-lifecycle.test.ts` | 7 | 7 | yes | `raptor3` |
| `tests/raptor3/g4/route-transactions.test.ts` | **11** (was **10** in r3) | 8 | yes | `raptor3` |
| `tests/raptor3/g4/route-cache.test.ts` | 6 | 6 | yes | `raptor3` |
| `tests/raptor3/g4/route-admission.test.ts` | 5 | 5 | yes | `raptor3` |

`G4_ROUTE_TRANSACTION_COUNTS` at `scripts/raptor3-manifest.mjs:527–529` must read
`11` (**corrected in repair 2**: r3 cited `:526–528` and `10`; the constant sits
at `:527–529` and still reads `8`, verified on the current tree). The unit total
becomes **29** behavior tests (7 + 11 + 6 + 5). The r2 request for
`tests/types/raptor3/route-public-types.core.types.ts` is unchanged (covered by
`run-typecheck.mjs`, deliberately not a layer type-core file).

**New, from finding 8:** a MySQL lane for B-2. The refusal B-2 claims to
preserve (`createMany({ skipDuplicates: true })` inside `$transaction([...])`)
is reachable **only** where
`adapter.mutations.skipDuplicatesStrategy === "recoverableUniqueError"`, i.e.
MySQL. Requested: a native MySQL witness that runs that shape on both routes and
pins whichever way it resolves. It cannot be written credential-free and nothing
in this environment can run it (§G.4, §G.5).

## R.8 Verification receipts for this revision

| Claim | Receipt | Result |
| --- | --- | --- |
| Review probes reproduce before the repair | [`review-probes-before.log`](receipts/repair/review-probes-before.log) | 3 failed \| 1 passed — findings 1 and 2 exactly as reported |
| The four route suites, with the two new pins (final run, after every edit) | [`route-suites-after.log`](receipts/repair/route-suites-after.log) | **28/28 passed**, 4.86 s wall, 631.7 MiB peak |
| D-1 pin is sensitive (region removed, restored from a scratchpad copy) | [`falsifier-envelope-removed-r3.log`](receipts/repair/falsifier-envelope-removed-r3.log) | 2 failed \| 8 passed — the D-1 pin and the member-rollback oracle, nothing else |
| D-2 pin is sensitive (read half simulated) | [`falsifier-array-read-pin-r3.log`](receipts/repair/falsifier-array-read-pin-r3.log) | 1 failed \| 9 passed — the D-2 pin only |
| Shipped client suites, batch 1 (arrays, nested, interceptors, transforms, extensions) | [`shipped-suites-r3-1.log`](receipts/repair/shipped-suites-r3-1.log) | 26 files / **677 passed** |
| Shipped client suites, batch 2 (construction, introspection, observers, cache) | [`shipped-suites-r3-2.log`](receipts/repair/shipped-suites-r3-2.log) | 21 files / **176 passed** |
| Shipped PGlite shard 3 (`batch-transaction`) | [`shipped-shared-family-shard3-r3.log`](receipts/repair/shipped-shared-family-shard3-r3.log) | 15 suites / **257 passed** |
| Shipped PGlite shard 7 (`engine/write/pending-operation-contract`) | [`shipped-shared-family-shard7-r3.log`](receipts/repair/shipped-shared-family-shard7-r3.log) | 15 suites / **213 passed** |
| Shipped PGlite shard 9 (`nested-transaction-contract`) | [`shipped-shared-family-shard9-r3.log`](receipts/repair/shipped-shared-family-shard9-r3.log) | 14 suites / **370 passed** |
| Whole-estate typecheck (final run, after every edit) | [`typecheck-r3.log`](receipts/repair/typecheck-r3.log) | **only** the two permitted `pattern/pack.ts` TS2345 diagnostics; 6.50 s wall, 5,803 MiB peak |
| Review probes after the repair | [`review-probes-after.log`](receipts/repair/review-probes-after.log) | 3 failed \| 9 passed — **unchanged and expected**: those three cases assert the two routes AGREE, which is the claim this revision withdraws. They are the external form of pins D-1 and D-2 |

Shipped totals for r3: **853** shipped client tests green (677 + 176) plus
**840** in the three PGlite shards, with no failure anywhere and no change in
any shipped behavior — the single production edit deletes a branch no shipped
operation can enter.

## R.9 What did NOT change, and why

- **No behavior change in `client-route.ts`.** The region of D-1 stays, because
  removing it breaks per-operation rollback inside a caller transaction
  (falsified, §R.1), and conditioning it needs B-1's seam.
- **No shipped-route behavior change anywhere.** The only production edit is a
  deletion of a route-only, unreachable guard.
- **No second admission, no second planning authority, no fallback** was added
  to make any probe pass. Both must-fix findings are answered by naming the
  divergence and pinning it, which is what the review asked for when the
  mirroring decision is unavailable.

# Repair 2 — revision r4 (2026-09-15, after the review follow-up returned REVISE a second time)

Input: [`../unit03-review-followup.md`](../unit03-review-followup.md) — one new
must-fix (**finding 9**: divergence D-1 also changes committed state and the
caller-visible outcome) and one note (**finding 10**: the registered count for
`route-transactions.test.ts` is stale and §R.7/handoff cite a stale line range).
All eight round-1 findings stay resolved; the follow-up re-verified them.

**No production change in this repair.** `src/` is byte-identical to the tree the
follow-up reviewed (identities in §R.12). One test was added, and the decision
records were extended. The resolution path for D-1 was decided by the integrator
and is recorded in the G4-02 brief item 11 — see §R.10.5.

## Summary table for repair 2 (finding → change → verification receipt)

| # | Severity | Change | Receipt |
| --- | --- | --- | --- |
| 9 | must-fix | Divergence **D-1** extended with its STATE/OUTCOME half and the `poisonOnFailure` mechanism in §5, §D, §R.1 and `handoff.md` §1; one self-falsifying pin added to `route-transactions.test.ts` asserting today's two outcomes side by side; **LX-02 qualified** in §D the way LX-04 and LX-14 were; recorded as **resolved by design** (G4-02 brief item 11), not as a decision for Arnaud (§R.10.5). No production change | [`finding9-repro.log`](receipts/repair2/finding9-repro.log), [`falsify-d1-state-pin.log`](receipts/repair2/falsify-d1-state-pin.log), [`route-suites-after-repair2.log`](receipts/repair2/route-suites-after-repair2.log) |
| 10 | note | Registration request updated to **11** tests (unit total **29**) and the stale manifest line range corrected to `:527-529` in §R.7, §E and `handoff.md` §5. Manifest not edited (witness author's file) | [`route-suites-after-repair2.log`](receipts/repair2/route-suites-after-repair2.log), §R.11 |

## R.10 Finding 9 — D-1 also changes committed state and the caller-visible outcome

### R.10.1 Reproduced, unchanged, before any edit

The reviewer's kept probe, re-run on this tree with nothing modified:

```
node scripts/run-vitest-safe.mjs run \
  --workspace=tests/raptor3/g4/review/unit03/review.workspace.ts \
  tests/raptor3/g4/review/unit03/route-region-followup.review.test.ts
```

[`finding9-repro.log`](receipts/repair2/finding9-repro.log) — **1 passed | 2 failed**,
exactly as the follow-up reports:

```
candidate = {inner:"UniqueConstraintError:Unique constraint violation",
             afterWrite:"ok", outer:undefined,
             stored:[taken@…, kept@…, after@…]}
shipped   = {inner:"UniqueConstraintError:Unique constraint violation",
             afterWrite:"UniqueConstraintError:Unique constraint violation",
             outer:"UniqueConstraintError:Unique constraint violation",
             stored:[taken@…]}
```

The passing case is the READ inside `$transaction(callback)` (the divergence is
write-only, as the record claims). The second failing case is D-1's unit sequence
one savepoint deeper — the same named divergence, not a second one.

### R.10.2 Mechanism, from source

| shape | tracked as | on failure |
| --- | --- | --- |
| SHIPPED, statement-atomic write inside a callback transaction: `compileSingleStatementCandidate` + `canExecuteDirectly` → `runStatementAtomic` (`write-engine/OperationExecutor.ts:347-357`), i.e. a DIRECT statement on the caller's transaction-scoped driver | `trackTransactionOperation(…, poisonOnFailure = true)` (`src/drivers/driver.ts:665-667`) | `markCurrentScopeRollbackOnly(error)` unconditionally (`driver.ts:649` → `:564-566`) — the caller's scope is rollback-only, so its next operation and its commit both throw that error (`assertTransactionOpen` `driver.ts:576-579`, `assertTransactionCommittable` `:559-561`) |
| CANDIDATE, the route's region for EVERY write (`route/client-route.ts:197-207`): a nested `engineDriver.withTransaction(…)` | `trackTransactionOperation(…, poisonOnFailure = false)` (`driver.ts:797-799`) | poisons the caller only `if (this.transactionClosed && !observation.isRejectionObserved)` (`driver.ts:642-648`); the route awaits the region's rejection, so the caller is never poisoned and only the member's savepoint rolls back |

Measured consequence (both routes, same program, default better-sqlite3):

| | shipped | candidate |
| --- | --- | --- |
| the failing member's error | `UniqueConstraintError` | `UniqueConstraintError` (same identity) |
| the next operation in the same callback | rejects with the same error | succeeds |
| `$transaction(callback)` | rejects | resolves |
| committed rows | only the pre-transaction row | the pre-transaction row plus both callback members |

This is not the multi-statement case LX-02's existing oracle covers: there the
shipped route opens its own `runTransaction` → `runTransactionScope` savepoint,
so both routes roll back only the member and both keep the caller's transaction —
which is why that oracle passes on both routes today.

### R.10.3 What was added — one self-falsifying pin, both routes side by side

`tests/raptor3/g4/route-transactions.test.ts` →
*"LX-02 DIVERGENCE PIN blocker B-1: a FAILING statement-atomic write inside a
callback transaction poisons the caller's transaction on the shipped route and
only its own member on the candidate route"*.

It asserts, for each route separately and explicitly: the failing member's error
identity (equal on both), the outcome of the caller's NEXT operation, whether
`$transaction` resolves or rejects, and the exact committed rows. Either column
moving turns it red — including the day the G4-02 envelope decision (§R.10.5)
makes the candidate column equal the shipped one, which is the intended tripwire.
The file now holds **11** tests, all green:
[`route-transactions-with-pin.log`](receipts/repair2/route-transactions-with-pin.log).

### R.10.4 Falsification — the pin is sensitive, and the region is the mechanism

The route's region was removed from `runCandidate` (the write branch made a plain
`borrowed-transaction` on `engineDriver`, which is exactly the shape the G4-02
resolution prescribes for a single-statement operation), the file was restored
from a scratchpad copy, and its SHA-256 re-verified.

[`falsify-d1-state-pin.log`](receipts/repair2/falsify-d1-state-pin.log) —
**3 failed | 8 passed**: the new pin, the r3 D-1 unit pin, and LX-02 "a failed
operation … rolls back only itself", nothing else. The new pin fails on exactly
one assertion:

```
candidate afterWrite: expected 'ok', actual 'UniqueConstraintError'
```

That is the whole finding in one line: without the region the candidate produces
the **shipped** outcome. The region is the divergence, and running the write
directly on the borrowed driver reproduces the shipped semantics in this tree —
not by argument, by receipt.

### R.10.5 Resolution — resolved by design in G4-02, not a decision for Arnaud

The follow-up's remedy (d) was "mark it as a C-01 decision for Arnaud". The
integrator has since decided the resolution path and recorded it in
[`../briefs/unit02-physical-provider.md`](../briefs/unit02-physical-provider.md)
item 11: **the candidate, not the route, decides the physical envelope, in
`OperationContext`**, and the route passes `memberRollback` as a capability the
candidate invokes instead of wrapping every write. For a borrowed transaction:

- a **single-statement** operation runs directly on the borrowed driver →
  `poisonOnFailure = true` → the caller's transaction is poisoned exactly as
  `runStatementAtomic` poisons it today (**witnessed** by §R.10.4: that is the
  mutation, and the candidate column became the shipped column);
- a **multi-statement** operation runs inside the `memberRollback` region the
  existing transaction owner supplies → `poisonOnFailure = false`, savepoint
  rollback for that member only, caller's transaction still usable — which is
  what the route's region does today and what LX-02's multi-statement oracle
  already shows agreeing with `runTransactionScope` on both routes.

So the planned design **mirrors shipped semantics on both branches**: there is no
case where the candidate would deliberately differ, therefore no new observable
compatibility choice, therefore nothing for Arnaud to choose. Both mechanisms are
already present in this tree; what moves is only *who decides which one*, from
the route (which holds nothing compiled, blocker B-1) to the one owner that knows
the compiled shape. I record D-1 as **resolved by design, owner G4-02 item 11**,
and I do not record it as a decision. The pin stays as the tripwire that fails
the day the design lands and must then be rewritten into an equality oracle.

**If it could not be mirrored I would say so; the one place I cannot witness the
mirror is the multi-statement half's observed UNITS** (LX-02's multi-statement
oracle compares state, not units, and this unit added no probe for it), so
"the multi-statement branch also mirrors shipped *observability*" is recorded as
**unverified** (§G, claim 6). G4-02 item 11 already requires pinning both D-1
outcomes against the shipped engine, which is where that check belongs.

The other three route call paths need no decision either: the root/standalone
path is item 11's standalone rule (one physical statement → no envelope, mirroring
`runStatementAtomic`); the `driverOverride` path already mirrors
`runLinearOn` (no second envelope, no `memberRollback`); `atomic-array` stays
unreachable from the route. The only residual compatibility item in this unit is
**B-2** (MySQL-only, unreachable here, already recorded unverified with a
requested native pin).

## R.11 Finding 10 — stale registered count and stale line references

- `scripts/raptor3-manifest.mjs:527-529` (`G4_ROUTE_TRANSACTION_COUNTS`) reads
  `8` on the current tree; the file now holds **11** tests. §R.7 and
  `handoff.md` §5 are corrected: **11**, unit total **29**, and the line range
  `:527-529` (r3 cited `:526-528`, which was one line short after the witness
  author's own edits). The manifest is the witness author's file and was **not**
  edited here; the integrator/witness lands the bump.
- The r3 evidence-timing nit the follow-up already closed is left as it is: the
  label on `receipts/repair/route-suites-after.log` was optimistic, the file
  reconstructs byte-identically from `tests.patch`, and this repair re-ran the
  suites after the last edit anyway (§R.12).

## R.12 Verification receipts for repair 2

| Claim | Receipt | Result |
| --- | --- | --- |
| Finding 9 reproduces on the untouched tree | [`finding9-repro.log`](receipts/repair2/finding9-repro.log) | 1 passed \| **2 failed** — the failing-write case and D-1's units one savepoint deeper (2.56 s wall, 446.8 MiB peak) |
| The new pin is green and the file holds 11 tests | [`route-transactions-with-pin.log`](receipts/repair2/route-transactions-with-pin.log) | **11/11 passed** (4.17 s wall, 576.8 MiB peak) |
| The new pin is sensitive, and the region is the mechanism (region removed, restored from a scratchpad copy, SHA-256 re-verified) | [`falsify-d1-state-pin.log`](receipts/repair2/falsify-d1-state-pin.log) | **3 failed \| 8 passed** — the two D-1 pins and the member-rollback oracle, nothing else (4.23 s wall, 606.5 MiB peak) |
| All four route suites, final run after every edit | [`route-suites-after-repair2.log`](receipts/repair2/route-suites-after-repair2.log) | **29/29 passed** (4.61 s wall, 634.8 MiB peak; 7 + 11 + 6 + 5) |
| The reviewer's probes, re-run after this repair (round 1 + follow-up, 6 files) | [`review-probes-after-repair2.log`](receipts/repair2/review-probes-after-repair2.log) | **5 failed \| 10 passed** (2.76 s wall, 612.4 MiB peak) — unchanged and expected: every failure is a case asserting the two routes AGREE, which is the claim D-1 and D-2 withdraw and pin |
| Whole-estate typecheck, final run after every edit | [`typecheck-repair2.log`](receipts/repair2/typecheck-repair2.log) | **only** the two permitted `pattern/pack.ts` TS2345 diagnostics (`:1443`, `:2633`); 6.43 s wall, 5,613.1 MiB peak |
| `src/` identity vs the reviewed tree | [`source-identity.log`](receipts/repair2/source-identity.log) | `client-route.ts` `77df5c09…54bf881` and `pending-operation.ts` `bc3e1191…fab6e795a` — the two hashes the follow-up recorded; `git diff --stat` still shows the same three modified shipped files |

No shipped suite was re-run in this repair and none needed to be: no production
file changed (identities above), and the follow-up itself re-ran the shipped
owners (104/104) and the unit's suites (28/28) on this exact `src/`.

**Charged cost is unchanged** by repair 2: **+236 token-lines / +357 physical /
+13,532 bytes**, incremental core semantic cost **0** (§R.6). The regenerated
`production.patch` is **byte-identical** to the one the follow-up reviewed, which
is the check that justifies inheriting the figure rather than recomputing it;
`tests.patch` grew by the one pin (+86 lines) and all five files it carries
reconstruct byte-identically from it. Tests and evidence are counted separately.

**Environment note.** The workspace lock was held by another stream several times
during this repair (`scripts/raptor3-cli.test.mjs`, then two whole-estate
typechecks). Every run above waited and retried through the bounded runner; none
was bypassed, and no two commands ran concurrently from this session.

## R.13 What did NOT change, and why

- **No production change.** The route's region stays until the G4-02 envelope
  decision lands; removing it here would fix the statement-atomic outcome and
  break the multi-statement member rollback (falsified twice now, §R.1 and
  §R.10.4), and conditioning it inside the route needs a compiled shape the
  route does not have (B-1).
- **No manifest edit** (witness author's file) and **no edit to the G4-02 brief**
  (integrator's file); the count request lives in §R.7 and handoff §5.
- **No new decision recorded for Arnaud**, because the decided resolution mirrors
  shipped semantics on both branches (§R.10.5). The reviewer's remedies (a), (b),
  (c) and (e) are applied as asked; (d) is answered by the integrator's decision
  rather than by a blocker.
- **The reviewer's probe files were not touched** — they are the reviewer's, and
  re-running them is how §R.12's probe row is produced.
- **No cost recomputation, no new census run**, because `production.patch` is
  byte-identical to the reviewed one (§R.12).

---

# Follow-up after G4-02 (unit G4-03b, 2026-09-15)

Brief: [`../briefs/unit03b-route-followup.md`](../briefs/unit03b-route-followup.md).
Receipts for everything below: [`receipts/followup/`](receipts/followup/).
Patches: [`production-followup.patch`](production-followup.patch),
[`tests-followup.patch`](tests-followup.patch).

G4-02 phase 2 landed the four candidate-side capabilities this unit was blocked
on. This section is the decision-elimination gate for consuming them, written
before the first production edit, then completed with the measured record.

## FU.1 Required behavior

| # | Behavior | Inventory row |
| --- | --- | --- |
| 1 | A write inside `$transaction(callback)` gets the caller's transferred region, not a route-opened one: the candidate decides the envelope | LX-02, LX-14 (divergence D-1, both halves) |
| 2 | The interceptor `input` and the cache key are the ADMITTED payload, admitted exactly once | LX-12, LX-07/NS-04 key half |
| 3 | The client's trusted execution context reaches candidate statements | LX-13, LX-14 statement units, LX-15 |
| 4 | A read member in an atomic array on a batch-only driver succeeds | LX-04 read half (divergence D-2) |
| 5 | The candidate reuses the client's already-resolved schema views | B-3 |
| 6 | The array owner's driver reaches `prepareBatch`; `buildStatement()` answers the prepared read's statement | D-3, D-4 |
| 7 | `$withCache` stores and materializes a candidate read | LX-07 store half, RF-10, NS-04 codec half |

## FU.2 Current owner, per obligation

| Obligation | Owner BEFORE this unit | Owner AFTER |
| --- | --- | --- |
| 1 | `runCandidate` opened `engineDriver.withTransaction(...)` for every borrowed write and passed `memberRollback` bound to the scoped driver | `OperationContext.region()` — the route only TRANSFERS the right to open one (`operationRegion`), the candidate decides whether to use it |
| 2 | the route answered `preparedArgs` with the CLIENT-prepared payload (B-1 consequence) | `PreparedOperation.args` — the candidate's one admission |
| 3 | `OperationContext` minted a plain `{model, operation, correlationId}` | the route passes `execution.context`; `OperationContext.callerAttribution` consumes it |
| 4 | `prepareBatch` refused a read (`incompletePreparation`) | the candidate packages reads (G4-02 item 12) |
| 5 | `new EngineSchema(schema)` hydrated and validated a second time | `EngineConfig.resolved`, handed over by identity from `VibORM`'s constructor |
| 6 | `commands/index.ts` `prepareBatch(attribution?)` — no driver; `PreparedRead` — no statement | unchanged: see FU.6 blockers D-3', D-4' |
| 7 | the route refused with `UnsupportedOperationError` | unchanged: see FU.6 blocker B-1c |

## FU.3 Smallest proposed change

Five edits, all inside this unit's files.

1. **`route/client-route.ts`, `runCandidate`.** Delete the `withTransaction`
   wrap and the `isWrite` branch. One borrowed binding per caller situation:
   `driverOverride` → `{kind, driver}` with NO grant (the array owner's own
   transaction is the unit); the transaction-bound engine → `{kind, driver,
   operationRegion, memberRollback}`; root → no binding. Exactly the diff
   `g4/unit02/note.md` §P.13 wrote out.
2. **`route/client-route.ts`, `operation()`.** `const prepared =
   engine.prepare(...)` once; `preparedArgs` becomes a getter over
   `prepared.args`; `prepareBatch(context)` and `execute` forward the client's
   attribution.
3. **`pending-operation.ts`.** The array owner's `prepareBatch` seam passes
   `operation.#context.attribution`.
4. **`client.ts`.** `route?.(this.schema, config.driver, {index: relations,
   registry: schemaRegistry})` — the two views the constructor already built.
5. **`route/client-route.ts`, `createCandidateRoute`.** Third parameter
   `resolved?: ResolvedSchemaViews`, forwarded to `createCommandEngine`.

## FU.4 What disappears, and the invariant that replaces it

| Decision that disappears | Mechanism deleted | Replacing invariant | Falsifier |
| --- | --- | --- | --- |
| "does this borrowed write need an envelope?" asked by the ROUTE | `engineDriver.withTransaction(...)` wrap + the `execution.isWrite` branch in `runCandidate` | ONE envelope owner: `OperationContext.run`'s deferred-statement rule decides, for every ownership | `route-transactions.test.ts` LX-14/LX-02 parity cells; `review/unit03/route-region-followup.review.test.ts` (3 cells) |
| "which payload is this operation's input?" answered differently per route | the B-1 consequence (client-prepared payload) in `#preparedInput`/`#cacheKeyPayload` | the admitting owner publishes it: `PreparedOperation.args` | `route-lifecycle.test.ts` LX-12 (`seen` equal on both routes); `route-admission.test.ts` admission-count cells |
| "who attributes a candidate statement?" | `OperationContext`'s minted attribution reaching the driver | the operation's own trusted context, created once by `createPendingOperationContext` | `route-lifecycle.test.ts` LX-13/LX-14 |
| "is this schema resolved?" asked twice per client | `new EngineSchema(schema)` re-hydrating and re-validating | the client's `ResolvedRelationIndex` and registry travel by identity | `review/unit03/…` + typecheck; identity assertion in `route-lifecycle.test.ts` |
| three route-local refusal pins | the D-1 (×2) and D-2 `DIVERGENCE PIN` cases | positive parity oracles against the shipped route | the oracles themselves |

No new decision is introduced: the route still owns exactly one, "which driver
did an existing owner supply", and now states it in the two grant fields the
candidate reads instead of opening a scope of its own.

## FU.5 Falsifiers this unit must fail

1. Re-adding the route's `withTransaction` wrap must break the LX-02 parity cell
   (the caller's transaction must stay poisoned) — the inverse of §R.10.4.
2. Granting `operationRegion` on the `driverOverride` (array) arm must break
   `g3-suppression-retry` / `g3-scope-composition-*` (unit02 §8.4).
3. Passing the client's context but re-minting attribution must leave
   `route-lifecycle.test.ts` LX-13 with `observed === []`.
4. Admitting twice (answering `preparedArgs` from a second `schema.admit`) must
   double the `admissions` counter in `route-admission.test.ts`.

## FU.6 Blockers recorded (not chosen), with the exact requested change

### B-1c — the cache result codec still cannot be composed without a second scalar authority

`PreparedRead` now publishes `shape`, `value`, `single` and `empty`, which is
everything the codec's STRUCTURE needs. What it does not publish is the one fact
each LEAF codec is compiled from: the `Scalar` itself.
`src/query-engine/result/cache-value-codecs.ts` is the official owner
(`compileScalarCodec(scalar)`, plus the exported `recordCodec`, `arrayCodec`,
`nullableCodec`, `countCodec`, `booleanCodec`, `numberCodec`,
`taggedRelationCodec`, `compileWidenedSumCodec` composers), and it addresses a
scalar by the object, never by a type name. `Leaf` carries a PROJECTION of that
object's state (`type`, `nullable`, `list`, `decimal`, `widened`, `dateTime`,
`enumValues`, `dimension`) — enough to re-dispatch, which is exactly the second
scalar-meaning authority the §7 gate rejects ("per-operation codec
implementations"). Writing it in the route to make the witness cell green is the
common brief's "duplicated semantic interpretation to pass a witness" stop rule,
so it was NOT written.

**Exact requested change** — `src/query-engine/raptor3/shared/query.ts` (one
line in the type, one in the constructor; the file is another stream's):

```ts
 export type Leaf = {
   kind: "scalar";
   type: string;
   nullable: boolean;
+  /** The declaring scalar, for consumers that compile a value codec from it. */
+  scalar: Scalar;
   …
 };
 …
   private leaf(scalar: Scalar, nullable: boolean): Leaf {
     const state = scalar["~"].state;
     return Object.freeze({
       kind: "scalar",
       type: state.type,
       nullable,
+      scalar,
```

With it the route composes the codec from the OFFICIAL owners in ~35 lines and
adds no scalar authority:

```ts
function leafCodec(leaf: Leaf): ValueCodec {
  const value = leaf.widened
    ? compileWidenedSumCodec(leaf.scalar)
    : compileScalarCodec(leaf.scalar, false);
  return leaf.nullable ? nullableCodec(value) : value;
}
function shapeCodec(shape: ProjectionShape | Leaf): ValueCodec { … }  // object → recordCodec, collection → arrayCodec, variants → taggedRelationCodec
```

**Reproducer (today):** `route-cache.test.ts` → "LX-07 PENDING blocker B-1c: a
cached read refuses at the candidate result codec", and the witness cell
`tests/raptor3/g4/lifecycle-admission.test.ts` → "C13 cache-bypass: a cached read
inside a transaction never serves the cache".

**Causation, stated plainly** (corrected in repair 3, review note 3). The witness
file belongs to another stream, but the red is PRODUCED by the refusal above:
`cacheResultCodec()` throws, and the cell asks for a cached read. Earlier revisions
called it "inherited red, not this unit's file", which is accurate about
OWNERSHIP and generous about CAUSATION. The registered `g4-lifecycle-admission`
suite is red at 3/4 until the one-line `shared/query.ts` change above lands, and
brief outcome 2 ("$withCache works on the candidate route for reads; RF-10 and
NS-04 hold") is met for the KEY half only — NS-04's key parity and RF-10's
bypass rules hold, the store/materialize half does not.

### D-3' — `prepareBatch` still takes no driver

`PreparedOperation.prepareBatch(attribution?)`
(`src/query-engine/raptor3/commands/index.ts`, G4-01's file) constructs
`new OperationContext(schema, config.driver, …, undefined, true, attribution)`:
the binding argument is hard-coded `undefined`, so a package is `_prepare`d on
the FACTORY driver while the array owner executes it on the driver it supplied.
The route now RECEIVES that driver at its `prepareBatch` seam and has nowhere to
put it.

**Exact requested change** (`commands/index.ts`): give `prepareBatch` the same
`binding?: ExecutionBinding` parameter `execute` already has and pass it to the
`OperationContext` constructor, so the route forwards
`{kind: "borrowed-transaction", driver}`.

**Observability:** now that B-4 is consumed, a package prepared on the wrong
driver object is observable through statement attribution, which is why this is
recorded here rather than left silent. No pin: both drivers are the same client's
lineage and share one adapter, so nothing in the SQLite/PGlite estate can yet
show a difference. See FU.8.

### D-4' — `buildStatement()` still answers `undefined`

`PreparedRead` publishes no `Sql`. `Read.query.sql` exists inside the candidate;
publishing it is one line.

**Exact requested change** (`commands/index.ts`, `publishedFacts`): add
`readonly statement: Sql` to `PreparedRead`, sourced from `value.query.sql`. The
route then answers `buildStatement()` with `prepared.read?.statement`.

Internal only: `grep -rn "\.build(" src/client` is empty, so no client surface
reaches `QueryEngine.build`. Kept without a pin, as in r3.

### D-5 — a MULTI-statement array member is refused by the shipped route and packaged by the candidate (batch-only substrate)

Found by the G4-03b independent review (finding 2), not by this unit. Recorded
here in repair 3 as a **refusal-removal decision for Arnaud**, pinned on both
routes, never repaired in the candidate.

**The two answers.** `client.$transaction([ client.author.create({ data: { …,
books: { create: [ … , … ] } } }) ])` on a `supportsBatch && !supportsTransactions`
driver:

| | shipped | candidate |
| --- | --- | --- |
| outcome | `TransactionError: query-engine-v2 cannot merge an insertId-scratch operation into a shared driver batch.` | `ok:[{"email":"d5@example.test"}]` |
| native batches | 0 | 1 |
| rows written | none | the author and both books |

**Shipped owner.** `src/query-engine/write-engine/OperationExecutor.ts:1515–1519`
(`prepareSharedBatch`): a compiled plan whose steps use the insertId scratch is
refused, and with no interactive transport there is no sequential `executeWith`
arm to fall through to, so the array fails and writes nothing.

**Candidate mechanism.** `PendingOperation.#resolveSinglePlan`
(`src/query-engine/pending-operation.ts:601–604`) answers `undefined` for every
routed operation, so the array owner always asks the route for a package
(`prepareBatch`, `:371–379`), and since G4-02 item 12 the candidate's package
carries the whole multi-statement write. Nothing in the route decides this; the
refusal simply has no counterpart in the candidate's packaging rule.

**Scope.** The same member on an INTERACTIVE driver agrees on both routes (both
take the array owner's sequential arm). The divergence exists only where there
is no sequential fallback, and the pin asserts both halves.

**The decision Arnaud owns.** The inventory's LX-04 disposition ("candidate
provides packageability, never another protocol") reads as if the direction is
wanted, and the candidate's answer is the one a user would prefer — but it
REMOVES a public refusal, which the common brief makes a contract. Either:

- (a) approve it as a compatibility change and register it in the inventory's
  section G alongside RF-01…RF-16, naming `OperationExecutor.ts:1515` as the
  shipped owner the change retires; or
- (b) refuse it, in which case the refusal must move to the owner that can still
  see the plan — the candidate's packaging rule, not the route, because a route
  that re-derived "does this package use insertId scratch?" would be a second
  plan authority.

Do NOT re-introduce the refusal in the route. This unit chose neither.

**Pin (today's answer, both routes):** `route-transactions.test.ts` → "D-5 PIN a
MULTI-statement array member is refused by the shipped route and packaged by the
candidate on a batch-only driver". It asserts the shipped refusal text, the
candidate's committed rows and single native batch, the interactive-substrate
parity, and `notEqual` on the two outcomes — so PARITY IN EITHER DIRECTION also
fails it, which is what makes it a decision alarm rather than a snapshot.

### D-6 — the `upsert` interceptor payload differs between the routes

Found by the G4-03b independent review (finding 1), not by this unit. Recorded
here in repair 3 as a **published-payload compatibility decision for Arnaud**,
pinned on both routes.

**The two answers.** For `client.author.upsert({ where, create, update })` a
query interceptor's `context.input` is:

```
shipped    create: { email, name }                      update: { name: "Updated" }
candidate  create: { email, id: undefined, name,        update: { name: { set: "Updated" } }
                     score: 0, secret: "hidden" }
```

Public results and committed state are identical on both routes; only the
published payload differs, on both the insert and the update arm.

**Shipped owner.** `src/query-engine/write-engine/routing.ts`, `case "upsert"`
validates the ENVELOPE only — "the delegated sub-ops still parse raw, and …
stays deferred to the taken branch" — so the arms reach the interceptor exactly
as the caller wrote them.

**Candidate mechanism.** The candidate admits the whole payload ONCE, and
`PendingOperation.#preparedInput` (`src/query-engine/pending-operation.ts:569`,
consumed at `:300` and `:696`) publishes that admission. Admission fills scalar
defaults into `create` and normalizes `update`'s assignments to `{ set: … }`.

**Scope.** `upsert` is the ONLY diverging verb. `create`, `createMany`,
`update`, `updateMany`, `delete`, `deleteMany` and all nine read verbs publish
byte-identical payloads, and `cacheKeyArgs()` agrees on every read verb —
measured by the reviewer's all-verb sweep
(`tests/raptor3/g4/review/unit03b/route-seams.review.test.ts`, cells 1–2) and
consistent with the 16-verb parity sweep in `route-admission.test.ts`.

**The decision Arnaud owns.** An extension reading `input.update.title` gets
`"updated"` today and `{ set: "updated" }` on the candidate route; one reading
`input.create` sees keys the caller never wrote. Either:

- (a) approve the normalized payload as the intended `upsert` publication (it is
  the payload that actually runs, which is the LX-12 rule for every other verb)
  and register it in the inventory's section G; or
- (b) require the raw arms, in which case the fix belongs to the SHIPPED/candidate
  admission boundary — `upsert` would have to publish its envelope with the arms
  un-admitted, i.e. the candidate would need a payload view that is neither its
  admission nor a second one.

Do NOT re-raw the arms in the route: reading `args` back for `preparedArgs` is
the r1 B-1 stand-in this follow-up deleted, and re-admitting later would be a
SECOND admission (falsification 4, and falsification 6 below).

**Pin (today's answer, both routes):** `route-lifecycle.test.ts` → "D-6 PIN the
interceptor input for upsert is the caller's raw arms on the shipped route and
the ONE admission on the candidate". It asserts the identical public results,
the identical envelope outside the two arms, each route's exact arms, and
`notDeepEqual` on the published payloads.

## FU.7 What was built, exactly

Four production files, all this unit's. `production-followup.patch` and
`tests-followup.patch` are the WHOLE unit against `0cc61e61` (they supersede
`production.patch` / `tests.patch`), and both reconstruct byte-identically
([`patch-reconstruction.log`](receipts/followup/patch-reconstruction.log)).

| File | Change | SHA-256 |
| --- | --- | --- |
| `src/query-engine/raptor3/route/client-route.ts` | one `engine.prepare(...)` handle per operation; `preparedArgs` is a getter over `prepared.args`; `prepareBatch(context)` and `execute` forward the client's attribution; `runCandidate` takes the prepared handle, drops the `withTransaction` wrap and the `isWrite` branch, and states the situation in the two grant fields; third `resolved` parameter | `82ba9c9e…7490b111` |
| `src/query-engine/pending-operation.ts` | the array owner's `prepareBatch` seam passes `#context.attribution`; two comments re-attributed (`#preparedInput`, `buildStatement` → D-4') | `1e19986c…6df85ef` |
| `src/client/client.ts` | the constructor hands `{index, registry}` to the route factory | `76433612…d57459bf` |
| `src/query-engine/query-engine.ts` | **unchanged this round** (r1's `route` seam was already right) | `bb07f7a0…80d5b612` |

One file outside this unit was touched, and it is a TEST probe, not production:
`tests/raptor3/g4/review/unit03/route-admission-count.review.test.ts` is a
reviewer's delegating wrapper around `RoutedCandidateOperation`, and the new
`prepareBatch(context)` parameter made its `prepareBatch: () => inner.prepareBatch()`
a whole-estate TS2554. It now forwards the parameter — one line, no assertion
changed. Recorded here because it is another stream's file; the alternative
(making the parameter optional so a dropped context compiles) would have made
the B-4 seam silently skippable.

### The route's own decision, before and after

```ts
// before — the ROUTE decided that a borrowed write needs an envelope
if (!execution.isWrite) return engine.execute(…, {kind, driver: engineDriver});
return engineDriver.withTransaction(
  (scoped) => engine.execute(…, {kind, driver: scoped, memberRollback: …}), …);

// after — the route states WHICH SITUATION it is in; the candidate decides
return prepared.execute(
  { driver: engineDriver, kind: "borrowed-transaction",
    memberRollback: …, operationRegion: … },
  context);
```

## FU.8 §7 decision-elimination answers, against this diff

1. **Which decision does this change eliminate, and where did it live?**
   "Does this borrowed write need a physical envelope?", asked in
   `runCandidate` for every write inside a caller transaction, and answered
   `yes` unconditionally because the route has no compiled shape to ask. It now
   has exactly one owner, `OperationContext.run`'s deferred-statement rule,
   which answers it for standalone, borrowed and batch ownership alike. The
   route's remaining decision — which driver an existing owner supplied — is
   the only one it ever had, and it is now stated as data (which grant fields
   are present) rather than as control flow.
2. **What replaces it?** The grant pair on the borrowed binding. `memberRollback`
   means "isolate a member inside the scope you are in"; `operationRegion` means
   "the caller opened nothing, you may open ONE". Three call sites, three
   distinct situations, no boolean: root passes no binding, the array arm passes
   neither grant (its own batch is the unit), the callback-transaction arm passes
   both.
3. **Is any fact now derived twice?** No — three were un-duplicated. The
   admitted payload had two producers (the candidate's `schema.admit` and the
   route's "client-prepared payload" stand-in) and now has one. The statement
   attribution had two (the client's trusted context and `OperationContext`'s
   minted one) and now has one. The resolved topology index and schema registry
   had two producers per client and now have one.
4. **Does the diff add a decision, a class, a registry or a policy flag?** No
   class, no registry, no flag. The route gained one optional parameter
   (`resolved`), one parameter on `prepareBatch`, and lost a branch: its token
   count went DOWN by 4 while consuming four capabilities.

## FU.9 Cost

[`receipts/followup/unit-cost.json`](receipts/followup/unit-cost.json),
`countTokenLines` copied verbatim from `scripts/query-engine-structure.mjs`.

| | token-lines | physical | bytes |
| --- | --- | --- | --- |
| **This follow-up alone** (vs the r1–r4 figures in `receipts/unit-cost.json`) | **+6** | +23 | +1,121 |
| `client-route.ts` alone | **+1** | +12 | +636 |
| `pending-operation.ts` / `client.ts` / `query-engine.ts` | +2 / +3 / 0 | +6 / +5 / 0 | +260 / +225 / 0 |
| **The whole G4-03 unit** vs `0cc61e61` | **+242** | +380 | +14,653 |

Incremental core semantic cost is **0 outside the new route adapter**: no file
under `src/query-engine/raptor3/` OTHER THAN `route/client-route.ts` changed.
The adapter is itself under that directory and is charged in full: **+144
token-lines / +234 physical / +9,170 bytes** of the unit's +242 / +380 / +14,653
(`receipts/followup/unit-cost.json`). (Corrected in repair 3, review note 5: the
earlier sentence read as a zero when skimmed.) The route's own charged
lines are net **+1** — it consumed four capabilities (a prepared handle, the
threaded context, the two grants and the resolved views) while deleting the
`withTransaction` wrap and the `isWrite` branch. (Measured before the Biome
formatting pass the route was −4; formatting split three long lines. Both
figures are in the receipt's history — the table above is the FINAL tree.)
Tests and evidence are counted separately.

## FU.10 Evidence

| Claim | Receipt | Result |
| --- | --- | --- |
| Baseline before any edit | [`baseline-route-suites.log`](receipts/followup/baseline-route-suites.log) | **3 failed / 26 passed (29)** — the stale `delete` admission cell, the D-2 pin, the D-1 unit pin |
| The four route suites, final for the follow-up | [`final-route-and-witness-suites.log`](receipts/followup/final-route-and-witness-suites.log) | **33/33 passed** (7 lifecycle + 12 transactions + 7 cache + 7 admission), 5.90 s wall, 727.2 MiB peak. **Superseded by repair 3**, which adds one cell to each of two files: **35/35** (8 + 13 + 7 + 7), [`followup-repair/final-route-and-witness-suites.log`](receipts/followup-repair/final-route-and-witness-suites.log) |
| C13 lifecycle witnesses (`g4-lifecycle-*`), same run | same receipt | `lifecycle-events` **3/3 passed** (was 2 red — B-4); `lifecycle-admission` **3 passed / 1 failed**, the cache-bypass cell, which is blocker B-1c |
| The unit03 reviewer's probes | [`review-unit03-probes.log`](receipts/followup/review-unit03-probes.log) | **19/19 passed (8 files)**, 4.25 s wall — repair 2 measured **5 failed / 10 passed** on the same probes (§R.12), and every one of those five asserted the two routes AGREE |
| The unit02 admission-count oracle | [`review-unit02-admission-count.log`](receipts/followup/review-unit02-admission-count.log) | 1/1 passed |
| Shipped client contracts, batch 1 (interceptors ×2, request transforms, extensions foundation, statement transforms, pending-operation) | [`shipped-suites-1.log`](receipts/followup/shipped-suites-1.log) | **519/519 passed** (17 files across projects), 10.98 s wall, 767.6 MiB peak |
| Shipped nested transactions, legacy array boundaries, lifecycle observers, introspection, construction boundaries **plus** the G3 execution/scope/array contracts (the §8.4 neighbours) | [`shipped-suites-2.log`](receipts/followup/shipped-suites-2.log) | **128/128 passed** (18 files: 94 shipped + 34 G3), 9.42 s wall, 800.8 MiB peak. The earlier separate G3 run is kept at [`g3-contracts.log`](receipts/followup/g3-contracts.log) (34/34) |
| G4-02's own author suites | [`g4-unit02-author-suites.log`](receipts/followup/g4-unit02-author-suites.log) | **80 passed / 6 skipped** (15 files + 2 native-only), 4.16 s wall |
| G4 read contracts | [`g4-read-contracts.log`](receipts/followup/g4-read-contracts.log) | **60 passed / 2 failed** — SC-13 `read-codecs.test.ts:457` and RF-16 `read-recursive-fit.test.ts:254`, the two INHERITED witness defects `g4/unit02/note.md` §P.11.1 diagnoses (same cells, same lines) |
| Whole-estate typecheck | [`typecheck-final.log`](receipts/followup/typecheck-final.log) | only the two permitted `pattern/pack.ts` TS2345 diagnostics; 8.50 s wall, 5,840.8 MiB peak |
| Both patches reconstruct byte-identically | [`patch-reconstruction.log`](receipts/followup/patch-reconstruction.log) | 10/10 identical |
| File identities | [`source-identity.log`](receipts/followup/source-identity.log) | table in FU.7 |

Intermediate typechecks whose diagnostics this unit then fixed are kept:
[`typecheck-1.log`](receipts/followup/typecheck-1.log) …
[`typecheck-4.log`](receipts/followup/typecheck-4.log). The intermediate suite
runs [`after-production-route-suites.log`](receipts/followup/after-production-route-suites.log)
(8 failed — every self-falsifying pin going red on cue, which is the reason they
were written) and [`route-suites-2.log`](receipts/followup/route-suites-2.log)
are kept as well.

### Falsifications

| # | Mutation | Expected | [Receipt] | Measured |
| --- | --- | --- | --- | --- |
| 1 | `runCandidate` opens the region again (the r4 code, restored from a scratchpad copy) | the two D-1 parity cells fail | [`falsify-1-route-region-restored.log`](receipts/followup/falsify-1-route-region-restored.log) | **exactly 2 failed / 17 passed** — the LX-14 unit cell and the LX-02 outcome cell, nothing else |
| 2 | the array arm (`driverOverride`) also grants `operationRegion` | `g3-suppression-retry` / the array contracts fail | [`falsify-2-array-region-granted.log`](receipts/followup/falsify-2-array-region-granted.log) | **NOT falsified — 18/18 still passed.** See FU.11.2 |
| 3 | the client's trusted context is not passed to `prepared.execute` | LX-13/LX-14 fail | [`falsify-3-attribution-dropped.log`](receipts/followup/falsify-3-attribution-dropped.log) | **4 failed / 6 passed** — LX-13, LX-14, and BOTH `g4-lifecycle-events` witness cells, which is the measurement that the two witness cells are green because of this change |
| 4 | `preparedArgs` admits a SECOND time | the admission counter doubles | [`falsify-4-second-admission.log`](receipts/followup/falsify-4-second-admission.log) | **1 failed / 5 passed** — the new seam cell only. First attempt [`falsify-4b-review-oracle.log`](receipts/followup/falsify-4b-review-oracle.log) and the pre-cell run showed the ESTATE DID NOT CATCH IT: `preparedArgs` is read only when an interceptor or the cache asks, and no existing cell installed one. The cell "the payload published before proceed() is the ONE admission" was written for exactly that hole |
| 5 | `createCommandEngine` drops the handed-over `resolved` views | the B-3 cell fails | [`falsify-5-resolved-dropped.log`](receipts/followup/falsify-5-resolved-dropped.log) | **1 failed / 6 passed** — the B-3 Proxy cell only |

Each mutation was applied to a scratchpad COPY-restored file, never through
`git checkout`; `client-route.ts` was back at
`44cd9cd47b9efd1763f3dace148a920c47e4dd104d449bcc1bd9a0d255f35d34` after every
one, verified by `shasum` in the same command. That is the pre-formatting hash:
the Biome pass below is the only change between it and the final
`82ba9c9e…7490b111`, and the suites, the probes and the typecheck were all
re-run after it.

**Formatting.** `biome check --write` was run over the eight changed files last
and reformatted five; the diff it produced touches only lines this unit wrote
(three long lines split), which was verified by diffing the patch before and
after. `biome check` is then clean on all eight.

## FU.11 Rows moved, and what is still pending

### FU.11.1 Moved from PARTIAL/PENDING to COVERED

| Row | Was | Now | Receipt |
| --- | --- | --- | --- |
| **LX-02** (statement-atomic member inside `$transaction(callback)`) | partial — divergence D-1 state/outcome half, pinned | covered: the failing member poisons the caller's transaction on BOTH routes, both reject, neither commits | `route-transactions.test.ts` "LX-02 a FAILING statement-atomic write … poisons the caller's transaction on both routes" |
| **LX-14** (units inside a caller transaction) | partial — divergence D-1 observability half, pinned | covered: identical three-unit sequence, plus a new cell pinning exactly ONE region for a MULTI-statement write on both routes | same file, two cells |
| **LX-04** (array READ half only) | partial — divergence D-2, pinned | covered FOR THE READ HALF: the read is packaged in ONE native batch on both routes with the same rows. **Corrected in repair 3:** this says nothing about a MULTI-statement WRITE member, which diverges on a batch-only driver (D-5, pinned) — the LX-04 row as a whole stays PARTIAL, as FU.11.2 already recorded for D-3' and B-2 | same file, "an array transaction containing a read is packaged on a batch-only driver on both routes" |
| **LX-12** (interceptor `input`) | partial — B-1, the client-prepared payload | **PARTIAL, corrected in repair 3** (this row read "covered" on the strength of a one-verb cell). Every verb but `upsert` publishes the same ADMITTED payload; `upsert` diverges (D-6, pinned). The B-1 stand-in is gone on every verb, which is the part that is genuinely closed | `route-lifecycle.test.ts` LX-12 (parity) and D-6 PIN (divergence) |
| **LX-13** (statement transforms) | pending — B-4, `observed === []` | covered: identical `["INSERT","SELECT"]` on both routes | `route-lifecycle.test.ts` LX-13 |
| **LX-14 / LX-15** (statement units and official instrumentation over them) | pending — B-4 | covered: the WHOLE unit sequence matches, operation and statement alike | `route-lifecycle.test.ts` LX-14, plus `g4-lifecycle-events` 3/3 |
| **NS-04** (cache-entry identity for a candidate read) | pending — B-1, key half | covered: `PendingOperation.cacheKeyArgs()` returns the identical admitted payload on both routes | `route-cache.test.ts` "NS-04 the payload a cache entry is keyed on is identical on both routes" |
| **B-3** (second schema resolution) | recorded as a cutover cost item | closed: the client hands both views over and the candidate provably reads them | `route-admission.test.ts` B-3 cell + falsification 5 |
| unsupported verbs | a refusal pin that had become unreachable AND false | covered by a 16-verb parity sweep: every client family is routed and answers exactly what the shipped route answers | `route-admission.test.ts` "every client verb is answered by the route…" |

### FU.11.2 Still pending, with the blocker that owns it

| Row | Pending part | Blocker |
| --- | --- | --- |
| LX-07 | the cached-read STORE/MATERIALIZE half | **B-1c** (FU.6) — pinned by `route-cache.test.ts`; the inherited `g4-lifecycle-admission` cache-bypass red is the same blocker |
| LX-04 | a candidate package is `_prepare`d on the factory driver, not the array owner's | **D-3'** (FU.6) — no pin: both drivers share one adapter and one client lineage, so nothing in the credential-free estate can show a difference |
| — | `QueryEngine.build` reports no statement for a routed operation | **D-4'** (FU.6) — no pin, no client surface reaches it |
| LX-04 | the borrowed `createMany skipDuplicates` suppression refusal | **B-2** (r1, unchanged): `TransactionOperationOwner.executeWith` still has no capability parameter, and the refusal is MySQL-only, so this estate cannot reach it |
| LX-04 | a MULTI-statement write member on a BATCH-ONLY driver: the shipped route refuses it, the candidate packages and commits it | **D-5** (FU.6, added in repair 3) — pinned on both routes in `route-transactions.test.ts`; a refusal-removal decision for Arnaud |
| LX-12 | the `upsert` published payload: raw arms on the shipped route, the one admission on the candidate | **D-6** (FU.6, added in repair 3) — pinned on both routes in `route-lifecycle.test.ts`; a published-payload decision for Arnaud |

**FU.11.2 note — falsification 2 did not falsify.** The array arm keeps NO
grant, which is what `g4/unit02/note.md` §8.4 measured as necessary. Granting
`operationRegion` there anyway left `g3-suppression-retry-contract`,
`g3-transaction-array-contract` and all 12 route-transaction cells green: those
suites construct the candidate binding directly or run on SQLite, and §8.4's
failure was measured on `g3-scope-composition-pg` / `-mysql`, which need live
providers this session must not start. So the array arm's "no grant" rests on
unit02's native measurement, not on a local falsifier. **Requested:** run
`tests/raptor3/g3/scope-composition-native.test.ts` with this mutation in the
provider lane, or leave it as unit02's measured evidence.

## FU.12 Registration requests (to the witness author — manifest owner)

**All four counts move** (updated in repair 3, which added one cell to each of
two files; review note 4 records that `g4-route-admission`, `-cache` and
`-transactions` are RED on this tree until the manifest owner applies them,
because `scripts/run-raptor3.mjs:1025–1036` asserts `assertionResults.length`
per file). Registered values read from `scripts/raptor3-manifest.mjs:509–532`
on 2026-09-15; "must become" is the measured cell count of the current file,
reproduced in `receipts/followup-repair/final-route-and-witness-suites.log`.

| File | Registered | Must become | Why |
| --- | --- | --- | --- |
| `tests/raptor3/g4/route-transactions.test.ts` | 11 | **13** | the D-1 unit pin became a parity cell and a second cell was added for the MULTI-statement region; the D-2 and D-1-state pins became parity cells in place; **repair 3** adds the D-5 divergence pin |
| `tests/raptor3/g4/route-lifecycle.test.ts` | 7 | **8** | **repair 3** adds the D-6 divergence pin |
| `tests/raptor3/g4/route-cache.test.ts` | 6 | **7** | the NS-04 cache-key parity cell |
| `tests/raptor3/g4/route-admission.test.ts` | 5 | **7** | the B-1 seam falsifier cell and the B-3 registry cell (the verb sweep replaced the stale refusal cell in place) |

This unit does not own `scripts/raptor3-manifest.mjs` and did not edit it. The
file is also dirty from another stream, so the counts above are the whole
request: four numbers, no other change.

`tests/types/raptor3/route-public-types.core.types.ts` is still unregistered and
still covered by `node scripts/run-typecheck.mjs`, as r2 explained.

## FU.13 Unverified claims

1. **Performance.** No benchmark was run. The r1 §G.1 claim that a candidate
   write costs an extra BEGIN/COMMIT inside a caller transaction is now WRONG in
   the direction that matters — the route opens nothing — but the standalone
   root case was never measured and still is not.
2. **Falsification 2** (above) is unverified locally.
3. **D-3'** is recorded from source reading, not measured: no estate cell can
   distinguish a package prepared on the factory driver from one prepared on the
   array owner's, because they share an adapter.
4. **B-2** remains unverified for the same MySQL-only reason r2 recorded.
5. The `g4-read-contracts` SC-13 / RF-16 reds are attributed to
   `g4/unit02/note.md` §P.11.1 by matching cell, file and line; they were not
   re-measured on a tree without this diff, because this diff touches no read
   path and both cells fail inside the witness's own helper.

# Repair 3 — after the G4-03b independent review returned REVISE (2026-09-15)

Review: [`../unit03b-review.md`](../unit03b-review.md) (outcome **REVISE**, two
must-fix findings, three notes). Receipts for everything below:
[`receipts/followup-repair/`](receipts/followup-repair/).

Both must-fix findings are the same defect class, and it is a defect in this
unit's EVIDENCE, not in its code: **an observable divergence from the shipped
route that the unit neither found nor recorded, on a row it had moved to
COVERED**. Neither is repaired in the candidate. The common brief makes
refusals contracts and makes a new observable compatibility choice a decision
for Arnaud, so both are MEASURED, PINNED on both routes, and RECORDED as
blockers, and the two inventory rows move back to PARTIAL.

**No production file changed in this repair.** All four keep the SHA-256 the
review verified (`receipts/followup-repair/source-identity.log`), and the cost
recheck against the reviewed tree is zero on every axis
([`unit-cost-recheck.json`](receipts/followup-repair/unit-cost-recheck.json)).

## RP.0 Summary table (finding → change → receipt)

| # | Severity | Finding | What changed | Receipt |
| --- | --- | --- | --- | --- |
| 1 | must-fix | the `upsert` interceptor payload differs between the routes; LX-12 was declared COVERED on a one-verb cell | divergence **D-6** recorded in FU.6 as a decision for Arnaud; one self-falsifying pin added to `route-lifecycle.test.ts`; the LX-12 row moved COVERED → **PARTIAL** | [`final-route-and-witness-suites.log`](receipts/followup-repair/final-route-and-witness-suites.log), [`falsify-6-upsert-pin-raw-args.log`](receipts/followup-repair/falsify-6-upsert-pin-raw-args.log) |
| 2 | must-fix | on a batch-only driver the candidate executes a MULTI-statement array member the shipped route refuses; a registered refusal disappeared unpinned | divergence **D-5** recorded in FU.6 as a refusal-removal decision for Arnaud, naming `OperationExecutor.ts:1515`; one self-falsifying pin added to `route-transactions.test.ts`; the LX-04 row's scope corrected | same, plus [`falsify-7-d5-pin-route-refuses.log`](receipts/followup-repair/falsify-7-d5-pin-route-refuses.log) |
| 3 | note | "inherited red, not this unit's file" is generous about causation; brief outcome 2 is met for the key half only | FU.6 B-1c now states the causation plainly and scopes brief outcome 2 | FU.6, no code |
| 4 | note | registered cell counts are stale, so three `g4-route-*` campaign modes are red (four now: this repair adds a cell to `route-lifecycle` too) | FU.12 rewritten: all **four** counts move, with the values measured on this tree | FU.12 + [`final-route-and-witness-suites.log`](receipts/followup-repair/final-route-and-witness-suites.log) |
| 5 | note | "incremental core semantic cost is 0" excludes the unit's own directory | FU.9 sentence rewritten and the route adapter charged in full (+144 token-lines / +9,170 bytes) | FU.9 |

## RP.1 Reproduced first, before any edit

[`review-probes-before.log`](receipts/followup-repair/review-probes-before.log)
— the reviewer's two minimized probes on the unmodified tree: **2 failed / 4
passed**, both failures exactly as reported.

```
upsert    candidate create: + id: undefined, + score: 0    update: - "updated"  + { set: "updated" }
batch-only  shipped  TransactionError: query-engine-v2 cannot merge an insertId-scratch
                     operation into a shared driver batch.
            candidate ok:[{"email":"barr@example.test"}] / ok:[{"id":2,…}]
```

## RP.2 Finding 1 — the `upsert` published payload (divergence D-6)

**Recorded** in FU.6 as D-6: both owners named from source (the shipped
envelope-only validation in `write-engine/routing.ts` `case "upsert"`, the
candidate's one admission published by `#preparedInput`
(`pending-operation.ts:569`)), the exact two payloads, the scope (`upsert` is
the only diverging verb), and the two resolutions Arnaud can take with the
reason each belongs where it does.

**Pinned** — `route-lifecycle.test.ts` → *"D-6 PIN the interceptor input for
upsert is the caller's raw arms on the shipped route and the ONE admission on
the candidate"*. It asserts, in this order: the two routes' public results and
committed rows agree; the published envelope OUTSIDE the two arms agrees key for
key; the shipped arms are exactly the caller's; the candidate arms are exactly
`{ email, id: undefined, name, score: 0, secret: "hidden" }` and
`{ name: { set: "Updated" } }`; and `notDeepEqual` on the whole payloads — so
PARITY IN EITHER DIRECTION also fails the cell. A pin that recorded only the
candidate's answer would stay quietly green the day the shipped route changed
its own.

**Not repaired.** Re-raw-ing the arms in the route means answering
`preparedArgs` from `args` — the r1 B-1 stand-in this follow-up deleted — and
admitting again later, i.e. a second admission. Falsification 6 measures exactly
that.

**Row moved.** FU.11.1's LX-12 row now reads **PARTIAL**: every verb but
`upsert` publishes the same admitted payload (the part that is genuinely
closed), `upsert` diverges, and FU.11.2 carries the pending half.

## RP.3 Finding 2 — the batch-only multi-statement array member (divergence D-5)

**Recorded** in FU.6 as D-5, with the shipped owner named at
`src/query-engine/write-engine/OperationExecutor.ts:1515–1519`, the candidate
mechanism named at `pending-operation.ts:601–604` + `:371–379`, the measured
table (outcome, native batches, rows written), the substrate scope, and the two
resolutions — with the explicit warning that a refusal re-introduced in the
ROUTE would be a second plan authority, so option (b) belongs to the candidate's
packaging rule.

**Pinned** — `route-transactions.test.ts` → *"D-5 PIN a MULTI-statement array
member is refused by the shipped route and packaged by the candidate on a
batch-only driver"*. One scenario, run on BOTH substrates:

- interactive driver: the two routes AGREE (`ok:[{"email":"d5@example.test"}]`
  on both) — the divergence is bounded to the substrate with no sequential
  fallback, and that boundary is asserted, not asserted about;
- batch-only driver: the shipped refusal text verbatim, 0 batches, 0 rows
  against the candidate's `ok:[…]`, 1 native batch, the author row and both book
  rows — plus `notEqual` on the two outcomes.

**Not repaired**, per the review's own instruction.

**Row corrected.** FU.11.1's LX-04 row now says what it actually measured (the
READ half) and points at D-5 for the multi-statement WRITE member; FU.11.2 gains
the D-5 row beside the existing D-3' and B-2 rows.

## RP.4 Falsifications — both new pins are sensitive

Each mutation was applied to a scratchpad COPY-restored file, never through
`git checkout`, and `client-route.ts` was verified back at
`82ba9c9e8848c09ee4d29e7ac824a305c9fb3a052424005f446e2e167490b111` by `shasum`
in the same command.

| # | Mutation | Expected | Receipt | Measured |
| --- | --- | --- | --- | --- |
| 6 | `preparedArgs` answers the CLIENT-prepared `args` again (the r1 B-1 stand-in), so both routes publish the caller's raw payload | the D-6 pin fails | [`falsify-6-upsert-pin-raw-args.log`](receipts/followup-repair/falsify-6-upsert-pin-raw-args.log) | **4 failed / 31 passed** — the D-6 pin, the LX-12 parity cell, the NS-04 cache-key cell and the admission-seam cell; nothing else. The D-6 pin is the only one of the four that fails *because the routes now AGREE* |
| 7 | the route refuses every package with the SHIPPED refusal text (the candidate moves to parity) | the D-5 pin fails | [`falsify-7-d5-pin-route-refuses.log`](receipts/followup-repair/falsify-7-d5-pin-route-refuses.log) | **3 failed / 32 passed** — the D-5 pin (`+ 'TransactionError: …' - 'ok:[{"email":"d5@example.test"}]'`), plus the two LX-04 batch-only packaging cells; nothing else |

The SHIPPED direction of each pin is a literal equality assertion on that route's
answer (the refusal sentence, the raw arms), so a change there fails the cell by
construction; no mutation of another stream's file was made to demonstrate it.

## RP.5 Findings 3, 4 and 5 — the three notes

- **3 (B-1c causation).** FU.6 B-1c now says the witness red is PRODUCED by this
  unit's refusal and only OWNED elsewhere, states that `g4-lifecycle-admission`
  stays red at 3/4 until the one-line `shared/query.ts` change lands, and scopes
  brief outcome 2 to the key half (NS-04 key parity and RF-10 hold; LX-07's
  store/materialize half does not). No code change: the requested change is in
  another stream's file and is already written out exactly.
- **4 (registration counts).** FU.12 is rewritten. All four counts move —
  `route-transactions` 11 → **13**, `route-lifecycle` 7 → **8**,
  `route-cache` 6 → **7**, `route-admission` 5 → **7** — and the section now
  says why the campaign modes are red until the manifest owner applies them
  (`scripts/run-raptor3.mjs:1025–1036` asserts `assertionResults.length` per
  file). This unit does not own `scripts/raptor3-manifest.mjs` and did not touch
  it; the file is also dirty from another stream.
- **5 (the cost sentence).** FU.9 now reads "0 outside the new route adapter"
  and charges the adapter in full: +144 token-lines / +234 physical / +9,170
  bytes of the unit's +242 / +380 / +14,653.

## RP.6 Verification receipts for repair 3

| Claim | Receipt | Result |
| --- | --- | --- |
| The reviewer's two probes reproduce BEFORE any edit | [`review-probes-before.log`](receipts/followup-repair/review-probes-before.log) | **2 failed / 4 passed** — both findings exactly as reported |
| The four route suites + the C13 witnesses, final run after every edit | [`final-route-and-witness-suites.log`](receipts/followup-repair/final-route-and-witness-suites.log) | **41 passed / 1 failed** — route suites **35/35** (transactions **13**, lifecycle **8**, cache 7, admission 7), `lifecycle-events` 3/3, `lifecycle-admission` **3/4** (the B-1c red, unchanged); 47.76 s wall, 483.9 MiB peak |
| The reviewer's own unit03b probes, after | [`review-unit03b-probes-after.log`](receipts/followup-repair/review-unit03b-probes-after.log) | **18 passed / 3 failed** — identical to the reviewer's own measurement. The three reds are `route-upsert-payload`, `route-seams` cell 2 and `route-envelope-array`'s batch-only cell: all three ASSERT PARITY on D-6/D-5, which is the claim this repair withdraws. They are the external form of the two new pins and are expected to stay red until Arnaud decides |
| The unit03 reviewer's probes | [`review-unit03-probes.log`](receipts/followup-repair/review-unit03-probes.log) | **19/19 passed** (8 files), 3.50 s wall |
| Shipped client contracts, batch 1 | [`shipped-suites-1.log`](receipts/followup-repair/shipped-suites-1.log) | **519/519 passed** (17 files), 28.33 s wall, 643.0 MiB peak |
| Shipped client + G3 contracts, batch 2 | [`shipped-suites-2.log`](receipts/followup-repair/shipped-suites-2.log) | **128/128 passed** (18 files), 12.06 s wall, 811.1 MiB peak |
| Whole-estate typecheck, after every edit | [`typecheck-final.log`](receipts/followup-repair/typecheck-final.log) | **exactly 2 diagnostics**, both the permitted `pattern/pack.ts` TS2345 (0 others); 59.74 s wall, 5,862.0 MiB peak |
| Both patches reconstruct the tree byte-for-byte | [`patch-reconstruction.log`](receipts/followup-repair/patch-reconstruction.log) | 10/10 identical (production patch applied onto `0cc61e61` sources, tests patch into an empty tree) |
| Production cost unchanged by this repair | [`unit-cost-recheck.json`](receipts/followup-repair/unit-cost-recheck.json) | every delta **0** on all four files; the unit total stays +242 / +380 / +14,653 |
| File identities after the last edit | [`source-identity.log`](receipts/followup-repair/source-identity.log) | the four production SHA-256 values are the ones FU.7 records and the review verified |

`biome check` is clean on both edited test files (no fixes applied).

**Identity of the two edited test files** (after the last edit; the four
production files are in `source-identity.log` with their unchanged r5 values):

| File | SHA-256 |
| --- | --- |
| `tests/raptor3/g4/route-transactions.test.ts` | `8c93d18a…1ad545dd` |
| `tests/raptor3/g4/route-lifecycle.test.ts` | `1e557cd9…56821e1e` |

Every run above was executed serially through `node scripts/run-vitest-safe.mjs`
under the workspace lock; both falsifications were re-measured on the FINAL tree
(after a formatting-only cleanup in the D-5 cell), not on an intermediate one.

## RP.7 What did NOT change, and why

- **No production edit.** Both must-fix findings are compatibility choices, and
  the review's own remedy is "measure, pin, and record — not repair". The
  candidate keeps its answer on both; the shipped route keeps its refusal.
- **No manifest edit.** Not this unit's file (common brief), and the counts are
  filed in FU.12 with the values measured on this tree.
- **No `shared/query.ts` edit.** B-1c's one-line requested change is another
  stream's file and is unchanged since the follow-up; writing the codec in the
  route would be the second scalar authority the §7 gate rejects.
- **No new cell for the interactive substrate of D-5 as a separate test.** It is
  asserted inside the D-5 pin itself, so the divergence boundary cannot drift
  without a red cell, and the registered count moves by one rather than two.
- **The three red reviewer probes were not "fixed".** Making them green requires
  choosing one of the two divergences, which is the decision this unit is
  recording rather than taking.

## RP.8 Blockers after repair 3 (the complete list)

| ID | What it blocks | Owner of the change |
| --- | --- | --- |
| **B-1c** | LX-07 store/materialize, the codec half of NS-04, `g4-lifecycle-admission` 4/4 | `src/query-engine/raptor3/shared/query.ts` (another stream) — exact diff in FU.6 |
| **B-2** | the borrowed `createMany skipDuplicates` suppression refusal | `TransactionOperationOwner.executeWith` + a MySQL lane |
| **D-3'** | a package is `_prepare`d on the factory driver, not the array owner's | `commands/index.ts` (another stream) — exact change in FU.6 |
| **D-4'** | `QueryEngine.build` reports no statement for a routed operation | `commands/index.ts` (another stream) — exact change in FU.6 |
| **D-5** | LX-04's multi-statement write member on a batch-only driver | **Arnaud** — a registered refusal is removed; then the candidate's packaging rule if refused |
| **D-6** | LX-12's `upsert` published payload | **Arnaud** — the documented interceptor surface changes shape for one verb |
