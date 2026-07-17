# Engine Unification — Type-Driven Design

> **Historical proposal.** This document predates the shipped unified engine and the removal of the D1 REST driver. It is retained only as design history; `DESIGN.md`, current exports, and the conformance suites are authoritative.

> Design lens: **make illegal states unrepresentable.** The IR types carry the
> substrate-capability contract. The compiler produces the *most static plan
> possible*; a plan that cannot run on a batch driver must not typecheck as a
> batch plan. This document is a design, not a refactor diff — but every type it
> introduces is justified from the code that exists today, and anything that
> cannot be justified from first principles is left out and named as such.

Anchor: branch `prisma-parity`. Ground truth is the six maps in this directory
plus the spot-checked source (`semantic-plan.ts`, `batch-references.ts`,
`batch-updated-primary-keys.ts`, `values-builder.ts::buildScalarSqlValue`,
`relation-data-builder.ts::getFkDirection`, `errors/query.ts`).

---

## 0. The one-paragraph thesis

A nested write is **a topologically-ordered list of row mutations over expressions
of `literal | symbol | columnMatch`, where a symbol is always a primary key read
from a persisted row, every read-driven branch is decided once and pinned by a
guard on the premise it consumed, and the whole list commits atomically or aborts.**
That is *already* what both engines do — the tx engine resolves symbols by
`await`ing a result and resolves branches by reading mid-flight; the batch engine
resolves symbols with `storeLastInsertId`+`read()` subqueries and resolves
branches with plan-time reads + `assertions.exists/notExists`. The duplication
exists because the *decision to lower* (what SQL, what order, which guard) is
re-implemented per substrate instead of being computed once and handed to a
semantics-free backend. The design: **one write-only Plan IR** (`Insert | Update
| Delete | Read | Guard | Store` over `Expr`), **one semantic compiler** grown
directly from `semantic-plan.ts` + `getFkDirection` + `planRelationMutationSteps`,
and **two thin backends** (`InlineBackend` = today's tx path, `BatchBackend` =
today's batch path) that contain *no nested-write semantics* — only "how do I
realize an `Insert`/`Read`/`Guard`/`Store` on my substrate." The type system
carries the capability contract: the compiler emits a `Plan<Deferral>` whose
`Deferral` type parameter records *what kind of not-yet-known values the plan
contains*, and a `BatchBackend` only accepts a `Plan` whose deferrals are all
`BatchLowerable`. A compound-generated-PK plan produces a `Deferral` the batch
backend's `run` signature rejects **at compile time**, so "this cannot run on a
batch driver" is a type error in the engine's own source, not a runtime
`NestedWriteError` discovered per input.

---

## 1. Where I agree with the orchestrator's frame, and where I push back

### 1.1 Agree

- **"A nested write is a plan over uncertain state."** Confirmed by the code.
  The value crossing every phase boundary is always a PK read from a persisted
  row (map-tx-create §13.2, batch `BatchRecordRef.primaryKey`). The `Expr` /
  `symbol` abstraction is exactly a PK-or-scalar that may be literal or deferred.
- **"The engines differ ONLY in substrate."** Confirmed. `buildScalarSqlValue`
  *already* accepts `literal | Sql | BatchValueRef` and lowers all three
  (values-builder.ts:114-157). `many-to-many-utils.ts` builders are *already*
  substrate-agnostic. The tx/batch split in `fk.ts` is at the
  *assignment-orchestration* layer, not the value layer — the leaf is already
  unified. This is the single strongest evidence the frame is right.
- **"Branches must resolve at plan time with SQL guards … an explicit,
  documented staleness contract, not an accident."** Confirmed and this must be
  a *type-level* obligation (§5): a branch node that carries no guard must not
  typecheck.

### 1.2 Push back — three points

**(a) "A write-only Plan IR" undersells one necessity: the IR must contain
`Read` as a first-class node, not just `Insert/Update/Delete/Guard/Branch`.**
The orchestrator's candidate shape lists `Read` but frames the IR as "write-only".
It is not write-only: `connectOrCreate`, `upsert`, correlated-child-update-with-PK,
and M2M-filtered-deleteMany all *consume a read result to decide or to obtain an
identity*. The crucial design question is **when** the read runs, and that is a
*backend* choice, not an IR choice. So the IR must model a `Read` as "a query
whose result binds a symbol and/or decides a branch", and each backend decides
whether to execute it at plan-build time (batch) or interleaved (inline). I make
`Read` first-class and give it an explicit `bindsSymbol` / `decidesBranch` role.
This is a real correction: a "write-only IR with branches resolved before it is
built" would push the read-timing decision *out* of the unified layer and back
into two places — reintroducing the divergence.

**(b) The orchestrator frames "two thin semantics-free backends." I argue the
backends are not symmetric, and pretending they are is the trap.** The inline
backend is strictly more capable: it can resolve *any* symbol (read it back) and
branch on *any* read. The batch backend can only resolve symbols that lower to a
single `last_insert_rowid()` or a computed arithmetic store, and can only branch
if the premise is a re-checkable SQL predicate. The honest design does **not**
give them a shared `Backend` interface with identical signatures and hope both
implement it. It gives the *compiler* a `Capability` type parameter and makes the
batch backend's entry point demand `Plan<BatchLowerable>`. The inline backend
accepts `Plan<AnyDeferral>`. **This asymmetry is the capability contract, and
encoding it as a shared symmetric interface (the ceremony the maintainer warns
against) would be a lie the type system should refuse to tell.**

**(c) I reject porting `txCtx.createdRecords`/`generatedIds` and the tx nested
`withTransaction` re-entrancy.** These are tx-substrate artifacts (map-tx-create
§12.5, map-tx-update DIVERGENCE-RECURSION-ATOMICITY). The unified IR is a *flat
ordered statement list with an explicit symbol table*, exactly like the batch
`PlanState` already is. The inline backend runs that list in one transaction; it
does not recurse into nested transactions. This removes the "nested
withTransaction is a savepoint/no-op" assumption entirely — one atomicity model,
made explicit, as the maps demand (map-batch-planner I11, map-tx-update inv 1).

---

## 2. The core abstractions (each with its justification)

### 2.1 `Expr` — the value language

**This exists because** the value crossing every phase boundary is a PK (or
scalar) that is *either* a literal known at compile time *or* a symbol produced
during execution *or* a reference to a column of a correlated row — and
`buildScalarSqlValue` already lowers exactly this union today. The `Expr` type is
the smallest language that closes over the three shapes the code already threads.

```ts
/** A value that flows through the plan. Deliberately NOT a general expression
 *  language — no arbitrary arithmetic, no boolean algebra. It closes over
 *  exactly what nested writes thread today. IR-creep guard: adding a case here
 *  requires a caller in nested-writes that produces it. */
type Expr =
  | { readonly kind: "lit"; readonly value: ScalarValue }        // known at compile time
  | { readonly kind: "sym"; readonly sym: SymbolId }             // produced during execution
  | { readonly kind: "computed"; readonly sql: Sql };            // adapter.expressions.* over lits+syms (PK arithmetic only)

/** Symbols are opaque handles. The ONLY thing a symbol ever stands for is a
 *  primary-key value read from a persisted (or freshly-inserted) row. This is
 *  the map's invariant "the value crossing every phase boundary is always a
 *  primary key" made into a type. A symbol is never a whole row. */
type SymbolId = string & { readonly __brand: "SymbolId" };

/** A scalar the adapter can parameterize: string | number | bigint | boolean |
 *  Date | Uint8Array | null | Sql (a pre-built subquery, e.g. a connect
 *  target-PK subquery). Matches buildScalarSqlValue's accepted domain. */
type ScalarValue = string | number | bigint | boolean | Date | Uint8Array | null | Sql;
```

**What I deliberately leave out** (over-abstraction guard): no `Expr.and`,
`Expr.or`, `Expr.eq`. Correlation predicates are built by the *adapter clause
methods* already (`buildFkMatchCondition`, `combineWithParentCorrelation`,
`buildWhereUnique`) and handed to the IR as an opaque `Sql`. The IR does not
re-model WHERE clauses — that would be the "IR creep toward a general query
language" risk the orchestrator named. A `Match` in the IR is just a `Sql`
(produced by the existing correlation builders) plus the *field→Expr map* for any
symbols that must be lowered into it.

### 2.2 `Deferral` — the capability brand on a symbol's *provenance*

**This exists because** the batch substrate has a hard, enumerable set of things
it can and cannot resolve (map-batch-refs I1, I11): it can defer *exactly one*
auto-increment PK per INSERT (via `storeLastInsertId`), and it can defer a
*computed* PK (arithmetic store). It cannot defer a compound generated PK. The
inline substrate can defer *anything* (it reads the row back). If I make the
symbol *table* carry, per symbol, *how the value becomes known*, then a plan's
set of `Deferral`s is a precise statement of "what substrates can run this."

```ts
/** How a symbol's value becomes known during execution. This is the capability
 *  contract, per symbol. */
type Deferral =
  /** A single auto-increment column produced by the immediately-preceding
   *  INSERT. Batch lowers via storeLastInsertId; inline reads lastInsertId/
   *  RETURNING. Batch-lowerable. */
  | { readonly kind: "generatedAutoIncrement"; readonly producedBy: StmtRef }
  /** A PK value computed by adapter arithmetic over a known before-value.
   *  Batch lowers via a computed store; inline computes in JS or reads back.
   *  Batch-lowerable. */
  | { readonly kind: "computedScalar"; readonly sql: Sql }
  /** A value read from a persisted row by a plan Read node. Batch can lower
   *  this ONLY if the read runs at plan-build time (committed state) and the
   *  value is a scalar it can embed as a literal. If the read must observe an
   *  in-plan write, it is NOT batch-lowerable. */
  | { readonly kind: "readFromRow"; readonly read: StmtRef; readonly observesInPlanWrite: boolean }
  /** A generated value that is neither a single auto-increment nor computable:
   *  a compound generated PK, or a generated PK on a row the plan must reference
   *  before RETURNING is available on a non-returning batch driver. Inline-only. */
  | { readonly kind: "generatedOpaque"; readonly reason: string };

type BatchLowerable =
  | Extract<Deferral, { kind: "generatedAutoIncrement" }>
  | Extract<Deferral, { kind: "computedScalar" }>
  | (Extract<Deferral, { kind: "readFromRow" }> & { observesInPlanWrite: false });

type AnyDeferral = Deferral;
```

The **key type-level move**: the symbol table is `SymbolTable<D extends Deferral>`,
and a `Plan<D>` carries that same `D`. `Plan<BatchLowerable>` and
`Plan<AnyDeferral>` are *different types*. A backend that only accepts
`Plan<BatchLowerable>` cannot be handed a plan whose symbol table contains a
`generatedOpaque` deferral — **the mismatch is a compile error in the engine's
own code**, and the *sole* runtime job left is: at the compiler's narrowing gate,
prove a concrete `Plan<AnyDeferral>` is actually a `Plan<BatchLowerable>` (a
single `assertBatchLowerable` function, §6.3), which throws the typed
`NestedWriteError` the maps require (map-oracle inv 11, D3) when it isn't.

### 2.3 The Plan IR — six node kinds

**This exists because** every statement both engines emit today is one of exactly
six shapes. I enumerated them from the maps: INSERT (`appendInsert`,
`executeSimpleInsert`), UPDATE (`buildUpdate`, `updateCurrentRecord`,
`connectCreatedRecordToCurrentParent`), DELETE (`deleteChildrenAndJunctionRows`,
`appendJunctionDelete`), a read that binds a symbol or decides a branch
(`fetchOptional*`, `fetchRequired*`), a guard (`appendAssert*` /
`throwIfNoCorrelatedRowsAffected`), and a store (`storeLastInsertId`,
`appendUpdatedPrimaryKeyStores` — batch-only, elided by the inline backend).

```ts
type StmtRef = number & { readonly __brand: "StmtRef" };   // index into plan.stmts

type PlanNode<D extends Deferral> =
  | Insert<D> | Update<D> | Delete<D> | Read<D> | Guard | Store<D>;

interface Insert<D extends Deferral> {
  readonly kind: "insert";
  readonly model: Model<any>;
  readonly values: ReadonlyMap<string /*field*/, Expr>;  // scalar columns incl. derived FKs
  /** Symbols this INSERT PRODUCES (a generated PK). Empty for client-supplied PKs. */
  readonly produces: ReadonlyArray<{ readonly sym: SymbolId; readonly field: string }>;
  readonly skipDuplicates?: boolean;
}

interface Update<D extends Deferral> {
  readonly kind: "update";
  readonly model: Model<any>;
  readonly set: ReadonlyMap<string, Expr>;       // includes SET fk=NULL, SET fk=<parentPk>, computed PK
  readonly match: Match;                          // correlated WHERE, opaque Sql + symbol bindings
  /** true ⇒ zero rows affected is a correlation failure (see §5.2). */
  readonly requireAffected: false | { readonly errorKind: NotFoundKind; readonly relationName: string; readonly op: string };
}

interface Delete<D extends Deferral> {
  readonly kind: "delete";
  readonly model: Model<any>;
  readonly match: Match;
  readonly requireAffected: false | { readonly errorKind: NotFoundKind; readonly relationName: string; readonly op: string };
}

interface Read<D extends Deferral> {
  readonly kind: "read";
  readonly model: Model<any>;
  readonly match: Match;
  /** What this read is FOR. A read must do at least one of the two. */
  readonly binds?: ReadonlyArray<{ readonly sym: SymbolId; readonly field: string }>;
  readonly decides?: BranchId;
  /** Whether the read must observe writes emitted earlier in THIS plan.
   *  Drives Deferral.observesInPlanWrite and thus batch-lowerability. */
  readonly observesInPlanWrite: boolean;
}

interface Guard {
  readonly kind: "guard";
  readonly premise: Premise;                       // exists | notExists over a Match
  /** The typed error this guard's failure MUST surface as (error-parity, §7). */
  readonly onFail: { readonly errorKind: NotFoundKind | "assertion"; readonly relationName: string; readonly op: string };
}

interface Store<D extends Deferral> {              // materialized only by the batch backend
  readonly kind: "store";
  readonly sym: SymbolId;
  readonly source: { readonly kind: "lastInsertId" } | { readonly kind: "computed"; readonly sql: Sql };
}

interface Match {
  readonly sql: Sql;                               // built by existing correlation builders
  /** Symbols embedded in `sql` that the backend must lower before use. Empty
   *  when the Match references only literals/columns. */
  readonly symbols: ReadonlyArray<SymbolId>;
}

type Premise =
  | { readonly kind: "exists"; readonly match: Match }
  | { readonly kind: "notExists"; readonly match: Match };

type NotFoundKind = "target" | "correlated" | "nested-write";
type BranchId = string & { readonly __brand: "BranchId" };
```

### 2.4 `Plan<D>` — the compiled artifact

```ts
interface Plan<D extends Deferral> {
  readonly root: Model<any>;
  readonly stmts: ReadonlyArray<PlanNode<D>>;        // topologically ordered; index = StmtRef
  readonly symbols: SymbolTable<D>;                  // sym → { deferral: D; field; producedAt: StmtRef }
  readonly branches: ReadonlyMap<BranchId, BranchDecision>;  // decided at compile time
  /** The trailing read whose result is the operation's return value, and the
   *  offset math the callers need (map-batch I10, B.2). */
  readonly result: { readonly read: StmtRef; readonly select?: unknown };
  /** Whole-operation retryability (map-oracle inv 9). Computed once, from the
   *  input shape, at compile time — not per-backend. */
  readonly raceable: boolean;
}

interface SymbolTable<D extends Deferral> {
  get(sym: SymbolId): { readonly deferral: D; readonly field: string; readonly producedAt: StmtRef };
  readonly all: ReadonlyArray<SymbolId>;
}

/** Branches are DECIDED at compile time (both engines already decide them from a
 *  read — inline from a mid-flight read, batch from a plan-time read). The IR
 *  records the decision AND the guard that pins its premise. There is no
 *  runtime-branch node: a plan is a straight-line list. This is the key
 *  simplification — see §5. */
interface BranchDecision {
  readonly taken: "a" | "b";
  readonly guard: Guard;                             // MANDATORY — see §5, type-enforced by construction
}
```

**Why a straight-line list and not a branch tree** (the single biggest design
decision): both engines *already* collapse branches to straight-line by the time
they emit SQL. The batch engine reads at plan time and bakes one branch +
a guard. The inline engine reads mid-flight and then also runs a straight-line
sequence for the chosen branch. Neither engine emits a conditional statement.
So the IR has **no `Branch` node** — it has a `BranchDecision` that was made
during compilation, recording which arm was compiled and the mandatory guard.
The compiler is *async* and performs the deciding reads itself (exactly as
`prepareNestedWriteBatch` is already async and reads at plan time). This is not
new capability — it is lifting the batch engine's existing "read-then-bake"
discipline to be the *only* discipline, and letting the inline backend re-decide
via retry (§8) rather than via a conditional node. See §5.4 for why this is safe
and where it costs something (the honest self-doubt).

---

## 3. Architecture: compiler + two backends

```
                    args (validated)
                        │
      ┌─────────────────▼──────────────────┐
      │           COMPILER (async)          │   grown from semantic-plan.ts,
      │  · separateData / parseRelation…    │   getFkDirection, planRelation-
      │  · getFkDirection (THE direction    │   MutationSteps, planExisting-
      │    oracle — unchanged, shared)      │   UpsertBranch, dedupe, m2m combo
      │  · planRelationMutationSteps order  │   assertions — all reused verbatim
      │  · decides branches via reads       │   as the ONE semantic core.
      │    (ReadPort, injected)             │
      │  · emits Plan<AnyDeferral>          │
      └─────────────────┬──────────────────┘
                        │  Plan<AnyDeferral>
             ┌──────────┴───────────┐
             │ narrowing gate       │  assertBatchLowerable(plan)
             │ (only on batch path) │  → Plan<BatchLowerable> | throw NestedWriteError
             └──────────┬───────────┘
        ┌───────────────┴────────────────┐
        ▼                                 ▼
 InlineBackend.run(                BatchBackend.run(
   plan: Plan<AnyDeferral>,          plan: Plan<BatchLowerable>,   ← type-enforced
   driver: TxDriver )                driver: BatchDriver )
   · withTransaction                 · lower to Sql[] + setup/cleanup
   · execute stmts in order,         · storeLastInsertId / read() subqueries
     resolving syms by reading        · guards → adapter.assertions
     RETURNING/lastInsertId           · one _executeBatch
   · guards → read+throw typed        · guards fail → normalize to typed error (§7)
   · Store nodes: no-op
```

### 3.1 The compiler's injected `ReadPort` — the one seam that lets it decide branches without knowing the substrate

**This exists because** the compiler must *read* to decide `connectOrCreate`
found/missing and `upsert` exists/missing — and today that read is done through
the live `driver` at plan time (batch) or mid-transaction (inline). To keep the
compiler substrate-free, it reads through an injected `ReadPort`:

```ts
interface ReadPort {
  /** SELECT * ... WHERE <match> LIMIT 1, translated to field names, or undefined.
   *  Wraps the existing record-access.ts fetchOptional*/fetchRequired* helpers. */
  fetchOptional(model: Model<any>, match: Sql): Promise<Row | undefined>;
  fetchRequired(model: Model<any>, match: Sql, err: RecordNotFoundSpec): Promise<Row>;
}
```

- **Batch path**: `ReadPort` reads *committed state through the driver at compile
  time* — identical to today's `prepareNestedWriteBatch` behavior. Every branch
  the compiler decides this way MUST attach a guard (the type in §5 enforces it),
  because the plan runs later.
- **Inline path**: this is the subtle part. The inline backend also compiles the
  plan *first* (to get one ordering + one symbol table), but the branch reads
  must observe in-transaction writes for read-after-write cases. **Resolution
  (see §5.4):** the compiler runs branch-deciding reads through a `ReadPort` that,
  on the inline path, reads *inside the open transaction* — so the compile step
  and the transaction are interleaved for the inline backend. Concretely: the
  inline backend opens the transaction, then drives compilation with a
  tx-scoped `ReadPort`, then executes the resulting straight-line plan in the
  same tx. The guard nodes become cheap no-ops on the inline backend (the read
  it just did already proved the premise, in the same tx, under `FOR UPDATE`),
  OR are executed as the `throwIfNoCorrelatedRowsAffected`-style checks where the
  premise is "rows affected". This preserves the inline engine's self-visibility
  (map-batch D3) without a conditional IR node.

This is the crux and I want to be explicit about the cost: **on the inline path,
compilation and execution share one transaction and are not two clean phases.**
That is unavoidable — it is exactly the capability that makes the inline
substrate more powerful (read-after-write). The design contains the messiness in
*one place* (the tx-scoped `ReadPort` + the inline backend's "compile-inside-tx"
loop) instead of smearing it across twelve files. See §5.4 and the self-doubt.

---

## 4. How each mutation kind compiles (the acceptance-critical section)

Notation: `P` = parent, `C` = child, `dir = getFkDirection(ctx, rel)`.
`parentHoldsFk = dir.holdsFK`. Ordering law (I4, map-oracle C.0) is realized by
the compiler emitting `currentHoldsFk` steps *before* the parent `Insert` and
`relatedHoldsFk`/m2m steps *after*. `planRelationMutationSteps` gives the fixed
intra-relation order (I5). **All of this is `splitRelationMutationsByFk` +
`planRelationMutationSteps` reused verbatim** — the compiler's job is to turn each
step into `PlanNode`s, not to re-derive order.

### 4.1 `create` (top-level and nested)
1. `separateData`; `assertNoPlannedNestedMutationExecution(relations, "create")`
   (I6, reused).
2. `splitRelationMutationsByFk`.
3. For each `currentHoldsFk` rel, in step order: compile it (create/connect/
   connectOrCreate — §4.3/4.4/4.5), obtaining an `Expr` for the child PK; write
   that `Expr` into `values` of the parent `Insert`. (before-parent)
4. Emit parent `Insert`. Its PK: if client-supplied → `lit`; if single
   auto-increment → allocate `sym` with `Deferral.generatedAutoIncrement`
   (`produces`), and (batch backend) a `Store{lastInsertId}` immediately after
   (§4.11); if compound-generated → `Deferral.generatedOpaque` (inline-only).
5. For each `relatedHoldsFk`/m2m rel, in step order: compile it, threading the
   parent PK `Expr` into child FK / junction columns. (after-parent)
6. `result` = trailing read by the parent PK where (select/include → refetch;
   else scalars-only per Prisma parity, map-oracle inv 8).

### 4.2 `createMany` (nested, related-holds-FK only)
Emit a single multi-row `Insert` with `skipDuplicates`; every row's FK column =
parent PK `Expr` (I4). `parentHoldsFk` ⇒ compile-time `NestedWriteError` (reused
guard). Never legal top-level here (that is a different operation).

### 4.3 `connect`
- `parentHoldsFk`: emit a `Read`(fetchRequired, kind `target`) that *binds* a
  symbol to the target PK, then write that symbol into the parent's FK (before
  parent, timing "before") — OR, when the target PK is directly given by the
  unique where, skip the read and use a `lit`/`Sql` subquery `Expr`
  (`buildConnectFkValues`). Missing target → `target`-kind not-found (the `Read`'s
  `err` on inline; a `Guard{exists, onFail:target}` on batch).
