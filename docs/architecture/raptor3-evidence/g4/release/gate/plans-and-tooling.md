# plans-and-tooling — gate triage note

Family files (from `plans-and-tooling.files`):
1. `tests/contracts/engine/write/mutation-projection-cte-fold.test.ts` — 16 red cells
2. `tests/contracts/engine/write/progressive-parent-rowkey.test.ts` — 7 red cells
3. `tests/contracts/engine/query/starts-with-prefix-plan.test.ts` — 5 red cells
4. `tests/raptor3/core-structure/measurement/cs02-structure-measure.test.ts` — 1 red cell
5. `tests/unit/instrumentation/namespace-attribute-segment.test.ts` — 1 red cell

Total: **30 red cells**. Method: read `docs/architecture/raptor3-evidence/g4/briefs/common.md`
first (the twelve rules — quoted where load-bearing below). Files 2–5 were each run
live via `TMPDIR=/private/tmp/viborm-triage-plans-tmp node scripts/run-vitest-safe.mjs
--project extended-local <file>` (receipts: `/private/tmp/viborm-triage-plans-tmp/
{progressive-parent-rowkey,starts-with-prefix-plan,cs02-structure-measure,
namespace-attribute-segment}.log`). File 1 (`mutation-projection-cte-fold.test.ts`)
could not be run standalone — see Blockers — so its cells are taken from the
pre-existing tonight's-measurement receipt `scratchpad/gate-inventory/shared-family-1.log`
lines 121–586 (16 failed / 40 tests, byte-identical failure roster to what the brief's
184-cell census counts for this file), cross-read against the file's own source.

## Table

