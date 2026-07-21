# The To-One Write Model (T1)

> Companion to [`ATOM.md`](./ATOM.md) (normative for the primitive),
> [`WHY-V1-GREW.md`](./WHY-V1-GREW.md) (the post-mortem), and
> [`PLAN.md`](./PLAN.md) (the phased path). This document is the **design note
> that gates the T1 absorption**: the to-one relation-write family under CREATE
> roots — both FK directions, the sibling coupling that the P6-prerequisite-2
> kill-signal incident exposed, and the pins each arm carries.
>
> **Written first, before any absorption code** (the P6-prereq-2 incident is the
> cautionary tale: the absorption unit is the TREE CLASS, not the throw site).

The one-sentence version:

> **A to-one arm is an ordinary FK edge whose ordering the atom already
> expresses — refs point backward. The only thing the flat atom lacks for the
> parent-held direction is a *construction-time before-parent coverage ledger*,
> and that ledger is a plain payload analysis (a `Map`), not a step kind. So the
> frozen vocabulary suffices; T1 adds no `OperationFragment` surface.**

---

## 0. Why this note exists — the recorded kill-signal incident

P6-prerequisite-2 (ATOM §8.1) tried to absorb parent-held to-one `create`
STANDALONE. It passed its own oracle and **broke a sibling scenario**:

```ts
client.record.create({
  data: {
    id: 1,
    primary:   { create: { id: 2, label: "created" } },  // parent-held to-one
    secondary: { connect: { id: 2 } },                     // parent-held to-one, SAME target model
  },
})
// V1 result: account [{ id: 2 }], record [{ id: 1, primaryId: 2, secondaryId: 2 }]
```

(`crossRelationTargetSchema` in `nested-write-conformance.test.ts`: `record`
holds two FK columns `primaryId`/`secondaryId`, both `manyToOne → account`.)

V1 **accepts** it. The before-parent `primary` create INSERTs account id=2, then
the `secondary` connect *observes that just-created row* and sets
`secondaryId = 2`. Absorbing `primary`'s before-parent create alone is correct in
isolation, but V2's flat plan-then-compile runs `secondary`'s existence **probe
at PLANNING — before any write** — so it sees no account id=2 and fails "target
record was not found." Converting that accept-and-execute shape to a refusal is
the kill signal; so P6-prereq-2 left the *whole* parent-held create family routed
to V1 and pinned it in `FALLBACK_CARRYING_RESIDUAL`.

**The lesson the incident teaches, and this note obeys:** the to-one arms under a
root are COUPLED through ordering and the own-write boundary. `primary` and
`secondary` cannot be absorbed one throw site at a time — a tree that constructs
on V2 with only one of them absorbed has *wrong sibling semantics*. The
absorption unit is the tree class **"to-one arms under a create root,"** landed
together.

---

## 1. The FK-direction taxonomy (a) — which dataflow each implies

A to-one relation is one FK edge. Which side physically holds the FK column
decides the write order. `getFkDirection(scope, relationInfo)` reports it.

### 1.1 Parent-held to-one — the record holds the FK (`holdsFK: true`)

`manyToOne`, or the FK-owning leg of a `oneToOne`. The record points **to** the
target. The target's referenced value must be in hand *before* the record's own
INSERT, because it lives in the record's own FK column. So the target write is a
**BEFORE-parent write**, and its produced identity flows **backward** into the
record INSERT — exactly ATOM §6's trace with the FK direction reversed:

```ts
record.create({ data: { primary: { create: { id: 2 } } } })
// is exactly
account.create({ id: 2 })                                   // step 1 (before-parent)
record.create({ ..., primaryId: ref("account.create", "id") })  // step 2
```

The three arms:

| arm | before-parent step(s) | record FK column ← |
| --- | --- | --- |
| `create` | INSERT target (capture generated id, or use the known literal) | `ref(target.create, refField)` **or** the literal |
| `connect` | *(none — unless uncovered, then a global existence probe)* | the connect `where`'s referenced literal |
| `connectOrCreate` | probe global; MISSING arm → INSERT target before parent | found → literal; missing → `ref(target.create, refField)` |

Refs point backward (the target INSERT is emitted first). No new vocabulary: the
record INSERT's `Sql.values` simply carries a `Ref` in its FK column, materialized
like any other. **Fresh-parent elision (ATOM §4) does NOT apply here** — the
target is the FK's *referenced* side ("the parent" in FK terms), looked up
GLOBALLY against committed state, never correlated to the fresh record. Elision is
only for children of a fresh parent (§1.2).