- `relatedHoldsFk`: emit `Guard{exists, target}` (target must exist) + an
  `Update{ set: fk=parentPk, match: childUnique, requireAffected: correlated }`.
  Missing → `correlated`-kind (rows-affected 0). **This preserves the
  direction-dependent error kind** (map-tx-create §5, inv 6): parent-holds-FK
  connect throws `target`, child-holds-FK throws `correlated`.

### 4.4 `connectOrCreate`
Inputs deduped by the shared `dedupeConnectOrCreateInputs` (I7 — reused; and see
§9 for making first-create-wins first-class). Compiler runs
`ReadPort.fetchOptional(target unique)` → decides:
- **found** → `BranchDecision{taken:a, guard: Guard{exists, onFail:target}}`, then
  compile as `connect` (existing row untouched — create payload ignored).
- **missing** → `BranchDecision{taken:b, guard: Guard{notExists,…}}`, then compile
  as `create` with the same timing.

The `guard` field is **mandatory in the type** — you cannot construct a
`BranchDecision` without it (§5). The compiler records `Deferral.readFromRow` with
`observesInPlanWrite=false` (it read committed/target state, not an in-plan write),
so this branch is `BatchLowerable`.

### 4.5 `upsert` (top-level)
`ReadPort.fetchRequired?`/`fetchOptional` by `where`:
- **exists** → run `targetWhere`/`setWhere` probe reads if present →
  `planExistingUpsertBranch(...)` (reused verbatim, semantic-plan.ts:232) →
  `BranchDecision`. The branch's `NestedWriteGuard` (`uniqueExists` /
  `uniqueWithWhere*`) maps to a `Guard` node via a single `lowerGuard` helper
  (replaces `appendPlanGuard`). Skipped branches emit only the guard + return
  `pkWhere` (no update). Update branch: scalar `Update`, PK-change tracking
  (§4.10), then compile nested relations.
