# Gate triage — the old engine's PGlite contract suites against the shipped engine (brief)

Integrator: Fable. Read-only classification. Repository `/Users/arnaud/code/viborm`
(branch `pattern-engine`, head `7bc08ebd9` plus one uncommitted unit: the decimal
seam `src/query-engine/raptor3/shared/decimal.ts`, not your concern). **You edit
NOTHING under the repository.** Your only write target is your family's note
under `/private/tmp/claude-501/-Users-arnaud-code-viborm/c2c775da-2927-4590-8677-3bb0f5d1aa98/scratchpad/triage/`.
Every test run exports `TMPDIR=/private/tmp/viborm-triage-<family>-tmp` (yours
alone; `mkdir -p` it). Never commit, stage, reset, stash, push, or touch any
other worktree. Never delete, weaken or `.skip` a test.

## The finding

The credential-free gate (`pnpm test:all`, what CI runs) stops at its first red
stage, and since the engine cutover it stopped before its `extended-local
shared-family` stages, so the retired engine's contract suites under
`tests/contracts/engine/{query,write}/` and `tests/contracts/public-client/`
(live PGlite, the shared model families) were never measured against the
shipped engine (Raptor 3, `src/query-engine/raptor3/`). Measured tonight, one
shard at a time: 184 red cells in 41 files (logs:
`scratchpad/gate-inventory/*.log`). The census of the parity program
(`docs/architecture/raptor3-parity-plan.md`, ledger `docs/architecture/raptor3-evidence/g4.md`)
never named these suites.

## What you classify

Every red cell of your family's files, one row each, into exactly one class:

- **A — physical-plan pin.** The cell pins the retired engine's physical plan
  (SQL text, statement count, CTE fold shape, batch segmentation, an alias) and
  the observable result is the same under the shipped engine. Re-expression is
  allowed only where the plan changed by design; you NAME the ruling or the
  unit note that changed it (grep `g4.md`, `g4/*/note.md`,
  `src/query-engine/raptor3/AGENTS.md`). No ruling found = not class A.
- **B — a registered Raptor 3 refusal replaces retired behavior.** The shipped
  engine refuses a shape the retired engine executed (or refuses with another
  class or sentence). Find the refusal's registration:
  `docs/architecture/raptor3-evidence/g4/root-review-C-receipts/refusals.json`,
  `refusal-census.txt`, `unit03/note.md`, the ledger's D-rulings, the guide.
  Say whether the registration names THIS shape and whether a ruling accepted
  the loss; quote the registration. Refusals are contracts: a registered
  refusal with a ruling is B-ruled; a refusal without a ruling for this shape
  is B-open.
- **C — a defect in the shipped engine.** The observable result (rows,
  identities, error class the public contract promises, a constraint
  violation that should have been prevented) differs and no ruling covers
  it. Give the smallest reproduction (model, operation, transport) and the
  engine site (`file:line`) you believe owns it.
- **D — the test's premise is gone.** The cell reaches a retired internal
  (`write-engine`, `query-engine-v2` internals, an instrumentation attribute
  of the retired engine, a runner-only replay/specimen environment). Say what
  it reached and where the equivalent shipped fact is pinned (or is not).

## Method

1. Run your family's files once, one file per call:
   `node scripts/run-vitest-safe.mjs --project extended-local <file>` (wait 20 s
   and retry on a lock refusal; never remove a lock). Keep the outputs in your
   TMPDIR and cite them.
2. Read each red cell's source and the engine site the error names. Read the
   rulings before deciding a class. Read `docs/architecture/raptor3-evidence/g4/briefs/common.md`
   (the twelve rules) first.
3. Write your note: a table `file | cell | class | one-sentence reason |
   ruling or registration or engine site`, then per class a paragraph: for A
   the ruling per group; for B the registration quotes and whether ruled; for
   C the reproduction and suspected owner; for D what was reached. End with
   "Unverified" (what you could not run or find) and "Blockers".
4. Speed: no whole-project runs, no typecheck, no builds. The minimum that
   discriminates. Do not attempt fixes.

Return the structured summary the task asks for.
