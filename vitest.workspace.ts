import { defineWorkspace } from "vitest/config";
import { CLIENT_COVERAGE_TESTS } from "./scripts/client-test-manifest.mjs";
import { EXTENDED_LOCAL_TESTS } from "./scripts/credential-free-test-manifest.mjs";
import {
  DRIVER_CORE_TESTS,
  DRIVER_COVERAGE_TESTS,
} from "./scripts/driver-test-manifest.mjs";
import { MIGRATION_COVERAGE_TESTS } from "./scripts/migration-test-manifest.mjs";
import {
  G1_COMPARISON_TESTS,
  G1_BASELINE_TESTS,
  G1_CONTRACT_TESTS,
  G2_BASELINE_TESTS,
  G2_CONTRACT_TESTS,
  G25_CONTRACT_TESTS,
  G25_PG_CONTRACT_TESTS,
  G27_CONTRACT_TESTS,
  G27_MYSQL_CONTRACT_TESTS,
  G27_PG_CONTRACT_TESTS,
  G3P02_PG_CONTRACT_TESTS,
  G3P03_CONTRACT_TESTS,
  G3P03_PG_CONTRACT_TESTS,
  G3P04_CONTRACT_TESTS,
  G3P04_REVIEW_CONTRACT_TESTS,
  G3P04_PG_CONTRACT_TESTS,
  G3P05_CONTRACT_TESTS,
  G3_BULK_SERIES_TESTS,
  G3_SUPPRESSION_RETRY_TESTS,
  G3_TRANSACTION_ARRAY_TESTS,
  G3_DEPTH_RECURRENCE_TESTS,
  G3_SCOPE_COMPOSITION_PG_TESTS,
  G3_GENERATED_SMOKE_TESTS,
  G3_GENERATED_TRANSPORT_SMOKE_TESTS,
  G3_GENERATED_MINIMIZATION_TESTS,
  G3_GENERATED_CAMPAIGN_TESTS,
  G3_GENERATED_TRANSPORT_CAMPAIGN_TESTS,
  G4_READ_TESTS,
  G4_LIFECYCLE_EVENTS_TESTS,
  G4_LIFECYCLE_ADMISSION_TESTS,
  G4_ROUTE_LIFECYCLE_TESTS,
  G4_ROUTE_ADMISSION_TESTS,
  G4_ROUTE_CACHE_TESTS,
  G4_ROUTE_TRANSACTION_TESTS,
  G4_GENERATION_SELFTEST_TESTS,
  G4_GENERATED_CAMPAIGN_TESTS,
  G4_GENERATED_TRANSPORT_CAMPAIGN_TESTS,
  G4_WRITE_CAMPAIGN_TESTS,
  G4_WRITE_TRANSPORT_CAMPAIGN_TESTS,
  G4_UNIT01_AUTHOR_TESTS,
  G4_UNIT01_REVIEW_TESTS,
  G4_UNIT02_AUTHOR_TESTS,
  G4_UNIT02_MYSQL_TESTS,
  G4_UNIT02_PG_TESTS,
  G4_NATIVE_PG_TESTS,
  G4_NATIVE_MYSQL_TESTS,
  G3_EXECUTION_REVIEW_TESTS,
  G3_AUTHOR_EXECUTION_REGRESSION_TESTS,
  G3_SCOPE_FAILURE_TESTS,
  G3_BULK_RESULT_BOUNDARY_TESTS,
  POST_G3_CLEARABILITY_CONTRACT_TESTS,
  POST_G3_CLEARABILITY_MYSQL_CONTRACT_TESTS,
  POST_G3_CLEARABILITY_PG_CONTRACT_TESTS,
  POST_G3_SCHEMA_VIEW_TESTS,
  POST_G3_PROJECTION_PREPARATION_TESTS,
  POST_G3_SELECTOR_PREPARATION_TESTS,
  POST_G3_HISTORY_ANALYSIS_TESTS,
  G29_MEMBER_DEPENDENCY_TESTS,
  G29_DEPENDENCY_BOUNDARY_TESTS,
  G29_DEPENDENCY_CHOICE_TESTS,
  G29_RESULT_PROGRESS_TESTS,
  CS01_STRUCTURAL_REFERENCE_TESTS,
  CS01_EXTENSION_A_TESTS,
  CS01_EXTENSION_B_TESTS,
  CS01_EXTENSION_COMPOSITION_TESTS,
  CS03_MEMBER_SCOPE_TESTS,
  CS03_EXTENSION_CAMPAIGN_TESTS,
  CS03_EXTENSION_SUPPORT_TESTS,
  CS02_REPEATED_OCCURRENCE_TESTS,
  CS02_STRUCTURE_MEASUREMENT_TESTS,
  G29_MEMBER_DEPENDENCY_MYSQL_TESTS,
  G29_MEMBER_DEPENDENCY_PG_TESTS,
  G2_DIAGNOSTIC_TESTS,
  G2_PG_BASELINE_TESTS,
  G2_PG_CONTRACT_TESTS,
  G2_CAMPAIGN_TESTS,
  G2_TRANSPORT_TESTS,
  G2_GENERATED_TESTS,
  G1_GENERATED_TESTS,
  G1_CAMPAIGN_TESTS,
  G1_TRANSPORT_TESTS,
  G1_TRANSPORT_CAMPAIGN_TESTS,
  G1_PROVIDER_TESTS,
  G1_PROVIDER_BASELINE_TESTS,
  RAPTOR3_TESTS,
} from "./scripts/raptor3-manifest.mjs";
import {
  QUERY_ENGINE_CORE_TESTS,
  WRITE_ENGINE_CORE_TESTS,
  WRITE_ENGINE_COVERAGE_TESTS,
} from "./scripts/query-engine-test-manifest.mjs";

