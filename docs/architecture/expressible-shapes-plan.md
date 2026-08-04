# Expressible Shapes — the E-waves

**Date:** 2026-08-04
**Language:** This document uses Simplified Technical English (ASD-STE100 style).
**Status:** Plan only. No work has started.

## Goal

The census holds 39 refusals. The floor audit gave 16 of them the class (c-ii): the shape is possible, and the mechanism that can do it exists. This plan absorbs all 16.

The maintainer set one more rule (2026-08-04): **parity with Prisma is not a reason to refuse.** If Prisma refuses a shape but this engine can express it, the engine absorbs it as a superset. So this plan also re-examines the capability half of the (a) class (Wave E5). After the plan, the census holds approximately 21 refusals. Each survivor is then a measured-impossible shape, a genuine payload contradiction, or a malformed-argument guard — never "Prisma says no".

A closing unit (TH) makes the type surface honest for the survivors.

## Rules for the work

- Each unit measures the refusal live before it changes code.
- Each unit uses the standard harness: one implementer, two adversarial reviewers, a maximum of two fix rounds, and a Docker wave gate (MySQL on port 3307, PostgreSQL on port 5434, one at a time).
- Each absorption changes the census pin, adds a count-evolution entry, adds a state witness for each shape on both substrates (transaction and atomic batch), and adds a falsification: put the refusal back, and the witness must fail.
- The wrong-row doctrine applies: an identity comes from the row a step acted on or made, never from the input again.
- One guard per invariant. The step vocabulary in `OperationFragment.ts` is frozen. The linearization order in ATOM §4.1 is the only order.
- Do not remove an error message, an error attribution, or a race protection.
- A conversion needs a public-surface witness, not a reachability argument.
- Memory limits: one vitest process at a time; a worktree lane does not run the full estate; Docker variables go only on the gate agent's own command lines.

## The 16 sites, in four waves

Site lines are for HEAD `20ccf5b`, in `src/query-engine/write-engine/`.

### Wave E1 — Values the locate read can supply (4 sites)

The N1 mechanism: the locate read returns the value; the edge takes it as a `planned` source. The N4-U2 mechanism: a lookup subquery finds a value by a unique the foreign key does not reference.

| Site | Shape | Correction |
|---|---|---|
| `UpdateOperation.ts:2974` | The before-root target's referenced field is not resolvable | Add the field to `locateFields`. The locate read returns it. The edge takes the `planned` source. |
| `UpdateOperation.ts:2991` | To-one `connectOrCreate` by a unique the foreign key does not reference | Use the lookup-subquery fold from N4-U2, at the root position. |
| `UpdateOperation.ts:3425` | To-one `connect` by a unique the foreign key does not reference | Same lookup subquery. Do this site first; `connectOrCreate` reuses it. |
| `UpdateOperation.ts:2908` | Shared-primary-key `create`/`connectOrCreate` at an UPDATE root | The root locate holds the primary key. The fold value is that key, as a `planned` source. (Under a CREATE root the value cannot exist. That site stays refused.) |

**Tests.** Run each shape end to end with a decoy row. The decoy shares the non-unique half of the selector. The write must land on the located row, not the decoy. **Falsification.** Corrupt the locate's published field. The witness must fail. The corrupt-locate harness exists.

### Wave E2 — Data positions that refuse nested relation writes (4 sites)

The mechanism exists: the recursive child-Part builder (T3b1), the whole-target delegation (X1c), and the create subtree (`FreshArmBuilder`, N4-U2). These four positions are not connected to it.

| Site | Shape | Correction |
|---|---|---|
| `RelationWritePart.ts:709` | An inverse-side to-one `update` with relations in its data | Give the located target its child Parts. The to-many sibling already does this. |
| `UpdateOperation.ts:2729` | Relations in a parent-held to-one `upsert` arm | The arm becomes an `UpdateOperation` sub-operation on the located target (the X1c pattern). |
| `UpdateOperation.ts:2923` | A relation-carrying target `create` on a parent-held to-one | The before-root INSERT becomes a create subtree (the N4-U2 pattern). |
| `RelationJunctionPart.ts:2066` | Relations inside m2m `updateMany` / `connectOrCreate` data | The junction target takes the child-Part builder. For `updateMany`, first measure what Prisma does with many matched rows. Pin the answer, or refuse with the measured reason. |

**Tests.** Run three-level trees through each position, on both substrates, on all four driver files. The N4-U2 grandchild suite is the template. **Falsification.** Put each refusal back — its family must fail. Force one subtree off — a state witness must fail.

### Wave E3 — The grandchild kinds on the upsert update arm (3 sites)

The located update arm holds a known primary key. Each mechanism the root owns applies at this position.

| Site | Shape | Correction |
|---|---|---|
| `RelationUpsertPart.ts:1091` | An m2m grandchild `create` | Use the junction machinery (N3) with the located key as the parent id. |
| `RelationUpsertPart.ts:1097` | A parent-held grandchild `create` | Use the before-parent fold. The arm's UPDATE gets the FK SET, ordered after the target INSERT (the N5 reorder primitives). |
| `RelationUpsertPart.ts:1037` | Grandchild kinds outside {upsert, connectOrCreate, create} | Open the switch to the other kinds through the same dispatch the root uses. A kind that cannot cross the arm boundary gets a measured refusal that names the boundary. |

