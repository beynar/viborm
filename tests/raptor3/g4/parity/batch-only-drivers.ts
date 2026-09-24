/**
 * Batch-only SQLite transports for the release units' pins: an ATOMIC native
 * batch (one transaction, rolled back on the first failure — the property D1's
 * batch and Neon's transaction have and the ladder's position rule depends
 * on), no callback transaction, with a one-shot `plant` hook that changes the
 * database right before the first batch after it is set — a change between
 * the plan-time read and the batch — and a variant that maps an aborted batch
 * to the assertion class without saying WHICH statement failed (D1 and Neon
 * reject the whole request), so the ladder must attribute the premise by
 * re-probing it (N3), and a variant that pins NO session and discards its
 * temporaries between batches (D-53).
 */

import type { BatchQuery, QueryResult } from "@drivers";
import {
  NESTED_WRITE_ASSERTION_FLOOR_MESSAGE,
  NestedWriteAssertionError,
} from "@errors";
import type Database from "better-sqlite3";
import { RecordingSQLiteDriver } from "../unit02/world";

/** Does this batch entry mutate? The atomic write unit is the only batch that
 *  carries one; a planning level is reads only. */
const MUTATION_STATEMENT = /^\s*(?:insert|update|delete)\b/i;

/**
 * A native batch, no callback transaction. `plant` runs once, against the
 * database, right before the first batch after it is set — a change between
 * the plan-time read and the batch. `plantBeforeFirstWrite` runs once INSIDE
 * that batch's transaction, between the unit's last premise and the first
 * statement they stand in front of: a premise and the effect it protects are
 * two statements, and this substrate's select assembly omits `FOR UPDATE`, so
 * that window is the one a batch premise cannot close here. One connection
 * carries both, so neither hook is a concurrent commit — it is the change
 * itself, applied at the position that names the window (the native
 * measurement on two real connections is
 * `tests/providers/docker/pg-batch-reference-reuse.test.ts`).
 */
export class BatchOnlyDriver extends RecordingSQLiteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  plant?: (database: Database.Database) => void;
  plantBeforeFirstWrite?: (database: Database.Database) => void;
  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    const plant = this.plant;
    if (plant) {
      this.plant = undefined;
      plant(client);
    }
    client.exec("BEGIN");
    try {
      const results = await this.runSplit<T>(client, queries);
      client.exec("COMMIT");
      return results;
    } catch (error) {
      client.exec("ROLLBACK");
      throw error;
    }
  }
  private async runSplit<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    const between = this.plantBeforeFirstWrite;
    const firstWrite = between
      ? queries.findIndex((query) => MUTATION_STATEMENT.test(query.sql))
      : -1;
    if (!between || firstWrite < 0)
      return await super.executeBatch<T>(client, queries);
    this.plantBeforeFirstWrite = undefined;
    const head =
      firstWrite === 0
        ? []
        : await super.executeBatch<T>(client, queries.slice(0, firstWrite));
    between(client);
    const tail = await super.executeBatch<T>(client, queries.slice(firstWrite));
    return [...head, ...tail];
  }
}

/**
 * A batch-only transport that maps an aborted batch to the assertion class
 * but cannot say WHICH statement failed (D1's batch and Neon's transaction
 * reject the whole request): the ladder must attribute the premise by
 * re-probing it and take its position from the attribution (N3).
 */
export class NoIndexBatchOnlyDriver extends BatchOnlyDriver {
  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    try {
      return await super.executeBatch<T>(client, queries);
    } catch (error) {
      if (error instanceof NestedWriteAssertionError)
        throw new NestedWriteAssertionError(
          NESTED_WRITE_ASSERTION_FLOOR_MESSAGE,
          { cause: error }
        );
      throw error;
    }
  }
}

/**
 * The Neon-shaped transport: a batch-only driver that pins NO session and
 * discards its temporaries between batches (D-53).
 *
 * Neon HTTP dispatches each batch as its own non-interactive transaction and
 * reserves nothing — `Driver._canPinSession()` is false, because the driver
 * declares no `pinnedSession` hook — so the TEMP table the D-50 batch
 * reference scratch lives in belongs to one dispatched unit and is gone by the
 * next. It models Neon HTTP only: D1 pins no session either, but refuses
 * temporaries, so its scratch is an ordinary table that outlives the batch and
 * is emptied by each unit's own cleanup, which this fixture's TEMP drop does
 * not model. Its sibling {@link BatchOnlyDriver} keeps one
 * better-sqlite3 connection, which IS a session, and therefore keeps the
 * scratch across dispatches; the only difference between the two fixtures is
 * the transport fact D-53 names, which is why the pins run the same payload on
 * both.
 */
export class SessionlessBatchOnlyDriver extends BatchOnlyDriver {
  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    try {
      return await super.executeBatch<T>(client, queries);
    } finally {
      // The session ends with the batch, whatever the batch answered.
      client.exec('DROP TABLE IF EXISTS temp."__viborm_batch_refs"');
    }
  }
}
