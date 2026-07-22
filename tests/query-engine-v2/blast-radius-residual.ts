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

/** CLASS III — batch generated/updated-PK dataflow. A nested `create` whose FK
 *  references a parent primary key the SAME batch update transitions (literal
 *  rename, `set`, or portable arithmetic) needs the produced/updated id THREADED
 *  to the fresh INSERT inside one prebuilt atomic batch. SQLite/D1 cannot use
 *  `INSERT … RETURNING` as a CTE source and `last_insert_rowid()` is volatile, so
 *  this needs an internal adapter-owned batch reference store
 *  (docs/architecture/batch-primary-key-dataflow-plan.md) that does not yet exist.
 *  V2 fails closed at construction; V1 executes it. The one transaction-mode case
 *  (sqlite3 "divides an integer PK") declines from the same construction guard. */
export const BLAST_RADIUS_BATCH_PK_DATAFLOW: readonly string[] = [
  "tests/drivers/pglite.test.ts > PGlite Driver > PGlite batch-only batch primary-key dataflow > top-level update changes PK with direct literal and nested create uses it",
  "tests/drivers/pglite.test.ts > PGlite Driver > PGlite batch-only batch primary-key dataflow > top-level update changes PK with set operation and nested create uses it",
  "tests/drivers/pglite.test.ts > PGlite Driver > PGlite batch-only batch primary-key dataflow > top-level update changes numeric PK with decrement and nested create uses it",
  "tests/drivers/pglite.test.ts > PGlite Driver > PGlite batch-only batch primary-key dataflow > top-level update changes numeric PK with divide and nested create uses it",
  "tests/drivers/pglite.test.ts > PGlite Driver > PGlite batch-only batch primary-key dataflow > top-level update changes numeric PK with increment and nested create uses it",
  "tests/drivers/pglite.test.ts > PGlite Driver > PGlite batch-only batch primary-key dataflow > top-level update changes numeric PK with multiply and nested create uses it",
  "tests/drivers/pglite.test.ts > PGlite Driver > PGlite batch-only batch primary-key dataflow > top-level upsert update branch changes PK before nested create",
  "tests/drivers/sqlite3.test.ts > SQLite3 Driver > SQLite3 batch-only batch primary-key dataflow > top-level update changes PK with direct literal and nested create uses it",
  "tests/drivers/sqlite3.test.ts > SQLite3 Driver > SQLite3 batch-only batch primary-key dataflow > top-level update changes PK with set operation and nested create uses it",
  "tests/drivers/sqlite3.test.ts > SQLite3 Driver > SQLite3 batch-only batch primary-key dataflow > top-level update changes numeric PK with decrement and nested create uses it",
  "tests/drivers/sqlite3.test.ts > SQLite3 Driver > SQLite3 batch-only batch primary-key dataflow > top-level update changes numeric PK with divide and nested create uses it",
  "tests/drivers/sqlite3.test.ts > SQLite3 Driver > SQLite3 batch-only batch primary-key dataflow > top-level update changes numeric PK with increment and nested create uses it",
  "tests/drivers/sqlite3.test.ts > SQLite3 Driver > SQLite3 batch-only batch primary-key dataflow > top-level update changes numeric PK with multiply and nested create uses it",
  "tests/drivers/sqlite3.test.ts > SQLite3 Driver > SQLite3 batch-only batch primary-key dataflow > top-level upsert update branch changes PK before nested create",
  "tests/drivers/sqlite3.test.ts > SQLite3 Driver > transactional nested update divides an integer PK and propagates it",
  "tests/query-engine/nested-mutation-routing.test.ts > Nested Mutation Routing > PGlite batch-only routing batch primary-key dataflow > top-level update changes PK with direct literal and nested create uses it",
  "tests/query-engine/nested-mutation-routing.test.ts > Nested Mutation Routing > PGlite batch-only routing batch primary-key dataflow > top-level update changes PK with set operation and nested create uses it",
  "tests/query-engine/nested-mutation-routing.test.ts > Nested Mutation Routing > PGlite batch-only routing batch primary-key dataflow > top-level update changes numeric PK with decrement and nested create uses it",
  "tests/query-engine/nested-mutation-routing.test.ts > Nested Mutation Routing > PGlite batch-only routing batch primary-key dataflow > top-level update changes numeric PK with divide and nested create uses it",
  "tests/query-engine/nested-mutation-routing.test.ts > Nested Mutation Routing > PGlite batch-only routing batch primary-key dataflow > top-level update changes numeric PK with increment and nested create uses it",
  "tests/query-engine/nested-mutation-routing.test.ts > Nested Mutation Routing > PGlite batch-only routing batch primary-key dataflow > top-level update changes numeric PK with multiply and nested create uses it",
  "tests/query-engine/nested-mutation-routing.test.ts > Nested Mutation Routing > PGlite batch-only routing batch primary-key dataflow > top-level upsert update branch changes PK before nested create",
];

