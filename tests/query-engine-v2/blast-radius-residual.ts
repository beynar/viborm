/**
 * T3d — the FULL-ESTATE blast-radius residual (P6 Stage 0).
 *
 * The T3c conformance census reached ZERO (every nested-write-conformance scenario
 * runs natively on V2 fallback-off). T3c's full-estate blast-radius probe — the V1
 * fallback disabled globally, all ~7000 estate tests — then surfaced 83 failures:
 * the FINER boundaries reached only by NON-conformance estate tests. T3d absorbed
 * the two tractable, machinery-complete classes (83 → 43):
 *   · CLASS I  — `select`/`include` result-shaping on delete/update/upsert (the
 *                largest chunk: plain deletes, delete/update/upsert-with-include,
 *                and the staleness-injection suite, which does plain deletes);
 *   · CLASS VII — nested `createMany skipDuplicates` default-only PARITY refusal
 *                (V1's byte-identical `QueryEngineError` raised at construction).
 *
 * T4a then absorbed CLASS VI — deep create-context grandchildren (43 → 40): a `create`
 * under a PLANNED / create-context parent id (a parent-held to-one `update` target, an
 * upsert `update` arm, a root-`create` nested `createMany skipDuplicates`). Its FK carries
 * the captured parent id, one step past the literal-parent reach. That class is now EMPTY.
 *
 * The remaining 40 are the documented residual below. Each is EITHER (b) a test
 * that asserts/exercises the V1-FALLBACK ROUTE itself (it is rewritten when V1 is
 * deleted at P6 — it cannot pass with the fallback OFF by construction), OR a
 * boundary-stopped DECLINE SUBSYSTEM: an accept-and-execute shape V1 runs today
 * that V2 declines with an explicit `UnsupportedOperationError` because closing it
 * needs an unbuilt mechanism (an adapter batch reference store; V1's
 * referential-action legality engine; a deeper create-context id thread). These
 * are exactly the "category (iii) finer boundaries" the route-inventory scope note
 * enumerates — reached by no conformance scenario (the census is zero), reached
 * here only by targeted estate tests.
 *
 * The `scripts/blast-radius-gate.mjs` runner asserts the observed fallback-off
 * failure set equals this set EXACTLY (bidirectional): a NEW decline (a regression
 * that pushes a shape back behind the fallback) makes the observed set a superset
 * → RED; absorbing a listed class without deleting its entries here makes the
 * observed set a subset → RED. So the gate is the machine ledger P6 Stage 0 reads:
 * green iff the estate's only fallback-off failures are these enumerated,
 * design-noted boundaries. It shrinks toward EMPTY as the subsystems land.
 *
 * NOTE: the maintainer-authorized refusal (a) — `createManyAndReturn skipDuplicates`
 * on a non-returning driver — is NOT in this set: it is a construct-time refusal
 * asserted directly (many-and-return-refusal.test.ts), never routed through the
 * client, so it does not fail under the estate probe.
 */

/** (b) V1-fallback-route documentation tests. They assert a declined shape routes
 *  to V1 (`engine: "v1"`); with the fallback OFF that route re-throws by design.
 *  These are rewritten when the V1 runtime is deleted at P6 ("routes to V1" has no
 *  meaning without V1). They are not reachable accept-and-execute behavior — they
 *  are meta-tests OF the fallback seam the gate disables. */
export const BLAST_RADIUS_ROUTING_DOC: readonly string[] = [
  "tests/query-engine-v2/update-family.test.ts > query-engine-v2 per-tree routing > supported update routes to V2; unsupported nested-create routes to V1",
  "tests/query-engine-v2/upsert-family.test.ts > query-engine-v2 per-tree routing (upsert) > scalar upsert routes to V2; nested-arm upsert routes to V1",
  "tests/query-engine-v2/upsert-family.test.ts > query-engine-v2 per-tree routing (depth-2 to-one grandchild) > nested upsert whose update arm has a to-one connectOrCreate falls to V1",
];

/** CLASS III — batch generated/updated-PK dataflow. ABSORBED by T4b (blast radius 40 -> 18).
 *  A nested `create` whose FK references a parent primary key the SAME update TRANSITIONS
 *  (literal rename, `{ set }`, or portable arithmetic) needs the POST-transition id on the
 *  fresh INSERT. The reconciliation (docs/architecture/batch-primary-key-dataflow-plan.md,
 *  §T4b): the updated PK is NOT a runtime-deferred value on V2 — it is COMPILE-derived from
 *  the where-pinned pre-transition value by the SAME exact `getUpdatedPrimaryKeyValue`
 *  arithmetic (JS==SQL for portable int/bigint ops) the terminal read already trusts, so the
 *  child FK lowers to a construction LITERAL, and the INSERT is ordered AFTER the root UPDATE
 *  (`afterRootCreateParts` in UpdateOperation) — a NO-ACTION FK does not cascade, so the new
 *  parent row must exist first. No adapter batch-ref STORE is needed for the updated-PK class
 *  (the generated-PK class already uses `batchRefs.storeLastInsertId`, unchanged). Proven
 *  native fallback-off on every RETURNING-capable batch-only driver (SQLite3, LibSQL, PGlite,
 *  Postgres) plus SQLite3 transaction mode; the pre-transition value knowable only from the
 *  located row (a non-PK `where`), a compound key, or a non-portable op remains a documented
 *  narrower boundary that routes to V1. MySQL batch-only is a non-returning driver and refuses
 *  the whole single-row update/upsert refetch family before I/O (V1==V2 parity), so it carries
 *  these mutations in TRANSACTION mode only. This class is now EMPTY. */
