/**
 * `viborm/rbac` itself on a real MySQL server (plan §7 "My"), in a database
 * of its own (`viborm_rbac_entry_<random>`, dropped after): the entry against
 * the oracle (`rbac-entry-behavior.ts`) over the sampled actors, and the
 * verbs witnesses re-run through it (`rbac-app-verbs.ts`).
 *
 * NOTE: These tests require a running MySQL database
 * (MYSQL_TEST_CONNECTION_STRING).
 */

import { randomBytes } from "node:crypto";
import { MySQL2Driver } from "@drivers/mysql2";
import { runRbacAppVerbs } from "@tests/contracts/public-client/rbac-app-verbs";
import { runRbacEntryBehavior } from "@tests/contracts/public-client/rbac-entry-behavior";
import { SAMPLED_ACTORS } from "@tests/contracts/public-client/rbac-sampled-actors";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { createConnection } from "mysql2/promise";
import { describe } from "vitest";
import { TEST_CONNECTION_STRING } from "./mysql2-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const database = `viborm_rbac_entry_${randomBytes(5).toString("hex")}`;

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

const substrate = {
  name: "MySQL2",
  createDriver: () =>
    new MySQL2Driver({
      databaseUrl: databaseUrl(),
      // A docker `mysql:8` reached directly: nothing rewrites `database.table`.
      migrationNamespaceAttestation: "non-redirecting",
    }),
  prepare: async (client: Parameters<typeof syncLiveSchema>[0]) => {
    await admin(`CREATE DATABASE \`${database}\``);
    await syncLiveSchema(client);
  },
  release: () => admin(`DROP DATABASE IF EXISTS \`${database}\``),
  timeout: 900_000,
};

describeIf("MySQL2 Driver", () => {
  runRbacEntryBehavior({
    ...substrate,
    actors: SAMPLED_ACTORS,
    exhaustive: process.env.VIBORM_RBAC_ACTORS === "all",
  });
  runRbacAppVerbs(substrate, { through: "entry" });
});
