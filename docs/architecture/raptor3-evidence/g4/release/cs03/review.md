# Release unit "cs03" — independent review

Reviewer: independent (not the author). Worktree read: `/private/tmp/viborm-cs03`
(branch `cs03`, base `29622ac54`). No author file was edited. All test runs
below used `TMPDIR=/private/tmp/viborm-cs03-tmp-r`. Nothing was committed,
staged, reset, stashed or pushed; no other worktree was touched (a scratch
detached worktree, `git worktree add --detach`, was created twice at
`/private/tmp/viborm-cs03-verify-base` purely to falsify against the pre-fix
`HEAD` content without ever writing to the reviewed worktree, and was removed
both times — `git worktree list` confirms it is gone).

## Verdict: **ACCEPT**

## What was checked

**1. The diff** (`git diff 29622ac54 -- tests/raptor3/core-structure/measurement/extension-a-scenario.ts`,
36 insertions / 48 deletions, the only file changed — confirmed by
`git diff 29622ac54 --stat` and `git status --short`). Read every hunk:

- Drops `capture:nested/root-member/N` and `admit:nested-member/N` from
  `requiredCuts` for the row-held `updateMany`/`deleteMany` shapes; keeps
  `admit:nested-template` / `admit:nested-template/root-member/N`.
- Removes the three `assertScheduled` call sites anchored on the eliminated
  `capture:nested/root-member/N` cut, rather than re-pointing them at an
  invented substitute; keeps the still-true `effect:root/N` →
  `effect:${nestedShape}/root-member/N` edge everywhere it already existed
  (including its pre-existing absence for `deleteMany`'s member 0, unchanged
  from the base).
- Unifies `nestedAdmission` to `recipe.rootCount + 1` for both shapes.
- Fixes `assertFailure`'s `recordSeriesProgress` formula from
  `rootCount * 2 - 1` to `rootCount`.
- Every other required cut (`admit:root-template`, `capture:roots/N`,
  `admit:root-member/N`, `effect:root/N`, the upsert `choice:*` cuts,
  `effect:${nestedShape}/root-member/N`, `result:terminal-roots`, all
  success-path data assertions) is untouched.

