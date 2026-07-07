import { resolve } from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    // The CLI suite mocks @clack/prompts. It lives in a setupFile (not an inline
    // vi.mock) because that external ESM module is not reliably re-intercepted
    // when the forks pool reuses a worker across files — the real prompt would
    // then load and block on stdin. See tests/cli/_clack.ts for the full
    // rationale. It only mocks a module the non-CLI suites never import, so it
    // is inert everywhere else.
    setupFiles: ["tests/cli/_clack.ts"],
    // Many suites boot fresh PGlite instances and run migrations per test. When
    // the whole suite (thousands of tests) runs in parallel on a contended CPU,
    // these routinely exceed vitest's 5s default even though each passes in well
    // under a second in isolation. Give realistic headroom so parallel CPU
    // contention does not surface as spurious timeouts. A genuine hang still
    // fails at this bound; a slow-but-correct test does not flake.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    benchmark: {
      include: ["benchmarks/**/*.bench.ts"],
    },
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