- **missing** → `Guard{notExists}` + compile `create` (with
  `assertNoPlannedNestedMutationExecution(create,"upsertCreate")`, reused).

`raceable=true` always for upsert (computed at compile time, §8).

### 4.6 `upsert` (nested, to-one and to-many)
Same branch model as `executeToOneRelationUpsert`/`executeToManyRelationUpsert`
(map-tx-update §2): to-one located by `buildFkMatchCondition`; to-many located by
`combineWithParentCorrelation`, with the extra uncorrelated-exists probe that
throws `correlated` if the unique key belongs to another parent. Compiles to a
branch (update vs create) + guard, plus the FK-direction timing for the create
arm (`before`+`connectCreatedRecordToCurrentParent` when parentHoldsFk).

### 4.7 `disconnect`
- `parentHoldsFk`: `assertFkCanBeSetNull` (reused; required-FK → compile-time
  `NestedWriteError`, inv 6). `Update{ set: fk=NULL, match: parentPk,
  requireAffected: correlated }`. The in-memory `parentData[fk]=null` mutation
  becomes: the symbol for that FK is *rebound to `lit null`* in the symbol table
  for downstream nodes (map-tx-update inv 14 — "downstream correlation observes
  post-mutation FK state" expressed via the symbol table, not a JS mutation).
- `relatedHoldsFk`: `disconnect:true` → `Update{fk=NULL, match: fkMatch,
  requireAffected:false}` (lax); explicit → `Update{…, match: correlated,
  requireAffected: correlated}` (strict). Asymmetry preserved (map-tx-update §5.2).

### 4.8 `delete` / `deleteMany`
- `delete` (parentHoldsFk): null parent FK *before* child delete (I4), then
  `Delete`. `delete:true` lax; explicit strict (`requireAffected: correlated`).
- `deleteMany`: `Delete{ match: parentFk ∧ filter, requireAffected:false }`
  (set-based, never rows-required, to-one rejected — reused guards).

### 4.9 `set`
Fixed order (map-tx-update §4): resolve/guard all target existence, compute
`buildDepartingRowsCondition` (shared, incl. `COALESCE(...,FALSE)` — inv 8),
disconnect departing (required-FK → `Guard{notExists departing, onFail:
assertion}`; nullable → `Update{fk=NULL, departing}`), then connect each member.
**Divergence resolution (D6/map-shared D.5): pick ONE order for the DELETE-vs-check
and the skip-already-connected question**, and lower it identically:
- I choose the **batch order** (delete/guard/connect unconditionally) as the
  canonical IR, because it is straight-line and substrate-neutral. The tx
  "skip-already-connected" optimization (map-tx-update §4.4) exists only to dodge
  MySQL's 0-affected-rows-on-noop tripping a per-row `requireAffected`. In the IR
  the member `Update`s carry `requireAffected:false` for set-connect (connecting
  an already-connected row is a no-op, not a correlation failure — this is what
  the batch engine already does), so the skip is *unnecessary*, not merely
  optimized away. This removes D6 as a divergence entirely: one lowering, correct
  on both substrates, no per-engine special case. (Cost: the inline path issues a
  few redundant no-op UPDATEs it used to skip — a statement-count regression on
  the inline side, not a correctness or observable-state change.)

### 4.10 `update` (nested, scalars-before-relations, PK-change)
Order (inv 4): `Read` before-image (binds child identity symbols), scalar
`Update`, compute post-update PK. PK change:
- literal/`{set}` → `lit` new PK.
- numeric op → `Expr.computed` via `adapter.expressions.*`, and a symbol with
  `Deferral.computedScalar`; batch backend emits `Store{computed}` after the
  `Update` (`appendUpdatedPrimaryKeyStores`, reused). Inline backend reads the
  updated row back (or computes in JS) — same symbol, resolved differently.
- non-literal/array PK op → compile-time `NestedWriteError` (reused
  `assertSafePrimaryKeyUpdateValue`).

**D4 resolution** (map-oracle D4 — batch overlays only PK, inline re-SELECTs): the
IR makes the after-image an explicit `Read` node when *any* downstream correlation
needs a non-PK column, and a synthesized `{...before, ...updatedPk}` overlay
otherwise. The compiler can see statically whether a non-PK column is referenced
downstream (it built those references), so it emits the `Read` iff needed — same
decision on both backends, closing the latent divergence.

### 4.11 Generated-id propagation (the fragile ordering, made structural)
`Insert.produces` names the symbol; the batch backend, when lowering, emits the
`Store{lastInsertId}` **as the immediately-following statement** — not by
convention but because the lowering function `lowerInsert` returns
`[insertSql, ...storeSqlForProducedSyms]` as an atomic pair. There is no way to
interleave another INSERT between them because the backend materializes them
together (map-batch-refs §5.2, the "silent-corruption bug class" is eliminated by
construction, not discipline).

### 4.12 M2M (all kinds)
`getFkDirection` throws on m2m (inv, B.3) — so the compiler routes m2m to a
dedicated `compileManyToMany` that uses `getManyToManyJoinInfo` and the
`many-to-many-utils.ts` builders (already substrate-agnostic — PART E). Every
junction value flows as an `Expr` (parent PK possibly a `sym`), lowered by
`buildScalarSqlValue`. Each step compiles to junction `Insert`/`Delete` +
child `Insert`/`Update`/`Delete` + guards, in the junction-safe order (junction
before child on delete; child before junction on create — I4). The one **inline
branch decision surface** here (M2M upsert, map-shared D.10, currently duplicated
inline in both engines) is compiled once through the shared branch machinery,
eliminating the highest divergence-risk duplication.

**The M2M filtered-deleteMany gap** (map-batch §5 last row; the un-guarded
plan-time read): I do **not** paper over it. The compiler materializes the target
PK set via `fetchConnectedTargetPks` and records it as a
`Deferral.readFromRow{observesInPlanWrite:false}` bound to a *fixed literal list*.
On the batch backend this is the documented staleness gap (rows connected after
planning are missed). **Type-driven improvement:** I add a `Plan`-level flag
`hasUnguardedPlanTimeSet: boolean`, and the `assertBatchLowerable` gate emits a
*structured warning capability* (not a throw — it is Prisma-parity-legal, just
racy) OR, preferably, the compiler lifts it by emitting a guard that re-checks
"no additional connected rows match the filter" — a `Guard{notExists, match:
filter ∧ membership ∧ target NOT IN (materialized set)}`. This *closes the gap*
uniformly (both backends), removing the one silent divergence, at the cost of one
extra guard SELECT. If the maintainer prefers to keep the documented gap, the flag
makes it *explicit in the type* rather than a `ponytail:` comment. I recommend
closing it; see §9.

### 4.13 `assertManyToManyStepCombinationIsSupported` (deleteMany + create/…)
Reused verbatim as a compile-time `NestedWriteError` (I8). Note: once §4.12's
guard closes the ordering gap, this restriction *could* be lifted, because the
combination would be well-defined (the compiler emits a fixed order and guards
it). I keep the error for the initial milestones and revisit it as a *separate,
later* well-definedness proof (the maps flag it as "defended, not reconciled" —
lifting it is out of scope for unification correctness and would need its own
conformance scenarios).

---

## 5. The branch-resolution and staleness contract, as types

### 5.1 The core rule
> **Every branch decided from a read must carry a guard that re-asserts the read's
> premise at the point the branch's writes execute.** (map-batch I2, map-tx-update
> inv 9, the maintainer's "never silent divergence".)

I make this a *construction invariant*, not a checked one: a `BranchDecision`
**cannot be built without a `Guard`** (the field is required, non-optional). The
only constructor is:

```ts
function decideBranch(read: Row | undefined, spec: BranchSpec): BranchDecision {
  // guard is chosen from spec by which arm was taken — never optional, never omitted.
  return read
    ? { taken: "a", guard: existsGuard(spec) }
    : { taken: "b", guard: notExistsGuard(spec) };
}
```

There is no code path that produces a guardless branch. The batch backend
*materializes* the guard as an `adapter.assertions` statement; the inline backend
*materializes* it as either a no-op (the deciding read was in the same tx under
`FOR UPDATE`, so the premise held and holds) or a `requireAffected`/re-read check
where the premise is "rows affected." **The guard is always present in the IR;
the two backends differ only in how they realize a semantic no-op-or-abort.**

### 5.2 `requireAffected` — the correlated-existence contract
`Update`/`Delete` carry `requireAffected`. `false` = set-based/lax (deleteMany,
disconnect:true, set-connect). Populated = "0 rows ⇒ typed not-found of this
kind." Inline backend checks `rowCount==0` (`throwIfNoCorrelatedRowsAffected`);
batch backend emits a paired `Guard{exists}` *before* the write (map-tx-update
DIVERGENCE-DELETE/DISCONNECT-STRICTNESS). Same contract, one field, two
realizations.

### 5.3 The staleness surface is enumerable and typed
Because every branch guard is mandatory and every `Read` records
`observesInPlanWrite`, the set of staleness surfaces is *exactly* the set of
`Read` nodes with `observesInPlanWrite=false` that feed a `BranchDecision` — the
compiler can enumerate them, and `assertBatchLowerable` verifies each has its
guard. This is the "explicit, documented staleness contract" upgraded from prose
to a type obligation.

### 5.4 Honest cost of the straight-line-plus-guard model
The inline engine today branches at runtime and never emits a guard. My model
makes the *compiler* decide the branch (via the tx-scoped `ReadPort`) and then run
a guardless-in-practice straight line. **This means the inline backend's
compilation must happen inside the transaction** (§3.1), because the deciding read
must see prior in-tx writes (e.g. an upsert-existing branch after a sibling create
in the same op). So "compile once, run on either backend" is *not* literally two
clean phases for the inline path — it is "open tx, compile-while-executing-reads,
run." I judged this acceptable because: (a) it is exactly what the tx engine does
today (interleave reads and writes); (b) it confines the interleaving to the
inline backend's driver loop; (c) the *semantics* (which node, which order, which
guard) still come from the one compiler. The alternative — a `Branch` node with
two subplans and a runtime chooser — reintroduces a conditional IR the batch
backend cannot execute, and would need a whole second lowering story. I chose the
straight-line model as the smaller, more honest abstraction. **This is the design's
weakest seam and I name it as such in the self-doubt.**

