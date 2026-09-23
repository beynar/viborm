# Cutover measurement unit — candidate-only package in an isolated worktree

Read `common.md`, `g4/unit03/note.md` §F ("Cutover (C-01) diff, precisely")
and §8 (benchmark reachability), plan §7 (`docs/architecture/raptor3-implementation-plan.md`
"Performance adoption budgets", "Size targets"), `g4/qualification-plan.md`,
and `docs/architecture/raptor3-evidence/g0-baseline.md` (the benchmark
invocations and the frozen 20-cell protocol). You do NOT edit
`/Users/arnaud/code/viborm` except to write evidence under
`docs/architecture/raptor3-evidence/g4/cutover/`. The shipped engine is not
deleted from the main tree; C-01 is a proposal for Arnaud.

## 1. Measurement worktree (isolated, own branch)

`git -C /Users/arnaud/code/viborm worktree add -b g4-perf-measurement
/private/tmp/viborm-g4-perf-candidate 0cc61e61`. Copy the frozen production
tree into it: every file `git status --porcelain` lists under `src/` in the
main tree (modified and untracked, including `src/query-engine/raptor3/route/`)
— production only, no tests, no docs, no scripts. Verify with
`captureRaptor3Identity` (from `scripts/raptor3-manifest.mjs`, run in the
worktree after copying `scripts/raptor3-manifest.mjs` too) that the
production identity equals the frozen one recorded in
`g4/qualified/support/final-identity.json` (or the identity the integrator
names in your prompt). Install deps (`pnpm install --frozen-lockfile
--offline` first; `npx prebuild-install` for better-sqlite3 if the native
binding is missing). Commit that as `chore(raptor3): frozen G4 production for
measurement` on the branch (this commit is local, on a throwaway branch, never
pushed).

## 2. Apply the C-01 cutover exactly as §F states

In the worktree only: `client.ts` builds the candidate route unconditionally;
`query-engine.ts` route required, `OperationExecutor` and the legacy
executors deleted; `pending-operation.ts` loses the legacy arms;
`src/query-engine/write-engine/**` deleted except `parse-boundary.ts`, plus
every `result/`, `context/`, `builders/`, `operations/` owner the typecheck
then reports unreferenced (delete transitively until `node
scripts/run-typecheck.mjs` reports only the two Pattern diagnostics — the
`pattern/` experiment is retained as is); `route/client-route.ts` loses
`createCandidateClient`. Do not change any behavior of the route. Record the
exact diff as `g4/cutover/cutover.patch` (`git diff` of the second commit) and
commit `chore(raptor3): C-01 cutover for measurement`. Run the shipped
credential-free fixed lane's Raptor selectors that do not need the legacy
engine (`node scripts/run-raptor3.mjs g4-read-contracts`, `g4-route-*`,
`g3-execution-review`, `g2-contracts`) in the worktree to prove the package
still answers; record which registered modes cannot run after the cutover
because they import the legacy engine (those are the harness's cutover
obligations, listed in the proposal).

## 3. Bundle fixtures

`node scripts/measure-raptor3-baseline.mjs --bundle --output
docs/…/g4/cutover/bundles.json` in the worktree (comparable engine and the
full public PostgreSQL client fixtures), against the frozen baseline fixtures
in `docs/architecture/raptor3-evidence/baseline.json`. Report minified+gzip
per fixture and the ratio against the §7 targets (engine ≤ 75 %, every public
PG fixture ≤ 100 %).

## 4. Performance series (plan §7 hard gate)

Baseline: `/private/tmp/viborm-g4-perf-baseline` (clean 0cc61e61, deps
installed — verify `git status --porcelain` empty). Candidate: the worktree's
cutover commit. Coordinator: run from the baseline worktree (clean). Derive
the exact 20-cell invocation from `benchmarks/operation-pipeline-catalog.mjs`
(`RAPTOR3_WORKLOADS`, their stages and modes) and
`benchmarks/operation-pipeline-report.mjs` (`evaluateKeepGate`, budgets):
five alternating fresh-process samples per side, sqlite3 provider, budgets 5 %
time / 10 % peak memory with `E = 2 × max(MAD)`, `--output
docs/…/g4/cutover/performance.json`. Write the exact command to
`g4/cutover/protocol.md` BEFORE running it. Take the workspace lock into
account (the integrator may be running qualification modes: the benchmark
acquires the same lock and waits or refuses; retry rather than remove a
lock). If a cell is inconclusive, repeat the full series once; a cell still
unresolved is recorded as "inconclusive — blocks adoption", never as passed.
Claims of improvement need improvement > E. No outlier removal.