const layerProject = (
  name: string,
  include: string[],
  exclude: string[] = []
) => ({
  extends: "./vitest.config.ts",
  test: {
    name: `layer-${name}`,
    include,
    ...(exclude.length === 0 ? {} : { exclude }),
  },
});

const providerProject = (name: string, include: string[]) => ({
  extends: "./vitest.config.ts",
  test: {
    name: `provider-${name}`,
    include,
    fileParallelism: false,
  },
});

const coverageProject = (name: string, include: string[]) => ({
  extends: "./vitest.config.ts",
  test: {
    name: `coverage-${name}`,
    include,
  },
});

export default defineWorkspace([
  {
    extends: "./vitest.config.ts",
    test: {
      name: "raptor3",
      include: [
        ...RAPTOR3_TESTS,
        ...G1_COMPARISON_TESTS,
        ...G1_BASELINE_TESTS,
        ...G1_CONTRACT_TESTS,
        ...G2_BASELINE_TESTS,
        ...G2_CONTRACT_TESTS,
        ...G25_CONTRACT_TESTS,
        ...G27_CONTRACT_TESTS,
        ...G3P03_CONTRACT_TESTS,
        ...G3P04_CONTRACT_TESTS,
        ...G3P04_REVIEW_CONTRACT_TESTS,
        ...G3P05_CONTRACT_TESTS,
        ...G3_BULK_SERIES_TESTS,
        ...G3_SUPPRESSION_RETRY_TESTS,
        ...G3_TRANSACTION_ARRAY_TESTS,
        ...G3_DEPTH_RECURRENCE_TESTS,
        ...G3_GENERATED_SMOKE_TESTS,
        ...G3_GENERATED_TRANSPORT_SMOKE_TESTS,
        ...G3_GENERATED_MINIMIZATION_TESTS,
        ...G4_READ_TESTS,
        ...G4_LIFECYCLE_EVENTS_TESTS,
        ...G4_LIFECYCLE_ADMISSION_TESTS,
        ...G4_ROUTE_LIFECYCLE_TESTS,
        ...G4_ROUTE_ADMISSION_TESTS,
        ...G4_ROUTE_CACHE_TESTS,
        ...G4_ROUTE_TRANSACTION_TESTS,
        ...G4_GENERATION_SELFTEST_TESTS,
        ...G4_GENERATED_CAMPAIGN_TESTS,
        ...G4_GENERATED_TRANSPORT_CAMPAIGN_TESTS,
        ...G4_WRITE_CAMPAIGN_TESTS,
        ...G4_WRITE_TRANSPORT_CAMPAIGN_TESTS,
        ...G4_UNIT01_AUTHOR_TESTS,
        ...G4_UNIT01_REVIEW_TESTS,
        ...G4_UNIT02_AUTHOR_TESTS,
        ...G3_EXECUTION_REVIEW_TESTS,
        ...G3_AUTHOR_EXECUTION_REGRESSION_TESTS,
        ...G3_SCOPE_FAILURE_TESTS,
        ...G3_BULK_RESULT_BOUNDARY_TESTS,
        ...POST_G3_CLEARABILITY_CONTRACT_TESTS,
        ...POST_G3_SCHEMA_VIEW_TESTS,
        ...POST_G3_PROJECTION_PREPARATION_TESTS,
        ...POST_G3_SELECTOR_PREPARATION_TESTS,
        ...POST_G3_HISTORY_ANALYSIS_TESTS,
        ...G29_MEMBER_DEPENDENCY_TESTS,
        ...G29_DEPENDENCY_BOUNDARY_TESTS,
        ...G29_DEPENDENCY_CHOICE_TESTS,
        ...G29_RESULT_PROGRESS_TESTS,
        ...CS01_STRUCTURAL_REFERENCE_TESTS,
        ...CS01_EXTENSION_A_TESTS,
        ...CS01_EXTENSION_B_TESTS,
        ...CS01_EXTENSION_COMPOSITION_TESTS,
        ...CS03_MEMBER_SCOPE_TESTS,
        ...CS03_EXTENSION_CAMPAIGN_TESTS,
        ...CS03_EXTENSION_SUPPORT_TESTS,
        ...CS02_REPEATED_OCCURRENCE_TESTS,
        ...CS02_STRUCTURE_MEASUREMENT_TESTS,
        ...G2_DIAGNOSTIC_TESTS,
        ...G1_GENERATED_TESTS,
        ...G1_CAMPAIGN_TESTS,
        ...G1_TRANSPORT_TESTS,
        ...G1_TRANSPORT_CAMPAIGN_TESTS,
        ...G3_GENERATED_CAMPAIGN_TESTS,
        ...G3_GENERATED_TRANSPORT_CAMPAIGN_TESTS,
        ...G2_CAMPAIGN_TESTS,
        ...G2_TRANSPORT_TESTS,
        ...G2_GENERATED_TESTS,
      ],
    },
  },
  {
    extends: "./vitest.config.ts",
    test: {
      name: "raptor3-provider",
      include: [...G1_PROVIDER_TESTS, ...G1_PROVIDER_BASELINE_TESTS],
    },
  },
  {
    extends: "./vitest.config.ts",
    test: {
      name: "raptor3-live-provider",
      include: [
        ...G2_PG_BASELINE_TESTS,
        ...G2_PG_CONTRACT_TESTS,
        ...G25_PG_CONTRACT_TESTS,
        ...G27_PG_CONTRACT_TESTS,
        ...G27_MYSQL_CONTRACT_TESTS,
        ...G3P02_PG_CONTRACT_TESTS,
        ...G3P03_PG_CONTRACT_TESTS,
        ...G3P04_PG_CONTRACT_TESTS,
        ...G3_SCOPE_COMPOSITION_PG_TESTS,
        ...POST_G3_CLEARABILITY_PG_CONTRACT_TESTS,
        ...POST_G3_CLEARABILITY_MYSQL_CONTRACT_TESTS,
        ...G29_MEMBER_DEPENDENCY_PG_TESTS,
        ...G29_MEMBER_DEPENDENCY_MYSQL_TESTS,
        ...G4_NATIVE_PG_TESTS,
        ...G4_NATIVE_MYSQL_TESTS,
        ...G4_UNIT02_MYSQL_TESTS,
        ...G4_UNIT02_PG_TESTS,
      ],
    },
  },
  layerProject("validation", ["tests/unit/validation/**/*.core.test.ts"]),
  layerProject("scalars", ["tests/unit/scalars/**/*.core.test.ts"]),
  layerProject("operation-schemas", [
    "tests/unit/operation-schemas/**/*.core.test.ts",
  ]),
  layerProject("relations", ["tests/unit/relations/**/*.core.test.ts"]),
  layerProject("schema-validation", [
    "tests/unit/schema-validation/**/*.core.test.ts",
  ]),
  layerProject("schema-json", ["tests/unit/schema-json/**/*.core.test.ts"]),
  layerProject("query-engine", [...QUERY_ENGINE_CORE_TESTS]),
  // The pattern engine's own estate (docs/architecture/pattern-engine-ideal-state.md
  // §13): the oracle harness, the payload generator, per-unit fixtures and the
  // differentials. Glob-admitted deliberately — every file here is provider-free
  // by construction (it runs on the planning driver or the simulated driver).
  layerProject("pattern", ["tests/pattern/**/*.core.test.ts"]),
  // The write core is its own layer rather than 56 more files inside
  // layer-query-engine, which is already the widest layer in the estate.
  // `pnpm test:core` selects `layer-*`, so a new layer name is admitted for
  // free, and each engine half then owns a whole 30 second layer budget instead
  // of the two sharing one. Until this project existed, `coverage-write-engine-core`
  // was the only selection that read these files, so the entire write estate
  // was absent from `pnpm test` and `pnpm test:all`.
  layerProject("write-engine", [...WRITE_ENGINE_CORE_TESTS]),
  layerProject("adapters", ["tests/contracts/adapters/**/*.core.test.ts"]),
  layerProject("drivers", [...DRIVER_CORE_TESTS]),
  // One recursive glob, not a per-subdirectory list: the enumerated form silently
  // dropped `extensions/array-admission.core.test.ts` when that directory was
  // added, and `extended-local` excludes every `.core.test.ts`, so the contract
  // executed in no runnable lane at all.
  layerProject("client", ["tests/contracts/public-client/**/*.core.test.ts"]),
  layerProject("cache", ["tests/unit/cache/**/*.core.test.ts"]),
  layerProject("instrumentation", [
    "tests/unit/instrumentation/**/*.core.test.ts",
  ]),
  layerProject("migrations", ["tests/unit/migrations/**/*.core.test.ts"]),
  {
    extends: "./vitest.config.ts",
    test: {
      name: "coverage-schema",
      include: [
        "tests/unit/scalars/field-ref.core.test.ts",
        "tests/unit/scalars/shared-scalar.core.test.ts",
        // `hydration.ts` is inside this gate's 100% glob, and the write-once
        // schema key it refuses is that file's own invariant — its witnesses
        // live in the schema-validation layer, so the gate must read them here.
        "tests/unit/schema-validation/model-registration-identity.core.test.ts",
        // `src/schema/json/**` is inside this gate's globs; its whole suite
        // lives here so the 100% report reads the tests that own it.
        "tests/unit/schema-json/**/*.core.test.ts",
        // `src/schema/identifier.ts` joined this gate's globs with the database
        // namespace grammar; its owner suite lives in the schema-validation
        // layer, so the 100% report must read it here.
        "tests/unit/schema-validation/namespace-identifier.core.test.ts",
      ],
    },
  },
  {
    extends: "./vitest.config.ts",
    test: {
      name: "coverage-public",
      include: [
        "tests/contracts/architecture/system-clock.core.test.ts",
        "tests/contracts/public-client/config-subpath.core.test.ts",
        "tests/contracts/public-client/public-runtime-surface.core.test.ts",
        "tests/unit/instrumentation/version.core.test.ts",
      ],
    },
  },
  {
    extends: "./vitest.config.ts",
    test: {
      name: "coverage-extensions",
      include: [
        "tests/contracts/architecture/extension-system-census.core.test.ts",
        "tests/contracts/public-client/default-omit-extension.core.test.ts",
        "tests/contracts/public-client/extensions-foundation.core.test.ts",
        "tests/contracts/public-client/official-cache-extension.core.test.ts",
        "tests/contracts/public-client/official-instrumentation-extension.core.test.ts",
        "tests/contracts/engine/query/operation-program-read-contracts.core.test.ts",
        "tests/contracts/engine/query/pending-operation-contracts.core.test.ts",
        "tests/contracts/public-client/extensions/array-admission.core.test.ts",
        "tests/contracts/public-client/query-interceptors*.core.test.ts",
        "tests/contracts/public-client/request-transforms.core.test.ts",
        "tests/contracts/public-client/statement-transforms-integration.core.test.ts",
        "tests/contracts/drivers/statement-transforms.core.test.ts",
        "tests/contracts/drivers/protected-observers.core.test.ts",
        "tests/unit/instrumentation/official-observer*.core.test.ts",
      ],
    },
  },
  {
    extends: "./vitest.config.ts",
    test: {
      name: "coverage-errors",
      include: [
        "tests/contracts/public-client/errors/**/*.test.ts",
        "tests/unit/validation/boundaries.core.test.ts",
      ],
    },
  },
  {
    extends: "./vitest.config.ts",
    test: {
      name: "coverage-cli",
      include: ["tests/contracts/public-client/cli/**/*.test.ts"],
    },
  },
  coverageProject("cache", [
    "tests/unit/cache/**/*.core.test.ts",
    "tests/contracts/public-client/official-cache-extension.core.test.ts",
    "tests/contracts/public-client/official-cache-instrumentation.core.test.ts",
    "tests/contracts/public-client/official-cache-swr.core.test.ts",
    "tests/contracts/public-client/protected-cache-observers.core.test.ts",
  ]),
  coverageProject("client", [...CLIENT_COVERAGE_TESTS]),
  coverageProject("drivers", [...DRIVER_COVERAGE_TESTS]),
  coverageProject("migrations", [...MIGRATION_COVERAGE_TESTS]),
  coverageProject("write-engine-core", [...WRITE_ENGINE_CORE_TESTS]),
  {
    extends: "./vitest.config.ts",
    test: {
      name: "coverage-write-engine",
      include: [...WRITE_ENGINE_COVERAGE_TESTS],
      pool: "threads",
      poolOptions: { threads: { singleThread: true } },
    },
  },
  {
    extends: "./vitest.config.ts",
    test: {
      name: "extended-local",
      include: [...EXTENDED_LOCAL_TESTS],
    },
  },
  // Every provider project globs its own prefix. Exact paths silently dropped
  // the pieces when the heavy suites were split for the 1280 MB shard heap.
  providerProject("pglite", ["tests/providers/local/pglite*.test.ts"]),
  providerProject("sqlite3", ["tests/providers/local/sqlite3*.test.ts"]),
  providerProject("libsql", ["tests/providers/local/libsql*.test.ts"]),
  // `pg*` cannot catch postgres*: that name starts "po".
  providerProject("pg", ["tests/providers/docker/pg*.test.ts"]),
  providerProject("postgres", ["tests/providers/docker/postgres*.test.ts"]),
  providerProject("mysql2", [
    "tests/providers/docker/mysql2*.test.ts",
    "tests/contracts/engine/query/decimal-wide-arithmetic-docker.test.ts",
    "tests/unit/migrations/mysql-strict-mode-docker.test.ts",
    "tests/unit/migrations/decimal-list-defaults-mysql-docker.test.ts",
  ]),
  providerProject("transaction-options", [
    "tests/providers/docker/transaction-options-live.test.ts",
  ]),
  providerProject("neon-http", ["tests/providers/hosted/neon-http.test.ts"]),
  providerProject("planetscale", [
    "tests/providers/hosted/planetscale.test.ts",
  ]),
  providerProject("bun", ["tests/providers/platform/*.test.ts"]),
  {
    extends: "./vitest.config.ts",
    test: {
      name: "package",
      include: ["tests/package/**/*.test.ts"],
    },
  },
  "./vitest.d1.config.ts",
]);
