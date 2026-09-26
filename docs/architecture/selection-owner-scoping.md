# Item 4 scoping: one schema-only meaning for a selection

Status: first written as a reader-only scoping at `f250df80a` (2026-09-26), then
corrected and brought up to date after the consolidation round on branch
`engine-consolidation` (PR #52), then after the owner's `_count` ruling
(`945aaf8b2`, B2 below), then after the `_distance` ruling (`ec844d8b5`,
`413984668`, below B2). Line numbers below are at `413984668` unless a
revision is named.

Each section labels its claims:
- **Measured**: observed by running code or counting lines, with the command or probe named.
- **Estimate**: a number derived from reading code, not from a built change.
- **Judgement**: a design opinion. Another reviewer can reasonably disagree.

The question: two interpreters read one selection.
- `Queries.prepareProjection` is the SQL preparer: src/query-engine/raptor3/shared/query.ts:3628-3790.
- `buildExpectedResultShape` is the schema-only shape that the TypeScript renderer reads:
  src/query-engine/result/result-shape.ts:144-336.

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
| 1 | Default projection = scalars minus the model's `.omit()` | 720-728 `defaultSelection`, 3640 | 179 | **ONE OWNER**: both call validation/model/core/projection.ts:52 `projectableScalarNames` (966d42c97, b05a13454) |
| 2 | select and include merged into one output | 3639-3642 (spread, caller order) | 161-202 (scalars, select relations, select variants, include relations, include variants, `_count`) | Same key set. **Presentation order differs**; each consumer owns its own order (see below) |
| 3 | A falsy entry is skipped | 3647 | 127-132 `selectedEntries`, 165 | Twice, agree |
| 4 | Key `_count` means relation counts | 3650 (`name === "_count"`) | 203-227 (reads the value's shape) | **ONE MEANING, owned by the schema**: F010 refuses a member named `_count` (src/schema/validation/rules/model.ts `memberNamesAreNotReserved`, 945aaf8b2), so admission, the engine and the renderer all read `_count` as counts. B2 resolved |
| 5 | An empty count list publishes no `_count` | 3656 | 229 | Twice, agree |
| 6 | Counted relations = the truthy entries of `_count.select` | 3863-3873 | 208-227 (re-guards at 217 and 222, which admission already enforces; see count-filter.ts:56) | Twice, agree |
| 7 | A non-relation entry with a `_distance` record is the distance | 3673-3675 | 169 | Twice, agree |
| 8 | At most one distance per select | 3677-3678 | 170-171 | Twice, agree; **sentence shared** as `DISTANCE_SELECTED_TWICE` (R:49, bd6e17af2) |
| 9 | Output key `_distance` has one producer | none (two order-dependent checks deleted, 413984668) | none (the check after gathering deleted, 413984668) | **RETIRED**: unreachable once F010 refuses a member named `_distance` (ec844d8b5); the coverage moved to schema validation (guard-ownership ledger, `_distance` addendum) |
| 10 | A recursive `_distance` slot vs a distance inside its node | none (deleted, 413984668) | none (deleted, 413984668) | **RETIRED**: the slot publishes under the relation's name, so only a relation named `_distance` could collide; F010 refuses it |
| 11 | Ordinary relation vs variant slot | 3699-3704 (resolved edge kind) | 275, 314 (declaration state) | Twice, agree: one fact read from two sources |
| 12 | Nested node: `true` becomes `{}`, otherwise its select/include | 3841-3842 | 134-142 `getNestedSelection` | Twice, agree |
| 13 | Recurrence read from the admitted `recurse` | 3856 | 255-258 (an `as` assertion at 257) | Twice, agree |
| 14 | To-one vs to-many | 3815 `edge.many` | 288 `state.cardinality` | Twice, agree: one fact read from two sources |
| 15 | A negative take means reversed | 3819-3824 (the decoder reads it) | — | **ONE SPELLING**: the unread renderer copy was deleted (53a1bc2dd) |
| 16 | A slot may be empty (optional) | 3805 (recursive only) | 289, 336 | Owned by the renderer, except for recursive slots |
| 17 | Collection arms = `only`, else every arm | 3725 | 319 | **ONE OWNER**: `selectedArm` (R:75-86, 03ad902bc). An arm that `only` excludes is no longer recorded |
| 18 | Arm node = `variants[type]` / `configuration[type]`, default `true` | 3725 | 319 | **ONE OWNER**: `selectedArm` |
| 19 | Singular carrier: every arm is read, and an unnamed arm at its default projection | 3725 | 319 | **ONE OWNER**: `selectedArm`. The runtime now agrees (B1, 357dd412a) |
| 20 | Empty projection: refuse if `select` was written, else the sentinel | 3776-3781 | 233-238 | Twice, agree; **sentence shared** as `emptySelectRefusal` (R:57, B3, 5ca72ba37) |
| 21 | Relation counts beside a scalar `_count` are refused | none | none (deleted, 945aaf8b2) | **RETIRED**: unreachable once F010 refuses the member; the coverage moved to schema validation (guard-ownership ledger addendum, 2026-09-26) |
| 22 | Duplicate output columns are refused | none | 111-115 | Renderer only; no test; no admitted payload found that reaches it |
| 23 | Distance nullability = a nullable point | 3828-3835 `distanceLeaf` | src/client/typescript-type-renderer.ts:336-340 | Twice, agree. Unchanged by the `_distance` ruling: the leaf's nullability is the point's, whatever else the model declares |

Decisions that exist only in the engine:
- the default-projection cache (3632-3636, 3788);
- count filters, tagged arms and `countedMemberships` (3924-);
- integrity memberships;
- leaf descriptors;
- the distance specification;
- relation arguments (3843-3854);
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

And after the `_distance` ruling (`ec844d8b5` reservation, `413984668` deletions):

| Category after both rulings | Entries | Count |
|---|---|---:|
| One owner, both views call it | 1, 17, 18, 19 | 4 |
| One meaning owned by the schema (every view reads `_count` as counts) | 4 | 1 |
| One spelling (the dead copy was deleted) | 15 | 1 |
| Twice; agree; sentence shared, guard in each view | 8, 20 | 2 |
| Twice, agree, maintained independently | 3, 5, 6, 7, 11, 12, 13, 14, 23 | 9 |
| Same key set; presentation order is per consumer | 2 | 1 |
| Twice, disagree | — | 0 |
| One side only | 16, 22 | 2 |
| Retired (unreachable guard deleted; coverage at schema validation) | 9, 10, 21 | 3 |
| **Total** | | **23** |

The `_distance` ruling moved two entries, both to **Retired**: #9 (from "sentence shared,
guard in each view": the engine's two order-dependent checks and the renderer's check after
gathering) and #10 (from "maintained independently": the recursive-slot check in each view).
Neither became a new "one meaning" row, unlike #4: `_count` is still a decision each view
makes (the key is counts), whereas "`_distance` has one producer" was only ever a refusal, and
with no member able to take the name there is nothing left to decide. The distance decisions
that remain are selection-side and unchanged: #7 (which entry is the distance), #8 (at most
one, `DISTANCE_SELECTED_TWICE`, still live) and #23 (its nullability). **Judgement:** #7 and
#23 are candidates for a leaf owner like `selectedArm`; the ruling does not change that.

