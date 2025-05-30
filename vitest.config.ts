import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test-d.ts"],
    globals: true,
    typecheck: {
      enabled: true,
      include: ["tests/**/*.test.ts"],
    },
  },
});
