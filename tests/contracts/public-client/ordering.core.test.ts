/**
 * viborm/ordering on in-memory SQLite (`ordering-behavior.ts`): the
 * interactive driver, and a batch-only one (D1's shape: every operation one
 * atomic batch, no interactive transaction).
 */

import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import type { BatchQuery, QueryResult } from "@drivers/types";
import {
  describeOrdering,
  describeOrderingAdmission,
  schema,
} from "@tests/contracts/public-client/ordering-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import type Database from "better-sqlite3";

class BatchOnlySQLite3Driver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (tx) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries)
        results.push(await this.execute<T>(tx, query.sql, query.params ?? []));
      return results;
    });
  }
}

const opening = (driver: () => SQLite3Driver) => async () => {
  const client = createClient({ schema, driver: driver() });
  await syncLiveSchema(client);
  return { client };
};

describeOrdering("SQLite", opening(createInMemorySQLite3Driver));
describeOrdering(
  "SQLite batch-only",
  opening(() => new BatchOnlySQLite3Driver({ dataDir: ":memory:" }))
);
describeOrderingAdmission(opening(createInMemorySQLite3Driver));
