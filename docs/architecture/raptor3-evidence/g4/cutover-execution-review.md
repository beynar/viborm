# C-01 cutover execution — independent review

**Unit** `g4-cutover-execution` (Arnaud's D-10, the cutover PERFORMED in the main
tree). **Brief** [`g4/briefs/cutover-execution.md`](briefs/cutover-execution.md).
**Author's record** [`g4/cutover-execution/note.md`](cutover-execution/note.md),
patch [`cutover.patch`](cutover-execution/cutover.patch).
**Base** `5a37bcd7f371fe393cf7cecb8ec9f82ef8bd3062`. **Reviewer** independent; did
not write the unit. **Receipts**
[`cutover-execution-review-receipts/`](cutover-execution-review-receipts/),
probes [`tests/raptor3/g4/review/cutover/`](../../../../tests/raptor3/g4/review/cutover/).

## Outcome: **REVISE**

The mechanical execution is faithful and, where I could re-derive it, exact. I
reconstructed the base tree, applied the stage-2d patch to it and diffed the
result against the live `src/`: **the production tree is byte-identical to
base + patch**, with exactly one further file, the `raptor3/AGENTS.md` restatement
the brief asked for. Typecheck, build, bundles, the cost census and both read
campaign corpora reproduce to the byte. The re-expressed one-sided pins are real
pins: I broke the engine behaviour two of them assert and watched them go red.

What must be revised is not the diff — it is the **measurement of what the diff
costs** and two statements the unit asks the integrator to commit. The note
reports "12 registered modes and 2 support checks are RED". The registered
raptor3 estate is not the estate: the repository's own core gate
(`--project='layer-*'`, i.e. `pnpm test:core`) was never run, and on the cutover
tree it is **35 failed files / 534 failed tests** against **5 / 42** on the base
— roughly **+30 files and +492 tests** that no receipt in the unit records. The
same blind spot the note correctly identifies for G0/G1/G2 (suites that reach the
engine through `createClient(...)` or `QueryEngine.build(...)`, not through the
private selector) extends across the whole estate, and it was measured for one
sixth of it.

Findings 1–3 are blocking for **commit 4**; the unit's artifacts (note §2, §3.4
and the commit-message draft §6) must be corrected before anything is committed,
whatever Arnaud then decides about the reds themselves.

---

## Findings

### 1. blocking — the repository's core test gate is red, unmeasured and unreported

`node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project='layer-*'`
(the `pnpm test:core` selection) on the cutover tree:

| tree | failed files | failed tests | total |
| --- | ---: | ---: | --- |
| base `5a37bcd7` (pristine copy) | 5 | 42 | 532 files / 11,292 tests |
| **cutover tree** | **35** | **534** | 467 files / 9,420 tests |

Receipts: [`test-core-cutover.log`](cutover-execution-review-receipts/test-core-cutover.log),
[`test-core-base-5a37bcd7.log`](cutover-execution-review-receipts/test-core-base-5a37bcd7.log),
failing-file sets in the same directory. Four of the base's five red files are
deleted by the cutover (`parity-b-upsert-arm`, `parity-e-shared-pk`,
`polymorphic-write-plan`, `pattern/corpus/oracle`) and only
`contract-matrix.core.test.ts` fails on both trees, so the arrival is
**34 newly red files**, listed in
[`test-core-cutover-failing-files.txt`](cutover-execution-review-receipts/test-core-cutover-failing-files.txt).

Causes, counted in the log: **790** occurrences of `Operation '…' does not compile
to one SQL statement` (the D-4′ `buildStatement()` refusal reached through
`QueryEngine.build` and `PendingOperation.buildStatement`), **21** of
`TypeError: Cannot read properties of undefined` (a `new QueryEngine(driver, registry)`
built outside a client lineage now has `route === undefined`, and
`PendingOperation`'s `engine.route as ClientOperationRoute` turns that into an
unnamed crash — the §4.3 escape hatch failing at runtime, not at the type), **7**
of `publishes no single driver result to parse`. 36 files / 51 sites under `tests/`
(plus 3 sites in `src/` and 1 in `benchmarks/`) still construct `new QueryEngine(`.

