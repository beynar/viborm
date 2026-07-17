# Why V1 Grew — and the Abstraction That Would Have Prevented It

> Companion to [`README.md`](./README.md) (the hypothesis) and [`ATOM.md`](./ATOM.md)
> (the resulting primitive). The README states what V2 tests. This document is
> the post-mortem it is a reaction to: **what actually made V1's query engine
> large, why, and the single design decision that would have avoided most of
> it.** Written from measurement of the current `src/query-engine/`, not from
> memory.

---

## 1. The measurement

`src/query-engine/` is ~21.5k lines. It splits cleanly:

| Region | Lines | Verdict |
| --- | --- | --- |
| `builders/` (where/select/orderby/values across 5 dialects) | ~5.3k | **Earned.** Portable SQL is irreducibly wide. |
| `result/` (scalar + relation result parsing) | ~2.4k | **Earned.** Cross-driver value normalization is real work. |
| root `src/query-engine/*.ts` (the operation/execution layer) | ~10.8k | **This is the problem.** |

The 10.8k root is ~23 files for **one verb**: *write a row, possibly nested,
possibly across drivers with different capabilities.* That ratio — 23 nouns for
one verb — is the whole story.

The files group into families that are really **axes of one domain**, each
sliced into its own subsystem:

```
Relation*    Branches Captures Membership MutationPlan Mutations
             ProgramValues Removals Updates Upserts        (9 files)
OwnWrite*    Analyzer Ledger Relation Steps                (4 files)
Operation*   Compiler Runtime BatchRuntime Results         (4 files)
ManyToMany*  Memberships Mutations Statements              (3 files)
Write*       Operations Programs                           (2 files)
```

---

## 2. Why it grew: one domain sliced along five orthogonal axes at once

A nested write varies along five independent axes. V1 gave **each axis its own
files**, so the file set became (roughly) their cross-product:

1. **Mutation kind** → `RelationMutations` / `RelationUpdates` / `RelationUpserts` / `RelationRemovals`
2. **Self vs. relation** → `OwnWrite*` vs. `Relation*`
3. **Cardinality** → `ManyToMany*` as its own kingdom
4. **Lifecycle phase** → Plan → Compiler → Program → Statements → Runtime → Results
5. **Substrate** → `OperationRuntime` **and** `OperationBatchRuntime` (1,093 lines
   executing the same program twice)

Orthogonal axes *multiply*. Every new feature has to visit every axis, and every
cell needs context from its neighbours — which is why the code is full of
children holding their owner:

```ts
this.writes = new WriteOperations(this);   // OperationCompiler
this.steps  = new OwnWriteSteps(this);     // OwnWriteRelation
new ManyToManyMemberships(updates);
```

`new Child(this)` is the tell. It means a scope was needed that was never
modeled as a value, so it gets threaded by construction instead. That is context
threading wearing an OO costume, and it is most of the "unreadable" feeling: to
understand one operation you must hold the whole owner graph in your head.

**None of these five slices is wrong individually.** The mistake is slicing on
*all of them structurally at the same time*. Four of the five are **data**, not
architecture (see §4).

---

## 3. The root cause: the atom was `Sql`, and `Sql` cannot carry a dependency

This is the single decision everything else grew out of.

The builders return `Sql` — a finished, parameterized string fragment. `Sql` is a
**terminal**. It is the last thing you produce, not something you compose a
dataflow out of. It cannot say:

> "my `userId` column is *whatever id the previous INSERT generated*."

The instant nested writes needed that sentence, the builders were the wrong
shape, and V1 could not compose them.

V1 did invent the symbolic-value primitive — it lives in `operation-program.ts`
as `ProducedValue`, `DerivedValue`, `FallbackValue`, `CapturedMutationStatement`,
plus the batch runtime's scratch-reference flavor. The primitive is not missing.
**It is just not the atom.** Because builders still return `Sql`, symbolic
values cannot ride *inside* the one value channel `Sql` already has — so they
live *above* the builders, and each axis carries its own factory and its own
flavor of "a value that isn't known yet":

- `RelationProgramValues`, `RelationCaptures` — the relation axis's factories
  for `ProducedValue`/`DerivedValue`/`FallbackValue` (verify: both import them
  from `operation-program`);
- the batch runtime — its own scratch-ref lowering of the same idea;
- `OwnWriteLedger` + `OwnWriteAnalyzer`/`OwnWriteInsertBarrier` — the sibling
  problem, ordering: dependency families and unique-constraint-overlap
  classification (`classifyTargetConstraintOverlap`) deciding what must run
  before what.

