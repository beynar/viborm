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
  VibORMErrorCode,
} from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import type { PreparedBatchOperation } from "@query-engine/types";
import { s } from "@schema";
import { overrideTransactionOperation } from "@tests/fixtures/transaction-operation";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { isRecord } from "@validation/value-guards";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

const PARENT_INSERT = /^INSERT INTO "g3_author_execution_parents"/;

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

/**
 * The fault cut: the provider answers a row whose `id` is not an integer.
 *
 * Stated over ANY row-bearing response on ANY transport, at `execute` — which
 * the driver's own batch entry dispatches every query it does not dispatch
 * verbatim through
 * (`drivers/driver-transaction-base.ts` `executeBatch`) — and NOT over
 * `executeBatch` alone. Which driver entry carries the fault is a physical
 * choice, not a property of this specimen: since Arnaud's D-7 decision a set
 * statement that is the operation's only statement leaves the batch
 * (`shared/operation-context.ts` `setMutations`, the `lone` condition
 * `statements.length === 1 && attempt.pending.length === 0 &&
 * continuations.length === 0`, guarding `if (this.usesBatch && !lone)`), so an
 * `executeBatch`-only cut is ELIMINATED for a relation-free `createMany` and
 * this specimen silently stops witnessing — raptor3 plan §5.4, and exactly what
 * qualification attempt 2 measured here ("Missing expected rejection"). The
 * property is unchanged: a malformed provider result is translated into the
 * established identity, with truthful progress, and nothing is published. The
 * two G2.9 specimens were re-expressed the same way
 * (`tests/raptor3/post-prep/g29-result-progress.test.ts` and its PGlite twin,
 * `g4/regression/note.md` §D.3).
 */
class MalformedResultSQLiteDriver extends BatchOnlySQLiteDriver {
  corrupted = false;
  private armed = false;

