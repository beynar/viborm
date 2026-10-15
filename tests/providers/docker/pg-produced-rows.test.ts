/**
 * pg Driver Tests — K4, the produced row (rbac plan §4.4, R4, OD-13) on a real
 * PostgreSQL server, in a schema of its own per test (`viborm_rbac_u6_<random>`,
 * dropped after): tests/contracts/engine/query/produced-row-behavior.ts.
 *
 * NOTE: These tests require a running PostgreSQL database
 * (PG_TEST_CONNECTION_STRING).
 */

import { randomBytes } from "node:crypto";
import { PgDriver } from "@drivers/pg";
import { runProducedRowBehavior } from "@tests/contracts/engine/query/produced-row-behavior";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import pg from "pg";
import { describe } from "vitest";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
let namespace = "";

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
  runProducedRowBehavior({
    name: "pg",
    createDriver: () => {
      namespace = `viborm_rbac_u6_${randomBytes(5).toString("hex")}`;
      return new PgDriver({ databaseUrl: TEST_CONNECTION_STRING, namespace });
    },
    prepare: async (client) => {
      await admin(`CREATE SCHEMA "${namespace}"`);
      await syncLiveSchema(client);
    },
    release: () => admin(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`),
  });
});
