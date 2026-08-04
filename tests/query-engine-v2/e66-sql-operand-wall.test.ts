import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import {
  registerSqlOperandWallBehavior,
  sqlOperandWallSchema,
} from "./e66-sql-operand-wall-behavior";

/**
 * E6.6 on both substrates.
 *
 * The atomic batch leg is the one the plan cared about — it is where the batch capture
 * wall (rule 9) would have kept a refusal while the transaction leg absorbed. It is here
 * for a different reason than the plan expected: BOTH substrates refuse identically,
 * because the refusal happens at the parse boundary and at construction, before either
 * substrate is chosen. A future absorption that made the two legs diverge would have to
 * change this file, which is exactly the notice this wall is for.
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

const substrates = [
  {
    name: "transaction",
    make: (db: PGlite) => new PGliteDriver({ client: db }),
  },
  {
    name: "atomic batch",
    make: (db: PGlite) => new BatchOnlyPGliteDriver({ client: db }),
  },
] as const;

for (const substrate of substrates) {
  let shared: any;
  registerSqlOperandWallBehavior(substrate.name, async () => {
    if (!shared) {
      shared = createClient({
        schema: sqlOperandWallSchema,
        driver: substrate.make(new PGlite()),
      }) as any;
      await push(shared, { force: true });
    }
    return shared;
  });
}
