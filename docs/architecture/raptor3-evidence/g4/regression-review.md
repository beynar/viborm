# Independent review — G4-02 bounded repair "record-series progress meta on a non-series failure"

Reviewer: independent (did not author the unit). Brief:
[`g4/briefs/g2-generated-regression.md`](briefs/g2-generated-regression.md) and
[`briefs/review.md`](briefs/review.md). Author note:
[`g4/regression/note.md`](regression/note.md). Source read and run in the main
tree `/Users/arnaud/code/viborm` at `HEAD 0cc61e61` with the unit's uncommitted
diff in place.

Reviewed identity (unchanged by this review — every falsification was restored
from a scratchpad copy, never by `git checkout`):

| File | sha256 |
| --- | --- |
| `src/query-engine/raptor3/shared/operation-context.ts` | `ff8b6b47f2977ada73c9ede8131c7ee7a6630477b8622941c81627756d5cf069` |
| `tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts` | `1d7c43465114bd97671661a37121bfe00cd28e064f5ade94e9fa2d32711c5a3e` |

Receipts: [`g4/regression-review-receipts/`](regression-review-receipts/).
Probes: `tests/raptor3/g4/review/regression/uncertain-outcome-neighbours.review.test.ts`
(`958e6bd6ec05f90ee4f0e3e4d53bbaa4daf8791d7103b07cdd2d7d9f13efb53a`, 11 cells,
green, typecheck clean; run with
`node scripts/run-vitest-safe.mjs run --config docs/architecture/raptor3-evidence/g4/regression-review-receipts/vitest.review-regression.config.ts`
— the file is not in any registered project include list yet).

---

## Outcome: **REVISE**

The named rule is genuinely repaired, correctly falsified, and agrees with the
shipped engine on every neighbouring shape I could reach — including three the
unit never measured. But the repair, as it stands in the tree, **removes a cache
invalidation the shipped engine performs** (finding 1, measured, not an absence
argument), and the brief for this very unit says that internal fact "must keep
driving the route's `writeMayBeVisible`". That is a behavioural divergence
introduced by this diff, unmeasured by any registered cell, and the change that
restores it lives in another stream's file. The repair should land together with
that seam change, not before it.

The target cell is also still red (finding 2), which is a correctly-applied §8
stop rule rather than a defect — but it means the acceptance criterion
"`g2-generated` 52/52 on both profiles" is not met, and the blocker's reach is
wider than the note records.

---

## Verified (no finding)

1. **One rule, one owner.** `attachRecordSeriesProgress` is called from exactly
   one place in the candidate (`shared/operation-context.ts:369`); the new fact
   is computed once (`setStatement`, `:364`) from a field written in exactly one
   place (`setMutations`, `:1010`). No verb table, no per-driver branch, no
   second progress authority (`grep attachRecordSeriesProgress|getTrusted…` over
   `src/query-engine/raptor3`).
2. **`submit()` is untouched.** `mayHaveCommittedSegment` is still set in one
   place (`:699`) and read by the two recovery gates (`:680`, `:733`, the note's
   pre-repair `:654`/`:707` shifted by the +26 inserted lines). The repair-only
   diff ([`repair-only.diff`](regression-review-receipts/repair-only.diff))
   touches none of them.
3. **The repair is three hunks / +27 physical lines, as claimed.** Reverse-
   applying `unit02/production-closure.patch` on a copy of the tree reproduces
   the claimed base identities exactly — `operation-context.ts`
   `8b25f6fe…`, `query.ts` `5143b7b3…`
   ([`patch-reverse-apply.log`](regression-review-receipts/patch-reverse-apply.log)) —
   and the delta to the current file is the three repair hunks plus the
   pre-existing R-D3 `QueryEngineError` hunk at `:1575`, which belongs to the
   closure round and not to this repair. Patch sha256s match the note
   (`9eed4194…`, `e2534666…`).
