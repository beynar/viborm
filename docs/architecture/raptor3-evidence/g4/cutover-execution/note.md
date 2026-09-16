# C-01 cutover execution — the Raptor 3 engine ships

Unit `g4-cutover-execution`, author stage. Brief:
[`g4/briefs/cutover-execution.md`](briefs/cutover-execution.md). Decisions
**D-9** (Arnaud accepts the measured preparation cost) and **D-10** (the
cutover is PERFORMED in the main tree, locally, as the next commit) in
[`g4.md`](../g4.md). Nothing is pushed, nothing is committed by this unit, no
database is changed.

- **Base** (main tree `HEAD` at launch, commit 3, the qualified pass-2 tree):
  `5a37bcd7f371fe393cf7cecb8ec9f82ef8bd3062`
  — `perf(raptor3): stop allocating write machinery and re-deriving schema facts on reads`
- **Frozen identity at launch** (identity 4, freeze 6), re-checked in the main
  tree before the first edit and byte-equal to `g4/freeze/identity.json`:
  `production 312cde34932cdb4d70ccad60bb002d0c0a438865bd18e165c38b4a572ebff640`,
  `harness 1d4d913c4f686d7aa0871dde7f8af2c6049a674db2595c54a52b7f66491f2f9e`
  ([receipt](receipts/identity-before.json)).
- **Patch** applied: `g4/cutover/receipts-stage2d/cutover-identity4.patch`
  (stage 2d's patch for the frozen pass-2 identity; it was present, so the
  stage-2c fallback was not used).

---

## 0. Decision-elimination gate (written before the first production edit)

**Required behavior.** A VibORM client must execute every model operation
through exactly one engine. Since G4-03 the estate has carried two: the shipped
write/read engine reached by `PendingOperation`'s legacy arms, and the Raptor 3
candidate reached by a non-public `route` argument that only
`createCandidateClient` and the two-sided harness ever passed. Qualification
attempt 6 and stage 2d measured the candidate on the frozen identity; D-9 and
D-10 decided it ships.

**Current owner.** `src/query-engine/pending-operation.ts` owns the *choice*:
`#resolveOperation`, `#statementOperation`, `#resolveSinglePlan`, `#singlePlan`,
`#operationInstance`, `#operationResolved`, `#operationExecutor`, `#executor()`
and the non-route branch of `#run`. `src/client/client.ts` owns the *selection*
(`VibORM.create(config, route?)`). `src/query-engine/query-engine.ts` owns the
two legacy executors the choice consumes.

**Smallest proposed change.** Exactly the measured diff: the constructor builds
`createCandidateRoute(...)` unconditionally, `VibORM.create` loses the non-public
`route` parameter, `pending-operation.ts` keeps only the route arm,
`query-engine.ts` loses `operationExecutor`/`cacheOperationExecutor`,
`client-route.ts` loses `createCandidateClient`, the four `routing.ts`
consumers re-point at a new 48-line `src/query-engine/routed-operations.ts`,
and every owner that becomes unreachable is deleted with the suites that
addressed it. No production file is edited beyond the patch.

**The decisions that disappear.**

| Decision | Mechanism | Consumers | Replacing invariant | Falsifier |
| --- | --- | --- | --- | --- |
| "Which engine owns this operation?" | `PendingOperation`'s route/non-route branches; `QueryEngine`'s two executors; `VibORM.create`'s `route` parameter | every client lineage, `bind()`, the cache and extension seams | **Every client lineage installs the route in `VibORM`'s constructor and `bind()` forwards it** — there is exactly one operation owner and no routeless path | grep for a legacy import or fallback under `src/` (plan §7 rows, §5 below); any surviving `new QueryEngine(` path that reaches an executor |
| "Does this operation have a legacy fold to fall back to?" | `write-engine/`'s 25 owners plus the seven `query-engine/` root owners and `builders/to-one-composition.ts` | `OperationExecutor`, `pending-operation.ts` | **The candidate never falls back** (`raptor3/AGENTS.md`: the route "opens, closes and retries nothing, and never falls back to the shipped engine") | the deleted owners are gone from disk: an import of any of them fails to resolve |
| "Is this verb read or write, and who says so?" | `write-engine/routing.ts` exporting `READ_OPERATIONS`/`ROUTED_OPERATIONS` from inside the engine being deleted | `client.ts`, `extensions/{definition,methods,query}.ts`, `cache-flow.ts` | **One retained owner outside either engine** (`routed-operations.ts`), verbatim, so the interception and cache seams keep the same classification (notably `findUniqueOrThrow`/`findFirstOrThrow`, which `raptor3/shared/schema.ts#isReadOperation` classifies differently) | a cache or interception test that keys on an `*OrThrow` verb |
| "Run the same oracle twice, once per engine" | six registered two-sided modes and 21 reviewer probes built on `createCandidateClient` / `VibORM.create(config, route)` | the G4 harness | **After C-01 there is no control left to run**: a re-pointed two-sided test compares the candidate with itself | any surviving test that builds two clients and deep-equals them |

**What this unit does NOT claim to remove.** `pattern/` and the 25 owners it
keeps alive (§4 below), the optional `route?:` type on `QueryEngine`, and the
`relation-series-2` benchmark divergence. All three are recorded as follow-ups,
per the brief.

---

## 1. What was applied

### 1.1 The measured cutover diff, as one `git apply`

`g4/cutover/receipts-stage2d/cutover-identity4.patch` (4,390,970 bytes) applied
to the main tree with **zero** hunk adjustments and **zero** rejects
([receipt](receipts/git-apply.log); `git apply --stat` reports
`239 files changed, 106 insertions(+), 115,495 deletions(-)`).

| Class | Count | Detail |
| --- | ---: | --- |
| production files modified | **8** | `src/client/client.ts`, `src/query-engine/pending-operation.ts`, `src/query-engine/query-engine.ts`, `src/query-engine/raptor3/route/client-route.ts`, `src/extensions/{definition,methods,query}.ts`, `src/query-engine/cache-flow.ts` |
| production files added | **1** | `src/query-engine/routed-operations.ts` (48 lines) |
| production owners deleted | **33** | `write-engine/` 25, seven `query-engine/` root owners, `builders/to-one-composition.ts` — 28,740 lines |
| test files deleted | **197** | `tests/contracts/` 134, `tests/raptor3/` 26, `tests/pattern/` 19, `tests/providers/` 15, `tests/types/` 2, `tests/unit/` 1 — 86,498 lines |
| **total** | **239** | 230 deletions + 8 modifications + 1 addition |

`git status` after the apply listed **exactly** the patch's file set and nothing
else: 229 `D` + 8 `M` + 1 `??`, plus two pre-existing dirty entries that the
patch itself consumed (§1.2). Receipts: [`git-status-before.txt`](receipts/git-status-before.txt),
[`git-status-after-apply.txt`](receipts/git-status-after-apply.txt).

`src/**/*.ts` goes from **581** files to **549**.

### 1.2 One conflict between two instructions, resolved and recorded

The common brief's rule 3 names `tests/pattern/pack/program-dump.ts` as a dirty
unrelated file that "stays untouched". **The measured patch deletes it**, and it
also deletes the untracked `tests/pattern/match/decode-malformed.core.test.ts`.
Both deletions are load-bearing, not incidental:

- `decode-malformed.core.test.ts` imports `@query-engine/validator`, a deleted
  owner (`cutover/receipts/deleted-tests-legacy-import.txt:104`);
- `program-dump.ts` imports `@tests/pattern/harness/dump`, which the patch
  deletes, so it is orphaned (`cutover/receipts/deleted-tests-orphaned.txt:43`).
  Its own other imports (`pattern/fragment`, `pattern/pack`,
  `write-engine/OperationFragment`) are all retained.

Neither file can typecheck after the cutover, so the terminating condition
("exactly the two Pattern diagnostics") cannot hold with them present. The
deletion therefore stands, but **both preimages — including the uncommitted
modification to `program-dump.ts`, which differs from `HEAD`** — are preserved
byte-for-byte under
[`receipts/preserved-unrelated-dirty/`](receipts/preserved-unrelated-dirty/)
so nothing another stream wrote is lost. **This is the one item in this unit
that needs Arnaud's or the integrator's call before commit 4.**

### 1.3 Retired instruments (brief item 2)

**Six registered two-sided modes left `scripts/raptor3-manifest.mjs`.** Their
`*_COUNTS` / `*_TESTS` constants were deleted and replaced by a comment naming
the reason; their test files are deleted by the patch.

| Mode | Cells it carried | File the patch deletes |
| --- | ---: | --- |
| `g4-lifecycle-events` | 3 | `tests/raptor3/g4/lifecycle-events.test.ts` |
| `g4-lifecycle-admission` | 4 | `tests/raptor3/g4/lifecycle-admission.test.ts` |
| `g4-route-lifecycle` | 8 | `tests/raptor3/g4/route-lifecycle.test.ts` |
| `g4-route-admission` | 7 | `tests/raptor3/g4/route-admission.test.ts` |
| `g4-route-cache` | 7 | `tests/raptor3/g4/route-cache.test.ts` |
| `g4-route-transactions` | 13 | `tests/raptor3/g4/route-transactions.test.ts` |

plus the shared helper `tests/raptor3/g4/route-contract.ts`. The registered
fixed estate goes **65 modes → 59**.

Removing those six constants forces four consumers, which the brief does not
name but which cannot compile or run without the change; each edit is the
deletion of the six names and nothing else:

- `scripts/run-raptor3.mjs` — the six imports, the six entries of the
  credential-free group list, of the mode→tests map and of the mode→counts map,
  and the six names in the usage string;
- `scripts/credential-free-test-manifest.mjs` — the six imports and the six
  spreads in `extendedLocalExclusions`;
- `scripts/raptor3-campaign-receipts.test.mjs` (the support group's receipts
  self-test) — the six imports, the six spreads in `G4_FIXED_SUITES`, and the
  six names in the "G4 fixed modes admit their exact contract" list;
- `vitest.workspace.ts` — the six imports and the six spreads in the `raptor3`
  project.

**21 reviewer probes retired.** The patch deletes 18 under
`tests/raptor3/g4/review/{unit02,unit02-closure,unit03,unit03b}/`; this unit
deleted three more the patch could not reach because they were added to the
main tree after the measurement worktree was copied. All 21 build a shipped
client and a candidate client side by side; none belongs to a registered mode
(proved against every array `scripts/raptor3-manifest.mjs` exports).

<details><summary>the 21 retired probes</summary>

Deleted by the patch (18): `unit02-closure/route-cache-codec.review.test.ts`;
`unit02/{packaged-cardinality,repair-packaged-guard,route-admission-count}.review.test.ts`;
`unit03/{route-admission-count,route-array-reads,route-behavior-divergence,route-envelope,route-observer-failures,route-region-followup,route-uncaught-failure}.review.test.ts`;
`unit03b/{route-admission-seam,route-array-verbs,route-envelope-array,route-nested-payload,route-seams,route-upsert-payload,route-write-outcome}.review.test.ts`.

Deleted by this unit (3): `regression/{d7-lone-statement,seam-followup,uncertain-outcome-neighbours}.review.test.ts`
— each imports `createCandidateRoute` and calls `VibORM.create(config, createCandidateRoute)`,
which no longer typechecks.
</details>

**`vitest.workspace.ts` / `scripts/credential-free-test-manifest.mjs` pruning.**
Beyond the six spreads, exactly one entry now matches no file:
`tests/unit/validation/boundaries.core.test.ts` in the `coverage-errors`
project, which the patch deletes; it was removed. **No vitest project becomes
empty** — every glob and every explicit list keeps at least one file, proved
file-by-file before the apply. `EXTENDED_LOCAL_TESTS`,
`SQLITE3_PROVIDER_TESTS`, `LIBSQL_PROVIDER_TESTS` and `PGLITE_PROVIDER_TESTS`
are computed by a directory walk, so the 62 / 3 / 4 / 0 deleted members leave
them by themselves (189 / 6 / 5 / 6 survive).

**The G4 read/write campaign harness does not use the private seam.**
`grep -rn "createCandidateClient\|createCandidateRoute\|VibORM.create("` over
`tests/raptor3/g4/generation/` returns nothing, and all four campaign families'
first children run green on the cutover tree (§3.5).

### 1.4 The rule this unit used to classify a cell, and why

The brief asks for a per-cell classification of `packaged-array.test.ts`. Four
more registered files and three reviewer probes turned out to carry the same
construction, because the measurement worktree the patch was built from never
held them. One rule was applied to all of them, and it is stated here so a
reviewer can re-derive every disposition:

> Remove the shipped arm and every assertion that references it. If at least one
> assertion survives **verbatim**, the cell is kept and renamed to what it now
> claims; otherwise the cell is retired. Nothing is invented, and no shipped
> answer is transcribed into a new literal.

A registered refusal that a cell pinned one-sidedly is always kept: refusals are
contracts (common brief, rule 9).

| File | Cells | Disposition |
| --- | --- | --- |
| `tests/raptor3/g4/unit02/packaged-array.test.ts` | **5 → 3** | RETIRED 2 ("a missing root delete/update aborts the array exactly as the shipped engine does" — every assertion was `candidate === shipped`). KEPT 3: the present-root-delete cell keeps `rejected === "none"` and is renamed "a present root delete does not reject the array"; the two `prepareBatch` pins are unchanged in substance and now reach the engine through `createClient`. |
| `tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts` | **10 → 8** | RETIRED 2 (cell 7 "…answers the same on both routes" and cell 8, whose two literals pinned the SHIPPED outcome). KEPT 8, each with its verbatim one-sided assertion; cells 6, 9 and 10 renamed to what they now claim. `observeInvalidation` / `observeSplitWrite` lost their `route` parameter and build one `createClient` world. |
| `tests/raptor3/g4/unit02/decimal-having-operand.test.ts` | **3 → 1** | RETIRED 2 — their oracle was `QueryEngine.build(...)`, which after the cutover raises "Operation 'groupBy' does not compile to one SQL statement" for every operation (`PendingOperation.buildStatement()` answers `undefined`, divergence D-4'). KEPT the third cell for its `assert.match` on the REGISTERED refusal. |
| `tests/raptor3/g4/unit02/key-arithmetic.test.ts` | **20 → 20** | 2 cells re-expressed: the R-D3 `increment`/`multiply` cells dropped their shipped arm and the `assert.equal(shipped.answer, …)` that recorded the accepted divergence; the registered `UnsupportedOperationError` identity, its `meta` and the surviving rows are untouched. |
| `tests/raptor3/g4/unit02/lone-statement-transport.test.ts` | **7 → 7** | 1 cell re-expressed: cell 7 dropped the shipped `{ statements: 1, index: 0 }` pin and the "nothing else diverges" comparison, and keeps the one-sided D-7 pin `{ statements: 1, index: undefined }` for root `update`/`delete`, which no other cell in the file reaches. Renamed. |

`g4-unit02-author` therefore moves from **21 files / 136 cells** to
**21 files / 130 cells**, and the runner verifies that count exactly
([receipt](receipts/fixed/g4-unit02-author.log)).

### 1.5 Retained by instruction (brief item 3) — verified, not assumed

`src/query-engine/pattern/` and the 25 owners it keeps alive are untouched: the
18 surviving `write-engine/` files are on disk, and the
`types.ts → OperationFragment → record-series → OperationExecutor` chain still
resolves — the whole-estate typecheck reports **exactly** the two historical
`pattern/pack.ts` TS2345 diagnostics at `:1443` and `:2633` and nothing else
([receipt](receipts/typecheck-final.txt)). The `route` parameter of
`QueryEngine` stays `route?:` with the single localised
`engine.route as ClientOperationRoute` in `PendingOperation`; it is recorded as
a follow-up in §5.

### 1.6 Public contract record (brief item 4)

`DatabaseAdapter.expressions` carries `integerDivide: (left: Sql, right: Sql) => Sql`,
implemented by the three shipped adapters (MySQL `TRUNCATE(left / right, 0)`,
PostgreSQL `(left / right)`, SQLite `(left / CAST(right AS INTEGER))`). It was
already in the frozen candidate; **the cutover makes it the only path**, so a
third-party `DatabaseAdapter` implementation will not typecheck until it
supplies the member. There is no changeset convention in this repository, so it
is recorded here and in the commit-message draft (§6).

### 1.7 Guides (brief item 5)

`src/query-engine/raptor3/AGENTS.md` said "The shipped engine remains the public
route. This directory is not a production replacement or a fallback." Those two
sentences are now false. The header is re-titled and re-worded to state that the
directory IS the production engine since C-01, that `VibORM`'s constructor
builds `createCandidateRoute(...)` for every client, and that it remains neither
a fallback nor part of the package entry. The `client-route.ts` docblock is the
patch's own (hand-applied at stage 2c and carried unchanged). Nothing
speculative was added; the guide is outside both identity fingerprints.

---

## 2. THE BLOCKER: the differential harness's baseline arm dies with the engine

> **Round 2 restates this section.** The population below is the registered
> raptor3 estate only; the repository's own core gate (`pnpm test:core`) adds
> **34 files / 533 cells**, and six of those files carry failures this unit
> cannot classify. Read §2 with **R2.2** (the measured population) and **R2.4**
> (every red, classified) — the review's finding 1.

**Twelve registered modes and two support checks are RED on the cutover tree.
Every one of them fails for the same reason, and no candidate defect was found.**

The cutover proposal §3.1 counted the harness cost as "7 modes break, all at the
cutover seam" — and §7 says plainly that the other 95 "intact" modes were never
executed, where *intact* only meant "every test file the mode names still
exists". Running them is what this unit added, and it shows the cost is larger
than the seam: **the G0–G2 differential harness and the G4-01 SQL parity probes
reach the shipped engine through `createClient(...)` or `QueryEngine.build(...)`,
not through the private route selector**, so the patch's file-set analysis could
not see them. After C-01 `createClient` IS the candidate and
`QueryEngine.build` raises for every operation, so the control arm is gone.

| Group | Modes | Green | Red |
| --- | ---: | ---: | ---: |
| fixed | 59 | **51** | **8** |
| native PostgreSQL | 12 | **10** | **2** |
| native MySQL | 11 | **9** | **2** |
| support | 6 checks | **4** | **2** |
| G4 campaign children | 4 | **4** | 0 |

### 2.1 Every red, with its failing files and its cause

| Red | Failing file(s) / cells | Cause |
| --- | --- | --- |
| `g0` | `gate.test.ts` 1/9, `fixed.test.ts` 4/24 | `tests/raptor3/scenarios/contracts/instances.ts:180` runs the scenario with **no** `candidateFactory` as the baseline (`createClient`) and asserts the legacy `k + 2nk` default evaluations (`ticket-4`, `ticket-5`). The baseline is now the candidate, which evaluates `k + nk`. This is the D-8 difference, seen from the G0 harness. |
| `g1-baseline` | `expanded/lifetime-legacy.test.ts` 2/16 | same: the file's whole subject is the legacy engine's lifetimes. |
| `g1-contracts` | `expanded/lifetime-commands.test.ts` 2/16 | the commands file compares against the legacy arm it builds itself. |
| `g1-compare` | `candidate.test.ts` 8/48, `candidate-ordering.test.ts` 4/4 | the G1-01 comparison mode: one oracle, two subjects. |
| `g2-generated` | `g2-generated.test.ts` 36/46 | `generation/campaign.ts:102` — "G2 seed 2100, sqlite-interactive, **baseline** failed": the admission ledger the baseline is asserted against is the legacy engine's. |
| `g2-transport` | `g2-transport.test.ts` 16/16 | the same baseline arm on the scripted transports. |
| `g4-unit01-author` | `unit01/repair2.test.ts` 7/22 | `shipped()` is `new QueryEngine(...).build(spot, "findMany", args)`; `buildStatement()` now answers `undefined`, so `build` raises. 18 occurrences of the refusal in the log. |
| `g4-unit01-review` | `review/unit01-followup2/distance-depth.test.ts` 12/13, `review/unit01-followup/distance-parity.test.ts` 7/9, `review/unit01-followup2/distance-pins.test.ts` 4/4 | same `QueryEngine.build` oracle; 49 occurrences of the refusal. |
| `g2-pg-baseline`, `g2-mysql-baseline` | `transitions/unique-races-live-legacy.test.ts` 1/3 | `unique-races-live.ts:132` `const expectedAttempts = candidateFactory ? 1 : 2` — the legacy arm is expected to retry twice. |
| `g2-pg-contracts`, `g2-mysql-contracts` | `transitions/unique-races-live-commands.test.ts` 1/3 | the *commands* test runs the baseline arm first, and it is the baseline arm's own assertion that fails — not the candidate's. |
| support: CLI self-test | 10/10 cells | `scripts/raptor3-cli.test.mjs` shells out to `run-raptor3 g0` and asserts exit 0. Entirely downstream of `g0`. |
| support: credential-free "Raptor 3 fixed" | 18 of 758 cells in 4 of 65 files | `candidate.test.ts`, `candidate-ordering.test.ts`, `fixed.test.ts`, `expanded/lifetime-commands.test.ts` — the same four files as `g0` / `g1-compare` / `g1-contracts`. |

**No red is a candidate defect.** Each failing assertion is either the legacy
engine's own recorded behaviour (`k + 2nk` defaults, the two-attempt unique-race
retry) or the `QueryEngine.build` single-statement oracle that C-01 deliberately
removes. The candidate arm of every one of these files passes.

### 2.2 Why this unit did not "fix" them

Re-pointing a differential at `createClient` on both sides produces a suite that
compares the candidate with itself and reports green forever — the exact outcome
the brief and the proposal forbid for the six named modes. Deciding what
replaces the G0/G1/G2 differential lanes is a harness redesign (the honest
one-sided replacements are the generation campaigns, which already assert
against fixtures and oracles), and it is a decision, not a repair. The brief
says a red verification is a blocker to report; that is what this is. The only
files this unit re-expressed are the ones the cutover left **unable to
typecheck** (§1.3, §1.4).

---

## 3. Verification

Every command ran serially under the existing workspace lock, on the pinned
runtime (`node v24.21.0`), from `/Users/arnaud/code/viborm`. No lock was ever
removed; none was contended. Raw receipts:
[`receipts/`](receipts/) — `fixed/`, `native-pg/`, `native-mysql/`, `support/`,
`campaigns/`, each with a `RUN.log` and one log per mode.

### 3.0 The two gates round 2 added (review finding 3)

- `pnpm test:coverage:policy` — **11 / 11** after the manifest pruning of R2.1
  ([receipt](receipts/round2/coverage-policy-after.log)); 9 / 11 before it.
