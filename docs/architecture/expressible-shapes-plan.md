# Expressible Shapes — the E-waves

**Date:** 2026-08-04
**Status:** Plan only. No work has started.
**Input:** the 16 census survivors the floor audit classified **(c-ii)** — reachable refusals whose absorbing mechanism already exists and is named in their count-evolution records. Absorbing all of them takes the census from **39 to ~23**, where every survivor is either Prisma-parity (4) or measured-impossible (19).
**Companion:** the type-honesty unit (TH) closes the loop on the sites that will *never* absorb.

## Rules (the standing harness, binding)

- Each unit: MEASURE the refusal live first; one implementer (opus, xhigh), contract + theater reviewers, ≤ 2 fix rounds, docker wave gate (MySQL 3307, pg 5434, one at a time).
- Census discipline: every absorption is a pin edit with a count-evolution entry, a state-asserting witness per shape on BOTH substrates (tx + atomic batch) or a typed refusal naming the substrate, and a falsification (re-add the refusal → witnesses fail).
- The wrong-row doctrine, the one-guard ban, the frozen `OperationFragment.ts` vocabulary, and ATOM §4.1's single linearization order all bind. No error message, attribution, or race protection may be removed.
- The conversion law: a site that turns out unreachable converts with a public-surface witness, never a reachability argument.
- Memory bounds: one vitest per lane, worktree lanes never run the full estate, docker env vars only on the gate's own command lines.

## The 16 sites, by absorbing mechanism

Site references are HEAD (`20ccf5b`) line numbers in `src/query-engine/write-engine/`.

### E1 — Locate-reach: values the root's own read can return (4 sites)

The N1/N4-U1 mechanism: the root locate (or a lookup subquery, already built for grandchild adopts in N4-U2) returns the value the edge needs.

| Site | Shape | Mechanism |
|---|---|---|
| `UpdateOperation.ts:2974` | before-root target's referenced field unresolvable at the update root | the root locate already reads this row — register the field in `locateFields`, take the `planned` source (N1-U1's exact move, applied to the before-root target) |
| `UpdateOperation.ts:2991` | to-one `connectOrCreate` by a non-referenced unique | the lookup-subquery fold N4-U2 shipped for grandchild `owner.connect { email }` — same fold, root position |
| `UpdateOperation.ts:3425` | to-one `connect` by a non-referenced unique | same lookup subquery; the simpler sibling lands first and `connectOrCreate` reuses its resolution |
| `UpdateOperation.ts:2908` | shared-PK `create`/`connectOrCreate` at an UPDATE root | under create the fold value cannot exist ((b), stays); under UPDATE the root LOCATED the row — its PK is the fold value, as a `planned` source |

**Witnesses:** each shape end-to-end with a decoy row sharing the non-unique half of the selector (wrong-row probe); the connect-by-email variant against a decoy holding the lower key; shared-PK-at-update with the located row's PK asserted as the written FK. **Falsify:** corrupt the locate's published field → witness fails (the corrupt-locate harness exists).

### E2 — Recursion-reach: data positions that refuse nested relation writes (4 sites)

The T3b1 shared recursive child-Part builder and the X1c whole-target delegation already carry nested data everywhere else; these four positions never got wired.

