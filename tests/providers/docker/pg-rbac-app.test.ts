/**
 * pg Driver Tests — the RBAC acceptance estate (plan §6.1 U0, §7 "PG") on a
 * real PostgreSQL server: the §1.1 fixture pushed and seeded in a schema of
 * its own (`viborm_rbac_<random>`, dropped after), the hand-written policy
 * against the independent oracle.
 *
 * NOTE: These tests require a running PostgreSQL database
 * (PG_TEST_CONNECTION_STRING).
 */

import { randomBytes } from "node:crypto";
import { PgDriver } from "@drivers/pg";
import { runRbacAppBehavior } from "@tests/contracts/public-client/rbac-app-behavior";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import pg from "pg";
import { describe } from "vitest";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const namespace = `viborm_rbac_${randomBytes(5).toString("hex")}`;

async function admin(statement: string): Promise<void> {
  const connection = new pg.Client({
    connectionString: TEST_CONNECTION_STRING,
  });
  await connection.connect();
  try {
    await connection.query(statement);
  } finally {
    await connection.end();
  }
}

describeIf("pg Driver", () => {
  runRbacAppBehavior({
    name: "pg",
    createDriver: () =>
      new PgDriver({ databaseUrl: TEST_CONNECTION_STRING, namespace }),
    prepare: async (client) => {
      await admin(`CREATE SCHEMA "${namespace}"`);
      await syncLiveSchema(client);
    },
    release: () => admin(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`),
    // The server plans each correlated recursive predicate afresh: an actor's
    // 37 reads measured up to 20 s here, against under 2 s on PGlite.
    timeout: 300_000,
  });
});
