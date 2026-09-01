/**
 * Explicit, provider-free query coverage admission.
 *
 * A recursive core-test glob can silently admit a future PGlite or native
 * provider fixture. Keep this list literal: adding a deterministic contract is
 * a deliberate matrix change, and the manifest audit rejects unassigned files.
 */
export const QUERY_ENGINE_CORE_TESTS = Object.freeze([
  "tests/contracts/architecture/contract-matrix.core.test.ts",
  "tests/contracts/architecture/core-taxonomy-census.core.test.ts",
  "tests/contracts/architecture/typecheck-partition-census.core.test.ts",
  "tests/contracts/architecture/extension-system-census.core.test.ts",
  "tests/contracts/architecture/geopoint-language-census.core.test.ts",
  "tests/contracts/architecture/system-clock.core.test.ts",
  "tests/contracts/engine/query/batch-attribution-hazard-signature.core.test.ts",
  "tests/contracts/engine/query/bind-budget.core.test.ts",
  "tests/contracts/engine/query/blob-result-parser.core.test.ts",
  "tests/contracts/engine/query/bound-relation.core.test.ts",
  "tests/contracts/engine/query/bulk-create-plan.core.test.ts",
  "tests/contracts/engine/query/bulk-insert-row-shapes.core.test.ts",
  "tests/contracts/engine/query/cache-result-codec-boundaries.core.test.ts",
  "tests/contracts/engine/query/cache-result-codec.core.test.ts",
  "tests/contracts/engine/query/consumable-result-rows.core.test.ts",
  "tests/contracts/engine/query/count-result-carrier.core.test.ts",
  "tests/contracts/engine/query/cursor-pagination-sql.core.test.ts",
  "tests/contracts/engine/query/cursor-order-normalization-boundaries.core.test.ts",
  "tests/contracts/engine/query/decimal-cache-identity.core.test.ts",
  "tests/contracts/engine/query/decimal-capture-materialization.core.test.ts",
  "tests/contracts/engine/query/decimal-having-operand-sql.core.test.ts",
  "tests/contracts/engine/query/decimal-list-container.core.test.ts",
  "tests/contracts/engine/query/decimal-relation-key-write.core.test.ts",
  "tests/contracts/engine/query/default-insert-sql.core.test.ts",
  "tests/contracts/engine/query/field-reference-sql.core.test.ts",
  "tests/contracts/engine/query/for-update-dialects.core.test.ts",
  "tests/contracts/engine/query/geopoint-sql.core.test.ts",
  "tests/contracts/engine/query/json-null-sentinel-sql.core.test.ts",
  "tests/contracts/engine/query/junction-conflict-target.core.test.ts",
  "tests/contracts/engine/query/junction-statements.core.test.ts",
  "tests/contracts/engine/query/junction-topology-order.core.test.ts",
  "tests/contracts/engine/query/lateral-joins.core.test.ts",
  "tests/contracts/engine/query/list-update-container.core.test.ts",
  "tests/contracts/engine/query/model-key-catalog.core.test.ts",
  "tests/contracts/engine/query/mutation-operation-boundaries.core.test.ts",
  "tests/contracts/engine/query/namespace-qualification.core.test.ts",
  "tests/contracts/engine/query/nested-captured-target-signature.core.test.ts",
  "tests/contracts/engine/query/nested-writes.core.test.ts",
  "tests/contracts/engine/query/operand-callback-sql.core.test.ts",
  "tests/contracts/engine/query/operation-equivalence-oracles.core.test.ts",
  "tests/contracts/engine/query/operation-program-read-contracts.core.test.ts",
  "tests/contracts/engine/query/orderby-relation-depth.core.test.ts",
  "tests/contracts/engine/query/own-write-dependency.core.test.ts",
  "tests/contracts/engine/query/own-write-ledger.core.test.ts",
  "tests/contracts/engine/query/own-write-target.core.test.ts",
  "tests/contracts/engine/query/pending-operation-contracts.core.test.ts",
  "tests/contracts/engine/query/polymorphic-collection-bind.core.test.ts",
  "tests/contracts/engine/query/polymorphic-inverse-read-sql.core.test.ts",
  "tests/contracts/engine/query/polymorphic-read-sql.core.test.ts",
  "tests/contracts/engine/query/polymorphic-row-mutation-intents.core.test.ts",
  "tests/contracts/engine/query/polymorphic-result-parser.core.test.ts",
  "tests/contracts/engine/query/polymorphic-storage-grouping.core.test.ts",
  "tests/contracts/engine/query/query-builder-coverage-boundaries.core.test.ts",
  "tests/contracts/engine/query/query-core-coverage-boundaries.core.test.ts",
  "tests/contracts/engine/query/query-engine-boundaries.core.test.ts",
  "tests/contracts/engine/query/query-inspection.core.test.ts",
  "tests/contracts/engine/query/query-operation-coverage-boundaries.core.test.ts",
  "tests/contracts/engine/query/query-relation-coverage-boundaries.core.test.ts",
  "tests/contracts/engine/query/query-result-coverage-boundaries.core.test.ts",
  "tests/contracts/engine/query/read-traversal-byte-pins.core.test.ts",
  "tests/contracts/engine/query/relation-key-legality.core.test.ts",
  "tests/contracts/engine/query/relation-filter-nullability-planning.core.test.ts",
  "tests/contracts/engine/query/relation-mutation-program.core.test.ts",
  "tests/contracts/engine/query/relation-nullability-parity.core.test.ts",
  "tests/contracts/engine/query/request-result-shape-contracts.core.test.ts",
  "tests/contracts/engine/query/result-aliases.core.test.ts",
  "tests/contracts/engine/query/result-identity-fast-path.core.test.ts",
  "tests/contracts/engine/query/result-parser-architecture-gates.core.test.ts",
  "tests/contracts/engine/query/result-parser-contracts.core.test.ts",
  "tests/contracts/engine/query/scalar-result-contracts.core.test.ts",
  "tests/contracts/engine/query/select-builder-boundaries.core.test.ts",
  "tests/contracts/engine/query/select-mode-capability-matrix.core.test.ts",
  "tests/contracts/engine/query/sql-generation.core.test.ts",
  "tests/contracts/engine/query/starts-with-prefix-sql.core.test.ts",
  "tests/contracts/engine/query/target-constraint.core.test.ts",
  "tests/contracts/engine/query/target-predicate-footprint.core.test.ts",
  "tests/contracts/engine/query/vector-distance-result-parser.core.test.ts",
  "tests/contracts/engine/query/vector-orderby.core.test.ts",
]);

