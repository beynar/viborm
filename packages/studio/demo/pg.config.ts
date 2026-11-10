// `viborm studio --config studio/demo/pg.config.ts` after `node studio/demo/seed.ts pg`.
// STUDIO_DEMO_PG_URL names the database; the default is a local one.
import { defineConfig } from "viborm/config";
import { createClient } from "viborm/pg";
import { schema } from "./schema";

export const client = createClient({
  schema,
  databaseUrl:
    process.env.STUDIO_DEMO_PG_URL ??
    "postgresql://postgres:password@127.0.0.1:5434/viborm_studio_demo",
});

export default defineConfig({ client });
