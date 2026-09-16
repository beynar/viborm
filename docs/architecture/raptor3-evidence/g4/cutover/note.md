# G4 cutover measurement — PREPARATION stage (sections 1 and 2 only)

Unit: `g4-cutover-measurement`, stage 1 of 2. This stage builds the isolated
measurement package and applies the C-01 cutover to it. It runs **no bundle
fixture, no performance series and writes no proposal** — those are stage 2,
against the frozen identity.

- Worktree: `/private/tmp/viborm-g4-perf-candidate`
- Branch: `g4-perf-measurement` (local, throwaway, **never pushed**)
- Base: `0cc61e61`
- Patch of the cutover commit:
  [`cutover.patch`](cutover.patch) (`git diff be447a3b c6d8ced0`, 4.4 MB)
- Receipts: [`receipts/`](receipts/)
- `/Users/arnaud/code/viborm` was **not** modified outside
  `docs/architecture/raptor3-evidence/g4/cutover/`. Nothing was committed,
  staged, reset, stashed or deleted there.

## 0. Commits on the branch

| Commit | Message | Content |
| --- | --- | --- |
| `5c08e840` | `chore(raptor3): candidate production for measurement (pre-freeze)` | the 20 files `git status --porcelain` listed under `src/` in the main tree (19 modified + the untracked `src/query-engine/raptor3/route/client-route.ts`), plus `scripts/raptor3-manifest.mjs`. +5,016 / −698. |
| `be447a3b` | `chore(raptor3): candidate test harness for measurement (pre-freeze)` | the 199 modified/untracked files under `tests/`, the four other modified `scripts/*.mjs` and `vitest.workspace.ts`. +36,801 / −88. |
| `c6d8ced0` | `chore(raptor3): C-01 cutover for measurement (pre-freeze)` | the cutover. 239 files, +106 / −115,495. |

**Why three commits and not two.** The prompt's copy list (files under `src/`
plus `scripts/raptor3-manifest.mjs`) is not sufficient to *run* the seven named
modes: at `0cc61e61` `scripts/run-raptor3.mjs` does not register `g4-read-contracts`
or any `g4-route-*` mode, and every test file those modes name is untracked in
the main tree. The harness overlay is therefore its own commit, so the cutover
patch stays exactly the cutover.

**Identity.** After the two copy commits, `captureRaptor3Identity()` in the
worktree is byte-identical to the same call in `/Users/arnaud/code/viborm`:

```
production 69dcfd215b36afb10b0089411156e258d4a409871d745396a716cc91d8255546
harness    eadf9d76888be1be448c579a1b078e487ffbfd7d8b2cad7eb77ec264abb9ca66
runtime    node v24.21.0, darwin/arm64, better-sqlite3 12.6.0, vitest 3.1.4
```

Two files outside the prompt's list were needed to reach that equality and are
recorded here rather than assumed: `vitest.workspace.ts` (it is in
`captureRaptor3Identity`'s *configuration* list, so it is part of the
**production** fingerprint even though it is not under `src/`) and
`benchmarks/baseline.json` (git-ignored — `.gitignore:23` — so
`git status --porcelain` never lists it; it is part of the **harness**
fingerprint and it is a benchmark input stage 2 will use). Receipts:
[`receipts/identity-before-cutover.json`](receipts/identity-before-cutover.json),
[`receipts/identity-after-cutover.json`](receipts/identity-after-cutover.json).

Install: `pnpm install --offline --frozen-lockfile` (7.4 s, no fallback needed).
`node_modules/better-sqlite3/build/Release/better_sqlite3.node` was already
present from the pnpm store; no `prebuild-install` and no copy from the baseline
worktree was required.

## 1. The cutover, as applied

### 1.1 The five edits §F names

1. **`src/client/client.ts`** (+9 / −21). `VibORM.create` and the `VibORM`
   constructor lose the `route` parameter; the constructor calls
   `createCandidateRoute(this.schema, config.driver, { index, registry })`
   unconditionally at the `new QueryEngine(…)` call. The type-only import of
   `ClientOperationRouteFactory` became a value import of `createCandidateRoute`.
2. **`src/query-engine/query-engine.ts`** (+4 / −14). `operationExecutor`,
   `cacheOperationExecutor`, the `OperationExecutor` import and the
   `resolveConsumableResultCandidate` import are deleted; `prepare` and
   `prepareCacheManaged` stop passing an executor to `createPendingOperation`.
3. **`src/query-engine/pending-operation.ts`** (+38 / −201). Deleted:
   `#resolveOperation`, `#statementOperation`, `#resolveSinglePlan`,
   `#singlePlan`, `#operationInstance`, `#operationResolved`,
   `#operationExecutor`, `#executor()`, `#runRouted`'s wrapper `#run` branch,
   `OperationResolution.operation`, and the imports of `OperationExecutor`,
   `constructRoutedOperation`, `executeRoutedOperation`,
   `createRoutedCacheResultCodec`, `isRecordSeries` and `ROUTED_OPERATIONS`.
   `#preparedInput`, `#cacheResultCodec`, `#cacheKeyPayload`, `#resolveRouted`,
   `#run` and `buildStatement` keep only the route arm. The array owner's
   `prepare` is now `() => undefined` and `parseResult` a loud
   `QueryEngineError` (§1.3 below).
4. **`src/query-engine/write-engine/**`** — 25 of its 43 `.ts` files deleted;
   `parse-boundary.ts` retained by name and 17 more retained by the retained
   `pattern/` experiment (§1.4).
5. **`src/query-engine/raptor3/route/client-route.ts`** (+3 / −17). Loses
   `createCandidateClient` and, with it, the value import of `VibORM` — so the
   new `client.ts → client-route.ts` value edge is not a cycle.

### 1.2 Transitive deletion of unreferenced owners

Method: resolve every import edge (tsconfig `paths`, relative, `.js`→`.ts`) from
the 29 `tsdown.config.ts` entries **plus every file under
`src/query-engine/pattern/`** (retained by instruction), before and after the
five edits. A file reachable before and unreachable after is an owner the
cutover orphans. The set is a fixpoint at the first round — an unreachable file
contributes no reachability.

**33 `src/` owners deleted, 28,740 lines** (full list with line counts:
[`receipts/deleted-src-owners.txt`](receipts/deleted-src-owners.txt)):

| Area | Files | Lines |
| --- | ---: | ---: |
| `src/query-engine/write-engine/` | 25 | 26,123 |
| `src/query-engine/` root owners (`OwnWriteSteps`, `OwnWriteAnalyzer`, `OwnWriteRelation`, `OwnWriteLedger`, `RelationMembership`, `relation-key-legality`, `validator`) | 7 | 2,485 |
| `src/query-engine/builders/to-one-composition.ts` | 1 | 132 |

The five largest: `RecordUpdateCompiler.ts` 5,803, `CreateOperation.ts` 4,315,
`RelationJunctionPart.ts` 3,464, `RelationWritePart.ts` 1,650,
`UpsertOperation.ts` 1,550.

**No file under `result/`, `context/` or `operations/` became unreferenced**, and
17 `write-engine/` files survived. All of them are reached by the retained
`pattern/` experiment, which imports `write-engine/{OperationFragment,
FragmentValidator, Part, race-retry, shared, create-race-pin, fragment-builders,
link-target-groups, messages, series-result-read}`, `result/ResultParser`,
`builders/*`, `context/*`, `operations/*`, `JunctionStatements` and
`TargetConstraint`. `OperationFragment` pulls `record-series` which pulls
`OperationExecutor`, so those two survive as well. Retaining `pattern/` and
deleting those owners are mutually exclusive; the instruction retains `pattern/`
(the two permitted diagnostics are pinned to `pattern/pack.ts:1443` and
`:2633`, which only resolve if every `pattern/` import resolves), so they stay.
`src/client/typescript-type-renderer.ts` keeps `result/result-aggregate-leaf`,
`result/result-column` and `result/result-shape` alive independently.

### 1.3 Three consequences that §F does not spell out, resolved here

Each changes no behavior; each is recorded because it is a judgement, not a
transcription.

1. **`READ_OPERATIONS` / `isReadOperation` / `ROUTED_OPERATIONS` /
   `isWriteOperation` are consumed outside the engine** — by `src/client/client.ts`,
   `src/extensions/definition.ts`, `src/extensions/methods.ts`,
   `src/extensions/query.ts` and `src/query-engine/cache-flow.ts` — but they live
   in the deleted `write-engine/routing.ts`. New retained module
   **`src/query-engine/routed-operations.ts` (48 lines, the only file added)**
   holds the four definitions *verbatim*, and the five importers are re-pointed
   (one line each). The candidate's own `raptor3/shared/schema.ts#isReadOperation`
   was **not** substituted: its set omits `findUniqueOrThrow` and
   `findFirstOrThrow`, so substituting it would reclassify two operations at the
   interception and cache seams.
2. **`CommittedWriteSegmentNotification` and `WriteMayBeVisibleNotification`**
   (`() => Promise<void>` aliases) were exported from `write-engine/OperationExecutor`
   and are used only by `pending-operation.ts`; they are now declared there.
3. **`prepare` and `parseResult` on the array-owner interface.** `prepare` must
   still exist (`TransactionOperationOwner` requires it) and, with a route, always
   answered `undefined` already — it is now literally `() => undefined`.
   `parseResult` was already documented as unreachable on the routed path (unit03
   §R.4 deleted its route branch as dead); with `prepare` never publishing a
   statement it cannot be called, so it is a loud `QueryEngineError` naming the
   operation rather than a silent value.

### 1.4 One deviation from §F's literal wording

§F/§7 say "`route` becomes required" on `QueryEngine`. The **constructor
parameter** was left `route?: ClientOperationRoute`; `PendingOperation` takes the
route as `readonly #route: ClientOperationRoute` with **one localized
non-null assertion** (`engine.route as ClientOperationRoute`) and a comment
naming the invariant that establishes it: every client lineage installs the
route in `VibORM`'s constructor and `bind()` forwards it.

Reason: `new QueryEngine(` appears **196 times** in this estate, 194 of them in
tests that pass two arguments. Making the parameter required by type turns those
into ~194 diagnostics that have nothing to do with the cutover and would force
~194 more test deletions, destroying the harness stage 2 needs. The common
brief permits "localized `as`/non-null assertions … where an upstream invariant
establishes the fact". **Nothing else about the route or the candidate was
changed**; the escape hatch is the *type*, not a fallback — there is no legacy
path left for a routeless engine to take.

### 1.5 Test files deleted to reach the required typecheck state

The terminating condition ("exactly the two `pattern/pack.ts` diagnostics and
nothing else") includes `tests/**/*.ts` — the root `tsconfig.json` compiles
`src`, `tests` and `benchmarks` as one program. **197 test files, 86,498 lines**
were deleted, in three rounds, each round deleting exactly the files the previous
typecheck named. **No test body was edited**: a parity test that builds a shipped
client and a candidate client and compares them cannot be "repaired" after the
shipped side is deleted without turning it into a candidate-vs-candidate
tautology. They are deleted and listed instead.

| Cause | Files | Receipt |
| --- | ---: | --- |
| imports a deleted legacy-engine owner (`write-engine/UpdateOperation`, `/routing`, `/CreateOperation`, `@query-engine/validator`, …) | 111 | [`deleted-tests-legacy-import.txt`](receipts/deleted-tests-legacy-import.txt) |
| uses the removed `createCandidateClient`, or `VibORM.create(config, route)`'s second argument | 25 | [`deleted-tests-cutover-seam.txt`](receipts/deleted-tests-cutover-seam.txt) |
| orphaned by the two above (imported a deleted helper) | 61 | [`deleted-tests-orphaned.txt`](receipts/deleted-tests-orphaned.txt) |

By area: `tests/contracts/` 134 (130 of them `tests/contracts/engine/`),
`tests/raptor3/` 26, `tests/pattern/` 19, `tests/providers/` 15,
`tests/types/` 2, `tests/unit/` 1.

## 2. Typecheck

`node scripts/run-typecheck.mjs`, run in the worktree with
`TMPDIR=/private/tmp/viborm-g4-cutover-tmp`.

| When | Result |
| --- | --- |
| pre-cutover (`be447a3b`) | exactly the two historical diagnostics. 17.96 s wall, 5,464.0 MiB peak RSS. Console only — not saved to a file (recorded here as a quoted receipt). |
| after the 33 `src/` deletions | 201 diagnostics: the two historical ones + 199 in 136 test files (162 × TS2307, 22 × TS2554, 8 × TS2578, 5 × TS2305, 1 × TS2344, 1 × TS2345). **`src/` itself was already clean apart from the two**, and `benchmarks/` clean. [`typecheck-after-src-deletions.txt`](receipts/typecheck-after-src-deletions.txt) |
| final (`c6d8ced0`) | **exactly the two historical `pattern/pack.ts` TS2345 diagnostics at 1443 and 2633, and nothing else.** 12.40 s wall, 5,086.0 MiB peak RSS. [`typecheck-final.txt`](receipts/typecheck-final.txt) |

## 3. Build

`pnpm package:build` (tsdown) in the worktree: **exit 0**, "Build complete in
3982 ms", 181 files / 6,442.54 kB, 5.31 s wall and 944.2 MiB peak RSS.
`dist/index.mjs` produced, 1.98 kB (gzip 0.90 kB).
Receipt: [`package-build.txt`](receipts/package-build.txt).

## 4. Modes run in the worktree

One `node scripts/run-raptor3.mjs <mode>` per invocation, `TMPDIR` set to
`/private/tmp/viborm-g4-cutover-tmp` so the worktree takes its own test lock and
never contends with the integrator's runs in the main tree.

| Mode | Result | Detail |
| --- | --- | --- |
| `g4-read-contracts` | **pass** | 8 files, 62 tests, 2.81 s; 9.82 s wall / 641.6 MiB peak |
| `g3-execution-review` | **pass** | 1 file, 6 tests; 4.81 s wall / 491.5 MiB peak |
| `g2-contracts` | **pass** | 16 files, 216 tests; 7.64 s wall / 739.8 MiB peak |
| `g4-route-lifecycle` | **cannot run** | `Missing required test tests/raptor3/g4/route-lifecycle.test.ts` |
| `g4-route-admission` | **cannot run** | `Missing required test tests/raptor3/g4/route-admission.test.ts` |
| `g4-route-cache` | **cannot run** | `Missing required test tests/raptor3/g4/route-cache.test.ts` |
| `g4-route-transactions` | **cannot run** | `Missing required test tests/raptor3/g4/route-transactions.test.ts` |

Receipts: `receipts/mode-*.txt`.

### 4.1 Modes the cutover retires — and the exact reason

**Zero registered raptor3 modes are legacy-engine-dependent.** Of the 103 modes
`scripts/run-raptor3.mjs` registers, **96 are intact** (every test file they name
still exists) and **7 are broken** — and all 7 break at the *cutover seam*, not
at a legacy-engine import. None of the 111 test files that import a deleted
legacy owner belongs to any registered raptor3 mode: they are the shipped
write-engine's own contract suites (`tests/contracts/engine/**`,
`tests/providers/**`, `tests/pattern/**`), run by other vitest projects.
Receipt: [`registered-mode-impact.txt`](receipts/registered-mode-impact.txt).

