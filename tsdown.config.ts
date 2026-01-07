import { defineConfig } from "tsdown";

export default defineConfig({
  // Multiple entry points: main library + CLI
  entry: {
    index: "./src/index.ts",
    cli: "./src/cli/index.ts",
    // Subpath exports for tree-shaking (users can import specific parts)
    adapters: "./src/adapters/index.ts",
    drivers: "./src/drivers/index.ts",
    "drivers/pglite": "./src/drivers/pglite/index.ts",
    migrations: "./src/migrations/index.ts",
    validation: "./src/validation/index.ts",
  },

  // Output format - ESM only since you're "type": "module"
  // Add "cjs" if you need CommonJS support for older tooling
  format: ["esm"],

  // Generate .d.ts declaration files
  // DISABLED: rolldown-plugin-dts can't handle complex inferred types (TS7056)
  // VibORM's type inference relies on these complex types - using VibSchema
  // would break the inference chain from schema → query → result types.
  // Use tsc separately: pnpm tsc --emitDeclarationOnly --declaration --outDir dist
  dts: false,

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
  ],

  // Shims for Node.js builtins when targeting edge runtimes
  shims: true,

  // Enable tree-shaking
  treeshake: true,
});