  /** Arm the cut after the migration, and forget the migration's traffic. */
  arm(): void {
    this.statements.length = 0;
    this.batchCalls = 0;
    this.batches.length = 0;
    this.batchResults.length = 0;
    this.corrupted = false;
    this.armed = true;
  }

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const response = await super.execute<T>(
      client,
      statement,
      parameters,
      context
    );
    if (!this.armed) return response;
    for (const row of response.rows) {
      if (isRecord(row) && Object.hasOwn(row, "id")) {
        Reflect.set(row, "id", "malformed");
        this.corrupted = true;
      }
    }
    return response;
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

function failureObservation(failure: unknown): object {
  if (failure instanceof QueryEngineError)
    return {
      name: failure.name,
      code: failure.code,
      message: failure.message,
      meta: { ...failure.meta },
    };
  if (failure instanceof Error)
    return { name: failure.name, message: failure.message };
  return { thrown: String(failure) };
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
  it("reports a malformed result on the transport its plan uses, with the progress that transport has", async () => {
    // HALF A — the request this specimen has always made (a two-row,
    // relation-free `createMany` with `select`) is ONE statement, so after D-7
    // it leaves the batch and the truthful answer is the SHIPPED one: the
    // malformed-scalar refusal with `{driver, operation, scalarType}` and no
    // record series to report on at all. `submit()` is the only writer of
    // `committedSegments` / `mayHaveCommittedSegment`
    // (`shared/operation-context.ts:716`, `:776`), so a statement that never
    // entered a batch has no segment to publish — which is precisely the
    // shipped `runBorrowedStatementAtomic` answer this engine now matches.
    const loneSchema = executionSchema();
    const loneDatabase = new Database(":memory:");
    const loneDriver = new MalformedResultSQLiteDriver({
      client: loneDatabase,
    });
    const loneClient = createClient({ schema: loneSchema, driver: loneDriver });
    assert.equal((await syncLiveSchema(loneClient)).applied, true);
    const loneCandidate = createCommandEngine({
      schema: loneSchema,
      driver: loneDriver,
    });
    loneDriver.arm();
    let loneValue: unknown;
    let loneFailure: unknown;
    try {
      loneValue = await loneCandidate.execute("record", "createMany", {
        data: [
          { id: 1, code: "one" },
          { id: 2, code: "two" },
        ],
        select: { id: true },
      });
    } catch (error) {
      loneFailure = error;
    }
    const loneRows = loneDatabase
      .prepare("SELECT id,code FROM g3_author_execution_records ORDER BY id")
      .all();
    const loneDiagnostic = JSON.stringify(
      {
        half: "lone statement",
        statements: loneDriver.statements,
        batchCalls: loneDriver.batchCalls,
        corrupted: loneDriver.corrupted,
        rows: loneRows,
        value: loneValue,
        failure: failureObservation(loneFailure),
      },
      undefined,
      2
    );
    try {
      assert.equal(loneValue, undefined, loneDiagnostic);
      assert.equal(loneDriver.corrupted, true, loneDiagnostic);
      assert.equal(loneDriver.statements.length, 1, loneDiagnostic);
      assert.equal(loneDriver.batchCalls, 0, loneDiagnostic);
      assert(loneFailure instanceof QueryEngineError, loneDiagnostic);
      assert.equal(
        loneFailure.code,
        VibORMErrorCode.INTERNAL_ERROR,
        loneDiagnostic
      );
      assert.equal(
        loneFailure.message,
        'Driver "sqlite3" returned a malformed int scalar for operation "createMany": the value is not a canonical integer.',
        loneDiagnostic
      );
      assert.deepEqual(
        { ...loneFailure.meta },
        { driver: "sqlite3", operation: "createMany", scalarType: "int" },
        loneDiagnostic
      );
      // Statement-atomic: the write committed with its own statement and the
      // failure happened afterwards, decoding what the provider answered.
      assert.deepEqual(
        loneRows,
        [
          { id: 1, code: "one" },
          { id: 2, code: "two" },
        ],
        loneDiagnostic
      );
    } finally {
      await loneClient.$disconnect();
      loneDatabase.close();
    }

    // HALF B — the property this cell has always owned ("an acknowledged atomic
    // batch answers with truthful progress"), on a request that is still a REAL
    // batch after D-7: a `createMany` whose member carries a NESTED write. Its
    // plan is several statements — the scratch prologue, the parent insert, the
    // generated-key capture, the nested child insert, then the terminal
    // read-back — so `lone` is false (measured: the write window this operation
    // submits is five statements in one `executeBatch` entry, whichever of the
    // three conjuncts `statements.length === 1`, `attempt.pending.length === 0`,
    // `continuations.length === 0` the plan trips) and `setMutations` keeps its
    // batch envelope. That is a STRUCTURAL multi-statement plan, not a bind-budget
    // split: no planner choice can fold three tables into one statement, so
    // unlike the pre-D-7 shape this half cannot be silently eliminated. The
    // write window is acknowledged and commits; the malformed row then arrives
    // in the terminal read, so the refusal still carries `committedSegments: 1`
    // exactly as before. Its MEMBER counts are the ones this request really has
    // — two write members (the parent record and its nested child), both
    // complete — where the old one-statement request had one and none. The
    // bind-budget-split form of the same property is pinned separately at
    // `tests/raptor3/g4/unit02/lone-statement-transport.test.ts` row 6.
    const batchSchema = executionSchema();
    const batchDatabase = new Database(":memory:");
    const batchDriver = new MalformedResultSQLiteDriver({
      client: batchDatabase,
    });
    const batchClient = createClient({
      schema: batchSchema,
      driver: batchDriver,
    });
    assert.equal((await syncLiveSchema(batchClient)).applied, true);
    const batchCandidate = createCommandEngine({
      schema: batchSchema,
      driver: batchDriver,
    });
    batchDriver.arm();
    let batchValue: unknown;
    let batchFailure: unknown;
    try {
      batchValue = await batchCandidate.execute("parent", "createMany", {
        data: [
          {
            label: "batched",
            leftChildren: {
              createMany: { data: [{ id: 1, label: "left-1" }] },
            },
          },
        ],
        select: { id: true, label: true },
      });
    } catch (error) {
      batchFailure = error;
    }
    const batchRows = batchDatabase
      .prepare("SELECT id,label FROM g3_author_execution_parents ORDER BY id")
      .all();
    const batchChildRows = batchDatabase
      .prepare(
        "SELECT id,label,parentId FROM g3_author_execution_left_children ORDER BY id"
      )
      .all();
    const batchDiagnostic = JSON.stringify(
      {
        half: "real batch",
        statements: batchDriver.statements,
        batchCalls: batchDriver.batchCalls,
        batches: batchDriver.batches.map((queries) =>
          queries.map(({ sql }) => sql)
        ),
        corrupted: batchDriver.corrupted,
        rows: batchRows,
        children: batchChildRows,
        value: batchValue,
        failure: failureObservation(batchFailure),
      },
      undefined,
      2
    );
    try {
      assert.equal(batchValue, undefined, batchDiagnostic);
      assert.equal(batchDriver.corrupted, true, batchDiagnostic);
      // Two batch entries, both genuinely plural: the write window (scratch
      // prologue, parent insert, generated-key capture, child insert) and the
      // terminal window (the read-back and the scratch release).
      assert.equal(batchDriver.batchCalls, 2, batchDiagnostic);
      const writeWindow = batchDriver.batches.find((queries) =>
        queries.some(({ sql }) => PARENT_INSERT.test(sql))
      );
      assert(writeWindow && writeWindow.length > 1, batchDiagnostic);
      assert(batchFailure instanceof QueryEngineError, batchDiagnostic);
      assert.equal(
        batchFailure.message,
        'Driver "sqlite3" returned a malformed int scalar for operation "createMany": the value is not a canonical integer.',
        batchDiagnostic
      );
      assert.deepEqual(
        batchFailure.meta.recordSeriesProgress,
        {
          atomicity: "segment",
          phase: "result",
          committedSegments: 1,
          committedWriteMembers: 2,
          completedMembers: 2,
        },
        batchDiagnostic
      );
      assert.deepEqual(
        batchRows,
        [{ id: 1, label: "batched" }],
        batchDiagnostic
      );
      assert.deepEqual(
        batchChildRows,
        [{ id: 1, label: "left-1", parentId: 1 }],
        batchDiagnostic
      );
    } finally {
      await batchClient.$disconnect();
      batchDatabase.close();
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
