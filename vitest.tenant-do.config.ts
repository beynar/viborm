import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import d1 from "./vitest.d1.config";

/**
 * The tenant migrator in a Durable Object (plan D4), against PostgreSQL over
 * workerd's outbound TCP. Apart from provider-d1, which runs without
 * `nodejs_compat` as a plain D1 Worker does: `pg` needs the flag, and under it
 * workerd reports a rejection whose handler arrives a microtask late, which
 * `nodejs-compat-rejections.test.ts` pins for the engine. Without
 * PG_TEST_CONNECTION_STRING the tenant suite skips.
 */
export default defineConfig({
  resolve: d1.resolve,
  // Storage is isolated per test file; one worker runs the files in turn.
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./tests/providers/workers/tenant/wrangler.jsonc",
      },
      miniflare: {
        bindings: {
          TENANT_PG_URL: process.env.PG_TEST_CONNECTION_STRING ?? "",
        },
      },
    }),
  ],
  test: {
    name: "provider-tenant-do",
    globals: true,
    include: ["tests/providers/workers/tenant/**/*.test.ts"],
    maxWorkers: 1,
  },
});
