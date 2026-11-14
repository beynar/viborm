import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { PgDriver } from "@drivers/pg";
import { UnsupportedOperationError } from "@errors";
import {
  runSkipSelectCaptureBehavior,
  skipSelectCaptureSchema,
  skipSelectCaptureTables,
} from "@tests/contracts/engine/write/skip-select-capture-behavior";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

/**
 * E6.9 on the live servers.
 *
 * MySQL is the whole point: it is the only driver in the matrix with no `RETURNING`, so it
 * is the one this shape was refused on and the one the capture actually runs on.
 * PostgreSQL is the CONTROL — the same six answers through the one-statement
 * `INSERT … ON CONFLICT DO NOTHING RETURNING …` fast path, which the absorption must not
 * have touched.
 *
 * Requires the Docker test databases:
 *   MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm
 *   PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:5434/viborm
 */

const PG = process.env.PG_TEST_CONNECTION_STRING;
const MYSQL = process.env.MYSQL_TEST_CONNECTION_STRING;
const NO_SAVEPOINT = /a member savepoint is required/;

runSkipSelectCaptureBehavior({
  name: "Docker MySQL",
  createDriver: () =>
    new MySQL2Driver({
      databaseUrl: MYSQL as string,
      migrationNamespaceAttestation: "non-redirecting",
    }),
  dropTablesFirst: true,
  supportsReturning: false,
  register: MYSQL ? describe : describe.skip,
});

runSkipSelectCaptureBehavior({
  name: "Docker PostgreSQL",
  createDriver: () => new PgDriver({ databaseUrl: PG as string }),
  dropTablesFirst: true,
  supportsReturning: true,
  register: PG ? describe : describe.skip,
});

/**
 * A batch-only driver has no savepoint, and MySQL passes a duplicate row by
 * only inside one: the call is refused before it writes, as documented
 * (`create-many.mdx`). The test expected `TransactionError` and a sentence of
 * an engine that is gone; it failed on 1.14.0 too, where it never ran (its
 * MySQL driver could not create its tables).
 */
(MYSQL ? describe : describe.skip)(
  "E6.9 — the atomic batch stays refused (Docker MySQL)",
  () => {
    test(
      "a batch-only driver that cannot pass a duplicate by refuses the call, typed",
      { timeout: 120_000 },
      async () => {
        class BatchOnlyMySQLDriver extends MySQL2Driver {
          override readonly supportsTransactions = false;
          override readonly supportsBatch = true;
        }
        const setupClient = createClient({
          schema: skipSelectCaptureSchema,
          driver: new MySQL2Driver({
            databaseUrl: MYSQL as string,
            migrationNamespaceAttestation: "non-redirecting",
          }),
        });
        for (const table of skipSelectCaptureTables) {
          await (setupClient as any).$executeRawUnsafe(
            `DROP TABLE IF EXISTS ${table}`
          );
        }
        await syncLiveSchema(setupClient);
        await setupClient.$disconnect();

        const client = createClient({
          schema: skipSelectCaptureSchema,
          driver: new BatchOnlyMySQLDriver({
            databaseUrl: MYSQL as string,
            migrationNamespaceAttestation: "non-redirecting",
          }),
        });
        try {
          await expect(
            client.widget.createMany({
              data: [{ sku: "batch", name: "n" }],
              skipDuplicates: true,
              select: { id: true, sku: true },
            })
          ).rejects.toThrow(UnsupportedOperationError);
          await expect(
            client.widget.createMany({
              data: [{ sku: "batch", name: "n" }],
              skipDuplicates: true,
              select: { id: true, sku: true },
            })
          ).rejects.toThrow(NO_SAVEPOINT);
        } finally {
          await client.$disconnect();
        }
      }
    );
  }
);
