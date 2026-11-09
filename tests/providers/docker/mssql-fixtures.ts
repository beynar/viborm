/**
 * Shared SQL Server provider fixtures. This file is deliberately NOT named
 * `*.test.ts`: Vitest must not collect it.
 */

import { createClient } from "@client/client";
import { MssqlDriver } from "@drivers/mssql";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

export const TEST_CONNECTION_STRING = process.env.MSSQL_TEST_CONNECTION_STRING;

/** The connection string carries the database; the schema is `dbo`. */
export function createMssqlDriver(): MssqlDriver {
  return new MssqlDriver({ databaseUrl: TEST_CONNECTION_STRING });
}

/**
 * The shared behavior suites assume a fresh database. SQL Server persists
 * between tests, so drop everything first: pushing an empty schema drops
 * every table of the schema (`pushMssqlSchema`).
 */
export async function dropEveryLiveTable(): Promise<void> {
  const client = createClient({ schema: {}, driver: createMssqlDriver() });
  await syncLiveSchema(client);
  await client.$disconnect();
}
