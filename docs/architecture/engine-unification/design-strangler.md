# Engine Unification — A Migration-First (Strangler) Design

Status: design proposal. Anchor commit `2fa49b6`, branch `prisma-parity`.
Author lens: **migration-first**. The best design here is worthless if it cannot
land one operation at a time with `tests/query-engine/nested-write-conformance.test.ts`
and the driver behavior suites green at *every* merge. Every abstraction below
carries its justification inline ("this exists because…"). Anything I cannot
justify from first principles I leave out and say so in §11.

This document supersedes nothing yet; it is the plan the six map documents in
this directory were written to enable. It trusts those maps and the consolidated
invariants (I1–I11, D1–D9, the FK-direction law) as ground truth and cites the
code where a decision is load-bearing.

---

## 0. The one-paragraph thesis

A nested write is **an ordered sequence of row mutations over a state that is
partly unknown at plan time**: some values are execution-generated (DB ids),
some branches depend on reads, some premises must still hold at commit. The two
engines that exist today are not two algorithms — they are **one algorithm run
against two substrates**. The proof is already in the code: the value that
crosses every phase boundary is always a primary key read from a persisted row
(`fk.ts`, `many-to-many-utils.ts`), and the single leaf function
`buildScalarSqlValue` *already* accepts both a concrete JS value and a
`BatchValueRef` symbol and lowers each correctly (`values-builder.ts:123`). The
duplication is not at the leaf; it is at the **orchestration** layer, where
`create.ts`/`update.ts`/`many-to-many.ts` re-express, in imperative `await`
style, the exact step sequence that `batch-plan.ts`/`batch-relations.ts`/
`batch-many-to-many.ts` re-express in append-to-a-list style. The design is
therefore: **grow `semantic-plan.ts` into a single compiler that emits a
write-only Plan IR — an ordered list of typed `Op`s over an `Expr` language of
`literal | symbol | columnRef` — and lower that IR through two semantics-free
backends**: a *sequential* backend (execute-and-thread, for interactive-tx and
direct drivers) and a *batch* backend (append-and-guard, for batch-only
drivers). The compiler owns every semantic decision (FK direction, step order,
correlation, existence rules, guards); the backends own only *how a value is
carried* and *how a branch premise is enforced*. That split is exactly the one
substrate difference the maps prove is real, and nothing more.

---

## 1. What is genuinely different between the substrates (and what is not)

I start here because the whole design lives or dies on getting this boundary
right. Over-drawing it produces ceremony; under-drawing it reproduces the bug
class we are trying to kill.

### 1.1 NOT different (already shared, must stay shared)

These are shared today and the maps confirm both engines consume them verbatim:

- **FK direction.** `getFkDirection` is the sole oracle; throws on M2M before
  inverse scanning; `pkFields = inverse.references ?? PK`. (Invariant: keep it
  the *only* direction source.)
- **Step decomposition and order.** `planRelationMutationSteps` →
  `create, createMany, connect, connectOrCreate, disconnect, delete, set,
  update, updateMany, deleteMany, upsert`. Fixed. Both engines iterate it.
- **FK split / timing.** `splitRelationMutationsByFk` (current-holds-FK →
  before parent INSERT; related-holds-FK and M2M → after).
- **Value lowering at the leaf.** `buildScalarSqlValue` +
  `lowerBatchResolvableValue` + `castBatchRefValue`. A literal and a symbol are
  already interchangeable here.
- **Correlation SQL.** `buildFkMatchCondition`, `combineWithParentCorrelation`,
  `buildCurrentRecordMatchCondition` — all substrate-agnostic (route through
  `buildScalarSqlValue`).
- **Junction SQL.** All of `many-to-many-utils.ts` (`buildJunctionInsert`,
  `buildJunctionMembership`, `buildTargetPkSubquery`, …).
- **Read helpers.** `record-access.ts` (`fetchOptional*`, `fetchRequired*`) —
  both engines call the identical functions; the only difference is *when* the
  read fires relative to the writes it informs.
- **Static validation.** `assertNoPlannedNestedMutationExecution`,
  `assertNestedUpdatePlanIsExecutable`, `assertUpdateManyDataHasNoRelations`,
  `assertManyToManyStepCombinationIsSupported`.
- **Error taxonomy.** `recordNotFoundError({kind: target|correlated|nested-write})`.

### 1.2 Genuinely different (the substrate boundary — exactly two axes)

Everything the maps call a "divergence" reduces to two axes. I claim there are
**only two**, and I will defend that the whole design is the minimal abstraction
over exactly these two.

**Axis A — how a produced value is carried forward.**
A value produced by an earlier statement that a later statement needs:
- Sequential backend: `await` the statement, read the value as a JS literal,
  thread it into the next statement's params. (tx today)
- Batch backend: the value is a `BatchValueRef` symbol; the producing statement
  emits a `store` (or `storeLastInsertId`), and the consuming statement embeds a
  `read()` subquery. (batch today)

The leaf lowering already abstracts this (`buildScalarSqlValue`). So Axis A is
already solved at the value level; the design only needs to make the *plan*
speak in symbols so both backends resolve them their own way.

**Axis B — how a read-driven branch and its premise are enforced.**
A branch chosen from a read (upsert exists?, connectOrCreate found?,
targetWhere matched?), and a precondition that must hold at commit (target
exists, child correlated, unique-key still absent):
- Sequential backend: read at execution, branch in JS, no guard needed (read and
  write are in the same open transaction, serialized; a mid-flight `throw` rolls
  back). Preconditions enforced by pre-read-then-throw or rows-affected==0.
- Batch backend: read at **plan time** against committed state, branch in JS,
  then emit a **guard statement** re-asserting the premise at commit; a stale
  premise aborts the atomic batch. Preconditions enforced by `assertions.exists/
  notExists` guards.

