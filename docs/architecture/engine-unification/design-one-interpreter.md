# Design — One Interpreter: nested writes as a single execution engine with a capability-parameterized read mode

Status: proposal. Anchor: branch `prisma-parity`, nested-writes dir ~7,200 LOC across
`src/query-engine/operations/nested-writes/` + `src/query-engine/transaction-flow.ts`.

Author's lens (assigned): **single-interpreter**. The orchestrator proposed a write-only
Plan IR compiled once and lowered by *two semantics-free backends*. I accept the IR and the
compiler. I **reject the two-backend shape** and argue, from the code, that the correct seam
is not *backend* (tx vs batch) but *execution mode* (can a read observe this operation's own
uncommitted writes?). There is one interpreter. "Batch-only" is that interpreter running with
one capability turned off. This document justifies that claim, then specifies the engine,
the mode contract, the branch/staleness contract, the error taxonomy, per-kind compilation,
and a migration plan with per-milestone acceptance gates.

Everything below is written against the six ground-truth maps in this directory and
spot-checked in code. Where a claim is load-bearing I cite the file.

---

## 0. The thesis, and why "mode" beats "backend" — from the code, not from taste

The maps repeatedly describe "two engines". The code says something more specific, and it is
the whole argument:

**Fact 1 — the value substrate is already one thing.** `buildScalarSqlValue`
(`builders/values-builder.ts:114`) accepts a value slot that is *either* a literal (`unknown`),
*or* an already-built `Sql`, *or* a `BatchValueRef`, and lowers all three: a ref becomes
`adapter.batchRefs.read(...)` + a type cast; an `Sql` passes through; a literal becomes an
adapter literal. That union has a name in the code — `BatchResolvableValue = unknown | Sql |
BatchValueRef` (`batch-references.ts:30`). The tx path passes concrete values into this leaf;
the batch path passes refs. **They already converge at the leaf.** The duplication that hurts
lives *above* the leaf (the `fk.ts` "runtime-value family" vs "batch/symbolic family" pairs,
map-shared-and-m2m B.1), not at it.

**Fact 2 — the reads are already one thing.** Every branch/existence read goes through
`record-access.ts` (`fetchOptionalUniqueRecord`, `fetchRequiredWhereRecord`, …). Each takes a
`driver` and runs `driver._execute(...)` *immediately*. In the tx path the `driver` is a
`txDriver` inside `withTransaction`, so the read sees the operation's own prior writes. In the
batch path the *same functions* are called at plan-build time against the base driver, so the
read sees only committed state. **The read implementation is identical. The only difference is
which driver it is handed and therefore whether it can see uncommitted self-writes.** That is a
property of the driver/scope, i.e. a *capability*, not a *backend*.

**Fact 3 — the atomic substrate is already one abstract guarantee with two implementations.**
`runNestedMutationAtomically` (`atomic-runner.ts:9`) wraps work in `driver.withTransaction`.
`_executeBatch` (`driver.ts:521`) runs a statement list atomically (native batch, or a
tx-wrapped loop). Both promise the *same three things*: (a) all-or-nothing, (b) ordered
sequential execution, (c) one session/connection. That is a single interface —
`AtomicScope` — with two implementations.

**Fact 4 — the step model and the guard vocabulary are already shared data.**
`NestedWriteStep`, `NestedWriteGuard`, `NestedWritePlan`, `planRelationMutationSteps`,
`splitRelationMutationsByFk`, `planExistingUpsertBranch` all live in `semantic-plan.ts` as
pure, SQL-free, IO-free data and functions that *both* engines already call.

So four of the five things a nested write is made of are already unified in the code. What is
*not* unified is the **control flow that consumes them**: two dispatchers
(`relation-mutation.ts` tx, `batch-relations.ts` batch), two m2m planners, two upsert paths,
the `fk.ts` orchestration pairs. That control flow diverges for exactly one reason, and the
maps name it every time: **the tx path can read-its-own-writes and branch at runtime; the
batch path cannot, so it reads at plan time and pins the premise with a guard.**

Therefore the real axis of variation is a single boolean capability:

> **`canObserveOwnWrites`** — can a read issued mid-operation see writes this same operation
> has already issued but not yet committed?

`true` for interactive-transaction drivers. `false` for batch-only drivers. Everything the two
"engines" do differently is a consequence of this one bit. Modeling it as a *backend split*
duplicates the ~90% that is identical to isolate the ~10% that differs. Modeling it as a
*mode* (a capability object the one interpreter consults) isolates exactly the ~10%.

**Why this is not just re-labeling.** A backend boundary forces every new feature to be
implemented on both sides and kept in sync by the conformance suite — which is the historical
cost the brief opens with (every feature lands twice; several shipped bugs were divergences).
A mode boundary means a feature is implemented *once* in the interpreter; the mode only changes
*how a produced value is carried* (JS value vs symbol) and *when a branch read runs* (inline
vs plan-time-with-guard). Those two concerns are small, closed, and already have their
mechanisms (`BatchResolvableValue`, `NestedWriteGuard`). The mode cannot drift feature-by-feature
because there is no second copy of the feature to drift.

**The orchestrator's IR still exists** — I keep it, because the interpreter needs a data
structure to walk and because plan-time validation (`assertNestedUpdatePlanIsExecutable`) must
run before any write on *both* modes. But the IR is **thin and write-only** and the interpreter
is **one function**, not two backends behind it. The difference from the orchestrator's frame:
there are not "two thin semantics-free backends"; there is one semantics-*full* interpreter and
one thin *effect surface* (the mode) it drives.

I will flag, in §11, the one place this thesis is weakest (recursion atomicity + the write-race
retry), because honesty about that is the price of proposing it.

---

## 1. Core abstractions (each with its justification; nothing speculative)

Five abstractions. For each: *this exists because…*. If I cannot finish that sentence from a
concrete need in the maps, it is not here.