- `tests/contracts/architecture/core-taxonomy-census.core.test.ts` — **4 / 4**
  ([receipt](receipts/round2/core-taxonomy-census-after.log)); 3 / 4 before it.
- `node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project='layer-*'`
  (the core lane) — **RED, 34 files / 533 cells**, measured and classified in
  R2.2 and R2.4 ([receipt](receipts/round2/test-core-cutover-round2.log)).

### 3.1 Whole-estate typecheck — GREEN

`node scripts/run-typecheck.mjs` reports **exactly** the two historical
`pattern/pack.ts` TS2345 diagnostics at `(1443,36)` and `(2633,58)` and nothing
else. **Round 2: this is no longer true of the tree**, through no change of this
unit's — the review's retained probe
`tests/raptor3/g4/review/cutover/routed-operations-authority.review.test.ts`
adds three TS2322 diagnostics (R2.6.1). 16.64 s wall, 5,362.0 MiB peak sampled process-group RSS (ceiling 8,192
MiB) on the first pass. Receipts: [`typecheck-1.txt`](receipts/typecheck-1.txt)
(straight after the apply, before the harness work),
[`typecheck-2.txt`](receipts/typecheck-2.txt),
[`typecheck-final.txt`](receipts/typecheck-final.txt).

### 3.2 Build — GREEN

`pnpm package:build`: exit 0, "Build complete in 6882ms", **181 files**,
`dist/index.mjs` produced (1,975 bytes). 7.53 s wall, 855.6 MiB peak RSS
(ceiling 1,536 MiB). [`package-build.txt`](receipts/package-build.txt).

### 3.3 Bundle fixtures — GREEN, zero bytes of difference

`node scripts/measure-raptor3-baseline.mjs --bundle` on the freshly rebuilt
`dist/`, compared field-by-field with `g4/cutover/bundles-identity4.json`:

| Fixture | runtime bytes | gzip bytes | sha256 | vs identity 4 |
| --- | ---: | ---: | --- | --- |
| `engine` | 123,093 | 37,260 | `b4bbee47…a5e9` | **identical** |
| `pg-simple` | 623,999 | 183,791 | `91acc78c…a356` | **identical** |
| `pg-relations` | 624,280 | 183,921 | `a799ab40…6cc3` | **identical** |

Module lists, external-package lists and per-module rendered lengths are
identical too: the comparison reports **0 differing fields** across all three
fixtures. Ratios against the frozen baseline are unchanged — engine **0.2377**
(target ≤ 0.75), `pg-simple` **0.6997** and `pg-relations` **0.6999**
(target ≤ 1.00). Receipts: [`bundles-after.json`](receipts/bundles-after.json),
[`bundles-run.txt`](receipts/bundles-run.txt).

Read the engine fixture's 0.2377 as the proposal's D3 does: that fixture holds
**no** `raptor3` module at all after the cutover, so it is not a candidate size
result; the two public PostgreSQL fixtures are.

### 3.4 The registered estate — 70 green / 12 red

Counts per group, one receipt per mode:

- **fixed, 59 modes** (65 minus the six retired): **51 green**, 1,206 cells
  passing; **8 red** (§2.1). `g4-unit02-author` reports its new **21 files /
  130 tests** exactly. **Its FIRST attempt failed** (`receipts/fixed/RUN.log:1`,
  `g4-unit02-author exit=1` at 21:02:52, before the re-expressions of §1.4 were
  complete); it was re-run at 21:08:59 and again at 21:23:12, both `exit=0`, and
  the per-mode log holds the last run. The RUN.log keeps all three labelled;
  this sentence is the review's finding 8.
- **native PostgreSQL, 12 modes** on `viborm-raptor3-g3-pg-20260914`
  (`docker port … 5432` → `127.0.0.1:55729`): **10 green**, **2 red**.
- **native MySQL, 11 modes** on `viborm-raptor3-g3-mysql-20260914`
  (`docker port … 3306` → `127.0.0.1:55730`): **9 green**, **2 red**.
- **support**: receipts self-test **green** (39/39,
  [`receipts-selftest.log`](receipts/support/receipts-selftest.log)); CLI
  self-test alone **RED** (0/10, downstream of `g0`); structure census **green**
  (§4); driver integration **green** (2 files / 16 tests through `layer-client`
  with the 1,536 MiB RSS and 768 MiB heap ceilings); credential-free selectors
  — `--only "raptor3-provider:"` **green**, `--only "Raptor 3 fixed"` **RED**
  (740/758, the same four files).

No database was created, migrated or dropped. The E-1 stale-world drop the
qualification driver performs before each native group was **not** run: the
MySQL tmpfs was at 228 MiB / 512 MiB and PostgreSQL at 64 MiB / 512 MiB before
the groups, and both groups completed without a disk-full failure.

### 3.5 G4 campaign children — GREEN, corpora byte-identical

One first child per family, on the cutover tree, compared with the attempt-6
retained archives:

| Command | corpus bytes | body sha256 (identity removed) | verdict |
| --- | ---: | --- | --- |
| `g4-seed-batch 20000 --subject=candidate` | 338,001 = 338,001 | `55949767…dda4` = retained | **identical** |
| `g4-transport-seed-batch 50000 --subject=candidate` | 324,201 = 324,201 | equal | **identical** |
| `g4-write-seed-batch 75000` | 61,371,797 = 61,371,797 | equal | **identical** |
| `g4-write-transport-seed-batch 100000` | 64,091,456 = 64,091,456 | equal | **identical** |

The only difference in any of the four corpora is the embedded
`identity.production` / `identity.harness` fingerprint (`312cde34…` →
`f42d6fac…`), which **must** change because the source changed;
`identity.runtime` is equal. Every generated cell, every replay and every
recorded observation is byte-for-byte what attempt 6 recorded. The engine did
not change — only the way the client reaches it. Machine-readable record:
[`campaigns/corpus-comparison.json`](receipts/campaigns/corpus-comparison.json).
All four were run twice — once at the intermediate identity (§4.1, retained as
[`campaigns-intermediate-identity/`](receipts/campaigns-intermediate-identity/))
and once at the final identity; both runs give the same body sha256.

### 3.6 Plan §7 hard architectural rows — grep-proven

[`plan7-greps.txt`](receipts/plan7-greps.txt), produced by resolving every
import specifier in every one of the 549 surviving `src/**/*.ts` files through
the tsconfig `paths` aliases:

| §7 row | Target | Measured |
| --- | --- | --- |
| legacy engine imports | 0 | **0** — no file under `src/` imports any of the 33 deleted owners |
| legacy fallbacks | 0 | **0** — `createCandidateClient`, `VibORM.create(config, …)`, `operationExecutor`, `cacheOperationExecutor`, `constructRoutedOperation` and `executeRoutedOperation` have no occurrence under `src/` |
| duplicated downstream public-verb algorithms | 0 | **0** — `READ_OPERATIONS`/`ROUTED_OPERATIONS`/`isReadOperation`/`isWriteOperation` have exactly one owner, the new `routed-operations.ts`; the candidate's own `raptor3/shared/schema.ts#isReadOperation` was deliberately NOT substituted because its set omits `findUniqueOrThrow`/`findFirstOrThrow` |

