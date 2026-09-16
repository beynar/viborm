# G4-01 — complete query and projection semantics (unit note)

Author: sole production author for G4-01. Worktree `/private/tmp/viborm-g4-unit01`
(detached at `0cc61e61`). Evidence directory:
`docs/architecture/raptor3-evidence/g4/unit01/`.

Revision 1 written **before the first production edit** (decision-elimination
gate, plan §7). Sections 6–9 are completed at hand-off against the actual diff.

---

## 1. Required behavior

Inventory rows this unit must make executable through
`createCommandEngine(config).execute(model, operation, rawArgs)` on real SQLite,
and adapter-spelled (not natively executed) for PostgreSQL/MySQL:

- **Operations.** OP-R01 `findUnique` (+ `findUniqueOrThrow` absence → the
  established not-found identity), OP-R03 `findFirst` (+ `OrThrow`), OP-R05
  `findMany` with `distinct` and `cursor`, OP-R06 `count` (number and selected
  `{ _all, field }`), OP-R07 `exist`, OP-R08 `aggregate`, OP-R09 `groupBy` with
  `having` AND/OR/NOT over scalar and aggregate predicates, aggregate ordering
  and paging.
- **Filters.** Q-W01–Q-W10: recursive AND/OR/NOT; comparable scalars with
  `in`/`notIn`/`not`/field references; string `contains`/`startsWith`/`endsWith`
  with `mode` and exact-text spellings; list `equals/has/hasEvery/hasSome/isEmpty`;
  JSON path/sentinel/string/array predicates; GeoPoint equality/within/distance
  per adapter tier; to-one shorthand plus `is`/`isNot`; collection
  `some`/`every`/`none`; tagged variant predicates.
- **Ordering.** Q-O01–Q-O04: `asc`/`desc`/`{ sort, nulls }`; to-one relation
  paths (≤ 8 hops, to-many refused by validation); collection `_count`;
  vector/GeoPoint distance with unambiguous output names.
- **Paging.** Q-P01–Q-P03: cursor + signed `take` + `skip`; `distinct` before
  windowing; every to-many nested node with its own
  `where/orderBy/take/skip/cursor/distinct/select/include/omit` per parent.
- **Projection.** Q-S01–Q-S03: `select`/`include`/`omit`; `_count` (`true` or
  per-collection with `where`); variant `{ only?, variants }` arms.
- **Aggregate shapes.** Q-A01–Q-A02 as the validation owner admits them.
- **Result.** Q-R01: provider rows, carriers and public arrays decoded once by a
  strict decoder that rejects malformed rows with the established identities and
  returns fresh public containers.
- **Codecs.** SC-01–SC-14 and SL-01–SL-10 at the read side (filter operands,
  cursor/order operands, projection decode) through the existing codec owners.
- **Recursive fit.** `Queries.recursive` keeps passing
  `tests/raptor3/prep/recursive-read-fit.test.ts` and gains the fuller
  projection/codec vocabulary.

Out of scope here (G4-02): root `delete` (OP-W03), write-side `data` codec
crossings, multiply/divide arithmetic in `Queries.updateValue`.

## 2. Current owner (state at `0cc61e61`)

| Fact | Current owner | Current breadth |
| --- | --- | --- |
| Column name / codec admission | `Queries.columnName` | **throws** for every scalar type except `int`, `string`, `decimal`, and for every list |
| Value lowering | `Queries.fieldValue` | decimal + pass-through only |
| Selector | `Queries.prepareSelector` → `prepareWhere` → `prepareScalarPredicate` → `prepareScalarOperations` | `equals`, `in`, `gt/gte/lt/lte`, `not`, `isNull`, field refs |
| Relation predicate | `prepareRelationPredicate` / `lowerRelationPredicate` | `some/none/every/is/isNot` on ordinary edges |
| `having` predicate | `Queries.lowerValuePredicate` | **second copy** of the same operator ladder, over an aggregate expression |
| Order | `Queries.order` / `orderTerms` | scalar `asc`/`desc` only |
| Page | `Queries.select` | `take`/`skip` only; no cursor, no distinct |
| Projection | `prepareProjection` / `lowerProjection` / `decodeProjection` | scalars (int/string/float/decimal), relation carriers, variant arms; no `omit`, no `_count`, no nested cursor/distinct |
| Grouped read | `Queries.grouped` | **second copy** of shape assembly (`by` columns, `_count`, `_sum/_min/_max/_avg` as `int`/`float` leaves) |
| Read dispatch | `commands/index.ts` | `findUnique` (as `select` + `take: 1` special case), `findMany`, `groupBy` |
| Admitted operations | `shared/schema.ts` `Operation` | no `findFirst`, `count`, `exist`, `aggregate` |
| Read/write route split | `operation-context.ts` `run()` | hard-coded triple `findMany` / `findUnique` / `groupBy` |

## 3. Smallest proposed change

One prepared predicate, one order owner, one page owner, one projection owner,
one decoder, consumed by every read verb as a cardinality/shape decision.

1. **Target-carrying predicates.** `PreparedPredicate` comparisons address a
   `PreparedTarget` (a physical column *or* an aggregate expression over one)
   instead of only a `PreparedScalar`. The operator vocabulary is prepared once
   and lowered once. `lowerValuePredicate` is deleted; `having` prepares the same
   predicate against aggregate targets.
2. **One operator vocabulary.** `prepareScalarOperations` gains the remaining
   admitted operators (`notIn`, `contains`/`startsWith`/`endsWith` + `mode`,
   list `has/hasEvery/hasSome/isEmpty`, JSON `path`/`string_*`/`array_*`,
   GeoPoint `within`/`distance`) as prepared nodes; the adapter spells each one.
3. **One value-lowering owner.** `Queries.fieldValue` becomes the single
   destination-aware operand owner (null, JSON-null sentinel, list container,
   JSON document, GeoPoint, DateTime native form, decimal scalar/list member,
   vector, ordinary literal), reusing `@validation/primitives/*` codecs and the
   adapter's literal vocabulary. `columnName`'s G1 type gate disappears.
4. **One order owner.** `orderTerms` returns
   `{ expression, direction, nulls, nullable }` and resolves scalar terms,
   `{ sort, nulls }`, to-one relation paths (correlated scalar subquery),
   collection `_count` (correlated count), distance terms, and grouped aggregate
   terms. `Queries.order` only joins what it returns.
5. **One page owner.** A `page()` computes normalized total order + cursor
   predicate + limit/offset/distinct for the root read *and* for each to-many
   projection node inside its parent's correlation scope. Nested pagination is
   the same operator, not a second engine.
6. **One projection owner.** `prepareProjection` consumes `omit`, `_count` and
   the full nested read node; `grouped()` stops assembling fields and returns a
   prepared projection of by-columns + aggregate leaves; `decodeValue` gains the
   remaining scalar leaves and the aggregate/count leaves.
7. **One read entry.** `Queries.read(model, operation, args)` returns
   `{ query, result }`: the query and the cardinality/shape decision
   (`one` / `many` / reversed negative-`take` window / count number / count
   object / boolean / aggregate object). `commands/index.ts` dispatches the verb
   and owns only the public `OrThrow` error identity.

## 4. Decisions that disappear (mechanism, consumers, replacing invariant, falsifier)

| # | Removed decision | Mechanism removed | Consumers | Replacing invariant | Falsifier |
| --- | --- | --- | --- | --- | --- |
| D1 | "A `having` operand is interpreted by a second operator ladder" | `Queries.lowerValuePredicate` (32 lines, `equals/in/gte/gt/lte/lt/not` over a raw `Sql`) | `Queries.grouped` | One prepared predicate vocabulary addresses a *target*; a column and an aggregate expression are two targets of the same operator | A `having` operator that the `where` ladder supports and `having` silently refuses (or vice versa) — e.g. `notIn` in `having`, or a decimal `_sum` operand bound without its descriptor |
| D2 | "Grouped rows have their own field/shape assembly" | `Queries.grouped`'s inline `columns`/`fields` construction and its private `_sum → int` / `_avg → float` leaf table | `commands/index.ts` groupBy dispatch | `prepareProjection` owns every output shape; a grouped value is a projection of by-columns and aggregate leaves, classified once from the field's own scalar | A `groupBy` `_sum` over a `float`/`bigint`/`decimal` column decoding to the wrong domain, or a `by` field whose mapped column name differs from its public name |
| D3 | "`findUnique` is `findMany` with `take: 1` at the entry" | the `{ ...args, take: 1 }` special case plus `rows[0] ?? null` in `commands/index.ts` | read dispatch | Cardinality is a property of the admitted operation, owned once by `Queries.read`; the SQL window and the public cardinality are one decision | `findUnique` emitting a `LIMIT` that a strict unique selector makes meaningless, or `findFirst`/`count`/`exist` needing a second entry special case to return their shape |
| D4 | "Reads are recognized by naming three verbs" | the hard-coded `findMany`/`findUnique`/`groupBy` triple in `OperationContext.run` | route selection for pure reads | One admitted-operation classification (`isReadOperation`) exported by `shared/schema.ts` | Adding `count` and forgetting one site: a pure read opening a write transaction, or a write skipping it |
| D5 | "Each scalar type is decoded by a per-type branch invented in the candidate" | `decodeValue`'s int/string/float/decimal ladder | every read/RETURNING decode | One leaf classification per physical field, decoded through the existing codec owners (`decimal-codec`, `datetime-physical-codec`, `geo-point-codec`, enum/vector/blob/JSON validators) | Two call sites decoding the same column differently (e.g. a DateTime in a projection vs. in a relation carrier), or a malformed row accepted by one path and refused by the other |

No deletion is claimed for the genuinely new behavior (cursor, distinct, `_count`,
variant projection breadth, GeoPoint/JSON/list predicates, aggregate verbs):
those add rules and are reported as growth in §9.

## 5. Constraints accepted before coding

- No import of the shipped compiler/lowerer/executor/query builders/result
  engine, and no fallback to it. Contracts are learned from that source; the
  adapter vocabulary (`operators`, `filters`, `orderBy`, `aggregates`, `json`,
  `arrays`, `expressions`, `literals`, `subqueries`, `identifiers`, `clauses`,
  `vector`, `geoPoint`, `result`) and the `@validation/primitives` codecs are the
  reused owners.
- Validation stays external: admitted arguments are trusted. No re-validation of
  operator legality, of `distinct` field names, or of relation-order depth.
  Registered refusals (RF-03, RF-04, RF-05, RF-07, RF-08) remain owned by the
  validation boundary.
- `Queries.updateValue` stays the sole scalar-update owner; this unit does not
  add arithmetic to it.
- `prepareSelector` stays alias-free; `lowerSelector` stays alias-binding.

## 6. Requests to other owners