### 1.1 `Expr` — a value that may not be known yet

```ts
// This exists because: a nested write threads values across statement boundaries where the
// value may be (a) a literal known now, (b) a primary key produced by an INSERT not yet run,
// or (c) an already-built SQL fragment (connect subquery). The code ALREADY has this union
// (BatchResolvableValue) and ALREADY lowers it at one leaf (buildScalarSqlValue). We name it
// and make it the ONE value type the interpreter and IR speak.
type Expr =
  | { kind: "lit"; value: unknown }        // known now (JS literal)
  | { kind: "sql"; sql: Sql }              // pre-built dialect fragment (e.g. connect subquery)
  | { kind: "sym"; sym: Symbol };          // produced-during-execution; resolved by the mode

// Symbol = "a value this operation will produce". Identity only; no value.
// This exists because: the value crossing every phase/step boundary is always a primary key
// read from a persisted row (map-tx-create §13 invariant 2). A Symbol is exactly that promise.
interface Symbol {
  readonly id: string;                     // unique within one operation
  readonly origin:                         // how it gets a value (drives lowering + validation)
    | { kind: "generatedPk"; model: Model; field: string }   // single auto-increment
    | { kind: "computedPk"; model: Model; field: string; expr: ArithExpr } // increment on a PK
    | { kind: "literalPromise"; value: unknown };            // known now but flowed as a symbol for uniformity
}
```

`Expr` is deliberately **not** a general expression language. There is no `+`, no `AND`, no
subquery-of-arbitrary-shape *as first-class IR*. Arithmetic on a PK (`increment`) is the *only*
computed case and it is captured narrowly as `ArithExpr` inside `computedPk` origin, mirroring
exactly what `batch-updated-primary-keys.ts` already supports and nothing more. **This is the
answer to the orchestrator's stated risk "Expr language creep": the language is closed at
`lit | sql | sym`, and `sym` has exactly three origins, all of which the code already handles.**

The leaf lowering is unchanged and already exists:

```ts
lowerExpr(mode: Mode, ctx, model, field, e: Expr): Sql
// lit -> buildScalarSqlValue(ctx, model, field, e.value)
// sql -> e.sql
// sym -> mode.resolveSymbol(e.sym, ctx, model, field)   // <-- the ONLY mode-specific line
```

### 1.2 `Op` — a write effect over `Expr`s

```ts
// This exists because: the interpreter must emit an ordered sequence of side effects that
// BOTH modes execute identically once values are resolved. These are write-only: no branching,
// no reads-that-decide. Reads-that-decide are Probes (§1.3); guards are Guards (§1.4).
type Op =
  | { kind: "insert"; model: Model; columns: string[]; values: Expr[]; produces?: Symbol[] }
  | { kind: "insertMany"; model: Model; columns: string[]; rows: Expr[][]; skipDuplicates?: boolean }
  | { kind: "update"; model: Model; set: Record<string, Expr>; where: Sql }
  | { kind: "delete"; model: Model; where: Sql }
  | { kind: "storeSymbol"; sym: Symbol; from: SymbolSource } // persist a produced value for later Exprs
```

`SymbolSource` is `{ kind: "lastInsertId" } | { kind: "arith"; expr: ArithExpr }` — the two
ways a symbol acquires a value, straight from `storeLastInsertId` / computed-PK stores. `where`
is a pre-built `Sql` because WHERE-clause construction is already fully adapter-delegated and
substrate-agnostic (`buildFkMatchCondition`, `combineWithParentCorrelation`,
`buildDepartingRowsCondition` — all in `fk.ts`/`set.ts`, all shared, all over
`buildScalarSqlValue`). **Hoisting WHERE-building into IR nodes would be re-implementing a
working, shared, adapter-correct layer — pure ceremony. We do not. The IR references `Sql`
where `Sql` is already the shared currency.** This is the answer to "IR creep toward a general
query language": the IR does not model queries; it models *writes and the values they thread*,
and delegates all predicate SQL to the existing shared builders.

### 1.3 `Probe` — a read that decides a branch

```ts
// This exists because: three branch decisions (upsert exists?, connectOrCreate found?,
// targetWhere/setWhere matched?) and one existence check depend on reading current state.
// The tx path reads inline and sees its own writes; the batch path reads at plan time and
// pins the result. A Probe is the SINGLE representation of "read this to decide", and the
// mode decides WHEN it runs and whether it needs a guard.
interface Probe {
  readonly model: Model;
  readonly where: Sql;                     // adapter-built; may reference earlier Symbols only if mode allows
  readonly select: "exists" | "record";    // do we need the row, or just its presence?
}
```

### 1.4 `Guard` — a premise that must still hold at commit

Reuse the existing `NestedWriteGuard` union verbatim (`semantic-plan.ts:31`). It is already the
right shape: `uniqueExists | uniqueMissing | uniqueWithWhereExists | uniqueWithWhereMissing`,
each lowering to `adapter.assertions.exists/notExists`. **This exists because** a plan-time
branch decision opens a staleness window (map-batch-refs I2, I5); a Guard closes it by aborting
the atomic unit if the premise changed. In `canObserveOwnWrites` mode the Guard is a *no-op that
never needs to run* (the read and the write are serialized in one transaction), but the
interpreter still *emits* it uniformly — see §3.3 for why emitting-always is correct and cheap.

### 1.5 `Mode` — the capability object (the heart of the single-interpreter claim)

