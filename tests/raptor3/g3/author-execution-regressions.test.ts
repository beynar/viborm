import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type {
  BatchQuery,
  QueryExecutionContext,
  QueryResult,
} from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import {
  QueryEngineError,
  TransactionError,
  UnsupportedOperationError,
} from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import type { PreparedBatchOperation } from "@query-engine/types";
import { s } from "@schema";
import { overrideTransactionOperation } from "@tests/fixtures/transaction-operation";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

class ObservedSQLiteDriver extends SQLite3Driver {
  readonly statements: string[] = [];

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return super.execute<T>(client, statement, parameters);
  }
}

class BatchOnlySQLiteDriver extends ObservedSQLiteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  override maxBindParametersPerStatement: number | undefined = undefined;
  batchCalls = 0;
  readonly batches: BatchQuery[][] = [];
  readonly batchResults: QueryResult<unknown>[][] = [];

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batchCalls++;
    this.batches.push(queries);
    const results = await this.transaction(client, (transaction) =>
      super.executeBatch<T>(transaction, queries)
    );
    this.batchResults.push(results);
    return results;
  }
}

class MalformedBatchResultSQLiteDriver extends BatchOnlySQLiteDriver {
  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    const results = await super.executeBatch<T>(client, queries);
    return results.map((result) => ({
      ...result,
      rows: result.rows.map((row) => {
        if (row !== null && typeof row === "object")
          Reflect.set(row, "id", "malformed");
        return row;
      }),
    }));
  }
}

class IndivisibleBindSQLiteDriver extends BatchOnlySQLiteDriver {
  override maxBindParametersPerStatement: number | undefined = undefined;
}

class InteractiveIndivisibleBindSQLiteDriver extends ObservedSQLiteDriver {
  override maxBindParametersPerStatement: number | undefined = undefined;
}

function executionSchema() {
  const record = s
    .model({
      id: s.int().id(),
      code: s.string().unique(),
    })
    .map("g3_author_execution_records");
  const parent = s
    .model({
      id: s.int().id().increment(),
      label: s.string(),
      leftChildren: s.toMany(() => leftChild),
      rightChildren: s.toMany(() => rightChild),
    })
    .map("g3_author_execution_parents");
  const leftChild = s
    .model({
      id: s.int().id(),
      label: s.string(),
      parentId: s.int(),
      parent: s.toOne(() => parent).fields("parentId").references("id"),
    })
    .map("g3_author_execution_left_children");
  const rightChild = s
    .model({
      id: s.int().id(),
      label: s.string(),
      parentId: s.int(),
      parent: s.toOne(() => parent).fields("parentId").references("id"),
    })
    .map("g3_author_execution_right_children");
  return { leftChild, parent, record, rightChild };
}

function transactionArray(
  client: object,
  operations: readonly unknown[]
): Promise<unknown[]> {
  const transaction = Reflect.get(client, "$transaction");
  assert.equal(typeof transaction, "function");
  return Reflect.apply(transaction, client, [operations]);
}

