/**
 * The RBAC acceptance estate on PlanetScale's Neki itself (plan §6.1 U0, §7
 * "Nk": the recursion runs): the §1.1 fixture pushed and seeded in a schema of
 * its own (`viborm_rbac_<random>`, dropped after, and the drop verified), the
 * hand-written policy, whose document and team arms recurse, against the
 * independent oracle for a sample of actors.
 *
 * Runs only with NEKI_DEV_CONNECTION_STRING (a Neki development branch).
 */

import { randomBytes } from "node:crypto";
import { PgDriver } from "@drivers/pg";
import { runRbacAppBehavior } from "@tests/contracts/public-client/rbac-app-behavior";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import pg from "pg";
import { describe } from "vitest";

const NEKI_URL = process.env.NEKI_DEV_CONNECTION_STRING;
const TIMEOUT = 300_000;

/** node-postgres reads `sslrootcert=system` as a file: verify against the system store instead. */
function poolConfig(url: string): pg.PoolConfig {
  const parsed = new URL(url);
  parsed.searchParams.delete("sslrootcert");
  parsed.searchParams.delete("sslmode");
  return {
    connectionString: parsed.toString(),
    ssl: { rejectUnauthorized: true },
    max: 4,
  };
}

const namespace = `viborm_rbac_${randomBytes(5).toString("hex")}`;

async function admin<T extends pg.QueryResultRow>(
  statement: string,
  values: unknown[] = []
): Promise<T[]> {
  const connection = new pg.Client(poolConfig(NEKI_URL as string));
  await connection.connect();
  try {
    return (await connection.query<T>(statement, values)).rows;
  } finally {
    await connection.end();
  }
}

describe.skipIf(!NEKI_URL)("Neki", () => {
  runRbacAppBehavior({
    name: "Neki",
    createDriver: () =>
      new PgDriver({ options: poolConfig(NEKI_URL as string), namespace }),
    prepare: async (client) => {
      await admin(`CREATE SCHEMA "${namespace}"`);
      await syncLiveSchema(client);
    },
    release: async () => {
      await admin(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      const [left] = await admin<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_catalog.pg_namespace WHERE nspname = $1",
        [namespace]
      );
      if (left?.n !== 0) throw new Error(`the schema ${namespace} was left`);
    },
    actors: [
      "u01",
      "u05",
      "u22",
      "u46",
      "k05-documents-share",
      "k21-everything",
    ],
    timeout: TIMEOUT,
  });
});
