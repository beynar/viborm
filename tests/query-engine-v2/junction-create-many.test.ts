import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { describe } from "vitest";
import { runJunctionCreateManyBehavior } from "./junction-create-many-behavior";

/**
 * N3 on PGlite, on BOTH substrates. The junction's `createMany` slot and the upsert
 * arm's create-data identity are planning/compile decisions, so the two substrates must
 * agree by construction — this file is what makes that claim falsifiable locally, and
 * the driver legs (`tests/drivers/*`) repeat the same suite on every dialect.
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

describe("N3 — M2M completions (PGlite)", () => {
  runJunctionCreateManyBehavior({
    name: "PGlite transaction",
    createDriver: () => new PGliteDriver({ client: new PGlite() }),
  });
  runJunctionCreateManyBehavior({
    name: "PGlite atomic batch",
    createDriver: () => new BatchOnlyPGliteDriver({ client: new PGlite() }),
  });
});