**Risk, named.** One order, one derivation. The grandchild dispatch must go through `RELATION_MUTATION_KEYS`. A local order forks the theorem ATOM §4.1 protects. **Tests.** One witness per absorbed kind, both substrates, with a swap-two-stages falsification of the order.

### Wave E4 — The dispatch residue (4 sites)

| Site | Shape | Correction |
|---|---|---|
| `CreateOperation.ts:985` | A relation type outside the create dispatch | Measure which type reaches (N7 proved one does). Route it to its owning family, or re-classify to (b) with the measurement. |
| `RelationUpsertPart.ts:723` | A relation type outside the nested-upsert builder | Same. The parent-held and m2m upserts have their own Parts. Route; do not refuse. |
| `CreateOperation.ts:1521` | A compound-referenced child edge under a create root | Make the `ParentIdSource` per-field. N1-U2 proved the per-field move at the update root. The audit found no measurement against the same move here. |
| `RelationJunctionPart.ts:1608` family | A relation-carrying junction create arm with a generated target key | The arm becomes a create subtree. Its root rides the produced-identity `Ref` (the N4-U4 backward `Ref`, junction position). |

**Tests.** The compound edge runs with per-field decoys: one field agrees, one does not; the write must not cross-match. The generated-key arm's grandchildren must show the produced id. **Falsification.** Make the per-field source single-field again — the compound witness must fail.

### Wave E5 — beyond parity: the (a) capability sites (2 sites)

The two argument-shape guards (`UpsertOperation.ts:1181`, `:1188`) stay: a payload that is not an upsert is not an operation. The two capability sites get the superset examination:

| Site | Shape | Correction |
|---|---|---|
| `CreateOperation.ts:1837` | m2m `upsert` under a create root (Prisma refuses it) | The child-held sibling already executes this as a documented superset: the global-lookup adopt-and-update. Carry the same semantics through the junction: probe globally; found means update the target and write the join row; absent means create the target and write the join row. The junction's produced-identity and the adopt family supply the machinery. Document the divergence from Prisma, as N6 did. |
| `RelationUpsertPart.ts:865` | The relation's owned foreign key spelled beside the relation in nested data (Prisma refuses it) | Measure what the payload means. Two different values for one column are a genuine contradiction: that case stays refused, and the site re-classifies to (b) with the measurement. Two equal values are a redundancy, not a contradiction: absorb the agreeing case if the comparison is decidable at construction; record the boundary where it is not (a `Ref` value has no construction-time comparison). |

**Tests.** The m2m upsert-under-create runs both arms, both substrates, with a decoy junction row; the divergence from Prisma is pinned as a test, not prose. The owned-FK site gets the agree / disagree / undecidable triple. **Falsification.** Put each refusal back; the witnesses must fail.

### Unit TH — the type-honesty closure (last)

After the E-waves, the permanent refusals are: the 11 measured-impossible sites, the two malformed-argument guards, and whatever E5 re-classified to (b). For these, the input types must stop offering what always throws.

- Per-relation removals: the shared-PK kinds under create; the unresolvable-reference kinds; `skipDuplicates` on a generated-key junction `createMany`. (The owned-FK and m2m-upsert removals apply only if E5 keeps those sites refused.)
- Position and one-of shapes: a to-one payload holds exactly one kind (an XOR union); a compound-PK child loses the targeted-mutation kinds.
- Each narrowing ships a contextual type probe through the public client (the typo-beside-real-key convention) and a runtime witness that the refusal still fires for untyped callers.
- Out of scope: the 16 absorbed sites (their wide types become true); the value-dependent and driver-dependent refusals (types cannot state them; the reasons are recorded).

**The order is load-bearing.** TH runs last. A type narrowed before its absorption would forbid a shape the E-waves make real.

## Order and parallelism

```
E1 ∥ E2      (separate files: locate sources / recursion wiring)
   |
E3 ∥ E4 ∥ E5 (E3 needs E2's child-Part reach; E4 and E5 do not)
   |
TH           (types narrow only what stayed refused)
   |
Final: census re-audit (target ~21; each survivor (b), a contradiction, or an argument guard),
capability matrix rows, full estate + gates + Docker legs, delivery records.
```

Sizes: E1 = M, E2 = L, E3 = M, E4 = M, E5 = S-M, TH = M. The census target is not a promise. A unit that finds a real wall re-classifies its site to (b) with the measurement. That is a valid delivery.

## Risks

1. E2 and E3 add recursion under located arms. Each new `planned` or `Ref` path needs the corrupt-locate provenance witness, not only state assertions.
2. The m2m `updateMany` multiplicity question is a semantics decision. Measure Prisma first. If Prisma refuses it, the site becomes (a), and the unit gets smaller.
3. TH before absorption breaks the plan. Keep the order.
