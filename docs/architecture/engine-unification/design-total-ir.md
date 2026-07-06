# Design — Total Plan IR for Nested Writes (IR-completeness lens)

Status: design proposal. Anchor: branch `prisma-parity`, commit `2fa49b6`.
Author lens: **IR-completeness** — every semantic decision (ordering, FK direction,
branch strategy, guards, junction rows) is decided by ONE compiler and *encoded in
the IR as data*. The two backends are semantics-free interpreters with zero relation
knowledge.

This design is written to be read against the six ground-truth maps in
`docs/architecture/engine-unification/`. Where a claim is load-bearing I cite the file
it came from. Every abstraction below carries an inline "this exists because…"; if I
could not justify one from first principles I left it out and said so in §12 and §13.

---

## 0. The thesis in one paragraph

A nested write is a **plan over uncertain state**: an ordered sequence of row mutations
whose values depend on (a) execution-generated values (DB ids), (b) reads that decide
branches, and (c) invariants that must hold at commit. Today that plan is *implicit* —
it exists only as the control flow of two engines (~6,600 lines) that reconstruct it
twice, once by interleaving `await`s in a transaction and once by emitting a guarded
statement list. The maps prove the two engines already share their entire *semantic*
layer — `getFkDirection`, `planRelationMutationSteps`, `splitRelationMutationsByFk`,
`planExistingUpsertBranch`, `buildScalarSqlValue`, the junction builders, the not-found
taxonomy — and differ **only in substrate**: tx threads concrete JS values and branches
at runtime; batch threads `BatchValueRef` symbols and pins plan-time branches with SQL
guards. The unification is therefore to **reify the plan as a first-class data
structure** — a `WritePlan` IR of typed nodes over an `Expr` language of
`literal | symbol | columnRef | computed` — produced by **one compiler** that owns all
relation semantics, and consumed by **two ~250-line interpreters** that know only how to
execute an `Insert`/`Update`/`Delete`/`Read`/`Guard` node. The IR is deliberately a
**write-plan language, not a query language** (§12): it can express exactly the twelve
mutation kinds and no more.

---

## 1. First-principles derivation of the node set (why these nodes and no others)

I refuse to invent nodes speculatively. Each node below is derived by asking: *what
irreducible operation does a nested write perform that a backend must execute?* I walked
every mutation kind in the maps and collapsed them.

Every nested write, in either engine, is built from exactly these primitive acts:

1. **Insert a row** (create, createMany, m2m child create, junction insert). → `Insert`
2. **Update columns of correlated rows** (scalar update, FK stamp, FK null, PK change,
   m2m updateMany). → `Update`
3. **Delete correlated rows** (delete, deleteMany, disconnect-by-delete on junction). →
   `Delete`
4. **Read a row to decide something / to obtain a value** (upsert exists?, connectOrCreate
   found?, before-image, after-image, connected-target-PKs). → `Read`
5. **Assert a premise still holds** (target exists, child correlated, unique missing,
   no departing rows). → `Guard`
6. **Choose between sub-plans based on a read** (upsert update-vs-create, connectOrCreate
   connect-vs-create, targetWhere/setWhere skip). → `Branch`
7. **Capture a produced value under a symbol** (generated PK, computed PK). → `Bind`

That is the complete list. There is no eighth act. `set` is (Guard\* + Delete/Update +
Insert\*). `connect` is (Guard + Update or Insert). `upsert` is (`Branch` over a `Read`).
M2M is (`Insert` junction / `Delete` junction) — the junction is just another table. This
exhaustiveness is the design's core claim and its falsifiable spine: **if any real
scenario needs an eighth node, the abstraction is wrong.** §13 records where I am least
sure of this.

Two nodes are *not* on the list and their absence is deliberate:

- **No `Transaction`/`Savepoint` node.** Atomicity is a property of the *whole* plan, not
  a node. The tx engine today opens a nested `withTransaction` per recursion level
  (map-tx-update-upsert §DIVERGENCE-RECURSION-ATOMICITY); that is a substrate artifact,
  not semantics. In the IR the plan is one flat ordered list and the backend commits it
  atomically as a unit. This exists because the oracle (map-oracle §C.9) requires the
  *entire* logical operation to be all-or-nothing; nesting transactions was only ever a
  way to get that.
- **No `Relation`/`Recurse` node.** Recursion is a *compiler* activity, not a runtime one.
  The compiler flattens the whole nested tree into one ordered node list at compile time.
  A backend never sees a relation. This is the essence of the IR-completeness lens.

---

## 2. The Expr language (exhaustive grammar)

`Expr` is the value language. It is intentionally tiny: it models exactly the values that
cross a phase/step boundary in a nested write, which the maps prove is **always a value
that is either known now, produced during execution, or a reference to a column**. It is
NOT an arithmetic/query expression language (§12).

```ts
// A value that may not be knowable at compile time.
export type Expr =
  | LiteralExpr    // a concrete JS value known at compile time
  | SymbolExpr     // a value produced DURING execution (generated/computed), named
  | ColumnExpr     // "the value of column C of the row this statement targets" (rare; see below)
  | SubqueryExpr   // a scalar SELECT resolving a value at execution (connect-by-unique)
  | ComputedExpr   // an arithmetic derivation over other Exprs (PK increment/decrement)
  | NullExpr;      // explicit SQL NULL (FK nulling on disconnect/delete)

export interface LiteralExpr {
  readonly kind: "literal";
  readonly value: unknown;              // raw JS value; lowered by buildScalarSqlValue
}

export interface SymbolExpr {
  readonly kind: "symbol";
  readonly symbol: PlanSymbol;          // see §3 — the unified BatchValueRef successor
}

export interface ColumnExpr {
  readonly kind: "column";
  readonly model: Model<any>;
  readonly field: string;               // field name (not column) — translated at lowering
}

export interface SubqueryExpr {
  readonly kind: "subquery";
  readonly select: ScalarSelect;        // (SELECT <pk> FROM <model> WHERE <unique> LIMIT 1)
}

export interface ComputedExpr {
  readonly kind: "computed";
  readonly op: "add" | "subtract" | "multiply" | "divide";
  readonly left: Expr;
  readonly right: Expr;
  readonly castType: CastType;          // getScalarCastType(model, field)
}

export interface NullExpr { readonly kind: "null"; }
```

**Why exactly these five (+null):**

- `LiteralExpr` — every client-supplied value, every PK that is known ahead. This exists
  because most values in a nested write *are* known at compile time.
- `SymbolExpr` — the single most important abstraction (§3). This exists because a
  generated DB id or a computed PK is *produced by executing a statement* and *consumed by
  a later statement*, and neither backend can avoid representing "produced-but-not-yet-known".
  Today this is `BatchValueRef` on the batch side and "a JS variable I read after await" on
  the tx side (map-batch-refs §0, D4). Unifying them into one `SymbolExpr` is the whole
  point.
