# Item 4 scoping: one schema-only meaning for a selection

Status: reader-only scoping (2026-09-26), no source edited. Reviewed at
`f250df80a` on branch `engine-consolidation`. Verdict: do not build the shared
owner this round; see the recommendation at the end.

The question: `Queries.prepareProjection` (SQL preparer) and
`buildExpectedResultShape` (schema-only shape for the TypeScript renderer) both
interpret a selection. Is that one decision spelled twice, and what would a
shared owner delete?

## Method

I read both interpreters line by line. Then I ran a differential probe: 31 admitted payloads went
through `Queries.prepareProjection(...).shape` and through `buildExpectedResultShape(...)`, both
normalised to one canonical tree and compared by key set and key order. The divergences were then
checked on a live SQLite client (a throwaway SQLite probe, not committed).

Result: 24 SAME, 1 same set with a different order, 5 DIFFERENT, 1 refused at admission.

## Decisions, file:line

E = src/query-engine/raptor3/shared/query.ts, R = src/query-engine/result/result-shape.ts

| # | Selection decision | Engine (E) | Renderer shape (R) | Status |
|---|---|---|---|---|
| 1 | Default projection = scalars minus model `.omit()` | 3624-3630 inline | 146-150 via getDefaultScalarFieldNames (context/query-scope.ts:224-231) | SAME decision, **3 spellings**; the third is validation/model/core/projection.ts:52 `projectableScalarNames`, which calls itself "the one definition" |
| 2 | select and include merged into one output | 3624-3632 (spread; caller order) | 119-122, 153-187 (four passes: scalars, then select relations, then select variants, then include relations, then include variants, then `_count`) | Same set, **ORDER DIFFERS** (probe "select interleaved") |
| 3 | A falsy entry is skipped | 3637 | 91-96 selectedEntries; 130 | SAME |
| 4 | Key `_count` means relation counts | 3638 (only when no scalar `_count`) | 195-219 (always) | **DIVERGENT** (see B2) |
| 5 | An empty count list publishes no `_count` | 3640-3644 | 226-228 | SAME |
| 6 | Counted relations = truthy entries of `_count.select` | 3885-3888 | 200-217 (+ re-guards at 209 and 210-216 that admission already enforces: "A polymorphic to-one slot has no collection to count") | SAME |
| 7 | A non-relation entry with a `_distance` record is the distance | 3661-3664 | 135 | SAME |
| 8 | At most one distance per select | 3665-3668 | 136-140 | SAME; the sentence **literal is duplicated**, not shared |
| 9 | Output key `_distance` has one producer | 3669-3675 + 3689-3695 (two order-dependent checks) | 188-194 (one check after gathering) | SAME decision, two algorithms; shared constant DISTANCE_NAME_COLLISION |
| 10 | Recursive `_distance` slot vs a distance inside its node | 3809-3815 | 297-302 | SAME |
| 11 | Ordinary relation vs variant slot | 3701-3706 (resolved edge kind) | 286, 336-337 (declaration state) | SAME fact, two sources |
| 12 | Nested node: `true` becomes `{}`, else its select/include | 3859-3860, 3873 | 98-106, 290-294 | SAME |
| 13 | Recurrence read from the admitted `recurse` | 3874 | 249-257 (uses an `as` assertion at 256) | SAME |
| 14 | To-one vs to-many | 3833 edge.many | 306 state.cardinality | SAME fact |
| 15 | Negative take means reversed | 3837-3844 (the decoder reads it) | 259-268, 305, 384-386 | **R side is dead**: nothing reads `reversed` on ExpectedResultShape (the deleted cache codec never read it either) |
| 16 | Slot may be empty (optional) | 3823 (recursive only) | 307, 400 | Renderer-owned, except for recursive slots |
| 17 | Collection arms = `only`, else all | 3726-3733 | 361-362, 383 | SAME set; R also records excluded arms (`visible:false`), and its only reader skips them (typescript-type-renderer.ts:257). The stated reason ("the parser still refuses...", 370-373) belongs to a parser that is gone |
| 18 | Arm node = variants[type] or configuration[type], default `true` | 3734-3739 | 345, 353-355, 363-366, 378-380 | SAME |
| 19 | Singular carrier: which arms are read | 3727-3733 (only the NAMED arms unless the selection is `true`) | 343-359 (every arm; an unnamed arm gets its default projection) | **DIVERGENT, and a runtime bug** (see B1) |
| 20 | Empty projection: refuse if `select` was written, else sentinel | 3780-3794 (`names.ts`) | 230-237 (`state.name`) | SAME decision; **sentence DIVERGENT** (see B3) |
| 21 | Relation counts beside a scalar `_count` are refused | none | 221-225 | Renderer only; no test |
| 22 | Duplicate output columns are refused | none | 75-79 | Renderer only; no test; I found no admitted payload that reaches it |
| 23 | Distance nullability = point and nullable | 3846-3853 (physicalField) | typescript-type-renderer.ts:337-341 via distanceScalar | SAME decision, two sites |

