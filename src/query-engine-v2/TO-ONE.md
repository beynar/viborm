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
| parent-held `connectOrCreate` FOUND arm | existing-row premise: `presenceGuard` (`exists`) | `false` | disable the guard → raw FK error instead of V1's replacement-race message "Record was replaced by another transaction during nested connectOrCreate" (`nestedReplacement`, V1 `RelationBranches.replacementFailure`) |
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

  > **T3a dual-run finding (item 2).** T3a probed whether the first two — the
  > connect-by-non-referenced-unique and the shared-PK parent-held edge — are
  > *accept-and-execute* (needing absorption) or *reject-parity* (convertible to a
  > byte-identical V2 rejection). A dual-run proves **V1 ACCEPTS both**: the
  > non-referenced-unique connect looks the target up by the unique and threads its
  > `id` into the FK (`record.create({ account: { connect: { code } } })` →
  > `accountId` filled, persisted); the shared-PK connect resolves the created row's
  > identity from the fold (V1's `getCreatedRowWhere`/`getUpdatedPrimaryKeyWhere`).
  > So neither is convertible to a typed rejection — each is a genuine
  > accept-and-execute **create-root** plan shape (a lookup-subquery capture; a
  > shared-PK identity fold), structurally distinct from family A's update-root
  > correlated writes. They are **not part of family A's coherent unit** and are NOT
  > in the measured `FALLBACK_OFF_RESIDUAL` census (no conformance scenario exercises
  > them); T3a leaves them as documented create-root boundaries (route-inventory
  > count for the two sites unchanged), a separate absorption unit for a later phase.

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

---

## 7. The to-one family under UPDATE roots (T2)

> This section extends the note to the second absorption unit: the to-one
> relation-write family under `update` roots. It is written first, before the
> T2 absorption code, and it obeys the same discipline as §0–§6 — the absorption
> unit is the tree class, the frozen vocabulary suffices, and every accept/reject
> decision is V1's, discovered from V1 source and certified by the dual-run oracle.

### 7.0 The one difference that reshapes everything: the parent EXISTS

Under a `create` root the parent row is *fresh* — §1.2's fresh-parent elision
applies, and §2's before-parent coverage ledger closes the sibling-coupling
incident. Under an `update` root the parent row **already exists and is located
first** (`UpdateOperation`'s FOR-UPDATE locate read). Three consequences follow,
and they are the whole of T2's design:

1. **No fresh-parent elision.** The parent-held direction was already global (§1.1);
   now the *inverse* (child-held) direction is global too — a correlated child of
   an existing parent CAN pre-exist, so its probes and adopt arms run against
   committed state, exactly as the to-many child-held family under `update` already
   does. The inverse-side to-one is the **arity-1 case of the to-many child-held
   path** (§1.2), and `UpdateOperation` already ships that path for `oneToMany`.
   T2 widens its type guard to `oneToOne` — the same widening T1 made for `create`.

2. **The parent's FK write is an UPDATE, not an INSERT fold.** In the parent-held
   direction (§1.1) the record's FK column carried the target's referenced value.
   Under `create` that value was folded into the record's own INSERT. Under
   `update` the parent row is already written, so the FK is set by the **root
   parent UPDATE** — V1's `updateParentForeignKey` (`RelationUpdates.compileRelation`,
   the `if (fk.holdsFK)` arms of `create`/`connect`/`connectOrCreate`). The
   before-parent target write is still emitted first (INSERT the target, capture
   its identity), and its identity flows **backward** into the parent UPDATE's SET
   — the same "refs point backward" shape, with the record INSERT replaced by a
   record UPDATE. `UpdateOperation` gains one `beforeRootWrites` phase between the
   guards and the root UPDATE; the root UPDATE's SET absorbs the resolved FK fold.

3. **The coverage ledger does NOT generalize, and MUST NOT be ported.** §2.4 is
   the load-bearing contrast: V1's `OwnWriteAnalyzer` gives `update` **one
   undivided relation group** (`getRelationEntryGroups` returns
   `[Object.entries(relations)]` for the update family, vs the `currentHoldsFk` /
   `relatedHoldsFk` split for create). So a sibling `connect` whose decision read
   overlaps a sibling `create`'s target write is a genuine own-write dependency and
   V1 **rejects** it (`assertUpdateOwnWriteSafety` → the typed "split these
   operations"). The T1 ledger — which turns exactly that overlap into a covered,
   probe-free adopt — would convert a V1 **rejection** into an **acceptance**: a
   different kill signal (§2.4's explicit warning). T2 therefore ports **no**
   ledger. Each parent-held arm under `update` is independent; the own-write
   preflight (`OwnWritePreflight.assertUpdate`, already wired in `UpdateOperation`)
   is the arbiter, unchanged. The create-then-connect incident under `update` is a
   **REJECT parity** oracle witness, not an accept-and-execute one.

### 7.1 The pinned-premise table for update roots (c)

Every premise carries its pin per the Pin Rule; the `update`-root column differs
from §3 only where the parent's existence and the UPDATE-vs-INSERT fold enter.

| arm / premise | pin | raceable | falsification |
| --- | --- | --- | --- |
| **root parent presence** (all update roots) | existing-row: tx FOR-UPDATE locate found-at-compile; batch `presenceGuard` (`exists`) on the root `where` | `false` | disable the guard → a concurrent delete yields a silent empty result instead of V1's typed NotFound (ATOM §8.1 note (b)) — already shipped, re-exercised under every to-one arm |
| parent-held `create` target INSERT | **none** | — | unconditional nested create; a unique violation is a genuine error, never a probe's missing arm. The record FK ← `ref(target.create, id)` in the root UPDATE SET |
| parent-held `connect`, uncovered *(covered does not exist under update — §7.0.3)* | existing-row premise: tx probe found-at-compile; batch `presenceGuard` (`exists`) | `false` | disable → raw FK error instead of V1's "target record was not found" |
| parent-held `connectOrCreate` FOUND arm | existing-row premise: `presenceGuard` (`exists`) on the connect target | `false` | same as uncovered connect |
| parent-held `connectOrCreate` MISSING arm target INSERT | **constraint + `racePin`**, never a `notExists` guard | `true` | disable racePin → a concurrent create of the same key surfaces `UniqueConstraintError` instead of retry-and-adopt convergence |
| inverse-side `connect` / `connectOrCreate` (child-held, global adopt) | reuses `RelationLinkPart` / `RelationUpsertPart` pins (existing-row `exists`, `false`; missing-arm constraint + `racePin`) | per part | already falsified for the to-many arity; the to-one arity rides the same pins |
| inverse-side `update` (child-held, correlated) | **correlated** existing-row premise: tx probe `WHERE fk = Ref(locate)` found-at-compile; batch `presenceGuard` on `(fk = parent ∧ pk = capturedPk)` (the split-witness correlation, `RelationWritePart`) | `false` | disable → a concurrent reparent of the correlated child lets the update land on a stranger, instead of V1's "target record was not found for this parent" |
| inverse-side `disconnect: true` / `delete: true` (child-held, correlated bulk) | **none** (bulk write, `WHERE fk = parent`; zero matched rows is V1's silent success) | — | the correlated `WHERE` is the whole pin; a required-FK disconnect is rejected at construction (`assertNullable`, V1-verbatim) |

Fresh-parent elision (§4) recap: it applied ONLY to the create-root child-held
direction. Under update it does not apply at all — every probe reads committed
state.

### 7.2 Inverse-side steal / orphan semantics — V1's call, cited

The inverse (child-held) one-to-one arms write the **other** row's FK. Their
steal/orphan behavior is V1's, and T2 reproduces it by reusing V1's builders, not
by re-deciding:

- **`connect` / `connectOrCreate` FOUND** — `RelationUpdates.compileRelation`'s
  child-held `connect` arm (lines ~266–292): `UPDATE child SET fk = parent WHERE
  unique`, then an `existsGuard` on the reparented row. It **steals** the target
  from any prior owner by overwriting its FK; when the child's FK column carries a
  UNIQUE constraint (a true one-to-one), a *second* row already pointing at this
  parent makes the reparent's `UPDATE` collide on that unique — a genuine DB error,
  V1's behavior, not a V2 refusal. No pre-disconnect of the parent's existing child
  is emitted (V1 emits none); the one-to-one invariant is the DB's to enforce.
- **`update`** — the correlated targeted arm (`RelationUpdates.compileRelation`'s
  `updateStep` loop): locate the child by `filter: correlatedWhere(fk, parentValues)`
  with **no** unique selector (`normalizeUpdateInputs` yields `{ data }` for a
  to-one — `RelationMutationPlan`), capture-or-fail with "target record was not
  found for this parent", then `compileLocatedUpdate`. V2 maps this to
  `RelationWritePart` with an **absent `where`** (correlation is the whole locator).
- **`disconnect: true` / `delete: true`** — `RelationRemovals` `input === true`:
  a correlated bulk `updateMany child SET fk = NULL WHERE fk = parent` / `deleteMany
  child WHERE fk = parent`. V2 maps `disconnect: true` to `RelationLinkPart`'s
  `disconnectAll` and `delete: true` to `RelationWritePart`'s `deleteMany` with an
  empty user filter. A required (non-nullable) FK disconnect is V1's typed
  `assertNullable` rejection, reproduced verbatim.

The **FK-holder-side** (parent-held) `update`/`delete` — mutating the row the
parent's own FK points at — mutate committed state correlated by the parent's FK
value (`correlatedWhere(fk, parentValues)` for `holdsFK` is `child.referenced =
parent.fkValue`); `delete` additionally nulls the parent FK first (`RelationRemovals.
delete`, the `fk.holdsFK` arm). These are the "FK-holder-side" arms; where a shape
needs V1's staged `compileLocatedUpdate` recursion the whole tree routes to V1.

> **T3 amendment (this was NOT a durable "documented boundary").** T2 called the
> FK-holder-side `update`/`delete` route-to-V1 a "documented boundary, mirroring
> the to-many nested-`update`-grandchildren boundary". The T3 measurement (a full
> `nested-write-conformance` run with the V1 fallback DISABLED) proved it a
> **migration target, not a boundary**: `UpdateOperation.interpretParentHeldToOne`
> declined every parent-held to-one `update`/`delete`/`upsert` under an update
> root — 13 conformance scenarios V1 accepts-and-executes (or reject-parities) and
> V2 handed wholesale to V1. It is **family A** of the eight-family, 43-scenario
> fallback-carrying surface (`FALLBACK_OFF_RESIDUAL`).
>
> **T3a absorbs 11 of family A's 13 (43 → 42 → 31).** The FK-holder-side (parent-
> held) to-one `update`/`delete`/`upsert` now run natively on V2 whenever the
> located target's own mutation is **scalar** — new `ParentHeldTarget` kinds in
> `UpdateOperation`:
> - **`update`** — locate the referenced target by the parent's **FINAL** FK value
>   (`child.<referenced> = parent.<fk>`, where a same-root scalar rebind of the FK
>   column moves the target, since V1 correlates `holdsFK` on the post-update
>   `parentValues`; a rebound column resolves to its construction literal, an
>   untouched one to the located parent row via a SQL `Ref`), then `UPDATE` it by
>   the captured PK. An empty capture is V1's verbatim "Cannot update relation …:
>   target record was not found for this parent" (the parent's FK pointed at
>   nothing). The batch split-witness `exists` guard pins the correlation.
> - **`delete: true`** — `NULL` the parent FK first (V1's `assertNullable` gate;
>   a required FK is its verbatim reject), then correlated bulk-delete the referenced
>   target by its (pre-null) FK value — V1's `RelationRemovals.delete` `holdsFK` arm.
> - **`upsert`** — the correlated probe decides at compile: found → `UPDATE` the
>   located target (the parent FK already equals the located value; V1's no-op
>   re-write is elided); absent → `INSERT` the target before the root and rebind the
>   parent FK to its created identity — V1's `RelationBranches.compileOneUpsert`
>   `holdsFK` arm + `updateParentForeignKey`.
>
> The parent's own FK columns are held in a **separate** locate-field set so a
> same-root FK rebind (e.g. a self-relation `partnerId`) does not spuriously trigger
> the child-edge reorder — reordering the root UPDATE after a sibling child write
> would race an unfreed UNIQUE value (the inverse holder), the divergence the
> multi-parent correlation witness in the decline-surface gate catches.
>
> **Two of the 13 stay pinned — a documented NARROWER boundary** (the +1 finer
> route, part of the +3 that moved the tripwire 62 → 65): a parent-held
> `update`/`upsert` whose located **target's DATA carries a nested relation write**
> (`container: { update: { nodes: { update } } }`). That is the parent-held
> projection of **family B**'s nested-relation-in-nested-update boundary (V1's staged
> `compileLocatedUpdate` recursion), and it stays on V1 until family B lands. The
> other +2 finer routes: a compound / non-PK-reference parent-held edge (needs V1's
> staged mutation-identity resolution), and a non-boolean parent-held `delete` (V1's
> captured targeted-delete path).
>
> Certified byte-identical to V1: the `VIBORM_FALLBACK_OFF=1` conformance run (the 11
> scenarios now run natively on BOTH substrates, byte-identical state + result +
> error; the 2 nested-relation-target shapes still decline), three absorbed positive
> tests each with a MULTI-PARENT correlation witness (a second parent's target
> survives every arm), typecheck, Biome, the full estate, and the 5-database matrix.
> P6 may not delete V1 while the residual (31 shapes: 2 of family A + families
> B–E, G, H) remains pinned.

