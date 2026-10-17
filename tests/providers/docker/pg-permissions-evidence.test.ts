/**
 * K5 against the oracle on a real PostgreSQL server (plan §7 "PG":
 * W-EV1..W-EV4, W-F1..W-F8), in a schema of its own (`viborm_permissions_u7_<random>`,
 * dropped after), over the sampled actors; see `permissions-evidence-behavior.ts`.
 *
 * NOTE: These tests require a running PostgreSQL database
 * (PG_TEST_CONNECTION_STRING).
 */

import { randomBytes } from "node:crypto";
import { PgDriver } from "@drivers/pg";
import { runPermissionsEvidenceBehavior } from "@tests/contracts/public-client/permissions-evidence-behavior";
import { SAMPLED_ACTORS } from "@tests/contracts/public-client/permissions-sampled-actors";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import pg from "pg";
import { describe } from "vitest";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const namespace = `viborm_permissions_u7_${randomBytes(5).toString("hex")}`;

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
  runPermissionsEvidenceBehavior({
    name: "pg",
    createDriver: () =>
      new PgDriver({ databaseUrl: TEST_CONNECTION_STRING, namespace }),
    prepare: async (client) => {
      await admin(`CREATE SCHEMA "${namespace}"`);
      await syncLiveSchema(client);
    },
    release: () => admin(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`),
    actors: SAMPLED_ACTORS,
    // The server plans each correlated recursive predicate afresh.
    timeout: 900_000,
  });
});
