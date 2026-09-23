# G4-01 query/projection — independent review of the repair pass

Reviewer: independent (did not author the unit, did not repair anything).
Source reviewed: `/private/tmp/viborm-g4-unit01` (detached at `0cc61e61`, the
repaired change already applied). This document follows
`docs/architecture/raptor3-evidence/g4/unit01-review.md`, which returned
**REVISE** with three blocking and four must-fix findings.

**Outcome: REVISE.**

All seven findings of the first review are resolved or soundly disputed, and
every acknowledgement it asked for is present and honest. The repair is
well-aimed: each fix lives in an owner the unit already held, no public contract
changed, no legacy import or fallback appeared, the deletions are verified gone,
the cost figures reproduce to the byte, and 47 author checks plus 44 corrected
r1 probes plus every registered suite re-run green. One of my own r1 probes was
wrong and the author was right to dispute it; I re-asked the oracle and
corrected my probe.

It is not yet ACCEPT. Four divergences from the shipped engine survive in the
repaired owners, 11 of my 44 new probes fail on them. One of the four is a
regression *created* by the finding-1 repair; one is a gap the unit inherits but
now claims as complete; two are registered refusals whose identity or wording
the candidate does not preserve. Each is a small fix inside a function this unit
already owns; none needs a redesign or a decision from Arnaud.

---

## Identity and reproduction

