# Release unit "perf" — independent review

Reviewer: the independent reviewer of the `perf` release unit. Worktree
`/private/tmp/viborm-perf`, branch `release-perf`, HEAD
`36c87710aa2526652867430f6e24f30005556394`. `TMPDIR=/private/tmp/viborm-perf-tmp-r`
exported for every command this review ran. Nothing was committed, staged,
reset, stashed or pushed; no lock file was removed; no file of the author's was
edited. The only files this review wrote are `review.md` and
[`review-receipts/`](review-receipts/).

**Verdict: REVISE.** Every number in the note that I re-measured reproduces,
the size targets are met with byte-identical receipts, and no production file
changed. One finding is material and bounded: the verdict-bearing A/B table
brackets the preparation cells at a seam the unit's **own probe proves does not
bracket equivalent work**, and the protocol's own instrument for the seam D-9
was decided at — `g4/cutover/phase-adapter.patch` — **applies cleanly to both
arms of this series** (`git apply --check`, RC=0 on `5a37bcd7` and on
`36c87710a`). Two of the five preparation cells, including one of the three
cells D-9 named, therefore have **no reading at all** at the bracket their
verdict is stated against, and blocker B2's "no end-to-end evidence retained" is
an instrument choice this unit controlled rather than a property of the release
tree.

---

## 1. What this review re-ran, and what it found

All commands under `TMPDIR=/private/tmp/viborm-perf-tmp-r`; receipts in
[`review-receipts/`](review-receipts/). Machine state before the re-runs:
1-minute load average **7.21**, no vitest/tsc/tsdown/tinypool process alive, the
stale `viborm-test-c33ebb4c906dfea8.lock` of §4.1 the only lock under any
`/private/tmp/viborm-*-tmp`
([`review-receipts/machine-before-review.txt`](review-receipts/machine-before-review.txt)).

### 1.1 The three D-9 cells (the brief's requirement), re-run from scratch

One cell in one mode per command, the author's command shape, five alternating
fresh-process pairs per side, `measurementProtocolValid: true` on all three.

| Cell | author (worse of 2 passes) | this review | verdict |
| --- | ---: | ---: | --- |
| `scalar-find-unique/prepare` | 1.711 | **1.686** | blocks adoption (both) |
| `bulk-update-returning-100/prepare` | 1.556 | **1.531** | blocks adoption (both) |
| `fixed-collection-rowref-1000/prepare` | 1.466 | **1.437** | blocks adoption (both) |

Wall on the third cell reproduces to three digits (1.308 both). Receipts:
`review-receipts/review__*__prepare__cpu.json` and their `.log`.

**One instrument fact worth recording.** My first run of
`fixed-collection-rowref-1000/prepare` omitted the `--iterations 1000 --warmup
200` the author's driver pushes for that cell, and the catalog's row-scaled
default (100/20) reversed the verdict: **0.731, "pass"**
([`review-receipts/review__fixed-collection-rowref-1000__prepare__cpu.json`](review-receipts/)).
The author is right and I was wrong: `g0.md`'s frozen counts name exactly this
trap — *"The old row-scaled default gave large-result preparation only 100/20,
although preparation does not process those 1,000 result rows"* — and fix
1,000/200 for the large relation result. The author's setting is the frozen
one, inherited unchanged from stage 2d. Both receipts are kept.

### 1.2 Size

- `measure-raptor3-baseline.mjs --bundle` re-run on the release tree: all three
  fixtures reproduce **byte for byte**, including `sha256`
  ([`review-receipts/review-bundles-release.json`](review-receipts/review-bundles-release.json)).
  engine 101,276 gzip / **0.646**; pg-simple 192,986 / **0.7347**; pg-relations
  193,115 / **0.7349**. Denominators checked directly against the frozen
  `baseline.json` (read-only from the main tree): 156,771 / 262,658 / 262,788,
  and its `bundleProtocol.fixtures` strings are **identical** to the current
  ones, so the ratios are like for like.
- The engine fixture's raptor3 module set is **exactly** the repository's 16
  `src/query-engine/raptor3/**/*.ts` — set equality, nothing missing, nothing
  extra. The brief's re-point is confirmed a measured no-op.
- Source size re-run: `query-engine-structure.mjs` reproduces **38 files /
  20,319 lines / 16,036 token-LOC** and every secondary count
  ([`review-receipts/review-query-engine-structure.json`](review-receipts/review-query-engine-structure.json)).
  16,036 / 46,021 = **0.3484** ≤ 0.60. The 46,021 and 49,887 denominators are
  the ledger's (`g4.md:2479–2484`).
