/**
 * Shared pg provider fixtures.
 *
 * The pg provider suite is split across sibling `pg*.test.ts` files so each one
 * fits the 1280 MB TypeScript shard heap. The connection string and the
 * drop-everything reset are the only things all of them share, so they live
 * here rather than being restated in each piece. This file is deliberately NOT
 * named `*.test.ts`: Vitest must not collect it.
 */

import { createClient as PgCreateClient } from "@drivers/pg";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

// Skip tests if no PostgreSQL connection is available
export const TEST_CONNECTION_STRING = process.env.PG_TEST_CONNECTION_STRING;

/**
 * The shared behavior suites and client-integration tests assume a fresh
 * database. PostgreSQL persists between tests, so drop everything first:
 * pushing an empty schema diffs to dropTable for every existing table.
 * (Same pattern as mysql2.test.ts.)
 */
export async function dropEveryLiveTable(): Promise<void> {
  const cleanupClient = PgCreateClient({
    schema: {},
    databaseUrl: TEST_CONNECTION_STRING,
    postgis: true,
  });
  await syncLiveSchema(cleanupClient);
  await cleanupClient.$disconnect();
}
