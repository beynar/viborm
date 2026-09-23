# D-35 — independent review, round 2 (the repair round)

Reviewer: independent (not the author), second round. Worktree
`/private/tmp/viborm-d35`, branch `d35`, base `fd441c7f5`.
`TMPDIR=/private/tmp/viborm-d35-tmp-r` exported for every run. Nothing
committed, staged, reset, stashed or pushed; no file of the author's was
edited; nothing written outside the worktree except the mandated TMPDIR. My
receipts are in
`docs/architecture/raptor3-evidence/g4/rulings/d35/review2-receipts/`.

Scope of this round: round 1 returned **REVISE** with one required resolution,
R-1, in three documentary parts ("The code is right… One document is wrong").
This round checks that those three were applied exactly, that nothing else
moved, and that the tree is still green.

## Verdict: **ACCEPT**

All three parts of R-1 are applied, exactly and only. The two extras the author
took are disclosed in `note.md` §9 and are both required for truth or trivially
correct. No source or test byte changed in the repair round — proven three ways
below — so round 1's hunk-by-hunk verification stands, and my own re-runs of the
affected files, the affected project and the whole-estate typecheck are green.

## 1. The three resolutions, verified

| part | required | found |
| --- | --- | --- |
| **R-1.1** delete the two sentences from the changelog entry | `CHANGELOG.md` must end at "…and is unaffected in outcome." | Applied. `git diff fd441c7f5 -- CHANGELOG.md` is now `+8 −0`, one bullet in `## Unreleased`, ending exactly there. The sentences "A custom SQLite transport that renames the count column … is no longer recovered by the driver middleware; that row is refused with the public error class instead." and "No shipped SQLite provider renames it." appear nowhere in the file (grep). Nothing else in the entry drifted: the three surviving sentences still carry the brief's three required statements — the SQLite drivers no longer normalise count/exist at the driver-level `parseResult`; the engine's decoder answers them; a consumer that wrapped `driver.result.parseResult` is unaffected in outcome. No other line of `CHANGELOG.md` is touched. |
| **R-1.2** replace the paragraph beginning "The last two sentences go beyond the brief's required text" | the paragraph gone, or replaced by the measured fact | Applied, in the stronger of the two forms the review offered. `note.md` §Release note now states the deletion has **no** observable difference at all, including for an alias-losing transport, names the mechanism (`normalizeCountResult` writes `0viborm_count_result`; the decoder reads `_count`), lists `COUNT_RESULT_KEY`'s three readers as decoded-value readers, and attributes the measurement to the counterfactual receipt `review-receipts/counterfactual-alias-row.log`. It also says plainly that F2 measured the after-state only and was written up as though it had measured a difference. The offending paragraph is gone (grep for its opening words returns nothing). |
| **R-1.3** the F2 row must say what it measured | "showing exactly what the arm used to recover" out of the *expected* column; the *measured* column to state the after-state-only fact | Applied. §5 F2's expected column now reads "the cell reddens, showing it measures the decoder reading ITS alias"; the measured column keeps the red and its exact `V9001` message and adds "**This measures the after-state only**, not a difference: with the arm reconstructed from `fd441c7f5` the same row fails closed with the identical class, code and message (review R-1, `review-receipts/counterfactual-alias-row.log`), so the cell fails closed when the alias is lost and did so before the deletion too." The falsification is kept, not deleted or weakened. |

Consistency check the review did not ask for and I made anyway: the block quote
in `note.md` §Release note, introduced as "Its text, as written into the file",
is now **byte-identical** to the entry in `CHANGELOG.md` (compared
programmatically, whitespace-normalised: identical). Had the author dropped the
two sentences from the file only, the note would have become false about the
file; it did not.

## 2. Nothing else moved

Three independent checks, all agreeing:

1. **numstat.** `git diff --numstat fd441c7f5 -- src tests` is byte-for-byte the
   table round 1 verified: `11/14` `sqlite-utils.ts`, `9/0` `sqlite3/index.ts`,
   `8/5` `query.ts`, `24/1` `consumable-result-proof`, `58/32`
   `driver-export-surface`, `31/0` `parity-decoding`, `8/5`
   `driver-result-parser`. src +28 −19, tests +121 −38. `CHANGELOG.md` is the
   only other changed path, `+8 −0`.