- `package.json` really declares **no `limit` and no bundler** on any
  `size-limit` entry; §6.1's "these are entry chunk sizes, not a budget" is
  accurate.

### 1.3 The aggregator, re-run from the author's own cell receipts

`AGGREGATE_OUT=… node receipts/aggregate.mjs pass1 pass2` reproduces the note's
tally exactly — **6 pass / 5 blocks adoption / 5 inconclusive after the one
permitted repeat / 3 not measurable comparably / 1 required contract
divergence** — and every per-pass ratio in §3
([`review-receipts/review-aggregate-stdout.txt`](review-receipts/review-aggregate-stdout.txt)).
I checked the note's §3 table row by row against it (worse-of-two-passes on
cpu, wall and rss); all twenty rows agree, and "peak RSS below parity on 14 of
the 16 measurable cells" is right.

I diffed `receipts/series-driver.mjs` and `receipts/aggregate.mjs` against
stage 2d's. The driver's four adaptations are exactly as its header says; the
**20-cell set is unchanged** (reordered only). The aggregator's `metricRow`,
`RANK`, the straddle test, the per-pass roll-up and the metric set are
**byte-identical** to stage 2d's. The only gate change is the D-9 budget
fraction the brief itself mandates — and it changes **no verdict**: all four
over-budget preparation cells block at 0.05 and at 0.12 alike.

### 1.4 Structural claims

- Protocol identity recomputed independently with `protocolIdentity()`:
  `2e35d9a73c57468f7a840a1ab8251393f489ae3b933db8e511e26a8591d5f087` on
  `/private/tmp/viborm-perf`, `-baseline` and `-cand`. The 24 `PROTOCOL_PATHS`
  files are byte-identical across the arms (`diff -rq benchmarks/` shows one
  extra file on the baseline, `read-fastpath-parse.bench.ts`, which is not in
  `PROTOCOL_PATHS`). §1.1 holds.
- Candidate-arm fidelity: `src/`, `benchmarks/`, `scripts/` byte-identical to
  the release worktree's; the five root build files identical; the two arms'
  `pnpm-lock.yaml` identical (`c366c980…`), so no separate install was needed.
- Whole-estate typecheck re-run: **EXIT=0, 0 diagnostics**, 5.68 s / 5,047 MiB
  ([`review-receipts/review-typecheck.txt`](review-receipts/review-typecheck.txt)).
  `src/query-engine/pattern/` does not exist, so the two permitted historical
  TS2345 errors are genuinely gone.
- Rulings reach: no `.schema(` anywhere in `benchmarks/`; the only two
  `s.json()` are in `operation-pipeline-provider-fixtures.mjs`; no
  `polymorphic`, no `only: [`. All twenty cells are `workload("core", …)` in the
  catalog. D-33 and D-26 can touch none of them — confirmed.
- Receipt completeness: `receipts/cells/` holds 80 logs, 64 `.json.gz`, 16
  `.log.done` and 2 journals = 162 files; 64 exit=0 and 16 exit=1 in the
  journals, matching the 16 refused commands (3 `flat-scalar-update` cells and
  `relation-series-2`, × 2 modes × 2 passes). `relation-series-2`'s log really
  carries 10 `replicate n/5` lines and the `AssertionError … changed final`.
- Machine load and the lock scan reproduce; the protocol's load gate of 20
  (§10.6) is real and was never approached.

### 1.5 Two of the note's own claims, checked harder than it checked them

- **Unverified claim #5 (the sparse candidate arm) is now verified, in the
  author's favour.** `pnpm package:build` in the sparse arm and in the full
  release worktree produce 181 files each, **every `.mjs` byte-identical**
  (`dist/index.mjs` sha256 `f2f9f9d0…` on both); only the content-hashed
  `.d.mts` chunk name differs, which no measurement reads. The sparse checkout
  is not a confound. (Cone mode keeps every root file, so nothing the build
  reads was missing.)
- **§2.2's "no extra statement" claim holds for `flat-scalar-update` too**, and
  I got the number the note left blank. Counting at the same `driver.execute`
  seam the author's probe uses, but driving the public entry directly (which is
  what the harness's `full` stage does), both sides send **exactly 1 statement
  per public operation** — the same `UPDATE … RETURNING`
  ([`review-receipts/review-fsu-count-{baseline,cand}.json`](review-receipts/)).
  The candidate's two-statement package is what `prepareBatch` publishes for
  batch mode; the public path does not use it. The note's row for that cell can
  say `1 → 1` instead of "refused by the harness".

---

## 2. Findings