/**
 * The write estate's core admission, shared by two lanes.
 *
 * `layer-write-engine` executes it (so `pnpm test:core` and `pnpm test:all` do
 * too) and `coverage-write-engine-core` measures it. The order below is load
 * bearing: {@link WRITE_ENGINE_COVERAGE_TEST_GROUPS} slices this array into the
 * coverage workers' memory groups, so a reordering silently re-partitions them.
 * Append, do not rearrange.
 */
export const WRITE_ENGINE_CORE_TESTS = Object.freeze([
  "tests/contracts/engine/query/nested-create-many.core.test.ts",
  "tests/contracts/engine/write/architecture-gates.core.test.ts",
  "tests/contracts/engine/write/atomic-unit-batch.core.test.ts",
  "tests/contracts/engine/write/bulk-polymorphic-connect-contracts.core.test.ts",
  "tests/contracts/engine/write/bulk-write-limit-plan.core.test.ts",
  "tests/contracts/engine/write/captured-row-key-decode.core.test.ts",
  "tests/contracts/engine/write/compound-relation-adoption.core.test.ts",
  "tests/contracts/engine/write/create-junction-upsert.core.test.ts",
  "tests/contracts/engine/write/create-many-bind-budget.core.test.ts",
  "tests/contracts/engine/write/create-many-return-fold.core.test.ts",
  "tests/contracts/engine/write/create-race-pin.core.test.ts",
  "tests/contracts/engine/write/dead-symbol-gate.core.test.ts",
  "tests/contracts/engine/write/destination-cast.core.test.ts",
  "tests/contracts/engine/write/final-root-assignment.core.test.ts",
  "tests/contracts/engine/write/fragment-validator.core.test.ts",
  "tests/contracts/engine/write/generated-identity-demand.core.test.ts",
  "tests/contracts/engine/write/generated-output-boundary.core.test.ts",
  "tests/contracts/engine/write/generated-output-segment-contract.core.test.ts",
  "tests/contracts/engine/write/implicit-returning-refusal.core.test.ts",
  "tests/contracts/engine/write/inverse-to-one-create.core.test.ts",
  "tests/contracts/engine/write/junction-produced-identity.core.test.ts",
  "tests/contracts/engine/write/junction-upsert-arm-probe.core.test.ts",
  "tests/contracts/engine/write/namespace-write-qualification.core.test.ts",
  "tests/contracts/engine/write/nested-series-coverage.core.test.ts",
  "tests/contracts/engine/write/non-returning-delete-plan.core.test.ts",
  "tests/contracts/engine/write/operation-construction-inventory.core.test.ts",
  "tests/contracts/engine/write/operation-construction-witnesses.core.test.ts",
  "tests/contracts/engine/write/operation-executor-scenarios.core.test.ts",
  "tests/contracts/engine/write/operation-owner-coverage.core.test.ts",
  "tests/contracts/engine/write/own-write-linearization.core.test.ts",
  "tests/contracts/engine/write/parity-b-upsert-arm.core.test.ts",
  "tests/contracts/engine/write/parity-c-selected-identity.core.test.ts",
  "tests/contracts/engine/write/parity-d-transition.core.test.ts",
  "tests/contracts/engine/write/parity-e-shared-pk.core.test.ts",
  "tests/contracts/engine/write/parity-f-fresh-field.core.test.ts",
  "tests/contracts/engine/write/parity-h-to-one-lattice.core.test.ts",
  "tests/contracts/engine/write/parity-j-create-many.core.test.ts",
  "tests/contracts/engine/write/parity-k-update-many.core.test.ts",
  "tests/contracts/engine/write/parity-m-create-dag.core.test.ts",
  "tests/contracts/engine/write/parse-boundary-gate.core.test.ts",
  "tests/contracts/engine/write/polymorphic-write-plan.core.test.ts",
  "tests/contracts/engine/write/race-retry-classification.core.test.ts",
  "tests/contracts/engine/write/record-compiler-contract.core.test.ts",
  "tests/contracts/engine/write/record-series-coverage.core.test.ts",
  "tests/contracts/engine/write/relation-junction-collection-coverage.core.test.ts",
  "tests/contracts/engine/write/relation-junction-singular-coverage.core.test.ts",
  "tests/contracts/engine/write/relation-membership-contracts.core.test.ts",
  "tests/contracts/engine/write/relation-mutation-scenario-matrix.core.test.ts",
  "tests/contracts/engine/write/relation-record-compiler-coverage.core.test.ts",
  "tests/contracts/engine/write/relation-target-coverage.core.test.ts",
  "tests/contracts/engine/write/relation-write-parity-anchors.core.test.ts",
  "tests/contracts/engine/write/series-result-read.core.test.ts",
  "tests/contracts/engine/write/target-projection.core.test.ts",
  "tests/contracts/engine/write/unique-where-relation-filter-plan.core.test.ts",
  "tests/contracts/engine/write/upsert-planning-scenarios.core.test.ts",
  "tests/contracts/engine/write/write-shared-coverage.core.test.ts",
]);

