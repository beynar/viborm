import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import d1 from "./vitest.d1.config";

/**
 * The tenant migrator in a Durable Object (plan D4), against PostgreSQL over
 * workerd's outbound TCP. Apart from provider-d1, which runs without
 * `nodejs_compat` as a plain D1 Worker does: `pg` needs the flag, and under it
 * workerd reports a rejection whose handler arrives a microtask late, which
 * `nodejs-compat-rejections.test.ts` pins for the engine. Without
 * PG_TEST_CONNECTION_STRING the tenant suite skips.
 */
export default defineWorkersConfig({
  resolve: d1.resolve,
  test: {
    name: "provider-tenant-do",
    globals: true,
    include: ["tests/providers/workers/tenant/**/*.test.ts"],
    poolOptions: {
      workers: {
        isolatedStorage: true,
        singleWorker: true,
        wrangler: {
          configPath: "./tests/providers/workers/tenant/wrangler.jsonc",
        },
        miniflare: {
          bindings: {
            TENANT_PG_URL: process.env.PG_TEST_CONNECTION_STRING ?? "",
          },
        },
      },
    },
  },
});
