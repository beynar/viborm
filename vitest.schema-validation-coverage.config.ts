import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/schema/validation/**/*.ts"],
      processingConcurrency: 1,
      reporter: ["text", "json-summary", "lcov", "html"],
      reportsDirectory: "coverage/schema-validation",
      thresholds: { 100: true },
    },
  },
});
