import { defineWorkspace } from "vitest/config";

const layerProject = (name: string, include: string[]) => ({
  extends: "./vitest.config.ts",
  test: {
    name: `layer-${name}`,
    include,
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
  layerProject("query-engine", [
    "tests/contracts/architecture/**/*.core.test.ts",
    "tests/contracts/engine/**/*.core.test.ts",
  ]),
  layerProject("adapters", ["tests/contracts/adapters/**/*.core.test.ts"]),
  layerProject("drivers", ["tests/contracts/drivers/*.core.test.ts"]),
  layerProject("client", ["tests/contracts/public-client/*.core.test.ts"]),
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
      ],
    },
  },
  {
    extends: "./vitest.config.ts",
    test: {
      name: "coverage-write-engine",
      include: [
        "tests/contracts/architecture/**/*.core.test.ts",
        "tests/contracts/engine/query/**/*.core.test.ts",
        "tests/contracts/engine/query/nested-create-many.test.ts",
        "tests/contracts/engine/write/**/*.test.ts",
      ],
    },
  },
  {
    extends: "./vitest.config.ts",
    test: {
      name: "extended-local",
      include: ["tests/**/*.test.ts"],
      exclude: [
        "tests/**/*.core.test.ts",
        "tests/package/**/*.test.ts",
        "tests/providers/**/*.test.ts",
      ],
    },
  },
  providerProject("pglite", ["tests/providers/local/pglite*.test.ts"]),
  providerProject("sqlite3", ["tests/providers/local/sqlite3.test.ts"]),
  providerProject("libsql", ["tests/providers/local/libsql.test.ts"]),
  providerProject("pg", ["tests/providers/docker/pg.test.ts"]),
  providerProject("postgres", [
    "tests/providers/docker/postgres.test.ts",
    "tests/providers/docker/postgres-pipelining.test.ts",
  ]),
  providerProject("mysql2", ["tests/providers/docker/mysql2.test.ts"]),
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