Not all of this is new engine behaviour — most of it is the deleted engine's own
SQL-text contract suites, which the patch's file-set analysis could not see
because they reach the engine through the friend seam rather than by importing a
deleted module. That is exactly the note §2 diagnosis, at ten times the scale.
Fifteen of the failures are on the **public client** path
(`query-interceptors-array` 4, `query-interceptors-integration` 2,
`request-transforms` 6, `official-cache-swr` 1, `array-transaction-closure` 1,
`one-resolution-identity` 1), so the note's "**No red is a candidate defect**" is
not established for this population; it was not looked at.

**Resolution.** Run the lane, put its receipt in `cutover-execution/receipts/`,
and restate the blocker in note §2 and in the commit-message draft with the real
population (per-file counts and the three causes above). Then classify the 34
files the way §1.4 classified the five `unit02` ones: a deleted-engine contract
suite is deleted with its engine; a public-client cell that now asserts a
changed seam is a decision for Arnaud, not a repair. Reproduce with the two
commands in
[`cutover-execution-review-receipts/README.txt`](cutover-execution-review-receipts/README.txt).

### 2. blocking — a published export changed behaviour; §2.1 and the commit draft say none did

`src/query-engine/pending-operation.ts:703` — `buildStatement()` now returns
`undefined` unconditionally. `PendingOperation` is exported from the package entry
(`src/index.ts:59-64`, `PendingOperation` at `:61`) and `buildStatement(): Sql | undefined` is declared in the
built type surface (`dist/index-DONhXaa8.d.mts:1532`) with a doc comment that
still promises "the one SQL statement this operation compiles to". A consumer
holding a `PendingOperation` — the documented `$transaction([...])` value — could
call it before the cutover and receive the compiled `Sql`; after it, every call
answers `undefined`.

The note records this as follow-up 2, but scoped to `QueryEngine.build` and
argued as "no client surface reaches it". `QueryEngine` is indeed absent from
every entry (`tsdown.config.ts` entries carry no `QueryEngine` export — verified);
`PendingOperation` is not. Meanwhile proposal §2.1 states "**The public surface
does not change**" and the commit draft repeats "Nothing a user can write changes
meaning".

