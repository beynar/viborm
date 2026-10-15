/**
 * MySQL2 Driver Tests — K3 on the RBAC acceptance estate (plan §4.3, §7
 * "My"), in a database of its own (`viborm_rbac_verbs_<random>`, dropped
 * after): verbs and written fields judged against the oracle.
 *
 * NOTE: These tests require a running MySQL database
 * (MYSQL_TEST_CONNECTION_STRING).
 */

import { randomBytes } from "node:crypto";
import { MySQL2Driver } from "@drivers/mysql2";
import { runRbacAppVerbs } from "@tests/contracts/public-client/rbac-app-verbs";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { createConnection } from "mysql2/promise";
import { describe } from "vitest";
import { TEST_CONNECTION_STRING } from "./mysql2-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const database = `viborm_rbac_verbs_${randomBytes(5).toString("hex")}`;

/** The suite's own database: the server's URL with its path replaced. */
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
  runRbacAppVerbs({
    name: "MySQL2",
    createDriver: () =>
      new MySQL2Driver({
        databaseUrl: databaseUrl(),
        // A docker `mysql:8` reached directly: nothing rewrites `database.table`.
        migrationNamespaceAttestation: "non-redirecting",
      }),
    prepare: async (client) => {
      await admin(`CREATE DATABASE \`${database}\``);
      await syncLiveSchema(client);
    },
    release: () => admin(`DROP DATABASE IF EXISTS \`${database}\``),
    timeout: 600_000,
  });
});
