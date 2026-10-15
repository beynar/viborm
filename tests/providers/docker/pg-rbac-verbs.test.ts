/**
 * pg Driver Tests — K3 on the RBAC acceptance estate (plan §4.3, §7 "PG") on
 * a real PostgreSQL server, in a schema of its own (`viborm_rbac_verbs_<random>`,
 * dropped after): verbs and written fields judged against the oracle.
 *
 * NOTE: These tests require a running PostgreSQL database
 * (PG_TEST_CONNECTION_STRING).
 */

import { randomBytes } from "node:crypto";
import { PgDriver } from "@drivers/pg";
import { runRbacAppVerbs } from "@tests/contracts/public-client/rbac-app-verbs";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import pg from "pg";
import { describe } from "vitest";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const namespace = `viborm_rbac_verbs_${randomBytes(5).toString("hex")}`;

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
  runRbacAppVerbs({
    name: "pg",
    createDriver: () =>
      new PgDriver({ databaseUrl: TEST_CONNECTION_STRING, namespace }),
    prepare: async (client) => {
      await admin(`CREATE SCHEMA "${namespace}"`);
      await syncLiveSchema(client);
    },
    release: () => admin(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`),
    // The server plans each correlated recursive predicate afresh.
    timeout: 600_000,
  });
});