export const BLAST_RADIUS_BATCH_PK_DATAFLOW: readonly string[] = [];

/** CLASS IV + V — the relation-key / referential-action legality engine (the
 *  subsystem the T3d mission pre-sanctioned as a boundary stop) plus its
 *  runtime-branch-gated companion. ABSORBED by T4c (blast radius 18 -> 3).
 *
 *  A root update/upsert that TRANSITIONS a referenced key while a nested write
 *  targets the relation on that key was V1's engine; V2 now reproduces its verdict
 *  natively, reusing V1's PURE-ANALYSIS legality functions wholesale as kept mass
 *  (visibility-only exports `assertRelationKeyUpdatesAreCompilable` /
 *  `assertUpdateManyRelationsAreCompilable`, byte-identical `NestedWriteError`
 *  messages) and executing every accepted shape on V2:
 *   · CLASS IV — a child-held (inverse one-to-one OR one-to-many) nested write under a
 *     referenced-PK transition. V1's occupied guard (`compileRelationKeyGuards`) is
 *     kind- AND cardinality-agnostic — it loops every non-M2M relation independent of
 *     the mutation planning — so the guard is emitted at the RELATION level
 *     (`interpretReferencedKeyTransition`, once per relation before the per-kind
 *     dispatch; T4c-fix generalized this from the original upsert-only wiring, which
 *     left update/delete/disconnect/create + the whole to-many family diverging
 *     accept-where-V1-rejects). Classified at compile from the where-pinned pre-value
 *     and `getUpdatedPrimaryKeyValue`: CASCADE keeps the ordinary correlated part (the
 *     DB re-points on `ON UPDATE CASCADE` + the root reorder); a NO-OP (`increment: 0`
 *     / `set` same, before == after) is byte-identical to a non-transition; a real
 *     NON-cascade transition of a single PK pinned by the unique `where` emits V1's
 *     occupied guard (ported to V2's guard/probe vocabulary — a tx-mode compile throw
 *     off the locked probe, a batch-mode raceable `notExists` guard pinning the
 *     empty-slot race). The correlated / literal-parent-create kinds
 *     (update/delete/disconnect/create/createMany) keep their ordinary part — their
 *     empty-slot behavior is already native; the to-one upsert reroutes its create arm
 *     to a POST-transition-FK leaf ordered after the root UPDATE (the T4b
 *     `afterRootCreateParts` machinery; the upsert update arm is unreachable). The
 *     nested-update recursion runs `assertRelationKeyUpdatesAreCompilable` at every
 *     child-part level; the top-level upsert's parent-held-to-one update arm plans its
 *     superset against an OPTIONAL-firstRowField locate (an absent create-arm parent
 *     resolves to `undefined`, never a planning abort) and rejects only when the found
 *     branch is taken (V1's whenTrue timing, the deferred `assertArmLegality`).
 *   · CLASS V — a nested relation write inside `updateMany` data rejects with V1's
 *     byte-identical message: immediate at construction for a plain update, deferred
 *     to the taken branch for an upsert update arm (runtime-branch-gated).
 *
 *  This class is now EMPTY. Narrower boundaries under such a transition still route to
 *  V1 (category-iii, reached by no estate test): an ADOPT kind (connect / connectOrCreate
 *  / set, and a to-many upsert) whose fresh FK would be written on the pre-transition
 *  value (its post-transition adopt is V1's, not built natively); and a `pastSurface`
 *  reference — compound, non-PK (the D4 case), or a pre-value the unique `where` does not
 *  pin — where only nested create/createMany proceed (their literal FK is threaded by
 *  `resolveLiteralCreateParent`) and every other kind routes to V1. */
export const BLAST_RADIUS_RELATION_KEY_LEGALITY: readonly string[] = [];

/** CLASS VI — deep create-context grandchildren. ABSORBED by T4a (blast radius 43 -> 40).
 *  A `create` nested under a target located by a PLANNED / create-context parent id — a
 *  parent-held to-one `update` whose target then creates a to-many child (key 1, its FK
 *  inlined from the located planning row at compile via `buildPlannedParentCreatePart`); an
 *  upsert `update` arm one level deeper that itself creates a grandchild correlated to the
 *  found row's literal PK (key 2, `RelationUpsertPart` accepts a child-held create on both
 *  arms); and a root-`create` nested `createMany skipDuplicates` whose FK refs the fresh
 *  parent's produced id (key 3, `CreateOperation.foldCreateMany` composes the skip leaf /
 *  recoverable `onUniqueConflict` effect). A `createMany` one step past the planned create
 *  leaf remains a documented finer boundary (measured-not-curated, reached by no estate
 *  scenario) that routes to V1. This class is now EMPTY. */
export const BLAST_RADIUS_DEEP_CREATE_CONTEXT: readonly string[] = [];

/** The full documented residual: the ONLY fallback-off estate failures P6 Stage 0
 *  tolerates. Everything else must be green with the V1 fallback disabled. */
export const BLAST_RADIUS_RESIDUAL: readonly string[] = [
  ...BLAST_RADIUS_ROUTING_DOC,
  ...BLAST_RADIUS_BATCH_PK_DATAFLOW,
  ...BLAST_RADIUS_RELATION_KEY_LEGALITY,
  ...BLAST_RADIUS_DEEP_CREATE_CONTEXT,
];