Read those names again: **none of them is a database concept.** There is no
"ledger" or "capture" in the idea of "insert a user and their posts." They are
the cost of minting the same primitive several times at the wrong layer.

That is the load-bearing insight, stated exactly: **the bulk of V1's accidental
complexity is not a missing primitive — it is a primitive minted per-axis,
above the builders, instead of once, inside the atom.** Five flavors of
deferred value plus a separate ordering subsystem is the plumbing mass.

---

## 4. The abstraction that was missing: **uniformity**

The fix is not a cleverer algorithm. It is refusing to let four things that are
**data** become **files**. Each collapse below deletes a family from §1.

### 4.1 Mutation kind is a parameter, not a subsystem

create / update / upsert / delete are the same shape — *emit a write against a
table, given values* — differing only in the SQL leaf. That is one `WritePart`
with four leaves, not `RelationMutations` + `RelationUpdates` + `RelationUpserts`
+ `RelationRemovals`. **Deletes most of `Relation*`.**

### 4.2 A nested write *is* a root write plus an edge

```ts
user.create({ data: { posts: { create: X } } })
// is exactly
user.create
post.create(X ∪ { userId: ref(user.create.id) })
```

"Relation-ness" is not a subsystem. It is an **edge** carrying two facts:

- **FK direction** → the ordering constraint between the two writes
- **a reference** → the value that flows across (`ref(user.create.id)`)

Once you have edges + references, `OwnWrite*` (self-writes) and `Relation*`
(relation-writes) are the *same code*. **Deletes the value-threading half of
`OwnWrite*` and the core of `Relation*`.** What must survive is the other half
of `OwnWrite*`: the **own-write independence preflight**
(`OwnWriteLedger.assertIndependent`) — a *legality gate* that statically
rejects any operation whose decision reads depend on its own earlier writes.
That gate is the soundness precondition of planning-before-writes itself
(ATOM §4) and belongs in §6's irreducible list, not here.

### 4.3 Many-to-many is not special

A M2M relation is a junction model with two ordinary FK edges. The "join row" is
just another write Part; cardinality is a fact in the schema, not a reason for a
three-file kingdom. What legitimately remains is membership *semantics* —
`set` as a symmetric difference, raceable membership guards (unification design
§5.5.3) — as leaves feeding the same step vocabulary. **Collapses `ManyToMany*`
from a subsystem to a schema lookup plus a handful of semantic leaves.**

### 4.4 Transaction vs. batch is one bit, resolved in one place

V1 spends **1,093 lines** on `OperationRuntime` + `OperationBatchRuntime` — the
same program executed twice. The batch runtime is also the **existence proof**
for the whole collapse: it already executes decision reads up front, pins
premises, linearizes taken branches, and threads generated ids through scratch
references — every supported shape is *already* provably linearizable, every
day, in production. The *substrate-specific* difference is how you resolve a
reference:

```ts
materializeLinearSql  // tx: read the concrete value the prior statement returned
materializeBatchSql   // batch: lower the reference to adapter batch-ref SQL
```

Those materializers are ~24 lines. The two runtimes also hold branch
interpretation, guard attribution, race retry, and result assembly — some of
that is irreducible and **relocates rather than vanishes**. The decisive claim
is narrower: with references as the atom, *nothing semantic* needs a second
implementation per substrate — one runtime plus two small materialize
functions, instead of two runtimes that must be kept in agreement by hand.

---

## 5. What should have been done differently (the actionable version)

Four rules. Each is small; together they make §2's cross-product impossible to
build.

### Rule 1 — `Step[]`, never `Sql`, is what an operation *is*

`Sql` is what a step **emits**. It is not what an operation **is**. If the atom
had been a step —

```ts
interface Step {
  id: string
  statement: Sql            // built by the same leaf builders; its values may contain Refs
  produces: Record<string, Source>   // named outputs later steps may reference
  // no declared `needs` — derived by scanning statement.values for Refs
}
```

— then composition costs nothing, dependencies are explicit in the data, and the
`Captures`/`ProgramValues` factory family is never born, because "a value that
isn't known yet" is a first-class thing (`Ref`) riding inside the value channel
`Sql` already has. (See `ATOM.md` for the full shape and its invariants.)