4. **Both shipped citations are accurate.**
   `write-engine/OperationExecutor.ts:1031-1072` is the catch that sets
   `progress.mayHaveCommittedSegment` (`:1056`), calls `writeMayBeVisible?.()`
   (`:1058`) and then `throw error` — the raw error (`:1071`);
   `dispatched` is what `:1005-1010` records and `:1050` gates on.
   `attachProgress` is at `:2308` and is reached only from record-series member
   failures and the invalidation aggregates. `route/client-route.ts:109-121` is
   `publishFailedWriteOutcome` and does read both signals off the published
   progress. `driver-diagnostics.ts:35-36` is exactly
   `if (!isVibORMError(error)) return candidates.length === 1 ? 0 : undefined;`.
5. **Falsifier works.** Reverting only `&& !setStatement` (mutation applied and
   restored byte-identically from a scratchpad copy) puts `recordSeriesProgress`
   back into the real seed-2122 cell
   ([`falsification-g2-generated-cell.log`](regression-review-receipts/falsification-g2-generated-cell.log))
   and into the author's cell 1
   ([`falsification-author-cells.log`](regression-review-receipts/falsification-author-cells.log)),
   leaving cell 2 green. It also turns four of my eleven probes red
   ([`probes-falsified-final.log`](regression-review-receipts/probes-falsified-final.log)),
   so the repair is what produces the agreement I measured.
6. **Cost figures reproduce.** `operation-context.ts` after = 1,981 physical /
   71,764 bytes; the tree the repair started from = 1,954 / 70,094 → **+27 /
   +1,670**, as claimed. Core (12 files, `commands/` + `shared/`) = 10,362
   physical / 365,414 bytes; whole `src/query-engine/raptor3` (15 files) =
   11,376 / 401,026 — both exactly the note's figures.
7. **No estate violation.** No file under `src/query-engine/write-engine/**` or
   `src/drivers/**` is modified; `route/client-route.ts` (15:28),
   `tests/raptor3/post-prep/g29-result-progress.test.ts` (05:46) and
   `raptor3/AGENTS.md` (19:25) all predate the repair window.
8. **Frozen fast-path counts did not move**: `physical-envelope` 10,
   `packaged-array` 5, `prepared-operation` 5, inside `g4-unit02-author` 110/110.

---

## Findings

### 1. blocking — the repair drops the `writeMayBeVisible` cache invalidation for an uncertain root single-record write

* **Where:** `src/query-engine/raptor3/shared/operation-context.ts:364-368`
  (the narrowed arm) together with
  `src/query-engine/raptor3/route/client-route.ts:113-121`
  (`publishFailedWriteOutcome` infers both cache signals from the **published**
  progress).
* **Probe:** `tests/raptor3/g4/review/regression/uncertain-outcome-neighbours.review.test.ts`
  cell **P7**, receipts
  [`probes-final.log`](regression-review-receipts/probes-final.log) and
  [`probes-falsified-final.log`](regression-review-receipts/probes-falsified-final.log).
* **Measured** on a batch-only driver with the harness before-dispatch fault, a
  root `create` with `cache: { autoInvalidate: true }`:

  | route | cache invalidations | failure |
  | --- | --- | --- |
  | shipped | **1** | `QueryError` |
  | candidate, repaired tree | **0** | `QueryError` |
  | candidate, `&& !setStatement` reverted | **1** | `QueryError` |

  The shipped engine calls `writeMayBeVisible?.()` from inside the executor
  (`OperationExecutor.ts:1052-1058`) before rethrowing the raw error; the
  candidate route can only learn the fact from meta that this repair removed.
* **Why blocking:** the unit's own brief states the internal fact "must keep
  driving the route's `writeMayBeVisible` (`route/client-route.ts:117-121`)".
  A client with `autoInvalidate` now keeps serving pre-write cached rows after a
  write whose outcome the driver could not prove rolled back — an observable
  answer, not only meta. Nothing registered measures it: `g4-route-cache` 7/7 and
  `g4-route-transactions` 13/13 are green with the regression present. The note
  records this as a §5 request and calls the impact "unverified"; it is now
  measured, and it is a regression rather than a neutral trade.
* **Resolution:** land note §5's seam change with this repair — `OperationContext`
  notifies `writeMayBeVisible` / `committedWriteSegment` through the execution
  seam at the point it learns the fact (`submit()`), and
  `publishFailedWriteOutcome` stops inferring the uncertain case from error meta
  — or otherwise carry the internal fact to the cache seam without publishing it.
  Keep P7 (or an equivalent registered cell) as the falsifier.

