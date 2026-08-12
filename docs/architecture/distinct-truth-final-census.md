# Distinct-truth compression — final census

**Plan:** [`query-engine-distinct-truth-compression-plan.md`](./query-engine-distinct-truth-compression-plan.md)
· **Phases run:** 0–10, 12 (Phase 10 REJECTED at its own gate; Phase 11 was
conditional on a retained Phase 10 and did not run)
· **Guard record:** [`guard-ownership-ledger.md`](./guard-ownership-ledger.md)
· **Starting audit:** [`engine-compression-audit.md`](./engine-compression-audit.md)

The rule the plan ends on: **one stored topology, several derived views.**

Live measurements below were filled by the coordinator from its own runs;
nothing in this document is a number the sweep phase measured itself.

---

## 1. Size

| Measure | Phase 0 baseline | HEAD |
| --- | --- | --- |
| Physical TypeScript lines (query engine) | 42,281 | 42,264 (−17) |
| Token-bearing lines (query engine) | 31,299 | 30,835 (−464) |

The Phase 0 figures are the ones the plan recorded for the end of the previous
lift (39,022 → 42,281 physical, 30,196 → 31,299 token-bearing, of which roughly
2,156 of the 3,259 added physical lines were comments or spacing). They are a
baseline, not a quota.

Two deliberate additions to the ending physical count, both recorded rather than
netted out: Phase 12's comment sweep REPLACED task labels with surviving reasons
instead of deleting the sentences that carried them, and the two proof-history
blocks it removed from `src/` were moved into the guard ledger, not discarded.

## 2. Named concepts deleted

Each of these was a distinct named thing — a type, an exported helper, a stored
field, a dispatch arm family, or a channel — and none of them exists at HEAD.
Verified by name search over `src/` at this phase.

**Identity and inverse resolution**

- `getCanonicalIdentityFields` and its family (only a comment naming the deleted
  function survives, at `operations/cursor-order.ts`);
- `findInverseRelationState` — inverse candidate discovery has ONE resolver,
  `@schema/relation/inverse`, with `bindRelation` as its query-time consumer;
- `assertEqualArity`.

**Many-to-many topology**

- `ManyToManyJoinInfo` and its getter `getManyToManyJoinInfo`;
- `bindJunctionRelation`'s second EXPORTED entry point (the function survives,
  private, reachable only through the one classifier);
- `buildCorrelation`'s junction refusal;
- `buildFkColumns`' own holder test — the function survives, but "does the parent
  row hold the membership" is now the bound value's `position` rather than a
  fourth reading of `relationInfo.fields`.

**Derived relation views that used to be stored**

- `isToOne` / `isToMany` as stored relation-state properties — cardinality is
  DERIVED by `relationCardinality` and, where a local boolean reads better, spelled
  as a local `const` over that one call;
- `inverseMembershipCanBeCleared` and family — clearability has one owner,
  `@schema/relation/clearability`, with its type twin beside it;
- the four inline cardinality spellings that predated `relationCardinality`.

**Polymorphic parallel structure**

- `ParsedRecordPrograms.polymorphic` and `ResolvedPolymorphicMutation`;
- `interpretPolymorphicChildHeld`, `interpretToManyKind`,
  `interpretInverseToOneKind`, `interpretInverseToOneComposition`;
- `getInverseMutationSchemas` and the `PolymorphicInverse*` schema family;
- the `polymorphic-*` arm families in the record compilers;
- the `ChildConnectConfig` CROSS-PRODUCT — the config type survives, but its
  ordinary/polymorphic variants do not: the membership rides as the assignment
  the child's UPDATE makes.

**Write-engine plumbing**

- `PostTransitionAdopt`;
- the membership scope override channel;
- `ExclusiveMutation`;
- `PendingOperationV2`;
- the executor's `prepareBatch`;
- `setupQueries` / `cleanupQueries`;
- `RecordSeriesOperation.mode`;
- `PlanningFragment.outputs` — planning has no explicit outputs map to
  under-publish through; the steps ARE the declaration;
- `processRelationOperations`;
- `assertPinnedTransitionIsCompilable` (Phase 12; the argument is in the ledger);
- `capturedTargetConstraint` (Phase 12; likewise);
- three dead cardinality refusals and one dead junction refusal (Phase 12).

**Names that stopped being cross-products**

- `interpretParentHeldToOne` → `interpretParentHeld`;
- the `BoundRelation.kind` cross-product enumeration → three orthogonal axes.

## 3. Owner counts

Stated honestly, including where more than one owner survives and why.

