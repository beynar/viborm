import { defineConfig } from "prisma/config";

// Prisma 7 moved connection URLs out of schema files. The comparison harness's
// client connects through its driver adapter (prisma/prismaClient.ts); this
// config only points the CLI at the schema and gives Migrate/db-push its URL.
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://postgres:password@localhost:2222/baseorm",
  },
});