- `ColumnExpr` — a reference to a column of the statement's own target row. Needed for the
  rare "SET fk = (this row's pk)" self-references and for correlated conditions where the
  value is another column. In practice most correlations resolve to a literal/symbol
  parentData value, so `ColumnExpr` appears mostly inside `Guard`/`Read` where clauses.
  This exists because some conditions genuinely compare two columns.
- `SubqueryExpr` — `buildConnectFkValues` / `buildTargetPkSubquery` already emit
  `(SELECT pk FROM target WHERE unique)` inline (relation-data-builder.ts:507,
  many-to-many-utils `buildTargetPkSubquery`). This exists because a connect can resolve a
  target PK *without a round-trip read* — an optimization both engines already exploit and
  which the IR must be able to represent so it is not lost.
- `ComputedExpr` — `increment`/`decrement`/etc. on a PK produce a value that must be known
  to correlate children (map-batch-refs §4, `getUpdatedPrimaryKeyValue`). This exists
  because a PK can change to an execution-computed value.
- `NullExpr` — FK nulling. A distinct node (not `LiteralExpr(null)`) because null carries
  the required-FK guard obligation (§7 delete/disconnect) and because
  `buildScalarSqlValue` already special-cases null vs adapter `literals.null()`.

**Lowering seam (already exists — do not rebuild).** `buildScalarSqlValue`
(values-builder.ts:114) already lowers `literal | Sql | BatchValueRef` correctly, applying
JSON/datetime/array/cast handling. The IR's `Expr → Sql` lowering is a thin dispatch:

```ts
function lowerExpr(ctx, model, field, e: Expr, resolver: SymbolResolver): Sql {
  switch (e.kind) {
    case "literal":  return buildScalarSqlValue(ctx, model, field, e.value);
    case "null":     return ctx.adapter.literals.null();
    case "symbol":   return buildScalarSqlValue(ctx, model, field, resolver.resolve(e.symbol));
    case "column":   return ctx.adapter.identifiers.escape(getColumnName(e.model, e.field));
    case "subquery": return lowerScalarSelect(ctx, e.select);
    case "computed": return lowerComputed(ctx, e, resolver);  // adapter.expressions.<op>
  }
}
```

`resolver.resolve(symbol)` returns *whatever the backend threads a symbol as*: for the tx
backend a concrete JS value (or a marker that a `RETURNING`/lastInsertId read will fill);
for the batch backend a `BatchValueRef` (which `buildScalarSqlValue` already lowers to
`adapter.batchRefs.read(...)`). **This is why the leaf never has to change**: the two
backends differ only in what `resolve` returns, and `buildScalarSqlValue` already accepts
both shapes.

---

## 3. `PlanSymbol` — the unified successor to `BatchValueRef` (the load-bearing abstraction)

```ts
export interface PlanSymbol {
  readonly id: string;                 // "sym_N", monotonic within a plan
  readonly origin: SymbolOrigin;       // how this symbol gets its value at execution
  readonly model: Model<any>;
  readonly field: string;              // the PK/column this symbol stands for
}

export type SymbolOrigin =
  | { kind: "generatedPk"; }                         // auto-increment produced by an Insert
  | { kind: "computedPk"; expr: Expr; }              // arithmetic over the before-value
  | { kind: "readColumn"; readId: string; };         // a value captured from a Read node
```

**This exists because** the maps identify one and only one thing that crosses every
phase/step boundary: *a primary key read from a persisted row, which may or may not be
known yet* (map-tx-create §13.2, map-batch-planner I1). `BatchValueRef` already models
"partly-known identity" (`BatchRecordRef.primaryKey` = per-field literal-or-ref,
batch-references.ts:22). `PlanSymbol` is that concept promoted to substrate-neutral: it
names a value and records *how it is produced*, so each backend resolves it its own way:

| origin | tx backend resolves by… | batch backend resolves by… |
|---|---|---|
| `generatedPk` | reading the `RETURNING`/`lastInsertId` after the `Insert` | `batchRefs.storeLastInsertId` + `batchRefs.read` subquery |
| `computedPk` | reading the updated row back (or computing in JS) | `batchRefs.store(computeSql)` + `read` |
| `readColumn` | the value already in the `Read`'s JS result | the value already in the plan-time read's result (literal) OR a stored ref |

A **partly-known identity** (the exact thing `BatchRecordRef` models) is just
`Record<field, Expr>` where each field is a `LiteralExpr` or a `SymbolExpr`. There is no
separate `RecordRef` type in the IR — a record identity is a where-map of `Expr`s. This
removes the `BatchRecordRef`/`BatchPrimaryKeyRef` pair as distinct concepts; they collapse
into `Expr`.

**Rejection rule preserved (I1, map-batch-planner §10).** The compiler must reject what
cannot be lowered to a symbol on a deferred substrate: a generated *compound* PK, or a PK
that is neither literal nor a single auto-increment, throws `NestedWriteError` at compile
time — *but only when compiling for a backend that declares it cannot observe generated
values mid-plan* (see §5.3 capability). This is the one place the compiler is
backend-aware, and it is aware only of a **capability flag**, never of a backend identity.

---

## 4. The node grammar (exhaustive, with TypeScript)

```ts
export interface WritePlan {
  readonly operation: "create" | "update" | "upsert";
  readonly nodes: PlanNode[];           // flat, ordered — execution order IS array order
  readonly result: ResultSpec;          // how to produce the returned value (§9)
  readonly requiresGeneratedValueObservation: boolean;  // true if any generatedPk/computedPk symbol exists
}

export type PlanNode =
  | InsertNode
  | UpdateNode
  | DeleteNode
  | ReadNode
  | GuardNode
  | BranchNode
  | BindNode;
```

### 4.1 `InsertNode`

```ts
export interface InsertNode {
  readonly kind: "insert";
  readonly model: Model<any>;
  readonly rows: ReadonlyArray<Record<string, Expr>>;   // field → Expr; multi-row for createMany
  readonly skipDuplicates?: boolean;                     // createMany / junction idempotency
  readonly produces?: PlanSymbol[];                      // generatedPk symbols this insert fills
  readonly onConflictReturnExisting?: boolean;           // reserved; unused today (see §13)
}
```

**Why `produces` on the node:** a `generatedPk` symbol is filled *by executing this
insert*. The tx backend reads it from the result; the batch backend must emit
`storeLastInsertId` **immediately after** this insert and before any other insert
(map-batch-refs §2 ordering law). Putting `produces` on the node makes that ordering
obligation local and non-losable — the backend cannot forget to store because the node
carries the symbols it fills.

