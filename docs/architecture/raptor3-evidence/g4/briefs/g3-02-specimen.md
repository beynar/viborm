# Bounded harness unit — re-express the G3-02 malformed-batch specimen under D-7

Read `common.md`, the ledger's D-7 rows and "D-7 unit" records in `g4.md`,
`g4/regression/note.md` §D.3 (how the two G2.9 specimens were re-expressed:
the cut stated over any row-bearing response on any transport, at the
driver's `execute`; the truthful answer for a lone statement is the shipped
malformed-scalar refusal with NO record-series progress; a real series keeps
its committed-segment progress), and the failing receipt
`g4/qualified-attempt-2-stale-identity/fixed/g3-author-execution-regressions.log`.
You own `tests/raptor3/g3/author-execution-regressions.test.ts` (harness, by
writer transfer) and nothing under `src/`. No production change; no manifest
edit; registered cell counts must not change (report if one must).

## The red

`tests/raptor3/g3/author-execution-regressions.test.ts:127` "reports a
malformed result after its atomic batch was acknowledged": a two-row
relation-free `createMany` with `select` on a batch-only driver whose
`executeBatch` corrupts the result; it expected a rejection carrying
`recordSeriesProgress { committedSegments: 1, committedWriteMembers: 1 }`
and `batchCalls === 1`. After D-7 the plan is ONE statement, so it takes
the plain `execute` path, the corruption cut in `executeBatch` is never
reached, and the create succeeds: "Missing expected rejection". Attempt 2
of the qualification found it; the fixed group's other 64 modes are green.

## Work

1. Re-express the cell exactly as the G2.9 precedent: state the corruption
   over the row-bearing response at the driver's `execute` too (or make the
   corrupting driver cut on either entry), assert the shipped answer for the
   lone statement (the malformed-scalar `QueryEngineError` with meta
   `{ driver, operation, scalarType }` and NO `recordSeriesProgress`, both
   rows committed, `batchCalls === 0`, one `execute`), and keep the
   "acknowledged atomic batch → truthful progress" property pinned by a
   request that is still a real batch (a `createMany` whose plan has two or
   more statements — for example with a nested write or a generated-key
   read-back that forces the batch — asserting `committedSegments: 1` as
   before), so the specimen loses no property. Say which shape you chose and
   why it is a real batch on this driver (cite the candidate's `lone`
   condition in `shared/operation-context.ts`).
2. Check the siblings by running them: `g3-execution-review`,
   `g3-suppression-retry`, `g3-transaction-array`, `g29-dependency-boundaries`,
   `g29-dependency-choices`, `g29-member-dependency`, `g29-result-progress`,
   `post-g3-projection-preparation`, `post-g3-selector-preparation`,
   `cs01-structural-reference`, `cs01-extension-a`, `cs03-member-scope`,
   `g1-transport`, `g2-transport`, `g4-route-transactions`, `g4-unit02-author`,
   and of course `g3-author-execution-regressions` (3/3). One mode per Bash
   call, bounded; the lock is free. Whole-estate typecheck (only the two
   Pattern diagnostics).
3. Write `g4/regression/note.md` "G3-02 specimen" section (what the cell
   pinned, what it pins now, the shape, receipts under
   `g4/regression/receipts/g3-02/`); recapture identity after the last edit.
   Never commit, stage, reset, stash or delete; never run Biome `--write` on
   a whole file.

## Exit and return value

Structured summary: unit, summary, location, notePath, repairs, suites,
typecheck, cellCounts, identity, blockers, unverifiedClaims.