### F1 — MAJOR. The verdict-bearing bracket is not equivalent work, and the protocol's own instrument for the right bracket applies cleanly to both arms

*Location:* `note.md` §1.1, §3 (the A/B table), §4.2 (B2), §4.3 (B3);
`receipts/series-driver.mjs`.

Plan §7, quoted at the head of `protocol.md`, requires a bracket that *"must
bracket equivalent work, including input/default preparation and decoding"*,
and says that when a phase cannot be isolated comparably one must *"measure the
common enclosing boundary and retain end-to-end evidence."* This series brackets
`prepare` at `capability.prepare()` on both sides and the unit's own v5 probe
proves that is **not equivalent work**:
[`receipts/probes/seam-summary-v5.json`](receipts/probes/seam-summary-v5.json),
`scalar-find-unique`, CPU µs/op medians —

| seam | baseline | candidate | gap |
| --- | ---: | ---: | ---: |
| statement (`prepare()`) | 10.05 | 16.22 | **6.17** |
| package (`prepareBatch()`) | 13.59 | 16.50 | **2.92** |

Going from the narrow to the wide bracket costs the candidate **+0.28 µs** and
the baseline **+3.53 µs**. Since `prepareBatch` is a superset of `prepare` on
both sides, the await-per-iteration constant the note itself identifies at v4 is
bounded above by the candidate's +0.28 µs, so ≥ 3.25 µs of the compression is
work the shipped engine defers past `prepare()` and the candidate has already
done inside it. (I set out to falsify the note's "most of it is the bracket"
attribution as an await artefact; the note's own data falsifies my objection.
The attribution is sound — and it is exactly why the narrow bracket is the
wrong one to publish verdicts from.)

The protocol answers this case with `g4/cutover/phase-adapter.patch` — five
files, all under `benchmarks/`, all inside `PROTOCOL_PATHS`, applied by stages
2c/2d as a byte-identical overlay commit on each scratch arm. **It applies
cleanly to both arms of this series**: `git apply --check` returns RC=0 against
`/private/tmp/viborm-perf` (36c87710a) and against `/private/tmp/viborm-perf-baseline`
(5a37bcd7); both trees stayed clean (`--check` writes nothing). The note's §4.2
offers it only as *"land the committed phase-adapter.patch on the main tree"*,
i.e. as a production change, and does not consider the scratch-arm overlay the
brief explicitly authorises and that its own §1.2 already used to build the
candidate arm.

Two consequences the note states as findings are in fact consequences of this
choice:

1. **B2 is avoidable.** Under the adapter, `createMutationHarness` does not
   refuse a workload whose side publishes no single statement — it returns
   `createFullOnlyHarness(...)` and keeps the public-entry `full` cell. That is
   not a reading of the patch alone: `performance-identity4.json` records
   `flat-scalar-update/full` **measured** at 0.698 / 0.702 through the
   comparator under exactly this adapter. So "the end-to-end evidence is NOT
   retained, which is strictly worse" is a property of running the frozen
   protocol un-adapted, not of the release tree.
2. **Two of the five preparation cells have no reading at the bracket their
   verdict is judged against** — see F2.

*Minimal resolution (do all three):*

- In §1.1 and at the head of §3, state that the statement seam does not bracket
  equivalent work on these trees, citing the +0.28 / +3.53 µs asymmetry in
  `seam-summary-v5.json`, so the table's preparation rows are read as a bracket
  artefact plus a real cost and not as the D-9 comparison.
- Rewrite B2 (§4.2) as an instrument choice: record `git apply --check` RC=0 on
  both arms, record that identity 4 measured this cell's `full` at 0.698/0.702
  under the adapter, and keep the requested `benchmarks/` change as the
  alternative rather than the primary. Use the 1 → 1 public statement count
  from `review-receipts/review-fsu-count-*.json` in §2.2's table.
- Close F2.

*Fuller resolution, if the integrator wants the series comparable with stage 2d
end to end:* commit the adapter as an overlay on each scratch arm exactly as
stage 2c/2d did, re-run the five preparation cells and the three
`flat-scalar-update` cells over two passes, and publish both brackets. That also
restores `flat-scalar-update`'s cells to the comparator's evidence (semantic
comparison, peak RSS, `measurementProtocolValid`). Note it yields a third
protocol identity, not stage 2d's `f23e0aac…`, because the 24 `PROTOCOL_PATHS`
files themselves moved since then — seam equivalence, not byte equivalence, is
what makes the comparison meaningful, which §4.3 already relies on.

### F2 — MAJOR. `bulk-update-returning-100/prepare` — a cell D-9 named — has no measurement at D-9's bracket