### 4.2 `UpdateNode`

```ts
export interface UpdateNode {
  readonly kind: "update";
  readonly model: Model<any>;
  readonly set: Record<string, Expr>;       // field → Expr (FK stamp, FK null, scalar update, PK change)
  readonly where: Condition;                // §6 — always parent-correlated for to-many
  readonly requireAffected?: RequireAffected; // §7 — how "0 rows affected" is treated
}
```

`set` values are `Expr`s, so "SET fk = parentPK (a symbol)" and "SET fk = NULL" and
"SET count = count + 1 (computed)" are all the same node. **Why `requireAffected` is on
the node:** the true-vs-explicit asymmetry (map-tx-update §5, §6.1) means the *same*
UPDATE shape sometimes must error on 0 rows (explicit correlated delete/disconnect/connect)
and sometimes must not (disconnect:true, deleteMany). Encoding it as node data means both
backends enforce it identically without re-deriving the rule.

### 4.3 `DeleteNode`

```ts
export interface DeleteNode {
  readonly kind: "delete";
  readonly model: Model<any>;               // target table OR junction table
  readonly where: Condition;
  readonly requireAffected?: RequireAffected;
}
```

Junction deletes are just `DeleteNode` on the junction model. The self-referential-junction
`OR source IN (...)` logic (map-shared §D.6) is compiled into the `where` Condition; the
backend sees only a condition.

### 4.4 `ReadNode`

```ts
export interface ReadNode {
  readonly kind: "read";
  readonly readId: string;                  // referenced by SymbolOrigin.readColumn and by Branch
  readonly model: Model<any>;
  readonly where: Condition;
  readonly select: "one" | "pks" | "exists"; // shape needed
  readonly required?: NotFoundSpec;         // if set: throw this typed error when absent
  readonly captures?: PlanSymbol[];         // readColumn symbols filled from this read's row
}
```

**Why `ReadNode` exists as a node and not a compiler-only act:** a read that decides a
branch (upsert exists?, connectOrCreate found?) is executed differently by the two
backends — **tx executes it inline at runtime; batch executes it at plan-build time**
(map-batch-planner §0, map-oracle §A.1). Making it a node lets each backend choose *when*
to run it while the compiler fixes *what* it reads and *what it decides*. The `captures`
field is how a `Read` feeds `readColumn` symbols (e.g. the before-image PK used to compute
an after-image where). `required` carries the exact `NotFoundSpec` (§8) so the not-found
error is identical across backends — closing divergence D1/§F.4.

### 4.5 `GuardNode`

```ts
export interface GuardNode {
  readonly kind: "guard";
  readonly assert: "exists" | "notExists";  // the ONLY two shapes (I3)
  readonly model: Model<any>;
  readonly where: Condition;
  readonly onFail: NotFoundSpec;            // the typed error this guard stands for
}
```

**Why guards are always in the IR, even for the tx backend:** this is the design's sharpest
departure from today's code and from the orchestrator's frame. Today the tx engine has *no*
guard objects — it enforces premises by read-then-throw or rowCount checks (map-shared §A.6,
"guard-as-control-flow vs guard-as-data"). I argue the guard must be **IR data in both
cases** because otherwise the two backends re-derive "what premise protects this write" from
control flow, which is exactly the divergence source the maps catalogue (D1: tx throws a
typed message, batch raises a generic assertion). By making the `GuardNode` carry `onFail:
NotFoundSpec`, *both* backends produce the identical typed error:

- tx backend: a `GuardNode` lowers to "run `SELECT 1 … LIMIT 1`; if it fails the assert,
  `throw recordNotFoundError(onFail)`." (It may fuse the guard into an adjacent read/rowCount
  check as an optimization — §10 — but the *error* is `onFail`.)
- batch backend: a `GuardNode` lowers to `adapter.assertions.exists/notExists(...)` — **but**
  the batch driver must map the resulting DB abort back to `onFail` (§8.2), so the observable
  error type matches tx.

This collapses D1 and F.4 (error-shape divergence) into a single rule: **the error a guard
produces is compiler-decided data, not backend-decided control flow.** This is the biggest
correctness win of the total-IR approach and I consider it non-negotiable (map-oracle §D1
calls this out as "purely an artifact of the two substrates"; the IR removes the artifact).

`RequireAffected` on `Update`/`Delete` is a *fused* guard (the guard is the rowCount check
of the mutation itself); it lowers the same way. It exists as a separate field only because
some backends (tx on MySQL) get the rowCount for free from the mutation and need not emit a
separate SELECT.

### 4.6 `BranchNode`

```ts
export interface BranchNode {
  readonly kind: "branch";
  readonly on: BranchPredicate;             // decided from a ReadNode's result
  readonly whenTrue: PlanNode[];            // sub-plan (already flattened)
  readonly whenFalse: PlanNode[];
}

export type BranchPredicate =
  | { kind: "readFound"; readId: string; }               // the read returned a row
  | { kind: "readMatches"; readId: string; }             // upsert targetWhere/setWhere matched
```

**Why `Branch` is a node and not resolved by the compiler:** here I *disagree* with the
strict IR-completeness reading that would demand the compiler resolve every branch. The
compiler **cannot** resolve upsert/connectOrCreate branches at compile time without doing
I/O, and doing that I/O is exactly what makes the batch engine's plan-time reads necessary
and the tx engine's runtime reads possible. The honest model is: **the branch condition is
IR data (`on`), both arms are IR data (`whenTrue`/`whenFalse`), and the backend decides
*when* to evaluate `on`.**

- tx backend: run the `ReadNode` inline, evaluate `on` against its live result, execute the
  chosen arm. No guard needed on the arm *because the read and the writes are in one
  transaction* — BUT the compiler still emits the guard node into the arm (see next
  paragraph); the tx backend may treat an already-satisfied guard as a no-op.
- batch backend: run the `ReadNode` at plan-build time, evaluate `on` **now**, emit only the
  chosen arm's nodes into the flat statement list, and **the chosen arm's leading `GuardNode`
  re-asserts the premise** at execution time (the staleness pin).

The critical compiler rule that makes this safe: **every `BranchNode` arm must begin with a
`GuardNode` that re-asserts the predicate.** The compiler emits, for `whenFound`, a
`GuardNode{exists, where: readWhere}`; for `whenMissing`, `GuardNode{notExists}`. This is the
staleness contract (I2) *made structural*: it is impossible to compile a read-driven branch
without its guard, because the guard is part of the arm. The tx backend, running read+write
in one tx, finds the guard trivially satisfied and may elide it; the batch backend needs it.
Neither backend can *forget* it because the compiler put it there. This directly answers
map-batch-refs §8.5 ("dropping a guard = silent divergence") by making the guard
un-droppable.

