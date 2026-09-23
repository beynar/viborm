# G4-02 bounded repair — record-series progress on a non-series failure

Brief: [`g4/briefs/g2-generated-regression.md`](../briefs/g2-generated-regression.md)
(and [`common.md`](../briefs/common.md)). Author: G4-02. Estate touched:
`src/query-engine/raptor3/shared/operation-context.ts`,
`tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts` (new); the Seam round
adds `src/query-engine/raptor3/route/client-route.ts` (writer transfer),
`src/query-engine/raptor3/AGENTS.md` and
`tests/raptor3/g4/unit02/statement-index-blocker.red.test.ts` (new). No
shipped-engine edit, no harness edit, no manifest edit, nothing committed,
staged, reset or stashed.

**Outcome in one line:** the named rule is repaired and falsified, every listed
suite is green, and the seed-2122 cell is **still red for a SECOND, independent
divergence** (`statementIndex: 0`) whose two candidate repairs both fail — §4 is
the §8 stop-rule record.

> **Superseded in part by the Seam round** (the second half of this file), which
> answers §5's requested change, narrows §2's sentence, applies §10, and splits
> §3's cells. §§1, 4 and 6-9 are this round's record and stay as written.

---

## 1. Minimization — the exact branch

`node scripts/run-vitest-safe.mjs run tests/raptor3/g2-generated.test.ts -t
"two-before-dispatch followed by healthy calls: sqlite-atomic-batch"` reproduces
the whole regression in 4.6 s
([`receipts/minimize-before-repair.log`](receipts/minimize-before-repair.log)).
Seed 2122's failing public call is a subsequent root `create` on `owner` whose
batch the harness driver rejects before dispatch
(`tests/raptor3/harness/sqlite-world.ts:84-91`). Two meta keys diverge from the
shipped engine:

```
  "meta": { "correlationId": …, "driver": "sqlite3", "model": "owner", "operation": "create",
+           "recordSeriesProgress": { atomicity:"segment", phase:"member", committedSegments:0,
+                                     committedWriteMembers:0, completedMembers:0,
+                                     mayHaveCommittedSegment:true },
+           "statementIndex": 0 }
```

