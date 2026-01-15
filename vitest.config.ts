import { resolve } from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
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
    },
  },
});
