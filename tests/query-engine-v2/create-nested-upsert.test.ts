import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createClient } from "@client/client";
import {
  type BatchQuery,
  Driver,
  type DriverResultParser,
  type QueryExecutionContext,
  type QueryResult,
} from "@drivers";
import { getExecutionInstrumentation } from "@drivers/execution-context";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { NestedWriteError, QueryError, UniqueConstraintError } from "@errors";
import { createInstrumentationContext } from "@instrumentation/context";
import { push } from "@migrations";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { CreateOperation } from "../../src/query-engine-v2/CreateOperation";
import { OperationExecutor } from "../../src/query-engine-v2/OperationExecutor";
import {
  isOperationValueReference,
  ref,
} from "../../src/query-engine-v2/OperationFragment";
import {
  createNestedUpsertArgs,
  createOperationExecutor,
  operationFragmentSchema,
  runCreateNestedUpsertBehavior,
} from "./create-nested-upsert-behavior";

class BatchOnlyPGliteDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  batchCalls = 0;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batchCalls += 1;
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

class BeforeBatchPGliteDriver extends BatchOnlyPGliteDriver {
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
    const beforeBatch = this.beforeBatch;
    this.beforeBatch = undefined;
    if (beforeBatch) await beforeBatch();
    return super.executeBatch<T>(client, queries);
  }
}

class FailingResultPGliteDriver extends PGliteDriver {
  readonly failure = new QueryError("result parser failure");
  override readonly result: DriverResultParser = {
    parseResult: () => {
      throw this.failure;
    },
  };
}

class TransactionProbeDriver extends Driver<string, string> {
  readonly adapter = new PostgresAdapter();
  readonly clients: string[] = [];
  readonly statements: string[] = [];
  readonly contexts: (QueryExecutionContext | undefined)[] = [];
  executions = 0;

  constructor() {
    super("postgresql", "query-engine-v2-transaction-probe");
  }

  protected async initClient(): Promise<string> {
    return "client";
  }

  protected async closeClient(): Promise<void> {
    // This driver owns no external resource.
  }

  protected async execute<T>(
    client: string,
    statement: string,
    _params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.executions += 1;
    this.clients.push(client);
    this.statements.push(statement);
    this.contexts.push(context);
    return { rows: [], rowCount: this.executions === 1 ? 0 : 1 };
  }

  protected executeRaw<T>(
    client: string,
    statement: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.execute<T>(client, statement, params ?? [], context);
  }

  protected async transaction<T>(
    _client: string,
    execute: (transaction: string) => Promise<T>
  ): Promise<T> {
    return execute("transaction");
  }
}

class UnsupportedDriver extends TransactionProbeDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = false;
}

class BatchProbeDriver extends Driver<null, null> {
  readonly adapter = new PostgresAdapter();
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  executions = 0;
  batchCalls = 0;

  constructor() {
    super("postgresql", "query-engine-v2-batch-probe");
  }

  protected async initClient(): Promise<null> {
    return null;
  }

  protected async closeClient(): Promise<void> {
    // This driver owns no external resource.
  }

  protected async execute<T>(): Promise<QueryResult<T>> {
    this.executions += 1;
    return { rows: [], rowCount: 0 };
  }

  protected executeRaw<T>(): Promise<QueryResult<T>> {
    return this.execute<T>();
  }

  protected async transaction<T>(
    _client: null,
    execute: (transaction: null) => Promise<T>
  ): Promise<T> {
    return execute(null);
  }
}

class GuardProviderFailureBatchDriver extends BatchProbeDriver {
  readonly failure = new QueryError("guard provider failure");
  guardIndex = -1;

  override _executeBatch<T>(queries: BatchQuery[]): Promise<QueryResult<T>[]> {
    this.batchCalls += 1;
    this.guardIndex = queries.findIndex((query) =>
      query.sql.includes("__viborm_assert__")
    );
    return Promise.reject(this.failure);
  }
}

class ShortBatchDriver extends BatchProbeDriver {
  override _executeBatch<T>(): Promise<QueryResult<T>[]> {
    this.batchCalls += 1;
    return Promise.resolve([]);
  }
}

class MalformedResultDriver extends BatchProbeDriver {
  override _execute<T>(): Promise<QueryResult<T>> {
    this.executions += 1;
    return Promise.resolve({ rows: [], rowCount: Number.NaN });
  }
}

runCreateNestedUpsertBehavior({
  name: "PGlite transaction",
  createDriver: () => new PGliteDriver(),
});

runCreateNestedUpsertBehavior({
  name: "PGlite atomic batch",
  createDriver: () => new BatchOnlyPGliteDriver(),
});

