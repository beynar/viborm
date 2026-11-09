import { resolve } from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      // Bare `@drivers` is the custom-driver entry; `@drivers/*` stays a prefix.
      {
        find: /^@drivers$/,
        replacement: resolve(import.meta.dirname, "src/drivers/exports.ts"),
      },
      // The package's root entry, as a consumer imports it: the Permissions
      // acceptance fixture (tests/package/fixtures/permissions-app) is written
      // against "viborm" so a packed-tarball consumer compiles it unchanged.
      {
        find: /^viborm$/,
        replacement: resolve(import.meta.dirname, "src/index.ts"),
      },
      ...Object.entries({
        "@src": resolve(import.meta.dirname, "src"),
        "@tests": resolve(import.meta.dirname, "tests"),
        "@schema": resolve(import.meta.dirname, "src/schema"),
        "@client": resolve(import.meta.dirname, "src/client"),
        "@extensions": resolve(import.meta.dirname, "src/extensions"),
        "@validation": resolve(import.meta.dirname, "src/validation"),
        "@query-engine": resolve(import.meta.dirname, "src/query-engine"),
        "@adapters": resolve(import.meta.dirname, "src/adapters"),
        "@drivers": resolve(import.meta.dirname, "src/drivers"),
        "@migrations": resolve(import.meta.dirname, "src/migrations"),
        "@errors": resolve(import.meta.dirname, "src/errors.ts"),
        "@instrumentation": resolve(import.meta.dirname, "src/instrumentation"),
        "@cache": resolve(import.meta.dirname, "src/cache"),
        "@sql": resolve(import.meta.dirname, "src/sql/sql.ts"),
      }).map(([find, replacement]) => ({ find, replacement })),
    ],
  },
  // The pool isolates storage per test file (its `isolatedStorage` and
  // `singleWorker` are gone); one worker runs the files one after another.
  plugins: [
    cloudflareTest({ wrangler: { configPath: "./wrangler.test.jsonc" } }),
  ],
  test: {
    name: "provider-d1",
    globals: true,
    include: ["tests/providers/workers/**/*.test.ts"],
    // Their own projects: `pg` needs nodejs_compat (vitest.tenant-do.config.ts),
    // and the driver contracts run in a Durable Object (vitest.durable-object.config.ts).
    exclude: [
      ...configDefaults.exclude,
      "tests/providers/workers/tenant/**",
      "tests/providers/workers/durable-object/**",
    ],
    // D1 binds the SQLite migration driver, as `viborm/migrations/sqlite` does.
    setupFiles: ["src/migrations/dialects/sqlite.ts"],
    maxWorkers: 1,
  },
});