1. **`shared/operation-context.ts` (G4-02 owner).** `run()` must treat every
   admitted read operation as a pure read. Requested change, at the hard-coded
   triple:

   ```ts
   -      if (
   -        this.operation === "findMany" ||
   -        this.operation === "findUnique" ||
   -        this.operation === "groupBy"
   -      )
   -        return await body();
   +      if (isReadOperation(this.operation)) return await body();
   ```

   with `isReadOperation` imported from `./schema` (this unit's file). Reason:
   `count`, `exist`, `aggregate`, `findFirst` are pure reads; without this they
   open a write transaction (`driver.withTransaction`) and allocate write
   machinery for a read, which §2 forbids and which changes the observable
   statement tape. **Status: made in this unit** (one line + one import), because
   no new read verb can execute on its qualified standalone route without it.
   Flagged in the handoff for the G4-02 writer transfer.

2. No other cross-owner change is required by this unit. `commands/commands.ts`
   and `commands/selection.ts` consume prepared selector/projection facts
   unchanged.

## 7. Four §7 questions — answered against the actual diff

**Diff:** `production.patch` (4 files, +2,162 / −408):
`shared/query.ts`, `shared/schema.ts`, `commands/index.ts`, and one line plus
one import in `shared/operation-context.ts` (§6 request 1).

### 1. Necessary decision or representation repair?

Every added rule is either database behavior, a real boundary, or a provider
capability:

| Added rule | Why it is not a second representation |
| --- | --- |
| The remaining admitted operators (`notIn`, string modes, list containment, JSON path/sentinel/string/array, GeoPoint `within`/`distance`) | Each one is a distinct *database* predicate the public contract already admits. They are added to the ONE prepared vocabulary and lowered by the ONE `lowerOperation`, not to a parallel ladder. |
| `PreparedTarget` | It *removes* a representation: a column, a JSON value inside one, and an aggregate over one become three targets of one operator grammar. `lowerValuePredicate` is deleted. |
| The order-term record (`{ expression, direction, nulls, nullable, field }`) | Null placement and the cursor's total order are the same fact; keeping them apart is what made the shipped engine need two order builders. `field` is not state — it records whether the key is a direct scalar, which is exactly what a cursor may use. |
| Cursor predicate (two spellings) | One semantic rule with a provider-performance specialization: the row-value form is emitted only when every key is NOT NULL and shares a direction, and it is *equivalent* to the general predicate by construction. This is a lowering branch, not a second semantics. |
| Scalar leaf decode per type | Database behavior: each physical domain has one legal spelling. Every leaf is decoded by the existing codec owners (`decimal-codec`, `datetime-physical-codec`, `geo-point-codec`, `datetime-values`); the candidate owns only the provider grammar, not the domain rules. |
| GeoPoint/vector capability refusals | A real provider boundary, asked of `adapter.geoPoint` / `adapter.capabilities`, never emulated. |

No new interpreter, context, scope class, per-verb codec or policy-boolean bag
was added. No JavaScript arithmetic was added beside SQL.

### 2. Exact deletion and replacement obligation

| Removed decision | Verified gone | Replacing invariant | Falsifier exercised |
| --- | --- | --- | --- |
| `Queries.lowerValuePredicate` (the second operator ladder for `having`) | the symbol no longer exists in the tree | one prepared predicate vocabulary over `PreparedTarget` | `read-verbs.test.ts` "groupBy … having": `notIn` and nested `NOT`/`OR` now work in `having`, which the deleted ladder did not admit |
| `Queries.grouped`'s own field/shape assembly and its `_sum → int` / `_avg → float` leaf table | `grouped` now calls `prepareAggregates` + `scalarShape`; no inline leaf literals remain | Every output **leaf** is classified once, by `scalarShape` / `aggregateLeaf` / `COUNT_LEAF`. The stronger claim r1 made — that `prepareProjection` assembles every output *shape* — is **not** what the diff does: `read()` assembles `count`'s selected `{ _all, field }` object (`query.ts:1968-2033`), `prepareAggregates` assembles the aggregate object (`:2087-2140`), and `grouped()` assembles the by-column half (`:2744-2760`). Three assembly sites, one leaf classifier | `read-verbs.test.ts` aggregate domains: `_avg` is a float, `_sum` stays in the field's domain, `_count` is a non-nullable int, and by-fields keep their real nullability |
| The `findUnique` `{ …args, take: 1 }` entry special case | `commands/index.ts` has one `Queries.read` dispatch | cardinality is the admitted operation's decision, owned by `Queries.read` | `findUnique` emits no `LIMIT`; `findFirst`, `count`, `exist`, `aggregate` and `groupBy` were added without a single new entry special case |
| The hard-coded `findMany`/`findUnique`/`groupBy` read triple in `OperationContext.run` | replaced by `isReadOperation(this.operation)` | one admitted-operation classification exported by `shared/schema.ts` | `read-verbs.test.ts` "a pure read opens no transaction and runs one statement" — `count` would have opened a write transaction under the old triple |
| The G1 scalar gate in `columnName` (`throw` for every type but int/string/decimal) and the per-type `decodeValue` ladder | `columnName` is one line; `decodeScalar` classifies one leaf | one leaf per physical field, decoded through the existing codec owners | `codec-roundtrip.test.ts` decodes 13 domains, and the same leaf decodes identically at the root, inside a relation carrier and inside a recursive occurrence |

No equivalent mechanism moved elsewhere: `prepareOperations` is the only place
that reads an admitted filter object, `lowerOperation`/`lowerJsonOperation` the
only places that spell one, `page()` the only window owner, `prepareProjection`
the only shape owner, `decodeScalar` the only leaf decoder.

### 3. One rule across uses

| Rule | Second (and third) consumer exercised through the same owner |
| --- | --- |
| operator vocabulary | root `where` (`filters.test.ts`), nested relation `where` ("keeps the same operator meaning through a nested relation filter"), `having` over aggregate targets (`read-verbs.test.ts`), relation-`_count` filter (`order-projection.test.ts`) |
| page operator | root window, nested to-many node per parent (take/skip/cursor/distinct all asserted per parent), and the `count`/`aggregate` input window |
| projection + decoder | root rows, relation carriers, variant arms, recursive occurrences (`recursive-vocabulary.test.ts` decodes decimal/DateTime/list at depth 0, 1 and 2) |
| value lowering (`fieldValue`) | filter operands, cursor operands, `lowerIdentity`, junction membership values, and `updateValue` assignments |
| aggregate expression | `aggregate`, `groupBy` projection, `having` targets, and grouped aggregate ordering |

### 4. What actually grew

Measured with the census definitions (`receipts/candidate-cost.json`,
baseline `receipts/candidate-cost-baseline.json`; the baseline reproduces the
g4.md opening figures exactly).

| Scope | Physical lines | Code-bearing lines | Parser tokens | Bytes |
| --- | --- | --- | --- | --- |
| Core (commands + shared) at `0cc61e61` | 6,997 | 6,927 | 43,383 | 230,397 |
| Core after G4-01 | 8,751 | 8,573 | 53,972 | 290,017 |
| **Incremental core** | **+1,754** | **+1,646** | **+10,589** | **+59,620** |
| Complete charged perimeter at `0cc61e61` | 14,486 | 11,849 | 72,385 | 499,927 |
| Complete charged perimeter after G4-01 | 16,240 | 13,495 | 82,974 | 559,547 |
| **Incremental complete** | **+1,754** | **+1,646** | **+10,589** | **+59,620** |

Retained owners (7,489 physical / 4,922 code-bearing / 29,002 tokens /
269,530 bytes) are unchanged, so the complete delta equals the core delta.
The G3 complete-charged guidepost of 14,000 code-bearing lines is not crossed
(13,495).

Where the growth is, honestly: `shared/query.ts` grew 1,640 → 3,355 physical
lines. Roughly 55 % of the addition is **new semantic breadth** the inventory
requires (the operator vocabulary, cursor/distinct, aggregate verbs, `_count`,
variant predicates, GeoPoint/JSON/list predicates); roughly 35 % is **codec
decode** (thirteen scalar domains plus the list container and the provider
grammars); roughly 10 % is representation support (`PreparedTarget`,
`OrderTerm`, the `Read` value). Against that, the unit deletes two duplicated
ladders, one entry special case and one hard-coded verb list. This is honest
net growth for behavior that did not exist, not a refactor claiming savings.
Tests and evidence are counted separately: 7 author test files, 34 checks.

## 8. Blockers and unverified claims

### Blockers

1. **`commands/assignments.ts` reads `"set" in value` on a whole-value object**
   (owned by the G3-01/02 writer, not this unit). `scalarAssignment` treats any
   object with a reachable `set` property as an admitted `{ set }` operator
   record, so `Uint8Array.prototype.set` is bound as the column value.
   *Reproducer:* `create({ data: { avatar: new Uint8Array([1,2,250]), … } })`
   on SQLite binds `function set() { [native code] }` and the driver rejects
   `SQLite3 can only bind numbers, strings, bigints, buffers, and null`.
   *Requested change* (`src/query-engine/raptor3/commands/assignments.ts:28`):

   ```ts
   -    "set" in value
   -    ? record(value).set
   +    Object.hasOwn(value, "set")
   +    ? record(value).set
   ```

   This unit applied the same invariant to its own owner
   (`Queries.updateValue`) and left `assignments.ts` untouched. **Consequence:**
   blob/Decimal/Date values cannot be written through `create`/`update` until
   this is fixed, so this unit's codec witnesses seed physical rows by hand
   (which is also the more independent oracle for a read unit).

2. **`program/index.ts` keeps a second read entry** (review finding 8, not this
   unit's file). It names `findMany`/`groupBy` by hand and calls
   `queries.select` / `queries.grouped` directly, so it receives none of
   `Queries.read`'s cardinality decisions, and its `findMany({ take: -n })`
   changed behavior as a side effect of this unit: `select()` now normalizes the
   window, so what used to be `LIMIT -n` (unlimited on SQLite) is a reversed
   window whose decoded array that route does not restore. *Requested change:*
   route it through `Queries.read` and `isReadOperation`, or record the program
   route as frozen and exempt. Owner: the root / G4-02.

### Compatibility items (resolved, recorded because r1/r2 did not record them)

1. **Default null placement** (review finding 1). r2 shipped a normalized
   default (`asc` → last, `desc` → first) for **every** nullable sort key, which
   silently changed the row order of every unqualified `orderBy` over a nullable
   column on SQLite and MySQL (inert on PostgreSQL, whose own defaults match).
   That was a new observable compatibility choice and should have been recorded
   as a decision for Arnaud; it was not. **Resolution: parity, not a decision.**
   The candidate now emits the bare direction for an unspelled `nulls` and
   normalizes only a windowed read, which is exactly the shipped split. Nothing
   is asked of Arnaud, and the differential witnesses are registered
   (`repairs.test.ts`, receipt `repair/author-tests.json`).

### Unverified claims

0. **The distance projection's positive path is not executed.** The refusal path
   is (twice: shipped and candidate raise the same identity on the coordinate
   tier). The positive path is evidenced by the PostgreSQL(PostGIS) lowered
   statement and a decode of a synthetic provider row, not by a live provider —
   no distance-tier provider can run here, and `adapter.geoPoint` is frozen and
   installed non-writable, so it cannot be stubbed.
1. **PostgreSQL and MySQL lowering is adapter-spelled but not executed.** No
   provider answered in this environment (preserved G4 environment blocker), and
   PGlite was not exercised by this unit. Every provider-specific spelling is
   delegated to the adapter vocabulary, but only SQLite lowering is *executed*
   evidence here.
2. **Decimal `having { _sum: … }` operand precision.** The operand binds in the
   field's declared domain. The shipped engine binds a decimal `_sum` operand in
   a *widened* domain (field scale, precision wide enough for the operand). A
   `having` comparison whose operand exceeds the column's precision may be cast
   differently on MySQL/PostgreSQL. Not reachable on SQLite (coefficient
   comparison), so it is unverified rather than known-wrong.
3. **GeoPoint distance bounds pre-filter.** The shipped filter adds an indexable
   `withinBounds` conjunct before a `lte`/`lt` distance comparison. This unit
   emits the distance comparison only. Same result set, potentially different
   plan; recorded for G4-02's provider envelope.
4. **Enum-list provider array text.** `providerArrayMembers` implements the
   PostgreSQL array output grammar for `enumListRepresentation: "arrayText"`.
   It cannot be executed without a PostgreSQL provider.
5. **Vector distance** (`Q-O02`, `SC-13`) is spelled through `adapter.vector`
   and refused with the named capability error on SQLite (the refusal path is
   shared with GeoPoint distance and *is* executed); the positive path needs a
   pgvector provider.

## 9. Cost

See §7 question 4. Receipts: `receipts/candidate-cost.json`,
`receipts/candidate-cost-baseline.json`, `receipts/structure.json`.

## 10. Proposed private-guide paragraph (for the root to merge into `raptor3/AGENTS.md`)

> `Queries` owns one read language. One prepared predicate vocabulary addresses
> a target — a physical column, a JSON value inside one, or an aggregate over
> one — so `where` and `having` can never admit different operators or bind an
> operand two ways. One order owner produces sort keys for scalars, `{ sort,
> nulls }`, to-one relation paths, collection `_count` and distance, and marks
> the direct scalar keys a cursor may use. An unspelled `nulls` is not a
> placement: the bare direction names the provider's own default, and a
> placement is emitted only for a nullable key whose caller spelled one or whose
> read is windowed — the one read whose cursor predicate must name the same
> total order the statement emits. One page owner computes the total order, the cursor
> predicate, the window and `distinct` for the root read, for every nested
> to-many node inside its parent's correlation scope, and for the aggregate
> input window: nested pagination is that same operator, never a second engine.
> `Queries.read` states each read verb's cardinality and public shape over that
> one select/projection/decoder; the private entry adds only the public
> `…OrThrow` error identity. A prepared shape carries every fact the decoder
> needs, including the direction of a reversed window, so a nested negative
> `take` is restored per parent by the same decoder rather than by a second
> reversal site. `Queries.fieldValue` is the single
> destination-aware operand owner for filters, cursors, identities and
> assignments, and `decodeScalar` the single leaf decoder; both reuse the
> existing validation codecs and neither may be duplicated per verb or per
> storage. An admitted operator record owns its keys — a `Uint8Array`, `Decimal`
> or `Date` inherits methods with the same names and is one whole value — a
> non-plain object is one whole value in EVERY domain, not only the two whose
> values happen to be objects. Adapter
> capabilities decide GeoPoint tiers and vector support; the query owner raises
> the named refusal and never emulates a tier in JavaScript. One distance
> expression serves the filter, the order key and the projected `_distance`
> leaf, so a provider tier is asked about once and the output name is stated
> once.

---

# Revision 2 — completion record

- Registered suites re-run green in the worktree (receipts under `receipts/`):
  candidate contract suites (68), prep/post-prep read suites (39), write-side
  dependency regressions (30), bulk/suppression regressions (16), ownership and
  transition regressions (52).
- Author checks: 34 in `tests/raptor3/g4/unit01/` (copied to `author-tests/`).
- Whole-estate typecheck: the two permitted Pattern `TS2345` diagnostics, plus
  one pre-existing `tests/pattern/pack/program-dump.ts(131,7)` diagnostic that
  exists in the committed tree at `0cc61e61` and is masked in the main tree by
  its uncommitted edit to that file. Not introduced by this unit.
- Worktree identity after the diff: production
  `2d579f68d6dad4725c5dd8f9a39e6c0909792cee4582a3d895a8230cbb686ef5`,
  harness `41e9f660256d8fe4c4c7663ff09919966dfd08b2b055bb6a028c7f005ae24fea`.

---

# Revision 3 — repair record (after the independent review returned REVISE)

The review (`../unit01-review.md`) returned REVISE with three blocking and four
must-fix findings. Every one is repaired in the same owners this unit already
holds; no public contract changed, no legacy import or fallback was added, and
no finding needed a second repair attempt. Receipts for this revision are under
`repair/` (the r2 receipts under `receipts/` are kept unchanged — a failed or
superseded receipt is never relabeled).

## Repair table — finding → change → verification receipt

| # | Finding (severity) | Change | Verification |
| --- | --- | --- | --- |
| 1 | (blocking) Unqualified `orderBy` silently changed where NULLs land | `OrderTerm.nulls` is now **optional**: `sortKey` no longer invents a placement, `lowerOrder` emits the bare direction when none was spelled, `reverseOrder` keeps an unspelled placement unspelled, and `totalOrder` — the windowed path, and only it — fills the established default (`asc` → last, `desc` → first) because the cursor predicate must read the same total order. A GeoPoint distance term states `nulls: "last"` in both directions and a vector distance term states none, matching `builders/sort-order-builder.ts:39,42`. This is **exactly the shipped split**: `buildSingleOrder` (bare) for an unwindowed read, `normalizeCursorOrder` + `buildNormalizedOrderBy` (normalized) when `take` or `cursor` is present (`operations/find-pagination.ts:47`, `operations/cursor-order.ts:121-135,183-208`). No compatibility decision is requested from Arnaud: parity was restored, not redefined. | `repair/author-tests.json` — `repairs.test.ts` "default null placement": four differential checks (unqualified asc/desc, windowed asc/desc, windowed + cursor, spelled `nulls`, to-one relation path with an absent relation with and without a tie-break, grouped order) all compare candidate against the **shipped client** over the same SQLite data. `repair/review-probes.json` — the review's own `null-placement-parity.test.ts` (2) and `shipped-parity.test.ts` "orders by a relation count and by a to-one path" now pass. |
| 2 | (blocking) A negative nested `take` returned the window reversed | The prepared shape carries the fact the root carries in `read()`: `relationShape(nested)` (one owner, used by the ordinary relation site **and** the variant-arm site) marks the `collection` shape `reversed` when `arguments.take < 0`, and `decodeValue`'s collection branch reverses the freshly mapped array. | `repair/author-tests.json` — `repairs.test.ts` "nested signed take": negative and positive nested windows, both asserted literally **and** against the shipped client. `repair/review-probes.json` — `nested-window.test.ts` (3/3). |
| 3 | (blocking) A distance projection was dropped and its refusal lost | `prepareProjection`'s scalar branch routes a `_distance` selection through the same `distanceExpression` owner (third usage, `"select"`) into one leaf named `_distance` — a `number`, the single numeric spelling this owner uses; the selected point/vector column is not projected. Two `_distance` selections raise the shipped refusal identity. The leaf is nullable only for a nullable **point**, matching `result/result-row-parser.ts` `parseDistanceValue`. | `repair/author-tests.json` — `repairs.test.ts` "distance projection": the coordinate-tier refusal is asserted for the shipped client **and** the candidate with the same message; the two-`_distance` refusal; and, because no distance-tier provider can execute here, a PostgreSQL(PostGIS) **lowering + decode** witness — the statement projects `… END AS "_distance"` and nothing `AS "at"`, the prepared shape is `["id","_distance"]`, and `decodeQuery` answers `4852312.5` and `null`. `repair/review-probes.json` — `distance-projection.test.ts` passes. |
| 4 | (must-fix) `equals`/`not` on a blob threw for a `Uint8Array` | `addressesOperators` applies the unit's own whole-value rule first: `if (!isOperatorRecord(value)) return false` — a non-plain object is one whole value for **every** domain, not only `json` and `point`. The rule is now stated once and used by both of its consumers (`prepareOperations` and `updateValue`). | `repair/author-tests.json` — `repairs.test.ts` "whole-value operands": `Uint8Array`, `Decimal`, `Date` (dateTime) and `Date` (date) as shorthand, as `{ equals }` and as `{ not }`, each differential against the shipped client (12 comparisons). `repair/review-probes.json` — `whole-value-operands.test.ts` (both checks). |
| 5 | (must-fix) `where: { NOT: [c1, c2] }` threw | `prepareWhere`'s `NOT` arm reads `entries(operand)` like `AND`/`OR` and conjoins the negation of each arm — the same reading `prepareHaving` already gave it. | `repair/author-tests.json` — `repairs.test.ts` "logical combinators": the array form asserted literally and differentially, plus object `NOT`, empty-array `NOT`, nested `NOT`, `NOT` inside `AND`/`OR`, and the same `NOT` in `having`. `repair/review-probes.json` — `logical-forms.test.ts`. |
| 6 | (must-fix) `PreparedProjectionField` kind `"aggregate"` had no producer | The union member and its `lowerProjection` branch (which emitted an empty JSON object) are deleted. The union gained `"distance"`, which has exactly one producer and one lowering branch. | `repair/typecheck.log` (the union is exhaustively switched, so a producerless member would not have been caught by the compiler — the deletion is verified by `grep -n '"aggregate"' src/query-engine/raptor3/shared/query.ts` matching only `PreparedTarget`/`AGGREGATES` uses) and the whole suite set below. |
| 7 | (must-fix) Handoff/note claims the diff did not support | `handoff.md` is re-frozen at **revision 3** with §5 (null placement; distance projection), §6 (nested reversal mechanism), §7 (carrier-level failures are *not* on the translated path and have no executed witness) corrected, falsifiers 11–15 added, and the revision history saying what r2 got wrong. This note's §7 question 2 now says what the diff does (three shape-assembly sites, one leaf classifier). §8 records the null-placement item below. | This file and `handoff.md`. |

## Findings 8–11 (notes), acknowledged

- **8 — a second read entry in `program/index.ts`.** Confirmed and not repaired:
  the file is not in this unit's owned list. It still names `findMany`/`groupBy`
  by hand and calls `queries.select` / `queries.grouped`, so it gets none of
  `Queries.read`'s cardinality decisions, and its `findMany({ take: -n })`
  changed behavior as a side effect of this unit (`select()` now normalizes the
  window). **Request to the root / G4-02**, recorded as §8 blocker 2 above.
- **9 — `page()` returns a `distinct` that `aggregated` drops.** Confirmed,
  still harmless (`CountArgs`/`AggregateArgs` do not admit `distinct`). Not
  changed: adding an assertion for an input the validation owner cannot produce
  would be a guard whose unique coverage cannot be named.
- **10 — `findUnique` has no `LIMIT` and takes `rows[0]`.** Confirmed and
  deliberate; the invariant is "the selector is strictly unique" (RF-03), which
  admission owns. Recorded so a later change to that admission has a place to
  fail.
- **11 — `receipts/identity.json` was older than the run it labelled.**
  Confirmed. `repair/identity.json` is captured **after** the last harness edit
  and after the last suite run of this revision.

## One reviewer probe contradicts the review's own blocking finding

`tests/raptor3/g4/review/unit01/order-cursor.test.ts` ::
*"orders by a to-one relation path when the relation is absent"* asserts
`[2,1,3]` for `orderBy: { person: { name: "asc" } }` over a row whose relation
is absent — i.e. NULLs **last**, which is the pre-repair candidate behavior that
finding 1 declares wrong. The review's own `shipped-parity.test.ts` demands the
opposite for the same construct (shipped `[5,1,2,3,4]`, the absent-relation row
first). The shipped engine is the oracle, and it was asked directly: over the
review's own data shape, `client.post.findMany({ orderBy: { author: { name:
"asc" } } })` answers `[3,2,1]` (absent first) and the candidate now answers
`[3,2,1]`; `"desc"` answers `[1,2,3]` on both. That comparison is registered as
a permanent witness in `repairs.test.ts` ("keeps a spelled placement and a
to-one relation path at parity", the *bare relation path* assertions), receipt
`repair/author-tests.json`.

So `repair/review-probes.json` is **43/44**, and the single failure is that
stale expectation, not a defect: satisfying it would re-break finding 1. The
probe file was left untouched (it is the reviewer's). No repair attempt was
spent on it.

## Identity of this revision

Captured **after** the last production edit, the last harness edit and the last
suite run of this revision (receipt `repair/identity.json`):

| Fact | Value |
| --- | --- |
| production | `407ea035b88d0b2e9de27ebc8adb72b06ae94692735390ad6b50758d0cd0dcc9` |
| harness | `84df3dbd0c764f20be0ff5f7c489fd1d9b173f3f40f8a60ec38066ab2da947e5` |
| runtime | Node v24.21.0, darwin/arm64, better-sqlite3 12.6.0, Vitest 3.1.4 |

(r2's production fingerprint was
`2d579f68d6dad4725c5dd8f9a39e6c0909792cee4582a3d895a8230cbb686ef5`, which the
review reproduced.) Every receipt in `repair/` except
`review-probes-before.json` — the deliberate pre-repair baseline, 36/44 — was
produced by this exact pair; the suite set was re-run from scratch after the
final source edit rather than reusing earlier receipts.

## Suites re-run for this revision (serially, through the safe runners)

| Suite set | Result | Receipt |
| --- | --- | --- |
| `tests/raptor3/g4/unit01` (author checks: 34 original + 13 repair witnesses) | **47/47 pass** | `repair/author-tests.json`, `repair/author-tests.log` |
| `tests/raptor3/g4/review/unit01` (the reviewer's probes, unmodified) | **43/44 pass** (the stale expectation above; 8 failures before the repair, receipt `repair/review-probes-before.json`) | `repair/review-probes.json`, `repair/review-probes.log` |
| `candidate-handoff`, `candidate-ordering`, `candidate-pagination`, `candidate`, `cleanup-failure` | **68/68 pass** | `repair/registered-candidate-suites.json` |
| `post-prep/{clearability-consumption,history-analysis,projection-preparation,schema-view-reuse,selector-preparation}`, `prep/{recursive-read-fit,selector-dependencies,variant-collection-order}` | **39/39 pass** | `repair/registered-prep-suites.json` |
| `prep/{g3p04-review-regressions,set-preparation,suppression-replay}` | **16/16 pass** | `repair/write-regressions-prep.json` |
| `post-prep/g29-*` | **30/30 pass** | `repair/write-regressions-g29.json` |
| `ownership/commands`, `polish/commands`, `transitions/junctions-commands`, `transitions/keys-commands` | **52/52 pass** | `repair/write-regressions-ownership.json` |
| Whole-estate typecheck | the two permitted `pattern/pack.ts` TS2345 plus the pre-existing committed-tree `tests/pattern/pack/program-dump.ts(131,7)` TS2532 | `repair/typecheck.log` |

**One** author expectation was corrected rather than the code, because it
pinned the pre-repair behavior the review found wrong:
`order-projection.test.ts` "orders by direction, explicit null placement and
several keys" (unqualified `asc` over a nullable column is now `[2,3,1]`, the
shipped answer on SQLite, pinned differentially in `repairs.test.ts`). One
expectation, one `it` block, one file. *(Corrected at r4: this sentence said
"Two author expectations" and then named one — review follow-up finding E.)*

## Cost after the repair

Recomputed with the census's own `countTokenLines` definition over the same
scope the r2 receipts use (`raptor3/commands` + `raptor3/shared`); the
recomputation reproduces the `0cc61e61` baseline receipt **exactly**
(6,997 / 6,927 / 43,383 / 230,397), which is what makes the deltas comparable.

| Scope | Physical | Code-bearing | Parser tokens | Bytes |
| --- | --- | --- | --- | --- |
| Core at `0cc61e61` | 6,997 | 6,927 | 43,383 | 230,397 |
| Core after r2 (reviewed) | 8,751 | 8,573 | 53,972 | 290,017 |
| **Core after r3 (repaired)** | **8,820** | **8,626** | **54,306** | **292,814** |
| **Incremental core (unit total)** | **+1,823** | **+1,699** | **+10,923** | **+62,417** |
| Repair-only delta (r2 → r3) | +69 | +53 | +334 | +2,797 |
| Complete charged perimeter after r3 | 16,309 | 13,548 | 83,308 | 562,344 |

Retained owners (7,489 / 4,922 / 29,002 / 269,530) are untouched, so the
complete delta still equals the core delta. The G3 complete-charged guidepost of
14,000 code-bearing lines is not crossed (13,548). The repair's 53 code-bearing
lines buy: the optional-placement rule and its windowed normalization (≈18), the
reversed-collection shape and its one owner (≈14), the distance projection
leaf + lowering + refusal (≈26), minus the deleted `"aggregate"` member and its
branch (−7) and the deleted `"float"` decode alias (−1). The `NOT` and
whole-value repairs are net-zero and net −1.

Receipts: `repair/candidate-cost.json`, `repair/candidate-cost-baseline.json`,
`repair/structure.json`.

## The four §7 questions, re-answered against the repaired diff

1. **Necessary decision or representation repair?** The repair *removes* two
   representations (the producerless `"aggregate"` projection field with its
   silently-wrong lowering, and the producerless `"float"` decode alias) and
   adds three rules, each of which is database or provider behavior stated once:
   an unspelled placement is the provider's own default; a to-many shape records
   the direction of the window that produced it; a `_distance` selection is a
   projected expression. The one representation the repair adds — the
   `"distance"` projection field — has exactly one producer and one lowering
   branch, which is what the deleted member did not.
2. **Did the named mechanism disappear, with a falsifier?** Verified by grep:
   `grep -n '"aggregate"'` in `shared/query.ts` now matches only `PreparedTarget`
   and the `read()` verb case, never a projection field; `grep -n '"float"'`
   matches nothing. The r2 deletions (D1–D5) are unaffected — all five falsifiers
   still run green, and D1's own falsifier is now *fully* honored: `where` and
   `having` read `NOT` identically (`repairs.test.ts` asserts both in one check).
3. **Is each rule stated once and used by every consumer?** The two places the
   review answered "no" are repaired: the whole-value rule is now one test
   (`isOperatorRecord`) inside `addressesOperators`, used by the filter path and
   by `updateValue`; the `NOT` shape is `entries(...)` in both `prepareWhere` and
   `prepareHaving`. The to-many reversal is one owner (`relationShape`) used by
   the ordinary relation site and the variant-arm site; the distance expression
   is one owner used by filter, orderBy and select. Two "no"s remain, both
   recorded rather than hidden: output-shape **assembly** still has three sites
   outside `prepareProjection` (they share one leaf classifier — §7 q2 above is
   corrected to say so), and `program/index.ts` is still a second read entry
   (not this unit's file; request in §8).
4. **What grew?** +69 physical / +53 code-bearing / +334 tokens / +2,797 bytes
   over r2, itemized below.

## Rules added and decisions removed by the repair

**Added rules (3).**
1. *An unspelled `nulls` is not a placement.* The bare direction names the
   provider's own default; a placement is stated only when the caller spelled
   one or the read is windowed over direct scalar keys.
2. *A to-many shape records the window's direction.* `relationShape` marks a
   `collection` shape reversed when `take < 0`; the decoder restores the logical
   order. (This replaces a rule that lived only at the root.)
3. *A `_distance` selection is a projected expression named `_distance`.* One
   owner (`distanceExpression`) serves filter, orderBy and select; the column
   it reads is not projected.

**Removed decisions (2).**
1. *"An object operand addresses operators unless its domain is `json` or
   `point`."* Removed: the domain list is gone, the whole-value rule is one
   test (`isOperatorRecord`) used by both consumers. Falsifier: any scalar
   domain whose values are objects and whose validation does not canonicalize
   them (blob today) filtering by a value and getting an operator error.
2. *"A projection field may be an aggregate."* Removed with its unreachable
   lowering; `prepareAggregates` is the only aggregate-column owner. Falsifier:
   a projection field kind with no producer reappearing in the union.
3. *"A numeric leaf may be spelled `float` or `number`."* Removed while writing
   the distance leaf: `decodeScalar`'s `case "float"` had no producer either (no
   schema scalar state is `"float"`; `aggregateLeaf` already spells a synthetic
   numeric leaf `"number"`), so the alias is deleted and the distance leaf uses
   the one spelling. Falsifier: two leaf type strings decoding through the same
   arm.

---

# Revision 4 — Repair 2 (after the independent review's follow-up returned REVISE)

The follow-up review (`../unit01-review-followup.md`) resolved all seven r1
findings and returned **REVISE** on four new ones: B (must-fix), C (must-fix),
D (must-fix) and E (note). Each is repaired inside a function this unit already
owns; no public contract changed, no legacy import or fallback appeared, and no
finding needed a second repair attempt. Receipts for this revision are under
`repair2/`; the r2 (`receipts/`) and r3 (`repair/`) receipts are untouched.

The reviewer's own 44 follow-up probes were reproduced **before** any edit —
`repair2/followup-probes-before.json`, **33 pass / 11 fail**, the same 11 names
the review's `followup-probes.json` lists — so the repair is measured against a
failure this author reproduced, not against a claim.

## Repair table — finding → change → verification receipt

| # | Finding (severity) | Change | Verification |
| --- | --- | --- | --- |
| B | (must-fix) An empty logical arm answered differently in `NOT` and `OR` | One rule, stated once and used by both readings. `states(predicate)` (module scope) is the single reading of *"this arm built no condition"*: a prepared conjunction with no member states nothing. `combine(key, arms)` is now the one assembler for `AND`/`OR`/`NOT` in **both** `prepareWhere` and `prepareHaving`: it drops every arm that states nothing, negates each surviving arm for `NOT`, and answers the vacuous FALSE when `OR` has no surviving arm — which is the shipped rule (`builders/where-builder.ts:217-308` and `operations/groupby-having.ts:77-173` skip every arm whose builder answered `undefined`, and only `buildLogicalOr` turns "none" into `literals.false()`). The reading is **recursive**, not shallow: `NOT: [{ AND: [{}] }]` must be absent too, and a shallow filter would have made it FALSE. The previously **producerless** `"always"` predicate kind gets its one producer here. | `repair2/followup-probes.json` — the review's `empty-arm.test.ts` **12/12** (was 6/12). `repair2/author-tests.json` — `repair2.test.ts` "the empty logical arm": 13 differential forms + `having` + four non-empty controls. `repair2/author-witnesses-falsified.json` — the same witnesses on the pre-repair source: 7 of the 13 forms fail, plus the `having` check, including `NOT around an empty AND`. |
| C | (must-fix) A negative `take` flipped a distance term's stated placement | `OrderTerm` gains `expressionNulls`, set only by the point-distance sort key, read only by `reverseOrder`: a placement the **caller** spelled still flips, a placement the **expression** owns does not. That is the shipped reversal, which rewrites only the input `sort` (`operations/find-pagination.ts:131-151`) and lets `buildDistanceOrder` re-emit `nullsLast(distance, …)` (`builders/sort-order-builder.ts:36-45`). | `repair2/followup-probes.json` — "reverses a point distance ORDER the way the shipped engine reverses it" passes. `repair2/author-tests.json` — `repair2.test.ts` "a reversed window and the distance placement": the reversed lowering is `DESC NULLS LAST` on both engines, 12 sort/take/skip shapes agree, and the falsifier (a caller-spelled `nulls` under `take: -2`) still flips on both. |
| D | (must-fix) The vector distance path lost one registered refusal and reworded three | All four restored in the two owners this unit holds. `distanceExpression`'s vector branch now refuses a **nullable vector `select`** first, before any capability is consulted (`Vector distance select does not support nullable vector field '<field>'.`), then answers the shipped capability sentence (`vector ordering requires a pgvector-enabled PostgreSQL driver` for `orderBy`, `vector distance select requires a pgvector-enabled PostgreSQL driver` otherwise), then the shipped **dimension-mismatch** refusal, which admission genuinely does not own (`v.array(v.number())` does not constrain length). `geoPoint(usage)` answers the shipped no-tier sentence (`GeoPoint requires a provider with its physical point tier enabled.`). The distance-tier sentence and all five usage labels (`distance <usage>`, `projection`, `value`, `equals`, `within`) already matched and are unchanged. | `repair2/followup-probes.json` — the four refusal comparisons in `distance-parity.test.ts` pass. `repair2/author-tests.json` — `repair2.test.ts` "the registered distance refusals": each refusal compared **message-for-message** against the shipped engine on the same adapter, the nullable-vector one on a provider with pgvector *and* without, and the point-tier one for both `orderBy` and `equals`. |
| E | (note) Two claim overstatements in the r3 record | Both corrected, and neither was a claim about the source. (1) The r3 return said "13 new author witnesses, 12 of them DIFFERENTIAL"; the true count is **13 witnesses, 11 differential** (`repairs.test.ts` has 13 `it` blocks; 10 go through `differential()` and 1 through `world.client.place.findMany`; the two-`_distance` refusal and the PostGIS lowering witness are candidate-only, as the note already described them). (2) §"Suites re-run for this revision" said "Two author expectations were corrected" and then named one — corrected in place above to **one** expectation, one `it` block, one file. | This file. The 11/13 count is `grep -c "  it("` and `grep -c "differential("` over `author-tests/repairs.test.ts`. |

## Identity of this revision

Captured **after** the last production edit, the last harness edit and the last
suite run (receipt `repair2/identity.json`):

| Fact | Value |
| --- | --- |
| production | `b779454047df89b8a3b55a714e0a78e275b0abf3301e82f6eb678b2b9e1edca6` |
| harness | `12d8ad10f3e4e03f4f6ed5145addcae49787104e50e87313753ab8ef006755de` |
| runtime | Node v24.21.0, darwin/arm64, better-sqlite3 12.6.0, Vitest 3.1.4 |

(r3's production fingerprint was `407ea035…`, which the follow-up review
reproduced. The harness hash moves because this revision adds
`tests/raptor3/g4/unit01/repair2.test.ts` and moves the `differential` helper
into `world.ts`; the reviewer's own probe files are untouched.)

`production.patch` is regenerated from this worktree (`git diff -- src`, four
files, +2289 / −425) and verified byte-identical to the live diff.
`author-tests/` is re-copied and verified byte-identical to
`tests/raptor3/g4/unit01/` (10 files). Nothing was staged or committed; the
unrelated dirty files in the main tree were never touched.

## Suites re-run for this revision (serially, through the safe runners)

| Suite set | Result | Receipt |
| --- | --- | --- |
| The review's follow-up probes, **before** the repair | **33/44** (the 11 failures the review names) | `repair2/followup-probes-before.json` |
| `tests/raptor3/g4/review/unit01-followup` (after) | **44/44 pass** (4.38 s, 713.8 MiB) | `repair2/followup-probes.json` |
| `tests/raptor3/g4/unit01` (34 + 13 r3 + **22 new**) | **69/69 pass** (4.57 s, 707.3 MiB) | `repair2/author-tests.json` |
| The new witnesses against the **pre-repair** source (falsification) | **8/22 pass, 14 fail** — the witnesses discriminate | `repair2/author-witnesses-falsified.json` |
| `tests/raptor3/g4/review/unit01/` (the reviewer's r1 probes, with the one expectation they corrected in place) | **44/44 pass** (4.58 s, 714.7 MiB) | `repair2/review-probes.json` |
| `candidate-handoff`, `candidate-ordering`, `candidate-pagination`, `candidate`, `cleanup-failure` | **68/68 pass** (4.82 s, 798.8 MiB) | `repair2/registered-candidate-suites.json` |
| `post-prep/{clearability-consumption,history-analysis,projection-preparation,schema-view-reuse,selector-preparation}`, `prep/{recursive-read-fit,selector-dependencies,variant-collection-order}` | **39/39 pass** (5.06 s, 750.0 MiB) | `repair2/registered-prep-suites.json` |
| `prep/{g3p04-review-regressions,set-preparation,suppression-replay}` | **16/16 pass** (4.44 s, 656.3 MiB) | `repair2/write-regressions-prep.json` |
| `post-prep/g29-*` minus the PGlite file | **30/30 pass** (4.43 s, 719.3 MiB) | `repair2/write-regressions-g29.json` |
| `post-prep/g29-result-progress-pglite.test.ts` (alone) | **1/1 pass** (5.10 s, 1523.7 MiB) — the first attempt **breached** the 1,536 MiB ceiling at 1574.5 MiB and wrote no report; recorded, not relabeled. The suite sits within ~1 % of the ceiling in this environment (the reviewer measured 1525.7 MiB) and this unit changes nothing PGlite-specific. | `repair2/g29-pglite.json` |
| `ownership/commands`, `polish/commands`, `transitions/junctions-commands`, `transitions/keys-commands` | **52/52 pass** (4.82 s, 741.9 MiB) | `repair2/write-regressions-ownership.json` |
| Whole-estate typecheck | ~~the two permitted `pattern/pack.ts` TS2345 plus the pre-existing committed-tree `tests/pattern/pack/program-dump.ts(131,7)` TS2532 — nothing else (6.46 s, 6024.1 MiB)~~ **This sentence was FALSE of the r4 delivered identity** — *corrected at r5, review follow-up-2 finding F*. The run it cites happened at 01:31:11, **before** `tests/raptor3/g4/unit01/world.ts` (01:32:40) and `repair2.test.ts` (01:33:37) were written, so it never saw the `world.ts(188,7) TS2345` the review found. The receipt is kept, byte-untouched, and marked stale by `repair2/typecheck.SUPERSEDED.md`; the authoritative run is `repair3/typecheck.log`, captured **after** the last edit of r5. | `repair2/typecheck.log` (**stale, superseded**) → `repair3/typecheck.log` |

No author expectation was corrected in this revision: every existing witness
passed unchanged, which is itself evidence that the four repairs are additive
to the r3 semantics rather than a second reinterpretation of them.

## Cost after Repair 2

Same scope and same `countTokenLines` definition as every earlier receipt
(`raptor3/commands` + `raptor3/shared`).

| Scope | Physical | Code-bearing | Parser tokens | Bytes |
| --- | --- | --- | --- | --- |
| Core at `0cc61e61` | 6,997 | 6,927 | 43,383 | 230,397 |
| Core after r2 | 8,751 | 8,573 | 53,972 | 290,017 |
| Core after r3 | 8,820 | 8,626 | 54,306 | 292,814 |
| **Core after r4 (this repair)** | **8,861** | **8,641** | **54,426** | **294,985** |
| **Incremental core (unit total)** | **+1,864** | **+1,714** | **+11,043** | **+64,588** |
| Repair-2-only delta (r3 → r4) | +41 | +15 | +120 | +2,171 |
| Complete charged perimeter after r4 | 16,350 | 13,563 | 83,428 | 564,515 |

The whole delta is in `shared/query.ts` (3,424 → 3,465 physical, 3,299 → 3,314
code-bearing); no other charged file changed a line. Retained owners
(7,489 / 4,922 / 29,002 / 269,530) are untouched, so the complete delta still
equals the core delta, and the G3 complete-charged guidepost of 14,000
code-bearing lines is still not crossed (13,563).

The +15 code-bearing lines are, counted by hand against the diff and summing
to the measured total: the one combinator owner (`states` + `VACUOUS_FALSE` +
`combine`, +24) **minus** the two duplicated assemblies it replaces (−32) =
**−8**; the expression-owned placement (`OrderTerm` field +1, `sortKey` +8, the
distance sort key's call +2) = **+11**; the vector branch's three restored
refusals plus the `field` parameter = **+10**; the two other call sites that now
name their field = **+2**.

*(Corrected at r5, review follow-up-2 finding G: the hand-counted added/removed
**split** above is **unverified** — the r3 source is not preserved anywhere this
author or the reviewer can reach, so only the **net** is checkable, and the net
reproduces exactly (+41 / +15 / +120 / +2,171, recomputed independently by the
reviewer). The r4 return message's "net of a 32-line deletion" and §7 q4's "net
of a 35-line deletion" were two numbers for one fact; neither is claimed now.)*

Receipts:
`repair2/candidate-cost.json`, `repair2/structure.json` (the `0cc61e61`
baseline receipt is `repair/candidate-cost-baseline.json`, unchanged and still
reproducing `g4.md` lines 15–16 exactly).

## The four §7 questions, re-answered against the twice-repaired diff

1. **Necessary decision or representation repair?** Repair, three times over.
   B removes a *missing* representation: the candidate had no reading of "this
   arm built no condition", so it spelled one as an empty conjunction that
   lowered to TRUE; `states()` states the reading once, and the `"always"`
   predicate kind — which had **no producer at all** before this repair, the
   same defect finding 6 charged against the `"aggregate"` projection field —
   gets its single producer. C repairs a representation that conflated two
   different facts under one field (`nulls` meant both "the caller asked for
   this" and "the expression emits this"); the two are now distinguishable by
   the one consumer that must tell them apart. D restores registered refusal
   identities, which are contracts, not decisions. The one field and the one
   module-level predicate added are the whole added representation, each with
   one producer and one consumer.
2. **Did the named mechanism disappear, and does the replacing invariant have a
   falsifier?** Yes: the two duplicated combinator assemblies are gone —
   `prepareWhere` and `prepareHaving` now each hand their arms to `combine`.
   Verified by grep rather than asserted:
   `grep -n 'kind: "not"' src/query-engine/raptor3/shared/query.ts` matches the
   union member (`:204`), `combine` (`:791`), and two *different* constructs
   that are not logical-combinator arms — the scalar `not` operator (`:914`) and
   the relation `isNot` quantifier (`:1078`). No second combinator assembly
   remains. Falsifier: any combinator that behaves differently in
   `where` and in `having` (`repair2.test.ts` "reads an empty arm the same way
   in where and in having", plus the r3 witness for non-empty `NOT`). All five
   r2 deletions and the r3 deletions remain gone. Each new rule has a falsifier
   that fails on the pre-repair source — measured, not asserted:
   `repair2/author-witnesses-falsified.json`.
3. **Is each rule stated once and used by every consumer?** The empty-arm rule:
   one function, one assembler, two consumers. The placement-ownership rule:
   one field, one producer (the point-distance sort key), one consumer
   (`reverseOrder`). The refusals: one owner each (`distanceExpression` for the
   vector and distance-tier refusals, `geoPoint` for the point tier), reached by
   filter, `orderBy` and `select` alike. The two "no"s the follow-up review
   recorded stand unchanged and are still recorded rather than hidden:
   output-shape *assembly* has three sites outside `prepareProjection` (sharing
   one leaf classifier), and `program/index.ts` is still a second read entry
   (§8 blocker 2). The third "no" it added — the empty-arm rule stated nowhere
   in the candidate — is what this repair closes.
4. **What grew?** +41 physical / +15 code-bearing / +120 tokens / +2,171 bytes,
   itemized above. *(Corrected at r5, finding G: the added/removed split — "a
   35-line deletion" here, "a 32-line deletion" in the r4 return message — is
   **unverified**, because the r3 source is not preserved. Only the net is
   claimed, and the net reproduces.)*

## Rules added and decisions removed by Repair 2

**Added rules (3).**
1. *An arm that builds no condition is absent.* It contributes nothing to
   `AND`, nothing to `NOT` and nothing to `OR`; the disjunction of nothing is
   FALSE. Consequence a consumer must not re-derive: `NOT: {}` does not exclude
   every row, and `OR: [{}, x]` does not admit every row.
2. *A placement can belong to the expression rather than to the caller.* A
   reversed window flips the caller's and keeps the expression's.
3. *A nullable vector has no distance to project, and a distance operand must
   be the declared length.* Both are refusals the shipped engine owns and this
   unit now preserves.

**Removed decisions (2).**
1. *"`AND`, `OR` and `NOT` are assembled where they are read."* Removed: two
   assemblies (six arms) became one owner, `combine`. Falsifier: a combinator
   admitted in `where` behaving differently in `having`.
2. *"A `PreparedPredicate` may be `always` with nobody to build one."* Removed
   by giving the kind its producer. Falsifier: a union member with no producer
   reappearing — the same grep finding 6 established.

## What this repair did **not** change

- No public contract, no admitted argument, no result shape, no error class.
  Findings B, C and D are all *parity* repairs: in every case the shipped engine
  is the oracle and the candidate now answers what it answers.
- `handoff.md` is bumped to **revision 4** because three contract *statements*
  changed: §3 gains the logical-combinator rule and names `combine`; §5's
  reversal sentence was wrong for a distance term and is corrected; §5 now lists
  the four registered distance refusals verbatim, one of which did not exist at
  r3. Falsifiers 16–18 added. No section that G4-02 already builds on changed
  meaning — the corrections narrow claims, they do not widen them.

## New observations (not defects, recorded for the record)

1. **The `"filter"` spelling of `distanceExpression` is unreachable for a
   vector.** Validation admits only `equals` on a vector filter
   (`src/validation/scalars/vector.ts`), and the shipped engine's `distance`
   filter case routes every field through the **point** path
   (`where-builder.ts:710` → `buildPointDistancePredicate`), so it never reaches
   its own vector branch with `"filter"` either. The candidate's ternary
   therefore has the same unreachable arm as the shipped one, and the
   capability sentence a vector filter would answer (`vector distance select
   requires …`) is the shipped sentence for that unreachable arm. Not repaired:
   it is parity on an input no admission produces.
2. **`states()` is recursive on purpose.** The shallow reading — "an `and` with
   zero members states nothing" — agrees with the shipped engine on all eleven
   forms the review probed, and diverges on `NOT: [{ AND: [{}] }]`, which the
   pre-repair candidate answered correctly only by accident (two wrongs
   cancelling). The witness for that form is in `repair2.test.ts` and fails on
   the pre-repair source.

---

# Revision 5 — Repair 3 (after the independent review's follow-up-2 returned REVISE)

The second follow-up review (`../unit01-review-followup-2.md`) closed findings
B, C, D and E and returned **REVISE** on five new ones: **J** (blocking),
**H**, **I** and **F** (must-fix) and **G** (note). All five are repaired here.
Three are one-owner production repairs inside functions this unit already
holds, one is a single type annotation in this unit's own test harness, and one
is a number in this record. No public contract changed, no admitted argument,
no result shape, no error class, no legacy import, no fallback, and no finding
needed a second repair attempt. Receipts are under `repair3/`; the r2
(`receipts/`), r3 (`repair/`) and r4 (`repair2/`) receipts are untouched, and
the one stale r4 receipt is kept and marked rather than replaced in place
(`repair2/typecheck.SUPERSEDED.md`).

The reviewer's five failing probes were **reproduced before the repair was
measured**: `repair3/followup2-probes-before.json` runs the reviewer's own
follow-up-2 directory against the pre-repair source and fails **58/63 — the
same five names** the review lists (set equality verified programmatically
against `../unit01-review-followup2/new-probes.json`). After the repair the same
directory is **63/63**.

## Repair table — finding → change → verification receipt

| # | Finding (severity) | Change | Verification |
| --- | --- | --- | --- |
| **J** | (blocking) The refusal for a field reference between two decimal columns of **different** declared domains was missing, and the candidate silently answered `[]` where the shipped engine refuses | Raised in **the one owner that reads the field-reference operand**, `prepareOperand` (`shared/query.ts:989-1021`), which already raises this unit's other two field-reference refusals. That owner now receives the **owning** `PreparedScalar` instead of only its model — one parameter, so the refusal can name the filtered field and read its declared domain — and refuses with the shipped sentence when both sides are exact decimals of different `(precision, scale)`. The *rule* stays owned by `sameDecimalDescriptor` (`@validation/primitives/decimal-codec`), the same comparison the shipped builder, the migration differ and the SQLite migration driver all use; only the **reading** of "is this state an exact decimal column, and in which domain" is spelled here, as `exactDecimalDomain` (`:236-247`, the doc comment included), because the equivalent shipped helper lives in `builders/decimal-field.ts` and the candidate may not import the shipped builders. A decimal **list** answers `undefined` — it has no scalar comparison — which is exactly what `decimalDescriptorOfState` does. | `repair3/new-witnesses.json` — `repair3.test.ts` "decimal field-reference domains": the mismatch refused **message-for-message** against the shipped engine, the same-domain reference still answered (`[{id:1}]` on both), the two columns named in the order the filter asked them (the reversed pair produces the reversed sentence), the mismatch refused under `lt`/`lte`/`gt`/`gte` as well as `equals`, two non-decimal columns **not** refused, and a same-domain reference inside a `NOT` **not** refused. `repair3/new-witnesses-falsified.json` — **3 of those 6 fail** on the pre-repair source (the three refusal witnesses; the three controls pass, which is what makes them controls). `repair3/followup2-probes.json` — the reviewer's `decimal-fieldref.test.ts` 2/2. |
| **H** | (must-fix) The cursor refusal was reworded (`relation and distance` for `relation and vector-distance`) | The shipped sentence, copied verbatim into `page()` (`shared/query.ts:1799-1802`). One string; no branch, no new decision. | `repair3/new-witnesses.json` — two differential witnesses over the same SQLite data (a to-one relation path order and a collection `_count` order, each beside a cursor) plus an **absolute** pin of the shipped sentence so the agreement cannot pass by both engines being wrong the same way, plus a control that a direct scalar order beside a cursor still pages (`[{id:1},{id:2}]` on both). `repair3/followup2-probes.json` — the reviewer's `cursor-refusal.test.ts` 2/2. |
| **I** | (must-fix) The JSON sentinel-with-path refusal was reworded and named neither the field nor the sentinel | The shipped template, copied verbatim into `lowerJsonOperation` (`shared/query.ts:1409-1412`), including `'${field}'` and the sentinel kind. The field is read from the prepared target; a sentence in the function's doc comment records the invariant that lets it (the caller, `lowerOperation`, reaches this owner **only** when the target's own scalar state is a JSON document, so the target always names a scalar). | `repair3/new-witnesses.json` — three differential witnesses (`DbNull`, `JsonNull`, **`AnyNull`** — the third kind the reviewer did not probe) each with an absolute pin of the shipped sentence for that kind, plus two controls: a `path` with a plain `equals: null` (`[{id:1}]` on both) and the whole-column sentinels (`DbNull → [2]`, `JsonNull → [3]`, `AnyNull → [2,3]` on both). `repair3/followup2-probes.json` — the reviewer's `json-sentinel.test.ts` 3/3. |
| **F** | (must-fix) A whole-estate typecheck diagnostic in this unit's own harness, behind a stale receipt | `differential`'s `operation` parameter is now **typed** as the engine's own operation type — `Parameters<World["engine"]["execute"]>[1]` — instead of `string` (`tests/raptor3/g4/unit01/world.ts:173`). One line, no cast at the call site. The typecheck was then re-run **after** the last edit of this revision, and the stale r4 receipt is kept byte-untouched and marked superseded. | `repair3/typecheck.log` (run at 02:23:28, after every edit; the last source edit is 02:21:56) and `repair3/typecheck-without-review-probes.log`. `repair3/world-r4-to-r5.diff` is the whole harness change. The r4 record's "nothing else" sentence is corrected in place above, with an r5 marker. |
| **G** | (note) Two numbers for one fact (a "32-line" and a "35-line" deletion) | Neither number is claimed any more: the r4 added/removed **split** is marked **unverified** in both places (the r3 source is not preserved anywhere this author or the reviewer can reach), and only the **net**, which reproduces exactly, is stated. Corrected in place above with r5 markers. To stop this class of defect recurring, **this** revision's split is made permanently checkable: `repair3/query-r4-to-r5.diff` is the complete r4 → r5 production diff (+37 / −9 physical lines, netting the measured +28). | This file; `repair3/query-r4-to-r5.diff`. |

### Why J is one comparison and not a mechanism

The fact the refusal needs — both columns' declared precision and scale — was
already at that point: the owning column arrives as the `PreparedScalar` the
predicate was prepared against, and the referenced column is the scalar the
existing "does not name a scalar field" guard already looks up. The change
therefore adds **no lookup, no cache, no scope, no capability and no policy
flag**: it passes one value that was already in the caller's hand, reads two
states, and compares them with the codec that already owns the comparison. The
guard has exactly one coverage that can be named: *two exact decimals of
different declared domains are not comparable as stored*, which no other check
in this unit or in admission makes (the interned filter schemas are model-blind
and compare `type` and arity only).

## Identity of this revision

Captured **after** the last production edit, the last harness edit and the last
suite run (receipt `repair3/identity.json`):

| Fact | Value |
| --- | --- |
| production | `db3c07dac7cea4a4c7a0da3b94a684c20d993a5b6ec4ed1e02d9ff7f4665528c` |
| harness (as delivered, worktree including the reviewer's r1, r3 and follow-up-2 probe directories) | `544218965a35a0564ef1541f345679e052b32cfb4a0f738db0977f17bb962131` |
| harness with the reviewer's `tests/raptor3/g4/review/` parked outside the tree | `63a08576c1c2ee979ffa63d7bb8cf6b2eeffab2e7b9dafaa3156349b408e69a2` (`repair3/identity-without-review-probes.json`) |
| runtime | Node v24.21.0, darwin/arm64, better-sqlite3 12.6.0, Vitest 3.1.4 |

Per-file, for anyone reproducing without the identity walk:

| File | sha256 |
| --- | --- |
| `src/query-engine/raptor3/shared/query.ts` | `6f39f82a161b6f3cbc5bc78a550048abf9564396cb950a6d6b96c073358e31a7` |
| `tests/raptor3/g4/unit01/world.ts` | `9504ddd740024f8d6c334bcfcc00547752db476ba795ddf21ff67b29ee1b5533` |
| `tests/raptor3/g4/unit01/repair3.test.ts` | `5ede2f0b08527f0de801395a25abb69583aa84a933180e8dfa3ff55c13f929d2` |

(The r4 production fingerprint was `b779454047df…`, which the follow-up-2 review
reproduced. The harness hash moves for three reasons, all recorded: this
revision adds `repair3.test.ts` and types one parameter in `world.ts`, and the
reviewer's own eight follow-up-2 probe files are present in the worktree.
**The reviewer's probe files were not touched**: their 25 files were hashed
before and after the two times this revision parked the directory to run a
typecheck and an identity without them, and the hashes are identical.)

**No staleness, provably.** Every edit of this revision is at or before
02:21:56 (`query.ts`, restored from the falsification copy and hash-verified);
the typecheck ran at 02:23:28 and the identity at 02:24:15. Nothing was staged
or committed (`git status --porcelain` shows the four modified `src` files and
the untracked `tests/raptor3/g4/` this unit authors); the unrelated dirty files
in the main tree were never touched.

`production.patch` is regenerated from this worktree (`git diff -- src`, four
files, **+2315 / −423**) and verified byte-identical to the live diff by hash
(`6d6b7a7e997d71e01029e23fa464bd56d030c098cc49e3b4790a7a7161617b72`).
`author-tests/` is re-copied and verified byte-identical to
`tests/raptor3/g4/unit01/` (11 files, one more than r4: `repair3.test.ts`).

## Suites re-run for this revision (serially, through the safe runners)

| Suite set | Result | Receipt |
| --- | --- | --- |
| The review's follow-up-2 probes, **before** the repair | **58/63** — the five failures the review names, set-equal to its own receipt (4.65 s, 775.4 MiB) | `repair3/followup2-probes-before.json` |
| `tests/raptor3/g4/review/unit01-followup2/` (after) | **63/63 pass** (4.77 s, 732.5 MiB) | `repair3/followup2-probes.json` |
| `tests/raptor3/g4/unit01` (69 + **14 new**) | **83/83 pass** (4.89 s, 742.0 MiB) | `repair3/author-tests.json` |
| The new witnesses alone | **14/14 pass** (4.24 s, 549.0 MiB) | `repair3/new-witnesses.json` |
| The new witnesses against the **pre-repair** source (falsification) | **6/14 pass, 8 fail** — every refusal witness fails, and the six that pass are exactly the controls (the paths this repair must not change) | `repair3/new-witnesses-falsified.json` |
| `tests/raptor3/g4/review/unit01-followup/` (the reviewer's r3 probes) | **44/44 pass** (4.63 s, 646.1 MiB) | `repair3/followup-probes.json` |
| `tests/raptor3/g4/review/unit01/` (the reviewer's r1 probes) | **44/44 pass** (4.86 s, 719.2 MiB) | `repair3/review-probes.json` |
| `candidate-handoff`, `candidate-ordering`, `candidate-pagination`, `candidate`, `cleanup-failure` | **68/68 pass** (5.38 s, 791.7 MiB) | `repair3/registered-candidate-suites.json` |
| `post-prep/{clearability-consumption,history-analysis,projection-preparation,schema-view-reuse,selector-preparation}`, `prep/{recursive-read-fit,selector-dependencies,variant-collection-order}` | **39/39 pass** (4.92 s, 755.9 MiB). The **first** attempt was refused by the workspace lock (`Vitest (PID 39669) already owns this workspace`, a run that had already exited); waited and retried, as the serial protocol requires. Recorded, not hidden. | `repair3/registered-prep-suites.json` |
| `prep/{g3p04-review-regressions,set-preparation,suppression-replay}` | **16/16 pass** (4.55 s, 618.2 MiB) | `repair3/write-regressions-prep.json` |
| `post-prep/g29-*` minus the PGlite file | **30/30 pass** (4.96 s, 740.2 MiB) | `repair3/write-regressions-g29.json` |
| `post-prep/g29-result-progress-pglite.test.ts` (alone) | **1/1 pass** (5.12 s, **1525.9 MiB**) — first attempt, no ceiling breach this time. The suite still sits within ~1 % of the 1,536 MiB ceiling in this environment and this unit changes nothing PGlite-specific. | `repair3/g29-pglite.json` |
| `ownership/commands`, `polish/commands`, `transitions/junctions-commands`, `transitions/keys-commands` | **52/52 pass** (4.87 s, 731.7 MiB) | `repair3/write-regressions-ownership.json` |
| Whole-estate typecheck, **as delivered** | the two permitted `pattern/pack.ts` TS2345, the pre-existing committed-tree `tests/pattern/pack/program-dump.ts(131,7)` TS2532, **and one diagnostic in the independent reviewer's own probe file** — see "Reported, not repaired" below (6.72 s, 6183.4 MiB) | `repair3/typecheck.log` |
| Whole-estate typecheck, reviewer probes parked | the two permitted `pattern/pack.ts` TS2345 and the pre-existing `program-dump.ts` TS2532 — **nothing else**, which is the claim finding F asked this unit to make true (6.75 s, 5269.5 MiB) | `repair3/typecheck-without-review-probes.log` |

Every count the follow-up-2 review reproduced (69→83 author, 44, 44, 68, 39, 16,
30, 52, 1) reproduces here, and no existing author expectation was corrected:
every witness this unit already had passes unchanged, which is the evidence that
these three refusals are additive to the r4 semantics rather than a
reinterpretation of them.

**Only `query.ts` moved since r4, and the integrator can take just that.**
The other three candidate files still carry their r2/r3 mtimes
(`commands/index.ts` 2026-09-14 22:52:28, `shared/operation-context.ts`
22:52:41, `shared/schema.ts` 22:52:14) against `query.ts`'s 2026-09-15 02:21:56;
no edit of this revision went near them. `production.patch` is, as always, the
whole unit diff **against `0cc61e61`**, so an integrator who has already applied
the r4 patch should apply **`repair3/query-r4-to-r5.diff`** instead — it is the
complete r5 production change (+37 / −9 physical lines in one file) and it will
not collide with the work other streams have since layered onto
`operation-context.ts` and `schema.ts` in the main tree. (Checked, for the
record: those two files now differ between the main tree and this worktree
because the main tree carries later work from other streams that consumes this
unit's exported `Read` type; this unit's own bytes for them are unchanged.)

**Final confirmation, run after the typecheck and after the identity capture**
so no receipt of this revision can be said to predate a file it covers:
`tests/raptor3/g4/unit01` + `tests/raptor3/g4/review/unit01-followup2/` in one
invocation — **146/146 pass** (18 files, 5.47 s, 766.0 MiB),
`repair3/final-confirmation.json`. The identity was re-captured immediately
afterwards and is **unchanged** (`db3c07da…` / `54421896…`), which is what makes
the earlier receipts of this revision receipts *of these bytes*: a test run
writes nothing inside the worktree.

## Reported, not repaired: one typecheck diagnostic in the reviewer's own probe file

```
tests/raptor3/g4/review/unit01-followup2/cursor-refusal.test.ts(29,32): error TS2638:
  Type '{}' may represent a primitive value, which is not permitted as the right
  operand of the 'in' operator.
