# The pattern engine — ideal state for VibORM's query/write engine

**Date:** 2026-09-02

**Status:** Design. No production code changed. Every number labelled *measured* comes
from the working tree at `5988a20e`; every number labelled *estimate* is an estimate and
says so.

**Scope:** `src/query-engine` (60,209 lines measured). Nothing in the public schema
language, query syntax, result types, SQL semantics, parameter order, statement order,
failure identity, transaction/batch behavior, dialect or driver support changes. The
plan holds every feature and re-expresses how the engine reaches them.

**Reading order:** §1 says what the engine is for and why it is 60k lines today. §2 gives
the model in six definitions. §3–§9 are the design, one mechanism per section, each
followed by an adversarial review that names the way it fails and what prevents that.
§10 is the failure register in one place. §11 is the size. §12 is the delivery path and
the decisions that only the maintainers can make.

---

## 1. Context

### 1.1 What the engine does

A user writes a payload against a model:

```ts
db.post.update({
  where: { id: 7 },
  data: {
    title: "x",
    author: { connect: { id: 3 } },
    tags: { set: [{ id: 1 }, { id: 2 }] },
    comments: { create: [{ body: "…", reactions: { create: { kind: "like" } } }] },
  },
  select: { id: true, author: { select: { name: true } }, comments: { where: { body: { contains: "…" } } } },
});
```

The engine must turn that into SQL statements in an order that respects referential
dependencies, execute them inside whatever atomicity the driver offers (an interactive
transaction, or an atomic native batch on D1 / Neon HTTP / PlanetScale, or committed
segments when a bulk write with relations cannot fit one batch), detect the one hazard
that makes the two substrates disagree (a decision read that would observe this
operation's own earlier write), publish generated keys on providers that cannot
`RETURNING` them, and decode provider rows back into the shape the `select` asked for.
Three dialects, eleven drivers, four relation storages (child-held FK, parent-held FK,
junction, polymorphic row-held and per-variant member junction), eleven nested-write
verbs at any depth.

### 1.2 Why it is 60k lines today (measured)

The diagnosis in [raptor3-restructuring-plan.md](./raptor3-restructuring-plan.md) and the
two first-principles sessions ([blind](./raptor3-first-principles-blind.md),
[adversarial](./raptor3-first-principles-attack.md)) agree on the cause. The engine is
organised by *inputs* (a verb, a storage kind, a parent state, a substrate, a phase), and
every one of those inputs was made a **copy axis** of the same algorithm instead of an
argument to it:

| axis | copies today | measured |
|---|---|---|
| parent state (fresh / selected / inline-literal junction target) | two record compilers + a restricted third | 5,803 + 4,315 + 808 lines |
| storage kind × verb | five relation owners, each re-dispatching the verb per lifecycle method | 7,962 lines; 21 verb switches / 170 labels; the junction owner switches 5× on one verb |
| phase (planning / compile) | every Part written as two methods with a bag between them | `PlanningKnown`, `conditionalArmPlanning`, 4 mutable-after-construction fields, reset-on-retry |
| substrate (transaction / atomic batch) | a batch arm in 16 files | 699 lines in `txMode` conditionals + 938 lines of guard/pin helpers |
| legality | a second interpreter re-walking the payload | `OwnWriteSteps` 754 lines + traversal |
| ordinary / polymorphic | twin arms | ≈ 810 lines |

Three abstraction levels were tried on top of that diagnosis. Each removed one axis:

| level | idea | engine size (estimate) |
|---|---|---:|
| coroutine + three lowering tables | one `lower()` per storage kind; substrate as an interpreter | ≈ 40k |
| goal states + one physical rule | verbs are goals on {row exists, edge holds}; "a reference is written after its referent exists, read before it changes" derives placement | ≈ 30k |
| **patterns over cells** (this document) | rows and edges are cells; one recursion in three modes; single assignment; dataflow | **≈ 13k + 4k relocated** |

### 1.3 What "ideal" means here

Ideal is not smallest. It is: every remaining line is either (a) the one recursion, the
one scheduler, the three premise enforcers, or (b) a table that maps a public vocabulary
onto them. Nothing in the engine is a second spelling of something that has an owner,
and no public verb, storage kind, substrate, or phase survives as a runtime discriminant
past the point where it was decided.

---

## 2. The model in six definitions

**D1 — Cell.** A database is a partial function `cell → value` where a cell is
`(table, key, column)`. A row *exists* iff its key cells have values. An edge *holds* iff
a reference cell equals another row's key. A junction row is a fresh key whose only cells
are two references. A discriminator is a cell whose value selects the *table* of another
reference cell. "Delete" is cells ceasing; "disconnect" is a reference cell becoming null
or a junction key's cells ceasing. There is no other fact.

**D2 — Pattern.** A pattern is a finite set of cells whose values are literals or
variables, plus constraints on them, plus an *arm tag* on cells that belong to a branch.
Patterns compose in exactly one way: **extend along a reference cell**. `include`,
`where.some`, `create`, `connect`, `delete` are all this extension, in different modes.

**D3 — Mode.** A pattern is used in one of three modes:

| mode | meaning | public names |
|---|---|---|
| **match** | bind the pattern's variables from the database | findMany, select, include, where, relation filters, every probe and locate |
| **assert** | make the database satisfy the pattern | create, connect, set, update, createMany, updateMany |
| **retract** | make the database not satisfy it | delete, disconnect, deleteMany, set's departures |

**merge** is derived: match, then assert whatever is unbound (`connectOrCreate`,
`upsert`, `skipDuplicates`). This is openCypher's clause set (`MATCH`, `CREATE`/`SET`,
`DELETE`, `MERGE`) applied one reference at a time.

**D4 — Binding and single assignment.** A variable is bound by exactly one of: a literal
in the payload, a client-side generator, the database (a matched value, or a value a
statement returns). **A variable is bound once.** A key that changes is two variables,
`k` and `k′`. This one rule is the whole of "old-read / new-write sources",
"captured versus final row key", "selected-row continuity", and "reset on retry".

**D5 — Schedule.** Statements are nodes that bind variables (matches, `RETURNING`,
insert ids) and consume them (parameters). Order is dataflow with one anti-dependency:

> use a variable after it is bound; read `k` before the statement that binds `k′`.

Per **fragment**, all matches run before any assert or retract. A fragment boundary is
derived: it is any point where a variable's only binding source is execution (a
database-generated key the provider cannot return in the same statement; a bulk row
that must observe the previous row's assertions).

