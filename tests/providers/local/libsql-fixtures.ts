/**
 * Shared fixtures for the LibSQL provider suite.
 *
 * The suite is split across sibling `libsql-*.test.ts` files so that no single
 * program has to typecheck every contract schema at the 1280 MB shard heap.
 * The forced-batch driver below is used by several of those files, so it lives
 * in a module Vitest does not collect rather than being duplicated.
 */
import { LibSQLDriver } from "@drivers/libsql";
import type { BatchQuery, QueryResult } from "@drivers/types";
import type { Client, Transaction } from "@libsql/client";

export class BatchOnlyLibSQLDriver extends LibSQLDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: Client | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(
          await this.execute<T>(transaction, query.sql, query.params ?? [])
        );
      }
      return results;
    });
  }
}
