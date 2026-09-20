# Release unit "perf" — performance and size, re-measured on the release tree

Author: the `perf` release unit. Brief: [`brief.md`](brief.md), with
[`../../briefs/common.md`](../../briefs/common.md)'s twelve rules binding.
Worktree `/private/tmp/viborm-perf`, branch `release-perf`, HEAD
`36c87710aa2526652867430f6e24f30005556394` (commit 30, D-58). Baseline
`5a37bcd7f371fe393cf7cecb8ec9f82ef8bd3062` (commit 3, the last tree whose
SHIPPED engine is the old one) in `/private/tmp/viborm-perf-baseline`.

**This unit measures. It changed no production file.** The single working-tree
change it leaves behind is this directory. Nothing was committed, staged, reset,
stashed or pushed; no lock file was removed.

Whole-estate typecheck on the release tree: **0 diagnostics**, `EXIT=0`
([`receipts/typecheck.txt`](receipts/typecheck.txt)). The two historical Pattern
TS2345 errors `common.md` still permits no longer exist — `pattern/` was retired
at commit 5 (D-15).

---

## 0. The headline, in four sentences

1. Every **size** target is met: engine bundle **0.646** of the frozen baseline
   (target ≤ 0.75), both public PostgreSQL fixtures **0.735** (target ≤ 1.00),
   `src/query-engine/**` **0.348** of the old engine's 46,021 token-LOC
   (target ≤ 0.60).
2. The **writes win and the reads hold**: the two conditional writes are 20 %
   cheaper in CPU and the key transition 9 %, peak RSS on the writes is 10–21 %
   better, `scalar-find-unique/full` and `fixed-collection-rowref-20/full` pass,
   and `flat-scalar-update` end to end is **0.691** CPU.
3. The **preparation path is the whole of the bad news**. At the bracket D-9
   accepted, the four cells read **1.215 / 0.985 / 1.315 / 1.325** against stage
   2d's 1.19–1.32, 0.97–0.99, 1.25–1.26 and 1.31–1.40: three sit inside their
   own earlier range and `fixed-collection-rowref-1000` is about 5 % above it,
   so little or nothing has regressed since D-9 — but three of the four are
   still over the 1.12 D-9 names. How much of the wider statement-seam gap is
   the bracket differs by cell (§4.3): most of it on the headline read, a tenth
   and a fifth on the two large-payload cells. At the seam the frozen protocol always
   bracketed, the headline cell reads 1.705–1.711.
4. Four things **block** and are reported with their profiles rather than
   repaired here: the preparation cells against D-9's 1.12, the D-28 decode
   cell, the `flat-scalar-update` evidence gap this series' un-adapted
   instrument opens (§4.2), and the +5.0 % public-bundle growth against the
   final report's "0.700".

---

## 1. What this series is, and what it is not comparable with

### 1.1 Neither tree carries the phase adapter, and this series did not apply it

Protocol [§2](../../cutover/protocol.md) built a phase adapter because the
pre-cutover candidate published only `prepareBatch()`, so `createReadHarness`
could not run at all. **On the release tree that is no longer true.** The 24
`PROTOCOL_PATHS` files are **byte-identical** between the two trees, file by
file, and both compute the same protocol hash
([`receipts/protocol-paths-check.json`](receipts/protocol-paths-check.json)):

| | value |
| --- | --- |
| `protocolIdentity(...).sha256`, this series | `2e35d9a73c57468f7a840a1ab8251393f489ae3b933db8e511e26a8591d5f087` |
| stages 2a / 2b | `6716a2229286205dac80b62ed962483ff26804f5580f614730be0d1fbd33089d` |
| stages 2c / 2d (the adapter overlay) | `f23e0aace9f0a8de55a1218d054870c1353a8456ec441f91d8bc5e437e0af22a` |

Neither arm carries an overlay commit, so no `--baseline-source-commit` is
passed and `validateCheckout`'s overlay rule is not exercised. This is a **new
protocol identity**: the bracket is the frozen protocol's **original statement
seam** (`capability.prepare()`) on both sides, not stage 2c/2d's package seam.

**Consequence, stated before the numbers are read: the `prepare`-family ratios
in this series are NOT comparable command for command with stage 2c's or 2d's.**
The `full` cells are, because `full` went through the public entry in every
series.

**And the statement seam does not bracket equivalent work on these two trees.**
Plan §7, quoted at the head of `protocol.md`, requires a bracket that *"must
bracket equivalent work, including input/default preparation and decoding"*.
This unit's own v5 probe measures that `capability.prepare()` is not that
bracket here: on `scalar-find-unique`, moving to the superset seam
`prepareBatch()` costs the candidate **+0.28 µs/op** (16.22 → 16.50) and the
baseline **+3.53 µs/op** (10.05 → 13.59)
([`receipts/probes/seam-summary-v5.json`](receipts/probes/seam-summary-v5.json)).
Since the package seam is a superset of the statement seam on both sides, at
least 3.25 µs of that asymmetry is work the shipped engine defers past
`prepare()` and the candidate has already done inside it. **The `prepare` rows
of §3 are therefore a bracket artefact plus a real cost, and they are not the
D-9 comparison**; §4.3 measures the D-9 bracket directly on all four of them and
is where the preparation verdicts are read from. Running the frozen protocol
un-adapted was this unit's instrument choice, not a property of the release
tree: the protocol's own instrument for that bracket,
`g4/cutover/phase-adapter.patch`, applies cleanly to both arms (§4.2).

### 1.2 The two sides, and the two scratch trees

| Side | Worktree | Commit | State |
| --- | --- | --- | --- |
| baseline (old engine shipped) | `/private/tmp/viborm-perf-baseline` | `5a37bcd7f371…` | detached, `git status --porcelain` empty; the integrator's, reused as instructed |
| candidate (release tree) | `/private/tmp/viborm-perf-cand` | `36c87710aa25…` | detached, clean, **created by this unit** |
| coordinator | `/private/tmp/viborm-perf-baseline` | — | the comparator runs from here |

**Why a third worktree.** `operation-pipeline-compare.mjs` refuses a dirty
checkout (`validateCheckout`) and refuses any checkout that is not a linked
worktree of the coordinator's Git common directory. `/private/tmp/viborm-perf`
is dirty from the moment the integrator put `brief.md` in it, so it cannot be an
arm. A local `git clone` into TMPDIR was tried first and refused for the common
directory rule; the accepted answer is the one the brief itself names for
scratch copies — `git worktree add --detach` — with a cone `sparse-checkout` of
`src benchmarks scripts` so the 3.1 GB of tracked evidence is not materialised.
`src/`, `benchmarks/`, `scripts/` and the four root build files are
**byte-identical** to `/private/tmp/viborm-perf`'s (`diff -rq`, verified before
the series), and `node_modules` is a symlink to the release worktree's, so both
arms resolve the same installed dependencies. The two `pnpm-lock.yaml` files are
byte-identical, so no separate `pnpm install` was needed on either side.

### 1.3 Method