**D6 — Premise.** An assertion relies on the bindings its match produced. The premise is
that they still hold at assert time. Three substrates are three enforcements of the same
premise: a locked match (transaction), a guard statement re-running the match (atomic
batch), the guard repeated in each later batch (segments). The engine states premises;
the executor enforces them.

Legality is a property of the pattern, not a mechanism: within a fragment, the match
set and the assert set must not overlap, or match-first and sequential semantics would
disagree. That is the "same-operation feedback" refusal.

---

## 3. The vocabulary table (sugar)

The public verbs are rows in a table that says which mode, which cells, and which arms.
This is the only place a verb name appears in the engine.

| verb | pattern (N = the parent's neighbour set along the edge; X = target) |
|---|---|
| `connect X` | match X by selector; assert reference cell(s) so X ∈ N |
| `create X` | assert X at a fresh key; assert reference cell(s) so X ∈ N; recurse into X's payload |
| `connectOrCreate X` | merge: match X by selector; arm *found*: assert X ∈ N; arm *missing*: as `create` |
| `disconnect X` / `disconnect: true` | retract reference cell(s) (null the FK, or retract the junction key) for X, or for all of N |
| `set S` | retract reference cells for N \ S; assert them for S \ N (junction: retract all of N then assert S — the pinned form; see §6 review) |
| `update X` | match X ∈ N by selector; assert X's scalar cells; recurse |
| `upsert X` | merge: match X ∈ N; arm *found*: as `update`; arm *missing*: as `create` |
| `delete X` / `delete: true` | match X ∈ N; retract all cells of X (dependents first by the schedule) |
| `updateMany` / `deleteMany` | assert / retract over the set-valued key variable matching a predicate under N |
| `createMany` | assert N fresh keys; recurse only when rows carry relation payloads |
| polymorphic direct payload | the same rows; the reference cell's table is bound from the payload's variant |

Top-level operations are the same rows with no incoming edge: `update` is match by
`where` then assert; `upsert` is merge at the root; `create` is assert at a fresh key;
`createMany` without relation payloads is one set assertion; `findMany` is match with a
projection.

**Further compression available.** `set` is `retract ∘ assert`, `connectOrCreate` and
`upsert` are `merge` with different arm bodies, `disconnect: true` is `retract` with an
unbound target. Six primitive rows (match, assert-fresh, assert-at-key, retract, merge,
set-op) generate the eleven. Keep the eleven as the public table for readability; the
six are what the construction code implements.

> **Adversarial review.** *Failure:* the table is written per storage kind again ("junction
> connect", "FK connect"), reintroducing the axis. *Prevention:* the rows above mention
> cells, never columns. Which cells a reference occupies comes from §4, and the row is
> total over all storages by construction. A census test greps this file's construction
> module for storage words (`junction`, `foreignKey`, `polymorphic`) and fails on any hit
> outside the cell map.

---

## 4. The cell map (schema data)

`relation-resolution.ts` already publishes one `ResolvedSlot` per (model, field) with the
owner side, the referenced fields, the junction topology, and the variant storage. The
engine reads it through one derived view:

```ts
interface ReferenceCells {
  // where the reference lives, as cells; never a "position" word
  readonly holder: { table; keyColumns };            // the row that stores the reference
  readonly referenced: { table; keyColumns };        // the row whose key is stored
  readonly cells: readonly { holderColumn; referencedColumn }[];   // paired members
  readonly viaJunction?: { table; sideA; sideB };    // a fresh key with two references
  readonly discriminator?: { column; value: TableVariable | literal }; // (type, id)
  readonly unique: boolean;                          // cardinality one ⇒ uniqueness on the holder cells
  readonly onKeyChange: "cascade" | "restrict" | "setNull" | "none"; // referential action
  readonly nullable: boolean;                        // may the reference cell be retracted
}
```

Every storage-specific question in the engine today is a field here:

| today | cell-map field |
|---|---|
| `position: parentHeld / childHeld / junction` | `holder === source` / `holder === target` / `viaJunction` |
| `membership.kind: foreignKey / polymorphic / junction` | `discriminator === undefined` / `discriminator` / `viaJunction` |
| singular junction inverse, "slot" | `viaJunction && unique` |
| polymorphic collection member | `viaJunction` with `discriminator.value` a table variable |
| `clearableForeignKeyFields`, `relation-nullability.ts` | `nullable` |
| `onUpdate` action in `relation-membership.ts` | `onKeyChange` |

> **Adversarial review.** *Failure 1:* a direct polymorphic payload and a fixed inverse
> topology get coerced into one carrier (ATOM §7 warns against this). *Prevention:* the
> discriminator's value is either a literal (fixed inverse) or a table variable bound from
> the payload (direct); both are the same cell, differently bound — that is D4, not a
> carrier. *Failure 2:* the compound-key pairing is re-paired by index somewhere.
> *Prevention:* `cells` is the one pairing, published lazily by the resolver as today
> (the mismatched-metadata refusal keeps its position in error order). *Failure 3:* the
> map is recomputed per operation. *Prevention:* it is a view over the resolved index,
> computed once per schema.

---

## 5. Pattern construction at the parse boundary

Today validation walks the payload with complete schema knowledge, produces a
normalized JSON, and the engine walks it again (`relation-mutation-parser.ts`,
`relation-data-builder.ts`, `to-one-composition.ts`, `polymorphic-mutation.ts`: 2.2k lines
measured). In the ideal state the operation schemas **emit the pattern** as their
transformed output.

Rules the construction must keep:

1. **Lazy and per fragment.** Client-side defaults are thunks materialised at parse
   (`ulid`, `cuid`, `@now`). A nested `create` under `updateMany` must materialise them
   per captured member. Therefore a fragment's pattern is constructed when the fragment
   is opened, from raw data retained for that purpose — exactly as `NestedSelectedRecordSeries`
   does today (AGENTS "Record series"). The pattern is a per-fragment value, not a whole-tree
   value.
2. **Both arms present, one arm inert.** A merge's two arms are both in the pattern as
   cells with arm tags, because legality (§6.4) and the match phase (§6.3) need both.
   The untaken arm's *scalar* cells are never validated deeper than shape, and its
   assertions are never packed. This reproduces today's "established shape parsing can
   remain eager; effects and deferred legality run only for the selected arm" (ATOM §19).
3. **Construction is total.** Pattern construction may refuse only what validation
   refuses today at the same position in §19's order (whole-argument validation,
   portable-primary-key validation, relation-key legality). Every other refusal that
   today fires "at construction" (unsupported shapes, the N>1 root child-held move, a
   plural generated key with no locator) moves to **packing** (§7), after legality. This
   is what preserves the pinned precedence "OwnWrite before construction refusals"
   without a deferred-refusal mechanism.
4. **Exact shapes.** A to-one edge yields at most one target cell group per arm; there is
   no plural array to index. The 37 `[0]` reads and 59 restated refusals measured in the
   kernel cannot exist because the shape cannot express them.

> **Adversarial review.** *Failure 1:* validation becomes engine-aware and the two layers
> fuse into one 25k-line blob. *Prevention:* the schema layer's output type is `Pattern`,
> a value with no engine imports; the engine imports the type, validation imports
> nothing from the engine. The dependency arrow does not change direction. *Failure 2:*
> non-idempotent transforms get re-applied because a pattern is re-derived from a
> transformed payload. *Prevention:* patterns are derived from raw input once per
> fragment; there is no transformed intermediate to re-feed. *Failure 3:* error order
> moves because construction refuses something earlier than today. *Prevention:* rule 3
> plus a census: the construction module may throw only `ValidationError`; every
> `QueryEngineError`/`NestedWriteError` site lives in packing or scheduling, after
> legality.

---

## 6. The scheduler

### 6.1 Variables and single assignment

Every cell in a pattern carries a variable or a literal. Variables are allocated in
payload order (the parsed collection order ATOM §5 defines: ordinary relations in key
order, then polymorphic ones). A key transition — a scalar update of a key member, or a
parent-held fold whose foreign key *is* the record's key — allocates `k′` beside `k`.
Nothing is rebound. Retry (§8.4) re-runs construction and allocation from scratch.

### 6.2 Dataflow order and the anti-dependency

Edges of the dataflow graph:

- **use-after-bind:** a statement that consumes `v` follows the statement that binds `v`;
- **read-before-rebind:** a match or assert that consumes `k` precedes the statement
  that binds `k′`;
- **cascade:** when `onKeyChange === "cascade"`, the database itself binds the
  dependents' reference cells to `k′` at the root statement. The scheduler models this as
  a pseudo-statement that binds those cells; assertions of those same cells after the
  root are therefore *dead* (already bound) and are not emitted. This is today's
  "current-membership writes precede the transition so `ON UPDATE CASCADE` carries
  them" (`RecordUpdateCompiler.ts:1479-1488`), derived instead of placed;
- **no cascade:** a dependent reference to `k` that is not itself re-asserted is an
  occupied slot; the scheduler emits a premise "no row references `k`" before the root
  statement, which is today's occupied-slot refusal, and a polymorphic inverse (no DB
  FK) always takes this path.