| file | cell | class | one-sentence reason | ruling / registration / engine site |
| --- | --- | --- | --- | --- |
| mutation-projection-cte-fold.test.ts:297 | update+include is ONE statement (CTE) | A | shipped engine never emits the retired `WITH "__viborm_mutation"` CTE fold for a relation-projecting mutation; it takes the multi-statement locate/mutate/re-read route by design | `docs/architecture/raptor3-evidence/g4/unit02/note.md` §4.4 + §12.1 (quoted below) |
| mutation-projection-cte-fold.test.ts:332 | create+include is ONE statement (CTE) | A | same — root `create` with a relation projection is not RETURNING-safe, so it never folds | same as above |
| mutation-projection-cte-fold.test.ts:362 | batch mode folds behind its in-unit presence guard | A | same mechanism, batch-only driver variant (4 statements observed vs 2 expected) | same as above |
| mutation-projection-cte-fold.test.ts:529 (×6: to-many include; to-many+select; to-many+where/orderBy; `_count` explicit relation; scalar+relation select; to-many+cursor) | "the fold answers what the read answers" | A | the **answer** (`expect(answer).toEqual(truth)`) passes every time (not in the failure list); only the boolean plan check `statements.some(sql=>sql.startsWith("WITH ")).toBe(projection.folds)` fails, because `projection.folds` assumes the retired CTE fold applies to any relation projection and the shipped engine never emits it | same as above |
| mutation-projection-cte-fold.test.ts:556 | a create's include folds to the read's answer | A | same mechanism as the six above, `create` arm | same as above |
| mutation-projection-cte-fold.test.ts:730 | "on that same model, an ordinary column still folds" (`include: { pets: true }`) | A | relation projection (`pets`) again fails the RETURNING-safety gate; the created/updated **value** is correct (not asserted here, but consistent with every other cell in this group) | same as above |
| mutation-projection-cte-fold.test.ts:865 | "a model nothing references folds a key rewrite the cascading model declines" (`_count`) | A | `_count` is explicitly named a relation projection by the gate — never RETURNING-safe | `g4/unit02/note.md` §4.4: "`_count` is a relation projection too" |
| mutation-projection-cte-fold.test.ts:903 | Phase 8.2 — root + two children is ONE statement | A | nested-create tree fold (CTE chaining several `__viborm_mutation`/sibling CTEs) is the same retired Phase-8 machinery, never ported; 4 statements observed vs 1 expected | same as §4.4/§12.1, plus `pattern-retirement/retirement.patch:18290-18660` (deletion of `MUTATION_CTE`/sibling-CTE code) |
| mutation-projection-cte-fold.test.ts:948 | a nested createMany rides the same fold | A | same as above | same |
| mutation-projection-cte-fold.test.ts:1100 | ONE arm taking a generated key still folds | A | same Phase-8.2 tree-fold mechanism, never ported | same |
| mutation-projection-cte-fold.test.ts:1247 | a skip-carrying arm on another table still folds | A | same | same |
| progressive-parent-rowkey.test.ts:249-266 | "row liveness and non-PK membership remain separate guard facts" (enclosing-batch search) | A* | first failing assertion searches batch text for `"t0"."code" = $1`; shipped engine's root alias is `q0`, never `t0` — same alias pin as the three cells below. **Caveat:** the test aborts here, so its *second* claim (the guard's `"code"` conjunct, line 273) was not independently exercised — see Unverified, it may also hit the C-class defect below | `src/query-engine/raptor3/shared/query.ts:657-689` (`alias()`/`rootAlias()`) |
| progressive-parent-rowkey.test.ts:276-317 | "a concurrent move of the referenced value fails the member closed" | C | write resolves successfully instead of rejecting with `/parent record changed across a committed segment/`; the spoke lands under whichever hub holds `code:"H1"` at execution time instead of the hub the caller captured — exactly the pre-fix bug the file's own header describes as "the honest before-picture" | `src/query-engine/raptor3/commands/execution.ts:757-788` (`captureSeries`, guard construction `this.identity(parent)` + `this.membershipValues(edge, parent)`, error raised at :771) — guard did not fire for this shape |
| progressive-parent-rowkey.test.ts:320-383 | "a child-held updateMany cannot continue under a replacement owner" | C | same defect, `updateMany` member instead of `createMany` | same site, `execution.ts:757-788` |
| progressive-parent-rowkey.test.ts:385-418 | "a before-root series re-pins the selected row by its captured key" | A (weak) | the returned value and the final DB state are both correct (`expect(await world(c))` is not in the failure list); only `member < rootMove` (batch ordering) fails — `member` and `rootMove` land in the same batch instead of separate ones. No single named ruling found for this exact ordering choice; classified A on "batch segmentation" (an explicitly named Class-A pin type) plus the general G4 rewrite of the progressive-write machinery, but flagged weak — see Unverified | `src/query-engine/raptor3/shared/operation-context.ts` (`committedSegments`/`recordSeriesProgress`, ~L83-95, L1111-1298) — no specific ordering ruling found |
| progressive-parent-rowkey.test.ts:610-630 | "each placement guards its exact progressive premise" — junction relation-bearing createMany | A | guard SQL is semantically identical (`EXISTS(SELECT ... FROM ... WHERE "q0"."id"=$1 ...)`); test expects `"t0"."id" = $1`, actual is `"q0"."id" = $1` | `src/query-engine/raptor3/shared/query.ts:657-689` |
| progressive-parent-rowkey.test.ts:632-650 | junction relation-bearing updateMany | A | same alias pin; guard correctly has *only* the `id` conjunct (junction placements are row-key-only, matching the file's own §H1 design note) | same |
| progressive-parent-rowkey.test.ts:652-674 | child-held relation-bearing updateMany | A | same alias pin; guard correctly has *both* `id` **and** `code` conjuncts (matches the file's own design note for ordinary child-held placements) | same |
| starts-with-prefix-plan.test.ts:185-198 | PG C-collated: default-mode startsWith becomes an index range | A | `predicateFor()`'s helper strips only `"t0".` before running the raw predicate against an unaliased bare table; the engine emits `"q0".`, so PG raises "missing FROM-clause entry for table q0" — an artifact of the test harness, not the planner | `src/query-engine/raptor3/shared/query.ts:657-689`; `docs/architecture/raptor3-evidence/g4/cutover/protocol.md` §7.2 |
| starts-with-prefix-plan.test.ts:200-212 | PG C-collated: range narrows to matching rows | A | same harness artifact (same unstripped `q0.` alias) | same |
| starts-with-prefix-plan.test.ts:223-236 | PG C-collated: endsWith seq-scans under either spelling | A | same | same |
| starts-with-prefix-plan.test.ts:269+ | SQLite: default-mode startsWith becomes an index range | A | same mechanism; SQLite raises `SqliteError: no such column: q0.title` — literal confirmation the leaked alias is `q0` | same |
| starts-with-prefix-plan.test.ts:~290 | SQLite: the range returns exactly the matching rows | A | same | same |
| cs02-structure-measure.test.ts:1097 | "collects the frozen CS-02 structural work matrix" | D | reaches `RAPTOR3_RUNNER_ONLY_TESTS`' CS-02 structural-measurement harness/recipe registration, explicitly named a "pre-existing registration defect" independent of this branch's work, and the file is designated runner-only — the credential-free manifest never excludes it, so plain `extended-local` execution reaches it outside its intended environment | `scripts/raptor3-manifest.mjs:315-319` (`CS02_STRUCTURE_MEASUREMENT_TESTS`) + `:1410-1411` (spread into `RAPTOR3_RUNNER_ONLY_TESTS`); `docs/architecture/raptor3-evidence/g4.md:2658` ("CS-02's matrix cell remains a pre-existing registration defect (B-R1)") and `:2744-2745` |
| namespace-attribute-segment.test.ts:69-107 | "progressive segment spans carry no database namespace" | D | `SPAN_RECORD_SERIES_SEGMENT` is a retired-engine-only instrumentation attribute: the only call site that ever created this span lived in the deleted V1 `write-engine`/`OperationExecutor` machinery; the constant survives only as an orphaned export in `src/instrumentation/spans.ts`, never invoked anywhere in `src/` | `docs/architecture/raptor3-evidence/g4/pattern-retirement/retirement.patch:36152,38307,38348` (deleted emission site); confirmed zero emission call sites anywhere under current `src/` |

\* progressive-parent-rowkey.test.ts:249-266 is listed under Class A but see the caveat in its row and in Unverified.

## Class A — physical-plan pin (26 cells)

**mutation-projection-cte-fold.test.ts (16 cells).** The retired engine had **two**
independent single-statement optimizations: a pre-Phase-8 scalar-only `UPDATE/INSERT
… RETURNING` fold (no CTE), and a Phase-8.1/8.2 CTE-based fold (`WITH
"__viborm_mutation" AS (… RETURNING <every column>) SELECT … FROM
"__viborm_mutation"`) that additionally covered relation-including projections
(`include`, `_count`, cursor-on-relation reads) and nested-create trees, gated by
two legality guards (`projectionReadsMutatedModel`, `setCanFireReferentialAction`),
per the file's own header comment and `pattern-retirement/retirement.patch:18263-
18660` (both guard functions, `MUTATION_CTE`, deleted as dead V1 code once nothing
called them post-cutover). The shipped engine (Raptor 3) ported only the **first**
optimization. Its own source states the gate explicitly:

> `src/query-engine/raptor3/commands/commands.ts:1051-1058`: "It is also the
> shipped fold gate (`UpdateOperation` `canFold`, `DeleteOperation.ts:206-212`): a
> relation projection must read other rows, which no `RETURNING` carries, and a
> provider without `RETURNING` keeps the located/mutated/re-read route."

> `docs/architecture/raptor3-evidence/g4/unit02/note.md` §4.4: "Gate (the shipped
> gate, `DeleteOperation.ts:206-212`, `UpdateOperation` `canFold`):
> `adapter.capabilities.supportsReturning` **and** every prepared projection field
> is `kind: "scalar"`. A relation projection must be read **before** the row is
> gone and has no `RETURNING` spelling; `_count` is a relation projection too."

> `docs/architecture/raptor3-evidence/g4/unit02/note.md` §12.1 (physical-envelope
> table, `physical-envelope.test.ts`): "`update` with a relation projection | n
> statements, 1 tx | **n statements, 1 tx** | — | unchanged" — measured explicitly
> and left multi-statement, not silently missed.

`returningSafeProjection()` (`src/query-engine/raptor3/shared/query.ts:231-237`)
is the concrete gate: `projection.fields.every(f => f.kind === "scalar" ||
f.kind === "sentinel")`. Grep for `__viborm_mutation`/`MUTATION_CTE` across
current `src/` returns zero hits — the CTE machinery genuinely does not exist in
the shipped tree. In every failing cell where the test also asserts the semantic
**answer** (`toEqual(truth)`), that assertion is not in the failure list — the
row values returned are correct; only the plan-shape (statement count / `WITH `
prefix) assertions fail. This satisfies the brief's Class-A bar precisely: an SQL
shape/CTE-fold-shape pin, changed by design, ruling named, observable result the
same. One honest gap: the unit note never uses the words "CTE" or "Phase 8.1" —
it documents the replacement (narrower) gate, not an explicit decision to drop
the broader retired mechanism. I infer supersession from (a) the zero-hit grep,
(b) the retirement patch showing the CTE code deleted as dead V1 code, (c) the
explicit "unchanged"/multi-statement measurement in §12.1. Flagged, not hidden.

**progressive-parent-rowkey.test.ts's alias cells (249-266, 610-674) and
starts-with-prefix-plan.test.ts (all 5).** One shared root cause, well-ruled
directly in the engine source:

> `src/query-engine/raptor3/shared/query.ts:657-689` (`alias()`/`rootAlias()`):
> "An alias is a fact of the statement it names… so a statement whose first alias
> is minted by one of the six owners… starts at `q0`, and the same logical query
> always emits the same text. Without it the engine-lifetime read owner
> (`commands/index.ts`) minted `q0, q1, … q10000` for the SAME `findUnique`… —
> measured as an obstacle by the cutover protocol (`g4/cutover/protocol.md`
> §7.2)."

> `docs/architecture/raptor3-evidence/g4/cutover/protocol.md` §7.2: "The shipped
> engine emits a stable `t0`… Receipt: `receipts-stage2/prepared-sql-alias-
> drift.json`."

The retired engine's root alias was the fixed text `t0` (confirmed: the literal
string `"t0"` does not appear anywhere in current `src/query-engine/raptor3/`).
The shipped engine's root alias is deterministically `q0` per statement (the
*drift* — an unboundedly growing counter — was the bug fixed; the letter itself
was never matched to the old engine, and no ruling says it needed to be — the
requirement was statement-text *stability*, which `q0` per fresh statement
satisfies). Both `starts-with-prefix-plan.test.ts`'s `predicateFor()` helper and
three of `progressive-parent-rowkey.test.ts`'s assertions hardcode stripping/
matching literal `t0`, which is simply stale. Observable behaviour is unaffected:
for the prefix-plan file, the SQL *shape* (range vs. seq-scan) is independently
proven by the file's own literal-predicate tests (which pass, since they never
go through `predicateFor`); for the progressive-parent-rowkey guard cells, the
actual guard predicates shown in the error output contain exactly the conjuncts
the design intends (junction: `id` only; child-held: `id` **and** `code`), just
under `q0` instead of `t0`.

**progressive-parent-rowkey.test.ts:385-418 ("before-root series").** Weakest
Class-A cell in this note. The returned value and final DB state are correct;
only the claim that the nested spoke `INSERT` lands in an *earlier* batch than
the root hub `UPDATE` fails — both land in the same batch. "Batch segmentation"
is one of the pin types the brief's own Class-A definition names, and Raptor 3's
progressive-write machinery is a documented G4 rewrite (`operation-context.ts`
`committedSegments`/`recordSeriesProgress`, explicitly modelled on "exactly as
the shipped executor keeps `progress.mayHaveCommittedSegment`"), so some
ordering choice was clearly made by construction — but I could not find a
ruling naming *this specific* before/after-root ordering decision. Recorded
here rather than under Unverified only because the observable result is
unambiguously correct and the divergence category matches Class A's own
wording; flagged for a second look.

## Class B — registered refusal (0 cells)

None found in this family.

## Class C — a defect in the shipped engine (2 cells)

**progressive-parent-rowkey.test.ts:276-317 and :320-383.** Smallest
reproduction: schema `hub { id string @id, code string @unique, spokes
toMany(spoke) }` / `spoke { id string @id, hubCode string?, hub
toOne(hub).fields(hubCode).references(code).onUpdate(cascade) }` (i.e. the
parent is *located and referenced by the same non-PK unique column*). Operation:
`client.hub.update({ where: { code: "H1" }, data: { spokes: { createMany: {
data: [relationBearingRow] } } } })` on a PGlite driver declaring
`supportsOrderedCommittedSegments: true`, batch-only transport. Inject, right
after the first committed segment, a concurrent write on a second client/driver
over the same database that changes the located hub's `code` (and lets a
second, different hub take the old value). Expected: the nested `createMany`
member rejects with `/parent record changed across a committed segment/` (the
message `src/query-engine/raptor3/commands/execution.ts:771` raises) and writes
nothing. Actual: the promise **resolves**, and the spoke would land under
whichever hub holds `code:"H1"` at that later moment — not the hub instance the
caller's `where` captured. The file's own header names this exact outcome as
the pre-fix bug ("FALSIFIED by dropping [the guard's second conjunct]… the
measured state… is the honest before-picture — hubs [[h-other, H1], [h-row-key,
H1-moved]]… with no error at all").

Suspected owner: `captureSeries()` in `src/query-engine/raptor3/commands/
execution.ts:757-788`. It builds the parent-liveness guard from `this.identity(
parent)` (row-key) plus `this.membershipValues(edge, parent)` (the referenced
non-PK columns, via `membershipFields()` in `commands/selection.ts:97-105`), and
that combination is exactly the "second conjunct" the guard cells at
progressive-parent-rowkey.test.ts:610-674 show correctly present in the emitted
SQL for a *different* schema shape (the `h1_junction`/child-held cases). Given
the SQL-shape half of the mechanism visibly works elsewhere, the defect is most
likely in *whether/when* `captureSeries()`'s guard actually runs for this
specific shape — `selection.membership()` (line 766) gating the whole guard
block, or the guard's read (`ctx.flush(ctx.queries.select(...), member)`, lines
778-786) racing behind rather than ahead of the concurrent write in this
driver's segment-commit ordering — but I did not trace far enough into
`OperationContext`'s segment-commit sequencing to name the exact line. That
would need a dedicated repair-track investigation, not a triage read.

## Class D — the test's premise is gone (2 cells)

**namespace-attribute-segment.test.ts.** Reaches `SPAN_RECORD_SERIES_SEGMENT`
("One committed-segment attempt inside a progressive record series",
`src/instrumentation/spans.ts:38-39`), an instrumentation attribute whose only
production call site (`shouldTraceSpan(...)` guard + `name:
SPAN_RECORD_SERIES_SEGMENT` span construction, `pattern-retirement/
retirement.patch:38307,38348`) belonged to the retired V1 `write-engine`'s
`OperationFragment → record-series → OperationExecutor` chain, deleted whole in
D-15 (`docs/architecture/raptor3-evidence/g4/pattern-retirement/note.md`: "Arnaud's
decision D-15… retire the `pattern/` experiment and every production owner it
alone kept alive… The owners underneath it are the shipped V1 engine's SQL
builders, verb operations, result parsers and write-engine fragments: the
machinery Raptor 3 replaced"). The constant remains exported from
`src/instrumentation/spans.ts`/`index.ts`/`exports.ts` (dead re-export, zero
emission call sites anywhere in current `src/`). Equivalent shipped fact: Raptor
3 *does* track an analogous "committed segment" concept live (`committedSegments`
counter, `recordSeriesProgress` meta with `atomicity: "segment"`,
`src/query-engine/raptor3/shared/operation-context.ts:83-95,189-234,1111-1298`,
explicitly "exactly as the shipped executor keeps `progress.
mayHaveCommittedSegment`") — but only as **error metadata on a failed/partial
write**, never as a success-path OpenTelemetry span. No tracing-span equivalent
of `SPAN_RECORD_SERIES_SEGMENT` is pinned anywhere for the shipped engine.

**cs02-structure-measure.test.ts.** Reaches the CS-02 structural-measurement
harness/recipe-registration machinery (`captureStructuralMeasurement`,
`SemanticInventoryBindings`, `structuralMeasurementRecipes`, `Recorder`/
`ReplayTape` from `tests/raptor3/harness/`), which `scripts/raptor3-manifest.mjs`
explicitly designates runner-only:

> `scripts/raptor3-manifest.mjs:315-319`: `CS02_STRUCTURE_MEASUREMENT_COUNTS =
> { "tests/raptor3/core-structure/measurement/cs02-structure-measure.test.ts": 1
> }`, `CS02_STRUCTURE_MEASUREMENT_TESTS = Object.keys(...)`.
> `:1410-1411`: `RAPTOR3_RUNNER_ONLY_TESTS = Object.freeze([
> ...CS02_STRUCTURE_MEASUREMENT_TESTS, ...])`.

`scripts/credential-free-test-manifest.mjs` imports and excludes the *sibling*
list `CS02_REPEATED_OCCURRENCE_TESTS` (lines 65, 158, 214 — a different file,
`tests/raptor3/core-structure/repeated-occurrence-ownership.test.ts`) but never
imports or excludes `CS02_STRUCTURE_MEASUREMENT_TESTS` at all (confirmed:
zero matches for that identifier or for `cs02-structure-measure` anywhere in the
file). `EXTENDED_LOCAL_TESTS` (`:231-249`) is a full recursive walk of `tests/`
minus a handful of filename-pattern filters and `extendedLocalExclusions`, so
this file falls through into the ordinary extended-local walk and, per its
measured RSS, into the "PGlite half" — the `imported-pglite-2` shard the
brief's own gate-inventory log confirms it landed in. This is the manifest gap
the family brief asks to identify: **`raptor3-manifest.mjs` owns and correctly
states the runner-only fact; `credential-free-test-manifest.mjs` has the gap**
that lets the file leak into `extended-local`.

Separately, `docs/architecture/raptor3-evidence/g4.md` shows the team was
already aware this specific cell is red, independent of any G4-02/pattern-
engine work:

> `g4.md:2658`: "CS-02's matrix cell remains a pre-existing registration
> defect (B-R1)."
> `g4.md:2744-2745` (the same paragraph that announces this whole triage
> program): "the retired engine's PGlite contract suites
> (`tests/contracts/engine/{query,write}/`), two `public-client` files, **the
> CS-02 structure measure**, one instrumentation unit), never named by the
> parity plan."

No further definition of "B-R1" was found elsewhere in the evidence tree (see
Unverified). Given it is (a) explicitly runner-only by the manifest that owns
that fact, and (b) already named a pre-existing, unresolved registration gap
independent of this branch, D is the closest fit — the cell's premise is the
runner-only measurement harness's own bookkeeping, not a live shipped-engine
behaviour this triage's A/B/C axis is about.

## Unverified

- **mutation-projection-cte-fold.test.ts** could not be run standalone (see
  Blockers); its 16 cells are taken from tonight's pre-existing
  `scratchpad/gate-inventory/shared-family-1.log` run rather than reproduced
  fresh by this session.
- **progressive-parent-rowkey.test.ts:249-266** — could not independently
  verify whether its second claim (line 273, the guard's `code` conjunct)
  would pass once de-aliased, since the test aborts at the first failing
  assertion (line 255). It is plausible this cell also hits the Class-C defect
  above rather than being pure alias noise; I could not distinguish the two
  without a live, instrumented reproduction, which the RSS ceiling (see
  Blockers) and the "no fixes, minimum that discriminates" brief rule both cut
  against.
- **progressive-parent-rowkey.test.ts:385-418** ("before-root series") — no
  named ruling found for the specific batch-ordering claim; see the Class-A
  paragraph's own hedge.
- **cs02-structure-measure.test.ts** — "B-R1" is referenced exactly once in
  `g4.md` (line 2658) with no definition found elsewhere in
  `docs/architecture/raptor3-evidence/`; I could not confirm what that label's
  registry is, only that the cell is called a "pre-existing registration
  defect" by name.
- **starts-with-prefix-plan.test.ts** — did not independently re-run the
  planner with a corrected (`q0`-stripping) `predicateFor()` to positively
  confirm the index-range/seq-scan classification is unchanged once de-
  aliased (would require editing the test, which is out of scope); confidence
  is high but based on (a) the literal-predicate tests in the same file
  passing independently and (b) the SQLite error text confirming the leaked
  alias is exactly `q0`, not on a corrected live run.

## Blockers

- `node scripts/run-vitest-safe.mjs --project extended-local tests/contracts/
  engine/write/mutation-projection-cte-fold.test.ts` exceeded the 1536 MiB
  ordinary-project RSS ceiling on every attempt (1555–1586 MiB peak sampled,
  4 attempts including one after a 20 s wait) and never produced output. This
  is not the "test-run lock" refusal the brief's retry protocol covers — no
  lock message appeared, and `run-vitest-safe.mjs` always selects
  `ORDINARY_PROCESS_GROUP_RSS_CEILING` (1536 MiB; see
  `scripts/bounded-process.mjs:14-45`), never the higher
  `ISOLATED_PGLITE_PROVIDER_RSS_CEILING` (2560 MiB) that a single PGlite-backed
  file this size would need — that raised ceiling is wired only into
  `scripts/run-credential-free-tests.mjs`, not into `run-vitest-safe.mjs`.
  Substituted the pre-existing `scratchpad/gate-inventory/shared-family-1.log`
  receipt (same file, same 16/40 failure roster, captured via `test:all`
  which does use the credential-free runner) rather than leave the file
  unmeasured. Two other family files (`progressive-parent-rowkey.test.ts`,
  `namespace-attribute-segment.test.ts`) hit the genuine "workspace
  verification PID … still active" lock refusal once each; both cleared after
  the brief's 20 s wait-and-retry with no other action taken.