---

## 6. Backend contracts

### 6.1 `InlineBackend` (today's tx path)
```ts
interface InlineBackend {
  run<D extends Deferral>(compile: Compiler, driver: TxDriver, args: OpArgs): Promise<Row>;
}
```
- Opens `withTransaction` (one level, no nesting — map-tx-update DIVERGENCE-NEST
  removed).
- Drives `compile` with a **tx-scoped `ReadPort`** (reads see in-tx writes;
  upsert uses `FOR UPDATE`).
- Executes `stmts` in order. `Insert` → run, read back generated PK (RETURNING or
  lastInsertId) into the symbol. `Update`/`Delete` → run; `requireAffected` →
  `throwIfNoCorrelatedRowsAffected`. `Read` → run (already done during compile for
  branch reads; re-reads only for after-image identity). `Guard` → no-op (premise
  held in-tx) or realized as the `requireAffected` check. `Store` → **no-op**.
- Accepts `Plan<AnyDeferral>` — it can resolve any symbol.

### 6.2 `BatchBackend` (today's batch path)
```ts
interface BatchBackend {
  run(plan: Plan<BatchLowerable>, driver: BatchDriver): Promise<Row>;   // ← type gate
  prepare(plan: Plan<BatchLowerable>, ctx: BatchPreparationContext): PreparedBatchOperation<Row>;
}
```
- **Signature demands `Plan<BatchLowerable>`.** A `Plan<AnyDeferral>` does not
  typecheck here. The only way to obtain one is `assertBatchLowerable` (§6.3).