2. **mtimes.** Every source and test file was last written at or before
   `22:32:14`; `review.md` was written at `22:50`, `CHANGELOG.md` at `22:52:30`,
   `note.md` at `22:56`. The repair round physically could not have touched
   `src/` or `tests/`.
3. **The diff itself.** I read the whole of `git diff fd441c7f5 -- src` and
   `-- tests` again in this round rather than trusting the numbers. It matches
   round 1's hunk table: the `parseResult` member deleted whole, the import
   collapsed to `parseIntegerBoolean`, the header re-stated as ROW VALUES only,
   the canonical identity unchanged code with its reason added, one doc comment
   in `query.ts`, three added cells, one extracted helper that keeps the same
   throw, two re-stated comments. No cell deleted, weakened, `.skip`-ed or
   renamed; no assertion relaxed.

State: `git status --porcelain -uall` is the eight modified files plus the
`rulings/d35/` directory; `git diff --cached` is empty; `HEAD` is still
`fd441c7f5`. Nothing staged, committed, stashed or reset.

## 3. The corrected claim is right on its own evidence

I did not take R-1's counterfactual on trust either. From the source, in this
tree:

- `extractCountValue` (`src/adapters/shared/result-parsing.ts:155-168`) accepts a
  row only when it has exactly one key and that key is `COUNT_RESULT_KEY`
  (`0viborm_count_result`) or lowercases to a `count(` prefix. `_count` is
  neither, so the deleted arm returned `undefined` and fell through to
  `next(raw, operation)` for every answer this engine asks for.
- The decoder reads `rows[0]?._count` (`raptor3/shared/query.ts:2970`, `:2973`)
  for the alias it aliased at `:2941`/`:2955`. `normalizeCountResult` produces
  `COUNT_RESULT_KEY`, which that path never reads.

So the arm was inert in both directions — it never recognised the engine's row,
and what it would have produced from a foreign row the decoder cannot read. The
corrected release note and the corrected F2 row say exactly this; the deleted
sentences said the opposite. The repair is not cosmetic, and it went into the
shipped file, which is where it mattered.

`normalizeCountResult` still has one live caller,
`src/adapters/databases/mysql/mysql-adapter.ts:1036` (the other hit,
`adapters/adapter-result-parser.ts:110`, is a doc example), so keeping it was
right and "now-unreferenced helpers" really are none.

## 4. Runs (mine, this round, serial, one file / project per call)