```ts
// This exists because: the ONE axis of real variation is "can a mid-operation read see this
// operation's own uncommitted writes". Everything the two old engines did differently is a
// consequence. The Mode is that bit, plus the three small mechanisms that follow from it.
interface Mode {
  readonly canObserveOwnWrites: boolean;

  // 1. HOW a produced value is carried. tx: a JS value read from a result. batch: a symbol
  //    lowered to a batchRefs.read subquery. Resolves an Expr{sym} to Sql at lowering time.
  resolveSymbol(sym: Symbol, ctx: QueryContext, model: Model, field: string): Sql;

  // 2. HOW/WHEN a Probe runs, and what it yields to the interpreter.
  //    tx: run now against the live tx driver; return the row/existence; NO guard needed.
  //    batch: run now against the base driver (committed state); return the row/existence;
  //           REQUIRE the caller to also emit a Guard (enforced structurally, see §3.3).
  probe(p: Probe): Promise<ProbeResult>;

  // 3. HOW a produced value becomes a symbol the plan can carry.
  //    tx: execute the insert, read RETURNING/lastInsertId, bind sym -> concrete value.
  //    batch: emit storeSymbol(lastInsertId) right after the insert; sym stays a ref.
  bindProduced(op: Extract<Op,{kind:"insert"}>, sym: Symbol): void;

  // 4. The atomic scope. Both provide "run this sequence atomically/ordered/one-connection".
  readonly scope: AtomicScope;
}
```

`Mode` has **exactly two implementations**: `LiveMode` (`canObserveOwnWrites: true`) and
`PlannedMode` (`canObserveOwnWrites: false`). This is not "an interface with one implementation"
(the ceremony the maintainer forbids) — there are two, they are genuinely different, and they
are the *only* two because there is only one capability bit. This is not "speculative
flexibility" either — no third mode is contemplated; `Mode` is not extensible sugar, it is the
precise dual of the one capability.

**Why `Mode` and not just `if (canObserveOwnWrites)` scattered in the interpreter.** Because the
maps prove the branches are not one-liners: symbol resolution, probe timing+guarding, and
produced-value binding are three *coordinated* behaviors that must stay consistent (a probe
without its guard is a silent-divergence bug; a symbol resolved as a literal in the wrong mode
is a correctness bug). Collecting them behind one object with an enforced contract (§3.3) is the
minimum structure that prevents the divergences the two-engine design suffered. It is
abstraction drawn from the failure mode, not from anticipation.

---

## 2. The interpreter (one function family) and the IR it walks

There is **one** entry, `runNestedWrite`, replacing both `executeCreate/Update/UpsertWithNestedWrites`
and `executeNestedWriteBatch`:

```ts
async function runNestedWrite<T>(
  ctx: QueryContext, operation: "create"|"update"|"upsert",
  args: Record<string, unknown>, driver: AnyDriver
): Promise<T> {
  const mode = selectMode(driver);                       // §3.1 — the ONLY capability decision
  assertPlanIsExecutable(ctx, operation, args, mode);    // §7 — static, before any effect
  return mode.scope.run(async (emit, mode) => {          // §3.2 — one atomic scope
    const result = await interpretOperation(ctx, operation, args, emit, mode);
    return result;                                        // scope flushes/parses; §3.2
  });
}
```

`interpretOperation` and its recursive helpers ARE the semantics — one copy. They walk the
same `NestedWriteStep[]` / FK split the code already produces, and for each step they:

1. build predicate `Sql` via the existing shared builders (unchanged),
2. run any `Probe` via `mode.probe` (which the mode times + guards),
3. `emit(op)` write effects over `Expr`s,
4. resolve produced identities via `mode.bindProduced`,
5. recurse with the child identity as `Expr`s.

`emit` is the effect sink the scope provides. In `LiveMode`, `emit` executes the op immediately
against the tx driver and (for inserts with `produces`) reads the identity back, binding the
symbol to a concrete `{kind:"lit"}`. In `PlannedMode`, `emit` appends the lowered op to the
statement list and (for `produces`) appends the `storeSymbol` op, leaving the symbol a
`batchRefs.read` ref. **The interpreter never inspects `mode.canObserveOwnWrites` directly** — it
only calls `mode.probe`, `emit`, `mode.bindProduced`, `mode.resolveSymbol`. That is what makes
it one interpreter: the mode is consulted only through four narrow methods, and semantics live
above them.

The IR (`Op[]` + `Probe`s + `Guard`s) is **not materialized as a separate pass in `LiveMode`** —
`emit` executes eagerly. In `PlannedMode`, `emit` materializes it into `PlanState.statements`.
So the "IR" is the *vocabulary the interpreter emits in*, and only `PlannedMode` collects it
into a list. This is important: it means `LiveMode` pays **zero** cost for the IR
(no plan array, no walk-then-execute) — it is exactly today's tx engine minus the duplicated
control flow. The orchestrator's "compile to IR, then two backends lower it" would force
`LiveMode` to build a plan it doesn't need; the emit-sink formulation avoids that.

---

## 3. Mode contracts, atomic scope, and the branch/staleness contract

### 3.1 `selectMode` — the one capability decision (replaces the dispatcher fork)

```ts
function selectMode(driver: AnyDriver): Mode {
  if (driver.supportsTransactions) return new LiveMode(driver);       // canObserveOwnWrites: true
  if (driver.supportsBatch)        return new PlannedMode(driver);    // canObserveOwnWrites: false
  throw new QueryEngineError(/* neither tx nor atomic batch — the existing atomic-runner error */);
}
```

This subsumes `runNestedWriteOperation`'s fork (`transaction-flow.ts:132`) and
`atomic-runner`'s throw. **Capability precedence is preserved exactly**: a driver that supports
both takes `LiveMode` (the `supportsTransactions` branch wins), matching today
(map-oracle A: "a driver that supports both takes the TX path"). d1-http (`supportsBatch=false`,
`supportsTransactions=false`) falls to the throw — the deliberate loud rejection is preserved
(map-batch-refs 6.2). The `atomic-runner` defensive "batch driver reached the tx path" throw
disappears because there is no separate tx path to mis-route into — the mode *is* the routing.

### 3.2 `AtomicScope` — one guarantee, two implementations