| Broken mode | Missing file | Why |
| --- | --- | --- |
| `g4-route-lifecycle` | `tests/raptor3/g4/route-lifecycle.test.ts` | imports `createCandidateClient` via `tests/raptor3/g4/route-contract.ts:14` |
| `g4-route-admission` | `tests/raptor3/g4/route-admission.test.ts` | `VibORM.create(config, route)` at `:101` and `:414` — it builds a **shipped** client and a **candidate** client side by side and compares them |
| `g4-route-cache` | `tests/raptor3/g4/route-cache.test.ts` | `createCandidateClient` at `:25` |
| `g4-route-transactions` | `tests/raptor3/g4/route-transactions.test.ts` | `VibORM.create(config, route)` at `:110` (same two-sided shape) |
| `g4-lifecycle-events` | `tests/raptor3/g4/lifecycle-events.test.ts` | imports `./route-contract` at `:23` |
| `g4-lifecycle-admission` | `tests/raptor3/g4/lifecycle-admission.test.ts` | imports `./route-contract` at `:18` |
| `g4-unit02-author` | `tests/raptor3/g4/unit02/packaged-array.test.ts` | `createCandidateRoute` + `VibORM.create(config, route)` at `:23`, `:83` |

These seven are **pre-cutover instruments by construction**: their value is that
they run the same oracle twice, once against the shipped route and once against
the candidate. After C-01 there is no shipped route to be the control. Retiring
them (not re-pointing them at `createClient`) is the honest disposition; the
proposal should say so rather than promise a repair.

### 4.2 An extra probe, because the four route modes could not answer

Not a registered mode. `receipts/built-package-probe.mjs` loads the **built**
`dist/` through the benchmark fixtures (`benchmarks/operation-pipeline-fixtures.mjs`,
which imports `../dist/index.mjs` and calls the public `createClient`) and
exercises the package end to end on sqlite3:

```
RESULT public findMany rows = 2
RESULT public create id = probe_1
RESULT benchmark prepare() = undefined
RESULT benchmark prepareBatch() = package
RESULT buildStatement() = undefined
```

The first two lines are the cutover package answering a read and a write through
the public entry with the candidate as its only operation owner. The last three
are a **blocker for stage 2** (§6.1).

## 5. Re-sync instruction for stage 2

The candidate production in `/Users/arnaud/code/viborm` was **not frozen** when
this stage copied it (a decisions unit is still editing files under
`src/query-engine/raptor3/` and its `AGENTS.md`). Before measuring anything,
stage 2 must re-sync and re-commit:

1. `cd /private/tmp/viborm-g4-perf-candidate && git status --porcelain` → expect
   empty, `HEAD` = `c6d8ced0` on `g4-perf-measurement`.
2. Re-copy, from `/Users/arnaud/code/viborm`, every path that
   `git status --porcelain --untracked-files=all` lists as modified or untracked
   under `src/`, **plus** `vitest.workspace.ts` and any modified
   `scripts/*.mjs` — these are part of `captureRaptor3Identity`'s fingerprints.
   `benchmarks/baseline.json` is git-ignored: copy it too.
3. Confirm the freeze: `captureRaptor3Identity().production` in the worktree must
   equal the integrator's named frozen identity (and `harness` likewise if the
   integrator pins it). Record the value before measuring.
4. **Re-apply the cutover to whatever the re-synced files changed.** The five
   edits of §1.1 are on `client.ts`, `query-engine.ts`, `pending-operation.ts`
   and `route/client-route.ts`; three of those four are files the decisions unit
   may have touched. `git diff c6d8ced0 -- <file>` after copying shows what came
   back, and `cutover.patch` is the authority for what must be removed again.
   `src/query-engine/routed-operations.ts` (§1.3.1) is not in the main tree at
   all — it must survive the re-sync.
5. Re-run `node scripts/run-typecheck.mjs` (must report only the two
   `pattern/pack.ts` diagnostics) and `pnpm package:build` (must produce
   `dist/index.mjs`) **before** any bundle or performance measurement — the
   benchmark fixtures load `dist/`, so a stale `dist/` silently measures the old
   build.
6. Commit the re-sync as its own commit; do not amend `c6d8ced0`, so the
   cutover patch this note points at stays valid.
7. Always export `TMPDIR=/private/tmp/viborm-g4-cutover-tmp` in the worktree, so
   the worktree's test lock stays separate from the main tree's.

## 6. Blockers

### 6.1 The frozen 20-cell performance protocol cannot measure read cells against the candidate as the harness stands

`benchmarks/operation-pipeline-harness.mjs:249-257` (`createReadHarness`) does:

```js
const prepared = preparedCapability.prepare();
if (!prepared) throw new Error("Read workload did not prepare one statement");
```

and `prepare()` is `readBenchmarkOperation(...).prepare()`, i.e. the array
owner's `prepare` — which on the cutover build **always returns `undefined`**
(measured, §4.2). `operation.buildStatement()` is `undefined` too (divergence
D-4′, unit03 FU.6: the candidate's prepared read publishes shape and cardinality,
not the `Sql`). `prepareOperationPlan` (`:219`) falls back to `prepareBatch`,
which **does** answer, so the paths that go through it are not obviously blocked;
`createReadHarness` has no such fallback.

The catalog's stage sets (`benchmarks/operation-pipeline-catalog.mjs:117-157`)
name `cold-prepare`, `prepare`, `execute`, `parse`, `raw-parse`, `full` for the
read workloads that dominate the 20 cells. This is **not** a consequence of the
cutover edit — it is the route's own design, true pre-cutover as well
(`#resolveSinglePlan` already returned `undefined` whenever a route was present)
— but it is the first time it has been put in front of the benchmark, and unit03
§8 ("Benchmark reachability") does not anticipate it: it assumes only that both
sides share `dist/` and the public entry.

Stage 2 must not "fix" this by editing the harness to make the two sides
measure different things. The decision belongs to Arnaud: either the candidate
grows a benchmark-visible single-statement preparation seam (a public-contract
question), or the protocol's read cells are re-expressed on a seam both routes
own, or the read cells are recorded as **not measurable**, never as passed.

### 6.2 Four of the seven named modes could not run

§4.1. Recorded, not repaired.

### 6.3 An ad-hoc public-client suite exceeded the vitest RSS ceiling

`node scripts/run-vitest-safe.mjs run tests/contracts/public-client/batch-transaction.test.ts`
was stopped at 1,543.6 MiB against the ordinary project's 1,536 MiB ceiling. It
is **not** one of the seven named modes and was only an extra smoke; no
pre-cutover control was run, so it is **not** attributable to the cutover.
Superseded as evidence by the built-package probe (§4.2), which proves the same
claim more directly.

## 7. Unverified claims

1. **No bundle figure and no performance number is produced by this stage.**
   Sections 3, 4 and 5 of the brief (bundles, the 20-cell series, the proposal)
   are stage 2's, against the frozen identity.
2. **`createReadHarness` was not executed.** §6.1's `prepare() === undefined` is
   measured; the resulting `throw` one line later is read from the source, not
   run.
3. **The 96 "intact" modes were not run** — intact means every test file the mode
   names still exists, checked against the deletion list, not that the mode
   passes.
4. **SQLite only.** Every receipt here is better-sqlite3 (or a typecheck/build).
   Nothing ran against native PostgreSQL or MySQL; the `g4.md` environment
   blocker stands.
5. **The pre-cutover typecheck receipt is a quotation, not a file** (§2): it was
   run before any file was saved to the receipts directory and the worktree has
   since moved past that commit.
6. **The retained-file argument is a reachability argument, not a test.** "No
   `result/`, `context/` or `operations/` owner became unreferenced" is derived
   from the import graph plus the final typecheck, which together prove nothing
   dangles; it is not proof that each retained file is *executed*.
7. **`AGENTS.md` under `src/`** was copied with the production files (the prompt
   said every file `git status` lists under `src/`); it is documentation and has
   no effect on any measurement. `captureRaptor3Identity` ignores it (it
   fingerprints only `.ts/.mts/.mjs/.js/.json`).

---

# Stage 2b — measurement against the SECOND frozen identity

The first freeze was superseded after a regression repair. Everything sections
0–7 above and `protocol.md` §§1–7 recorded was measured against identity 1
(`g4/freeze/identity-1-superseded.json`) and is retained as a receipt of that
identity — **not** as a result for this one. The stage-2a candidate tips
`08380bac` and `981368f6` are stale; nothing was deleted, they stay reachable as
branch `g4-perf-measurement-stage2a`.

Frozen identity 2 (`g4/freeze/identity.json`):

```
production fce8ec0cd32c839c5517a383d92f003e090e72cb8110b8ec0e08e1f7664d6904
harness    d9b7c1653a76234a000ff49cc79cd530bd752e9adb2f0977d30bbe74d0c8ff56
```

## B0. Commit graph, as built

```
0cc61e61  refactor(raptor3): unify completion and scalar update ownership   (base = main tree HEAD)
5c08e840  chore(raptor3): candidate production for measurement (pre-freeze)
be447a3b  chore(raptor3): candidate test harness for measurement (pre-freeze)
cacb2827  chore(raptor3): frozen G4 production for measurement (identity 2)     +771 / −153, 7 files
0f09f7b6  chore(raptor3): C-01 cutover for measurement (identity 2)             239 files, +106 / −115,495
9086ad81  test(bench): G4 cutover preparation phase adapter                     cherry-pick of e6f9acc7, 5 files, +226 / −56
```

The branch was reset to `be447a3b` before the re-sync — **not** built on the
stale `981368f6` — because `captureRaptor3Identity().production` fingerprints
every file under `src/`, so the pre-cutover identity can only be verified on a
tree that still has the legacy owners. The adapter is the top commit, so the 24
`PROTOCOL_PATHS` files are the adapter's own bytes on both sides.

`/Users/arnaud/code/viborm` was not modified outside
`docs/architecture/raptor3-evidence/g4/cutover/`. Nothing was committed, staged,
reset, stashed or deleted there.

## B1. Re-sync (note §5), as executed

Copied from the main tree: the **20** paths `git status --porcelain
--untracked-files=all` lists under `src/` (19 modified + the untracked
`src/query-engine/raptor3/route/client-route.ts`), plus
`scripts/raptor3-manifest.mjs`, `vitest.workspace.ts` and the git-ignored
`benchmarks/baseline.json`. Seven of those files actually differed from the
pre-freeze copy: `raptor3-manifest.mjs`, `raptor3/AGENTS.md`,
`commands/assignments.ts`, `commands/relation-body.ts`, `route/client-route.ts`,
`shared/operation-context.ts`, `shared/query.ts`.

**Identity, verified before the cutover** (receipt
[`receipts-stage2b/identity-identity2.json`](receipts-stage2b/identity-identity2.json)):

