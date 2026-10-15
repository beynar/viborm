/**
 * MySQL2 Driver Tests — K4, the produced row (rbac plan §4.4, R4, OD-13) on a
 * real MySQL server, which returns no row from an INSERT (the key comes back
 * as the insert id) and refuses to read a table from a subquery of its own
 * UPDATE: tests/contracts/engine/query/produced-row-behavior.ts, in a database
 * of its own per test (`viborm_rbac_u6_<random>`, dropped after).
 *
 * NOTE: These tests require a running MySQL database
 * (MYSQL_TEST_CONNECTION_STRING).
 */

import { randomBytes } from "node:crypto";
import { MySQL2Driver } from "@drivers/mysql2";
import { runProducedRowBehavior } from "@tests/contracts/engine/query/produced-row-behavior";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { createConnection } from "mysql2/promise";
import { describe } from "vitest";
import { TEST_CONNECTION_STRING } from "./mysql2-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
let database = "";

function databaseUrl(): string {
  const url = new URL(TEST_CONNECTION_STRING as string);
  url.pathname = `/${database}`;
  return url.toString();
}

async function admin(statement: string): Promise<void> {
  const connection = await createConnection(TEST_CONNECTION_STRING as string);
  try {
    await connection.query(statement);
  } finally {
    await connection.end();
  }
}

describeIf("MySQL2 Driver", () => {
  runProducedRowBehavior({
    name: "MySQL2",
    createDriver: () => {
      database = `viborm_rbac_u6_${randomBytes(5).toString("hex")}`;
      return new MySQL2Driver({
        databaseUrl: databaseUrl(),
        migrationNamespaceAttestation: "non-redirecting",
      });
    },
    prepare: async (client) => {
      await admin(`CREATE DATABASE \`${database}\``);
      await syncLiveSchema(client);
    },
    release: () => admin(`DROP DATABASE IF EXISTS \`${database}\``),
  });
});
