import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { describe } from "vitest";
import { runJunctionSkipAdoptBehavior } from "./e68-junction-skip-adopt-behavior";

/**
 * E6.8 on PGlite, on BOTH substrates.
 *
 * The batch leg is the one that says something the transaction leg cannot: the adopt
 * rewrite carries NO `onUniqueConflict` effect, so it never reaches the executor's
 * savepoint wall (`compileToEntries`: "carries an onUniqueConflict skip effect that has no
 * atomic-batch lowering"). The wall is BYPASSED, not weakened — `junction-create-many.test`
 * still drives the skip leaf into it on a `recoverableUniqueError` dialect. This file
 * proves the absorbed shapes run on an atomic batch with the same state as in a
 * transaction.
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

describe("E6.8 — junction skipDuplicates adopt-equivalence (PGlite)", () => {
  runJunctionSkipAdoptBehavior({
    name: "PGlite transaction",
    createDriver: () => new PGliteDriver({ client: new PGlite() }),
  });
  runJunctionSkipAdoptBehavior({
    name: "PGlite atomic batch",
    createDriver: () => new BatchOnlyPGliteDriver({ client: new PGlite() }),
  });
});