This is the *real* asymmetry, and it is **control-flow, not value-flow**. The
tx engine expresses a branch as `if`; the batch engine expresses it as
`(decision baked into the statement list) + (guard object)`. The IR must
therefore model a branch as **data** (a decision + a guard), so the sequential
backend can execute it as control-flow and the batch backend can lower it to
guarded statements — and crucially so that *the decision is made in exactly one
place* (the compiler), removing the class of bugs where the two engines chose
differently.

**That is all.** Every entry in the maps' divergence tables is Axis A, Axis B,
or a *consequence* of one of them (e.g. the compound-generated-PK limitation is
Axis A hitting the batch backend's single-`last_insert_rowid()` ceiling; the
error-type divergence D1 is Axis B's guard raising a raw SQL error instead of
the typed one). I will handle the consequences explicitly rather than let them
leak.

### 1.3 Where I disagree with the orchestrator's frame

The orchestrator proposed a "write-only Plan IR (Insert/Update/Delete/Read/
Guard/Branch over exprs)" with "branches resolve at plan time with SQL guards".
I accept the IR and the Expr language. I **push back on two points**:

1. **"Branches must resolve at plan time" is a batch-backend property, not an
   IR property.** If I bake branch resolution into the IR, the sequential
   backend is forced to pre-read too, losing the tx engine's read-after-write and
   its FOR-UPDATE locking (which is what makes the single-retry race compensation
   correct — invariant I from the maps, `transaction-flow.ts:108`). So the IR
   must contain a `Branch` node whose *condition is a `Read`*, and **each backend
   decides when to evaluate it**: the sequential backend evaluates at execution
   (inside the tx, with locking); the batch backend evaluates at plan time and
   emits the guard. The IR carries the guard as *data attached to the branch*, so
   the batch backend has it and the sequential backend ignores it. This keeps the
   tx engine's concurrency semantics intact instead of degrading every driver to
   the batch engine's weaker plan-time-read model. **This is the single most
   important design decision and I am overriding the frame on it.**

2. **A general `Read`/`Branch` IR is where "IR creep toward a query language"
   bites.** The maps enumerate a *closed* set of branch shapes: existence probes
   (`uniqueExists/uniqueMissing`), conditional-match probes
   (`uniqueWithWhere*`), connectOrCreate found/missing, upsert exists/missing,
   the M2M upsert three-way. I will **not** add a general `Read`+`Branch`. I will
   add a *fixed, closed* set of high-level `Op`s (`ResolveOrCreate`,
   `UpsertInto`, `ReplaceSet`, …) whose branch logic is compiled once and whose
   guard is attached. The `Expr` language stays tiny (three constructors). This
   is the deliberate anti-creep boundary; §11 records the temptation I am
   refusing.

---

## 2. The core abstractions (each with its justification)

Five abstractions. I resisted more; §11 lists what I threw out.

### 2.1 `Expr` — the value language

```ts
// A value that appears in a Plan. Exactly three shapes. This is the whole
// value language; it does not grow.
type Expr =
  | { kind: "lit"; value: unknown }          // a known literal (client-supplied PK, scalar)
  | { kind: "sym"; sym: Symbol_ }            // a value produced during execution, not yet known
  | { kind: "col"; model: Model<any>; field: string }; // a column of a row (rare; for computed-PK arithmetic)

// A Symbol_ names a value produced by an Op during execution. It is the unified
// form of today's BatchValueRef, and of the tx engine's "read the PK back into
// a JS var". Compound identities are a Record<field, Expr>.
interface Symbol_ {
  readonly id: string;            // unique within one Plan
  readonly origin: SymbolOrigin;  // how it gets its value (see §2.4)
  readonly castField?: { model: Model<any>; field: string }; // for TEXT round-trip cast-back
}
```

**This exists because** the maps prove the value crossing every phase boundary
is always a PK read from a persisted row, and `buildScalarSqlValue` already
lowers `lit | sym`. `col` exists solely for the computed-PK-update case
(`increment` on a PK column, `batch-updated-primary-keys.ts`), which is the only
place a value is derived arithmetically from another column rather than read
whole; without `col` I would have to special-case that one op. Three
constructors, no arithmetic node, no boolean node — arithmetic and predicates
live in adapter-built `Sql`, not in `Expr` (anti-creep; see §11).

`Expr` is a strict superset of what flows today: a `lit` is a tx concrete value,
a `sym` is a `BatchValueRef`. **The sequential backend resolves a `sym` by
reading the produced value into a JS map; the batch backend resolves it via
`store`/`read`.** Same symbol, two resolutions — Axis A, made first-class.

### 2.2 `Op` — the write-only instruction set

An ordered `Op[]` is a Plan body. Each `Op` is a *semantic* instruction, not a
SQL statement — the backend turns it into 1..n statements. The set is closed and
small; it mirrors exactly the operations the maps enumerate.

```ts
type Op =
  // ---- primitive row writes ----
  | InsertRow      // INSERT one row; may PRODUCE a Symbol_ for its generated PK
  | InsertRows     // INSERT many rows (createMany); skipDuplicates flag
  | UpdateRow      // UPDATE by a correlated where; may PRODUCE a computed-PK symbol
  | DeleteRow      // DELETE by a correlated where
  | SetNullFk      // UPDATE ... SET fk = NULL by correlated where (disconnect)

  // ---- resolved branches (branch logic compiled ONCE, guard attached) ----
  | ResolveTarget      // connect: require a target row exists; PRODUCE its PK symbol
  | ResolveOrCreate    // connectOrCreate: found -> use PK; missing -> create; guard pins the choice
  | UpsertInto         // upsert one relation slot / row: exists -> update; missing -> create
  | ReplaceSet         // set: replace the whole to-many/junction membership atomically

  // ---- junction writes (M2M) ----
  | InsertJunction     // idempotent (source,target) insert
  | DeleteJunction     // delete junction rows by source [+ target-in]
  | DeleteChildAndJunctions // delete child rows and all their junction rows, junction-first

  // ---- guards & assertions ----
  | Assert         // a premise that must hold; carries kind (§2.3)

  // ---- the trailing read ----
  | ReadBack       // the final findUnique that produces the returned record
```