- Lowers each node to `Sql` via the adapter (Golden Rule, I9): `Insert`→`buildCreate`
  +`storeLastInsertId` for produced syms; `Update`/`Delete`→`buildUpdate`/
  `buildDelete`; `Guard`→`adapter.assertions.exists/notExists`; `Store`→
  `batchRefs.store`; symbols in any `Expr`/`Match`→`batchRefs.read()` via
  `buildScalarSqlValue` (unchanged).
- Lazy setup/cleanup exactly as `BatchReferenceStore.initialize` (I only if a sym
  is allocated — inv, map-batch I10/§10 lazy).
- Emits `PreparedBatchOperation` with `setup/cleanup/parseResult` and the
  result-window offset (I10, B.2) — unchanged upward seam.

### 6.3 The narrowing gate — the single runtime capability check
```ts
/** The ONE place the batch capability contract is checked at runtime. It proves a
 *  Plan<AnyDeferral> is a Plan<BatchLowerable>, or throws the typed error the
 *  maps require. After this returns, the type system guarantees the batch backend
 *  can lower every node — no per-node "can I lower this?" scattered anywhere. */
function assertBatchLowerable(plan: Plan<AnyDeferral>): Plan<BatchLowerable> {
  for (const sym of plan.symbols.all) {
    const d = plan.symbols.get(sym).deferral;
    if (d.kind === "generatedOpaque")
      throw new NestedWriteError(
        `Batch-only nested write cannot propagate ${d.reason}.`, plan.root.name);
    if (d.kind === "readFromRow" && d.observesInPlanWrite)
      throw new NestedWriteError(
        `Batch-only nested write requires a value only observable mid-transaction.`,
        plan.root.name);
  }
  // every BranchDecision.guard is mandatory by construction (§5.1) — nothing to check.
  return plan as Plan<BatchLowerable>;   // the ONLY narrowing assertion in the codebase
}
```
This is the whole D3/I1/inv-11 capability gap, in one function, producing the one
error type. Compound-generated-PK and mid-tx-only values are the only two ways to
fail it, and both are `generatedOpaque`/`observesInPlanWrite` by construction.

