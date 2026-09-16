# D-7 unit — a lone statement leaves the batch (Arnaud's decision, 22:40)

Read `common.md`, `g4/regression/note.md` (§4 attempt 2 and its receipt
`receipts/attempt2-lone-statement.log`, §1–§2), `g4/regression-review.md`
(finding 2: the family is every one-statement batch — root fold, relation-free
`createMany`/`updateMany`/`deleteMany`; finding 3), the seam round of the
same note, `tests/raptor3/post-prep/g29-result-progress.test.ts` and
`g29-result-progress-pglite.test.ts` (the G2.9 specimen and its
`CorruptingBatchSQLiteDriver`), and the ledger's D-7 row. You are the G4-02
author with writer transfer, for this unit only, of the two G2.9 test files
(harness stream) and `tests/raptor3/g4/unit02/**`. No shipped-engine edits;
no manifest edits (report counts).

## Decision applied

Arnaud chose the shipped transport rule: a set statement that is the
operation's ONLY statement needs no batch envelope (`write-engine/OperationExecutor.ts`
`runStatementAtomic` / `canExecuteDirectly`); on a batch-only driver it is
dispatched through the plain `_execute` path, not `_executeBatch`. Consequences
he accepted: no `statementIndex` (the driver seam never sees a one-statement
batch), no segment progress and no `mayHaveCommittedSegment` for a folded root
single-record write on a batch-only transport (the shipped raw error), and the
G2.9 "result progress" specimen re-expressed on the transport the fold now
uses. "G3 may not have the same knowledge as today."

## Work

1. **The rule, once, in the physical owner** (`shared/operation-context.ts`):
   attempt 2's condition (`statements.length === 1 && attempt.pending.length === 0
   && continuations.length === 0` takes the existing non-batch `dispatch`
   path) stated where the envelope decision lives (`OperationContext.run` /
   `dispatch` / `setMutations`), applying equally to the root fold and to a
   relation-free `createMany` / `updateMany` / `deleteMany` whose plan is one
   statement. Frozen fast-path counts must not increase (physical-envelope
   10 / packaged-array 5 / prepared-operation 5 stay as pinned; 1 statement /
   0 transactions for the root fold). The exact failed-INSERT recovery (RF-12,
   `g2-mysql-contracts` 13/13) attributes on the batch attempt — state what a
   lone INSERT on the standalone batch route does now and keep the recovery
   contract; if a lone INSERT must stay in the batch for recovery, say so and
   keep the rule exact (the shipped engine's own condition).
2. **G2.9 re-expressed.** `g29-result-progress.test.ts` (both profiles) and
   the PGlite twin: the malformed-result cut for a root single-record write is
   injected on the transport the fold now uses (`execute`, a corrupting driver
   that wraps `_execute` for the lone statement); the truthful answer becomes
   the shipped one — the malformed-scalar refusal with the inherited
   malformed-scalar sentence and NO record-series progress; a REAL series
   (the same file's series member, or `createMany` with ≥ 2 statements /
   segments) keeps `committedSegments: 1` progress on a corrupted result
   exactly as today. Keep the registered cell counts (`g29-result-progress`
   is registered; report if a count must change).
3. **Cells.** The red D-7 reproducer in `tests/raptor3/g4/unit02/` becomes
   the positive contract: a root `create` rejected before dispatch on a
   batch-only driver answers meta byte-identical to the shipped engine (no
   index, no progress); add the three bulk verbs (relation-free
   `createMany`/`updateMany`/`deleteMany`, one statement, rejected before
   dispatch) as rows; keep the reviewer's neighbour probe green (multi-
   statement batches keep index parity; series keep progress). Falsifier: put
   the batch envelope back for the lone statement — the new rows go red.
4. **Guide.** `AGENTS.md` envelope paragraph: state the rule and the D-7
   decision (one sentence each).
5. **Checks**, one mode per Bash call, bounded: `g2-generated` (must be
   52/52), `g29-result-progress`, `g4-unit02-author`, `g4-route-cache`,
   `g4-route-transactions`, `g3-transaction-array`, `g3-suppression-retry`,
   `g3-bulk-series`, `g2-contracts`, `g1-transport`, `g2-transport`,
   `g3-generated-transport-smoke`, `g2-mysql-contracts` and `g2-mysql-baseline`
   (port from `docker port viborm-raptor3-g3-mysql-20260914 3306`),
   `g2-pg-contracts` (`docker port viborm-raptor3-g3-pg-20260914 5432`), the
   whole-estate typecheck. Write `g4/regression/note.md` "D-7 round"
   (mechanism, invariant, falsifier, receipts under `g4/regression/receipts/d7/`),
   regenerate the closure patches with hashes, recapture identity. Never
   commit, stage, reset, stash or delete; restore falsifications from a
   scratch copy; never run Biome `--write` on a whole file.

## Exit and return value

Structured summary: unit, summary, location, notePath, patchPath, repairs,
suites, native, typecheck, cost, cellCounts, identity, blockers,
unverifiedClaims.

## Added after the seam round's verification (ACCEPT, 22:47)

Read `g4/regression-review-followup.md`. Its note 2 is parity work for this
unit (no decision): when a cache-invalidation listener throws on an uncertain
root write, the shipped engine keeps the operation's own failure primary and
retains the listener's failure beside it (`OperationExecutor.ts:983-990`,
`:1057-1069`, "Query execution and write-outcome publication both failed."),
while the candidate lets the listener's error replace the operation's. Retain
the primary failure at the two seam call sites in `submit()` the same way
(one wrapper, no second mechanism); pin it with the reviewer's S6 shape as
an author cell; S7 (listener fails alone) must stay identical on both engines.
Also rename `tests/raptor3/g4/unit02/statement-index-blocker.red.test.ts` to a
positive-contract name once it is green, and report the final per-file cell
counts for `uncertain-outcome-meta.test.ts` (4 today) and the renamed file so
the integrator registers both.

## Round 2 (after `g4/d7-review.md`, REVISE, 00:10)

Read the review in full. Exactly its resolutions, in `shared/operation-context.ts`:
(1, must-fix) on the plain path, translate the decoding failure once —
`const failure = this.failure(error, "result")` where `decoded` is built —
and use it both as `stateWriteOutcome`'s primary and as the thrown value, so
the public malformed-scalar refusal stays primary when a cache listener also
throws (add the reviewer's D9 as an author cell in `uncertain-outcome-meta.test.ts`);
(2, note, fix together) on the batch transport's committed arm, hold the
decode failure while acknowledging so a throwing listener never replaces it
(the shipped `runAtomicBatch` order; the reviewer's D12 becomes an author
cell); (3) adopt the reviewer's D11 as an author cell so the plain path's
`owned` gate is falsifiable by colour; (4) the note/guide sentences the
review names (§D.1/§D.9 one sentence on the three unreachable shipped
exclusions; §D.3 naming `malformed-result-cuts.test.ts` cell 1 as the
rolled-back form's home; `AGENTS.md:425-426` naming the current witness of
the committed-window progress; rewrap :436). The harness diff for
`transport-plans.ts` is already applied by the integrator (do not touch it).
Re-run the same modes as round 1 plus `g3-generated-transport-smoke`
(expect green now), regenerate the closure patches with hashes, recapture
identity, report the final per-file cell counts of the two unit02 files.