These decisions exist only in the engine: the default-projection cache (3617-3621, 3800), count filters and tagged arms and countedMemberships (3889-3970), integrity memberships (3720-3725), leaf descriptors, the distance specification, relation arguments (3863-3872) and recursive identity (3826-3830).

These exist only in the renderer: `optional` outside recursion, the model reference per relation and arm, and the SQL-alias vocabulary. `rawKeys` carries DISTANCE_RESULT_KEY and RELATION_COUNTS_RESULT_KEY, and result-column.ts decodes them back to public names. No SQL uses these aliases any more; only R, result-column.ts and result-aliases.core.test.ts read them.

Tally: 15 decisions are spelled twice and agree (1, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 18, 23). 5 are shared but disagree today (2, 4/21, 19, 20). 1 is dead on the renderer side (15).

## Bugs the divergence exposes (confirmed on SQLite)

- **B1 (engine, runtime):** `comment.subject` is a required s.toOne variant slot. Take
  `findMany({ select: { id: true, subject: { article: { select: { title: true } } } } })` on a comment
  whose subject is a clip. It returns `subject: null`. The rendered type is non-null
  `article | clip(default projection)`, and docs/content/docs/schema/relations/polymorphic.mdx:349-351
  says "An omitted variant uses that model's default scalar projection, so the result union remains
  exhaustive". The static client type agrees with the docs
  (tests/types/client/polymorphic-result.core.types.ts:187-205 `_omittedVariantKeepsDefaultProjection`).
  The cause is E:3727-3733 (added in b2daea115). No runtime test covers it: every runtime test names
  every arm (tests/contracts/drivers/behaviors/polymorphic-relation-behavior.ts:287, :397).