| run | result | receipt |
| --- | --- | --- |
| `node scripts/run-typecheck.mjs` (whole estate) | **0 diagnostics, exit 0**, 5.67 s, 4894.2 MiB peak (an earlier identical run in this session: 5.89 s, 4990.3 MiB) | `review2-receipts/typecheck.log` |
| `tests/contracts/engine/query/parity-decoding.core.test.ts` (the ruling's new cell) | **10/10** | `review2-receipts/parity-decoding.log` |
| `--project layer-drivers` (the two touched driver contract files and their neighbours) | **974/974, 43 files** | `review2-receipts/layer-drivers.log` |
| `tests/raptor3/g4/parity/driver-result-parser.test.ts` (D-28 pin, `extended-local`) | **5/5** | `review2-receipts/driver-result-parser-pin.log` |
| `npx biome check CHANGELOG.md` | "Checked 0 files… these paths were provided but ignored: CHANGELOG.md" — Biome's config ignores Markdown, so the author's "no formatting fix to make by hand" is correct | — |
| `grep -rl CHANGELOG tests scripts` | empty — no test or script reads the changelog, so the repair round's edits cannot move the test estate | — |

No lock refusal was met; no lock was removed; no two test or typecheck commands
ran at once.

**Not re-run, deliberately:** `provider-sqlite3`, `provider-libsql`, modes
`g2-baseline` and `g2-contracts`. Those bytes did not change in this round (§2),
and they are green twice on exactly them — the author's §6 and my own round-1 §4
(`review-receipts/provider-sqlite3.log` 755 passed / 1 skipped,
`provider-libsql.log` 9 passed / 663 pre-existing skips, `mode-g2-baseline.log`
and `mode-g2-contracts.log` 216/216 each, gate verified). Measuring the same
bytes a third time is not evidence, and the brief asks for the minimum.

## 5. The two extras the author took, judged

- **The block quote in `note.md` §Release note** was updated with the file. Not
  in the review's list, but required: the quote is introduced as the file's
  text. Leaving it would have made the note false. Correct to take.
- **"hunk 7 below" → "hunk 9 below"**, in the very sentence R-1.2 rewrote. The
  hunks table (§2) does list `CHANGELOG.md` as hunk 9. Disclosed in §9, no
  substance. Correct to take.

Nothing else in `note.md` changed that I can detect: §§1-8 still say what round 1
read them saying, including the per-cell re-expression table, the four §7
answers, the LOC figures and the still-red/unverified/blockers lists, and the
new §9 is an addition, not a rewrite.

## 6. R-2 — not applied, and that is acceptable

Round 1 marked R-2 (one clause saying that on these drivers `result.parseResult`
is now **absent**, so a consumer that *captured* the shipped function must check
before calling) explicitly "not required for ACCEPT". The author left the entry
alone, recorded the decision in §9 with the exact sentence ready for the
integrator, and checked the two facts behind it (`parseResult` is optional on
`DriverResultParser`; `bunSQLResultParser` is already a shipped `parseField`-only
parser, so the post-deletion shape is not novel). That is the right handling of a
recommendation under "apply the resolutions and nothing more": it is preserved as
a decision for Arnaud rather than silently taken or silently dropped. The entry
as it stands is the brief's required text and is accurate.

## 7. Observations (no change required; recorded, not requested)

- **R2-O-1 — one leftover adverb.** `note.md` §4, question 2 (line 166) still
  reads "Falsifier: F2 below (an alias-losing row **now** fails closed,
  measured)". As written it is true of the after-state and F2 did measure it,
  but "now" is the last trace of the contrast R-1 removed. I did not raise it to
  a required resolution: it is an internal evidence note, not a shipped file; §5
  F2 and §9 both state the measured fact within twenty lines of it; and
  requiring a fourth documentary edit for one adverb is the patchwork the
  standing demand forbids. If the note is opened again for any reason, delete
  the word.
- **R2-O-2 / R2-O-3 — round 1's O-1 and O-2 stand unchanged and out of scope.**
  With `canonicalDriverParseResult` now `undefined`,
  `hasCanonicalProducerSurface` (`sqlite3/index.ts:224-232`, re-read this round)
  no longer discriminates a `parseField`-only middleware on an instance; the
  stronger form `driver.result === sqliteResultParser` should be ruled for
  SQLite and PGlite together, which is Arnaud's call. And the adapter-level
  `parseResult` legs look as inert as the driver leg was (MySQL normalises to a
  key no raw path reads; PostgreSQL's `convertBigIntToNumber(raw)` over a row
  array always falls through) — reasoned from source, not measured, and not
  deletable by this brief because the function has a caller. Both are carried
  correctly in `note.md` §9.

## 8. Rules

Twelve rules of `g4/briefs/common.md`: respected in the repair round. One fact
one authority — the repair moved no authority at all; it removed a false claim
about one. No policy boolean, no second reader, no new interpreter, no legacy
import, no fallback, no registered refusal touched (the `V9001` on a row with no
`_count` is the pre-existing decoder contract, and it is now described
correctly instead of being presented as newly reached). No test deleted,
weakened or `.skip`-ed — none was even opened. Pinned runtime, serial validation
through the bounded runner, receipts kept per run, failed attempts not relabelled
(there were none this round).

## 9. Unverified claims carried forward

- bun-sqlite and d1 have no live transport in this environment, so "the count
  and exists answers are unchanged" stays live-verified on sqlite3 only; for the
  other three it rests on two green facts (all four publish the same parser
  object; that object has no result hook). libsql's `exist` witness sits inside
  a pre-existing `describe.skip`. Reported honestly by the author; unchanged by
  this round.
- R2-O-3 (the adapter legs' inertness) is reasoned from source, not measured.
- The one still-red, `tests/contracts/architecture/contract-matrix.core.test.ts`
  naming `tests/raptor3/candidate-handoff.test.ts`, is pre-existing
  (`cf2cbc4e6`, 2026-09-14) and unrelated; I reproduced it in round 1
  (`review-receipts/contract-matrix.log`) and did not re-run it here, nothing
  having changed.
- "No lock refusal was met and no lock was removed" is unverifiable after the
  fact for the author's runs; I met none in either round.