| Tree | production | equals frozen |
| --- | --- | --- |
| `/Users/arnaud/code/viborm` now | `fce8ec0c…d6904` | yes (harness too) |
| worktree at `cacb2827` | `fce8ec0c…d6904` | **yes** |

The worktree's `harness` fingerprint is `5b40db1f…1764f`, not the frozen
`d9b7c165…`. Reason, measured rather than assumed: `scripts/` (33 files) and
`benchmarks/` (39 files) are **byte-identical** to the main tree; `tests/raptor3`
is not — the worktree has 394 files to the main tree's 414 (20 review/freeze
tests added after the prep stage copied `tests/`, and 4 differing). The
stage-2b prompt names only `src/` plus the three files above for the re-sync,
and the cutover deletes 197 test files anyway, so harness equality is
unreachable on the candidate by construction. Consequence recorded in B4.

## B2. The cutover, re-applied — one adjustment

`git apply --check` of [`cutover.patch`](cutover.patch) against the re-synced
tree failed on exactly **one** file, `src/query-engine/raptor3/route/client-route.ts`:
the freeze collapsed its four-line `@errors` import into one line and grew the
file by 22 lines, so the patch's trailing context (`import {`) no longer matched.
The patch was applied with that path excluded and the file's two edits were
applied by hand, **verbatim** — the same comment rewrite and the same deletion of
the `VibORM` value import and of `createCandidateClient`. No other hunk needed
adjusting, and no edit was invented.

Verification that the re-applied cutover is the same cutover:

- the identity-2 diff ([`receipts-stage2b/cutover-identity2.patch`](receipts-stage2b/cutover-identity2.patch),
  `git diff cacb2827 0f09f7b6`) touches **exactly the same 239 files** as
  `cutover.patch` (`diff` of the two `diff --git` file lists is empty);
- the per-file hunks for `src/client/client.ts`, `src/query-engine/query-engine.ts`,
  `src/query-engine/pending-operation.ts` and the added
  `src/query-engine/routed-operations.ts` are **byte-identical** between the two
  patches;
- **33** `src/` owners deleted, **28,740** lines (write-engine 25 files / 26,123;
  query-engine root 7 / 2,485; `builders/to-one-composition.ts` 1 / 132);
  **197** test files, **86,498** lines; **1** file added.
  Receipts: [`deleted-src-owners-identity2.txt`](receipts-stage2b/deleted-src-owners-identity2.txt),
  [`deleted-tests-identity2.txt`](receipts-stage2b/deleted-tests-identity2.txt).

**No further transitive deletion was needed.** The first typecheck after the
re-applied cutover already reported exactly the two permitted diagnostics.

## B3. Typecheck and build

| Command | Result |
| --- | --- |
| `node scripts/run-typecheck.mjs` | **exactly** `pattern/pack.ts(1443,36)` and `(2633,58)` TS2345, nothing else. 11.80 s wall, 5,275.1 MiB peak sampled RSS. [`typecheck-identity2-cutover.txt`](receipts-stage2b/typecheck-identity2-cutover.txt) |
| `pnpm package:build` | exit 0, "Build complete in 3602 ms", 181 files / 6,465.69 kB, 5.86 s wall / 742.5 MiB peak. `dist/index.mjs` produced. [`package-build-identity2.txt`](receipts-stage2b/package-build-identity2.txt) |

`protocolIdentity(...).sha256` is
`6716a2229286205dac80b62ed962483ff26804f5580f614730be0d1fbd33089d` in **both**
worktrees; `diff -rq` finds the two `benchmarks/` trees identical except the
git-ignored `benchmarks/baseline.json` (not a `PROTOCOL_PATHS` member, and no
file under `benchmarks/` or `scripts/` reads it).

## B4. Registered modes on the identity-2 build

[`registered-mode-impact-identity2.txt`](receipts-stage2b/registered-mode-impact-identity2.txt).
Of the 103 registered modes with a resolvable test list: **95 intact**,
**6 broken by the cutover**, **2 with files already absent pre-cutover**.
Per-file attribution puts the cutover's own count at **7**: the six route and
lifecycle modes plus `g4-unit02-author`, whose `packaged-array.test.ts` the
cutover deletes. The other four absent files (`lone-statement-transport`,
`nested-key-refusal`, `uncertain-outcome-meta`, `native-nested-key-refusal`) are
**harness staleness, not cutover casualties** — they exist in the main tree and
never existed in this worktree. `g4-unit02-mysql-contracts` is therefore NOT a
cutover casualty.

Three modes were actually run on the identity-2 cutover build, all **pass**,
with the same counts the prep stage recorded:

| Mode | Result | Detail |
| --- | --- | --- |
| `g4-read-contracts` | pass | 8 files, 62 tests; 5.46 s wall / 666.0 MiB peak |
| `g3-execution-review` | pass | 1 file, 6 tests; 4.61 s wall / 469.2 MiB peak |
| `g2-contracts` | pass | 16 files, 216 tests; 6.80 s wall / 739.0 MiB peak |

Receipts `receipts-stage2b/mode-*-identity2.txt`.

## B5. Pre-series cell probe

[`cell-probe-candidate-identity2.json`](receipts-stage2b/cell-probe-candidate-identity2.json)
is **byte-identical** to the identity-1 frozen probe: the freeze changed nothing
observable at the benchmark seams. 17 of 20 cells build and run a stage;
`flat-scalar-update/prepare` and `/execute` have no candidate stage function,
`relation-series-2/full` fails its contract observation.

### B5.1 `relation-series-2` re-observed at identity 2

The frozen contract assertion throws inside the harness, so the divergence was
re-measured through the public client with the assertion bypassed
([`relation-series-2-identity2.json`](receipts-stage2b/relation-series-2-identity2.json)),
on a fresh core fixture on both sides:

| | `{count}` | `generatedChild.id` defaults evaluated | persisted children |
| --- | --- | ---: | --- |
| shipped | `{ count: 2 }` | 5 (`series_child_1`…`_5`) | `series_child_3` → 5000, `series_child_5` → 6000 |
| candidate | `{ count: 2 }` | 3 (`series_child_1`…`_3`) | `series_child_2` → 5000, `series_child_3` → 6000 |

Identical to the identity-1 receipt. The shipped side's harness witness was also
re-read this stage: 7 statements, cuts `selected-roots-captured`,
`first-member-visible`, `second-member-visible`. The candidate's physical
statement count (3) and both sides' full SQL are carried forward from
[`receipts-stage2/relation-series-2-divergence.json`](receipts-stage2/relation-series-2-divergence.json)
and were not re-measured here.

## B6. Bundles (brief §3)

`node scripts/measure-raptor3-baseline.mjs --bundle` in the worktree against the
frozen [`baseline.json`](../../baseline.json). Full report
[`bundles.json`](bundles.json), ratios [`bundle-ratios.json`](bundle-ratios.json).

| Fixture | baseline gzip | candidate gzip | ratio | §7 target | meets |
| --- | ---: | ---: | ---: | ---: | --- |
| `engine` | 156,771 | 37,260 | **0.2377** | ≤ 0.75 | **yes** |
| `pg-simple` | 262,658 | 183,366 | **0.6981** | ≤ 1.00 | **yes** |
| `pg-relations` | 262,788 | 183,508 | **0.6983** | ≤ 1.00 | **yes** |

Modules: engine 241 → 93; each PG fixture 427 → 311. Externalization lists are
identical on both sides, and `bundleProtocol` is identical to the frozen
baseline's. The one tool difference from the frozen baseline is the Node patch
version driving rolldown (v24.20.0 frozen, v24.21.0 here, the pinned measurement
runtime); V8, TypeScript, tsdown, rolldown and biome versions are identical.
Gzip sizes are per fixture and are not additive.

## B7. Performance series (brief §4, plan §7)

The series started only after `g4/qualified/RUNS-COMPLETE` appeared (03:08
local) and no `run-raptor3`/`vitest`/benchmark process remained. Two full
series were run — pass 2 because three cells were inconclusive on pass 1 —
40 commands each, one cell in one mode per command, five alternating
fresh-process pairs per side. Wall time: pass 1 07:18, pass 2 07:04. Journals
`cells/pass1-journal.txt`, `cells/pass2-journal.txt`; per-cell evidence reports
and logs in [`receipts-stage2b/cells/`](receipts-stage2b/cells/) (reports
`gzip -9`, 437 MB → 37 MB); aggregate [`performance.json`](performance.json).

**Machine state, recorded rather than claimed.** No viborm process ran
concurrently. The 1-minute load average was nevertheless 7.6–8.8 throughout,
from the user's own desktop applications (Cursor, Raycast, browsers) — this is
the machine's ambient state, identical for both sides of every alternating pair,
and it is what the MAD-based `E` exists to carry. The two independent series
agree cell for cell on every verdict, which is the strongest available evidence
that the ambient load did not decide any of them.

### Verdicts

| Verdict | Cells |
| --- | ---: |
| pass | **3** |
| blocks adoption (resolved, over budget) | **11** |
| inconclusive after the one permitted repeat — blocks adoption | **3** |
| not measurable comparably — end-to-end evidence retained | **2** |
| blocks adoption — required contract divergence | **1** |

| Cell | pass 1 | pass 2 | final | CPU ratio N/B | wall ratio N/B |
| --- | --- | --- | --- | ---: | ---: |
| `scalar-find-unique/cold-prepare` | blocks | blocks | **blocks adoption** | 1.084 / 1.100 | 1.138 / 1.143 |
| `scalar-find-unique/prepare` | blocks | blocks | **blocks adoption** | 2.154 / 2.152 | 2.638 / 2.672 |
| `scalar-find-unique/execute` | pass | pass | **pass** | 0.963 / 0.969 | 0.965 / 0.969 |
| `scalar-find-unique/full` | blocks | blocks | **blocks adoption** | 1.322 / 1.345 | 1.570 / 1.618 |
| `flat-scalar-update/prepare` | refused | refused | **not measurable comparably** | — | — |
| `flat-scalar-update/execute` | refused | refused | **not measurable comparably** | — | — |
| `flat-scalar-update/full` | blocks | blocks | **blocks adoption** (wall) | 1.010 / 1.012 | 1.311 / 1.323 |
| `fixed-collection-rowref-20/prepare` | blocks | blocks | **blocks adoption** | 1.400 / 1.403 | 1.874 / 1.890 |
| `fixed-collection-rowref-20/execute` | pass | pass | **pass** | 1.025 / 1.006 | 1.025 / 1.007 |
| `fixed-collection-rowref-20/full` | blocks | blocks | **blocks adoption** | 1.103 / 1.108 | 1.208 / 1.203 |
| `nested-conditional-found/full` | blocks | blocks | **blocks adoption** (wall) | 0.900 / 0.874 | 1.171 / 1.145 |
| `nested-conditional-missing/full` | blocks | blocks | **blocks adoption** (wall) | 0.903 / 0.886 | 1.211 / 1.184 |
| `key-transition-cascade/full` | blocks | blocks | **blocks adoption** | 1.164 / 1.185 | 1.448 / 1.447 |
| `bulk-update-returning-100/prepare` | blocks | blocks | **blocks adoption** | 1.656 / 1.607 | 1.586 / 1.530 |
| `bulk-update-returning-100/full` | inconclusive | inconclusive | **inconclusive — blocks adoption** (wall) | 0.900 / 0.925 | 1.040 / 1.059 |
| `relation-series-2/full` | refused | refused | **blocks adoption — required contract divergence** | — | — |
| `fixed-collection-rowref-1000/prepare` | blocks | blocks | **blocks adoption** | 1.592 / 1.616 | 1.529 / 1.545 |
| `fixed-collection-rowref-1000/execute` | pass | pass | **pass** | 1.001 / 1.007 | 1.000 / 1.003 |
| `fixed-collection-rowref-1000/parse` | inconclusive | inconclusive | **inconclusive — blocks adoption** (wall) | 1.003 / 1.007 | 1.043 / 1.043 |
| `fixed-collection-rowref-1000/full` | inconclusive | inconclusive | **inconclusive — blocks adoption** | 1.048 / 1.042 | 1.045 / 1.047 |

`B`, `N`, both MADs, `E = 2 × max(MAD)`, the budget, `(N − B) + E`, every raw
sample, the preparation seam and statement count each side used, and the
per-metric verdict are in `performance.json`, per cell **and per pass**.

Four facts the table does not carry:

1. **Peak RSS passes every measurable cell, and is often a large improvement.**
   `nested-conditional-*` and `key-transition-cascade` run at 0.76–0.80 of the
   baseline's whole-worker peak RSS (−25 to −32 MiB), far beyond `E`. The one
   cell where the candidate uses more is `scalar-find-unique/prepare`
   (1.050–1.054), still inside the 10 % budget.
2. **The candidate is faster in CPU on the three nested/conditional writes**
   (0.874–0.903) and on `bulk-update-returning-100/full` (0.900–0.925), by more
   than `E` — a real improvement — while being slower in **wall** time on the
   same cells (1.145–1.211). CPU below and wall above means time spent not
   burning CPU: more await points or more round trips per operation, not more
   computation. Both are reported; neither is dropped.
