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
  "tests/contracts/architecture/extension-system-census.core.test.ts",
  "tests/contracts/architecture/gate-inventory-census.core.test.ts",
  "tests/contracts/architecture/geopoint-language-census.core.test.ts",
  "tests/contracts/architecture/system-clock.core.test.ts",
  "tests/contracts/engine/query/batch-attribution-hazard-signature.core.test.ts",
  "tests/contracts/engine/query/bind-budget.core.test.ts",
  "tests/contracts/engine/query/bulk-insert-row-shapes.core.test.ts",
  "tests/contracts/engine/query/cache-result-codec-boundaries.core.test.ts",
  "tests/contracts/engine/query/decimal-having-operand-sql.core.test.ts",
  "tests/contracts/engine/query/default-insert-sql.core.test.ts",
  "tests/contracts/engine/query/field-reference-sql.core.test.ts",
  "tests/contracts/engine/query/for-update-dialects.core.test.ts",
  "tests/contracts/engine/query/geopoint-sql.core.test.ts",
  "tests/contracts/engine/query/json-null-sentinel-sql.core.test.ts",
  "tests/contracts/engine/query/lateral-joins.core.test.ts",
  "tests/contracts/engine/query/model-key-catalog.core.test.ts",
  "tests/contracts/engine/query/namespace-qualification.core.test.ts",
  "tests/contracts/engine/query/nested-captured-target-signature.core.test.ts",
  "tests/contracts/engine/query/operand-callback-sql.core.test.ts",
  "tests/contracts/engine/query/operation-program-read-contracts.core.test.ts",
  "tests/contracts/engine/query/orderby-relation-depth.core.test.ts",
  "tests/contracts/engine/query/parity-admission.core.test.ts",
  "tests/contracts/engine/query/parity-assignments.core.test.ts",
  "tests/contracts/engine/query/parity-decoding.core.test.ts",
  "tests/contracts/engine/query/parity-lowering.core.test.ts",
  "tests/contracts/engine/query/parity-preparation.core.test.ts",
  "tests/contracts/engine/query/pending-operation-contracts.core.test.ts",
  "tests/contracts/engine/query/query-inspection.core.test.ts",
  "tests/contracts/engine/query/result-aliases.core.test.ts",
  "tests/contracts/engine/query/select-mode-capability-matrix.core.test.ts",
  "tests/contracts/engine/query/starts-with-prefix-sql.core.test.ts",
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
  "tests/contracts/engine/write/atomic-unit-batch.core.test.ts",
  "tests/contracts/engine/write/dead-symbol-gate.core.test.ts",
  "tests/contracts/engine/write/parse-boundary-gate.core.test.ts",
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
 * admission is one group now that the V1 write engine and its gates are retired
 * (four files); the mocked Neon transport remains isolated because it installs
 * module-level provider fakes.
 */
export const WRITE_ENGINE_COVERAGE_TEST_GROUPS = Object.freeze([
  Object.freeze([...WRITE_ENGINE_CORE_TESTS]),
  Object.freeze([...WRITE_ENGINE_EXTENDED_COVERAGE_TESTS]),
]);