### 4.7 `BindNode`

```ts
export interface BindNode {
  readonly kind: "bind";
  readonly symbol: PlanSymbol;              // computedPk symbol
  readonly expr: Expr;                      // the computation (before-value ± operand)
}
```

**Why `Bind` is separate from the `Insert.produces`/`Read.captures` mechanisms:** a
`computedPk` (PK += 1) is neither produced by an insert nor captured from a read — it is a
*derivation* the plan must materialize so children can reference it (map-batch-refs §4).
`generatedPk` binds via `Insert.produces` (the insert produces it); `readColumn` binds via
`Read.captures`; `computedPk` binds via an explicit `BindNode`. On the batch backend a
`BindNode` lowers to `batchRefs.store(batchId, key, computeSql)`; on the tx backend it lowers
to "compute in JS from the before-value, or read the updated row" — either yields a concrete
value for `resolve`. Three origins, three binding mechanisms, all producing a resolvable
symbol. I considered collapsing all three into `BindNode` but rejected it: `generatedPk`
*must* be co-located with its insert for the lastInsertId ordering law, so `Insert.produces`
is not redundant.

### 4.8 `Condition` and `ScalarSelect` (the shared sub-grammar)

```ts
export interface Condition { readonly sql: (ctx: QueryContext, r: SymbolResolver) => Sql; }
```

`Condition` is deliberately a **thunk that builds `Sql` via the adapter**, not a reified
boolean-expression tree. This is a considered choice (§12): the existing correlation
builders (`buildFkMatchCondition`, `combineWithParentCorrelation`, `buildWhereUnique`,
`buildDepartingRowsCondition`, `buildJunctionMembership`) already produce `Sql` and are
already substrate-agnostic (they route every value through `buildScalarSqlValue`, which
handles symbols). Reifying WHERE into IR nodes would duplicate the entire where-builder for
zero benefit — the backends never need to *inspect* a condition, only execute it. The one
thing the thunk closes over that varies by backend is the `SymbolResolver`, which is passed
at lowering time. **This exists because** the maps show conditions are already unified
(map-shared §B.2); re-abstracting them would be ceremony (a violation of the maintainer's
anti-over-abstraction value).

---

## 5. The compiler (single semantic source of truth)

`compileWritePlan(ctx, operation, args, caps): WritePlan`. It is grown from
`semantic-plan.ts` (which already owns the step/branch model) plus the top-level
create/update/upsert orchestration currently split across `transaction-flow.ts`,
`create.ts`, `update.ts`, `upsert.ts`, `batch-plan.ts`. It performs **zero writes**. It
*may* perform reads — but only through a `PlanReader` abstraction (§5.2) so the same
compiler drives both "read at plan time" (batch) and "defer read to a node" (tx).

### 5.1 Compiler responsibilities (exhaustive)

The compiler owns, and the backends never touch:

1. `separateData` → scalars vs relations; parse-time validation (already shared).
2. `assertNestedUpdatePlanIsExecutable` / `assertNoPlannedNestedMutationExecution` /
   `assertUpdateManyDataHasNoRelations` — **static** validation, runs first, before any
   node is emitted (map-batch-planner §7; invariant 11). Deep whole-tree (matches batch
   depth D5 — the *stricter* of the two, applied uniformly).
3. `getFkDirection` — the sole direction oracle; unchanged (m2m throws, `pkFields =
   references ?? PK`). Drives `splitRelationMutationsByFk`.
4. `splitRelationMutationsByFk` → ordering: currentHoldsFk relations compile **before** the
   parent `InsertNode`; relatedHoldsFk + m2m compile **after** (I4). This is emitted as node
   *order*, which is the IR's ordering encoding.
5. `planRelationMutationSteps` — the fixed intra-relation step order (I5), consumed verbatim.
6. Branch resolution strategy: emit `BranchNode`s with guard-led arms (§4.6). The
   `dedupeConnectOrCreateInputs` shim (§A.3) is **kept but relabeled**: it becomes an explicit
   compiler rule "first-create-wins within one connectOrCreate array" (§13 argues it can then
   be a real invariant rather than a divergence patch).
7. Junction planning (m2m): compile child `InsertNode` then junction `InsertNode`; delete
   junction-before-child; membership conditions. `assertManyToManyStepCombinationIsSupported`
   stays (I8).
8. FK-nullability guards, departing-rows, three-valued-logic COALESCE — compiled into
   `Condition`s and `GuardNode`s (I7, invariant 8).
9. Symbol allocation and the PK-known-before-execution rejection (§3), gated by `caps`.
10. `ResultSpec` (§9): the trailing findUnique and scalars-only-vs-refetch rule.

### 5.2 `PlanReader` — how the compiler does I/O without knowing the substrate

```ts
export interface PlanReader {
  // Resolve a read the compiler needs to decide a branch or capture a value.
  // Returns the row NOW (batch: plan-time driver read) or a deferred handle (tx).
  resolve(read: ReadNode): Promise<ResolvedRead>;
}
export interface ResolvedRead {
  readonly found: boolean;
  readonly row?: Record<string, unknown>;   // present when the reader read eagerly
  readonly deferred?: true;                  // tx: the read will run at execution
}
```

Two implementations:

- **EagerReader (batch)**: executes the read against the driver *now* (committed state),
  returns concrete rows. The compiler uses the row to pick the `Branch` arm and to seed
  literal PKs, then emits *only the chosen arm* plus its guard. This is exactly today's
  batch behavior (map-batch-planner §0).
- **DeferredReader (tx)**: returns `{ deferred: true }`. The compiler emits *both* arms and a
  `BranchNode`; the tx backend runs the read node at execution and branches live.

**Why this abstraction earns its place:** it is the single seam that lets *one* compiler
produce a plan whose read-driven branches are resolved eagerly (batch) or lazily (tx),
without the compiler branching on backend identity. It has two implementations — which the
maintainer's anti-ceremony value would normally flag — but here the two implementations are
*genuinely different strategies*, not speculative flexibility: one reads now, one reads
later. That is the irreducible substrate difference the whole project is about, localized to
one interface. I keep it. (Contrast §13, where I flag things that do NOT earn two
implementations.)

