import { defineConfig } from "tsdown";

export default defineConfig({
  // Multiple entry points for tree-shaking
  entry: {
    // Main entry
    index: "./src/index.ts",
    cli: "./src/cli/index.ts",

    // Schema (viborm/schema)
    schema: "./src/schema/exports.ts",

    // Driver base (viborm/driver)
    driver: "./src/drivers/exports.ts",

    // PostgreSQL drivers (viborm/pg, viborm/postgres, etc.)
    pg: "./src/drivers/pg/index.ts",
    postgres: "./src/drivers/postgres/index.ts",
    pglite: "./src/drivers/pglite/index.ts",
    "neon-http": "./src/drivers/neon-http/index.ts",
    "bun-sql": "./src/drivers/bun-sql/index.ts",

    // MySQL drivers (viborm/mysql2, viborm/planetscale)
    mysql2: "./src/drivers/mysql2/index.ts",
    planetscale: "./src/drivers/planetscale/index.ts",

    // SQLite drivers (viborm/sqlite3, viborm/libsql, etc.)
    sqlite3: "./src/drivers/sqlite3/index.ts",
    libsql: "./src/drivers/libsql/index.ts",
    d1: "./src/drivers/d1/index.ts",
    "d1-http": "./src/drivers/d1-http/index.ts",
    "bun-sqlite": "./src/drivers/bun-sqlite/index.ts",

    // Cache (viborm/cache, viborm/cache/memory, etc.)
    cache: "./src/cache/exports.ts",
    "cache/memory": "./src/cache/drivers/memory.ts",
    "cache/cloudflare-kv": "./src/cache/drivers/cloudflare-kv.ts",

    // Migrations (viborm/migrations)
    migrations: "./src/migrations/index.ts",

    // Client types (viborm/client)
    client: "./src/client/exports.ts",

    // Validation (viborm/validation)
    validation: "./src/validation/index.ts",

    // Instrumentation (viborm/instrumentation)
    instrumentation: "./src/instrumentation/exports.ts",

    // Adapters (internal, but exposed for advanced usage)
    adapters: "./src/adapters/index.ts",
  },

  // Output format - ESM only since you're "type": "module"
  // Add "cjs" if you need CommonJS support for older tooling
  format: ["esm"],

  // Generate .d.ts declaration files
  // DISABLED: rolldown-plugin-dts can't handle complex inferred types (TS7056)
  // VibORM's type inference relies on these complex types - using VibSchema
  // would break the inference chain from schema → query → result types.
  // Use tsc separately: pnpm tsc --emitDeclarationOnly --declaration --outDir dist

  // Clean output directory before build
  clean: true,

  // Generate sourcemaps for debugging
  sourcemap: true,

  // Target modern Node.js (matches your engines.node >= 18)
  target: "node18",

  // Output directory
  outDir: "./dist",

  // Don't bundle dependencies - they should be installed by consumers
  external: [
    // Runtime dependencies
    "commander",
    "pg",
    "@clack/prompts",
    "@paralleldrive/cuid2",
    "nanoid",
    "ulidx",
    // Peer dependencies
    "@electric-sql/pglite",
    "@cloudflare/workers-types",
    "@neondatabase/serverless",
    "@planetscale/database",
    "@libsql/client",
    "mysql2",
    "better-sqlite3",
    "postgres",
    // Bun built-ins (only available in Bun runtime)
    "bun:sqlite",
    "bun:sql",
  ],

  // Shims for Node.js builtins when targeting edge runtimes
  shims: true,
  minify: true,
  bundle: true,
  dts: true,
  // Enable tree-shaking
  treeshake: true,
});
