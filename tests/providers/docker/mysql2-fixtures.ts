/**
 * Shared MySQL2 provider fixtures.
 *
 * The mysql2 provider suite is split across sibling `mysql2*.test.ts` files so
 * each one fits the 1280 MB TypeScript shard heap. The driver factory, its
 * namespace attestation and the drop-everything reset are the only things all
 * of them share, so they live here rather than being restated in each piece.
 * This file is deliberately NOT named `*.test.ts`: Vitest must not collect it.
 */

import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

export const TEST_CONNECTION_STRING = process.env.MYSQL_TEST_CONNECTION_STRING;

/**
 * The connection string carries the database, so this driver is namespace-bound
 * from its URL path. The attestation is the SECOND, independent fact effectful
 * live migration work requires (plan §5.3): it asserts that nothing between the
 * client and the server reinterprets a qualified `database.table`. It is true
 * here by construction — a docker `mysql:8` reached directly on 3307 is not
 * behind VTGate or a rewriting proxy — and stating it is what admits `syncLiveSchema()`.
 */
export function createMySQL2Driver(): MySQL2Driver {
  return new MySQL2Driver({
    databaseUrl: TEST_CONNECTION_STRING,
    migrationNamespaceAttestation: "non-redirecting",
  });
}

/**
 * The shared behavior suites assume a fresh database (the local drivers are
 * in-memory). MySQL persists between tests, so drop everything first: pushing
 * an empty schema diffs to dropTable for every existing table.
 */
export async function dropEveryLiveTable(): Promise<void> {
  const client = createClient({ schema: {}, driver: createMySQL2Driver() });
  await syncLiveSchema(client);
  await client.$disconnect();
}
