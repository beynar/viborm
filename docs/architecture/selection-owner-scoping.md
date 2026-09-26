# Item 4 scoping: one schema-only meaning for a selection

Status: first written as a reader-only scoping at `f250df80a` (2026-09-26), then
corrected and brought up to date after the consolidation round on branch
`engine-consolidation` (PR #52), then after the owner's `_count` ruling
(`945aaf8b2`, B2 below). Line numbers below are at that commit unless a
revision is named.

Each section labels its claims:
- **Measured**: observed by running code or counting lines, with the command or probe named.
- **Estimate**: a number derived from reading code, not from a built change.
- **Judgement**: a design opinion. Another reviewer can reasonably disagree.

The question: two interpreters read one selection.
- `Queries.prepareProjection` is the SQL preparer: src/query-engine/raptor3/shared/query.ts:3629-3803.
- `buildExpectedResultShape` is the schema-only shape that the TypeScript renderer reads:
  src/query-engine/result/result-shape.ts:148-376.

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
| 4 | Key `_count` means relation counts | 3651 (`name === "_count"`) | 233-257 (reads the value's shape) | **ONE MEANING, owned by the schema**: F010 refuses a member named `_count` (src/schema/validation/rules/model.ts `memberNamesAreNotReserved`, 945aaf8b2), so admission, the engine and the renderer all read `_count` as counts. B2 resolved |
| 5 | An empty count list publishes no `_count` | 3657 | 259 | Twice, agree |
| 6 | Counted relations = the truthy entries of `_count.select` | 3882-3892 | 238-257 (re-guards at 247 and 252, which admission already enforces; see count-filter.ts:56) | Twice, agree |
| 7 | A non-relation entry with a `_distance` record is the distance | 3674-3676 | 175 | Twice, agree |
| 8 | At most one distance per select | 3678-3679 | 176-177 | Twice, agree; **sentence shared** as `DISTANCE_SELECTED_TWICE` (R:53, bd6e17af2) |
| 9 | Output key `_distance` has one producer | 3684-3686 and 3705-3706 (two order-dependent checks) | 230-232 (one check after gathering) | Twice, agree; two algorithms; sentence shared (`DISTANCE_NAME_COLLISION`, R:49) |
| 10 | A recursive `_distance` slot vs a distance inside its node | 3815-3816 | 320-322 | Twice, agree |
| 11 | Ordinary relation vs variant slot | 3712-3717 (resolved edge kind) | 306, 353 (declaration state) | Twice, agree: one fact read from two sources |
| 12 | Nested node: `true` becomes `{}`, otherwise its select/include | 3860-3861 | 138-146 `getNestedSelection` | Twice, agree |
| 13 | Recurrence read from the admitted `recurse` | 3875 | 285-288 (an `as` assertion at 287) | Twice, agree |
| 14 | To-one vs to-many | 3834 `edge.many` | 326 `state.cardinality` | Twice, agree: one fact read from two sources |
| 15 | A negative take means reversed | 3838-3843 (the decoder reads it) | — | **ONE SPELLING**: the unread renderer copy was deleted (53a1bc2dd) |
| 16 | A slot may be empty (optional) | 3824 (recursive only) | 327, 376 | Owned by the renderer, except for recursive slots |
| 17 | Collection arms = `only`, else every arm | 3738 | 358 | **ONE OWNER**: `selectedArm` (R:79-90, 03ad902bc). An arm that `only` excludes is no longer recorded |
| 18 | Arm node = `variants[type]` / `configuration[type]`, default `true` | 3738 | 358 | **ONE OWNER**: `selectedArm` |
| 19 | Singular carrier: every arm is read, and an unnamed arm at its default projection | 3738 | 358 | **ONE OWNER**: `selectedArm`. The runtime now agrees (B1, 357dd412a) |
| 20 | Empty projection: refuse if `select` was written, else the sentinel | 3789-3794 | 263-268 | Twice, agree; **sentence shared** as `emptySelectRefusal` (R:61, B3, 5ca72ba37) |
| 21 | Relation counts beside a scalar `_count` are refused | none | none (deleted, 945aaf8b2) | **RETIRED**: unreachable once F010 refuses the member; the coverage moved to schema validation (guard-ownership ledger addendum, 2026-09-26) |
| 22 | Duplicate output columns are refused | none | 115-119 | Renderer only; no test; no admitted payload found that reaches it |
| 23 | Distance nullability = a nullable point | 3847-3854 `distanceLeaf` | src/client/typescript-type-renderer.ts:336-340 | Twice, agree |

Decisions that exist only in the engine:
- the default-projection cache (3633-3637, 3801);
- count filters, tagged arms and `countedMemberships` (3943-);
- integrity memberships;
- leaf descriptors;
- the distance specification;
- relation arguments (3862-3873);
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

The same entries after the consolidation round (`c245bb319`):

| Category at `c245bb319` | Entries | Count |
|---|---|---:|
| One owner, both views call it | 1, 17, 18, 19 | 4 |
| One spelling (the dead copy was deleted) | 15 | 1 |
| Twice; agree; sentence shared, guard in each view | 8, 9, 20 | 3 |
| Twice, agree, maintained independently | 3, 5, 6, 7, 10, 11, 12, 13, 14, 23 | 10 |
| Same key set; presentation order is per consumer | 2 | 1 |
| Twice, disagree | 4 (B2) | 1 |
| One side only | 16, 21, 22 | 3 |
| **Total** | | **23** |

And after the `_count` ruling (`945aaf8b2`):

| Category after the ruling | Entries | Count |
|---|---|---:|
| One owner, both views call it | 1, 17, 18, 19 | 4 |
| One meaning owned by the schema (every view reads `_count` as counts) | 4 | 1 |
| One spelling (the dead copy was deleted) | 15 | 1 |
| Twice; agree; sentence shared, guard in each view | 8, 9, 20 | 3 |
| Twice, agree, maintained independently | 3, 5, 6, 7, 10, 11, 12, 13, 14, 23 | 10 |
| Same key set; presentation order is per consumer | 2 | 1 |
| Twice, disagree | — | 0 |
| One side only | 16, 22 | 2 |
| Retired (unreachable guard deleted; coverage at schema validation) | 21 | 1 |
| **Total** | | **23** |

This plainly answers whether the smaller sharing left semantic decisions maintained
independently. It did:
- 10 decisions still agree only because two independent spellings happen to agree.
- 3 more share a sentence but keep a guard in each view.

What changed is narrower:
- the decisions where the views disagreed (#19, #20) or where a leaf function suffices
  (#1, #17, #18) now have one owner;
- #4 no longer disagrees: the schema owns the fact that makes `_count` one meaning, and
  the engine's model lookup behind the disagreement is gone;
- dead renderer state (#15, the excluded-arm record behind #17, and #21's guard) is gone.

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
- **B2: resolved by the owner's ruling (Arnaud, 2026-09-26: "_count is a reserved
  word").** Commit 945aaf8b2.
  - The defect: a model member named `_count` gave `select._count` / `include._count` two
    producers. Admission and the renderer read counts; the engine decided by model and
    published the member, even against `omit` and against the model's own `.omit()`; the
    static result type intersected the two. It was pinned as a known defect in
    count-member-collision-known-defect.test.ts (2ebadbc46, 48f434ae8), now deleted: its
    eight cells asserted answers the refusal makes unreachable.
  - The rule: schema validation refuses a member named `_count` (scalar, relation or
    variant slot) with one sentence, F010 (`memberNamesAreNotReserved`,
    src/schema/validation/rules/model.ts). It runs in `validateSchema` and in the selector
    rules of every effect-capable boundary (client construction, the standalone registry,
    migrations). A column keeps the name through `.map("_count")` on a renamed scalar.
    Only `_count` is reserved; `_distance` and the aggregate names are not.
  - Deleted because the invariant makes them dead:
    - The `!model["~"].state.scalars[name]` conjunct that stood beside E:3651's test. Restoring it changes no
      result (measured: 204 cells over the new contract, the sqlite3 behaviour file and
      the raptor3 projection/count files).
    - R's "Relation counts cannot be selected together with a model field named '_count'."
      guard (#21). Restoring it leaves layer-client and layer-query-engine green (1295
      cells). Ledger: guard-ownership-ledger.md, addendum of 2026-09-26.
    - The `_count` entry of groupBy's grouped-column collision list
      (src/validation/model/args/aggregate.ts `GROUP_AGGREGATE_KEYS`).
  - Unchanged, with reason: admission's count schema (select.ts `getSelectSchema`,
    `getIncludeSchema`) no longer overwrites anything, so there is nothing to delete; the
    omit desugar and the nested synthesized select produce `_count: true` only for a scalar
    of that name, which no longer exists; the bulk-write `select._count` refusal
    (bulk-write-projection.ts:107) is live on every model (it names the relation-derived
    projection instead of "Unknown key: _count"); the client result and input types were
    generic and only intersected because a scalar `_count` could exist.
  - Tests:
    - tests/contracts/public-client/count-reserved-member.core.test.ts: the exact F010
      issue from `validateSchema` and from client construction, for each member kind; a
      member mapped to the `_count` column is admitted, and admission and the renderer
      read `_count` beside it as counts (renderer pin). Disabling the refusal turns 7
      cells red (6 there, 1 in aggregate-args.core.test.ts).
    - tests/contracts/drivers/behaviors/relation-read-aggregate-behavior.ts, "a scalar
      mapped to the column `_count`" (sqlite3, libsql, PGlite, pg, postgres.js, mysql2):
      the column read under its member name beside the counts, `omit` of that member with
      counts included, orderBy count vs column, where on the column, a filtered count,
      groupBy by the column, and a model-hidden member in the `_count` column that no
      counts spelling publishes (the P09 and hidden-leak witnesses under the ruling).
    - tests/types/client/count-reserved-member.core.types.ts: the static pin; select
      `_count` is `true` or the count object (`false` refused), results are counts only.
  - The B2 follow-up scope (the four-owner change set that either candidate rule would
    have needed) is closed: the ruling needed only the schema rule and the deletions above.

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
   - #4 and #21 are settled by the ruling: `_count` is counts in every view.
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

**Both sides (#4, #21):** count-reserved-member.core.test.ts (schema refusal, admission and
renderer), the "a scalar mapped to the column `_count`" section of
relation-read-aggregate-behavior.ts (runtime, every registered provider) and
count-reserved-member.core.types.ts (static).

**Untested:**
- #2: the interleaved order, on either side;
- #22.