| Fact | Value |
| --- | --- |
| Production identity reviewed | `407ea035b88d0b2e9de27ebc8adb72b06ae94692735390ad6b50758d0cd0dcc9` — **identical** to the author's `repair/identity.json` |
| Harness identity at review time | `b6cf6157dc2b2f6cdc4be5f51f747f617594040b76985c61171feae48356398d` (differs from the author's `84df3dbd…` because this review added 6 probe files and corrected one r1 probe) |
| `production.patch` vs worktree `git diff -- src` | byte-identical (4 files, +2242 / −419) |
| `author-tests/*` vs `tests/raptor3/g4/unit01/*` | byte-identical (9 files) |
| r2 receipts under `receipts/` | untouched (timestamps 23:17–23:24), not relabeled — evidence discipline respected |
| Runtime | Node v24.21.0, darwin/arm64, better-sqlite3 12.6.0, Vitest 3.1.4 |

Suites re-run serially through `node scripts/run-vitest-safe.mjs run …`:

| Suite set | Result | Review receipt | Author receipt |
| --- | --- | --- | --- |
| `tests/raptor3/g4/unit01` (34 original + 13 repair witnesses) | **47/47 pass** (4.46 s, 708.5 MiB) | `author-tests-rerun.json` | `repair/author-tests.json` (47) — reproduced |
| `tests/raptor3/g4/review/unit01/` (my r1 probes, as the author received them) | **43/44 pass**, the single failure being my own stale expectation (finding A below) | `review-probes.json` | `repair/review-probes.json` (43/44) — reproduced exactly, same single failure |
| `tests/raptor3/g4/review/unit01/` after correcting that expectation | **44/44 pass** (4.44 s, 736.8 MiB) | `review-probes-corrected.json` | — |
| `candidate-handoff`, `candidate-ordering`, `candidate-pagination`, `candidate`, `cleanup-failure` | **68/68 pass** (4.60 s, 777.2 MiB) | `registered-candidate-suites.json` | `repair/registered-candidate-suites.json` (68) — reproduced |
| `post-prep/{clearability-consumption,history-analysis,projection-preparation,schema-view-reuse,selector-preparation}` + `prep/{recursive-read-fit,selector-dependencies,variant-collection-order}` | **39/39 pass** (4.94 s, 748.9 MiB) | `registered-prep-suites.json` | `repair/registered-prep-suites.json` (39) — reproduced |
| `prep/{g3p04-review-regressions,set-preparation,suppression-replay}` | **16/16 pass** (4.33 s, 602.7 MiB) | `write-regressions-prep.json` | `repair/write-regressions-prep.json` (16) — reproduced |
| `post-prep/g29-*` minus the PGlite file | **30/30 pass** (4.57 s, 675.9 MiB) | `write-regressions-g29.json` | `repair/write-regressions-g29.json` (30) — reproduced |
| `post-prep/g29-result-progress-pglite.test.ts` (alone; it blows the 1,536 MiB ceiling when batched) | **1/1 pass** (4.80 s, 1525.7 MiB) | `g29-pglite.json` | not in the author's batches |
| `ownership`, `polish`, `transitions/junctions-commands`, `transitions/keys-commands` | **52/52 pass** (6.36 s, 736.7 MiB) | `write-regressions-ownership.json` | `repair/write-regressions-ownership.json` (52) — reproduced |
| Whole-estate typecheck | the two permitted `pattern/pack.ts` TS2345 plus the pre-existing committed-tree `tests/pattern/pack/program-dump.ts(131,7)` TS2532 — nothing else | `typecheck.log` | matches `repair/typecheck.log` |
| **New review probes (this pass)** | **44 checks, 33 pass, 11 fail** | `followup-probes.json` | — |

Receipts and probe copies:
`/Users/arnaud/code/viborm/docs/architecture/raptor3-evidence/g4/unit01-review-followup/`.
The probes themselves are kept in the worktree at
`/private/tmp/viborm-g4-unit01/tests/raptor3/g4/review/unit01-followup/`:
`world.ts`, `order-oracle.test.ts`, `nested-reversal.test.ts`,
`operand-and-logic.test.ts`, `empty-arm.test.ts`, `distance-parity.test.ts`.
Every one of them asks the SAME public arguments of the shipped client and of
the candidate over identical data (or, where no provider can execute, compares
the two lowerings on one PostgreSQL adapter).

---

## Status of the first review's findings

| # | r1 finding | Status |
| --- | --- | --- |
| 1 | (blocking) Unqualified `orderBy` silently changes where NULLs land | **RESOLVED — by parity, and the author's dispute of my probe is upheld.** See A below. |
| 2 | (blocking) A negative nested `take` returns the window in reverse order | **RESOLVED.** |
| 3 | (blocking) A distance projection is silently dropped and its refusal is lost | **RESOLVED for the point/select path.** Partially open on the vector path — findings C and D below. |
| 4 | (must-fix) `equals` on a blob throws for a `Uint8Array` | **RESOLVED.** |
| 5 | (must-fix) `where: { NOT: [c1, c2] }` throws | **RESOLVED for non-empty arms.** The empty arm is finding B below. |
| 6 | (must-fix) An added representation with no producer | **RESOLVED.** |
| 7 | (must-fix) Handoff and note claims the diff does not support | **RESOLVED.** |
| 8–11 | (notes) | **Acknowledged** as asked; see the closing section. |

### A. Finding 1 — resolved, and my own probe was the thing that was wrong

The author disputed one of my r1 probes rather than repairing it, and the
dispute is correct. I re-asked the oracle directly instead of trusting either
revision of the candidate:
`tests/raptor3/g4/review/unit01-followup/order-oracle.test.ts` ::
*"settles the disputed bare relation-path order against the shipped engine"*.
Over five rows, two with an absent to-one relation,
`findMany({ orderBy: { team: { label: "asc" } } })` answers `[2,4,3,1,5]` on the
shipped client and `[2,4,3,1,5]` on the candidate — NULLs **first**, SQLite's own
bare placement. `"desc"` answers `[5,1,3,2,4]` on both.

My r1 `order-cursor.test.ts` :: *"orders by a to-one relation path when the
relation is absent"* asserted NULLs last, which was the pre-repair candidate's
own answer and directly contradicted my own `shipped-parity.test.ts`. I have
corrected that expectation in place, with a comment naming the oracle probe
(copy: `unit01-review-followup/probes/order-cursor.corrected.test.ts`). The
pre-correction run is preserved as `review-probes.json` (43/44) so the record
shows what the author actually received.

The repair itself is the shipped split, verified against the shipped source and
then differentially: `normalizeCursorOrder` returns `undefined` when there is
neither a cursor nor a `take` (`operations/cursor-order.ts:47-50`), so an
unwindowed read reaches `buildSingleOrder` and emits the bare direction; the
candidate's `page()` computes `totalOrder` only when
`windowed && requested.every(term => term.field !== undefined)`
(`shared/query.ts:1709-1718`), which is the same condition, and `totalOrder` is
the only site that invents `asc → last` / `desc → first`
(`:1750-1759`, matching `defaultNullPlacement` and `appendTieBreakers`).
Nine differential shapes agree: unwindowed asc/desc, skip-only, `take`,
negative `take`, `cursor`, `findFirst`/`findFirstOrThrow`, spelled `nulls`
windowed and unwindowed, two-key orders, nested to-many with and without a
window, collection `_count`, grouped with and without `take`, `aggregate` and
`count` windows. No compatibility decision is owed to Arnaud.

### Findings 2, 4, 5, 6 — resolved, and they hold under wider attack

- **2.** `relationShape` (`:2603-2611`) is the single owner and is called from
  the ordinary relation site (`:2589`) and the variant-arm site (`:2565`);
  `decodeValue`'s collection branch reverses a freshly mapped array (`:3049`),
  so no caller's array is aliased. `nested-reversal.test.ts` (5 checks, all
  green, all differential) covers `select` and `include`, `take: -2` combined
  with `skip`, with `distinct` and with a `cursor`, `take: -1`, a window larger
  than the rows, a to-one relation that must NOT be reversed, and a negative
  window inside a **to-many variant arm through a junction** — the site the
  author claimed shares the owner. It does.