`benchmarks/operation-pipeline-compare.mjs`, `--providers sqlite3 --comparison
semantic`, one cell in one mode per command, **five alternating fresh-process
pairs per side**, `--iterations 1000 --warmup 200` on
`fixed-collection-rowref-1000` cpu only, everything else at the catalog default
(5,000/1,000; 1,000/200 for the bulk cell). `measurementProtocolValid: true` on
every measured cell. Driver
[`receipts/series-driver.mjs`](receipts/series-driver.mjs) — stage 2d's driver
with four mechanical adaptations and **no change to its lock classification**;
aggregator [`receipts/aggregate.mjs`](receipts/aggregate.mjs) — stage 2d's with
five, and **no change to any straddle test, roll-up or metric set**. Both
adaptations are listed in the files' own headers.

Cell order: the brief requires the cells the rulings can touch first. §2 names
them; the driver runs them in that order and the journals record it.

**Two full passes** were run because pass 1 left five cells
`inconclusive-repeat`, which is exactly the one permitted repeat. The cell
verdict is the worse of the two, unchanged from stage 2d.

### 1.4 The verdict rule, and where D-9 enters it

The protocol gate is unchanged: `(N − B) + E ≤ budget`, `E = 2 × max(MAD)`, no
outlier removal, an improvement claim needs improvement `> E`. The **budget**
carries D-9: `0.12 × B` on the three preparation cells D-9 accepted, `0.05 × B`
on every other CPU/wall cell, `0.10 × B` on peak RSS.

Which three cells D-9 accepted is not spelled in one place, so the reading is
recorded: D-9's own sentence quotes `scalar-find-unique/prepare` and
`bulk-update-returning-100/prepare` at ≈ 1.12×; the final report's "the three
cells that were 1.40–2.15× at the start … 1.19–1.40× now" and stage 2d's tally
name the third as `fixed-collection-rowref-1000/prepare` (1.40 → 1.25). Those
three carry 0.12; `fixed-collection-rowref-20/prepare`, which stage 2d put
**under parity**, carries the plain 5 %.

---

## 2. Which cells the rulings can touch (brief §1), measured first

Receipt: [`receipts/rulings-reach.txt`](receipts/rulings-reach.txt), and the
probes it cites.

| Ruling | Cells it can touch | Evidence |
| --- | --- | --- |
| **D-33** — a `json().schema(…)` user schema runs per JSON value | **none of the 20** | all 20 cells are `core` fixture cells; `coreSchema` has no `json()` field; the only two `s.json()` in `benchmarks/` are in the cross-provider fixture and neither declares a schema; `.schema(` appears nowhere in `benchmarks/` |
| **D-26** — one correlated integrity probe per configured polymorphic membership under `only: []` | **none of the 20** | `polymorphic` and `only: [` appear nowhere in `benchmarks/` |
| **D-29** — a queued premise rides the atomic unit it protects | `flat-scalar-update/{prepare,execute,full}` | [`receipts/probes/fsu-publish-*.json`](receipts/probes/) |
| **D-28** — the result seam | `fixed-collection-rowref-1000/parse` and every `/full` cell | the decode boundary is what `parse` and `full` cross |
| **D-58** — a produced value is carried into the next segment | the multi-segment writes | [`receipts/probes/count__*.json`](receipts/probes/) |

### 2.1 D-29: the two sides share no seam at all for `flat-scalar-update`

This **supersedes protocol §2.3's table for this identity** and is the cause of
the evidence gap in §4.2.

| Side | `capability.prepare()` | `capability.prepareBatch(driver)` | `buildStatement()` |
| --- | --- | --- | --- |
| baseline | does not answer | **refuses**: *"Step 'user.update' carries a postcondition that is not yet enforced in batch mode."* | answers one statement |
| candidate | does not answer | answers, **2 statements** | `null` |

The candidate's two statements are D-29's premise placement, verbatim from the
receipt:

```sql
SELECT CASE WHEN EXISTS (SELECT "q0"."id" FROM "bench_users" AS "q0" WHERE "q0"."id" = ?)
       THEN 1 ELSE json_extract('x', '$') END AS "__viborm_assert__"
UPDATE "bench_users" SET "age" = "age" + ? WHERE "id" = ? RETURNING …
```

`buildStatement()` answering `null` is consistent with D-14 rather than against
it: D-14 makes it answer *the one statement an operation compiles to*, and this
operation compiles to two.

### 2.2 D-58: it costs no extra statement, and the receipt does not show the mechanism

Statements per **public** operation, counted from outside at `driver.execute`
(the seam every statement crosses, including inside `withTransaction`), 30
operations per side:

| Cell | baseline | candidate |
| --- | ---: | ---: |
| `nested-conditional-found/full` | 4 | **4** |
| `nested-conditional-missing/full` | 4 | **4** |
| `key-transition-cascade/full` | 3 | **3** |
| `relation-series-2/full` | 7 | **3** |
| `bulk-update-returning-100/full` | 1 | **1** |
| `scalar-find-unique/full`, `fixed-collection-rowref-20/full` | 1 | **1** |
| `flat-scalar-update/full` | 1 | **1** (the frozen harness refuses this cell — §4.2; counted at the same seam through the public entry: [`review-receipts/review-fsu-count-baseline.json`](review-receipts/review-fsu-count-baseline.json), [`…-cand.json`](review-receipts/review-fsu-count-cand.json)) |

D-58's mechanism does not show up in the count, and the receipt does not let it
be read off the SQL either. The candidate's first three statements per operation
on `nested-conditional-found`, in the order
[`receipts/probes/count__nested-conditional-found__cand.json`](receipts/probes/)
lists them:

```sql
INSERT INTO "bench_generated_parents" ("label") VALUES (?) RETURNING "id" AS "id"
SELECT "q0"."id" AS "id", "q0"."parentId" AS "parentId", "q0"."label" AS "label"
  FROM "bench_generated_children" AS "q0" WHERE "q0"."id" = ?
  ORDER BY "q0"."id" ASC LIMIT ?
UPDATE "bench_generated_children" SET "parentId" = ? WHERE "id" = ?
```

