# G4-01 query/projection — independent review of the SECOND repair pass

Reviewer: independent (did not author the unit, did not repair anything).
Source reviewed: `/private/tmp/viborm-g4-unit01` (detached at `0cc61e61`, the
twice-repaired change already applied). This document follows
`docs/architecture/raptor3-evidence/g4/unit01-review.md` (REVISE, 3 blocking +
4 must-fix) and `unit01-review-followup.md` (REVISE, 4 findings: B, C, D
must-fix, E note).

**Outcome: REVISE.**

All four follow-up findings — B, C, D and E — are **resolved**, and resolved
properly: each repair lives in an owner the unit already held, each states its
rule once, each has a producer/consumer pair I verified by grep rather than by
reading the note, and each has a falsifier that actually fails on the pre-repair
source. I wrote 63 new adversarial probes; the 56 aimed at the three repaired
owners — composition and recursion of the empty-arm rule, relation- and
nested-scoped combinators, every read verb, mixed and doubled distance orders,
both directions, a non-nullable point column, a vector order, a cursor beside a
distance order, the refusal *ordering*, and absolute (non-parity) pins so the
agreement assertions cannot pass vacuously — **all pass**. Every registered
suite, every earlier probe set, the cost census and the identity reproduce
exactly.

It is not ACCEPT, for two reasons.

1. **The unit leaves a whole-estate typecheck diagnostic in its own test
   harness**, and the r4 typecheck receipt was captured *before* the harness
   edit that introduced it, so the record's "nothing else" claim is not true of
   the delivered identity (finding F). One line, in a test file.
2. **Finding D was repaired where it was pointed, not where it applies.** The
   author restored the four distance refusals the follow-up named; I then swept
   the unit's whole refusal vocabulary against the shipped engine and three more
   registered refusals in owners this unit holds are still wrong (findings H, I,
   J) — 7 further probes, of which 5 fail. Two are rewordings
   of the same kind as D 2–4; the third, J, is a **missing** refusal where the
   candidate silently answers `[]` instead — that one is blocking under the same
   standard r1 used for the null-placement and dropped-projection findings.

H, I and J are **inherited from r2**, not created by this repair; they are
divergences my first two reviews did not probe, not regressions. Each is a
localized change inside a function the unit already owns.

Nothing in this review is a compatibility decision for Arnaud. Every finding is
measured against the shipped engine as the oracle; no new observable choice is
proposed and no decision is owed.

---

## Identity and reproduction

| Fact | Value |
| --- | --- |
| Production identity (`captureRaptor3Identity()`) | `b779454047df89b8a3b55a714e0a78e275b0abf3301e82f6eb678b2b9e1edca6` — **identical** to `repair2/identity.json` |
| Harness identity | author `12d8ad10f3e4e03f4f6ed5145addcae49787104e50e87313753ab8ef006755de` reproduced **exactly** before I added anything; `fd837cc43b915580de8240ce43e8664c31ee9dfeaab3089c8d14f3faf31e8b0e` after adding my 8 probe files |
| `production.patch` vs worktree `git diff -- src` | **byte-identical** (4 files, +2289 / −425) |
| `author-tests/*` vs `tests/raptor3/g4/unit01/*` | **byte-identical** (10 files) |
| My r1 and r3 probe files in the worktree | **byte-identical** to the copies under `unit01-review-followup/probes/` — the author did not touch them |
| r2/r3 receipts (`receipts/`, `repair/`) | untouched, not relabeled |
| Runtime | Node v24.21.0, darwin/arm64, better-sqlite3 12.6.0, Vitest 3.1.4 |

Everything below was re-run serially through `node scripts/run-vitest-safe.mjs`
on the current source. Receipts:
`/Users/arnaud/code/viborm/docs/architecture/raptor3-evidence/g4/unit01-review-followup2/`.

