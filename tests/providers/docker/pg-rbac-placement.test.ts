/**
 * pg Driver Tests — K4 on the RBAC acceptance estate (plan §4.4, §7 "PG",
 * W-P1..W-P16) on a real PostgreSQL server, in a schema of its own
 * (`viborm_rbac_u6_<random>`, dropped after), judged against the oracle over
 * the sampled actors.
 *
 * NOTE: These tests require a running PostgreSQL database
 * (PG_TEST_CONNECTION_STRING).
 */

import { randomBytes } from "node:crypto";
import { PgDriver } from "@drivers/pg";
import { runRbacAppPlacement } from "@tests/contracts/public-client/rbac-app-placement";
import { SAMPLED_ACTORS } from "@tests/contracts/public-client/rbac-sampled-actors";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import pg from "pg";
import { describe } from "vitest";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const namespace = `viborm_rbac_u6_${randomBytes(5).toString("hex")}`;

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
  runRbacAppPlacement({
    name: "pg",
    createDriver: () =>
      new PgDriver({ databaseUrl: TEST_CONNECTION_STRING, namespace }),
    prepare: async (client) => {
      await admin(`CREATE SCHEMA "${namespace}"`);
      await syncLiveSchema(client);
    },
    release: () => admin(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`),
    actors: SAMPLED_ACTORS,
    timeout: 1_800_000,
  });
});