Each `Op` carries: the `RelationPlanContext` (relation name, `relationInfo`,
timing) where relevant, its `where`/`data` as **`Expr`-valued** structures, the
`Symbol_` it produces (if any), and — for the resolved-branch ops — the
`Assert` it implies. Concrete field sketches for the load-bearing ones:

```ts
interface InsertRow {
  kind: "insertRow";
  model: Model<any>;
  data: Record<string, Expr>;              // scalars + FK columns, FK may be a sym
  produces?: Symbol_ | Record<string, Symbol_>; // generated PK (single or compound)
}

interface UpdateRow {
  kind: "updateRow";
  model: Model<any>;
  where: Sql;                              // already-correlated (adapter-built)
  set: Record<string, Expr | SetOp>;       // SetOp = {increment: Expr} etc.
  producesUpdatedPk?: Record<string, Symbol_>; // when a PK column is mutated
}

interface ResolveOrCreate {                // connectOrCreate, one input
  kind: "resolveOrCreate";
  context: RelationPlanContext;
  where: Record<string, unknown>;          // unique where to probe
  create: Record<string, unknown>;         // raw create payload (recursively compiled on the miss branch)
  fkDirection: FkDirection;
  produces: Record<string, Expr>;          // the resolved target PK (lit if found-at-plan, sym if created)
  guard: Assert;                           // uniqueExists (found) | uniqueMissing (created)
}

interface UpsertInto {                     // to-one / to-many / top-level upsert arm
  kind: "upsertInto";
  context?: RelationPlanContext;           // absent for top-level upsert
  locate: UpsertLocator;                   // fk-match (to-one) | unique-where (+correlation)
  update: Record<string, unknown>;         // compiled recursively on the exists branch
  create: Record<string, unknown>;         // compiled recursively on the missing branch
  branchModel: ExistingUpsertBranch | "m2m"; // reuse planExistingUpsertBranch, or the M2M three-way
  guards: Assert[];                        // exists/missing/withWhere* per branch
}
```

**This exists because** the maps show both engines already dispatch on exactly
these kinds via `planRelationMutationSteps` + a switch. The *resolved-branch*
ops (`ResolveOrCreate`, `UpsertInto`, `ReplaceSet`) are the key move: today the
branch decision lives in *two* places (`connect-or-create.ts` vs
`batch-relations.ts appendConnectOrCreate`; `upsert.ts` vs `appendUpsertRecord`;
inline M2M upsert in *both* M2M files). Making them single `Op`s forces the
decision into one compiler function, which is the entire point — it structurally
prevents the D10 "highest divergence risk because there is no shared decision
function" class of bug. I am **not** adding a general `Branch` op precisely to
avoid IR-as-query-language creep (§1.3.2, §11).

### 2.3 `Assert` — the guard, as data

```ts
type Assert =
  | { kind: "exists";        where: Sql; error: AssertError }
  | { kind: "notExists";     where: Sql; error: AssertError }
  | { kind: "rowsAffected";  min: number; error: AssertError }; // sequential-only realization

interface AssertError {                    // the typed error this guard stands for
  errorKind: "target" | "correlated" | "nested-write" | "orphan" | "fkRequired";
  relationName: string;
  operation: string;
  message: string;                         // pinned by the behavior suites
}
```

**This exists because** the maps' single biggest *observable* gap (D1, F.4) is
that the batch backend's guards raise a raw dialect SQL error
(`NestedWriteAssertionError`) while the tx backend throws a typed
`NestedWriteError` with a specific message. By making the intended typed error
**part of the guard object**, both backends can produce the same error surface:
the sequential backend throws `error` directly (as a pre-read-then-throw or a
rows-affected==0 check); the batch backend attaches `error` to the guard so that
when the guard's SQL aborts the batch, the driver-level failure is caught and
**re-thrown as `error`** (see §4.3 error normalization). This closes D1 by
construction instead of leaving it a "documented divergence." An `Assert` is the
unification of today's `throwIfNoCorrelatedRowsAffected` /
`fetchRequiredUniqueRecord`-then-throw (sequential) and `appendAssert*` (batch).

Note `rowsAffected` is a sequential-only realization: the tx engine detects a
missing correlated row by `rowCount === 0` after an UPDATE/DELETE. The batch
backend cannot see a rowcount mid-batch, so the compiler emits an equivalent
`exists` guard *before* the mutation for the batch backend. The compiler decides
which realization each backend gets from the *same* `Assert` intent — this is
the D6 (delete/disconnect strictness) reconciliation.

### 2.4 `SymbolOrigin` — how a symbol gets its value

```ts
type SymbolOrigin =
  | { kind: "generatedPk"; model: Model<any> }            // last_insert_rowid() after an InsertRow
  | { kind: "computedPk"; sql: Sql }                      // adapter arithmetic (increment on PK)
  | { kind: "readColumn"; model: Model<any>; field: string; locate: Sql }; // a value read from a row
```

**This exists because** Axis A has exactly three sources in the code:
`storeLastInsertId` (generated), `store(computedSql)` (computed PK arithmetic,
`batch-updated-primary-keys.ts`), and "read a column back" (upsert existing-PK,
connectOrCreate found-PK). The sequential backend resolves each by executing and
reading JS; the batch backend resolves each by emitting the matching
`batchRefs.store*` + `read`. This is a *closed* enumeration — I do not need a
general "expression evaluator." The compound-generated-PK ceiling
(`generatedPk` can only be a single column via `last_insert_rowid()`) lives here
as a compile-time check (§2.6).

### 2.5 `Plan` and the compiler/backend seam