| Suite set | Result | Review receipt | Author receipt |
| --- | --- | --- | --- |
| **New review probes (this pass)** — `tests/raptor3/g4/review/unit01-followup2/` | **63 checks, 58 pass, 5 fail** (4.76 s, 737.7 MiB). The 5 failures are findings H, I and J; the 56 aimed at the repaired owners all pass | `new-probes.json` | — |
| `tests/raptor3/g4/review/unit01-followup/` (my r3 probes) | **44/44 pass** | `followup-probes-rerun.json` | `repair2/followup-probes.json` (44) — reproduced |
| `tests/raptor3/g4/review/unit01/` (my r1 probes) | **44/44 pass** | `review-probes-r1-rerun.json` | `repair2/review-probes.json` (44) — reproduced |
| `tests/raptor3/g4/unit01` (34 + 13 r3 + 22 r4) | **69/69 pass** (4.65 s, 728.1 MiB) | `author-tests-rerun.json` | `repair2/author-tests.json` (69) — reproduced |
| `candidate-handoff`, `candidate-ordering`, `candidate-pagination`, `candidate`, `cleanup-failure` | **68/68 pass** | `registered-candidate-suites.json` | reproduced |
| `post-prep/{clearability-consumption,history-analysis,projection-preparation,schema-view-reuse,selector-preparation}` + `prep/{recursive-read-fit,selector-dependencies,variant-collection-order}` | **39/39 pass** | `registered-prep-suites.json` | reproduced |
| `prep/{g3p04-review-regressions,set-preparation,suppression-replay}` | **16/16 pass** | `write-regressions-prep.json` | reproduced |
| `post-prep/g29-*` minus the PGlite file | **30/30 pass** | `write-regressions-g29.json` | reproduced |
| `post-prep/g29-result-progress-pglite.test.ts` (alone) | **1/1 pass** at 1527.5 MiB — **third** attempt; attempts 1 and 2 breached the 1,536 MiB ceiling at 1555.2 and 1542.1 MiB and wrote no report. Recorded as failed, not relabeled | `g29-pglite.json`, `g29-pglite-attempt1-breached.log` | author saw the same behavior (1 breach, then 1523.7 MiB) |
| Whole-estate typecheck | the two permitted `pattern/pack.ts` TS2345, the pre-existing `tests/pattern/pack/program-dump.ts(131,7)` TS2532, **and one more — finding F** | `typecheck.log`, `typecheck-without-review-probes.log` | `repair2/typecheck.log` does **not** contain it (stale) |

The author's pre-repair reproduction is honest: `repair2/followup-probes-before.json`
fails on **exactly the same 11 named checks** as my r3 receipt
`unit01-review-followup/followup-probes.json` (set equality verified
programmatically). The falsification receipt is real too:
`repair2/author-witnesses-falsified.json` fails 14 of 22 on the pre-repair
source, and the 8 that pass are precisely the controls that were already at
parity (`NOT: []`, `AND: []`, `OR: []`, `AND: [{}, x]`, `NOT: [{NOT: [{}]}]`,
empty `where`, the non-empty-arm control, the caller-spelled-`nulls` falsifier).

---

## Status of the follow-up findings

| # | r3 follow-up finding | Status |
| --- | --- | --- |
| A | Finding 1 disputed by the author, dispute upheld | Closed at r3; `order-oracle.test.ts` still green. |
| B | (must-fix) Empty logical arm differs in `NOT` and `OR` | **RESOLVED.** |
| C | (must-fix) Negative `take` flips a distance term's placement | **RESOLVED.** |
| D | (must-fix) Vector distance path loses one refusal and rewords three | **RESOLVED.** |
| E | (note) Two claim overstatements | **CORRECTED**, in place, with an r4 marker. |
| — | **F (new, must-fix)** | New whole-estate typecheck diagnostic + stale receipt. |
| — | **G (new, note)** | `32-line` vs `35-line` deletion, two numbers for one fact. |
| — | **H (new, must-fix)** | The cursor refusal is reworded (`relation and distance` vs `relation and vector-distance`). |
| — | **I (new, must-fix)** | The JSON sentinel-with-path refusal is reworded and drops the field and sentinel it names. |
| — | **J (new, blocking)** | The decimal field-reference domain refusal is **absent**; the candidate silently answers instead. |

### B — resolved, and it holds under composition, recursion and scope

