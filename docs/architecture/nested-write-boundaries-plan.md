# Nested-Write Boundaries — the ≥-Prisma Plan (N-waves)

> **Delivery status:** in progress on branch `nested-write-boundaries` (PR opened at wave start). Per-wave records land below each phase as waves close.

**Date:** 2026-07-29 · **Scope:** query engine only (no CLI, no ecosystem, per maintainer).
**Goal:** absorb the remaining nested-write refusals so every shape Prisma executes, viborm executes — and go past Prisma where the atom's flexibility allows. Baseline: `main` @ post-#17/#18 merge, refusal census **78** (`tests/query-engine-v2/route-inventory.test.ts:670`).

**The keystone insight:** almost every remaining refusal exists because a value the engine needs is not a **compile-time literal** — a located parent's id, a compound key member, a deeper FK. But the engine already owns the mechanism that makes non-literals flow: **`Ref`** (a not-yet-known value riding `Sql.values`, resolved from an earlier step), proven by the junction generated-PK work, the T4a planned-parent leaf, and T4b's updated-PK dataflow. This plan is one generalization applied family by family: **where a pin was required, thread a Ref from the locate step instead** — with the W4 wrong-row lesson as doctrine (a Ref derives from the row a step *acted on*, never from re-consulting the `where`).

**Harness:** per-wave opus workflow, implementer → contract attacker → theater attacker (falsify-by-mutation, staleness-injection for every new Ref/pin path), ≤2 fix rounds, memory-bounded verification, Docker legs at wave gates. Census edits deliberate, bidirectional, with the count-evolution log updated. One guard per invariant. Both execution substrates (tx AND atomic batch) per absorbed shape, or an explicit typed refusal for the batch side with the reason named.

---

## N1 — The located-parent Ref (keystone; runs ALONE — Pin Rule blast radius)

Today, `update({ where, data: { <child writes> } })` demands the referenced parent column be a compile-time literal: pinned by the unique `where` or rewritten by the root SET. That is why `where: { email }` + `posts: { create }` refuses while `where: { id }` works ([UpdateOperation.ts:1422](../../src/query-engine-v2/UpdateOperation.ts:1422)).

