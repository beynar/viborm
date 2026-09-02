/**
 * Shared fixtures for the SQLite3 provider suite.
 *
 * The suite is split across sibling `sqlite3-*.test.ts` files so that no single
 * program has to typecheck every contract schema at the 1280 MB shard heap.
 * The forced-batch driver below is used by several of those files, so it lives
 * in a module Vitest does not collect rather than being duplicated.
 */
import { SQLite3Driver } from "@drivers/sqlite3";
import type { BatchQuery, QueryResult } from "@drivers/types";
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
      for (const query of queries) {
        results.push(await this.execute<T>(tx, query.sql, query.params ?? []));
      }
      return results;
    });
  }
}

export function createBatchOnlySQLite3Driver(): SQLite3Driver {
  return new BatchOnlySQLite3Driver({
    dataDir: ":memory:",
  });
}
