import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * The full-estate blast-radius gate config (T3d — P6 Stage 0). Runs the ENTIRE
 * local estate with the V1 fallback globally disabled (via
 * tests/query-engine-v2/blast-radius.setup.ts): a V2 decline re-throws instead of
 * routing to V1. `scripts/blast-radius-gate.mjs` runs this and asserts the failing
 * set equals the documented residual (tests/query-engine-v2/blast-radius-residual.ts)
 * exactly. Docker-only driver legs (pg, mysql) self-skip without their connection
 * strings, exactly as under the default config.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    setupFiles: [
      "tests/cli/_clack.ts",
      "tests/query-engine-v2/blast-radius.setup.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@schema": resolve(__dirname, "src/schema"),
      "@types": resolve(__dirname, "src/types"),
      "@adapters": resolve(__dirname, "src/adapters"),
      "@sql": resolve(__dirname, "src/sql/sql.ts"),
      "@drivers": resolve(__dirname, "src/drivers"),
      "@client": resolve(__dirname, "src/client"),
      "@validation": resolve(__dirname, "src/validation"),
      "@query-engine": resolve(__dirname, "src/query-engine"),
      "@migrations": resolve(__dirname, "src/migrations"),
      "@errors": resolve(__dirname, "src/errors"),
      "@instrumentation": resolve(__dirname, "src/instrumentation"),
      "@cache": resolve(__dirname, "src/cache"),
    },
  },
});