3. **Preparation is the consistent regression.** Every `prepare` cell is 1.4×–2.2×
   the baseline in CPU with MADs under 1 % of the median, on both passes. The
   two sides bracket the identical seam there (`package`/`package`, one
   statement each), and `performance.json` retains the prepared SQL both sides
   published.
4. **The three passing cells are all `execute`** — the stage that is
   `driver._executeRaw(sql, params)` on the statement the plan contains. Where
   the work is the provider's, the two engines are indistinguishable
   (0.963–1.025). That is the control that says the harness is measuring the
   engines and not itself.

No outlier was removed. No cell was rerun on its own; only the two full series
exist. No lock belonging to a live process was removed (see B8.1).

## B8. Deviations and judgements recorded for stage 2b

1. **A stale lock was removed once.** `scripts/test-run-lock.mjs` refused every
   command in the worktree because
   `/private/tmp/viborm-g4-cutover-tmp/viborm-test-c33ebb4c906dfea8.lock` named
   PID 23632, the stage-2a benchmark coordinator, which no longer exists. The
   script itself classifies this "stale or unreadable" and instructs removal
   after confirming no verification process remains; that was checked (`ps`) and
   the file was copied to
   [`receipts-stage2b/stale-lock-removed.json`](receipts-stage2b/stale-lock-removed.json)
   before removal. This is the only lock file touched, it was in the worktree's
   own TMPDIR, and no live process's lock was ever removed or waited past.
2. **One mode per command for all 20 cells**, not only the preparation cells
   (`protocol.md` §8.3).
3. **`fixed-collection-rowref-1000`'s explicit `--iterations 1000 --warmup 200`
   was applied to its `cpu` commands only**; its `retained` commands take the
   catalog's own 20 iterations (`protocol.md` §8.4).
4. **`tests/` was not re-synced** (B1). The three named files plus `src/` were,
   exactly as the prompt specified.
5. **The candidate branch was reset to `be447a3b`** before the re-sync, and the
   stale tips were preserved as branch `g4-perf-measurement-stage2a`. Nothing
   was deleted.

## B9. Unverified claims (stage 2b)

1. **SQLite only.** Every number here is better-sqlite3. Nothing ran against
   native PostgreSQL or MySQL; the `g4.md` environment blocker stands.
2. **The 95 "intact" modes were not run.** Intact means every test file the mode
   names still exists, checked against the deletion list — not that the mode
   passes. Three modes were actually executed (B4).
3. **`harness` identity was not matched** and cannot be on the candidate (B1).
   Only `production` was verified equal to the freeze, before the cutover.
4. **The wall-versus-CPU reading in B7.2 is an inference**, not a measurement:
   nothing in this unit counted await points or round trips per operation. The
   physical statement counts each side produced ARE retained per sample in the
   per-cell reports and would settle it.
5. **The ambient desktop load was not controlled**, only recorded. The two
   independent series agreeing cell for cell is evidence, not proof, that it
   decided nothing.
6. **No falsifier was re-run for identity 2.** The adapter's old-versus-old
   calibration, changed-SQL/wrong-result specimens and unchanged benchmark
   suites (`protocol.md` §3) were run against the baseline overlay, which has
   not changed since; they are not re-established against this candidate. The
   plumbing WAS re-validated against the identity-2 commit pair by a `--smoke`
   run ([`smoke-identity2.json.gz`](receipts-stage2b/smoke-identity2.json.gz),
   `measurementProtocolValid: false` by construction, two-iteration numbers that
   are not a result).
7. **`benchmarks/baseline.json` was copied but is used by nothing** under
   `benchmarks/` or `scripts/` (checked by grep); it is carried only because it
   is part of `captureRaptor3Identity`'s harness fingerprint.

---

# Stage 2c — measurement against the THIRD frozen identity (performance pass)

Identity 2 was superseded by the performance-pass safe fixes and by Arnaud's
D-8 benchmark decision. Everything sections B0–B9 and `protocol.md` §§1–8
recorded is retained as a receipt of *identity 2* and is **not** a result for
this one. The protocol for this stage is `protocol.md` §9, written by the
previous author **before** the series.

Frozen identity 3 (`g4/freeze/identity.json`):

```
production 2e92354bafaaccb7cab5f54041992b552664a7865fb69370be70ebccb63a1975
harness    31c2883fd742dbea69896430543a85a9eace96719b9f24f9358593b54ff3a66a
```

`/Users/arnaud/code/viborm` was **not** modified outside
`docs/architecture/raptor3-evidence/g4/cutover/` and `g4/cutover-proposal.md`.
Nothing there was committed, staged, reset, stashed or deleted. **No commit was
added to either measurement worktree**: both are exactly as the previous author
left them.

## C0. What was verified rather than redone

This session resumed after the previous author's was cut off while polling for
`g4/qualified/RUNS-COMPLETE`. Everything below was checked read-only before the
series; none of it was rebuilt.

| Claim | How it was checked | Result |
| --- | --- | --- |
| both worktrees clean | `git status --porcelain` | empty on both |
| candidate tip | `git log` | `90d4bb47` on `g4-perf-measurement`, over `c22cb59e` → `0db0377f` → `59c44d3c` → `a9a482e1` → `cacb2827` |
| baseline tip | `git log` | `e532bbec` on `g4-perf-baseline-overlay`, one commit above `e67b511b`, itself one above `0cc61e61` |
| the 24 `PROTOCOL_PATHS` are the same bytes on both sides | `cmp` per file, plus `protocolIdentity()` in both trees | all 24 identical; `sha256 = f23e0aace9f0a8de55a1218d054870c1353a8456ec441f91d8bc5e437e0af22a` in **both**, equal to the value §9.2 predeclared |
| `benchmarks/` trees identical | `diff -rq` | identical except the git-ignored `benchmarks/baseline.json` (candidate only; not a `PROTOCOL_PATHS` member) |
| both overlays touch only protocol paths | `git show --stat` on `e67b511b`, `e532bbec`, `c22cb59e`, `90d4bb47` | adapter 5 files +226/−56, D-8 1 file +106/−20; every path is in `PROTOCOL_PATHS`; `e532bbec`'s parent **is** `e67b511b` |
| the candidate measured the frozen production | `git archive a9a482e1` into a scratch tree, then `captureRaptor3Identity()` on it — **independent of the predecessor's receipt** | `production = 2e92354b…a1975`, byte-equal to the freeze |
| the main tree still holds the freeze | `captureRaptor3Identity("/Users/arnaud/code/viborm")` at 15:12 local, after the integrator's campaign finished | `production` **and** `harness` both byte-equal to `g4/freeze/identity.json` |
| the cutover receipt is the cutover | `cmp` of `receipts-stage2c/cutover-identity3.patch` against `git diff a9a482e1 59c44d3c` | byte-identical; 239 `diff --git` entries, the **same 239 files** as `receipts-stage2b/cutover-identity2.patch` |
| typecheck and build | `receipts-stage2c/typecheck-identity3-{cutover,tip}.txt`, `package-build-identity3.txt` | exactly the two permitted `pattern/pack.ts` TS2345 diagnostics at both commits; build exit 0, 181 files, `dist/index.mjs` produced |
| bundles | `bundles-identity3.json`, `bundle-ratios-identity3.json` | engine gzip ratio 0.2377 (≤ 0.75), `pg-simple` 0.6984 and `pg-relations` 0.6986 (≤ 1.00) |

The candidate's `harness` fingerprint is **not** equal to the freeze and cannot
be, for the reason B1 recorded. Only `production` is claimed equal.

## C1. Machine state, recorded rather than claimed

The integrator's `g4/qualified/RUNS-COMPLETE` was written at 14:06 local; no
`vitest`, `run-raptor3` or benchmark process existed at any point during this
stage's runs. The machine's owner nevertheless runs Cursor, Codex/ChatGPT,
Devin, Raycast, Dia and Claude, which is outside this unit's control.

| Moment | 1-min load | Receipt |
| --- | ---: | --- |
| before the series (15:11) | **5.79** | [`machine-before-series.txt`](receipts-stage2c/machine-before-series.txt) |
| end of pass 1 (15:22) | 11.91 | same file's notes |
| pass-2 attempt 1, aborted (15:22–15:44) | **11.9 → 143** | [`cells/aborted-pass2-attempt1/`](receipts-stage2c/cells/aborted-pass2-attempt1/) |
| start of pass 2, the recorded repeat (15:54) | **9.14** | [`machine-pass2-start.txt`](receipts-stage2c/machine-pass2-start.txt) |
| across all 40 pass-2 commands | 8.69–13.14 | sampled per command |
| after the series (16:04) | 12.39 | [`machine-after-series.txt`](receipts-stage2c/machine-after-series.txt) |

### C1.1 One aborted attempt at the repeat, kept and not relabelled

The first attempt at pass 2 was **aborted after 9 of its 40 commands**, on the
machine state and **before any of its numbers were aggregated or read**.
`pass2__scalar-find-unique__execute__retained` had failed after 1,014 s with
`Error: baseline package build failed: Node command exceeded its 300 second
wall limit` — `buildCheckout`
(`benchmarks/operation-pipeline-compare.mjs:290`), an infrastructure failure of
the harness's own build step, not a cell refusal. At that moment the 1-minute
load average was 43 and rising (it peaked at 143), with `fseventsd` at 155 %
and `syspolicyd`, `PerfPowerServices` and `WindowServer` all heavy; per-command
wall time had gone from ~10 s to 24–56 s.

Running the one permitted repeat under a system-level storm that had already
broken a 300 s build limit would have produced a pass whose MADs describe the
machine. The attempt was stopped, everything it produced was moved intact to
[`cells/aborted-pass2-attempt1/`](receipts-stage2c/cells/aborted-pass2-attempt1/)
with a README stating exactly this, and the repeat was re-run 10 minutes later
once the 1-minute load was back to 7.98 — comparable to pass 1's 5.79 start and
to stage 2b's 7.6–8.8.

Two consequences, both recorded rather than smoothed:

1. **A stale lock was created and was NOT removed.** Terminating the driver
   killed the compare process it had spawned, which left
   `/private/tmp/viborm-g4-cutover-tmp/viborm-test-c33ebb4c906dfea8.lock`
   (`{"pid":81219,…}`; PID confirmed absent from the process table). This unit
   removes no lock file. A copy is kept as
   `cells/aborted-pass2-attempt1/stale-lock-left-in-place.json` and the file is
   still in place; `scripts/test-run-lock.mjs:223` prints the instruction for
   clearing it.
2. **Pass 2 therefore ran with `TMPDIR=/private/tmp/viborm-g4-cutover-tmp2`**, a
   sibling directory, because the lock path is derived from `tmpdir()`. This is
   **measurement-neutral and was checked, not assumed**: the only two uses of
   `tmpdir()` across the protocol files are the lock path
   (`scripts/test-run-lock.mjs:52`) and a `--calibrate`-only scratch directory
   (`operation-pipeline-compare.mjs:864`), and every sqlite3 fixture in this
   series is `:memory:` (`operation-pipeline-fixtures.mjs:164`). Same machine,
   same filesystem, same commands, same counts.

## C2. The series as run

Two full series, 40 commands each — one cell in one mode per command, five
alternating fresh-process pairs per side — from the baseline overlay worktree as
coordinator, exactly the command `protocol.md` §9.4 predeclared.

| | pass 1 | pass 2 (the one permitted repeat) |
| --- | --- | --- |
| window (UTC) | 13:12:10 – 13:21:21 | 13:55:03 – 14:03:44 |
| summed command wall | 9 min 21 s | 8 min 53 s |
| commands | 40 | 40 |
| evidence reports written | 34 | 34 |
| commands that refused | 6 | the same 6 |
| journal | [`cells/pass1-journal.txt`](receipts-stage2c/cells/pass1-journal.txt) | [`cells/pass2-journal.txt`](receipts-stage2c/cells/pass2-journal.txt) |

Every measured cell reports `measurementProtocolValid: true` with **5 baseline
and 5 candidate replicates in both modes**, and the counts are the frozen
matrix's: 5,000/1,000 cpu and 500/100 retained for the default workloads,
1,000/200 and 100/20 for `bulk-update-returning-100`, and 1,000/200 cpu with the
catalog's own 20/10 retained for `fixed-collection-rowref-1000` (§8.4).

Per-cell reports (`gzip -9`) and logs are in
[`cells/`](receipts-stage2c/cells/) (41 MB); the driver is
[`series-driver.mjs`](receipts-stage2c/series-driver.mjs) and the aggregator
[`aggregate.mjs`](receipts-stage2c/aggregate.mjs). The aggregate of both passes
is [`performance-identity3.json`](performance-identity3.json); the first series
alone is retained as
[`performance-identity3-pass1.json`](performance-identity3-pass1.json).
`performance.json` (identity 2) is untouched.

## C3. Verdicts