The shipped engine sends the same three in a different order — it reads the
child *first*, then `INSERT … RETURNING "id"`, then `UPDATE … SET "parentId" =
CAST(? AS INTEGER) … RETURNING "id", "parentId"`. **The produced id arrives as a
bound `?` on both sides.** What this receipt distinguishes is order and
spelling (the cast; the candidate's `UPDATE` carrying no `RETURNING`), not a
carried value against a read-back one: neither side re-reads the inserted parent
row, so a read-back is not what either of them does here. **On none of the 20
cells does the release tree send one statement more than the shipped engine**;
on `relation-series-2` it sends four fewer.

---

## 3. The A/B table

Full record: [`performance-release.json`](performance-release.json) (per cell:
`B`, `N`, both MADs, `E`, budget, signed delta, `(N−B)+E`, every raw sample,
both passes). Pass 1 alone is retained as
[`performance-release-pass1.json`](performance-release-pass1.json). Per-cell
evidence reports and logs: [`receipts/cells/`](receipts/cells/), gzip −9, with
`pass1-journal.txt` and `pass2-journal.txt` recording every command in order
with its exit code, duration and lock attempts.

`cpu` and `wall` are the **worse** of the two passes; `rss` likewise.

**Read the `prepare` rows as §1.1 says.** They are bracketed at
`capability.prepare()`, which is not equivalent work on these two trees (+0.28
µs/op on the candidate against +3.53 µs/op on the baseline to reach the common
superset seam), so they are a bracket artefact plus a real cost and **not** the
D-9 comparison. §4.3 measures the D-9 bracket for all four of them, and that is
where their verdicts are to be read from.

| Cell | budget | CPU B → N (µs/op) | ratio | E | `(N−B)+E` | wall | RSS | verdict |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `scalar-find-unique/cold-prepare` | 5 % | 168.48 → 174.82 | 1.038 | 6.46 | 12.80 | 1.039 | 0.994 | inconclusive after the repeat — blocks |
| `scalar-find-unique/prepare` | **12 %** | 10.14 → 17.34 | **1.711** | 0.10 | 7.31 | 1.472 | 1.002 | **blocks adoption** |
| `scalar-find-unique/execute` | 5 % | 6.38 → 6.43 | 1.007 | 0.28 | 0.33 | 1.015 | 0.981 | inconclusive after the repeat — blocks |
| `scalar-find-unique/full` | 5 % | 29.01 → 26.32 | 0.907 | 1.49 | −1.20 | 0.962 | 0.980 | **pass** |
| `flat-scalar-update/prepare` | 5 % | — | — | — | — | — | — | not measurable comparably — **no end-to-end evidence retained** |
| `flat-scalar-update/execute` | 5 % | — | — | — | — | — | — | not measurable comparably — **no end-to-end evidence retained** |
| `flat-scalar-update/full` | 5 % | — | — | — | — | — | — | not measurable comparably — **no end-to-end evidence retained** (see §4.2) |
| `fixed-collection-rowref-20/prepare` | 5 % | 23.95 → 29.02 | 1.212 | 0.80 | 5.87 | 1.310 | 0.992 | **blocks adoption** |
| `fixed-collection-rowref-20/execute` | 5 % | 31.51 → 32.70 | 1.038 | 0.18 | 1.37 | 1.039 | 0.984 | **pass** |
| `fixed-collection-rowref-20/full` | 5 % | 73.71 → 72.24 | 0.980 | 0.67 | −0.81 | 1.035 | 0.925 | **pass** |
| `nested-conditional-found/full` | 5 % | 158.96 → 127.33 | **0.801** | 2.35 | −29.27 | 0.883 | 0.902 | **pass** |
| `nested-conditional-missing/full` | 5 % | 156.59 → 124.65 | **0.796** | 2.54 | −29.39 | 0.915 | 0.901 | **pass** |
| `key-transition-cascade/full` | 5 % | 106.80 → 97.11 | 0.909 | 1.35 | −8.33 | 1.030 | **0.792** | inconclusive after the repeat — blocks |
| `bulk-update-returning-100/prepare` | **12 %** | 40.27 → 62.65 | **1.556** | 3.24 | 25.62 | 1.327 | 0.985 | **blocks adoption** |
| `bulk-update-returning-100/full` | 5 % | 184.01 → 177.21 | 0.963 | 5.57 | −1.23 | 1.041 | 0.986 | inconclusive after the repeat — blocks |
| `relation-series-2/full` | 5 % | — | — | — | — | — | — | **blocks adoption — required contract divergence** |
| `fixed-collection-rowref-1000/prepare` | **12 %** | 38.82 → 56.91 | **1.466** | 0.93 | 19.03 | 1.308 | 0.969 | **blocks adoption** |
| `fixed-collection-rowref-1000/execute` | 5 % | 585.41 → 583.78 | 0.997 | 9.57 | 7.94 | 0.995 | 0.956 | **pass** |
| `fixed-collection-rowref-1000/parse` | 5 % | 475.82 → 520.64 | **1.094** | 12.45 | 57.27 | 1.138 | 0.953 | **blocks adoption** |
| `fixed-collection-rowref-1000/full` | 5 % | 1130.91 → 1201.14 | 1.062 | 34.05 | 104.28 | 1.062 | 1.055 | inconclusive after the repeat — blocks |

Tally: **6 pass / 5 blocks adoption / 5 inconclusive after the one permitted
repeat / 3 not measurable comparably / 1 required contract divergence.** Two of
the five inconclusives — `scalar-find-unique/execute` and
`bulk-update-returning-100/full` — were `inconclusive-repeat` on pass 1 and
**passed** on their repeat; they are carried as blocking by the
worse-of-two-passes rule (§1.3), which is stage 2d's unchanged and errs against
the candidate.

Peak RSS is **below parity on 14 of the 16 measurable cells**, with 10–21 %
wins on the nested and conditional writes (`key-transition-cascade/full` 0.792).
Two cells sit above it: `scalar-find-unique/prepare` at 1.002, which passes, and
`fixed-collection-rowref-1000/full` at 1.055, whose RSS metric is
`inconclusive-repeat` on its own — that cell's CPU metric is inconclusive too,
so RSS is not what decides it, but it is not inside the 10 % budget either. On
every other cell the RSS metric passes.

`relation-series-2/full` refuses exactly as it did at identities 3 and 4: every
one of the 10 replicate runs completed on both sides and the **between-engine**
comparison then refused with `AssertionError ["sqlite3","relation-series-2"]
changed final` — D-8's counter-default ids, a known and recorded contract
divergence, not a timing result. The log is the receipt; no evidence report was
written.

### 3.1 The `full` cells against stage 2d, which IS comparable

`full` is end to end through the public entry in every series, so these rows can
be read against `performance-identity4.json` directly. Worst CPU ratio of the
two passes, each series against its own baseline:

| Cell | stage 2d (identity 4) | this series | movement |
| --- | ---: | ---: | --- |
| `scalar-find-unique/full` | 0.902 | 0.907 | flat |
| `fixed-collection-rowref-20/full` | 0.976 | 0.980 | flat |
| `fixed-collection-rowref-1000/full` | 1.026 | 1.062 | +3.5 % |
| `nested-conditional-found/full` | 0.760 | 0.801 | +5.4 %, still a 20 % win |
| `nested-conditional-missing/full` | 0.759 | 0.796 | +4.9 %, still a 20 % win |
| `key-transition-cascade/full` | 0.896 | 0.909 | +1.5 % |
| `bulk-update-returning-100/full` | 0.838 | 0.963 | **+14.9 %** |
| `flat-scalar-update/full` | 0.702 | 0.691 (probe, §4.2) | flat |

`bulk-update-returning-100/full` is the one end-to-end cell that moved
materially since identity 4. It is still **under** parity (0.963) and its
verdict here is inconclusive, not blocking on its own merits, but the movement
is real and is reported as a blocker in §4.5 rather than explained away.

---

## 4. Blockers, with their profiles

### 4.1 B1 — a stale workspace lock in the integrator's TMPDIR (environment)

`/private/tmp/viborm-perf-tmp` already held
`viborm-test-c33ebb4c906dfea8.lock`, written **2026-09-20T00:40:04Z** by
`{"pid":33729,"label":"Vitest"}`, hours before this unit began. PID 33729 does
not exist; no `vitest`, `tsc`, `tsdown` or `tinypool` process is running
anywhere on the machine; it is the only lock file under any
`/private/tmp/viborm-*-tmp`. Receipt:
[`receipts/lock-scan.txt`](receipts/lock-scan.txt).

The lock key is derived from the Git **common** directory, so this one file
refuses every command in that TMPDIR, and `acquireTestRunLock` refuses a stale
lock rather than waiting — retrying can never clear it.

**No lock file was removed.** The series ran with
`TMPDIR=/private/tmp/viborm-perf-tmp/run`, a fresh subdirectory *of* the
mandated TMPDIR, so temporary files still land under it, this unit held a real
lock of its own, and the stale file is untouched for the integrator to clear
deliberately. This is the one instruction from the prompt not executed as
literally written; the substitute and the reason are recorded here.

### 4.2 B2 — `flat-scalar-update` keeps no end-to-end evidence in **this** series, because this series ran the frozen protocol un-adapted

`createMutationHarness` calls `prepareForRawExecution` for **every** stage, and
that helper demands one executable statement. The candidate publishes two (§2.1),
so the candidate worker dies with *"Mutation workload did not build one
executable statement"* before any stage is timed — including `full`, which the
protocol says must stay measurable end to end.

The protocol's verdict for such a cell is *"not measurable comparably —
end-to-end evidence retained"*, and through **this** series' instrument the
end-to-end evidence is not retained, which the aggregator says in those words
rather than reusing stage 2d's sentence. **That is an instrument choice this
unit controlled, not a property of the release tree**, and the three things that
establish it are measured:

- The protocol's own instrument for this case is
  `g4/cutover/phase-adapter.patch` — five files, all under `benchmarks/`, all
  inside `PROTOCOL_PATHS` — which stages 2c/2d applied as a byte-identical
  overlay commit on each scratch arm. It **applies cleanly to both arms of this
  series**: `git apply --check` returns `RC=0` on `/private/tmp/viborm-perf`
  (36c87710a), `/private/tmp/viborm-perf-baseline` (5a37bcd7) and
  `/private/tmp/viborm-perf-cand` (36c87710a), and all three trees stayed clean
  (`--check` writes nothing). Receipt:
  [`receipts/repair/phase-adapter-apply-check.txt`](receipts/repair/phase-adapter-apply-check.txt).
- Under that adapter the harness does not refuse the workload: when a side
  publishes no single statement to isolate, `createMutationHarness` returns
  `createFullOnlyHarness(...)` and keeps the public-entry `full` cell.
- That is not a reading of the patch alone. Stage 2d **measured** this cell's
  `full` through the comparator under exactly this adapter, at **0.698 / 0.702**
  (`g4/cutover/performance-identity4.json`, `flat-scalar-update/full`, both
  passes `pass`, with its `prepare` and `execute` cells recorded *"not
  measurable comparably — end-to-end evidence retained"*).

This unit retains the evidence with its own probe instead
([`receipts/probes/flat-scalar-update-probe.mjs`](receipts/probes/flat-scalar-update-probe.mjs),
[`receipts/probes/fsu-full-summary.json`](receipts/probes/fsu-full-summary.json)):
the same world (`createBenchmarkFixture` with the catalog's own fixture and
substrate), the public entry the harness's `full` stage calls, five alternating
fresh-process pairs per side, 5,000 iterations after 1,000 warmup, no forced
collection before the measured loop.

| metric | B | N | ratio | E | budget | verdict |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| CPU µs/op | 41.41 | 28.63 | **0.691** | 1.67 | 2.07 | pass |
| wall µs/op | 23.68 | 19.90 | 0.841 | 1.01 | 1.18 | pass |
| peak RSS | 140.0 MB | 136.0 MB | 0.971 | 2.0 MB | 14.0 MB | pass |

**Why the overlay was not run here.** Applying the adapter to an arm is an
overlay *commit* on that arm, and this unit commits nothing (`common.md`; the
brief's "never commit, stage, reset, stash or push"). The fuller answer is one
overlay commit per scratch arm away: re-run the five preparation cells and the
three `flat-scalar-update` cells over two passes and publish both brackets. It
yields a third protocol identity, not stage 2d's `f23e0aac…`, because the 24
`PROTOCOL_PATHS` files themselves moved since then — seam equivalence, not byte
equivalence, is what makes such a comparison meaningful, which §4.3 already
relies on.

**The `benchmarks/` change this unit would otherwise ask for stands as the
alternative, not as the primary answer** — the primary answer is the overlay the
protocol already owns, above. For whoever owns
`benchmarks/operation-pipeline-mutation-workloads.mjs`:

> `createMutationHarness` should call `prepareForRawExecution` only for the
> stages that need one raw statement (`prepare`, `cold-prepare`, `execute`,
> `raw-parse`), not for `full`, which goes through the public entry and needs no
> prepared statement at all. Today a workload whose operation compiles to more
> than one statement loses its `full` cell as collateral.

Whichever route is taken, the public statement count for this cell is **1 on
both sides** (§2.2): nothing about the release tree's behaviour is in question
here, only which bracket the frozen harness can hold.

### 4.3 B3 — the preparation cells against D-9's 1.12

Four preparation cells are over budget, three of them against D-9's own 1.12:

| Cell | this series (statement seam) | budget | over by |
| --- | ---: | ---: | ---: |
| `scalar-find-unique/prepare` | 1.711 | 1.12 | +0.59 |
| `bulk-update-returning-100/prepare` | 1.556 | 1.12 | +0.44 |
| `fixed-collection-rowref-1000/prepare` | 1.466 | 1.12 | +0.35 |
| `fixed-collection-rowref-20/prepare` | 1.212 | 1.05 | +0.16 |

**Every one of the four now has a reading at D-9's own bracket, and how much of
the gap the bracket explains differs by cell.** Both the bracket and the GC
effect are measured, not asserted — §5 is the whole falsification chain. Same
trees, same machine, the counts the series ran each cell at, five fresh-process
pairs per arm
([`receipts/probes/seam-summary-v5.json`](receipts/probes/seam-summary-v5.json)
for the three reads;
[`receipts/probes/seam-summary-v6.json`](receipts/probes/seam-summary-v6.json)
for the bulk write, measured in the repair round — §10):

| Cell | statement seam (this series' bracket) | package seam (the bracket D-9 accepted) | of the excess over parity, the bracket explains | stage 2d, package seam |
| --- | ---: | ---: | ---: | ---: |
| `scalar-find-unique/prepare` | 1.613 | **1.215** | 0.398 of 0.613 | 1.189 / 1.318 |
| `fixed-collection-rowref-20/prepare` | 1.150 | **0.985** | all of it (under parity) | 0.974 / 0.988 |
| `fixed-collection-rowref-1000/prepare` | 1.349 | **1.315** | 0.034 of 0.349 | 1.250 / 1.257 |
| `bulk-update-returning-100/prepare` | 1.411 | **1.325** | 0.086 of 0.411 | 1.310 / 1.397 |

The probe's statement arm reproduces the series on every row (1.613 against the
series' 1.705–1.711; 1.150 against 1.164–1.212; 1.349 against 1.457–1.466;
1.411 against 1.556 / 1.432 — 1.5 % below the nearer pass, where the cell's own two passes differ by 8.7 %), which
is what makes its package arm evidence about the bracket rather than about the
instrument. At the bracket D-9 measured, `scalar-find-unique/prepare` sits
**inside stage 2d's own range**, `fixed-collection-rowref-20/prepare` is back
under parity, and `bulk-update-returning-100/prepare` — the cell the first
version of this table omitted — reads **1.325**, inside stage 2d's own
1.310 / 1.397 and still **+0.21 over D-9's 1.12**.

**So "most of this is the bracket" is withdrawn as a statement about the four.**
It is true of the headline read (0.398 of its 0.613) and of
`fixed-collection-rowref-20` (which returns under parity); it is **not** true of
the two large-payload cells, where the bracket explains a tenth and a fifth of
the excess and the rest is real preparation cost at the bracket D-9 named.
`scalar-find-unique/cold-prepare` (1.038, inconclusive rather than over budget)
is now the only preparation cell with no package-seam reading; nothing in this
note rests on it.

**What is left after the bracket is subtracted, and is a decision for Arnaud:**

1. At the D-9 bracket the headline cell is **1.215**, and D-9 said 1.12. Stage
   2d already read 1.189–1.318 there, so nothing has regressed since D-9 — but
   the acceptance was never met at the number it names, and this series is the
   first to say so against a shipped-engine baseline.
   `bulk-update-returning-100/prepare` is the same story at that bracket:
   **1.325** against stage 2d's 1.310 / 1.397 — inside its own earlier range,
   and over the 1.12 D-9 named.
2. `fixed-collection-rowref-1000/prepare` reads **1.315** at the package seam
   against stage 2d's 1.250/1.257 — about +5 %, the one preparation cell that
   may genuinely have moved. It is at the edge of what three instruments can
   separate and is reported as *possible* movement, not as a regression.
3. The **real** engineering fact under all of it: the candidate's preparation
   path is far more GC-sensitive than the shipped engine's. Measured directly on
   `scalar-find-unique/prepare`, three runs per side, median, with and without a
   forced collection between warmup and the measured loop
   ([`receipts/probes/gc-sensitivity.txt`](receipts/probes/gc-sensitivity.txt)):

   | | forced `gc()` | no forced `gc()` (what the worker does) |
   | --- | ---: | ---: |
   | baseline CPU µs/op, the three runs → median | 10.61 · 10.61 · 11.28 → **10.61** | 9.98 · 10.21 · 10.74 → **10.21** |
   | candidate CPU µs/op, the three runs → median | 16.15 · 14.40 · 15.34 → **15.34** | 17.15 · 17.23 · 16.28 → **17.15** |
   | **ratio of the medians** | **1.446** | **1.680** |

   A collection before the loop costs the baseline ~4 % and saves the candidate
   ~12 %, compressing the ratio by 14 %. The uncompressed 1.680 is what the
   series reads (1.705–1.711). This is the same cause perf pass 2 named and did
   not close (`perf2/note.md` §5.4: “per-scavenge cost is still 6–10× the
   shipped engine’s … what is left of it is object LIFETIME inside one
   operation”).

   Three runs per arm, and the candidate's forced-`gc()` samples span
   14.40–16.15 (11 % of their median), so this pair separates its two
   conditions but does not bound the compression to better than a few per cent
   (§8, item 7).

### 4.4 B4 — `fixed-collection-rowref-1000/parse`, the D-28 cell, is newly over budget

| | pass 1 | pass 2 | stage 2d |
| --- | ---: | ---: | ---: |
| CPU ratio | 1.079 | 1.094 | 0.989 / 1.028 |
| wall ratio | 1.120 | 1.138 | — |

`parse` is the decode boundary, which is exactly what D-28 moved (the driver
`parseResult` consumer, `Queries.decodeResult` at `publishedTerminal`). It sat
inside the noise at identity 4 and is now 8–9 % over on CPU and 12–14 % over on
wall, on **both** passes, with `(N−B)+E = 57.27` against a budget of 23.79. Both
sides decode the same single statement (`statementCount` 1/1), so this is not a
bracket artefact.

`fixed-collection-rowref-1000/full`, which contains that decode, moved with it
(1.026 → 1.062). This is the clearest ruling-attributable movement in the
series and the one worth a profile before release.

**Addendum, 2026-09-20 (release unit P1, ruling D-61).** This cell was profiled
and repaired; this section is left as measured and is not rewritten. The profile
put **48.9 % of the whole `parse` profile** on one line — `decodeValue`'s object
arm rebuilding every decoded document through
`Object.fromEntries(Object.entries(shape.fields).map(…))` — and measured the
decoder allocating **2.51x** the shipped engine's bytes per row (1702 B against
677 B, protocol `alloc` mode) with 146 scavenges against 68 over the same
1,200-operation run. The three per-operation legs this section names are NOT the
cost and are not asked per row: `Queries.decodeResult` is 0.01 % of the profile,
its adapter arm 0.01 %, the shipped SQLite adapter's own parser 0.00 %. After the
repair the cell reads **0.655 / 0.649 CPU and 0.681 / 0.674 wall** over two
alternating five-replicate series, allocation per row falls to 847 B, and
`fixed-collection-rowref-1000/full` — which §4.4 records moving 1.026 → 1.062
with it — reads **0.819**. B4 is closed.
See [`../p1/note.md`](../p1/note.md).

### 4.5 B5 — `bulk-update-returning-100/full` moved 0.838 → 0.963

Same bracket in both series (public entry), same statement count (1/1), both
passes agree (0.963 / 0.945). Still under parity, so it does not block on its
own, but a 15 % relative loss on an end-to-end write cell between identity 4 and
the release tree is not noise and is not explained by this unit.

### 4.6 B6 — the public PostgreSQL bundles are 0.735, not the final report's 0.700

See §6. `+5.00 %` gzip against identity 4 on both public fixtures. The target
(≤ 1.00) is still met; the **final report's "Size" paragraph is now wrong** and
must be corrected before release.

### 4.7 B7 — `relation-series-2/full` still refuses between engines

Unchanged from identities 3 and 4 and already adjudicated (D-8). Recorded, not
re-adjudicated.

---

## 5. How the bracket claim was falsified before it was believed

The attribution in §4.3 is the load-bearing claim of this note, so the
instrument was falsified against the series four times. **Every attempt is kept
with its receipt and none is relabelled**
([`receipts/probes/README-v1.md`](receipts/probes/README-v1.md) and the
version-suffixed samples/summaries).

| Version | What it did | Statement-seam ratio, `scalar-find-unique` | Why it was superseded |
| --- | --- | ---: | --- |
| v1 | both seams in ONE process, statement first | 1.386 | ordering confound: the second arm inherited a warm JIT (candidate's package seam read 28.5 µs/op against its own statement seam's 44.6 for a superset of the work) |
| v2 | one seam per process, own bare fixture | 1.394 | did not reproduce the series (1.711) |
| v3 | one seam per process, the **series' own setup** (`createWorkloadHarness`) | 1.353 | still did not reproduce it — so the setup was not the variable |
| v4 | + each arm run the way the worker runs its **stage kind** (`prepare` is declared sync, so `runIterationsSync`, no `await` per iteration) | 1.414 | closer; still not it |
| **v5** | + **no forced collection** between warmup and the measured loop, because `operation-pipeline-worker.mjs` forces none | **1.613** | reproduces the series within noise on all three cells |

Which file is which attempt: [`receipts/probes/INDEX.md`](receipts/probes/INDEX.md).

Two instrument defects were found this way and both matter beyond this unit: an
`await` per iteration on a sync stage adds a constant to **both** sides and
compresses exactly the ratio under test, and a forced `gc()` before the measured
loop flatters whichever engine allocates more. `ab-stage.mjs` — the instrument
that produced the numbers D-9 was decided on — does both.

**Recorded as a consequence, not as a conclusion:** the A/B behind D-9
(`perf2/note.md` §5.3) was measured with a forced collection before its loop. If
that instrument behaves on that tree as it does on these two, the 1.117 it
reported for `scalar-find-unique/prepare` is optimistic by roughly the same
~14 %. This unit did not re-run it — the pass-2 scratch trees are gone — so this
is flagged as **unverified** in §8, not asserted.

---

## 6. Size

### 6.1 `pnpm size` on the release tree

[`receipts/size-run.txt`](receipts/size-run.txt) (`BUILD_EXIT=0`,
`SIZE_EXIT=0`). `pnpm package:build`: **181 files, 6,766.65 kB total**, 2.0 s.

| Entry | Size |
| --- | ---: |
| Main (`viborm`) | 1.97 kB |
| Schema | 214 B |
| Driver (pg) | 5.08 kB |
| Driver (pglite) | 3.83 kB |
| Cache | 187 B |
| Migrations | 4.46 kB |
| Validation | 283 B |

**What this is worth saying plainly:** no `size-limit` entry declares a `limit`
and none declares a bundler, so these are the **entry chunk sizes**, not the
dependency closure — `dist/index.mjs` is 1,967 bytes of re-exports. `pnpm size`
is a receipt that the command runs and what it reports; it is not a size budget
and cannot regress meaningfully. The size evidence that means something is §6.2.

### 6.2 The protocol's fixtures, against the frozen baseline

`node scripts/measure-raptor3-baseline.mjs --bundle`
([`receipts/bundles-run.txt`](receipts/bundles-run.txt),
[`receipts/bundles-release.json`](receipts/bundles-release.json)); ratios
computed against `docs/architecture/raptor3-evidence/baseline.json` (commit
`3a291a59`, read **read-only** from the main tree — it is untracked there and
therefore absent from this worktree) into
[`bundle-ratios-release.json`](bundle-ratios-release.json).

| Fixture | frozen gzip | release gzip | ratio | target | modules | raptor3 modules in fixture | vs identity 4 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `engine` | 156,771 | 101,276 | **0.646** | ≤ 0.75 ✓ | 241 → 180 | **16 / 16** (identity 4: 1) | 0.2377 → 0.646 |
| `pg-simple` | 262,658 | 192,986 | **0.735** | ≤ 1.00 ✓ | 427 → 313 | 16 / 16 (identity 4: 14) | **+5.00 %** |
| `pg-relations` | 262,788 | 193,115 | **0.735** | ≤ 1.00 ✓ | 427 → 313 | 16 / 16 (identity 4: 14) | **+5.00 %** |

**The engine-fixture re-point the brief asks for is a no-op, and that is
measured, not assumed.** The final report records the engine fixture as no
longer containing the candidate after the cutover (identity 4: **1** raptor3
module, 0.2377). On the release tree the fixture's declared entry
`src/query-engine/query-engine.ts` imports `./raptor3/route/client-route` at
runtime, and the measured fixture contains **all 16** of the repository's 16
`src/query-engine/raptor3/**/*.ts` files, listed file by file in
`bundle-ratios-release.json`. No fixture path change is required; the
restructuring at commit 5 (D-15) already re-pointed it. The follow-up can be
closed, and the "0.238" line in the final report is superseded by **0.646**.

The **+5.00 %** on both public fixtures is B6: the final report's "the public
PostgreSQL client fixtures are 0.700" must become **0.735**.

### 6.3 Source size, like for like

[`source-size-release.json`](source-size-release.json). Token-LOC = physical
lines on which at least one parser-owned TypeScript token starts.

**Two independent readers agree exactly**, which is the check that the number is
the same fact twice and not two facts: `scripts/query-engine-structure.mjs`
reports `src/query-engine/**` at 38 files / 20,319 lines / **16,036 token-LOC**,
and `scripts/measure-raptor3-baseline.mjs`'s `charged-engine` class reports 38
files / 20,319 / **16,036**.

| Reading | release | denominator | ratio | commit 5 | parity | target |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| engine only, `src/query-engine/**` | **16,036** | 46,021 | **0.348** | 0.315 | 0.334 | ≤ 0.60 ✓ |
| with the same two integration classes (15 files at the baseline, 14 here) | 19,896 | 49,887 | 0.399 | 0.368 | 0.385 | — |

`charged-g3-prep-shared` (11 files, 3,935 token-LOC) stays **out** of the
like-for-like, exactly as the ledger ruled — that class did not exist at the
baseline.

The census tool's own numbers for `src/query-engine/**`: 38 files, 20,319
physical lines, 16,036 token-LOC, 1,095 functions, 1,653 parameters, 36
functions with ≥ 5 parameters, 2,561 branch nodes, **1** runtime import-cycle
component over 3 files, 13 files over 300 lines, 7 over 600. Whole report:
[`receipts/query-engine-structure.json`](receipts/query-engine-structure.json).

The engine has grown 15,359 → 16,036 token-LOC (+677, +4.4 %) since parity,
through D-53, M1, D-58 and the rulings. Comfortably inside the target.

---

## 7. Verification (the brief's list)

- **Every number in the note has a receipt file.** The A/B table is
  `performance-release.json`, computed by `receipts/aggregate.mjs` from the
  per-cell gzip evidence reports in `receipts/cells/`; the size tables are
  `bundle-ratios-release.json` and `source-size-release.json`, computed from
  `receipts/bundles-release.json` and `receipts/query-engine-structure.json`;
  the seam attribution is `receipts/probes/seam-summary-v5.json` with every
  sample in `seam-samples-v5.json`, and `seam-summary-v6.json` /
  `seam-samples-v6.json` for the bulk cell added in the repair round (§10); the
  statement counts are
  `receipts/probes/count__*.json`; `pnpm size` and the typecheck are
  `receipts/size-run.txt` and `receipts/typecheck.txt`.
- **Interleaved runs are recorded in order.** `receipts/cells/pass1-journal.txt`
  and `pass2-journal.txt`: every command, its UTC timestamp, exit code, wall
  duration and lock attempt count, in execution order. Within each command the
  comparator alternates baseline/candidate for five fresh-process pairs per
  side; the per-cell logs record each `replicate n/5: baseline|candidate` line.
- **The machine load during the runs is stated.**
  `receipts/machine-before-smoke.txt`, `machine-pass1-start.txt`,
  `machine-pass2-start.txt`, `machine-after-series.txt`: 1-minute load average
  **5.55 → 8.77 → 8.22 → 10.52**, always far below the protocol's gate of 20.
  The repair round's runs are bracketed the same way by
  `receipts/repair/machine-repair-start.txt` and `machine-repair-end.txt`
  (**5.88 → 6.53**).
  The top consumers throughout are the machine owner's desktop applications
  (WindowServer, Devin, ChatGPT, Claude), not this unit.
- **No other test lane ran.** `receipts/lock-scan.txt`: the only lock file under
  any `/private/tmp/viborm-*-tmp` is the stale one of §4.1, and no
  vitest/tsc/tsdown/tinypool process was alive at scan time. Pass 1 and pass 2
  each ran as one serial driver; nothing else was started while a cell was in
  flight, with one recorded exception below.
- **One recorded self-inflicted noise event.** The census tool was run once at
  ~16:23:50Z while `pass1__flat-scalar-update__full__retained` was in flight.
  That cell **refused** and produced no timing, so no measured number is
  affected. Nothing else was run during either pass.
- **Whole-estate typecheck**: `node scripts/run-typecheck.mjs`, `EXIT=0`, 0
  diagnostics, 6.0 s wall / 5,056 MiB peak.
- **Nothing was committed, staged, reset, stashed or pushed**, and no lock file
  was removed. Exactly three things were written outside this evidence
  directory, none of them in any other agent's worktree: (a) a git-ignored
  `dist/` in each of the three trees, which `buildCheckout` and
  `pnpm package:build` produce and which every earlier stage produced too;
  (b) the new linked worktree `/private/tmp/viborm-perf-cand`, which
  `git worktree add` registers as metadata under
  `/Users/arnaud/code/viborm/.git/worktrees/` — **no file in the main working
  tree was modified**, and the main tree's untracked `baseline.json` was opened
  read-only; (c) this unit's own lock and temporary files under
  `/private/tmp/viborm-perf-tmp/run`. `git status --porcelain` is **empty** in
  both measurement arms and, in `/private/tmp/viborm-perf`, lists this directory
  and nothing else.
- **`/private/tmp/viborm-perf-cand` is left in place** as the receipt of the
  candidate arm. Removing it would write to the same Git metadata again; the
  integrator can `git worktree remove` it deliberately.

---

## 8. Unverified claims

1. **The instrument defect behind D-9's number is inferred, not re-measured.**
   §5 shows the forced collection flatters the candidate by ~14 % on **these**
   trees with **this** probe. `perf2`'s `ab-stage.mjs` forces one too, so its
   1.117 is probably optimistic — but the pass-2 scratch trees are gone and this
   unit did not reproduce it. Treat it as a reason to re-measure, not as a
   correction.
2. **`fixed-collection-rowref-1000/prepare` at 1.315 vs stage 2d's 1.250/1.257**
   is one probe against another series on another day. The direction is
   consistent but the gap is inside what this unit can separate.
3. **Why `bulk-update-returning-100/full` moved (§4.5) is not established.** The
   statement count is unchanged (1/1) and the bracket is unchanged; the cause is
   somewhere in the eight commits between identity 4 and the release tree, and
   this unit did not bisect it.
4. **Whether D-58 added a round trip anywhere outside the 20 cells is unknown.**
   What is measured is only that on the 20 cells the release tree sends the same
   number of statements per public operation as the shipped engine (§2.2).
5. **The sparse checkout of the candidate arm is an unremarked deviation from
   how the earlier stages built their worktrees.** `src`, `benchmarks`,
   `scripts` and the root build files were verified byte-identical, and nothing
   outside them enters `dist` or the worker — but no earlier series ran from a
   sparse worktree. *No longer unverified:* the review measured it —
   `pnpm package:build` in the sparse arm and in the full release worktree
   produce 181 files each with every `.mjs` byte-identical (`dist/index.mjs`
   sha256 `f2f9f9d0…` on both), only the content-hashed `.d.mts` chunk name
   differing (`review.md` §1.5). The deviation stands; the confound does not.
6. **The absolute medians of this series are not comparable with stage 2c's or
   2d's** for anything but the `full` cells, for the reason §1.1 records. The
   §3.1 table is the only cross-series comparison this note makes.
7. **The GC-sensitivity pair (§4.3 item 3) is three runs per arm.** The
   candidate's forced-`gc()` samples span 14.40–16.15, 11 % of their median.
   Three runs separate the two conditions (a 16 % gap between 1.446 and 1.680)
   but cannot bound the compression closer than a few per cent: the direction is
   solid, the "~14 %" is not a measured constant.
8. **The `bulk-update-returning-100` package-seam reading (§4.3, repair round)
   reproduces the series' pass 2, not its pass 1.** The v6 statement arm reads
   1.411 where the series read 1.556 (pass 1) and 1.432 (pass 2); the series'
   own two passes differ by 8.7 % on this cell, so the probe is inside the
   series' spread but the fidelity is looser than on the three read cells. Its
   runner also alternates the side order per pair, which `seam-run-v5.mjs` did
   not, so the bulk row is not a byte-for-byte method match with the three rows
   above it — each row is still an internally alternating baseline/candidate
   comparison at the same two brackets.

---

## 9. What this unit did NOT do, by instruction

- It did not repair anything. Every cell over budget is reported with its
  profile, as the brief requires of a measurement unit.
- It did not change production code, did not land the phase adapter, and did not
  touch `benchmarks/`. The one `benchmarks/` change it wants is written out as a
  request in §4.2 for its owner.
- It did not remove the stale lock (§4.1).

---

## 10. Repair round — the review's resolutions, applied

Trigger: [`review.md`](review.md), verdict **REVISE**. This round applies
exactly the resolutions that review states, re-runs what they affect, and
changes nothing else. It is still a measurement unit: **no production file, no
`benchmarks/` file and no test was touched**, nothing was committed, staged,
reset, stashed or pushed, and no lock file was removed.

Machine: 1-minute load **5.88 → 6.53** across the round
([`receipts/repair/machine-repair-start.txt`](receipts/repair/machine-repair-start.txt),
[`machine-repair-end.txt`](receipts/repair/machine-repair-end.txt)), no
vitest/tsc/tsdown/tinypool process alive at either scan, and the stale
`viborm-test-c33ebb4c906dfea8.lock` of §4.1 still the only lock file under any
`/private/tmp/viborm-*-tmp` — untouched, and again worked around by running
under `/private/tmp/viborm-perf-tmp/run` (B1, unchanged).

### 10.1 What each finding changed

| Finding | Resolution applied | Where |
| --- | --- | --- |
| **F1** (major) | The statement seam is stated as **not** bracketing equivalent work on these trees, with the +0.28 µs (candidate) / +3.53 µs (baseline) asymmetry from `seam-summary-v5.json`, so the `prepare` rows of §3 are a bracket artefact plus a real cost and not the D-9 comparison | §1.1 (heading and a new paragraph), head of §3 |
| **F1** | B2 rewritten as an **instrument choice**: `git apply --check` RC=0 for `g4/cutover/phase-adapter.patch` on all three trees, the adapter's `createFullOnlyHarness` route, and stage 2d's measured 0.698 / 0.702 for this cell's `full` under that adapter; the `benchmarks/` change is kept as the **alternative**, not the primary | §4.2 (rewritten), §0 item 4 |
| **F1** | §2.2's row for `flat-scalar-update/full` now reads **1 → 1** from the reviewer's public-entry counts | §2.2 table |
| **F2** (major) | `bulk-update-returning-100` **measured at both seams** and added to §4.3's second table; the "most of this is the bracket" sentence withdrawn as a statement about the four cells; `scalar-find-unique/cold-prepare` named as the one preparation cell still without a package-seam reading; what the new probe's fidelity does and does not bound recorded as unverified | §4.3, §0 item 3, §8 item 8 |
| **F3** (minor) | The candidate's three statements quoted in the order the receipt lists them; "as a literal" dropped and replaced by what the receipt does and does not distinguish (the §2.2 heading follows the corrected sentence) | §2.2 heading and narrative |
| **F4** (minor) | "the same 14 … files" → "the same two integration classes (15 files at the baseline, 14 here)" | §6.3 table |
| **F5** (minor) | The three GC samples per arm printed beside the medians; one line added to §8 bounding what three runs separate | §4.3 item 3, §8 item 7 |
| **F6** (note, no change required) | The tally now says that two of the five inconclusives passed on their repeat and are carried as blocking by the worse-of-two rule | §3 tally |

One correction outside the numbered findings, for the same reason F1 gives for
taking the reviewer's own statement count into §2.2 — a fact the review measured
should not stay open here as well: §8 item 5 was carried as unverified although
the review **measured** it
(the sparse arm's build is byte-identical to the full worktree's), so it now
points at that receipt instead of leaving the same fact open in two places.

**The one thing the review offered that was NOT done, and why.** F1's *fuller*
resolution — commit the phase adapter as an overlay on each scratch arm and
re-run eight cells over two passes — requires a commit on each arm. This unit
commits nothing (`common.md`; the brief's "never commit, stage, reset, stash or
push"), so the overlay stays an integrator decision and §4.2 now states its
exact cost and consequence instead. Nothing else in the review was left
unapplied.

### 10.2 The one new measurement (F2)

`bulk-update-returning-100/prepare`, the second-largest miss and one of the
three cells D-9 named, had no reading at D-9's bracket because
`seam-probe-v5.mjs`'s `OPERATIONS` map builds only the three reads. v5 is left
**untouched** so its receipts keep their provenance;
[`receipts/probes/seam-probe-v6.mjs`](receipts/probes/seam-probe-v6.mjs) is a
copy of it with

1. `bulk-update-returning-100` added to `OPERATIONS`, built verbatim as
   `benchmarks/operation-pipeline-batch-workloads.mjs` builds it;
2. the statement-arm **loop kind read from the catalog** instead of hardcoded
   sync — v5's own v3→v4 finding is that each arm must run the way the worker
   runs its stage kind, and this cell declares `prepare` async
   (`asyncStages: ["cold-prepare", "prepare"]`) where the three reads declare it
   sync, so for those three v6 runs exactly what v5 ran;
3. the **side order alternated per pair** in the runner (the review's §3
   methodological caveat), where v5 always ran baseline first.

Exact diff: [`receipts/repair/seam-probe-v5-to-v6.diff`](receipts/repair/seam-probe-v5-to-v6.diff).
Run: 5 fresh-process pairs per seam per side, 1,000 iterations after 200 warmup
(the counts the series ran this cell at), log
[`receipts/repair/seam-run-v6.log`](receipts/repair/seam-run-v6.log), samples
[`receipts/probes/seam-samples-v6.json`](receipts/probes/seam-samples-v6.json),
summary [`seam-summary-v6.json`](receipts/probes/seam-summary-v6.json).

| seam | baseline CPU µs/op | candidate CPU µs/op | ratio | wall ratio |
| --- | ---: | ---: | ---: | ---: |
| statement (`prepare()`) | 42.39 | 59.79 | **1.411** | 1.229 |
| package (`prepareBatch()`) | 44.55 | 59.02 | **1.325** | 1.152 |

Both sides answer **both** seams with one statement (`published` in every
sample), so the two brackets are like for like here. The bracket costs the
baseline +2.16 µs and the candidate nothing measurable (−0.77 µs, inside its
spread) — the same asymmetry as the reads, but far smaller, which is why the
package-seam ratio stays at 1.325. Stage 2d measured this cell at the package
seam at 1.310 / 1.397, so the reading is inside its own earlier range: **not a
regression since D-9, and not explained by the bracket either.** F2's worry —
"if its package-seam ratio comes back near 1.5 rather than near 1.2, B3's
profile changes materially" — resolves in between: B3's profile changes in
*attribution* (the bracket explains a fifth of this cell's excess, not most of
it) and not in *verdict* (the cell blocks at either bracket, and nothing has
regressed since D-9).

### 10.3 Re-runs

| What | Result | Receipt |
| --- | --- | --- |
| the affected measurement (F2's cell, both seams, 20 fresh processes) | EXIT=0, `measurementProtocolValid` not applicable (probe, not comparator); ratios above | [`receipts/repair/seam-run-v6.log`](receipts/repair/seam-run-v6.log) |
| whole-estate typecheck, `node scripts/run-typecheck.mjs` | **EXIT=0, 0 diagnostics**, 5.54 s wall / 5,113.8 MiB peak | [`receipts/repair/typecheck-repair.txt`](receipts/repair/typecheck-repair.txt) |
| `git apply --check` of the phase adapter on all three trees | RC=0 ×3, every tree clean afterwards | [`receipts/repair/phase-adapter-apply-check.txt`](receipts/repair/phase-adapter-apply-check.txt) |

No vitest project, file or registered mode was re-run, because none was
affected: this round changed `note.md`, added the v6 probe, its runner and their
receipts, and updated `receipts/probes/INDEX.md` (a v6 row, and one clause made
consistent with the rewritten §4.2). The 20-cell series, the
bundle measurements and the source census are unchanged and were not
re-measured: the review re-ran the three D-9 cells from scratch, the aggregator
from this unit's own cell receipts, and both size readers independently, and all
of them reproduced.

### 10.4 What the repair round did NOT change

- **No verdict moved.** The §3 table, its tally, every blocker's verdict and
  every size number are exactly as measured; what changed is where the
  preparation verdicts are said to come from (§1.1, §3) and the attribution
  inside B3 (§4.3).
- **No receipt was relabelled, replaced or deleted.** v1–v5 and all 162 files
  under `receipts/cells/` are byte-identical to what the review checked; v6 is
  additive.
- **No test was deleted, weakened or skipped**, and no production, `benchmarks/`
  or `scripts/` file was touched. `git status --porcelain` in
  `/private/tmp/viborm-perf` still lists this evidence directory and nothing
  else; both measurement arms are still clean at their commits.
