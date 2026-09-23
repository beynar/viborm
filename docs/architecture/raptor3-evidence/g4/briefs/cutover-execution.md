# C-01 cutover execution — the Raptor 3 engine ships (Arnaud, D-10, 18:32 2026-09-16)

Read `common.md` in full (the twelve rules), the proposal
`g4/cutover-proposal.md` in full (§2 the exact diff, §3 what the cutover
costs the harness, §4 what it does not remove and what it adds, §7, §9–§12
and the integrator addendum), the cutover note `g4/cutover/note.md`, the
ledger decisions D-8, D-9 and D-10 in `docs/architecture/raptor3-evidence/g4.md`,
plan §7 in `docs/architecture/raptor3-implementation-plan.md`, and the
private guide `src/query-engine/raptor3/AGENTS.md`. Decisions: D-9 — Arnaud
accepts the measured preparation cost; D-10 — the cutover is PERFORMED in
the main tree, locally, as the next commit; nothing is pushed, no database
is changed. Base: the main tree's HEAD at launch (commit 3, the qualified
pass-2 tree — record its sha). Never commit, stage, reset, stash or run
Biome `--write` on a whole file; the integrator commits. The unrelated
dirty files (CONTEXT.md, memory.md, tests/pattern/**, exa-results/, root
corpora, pre-G4 archives) stay untouched.

## What to apply

1. **The measured cutover diff**, as one `git apply` in the main tree:
   `g4/cutover/receipts-stage2d/cutover-identity4.patch` (stage 2d's patch
   for the frozen pass-2 identity; if absent, `receipts-stage2c/cutover-identity3.patch`
   adjusted, every adjustment recorded). Expected: 239 files — nine
   production files change (`client.ts` builds the route unconditionally and
   `VibORM.create` loses its non-public `route` parameter,
   `pending-operation.ts` keeps only the route arm, `query-engine.ts` loses
   the legacy executors, `client-route.ts` loses `createCandidateClient`,
   `routed-operations.ts` is added, four imports re-pointed), 33 production
   owners deleted (`write-engine/` 25, seven root owners,
   `builders/to-one-composition.ts`; 28,740 lines), 197 test files deleted
   (86,498 lines; the list is `deleted-tests-identity*.txt`). After the
   apply, `git status` must list exactly the patch's file set plus your
   harness re-expressions below; state the counts.
2. **Retire, do not re-point, the two-sided instruments** (§3.1): the
   modes `g4-route-lifecycle`, `g4-route-admission`, `g4-route-cache`,
   `g4-route-transactions`, `g4-lifecycle-events`, `g4-lifecycle-admission`
   leave `scripts/raptor3-manifest.mjs` (their files are deleted by the
   patch); the 18 `tests/raptor3/g4/review/**` probes the patch deletes are
   reviewers' instruments and go with them (record the list). For
   `tests/raptor3/g4/unit02/packaged-array.test.ts` (5 registered cells of
   `g4-unit02-author`): classify each cell — a two-sided comparison against
   the shipped route is retired and the count lowered; a one-sided pin of
   the engine's own behaviour that merely used `createCandidateRoute` to
   reach the engine is re-expressed through the public client
   (`createClient`) and kept. The G4 read/write campaign harness
   (`tests/raptor3/g4/generation/**`) does not use the private seam; verify
   that and that every campaign mode still resolves. Prune
   `vitest.workspace.ts` projects and `scripts/credential-free-test-manifest.mjs`
   entries that now match no file (a project with no test file is red);
   nothing else in those two files moves.
3. **Retained by instruction:** `pattern/` and the 25 owners it keeps alive
   (§4.1), including three `write-engine/` files and the
   `PreparedBatchGuard.failure` type chain — do not delete them; the two
   historical Pattern TS2345 diagnostics stay the only typecheck errors.
   The `route` parameter of `QueryEngine` stays optional with the one
   localised assertion (§4.3) — record it as the follow-up it is.
4. **Public contract record:** the adapter member
   `expressions.integerDivide` (§4.2) already ships in the candidate; the
   cutover makes it the only path. There is no changeset convention in
   this repo; write the contract change into `g4/cutover-execution/note.md`
   and into the commit message the integrator will use (a draft in the
   note: `feat(raptor3): cut over to the Raptor 3 engine (C-01)`, listing
   the removed owners, the retired modes, the adapter member, D-8/D-9/D-10).
5. **Guides:** `src/query-engine/raptor3/AGENTS.md` sentences that say the
   route is not the shipped default (the hand-applied `client-route.ts`
   docblock of stage 2c is the model); nothing speculative.

## Verification before hand-off (one mode per Bash call, bounded)

- `node scripts/run-typecheck.mjs`: exactly the two Pattern diagnostics.
- `pnpm package:build`; then the bundle fixtures of brief §3 of
  `cutover-measurement.md` (`benchmarks/operation-pipeline-*` bundle
  measurement as stage 2d ran it): sizes must equal
  `g4/cutover/bundles-identity4.json` (same sources, same build) — state
  every byte of difference.
- The whole surviving registered estate through the qualification driver's
  groups: every remaining fixed mode (the driver's list minus the retired
  six; `g4-unit02-author` with its new count), the native PostgreSQL and
  MySQL modes on the Docker providers (ports from `docker port …`), the
  support group (receipts self-test, CLI self-test alone, structure census,
  driver integration, credential-free selectors). Green everywhere; any red
  is a blocker, not a note.
- One child batch of each G4 campaign family on the cutover tree
  (`g4-seed-batch 20000 --subject=candidate`, `g4-transport-seed-batch 50000
  --subject=candidate`, and the write families' first children per the
  attempt-6 package's `reproduction.md`): the corpora must be byte-identical
  to the attempt-6 retained archives — the engine did not change, only the
  way the client reaches it.
- Plan §7 hard requirements, grep-proven and recorded: no import of a
  deleted owner anywhere under `src/` (the retained 25 are listed, not
  imported by the engine), no legacy fallback, no duplicated downstream
  public-verb algorithm.
- `captureRaptor3Identity` after the last edit (production and harness);
  the cost census before and after (candidate core, whole tree; the deletion
  is the whole-cost result plan §7 asks for — report physical, token-bearing
  and byte counts against the frozen baseline and the §7 targets).

## Record

`g4/cutover-execution/note.md` (what was applied, the classification of
every harness file touched, the counts, every verification receipt under
`g4/cutover-execution/receipts/`, the commit-message draft, follow-ups:
the optional `route` type, `pattern/` retirement, the seven retired modes'
replacements), `g4/cutover-execution/cutover.patch` (`git diff <base>`,
proper headers, binary-safe). Return the structured summary.