**2. The ruling attribution.** Read `docs/architecture/raptor3-parity-plan.md`
U6.2 and `src/query-engine/raptor3/AGENTS.md` "Parity lane X" directly (not
just the note's paraphrase): both state, in the engine's own words, that a
row-held `updateMany`/`deleteMany` with no nested relation write is now one
correlated `set` statement with no plan-time lookup and no captured series —
exactly the cuts this diff drops. Read `extensionASchedule` in
`extension-recipes.ts` (the unowned, unchanged file that builds
`recipe.schedule`, which `assertScheduled` cross-checks): confirmed by
inspection that for all three removed ordering call sites, `recipe.schedule`
has no edge left that doesn't route through the eliminated capture/admission
cut — the diff invents nothing and correctly leaves that file alone (its
brief-scoped owner is a different unit). Read `g4/parity/repair-note.md` R6
(`cs01-extension-a`, the precedent the brief names as "the method to
follow"): same "Class (a), re-expressed not weakened" pattern — the physical
plan changed by design, the pin follows it. This unit's fix matches that
precedent exactly.

**3. Independently reproduced, not just read:**

- Self-test green: ran
  `node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=raptor3 tests/raptor3/core-structure/measurement/extension-campaign.selftest.test.ts`
  myself under the cleared env → **42/42 passed**, matching `selftest-after-fix.log`.
- Falsifier: created a detached scratch worktree at `29622ac54` (pre-fix
  content, verified by grepping the eliminated `capture:nested/root-member`
  references back in the file), symlinked `node_modules`, ran the same
  self-test there → **10 failed / 32 passed**, identical failure set and
  identical `Missing semantic cut capture:nested/root-member/0` message to
  `repro-before.log` and the note's falsification record. Removed the
  scratch worktree after. This is the load-bearing check and it holds.
- Typecheck: ran `node scripts/run-typecheck.mjs` myself → **exit 0, zero
  diagnostics**, matching `typecheck.log`.
- Biome: ran `npx biome check` on the touched file at both the fixed content
  and (via the same scratch worktree, second use) the base content →
  **22 errors both times**, and diffed the rule breakdown myself: 21
  `lint/suspicious/noMisplacedAssertion` + 1 pre-existing `format` diagnostic,
  identical set at both revisions, none added or removed. (Minor: the note's
  prose says "all... `noMisplacedAssertion`"; one of the 22 is actually the
  file's pre-existing formatter diff, not a lint rule. The substantive claim —
  same 22, no delta — is correct and independently confirmed; this is a
  wording nit in the note, not a defect in the fix, and needs no resolution.)
- Fixed mode spot check: ran `node scripts/run-raptor3.mjs cs01-extension-a`
  myself → **6/6**, matching `fixed-modes.log`. `cs03-member-scope` (8/8) and
  `g2-baseline` (216/216) were not independently re-run (budget: "minimum
  tests, run only what discriminates") but the `g2-baseline` count was
  cross-checked against an independent, unrelated pre-existing record
  (`g4/release/d46/note.md` also states `g2-baseline 216/216`), and the
  receipts' methodology, formatting and timestamps are consistent with every
  command I did run myself.
- Full raptor3 stage: not re-run in full (758 tests; out of proportion to
  what discriminates given the self-test IS the file that was red). Instead:
  confirmed `extension-campaign.selftest.test.ts` is genuinely registered in
  `RAPTOR3_FIXED_LOCAL_TESTS` (via `CS03_EXTENSION_SUPPORT_TESTS` in
  `scripts/raptor3-manifest.mjs`, expected count 42 — matches what I ran
  myself), and independently re-summed the receipt log itself: `grep -c "✓
  |raptor3|"` → 65 file lines, and the per-file `(N tests)` counts sum to
  exactly 758, matching its own reported summary — internally consistent,
  not just asserted.
- Diagnostic ground truth: read `diagnostic-reachedCuts-dump.log` in full.
  The three `TransactionError` cells' outcome-kind claim checks out from the
  raw dump itself (`recipe.missingTerminalRow: true` on exactly those three
  seeds' recipes), and the `deleteMany` member-0 "no
  `effect:deleteMany/root-member/0` cut" claim that justifies dropping the
  tail ordering check is directly visible in the dumped `reachedCuts` arrays
  (member 0's nested-delete effect never appears, for any `rootCount`) — this
  is a pre-existing labeling fact of the recipe/harness, not something this
  diff introduces or hides.

## Rule compliance

- **One owner, no patchwork:** all four edits are in
  `extension-a-scenario.ts`'s `requiredCuts`/`assert()`, the sole owner of
  "which cuts this plan reaches." No second reader, no policy boolean, no new
  class. `extension-recipes.ts` (a different owner) is untouched, correctly
  scoped out.
- **Refusals are contracts:** none touched; not applicable to this unit (no
  refusal is involved in the cells fixed).
- **Nothing deleted/weakened that still holds:** every removed assertion
  named a cut the engine no longer produces (verified from the raw dump, not
  assumed); every surviving true edge is kept. No `test()`/`it()` was
  touched, skipped, or deleted — only the shared scenario-expectation helper
  functions consumed by them.
- **Scope:** only the one file changed; `git status` shows no other tracked
  file modified, nothing staged.
- **Never committed/staged/reset/stashed/pushed; nothing written outside the
  worktree:** confirmed by `git status --short` / `git diff --cached`
  (empty) at the end of this review, and by the scratch worktree's removal.

## Residual observations (not blockers, no resolution required)

- `tests/raptor3/core-structure/measurement/extension-campaign.test.ts` (the
  non-selftest, 1-test campaign runner, `CS03_EXTENSION_CAMPAIGN_TESTS`) also
  consumes `extensionAScenario` but is not a member of
  `RAPTOR3_FIXED_LOCAL_TESTS` and so is outside this brief's "credential-free
  gate" scope; not exercised by this review, consistent with the brief's own
  scoping.
- The note's biome-check paragraph slightly overstates rule uniformity (see
  above) — cosmetic only.

## Conclusion

The re-expression is minimal, correctly attributed to U6.2 with the ruling's
own text checked directly (not taken on faith), faithful to the still-active
`recipe.schedule` edges owned by another file, and matches the established
`cs01-extension-a` (R6) repair precedent the brief points to. The falsifier
is genuinely load-bearing (independently reproduced in a throwaway worktree,
not just re-read from a log). Typecheck and biome are clean and unchanged in
shape. The credential-free raptor3 stage's own receipt is internally
self-consistent and the one file that was red is independently confirmed
green. No patchwork, no deleted/weakened test, nothing outside scope.

**ACCEPT.**