### 6.4 Dispatch (unchanged upward seams — B.1–B.3, inv 10)
`runNestedWriteOperation` stays the fork: batch-only driver → compile →
`assertBatchLowerable` → `BatchBackend`; else → `InlineBackend`. `atomic-runner`'s
"batch driver must never reach tx path" throw stays as defense-in-depth.
`hasNestedWrites`/`prepare`/`prepareBatch` gating in `createPreparedOperation`
unchanged. `prepareBatch → undefined` when a driver is not atomic (d1-http)
unchanged.

---

## 7. Error taxonomy (parity, both backends → same typed error)

`NotFoundKind = "target" | "correlated" | "nested-write"` is carried *on the IR
node* (`Guard.onFail`, `Update/Delete.requireAffected.errorKind`). This is the
fix for D1 / map-shared F.4 (today batch raises a generic
`NestedWriteAssertionError`, inline raises `NestedWriteError` with the specific
message):

- The **inline** backend throws `recordNotFoundError({kind, relationName, op})`
  (reused) directly from `requireAffected`/`fetchRequired`.
- The **batch** backend's guard failure surfaces as a raw dialect error. The
  driver error-mapper already normalizes it to `NestedWriteAssertionError`.
  **Change:** carry `Guard.onFail` into the guard's SQL as a recognizable tag
  (e.g. an alias/comment the mapper reads) OR — simpler and my recommendation —
  have `BatchBackend.run` wrap `_executeBatch` in a catch that, on
  `NestedWriteAssertionError`, rethrows `recordNotFoundError` using the
  `onFail` of the *first guard whose premise now fails* (a cheap post-hoc
  re-probe, only on the error path). This gives **identical typed errors and
  messages across substrates** — collapsing D1.
  - The behavior suites currently branch on `driver.supportsTransactions` to
    assert *different* messages (map-oracle D1). Those assertions get *simplified*
    (one expected message) — a deliberate, documented behavior change that
    *increases* parity, which the maintainer's values endorse ("identical
    observable behavior … or a clear typed error"). This is the one place the
    design *changes* an observable behavior, and it changes it toward parity.

