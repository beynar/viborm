# The full gate on the release head — the retired engine's PGlite contract suites (triage note)

Integrator: Fable, 2026-09-19. The credential-free gate (`pnpm test:all`, what
CI runs) stops at its first red stage and had stopped before its
`extended-local shared-family` and `imported-pglite` stages on every head
since the engine cutover, so the retired engine's contract suites under
`tests/contracts/engine/{query,write}/` and `tests/contracts/public-client/`
(live PGlite, the shared model families) were never measured against the
shipped engine. The parity plan never named them. Measured on `7bc08ebd9`
(commit 16) one shard at a time (`inventory/`): **184 red cells in
41 files** (of 923 cells in those files).

## Method

Six read-only Sonnet classifiers at maximum effort, one per failure family
(`brief.md`; the family file lists `*.files`; the notes `<family>.md`), each
red cell into one class: **A** a physical-plan pin (re-express, naming the
ruling), **B** a registered Raptor 3 refusal replacing retired behavior
(ruled → re-express to the refusal; open → a ruling), **C** a defect in the
shipped engine (a unit), **D** the test's premise is gone (a retired
internal, a runner-only environment).

## Classification

| Family | A | B ruled | B open | C | D |
|---|---|---|---|---|---|
| atomic-output (9 files) | 0 | 0 | 28 | 4 | 0 |
| skip-duplicates-junction (6 files) | 0 | 12 | 0 | 23 | 0 |
| nested-conformance (8 files) | 0 | 0 | 0 | 37 | 0 |
| nested-write-misc (7 files, ~47 substrate legs unrun) | 0 | 1 | 0 | 18 | 9 |
| legality-and-client (6 files) | 0 | 3 | 0 | 8 | 0 |
| plans-and-tooling (5 files) | 26 | 0 | 0 | 2 | 2 |
| **total** | **26** | **16** | **28** | **92** | **11** |

The 28 open B cells are one refusal, "G1 atomic output requires exact
identity scratch or segmented RETURNING", escalated four times and never
ruled; Arnaud ruled D-50 on it the same evening (the CTE identity scratch,
commit 18): 26 of the 28 are green, the two others were masking class-C
defects that now surface (the M7 disjoint upsert guard, both modes).

## Per file