describe("G3-02 author execution regressions", () => {
  it("reports a malformed result after its atomic batch was acknowledged", async () => {
    const schema = executionSchema();
    const database = new Database(":memory:");
    const driver = new MalformedBatchResultSQLiteDriver({ client: database });
    const client = createClient({ schema, driver });
    const migration = await syncLiveSchema(client);
    assert.equal(migration.applied, true);
    const candidate = createCommandEngine({ schema, driver });
    driver.statements.length = 0;
    driver.batchCalls = 0;
    try {
      await assert.rejects(
        candidate.execute("record", "createMany", {
          data: [
            { id: 1, code: "one" },
            { id: 2, code: "two" },
          ],
          select: { id: true },
        }),
        (failure) => {
          assert(failure instanceof QueryEngineError);
          assert.deepEqual(failure.meta.recordSeriesProgress, {
            atomicity: "segment",
            phase: "result",
            committedSegments: 1,
            committedWriteMembers: 1,
            completedMembers: 0,
          });
          return true;
        }
      );
      assert.equal(driver.batchCalls, 1);
      assert.deepEqual(
        database
          .prepare("SELECT id,code FROM g3_author_execution_records ORDER BY id")
          .all(),
        [
          { id: 1, code: "one" },
          { id: 2, code: "two" },
        ]
      );
    } finally {
      await client.$disconnect();
      database.close();
    }
  });

  it("keeps prepared cardinality independent of terminal query chunking", async () => {
    const schema = executionSchema();
    const database = new Database(":memory:");
    const driver = new BatchOnlySQLiteDriver({ client: database });
    const client = createClient({ schema, driver });
    const migration = await syncLiveSchema(client);
    assert.equal(migration.applied, true);
    driver.maxBindParametersPerStatement = 8;
    const candidate = createCommandEngine({ schema, driver });
    let prepared: PreparedBatchOperation<unknown> | undefined;
    const preparedSeries: PreparedBatchOperation<unknown>[] = [];
    const create = overrideTransactionOperation(client.record.findMany(), {
      prepare: () => undefined,
      prepareBatch: async () => {
        prepared = await candidate.prepareBatch("record", "create", {
          data: { id: 1, code: "one" },
          select: { id: true, code: true },
        });
        return prepared;
      },
    });
    const relationArgs = (
      firstChildId: number,
      count: number,
      select: { readonly id: true; readonly label: true } | undefined
    ) => ({
      data: Array.from({ length: count }, (_, index) => {
        const childId = firstChildId + index;
        return {
          label: `parent-${childId}`,
          leftChildren: {
            createMany: {
              data: [{ id: childId, label: `left-${childId}` }],
            },
          },
          rightChildren: {
            createMany: {
              data: [{ id: childId, label: `right-${childId}` }],
            },
          },
        };
      }),
      ...(select ? { select } : {}),
    });
    const relationCreateMany = (
      firstChildId: number,
      count: number,
      select: { readonly id: true; readonly label: true } | undefined
    ) =>
      overrideTransactionOperation(client.parent.findMany(), {
        prepare: () => undefined,
        prepareBatch: async () => {
          const operation = await candidate.prepareBatch(
            "parent",
            "createMany",
            relationArgs(firstChildId, count, select)
          );
          if (operation) preparedSeries.push(operation);
          return operation;
        },
      });
    try {
      assert.deepEqual(await transactionArray(client, [create]), [
        { id: 1, code: "one" },
      ]);
      assert(prepared);
      assert.equal(driver.batchResults.length, 1);
      assert.throws(
        () => prepared!.parseResult(driver.batchResults[0]!.slice(0, -1)),
        (failure) => {
          assert(failure instanceof TransactionError);
          assert.match(failure.message, /omitted the prepared result/);
          assert.equal(failure.meta.model, "record");
          assert.equal(failure.meta.operation, "create");
          return true;
        }
      );

      assert.deepEqual(
        await transactionArray(client, [
          relationCreateMany(10, 1, { id: true, label: true }),
        ]),
        [[{ id: 1, label: "parent-10" }]]
      );
      assert.equal(preparedSeries.length, 1);
      assert.equal(
        preparedSeries[0]!.queries.filter(({ sql }) =>
          /^SELECT\b/i.test(sql.trim())
        ).length,
        1
      );

      assert.deepEqual(
        await transactionArray(client, [
          relationCreateMany(20, 3, { id: true, label: true }),
        ]),
        [
          [
            { id: 2, label: "parent-20" },
            { id: 3, label: "parent-21" },
            { id: 4, label: "parent-22" },
          ],
        ]
      );
      assert.equal(preparedSeries.length, 2);
      const multiple = preparedSeries[1]!;
      const terminalIndexes = multiple.queries.flatMap(({ sql }, index) =>
        /^SELECT\b/i.test(sql.trim()) ? [index] : []
      );
      assert(
        terminalIndexes.length > 1,
        "the prepared result spans multiple physical terminal queries"
      );
      assert.equal(
        driver.batchResults.length,
        3,
        "each prepared operation must own one physical batch result window"
      );
      assert.throws(
        () =>
          multiple.parseResult(
            driver.batchResults[2]!.slice(0, terminalIndexes[0]! + 1)
          ),
        (failure) => {
          assert(failure instanceof TransactionError);
          assert.match(failure.message, /omitted the prepared result/);
          assert.equal(failure.meta.model, "parent");
          assert.equal(failure.meta.operation, "createMany");
          return true;
        }
      );

      assert.deepEqual(
        await transactionArray(client, [
          relationCreateMany(30, 2, undefined),
        ]),
        [{ count: 2 }]
      );
      assert.deepEqual(
        database
          .prepare(
            "SELECT id,label FROM g3_author_execution_parents ORDER BY id"
          )
          .all(),
        [
          { id: 1, label: "parent-10" },
          { id: 2, label: "parent-20" },
          { id: 3, label: "parent-21" },
          { id: 4, label: "parent-22" },
          { id: 5, label: "parent-30" },
          { id: 6, label: "parent-31" },
        ]
      );
      assert.deepEqual(
        database
          .prepare(
            "SELECT id,label,parentId FROM g3_author_execution_left_children ORDER BY id"
          )
          .all(),
        [
          { id: 10, label: "left-10", parentId: 1 },
          { id: 20, label: "left-20", parentId: 2 },
          { id: 21, label: "left-21", parentId: 3 },
          { id: 22, label: "left-22", parentId: 4 },
          { id: 30, label: "left-30", parentId: 5 },
          { id: 31, label: "left-31", parentId: 6 },
        ]
      );
      assert.deepEqual(
        database
          .prepare(
            "SELECT id,label,parentId FROM g3_author_execution_right_children ORDER BY id"
          )
          .all(),
        [
          { id: 10, label: "right-10", parentId: 1 },
          { id: 20, label: "right-20", parentId: 2 },
          { id: 21, label: "right-21", parentId: 3 },
          { id: 22, label: "right-22", parentId: 4 },
          { id: 30, label: "right-30", parentId: 5 },
          { id: 31, label: "right-31", parentId: 6 },
        ]
      );
    } finally {
      await client.$disconnect();
      database.close();
    }
  });

  it("refuses one indivisible over-budget insert at borrowed and native-batch dispatch", async () => {
    const schema = executionSchema();
    const interactiveDatabase = new Database(":memory:");
    const interactiveDriver = new InteractiveIndivisibleBindSQLiteDriver({
      client: interactiveDatabase,
    });
    const interactiveClient = createClient({
      schema,
      driver: interactiveDriver,
    });
    const interactiveMigration = await syncLiveSchema(interactiveClient);
    assert.equal(interactiveMigration.applied, true);
    interactiveDriver.maxBindParametersPerStatement = 1;
    const interactiveCandidate = createCommandEngine({
      schema,
      driver: interactiveDriver,
    });
    interactiveDriver.statements.length = 0;
    try {
      await assert.rejects(
        interactiveDriver.withTransaction((transactionDriver) =>
          interactiveCandidate.execute(
            "record",
            "createMany",
            { data: [{ id: 1, code: "over-budget" }] },
            { kind: "borrowed-transaction", driver: transactionDriver }
          )
        ),
        UnsupportedOperationError
      );
      assert.deepEqual(interactiveDriver.statements, []);
      assert.deepEqual(
        interactiveDatabase
          .prepare("SELECT id FROM g3_author_execution_records")
          .all(),
        []
      );
    } finally {
      await interactiveClient.$disconnect();
      interactiveDatabase.close();
    }

    const batchDatabase = new Database(":memory:");
    const batchDriver = new IndivisibleBindSQLiteDriver({
      client: batchDatabase,
    });
    const batchClient = createClient({ schema, driver: batchDriver });
    const batchMigration = await syncLiveSchema(batchClient);
    assert.equal(batchMigration.applied, true);
    batchDriver.maxBindParametersPerStatement = 1;
    const batchCandidate = createCommandEngine({ schema, driver: batchDriver });
    batchDriver.statements.length = 0;
    batchDriver.batchCalls = 0;
    try {
      await assert.rejects(
        batchCandidate.execute("record", "createMany", {
          data: [{ id: 1, code: "over-budget" }],
        }),
        UnsupportedOperationError
      );
      assert.equal(batchDriver.batchCalls, 0);
      assert.deepEqual(batchDriver.statements, []);
      assert.deepEqual(
        batchDatabase
          .prepare("SELECT id FROM g3_author_execution_records")
          .all(),
        []
      );
    } finally {
      await batchClient.$disconnect();
      batchDatabase.close();
    }
  });
});
