# G4 witness follow-up — independent review of repair round 4

Reviewer: independent; did not author the unit, any repair round, or the
verification pass. Reviewed source: main tree `/Users/arnaud/code/viborm`,
branch `pattern-engine`, already containing the change (nothing applied,
nothing repaired here). Date 2026-09-15, 09:03–09:28 local.

**Filename.** The prompt asked for `g4/witness-followup-review-followup.md`.
That path is already the round-2 review (ACCEPT, 06:22) and
`witness-followup-review-followup-2.md` is the round-3 review (REVISE, 08:30).
Overwriting either would destroy a receipt, so this round continues the chain's
own naming.

Inputs read: `g4/briefs/common.md`, `g4/briefs/review.md`,
`g4/briefs/witness-followup.md`, my round-3 review, the author's repair summary,
`g4/witness/note.md` §§14.6, 15.7, 16 and 17 in full, `g4/witness/handoff.md`
§6, `receipts/followup-verify/README.md`, every file under
`receipts/repair2/` (74 files: README, every log, every JSON, the three
`.mjs` audit scripts), the regenerated cumulative patch, and the current source
of `scripts/credential-free-test-manifest.mjs`,
`scripts/raptor3-campaign-receipts.test.mjs` and `scripts/run-raptor3.mjs`.

Review receipts: `g4/witness-followup-review4-receipts/` (40 files: 20 logs,
6 run-receipt directories, 4 identity captures, the regenerated patch, the blob
ids).
New probes (kept): `tests/raptor3/g4/review/witness-followup4/` — three suites,
12 cells. The round-1, round-2 and round-3 probe directories were **not**
touched.

---

## Outcome: **ACCEPT**

All three must-fix findings are repaired, the seven notes are answered, and the
one declined change is declined on sound grounds. I re-ran the whole accepted
claim set myself at production `a830d713…` — the identity the round closes at —
and every number reproduces: native pg 5/5 (65504) and mysql 5/5 (65515),
`g4-unit01-author` 83/83, `g4-unit01-review` 200/200, `g4-write-seed-batch
75000` green with the corpus at exactly **62,116,444 B** and C08–C11
50/50/50/50, 40 two-actor, 40 overlap, 40 faults, the receipts self-test 39/39,
the typecheck clean apart from the two permitted Pattern TS2345, the cumulative
patch byte-identical at 88,236 B with zero `src/` files and all ten blob ids
unchanged, and both transport reds red with their recorded signatures.

The two findings that needed a *measurement* rather than prose are closed by
measurement, not by assertion: `identity-audit.json` recomputes the identity
property over the round's own 13 run receipts (I re-ran it: 13 receipts, one
production, `everyReceiptAtTheClosingProduction: true`), and the corpus snapshot
is a real byte census — its declared totals add up from its rows, its delta is
reproducible from the two snapshots, all 139 rows still exist on disk, all 66
witness-owned files are still byte-identical, and the 43-file worktree
comparison recomputes to 42 identical / 1 differing (+96 B) from the snapshot
alone, so it no longer depends on `/private/tmp/viborm-g4-unit01`.

I also closed the round's blocker: the full **archive → restore → replay** path
that four attempts could not complete is green here, restored sha256
`715718984add…` equal to its archive receipt and "Raptor 3 replay contract gate
verified" — which confirms the author's attribution (harness drift between
generation and replay, not the lane) and means the blocker is a scheduling
constraint, already written as handoff request 7, rather than an open defect.

Six notes below, none blocking and none changing a public answer, an error
identity or committed state. Two of them are pinned by red probe cells: a single
sentence in §16.6 that still says the opposite of the paragraph that corrects it,
and three cross-references that send the reader to the wrong subsection.

### Suites run (serial, through the bounded runner and the workspace lock)

Opening identity `a830d713…` / `7f9fbe2e…` (09:03,
[identity-before.json](witness-followup-review4-receipts/identity-before.json)).
**Every run receipt below carries production `a830d713…`** — the author's
round-4 identity — as their `attempt.json` / `verified.json` record.