`states()` (`shared/query.ts:227-229`) is the single reading; `combine(key, arms)`
(`:778-793`) is the single assembler, and **grep confirms exactly two call sites**:
`prepareWhere` (`:807`) and `prepareHaving` (`:2919`). `states` is referenced
only at `:782` (`arms.filter(states)`) and recursively at `:228`. `VACUOUS_FALSE`
(`:231-234`) has one producing site (`:785`) and gives the `"always"` kind its
one producer and one lowering branch (`:1163`).

I checked the rule against the shipped source rather than the note:
`buildLogicalAnd`/`buildLogicalNot` return `undefined` when nothing survives and
`buildLogicalOr` returns `ctx.adapter.literals.false()`
(`builders/where-builder.ts:217-305`); `buildHavingLogicalOr` does the same and
says so in its own comment (`operations/groupby-having.ts:110-131`). `combine`
implements exactly that. I also checked the vacuous-case arithmetic that makes
the *old* shapes still agree: `createLogicalOperators`
(`adapters/shared/standard-sql.ts:383-394`) already answers TRUE for a
zero-argument `and` and FALSE for a zero-argument `or`, so `AND: []` and
`OR: []` were never the bug and are not changed by the repair.

Verified green, all differential against the shipped client on the same SQLite
data:

- my r3 `empty-arm.test.ts` — **12/12** (was 6/12);
- `combinator-depth.test.ts` (24 checks): 19 composition forms — `NOT: [{OR: []}]`,
  `AND: [{OR: []}]`, `OR: [{AND: []}]`, `OR: [{NOT: {}}]`, `NOT: {NOT: {}}`,
  three empty `AND`s deep, an empty `AND` beside a vacuous `OR` **in one object**
  (the one place a non-stating arm is *not* filtered, because it survives the
  implicit-AND), `OR` of two empty arms, `NOT` of two empty arms, a vacuous `OR`
  beside a real key, `NOT: [{OR: [{}, x]}]` — plus 9 relation-scope forms
  (`some`/`every`/`none` holding an empty arm, a `NOT` around a `some`), 4
  to-one forms (`is`/`isNot`/bare), 3 nested-read `where` forms, `findFirst` /
  `count` / `aggregate`, and 5 grouped `having` forms at depth;
- `characterize.test.ts` (10 checks): **absolute** pins, so the parity
  assertions cannot pass vacuously — `NOT: [{OR: []}]` → all four rows on both
  engines, `OR: [{AND: []}]` → `[]` on both, `AND: [{OR: []}]` → `[]`,
  `NOT: {NOT: {}}` → all four, `OR: [{}, {}]` → `[]`, `AND: []` beside a real
  key → `[1,3]`, `OR: [{NOT: []}, {bucket:"y"}]` → `[2]`;
- `selector-facts.test.ts` (5 checks): `prepareWhere` sets `facts.exact = false`
  for `OR`/`NOT` *before* `combine` decides whether any arm survives, so a
  dropped arm still marks the selector inexact. I probed whether that is
  observable — `findUnique`, `findUniqueOrThrow`, `findFirstOrThrow`, a cursor
  window with `take: ±2` and `skip`, `distinct`, and a nested negative window —
  all at parity. **Not a defect.**

`OR` as a non-array is unreachable: the admission schema types it
`v.array(whereSchema)` (`validation/model/core/where.ts:69`,
`validation/model/args/aggregate.ts:682`), so the shipped
`Logical OR requires an array value.` refusal and the candidate's tolerant
`entries()` reading never meet an input that separates them.

### C — resolved, and the rule is the right one

`OrderTerm.expressionNulls` (`:252`) has exactly **one producer** — the
point-distance sort key, `sortKey(..., point ? true : undefined)` at `:1646-1653`
(grep confirms no other `sortKey` call passes a sixth argument) — and exactly
**one consumer**, `reverseOrder` (`:1738`). A vector distance term states no
placement at all, matching `sort-order-builder.ts:47-52`.

