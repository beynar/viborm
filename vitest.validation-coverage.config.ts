import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/validation/**/*.ts"],
      processingConcurrency: 1,
      reporter: ["text", "json-summary", "lcov", "html"],
      reportsDirectory: "coverage/validation",
      thresholds: { 100: true },
    },
  },
});