There is a subtlety I will not hide: with EagerReader the compiler emits only one arm, so
the plan is already *specialized*; with DeferredReader it emits both arms. This means the IR
a batch plan and a tx plan produce for the same args are **not node-identical** — they are
*state-equivalent* (the conformance oracle's actual assertion, map-oracle §E.3). I argue
this is correct and unavoidable: the batch substrate fundamentally cannot carry an
unresolved branch into a one-shot statement list. The IR is one *language*; the two plans
are two *sentences* in it that provably reach the same state. (§13 records the risk.)

### 5.3 Capabilities (`caps`) — the only backend knowledge the compiler has

```ts
export interface BackendCaps {
  readonly observesGeneratedValues: boolean;  // tx: true; batch: false
  readonly resolvesBranchesAtRuntime: boolean; // tx: true; batch: false
}
```

Exactly two flags, both derived from the same fact (interactive tx vs one-shot). The
compiler consults `caps.observesGeneratedValues` to decide whether to allow a generated
compound PK (§3 rejection) and `caps.resolvesBranchesAtRuntime` to pick EagerReader vs
DeferredReader. **This exists because** invariant I1/D3 (map-oracle) require the
capability gap to be a *typed error at compile time*, not a silent divergence — so the
compiler must know the gap exists. Two flags is the minimum that expresses it. I explicitly
reject a richer capability object (e.g. per-feature flags) as speculative (§13).

---

## 6. Backend contract (two dumb interpreters)

```ts
export interface PlanBackend {
  execute<T>(ctx: QueryContext, plan: WritePlan, driver: AnyDriver): Promise<T>;
}
```

Each backend is a ~200–300 line interpreter over `PlanNode[]`. It knows how to execute the
seven node kinds and how to `resolve` a `PlanSymbol`. It has **zero** relation knowledge —
no `getFkDirection`, no `planRelationMutationSteps`, no junction logic. If a backend file
imports `relation-data-builder` or `semantic-plan`, the design has failed.

### 6.1 Tx backend (`TxPlanBackend`)

Opens one `driver.withTransaction`. Walks `nodes` in order:

- `Insert` → build SQL via `buildInsert`, execute, read `RETURNING`/lastInsertId into the
  `produces` symbols' resolver slots.
- `Update`/`Delete` → build SQL, execute, apply `requireAffected` (rowCount → `throw
  recordNotFoundError(onFail)`).
- `Read` → execute, store row in the resolver for `captures`, remember result for `Branch`.
- `Guard` → execute the SELECT-1; if the assert fails, `throw recordNotFoundError(onFail)`.
  (May be elided when a same-tx prior write already established the premise — an
  optimization, not a semantic change.)
- `Branch` → look up the `on` read's live result, execute the chosen arm's nodes recursively.
- `Bind` → compute the `Expr` in JS (or read back), store in resolver.

Atomicity: the single `withTransaction`. Recursion-atomicity divergence
(map-tx-update §DIVERGENCE-RECURSION-ATOMICITY) **disappears** because the plan is flat —
there is no per-level nested `withTransaction`.

Race retry (§B.5, invariant 9): stays *above* the backend, in the caller
(`executeWithNestedWrites`), unchanged. It re-invokes `compile + execute`. This is correct
because the retry re-reads (via a fresh EagerReader/DeferredReader) and re-compiles the
branch. Keeping it above the backend means both backends inherit it identically — which the
maps say is required (map-oracle §D7: the batch abort must also be retryable).

### 6.2 Batch backend (`BatchPlanBackend`)

Lowers `nodes` to a flat `Sql[]` (setup + body + cleanup) and hands it to
`driver._executeBatch` as one atomic unit. Walks `nodes`:

- `Insert` → `appendInsert`; for each `produces` symbol emit `storeLastInsertId`
  **immediately after** (ordering law, map-batch-refs §2).
- `Update`/`Delete` → append; `requireAffected` with explicit targets lowers to a *preceding*
  `Guard` (batch cannot check rowCount mid-batch — map-oracle §C.2, D1). The compiler already
  emitted that guard, so the backend just appends.
- `Read` → **does not appear in a batch plan's body** for branch decisions (the EagerReader
  resolved them at compile time). A `Read` whose purpose was `captures` for a value the batch
  needs becomes either a plan-time literal (already resolved) or is unnecessary. The only
  reads that survive into the batch are guards.
- `Guard` → `adapter.assertions.exists/notExists`, **wrapping the DB abort back into
  `onFail`** so the error type matches tx (§8.2).
