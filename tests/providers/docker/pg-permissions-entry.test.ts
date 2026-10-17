/**
 * `viborm/permissions` itself on a real PostgreSQL server (plan §7 "PG"), in a
 * schema of its own (`viborm_permissions_entry_<random>`, dropped after): the entry
 * against the oracle (`permissions-entry-behavior.ts`) over the sampled actors, and
 * the verbs witnesses re-run through it (`permissions-app-verbs.ts`).
 *
 * NOTE: These tests require a running PostgreSQL database
 * (PG_TEST_CONNECTION_STRING).
 */

import { randomBytes } from "node:crypto";
import { PgDriver } from "@drivers/pg";
import { runPermissionsAppVerbs } from "@tests/contracts/public-client/permissions-app-verbs";
import { runPermissionsEntryBehavior } from "@tests/contracts/public-client/permissions-entry-behavior";
import { SAMPLED_ACTORS } from "@tests/contracts/public-client/permissions-sampled-actors";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import pg from "pg";
import { describe } from "vitest";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const namespace = `viborm_permissions_entry_${randomBytes(5).toString("hex")}`;

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

const substrate = {
  name: "pg",
  createDriver: () =>
    new PgDriver({ databaseUrl: TEST_CONNECTION_STRING, namespace }),
  prepare: async (client: Parameters<typeof syncLiveSchema>[0]) => {
    await admin(`CREATE SCHEMA "${namespace}"`);
    await syncLiveSchema(client);
  },
  release: () => admin(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`),
  // The server plans each correlated recursive predicate afresh.
  timeout: 900_000,
};

describeIf("pg Driver", () => {
  runPermissionsEntryBehavior({
    ...substrate,
    actors: SAMPLED_ACTORS,
    exhaustive: process.env.VIBORM_PERMISSIONS_ACTORS === "all",
  });
  runPermissionsAppVerbs(substrate, { through: "entry" });
});
