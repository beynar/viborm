import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { describe } from "vitest";
import { runProducedIdentityBehavior } from "./produced-identity-depth-behavior";

/**
 * N4-U2 / N4-U4 — the produced identity, on the always-available substrate pair.
 *
 * The shared suite (`produced-identity-depth-behavior.ts`, run here and by every driver
 * leg) carries the assertions. This file only supplies the two PGlite substrates, so the
 * whole surface is exercised on `pnpm test` without a container: a real transaction, and
 * a driver forced to lower the same plan into a single atomic batch.
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

describe("N4-U2 / N4-U4 — produced identity at depth (PGlite)", () => {
  runProducedIdentityBehavior({
    name: "PGlite transaction",
    createDriver: () => new PGliteDriver(),
  });
  runProducedIdentityBehavior({
    name: "PGlite atomic batch",
    createDriver: () => new BatchOnlyPGliteDriver(),
  });
});
