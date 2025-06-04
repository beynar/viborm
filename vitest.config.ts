import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@types": new URL("./src/types/index.ts", import.meta.url).pathname,
      "@types/*": new URL("./src/types/*", import.meta.url).pathname,
      "@schema": new URL("./src/schema/index.ts", import.meta.url).pathname,
      "@schema/*": new URL("./src/schema/*", import.meta.url).pathname,
      "@query-parser": new URL("./src/query-parser/index.ts", import.meta.url)
        .pathname,
      "@query-parser/*": new URL("./src/query-parser/*", import.meta.url)
        .pathname,
      "@adapters": new URL("./src/adapters/index.ts", import.meta.url).pathname,
      "@adapters/*": new URL("./src/adapters/*", import.meta.url).pathname,
      "@sql": new URL("./src/sql/sql.ts", import.meta.url).pathname,
      "@standard-schema": new URL("./src/standardSchema.ts", import.meta.url)
        .pathname,
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test-d.ts"],
    globals: true,
    typecheck: {
      enabled: false,
      include: ["tests/**/*.test.ts"],
    },
  },
});
