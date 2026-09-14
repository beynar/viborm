import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type {
  BatchQuery,
  QueryExecutionContext,
  QueryResult,
} from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { QueryEngineError, UnsupportedOperationError } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
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
  batchCalls = 0;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batchCalls++;
    return this.transaction(client, (transaction) =>
      super.executeBatch<T>(transaction, queries)
    );
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
  return { record };
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