export const WRITE_ENGINE_EXTENDED_COVERAGE_TESTS = Object.freeze([
  "tests/contracts/engine/write/neon-committed-segments-capability.test.ts",
]);

/**
 * Provider-free focused coverage.
 *
 * A non-core write contract is admitted only when its complete local import
 * graph is deterministic and owns no provider resource. A `-docker` suite, or
 * any suite that reaches PGlite, SQLite3, LibSQL, `better-sqlite3`, live-schema
 * synchronization, provider lifecycle, network, or credentials is excluded as
 * one whole module. This also excludes mixed modules that contain useful probe
 * cases: Vitest imports and registers the whole file, not selected cases.
 *
 * The Neon contract is the audited exception: it replaces the provider module
 * with a hoisted in-process fake before constructing its driver, so it owns no
 * network or provider resource. Exhaustive provider combinations remain in
 * test:all and do not inflate the diagnostic coverage lane.
 */
export const WRITE_ENGINE_COVERAGE_TESTS = Object.freeze([
  ...WRITE_ENGINE_CORE_TESTS,
  ...WRITE_ENGINE_EXTENDED_COVERAGE_TESTS,
]);

/**
 * Keep each coverage worker far below the 1536 MiB process ceiling. The core
 * slices preserve the literal admission order above; the mocked Neon transport
 * remains isolated because it installs module-level provider fakes.
 */
export const WRITE_ENGINE_COVERAGE_TEST_GROUPS = Object.freeze([
  Object.freeze(WRITE_ENGINE_CORE_TESTS.slice(0, 8)),
  Object.freeze(WRITE_ENGINE_CORE_TESTS.slice(8, 16)),
  Object.freeze(WRITE_ENGINE_CORE_TESTS.slice(16, 24)),
  Object.freeze(WRITE_ENGINE_CORE_TESTS.slice(24, 32)),
  Object.freeze(WRITE_ENGINE_CORE_TESTS.slice(32, 40)),
  Object.freeze(WRITE_ENGINE_CORE_TESTS.slice(40, 48)),
  Object.freeze(WRITE_ENGINE_CORE_TESTS.slice(48)),
  Object.freeze([...WRITE_ENGINE_EXTENDED_COVERAGE_TESTS]),
]);
