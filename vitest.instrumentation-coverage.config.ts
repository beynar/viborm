import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/instrumentation/**/*.ts"],
      processingConcurrency: 1,
      reporter: ["text", "json-summary", "lcov", "html"],
      reportsDirectory: "coverage/instrumentation",
      thresholds: { 100: true },
    },
  },
});
