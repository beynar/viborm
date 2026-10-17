/**
 * K5 against the oracle on a real MySQL server (plan §7 "My": W-EV1..W-EV4,
 * W-F1..W-F8), in a database of its own (`viborm_permissions_u7_<random>`, dropped
 * after), over the sampled actors; see `permissions-evidence-behavior.ts`.
 *
 * NOTE: These tests require a running MySQL database
 * (MYSQL_TEST_CONNECTION_STRING).
 */

import { randomBytes } from "node:crypto";
import { MySQL2Driver } from "@drivers/mysql2";
import { runPermissionsEvidenceBehavior } from "@tests/contracts/public-client/permissions-evidence-behavior";
import { SAMPLED_ACTORS } from "@tests/contracts/public-client/permissions-sampled-actors";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { createConnection } from "mysql2/promise";
import { describe } from "vitest";
import { TEST_CONNECTION_STRING } from "./mysql2-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const database = `viborm_permissions_u7_${randomBytes(5).toString("hex")}`;

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
  runPermissionsEvidenceBehavior({
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
    actors: SAMPLED_ACTORS,
    timeout: 600_000,
  });
});