`raceable` (inv 9) is computed at compile time from the input shape
(`containsRaceableNestedWrite` reused) and stored on the `Plan`. The retry
wrapper (`executeWithNestedWrites`) stays *above* both backends and consults
`plan.raceable` + `isWriteRaceLoserError`. The batch backend's lost-race signal
(a real `UniqueConstraintError` from the INSERT, or a `notExists`-guard abort)
must remain in `isWriteRaceLoserError`'s accepted set (map-oracle D7 — preserved).

---

## 8. Race-retry and atomicity — one model

- **Atomicity**: the plan is one ordered list; the inline backend runs it in one
  `withTransaction`, the batch backend in one `_executeBatch`. All-or-nothing on
  both (inv 2, I11). No nested transactions, no partial commit.
- **Retry**: `executeWithNestedWrites` catches, checks `plan.raceable &&
  isWriteRaceLoserError`, **recompiles and reruns once** (the recompile re-reads
  and now takes the update/found branch — this is why compilation is cheap and
  repeatable, and why branches are decided by reads rather than baked into the
  input). This unifies map-tx-update §7 (inline retry) and gives the batch
  backend the retry it lacks today (map-batch D2) — the same wrapper now covers
  both because it sits above the compiler. **This closes the latent parity gap
  the maps flag** (batch has no retry today; concurrent create-of-same-unique
  aborts instead of converging). The retry is "recompile+rerun", uniform.

---

## 9. Divergences: resolved, preserved, or deliberately deferred

| Divergence (map ref) | Resolution |
|---|---|
| D1 error type/message | **Resolved** — `onFail` on IR nodes; batch re-maps to typed `recordNotFoundError` (§7). Behavior suites lose the `supportsTransactions` branch. |
| D2/D3 branch timing, value substrate | **Absorbed into the model** — one compiler decides branches via `ReadPort`; symbols carry `Deferral`; backends realize them (§2.2, §5). |
| D3 capability gap (compound/opaque PK) | **Preserved as a typed error, now type-enforced** — `assertBatchLowerable` (§6.3), one throw site (inv 11). |
| D4 updated-parent refetch | **Resolved** — compiler emits an after-image `Read` iff a non-PK column is referenced downstream (§4.10). |
| D6 set skip-already-connected | **Resolved by removal** — set-connect `Update`s carry `requireAffected:false`; the skip is unnecessary (§4.9). |
| M2M filtered-deleteMany silent gap (map-batch §5) | **Recommended: closed** by an extra `notExists` guard over the filter (§4.12). Falls back to an explicit `Plan.hasUnguardedPlanTimeSet` flag if the maintainer keeps the gap. |
| connectOrCreate dedupe (D8) | **Preserved, promoted to first-class** — first-create-wins is a documented compiler rule; the dedupe stays but is now *the* rule, not a shim (§4.4). Once the M2M gap is closed and combos are well-defined, the dedupe remains as the semantic rule (not an engine-alignment patch). |
| M2M deleteMany+create combo (I8) | **Preserved** for now; lifting it is a separate, later well-definedness task (§4.13). |
| Race retry (map-batch D2) | **Resolved** — one retry wrapper above the compiler, covers batch (§8). |
| Nested `withTransaction` re-entrancy (map-tx-update DIVERGENCE-NEST) | **Removed** — flat plan, one transaction (§3). |
| `txCtx.createdRecords`/`generatedIds` dead bookkeeping | **Removed** — symbol table replaces it (§1.2c). |
| Inline connect fast-path / `canUseSubqueryOnly` (D5) | **Preserved as a compiler post-pass** — an optional peephole that collapses a single before-parent connect into the parent `Insert.values` as a `Sql` subquery `Expr`. Pure optimization; both backends benefit; not load-bearing. |

---

## 10. What I deliberately did NOT abstract (ceremony guard)

- **No `Backend` interface with two implementations sharing one symmetric
  signature.** The backends have *different* input types (`Plan<AnyDeferral>` vs
  `Plan<BatchLowerable>`). A shared interface would erase the capability contract
  the whole design exists to encode. (This is the maintainer's "interfaces with
  one implementation / speculative flexibility" prohibition applied honestly:
  the asymmetry is real, so the types are asymmetric.)
- **No general expression language.** `Expr` has three cases, all present in
  today's code. WHERE/correlation stays opaque `Sql` from existing builders. This
  is the explicit guard against "IR creep toward a general query language."
- **No `Branch` IR node.** Branches are compile-time decisions + mandatory guards
  (§5). The batch substrate cannot execute a conditional, and inventing one only
  to strip it before lowering is pure ceremony.
- **No new adapter primitives.** `batchRefs` (6 methods), `assertions` (2),
  `expressions.*`, `literals.*` all already exist and are exactly the lowering
  surface (I9). The design adds *zero* to the adapter contract.
- **No rewrite of `getFkDirection`, `planRelationMutationSteps`,
  `planExistingUpsertBranch`, `separateData`, `record-access`, `fk.ts`
  correlation builders, `many-to-many-utils`.** These are the semantic core and
  are reused verbatim. The compiler is *assembled from them*; it does not replace
  them. (This is why the migration is incremental — §11.)

---

## 11. Migration plan — per-milestone acceptance gates

The oracle (`nested-write-conformance.test.ts` on `BatchOnlyPGliteDriver` +
`tests/drivers/*-behavior.ts`) must be green at **every** milestone. Strategy:
introduce the IR + backends *behind* the existing dispatch, migrate one mutation
kind at a time, deleting the old dual implementation only after its kind is green
through the IR on both engines.

**M0 — Oracle hardening (prerequisite, no engine change).**
Add the missing M2M scenarios to `nested-write-conformance.test.ts` (map-shared
PART G names them: connect, create-through-junction, set, disconnect, delete,
deleteMany, upsert connected/uncorrelated/create, self-referential delete). This
gives the head-to-head tx-vs-batch oracle real M2M coverage *before* touching M2M.
Gate: new scenarios pass on both existing engines (they must — this is pure
coverage). **No IR yet.**

**M1 — IR + backends skeleton, `create`-only, behind a flag.**
Land `Expr`, `Deferral`, `PlanNode`, `Plan`, `SymbolTable`, `InlineBackend`,
`BatchBackend`, `assertBatchLowerable`, the compiler for **`create` +
`createMany` + `connect` (both directions)** only. Route `create` through the IR
*only when an env/opt flag is set*; default stays the old path. Gate: with the
flag on, all `create`-family conformance + behavior scenarios green on both
engines; with it off, byte-identical to `main`. **Delete nothing yet.**

**M2 — `connectOrCreate` + top-level/nested `upsert` + branch/guard machinery.**
Implement `ReadPort` (tx-scoped for inline, plan-time for batch), `decideBranch`,
`lowerGuard`, `planExistingUpsertBranch` reuse, `raceable`, and the retry wrapper
consulting `plan.raceable`. Route these kinds through the IR under the flag. Gate:
all connectOrCreate/upsert conformance + advanced-behavior scenarios green on both
engines (including targetWhere/setWhere skip cases); race-retry behavior
(single-threaded oracle) unchanged.

