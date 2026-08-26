import { resolve } from "node:path";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  resolve: {
    alias: {
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
    },
  },
  test: {
    name: "provider-d1",
    globals: true,
    include: ["tests/providers/workers/**/*.test.ts"],
    poolOptions: {
      workers: {
        isolatedStorage: true,
        singleWorker: true,
        wrangler: { configPath: "./wrangler.test.jsonc" },
      },
    },
  },
});