- `Branch` → never reaches the batch backend as a node: EagerReader specialized it away at
  compile time (§5.2). If a `BranchNode` ever reaches the batch backend, that is a compiler
  bug and the backend throws `QueryEngineError` (defense-in-depth, mirroring
  `atomic-runner`'s existing mis-routing throw).
- `Bind` (computedPk) → `batchRefs.store`.

Symbol resolution: `resolve(symbol)` returns the `BatchValueRef` for that symbol;
`buildScalarSqlValue` lowers it to `batchRefs.read(...)`. Lazy setup (I10, invariant 10)
preserved: the temp table materializes only when the first symbol needs a ref.

Capability honesty (invariant, map-batch-refs §8.8): a driver that cannot guarantee
atomic/ordered/single-connection batch declares `supportsBatch=false` and is rejected
loudly (d1-http). Unchanged.

### 6.3 Dispatch (the upward seams, unchanged shapes — invariant 10)

`runNestedWriteOperation` becomes:

```
caps = capsFor(driver)
plan = await compileWritePlan(ctx, op, args, caps, readerFor(driver))
backend = caps.resolvesBranchesAtRuntime ? TxPlanBackend : BatchPlanBackend
return backend.execute(ctx, plan, driver)
```

`metadata.execute`, `metadata.prepareBatch` (→ lowers the plan to `PreparedBatchOperation`
with shared `setup/cleanup` via `BatchPreparationContext`), and `prepareBatch → undefined`
(when `caps` reject the plan for atomic batching) keep their exact shapes. The
`hasNested/prepare/prepareBatch` gating in `createPreparedOperation` is untouched.

---

## 7. How each of today's mutation kinds compiles (all twelve, + M2M)

Notation: `P` = parent model, `C` = child/target, `J` = junction. `sym(pk)` = a `SymbolExpr`
for a generated PK. Node order shown is the emitted order.

**create (parent-holds-FK child)** — `splitRelationMutationsByFk` → currentHoldsFk:
`[compile child create → Insert(C) producing sym(cpk)] · Insert(P){ set fkcol = sym(cpk) }`.
Value flows child→parent via `sym(cpk)`. (map-tx-create §2.1.)

**create (child-holds-FK / to-many)** — relatedHoldsFk:
`Insert(P) producing sym(ppk) · Insert(C){ fkcol = sym(ppk) }`. (Parent before child.)

**createMany** — one `InsertNode` with `rows: [...]`, each row's FK = `sym(ppk)`,
`skipDuplicates` if requested. Rejected on m2m (default-case error). (map-shared §D.11.)

**connect (parent-holds-FK)** — `Guard{exists, where: unique(C), onFail: target} ·
Update(P){ fkcol = SubqueryExpr(select pk from C where unique) or literal }`. The pre-read
that today throws `target` becomes a `GuardNode{onFail:target}` — identical error both
backends. (Closes map-tx-create §5 kind-divergence.)

**connect (child-holds-FK)** — `Update(C){ fkcol = sym(ppk), where: unique(C),
requireAffected: {onFail: correlated} }`. The rowCount==0 → `correlated` becomes
`requireAffected.onFail`. Direction still decides the kind (target vs correlated), preserved
because the compiler picks it. (Invariant, map-tx-create §5.)

**connectOrCreate** — `Read(readId, where: unique(C)) · Branch{ on: readFound,
whenTrue: [Guard{exists,onFail:target?}, <connect nodes>],
whenFalse: [Guard{notExists}, <create nodes>] }`. Dedupe applied by compiler. Guard-led arms
= the staleness pin (§4.6). (map-oracle §C.5, D8.)

**disconnect (nullable child FK)** — `Update(C){ fkcol = NullExpr, where:
correlated(explicit) → requireAffected:{onFail:correlated}; or where: fkMatch (true) → no
requireAffected }`. (map-tx-update §5.)

**disconnect (non-nullable FK)** — compiler emits **nothing** and throws
`NestedWriteError` at compile time (`assertFkCanBeSetNull`). Never a `SET NULL` on a required
column (invariant 7). Same for the parent-holds-FK to-one disconnect (Update(P) SET fk=NULL +
mutate — the "mutate parentData" is replaced by the compiler threading `NullExpr` into
downstream correlation Exprs, §11).

**set** — compiler emits: for each member `Guard{exists, where: unique, onFail: target}`
(existence asserted up front); then departing-rows handling: required FK →
`Guard{notExists, where: buildDepartingRowsCondition (COALESCE fix), onFail: nestedWrite}`;
nullable FK → `Update(C){ fkcol = NullExpr, where: departing }`; then per-member
`Update(C){ fkcol = sym(ppk), where: unique, requireAffected: correlated }`. The
DELETE-vs-check ordering divergence (map-shared §D.5) is **resolved by the compiler picking
one order** (assert-existence → handle-departing → connect) and both backends emitting it
verbatim. The tx "skip already-connected" optimization (D6) becomes a backend-local
micro-optimization the tx interpreter may apply (skip an `Update` whose `set` equals current)
— it does not change the IR. (I keep it as an interpreter detail, not IR, because it is a
substrate performance quirk, MySQL 0-affected-rows; §13.)

**update (scalar + nested)** — `Read(before, where, required:correlated, captures:[sym(bpk)])
· Bind?/Update(P){ set: scalarExprs } · <compute after-PK: literal or ComputedExpr → sym(apk)>
· <for each relation: nodes correlated by sym(apk)>`. Scalars-before-relations and
after-image PK (invariant 4) are node order + symbol flow. Batch's read-avoidance
optimization (D8: skip the read when no PK change and no nested relations) becomes: the
compiler simply does not emit the `Read` when nothing downstream references `sym(apk)` — a
*compiler* decision available to both backends, not a batch-only hack.

**updateMany** — `Update(C){ set: scalarExprs (assertUpdateManyDataHasNoRelations), where:
parentFk ∧ filter, requireAffected: none }`. Set-based, never rows-required. (map-tx-update
§6.3.)

**delete** — parent-holds-FK: `Update(P){ fkcol=NullExpr } · Delete(C)`. Else
`Delete(C){ where: correlated(explicit)→requireAffected:correlated; or fkMatch(true)→none }`.
(map-tx-update §6.1.)

**deleteMany** — `Delete(C){ where: parentFk ∧ filter, requireAffected: none }`. (§6.2.)

**upsert (top-level)** — `Read(existing, where, forUpdate on tx) · Branch{ on: readFound,
whenTrue: [Guard{exists}, <targetWhere/setWhere sub-branches via planExistingUpsertBranch>,
<update nodes>], whenFalse: [Guard{notExists}, <create nodes>] }`. `planExistingUpsertBranch`
is reused verbatim to build the inner guards (`uniqueWithWhereExists/Missing` →
`GuardNode`s). The concurrent-delete-during-update case (D-UPSERT-EXISTING) becomes a
`Guard{exists, onFail: <"deleted during upsert">}` — same typed error both backends,
resolving the divergence where tx threw `QueryEngineError` and batch threw a different
`NestedWriteError`. (map-tx-update §3, §8.)

**upsert (nested relation)** — same shape; to-one uses fkMatch, to-many uses correlated
where + the uncorrelated-exists → throw `correlated` rule (map-tx-update §2.3), compiled as
`Read(correlated) · Branch{ whenTrue: update, whenFalse: [Read(uncorrelated) · Branch{
whenTrue: throw correlated, whenFalse: [Guard{notExists}, create] } ] }`.

**M2M (all kinds)** — junction rows are `Insert(J)`/`Delete(J)` nodes; the child is
`Insert(C)`/`Delete(C)`. create: `Insert(C) producing sym(cpk) · Insert(J){ source=sym(ppk),
target=sym(cpk), skipDuplicates }`. connect: `Guard{exists} · Insert(J){ target =
SubqueryExpr }`. delete: `Delete(J) · Delete(C)` (junction-first). The **one documented
un-guarded gap** — M2M filtered deleteMany resolving connected PKs at plan time
(map-batch-planner §5 last row, `ponytail:` comment) — is preserved **as an explicit IR
annotation**: the compiler emits a `DeleteNode` whose `where` is a materialized PK-IN list
*with a `staleness: "unpinnable"` marker* and a comment, so the gap is visible in the IR
rather than buried in batch-only code. §13 argues this is the one place the total-IR ideal
genuinely cannot be met, and the honest move is to *name* it in the IR, not hide it.
M2M upsert's inline branch logic (map-shared §D.10) is compiled through the *same*
`BranchNode` machinery as to-one upsert — removing the "duplicated inline, no shared decision
function, highest divergence risk" smell the map flags.

---

## 8. Error taxonomy (unified, compiler-owned)

```ts
export interface NotFoundSpec {
  readonly relationName?: string;
  readonly operation: string;
  readonly kind: "target" | "correlated" | "nested-write";
}
```

### 8.1 The three kinds are compiler-decided data

`recordNotFoundError({relationName, operation, kind})` and its exact messages
(map-shared §C.1) are preserved verbatim. The kind is chosen by the compiler from FK
direction + correlation (invariant, map-tx-create §13.6) and travels as `Guard.onFail` /
`Read.required` / `RequireAffected.onFail`. **This is the mechanism that closes the D1/F.4
error-shape divergence**: because the kind is IR data, both backends raise the *same*
`NestedWriteError` with the *same* message.

### 8.2 Batch guard → typed error mapping (the fix for D1)

Today a batch guard raises a raw div-by-zero / bad-json-path that normalizes to a generic
`NestedWriteAssertionError` (map-oracle §D1, map-batch-refs §7.3). Under this design the
`BatchPlanBackend`, when a guard's assertion SQL aborts, must catch the driver error and
rethrow `recordNotFoundError(guard.onFail)` (or the appropriate typed error). To do this it
tags each assertion statement with its `onFail` (e.g. via the `__viborm_assert__` alias
carrying an index into a side-table of `onFail` specs the backend holds). **This is the
one place a real behavior-test change is required** (map-oracle §D1 asserts *different*
messages by branching on `supportsTransactions`; after this design both branches assert the
*same* message). I flag it explicitly as an acceptance-gate change in §10 — it is a
deliberate reduction of divergence, blessed by the maintainer's "identical behavior or a
clear typed error" value, but it touches the oracle and must be done consciously.

### 8.3 Compile-time errors (before any execution)

Static validation (`assertNestedUpdatePlanIsExecutable`, planned-mutation rejection,
updateMany-no-relations), PK-known-before-execution rejection, non-nullable FK guards, and
m2m combination rejection all throw `NestedWriteError` at **compile** time — before any
node executes, on both backends (invariant 11, D5). This is strictly the union of what both
engines reject today, applied uniformly (the stricter batch depth becomes the standard).

### 8.4 Write-race classification (unchanged)

`isWriteRaceLoserError` must still recognize the batch backend's lost-race signal. Because
§8.2 maps guard aborts to typed errors, the classification must also recognize the
underlying `UniqueConstraintError` from the losing INSERT (which is the real race signal,
not the guard — map-oracle §D7). Unchanged from today; called out so §8.2's rewrap does not
accidentally swallow the retry signal.

---

## 9. Result assembly (`ResultSpec`)

```ts
export interface ResultSpec {
  readonly finalWhere: Record<string, Expr>;   // PK (possibly post-update / symbol)
  readonly refetch: boolean;                    // true iff select/include present
  readonly selectInclude?: unknown;
}
```

Prisma-parity return shape (invariant 8): without select/include → scalars only (the
compiler marks `refetch:false` and the backend returns the parent record it already has);
with select/include → `refetch:true` and the backend runs `buildFindUnique(finalWhere,
select, include)`. `finalWhere` uses `Expr` so a PK changed by a scalar update (a
`ComputedExpr`/symbol) refetches correctly. Field-name translation
(`translateRowToFieldNames`) is applied by the backend at the read boundary (choke point,
invariant, map-tx-create §13.7). The batch result-window offset (I10) is a `BatchPlanBackend`
concern only.

---

## 10. Migration plan (per-milestone, each keeps the oracle green)

Guiding rule: **the conformance suite (`nested-write-conformance.test.ts`) and behavior
suites (`tests/drivers/*-behavior.ts`) must be green at every milestone.** The strategy is
strangler-fig: introduce the IR and one backend at a time behind the existing dispatch,
never a big-bang rewrite.

**M0 — Add M2M conformance scenarios (prerequisite, no engine change).**
The conformance oracle has *zero* M2M scenarios (map-shared §G, map-oracle §G). Before
touching engines, add M2M scenarios (connect/idempotent/create-through-junction/set/
disconnect/delete/deleteMany/upsert-connected/uncorrelated/create/self-ref) so tx-vs-batch
M2M equivalence is actually asserted.
*Gate:* new scenarios pass on both existing engines unchanged. This milestone de-risks
everything after it.

**M1 — Introduce the IR types + `Expr`/`PlanSymbol`, no behavior change.**
Land `write-plan-ir.ts` (types only), `expr.ts`, and the `lowerExpr` leaf delegating to
`buildScalarSqlValue`. No engine consumes it yet.
*Gate:* build + type-check green; zero runtime change; existing tests untouched.

**M2 — Compiler skeleton driving the *batch* backend for CREATE only.**
Implement `compileWritePlan` for `operation:"create"` (the simplest FK-direction case) and a
`BatchPlanBackend` that lowers create plans. Route batch-only drivers' *create* through the
new path; keep tx create on the old engine. Reuse `getFkDirection`,
`splitRelationMutationsByFk`, `getBatchPrimaryKeyRef`.
*Gate:* conformance create scenarios' `batchState` still `toEqual` `txState` and `expected`;
all batch behavior create tests green. This proves the IR can reproduce the batch engine's
create semantics exactly.

**M3 — Tx backend for CREATE; delete old create engine.**
Implement `TxPlanBackend` for create; route tx create through it. Delete `create.ts`'s
executor bodies (keep shared helpers). Now *both* backends run create from one compiler.
*Gate:* full create conformance + behavior green on tx and batch drivers; net LOC down.

**M4 — UPDATE + nested update through the IR (both backends).**
Add compiler support for update (scalars-before-relations, after-image PK, correlation).
Route both backends. Delete `update.ts` executor bodies.
*Gate:* update conformance + "parent-correlated" + "other parent's child rejected" behavior
tests green. **Here the D1 error-message unification lands** (§8.2): update the behavior
tests that branched on `supportsTransactions` for the correlation-rejection message to assert
the *same* typed message on both. This is a deliberate, reviewed oracle change.

**M5 — UPSERT + connectOrCreate + BranchNode/guard-led arms (both backends).**
The hardest: `BranchNode`, `PlanReader` (Eager/Deferred), staleness guards,
`planExistingUpsertBranch` reuse, targetWhere/setWhere, race retry above the backend.
*Gate:* upsert/connectOrCreate conformance + advanced-behavior guard tests + write-race
retry green. Concurrency divergences (D2/D7) explicitly re-verified: the batch uniqueMissing
loss still surfaces a retryable error.

**M6 — connect/disconnect/set/delete/deleteMany/updateMany (both backends).**
The link-only ops. `set` DELETE-ordering unified; departing-rows COALESCE; required-FK
guards. Delete `set.ts`/`disconnect.ts`/`delete.ts`/`delete-many.ts`/`update-many.ts`
executor bodies.
*Gate:* all set/disconnect/delete behavior tests green, including "orphan reject only when
rows depart" and "no-op set succeeds". D1 set-orphan message unified like M4.

**M7 — M2M through the IR (both backends).**
Junction Insert/Delete nodes, membership conditions, junction-first delete, self-ref, m2m
upsert via the shared `BranchNode`. Delete `many-to-many.ts`/`batch-many-to-many.ts` executor
bodies; keep `many-to-many-utils.ts` (the good shared junction SQL layer). The one un-pinnable
deleteMany gap is annotated in the IR (§7).
*Gate:* the M0 M2M conformance scenarios green on both backends; per-driver m2m behavior green.

**M8 — Delete the two old engines; collapse `fk.ts` duplicate helper pairs.**
Remove the tx/batch duplicate FK-assignment pairs (map-shared §B.1) now that assignment is
expressed once over `Expr`. Remove `txCtx.createdRecords`/`generatedIds` dead bookkeeping
(map-tx-create §4.1). `relation-mutation.ts`, `batch-plan.ts`, `batch-relations.ts`,
`batch-relation-links.ts`, etc. executor bodies gone; `semantic-plan.ts` absorbed into the
compiler.
*Gate:* full suite green; ~6,600 lines → one compiler + two interpreters + shared builders.
Grep gate: no backend file imports `relation-data-builder`/`semantic-plan`.

Each milestone is independently revertible (old engine still present until its M-gate
passes). No milestone requires the other backend to be migrated first *except* that a kind is
migrated on both backends in the same milestone (M3+) so the conformance dual-run stays
meaningful.

---

## 11. The `parentData`-mutation problem (a specific hazard the IR must handle)

The tx engine mutates `parentData[fk] = null` in place after disconnect/delete so later
in-tx steps observe it (map-tx-update §DIVERGENCE-PARENTDATA-MUTATION, invariant 14). The
batch engine never mutates a live record. In the IR this must be **neither** — it is a
*symbol/Expr rebind*: after a `disconnect` nulls a parent FK, the compiler rebinds the
downstream correlation Expr for that FK field to `NullExpr` (or the new symbol). Because the
compiler threads `Expr`s, not JS records, "downstream correlation observes the post-mutation
FK state" (the semantic requirement) is satisfied structurally, on both backends, without
mutation. This is the cleanest example of why reifying values as `Expr` beats both today's
substrate-specific hacks.

---

## 12. Where I push back on the orchestrator's frame

The orchestrator's candidate ("a write-only Plan IR of Insert/Update/Delete/Read/Guard/Branch
over exprs of literals+symbols+column refs, one semantic compiler, two thin semantics-free
backends") is almost exactly this design, and I adopt it. Three refinements where I diverge:

1. **`Branch` cannot be fully compiler-resolved, and pretending otherwise is the trap.**
   The strict IR-completeness reading (my own lens's temptation) says "the compiler decides
   every branch." It *can't* without I/O, and the I/O timing is the substrate difference.
   My resolution — `BranchNode` is IR data, with **guard-led arms so the staleness pin is
   structural and un-droppable**, and a `PlanReader` that resolves eagerly (batch, emitting
   one arm) or lazily (tx, emitting both) — is the honest middle. Consequence I own: the two
   backends' *plans* are state-equivalent, not node-identical (§5.2). I argue this is correct;
   a single node-identical plan for both substrates is impossible because batch cannot carry an
   unresolved branch.

2. **Do NOT reify `Condition` into an IR expression tree.** The orchestrator's risk list names
   "IR creep toward a general query language" and "Expr language creep" — I take that seriously
   and *stop the Expr language at values*, keeping WHERE as an adapter-built `Sql` thunk. The
   where-builders are already unified and substrate-agnostic (map-shared §B.2); reifying them
   would be a second query language for no backend benefit (backends never inspect conditions).
   This keeps the IR a *write-plan* language, honoring the anti-over-abstraction value.

3. **The `Guard` belongs in the tx plan too, not only the batch plan.** Today tx has no guard
   objects. Putting `GuardNode{onFail}` in *both* plans is what unifies the error taxonomy
   (§8) and kills D1. This is more IR than the tx engine "needs," but it is the abstraction
   that makes the two backends provably agree on errors — so it earns its place by the "never
   silent divergence / clear typed error" value, not by symmetry for its own sake.

---

## 13. Self-doubt — the weakest points, honestly

1. **The seven-node exhaustiveness claim is the whole design and I cannot fully prove it.**
   I derived the nodes by collapsing the twelve kinds, but the derivation is inductive over
   *today's* features. A future feature (e.g. `connectOrCreate` with an `update` payload à la
   Prisma's newer semantics, or ordered/positional relations) could need an eighth node or a
   richer `Expr`. My mitigation is the grep/exhaustiveness discipline and the falsifiable
   spine (§1), but I concede the risk is real and is exactly the "IR creep" the orchestrator
   named.

2. **State-equivalence, not node-equivalence, weakens the conformance guarantee.** Because the
   batch compile specializes branches away (§5.2), the conformance oracle proves the two
   *plans* reach the same state, not that they are the same plan. If a bug lives in the
   *specialization* (EagerReader picks the wrong arm), the oracle catches it only if a scenario
   exercises that exact state. This is *already* true of today's two engines, so I am not making
   it worse — but the total-IR promise ("one source of truth") is slightly softer than it
   sounds: the branch-resolution *strategy* differs by backend even though the *semantics* are
   compiled once. The M0 milestone (add M2M scenarios) partly mitigates by widening the oracle.

3. **The un-pinnable M2M filtered-deleteMany gap (§7) is a genuine hole in the ideal.** The
   IR-completeness lens says "every decision is compiler-decided and guarded." This one read is
   materialized at plan time with *no* re-checkable premise (the filter can't be re-evaluated
   after junction rows are gone — map-batch-planner §5). My design *names* it in the IR
   (`staleness:"unpinnable"`) rather than solving it, which is honest but is an admission that
   the ideal is not 100% reachable on the batch substrate. A stricter design would *reject* the
   filtered-deleteMany-with-BatchValueRef-parent case even harder, or lift it by requiring the
   parent PK known — but that would forbid scenarios tx allows, trading one divergence for
   another. I left the gap as-is-but-visible; I am not certain that is the right call.

4. **`ColumnExpr` and `SubqueryExpr` may be under-exercised.** I included them for completeness
   (self-column references, connect-by-unique subqueries), but most real correlations resolve to
   literal/symbol parentData values. If in practice they are never needed, they are speculative
   surface — a mild violation of the anti-ceremony value. I would keep `SubqueryExpr` (it
   preserves a real existing optimization, `buildConnectFkValues`) but would delete `ColumnExpr`
   at M8 if the migration shows nothing emits it.

5. **The D1 error-message unification (§8.2) is a real behavior change to the oracle.** I argue
   it is blessed by the maintainer's values, but I am changing tests that today deliberately
   assert *different* messages per substrate. If the maintainer considers the per-substrate
   message an intentional contract rather than an artifact, this milestone is wrong and the
   guard must instead carry two messages. I believe it is an artifact (map-oracle §D1 says so),
   but this is a judgment call I am imposing.