```ts
// This exists because: both withTransaction and _executeBatch promise all-or-nothing +
// ordered + one-connection. That single guarantee is what makes guards and symbol-refs
// correct (map-batch-refs I11, invariant 1). We name the guarantee, not the mechanism.
interface AtomicScope {
  run<T>(body: (emit: Emit, mode: Mode) => Promise<T>): Promise<T>;
}
```

- `LiveMode.scope.run(body)` = `driver.withTransaction(tx => body(liveEmit(tx), this))`. `emit`
  executes each op immediately on `tx`; probes read on `tx`; the return value is the assembled
  record (already a JS value). No setup/cleanup, no result-slicing.
- `PlannedMode.scope.run(body)` = build a `PlanState`; `emit` appends lowered ops; `body`
  returns a `finalWhere` + parse closure; then `driver._executeBatch(collectPlanStatements(state))`
  and slice/parse by `setupStatements.length` (the existing result-window math, map-batch-planner
  I10). Setup/cleanup materialize lazily on first symbol allocation (existing lazy behavior,
  map-batch-refs 1.3, invariant 10).

**Atomicity model, stated explicitly (this is a decision the maps demand, DIVERGENCE-RECURSION-
ATOMICITY).** There is **one** atomic scope per top-level operation. Recursion into nested
children does **not** open a new scope — it emits into the *same* scope. This is a deliberate
change from today's tx engine, which opens a fresh `runNestedMutationAtomically` (nested
`withTransaction`) at every recursion level (map-tx-update §1.2) and relies on the driver making
nested `withTransaction` a savepoint/no-op. That reliance is implicit and fragile
(`TransactionBoundDriver` inherits `supportsTransactions`, so a naive nested call would open a
*real* nested transaction, `driver.ts:724`). The unified design makes the outer scope the single
atomic unit and threads the same `emit` down the recursion — which is *already* how
`PlannedMode` works (one flat statement list). So this change makes `LiveMode` match
`PlannedMode`'s already-correct flat-atomicity model, eliminating a latent re-entrancy
assumption rather than porting it. Acceptance gate M4 pins this.

### 3.3 The branch/staleness contract — stated as an enforced invariant, not a convention

> **Every `Probe` whose result selects a branch MUST, in `PlannedMode`, be paired with a
> `Guard` emitted at the point in the statement list where the branch's premise must still
> hold. In `LiveMode` the Guard is emitted too but is a serialized no-op. The interpreter
> cannot emit a branch-selecting probe without its guard, because `mode.probe` returns a
> `ProbeResult` that structurally carries the guard the caller must emit.**

Concretely, `ProbeResult` forces the pairing at the type level:

```ts
type ProbeResult =
  | { found: true;  record?: Record<string, unknown>; guard: NestedWriteGuard /* uniqueExists */ }
  | { found: false;                                    guard: NestedWriteGuard /* uniqueMissing */ };

// interpreter usage — the guard is not optional, you destructure it and must emit it:
const r = await mode.probe({ model, where, select: "record" });
emitGuard(r.guard);                 // <- omitting this is a compile-time smell (unused binding)
if (r.found) { /* update/connect branch */ } else { /* create branch */ }
```

`emitGuard` in `LiveMode` is a documented no-op (the transaction already serialized the read and
the write). `emitGuard` in `PlannedMode` appends the `adapter.assertions.exists/notExists`
statement. **Why emit the guard even in `LiveMode` rather than skip it:** so the two modes run
the *same interpreter code path* — no `if (canObserveOwnWrites) skipGuard`. The guard object is
constructed unconditionally; only its *lowering* differs (no-op vs SQL). This keeps the
interpreter genuinely single and makes "a branch without a guard" unrepresentable. This is the
structural fix for the maps' recurring warning: "dropping a guard for any read-driven branch is
silent divergence" (map-batch-refs invariant 5).

**The one documented un-guardable case is preserved as-is and named.** Filtered M2M
`deleteMany`/`delete:true` materializes a target-PK set from a plan-time read that *cannot* be
re-expressed as a re-checkable premise (the filter can't be re-evaluated after the junction
rows are gone — map-batch-planner §5 last row, `batch-many-to-many.ts:528` ponytail comment). In
the unified model this is a `Probe` with `select: "record"` whose `ProbeResult` carries **no**
guard, and the interpreter branch for filtered m2m delete is the *only* place allowed to consume
a guard-less probe. That permission is a single, commented, test-pinned exception — the staleness
gap becomes one explicitly-marked line instead of an accident. In `LiveMode` this same branch
re-evaluates the filter live (no gap), exactly as today; the gap exists only in `PlannedMode`
and only there. Milestone M8 gate: a conformance scenario documents the gap on `PlannedMode` and
asserts `LiveMode` closes it, so the asymmetry is *tested*, not merely commented.

---

## 4. Error taxonomy — one surface, mode-normalized

The single worst honesty gap in today's code: the tx path throws typed `NestedWriteError` /
`recordNotFoundError` with pinned messages; the batch guard raises a raw dialect error
(div-by-zero / bad-json-path) normalized to a generic `NestedWriteAssertionError`
(map-oracle D1, map-batch-refs 12). The behavior suite *branches on `driver.supportsTransactions`*
to assert two different messages (nested-write-behavior 518-528, 721-731). That is a divergence
the maintainer's value ("identical behavior or a clear typed error, never silent divergence")
condemns, and the single-interpreter shape lets us close it.

**Decision: every guard carries the domain error it stands for, and `PlannedMode` maps the
assertion abort back to that typed error.**

```ts
// Guards gain a `failure` payload (the error the tx path would have thrown at this premise).
interface GuardFailure { error: () => NestedWriteError | NotFoundError; raceable: boolean; }
type NestedWriteGuard = /* existing union */ & { failure: GuardFailure };
```

- `LiveMode`: the interpreter throws `failure.error()` directly (read-then-throw), exactly the
  pinned message today (`recordNotFoundError({kind})`, the `set`/orphan messages, etc.).