describe("query-engine-v2 linear operation fragments", () => {
  test("creates locked transaction planning and linear final fragments", () => {
    const driver = new TransactionProbeDriver();
    const operation = createOperation(driver);
    const planning = operation.createPlanningFragment();
    const planningStep = planning.steps[0];

    expect(operation.mode).toBe("transaction");
    expect(planning.steps.map((step) => step.id)).toEqual(["post.find"]);
    expect(planning.outputs).toEqual({ rows: ref("post.find", "rows") });
    expect(planningStep?.kind).toBe("read");
    if (planningStep?.kind !== "read") return;
    expect(driver._prepare(planningStep.statement).sql).toContain("FOR UPDATE");

    const existing = operation.createFragment({ rows: [{ id: 1 }] });
    const missing = operation.createFragment({ rows: [] });
    expect(existing.steps.map((step) => step.id)).toEqual([
      "user.create",
      "post.update",
      "user.select",
    ]);
    expect(missing.steps.map((step) => step.id)).toEqual([
      "user.create",
      "post.create",
      "user.select",
    ]);
    expect(
      [...existing.steps, ...missing.steps].every(
        (step) => step.kind !== "guard"
      )
    ).toBe(true);
    expect(existing.outputs).toEqual({
      result: ref("user.select", "result"),
    });
  });

  test("creates unlocked batch planning and guarded linear final fragments", () => {
    const driver = new BatchProbeDriver();
    const operation = createOperation(driver);
    const planning = operation.createPlanningFragment();
    const planningStep = planning.steps[0];

    expect(operation.mode).toBe("batch");
    expect(planningStep?.kind).toBe("read");
    if (planningStep?.kind !== "read") return;
    expect(driver._prepare(planningStep.statement).sql).not.toContain(
      "FOR UPDATE"
    );

    const existing = operation.createFragment({ rows: [{ id: 1 }] });
    const missing = operation.createFragment({ rows: [] });
    expect(existing.steps.map((step) => step.id)).toEqual([
      "post.guard.exists",
      "user.create",
      "post.update",
      "user.select",
    ]);
    expect(missing.steps.map((step) => step.id)).toEqual([
      "post.guard.notExists",
      "user.create",
      "post.create",
      "user.select",
    ]);
    expect(existing.steps[0]?.kind).toBe("guard");
    expect(missing.steps[0]?.kind).toBe("guard");
    const existingGuard = existing.steps[0];
    if (existingGuard?.kind !== "guard") return;
    expect(driver._prepare(existingGuard.premise.statement).sql).toContain(
      "FOR UPDATE"
    );
    const createChild = missing.steps[2];
    expect(createChild?.kind).toBe("write");
    if (createChild?.kind !== "write") return;
    expect(createChild.statement.values.some(isOperationValueReference)).toBe(
      true
    );
  });

  test("rejects unsupported shapes and unsupported drivers before I/O", () => {
    const driver = new TransactionProbeDriver();

    expect(
      () =>
        new CreateOperation(
          driverEngine(driver),
          operationFragmentSchema.user,
          {
            data: {
              name: "henry",
              posts: {
                upsert: {
                  where: { id: 1 },
                  create: {
                    id: 1,
                    title: "post",
                    slug: "post-key",
                    author: { connect: { id: 1 } },
                  },
                  update: { title: "post" },
                },
              },
            },
            select: { name: true, posts: true },
          }
        )
    ).toThrow("does not support deeper relation mutations");

    const upsert = createNestedUpsertArgs().data.posts.upsert;
    expect(
      () =>
        new CreateOperation(
          driverEngine(driver),
          operationFragmentSchema.user,
          {
            data: {
              name: "henry",
              posts: { upsert: [upsert, upsert] },
            },
            select: { name: true, posts: true },
          }
        )
    ).toThrow("exactly one nested upsert object");
    expect(driver.executions).toBe(0);

    const unsupported = new UnsupportedDriver();
    expect(() => createOperation(unsupported)).toThrow(
      "supports neither transactions nor atomic batch execution"
    );
    expect(unsupported.executions).toBe(0);
  });

  test("plans on the transaction-bound driver and fails closed on a missing generated id", async () => {
    const driver = new TransactionProbeDriver();

    await expect(
      createOperationExecutor(driver).executeCreate(
        operationFragmentSchema.user,
        createNestedUpsertArgs()
      )
    ).rejects.toThrow("did not produce row field 'id'");

    expect(driver.clients).toEqual(["transaction", "transaction"]);
    expect(driver.statements[0]).toContain("FOR UPDATE");
  });

  test("passes engine-owned attribution through staged transaction execution", async () => {
    const driver = new TransactionProbeDriver();
    const instrumentation = createInstrumentationContext({});
    const executor = new OperationExecutor(
      new QueryEngine(
        driver,
        createModelRegistry(
          operationFragmentSchema,
          createSchemaRegistry(operationFragmentSchema)
        ),
        instrumentation
      )
    );

    await expect(
      executor.executeCreate(
        operationFragmentSchema.user,
        createNestedUpsertArgs()
      )
    ).rejects.toThrow("did not produce row field 'id'");

    expect(driver.contexts[0]).toMatchObject({
      model: "user",
      operation: "create",
    });
    expect(driver.contexts[0]?.correlationId).toEqual(expect.any(String));
    expect(getExecutionInstrumentation(driver.contexts[0])).toBeDefined();
  });

  test("uses the validated selection snapshot during result parsing", () => {
    const driver = new TransactionProbeDriver();
    const args = createNestedUpsertArgs();
    const operation = new CreateOperation(
      driverEngine(driver),
      operationFragmentSchema.user,
      args
    );
    args.select.name = false;
    args.select.posts = false;

    expect(
      operation.parseResult({
        result: [{ name: "henry", posts: [] }],
      })
    ).toEqual({ name: "henry", posts: [] });
  });

  test("performs one planning read before one atomic batch and preserves guard provider errors", async () => {
    const driver = new GuardProviderFailureBatchDriver();
    const execution = createOperationExecutor(driver).executeCreate(
      operationFragmentSchema.user,
      createNestedUpsertArgs()
    );

    await expect(execution).rejects.toBe(driver.failure);
    await expect(execution).rejects.not.toBeInstanceOf(NestedWriteError);
    expect(driver.executions).toBe(1);
    expect(driver.batchCalls).toBe(1);
    expect(driver.guardIndex).toBeGreaterThanOrEqual(0);
  });

  test("rejects malformed provider results and incorrect batch result counts", async () => {
    const malformed = new MalformedResultDriver();
    await expect(
      createOperationExecutor(malformed).executeCreate(
        operationFragmentSchema.user,
        createNestedUpsertArgs()
      )
    ).rejects.toThrow("malformed normalized result");
    expect(malformed.batchCalls).toBe(0);

    const short = new ShortBatchDriver();
    await expect(
      createOperationExecutor(short).executeCreate(
        operationFragmentSchema.user,
        createNestedUpsertArgs()
      )
    ).rejects.toThrow("returned 0 results");
    expect(short.executions).toBe(1);
    expect(short.batchCalls).toBe(1);
  });

  test(
    "rolls back transaction writes when result parsing fails",
    { timeout: 30_000 },
    async () => {
      const db = new PGlite();
      const setup = createClient({
        schema: operationFragmentSchema,
        driver: new PGliteDriver({ client: db }),
      });
      const driver = new FailingResultPGliteDriver({ client: db });
      try {
        await push(setup, { force: true });

        await expect(
          createOperationExecutor(driver).executeCreate(
            operationFragmentSchema.user,
            createNestedUpsertArgs()
          )
        ).rejects.toBe(driver.failure);
        await expect(setup.user.findMany()).resolves.toEqual([]);
        await expect(setup.post.findMany()).resolves.toEqual([]);
      } finally {
        await setup.$disconnect();
      }
    }
  );

  test(
    "propagates a post-guard unique conflict and rolls back without retry",
    { timeout: 30_000 },
    async () => {
      const db = new PGlite();
      const setup = createClient({
        schema: operationFragmentSchema,
        driver: new PGliteDriver({ client: db }),
      });
      const driver = new BatchOnlyPGliteDriver({ client: db });
      try {
        await push(setup, { force: true });
        await setup.post.create({
          data: {
            id: 2,
            title: "existing",
            slug: "post-key",
            userId: null,
          },
        });

        await expect(
          createOperationExecutor(driver).executeCreate(
            operationFragmentSchema.user,
            createNestedUpsertArgs()
          )
        ).rejects.toBeInstanceOf(UniqueConstraintError);
        expect(driver.batchCalls).toBe(1);
        await expect(setup.user.findMany()).resolves.toEqual([]);
        await expect(setup.post.findMany()).resolves.toEqual([
          {
            id: 2,
            title: "existing",
            slug: "post-key",
            userId: null,
          },
        ]);
      } finally {
        await setup.$disconnect();
      }
    }
  );

  test(
    "fails a stale batch premise before writes and leaves no partial mutation",
    { timeout: 30_000 },
    async () => {
      const db = new PGlite();
      const setup = createClient({
        schema: operationFragmentSchema,
        driver: new PGliteDriver({ client: db }),
      });
      try {
        await push(setup, { force: true });
        await setup.post.create({
          data: {
            id: 1,
            title: "draft",
            slug: "post-key",
            userId: null,
          },
        });
        const driver = new BeforeBatchPGliteDriver(
          async () => {
            await setup.post.delete({ where: { id: 1 } });
          },
          { client: db }
        );

        await expect(
          createOperationExecutor(driver).executeCreate(
            operationFragmentSchema.user,
            createNestedUpsertArgs("published")
          )
        ).rejects.toBeInstanceOf(NestedWriteError);
        expect(driver.batchCalls).toBe(1);
        await expect(setup.user.findMany()).resolves.toEqual([]);
        await expect(setup.post.findMany()).resolves.toEqual([]);
      } finally {
        await setup.$disconnect();
      }
    }
  );
});

function driverEngine(driver: Driver<unknown, unknown>): QueryEngine {
  const schemas = createSchemaRegistry(operationFragmentSchema);
  return new QueryEngine(
    driver,
    createModelRegistry(operationFragmentSchema, schemas)
  );
}

function createOperation(driver: Driver<unknown, unknown>): CreateOperation {
  return new CreateOperation(
    driverEngine(driver),
    operationFragmentSchema.user,
    createNestedUpsertArgs()
  );
}
