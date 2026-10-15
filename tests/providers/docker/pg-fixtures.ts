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

/**
 * The server as configured: its own `jit` setting. Only the JIT cost witness
 * (`pg-jit-cost.test.ts`) connects through it.
 */
export const SERVER_CONNECTION_STRING = process.env.PG_TEST_CONNECTION_STRING;

/**
 * `url`'s sessions with PostgreSQL's JIT off, whatever else its `options`
 * set. A governed statement (an OR of correlated EXISTS) is estimated over
 * the JIT thresholds on tables nobody ANALYZEd, and the server then compiles
 * thousands of functions per statement: 1.9 s for a one-row lookup, 21-25 s
 * for a policy write, the rbac runs 40+ minutes against about one without
 * (E4, `rbac/e4/pg-cost.md`). The statements and their answers are the same.
 */
function withJitOff(url: string): string {
  const parsed = new URL(url);
  const options = parsed.searchParams.get("options");
  parsed.searchParams.set(
    "options",
    options ? `${options} -c jit=off` : "-c jit=off"
  );
  return parsed.href;
}

// Skip tests if no PostgreSQL connection is available
export const TEST_CONNECTION_STRING =
  SERVER_CONNECTION_STRING && withJitOff(SERVER_CONNECTION_STRING);

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