```ts
interface Plan {
  operation: "create" | "update" | "upsert";
  ops: Op[];                 // ordered; FK-direction and step-order already baked in
  symbols: Symbol_[];        // all symbols, for the batch backend's setup laziness
  resultParse: (row: Record<string, unknown> | undefined) => unknown; // over the ReadBack
}

// The compiler: pure-ish (it MAY do plan-time reads on the batch backend — see §3).
// It is grown from semantic-plan.ts.
interface Compiler {
  compileCreate(ctx, args): Promise<Plan>;
  compileUpdate(ctx, args): Promise<Plan>;
  compileUpsert(ctx, args): Promise<Plan>;
}

// The two backends. Semantics-free: they never decide a branch, never choose an
// order, never build a correlation. They only realize Ops and resolve Symbols.
interface Backend {
  run<T>(ctx, plan: Plan, driver): Promise<T>;
}
```

**This exists because** the maps show the callers depend on exactly three seams
(`execute`, `prepareBatch → PreparedBatchOperation`, `prepareBatch → undefined`).
`Plan` is what both backends consume; `Backend.run` is what `execute` and
`prepareBatch` call. The compiler is the grown-up `semantic-plan.ts`. This is
the whole architecture: **one compiler, two backends, one IR between them.**

### 2.6 The batch capability check lives in the compiler, not the backend

The compound-generated-PK rejection, the "PK known before execution" rule, and
the M2M-parent-PK-must-be-known rule are **compile-time** properties of a
symbol's origin, not runtime backend properties. But they only *apply* to the
batch backend (the sequential backend can read anything back). So the compiler
takes a `capabilities` flag:

```ts
interface Capabilities { deferredValues: "read-back" | "single-generated-only"; }
```

- Sequential backend → `read-back`: any symbol origin is fine.
- Batch backend → `single-generated-only`: `generatedPk` allowed for a single PK
  column only; compound-generated PK → typed `NestedWriteError` at compile time
  (preserving I1 / D3). M2M filtered `deleteMany` with a symbolic parent PK →
  typed error (preserving the D7/§9 rule).

**This exists because** invariant I11 demands "batch-only capability gaps remain
typed errors, never silent divergence." Putting the check in the compiler (which
knows the capability) means the *same* compile pass that both backends share
raises the error — there is no way for the two backends to disagree on legality
(closing the "compound-autoincrement legal on tx, illegal on batch" latent gap
by making it a *declared, uniform* capability difference rather than an accident
of which file you happened to be in).

---

## 3. The compiler's responsibilities (what it owns)

The compiler is `semantic-plan.ts` grown to own **every** semantic decision.
Concretely it owns:

1. **`separateData`** into scalars vs relations (already shared).
2. **Static validation** — `assertNoPlannedNestedMutationExecution`,
   `assertNestedUpdatePlanIsExecutable`, `assertUpdateManyDataHasNoRelations`,
   `assertManyToManyStepCombinationIsSupported`. Runs first, before emitting any
   `Op` (I11 / D5: whole-tree up-front validation — the compiler adopts the
   batch engine's deeper validation for *both* backends, which is strictly safer
   and removes D5 as a divergence).
3. **FK direction and split** — `getFkDirection`, `splitRelationMutationsByFk`.
   Emits before-parent `Op`s (currentHoldsFk) and after-parent `Op`s
   (relatedHoldsFk + M2M) in the FK-direction order (I4).
4. **Step order** — `planRelationMutationSteps` (I5), verbatim.
5. **Correlation** — every to-many `Op`'s `where` is
   `combineWithParentCorrelation`-ed before it enters the IR (invariant:
   parent-correlation on every to-many mutation).
6. **Branch resolution** — the *single* place `ResolveOrCreate` / `UpsertInto` /
   `ReplaceSet` branch logic lives. Reuses `planExistingUpsertBranch`
   (already shared) and a new shared `planM2mUpsertBranch` (extracted from the
   two inline copies — this is a concrete divergence-elimination the migration
   delivers, §7 milestone M6).
7. **Guard attachment** — every branch/precondition emits its `Assert` with the
   typed `AssertError` message (closing D1).
8. **Symbol allocation** — every produced PK becomes a `Symbol_` with the right
   `origin`; the capability check (§2.6) runs here.
9. **The result window** — the trailing `ReadBack` and its parse; return-shape
   parity (scalars-only vs refetch-by-final-PK).

**Plan-time reads.** The subtle part: `ResolveOrCreate` / `UpsertInto` need to
know found-vs-missing. Per §1.3.1, the IR does *not* resolve this; it records the
probe (`where`) and both branches (compiled). **The backend decides when to
probe.** So the compiler emits a *branch Op with both arms compiled*; it does
**not** itself call `driver._execute`. This is a departure from today's batch
planner (which reads at plan time inside `appendUpsertRecord`). I move the probe
*into the batch backend* so the compiler stays a pure function of `(ctx, args,
capabilities)`. Benefit: the compiler is testable without a driver, and the
"read at plan time" behavior is contained in exactly one place (the batch
backend) where its staleness guard also lives — they cannot drift apart.

> Trade-off, stated honestly: compiling *both* arms of every branch up front
> costs work on the arm not taken (e.g. compiling a `create` payload that will be
> discarded because the target was found). The tx engine today lazily compiles
> only the taken arm. I accept this cost because (a) compiling is cheap
> string/Expr building, no I/O; (b) it is the price of the compiler being
> driver-free and the branch decision being single-sourced. §11 flags it as the
> weakest efficiency point.

---

## 4. The two backends (what they own — nothing semantic)

### 4.1 Sequential backend (`SequentialBackend`)

Serves interactive-tx drivers (and any driver with `supportsTransactions`). Runs
inside `runNestedMutationAtomically` → `withTransaction`. For each `Op` in
order:

