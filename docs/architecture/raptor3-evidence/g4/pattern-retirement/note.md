# Pattern retirement (D-15) — author note

**Unit.** `pattern-retirement` — retire the `pattern/` experiment and every
production owner it alone kept alive (Arnaud's decision
[D-15](../g4.md), 23:58 2026-09-16).
**Brief.** [`g4/briefs/pattern-retirement.md`](../briefs/pattern-retirement.md)
(with [`common.md`](../briefs/common.md), the twelve rules).
**Base.** `e8114ed9daa808b38234d80cf30547943b013e29` — commit 4, the C-01
cutover, the main tree's HEAD at launch (`git rev-parse HEAD`, 02:36
2026-09-17). Branch `pattern-engine`.
**Evidence.** [`receipts/`](receipts/). Patch: [`retirement.patch`](retirement.patch).

---

## 0. Decision-elimination gate (written before the first deletion)

### 0.1 Required behavior

None. This unit removes code and removes no behavior a client can observe.
Since commit 4 every VibORM client reaches the Raptor 3 route
(`client.ts:489` builds `createCandidateRoute(...)` unconditionally; there is
no routeless path). `pattern/` — the G3 pattern-engine experiment — is not
exported from the package entry, renders in no bundle fixture, and is reached
by no client. The owners underneath it are the shipped V1 engine's SQL
builders, verb operations, result parsers and write-engine fragments: the
machinery Raptor 3 replaced.

### 0.2 Current owner

`src/query-engine/pattern/**` (19 files) is its own owner. It reaches the rest
through ordinary imports. Two further edges keep the V1 estate resolvable:

| Edge | Kind | What it anchors |
| --- | --- | --- |
| `types.ts:69` `PreparedBatchGuard.failure: import("./write-engine/OperationFragment").Failure` | type-only | the whole `OperationFragment → record-series → OperationExecutor` chain |
| `batch-error-attribution.ts:10` `import { createFailureError } from "./write-engine/OperationFragment"` | value | the same chain, from the one surviving consumer |

### 0.3 Smallest proposed change

1. Move the two facts those edges carry to the owners that already publish
   them: the guard's failure **shape** into `types.ts` (which already declares
   every other `PreparedBatchGuard` field), and the one `Failure → Error`
   construction (`createFailureError`) into `batch-error-attribution.ts` (its
   one surviving consumer, which already owns batch attribution).
2. Delete `src/query-engine/pattern/**` and everything that becomes
   unreachable from the 28 `tsdown` entry points afterwards.
3. Delete the suites that addressed the deleted owners; prune the four harness
   files that keep surviving cells; prune the manifests, the workspace and the
   two tooling special cases that name the experiment.

**Four** surviving production files change. Two carry the type anchor —
`types.ts` (**+14 / −1**) and `batch-error-attribution.ts` (**+34 / −2**) — and
two are **comment-only** docblock restatements:
`raptor3/shared/operation-context.ts` (+7 / −6, §4.1) and
`validation/relations/order-by.ts` (+5 / −4, §3.6). Across every production
`.ts` the diff is **+60 / −41,285 across `src/**/*.ts`, of which 12 insertions
are the two comment-only restatements**
(`git diff --numstat e8114ed9 -- 'src/***.ts'`). No surviving production file
changes beyond those four.

### 0.4 The decisions that disappear

| Decision | Mechanism | Consumers | Replacing invariant | Falsifier |
| --- | --- | --- | --- | --- |
| "Is there a second way to compile a VibORM operation?" | the `pattern/` experiment: `construct`/`construct-read`/`pack`/`match`/`schedule`/`sugar`/`cells` and its `execute/` substrate — a whole parallel compiler, scheduler and executor | nothing outside itself; no package entry, no bundle fixture, no client | **One compiler.** After C-01 `raptor3/` is the only thing a client reaches, and after this unit it is the only thing on disk that can compile an operation | **registered**: `dead-symbol-gate.core.test.ts`'s estate cell fails if `src/query-engine/pattern/` is back on disk, and four symbol cells (`constructPattern`, `constructMemberPatterns`, `matchWriteResult`, `ScheduledFragment`) fail if the experiment's vocabulary reappears anywhere in `src/` CODE under any path. Also `grep -rn "query-engine/pattern" src/ tests/ scripts/` returns nothing and the census reports no `pattern/` file |
| "What does a V1 operation lower to, and who executes it?" | `write-engine/` (`OperationFragment`, `OperationExecutor`, `record-series`, `FragmentValidator`, `Part`, `StepScope`, `race-retry`, `relation-membership`, `relation-nullability`, `generated-output-boundary`, `messages`, `fragment-builders`, `create-race-pin`, `shared`, `link-target-groups`, `series-result-read`, `target-projection`) | `pattern/` and the type anchor | **Raptor 3's commands own lowering and execution** (`raptor3/AGENTS.md`: the route "opens, closes and retries nothing, and never falls back to the shipped engine") | **registered**: `dead-symbol-gate.core.test.ts`'s estate cell pins `write-engine/` at exactly `parse-boundary.ts` (plus the two RETIRED-headed guides) and twelve symbol cells (`OperationFragment`, `OperationExecutor`, `FragmentValidator`, `RecordSeriesOperation`, `StepScope`, `createRacePin`, `markRaceable`, `isRetryableRace`, `buildSeriesResultReads`, `buildTargetProjection`, `groupLinkTargets`, `executeSkippableWrite`) fail on a resurrection under any path. Also: an import of any deleted owner fails to resolve |
| "How does a V1 verb build its SQL?" | `builders/**` (39 files) and `operations/**` (19 of 20) — a second public-syntax walker for select, where, orderby, cursor, aggregate, groupby, polymorphic reads and relation mutation | `pattern/`, `write-engine/`, each other | **`raptor3/shared/query.ts` prepares selectors and projections once per admission scope**, and the adapters spell the SQL (common brief rules 5 and 6) | **registered**: `dead-symbol-gate.core.test.ts`'s estate cell fails if `src/query-engine/builders/` is back on disk, and six symbol cells (`JunctionStatements`, `TargetConstraint`, `uniqueConflictTarget`, `buildSubqueryInclude`, `buildLateralInclude`, `buildMutationProjectionFold`) fail on a second walker under any path. Also plan §7 row "duplicated downstream public-verb algorithms = 0", grep-proven |
| "How is a provider row decoded into a result?" | `result/ResultParser.ts` and its 12 parser siblings | `pattern/`, `write-engine/OperationExecutor`, `write-engine/series-result-read` | **Raptor 3 decodes at its own prepared projection**, and the existing validation/schema codecs own scalar meaning; only the **cache** codecs in `result/` are shared, and they stay | **registered**: four `dead-symbol-gate.core.test.ts` symbol cells (`ResultParser`, `createRowParser`, `parseResultRows`, `decodeRelationCarrier`) fail if the V1 parser tree reappears under any path. Also `result/` keeps exactly the 7 files `cache-flow.ts`, `pending-operation.ts`, `client/typescript-type-renderer.ts` and `raptor3/route/client-route.ts` import |
| "Which file declares what a prepared batch guard's failure is?" | `write-engine/OperationFragment.Failure`, borrowed across a layer boundary by `types.ts:69` | `types.ts`, `batch-error-attribution.ts` | **The guard's owner declares the guard.** `PreparedBatchGuard` lives in `types.ts`; its `failure` field is now declared there with its five siblings, and the one `Failure → Error` construction lives with the one algorithm that performs it | `grep -rn "write-engine/OperationFragment" src/` returns nothing; `batch-attribution-hazard-signature.core.test.ts` still builds a guard and still gets the same errors |
| "Do the census and the baseline instrument have to pretend a directory is not there?" | `scripts/measure-raptor3-baseline.mjs:114` (the `pattern/` exclusion) and `:356` (the `/pattern/` filter) — the excluded-experiment accounting. **Not `scripts/query-engine-structure.mjs`**, which at `e8114ed9` is 278 lines and contains no occurrence of the string `pattern` at all: the brief mis-attributed the two coordinates and round 1 of this note repeated it. The special cases were always in the baseline instrument, and that is the file the patch edits | every cost receipt since G1 | **Nothing is excluded because the excluded thing is gone.** The census counts the tree as it is | the census's own `excluded` field is absent and the charged perimeter with and without the special case is the same number (§4) |

**Not claimed.** This unit does not move a surviving file, does not rename
anything, does not change a public type, and adds no behavior. The
`write-engine/` survivor (`parse-boundary.ts`) stays where it is; moving it
under `raptor3/` is recorded as a follow-up (§6).

