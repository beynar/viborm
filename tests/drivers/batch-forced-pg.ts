import { PgDriver } from "@drivers/pg";
import type { BatchQuery, QueryResult } from "@drivers/types";
import type { Pool, PoolClient } from "pg";

/**
 * A batch-forced sibling of `PgDriver` (§8.1): it advertises no interactive
 * transactions and native atomic batch instead, so `selectMode` routes it to
 * PlannedMode. The base `executeBatch` would run the statements sequentially on
 * a pooled connection WITHOUT a transaction (not atomic); this override wraps
 * them in one real transaction so the planned plan commits all-or-nothing, over
 * a genuinely concurrent Postgres connection. Mirrors the M7 gate's
 * `BatchOnlyDriver`, but over the real pg driver rather than PGlite.
 */
export class PgBatchForcedDriver extends PgDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override executeBatch<T>(
    client: Pool | PoolClient,
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

/**
 * A `PgBatchForcedDriver` that commits a conflicting row out-of-band just before
 * its FIRST atomic batch runs, so a create-branch INSERT chosen against the
 * (now-stale) plan-time probe deterministically violates a unique constraint —
 * the missing-key race, without a real timing window. `onBatchError` records the
 * error each atomic batch threw (the pre-retry signal the M8 gate inspects).
 */
export class PgRacePlantingBatchDriver extends PgBatchForcedDriver {
  private planted = false;
  private readonly plant: { sql: string; params: unknown[] };
  private readonly onBatchError: (error: unknown) => void;

  constructor(
    plant: { sql: string; params: unknown[] },
    onBatchError: (error: unknown) => void,
    options: ConstructorParameters<typeof PgDriver>[0]
  ) {
    super(options);
    this.plant = plant;
    this.onBatchError = onBatchError;
  }

  protected override async executeBatch<T>(
    client: Pool | PoolClient,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    if (!this.planted) {
      this.planted = true;
      // Commit the winner's row in a separate autocommit statement on the pool,
      // BEFORE this batch's transaction begins, so the batch reads and conflicts
      // with a committed row.
      await this.executeRaw(client, this.plant.sql, this.plant.params);
    }
    return super.executeBatch<T>(client, queries);
  }

  // Record the NORMALIZED error the atomic batch surfaced (the pre-retry
  // signal). `_executeBatch` applies `normalizeDriverError` via
  // `withInstrumentation`, so wrapping it here — one level above `executeBatch`
  // — captures the mapped `UniqueConstraintError`, not the raw driver error.
  override async _executeBatch<T = Record<string, unknown>>(
    ...args: Parameters<PgDriver["_executeBatch"]>
  ): Promise<QueryResult<T>[]> {
    try {
      return (await super._executeBatch(...args)) as QueryResult<T>[];
    } catch (error) {
      this.onBatchError(error);
      throw error;
    }
  }
}
