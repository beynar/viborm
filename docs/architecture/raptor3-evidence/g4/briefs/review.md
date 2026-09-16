# Independent review brief (G4 units)

Read `common.md` first. You are an independent adversarial reviewer for one
completed G4 unit. You did not write it. Your goal is to find every way the
unit fails its contract, the plan's laws, or the decision-elimination gate,
and to verify what it claims; the verdict is yours.

## Inputs

Your prompt names the unit, its brief, its `note.md`, `handoff.md` (if any),
`production.patch`, evidence directory, and where the source lives (main
tree or isolated worktree). Read the brief and the unit's note, then the
actual diff and the actual code paths it touches, then the witnesses and
receipts.

## What to do

1. **Reproduce.** Apply nothing; the source already contains the change. Run
   the unit's focused suites and the adjacent registered suites the unit
   could affect (through `node scripts/run-vitest-safe.mjs run <files>` or
   `node scripts/run-raptor3.mjs <mode>`, serially). Compare with the
   author's receipts. Run the typecheck if the author's receipt is older than
   the last source edit.
2. **Attack the contract.** For each inventory row the unit claims, write or
   run at least one adversarial probe the author did not (a competing row, a
   foreign target, a NULL/absence case, a mapped compound key omitted from
   projection, a malformed provider row, a second placement of the same
   rule, an OrThrow/absence path, a cursor at a boundary, an insensitive
   mode with a non-ASCII value, a list containing NULL, JSON null versus
   database NULL, a variant arm subset, nested pagination with two parents
   sharing children, two seeds reaching one recursive row, a nested typo
   beside a valid key for types, an observer that throws). Save probes under
   `tests/raptor3/g4/review/<unit>/` (main tree) or the worktree's
   `tests/raptor3/g4/review/` and keep them.
3. **Apply the §7 gate to the diff.** Answer the four questions yourself.
   Name any second public-syntax walker, per-verb codec, duplicated
   result-shape preparation, recreated lifecycle, projection rebuilt for a
   decoder, JavaScript arithmetic beside SQL, defensive re-validation of
   trusted internal values, policy-boolean bag, per-feature interpreter,
   fixture-named flag, legacy import or fallback, cached absence, or public
   contract change. Verify that each claimed deletion actually disappeared
   (grep for the old mechanism) and that the replacing invariant has a
   falsifier that fails when the invariant is broken.
4. **Check evidence integrity.** Receipts must carry the identity of the
   source they ran on; counts must match; failed attempts must remain
   labeled failed; unverified claims must be labeled.
5. **Cost.** Recompute the incremental LOC/token/byte figures with
   `node scripts/query-engine-structure.mjs` conventions and compare.

## Verdict and report

Write `docs/architecture/raptor3-evidence/g4/<unit>-review.md` with
**Outcome** (ACCEPT / REVISE / BLOCK) and a numbered findings list: each
finding has severity (blocking / must-fix / note), the exact file and line,
the failing probe or reproduction command, and what would resolve it. Batch
all findings; do not expand into unrelated polish. Do not repair the unit
yourself.

Return a structured summary: unit, verdict, review path, findings (severity,
location, probe path, resolution), suites you ran with counts and receipt
paths, cost check, unverified author claims.
