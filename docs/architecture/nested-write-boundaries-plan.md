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