I re-derived the shipped behavior rather than trusting the citation:
`reverseFallbackSortValue` recurses into `{_distance: {…}}` and rewrites only
the inner `sort` (`operations/find-pagination.ts:131-152`), after which
`buildDistanceOrder` re-emits `nullsLast(distance, "desc")` for a point field
(`builders/sort-order-builder.ts:36-45`). Admission also forbids a caller from
spelling `nulls` beside `_distance` (`pointDistanceOrderSchema`,
`validation/model/core/orderby.ts:66-80`), so `expressionNulls` can never
collide with a caller's placement on the same term.

Verified green (`distance-depth.test.ts`, 13 checks; `distance-pins.test.ts`,
4 checks), lowering-vs-lowering on one PostgreSQL adapter because no provider
here has the tier:

- 24 mixed-order shapes — a distance term beside `{id: asc}`, `{id: desc}`,
  `{rank: {sort, nulls}}` — across both distance directions and `take` of
  `undefined`/`3`/`-3`: placements agree on every one;
- **absolute pin**: `[{at:{_distance:{to,sort:"asc"}}}, {id:"asc"}]` with
  `take: -3` emits `["DESC NULLS LAST", "DESC"]` on **both** engines (and
  `["ASC NULLS LAST", "ASC"]` unreversed) — the expression keeps its placement
  while the scalar key flips bare;
- two distance terms in one order, reversed and not;
- a **non-nullable** point column (the term is `nullable` because the
  *expression* can be null, not the column — matching the shipped
  unconditional `nullsLast`);
- a vector distance order in both directions with `take` ±2 (no placement on
  either engine);
- skip-only (no window, no invented placement);
- a cursor beside a distance order: both engines refuse, and the candidate's
  refusal is its own registered `Cursor pagination supports direct scalar sort
  directions only…` — `page()` never reaches `totalOrder` with a distance term
  because that term has no `field`.

### D — resolved as it was scoped, including the check *order*

`distanceExpression`'s vector branch (`:1433-1466`) is now, in order: nullable
`select` refusal → pgvector capability → dimension mismatch. That is the shipped
order and the shipped wording, compared line-for-line against
`builders/distance-builder.ts:141-186`. `geoPoint(usage)` (`:474-483`) answers
`GeoPoint requires a provider with its physical point tier enabled.`

Verified green:

- the nullable-vector `select` refusal on a provider **with** pgvector and
  **without** it — identical message on both engines in both tiers;
- the same refusal when the operand *also* has the wrong dimension: both engines
  answer the nullable-vector sentence, so the **ordering** of the two checks is
  pinned, not just their presence;
- a nullable vector in `orderBy` is **not** refused on either engine (the
  shipped check is `usage === "select"` only) — the candidate does not
  over-refuse;
- an undeclared-dimension vector (`s.vector()` with no `.dimension()`) with
  operands of length 2 and 4 agrees on both engines (no mismatch to raise);
- the dimension refusal in `orderBy` with the exact sentence
  `Vector distance orderBy dimension mismatch for 'embedding': expected 3 values, received 1.`;
- **absolute pins** of both pgvector sentences, and of
  `GeoPoint requires a provider with its physical point tier enabled.` for
  **six** usages on a PostGIS-less adapter: `orderBy`, `select`, `equals`,
  `within`, `projection` and the `distance` filter.

What D did **not** do is generalize: the four distance refusals it named are
restored, but the unit's other registered refusals were not swept. Three of them
are still wrong — findings H, I and J.

The metric/`to` refusals the shipped engine also carries
(`requires an object.`, `'to' to be an array of finite numbers.`,
`metric must be 'l2' or 'cosine'.`) are genuinely admission-owned: `to` and
`metric` are `atLeast`/`partial: false` required keys and `metric` is
`v.enum(["l2","cosine"])` (`orderby.ts:26-40`, `select.ts:179-190`), so the
candidate's `metric === "cosine" ? "cosine" : "l2"` reading cannot be reached by
an admitted input. The author's claim that dimension is the one refusal
admission does not own is correct.

### E — corrected

