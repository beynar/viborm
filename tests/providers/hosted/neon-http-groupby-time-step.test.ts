/**
 * Neon HTTP: `groupBy` by a time step on a real Neon database, every case of
 * the PostgreSQL behavior, one HTTP request per statement.
 *
 * The tables are created if missing and emptied at the end, never dropped:
 * the database is shared.
 */

import { NeonHTTPDriver } from "@drivers/neon-http";
import { runGroupByTimeStepBehavior } from "@tests/contracts/engine/query/groupby-time-step-behavior";

const databaseUrl = process.env.NEON_TEST_DATABASE_URL;
const TABLE = "viborm_groupby_time_step";

describe.skipIf(!databaseUrl)("Neon HTTP Driver", () => {
  runGroupByTimeStepBehavior({
    name: "neon-http",
    table: TABLE,
    createDriver: () => new NeonHTTPDriver({ databaseUrl }),
    prepare: async (driver, table) => {
      await driver._executeRaw(
        `CREATE TABLE IF NOT EXISTS "public"."${table}" (id INTEGER PRIMARY KEY, "orgId" TEXT NOT NULL, statut TEXT NOT NULL, montant INTEGER NOT NULL, date TIMESTAMPTZ(3) NOT NULL, "dueAt" TIMESTAMPTZ(3), wall TIMESTAMP(3) NOT NULL, jour DATE NOT NULL, "deletedAt" TIMESTAMPTZ(3))`
      );
      await driver._executeRaw(
        `CREATE TABLE IF NOT EXISTS "public"."${table}_d" (id INTEGER PRIMARY KEY, "orgId" TEXT NOT NULL, montant INTEGER NOT NULL, date TIMESTAMPTZ(3) NOT NULL)`
      );
    },
  });
});