- `InsertRow` → resolve `data` Exprs to JS values (a `sym` resolves from the
  symbol table it fills as it goes), execute the INSERT, read the generated PK
  (RETURNING / lastInsertId / provided), **store it in the symbol table** under
  the produced `Symbol_.id`. This is today's `executeSimpleInsert` contract.
- `UpdateRow` / `DeleteRow` / `SetNullFk` → resolve, execute; if the `Op` carries
  a `rowsAffected` assert, check `rowCount` and throw the typed `AssertError`.
- `ResolveOrCreate` / `UpsertInto` → **evaluate the branch at execution time**:
  run the probe read (inside the tx, optionally FOR UPDATE for upsert), pick the
  arm, execute it. The attached `Assert` guard is a *no-op* for this backend
  (the read-in-tx already enforces the premise — Axis B, sequential realization).
- `Assert(exists/notExists)` → realize as a pre-read-then-throw (today's
  `fetchRequiredUniqueRecord`-then-`recordNotFoundError`).
- `ReadBack` → the final findUnique.

The symbol table is a `Map<string, unknown>` — the unified, single form of
today's ad-hoc "thread the JS value into the next call." `parentData` mutation
(disconnect setting `parentData[fk]=null`) becomes "write `null` to the symbol
that downstream correlation reads" — same observable effect, no in-place record
mutation (invariant 14: parentData mutation is a substrate detail).

**Why this backend keeps the tx concurrency semantics:** because it evaluates
branches *at execution inside the transaction*, FOR-UPDATE locking and
read-after-write still work, so the single-retry race compensation
(`transaction-flow.ts:108`) stays correct and unchanged. I did not degrade it to
the batch model. (This is the §1.3.1 override paying off.)

### 4.2 Batch backend (`BatchBackend`)

Serves batch-only drivers (D1, Neon-HTTP). Builds a `PlanState`-equivalent
`Sql[]` and hands it to `driver._executeBatch`. For each `Op`:

- Resolve Exprs via `buildScalarSqlValue` (a `sym` lowers to `batchRefs.read`).
- `InsertRow` with a `generatedPk` produce → emit INSERT then **immediately**
  `storeLastInsertId` (the ordering rule, `batch-plan.ts:199`; the backend
  enforces "store directly follows its INSERT").
- `UpdateRow` with `computedPk` → emit UPDATE then `store(computedSql)`.
- `ResolveOrCreate` / `UpsertInto` → **evaluate the branch at plan time**: run
  the probe read against committed state (this is the one place plan-time reads
  live), pick the arm, emit its statements, and emit the attached `Assert` as an
  `assertions.exists/notExists` guard pinning the premise (Axis B, batch
  realization).
- `Assert` → emit the adapter guard SQL; register its `AssertError` so a batch
  abort at that statement index normalizes to the typed error (§4.3).
- `ReadBack` → the trailing findUnique; the parse window offset math
  (I10, `setupStatements.length`) is preserved.

Setup/cleanup (temp table) materialize lazily only if any `Symbol_` needs the
scratch table (I: lazy setup preserved — the `BatchReferenceStore.initialize`
mechanism carries over unchanged).

### 4.3 Error normalization (closing D1 and F.4)

The batch backend wraps `driver._executeBatch` in a catch. It keeps a map from
statement index → `AssertError` (populated when it emits guard statements). When
the driver reports a failure, the backend:

1. If the failure is a known guard abort → throw the mapped `AssertError`
   (typed `NestedWriteError` with the pinned message).
2. If it is a `UniqueConstraintError` / DEADLOCK / SERIALIZATION → rethrow as-is
   so the race-retry wrapper (unchanged, above both backends) sees it.

**This exists because** the maintainer's value is "identical behavior on every
driver class, or a clear typed error — never silent divergence," and today the
batch path violates it by surfacing `NestedWriteAssertionError` where tx
surfaces `NestedWriteError`. Making the typed error travel *with* the guard is
the minimal fix. The behavior suites that today branch on
`driver.supportsTransactions` to assert two different messages (nested-write-
behavior 518-528, 721-731) become a **single** assertion after this lands —
which is itself a milestone acceptance signal (§7, M4).

> Honesty: the driver→guard-index mapping is only as reliable as the driver
> reporting *which* statement failed. D1's `batch()` and Neon's `transaction()`
> both fail the whole batch on the first error; if a driver does not tell us the
> failing index, the backend falls back to a generic-but-typed `NestedWriteError`
> ("nested write assertion failed") rather than the specific message. That is a
> strictly smaller divergence than today (typed vs untyped) and is the realistic
> ceiling. §11 records it.

---

## 5. How each mutation kind compiles (the concrete table)

For every kind, the compiler emits the same `Op`s regardless of backend; the
backend realizes them per §4. FK direction is from `getFkDirection`; ordering is
`planRelationMutationSteps`. "before/after" is the parent-INSERT timing.