`repairs.test.ts` has 13 `it` blocks; a per-block scan (not a bare `grep -c`)
gives **10** that call `differential()` and **1** that calls
`world.client.place.findMany` — 11 differential, 2 candidate-only. `note.md`
now says 13/11 and the "Two author expectations" sentence is corrected in place
to one expectation, one `it`, one file, with an explicit `*(Corrected at r4 …)*`
marker. Both corrections are accurate.

*(Small nit, not a finding: the cell's stated recipe — `grep -c "  it("` and
`grep -c "differential("` — yields 13 and 15, not 11. The prose derivation
beside it is the correct one.)*

---

## New findings

### F. (must-fix) A new whole-estate typecheck diagnostic, behind a stale receipt

`tests/raptor3/g4/unit01/world.ts:188`.

```
tests/raptor3/g4/unit01/world.ts(188,7): error TS2345:
  Argument of type 'string' is not assignable to parameter of type 'Operations'.
```

`differential()` was moved into `world.ts` at r4 (the note says so). Its
`operation: string` parameter is handed straight to
`candidateWorld.engine.execute(model, operation, args)`, whose second parameter
is `Operations` (`raptor3/commands/index.ts:76-80`). My own follow-up world
already solves the same problem the right way
(`operation as Parameters<typeof world.candidate.execute>[1]`).

Reproduction: `node scripts/run-typecheck.mjs` in `/private/tmp/viborm-g4-unit01`
→ `unit01-review-followup2/typecheck.log`. **It is not mine:** I moved my own
probe directory out of the tree and re-ran — the diagnostic is still there
(`typecheck-without-review-probes.log`).

Why it survived the author's pass — the receipt is stale, and provably:

| File | mtime |
| --- | --- |
| `repair2/typecheck.log` | 01:31:11 |
| `tests/raptor3/g4/unit01/world.ts` | 01:32:40 |
| `tests/raptor3/g4/unit01/repair2.test.ts` | 01:33:37 |

So the r4 typecheck ran **before** the two harness files it was meant to cover.
`common.md` permits only the two Pattern `TS2345` diagnostics and requires any
other to be fixed or reported; the repair record instead states *"Clean apart
from the three known diagnostics… Nothing else."*, which is not true of the
delivered identity. This is the third time this unit has been asked to align a
claim with its receipts (r1 finding 7, r3 finding E), which is why it is
must-fix rather than a note, even though it touches no production code.

*(Related but benign: `src/query-engine/raptor3/shared/query.ts` also has an
mtime of 01:34:18, after the 01:31 typecheck. That one is an artifact of the
falsification protocol — the file was restored from the scratchpad copy after
the pre-repair run — and the identity captured at 01:39 plus my own full re-run
of every suite on the current bytes settles it. No finding.)*

**Minimal remaining change — the whole of it:**

1. In `tests/raptor3/g4/unit01/world.ts`, type `differential`'s `operation`
   parameter as the engine's own operation type (import `Operations` from
   `@client/types`, or cast at the call site exactly as
   `tests/raptor3/g4/review/unit01-followup/world.ts:97-101` does). One line.
2. Re-run `node scripts/run-typecheck.mjs` **after** that edit and replace
   `repair2/typecheck.log` (keeping the stale one, relabeled as superseded, not
   deleted), and correct the record's "nothing else" sentence to name the run it
   is based on.
3. Re-capture `repair2/identity.json` after the edit (the harness hash moves).

No production edit, no re-run of any other suite, no new witness. Nothing else
is open.

### G. (note) Two numbers for one fact in the r4 record

The repair summary says the cost is "+15 code-bearing lines net of a **32**-line
deletion"; `note.md` §7 q4 says "net of a **35**-line deletion". One of the two
is wrong. I cannot adjudicate it — the r3 source is not preserved anywhere I can
reach, so the added/removed split is **unverifiable**; only the net is
checkable, and the net reproduces exactly (below). Pick one number, or state the
split as unverified.

---

### H. (must-fix) The cursor refusal is reworded

`src/query-engine/raptor3/shared/query.ts:1771-1774` (`page()`).

| engine | message |
| --- | --- |
| shipped (`operations/cursor-order.ts:55-59`) | `Cursor pagination supports direct scalar sort directions only; relation and **vector-distance** orderBy are not supported.` |
| candidate | `Cursor pagination supports direct scalar sort directions only; relation and **distance** orderBy are not supported.` |

