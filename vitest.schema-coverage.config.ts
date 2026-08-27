import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: [
        "src/schema/field-ref.ts",
        "src/schema/hydration.ts",
        // The identifier grammar every schema name and every database
        // namespace is admitted by.
        "src/schema/identifier.ts",
        "src/schema/json/**/*.ts",
        // Lifted out of `json/` when `s.model(...)`'s member maps became its
        // second consumer; the gate follows the file rather than the folder.
        "src/schema/record.ts",
      ],
      processingConcurrency: 1,
      reporter: ["text", "json-summary", "lcov", "html"],
      reportsDirectory: "coverage/schema",
      thresholds: { 100: true },
    },
  },
});