| Verdict | Cells |
| --- | ---: |
| pass | **6** |
| blocks adoption (resolved, over budget) | **4** |
| inconclusive after the one permitted repeat — blocks adoption | **7** |
| not measurable comparably — end-to-end evidence retained | **2** |
| blocks adoption — required contract divergence | **1** |

`B`, `N`, both MADs, `E = 2 × max(MAD)`, the budget, the signed delta,
`(N − B) + E`, every raw sample, the preparation seam and statement count each
side used and the prepared SQL are in `performance-identity3.json`, per cell and
per pass. Verdict rules are `protocol.md` §5's, unchanged, and the cell verdict
is **the worse of the two series** — the same rule that produced the identity-2
record.

| Cell | pass 1 | pass 2 | final | CPU N/B (p1 / p2) | wall N/B | RSS N/B |
| --- | --- | --- | --- | ---: | ---: | ---: |
| `scalar-find-unique/cold-prepare` | inconclusive | pass | **inconclusive — blocks adoption** | 1.059 / 1.025 | 1.092 / 0.999 | 0.991 / 0.996 |
| `scalar-find-unique/prepare` | blocks | blocks | **blocks adoption** | 1.480 / 1.454 | 1.427 / 1.374 | 0.991 / 0.987 |
| `scalar-find-unique/execute` | pass | pass | **pass** | 1.002 / 0.985 | 1.006 / 0.983 | 0.977 / 0.983 |
| `scalar-find-unique/full` | inconclusive | inconclusive | **inconclusive — blocks adoption** | 1.018 / 1.030 | 1.036 / 1.066 | 0.965 / 0.968 |
| `flat-scalar-update/prepare` | refused | refused | **not measurable comparably** | — | — | — |
| `flat-scalar-update/execute` | refused | refused | **not measurable comparably** | — | — | — |
| `flat-scalar-update/full` | pass | pass | **pass** | 0.771 / 0.757 | 0.907 / 0.870 | 0.948 / 0.954 |
| `fixed-collection-rowref-20/prepare` | blocks | inconclusive | **blocks adoption** | 1.051 / 0.927 | 1.202 / 1.085 | 0.978 / 0.980 |
| `fixed-collection-rowref-20/execute` | pass | pass | **pass** | 1.028 / 1.022 | 1.028 / 1.021 | 0.977 / 0.986 |
| `fixed-collection-rowref-20/full` | inconclusive | pass | **inconclusive — blocks adoption** | 0.947 / 0.951 | 1.021 / 1.020 | 0.930 / 0.930 |
| `nested-conditional-found/full` | pass | inconclusive | **inconclusive — blocks adoption** | 0.807 / 0.893 | 0.905 / 0.978 | 0.912 / 0.915 |
| `nested-conditional-missing/full` | pass | pass | **pass** | 0.798 / 0.801 | 0.911 / 0.927 | 0.917 / 0.912 |
| `key-transition-cascade/full` | inconclusive | inconclusive | **inconclusive — blocks adoption** | 0.915 / 0.901 | 1.046 / 1.024 | 0.791 / 0.796 |
| `bulk-update-returning-100/prepare` | blocks | blocks | **blocks adoption** | 1.457 / 1.484 | 1.263 / 1.256 | 0.975 / 0.975 |
| `bulk-update-returning-100/full` | pass | pass | **pass** | 0.861 / 0.829 | 0.975 / 0.966 | 0.982 / 0.979 |
| `relation-series-2/full` | refused | refused | **blocks adoption — required contract divergence** | — | — | — |
| `fixed-collection-rowref-1000/prepare` | blocks | blocks | **blocks adoption** | 1.414 / 1.401 | 1.212 / 1.215 | 0.955 / 0.951 |
| `fixed-collection-rowref-1000/execute` | pass | pass | **pass** | 0.985 / 0.969 | 0.984 / 0.967 | 0.954 / 0.954 |
| `fixed-collection-rowref-1000/parse` | inconclusive | inconclusive | **inconclusive — blocks adoption** | 1.002 / 1.035 | 1.042 / 1.075 | 0.948 / 0.949 |
| `fixed-collection-rowref-1000/full` | inconclusive | inconclusive | **inconclusive — blocks adoption** | 1.053 / 1.015 | 1.093 / 1.010 | 1.034 / 1.034 |

## C4. What moved since identity 2, cell by cell

Comparison script:
[`compare-identity2-identity3.mjs`](receipts-stage2c/compare-identity2-identity3.mjs).
The protocol identity changed with D-8 (§9.2), so the two series are **not**
comparable command-for-command; the ratios below are each series' own N/B and
are comparable as ratios.

| Cell | identity 2 | identity 3 | CPU N/B | wall N/B |
| --- | --- | --- | ---: | ---: |
| `scalar-find-unique/cold-prepare` | blocks | inconclusive | 1.100 → **1.025** | 1.143 → **0.999** |
| `scalar-find-unique/prepare` | blocks | blocks | 2.152 → **1.454** | 2.672 → **1.374** |
| `scalar-find-unique/execute` | pass | **pass** | 0.969 → 0.985 | 0.969 → 0.983 |
| `scalar-find-unique/full` | blocks | inconclusive | 1.345 → **1.030** | 1.618 → **1.066** |
| `flat-scalar-update/prepare` | not measurable | not measurable | — | — |
| `flat-scalar-update/execute` | not measurable | not measurable | — | — |
| `flat-scalar-update/full` | blocks | **pass** | 1.012 → **0.757** | 1.323 → **0.870** |
| `fixed-collection-rowref-20/prepare` | blocks | blocks | 1.403 → **0.927** | 1.890 → **1.085** |
| `fixed-collection-rowref-20/execute` | pass | **pass** | 1.006 → 1.022 | 1.007 → 1.021 |
| `fixed-collection-rowref-20/full` | blocks | inconclusive | 1.108 → **0.951** | 1.203 → **1.020** |
| `nested-conditional-found/full` | blocks | inconclusive | 0.874 → 0.893 | 1.145 → **0.978** |
| `nested-conditional-missing/full` | blocks | **pass** | 0.886 → **0.801** | 1.184 → **0.927** |
| `key-transition-cascade/full` | blocks | inconclusive | 1.185 → **0.901** | 1.447 → **1.024** |
| `bulk-update-returning-100/prepare` | blocks | blocks | 1.607 → **1.484** | 1.530 → **1.256** |
| `bulk-update-returning-100/full` | inconclusive | **pass** | 0.925 → **0.829** | 1.059 → **0.966** |
| `relation-series-2/full` | contract divergence | contract divergence | — | — |
| `fixed-collection-rowref-1000/prepare` | blocks | blocks | 1.616 → **1.401** | 1.545 → **1.215** |
| `fixed-collection-rowref-1000/execute` | pass | **pass** | 1.007 → 0.969 | 1.003 → 0.967 |
| `fixed-collection-rowref-1000/parse` | inconclusive | inconclusive | 1.007 → 1.035 | 1.043 → 1.075 |
| `fixed-collection-rowref-1000/full` | inconclusive | inconclusive | 1.042 → 1.015 | 1.047 → 1.010 |

Four things this table says, and one it does not.

1. **The performance pass did what the diagnosis predicted.** The worst
   preparation cell falls from **2.152×** to **1.454×** CPU (13.13 → 28.26 µs/op
   at identity 2; 13.65 → 19.85 µs/op here), and `fixed-collection-rowref-20`'s
   preparation goes from 1.403× to **0.927×** — under parity. Preparation is
   still the regression, but it is roughly half of what it was.
2. **The wall-above-CPU signature on the writes is gone.** Every cell that
   showed it at identity 2 — the two `nested-conditional-*`,
   `key-transition-cascade` and `flat-scalar-update/full` — is now at or below
   parity in wall time (0.870–1.024, from 1.145–1.447). `flat-scalar-update/full`
   moves from a resolved regression to **0.757× CPU / 0.870× wall**, a pass.
3. **Peak RSS still passes every measurable cell** and is still a large win on
   `key-transition-cascade` (0.79) and the nested writes (0.91). The two
   `nested-conditional-*` cells are less far ahead than at identity 2 (0.91–0.92
   against 0.76): the candidate did not get worse — both sides' whole-worker
   peak moved — but the improvement claim is smaller and is reported as measured.
4. **Six cells pass, against three at identity 2**, and **no cell regressed in
   verdict**: every change of verdict is toward "pass", or from "blocks" to
   "inconclusive".
5. What it does **not** say is that the gate is met. Eleven cells still block
   adoption, one of them for a reason that is not a number at all (C6).

## C5. The honest limit of this series: E is larger than the budget on most cells

This is the finding that most constrains what may be claimed. `E = 2 × max(MAD)`
is the protocol's own uncertainty, and on **13 of the 17 measurable cells** `E`
exceeded the 5 % budget on at least one metric in at least one pass. Where that
happens, `(N − B) + E ≤ 0.05 × B` is **arithmetically unreachable even if
N = B exactly**, so "pass" is not an available answer for that cell in that pass
and "inconclusive" is the only outcome a well-behaved candidate can obtain.

Representative `E/B` (CPU, pass 1 / pass 2; the identity-2 series' pass-2 value
for scale):

| Cell | id3 p1 | id3 p2 | id2 p2 |
| --- | ---: | ---: | ---: |
| `nested-conditional-found/full` | 7.9 % | **23.2 %** | 8.7 % |
| `fixed-collection-rowref-1000/parse` | **10.3 %** | 6.6 % | 0.5 % |
| `fixed-collection-rowref-1000/full` | **11.8 %** | 5.2 % | 1.1 % |
| `scalar-find-unique/full` | 9.3 % | 8.6 % | 2.4 % |
| `fixed-collection-rowref-20/prepare` | 2.3 % | **10.6 %** | 2.4 % |
| `scalar-find-unique/execute` | 3.1 % | 4.8 % | 4.1 % |

The wall-time `E/B` reaches **42 %** on `fixed-collection-rowref-1000/parse` in
pass 1. For scale on the same four preparation cells, the identity-2 series'
CPU `E/B` was **2.4–6.0 %** against **2.3–10.6 %** here, and on six of the seven
cells that are inconclusive here it was **under 2.5 %** (the exception is
`nested-conditional-found/full`, 8.7 % there and 23.2 % here). This series was
taken between and around a system-level storm, at a 1-minute load of 5.8–13.1
on a 14-core machine that was never idle.

The consequence is stated plainly rather than argued away: **seven cells are
inconclusive because the measurement was not precise enough on this machine, not
because the candidate was measured over budget.** Under plan §7 an inconclusive
cell blocks adoption after the one permitted repeat, and that rule is applied
here without exception. But the diagnosis differs from identity 2's: there,
eleven cells were *resolved regressions*; here, four are resolved regressions
and seven are unresolved. A series on a quiet machine is what would settle them,
and this unit did not get one.

Two facts limit how far that reading can be pushed, and both are in the data:

- Three of the four cells that **block** do so on both passes, at CPU ratios of
  **1.401–1.484** with CPU `E/B` between 2.9 % and 9.2 % — far outside any
  plausible noise. They are regressions, not noise. (The fourth,
  `fixed-collection-rowref-20/prepare`, blocks on pass 1 only and is discussed
  in the proposal §10.2.)
- The six cells that **pass** do so on both passes. Nothing here depends on a
  single lucky series.

## C6. `relation-series-2` at identity 3: D-8 worked, and the cell still refuses

D-8 changed what the cell can do, and the change is visible first-hand.

- **At identity 2** the workload's own contract assertion threw *inside the
  observed driver call*; the engine re-wrapped it and the harness surfaced
  `QueryError: Query execution failed`. No replicate completed on the candidate
  side.
- **At identity 3** every replicate completes on both sides — `replicate 1/5`
  through `5/5`, baseline and candidate, are in the log — because
  `seriesLedger(defaults.length)` now selects each engine's **own** recorded
  ledger. The within-engine contract observation passes on both sides.

The cell then refuses at the **between-engine** comparison:

```
AssertionError [ERR_ASSERTION]: ["sqlite3","relation-series-2"] changed final
+ actual  - expected
  { id: 'series_child_2' ... }   -   { id: 'series_child_3' ... }   parentId 5000
  { id: 'series_child_3' ... }   -   { id: 'series_child_5' ... }   parentId 6000
```