| Question | Owners at HEAD | Note |
| --- | --- | --- |
| Inverse relation resolution | **1** | `@schema/relation/inverse` |
| Many-to-many topology | **1** | the junction bind, reached only through `classifyRelation` |
| Planning publication | **1**, derived | `derivePlanningKnown` — nothing declares it |
| Read-side physical traversal | **1** | `builders/relation-traversal.ts` |
| Statement-reference discovery | **1** | `OperationFragment.statementReferences` |
| Relation cardinality | **1** | `@schema/relation/cardinality` |
| Relation clearability | **2 by design** | public optionality and physical storage are two facts; the ledger's Phase 8 stage 2 addendum records the three coverages that keep them apart |
| Foreign/referenced member pairing | **1** | `membership.members`, lazy, because it owns a refusal |
| Result / projection traversal | **2 traversals, 5 owners** | see below |
| Record-series derived owners | derived, not stored | the series contract plus two shells; a member is an ordinary single-record operation |
| Write-engine runtime cycles | **0** | the recursion seam is an erased type import |

**The result/projection count, stated without rounding.** There are 2 traversals
and 5 retained owners with documented, distinct responsibilities. Phase 10
proposed compiling one selection fact for all of them; the prototype was built in
its only byte-safe form, measured (SQL bytes exact, parsing exact, CTE eligibility
unchanged, tsc within budget, e2e overhead 6–9% worse on findUnique/include/create,
physical LOC +101) and REJECTED at its gate. The two pre-SQL predicates now carry
the structural reason they cannot consume a compiled fact. This is not a target
missed; it is a target measured and declined.

## 4. Refusals and invariants

| Scope | `UnsupportedOperationError` construction sites | Distinct invariants |
| --- | --- | --- |
| write-engine | **14** | **10** |
| whole `src` (classified in the inventory test) | **18** coordinates, 17 owner declarations | 14 |

No distinct invariant was retired by any distinct-truth phase. Phase 12's four
code deletions removed refusals whose owner became a TYPE (a two-value union, and
a narrowed parameter), not invariants: the states they named are unconstructible.

The write-engine site count moved 15 → 14 across the plan. The classification
coordinates are re-resolved on every run by
`operation-construction-inventory.test.ts` ("every classified coordinate still
resolves"), which is what keeps this table from decaying into narrative.

## 5. Live measurements — TBD slots for the coordinator

| Measure | Value |
| --- | --- |
| Physical / token-bearing production LOC at HEAD | query engine 42,264 / 30,835 (Phase 0: 42,281 / 31,299 — net −17 physical, −464 token); write engine 23,511 / 16,588 (Phase 0: 23,841 / 17,013); functions 1,578 (Phase 0: 1,572); one runtime import-cycle component of 11 builder files (Phase 0: 6 — the growth is Phase 7's traversal module joining the pre-existing component, recorded there); write-engine cycles 0 |
| Relation topology branch delta vs Phase 0 | branchNodes 3,532 (Phase 0: 3,658 — net −126) |
| `pnpm test:types` median | 16.89 s warm (16.82 / 16.89 / 17.02), quiet box — vs the lift A1 quiet median 16.71 s (+1.1%) and the Phase 0 loaded-box 22.49 s |
| Full suite: tests passed / files | `pnpm test`: 5,092 passed / 221 files. `coverage-write-engine` (fold + parity + census suites, NOT in `pnpm test`): 3,145 passed / 354 skipped / 173 files. Coverage gates: validation 100/100/100/100, relations 100/100/100/100. `pnpm build`: clean |
| Provider suites run | pglite 774 · sqlite3 1,169 · libsql 1,117 · pg (Docker) 874 · postgres (Docker) 294 · transaction-options (Docker) 2 · mysql2 (Docker) 1,065 · bun 2 · D1 3 — all passed; per-suite single-digit skips are their own env-conditional cases |
| Provider suites SKIPPED | neon-http and planetscale (hosted credentials absent) — SKIPPED, not passed |
| `operation-construction-inventory.test.ts` coordinate table | re-anchored by the coordinator for Phase 12's 11 shifted rows; 7/7 census assertions green at HEAD (14 write-engine sites, 18 classified, 10 invariants) |

The D1 count is a post-plan repair. The original final gate correctly recorded
that `@paralleldrive/cuid2@3.0.4` initialized randomness at module scope and
therefore failed Workerd collection. Upgrading to 3.3.0 uses the package's lazy
`createId` initialization. The provider suite now pins
both safe module collection and request-context CUID generation. This repair
changes no query-engine production code or census value.

## 6. What the plan did not do

It proposed no mutation DSL, payload walker, branch-step IR, universal locator,
adopt strategy, operation base class, lifecycle callback, junction placement flag
or shared utility landfill — the shapes the compression audit had already
rejected. It changed no public API, result type, SQL byte, parameter, step
allocation, execution order, guard, race pin, error sentence or transaction
behavior.

Comment-sweep kept classes (deliberate, not misses): `CLASS I–V` transition-
provenance taxonomy; JT001–JT004 rule codes; Cloudflare `D1`; normative `plan §`/
ATOM § citations; query-performance-plan phase cites; and the bare expressible-
shapes wave labels (`E1 —`, `E1 U1/U2/U3`, `E3 —`, `W4`) at ~17 sites — the same
taxonomy family as CLASS IV, kept as stable cross-doc addresses rather than
provenance narration.