- `PlannedMode`: `_executeBatch` rejects with a driver SQL error at the aborting guard. The
  scope wraps execution and, on abort, **re-derives which guard aborted** (guards are ordered
  and identifiable; the aborting statement index maps to a guard) and rethrows `failure.error()`.
  If the abort is a genuine `UniqueConstraintError` from an INSERT (not an assertion), it is
  passed through unchanged (it is already the right typed error and `raceable`).

Result: **both modes surface the same typed error with the same message.** The behavior suite's
`supportsTransactions` branch on error *message* is deleted (gate M6). What legitimately still
differs is only *timing granularity* (tx fails at the read; batch fails at the guard statement)
and *cost* (batch issues extra guard SELECTs) — both invisible to observable state and error
type.

**Write-race retry stays above the interpreter, unchanged in policy** (`executeWithNestedWrites`
wrapper, map-oracle B.5): catch `isWriteRaceLoserError` + `hasRaceableCreateBranch`, re-run once.
The `raceable` bit on `GuardFailure` keeps `isWriteRaceLoserError`'s classification aligned with
how each mode signals a lost race: `LiveMode` via lock-rollback unique/deadlock; `PlannedMode`
via a real `UniqueConstraintError` from the create-branch INSERT when its `uniqueMissing` guard's
premise went stale (map-oracle D7 — the INSERT, not the assertion, throws the retryable error).
This preserves the one genuine concurrency parity the batch path lacks today only because it had
no retry; putting the retry above the *single* interpreter gives batch drivers the same
converge-on-rerun behavior (a latent parity gap the maps flag, map-tx-create §11). **This is a
behavior improvement the unification enables, gated by M7 (concurrent conformance).**

---

## 5. Per-kind compilation — how each of today's mutation kinds interprets

Notation: `emit(op)` = the effect sink; `probe`/`guard` per §3.3; `Expr` values carry the
partly-known identity. FK direction from `getFkDirection` — the sole direction oracle, kept
verbatim (map-tx-create §2.2, invariants). Step order from `planRelationMutationSteps`, kept
verbatim (create, createMany, connect, connectOrCreate, disconnect, delete, set, update,
updateMany, deleteMany, upsert). FK split from `splitRelationMutationsByFk` (current-holds-FK
before parent; related-holds-FK + m2m after).

### create (parent) — the phase skeleton
`separateData` → `assertNoPlannedNestedMutationExecution(create)` → split by FK.
- **before-parent (currentHoldsFk):** for each create/connect/connectOrCreate, resolve the
  child/target identity to `Expr`s and write them into the parent's FK columns of `scalarData`.
  A nested `create` emits its child `insert` (with `produces: [childPkSym]`) and binds the sym;
  the parent's FK `Expr` becomes `{kind:"sym", childPkSym}`. A `connect` emits a `guard`
  (uniqueExists, carrying the `target`-kind failure) and sets the FK `Expr` from the connect
  where (`buildConnectFkValues`, may be an `sql` subquery). `connectOrCreate` probes; found →
  guard(uniqueExists)+existing PK; missing → guard(uniqueMissing)+child insert.
- **parent insert:** `emit({kind:"insert", model, columns, values, produces: [parentPkSym?]})`.
  `mode.bindProduced` binds `parentPkSym` — `LiveMode` from RETURNING/lastInsertId,
  `PlannedMode` via `storeSymbol(lastInsertId)` emitted *immediately after* the insert
  (ordering invariant, map-batch-refs 5.2). `getBatchPrimaryKeyRef`'s legality rules become
  symbol-origin validation (§7): single auto-increment → one `generatedPk` sym; compound
  generated → rejected uniformly (§8).
- **after-parent (relatedHoldsFk + m2m):** each child/junction receives `parentPkSym` as an
  `Expr` in its FK column / junction source. Same interpreter code as update's after-phase.

### createMany
Only legal when related-holds-FK (parent-holds-FK createMany throws today; kept). Stamp
`parentPkSym` into every row's FK `Expr`; `emit({kind:"insertMany", rows, skipDuplicates})`.
On m2m: unsupported → typed error (both modes today; kept).

### connect
Direction-split, preserving the *error-kind-by-direction* invariant (map-tx-create §5, invariant
6): parent-holds-FK connect → `probe`/`guard(uniqueExists, failure=target-kind)` then FK `Expr`
into parent; child-holds-FK connect → `emit({kind:"update", set:{fk: parentPkExpr}, where:
childUnique})` with a `guard(exists, failure=correlated-kind)` (replacing the tx path's
rowCount==0 throw — the guard now carries that exact message so both modes agree). m2m connect →
`guard(uniqueExists)` + junction `insert` with target-PK subquery; idempotent
(`skipDuplicates`), unrelated FKs untouched.

### connectOrCreate
Deduped inputs (first-create-wins) from `semantic-plan.dedupeConnectOrCreateInputs`. **This
dedupe is reclassified from "divergence-avoidance shim" to a first-class semantic rule** (§10):
in the single interpreter both modes see the same deduped input, so there is no second engine to
diverge; the dedupe is simply "first create wins", a stated Prisma-parity rule
(map-oracle invariant 4, D8). Per input: `probe(record)`; found → connect branch
(guard uniqueExists); missing → create branch (guard uniqueMissing) then create-and-link.