| kind | compiled Ops (in order) | symbols / guards | invariant pinned |
|---|---|---|---|
| **create** (currentHoldsFk, before) | `ResolveTarget`/`ResolveOrCreate`/`InsertRow(child)` → child PK Expr injected into parent `InsertRow.data` | child PK `sym` if created; `Assert(exists)` for connect | FK-dir: child before parent; PK → parent FK |
| **create** (relatedHoldsFk, after) | parent `InsertRow` (produces parent PK sym) → child `InsertRow` with parent PK stamped into FK | parent PK sym | FK-dir: parent before child |
| **createMany** (related, after) | `InsertRows` with parent PK stamped, `skipDuplicates` | — | related-holds-FK only; scalar rows |
| **connect** (parent holds FK) | `ResolveTarget` (probe target) → PK into parent `InsertRow`/`UpdateRow` FK | `Assert(exists, kind:target)` | connect target must exist; `target` error kind |
| **connect** (child holds FK) | `UpdateRow(child SET fk=parentPk WHERE unique)` | `Assert(rowsAffected≥1, kind:correlated)` | `correlated` error kind on miss |
| **connect** (M2M) | `InsertJunction(parentPk, targetPkSubquery)` | `Assert(exists, kind:target)` (batch) / read-then-throw (seq) | idempotent junction; unrelated FKs untouched |
| **connectOrCreate** | `ResolveOrCreate` (found→PK Expr; missing→compile `create` recursively) | guard `uniqueExists`(found) \| `uniqueMissing`(missing) | first-create-wins (dedupe stays in compiler) |
| **disconnect** (parent holds FK) | `SetNullFk(parent WHERE parentPk)` | `Assert(fkRequired)` if non-nullable; `rowsAffected` | required-FK reject; symbol fk←null |
| **disconnect** (child holds FK) | `SetNullFk(child WHERE correlated)` | `true`→lax; else `rowsAffected(kind:correlated)` | true-lax / explicit-strict asymmetry |
| **disconnect** (M2M) | `DeleteJunction(source[, target-in])` | boolean-disconnect → typed reject | child survives |
| **set** (to-many/child FK) | `ReplaceSet`: departing-rows `Assert(orphan)`/`SetNullFk` → per-member connect | `buildDepartingRowsCondition` (COALESCE fix, shared) | required-FK orphan reject only when rows depart; 3VL safety |
| **set** (M2M) | `ReplaceSet`: `DeleteJunction(all source)` → per-member `InsertJunction` | `Assert(exists)` per member | all-or-nothing replace |
| **delete** (correlated) | `DeleteRow(child WHERE correlated)`; parent-holds-FK: `SetNullFk(parent)` **before** | `true`→lax; else `rowsAffected`/`exists`(kind:correlated) | null parent FK before child delete |
| **delete** (M2M) | `DeleteChildAndJunctions` (junction-first; self-ref source too) | per-item `Assert(exists)` (batch) | delete child + all its junction rows |
| **deleteMany** (child FK) | `DeleteRow(child WHERE parentFk ∧ filter)` | none (set-based, never rows-required) | correlated set-based |
| **deleteMany** (M2M) | resolve connected PKs → `DeleteChildAndJunctions(PK-in)` | **capability check**: symbolic parent PK → typed error (batch) | the documented staleness gap (§9) |
| **update** (to-one) | `UpdateRow(child WHERE fkMatch)` → recurse | `Assert(exists, kind:correlated)`; producesUpdatedPk if PK mutated | scalars before nested; after-image |
| **update** (to-many) | per input: `UpdateRow(child WHERE unique ∧ parentFk)` → recurse | `Assert(exists/rowsAffected, kind:correlated)` | parent-correlation |
| **updateMany** | `UpdateRow(child WHERE parentFk ∧ filter)` | none; `assertUpdateManyDataHasNoRelations` | scalar-only, set-based |
| **upsert** (to-one) | `UpsertInto(locate=fkMatch)`: exists→update arm; missing→create arm (timing per FK dir) | exists/missing guards | FK-dir on create arm |
| **upsert** (to-many) | `UpsertInto(locate=unique+correlation)`: connected→update; uncorrelated-exists→typed reject; absent→create | `uniqueMissing` on create arm | correlated-not-found reject |
| **upsert** (M2M) | `UpsertInto(branchModel="m2m")` via shared `planM2mUpsertBranch` | `uniqueMissing` on create arm | connected→update / exists-uncorrelated→throw / absent→create+connect |
| **upsert** (top-level) | probe by `where` [FOR UPDATE on seq]; exists→`UpsertInto` update arm (with targetWhere/setWhere via `planExistingUpsertBranch`); missing→create | `uniqueExists`/`uniqueMissing`/`uniqueWithWhere*` | targetWhere/setWhere no-op skip |

Every row above is realized identically in state by both backends; the only
difference is Axis A (how a `sym` is carried) and Axis B (when a branch is
evaluated and whether a guard is emitted). That is the whole claim, made
operation-by-operation.

---

## 6. What each caller seam sees (upward contract preserved)

The three seams (map-oracle §B) stay byte-identical in shape:

- **`metadata.execute`** → `SequentialBackend.run(compileX(...))` inside
  `runNestedMutationAtomically`, OR — for a batch-only driver reached via direct
  await — `BatchBackend.run(...)`. The `runNestedWriteOperation` dispatch
  (`transaction-flow.ts:132`) is unchanged; it just picks the backend.
- **`metadata.prepareBatch`** → compiles the `Plan`, then `BatchBackend`
  produces `PreparedBatchOperation { queries, setupQueries, cleanupQueries,
  parseResult }`. Shared `PlanState` across `$transaction([...])` ops via
  `BatchPreparationContext.nestedWriteState` is preserved (the compiler appends
  into a shared symbol namespace; §migration keeps the exact
  `getSharedPlanState` mechanism).
- **`prepareBatch → undefined`** → the compiler/backend returns `undefined`
  exactly when it cannot honor atomicity (batch-only driver that declares
  `supportsBatch=false`, i.e. d1-http). Unchanged.

The **race-retry wrapper** (`executeWithNestedWrites`, `isWriteRaceLoserError`,
`hasRaceableCreateBranch`) stays **above** both backends, untouched. Its error
classification keeps recognizing `UniqueConstraintError`/DEADLOCK/SERIALIZATION;
§4.3 guarantees the batch backend still surfaces a real `UniqueConstraintError`
from a losing INSERT (not a swallowed assertion), so the coupling the map flags
(D7 "verify") holds.

---

## 7. Migration plan (strangler, one kind at a time, green at every merge)

The design's whole justification is that it can be *strangled in*, not
rewritten. The strategy: introduce the IR + both backends behind a **per-kind,
per-op feature switch** in the compiler, route one mutation kind through the new
path at a time, and keep the old files as the fallback until their last consumer
is gone. The conformance suite (both engines, PGlite) is the gate on every
merge; the driver behavior suites are the gate on kinds with weak conformance
coverage (M2M — see map-shared §G).

