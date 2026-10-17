/**
 * MySQL2 Driver Tests — K4 on the Permissions acceptance estate (plan §4.4, §7 "My",
 * W-P1..W-P16), in a database of its own (`viborm_permissions_u6_<random>`, dropped
 * after), judged against the oracle over the sampled actors.
 *
 * NOTE: These tests require a running MySQL database
 * (MYSQL_TEST_CONNECTION_STRING).
 */

import { randomBytes } from "node:crypto";
import { MySQL2Driver } from "@drivers/mysql2";
import { runPermissionsAppPlacement } from "@tests/contracts/public-client/permissions-app-placement";
import { SAMPLED_ACTORS } from "@tests/contracts/public-client/permissions-sampled-actors";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { createConnection } from "mysql2/promise";
import { describe } from "vitest";
import { TEST_CONNECTION_STRING } from "./mysql2-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const database = `viborm_permissions_u6_${randomBytes(5).toString("hex")}`;

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
  runPermissionsAppPlacement({
    name: "MySQL2",
    createDriver: () =>
      new MySQL2Driver({
        databaseUrl: databaseUrl(),
        migrationNamespaceAttestation: "non-redirecting",
      }),
    prepare: async (client) => {
      await admin(`CREATE DATABASE \`${database}\``);
      await syncLiveSchema(client);
    },
    release: () => admin(`DROP DATABASE IF EXISTS \`${database}\``),
    actors: SAMPLED_ACTORS,
    timeout: 1_800_000,
  });
});