`assertEquivalentRunObservations` (`benchmarks/operation-pipeline-semantics.mjs:74`,
via `verifyRewriteBenchmarkEvidence:113`) compares the two engines' authoritative
final state, which is exactly what plan §7 requires of the semantic mode
("compare public outcomes, authoritative state and causal contracts **between**
engines"). The persisted primary keys differ, so the comparison refuses and no
evidence report is written. The log is the receipt:
`cells/pass1__relation-series-2__full__cpu.log` and its three siblings.

This is the same underlying divergence
([`relation-series-2-classification.md`](relation-series-2-classification.md)):
the shipped engine evaluates `k + 2nk` generated defaults and the candidate
`k + nk`, so a counter default yields different ids. D-8 pinned each engine's
ledger inside the workload; it did not, and was not meant to, make the two
engines agree about what ends up in the table. The verdict is unchanged —
**blocks adoption — required contract divergence** — but the reason is now
sharper and better localized: it is one assertion, in the cross-engine
comparator, about two primary keys.

## C7. Deviations and judgements recorded for stage 2c

1. **The pass-2 attempt that was aborted** (C1.1), with all its receipts kept in
   `cells/aborted-pass2-attempt1/` and never relabelled. The decision was taken
   on the recorded machine state and a 300 s build timeout, before any of that
   attempt's numbers were aggregated.
2. **`TMPDIR=/private/tmp/viborm-g4-cutover-tmp2` for pass 2 only** (C1.1),
   because a stale lock from the aborted attempt was left in place. Shown
   measurement-neutral, not assumed.
3. **No lock file was removed**, including the stale one this unit itself
   created. It is still at
   `/private/tmp/viborm-g4-cutover-tmp/viborm-test-c33ebb4c906dfea8.lock`.
4. **The predecessor's aggregation helper was not used.** A helper at
   `…/scratchpad/aggregate.mjs` was left for this stage; read against the
   identity-2 record it produced, it changed four load-bearing rules: the
   straddle test (`δ ≤ budget` instead of `δ − E ≤ budget`), a **last-pass**
   instead of a **worst-pass** roll-up, a differing preparation seam overriding
   a *measured* `full` cell to "not measurable comparably" (which would have
   flipped `flat-scalar-update/full`), and an **empty** metric set scoring
   "pass". This stage instead adapted `aggregate2.mjs`, the program that
   produced `performance.json`, changing only the input directory, the gzip
   read, the output path and the commit metadata — plus two additions recorded
   here: `protocol.protocolIdentity` / `protocol.raptor3WorkloadVersion` (the
   D-8 overlay moved the protocol identity), a `passesAgree` boolean per cell,
   and a `shortError` branch for the cross-engine `AssertionError` shape, which
   is new at this identity. Copy: `receipts-stage2c/aggregate.mjs`.
5. **The series driver's lock classification was corrected.** The driver left
   for this stage matched `/lock|another verification|is already running/i`,
   which matches the *stale*-lock refusal but not the two refusals
   `scripts/test-run-lock.mjs` actually emits when a lock is **held**
   (`… already owns this workspace`, `workspace verification PID N is still
   active`). It would therefore have retried where retrying is wrong and given
   up where `protocol.md` §9.6 says to wait. The corrected driver waits 30 s and
   retries up to 20 times on a held lock and stops the series on a stale one.
   No command in either pass ever waited on a lock (`attempts=1` throughout).
   Copy: `receipts-stage2c/series-driver.mjs`.
6. **One mode per command for all 20 cells**, `fixed-collection-rowref-1000`'s
   cpu override, and the `retained` count split — all as §§8.3, 8.4 and 9.4
   predeclared. Unchanged from stage 2b.

## C8. Unverified claims (stage 2c)

1. **SQLite only.** Every number here is better-sqlite3 against `:memory:`
   fixtures. Nothing ran against native PostgreSQL or MySQL; the `g4.md`
   environment blocker stands.
2. **No mode, suite or typecheck was run by this stage.** The typecheck, build,
   bundle and registered-mode receipts are the previous author's, verified
   read-only as files (C0), not re-executed.
3. **The falsifiers were not re-run for identity 3.** The adapter's
   old-versus-old calibration, the changed-SQL / wrong-result specimens and the
   unchanged benchmark suites (`protocol.md` §3) were established against the
   baseline overlay at stage 2a. The D-8 overlay sits above that adapter and
   changes one contract workload's assertions; its effect on this cell was
   observed directly (C6) but no new falsifier was established for it. The
   cross-engine comparator's ability to refuse **was** demonstrated in this
   series — it refused `relation-series-2` — which is a live wrong-state
   falsifier, but it is not the full §3 set.
4. **The E/B reading in C5 is arithmetic, not an attribution.** That `E`
   exceeded the budget on 14 cells is computed from the saved MADs; that the
   ambient desktop load *caused* it is an inference supported by the recorded
   load and by the identity-2 series' smaller `E`, not a controlled experiment.
5. **The improvement claims in C4 are ratio comparisons across two different
   protocol identities.** D-8 changed a `PROTOCOL_PATHS` file, so identity 2's
   and identity 3's commands are not comparable command-for-command; only the
   within-series N/B ratios are compared, and both series' raw samples are
   retained.
6. **Nothing was re-measured about the shipped engine's own behavior.** The
   baseline implementation is still exactly `0cc61e61`'s (`e67b511b` and
   `e532bbec` contain no `src/` change, verified by `git show --stat`).
7. **The aborted attempt's 7 evidence reports were never aggregated or read.**
   They are kept as files only.

---

# Stage 2d — measurement against the FOURTH frozen identity (performance pass 2)

Identity 3 was superseded by **performance pass 2** (`g4/perf2/note.md`).
Everything sections C0–C8 and `protocol.md` §9 recorded is retained as a receipt
of *identity 3* and is **not** a result for this one. The protocol for this stage
is [`protocol.md`](protocol.md) §10, written **before** the series.

Frozen identity 4 (`g4/freeze/identity.json`):

```
production 312cde34932cdb4d70ccad60bb002d0c0a438865bd18e165c38b4a572ebff640
harness    1d4d913c4f686d7aa0871dde7f8af2c6049a674db2595c54a52b7f66491f2f9e
```

`/Users/arnaud/code/viborm` was **not** modified outside
`docs/architecture/raptor3-evidence/g4/cutover/` and `g4/cutover-proposal.md`.
Nothing there was committed, staged, reset, stashed or deleted. In the
measurement worktrees, the baseline was not touched at all and the candidate
received a **new branch** (`g4-perf-measurement-4`); `g4-perf-measurement`
still points at `90d4bb47` and every earlier tip is still reachable.

## D0. What was verified rather than redone

| Claim | How it was checked | Result |
| --- | --- | --- |
| both worktrees clean before anything | `git status --porcelain` | empty on both |
| baseline tip | `git log` | `e532bbec` on `g4-perf-baseline-overlay`, unchanged since stage 2c |
| candidate tip before this stage | `git log` | `90d4bb47` on `g4-perf-measurement` |
| the main tree holds the freeze | `captureRaptor3Identity("/Users/arnaud/code/viborm")` at 18:46 and again at 20:08 | `production`, `harness` **and** `runtime` byte-equal to `g4/freeze/identity.json` both times |
| the freeze is the one this stage was told to measure | `capturedAt` `2026-09-16T16:44:46Z` = 18:44:46 local, today, after 18:30 | yes |
| `benchmarks/` has not moved in the main tree | per-path byte comparison against `0cc61e61` and `e532bbec` (D1) | confirmed; the protocol did **not** move |
| the two worktrees run the same protocol | `protocolIdentity()` in both, plus a per-file `cmp` of all 24 `PROTOCOL_PATHS` | `f23e0aac…` in both, 0 of 24 differ; `diff -rq` on `benchmarks/` identical except the git-ignored `baseline.json` |
| the stale lock stage 2c left behind | `ls /private/tmp/viborm-g4-cutover-tmp/*.lock` | **gone** — the integrator removed it at 16:14 (proposal addendum). This unit created and removed no lock file. |
| the qualification campaign finished against *this* identity | `RUNS-COMPLETE` mtime 20:08:34 > `identity.json` mtime 20:06:00 | yes; polled, never busy-waited |

## D1. The one instruction that could not be executed as written

The prompt said: verify every `PROTOCOL_PATHS` file byte-identical between the
main tree and `e532bbec`, and **stop** if any differs, because "the protocol
moved". Five of the 24 differ. They are **exactly** the five files the
phase-adapter overlay `e67b511b` touches, and that overlay exists only in the
two measurement worktrees — so the literal check cannot pass, and did not pass
at stage 2c either.

The question behind it was answered exhaustively instead, per path
([`receipts-stage2d/protocol-paths-main-tree-check.json`](receipts-stage2d/protocol-paths-main-tree-check.json)):

| Group | Expectation | Result |
| --- | --- | --- |
| the 19 files the adapter does not touch (incl. D-8's `operation-pipeline-contract-workloads.mjs`) | byte-equal main tree ↔ `e532bbec` | **all 19 equal** |
| the 5 files the adapter touches | byte-equal main tree ↔ `0cc61e61` (pre-overlay bytes) | **all 5 equal** |
| uncommitted changes under `benchmarks/` or to `scripts/test-run-lock.mjs` in the main tree | none | none |

The protocol identity is therefore unchanged from stage 2c (`f23e0aac…`) and the
series ran. This is recorded as a deviation (D10.2), not hidden.

## D2. The package, rebuilt at identity 4

Commits, in order, on `g4-perf-measurement-4` (branched from `a9a482e1`, the
identity-3 **pre-cutover** production commit, so `captureRaptor3Identity` could
fingerprint a tree that still holds the legacy owners):

```
eee0ddfd  chore(raptor3): frozen G4 production for measurement (identity 4, perf pass 2)
bb2e0965  chore(raptor3): C-01 cutover for measurement (identity 4, perf pass 2)
bb0a4d60  test(raptor3): re-sync the harness files identity 4 contradicts
af8714cf  test(bench): G4 cutover preparation phase adapter          (cherry-pick of c22cb59e)
e05519c2  test(bench): D-8 per-engine ledger for relation-series-2   (cherry-pick of 90d4bb47)
```

1. **Re-sync.** `src/` wholesale (`rsync --checksum --delete`) from the main
   tree, plus `scripts/raptor3-manifest.mjs`, `vitest.workspace.ts` and the
   git-ignored `benchmarks/baseline.json` (the last two were already
   byte-equal). `diff -rq` against `a9a482e1` lists **exactly five files**,
   nothing added, nothing removed:

   | File | What it is |
   | --- | --- |
   | `src/query-engine/raptor3/shared/operation-context.ts` | pass-2 production |
   | `src/query-engine/raptor3/shared/query.ts` | pass-2 production |
   | `src/query-engine/raptor3/shared/schema.ts` | pass-2 production |
   | `src/query-engine/raptor3/shared/transport-attempt.ts` | pass-2 production |
   | `src/query-engine/raptor3/AGENTS.md` | documentation; `.md`, so not fingerprinted |

   plus `scripts/raptor3-manifest.mjs` (+1 line: the integrator's registration of
   `tests/raptor3/g4/unit02/prepared-projection-reuse.test.ts`). These are the
   four production files `g4/perf2/note.md` names, and no others.

2. **Identity, before the cutover.** `captureRaptor3Identity()` run **in the
   worktree with the worktree's own re-synced manifest** on `eee0ddfd`:
   `production = 312cde34…ff640`, byte-equal to the freeze; `runtime` equal too.
   `harness` is not equal and cannot be (B1/§9.3). Receipt:
   [`receipts-stage2d/identity-identity4.json`](receipts-stage2d/identity-identity4.json).

3. **Cutover, with zero adjustments.** `git apply --check` of
   [`receipts-stage2c/cutover-identity3.patch`](receipts-stage2c/cutover-identity3.patch)
   reported no failing hunk, because pass 2 touches four files the cutover does
   not edit (the cutover modifies 8, adds `src/query-engine/routed-operations.ts`
   and deletes 230). Verified rather than assumed: all nine non-deleted files are
   **byte-identical** to stage 2c's cutover commit `59c44d3c`, and the whole
   cutover tree differs from `59c44d3c` by exactly the six re-synced files. The
   re-recorded patch
   [`receipts-stage2d/cutover-identity4.patch`](receipts-stage2d/cutover-identity4.patch)
   is identical to the identity-3 patch except Git index lines. §F's rule needed
   no interpretation this time: nothing had to be re-derived by hand (stage 2c
   had one hand-applied hunk; this stage has none).

4. **Harness re-sync — nine files.** The new branch starts below stage 2c's
   `0db0377f`, so the same eight stale files came back; each main-tree version is
   byte-identical to what `0db0377f` set (pass 2 changed none of them). Added:
   `tests/raptor3/g4/unit02/prepared-projection-reuse.test.ts`, pass 2's new
   test, because the cutover keeps `tests/raptor3/g4/unit02/` (21 of its 28 files
   survive) and it imports only retained owners. Those nine are **every** file
   under `tests/` that exists on both sides and differs, checked file by file.

5. **Typecheck and build.** `node scripts/run-typecheck.mjs` at the tip reports
   **exactly the two permitted** `pattern/pack.ts` TS2345 diagnostics and nothing
   else (11.69 s wall, 5,032.4 MiB peak sampled process-group RSS under the
   8,192 MiB ceiling). `pnpm package:build` exits 0, 181 files, `dist/index.mjs`
   produced (5.56 s, 940.5 MiB peak under the 1,536 MiB ceiling). Receipts:
   [`typecheck-identity4.out`](receipts-stage2d/typecheck-identity4.out),
   [`package-build-identity4.txt`](receipts-stage2d/package-build-identity4.txt).

## D3. Bundles (brief §3)

[`bundles-identity4.json`](bundles-identity4.json) /
[`bundle-ratios-identity4.json`](bundle-ratios-identity4.json), measured on the
cutover build with `dist/` freshly rebuilt, against the frozen
`docs/architecture/raptor3-evidence/baseline.json`.

| Fixture | baseline gzip | identity 4 gzip | ratio | target | vs identity 3 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `engine` | 156,771 | 37,260 | **0.2377** | ≤ 0.75 | **byte-identical** |
| `pg-simple` | 262,658 | 183,791 | **0.6997** | ≤ 1.00 | +348 B (+0.19 %) |
| `pg-relations` | 262,788 | 183,921 | **0.6999** | ≤ 1.00 | +336 B (+0.18 %) |

Every target is met with margin, as at identities 2 and 3. Two things are worth
stating plainly rather than leaving in the JSON:

1. **The `engine` fixture contains no `raptor3` module at all.** Its 93 modules
   include `src/query-engine/routed-operations.ts` but nothing under
   `src/query-engine/raptor3/`: after the cutover `QueryEngine` takes the route
   as a required dependency, and the route is constructed by `client.ts`, which
   this fixture does not import. That is why the fixture is byte-identical
   across identities 2, 3 and 4 — performance pass 2 is invisible in it. **The
   0.2377 ratio must not be read as "the candidate implementation is 24 % of the
   shipped engine."** The two public PostgreSQL fixtures are the ones that carry
   both implementations end to end.
2. **Pass 2's cost is visible and small.** Both PG fixtures keep the same 311
   modules, 14 of them `raptor3`, and exactly the four pass-2 files grew:
   `query.ts` +2,186, `transport-attempt.ts` +1,728, `operation-context.ts`
   +1,614, `schema.ts` +1,392 rendered bytes, which minify and gzip down to
   +348 / +336 bytes.

## D4. Machine state, recorded rather than claimed

The integrator's attempt-6 campaign was running when this stage started and
finished at 20:08:34; the series began after that. No `vitest`, `run-raptor3` or
benchmark process existed during either pass. The machine's owner nevertheless
runs Cursor, Codex/ChatGPT, Devin, Raycast, Dia, Claude and a 100 %-CPU
`tsx` process that has been running since 14:53 — outside this unit's control,
and recorded rather than claimed away.

| Moment | 1-min load | Receipt |
| --- | ---: | --- |
| before the series (20:09) | **7.88** | [`machine-before-series.txt`](receipts-stage2d/machine-before-series.txt) |
| start of pass 2 (20:18) | **8.27** | [`machine-pass2-start.txt`](receipts-stage2d/machine-pass2-start.txt) |
| after the series (20:26) | 8.81 | [`machine-after-series.txt`](receipts-stage2d/machine-after-series.txt) |

`protocol.md` §10.6's gate (do not start a pass while the 1-minute load exceeds
20) never had to hold anything back: the load stayed between 7.9 and 11.1
across both passes, against 5.8–13.1 at stage 2c with a storm to 143 between
its passes. **No pass was aborted, and no lock file was created or removed.**

