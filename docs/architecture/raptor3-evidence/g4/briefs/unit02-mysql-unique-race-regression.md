# G4-02 bounded repair — MySQL atomic-batch unique-race recovery regression

Read `common.md`, the G4-02 brief (`unit02-physical-provider.md`, all
revisions), `g4/unit02/note.md` (phase 1 §4.3–4.4, R.3, phase 2 P.4.1,
P.4.7, P.4.9 and the repair records), the private guide's recovery paragraphs
(`src/query-engine/raptor3/AGENTS.md`: "Unique recovery belongs to the exact
failed INSERT's Assignments producer…", "Failed-INSERT producer attribution
is evidence, not replay authority…", "OperationContext admits attempt
replacement only on the standalone physical batch route after its exact
rejection proof"), plan §2.3 adjudicated recovery contract and inventory row
RF-12. You are the G4-02 author. You own the candidate files
(`shared/operation-context.ts`, `commands/execution.ts`, `commands/*`,
`shared/query.ts`, `shared/schema.ts`) and `tests/raptor3/g4/unit02/`.

## The regression (measured by the integrator)

`VIBORM_RAPTOR3_PROVIDER=mysql VIBORM_RAPTOR3_PROVIDER_PORT=<docker port viborm-raptor3-g3-mysql-20260914 3306> node scripts/run-raptor3.mjs g2-mysql-contracts`

- Clean `0cc61e61` worktree, same container: **13/13**
  (`g4/environment/g2-mysql-contracts-clean-0cc61e61.log`).
- Current tree (12:05): **10/13**
  (`g4/environment/g2-mysql-contracts-main-1205.log`), red cells in
  `tests/raptor3/transitions/unique-races-live-commands.test.ts`, suite
  "G2 live mysql atomic-batch unique races: commands":
  `g2-race-selected-unique-recovery` (deep-equal mismatch),
  `g2-race-unrelated-unique-refused` (deep-equal mismatch),
  `g2-race-wrong-insert-same-constraint`
  ("wrong-insert-provenance: preserve the measured legacy retry and approved
  exact-INSERT exclusion").
- PostgreSQL `g2-pg-contracts` on the current tree: 18/18.

These are the approved exact failed-INSERT recovery contracts (RF-12) on the
candidate's **standalone physical batch route** (MySQL without interactive
transactions in this lane). Suspects, in order: the statement-atomic fast
path / one-envelope rule (a folded single-statement `create` now dispatches
directly and may bypass the batch attempt's rejection attribution and
`restartRejectedInsert`), the prepared-operation boundary (attempt
replacement must reuse admitted values, never re-admit), the root `create`
fold changing which statement the constraint failure is attributed to, or
the `operationRegion`/`region()` change altering the batch-route ownership
test that gates attempt replacement.

## Constraints

- Preserve the adjudicated scope exactly: only the actual failed INSERT's
  producer and selected constraint may recover, once, before committed
  progress or dynamic member admission; wrong-constraint, unknown-outcome and
  acknowledged-prefix failures never replay; the shipped two-attempt
  baseline trace is the oracle (`unique-races-live-commands.test.ts`
  compares against the measured legacy tape).
- No second recovery owner, no re-admission, no replay on borrowed or
  preparation-owned execution, no per-verb branch. Repair the physical route
  in its one owner; if the fast path must yield to the batch attempt for a
  statement that can fail on a unique constraint, that is a physical-route
  rule stated once in `OperationContext.run`/`dispatch`, with the frozen
  fast-path statement counts re-pinned (`tests/raptor3/g4/unit02/physical-envelope.test.ts`).
- Minimize first: reproduce each red cell, name the exact mechanism, then
  repair. The same minimized failure surviving two attempted repairs is a
  blocker to record for Arnaud.

## Second obligation in the same unit: B-1c cache result codec (writer transfer)

`g4/unit03/note.md` §B-1c: the official cache result codec must be compiled
from the declaring `Scalar` objects through the official owners in
`src/query-engine/result/cache-value-codecs.ts` (`compileScalarCodec`,
`compileWidenedSumCodec`, `recordCodec`, `arrayCodec`, `nullableCodec`,
`taggedRelationCodec`, …), never re-dispatched from a `Leaf`'s type name.
Do exactly the recorded change: `Leaf` gains `scalar: Scalar` (set once in
`Queries.leaf`), and the route composes `leafCodec`/`shapeCodec` from the
official owners (~35 lines) so `$withCache` stores and materializes on the
candidate route. **Writer transfer for this unit only:**
`src/query-engine/raptor3/route/client-route.ts` and
`tests/raptor3/g4/route-cache.test.ts` (the LX-07 pending pin becomes a
positive assertion) pass to you; the accepted G4-03b record stays as is.
Expected outcome: `g4-route-cache` green with the pin flipped,
`g4-lifecycle-admission` 4/4, NS-04 store/materialize parity with the
shipped route (same cached value identity rules, fresh materialized graphs),
no second scalar authority anywhere (grep for `type ===` dispatch in the
route). Report the registered count changes for the integrator.

## Third obligation: the open items of the phase-2 third verification

`g4/unit02-phase2-review-followup-2.md` (REVISE) leaves one must-fix and
three notes; close them in this unit rather than another phase-2 round:

- **Must-fix (divide-by-zero on an upsert key, third shipped owner):**
  mirror the third owner — answer the divide-by-zero refusal from the
  position the shipped engine answers it (`RecordUpdateCompiler.ts:3319`
  `interpretReferencedKeyTransition`, at analysis, before any row is located)
  with the shipped sentence `Cannot divide a primary key by zero.`; on an
  absent row the shipped engine refuses and writes nothing. Correct note
  §R3.1's "two halves" model to three owners and add the reviewer's rows as
  differential cells. Parity, not a decision.
- **Notes:** name the `upsert`-with-relations `set`-beside-operator sentence
  in R-D2 (c); update §R3.8 item 4 to "measured and divergent" and record
  the scalar-only batch-publication gap (`Raptor 3 update expression
  publication requires an integer field` leaking to a caller) — repair it in
  the batch publication owner if it is the same family as your MySQL
  regression, else record it as a divergence for Arnaud with both answers
  pinned; route the three remaining inline "names a relation" spellings in
  `commands.ts` through `EngineSchema.namesRelation` or narrow the §R3.1
  sentence; add the §R3.3 pointer to the R-D1 row of the decision table.

## Validation

Re-run `g2-mysql-contracts` and `g2-mysql-baseline` on MySQL, `g2-pg-contracts`
and `g2-pg-baseline` on PostgreSQL (record port and container), the G3
suppression/transaction-array/bulk modes, `g3-execution-review`,
`g29-result-progress`, the unit02 author checks (physical envelope, packaged
array, prepared operation), `g4-read-contracts`, and the whole-estate
typecheck. Add a "Regression repair" section to `g4/unit02/note.md` with the
mechanism, the invariant, the falsifier and the receipts; regenerate
`production-phase2.patch` (or a third patch file) and recapture identity.

## Exit and return value

Structured summary: unit, summary, location, notePath, patchPath, repairs
(cell → mechanism → change → receipt), suites, native, typecheck, cost,
blockers, unverifiedClaims.