### 2. blocking (carried, not introduced) — the target cell is still red, and the `statementIndex: 0` blocker reaches three more verbs than the note states

* **Where:** `src/drivers/driver-diagnostics.ts:35-36` →
  `src/drivers/driver-transaction-base.ts:854-872`, reached because the
  candidate submits a lone set-oriented statement through `_executeBatch`
  (`shared/operation-context.ts:1007-1013`).
* **Reproduction:** `node scripts/run-raptor3.mjs g2-generated` →
  **1 failed / 51 passed (52)**, the single failure being seed 2122
  `sqlite-atomic-batch`, diff `+ "statementIndex": 0` only
  ([`g2-generated.log`](regression-review-receipts/g2-generated.log)). The
  `sqlite-interactive` profile is entirely green. `recordSeriesProgress` is gone
  — the named regression is repaired.
* **New information:** probes **P4/P5/P6** show the same `statementIndex: 0`
  divergence on relation-free `createMany`, `updateMany` and `deleteMany`
  rejected before dispatch, where neither engine publishes progress. The note's
  §4 frames the blocker as the folded root `create`; it is a property of every
  one-statement batch the candidate submits, so **options 1 and 2 must be judged
  against the bulk verbs too**, and option 3 (the driver seam) is the only one
  that covers them all. Probes **P9.1-P9.3** (a relation-bearing root `create`
  faulted after 1/2/3 dispatched statements) show both engines agreeing —
  including the same `statementIndex` 1/2/3 — so the divergence is confined to
  the one-statement batch.
* **Resolution:** Arnaud's decision, as the note says; this finding only asks
  that §4 record the bulk verbs and the P4-P6 receipt so the decision is taken
  on the full surface.

### 3. must-fix (statement) — the rule as written over-claims: a set-oriented statement still reports a record series when its segment commits