```

It is `"label" in (orderBy.team ?? {})` in the reviewer's `cursor-refusal.test.ts`
(line 29), a test-local typing question with no reference to `src`. It is not
this unit's file and not this unit's harness: `common.md` makes it *"yours to fix
or report"*, and fixing it would mean editing a reviewer probe whose
byte-identity the review verifies. **Reported.** It is invisible to the
reviewer's own `unit01-review-followup2/typecheck.log` for the same reason
finding F was invisible to `repair2/typecheck.log`: that run is timestamped
01:57 and `cursor-refusal.test.ts` was written at 02:03. The unit's own delivered
source and harness are clean apart from the three known diagnostics —
`repair3/typecheck-without-review-probes.log`, produced by parking
`tests/raptor3/g4/review/` and restoring it with hashes verified identical.

Suggested one-line fix for whoever owns that file:
`const model = typeof orderBy.team === "object" ? "member" : "team";`

## Cost after Repair 3

Same scope and same `countTokenLines` definition as every earlier receipt
(`raptor3/commands` + `raptor3/shared`). The recompute reproduces the reviewer's
`core-cost-recheck.json` **per file, exactly, for all eleven files this repair
does not touch**, which is what makes the twelfth comparable.

| Scope | Physical | Code-bearing | Parser tokens | Bytes |
| --- | --- | --- | --- | --- |
| Core at `0cc61e61` | 6,997 | 6,927 | 43,383 | 230,397 |
| Core after r2 | 8,751 | 8,573 | 53,972 | 290,017 |
| Core after r3 | 8,820 | 8,626 | 54,306 | 292,814 |
| Core after r4 | 8,861 | 8,641 | 54,426 | 294,985 |
| **Core after r5 (this repair)** | **8,889** | **8,660** | **54,569** | **296,423** |
| **Incremental core (unit total)** | **+1,892** | **+1,733** | **+11,186** | **+66,026** |
| Repair-3-only delta (r4 → r5) | +28 | +19 | +143 | +1,438 |
| Complete charged perimeter after r5 (derived) | 16,378 | 13,582 | 83,571 | 565,953 |

The whole delta is in `shared/query.ts` (3,465 → 3,493 physical, 3,314 → 3,333
code-bearing); no other charged file changed a line, so the complete perimeter is
the measured core plus the r4 retained-owner figure (7,489 / 4,922 / 29,002 /
269,530) carried unchanged — **derived, not re-measured this revision**, and
sound because `git diff --stat -- src` still names only the four candidate
files. The G3 complete-charged guidepost of 14,000 code-bearing lines is still
not crossed (13,582).

The **+19 code-bearing** lines, counted by hand against
`repair3/query-r4-to-r5.diff` and summing to the measured total:

| Added | Lines |
| --- | --- |
| `sameDecimalDescriptor` added to an existing import list | +1 |
| `exactDecimalDomain`, the one reading of "exact decimal column, and in which domain" | +7 |
| `prepareOperand` takes the owning scalar (signature over three lines) | +3 |
| `const { model } = owner;` | +1 |
| the referenced scalar is named instead of tested twice | +1 |
| the domain guard and its refusal | +6 |
| **total** | **+19** |

H and I are string replacements and cost **zero** lines. The remaining +9
physical are two comments: the five-line contract note on `exactDecimalDomain`
and the four-line invariant note on `lowerJsonOperation` that lets its refusal
name the field. Receipts: `repair3/core-cost.json` (this revision),
`../unit01-review-followup2/core-cost-recheck.json` (r4, reproduced per file),
`repair/candidate-cost-baseline.json` (the `0cc61e61` baseline, unchanged).

## The four §7 questions, re-answered against the thrice-repaired diff

1. **Necessary decision or representation repair?** Repair, and the smallest
   kind: **none of the three production changes adds a representation**. H and I
   are strings. J adds no state — one existing value (`target.scalar`, already
   computed one line above the old call) is passed one level down instead of one
   of its fields, and one three-line pure function reads a state that the file
   already reads in two other places for two other questions. No second
   interpreter, context or scope class, no per-verb codec, no policy-boolean bag,
   no JavaScript arithmetic beside SQL, no cached absence, no fixture-named flag.
   `query.ts` still imports nothing from the shipped compiler, builders,
   operations or result engine: the decimal *rule* comes from
   `@validation/primitives/decimal-codec`, an existing validation boundary the
   shipped engine, the migration differ and the SQLite migration driver already
   share, and there is no fallback.
2. **Did the named mechanism disappear, and does the replacing invariant have a
   falsifier?** The mechanism named here is a **wrong answer**, and it is gone:
   the candidate can no longer answer `[]` where the shipped engine refuses.
   Falsifier: the six decimal witnesses, four of which fail on the pre-repair
   source (`repair3/new-witnesses-falsified.json`), and the reviewer's own
   `decimal-fieldref.test.ts`. Every r2, r3 and r4 deletion remains gone
   (`grep -n 'kind: "not"'` still matches only the union member, `combine`, the
   scalar `not` operator and the relation `isNot` quantifier). The two reworded
   refusals have differential *and* absolute falsifiers: each witness pins the
   shipped sentence itself, so it fails both when the candidate diverges and
   when both engines drift together.
3. **Is each rule stated once and used by every consumer?** Yes, and this
   revision closes the one place the follow-up-2 review said it was not. *"A
   registered refusal is a contract"* was honored in `distanceExpression` and
   `geoPoint` at r4 and broken in three other owners of the same file; those
   three now carry the shipped sentence, and the missing one is raised in the
   single owner that reads the operand it is about, so no consumer can reach a
   field-reference operand without passing it. The unit's whole message
   vocabulary in `query.ts` has now been compared against the shipped engine
   sentence by sentence — by the reviewer at r5 and by this author while
   repairing — and the two remaining divergences are both **unreachable** by any
   admitted input and are recorded as such below, not silently left. The three
   standing "no"s are unchanged and still recorded rather than hidden:
   output-shape *assembly* has three sites outside `prepareProjection`;
   `program/index.ts` is a second read entry (§8 blocker 2); and the polymorphic
   slot-presence branch builds a bare `{kind: "or"}` without going through
   `combine` (the reviewer's observation at r5 — a different rule, agreeing
   answer, worth one sentence in the private guide, not a repair).
4. **What grew?** +28 physical / +19 code-bearing / +143 tokens / +1,438 bytes,
   itemized above against a diff that is preserved so the split stays checkable.

## Rules added and decisions removed by Repair 3

**Added rules (1).**
1. *Two exact decimals compare only when they declare the same precision and
   scale.* Stated once, in the one owner that resolves a field-reference operand,
   and refused before I/O rather than answered differently per provider (SQLite
   stores the unscaled coefficient, so `decimal(12,2)` `1.20` and
   `decimal(12,4)` `1.2000` are the different integers 120 and 12000 there and
   the same logical value on a dialect that stores logical values). Consequence a
   consumer must not re-derive: a reference between two decimal columns is a
   **refusal**, not a comparison, unless the domains match.

**Removed decisions (1).**
1. *"A field-reference operand is comparable because both sides are the same
   scalar kind."* Removed: kind is not the boundary, the declared domain is.
   Falsifier: any pair of exact decimals of different `(precision, scale)`
   answering a row instead of refusing.

H, I and F remove no decision and add no rule — they are a contract restored to
its registered wording, twice, and a type annotation.

## What this repair did **not** change

- No public contract, no admitted argument, no result shape, no error class.
  All three production repairs are *parity* repairs with the shipped engine as
  the oracle; none is a compatibility choice, so **no decision is owed to
  Arnaud from this revision**.
- No SQL shape changed for any input that was already answered: the three
  changes are reached only on the refusal paths, and every control witness (the
  same-domain reference, the non-decimal reference, the negated reference, the
  scalar cursor order, the plain `equals: null` path, the whole-column
  sentinels) answers exactly what it answered before.
- `handoff.md` stays at **revision 4** and is still accurate: no statement in it
  quotes either reworded sentence, and its §5 claim about the four registered
  *distance* refusals was true and remains true. For the next revision, whoever
  edits it should add one bullet to §5, which this author has not applied
  because it is outside the repair the review scoped: *"A field reference
  between two exact decimal columns is refused unless both declare the same
  precision and scale — `prepareOperand` owns it, with the shipped sentence
  (`builders/where-builder.ts:438-455`). G4-02 inherits this when it extends
  `fieldValue`/`value` for write-side operands."*
- The reviewer's probe files, the earlier receipts and the unrelated dirty
  files in the main tree are untouched.

## Unverified claims (this revision)

| Claim | Status |
| --- | --- |
| PostgreSQL / MySQL lowering is adapter-spelled but not executed | **Still unverified, still labeled.** Unchanged by this repair: all three repairs here are reachable on SQLite and every witness executes on it. |
| The complete charged perimeter after r5 (16,378 / 13,582 / 83,571 / 565,953) | **Derived, not re-measured**: the retained-owner component is carried from r4. The core component is measured (`repair3/core-cost.json`) and the derivation is sound only while no retained file changes, which `git diff --stat -- src` confirms. |
| The r4 added/removed line split ("32" vs "35") | **Unverifiable and no longer claimed** — finding G. This revision's split is checkable (`repair3/query-r4-to-r5.diff`). |
| `JSON filter '<op>' requires a number or string operand.` drops the shipped `for field '<name>'` | **Unreachable, not repaired.** Admission types `lt`/`lte`/`gt`/`gte` on a JSON filter as `v.union([v.number(), v.string()])` — `comparisonOperand` at `validation/scalars/json.ts:126`, bound to the four operators at `:133-136` (re-read this revision, not carried from the review), so neither engine can reach either sentence. Same standing as the vector `"filter"` arm recorded at r4. Recorded rather than "fixed" so a future reader does not mistake it for a divergence. |
| The `in`/`notIn` **member** operand path now raises the decimal-domain refusal too | **True and deliberate** — it is the same single owner — but it is **not** a parity claim: the shipped engine refuses a field reference in `in`/`notIn` *outright* (`lit`, `where-builder.ts:519-526`: `Field reference '<ref>' is not supported by the 'in' filter on '<field>'.`), so the two engines already diverged there **before** this repair and still do. Pre-existing, outside the five findings this revision was scoped to, not probed here, and recorded so it is not mistaken for a regression. It is a candidate refusal that is *missing*, not one that is reworded; whoever schedules the next sweep should take it with the same standard as J. |
| "58/63 before, 63/63 after, 83/83, 14/14, 8/14 falsified, 44/44, 44/44, 68/68, 39/39, 16/16, 30/30, 52/52, 1/1" | **Measured this revision**, receipts in `repair3/`. |
