# Bounded unit — cache-invalidation signals come from the context, not from published meta

Read `common.md`, `g4/regression/note.md` (§2, §5, §10), `g4/regression-review.md`
(findings 1, 3 and the two notes), `g4/unit03/note.md` (B-4 execution context,
the route's binding kinds) and the private guide's route and envelope
paragraphs. You are the G4-02 author with writer transfer, for this unit
only, of `src/query-engine/raptor3/route/client-route.ts`. No shipped-engine
edits; no manifest edits (report counts); the D-7 blocker (`statementIndex`
on one-statement batches) is Arnaud's decision — do not attempt it.

## 1. The seam (review finding 1, blocking)

`route/client-route.ts:109-121` `publishFailedWriteOutcome` derives both
cache-invalidation signals (`committedWriteSegment`, `writeMayBeVisible`)
from the PUBLISHED `recordSeriesProgress` of the error. The shipped executor
calls `writeMayBeVisible?.()` from inside the executor
(`write-engine/OperationExecutor.ts:1052-1058`) before rethrowing the raw
error, so its meta is free to match the public contract. Measured by the
reviewer (probe P7 in `tests/raptor3/g4/review/regression/uncertain-outcome-neighbours.review.test.ts`):
on a batch-only driver with the harness before-dispatch fault, a root
`create` under `cache.autoInvalidate` yields shipped 1 invalidation,
candidate 0. Move the fact to its owner: `OperationContext` notifies the
route's `writeMayBeVisible` / `committedWriteSegment` through the execution
seam (`ExecutionBinding` / the routed execution it already receives) at the
point it learns the fact — `submit()`, where `mayHaveCommittedSegment` is set
and where `acknowledged()` runs — and `publishFailedWriteOutcome` stops
inferring anything from error meta (delete it or reduce it to the one call
the seam still needs). One owner for one fact; no second signal path; the
route still states WHICH situation it is in and never whether an envelope is
needed. Keep the shipped ordering (invalidate before the failure is
published) and the existing behavior for real series (committed segments →
`committedWriteSegment`; uncertain → `writeMayBeVisible`).

## 2. The sentence (review finding 3, must-fix)

Narrow the rule as the code enforces it: an UNCERTAIN outcome alone is not a
record series; a committed set window still publishes its progress (the G2.9
pin). Fix the code comment at `shared/operation-context.ts:350-356`, note §2,
and apply note §10's replacement to `AGENTS.md:406-410` with that narrowing.

## 3. The cells (review note)

Split `tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts` into (a) a
green, falsifiable cell asserting `recordSeriesProgress === undefined` on
both engines for the pre-dispatch-rejected root create (and the invalidation
count parity the reviewer measured: shipped 1 / candidate 1 after this unit),
and (b) a separately named, clearly labelled red reproducer of the D-7
blocker (`statementIndex`) — keep (b) OUT of any registered mode; report the
registration of (a) (file and count) for the integrator. Add the reviewer's
P7 as an author cell (or keep P7 by reference) so the seam has a falsifier:
disabling the context's notification must turn it red.

## 4. Checks and record

One mode per Bash call, bounded: `g4-route-cache`, `g4-route-transactions`,
`g4-route-lifecycle`, `g4-lifecycle-admission`, `g4-unit02-author`,
`g29-result-progress`, `g3-transaction-array`, `g2-contracts`, `g2-generated`
(expect 51/52 — the one red is D-7 — and state it), `g2-mysql-contracts`
(port from `docker port viborm-raptor3-g3-mysql-20260914 3306`), `g2-pg-contracts`
(`docker port viborm-raptor3-g3-pg-20260914 5432`), the whole-estate
typecheck. Frozen fast-path counts must not move. Write
`g4/regression/note.md` "Seam round" (mechanism, invariant, falsifier,
receipts under `g4/regression/receipts/seam/`), regenerate the unit02 closure
patches and the G4-03 route patch (`g4/unit03/production.patch` is the
route's record — regenerate it too) with hashes, recapture identity after the
last edit. Never commit, stage, reset, stash or delete; restore
falsifications from a scratch copy; never run Biome `--write` on a whole
file (reformatting churn broke the validation barrel once).

## Exit and return value

Structured summary: unit, summary, location, notePath, patchPath, repairs,
suites, native, typecheck, cost, cellCounts, identity, blockers,
unverifiedClaims.