- **4.** `addressesOperators` (`:309-315`) applies `isOperatorRecord` first.
  `operand-and-logic.test.ts` (4 green checks) adds `in`/`notIn` lists holding a
  `Uint8Array`, a Node `Buffer` (a `Uint8Array` subclass), a blob operand inside
  `some`, inside `NOT`, and two relation scopes deep, and `null` / `not: null`
  — all at parity.
- **5.** `prepareWhere`'s `NOT` arm reads `entries(operand)` (`:770-783`), the
  same reading `prepareHaving` gives it. Verified at parity inside `some`,
  inside `every`, inside a nested read's own `where`, over a relation arm, and
  in `having`. The empty arm is the exception — finding B.
- **6.** `grep -n '"aggregate"' src/query-engine/raptor3/shared/query.ts` now
  matches only `PreparedTarget` (`:195`), the `read()` verb case (`:2050`) and
  `prepareHaving`'s target construction (`:2903`) — no projection-field member
  and no empty-JSON lowering branch. `grep -rn '"float"' src/query-engine/raptor3/`
  matches nothing, and `decodeScalar`'s `"number"` arm (`:3118`) is the one
  numeric spelling; `s.number()` columns, `_avg` leaves and the new distance
  leaf all decode through it (`codec-roundtrip.test.ts`,
  `having-projection.test.ts`, `decode-strictness.test.ts` all green).

### Finding 7 — resolved

`handoff.md` is at revision 3. All four misstatements are corrected and the
corrections are accurate against the diff: §5 now states the bare-direction rule
with the per-dialect defaults and the exact two cases that emit a placement;
§5 describes the distance projection that now exists; §6 describes the shape
that carries the reversal; §7 says plainly that carrier-level failures are
**not** on the translated path, that only the `_count` case degenerates to a
translated identity, and that none of the three has an executed witness.
Falsifiers 11–15 are present and correctly stated. `note.md` §7 q2 now says
"three shape-assembly sites, one leaf classifier", and §8 records the
null-placement item as resolved-by-parity rather than as a decision request.

---

## New findings

### B. (must-fix) An empty logical arm answers differently in `NOT` and `OR`

