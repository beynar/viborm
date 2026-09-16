# G4 cutover measurement — revised protocol (stage 2)

Written **before** the qualification runs, as plan §7 requires ("record the
revised protocol before its qualification runs and retain earlier receipts").
It revises the frozen 20-cell protocol of [`g0.md`](../../g0.md) in exactly one
place: **where preparation is bracketed**. Counts, cells, five alternating
fresh-process pairs per side, the 5 %/10 % budgets and `E = 2 × max(MAD)` are
unchanged.

## 1. Why a phase adapter is needed

The prep stage measured (`note.md` §6.1, receipt
[`receipts/built-package-probe.mjs`](receipts/built-package-probe.mjs)) that on
the cutover build the array owner's `prepare()` and `operation.buildStatement()`
both answer `undefined`: the candidate route publishes a complete **package**
(`prepareBatch()`), never a bare statement. `createReadHarness` threw on that,
so the read cells could not run at all.

Plan §7 answers this directly:

> Use narrow test-only phase adapters where internal entry shapes differ. They
> must bracket equivalent work, including input/default preparation and
> decoding; moving work across an artificial timing boundary is not an
> improvement. If a phase cannot be isolated comparably, measure the common
> enclosing boundary and retain end-to-end evidence. No production
> compatibility layer is required.

## 2. The adapter

Patch: [`phase-adapter.patch`](phase-adapter.patch) (448 lines, five files, all
under `benchmarks/`).

| Commit | Worktree | Content |
| --- | --- | --- |
| `e67b511b2c1e9db738b23ed5f6b6f1f16cd449b0` | `/private/tmp/viborm-g4-perf-baseline` (branch `g4-perf-baseline-overlay`) | the protocol overlay, **one direct commit above** `0cc61e61f372945026b0b564fa643de67168c08e` |
| `e6f9acc71ded960ca57d5bf6ee13dad94d335335` | `/private/tmp/viborm-g4-perf-candidate` (branch `g4-perf-measurement`) | byte-identical change committed on top of the cutover |

The 24 files of `PROTOCOL_PATHS`
(`benchmarks/operation-pipeline-protocol.mjs`) are byte-identical in both
worktrees; the comparator refuses the run otherwise, and
`findProtocolOverlayImplementationPaths` refuses an overlay that touches any
path outside that list. **No `src/` file changed on either side.**

### 2.1 What it does

1. **`prepareOperationPlan` tries the package seam first.** The shipped owner
   publishes both `prepare()` (one statement) and `prepareBatch()` (the package
   containing it); the candidate publishes only `prepareBatch()`. Preferring
   `prepare()` would time one engine's single-statement seam against the other
   engine's package seam. The package seam is the **common enclosing boundary**:
   admission plus construction of the same statement(s), on both sides. The
   shipped side is therefore also measured through `prepareBatch()`.
2. **`createReadHarness` and the mutation harness bracket there too.** They
   previously called `capability.prepare()` directly. Their `prepare`,
   `cold-prepare`, `parse` and `raw-parse` stages now go through the plan the
   package published; `execute` still runs `driver._executeRaw(sql, params)` on
   the statement that plan contains, and `full` is untouched (the public entry).
3. **`prepare`/`cold-prepare` are declared asynchronous.** `prepareBatch()`
   returns a promise on both sides. The catalog already declared exactly this
   for `bulk-create-returning-100` and `bulk-update-returning-100`, which
   already prepared through `prepareOperationPlan`; the declaration is now
   uniform. A synchronous stage function is still valid under an asynchronous
   declaration (the worker awaits a plain number without harm).
4. **Every sample retains which seam answered.** A new `preparation` field on
   the worker's output carries `preparationSeam`
   (`package` | `statement` | `built-statement` | `none`), the statement count,
   the SQL and the parameters that seam published, and the package's refusal
   message when it declined. Nothing is normalized away.
5. **A side that cannot publish one isolable statement keeps only `full`.**
   When the package holds several statements, or no seam answers, the isolated
   stages are dropped and the harness measures the public entry only. That cell
   is then reported **"not measurable comparably — end-to-end evidence
   retained"**, never as passed.

### 2.2 Why this is a phase adapter and not a compatibility layer

- It lives entirely in `benchmarks/`, which ships in no package artifact.
- It is the **same bytes on both checkouts**, and the comparator enforces that
  through the protocol hash.
- It changes **no production file on either side**. The candidate is not given
  a `prepare()`; the shipped engine is not given a route. Neither engine can
  observe the adapter.
- It does not move work across a timing boundary to flatter one side: it moves
  the boundary **outward**, to the smallest boundary both owners publish. The
  bracket is therefore larger on the shipped side than the frozen protocol's
  was — the baseline medians below are correspondingly larger than G0's, and
  that is visible, not hidden.
- Decoding, execution and the `full`/`cold-full` stages stay end-to-end through
  the public entry exactly as before.

### 2.3 What the adapter does NOT solve

`flat-scalar-update` is bracketed differently on the two sides, and this is a
**real physical difference**, not an adapter defect (receipts
[`receipts-stage2/cell-probe-baseline-overlay.json`](receipts-stage2/cell-probe-baseline-overlay.json),
[`receipts-stage2/cell-probe-candidate-prefreeze.json`](receipts-stage2/cell-probe-candidate-prefreeze.json)):

| Side | Seam | Statements the seam published |
| --- | --- | --- |
| shipped | `built-statement` — the package seam **refuses** it: *"Step 'user.update' carries a postcondition that is not yet enforced in batch mode."* | 1: `UPDATE "bench_users" SET "age" = "age" + ? WHERE "bench_users"."id" = ? RETURNING …` |
| candidate | `package` | 2: a `SELECT CASE WHEN EXISTS (…) THEN 1 ELSE json_extract('x','$') END AS "__viborm_assert__"` premise probe, then `UPDATE "bench_users" SET "age" = "age" + ? WHERE "id" = ? RETURNING …` |

Its `prepare` and `execute` cells are therefore recorded as **not measurable
comparably**; its `full` cell is measured end to end and is comparable. The same
two seams were re-probed on the frozen cutover build after the re-sync and are
unchanged:
[`receipts-stage2/cell-probe-candidate-frozen.json`](receipts-stage2/cell-probe-candidate-frozen.json).

## 3. Falsifiers

### 3.1 Old-versus-old calibration under the adapter

Receipts:
[`receipts-stage2/calibrate-adapter-prepare-summary.json`](receipts-stage2/calibrate-adapter-prepare-summary.json),
raw [`receipts-stage2/calibrate-adapter-prepare.json.gz`](receipts-stage2/calibrate-adapter-prepare.json.gz)
(13,149,182 bytes decoded, SHA-256
`9c55095f80ed3e2514090c0254b10b591030c4b8a6d6f1e47fdc80a4d2f5de55`).

```sh
cd /private/tmp/viborm-g4-perf-baseline
TMPDIR=/private/tmp/viborm-g4-cutover-tmp node --max-old-space-size=512 \
  benchmarks/operation-pipeline-compare.mjs --calibrate --providers sqlite3 \
  --workloads scalar-find-unique,fixed-collection-rowref-20 --stages prepare \
  --modes cpu --iterations 5000 --warmup 1000 --output <absolute>.json
```

Exit 0; 20 fresh workers, 0.42–0.48 s each, 73.0–80.8 MiB peak sampled
process-group RSS under the unchanged 1,536 MiB ceiling; build 2.52 s /
940.6 MiB. `adoptionEligible: false`, `keepGate: null`. Both arms report
`preparationSeam: "package"` with one statement.

| Cell / metric | B | signed delta | E | 5 % budget | \|delta\|+E | resolved |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `scalar-find-unique/prepare` CPU µs/op | 13.6120 | −0.3220 | 0.8540 | 0.6806 | 1.1760 | **no** |
| `scalar-find-unique/prepare` wall µs/op | 6.9108 | −0.0881 | 0.3814 | 0.3455 | 0.4695 | **no** |
| `fixed-collection-rowref-20/prepare` CPU µs/op | 27.8796 | −0.1704 | 0.6880 | 1.3940 | 0.8584 | yes |
| `fixed-collection-rowref-20/prepare` wall µs/op | 12.7851 | −0.1117 | 0.3208 | 0.6393 | 0.4325 | yes |

**Reading this honestly.** The adapter's bracket is stable enough to resolve the
20-row relation preparation cell old-versus-old. It does **not** resolve
`scalar-find-unique/prepare` — and neither did the unadapted protocol: G0
recorded that same cell unresolved on its initial series (CPU \|delta\|+E
0.6982 against a 0.48942 budget) and again on its one permitted repeat (0.6016
against 0.49442). The cell's uncertainty-to-median ratio is comparable under
the adapter (E/B = 0.063) to G0's (E/B = 0.056). This is a **pre-existing
limitation of the smallest scalar preparation cell on this machine**, carried
into stage 2, not a defect the adapter introduced and not a candidate result.

### 3.2 Changed-SQL passes, wrong result fails

Receipt: [`receipts-stage2/falsifier-specimens.txt`](receipts-stage2/falsifier-specimens.txt),
script [`receipts-stage2/falsifier-specimens.mjs`](receipts-stage2/falsifier-specimens.mjs).
It feeds the **real measured samples** of the smoke run below back through the
shipped `verifyRewriteBenchmarkEvidence`:

```
control (as measured): ACCEPTED
changed-SQL specimen (must be accepted): ACCEPTED
wrong-result specimen (must be refused): REFUSED — ["sqlite3","scalar-find-unique"] changed outcome
wrong-final-state specimen (must be refused): REFUSED — ["sqlite3","scalar-find-unique"] changed final
VERDICT=FALSIFIERS HOLD
```

### 3.3 Plumbing smoke (never keep-eligible)

```sh
cd /private/tmp/viborm-g4-perf-baseline
TMPDIR=/private/tmp/viborm-g4-cutover-tmp node --max-old-space-size=512 \
  benchmarks/operation-pipeline-compare.mjs \
  --baseline-dir /private/tmp/viborm-g4-perf-baseline \
  --baseline-commit e67b511b2c1e9db738b23ed5f6b6f1f16cd449b0 \
  --baseline-source-commit 0cc61e61f372945026b0b564fa643de67168c08e \
  --candidate-dir /private/tmp/viborm-g4-perf-candidate \
  --candidate-commit e6f9acc71ded960ca57d5bf6ee13dad94d335335 \
  --providers sqlite3 --workloads scalar-find-unique,fixed-collection-rowref-20 \
  --stages prepare,execute,full --modes cpu --comparison semantic --smoke \
  --output <absolute>.json
```

Exit 0, 12 workers, `measurementProtocolValid: false`, `keepGate.eligible:
false`, `comparisonMode: semantic`, `replicates: 1`. Both sides reported
`preparationSeam: "package"`, one statement. **Its numbers are two-iteration
infrastructure output and are not a performance result.** Receipt:
[`receipts-stage2/smoke-prefreeze-summary.txt`](receipts-stage2/smoke-prefreeze-summary.txt).

### 3.4 Unchanged benchmark suites under the adapter

In the baseline overlay worktree, `TMPDIR=/private/tmp/viborm-g4-cutover-tmp`:

- `node scripts/run-node-safe.mjs 768 180000 benchmarks/operation-pipeline-report.test.mjs`
  — 41/41 pass, 0 fail, 0.33 s / 50.8 MiB.
- `node scripts/run-node-safe.mjs 768 600000 benchmarks/operation-pipeline-transport.test.mjs`
  — 10/10 pass (all nine frozen recipes at full/cpu 1/1 plus the codec case),
  0 fail, 3.55 s / 214.7 MiB.

## 4. Comparison mode

`--comparison semantic`. Plan §7: "check repeatable physical witnesses
**within** each engine; compare public outcomes, authoritative state and causal
contracts **between** engines". Strict mode demands byte-equal SQL between the
two engines, which this rewrite does not promise. Semantic mode keeps
within-engine witness and checksum repeatability, requires an independent
contract observation on every sample, and compares outcome, independent initial
and final state, default calls and reached causal cuts between the engines. It
also forces `keepGate.eligible: false` by construction — the legacy keep gate
is not the Raptor 3 adoption verdict. **The §7 verdict per cell is computed
from the saved medians and MADs in this unit's report, not read off
`keepGate`.**

## 5. The 20 cells and their exact commands

The frozen matrix (`g0.md`, "Frozen representative calibration, version 1"),
unchanged:

| Workload | Measured CPU stages | Cells | Iterations / warmup |
| --- | --- | ---: | --- |
| `scalar-find-unique` | cold-prepare, prepare, execute, full | 4 | 5,000 / 1,000 (default) |
| `flat-scalar-update` | prepare, execute, full | 3 | 5,000 / 1,000 (default) |
| `fixed-collection-rowref-20` | prepare, execute, full | 3 | 5,000 / 1,000 (default) |
| `nested-conditional-found` | full | 1 | 5,000 / 1,000 (default) |
| `nested-conditional-missing` | full | 1 | 5,000 / 1,000 (default) |
| `key-transition-cascade` | full | 1 | 5,000 / 1,000 (default) |
| `bulk-update-returning-100` | prepare, full | 2 | 1,000 / 200 (default) |
| `relation-series-2` | full | 1 | 5,000 / 1,000 (default) |
| `fixed-collection-rowref-1000` | prepare, execute, parse, full | 4 | 1,000 / 200 (**explicit override**) |

`defaultMeasurementIterations` row-scales `fixed-collection-rowref-1000` to
100/20, which g0.md rejected by name ("The old row-scaled default gave
large-result preparation only 100/20 … This is the reason for the predeclared
minimum useful work"). Its four cells therefore pass `--iterations 1000
--warmup 200` explicitly; every other cell takes the catalog default, which
already equals the frozen count. Supplying the override makes
`keepGate.eligible` false for those cells — already false in semantic mode.

**One complete cell (all five alternating pairs) per command**, as g0.md
resolved after a 94 MB single-report diagnostic: "This changes only command
grouping, not the 20 cells, counts, sampling unit or budgets."

Each command is run from the **baseline overlay worktree as coordinator**:

```sh
cd /private/tmp/viborm-g4-perf-baseline
TMPDIR=/private/tmp/viborm-g4-cutover-tmp node --max-old-space-size=512 \
  benchmarks/operation-pipeline-compare.mjs \
  --baseline-dir /private/tmp/viborm-g4-perf-baseline \
  --baseline-commit e67b511b2c1e9db738b23ed5f6b6f1f16cd449b0 \
  --baseline-source-commit 0cc61e61f372945026b0b564fa643de67168c08e \
  --candidate-dir /private/tmp/viborm-g4-perf-candidate \
  --candidate-commit <the re-synced cutover commit> \
  --providers sqlite3 --comparison semantic \
  --workloads <workload> --stages <stage> --modes cpu \
  [--iterations 1000 --warmup 200]   # fixed-collection-rowref-1000 only
  --output <absolute per-cell report>.json
```

The per-cell reports are aggregated into
[`performance.json`](performance.json), which carries, per cell: `B`
(baseline median), `N` (candidate median), both MADs, `E = 2 × max(MAD)`, the
budget, the signed delta, `(N − B) + E`, the preparation seam and statement
count each side used, and the verdict.

Verdicts, exactly as plan §7 and the brief define them:

- **pass** — `(N − B) + E ≤ 0.05 × B` for CPU/wall time and `≤ 0.10 × B` for
  whole-worker peak RSS, with both sides bracketed at the same seam.
- **inconclusive-repeat** — uncertainty straddles the limit on the first
  series; the full series is repeated once.
- **blocks adoption** — still unresolved after the one permitted repeat, or
  resolved and over budget.
- **not measurable comparably** — the two sides did not bracket the same work
  (different `preparationSeam`, or different prepared statement counts). The
  end-to-end `full` evidence for that workload is retained and reported.

No outlier removal. A claim of improvement additionally requires improvement
greater than `E`.

## 6. Deviations from the brief, recorded

1. **`TMPDIR=/private/tmp/viborm-g4-cutover-tmp` for every command, including
   the coordinator's.** `scripts/test-run-lock.mjs` derives its lock path from
   `tmpdir()`, so this run holds a lock **separate** from the main tree's. The
   brief's §4 anticipated sharing the integrator's serial slot; the stage-2
   prompt grants the worktree its own lock, and the prep stage set it up that
   way so the worktree never blocks the integrator's qualification modes. The
   cost is that the integrator's runs are **not** serialized against this
   series and can add machine noise to it. That risk is carried by the
   five-alternating-pair design and the MAD-based `E`, and any cell it
   destabilizes is recorded as inconclusive or blocking — never as passed.
2. **No lock file is ever removed**; a held lock is waited on and retried.
3. The adapter touches five `benchmarks/` files rather than adding a new one:
   `findProtocolOverlayImplementationPaths` refuses any path outside the frozen
   `PROTOCOL_PATHS` list, and a new file is such a path.

## 7. Addendum, recorded during the series: peak memory and mode splitting

Two facts forced a refinement of §5's command shape. Both are recorded here
before the numbers they produced are read.

### 7.1 Peak RSS needs `retained` mode in a comparison run

The frozen matrix says "Every recipe has end-to-end CPU/wall time and
whole-worker peak RSS", and g0 obtained peak RSS from its CPU workers. That
works **only under `--calibrate`**: `measureCpu`
(`benchmarks/operation-pipeline-worker.mjs:265-283`) attaches `peakRssBytes`
only when `VIBORM_BENCH_CALIBRATION_SOURCE_SHA256` is set. An ordinary
baseline-versus-candidate comparison therefore yields no peak RSS in `cpu`
mode. Every cell is consequently run in **`cpu` and `retained`** mode; the
5 % time gate reads the `cpu` samples and the 10 % peak-memory gate reads
`retained`'s `peakRssBytes`. Counts are the catalog's own for each mode.

### 7.2 The preparation cells are run one mode per command, and why

`verifyCrossStageSemantics` (`operation-pipeline-report.mjs:801-835`) requires
`checksum / iterations` to be equal across the modes of one checkout. On the
candidate that equality **fails for preparation stages**, and the reason is a
property of the candidate, not of the adapter: its prepared SQL carries a
**per-client monotonically increasing table alias** — `q0`, `q1`, … `q10`,
… — so the prepared statement text of the same `findUnique` grows by six
characters each time the alias gains a digit. Over 5,000 iterations the mean
per-iteration checksum is 160; over 500 it is 154. The shipped engine emits a
stable `t0` and a constant 148-character statement for all 600 preparations.
Receipt: [`receipts-stage2/prepared-sql-alias-drift.json`](receipts-stage2/prepared-sql-alias-drift.json).

The check is not weakened. The preparation cells are run **one mode per
command**, which is the frozen protocol's own unit of work ("one complete cell
per command"); within one mode every replicate is a fresh process, starts the
counter at zero, and agrees. The combined-mode refusal is retained as a
receipt, and the drift is reported to Arnaud as a finding in its own right —
a driver or server prepared-statement cache keys on statement text.

### 7.3 Cells where the two sides do not bracket the same work

Recorded from the pre-series probe
([`receipts-stage2/cell-probe-candidate-frozen.json`](receipts-stage2/cell-probe-candidate-frozen.json))
and confirmed by the protocol command itself:

- `flat-scalar-update/prepare` and `/execute` — the shipped side prepares one
  statement through `buildStatement()` (its package seam refuses the
  postcondition); the candidate's package holds two statements (an
  `EXISTS` premise probe plus the `UPDATE`). No single-statement bracket exists
  on the candidate, so those two stages do not exist on its harness. Verdict:
  **not measurable comparably — end-to-end evidence retained** (the `full`
  cell is measured).
- `relation-series-2/full` — the candidate fails the workload's independent
  contract observation. Not a bracketing problem: a public-outcome divergence,
  recorded in §7.4.

### 7.4 `relation-series-2` is a contract divergence, not a measurement problem

`generatedParent.updateMany({ where: { id: { in: [5000, 6000] } }, data: {
children: { create: { label: "series-child" } } } })` on a fresh fixture
(receipt [`receipts-stage2/relation-series-2-divergence.json`](receipts-stage2/relation-series-2-divergence.json)):

| | statements | `generatedChild.id` defaults evaluated | persisted child ids |
| --- | ---: | ---: | --- |
| shipped | 7 | 5 | `series_child_3` (parent 5000), `series_child_5` (parent 6000) |
| candidate | 3 | 3 | `series_child_2` (parent 5000), `series_child_3` (parent 6000) |

Both answer `{ count: 2 }`. The **persisted primary keys differ**, and so does
the number of defaults evaluated before the first causal cut. The frozen
contract asserts the shipped values, so the candidate fails it; because the
assertion throws inside the observed driver call, the engine re-wraps it and
the harness surfaces `QueryError: Query execution failed`. This is a public
outcome and authoritative-state difference between the engines — exactly what
the semantic comparison exists to catch — and under plan §7 it is a **required
contract divergence**, whose target is zero.

## 8. Stage 2b — the series against the SECOND frozen identity

Written **before** the stage-2b series runs. The first freeze was superseded
after a regression repair, so every number sections 1–7 produced against it is
retained as a receipt of that identity and is **not** a result for this one.
Sections 1–6 are unchanged and still govern; this section records only what
differs.

### 8.1 The two sides

| Side | Worktree | Branch | Commit |
| --- | --- | --- | --- |
| baseline | `/private/tmp/viborm-g4-perf-baseline` | `g4-perf-baseline-overlay` | `e67b511b2c1e9db738b23ed5f6b6f1f16cd449b0` (protocol overlay, one commit above `0cc61e61`) — **unchanged since stage 2a**, `git status --porcelain` empty |
| candidate | `/private/tmp/viborm-g4-perf-candidate` | `g4-perf-measurement` | `9086ad814173f5babfca32ad9187f4ae4eab508d` |

Candidate branch graph (the stage-2a tips `08380bac` and `981368f6` are stale
and were left reachable as `g4-perf-measurement-stage2a`; nothing was deleted):

```
0cc61e61  refactor(raptor3): unify completion and scalar update ownership   (base)
5c08e840  chore(raptor3): candidate production for measurement (pre-freeze)
be447a3b  chore(raptor3): candidate test harness for measurement (pre-freeze)
cacb2827  chore(raptor3): frozen G4 production for measurement (identity 2)
0f09f7b6  chore(raptor3): C-01 cutover for measurement (identity 2)
9086ad81  test(bench): G4 cutover preparation phase adapter   (cherry-pick of e6f9acc7)
```

The adapter is the **top** commit, so the 24 `PROTOCOL_PATHS` files are the
adapter's bytes on both sides. Verified, not assumed:
`protocolIdentity(...).sha256` =
`6716a2229286205dac80b62ed962483ff26804f5580f614730be0d1fbd33089d` in **both**
worktrees, and `diff -rq` reports the two `benchmarks/` trees identical except
the git-ignored `benchmarks/baseline.json` (not a `PROTOCOL_PATHS` member, and
nothing under `benchmarks/` or `scripts/` reads it).

### 8.2 Identity

`captureRaptor3Identity()` in the candidate worktree at `cacb2827` — that is,
**before** the cutover — reports
`production = fce8ec0cd32c839c5517a383d92f003e090e72cb8110b8ec0e08e1f7664d6904`,
byte-equal to `g4/freeze/identity.json`. Receipt:
[`receipts-stage2b/identity-identity2.json`](receipts-stage2b/identity-identity2.json).

### 8.3 One mode per command, for every cell

§7.2 already ran the preparation cells one mode per command. Stage 2b applies
that uniformly to all 20 cells: 40 commands, each one cell in one mode, five
alternating fresh-process pairs. Reasons, both recorded before the runs:

1. `verifyCrossStageSemantics` compares `checksum / iterations` across the modes
   of one checkout, and the candidate's prepared SQL carries a per-client
   monotonic table alias (§7.2) that makes that equality fail for preparation
   stages. One mode per command removes the whole class rather than treating
   some cells differently from others.
2. It keeps the sampling unit identical for every cell, so no cell's verdict
   depends on which mode it shared a process schedule with.

The 5 % time gate reads the `cpu` command's `cpuMicrosecondsPerOperation` and
`wallMicrosecondsPerOperation`; the 10 % peak-memory gate reads the `retained`
command's `peakRssBytes` (§7.1).

### 8.4 Counts

Every cell takes the catalog's own count for its mode, with one exception kept
from §5: `fixed-collection-rowref-1000`'s **`cpu`** commands pass
`--iterations 1000 --warmup 200` explicitly, because `defaultMeasurementIterations`
row-scales that workload's cpu count to 100/20, which g0.md rejected by name.
Its **`retained`** commands take the catalog's own 20 iterations: peak RSS is a
process-lifetime high-water mark, not a per-operation rate, and forcing 1,000
iterations of a 1,000-row parse would change what the arm measures rather than
lengthen a rate measurement. This is the one place where §5's "its four cells"
and §7.1's "counts are the catalog's own for each mode" disagree; the split is
recorded here rather than resolved silently.

### 8.5 Quiet machine

The series does not start until the integrator's qualification campaign has
finished (`g4/qualified/RUNS-COMPLETE` exists). The worktree keeps its own
`TMPDIR=/private/tmp/viborm-g4-cutover-tmp` (§6.1), so it never contends for the
main tree's lock.

One stale lock was removed before stage 2b's first command: the stage-2a
coordinator's own
`/private/tmp/viborm-g4-cutover-tmp/viborm-test-c33ebb4c906dfea8.lock`
(`{"pid":23632,"label":"operation-pipeline benchmark comparison"}`), whose owner
process no longer exists — `scripts/test-run-lock.mjs` classifies it "stale or
unreadable" and instructs removal after confirming no verification process
remains, which was checked. Copy kept at
[`receipts-stage2b/stale-lock-removed.json`](receipts-stage2b/stale-lock-removed.json).
No lock belonging to a live process was ever removed; a held lock is waited on
and retried.

### 8.6 Pre-series probe, on the frozen build

[`receipts-stage2b/cell-probe-candidate-identity2.json`](receipts-stage2b/cell-probe-candidate-identity2.json)
builds every one of the 20 cells against the frozen cutover build and runs each
stage once. It is **byte-identical** to the identity-1 frozen probe
(`receipts-stage2/cell-probe-candidate-frozen.json`): the freeze changed nothing
observable at the benchmark seams. It therefore carries §7.3 forward unchanged:

- `flat-scalar-update/prepare` and `/execute` — the candidate harness has no
  such stage function (its package holds two statements), the shipped side
  brackets one statement through `built-statement`. **Not measurable comparably
  — end-to-end evidence retained** (`full` is measured).
- `relation-series-2/full` — the candidate fails the workload's independent
  contract observation (§7.4, a public-outcome divergence, not a measurement
  problem).

Both are still issued as commands in stage 2b so the refusal is a first-hand
receipt of this identity rather than an inference from the probe.