*Location:* `note.md` §4.3 (both tables); `receipts/probes/seam-probe-v5.mjs`.

§4.3's first table lists **four** preparation cells over budget. Its second
table — the one that carries the whole "most of this is the bracket" argument —
covers **three**, and the one it omits is `bulk-update-returning-100/prepare` at
**1.556**, the second-largest miss and one of the three cells D-9 explicitly
accepted. `scalar-find-unique/cold-prepare` (1.038, inconclusive) has no
package-seam reading either. `seam-probe-v5.mjs`'s `OPERATIONS` map builds only
`scalar-find-unique`, `fixed-collection-rowref-20` and
`fixed-collection-rowref-1000`, and throws for anything else.

The claim "most of this is the bracket" is therefore asserted for four cells and
measured for three, and the unmeasured one is a bulk **write** preparation whose
seam behaviour need not resemble the three reads' (§2.1 already shows this
family's seams diverge). If its package-seam ratio comes back near 1.5 rather
than near 1.2, B3's profile changes materially and the "nothing has regressed
since D-9" sentence does not cover it.

*Minimal resolution:* add `bulk-update-returning-100` to `seam-probe-v5.mjs`'s
`OPERATIONS` (same counts, 1,000/200, same runner, 5 alternating pairs per side)
and add its row to §4.3's second table — **or**, if it will not be measured,
narrow §4.3's sentence to the three cells that were, and say in the first table
that `bulk-update-returning-100/prepare` has no reading at D-9's bracket.

### F3 — MINOR. §2.2's SQL narrative does not match its own receipt

*Location:* `note.md` §2.2, the paragraph under the statement-count table.