The 18 surviving `write-engine/` files are reached **only** by `pattern/` and
by **five** retained non-engine owners (`JunctionStatements.ts`,
`batch-error-attribution.ts`, `unique-conflict-target.ts`,
`operations/mutation-projection-fold.ts`, `types.ts`) — never by the candidate.
(Round 2 correction, review finding 7: the sentence said "three" and listed
five; five is correct.)
`src/query-engine/raptor3/**` has exactly **two** edges into the SHIPPED
ENGINE's owners, and neither is a compiler, lowerer, executor, query builder or
result engine: `shared/schema.ts → write-engine/parse-boundary.ts` (the typed
parse boundary, retained by name in the cutover's own analysis) and
`route/client-route.ts → result/cache-value-codecs.ts` (an existing scalar
codec). **Round 2 correction (review finding 7):** the sentence above said
"two edges outside itself", which is wrong and is not what the receipt says.
`raptor3/**` has **68** edges outside `raptor3/`, **6** of them into
`src/query-engine/` outside `raptor3/`: the two above, `types.ts` (from
`commands/index.ts`, `route/client-route.ts` and `shared/operation-context.ts`)
and `shared/operation-context.ts → bind-budget.ts`.
[`plan7-greps.txt`](receipts/plan7-greps.txt) states the true claim
("raptor3 → shipped-engine import edges: 2"); only the prose over-claimed. `client.ts:489` builds `createCandidateRoute(...)` unconditionally;
there is no routeless path left.

### 3.7 Formatting

`npx biome check` on the ten harness files this unit edited reports **175**
diagnostics; the same ten files at `HEAD` report **178**. The set of
diagnostic classes is identical (unsorted manifest import lists,
`noMisplacedAssertion` on pre-existing helpers, `useTopLevelRegex`), so this
unit added none. The three that disappeared were introduced by the edits and
then fixed by hand — a single-element `include` array in `vitest.workspace.ts`,
a now-unused `biome-ignore` in `packaged-array.test.ts` (replaced by a typed
cast), and an `assert.equal` that fits on one line in `key-arithmetic.test.ts`.
**Biome `--write` was never run on a whole file.**
[`biome-check.txt`](receipts/biome-check.txt).

---

## 4. Identity and the whole-cost result

### 4.1 `captureRaptor3Identity`, before and after the last edit

| | production | harness |
| --- | --- | --- |
| before (frozen identity 4, byte-equal to `g4/freeze/identity.json`) | `312cde34932cdb4d70ccad60bb002d0c0a438865bd18e165c38b4a572ebff640` | `1d4d913c4f686d7aa0871dde7f8af2c6049a674db2595c54a52b7f66491f2f9e` |
| intermediate (all source and harness work done, before the three formatting fixes of §3.7) | `02acf87987e1394a335fb633f65b5c54bb2b372abfe61d8e97c52da2f8c1331e` | `c4eca7bbf91bf266cf0d2332d71c1ce270279d78de228b45c2d335a151fc900f` |
| **after the last edit** | **`f42d6facdc5b36b420ca47b929acb629383dc47d3aa55be9c0d68fe2ae3c19d3`** | **`5ba4982a6e49ed988d30a9422e72d873821cc7f3df37e23cfb0d556f3e7550ca`** |

`runtime` is unchanged (`v24.21.0`, darwin/arm64, better-sqlite3 12.6.0, Vitest
3.1.4). Both fingerprints necessarily move: the cutover is a production change
and a harness change. Receipts: [`identity-before.json`](receipts/identity-before.json),
[`identity-after.json`](receipts/identity-after.json).

**The intermediate identity is recorded rather than hidden.** `vitest.workspace.ts`
is in `captureRaptor3Identity`'s `configuration` list, so it belongs to BOTH
fingerprints; collapsing one single-element `include` array onto one line to
satisfy Biome (§3.7) moved them after most modes had already run. The delta
between the two identities is exactly three formatting-only edits —
`vitest.workspace.ts` (one array on one line), `packaged-array.test.ts` (an
unused `biome-ignore` replaced by a typed cast) and `key-arithmetic.test.ts`
(one `assert.equal` on one line). No selection, project, cell or assertion
changed. `g4-unit02-author` and all four campaign children were re-run at the
final identity and are green; the mode receipts of §3.4 carry the intermediate
pair, which is listed as an unverified claim in §7.

### 4.2 The cost census — the whole-cost result plan §7 asks for

`node scripts/measure-raptor3-baseline.mjs` (charged production owners, the
frozen `source-cost.json` file lists) and `node scripts/query-engine-structure.mjs`
(the structure census), before and after, in the main tree:

| Charged production | files | bytes | physical LOC | token LOC |
| --- | ---: | ---: | ---: | ---: |
| frozen baseline (`raptor3-evidence/baseline.json`) | 161 | 2,292,906 | 64,980 | 49,887 |
| before the cutover (= attempt 6's `source-cost.json`) | 171 | 2,518,074 | 71,146 | 53,890 |
| **after the cutover** | **139** | **1,420,269** | **42,269** | **31,622** |
| delta, before → after | −32 | −1,097,805 | −28,877 | −22,268 |

| §7 size target | Target | Measured | Verdict |
| --- | ---: | ---: | --- |
| complete charged production **token**-LOC | ≤ 0.60 × baseline | **0.6339** (31,622 / 49,887) | **missed by 3.4 points** — a target, not a hard requirement: "a miss requires review, not abandonment" |
| complete charged production **physical** LOC | ≤ 0.70 × baseline | **0.6505** (42,269 / 64,980) | **met** |
| charged production bytes (reported, untargeted) | — | **0.6194** | — |
| comparable `engine` bundle gzip | ≤ 0.75 | **0.2377** | met (but see §3.3) |
| every public PostgreSQL client bundle gzip | ≤ 1.00 | **0.6997 / 0.6999** | met |

By classification after the cutover: `charged-engine` 23,313 token-LOC,
`charged-g3-prep-shared` 4,476, `charged-integration` 3,759,
`charged-adapter-integration` 74.

Structure census, `src/query-engine`:

| | files | lines | token lines | functions | branch nodes | runtime import cycles |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| before | 181 | 86,929 | 68,716 | 3,862 | 8,995 | 2 components / 14 files |
| after | **149** | **58,050** | **46,453** | **2,810** | **6,846** | 2 / 14 (unchanged) |
| `write-engine/` before | 43 | 34,084 | 25,911 | 1,318 | 2,651 | 0 |
| `write-engine/` after | **18** | **7,961** | **5,903** | **390** | **771** | 0 |

Receipts: [`source-cost-before.json`](receipts/source-cost-before.json),
[`source-cost-after.json`](receipts/source-cost-after.json),
[`census-before.txt`](receipts/census-before.txt),
[`census-after.txt`](receipts/census-after.txt).

The 7,961 lines still under `write-engine/` and the rest of the gap to the 0.60
token target are `pattern/`'s 25 retained owners (§5): retiring the experiment
is what closes it, and that is not a cutover question.

### 4.3 The four §7 decision-elimination questions, against this diff

1. **Necessary decision or representation repair?** Neither: this unit adds no
   rule. It removes one — "which engine owns this operation" — and the 33 owners
   that existed only to answer it one way. The single thing it *adds*,
   `routed-operations.ts`, is a verbatim move of four definitions out of a file
   being deleted, so that the read/write classification the interception and
   cache seams consume keeps exactly one authority.
2. **Exact deletion and replacement obligation.** Removed: `PendingOperation`'s
   legacy arms (`#resolveOperation`, `#statementOperation`, `#resolveSinglePlan`,
   `#singlePlan`, `#operationInstance`, `#operationResolved`,
   `#operationExecutor`, `#executor()`), `QueryEngine.operationExecutor` /
   `cacheOperationExecutor`, `VibORM.create`'s non-public `route` parameter,
   `createCandidateClient`, and 33 production owners. Consumers: every client
   lineage, `bind()`, the cache and extension seams, 197 test files.
   Replacing invariant: **every client lineage installs the route in `VibORM`'s
   constructor and `bind()` forwards it**, so there is exactly one operation
   owner and no routeless path. Falsifier: §3.6's import resolution over all 549
   surviving source files — a legacy import or a second owner of the
   read/write classification would appear there; and `client.ts:489`, where a
   conditional would have to reappear for a second engine to exist.
   No equivalent mechanism moved elsewhere: the candidate gained nothing, and
   its bundle output is byte-identical to the pre-cutover measurement (§3.3).
3. **One rule across uses?** The same single owner is exercised through the
   public client (`createClient`), through `$transaction([...])` (the array
   owner), through the cache rail (`cache({ autoInvalidate: true })`), through
   the extension interception seam, and through three providers —
   better-sqlite3, native PostgreSQL and native MySQL — by the 70 green modes
   and the four campaign families of §3.4–§3.5.
4. **What actually grew?** Nothing. Incremental core: **+48** physical lines
   (`routed-operations.ts`) and **+58 / −257** across the eight modified files.
   Complete charged production: **−22,268 token-LOC**, **−28,877 physical LOC**,
   **−1,097,805 bytes**, **−32 charged files** (§4.2). Tests and evidence are
   counted separately: **−197 test files / −86,498 lines** deleted by the patch,
   **−3** reviewer probes (−1,571 lines) and **−6 registered cells** by this
   unit's re-expressions of five `unit02` files (**+191 / −461** lines). This is
   the whole-cost result, and it is a deletion.

---

## 5. Follow-ups

1. **The G0/G1/G2 differential lanes and the G4-01 SQL parity probes need a
   one-sided replacement** (§2). Twelve modes and two support checks assert
   against a control that no longer exists. Deciding what replaces them — the
   generation campaigns are the honest candidates, since they assert against
   fixtures and oracles — is a harness decision for Arnaud, not a repair.
2. **`QueryEngine.build` no longer answers anything.** `PendingOperation.buildStatement()`
   returns `undefined` unconditionally (divergence D-4'), so the public
   `QueryEngine.build(model, operation, args)` raises "does not compile to one
   SQL statement" for every operation. No client surface reaches it, but it is
   an exported method of an exported class that is now always a refusal; either
   the candidate's prepared read should publish its `Sql`, or `build` should be
   removed. It is what breaks `g4-unit01-author` / `g4-unit01-review`.
3. **Two-sided cells that now compare two SEAMS of one engine.** Where the
   cutover did not break the typecheck, cells that build a "shipped" arm through
   `createClient` and compare it to `createCommandEngine(...)` now compare the
   client route seam with the direct command-engine seam. They are not
   tautologies — the two seams can still diverge — but their names claimed a
   comparison with an engine that no longer exists. **Round 2 renamed all 31 of
   them (review finding 4); the cell-level list, and the three groups
   deliberately NOT renamed, are in R2.3**, which replaces the `"shipped"`
   literal count this follow-up used to carry. What remains is the local
   identifiers and some assertion messages, which still spell "shipped"; they
   belong to the same decision as follow-up 1.
4. **`--subject=shipped` on the campaign families.** `g4-seeds`,
   `g4-seed-batch`, `g4-transport-seeds` and `g4-transport-seed-batch` still
   accept `--subject=shipped`; after C-01 that subject runs the candidate. The
   option should be retired with the differential lanes.
5. **The optional `route` type.** `QueryEngine`'s constructor parameter stays
   `route?: ClientOperationRoute` with one localised
   `engine.route as ClientOperationRoute` in `PendingOperation` and a comment
   naming the invariant. Making it genuinely required is mechanical and costs
   the update of the ~194 test call sites that pass two arguments (proposal
   §4.3). Not a fallback — the escape hatch is the type.
6. **`pattern/` retirement.** The experiment keeps 25 production owners alive,
   including 18 `write-engine/` files (7,961 lines) and the
   `PreparedBatchGuard.failure → OperationFragment → record-series → OperationExecutor`
   type chain, and it owns the only two permitted typecheck diagnostics.
   Retiring it on its own merits deletes those owners and closes most of the
   remaining gap to the §7 0.60 token-LOC target (§4.2).
7. **`relation-series-2`.** Unchanged by this unit and unchanged by the cutover:
   the benchmark's generated id is a call counter, so the D-8
   one-evaluation-per-admitted-input contract lands on the persisted primary
   keys. After the cutover there is no second engine for the cross-engine
   comparator to run, so the cell's gate ceases to exist as such; making the
   workload's ids engine-neutral is a `benchmarks/**` follow-up. The
   proposal's integrator addendum also asks for the engine-only bundle fixture
   to be re-pointed in the same change, since it now holds no `raptor3` module.
8. **`coverage-errors` lost `tests/unit/validation/boundaries.core.test.ts`**
   (deleted by the patch: it imported `@query-engine/validator`). The project
   still has its `tests/contracts/public-client/errors/**` glob, but whatever
   source that file uniquely covered is now uncovered by that gate.
9. **`cs02-structure-measure` was not run.** It requires
   `VIBORM_RAPTOR3_MEASUREMENT_BASE_IDENTITY`, an instrumentation patch and a
   named alternative, which the qualification driver applies to `src/` and then
   reverses — an apparatus outside this unit's file set and incompatible with an
   uncommitted cutover tree. The brief's support group asks for the structure
   *census*, which ran (§4.2). Receipt of the refused invocation:
   [`support/cs02-structure-measure.log`](receipts/support/cs02-structure-measure.log).

---

## 6. Commit-message draft for the integrator

> **Superseded by R2.8**, which carries two variants (with and without a
> `buildStatement` change) and the corrected KNOWN RED population. The draft
> below is round 1's and its "Nothing a user can write changes meaning" sentence
> is false (review finding 2); it is kept for the record, not for use.

```
feat(raptor3): cut over to the Raptor 3 engine (C-01)

The candidate becomes the only operation owner behind an unchanged public API.
VibORM's constructor builds createCandidateRoute(...) for every client,
VibORM.create loses its non-public `route` parameter (G4-03; absent from
createClient, from the package entry and from the docs), PendingOperation keeps
only the route arm, QueryEngine loses operationExecutor/cacheOperationExecutor,
and client-route.ts loses createCandidateClient. Nothing a user can write
changes meaning.

Deleted, 33 production owners / 28,740 lines: src/query-engine/write-engine/
(25 files, incl. RecordUpdateCompiler, CreateOperation, UpdateOperation,
UpsertOperation, DeleteOperation, the Relation*Part family and routing.ts),
the seven query-engine root owners (OwnWriteSteps, OwnWriteAnalyzer,
OwnWriteRelation, OwnWriteLedger, RelationMembership, relation-key-legality,
validator) and builders/to-one-composition.ts. Added: routed-operations.ts,
48 lines, holding READ_OPERATIONS / ROUTED_OPERATIONS / isReadOperation /
isWriteOperation verbatim so the interception and cache seams keep one
authority; four imports re-pointed at it.

Deleted with them, 197 test files / 86,498 lines: the shipped engine's own
contract suites. No test body was edited — a parity test that builds a shipped
client and a candidate client cannot be repaired once the shipped side is gone
without becoming a candidate-versus-candidate tautology.

Retired, not re-pointed: the six two-sided harness modes g4-route-lifecycle,
g4-route-admission, g4-route-cache, g4-route-transactions, g4-lifecycle-events
and g4-lifecycle-admission, plus 21 reviewer probes under
tests/raptor3/g4/review/**. Five g4-unit02-author files were re-expressed
one-sided (136 -> 130 cells).

Public contract change: DatabaseAdapter.expressions.integerDivide is now the
only path. It already shipped in the candidate; a third-party DatabaseAdapter
implementation will not typecheck until it supplies the member.

Whole-cost: charged production 53,890 -> 31,622 token-LOC (0.634 of the frozen
baseline, target 0.60), 71,146 -> 42,269 physical LOC (0.651, target 0.70);
src/**/*.ts 581 -> 549 files. Bundles byte-identical to the stage-2d
measurement: engine gzip 0.2377, both public PostgreSQL fixtures 0.700.

Decisions: D-8 (one evaluation per admitted input; the benchmark pins one
ledger per engine), D-9 (the remaining preparation cost is accepted; no further
performance pass), D-10 (the cutover is performed locally, nothing pushed,
no database changed).

KNOWN RED, and a blocker for whoever takes the next step: the G0/G1/G2
differential lanes and the G4-01 SQL parity probes reach the shipped engine
through createClient(...) or QueryEngine.build(...), not through the private
route selector, so the cutover leaves 12 registered modes and 2 support checks
without a control arm. See docs/architecture/raptor3-evidence/g4/cutover-execution/note.md §2.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

---

## 7. Unverified claims (round 1; round 2's are in R2.9)

- **The mode receipts of §3.4 were taken at the intermediate identity**
  `02acf879… / c4eca7bb…`, not at the final `f42d6fac… / 5ba4982a…`. The delta
  is the three formatting-only edits listed in §4.1. Only `g4-unit02-author`
  and the four campaign children were re-run at the final identity; the other
  69 modes were not.
- The "51 green / 8 red" fixed tally and the native tallies are single runs on a
  machine that was not otherwise quiet. Every green mode verified its exact
  registered cell count, so a flake would have to reproduce a count, but none of
  the greens was run twice.
- The claim that **no red is a candidate defect** is grounded in reading each
  failing assertion and its harness (§2.1) — the legacy `k + 2nk` default
  ledger, the two-attempt unique-race retry, the `QueryEngine.build` oracle. It
  is not proved by an independent bisect.
- The tautology inventory in follow-up 3 is a `"shipped"`-literal count over
  registered files, not a cell-by-cell audit. The cells were not read
  individually; some of those occurrences may be prose.
- The Biome comparison (175 now against 178 at `HEAD`) was taken by copying the
  ten files at `HEAD` into a scratch directory and running the same config
  there. The roots differ, so the counts are comparable but not identical
  measurements.
- `pnpm package:build` was run once, and `dist/` was rebuilt before the bundle
  measurement; the bundle figures assume the rebuild is what the fixtures read,
  which is what §3.3's byte-identical result implies but does not independently
  prove.
- No performance cell was re-measured. Stage 2d's series stands as the record of
  what D-9 accepted; this unit changed no production file beyond the patch.
- The MySQL container was at 228 MiB of its 512 MiB tmpfs before the native
  group and no E-1 drop was performed. A later native run may need one.

---

# Round 2 — the review's mechanical resolutions, the core lane, the red classification and the two measured resolutions

Round 2 answers the independent review
([`cutover-execution-review.md`](../cutover-execution-review.md), outcome
REVISE) for everything that needs no decision from Arnaud, and prepares the
decisions it raises with numbers. Base is unchanged (`5a37bcd7`); nothing was
committed, staged, reset or stashed; the two preserved pattern preimages were
not touched. New receipts are under
[`receipts/round2/`](receipts/round2/).

## R2.0 What round 2 changed, file by file

| File | Change | Why |
| --- | --- | --- |
| `scripts/query-engine-test-manifest.mjs` | −51 dead entries (10 `QUERY_ENGINE_CORE_TESTS`, 41 `WRITE_ENGINE_CORE_TESTS`); `WRITE_ENGINE_COVERAGE_TEST_GROUPS` collapsed from 7+1 slices to 2+1 | review finding 3 |
| `scripts/driver-test-manifest.mjs` | −1 dead entry (`consumable-result-rows.provider.test.ts`) | review finding 3 |
| `scripts/coverage-policy.test.mjs` | −2 dead entries the gate itself hardcodes | **addition to finding 3**, see R2.1 |
| `src/query-engine/AGENTS.md` | factual banner; `write-engine/routing.ts` terminology paragraph; 12 ownership rows naming deleted files removed; 4 surviving rows corrected | review finding 6 |
| `src/query-engine/README.md` | factual banner; ownership diagram and table; the two `CreateOperation`/`RecordUpdateCompiler` paragraphs; the polymorphic-collection-write row; the "Single-statement inspection" section | review finding 6 |
| `src/query-engine/raptor3/shared/operation-context.ts` | one comment corrected (`@extensions/query` no longer imports `write-engine/routing`) | review finding 6 |
| 13 `tests/raptor3/g4/unit02/*.test.ts` | 31 cell titles renamed | review finding 4, list in R2.3 |
| `note.md` §3.4, §3.6 | two prose inaccuracies, the failed first attempt | review findings 7, 8 |

`WRITE_ENGINE_CORE_TESTS` is 56 → 15 entries, so the literal slice list that
partitions it into coverage workers produced five EMPTY groups, which
`coverage-policy.test.mjs:469` rejects (`group.length > 0 && <= 8`). The slices
are now `slice(0, 8)` / `slice(8)` / the extended group — 8 / 7 / 1, the same
partition rule at the new size.

## R2.1 Finding 3 — the manifests, and two entries the review did not see

The 52 entries the review named were deleted verbatim. The gate did **not** go
11/11 on that alone: `scripts/coverage-policy.test.mjs` hardcodes two of the
same deleted paths in its own expectation lists —
`tests/contracts/drivers/consumable-result-rows.provider.test.ts` (`:301`, the
`providerContracts` mirror of the driver manifest) and
`tests/contracts/drivers/consumable-result-rows-pglite.provider.test.ts`
(`:394`, `pgliteCoverageExclusions`) — and `readFileSync`s both. Each is the
same mechanical class as the 52 (a path the cutover deleted), so both were
removed; that is the only departure from the review's wording, and it is
recorded here rather than left as a silent extra edit.

| Gate | Before round 2 | After |
| --- | --- | --- |
| `pnpm test:coverage:policy` (`coverage-policy.test.mjs`) | 9 / 11 | **11 / 11**, exit 0 for all three of its commands ([receipt](receipts/round2/coverage-policy-after.log)) |
| `tests/contracts/architecture/core-taxonomy-census.core.test.ts` | 1 of 4 red (51 dead include entries) | **4 / 4 green** ([receipt](receipts/round2/core-taxonomy-census-after.log)) |

Both are now part of this unit's verification list (note §3).

## R2.2 The core lane — run, recorded, and restated

`node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project='layer-*'`
(the `pnpm test:core` selection; the review's ceilings — 1,536 MiB sampled
process-group RSS, 768 MiB heap, the runner's defaults), main tree, after the
finding-3 fix:

| Tree | Failed files | Failed tests | Total |
| --- | ---: | ---: | --- |
| base `5a37bcd7` (review's receipt) | 5 | 42 | 532 files / 11,292 tests |
| cutover, review's run | 35 | 534 | 467 / 9,420 |
| **cutover, round 2** | **34** | **533** | **467 / 9,420** |

38.77 s wall, 1,340.1 MiB peak sampled process-group RSS. Re-run on the FINAL
round-2 tree (after the guide, comment and rename edits): the same
**34 / 533 of 467 / 9,420** and the same failing-file set, 43.64 s, 1,310.0 MiB
([`test-core-cutover-round2-final.log`](receipts/round2/test-core-cutover-round2-final.log)).
Receipt: [`test-core-cutover-round2.log`](receipts/round2/test-core-cutover-round2.log),
failing set [`test-core-cutover-round2-failing-files.txt`](receipts/round2/test-core-cutover-round2-failing-files.txt),
per-file cause census [`failure-causes-by-file.txt`](receipts/round2/failure-causes-by-file.txt).
The one file the review counted that round 2 does not is
`core-taxonomy-census.core.test.ts`, which finding 3 fixed. Four of the base's
five red files are deleted by the cutover; `contract-matrix.core.test.ts` is red
on both trees, so **33 files are newly red** and one carries one new failure of
three.

**Causes, counted in the round-2 log** (533 failing cells):

| Cause | Cells | What raises it |
| --- | ---: | --- |
| `buildStatement()` refusal | **371** | `QueryEngineError: Operation 'X' does not compile to one SQL statement` — `PendingOperation.buildStatement()` returns `undefined`, `QueryEngine.build` reports the absence |
| an assertion about the shipped engine's own SQL text or behaviour | **144** | the cell reached its answer, and the answer differs from the deleted engine's pinned text/identity |
| `new QueryEngine(driver, registry)` outside a client lineage | **6** direct (+ 16 as a nested cause) | `TypeError: Cannot read properties of undefined (reading 'operation')` at `pending-operation.ts:460` — `engine.route` is `undefined` and the §4.3 localised assertion does not hold |
| `parseResult` refusal | **3** | `Operation 'X' on model 'Y' publishes no single driver result to parse` |
| reads a deleted owner from disk | **3** | `ENOENT … src/query-engine/write-engine/CreateOperation.ts` (source-text architecture gates) |
| other (collection abort, ratchet count) | 6 | e.g. `namespace-qualification` aborts at collection on the first refusal |

**Note §2 is restated by this section.** Its "twelve registered modes and two
support checks are RED" was true and complete for the registered raptor3 estate;
it was not the estate. The population is **12 registered modes + 2 support
checks + 34 core-lane files (533 cells)**, and the sentence "**No red is a
candidate defect**" is NOT established for all of it: six of the 34 files carry
10 failing cells this unit cannot classify with certainty (R2.4 class D).

## R2.3 Finding 4 — the 31 renamed cells

Every registered cell whose title claimed a comparison with the shipped engine
**and** whose construction is two-armed (one arm `createClient(...)` or a public
model method, the other `createCommandEngine(...)`) was renamed to what it now
compares: the **client route seam** against the **command engine**. No cell was
deleted, no assertion changed, and `g4-unit02-author` still reports exactly
**21 files / 130 tests**
([receipt](receipts/round2/g4-unit02-author-after-rename.log)).

| File | Cells renamed | Old title → new title (pattern) |
| --- | ---: | --- |
| `unit02/key-arithmetic.test.ts` | 6 + 1 `describe` | "…the way the shipped engine does" → "…identically on the client route seam and the command engine"; "the candidate answers what the shipped engine answers" → "the command engine answers what the client route seam answers" |
| `unit02/upsert-key-portability.test.ts` | 7 + 1 `describe` | "…as the shipped engine does" / "as shipped does" → "…identically on both seams"; "the THIRD shipped owner" → "the THIRD owner the deleted engine had" |
| `unit02/lone-statement-transport.test.ts` | 2 | "answers the shipped failure exactly" → "answers the same failure on both seams"; "still agrees with the shipped engine" → "the two seams still agree" |
| `unit02/unique-discriminator.test.ts` | 2 | "exactly as the shipped engine does" → "identically on the client route seam and the command engine"; "exactly the call sites the shipped engine compiles with `buildWhereUnique`" → "on both seams, at exactly the call sites the deleted engine compiled with `buildWhereUnique`" |
| `unit02/nested-key-refusal.test.ts` | 2 | "inside the shipped predicate's SHAPE and POSITIONS" → "on both seams, inside the deleted engine's predicate SHAPE and POSITIONS"; "answers the shipped sentence…" → "answers one sentence on both seams…" |
| `unit02/root-member-cut-trace.test.ts` | 2 | "both branches equal shipped" / "the row set is the shipped one" → "…agree(s) across the two seams" |
| `unit02/physical-envelope.test.ts` | 2 | "same row as shipped" / "as shipped" → "…on both seams" |
| `unit02/malformed-result-cuts.test.ts` | 1 | "answers exactly what the shipped engine answers" → "answers exactly the same on the client route seam and the command engine" |
| `unit02/root-delete.test.ts` | 1 | "keeps the shipped not-found identity" → "keeps one not-found identity across the two seams" |
| `unit02/borrowed-envelope.test.ts` | 1 | "poisons the caller's transaction, as shipped" → "…on both seams" |
| `unit02/vector-capability.test.ts` | 1 | "refuses the write with the shipped identity" → "refuses the write with one identity on both seams" |
| `unit02/native-date-codec.test.ts` | 1 | "identically on the shipped and candidate engines" → "identically on the client route seam and the command engine" |
| `unit02/native-key-arithmetic.test.ts` | 1 | "exactly as the shipped engine does" → "identically on the client route seam and the command engine" |

**Not renamed, and why.** Three groups keep their titles:

1. **One-sided pins whose title names where the pinned literal came from** —
   `packaged-array.test.ts:135` ("the packaged plan is the shipped batch shape")
   and `phase2-envelope-and-arithmetic.test.ts:293` ("carries the shipped meta
   for a missing root delete"). Both build only `createCommandEngine`; their
   titles describe the ORIGIN of a literal, not a live comparison. Renaming them
   would erase the provenance the pin exists for.
2. **The `g4-unit01` cells whose oracle is `QueryEngine.build`** —
   `unit01/repair2.test.ts:49`, `unit01/repairs.test.ts:124`,
   `unit01/repair3.test.ts:88` and `:131`. They are RED today (R2.4), and what
   they will compare depends on Arnaud's decision: under option (c) they go
   green as `QueryEngine.build` against a pinned SQL text. Renaming a red cell
   before the decision would name something that does not run.
3. **The reviewer's own probes under `tests/raptor3/g4/review/**`** — not
   registered, and another stream's files.

**Residual, recorded rather than fixed:** inside the 13 renamed files the local
identifiers (`const shipped = …`, `engine: "shipped" | "candidate"`) and some
assertion MESSAGES still spell "shipped". They are not cell names and not
assertions; renaming them touches ~120 lines of live code paths for no
observable gain before the harness decision of follow-up 1. Follow-up 3's
literal count is replaced by the cell-level table above.

Biome: per file, diagnostics before the rename = diagnostics after (27 = 27
across the 13 files, measured by reverting the renames on a scratch copy and
running the same `npx biome check` on disk). No `--write` was run.

## R2.4 CLASSIFICATION — every red, with its cause, class and disposition

Four classes, as the brief for this round defines them:

- **A — deleted-engine contract suite.** The cell asserts the SQL text, message
  text, source text or physical plan of the SHIPPED engine only. It has no
  subject after C-01.
- **B — public-client cell whose assertion is about the changed seam.** The cell
  reaches the engine only through a public surface (`createClient`,
  `$transaction([...])`, the exported `PendingOperation`) and asserts a fact the
  cutover moved.
- **C — differential instrument whose control arm was the shipped engine.**
- **D — possible candidate defect.** Everything this unit cannot classify with
  certainty; the exact failing assertion is quoted.

### R2.4.1 The 34 core-lane files

`fail/total` is cells. "(a)/(b)/(c)" are the measured dispositions of R2.5 —
green, a residual count, or unchanged.

| # | File | fail/total | Red cause (failing assertion) | Class | (a) | (b) | (c) |
| ---: | --- | ---: | --- | :-: | :-: | :-: | :-: |
| 1 | `engine/query/sql-generation.core.test.ts` | 108/147 | buildStatement refusal ×90; the rest pin the shipped SQL text | **A** | 114 | 108 | **56** |
| 2 | `engine/query/field-reference-sql.core.test.ts` | 83/89 | buildStatement refusal ×46, then shipped SQL text | **A** | 83 | 83 | **40** |
| 3 | `engine/query/operand-callback-sql.core.test.ts` | 67/74 | buildStatement refusal ×40, then shipped SQL text | **A** | 67 | 67 | **12** |
| 4 | `engine/query/decimal-having-operand-sql.core.test.ts` | 48/48 | buildStatement refusal ×41 (`groupBy`) | **A** | 48 | 48 | **6** |
| 5 | `engine/query/cursor-pagination-sql.core.test.ts` | 42/44 | buildStatement refusal ×36 | **A** | 42 | 42 | **30** |
| 6 | `engine/query/read-traversal-byte-pins.core.test.ts` | 32/32 | buildStatement refusal ×32 (byte snapshots of the shipped SQL) | **A** | 32 | 32 | **32** (all snapshot mismatches) |
| 7 | `engine/query/starts-with-prefix-sql.core.test.ts` | 27/31 | buildStatement refusal ×21 | **A** | 27 | 27 | **green** |
| 8 | `engine/query/json-null-sentinel-sql.core.test.ts` | 24/30 | buildStatement refusal ×21 | **A** | 24 | 24 | **9** |
| 9 | `engine/query/request-result-shape-contracts.core.test.ts` | 16/29 | mixed: refusal ×5, `parseResult` refusal ×2, route-undefined, `transactionOperation(...).prepare()` → `undefined` | **A**+**B** | 16 | 16 | **15** |
| 10 | `engine/query/batch-attribution-hazard-signature.core.test.ts` | 12/17 | buildStatement refusal ×12 (write verbs) | **A** | 12 | 12 | **12** |
| 11 | `engine/query/geopoint-sql.core.test.ts` | 10/20 | buildStatement refusal ×9; 1 masked (`expected error to be instance of FeatureNotSupportedError`, received the refusal) | **A** | 10 | 10 | **6** |
| 12 | `engine/query/lateral-joins.core.test.ts` | 9/18 | buildStatement refusal ×9 | **A** | 9 | 9 | **7** |
| 13 | `engine/query/operation-equivalence-oracles.core.test.ts` | 3/3 | buildStatement refusal ×3 (frozen SQL+params oracles) | **A** | 3 | 3 | **3** |
| 14 | `engine/query/namespace-qualification.core.test.ts` | suite/122 | the suite ABORTS at collection on the first refusal, so 122 cells never ran | **A** | abort | abort | **2/122** |
| 15 | `drivers/namespace-execution-target.core.test.ts` | 5/5 | buildStatement refusal ×5 (`.build()` oracle in the drivers layer) | **A** | 5 | 5 | **5** |
| 16 | `drivers/provider-result-contracts.core.test.ts` | 1/115 | buildStatement refusal ×1 (PlanetScale GeoPoint SQL) | **A** | 1 | 1 | **1** (SQL text) |
| 17 | `engine/query/pending-operation-contracts.core.test.ts` | 11/27 | route-undefined ×4, `prepare()` → `undefined`, `parseResult` refusal, deferred-validation cell | **B** (the exported class's own contract) | 11 | **4** | **4** |
| 18 | `engine/query/bulk-create-plan.core.test.ts` | 1/12 | route-undefined: `new QueryEngine(driver, registry)` then `prepareBatch` | **A** | 1 | 1 | 1 (SQL text) |
| 19 | `engine/query/operation-program-read-contracts.core.test.ts` | 2/2 | route-undefined on `engine.prepare(...)` | **A** | 2 | **1** | **1** |
| 20 | `engine/query/query-operation-coverage-boundaries.core.test.ts` | 1/25 | route-undefined at `startInterception` | **A** | 1 | **green** | **green** |
| 21 | `engine/query/orderby-relation-depth.core.test.ts` | 3/4 | route-undefined masks the expected `/Unknown key: parent/` and `/cannot order through a to-many relation/` refusals | **A** | 3 | **green** | **green** |
| 22 | `engine/write/architecture-gates.core.test.ts` | 1/6 | `ENOENT … write-engine/CreateOperation.ts` — a source-text gate over two deleted owners | **A** | 1 | 1 | 1 |
| 23 | `engine/write/parse-boundary-gate.core.test.ts` | 3/6 | `ENOENT` ×2 (`CreateOperation.ts`, `routing.ts`) + the ratchet self-check (`expected 2 to be 6`) | **A** | 3 | 3 | 3 |
| 24 | `architecture/contract-matrix.core.test.ts` | 3/5 | 2 pre-existing at base; **1 new**: `libsql:drivers.batch-primary-key-dataflow` — the libsql file that registered it (`libsql-write-engine-*.test.ts`) is deleted by the patch | **A** (harness debris) | 3 | 3 | 3 |
| — | `architecture/core-taxonomy-census.core.test.ts` | 1/4 | 51 dead `vitest.workspace.ts` include entries | **A** | **RESOLVED in round 2 (finding 3)** | | |
| 25 | `public-client/request-transforms.core.test.ts` | 6/43 | `transactionOperation(op).prepare()` answers `undefined`, so the validation the cell expects never runs: `expected function to throw an error, but it didn't` ×2, `expected undefined to be defined`, `expected Set{} to deeply equal Set{'findMany', …(9)}` | **B** | 6 | 6 | 6 |
| 26 | `public-client/one-resolution-identity.core.test.ts` | 1/3 | `buildStatement()?.toStatement("$n")` → `undefined`; `expect(sql).toContain("secret")` | **B** | **green** | 1 | **green** |
| 27 | `unit/cache/operand-callback-keys.core.test.ts` | 1/7 | same; `expected '' to contain '"likes"'` (the review's finding-2 probe) | **B** | **green** | 1 | **green** |
| 28 | `drivers/sqlite-integer-safety.core.test.ts` | 1/5 | `capability.prepare(driver)` → `undefined`; `Error: Expected one prepared statement` | **B** | 1 | 1 | 1 |
| 29 | `engine/query/select-mode-capability-matrix.core.test.ts` | 3/3 | 2 are message text (`Driver 'x'` vs `Driver "x"`: the refusal now comes from `drivers/driver-transaction-base.ts:790`, not the deleted `write-engine/shared.ts:732`) — class A. **1 is not**: `operation 'upsert' fails before dispatch` — `expected QueryError: Query execution failed {…} to be an instance of TransactionError` | **A**+**D** | 3 | 3 | 3 |
| 30 | `engine/query/bulk-insert-row-shapes.core.test.ts` | 1/2 | `client.$transaction([client.batchRow.createMany({ data: [] })])` — `promise resolved "[ { count: +0 } ]" instead of rejecting` (`"No data to insert"`). A refusal REMOVAL visible through the public client; not in the recorded divergence table (R-D1, R-D2, D-1…D-8) | **D** | 1 | 1 | 1 |
| 31 | `public-client/array-transaction-closure.core.test.ts` | 1/8 | `native array closures > keeps an already-applied observation settled when a later parse fails` — `promise resolved "[ [], [] ]" instead of rejecting` | **D** | 1 | 1 | 1 |
| 32 | `public-client/official-cache-swr.core.test.ts` | 1/7 | `contains provider, snapshot, set, and cleanup failures` — `expected +0 to be 1` (`hostileJsonReadsAtCoreBoundary`, `:550`) | **D** | 1 | 1 | 1 |
| 33 | `public-client/query-interceptors-array.core.test.ts` | 4/54 | `expected "spy" to be called once, but got 0 times` (`:1089`); `expected […(3)] to have a length of 5` (`:1242`); `expected [ 'provider' ] to deeply equal []` (`:2035`); `Error: Expected the array transaction to fail` (`:2249`) | **D** | 4 | 4 | 4 |
| 34 | `public-client/query-interceptors-integration.core.test.ts` | 2/48 | `reports commit ambiguity for a direct composed write transaction` — `expected [] to deeply equal [ 'may-have-committed' ]` (`:1383`); `reports committed certainty when direct transaction cleanup fails after commit` — `expected [] to deeply equal [ 'committed' ]` (`:1427`). BEGIN/COMMIT/ROLLBACK all reached the driver; the `onWriteOutcome` listener was never called | **D** | 2 | 2 | 2 |

**Counts**, over the 34 files and the 533 failing cells, arithmetic shown:

| Class | Files | Cells | Rows |
| --- | ---: | ---: | --- |
| **A** deleted-engine contract suite | **24** | **494** | 1–16 (431 + 40 = 471, `namespace-qualification` contributing its collection abort and 0 run cells), 18–24 (14), the refusal + `parseResult` half of row 9 (7), the two message-text cells of row 29 |
| **B** public-client cell about the changed seam | **6** | **29** | 17 (11), 25 (6), 26 (1), 27 (1), 28 (1), the `prepare()` half of row 9 (9) |
| **D** possible candidate defect | **6** | **10** | 29 (1 of 3), 30 (1), 31 (1), 32 (1), 33 (4), 34 (2) |
| | | **533** | |

Two files carry two classes (9 and 29), so the file column sums to 36 over 34
distinct files; the cell column partitions exactly.

### R2.4.2 The 12 red registered modes and the 2 red support checks

| Mode / check | Failing files, cells | Red cause | Class | (a) | (b) | (c) |
| --- | --- | --- | :-: | :-: | :-: | :-: |
| `g0` | `gate.test.ts` 1/9, `fixed.test.ts` 4/24 | `scenarios/contracts/instances.ts:155,180` runs the scenario with NO `candidateFactory` as the baseline (`createClient`) and asserts the legacy `k + 2nk` default evaluations. The baseline is now the candidate (`k + nk`), the D-8 difference | **C** | — | — | **5 failed, unchanged** (measured) |
| `g1-baseline` | `expanded/lifetime-legacy.test.ts` 2/16 | the file's whole subject is the legacy engine's lifetimes | **C** | — | — | — |
| `g1-contracts` | `expanded/lifetime-commands.test.ts` 2/16 | the commands file compares against the legacy arm it builds itself | **C** | — | — | — |
| `g1-compare` | `candidate.test.ts` 8/48, `candidate-ordering.test.ts` 4/4 | one oracle, two subjects; the control subject is gone | **C** | — | — | — |
| `g2-generated` | `g2-generated.test.ts` 36/46 | `generation/campaign.ts:102` "G2 seed 2100, sqlite-interactive, **baseline** failed": the admission ledger the baseline is asserted against is the legacy engine's | **C** | — | — | — |
| `g2-transport` | `g2-transport.test.ts` 16/16 | the same baseline arm on the scripted transports | **C** | — | — | — |
| `g2-pg-baseline`, `g2-mysql-baseline` | `transitions/unique-races-live-legacy.test.ts` 1/3 each | `unique-races-live.ts:132` `const expectedAttempts = candidateFactory ? 1 : 2` — the legacy arm is expected to retry twice | **C** | — | — | — |
| `g2-pg-contracts`, `g2-mysql-contracts` | `transitions/unique-races-live-commands.test.ts` 1/3 each | the commands test runs the baseline arm first, and it is the baseline arm's own assertion that fails | **C** | — | — | — |
| **`g4-unit01-author`** | `unit01/repair2.test.ts` 7/22 (mode total 7 failed / 83) | `shipped()` is `new QueryEngine(driver, registry).build(spot, "findMany", args)` — BOTH the bare-engine route and the `buildStatement` refusal | **A** | 7 failed | 7 failed | **GREEN 10 files / 83 tests** (measured) |
| **`g4-unit01-review`** | `unit01-followup2/distance-depth.test.ts` 12/13, `unit01-followup/distance-parity.test.ts` 7/9, `unit01-followup2/distance-pins.test.ts` 4/4 (mode total 23 failed / 200) | the same `QueryEngine.build` oracle | **A** | 23 failed | 23 failed | **2 failed / 200** (measured) — the residual is a real SQL-text divergence: the shipped engine named the distance column `AS "0viborm_distance"`, the candidate names it `AS "_distance"` |
| support: CLI self-test (`scripts/raptor3-cli.test.mjs`) | 0/10 | shells out to `run-raptor3 g0` and asserts exit 0; entirely downstream of `g0` | **C** | — | — | unchanged |
| support: credential-free `--only "Raptor 3 fixed"` | 18 of 758 cells in 4 of 65 files | `candidate.test.ts`, `candidate-ordering.test.ts`, `fixed.test.ts`, `expanded/lifetime-commands.test.ts` — the same four files as `g0`/`g1-compare`/`g1-contracts` | **C** | — | — | unchanged |

**Mode counts.** C = **10 modes + 2 support checks**; A = **2 modes**
(`g4-unit01-author`, `g4-unit01-review`), and the measurement proves the
classification: both are repaired by publishing the statement and provisioning
the route, which a differential lane would not be. Only `g0` was re-run under
(c) among the class-C modes (`5 failed`, unchanged); the other nine are
unaffected by both options by construction — they never call
`QueryEngine.build` and always build their arms through `createClient`.

### R2.4.3 The disposition each red would get under each option

| Class | Option 1 — publish the statement (a) | Option 2 — remove `buildStatement` from the exported class | Option 3 — keep the refusal and record it | With route provisioning (b) added |
| --- | --- | --- | --- | --- |
| **A** (24 files, 2 modes) | **worse on its own** — these suites build a bare `new QueryEngine(...)`, so the named refusal becomes a `TypeError` (R2.5). Only WITH (b) do the cells reach the SQL comparison, and then **228 of the 268 residual cells fail on the candidate's SQL text differing from the deleted engine's pin** — the suites still have to be deleted or re-pinned, one by one | the suites stop compiling against a method that no longer exists: delete with their engine | delete with their engine (the §1.4 rule, applied at scale) | (c): 2 modes repaired, 5 files green/near-green, the rest still need deletion or re-pinning |
| **B** (6 files) | 2 files go green (`one-resolution-identity`, `operand-callback-keys`); the other 4 need the SAME decision one seam further — the array owner's `prepare` / `parseResult` arms | the cells that call `buildStatement()` through a public surface must be deleted or rewritten: a public-contract change | a public behaviour change to record in the commit message, and 29 public-client cells to delete or re-pin | (c): same 2 green; `pending-operation-contracts` 11 → 4 |
| **C** (10 modes, 2 checks) | no effect | no effect | no effect | no effect — a differential lane has no control arm whatever `build` publishes |
| **D** (6 files, 10 cells) | no effect | no effect | no effect | no effect — each needs a reading of the candidate's behaviour, not a publication decision |

The one disposition that is NOT a decision: class D must be looked at before
commit 4 either way. It is 10 cells, all on the public client, and it is the
whole of the review's "the note's *No red is a candidate defect* is not
established for this population".

## R2.5 The two candidate resolutions, MEASURED in a scratch copy

Three scratch copies of the cutover tree (`rsync` of the working tree, `.git`,
`node_modules` and `docs/architecture` excluded; `node_modules` symlinked), none
inside the main tree, all deleted at the end. The main tree was not touched by
any of this. The diff of the largest variant is retained:
[`scratch-measurement/option-c.patch`](receipts/round2/scratch-measurement/option-c.patch)
(152 lines, 5 files).

**The scratch baseline reproduces the main tree exactly**: 34 failed files /
533 failed tests of 467 / 9,420
([`core-baseline.log`](receipts/round2/scratch-measurement/core-baseline.log)).

### (a) `buildStatement()` publishes the prepared read's `Sql`

Smallest honest implementation, 3 files / 24 lines:

- `raptor3/commands/index.ts` — `PreparedRead` gains `readonly statement: Sql`,
  `publishedFacts()` fills it from `value.query.sql` (the prepared `Read` has
  owned the statement all along; the facts simply did not publish it);
- `raptor3/route/client-route.ts` — `RoutedCandidateOperation.buildStatement()`
  returns `prepared.read?.statement`;
- `pending-operation.ts` — `buildStatement()` returns
  `this.#resolveRouted().buildStatement()`.

Every non-read verb keeps the refusal, and that is not a choice: **a folded
single-statement write is not reachable synchronously.** The package's only
write fold is `PreparedOperation.prepareBatch()`, which is `async` and publishes
`PreparedQuery[]` (`{ sql: string, params, context }` produced by
`driver._prepare`), not an `Sql`. `buildStatement(): Sql | undefined` is
synchronous and returns `Sql`, so publishing a write fold would require either
an async `build()` (a public signature change) or fabricating an `Sql` from a
driver-prepared string (not a publication). This is why 33 refusals remain under
(c).

| | files | cells |
| --- | ---: | ---: |
| baseline | 34 | 533 |
| **(a)** | **32** | **537** |

**(a) alone is a net regression.** Exactly 2 cells newly pass — the whole of
`one-resolution-identity.core.test.ts` and of
`unit/cache/operand-callback-keys.core.test.ts`, the review's own finding-2
probe, which go green — and **6 cells newly FAIL**, all in
`sql-generation.core.test.ts` ("… rejects the single-statement build API",
"a non-returning driver keeps the multi-step path"). The reason is exact:
`buildStatement()` now RESOLVES the routed operation, and in a suite that built
`new QueryEngine(driver, registry)` the route is `undefined`, so a named refusal
(`Operation 'upsert' does not compile to one SQL statement`) becomes an unnamed
`TypeError: Cannot read properties of undefined (reading 'operation')`. Across
the lane the cause census moves from 371 refusals / 6 TypeErrors to
**12 refusals / 366 TypeErrors**. Publishing the statement without (b) converts
the estate's named refusal into a crash.

### (b) `QueryEngine` provisions its own route when constructed without one

**Every runtime input the route factory needs is already on the engine.**
`createCandidateRoute(schema, driver, { index, registry })` needs the model map,
the driver, the resolved relation index and the schema registry;
`QueryEngine` holds `driver` and `registry`, and `registry.relations` is a
`ReadonlyMap<Model, …>` whose keys are **every** model of the schema
(`relation-resolution.ts:1297-1307` sets an entry for every model, related or
not), so the map is rebuilt under the same name the route looks models up by
(`model["~"].names.ts`, which is also the name `PendingOperation` uses).

**One thing was missing, and it is a type, not a value.**
`ResolvedSchemaViews.registry` is declared as the full
`ReturnType<typeof createResolvedSchemaRegistry>`, which carries a `proxy`
member; `ModelRegistry.schemas` is `OperationSchemaRegistry =
Pick<SchemaRegistryLookup, "getModelSchemas" | "validate">`, which does not:

```
src/query-engine/query-engine.ts(219,5): error TS2741: Property 'proxy' is
missing in type 'OperationSchemaRegistry' but required in type
'SchemaRegistryLookup<Record<string, Model<any>>>'.
```

`EngineSchema` never reads `proxy` — it uses `this.registry.getModelSchemas(…)`
at `shared/schema.ts:204, 372, 445, 476` and nothing else — so the smallest
honest repair is to declare `ResolvedSchemaViews.registry` as what the engine
actually consumes (`Pick<…, "getModelSchemas" | "validate">`). With that,
27 lines across 2 files, the whole estate typechecks with only the permitted
diagnostics.

| | files | cells |
| --- | ---: | ---: |
| baseline | 34 | 533 |
| **(b)** | **32** | **521** |

**(b) alone is strictly better than the baseline**: 0 cells newly fail, 12 newly
pass. `orderby-relation-depth` and `query-operation-coverage-boundaries` go
green; `pending-operation-contracts` 11 → 4; `operation-program-read-contracts`
2 → 1. Every remaining `TypeError` disappears from the lane (22 → 0).

### (c) both

| | files | cells | collected |
| --- | ---: | ---: | ---: |
| baseline | 34 | 533 | 9,420 |
| (a) | 32 | 537 | 9,420 |
| (b) | 32 | 521 | 9,420 |
| **(c)** | **29** | **268** | **9,542** |

267 cells newly pass; the only 2 "newly failing" cells are in
`namespace-qualification.core.test.ts`, which stops aborting at collection and
runs 122 cells for the first time (2 of them red). Whole-estate typecheck under
(c): the two permitted `pattern/pack.ts` diagnostics and nothing else of mine.
Modes: `g4-unit01-author` **GREEN** (was 7 failed / 83), `g4-unit01-review`
**2 failed / 200** (was 23), `g0` unchanged at 5 failed.

**The 268 residual cells, by class:**

| Residual cause | Cells | Class | Meaning |
| --- | ---: | :-: | --- |
| the candidate's SQL text differs from the deleted engine's pin (`expected 'X' to contain 'Y'`, `to be`, 32 byte-snapshots) | **228** | A | the suite has to be deleted or re-pinned; the engine answers, the text differs |
| `does not compile to one SQL statement` | **33** | A | write verbs and `groupBy`-family folds — the sync `Sql` limit above |
| `publishes no single driver result to parse` + `prepare()` → `undefined` | ~**14** in 4 files (`request-transforms` 6, `sqlite-integer-safety` 1, `pending-operation-contracts` 2, `request-result-shape-contracts` 5) | B | the SAME publication question one seam further: the array owner's `prepare`/`parseResult` arms in `pending-operation.ts:340-352` |
| `ENOENT` reading a deleted owner | **3** | A | the source-text architecture gates |
| behaviour differences with no refusal in them | **10** | D | rows 29–34 of R2.4.1, unchanged by every option |

Receipts: [`core-option-a.log`](receipts/round2/scratch-measurement/core-option-a.log),
[`core-option-b.log`](receipts/round2/scratch-measurement/core-option-b.log),
[`core-option-c.log`](receipts/round2/scratch-measurement/core-option-c.log),
[`option-matrix.txt`](receipts/round2/scratch-measurement/option-matrix.txt)
(the per-file table), [`residual-c.txt`](receipts/round2/scratch-measurement/residual-c.txt),
the three typechecks and the six mode logs in the same directory.

**What the measurement says, stated plainly and without recommending:** (a)
without (b) is worse than doing nothing; (b) alone is free and strictly
positive; together they move the lane from 533 failing cells to 268 and repair
both `g4-unit01` modes, and what is left is overwhelmingly (228 of 268) the
deleted engine's own SQL text, which no publication decision can repair — those
suites are deleted with their engine or re-pinned against the candidate, one by
one. Neither option touches classes C and D at all.

## R2.6 Two things round 2 found that nobody has recorded

1. **The whole-estate typecheck is RED, and not because of the cutover.**
   `node scripts/run-typecheck.mjs` on the main tree reports **five**
   diagnostics: the two permitted `pattern/pack.ts` TS2345 at `(1443,36)` and
   `(2633,58)`, and **three TS2322 in the reviewer's own retained probe**
   `tests/raptor3/g4/review/cutover/routed-operations-authority.review.test.ts`
   at `(70,11)`, `(87,11)` and `(103,11)`
   ([receipt](receipts/round2/typecheck-round2.txt)). The file is untracked and
   belongs to the review, not to this unit; the three interceptor callbacks
   (`findUniqueOrThrow: async () => short`, `findFirstOrThrow: …`,
   `create: …`) return a bare object literal where the `$extends` query seam's
   type wants `Promise<Prettify<InferSelectInclude<…>>>`. **Requested change,
   for that file's owner:** annotate the three callbacks (e.g.
   `findUniqueOrThrow: (async () => short) as never`) or widen `short` to the
   model's inferred type. This unit did not edit another stream's file. Until it
   is fixed the brief's terminating condition ("exactly the two Pattern
   diagnostics") does not hold, and it is a **blocker for commit 4** —
   independent of everything else in this note. Round 2's own edits add zero
   diagnostics: the same five appear on the scratch copies with and without
   options (a), (b) and (c).

2. **One provider contract silently lost its libsql arm.**
   `contract-matrix.core.test.ts > matches matrix run decisions to provider
   registrations` fails NEW at the cutover: `tests/providers/matrix.ts:133`
   still registers `batchPrimaryKeyDataflowContract` for libsql, and the file
   that called `batchPrimaryKeyDataflowContract.register(` for libsql was one of
   the three `libsql-write-engine-*.test.ts` files the patch deletes. The same
   contract survives for PGlite (`pglite-bulk-writes.test.ts`) and sqlite3
   (`sqlite3-polymorphic-batch.test.ts`). This is finding 3's class — cutover
   debris in a manifest — but removing the matrix entry ACCEPTS a coverage loss,
   so it is recorded here rather than done: **the libsql provider no longer runs
   `drivers.batch-primary-key-dataflow`.**

## R2.7 Identity, build and bundles after round 2

| | production | harness |
| --- | --- | --- |
| round 1, after the last edit | `f42d6facdc5b36b420ca47b929acb629383dc47d3aa55be9c0d68fe2ae3c19d3` | `5ba4982a6e49ed988d30a9422e72d873821cc7f3df37e23cfb0d556f3e7550ca` |
| **round 2** | **`6361661222b65bff46930d2f0245385b9fc9637c855650410e725b7289e255fe`** | **`469ea96e250706e6c08fd42ccc199d7b4facca9e5ba8da702d9fd24760383ed0`** |

([receipt](receipts/round2/identity-after-round2.json)). Both move, and both
moves are explained: production because the `operation-context.ts` COMMENT of
finding 6 is inside the production fingerprint (the harness fingerprint also
covers the review's own untracked probes, which arrived between the two
captures). **The production CHANGE is a comment**, and the build proves it:
`pnpm package:build` rebuilt `dist/` (181 files, exit 0,
[receipt](receipts/round2/package-build-round2.txt)) and
`measure-raptor3-baseline.mjs --bundle` reports the three fixtures **byte- and
sha-identical to `g4/cutover/bundles-identity4.json`** — engine 123,093 /
37,260 gzip / `b4bbee47…`, pg-simple 623,999 / 183,791 / `91acc78c…`,
pg-relations 624,280 / 183,921 / `a799ab40…`
([receipt](receipts/round2/bundles-round2.json)). §3.3's "zero bytes of
difference" still holds after round 2.

The production tree is therefore **base + the measured patch + two
documentation-only deltas**: `raptor3/AGENTS.md` (round 1, brief item 5) and the
`operation-context.ts` comment (round 2, review finding 6). No behaviour.

## R2.8 Commit-message drafts (two variants)

Both replace §6's draft. Both delete the sentence "Nothing a user can write
changes meaning", which review finding 2 showed to be false: `PendingOperation`
is exported from the package entry (`src/index.ts:61`), its
`buildStatement(): Sql | undefined` is in the built type surface
(`dist/index-DONhXaa8.d.mts:1532`), and after the cutover it answers `undefined`
for every operation.

### Variant 1 — the cutover as it stands (no `buildStatement` change)

```
feat(raptor3): cut over to the Raptor 3 engine (C-01)

The candidate becomes the only operation owner behind an unchanged public API
SHAPE. VibORM's constructor builds createCandidateRoute(...) for every client,
VibORM.create loses its non-public `route` parameter (G4-03; absent from
createClient, from the package entry and from the docs), PendingOperation keeps
only the route arm, QueryEngine loses operationExecutor/cacheOperationExecutor,
and client-route.ts loses createCandidateClient.

Deleted, 33 production owners / 28,740 lines: src/query-engine/write-engine/
(25 files, incl. RecordUpdateCompiler, CreateOperation, UpdateOperation,
UpsertOperation, DeleteOperation, the Relation*Part family and routing.ts),
the seven query-engine root owners (OwnWriteSteps, OwnWriteAnalyzer,
OwnWriteRelation, OwnWriteLedger, RelationMembership, relation-key-legality,
validator) and builders/to-one-composition.ts. Added: routed-operations.ts,
48 lines, holding READ_OPERATIONS / ROUTED_OPERATIONS / isReadOperation /
isWriteOperation verbatim so the interception and cache seams keep one
authority; four imports re-pointed at it.

Deleted with them, 197 test files / 86,498 lines: the shipped engine's own
contract suites. No test body was edited — a parity test that builds a shipped
client and a candidate client cannot be repaired once the shipped side is gone
without becoming a candidate-versus-candidate tautology.

Retired, not re-pointed: the six two-sided harness modes g4-route-lifecycle,
g4-route-admission, g4-route-cache, g4-route-transactions, g4-lifecycle-events
and g4-lifecycle-admission, plus 21 reviewer probes under
tests/raptor3/g4/review/**. Five g4-unit02-author files were re-expressed
one-sided (136 -> 130 cells) and 31 cells in 13 registered files were renamed
to what they now compare (the client route seam against the command engine).

PUBLIC BEHAVIOUR CHANGES, both deliberate:
- DatabaseAdapter.expressions.integerDivide is now the only path. It already
  shipped in the candidate; a third-party DatabaseAdapter implementation will
  not typecheck until it supplies the member.
- PendingOperation.buildStatement() — an exported method of an exported class —
  now returns undefined for every operation, so QueryEngine.build(...) raises
  "does not compile to one SQL statement" for every operation (divergence D-4').
  The candidate's prepared read owns a statement and does not publish it. Its
  JSDoc still promises the old behaviour and is corrected in this commit.

Whole-cost: charged production 53,890 -> 31,622 token-LOC (0.634 of the frozen
baseline, target 0.60), 71,146 -> 42,269 physical LOC (0.651, target 0.70);
src/**/*.ts 581 -> 549 files. Bundles byte-identical to the stage-2d
measurement: engine gzip 0.2377, both public PostgreSQL fixtures 0.700.

Decisions: D-8, D-9, D-10.

KNOWN RED, and a blocker for whoever takes the next step. The estate is not
the registered raptor3 estate: the repository's core gate (pnpm test:core,
--project='layer-*') is 34 failed files / 533 failed tests against 5 / 42 on
the base. Classified in
docs/architecture/raptor3-evidence/g4/cutover-execution/note.md R2.4:
  24 files / 494 cells  deleted-engine contract suites (SQL text, message text
                        or source text of an engine that no longer exists)
   6 files /  29 cells  public-client cells whose assertion is about the
                        changed single-statement seam
   6 files /  10 cells  UNCLASSIFIED — possible candidate defects, all on the
                        public client, listed cell by cell in R2.4.1
  10 modes + 2 support checks  differential lanes whose control arm was the
                        shipped engine (g0, g1-*, g2-*, the CLI self-test)
   2 modes              g4-unit01-author / g4-unit01-review, the same
                        QueryEngine.build oracle
```

### Variant 2 — the cutover with the statement published and the route provisioned

Identical to variant 1 except the PUBLIC BEHAVIOUR CHANGES block and the KNOWN
RED block:

```
PUBLIC BEHAVIOUR CHANGES:
- DatabaseAdapter.expressions.integerDivide is now the only path (as above).
- PendingOperation.buildStatement() publishes the candidate's prepared read as
  the one Sql it compiles to, so QueryEngine.build(...) keeps working for every
  read verb. A write keeps the refusal: the candidate's only write fold is the
  async prepareBatch(), and buildStatement() is synchronous. The prepared read
  carried the statement already (raptor3/shared/query.ts Read.query.sql); the
  published facts simply did not expose it.
- A QueryEngine built outside a client lineage (new QueryEngine(driver,
  registry), 36 test files and one benchmark) now provisions its own route from
  the registry it already holds, instead of crashing with an unnamed TypeError
  on the first operation. ResolvedSchemaViews.registry is declared as the two
  members EngineSchema actually consumes.

KNOWN RED, measured on this exact change: the core gate is 29 failed files /
268 failed tests (from 34 / 533), g4-unit01-author is GREEN and
g4-unit01-review has 2 of 200 left. 228 of the 268 are the candidate's SQL text
differing from the deleted engine's pinned text — those suites are deleted with
their engine or re-pinned one by one; 33 are write verbs that legitimately do
not compile to one statement; 14 are the same publication question at the array
owner's prepare/parseResult arms; 10 are the unclassified public-client cells
of R2.4.1; the 10 differential modes and 2 support checks are unaffected.
```

## R2.9 Round 2's unverified claims

- The classification of the 34 core-lane files is a reading of one failing
  assertion per distinct signature per file, not a cell-by-cell audit of all 533.
  Where a file mixes causes the table names them all, but the per-cause cell
  counts inside a mixed file are counted by error signature, not by reading each
  cell.
- Class **D** is an honest "cannot classify", not a claim of a defect. None of
  its 10 cells was bisected against the pre-cutover engine, and none was
  reproduced outside the core lane.
- The option (a)/(b)/(c) measurements are single runs of the core lane in a
  scratch copy, plus single runs of three modes. The scratch baseline reproduced
  the main tree's 34/533 exactly, which is the only cross-check performed.
- Option (b)'s model map is rebuilt from `registry.relations`' keys under
  `model["~"].names.ts`. Every model appears in that map by construction, but a
  schema whose names were never hydrated would key every model as `"unknown"`;
  `PendingOperation` already derives the model name the same way, so the two
  agree, and no test in the lane exercised an unhydrated multi-model schema.
- The "14 cells" attributed to the array owner's `prepare`/`parseResult` arms
  under (c) is a count by error signature and by reading four files' failing
  cells; it was not measured by implementing that publication.
- The nine class-C modes other than `g0` were not re-run under (c). The claim
  that they are unaffected rests on their construction (no `QueryEngine.build`,
  both arms through `createClient`), not on a run.
- Biome for the 31 renamed cells was compared per file by reverting the renames
  on a scratch copy and running `npx biome check` on disk in that copy: 27
  diagnostics before, 27 after, identical per file. The manifests and
  `operation-context.ts` were compared the same way (0 = 0, 6 = 6).
- The native PostgreSQL and MySQL groups, the four campaign families and the 51
  green fixed modes were NOT re-run in round 2. Round 2 changed `scripts/*`
  (three files), two layer guides, one production comment and 31 cell titles;
  `g4-unit02-author` (which owns 13 of those files) was re-run green, and the
  core lane covers the manifests. The rest of §3 stands on round 1's receipts.

## R2.10 Where round 2's record lives

- [`receipts/round2/INDEX.txt`](receipts/round2/INDEX.txt) — every receipt, what
  it is and what it says.
- [`receipts/round2/round2.patch`](receipts/round2/round2.patch) —
  `git diff --binary HEAD` restricted to the paths round 2 touched: **22 tracked
  files** (3 scripts, 2 layer guides, 1 production comment, 16
  `tests/raptor3/g4/unit02/**`). It carries round 1's re-expressions of those
  unit02 files too, because they were already modified, and it does NOT carry
  this note, which lives in the untracked evidence tree;
  [`cutover.patch`](cutover.patch) stays round 1's whole-unit snapshot and was
  NOT regenerated (regenerating it would need `git add -N` for the one untracked
  production file, and this unit does not stage).
- [`receipts/round2/scratch-measurement/`](receipts/round2/scratch-measurement/)
  — the (a)/(b)/(c) measurement and its patch. The three scratch copies lived
  outside the repository and were deleted; nothing of them remains in the tree.

**Open for Arnaud, unchanged by round 2 and now costed:** what
`PendingOperation.buildStatement()` / `QueryEngine.build` publish (R2.5, R2.8);
whether a bare `QueryEngine` provisions a route (R2.5 (b) — the only option
measured to be free); what replaces the ten differential lanes and two support
checks (§5 follow-up 1; no option in R2.5 touches them); the disposition of the
23 deleted-engine contract suites (R2.4.3); the ten unclassified public-client
cells (R2.4.1 rows 29–34), which need a reading whatever else is decided; and
the deleted dirty pattern file (§1.2, review finding 5).

---

# Round 3 — D-11 … D-14 applied, the class-D bisection, and the estate re-verified

Round 3 applies Arnaud's decisions **D-11** (the differential modes), **D-12**
(dispose of every newly red core-lane file), **D-13** (the two preserved
pattern preimages stay and the deletions stand) and **D-14**
(`buildStatement()` / `QueryEngine.build()` publish the statement when the
operation prepares to exactly one, and `QueryEngine` provisions its own route
when constructed without one). Base is unchanged (`5a37bcd7`); nothing was
committed, staged, reset or stashed; `CONTEXT.md`, `memory.md`, `exa-results/`,
the eight root `transport-*-corpus.json` files (mtime 9 Sep) and the pre-G4
evidence were not touched. New receipts are under
[`receipts/round3/`](receipts/round3/).

**Identity after the last edit** (`captureRaptor3Identity`,
[receipt](receipts/round3/identity-after.json)):

| | production | harness |
| --- | --- | --- |
| round 2 | `6361661222b65bff46930d2f0245385b9fc9637c855650410e725b7289e255fe` | `469ea96e250706e6c08fd42ccc199d7b4facca9e5ba8da702d9fd24760383ed0` |
| **round 3** | **`50c0ee97fb1458333c818735da4c92b7bca89daa65929199c00ef551533b7a63`** | **`ce8436e6122b50e738c4d40ced64a6057d7bdf61c0ecb813b7b339afa82048ea`** |

`runtime` is unchanged (`v24.21.0`, darwin/arm64, better-sqlite3 12.6.0, Vitest
3.1.4). **Unlike round 1, no receipt in round 3 was taken at an intermediate
identity**: the build, the three bundle fixtures and all four campaign children
were re-run after the last edit and carry `50c0ee97… / ce8436e6…`.

## R3.1 What D-14 changed in production, file by file

Six production files, **+191 / −38** over the measured cutover patch (the
`operation-context.ts` figure below excludes round 2's +9/−8 comment
correction). Measured by diffing the live tree against a pristine
`5a37bcd7` + `cutover-identity4.patch` scratch tree.

| File | +/− | What it now owns |
| --- | ---: | --- |
| `src/query-engine/raptor3/commands/index.ts` | **+36 / −0** | `PreparedRead` gains `statement: Sql`, and `publishedFacts` fills it from the prepared `Read`'s own `query.sql` — the statement the execution runs, read from the same construction, so `build()` and the run cannot describe different queries. `PreparedOperation` gains `prepareSingle(attribution?)`: the SAME package `prepareBatch` publishes, for the verbs whose preparation reaches no driver (a read). It admits the input first, whatever the verb compiles to, so a refusal about the payload is still raised for a verb that publishes no single query. |
| `src/query-engine/raptor3/route/client-route.ts` | **+27 / −0** | `RoutedCandidateOperation.buildStatement()` returns `prepared.read?.statement`; `prepareSingle(context)` forwards the package. Both are one line each over the one prepared handle the route already builds per client operation — **no second lowering and no re-derivation** (rule 1). |
| `src/query-engine/raptor3/shared/operation-context.ts` | **+25 / −8** | `publish`'s batch-preparation arm is extracted as the synchronous `publishPrepared(read, missing)` that `publish` itself calls, and the row→value decision both arms make is the single `decideRead`. That extraction is what makes a read's package reachable synchronously; there is still exactly one decode and one owner. |
| `src/query-engine/pending-operation.ts` | **+58 / −23** | `buildStatement()` answers `this.#resolveRouted().buildStatement()` and its JSDoc states the truth (every read publishes one statement; a write answers `undefined` because the engine's only write fold is the asynchronous `prepareBatch`, and this accessor is synchronous). `#resolveSinglePackage()` memoizes the one package, and the array-owner arms read it: `prepare()` publishes `queries[0]`, `parseResult(raw)` applies `single.parseResult([raw])` — **the package's own parser**, with the unchanged refusal sentence where there is no package. The registered refusal `Unknown operation '<x>' on model '<y>'. Known operations: …` is restored at the route seam, from `ROUTED_OPERATIONS` (the one vocabulary owner); it had been deleted with `#resolveOperation`. |
| `src/query-engine/query-engine.ts` | **+35 / −6** | `provisionedRoute(driver, registry)` and `this.route = route ?? provisionedRoute(driver, registry)`. It is built from the driver and the registry the engine already holds — the registry's resolved topology index (whose keys enumerate every model) and its operation schema registry, the exact pair `VibORM`'s constructor hands to `createCandidateRoute`, under the same name the route and `PendingOperation` look a model up by. **No policy boolean and no second route factory**; the `route` field's JSDoc is restated. |
| `src/query-engine/raptor3/shared/schema.ts` | **+10 / −1** | The one open type of the measured option (c): `ResolvedSchemaViews.registry` is declared as `Pick<ReturnType<typeof createResolvedSchemaRegistry>, "getModelSchemas">` — exactly the member `EngineSchema` reads (`:204`, `:372`, `:445`, `:476`, and nothing else). **No cast and no widening of the registry**: a client's full resolved registry and an engine's `OperationSchemaRegistry` both satisfy it, and the TS2741 on `proxy` is gone. |

**Nothing was genuinely missing.** Round 2's question — "if an input is missing,
say which" — has the answer *none*: the two resolved views the route's engine
consumes are already on `ModelRegistry`, and the only gap was the declared type
above.

**No folded single-statement write is published.** D-14 asks for "a folded
single-statement write if the package exposes it". The package does not expose
one synchronously: the engine's only write fold is `PreparedOperation.prepareBatch()`,
which is `async` and publishes driver-prepared `PreparedQuery[]`
(`{ sql: string, params, context }` from `driver._prepare`), not an `Sql`.
`buildStatement(): Sql | undefined` is synchronous, so publishing a write fold
would need an async `build()` — a public signature change, which is a decision,
not a repair. Every write therefore keeps the existing refusal, and the JSDoc
says exactly that.

## R3.2 The class-D bisection — every cell is an unrecorded compatibility difference of the candidate

Method, per the round-3 brief: `git archive 5a37bcd7` into a scratch tree
outside the repository, make `VibORM.create`'s `route` parameter default to
`createCandidateRoute` (two lines, [diff](receipts/round3/classd-bisect/base-tree-route-default.diff))
so every `createClient` in the estate is the pre-cutover candidate route, and
run the six class-D files there. The main tree was not touched; the scratch copy
was deleted afterwards.

**All ten cells fail on the BASE with the candidate route, with the same
observable, byte for byte**
([receipt](receipts/round3/classd-bisect/base-5a37bcd7-candidate-route.log)):

| Cell | Observable on base+candidate = on the cutover tree |
| --- | --- |
| `array-transaction-closure` › keeps an already-applied observation settled when a later parse fails | `promise resolved "[ [], [] ]" instead of rejecting` |
| `official-cache-swr` › contains provider, snapshot, set, and cleanup failures | `expected +0 to be 1` (`hostileJsonReadsAtCoreBoundary`) |
| `query-interceptors-array` › orders provider, committed outcomes, parsing, and handler post-work | `expected "spy" to be called once, but got 0 times` |
| `query-interceptors-array` › keeps the native child primary across ordered post-work and commit failures | `expected [ …(3) ] to have a length of 5 but got 3` |
| `query-interceptors-array` › orders native statement onions before transforms and submits nothing on failure | `expected [ 'provider' ] to deeply equal []` |
| `query-interceptors-array` › keeps observe-only native admission private and reports exact commit facts | `Error: Expected the array transaction to fail` |
| `query-interceptors-integration` › reports commit ambiguity for a direct composed write transaction | `expected [] to deeply equal [ 'may-have-committed' ]` |
| `query-interceptors-integration` › reports committed certainty when direct transaction cleanup fails after commit | `expected [] to deeply equal [ 'committed' ]` |
| `bulk-insert-row-shapes` › empty createMany rejects during batch preparation | `promise resolved "[ { count: +0 } ]" instead of rejecting` (the `"No data to insert"` refusal is gone) |
| `select-mode-capability-matrix` › operation `'upsert'` fails before dispatch | `expected QueryError: Query execution failed {…} to be an instance of TransactionError` |

The same run also reproduces the two class-A message cells of
`select-mode-capability-matrix` (`Driver "x"` vs `Driver 'x'`), so those are the
candidate's own message too, not cutover debris.

**Therefore, per the brief: none of them is a cutover defect, none was repaired
and none was deleted.** They are ten (now eight — see below) unrecorded
compatibility differences of the candidate, and they are a decision for Arnaud.

**Two of the ten were nonetheless closed by D-14's array-owner extension**,
because the array rail was taking the package path for reads where the shipped
engine took the single-statement path: `array-transaction-closure` went green
and `query-interceptors-array` went 4 red → 3. That is a repair inside the
cutover's own files, not a change of their classification. **Eight remain**, and
they are the whole of the residual red (R3.6).

## R3.3 D-11 — the differential modes, under the §1.4 rule

**No mode was retired and no registered cell was lost.** The brief's rule is
"retire the modes whose every arm needs the shipped engine; where a mode has
one-sided cells, keep the mode with those cells and lower its count". Applying
§1.4 (remove the shipped arm and every assertion that references it; a cell with
a verbatim surviving one-sided assertion is kept) made **all ten class-C modes
and both support checks green at their full registered counts**, so there was
nothing left whose every arm needed the deleted engine.

| Harness owner | Change | Modes it repairs |
| --- | --- | --- |
| `tests/raptor3/scenarios/contracts/instances.ts` | the two S2 scenarios drop their `singleAdmission` branch: one evaluation per admitted input on every arm, since `createClient` IS this engine. `verifyInstanceAdmissionPair` and `verifyChangedDependencyCommandsProgress` — the adjudicators that existed to translate legacy ids and the legacy `recordSeriesProgress` shape — are **retired** (−86 lines); `verifyProgramEnginePair` (+42) replaces the second of them where the difference actually lives now. | `g0` (5 red → green, 33/33), `g1-compare` |
| `tests/raptor3/candidate.test.ts`, `candidate-ordering.test.ts` | the special-case block collapses to `verifyG0Pair`; the `program` arm uses `verifyProgramEnginePair`; the `assert.throws` that pinned "the two arms differ" is gone with its subject. The corpus `records.push` for the two adjudicated scenarios is kept. | `g1-compare` (12 red → green, 66/66) |
| `tests/raptor3/expanded/upsert-legality.ts` | `g1-upsert-nested-admission-publication` drops the legacy `Changed-2` second transform from its ledger. | `g1-baseline` (141/141), `g1-contracts` (143/143) |
| `tests/raptor3/expanded/lifetime-commands.test.ts` | the adjudicated cell becomes `verifyG0Pair` plus its replays. | `g1-contracts` |
| `tests/raptor3/generation/transitions.ts`, `generation/campaign.ts` | `primaryAdmissions` is 1 for every mode and arm; the campaign's `duplicateAdmissions` slice (which removed "legacy's duplicate first admission") is gone. | `g2-generated` (36 red → green, 52/52) |
| `tests/raptor3/transport/world.ts` | the `key-update` actor script loses its `candidate === "legacy"` plan (the deleted engine's INSERT-then-UPDATE order and its shorter lookups); the "acknowledged" phase and the ordinary-UPDATE progress contract are stated once for both arms. | `g2-transport` (16 red → green, 16/16) |
| `tests/raptor3/transitions/unique-races-live.ts` | `expectedAttempts` is 1 on every arm (the deleted engine's two-attempt retry has no arm left); the evidence record names the client route instead of "legacy". | `g2-pg-baseline`, `g2-pg-contracts`, `g2-mysql-baseline`, `g2-mysql-contracts` |

**The two support checks followed their cause**, as the brief says: the CLI
self-test (which shells out to `run-raptor3 g0`) is **10/10** and the
credential-free `--only "Raptor 3 fixed"` selector is **65 files / 758 cells,
all passing** — the same four files that were red are the four repaired above.

`scripts/raptor3-manifest.mjs` therefore keeps all 65 registered fixed modes and
every count except one: `g4-unit01-review`'s `distance-parity.test.ts` moves
**9 → 7** (R3.4), which the receipts self-test's own total (200 → 198) records.

## R3.4 D-12 — the disposition of every newly red core-lane file

**Class A — the deleted engine's SQL-text, message, oracle and source-text
suites: deleted with it.** 15 test files + 1 snapshot file, **9,222 lines, 568
registered cells**. Nothing was re-pinned.

| # | Deleted file | cells | red under (c) | Why it has no subject after C-01 |
| ---: | --- | ---: | ---: | --- |
| 1 | `tests/contracts/engine/query/sql-generation.core.test.ts` | 147 | 56 | pins the shipped engine's SQL text |
| 2 | `tests/contracts/engine/query/field-reference-sql.core.test.ts` | 89 | 40 | same |
| 3 | `tests/contracts/engine/query/operand-callback-sql.core.test.ts` | 74 | 12 | same |
| 4 | `tests/contracts/engine/query/decimal-having-operand-sql.core.test.ts` | 48 | 6 | same |
| 5 | `tests/contracts/engine/query/cursor-pagination-sql.core.test.ts` | 44 | 30 | same |
| 6 | `tests/contracts/engine/query/read-traversal-byte-pins.core.test.ts` | 32 | 32 | byte snapshots of the shipped SQL |
| 7 | `tests/contracts/engine/query/json-null-sentinel-sql.core.test.ts` | 30 | 9 | pins the shipped SQL text |
| 8 | `tests/contracts/engine/query/request-result-shape-contracts.core.test.ts` | 29 | 18 | the shipped engine's private carriers (`0viborm_relation_counts`, `0viborm_empty_row`), `t0` aliases and row-shape enforcement |
| 9 | `tests/contracts/engine/query/geopoint-sql.core.test.ts` | 20 | 6 | pins the shipped SQL text |
| 10 | `tests/contracts/engine/query/lateral-joins.core.test.ts` | 18 | 7 | same |
| 11 | `tests/contracts/engine/query/batch-attribution-hazard-signature.core.test.ts` | 17 | 12 | same, for write verbs |
| 12 | `tests/contracts/engine/write/parse-boundary-gate.core.test.ts` | 6 | 3 | a source-text gate over `write-engine/`'s deleted owners, plus its own ratchet |
| 13 | `tests/contracts/engine/write/architecture-gates.core.test.ts` | 6 | 1 | a source-text gate over `write-engine/CreateOperation.ts` |
| 14 | `tests/contracts/drivers/namespace-execution-target.core.test.ts` | 5 | 5 | its oracle is `QueryEngine.build(..., "createMany", …)`, which legitimately compiles to no single statement |
| 15 | `tests/contracts/engine/query/operation-equivalence-oracles.core.test.ts` | 3 | 3 | frozen SQL+params oracles of the deleted engine |
| 16 | `tests/contracts/engine/query/__snapshots__/read-traversal-byte-pins.core.test.ts.snap` | — | — | the snapshots of #6 |

**Class A cells inside suites that are NOT about the deleted engine: the cells
were removed, the suite kept.** Deleting 122, 115, 12 or 2 live cells to retire
one deleted-engine pin would have been a coverage loss the rule does not ask
for.

| File | cells | removed | The pin that was removed |
| --- | ---: | ---: | --- |
| `tests/contracts/engine/query/namespace-qualification.core.test.ts` | 122 → 120 | 2 | `FROM "billing"."ns_users" AS "t0"` / `AS "t1"` — the deleted engine's alias letter |
| `tests/contracts/drivers/provider-result-contracts.core.test.ts` | 115 → 114 | 1 | a full PlanetScale GeoPoint SQL string |
| `tests/contracts/engine/query/bulk-create-plan.core.test.ts` | 12 → 11 | 1 | `toThrow("is unresolved")` — the deleted engine's short-window message |
| `tests/contracts/engine/query/operation-program-read-contracts.core.test.ts` | 2 → 1 | 1 | rows keyed by the shipped `COUNT_RESULT_KEY` / `getAggregateResultKey` carriers |
| `tests/raptor3/g4/review/unit01-followup/distance-parity.test.ts` | 9 → 7 | 2 | `AS "0viborm_distance"` beside the candidate's `AS "_distance"` (the two cells the round-3 brief names) |

**Class B — public-client cells about the changed seam: kept, and green.**

| File | red before | red after | What closed it |
| --- | ---: | ---: | --- |
| `tests/contracts/public-client/request-transforms.core.test.ts` | 6 | **0** | `prepare()` publishes the read's one query and admits the input |
| `tests/contracts/engine/query/pending-operation-contracts.core.test.ts` | 11 (round 2) → 4 | **0** | `prepare()`, `parseResult`, admission on `prepare()`, and the restored `Unknown operation` refusal |
| `tests/contracts/drivers/sqlite-integer-safety.core.test.ts` | 1 | **0** | `prepare()` |
| `tests/contracts/public-client/one-resolution-identity.core.test.ts` | 1 | **0** | `buildStatement()` |
| `tests/unit/cache/operand-callback-keys.core.test.ts` | 1 | **0** | `buildStatement()` (the review's own finding-2 probe) |
| `tests/contracts/engine/query/query-operation-coverage-boundaries.core.test.ts`, `orderby-relation-depth.core.test.ts`, `operation-program-read-contracts.core.test.ts` | 1 / 3 / 2 | **0** | the provisioned route |

**Harness debris the cutover left, disposed:**

- 16 dead entries removed from `scripts/query-engine-test-manifest.mjs` (14),
  `scripts/driver-test-manifest.mjs` (1) and `scripts/coverage-policy.test.mjs`
  (1) — the same mechanical class as round 2's 52.
- `tests/providers/local/libsql-scalars-upserts.test.ts` **restored** without the
  two behaviour modules C-01 deleted (`create-nested-upsert-behavior`,
  `update-nested-upsert-behavior`): its **six** provider-contract registrations
  outlived the engine and were lost with the file —
  `batchPrimaryKeyDataflowContract` (the one R2.6.2 found) and also
  `clientRawContract`, `scalarRoundtripContract`, `fullScalarRoundtripContract`,
  `decimalExactnessContract`, `upsertAtomicityContract`, all five of which the
  matrix check only reveals one at a time. **The libsql provider runs
  `drivers.batch-primary-key-dataflow` again** and R2.6.2's recorded coverage
  loss is closed.
- `tests/providers/docker/pg-nested-write-races.test.ts` gains the two pg
  registrations lost with `pg-write-update.test.ts` and `pg-write-upsert.test.ts`
  (`batchPrimaryKeyDataflowContract`, `createManyReturnFoldContract`). An
  independent sweep over every provider × contract now reports **0 missing and 0
  unexpected** registrations.
- `tests/types/query-engine/single-statement-publication.core.types.ts` — the
  query-engine layer lost its ONLY type core when the patch deleted
  `tests/types/query-engine/routed-operation.core.types.ts` (which typed
  `write-engine/OperationExecutor`, `record-series` and `routing`, all deleted).
  The new 42-line type core states the D-14 surface through the package entry:
  `buildStatement()` publishes `Sql | undefined` and `QueryEngine.build()` never
  publishes absence. `contract-matrix`'s "one runtime core owner and one type
  core" cell is green again.
- `scripts/raptor3-campaign-receipts.test.mjs`'s `G4_UNIT01_REVIEW_COUNTS` total
  200 → 198, with the reason in a comment.

## R3.5 D-13 — the two preserved preimages

Untouched and still in place, for the integrator to commit:
`receipts/preserved-unrelated-dirty/tests_pattern_pack_program-dump.ts` and
`receipts/preserved-unrelated-dirty/tests_pattern_match_decode-malformed.core.test.ts`.
The two deletions stand.

## R3.6 The residual red, and the one ceiling this unit misses

`node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project='layer-*'`
(the review's ceilings), [receipt](receipts/round3/core-round3.log):

| Tree | Failed files | Failed tests | Total |
| --- | ---: | ---: | --- |
| base `5a37bcd7` | 5 | 42 | 532 files / 11,292 tests |
| cutover, round 2 | 34 | 533 | 467 / 9,420 |
| **cutover, round 3** | **6** | **11** | **452 / 8,969** |

Progression, all measured on the main tree:
533 → 268 (D-14's publication + the provisioned route) → 260 (the array-owner
arms) → 14 (class A disposed) → 12 (the restored provider registrations and the
new type core) → **11** (the restored `Unknown operation` refusal).

**Failed tests are 11 against the base's 42 — comfortably under. Failed FILES
are 6 against the base's 5 — one over, and this unit cannot close it without
disobeying D-12.** The six:

| File | cells | What it is |
| --- | ---: | --- |
| `tests/contracts/architecture/contract-matrix.core.test.ts` | 1 | **red at base too**: "inventories every executable test by owner and boundary" — `tests/raptor3/candidate-handoff.test.ts: expected undefined to be defined`. The base's other two contract-matrix failures are gone (one was the deleted `tests/types/raptor3/route-public-types.core.types.ts`, one the libsql registration). |
| `tests/contracts/public-client/query-interceptors-array.core.test.ts` | 3 | class D, bisected |
| `tests/contracts/engine/query/select-mode-capability-matrix.core.test.ts` | 3 | 1 class D + 2 class-A message-quote cells that **cannot be separated**: the file is a single `test()` parameterized over `create`/`update`/`upsert`, so removing the two message cells would remove the class-D `upsert` observable with them |
| `tests/contracts/public-client/query-interceptors-integration.core.test.ts` | 2 | class D, bisected |
| `tests/contracts/public-client/official-cache-swr.core.test.ts` | 1 | class D, bisected |
| `tests/contracts/engine/query/bulk-insert-row-shapes.core.test.ts` | 1 | class D, bisected |

Five of the six carry only cells the brief says to neither repair nor delete.
**The file-count ceiling and the class-D instruction are in direct tension, and
this note reports the tension rather than resolving it**: closing it needs
Arnaud to decide the eight compatibility differences (or to accept
`select-mode-capability-matrix`'s two message cells being deleted with their
class-D sibling).

## R3.7 Verification receipts

Every command ran serially under the existing workspace lock, on the pinned
runtime, from `/Users/arnaud/code/viborm`. No lock was contended or removed.

| Check | Result | Receipt |
| --- | --- | --- |
| `node scripts/run-typecheck.mjs` | the two permitted `pattern/pack.ts` TS2345 — **plus three TS2322 that are not this unit's** (R3.8) | [`typecheck-final.txt`](receipts/round3/typecheck-final.txt) |
| `pnpm package:build` | exit 0, 181 files, 6,491.64 kB | [`package-build.txt`](receipts/round3/package-build.txt) |
| bundle fixtures | **every byte of difference stated below** | [`bundles-after.json`](receipts/round3/bundles-after.json) |
| 59 fixed modes through the driver | **59 / 59 green**, every registered count exact | [`fixed/RUN.log`](receipts/round3/fixed/RUN.log) + one log per mode |
| 12 native PostgreSQL modes (`docker port … 5432` → `127.0.0.1:55729`) | **12 / 12 green** | [`native-pg/RUN.log`](receipts/round3/native-pg/RUN.log) |
| 11 native MySQL modes (`docker port … 3306` → `127.0.0.1:55730`) | **11 / 11 green** | [`native-mysql/RUN.log`](receipts/round3/native-mysql/RUN.log) |
| support: receipts self-test | **39 / 39** | [`support/receipts-selftest.log`](receipts/round3/support/receipts-selftest.log) |
| support: CLI self-test alone | **10 / 10** (was 0 / 10) | [`support/cli-selftest.log`](receipts/round3/support/cli-selftest.log) |
| support: structure census | exit 0 | [`census-after.txt`](receipts/round3/census-after.txt) |
| support: driver integration (`layer-client`, 1,536 MiB RSS / 768 MiB heap) | **2 files / 16 tests** | [`support/driver-integration.log`](receipts/round3/support/driver-integration.log) |
| support: credential-free `--only "Raptor 3 fixed"` | **65 files / 758 tests green** (was 740 / 758) | [`support/credential-free-fixed.log`](receipts/round3/support/credential-free-fixed.log) |
| support: credential-free `--only "raptor3-provider:"` | green | [`support/credential-free-provider.log`](receipts/round3/support/credential-free-provider.log) |
| four G4 campaign first children | **all four byte-identical to the attempt-6 archives** | [`campaigns/corpus-comparison.json`](receipts/round3/campaigns/corpus-comparison.json) |
| `pnpm test:coverage:policy` | **11 / 11**, exit 0 for all three commands | [`coverage-policy.log`](receipts/round3/coverage-policy.log) |
| `core-taxonomy-census.core.test.ts` | **4 / 4** | [`core-taxonomy-census.log`](receipts/round3/core-taxonomy-census.log) |
| core lane | 6 files / 11 tests (R3.6) | [`core-round3.log`](receipts/round3/core-round3.log) |

### Bundles — every byte of difference from `bundles-identity4.json`

| Fixture | runtime bytes | Δ identity 4 | gzip | Δ identity 4 | gzip ÷ frozen baseline | §7 target |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `engine` | 329,134 | **+206,041** | 92,390 | **+55,130** | **0.5893** | ≤ 0.75 — **met** |
| `pg-simple` | 624,922 | **+923** | 184,023 | **+232** | **0.7006** | ≤ 1.00 — **met** |
| `pg-relations` | 625,203 | **+923** | 184,152 | **+231** | **0.7008** | ≤ 1.00 — **met** |

sha256: engine `1e0a7878…d4be`, pg-simple `231a3b64…7605`, pg-relations
`b10a9bdd…ddc7` — all three differ from identity 4, and the reason is exact.

- **The `engine` fixture grew because it now contains the engine.** Its protocol
  is `export { QueryEngine, createModelRegistry }` + `export { PendingOperation }`.
  Before D-14 `query-engine.ts` referenced `ClientOperationRoute` by TYPE only,
  so the fixture held **no** `raptor3` module at all (93 modules) and §3.3's
  0.2377 was, as the note said, not a candidate size result. `provisionedRoute`
  makes `createCandidateRoute` a value import, so the fixture now holds 176
  modules — the whole candidate — and **0.5893 is a real candidate size result
  under the 0.75 target**.
- **The two public PostgreSQL fixtures grew by 923 runtime bytes each** (+232 /
  +231 gzip): the statement publication, `prepareSingle`, the provisioned route
  and the restored refusal. Both ratios moved 0.6997 → 0.7006 and
  0.6999 → 0.7008, still far under 1.00.

### The four campaign corpora, at the final identity

| Command | corpus bytes | body sha256 (identity removed) | verdict |
| --- | ---: | --- | --- |
| `g4-seed-batch 20000 --subject=candidate` | 338,001 = 338,001 | equal | **identical** |
| `g4-transport-seed-batch 50000 --subject=candidate` | 324,201 = 324,201 | equal | **identical** |
| `g4-write-seed-batch 75000` | 61,371,797 = 61,371,797 | equal | **identical** |
| `g4-write-transport-seed-batch 100000` | 64,091,456 = 64,091,456 | equal | **identical** |

The only difference in any of the four is the embedded
`identity.production` / `identity.harness` fingerprint (`312cde34… / 1d4d913c…`
→ `50c0ee97… / ce8436e6…`), which must change because the source changed;
`identity.runtime` is equal. **D-14 changed no campaign corpus.**

### Cost, after round 3

| Charged production | files | bytes | physical LOC | token LOC |
| --- | ---: | ---: | ---: | ---: |
| frozen baseline | 161 | 2,292,906 | 64,980 | 49,887 |
| before the cutover | 171 | 2,518,074 | 71,146 | 53,890 |
| round 2 | 139 | 1,420,269 | 42,269 | 31,622 |
| **round 3** | **139** | **1,423,012** | **42,335** | **31,664** |

Ratios: token **0.6347** (target 0.60, missed by 3.5 points — a target, not a
hard requirement), physical **0.6515** (target 0.70, **met**), bytes 0.6206.
D-14 costs **+2,743 bytes / +66 physical / +42 token-LOC** over round 2; the
whole-cost result is still a deletion of **−22,226 token-LOC / −28,811 physical
LOC / −1,095,062 bytes / −32 charged files** against the pre-cutover census.
`src/**/*.ts` is **549** files. Structure census, `src/query-engine`: 149 files,
58,206 lines, 46,543 token lines, 2,816 functions, 6,854 branch nodes, 2 runtime
import-cycle components over 14 files (unchanged).

### Formatting

`npx biome check --max-diagnostics=500` over the 22 harness/script files round 3
touched reports **302** diagnostics; the same files at `5a37bcd7` report **317**.
No diagnostic class appears that did not appear at the base, and the three this
round did introduce (a `format` in `coverage-policy.test.mjs`, a `format` in
`instances.ts`, an import order in the new type core) were fixed by hand. The
six production files report **10** diagnostics, the same 10 the base reports for
them, all pre-existing (`noParameterProperties`, `organizeImports`, `format`).
**Biome `--write` was never run on a whole file.**

## R3.8 Blocker, and what round 3 did NOT do

1. **The whole-estate typecheck is still RED for three diagnostics this unit
   does not own.** `tests/raptor3/g4/review/cutover/routed-operations-authority.review.test.ts`
   `(70,11)`, `(87,11)`, `(103,11)` — TS2322 on three interceptor callbacks that
   return a bare object literal where the `$extends` query seam wants
   `Promise<Prettify<InferSelectInclude<…>>>`. The file is untracked and belongs
   to the review, which the round-3 brief says owns it. **Until its owner fixes
   it the brief's terminating condition ("exactly the two Pattern diagnostics")
   does not hold, and it is a blocker for commit 4.** Requested change, for that
   file's owner: annotate the three callbacks (e.g.
   `findUniqueOrThrow: (async () => short) as never`) or widen `short` to the
   model's inferred type.
2. **Eight public-client compatibility differences of the candidate are open**
   (R3.2). They are not repaired, not deleted, and not classifiable as cutover
   defects: the same assertions fail identically on `5a37bcd7` with the
   pre-cutover candidate route.
3. **The core lane is one FILE over the base's five** (R3.6), for the reason
   above.
4. **No folded single-statement write is published** (R3.1) — publishing one
   needs an async `build()`, a public signature change.
5. **`cs02-structure-measure` was not run** (§5 follow-up 9, unchanged).
6. **No performance cell was re-measured.** D-14 adds a synchronous package
   preparation on the `prepare()` path and a route construction per bare
   `QueryEngine`; stage 2d's series is the record D-9 accepted, and this unit did
   not re-measure it.

## R3.9 Round 3's unverified claims

- Every mode tally is a single run. Every green mode verified its exact
  registered cell count, so a flake would have to reproduce a count, but no
  green mode was run twice except the nine re-run after the last edit.
- The class-D bisection ran the six files ONCE on the base scratch tree. The
  scratch tree is `git archive 5a37bcd7` plus a two-line default on
  `VibORM.create`; it was not otherwise verified to be equivalent to
  `createCandidateClient`, although that is exactly what `createCandidateClient`
  did (`VibORM.create<C>(config, createCandidateRoute)`).
- The class-A file dispositions are a reading of each file's subject and of its
  failing assertions, not a cell-by-cell audit of all 568 deleted cells. The
  green cells deleted with those files (568 − 241 red = 327) were SQL-text
  assertions that happened to coincide with the candidate's text; they were not
  individually re-read.
- The "+191 / −38 production" figure is a `diff -u` line count against a
  `5a37bcd7` + `cutover-identity4.patch` scratch tree, with round 2's +9/−8
  comment subtracted by inspection of `round2.patch`.
- The bundle growth attribution (923 bytes to D-14) is arithmetic against
  identity 4, not a per-symbol measurement.
- `tests/providers/local/libsql-scalars-upserts.test.ts` is restored inside the
  same `describe.skip` the whole libsql contract suite uses ("V1 effectful push
  is not supported by libSQL"), so its six contracts are registered and
  matrix-visible but do not execute — exactly the state the deleted file had.
- The eight root `transport-*-corpus.json` files were confirmed untouched by
  mtime (9 Sep 02:09), not by hash.

## R3.10 Commit-message draft for commit 4 (replaces §6 and R2.8)

```
feat(raptor3): cut over to the Raptor 3 engine (C-01)

The candidate becomes the only operation owner. VibORM's constructor builds
createCandidateRoute(...) for every client and bind() forwards it, VibORM.create
loses its non-public `route` parameter (G4-03; absent from createClient, from
the package entry and from the docs), PendingOperation keeps only the route arm,
QueryEngine loses operationExecutor/cacheOperationExecutor, and client-route.ts
loses createCandidateClient.

Deleted, 33 production owners / 28,740 lines: src/query-engine/write-engine/
(25 files, incl. RecordUpdateCompiler, CreateOperation, UpdateOperation,
UpsertOperation, DeleteOperation, the Relation*Part family and routing.ts),
the seven query-engine root owners (OwnWriteSteps, OwnWriteAnalyzer,
OwnWriteRelation, OwnWriteLedger, RelationMembership, relation-key-legality,
validator) and builders/to-one-composition.ts. Added: routed-operations.ts,
48 lines, holding READ_OPERATIONS / ROUTED_OPERATIONS / isReadOperation /
isWriteOperation verbatim so the interception and cache seams keep one
authority; four imports re-pointed at it.

PUBLIC CONTRACT CHANGES, both deliberate:
- DatabaseAdapter.expressions.integerDivide is now the only path. It already
  shipped in the candidate; a third-party DatabaseAdapter implementation will
  not typecheck until it supplies the member.
- PendingOperation.buildStatement() and QueryEngine.build() keep the
  pre-cutover contract, made true for the new engine (D-14): they answer the
  ONE statement an operation compiles to whenever it compiles to exactly one,
  and keep the existing "does not compile to one SQL statement" refusal
  otherwise. Every read publishes one, from the prepared read the execution
  itself runs; a write answers the refusal, because the engine's only write
  fold is the asynchronous prepareBatch() and buildStatement() is synchronous.
  The JSDoc now says exactly that. The array-owner seam answers from the same
  single preparation: prepare() publishes that package's one query and
  parseResult() applies that package's own parser.
- A QueryEngine constructed without a route provisions one from the driver and
  the registry it already holds, so every engine has exactly one operation
  owner and none has two. ResolvedSchemaViews.registry is declared as the one
  member EngineSchema reads.

Deleted with the engine, 213 test files / 96,450 lines: its own contract
suites. 197 came with the measured patch; 15 more are the SQL-text, message,
oracle and source-text suites the core gate exposed (sql-generation 147 cells,
field-reference-sql 89, operand-callback-sql 74, decimal-having-operand-sql 48,
cursor-pagination-sql 44, read-traversal-byte-pins 32 + its snapshots,
json-null-sentinel-sql 30, request-result-shape-contracts 29, geopoint-sql 20,
lateral-joins 18, batch-attribution-hazard-signature 17, write/parse-boundary-gate
6, write/architecture-gates 6, drivers/namespace-execution-target 5,
operation-equivalence-oracles 3 — 568 registered cells). Seven deleted-engine
pins were removed from suites that outlived it (namespace-qualification 2,
provider-result-contracts 1, bulk-create-plan 1, operation-program-read-contracts
1, the two g4-unit01-review distance-alias cells). Nothing was re-pinned.

Harness, per D-11: no differential mode was retired and no registered cell was
lost. The ten G0/G1/G2 lanes and both support checks are green at their full
counts, because each two-sided arm was removed under the one-sided rule and
every surviving assertion is verbatim: the S2 and G1-upsert admission ledgers
and the G2 generated transitions state one evaluation per admitted input on
every arm, the key-update transport script states the engine's own statement
plan once, and the live unique-race expects one attempt. The two adjudicators
that existed only to translate the deleted engine's answers are retired.
Earlier, C-01 retired the six two-sided modes g4-route-lifecycle,
g4-route-admission, g4-route-cache, g4-route-transactions, g4-lifecycle-events
and g4-lifecycle-admission plus 21 reviewer probes; five g4-unit02-author files
were re-expressed one-sided (136 -> 130 cells) and 31 cell titles were corrected.
g4-unit01-review moves 200 -> 198.

Also restored, because the cutover took them as collateral: six libsql provider
contracts (batch-primary-key-dataflow, client-raw, scalar-roundtrip,
full-scalar-roundtrip, decimal-exactness, upsert-atomicity) and two pg ones
(batch-primary-key-dataflow, create-many-return-fold); and the query-engine
layer's type core, now stating the single-statement publication surface.

Whole-cost: charged production 53,890 -> 31,664 token-LOC (0.635 of the frozen
baseline, target 0.60), 71,146 -> 42,335 physical LOC (0.651, target 0.70);
src/**/*.ts 581 -> 549 files. Bundles: the engine fixture now contains the
engine (gzip 0.5893 of baseline, target 0.75) and both public PostgreSQL
fixtures are 0.7006 / 0.7008 (target 1.00). All four G4 campaign corpora are
byte-identical to the attempt-6 archives.

Decisions: D-8 (one evaluation per admitted input), D-9 (the remaining
preparation cost is accepted), D-10 (the cutover is performed locally, nothing
pushed, no database changed), D-11 (the differential modes), D-12 (dispose of
every newly red core-lane file; commit 4 only when the core lane is back to the
base's five red files or better), D-13 (the two deleted dirty pattern files are
accepted and their preimages committed under
docs/architecture/raptor3-evidence/g4/cutover-execution/receipts/preserved-unrelated-dirty/),
D-14 (the single-statement publication above).

KNOWN RED: the core gate (pnpm test:core, --project='layer-*') is 6 failed
files / 11 failed tests against 5 / 42 on the base. Failed tests are far under
the base; failed FILES are one over, and the reason is recorded rather than
repaired. One of the six (contract-matrix) is red on the base too. The other
five carry eight public-client cells that behave identically on 5a37bcd7 with
the pre-cutover candidate route -- unrecorded compatibility differences of the
candidate, not cutover defects, bisected cell by cell in
docs/architecture/raptor3-evidence/g4/cutover-execution/note.md R3.2: an upsert
error class, an empty-createMany refusal that is gone, a cache hostile-JSON
count, three array-interceptor orderings and two write-outcome certainties.
They need Arnaud's decision, not a repair.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

---

# Round 4 — the missing lanes run and bisected, the class-A suites restored cell by cell

Round 4 applies the integrator's decisions of 2026-09-17 01:00 (ledger), taken
under the recorded rules while Arnaud is asleep, against
[`cutover-execution-review-round3.md`](../cutover-execution-review-round3.md).
Base is unchanged (`5a37bcd7`); nothing was committed, staged, reset or stashed;
`CONTEXT.md`, `memory.md`, `exa-results/`, the root corpora and the pre-G4
evidence were not touched; Biome `--write` was never run on a whole file; the
workspace lock was waited on, never removed. New receipts are under
[`receipts/round4/`](receipts/round4/).

**Identity after the last edit** ([receipt](receipts/round4/identity-after.json)):

| | production | harness |
| --- | --- | --- |
| round 3 | `50c0ee97fb1458333c818735da4c92b7bca89daa65929199c00ef551533b7a63` | `ce8436e6122b50e738c4d40ced64a6057d7bdf61c0ecb813b7b339afa82048ea` |
| **round 4** | **`50c0ee97fb1458333c818735da4c92b7bca89daa65929199c00ef551533b7a63`** | **`02f0489ce79b9dc47903e1119603a87e478a911c68ae890e37dc93b54483ebb0`** |

**Production is byte-identical to round 3.** Round 4 changed no production file:
every edit is in `tests/` and `scripts/`. The build, the three bundle fixtures
and the cost census therefore stand unchanged from R3.7 and were not re-measured
(recorded as an unverified claim in R4.9).

## R4.1 The four missing lanes, run

Every command ran from `/Users/arnaud/code/viborm` on the pinned runtime,
serially, under the existing workspace lock. The Docker lanes used the two
running G3 containers, `docker port viborm-raptor3-g3-pg-20260914 5432` →
`127.0.0.1:55729` and `docker port viborm-raptor3-g3-mysql-20260914 3306` →
`127.0.0.1:55730`, with `PG_TEST_CONNECTION_STRING=postgresql://postgres@127.0.0.1:55729/raptor3_g2`,
`MYSQL_TEST_CONNECTION_STRING=mysql://root@127.0.0.1:55730/raptor3_g2` and
`VIBORM_RAPTOR3_PROVIDER_PORT` set to the same port (both containers are
passwordless and own the `raptor3_g2` database; the suites drop and recreate
their own tables).

| Lane | base `5a37bcd7` | base + candidate route | **cutover tree** |
| --- | --- | --- | --- |
| `--project=provider-sqlite3 --project=provider-libsql` | **0 failed** / 1,253 passed, 10 files ([receipt](receipts/round4/provider-local-BASE-legacy.log)) | 71 failed / 1,182 passed, 7 red files ([receipt](receipts/round4/provider-local-BASE-candidate.log)) | **61 failed** / 703 passed, **5 red files** ([receipt](receipts/round4/provider-local-cutover.log)) |
| `provider-pg` → `pg-nested-write-races.test.ts` | **0 failed** / 77 passed ([receipt](receipts/round4/pg-nested-write-races-BASE-legacy.log)) | 8 failed / 69 passed ([receipt](receipts/round4/pg-nested-write-races-BASE-candidate.log)) | **13 failed** / 82 passed of 95 ([receipt](receipts/round4/pg-nested-write-races-cutover.log)) |
| `provider-mysql2` → `mysql2.test.ts` | 4 failed / 80 passed (pre-existing `MySQL namespace containment`) ([receipt](receipts/round4/mysql2-BASE-legacy.log)) | 12 failed / 72 passed ([receipt](receipts/round4/mysql2-BASE-candidate.log)) | **13 failed** / 71 passed of 85 ([receipt](receipts/round4/mysql2-cutover.log)) |
| `provider-mysql2` → `mysql2.test.ts`, **build-oracle base** (see R4.3) | — | **13 failed** / 71 passed, failing set **identical to the cutover tree's** ([receipt](receipts/round4/mysql2-BASE-candidate-buildoracle.log)) | **13 failed** / 71 passed |
| `provider-pg` → `pg-write-update.test.ts` (the file C-01 deletes) | 167 / 167 green (round-3 review receipt) | 19 failed / 148 passed, **including all five `batchPrimaryKeyDataflowContract` cells** ([receipt](receipts/round4/pg-write-update-BASE-candidate.log)) | file deleted |

Every count reproduces the round-3 reviewer's figures exactly, and the failing
**sets** are identical file by file (`diff` of the sorted `FAIL` lines against
`cutover-execution-review-round3-receipts/`: no difference for the mysql lane,
none for the pg lane).

`node scripts/run-credential-free-tests.mjs --only "raptor3-provider:"` was
already green in round 3 and is a different lane from these two vitest projects;
the reviewer's finding was about `provider-sqlite3` / `provider-libsql`, which
are stages of `pnpm test:all` and had never been run by this unit.

## R4.2 CLASSIFICATION of every new red — the bisection this unit owns

Method, as in R3.2: `git archive 5a37bcd7` into a scratch tree outside the
repository, two lines making `VibORM.create`'s `route` parameter default to
`createCandidateRoute` (byte-identical to
[`base-tree-route-default.diff`](receipts/round3/classd-bisect/base-tree-route-default.diff)),
then the same lane. **Every red that reproduces there is an unrecorded
compatibility difference of the candidate, not a cutover defect: it is neither
repaired nor deleted.**

- **All 61** credential-free provider reds reproduce on the base with the
  candidate route — the failing cell sets are **identical** (`comm` of the
  sorted names: zero one-sided entries in the cutover direction). The extra 10
  there are in `sqlite3-write-engine-linearization.test.ts` and
  `sqlite3-write-engine-mutations.test.ts`, two suites the cutover deletes.
- **8 of the 13** pg reds reproduce there. The other five are the restored
  `batchPrimaryKeyDataflowContract` registration (R4.4).
- **8 of the 13** mysql reds reproduce there; four of the remaining five are the
  base's own pre-existing `MySQL namespace containment` failures. The ninth new
  one is the `QueryEngine.build`-oracle cell, settled in R4.3.
- **0 cutover defects.** No red in any of the four lanes fails only because of
  the cutover diff.

**The families, with their cell counts and their exact observable.** 78 provider
cells plus the two changed-refusal cells of family 17, on top of the eight
public-client cells already bisected in R3.2 — **88 unrecorded compatibility
differences in total**. The arithmetic against the base, lane by lane: 10 new
core-lane cells (11 red minus `contract-matrix`, which is red at the base too),
61 credential-free provider cells, 13 pg cells and 9 new mysql cells (13 minus
the base's four pre-existing `MySQL namespace containment` failures) = **93 red
cells beyond the base, in 12 files, 11 of them newly red** — of which 88 are
compatibility differences and the remaining 5 are the restored pg registration
of R4.4, which records an engine limitation rather than a difference.

| # | Family | cells | Observable |
| ---: | --- | ---: | --- |
| 1 | A nested object value is parsed as an update-operator bag | **9** | `QueryEngineError: Unknown update operation: z` / `m` / `s` / `label` / `longitude, latitude` where the shipped engine stored the document; and `expected { z: 1 } to deeply equal { set: { z: 1 }, increment: 4 }`. 7 SQLite (`sqlite3-nested-write`, delegated JSON write envelope) + 2 MySQL (`mysql2`, GeoPoint round-trip and array/callback transactions) |
| 2 | Relation-filtered `updateMany` / `deleteMany` affect the wrong row set | **18** | `expected +0 to be 1`, `expected 3 to be 2`, `expected 3 to be 1`; `NotFoundError: No employee record found for update`; `promise resolved "{ id: 'e1', name: 'boss', … }" instead of rejecting` (`sqlite3-returning-json`, relation-filter mutation behavior: some/every/none, combined operators, self-relations) |
| 3 | JSON string and array path filters | **8** | `expected [] to deeply equal [ 'dark' ]`; `expected [ 'light' ] to deeply equal [ 'dark', 'light' ]`; `promise resolved "[]" instead of rejecting`; and a changed refusal — `expected … to throw error including 'portable JSON path' but got 'SQLite JSON path segments containing …'` |
| 4 | JSON null-sentinel refusal | **1** | `promise resolved "[ 'doc', 'js', 'nest' ]" instead of rejecting` — an inert mode beside a sentinel `not` is no longer refused |
| 5 | A nested-write dependency refusal is raised where the shipped engine executed | **5** | `NestedWriteError: Nested operation 'updateMany' / 'deleteMany' / 'connectOrCreate' on relation '…' depends on an earlier '…' target write in the same nested write. Split these operations into separate queries.` (3 SQLite + 2 PostgreSQL) |
| 6 | Nested default-only duplicate skipping is not refused | **2** | `promise resolved "{ id: 'default-only-parent' }" instead of rejecting` (1 SQLite + 1 PostgreSQL) |
| 7 | Self-referential many-to-many round trip | **1** | `expected [] to deeply equal [ 'u1' ]` |
| 8 | Prisma-parity refusals for empty select and non-grouped `groupBy`/`having` | **5** | `expected [Function] to throw error matching /needs at least one truthy value/ but got 'Query execution failed'`; `promise resolved "[ { authorId: 'u1' }, …(1) ]" instead of rejecting` |
| 9 | Polymorphic collection reads, writes and relations | **9** | `Error: Raptor 3 G1 physical field is not implemented: type`; orphaned and duplicate memberships resolve instead of refusing (`promise resolved "{ id: 1, name: 'main', …(1) }" instead of rejecting`); `expected [ 't1/left/eu/111' ] to deeply equal [ 't1/right/eu/111' ]`. 4 SQLite + 5 MySQL |
| 10 | Ordering query plan and cursor paging over duplicate sort keys | **2** | `expected 'SEARCH q0 USING INDEX order_plan_rows…' to contain 'SEARCH t0 USING INDEX order_plan_rows…'` (the alias moved) and `expected +0 to be 5` |
| 11 | Decimal exactness and scalar round-trip decoding | **7** | `QueryEngineError: Driver "sqlite3" returned a malformed decimal scalar for operation "aggregate" / "groupBy" / "findUnique"`; `expected 42n to deeply equal 42`; `SyntaxError: Unexpected token 'j', "just a json string" is not valid JSON`; `QueryError: Query execution failed` on a scalar-subquery field reference |
| 12 | Read-path regressions: `groupBy` `by`, empty default projections, `_count: true` | **4** | `TypeError: by.map is not a function`; `QueryError: Query execution failed` (×2, empty default projections); `expected [ { id: 'p1', _count: {} } ] to deeply equal [ { id: 'p1' } ]` |
| 13 | Live upsert / nested `connectOrCreate` concurrency (PostgreSQL) | **4** | `UniqueConstraintError: Unique constraint violation` where the shipped engine converged to one row |
| 14 | Filtered m2m `deleteMany` staleness retry (PostgreSQL) | **1** | `AssertionError: expected 0 to be greater than or equal to 1` — the guard does not abort and the retry never converges |
| 15 | MySQL GeoPoint predicates are not sargable on the spatial index | **1** | `expected { table_name: 'q0', …(7) } to match object { access_type: 'range', …(1) }` — `access_type` is `ALL`, `geopoint_plan_places_location_idx` unused |
| 16 | MySQL batch-only non-returning refusal | **1** | `expected [Function] to throw error including 'cannot execute non-returning upsert w…'` — nothing was thrown |
| 17 | A registered refusal's wording changed | **2** | `Driver '<name>' supports neither transactions nor atomic batch execution.` is now spelled `Driver "<name>" …` by `src/drivers/driver-transaction-base.ts:790`/`:979`. The two `select-mode-capability-matrix` core-lane cells (`'create'`, `'update'`) are exactly this text; already counted inside the core lane's 11 |

| 18 | Read-path admission refusals no longer raised (integrator addition from the round-4 re-check, finding 1; cells deleted with `sql-generation.core.test.ts`) | **11** | `expect(() => …).toThrow(<sentence>)` on `findMany`/`groupBy` — nothing is thrown: non-portable JSON string paths ×6 (`status`, `$.`, `$.*`, `$[last]`, `$[0`, `$status`), non-portable escaping, a JSON filter with only a path, an EMPTY scalar filter (`where: { name: {} }`), an EMPTY relation filter, a `groupBy` `having` field outside `by`. Measured through the public client: `findMany({ where: { name: {} } })` resolves every row; **`updateMany`/`deleteMany({ where: { name: {} } })` answer `{ count: <all> }` — every row updated, then every row deleted** where the base refused with `Filter for field 'name' must contain at least one operation.` |
| 19 | Fail-closed result contracts no longer enforced (cells deleted with `request-result-shape-contracts.core.test.ts`) | **13** | the requested projection is not enforced on direct execution (resolves instead of rejecting); relation-count rows with a missing carrier / missing or extra inner relation / primitive carrier, unrequested private carriers, nested include shapes, duplicate `groupBy` fields ×2, unrequested uniformly-missing scalar columns — all `expected error to be instance of QueryEngineError`; two now leak a raw `TypeError` (`Invalid provider integer`, `by.map is not a function`); the simultaneous scalar + computed `_distance` refusal changed sentence |
| 20 | Vector-distance cursor ordering refusal replaced by a crash (cells deleted with `cursor-pagination-sql.core.test.ts`, one per dialect) | **3** | `Cursor pagination supports direct scalar …` is replaced by `TypeError: vector.orderBy is not a function` |
| 21 | Short provider result window no longer fails closed (cell removed from the surviving `bulk-create-plan.core.test.ts` in round 3) | **1** | a truncated provider result window reports a count instead of raising |

Families 18–21 were carried only by cells this commit deletes; deleting the
witness does not make the difference smaller. Every probed cell reproduces on
`5a37bcd7` with the candidate route (round-4 re-check probe
`round4-deleted-refusals.review.test.ts`: green on the cutover tree, red on
the base, green on base + candidate route). Family 18's bulk-mutation row is
the one to put in front of Arnaud first.

Families 1, 2, 3, 5, 6 and 13 are the ones a user would notice first: a JSON
document whose keys spell update operators is refused rather than stored; a
relation-filtered bulk mutation touches a different row set; two nested
operations that the shipped engine executed are now refused with a "split these
operations" sentence; concurrent upserts of the same missing key no longer
converge. **None of them is repaired here and none is deleted; they are Arnaud's
decision.**

## R4.3 The bisection's blind spot, closed with a receipt

The round-3 review is right that a bisection which only defaults
`VibORM.create`'s route cannot see a cell whose oracle is `QueryEngine.build()`
or `PendingOperation.buildStatement()`: on the base a bare engine has no route,
so `build()` answers the **deleted** engine's lowering. One cell in the four
lanes has that oracle — `mysql2.test.ts:203-242`,
`uses the GeoPoint spatial index only for positive indexable predicates`, which
EXPLAINs `new QueryEngine(driver, registry).build(place, "findMany", …)`.

So round 4 built a **second** scratch base: `5a37bcd7` + the candidate-route
default **plus D-14's publication hunks**, so that `buildStatement()` answers the
candidate's `Sql` while the shipped engine is still present. Exactly six edits,
all additive, none deleting a shipped owner:

- `raptor3/commands/index.ts`, `raptor3/shared/schema.ts`,
  `raptor3/shared/operation-context.ts` — copied from the cutover tree (their
  whole diff against the base is D-14's additive publication: +36/−0, +10/−1 and
  the `publish`/`publishPrepared`/`decideRead` extraction).
- `raptor3/route/client-route.ts` — `buildStatement(): Sql | undefined` added to
  the interface and to the returned object (`prepared.read?.statement`);
  `createCandidateClient` left in place, because the base still exports it.
- `query-engine.ts` — `provisionedRoute(driver, registry)` and
  `this.route = route ?? provisionedRoute(driver, registry)`, verbatim from the
  cutover tree; the shipped executors untouched.
- `pending-operation.ts` — one line: `buildStatement()`'s route arm returns
  `this.#resolveRouted().buildStatement()` instead of `undefined`.

On that tree the mysql lane is **13 failed / 71 passed, and the failing set is
byte-identical to the cutover tree's** (`diff` of the sorted `FAIL` lines: no
difference), with the same observable for the spatial cell
(`"access_type": "ALL"` where `"range"` was expected). **The ninth mysql red is
therefore a compatibility difference of the candidate too** (family 15), not a
cutover defect. The reviewer's stated limitation is closed for every cell in
these four lanes: the one cell it applied to has been measured against a base
whose `buildStatement` answers the candidate's SQL.

Limitation that remains, stated per the brief: the 61 credential-free reds and
the 8+8 Docker reds were bisected against the **route-default** base only. That
is sound for them because none has `build()`/`buildStatement()` as its oracle —
they all reach the engine through `createClient` and a driver — and the proof is
that all of them reproduce there with identical failing sets.

## R4.4 The restored pg `batchPrimaryKeyDataflowContract` registration — kept, registered, and RED

R3.4 re-registered `batchPrimaryKeyDataflowContract` and
`createManyReturnFoldContract` onto `tests/providers/docker/pg-nested-write-races.test.ts`
because the cutover deleted the files that held them. **Five of those cells
fail**, each with

```
Error: Raptor 3 G1 atomic output requires exact identity scratch or segmented RETURNING
    at src/query-engine/raptor3/shared/operation-context.ts:1837
```

The registration is **kept registered and kept red**: it documents an engine
limitation, and withdrawing it would hide the limitation rather than record it.
The evidence that the registration is not what makes them red: the same five
cells fail on the **base** with the candidate route inside
`tests/providers/docker/pg-write-update.test.ts`, the file that held the contract
before C-01 (19 failed / 148 passed there,
[receipt](receipts/round4/pg-write-update-BASE-candidate.log)). At the base with
the shipped engine that file is 167/167 green. `createManyReturnFoldContract`
is green on the cutover tree.

## R4.5 CLASS-A — the fifteen deleted suites, restored and pruned cell by cell

The rule is the one already used on the four surviving suites (§1.4 / R3.4):
**restore the file from `5a37bcd7` and delete only the cells that are red against
the new engine. Measured split of the 240 (round-4 re-check, finding 1): 129 statement/shape text pins of the deleted engine, 28 cells that hit D-14's disclosed write refusal, 4 source-text gates over deleted files, and at least 27 registered refusals or fail-closed contracts the candidate no longer raises (R4.2 families 18–21; a further 8 are the D-14 write refusal masking an older one), so the last group is a set of compatibility differences that the deletion of its witnesses does not make smaller — keeping every cell that passes.** Where a file has no surviving
cell it stays deleted.

Measured first, then cut: all fourteen deleted `.test.ts` files were restored and
run on the cutover tree
([receipt](receipts/round4/classA-restored-run1.log), JSON reporter). **The red
count of every single file equals R3.4's table exactly** — independent
confirmation of that table, and of the round-3 reviewer's spot check of three of
them.

| # | File | cells | red (deleted) | **green (kept)** | Disposition |
| ---: | --- | ---: | ---: | ---: | --- |
| 1 | `tests/contracts/engine/query/sql-generation.core.test.ts` | 147 | 56 | **91** | restored, pruned (2,582 → 1,775 lines) |
| 2 | `tests/contracts/engine/query/field-reference-sql.core.test.ts` | 89 | 40 | **49** | restored, pruned (740 → 516) |
| 3 | `tests/contracts/engine/query/operand-callback-sql.core.test.ts` | 74 | 12 | **62** | restored, pruned (857 → 783) |
| 4 | `tests/contracts/engine/query/decimal-having-operand-sql.core.test.ts` | 48 | 6 | **42** | restored, pruned (435 → 410) |
| 5 | `tests/contracts/engine/query/cursor-pagination-sql.core.test.ts` | 44 | 30 | **14** | restored, pruned (454 → 202) |
| 6 | `tests/contracts/engine/query/read-traversal-byte-pins.core.test.ts` | 32 | 32 | **0** | **stays deleted** — every cell is a byte snapshot of the deleted engine's text |
| 7 | `tests/contracts/engine/query/json-null-sentinel-sql.core.test.ts` | 30 | 9 | **21** | restored, pruned (221 → 200) |
| 8 | `tests/contracts/engine/query/request-result-shape-contracts.core.test.ts` | 29 | 18 | **11** | restored, pruned (789 → 385) |
| 9 | `tests/contracts/engine/query/geopoint-sql.core.test.ts` | 20 | 6 | **14** | restored, pruned (726 → 553) |
| 10 | `tests/contracts/engine/query/lateral-joins.core.test.ts` | 18 | 7 | **11** | restored, pruned (302 → 184) |
| 11 | `tests/contracts/engine/query/batch-attribution-hazard-signature.core.test.ts` | 17 | 12 | **5** | restored, pruned (344 → 264) |
| 12 | `tests/contracts/engine/write/parse-boundary-gate.core.test.ts` | 6 | 3 | **3** | restored, pruned (204 → 153) |
| 13 | `tests/contracts/engine/write/architecture-gates.core.test.ts` | 6 | 1 | **5** | restored, pruned (257 → 232) |
| 14 | `tests/contracts/drivers/namespace-execution-target.core.test.ts` | 5 | 5 | **0** | **stays deleted** — its oracle is `QueryEngine.build(…, "createMany", …)`, which legitimately compiles to no single statement |
| 15 | `tests/contracts/engine/query/operation-equivalence-oracles.core.test.ts` | 3 | 3 | **0** | **stays deleted** — frozen SQL+params oracles of the deleted engine |
| 16 | `…/__snapshots__/read-traversal-byte-pins.core.test.ts.snap` | — | — | — | **stays deleted** with #6 |
| | **total** | **568** | **240** | **328** | **12 files restored, 3 + 1 snapshot stay deleted** |

**328, not 327.** The round-3 review computed the green count as 568 − 241; the
red column of R3.4 sums to **240**, and the measured run agrees per file. The
corrected split is **240 deleted / 328 kept**.

All twelve restored files are **green at exactly their kept-cell counts**
([receipt](receipts/round4/classA-restored-run3.log)): 91, 62, 49, 14, 42, 11, 5,
14, 21, 11, 3, 5 = **328 / 328 passing**.

What "delete only the red cells" meant per file, so a reviewer can re-derive it:
whole `describe.each`/`test.each` blocks where every dialect arm was red
(`batch-attribution-hazard-signature`'s hazard-signature block, `geopoint-sql`'s
write-lowering block, `field-reference-sql`'s collation-and-folding and enum
describes, `lateral-joins`' two "lateral joins enabled" describes,
`sql-generation`'s dialect relation-filter-mutation describe), and individual
`test(...)` bodies elsewhere. Four `describe`s that lost every cell were removed
with them (`sql-generation`: `create`, `update`, `nested selects (2-3 levels
deep)`, `select with manyToMany relation`). Fixtures, regexes and helpers that no
surviving cell referenced were removed with the cells they served — they are not
cells and leaving them would have added `noUnusedVariables` /
`noUnusedImports` diagnostics the base does not have (R4.8). Three docblocks
that described a removed cell were corrected rather than left false
(`parse-boundary-gate`'s numbered invariants, `sql-generation`'s delete-fold
comment, `distance-parity`'s header).

**Manifests and workspace.** The twelve restored files are back in
`scripts/query-engine-test-manifest.mjs` (`QUERY_ENGINE_CORE_TESTS` +10,
`WRITE_ENGINE_CORE_TESTS` +2) **at the base's own relative order** (verified
programmatically: the base list filtered to the surviving entries equals the
current list, element for element, so no coverage group was silently
re-partitioned). `namespace-execution-target.core.test.ts` stays out of
`scripts/driver-test-manifest.mjs`'s `providerHeavyCoreContracts` and out of
`scripts/coverage-policy.test.mjs`; `operation-equivalence-oracles` stays out of
`QUERY_ENGINE_CORE_TESTS`. `vitest.workspace.ts` needed no change:
`DRIVER_CORE_TESTS` is read from disk and every restored file is admitted by an
existing project.

**The two orphaned behaviour modules are deleted.**
`tests/contracts/engine/write/extended-where-unique-behavior.ts` (1,493 lines)
and `tests/contracts/engine/write/to-one-update-where-behavior.ts` (1,037 lines)
had **zero importers** after C-01 deleted all five registrations of each; the
only remaining mention of the first is a documentation `sources:` string in
`tests/raptor3/expanded/unique-filter-identity.ts`, which is provenance, not an
import. Re-registering them would have added a suite of which the `extended
whereUnique` family is known red under the candidate (14 of the 19
`pg-write-update` reds) — that is a compatibility decision, not a repair, so the
files go and the contract is recorded in R4.2 instead.

## R4.6 The three dropped one-sided halves, re-expressed

> Integrator correction (round-4 re-check, finding 2): the round-3 review's three files were operation-program-read-contracts, namespace-qualification and distance-parity. This section re-expressed the first two and provider-result-contracts (round-3 finding 4's file). distance-parity stays at 7 of 9 cells; its second cell's three `mine` assertions are a recorded coverage loss.


Verbatim assertions only; no shipped answer transcribed into a new literal, no
literal truncated. The reviewer's probe
(`d14-publication.review.test.ts`, cell 9) is the model.

| File | Cell | What it now asserts |
| --- | --- | --- |
| `tests/contracts/engine/query/operation-program-read-contracts.core.test.ts` (1 → **2** cells) | `preserves public result shapes on the direct runtime path, for the arms that carry no private result key` | The base's `findMany { take: -2 }` reversal, `findFirst`, `findUnique` → `null` and `expect(driver.transactionCount).toBe(0)`, all four unchanged. The four arms whose oracle was `COUNT_RESULT_KEY` / `getAggregateResultKey` are gone, and with them `executionCount === 8`, which counted all eight arms |
| `tests/contracts/engine/query/namespace-qualification.core.test.ts` (120 → **122** cells) | `a .map() name is never flattened into the namespace` | The base's two negative assertions verbatim: `not.toContain('"billing_ns_users"')` and `not.toContain('"ns_users"."')`. The positive half quoted the deleted engine's alias letter (`AS "t0"`) |
| same file | `both cursor spellings keep the derived cursor row bare` › `neither branch qualifies a statement-local derived cursor row` | The base's `expect(sargable).not.toContain("__viborm_cursor_0")` and `expect(lexicographic).not.toContain('"billing"."__viborm_cursor_0"')`, unchanged. The two `toContain` assertions quoted the deleted engine's aliases and its derived-row spelling |
| `tests/contracts/drivers/provider-result-contracts.core.test.ts` (114 → **115** cells) | `PlanetScale preview decodes a GeoPoint projection through its SDK formatter` | The base's `await expect(driver._execute(query)).resolves.toMatchObject({ rows: [{ location: locationText }] })`, unchanged, with the same fixture. The removed half was the whole shipped `SELECT JSON_OBJECT('longitude', ST_Longitude(…)) … AS \`t0\` …` text |

All three suites are green at their **base** cell counts again (115 / 122 / 2,
[receipt](receipts/round4/core-round4.log)).

## R4.7 The misnamed cells, the helper, and the retired adjudicator's literal

**Renamed, following R2.3's pattern** ("the client route seam" against "the
command engine"; `differential()` builds `createClient(...)` on one side and
`world.engine.execute` on the other):

| File | Old title | New title |
| --- | --- | --- |
| `tests/raptor3/g4/unit01/repair2.test.ts:49` (×6 forms) | `answers ${label} the way the shipped engine does` | `answers ${label} identically on the client route seam and the command engine` |
| `tests/raptor3/g4/unit01/repair3.test.ts:88` | `words the cursor refusal for ${label} the way the shipped engine does` | `… identically on the client route seam and the command engine` |
| `tests/raptor3/g4/unit01/repair3.test.ts:131` | `words the path + ${label} refusal the way the shipped engine does` | `… identically on the client route seam and the command engine` |
| `tests/raptor3/g4/unit01/repairs.test.ts:124` | `orders a grouped read the way the shipped engine orders it` | `orders a grouped read identically on the client route seam and the command engine` |

**`distance-parity.test.ts`**: the helper `shippedStatement()` — since D-14 it is
`new QueryEngine(driver, registry).build(...)`, i.e. the **provisioned route** —
is renamed `routedStatement()`, with `shippedMessage` → `routedMessage`, the
local `const shipped` → `routed`, the assertion message `"the shipped engine must
refuse"` → `"the routed seam must refuse"`, and the file header restated. Its six
titles that claimed a shipped engine are renamed to "on both seams" / "across the
routed seam and the query layer". `g4-unit01-review` is **198 / 198 green**, the
registered count unchanged ([receipt](receipts/round4/modes/g4-unit01-review.log));
`g4-unit01-author` is **83 / 83** ([receipt](receipts/round4/modes/g4-unit01-author.log)).

**The retired adjudicator's progress literal is restated one-sided**, in the
`s2-changed-dependency` fixture's own `assert` in
`tests/raptor3/scenarios/contracts/instances.ts`. `verifyChangedDependencyCommandsProgress`
carried `{atomicity: "segment", phase: "planning", committedSegments: 1,
committedWriteMembers: 1, completedMembers: 0, memberPath: [1], totalMembers: 2}`
and ran at one profile only (`sqlite-atomic-batch`; the interactive profile
publishes no segment progress — measured, the first attempt failed there). The
restatement pins the five common fields unconditionally at that profile and the
located pair (`memberPath`, `totalMembers`) for the engines that publish them —
the program engine publishes the same segment record without them, which is
exactly the difference `verifyProgramEnginePair` strips, and that is the guard's
whole and nameable coverage. `g0` is **33 / 33** and `g1-compare` **66 / 66**
([receipts](receipts/round4/modes/)).

## R4.8 Verification

| Check | Result | Receipt |
| --- | --- | --- |
| `node scripts/run-typecheck.mjs` | **exactly the two permitted `pattern/pack.ts` TS2345** at `:1443` and `:2633` | [`typecheck-final.txt`](receipts/round4/typecheck-final.txt) |
| core lane `--project='layer-*'` | **6 failed files / 11 failed tests** of **464 files / 9,301 tests** (round 3: 6 / 11 of 452 / 8,969; base: 5 / 42 of 532 / 11,292) | [`core-round4.log`](receipts/round4/core-round4.log) |
| `run-raptor3 g0` | 33 / 33 | [`modes/g0.log`](receipts/round4/modes/g0.log) |
| `run-raptor3 g1-compare` | 66 / 66 | [`modes/g1-compare.log`](receipts/round4/modes/g1-compare.log) |
| `run-raptor3 g1-baseline` | 141 / 141 | [`modes/g1-baseline.log`](receipts/round4/modes/g1-baseline.log) |
| `run-raptor3 g1-contracts` | 143 / 143 | [`modes/g1-contracts.log`](receipts/round4/modes/g1-contracts.log) |
| `run-raptor3 g4-unit01-author` | 10 files / 83 tests | [`modes/g4-unit01-author.log`](receipts/round4/modes/g4-unit01-author.log) |
| `run-raptor3 g4-unit01-review` | 29 files / 198 tests | [`modes/g4-unit01-review.log`](receipts/round4/modes/g4-unit01-review.log) |
| credential-free `--only "Raptor 3 fixed"` | **65 files / 758 tests green** | [`credential-free-fixed.log`](receipts/round4/credential-free-fixed.log) |
| `pnpm test:coverage:policy` | **11 / 11, 16 / 16, 6 / 6**, exit 0 | [`coverage-policy.log`](receipts/round4/coverage-policy.log) |
| `scripts/raptor3-campaign-receipts.test.mjs` | **39 / 39** | [`receipts-selftest.log`](receipts/round4/receipts-selftest.log) |
| `core-taxonomy-census.core.test.ts` | **4 / 4** | [`core-taxonomy-census.log`](receipts/round4/core-taxonomy-census.log) |
| structure census | exit 0; `src/query-engine` 149 files, 58,206 lines, 46,543 token lines, 2,816 functions, 6,854 branch nodes, 2 cycles over 14 files — **identical to round 3** | [`census-after.txt`](receipts/round4/census-after.txt) |
| `captureRaptor3Identity` after the last edit | production `50c0ee97…` **unchanged**, harness `02f0489c…` | [`identity-after.json`](receipts/round4/identity-after.json) |

The six red core-lane files are the same six as round 3, cell for cell:
`contract-matrix` (1, red at the base too), `select-mode-capability-matrix` (3),
`query-interceptors-array` (3), `query-interceptors-integration` (2),
`official-cache-swr` (1), `bulk-insert-row-shapes` (1). **The twelve restored
suites added 328 green tests and no red one.**

**Formatting.** `npx biome check --max-diagnostics=500` over the 23 files round 4
touched reports **33 errors**; the same 23 files at `5a37bcd7` report **45**
([receipt](receipts/round4/biome-after.txt)). Per rule: `useTopLevelRegex` 15
(base 23), `noMisplacedAssertion` 13 (base 17), `format` 4 (base 4 — the same
four files), `organizeImports` 1 (base 1 — the same file). **No diagnostic class
appears that the base does not have, and no new diagnostic in any class.** Three
that the first cut did introduce — 26 `noUnusedVariables`, 7 `noUnusedImports`
and one `format` in `instances.ts` — were removed by hand, by deleting the dead
fixtures and imports and re-wrapping one expression. Biome `--write` was never
run on a whole file.

**The patch.** [`cutover.patch`](cutover.patch) is
`git diff --binary 5a37bcd7 -- src scripts tests vitest.workspace.ts` plus the
two untracked files the cutover adds (`src/query-engine/routed-operations.ts`,
`tests/types/query-engine/single-statement-publication.core.types.ts`) as
`new file mode` entries: **307 entries**. Verified, not asserted: applied with
`git apply --binary` to a pristine `git archive 5a37bcd7`, then `diff -r` of
`src/`, `tests/`, `scripts/` and `vitest.workspace.ts` against the live tree —
**no difference**, the only extra paths being three untracked directories the
patch deliberately excludes (the reviewer's `tests/raptor3/g4/review/cutover/`
probes, `tests/raptor3/generated/` corpora, and an empty `__snapshots__/`).
`CONTEXT.md`, `memory.md` and the evidence tree are excluded, as in round 3.

## R4.9 Round 4's unverified claims

- Integrator addition (round-4 re-check, note 3): the run-1 receipt (`receipts/round4/classA-restored-run1.json`) holds 15 files / 540 cells / 208 red — it includes `result-parser-architecture-gates.core.test.ts` (4 cells, 0 red), which R4.5's table does not, and omits `read-traversal-byte-pins.core.test.ts` (32 cells, 32 red), whose reds are round 3's measurement; R4.5's 15 / 568 / 240 and INDEX.txt's 536 / 208 / 328 reconcile on that basis.


- **The build, the three bundle fixtures and the cost census were not re-run.**
  They are unchanged by construction — `captureRaptor3Identity().production` is
  byte-equal to round 3's `50c0ee97…` and no file under `src/` differs — but that
  is an inference from the fingerprint, not a fresh measurement.
- **The four G4 campaign corpora were not re-generated.** Round 4 changed no
  production file and none of `tests/raptor3/g4/generation/**`; the corpora embed
  `identity.harness`, which has changed, so a re-run would differ in that field
  and nowhere else. Not measured.
- Each provider lane is a **single** run per tree, except the two Docker lanes on
  the cutover tree, whose failing sets were also compared cell for cell against
  the round-3 reviewer's independent runs and matched exactly.
- The class-A red/green split is a **measured** per-cell run (JSON reporter) on
  the cutover tree, not a reading. The claim that each deleted cell is an
  old-engine pin rather than a candidate defect is a reading of the cell, not a
  second bisection: these suites' oracles are `QueryEngine.build()` SQL text, and
  a base whose `build()` answers the candidate (R4.3) would make them red for the
  same reason.
- The mysql lane rewrites the `raptor3_g2` database (the suites drop and recreate
  their own tables). `g4-unit02-pg-contracts` and `g4-unit02-mysql-contracts`
  were **not** re-run after round 4's Docker runs; round 3's reviewer re-ran them
  green after the same sequence.
- The 45 → 33 Biome comparison uses the base file set restored into a scratch
  tree, not the repository.
- The eight root `transport-*-corpus.json` files were confirmed untouched by
  mtime, not by hash.

## R4.10 Commit-message draft for commit 4 (replaces R3.10)

```
feat(raptor3): cut over to the Raptor 3 engine (C-01)

The candidate becomes the only operation owner. VibORM's constructor builds
createCandidateRoute(...) for every client and bind() forwards it, VibORM.create
loses its non-public `route` parameter (G4-03; absent from createClient, from
the package entry and from the docs), PendingOperation keeps only the route arm,
QueryEngine loses operationExecutor/cacheOperationExecutor, and client-route.ts
loses createCandidateClient.

Deleted, 33 production owners / 28,740 lines: src/query-engine/write-engine/
(25 files, incl. RecordUpdateCompiler, CreateOperation, UpdateOperation,
UpsertOperation, DeleteOperation, the Relation*Part family and routing.ts),
the seven query-engine root owners (OwnWriteSteps, OwnWriteAnalyzer,
OwnWriteRelation, OwnWriteLedger, RelationMembership, relation-key-legality,
validator) and builders/to-one-composition.ts. Added: routed-operations.ts,
48 lines, holding READ_OPERATIONS / ROUTED_OPERATIONS / isReadOperation /
isWriteOperation verbatim so the interception and cache seams keep one
authority; four imports re-pointed at it.

PUBLIC CONTRACT CHANGES, all deliberate:
- DatabaseAdapter.expressions.integerDivide is now the only path. It already
  shipped in the candidate; a third-party DatabaseAdapter implementation will
  not typecheck until it supplies the member.
- PendingOperation.buildStatement() and QueryEngine.build() keep the
  pre-cutover contract, made true for the new engine (D-14): they answer the
  ONE statement an operation compiles to whenever it compiles to exactly one,
  and keep the existing "does not compile to one SQL statement" refusal
  otherwise. Every read publishes one, from the prepared read the execution
  itself runs; a write answers the refusal, because the engine's only write
  fold is the asynchronous prepareBatch() and buildStatement() is synchronous.
  The JSDoc now says exactly that. The array-owner seam answers from the same
  single preparation: prepare() publishes that package's one query and
  parseResult() applies that package's own parser.
- The SQL build() publishes is the CANDIDATE's, and it is not the same query
  the deleted engine built: aliases are q0/q1 rather than t0/t1, a nested
  include on PostgreSQL/MySQL no longer uses LEFT JOIN LATERAL, and a GeoPoint
  predicate no longer uses a MySQL spatial index (EXPLAIN access_type ALL, not
  range). build() is the documented debugging surface, so anyone reading its
  output sees a different query than before.
- A registered refusal's wording changed: "Driver '<name>' supports neither
  transactions nor atomic batch execution." is now spelled with double quotes,
  Driver "<name>", by src/drivers/driver-transaction-base.ts:790 and :979.
- A QueryEngine constructed without a route provisions one from the driver and
  the registry it already holds, so every engine has exactly one operation
  owner and none has two. ResolvedSchemaViews.registry is declared as the one
  member EngineSchema reads.

Deleted with the engine, 203 test files / 91,069 lines: its own contract
suites. 197 came with the measured patch. The 15 SQL-text, message, oracle and
source-text suites the core gate exposed were then restored from the base and
pruned CELL BY CELL, under the rule the four surviving suites already used:
delete the cells that are red against the new engine, keep the cells that pass.
Of their 568 registered cells, 240 were deleted and 328 kept and are green.
Twelve of the fifteen files come back (sql-generation 91 of 147 cells kept,
field-reference-sql 49 of 89, operand-callback-sql 62 of 74,
decimal-having-operand-sql 42 of 48, cursor-pagination-sql 14 of 44,
json-null-sentinel-sql 21 of 30, request-result-shape-contracts 11 of 29,
geopoint-sql 14 of 20, lateral-joins 11 of 18,
batch-attribution-hazard-signature 5 of 17, write/parse-boundary-gate 3 of 6,
write/architecture-gates 5 of 6). Three stay deleted because no cell of theirs
survives: read-traversal-byte-pins (32 byte snapshots of the deleted engine's
text) with its snapshot file, drivers/namespace-execution-target (5; its oracle
is build(..., "createMany", ...), which compiles to no single statement) and
operation-equivalence-oracles (3 frozen SQL+params oracles). Seven
deleted-engine pins were removed from suites that outlived the engine, and
four of those removals dropped a one-sided half that still holds (the round-3 review named operation-program-read-contracts, namespace-qualification ×2 and distance-parity ×2; round 4 re-expressed the first two plus provider-result-contracts, which was finding 4's file); distance-parity's second cell's three `mine` assertions remain dropped and are recorded here as a knowing coverage loss, not re-expressed; the re-expressed halves
are restated verbatim (operation-program-read-contracts' direct-runtime arms,
two namespace-qualification cells, one provider-result-contracts cell), so
those three suites are back at their base counts. Two behaviour modules left
with zero importers by the deletion, extended-where-unique-behavior.ts and
to-one-update-where-behavior.ts, are deleted too. Nothing was re-pinned.

Harness, per D-11: no differential mode was retired and no registered cell was
lost. The ten G0/G1/G2 lanes and both support checks are green at their full
counts, because each two-sided arm was removed under the one-sided rule and
every surviving assertion is verbatim: the S2 and G1-upsert admission ledgers
and the G2 generated transitions state one evaluation per admitted input on
every arm, the key-update transport script states the engine's own statement
plan once, and the live unique-race expects one attempt. The two adjudicators
that existed only to translate the deleted engine's answers are retired; the
progress record one of them pinned is restated one-sided in the
s2-changed-dependency fixture's own assert. Earlier, C-01 retired the six
two-sided modes g4-route-lifecycle, g4-route-admission, g4-route-cache,
g4-route-transactions, g4-lifecycle-events and g4-lifecycle-admission plus 21
reviewer probes; five g4-unit02-author files were re-expressed one-sided
(136 -> 130 cells) and 31 cell titles were corrected. A further 10 cell titles
and distance-parity's shippedStatement() helper, which since D-14 is the
provisioned route rather than a shipped engine, are corrected here.
g4-unit01-review moves 200 -> 198.

Also restored, because the cutover took them as collateral: six libsql provider
contracts (batch-primary-key-dataflow, client-raw, scalar-roundtrip,
full-scalar-roundtrip, decimal-exactness, upsert-atomicity) -- these sit inside
the suite's existing describe.skip ("V1 effectful push is not supported by
libSQL"), so they are registered and matrix-visible but DO NOT EXECUTE, exactly
as before the cutover; two pg ones (batch-primary-key-dataflow,
create-many-return-fold) -- create-many-return-fold is green, and
batch-primary-key-dataflow FAILS and is kept red on purpose, because it records
an engine limitation ("Raptor 3 G1 atomic output requires exact identity
scratch or segmented RETURNING", raptor3/shared/operation-context.ts:1837); and
the query-engine layer's type core, now stating the single-statement
publication surface.

Whole-cost: charged production 53,890 -> 31,664 token-LOC (0.635 of the frozen
baseline, target 0.60), 71,146 -> 42,335 physical LOC (0.651, target 0.70);
src/**/*.ts 581 -> 549 files. Bundles: the engine fixture now contains the
engine (gzip 0.5893 of baseline, target 0.75) and both public PostgreSQL
fixtures are 0.7006 / 0.7008 (target 1.00). All four G4 campaign corpora are
byte-identical to the attempt-6 archives.

Decisions: D-8 (one evaluation per admitted input), D-9 (the remaining
preparation cost is accepted), D-10 (the cutover is performed locally, nothing
pushed, no database changed), D-11 (the differential modes), D-12 (dispose of
every newly red core-lane file; commit 4 only when the core lane is back to the
base's five red files or better), D-13 (the two deleted dirty pattern files are
accepted and their preimages committed under
docs/architecture/raptor3-evidence/g4/cutover-execution/receipts/preserved-unrelated-dirty/),
D-14 (the single-statement publication above).

KNOWN RED, by lane, measured on this tree against 5a37bcd7:

  core gate (pnpm test:core, --project='layer-*')
    this tree 6 failed files / 11 failed tests of 464 files / 9,301 tests
    base      5 failed files / 42 failed tests of 532 files / 11,292 tests
  provider-sqlite3 + provider-libsql (stages of pnpm test:all, no credentials)
    this tree 5 failed files / 61 failed tests
    base      0 failed        / 1,253 passed
  provider-pg, tests/providers/docker/pg-nested-write-races.test.ts
    this tree 13 failed / 82 passed of 95
    base      0 failed  / 77 passed
  provider-mysql2, tests/providers/docker/mysql2.test.ts
    this tree 13 failed / 71 passed of 85
    base      4 failed (pre-existing MySQL namespace containment) / 80 passed

That is 93 red cells beyond the base, in 12 files, 11 of them newly red (the
mysql2 file is red at the base too): 10 new core-lane cells, 61 credential-free
provider cells, 13 pg cells and 9 new mysql cells. Every one of them was
bisected: they fail identically on 5a37bcd7 with the pre-cutover candidate
route -- and the one cell whose oracle is QueryEngine.build (the MySQL GeoPoint
spatial-index plan) fails identically on a 5a37bcd7 whose buildStatement also
answers the candidate's SQL. NONE is a cutover defect. 88 of the 93 are unrecorded
compatibility differences of the candidate, neither repaired nor deleted, in
seventeen families, listed cell by cell with their exact observable in
docs/architecture/raptor3-evidence/g4/cutover-execution/note.md R4.2:
a nested object value parsed as an update-operator bag (9), relation-filtered
updateMany/deleteMany affecting the wrong row set (18), JSON string and array
path filters (8), the JSON null-sentinel refusal (1), a nested-write dependency
refusal raised where the shipped engine executed (5), nested default-only
duplicate skipping not refused (2), a self-referential m2m round trip (1),
Prisma-parity refusals for empty select and non-grouped groupBy/having (5),
polymorphic collection reads/writes/relations (9), the ordering query plan and
cursor paging over duplicate sort keys (2), decimal exactness and scalar
round-trip decoding (7), three read-path regressions (4), live upsert and
nested connectOrCreate concurrency on PostgreSQL (4), the filtered m2m
deleteMany staleness retry (1), the MySQL GeoPoint spatial index (1), the MySQL
batch-only non-returning refusal (1), the changed Driver "<name>" refusal text
(2 select-mode-capability-matrix cells), and the eight public-client cells
already bisected in note R3.2. They need Arnaud's decision, not a repair.

Five of the pg reds are the restored batchPrimaryKeyDataflowContract
registration described above: kept registered and kept red, because it records
an engine limitation. One of the six red core-lane files (contract-matrix) is
red on the base too. The whole-estate typecheck ends at exactly the two
historical pattern/pack.ts TS2345 diagnostics.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