`src/query-engine/raptor3/shared/query.ts:756-785` (`prepareWhere`'s `AND`/`OR`
and `NOT` arms) and `:2867-2890` (`prepareHaving`'s `NOT` arm).

The shipped engine treats an arm that builds no condition as *absent*:
`buildLogicalNot` pushes a negation only `if (condition)` and returns `undefined`
when none survives (`builders/where-builder.ts:291-308`), and the AND/OR builders
do the same. The candidate turns an empty arm into an empty `and` predicate,
which lowers to TRUE — so `NOT {}` becomes FALSE and `OR [{}, x]` becomes TRUE.
Six admitted inputs answer differently; the `OR` case silently **over-fetches**,
which is the shape that leaks rows when a caller assembles an authorization
filter dynamically.

Probe: `tests/raptor3/g4/review/unit01-followup/empty-arm.test.ts` (differential,
same SQLite data, 12 forms):

| input | candidate | shipped |
| --- | --- | --- |
| `where: { NOT: {} }` | `[]` | `[1,2,3]` |
| `where: { NOT: [{}] }` | `[]` | `[1,2,3]` |
| `where: { NOT: [{}, { bucket: "y" }] }` | `[]` | `[1,3]` |
| `where: { NOT: [{ bucket: "y" }, {}] }` | `[]` | `[1,3]` |
| `where: { OR: [{}, { bucket: "y" }] }` | `[1,2,3]` | `[2]` |
| `having: { NOT: {} }` | `[]` | both groups |

`{ NOT: [] }`, `{ AND: [] }`, `{ OR: [] }`, `{ AND: [{}, x] }`, `{ NOT: [{ NOT: [{}] }] }`
and `where: {}` all agree.

The `OR` and object-`NOT` shapes are **inherited**: the AND/OR arm is unchanged
from `0cc61e61` (`git show 0cc61e61:…/query.ts:464-486`), so this unit did not
introduce them. But this unit is what makes the whole read envelope executable
and it claims row Q-W01 ("recursive AND/OR/NOT") complete, and the finding-5
repair newly *reaches* the array form with an empty arm. The author's own
witness set covers `{ NOT: [] }` and nested `NOT` but no empty arm.

Resolution: give `prepareWhere`/`prepareHaving` the shipped rule once — an arm
whose prepared predicate carries no operation contributes nothing to `NOT` and
nothing to `OR` (the `always` predicate kind already exists for exactly this).
Add the six rows above as a witness; they are cheap and differential.

### C. (must-fix) A negative `take` flips a distance term's stated placement

`src/query-engine/raptor3/shared/query.ts:1677-1690` (`reverseOrder`) with
`:1596-1604` (the distance sort key).

The finding-1 repair changed `reverseOrder` to flip a *stated* `nulls`. That is
right for a scalar key, and the handoff states it as the rule (§5: "reverses the
direction of every term, and the placement of every term that states one"). The
GeoPoint distance term is the one term that states a placement unconditionally
(`nulls: "last"` in both directions, matching `builders/sort-order-builder.ts:39,42`),
and the shipped engine keeps it `NULLS LAST` when the window is reversed:
`reverseFallbackOrder` rewrites only the raw `sort` (`operations/find-pagination.ts:131-151`)
and `buildDistanceOrder` then re-emits `nullsLast(distance, "desc")`.

Probe: `distance-parity.test.ts` :: *"reverses a point distance ORDER the way the
shipped engine reverses it"* — for
`{ orderBy: { at: { _distance: { to, sort: "asc" } } }, take: -2 }` on
PostgreSQL+PostGIS the shipped statement orders `DESC NULLS LAST` and the
candidate orders `DESC NULLS FIRST`. That is not a cosmetic difference: `LIMIT 2`
over the reversed order then selects rows with a NULL location instead of the two
nearest ones. No provider here can execute it, so the evidence is the two
lowerings on one adapter; the divergence is provider-independent.

Resolution: keep the distance term's placement fixed under reversal (it is not a
caller-spelled placement but a property of the expression), or mark it so
`reverseOrder` leaves it alone. One flag or one branch.

### D. (must-fix) The vector distance path loses a registered refusal and rewords two

`src/query-engine/raptor3/shared/query.ts:1403-1420` (`distanceExpression`,
vector branch) and `:452-461` (`geoPoint`).

`common.md` makes refusals contracts. Four refusal comparisons fail
(`distance-parity.test.ts`, shipped lowering vs candidate lowering on the same
adapter):

1. **Missing identity.** `select: { <nullable vector>: { _distance: { to, metric } } }`
   — shipped raises `Vector distance select does not support nullable vector
   field 'maybeEmbedding'.` *before* the capability check
   (`builders/distance-builder.ts:150-154`), so it refuses on every provider. The
   candidate has no such check: on this adapter it answers the pgvector
   capability error instead, and on a pgvector provider it would answer a
   distance and then fail the decode, because `distanceLeaf` (`:2613-2620`) makes
   a vector distance non-nullable. This is a registered refusal the unit does not
   preserve.
2. **Reworded.** vector `select`: candidate `vector distance requires a provider
   with vector support`, shipped `vector distance select requires a
   pgvector-enabled PostgreSQL driver`.
3. **Reworded.** vector `orderBy`: candidate `vector distance requires a provider
   with vector support`, shipped `vector ordering requires a pgvector-enabled
   PostgreSQL driver`.
4. **Reworded.** point distance on a provider with no point tier at all
   (PostgreSQL without PostGIS): candidate `GeoPoint is not supported by this
   provider.`, shipped `GeoPoint requires a provider with its physical point tier
   enabled.` (`requireGeoPointSql`). The coordinate-tier case the author pinned
   (`GeoPoint distance is not supported by this provider.`) does match.

In 2–4 the error class, `feature` and `method` match and only the detail sentence
differs; in 1 the refusal is genuinely absent. 2–4 are inherited from r2 (the
`geoPoint` helper and the vector branch are r2 code), but 1 becomes reachable
only because the finding-3 repair routed `"select"` through this owner.

Resolution: copy the three shipped sentences, and add the nullable-vector
select check to the one owner. The shipped dimension-mismatch refusal
(`Vector distance <usage> dimension mismatch for '<field>': expected N, received M.`)
is admitted input too — `v.array(v.number())` does not constrain length — and has
no candidate equivalent; worth the same pass.

### E. (note) Two small claim overstatements in the repair record

- The repair summary says "13 new author witnesses, 12 of them DIFFERENTIAL".
  `repairs.test.ts` has 13 `it(...)` blocks; 11 compare against the shipped
  engine (10 through `differential()`, 1 through `world.client.place.findMany`).
  The two-`_distance` refusal and the PostGIS lowering witness are candidate-only,
  which the note itself describes correctly — the count is just one high.
- `note.md` (repair section, "Two author expectations were corrected rather than
  the code") names one test in one file, and only one author test file changed
  (`order-projection.test.ts`, one corrected expectation at line 34). Either the
  sentence or the count is stale.

Neither affects a claim about the source; recorded for evidence integrity only.

---

## §7 decision-elimination gate, re-answered against the repaired diff

**1. Is every added rule a necessary decision or a representation repair?** Yes,
more so than at r2. The repair *removes* two representations (the producerless
`"aggregate"` projection field with its silently-wrong empty-JSON lowering, and
the `"float"` decode alias) and the one it adds, the `"distance"` projection
field, has exactly one producer (`:2517-2531`) and one lowering branch
(`:2702-2709`) — verified by grep. The default-null-placement rule that r1 called
a compatibility change is gone: the unspelled case now emits the provider's own
default and only `totalOrder` states a placement. No second interpreter, context
or scope class, no per-verb codec, no policy-boolean bag, no JavaScript
arithmetic beside SQL, no cached absence, no fixture-named flag, no legacy import
and no fallback — re-checked against the current diff.

**2. Did the named mechanism disappear, and does the replacing invariant have a
falsifier?** All five r2 deletions remain gone (`lowerValuePredicate` still
`grep`s to nothing; `isReadOperation` is the only read classification in
`raptor3/`, used by `commands/index.ts:54` and `operation-context.ts:282`). The
new falsifiers 11–15 in the handoff are real and each fails when its invariant
is broken — 11, 12, 13 and 14 are exactly what my probes assert differentially,
and 15 is what `repairs.test.ts` pins on both engines. D1's falsifier is now
fully honored: `where` and `having` read a non-empty `NOT` identically.

**3. Is each rule stated once and used by every consumer?** The two r1 "no"s are
repaired and I verified the sharing, not just the claim: the whole-value rule is
one test used by `prepareOperations` and `updateValue`; `relationShape` is the
one to-many shape owner and the variant arm really does go through it (probed on
a junction). Three "no"s remain, all recorded by the author rather than hidden:
output-shape *assembly* still has three sites outside `prepareProjection`;
`program/index.ts` is still a second read entry; and — new — the empty-arm rule
is stated in the shipped engine once and in the candidate not at all (finding B).

**4. What grew?** Reproduced exactly.

## Cost check

Recomputed with the census's own `countTokenLines` definition over
`raptor3/commands` + `raptor3/shared`, the same scope both receipts use
(receipt: `unit01-review-followup/core-cost-recheck.json`):

| Scope | Author | Recomputed | Match |
| --- | --- | --- | --- |
| Core at `0cc61e61` | 6,997 / 6,927 / 43,383 / 230,397 | — | reproduces `g4.md` lines 15–16 exactly |
| Core after r2 | 8,751 / 8,573 / 53,972 / 290,017 | — | (r1 review reproduced this) |
| **Core after r3** | **8,820 / 8,626 / 54,306 / 292,814** | **8,820 / 8,626 / 54,306 / 292,814** | **yes, byte for byte** |
| Incremental core (unit total) | +1,823 / +1,699 / +10,923 / +62,417 | same | yes |
| Repair-only delta (r2 → r3) | +69 / +53 / +334 / +2,797 | same | yes |

The complete-perimeter claim (13,548 code-bearing, under the 14,000 guidepost)
follows from the untouched retained-owners figure and closes arithmetically, as
at r1. `shared/query.ts` is now 3,424 physical lines in one file — a shape
question for the root, not a rule violation.

## Unverified author claims

| Claim | Status after this review |
| --- | --- |
| PostgreSQL / MySQL lowering is adapter-spelled but not executed | **Still unverified and correctly labeled.** Findings B, C and D are provider-independent; C and D are *only* observable through the lowering, which is how I evidenced them. |
| The distance projection's positive path is not executed | **Confirmed and correctly labeled.** I re-derived the projected-column question from the shipped builder instead of trusting it: `selectPairs` (`builders/projection-select.ts:368-403`) emits the distance only for a field that is NOT in `projection.scalars`, so the shipped engine does not project the point column either — the candidate matches, and it keeps the column when the caller selects it in its own right. Both asserted in `distance-parity.test.ts`. |
| Decimal `having { _sum: … }` operand binds in the field's domain | Unchanged from r1: confirmed unreachable on SQLite, correctly labeled. |
| GeoPoint distance emits no indexable `withinBounds` pre-filter | Unchanged; plan-shape only, correctly labeled. |
| Enum-list provider array text; vector positive path needs pgvector | Still unexecuted and correctly labeled. Finding D shows the vector *refusal* path is executed and diverges. |
| `assignments.ts:28` `"set" in value` blocker | Confirmed still present, still another owner's, still correctly recorded as blocker 1. |
| "One reviewer probe still fails and is not a defect" | **Upheld.** See A. |
| "13 new author witnesses, 12 of them DIFFERENTIAL" | 13 witnesses, **11** differential (finding E). |
| "47/47, 43/44, 68/68, 39/39, 16/16, 30/30, 52/52, typecheck clean apart from the three known diagnostics" | **Reproduced in full.** |

## Findings 8–11 acknowledgements

Satisfactory, and I re-checked each against the source rather than the note:
`program/index.ts:20-50` still names the verbs by hand and still calls
`queries.select` / `queries.grouped`, and the note now records both the requested
change and the behavior change that route inherited (blocker 2); `page()` still
returns a `distinct` that `aggregated` drops, correctly left alone under the
no-redundant-guards rule; `findUnique`'s `rows[0]` is recorded as resting on
RF-03; and `repair/identity.json` was captured after the last source edit, the
last harness edit and the last suite run — its `production` hash is the one I
recomputed.

## What would make this ACCEPT

1. Finding B fixed in `prepareWhere` / `prepareHaving`, with the six differential
   rows as a witness.
2. Finding C fixed in `reverseOrder` (or at the distance sort key), with the
   reversed-lowering comparison as a witness.
3. Finding D: the nullable-vector select refusal added to `distanceExpression`,
   and the three reworded capability sentences restored to the shipped text.
   The dimension-mismatch refusal is worth the same pass.
4. Finding E's two counts corrected in `note.md`.

Nothing else. The unit's design survives the second reading intact; what is left
is four small parity repairs inside functions it already owns.