### disconnect
FK-nullability guard first (`assertFkCanBeSetNull`, unchanged, throws synchronously in both
modes at plan time — it is a static property, not a read). Parent-holds-FK → `emit(update
parent SET fk=NULL WHERE parentPk)` + guard(correlated). Child-holds-FK → `emit(update child SET
fk=NULL WHERE …)`; `true` is lax (no guard), explicit-where is strict (guard correlated). m2m →
`emit(delete junction …)`; boolean disconnect on m2m rejected (kept). **The tx path's in-place
`parentData[fk]=null` mutation becomes: the interpreter rebinds the FK column's downstream `Expr`
to `{kind:"lit", value:null}`** — the semantic requirement ("downstream correlation observes the
post-mutation FK state", map-tx-update invariant 14) is met by threading an `Expr`, identically
in both modes. This kills DIVERGENCE-PARENTDATA-MUTATION-vs-BATCH-REF outright.

### delete / deleteMany
`delete:true` lax, explicit strict (guard correlated). Parent-holds-FK delete nulls parent FK
before child delete (rebind FK `Expr` to null, then `emit(delete child)`). deleteMany is
set-based, correlated, no rows-required, updateMany-data-scalar-only rule shared. m2m delete:
junction-first then child, self-ref source-side junctions cleared (kept). **The one gap** (m2m
filtered deleteMany plan-time PK materialization) is the guard-less probe of §3.3, `PlannedMode`
only.

### set
FK-holder rejection, all-targets-exist assertion, departing-rows via shared
`buildDepartingRowsCondition` (with the `COALESCE(...,FALSE)` three-valued-logic fix, kept —
map-tx-update invariant 8). Required-FK departure → guard(whereMissing on departing, failure =
the exact orphan message). **DIVERGENCE-SET-MEMBER-SKIP and the DELETE-vs-existence ordering
inversion (map-shared D.5) are resolved by picking ONE order in the interpreter:**
resolve-all-targets (probe existence) → compute departing → assert/null departing → connect
members, skipping already-connected. The already-connected skip becomes a property of the
interpreter available in *both* modes (in `PlannedMode` the "is already connected" fact comes
from the same all-targets probe the interpreter already runs), removing the batch path's
write-amplification. Gate M5 asserts identical statement *effects* (not counts) and identical
end state.

### update / updateMany
Scalars-before-nested-relations; after-image identity computed via `getUpdatedPrimaryKeyWhere`
(rejecting non-literal PK updates) → post-update PK becomes an `Expr` (literal, or a
`computedPk` sym for `increment` on a PK). Parent-correlation on every to-many mutation
(`combineWithParentCorrelation`) — non-negotiable, kept (map-tx-update invariant 2). The tx
path's "re-SELECT the updated parent" and the batch path's "overlay PK onto pre-read row" unify:
the interpreter carries `updatedParentData` as a record of `Expr`s = pre-read literals overlaid
with the updated-PK `Expr`. **This is where DIVERGENCE-D4 (non-PK correlation column changed
mid-update) is closed on purpose:** if a *non-PK* column that a downstream child correlation
reads is updated, the interpreter rebinds *that column's* `Expr` too (not only the PK). Today's
batch overlays only the PK (map-oracle D4, a latent bug); the unified interpreter overlays every
updated column that is later read. Gate M5 adds the currently-missing scenario.

### upsert (top-level and relation)
Top-level: `probe(where, record)` → existing branch runs `planExistingUpsertBranch` (shared,
kept) producing `update | targetWhereSkipped | setWhereSkipped` with the right guards; missing
branch = create branch with `guard(uniqueMissing)`. Relation upsert (to-one/to-many) same shape.
**M2M upsert's inline branch logic (the highest divergence risk, map-shared D.10 — duplicated in
both handlers, no shared decision function) collapses to ONE interpreter branch:** connected →
update; exists-uncorrelated → throw correlated-not-found; absent → create+connect+guard
(uniqueMissing). Because there is one interpreter, there is no second copy to drift; the M2M
upsert branch is the same function body as the relation upsert branch, specialized only by
"membership = junction" vs "membership = FK". Gate M8 adds the missing M2M conformance scenarios
(map-shared PART G: conformance has ZERO m2m today).

### M2M (all kinds)
`getFkDirection` throws on m2m (kept); m2m forced to after-parent; junction writes over
`buildJunction*` helpers (already unified over `buildScalarSqlValue`, map-shared PART E — the
model of what unification looks like). `assertManyToManyStepCombinationIsSupported` (deleteMany +
create/connect/connectOrCreate/set) **stays a typed error until the interpreter makes the
combination well-defined** — with one interpreter and one ordering, the *reason* for the ban
(tx-orders-before-deleteMany vs batch-resolves-at-plan-time) largely dissolves, but I do **not**
lift it speculatively in this design; lifting it is a separate, test-backed change (§9, deferred).

---

## 6. What is deleted, what is kept

**Deleted (the duplication):** the two dispatchers collapse to one interpreter
(`relation-mutation.ts` + `batch-relations.ts` → one `interpret*` family); the two m2m planners
collapse (`many-to-many.ts` + `batch-many-to-many.ts` → one); the `fk.ts` runtime/symbolic pairs
collapse to one set over `Expr` (map-shared B.1 — the assignment-orchestration duplication, since
the leaf is already shared); `txCtx.createdRecords`/`generatedIds` (dead on the create path,
tx-only artifact — map-tx-create §4.1, DIVERGENCE 5) are dropped, not ported; the inline tx
"subquery-only fast path" for a single connect (map-tx-create §1, largely dead because
`needsTransaction` returns true for any connect) is dropped unless a benchmark justifies it (it
is an optimization the oracle does not distinguish — map-oracle D5).

**Kept verbatim (the semantics):** `getFkDirection`, `planRelationMutationSteps`,
`splitRelationMutationsByFk`, `planExistingUpsertBranch`, `dedupeConnectOrCreateInputs`,
`assertManyToManyStepCombinationIsSupported`, all `record-access.ts` fetch helpers, all `fk.ts`
predicate builders, `buildDepartingRowsCondition`, `many-to-many-utils.ts`, the assertions
adapter primitives, the batch-refs adapter, `assertNestedUpdatePlanIsExecutable`,
`translateRowToFieldNames` (the field-name choke point), the write-race retry wrapper, the three
upward seams (`execute` / `prepareBatch` → `PreparedBatchOperation` / `prepareBatch`→undefined),
the result-window offset math, lazy setup.