**The single highest-leverage decision:** make the operation layer speak steps,
and make `Sql` strictly the leaf. V1's operations being made of `Sql` is the
fork in the road; everything large followed from taking it.

### Rule 2 — no raw JS value may cross a step boundary; only `Ref`

If the *only* way one step feeds another is a typed reference, then:

- value dependencies become checkable data: refs must point at an earlier step's
  declared output, or the operation is rejected before provider access;
- substrate is a `resolve(ref)` function — no second semantic runtime;
- a missing dependency is a typed precondition error, not a silent `undefined`.

One boundary must be respected: **refs give a *partial* order, not a total
one.** Real ordering constraints exist with no value flow at all —
parent-before-child when the FK value is user-supplied, and
children-deleted-before-parent. So don't promise topo-sort synthesis. The
emitter owns the total order — the step list *is* the order — and the checkable
invariant is only: **refs point backward.**

And one thing is *not* an ordering problem, though it looks like one: two
writes whose unique targets overlap within one operation are **rejected, not
serialized** — serializing them is impossible in this model (the second's
decision would have to observe the first's write). That is what
`OwnWriteLedger`'s `classifyTargetConstraintOverlap` actually computes today:
rejection rules, not ordering rules. The Analyzer's value-threading half dies
with the atom; its independence/overlap analysis survives as the preflight
legality gate (ATOM §4).

### Rule 3 — refuse compiler-object hierarchies; pass scope as a value

`new Child(this)` should be a code-review stop sign. It means you needed a scope
you didn't model. Model it: a plain `Scope` value threaded as an argument to pure
functions. Objects-holding-their-owner is unreviewable precisely because the unit
of understanding becomes the whole graph, not the function in front of you.

### Rule 4 — a new step *kind* must be earned by two operations; a *leaf* is free

Adding a fourth mutation leaf (a new SQL string) is free and local. Adding a new
step **kind** (`BranchStep`, `FallbackValue`, `DerivedValue`) is a tax every
compiler and both runtimes must pay forever. V1 minted these one-offs freely;
each one then had to be handled in every phase. The gate: **a feature may add a
leaf, never an axis.**

---

## 6. What is *not* reducible (so V2 doesn't over-promise)

Honesty matters more than a clean pitch. Some V1 mass is genuine domain
difficulty and will reappear in V2 under different names, correctly:

- **`TargetConstraint` (~500 lines)** — *which unique constraint does this upsert
  target, and does it overlap another?* Real portable-DB work.
- **The own-write independence preflight (~1.2k lines of `OwnWrite*` legality
  analysis)** — the static proof that no decision read depends on a
  same-operation earlier write, rejecting overlapping shapes with a typed
  error. It is the soundness theorem of planning-before-writes (ATOM §4);
  without it, flat planning silently changes semantics instead of failing
  closed.
- **`mutation-identity` (~420 lines)** — *which row did I just write on a driver
  with no `RETURNING`?* Essential MySQL/LibSQL complexity.
- **The Pin Rule / raceability** (unification design §5.5) — a correctness
  contract paid for with a production bug. Guard failures must declare
  raceability, and missing-premise guards on create branches must not exist;
  the step vocabulary has to carry this from day one.
- **The builders and result parsing** — earned width, not accidental.

Realistic prize: **the 10.8k operation/execution root → ~3–4k**, by deleting the
plumbing families (§4.1–4.4). Not 21k → 1k. Anyone promising the latter is
counting the irreducible work as waste.

---

## 7. The one rule that prevents recurrence

**Count nouns per verb.**

One verb — *write a row, maybe nested, maybe across capabilities* — must not
require 23 nouns. The failure mode is always the same: a real distinction
(update ≠ create, batch ≠ tx, m2m ≠ 1-n) gets promoted from **data** to
**architecture**, and distinctions multiply where data would have added.

Make this V2's standing review gate:

> **A new feature may add a leaf (a SQL string, a schema fact). It may not add an
> axis (a file family, a step kind, a second runtime).** The day V2 grows
> `RelationUpsert.ts` + `M2MUpsert.ts` + `BatchUpsert.ts`, it has re-derived V1's
> cross-product — and no amount of per-file cleanliness will save it.

The lesson of V1 is not "we wrote bad code." Each of those 23 files is locally
reasonable. The lesson is that **locally reasonable decisions on five orthogonal
axes multiply into an unreadable whole**, and the way you refuse that is to keep
the axes as *data flowing through a tiny fixed vocabulary of steps* — which is
exactly, and only, what V2 has to prove.
