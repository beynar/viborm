import { defineWorkspace } from "vitest/config";
import { CLIENT_COVERAGE_TESTS } from "./scripts/client-test-manifest.mjs";
import { EXTENDED_LOCAL_TESTS } from "./scripts/credential-free-test-manifest.mjs";
import {
  DRIVER_CORE_TESTS,
  DRIVER_COVERAGE_TESTS,
} from "./scripts/driver-test-manifest.mjs";
import { MIGRATION_COVERAGE_TESTS } from "./scripts/migration-test-manifest.mjs";
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