The note says the candidate *"sends `INSERT … RETURNING "id"` and then `UPDATE …
SET "parentId" = ?` — the produced id as a **literal**"*.
[`receipts/probes/count__nested-conditional-found__cand.json`](receipts/probes/)
shows a `SELECT` of the child **between** those two statements, and the
carried id arrives as a bound `?` on both sides (the shipped engine's only
visible difference is `CAST(? AS INTEGER)`). The load-bearing claim — 4
statements on each side — is correct and I reproduced the counts; the sentence
describing the mechanism is not what the receipt shows.

*Minimal resolution:* quote the candidate's three statements in the order the
receipt lists them, and either drop "as a literal" or say what in the receipt
distinguishes a carried value from a read-back one.

### F4 — MINOR. §6.3's "the same 14 … files" is not the same set as the denominator's

*Location:* `note.md` §6.3 table, second row; `source-size-release.json`.

The note's row reads *"with the same 14 client + adapter integration files …
19,896 / 49,887"*. `source-size-release.json`'s own `method` field records the
denominator as *"12 client + 3 adapter integration files"* (15), while the
release side is 12 + 2 = 14 (`charged-integration` 12, `charged-adapter-integration`
2). The classes match; the file counts do not, so "the same 14" is wrong on its
face. The primary reading (engine-only 16,036 / 46,021 = 0.348 ≤ 0.60) is
unaffected and I reproduced it.

*Minimal resolution:* say "the same two integration classes (15 files at the
baseline, 14 here)" instead of "the same 14 … files".

### F5 — MINOR. The GC-sensitivity numbers carry no stated uncertainty and are not in §8

*Location:* `note.md` §4.3 item 3; `receipts/probes/gc-sensitivity.txt`.

The 1.446 / 1.680 pair is **three runs per arm**, and the candidate's forced-gc
samples span 14.40–16.15 (12 % of the median). The medians and both ratios are
arithmetically correct — I recomputed them — but §4.3 calls this "the **real**
engineering fact under all of it" and §8 does not list it among the unverified
or weakly-bounded claims, while it lists thinner things.

*Minimal resolution:* print the three samples per arm beside the medians in
§4.3, and add one line to §8 bounding what three runs can separate.

### F6 — NOTE, no change required. Two of the five "inconclusive" cells resolved on their repeat

`scalar-find-unique/execute` (pass1 inconclusive-repeat, pass2 **pass**) and
`bulk-update-returning-100/full` (pass1 inconclusive-repeat, pass2 **pass**) are
tallied as "inconclusive after the one permitted repeat — blocks adoption",
because stage 2d's roll-up takes the worse of the two passes. `g0.md`'s own
sentence is *"Repeat an unresolved … series once … if its repeat was still
unresolved, the original policy blocked the gate"*, which those two repeats were
not. The rule is unchanged from an accepted precedent, is stated in §1.3, and
errs **against** the candidate, so I am not asking for it to be changed — but
the tally sentence in §3 would be more honest if it said that 2 of the 5
inconclusives resolved on their repeat and are carried as blocking by the
worse-of-two rule.

---

## 3. What I could not fault

- **No production change, and the discipline held.** `git status --porcelain` in
  `/private/tmp/viborm-perf` lists only the unit's evidence directory; `git diff
  36c87710a` is empty; the index is empty; both measurement arms are clean at
  their commits; the two entries in `git stash list` are dated 2026-09-02 and
  2026-08-25 and predate this unit; the main tree's dirty files are the
  `CONTEXT.md` / `memory.md` / untracked-evidence set `common.md` names. No test
  was deleted, weakened or skipped — none was touched.
- **The stale-lock substitute.** Running under `/private/tmp/viborm-perf-tmp/run`
  rather than removing `viborm-test-c33ebb4c906dfea8.lock` is the right call:
  the lock is dead (PID 33729 gone, written 2026-09-20T00:40Z, hours before the
  unit), `acquireTestRunLock` refuses a stale lock rather than waiting, and the
  unit still took a real lock of its own. The deviation is recorded as B1 and
  the file is untouched — I confirmed it is still there.
- **The falsification chain (§5) is real work and is honestly labelled.** v1–v4
  are kept with their receipts and their defects named, none relabelled, and v5
  reproduces the series on all three cells (1.613 / 1.150 / 1.349 against the
  series' 1.705–1.711 / 1.164–1.212 / 1.457–1.466), which is what licenses its
  package arm as evidence about the bracket. The two instrument defects it found
  — an `await` on a sync stage, and a forced collection before the measured loop
  — are findings that outlive this unit.
- **The B6 size correction is right and matters.** identity 4's own receipt
  gives pg-simple 183,791 gzip at 0.6997; the release measures 192,986 at
  0.7347, i.e. +5.003 %. The final report's "the public PostgreSQL client
  fixtures are 0.700" is stale and the engine line "0.2377" was measuring a
  fixture that contained **one** raptor3 module; 0.646 with all 16 is the first
  honest engine number. Both targets are still met.

### One methodological caveat, recorded rather than charged

`seam-run-v5.mjs` runs all five statement-seam pairs and then all five
package-seam pairs, and within a pair always baseline before candidate, where
the comparator alternates the order between replicates. Over a session whose
1-minute load drifted 5.55 → 10.52 that is a possible few-percent systematic. It
cannot explain the effect it is used for — a 3.25 µs shift landing entirely on
one arm — so I am not asking for a re-run, but if the probe is extended for F2,
alternating the side order per pair costs nothing.

---

## 4. Verdict

**REVISE.** F1 and F2 are the required changes; F3–F5 are exact one-line
corrections; F6 is a wording suggestion. Nothing found contradicts the unit's
decision-bearing conclusions: every size target is met, the writes win, the
preparation path is over budget at **both** brackets (1.705–1.711 at the
statement seam, 1.215 at D-9's own), and `fixed-collection-rowref-1000/parse` —
the D-28 cell — is newly 8–14 % over on both passes and is the clearest
ruling-attributable movement in the series. What must change is where the
preparation verdicts are said to come from, and the two cells that have no
reading at the bracket they are judged against.

## 5. Review receipts

`docs/architecture/raptor3-evidence/g4/release/perf/review-receipts/`

| File | What it is |
| --- | --- |
| `machine-before-review.txt` | load, top consumers, live test processes, lock scan before the re-runs |
| `review__scalar-find-unique__prepare__cpu.{json,log}` | D-9 cell 1 re-run, 5 pairs/side |
| `review__bulk-update-returning-100__prepare__cpu.{json,log}` | D-9 cell 2 re-run |
| `review__fixed-collection-rowref-1000__prepare__cpu.{json,log}` | D-9 cell 3 at the catalog default (100/20) — the wrong counts, kept as the receipt of a failed falsification |
| `review__fixed-collection-rowref-1000__prepare__cpu__protocolcounts.{json,log}` | D-9 cell 3 at `g0.md`'s frozen 1,000/200 |
| `review-bundles-release.json`, `review-bundles-run.txt` | independent `--bundle` re-run |
| `review-query-engine-structure.json` | independent census re-run |
| `review-typecheck.txt` | independent whole-estate typecheck, EXIT=0 |
| `review-performance-release.json`, `review-aggregate-stdout.txt` | aggregator re-run from the author's cell receipts |
| `review-fsu-public-count.mjs`, `review-fsu-count-{baseline,cand}.{json,err}` | public-entry statement count for `flat-scalar-update`, both sides |