## D5. The series as run

Two full series, 40 commands each — one cell in one mode per command, five
alternating fresh-process pairs per side — from the baseline overlay worktree as
coordinator, exactly the command `protocol.md` §10.5 predeclared.

| | pass 1 | pass 2 (the one permitted repeat) |
| --- | --- | --- |
| window (UTC) | 18:09:50 – 18:17:47 | 18:18:45 – 18:26:34 |
| summed command wall | 8 min 09 s | 7 min 59 s |
| commands | 40 | 40 |
| evidence reports written | 34 | 34 |
| commands that refused | 6 | the same 6 |
| commands that waited on a lock | 0 | 0 |
| journal | [`cells/pass1-journal.txt`](receipts-stage2d/cells/pass1-journal.txt) | [`cells/pass2-journal.txt`](receipts-stage2d/cells/pass2-journal.txt) |

Every measured cell reports `measurementProtocolValid: true` with **5 baseline
and 5 candidate replicates in both modes** (checked for all 17 × 2 × 2), and the
counts are the frozen matrix's: 5,000/1,000 cpu and 500/100 retained for the
default workloads, 1,000/200 for `bulk-update-returning-100`, and 1,000/200 cpu
with the catalog's own 20/10 retained for `fixed-collection-rowref-1000` (§8.4).
Every measured preparation cell bracketed **the same seam on both sides**
(`package`, one statement).

Per-cell reports (`gzip -9`) and logs are in
[`cells/`](receipts-stage2d/cells/) (38 MB, 162 files); the driver is
[`series-driver.mjs`](receipts-stage2d/series-driver.mjs) and the aggregator
[`aggregate.mjs`](receipts-stage2d/aggregate.mjs), each stage 2c's program with
only the mechanical changes their headers list and **no change to any verdict
rule**. The aggregate of both passes is
[`performance-identity4.json`](performance-identity4.json); the first series
alone is retained as
[`performance-identity4-pass1.json`](performance-identity4-pass1.json).
`performance.json`, `performance-identity3.json` and
`performance-identity3-pass1.json` are untouched.

## D6. Verdicts

| Verdict | identity 3 | identity 4 |
| --- | ---: | ---: |
| pass | 6 | **5** |
| blocks adoption (resolved, over budget) | 4 | **3** |
| inconclusive after the one permitted repeat — blocks adoption | 7 | **9** |
| not measurable comparably — end-to-end evidence retained | 2 | 2 |
| blocks adoption — required contract divergence | 1 | 1 |

`B`, `N`, both MADs, `E = 2 × max(MAD)`, the budget, the signed delta,
`(N − B) + E`, every raw sample, the preparation seam and statement count each
side used and the prepared SQL are in `performance-identity4.json`, per cell and
per pass. Verdict rules are `protocol.md` §5's, unchanged, and the cell verdict
is **the worse of the two series**.

| Cell | pass 1 | pass 2 | final | CPU N/B (p1 / p2) | wall N/B | RSS N/B |
| --- | --- | --- | --- | ---: | ---: | ---: |
| `scalar-find-unique/cold-prepare` | inconclusive | pass | **inconclusive — blocks adoption** | 1.008 / 1.011 | 1.003 / 1.030 | 0.991 / 0.991 |
| `scalar-find-unique/prepare` | blocks | blocks | **blocks adoption** | 1.189 / 1.318 | 1.128 / 1.223 | 0.964 / 0.963 |
| `scalar-find-unique/execute` | inconclusive | pass | **inconclusive — blocks adoption** | 0.941 / 0.950 | 0.925 / 0.954 | 0.980 / 0.980 |
| `scalar-find-unique/full` | pass | pass | **pass** | 0.902 / 0.874 | 0.977 / 0.954 | 0.961 / 0.952 |
| `flat-scalar-update/prepare` | refused | refused | **not measurable comparably** | — | — | — |
| `flat-scalar-update/execute` | refused | refused | **not measurable comparably** | — | — | — |
| `flat-scalar-update/full` | pass | pass | **pass** | 0.698 / 0.702 | 0.832 / 0.838 | 0.953 / 0.952 |
| `fixed-collection-rowref-20/prepare` | inconclusive | inconclusive | **inconclusive — blocks adoption** | 0.974 / 0.988 | 1.077 / 1.093 | 0.969 / 0.969 |
| `fixed-collection-rowref-20/execute` | inconclusive | inconclusive | **inconclusive — blocks adoption** | 1.025 / 1.032 | 1.022 / 1.042 | 0.973 / 0.972 |
| `fixed-collection-rowref-20/full` | inconclusive | inconclusive | **inconclusive — blocks adoption** | 0.976 / 0.952 | 1.034 / 1.020 | 0.921 / 0.924 |
| `nested-conditional-found/full` | pass | pass | **pass** | 0.760 / 0.646 | 0.876 / 0.675 | 0.892 / 0.890 |
| `nested-conditional-missing/full` | pass | pass | **pass** | 0.759 / 0.742 | 0.898 / 0.877 | 0.902 / 0.917 |
| `key-transition-cascade/full` | inconclusive | pass | **inconclusive — blocks adoption** | 0.896 / 0.888 | 1.008 / 1.017 | 0.787 / 0.786 |
| `bulk-update-returning-100/prepare` | blocks | blocks | **blocks adoption** | 1.310 / 1.397 | 1.091 / 1.191 | 0.973 / 0.977 |
| `bulk-update-returning-100/full` | pass | pass | **pass** | 0.807 / 0.838 | 0.921 / 0.967 | 0.981 / 0.985 |
| `relation-series-2/full` | refused | refused | **blocks adoption — required contract divergence** | — | — | — |
| `fixed-collection-rowref-1000/prepare` | blocks | blocks | **blocks adoption** | 1.257 / 1.250 | 1.087 / 1.110 | 0.959 / 0.956 |
| `fixed-collection-rowref-1000/execute` | inconclusive | inconclusive | **inconclusive — blocks adoption** | 0.996 / 1.022 | 0.991 / 1.022 | 0.960 / 0.949 |
| `fixed-collection-rowref-1000/parse` | pass | inconclusive | **inconclusive — blocks adoption** | 0.989 / 1.028 | 1.028 / 1.067 | 0.946 / 0.950 |
| `fixed-collection-rowref-1000/full` | pass | inconclusive | **inconclusive — blocks adoption** | 1.025 / 1.026 | 1.032 / 1.029 | 1.038 / 1.041 |

## D7. What moved since identity 3, cell by cell

Comparison script:
[`compare-identity3-identity4.mjs`](receipts-stage2d/compare-identity3-identity4.mjs).
Unlike stage 2c's comparison, **the protocol identity did not move** this time
(`f23e0aac…` on both sides, workload version 1, same baseline commit
`e532bbec`, same commands), so the two series measure the same work with the
same instrument. Both passes are shown for each identity; nothing is collapsed
to one number.

| Cell | id3 | id4 | CPU N/B id3 (p1/p2) | CPU N/B id4 (p1/p2) | wall id3 | wall id4 | RSS id4 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| `scalar-find-unique/cold-prepare` | inconclusive | **inconclusive** | 1.059 / 1.025 | 1.008 / 1.011 | 1.092 / 0.999 | 1.003 / 1.030 | 0.991 / 0.991 |
| `scalar-find-unique/prepare` | blocks | **blocks** | 1.480 / 1.454 | 1.189 / 1.318 | 1.427 / 1.374 | 1.128 / 1.223 | 0.964 / 0.963 |
| `scalar-find-unique/execute` | pass | **inconclusive** | 1.002 / 0.985 | 0.941 / 0.950 | 1.006 / 0.983 | 0.925 / 0.954 | 0.980 / 0.980 |
| `scalar-find-unique/full` | inconclusive | **pass** | 1.018 / 1.030 | 0.902 / 0.874 | 1.036 / 1.066 | 0.977 / 0.954 | 0.961 / 0.952 |
| `flat-scalar-update/prepare` | not measurable | **not measurable** | — | — | — | — | — |
| `flat-scalar-update/execute` | not measurable | **not measurable** | — | — | — | — | — |
| `flat-scalar-update/full` | pass | **pass** | 0.771 / 0.757 | 0.698 / 0.702 | 0.907 / 0.870 | 0.832 / 0.838 | 0.953 / 0.952 |
| `fixed-collection-rowref-20/prepare` | blocks | **inconclusive** | 1.051 / 0.927 | 0.974 / 0.988 | 1.202 / 1.085 | 1.077 / 1.093 | 0.969 / 0.969 |
| `fixed-collection-rowref-20/execute` | pass | **inconclusive** | 1.028 / 1.022 | 1.025 / 1.032 | 1.028 / 1.021 | 1.022 / 1.042 | 0.973 / 0.972 |
| `fixed-collection-rowref-20/full` | inconclusive | **inconclusive** | 0.947 / 0.951 | 0.976 / 0.952 | 1.021 / 1.020 | 1.034 / 1.020 | 0.921 / 0.924 |
| `nested-conditional-found/full` | inconclusive | **pass** | 0.807 / 0.893 | 0.760 / 0.646 | 0.905 / 0.978 | 0.876 / 0.675 | 0.892 / 0.890 |
| `nested-conditional-missing/full` | pass | **pass** | 0.798 / 0.801 | 0.759 / 0.742 | 0.911 / 0.927 | 0.898 / 0.877 | 0.902 / 0.917 |
| `key-transition-cascade/full` | inconclusive | **inconclusive** | 0.915 / 0.901 | 0.896 / 0.888 | 1.046 / 1.024 | 1.008 / 1.017 | 0.787 / 0.786 |
| `bulk-update-returning-100/prepare` | blocks | **blocks** | 1.457 / 1.484 | 1.310 / 1.397 | 1.263 / 1.256 | 1.091 / 1.191 | 0.973 / 0.977 |
| `bulk-update-returning-100/full` | pass | **pass** | 0.861 / 0.829 | 0.807 / 0.838 | 0.975 / 0.966 | 0.921 / 0.967 | 0.981 / 0.985 |
| `relation-series-2/full` | contract divergence | **contract divergence** | — | — | — | — | — |
| `fixed-collection-rowref-1000/prepare` | blocks | **blocks** | 1.414 / 1.401 | 1.257 / 1.250 | 1.212 / 1.215 | 1.087 / 1.110 | 0.959 / 0.956 |
| `fixed-collection-rowref-1000/execute` | pass | **inconclusive** | 0.985 / 0.969 | 0.996 / 1.022 | 0.984 / 0.967 | 0.991 / 1.022 | 0.960 / 0.949 |
| `fixed-collection-rowref-1000/parse` | inconclusive | **inconclusive** | 1.002 / 1.035 | 0.989 / 1.028 | 1.042 / 1.075 | 1.028 / 1.067 | 0.946 / 0.950 |
| `fixed-collection-rowref-1000/full` | inconclusive | **inconclusive** | 1.053 / 1.015 | 1.025 / 1.026 | 1.093 / 1.010 | 1.032 / 1.029 | 1.038 / 1.041 |

