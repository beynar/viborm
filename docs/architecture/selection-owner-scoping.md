# Item 4 scoping: one schema-only meaning for a selection

Status: first written as a reader-only scoping at `f250df80a` (2026-09-26), then
corrected and brought up to date after the consolidation round on branch
`engine-consolidation` (PR #52). Line numbers below are at that branch's tip
unless a revision is named.

Each section labels its claims:
- **Measured**: observed by running code or counting lines, with the command or probe named.
- **Estimate**: a number derived from reading code, not from a built change.
- **Judgement**: a design opinion. Another reviewer can reasonably disagree.

The question: two interpreters read one selection.
- `Queries.prepareProjection` is the SQL preparer: src/query-engine/raptor3/shared/query.ts:3629-3801.
- `buildExpectedResultShape` is the schema-only shape that the TypeScript renderer reads:
  src/query-engine/result/result-shape.ts:148-381.

Which of their decisions are one meaning spelled twice? Which can share one owner?

The objective this round, from the owner's reviewer: make selection meaning agree across
admission, runtime and types, then delete the duplicated rules that the agreement makes
unnecessary. Shared selection meaning is in scope. Each consumer's own responsibilities stay
where they are:
- SQL generation stays in the engine.
- Rendering stays in the renderer.
- Presentation order stays with each consumer.

## Method (measured)

**The original scoping.** At `f250df80a`, a differential probe sent 31 admitted payloads
through both interpreters and compared the two outputs as canonical trees.
- 24 SAME.
- 1 had the same key set in a different order.
- 5 DIFFERENT.
- 1 was refused at admission.

The differences were then reproduced on a live SQLite client.

**This round.** A second probe (36 admitted selections; the engine's prepared fields and shape,
plus the rendered text) was run before and after each consolidation commit. Every consolidation
commit is byte-identical to its predecessor on that probe. The probe sits outside the repository,
in the session scratchpad (`consolidate-report/probe/`).

## Decisions, file:line (current tip)

E = src/query-engine/raptor3/shared/query.ts. R = src/query-engine/result/result-shape.ts.

| # | Selection decision | Engine (E) | Renderer shape (R) | Status now |
|---|---|---|---|---|
| 1 | Default projection = scalars minus the model's `.omit()` | 721-729 `defaultSelection`, 3641 | 185 | **ONE OWNER**: both call validation/model/core/projection.ts:52 `projectableScalarNames` (966d42c97, b05a13454) |
| 2 | select and include merged into one output | 3640-3643 (spread, caller order) | 166-225 (scalars, select relations, select variants, include relations, include variants, `_count`) | Same key set. **Presentation order differs**; each consumer owns its own order (see below) |
| 3 | A falsy entry is skipped | 3648 | 131-136 `selectedEntries`, 170 | Twice, agree |
| 4 | Key `_count` means relation counts | 3649 (only when the model has no scalar `_count`) | 233-257 (reads the value's shape) | **DIVERGENT: B2, deferred** |
| 5 | An empty count list publishes no `_count` | 3655 | 264 | Twice, agree |
| 6 | Counted relations = the truthy entries of `_count.select` | 3880-3890 | 238-257 (re-guards at 247 and 252, which admission already enforces; see count-filter.ts:56) | Twice, agree |
| 7 | A non-relation entry with a `_distance` record is the distance | 3672-3674 | 175 | Twice, agree |
| 8 | At most one distance per select | 3676-3677 | 176-177 | Twice, agree; **sentence shared** as `DISTANCE_SELECTED_TWICE` (R:53, bd6e17af2) |
| 9 | Output key `_distance` has one producer | 3682-3684 and 3703-3704 (two order-dependent checks) | 230-232 (one check after gathering) | Twice, agree; two algorithms; sentence shared (`DISTANCE_NAME_COLLISION`, R:49) |
| 10 | A recursive `_distance` slot vs a distance inside its node | 3813-3814 | 325-327 | Twice, agree |
| 11 | Ordinary relation vs variant slot | 3710-3715 (resolved edge kind) | 311, 358 (declaration state) | Twice, agree: one fact read from two sources |
| 12 | Nested node: `true` becomes `{}`, otherwise its select/include | 3858-3859 | 138-146 `getNestedSelection` | Twice, agree |
| 13 | Recurrence read from the admitted `recurse` | 3873 | 290-293 (an `as` assertion at 292) | Twice, agree |
| 14 | To-one vs to-many | 3832 `edge.many` | 331 `state.cardinality` | Twice, agree: one fact read from two sources |
| 15 | A negative take means reversed | 3836-3841 (the decoder reads it) | — | **ONE SPELLING**: the unread renderer copy was deleted (53a1bc2dd) |
| 16 | A slot may be empty (optional) | 3822 (recursive only) | 332, 381 | Owned by the renderer, except for recursive slots |
| 17 | Collection arms = `only`, else every arm | 3736 | 363 | **ONE OWNER**: `selectedArm` (R:79-90, 03ad902bc). An arm that `only` excludes is no longer recorded |
| 18 | Arm node = `variants[type]` / `configuration[type]`, default `true` | 3736 | 363 | **ONE OWNER**: `selectedArm` |
| 19 | Singular carrier: every arm is read, and an unnamed arm at its default projection | 3736 | 363 | **ONE OWNER**: `selectedArm`. The runtime now agrees (B1, 357dd412a) |
| 20 | Empty projection: refuse if `select` was written, else the sentinel | 3787-3792 | 268-273 | Twice, agree; **sentence shared** as `emptySelectRefusal` (R:61, B3, 5ca72ba37) |
| 21 | Relation counts beside a scalar `_count` are refused | none | 259-263 | Renderer only; part of B2. Now executed by the known-defect file |
| 22 | Duplicate output columns are refused | none | 115-119 | Renderer only; no test; no admitted payload found that reaches it |
| 23 | Distance nullability = a nullable point | 3845-3852 `distanceLeaf` | src/client/typescript-type-renderer.ts:336-340 | Twice, agree |

Decisions that exist only in the engine:
- the default-projection cache (3633-3637, 3799);
- count filters, tagged arms and `countedMemberships` (3941-);
- integrity memberships;
- leaf descriptors;
- the distance specification;
- relation arguments (3860-3871);
- recursive identity.

Decisions that exist only in the renderer:
- `optional`, outside recursion;
- the model reference for each relation and arm;
- the SQL-alias vocabulary: `rawKeys`, decoded by result-column.ts.

### Tally (measured by reading the table; the categories sum to 23)

The original scoping printed "15 + 5 + 1 = 21", which does not reconcile with 23 numbered
entries: it counted #4 and #21 as one, and it left out #16 and #22. The corrected tally at
`f250df80a`:

| Category at `f250df80a` | Entries | Count |
|---|---|---:|
| Spelled twice, agree | 1, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 18, 23 | 15 |
| Spelled twice, disagree | 2 (order only), 4, 19, 20 | 4 |
| Dead on the renderer side | 15 | 1 |
| One side only | 16, 21, 22 | 3 |
| **Total** | | **23** |

The same entries at the branch tip:

| Category at the tip | Entries | Count |
|---|---|---:|
| One owner, both views call it | 1, 17, 18, 19 | 4 |
| One spelling (the dead copy was deleted) | 15 | 1 |
| Twice; agree; sentence shared, guard in each view | 8, 9, 20 | 3 |
| Twice, agree, maintained independently | 3, 5, 6, 7, 10, 11, 12, 13, 14, 23 | 10 |
| Same key set; presentation order is per consumer | 2 | 1 |
| Twice, disagree | 4 (B2) | 1 |
| One side only | 16, 21, 22 | 3 |
| **Total** | | **23** |

This plainly answers whether the smaller sharing left semantic decisions maintained
independently. It did:
- 10 decisions still agree only because two independent spellings happen to agree.
- 3 more share a sentence but keep a guard in each view.
- #4 still disagrees.

What changed is narrower:
- the decisions where the views disagreed (#19, #20) or where a leaf function suffices
  (#1, #17, #18) now have one owner;
- dead renderer state (#15, and the excluded-arm record behind #17) is gone.

## B1, B2, B3: status on this branch

- **B1: fixed.** The engine read only the arms of a singular variant slot that the selection
  named. A row of an unnamed arm came back `null`, against polymorphic.mdx, the renderer and the
  static type.
  - Fix: commit 357dd412a, now expressed through `selectedArm` (03ad902bc).
  - Tests:
    - polymorphic-relation-behavior.ts:427 "an arm the selection leaves unnamed reads at its
      default projection" runs on sqlite3, pglite, pg and mysql2. It also reads the unnamed arm's
      missing row as the slot's integrity refusal.
    - schema-introspection.core.test.ts:362 is the renderer pin.
    - polymorphic-result.core.types.ts:232 and :235 are the static pins.
    - g4/review/unit01/variant-arms.test.ts:61 previously pinned the null.
- **B3: fixed.** The renderer's empty-select refusal named model `'undefined'`.
  - Fix: commit 5ca72ba37. One sentence, `emptySelectRefusal`, shared by both views.
  - Test: typescript-renderer-closure.core.test.ts:80.
- **B2: not fixed; deferred on purpose.** It is pinned as a known defect in
  tests/contracts/public-client/count-member-collision-known-defect.test.ts (2ebadbc46). That
  file's six tests say "documents the defect" and record today's answers from four surfaces:
  admission, the renderer, the SQLite runtime and, through tsc, the static types.
  - It is deferred because the public contracts conflict. There is nothing yet to implement
    against.
  - The documentation (selecting.mdx:221-238), admission's runtime, the renderer and the retired
    V1 engine read `_count` in select/include as relation counts.
  - The engine decides by model and publishes the scalar. It does so even when `omit` removed it,
    which is a plain bug on any reading.
  - The static types intersect the two answers.

### B2 follow-up scope (bounded)

B2 needs an explicit collision contract before any implementation. The owner rules between
two candidate rules. **Judgement:** the audit leaned toward (iii).
- **(iii)** The member wins wherever it exists, and relation counts are not offered as a
  projection on that model.
- **(iv)** One producer per output key, with the input's meaning read from the value's shape,
  as in the `_distance` precedent.

Once ruled, the work is one change set across four owners, plus tests on each side:
1. **Admission:**
   - src/validation/model/core/select.ts, near :303-327 and :369;
   - the omit desugar, src/validation/model/args/omit.ts:76-89;
   - the nested synthesized select, src/validation/relations/select-include.ts:49-55;
   - the bulk projection admission, bulk-write-projection.ts:107.
2. **Execution:** E:3649, which decides by model today. Under (iii) it is unchanged; under (iv)
   it reads the value's shape.
3. **Rendering:** R:233-263. Under (iii) the pair refusal at R:259-263 becomes unreachable and is
   deleted, with a guard-ownership-ledger entry.
4. **Types:** src/client/result-types.ts `InferSelectedFields` (:869-884),
   `InferRelationCountSelection` (:1004-1018), and the intersections in `InferSelectResult` /
   `InferIncludeResult` (:846-857, :1023-1043). The select input type must match admission.
5. **Tests:** the known-defect file is replaced by the ruled contract. It needs:
   - a runtime cell in tests/contracts/drivers/behaviors/, so it runs on every provider;
   - a renderer pin;
   - a static pin.

   The `@ts-expect-error` in the known-defect file fails tsc as soon as the select input type
   changes, which forces the replacement.
6. **Docs:** one paragraph in selecting.mdx, with the rename-and-`.map("_count")` remedy.

A sibling case sits in the same scope: a RELATION named `_count`. Under (iii) the member wins, so
it returns the relation. Under (iv) the rule does not extend to it.

## What this round shared, and why each deletion is safe

Each commit is behaviour-preserving on the 36-selection probe (measured).

- **966d42c97: default projection, one owner.** Deleted `getDefaultScalarFieldNames` and its
  context re-export, and the engine's inline filter.
  - Invariant: `.omit()` is typed `Record<Hidden, true>`, and hydration refuses a field name that
    collides with an Object.prototype property (schema/hydration.ts:135). So the engine's truthy
    lookup and the owner's own-`true` lookup agree.
  - Pins: typescript-renderer-closure.core.test.ts:92 (renderer; it fails when the renderer reads
    every scalar), omit-behavior.ts (runtime, model-level omit through an include) and
    parity-preparation.core.test.ts:111 (engine).
- **53a1bc2dd: the renderer's `reversed` flag deleted.**
  - Invariant: nothing reads it. tsc compiles with the field removed from both interfaces.
  - The renderer's output does not depend on row order.
- **03ad902bc: `selectedArm`.** This deleted:
  - the renderer's separate singular and collection branches;
  - `visible` and the excluded-arm record;
  - the filter at typescript-type-renderer.ts;
  - the engine's `as string[] | undefined` assertion and its per-arm `{}` allocation.

  Invariant: admission refuses a `variants` key outside `only` (select-include.ts:329), so an
  excluded arm was always shaped from `{}`, could not throw, and was never rendered.

  Pins: one mutation of `selectedArm` fails both views.
  - Singular rule: schema-introspection.core.test.ts:362, polymorphic-relation-behavior.ts:427
    and variant-arms.test.ts.
  - `only` rule: typescript-renderer-closure.core.test.ts:68, schema-introspection.core.test.ts:342,
    and polymorphic-collection-read-behavior.ts:325 and :341.
- **bd6e17af2: one-distance sentence shared.**
  - The renderer's copy was untested. It is now pinned at typescript-renderer-closure.core.test.ts:117,
    and a mutated sentence fails that test.
  - The census follows imported constants: no change.
- **b05a13454:** `defaultSelection` replaces a `.map` to tuples plus `Object.fromEntries`. See the
  cost below.

No guard was added or removed in (c).
- The two distance guards and the empty-select guard stay, one in each view: each view prepares
  its own projection, and the renderer never calls the SQL preparer.
- `visible` was a presentation filter, not a refusal.
- The guard-ownership ledger is unchanged.
- Refusal census (measured): before and after the consolidation commits it differs only in line
  numbers.

## Preparation-path cost (measured)

This is a fresh-process micro-benchmark of `Queries.prepareProjection`:
- 33 admitted selections (the 36 probe cases minus 3 refused ones), 20,000 iterations each, after
  warm-up;
- PostgreSQL adapter;
- each run a separate vitest process;
- rounds alternate which tree runs first.

It is a micro-benchmark on one laptop. It is not a claim about operation latency.

| Comparison | Paired ratios (branch / base) | Median |
|---|---|---:|
| Before the consolidation (2ebadbc46) → tip, 6 rounds | 1.024 0.962 1.042 0.991 0.988 1.011 | 1.001 |
| main (6729e0f87) → tip, 5 rounds | 1.031 1.038 1.216 1.014 1.050 | 1.038 |

The main → tip ratio includes B1's intended extra work. A singular selection now prepares every
arm: the "poly one" cases cost 1.16× to 2.08× on their own. Round 3 was noisy on both trees.

Per case against 2ebadbc46, the medians range from 0.85 to 1.22:
- polymorphic collection levels cost about +7-10% (the `selectedArm` lookups per arm);
- a default projection on a model with `.omit()` costs about +22%, about 40 ns. The owner calls
  `Object.keys` where the engine read a cached name list.

The allocation count per level does not grow:
- the written-`select` path keeps one spread;
- the default path drops one array and one tuple per scalar;
- the `.omit()` default path allocates `Object.keys` in place of the old `.map` array.

## A shared owner for the rest: options, not a verdict

The original scoping sketched one design for sharing the remaining decisions. It is a function
`selectedOutputs(model, admittedArgs, index)` that returns an ordered list of six kinds:
`scalar | distance | counts | relation | variants | sentinel`. Each consumer would keep its own
recursion and payloads.

That is **one proposed design**. It does not prove that all sharing requires an intermediate
representation: this round shared five decisions through a leaf function or a constant beside
the existing ones. Nor should that design be rejected merely because it is new. **Judgement:** a
new abstraction earns its place if it removes independently maintained decisions at a measured
preparation-path cost the engine can afford.

Two alternatives are equally open:
- continue with small leaf owners per decision, for #6, #7, #12 and #23;
- give the renderer the engine's prepared shape, if its schema-only needs (models, optional)
  can be read from the resolved index.

What still decides the question:
1. **Unresolved observable behaviour.**
   - #4/#21 (B2) have no contract yet. A shared owner would have to pick one answer.
   - #2 is not a divergence of meaning: both views agree on the key set, and the order is
     presentation. The engine's runtime key order follows the caller's selection. The rendered
     type's field order follows the renderer's passes. A shared owner must either carry an order
     each consumer may re-sort, or change one public order. Changing an order is a public change
     and needs its own decision.
2. **Unmeasured preparation-path cost.** An intermediate list per selection level is an
   allocation on a path that runs per operation for every non-default projection. This round
   measured only the small sharing above. The six-kind list itself has not been built or measured.

### Line counts (estimates)

These are estimates at `f250df80a`, from region counts. Nothing was built.
- The six-kind owner would delete roughly 226 lines, move roughly 60 and add roughly 48: about
  −178 net.
- About 42 of those lines needed no owner: the `reversed` flag and the `visible` representation.
  They were deleted this round.
- The remaining estimate attributable to the owner is about −136 lines. The 60-line "moved" figure
  is the softest input.

**Measured, this round:** src/** changed by +68 / −128 physical lines across 6 files
(`git diff --numstat 2ebadbc46 HEAD -- src`). Source deletion alone is not a bundle or
performance claim.

The earlier report measured the size of a win against a "~150-line bar". That bar is withdrawn:
no line threshold decides whether an abstraction is justified. The criteria are the ones above:
- agreed observable behaviour;
- fewer independently maintained decisions;
- measured cost.

## Tests that pin each side

**Renderer:**
- schema-introspection.core.test.ts:
  - :242 (#12, #14, #16);
  - :330 (#5, #6);
  - :342 (#17, #18);
  - :362 (#19);
  - :435, :453, :482 (#13, #16).
- client-coverage.core.test.ts: :146 (#23) and :193 (#19 with `true`).
- typescript-renderer-nullability.core.test.ts: :9 and :35 (#16).
- typescript-renderer-closure.core.test.ts: :68 (#17), :80 (#20), :92 (#1), :117 (#8).
- distance-key-collision.test.ts: :187 and :213 (#9, #10).
- polymorphic-result.core.types.ts (static): :198, :232 and :235 (#19).

**Engine:**
- parity-preparation.core.test.ts: :95-146 (#20, #5).
- distance-parity.test.ts:111 and g4/unit01/repairs.test.ts:24 (#8).
- parity-decoding.core.test.ts:400 (#9).
- distance-key-collision.test.ts: :135 and :225 (#9, #10).
- polymorphic-relation-behavior.ts: :217 (#18) and :427 (#19).
- polymorphic-collection-read-behavior.ts: :325 and :341 (#17).
- result-aliases.core.test.ts (the sentinel alias).

**Known defect:** count-member-collision-known-defect.test.ts pins today's answers for #4 and #21.

**Untested:**
- #2: the interleaved order, on either side;
- #22.