/** CLASS IV + V — the relation-key / referential-action legality engine (the
 *  subsystem the T3d mission pre-sanctions as a boundary stop) plus its
 *  runtime-branch-gated companion. A root update/upsert that TRANSITIONS a
 *  referenced key (PK arithmetic, an FK-referenced column rewrite) while a nested
 *  write targets the relation on that key needs V1's engine: occupied-slot
 *  detection, the cascade / setNull / restrict staged re-point, no-op-transition
 *  detection (`set` same / `increment: 0`), an empty-slot race pin, and — for the
 *  top-level upsert — validating ONLY the branch the existence probe takes (an
 *  invalid UNTAKEN update branch must not reject). CLASS V is the same
 *  runtime-branch-gating over an `updateMany` whose data carries nested relation
 *  writes (V1's `NestedWriteError`), taken only when the update branch runs. V2
 *  declines the whole shape to V1 with an explicit `UnsupportedOperationError`. */
export const BLAST_RADIUS_RELATION_KEY_LEGALITY: readonly string[] = [
  "tests/query-engine/relation-key-update-legality.test.ts > relation-key update legality > allows a restrict key transition when the old slot is empty",
  "tests/query-engine/relation-key-update-legality.test.ts > relation-key update legality > allows a setNull key transition when the old slot is empty",
  "tests/query-engine/relation-key-update-legality.test.ts > relation-key update legality > allows increment zero on an occupied setNull relation",
  "tests/query-engine/relation-key-update-legality.test.ts > relation-key update legality > allows primary-key arithmetic transition with cascade upsert",
  "tests/query-engine/relation-key-update-legality.test.ts > relation-key update legality > allows same-value set on an occupied setNull relation",
  "tests/query-engine/relation-key-update-legality.test.ts > relation-key update legality > does not validate an untaken top-level upsert update branch",
  "tests/query-engine/relation-key-update-legality.test.ts > relation-key update legality > pins an empty setNull slot until the parent update executes",
  "tests/query-engine/relation-key-update-legality.test.ts > relation-key update legality > recurses into nested update data before outer effects",
  "tests/query-engine/relation-key-update-legality.test.ts > relation-key update legality > rejects non-cascade child-holds key transition with nested upsert",
  "tests/query-engine/relation-key-update-legality.test.ts > relation-key update legality > validates the taken top-level upsert update branch",
  "tests/query-engine/legality-gate.test.ts > M2 legality gate > upsert branch validation stays runtime-branch-gated > batch mode: existing target rejects the taken update branch, same message",
  "tests/query-engine/legality-gate.test.ts > M2 legality gate > upsert branch validation stays runtime-branch-gated > batch mode: missing target with invalid update branch succeeds",
  "tests/query-engine/legality-gate.test.ts > M2 legality gate > upsert branch validation stays runtime-branch-gated > transaction mode: existing target rejects the taken update branch",
  "tests/query-engine/legality-gate.test.ts > M2 legality gate > upsert branch validation stays runtime-branch-gated > transaction mode: missing target with invalid update branch succeeds",
  "tests/query-engine/nested-mutation-routing.test.ts > Nested Mutation Routing > nested relation writes inside updateMany data fail closed",
];

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