**Kept but reclassified from "shim" to "rule":** `dedupeConnectOrCreateInputs` and the m2m
deleteMany-combination ban were divergence-avoidance patches (map-shared A.3, A.7). In the single
interpreter they are simply Prisma-parity rules with no second engine to reconcile — the comment
changes from "keep the two engines aligned" to "first create wins" / "this combination is
undefined". No code change; a semantics reclassification the maintainer's values require us to
make honest.

---

## 7. Static validation (before any effect, both modes)

`assertPlanIsExecutable(ctx, operation, args, mode)` runs before `scope.run`. It is today's
`assertNestedUpdatePlanIsExecutable` + `assertNoPlannedNestedMutationExecution` +
`assertUpdateManyDataHasNoRelations`, plus **symbol-origin legality** (the batch-only PK rules,
now expressed as: every `Symbol` must have a lowerable origin *in this mode*).

Crucially, mode-dependent legality is **checked here, uniformly, as a typed error** — not
discovered mid-execution:

- `LiveMode`: every symbol origin is lowerable (it can read any generated value back). So
  compound-generated PKs, arbitrary generated PKs — all legal.
- `PlannedMode`: only `generatedPk` (single auto-increment) and `computedPk` (PK arithmetic)
  origins are lowerable; a compound generated PK or an unknown non-literal PK → `NestedWriteError`
  "requires primary key known before execution" (today's `getBatchPrimaryKeyRef`/
  `getStaticPrimaryKeyWhere` throws, now hoisted into one static pass). **This is the
  capability-gap-as-typed-error the maintainer requires** (map-oracle invariant 11): the gap is
  enumerated in one place, typed, and mode-scoped, never silently degraded.

Depth of validation is now uniform: because there is one interpreter and `PlannedMode` needs the
whole tree lowerable before emitting, `assertPlanIsExecutable` walks the whole tree in *both*
modes. This makes `LiveMode` reject-before-writing the same inputs `PlannedMode` rejects,
eliminating DIVERGENCE-D5 (tx begins executing then errors; batch rejects up front) — both now
reject up front. A strict improvement in fail-fast behavior, gated by M2.

---

## 8. The compound-generated-PK edge — lifted or rejected *uniformly*

The maps insist this not be left as a silent per-mode disagreement (map-batch-refs invariant 11).
Decision: **reject it uniformly, for now, in both modes**, via §7's static pass — even though
`LiveMode` *could* support it. Rationale: identical observable behavior is worth more than a
capability only one mode has; a compound-autoincrement nested write that succeeds on Postgres but
throws on D1 is exactly the silent divergence the maintainer forbids. Making `LiveMode` reject it
too costs nothing (compound autoincrement is exotic) and buys parity. If a real use case appears,
lifting it means teaching `PlannedMode` to carry multiple generated columns (multiple
`storeLastInsertId`-like stores) — a scoped, test-first change, not a design assumption. This is
the deliberate uniform choice the maps demand; I make it toward rejection and say so.

---

## 9. Where I disagree with the orchestrator's frame

1. **"Two thin semantics-free backends."** I reject this. Two backends re-create the exact
   split that caused every historical double-bug. The code shows the value/read/atomic/step
   substrates are *already* shared; the only real variable is one capability bit. A backend
   split isolates the wrong thing. One interpreter + one `Mode` capability object isolates the
   right ~10% and makes "a feature landing twice" structurally impossible. The IR survives, but
   as the interpreter's *emit vocabulary*, materialized only by `PlannedMode` — not as a
   compile target for two lowerers.