| Site | Shape | Mechanism |
|---|---|---|
| `RelationWritePart.ts:709` | inverse-side to-one `update` carrying relations | the located target's child Parts (`interpretChildParts`) — the to-many sibling already does this; arity-1 case |
| `UpdateOperation.ts:2729` | nested relation writes in a parent-held to-one `upsert` arm | X1c delegation: the arm becomes an `UpdateOperation` sub-op on the located target (T3c's own pattern, parent-held position) |
| `UpdateOperation.ts:2923` | a nested-relation target `create` on a parent-held to-one | the before-root INSERT becomes a create SUBTREE via `FreshArmBuilder` — N4-U2's exact move, parent-held position |
| `RelationJunctionPart.ts:2066` | relation writes inside m2m `updateMany` / `connectOrCreate` data | the junction's located/produced target takes the shared child-Part builder; `updateMany` scopes children per matched row or refuses with the measured multiplicity reason |

**Witnesses:** three-level trees through each position (the N4-U2 grandchild suite is the template), both substrates, wired into the four driver files. The m2m `updateMany` multi-row case gets an explicit multiplicity decision: measure Prisma, pin the answer. **Falsify:** re-add each refusal → its family fails; force one subtree to `undefined` → a behavioral witness fails (the N4-U2 lesson: conversions owe behavior, not reachability).

### E3 — Update-arm depth: the grandchild kind allowlist (3 sites)

`RelationUpsertPart.ts:1037` (only upsert/connectOrCreate/create one level deeper), `:1091` (m2m grandchild create), `:1097` (parent-held grandchild create). The located update arm holds a KNOWN primary key (literal or `planned`) — every mechanism the root owns applies:

- `:1091`: N3's junction machinery under a literal parent — the create-through-junction path with the located PK as the parent id.
- `:1097`: the before-parent fold with the located row as the receiving record (the arm's UPDATE gains the FK SET, ordered after the target INSERT — N5's reorder primitives).
- `:1037`: widen the switch to the remaining kinds (`update`/`delete`/`disconnect`/`set`/`updateMany`/`deleteMany` on the grandchild) via the same child-Part dispatch the root uses; kinds whose semantics do not survive the arm boundary get a measured refusal naming the boundary, not the kind.

**Witnesses:** per absorbed kind, both substrates, with the ATOM §4.1 order asserted across arm-grandchild siblings (swap-two-stages falsification). **Interplay risk (named):** the linearization order is derived once — grandchild kinds must dispatch through `RELATION_MUTATION_KEYS`, never a local order.

### E4 — Dispatch-bound residue (4 sites)

| Site | Shape | Mechanism |
|---|---|---|
| `CreateOperation.ts:985` | relation types outside child-held to-many / to-one under create | re-measure which type actually reaches (N7 proved reachability with a purpose-built schema); absorb it through its owning family or re-justify to (b) with the measurement |
| `RelationUpsertPart.ts:723` | relation types outside child-held to-many / inverse to-one at the nested-upsert builder | same: the parent-held and m2m upserts have their own Parts — route, don't refuse |
| `CreateOperation.ts:1521` | compound-referenced child edge under a create root | per-field `ParentIdSource` — N1-U2 proved per-field at the update root; the fresh-parent adopt takes the same per-field list (the audit's own note: "no measurement says why the fresh-parent adopt cannot take the same per-field source") |
| `RelationJunctionPart.ts:1608`-family | relation-carrying junction create arm with a generated target PK | the produced-identity Ref already feeds scalar arms; the relation-carrying arm becomes a create subtree whose root rides that Ref (N4-U4's backward-Ref, junction position) |

**Witnesses:** compound-edge create with per-field decoys (one field matching, one not — the wrong-pair probe); generated-PK junction arm with grandchildren asserting the produced id. **Falsify:** single-field-only regression on the per-field source → compound witness fails.

### TH — the type-honesty closure (after E1–E4, or parallel to E3/E4)

Narrow the computed input types for the **15 permanent** refusals (11 measured-impossible + 4 parity) so autocompletion stops offering what always throws:

- 1a set (per-relation omission): shared-PK kinds under create, unresolvable-reference kinds, owned-FK scalars in nested data, `skipDuplicates` on generated-PK junction `createMany`, m2m `upsert` under create.
- 1b set (one-of / position types): XOR-style single-kind to-one payloads; compound-PK children lose targeted-mutation kinds.
- Discipline: every narrowing ships a typo-beside-real-key contextual probe through the PUBLIC client types (the omit-work convention) plus a runtime witness that the refusal still fires for untyped callers.
- Explicitly out: the 16 sites this plan absorbs (their wide types become true), the 3 depth-contextual sites (recursive-type forking recorded as impractical), bucket 2/3 (type-inexpressible, reasons recorded).

## Ordering and parallelism

```
E1 ∥ E2      (disjoint: locate/lookup sources vs recursion wiring)
   │
E3 ∥ E4      (E3 needs E2's child-Part reach; E4's junction unit needs nothing from E3)
   │
TH           (types narrow only what E-waves did NOT absorb)
   │
Final: census re-audit (expected ~23; every survivor (a) or (b)), capability matrix rows,
full estate + gates + docker, delivery records per wave.
```

Sizes: E1 = M, E2 = L (the recursion positions are the deep water), E3 = M, E4 = M, TH = M. Census target: 39 → ~23, not pinned in advance — each absorption is measured, and a unit that hits a genuine wall re-justifies to (b) with the measurement rather than forcing it (the N-wave standard).

## Risks, named

1. **E2/E3 recursion under located arms** re-enters the wrong-row doctrine's hardest terrain — every new `planned`/`Ref` path needs the corrupt-locate provenance witness, not just state assertions.
2. **Linearization interplay** (E3): one order, one derivation; a grandchild dispatch with its own ordering is the forked-theorem regression ATOM §4.1 exists to prevent.
3. **The m2m `updateMany` multiplicity question** (E2) is a genuine semantics decision — measure Prisma before choosing; if Prisma refuses it too, that row flips to (a) and the unit shrinks.
4. **TH before absorption would narrow types that E-waves re-widen** — the ordering above is load-bearing.
