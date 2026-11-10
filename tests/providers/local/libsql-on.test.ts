/**
 * libSQL Driver Tests — `viborm/on` on an in-memory libSQL database. Its
 * tables are created from the statements the SQLite3 driver plans for the
 * same schema: libSQL declares no migration capability of its own.
 */

import { createClient } from "@src/index";
import {
  onSchema,
  runOnBehavior,
} from "@tests/contracts/public-client/on-behavior";
import { createInMemoryLibSQLDriver } from "@tests/fixtures/drivers/libsql";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

describe("libSQL Driver", () => {
  runOnBehavior({
    name: "libSQL",
    createDriver: createInMemoryLibSQLDriver,
    sync: async (base) => {
      const planner = createClient({
        schema: onSchema(),
        driver: createInMemorySQLite3Driver(),
      });
      const { sql } = await syncLiveSchema(planner, { dryRun: true });
      await planner.$disconnect();
      for (const statement of sql) await base.$executeRawUnsafe(statement);
    },
  });
});