2. **"Compile to a Plan IR, then lower."** Partly reject. A *compile-then-lower* pipeline forces
   `LiveMode` to build and walk a plan it never needs (it executes eagerly and reads its own
   writes). The `emit`-sink formulation lets `LiveMode` stay allocation-free and read-driven
   (today's tx behavior minus duplication) while `PlannedMode` collects the same emissions into a
   list. Same semantics, no forced materialization on the live path.

3. **"Branches must resolve at plan time with SQL guards" (stated as the batch nature).** Agree,
   but I make it *symmetric*: the guard is emitted in **both** modes (a no-op lowering in
   `LiveMode`) so the interpreter has one code path and "a probe without a guard" is
   unrepresentable. The orchestrator framed guards as a batch-only concern; making them
   uniform-but-differently-lowered is what actually kills the silent-divergence class.

4. **The race retry / recursion atomicity.** The orchestrator's frame is silent on these; the
   maps are not. I make them explicit design decisions (§3.2 single flat scope; §4 retry above
   the single interpreter with mode-aligned race classification) rather than leave them as
   substrate accidents. See §11 for the honest weak point.

Where I fully agree: FK-direction as the sole ordering oracle; the symbol = primary-key
insight; the explicit-documented-staleness-contract; typed-error-or-identical-behavior.

---

## 10. Milestones with per-milestone acceptance gates

Every milestone keeps the two acceptance oracles green: `nested-write-conformance.test.ts`
(both modes on PGlite, identical persisted state — via a `PlannedMode`-forcing driver like
today's `BatchOnlyPGliteDriver`) and `tests/drivers/*-behavior.ts` (per-driver Prisma parity).
The strategy is **strangler**: introduce the interpreter alongside, route one kind at a time,
delete the old pair once its kind is green in both modes.

- **M0 — scaffolding, no behavior change.** Land `Expr`, `Symbol`, `Op`, `Probe`, `Mode`,
  `LiveMode`, `PlannedMode`, `AtomicScope`, `selectMode`, and `interpretOperation` as a shell
  that *delegates back to the existing engines*. `selectMode` replaces the dispatcher fork with
  identical routing. **Gate:** full suite green; `selectMode` proven to pick the same path as
  `runNestedWriteOperation` for every driver class (unit test over the capability matrix incl.
  d1-http rejection).

- **M1 — value substrate unified (create leaf).** Route `create`'s scalar/FK value threading
  through `Expr`+`lowerExpr` in both modes, deleting the `fk.ts` runtime/symbolic pair for
  current-FK and related-FK assignment. **Gate:** conformance create scenarios identical in both
  modes; behavior "create derives to-one and to-many FKs", "mapped FK propagation" green.

- **M2 — one static-validation pass, uniform depth.** Move all `assert*Executable` +
  symbol-origin legality into `assertPlanIsExecutable`, run in both modes before any effect.
  **Gate:** "unsupported nested create keys reject before parent mutation" (0 rows) green in both
  modes; add a test that an input `LiveMode` used to begin-then-fail is now rejected up front
  (closes D5); compound-generated-PK rejected in *both* modes with the same message (§8).

- **M3 — create + createMany + connect + connectOrCreate on the interpreter; delete old create
  engine + create half of both dispatchers.** Probe/guard pairing enforced via `ProbeResult`.
  **Gate:** conformance connect/connectOrCreate scenarios (existing→connect, missing→create) +
  first-create-wins dedupe identical in both modes; error-kind-by-direction (target vs
  correlated) preserved in both modes.

- **M4 — single flat atomic scope; recursion emits into it.** Remove nested
  `runNestedMutationAtomically`; `LiveMode` recursion threads the same `emit`. **Gate:** "nested
  child failure rolls back parent + prior children" (0 users, 0 posts) green on both modes and on
  a real multi-level nested scenario; verify no nested `withTransaction` is opened (spy/count).

- **M5 — update/updateMany/set/disconnect/delete/deleteMany on the interpreter; delete
  update/set/etc. engines + rest of both dispatchers.** Pick the single `set` ordering; overlay
  every updated correlation column (closes D4). **Gate:** all correlation/parent-ownership
  behavior tests; "set on required-FK rejects only when orphaned", "set keeping all is no-op";
  add the D4 scenario (non-PK correlation column changed mid-update) — identical end state both
  modes.

- **M6 — one error surface.** Guards carry `failure`; `PlannedMode` maps assertion aborts back
  to typed `NestedWriteError`/`NotFoundError`. **Gate:** delete the `supportsTransactions`
  message-branching in nested-write-behavior (518-528, 721-731); both modes throw the *same
  typed error and message* for correlation/orphan/target-missing failures.

- **M7 — race retry above the single interpreter; batch drivers get converge-on-rerun.**
  `raceable` classification aligned per mode. **Gate:** a concurrent upsert/connectOrCreate-of-
  missing-key test (two racers) converges on one committed row in *both* modes (new concurrent
  suite — today's conformance is serial; this closes the map's flagged latent batch gap).

- **M8 — M2M on the interpreter; delete both m2m planners; add M2M conformance scenarios.**
  One m2m upsert branch (collapses the inline duplication). Add the missing dual-mode m2m
  conformance scenarios (connect, create-through-junction, set, disconnect, delete, deleteMany,
  upsert connected/uncorrelated/create, self-ref). Document + test the one filtered-deleteMany
  staleness gap: `PlannedMode` misses concurrently-added rows; `LiveMode` does not; the gap is a
  single commented guard-less probe. **Gate:** new m2m conformance scenarios identical across
  modes except the documented gap, which has its own asymmetry-asserting test.

- **M9 — delete dead scaffolding, finalize.** Remove `atomic-runner`'s now-unreachable defensive
  throw (subsumed by `selectMode`), `txCtx.createdRecords`/`generatedIds`, and the dead
  subquery-only fast path unless a benchmark reinstates it. **Gate:** full suite green; LOC of
  `nested-writes/` roughly halved; no `if (supportsTransactions/supportsBatch)` outside
  `selectMode` and the two `Mode` implementations (grep gate).

**Deferred, explicitly not in this design (each needs its own test-first change):** lifting the
M2M deleteMany-combination ban (§5); lifting compound-generated-PK rejection (§8); reinstating
the connect fast path (§6). Each is a scoped follow-up, not a hidden assumption.

---

## 11. Self-doubt — the weakest point, honestly

The weakest point is **M4 + M7 together: unifying atomicity and the write-race retry around one
flat scope.** The single-interpreter shape is cleanest for the value/read/step/error substrates,
where the code already converges — I am confident there. But atomicity is where the two
substrates are genuinely *different guarantees*, not the same guarantee expressed two ways.
`LiveMode` today opens a real (possibly nested) transaction and relies on `SELECT … FOR UPDATE`
locking plus a retry to handle concurrent create races; `PlannedMode` has no locks at all, only
plan-time reads + guards + a retry driven by a real INSERT unique-violation. My design asserts
these "converge on retry-once," and §4 leans on the *INSERT* (not the assertion) throwing the
retryable `UniqueConstraintError` in `PlannedMode`. If, on some driver, the `uniqueMissing`
guard fires *before* the INSERT would (aborting with a non-`raceable` assertion error instead of
a unique violation), the retry classification breaks and a concurrent-create case that succeeds
on tx drivers would surface as a hard error on batch drivers — a *new* divergence introduced by
unifying the retry, the opposite of the goal. I believe the guard-orders-before-INSERT case can
be handled by tagging the guard `raceable` and letting the retry accept it, but I have **not**
proven that a stale-`uniqueMissing`-abort and a real-INSERT-unique-violation are always
distinguishable-yet-both-retryable across PG/MySQL/SQLite/D1 error mappings — and today's
conformance suite is serial, so it cannot catch a regression here. M7's new concurrent suite is
therefore load-bearing for the whole thesis, and if it reveals that batch race semantics cannot
be made to match tx race semantics without per-dialect special-casing, the honest fallback is to
keep the retry but *document a typed, mode-scoped concurrency difference* — which would be a
small, named crack in the "identical behavior" ideal that this design otherwise closes.
