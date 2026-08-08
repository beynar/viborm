import { MySQL2Driver } from "@drivers/mysql2";
import type { BatchQuery, QueryResult } from "@drivers/types";
import type { Pool, PoolConnection } from "mysql2/promise";

/**
 * Artificial batch-only sibling used to prove that a non-returning MySQL
 * adapter rejects before provider access. Public mysql2/PlanetScale drivers are
 * transaction-capable; this unsupported capability combination must never run
 * a plan whose public parsing could fail after its batch already committed.
 */
export class MySQL2BatchForcedDriver extends MySQL2Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override executeBatch<T>(
    client: Pool | PoolConnection,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (tx) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(await this.executeRaw<T>(tx, query.sql, query.params));
      }
      return results;
    });
  }
}