| Command | Result | Wall / peak RSS | Receipt |
| --- | --- | --- | --- |
| `g4-unit01-author` | **83 / 83**, gate verified | 4.71 s / 703.0 MiB | `mode-g4-unit01-author-attempt1.log` |
| `g4-unit01-review` | **200 / 200** over 29 files, gate verified | 6.07 s / 742.3 MiB | `mode-g4-unit01-review-attempt1.log` |
| `g4-read-envelope-pg-contracts` (port **65504**) | **5 / 5** | 4.46 s / 512.7 MiB | `native-pg-attempt1.log`, `native-pg-attempt1/` |
| `g4-read-envelope-mysql-contracts` (port **65515**) | **5 / 5** | 4.39 s / 533.9 MiB | `native-mysql-attempt1.log`, `native-mysql-attempt1/` |
| `g4-write-seed-batch 75000` | green — 100 seeds / 200 cells / 600 replays, **C08–C11 50 / 50 / 50 / 50**, **40** two-actor, **40** overlap, **40** faults, 0 skipped; corpus **62,116,444 B** | 7.97 s / 875.5 MiB | `write-seed-batch-75000-attempt1.log`, `write-campaign/sqlite-75000/` |
| `g4-write-seed-batch 75300` — a seed no round has used | green | 7.24 s / 814.1 MiB | `write-seed-batch-75300-attempt1.log`, `write-campaign/sqlite-75300/` |
| `replay` on that raw corpus, immediately | **gate verified** | 5.19 s / 822.1 MiB | `write-corpus-gate-replay-attempt1.log` |
| `archiveG3GeneratedCorpus` + its own `restoreCommand` + `replayCommand`, verbatim | **gate verified**; archive receipt carries **no `--subject`**; restored sha256 `715718984add…` = the receipt's `originalSha256` | 5.96 s / 765.4 MiB | `write-campaign-archive-attempt1.log`, `write-corpus-gate-restore-replay-attempt1.log` |
| `g4-write-transport-seed-batch 100000` | **red, kept red** — `g3-transport:script-shape; Unscripted statement: g3-c11-100027-0:recurrence-0; actual=INSERT; expected=INSERT,SELECT` | 5.06 s / 684.1 MiB | `write-transport-seed-batch-100000-attempt1.log` |
| `g4-write-transport-seed-batch 124900` — the lane's **last** legal child, never run by anyone | **red** — same class, `g3-c11-124911-0:recurrence-0` (offset **11**, not 27) | 4.86 s / 665.1 MiB | `write-lane-boundary-refusals.log` |
| `g3-generated-transport-smoke` (G3's own, untouched) | **red** at `g3-c11-8027-0:recurrence-0` | 4.32 s / 531.1 MiB | `g3-transport-smoke-twin-attempt1.log` |
| seven off-boundary write children (74999, 75050, 100000, 124900 on the SQLite lane; 99999, 100050, 125000 on the transport lane) | all **refused**: "Generated batch must start at an exact frozen boundary" | — | `write-lane-boundary-refusals.log` |
| `scripts/raptor3-campaign-receipts.test.mjs` | **39 / 39** | 0.50 s / 63.5 MiB | `campaign-receipts-selftest-attempt3.log` |
| `scripts/raptor3-cli.test.mjs` | **8 pass / 2 fail** — one drift (`Stale Raptor 3 evidence` ×2, production moved mid-run), one the `test:all` cell whose inner run is **11 failed / 747 passed** across the same two files as §15.7. **All three G4 cells green.** | 233.70 s / 203.2 MiB | `raptor3-cli-selftest-attempt1.log` |
| `node scripts/run-typecheck.mjs` | clean apart from the two permitted Pattern TS2345 at `pack.ts:1443` and `:2633` (exactly 2 diagnostics, my new probes add none) | 7.80 s / 5,764.2 MiB | `typecheck-attempt1.log` |
| round-3 probes (18 cells) | **16 pass / 2 fail** — unchanged, and correctly so: both reds assert properties of the historical `followup-verify/` receipt set | 0.94 s / 270.0 MiB | `review-probes-round3-attempt1.log` |
| round-4 probes (12 cells) | **10 pass / 2 fail**, identical at both attempts | 0.86 s / 229.7 MiB | `review-probes-round4-attempt{1,2}.log` |

`campaign-receipts-selftest-attempt1-wrong-runner-FAILED.log` and
`…-attempt2-wrong-args-FAILED.log` are **kept failed and labelled**: they are my
own two mis-invocations of the node-test self-test, receipts of my mistake, not
of the unit.

### Static checks

| Check | Result |
| --- | --- |
| `git diff 0cc61e61` over the ten tracked files vs **both** stored copies (`repair/`, `repair2/`) | **byte-identical**, 88,236 B, `cmp` exit 0; `grep -c '^+++ b/src/'` = **0**; exactly 10 files |
| Working-tree blob ids of those ten files | identical to `patch-verification.txt`, including `live-world.ts` `4b702c67`, `run-raptor3.mjs` `c9ccaf11` |
| `shasum -a 256 scripts/credential-free-test-manifest.mjs` | `8f4a447c…` — the value recorded before and after the note-6 falsification |
| `identity-audit.mjs` re-run over `repair2/` | 13 run receipts, **one** production (`a830d713…`), `everyReceiptAtTheClosingProduction: true`, `measuredAtADifferentProductionThanThePriorRound: true` |
| Corpus snapshots (open / close) | declared 132 / 809,721 B and 139 / 845,179 B; rows re-add to exactly those totals; `byOwner` reproduces |
| Corpus delta | recomputed from the two snapshots: **7 added, 0 removed, 0 changed**, every addition another stream's under `review/unit02-phase2/`; witness-owned 66 files / 438,320 B at both brackets |
| Close snapshot vs the tree **now** | 139 / 139 still present, 1 changed since (another stream's `unit02-phase2/recursive-carrier.review.test.ts`), **66 / 66 witness-owned byte-identical** |
| `unit01-source-worktree.sha256` vs `/private/tmp/viborm-g4-unit01` | 43 rows, **0** mismatched; landed-vs-worktree recomputes to 42 identical, 1 differing (1,574 → 1,670 B) |
| Registration re-derived from the manifest | **55** registered fixed files / **392** cells; native file 5; `route-transactions` 11; `G4_UNIT01_AUTHOR_COUNTS` 83 over 10 files; `G4_UNIT01_REVIEW_COUNTS` 200 over 29 files; **0** registered-but-absent |
| `EXTENDED_LOCAL_TESTS` | **251** files, **0** under `tests/raptor3/g4/` |
| Note-6 falsification receipts | `note6-falsify-walk-skip-attempt1.log`: 321 files / 70 G4, self-test **38 / 1** with the named cell red. `note6-restore-verify.log`: 251 / 0, **39 / 39**, hash restored |
| Archive receipt of the 75000 child | raw 62,116,444 B → gzip 1,192,711 B, `replayCommand` carries no `--subject` |
| `§15.7` text vs `§16.3`'s rewrite | §15.7 records pg **5 / 5 "including the recursive fit"** and review **200 / 200 "the three finding-K probes … are green now"** — "unchanged since §15.7" is accurate |

---

## Status of every round-3 finding

| # | Round-3 finding | Status | What I checked |
| --- | --- | --- | --- |
| 1 | must-fix — §16's stated purpose contradicted by §16's receipts | **repaired** (one residue, note 1 below) | §16 preamble withdraws the claim and names `7475621b…`; §16.1 states the consequence; `followup-verify/README.md` rewritten the same way; the missing measurement taken at `a830d713…` and audited by recomputation — and reproduced independently here |
| 2 | must-fix — the two "changes" were already in the accepted record | **repaired** | §16.3 bullets 1–2 now say "unchanged since §15.7" and point the integrator at the phase-2 landing that preceded §15.7; verified against §15.7's own text; the unverifiable "nothing in the fixture changed" clause is deleted, not softened |
| 3 | must-fix — the untracked corpus had no recorded bytes | **repaired** | `receipts/repair2/corpus/` is a real census: totals recompute, delta recomputes, rows match the tree, and the worktree claim now survives the worktree |
| 4 | note — half the disk projection is unreproducible | **repaired** | qualified in place at §16.5 and §16.6 claim 3 and in handoff request 6; the transport half is named unmeasurable until request 5 closes |
| 5 | note — "5 / 5" is 4 + 1 | **repaired** | the clause is in §16.2, §17.4, the followup-verify README and handoff §6.2; both modes 5/5 here |
| 6 | note — the review suites are excluded by one mechanism only | **disputed, soundly** | the dispute is correct and measured. `G4_UNIT01_REVIEW_TESTS` (29 files, all under `tests/raptor3/g4/review/`, all `*.test.ts`) is spread into `G4_FIXED_SUITES` at `scripts/raptor3-campaign-receipts.test.mjs:957-967` and the cell at `:970` asserts every one of them is absent from `EXTENDED_LOCAL_TESTS`. So the falsifier I asked for already exists, and deleting the walk skip fires it (321 / 70, 38 / 1). A second exclusion would be a guard with no unique coverage. The falsification was done against a backup copy and the file is byte-restored (`8f4a447c…`, blob `764fd78d`) |
| 7 | note — the far end of both write ranges | **closed** | and extended here: the transport lane's last legal child (124900) has now run — see note 4 |
| 8 | note — the write lanes break the twin-range convention | **recorded for Arnaud** | correctly left unchanged; a frozen-range change is not this stream's |
| 9 | note — blocker 2 is still live | **sharpened** into §17.8 and handoff request 7 | and reproduced here: production moved twice during this review, once inside the CLI self-test |
| 10 | note — the §14.6 census total is stale | **repaired** | §14.6 carries the superseded total; `registration-totals.json` re-derives it; I recomputed 55 / 392 from the manifest independently |

---

## New findings (all notes)

### 1. note — one sentence in §16.6 still says what §16's preamble withdraws

**Location.** `docs/architecture/raptor3-evidence/g4/witness/note.md:1717`
(§16.6, unverified claim 1): "…the numbers above are a snapshot at
`a830d713…`, not a frozen identity."

The preamble of the same section now says "Everything below is therefore an
accurate re-measurement at `7475621b…`, not at the closing identity", and §16.1
adds "A reader must not read §16.2 as 'the numbers at `a830d713…`'". Claim 1 is
the withdrawn sentence, left in the list of things the round could not verify.
It is the only place in §16 that still makes the claim, and it is inside the
section that corrects it.

**Probe.**
`tests/raptor3/g4/review/witness-followup4/record-consistency.review.test.ts`,
cell "nowhere tells a reader that its own numbers are the numbers at the closing
identity" — red, printing the offending line with its number:

```
node scripts/run-vitest-safe.mjs run \
  --workspace=tests/raptor3/g4/review/witness-followup4/review.workspace.ts \
  tests/raptor3/g4/review/witness-followup4/
→ AssertionError: a sentence in §16 still attributes §16's rows to the closing identity
  + [ '1717: the numbers above are a snapshot at `a830d713…`, not a frozen identity.' ]
```

**Resolution.** One clause: "…the numbers above are a snapshot at `7475621b…`
(§16.1); the same claim set at `a830d713…` is §17.4."

### 2. note — three §16 cross-references send the reader to §17.3 for measurements that are in §17.4

**Location.** `note.md:1616` ("Those numbers are in §17.3"), `:1705`
("62,116,444 B raw, 1,192,711 B gzip — §17.3"), `:1709` ("at `a830d713…` in
§17.3").

§17.3 is "Must-fix 3 — the untracked corpus now has recorded bytes" (the byte
census of `tests/raptor3/g4/**`). The measurements those three lines promise —
the claim set at `a830d713…`, the 62,116,444 B corpus, the transport lane's red
at `a830d713…` — are all in §17.4, "Measured results". A reader following the
pointer lands on file hashes instead of results.

**Probe.** Same file, cell "points a reader at the section that actually holds
the round-4 measurements" — red, naming all three lines. The cell derives the
target section number from the heading rather than hard-coding "17.4", so it
keeps working if the section is renumbered.

**Resolution.** Change the three `§17.3` references to `§17.4`.

### 3. note — the §17.8 blocker closed on the first try here; it is a scheduling constraint, not an open defect

The archive → restore → replay path that four attempts could not complete is
green in this review, twice over: `replay` straight from the raw corpus of a
fresh child (09:11) and the receipt's own `restoreCommand` + `replayCommand`
verbatim after `archiveG3GeneratedCorpus` (09:12), restored sha256
`715718984add…` equal to the archive receipt's `originalSha256`, "Raptor 3
replay contract gate verified" both times. The author's attempt 4 receipt shows
exactly the expected cause — production equal on both sides, harness
`d8ac2a49… → 85895c70…` — so the attribution is right and the gate is working.

**Resolution.** Keep the receipts, but downgrade the wording from "blocker"
to what handoff request 7 already says: the replay gate needs a window in which
no other stream writes `tests/raptor3/**` or `scripts/**`. Nothing in the lane
is waiting on anyone.

### 4. note — the transport red is not tied to offset 27

The lane's **last** legal child (`g4-write-transport-seed-batch 124900`), which
no round has run, is red with the same class at
`g3-c11-124911-0:recurrence-0` — offset **11**, not 27. So the failure is "the
first C11 recurrence cell of the child", not a constant offset, which
strengthens the §15.7 / §16.3 attribution to the generated-transport path in
`src/` rather than to `G4_WRITE_TRANSPORT_CAMPAIGN`. Worth one line beside
integrator request 5.

**Caveat, stated rather than hidden:** this child ran after production had begun
moving again (its `attempt.json` reads `216564c2…`, its progress receipt
`b95ad5ec…`), so it is a datum about the lane on a moving tree, not a
measurement at `a830d713…`. Receipt: `write-lane-boundary-refusals.log`.

### 5. note — `a830d713…` was already historical before this review ended

Production moved twice while I worked: `a830d713…` → `6f2bb1e6…` (inside my CLI
self-test, ~09:19) → `9f35360f…` (09:26,
[identity-after.json](witness-followup-review4-receipts/identity-after.json)).
Every identity-sensitive row in my table was taken before the first move and
carries `a830d713…` in its own receipt. §17.10 claim 1 is therefore load-bearing
rather than boilerplate: the integrator must re-measure at whatever identity is
actually qualified, and no round of this stream can close that gap while phase 2
is landing.

### 6. note — the disk figures are stale in both directions

`note.md` §16.5 / §17.9 and handoff request 6 record 6.4 → 6.2 → 6.0 → 5.1 GiB
free. The volume read **9.5 GiB** when I started and **29 GiB** twenty minutes
later. The note's own instruction ("re-measure immediately before any campaign
run; do not treat any of these figures as the number that will be there") is the
right one and is what the integrator should read; the absolute numbers are
already wrong in the generous direction.

---

## The §7 decision-elimination gate

The diff has not moved since the round-3 review — same ten tracked harness
files, same 88,236 B, `grep -c '^+++ b/src/'` = **0**, same blob ids — so my
round-3 answers stand unchanged and are not restated here. Nothing in repair
round 4 touched a production file, a harness file or a test file except the
note-6 falsification, which was performed against a scratchpad backup, reverted
inside the same command and verified byte-identical by hash and by patch.

No second public-syntax walker, per-verb codec, duplicated result-shape
preparation, recreated lifecycle, projection rebuilt for a decoder, JavaScript
arithmetic beside SQL, policy-boolean bag, per-feature interpreter,
fixture-named flag, legacy import, cached absence or public-contract change.

## Cost check

Incremental core and complete charged cost **0 LOC / 0 parser tokens / 0 bytes**,
confirmed: the charged file list is `src/`-only, the regenerated patch contains
no `src/` file, and the ten working-tree blob ids are unchanged.
`scripts/query-engine-structure.mjs` was correctly not re-run — with an empty
`src/` delta it could only re-measure another stream's absolute figures.

## Author claims this review could not verify

1. **That this stream never edited `src/`.** The patch, the blob ids and the
   corpus snapshot all agree, but production moved under another author four
   times across the rounds; no receipt can rule out a foreign edit being
   attributed here, only show this stream's files unchanged.
2. **The harness-delta arithmetic at its own instant.** `harness-delta-proof*.json`
   reproduce `32af4729…` over 420 files and their `harnessWithAll` matches the
   captured brackets exactly, which is self-validating; I could not re-run it
   to the same value because my own probe files (and two other streams) have
   since moved the harness.
3. **That the two write parents work over 250 children each.** Five distinct
   SQLite children have now run green across rounds 3 and 4 and this review
   (75000, 75100, 75200, 75300, 99900), several of them more than once, and
   **zero** transport children are green — two of the transport lane's own
   children (100000 and its last, 124900) are red. The parents themselves have
   still never been executed.
4. **The `g2-mysql-contracts` reds and the two `route-transactions` LX
   DIVERGENCE PINs.** Carried forward from §15.7, not re-run here.
5. **The `test:all` inner failures.** Matched by signature (11 failed / 747
   passed, the same two files), not diagnosed.
6. **The 75200 child's result.** Its JSON receipt was deleted with its corpus,
   which §17.10 claim 6 discloses; that row rests on its log alone.