The branch that produces the first one is
`shared/operation-context.ts` `failure()`'s third arm — `this.usesBatch && (…
|| this.mayHaveCommittedSegment)`. The path is exact:

1. §P.4.7's fold routes the root `create` to the set-oriented INSERT owner, so
   it reaches `setMutations`, which on a batch transport mints a synthetic
   `windowMember`, queues its one `INSERT … RETURNING` against it, and calls
   `submit(true, windowMember)` (`:1003-1013`).
2. `submit()`'s catch sets `mayHaveCommittedSegment` because the batch is
   member-bearing and the driver cannot prove rollback (`:665-673`) — that is the
   internal fact the brief says to leave alone, and it is left alone.
3. `publishingGeneratedOutput` is `true`, so the raw error is answered through
   `failure(attributedError, "member", windowMember)` (`:713-718`), whose third
   arm attaches progress **because the transport is a batch**, not because a
   series exists.

At `0cc61e61` the same request never reached that arm: without the fold, the
root `create` queued its INSERT and the terminal read into ONE batch of two
statements, `submit()` was called from `finishTerminals` with
`publishingGeneratedOutput === false` and no continuation, so the raw error was
rethrown unwrapped. The fold is what made this operation a one-statement batch
that publishes generated output.

## 2. The rule — one rule, one owner

> **A failure carries record-series progress only when it BELONGS to a record
> series.** A committed segment and a prefix phase are the series the operation
> already has; an *uncertain outcome* is not one on its own, so a set-oriented
> statement's window reports nothing while its outcome is merely unknown:
> `setMutations`' window is the single atomic unit a folded root write — or a
> relation-free bulk verb — issues on its own behalf, not a member. A window
> whose segment DID commit is a committed segment like any other and keeps
> publishing its progress, which is the G2.9 atomic-batch pin.

*Narrowed in the Seam round* (review finding 3, measured by probe P8). The
sentence first written here — "a set-oriented statement has no series to
report" — over-claimed: the diff only ever narrowed the UNCERTAIN arm, and the
surviving `committedSegments > 0` arm still counts that same window. The code
comment at `shared/operation-context.ts` and the guide paragraph (§10) now say
what the code enforces.

Shipped, cited: `write-engine/OperationExecutor.ts:1031-1072` — for a single
operation the executor sets its internal `progress.mayHaveCommittedSegment`
(only after `dispatching()` fired, `:1005-1010`), calls `writeMayBeVisible`, and
then `throw error` — the raw error. `attachProgress` (`:2308`) is reached only
from record-series member failures (`:493, :534, :557, :621, :746, :793, :902,
:1370, :1398, :1407, :1444, :1463, :1471`) and from the three
invalidation-failure aggregates (`:1023, :1038, :1060`). A root single-record
write's failure never carries `recordSeriesProgress`. The unknown-outcome fact
is internal; it is not public meta unless a record series exists.

The diff is three hunks in one file (26 added lines, 20 of them the two
explanations; one changed line):

- a stated fact, `private setWindow?: Member` — the transport window of the
  operation's own set-oriented statement;
- `setMutations` names its window there when it mints it;
- `failure()`'s third arm becomes
  `(this.mayHaveCommittedSegment && !setStatement)`, where
  `setStatement = member !== undefined && member === this.setWindow`.

`phase === "prefix"` and `committedSegments > 0` are untouched: they are the
g29 pins, and they are what keeps the g29 atomic-batch specimen
(`phase:"result", committedSegments:1, committedWriteMembers:1`) exactly as it
was. Nothing changes **when** `mayHaveCommittedSegment` is set, so the recovery
gating at `:654`/`:707` is byte-identical.

**Decisions that disappear.** "Does this failure carry record-series progress?"
stops being answered by the transport kind (E-f's own row). The E-f falsifier is
now real: a folded root `delete`/`update`/`create` that fails on a batch-only
driver carries the shipped meta, and a real series keeps its progress.

## 3. Cells and falsification

New file `tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts`
(`1d7c43465114bd97671661a37121bfe00cd28e064f5ade94e9fa2d32711c5a3e`), 2 cells,
on a `BeforeDispatchDriver` that models the `sqlite-atomic-batch` profile
(`supportsTransactions=false`, `supportsBatch=true`) with the harness's
before-dispatch fault:

| Cell | What it measures | State |
| --- | --- | --- |
| 1. differential | a root `create` rejected before dispatch answers byte-identical meta on both engines | **RED** — `recordSeriesProgress` is gone, `statementIndex: 0` remains (§4) |
| 2. control | a real series member — a relation-bearing `createMany` segment — rejected the same way keeps `{ phase:"member", committedSegments:0, committedWriteMembers:0, completedMembers:0, mayHaveCommittedSegment:true }` | **GREEN** |

*Superseded by S.3*: the file now holds four GREEN cells and the red D-7
reproducer lives in its own unregistered file. Cell 1 below is the same
measurement with `statementIndex` excluded by name.

Cell 2 was measured, not assumed: three earlier candidate shapes for the control
(a relation-bearing `create` with supplied ids, then with a generated member id,
then a nested array) never reach `failure()` at all on this transport — their
batch is submitted by `flush`/`finishTerminals` with `publishingGeneratedOutput
=== false` and no continuation, so the raw error is rethrown. The
`createMany` series is the shape whose member failure crosses
`executeMember` → `failure(error, "member", member)` with
`committedSegments === 0` and `mayHaveCommittedSegment === true`, i.e. exactly
the arm this repair narrows.

**Falsification** ([`receipts/falsification-branch-reverted.log`](receipts/falsification-branch-reverted.log)):
reverting only the branch (`&& !setStatement` → `&& true`) puts
`recordSeriesProgress` back into cell 1's divergence and leaves cell 2 green
(1 failed | 1 passed). The production file was restored from a scratchpad copy,
not by `git checkout`, and is byte-identical afterwards.

## 4. BLOCKER for Arnaud — `statementIndex: 0` (§8 stop rule, two attempts)

**The fact.** The candidate submits the folded root `create`'s single statement
through `_executeBatch`. `driver-diagnostics.ts:35-36`
(`findUniqueExecutionContextIndex`) returns index `0` for any one-statement
batch whose error carries no VibORM context, so
`driver-transaction-base.ts:854-872` normalizes the failure **with**
`statementIndex: 0`. The shipped engine never produces it here because
`runStatementAtomic` sends the same operation through `_execute`. Measured on
both engines side by side in cell 1
([`receipts/unit02-new-cells.log`](receipts/unit02-new-cells.log)):

```
shipped   meta = { driver:"sqlite3", model:"owner", operation:"create" }
candidate meta = { driver:"sqlite3", model:"owner", operation:"create", statementIndex:0 }
```

This is a **second, independent** divergence: it is a driver-seam batch
attribution, not a record-series decision, and no change inside `failure()` can
remove it without rewriting a driver-owned diagnostic key.

**Attempt 1** — the brief's named rule (§2). Removes `recordSeriesProgress`;
`statementIndex` survives. Receipts:
[`minimize-after-repair-attempt1.log`](receipts/minimize-after-repair-attempt1.log),
[`g2-generated.log`](receipts/g2-generated.log) (51/52, the same cell).

**Attempt 2** — "a set statement that is the operation's ONLY statement needs no
batch envelope", the shipped `runStatementAtomic` condition, applied in
`setMutations` (`statements.length === 1 && attempt.pending.length === 0 &&
continuations.length === 0` takes the existing non-batch `dispatch` path).
Receipt: [`attempt2-lone-statement.log`](receipts/attempt2-lone-statement.log).
It **works** — both cells of the differential file pass, `statementIndex`
disappears — and it **breaks a registered pin**:
`tests/raptor3/post-prep/g29-result-progress.test.ts` (`sqlite-atomic-batch`)
goes red, because the G2.9 specimen's malformed-result cut is reached only
through `CorruptingBatchSQLiteDriver.executeBatch`. With the statement outside
the batch the cut is not reached at all (`corrupted:false`, the create
succeeds), and the pinned `committedSegments:1 / committedWriteMembers:1`
progress the same file asserts cannot be produced. That pin is not this unit's
file, and the brief keeps it explicitly. Attempt 2 was reverted from a
scratchpad copy.

**The decision.** The seed-2122 cell cannot be made green without choosing one
of three, all outside this brief's authority:

1. **Keep the batch, change the G2.9 atomic-batch specimen** so the
   malformed-result cut is expressed on the transport the fold actually uses,
   and accept `statementIndex` as candidate-only meta (an observable
   compatibility choice against the oracle — it would leave `g2-generated`
   permanently 51/52).
2. **Take attempt 2's transport rule** (a lone set statement leaves the batch)
   and re-express the G2.9 atomic-batch specimen's cut, accepting that the
   folded root write on a batch-only transport no longer produces a segment and
   therefore no `mayHaveCommittedSegment` at all.
3. **Change the driver seam** so a one-statement batch does not attribute a
   statement index to an error that carries no context
   (`driver-diagnostics.ts:35-36`) — a shipped-engine-visible change.

Reproducer: cell 1 of `uncertain-outcome-meta.test.ts`, and
`node scripts/run-raptor3.mjs g2-generated`
(receipt directory [`receipts/g2-generated.receipt/`](receipts/g2-generated.receipt/),
failure JSON `failure-2122-sqlite-atomic-batch-key-move-two-before-dispatch-2-15.json`).

## 5. Requested change in another stream's file (G4-03, `route/client-route.ts`)

**File / location:** `src/query-engine/raptor3/route/client-route.ts:109-121`,
`publishFailedWriteOutcome`.

**Reason.** The brief states the internal unknown-outcome fact "must keep
driving the route's `writeMayBeVisible`". It does not today: the route derives
BOTH cache-invalidation signals from the **published** progress meta
(`getTrustedRecordSeriesProgress(error)` → `progress.mayHaveCommittedSegment`).
So the moment a root single-record write stops publishing that meta — which is
exactly what the shipped engine does — the route stops invalidating for it. The
shipped engine does not have this coupling: it calls `writeMayBeVisible?.()`
from inside the executor (`OperationExecutor.ts:1058`), before rethrowing the
raw error.

**Proposed change.** `OperationContext` should call the route's
`writeMayBeVisible` / `committedWriteSegment` through the execution seam at the
point it learns the fact (`submit()`, where `mayHaveCommittedSegment` is set and
where `acknowledged()` runs), and `publishFailedWriteOutcome` should stop
inferring them from error meta. That is one owner for one fact, and it is what
makes the meta free to match shipped. Not made here: `route/client-route.ts` is
G4-03's file, and the change also needs the notification to reach the context,
which is a seam change across both.

**Impact if not made:** a folded or packaged root single-record write whose
batch is rejected with an unknown outcome no longer triggers the route's
write-may-be-visible invalidation. No registered cell measures it —
`g4-route-transactions` is 13/13 with the repair — so it is a silent divergence
until the seam moves.

## 6. Suites (bounded runner, one mode per invocation, after the last edit)

| Mode | Result | Wall / peak RSS | Receipt |
| --- | --- | --- | --- |
| `g2-generated` | **1 failed / 51 passed (52)** — the §4 blocker | 8.75 s / 750.8 MiB | [`g2-generated.log`](receipts/g2-generated.log) + [`g2-generated.receipt/`](receipts/g2-generated.receipt/) |
| `g2-contracts` | 216 passed (216) | 12.20 s / 809.4 MiB | [`g2-contracts.log`](receipts/g2-contracts.log) |
| `g29-result-progress` | 2 passed (2) | 8.48 s / 483.0 MiB | [`g29-result-progress.log`](receipts/g29-result-progress.log) |
| `g3-transaction-array` | 4 passed (4) | 7.92 s / 487.8 MiB | [`g3-transaction-array.log`](receipts/g3-transaction-array.log) |
| `g3-suppression-retry` | 2 passed (2) | 7.35 s / 531.8 MiB | [`g3-suppression-retry.log`](receipts/g3-suppression-retry.log) |
| `g3-bulk-series` | 6 passed (6) | 5.05 s / 519.2 MiB | [`g3-bulk-series.log`](receipts/g3-bulk-series.log) |
| `g4-route-transactions` | 13 passed (13) | 6.67 s / 586.5 MiB | [`g4-route-transactions.log`](receipts/g4-route-transactions.log) |
| `g4-unit02-author` | 110 passed (110), 17 files | 17.85 s / 709.2 MiB | [`g4-unit02-author.log`](receipts/g4-unit02-author.log) |
| `g3-execution-review` | 6 passed (6) | 10.55 s / 523.6 MiB | [`g3-execution-review.log`](receipts/g3-execution-review.log) |
| `g2-mysql-contracts` (port 65515) | **13 passed (13)** — the exact failed-INSERT recovery holds | 20.12 s / 597.0 MiB | [`g2-mysql-contracts.log`](receipts/g2-mysql-contracts.log) |
| `g2-mysql-baseline` (port 65515) | 13 passed (13) | 16.99 s / 663.5 MiB | [`g2-mysql-baseline.log`](receipts/g2-mysql-baseline.log) |
| `g2-pg-contracts` (port 65504) | 18 passed (18) | 12.34 s / 692.2 MiB | [`g2-pg-contracts.log`](receipts/g2-pg-contracts.log) |
| the new cells (not yet registered) | 1 failed / 1 passed (2) | 16.77 s / 495.2 MiB | [`unit02-new-cells.log`](receipts/unit02-new-cells.log) |
| whole-estate typecheck | only the two permitted `pattern/pack.ts` TS2345 (`:1443`, `:2633`) | 19.31 s / 5362.8 MiB | [`typecheck.log`](receipts/typecheck.log) |

Provider ports: `docker port viborm-raptor3-g3-mysql-20260914 3306` → 65515,
`docker port viborm-raptor3-g3-pg-20260914 5432` → 65504.

**Frozen fast-path counts did not move**: `physical-envelope` 10,
`packaged-array` 5, `prepared-operation` 5, all inside `g4-unit02-author`'s
110/110.

**Count to register (manifest not edited, as instructed):**
`tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts` — **2** cells, of which
cell 1 is the §4 blocker's reproducer and is red today. It is deliberately NOT
weakened to green: weakening it would hide a measured G4 divergence at the
freeze.

## 7. Files, identities, patches, cost

| File | Identity after |
| --- | --- |
| `src/query-engine/raptor3/shared/operation-context.ts` | `ff8b6b47f2977ada73c9ede8131c7ee7a6630477b8622941c81627756d5cf069` (was `8b25f6fea73cfe2a1a50ac2558aeb01c3b2bd7563217e5266a89c22ee10451b6`) |
| `tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts` | `1d7c43465114bd97671661a37121bfe00cd28e064f5ade94e9fa2d32711c5a3e` (new) |

Every other candidate, adapter, harness and shipped file is byte-identical to
the tree this repair started from. Biome's `check --write` was run once and
reformatted the whole of `operation-context.ts` (561/184 lines of unrelated
trailing-comma and import-order churn, including an import reorder of the kind
recorded as dangerous for the validation barrel); that formatting was reverted
from the scratchpad copy and only the three repair hunks re-applied.

**Patches regenerated** (both verified to apply forward and reverse-apply, and
the production one to reproduce the round-3/closure base identities exactly —
`query.ts 5143b7b3…`, `operation-context.ts 8b25f6fe…`):

- [`../unit02/production-closure.patch`](../unit02/production-closure.patch) — seven files —
  `9eed41941648fa34e709a206f5f86823142d2f536d379f2c615a2a55fa66c320`
- [`../unit02/tests-closure.patch`](../unit02/tests-closure.patch) — nine files (eight + the new cell file) —
  `e253466610a01d56a049cf6dd2e7313229d5737a9ace7aa43d310bfe0b31bee0`

`production.patch`, `production-phase2.patch`, `tests.patch` and
`tests-phase2.patch` are untouched.

**Identity recapture** (`captureRaptor3Identity`, after the last edit,
[`receipts/identity-after.json`](receipts/identity-after.json)):
production `6cbdf5191c3483cd94799eeb6d0d173dce09405bfed8f71588c09a54c9446e21`,
harness `c59bf12eaaeb19a7f9f67186720e61196c62160380514ce897529529358eae89`
(node v24.21.0, darwin arm64, sqlite driver 12.6.0, vitest 3.1.4).

**Cost**, same census function as note §R2.7 (`countTokenLines`, JSDoc and EOF
excluded), [`receipts/cost.json`](receipts/cost.json):

| | bytes | physical | token-lines |
| --- | --- | --- | --- |
| `shared/operation-context.ts`, before | 70,094 | 1,954 | 1,781 |
| `shared/operation-context.ts`, after | 71,764 | 1,981 | 1,784 |
| **increment** | **+1,670** | **+27** | **+3** |

Candidate **core** (12 files, `commands/` + `shared/`) now measures
**365,414 bytes / 10,362 physical / 9,410 token-lines**; the whole
`src/query-engine/raptor3` tree (15 files) measures
**401,026 / 11,376 / 10,283**. The complete charged perimeter remains
UNVERIFIED for §R.6's unchanged reason; this repair adds no file to it.

## 8. §7 decision-elimination answers, against this diff

1. **What decision disappears?** "Is this failure a record-series failure?"
   stops being answered by the transport kind. One fact — the operation's own
   set-oriented statement window — answers it, in the one owner that mints it.
2. **Could a caller still express the old behavior?** No. There is no flag, no
   verb table and no per-driver branch; a set mutation's window is not a member
   by construction, and every other member still reports.
3. **Is any meaning now stated twice?** No. `mayHaveCommittedSegment` is still
   set in exactly one place and still means exactly one thing; this diff only
   decides whether it is *published*. The route's second reading of it is the
   §5 handoff, recorded rather than duplicated here.
4. **What falsifies it?** §3: reverting `&& !setStatement` restores the
   divergence in cell 1 and leaves the control green, measured.

## 9. Unverified

- That no unlisted suite depends on a set-oriented statement's uncertain
  rejection publishing progress. The listed twelve modes plus the typecheck were
  run; `g1-transport` / `g2-transport` / the G4 seed campaigns were **not**
  (campaigns are forbidden during unit work). The narrowing touches only a
  failure whose member is `setMutations`' own window, and the transport worlds'
  uncertain progress is attributed to record members (`insert`'s
  `submit(true, member)`), so no change is expected there — unverified.
- The §5 impact statement ("no registered cell measures the route's
  write-may-be-visible invalidation for a folded root write") is an absence
  argument from `g4-route-transactions` 13/13 and a grep of
  `writeMayBeVisible` consumers, not a proof.
- §4 option 3's blast radius on the shipped engine was not measured.

## 10. One stale sentence in the private guide — **APPLIED in the Seam round**

`src/query-engine/raptor3/AGENTS.md:406-410` said `failure()` "attaches
`recordSeriesProgress` only when the transport actually has one (a prefix phase,
a committed segment, or a segment that may have committed)" — the third clause
is now qualified. The replacement proposed here was *"…or a segment that
may have committed AND a record series to report it on: a set-oriented
statement's window is not a member, so its unknown outcome stays internal, which
is the shipped single-operation meta."*

**Applied** in the Seam round below, with review finding 3's narrowing added —
the committed set window still reports (probe P8) — and with the sentence that
says where the internal fact now goes instead
(`ExecutionBinding.writeOutcome`). The guide is Markdown, so it is outside
`captureRaptor3Identity`'s fingerprint (which filters `src` to
`.ts/.mts/.mjs/.js/.json`); its sha256 is recorded in S.5 with the two
production files.

---

# Seam round — the cache-invalidation fact moves to its owner

Brief: [`g4/briefs/invalidation-seam.md`](../briefs/invalidation-seam.md) (with
[`common.md`](../briefs/common.md)). Author: G4-02, with **writer transfer of
`src/query-engine/raptor3/route/client-route.ts` for this unit only**. Input:
the independent review [`g4/regression-review.md`](../regression-review.md)
findings 1 (blocking), 3 (must-fix) and the two notes. Nothing committed,
staged, reset, stashed or deleted; no shipped-engine edit; no manifest edit.

## S.1 Decision-elimination gate (written before the first production edit)

**Required behavior.** A write whose durable phase the candidate learns —
a committed segment, or a dispatched segment it cannot prove rolled back —
must reach the client's cache-invalidation rail (`committedWriteSegment` /
`writeMayBeVisible`) exactly as the shipped engine's does, and must do so
*before* the failure is published, for every operation the route runs. It must
do so **without** the route reading the fact back out of published error meta,
because the meta is now what the shipped single-operation contract says it is
(the repair recorded above), and the two are no longer the same fact.

**Current owner (two owners, which is the defect).**

| Fact | Learned in | Published by |
| --- | --- | --- |
| a write segment of this operation committed | `OperationContext.submit`'s `acknowledged()` (`shared/operation-context.ts:657-661`, the only site that increments `committedSegments`) | `route/client-route.ts:113-118`, re-deriving it from `getTrustedRecordSeriesProgress(error).committedSegments` |
| a dispatched segment cannot be proven rolled back | `OperationContext.submit`'s catch (`:696-699`, the only site that sets `mayHaveCommittedSegment`) | `route/client-route.ts:119-121`, re-deriving it from `progress.mayHaveCommittedSegment` |

Measured consequence (reviewer's probe P7): on a batch-only driver with the
harness before-dispatch fault, a root `create` under `cache.autoInvalidate`
yields shipped **1** invalidation, candidate **0**.

**Smallest proposed change.**

1. `shared/operation-context.ts` states the seam it publishes through —
   `WriteOutcomeSeam { committedSegment?, mayBeVisible? }` — carries it on
   `ExecutionBinding`, and calls it from the two sites above, which are the two
   sites the shipped executor calls the same rail from
   (`write-engine/OperationExecutor.ts:974-990` and `:1050-1058`).
2. `ExecutionBinding` gains the `standalone` member so the ROOT situation can
   be stated by name rather than by `undefined`; the route already states every
   other situation by name.
3. `route/client-route.ts` deletes `publishFailedWriteOutcome` (and the
   `getTrustedRecordSeriesProgress` / `isVibORMError` imports with it), builds
   the seam once per write operation, and keeps its success-path
   `committedWriteSegment` **only for a transport that never separated commit
   from success** — the same arm the shipped rail itself keeps
   (`extensions/query.ts:286-293`, `publishedDirectUnits === 0`).

**Decisions that disappear.**

- *Mechanism:* "which durable phase should the cache be told about?" stops
  being answered twice — once by the transport that learned it and once by a
  reader of the failure's published meta. It is answered where it is learned.
- *Consumers:* `route/client-route.ts` stops consuming `@errors`'
  `getTrustedRecordSeriesProgress` entirely; record-series progress goes back
  to being one thing only — the *public report* of a record series — with no
  second job as a cache signal. The route keeps exactly one decision (which
  situation an operation is in) and gains none.
- *Replacing invariant:* one fact, one owner, one publication site per fact;
  the route never learns a transport fact and the context never publishes a
  route policy.
- *Falsifier:* disabling the context's notification (deleting the two calls, or
  the seam's construction in the route) must turn the new author cell
  `uncertain-outcome-meta.test.ts` "3. …invalidates on both engines" red, with
  candidate 0 against shipped 1 — the reviewer's P7 measurement, as an author
  cell.

**What is NOT changed.** `mayHaveCommittedSegment` is still set in exactly one
place and still gates recovery; `committedSegments` is still incremented in
exactly one place; `failure()` is untouched by this round except for its
comment; the G2.9 `committedSegments > 0` publication stays; the D-7
`statementIndex` blocker is Arnaud's decision and is not attempted.

## S.2 What was built, exactly

Two production files, five hunks, plus the guide paragraph and the comment.

**`src/query-engine/raptor3/shared/operation-context.ts`** (+41 physical, 26 of
them explanation):

1. `export interface WriteOutcomeSeam { committedSegment?; mayBeVisible? }` —
   the named place a transport says the durable phase of its own writes, with
   the two shipped call sites cited.
2. `ExecutionBinding` gains `writeOutcome` on the borrowed-transaction member
   and a third member `{ kind: "standalone"; writeOutcome? }`. `this.driver`
   now reads the driver from the borrowed member by name instead of from the
   union (`binding?.driver`), which is what makes the third member typecheck;
   `ownership` is unchanged, because `binding?.kind ?? "standalone"` already
   mapped an absent binding to the same word.
3. `private readonly writeOutcome?: WriteOutcomeSeam`, assigned once in the
   constructor.
4. `submit()`'s `acknowledged()` — the ONLY site that increments
   `committedSegments` — awaits `writeOutcome?.committedSegment?.()`.
5. `submit()`'s catch — the ONLY site that sets `mayHaveCommittedSegment` —
   awaits `writeOutcome?.mayBeVisible?.()` immediately after setting it and
   before anything else in that catch, which is the shipped order.

Nothing else moved: `failure()` is unchanged apart from its comment, the two
recovery gates still read `mayHaveCommittedSegment` from the same field, and
the G2.9 `committedSegments > 0` publication is untouched.

**`src/query-engine/raptor3/route/client-route.ts`** (+22 physical):

6. `publishFailedWriteOutcome` is **deleted**, and with it the route's imports
   of `getTrustedRecordSeriesProgress` and `isVibORMError`. The route no longer
   imports any record-series concept.
7. `routeWriteOutcome(execution)` builds the seam once per write from the
   client's own two notifications and records whether either has fired. It
   returns `undefined` when the client supplied neither, so an unextended write
   allocates nothing.
8. `execute` passes the seam to `runCandidate`, has no `try`/`catch` at all
   any more, and publishes the operation's success as a durable fact only when
   the transport did not already publish one.
9. `runCandidate` carries `writeOutcome` on every situation it states, and the
   root situation is now stated by name (`{ kind: "standalone", writeOutcome }`)
   when there is a rail to carry, `undefined` — meaning the same thing — when
   there is not.

**`src/query-engine/raptor3/AGENTS.md`**: the `failure()` paragraph
(§10's replacement, narrowed by review finding 3, plus where the internal fact
goes), and the route paragraph's "A root operation gets no binding" → "A root
operation is `standalone`", with one sentence for `writeOutcome`.

### Why the route still publishes success

Both engines answer "the write is durable" from two different places depending
on the transport, and the shipped rail states the rule once, for itself:
`extensions/query.ts:286-293` publishes `committed` on success **only if the
child published nothing** (`publishedDirectUnits === 0`). The candidate's
`submit()` is the child, and it publishes only on a batch transport — the only
transport that separates "the segment acknowledged" from "the operation
returned". Every other transport (a direct statement, a borrowed scope, a
packaged member) leaves success as the only durable fact there is, so the route
says it. `outcome.published` is that one condition and nothing else; it is not a
second signal path, and cell 4 below is what fails if it is removed (candidate
publishes twice, 2 invalidations against shipped's 1).

## S.3 Cells

`tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts`
(`9aa470f751cc9ef1ae8ffd83b995c58dd6ef164491fa025d596e85b5316ee68c`) — **4
cells, all green** ([`receipts/seam/author-cells.log`](receipts/seam/author-cells.log)):

| Cell | What it measures | State |
| --- | --- | --- |
| 1. differential | the folded root `create` rejected before dispatch publishes NO `recordSeriesProgress` on either engine, and agrees with the shipped failure on every other field. `statementIndex` is excluded by name, with the blocker cited | **GREEN** (was RED for D-7) |
| 2. control | a real record series (a relation-bearing `createMany` segment) rejected the same way keeps `{ phase:"member", committedSegments:0, committedWriteMembers:0, completedMembers:0, mayHaveCommittedSegment:true }` | **GREEN** |
| 3. seam (the reviewer's P7, inverted to the repaired expectation) | the same uncertain root `create` under `cache: { autoInvalidate: true }` invalidates **1** on shipped and **1** on the candidate route | **GREEN** |
| 4. seam, committed half | a COMMITTED root `create` on the same batch-only transport invalidates exactly **1** on both routes | **GREEN** |

Cell 1 is now falsifiable by colour, which was review note 4's objection: it is
green, and re-introducing `recordSeriesProgress` turns it red (the original
falsification receipt `falsification-branch-reverted.log` measured exactly that
divergence against the same assertion).

**Falsifications of the seam** (both mutations applied to the working file and
restored from a scratchpad copy, never by `git checkout`; the file is
byte-identical afterwards, `46060d8c…` / `976bbf85…`):

| Mutation | Effect | Receipt |
| --- | --- | --- |
| delete `await this.writeOutcome?.mayBeVisible?.();` from `submit()`'s catch | **cell 3 red**, candidate **0** against shipped 1 — the reviewer's P7 measurement exactly | [`receipts/seam/falsification-seam-disabled.log`](receipts/seam/falsification-seam-disabled.log) |
| drop `&& !outcome?.published` from the route's success arm | **cell 4 red**, candidate **2** against shipped 1 | [`receipts/seam/falsification-double-publish-guard.log`](receipts/seam/falsification-double-publish-guard.log) |

**The blocker's reproducer moved out.**
`tests/raptor3/g4/unit02/statement-index-blocker.red.test.ts`
(`b002634f8b7f1135127320e9e979c754b6f44c5f6a7ad66c4cdbc86751948533`) is **1
cell, RED on purpose**, and its docblock says so in the first line: it is the
D-7 reproducer (§4), widened by the review's P4-P6 to every one-statement batch
the candidate submits. Its diff is exactly `+ "statementIndex": 0`
([`receipts/seam/blocker-d7-reproducer.log`](receipts/seam/blocker-d7-reproducer.log)).

**Registration (manifest NOT edited, as instructed).**

- **Register:** `tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts` —
  **4** tests, credential-free (better-sqlite3 in memory), project `raptor3`,
  mode `g4-unit02-author`.
- **Do NOT register:** `tests/raptor3/g4/unit02/statement-index-blocker.red.test.ts`.
  It must stay out of every mode until D-7 is decided.
- **One consequence for the witness author** (`scripts/credential-free-test-manifest.mjs`,
  not my file): `EXTENDED_LOCAL_TESTS` is a directory WALK minus the registered
  modes and `tests/raptor3/g4/review/`, so the unregistered blocker file is
  adopted by the `extended-local` lane and makes it red — exactly as
  `uncertain-outcome-meta.test.ts` cell 1 did before this round, so the lane's
  colour does not change. Requested change: name
  `tests/raptor3/g4/unit02/statement-index-blocker.red.test.ts` in
  `extendedLocalExclusions` (or exclude `*.red.test.ts`) when the manifest is
  next edited. Not made here.

## S.4 Suites (bounded runner, one mode per invocation, after the last edit)

| Mode | Result | Wall / peak RSS | Receipt |
| --- | --- | --- | --- |
| `g4-route-cache` | 7 passed (7) | 10.53 s / 508.2 MiB | [`receipts/seam/g4-route-cache.log`](receipts/seam/g4-route-cache.log) |
| `g4-route-transactions` | 13 passed (13) | 7.14 s / 528.1 MiB | [`receipts/seam/g4-route-transactions.log`](receipts/seam/g4-route-transactions.log) |
| `g4-route-lifecycle` | 8 passed (8) | 5.56 s / 538.2 MiB | [`receipts/seam/g4-route-lifecycle.log`](receipts/seam/g4-route-lifecycle.log) |
| `g4-lifecycle-admission` | 4 passed (4) | 6.40 s / 528.0 MiB | [`receipts/seam/g4-lifecycle-admission.log`](receipts/seam/g4-lifecycle-admission.log) |
| `g4-unit02-author` | 110 passed (110), 17 files | 10.85 s / 748.6 MiB | [`receipts/seam/g4-unit02-author.log`](receipts/seam/g4-unit02-author.log) |
| `g29-result-progress` | 2 passed (2) | 6.07 s / 528.8 MiB | [`receipts/seam/g29-result-progress.log`](receipts/seam/g29-result-progress.log) |
| `g3-transaction-array` | 4 passed (4) | 6.19 s / 536.4 MiB | [`receipts/seam/g3-transaction-array.log`](receipts/seam/g3-transaction-array.log) |
| `g2-contracts` | 216 passed (216), 16 files | 14.88 s / 759.1 MiB | [`receipts/seam/g2-contracts.log`](receipts/seam/g2-contracts.log) |
| `g2-generated` | **1 failed / 51 passed (52)** — the one red is **D-7**, seed 2122 `sqlite-atomic-batch`, diff `+ "statementIndex": 0` only | 7.56 s / 755.4 MiB | [`receipts/seam/g2-generated.log`](receipts/seam/g2-generated.log) + [`receipts/seam/g2-generated.receipt/`](receipts/seam/g2-generated.receipt/) |
| `g2-mysql-contracts` (port 65515) | 13 passed (13), 4 files | 10.66 s / 639.8 MiB | [`receipts/seam/g2-mysql-contracts.log`](receipts/seam/g2-mysql-contracts.log) |
| `g2-pg-contracts` (port 65504) | 18 passed (18), 6 files | 7.46 s / 695.3 MiB | [`receipts/seam/g2-pg-contracts.log`](receipts/seam/g2-pg-contracts.log) |
| author cells (unregistered) | 4 passed (4) | 9.71 s / 554.1 MiB | [`receipts/seam/author-cells.log`](receipts/seam/author-cells.log) |
| D-7 reproducer (unregistered, red on purpose) | 1 failed (1) | 11.41 s / 568.3 MiB | [`receipts/seam/blocker-d7-reproducer.log`](receipts/seam/blocker-d7-reproducer.log) |
| reviewer's regression probes (unregistered) | **1 failed / 10 passed (11)** — the single red is **P7**, which pinned the DEFECT (`candidate.invalidations === 0`); it now measures 1. P8 stays green, so the narrowed sentence is what the code enforces | 3.63 s / 465.7 MiB | [`receipts/seam/review-probes-regression.log`](receipts/seam/review-probes-regression.log) |
| whole-estate typecheck | only the two permitted `pattern/pack.ts` TS2345 (`:1443`, `:2633`) | 36.24 s / 6,103.1 MiB | [`receipts/seam/typecheck.log`](receipts/seam/typecheck.log) |

Provider ports confirmed this round: `docker port viborm-raptor3-g3-mysql-20260914
3306` → `127.0.0.1:65515`, `docker port viborm-raptor3-g3-pg-20260914 5432` →
`127.0.0.1:65504`.

**Frozen fast-path counts did not move**: `physical-envelope` 10,
`packaged-array` 5, `prepared-operation` 5, all inside `g4-unit02-author`'s
110/110.

**Biome**: `biome check` (no `--write`, never on a whole file) on the four
edited/added source files reports only the categories that were already there
before this round — `operation-context.ts`'s pre-existing `format` /
`organizeImports` / `noParameterProperties` (the whole-file reformat is the one
§7 records as reverted on purpose) and `noMisplacedAssertion` on the test
helpers. `client-route.ts` is clean. Verified by running the same check against
the pre-round copies in the scratchpad.

## S.5 Patches, identity, cost

**Patches regenerated** (each verified to apply forward onto its recovered base
and to reconstruct every file byte-identically):

| Patch | Files | sha256 |
| --- | --- | --- |
| [`../unit02/production-closure.patch`](../unit02/production-closure.patch) | 7 (unchanged set) | `1a62003e3545c5340ce03406a03227c3ec9c12c5c776ce8bbaa1b7463ad3cc3f` |
| [`../unit02/tests-closure.patch`](../unit02/tests-closure.patch) | **10** (was 9; + the D-7 reproducer) | `9c1b0a8c51008a9dfa55211ccbf45271a1e8bb088a4a40b54b813d84143f9c81` |
| [`../unit03/production.patch`](../unit03/production.patch) — the route's record, against `0cc61e61` | 4 | `96f956ec604e1ee2e8ad937a75de066501d1825b708e9474f2513d65d51227ae` |

The production-closure base recovered by reverse-applying the previous patch
reproduces the recorded identities exactly (`query.ts` `5143b7b3…`,
`operation-context.ts` `8b25f6fe…`), so the patch still starts where it said it
did.

**Two observations on `unit03/production.patch`, for the integrator.** It held
G4-03 round 1's record (sha `90fed107…`), superseded twice since — by
`production-followup.patch` (r5) and then by the unit02 closure round, which
carried the route's later delta in `unit02/production-closure.patch` instead of
refreshing either unit03 patch. The brief for this round names
`unit03/production.patch` as the route's record, so it now holds the CURRENT
four-file route delta against `0cc61e61`. The superseded r1 bytes are kept at
[`receipts/seam/unit03-production-r1-superseded.patch`](receipts/seam/unit03-production-r1-superseded.patch)
rather than destroyed. `unit03/production-followup.patch` is G4-03's own r5
record and was NOT rewritten by me; it is now stale for `client-route.ts` and
the integrator should decide whether to retire it.

**Identity recapture** (`captureRaptor3Identity`, after the last edit,
[`receipts/seam/identity-after.json`](receipts/seam/identity-after.json)):
production `467baa794b561f558254dae9bbfa138e12ab7116643cedb70c302a8f07597da9`
(was `6cbdf519…`), harness
`9768511ab5ce79747c4bcd5f258fff862b61226e193496491cddc2896e9c115e`
(was `c59bf12e…`; the harness fingerprint covers `tests/raptor3`, which this
round's two cell files changed), node v24.21.0, darwin arm64, sqlite driver
12.6.0, vitest 3.1.4.

| File | sha256 after |
| --- | --- |
| `src/query-engine/raptor3/shared/operation-context.ts` | `46060d8cb2838d3ce6c83d76ae0be91f37e811718c42be417a7fc9946c6736e0` |
| `src/query-engine/raptor3/route/client-route.ts` | `976bbf85f9bf8248813a56d9b101b9c5ffb03d772877b6efcbb2dd1b09527af1` |
| `src/query-engine/raptor3/AGENTS.md` | `ce991d0bfdb0ed2d993ca181be5a66b1227a3fe1ccd645a1c1533c2c2888cc4c` |
| `tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts` | `9aa470f751cc9ef1ae8ffd83b995c58dd6ef164491fa025d596e85b5316ee68c` |
| `tests/raptor3/g4/unit02/statement-index-blocker.red.test.ts` | `b002634f8b7f1135127320e9e979c754b6f44c5f6a7ad66c4cdbc86751948533` |

Every other candidate, adapter, harness and shipped file is byte-identical to
the tree this round started from.

**Cost**, same census (`countTokenLines`, JSDoc and EOF excluded),
[`receipts/seam/cost.json`](receipts/seam/cost.json):

| | bytes | physical | token-lines |
| --- | --- | --- | --- |
| `shared/operation-context.ts` | 71,764 → 73,982 | 1,981 → 2,022 | 1,784 → 1,796 |
| `route/client-route.ts` | 14,880 → 16,173 | 378 → 400 | 247 → 256 |
| **increment (this round)** | **+3,511** | **+63** | **+21** |

Candidate **core** (12 files, `commands/` + `shared/`) now measures
**367,632 bytes / 10,403 physical / 9,422 token-lines** (+2,218 / +41 / +12 —
the route is not in the core set); the whole `src/query-engine/raptor3` tree
(15 files) measures **404,537 / 11,439 / 10,304** (+3,511 / +63 / +21). The
complete charged perimeter remains UNVERIFIED for §R.6's unchanged reason; this
round adds no file to it.

## S.6 §7 decision-elimination answers, against this diff

1. **What decision disappears?** "Which durable phase should the cache be told
   about?" stops being answered twice. It was answered once by the transport
   that learned it (internally) and once by the route re-deriving it from
   published error meta; it is now answered only where it is learned, and the
   route consumes no record-series concept at all. `recordSeriesProgress` goes
   back to meaning exactly one thing.
2. **Could a caller still express the old behavior?** No. There is no flag and
   no alternative path: `getTrustedRecordSeriesProgress` is no longer imported
   by the route, `committedSegments` and `mayHaveCommittedSegment` are each
   still written in exactly one place, and that place is the only publisher.
3. **Is any meaning now stated twice?** No. The route's remaining success-arm
   publication is the complementary case, not the same one, and it is gated by
   the single condition the shipped rail itself uses for the identical purpose.
   Cell 4 fails if that gate is removed, so the non-duplication is measured
   rather than asserted.
4. **What falsifies it?** S.3's two mutations, both measured: disabling the
   context's notification makes cell 3 red at candidate 0 (the reviewer's P7
   number), and removing the route's gate makes cell 4 red at candidate 2.

## S.7 Blockers and unverified

**Blocker carried, untouched: D-7 (`statementIndex: 0`).** §4 is the record and
the decision is Arnaud's. Its reach is the full one the review established —
the folded root `create` AND every relation-free bulk verb (P4-P6), i.e. every
one-statement batch the candidate submits — so §4's three options must be judged
against the bulk verbs too, and option 3 (the driver seam) is the only one that
covers them all. It is reproduced by
`tests/raptor3/g4/unit02/statement-index-blocker.red.test.ts` and by
`node scripts/run-raptor3.mjs g2-generated` (51/52). Not attempted here, as the
brief instructs.

**No new blocker.** Nothing in this round needed a public-contract change, a
legacy fallback, or a second semantic interpretation.

**Unverified:**

- The behavior when a cache-invalidation LISTENER ITSELF THROWS has moved site
  but was not measured on either side. Before: the notification ran in the
  route's `catch`, so its failure replaced the operation's own error. Now it
  runs inside `submit()`'s catch, so its failure escapes there instead; for the
  uncertain root write measured here that is the same observable outcome (no
  continuation, no committed segment, so `run()`'s wrapper does not re-attribute
  it), but for a failure with `committedSegments > 0` the notification's error
  would now be published through `failure()` with record-series progress
  attached, where before it propagated bare. The shipped engine wraps this case
  in an `AggregateError` with progress (`OperationExecutor.ts:1059-1069`); the
  candidate does neither before nor after, and no registered cell measures it.
  Recorded, not repaired: repairing it is a new observable choice.
- That no unlisted suite depends on the route's old meta-derived publication.
  Fourteen modes plus the typecheck were run; the G4 seed campaigns were not
  (campaigns are forbidden during unit work). The seam only fires on a batch
  transport that reaches `submit()`, which on the client route means a
  standalone operation on a `supportsTransactions=false` driver, so the
  transaction, array-fallback and packaged paths are untouched by construction —
  argued from the call graph, measured only through the listed modes.
- Multi-SEGMENT publication counts on a batch transport (a write whose
  `acknowledged()` runs more than once) were not measured against shipped on
  either engine. Both now notify per acknowledged segment, which is why they are
  expected to agree, but the only measured counts are the single-segment ones in
  cells 3 and 4.

---

# D-7 round — a lone statement leaves the batch

Brief: [`g4/briefs/d7-lone-statement.md`](../briefs/d7-lone-statement.md) (with
[`common.md`](../briefs/common.md)), applying **Arnaud's D-7 decision, option A**
("A is better, G3 may not have the same knowledge as today", 22:40). Author:
G4-02, with **writer transfer, for this unit only, of the two G2.9 specimen
files** (`tests/raptor3/post-prep/g29-result-progress.test.ts` and
`g29-result-progress-pglite.test.ts`) and of `tests/raptor3/g4/unit02/**`. Input:
[`g4/regression-review.md`](../regression-review.md) findings 2 and 3, and
[`g4/regression-review-followup.md`](../regression-review-followup.md) note 2
(the listener-primacy parity item, added to this brief after the seam round's
ACCEPT). No shipped-engine edit, no manifest edit, no route edit; nothing
committed, staged, reset, stashed or deleted. Receipts:
[`receipts/d7/`](receipts/d7/).

## D.1 Decision-elimination gate (written before the first production edit)

**Required behavior.** A set-oriented statement that is the operation's ONLY
statement must reach the provider the way the shipped engine sends it — through
the plain `_execute` path, with no batch envelope — on every transport,
including a driver that has batches and no transactions. That is the shipped
`runStatementAtomic` / `canExecuteDirectly` condition
(`write-engine/OperationExecutor.ts:241-247`, `:346-357`) and it is the same
sentence this engine already states for its physical envelope ("the envelope
opens at the first statement that is not the operation's only statement",
`OperationContext.run`). The consequences Arnaud accepted: no `statementIndex`
(the driver seam never sees a one-statement batch), and no segment progress /
no `mayHaveCommittedSegment` for a folded root single-record write on a
batch-only transport — the shipped raw error.

**The condition is exact by REACHABILITY, not by spelling** (added in round 2,
the review's note 4): `lone` names none of shipped's three exclusions from
`canExecuteDirectly` (`OperationExecutor.ts:240-247`) — an `onUniqueConflict`
write, `statementHasReferences`, `stepUsesInsertIdScratch` — because each is
structurally unreachable at `setMutations` in THIS engine's plan shapes:
`onUniqueConflict: "skip"` is set only for the MySQL `recoverableUniqueError`
strategy, which takes the per-row `recoverableSkip` branch and never
`setMutations`; references and insert-id scratch exist only on statements
`insert()` has QUEUED, which makes `attempt.pending.length > 0` and `lone`
already false. The reviewer measured the one dialect-dependent case (probe D7,
a one-statement `createMany({ skipDuplicates: true })` on a batch-only driver:
both engines answer identically). A set-oriented statement that ever gained a
conflict clause on a `"sql"` dialect outside `createMany` is the shape that
would make the difference between the two spellings observable.

**Current owner (one owner, one missing case).** `OperationContext` owns the
envelope rule in `run`/`dispatch`, but `setMutations` answers the TRANSPORT
question on its own, by `usesBatch` alone (`:1058`): on a batch-only driver
every set mutation is submitted through `_executeBatch`, however many statements
it has. That is the one place the shipped condition is not applied, and it is
why `drivers/driver-diagnostics.ts:35-36` attributes `statementIndex: 0` to a
rejection the shipped engine attributes no index to.

**Smallest proposed change.**

1. `setMutations` asks the envelope rule's own question before it chooses a
   transport: a set mutation that is ONE statement, with nothing else queued on
   this attempt and no generated-output continuation, takes the existing plain
   `dispatch`/`_execute` path on every transport.
2. That plain path becomes the transport that STATES the durable phase of its
   own write, because on this route it is the only one that learns it: the
   shipped `runBorrowedStatementAtomic` (`:1558-1645`) notifies
   `writeMayBeVisible` when its statement fails and `committedWriteSegment`
   after its statement returned, and the candidate's `submit()` — the batch
   transport — already states exactly those two facts through
   `ExecutionBinding.writeOutcome`. Without this the D-7 change would silently
   delete the cache invalidation the seam round restored (review finding 1's
   regression, in the other direction).
3. One wrapper, `stateWriteOutcome`, retains the OPERATION's own failure as
   primary when the client's invalidation listener throws, at every seam call
   site — the two in `submit()` and the two in the plain path. This is the
   followup review's note 2, the shipped `retainWriteOutcomeFailure`
   composition.

**Decisions that disappear.**

- *Mechanism:* "which transport does a set-oriented mutation use?" stops being
  answered by the driver's batch capability and starts being answered by the
  one question the engine already asks about every statement — is it the
  operation's only one? A one-statement batch, and with it a whole family of
  driver-seam attribution (`statementIndex` on the root fold and on every
  relation-free `createMany`/`updateMany`/`deleteMany`), ceases to exist.
- *Consumers:* the driver seam no longer has a one-statement batch to attribute
  an index to, so `g2-generated`'s oracle needs no exception; `failure()` keeps
  the narrowing it already has and gains nothing.
- *Replacing invariant:* one rule for the physical envelope, stated in
  `OperationContext` and applied to both of its transports; one seam for the
  durable write phase, stated by whichever transport ran the write.
- *Falsifier:* put the batch envelope back for the lone statement (drop the new
  condition) — the new `lone-statement-transport.test.ts` rows go red with
  `+ statementIndex: 0`, and the G2.9 atomic-batch specimen goes back to
  publishing `committedSegments: 1` on a malformed result.

## D.2 What was built, exactly

**One production file**, `src/query-engine/raptor3/shared/operation-context.ts`,
three hunks (+105 physical, ~60 of them explanation):

1. **The rule, in the physical owner.** `setMutations` names the question the
   envelope rule already asks — `lone = statements.length === 1 &&
   this.attempt.pending.length === 0 && this.continuations.length === 0` — and a
   lone set statement takes the existing plain `dispatch`/`_execute` path on
   every transport: `if (this.usesBatch && !lone)` is the only changed
   condition. Each conjunct is a different way of NOT being the operation's only
   statement (a plan of several statements; something already queued that would
   ride the same batch; a generated-output continuation guard that must precede
   the mutation inside one atomic unit), and none of them is redundant with
   another.
2. **`dispatchSetMutations`**, the plain path extracted from the same method, now
   states the durable phase of its own write on the seam `submit()` already
   uses: `mayBeVisible` when its statement fails without proving rollback (the
   same sentence `submit()`'s catch states — a `UniqueConstraintError` is the
   one class that proves it), and `committedSegment` once its statement has
   returned, whether or not the result then decodes. Only a STANDALONE operation
   running outside any region does so (`this.ownership === "standalone" &&
   !this.ownRegionOpen`): a borrowed operation's caller owns the scope (the
   shipped `runLinearOn` notifies nothing) and this operation's own region
   answers with its rollback (the shipped `runTransactionScope` notifies by
   transaction PHASE). This mirrors `runBorrowedStatementAtomic`
   (`write-engine/OperationExecutor.ts:1558-1645`) call for call. Without it,
   applying D-7 would DELETE the invalidation the seam round restored — review
   finding 1's regression in the other direction, measured by cells 3 and 5.
3. **`stateWriteOutcome`**, one wrapper used at all four seam call sites (the
   two in `submit()`, the two above), which keeps the OPERATION's own failure
   primary and retains the listener's beside it when the client's cache listener
   throws: `AggregateError([primary, …listener], "Query execution and
   write-outcome publication both failed.", { cause: primary })`. That is the
   shipped `retainWriteOutcomeFailure` (`src/extensions/query.ts:859-871`)
   composition, restated rather than imported because `@extensions/query` imports
   `write-engine/routing` and with it every shipped operation class — the one
   import this engine may not have. This is the followup review's note 2.
   (Round 2 corrects both its reach and the identity it keeps: the batch
   transport's committed arm did not keep the operation's failure primary at
   all, and the plain path kept an untranslated internal one — §R2.1, §R2.2.)

`failure()` is untouched; `mayHaveCommittedSegment` and `committedSegments` are
still written in exactly one place each; the `setWindow` narrowing stays and now
applies only to set mutations that really are a batch.

**Guide** (`src/query-engine/raptor3/AGENTS.md`): the envelope paragraph gains
the transport sentence and the D-7 decision, and the seam sentence names the two
transports that state the durable phase plus the one wrapper.

## D.3 The G2.9 specimens, re-expressed

Both specimens cut a malformed row out of a provider response. The fold made the
statement that carries the row an `INSERT … RETURNING`; D-7 now makes that
statement leave the batch, so a cut stated over `executeBatch` is ELIMINATED —
exactly the §5.4 failure mode the files' own docblocks were written to prevent
for `^SELECT`. Both are therefore restated over **any row-bearing response on
any transport**, at the driver's `execute`, which its batch entry dispatches
every query through. The truthful answer becomes the shipped one:

| Specimen | Before | After |
| --- | --- | --- |
| `g29-result-progress.test.ts` `sqlite-interactive` | malformed-scalar refusal, `{driver, operation, scalarType}` | unchanged |
| `g29-result-progress.test.ts` `sqlite-atomic-batch` | the same sentence **plus** `recordSeriesProgress {phase:"result", committedSegments:1, committedWriteMembers:1}` | the same sentence, **no progress**, and `acknowledgedInsertBatches === 0` — the lone statement left the batch |
| `g29-result-progress-pglite.test.ts` (generated id) | the same candidate-only progress | the same sentence, no progress, `insertBatches === 0` / `insertStatements === 1` |

**Cell counts are unchanged** (`g29-result-progress` stays at **2**, its mode
gate re-verified; the PGlite twin stays at **1**), so no registration changes.
The PROGRESS half of the specimen — a set window that DID commit still publishing
`committedSegments: 1` on a malformed result — moves to the shape that still has
a record series after D-7 and is pinned as row 6 of
`tests/raptor3/g4/unit02/lone-statement-transport.test.ts` (a `createMany` whose
bind budget splits it into two statements, so its window is a real batch). The
registered split specimen `g4/unit02/malformed-result-cuts.test.ts` cell 1b is
unchanged and still green, and still pins the same progress for a split trace.

What the sqlite specimen STOPPED measuring (added in round 2, the review's
note 5): before the re-expression its `sqlite-interactive` profile asserted
`finalDatabase === []`, so the same cell also witnessed "a malformed result
ROLLS THE WRITE BACK". Both profiles are statement-atomic now and both assert
one committed row — the shipped answer for that request, measured by the
reviewer's D5, so nothing untruthful is pinned. The ROLLED-BACK form of the cut
keeps a registered home: `g4/unit02/malformed-result-cuts.test.ts` **cell 1**,
the split trace on a provider without RETURNING whose window rolls back, beside
cell 1b which is the progress half.

## D.4 Cells and falsifications

`tests/raptor3/g4/unit02/statement-index-blocker.red.test.ts` is **renamed**
`lone-statement-transport.test.ts` and is now the positive contract — **7 cells,
all green**:

| Cell | What it measures |
| --- | --- |
| 1-4 | root `create`, and relation-free `createMany` / `updateMany` / `deleteMany`, each ONE statement rejected before dispatch on a batch-only driver, answer the shipped failure **byte-identically** — no `statementIndex`, no progress. These are the four shapes of the blocker (P4-P6 plus the fold) |
| 5 | a MULTI-statement batch (a bind-budget-split `createMany`) is still a batch, still carries the driver seam's `statementIndex: 1`, and still agrees with the shipped engine field for field |
| 6 | a set window that DID commit and then answered a malformed row still publishes `{phase:"result", committedSegments:1, committedWriteMembers:1, completedMembers:0}` — the G2.9 progress pin, on the shape that kept its series |
| 7 | **the recorded divergence D-7.1** (§D.6), pinned as measured on both engines |

`uncertain-outcome-meta.test.ts` grows from 4 to **7 cells, all green**: cell 1
no longer excludes `statementIndex` (nothing is excluded any more), and cells 5,
6 and 7 are new — the committed-but-malformed invalidation, and the followup
review's S6/S7 listener-primacy pair.

**Falsifications** (each mutation applied to the working file and restored from
the scratchpad copy, never with `git checkout`; `operation-context.ts` is
`8689fe66…` before and after every one):

| Mutation | Effect | Receipt |
| --- | --- | --- |
| put the batch envelope back for the lone statement (`&& !lone` dropped) | `lone-statement-transport` rows **1-4 red** with the diff `+ statementIndex: 0`, `uncertain-outcome-meta` cell **1 red** the same way, `g29-result-progress` `sqlite-atomic-batch` **red** with `+ recordSeriesProgress`; rows 5-7 and cells 2-7 stay green | [`falsification-1-batch-envelope-restored.log`](receipts/d7/falsification-1-batch-envelope-restored.log) |
| drop the plain path's `mayBeVisible` | cell **3 red**, candidate **0** against shipped 1 (the reviewer's P7 number), and cell 6 red | [`falsification-2-plain-may-be-visible-dropped.log`](receipts/d7/falsification-2-plain-may-be-visible-dropped.log) |
| drop the plain path's `committedSegment` | cell **5 red**, candidate **0** against shipped 1 | [`falsification-3-plain-committed-segment-dropped.log`](receipts/d7/falsification-3-plain-committed-segment-dropped.log) |
| invert `stateWriteOutcome`'s primary-retention arm | cell **6 red** at `CacheConfigurationError` — the reviewer's S6 divergence exactly — and cell **7 red** the other way | [`falsification-4-primary-failure-not-retained.log`](receipts/d7/falsification-4-primary-failure-not-retained.log) |

## D.5 Suites (bounded runner, one mode per invocation, after the last edit)

| Mode | Result | Wall / peak RSS | Receipt |
| --- | --- | --- | --- |
| `g2-generated` | **52 passed (52)** — D-7 closed | 5.04 s / 767.3 MiB | [`g2-generated.log`](receipts/d7/g2-generated.log) |
| `g29-result-progress` | 2 passed (2), gate verified | 4.06 s / 512.5 MiB | [`g29-result-progress.log`](receipts/d7/g29-result-progress.log) |
| G2.9 PGlite twin (`raptor3-provider`) | 1 passed (1) | 5.34 s / 1,530.6 MiB | [`g29-pglite.log`](receipts/d7/g29-pglite.log) |
| `g4-unit02-author` | 110 passed (110), 17 files | 5.70 s / 777.5 MiB | [`g4-unit02-author.log`](receipts/d7/g4-unit02-author.log) |
| `g4-route-cache` | 7 passed (7) | 4.00 s / 527.0 MiB | [`g4-route-cache.log`](receipts/d7/g4-route-cache.log) |
| `g4-route-transactions` | 13 passed (13) | 4.03 s / 531.4 MiB | [`g4-route-transactions.log`](receipts/d7/g4-route-transactions.log) |
| `g3-transaction-array` | 4 passed (4) | 4.00 s / 527.5 MiB | [`g3-transaction-array.log`](receipts/d7/g3-transaction-array.log) |
| `g3-suppression-retry` | 2 passed (2) | 3.96 s / 533.6 MiB | [`g3-suppression-retry.log`](receipts/d7/g3-suppression-retry.log) |
| `g3-bulk-series` | 6 passed (6) | 3.92 s / 526.3 MiB | [`g3-bulk-series.log`](receipts/d7/g3-bulk-series.log) |
| `g2-contracts` | 216 passed (216) | 6.92 s / 814.5 MiB | [`g2-contracts.log`](receipts/d7/g2-contracts.log) |
| `g1-transport` | 44 passed (44) | 4.72 s / 709.0 MiB | [`g1-transport.log`](receipts/d7/g1-transport.log) |
| `g2-transport` | 16 passed (16) | 4.54 s / 712.4 MiB | [`g2-transport.log`](receipts/d7/g2-transport.log) |
| `g3-generated-transport-smoke` | **1 failed (1)** — the harness plan's transport expectation, §D.7, NOT a candidate answer | 3.96 s / 532.3 MiB | [`g3-generated-transport-smoke.log`](receipts/d7/g3-generated-transport-smoke.log) |
| `g2-mysql-contracts` (port 65515) | **13 passed (13)** — the exact failed-INSERT recovery holds | 4.90 s / 695.3 MiB | [`g2-mysql-contracts.log`](receipts/d7/g2-mysql-contracts.log) |
| `g2-mysql-baseline` (port 65515) | 13 passed (13) | 4.57 s / 654.2 MiB | [`g2-mysql-baseline.log`](receipts/d7/g2-mysql-baseline.log) |
| `g2-pg-contracts` (port 65504) | 18 passed (18) | 5.12 s / 695.4 MiB | [`g2-pg-contracts.log`](receipts/d7/g2-pg-contracts.log) |
| author cells (unregistered, 3 files) | 16 passed (16) | 7.30 s / 613.3 MiB | [`author-cells.log`](receipts/d7/author-cells.log) |
| reviewer's probes (unregistered, 19 cells) | **6 failed / 13 passed** — every red is a probe that PINNED a divergence D-7 removes: P4/P5/P6 (`statementIndex: 0` on the three bulk verbs), P8 (the folded root write's candidate-only committed-window progress), S6 (the listener replacing the query failure) — plus **P1**, which is §D.6 | 2.51 s / 507.4 MiB | [`review-probes.log`](receipts/d7/review-probes.log) |
| whole-estate typecheck | only the two permitted `pattern/pack.ts` TS2345 (`:1443`, `:2633`) | 7.03 s / 6,219.8 MiB | [`typecheck.log`](receipts/d7/typecheck.log) |

Provider ports confirmed this round: `docker port viborm-raptor3-g3-mysql-20260914
3306` → `127.0.0.1:65515`, `docker port viborm-raptor3-g3-pg-20260914 5432` →
`127.0.0.1:65504`.

Three intermediate receipts are kept as they fell and are not results:
[`typecheck-after-production.log`](receipts/d7/typecheck-after-production.log)
and [`g2-generated-first.log`](receipts/d7/g2-generated-first.log) (taken right
after the production hunks, before any specimen was re-expressed — `g2-generated`
was already 52/52 there), and
[`g29-before-reexpression.log`](receipts/d7/g29-before-reexpression.log), which
is the G2.9 sqlite specimen RED for the reason §D.3 then repairs: with the lone
statement outside the batch, `corrupted: false` — the cut was not reached at all.

**Frozen fast-path counts did not move**: `physical-envelope` 10,
`packaged-array` 5, `prepared-operation` 5 — the `g4-unit02-author` gate asserts
each registered file's exact cell count and verified. The root fold still costs
**1 statement / 0 transactions**; the count is transport-blind (the harness
world counts a batched statement and a direct statement alike), and what changed
is only which entry carries it.

**Biome** (`biome check`, never `--write`, never on a whole file) on the five
edited/added source files reports only the categories that were already there
before this round — `operation-context.ts`'s pre-existing `format` /
`organizeImports` / `noParameterProperties` / `useSimplifiedLogicExpression`, and
`noMisplacedAssertion` on test helpers (14 → 15, one more helper). The
`useTopLevelRegex` category the new drivers would have added (5) was removed
outright by hoisting every `^INSERT` matcher to module scope, so it is now 0
where it was 3 before. [`biome-check.log`](receipts/d7/biome-check.log)

## D.6 BLOCKER D-7.1 for Arnaud — root `update` / `delete` lose the index D-7 gave the others

**The fact, measured on both engines** (receipt: the reviewer's probe **P1** in
[`review-probes.log`](receipts/d7/review-probes.log), and cell 7 of
`lone-statement-transport.test.ts`, which pins it):

| root verb, rejected before dispatch on a batch-only driver | shipped meta | candidate meta (after D-7) |
| --- | --- | --- |
| `create` | `{driver, model, operation}` | the same — **repaired by D-7** |
| `update` | `{driver, model, operation, statementIndex: 0}` | `{driver, model, operation}` — **now diverges** |
| `delete` | `{driver, model, operation, statementIndex: 0}` | `{driver, model, operation}` — **now diverges** |
| `createMany` / `updateMany` / `deleteMany` (relation-free) | `{…}` no index | the same — repaired by D-7 |
| `upsert` | `{…}` no index | the same — unchanged |

**Why.** The shipped root `update`/`delete` fold is TWO statements on a batch
transport — `[presence guard, mutation … RETURNING]`
(`UpdateOperation`/`DeleteOperation` `foldGuard` / `buildRootPresenceGuard`,
which the candidate's own `packagedPresence` comment cites) — so the shipped
engine submits a batch and the driver seam attributes `statementIndex: 0` to a
rejection before dispatch. The candidate's fold is ONE statement with a
JavaScript postcondition (`OperationContext.published`), which is the
G3-accepted difference; before D-7 it wrapped that one statement in a batch and
the seam gave it the same index **by coincidence**. D-7 removes the envelope, so
the coincidence goes with it. Nothing else in the failure differs (cell 7
asserts field-for-field equality with `statementIndex` excluded).

**Why it is Arnaud's and not mine.** Removing it needs one of: a per-verb branch
in the transport rule (forbidden, and not the shipped condition); the candidate
emitting a presence-guard STATEMENT for a standalone root `update`/`delete` so
it too is a two-statement batch (a change to the frozen physical cost of those
verbs, 1 statement → 2, and outside this brief); or the driver-seam change that
was D-7 option 3. All three are observable compatibility choices.

**Reach and evidence of the boundary.** `g2-generated` is 52/52, so its oracle
does not reach this shape. The reviewer's P2, P3 and P9.1-P9.3 (a nested write, an
array member, and a relation-bearing root create faulted after 1/2/3 dispatched
statements) are green, so multi-statement parity including the index is intact.

## D.7 Requested change in another stream's file (harness — `g3/generation/transport-plans.ts`)

**File / location:** `tests/raptor3/g3/generation/transport-plans.ts`, four sites
(`:233` the C08 `:bulk` reply, `:350` the C09 `:scope` reply, `:475` the C10
`:suffix` reply, and `recurrenceSegment`'s own `via` at `:513` together with its
folded caller in `ordinaryRecurrenceReplies` at `:541-549`). The `:434` `:array`
and `:657` compound replies are genuinely multi-statement and stay `batch`.

**Reason.** Those scripted replies pin the TRANSPORT FORM of a
one-statement set mutation as `batch`. After D-7 the candidate dispatches it
through `execute`, so `g3-generated-transport-smoke` fails with
`Wrong transport form: g3-c08-8020-1:bulk — 'execute' !== 'batch'`. This is the
harness recording the old transport knowledge, not a candidate answer: no
statement, parameter, response or published value changes.

**Proposed diff**, verified to turn the mode green:
[`requested-harness-change-transport-plans.patch`](receipts/d7/requested-harness-change-transport-plans.patch).
The three literal sites become `via: "execute"`; `recurrenceSegment` gains a
`via` parameter defaulting to `"batch"` and `ordinaryRecurrenceReplies` passes
`folded ? "execute" : "batch"` — a blanket "one statement ⇒ execute" rule is
WRONG there, because a record-series member segment is one statement and stays
in its batch (measured: it turns `g3-c11-8023-0:recurrence-1` red the other way).

**Verification, and the file is untouched.** The diff was applied to the working
file only long enough to measure it, and the file was restored from a scratchpad
copy; its sha256 is `e331824c984f9cd4b8a56399e5ff5ec4dacfbcf3aa48cf5a2f0432cae63911e1`
before the probe and after the restore. With the diff in place
`g3-generated-transport-smoke` is **1 passed (1), gate verified**
([`probe-g3-generated-transport-smoke-with-requested-harness-change.log`](receipts/d7/probe-g3-generated-transport-smoke-with-requested-harness-change.log));
without it the mode is red, which is the receipt this round files as its own.

**Impact if not made:** `g3-generated-transport-smoke` stays red, and the G3
transport seed campaigns (not run during unit work) will carry the same
expectation.

## D.8 Registration, files, patches, identity, cost

**Counts to register (manifest NOT edited, as instructed).**

- `tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts` — **7** cells (was 4),
  credential-free (better-sqlite3 in memory), project `raptor3`, mode
  `g4-unit02-author`.
- `tests/raptor3/g4/unit02/lone-statement-transport.test.ts` — **7** cells. This
  is the RENAMED `statement-index-blocker.red.test.ts`; it is green and should be
  registered in `g4-unit02-author` like any other author file. The earlier
  request to name it in `extendedLocalExclusions` is **withdrawn** — with the
  blocker closed there is no red file to exclude, and no `*.red.test.ts` remains
  under `tests/raptor3/g4/unit02/`.
- `tests/raptor3/post-prep/g29-result-progress.test.ts` stays at **2** and
  `g29-result-progress-pglite.test.ts` at **1** — no change.

| File | sha256 after |
| --- | --- |
| `src/query-engine/raptor3/shared/operation-context.ts` | `8689fe663ae0fd2e0296c4002c769e4ed3d44f1829523fffecf63a250254983c` (was `46060d8c…`) |
| `src/query-engine/raptor3/AGENTS.md` | `18164d0ed1ebd07132b44608c7a79fd93c42dd4450a799bd6f7dc432b961f93b` (was `ce991d0b…`) |
| `tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts` | `ea5cc3b999e68086ff4bfabfae5cfc9e0516412dc0e3d4ee7834306e67d26f49` |
| `tests/raptor3/g4/unit02/lone-statement-transport.test.ts` | `8b849837576e612e3906ac365f964f3f5ce89a82645d41370b0357ea3df9430d` (renamed from `statement-index-blocker.red.test.ts`, `b002634f…`) |
| `tests/raptor3/post-prep/g29-result-progress.test.ts` | `8518e40652ae696cf472bc286285a07961f6983d0343cb9ef2f4f4e0ff5a63eb` (was `63abd327…`) |
| `tests/raptor3/post-prep/g29-result-progress-pglite.test.ts` | `085573539c581831fb3676ac7da8d2a1c64a511fc9041419a46b33834ede8312` (was `17806c60…`) |
| `src/query-engine/raptor3/route/client-route.ts` | `976bbf85…` — **unchanged**, no route edit this round |

Every other candidate, adapter, harness and shipped file is byte-identical to
the tree this round started from.

**Patches regenerated**, both verified to reverse-apply onto the recorded
closure base (`query.ts 5143b7b3…`, `operation-context.ts 8b25f6fe…` reproduced
exactly) and to forward-apply reconstructing **19/19 files byte-identically**:

| Patch | Files | sha256 |
| --- | --- | --- |
| [`../unit02/production-closure.patch`](../unit02/production-closure.patch) | 7 (unchanged set) | `57c69fd174d7880a1dc3d288742d69556c97427bec234687896cc84c8592e57f` |
| [`../unit02/tests-closure.patch`](../unit02/tests-closure.patch) | **12** (was 10: the blocker file's entry became `lone-statement-transport.test.ts`, and the two G2.9 specimens joined it) | `9994a5eae4d511f0ddd8e57ed101f808ca960df1c7d4207c94494a43e266d517` |

`unit03/production.patch` is untouched (no route edit), as are
`production.patch`, `production-phase2.patch`, `tests.patch` and
`tests-phase2.patch`. `src/query-engine/raptor3/AGENTS.md` is Markdown and stays
outside both patches and outside `captureRaptor3Identity`; its sha is in the
table above.

**Identity recapture** (`captureRaptor3Identity`, after the last edit,
[`identity-after.json`](receipts/d7/identity-after.json)): production
`0a0a7e9b6cc0f701aa8d2d935cc400de9a4332087371cd2de120a59191e9cdf9`
(was `467baa79…`), harness
`3f579a1a114cf28333bd9a49d3bb8ddb0c2e7a1c115efd25af64010b111d82a0`
(was `9768511a…`; this round changed four files under `tests/raptor3`), node
v24.21.0, darwin arm64, sqlite driver 12.6.0, vitest 3.1.4.

**Cost**, same census (`countTokenLines`, JSDoc and EOF excluded),
[`cost.json`](receipts/d7/cost.json):

| | bytes | physical | token-lines |
| --- | --- | --- | --- |
| `shared/operation-context.ts` | 73,982 → 79,053 | 2,022 → 2,127 | 1,796 → 1,849 |
| **increment (this round)** | **+5,071** | **+105** | **+53** |

Candidate **core** (12 files, `commands/` + `shared/`) now measures
**372,703 bytes / 10,508 physical / 9,475 token-lines**; the whole
`src/query-engine/raptor3` tree (15 files) measures
**409,608 / 11,544 / 10,357**. The pre-round figures the census reproduces
(367,632 / 10,403 / 9,422 and 404,537 / 11,439 / 10,304) are exactly the seam
round's, which cross-checks the measure. The complete charged perimeter remains
UNVERIFIED for §R.6's unchanged reason; this round adds no file to it.

## D.9 §7 decision-elimination answers, against this diff

1. **What decision disappears?** "Which transport does a set-oriented mutation
   use?" stops being answered by the driver's batch capability. It is answered by
   the question the engine already asks about every statement — is this the
   operation's only one? — so the one-statement batch, and with it the whole
   driver-seam `statementIndex` family it created (the folded root write plus
   every relation-free bulk verb), ceases to exist rather than being excused.
   A second decision disappears with it: "who tells the cache a write became
   durable?" is now answered by whichever transport ran the write, at both of
   its two sites, instead of only the batch one.
2. **Could a caller still express the old behavior?** No. There is no flag, no
   per-verb branch and no driver table; the condition is a property of the
   constructed plan, read at the one place that chooses between `_execute` and
   `_executeBatch`. Stated exactly (round 2, the review's note 4): `lone` is
   the shipped condition by REACHABILITY, not by spelling — it names none of
   shipped's three exclusions (`onUniqueConflict`, `statementHasReferences`,
   `stepUsesInsertIdScratch`), each of which is structurally unreachable at
   `setMutations` in this engine's plan shapes (§D.1), with the one
   dialect-dependent case measured by the reviewer's probe D7.
3. **Is any meaning now stated twice?** One sentence is deliberately restated:
   the AggregateError composition of `retainWriteOutcomeFailure`, because the
   module that owns it drags the shipped write engine into the candidate's
   module graph. It is one wrapper, used at all four call sites, and cells 6 and
   7 measure it against the shipped engine's own answer in both directions.
   (Round 2 bounds this: the property held on three of the four situations, not
   four — the batch transport's COMMITTED arm let the listener's failure replace
   the operation's. §R2.2 repairs it and cell 9 pins it.) The
   uncertain-outcome CLASS test (`UniqueConstraintError`) is the same expression
   `submit()` already uses, and is still the candidate's one sentence — narrower
   than shipped's, which is the followup review's finding 4, unchanged here.
4. **What falsifies it?** §D.4's four mutations, all measured: restoring the
   batch envelope reddens the four transport rows plus the G2.9 atomic-batch
   specimen with the exact `+ statementIndex: 0` / `+ recordSeriesProgress`
   diffs, and each of the three seam mutations reddens exactly one cell with the
   shipped number beside the candidate's.

## D.10 Blockers and unverified

**Blocker raised: D-7.1** (§D.6) — root `update` / `delete` now publish no
`statementIndex` where the shipped engine publishes `0`. Measured on both
engines, pinned green as a recorded divergence in cell 7, reproduced by the
reviewer's probe P1. Arnaud's decision.

**Handoff, not a blocker:** the harness transport plan (§D.7), with the exact
verified diff.

**Unverified:**

- Whether any shape other than root `update`/`delete` loses an index the shipped
  engine keeps. Measured: `create`, `createMany`, `updateMany`, `deleteMany`,
  `upsert`, a nested write, an array member and a relation-bearing create faulted
  at three depths. Not measured: every generated seed (the G3/G4 campaigns are
  forbidden during unit work), and no provider other than SQLite for this
  question — MySQL has no RETURNING, so its root folds never reach the same
  shape, and `g2-mysql-contracts`/`g2-pg-contracts` are green.
- The plain path now notifies the cache rail for a STANDALONE write on a
  transaction-capable driver too (the statement-atomic case), where before this
  round nothing did. That is the shipped `runBorrowedStatementAtomic` behavior
  and `g4-route-cache` 7/7 plus the reviewer's S2/S3 are green, but no cell
  measures the failure half of it on a transaction-capable driver specifically.
- A write inside the operation's OWN region still notifies nothing, where the
  shipped `runTransactionScope` notifies by transaction phase
  (`ready`/`committed`). That gap predates this round and this round does not
  widen it (`owned` is false whenever a region is open); it is not measured
  against shipped.
- Multi-statement `setMutations` on a batch transport is unchanged by
  construction, but only the two-statement shape (cells 5 and 6) was measured.

# D-7 round 2 — the review's three resolutions

Input: [`g4/d7-review.md`](../d7-review.md) (**REVISE**, 00:10) — finding 1
(must-fix), note 2 (fix together with it), note 3, and the statement items of
notes 4, 5 and 6. Author: G4-02, same writer transfer. Scope: exactly the
review's resolutions, in `shared/operation-context.ts`, `raptor3/AGENTS.md`,
`tests/raptor3/g4/unit02/**` and this note. The harness diff of §D.7 was applied
by the integrator before this round (`tests/raptor3/g3/generation/transport-plans.ts`
is now `5232c398…`, untouched here), so `g3-generated-transport-smoke` is green.
No shipped-engine edit, no manifest edit, no route edit; nothing committed,
staged, reset, stashed or deleted. Receipts:
[`receipts/d7-round2/`](receipts/d7-round2/).

## R2.1 The plain path publishes the PUBLIC refusal (review finding 1, must-fix)

**Required behavior.** A root write whose result is malformed must publish the
registered malformed-scalar `QueryEngineError` as its primary even when the
client's cache listener throws beside it. It is a registered refusal (G2.9), and
the round-1 code composed the listener's failure with the INTERNAL
`InvalidScalarResult` — published to the caller as `TypeError: Invalid provider
integer`, measured on both engines by the reviewer's D9.

**Change** (`dispatchSetMutations`, one expression): the decode failure is
translated where `decoded` is built —

```ts
decoded = { failure: this.failure(error, "result") };
```

— so the ONE value this arm holds is the one the caller receives: it is both
`stateWriteOutcome`'s primary and the thrown value. `run()`'s catch is the only
other translator of a decoding failure, and it stops recognising an
`InvalidScalarResult` the moment a composition wraps it, which is why the
translation has to happen before the composition and not after. On this path
`failure()` is a pure translation — `usesBatch && (phase === "prefix" ||
committedSegments > 0 || …)` is false for a lone statement, so it attaches no
progress, and D5/D6 stay green.

**Invariant.** One translation site per failure, at the point the failure is
first held; nothing downstream re-derives a public error from an internal one.

**Falsifier.** Restore `decoded = { failure: error }`: cell 8 goes red with the
candidate publishing `TypeError: "Invalid provider integer"` where the shipped
engine publishes `QueryEngineError` V9001, and cells 1-7, 9 and 10 stay green
([`falsification-1-plain-translation-dropped.log`](receipts/d7-round2/falsification-1-plain-translation-dropped.log)).

## R2.2 The batch transport HOLDS its listener failure (review note 2)

**Required behavior.** The same property on the other transport. `submit()`
acknowledges its committed segment BEFORE anything is decoded, so the listener
fails first and round 1 let it replace the operation's own answer: the reviewer's
D12 measured the candidate publishing `CacheConfigurationError` **alone** where
the shipped engine publishes the composition.

**Change**, the shipped `runAtomicBatch` order
(`write-engine/OperationExecutor.ts:1277-1289`, `:1306-1309`, `:1332-1343`):

1. `acknowledged()` **captures** the listener's failure into
   `heldOutcomeFailure` instead of throwing it — shipped's `committed()` closure
   captures `outcomeFailure` in exactly the same place.
2. `settleSubmitted(answer)` releases the hold where every caller of `submit()`
   decodes what it returned: a decode failure stays primary with the listener's
   retained beside it, and a listener that failed beside an answer that SUCCEEDED
   is published alone (shipped `:1336-1343`). All four submit-decode sites —
   `flush`, the terminal decode, `setMutations`' batch arm and the record route's
   `insert` — go through it, so the hold is released exactly once per submission
   and can never leak into a later decode.
3. `submit()`'s own catch releases the hold FIRST, composing with the batch's own
   failure as primary and skipping the uncertain-outcome arm below it — shipped's
   `if (hasOutcomeFailure) throw retainWriteOutcomeFailure(error, outcomeFailure)`
   at the head of its catch. (Reachable only on an ordered-commit driver, where
   `acknowledged` runs inside the driver's callback; not reachable in the
   credential-free estate, so unverified by colour.)
4. The composition itself is now ONE expression, `retainOutcomeFailure`, used by
   `stateWriteOutcome` (primary already in hand) and by `settleSubmitted`
   (primary learned after the listener). The engine states the shipped
   `retainWriteOutcomeFailure` composition once, as before, at one more site.
5. `premiseFailures` is renamed `answeredFailures` and generalised by one clause:
   a failure this operation has ALREADY ANSWERED with is returned unchanged by
   `failure()`. Without it the repair is invisible — `run()`'s catch would call
   `failure(composition, "member")` on the AggregateError, and
   `attachRecordSeriesProgress` wraps a non-`VibORMError` in a fresh
   `QueryEngineError("Record-series execution failed at a committed-segment
   boundary.")`, destroying the composition (measured: the intermediate probe run
   [`probe-review-after-production.log`](receipts/d7-round2/probe-review-after-production.log)
   shows exactly that wrapper). The two members are the premise failure
   (unchanged meaning) and the write-outcome answers released by
   `settleSubmitted` / `submit`'s catch, which the shipped `runAtomicBatch`
   likewise throws exactly as built. The progress-bearing aggregate of shipped's
   PROGRESSIVE path (`:1037-1046`) is a different failure, is not marked, and
   still reaches `failure()` as before.

**Invariant.** The operation's own failure is primary whenever a write-outcome
listener throws — now on four of four situations, where round 1 held on three.

**Falsifier.** Restore `await this.stateWriteOutcome(this.writeOutcome?.committedSegment)`
in `acknowledged()`: cell 9 goes red with the candidate publishing
`CacheConfigurationError` alone, cells 1-8 and 10 stay green
([`falsification-2-acknowledged-hold-dropped.log`](receipts/d7-round2/falsification-2-acknowledged-hold-dropped.log)).

**What D12 measures now** (the reviewer's probe is still RED by one field, and
this is the whole of it):

| route | published failure |
| --- | --- |
| shipped | `AggregateError([QueryEngineError V9001 {driver, operation, scalarType}, CacheConfigurationError])`, `cause` = the V9001 |
| candidate, round 1 | `CacheConfigurationError` **alone** |
| candidate, now | the same `AggregateError`, same message, same `errors` order, same `cause` — with `recordSeriesProgress {phase:"result", committedSegments:1, committedWriteMembers:1, completedMembers:0}` on the V9001 |

That last field is the accepted divergence of `g4/regression-review.md`
**finding 3** (probe P8): a committed set window publishes its progress on this
engine where the shipped engine publishes none, which §D.3 and the brief keep
deliberately and which `lone-statement-transport.test.ts` row 6 and the
registered `malformed-result-cuts.test.ts` cell 1b pin as measured. Author cell 9
therefore compares the two shapes with `recordSeriesProgress` excluded — and
ONLY it — and then asserts the excluded value itself, so the exclusion cannot
hide a change. The reviewer's D12, which excludes nothing, stays red on that one
field and on nothing else.

## R2.3 The `owned` gate is falsifiable by colour (review note 3)

The reviewer's **D11** is adopted as author cell 10: two statements on a
transaction-capable driver open the operation's own region, the malformed result
rolls it back, and both engines publish **zero** invalidations and no rows.

**Falsifier.** Replace `const owned = this.ownership === "standalone" &&
!this.ownRegionOpen` with `const owned = true`: cell 10 goes red with the
candidate at 1 invalidation against the shipped engine's 0 — the reviewer's
measurement exactly — and cells 1-9 stay green
([`falsification-3-owned-gate-dropped.log`](receipts/d7-round2/falsification-3-owned-gate-dropped.log)).

## R2.4 The statement items (review notes 4, 5, 6)

- **Note 4** — §D.1 gains the paragraph "The condition is exact by REACHABILITY,
  not by spelling", naming shipped's three exclusions
  (`onUniqueConflict`, `statementHasReferences`, `stepUsesInsertIdScratch`), why
  each is structurally unreachable at `setMutations`, the reviewer's D7 as the
  measurement of the one dialect-dependent case, and the shape that would make
  the two spellings differ. §D.9 answer 2 carries the same sentence in short.
- **Note 5** — §D.3 gains the paragraph naming what the sqlite specimen STOPPED
  measuring and where the rolled-back form of the cut still lives:
  `g4/unit02/malformed-result-cuts.test.ts` **cell 1** (verified: it asserts the
  write rolled back, `SELECT id … === []`), beside cell 1b, the progress half.
- **Note 6** — `raptor3/AGENTS.md` no longer calls the committed-window progress
  "the G2.9 atomic-batch pin"; it names the current witnesses
  (`malformed-result-cuts.test.ts` cell 1b and `lone-statement-transport.test.ts`
  row 6) and says the G2.9 atomic-batch specimen now publishes none. The
  102-character line is rewrapped, and the same paragraph now states the seam
  accurately: one composition, `stateWriteOutcome` where the primary is in hand
  and `settleSubmitted` where the batch held the listener's failure. The only
  line over 84 characters left in the file is the pre-existing 133-character one
  at `:687`, which is not this unit's.
- **§D.2 and §D.9** carry a pointer to this round where round 1 over-claimed.

## R2.5 Cells

`uncertain-outcome-meta.test.ts` grows from 7 to **10 cells, all green**: cells 8
(D9), 9 (D12) and 10 (D11) are new, and cells 1-7 are unchanged.
`lone-statement-transport.test.ts` is unchanged at **7 cells**. No other test
file is touched this round.

| Cell | What it measures |
| --- | --- |
| 8 | a malformed result AND a throwing listener on the plain path: the failure is byte-identical to the shipped composition, the committed rows and the invalidation count agree |
| 9 | the same pair on the BATCH transport (a bind-budget-split `createMany`): same composition, `batches === 1`, with `recordSeriesProgress` excluded and then pinned as the accepted divergence |
| 10 | a split write inside the operation's OWN region: 0 invalidations on both engines, no rows on either |

Each falsification was applied to the working file and restored from the
scratchpad copy, never with `git checkout`; `operation-context.ts` is
`aec115a3a817572c6edd0dab9d6400ed953eee28d44298bd73f73ad513fee1b1` before and
after every one of the three.

## R2.6 Suites (bounded runner, one mode per invocation, after the last edit)

| Mode | Result | Wall / peak RSS | Receipt |
| --- | --- | --- | --- |
| `g2-generated` | **52 passed (52)** | 5.00 s / 792.0 MiB | [`g2-generated.log`](receipts/d7-round2/g2-generated.log) |
| `g29-result-progress` | 2 passed (2), gate verified | 4.41 s / 528.3 MiB | [`g29-result-progress.log`](receipts/d7-round2/g29-result-progress.log) |
| G2.9 PGlite twin (`raptor3-provider`) | 1 passed (1) | 4.61 s / 1,481.6 MiB | [`g29-pglite.log`](receipts/d7-round2/g29-pglite.log) |
| `g4-unit02-author` | 110 passed (110), 17 files, gate verified | 6.13 s / 773.8 MiB | [`g4-unit02-author.log`](receipts/d7-round2/g4-unit02-author.log) |
| `g4-route-cache` | 7 passed (7) | 4.45 s / 540.5 MiB | [`g4-route-cache.log`](receipts/d7-round2/g4-route-cache.log) |
| `g4-route-transactions` | 13 passed (13) | 4.39 s / 574.3 MiB | [`g4-route-transactions.log`](receipts/d7-round2/g4-route-transactions.log) |
| `g3-transaction-array` | 4 passed (4) | 4.35 s / 525.2 MiB | [`g3-transaction-array.log`](receipts/d7-round2/g3-transaction-array.log) |
| `g3-suppression-retry` | 2 passed (2) | 4.36 s / 535.9 MiB | [`g3-suppression-retry.log`](receipts/d7-round2/g3-suppression-retry.log) |
| `g3-bulk-series` | 6 passed (6) | 4.21 s / 531.3 MiB | [`g3-bulk-series.log`](receipts/d7-round2/g3-bulk-series.log) |
| `g2-contracts` | 216 passed (216) | 7.44 s / 834.6 MiB | [`g2-contracts.log`](receipts/d7-round2/g2-contracts.log) |
| `g1-transport` | 44 passed (44) | 4.75 s / 698.1 MiB | [`g1-transport.log`](receipts/d7-round2/g1-transport.log) |
| `g2-transport` | 16 passed (16) | 4.56 s / 712.2 MiB | [`g2-transport.log`](receipts/d7-round2/g2-transport.log) |
| `g3-generated-transport-smoke` | **1 passed (1)**, gate verified — green with the integrator's harness diff | 4.76 s / 549.6 MiB | [`g3-generated-transport-smoke.log`](receipts/d7-round2/g3-generated-transport-smoke.log) |
| `g2-mysql-contracts` (port 65515) | **13 passed (13)** — the exact failed-INSERT recovery (RF-12) holds | 5.06 s / 681.7 MiB | [`g2-mysql-contracts.log`](receipts/d7-round2/g2-mysql-contracts.log) |
| `g2-mysql-baseline` (port 65515) | 13 passed (13) | 4.74 s / 650.2 MiB | [`g2-mysql-baseline.log`](receipts/d7-round2/g2-mysql-baseline.log) |
| `g2-pg-contracts` (port 65504) | 18 passed (18) | 5.48 s / 713.0 MiB | [`g2-pg-contracts.log`](receipts/d7-round2/g2-pg-contracts.log) |
| author cells (2 unregistered files) | 17 passed (17) | 4.61 s / 587.6 MiB | [`author-cells.log`](receipts/d7-round2/author-cells.log) |
| reviewer's probes (31 cells, unregistered) | **30 passed / 1 failed** — D9 repaired; D12 red on `recordSeriesProgress` only (§R2.2) | 2.59 s / 509.7 MiB | [`review-probes.log`](receipts/d7-round2/review-probes.log) |
| whole-estate typecheck | only the two permitted `pattern/pack.ts` TS2345 (`:1443`, `:2633`) | 9.40 s / 5,716.5 MiB | [`typecheck.log`](receipts/d7-round2/typecheck.log) |

Provider ports confirmed this round: `docker port viborm-raptor3-g3-mysql-20260914
3306` → `127.0.0.1:65515`, `docker port viborm-raptor3-g3-pg-20260914 5432` →
`127.0.0.1:65504`.

One intermediate receipt is kept as it fell and is not a result:
[`probe-review-after-production.log`](receipts/d7-round2/probe-review-after-production.log),
the probe run taken after R2.1 and the hold but BEFORE `answeredFailures`, which
is the measurement that `run()`'s catch was destroying the composition.

**Frozen fast-path counts did not move**: `physical-envelope` 10,
`packaged-array` 5, `prepared-operation` 5 — the `g4-unit02-author` gate asserts
each registered file's exact cell count and verified. The root fold still costs
1 statement / 0 transactions.

**Biome** (`biome check`, never `--write`, never on a whole file) on the two
edited files: `operation-context.ts` reports only its pre-existing categories
(`organizeImports`, 4 × `noParameterProperties`, `format`), and
`uncertain-outcome-meta.test.ts` reports only `noMisplacedAssertion` on its
helpers (4) — its `format` findings, all in this round's new lines, were applied
by hand. [`biome-check.log`](receipts/d7-round2/biome-check.log)

## R2.7 Registration, files, patches, identity, cost

**Counts to register (manifest NOT edited, as instructed).**

- `tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts` — **10** cells
  (7 after round 1, 4 before it), credential-free, project `raptor3`, mode
  `g4-unit02-author`.
- `tests/raptor3/g4/unit02/lone-statement-transport.test.ts` — **7** cells,
  unchanged this round.
- `g29-result-progress` stays at **2**, the PGlite twin at **1**.

| File | sha256 after |
| --- | --- |
| `src/query-engine/raptor3/shared/operation-context.ts` | `aec115a3a817572c6edd0dab9d6400ed953eee28d44298bd73f73ad513fee1b1` (was `8689fe66…`) |
| `src/query-engine/raptor3/AGENTS.md` | `739397f348136cb9730319f686e7156e063c61155dfcb462437d14070c5e4ce2` (was `18164d0e…`) |
| `tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts` | `cc0b6dea3eb79e318588c4ac3022f0713c714de235e058c515d8309b7bfb5e61` (was `ea5cc3b9…`) |
| `tests/raptor3/g4/unit02/lone-statement-transport.test.ts` | `8b849837…` — unchanged |
| `tests/raptor3/post-prep/g29-result-progress.test.ts` | `8518e406…` — unchanged |
| `tests/raptor3/post-prep/g29-result-progress-pglite.test.ts` | `08557353…` — unchanged |
| `src/query-engine/raptor3/route/client-route.ts` | `976bbf85…` — unchanged, no route edit |
| `tests/raptor3/g3/generation/transport-plans.ts` | `5232c398ee8a0b3f5abb38f771e185ec36af61f15f0d898bdfdfee8af1324cac` — the integrator's applied harness diff, untouched here |

**Patches regenerated** from the same recorded closure base, verified in both
directions: reverse-applying reproduces
`query.ts 5143b7b36f6711dc0605ee534b8ef28d351f278ebebbed2354e1955c22352715` and
`operation-context.ts 8b25f6fea73cfe2a1a50ac2558aeb01c3b2bd7563217e5266a89c22ee10451b6`
exactly, forward-applying reconstructs **19/19 files byte-identically**.

| Patch | Files | sha256 |
| --- | --- | --- |
| [`../unit02/production-closure.patch`](../unit02/production-closure.patch) | 7 | `1560808b41b4aeb77add81f4a3fe803c7aec57b9f40baf4e7102a06b743cca3e` |
| [`../unit02/tests-closure.patch`](../unit02/tests-closure.patch) | 12 | `f8001d1edd4f27aac097799d33c78d64e3589c332667d372dbc4bab313addae4` |

`unit03/production.patch`, `production.patch`, `production-phase2.patch`,
`tests.patch` and `tests-phase2.patch` are untouched. `raptor3/AGENTS.md` is
Markdown and stays outside both patches and outside `captureRaptor3Identity`.

**Identity recapture** (`captureRaptor3Identity`, after the last production and
test edit, [`identity-after.json`](receipts/d7-round2/identity-after.json)):
production `ad918c0e71af347885bbbec11ed04aac1516bfcf32b0434e58755e4465a31f2f`
(was `0a0a7e9b…`), harness
`a339c70ad453d3afc0444c0fe3433bde956a2c8b745f56509311b9d50f0ac7ed`
(was `3f579a1a…`; this round changed one file under `tests/raptor3`, and the
harness fingerprint also carries the integrator's `transport-plans.ts` and the
reviewer's three probe files), node v24.21.0, darwin arm64, sqlite driver
12.6.0, vitest 3.1.4.

**Cost**, same census (`countTokenLines`, JSDoc and EOF excluded),
[`cost.json`](receipts/d7-round2/cost.json). The pre-round figures reproduce
§D.8's exactly, which cross-checks the measure:

| | bytes | physical | token-lines |
| --- | --- | --- | --- |
| `shared/operation-context.ts` | 79,053 → 84,011 | 2,127 → 2,228 | 1,849 → 1,892 |
| **increment (this round)** | **+4,958** | **+101** | **+43** |

Candidate **core** (12 files, `commands/` + `shared/`) now measures
**377,661 bytes / 10,609 physical / 9,518 token-lines**; the whole
`src/query-engine/raptor3` tree (15 files) measures
**414,566 / 11,645 / 10,400**. The complete charged perimeter remains UNVERIFIED
for §R.6's unchanged reason; this round adds no file to it.

## R2.8 §7 decision-elimination answers, against this diff

1. **What decision disappears?** "Which failure does a caller see when the write
   outcome and its cache listener both fail?" stops being answered by WHICH of
   the two the transport happened to learn first. Both transports now answer it
   the same way — the operation's own failure is primary — and the plain path no
   longer has a second answer for "is the value I publish the public one or the
   internal one".
2. **Could a caller still express the old behavior?** No. There is no flag and no
   per-transport branch: `retainOutcomeFailure` is the one composition, reached
   from the two places a primary can become known, and the hold has exactly one
   producer (`acknowledged`) and one release point per submission
   (`settleSubmitted`, or `submit`'s own catch when the batch itself failed).
3. **Is any meaning now stated twice?** No new restatement. The one deliberate
   restatement of `retainWriteOutcomeFailure` is now a single named expression
   rather than an inline literal, used at two sites instead of one.
   `answeredFailures` generalises `premiseFailures` rather than adding a second
   set: one fact — this operation has already answered with this failure —
   asked once, in `failure()`'s existing early return.
4. **What falsifies it?** §§R2.1-R2.3's three mutations, each measured: each
   reddens exactly one of the three new cells, with the shipped answer beside the
   candidate's, and leaves the other nine green.

## R2.9 Blockers and unverified

**Blocker D-7.1 (§D.6) is unchanged and still Arnaud's**: root `update`/`delete`
publish no `statementIndex` where the shipped engine publishes `0`. Nothing in
this round touches it; cell 7 still pins it as measured.

**Unverified (new to this round):**

- `submit()`'s own catch releasing the hold (R2.2 item 3) is reachable only on a
  driver with `supportsOrderedCommittedSegments`, where `acknowledged` runs
  inside the driver's callback. No such driver exists in the credential-free
  estate, so that arm is reasoned from the shipped order and is not measured by
  colour.
- The three submit-decode sites other than `setMutations`' batch arm (`flush`,
  the terminal decode, the record route's `insert`) go through `settleSubmitted`
  for the same reason and are covered by the registered suites only for the case
  where nothing is held (no listener failure); no cell measures a held failure
  released at those three sites.
- The reviewer's D12 remains red by exactly one field, the accepted
  committed-set-window `recordSeriesProgress` (§R2.2). Whether shipped should be
  matched on that field is `g4/regression-review.md` finding 3's open statement,
  not this round's.

**Unverified, unchanged from §D.10:** every generated seed beyond
`g2-generated`'s 52; the phase notifications on a SUCCESSFUL own-region write;
the uncertain-outcome class test's narrower sentence (the followup review's
finding 4).

# G3-02 specimen — the last harness file pinning the pre-D-7 transport

Brief: [`g4/briefs/g3-02-specimen.md`](../briefs/g3-02-specimen.md) (with
[`common.md`](../briefs/common.md)). Author: bounded harness unit, by writer
transfer of `tests/raptor3/g3/author-execution-regressions.test.ts` **only**.
No production file, no manifest edit, no route edit; nothing committed, staged,
reset, stashed or deleted. Receipts: [`receipts/g3-02/`](receipts/g3-02/).

## G.1 Gate (written before the first edit)

**Required behavior.** A malformed provider row is translated into the
registered malformed-scalar identity with TRUTHFUL progress, and nothing is
published — whichever transport the operation's plan actually uses. That is the
same property §D.3 restated for the two G2.9 specimens; this file is the third
member of the family and was not in the D-7 unit's mode list.

**Current owner.** `src/query-engine/raptor3/shared/operation-context.ts`:
`setMutations` chooses the transport by the `lone` condition (`:1141-1145`),
`failure()` decides whether a failure carries `recordSeriesProgress` (`:383-436`),
and `submit()` is the only writer of `committedSegments` / `committedMembers`
(`:716-717`). Nothing here is proposed for change — the owner is correct and the
harness is what records stale transport knowledge.

**Smallest proposed change (harness only).** State the specimen's corruption cut
over ANY row-bearing response on ANY transport, at the driver's `execute` (which
the driver's own batch entry dispatches every query through), instead of over
`executeBatch` alone; assert the shipped answer for the request whose plan is one
statement; and keep the "acknowledged atomic batch → truthful progress" half
pinned by a request that is still a real batch.

**Decisions that disappear.**

- *Mechanism:* the specimen stops deciding "which driver entry carries the
  fault" — a physical choice it has no business owning. One cut, stated once,
  reaches whichever entry the plan uses.
- *Consumers:* nothing downstream; this is a harness file. The registered cell
  count stays 3, so no manifest or registration consumer changes.
- *Replacing invariant:* the cut follows the ROW, not the transport; the
  transport is then a measured observation of the cell (`batchCalls`), not a
  premise of the fault.
- *Falsifier:* narrow the cut back to `executeBatch` — the lone-statement half
  stops being reached and the create succeeds ("Missing expected rejection"),
  which is exactly the attempt-2 red.

## G.2 What the cell pinned, and what it pins now

`tests/raptor3/g3/author-execution-regressions.test.ts:127` "reports a malformed
result after its atomic batch was acknowledged" made ONE request — a two-row,
relation-free `record.createMany` with `select` on a batch-only driver — and
stated its fault cut inside `executeBatch`, corrupting `id` in the batch's
results. It then asserted a rejection carrying
`recordSeriesProgress {atomicity:"segment", phase:"result", committedSegments:1,
committedWriteMembers:1, completedMembers:0}` and `batchCalls === 1`.

After D-7 that request's plan is ONE statement, so it leaves the batch
(`shared/operation-context.ts` `setMutations`: `lone = statements.length === 1 &&
this.attempt.pending.length === 0 && this.continuations.length === 0`, guarding
`if (this.usesBatch && !lone)`). The cut therefore sits on an entry the plan
never reaches, the corruption never happens, and the create SUCCEEDS —
"Missing expected rejection", the single red of qualification attempt 2
([receipt](../qualified-attempt-2-stale-identity/fixed/g3-author-execution-regressions.log)).
This is the §5.4 elimination the two G2.9 docblocks were written to prevent;
this file simply was not in the D-7 unit's mode list.

**The cell now makes two requests in one cell** (the registered count is 3 and
must not move), under one cut stated over ANY row-bearing response on ANY
transport, at the driver's `execute` — which the driver's own batch entry
dispatches every query through (`drivers/driver-transaction-base.ts`
`executeBatch`, the loop at `:667-700`). Same cut, same fault, whichever entry
the plan uses. The cut is armed after the migration (`arm()`) so it fires only
on the operation under test.

| Half | Request | Answer pinned |
| --- | --- | --- |
| **A — lone statement** | the specimen's own two-row relation-free `record.createMany({select})` | the SHIPPED malformed-scalar `QueryEngineError` (`V9001`, `Driver "sqlite3" returned a malformed int scalar for operation "createMany": the value is not a canonical integer.`) with meta EXACTLY `{driver, operation, scalarType}` and **no** `recordSeriesProgress`; `batchCalls === 0`, exactly **one** `execute`; nothing published; both rows committed (statement-atomic) |
| **B — real batch** | `parent.createMany` whose one member carries a NESTED write (`leftChildren.createMany`) plus `select` | the same message, **plus** `recordSeriesProgress {atomicity:"segment", phase:"result", committedSegments:1, committedWriteMembers:2, completedMembers:2}`; `batchCalls === 2`, the window carrying the parent insert has more than one statement; the parent row and its child are committed |

Half A is the half that would have caught attempt 2's red; half B is the
"acknowledged atomic batch → truthful progress" property the cell has always
owned. Neither half alone is the specimen.

## G.3 The shape chosen for half B, and why it is a real batch on this driver

**Shape: a `createMany` with a nested relation write**, not a bind-budget split.
Measured plan, in order (receipt:
[`falsification-2-nested-write-dropped.log`](receipts/g3-02/falsification-2-nested-write-dropped.log)
carries the same statement list for the lone counter-shape, and the green run's
diagnostic prints it whenever the cell fails):

1. `CREATE TEMP TABLE IF NOT EXISTS "__viborm_batch_refs" …`
2. `DELETE FROM "__viborm_batch_refs" WHERE "batch_id" = ?`
3. `INSERT INTO "g3_author_execution_parents" ("label") VALUES (?)`
4. `INSERT INTO "__viborm_batch_refs" … CAST((last_insert_rowid()) AS TEXT) …`
5. `INSERT INTO "g3_author_execution_left_children" … CAST((SELECT "ref_value" …) AS INTEGER)`
6. `SELECT "q0"."id", "q0"."label" FROM "g3_author_execution_parents" … `
7. `DELETE FROM "__viborm_batch_refs" WHERE "batch_id" = ?`

Statements 1-5 are the WRITE window, submitted as ONE `executeBatch`; statements
6-7 are the terminal window. `batchCalls === 2`, and the window carrying the
parent insert holds five statements — so `lone` is false and `setMutations` keeps
its batch envelope. WHICH of the three conjuncts the plan trips
(`statements.length === 1`, `attempt.pending.length === 0`,
`continuations.length === 0`) is not separately instrumented and is listed as
unverified in §G.9; the cell asserts only what it measures — the batch count and
the window's own plurality.

**Why this shape and not a bind-budget split.** A split is a physical parameter
the harness sets (`maxBindParametersPerStatement`), so a planner that stopped
chunking would eliminate the cell the same way D-7 eliminated the old one. A
nested write spans three tables and one generated key: no planner choice folds
it into a single statement, so half B cannot be silently eliminated. The
bind-budget-split form of the identical property already has a registered home —
`tests/raptor3/g4/unit02/lone-statement-transport.test.ts` row 6 (§D.4) — so
choosing the nested write ADDS a shape to the estate instead of duplicating one.

**Why the member counts differ from the pre-D-7 ones.** They are the counts this
request really has: two write members (the parent record and its nested child),
both complete, inside one committed segment — where the old one-statement
request had one write member and no completed member. `committedSegments: 1`,
the field the property is about, is unchanged, and it is still written in exactly
one place (`OperationContext.submit`, `:716`).

## G.4 Falsifications

Each mutation was applied to the working file and restored from a scratchpad
copy (never `git checkout`); the file is
`fca8677c13d2dcdd6ccd4ca97350042a2340fa25a1aca34de601af985e800aa2` before and
after both; the two lint-only edits of §G.6 and one comment correction (§G.3's
accuracy fix) then take it to its final
`778438ffa1729b90d5501e4994a7ede2b231bd8034a6b2bbcdc293cc163f4132`.

| Mutation | Effect | Receipt |
| --- | --- | --- |
| narrow the cut back to `executeBatch` only (a `withinBatch` flag set around the batch entry) — the pre-D-7 spelling | half **A red**: `corrupted: false`, `batchCalls: 0`, and the create publishes `[{id:1},{id:2}]` — the attempt-2 red reproduced exactly. Half B unreached | [`falsification-1-cut-narrowed-to-executebatch.log`](receipts/g3-02/falsification-1-cut-narrowed-to-executebatch.log) |
| drop the nested write from half B's request (`leftChildren` removed), leaving a lone-statement `parent.createMany` | half **B red**: `batchCalls: 0`, and the refusal carries meta `{driver, operation, scalarType}` with **no** `recordSeriesProgress` — the nested write is exactly what makes this half a batch | [`falsification-2-nested-write-dropped.log`](receipts/g3-02/falsification-2-nested-write-dropped.log) |

The second falsification is also the positive evidence for §G.3's claim: the same
request WITHOUT the nested write answers half A's sentence, so the two halves
differ by the `lone` condition and nothing else.

## G.5 Suites (bounded runner, one mode per invocation, after the last edit)

The lock was free throughout; every mode ran through `node scripts/run-raptor3.mjs`
and its contract gate verified. Receipts in [`receipts/g3-02/`](receipts/g3-02/).

| Mode | Result | Wall / peak RSS |
| --- | --- | --- |
| `g3-author-execution-regressions` | **3 passed (3)**, gate verified (count still 3) | 3.85 s / 511.9 MiB |
| `g3-execution-review` | 6 passed (6) | 4.01 s / 530.7 MiB |
| `g3-suppression-retry` | 2 passed (2) | 4.12 s / 512.2 MiB |
| `g3-transaction-array` | 4 passed (4) | 3.97 s / 529.9 MiB |
| `g29-dependency-boundaries` | 4 passed (4) | 3.87 s / 561.0 MiB |
| `g29-dependency-choices` | 10 passed (10) | 3.93 s / 542.3 MiB |
| `g29-member-dependency` | 14 passed (14) | 4.05 s / 530.0 MiB |
| `g29-result-progress` | 2 passed (2) | 3.99 s / 525.9 MiB |
| `post-g3-projection-preparation` | 4 passed (4) | 3.57 s / 501.5 MiB |
| `post-g3-selector-preparation` | 4 passed (4) | 3.63 s / 512.6 MiB |
| `cs01-structural-reference` | 10 passed (10) | 3.89 s / 538.4 MiB |
| `cs01-extension-a` | 6 passed (6) | 3.97 s / 527.1 MiB |
| `cs03-member-scope` | 8 passed (8) | 3.73 s / 505.2 MiB |
| `g1-transport` | 44 passed (44) | 4.44 s / 723.0 MiB |
| `g2-transport` | 16 passed (16) | 4.37 s / 688.8 MiB |
| `g4-route-transactions` | 13 passed (13) | 4.17 s / 543.1 MiB |
| `g4-unit02-author` | 127 passed (127), 19 files | 5.67 s / 788.4 MiB |
| whole-estate typecheck | only the two permitted `pattern/pack.ts` TS2345 (`:1443`, `:2633`), 2 diagnostics total | 7.03 s / 6,035.2 MiB |

Every row above was taken on the FINAL file (`778438ff…`). An earlier, identical
green run of the sixteen sibling modes, taken before the two lint-only edits of
§G.6, is kept unrelabelled at
[`receipts/g3-02/pre-lint-edit/`](receipts/g3-02/pre-lint-edit/) — same counts,
same greens.

## G.6 Biome

`biome check` on the one edited file, never `--write`, never on a whole file:
**8 findings in 5 categories — exactly the baseline's 8 findings in the same 5
categories** (the untouched file also reports 8): `organizeImports`,
four `useTopLevelRegex` (all in cell 2, pre-existing), `noUnusedFunctionParameters`
(`ObservedSQLiteDriver.execute`'s `context`, pre-existing), `noMisplacedAssertion`
(`transactionArray`, pre-existing) and `format`. The baseline was measured by
running `biome check` on a copy of the pre-edit file inside the same directory
(the copy was removed immediately; it was never a test file and never collected).

Two lint-only edits were made by hand so that this round adds NO new category:
the row guard was written positively (`if (isRecord(row) && Object.hasOwn(row,
"id"))`) instead of a negated disjunction, which removes the
`useSimplifiedLogicExpression` the first draft added; and one `assert.deepEqual`
of mine was wrapped to the formatter's shape. Every remaining `format` site is
pre-existing (the `@drivers` type import, the two `parent: s.toOne(…)` chains,
and cell 2's `transactionArray` call); the one pre-existing format site that
lived inside the old cell 1 is gone with it.
[`biome-check.log`](receipts/g3-02/biome-check.log)

## G.7 Registration, files, identity, cost

**Cell counts: UNCHANGED, nothing to register.**
`tests/raptor3/g3/author-execution-regressions.test.ts` stays at **3** cells
(`scripts/raptor3-manifest.mjs:417`, `G3_AUTHOR_EXECUTION_REGRESSION_COUNTS`);
the runner's gate verified 3 on the final file. The manifest was not edited. The
re-expression is contained in cell 1, which now makes two requests rather than
one; a second `it` would have moved the count, so it was not written.

| File | sha256 |
| --- | --- |
| `tests/raptor3/g3/author-execution-regressions.test.ts` | `778438ffa1729b90d5501e4994a7ede2b231bd8034a6b2bbcdc293cc163f4132` (was `688de89ca7eac91985cb1bba5928409806e877ce6900c632355522fb78f7c527`) |

No other file under `src/`, `tests/`, `scripts/` or `benchmarks/` was touched; no
patch file was regenerated (this unit's diff is harness-only and belongs to the
tests patch whenever the integrator next regenerates it — **requested, not done
here**, since `unit02/tests-closure.patch` is another stream's file).

**Identity** (`captureRaptor3Identity`, after the last edit,
[`identity-after.json`](receipts/g3-02/identity-after.json); the before-state is
[`identity-before.json`](receipts/g3-02/identity-before.json)):

- production `fce8ec0cd32c839c5517a383d92f003e090e72cb8110b8ec0e08e1f7664d6904` —
  **unchanged**, which is the proof that no production file was touched.
- harness `41e2b2f64c02af90ae6d892e56607247e741c30b762dcb9b7f8e992e3d08f126`
  (was `2b5ed066a619bf8accf7b3f503cd96f7b4b7e4aac52c1249cfa7cf751df1666c`) — one
  file under `tests/raptor3` changed.
- runtime: node v24.21.0, darwin arm64, sqlite driver 12.6.0, vitest 3.1.4.

**Cost.** Incremental candidate **core** charged LOC, parser tokens and bytes:
**0 / 0 / 0** — no charged file changed, and the unchanged production fingerprint
above is the measurement. The whole-estate census ran for the record
([`query-engine-structure.log`](receipts/g3-02/query-engine-structure.log):
`src/query-engine` 181 files, 86,631 physical lines, 68,606 token-lines, 3,846
functions, 8,983 branch nodes). The ABSOLUTE core/whole raptor3 perimeter is not
restated here: §R2.7's figures were measured on
`operation-context.ts aec115a3…` and the current tree carries `58e89525…` from
later units, so quoting them would be stale — and this round moves them by zero
in any case. The harness file itself (counted separately from the charged
perimeter) goes 436 → 652 physical lines and 14,161 → 22,891 bytes, most of it
the two docblocks and the per-half diagnostics.

## G.8 §7 decision-elimination answers, against this diff

1. **What decision disappears?** "Which driver entry carries this specimen's
   fault?" The cell no longer decides it. One cut, stated over any row-bearing
   response, reaches whichever entry the plan uses, so the specimen stops
   encoding a transport choice it does not own — and stops being silently
   waivable when that choice changes. A second decision goes with it: "what is
   the truthful progress here?" is no longer answered by the cell's memory of
   the pre-D-7 transport but by the shape of the request it actually makes.
2. **Could a caller still express the old behavior?** Not from the cell: there
   is no flag and no transport-specific branch left in it. The old sentence is
   reachable only by narrowing the cut again, which is falsification 1 and goes
   red.
3. **Is any meaning now stated twice?** No. The engine's transport rule stays in
   `setMutations`; the cell OBSERVES it (`batchCalls`, the window's length)
   rather than restating it. Half B's property is the same property row 6 of
   `lone-statement-transport.test.ts` pins — deliberately, on a different shape
   (structural nesting vs. bind-budget split), which is coverage, not a second
   authority: neither file states the rule, both measure it.
4. **What falsifies it?** §G.4's two mutations, each measured: narrowing the cut
   reddens half A exactly as attempt 2 did, and removing the nested write
   reddens half B by turning it into half A.

## G.9 Blockers and unverified

**No blockers.** No production change was needed, no public contract moved, no
registered refusal changed, no legacy fallback was required, and no cell count
must change. Blocker **D-7.1** (§D.6) is untouched and still Arnaud's.

**Unverified:**

- The re-expressed cell is measured on `better-sqlite3` only. Whether a provider
  WITHOUT `RETURNING` (where the same relation-free `createMany` needs a split
  trace) answers half A's sentence is not measured here; the split form is
  `g4/unit02/malformed-result-cuts.test.ts` cell 1/1b, which was not re-run by
  this unit (it is inside `g4-unit02-author`, which is green at 127/127).
- Half B's `completedMembers: 2` / `committedWriteMembers: 2` are recorded as
  MEASURED on this engine; no shipped-engine comparison was run for this shape,
  so "the shipped engine would publish the same member counts" is NOT claimed.
- Which conjunct of `lone` half B's plan trips (§G.3) is inferred from the
  measured five-statement write window, not instrumented; the cell asserts the
  window, not the conjunct.
- The native provider modes (`g2-mysql-contracts`, `g2-pg-contracts`) and the
  generated campaigns were not run: they are outside this brief's mode list and
  no production file changed.
