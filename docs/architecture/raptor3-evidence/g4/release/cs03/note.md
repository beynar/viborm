# Release unit "cs03" — note

Author: the integrator (Fable). Worktree `/private/tmp/viborm-cs03`, branch
`cs03` from `29622ac54`. `TMPDIR=/private/tmp/viborm-cs03-tmp`, exported for
every run below. Only file touched: `production`/test —
`tests/raptor3/core-structure/measurement/extension-a-scenario.ts` (a
measurement-harness scenario file under `tests/`, not `src/`; there is no
production-code change in this unit).

## 0. The finding, reproduced

`receipts/repro-before.log`: the credential-free stage's raptor3 gate,
`tests/raptor3/core-structure/measurement/extension-campaign.selftest.test.ts`,
under the cleared `VIBORM_RAPTOR3_REPLAY_PATH=`/`VIBORM_RAPTOR3_SPECIMEN=`/
`VIBORM_RAPTOR3_EVIDENCE_DIRECTORY=` environment — 10 of 42 red, all ten at
`tests/raptor3/harness/sqlite-world.ts:417`'s
`Missing semantic cut capture:nested/root-member/0; observed outcome: …`.

## 1. Per-cell attribution

All 10 red cells attribute to **one** ruling: **U6.2**
(`docs/architecture/raptor3-parity-plan.md` "U6 — Execution: membership,
series, recovery", item 2; confirmed against the shipped invariant at
`src/query-engine/raptor3/AGENTS.md` "Parity lane X", the paragraph beginning
"A nested relation mutation creates a PLANNING READ only when..."). No cell
needed D-29, D-32, D-46 or U1 (read per the brief's "What changed, by
design"; see §2 for why none of them applies here).

| Seed | Transport (`profile`) | `nestedShape` | `rootCount` | Missing cut(s) at the base | Ruling |
| --- | --- | --- | --- | --- | --- |
| 7109 | sqlite-interactive | deleteMany | 2 | `capture:nested/root-member/0`, `/1` | U6.2 |
| 7109 | sqlite-atomic-batch | deleteMany | 2 | same, plus a stale `recordSeriesProgress` formula | U6.2 |
| 7117 | sqlite-interactive | updateMany | 2 | `capture:nested/root-member/0`, `/1`, `admit:nested-member/0`, `/1` | U6.2 |
| 7117 | sqlite-atomic-batch | updateMany | 2 | same | U6.2 |
| 7119 | sqlite-interactive | deleteMany | 4 | `capture:nested/root-member/0..3` | U6.2 |
| 7119 | sqlite-atomic-batch | deleteMany | 4 | same, plus the stale progress formula | U6.2 |
| 7128 | sqlite-interactive | updateMany | 1 | `capture:nested/root-member/0`, `admit:nested-member/0` | U6.2 |
| 7128 | sqlite-atomic-batch | updateMany | 1 | same | U6.2 |
| 7149 | sqlite-interactive | deleteMany | 2 | `capture:nested/root-member/0`, `/1` | U6.2 |
| 7149 | sqlite-atomic-batch | deleteMany | 2 | same, plus the stale progress formula | U6.2 |

Every `updateMany`/`deleteMany` recipe this scenario generates is a **row-held
membership whose payload names no nested relation write** — the `deleteMany`
arm is a bare `{ deleteGroup: "deletable" }` filter and the `updateMany` arm's
`data` is two plain scalars — exactly U6.2's case: "a nested
`updateMany`/`deleteMany` on a ROW-HELD membership whose payload names no
relation is one `set` command — one statement, `WHERE fk = parent AND
filter`, no lookup, no `SelectedSeries`, no capture." So the fix is uniform
across all 10 cells; there is no cell needing a different ruling.

Three cells (7109, 7119, 7149) observe `TransactionError: updateMany with
'select' could not read back one of the updated rows…` rather than
`"success"`. This is **not** an outcome-kind regression: `recipe.outcome` for
these seeds is already `"missing-terminal-row"` (`recipe.missingTerminalRow:
true`), by the recipe's own seed data — each root's `parentId` chains to
another root (`node.parentId` self-references `node.id`), so one root's
nested `deleteMany` deletes a row the outer `updateMany`'s own read-back still
expects. `observation.outcome.kind` already equalled
`recipe.outcome === "success" ? "success" : "failure"` on the unfixed tree,
for every one of the 10 cells — confirmed directly (`receipts/diagnostic-
reachedCuts-dump.log`), not inferred. There is accordingly no U1 (empty-filter
admission refusal) or D-29 (queued-premise ordering) attribution to make, and
no genuine engine regression: nothing here is a STOP/blocker.

## 2. What changed, and where (one owner: `extension-a-scenario.ts`)

Ground truth for the fix was read off the real engine, not derived on paper:
`runSQLiteWorld` was driven directly (bypassing `fixture.assert`, which
throws at the FIRST missing required cut and hides everything after it) for
all 5 seeds x 2 profiles, dumping the full `observation.reachedCuts`
(`receipts/diagnostic-reachedCuts-dump.log`). Reading:

- `admit:nested-template` and `admit:nested-template/root-member/N` (the
  nested payload's own admission, once globally and once per root member)
  **still fire** — U6.2 removes the plan-time lookup and the captured series,
  not the template's admission.
- `capture:nested/root-member/N` (the plan-time lookup) **never fires**, for
  either shape — U6.2's "no lookup".
- `admit:nested-member/N` (the second, per-captured-member re-admission pass
  that only `updateMany` had) **never fires** — there is no captured member
  left to re-admit against.
- `effect:${nestedShape}/root-member/N` still fires once per root member,
  still after that member's own `effect:root/N` — the one correlated
  statement still runs at its declared body position.

Four edits, all in `extensionAScenario`'s `requiredCuts` and `assert()`
(diff: `git diff -- tests/raptor3/core-structure/measurement/extension-a-
scenario.ts`, 36 insertions / 48 deletions):

1. **`requiredCuts`** — dropped the `capture:nested/root-member/N` and
   `admit:nested-member/N` sub-arrays. Kept `admit:nested-template` and
   `admit:nested-template/root-member/N` (still required, still reached).
2. **`assert()`'s per-member ordering block** — the `capture:nested/root-
   member/N`-anchored `assertScheduled` calls (three call sites: the
   `deleteMany` member>0 branch, the `updateMany`/else branch, and the tail
   "member+1 < rootCount" special case for `deleteMany`'s member 0) are
   removed rather than re-pointed at a substitute cut. `assertScheduled`
   cross-checks `recipe.schedule` (built by `extension-recipes.ts`'s
   `extensionASchedule`, a **different** owner the brief scopes out of this
   unit) as well as `observation.reachedCuts`, and no non-capture edge for
   these three relationships exists in `recipe.schedule` — inventing one
   would have needed a second owner's edit. The edge that **does** survive in
   both `recipe.schedule` and reality — the root member's own effect before
   its nested set's effect — is kept unchanged. `deleteMany`'s member-0 tail
   case (whose row never gets its own `effect:deleteMany/root-member/0` cut
   either — the numbering already names the row by whichever member's delete
   removed it) is simply skipped: there is no surviving per-member nested cut
   left to anchor it to.
3. **`nestedAdmission` count** — `recipe.rootCount + 1` for both shapes now
   (one template admission plus one per root member); no longer
   `recipe.rootCount * 2 + 1` for `updateMany` alone, since the eliminated
   second admission pass was the only source of the extra `rootCount`.
4. **`assertFailure`'s `recordSeriesProgress` formula** (the atomic-batch
   `missing-terminal-row` deleteMany cells only) — `recipe.rootCount`, not
   `recipe.rootCount * 2 - 1`: a written root member (its own write plus its
   now-one-statement nested set) is one committed progress unit, not two.

Every other cut — `admit:root-template`, `capture:roots/N`, `admit:root-
member/N`, `effect:root/N`, the `choice:*` cuts for the upsert shapes (which
this fix does not touch — no upsert-shaped recipe was among the 10 red
cells), `effect:${nestedShape}/root-member/N`, `result:terminal-roots`, and
every success-path data assertion (`expectedLabels`, the final-row checks) —
is unchanged and still required; nothing that still holds was deleted or
weakened.

## 3. Falsifier

`receipts/falsification-record.md` (full detail): fixed content green (42/
42, `receipts/selftest-after-fix.log`); the re-expression reverted in a
scratch copy (never `git checkout` on the dirty file — the fixed content was
backed up to the scratch `TMPDIR` first, the pre-fix `HEAD` content written
to the real path, then restored from the scratch backup by `cp`, confirmed
byte-identical by `diff`) reproduces the original 10 red cells exactly; the
restored fix is green again (42/42).

Fixed modes unchanged (`receipts/fixed-modes.log`,
`receipts/mode-*.verified.json`, `receipts/mode-*.vitest.json`):
`cs01-extension-a` 6/6, `cs03-member-scope` 8/8, `g2-baseline` 216/216 (`node
scripts/run-raptor3.mjs <mode>`).

Whole-estate typecheck: 0 diagnostics, exit 0 (`receipts/typecheck.log`,
`node scripts/run-typecheck.mjs`).

`npx biome check` on the one touched file: 22 diagnostics, the identical set
at the file's own `HEAD` baseline and after the fix, checked at the same real
path (`receipts/biome-check.log`): 21 pre-existing
`lint/suspicious/noMisplacedAssertion` on this scenario file's `assert*`
helper calls plus 1 pre-existing formatter diff; none introduced or removed by
this diff (the reviewer's breakdown, `review.md`).

## 4. Stage run — `pnpm test:all`'s raptor3 stage alone

`node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts
--project=raptor3 <the 65 files of RAPTOR3_FIXED_LOCAL_TESTS from
scripts/credential-free-test-manifest.mjs>`, same cleared environment:
**65 files passed, 758 tests passed, 0 failed**
(`receipts/raptor3-stage-65-files-green.log`). The credential-free gate's
raptor3 stage is green.

## 5. Deliverables

- The re-expressed scenario: `tests/raptor3/core-structure/measurement/
  extension-a-scenario.ts` (diff above).
- This note.
- `receipts/`: `repro-before.log` (pre-existing, captured at first
  reproduction), `diagnostic-reachedCuts-dump.log`, `selftest-after-fix.log`,
  `falsification-record.md`, `fixed-modes.log` +
  `mode-{cs01-extension-a,cs03-member-scope,g2-baseline}.{verified,vitest}.json`,
  `typecheck.log`, `biome-check.log`, `raptor3-stage-65-files-green.log`.
- Reviewer writes `review.md` (ACCEPT / REVISE / BLOCK) — not authored here.

## 6. Rules followed

No patchwork: one fact (which cuts a given plan reaches) has one owner
(`extension-a-scenario.ts`'s `requiredCuts`/`assert()`); no second reader was
added, no policy boolean, no new class. Refusals treated as contracts:
nothing in `sqlite-world.ts`'s assertion owner, `extension-recipes.ts`'s
schedule generation, or any other file's ownership was touched or worked
around. Nothing was deleted, weakened, or skipped to go green — every cut
still produced by the engine is still required, and the three ordering
checks that were removed named a cut that no longer exists in any of the
recipes this scenario generates (verified, not assumed, via the direct
`reachedCuts` dump). No test was `.skip`ped. Never committed, staged, reset,
stashed or pushed; nothing written outside this worktree.
