/**
 * libSQL Driver Tests — `viborm/ordering` on an in-memory libSQL database.
 * Its tables are created from the statements the SQLite3 driver plans for the
 * same schema: libSQL declares no migration capability of its own.
 */

import { createClient } from "@src/index";
import {
  describeOrdering,
  schema,
} from "@tests/contracts/public-client/ordering-behavior";
import { createInMemoryLibSQLDriver } from "@tests/fixtures/drivers/libsql";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

describe("libSQL Driver", () => {
  describeOrdering("libSQL", async () => {
    const planner = createClient({
      schema,
      driver: createInMemorySQLite3Driver(),
    });
    const { sql } = await syncLiveSchema(planner, { dryRun: true });
    await planner.$disconnect();
    const client = createClient({
      schema,
      driver: createInMemoryLibSQLDriver(),
    });
    for (const statement of sql) await client.$executeRawUnsafe(statement);
    return { client };
  });
});