### 1.2 Child-held to-one — the target holds the FK (inverse-side one-to-one)

The other leg of a `oneToOne` (and the arity-1 case of `oneToMany`). The record is
the **referenced** side; the child (target) holds the FK pointing back at the
record. The child write is an **AFTER-parent write** with `fk = record.id`:

```ts
user.create({ data: { profile: { create: { id: "pr1" } } } })
// is exactly
user.create({ id: "u1" })                                   // step 1
profile.create({ id: "pr1", userId: ref("user.create", "id") })  // step 2 (after-parent)
```

This is direction-based, not arity-based: a to-one child is the arity-1 case of
the child-held path that P2c/P6-prereq already ship. **Already absorbed**
(P6-prereq-2 widened the one-to-many type guard to one-to-one for `create`); T1
extends the same after-parent path to child-held to-one `connect`/
`connectOrCreate`/`upsert` (global adopt under a fresh parent — set the existing
child's FK to the fresh record). Fresh-parent elision DOES apply: a child
correlated to the fresh record cannot pre-exist, so the adopt family runs GLOBAL
and a nested `create` is an unconditional INSERT (no probe, no `notExists` guard).

### 1.3 The two directions are one code path with a reversed emit position

Both are `childFkAssign`/`referenceSql` writing an FK column from a referenced
parent value — the difference is only **where** in the step list the target write
sits (before vs after the record INSERT) and **which** row carries the ref. WHY
§4.2 holds: relation-ness is an edge (FK direction + a reference), not a subsystem.

---

## 2. Sibling coupling (b) — the incident dissected, and the ledger that closes it

### 2.1 Why standalone absorption breaks, precisely

Two facts collide:

1. **The atom hoists every probe to planning.** A parent-held `connect`'s
   existence probe runs before *any* write in the operation.
2. **A before-parent `create` is a write that a sibling `connect`'s decision read
   can depend on.** `secondary: { connect: { id: 2 } }` reads a row that
   `primary: { create: { id: 2 } }` writes.

That is *exactly* the ATOM §4 own-write boundary: a decision read overlapping a
same-operation earlier write. V1 tolerates it by staged linearization (create,
then probe observes it). The flat atom cannot re-derive the staged read — so the
narrow claim of P6-prereq-2 ("needs V1's staged linearization or the own-write
before-parent ledger") stands. **T1 builds the before-parent ledger.**

### 2.2 The insight that makes it a construction-time analysis, not runtime staging

Everything the coupling needs is a **compile-time literal in the payload**:

- A before-parent `create` is **unconditional** — it always writes its target.
- Its target key is a **known literal** (validation materializes every scalar
  default — ulid/cuid/now/increment-is-DB-side-but-then-not-connectable — before
  the tree walk, ATOM §8.1). A sibling `connect`'s `where` is a literal too.

So "does `secondary`'s connect observe `primary`'s create?" is decided by reading
the payload, not by staging a DB read. Build, per record, a **before-parent
coverage ledger**:

```
coverage : Set<(targetModel, referencedField, value)>
         = { every parent-held `create` (and connectOrCreate-MISSING create)
             target key in this record's parent-held arms }
```

A parent-held `connect` whose referenced value is **covered** adopts the
just-created row: pure FK assignment (FK ← the literal), **no probe, no guard** —
its existence is guaranteed by our own before-parent write inside the atomic
envelope. An **uncovered** connect keeps its global existence probe + pin (§3).

The ledger is **order-insensitive** (verified against V1: forward and reversed
declaration order both yield `secondaryId = 2`), because coverage is set
membership over the whole record's parent-held arms, computed before emitting any
connect. It is a plain `Map`/`Set` in JS — not a step kind, a Part method, an
executor branch, or a parent reference (WHY §7).

### 2.3 Soundness

- The before-parent create runs unconditionally and is emitted **before** the
  record INSERT (refs point backward). If it fails (e.g. account id=2 already
  exists in committed state → unique violation), the whole atomic operation
  aborts — the covered connect never proceeds against a phantom. So the covered
  connect needs no race pin: a stale read is impossible when the row is our own
  write inside the envelope.
- The self-referential and "connect to the record's own future id" cases stay
  correct because coverage is populated ONLY by sibling `create` arms, never by
  the record's own INSERT. `node.create({ data: { id: 1, parent: { connect:
  { id: 1 } } } })` has no covering create → global probe → node id=1 absent →
  V1's verbatim "target record was not found." (conformance:
  "before-parent self connect is unaffected by the future insert" — REJECT.)
- The ledger is per-record and populated from *this record's* parent-held arms;
  it does not leak coverage across the before/after-parent boundary, matching
  V1's group-0 (`currentHoldsFk`) analysis in `OwnWriteAnalyzer`.

### 2.4 The own-write preflight still gates everything

`OwnWritePreflight.assertCreate` (V1's `assertCreateOwnWriteSafety`, verbatim)
runs first and is the arbiter of accept/reject. It **accepts** every create-root
shape in §2 — standalone, sibling create+connect (either order), create+create,
disjoint connect — because V1's create family splits `currentHoldsFk` (group 0,
before-parent) from `relatedHoldsFk` (group 1) and lets a group-0 connect observe
a group-0 create. The T1 ledger is the *execution* counterpart of that already-
reused *legality* analysis: the preflight says "legal," the ledger says "here is
how the covered connect resolves." T1 adds no preflight logic.

**The UPDATE-root contrast (why this is a create-root note).** V1 **rejects** the
same sibling shape under `update` (`OwnWriteAnalyzer` gives update one undivided
relation group, so the sibling connect's read overlaps the sibling create's
write → the typed "depends on an earlier 'create' target write"). That rejection
already flows through `OwnWritePreflight.assertUpdate` unchanged. So the ledger is
scoped to `CreateOperation` and must NOT be ported to `UpdateOperation` — doing so
would convert a V1 rejection into an acceptance (a different kill signal). T2
inherits the reject; see §4.

---

## 3. Pins per arm (c) — the Pin Rule for the to-one create family

| arm / premise | pin | raceable | falsification |
| --- | --- | --- | --- |
| parent-held `create` target INSERT | **none** | — | unconditional nested create; a unique violation is a genuine error, never a probe's missing arm (ATOM §8.1 P6-prereq). No racePin. |
| parent-held `connect`, **uncovered** | existing-row premise: tx FOR-UPDATE probe found-at-compile; batch `presenceGuard` (`exists`) | `false` | disable the guard → raw FK error instead of V1's "Cannot connect relation … target record was not found" |
| parent-held `connect`, **covered** by sibling before-parent create | **none** | — | existence is our own before-parent write inside the envelope; no stale-read race exists |
| parent-held `connectOrCreate` FOUND arm | existing-row premise: `presenceGuard` (`exists`) | `false` | same as uncovered connect |
| parent-held `connectOrCreate` MISSING arm target INSERT | **constraint + `racePin`**, never a `notExists` guard (Pin Rule class 2) | `true` (the raceable create-branch signal) | disable racePin → a concurrent create of the same key surfaces as a hard `UniqueConstraintError` instead of the retry-and-adopt convergence |
| child-held to-one `connect`/`connectOrCreate` (after-parent adopt) | reuses the existing `ChildConnectPart` / `RelationUpsertPart` pins (existing-row `exists`, `raceable: false`; missing arm constraint + racePin) | per part | already falsified for the to-many case; the to-one arity rides the same pins |

**Fresh-parent elision recap (§4):** applies to the *child-held* direction only.
The parent-held direction's target is looked up globally; its pins are ordinary
existing-row / create-branch pins, not elided.

---

## 4. The absorption units (d) — what lands together

### T1 (create roots) — lands in this phase

- **Unit T1-A — parent-held to-one under create (the coupled unit).**
  `create`, `connect`, `connectOrCreate`, and **every same-record sibling
  combination** (create+connect same/disjoint target, create+create, the
  reversed orders, self-referential parent-held), with the §2 before-parent
  coverage ledger. These land **together** — the sibling coupling forbids
  splitting them. This is the direct closure of the P6-prereq-2 incident; the
  create-then-connect scenario is the named regression witness in the oracle.
- **Unit T1-B — child-held / inverse-side to-one under create.** Nested `create`
  already absorbed (P6-prereq-2); T1 confirms and oracle-covers child-held to-one
  `connect`/`connectOrCreate`/`upsert` (after-parent global adopt).
- **Deliberately still routed (documented boundaries, not silent gaps):**
  - a to-one `connect` by a **non-referenced unique** (needs a lookup subquery
    producing the referenced value — a genuinely different plan shape);
  - a **shared-primary-key** `connect` (the record's PK is supplied by the connect
    fold, so the terminal read has no scalar identity to address the row — V1's
    `getCreatedRowWhere` resolves it; out of the create fold's scope);
  - nested `update`/`delete`/`set`/… inside a create payload (V1 rejects them too
    — routing yields the byte-identical typed rejection).
  Each stays a construction-time `UnsupportedOperationError` route; the
  route-inventory census counts it.

### T2 (update roots) — sketched, NOT this phase

The same parent-held to-one family under `update`/`upsert` roots. The key
difference is already stated in §2.4: **V1 rejects cross-sibling target
dependency under update** (the undivided own-write group). So T2:

- absorbs the **standalone** parent-held to-one `create`/`connectOrCreate` under
  update (a before-parent write with no sibling coupling — the atom expresses it
  natively);
- absorbs the **inverse-side** to-one `update`/`upsert` arms (the residual entries
  3 and 4 of `FALLBACK_CARRYING_RESIDUAL`);
- **does NOT** port the §2 coverage ledger — it inherits `OwnWritePreflight.
  assertUpdate`'s rejection of sibling create-then-connect, mirroring V1.

T3 then closes upsert arms, D4 threading, parity refusals, and the full-estate
gate.

---

## 5. Vocabulary sufficiency (e) — the frozen surface suffices; here is why

**Expected answer: YES.** No `OperationFragment.ts` change, no new step kind, no
Part method, no executor branch, no parent reference. Concretely:

- The before-parent `create` is an ordinary `write` step emitted first; the record
  INSERT is an ordinary `write` step whose FK column holds a `Ref` — the atom's
  native "refs point backward" shape (WHY §4.2, ATOM §6). No IR.
- The `connectOrCreate` found/missing decision is `compile(known)` JS over a
  widened global probe (technique #2) — the same `Probe.pin` + `Step.racePin` the
  adopt family already uses. No `BranchStep`.
- The §2 coverage ledger is a construction-time payload analysis — a `Map<string,
  Set<unknown>>` keyed by target model — consumed while emitting the record's FK
  assignments. It produces no step, carries no runtime row set across a write
  boundary (§3 corollary of ATOM §3), and never enters the executor. It is data
  flowing through the tiny fixed step vocabulary (WHY §7), which is the whole point.
- The census (ATOM §8) is unmoved: `ProducedValue` (the record FK is
  `ref(target.create, id)`), the adopt-family pins, grouped `createMany` — all
  already-live rows, now exercised by one more consumer (the parent-held
  direction). `StatementStep.onUniqueConflict` stays the only executor effect.

So the freeze holds the sanctioned way: the P0 fragment-surface snapshot + executor
token gate stay green, and this note is the design record — **not** a
design-note-to-amend-the-freeze, because there is nothing to amend.

---

## 6. The worked trace — the incident scenario, now on V2

```ts
record.create({
  data: {
    id: 1,
    primary:   { create: { id: 2, label: "created" } },
    secondary: { connect: { id: 2 } },
  },
})
```

Construction:
- separate relations: `primary` (parent-held, create), `secondary` (parent-held,
  connect). Both `holdsFK` → before-parent phase.
- coverage ledger from before-parent creates: `{ (account, id, 2) }`.
- `secondary` connect: referenced value `2` is **covered** → pure FK assign
  `secondaryId = 2`, no probe, no guard.
- `primary` create: before-parent INSERT account (id=2 literal), record FK
  `primaryId = 2` (literal, since id is provided; a `ref` if generated).

Planning fragment: **empty** (no uncovered probe).

Compile (tx or batch), one linear list:
```ts
steps = [
  write("account.create", INSERT account (id=2, label="created")),      // before-parent
  write("record.create",  INSERT record  (id=1, primaryId=2, secondaryId=2)),
  read ("record.select",  SELECT record WHERE id=1, expects exactlyOneRow),
]
```

Result byte-identical to V1: account `[{id:2}]`, record
`[{id:1, primaryId:2, secondaryId:2}]`. The `secondary` connect never emitted a
probe — the ledger resolved it at construction. Depth adds list entries, never
vocabulary.