This plainly answers whether the smaller sharing left semantic decisions maintained
independently. It did:
- 9 decisions still agree only because two independent spellings happen to agree (10 before
  the `_distance` ruling; #10 was one of them).
- 2 more share a sentence but keep a guard in each view (3 before; #9 was one of them).

What changed is narrower:
- the decisions where the views disagreed (#19, #20) or where a leaf function suffices
  (#1, #17, #18) now have one owner;
- #4 no longer disagrees: the schema owns the fact that makes `_count` one meaning, and
  the engine's model lookup behind the disagreement is gone;
- dead renderer state (#15, the excluded-arm record behind #17, and #21's guard) is gone;
- #9 and #10 are gone from both views: the schema owns the fact that `_distance` has one
  producer (F010), and the five checks and the `DISTANCE_NAME_COLLISION` sentence are deleted.

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
    - The three views on ONE schema (added after 945aaf8b2, so named rather than numbered): the
      behaviour suite's schema and its two selections now live in
      tests/contracts/drivers/behaviors/polymorphic-relation-schema.ts. The runtime cell reads
      them, the renderer cell "renders the behavior suite's unnamed-arm selections over its own
      schema" (schema-introspection.core.test.ts) renders them, and
      tests/types/client/polymorphic-relation-behavior.core.types.ts types them. **Measured:**
      dropping `?? true` from `selectedArm`'s singular branch fails the runtime cell on sqlite3
      and both renderer cells.
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
    At this ruling only `_count` was reserved; `_distance` followed the same day (next
    section). The aggregate names (`_avg`, `_sum`, `_min`, `_max`) are not reserved.
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
      mapped to the column `_count`" (runs on sqlite3, PGlite, pg, postgres.js, mysql2;
      libsql's only registration, tests/providers/local/libsql-parity-json.test.ts, sits
      in an unconditional `describe.skip` (DRIVER_NOT_SUPPORTED), so it never runs there):
      the column read under its member name beside the counts, `omit` of that member with
      counts included, orderBy count vs column, where on the column, a filtered count,
      groupBy by the column, and a model-hidden member in the `_count` column that no
      counts spelling publishes (the P09 and hidden-leak witnesses under the ruling).
    - tests/types/client/count-reserved-member.core.types.ts: the static pin; select
      `_count` is `true` or the count object (`false` refused), results are counts only.
  - The B2 follow-up scope (the four-owner change set that either candidate rule would
    have needed) is closed: the ruling needed only the schema rule and the deletions above.

## The `_distance` ruling (#9, #10)

**Owner ruling (Arnaud, 2026-09-26): "_distance is reserved too."**

- The rule: F010 refuses a member named `_distance` as it refuses `_count` (scalar, relation,
  variant slot), one sentence parameterised by the name and the output it is reserved for
  (`ec844d8b5`). `DeclaredModelShape` refuses the key at compile time with the reason literal.
  A column keeps the name through `.map("_distance")` on a renamed scalar.
- Before the ruling (measured, reproduced at `002ee0a90` before any change):
  distance-key-collision.test.ts passed 4 of 4 with a recursive relation named `_distance`
  admitted by `createClient` and the pair refused per query.
- Deleted because the invariant makes them dead (`413984668`):
  - E: the check before the distance (`fields[DISTANCE_FIELD]`), the check after it
    (`name === DISTANCE_FIELD && distanceSelected`) and `relationShape`'s recursive check;
  - R: the check after gathering, the `selectedOutputKeys` set only it read, and
    `addSelectedRelations`' recursive mirror;
  - the `DISTANCE_NAME_COLLISION` sentence.

  The recursive checks (#10) were read before deletion: the repeated slot publishes under the
  relation's own name, which admission refuses inside its node, so a field of that name in the
  node existed only when the relation was named `_distance`. That is a member against the
  distance, not a second collision between two selection-side producers, so it is dead too.
  `DISTANCE_SELECTED_TWICE` (#8, two distances in one select) is selection-side and stays.
- Falsified (measured): with all five checks restored against their deletion, `layer-*` is
  423 files / 9,005 cells passed both ways, `raptor3` is 2,002 passed / 7 failed both ways (the
  known reds), and a 51-case probe (the round's probe with the `tally` fixture renamed, plus a
  point model with a member mapped to the `_distance` column and a recursive relation: the
  distance beside the mapped member and beside the slot in both orders, inside the repeated
  node (to-many and to-one), a top-level `_distance` key (admission: "Unknown key:
  _distance"), two distances, and two select-beside-include spellings asked of the engine and
  the schema-only shape directly) is byte-identical. The probe sits in the session
  scratchpad (`distance-reserved/probe/`).
- Refusal census (measured, `node scripts/raptor3-refusal-census.mjs`): inherited 79 sites /
  77 sentences → 76 / 76; total 206 → 203. The three sites were query.ts's throws of the deleted
  sentence; invariant 25 / 24, candidate 44 / 35 and sentence-less 58 are unchanged.
- Tests:
  - count-reserved-member.core.test.ts: :183 and :194, the F010 refusal table over both
    names (scalar, relation, variant slot, at `validateSchema` and at client construction);
    :208 both names on one model; :223 the `.map` remedy admitted for both columns; :260
    admission and the renderer read `_distance` as the distance beside the mapped member.
  - distance-key-collision.test.ts: :179 the recursive relation named `_distance` refused at
    `validateSchema`, `EngineSchema` and `createClient` (no statement); :195 and :223 the
    pair's four spellings under the renamed relation keep both keys in the engine and the
    renderer; :272 each producer alone.
  - geopoint-behavior.ts: :440 the column read and written under the member name (every
    tier: sqlite3, libsql, PGlite, pg, postgres.js, mysql2); :467 a distance selected and
    ordered beside it (full tier: PGlite with PostGIS, mysql2 pass; pg and postgres.js fail on
    the docker container's missing PostGIS, as every GeoPoint cell there does).
  - count-reserved-member.core.types.ts: the four `@ts-expect-error` refusals and the static
    result `{ score: number; _distance: number }`.

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
  its own projection, and the renderer never calls the SQL preparer. (The `_distance` ruling
  later deleted #9's guards; `DISTANCE_SELECTED_TWICE` stays.)
- `visible` was a presentation filter, not a refusal.
- The guard-ownership ledger is unchanged.
- Refusal census (measured, `node scripts/raptor3-refusal-census.mjs --at <rev>`):
  - main (6729e0f87): invariant 25 sites / 24 sentences, inherited 79 / 77, candidate 45 / 36,
    sentence-less 58, 207 sites.
  - 5d9adc5b7, before the census followed imported builders: inherited 78 / 76, sentence-less 59.
    B3 (5ca72ba37) made the empty-select throw call `emptySelectRefusal(model)` from
    result-shape.ts, and the census did not follow a call, so query.ts's empty-select site
    dropped from inherited to sentence-less. That was a blind spot in the census, not a change
    in what the engine refuses.
  - After the census learned to follow an imported function whose body returns one template
    (and at 5d9adc5b7 read with it): inherited 79 / 77, sentence-less 58, candidate 44 / 35,
    206 sites.
  - The one remaining difference from main is e6679e1f3: the deleteMany and updateMany
    "selected-row cardinality changed during its locked mutation" sentences are now one
    `${verb}` template at one site. Candidate goes from 45 / 36 to 44 / 35. Line numbers
    differ too.

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
- polymorphic-result.core.types.ts (static): :198, :232 and :235 (#19).

**Engine:**
- parity-preparation.core.test.ts: :95-146 (#20, #5).
- distance-parity.test.ts:111 and g4/unit01/repairs.test.ts:24 (#8).
- polymorphic-relation-behavior.ts: :217 (#18) and :427 (#19).
- polymorphic-collection-read-behavior.ts: :325 and :341 (#17).
- result-aliases.core.test.ts (the sentinel alias).

**Both sides (#4, #21):** count-reserved-member.core.test.ts (schema refusal, admission and
renderer), the "a scalar mapped to the column `_count`" section of
relation-read-aggregate-behavior.ts (runtime, every registered provider) and
count-reserved-member.core.types.ts (static).

**Both sides (#9, #10, retired):** the F010 refusal pins in count-reserved-member.core.test.ts
and distance-key-collision.test.ts:179; distance-key-collision.test.ts:195 and :223 (the old
pair's spellings keep both keys, engine and renderer); geopoint-behavior.ts:440 and :467
(runtime); count-reserved-member.core.types.ts (static).

**Untested:**
- #2: the interleaved order, on either side;
- #22.
