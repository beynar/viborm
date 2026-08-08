import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/query-engine/write-engine/**/*.ts"],
      processingConcurrency: 1,
      reporter: ["text", "json-summary", "lcov", "html"],
      reportsDirectory: "coverage/write-engine",
      thresholds: {
        branches: 85,
        functions: 95,
        lines: 90,
        statements: 90,
      },
    },
  },
});