| File | red / cells | family |
|---|---|---|
| `tests/contracts/engine/query/m8-race-retry.test.ts` | 1 / 4 | nested-conformance |
| `tests/contracts/engine/query/nested-m2m-parent-pk-dataflow.test.ts` | 2 / 6 | nested-conformance |
| `tests/contracts/engine/query/nested-mutation-routing.test.ts` | 5 / 72 | atomic-output |
| `tests/contracts/engine/query/nested-write-conformance-fk.test.ts` | 1 / 28 | nested-conformance |
| `tests/contracts/engine/query/nested-write-conformance-m2m.test.ts` | 5 / 34 | nested-conformance |
| `tests/contracts/engine/query/nested-write-conformance-membership.test.ts` | 13 / 30 | nested-conformance |
| `tests/contracts/engine/query/nested-write-conformance-root-dependency.test.ts` | 6 / 30 | nested-conformance |
| `tests/contracts/engine/query/nested-write-conformance-to-one.test.ts` | 3 / 19 | nested-conformance |
| `tests/contracts/engine/query/nested-write-conformance-transitive.test.ts` | 6 / 31 | nested-conformance |
| `tests/contracts/engine/query/relation-key-update-legality-occupied-to-many.test.ts` | 2 / 6 | legality-and-client |
| `tests/contracts/engine/query/relation-key-update-legality-occupied-to-one.test.ts` | 4 / 7 | legality-and-client |
| `tests/contracts/engine/query/relation-key-update-legality-referenced-column.test.ts` | 1 / 4 | legality-and-client |
| `tests/contracts/engine/query/relation-key-update-legality-transition-arm.test.ts` | 1 / 7 | legality-and-client |
| `tests/contracts/engine/query/starts-with-prefix-plan.test.ts` | 5 / 14 | plans-and-tooling |
| `tests/contracts/engine/write/combined-depth-stress.test.ts` | 1 / 2 | skip-duplicates-junction |
| `tests/contracts/engine/write/compound-junction.test.ts` | 5 / 24 | skip-duplicates-junction |
| `tests/contracts/engine/write/compound-relation-adoption.test.ts` | 1 / 4 | atomic-output |
| `tests/contracts/engine/write/create-junction-upsert.test.ts` | 12 / 26 | atomic-output |
| `tests/contracts/engine/write/create-many-skip-depth.test.ts` | 2 / 6 | skip-duplicates-junction |
| `tests/contracts/engine/write/fresh-create-subtree.test.ts` | 2 / 4 | atomic-output |
| `tests/contracts/engine/write/generated-output-fallback.test.ts` | 2 / 5 | atomic-output |
| `tests/contracts/engine/write/inverse-to-one-update-depth.test.ts` | 2 / 33 | nested-write-misc |
| `tests/contracts/engine/write/junction-create-many-routing.test.ts` | 4 / 9 | skip-duplicates-junction |
| `tests/contracts/engine/write/junction-produced-identity.test.ts` | 6 / 12 | atomic-output |
| `tests/contracts/engine/write/junction-upsert-arm-probe.test.ts` | 1 / 10 | atomic-output |
| `tests/contracts/engine/write/located-target-depth.test.ts` | 2 / 8 | atomic-output |
| `tests/contracts/engine/write/mutation-projection-cte-fold.test.ts` | 16 / 40 | plans-and-tooling |
| `tests/contracts/engine/write/nested-create-context-grandchild.test.ts` | 1 / 3 | skip-duplicates-junction |
| `tests/contracts/engine/write/nested-error-attribution.test.ts` | 1 / 6 | nested-write-misc |
| `tests/contracts/engine/write/nested-semantic-stability.test.ts` | 2 / 3 | nested-write-misc |
| `tests/contracts/engine/write/parent-held-compound-edge.test.ts` | 2 / 16 | nested-write-misc |
| `tests/contracts/engine/write/parent-held-lookup.test.ts` | 11 / 56 | nested-write-misc |
| `tests/contracts/engine/write/polymorphic-collection-write-family.test.ts` | 22 / 88 | skip-duplicates-junction |
| `tests/contracts/engine/write/progressive-parent-rowkey.test.ts` | 7 / 9 | plans-and-tooling |
| `tests/contracts/engine/write/shared-pk-update-root.test.ts` | 16 / 71 | nested-write-misc |
| `tests/contracts/engine/write/supplier-continuation.test.ts` | 4 / 21 | nested-write-misc |
| `tests/contracts/engine/write/type-depth-ceiling.test.ts` | 1 / 2 | atomic-output |
| `tests/contracts/public-client/batch-transaction.test.ts` | 3 / 70 | legality-and-client |
| `tests/contracts/public-client/operations.test.ts` | 1 / 101 | legality-and-client |
| `tests/raptor3/core-structure/measurement/cs02-structure-measure.test.ts` | 1 / 1 | plans-and-tooling |
| `tests/unit/instrumentation/namespace-attribute-segment.test.ts` | 1 / 1 | plans-and-tooling |

## What follows (units and rulings, in the ledger)

- **A (26):** `mutation-projection-cte-fold` pins the retired engine's CTE fold
  (Raptor 3 ports only the scalar RETURNING fold, D-15 deleted the CTE
  machinery; the semantic answers pass); `progressive-parent-rowkey` and
  `starts-with-prefix-plan` hardcode the retired alias `t0` where the shipped
  root alias is `q0` (protocol §7.2). Re-expressions with those rulings.
- **B ruled (16):** the member-rollback refusal of borrowed `createMany
  skipDuplicates` on the atomic-batch leg (G3P-04, 8), the atomic-output
  refusal's now-closed cells (4), the D-46 unbatchable relation-bearing update
  on the array route (3), the `batchPrimaryKeyDataflowContract` cell reached
  through PGlite (1, closed by D-50). Re-expressions to the refusals.
- **C (92), six mechanisms:** the nested-write dependency pass (four
  competing refusals with no ordering, false positives and negatives, tx/batch
  parity breaks — 30 cells); `disconnect: true` / `delete: true` on a to-one
  edge rejecting where DESIGN §5.3 pins a no-op (3 + polymorphic cells); the
  membership race recovery never dispatched in `recover()` (4); the batch
  attribution losing typed errors to a raw `QueryError` (6); `adoptSuppressed`
  conflating "own key spelled" with "row exists" (foreign-key violations, 3);
  the shared-primary-key root transition addressing the pre-transition key
  (6); plus the M7 disjoint upsert guard, the skipDuplicates adopt shape, the
  SQLite nested-connect "known" value, the parent-row-changed guard for one
  schema shape, `updateMany` no longer refusing a child-held connect across
  two matched rows, and the polymorphic singular-collection inverse block (10).
- **D (11):** pinned wording or internals of the retired engine
  (`OwnWritePreflight`, `UpdateOperation.interpretRelation`, …); the CS-02
  structure measure listed runner-only by the raptor3 manifest but swept into
  an extended-local shard by the credential-free manifest; one instrumentation
  attribute of the retired engine.

Nothing is waived: an open C stays red until a unit or Arnaud's ruling closes
it, and the gate stays red until then.
