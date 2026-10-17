/**
 * The compiled §1.1 policy against the oracle on a real PostgreSQL server
 * (plan §7 "PG": W-H1, W-A1..W-A6), in a schema of its own
 * (`viborm_permissions_compiled_<random>`, dropped after); see
 * `permissions-compiled-policy-behavior.ts`. A sample of the actors: the server plans each
 * correlated recursive predicate afresh (an actor's reads take seconds here).
 *
 * NOTE: These tests require a running PostgreSQL database
 * (PG_TEST_CONNECTION_STRING).
 */

import { randomBytes } from "node:crypto";
import { PgDriver } from "@drivers/pg";
import { runCompiledPolicyBehavior } from "@tests/contracts/public-client/permissions-compiled-policy-behavior";
import { SAMPLED_ACTORS } from "@tests/contracts/public-client/permissions-sampled-actors";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import pg from "pg";
import { describe } from "vitest";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const namespace = `viborm_permissions_compiled_${randomBytes(5).toString("hex")}`;

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
  runCompiledPolicyBehavior({
    name: "pg",
    createDriver: () =>
      new PgDriver({ databaseUrl: TEST_CONNECTION_STRING, namespace }),
    prepare: async (client) => {
      await admin(`CREATE SCHEMA "${namespace}"`);
      await syncLiveSchema(client);
    },
    release: () => admin(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`),
    actors: SAMPLED_ACTORS,
    timeout: 600_000,
  });
});