Same error class (`QueryEngineError`), one word apart. This is reachable on
**SQLite with no provider tier at all** — any non-scalar order beside a cursor
reaches it.

Probe: `tests/raptor3/g4/review/unit01-followup2/cursor-refusal.test.ts`
(2 checks, both failing, both differential over the same SQLite data):
`findMany({ orderBy: { <to-one>: { label: "asc" } }, cursor, take: 2 })` and
the same with a collection `_count` order. Receipt: `cursor-refusal.json`.

Resolution: copy the shipped sentence. One string.

### I. (must-fix) The JSON sentinel-with-path refusal is reworded and loses its subject

`src/query-engine/raptor3/shared/query.ts:1381-1385`.

| engine | message |
| --- | --- |
| shipped (`builders/json-filter-builder.ts:307-311`) | `JSON filter for field 'profile' cannot combine 'path' with the DbNull sentinel: the sentinels distinguish the database NULL from the JSON null value of the WHOLE column. Use 'path' with 'equals: null' to test for a JSON null at that path.` |
| candidate | `A JSON null sentinel describes the column, not the value at a path; use 'path' with 'equals: null'.` |

The candidate's sentence says the same thing but names neither the field nor
which sentinel was used, which is what makes the shipped message actionable when
several JSON columns are in one filter. Reachable on SQLite.

Probe: `tests/raptor3/g4/review/unit01-followup2/json-sentinel.test.ts`
(3 checks, 2 failing — `DbNull` and `JsonNull`; the third, `path` with a plain
`equals: null`, agrees). Receipt: `json-sentinel.json`.

Resolution: copy the shipped sentence, including `${field}` and the sentinel
kind. One template string.

### J. (blocking) A registered refusal is missing, and the candidate silently answers instead

`src/query-engine/raptor3/shared/query.ts:975-995` (the field-reference operand
path in `prepareScalarPredicate`).

The shipped `where` builder refuses a field reference between two decimal
columns whose declared `(precision, scale)` differ, because the stored
coefficients are not comparable — `assertComparableDecimalDomains`,
`builders/where-builder.ts:417,436-455`. The candidate has **no equivalent**:
`grep -n "comparable\|same declared\|decimal domain"` over `raptor3/` matches
nothing. It emits a plain column comparison, so two values that ARE equal as
decimals answer "not equal" as stored text.

Probe: `tests/raptor3/g4/review/unit01-followup2/decimal-fieldref.test.ts`
(2 checks, 1 failing), differential over the same SQLite data. Model:
`cents decimal(12,2)`, `micros decimal(12,4)`, `alsoCents decimal(12,2)`; row 1
holds `1.20`, `1.2000`, `1.20` — each written at its own declared scale, which
is what the storage codec produces.

| input | candidate | shipped |
| --- | --- | --- |
| `where: { cents: { equals: fields.alsoCents } }` (same domain) | `[{id:1}]` | `[{id:1}]` — agree |
| `where: { cents: { equals: fields.micros } }` (different domain) | **`[]`** | refuses: `Field reference 'micros' cannot be compared with 'cents' on 'ledger': 'cents' is decimal(12,2) and 'micros' is decimal(12,4). Two decimals compare exactly only when they declare the same precision and scale.` |

`1.20` and `1.2000` are the same decimal, so `[]` is not merely a different
spelling of the refusal — it is a wrong answer, silently, on every provider.
That is the standard r1 used to call the null-placement and dropped-projection
findings blocking, so this one is blocking too.

Resolution: raise the shipped refusal in the one owner that already reads the
reference payload, with the shipped sentence. The fact needed — both columns'
declared precision and scale — is already on `physicalField(...).scalar["~"].state`
at that point, so this is one comparison and one throw, not a new mechanism and
not a new decision. Receipt: `decimal-fieldref.json`.

