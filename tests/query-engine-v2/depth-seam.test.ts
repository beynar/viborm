import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { describe } from "vitest";
import { runDepthSeamBehavior } from "./depth-seam-behavior";

/**
 * N4 — the depth seams, on the always-available substrate pair.
 *
 * The shared suite (`depth-seam-behavior.ts`, run here and by every driver leg)
 * carries the assertions. This file only supplies the two PGlite substrates, so the
 * whole N4 surface is exercised on `pnpm test` without a container: a real
 * transaction, and a driver forced to lower the same plan into a single atomic batch.
 */
class BatchOnlyPGliteDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(
          await this.executeRaw<T>(transaction, query.sql, query.params)
        );
      }
      return results;
    });
  }
}

describe("N4 — depth-seam boundaries (PGlite)", () => {
  runDepthSeamBehavior({
    name: "PGlite transaction",
    createDriver: () => new PGliteDriver(),
  });
  runDepthSeamBehavior({
    name: "PGlite atomic batch",
    createDriver: () => new BatchOnlyPGliteDriver(),
  });
});
