# Release unit "perf" — independent review, round 2 (the repair round)

Reviewer: the independent reviewer of the `perf` release unit, second pass.
Worktree `/private/tmp/viborm-perf`, branch `release-perf`, HEAD
`36c87710aa2526652867430f6e24f30005556394`. `TMPDIR=/private/tmp/viborm-perf-tmp-r`
exported for every command this round ran. Nothing was committed, staged, reset,
stashed or pushed; no lock file was removed; no file of the author's and no file
of round 1's was edited. The only files this round wrote are `review-round2.md`
and [`review-round2-receipts/`](review-round2-receipts/).

**Verdict: ACCEPT.** All six findings of [`review.md`](review.md) — the two
majors included — are applied exactly as that review worded them, no number,
verdict or tally moved with them, and the one new measurement the repair round
added reproduces on an independent re-run from my own runner (statement seam
1.404 against the note's 1.411; package seam 1.295 against 1.325). Three
sentence-level corrections are recorded in §5; none of them changes a number, a
verdict or a decision, and none needs another review round.

---

## 1. What the repair round touched, and what it must not have touched

Files newer than `review.md` (the round-1 boundary), the complete list:

| File | Kind |
| --- | --- |
| `note.md` | the repaired note (new §10 records the round) |
| `receipts/probes/seam-probe-v6.mjs`, `seam-run-v6.mjs` | the new probe and its runner |
| `receipts/probes/seam-samples-v6.json`, `seam-summary-v6.json` | its receipts |
| `receipts/probes/INDEX.md` | a v6 row |
| `receipts/repair/*` (6 files) | machine scans, the `git apply --check` receipt, the v5→v6 diff, the run log, the typecheck |

Nothing else moved: `v1`–`v5` and every file under `receipts/cells/`,
`review-receipts/`, the two `performance-release*.json`, `bundle-ratios-release.json`,
`source-size-release.json` and `receipts/{aggregate,series-driver}.mjs` are all
older than `review.md` and untouched. **v5 is a copy source, not an edit** — I
diffed `seam-probe-v6.mjs` against `seam-probe-v5.mjs` myself
(`receipts/repair/seam-probe-v5-to-v6.diff` is faithful; see §3).

Discipline, re-checked at the end of this round:

- `git status --porcelain` in `/private/tmp/viborm-perf` lists only
  `?? docs/architecture/raptor3-evidence/g4/release/perf/`; `git diff 36c87710a`
  and the index are both empty; the two `git stash` entries still predate the unit.
- Both measurement arms are clean at their commits:
  `/private/tmp/viborm-perf-baseline` at `5a37bcd7f371…`, `/private/tmp/viborm-perf-cand`
  at `36c87710aa25…`, porcelain empty on both.
- The stale `viborm-test-c33ebb4c906dfea8.lock` (B1) is still there, still dated
  2026-09-20T00:40, untouched.
- No production, `benchmarks/`, `scripts/` or test file was touched; no test was
  deleted, weakened or skipped — none was touched at all.

Machine during this round: 1-minute load **7.14** at the start of the timing
re-run and **9.44** at the end, well under the protocol's gate of 20
([`review-round2-receipts/machine-before-round2.txt`](review-round2-receipts/machine-before-round2.txt),
[`machine-after-round2.txt`](review-round2-receipts/machine-after-round2.txt)).
Recorded honestly: when I started, a vitest run belonging to **another
repository** (`/Users/arnaud/code/edytor`, three processes, ~400 % CPU) was
alive. I waited **74 s** for it to exit before the timing re-run and only ran
the typecheck — which is not timing-sensitive — while it was still alive. No
viborm test lane ran at any point.

---

## 2. Every resolution, checked against what review.md asked for

| # | What `review.md` required | What the note now says | How I verified it |
| --- | --- | --- | --- |
| **F1 a** | §1.1 and the head of §3 must say the statement seam does not bracket equivalent work, citing the +0.28 / +3.53 µs asymmetry, and that the `prepare` rows are not the D-9 comparison | §1.1 ¶4 ("**And the statement seam does not bracket equivalent work on these two trees**", with 16.22→16.50 and 10.05→13.59) and §3's "**Read the `prepare` rows as §1.1 says**" | recomputed both medians from `seam-summary-v5.json`: baseline 10.05→13.59 (+3.53), candidate 16.22→16.50 (+0.28) — exact |
| **F1 b** | B2 rewritten as an instrument choice: `git apply --check` RC=0 on both arms, identity 4's measured 0.698 / 0.702 under the adapter, the `benchmarks/` change demoted to the alternative | §4.2 rewritten head to foot, heading now "…**because this series ran the frozen protocol un-adapted**"; the three establishing facts are bulleted; the harness request is explicitly "the alternative, not the primary answer" | I ran `git apply --check` of `g4/cutover/phase-adapter.patch` myself on all three trees: **RC=0 ×3**, porcelain unchanged on each. `performance-identity4.json`, `flat-scalar-update/full`: **0.6977 / 0.7018**, both passes `pass`; its `prepare`/`execute` carry "not measurable comparably — end-to-end evidence retained". The adapter's `createMutationHarness` route to `createFullOnlyHarness` is in the patch at the lines the note describes |
| **F1 c** | §2.2's `flat-scalar-update` row to read `1 → 1` from the review's receipts | the row reads **1 → 1** and cites `review-receipts/review-fsu-count-{baseline,cand}.json` | both receipts: `execute: 1` per public operation, identical `UPDATE … RETURNING` on both sides |
| **F2** | measure `bulk-update-returning-100` at the package seam and add it to §4.3's second table, **or** narrow the sentence | both: the cell is measured at both seams (**1.411 / 1.325**), added to the table, and "most of this is the bracket" is explicitly **withdrawn** as a statement about the four; `scalar-find-unique/cold-prepare` is named as the only preparation cell left without a package-seam reading | re-ran the probe independently — §3 below |
| **F3** | quote the candidate's three statements in receipt order; drop "as a literal" or say what the receipt distinguishes | §2.2 now quotes INSERT → SELECT → UPDATE in that order, says "**The produced id arrives as a bound `?` on both sides**", and states what the receipt does and does not distinguish (order and spelling, not carried vs read-back) | read `count__nested-conditional-found__{baseline,cand}.json`: candidate `INSERT … RETURNING "id"`, `SELECT … FROM "bench_generated_children" … ORDER BY … LIMIT ?`, `UPDATE … SET "parentId" = ?` (no RETURNING); baseline reads the child first, then INSERT, then `UPDATE … CAST(? AS INTEGER) … RETURNING`. The note's quoted SQL matches the receipt character for character |
| **F4** | "the same 14 … files" → "the same two integration classes (15 files at the baseline, 14 here)" | §6.3's row reads exactly that | `source-size-release.json`: `method` says "12 client + 3 adapter integration files" (15) for the denominator, and `withSameIntegrationFiles.files` = 52 = 38 engine + **14** |
| **F5** | print the three GC samples per arm beside the medians; add one line to §8 | §4.3 item 3 prints `10.61 · 10.61 · 11.28 → 10.61`, `9.98 · 10.21 · 10.74 → 10.21`, `16.15 · 14.40 · 15.34 → 15.34`, `17.15 · 17.23 · 16.28 → 17.15`; §8 item 7 bounds what three runs separate | every sample matches `receipts/probes/gc-sensitivity.txt`; medians and the 1.446 / 1.680 ratios recomputed; the stated spread (14.40–16.15, "11 % of their median") is 11.4 %, correctly rounded |
| **F6** | say that two of the five inconclusives passed on their repeat | §3's tally sentence names `scalar-find-unique/execute` and `bulk-update-returning-100/full` and says the worse-of-two rule carries them as blocking | the per-pass records in `performance-release.json` agree; the tally itself is unchanged |
| extra | — (the author's own addition) | §8 item 5 now points at the review's sparse-arm build receipt instead of leaving the same fact open as unverified | read; it cites `review.md` §1.5 and keeps "the deviation stands; the confound does not" |

**The one thing the review offered that was not done** — F1's *fuller*
resolution (commit the adapter as an overlay on each scratch arm and re-run
eight cells) — is refused in §10.1 for the correct reason: an overlay is a
commit, and the brief and `common.md` both forbid this unit to commit. §4.2
states the cost and the consequence instead. That is a refusal honoured as a
contract, not a corner cut.

---

## 3. The one new measurement, re-run independently

The author's `receipts/probes/seam-run-v6.mjs` writes into the author's own
receipts, so I did not run it. I wrote my own runner
([`review-round2-receipts/r2-seam-run-v6.mjs`](review-round2-receipts/r2-seam-run-v6.mjs),
a copy whose only differences are its output paths and one extra assertion) and
invoked **the author's probe unchanged**: 5 fresh-process pairs per seam, side
order alternated per pair, 1,000 iterations after 200 warmup, both arms.

| seam | author, CPU µs/op | author ratio | this review, CPU µs/op | this review ratio |
| --- | ---: | ---: | ---: | ---: |
| statement (`prepare()`) | 42.39 → 59.79 | **1.411** | 41.62 → 58.43 | **1.404** |
| package (`prepareBatch()`) | 44.55 → 59.03 | **1.325** | 44.15 → 57.15 | **1.295** |

Receipts: [`review-round2-receipts/r2-seam-run-v6.log`](review-round2-receipts/r2-seam-run-v6.log),
[`r2-seam-samples-v6.json`](review-round2-receipts/r2-seam-samples-v6.json),
[`r2-seam-summary-v6.json`](review-round2-receipts/r2-seam-summary-v6.json).

Everything the note reads off this measurement survives the re-run:

- **The bracket asymmetry.** Mine: baseline **+2.53 µs** to reach the superset
  seam, candidate **−1.28 µs** (inside its own spread). The author's: +2.16 /
  −0.77. Same sign, same size, same conclusion — "the same asymmetry as the
  reads, but far smaller".
- **The attribution.** Excess over parity 0.404 at the statement seam and 0.295
  at the package seam, so the bracket explains **0.109 of 0.404** here against
  the note's 0.086 of 0.411 — a quarter rather than a fifth, i.e. the note's
  attribution is the conservative one.
- **The verdict.** 1.295 is 15.6 % over D-9's 1.12 at D-9's own bracket. The
  cell blocks at either bracket, as the note says.
- **Not a regression since D-9.** Stage 2d read this cell at the package seam
  (`preparationSeam.seam = "package"` on **both** sides in both passes) at
  **1.3098 / 1.3971**. The note's 1.325 is inside that; my 1.295 is 1.1 % below
  its lower end. Either reading says the same thing in the same direction.
- **Both sides answer both seams with one statement.** I checked all 20 of my
  samples and all 20 of the author's, not just the first: `published.statement`
  and `published.package` are `answered: true, statementCount: 1` in **40 of
  40**, and the published SQL is the same `UPDATE … RETURNING "id", "age"` on
  both sides. The two brackets really are like for like on this cell.

**The v5 → v6 diff is what its header claims**, checked line by line against the
two files: `bulk-update-returning-100` added to `OPERATIONS` (built verbatim as
`benchmarks/operation-pipeline-batch-workloads.mjs:52–59` builds it — I compared
them), the statement-arm loop kind read from `WORKLOADS[…].stageKinds.prepare`
instead of hardcoded sync, and the side order alternated per pair. Nothing else
changes behaviour. For the three read cells `stageKinds.prepare === "sync"`, so
the `seam === "statement" && stageKind === "sync"` branch is v5's branch
unchanged — the claim "for those three v6 runs exactly what v5 ran" holds by
construction. The catalog does declare this cell async
(`operation-pipeline-catalog.mjs:449–451`, `asyncStages: ["cold-prepare",
"prepare"]`), and `prepareOperationPlan` (`operation-pipeline-harness.mjs:219–229`)
does return `capability.prepare()` whenever that seam answers — so the series'
bracket for this cell is the probe's statement seam plus a witness checksum,
exactly as the summary's own `note` field states.

---

## 4. The numbers that had to stay still, re-checked

- **The A/B table.** I parsed all twenty rows of §3 out of `note.md` and
  compared each against `performance-release.json` recomputed worse-of-two-passes:
  every CPU, wall and RSS ratio, every `B → N`, every `E` and every `(N−B)+E`
  agrees to the digit the note prints, and the JSON tally is **6 pass / 5 blocks
  adoption / 5 inconclusive-after-repeat / 3 not measurable comparably / 1
  required contract divergence**, the note's sentence exactly.
- **§4.3's three read rows and §1.1's asymmetry** recomputed from
  `seam-summary-v5.json`: 1.613 / 1.215, 1.150 / 0.985, 1.349 / 1.315 — the
  table's values, and the bracket shares (0.398 of 0.613; all of it; 0.034 of
  0.349) follow arithmetically.
- **The stage 2d column** checked against `performance-identity4.json`:
  1.1892 / 1.3175, 0.9739 / 0.9883, 1.2566 / 1.2497, 1.3098 / 1.3971, all with
  `preparationSeam.seam = "package"` on both sides. The column is like for like.
- **Size and census** were not re-measured: no repair-round file touches them,
  their receipts predate `review.md`, and round 1 reproduced all of them
  (engine 0.646, pg fixtures 0.7347 / 0.7349, 16,036 token-LOC, 0.3484).
- **Whole-estate typecheck**, re-run by me: **EXIT=0, 0 diagnostics**, 5.74 s
  wall / 4,957.8 MiB peak
  ([`review-round2-receipts/r2-typecheck.txt`](review-round2-receipts/r2-typecheck.txt)).
  No vitest project, file or registered mode is affected by this round — the
  repair changed a note, a probe and receipts — so none was run.

---

## 5. Findings of this round

### G1 — MINOR. `note.md:445` claims the v6 statement arm is "inside that cell's own pass-to-pass spread"

The sentence reads *"1.411 against 1.556 / 1.432, inside that cell's own
pass-to-pass spread"*. Read as an interval, `[1.432, 1.556]` does not contain
1.411 — the probe is 1.5 % below the lower pass. Read as "the probe's deviation
is smaller than the cell's own pass-to-pass variation (8.7 %)", the claim is
true, and §8 item 8 states that weaker form correctly. The strong form is the
only claim in §4.3 that its own receipts do not support literally, and §4.3 is
the section the preparation verdicts are read from.

*Minimal fix (one line):* "…1.411 against 1.556 / 1.432 — 1.5 % below the nearer
pass, where the cell's own two passes differ by 8.7 %".

### G2 — MINOR. The headline says "almost none" where the body measures a fifth

`note.md:37–38` (§0 item 3): *"most of it on the headline read, almost none on
the two large-payload cells."* §4.3 measures those two shares as **a tenth**
(0.034 of 0.349) and **a fifth** (0.086 of 0.411), and my re-run of the second
puts it at **a quarter** (0.109 of 0.404). "Almost none" understates the
bracket's share, which errs *against* the candidate and so is not self-serving —
but the four-sentence headline should say what the table says.

*Minimal fix (one line):* "…most of it on the headline read, a tenth and a fifth
on the two large-payload cells."

### G3 — NIT. `receipts/probes/INDEX.md`'s v6 row says "v5 is a copy, not an edit"

Inside the v6 row the sentence *"v5 is a copy, not an edit, so its receipts keep
their provenance"* inverts the two files: v6 is the copy. `note.md` §10.2 and
the probe's own header both say it the right way round.

*Minimal fix:* "v6 is a copy of v5, not an edit of it, so v5's receipts keep
their provenance."

### Recorded, not charged

My package-seam reading (1.295) sits 1.1 % **below** stage 2d's 1.310 / 1.397,
where the author's (1.325) sits inside it. The note's sentence "inside stage 2d's
own 1.310 / 1.397" is true of the measurement it reports; a second instrument on
a busier machine reads marginally lower. Both support the note's conclusion —
nothing has regressed since D-9 on this cell — so this is a note about
instrument precision at the 1–3 % level, not a fault. It is one more reason the
note's own §8 item 8 caveat is the right one to keep.

---

## 6. What I could not fault

- **The repair is exactly the repair that was asked for.** Every one of the six
  findings is answered in the section `review.md` named, in the words it asked
  for, and §10.1 is an honest per-finding change log that I was able to check
  line by line. The one resolution not taken is refused with a rule, not with a
  preference.
- **v5 was not edited to make v6.** The new probe is a copy with a documented
  diff, v1–v5 keep their receipts and their provenance, and the failed
  falsifications are still labelled as failures. `INDEX.md` still says "Every
  attempt is kept. None was relabelled or deleted", and that is still true.
- **The new measurement was built the harder way.** v6 could have hardcoded the
  sync loop and produced a friendlier number; instead it reads the stage kind
  from the catalog (which makes the bulk cell's arm async, the slower and more
  faithful choice) and alternates the side order per pair, which was my
  predecessor's *uncharged* methodological caveat. The repair round adopted a
  suggestion it was not required to adopt.
- **No verdict moved and no receipt was relabelled.** The A/B table, the tally,
  every blocker and every size number are bit-for-bit the numbers round 1
  verified; what changed is where the preparation verdicts are said to come from.
- **The unit is still a measurement unit.** No production code, no `benchmarks/`
  file, no test, no commit, no lock removal — verified in the trees, not taken
  from the note.

The substantive blockers (B2–B7, the preparation cells against D-9's 1.12, the
D-28 decode cell, the +5 % public bundle) remain open **by design**: this unit
reports them with profiles and Arnaud decides. This ACCEPT is about the repair
round's fidelity and the note's evidence, not about adopting the candidate.

---

## 7. Round-2 review receipts

`docs/architecture/raptor3-evidence/g4/release/perf/review-round2-receipts/`

| File | What it is |
| --- | --- |
| `machine-before-round2.txt`, `machine-after-round2.txt` | load, live test processes and the lock scan before and after the re-runs |
| `r2-seam-run-v6.mjs` | the reviewer's runner (the author's probe is invoked unchanged) |
| `r2-seam-run-v6.log` | its run log, 20 fresh processes, in order, with the load at both ends |
| `r2-seam-samples-v6.json`, `r2-seam-summary-v6.json` | the independent re-run's samples and medians, plus the 40-of-40 `published` assertion |
| `r2-typecheck.txt` | independent whole-estate typecheck, EXIT=0, 0 diagnostics |
