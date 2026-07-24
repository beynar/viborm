import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import { Driver } from "@drivers/driver";
import type { BatchQuery, QueryResult } from "@drivers/types";
import { isVibORMError, QueryError } from "@errors";
import { createInstrumentationContext } from "@instrumentation/context";
import {
  ATTR_DB_COLLECTION,
  ATTR_DB_OPERATION_NAME,
  ATTR_VIBORM_CORRELATION_ID,
  SPAN_OPERATION,
} from "@instrumentation/spans";
import type { TracerWrapper, VibORMSpanOptions } from "@instrumentation/tracer";
import type { PendingOperation } from "@query-engine/pending-operation";
import type { PreparedBatchOperation } from "@query-engine/types";
import { s } from "@schema";
import { describe, expect, it, vi } from "vitest";
import { captureLogs } from "./_capture";

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

class AttributionTracer implements TracerWrapper {
  readonly options: VibORMSpanOptions[] = [];

  async startActiveSpan<T>(
    options: VibORMSpanOptions,
    fn: () => T | Promise<T>
  ): Promise<T> {
    this.options.push(options);
    return fn();
  }

  startActiveSpanSync<T>(options: VibORMSpanOptions, fn: () => T): T {
    this.options.push(options);
    return fn();
  }

  isEnabled(): boolean {
    return true;
  }
}

const user = s.model({ id: s.string().id() });
const post = s.model({ id: s.int().id() });

function createInstrumentedClient(driver: NativeAttributionDriver) {
  const logs = captureLogs();
  const tracer = new AttributionTracer();
  const base = createInstrumentationContext({
    logging: { error: logs.callback },
    tracing: true,
  });
  const client = createClient({
    schema: { user, post },
    driver,
    instrumentation: { ...base, tracer },
  });
  return { client, logs, tracer };
}

describe("native batch logical attribution", () => {
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
    driver.setInstrumentation(
      createInstrumentationContext({
        logging: {
          error: logs.callback,
          includeParams: true,
          includeSql: true,
        },
      })
    );

    const error = await driver
      ._executeBatch(
        [
          {
            sql: "SELECT statement_a",
            params: [{ token: "statement-a-secret" }],
            context: {
              model: "user",
              operation: "findMany",
              correlationId: "statement-a-correlation",
            },
          },
          {
            sql: "SELECT statement_b",
            params: [{ token: "statement-b-secret" }],
            context: {
              model: "post",
              operation: "findMany",
              correlationId: "statement-b-correlation",
            },
          },
        ],
        undefined,
        {
          model: "$transaction",
          operation: "$transaction([...])",
          correlationId: "statement-outer-correlation",
        }
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

  it("attributes operation-two scalar parsing failures", async () => {
    const driver = new NativeAttributionDriver();
    const { client, logs, tracer } = createInstrumentedClient(driver);
    const first = client.user.findMany();
    const second = client.post.findMany();
    const secondContext = second.getExecutionContext();

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
      tracer.options.some(
        (options) =>
          options.name === SPAN_OPERATION &&
          options.attributes?.[ATTR_DB_COLLECTION] === "post" &&
          options.attributes?.[ATTR_DB_OPERATION_NAME] === "findMany" &&
          options.attributes?.[ATTR_VIBORM_CORRELATION_ID] ===
            secondContext.correlationId
      )
    ).toBe(true);
  });

  it("attributes operation-two preparation failures", async () => {
    const driver = new NativeAttributionDriver();
    const { client, logs } = createInstrumentedClient(driver);
    const first = client.user.findMany();
    const failing = client.post.findMany();
    const secondContext = failing.getExecutionContext();
    vi.spyOn(failing, "prepare").mockImplementation(() => {
      throw new QueryError("Preparation failed", {
        meta: { operation: "build" },
      });
    });

    const error = await client
      .$transaction([first, failing])
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
      })
    );
    expect(driver.submitted).toHaveLength(0);
  });

  it.each([
    { failedSql: "setup", expected: "outer" },
    { failedSql: "operation-two", expected: "second" },
    { failedSql: "cleanup", expected: "outer" },
  ])("attributes $failedSql failures to the correct logical scope", async ({
    failedSql,
    expected,
  }) => {
    const driver = new NativeAttributionDriver();
    driver.failSql = failedSql;
    const { client } = createInstrumentedClient(driver);
    const firstSeed = client.user.findMany();
    const secondSeed = client.post.findMany();
    const first = createPlannedOperation(firstSeed, "operation-one");
    const second = createPlannedOperation(secondSeed, "operation-two");

    const error = await client
      .$transaction([first, second])
      .catch((caught) => caught);
    if (!isVibORMError(error)) throw new Error("expected a VibORMError");

    if (expected === "second") {
      const secondContext = second.getExecutionContext();
      expect(error.meta).toMatchObject({
        model: secondContext.model,
        operation: secondContext.operation,
        correlationId: secondContext.correlationId,
      });
    } else {
      expect(error.meta).toMatchObject({
        model: "$transaction",
        operation: "$transaction([...])",
        correlationId: expect.any(String),
      });
    }
    expect(driver.submitted.map((query) => query.context?.model)).toEqual([
      "$transaction",
      "user",
      "post",
      "$transaction",
    ]);
  });
});

function createPlannedOperation(
  seed: PendingOperation<unknown>,
  sql: string
): PendingOperation<unknown> {
  const context = seed.getExecutionContext();
  const prepared: PreparedBatchOperation<unknown> = {
    setupQueries: [{ sql: "setup", params: [], context }],
    queries: [{ sql, params: [], context }],
    cleanupQueries: [{ sql: "cleanup", params: [], context }],
    parseResult: () => undefined,
  };
  vi.spyOn(seed, "prepare").mockReturnValue(undefined);
  vi.spyOn(seed, "prepareBatch").mockResolvedValue(prepared);
  return seed;
}