- **B2 (three owners, three answers):** take a model with a scalar `_count` and a to-many. Admission gives
  `select._count` the relation-count meaning, because the `_count` count schema is spread over the
  scalar entry (validation/model/core/select.ts:319-326) and `_count: true` is desugared to
  `{select:{things:true}}`.
  - The engine (E:3638) then publishes the scalar: runtime `[{"id":"t1","_count":5}]`.
  - The renderer declares `_count: { things: number }`.
  - For `include: { _count: true }` the renderer refuses ("Relation counts cannot be selected together
    with a model field named '_count'."), while the runtime silently returns the scalar.
- **B3 (renderer sentence):** `renderOperationResultType(..., { select: { id: false } })` throws
  "The 'select' statement for model 'undefined' needs at least one truthy value.", because R:233 reads
  `state.name`. The engine throws "... model 'tally' ..." (E:3789 reads `names.ts`, pinned by
  parity-preparation.core.test.ts:99).

## Smallest shared owner

This is the schema-only meaning of ONE selection level. It would be a function
`selectedOutputs(model, admittedArgs, index)` returning an ordered list of
`scalar | distance{field,spec} | counts{requested} | relation{name,node,recurrence} | variants{name,many,arms[{variant,node}]} | sentinel`.
It would own decisions 1-9, 11-13, 17-20 and their three refusals.

Each consumer would keep its own recursion and its own payloads:
- the engine: leaves, counts preparation, memberships, arguments, cache;
- the renderer: models, optional, cardinality.

The renderer never calls the SQL preparer.

It is still a NEW abstraction: a six-variant union that both builders must switch over. It is not a universal intermediate language, but it is a new intermediate representation of the selection grammar.

## Line count under that design (measured regions, estimates per decision)

The regions were measured with an awk count of code, comment and blank lines:
- E prepareProjection 3604-3802: 199 lines (159 code, 40 comment)
- E relationShape and collectionShape: 42 lines
- E prepareRelationProjection: 22 lines
- R buildModelShape 108-247: 140 lines
- R addSelectedRelations: 42 lines
- R addSelectedPolymorphicRelations: 92 lines
- R helpers 91-106 and 249-268: 36 lines

| | Lines |
|---|---|
| Removed from the engine | ~76 (#1-9, 11, 17-20), plus ~15 of switch plumbing added back = net −60 |
| Removed from R | ~210 (buildModelShape 140→~35; relations 42→~18; polymorphic 92→~30; getNestedSelection −9; pagesBackward −10) |
| New owner | ~93 (union ~18, function ~60, doc ~15), of which ~60 are code MOVED from the engine |
| **Deleted** (net of moves) | ~226 |
| **Moved** | ~60 |
| **Added** (new) | ~48 |
| **Net** | **≈ −178** |

About 42 of those lines do not need the owner at all: the dead `reversed` (~26) and the dead
excluded-arm/`visible` representation (~16). **Net attributable to the owner ≈ −136**, which is under
the ~150 bar.

## Risks

1. **Not behaviour-preserving.** A single owner must pick one answer for #2, #4/#21, #19 and #20:
   - #2: with one loop, the renderer's rendered text order becomes caller order. The alternative is
     to change the runtime object key order.
   - #19: changes either the runtime result (the fix for B1) or the renderer.
   - #4/#21: changes either runtime or renderer, plus admission.
   - #20: changes the renderer sentence.

   All of these are public changes, and this round forbids them.
2. **Refusal census.** Moving 4 throws out of raptor3/** changes scripts/raptor3-refusal-census.mjs
   counts. The guard ledger needs entries for R:75-79 and R:221-225 if they are dropped.
3. **Performance.** prepareProjection runs per operation for every non-default projection. An
   intermediate array per level is a new allocation on the prepare path that the calibration evidence
   measures.
4. **Import hygiene.** The shared owner imports `projectableScalarNames` into raptor3 (the
   validation-barrel-cycle memory: import a leaf path, never the barrel).
5. **Estimate risk.** The per-decision numbers above are counted from real regions, not file sizes.
   The 60-line "moved" figure is the softest number; ±25 lines would not change the verdict.

## Recommendation

Do NOT build the shared owner this round:
- the honest net is ≈ −136 lines once the separable dead code is taken out;
- it needs a new abstraction;
- it cannot be behaviour-preserving because of 4 live divergences.

Take instead these behaviour-preserving deletions, each a "superseded mechanism with no caller" or a
"second spelling with an owner":
- (a) Delete `reversed` from ExpectedResultShape and ExpectedPolymorphicVariantShape
  (types.ts:168-173 partially, 185-186, 222-229) and R:259-268, 305, 384-386. ≈ −26 lines. Pinned by
  nothing; the renderer output is unchanged.
- (b) Record only the visible arms in R:370-386, drop `visible` (types.ts:177-184), and drop the filter at
  typescript-type-renderer.ts:257. ≈ −16 lines. Pinned by typescript-renderer-closure.core.test.ts:42
  (`only: []` gives `ReadonlyArray<never>`) and schema-introspection.core.test.ts:342.
- (c) Default projection: delete getDefaultScalarFieldNames (query-scope.ts:224-231, context/index.ts:12)
  and make R:147 and E:3626-3630 call validation/model/core/projection.ts:52. ≈ −12 lines.
  Semantics are identical (`omit` is `Record<string, true>`).
- (d) Share the one-distance sentence as a constant beside DISTANCE_NAME_COLLISION (±0 lines, one
  spelling).

Total ≈ −55 to −60 lines.

Separately, and not this round, open the three bugs as behaviour-changing work: B1 (the runtime returns
null against the docs and the static type), B2 (`_count` has three meanings) and B3 ('undefined' in
the renderer's sentence). Fixing B1 and B3 removes two of the four divergences. If B2 and the order
question are then settled, the shared owner can be scoped again on a smaller, behaviour-preserving
footing.

## Tests that pin each side

**Renderer:**
- tests/contracts/public-client/schema-introspection.core.test.ts: :242 (rows, #12/#14/#16), :330
  (#5/#6), :342 (#17/#18), :392/:410/:439/:478 (#13/#16)
- client-coverage.core.test.ts: :146 (#23), :193 (#19 with `true` only)
- typescript-renderer-nullability.core.test.ts: :9, :35 (#16)
- typescript-renderer-closure.core.test.ts: :42 (#17), :54 (#20 sentinel)
- tests/raptor3/recursive-query/distance-key-collision.test.ts: :187, :213 (#9/#10)
- tests/types/client/polymorphic-result.core.types.ts: :198 (the #19 contract, static)

**Engine:**
- parity-preparation.core.test.ts: :99-143 (#20)
- distance-parity.test.ts: :111; g4/unit01/repairs.test.ts: :24 (#8)
- parity-decoding.core.test.ts: :400 (#9)
- distance-key-collision.test.ts: :135, :225 (#9/#10)
- polymorphic-relation-behavior.ts: :287, :397 (#18, all arms named)
- result-aliases.core.test.ts (sentinel alias)

**Untested:**
- #2 interleaved order
- #4/#21 scalar `_count`
- #19 unnamed singular arm at runtime
- #22
- the renderer's copies of the #8 and #20 sentences