### 7.3 The sibling-coupling analysis for update roots (b)

Does the T1 coverage ledger generalize? **No — and that is the point (§7.0.3).**
The ledger existed to turn a same-operation own-write overlap into a covered
adopt; V1 permits that overlap under `create` (the group-0 `currentHoldsFk`
observes a group-0 create) but **forbids** it under `update` (one undivided
group). So under `update` the sibling arms are mutually independent: no arm's
decision read may observe another arm's write, and `OwnWritePreflight.assertUpdate`
enforces it before planning. The absorption unit is still the tree class ("to-one
arms under an update root"), but the coupling that made T1's arms inseparable is
**absent** here — the coherence is enforced by routing (any unsupported arm hands
the whole tree to V1) plus the own-write preflight, not by a ledger.

Two disjoint-decision families V1 **accepts** under update, and T2 mirrors:

- **disjoint parent-held + inverse-side** (`{ author: { connect }, profile: {
  update } }`): the parent-held arm folds into the root UPDATE SET, the inverse arm
  is a correlated child write — no overlap, accepted on both.
- **own-write disjoint decision** (`data: { userId: 5 }, author: { connect: {
  id: 5 } }`) is V1's `assertRelationKeyUpdatesAreCompilable` / own-write surface,
  already ported into `UpdateOperation` and unchanged by T2.

### 7.4 Vocabulary sufficiency (e) — still YES

No `OperationFragment` change, no new step kind, no Part method, no parent
reference. The before-parent target INSERT is an ordinary `write` step; the root
parent UPDATE is the ordinary root-`update` write step whose SET now carries a
`Ref` (create) or a compile-decided literal (connectOrCreate found) in the FK
column — the atom's native "refs point backward". The inverse-side arms reuse the
already-live `RelationLinkPart` / `RelationWritePart` / `RelationUpsertPart` Parts
verbatim, widened only in their `oneToOne` type guard and (for the correlated
`update`) an **optional** unique `where`. The census (ATOM §8) is unmoved.

### 7.5 The T2 / T3 boundary (d) — what lands, what stays pinned

`FALLBACK_CARRYING_RESIDUAL` (decline-surface gate) holds three entries at T1's
close. T2 absorbs two, leaving one:

- **T2 lands** — parent-held to-one `connectOrCreate` under update (entry 1); the
  inverse-side to-one `update` (entry 2). Plus the coherent family the tree class
  requires: parent-held `create`; inverse-side `connect`/`connectOrCreate`/
  `disconnect: true`/`delete: true`; the disjoint-sibling and REJECT-parity
  witnesses.
- **T3 keeps pinned** — the inverse-side to-one **`upsert`** arm (entry 3): the
  nested-relation upsert branch (create-or-update the correlated child) whose D4
  threading and deliberate-decline closure T3 owns. The residual shrinks to exactly
  this one entry; the gate stays honestly non-empty.

### 7.6 T3 correction — the residual was NEVER "exactly one entry"

§7.5 stated the residual "shrinks to exactly this one entry" at T2's close. That
was the curated pin list, not the measured surface — the exact mistake the T2
theater replay was chartered to end. T3's first act was to MEASURE it: run the
full `nested-write-conformance` suite with `setV1FallbackDisabled(true)` and count
every scenario whose whole tree V2 declines (`declinedToV1` — a V2
`UnsupportedOperationError` anywhere in seed/act, which also catches the
reject-parity shapes whose reject-bool coincidentally matched V1 and which a
pass/fail count under-reports). The measure is **43 scenarios across EIGHT
families**, not one:

| family | decline site | count |
| --- | --- | --- |
| A. parent-held to-one `update`/`delete`/`upsert` under update | ~~`interpretParentHeldToOne` default~~ **ABSORBED (T3a): 11 of 13** — native parent-held correlated `update`/`delete`/`upsert`; the 2 nested-relation-**target-data** shapes stay pinned (family-B projection) | ~~13~~ → **2** |
| B. nested relation writes inside a nested to-many `update` | `RelationWritePart` scalarData | 8 |
| C. nested relation writes inside an m2m nested `create`/`update` (incl. deep-nested-update) | `RelationJunctionPart` scalarData | 10 |
| D. top-level `upsert` with nested-relation create/update arms | `UpsertOperation` scalar-arms-only | 7 |
| E. nested `create` under update whose create data carries relations / D4 | depth guard | 2 |
| F. inverse-side to-one `upsert` (the sole pre-T3 pin) | ~~`interpretInverseToOneKind` default~~ **ABSORBED (T3-r2)** | ~~1~~ → **0** |
| G. `connectOrCreate` create-arm recursion one level too deep | depth guard | 1 |
| H. to-many `upsert` create-then-update identity spelling | — | 1 |

The census is now the machine-checked `FALLBACK_OFF_RESIDUAL`
(tests/query-engine-v2/fallback-off-residual.ts), enforced bidirectionally by the
`VIBORM_FALLBACK_OFF=1` conformance run wired into `pnpm test:gates`: a pinned
scenario MUST decline on both substrates; a non-pinned one MUST run natively on V2.

**T3-r2 absorbs family F (43 → 42).** The inverse-side (child-held) to-one `upsert`
is now handled natively by V2 — a correlated locate (`WHERE fk = parent`, the FK
correlation is the whole locator, no unique `where`) that decides at plan time:
found → UPDATE the correlated child (the certified inverse-side to-one update leaf,
pinned in batch by the upsert-family `exists` premise guard, in tx by the
upsert-vanished affected-rows expectation); absent → INSERT the child with `fk =
parent`, **no `racePin` and no found guard** (V1's `missingPin: none` — the child
FK's UNIQUE constraint is the sole invariant, exactly as V1 leaves it). It composes
`buildToOneUpdatePart`'s correlated-update leaf with a create leaf in
`RelationWritePart` (`buildInverseToOneUpsertPart`); the root parent does not hold
the FK, so no parent-side FK rebind follows.

Two **documented narrower boundaries** route the whole tree to V1 (finer than the
absorbed shape, each a construction-time throw — the +3 route-inventory sites that
moved the tripwire 59 → 62):
  1. a **relation-carrying** create or update arm (family F composes scalar leaves
     only);
  2. a nested upsert while the **same root update transitions a referenced key** (a
     write to a parent column this child FK references). There V1 runs its
     referential-action legality engine — reject-occupied for a non-cascade child,
     staged setNull/restrict re-point for an empty slot — around the upsert; family F
     composes plain leaves and does not replicate that engine, so it defers to V1.
     The certified census case writes no referenced key and stays on V2. This
     boundary is proved by `relation-key-update-legality.test.ts` (the referential
     oracle: the transition-upsert scenarios reject/re-point byte-identically once
     routed to V1).

Certified: the `VIBORM_FALLBACK_OFF=1` conformance run (the F scenario now runs
natively on BOTH substrates, byte-identical to V1's expected state), a two-parent
correlation witness in the decline-surface gate (the second parent's child survives
both arms), the `relation-key-update-legality` referential oracle, typecheck, Biome,
the full estate, and the 5-database matrix (sqlite3/libsql/pglite + Docker MySQL 469
+ pg 409).

The **remaining seven families (42 scenarios) stay pinned** — each a coherent
composite-absorption unit (a byte-identical-to-V1 correlated write requiring its own
dual-run oracle, correlation witness, and 5-database certification). The honest
disposition: the true surface is measured and pinned; **P6 stays blocked** until the
set is empty; the gate turns green only when a real absorption removes a family,
never when the pin list is curated down.

### 7.7 T3b — the recursion/depth group's hypothesis, measured

T3b took the 23-key recursion/depth group (§7.6 families **A-remainder ×2, B ×8,
C ×10, E ×2, G ×1** — "a nested write whose target payload itself carries relation
writes"; D ×7 and H ×1 are later drives) and MEASURED the decline SITE of each of the
31 residual keys by capturing every `UnsupportedOperationError` message under
`VIBORM_FALLBACK_OFF=1`. The site tally is **exactly** the §7.6 table (A-rem 2 · B 8 ·
C 10 · D 7 · E 2 · G 1 · H 1 = 31), so the group boundary is a measured fact.

**The hypothesis** — "the 23 close through ONE generalization: recursive Part
composition, a nested target building its own child Parts as the root does (the
`RelationUpsertPart.buildArmChildParts` machinery P1 proved)". **Verdict: one
architecture, three mechanisms.** The architecture holds — every shape reuses the
`Part` interface and V1 SQL builders, `OperationFragment.ts` vocabulary is untouched,
and the scalarData/scalarOnly throws exist only because nested targets were built
scalar-only. But the 23 split by **linearity precondition** (WHY §4.2):
(1) **update-arm literal-parent recursion** (B, A-rem, C's `update`/`upsert`) — nested
target located by its `where` PK → `literalParentId(pk)`, extending `buildArmChildParts`
— **plus** porting the root's `reorderRootUpdateAfterChildren` + `ON UPDATE CASCADE`
to depth for the B PK-transition/self-m2m scenarios (`children.update.data = { id: 2,
links … }` expecting `sourceId: 2`), an obligation P1 never carried;
(2) **create-arm fresh-parent recursion** (E, G, C's `create`) — fresh target (ATOM §4
elision), its explicit PK the child parts' `literalParentId`, the create-context
composition `CreateOperation` runs at the root threaded into the nested create;
(3) **create-arm depth-guard relaxation** (G) — raise `buildArmChildParts`' one-level
guard while mirroring V1's accepted depth exactly. The own-write preflight
(`assertUpdateOwnWriteSafety`, V1's analyzer verbatim) already walks the whole tree, so
the reject half of every rejects/succeeds pair is free.

### 7.7.1 T3b-1 — mechanism 1 DELIVERED (family B + A-remainder, census 31 → 21)

Mechanism (1) is landed. The delivered truth:

**The recursion.** `buildNestedTargetChildParts` (`nested-target-parts.ts`) is the
reusable depth-recursive child-Part builder the hypothesis called for — it folds a
**located-by-PK** target's data relations into deeper Parts through the SAME per-kind
builders the root's `interpretRelation` uses (m2m junction, the correlated
write/link/adopt families, the inverse-side to-one, and a literal-parent create/
createMany leaf), differing only in the `ParentIdSource`: a compile-time
`literalParentId(pk)` for a child-held nested update (the target's own `where` PK), a
`plannedParentId(probe, pk)` for a parent-held one (its captured PK, exposed as a
firstRowField). Both callers — `RelationWritePart` (child-held) and
`UpdateOperation.parentHeldUpdateData` (parent-held, family A-remainder's projection) —
share it. Depth adds list entries and one parent-id value, never vocabulary or a Part
method; `OperationFragment.ts` is untouched.

**The obligation P1 never carried, now ported to depth.** A nested target whose SET
rewrites its own PK (a transition the deeper FK references — the B PK-transition/self-
m2m witnesses, `children.update.data = { id: 4, friends: { connect } }` expecting a
friend `sourceId` of 4) emits its self-UPDATE **after** its child edges, whose FK's
`ON UPDATE CASCADE` then carries the vacated id forward — `reorderRootUpdateAfterChildren`
ported to depth, computed per Part as `childParts.length > 0 && scalarData rewrites the
target PK`. A relation-only nested update writes no self-UPDATE row at all. This trick is
sound **only when the deeper edge cascades on update** — an implicit m2m junction FK
(serializer default), the only PK-transition shape in the census; a non-cascade child-held
edge is bounded out below (§7.7.2).

**Two literal-parent seams the root never needed.** A depth-composed junction
membership read (`RelationJunctionPart.parentRef`) and an inverse-side to-one correlated
probe (`RelationWritePart.correlationFilters`) inline the literal parent value even at
planning — no SQL `Ref` is possible or needed for a compile-time constant. The
planned-parent root paths are byte-identical.

**The documented narrower routes (65 → 74, all finer, none removed).** A deeper
parent-held-FK to-one at depth (needs child-SET folding); a compound-PK child at depth;
a relation-carrying or FK-not-a-literal create arm at depth (create-context depth is
mechanism 2/3, a later drive); an unenumerated nested kind. Each routes the whole tree
to V1.

**Certified.** `FALLBACK_OFF_RESIDUAL_COUNT` **31 → 25** (the 6 child-held family-B
shapes) **→ 21** (family B's 2 parent-held membership-root shapes + family A-remainder's
2). The `VIBORM_FALLBACK_OFF=1` conformance census runs all 10 natively on BOTH
substrates, byte-identical to V1's state/result/error/message; multi-parent correlation
witnesses at the deepest mutated level (the "disjoint" scenarios — a second parent's
child untouched by either arm); the decline-surface gate carries 3 native + falsification
witnesses (PK-transition/cascade, parent-held target update, the 3-level
container→to-many-update→inverse-to-one-upsert chain); typecheck, Biome, the full estate
(6107/0), and the 5-database matrix (sqlite3/libsql/pglite + Docker MySQL 470 + pg
411/14 — the PK-transition/`ON UPDATE CASCADE` shapes are exactly where an ordering bug
would pass PGlite and diverge on MySQL/pg; it does not). A/B: the family-B deep tree is
**1.85× faster on V2** (PERF.md). **P6 stays blocked** (21 shapes remain: families C ×10,
D ×7, E ×2, G ×1, H ×1).

### 7.7.2 T3b-1 fixer round 1 — the PK-transition cascade boundary (finding #1)

Mechanism 1's reorder path (§7.7.1's "obligation ported to depth") over-widened the
native surface. Writing a deeper edge against the target's **pre-transition** literal PK
and relying on `ON UPDATE CASCADE` to carry it forward is sound only when that edge's FK
actually cascades. The implicit m2m junction FK does (serializer default) — every
absorbed PK-transition census witness is a self-m2m connect. A **child-held** one-to-many
/ inverse-side one-to-one edge defaults to `NO ACTION`, so the edge written against the
old id is stranded the moment the PK moves: native V2 raised a `ForeignKeyError` and
rolled back where V1 succeeds (V1 orders the edge against the **post-transition** id).
The witness: `node.update({ children: { update: { where: { id: 1 }, data: { id: 7,
children: { connect: { id: 5 } } } } } })` — V1 yields parents `[[2,null],[3,10],[5,7],
[7,10],[10,null]]`; native V2 threw. This routed to V1 before mechanism 1, so it was a
fresh regression, not a listed residual — and no conformance scenario exercised it, which
is why the gate stayed green while the divergence went unmeasured.

**The fix** (`pkTransitionCascadeSafe`, `RelationWritePart.ts`): when a nested update
transitions its target PK **and** carries a child-held (non-cascade) deeper edge that
references that PK, decline at construction so the whole tree routes to V1. The m2m
PK-transition witnesses stay native (cascade-safe). Route inventory **74 → 75** (one finer
boundary, none removed); `FALLBACK_OFF_RESIDUAL_COUNT` **unchanged at 21** (the shape is
not a census key). Certified on both PGlite substrates + the dual-run witness
(`nested-update-pk-transition-cascade.test.ts`, child-held→V1 / m2m→native, multi-parent
isolation, guard falsified); estate 6111/0, MySQL 470, pg 411/14; typecheck + Biome clean.

The next drive absorbs mechanism (2) — create-arm fresh-parent recursion (C's create,
E, G) — then mechanism (3), the create-arm depth-guard relaxation.

### 7.7.3 T3b-2 — mechanisms 2 + 3 DELIVERED (families C + E + G, census 21 → 8)

Mechanisms (2) and (3) are landed. The delivered truth — all 13 remaining recursion/depth
keys (**C ×10, E ×2, G ×1**) run natively fallback-off; only D ×7 + H ×1 (T3c) remain.

**Family C — the m2m junction scalarOnly boundary lifted.** `RelationJunctionPart`'s
`buildJunctionParts` folds a junction `create`/`update`/`upsert`-arm target whose data
carries its OWN relations one level deeper through the SAME `buildNestedTargetChildParts`
seam mechanism 1 introduced — a located `update`/`upsert`-update target by its `where` PK
(mechanism 1 reuse), a fresh `create`/`upsert`-create target by its explicit `create` PK
(mechanism 2, ATOM §4 fresh-parent elision — the just-created junction target has no
memberships, so a correlated read below it is statically empty). The `RelationJunctionPart`
slots carry the per-target child Parts; `planning` plans their probes one level deeper
(the unconditional superset, ATOM §3 technique 2), `compile` emits only the taken arm's
writes after the relevant junction row (branch-specific for the upsert arms). The
`nestedBuilder` is threaded at all three call sites (`UpdateOperation`, `CreateOperation`,
`nested-target-parts`); a caller that does not thread it keeps the pre-T3b-2 scalar-only
boundary. `scalarOnly` stays for `updateMany` (a filter target, no literal PK) and the
`connectOrCreate` adopt arm. Witnesses (`nested-junction-target-recursion.test.ts`): a
live V1-vs-V2 dual-run oracle with a native-route assertion; a deepest-level multi-parent
correlation witness (two junction targets in ONE operation, deeper writes isolated); raw
junction-row A/B inspection for a deep self-referential m2m (orientation preserved at
depth).

**Family E — a nested `create`/`createMany` under the update root.** `UpdateOperation.`
`interpretChildHeldCreate` routes a child-held to-many create under the update root to the
literal-parent create leaf (mechanism 2 create-arm), resolving the FK from the update's own
inputs: the referenced column pinned by the unique `where` (the common PK case), or — **D4**
— rewritten by the root SET, its new value threaded to the fresh row. A create-only relation
adds NO referenced column to `locateFields`, so the reorder stays FALSE and the root UPDATE
lands BEFORE the child INSERT (the fresh row references the post-transition value, which must
already exist). A referenced column knowable only from the located row (a planned FK), a
compound key, or a non-literal (arithmetic) rewrite routes to V1.

**Family G — the create-arm depth-guard relaxation (mechanism 3).** `RelationUpsertPart.`
`buildArmChildParts` accepts a child-held `create` one level deeper on the connectOrCreate
CREATE arm: a fresh grandchild INSERT under the fresh child (its PK a compile-time literal,
ATOM §4 elision), its own data folding a single parent-held to-one `connect` (its FK the
connect's literal referenced value). Anything deeper — a m2m grandchild, a parent-held-to-one
grandchild create, a non-connect grandchild relation — routes to V1, mirroring V1's accepted
depth exactly. The decline message keeps its pre-T3b-2 wording (byte-identical).

**The named reorder obligation, closed.** The depth reorder check
(`RelationWritePart`, `UpdateOperation.parentHeldUpdateData`) tested only the target PK,
while the root reorders on its full referenced-column union (PK ∪ every child-referenced
column, D4-style non-PK references included). A **D4-style deeper edge referencing a non-PK
unique the target rewrites** is the gap. Resolution: `buildNestedTargetChildParts` now routes
every deeper child-held edge whose FK references a NON-PK column of the located target to V1
— the literal/planned parent id carries only the target's PK per-field, so such a reference
cannot be injected AND would miss the PK-only reorder. The PK is therefore the only referenced
column that can reach the depth check, so the PK-only check is complete. The root threads a
non-PK reference from its located row (D4 at the root, family E); the depth builder is a
documented narrower boundary. Witness (`nested-update-d4-deep-nonpk-reference.test.ts`): a
deeper edge referencing a non-PK unique routes to V1, state byte-identical, both substrates;
guard falsified (neuter it → V2 injects the target's id and the witness diverges).

**Certified.** `FALLBACK_OFF_RESIDUAL_COUNT` **21 → 11** (family C ×10) **→ 9** (family E
×2) **→ 8** (family G ×1). Route inventory **75 → 87** (12 finer boundary routes, none
removed): C's `requireWherePk`/`requireCreatePkValue`/`foldTarget`-no-builder (×3), E's
`resolveLiteralCreateParent` compound/non-literal/planned (×3), G's create-arm
`buildCreateArmChildCreateParts`/`foldParentHeldConnect` (×5), the D4-deep non-PK guard
(×1). The `VIBORM_FALLBACK_OFF=1` conformance census runs all 13 natively on BOTH substrates,
byte-identical to V1's state/result/error/message; the census edit is falsified twice (the
count pin catches a wrong count; re-pinning an absorbed key fails the fallback-off gate —
absorption is real). `OperationFragment.ts` vocabulary untouched; V1 frozen. **P6 stays
blocked** (8 shapes remain: families D ×7, H ×1 — T3c).

### 7.8 T3c — the drive to ZERO (census 8 → 0; the two create-root declines absorbed)

T3c took the final 8 census keys to **ZERO**. The V1 fallback arm now carries no
reachable accept-and-execute conformance behavior — P6's deletion premise, finally
true.

**Family D ×7 — the top-level `upsert` scalar-arms-only guard, LIFTED.** The
`UpsertOperation` no longer declines a relation-bearing create/update arm. A **scalar**
arm stays the proven inline path (a plain INSERT with the raceable missing-premise
`racePin`, or `UPDATE … [RETURNING]`). A **relation-bearing** arm composes the
root machinery it always should have: the update arm delegates to an `UpdateOperation`
sub-op (mechanism 1 — `buildNestedTargetChildParts`, the reorder/cascade root handling,
the D7 PK-transition + self-m2m witness), the create arm to a `CreateOperation` sub-op
(mechanism 2 — fresh-parent elision, the create-root traversal barrier). Both share the
upsert's `StepScope` (no step-id collision across arms), plan their WHOLE superset (ATOM
§3 technique 2 — only the taken arm's writes compile), and defer their own-write barrier
to the enclosing per-arm compile: V1 runs the barrier inside the taken branch ONLY, so a
create-arm violation rejects only on the create arm (D4/D5's create-branch insert
barrier) and an update-arm violation only on the found branch (D6). The update arm's
sub-op drops its locate not-found postcondition — under an upsert a located-miss is the
CREATE decision, not an error. The probe-decided arm selection, the setWhere/targetWhere
skip pins, and the create-branch racePin all compose with each arm's own child Parts.

**Family H ×1 — the nested to-many upsert create-identity over-restriction, RELAXED.**
V1's absent arm inserts `input.create` verbatim and pins the missing premise on
`input.where` (RelationBranches.compileOneUpsert), so a `create.id ≠ where.id` is legal
and a FOUND arm never touches `create`. V2's `assertMatchingCreateIdentity` was too
eager; it now fires ONLY when the create arm folds GRANDCHILDREN (which correlate to the
fresh row through `where`'s PK — the only place the identity must match).

**The two create-root parent-held-FK declines T1 deferred, ABSORBED (outside the
pre-T3c census, now given coverage).**
  1. A to-one **`connect` by a NON-REFERENCED unique** — `toOneFkAssign` resolves the FK
     through V1's verbatim `buildConnectSubqueryForField` lookup subquery `(SELECT
     referenced FROM target WHERE unique = …)`. The parent-held connect's probe/guard
     reads by the same `where`, so a missing target is caught as before.
  2. A **SHARED-PRIMARY-KEY parent-held edge** (the record's PK IS its FK). For a
     COMPILE-TIME-LITERAL fold — a direct-referenced connect, a literal-id create —
     `resolveSharedPkIdentity` threads the value into the record identity so the terminal
     read can address the created row. A non-literal fold (a non-referenced connect
     subquery, a generated create id, a connectOrCreate) has no compile-time identity;
     the reworded decline routes those finer sub-cases to V1 (route-inventory category
     iii — the same class as the deep narrower boundaries every absorption drew).

**Certified.** `FALLBACK_OFF_RESIDUAL_COUNT` **8 → 0**. New conformance group
"create-root FK declines (tx vs batch)" (3 scenarios) runs the two absorbed create
shapes natively, byte-identical to V1 (dual-run: reverting the create-src changes routes
them to V1 and yields the same expected state). Route inventory **88 → 87** (family D's
scalar-arms guard deleted, no new upsert route — a shape neither root owns throws inside
the delegated sub-op's already-audited surface) **→ 86** (the non-referenced connect
throw deleted; the shared-PK throw reworded, not removed) **→ 87** (one FINER boundary
added: a parent-held to-one relation in the update arm, whose parent-correlated probe
cannot plan when the create arm is taken, routes to V1 — category iii, no census key
reaches it). The `VIBORM_FALLBACK_OFF=1`
conformance census runs **172/172 natively on BOTH substrates**; the census edit is
falsified (re-pinning an absorbed key fails the fallback-off gate). `OperationFragment.ts`
vocabulary untouched; V1 frozen.

**The census deletion gate is MET; the full-estate blast-radius probe is the honest
closing statement.** The machine-checked deletion gate (`FALLBACK_OFF_RESIDUAL`, the
conformance run fallback-off) is EMPTY — P6's stated census precondition holds. Running
the ORIGINAL blast-radius probe over the FULL local estate with the V1 fallback DISABLED
(not just conformance) is NOT clean-green, and that is recorded honestly: ~82 non-
conformance tests reach the documented category-iii finer boundaries (V1-accepted shapes
V2 routes to V1 — batch PK-dataflow with a nested create, upsert-with-`include`, a
compound-key/m2m-direct-delete edge, the referential-action legality engine) plus
routing-documentation and parity-refusal-message tests. None is a T3c regression (the
full estate is green with the fallback ON). So P6's V1-runtime deletion carries a
nonzero blast radius the finer-boundary surface must still reconcile — enumerated, not
hidden. The T3c report's `p6Readiness` holds the full accounting.
