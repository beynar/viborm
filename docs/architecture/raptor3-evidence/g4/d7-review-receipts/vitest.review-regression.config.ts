import { defineConfig } from "vitest/config";

const root = "/Users/arnaud/code/viborm";

export default defineConfig({
  root,
  resolve: {
    alias: {
      "@src": `${root}/src`,
      "@tests": `${root}/tests`,
      "@root": root,
      "@schema": `${root}/src/schema`,
      "@types": `${root}/src/types`,
      "@adapters": `${root}/src/adapters`,
      "@sql": `${root}/src/sql/sql.ts`,
      "@drivers": `${root}/src/drivers`,
      "@client": `${root}/src/client`,
      "@extensions": `${root}/src/extensions`,
      "@validation": `${root}/src/validation`,
      "@query-engine": `${root}/src/query-engine`,
      "@migrations": `${root}/src/migrations`,
      "@errors": `${root}/src/errors`,
      "@instrumentation": `${root}/src/instrumentation`,
      "@cache": `${root}/src/cache`,
    },
  },
  test: {
    name: "raptor3-review-regression",
    include: ["tests/raptor3/g4/review/regression/**/*.test.ts"],
    globals: true,
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    sequence: { hooks: "stack" },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
