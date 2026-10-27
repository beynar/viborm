// `viborm studio --config studio/demo/sqlite.config.ts` after `node studio/demo/seed.ts sqlite`.
import { fileURLToPath } from "node:url";
import { defineConfig } from "viborm/config";
import { createClient } from "viborm/sqlite3";
import { schema } from "./schema";

export const client = createClient({
  schema,
  dataDir: fileURLToPath(new URL("./demo.db", import.meta.url)),
});

export default defineConfig({ client });
