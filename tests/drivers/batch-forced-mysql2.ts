import { MySQL2Driver } from "@drivers/mysql2";
import type { BatchQuery, QueryResult } from "@drivers/types";
import type { Pool, PoolConnection } from "mysql2/promise";

/**
 * A batch-forced sibling of `MySQL2Driver` (§8.1): no interactive transactions,
 * native atomic batch instead, so `selectMode` routes it to PlannedMode. The
 * override wraps the plan's statements in one real transaction so the planned
 * plan commits all-or-nothing over a genuinely concurrent MySQL connection.
 * Mirrors the pg batch-forced sibling and the M7 gate's PGlite `BatchOnlyDriver`.
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

/**
 * A `MySQL2BatchForcedDriver` that commits a conflicting row out-of-band just
 * before its FIRST atomic batch runs, so a create-branch INSERT chosen against
 * the (now-stale) plan-time probe deterministically violates a constraint — the
 * missing-key race without a real timing window. `onBatchError` records the
 * error each atomic batch threw (the pre-retry signal the M8 gate inspects).
 */
export class MySQL2RacePlantingBatchDriver extends MySQL2BatchForcedDriver {
  private planted = false;
  private readonly plant: { sql: string; params: unknown[] };
  private readonly onBatchError: (error: unknown) => void;

  constructor(
    plant: { sql: string; params: unknown[] },
    onBatchError: (error: unknown) => void,
    options: ConstructorParameters<typeof MySQL2Driver>[0]
  ) {
    super(options);
    this.plant = plant;
    this.onBatchError = onBatchError;
  }

  protected override async executeBatch<T>(
    client: Pool | PoolConnection,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    if (!this.planted) {
      this.planted = true;
      // Commit the winner's row in a separate autocommit statement on the pool,
      // BEFORE this batch's transaction begins.
      await this.executeRaw(client, this.plant.sql, this.plant.params);
    }
    return super.executeBatch<T>(client, queries);
  }

  // Record the NORMALIZED error the atomic batch surfaced. `_executeBatch`
  // applies `normalizeDriverError` via `withInstrumentation`, so wrapping it
  // here captures the mapped `UniqueConstraintError`, not the raw driver error.
  override async _executeBatch<T = Record<string, unknown>>(
    ...args: Parameters<MySQL2Driver["_executeBatch"]>
  ): Promise<QueryResult<T>[]> {
    try {
      return (await super._executeBatch(...args)) as QueryResult<T>[];
    } catch (error) {
      this.onBatchError(error);
      throw error;
    }
  }
}

/**
 * A `MySQL2BatchForcedDriver` that runs an arbitrary async callback ONCE, just
 * before its FIRST atomic batch runs, and records the (normalized) error each
 * atomic batch surfaces. Used by the M9 filtered-M2M-deleteMany staleness gate
 * (§9, §5.5 Rule 3): the callback concurrently adds a junction member matching
 * the deleteMany filter AFTER the interpreter's plan-time membership read, so
 * the planned plan's symmetric-difference guard aborts (raceable) and the retry
 * re-plans against fresh membership and converges.
 */
export class MySQL2BeforeFirstBatchDriver extends MySQL2BatchForcedDriver {
  private fired = false;
  private readonly beforeFirstBatch: () => Promise<void>;
  private readonly onBatchError: (error: unknown) => void;

  constructor(
    beforeFirstBatch: () => Promise<void>,
    onBatchError: (error: unknown) => void,
    options: ConstructorParameters<typeof MySQL2Driver>[0]
  ) {
    super(options);
    this.beforeFirstBatch = beforeFirstBatch;
    this.onBatchError = onBatchError;
  }

  protected override async executeBatch<T>(
    client: Pool | PoolConnection,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    if (!this.fired) {
      this.fired = true;
      await this.beforeFirstBatch();
    }
    return super.executeBatch<T>(client, queries);
  }

  override async _executeBatch<T = Record<string, unknown>>(
    ...args: Parameters<MySQL2Driver["_executeBatch"]>
  ): Promise<QueryResult<T>[]> {
    try {
      return (await super._executeBatch(...args)) as QueryResult<T>[];
    } catch (error) {
      this.onBatchError(error);
      throw error;
    }
  }
}
