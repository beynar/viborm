import { resolve } from "node:path";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import d1 from "./vitest.d1.config";

const BEHAVIORS = resolve(__dirname, "tests/contracts/drivers/behaviors");
const HARNESS = resolve(
  __dirname,
  "tests/providers/workers/durable-object/harness.ts"
);

/**
 * `viborm/durable-object` on workerd. The driver contracts import `vitest`
 * directly; here that import resolves to `harness.ts`, which runs each of
 * their tests inside a fresh SQLite Durable Object.
 */
export default defineWorkersConfig({
  resolve: d1.resolve,
  plugins: [
    {
      name: "viborm-durable-object-contract-harness",
      enforce: "pre",
      resolveId(source, importer) {
        if (source === "vitest" && importer?.startsWith(BEHAVIORS))
          return HARNESS;
        return null;
      },
    },
  ],
  test: {
    name: "provider-durable-object",
    globals: true,
    include: ["tests/providers/workers/durable-object/**/*.test.ts"],
    // The driver binds the SQLite migration driver, as `viborm/migrations/sqlite` does.
    setupFiles: ["src/migrations/dialects/sqlite.ts"],
    poolOptions: {
      workers: {
        isolatedStorage: true,
        singleWorker: true,
        wrangler: {
          configPath: "./tests/providers/workers/durable-object/wrangler.jsonc",
        },
      },
    },
  },
});