Within one dependency level the tie-break is payload order. **This tie-break is the
contract that reproduces today's statement order and step positions**; §12.3 records
what happens if it does not.

### 6.3 Fragments and the match phase

A fragment is a maximal prefix of the dataflow order with no execution-only binding.
Inside a fragment, **all matches run first**, grouped by dependency level so independent
probes share a round trip (today `executePlanningLevels`), then all asserts and
retracts. The match phase includes the matches of *both* arms of every merge, with the
untaken arm's outputs optional — today's "planning superset" (`Part.ts:41-58`,
`conditionalArmPlanning`), reproduced rather than forked. Decision matches lock where
the substrate supports it (ATOM §11).

A fragment boundary is opened by:

- a database-generated key on a provider that cannot bind it in the same statement
  (§9.2: the driver declares how it binds generated keys);
- a bulk row with relation payloads (row N must observe row N−1: AGENTS core rule 7);
- a merge whose outcome must be observed before dependents assert (`skipDuplicates`
  beside relation data: the root's row count decides whether the subtree runs).

Fragments are today's `RecordSeriesStep`, the progressive segments, and the
generated-output boundary, as one derived predicate.

### 6.4 Legality

For each fragment: `matches(fragment) ∩ asserts_before(match) = ∅`, where overlap is
decided by cell identity with the certainty rule that `TargetConstraint.ts` implements
today (an exact key overlaps only an equal key; an unknown key overlaps everything on
that table; a predicate overlaps when its fields intersect). Both arms of every merge
contribute their matches and their asserts (the arm that is not taken still counts, as
`OwnWriteSteps.ts:463-509` does today). Deduplicated `connectOrCreate` targets within one
fragment overlap by design and are exempt (first-create-wins: the second occurrence
takes the first's variable, so there is no second match).

Legality runs after construction and before packing, i.e. before any refusal that today
belongs to construction of Parts — see §5 rule 3. The refusal text and code are
unchanged (`NestedWriteError`, V7001, "Split these operations into separate queries").

> **Adversarial review.**
> *Failure 1 (order):* the dataflow tie-break does not reproduce the pinned order for
> some family (the transition parity file pins 77 ids; the record-compiler contract 121).
> This is the single largest risk in the plan and it is *measurable before commitment*:
> the junction slice (§12.1) diffs order step by step. If a family's pinned order is
> neither payload order nor dependency order but a historical accident, that is a
> decision (§12.3), not a design failure.
> *Failure 2 (compound key partial transition):* only one member of a compound key
> changes. Variables are per cell, so `k′` is allocated for the changed cell only; a read
> "before rebind" uses all current cells, a write "after" uses the mixed tuple. That is
> what the dual-source binding does today member by member (`relation-membership.ts`).
> *Failure 3 (cascade modelled wrongly):* a dependent assert after the root is emitted
> anyway, producing a redundant UPDATE that today does not exist, changing statement
> bytes. *Prevention:* the cascade pseudo-statement binds the cells; the packer never
> emits an assert for a bound cell with an equal value (§7.1's agreement rule).
> *Failure 4 (legality over both arms reintroduces a walk):* no — arms are cells in
> the same pattern; the overlap test iterates the pattern once. What it must not do is
> derive facts from the *packed statements* (a nullable-FK `set` plans no departing
> read but asserts a membership-read fact today); facts come from the pattern's
> matches, which include the decision matches whether or not the packer later folds
> them away.
> *Failure 5 (fragment cut too eager):* a generated key used only by a terminal
> `select` forces a fragment on a non-RETURNING provider where today one focused
> post-insert read suffices inside the transaction. *Prevention:* an execution-only
> binding cuts a fragment only when the substrate has no in-fragment binding for it;
> the transaction substrate always has one (a focused read), so cuts occur only on
> batch substrates — matching today.

---

## 7. Packing: cells → statements

### 7.1 Grouping

Cell assertions at one key pack into one statement: all cells of a fresh key →
`INSERT`; some cells at a bound key → `UPDATE`; all cells retracted → `DELETE`; a
match → `SELECT`. A junction is a fresh key with two reference cells and packs like any
insert. "Fold the FK into the root INSERT" is not a decision: the reference cell's key
was bound before the root was packed, so it is one of the root's cells.

Two contributions to the same cell must agree (a parent-held fold and a scalar SET
naming the same column; a cascade-bound cell and an explicit assert). The agreement
rule is today's `final-root-assignment.ts` (equal proven sources collapse; opaque or
conflicting sources fail closed) — kept as the packer's one merge rule, ~150 lines.

### 7.2 Set forms

- N independent assertions of the same shape at fresh keys with no execution-only
  bindings between them pack into one multi-row `INSERT`, chunked by the driver's bind
  budget from the compiled parameter count (today `bind-budget.ts`, kept). This is
  `createMany`.
- An assert or retract over a set-valued key variable packs into one predicate
  `UPDATE`/`DELETE`; `AndReturn` is the match that follows. This is
  `updateMany`/`deleteMany`.
- A merge over a set on a dialect with a native conflict clause packs to one statement
  (`ON CONFLICT DO NOTHING` / `INSERT IGNORE`); the captured set is a variable bound by
  `RETURNING` where available. Which unique can name a row's conflict is a cell-map fact
  and decides the four per-row dispositions of a junction `createMany` (ATOM §17).
- A merge one key deep on a dialect with targeted upsert packs to one statement — the
  upsert `ON CONFLICT` fold.

### 7.3 Departures and slots

- `set S` on a nullable reference cell: retract for N \ S (one predicate UPDATE), assert
  for S \ N. On a non-nullable cell, a departure is either a row retract or a refusal;
  the refusal is a premise "N \ S = ∅" (today's `guard.departing`).
- A `unique` reference cell (cardinality one) being asserted for X when it is occupied
  by Y: retract Y's cell, then assert X's, under the premise "the occupant is Y". That is
  the singular slot transfer with its CAS; the executor enforces the premise (§8).

### 7.4 Packing-time refusals

All refusals that are not validation and not legality live here and only here, after
legality, before any statement executes: unsupported shapes (a root child-held move with
N>1 captured roots; a plural database-generated key with no complete literal locator; a
dynamic series inside `$transaction([...])`; a non-transactional clear that would split a
collection barrier). They keep their current error classes and messages. The guard
ownership ledger continues to census them.

> **Adversarial review.**
> *Failure 1 (the packer cannot reproduce pinned bytes):* hand-written statement shapes
> exist that a generic packer would not choose (`findUnique`'s raw `LIMIT 1` versus a
> bound limit; `1 = 0` as a false condition in junction statements; the `";\n\n"` join in
> one SQLite DDL path; junction insert chunk ids). *Prevention:* the packer emits through
> the adapter's existing methods (`mutations.insert`, `filters.*`, `json.*`), so a shape
> is reproduced if the same adapter method is called with the same arguments. Every shape
> that still differs is a **special case counted in the slice** (§12.1). This is the one
> term in the size estimate that is not a design fact; §11 carries it as ±5k.
> *Failure 2 (bulk folds change semantics):* packing N single-row asserts into one
> multi-row statement changes trigger cardinality and error attribution. *Prevention:*
> the fold is applied only where today's engine already emits one statement (the
> scalar-only `createMany`, `updateMany`, `deleteMany`); rows carrying relation payloads
> are separate fragments by §6.3 and are never folded — exactly ATOM §17.
> *Failure 3 (junction `set` order):* the natural packing is retract N\S then assert S\N;
> the pinned junction form is clear-all then insert-all with a bind-budget chunk order
> and the first chunk using the `set.insert` id. *Prevention:* the sugar row for `set`
> on a junction cell says retract-all then assert-all; the id/chunk order is a §12.3
> decision if the packer's chunking differs.

---

## 8. Premises and executors

### 8.1 What a premise is

Every match in the match phase states one premise for the assertions that consume its
bindings: `exists(key)` when the match found the row (non-raceable: the row was replaced
or removed after the decision), `notExists(selector)` when it did not (raceable when a
same-target unique constraint will catch the race, otherwise not), `occupant(slot) = Y`
for a unique reference cell. Raceability is derived from the cell map (is there a unique
constraint on the target that the missing arm's insert will violate) — today's Pin Rule
(ATOM §12), stated once.

### 8.2 Three enforcers

| substrate | match phase | premise enforcement | postconditions |
|---|---|---|---|
| transaction | executed per dependency level, decision matches locked (`FOR UPDATE` where supported) | the lock is the premise | `expects` checked before commit |
| atomic batch | executed per level in a preceding round trip | one guard statement per premise, before the writes, stable order inside both buckets | postconditions the batch cannot enforce are stripped (today's behavior) |
| committed segments | per fragment as an atomic batch | inherited premises (the parent's liveness and the exact referenced tuple) re-asserted in every later fragment | progress reported as `recordSeriesProgress`; a later failure keeps acknowledged fragments |

The segments enforcer is the batch enforcer applied to a list of fragments with two
additions: inherited premises are matches that reappear in each fragment (a fact the
cell map states: a junction side and a polymorphic inverse reference the complete row
key, so their membership premise is empty), and the merge-outcome cut (a
`skipDuplicates` root observed before its subtree). `supportsOrderedCommittedSegments`
and D1's per-statement `last_row_id` remain driver facts consumed here.

### 8.3 Attribution

A statement carries the table of its key cells; the executor re-attributes provider
failures to that model (today `step.model`). Guards and postconditions are engine-owned
failures and keep the operation's attribution.

### 8.4 Retry

A retryable race (the missing arm's unique violation, classified by the driver's error
mapping against the premise's constraint) re-runs the operation: construction,
allocation, scheduling from scratch, fresh variables. On segments, only the current
fragment is retried after a committed prefix, as today. Determinism over (payload,
matched values) is a property of the design, not an invariant that needs a reset block.

> **Adversarial review.**
> *Failure 1 (guard bytes):* today some batch guards are not the match re-run: the
> probe-first scalar upsert reasserts selector-plus-captured-key and a *second* raceable
> absence guard in a fixed order (ATOM §15); the singular transfer's capture is
> `LIMIT 2` while its guard is `take: 1 where target = key`. *Prevention:* a premise may
> carry an explicit guard statement supplied by packing when the re-run of the match is
> not the pinned guard; the enforcer uses it verbatim. That keeps bytes and is a
> bounded list (the slice counts it). *Failure 2 (locks):* the transactional enforcer
> locks every decision match where today only "required target reads lock"; extra
> locks change contention. *Prevention:* the premise kind says whether the match is a
> decision read; only those lock, as today. *Failure 3 (stripping postconditions in
> batch hides failures):* today's behavior; the batch executor fails closed only on
> postconditions it *could* enforce and does not. Unchanged.

---

## 9. Match mode, decoding, and what leaves the engine

### 9.1 Match mode

A read is the same recursion in match mode with a projection. The pattern extended
along a reference cell becomes a correlated subquery aggregated to a row (to-one) or a
JSON array (to-many, via the adapter's aggregation), with the nested window (order,
take, skip, cursor, distinct) inside the subquery. Filters are the same extension under
`EXISTS` / `NOT EXISTS`; `every` is the negation stated once (no member violates, and no
member of another variant exists), which is today's two-conjunct form. Relation
`_count` and relation-aggregate `orderBy` are correlated scalar subqueries over the same
extension. Row-held versus junction versus member-junction traversal is the cell map
saying how many tables the reference crosses. The eight include spellings and the
duplicated request walk (select-builder and result-shape) collapse to one traversal that
emits the SQL and *is* the expected shape.

### 9.2 Decoding is match backwards

Provider rows are validated against the pattern (the pattern is the expected shape) and
decoded cell by cell through the codec table that validation primitives already own for
each scalar type. Relation carriers (JSON) and polymorphic arms (a table variable bound
by the discriminator value in the row) are the same walk. The container policy
(identity / reusable / copy) becomes a driver fact sealed at construction (the
immutable-driver-fact mechanism), consulted per row set; the supplied-client rule
(borrowed transport) is a constructor input to that fact, exactly as Rule 5 requires,
and reconnects re-seal it per transport.

### 9.3 What leaves the engine, and to where

| leaves | to | why it was here |
|---|---|---|
| generated-key transports (`RETURNING`; focused re-select by insert id or literal unique; statement-local insert id; CTE fold) | adapters and drivers, as one declared capability `bindsGeneratedKey` | the engine only needs "can this statement bind this variable on this substrate" |
| JSON-path filter grammar and dialect JSONPath spelling | adapters (grammar validated at the boundary) | dialect-dependent |
| cursor form choice (sargable row-value vs null-aware expansion) | adapter capability | dialect-dependent |
| per-type scalar decoding | the codec table in validation primitives | a cell-type property |
| cache snapshot codecs | cache layer, as a generic tagged encoding of provider-native values (`Date`, `Buffer`, `bigint`) | the cache re-decodes provider rows through the normal decoder; it still has to serialise provider-native values for KV |
| pending operation, one-shot execution, request → validate → intercept → statement → observe seams, cache flow, instrumentation facts | client, cache, instrumentation | the client lifecycle, not the engine |

> **Adversarial review.**
> *Failure 1 (decoding through the validation library is slow):* the `v` validators
> collect issues and are built for input; today's row parsers compile from the first
> validated row and reuse. *Prevention:* compile one row validator per pattern once
> (the library already interns schemas by state); benchmark against
> `bench:operation-pipeline` before keeping it; if slower beyond noise, keep a compiled
> row parser built *from the pattern* — still one walk, one shape. *Failure 2 (the cache
> codec does not vanish):* provider rows contain non-JSON values, so a serialiser
> remains. It is generic over provider-native types (≈200 lines) instead of per result
> shape (≈1,000 today), and it lives in the cache. *Failure 3 (moving transports to
> adapters spreads engine knowledge into three dialect files):* the moved code is
> exactly the dialect-specific part (how to spell `RETURNING`, a CTE fold, an insert-id
> read); the decision of *when* stays in §6.3. The adapter's contract gains one method
> family and one capability flag, not engine semantics.

---

## 10. Failure register

Every foreseeable failure from the reviews above, with the gate that catches it before
it ships.

| # | failure | gate |
|---|---|---|
| F1 | the dataflow tie-break does not reproduce a pinned statement order | the slice diff (§12.1) reports order first; a mismatch is a §12.3 decision |
| F2 | a packed statement's bytes differ from a pinned shape | the slice counts special cases; each is either an adapter call fixed or an explicit packer rule |
| F3 | error precedence moves (construction refusal before legality) | census: construction throws only `ValidationError`; §19 order test on a double-fault payload |
| F4 | untaken-arm reads or locks differ from the pinned planning superset | match phase includes both arms; premise kind decides locking; parity-b upsert-arm pins |
| F5 | cascade modelled as an explicit assert (redundant UPDATE) | packer's agreement rule drops asserts of already-bound cells; transition parity pins |
| F6 | fragment cut where today one focused read suffices | cut only when the substrate declares no in-fragment binding; generated-identity demand tests |
| F7 | bulk fold changes trigger cardinality or attribution | fold only where today emits one statement; relation-bearing rows are fragments |
| F8 | junction `set` chunk ids / order differ | sugar row states retract-all-then-assert-all; id scheme is a §12.3 decision |
| F9 | decoding through validators is slower than compiled parsers | benchmark gate; fallback to a pattern-compiled row parser |
| F10 | the cache still needs a codec | generic provider-native serialiser in the cache layer; budgeted at ≈200 lines |
| F11 | the sugar table or construction grows storage-word branches | grep census on the construction module |
| F12 | validation becomes engine-aware | `Pattern` is a value type without engine imports; dependency arrow census |
| F13 | defaults materialised once for N members | per-fragment construction from retained raw data (today's rule) |
| F14 | polymorphic direct and inverse coerced into one carrier | discriminator literal vs table variable, same cell; polymorphic write-family tests |
| F15 | premises derived from packed statements instead of the pattern (loses the nullable-FK `set` membership fact) | legality reads the pattern's matches; own-write linearization tests |
| F16 | the progressive enforcer loses root-conflict isolation | the merge-outcome cut is a fragment boundary; create-many skip tests on the batch leg |
| F17 | step ids observable somewhere unpinned | D0 census found them only in internal-invariant error text; positions replace them; 13 files / ≈170 assertions re-pinned as behavior |
| F18 | the 123 test files that import engine internals have no oracle after the rewrite | the planning-driver harness diffs fragments step by step on both substrates, independent of internals; behavior files are untouched |

---

## 11. Size (estimate)

Physical lines at the repository's comment density (about 25%).

| part | today (measured) | ideal | what remains and why |
|---|---:|---:|---|
| construction (sugar table, cell-map view, pattern from raw input) | 9.5k | 1.0k | six primitive rows generate eleven; cell map is a view over the resolved index |
| scheduler (variables, dataflow, anti-dependency, fragments, legality) | 27.6k + 3k | 2.0k | one sort with one tie-break; overlap classification |
| packing (grouping, agreement rule, set forms, departures, slots, refusals) | (spread) | 2.5k | the statement shapes and the enumerated refusals |
| executors (transaction, batch, segments, retry, attribution) | 4.9k | 1.8k | the segments enforcer is the largest single piece |
| match mode (include, filter, orderBy, cursor, aggregates, groupBy, distinct, window) | 10k | 2.4k | projections and the nested window |
| decoding (row validation from the pattern, carriers, polymorphic arms, decode chain, container policy) | 5.4k | 1.7k | the decode chain and the reentrancy rule stay |
| entry and result plumbing | 5.6k | 0.5k | `run(pattern, driver, hooks)` |
| **engine** | **60.2k** | **≈ 12–14k** | |
| relocated (transports, JSON path, cursor choice, scalar decode, cache serialiser, client lifecycle) | — | ≈ 4k | not deleted; owned where the knowledge is |
| packer special cases for pinned bytes | — | **±5k** | the one non-design term; measured by the slice |

The engine's own footprint falls by roughly 75%; the sum of engine plus relocated code by
about 70%. Below this there is SQL and provider protocol.

Two comparisons to keep the number honest: the adversarial session's estimate for the
same features on today's architecture with a coroutine was ≈40k; the blind session's
from-scratch estimate before it read the doctrine was 4.4k for write lowering plus
schedulers, and 12k after it priced the semantics it had missed. This document lands
between them because it keeps every semantic the adversary listed and removes every
copy the blind session did not know existed.

---

## 12. Delivery

### 12.1 The falsifier, before anything else

Prototype the junction reference cell — all eleven verbs, the singular slot transfer,
the collection barrier, bind-budget chunking, first-create-wins — as pattern →
schedule → packing, under a selected root (`update`), and diff it against today's
compiled fragments step by step (id position, kind, SQL text, parameters, outputs,
postconditions, race pin, guard premise and raceability) on the planning driver with
both substrate settings. Oracles that already exist: `m2m-mutation.test.ts`,
`link-in-list-fold.test.ts`, `nested-junction-target-recursion.test.ts`,
`polymorphic-collection-write-family.test.ts`, `parity-j-create-many.core.test.ts`,
`record-compiler-contract.core.test.ts`, `create-many-bind-budget.test.ts`.

Outputs of the slice, each a number: order mismatches (F1), byte special cases (F2),
guard-shape special cases (§8 review), untaken-arm read differences (F4). Those four
numbers decide whether §11's estimate stands.

### 12.2 Then, in order

1. Child-held reference cell under a transitioning root, against the 77 pinned ids of
   the transition parity file: where cascade and the anti-dependency must reproduce
   before/after placement.
2. Parent-held reference cell with the agreement rule; delete both record compilers.
3. Legality over the pattern; delete the shadow interpreter; the double-fault
   precedence test pins the order.
4. Executors: transaction, batch, segments; delete the per-Part batch arms and the
   two-method interface.
5. Match mode against the read byte-pin file; decoding from the pattern; delete the
   second request walk.
6. The moves of §9.3, each with its census update.

Each step passes the raptor plan's keep gates (a representation or copy deleted, no
coexistence, census-proven, bytes reported, a named falsifier red when broken) before
the next starts. The full validation ladder (`test:types`, the write-engine project,
adapters, drivers, client, `package:build`, `size`, `test:all`, provider suites with
skipped legs recorded) runs per retained step.

### 12.3 Decisions only the maintainers can make

| decision | if kept as contract | if re-decided |
|---|---|---|
| exact step-id spellings (`tag.find#1`) | the scheduler reproduces the tie-break and label scheme; ≈170 assertions untouched | ids become positions; 13 files re-pinned as behavior probes |
| batch guard bytes that differ from the match re-run | premises carry explicit guard statements from packing | guards derive from the match; bytes change, semantics do not |
| untaken-arm reads issued and locked | the match phase includes both arms (default in this design) | fewer statements; lock footprint shrinks |
| own-write refusal precedence over packing-time refusals | §5 rule 3 preserves it | not needed |
| junction `set` as clear-all then insert-all with today's chunk ids | sugar row + explicit id scheme | natural retract/assert of the difference |

None of these changes a public result, an SQL semantic, or a failure code. They are the
only places where "the same rocket" and "fewer parts" pull in different directions, and
they are small.

---

## 13. Implementation plan

### 13.1 Strategy

The engine is written whole, not in slices, and validated by **differential and
deterministic simulation testing** against the existing engine, which stays in-tree as
the oracle until the last diff is green. Slicing would force the new abstraction into
the old seams (`Part`, `StepScope`, the two record compilers) and distort it; a rewrite
with a deterministic oracle on both substrates is the case where differential testing
is strictly better.

Two rules hold for the whole period:

- The old engine is untouched and remains the default; the new engine is reachable only
  through a private, non-exported switch used by the harness. Nothing public changes
  until §13.7's exit criteria are met, and then the old engine is deleted in one commit.
- Every divergence the harness finds is **classified before it is fixed** as one of:
  design gap (the model cannot express it), packer special case (bytes), or maintainer
  decision (§12.3). The counts are reported per integration milestone; a fix that is not
  classified does not merge.

### 13.2 Day 0 — contracts (one session, one day, serial)

Everything else depends on four frozen definitions. They are written first, reviewed
once, and changed afterwards only by a recorded decision.

| contract | content | consumers |
|---|---|---|
| **K1 `Pattern`** | cells `(table, key, column)` with literal or variable values; variables with their binding source (`literal | generated | matched | returned`); arm tags; mode per cell group; the extension edge (which reference cell a child pattern hangs from). A value type with no engine imports. | C, D, G, the generator's expected-pattern fixtures |
| **K2 `ReferenceCells`** | the cell-map view of §4 over `ResolvedRelationIndex`: holder, referenced, paired cells, `viaJunction`, `discriminator`, `unique`, `onKeyChange`, `nullable`. | C, D, E, G |
| **K3 `Statement` / `Premise` / `Fragment`** | a statement (kind, table, cells consumed and bound, outputs, `expects`, `model`); a premise (kind `exists | notExists | occupant`, key or selector, raceable, optional explicit guard statement); a fragment (ordered statements, premises, boundary reason). | D, E, F |
| **K4 fragment-dump JSON** | the canonical form both engines emit for the differential: position, kind, SQL text, parameters, outputs, `expects`, race pin, guard premise + raceability, model. Sorted keys, stable number formatting. | A, D/E, F, the CI diff |

Module layout, disjoint by stream so parallel work does not collide:

```text
src/query-engine/pattern/
  pattern.ts            K1
  cells.ts              K2 view over the resolved index
  sugar.ts              §3 table (eleven rows over six primitives)
  construct.ts          C — validated payload → Pattern
  schedule.ts           D — variables, dataflow, fragments, legality
  pack.ts               E — cell groups → statements via adapters
  execute/
    transaction.ts      F
    batch.ts            F
    segments.ts         F
    retry.ts            F
  match.ts              G — pattern → SELECT
  decode.ts             G — provider rows → results from the pattern
  run.ts                entry: run(pattern, driver, hooks)
tests/pattern/
  harness/              A — dump today's engine and the new engine in K4
  generator/            B — seeded payload corpus
  fixtures/             hand-written Pattern / Statement / Fragment fixtures for D, E, F
  differential/         compile-level and execution-level diffs
```

### 13.3 Units of work

Each unit names its inputs, its output, its own test until integration, and its
estimated size. "Own test" means the unit is green on fixtures before any integration;
integration adds the differential.

| id | unit | needs | delivers | own test | est. lines |
|---|---|---|---|---|---:|
| **A** | Oracle harness | K4 | dumps of today's engine for any payload, both substrate settings, via `routing.ts` → `planning()` on the planning driver → `compile(known)` | golden dumps for the 243 existing write contracts and the read byte-pin corpus | 600 (test code) |
| **B** | Payload generator | operation schemas | seeded, shrinkable corpus: root op × model × recursive relation keys × verbs admitted at that depth; a valid mode and an invalid mode; existing contract payloads as fixed seeds | every generated valid payload passes validation; every invalid one is refused | 900 (test code) |
| **C** | Construction | K1, K2 | `Pattern` from a validated payload; per-fragment construction from retained raw data (defaults per member); both arms present; total (throws only `ValidationError`) | hand-written expected patterns per verb × storage; the throw-class census | 1,000 |
| **D** | Scheduler + legality | K1, K2, K3 | variables with single assignment (`k`/`k′`), dataflow order with the anti-dependency and the cascade pseudo-statement, payload-order tie-break, fragment cut, match-then-assert per fragment, overlap legality over both arms | hand-written pattern fixtures with expected orders; the double-fault precedence test; overlap cases lifted from the own-write suites | 2,000 |
| **E** | Packer | K3, adapters | cell groups → `INSERT/UPDATE/DELETE/SELECT` through existing adapter methods; agreement rule; set folds; departures and slots; packing-time refusals; bind-budget chunking | statement byte fixtures lifted from A's dumps, per shape | 2,500 |
| **F** | Executors + simulated driver | K3 | transaction, atomic batch, segments enforcers; retry; attribution; a seeded, fault-injecting simulated driver (unique violation at statement N, batch failure at segment N, premise invalidated between match and assert, malformed row K, disconnect mid-transaction) | hand-written fragment fixtures with expected statement sequences and outcomes under each injected fault | 1,800 + 700 (driver) |
| **G** | Match + decode | K1, K2, adapters | pattern → correlated SELECT with nested windows, filters under `EXISTS`, `_count`, relation-aggregate orderBy, cursor, aggregates, groupBy; row validation and decoding from the pattern; container policy as a sealed driver fact | the read byte-pin file and its snapshot; `sql-generation.core.test.ts`; result-parser contracts | 4,100 |
| **H** | Layer moves | none | adapter/driver capability `bindsGeneratedKey` with the four transports; JSON-path and cursor-form choice in adapters; scalar decode in the codec table; cache serialiser for provider-native values; pending-operation lifecycle and seams in the client | each move's existing suites; a census per move | 4,000 relocated |
| **I** | Integration + triage | A–F | the compile-level and execution-level differentials wired in CI; the divergence classifier and its report | the diff itself | 400 |

D and E share the hot spot that decides pinned statement order (tie-break × packing
order); they are one owner or two owners in one channel. Everything else is disjoint by
module.

### 13.4 Parallel streams and the dependency graph

```text
day 0   K1 K2 K3 K4 ─────────────────────────────────────────────────────────── serial
           │
day 1   ┌──┴──────────────┬──────────────┬─────────────┬─────────────┬───────────┬──────────┐
        A oracle          B generator    C construct   D schedule    E pack      F execute  G match   H moves
        (K4)              (schemas)      (K1,K2)       (K1,K2,K3)    (K3)        (K3)       (K1,K2)   (—)
        │                 │              │             │             │           │          │         │
        └────────┬────────┘              └──────┬──────┴──────┬──────┘           │          │         │
                 │                              │             │                  │          │         │
     M1 compile-level differential ◄────────────┴─────────────┘                  │          │         │
                 │                                                               │          │         │
     M2 execution-level DST ◄────────────────────────────────────────────────────┘          │         │
                 │                                                                          │         │
     M3 read parity + decode parity ◄───────────────────────────────────────────────────────┘         │
                 │                                                                                    │
     M4 moves merged, censuses updated ◄──────────────────────────────────────────────────────────────┘
                 │
     M5 behavior estate on PGlite + docker providers against the new engine; old engine deleted
```

Eight streams start on day 1. Critical path: K → C+D+E → M1 → F → M2 → M5. G and H are
off the critical path until M3/M4 and can absorb slack.

Suggested staffing for agents in worktrees: one session per stream, disjoint paths
under `src/query-engine/pattern/` and `tests/pattern/`; D and E in one session; I is the
integrator and the single triage owner.

### 13.5 Milestones and their numbers

Each milestone publishes the same four counts, and a milestone is not passed until they
are classified:

| milestone | what runs | counts reported |
|---|---|---|
| **M1** compile-level differential | for every corpus payload, both substrate settings: K4 dump of old vs new, byte-equal | order mismatches; byte special cases; guard-shape special cases; untaken-arm read differences; error identity/precedence mismatches on the invalid corpus |
| **M2** execution-level DST | both engines on the simulated driver, same seed and fault schedule | statement-sequence divergences; result divergences; error class/code/message/meta divergences; instrumentation-fact divergences; retry and `recordSeriesProgress` divergences |
| **M3** read and decode parity | the read byte-pin corpus and generated read payloads; provider-row fixtures incl. malformed rows | SQL divergences; shape/decoding divergences; container-policy divergences |
| **M4** moves | each moved capability's existing suite; censuses (namespace, decimal, geopoint, forbidden tokens) updated for the new owners | census failures |
| **M5** exit | the full behavior estate (`test:all`, provider suites) on the new engine; `test:types`; `package:build`; `size` | must be zero divergences; bytes reported |

Stop conditions, decided now:

- an M1 order mismatch that is neither payload order nor dependency order → record as a
  §12.3 decision; do not add a tie-break rule to reproduce a historical accident;
- byte special cases above about 40 across the whole corpus at M1 → re-size §11 before
  continuing (the packer thesis is weaker than estimated);
- any premise that cannot be stated from the pattern's matches → design gap; stop and
  name it in this document before any workaround.

### 13.6 The simulated driver (unit F, used by M2)

A deterministic driver over an in-memory cell store with:

- a seeded schedule: which statement index throws which classified provider error
  (unique violation naming a constraint, timeout, connection closed);
- premise invalidation: between the match phase and the assert phase of fragment N,
  mutate a chosen cell so a guard fails (batch) or a lock would have prevented it
  (transaction);
- segment failure at fragment N with `supportsOrderedCommittedSegments` true and false;
- malformed provider rows at row K (missing column, wrong type, half-null polymorphic
  carrier);
- capability matrix: `supportsTransactions`, `supportsBatch`, `supportsReturning`,
  `bindsGeneratedKey`, `maxBindParametersPerStatement`, so the same payload runs under
  every substrate the real drivers expose.

Both engines see the identical driver and seed; the comparison is on everything the
user or an observer can see. Shrinking reduces a failing (payload, seed) pair to its
minimal form before it is filed.

### 13.7 Exit criteria

1. M1–M4 at zero unclassified divergences; every classified special case listed in
   this document's §12.3 table or in the packer's rule table with its byte oracle.
2. M5 green: the complete existing behavior estate and provider suites pass on the new
   engine with the old engine's switch removed.
3. §2.5-style structural counts, measured: verb switches below the sugar table = 0;
   storage words in `construct.ts`/`schedule.ts` = 0; substrate words outside
   `execute/` = 0; mutable-after-construction compile fields = 0; the census tests
   enforce all four.
4. Size reported against §11: engine lines, relocated lines, packer special-case count.
5. The old engine, `Part`, `StepScope`, `OperationFragment`'s planning/final split, the
   two record compilers, the relation owners, `OwnWriteSteps`, and `nested-target-parts`
   deleted in one commit; AGENTS.md and ATOM.md rewritten to describe §2–§9 as the
   current doctrine, in the same commit.

### 13.8 Effort

Estimate, with eight parallel streams: day 0 contracts, one day; A and B, one week;
C, D+E, F, G in parallel, three to five weeks to M1 and M2; G to M3 in the same window;
H throughout; M5 and deletion, one week. About six to eight weeks of wall-clock with the
streams parallel, against roughly the same calendar for the incremental raptor plan's
P0–P7, which would leave every old seam in place.

### 13.9 Status log

Branch `pattern-engine`. The old engine is untouched; the new one lives under
`src/query-engine/pattern/` and `tests/pattern/`. Numbers are the dashboards'
own output (`tests/pattern/differential/compile.core.test.ts` for M1,
`execute.core.test.ts` for M2); "cells" are payload × dialect × substrate ×
world over the 246-payload corpus, 2,952 cells.

| Date | Commit | State |
| --- | --- | --- |
| 2026-09-01 | aa326b10 | Day 0: K1–K4 contracts, oracle harness, corpus + 2,952 goldens. |
| 2026-09-01 | 761464d2 | Wave 1 landed: generator (B), construction (C), scheduler + packer (D+E), executors + simulated driver (F), match + decode (G). K4 smoke payload byte-equal on both substrates; read parity 131 × 3 dialects byte-equal (M3 for the corpus's read shapes). |
| 2026-09-02 | 0e04c87d | Contract revision reconciled across the four streams (K1 arms / referenceRow / verb / read-side terms; K2 junction pairings; K3 required failures, `Fragment.pack`, program outputs). 870 tests. M1 runner: 232 equal, 1,759 error-identity, 689 with step diffs. |
| 2026-09-02 | c5919b8c | M2 runner (both engines on the simulated driver, gated to compile-equal cells): 194 equal, 26 trace, 12 outcome. Found: executor re-locks a locked match; nested premise failure raised before the root locate's own failure. |
| 2026-09-02 | 08bf6522 | K2 orients junctions by slot identity; K1 `Extension.variant`; match exports `lowerPredicate` / `lowerRowKey` / `lowerRowSelector` for the packer; M1 compares record series (capture + members + result reads). 244 equal. |

Open divergence classes, by owner (cell counts from the 08bf6522 run):

- Packer (D+E): row-id allocation for connect / disconnect / set rows (≈540);
  predicate lowering through the public-args path instead of `lowerPredicate`
  (≈470); variant families not addressable (≈300); statement `outputs` /
  `model` (≈200); per-dialect insert forms (postgres CTE with projection,
  sqlite without RETURNING, mysql insertId) (≈80); bulk member fragments (no
  `member` boundary yet, so every series cell diverges).
- Construction (C): refusals today raises that the pattern engine does not
  (`No fields to update`, nested-dependency refusals) and failure text per verb.
- Executors (F): double `FOR UPDATE`; premise evaluation order in the missing
  world; the mysql/batch "public result parsing cannot be rolled back" refusal.
- Contracts (coordinator): `viaJunction.askingCells` / `referencedCells`
  naming so the packer and the read constructor read a pairing instead of
  comparing two (G's note); `Projection.relations[].variant` duplicates
  `Extension.variant` for projected arms.
