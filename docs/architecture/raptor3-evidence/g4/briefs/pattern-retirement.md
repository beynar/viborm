# Retire the `pattern/` experiment and the owners it keeps alive (Arnaud, D-15, 23:58 2026-09-16)

Read `common.md` in full (the twelve rules), the ledger decisions D-10 and
D-15 in `docs/architecture/raptor3-evidence/g4.md`, the cutover proposal
§4.1 (`g4/cutover-proposal.md`), the reachability receipt
`g4/cutover/receipts-stage2/pattern-retained-owners.json`, the cutover
execution note `g4/cutover-execution/note.md` (what the cutover already
deleted and why), plan §7 in `docs/architecture/raptor3-implementation-plan.md`,
and the guides `src/query-engine/AGENTS.md`, `src/query-engine/README.md`,
`src/query-engine/raptor3/AGENTS.md`. Base: the main tree's HEAD at launch
(commit 4, the C-01 cutover — record its sha). Never commit, stage, reset,
stash, push or run Biome `--write` on a whole file; the integrator commits.
CONTEXT.md, memory.md, exa-results/, the root corpora and the pre-G4
evidence stay untouched.

Arnaud's reason: the new engine was mainly about size; `pattern/` and what
it alone keeps alive are the remaining 3.4 points of plan §7's token-LOC
target and the last two typecheck diagnostics.

## What goes

1. `src/query-engine/pattern/**` — the retained experiment (19 files,
   about 10,600 lines). It is not exported from the package entry and no
   bundle fixture renders it. Its three importers outside itself are two
   owners it alone keeps alive (`builders/projection-select.ts`,
   `operations/mutation-projection-fold.ts`) and one docblock mention in
   `raptor3/shared/operation-context.ts:331` (a comment, restate it).
2. The 25 production owners the receipt lists as reachable only through
   `pattern/` (22 under `builders/` and `operations/`, and
   `write-engine/link-target-groups.ts`, `series-result-read.ts`,
   `target-projection.ts`) — verify each by re-running the receipt's
   method (import-graph reachability from the tsdown entry points) on the
   cutover tree BEFORE deleting; the set may have moved since stage 2 and
   the cutover.
3. The type anchor: `src/query-engine/types.ts:69` declares
   `PreparedBatchGuard.failure` as `import("./write-engine/OperationFragment").Failure`.
   Give that type one small owner (the shape the batch guard actually
   publishes — read what consumes `failure` before choosing), then re-run
   reachability: the `OperationFragment` → `record-series` →
   `OperationExecutor` chain and everything only it reaches
   (`relation-membership.ts`, `relation-nullability.ts`, `FragmentValidator.ts`,
   `race-retry.ts`, `messages.ts`, `generated-output-boundary.ts`, …) are
   deleted when nothing outside the deleted set imports them. Rule 12:
   moving a type to a named owner is fine; re-creating `OperationFragment`
   under another name is not.
4. `tests/pattern/**` (33 files) and the `layer-pattern` project in
   `vitest.workspace.ts`; the two Pattern TS2345 diagnostics disappear with
   them, so the terminating condition is now **zero** typecheck
   diagnostics. Prune `scripts/query-engine-test-manifest.mjs`,
   `scripts/driver-test-manifest.mjs`, `scripts/credential-free-test-manifest.mjs`
   and `scripts/coverage-policy.test.mjs` of every entry naming a deleted
   file (the cutover's round 2 shows how); no project may end up matching
   no file.
5. Tooling that names the experiment: `scripts/query-engine-structure.mjs`
   (its `pattern/` exclusion at :114 and the `/pattern/` filter at :356)
   and `scripts/measure-raptor3-baseline.mjs` (the excluded-experiment
   accounting): remove the special cases so the census counts the tree as
   it is; state the census before and after (the charged perimeter with
   and without the special case, so the numbers stay comparable with the
   frozen baseline).

## What stays, and how

- Owners the new engine or another surviving layer genuinely imports stay:
  `write-engine/parse-boundary.ts` (the new schema owner), the `builders/`
  and `operations/` helpers `raptor3/shared/query.ts` and `schema.ts`
  import (`distance-builder`, `set-builder`, `sort-order-builder`,
  `values-builder`, `where-builder`, `find-common`, `find-pagination`,
  `groupby`, `groupby-having`, `mutation-identity`), `JunctionStatements.ts`,
  `unique-conflict-target.ts`, `TargetConstraint.ts`, `batch-error-attribution.ts`
  and what they import, `result/**`, `validation/**`, `adapters/**`. Do not
  move them in this unit unless a file survives only as a one-line
  re-export shell; then fold it into its one consumer and say so. Rule 1:
  one owner per fact; rule 12: no wrapper-only files.
- `write-engine/shared.ts`: check whether anything still imports it once
  the chain is gone (the raptor3 mentions are comments); delete if
  orphaned, keep as a named boundary if imported.
- The `write-engine/` directory may end up with a handful of files. Do not
  rename or relocate the survivors in this unit; list them with their
  importers in the note as the follow-up "move the last boundaries under
  `raptor3/`".

## Decision-elimination gate (before the first deletion)

In `g4/pattern-retirement/note.md`: the reachability result on the cutover
tree (entries, reachable set, the pattern-only set with line counts), the
type-anchor decision, the exact deletion list, and for every surviving
`write-engine/`, `builders/`, `operations/` file the importer that keeps
it.

## Verification before hand-off (one mode per Bash call, bounded)

- `node scripts/run-typecheck.mjs`: **zero** diagnostics.
- `pnpm package:build`; the three bundle fixtures against
  `g4/cutover-execution/receipts/` (the post-cutover bundles): expected
  byte-identical, since nothing deleted was rendered; state every byte of
  difference.
- The qualification driver's groups on the retired tree: every surviving
  registered fixed mode, the native PostgreSQL and MySQL modes (ports from
  `docker port …`), the support group (receipts self-test, CLI self-test
  alone, structure census, driver integration, credential-free selectors),
  `pnpm test:core`, `pnpm test:coverage:policy`, the taxonomy census; the
  four G4 campaign first children byte-identical to the attempt-6 archives.
  Green everywhere; any red is a blocker.
- Plan §7 rows, grep-proven: no import of a deleted owner under `src/`; the
  cost census before and after (charged production token-LOC, physical,
  bytes against the frozen baseline 49,887 / 64,980 / 2,292,906 and the
  §7 targets); `captureRaptor3Identity` after the last edit.
- Guides: remove the deleted owners from `src/query-engine/AGENTS.md` and
  `README.md`; nothing speculative.

## Record

`g4/pattern-retirement/note.md` (the gate, the deletion list with per-file
line counts, the survivors and their importers, every receipt under
`g4/pattern-retirement/receipts/`, the census before and after, the
commit-message draft `refactor(query-engine): retire the pattern experiment
and the owners it kept alive`, follow-ups), `g4/pattern-retirement/retirement.patch`
(`git diff <base>`, proper headers). Return the structured summary.
