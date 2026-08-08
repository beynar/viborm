import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/sql/sql.ts"],
      processingConcurrency: 1,
      reporter: ["text", "json-summary", "lcov", "html"],
      reportsDirectory: "coverage/sql",
      thresholds: { 100: true },
    },
  },
});
