# C-01 cutover execution — independent review, round 3

**Unit** `g4-cutover-execution`, round 3 (Arnaud's D-11 … D-14 applied).
**Brief** [`g4/briefs/cutover-execution.md`](briefs/cutover-execution.md) +
[`briefs/review.md`](briefs/review.md).
**Author's record** [`cutover-execution/note.md`](cutover-execution/note.md)
§§R3.1–R3.10. **Base** `5a37bcd7f371fe393cf7cecb8ec9f82ef8bd3062` (HEAD, unchanged).
**Previous review** [`cutover-execution-review.md`](cutover-execution-review.md)
(round 1/2, REVISE). **Reviewer** independent; did not write the unit.
**Receipts** [`cutover-execution-review-round3-receipts/`](cutover-execution-review-round3-receipts/),
probes [`tests/raptor3/g4/review/cutover/`](../../../../tests/raptor3/g4/review/cutover/).

## Outcome: **REVISE** (findings 1–3 blocking for commit 4)

D-14 is well built and I could falsify nothing in it. The production diff beyond
the measured patch is **exactly** the six files the note names and nothing else;
the statement `buildStatement()` publishes is the *same `Sql` object* the
execution submits (identity, not equality — probe P1); every write answers the
byte-identical pre-cutover refusal; `prepareSingle()` publishes exactly what
`prepareBatch()` publishes; the restored `Unknown operation` sentence is
byte-identical to the base's. Typecheck, build, all three bundles, the cost
census and both G4 read corpora reproduce to the byte. I reproduced the **whole**
class-D bisection: all ten cells fail on `5a37bcd7` + the candidate route with
**byte-identical observables**, so the author's classification is right.

What blocks commit 4 is again a measurement gap, one lane deeper than round 2's.
Round 2 established that the estate is larger than the registered raptor3 modes
and produced the core lane. **The provider lanes were still never run — not in
round 1, 2 or 3, and not by my predecessor.** They are red:

| lane | base `5a37bcd7` | cutover tree |
| --- | --- | --- |
| `provider-sqlite3` + `provider-libsql` (credential-free, stages of `pnpm test:all`) | **0 failed** / 1,253 passed, 10 files | **61 failed** / 703 passed, **5 red files** |
| `provider-pg` → `pg-nested-write-races.test.ts` (Docker) | **0 failed** / 77 passed | **13 failed** / 82 passed |
| `provider-mysql2` → `mysql2.test.ts` (Docker) | 4 failed (pre-existing) / 80 passed | **13 failed** / 71 passed (**9 new**) |

That is **≥ 83 newly red registered cells in ≥ 7 files** on top of the core
lane's 11, none of them in the note's classification and none in the
commit-message draft, which tells the integrator the estate's red is
"6 failed files / 11 failed tests". Five of those reds are a registration
**round 3 itself added** and never ran.

I bisected them the way the author bisected class D: every one of the 61 local
reds and 8 of the 13 pg reds fail identically on the base with the candidate
route, so they are **unrecorded compatibility differences of the candidate, not
cutover defects** — the same verdict, and the same decision for Arnaud, as the
ten already on the table. The unit's rule is right; it was applied to one lane
and a half of the estate.

---

## Findings

### 1. blocking — the credential-free provider lanes go from 0 red to 61 red, unrun and unrecorded

`node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=provider-sqlite3 --project=provider-libsql`
(the `provider-sqlite3:` / `provider-libsql:` stages of `scripts/run-credential-free-tests.mjs`,
i.e. `pnpm test:all`; they need no Docker and no credentials):

| tree | result | receipt |
| --- | --- | --- |
| base `5a37bcd7` | 10 files passed, 8 skipped — **1,253 passed, 0 failed** | [`provider-local-BASE-legacy.log`](cutover-execution-review-round3-receipts/provider-local-BASE-legacy.log) |
| **cutover** | 5 files failed, 2 passed — **61 failed**, 703 passed | [`provider-local-cutover.log`](cutover-execution-review-round3-receipts/provider-local-cutover.log) |
| base + candidate route | 7 files failed — 71 failed, 1,182 passed | [`provider-local-BASE-candidate.log`](cutover-execution-review-round3-receipts/provider-local-BASE-candidate.log) |

Per file: `sqlite3-returning-json` 27, `sqlite3-scalar-roundtrip` 12,
`sqlite3-nested-write` 12, `sqlite3-polymorphic-batch` 8, `sqlite3-index-ddl` 2.
**Every one of the 61 is red on the base with the candidate route too** (the
failing-cell sets are identical; the extra 10 there are in two suites the
cutover deletes), so none is a cutover defect — they are candidate
compatibility differences of exactly the class-D kind, at six times the volume
of the ten already reported. Examples, all through `createClient`:

- `SQLite3 delegated nested update — JSON write envelope > the documented `data`-column escape stores the document at the delegation seam` → `QueryEngineError: Unknown update operation: label`
- `… > a delegated TO-MANY update target stores its JSON document exactly` → `Unknown update operation: z`
- `SQLite3 ordering query plan > a cursor over NOT NULL sort columns seeks into the index`
- `SQLite3 Prisma parity > empty select rejection > all-false select throws`

A user storing a JSON document whose keys look like update operators gets a
refusal where the shipped engine stored the document. That is a public
behaviour change, and it is currently recorded nowhere.

**Resolution.** Run the lane, put the receipt in `cutover-execution/receipts/`,
classify every red with the bisection the unit already owns, list the families
in note §R3.2 and in the commit message's KNOWN RED, and put them in front of
Arnaud with the other eight. Reproduce with the three commands above.

### 2. blocking — the Docker provider lanes are redder than base, and one red registration is round 3's own

`pnpm test:providers`' pg and mysql2 suites, against the two running containers
(`docker port …` → 55729 / 55730):

- **`tests/providers/docker/pg-nested-write-races.test.ts`** — base **77/77 green**
  ([receipt](cutover-execution-review-round3-receipts/pg-nested-write-races-BASE-legacy.log));
  cutover **13 failed / 82 passed of 95**, reproduced twice
  ([1](cutover-execution-review-round3-receipts/pg-nested-write-races-cutover.log),
  [2](cutover-execution-review-round3-receipts/pg-nested-write-races-cutover-2.log)).
  - **8** are cells that were already in that file and were green: `pg upsert
    atomicity` ×2, `pg nested-write concurrency` ×2, `pg filtered m2m deleteMany
    staleness`, `pg nested write behavior` ×3. All 8 fail identically on
    base + candidate route
    ([receipt](cutover-execution-review-round3-receipts/pg-nested-write-races-BASE-candidate.log))
    → candidate differences, unrecorded.
  - **5** are `batchPrimaryKeyDataflowContract`, the contract **note R3.4
    re-registered onto this file in round 3** (`tests/providers/docker/pg-nested-write-races.test.ts:113`).
    Every one dies with `Error: Raptor 3 G1 atomic output requires exact identity
    scratch or segmented RETURNING` (`src/query-engine/raptor3/shared/operation-context.ts:1837`).
    At the base that contract was green (167/167 in `pg-write-update.test.ts`,
    [receipt](cutover-execution-review-round3-receipts/pg-write-update-BASE-legacy.log)).
    **The unit turned a green registration red and never ran it**, while the
    commit draft presents the restoration as recovered coverage.
- **`tests/providers/docker/mysql2.test.ts`** — base 4 failed / 80 passed (the
  pre-existing `MySQL namespace containment` four); cutover **13 failed / 71
  passed**, i.e. **9 new**: GeoPoint round-trip ×2, polymorphic collection
  reads ×3, polymorphic collection writes, polymorphic relations, the
  batch-only non-returning refusal, and the spatial-index plan.
  ([base](cutover-execution-review-round3-receipts/mysql2-BASE-legacy.log),
  [cutover](cutover-execution-review-round3-receipts/mysql2-cutover.log),
  [cutover 2nd run](cutover-execution-review-round3-receipts/mysql2-cutover-2.log))

**The bisection method has a blind spot, and this lane shows it.** Eight of the
nine mysql reds reproduce on base + candidate route; the ninth,
`uses the GeoPoint spatial index only for positive indexable predicates`,
**passes there and fails only on the cutover tree**
([receipt](cutover-execution-review-round3-receipts/mysql2-BASE-candidate.log)):

```
expected { table_name: 'q0', …(7) } to match object { access_type: 'range', …(1) }
-   "access_type": "range",  "key": "geopoint_plan_places_location_idx",
+   "access_type": "ALL",
```

The cell EXPLAINs `new QueryEngine(driver, registry).build(place, "findMany", …)`
(`tests/providers/docker/mysql2.test.ts:203-242`). On the base a bare engine has
no route, so `build()` answered the **legacy** lowering, which used the spatial
index; on the cutover tree D-14's `provisionedRoute` makes it answer the
**candidate** lowering, which scans the table. So: (a) the candidate's
`within` / `distance` predicates are not sargable on a MySQL spatial index —
a real, unrecorded consequence of shipping; and (b) **any cell whose subject is
`QueryEngine.build` is invisible to a bisection that only defaults
`VibORM.create`'s route**, because the base still answers the deleted engine
there. Note R3.9 lists the bisection's single run as an unverified claim; this
is the sharper limitation and it is not stated.

**Resolution.** Run both Docker lanes; classify the 8 + 8 candidate differences
with the others; decide the restored `batchPrimaryKeyDataflowContract`
registration (keep it red and record the engine limitation, or withdraw it and
record the coverage loss — both are decisions, not repairs); and re-run the
class-D bisection for every `QueryEngine.build`-based cell against a base whose
`buildStatement` is also the candidate's, or state the limitation.

### 3. blocking — the commit-message draft is not truthful about the estate or about two of its own claims

`cutover-execution/note.md` R3.10:

1. `KNOWN RED: the core gate (pnpm test:core, --project='layer-*') is 6 failed
   files / 11 failed tests …` — that is the whole of the draft's red disclosure.
   With findings 1 and 2 the integrator would be committing an estate with
   **≥ 83 further red cells in ≥ 7 further files across three more lanes**, one
   of which (`provider-sqlite3`/`provider-libsql`) is a stage of the repository's
   own credential-free runner and was **0 red at the base**.
2. `Also restored, because the cutover took them as collateral: six libsql
   provider contracts … and two pg ones (batch-primary-key-dataflow,
   create-many-return-fold)` — the pg `batch-primary-key-dataflow` registration
   **fails** (finding 2), and the six libsql ones sit inside
   `describe.skip("LibSQL contracts that need effectful live-schema setup …")`,
   so they are matrix-visible and never execute. The note says the second half
   (R3.9); the commit message does not.
3. The draft records that `QueryEngine.build()` now publishes the candidate's
   statement, but not that **the statement it publishes is a different query**:
   `t0` → `q0`, no `LEFT JOIN LATERAL` for nested includes on PostgreSQL/MySQL
   (resurrected `lateral-joins` cells, finding 4), and a GeoPoint predicate that
   no longer uses the spatial index (finding 2). Anyone reading `build()` output
   — the documented debugging surface — sees a different query than before.
4. A registered refusal's wording changed and is nowhere in the draft:
   `Driver '<name>' supports neither transactions nor atomic batch execution.`
   (the deleted path, `src/query-engine/write-engine/shared.ts:732`, still there
   but now unreachable) is now spelled with double quotes by the driver layer
   (`src/drivers/driver-transaction-base.ts:790`, `:979`). Two of the eleven
   core-lane reds are exactly this text
   (`select-mode-capability-matrix` `'create'` / `'update'`). The common brief
   makes refusals contracts and a changed one a decision for Arnaud.

**Resolution.** Restate KNOWN RED with the three lanes and their real counts;
correct the two restoration sentences; add one line for the changed refusal
text and one for "the SQL `build()` publishes is the candidate's, and it is not
the same query".

### 4. must-fix — 327 of the 568 deleted cells were green against the NEW engine; I verified 115 of them

Note R3.9 labels this unverified ("they were not individually re-read"). I
verified it: I restored three of the fifteen class-A files from `5a37bcd7` into
the review directory and ran them **on the cutover tree**
([receipt](cutover-execution-review-round3-receipts/resurrected-deleted-suites.log)):

| resurrected file | cells | red | green cells deleted |
| --- | ---: | ---: | ---: |
| `operand-callback-sql.core.test.ts` | 74 | 12 | **62** |
| `decimal-having-operand-sql.core.test.ts` | 48 | 6 | **42** |
| `lateral-joins.core.test.ts` | 18 | 7 | **11** |

The red counts match note R3.4's table exactly, which is independent
confirmation of that table — and the green ones are executable pins the
**shipping** engine satisfies (62 operand-callback lowerings, 42 decimal
`having` casts, all 11 SQLite correlated-subquery arms of `lateral-joins`).
The same unit removed single cells and kept the suite in
`namespace-qualification` (2 of 122) and `provider-result-contracts` (1 of 115);
the threshold between the two treatments is unstated.

Two more casualties of the same class, checkable by grep:
`tests/contracts/engine/write/extended-where-unique-behavior.ts` (1,493 lines)
and `tests/contracts/engine/write/to-one-update-where-behavior.ts` (1,037 lines)
are now **orphans with zero importers** — the cutover deleted all five
registrations of each (`extended-where-unique.test.ts`, `pg-write-update`,
`mysql2-write-update`, `libsql-…-linearization`, `sqlite3-…-linearization` for
the first; the `-upsert` / `-mutations` quartet for the second). 14 of the 19
pg-write-update cells that fail under the candidate are `extended whereUnique`
cells, so the contract the new engine fails and the contract that lost every
registration are the same contract.

**Resolution.** Either delete the red cells and keep the files (the rule the
unit used on the four surviving suites), or state in the note and the commit
message that 327 of the 568 deleted cells were passing against the new engine;
and delete or re-register the two orphaned behaviour modules.

### 5. must-fix — three §1.4 removals dropped verbatim one-sided assertions the rule says to keep

- `tests/contracts/engine/query/operation-program-read-contracts.core.test.ts` —
  the removed cell ("preserves public result shapes on the direct runtime path")
  is described in R3.4 as "rows keyed by the shipped `COUNT_RESULT_KEY` /
  `getAggregateResultKey` carriers". Only its `count`/`exist`/`aggregate`/`groupBy`
  arms are. Its other arms — `findMany { take: -2 }` reverses, `findFirst`,
  `findUnique` → `null`, and `executionCount === 8 / transactionCount === 0` —
  do not touch a carrier and **still hold**: my probe cell
  `the deleted direct-runtime arms that carry no shipped result key still hold`
  runs all three on the cutover tree and passes.
- `tests/contracts/engine/query/namespace-qualification.core.test.ts` lost **two**
  cells, not the one pin R3.4 describes: the second is the whole
  `both cursor spellings qualify the located-row subquery` block, which pinned
  that the sargable and lexicographic cursor branches both name the qualified
  table and that the derived cursor row stays bare.
- `tests/raptor3/g4/review/unit01-followup/distance-parity.test.ts` lost two
  cells whose `mine.*` half was one-sided (`AS "_distance"`, `assert.deepEqual(mine.fields, …)`,
  "never projects the point column beside the distance").

**Resolution.** Re-express the one-sided halves (three small cells), or record
each as a knowing coverage loss in note §R3.4.

### 6. must-fix — round 2's finding 4 is half-closed and the deferral reason has expired

R2.3 renamed 31 cells and deferred two groups. One of the two was
"the `g4-unit01` cells whose oracle is `QueryEngine.build` … They are RED today,
and what they will compare depends on Arnaud's decision". D-14 made that
decision and they are green now, still named for an engine that no longer
exists, and still comparing the client-route seam with the command-engine seam:

- `tests/raptor3/g4/unit01/repair2.test.ts:49` "answers … the way the shipped engine does" (×6 forms)
- `tests/raptor3/g4/unit01/repair3.test.ts:88`, `:131` "words the … refusal the way the shipped engine does"
- `tests/raptor3/g4/unit01/repairs.test.ts:124`
- `tests/raptor3/g4/review/unit01-followup/distance-parity.test.ts:85,121,148,175` —
  a registered file (`g4-unit01-review`, count 200 → 198) the unit **edited in
  round 3**, whose `shippedStatement()` helper (`:55`) is
  `new QueryEngine(driver, registry).build(...)` — since D-14 the candidate —
  while three cells still assert "the shipped engine must refuse".

**Resolution.** Rename them in the same pass (the R2.3 pattern), or list them in
the commit message as knowingly misnamed. `distance-parity.test.ts` also needs
its `shippedStatement` helper renamed or removed, since "shipped" there is now
the provisioned route.

### 7. note — a retired adjudicator took a one-sided literal with it

`verifyChangedDependencyCommandsProgress` (removed from
`tests/raptor3/scenarios/contracts/instances.ts`, −86 lines) contained a
verbatim one-sided pin of the candidate's own published progress —
`{atomicity: "segment", phase: "planning", committedSegments: 1,
committedWriteMembers: 1, completedMembers: 0, memberPath: [1], totalMembers: 2}`.
The replacing `verifyProgramEnginePair` **strips** `memberPath`/`totalMembers`
before comparing, and the `s2-changed-dependency` fixture's own `assert` pins
the failure name, code, message, defaults and final state but not the progress
record. Nothing pins that record for this scenario any more (the mechanism is
pinned elsewhere: `g2-transport`, `g29-member-dependency`, the D1 provider
suite). Everything else I read in the D-11 edits is a faithful removal of the
shipped arm with the candidate expectation stated unconditionally, and
`generation/campaign.ts` is strictly stronger than before (the adjudicated
`slice(duplicateAdmissions)` comparison became a plain `verifyG0Pair`).

### 8. note — the ceiling the brief set is missed, as the note says, and one of the six is the base's

D-12's gate is "the lane back to the base's five red files or better".
I measured it twice on the final tree: **6 failed files / 11 failed tests of
452 / 8,969** ([before my probes](cutover-execution-review-round3-receipts/core-lane-review3.log),
[after](cutover-execution-review-round3-receipts/core-lane-final.log)) — exactly
the author's figures. Tests are far under the base's 42; files are one over, and
the surviving red set is **not** the base's: four of the base's five red files
were deleted by the cutover, `contract-matrix` is red on both
(base: 2 cells, `route-public-types.core.types.ts` and `candidate-handoff.test.ts`;
cutover: 1, `candidate-handoff.test.ts` —
[receipt](cutover-execution-review-round3-receipts/contract-matrix-base.log)),
and the other five files are new. The note reports the tension rather than
resolving it, which is correct; findings 1–2 enlarge it rather than change it.

---

## What I verified, and how

### The production diff beyond the measured patch is exactly D-14 — CONFIRMED

`git archive 5a37bcd7 src` into a scratch tree, `git apply --include='src/*'`
the stage-2d patch (clean, no offsets), `diff -r` against the live `src/`:
**nine differing files and no others** — the six `.ts` files note R3.1 names,
plus `raptor3/AGENTS.md` (brief item 5) and the two layer guides round 2
corrected. No tenth file, no missing hunk. I read every hunk of all six:

| file | what I checked |
| --- | --- |
| `raptor3/commands/index.ts` | `PreparedRead.statement = value.query.sql` is filled from the memoized `read()` (`prepared ??= queries.read(...)`), so the published `Sql` is the one the execution runs. `prepareSingle()` calls `args()` then the same `read()`, builds a batch-preparation context and calls `publishPrepared` — which is exactly what `prepareBatch`'s `body()` reaches for a read, because `run()` in `batch-preparation` ownership is `return await body()` and nothing else. |
| `raptor3/route/client-route.ts` | `buildStatement()` is `prepared.read?.statement` and `prepareSingle()` forwards, both over the ONE `engine.prepare(...)` handle built per `route.operation(...)` call, which `PendingOperation.#resolveRouted()` memoizes. No second lowering, no new seam. |
| `raptor3/shared/operation-context.ts` | `publish()`'s batch arm extracted verbatim as `publishPrepared`; the row→value decision is the single private `decideRead` both arms call. The other hunk is a comment correction. |
| `pending-operation.ts` | `buildStatement()` delegates; `#resolveSinglePackage()` memoizes one package and requires `queries.length === 1`; `prepare()`/`parseResult()` read that one package. The restored `Unknown operation` sentence is **byte-identical** to `git show 5a37bcd7:src/query-engine/pending-operation.ts:529`, and `#operation` strips `OrThrow` before the `ROUTED_OPERATIONS.has` test, so no OrThrow verb can trip it. |
| `query-engine.ts` | `route ?? provisionedRoute(driver, registry)`; `bind()` passes `this.route`, so the client lineage never provisions (probe: `bound.route === engine.route`). The `if (!(registry.schemas && registry.relations))` guard has nameable coverage: it keeps the constructor's own `Schema registry is required for query engine` refusal instead of a TypeError from inside `createCandidateRoute` (probe). The map is keyed by `model["~"].names.ts ?? "unknown"`, the same expression `createCandidateRoute.operation` looks a model up by (`client-route.ts:180`). |
| `raptor3/shared/schema.ts` | `registry` narrowed to `Pick<…, "getModelSchemas">`; no cast, no widening. |

**Rule 1 (one owner, no second lowering) — observable, not just argued.**
Probe `publishes the SAME Sql object the execution submits`: `buildStatement()`
before awaiting the same `PendingOperation`, then the driver records the `Sql`
it is handed — `submitted.statement === published.toStatement("?")`, one
execution, zero transactions, and `pending.buildStatement()` twice returns the
identical object. **Rule 3 (no policy boolean)**: none in the diff; the only new
booleans are `#singlePackageResolved` (a memo latch over a legitimately
`undefined` value, on a frozen single-use object — not a cached absence that can
go stale) and the guard above. **Rule 12 (no wrapper)**: `buildStatement` is a
field read and `prepareSingle` is the same forwarding shape `prepareBatch`
already had on that interface.

**Both refusals, probed.** All seven write verbs answer `undefined` from
`buildStatement()` and
`Operation '<verb>' does not compile to one SQL statement. Execute the operation instead.`
from `build()` — byte-identical to `git show 5a37bcd7:src/query-engine/query-engine.ts:145`.
All seven read verbs publish one statement, including `findUniqueOrThrow`
against a missing row (no execution).

### The class-D bisection — REPRODUCED, all ten

`git archive 5a37bcd7` into a scratch tree, two lines making `VibORM.create`'s
`route` default to `createCandidateRoute` (the same change as the author's
`base-tree-route-default.diff`; `createClient` → `VibORM.create(config)` with no
route, so every client in the estate becomes the pre-cutover candidate), then
the five class-D files:
[receipt](cutover-execution-review-round3-receipts/classd-bisect-base-candidate-route.log).
**All ten cells fail there, and every failure message is byte-identical to the
cutover tree's** (I diffed them mechanically; `array-transaction-closure` and
one `query-interceptors-array` cell are additionally green on the cutover tree,
which is D-14's array-owner arms closing them, exactly as R3.2 claims). The
classification "unrecorded compatibility difference of the candidate, not a
cutover defect, not repaired" is correct for all ten — and, by the same method,
for the 61 + 8 of findings 1–2.

### Deleted files (brief item 2) — CONFIRMED, with finding 4

213 test files are deleted against the base, **96,450 lines** — the commit
message's figure to the line. The patch's own arithmetic re-derived from the
patch: 239 entries = 230 D + 1 A + 8 M, of which 197 test deletions and 33 `src`
deletions (28,740 lines, matching `git diff --numstat`); three patch-deleted
test paths are not working-tree deletions (`packaged-array.test.ts` re-written,
`libsql-scalars-upserts.test.ts` restored, the untracked
`decode-malformed.core.test.ts`), and 19 extra deletions are round 3's 16
class-A files + the 3 round-1 review probes. `routed-operations.ts` is 48 lines;
`src/**/*.ts` 581 → 549.

I classified **every one of the 213** by dependency: 110 import a deleted
production owner, 60 import a deleted test helper that does, and 43 are deleted
for their subject alone — and those 43 are precisely the 16 class-A files, the
21 retired reviewer probes, the five `route-*` two-sided suites and the
`route-public-types` type core, i.e. the note's own list. I opened the one
public-client deletion (`consumable-result-rows.test.ts` — imports
`write-engine/ReadOperation`), `tests/unit/validation/boundaries.core.test.ts`
(imports `query-engine/validator`), the headers of all 16 class-A files, and
resurrected and ran three of them (finding 4). The reason is checkable in the
source in every case I opened; **what is not checkable from the note is how much
live coverage went with them** (finding 4).

### Kept public-client cells (brief item 3) — CONFIRMED, no assertion weakened

Every class-B file the note reports as red→green is **byte-unchanged since the
base**: `request-transforms.core.test.ts`, `pending-operation-contracts.core.test.ts`,
`sqlite-integer-safety.core.test.ts`, `one-resolution-identity.core.test.ts`,
`operand-callback-keys.core.test.ts`, `query-operation-coverage-boundaries.core.test.ts`,
`orderby-relation-depth.core.test.ts` (`git diff --quiet 5a37bcd7 -- <file>`
clean for all seven), and all are green in my core-lane run. They went green
through production alone. The eighth,
`operation-program-read-contracts.core.test.ts`, is the one modified file — see
finding 5. The four suites that lost cells I diffed line by line; the removals
are the pins the note names, plus the two extras of finding 5.

### Plan §7 architectural rows (brief item 5) — CONFIRMED

I resolved every import specifier in all 549 surviving `src/**/*.ts` through the
`tsconfig` paths: **3,258 internal edges, 0 resolve to a deleted owner** (the 20
unresolved are `.js`-suffixed self-imports in `src/index.ts` and three
documentation strings in `src/config.ts` / `src/cli/utils.ts`).
`createCandidateClient`, `operationExecutor`, `cacheOperationExecutor`,
`constructRoutedOperation`, `executeRoutedOperation` and `OwnWriteLedger` have
no occurrence under `src/`. All 18 surviving `write-engine/` files have an
importer; the only src files with no importer are entry points, the CLI,
`pattern/` (D-15) and `raptor3/program/index.ts`. No fallback: the one remaining
route-absent path is the guard in `provisionedRoute`, and the constructor's own
refusal covers it (probed).

### Suites I ran

| Command | Result | Author's claim |
| --- | --- | --- |
| `--project='layer-*'` (core lane), twice | **6 failed files / 11 failed tests** of 452 / 8,969 | matches exactly |
| `node scripts/run-typecheck.mjs` (before my fix) | 2 Pattern TS2345 **+ the 3 TS2322 of R3.8** | matches |
| `node scripts/run-typecheck.mjs` (after my fix, twice) | **exactly the two `pattern/pack.ts` TS2345** | R3.8 blocker closed |
| `pnpm package:build` | exit 0, 181 files, 6,491.64 kB | matches |
| `measure-raptor3-baseline.mjs --bundle` | engine 329,134 / 92,390 / `1e0a7878…`, pg-simple 624,922 / 184,023 / `231a3b64…`, pg-relations 625,203 / 184,152 / `b10a9bdd…` — **all three byte-equal to the author's**; Δ identity 4 = +206,041 / +923 / +923 runtime, +55,130 / +232 / +231 gzip; ratios **0.5893 / 0.7006 / 0.7008** against the frozen baseline (156,771 / 262,658 / 262,788) | matches to the byte |
| `run-raptor3 g4-read-contracts` | 8 files / 62 tests green | matches |
| `run-raptor3 g2-contracts` | 16 / 216 green | matches |
| `run-raptor3 g4-unit02-author` | 21 / 130 green | matches |
| `run-raptor3 g0` | **33 / 33 green** (was 5 red) | matches D-11 |
| `run-raptor3 g2-generated` | **52 / 52 green** (was 36 red) | matches D-11 |
| `run-raptor3 g4-unit02-pg-contracts` (55729) | 1 / 1 green | matches |
| `run-raptor3 g4-unit02-mysql-contracts` (55730) | 3 files / 17 green | matches |
| `run-raptor3 g4-seed-batch 20000 --subject=candidate` | 338,001 B, body sha256 `16eab58f…f458` — **equal** to the attempt-6 archive | matches |
| `run-raptor3 g4-transport-seed-batch 50000 --subject=candidate` | 324,201 B, body sha256 `c8d9878a…92d6` — **equal** | matches |
| `scripts/raptor3-campaign-receipts.test.mjs` | 39 / 39 | matches |
| `pnpm test:coverage:policy` | **11 / 11, 16 / 16, 6 / 6**, exit 0 | matches |
| `--project=provider-sqlite3 --project=provider-libsql` | **61 failed / 703 passed** (base: 0 / 1,253) | **not run by the unit** (finding 1) |
| `provider-pg` `pg-nested-write-races.test.ts` | **13 failed / 82 passed** (base: 0 / 77) | **not run by the unit** (finding 2) |
| `provider-mysql2` `mysql2.test.ts` | **13 failed / 71 passed** (base: 4 / 80) | **not run by the unit** (finding 2) |
| the five class-D files on base + candidate route | **10 / 10 reproduced, byte-identical** | matches R3.2 |

Both campaign corpora carry `identity.production =
50c0ee97fb1458333c818735da4c92b7bca89daa65929199c00ef551533b7a63`, byte-equal to
the author's post-edit fingerprint — independent proof that production is
exactly as the unit left it and that I changed none of it.

### Cost — CONFIRMED

My own `measure-raptor3-baseline.mjs` run: charged production **139 files /
1,423,012 B / 42,335 physical / 31,664 token-LOC**, identical to
`source-cost-after.json`. Against the frozen baseline (161 / 2,292,906 / 64,980 /
49,887): token **0.6347** (target 0.60, missed by 3.5 points), physical
**0.6515** (target 0.70, met), bytes 0.6206. The whole-cost result is a deletion,
as claimed.

### The probe I inherited (brief item 7) — fixed, minimally

`tests/raptor3/g4/review/cutover/routed-operations-authority.review.test.ts`
carried the three TS2322 of R3.8. The three interceptor callbacks now return
`short as never` / `({…}) as never` — three tokens, no runtime change, the four
cells still green. The whole-estate typecheck ends at **exactly the two
`pattern/pack.ts` TS2345 diagnostics**. R3.8's blocker 1 is closed.

### Probes I added (kept)

`tests/raptor3/g4/review/cutover/d14-publication.review.test.ts` — 9 cells, all
green, run with
`node scripts/run-vitest-safe.mjs run --config tests/raptor3/g4/review/cutover/vitest.config.ts`
(16/16 with the two inherited files):

1. `publishes the SAME Sql object the execution submits, with no extra round trip`
2. `answers the same statement through QueryEngine.build, for every read verb` (7 verbs + OrThrow)
3. `refuses every write with the pre-cutover sentence, on both accessors` (7 verbs × 2)
4. `keeps the registered refusals around the publication` (Unknown operation; admission at the accessor; `Schema registry is required` rather than a TypeError)
5. `prepareSingle publishes exactly what prepareBatch publishes, for a read` (same sql, same params, same parsed value, same statement `build()` answers; a write publishes no package)
6. `an array $transaction member runs the statement the same read builds`
7. `refuses a malformed array member before anything is dispatched`
8. `the provisioned route reaches every model of a bare engine, .map() names included` (+ `bind()` forwards the same route object)
9. `the deleted direct-runtime arms that carry no shipped result key still hold` (evidence for finding 5)

Three further files — verbatim copies of `operand-callback-sql`,
`decimal-having-operand-sql` and `lateral-joins` from `5a37bcd7` — were run once
for finding 4 and then removed; their receipt is
[`resurrected-deleted-suites.log`](cutover-execution-review-round3-receipts/resurrected-deleted-suites.log).

### Evidence integrity

Nothing was committed, staged, reset or stashed; `HEAD` is still `5a37bcd7f`; no
production file was touched (`captureRaptor3Identity().production` after this
review is `50c0ee97fb1458333c818735da4c92b7bca89daa65929199c00ef551533b7a63`,
the author's). The harness fingerprint is now
`c88f426fe83f8a077e1f964be75d7222ac0183d265647909477193b9691b7dc5`, where the
unit finished at `ce8436e6…`: the difference is my probe file and the three-token
type fix in the inherited one. Every command ran serially under the existing
workspace lock on the pinned runtime; no lock was removed. The scratch base tree
lives outside the repository. The two Docker containers were written to by the
provider suites of findings 1–2 (they create and drop their own tables and
clean up); `g4-unit02-pg-contracts` and `g4-unit02-mysql-contracts` were green
afterwards.

### Author claims I could not verify

- The two **write** campaign corpora (`g4-write-seed-batch 75000`,
  `g4-write-transport-seed-batch 100000`, 61 MB and 64 MB) — I ran only the two
  read children the brief names; the author's comparison receipt is internally
  consistent.
- The 59 fixed modes and the 23 native modes are single runs by the author; I
  re-ran six of them (g0, g2-generated, g2-contracts, g4-read-contracts,
  g4-unit02-author, both native unit02 modes) and all agree at exact counts.
- The Biome comparison (302 vs 317) is a scratch measurement I did not reproduce.
- No performance cell was re-measured, by the author or by me. D-14 adds a
  synchronous package preparation on `prepare()` and a route construction per
  bare `QueryEngine`; `bind()` forwards, so no client lineage pays the second.
- Whether the 61 + 16 provider differences of findings 1–2 are acceptable is a
  judgement for Arnaud; I classified them, I did not weigh them.