**Pre-work — scaffolding (no behavior change).**
- Add `ir.ts` (`Expr`, `Op`, `Assert`, `Symbol_`, `Plan`) and empty
  `SequentialBackend` / `BatchBackend` skeletons.
- Add a `compile*` entry that, for a kind not yet migrated, throws
  `"not-migrated"` — caught by a shim that falls back to the existing engine.
- **Gate:** full suite green (nothing routes through the new path yet).

**M1 — `create`, no relations (the tracer bullet).**
- Compile the simplest case (`InsertRow` + `ReadBack`) through both backends.
- Route only relation-free create through the compiler; everything else falls
  back.
- **Acceptance gate:** conformance create scenarios green through *both*
  backends; behavior "create derives FKs" green; `dumpState` identical.

**M2 — `create` with relations (both FK directions, connect, connectOrCreate).**
- Add `InsertRow(child)`, before/after split, `ResolveTarget`, `ResolveOrCreate`,
  M2M `InsertJunction`/`InsertChildAndJunction`.
- Retire `create.ts`, `connect.ts`, `connect-or-create.ts` (tx) and
  `appendCreateRecord`/before-parent path (batch) once no fallback hits them.
- **Gate:** all create + connect + connectOrCreate conformance and behavior
  scenarios green on both backends; the atomicity oracle (duplicate-PK createMany
  → 0 parent, 0 children) green on both; **capability check** produces the typed
  compound-generated-PK error on the batch backend (new assertion).

**M3 — `update` + `updateMany` (scalars-before-relations, correlation).**
- Add `UpdateRow` with `producesUpdatedPk` (computed-PK symbol), after-image
  handling, parent-correlation.
- Retire `update.ts`, `update-many.ts`, `batch-updated-primary-keys.ts` consumers.
- **Gate:** update/updateMany correlation + "cannot target another parent's
  child" green on both backends. **D1 milestone:** the behavior test's
  `supportsTransactions` branch for the correlation-reject message collapses to a
  single message (§4.3). If it does not, the milestone is not done.

**M4 — `delete`, `deleteMany`, `disconnect`, `set` (the guard-heavy kinds).**
- Add `DeleteRow`, `SetNullFk`, `ReplaceSet`, `Assert(orphan/fkRequired)`, the
  shared `buildDepartingRowsCondition` path.
- Retire `delete.ts`, `delete-many.ts`, `disconnect.ts`, `set.ts`,
  `batch-relation-links.ts`.
- **Gate:** required-FK disconnect/set reject green on both; set no-op-succeeds
  green; the D1 message-unification also holds for the set-orphan reject
  (behavior 721-731 collapses to one message).

**M5 — `upsert` (to-one, to-many, top-level, targetWhere/setWhere).**
- Add `UpsertInto`, reuse `planExistingUpsertBranch`, wire the top-level
  probe (FOR UPDATE on sequential).
- Retire `upsert.ts` and `appendUpsertRecord`.
- **Gate:** advanced "top-level upsert guards gate nested update branch" green on
  both; race-retry still fires (concurrency behavior tests, where present).

**M6 — M2M consolidation (the highest-risk divergence — do it last, with new
oracle coverage first).**
- **Before touching code:** add M2M scenarios to
  `nested-write-conformance.test.ts` (connect, create-through-junction, set,
  disconnect, delete, deleteMany, upsert connected/uncorrelated/create,
  self-referential delete) so tx-vs-batch M2M equivalence is *directly* asserted
  (map-shared §G says it is not today). This is a prerequisite, not an afterthought.
- Extract the inline M2M upsert branch into shared `planM2mUpsertBranch` (kills
  the D10 duplication).
- Route M2M through `InsertJunction`/`DeleteJunction`/`DeleteChildAndJunctions`/
  `ReplaceSet`/`UpsertInto(branchModel="m2m")`.
- Retire `many-to-many.ts`, `batch-many-to-many.ts` (keep
  `many-to-many-utils.ts` — it is already the good shared layer).
- **Gate:** the new conformance M2M scenarios green on both backends; the
  documented M2M filtered-deleteMany staleness gap (§9) is now a *single*
  compiler-emitted behavior with a typed error on symbolic parent PK — not a
  per-engine accident.

**M7 — delete the old orchestrators and dead bookkeeping.**
- Remove `relation-mutation.ts` (the injected-executor dispatch), `create.ts`
  Phase machinery, `txCtx.createdRecords`/`generatedIds` (dead on create path,
  map-tx-create §4.1). Keep `fk.ts`'s *shared* condition builders; delete its
  duplicated tx-vs-batch assignment pairs (now one path over `Expr`).
- **Gate:** whole suite green; line count of `operations/nested-writes/` down
  from ~6600 to the compiler + two backends + shared builders. This is the
  quantitative success signal.

**Rollback discipline:** every milestone leaves the old file importable and the
feature switch flippable, so any red gate reverts to the prior engine for that
kind without touching the others. No milestone merges with a red conformance
suite. That is the entire safety property of the strangler.

---

## 8. Error taxonomy (unified, explicit)

- **`NestedWriteError`** (typed): all correlation/existence/orphan/fk-required/
  unsupported-combination failures. Carries `relationName`, `operation`, and the
  pinned message. Produced by the compiler (static) or by an `Assert` at run
  time (both backends — §4.3 makes the batch backend produce the *same* typed
  error, closing D1).
- **`NotFoundError`** (typed): top-level update/upsert target absent
  (`fetchRequiredUniqueRows` today) — unchanged.
- **`QueryEngineError`** (typed): capability/routing failures — batch driver
  reaching the sequential path (kept as defense-in-depth per `atomic-runner`),
  compound-generated-PK on batch, "cannot execute atomically."
- **`UniqueConstraintError` / DEADLOCK / SERIALIZATION**: pass through both
  backends unchanged so the race-retry wrapper classifies them (I: race
  compensation).

