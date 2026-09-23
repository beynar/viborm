# Review, round 2 — the repair round of D-39 and D-41

Independent reviewer, re-check. Worktree `/private/tmp/viborm-o1`, branch `o1`,
HEAD still `383f830c` (unmoved). `TMPDIR=/private/tmp/viborm-o1-tmp-r` exported
for every run; one file, one project or one registered mode per call, never two
at once; no lock refusal was met, so nothing was retried and no lock was
removed. I edited no file of the author's: my only writes are this file and the
`r2-*` receipts in `review-receipts/`. Nothing was committed, staged, reset,
stashed or pushed. `/Users/arnaud/code/viborm` and `/private/tmp/viborm-o2` were
never touched.

## Verdict: ACCEPT

Round 1's single finding (F-1, evidence only: both falsification receipts were
taken against earlier revisions of the two pinned files) is resolved. The author
took resolution 1 — re-ran both falsifiers against the delivered files — and the
two new receipts show the *delivered* assertion forms failing under the weakened
mechanisms, at the delivered line numbers. Nothing else moved, and I can prove
that from git and from hashes rather than take it on the note's word. Every gate
the brief names that can run here is green on my own re-runs; the whole-estate
typecheck is zero at exit 0.

No new finding. Two observations of record (§4), neither a defect. The open
items are decisions for Arnaud, not work for the author (§5).

---

## 1. The resolution, and whether it was applied exactly

F-1 offered two resolutions, author's choice. The author took **1** and recorded
why (§10 of `note.md`): resolution 2 would have left a receipt-to-tree mismatch
standing behind a sentence explaining it.

What resolution 1 required, and what I verified:

| required | delivered | how I checked |
| --- | --- | --- |
| F2 (D-39) re-run with both legs weakened, against the delivered cells | `receipts/repair-d39-falsification-per-hook-leg.log`: RED, `2 failed / 5 passed`, at `consumable-result-proof.core.test.ts:274` and `:278`, each on `expect(consumableAnswers(FAMILY)).toEqual(STOCK_ONLY)` | read the receipt in full; both diffs move exactly one key, `withFieldMiddleware: false → true`, with `stock: true`, `withResultMiddleware: false`, `withReenteredAdapter: false` unmoved. `:274`/`:278` are the delivered cells in the tree as I read it now |
| F1 (D-41) re-run with `publishedTerminal` counting over the concatenation, against the delivered cell | `receipts/repair-d41-falsification-concatenated-count.log`: RED, `2 failed / 4 passed`; cell 6 "raises a short window's own registered refusal, before the boundary" fails at `driver-result-parser.test.ts:412` on the delivered `assert.match(failure.message, SHORT_WINDOW_REFUSAL)` with `'Raptor 3 createMany final read returned inconsistent row counts.'`; cell 5 reddens with the same internal message | read the receipt in full; `:412` is `assert.match(failure.message, SHORT_WINDOW_REFUSAL)` in the tree as I read it now, and the failing title is the delivered title, not round 1's "above the boundary" |
| restore, then re-run green | `repair-d39-consumable-result-proof.log` 14/14 (both projects), `repair-d41-pin.log` 6/6, `repair-typecheck.log` | reproduced all three myself (§3) |
| the citations in §2.4 and §3.4 to move to the new receipts | both rows now cite the `repair-` receipts, and each carries a paragraph naming the round-1 receipt as the same mutation against the earlier cell layout, superseded and kept | read both sections; §6 gained the two new rows and two rows labelling the round-1 runs "superseded, kept" |

