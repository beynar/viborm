# G4-01 query/projection — independent adversarial review

Reviewer: independent (did not author the unit). Source reviewed:
`/private/tmp/viborm-g4-unit01` (detached at `0cc61e61`, change already applied;
nothing was applied or repaired by this review).

**Outcome: REVISE.**

The unit is a real and largely correct completion of the read envelope. Every
claimed deletion is verified gone, the four §7 questions survive most of the
diff, the cost figures reproduce to the byte, the author's 34 checks and all
re-run registered suites reproduce green, and 19 of the 20 shapes in a broad
differential matrix against the shipped engine (same data, same public
arguments, same SQLite provider) agree exactly. It is not acceptable as it
stands: three admitted public inputs answer *silently differently* from the
shipped engine, two more throw where the shipped engine answers, and one added
representation has no producer. Every fix is inside an owner this unit already
owns; nothing requires a redesign.

---

## Identity and reproduction

| Fact | Value |
| --- | --- |
| Production identity reviewed | `2d579f68d6dad4725c5dd8f9a39e6c0909792cee4582a3d895a8230cbb686ef5` — **identical** to the author's `receipts/identity.json` |
| Harness identity at review time | `8036a767094cef39129fbf52a59accaf092865b522d5adf05a7883f7fc9bf264` (differs from the author's receipt because this review added probes; see finding 11) |
| `production.patch` vs worktree `git diff` | byte-identical |
| `author-tests/*` vs `tests/raptor3/g4/unit01/*` | byte-identical (8 files) |
| Runtime | Node v24.21.0, darwin/arm64, better-sqlite3 12.6.0, Vitest 3.1.4 |

Suites re-run (serially, through `scripts/run-vitest-safe.mjs`):

| Suite set | Result | Review receipt | Author receipt |
| --- | --- | --- | --- |
| `tests/raptor3/g4/unit01` (author checks) | **34/34 pass** | `author-tests-rerun.json` | `receipts/author-tests.json` (34) — reproduced |
| `candidate-handoff`, `candidate-ordering`, `candidate-pagination`, `candidate`, `cleanup-failure` | **68/68 pass** | `registered-candidate-suites.json` | `receipts/registered-candidate-suites.json` (68) — reproduced |
| `tests/raptor3/post-prep` + `tests/raptor3/prep` (whole directories) | **86/86 pass** | `registered-prep-suites.json` | the author's `registered-prep-suites.json` (39) + `write-regressions-prep.json` (16) + `write-regressions-g29.json` (30) = 85 — reproduced; the 86th is `post-prep/g29-result-progress-pglite.test.ts` (1), which the author's three batches did not include (the five `native-*` files in these directories collect 0 tests without a provider) |
| `ownership/commands`, `polish/commands`, `transitions/junctions-commands`, `transitions/keys-commands` | **52/52 pass** | `write-regressions-ownership.json` | `receipts/write-regressions-ownership.json` (52) — reproduced |
| Whole-estate typecheck | the two permitted `pattern/pack.ts` TS2345 plus `tests/pattern/pack/program-dump.ts(131,7)` TS2532 | `typecheck.log` | matches `receipts/typecheck.log`; `git status` confirms `program-dump.ts` is the **committed** `0cc61e61` file in this worktree, so the third diagnostic is genuinely pre-existing and not the unit's |
| Review probes (this review) | 44 checks, 36 pass, **8 fail** | `review-probes.json`, `review-probes.log` | — |

Review receipts are under
`docs/architecture/raptor3-evidence/g4/unit01-review/`.

Running `tests/raptor3/ownership tests/raptor3/polish tests/raptor3/transitions`
as whole directories reports 14 *file-level* failures; all 14 are the
`transitions/*-live-*.ts` provider gate (`Required live provider is pg or
mysql`), and 446/446 collected tests pass. Pre-existing environment gating, not
the unit's. Running `candidate* + post-prep + prep` in one Vitest invocation
exceeds the 1,536 MiB sampled ceiling (1,665 MiB); the two batches above stay
under it, which is presumably why the author split them the same way.

Review probes live in
`/private/tmp/viborm-g4-unit01/tests/raptor3/g4/review/unit01/` and are kept:
`whole-value-operands.test.ts`, `nested-window.test.ts`,
`decode-strictness.test.ts`, `order-cursor.test.ts`,
`having-projection.test.ts`, `null-placement-parity.test.ts`,
`logical-forms.test.ts`, `variant-arms.test.ts`, `shipped-parity.test.ts`,
`distance-projection.test.ts`, `world.ts`. Receipts under
`docs/architecture/raptor3-evidence/g4/unit01-review/`.

---

## Findings

### 1. (blocking) Unqualified `orderBy` silently changes where NULLs land

`src/query-engine/raptor3/shared/query.ts:1650-1664` (`sortKey`) and
`:1534-1547` (`lowerOrder`).

`sortKey` defaults `nulls` to `descending ? "first" : "last"` whenever the
column is nullable, and `lowerOrder` then emits `orderBy.nullsLast` /
`nullsFirst` for **every** nullable sort key, including keys the caller spelled
as a bare `"asc"` / `"desc"`. The shipped engine emits the bare direction in
that case (`src/query-engine/builders/sort-order-builder.ts:68-70, 100-102`) and
only states a placement when the caller asked for one. On SQLite and MySQL, the
bare direction puts NULLs FIRST for `asc`; the candidate puts them LAST. Every
unqualified order over a nullable column therefore answers a different row
order, and because `page()`/`totalOrder`/`cursorCondition` read `term.nulls`,
every windowed and cursor read built on such an order drifts with it.

Probes (differential, shipped engine and candidate over identical SQLite data):

- `tests/raptor3/g4/review/unit01/null-placement-parity.test.ts` —
  `orderBy: { weight: "asc" }`: shipped `[2,4,3,5,1]`, candidate `[3,5,1,2,4]`;
  `"desc"`: shipped `[1,5,3,2,4]`, candidate `[2,4,1,5,3]`.
- `tests/raptor3/g4/review/unit01/shipped-parity.test.ts` ::
  `orders by a relation count and by a to-one path` —
  `orderBy: [{ owner: { name: "asc" } }, { id: "asc" }]` with one row whose
  relation is absent: shipped `[5,1,2,3,4]`, candidate `[1,2,3,4,5]`
  (`relationOrderTerm` at `:1607-1665` marks the correlated value `nullable:
  true` unconditionally).

`common.md` states that a new observable compatibility choice is a decision for
Arnaud and must be recorded as a blocker. `note.md` §8 records five unverified
claims and one blocker; this is not among them, and `handoff.md` §5 states the
new default as settled fact ("Default placement: `asc` → nulls last, `desc` →
nulls first"), which will propagate the change into G4-02 and the witnesses.

Resolution: either emit the bare direction when the caller did not spell
`nulls` (shipped parity — `OrderTerm.nulls` becomes optional and `lowerOrder`
only wraps when it is present, with the cursor predicate reading the provider
default for an unspelled key), **or** obtain and record an explicit decision
from Arnaud plus a registered witness pinning the normalized placement on all
three dialects. Note the Phase-5 ordering contract
(`tests/contracts/drivers/behaviors/ordering-plan-behavior.ts:175-206`) already
elides placement on NOT NULL columns for index reasons; adding it by default on
nullable columns is the adjacent choice and deserves the same explicit record.

### 2. (blocking) A negative nested `take` returns the window in reverse order

`src/query-engine/raptor3/shared/query.ts:2695-2743` (`lowerRelationProjection`,
which reverses the nested order and applies `abs(take)`) and `:2978-2981`
(`decodeValue`'s `collection` branch, which never restores the logical order).

At the root, `read()` (`:1960-1967`) reverses the decoded array for a negative
`take`. A nested to-many node runs the same reversed window but its decoded
array is returned as the provider produced it, so the caller sees the correct
rows in the wrong order. The shipped engine restores it
(`src/query-engine/result/relation-result-parser.ts:66-68`, and
`polymorphic-result-parser.ts:282,315` for variant arms), and `handoff.md` §6
claims the same ("`take: -n` reverses the window exactly as at the root").

Probe: `tests/raptor3/g4/review/unit01/nested-window.test.ts` ::
`restores the logical order of a negative nested take` —
`include: { notes: { orderBy: { rank: "asc" }, take: -2 } }` over two parents
returns `[{id:3},{id:2}]` / `[{id:5},{id:4}]`; expected (and what the same
`take: -2` returns at the root, asserted in the next check of the same file)
`[{id:2},{id:3}]` / `[{id:4},{id:5}]`.

Resolution: carry the reversal in the prepared shape, as the shipped
`ExpectedRelationResultShape.reversed` does — e.g. mark the `collection` shape
(and each variant arm's collection) `reversed` in `prepareProjection` when
`arguments.take < 0`, and reverse in `decodeValue`'s `collection` branch. Row
Q-P03 should not be claimed until a witness covers the negative nested window.

### 3. (blocking) A distance projection is silently dropped and its refusal is lost

`src/query-engine/raptor3/shared/query.ts:2488-2491` (`prepareProjection`'s
scalar branch).

`select: { <point|vector field>: { _distance: { to, metric? } } }` is an
admitted projection (`src/validation/model/core/select.ts:179-202`,
`vectorDistanceSelectSchema` / `pointDistanceSelectSchema`). `prepareProjection`
tests only truthiness of the selection for a non-relation field, so the
`_distance` request is discarded and the raw column is projected and decoded as
a GeoPoint/vector. On a provider that lacks the distance tier the shipped engine
raises the registered capability refusal; on a full-tier provider it would
return a distance number. The candidate returns the column in both cases.

Probe: `tests/raptor3/g4/review/unit01/distance-projection.test.ts` — on the
coordinate-tier SQLite adapter, shipped throws
`point.distance select is not supported. GeoPoint distance is not supported by
this provider.`; candidate returns
`[{"id":1,"at":{"longitude":2.3522,"latitude":48.8566}}]`.

`note.md` lists Q-O02 as partial for *ordering* only and claims Q-S01
(`select`/`include`/`omit`) implemented; the distance projection is neither
implemented nor declared missing, and `handoff.md` §5's claim that "the distance
expression is also projected under a query-local alias that no model field can
collide with" is not true of the diff — `distanceExpression` has exactly two
call sites (`:1290` filter, `:1584` orderBy) and no projection site at all.

Resolution: route a `_distance` scalar selection through the same
`distanceExpression` owner into a projected leaf (nullable float), so the
capability refusal comes from the one owner and the output name is stated once;
or, if it is deferred to G4-02, refuse it explicitly and record the row as not
started.

### 4. (must-fix) `equals` on a blob column throws for a `Uint8Array` operand

`src/query-engine/raptor3/shared/query.ts:297-305` (`addressesOperators`) and
`:835-880` (`prepareOperations`).

Admission normalizes a shorthand filter into `{ equals: <value> }`
(`src/validation/primitives/shorthand.ts:11`), and `prepareOperations` recurses
into the `equals` operand, re-testing it for operator-ness.
`addressesOperators` only disambiguates whole-value objects for `json` and
`point`; for every other domain an object operand is taken to be an operator
record. A `Uint8Array` then yields its indices as operator names and
`lowerOperation`'s default arm throws
`Raptor 3 filter operator is not implemented: 0`. The shipped engine reads the
filter object exactly once and passes the operand through
(`src/query-engine/builders/where-builder.ts:323-386`, `equals` arm at `:640`).

Probe: `tests/raptor3/g4/review/unit01/whole-value-operands.test.ts` ::
`filters a blob column by a Uint8Array operand` and `negates a blob equality
operand` (`{ not: <Uint8Array> }`). `Date`, `date` and `Decimal` operands pass,
because their validation schemas canonicalize them before the engine sees them —
blob does not, so blob is the reachable case today and any future
non-canonicalizing domain joins it.

This is the exact invariant the unit itself states in `note.md` §10 ("An
admitted operator record owns its keys — a `Uint8Array`, `Decimal` or `Date`
inherits methods with the same names and is one whole value") and applies in
`Queries.updateValue` (`:568-598`, via `Object.hasOwn` + `isOperatorRecord`).
§7 question 3 ("one rule across uses") does not hold for it: the rule is applied
in one of its two owners.

Resolution: use the existing `isOperatorRecord` guard in `addressesOperators`
(a non-plain object is one whole value for every domain), or stop recursing into
the `equals` operand.

### 5. (must-fix) `where: { NOT: [c1, c2] }` throws

`src/query-engine/raptor3/shared/query.ts:758-769` (`prepareWhere`).

`AND` and `OR` are read with `entries(operand)` (object or array); `NOT` is read
with `record(operand)`. The where schema admits an array for `NOT` exactly as it
does for `AND` (`src/validation/model/core/where.ts:68-70`: both are
`union([whereSchema, array(whereSchema)])`) and the shipped engine gives
`NOT: [c1, c2]` the Prisma meaning `NOT c1 AND NOT c2`
(`src/query-engine/builders/where-builder.ts:281-311`). In the candidate the
array's indices are read as field names and
`Raptor 3 G1 physical field is not implemented: 0` is thrown from
`storage.ts:187`.

Probe: `tests/raptor3/g4/review/unit01/logical-forms.test.ts` ::
`negates each arm of an array NOT and ANDs the negations` (differential; the
array `AND`/`OR` forms and the empty-array forms agree with the shipped engine).

Note the asymmetry inside the unit: `prepareHaving` (`:2786-2867`, `NOT` arm at
`:2811-2825`) *does* use
`entries(value)` for `NOT` and produces the correct `AND of NOTs`. Row Q-W01
("recursive AND/OR/NOT") should not be claimed until the array form of `NOT` is
covered.

Resolution: read `NOT` with `entries(operand)` in `prepareWhere` and negate each
arm, matching `prepareHaving` and the shipped semantics.

### 6. (must-fix) An added representation with no producer

`src/query-engine/raptor3/shared/query.ts:110-118`
(`PreparedProjectionField` kind `"aggregate"`) and `:2641-2642`
(`lowerProjection`'s branch for it, emitting `a.json.objectFromColumns([])`).

No code path constructs a projection field of kind `"aggregate"`
(`prepareProjection` pushes only `counts`, `scalar`, `relation`, `variants`);
the type member and its lowering branch are unreachable. §7 question 1 asks
whether each added rule is a necessary decision — this one is dead flexibility,
and its lowering (an empty JSON object) is a silently wrong answer waiting for
the first producer.

Resolution: delete the type member and the branch; `prepareAggregates` already
owns aggregate columns and leaves.

### 7. (must-fix) Handoff and note claims that the diff does not support

Evidence-integrity items, all in
`docs/architecture/raptor3-evidence/g4/unit01/`:

1. `handoff.md` §5: "The distance expression is also projected under a
   query-local alias that no model field can collide with, so the output name is
   unambiguous." No distance is projected anywhere (finding 3).
2. `handoff.md` §6: nested "`take: -n` reverses the window exactly as at the
   root". It reverses the SQL window but not the decoded array (finding 2).
3. `handoff.md` §7: "Carrier-level failures (a carrier that is not an object, a
   collection that is not an array, a `_count` carrier whose keys do not match
   the requested relations) raise their own carrier reasons **through the same
   path**." Only the `_count` key-mismatch case does — by code reading it
   degenerates to `InvalidScalarResult(int, "the value is absent")` in
   `decodeValue`'s object branch, which `failure` does translate; no probe can
   force it from a real provider. A carrier that is not an object, or a
   collection that is not an array, raises a bare
   `TypeError("Invalid provider row" / "Invalid provider collection")`
   (`query.ts:2978`, `:2983`) which `OperationContext.failure`
   (`operation-context.ts:245-258`) does not translate, so it reaches the caller
   with no driver/operation/scalarType meta. The shipped engine has a named
   identity for these (`result/relation-result-parser.ts:48-53`,
   `malformedResult`).
4. `note.md` §7 question 2: "`prepareProjection`/`aggregateLeaf` own every
   output shape." `count`'s selected `{ _all, field }` shape is assembled inline
   in `read()` (`query.ts:1968-2033`) and `aggregate`'s in `prepareAggregates`
   (`:2087-2140`); `grouped()` assembles the by-column half (`:2744-2760`).
   These are three shape-assembly sites outside the named owner. They share
   `COUNT_LEAF` and `aggregateLeaf`, so the duplication is small — but the
   invariant as written is not what the diff does, and D2's replacing invariant
   is the one a later unit will rely on.
5. `note.md` §8 omits the null-placement compatibility change (finding 1) from
   both the blocker list and the unverified-claims list.

Resolution: correct the five statements, add finding 1 as a recorded decision
request, and re-freeze the handoff at revision 3 before G4-02 rebases on it.

### 8. (note) A second read entry the "one read entry" invariant did not reach

`src/query-engine/raptor3/program/index.ts:20-50`.

The `program` route still names `findMany`/`groupBy` by hand and calls
`queries.select` / `queries.grouped` directly, so it gets none of `Queries.read`'s
cardinality decisions — and because `select()` now normalizes the window, that
route's `findMany({ take: -n })` changed behavior as a side effect of this diff
(previously `LIMIT -n`, i.e. unlimited on SQLite; now a reversed window with no
array restoration). The file is not in this unit's owned list, so this is a
request to the root/G4-02 rather than a defect of the unit — but D3's replacing
invariant ("cardinality is a property of the admitted operation, owned once by
`Queries.read`") has a live second consumer, and D4's ("one admitted-operation
classification") likewise: `isReadOperation` is not used here.

Resolution: route `program/index.ts` through `Queries.read` and
`isReadOperation`, or record that the program route is frozen and exempt.

### 9. (note) `page()` computes `distinct` for windows that discard it

`src/query-engine/raptor3/shared/query.ts:1678-1726` (`page`) and `:2040-2073`
(`aggregated`).

`aggregated` calls `page()` and uses `orderBy`/`limit`/`offset`/`cursor` but
never `distinct`. That is currently harmless — neither `CountArgs` nor
`AggregateArgs` admits `distinct`
(`src/validation/model/args/aggregate.ts`, `getCountArgs` / `getAggregateArgs`)
— but the page owner
returns a fact its caller silently drops, which is the shape a later `distinct`
admission would fail through instead of failing loudly.

Resolution: none required now; consider asserting or destructuring exhaustively
so a future admission cannot be dropped silently.

### 10. (note) `findUnique` has no `LIMIT` and takes `rows[0]` without a witness for the extra-row case

`src/query-engine/raptor3/shared/query.ts:1949-1951` (`read()`, `findUnique`).

This is the deliberate D3 outcome and is fine for a strict unique selector. It
does mean that if a selector ever admitted a non-unique shape the engine would
silently answer the first row rather than fail. No probe could reach it through
admission; recorded only so the invariant ("the selector is strictly unique") is
named somewhere a later change can falsify.

### 11. (note) `receipts/identity.json` is older than the run it labels

`docs/architecture/raptor3-evidence/g4/unit01/receipts/identity.json` was written
at 23:19; `tests/raptor3/g4/unit01/{filters.test.ts,variants.test.ts,world.ts}`
were last modified at 23:21–23:22 and `receipts/author-tests.json` was written at
23:24. The recorded `harness` fingerprint (`41e9f660…`) is therefore **not** the
harness that produced the author-test receipt. The `production` fingerprint is
unaffected and reproduces exactly, so no claim about the reviewed source is in
doubt; the harness line is just stale.

Resolution: capture the identity after the last harness edit, or capture it per
receipt.

---

## §7 decision-elimination gate, answered against the diff

**1. Is every added rule a necessary decision or a representation repair?**
Mostly yes. `PreparedTarget` genuinely removes a representation (verified:
`lowerValuePredicate` no longer exists anywhere in `src/`). The operator
vocabulary, cursor/distinct, aggregate verbs, `_count` and the scalar leaf
decoders are database behavior, a real boundary, or a provider capability, and
each is added to the single owner rather than to a parallel ladder. Two
exceptions: the unreachable `"aggregate"` projection field (finding 6), and the
default null placement, which is not a repair of a representation but a change
of an observable answer (finding 1).

No second interpreter, context or scope class, no per-verb codec, no
policy-boolean bag, no JavaScript arithmetic beside SQL, no defensive
re-validation of trusted internal values, no cached absence, no fixture-named
flag, no legacy import and no fallback. `assembleAdapterSelect`,
`@adapters/*` and `@validation/primitives/*` are the pre-existing seams; nothing
from `src/query-engine/builders`, `result`, `operations`, `write-engine` or
`pattern` is imported.

**2. Did the named mechanism disappear, and does the replacing invariant have a
falsifier?** Verified gone, by grep against the worktree and by diff against
`0cc61e61`:

| Claimed deletion | Verified |
| --- | --- |
| `Queries.lowerValuePredicate` | `grep -rn lowerValuePredicate src/` → no match |
| `grouped()`'s inline leaf table (`_avg → float`, `_sum → int`) and field assembly | gone from `grouped()`; replaced by `prepareAggregates` + `scalarShape` |
| `findUnique`'s `{ …args, take: 1 }` entry special case | gone from `commands/index.ts` (the remaining `take: 1` occurrences are write-path single-row reads and the program route) |
| the `findMany`/`findUnique`/`groupBy` triple in `OperationContext.run` | replaced by `isReadOperation` |
| `columnName`'s G1 scalar gate (`throw` for every type but int/string/decimal) | gone; `columnName` is one line |

Falsifiers exercised independently by this review: D1 — `having: { category: {
notIn: [...] } }` and nested `NOT`/`OR` over aggregate targets answer correctly
(`having-projection.test.ts`); D2 — `groupBy({ by: ["personId"] })` over a
**mapped** column keeps the public name and real nullability, `_sum` of a
`bigInt` decodes as `bigint`, `_avg` as a float, `_count` as a non-nullable int
(`having-projection.test.ts`, `decode-strictness.test.ts`); D5 — a malformed
leaf is refused with the SAME established identity at the root, inside a to-many
carrier and inside a list container, and an empty aggregate window answers
`null` per leaf rather than coercing (`decode-strictness.test.ts`); the
thirteen-domain breadth itself is the author's `codec-roundtrip.test.ts`, re-run
green. D1's falsifier is only *partly* honored: `where` and `having` still read
`NOT` differently (finding 5).

**3. Is each rule stated once and used by every consumer?** Yes for the page
owner (root, nested node, aggregate window — all probed), the operator
vocabulary (root, nested relation scope, `having`, relation `_count` filter),
the projection/decoder (rows, carriers, variant arms, recursive occurrences) and
the aggregate expression. No for the whole-value/operator-record rule, which is
applied in `updateValue` and not in the filter path (finding 4), and for the
`NOT` shape, which differs between `prepareWhere` and `prepareHaving`
(finding 5). Output-shape assembly has three sites outside `prepareProjection`
(finding 7.4), and a second read entry exists in `program/index.ts` (finding 8).

**4. What grew?** Reproduced exactly (below).

---

## Cost check

Recomputed with the census's own `countTokenLines` definition over the same
scope the author's receipts use (`raptor3/commands` + `raptor3/shared`;
`raptor3/program` is excluded in both the baseline and the after figure, which
is why 6,997 = 3,228 + 3,769 at the baseline):

| Scope | Author | Recomputed | Match |
| --- | --- | --- | --- |
| commands (physical / token lines / bytes) | 3,241 / 3,209 / 107,040 | 3,241 / 3,209 / 107,040 | yes |
| shared | 5,510 / 5,364 / 182,977 | 5,510 / 5,364 / 182,977 | yes |
| **core after** | **8,751 / 8,573 / 290,017** | **8,751 / 8,573 / 290,017** | yes |
| core baseline (`candidate-cost-baseline.json`) | 6,997 / 6,927 / 230,397 | — | reproduces `g4.md`'s opening figures exactly |
| **incremental core** | **+1,754 / +1,646 / +59,620** | same | yes |

The parser-token figures (43,383 → 53,972, +10,589) are produced by the
author's own counter; the baseline value reproduces `g4.md` line 15 exactly, so
the counter is the one the milestone uses and the delta is internally
consistent. The "retained owners" figure (7,489 physical / 4,922 code-bearing)
has no receipt of its own, but the arithmetic closes against `g4.md` line 16
(6,927 + 4,922 = 11,849), so the complete-perimeter figures (13,495 code-bearing
after, under the 14,000 guidepost) stand. Receipt:
`g4/unit01-review/core-cost-recheck.json`.

Growth judgement: honest. `shared/query.ts` is now 3,355 physical lines in one
file, which the census flags as a >600-line file; that is a shape question for
the root, not a rule violation.

---

## Unverified author claims (checked, and what remains unverified)

| Claim | Status after review |
| --- | --- |
| PostgreSQL / MySQL lowering is adapter-spelled but not executed | **Still unverified** (no provider answered here either). Findings 2–6 are provider-independent and would reproduce on PG/MySQL. Finding 1 is the opposite: it is inert on PostgreSQL (whose own defaults are `ASC NULLS LAST` / `DESC NULLS FIRST`) and changes the answer on SQLite and MySQL, so a PG-only witness would never catch it. |
| Decimal `having { _sum: … }` operand binds in the field's domain, not the widened one | **Confirmed unreachable on SQLite** and correctly labeled: `literals.decimal` → `encodePhysicalDecimal` uses only `descriptor.scale` (`decimal-codec.ts:752-762`), and the validation widening keeps the scale (`args/aggregate.ts` `sumOperandDomain`). Remains unverified on PG/MySQL. |
| GeoPoint distance emits no indexable `withinBounds` pre-filter | Confirmed true of the diff; plan-shape only, correctly labeled unverified. |
| Enum-list provider array text (`providerArrayMembers`) | Still unexecuted; correctly labeled. |
| Vector distance positive path needs pgvector | Confirmed: the refusal path is executed, the positive path is not. |
| `assignments.ts:28` `"set" in value` blocker | Confirmed present and correctly attributed to another owner. **The same class of defect exists in this unit's own read path** and is not recorded (finding 4). |
| "34 author checks green on real SQLite; every registered raptor3 read and write suite re-run green; typecheck clean apart from the two permitted Pattern diagnostics and one pre-existing committed-tree diagnostic" | **Reproduced in full.** |

---

## What would make this ACCEPT

1. Findings 1, 2 and 3 resolved (or, for 1, an explicit recorded decision plus a
   three-dialect witness).
2. Findings 4 and 5 fixed in `prepareOperations` / `prepareWhere`, with a
   witness each.
3. Finding 6 deleted.
4. `handoff.md` re-frozen at revision 3 with the five corrected statements and
   the recorded decision request (finding 7), since G4-02 and the witness author
   rebase on it.
5. Findings 8–11 acknowledged in the note; none of them blocks.