Five readings, and two limits on them.

1. **Pass 2 moved every preparation cell in the right direction, and none of
   them enough.** The three cells that still block improve on both passes:
   `scalar-find-unique/prepare` 1.480/1.454 → **1.189/1.318** CPU,
   `bulk-update-returning-100/prepare` 1.457/1.484 → **1.310/1.397**,
   `fixed-collection-rowref-1000/prepare` 1.414/1.401 → **1.257/1.250**. The
   fourth identity-3 blocker, `fixed-collection-rowref-20/prepare`, is now at
   **0.974/0.988** CPU — under parity — and blocks no longer; it is inconclusive
   on **wall** time (1.077/1.093).
2. **Nothing regressed in number on any cell that mattered.** Of the 17
   measurable cells, 14 have a better (lower) worst-pass CPU ratio at identity 4
   than at identity 3; the three that do not —
   `fixed-collection-rowref-20/execute` (1.028 → 1.032),
   `fixed-collection-rowref-20/full` (0.951 → 0.976) and
   `fixed-collection-rowref-1000/execute` (0.985 → 1.022) — move by 0.4–3.7 %,
   inside their own pass-to-pass spread.
3. **Three verdicts got worse and none of them is a regression of the
   candidate.** `scalar-find-unique/execute` (pass → inconclusive) has a *better*
   ratio at identity 4 (0.941/0.950 against 1.002/0.985): it lost its "pass"
   because pass 1's `E/B` was 11.8 % (cpu) and 14.5 % (wall), i.e. that one pass
   was imprecise. `fixed-collection-rowref-20/execute` and
   `fixed-collection-rowref-1000/execute` lost theirs because a precise
   measurement put them 2.2–4.2 % above parity, which straddles a 5 % budget
   (D8).
4. **Peak RSS still passes every measurable cell**, and the big wins are intact:
   `key-transition-cascade` 0.787, the two nested writes 0.89–0.92,
   `fixed-collection-rowref-20/full` 0.92. One cell is above parity —
   `fixed-collection-rowref-1000/full` at 1.038/1.041 — well inside the 10 %
   budget, as at identity 3 (1.034).
5. **Six cells carry a defensible improvement claim** (CPU improvement greater
   than `E` on **both** passes): `scalar-find-unique/full`,
   `flat-scalar-update/full`, both `nested-conditional-*`,
   `key-transition-cascade/full` and `bulk-update-returning-100/full`. At
   identity 3 that list had five members and did not include
   `scalar-find-unique/full`.

The two limits:

- **Absolute medians are not comparable across the two identities, even though
  the commands are.** The machine was quieter this evening, and both sides moved
  together: on `fixed-collection-rowref-1000/parse` the **baseline** median fell
  from 859.7 to 470.6 µs/op (−45 %) and the candidate from 870.7 to 474.7
  (−45 %); on `/full`, 2,010 → 1,118 and 2,094 → 1,146. Nothing in the shipped
  engine changed (`e532bbec` contains no `src/` diff), so that is the machine,
  not the code. Only the **ratios** and their uncertainties are compared above.
- **The worse-of-two-passes rule is doing real work here.** Six cells disagree
  between their two passes; every one of them is recorded at its worse verdict.

## D8. The precision picture: a better instrument, and a sharper diagnosis

Stage 2c's C5 recorded that `E` exceeded the 5 % budget on **13 of 17**
measurable cells, which makes "pass" arithmetically unreachable. At identity 4
that count is **11 of 17** — better, and still the single largest limit on what
this series can conclude.

But the composition changed, and that is the useful part. The nine inconclusive
cells split cleanly in two:

| Cell | Why it is inconclusive | worst time ratio | worst `E/B` on a time metric |
| --- | --- | ---: | ---: |
| `scalar-find-unique/cold-prepare` | **precision**: `E` > budget in a pass | 1.030 (wall) | 5.1 % (cpu, p1) |
| `scalar-find-unique/execute` | **precision** | 0.954 (wall) | 14.5 % (wall, p1) |
| `fixed-collection-rowref-20/prepare` | **precision** | 1.093 (wall) | 8.1 % (wall, p2) |
| `key-transition-cascade/full` | **precision** | 1.017 (wall) | 5.4 % (wall, p1) |
| `fixed-collection-rowref-1000/execute` | **precision** | 1.022 (cpu) | 14.0 % (wall, p1) |
| `fixed-collection-rowref-20/execute` | **substance**: precise in both passes; sits above parity and straddles 5 % | 1.042 (wall) | 2.8 % |
| `fixed-collection-rowref-20/full` | **substance** | 1.034 (wall) | 4.2 % |
| `fixed-collection-rowref-1000/parse` | **substance** | 1.067 (wall) | 3.1 % |
| `fixed-collection-rowref-1000/full` | **substance** | 1.032 (wall) | 2.3 % |

Four of the nine are **not** a noise problem: the instrument was precise enough
(`E/B` 2.3–4.2 %) and the candidate is genuinely 2–7 % slower there. A quieter
machine will not turn those into passes; only a faster candidate will. The other
five are the familiar precision problem, and four of those five have a *better*
ratio than at identity 3.

One signature runs through the whole table and is worth naming, because it is
the opposite of what identity 3 concluded about the writes. **The candidate's
remaining deficit is in wall time, not CPU.** Averaging the two passes:

| | CPU N/B | wall N/B | wall − CPU |
| --- | ---: | ---: | ---: |
| `flat-scalar-update/full` | 0.700 | 0.835 | **+0.135** |
| `nested-conditional-missing/full` | 0.751 | 0.888 | **+0.137** |
| `key-transition-cascade/full` | 0.892 | 1.013 | **+0.121** |
| `bulk-update-returning-100/full` | 0.822 | 0.944 | **+0.121** |
| `fixed-collection-rowref-20/prepare` | 0.981 | 1.085 | **+0.104** |
| `nested-conditional-found/full` | 0.703 | 0.775 | +0.072 |
| `fixed-collection-rowref-20/full` | 0.964 | 1.027 | +0.063 |
| `scalar-find-unique/prepare` | 1.253 | 1.176 | −0.077 |
| `fixed-collection-rowref-1000/prepare` | 1.253 | 1.099 | −0.154 |
| `bulk-update-returning-100/prepare` | 1.353 | 1.141 | −0.212 |

On the write and relation-read cells the candidate converts a 15–30 % CPU saving
into only a 6–22 % wall saving; on the three blocking preparation cells the
reverse holds — the CPU penalty is larger than the wall penalty. Both patterns
are consistent with the GC accounting pass 2 targeted (process CPU counts helper
threads; wall counts the main thread only), but **this series does not measure
that mechanism and the reading is an inference, not a result** (D11.5).

## D9. `relation-series-2` at identity 4: unchanged, exactly as predicted

`protocol.md` §10.4 recorded, before the run, that this cell was expected to
refuse again at the **between-engine** comparison. It did, identically in all
four commands:

- every replicate completes on both sides (`replicate 1/5` … `5/5`, baseline and
  candidate, in each log) — D-8's per-engine ledger still does its job;
- `assertEquivalentRunObservations`
  (`benchmarks/operation-pipeline-semantics.mjs:74`) then refuses:

```
AssertionError [ERR_ASSERTION]: ["sqlite3","relation-series-2"] changed final
+ actual  - expected
  { id: 'series_child_2' … }  -  { id: 'series_child_3' … }   parentId 5000
  { id: 'series_child_3' … }  -  { id: 'series_child_5' … }   parentId 6000
```

The persisted primary keys are the **same two pairs** as at identity 3, which is
the correct outcome for a pass that promised no behaviour change: the shipped
engine evaluates `k + 2nk` generated defaults and the candidate `k + nk`, and
pass 2 did not touch that. Verdict unchanged: **blocks adoption — required
contract divergence**, target zero, decision for Arnaud
([`relation-series-2-classification.md`](relation-series-2-classification.md)).

`flat-scalar-update/prepare` and `/execute` also refused exactly as predicted
(`Error: Harness flat-scalar-update does not implement prepare|execute`): the
candidate's package still holds two statements there, so no single-statement
bracket exists. Their `full` cell is measured and passes on both passes.

## D10. Deviations and judgements recorded for stage 2d

1. **A new branch, not a reset** (`g4-perf-measurement-4` from `a9a482e1`).
   Every earlier tip is still reachable; nothing that produced an earlier receipt
   moved.
2. **The prompt's literal `PROTOCOL_PATHS` check was replaced** by the
   exhaustive per-path check of D1, because the literal form cannot hold while
   the phase-adapter overlay lives only in the worktrees. This is the one
   instruction not executed as written; it is recorded here, in
   `protocol.md` §10.2 and §10.7.2, and in the receipt.
3. **The new unit02 test file was added to the worktree**, unlike stage 2c's
   rule of adding no main-tree-only file. The prompt named it, the cutover keeps
   `unit02`, the integrator registered it in the manifest, and it imports only
   retained owners. It has no effect on any measurement: nothing under `tests/`
   is on the benchmark path.
4. **`src/query-engine/raptor3/AGENTS.md` was re-synced with the production
   files.** It is documentation; `captureRaptor3Identity` fingerprints only
   `.ts/.mts/.mjs/.js/.json`, so it cannot affect the identity (same judgement as
   §7.7).
5. **No lock file was created or removed**, and no pass was aborted. The stale
   lock stage 2c left behind was already gone (removed by the integrator at
   16:14); `TMPDIR` was `/private/tmp/viborm-g4-cutover-tmp` for **every**
   command, so stage 2c's `tmp2` deviation does not apply.
6. **The driver and the aggregator are stage 2c's programs**, changed only in
   the receipts directory, the output path, the candidate commit and the labels.
   Both diffs are in this note's receipts directory and in the file headers. No
   verdict rule, straddle test, roll-up or metric set was touched.
7. **The typecheck and the build ran while the integrator's campaign was
   running** (19:53–19:54 local, before `RUNS-COMPLETE`). They are not
   measurements, and the series did not start until the campaign had finished;
   but the campaign's own wall-limited tests shared the machine with a 5 GB
   typecheck for 13 s, which is recorded here rather than left implicit.

## D11. Unverified claims (stage 2d)

1. **SQLite only.** Every number here is better-sqlite3 against `:memory:`
   fixtures. Nothing ran against native PostgreSQL or MySQL; the `g4.md`
   environment blocker stands.
2. **No registered mode, suite or campaign was run by this stage.** The
   typecheck and `pnpm package:build` were run here; the registered-mode
   receipts are still the prep stage's, and the qualification campaign is the
   integrator's.
3. **The falsifiers were not re-run for identity 4.** The adapter's
   old-versus-old calibration, the changed-SQL / wrong-result specimens and the
   unchanged benchmark suites (`protocol.md` §3) were established at stage 2a
   against the same protocol bytes this series used (`f23e0aac…`, unchanged since
   stage 2c). The cross-engine comparator's ability to refuse **was**
   demonstrated live again — it refused `relation-series-2` in all four
   commands — but that is one falsifier, not the full §3 set.
4. **Nothing was re-measured about the shipped engine's own behaviour.** The
   baseline implementation is still exactly `0cc61e61`'s; `e67b511b` and
   `e532bbec` contain no `src/` change.
5. **D8's wall-versus-CPU reading is an inference.** The ratios are measured;
   the attribution to GC helper-thread accounting is a hypothesis consistent with
   `g4/perf2/note.md` §0.2, not something this series tested.
6. **"Pass 2 changed no behaviour" is not established by this stage.** This
   series measures time and memory, and observes that the same six commands
   refuse for the same reasons with the same persisted ids. The behavioural
   claim belongs to the integrator's qualification campaign and to
   `g4/perf2/note.md`.
7. **The `engine` bundle ratio is not a candidate-size result** (D3.1). It is
   reported because the brief asks for the fixture, with its composition stated.
8. **The absolute-median comparison in D7 is descriptive.** That the machine,
   not the code, moved both sides on `fixed-collection-rowref-1000` is supported
   by the baseline having no source change and by both sides moving by the same
   percentage; it is not a controlled experiment.
