import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/schema/scalars/**/*.ts"],
      processingConcurrency: 1,
      reporter: ["text", "json-summary", "lcov", "html"],
      reportsDirectory: "coverage/scalars",
      thresholds: { 100: true },
    },
  },
});