**One deviation from the resolution's wording, and it is the right one.**
Resolution 1 said "replace the two receipts". The author did not delete or
overwrite them: `receipts/d39-falsification-per-hook-leg.log` and
`receipts/d41-falsification-concatenated-count.log` stay on disk unaltered
(mtimes 23:52 and 23:46, before the repair round's 00:20–00:22) and are recorded
as superseded. That is what `common.md`'s evidence discipline requires — a
receipt is never relabelled or discarded — so overwriting them would have traded
one record defect for another. The substance of F-1 (the cited falsification
must be of the delivered tree) is satisfied. Accepted as delivered.

## 2. "Nothing else moved" — proved, not asserted

- `git status --porcelain` is exactly the four files of the unit plus the
  untracked `rulings/o1/` directory. Nothing else in the worktree is modified or
  untracked.
- The delivered change **is** `git diff 383f830c -- src tests`, which I read hunk
  by hunk this round. Any byte the repair round's mutate/restore had altered
  anywhere else in those four files would appear in that diff, and none does —
  so the rest of all four files is byte-identical to `383f830c` by construction.
  `--numstat` still reads `21 1 / 22 13 / 101 20 / 87 7`, so §8's LOC stands.
- `src/query-engine/raptor3/shared/operation-context.ts` — the file the D-41
  falsifier mutates and the one file this unit does not own — is **byte-identical
  to HEAD**: `git diff --stat 383f830c` on it is empty. Its restore is proved by
  git, not by the note.
- The two driver files' sha256 match the block recorded in §10.2 **and** the
  author's pre-mutation backups, which I hashed myself in
  `…/scratchpad/o1-repair-falsify/` (taken 00:20, before either mutation):
  `9625…c60d` (sqlite3), `56c4…d437d` (pglite), `1fbb…3576`
  (operation-context). All six values agree.
- No leftover weakening: `grep -rn "result?.parseResult\|canonicalDriverParseResult" src/drivers/`
  returns nothing; the two legs read `driver.result === sqliteResultParser`
  (`sqlite3/index.ts:239`) and `driver.result === undefined`
  (`pglite/index.ts:252`).
- Both test files' mtimes (23:57) predate round 1's read, and their content still
  matches every line citation round 1 made. `review.md` is untouched (mtime
  00:16); so are the round-1 receipts and my own round-1 `review-receipts/`.
- No test was deleted, weakened or skipped: `layer-drivers` still answers 975
  (D-35 left 974, +1 because one cell became two), `provider-sqlite3` 755 passed
  / 1 skipped — the same skip as D-35's baseline.

## 3. My re-runs (round 2, mine)

| run | result | wall / peak RSS | receipt |
| --- | --- | --- | --- |
| `drivers/consumable-result-proof.core.test.ts` (both projects) | **14/14** | 5.47 s / 444.6 MiB | `r2-d39-consumable-result-proof.log` |
| `g4/parity/driver-result-parser.test.ts` (`extended-local`) | **6/6** | 3.80 s / 471.4 MiB | `r2-d41-driver-result-parser.log` |
| `layer-drivers` (whole project) | **975/975**, 43 files | 5.31 s / 652.3 MiB | `r2-layer-drivers.log` |
| `provider-sqlite3` (whole project, live better-sqlite3) | **755 passed, 1 skipped**, 6 files | 9.43 s / 605.7 MiB | `r2-provider-sqlite3.log` |
| `run-raptor3.mjs g3-execution-review` | **6/6**, gate verified | 4.24 s / 438.4 MiB | `r2-mode-g3-execution-review.log` |
| `run-raptor3.mjs g2-baseline` | **216/216**, gate verified | 5.60 s / 697.0 MiB | `r2-mode-g2-baseline.log` |
| `node scripts/run-typecheck.mjs` (whole estate) | **0 diagnostics, exit 0** | 7.86 s / 5072.5 MiB | `r2-typecheck.log` |
| `npx biome check` on the four touched files | **clean**, 0 diagnostics | — | — |

The two raptor3 modes matter here beyond round 1: they are what exercises
`operation-context.ts`, the file the D-41 falsifier mutated. Green, on a file git
proves identical to HEAD.

## 4. Observations of record (neither is a finding)

- **O-1.** The D-39 repair falsifier ran in `layer-drivers` only, while the
  delivered green run covers `layer-drivers` and `coverage-drivers` (14/14). The
  two projects both `extend: "./vitest.config.ts"` and differ only in their
  include globs (`vitest.workspace.ts:96-124`), so the second registration of the
  same file cannot answer differently, and running one is the brief's minimum.
  Recorded so the record is exact.
- **O-2.** `receipts/repair-typecheck.log` carries only the bounded runner's
  resources line — no exit code and no "0 diagnostics" line (the same shape as
  round 1's `typecheck.log`; the runner prints diagnostics when there are any, so
  a bare line means none). The note's "exit 0" was therefore inferred from the
  receipt rather than shown by it. I re-ran it and captured `EXIT=0` in
  `review-receipts/r2-typecheck.log`, so the claim is now measured.

## 5. Still open — these are questions for Arnaud, not work for the author

Nobody in this unit has decided any of them, and nothing is blocked on them.

1. **Q1 — D-41's "asked once".** The brief asked the new cell to assert the
   driver middleware is still asked once; the author refused and pinned
   `assert.deepEqual(driver.observed, [])` instead, because as shipped the
   middleware is asked **zero** times (I measured the same in round 1: "asked
   once" is what the *falsified* pre-repair shape produces). Leave the pin as
   delivered, or do you want the brief's wording honoured by moving the count
   below the middleware again?
2. **Q2 — the live PGlite lane.** The brief's `--rss-limit-mb=2560` is refused by
   the runner it names, and the smallest live PGlite file breaches the ordinary
   1536 MiB ceiling with the change (1676.9 MiB) and without it (1680.9 MiB
   at `383f830c`). Do you want that lane re-enabled for unit work, accept the
   PGlite surface check as measured only on constructed `PGliteDriver`
   instances, or something else?
3. **Q3 — PGlite's `undefined` literal.** `driver.result === undefined` is the
   comparison; the author rejected a named `canonicalResult = undefined` as a
   second place stating "this class ships no parser". Ruling wanted?
4. **Q4 — the changelog.** Untouched, on the argument that no shipped answer
   changes (no path in `src/` installs a driver `result` surface). Confirm, or
   do you want a line?
5. **Q5 — the re-expressed D-35 cell.** D-35's cell became two family cells over
   one answer object; the same two facts are still pinned, two more were added.
   Accept, or do you want D-35's cell kept verbatim beside them?
6. **Q6 (mine, round 1).** `sqliteResultParser` is now named twice in
   `src/drivers/sqlite3/index.ts` — at the `result` field (`:79`) and at the
   comparison (`:239`). Both read the same owned object and divergence fails
   SAFE, so neither of us counted it as patchwork. One named source, or leave it?
7. **Q7 (mine, this round).** The two superseded round-1 falsification receipts
   now sit in `receipts/` beside the ones the note cites, distinguished only by
   filename prefix and by §6's labels. Keep them flat, or move them to a
   `receipts/superseded/` so a later reader cannot mistake them for the
   delivered record? (Evidence discipline forbids deleting them either way.)

## 6. Carried forward, unchanged by this round

- **Blocker (environmental, pre-existing, confirmed by me in round 1 by being
  refused).** The live PGlite provider lane cannot be run under the runner the
  brief names. See Q2.
- **Still red, unrelated.** `contracts/architecture/contract-matrix.core.test.ts`
  > "inventories every executable test by owner and boundary", on the
  unclassified `tests/raptor3/candidate-handoff.test.ts` (committed `cf2cbc4e6`).
  Not re-run this round: the repair changed no test file, and §2 proves the tree
  it inventories is byte-identical to the one it measured in round 1
  (`review-receipts/r-contract-matrix.log`, 4/5).
- **Unverified claims.** The three in §9 stand as stated and are correctly
  labelled: no live PGlite / bun-sqlite / d1 verification of claim 1; the
  consumable mechanism still has no caller in `src/`; no short-window witness
  outside cell 6, MySQL unmeasured.
- **Process deviation, disclosed.** `note.md` was written after the production
  edits, contrary to the decision-elimination gate. Recorded by the author, not
  papered over; accepted as disclosed in round 1 and unchanged here.
