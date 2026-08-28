import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { PgDriver } from "@drivers/pg";
import { TransactionError } from "@errors";

import { describe, expect, test } from "vitest";
import {
  runSkipSelectCaptureBehavior,
  skipSelectCaptureSchema,
  skipSelectCaptureTables,
} from "@tests/contracts/engine/write/skip-select-capture-behavior";

import { syncLiveSchema } from "@tests/fixtures/sync-schema";
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
const NO_ROLLBACK = /public result parsing cannot be rolled back/;

runSkipSelectCaptureBehavior({
  name: "Docker MySQL",
  createDriver: () => new MySQL2Driver({ databaseUrl: MYSQL as string }),
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
 * THE ATOMIC BATCH STAYS REFUSED, on the driver the absorption is about.
 *
 * A non-returning driver forced onto the batch substrate cannot hand these rows back at
 * all — public result parsing happens after the atomic unit commits and cannot be rolled
 * back (ATOM §7, the constructor's own refusal). That answer comes first and covers this
 * shape whole, so the skip effect's separate wall
 * (`OperationExecutor.compileToEntries`: "carries an onUniqueConflict skip effect that has
 * no atomic-batch lowering") never has to speak. Both reasons point the same way; a second
 * skip-specific throw would be a redundant guard, so there is not one — and this witness
 * pins WHICH refusal answers, so a future edit cannot quietly swap it for a raw driver
 * error.
 */
(MYSQL ? describe : describe.skip)(
  "E6.9 — the atomic batch stays refused (Docker MySQL)",
  () => {
    test(
      "a batch-only non-returning driver refuses the whole select arm, typed",
      { timeout: 120_000 },
      async () => {
        class BatchOnlyMySQLDriver extends MySQL2Driver {
          override readonly supportsTransactions = false;
          override readonly supportsBatch = true;
        }
        const setupClient = createClient({
          schema: skipSelectCaptureSchema,
          driver: new MySQL2Driver({ databaseUrl: MYSQL as string }),
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
          driver: new BatchOnlyMySQLDriver({ databaseUrl: MYSQL as string }),
        });
        try {
          await expect(
            client.widget.createMany({
              data: [{ sku: "batch", name: "n" }],
              skipDuplicates: true,
              select: { id: true, sku: true },
            })
          ).rejects.toThrow(TransactionError);
          await expect(
            client.widget.createMany({
              data: [{ sku: "batch", name: "n" }],
              skipDuplicates: true,
              select: { id: true, sku: true },
            })
          ).rejects.toThrow(NO_ROLLBACK);
        } finally {
          await client.$disconnect();
        }
      }
    );
  }
);
