import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Model } from "@schema/model";
import { DeleteOperation } from "@src/query-engine/write-engine/DeleteOperation";
import { OperationExecutor } from "@src/query-engine/write-engine/OperationExecutor";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { updateFamilySchema } from "@tests/contracts/engine/write/update-family-behavior";
import { batchIsAtomicUnit } from "@tests/fixtures/atomic-unit-batch";
import { createSchemaRegistry } from "@validation";

// ---------------------------------------------------------------------------
// Staleness injection (PLAN P2a instrument 3). The single-threaded dual-run
// oracle cannot observe raceability, so each existing-row premise class gets a
// deterministic before-batch driver hook: it mutates committed state AFTER V2's
// unlocked planning read decides the arm but BEFORE the atomic batch runs. The
// pinned guard must then abort the batch with its typed failure — proving the
// premise is actually pinned inside the atomic unit, not merely observed at
// planning. This is the coverage ATOM §8.1 note (b) said P2a adds.
// ---------------------------------------------------------------------------

// The four `staleness-injection-*.test.ts` slices beside this module share these
// two drivers and the `updateFamilySchema` runners built on them. Each slice opens
// its own fresh database per test, so nothing here holds state between them.

/**
 * A batch-only PGlite driver that runs `beforeBatch` between planning and the
 * atomic WRITE batch — the deterministic staleness window. The window is named
 * by {@link batchIsAtomicUnit}, not by "the first batch": planning reads travel
 * by batch too once they are grouped by dependency level (PLAN Phase 6.1), and
 * firing on one of those would land the mutation BEFORE planning.
 */
export class BeforeBatchPGliteDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  private beforeBatch: (() => Promise<void>) | undefined;

  constructor(
    beforeBatch: () => Promise<void>,
    options: ConstructorParameters<typeof PGliteDriver>[0]
  ) {
    super(options);
    this.beforeBatch = beforeBatch;
  }

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    const hook = this.beforeBatch;
    if (hook && batchIsAtomicUnit(queries)) {
      this.beforeBatch = undefined;
      await hook();
    }
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

export function makeClient(db: PGlite) {
  return createClient({
    schema: updateFamilySchema,
    driver: new PGliteDriver({ client: db }),
  });
}

/** Run a V2 update in forced-batch mode with a before-batch staleness hook. */
export function runUpdate(
  db: PGlite,
  beforeBatch: () => Promise<void>,
  modelName: string,
  model: Model<any>,
  args: Record<string, unknown>
): Promise<unknown> {
  const driver = new BeforeBatchPGliteDriver(beforeBatch, { client: db });
  const schemas = createSchemaRegistry(updateFamilySchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(updateFamilySchema, schemas)
  );
  const executor = new OperationExecutor(engine);
  const operation = new UpdateOperation(engine, model, args);
  const context = createOperationExecutionContext(
    modelName,
    "update",
    engine.instrumentation
  );
  return executor.execute(operation, context);
}

export function runDelete(
  db: PGlite,
  beforeBatch: () => Promise<void>,
  modelName: string,
  model: Model<any>,
  args: Record<string, unknown>
): Promise<unknown> {
  const driver = new BeforeBatchPGliteDriver(beforeBatch, { client: db });
  const schemas = createSchemaRegistry(updateFamilySchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(updateFamilySchema, schemas)
  );
  const executor = new OperationExecutor(engine);
  const operation = new DeleteOperation(engine, model, args);
  const context = createOperationExecutionContext(
    modelName,
    "delete",
    engine.instrumentation
  );
  return executor.execute(operation, context);
}

/** Run raw SQL on the batch's own transaction handle. */
export type RawRunner = (sql: string) => Promise<unknown>;

/**
 * A batch-only PGlite driver that runs a hook INSIDE the atomic unit, immediately
 * before the first statement matching `runBefore`. PGlite is single-connection, so
 * the hook cannot be a second committed session; it runs on the batch's own
 * transaction handle. That is not a weaker witness for the row ADDRESS: what the
 * root UPDATE sees is the same either way — under READ COMMITTED an unlocked guard
 * SELECT does not stop another session committing a reassignment before the UPDATE
 * statement runs. This driver reproduces exactly that state deterministically.
 */
export class MidBatchPGliteDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  private hook: ((run: RawRunner) => Promise<void>) | undefined;
  private readonly runBefore: (sql: string) => boolean;

  constructor(
    hook: (run: RawRunner) => Promise<void>,
    runBefore: (sql: string) => boolean,
    options: ConstructorParameters<typeof PGliteDriver>[0]
  ) {
    super(options);
    this.hook = hook;
    this.runBefore = runBefore;
  }

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        if (this.hook && this.runBefore(query.sql)) {
          const hook = this.hook;
          this.hook = undefined;
          await hook((raw) => this.executeRaw(transaction, raw, []));
        }
        results.push(
          await this.executeRaw<T>(transaction, query.sql, query.params)
        );
      }
      return results;
    });
  }
}

export const startsWithUpdate = (sql: string) =>
  sql.trimStart().toUpperCase().startsWith("UPDATE");
