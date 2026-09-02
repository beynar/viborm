import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import {
  coverageOptionsForAll,
  coverageOptionsForSubsystem,
} from "./scripts/coverage-policy.mjs";

const coverage = process.env.VIBORM_COVERAGE_SUBSYSTEM
  ? coverageOptionsForSubsystem(process.env.VIBORM_COVERAGE_SUBSYSTEM, {
      mode: process.env.VIBORM_COVERAGE_MODE ?? "focused",
      reportsDirectory: process.env.VIBORM_COVERAGE_DIRECTORY,
    })
  : coverageOptionsForAll();

export default defineConfig({
  server: {
    fs: {
      allow: [resolve(__dirname), realpathSync(tmpdir())],
    },
  },
  test: {
    globals: true,
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // File-local teardown must release clients before imported lifecycle
    // fixtures close the borrowed provider handles they own.
    sequence: { hooks: "stack" },
    // The CLI suite mocks @clack/prompts. It lives in a setupFile (not an inline
    // vi.mock) because that external ESM module is not reliably re-intercepted
    // when the forks pool reuses a worker across files — the real prompt would
    // then load and block on stdin. See the public-client CLI fixture for the full
    // rationale. It only mocks a module the non-CLI suites never import, so it
    // is inert everywhere else.
    setupFiles: ["tests/contracts/public-client/cli/_clack.ts"],
    // Database behavior suites provision one schema family and reset its rows.
    // The remaining fresh-database tests inject races or destructive state and
    // can legitimately spend several seconds in one case. A genuine hang still
    // fails at this bound.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage,
    benchmark: {
      include: ["benchmarks/**/*.bench.ts"],
    },
  },
  resolve: {
    alias: {
      "@src": resolve(__dirname, "src"),
      "@tests": resolve(__dirname, "tests"),
      "@root": resolve(__dirname),
      "@schema": resolve(__dirname, "src/schema"),
      "@types": resolve(__dirname, "src/types"),
      "@adapters": resolve(__dirname, "src/adapters"),
      "@sql": resolve(__dirname, "src/sql/sql.ts"),
      "@drivers": resolve(__dirname, "src/drivers"),
      "@client": resolve(__dirname, "src/client"),
      "@extensions": resolve(__dirname, "src/extensions"),
      "@validation": resolve(__dirname, "src/validation"),
      "@query-engine": resolve(__dirname, "src/query-engine"),
      "@migrations": resolve(__dirname, "src/migrations"),
      "@errors": resolve(__dirname, "src/errors"),
      "@instrumentation": resolve(__dirname, "src/instrumentation"),
      "@cache": resolve(__dirname, "src/cache"),
    },
  },
});