Probe: `tests/unit/cache/operand-callback-keys.core.test.ts:83` ("the raw payload
keeps the function; the compiled statement does not") fails with
`expected '' to contain '"likes"'` — through `createClient`, no internal import.

**Resolution.** Either publish the candidate's prepared `Sql` from
`buildStatement()`, or remove the method from the exported class and its
declaration, or record it in the commit message as the public behaviour change it
is. Whichever Arnaud picks, delete the "the public surface does not change"
sentence from the commit draft and from the note's §1.6 framing, and fix the
JSDoc, which now describes behaviour the method no longer has.

### 3. blocking — 52 manifest entries point at deleted files; two gates catch it

`scripts/query-engine-test-manifest.mjs` (`QUERY_ENGINE_CORE_TESTS` 10 of 77,
`WRITE_ENGINE_CORE_TESTS` 41 of 56, `WRITE_ENGINE_COVERAGE_TESTS` 41 of 57) and
`scripts/driver-test-manifest.mjs` (`DRIVER_COVERAGE_TESTS` 1 of 60,
`tests/contracts/drivers/consumable-result-rows.provider.test.ts`) still name
files the patch deleted. Every one of them existed at the base, so this is the
cutover's own debris. The brief's item 2 ("prune entries that now match no file")
named `vitest.workspace.ts` and the credential-free manifest, which the unit did
prune correctly; these two manifests feed `vitest.workspace.ts` through imports
and were not checked.

Two gates fail on it:

- `pnpm test:coverage:policy` → `scripts/coverage-policy.test.mjs`: **9 of 11**,
  where the base copy is **11 of 11**. `driver coverage isolates provider
  resources…` dies with `ENOENT … consumable-result-rows.provider.test.ts`;
  `query coverage admits every core contract exactly once` (`:434`) fails the
  `deepEqual` between the manifest and the on-disk enumeration.
  [`coverage-policy-cutover.log`](cutover-execution-review-receipts/coverage-policy-cutover.log).
- `tests/contracts/architecture/core-taxonomy-census.core.test.ts` > "keeps every
  layer project and include pattern live": `expected [ …(51) ] to deeply equal []`
  — the 51 dead include entries, named one by one. This gate exists for precisely
  this defect.

No vitest project becomes empty (I resolved all 42 projects' includes against the
filesystem: minimum 1 file, `layer-write-engine` 15, `coverage-write-engine` 16),
so the author's narrower claim holds; the stale entries are still a red gate.

**Resolution.** Delete the 52 entries from the two manifests (mechanical, no
judgement), re-run `pnpm test:coverage:policy` and `core-taxonomy-census`, and add
both to the verification list in note §3.

### 4. must-fix — registered cells that now compare the engine with itself are still named "shipped"

The note's follow-up 3 inventories these by counting `"shipped"` literals and
labels the count unverified. I read the constructions. In
`key-arithmetic.test.ts:114`, `lone-statement-transport.test.ts:198,239,306`,
`unique-discriminator.test.ts:546`, `nested-key-refusal.test.ts:130`,
`native-nested-key-refusal.test.ts:152`, `upsert-key-portability.test.ts:142`,
`malformed-result-cuts.test.ts:273` and `root-member-cut-trace.test.ts:57` the
"shipped" arm is `createClient(...)`/the public model method and the "candidate"
arm is `createCommandEngine(...).execute(...)`. After C-01 both arms are the
Raptor 3 engine, so these are **not quite tautologies** — they compare the client
route seam against the direct command-engine seam, which can still diverge — but
every cell name and failure message asserts a comparison with an engine that no
longer exists ("answers the shipped failure exactly", "still agrees with the
shipped engine", "exactly the call sites the shipped engine compiles with
`buildWhereUnique`"). `g4-unit02-mysql-contracts`, which I ran green, prints that
last sentence as a passing native claim.

The brief's rule for the six retired modes was retire, do not re-point; the
cutover re-points these by construction, and the unit applied §1.4 only to files
that stopped typechecking. That is a defensible scope line, but the estate is now
carrying registered evidence whose names are false.

**Resolution.** Either rename each cell to what it now compares (client seam vs
command engine) in the same pass as the §1.4 re-expressions, or list them
explicitly in the commit message as knowingly misnamed pending the harness
decision of follow-up 1. Replace the literal count in follow-up 3 with the
cell-level list above.

### 5. must-fix — another stream's uncommitted work was deleted; the only copy is untracked

`tests/pattern/pack/program-dump.ts` was dirty in the working tree and the patch
deletes it; common-brief rule 3 names that exact file as one that "stays
untouched". The unit resolved the conflict in favour of the terminating condition
(the file is orphaned by the patch and cannot typecheck) and preserved the
preimage at
`cutover-execution/receipts/preserved-unrelated-dirty/tests_pattern_pack_program-dump.ts`.
I verified the preserved copy is the dirty version, not `HEAD`: it differs from
`git show 5a37bcd7:tests/pattern/pack/program-dump.ts` by a real edit (a
`const row = table[i]; if (!row) continue;` hoist). The untracked
`tests/pattern/match/decode-malformed.core.test.ts` is preserved the same way.

The unit flagged this as needing Arnaud's call, which is right. The risk it does
not name: the preserved copy lives in an **untracked** evidence directory, so any
`git clean` between now and the decision destroys the only copy.

**Resolution.** Get the owning stream's or Arnaud's confirmation before commit 4,
and until then keep the two preimages somewhere that survives a clean.

### 6. note — the guides of the layer whose engine was deleted still describe it

`src/query-engine/AGENTS.md` (907 lines, normative for the layer) names **13**
deleted owners — `RecordUpdateCompiler.ts`, `CreateOperation.ts`,
`write-engine/routing.ts` (`:151`, `:722`), the `Relation*Part` family — and
`src/query-engine/README.md` names 4. `src/query-engine/raptor3/shared/operation-context.ts:1305`
still says `@extensions/query` imports `write-engine/routing`, which the cutover
re-pointed. The brief's item 5 named only `raptor3/AGENTS.md`, which the unit
restated correctly and truthfully, so this is out of the letter of the scope and
inside the spirit of it: the next agent reading the layer guide is told an engine
exists that does not.

**Resolution.** A follow-up in note §5, or a one-pass correction of the two files
before commit.

### 7. note — two inaccuracies in the note's own prose (the receipts are right)

- §3.6: "`src/query-engine/raptor3/**` has exactly **two** edges outside itself".
  It has 68 edges outside `raptor3/`, and 6 into `src/query-engine/` outside it:
  `shared/schema.ts → write-engine/parse-boundary.ts`,
  `route/client-route.ts → result/cache-value-codecs.ts`, plus `types.ts`
  (from `commands/index.ts`, `route/client-route.ts`, `shared/operation-context.ts`)
  and `shared/operation-context.ts → bind-budget.ts`. The receipt
  `plan7-greps.txt` states it correctly ("raptor3 → shipped-engine import edges:
  2"); only the note's sentence over-claims.
- §3.6: "reached **only** by `pattern/` and by **three** retained non-engine
  owners" — then lists five (`JunctionStatements.ts`,
  `batch-error-attribution.ts`, `unique-conflict-target.ts`,
  `operations/mutation-projection-fold.ts`, `types.ts`). Five is correct.

### 8. note — the fixed group's first `g4-unit02-author` attempt failed and the note does not say so

`cutover-execution/receipts/fixed/RUN.log:1-4` records `g4-unit02-author exit=1`
at 21:02:52, then `exit=0` at 21:08:59 and again at 21:23:12. The RUN.log keeps
the failure labelled, which satisfies evidence discipline, but the per-mode
`g4-unit02-author.log` holds only the last run and note §3.4 presents the mode as
green without mentioning the earlier red. 61 `exit=` lines for 59 modes.

**Resolution.** One sentence in §3.4 or §7.

---

## What I verified, and how

### The diff is the measured diff (brief item 1) — CONFIRMED

`git archive 5a37bcd7 src` into a scratch tree, `git apply` the 42 `src/` blocks of
`g4/cutover/receipts-stage2d/cutover-identity4.patch` (clean, no offsets), then
`diff -r` against the live `src/`: **one differing file**,
`src/query-engine/raptor3/AGENTS.md` (brief item 5, and its text is true —
`client.ts:489` does build the route unconditionally and nothing under `raptor3/`
is exported from any entry). No extra production change exists.

Patch arithmetic re-derived from the patch itself: 239 entries = 230 D + 8 M + 1 A;
33 `src/` owners / 28,740 deleted lines; 197 test files / 86,498 deleted lines
(contracts 134, raptor3 26, pattern 19, providers 15, types 2, unit 1);
+106 / −115,495; modified production +58 / −257; `routed-operations.ts` 48 lines.
Working-tree deletions = the patch's set plus the three review probes the unit
deleted, minus `packaged-array.test.ts` (deleted then re-written) and the
untracked `decode-malformed.core.test.ts`. `src/**/*.ts` 581 → 549;
`src/query-engine` 149; `write-engine/` 18; `raptor3/` 15.

### Plan §7 architectural rows (brief item 4) — CONFIRMED

I resolved every import specifier in all 549 surviving `src/**/*.ts` through the
`tsconfig` paths myself (3,064 internal edges, 43 external packages): **0** resolve
to a deleted owner; the only 3 unresolved strings are documentation examples in
`src/config.ts` and `src/cli/utils.ts`. `createCandidateClient`,
`operationExecutor`, `cacheOperationExecutor`, `constructRoutedOperation`,
`executeRoutedOperation` and `VibORM.create(config, …)` have no occurrence under
`src/`. All 18 surviving `write-engine/` files have at least one importer, so the
cutover leaves no dead owner behind.

### Manifests and workspace (brief item 3) — CONFIRMED for the two named files, see finding 3

All 463 path entries across the 228 exports of `scripts/raptor3-manifest.mjs`
exist. No reference to the six retired constants survives anywhere outside docs.
The four consumer edits delete exactly the six names and nothing else. All 42
vitest projects resolve to at least one file. The credential-free manifest has no
dangling entry; `EXTENDED_LOCAL_TESTS` is 189 and contains no review probe.

### Harness classification (brief item 2) — CONFIRMED, with finding 4

I read all five re-expressed files. Every retired cell was genuinely two-sided
(`candidate === shipped`, or a literal that pinned the shipped answer, or an
oracle built on `QueryEngine.build`). Every kept cell keeps a verbatim one-sided
assertion; `uncertain-outcome-meta.test.ts` has no residual two-arm comparison.
One coverage loss worth recording: `packaged-array.test.ts`'s kept
present-root-delete cell lost its surviving-rows comparison and now asserts only
`rejected === "none"`, and `decimal-having-operand.test.ts` lost the
PostgreSQL/MySQL operand-widening property entirely (its shipped-side contract,
`decimal-having-operand-sql.core.test.ts`, is deleted by the patch and is also
one of the 34 files of finding 1). Both are consequences of the stated rule, not
departures from it.

**Falsification (brief item 2, the "still falsifies" half).** Two mutations, each
made on a scratch copy and restored with a sha256 check:

- F1 `src/query-engine/raptor3/shared/query.ts:1783` — replaced the
  `precision === undefined` refusal with a widened literal. Expected red, got red:
  `decimal-having-operand.test.ts:84` `assert.match` fails with the rendered
  `CAST($1 AS INTEGER)` statement. Restored; sha256
  `c52ec048…c3a8` before and after.
- F2 `src/query-engine/raptor3/shared/operation-context.ts:1031-1034` — removed the
  `assertions.exists` guard `packagedPresence` queues. Expected red, got red:
  `packaged-array.test.ts:142` `1 !== 2`. Restored; sha256 `bc791617…c637`.

`captureRaptor3Identity().production` after the review is
`f42d6facdc5b36b420ca47b929acb629383dc47d3aa55be9c0d68fe2ae3c19d3` — byte-equal to
the author's post-edit fingerprint, which is independent proof that production is
exactly as the unit left it.

### Suites I ran (brief item 5)

| Command | Result | Author's claim |
| --- | --- | --- |
| `node scripts/run-typecheck.mjs` | the two `pattern/pack.ts` TS2345 diagnostics at `(1443,36)` and `(2633,58)` and nothing else | matches |
| `pnpm package:build` | exit 0, 181 files, `dist/index.mjs` | matches |
| `measure-raptor3-baseline.mjs --bundle` | **0 differing fields** against `bundles-identity4.json`; engine gzip 37,260 `b4bbee47…`, pg-simple 183,791 `91acc78c…`, pg-relations 183,921 `a799ab40…`; ratios **0.2377 / 0.6997 / 0.6999** | matches exactly |
| `run-raptor3 g4-read-contracts` | 8 files / 62 tests green | matches |
| `run-raptor3 g2-contracts` | 16 / 216 green | matches |
| `run-raptor3 g4-unit02-author` | **21 / 130** green | matches the new count |
| `run-raptor3 g4-unit02-pg-contracts` (port 55729) | 1 / 1 green | matches |
| `run-raptor3 g4-unit02-mysql-contracts` (port 55730) | 3 / 17 green | matches |
| `run-raptor3 g4-seed-batch 20000 --subject=candidate` | corpus 338,001 B; body sha256 `16eab58f…f458` **equal** to the attempt-6 archive with the identity removed | matches |
| `run-raptor3 g4-transport-seed-batch 50000 --subject=candidate` | corpus 324,201 B; body **equal** | matches |
| `run-raptor3 g0` | **RED**, 5 failed / 28 passed in 2 files | matches (`instances.ts:155` sets `singleAdmission = candidateFactory !== undefined`, so the baseline arm — now the candidate — is asserted against the legacy `k + 2nk` ledger; not a candidate defect) |
| `scripts/raptor3-campaign-receipts.test.mjs` | 39 / 39 green | matches |
| `scripts/raptor3-cli.test.mjs` | **RED** 0 / 10, all downstream of `g0` | matches |
| `--project='layer-*'` (`pnpm test:core`) | **RED** 35 files / 534 tests | **not run by the unit** (finding 1) |
| `scripts/coverage-policy.test.mjs` | **RED** 9 / 11 | **not run by the unit** (finding 3) |

### Cost (review brief item 5) — CONFIRMED

Recomputed from my own `measure-raptor3-baseline.mjs` run: charged production
**139 files / 1,420,269 B / 42,269 physical / 31,622 token-LOC**, by classification
`charged-engine` 23,313, `charged-g3-prep-shared` 4,476, `charged-integration`
3,759, `charged-adapter-integration` 74 — identical to the note and to
`source-cost-after.json`. Against the frozen baseline (161 / 2,292,906 / 64,980 /
49,887): token ratio **0.6339** (target 0.60, missed by 3.4 points), physical
**0.6505** (target 0.70, met), bytes 0.6194. Deltas from the pre-cutover census
(171 / 2,518,074 / 71,146 / 53,890): −32 files, −1,097,805 B, −28,877 physical,
−22,268 token-LOC. The unit's whole-cost result is a deletion, as claimed.

### §7 decision-elimination gate, against the actual diff

1. **Necessary decision or representation repair?** Neither. One decision is
   removed ("which engine owns this operation") and nothing replaces it. The one
   added file is a verbatim move, not a new rule.
2. **Deletion and replacement obligation.** Verified above: 33 owners gone, no
   import resolves to one, no fallback identifier survives, the selection
   parameter is gone from `VibORM.create`. The replacing invariant ("every client
   lineage installs the route and `bind()` forwards it") is observable, not just
   grep-able — see the probes below. The escape hatch is the type only, but
   finding 1 shows it is reachable at runtime by code that already exists in the
   estate, where it produces an unnamed `TypeError` rather than a named refusal.
3. **One rule across uses?** Yes: root view, callback `$transaction` and array
   `$transaction([...])` all reach the same owner (probe P2), and the read/write
   vocabulary has exactly one owner (probe P1).
4. **What grew?** Nothing: +48 lines and +58/−257, against −22,268 charged
   token-LOC. No second public-syntax walker, per-verb codec, duplicated
   result-shape preparation, recreated lifecycle, policy-boolean bag, cached
   absence or fixture-named flag appears in the diff.

### Probes I added (kept, as the review brief requires)

`tests/raptor3/g4/review/cutover/` — 7 cells, all green, run with
`node scripts/run-vitest-safe.mjs run --config tests/raptor3/g4/review/cutover/vitest.config.ts`
(the registered `raptor3` project admits an explicit file list, so an
unregistered probe needs its own selection; the config extends the repository
config unchanged and only narrows `include`).

- **P1 `routed-operations-authority.review.test.ts`** (4 cells). The cutover's one
  added file claims the deleted `write-engine/routing.ts` vocabulary verbatim, and
  the note names the falsifier: `raptor3/shared/schema.ts#isReadOperation` omits
  `findUniqueOrThrow`/`findFirstOrThrow`, so a substitution would change the
  observable interception contract at `src/extensions/query.ts:642`
  (`requiresProceed`). Through a real sqlite3 client: an interceptor may answer
  `findUniqueOrThrow` and `findFirstOrThrow` **without** proceeding (read), a
  `create` that does the same is still refused with "completed without proceed"
  (write), and the two sets differ on exactly those two verbs. The non-substitution
  is correct and now has an executable witness.
- **P2 `one-owner-every-lineage.review.test.ts`** (3 cells). The replacing
  invariant, observed rather than grepped: a recording `SQLite3Driver` shows that
  the root view, a callback `$transaction` and an array `$transaction([...])` all
  emit the Raptor 3 root alias `"q0"` (the deleted engine spelled it `t0`), so
  every lineage reaches the one owner and `bind()` forwarding is real.

Note for the integrator: these three files change the **harness** fingerprint
(`captureRaptor3Identity` walks `tests/raptor3`). It is
`b2f6713e66a0737c7e8a618ad284a8ee42c6ee59aa55f3e6a4e5b512582558ad` after this
review, where the unit finished at `5ba4982a…`. Production is unchanged.

### Evidence integrity and preservation

Receipts carry the identity they ran on; the intermediate identity is disclosed
rather than hidden; the failed `g4-unit02-author` attempt stays labelled failed
(finding 8 is that the note does not repeat it). `git reflog` shows two
`reset: moving to HEAD` entries at **20:47:50**, before the unit's first receipt at
20:49:15 — they belong to the integrator's commit 3, not to this unit. Nothing is
staged, no stash was added, `HEAD` is still `5a37bcd7f`. The Docker containers
were used read-only through the existing ports and no database was created or
dropped by this review.

### Author claims I could not verify

- "**No red is a candidate defect**" — established by reading for the 12 modes the
  unit ran, not established for the 34 core-lane files it did not (finding 1).
- The 51-green fixed tally and the native tallies are single runs, and 69 of the
  70 greens were taken at the **intermediate** identity `02acf879…/c4eca7bb…`, not
  at the final one. The unit says so in §7. I re-ran five of them at the final
  identity and all five agree.
- The Biome comparison (175 vs 178) is a scratch-directory measurement; I did not
  reproduce it.
- No performance cell was re-measured by the unit or by me; stage 2d stands.
