import { PGliteDriver } from "@drivers/pglite";
import type { BatchQuery, QueryResult } from "@drivers/types";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { runReadBehavior } from "./read-behavior";

/**
 * Forces the batch substrate: a PGlite driver that reports no transaction
 * support, so the V2 executor lowers every read into a single-entry atomic
 * batch instead of a transaction envelope.
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

// The read family on PGlite, both substrates: V2 in transaction mode, and V2 in
// forced atomic-batch mode (single-entry batch), each dual-run against a
// transaction-mode V1 reference reading the SAME seeded database.
runReadBehavior({
  name: "PGlite transaction",
  createDriver: () => new PGliteDriver(),
});

// The batch arm binds both drivers to one PGlite instance so the forced-batch V2
// reads exactly the data the transaction-mode V1 arm seeded.
let sharedBatchDb: PGlite | undefined;
runReadBehavior({
  name: "PGlite atomic batch",
  createDriver: () => {
    sharedBatchDb = new PGlite();
    return new PGliteDriver({ client: sharedBatchDb });
  },
  createV2Driver: () =>
    new BatchOnlyPGliteDriver({ client: sharedBatchDb as PGlite }),
});