---

## 1. The reachability re-run, on the cutover tree (brief item 2)

The receipt's method, re-implemented and re-run at the base commit:
resolve every import specifier (tsconfig `paths`, relative, `.js`→`.ts`,
directory `index.ts`, and type-position `import("…")`) from the
`tsdown.config.ts` entry points, with and without every file under
`src/query-engine/pattern/` as an extra seed. Script:
[`receipts/reachability.mjs`](receipts/reachability.mjs); raw result
[`receipts/reachability-before.json`](receipts/reachability-before.json).

| | stage-2 receipt (2026-09-16) | this re-run (base `e8114ed9`) |
| --- | ---: | ---: |
| tsdown entry points | 29 | **28** |
| `src/**/*.ts` on disk | — | **549** |
| reachable from entries | 487 | **486** |
| reachable with `pattern/` seeded | 523 | **530** |
| `pattern/` files / lines | 11 / 10,579 | **19 / 12,712** |
| retained only via `pattern/` | **25 / 7,855 lines** | **25 / 7,855 lines** |

**The 25 are byte-identical to the receipt's list** — same files, same
7,855-line total (the receipt counts a file's lines as `split("\n").length`,
one more than `wc -l` per file; 7,855 is the same number under both because
the comparison is the receipt's own). Nothing moved since stage 2.

Three of the receipt's other counts do not reproduce, and each has a cause:

- **29 → 28 entries.** `tsdown.config.ts` has 28 entries and has not been
  touched since `f392c4b2` (`git log -- tsdown.config.ts`), long before the
  cutover. The receipt's 29 was a miscount; it does not change the reachable
  set (the count is of seeds, and every seed is still a seed).
- **11 → 19 `pattern/` files.** The receipt counted only
  `src/query-engine/pattern/*.ts` (11 files, 10,568 lines by `wc -l`) and not
  the 8 files under `pattern/execute/` (2,144 lines). D-15's "19 files,
  ≈ 10,600 lines" pairs the correct file count with the 11-file line count.
  The true size of the experiment is **19 files / 12,712 lines**.
- **487 → 486 and 523 → 530.** The cutover deleted 33 owners and added
  `routed-operations.ts`; `src/**` went 581 → 549 files. The two totals move
  with it. `retainedOnlyViaPattern` is a set difference and is unchanged.

### 1.1 Where the brief's prose and the reachability disagree

The brief's "what stays" paragraph names five owners as survivors that the
reachability proves are reached from an entry point **only** through
`pattern/`. The brief's own instruction settles it ("verify each by re-running
the receipt's method … the set may have moved") and so does its governing
clause ("Owners the new engine or another surviving layer **genuinely
imports** stay"). Recorded rather than silently resolved:

| Named as staying | Measured on the cutover tree | Disposition |
| --- | --- | --- |
| `JunctionStatements.ts` | sole production importer `pattern/pack.ts`; it is item #1 of the receipt's own 25 | deleted |
| `set-builder`, `find-common`, `groupby`, `groupby-having`, `mutation-identity` — "the helpers `raptor3/shared/query.ts` and `schema.ts` import" | **`raptor3/**` imports no `builders/` or `operations/` file at all.** Its only six edges into `src/query-engine/` outside itself are `types.ts` (×3), `result/cache-value-codecs.ts`, `bind-budget.ts` and `write-engine/parse-boundary.ts` | deleted |
| `unique-conflict-target.ts`, `TargetConstraint.ts` | sole production importers `write-engine/fragment-builders.ts` and `write-engine/shared.ts`, both inside the chain the type anchor releases | deleted |
| `result/**` | 7 of its 20 files are genuinely imported (the cache codecs, `result-shape`, `result-column`, `result-aggregate-leaf`); the other 13 are the V1 parser tree, reached only from `pattern/` and `write-engine/` | 13 deleted, 7 kept |
| `write-engine/shared.ts` (brief: "delete if orphaned, keep as a named boundary if imported") | production importers `OperationExecutor.ts` and `series-result-read.ts`, both deleted. Its only cross-layer export, `UnsupportedOperationError`, is a **one-line re-export of `@errors`** (`shared.ts:755`) | deleted; the one harness consumer re-points at `@errors`, the real owner |

---

## 2. The type-anchor decision (brief item 3)

**What consumes `failure`.** One producer and one consumer, both surviving:

- **Producer** — `raptor3/shared/operation-context.ts#packagedPresence`
  (`:1036`) publishes `{ kind: "notFound", message, raceable: false }` for the
  presence guard it queues ahead of a packaged mutation.
- **Consumer** — `batch-error-attribution.ts` reads `.kind`, `.message`,
  `.relation` and `.raceable` in `sameAttribution` and hands the whole value
  to `createFailureError`, whose only other caller was `OperationExecutor.ts`,
  `series-result-read.ts` and `pattern/execute/**` — all deleted.

**Decision.** The shape goes to `src/query-engine/types.ts`, inline in
`PreparedBatchGuard`, as a named `PreparedGuardFailure` interface beside it.
That file already declares `queryIndex`, `premise`, `probe`, `model` and
`operation`; `failure` was the only field borrowed from another layer. The
`Failure → Error` construction goes to `batch-error-attribution.ts`, the one
algorithm that performs it, which already imports `NestedWriteError` from
`@errors`.

Why not a new file: rule 12 forbids a wrapper-only owner, and the brief
forbids re-creating `OperationFragment` under another name. Why not put the
type in `batch-error-attribution.ts`: `types.ts` would then have to import it
back for the field declaration, making a two-file cycle for one interface.
One direction, two owners, no new file.

This is the whole of the "type anchor relocation": **+10 / −1 lines in
`types.ts`, +37 / −1 in `batch-error-attribution.ts`**, and it releases the
`OperationFragment → record-series → OperationExecutor` chain.

---

## 3. The deletion list

Computed as entry reachability in the rewired graph (the three
`→ OperationFragment` edges cut, `pattern/**` removed), then every `src/` file
that is unreachable and was not already unreachable at the base.
Script [`receipts/closure.mjs`](receipts/closure.mjs), raw
[`receipts/deletion-closure.json`](receipts/deletion-closure.json).

### 3.1 Production — 111 files, 41,272 lines (`wc -l`)

| directory | files | lines |
| --- | ---: | ---: |
| `src/query-engine/pattern/` | 11 | 10,568 |
| `src/query-engine/pattern/execute/` | 8 | 2,144 |
| `src/query-engine/builders/` | 39 | 11,852 |
| `src/query-engine/operations/` | 19 | 3,801 |
| `src/query-engine/write-engine/` | 17 | 7,863 |
| `src/query-engine/result/` | 13 | 3,813 |
| `src/query-engine/` (root: `JunctionStatements.ts`, `TargetConstraint.ts`, `skippable-write.ts`, `unique-conflict-target.ts`) | 4 | 1,231 |
| **total** | **111** | **41,272** |

`src/query-engine/builders/` becomes empty and the directory goes with its
`AGENTS.md`. Four `src/**` files were already unreachable at the base and are
**not** touched by this unit (`raptor3/program/{index,program}.ts`,
`standardSchema.ts`, `standard-schema-spec.d.ts`, the `schema/scalars/*/index.ts`
shells and the `migrations/push` pair): pre-existing, out of scope, recorded
as a follow-up.

### 3.2 Survivors of the three named directories, with the importer that keeps each

| surviving file | kept by |
| --- | --- |
| `write-engine/parse-boundary.ts` | `raptor3/shared/schema.ts` (the typed parse boundary) |
| `operations/groupby-fields.ts` | `result/result-shape.ts` |
| `result/result-shape.ts` | `client/typescript-type-renderer.ts` |
| `result/result-column.ts` | `client/typescript-type-renderer.ts`, `result/cache-result-codec.ts` |
| `result/result-aggregate-leaf.ts` | `client/typescript-type-renderer.ts`, `result/cache-result-codec.ts` |
| `result/cache-result-codec.ts` | `query-engine/cache-flow.ts`, `query-engine/pending-operation.ts` |
| `result/cache-value-codecs.ts` | `raptor3/route/client-route.ts`, `result/cache-result-codec.ts` |
| `result/cache-json-codec.ts` | `result/cache-value-codecs.ts` |
| `result/cache-snapshot-structure.ts` | `result/cache-json-codec.ts`, `result/cache-value-codecs.ts` |
| `builders/` | — nothing survives |

`src/query-engine/` root survivors and their importers are in §3.4 of the
verification below.

### 3.3 Harness — 3,129 files

| what | files | detail |
| --- | ---: | --- |
| `tests/pattern/**` | **3,072** | 33 `.ts` = **9,812 lines** (`wc -l`, the total printed at the bottom of [`receipts/deleted-tests-pattern.txt`](receipts/deleted-tests-pattern.txt)) and 3,039 non-TypeScript files — **3,036 `.json` golden documents + 1 `.jsonc` + 2 `.md`** — 13 MB. The whole experiment estate, per brief item 4 |
| `tests/contracts/engine/**` | **52** | 21,465 lines — the white-box suites of the deleted builders, operations, result parsers and write-engine fragments |
| `tests/contracts/engine/write/architecture-gates.core.test.ts` | **1** | 218 lines. It imports nothing deleted but `readdirSync`s `write-engine/` and requires `OperationExecutor.ts` and `OperationFragment.ts` to exist. Cells (a), (c) and (d) read those two files and have no subject left. The other two survive their subject and still pass on the retired tree — the round-2 reviewer measured both — but neither is worth keeping: **(b)** ("forbids adapters from constructing a `Step`") is **vacuous** now that nothing in `src/` declares the step vocabulary, and **(e)** ("keeps `write-engine` runtime imports acyclic") is **trivially true at one file** — `writeEngine.runtimeImportCycles` over `parse-boundary.ts` alone can only be 0. So the whole file went. What replaces (e)'s real content is `dead-symbol-gate.core.test.ts`'s estate cell, which pins the directory at that one file rather than testing it for cycles |
| `tests/contracts/engine/write/__snapshots__/architecture-gates.core.test.ts.snap` | **1** | 2,596 bytes: the frozen exported-type surface of `write-engine/OperationFragment.ts`, cell (c)'s snapshot. A snapshot of a deleted file, owned by a deleted suite. Deleted with its suite in round 2 (round 1 left it orphaned — reviewer finding 2.5); the now-empty `__snapshots__/` directory goes too |
| `tests/fixtures/planning-published.ts`, `routed-fragment-atom.ts` | **2** | 28 lines each, **already zero-importer** at the base; they fall with the chain they described |
| `benchmarks/read-fastpath-parse.bench.ts` | **1** | 87 lines — an A/B of `ResultParser`'s fast path over synthetic rows |
| **total** | **3,129** | of which 78 carry TypeScript (round 1 was 3,128; round 2 added the orphaned snapshot) |

### 3.4 The four harness files PRUNED rather than deleted

Each imported exactly one deleted owner and keeps cells with a live subject.

| file | edit | what survives |
| --- | --- | --- |
| `tests/fixtures/query-scope.ts` | dropped `parserFor` and its `ResultParser`/`AnyDriver` imports (−14 lines) | `prepareSchema` / `indexFor`, which is all the three surviving `public-client/*omit*` suites use. Without this prune those three suites would have died for a helper they never call |
| `tests/contracts/drivers/transaction-lifecycle.core.test.ts` | dropped the two `executeSkippableWrite` cells and the two helpers only they used (−128 lines) | the whole driver transaction-lifecycle estate. `skippable-write.ts` had no consumer left: the candidate owns skip-duplicates itself |
| `tests/contracts/public-client/errors/prisma-codes.test.ts` | re-pointed `UnsupportedOperationError` at `@errors` | everything. `write-engine/shared.ts:755` was a **one-line re-export** of `@errors`; the test now imports from the real owner (the brief's "one-line re-export shell" case) |
| `tests/contracts/public-client/errors/failure-classification.test.ts` | 4 cells → 2: kept every `classifyFailure` assertion, dropped the `isRetryableRace`/`markRaceable` ones | the public error-taxonomy contract, including "a `meta.raceable` mark never turns a failure into something else". `race-retry.ts`'s helpers had no production reader left — `raptor3` sets `meta.raceable` directly and the route "retries nothing" |

### 3.5 Two stale classifier rows

`tests/contracts/architecture/contract-matrix.core.test.ts` and `tests/inventory.ts`
each carried `{ prefix: "tests/pattern/", layer: "query-engine" }`. Both rows now
match no file; both removed. Neither removal changes a cell's verdict (the
`contract-matrix` red is the pre-existing `tests/raptor3/candidate-handoff.test.ts`
classification gap, §4.2).

### 3.6 One production mirror that lost its twin

`src/validation/relations/order-by.ts` documented `MAX_RELATION_ORDER_DEPTH = 8`
as "MIRRORED by … `builders/relation-orderby-builder.ts` … the two constants must
stay equal", and `orderby-relation-depth.core.test.ts` read both files and
asserted equality. The mirror is deleted, so the docblock and the cell were
restated: **one owner, one constant.** The three rejection cells that exercise
the cap through the public route are untouched. This is the unit's one
production edit outside the type anchor, and the decision it removes is "keep
two constants in step".

---

## 4. Verification

Every command ran serially from `/Users/arnaud/code/viborm` on the pinned
runtime (`node v24.21.0`), one mode per invocation, under the existing
workspace lock. No lock was removed; none was contended. No database was
created, migrated or dropped. Raw receipts under [`receipts/`](receipts/).

| group | result | receipt |
| --- | --- | --- |
| whole-estate typecheck | **ZERO diagnostics** (the terminating condition), on the final tree. 5.19 s wall, 4,937.0 MiB peak sampled process-group RSS, ceiling 8,192 MiB. Zero on all three passes | [`typecheck-final.txt`](receipts/typecheck-final.txt); [`typecheck-1.txt`](receipts/typecheck-1.txt) (straight after the deletions), [`typecheck-2.txt`](receipts/typecheck-2.txt) |
| `pnpm package:build` | exit 0, "Build complete in 1968ms", **181 files**. 2.32 s wall, 782.8 MiB peak | [`package-build.txt`](receipts/package-build.txt) |
| 3 bundle fixtures | **byte-identical** to the post-cutover bundles — runtimeBytes, gzipBytes and sha256 all equal for `engine`, `pg-simple`, `pg-relations`. 4 differing fields, all pre-minification module metadata, each explained (§4.1) | [`bundles-comparison.json`](receipts/bundles-comparison.json), [`bundles-run.txt`](receipts/bundles-run.txt) |
| 59 fixed modes through the driver | **59 / 59 green, 1,701 cells, ZERO cell-count differences** against the cutover's round-3 receipt | [`fixed/RUN.log`](receipts/fixed/RUN.log) + one log per mode |
| 12 native PostgreSQL modes (`docker port viborm-raptor3-g3-pg-20260914 5432` → `127.0.0.1:55729`) | **12 / 12 green, 64 cells**, every count equal to round 3 | [`native-pg/RUN.log`](receipts/native-pg/RUN.log) |
| 11 native MySQL modes (`docker port viborm-raptor3-g3-mysql-20260914 3306` → `127.0.0.1:55730`) | **11 / 11 green, 69 cells**, every count equal to round 3 | [`native-mysql/RUN.log`](receipts/native-mysql/RUN.log) |
| support: receipts self-test | **39 / 39** | [`support/receipts-selftest.log`](receipts/support/receipts-selftest.log) |
| support: CLI self-test alone | **10 / 10** | [`support/cli-selftest.log`](receipts/support/cli-selftest.log) |
| support: structure census | exit 0 | [`census-after.txt`](receipts/census-after.txt) |
| support: driver integration (`layer-client`, 1,536 MiB RSS ceiling) | **2 files / 16 tests** | [`support/driver-integration.log`](receipts/support/driver-integration.log) |
| support: credential-free `--only "Raptor 3 fixed"` | **65 files / 758 tests green** | [`support/credential-free-fixed.log`](receipts/support/credential-free-fixed.log) |
| support: credential-free `--only "raptor3-provider:"` | **1 file / 2 tests green** | [`support/credential-free-provider.log`](receipts/support/credential-free-provider.log) |
| four G4 campaign first children | **all four byte-identical to the attempt-6 archives** apart from the identity fingerprint, which must move | [`campaigns/corpus-comparison.json`](receipts/campaigns/corpus-comparison.json) |
| `pnpm test:coverage:policy` | **11 / 11 + 16 / 16 + 6 / 6**, exit 0 for all three commands | [`coverage-policy.log`](receipts/coverage-policy.log) |
| `core-taxonomy-census.core.test.ts` | **4 / 4** | [`core-taxonomy-census.log`](receipts/core-taxonomy-census.log) |
| `pnpm test:core` (`--project='layer-*'`) | **6 failed files / 11 failed tests of 395 files / 8,211 tests — exactly the base's red set, file for file and cell for cell** (§4.2), on the final tree | [`test-core-final.log`](receipts/test-core-final.log); [`test-core-2.log`](receipts/test-core-2.log) |
| no project matches no file | every manifest array non-empty, **0 manifest entries naming a missing file**; `layer-write-engine` (4 files after pruning) runs **4 / 4, 23 cells** | [`layer-write-engine.log`](receipts/layer-write-engine.log) |
| plan §7 architectural rows | grep-proven, all 0 | [`plan7-greps.txt`](receipts/plan7-greps.txt) |
| `npx biome check`, 15 edited files | 17 diagnostics, **every one pre-existing at HEAD**, coordinates proven outside this unit's hunks. Biome `--write` was never run on a whole file | [`biome-check.txt`](receipts/biome-check.txt) |

### 4.1 The bundles — every byte of difference

The brief says to compare against `g4/cutover-execution/receipts/`. The
top-level `receipts/bundles-after.json` there is the **round-1/2** measurement
and is superseded: D-14 (round 3) made a bare `QueryEngine` provision its own
route, which pulls the whole candidate into the `engine` fixture
(93 → 176 modules, 123,093 → 329,134 runtime bytes). The post-cutover authority
is [`round3/bundles-after.json`](../cutover-execution/receipts/round3/bundles-after.json),
and against it:

| fixture | runtime bytes | gzip bytes | sha256 | verdict |
| --- | ---: | ---: | --- | --- |
| `engine` | 329,134 = 329,134 | 92,390 = 92,390 | `1e0a7878…d4be` | **identical** |
| `pg-simple` | 624,922 = 624,922 | 184,023 = 184,023 | `231a3b64…7605` | **identical** |
| `pg-relations` | 625,203 = 625,203 | 184,152 = 184,152 | `b10a9bdd…ddb7` | **identical** |

Four fields differ, all pre-minification module metadata:

1. `engine` `modules[107]` `src/validation/relations/order-by.ts` renderedLength **3,490 → 3,571** (+81) — the restated docblock of §3.6.
2. `engine` `modules[165]` `raptor3/shared/operation-context.ts` renderedLength **60,668 → 60,727** (+59) — the restated provenance docblock the brief asked for.
3. / 4. `pg-simple` and `pg-relations` module count **311 → 310**:
   `write-engine/OperationFragment.ts` (renderedLength 837, renderedExports
   `["createFailureError"]`) is gone, and `batch-error-attribution.ts` grew
   **3,494 → 4,359** (+865) — the same function, in its new owner.

Total pre-minification delta: **+168 bytes** (81 + 59 + 865 − 837). The minifier
strips comments and module boundaries, which is why every measured artifact is
byte-identical. **`write-engine/` now renders exactly one module —
`parse-boundary.ts` — in all three fixtures**, where the public PostgreSQL
fixtures previously rendered two.

### 4.2 The core lane's red set — unchanged, cell for cell

Commit 4's message records the base as **6 failed files / 11 failed tests**.
This tree reports the same 6 files and the same 11 cells:

| file | cells | class |
| --- | ---: | --- |
| `public-client/official-cache-swr.core.test.ts` | 1 | D-16 |
| `public-client/query-interceptors-array.core.test.ts` | 3 | D-16 |
| `public-client/query-interceptors-integration.core.test.ts` | 2 | D-16 |
| `architecture/contract-matrix.core.test.ts` | 1 | pre-existing registration gap (`tests/raptor3/candidate-handoff.test.ts` unclassified) |
| `engine/query/bulk-insert-row-shapes.core.test.ts` | 1 | D-16 family 18, the empty-filter bulk mutation |
| `engine/query/select-mode-capability-matrix.core.test.ts` | 3 | D-16 (quote style, error class) |

The first run after the deletions had **one** new red —
`orderby-relation-depth.core.test.ts`, `ENOENT` on the deleted
`builders/relation-orderby-builder.ts` ([`test-core-1.log`](receipts/test-core-1.log)).
It was repaired as §3.6 and the lane returned to the base's set, on
[`test-core-2.log`](receipts/test-core-2.log) and again on the final tree after
the last two harness edits ([`test-core-final.log`](receipts/test-core-final.log)).
**No cell of this unit's making is red.**

The lane's totals move with the deletion: 464 files / 9,301 tests → **395 files
/ 8,211 tests**. Every lost cell addressed a deleted owner.

---

## 5. The cost census, and the four §7 questions

### 5.1 Charged production, with and without the special case

The brief asks for the charged perimeter **with and without** the tooling
special case so the numbers stay comparable with the frozen baseline. The
special case is gone from `scripts/measure-raptor3-baseline.mjs`, so "after"
has only one value.

| perimeter | files | bytes | physical LOC | token LOC |
| --- | ---: | ---: | ---: | ---: |
| frozen baseline (`raptor3-evidence/baseline.json`) | 161 | 2,292,906 | 64,980 | 49,887 |
| **before**, with the special case (= cutover round 3) | 139 | 1,423,012 | 42,335 | 31,664 |
| **before**, without it (`pattern/` 19 files + `builders/projection-select.ts` charged: +20 files, +486,754 bytes, +14,548 physical, +12,100 token) | 159 | 1,909,766 | 56,883 | 43,764 |
| **after** (no special case exists) | **48** | **536,396** | **15,656** | **11,732** |

| §7 size target | target | before (with) | before (without) | **after** | verdict |
| --- | ---: | ---: | ---: | ---: | --- |
| charged production **token**-LOC | ≤ 0.60 | 0.6347 | 0.8773 | **0.2352** | **MET**, by 36 points |
| charged production **physical** LOC | ≤ 0.70 | 0.6515 | 0.8754 | **0.2409** | **MET** |
| charged production bytes (reported) | — | 0.6206 | 0.8329 | **0.2339** | — |
| comparable `engine` bundle gzip | ≤ 0.75 | unchanged | — | **unchanged** | met (and see §4.1 D3: that fixture is not a candidate size result) |
| public PostgreSQL client bundle gzip | ≤ 1.00 | unchanged | — | **unchanged** | met |

The "without" column is the honest statement of what the tree cost before this
unit: **0.8773, not 0.6347.** The 0.6347 was only reachable because the census
excluded 20 charged files by name. D-15's "the remaining 3.4 points" is
measured against the WITH column; the unit removes 40 points from it and 64
from the honest one.

`accounting.charged` excludes `src/query-engine/raptor3/` as
`excluded-experiment` ("Private G1 candidates … not the public operation
route"). Since C-01 that reason is false — raptor3 IS the public operation
route — but changing it re-bases every cost receipt since G1 and is not what
D-15 authorized. It is recorded as follow-up F-1 with both numbers: the
candidate's own complete charged cost (`privateCandidates.candidates.commands.total`)
moved **14,590 → 14,060 token-LOC** (−530: `JunctionStatements.ts` and
`unique-conflict-target.ts` left its retained set).

### 5.2 Structure census, `src/query-engine`

| | files | lines | token lines | functions | branch nodes | runtime import cycles |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| before (cutover round 3) | 149 | 58,206 | 46,543 | 2,816 | 6,854 | 2 components / 14 files |
| **after** | **38** | **16,980** | **14,511** | **986** | **2,280** | **1 component / 2 files** |
| `write-engine/` before | 18 | 7,961 | 5,903 | 390 | 771 | 0 |
| `write-engine/` after | **1** | **98** | **41** | **2** | **3** | 0 |

The import-cycle drop is a real structural result, not an artefact: the
component that disappeared lived inside the deleted `builders/`↔`operations/`
tangle.

### 5.3 Identity

| | production | harness |
| --- | --- | --- |
| base (`e8114ed9`, cutover round 4) | `50c0ee97fb1458333c818735da4c92b7bca89daa65929199c00ef551533b7a63` | `02f0489ce79b9dc47903e1119603a87e478a911c68ae890e37dc93b54483ebb0` |
| **after the last edit** | **`841ae5fb3b1ea31ad9bdad2c531e74935172338b86c58667360d455cea205645`** | **`da070a15ff1ceed4bf0c03b981194579f8f45bcdd381702d9d4df79db5340ea9`** |

`runtime` unchanged (`v24.21.0`, darwin/arm64, better-sqlite3 12.6.0, Vitest
3.1.4). Both fingerprints must move: this is a production change and a harness
change. [`identity-after.json`](receipts/identity-after.json).

### 5.4 The four §7 decision-elimination questions, against this diff

1. **Necessary decision or representation repair?** Neither: the unit adds no
   rule. It deletes six (§0.4). The two things it *moves* — the guard-failure
   shape and the one `Failure → Error` construction — are a **representation
   repair**: `PreparedBatchGuard` declared five fields itself and borrowed the
   sixth from another layer, which is precisely "two representations of the
   same fact" with an import edge holding them together. The edge is gone and
   the fact has one owner.
2. **Exact deletion and replacement obligation?** §0.4 names each removed
   decision, its mechanism, its consumers, the replacing invariant and a
   falsifier. No equivalent mechanism moved elsewhere: `plan7-greps.txt` shows
   zero `src/` imports of a deleted owner, zero `src/` CODE references to a
   deleted symbol, `builders/` gone from disk and `write-engine/` at one file.
   Nothing under `raptor3/` grew: its `language` and `shared` token-LOC are
   **unchanged** (3,450 and 6,213) in `source-cost-after.json`.
3. **One rule across uses?** The type-anchor move is exercised through both its
   consumers: `batch-attribution-hazard-signature.core.test.ts` builds a
   `PreparedBatchGuard` literal against the new `PreparedGuardFailure` and gets
   the same errors (green in the core lane), and the candidate's own producer
   (`operation-context.ts#packagedPresence`) is exercised by the 59 fixed modes
   and both native providers — all green, all cell-counts exact. The four G4
   campaign corpora are byte-identical, which exercises the same path across
   115,000+ generated cells.
4. **What actually grew?** Nothing. **Net charged production token-LOC
   −19,932** (31,664 → 11,732 on the WITH perimeter; −32,032 on the honest
   one). Production insertions, measured with
   `git diff --numstat e8114ed9`: **+48 production lines, −3** in the two
   anchor files — `types.ts` **+14 / −1** and `batch-error-attribution.ts`
   **+34 / −2**. Across every production `.ts` the diff is **+60 / −41,285
   across `src/**/*.ts`, of which 12 insertions are the two comment-only
   restatements** (`raptor3/shared/operation-context.ts` +7 / −6,
   `validation/relations/order-by.ts` +5 / −4); comment lines are not
   token-bearing. Harness: **3,129 files / ~122,000 lines removed, 173 lines
   of pruning edits, and the registered dead-symbol gate extended +73 / −10**.
   Tests and evidence are counted separately, as §7 requires.

---

## 6. Follow-ups

- **F-1 — the baseline instrument still excludes `raptor3/` by name.**
  `classify()` returns `excluded-experiment` for `src/query-engine/raptor3/`
  with the reason "Private G1 candidates … not the public operation route",
  which C-01 falsified. Re-basing it makes `accounting.charged` the whole
  shipped engine and is the honest perimeter, but it re-bases every cost
  receipt since G1. **Arnaud's call**, not this unit's; both numbers are in
  §5.1.
- **F-2 — move the last boundaries under `raptor3/`.** The brief asks for this
  list explicitly. `write-engine/` holds one file:
  | survivor | importer | proposed home |
  | --- | --- | --- |
  | `write-engine/parse-boundary.ts` | `raptor3/shared/schema.ts` (its only importer) | `raptor3/shared/` |
  `operations/` holds one: `groupby-fields.ts`, imported by
  `result/result-shape.ts`. `builders/` no longer exists. Doing either move in
  this unit would have been a rename the brief forbids.
  **Two harness files move with `parse-boundary.ts`:**
  `tests/contracts/engine/write/parse-boundary-gate.core.test.ts:39` sets
  `const ENGINE = join(SOURCE_ROOT, "query-engine/write-engine")` and
  `readdirSync`s it, so its three ratchets now measure exactly one file and
  must be **re-pointed at `raptor3/`** when the boundary moves — otherwise the
  move silently empties the gate (reviewer finding 2.7). And
  `dead-symbol-gate.core.test.ts`'s estate cell pins
  `write-engine/ = [ATOM.md, README.md, parse-boundary.ts]`; that cell is the
  thing that reddens on the move, which is the intended signal.
- **F-3 — the two coverage floors were measured over estates that no longer
  exist.** `test:coverage:query-engine-core`'s branch exception cites
  `result-count-parser.ts` and `result-row-parser.ts` (deleted) and
  `test:coverage:write-engine`'s floors (82 / 80.5 / 92 / 82) were measured
  over 18 files; the root now holds one. `scripts/coverage-policy.mjs` is
  unchanged and `pnpm test:coverage:policy` is green (it validates
  registration, not percentages), but the floors are re-measurement work.
  `AGENTS.md` now says so. The same re-measurement must re-point
  `parse-boundary-gate.core.test.ts`'s `ENGINE` at `raptor3/` (F-2): its
  ceilings were measured over 18 `write-engine/` files and are now counted over
  one, so they pass for the wrong reason until the scope follows the boundary.
- **F-4 — `meta.raceable` is written and never read.** `raptor3` sets it in
  four places; the only readers were `race-retry.ts` and `OperationExecutor`,
  both deleted, and `raptor3/AGENTS.md` says the route "retries nothing". The
  bit still rides on the error for callers, and `createFailureError` still
  sets it. Surfaced, not repaired: whether the candidate should retry a
  raceable failure is a compatibility decision (class D), not this unit's.
- **F-5 — nineteen `src/` files are unreachable from every entry point and were
  already unreachable at the base.** `raptor3/program/{index,program}.ts` (638
  lines, the retained G1-01 comparison specimen), `standardSchema.ts` +
  `standard-schema-spec.d.ts`, the eleven `schema/scalars/*/index.ts` shells,
  and `migrations/push/{executor,index}.ts` + `migrations/storage/index.ts`.
  Pre-existing, out of this unit's scope, listed in
  [`reachability-before.json`](receipts/reachability-before.json).
- **F-6 — `write-engine/ATOM.md` and `README.md` describe a deleted engine.**
  Eleven plans under `docs/architecture/` cite ATOM.md, so deleting it would
  break them. Both gained a RETIRED header pointing at `raptor3/AGENTS.md`;
  whether they should move under `docs/architecture/` is a documentation call.

---

## 7. Commit-message draft

```
refactor(query-engine): retire the pattern experiment and the owners it kept alive

Arnaud's decision D-15. The pattern engine was a G3 experiment: not exported
from the package entry, rendered by no bundle fixture, reached by no client.
It was also the last thing holding up the V1 estate. Retiring it deletes 111
production files and 41,272 lines.

What went, and why each was safe to delete: the reachability receipt's method
(import-graph reachability from the 28 tsdown entry points, with and without
pattern/ as an extra seed) was re-run on this base and reproduced the stage-2
set exactly — 25 owners, 7,855 lines, reachable only through pattern/. With
pattern/ gone and the type anchor moved, the closure is:

  src/query-engine/pattern/          19 files  12,712 lines
  src/query-engine/builders/         39 files  11,852 lines  (the whole layer)
  src/query-engine/write-engine/     17 files   7,863 lines  (all but parse-boundary.ts)
  src/query-engine/operations/       19 files   3,801 lines  (all but groupby-fields.ts)
  src/query-engine/result/           13 files   3,813 lines  (the V1 parser tree)
  src/query-engine/ root              4 files   1,231 lines

The type anchor: types.ts declared PreparedBatchGuard.failure as
import("./write-engine/OperationFragment").Failure, which kept the whole
OperationFragment -> record-series -> OperationExecutor chain resolvable. The
guard's owner now declares the guard: PreparedGuardFailure sits in types.ts
beside the five fields it already owned, and the one Failure->Error
construction (createFailureError) moved into batch-error-attribution.ts, its
one surviving consumer. +48 production lines, -3 (types.ts +14/-1,
batch-error-attribution.ts +34/-2); across src/**/*.ts the diff is +60 /
-41,285, of which 12 insertions are two comment-only docblock restatements. No
wrapper file, no OperationFragment under another name.

Harness: tests/pattern/** (3,072 files, 13 MB), the layer-pattern project, 52
tests/contracts/engine suites, the write-engine architecture gate whose two
subjects are gone (with its orphaned OperationFragment snapshot), two
already-orphaned fixtures and one benchmark. Four files
were pruned instead of deleted so their live cells survive: query-scope.ts
loses parserFor, transaction-lifecycle loses two executeSkippableWrite cells,
prisma-codes re-points UnsupportedOperationError at @errors (write-engine/
shared.ts:755 was a one-line re-export of it), failure-classification keeps
its classifyFailure assertions and drops the isRetryableRace ones. The
manifests, vitest.workspace.ts and the two tooling special cases in
measure-raptor3-baseline.mjs are pruned; the census now counts the tree as it
is.

The deletion keeps a registered falsifier rather than a grep in a note:
dead-symbol-gate.core.test.ts, already in the core lane, gains the 26 D-15
module and symbol names (OperationFragment, OperationExecutor,
RecordSeriesOperation, FragmentValidator, ResultParser, JunctionStatements,
TargetConstraint, executeSkippableWrite, uniqueConflictTarget and the rest, one
group per retired decision) and one estate cell: builders/ and pattern/ are off
disk and write-engine/ holds exactly parse-boundary.ts beside its two
RETIRED-headed guides. Its docblock no longer calls OperationExecutor a kept
lookalike -- that sentence became false when this change deleted it.

Verification, all green: whole-estate typecheck ZERO diagnostics (the two
historical Pattern TS2345 errors died with pack.ts); 59 fixed modes 59/59,
1,701 cells, zero cell-count differences; 12 native PostgreSQL and 11 native
MySQL modes green with identical counts; the support group green; all four G4
campaign first children byte-identical to the attempt-6 archives; coverage
policy 11/11; taxonomy census 4/4; package:build exit 0; the three bundle
fixtures byte-identical to the post-cutover bundles (runtimeBytes, gzipBytes
and sha256 all equal), with write-engine/ now rendering one module instead of
two. pnpm test:core is 6 files / 11 tests red -- exactly the base's set, file
for file and cell for cell; no cell of this change's making is red.

Cost, against the frozen baseline (49,887 / 64,980 / 2,292,906): charged
production token-LOC 31,664 -> 11,732, ratio 0.6347 -> 0.2352 (plan section 7
target 0.60, MET); physical 42,335 -> 15,656, 0.6515 -> 0.2409 (target 0.70,
MET). Measured without the deleted special case, the base was really 0.8773.
src/query-engine: 149 files -> 38, 46,543 token lines -> 14,511, runtime
import cycles 2 components / 14 files -> 1 / 2. write-engine/: 18 files -> 1.

Identity 50c0ee97 -> 841ae5fb (production), 02f0489c -> da070a15 (harness).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

*(Round 2 supersedes this draft. The final message — this one plus the
registered-falsifier paragraph and the corrected harness total — is §9.4.)*

---

## 8. Blockers and unverified claims

**Blockers: none.** Every verification group is green, and the terminating
condition (zero typecheck diagnostics) held on the first pass after the
deletions.

**Unverified claims, stated as unverified:**

1. **The four campaign corpora were compared with this unit's own body hash,
   not round 3's.** Both sides (the rerun and the attempt-6
   `generated-corpus.json.gz`) go through the identical strip-identity-then-
   `JSON.stringify` path, so `bodyIdentical: true` is sound; but the printed
   `bodySha256` for `g4-transport-seeds` (`2db16d09…`) is not comparable with
   round 3's (`c8d9878a…`) because round 3 stripped the identity differently.
   `g4-seeds` (`55949767…`), `g4-write-seeds` (`2cfe836e…`) and
   `g4-write-transport-seeds` (`2547b8db…`) do match round 3's printed values.
2. **The full `pnpm test:all` was not run.** The brief's list does not include
   it, and it is the campaign-length lane. The credential-free selectors it
   names were run and are green. The provider lanes that commit 4 records as
   KNOWN RED (provider-sqlite3/libsql 61, pg-nested-write-races 13, mysql2 13)
   were **not** re-run: nothing this unit deleted is reachable from them, but
   that is an argument, not a measurement.
3. **The two coverage reports themselves were not run** (`test:coverage:
   query-engine-core`, `test:coverage:write-engine`). `test:coverage:policy`,
   which is what the brief lists, is green. F-3 records the floors as
   re-measurement work.
4. **`parse-boundary-gate.core.test.ts` and `dead-symbol-gate.core.test.ts`
   now scan a much smaller tree** and pass. Both are ratchets whose ceilings
   may only shrink, so passing is expected; no one has re-derived whether the
   ceilings are still meaningful at one file.
5. **The 20-file "before, without the special case" figure is arithmetic, not a
   second instrument run.** `pattern/` + `projection-select.ts` were measured
   from `e8114ed9` for bytes (486,754) and physical lines (14,548) directly;
   the 12,100 token-LOC is the difference between the round-3 and current
   `excluded-experiment` classification totals, which also contains the +1 line
   of the `operation-context.ts` docblock restatement. It is accurate to ±1
   line.

---

## 9. Round 2 — the independent review's resolutions

Review: [`g4/pattern-retirement-review.md`](../pattern-retirement-review.md),
outcome **REVISE**, no blocking finding, two must-fix items and eight notes.
The reviewer re-derived the deletion closure with a different method (a real
`ts.Program` over the 28 `tsdown` entries) and got the same 111 files, byte-
identical bundles and the census to the digit, and turned unverified claim #5
into a measurement. Every finding was documentary. **This round changes no
shipped behaviour and deletes no further production code**; it adds the
registered falsifier the retirement was missing, deletes one orphaned snapshot,
extends a documentation pointer, and corrects the counts.

Round-2 receipts: [`receipts/round2/`](receipts/round2/).

### 9.1 The two must-fix items

**M-1 — the line counts (review §2.1).** Measured with
`git diff --numstat e8114ed9`:

| perimeter | round 1 said | measured |
| --- | --- | --- |
| `src/query-engine/types.ts` | +10 / −1 | **+14 / −1** |
| `src/query-engine/batch-error-attribution.ts` | +37 / −1 | **+34 / −2** |
| the two anchor files together | "+47 production lines, −2" | **+48 production lines, −3** |
| all production `.ts` | not stated | **+60 / −41,285 across `src/**/*.ts`, of which 12 insertions are the two comment-only restatements** (`raptor3/shared/operation-context.ts` +7 / −6, `validation/relations/order-by.ts` +5 / −4) |

Corrected in §0.3, §5.4 question 4 and the §7 commit-message draft, and carried
into the final message (§9.4). **The `g4.md` ledger line "41,272 lines deleted
against 47 inserted" is NOT corrected here** — the ledger is the integrator's
file and this unit does not edit it; §9.5 hands it over.

**M-2 — the retirement now ships a registered falsifier (review §2.2).**
Round 1 proved the three largest deletions with greps recorded in
[`receipts/plan7-greps.txt`](receipts/plan7-greps.txt). Nothing executed them.
`tests/contracts/engine/write/dead-symbol-gate.core.test.ts` — already in
`WRITE_ENGINE_CORE_TESTS`, so already in `layer-write-engine`, `pnpm test:core`,
`pnpm test:all` and `coverage-write-engine-core` — was extended instead
(**+73 / −10**, no new file, no new registration):

- `DELETED_V1_SYMBOLS` grows from the 15 P6 names to **41**, the 26 D-15 names
  grouped one block per retired decision: the experiment itself
  (`constructPattern`, `constructMemberPatterns`, `matchWriteResult`,
  `ScheduledFragment`); what a V1 operation lowered to and who executed it
  (`OperationFragment`, `OperationExecutor`, `FragmentValidator`,
  `RecordSeriesOperation`, `StepScope`, `createRacePin`, `markRaceable`,
  `isRetryableRace`, `buildSeriesResultReads`, `buildTargetProjection`,
  `groupLinkTargets`, `executeSkippableWrite`); how a V1 verb built its SQL
  (`JunctionStatements`, `TargetConstraint`, `uniqueConflictTarget`,
  `buildSubqueryInclude`, `buildLateralInclude`, `buildMutationProjectionFold`);
  how a provider row became a result (`ResultParser`, `createRowParser`,
  `parseResultRows`, `decodeRelationCarrier`). Each name was checked to occur in
  no surviving `src/` CODE before being listed, so no cell is listed red.
  A symbol cell's unique coverage is **resurrection under a different path** —
  a copy of `ResultParser` inside `raptor3/` trips it and no directory check
  would.
- One **estate cell**: `src/query-engine/builders` and `src/query-engine/pattern`
  are not on disk, and `src/query-engine/write-engine` holds exactly
  `["ATOM.md", "README.md", "parse-boundary.ts"]` — the one live boundary and
  the two RETIRED-headed guides eleven plans under `docs/` still cite (F-6). Its
  unique coverage is the estate's *shape*: a directory back on disk, or a second
  `.ts` beside the parse boundary, neither of which a symbol scan sees.
- The docblock is restated for the D-15 estate. The old sentence called
  `OperationExecutor` a **"kept lookalike"** that "never trips it" — true under
  P6, false the moment D-15 deleted it, and it would have let a resurrected
  `OperationExecutor` through. It is now a listed dead symbol and the docblock
  says so.
- One deleted module name is deliberately **not** listed: `write-engine/Part.ts`.
  `\bPart\b` is too common a word to be a symbol gate and would redden on an
  unrelated future identifier; the estate cell covers that directory instead.
  Recorded here so the omission is a decision, not an oversight.

**Falsified once, and restored.** Before touching anything the file was copied to
the scratchpad. The mutation was on the tree, not on the test: with
`src/query-engine/builders/` recreated (empty), the run went **1 failed / 42
passed**, the failure naming the directory —

```
× … > leaves no directory of the retired estate on disk
  → expected [ 'builders' ] to deeply equal []
```

— and after `rmdir` the same file is **43 / 43** green inside the
`layer-write-engine` project (§9.3). Receipt:
[`receipts/round2/dead-symbol-gate-falsified.log`](receipts/round2/dead-symbol-gate-falsified.log).
`git status` for `src/query-engine/builders/` is unchanged by the falsification:
an empty directory is untracked by git, so the mutation could not touch the
deletion it was testing.

### 9.2 The eight notes

| # | finding | resolution |
| --- | --- | --- |
| 2.3 | §0.3 named two of four changed production files | §0.3 now names **four** — `types.ts` and `batch-error-attribution.ts` (the anchor) and `raptor3/shared/operation-context.ts` (+7 / −6) and `validation/relations/order-by.ts` (+5 / −4), both marked **comment-only** — with the whole-`src` figure |
| 2.4 | a gate was deleted whole though two cells kept a live subject | §3.3 now says it: cell **(b)** ("forbids adapters from constructing a `Step`") is **vacuous** now that nothing in `src/` declares the step vocabulary, and cell **(e)** (`writeEngine.runtimeImportCycles`) is **trivially true at one file** — 0 cycles over `parse-boundary.ts` alone is not a ratchet. Cell (e) was not rehomed; what replaces its content is the estate cell, which pins the directory at that one file |
| 2.5 | an orphan snapshot survived its deleted suite | `tests/contracts/engine/write/__snapshots__/architecture-gates.core.test.ts.snap` (2,596 bytes, 33 lines — the frozen `OperationFragment` exported-type surface, cell (c)'s subject) **deleted**, and the now-empty `__snapshots__/` directory with it. §3.3 gains the row; the harness total moves 3,128 → **3,129** |
| 2.6 | 27 provenance citations name files that do not exist; the `raptor3/AGENTS.md` blanket header reaches only 22 | the same one-line "read it in git history (`e8114ed9`), not on disk" pointer now covers the **five outside `raptor3/`**, in the guides that own them: `src/adapters/AGENTS.md` (+9) for `database-adapter.ts:664`, `databases/mysql/mysql-adapter.ts:886` and `adapter-capabilities.ts:42`; `src/schema/AGENTS.md` (+7) for `field-ref.ts:31`, naming it as the `{@link file://…}` that now resolves to nothing; `src/validation/AGENTS.md` (+9) for `scalars/negatable-filter.ts:12`, likewise, and noting that `relations/order-by.ts:75` was already restated in place. **Restating the five docblocks in the `.ts` files was declined**: it would add five more changed production files and invalidate the "four changed production files / +60 / −41,285 / 12 comment-only insertions" figures this same review fixes. The remaining 22 keep the `raptor3/AGENTS.md` header; a full restatement stays a follow-up |
| 2.7 | the parse-boundary ratchet now scans a one-file directory | added to **F-2** and **F-3**: `parse-boundary-gate.core.test.ts:39`'s `ENGINE` must be **re-pointed at `raptor3/`** when `parse-boundary.ts` moves, or the move silently empties the gate; and its ceilings, measured over 18 files, now pass for the wrong reason at one |
| 2.8 | §3.3's harness line and document counts disagree with the author's own receipt | corrected: the 33 deleted `tests/pattern/**/*.ts` are **9,812 lines** (`wc -l`, and the total printed at the bottom of `receipts/deleted-tests-pattern.txt`), not 8,645; the 3,039 non-TypeScript files are **3,036 `.json` + 1 `.jsonc` + 2 `.md`**. Both re-measured here from `git ls-tree -r e8114ed9 tests/pattern` |
| 2.9 | the ledger rewrites three recorded timestamps | **not this unit's edit and not applied.** `docs/architecture/raptor3-evidence/g4.md` is the integrator's file and is out of this unit's scope by instruction; §9.5 hands it over |
| 2.10 | §0.4 attributes the census special cases to the wrong script | §0.4's tooling row now names **`scripts/measure-raptor3-baseline.mjs:114` and `:356`**, and records that `scripts/query-engine-structure.mjs` at `e8114ed9` is 278 lines and contains no occurrence of the string `pattern` — the brief mis-attributed the coordinates and round 1 repeated it |

Two further documentary corrections the review did not list, made because they
now contradicted a number on the same page:

- §3.3's heading said "Harness — 3,094 files" while its own table summed to
  3,128. The heading is now **3,129**, the measured count
  (`git status --porcelain | grep -c '^ D tests/\|^ D benchmarks/'`).
- §5.4 question 4 said the docblock restatements "add 13 further comment lines in
  three files". Measured, they are **12 insertions in two `.ts` files**; the
  thirteenth line was the `raptor3/AGENTS.md` header, which is not a `.ts` file
  and is not in the production numstat.

### 9.3 Round-2 receipts

Serially, one mode per invocation, under the existing workspace lock; no lock
was removed or contended, no database touched.

| group | result | receipt |
| --- | --- | --- |
| `node scripts/run-typecheck.mjs`, **with the reviewer's four probe files present** | **ZERO diagnostics**, exit 0 — the terminating condition. 5.22 s wall, 5,005.4 MiB peak sampled process-group RSS, ceiling 8,192 MiB | [`round2/typecheck-round2.txt`](receipts/round2/typecheck-round2.txt) |
| `dead-symbol-gate.core.test.ts` alone (`layer-write-engine`) | **43 / 43 green** (41 symbol cells + the estate cell + the matcher self-check), 493 ms, 366.3 MiB peak | [`round2/dead-symbol-gate.log`](receipts/round2/dead-symbol-gate.log) |
| the same file, **falsified** (`src/query-engine/builders/` recreated) | **1 failed / 42 passed**, naming `expected [ 'builders' ] to deeply equal []`; restored by `rmdir`, directory absent again | [`round2/dead-symbol-gate-falsified.log`](receipts/round2/dead-symbol-gate-falsified.log) |
| `pnpm test:coverage:policy` | **11 / 11 + 16 / 16 + 6 / 6**, exit 0 — round 1's and the reviewer's counts | [`round2/coverage-policy.log`](receipts/round2/coverage-policy.log) |
| `tests/contracts/architecture/core-taxonomy-census.core.test.ts` | **4 / 4** | [`round2/core-taxonomy-census.log`](receipts/round2/core-taxonomy-census.log) |
| the `layer-write-engine` project | **4 files / 50 tests green** (round 1 was 4 / 23; the gate grew from 16 cells to 43) | [`round2/layer-write-engine.log`](receipts/round2/layer-write-engine.log) |
| the gate once more on the finished tree, after the last edit | **43 / 43 green**, 507 ms, 348.1 MiB peak — the falsify → restore → green loop closed | [`round2/dead-symbol-gate-final.log`](receipts/round2/dead-symbol-gate-final.log) |
| `captureRaptor3Identity` after the last edit | production **`841ae5fb…`, identical to round 1** — round 2 changed no `src/**` `.ts`/`.json`. Harness **`9b07f50d…`** on the tree as it stands; with the reviewer's four `tests/raptor3/g4/review/pattern-retirement/` probe files excluded it is **`da070a15…`, exactly round 1's value** | [`round2/identity-after-round2.json`](receipts/round2/identity-after-round2.json), [`round2/identity-harness-attribution.json`](receipts/round2/identity-harness-attribution.json) |
| `retirement.patch` regenerated (`git diff --binary e8114ed9 -- src tests scripts benchmarks vitest.workspace.ts`) | **3,265 files / 318 insertions / 292,416 deletions**; `git apply --check --reverse` **exit 0** | [`retirement.patch`](retirement.patch) |

**Why the identity did not move.** `captureRaptor3Identity` fingerprints
`src/**`, `tests/raptor3/**`, `scripts/**`, `benchmarks/**` and six configuration
files, filtered to `.ts|.mts|.mjs|.js|.json`. Round 2's production edits are
three `AGENTS.md` (not `.ts`) and its harness edits are under
`tests/contracts/**` (not fingerprinted), so **neither fingerprint can move on
this round's work** — and the measured numbers say exactly that. The harness
value differs from round 1 only because the reviewer's probes are on disk; the
attribution receipt reproduces `da070a15…` by excluding those four files and
nothing else. The self-check in that receipt re-implements the manifest's own
hash and reproduces both official fingerprints before filtering, so the filtered
number is the same algorithm, not an approximation.

**The patch delta is exactly this round's work**: 3,260 → 3,265 files
(+`src/adapters/AGENTS.md`, +`src/schema/AGENTS.md`, +`src/validation/AGENTS.md`,
+`tests/contracts/engine/write/dead-symbol-gate.core.test.ts`, +the deleted
snapshot), 220 → 318 insertions and 292,373 → 292,416 deletions, which is
`+9 +7 +9 +73 / −10 −33` and nothing else.

### 9.4 Final commit-message draft

```
refactor(query-engine): retire the pattern experiment and the owners it kept alive

Arnaud's decision D-15. The pattern engine was a G3 experiment: not exported
from the package entry, rendered by no bundle fixture, reached by no client.
It was also the last thing holding up the V1 estate. Retiring it deletes 111
production files and 41,272 lines.

What went, and why each was safe to delete: the reachability receipt's method
(import-graph reachability from the 28 tsdown entry points, with and without
pattern/ as an extra seed) was re-run on this base and reproduced the stage-2
set exactly -- 25 owners, 7,855 lines, reachable only through pattern/. The
independent review re-derived the same closure from a real ts.Program built
from the same entries and found it exact: not a file more, not a file less.
With pattern/ gone and the type anchor moved, the closure is:

  src/query-engine/pattern/          19 files  12,712 lines
  src/query-engine/builders/         39 files  11,852 lines  (the whole layer)
  src/query-engine/write-engine/     17 files   7,863 lines  (all but parse-boundary.ts)
  src/query-engine/operations/       19 files   3,801 lines  (all but groupby-fields.ts)
  src/query-engine/result/           13 files   3,813 lines  (the V1 parser tree)
  src/query-engine/ root              4 files   1,231 lines

The type anchor: types.ts declared PreparedBatchGuard.failure as
import("./write-engine/OperationFragment").Failure, which kept the whole
OperationFragment -> record-series -> OperationExecutor chain resolvable. The
guard's owner now declares the guard: PreparedGuardFailure sits in types.ts
beside the five fields it already owned, and the one Failure->Error
construction (createFailureError) moved into batch-error-attribution.ts, its
one surviving consumer. +48 production lines, -3 (types.ts +14/-1,
batch-error-attribution.ts +34/-2); across src/**/*.ts the diff is +60 /
-41,285, of which 12 insertions are two comment-only docblock restatements. No
wrapper file, no OperationFragment under another name.

Harness: tests/pattern/** (3,072 files, 13 MB), the layer-pattern project, 52
tests/contracts/engine suites, the write-engine architecture gate whose two
subjects are gone (with its orphaned OperationFragment snapshot), two
already-orphaned fixtures and one benchmark -- 3,129 files. Four files were
pruned instead of deleted so their live cells survive: query-scope.ts loses
parserFor, transaction-lifecycle loses two executeSkippableWrite cells,
prisma-codes re-points UnsupportedOperationError at @errors (write-engine/
shared.ts:755 was a one-line re-export of it), failure-classification keeps
its classifyFailure assertions and drops the isRetryableRace ones. The
manifests, vitest.workspace.ts and the two tooling special cases in
measure-raptor3-baseline.mjs are pruned; the census now counts the tree as it
is.

The deletion keeps a registered falsifier rather than a grep in a note:
dead-symbol-gate.core.test.ts, already in the core lane, gains the 26 D-15
module and symbol names (OperationFragment, OperationExecutor,
RecordSeriesOperation, FragmentValidator, ResultParser, JunctionStatements,
TargetConstraint, executeSkippableWrite, uniqueConflictTarget and the rest, one
group per retired decision) and one estate cell: builders/ and pattern/ are off
disk and write-engine/ holds exactly parse-boundary.ts beside its two
RETIRED-headed guides. Its docblock no longer calls OperationExecutor a kept
lookalike -- that sentence became false when this change deleted it. The gate
is 43/43 green, and reddens on the named directory when builders/ is put back.

Verification, all green: whole-estate typecheck ZERO diagnostics (the two
historical Pattern TS2345 errors died with pack.ts); 59 fixed modes 59/59,
1,701 cells, zero cell-count differences; 12 native PostgreSQL and 11 native
MySQL modes green with identical counts; the support group green; all four G4
campaign first children byte-identical to the attempt-6 archives; coverage
policy 11/11; taxonomy census 4/4; package:build exit 0; the three bundle
fixtures byte-identical to the post-cutover bundles (runtimeBytes, gzipBytes
and sha256 all equal), with write-engine/ now rendering one module instead of
two. pnpm test:core is 6 files / 11 tests red -- exactly the base's set, file
for file and cell for cell; no cell of this change's making is red.

Cost, against the frozen baseline (49,887 / 64,980 / 2,292,906): charged
production token-LOC 31,664 -> 11,732, ratio 0.6347 -> 0.2352 (plan section 7
target 0.60, MET); physical 42,335 -> 15,656, 0.6515 -> 0.2409 (target 0.70,
MET). Measured without the deleted special case, the base was really 0.8773.
src/query-engine: 149 files -> 38, 46,543 token lines -> 14,511, runtime
import cycles 2 components / 14 files -> 1 / 2. write-engine/: 18 files -> 1.

Identity 50c0ee97 -> 841ae5fb (production), 02f0489c -> da070a15 (harness).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

### 9.5 Handed to the integrator

- **The `g4.md` ledger line** "41,272 lines deleted against 47 inserted" is
  wrong by the same arithmetic as M-1 and should read **48 inserted, 3 deleted**
  (or the whole-`src` form, +60 / −41,285). Review finding 2.1; not edited here
  because the ledger is the integrator's file.
- **Review finding 2.9**, the three rewritten timestamps in `g4.md`
  ("01:45"→"00:57", "02:15"→"01:32", "02:20"→"01:42"): state the correction and
  its basis, or restore the recorded times. The review itself observes the edit
  may be the integrator's concurrent work on `g4.md` and `final-report.md`, not
  this unit's.
- **The reviewer's probes** at `tests/raptor3/g4/review/pattern-retirement/`
  (3 files, 29 cells, green, typed cleanly, unregistered) are untracked and are
  not in `retirement.patch`. Whether they land is the integrator's call; they
  are the only reason the harness fingerprint reads `9b07f50d…` instead of
  `da070a15…` (§9.3).

### 9.6 Unverified claims after round 2

| claim | status |
| --- | --- |
| #1 the transport corpus body hash | **resolved in the unit's favour by the review** — both G4 read corpora byte-identical to the attempt-6 archives, `2db16d09…` reproducing on both sides |
| #2 `pnpm test:all` and the KNOWN-RED provider lanes were not run | **still unverified.** Not re-run in round 2 either: round 2 touches no production `.ts` and no provider lane's imports, so the round-1 argument is unchanged — and it is still an argument |
| #3 the two coverage reports were not run | **still unverified.** `test:coverage:policy` is green again (§9.3); the floors remain re-measurement work (F-3) |
| #4 the two ratchets scan a much smaller tree | **sharpened and half-addressed.** `parse-boundary-gate` scans exactly one file and F-2/F-3 now say it must follow `parse-boundary.ts` to `raptor3/`. `dead-symbol-gate` is no longer in this class: it scans all 438 surviving `src/**/*.ts` for 41 names and its estate cell was falsified in this round |
| #5 the "before, without the special case" figure is arithmetic | **now measured by the reviewer** — 0.8773 / 0.8754 / 0.8329, exact |
| **new** — round 2's own reach | The five surviving stale citations are mitigated by a **guide-level** pointer, not restated in the `.ts` files; a reader who opens `field-ref.ts` in an editor still sees a `{@link file://…}` that resolves to nothing. Stated as a deliberate trade (§9.2, finding 2.6), not as a repair |
