# Bounded repair — record-series progress meta on a non-series failure (G4 regression)

Read `common.md`, `g4/unit02/note.md` (phase 2 E-f row, §P.4.*, the closure and
decisions sections on `failure()`), the private guide's envelope paragraphs, and
the ledger record "Qualification attempt 1 stopped (20:49)". You are the
G4-02 author. You own `src/query-engine/raptor3/shared/operation-context.ts`
(and the candidate files), `tests/raptor3/g4/unit02/**`. No shipped-engine
edits, no harness edits outside your estate, no manifest edits (report counts).

## The regression (measured by the integrator)

`node scripts/run-raptor3.mjs g2-generated` — clean `0cc61e61` worktree: 52/52
(`scratchpad` receipt copied to `g4/regression/classify-g2-generated-baseline-0cc61e61.log`);
frozen tree: 51/52, cell "G2 generated two-before-dispatch followed by healthy
calls: sqlite-atomic-batch", seed 2122 (`key-move`, two actors, fault
`two-before-dispatch`), receipt `g4/qualified-attempt-1-stale-identity/fixed/g2-generated.log`
and the failure/corpus JSON beside it in `g2-generated.receipt/`. The oracle
(`benchmarks/operation-pipeline-semantics.mjs` `assertEquivalentRunObservations`)
compares the shipped engine's run with the candidate's, meta included. For a
subsequent root `create` whose atomic batch is rejected BEFORE dispatch (the
harness driver throws `Controlled failure before dispatch` from
`_executeBatch`, `tests/raptor3/harness/sqlite-world.ts:84-91`), the candidate's
failure meta carries `recordSeriesProgress { atomicity: "segment", phase:
"member", committedSegments: 0, committedWriteMembers: 0, completedMembers: 0,
mayHaveCommittedSegment: true }` and `statementIndex: 0`; the shipped failure
carries neither.

## The shipped rule (cite it in the note)

`write-engine/OperationExecutor.ts:1031-1072`: for a single operation the
executor sets its internal `progress.mayHaveCommittedSegment` (only after
`dispatching()` fired, :1005-1010) and calls `writeMayBeVisible`, then
`throw error` — the raw error. `attachProgress` (:2308) is applied only to
record-series member failures and to the invalidation-failure aggregates; a
root single-record write's failure never carries `recordSeriesProgress`.
The unknown-outcome fact is internal (it drives cache invalidation), not
public meta, unless a record series exists.

## The candidate's site

`shared/operation-context.ts:338-355` `failure()`: attaches progress when
`usesBatch && (phase === "prefix" || committedSegments > 0 || mayHaveCommittedSegment)`
— the transport kind decides (E-f's own row says "a statement-atomic
operation has no series"). `submit()` :665-673 sets `mayHaveCommittedSegment`
for a member-bearing batch rejected without ordered committed segments — that
internal fact is right and must keep driving the route's `writeMayBeVisible`
(`route/client-route.ts:117-121`) and the recovery gating at :654/:707; do not
change when it is set.

## The repair

One rule in one owner: a failure carries `recordSeriesProgress` only when it
belongs to a record series — the fact the context already owns (member
attribution / the series the operation is: `createMany`, `updateMany`,
`deleteMany` series, array members, nested selected series), never from the
transport kind alone. A root single-record write (`create`/`update`/`delete`/
`upsert`, folded or packaged) answers the driver's own error with the shipped
meta even when its outcome is unknown. No per-verb table: ask the owner of
"is this a series" once. Minimize first: reproduce seed 2122 through the
runner, name the exact branch, then change it; keep `phase === "prefix"` and
`committedSegments > 0` semantics for real series (they are the g29 pins).

## Cells and checks

Add to your estate (`tests/raptor3/g4/unit02/`): a differential cell on the
`sqlite-atomic-batch` world — a root `create` rejected before dispatch (the
harness `before-dispatch` fault) answers byte-identical meta on both engines;
a control — a real series member (an array member or `createMany` segment)
rejected the same way keeps its progress on the candidate exactly as
`g29-result-progress` pins; falsify by reverting the branch (the first cell
must go red, the control green). Then run, one mode per Bash call, bounded:
`g2-generated`, `g2-contracts`, `g29-result-progress`, `g3-transaction-array`,
`g3-suppression-retry`, `g3-bulk-series`, `g4-route-transactions`,
`g4-unit02-author`, `g3-execution-review`, `g2-mysql-contracts` and
`g2-mysql-baseline` (MySQL port from `docker port viborm-raptor3-g3-mysql-20260914 3306`,
env `VIBORM_RAPTOR3_PROVIDER_PORT`; the exact failed-INSERT recovery must
stay 13/13), `g2-pg-contracts` (PostgreSQL port likewise), the whole-estate
typecheck. Frozen fast-path counts (physical-envelope 10 / packaged-array 5 /
prepared-operation 5) must not move. §8 stop rule: if the same minimized
failure survives two attempted repairs, stop and record it for Arnaud with
both attempts' receipts. Write `g4/regression/note.md` (mechanism, invariant,
falsifier, receipts under `g4/regression/receipts/`), regenerate the unit02
closure patches with hashes, recapture identity after the last edit. Never
commit, stage, reset, stash or delete; restore falsifications from a scratch
copy. Return the structured summary (unit, summary, location, notePath,
patchPath, repairs, suites, native, typecheck, cost, cellCounts, identity,
blockers, unverifiedClaims).
