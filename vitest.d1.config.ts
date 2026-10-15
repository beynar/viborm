import { resolve } from "node:path";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { configDefaults } from "vitest/config";

export default defineWorkersConfig({
  resolve: {
    alias: [
      // Bare `@drivers` is the custom-driver entry; `@drivers/*` stays a prefix.
      {
        find: /^@drivers$/,
        replacement: resolve(__dirname, "src/drivers/exports.ts"),
      },
      // The package's root entry, as a consumer imports it: the RBAC
      // acceptance fixture (tests/package/fixtures/rbac-app) is written
      // against "viborm" so a packed-tarball consumer compiles it unchanged.
      { find: /^viborm$/, replacement: resolve(__dirname, "src/index.ts") },
      ...Object.entries({
        "@src": resolve(__dirname, "src"),
        "@tests": resolve(__dirname, "tests"),
        "@schema": resolve(__dirname, "src/schema"),
        "@client": resolve(__dirname, "src/client"),
        "@extensions": resolve(__dirname, "src/extensions"),
        "@validation": resolve(__dirname, "src/validation"),
        "@query-engine": resolve(__dirname, "src/query-engine"),
        "@adapters": resolve(__dirname, "src/adapters"),
        "@drivers": resolve(__dirname, "src/drivers"),
        "@migrations": resolve(__dirname, "src/migrations"),
        "@errors": resolve(__dirname, "src/errors.ts"),
        "@instrumentation": resolve(__dirname, "src/instrumentation"),
        "@cache": resolve(__dirname, "src/cache"),
        "@sql": resolve(__dirname, "src/sql/sql.ts"),
      }).map(([find, replacement]) => ({ find, replacement })),
    ],
  },
  test: {
    name: "provider-d1",
    globals: true,
    include: ["tests/providers/workers/**/*.test.ts"],
    // Its own project (vitest.tenant-do.config.ts): `pg` needs nodejs_compat.
    exclude: [...configDefaults.exclude, "tests/providers/workers/tenant/**"],
    // D1 binds the SQLite migration driver, as `viborm/migrations/sqlite` does.
    setupFiles: ["src/migrations/dialects/sqlite.ts"],
    poolOptions: {
      workers: {
        isolatedStorage: true,
        singleWorker: true,
        wrangler: { configPath: "./wrangler.test.jsonc" },
      },
    },
  },
});