| Unit | What |
|---|---|
| N1-U1 | The update's **locate step returns the referenced column(s)**, and child-edge builders accept a `Ref` into that read wherever they accept a literal today — single-field first. The Pin Rule's *race* semantics survive intact: racePin attribution still keys on the discriminator; the Ref is a dataflow value, not a race signal. Staleness-injection: corrupt the locate's returned column → the child write must fail closed, never write a stale FK. |
| N1-U2 | **Compound referenced keys** ride the same mechanism per field (removes `does not support a compound-key nested create`, `requires a child with one primary key` where the cause was literal-only compounds). |
| N1-U3 | **Batch lowering**: the locate is a planning step; planning steps may Ref earlier planning steps (technique #1). Prove tx/batch equivalence with the dual-substrate oracle; where the batch side is genuinely inexpressible, a typed refusal naming the substrate. |
| N1-U4 | Census sweep of every site whose stated reason was "not pinned / not a compile-time literal" — absorb or re-justify each with the new mechanism available; falsify absorbed paths. |

**Acceptance:** `update({ where: { email }, data: { posts: { create } } })` executes identically to the `where: { id }` spelling on all local dialects + both substrates; the B6 family (unpinned PK-transition variants) re-audited against the Ref; census drops with per-site justifications.

### N1-U1 — delivered

`UpdateOperation.resolveLiteralCreateParent` became `resolveCreateParent`: when no
compile-time literal names the referenced parent column, the column joins `locateFields`
(so the locate SELECTs it *and* declares it as a `firstRowField` output) and the create
leaf gets a `plannedParentId`, resolving the foreign key at compile from the row the
locate ACTED ON. The literal path is untouched for the pinned single-field case — the
`where: { id }` spelling compiles byte-identically, pays no extra column and no extra
statement. The single-`create` leaf was already per-field compound-ready from T4a
(`buildPlannedParentCreatePart` / `plannedFkInject`); N1-U1 adds
`buildPlannedParentCreateManyPart` for the bulk arm, allocating step ids at construction
from a shape plan and ASSERTING (not assuming) that the compile-built plan has the same
statement count.

Census **78 → 77**: the refusal is deleted, not narrowed. Four sites were re-justified
rather than absorbed, each with the Ref explicitly considered — see the count-evolution
entry in `route-inventory.test.ts`. Notably `resolveCreateParent`'s "pre-transition value
is not pinned" survivor: the Ref *does* reach the pre-transition value, but the
absorption needs the post-transition derivation ordered against the root UPDATE, which is
**N5-U2**'s unit.

Witnesses: `located-parent-ref-behavior.ts` (7 shapes × every driver leg × both
substrates — state parity between spellings, the wrong-row decoy, a D4 non-PK referenced
column, `createMany`, the X1b create subtree); `located-parent-ref.test.ts` (plan parity:
identical statement count and write SQL between spellings; staleness injection: the FK
follows the locate's returned value, a value corrupted to a non-existent key fails closed,
an absent declared output fails closed at planning); `staleness-injection.test.ts` (race
story: a concurrent parent delete aborts the batch typed with no orphan);
`upsert-family-behavior.ts` (the upsert's UPDATE arm rides the same Ref; its CREATE arm's
produced-identity provenance is unaffected).

Four tests were deliberately RETARGETED from a decline to an accept-and-execute assertion
on the SAME payload, each with the reason written at the site:
`nested-update-d4-deep-nonpk-reference.test.ts` (this is also the depth-≥2 witness — the
Ref under X1c delegation), `extended-where-unique-behavior.ts` (the Pin-Rule claim
survives, sharpened), and the two construction-surface tests in `update-family.test.ts` /
`upsert-family.test.ts`.

### N1-U2 — delivered

No new mechanism. A compound foreign key was already per-field in this model, and the
create leaf's inject already loops the FK columns index-aligned with the referenced ones,
resolving each BY NAME from one located row — so U1's `plannedParentId` covers arity ≥ 2
by construction. U2 is a **gate** change: every referenced column is registered in
`locateFields`, and the compound refusal moves *behind* the "does the root SET rewrite a
referenced column?" test instead of standing in front of it.

Census stays **77** — the site NARROWS rather than disappears, and its message now names
the surviving cause: a compound reference whose member the root SET rewrites. That
survivor is ordering, not dataflow (the located row carries the PRE-transition tuple), and
belongs to **N5**.

Witnesses (every driver leg, both substrates): a compound PK reference located by its own
compound where-unique; the same PK located by a `handle` unique naming NEITHER member,
with a sibling sharing `tenantId` so a dropped member would attach the child to it; a
compound NON-PK referenced unique (`[region, code]`) with a sibling sharing `region`; plus
a staleness probe that corrupts exactly ONE member of the tuple and asserts the WHOLE tuple
moved — the proof that every member travels from the same located row.

### N1-U3 — delivered

**No batch-side code was needed, and that is the finding.** The locate is a planning step,
and planning runs ahead of the atomic unit in batch mode exactly as it runs inside the
transaction — so the value the Ref carries is produced identically on both substrates and
inlined into the compiled statements before `compileToEntries` ever sees them. Technique #1
is satisfied by the existing lifecycle; nothing threads through the batch lowering.

The deliverable is therefore the ORACLE, not a mechanism: seven scenarios (single, bulk, D4
referenced column with a scalar SET, the create subtree, a compound reference by a unique
naming neither member, a missing row, a colliding child PK) run through BOTH substrates on
a FRESH database per arm, comparing the returned result, the whole persisted state, AND the
error class + message. They agree on all seven, including both failure classes. No shape
required a substrate-naming refusal — that is measured, not assumed.

One genuinely inexpressible batch case exists and is NOT new: `createMany` +
`skipDuplicates` on a dialect whose skip is not a SQL leaf (`recoverableUniqueError` —
MySQL) compiles to the savepoint-wrapped executor effect, which a single atomic batch
cannot carry. The planned-parent leaf inherits that disposition unchanged from the literal
one (same `onUniqueConflict` flag, same executor refusal). The shared behavior suite pins
it in BOTH directions rather than skipping it: the MySQL atomic-batch leg DECLARES
`skipDuplicatesInBatchIsInexpressible` and asserts the typed refusal with nothing written;
every other leg asserts the skip executing. A dialect that can express it cannot quietly
start refusing, and one that cannot cannot quietly start succeeding.

**Measured, not fixed — recorded for a later wave.** In BATCH mode the root-presence guard
and the root UPDATE both address the ORIGINAL `where`, while child edges address the
captured located row. Under a concurrent rename-plus-reinsert on the discriminator those
two can name different rows. This is pre-existing for every alternate-unique locate (a
`connect` under `where: { email }` splits the same way) and is NOT introduced by the Ref —
but N1 makes the spelling common, so it is named here rather than left implicit.

## N2 — Inverse-side to-one family (the mainstream Prisma shape)

`user.update({ where, data: { profile: { create: { bio } } } })` still refuses ([UpdateOperation.ts:1720](../../src/query-engine-v2/UpdateOperation.ts:1720)); `createMany`/`deleteMany` on the inverse side likewise.

| Unit | What |
|---|---|
| N2-U1 | Inverse to-one **`create`**: child INSERT with FK = parent id (literal or N1's Ref), guarded by the **occupied-slot** rule (Prisma errors if a related row already exists — match it, tx + batch, race-safe: the unique FK constraint is the backstop and the racePin story must be stated). Reuse RelationWritePart/ConnectDisconnectPart machinery, not a new path. |
| N2-U2 | Inverse to-one **`createMany`** (single-element semantics per Prisma — or refuse exactly as Prisma refuses; MEASURE Prisma's actual behavior first and pin it in the test name) and **`deleteMany`** (delete-the-connected-row filtered form). |
| N2-U3 | The residual inverse-side declines re-audited: object-form `disconnect`/`delete` stay Prisma-parity refusals (Prisma only takes booleans there) — verify, don't assume. |

## N3 — M2M completions (after N1; junction machinery)

| Unit | What |
|---|---|
| N3-U1 | Nested **`createMany` through a junction** (`tags: { createMany: { data: [...] } }` under create and update roots), skipDuplicates included, generated target PKs via the existing produced-identity path. |
| N3-U2 | **upsert-through-junction with a generated create-arm PK** — the dedup ledger learns the create-data-unique identity source W4's closure gave plain upserts. |
| N3-U3 | Compound-PK M2M: measure what the correlation-utils refusal actually protects; absorb per-field or re-justify. |

## N4 — Depth-seam boundaries (after N1; B3/B8/B9)

| Unit | What |
|---|---|
| N4-U1 | **Locate-by-any-unique for relation-carrying targets** (B3): a nested `update`/`upsert` addressed by a non-PK unique that carries deeper writes — the locate read returns the PK, deeper FKs Ref it. Removes `must locate the target by its primary key`. |
| N4-U2 | The **create-arm one-level-deeper guards** (B8: connectOrCreate/upsert create-arm nested kinds) — absorb with the recursive child-Part builder + Refs; each absorbed kind gets a depth witness. |
| N4-U3 | **createMany under a planned parent** (B9's live tripwire, `nested-target-parts.ts:537`) — the decline-surface gate's named backlog item. |
| N4-U4 | **Shared-PK edges** (B1): non-literal fold values Ref the producing step. |

## N5 — Ordering boundaries (independent of N1 mechanics; can run parallel to N4)

| Unit | What |
|---|---|
| N5-U1 | **B5 — nested adopt / child-edge writes under a non-cascade PK transition** (`RelationWritePart.ts:637` and the A15 adopt refusal): the plan-of-record fix is ORDERING — self-UPDATE after cascade-safe edges, or edge-writes against the post-transition id via Ref. "Routed for correctness, not inexpressibility" (PLAN §1314) — this is the wave that proves it. The T4c wrong-row witnesses are the falsification bed. |
| N5-U2 | B10 residue (located-only pre-transition PK, compound generated PK, non-portable arithmetic) — absorb what N1+N5-U1 machinery covers; re-justify the remainder with measured reasons. |

## N6 — Beyond Prisma (decision-gated; each unit needs a maintainer yes)

| Unit | What | Decision |
|---|---|---|
| N6-U1 | **Extended whereUnique in nested target selectors** — W4 deliberately kept them strict; with N1/N4 landed, the collision that forced that scoping is gone. Superset: Prisma's nested selectors are unique-only in several positions. | D-N1 |
| N6-U2 | **Relation filters inside a unique where** — refused today because the filter half compiles into UPDATE/DELETE where MySQL rejects reading the mutated table; the 1093 derived-table wrapper already exists for updateMany — compose it. | D-N2 |
| N6-U3 | **Own-write linearization** (A14: `{ posts: { create, connect } }` same-tree overlap) — Prisma linearizes some of these; ATOM §4 refuses by doctrine because per-Part legality re-derivation "forks the theorem". Default: KEEP the refusal. Only revisit with an explicit doctrine change. | D-N3, default NO |

## Ordering and parallelism

```
N1 (keystone, ALONE — Pin Rule/staleness blast radius, dual-substrate oracle)
        │
   N2 ∥ N3            (disjoint: UpdateOperation inverse arm vs junction Parts)
        │
   N4 ∥ N5            (disjoint: depth seams vs ordering)
        │
   N6 (decision-gated units, only those with a yes)
        │
Final: census at its floor (each survivor = genuinely inexpressible or Prisma-parity refusal,
each with a measured justification), full estate + gates + Docker, capability matrix §write rows updated.
```

Sizes: N1 = L (the keystone), N2 = M, N3 = M, N4 = M, N5 = M, N6 = S–M each. Census target: from 78 down to the floor — not a number picked in advance, but every survivor must answer "why can no mechanism express this?" with a measurement, the standard the census log already enforces.

## What "better than Prisma" means here, concretely

Already ahead and staying: unlimited depth, nested upsert-under-create, optional-`where` nested updateMany, to-one `{where,data}` non-unique filters, upsert `targetWhere`/`setWhere`, operand callbacks at every depth. This plan adds: located-parent dataflow Prisma resolves with multiple round-trips folded into single plans; nested extended-unique selectors (N6-U1) Prisma doesn't offer; and honest typed refusals with named reasons where Prisma silently degrades or errors opaquely.