## 5. Proposal

Write `g4/cutover-proposal.md` for Arnaud: the exact cutover diff (patch
path, files deleted with line counts), the harness modes that need the legacy
engine and how each would be retired or re-pointed, the bundle and
performance results with their receipts, and what is NOT done (nothing is
pushed, the main tree keeps the legacy engine, no database changed). Remove
nothing from the main tree. Leave the worktree and branch in place for the
integrator.

## Exit

Structured summary: unit, summary, location (worktree, branch, commits),
notePath (`g4/cutover/note.md`), patchPath, results (bundles per fixture,
performance per cell with B/N/MAD/E and verdict), suites run in the worktree,
typecheck, blockers, unverifiedClaims.

## Stage 2 addendum (after the prep stage, 18:05) — the read-harness blocker

The prep stage (`g4/cutover/note.md`) measured that on the cutover build the
pending operation's `prepare()` and `buildStatement()` return `undefined`
(divergence D-4′, `g4/unit03/note.md` FU.6): the candidate route publishes a
prepared PACKAGE (`prepareBatch()`), not a single statement.
`benchmarks/operation-pipeline-harness.mjs:249-257` (`createReadHarness`)
throws when `prepare()` answers nothing, so the read cells cannot be measured
as the harness stands. Plan §7 answers this: "use narrow test-only phase
adapters where internal entry shapes differ; they must bracket equivalent
work, including input/default preparation and decoding; if a phase cannot be
isolated comparably, measure the common enclosing boundary and retain
end-to-end evidence; no production compatibility layer is required".

Rules for stage 2:

1. No production change on either side. The adapter lives in `benchmarks/`
   only, is the same bytes on both sides, and is applied as a **protocol
   overlay commit**: on the baseline, one commit above `0cc61e61` touching only
   `benchmarks/` files (`--baseline-source-commit 0cc61e61 --baseline-commit
   <overlay>`; the compare script refuses an overlay that touches
   implementation paths, `findProtocolOverlayImplementationPaths`), on the
   candidate branch the same change committed on top of the re-synced frozen
   production + cutover.
2. The adapter brackets equivalent work: where the shipped `prepare()` covers
   admission + one statement's construction, the candidate's `prepareBatch()`
   covers admission + the same statement inside a package; measure that
   common enclosing boundary on BOTH sides (call `prepareBatch()` on the
   shipped side too when the adapter is active) rather than timing
   `prepare()` on one side and `prepareBatch()` on the other. Retain the SQL,
   parameters and statement counts each side produced as evidence. Decoding
   and the execute/parse stages stay end-to-end through the public entry.
3. Falsifiers: run `--calibrate` (old-versus-old on the baseline overlay) to
   show the adapter changes nothing for the shipped engine beyond the bracket;
   keep a wrong-result specimen check (the existing semantic comparison must
   still fail when it should).
4. Record the revised protocol in `g4/cutover/protocol.md` BEFORE the series,
   with the exact commands, both commits, the adapter diff and why it is a
   phase adapter and not a compatibility layer. Then run the series per §4 of
   this brief. If the adapter cannot bracket a cell comparably, that cell is
   recorded as "not measurable comparably — end-to-end evidence retained",
   never as passed.
5. Re-sync first: copy the frozen files named in the integrator's prompt (the
   freeze identity) over the worktree, keep `src/query-engine/routed-operations.ts`
   (the cutover's own file), re-apply `cutover.patch` if needed, commit,
   re-run typecheck and `pnpm package:build`, and only then measure.