* **Where:** the comment at `shared/operation-context.ts:350-356` ("a
  set-oriented statement has no series to report"), the same sentence in note §2,
  and the §10 replacement text proposed for `raptor3/AGENTS.md:406-410`.
* **Probe:** cell **P8** — the same folded root `create`, whose segment commits
  and whose result is then malformed:

  | route | published `recordSeriesProgress` |
  | --- | --- |
  | shipped | *none* |
  | candidate | `{ atomicity: "segment", phase: "result", committedSegments: 1, committedWriteMembers: 1, completedMembers: 0 }` |

  The surviving `committedSegments > 0` arm counts the very window the repair
  calls "not a member" (`submit()`'s `acknowledged()` adds it to
  `committedMembers`), and that is the registered
  `g29-result-progress` `sqlite-atomic-batch` pin, which the brief explicitly
  keeps. So the diff is right; the sentence is not.
* **Resolution:** narrow the statement to what the code enforces — *an uncertain
  outcome alone is not a record series* — and add the committed-set-window case
  (`committedWriteMembers: 1` where shipped publishes nothing) to §4's decision
  list, since options 1 and 2 both change it.

### 4. note — the differential cell cannot falsify by colour

`tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts` cell 1 is red before
and after the repair (blocker 2); only the text of its diff changes. If
`recordSeriesProgress` were re-introduced tomorrow, the registered pass/fail
signal would not move. Registering the file as-is also makes any mode containing
it permanently red. Suggest splitting it into (a) a green, falsifiable cell
asserting `recordSeriesProgress === undefined` on both engines, and (b) a
separately named red reproducer for the `statementIndex` blocker, so the freeze
carries one falsifiable pin for the repaired rule plus one clearly labelled
blocker.

### 5. note — "one fact answers it" is stated slightly stronger than the diff

The diff introduces the *complement* of the series question (`setWindow`, the
operation's own set statement), not a named "is this a record series" fact;
`failure()` still answers with three arms, all under the outer `this.usesBatch &&`
transport gate. Publication therefore remains transport-gated for every arm —
the repair removes the transport-kind decision only for the uncertain arm of a
set statement. I found no divergence caused by the remaining gate
(`g2-generated` interactive profile green, `g1-transport` 44/44,
`g2-transport` 16/16), so this is a wording note for §8 answer 1, not a defect.

### 6. note (evidence) — two of the author's unverified claims are now discharged

`g1-transport` 44/44 and `g2-transport` 16/16 are green on the repaired tree
([`g1-transport.log`](regression-review-receipts/g1-transport.log),
[`g2-transport.log`](regression-review-receipts/g2-transport.log)), which closes
note §9's first bullet for the transport worlds. Note §9's second bullet (the §5
absence argument) is superseded by finding 1: measured, and not silent-neutral
but a regression. Note §9's third bullet (option 3's blast radius) remains
unmeasured here too.

---

## Suites re-run (bounded runner, serial, after the last edit)

| Mode / file | Result | Receipt |
| --- | --- | --- |
| `g2-generated` | **1 failed / 51 passed (52)** — finding 2 | [`g2-generated.log`](regression-review-receipts/g2-generated.log) |
| `g29-result-progress` | 2 passed (2) | [`g29-result-progress.log`](regression-review-receipts/g29-result-progress.log) |
| `g3-transaction-array` | 4 passed (4) | [`g3-transaction-array.log`](regression-review-receipts/g3-transaction-array.log) |
| `g3-suppression-retry` | 2 passed (2) | [`g3-suppression-retry.log`](regression-review-receipts/g3-suppression-retry.log) |
| `g3-bulk-series` | 6 passed (6) | [`g3-bulk-series.log`](regression-review-receipts/g3-bulk-series.log) |
| `g2-contracts` | 216 passed (216) | [`g2-contracts.log`](regression-review-receipts/g2-contracts.log) |
| `g4-route-transactions` | 13 passed (13) | [`g4-route-transactions.log`](regression-review-receipts/g4-route-transactions.log) |
| `g4-unit02-author` | 110 passed (110), 17 files | [`g4-unit02-author.log`](regression-review-receipts/g4-unit02-author.log) |
| `g2-mysql-contracts` (port 65515) | 13 passed (13) | [`g2-mysql-contracts.log`](regression-review-receipts/g2-mysql-contracts.log) |
| `g2-mysql-baseline` (port 65515) | 13 passed (13) | [`g2-mysql-baseline.log`](regression-review-receipts/g2-mysql-baseline.log) |
| `g2-pg-contracts` (port 65504) | 18 passed (18) | [`g2-pg-contracts.log`](regression-review-receipts/g2-pg-contracts.log) |
| `g3-execution-review` (extra) | 6 passed (6) | [`g3-execution-review.log`](regression-review-receipts/g3-execution-review.log) |
| `g4-route-cache` (extra, finding 1) | 7 passed (7) | [`g4-route-cache.log`](regression-review-receipts/g4-route-cache.log) |
| `g1-transport` (extra, finding 6) | 44 passed (44) | [`g1-transport.log`](regression-review-receipts/g1-transport.log) |
| `g2-transport` (extra, finding 6) | 16 passed (16) | [`g2-transport.log`](regression-review-receipts/g2-transport.log) |
| author cells (unregistered) | 1 failed / 1 passed (2) — reproduces the note | [`author-cells-reproduce.log`](regression-review-receipts/author-cells-reproduce.log) |
| review probes (unregistered, 11 cells) | 11 passed (11) | [`probes-final.log`](regression-review-receipts/probes-final.log) |
| whole-estate typecheck (with probes) | only the two permitted `pattern/pack.ts` TS2345 | [`typecheck-with-probes.log`](regression-review-receipts/typecheck-with-probes.log) |

Provider ports confirmed with `docker port viborm-raptor3-g3-mysql-20260914 3306`
→ 65515 and `docker port viborm-raptor3-g3-pg-20260914 5432` → 65504, matching
the author's receipts.

**Count to register if the probes are kept:**
`tests/raptor3/g4/review/regression/uncertain-outcome-neighbours.review.test.ts`
— **11** cells, all green on the repaired tree (4 of them red when the repaired
branch is reverted). No manifest was edited by this review.