*(Scope note: H, I and J are all pre-existing r2 code, not repair-2
regressions. They are here because finding D established that this unit owns the
registered refusals in the functions it holds, and a sweep of the unit's whole
message vocabulary against the shipped engine turns up exactly these three and
nothing else. I checked every other contract-looking message in `query.ts`:
`Distance select supports only one _distance field per select.`,
`Paginated scalar ordering requires a primary model identifier.`,
`Cursor field '<f>' cannot be null. Cursor must point to a specific record.`,
`GeoPoint polygon filtering is not supported by this provider.`, the two
`Decimal field/list … exact decimal` sentences and the two `Field reference …`
sentences all match the shipped text **exactly**. The
`JSON filter '<op>' requires a number or string operand.` sentence drops the
shipped `for field '<name>'`, but admission types `lt`/`lte`/`gt`/`gte` as
`v.union([v.number(), v.string()])` (`validation/scalars/json.ts:126,133-136`),
so neither engine can reach it — unreachable, like the vector `"filter"` arm the
author already recorded. Not a finding.)*

## §7 decision-elimination gate, re-answered against the twice-repaired diff

**1. Necessary decision or representation repair?** Repair. The added
representation is exactly one predicate reading (`states`), one constant
(`VACUOUS_FALSE`), one assembler (`combine`) and one optional term field
(`expressionNulls`) — each with one producer and one consumer, each verified by
grep. `"always"` gains the single producer it lacked, which is the same defect
r1 finding 6 charged against the producerless `"aggregate"` projection field, so
the repair closes that class rather than reopening it. No second interpreter,
context or scope class, no per-verb codec, no policy-boolean bag, no JavaScript
arithmetic beside SQL, no cached absence, no fixture-named flag. `query.ts`
imports nothing from the shipped compiler, builders, operations or result engine
(checked: only `@adapters`, `@errors`, `@schema`, `@sql`, `@validation/primitives`
and two sibling modules), and there is no fallback.

**2. Did the named mechanism disappear, and does the replacing invariant have a
falsifier?** Yes. The two duplicated combinator assemblies are gone —
`grep -n 'kind: "not"'` matches the union member (`:204`), `combine` (`:791`) and
two different constructs (the scalar `not` operator `:914`, the relation `isNot`
quantifier `:1078`), exactly as the note claims. All r2 and r3 deletions remain
gone. Falsifiers 16–18 in the handoff are correctly stated and are what my
probes assert; the measured falsification (14/22 fail on the pre-repair source)
is real.

**3. Is each rule stated once and used by every consumer?** The three new rules
are. The rule *"a registered refusal is a contract"* is not: it is honored in
`distanceExpression` and `geoPoint` (where the review pointed) and broken in
three other owners of the same file (H, I, J). That is a scoping failure of the
repair, not of the design — every one of the three is a string or a throw in a
function the unit already holds. The three standing "no"s are unchanged and still recorded rather than
hidden: output-shape assembly has three sites outside `prepareProjection`;
`program/index.ts` is a second read entry (§8 blocker 2); and the empty-arm "no"
the follow-up added is the one this repair closes. One observation, not a
finding: the polymorphic slot-presence branch (`:1035-1050`) builds a bare
`{kind: "or"}` without going through `combine`. It is a different rule
(slot presence, not a public combinator key) and its vacuous case still lowers to
FALSE through the adapter, so the two agree — but it is the one place where "a
disjunction of nothing is FALSE" is spelled twice. Pre-existing; worth a
sentence in the private guide, not a repair.

**4. What grew?** Reproduced exactly (below).

## Cost check

Recomputed independently with the census's own `countTokenLines` walk over
`raptor3/commands` + `raptor3/shared` (receipt: `core-cost-recheck.json`):

| Scope | Author | Recomputed | Match |
| --- | --- | --- | --- |
| Core after r3 | 8,820 / 8,626 / 54,306 / 292,814 | (verified at r3) | — |
| **Core after r4** | **8,861 / 8,641 / 54,426 / 294,985** | **8,861 / 8,641 / 54,426 / 294,985** | **yes, byte for byte** |
| Repair-2 delta (r3 → r4) | +41 / +15 / +120 / +2,171 | same | yes |
| Incremental core (unit total) | +1,864 / +1,714 / +11,043 / +64,588 | same | yes |
| `shared/query.ts` | 3,424 → 3,465 physical | 3,465 | yes |

