import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import { Driver } from "@drivers/driver";
import type { BatchQuery, QueryResult } from "@drivers/types";
import { isVibORMError, QueryError } from "@errors";
import {
  ATTR_DB_COLLECTION,
  ATTR_DB_OPERATION_NAME,
  ATTR_VIBORM_CORRELATION_ID,
  SPAN_OPERATION,
} from "@instrumentation/spans";
import { observeTransactionBatchPhase } from "@query-engine/execution-context";
import type { PendingOperation } from "@query-engine/pending-operation";
import type { PreparedBatchOperation } from "@query-engine/types";
import { s } from "@schema";
import { instrumentation } from "@src/instrumentation/exports";
import {
  overrideTransactionOperation,
  readTestTransactionOperation,
  type TestTransactionOperation,
} from "@tests/fixtures/transaction-operation";
import {
  captureLogs,
  type OtelRecorder,
  withOtelRecorder,
} from "@tests/unit/instrumentation/_capture";
import { createOfficialTestExecutionContext } from "@tests/unit/instrumentation/_official-context";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

class NativeAttributionDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  failSql: string | undefined;
  staleError: QueryError | undefined;
  submitted: BatchQuery[] = [];

  constructor() {
    super("sqlite", "native-attribution");
  }

  protected initClient(): Promise<object> {
    return Promise.resolve({});
  }

  protected closeClient(): Promise<void> {
    return Promise.resolve();
  }

  protected execute<T>(): Promise<QueryResult<T>> {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  protected executeRaw<T>(): Promise<QueryResult<T>> {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  protected transaction<T>(
    client: object,
    fn: (tx: object) => Promise<T>
  ): Promise<T> {
    return fn(client);
  }

  protected executeBatch<T>(
    _client: object,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.submitted = queries;
    if (this.staleError) throw this.staleError;
    const failed = queries.find((query) => query.sql === this.failSql);
    if (failed) {
      throw new QueryError("Native batch statement failed", {
        meta: {
          driver: this.driverName,
          model: failed.context?.model,
          operation: failed.context?.operation,
          correlationId: failed.context?.correlationId,
        },
      });
    }
    return Promise.resolve(
      queries.map((query) => ({
        rows: [
          query.context?.model === "post"
            ? { id: "not-an-integer" }
            : { id: "valid-id" },
        ] as T[],
        rowCount: 1,
      }))
    );
  }
}

const user = s.model({ id: s.string().id() });
const post = s.model({ id: s.int().id() });

function createInstrumentedClient(driver: NativeAttributionDriver) {
  const logs = captureLogs();
  const client = createClient({
    schema: { user, post },
    driver,
  }).$extends(
    instrumentation({
      logging: { error: logs.callback },
      tracing: true,
    })
  );
  return { client, logs };
}

function transactionOperation(operation: unknown) {
  const capability = readTestTransactionOperation(operation);
  if (!capability) throw new Error("expected a transaction operation");
  return capability;
}

function runUnsafeArrayTransaction(
  client: object,
  candidates: readonly unknown[]
): Promise<unknown> {
  const transaction = Reflect.get(client, "$transaction");
  if (typeof transaction !== "function") {
    throw new Error("Expected $transaction");
  }
  return Reflect.apply(transaction, client, [candidates]);
}

describe("native batch logical attribution", () => {
  let recorder: OtelRecorder;

  beforeAll(() => {
    recorder = withOtelRecorder();
  });

  afterAll(async () => {
    await recorder.dispose();
  });

  it("keeps the unobserved batch phase inert while normalizing failures", async () => {
    const driver = new NativeAttributionDriver();
    const operation = createClient({
      schema: { user },
      driver,
    }).user.findMany();
    const context = transactionOperation(operation).context;
    const correlationId = context.correlationId;
    const startedSpans = recorder.spans().length;
    const clock = vi.spyOn(Date, "now");
    const baseAttributes = vi.spyOn(driver, "getBaseAttributes");

    try {
      await expect(
        observeTransactionBatchPhase(context, driver, () => "done")
      ).resolves.toBe("done");

      const failure = await observeTransactionBatchPhase(
        context,
        driver,
        () => {
          throw new Error("batch preparation failed");
        }
      ).catch((error) => error);

      if (!isVibORMError(failure)) throw new Error("expected a VibORMError");
      expect(failure.meta).toMatchObject({
        driver: driver.driverName,
        model: "user",
        operation: "findMany",
        correlationId,
      });
      expect(clock).not.toHaveBeenCalled();
      expect(baseAttributes).not.toHaveBeenCalled();
      expect(recorder.spans()).toHaveLength(startedSpans);
    } finally {
      clock.mockRestore();
      baseAttributes.mockRestore();
    }
  });

  it("rejects stale attribution from outside the current batch", async () => {
    const driver = new NativeAttributionDriver();
    driver.staleError = new QueryError("Stale provider error", {
      meta: {
        driver: driver.driverName,
        model: "foreign",
        operation: "delete",
        correlationId: "foreign-correlation",
      },
    });

    const error = await driver
      ._executeBatch(
        [
          {
            sql: "SELECT current",
            context: {
              model: "user",
              operation: "findMany",
              correlationId: "current-correlation",
            },
          },
        ],
        undefined,
        {
          model: "$transaction",
          operation: "$transaction([...])",
          correlationId: "outer-correlation",
        }
      )
      .catch((caught) => caught);

    if (!isVibORMError(error)) throw new Error("expected a VibORMError");
    expect(error.meta).toMatchObject({
      model: "$transaction",
      operation: "$transaction([...])",
      correlationId: "outer-correlation",
    });
    expect(JSON.stringify(error)).not.toContain("foreign-correlation");
  });

  it("logs only the uniquely attributed failing statement payload", async () => {
    const driver = new NativeAttributionDriver();
    const logs = captureLogs();
    driver.failSql = "SELECT statement_b";
    const officialContext = (values: BatchQuery["context"]) =>
      createOfficialTestExecutionContext(
        {
          logging: {
            error: logs.callback,
            includeParams: true,
            includeSql: true,
          },
        },
        values ?? {}
      );

    const error = await driver
      ._executeBatch(
        [
          {
            sql: "SELECT statement_a",
            params: [{ token: "statement-a-secret" }],
            context: officialContext({
              model: "user",
              operation: "findMany",
              correlationId: "statement-a-correlation",
            }),
          },
          {
            sql: "SELECT statement_b",
            params: [{ token: "statement-b-secret" }],
            context: officialContext({
              model: "post",
              operation: "findMany",
              correlationId: "statement-b-correlation",
            }),
          },
        ],
        undefined,
        officialContext({
          model: "$transaction",
          operation: "$transaction([...])",
          correlationId: "statement-outer-correlation",
        })
      )
      .catch((caught) => caught);

    if (!isVibORMError(error)) throw new Error("expected a VibORMError");
    expect(error.meta).not.toHaveProperty("query");
    expect(error.meta).not.toHaveProperty("params");
    expect(logs.events).toHaveLength(1);
    expect(logs.events[0]).toMatchObject({
      model: "post",
      operation: "findMany",
      correlationId: "statement-b-correlation",
      sql: "SELECT statement_b",
      params: [{ token: "statement-b-secret" }],
    });
    expect(JSON.stringify(logs.events)).not.toContain("statement-a-secret");
    expect(JSON.stringify(logs.events)).not.toContain("SELECT statement_a");
  });

  it("sanitizes disclosed batch parameters once and skips undisclosed values", async () => {
    let undisclosedReads = 0;
    const undisclosed = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        undisclosedReads += 1;
        return "undisclosed";
      },
    });
    const privateDriver = new NativeAttributionDriver();

    await privateDriver._executeBatch([
      { sql: "SELECT private", params: [undisclosed] },
    ]);
    expect(undisclosedReads).toBe(0);

    let disclosedSnapshots = 0;
    const disclosed = new Proxy(
      { secret: "disclosed" },
      {
        ownKeys(target) {
          disclosedSnapshots += 1;
          return Reflect.ownKeys(target);
        },
      }
    );
    const logs = captureLogs();
    const observedDriver = new NativeAttributionDriver();
    observedDriver.failSql = "SELECT observed";
    const context = createOfficialTestExecutionContext(
      { logging: { error: logs.callback, includeParams: true } },
      {
        model: "user",
        operation: "findMany",
        correlationId: "observed-correlation",
      }
    );

    await observedDriver
      ._executeBatch(
        [
          {
            sql: "SELECT observed",
            params: [disclosed],
            context,
          },
        ],
        undefined,
        context
      )
      .catch(() => undefined);

    expect(disclosedSnapshots).toBe(1);
    expect(logs.events[0]?.params).toEqual([{ secret: "disclosed" }]);
  });

  it("attributes operation-two scalar parsing failures", async () => {
    const driver = new NativeAttributionDriver();
    const { client, logs } = createInstrumentedClient(driver);
    const first = client.user.findMany();
    const second = client.post.findMany();
    const secondContext = transactionOperation(second).context;

    const error = await client
      .$transaction([first, second])
      .catch((caught) => caught);

    if (!isVibORMError(error)) throw new Error("expected a VibORMError");
    expect(error.meta).toMatchObject({
      model: secondContext.model,
      operation: secondContext.operation,
      correlationId: secondContext.correlationId,
    });
    expect(logs.events).toContainEqual(
      expect.objectContaining({
        level: "error",
        model: "post",
        operation: "findMany",
        correlationId: secondContext.correlationId,
        duration: expect.any(Number),
      })
    );
    expect(
      recorder
        .spans()
        .some(
          (span) =>
            span.name === SPAN_OPERATION &&
            span.attributes[ATTR_DB_COLLECTION] === "post" &&
            span.attributes[ATTR_DB_OPERATION_NAME] === "findMany" &&
            span.attributes[ATTR_VIBORM_CORRELATION_ID] ===
              secondContext.correlationId
        )
    ).toBe(true);
  });

  it("attributes operation-two preparation failures", async () => {
    const driver = new NativeAttributionDriver();
    const { client, logs } = createInstrumentedClient(driver);
    const first = client.user.findMany();
    const failing = client.post.findMany();
    const secondContext = transactionOperation(failing).context;
    const failingOperation = overrideTransactionOperation(failing, {
      prepare: () => {
        throw new QueryError("Preparation failed", {
          meta: { operation: "build" },
        });
      },
    });

    const error = await runUnsafeArrayTransaction(client, [
      first,
      failingOperation,
    ]).catch((caught) => caught);

    if (!isVibORMError(error)) throw new Error("expected a VibORMError");
    expect(error.meta).toMatchObject({
      model: secondContext.model,
      operation: secondContext.operation,
      correlationId: secondContext.correlationId,
    });
    expect(logs.events).toContainEqual(
      expect.objectContaining({
        level: "error",
        model: "post",
        operation: "findMany",
        correlationId: secondContext.correlationId,
      })
    );
    expect(driver.submitted).toHaveLength(0);
  });

  it("attributes a merged-batch member failure to its own logical operation", async () => {
    const driver = new NativeAttributionDriver();
    driver.failSql = "operation-two";
    const { client } = createInstrumentedClient(driver);
    const firstSeed = client.user.findMany();
    const secondSeed = client.post.findMany();
    const first = createPlannedOperation(firstSeed, "operation-one");
    const second = createPlannedOperation(secondSeed, "operation-two");

    const error = await runUnsafeArrayTransaction(client, [
      first,
      second,
    ]).catch((caught) => caught);
    if (!isVibORMError(error)) throw new Error("expected a VibORMError");

    const secondContext = transactionOperation(second).context;
    expect(error.meta).toMatchObject({
      model: secondContext.model,
      operation: secondContext.operation,
      correlationId: secondContext.correlationId,
    });
    // Every query in the merged batch carries its own operation's context —
    // the batch has no outer-scoped setup/cleanup entries (that channel had no
    // production writer and was deleted by distinct-truth unit 9.3).
    expect(driver.submitted.map((query) => query.context?.model)).toEqual([
      "user",
      "post",
    ]);
  });
});

function createPlannedOperation(
  seed: PendingOperation<unknown>,
  sql: string
): TestTransactionOperation<unknown> {
  const context = transactionOperation(seed).context;
  const prepared: PreparedBatchOperation<unknown> = {
    queries: [{ sql, params: [], context }],
    parseResult: () => undefined,
  };
  return overrideTransactionOperation(seed, {
    prepare: () => undefined,
    prepareBatch: async () => prepared,
  });
}