**M3 — `update`/`updateMany`/`delete`/`deleteMany`/`disconnect`/`set`.**
Includes PK-change tracking (§4.10), `requireAffected` (§5.2), the D4 after-image
`Read` decision, and the D6 set-connect `requireAffected:false` resolution. Gate:
all correlation/parent-ownership scenarios green; the D6 "no-op set succeeds",
"orphan reject", "partial" cases green; **error-parity milestone** — flip the
behavior suites' D1 `supportsTransactions` branch to a single expected message and
confirm both engines produce it (§7). This is the one deliberate behavior change;
it lands here, isolated, reviewable.

**M4 — M2M (all kinds) through `compileManyToMany`.**
Reuse `many-to-many-utils`. Implement the M2M-upsert branch once (kills the
inline duplication, map-shared D.10). Decide the filtered-deleteMany gap: land the
extra guard (§4.12, recommended) or the `hasUnguardedPlanTimeSet` flag. Gate: the
M0 M2M conformance scenarios green head-to-head on both engines; per-driver
`many-to-many-behavior.ts` green on every driver class (pglite, sqlite3, mysql2,
libsql, and the batch-only d1/neon paths if CI covers them). If the guard is
landed, add a concurrency scenario proving the gap is closed.

**M5 — Cutover + deletion.**
Make the IR path the default; delete `create.ts`, `update.ts`, `upsert.ts`,
`connect.ts`, `connect-or-create.ts`, `set.ts`, `disconnect.ts`, `delete.ts`,
`delete-many.ts`, `update-many.ts`, `many-to-many.ts`, `relation-mutation.ts`,
`batch-plan.ts`, `batch-relations.ts`, `batch-relation-links.ts`,
`batch-references.ts` (folded into the symbol table), `batch-many-to-many.ts`,
`batch-updated-primary-keys.ts` — replacing ~6,600 lines with the compiler +
two backends + IR types. Keep `semantic-plan.ts`, `fk.ts`, `record-access.ts`,
`many-to-many-utils.ts`, `assertions.ts` (now called by the backends' lowering,
not by two engines). Gate: full suite green with the flag removed; line count
down materially; `assertBatchLowerable` is the only narrowing assertion in the
tree; `grep` finds no second implementation of any mutation kind.

**M6 — Retire the flag; regression guard.**
Remove the flag and the old-path scaffolding. Add a conformance scenario for each
of the resolved divergences (D1 single-message, D4 non-PK-correlation-column
change mid-update, batch race-retry convergence) so a future change cannot silently
reintroduce them. Gate: green; the "identical persisted state, both backends"
assertion holds for the newly-added divergence probes.

**Rollback posture:** every milestone M1–M4 is flag-gated; if a milestone's gate
fails and can't be fixed quickly, the flag stays off and `main` behavior is
untouched. The old code is deleted only at M5, after every kind is proven through
the IR on both engines.

---

## 12. Traceability — every consolidated invariant, mapped to a mechanism

| Invariant (from the brief) | Where the design honors it |
|---|---|
| FK-direction ordering law; `getFkDirection` sole oracle; m2m-throw-before-inverse; `pkFields=references??PK` | §4 compiler uses `splitRelationMutationsByFk`+`getFkDirection` unchanged; §4.12 routes m2m before any direction query |
| Symbol = PK from a persisted row | §2.1 `SymbolId` brand; symbol never a whole row |
| Fixed intra-relation step order | §4 `planRelationMutationSteps` reused verbatim |
| `assertNoPlannedNestedMutationExecution` in create/upsertCreate | §4.1/§4.5 reused |
| Timing gate (create/connectOrCreate in "before"; rest "after") | §4 before/after emission driven by the split |
| Error-kind taxonomy target/correlated/nested-write | §7 `NotFoundKind` on nodes; identical on both backends |
| `translateRowToFieldNames` choke point | `ReadPort` wraps `record-access` (already translates); symbols bound from field-named rows |
| Atomicity + substrate gate; tx never enters batch & vice-versa | §3/§8 one atomic unit per backend; `atomic-runner` throw kept |
| connectOrCreate dedupe; m2m deleteMany combo rejection | §4.4/§4.13 reused |
| Return shape (scalars-only vs refetch) | §4.1/§4.5 `result` node |
| I1 partly-known identity + reject unlowerable | §2.2 `Deferral`; §6.3 `assertBatchLowerable` |
| I2 branch static or read+guard | §5.1 mandatory-guard `BranchDecision` |
| I3 guards are exists/notExists no-op-or-abort | §2.3 `Guard`/`Premise`; §6 backends realize |
| I4 FK ordering within relation; junction after child | §4 emission order |
| I5 shared step order | §4 |
| I6 nested-into-create rejection | §4.1 |
| I7 first-create-wins | §4.4, §9 |
| I8 m2m deleteMany combo | §4.13 |
| I9 adapter delegation / no raw dialect SQL | §6 backends lower via adapter only; §10 no new primitives |
| I10 result window offset | §6.2 `PreparedBatchOperation` unchanged |
| I11 atomic + fail-closed | §8 |
| Race compensation retryable-once | §8 one wrapper above the compiler |
| 3-valued departing-rows COALESCE | §4.9 `buildDepartingRowsCondition` reused |
| TEXT round-trip + cast-back | unchanged — `buildScalarSqlValue`/`getScalarCastType` reused (§2.1) |
| Capability honesty (`supportsBatch` genuinely atomic; d1-http rejects) | §6.4 dispatch unchanged; d1-http still `supportsBatch=false` |
| Lazy setup | §6.2 `BatchReferenceStore.initialize` behavior kept |
| Upward seams stable (execute/prepareBatch/undefined) | §6.4 |

---

## 13. Self-doubt (the weakest point, honestly)

The straight-line-plus-guard model forces the **inline backend to compile inside
its own transaction** (§5.4), because a branch-deciding read on the inline
substrate must observe prior in-transaction writes and lock with `FOR UPDATE`.
So the clean story "compile once, hand the same `Plan` to either backend" is only
*fully* true for the batch backend; for the inline backend, compilation and
execution interleave through the tx-scoped `ReadPort`. That is defensible (it is
what the tx engine already does, and the *semantics* still live in one compiler),
but it means the `Plan` the inline backend runs is effectively *built as it runs*
rather than built-then-run — the two backends consume the compiler differently
(batch: build-all-then-lower; inline: build-and-run-interleaved). If that
interleaving turns out to leak semantics back into the inline backend's driver
loop (e.g. a case where the ordering of a branch read vs a sibling write is
subtle enough that the compiler can't pre-decide it substrate-neutrally), the
"one semantic source of truth" claim weakens exactly where it matters most —
concurrency and read-after-write. The mitigation is that M2/M3's gates run every
upsert/connectOrCreate/correlation scenario through *both* backends on the same
DB, so any such leak shows up as a conformance divergence before cutover; but I
cannot prove a priori that no such case exists, and the honest risk is that a
late-discovered read-after-write ordering case forces a small `Branch`-like
escape hatch back into the IR, eroding the "no conditional node" simplification I
leaned on.
