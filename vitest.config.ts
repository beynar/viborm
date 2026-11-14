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
      allow: [resolve(import.meta.dirname), realpathSync(tmpdir())],
    },
  },
  test: {
    globals: true,
    fileParallelism: false,
    // Vitest 4 spells Vitest 3's `poolOptions.forks.singleFork` as one worker
    // that is not isolated: every file runs in the same child process.
    // `tests/fixtures/reset-modules-per-file.ts` restores the per-file module
    // and mock reset `singleFork` performed and Vitest 4 now reserves for
    // `isolate: true`, which would instead start a process per file.
    maxWorkers: 1,
    isolate: false,
    pool: "forks",
    // File-local teardown must release clients before imported lifecycle
    // fixtures close the borrowed provider handles they own.
    sequence: { hooks: "stack" },
    // The CLI suite mocks @clack/prompts. It lives in a setupFile (not an inline
    // vi.mock) because that external ESM module is not reliably re-intercepted
    // when the forks pool reuses a worker across files — the real prompt would
    // then load and block on stdin. See the public-client CLI fixture for the full
    // rationale. It only mocks a module the non-CLI suites never import, so it
    // is inert everywhere else.
    setupFiles: [
      // First: it resets what the previous file evaluated and mocked, so the
      // setup files after it register into a clean graph.
      "tests/fixtures/reset-modules-per-file.ts",
      "tests/contracts/public-client/cli/_clack.ts",
      "tests/fixtures/register-migration-drivers.ts",
      "tests/fixtures/extension-host.ts",
    ],
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
        "@root": resolve(import.meta.dirname),
        "@schema": resolve(import.meta.dirname, "src/schema"),
        "@types": resolve(import.meta.dirname, "src/types"),
        "@adapters": resolve(import.meta.dirname, "src/adapters"),
        "@sql": resolve(import.meta.dirname, "src/sql/sql.ts"),
        "@drivers": resolve(import.meta.dirname, "src/drivers"),
        "@client": resolve(import.meta.dirname, "src/client"),
        "@extensions": resolve(import.meta.dirname, "src/extensions"),
        "@validation": resolve(import.meta.dirname, "src/validation"),
        "@query-engine": resolve(import.meta.dirname, "src/query-engine"),
        "@migrations": resolve(import.meta.dirname, "src/migrations"),
        "@errors": resolve(import.meta.dirname, "src/errors"),
        "@instrumentation": resolve(import.meta.dirname, "src/instrumentation"),
        "@cache": resolve(import.meta.dirname, "src/cache"),
      }).map(([find, replacement]) => ({ find, replacement })),
    ],
  },
});