The patch stat is arithmetically consistent with a deletion of r3-added lines:
r3 was +2242/−419, r4 is +2289/−425, so the "+" column grew by 47 and the "−"
column by 6, netting the +41 physical. Whether the deleted count is 32 or 35
(finding G) is not decidable from here.

## Unverified author claims

| Claim | Status after this review |
| --- | --- |
| PostgreSQL / MySQL lowering is adapter-spelled but not executed | **Still unverified and correctly labeled.** C and D are observable only through the lowering, which is how both the author and I evidenced them. |
| The distance projection's positive path is not executed | Confirmed and correctly labeled (settled at r3). |
| The vector positive path needs pgvector; enum-list provider array text | Still unexecuted, correctly labeled. The vector **refusal** path is executed and now matches. |
| The `"filter"` spelling of `distanceExpression` is unreachable for a vector | **Verified true.** `validation/scalars/vector.ts` admits only `equals` on a vector filter, and the shipped `case "distance"` routes every field through `buildPointDistancePredicate` (`where-builder.ts:710-719`), so neither engine reaches a vector `"filter"`. |
| `states()` must be recursive | **Verified true.** The shallow reading diverges on `NOT: [{AND: [{}]}]`; my `NOT: [{AND: [{OR: []}]}]` probe pins the opposite direction (an inner vacuous FALSE must *survive*). |
| Decimal `having { _sum }` operand domain; no indexable `withinBounds` pre-filter; `assignments.ts:28` blocker | Unchanged from r1/r3, correctly labeled. |
| "typecheck clean apart from the three known diagnostics — nothing else" | **FALSE for the delivered identity.** Finding F. |
| handoff §5 "the registered distance refusals, preserved verbatim from the shipped engine" | **True of the four distance refusals**, verified message-for-message. But the unit's refusal set is larger than those four — findings H, I and J. |
| note §"What this repair did not change": "no error class" | **True.** Every divergence I found is a message or a missing throw, never a different class. |
| "+15 code-bearing net of a 32-line deletion" (summary) vs "35-line" (note) | **Unverifiable and mutually inconsistent.** Finding G. |
| "69/69, 44/44, 44/44, 68/68, 39/39, 16/16, 30/30, 52/52, 1/1, 33/44 before, 8/22 falsified" | **Reproduced in full.** |

## What would make this ACCEPT

The minimal remaining change, in full — four edits, three of them one line, none
of them touching a public contract, an admitted argument, a result shape, an
error class, or any design this unit has settled:

1. **J (blocking).** In the field-reference operand path of
   `prepareScalarPredicate` (`shared/query.ts:975-995`), refuse a reference
   between two decimal columns of different declared `(precision, scale)` with
   the shipped sentence (`builders/where-builder.ts:436-455`). Witness: the two
   rows of `decimal-fieldref.test.ts`.
2. **H (must-fix).** In `page()` (`shared/query.ts:1771-1774`), copy the shipped
   cursor sentence — `relation and vector-distance orderBy are not supported.`
   Witness: `cursor-refusal.test.ts`.
3. **I (must-fix).** At `shared/query.ts:1381-1385`, copy the shipped JSON
   sentinel sentence including the field name and the sentinel kind. Witness:
   the two failing rows of `json-sentinel.test.ts`.
4. **F (must-fix).** One line in `tests/raptor3/g4/unit01/world.ts:170-190` so
   `differential`'s `operation` reaches `execute` as `Operations`; then re-run
   `node scripts/run-typecheck.mjs` **after** the edit, replace the stale
   `repair2/typecheck.log` (keeping it, relabeled as superseded), correct the
   record's "nothing else" sentence, and re-capture the harness identity.

Finding G is a one-word edit to a number.

Nothing else is open. B, C, D and E are closed, and no compatibility decision is
owed to Arnaud from this unit: every one of H, I and J has the shipped engine as
an unambiguous oracle, so none of them is a choice to record — they are parity
repairs of the same kind the author has already made four times.
