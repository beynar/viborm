/**
 * Shared setup for the postgres.js provider suite.
 *
 * The suite is split across several `postgres*.test.ts` files because one
 * program holding every behavior schema cannot be typechecked inside the fixed
 * 1280 MB shard heap. Everything more than one piece needs lives here, in a
 * module deliberately NOT named `*.test.ts` so Vitest does not collect it.
 */

import {
  createClient as PostgresCreateClient,
  PostgresDriver,
} from "@drivers/postgres";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe } from "vitest";

// Skip tests if no PostgreSQL connection is available
export const TEST_CONNECTION_STRING = process.env.PG_TEST_CONNECTION_STRING;

export const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

export function createPostgresDriver(): PostgresDriver {
  return new PostgresDriver({ databaseUrl: TEST_CONNECTION_STRING });
}

/**
 * The tests below assume a fresh database. PostgreSQL persists between
 * tests, so drop everything first: pushing an empty schema diffs to
 * dropTable for every existing table. (Same pattern as mysql2.test.ts.)
 */
export async function dropEveryTable(): Promise<void> {
  const cleanupClient = PostgresCreateClient({
    schema: {},
    databaseUrl: TEST_CONNECTION_STRING,
    postgis: true,
  });
  await syncLiveSchema(cleanupClient);
  await cleanupClient.$disconnect();
}