The *kind* → message mapping (`target` / `correlated` / `nested-write` / `orphan`
/ `fkRequired`) is owned by `AssertError.errorKind` and is the single source of
those strings — the behavior suites pin them and become backend-independent.

---

## 9. The one honestly-unresolved semantic edge (M2M filtered deleteMany)

The maps document a real, un-guardable gap (map-batch §5 last row,
`batch-many-to-many.ts:528` ponytail comment): filtered M2M `deleteMany` resolves
matching child PKs at plan time; rows connected *after* planning but *before*
execution are silently not deleted, because the filter cannot be re-evaluated
once junction rows are gone. This is not Axis A or B — it is a genuine limit of
a one-shot substrate: a *set* materialized at plan time is not a *premise* that a
guard can re-check.

My design does **not** magically fix this. It does two honest things:
1. Makes it a **single compiler decision** (`DeleteChildAndJunctions` with a
   plan-time-resolved PK set) with a **capability-gated typed error** when the
   parent PK is symbolic (batch), instead of a per-engine accident. So the two
   backends *agree*: sequential re-evaluates the filter live (correct); batch
   materializes and documents the staleness (best-effort) — and this difference
   is **declared in the IR** (the `Op` carries a `plan-time-materialized: true`
   flag the sequential backend ignores and the batch backend honors), not hidden.
2. Leaves a `ponytail:` note and a design-doc pointer so it is tracked debt, not
   rot.

If the maintainer wants *strict* parity here, the only correct fix is to forbid
filtered M2M deleteMany on batch-only drivers with a typed error (uniform
rejection, per invariant "lift uniformly or reject uniformly"). I recommend that
as the eventual resolution and flag it as an open decision, not a silent choice.

---

## 10. Why this is the *minimal* meaningful abstraction (defending against ceremony)

The maintainer fears under-abstraction more than over-abstraction, but rejects
ceremony equally. My defenses that this is not ceremony:

- **`Expr` has three constructors, not a general expression tree.** Arithmetic
  and predicates stay in adapter `Sql`. I refused a `BinOp`/`Predicate` node.
- **`Op` is a closed set that mirrors the existing switch statements** — it adds
  no operation the engines don't already have. The *resolved-branch* ops are the
  only new concept, and they exist to force single-sourcing of the exact
  decisions that today live in two places (the documented D8/D10 divergence
  surfaces). That is not speculative flexibility; it is the direct cause of
  shipped bugs.
- **Two backends, not an N-backend plugin system.** There are exactly two
  substrates in reality (interactive-tx and one-shot-batch); the interface has
  two implementations because there are two, not because "someone might add a
  third." If a third substrate ever appears, it implements `Backend`; until then
  there is no speculative seam beyond the one the reality already has.
- **No `interface` with a single implementation** survives: `Compiler` has one
  implementation (there is one semantics), `Backend` has two (there are two
  substrates). Both counts are dictated by reality, not by taste.
- **I delete more than I add.** The end state removes `create.ts`, `update.ts`,
  `upsert.ts`, `connect*.ts`, `set.ts`, `disconnect.ts`, `delete*.ts`,
  `relation-mutation.ts`, `batch-plan.ts`, `batch-relations.ts`,
  `batch-relation-links.ts`, `batch-many-to-many.ts`, `many-to-many.ts`, and the
  duplicated half of `fk.ts` — replacing ~6600 lines of doubled orchestration
  with one compiler + two thin backends + the already-shared builders. If the net
  line count does not drop substantially, the abstraction failed and I would say
  so.

---

## 11. Self-doubt: the weakest points, stated plainly

1. **The compile-both-arms cost (§3).** Making the compiler driver-free means it
   compiles both branch arms even though one is discarded. The tx engine today
   compiles lazily. This is pure CPU (no I/O), but on a deep
   `connectOrCreate`-heavy create it is measurable. If profiling shows it hurts,
   the escape hatch is to let the sequential backend request lazy arm-compilation
   via a callback — but that reintroduces a backend-specific compiler path, which
   is exactly the seam I am trying to remove. **This is the design's sharpest
   internal tension and I do not have a free answer.**

2. **Error-index mapping on the batch backend (§4.3).** Normalizing a batch abort
   back to the typed error depends on the driver telling us which statement
   failed. D1/Neon fail the whole batch atomically and may not report the index.
   The fallback (a typed-but-generic error) is strictly better than today's
   untyped one, but it is *not* full message parity in every driver case. I claim
   partial-but-typed is acceptable; a maintainer could reasonably want more.

3. **Moving plan-time reads into the batch backend (§3).** This keeps the
   compiler pure, but it means the staleness-guard emission and the probe read
   live in the backend, so the compiler cannot *see* the resolved branch. If a
   future feature needs the compiler to reason about the resolved value (not just
   both arms), this split fights it. I judged compiler purity worth more than that
   hypothetical; it is a bet.

4. **M2M filtered deleteMany (§9) is not solved, only made honest.** The IR
   carries a `plan-time-materialized` flag that the sequential backend ignores —
   which means the two backends *do* differ on exactly this construct, and I am
   choosing to *declare* that difference rather than eliminate it. That is a
   deliberate, documented divergence, which is the maintainer's stated fallback
   ("clear typed error / documented contract, never silent") — but it is still a
   divergence, and a purist reading of "identical observable behavior on every
   driver class" would reject it and demand uniform rejection instead. I lean
   toward eventual uniform rejection (§9) and flag it as an open call.

5. **The `col` Expr constructor (§2.1)** exists for exactly one case
   (computed-PK arithmetic). One-use constructors are a ceremony smell. I kept it
   because folding that case into `sym` would push arithmetic into the symbol
   origin and make `Symbol_` carry `Sql`, blurring the value/expression line I am
   trying to hold. It is the one place I chose a named constructor over a special
   case, and a reviewer might reasonably flip that call.
