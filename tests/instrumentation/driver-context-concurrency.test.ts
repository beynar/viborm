import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { MemoryCache } from "@cache/drivers/memory";
import { createClient } from "@client/client";
import { Driver, type QueryExecutionContext } from "@drivers/driver";
import type { BatchQuery, QueryResult } from "@drivers/types";
import { isVibORMError } from "@errors";
import { createInstrumentationContext } from "@instrumentation/context";
import {
  ATTR_DB_COLLECTION,
  ATTR_DB_OPERATION_NAME,
  ATTR_VIBORM_CORRELATION_ID,
} from "@instrumentation/spans";
import { s } from "@schema";
import { describe, expect, it, vi } from "vitest";
import { captureLogs } from "./_capture";

const QUERY = "SELECT id FROM example WHERE id = ?";

function createDeferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {
    promise,
    resolve(): void {
      if (!resolve) throw new Error("deferred promise was not initialized");
      resolve();
    },
  };
}

class ControlledOverlapDriver extends Driver<object, object> {
  readonly adapter = {} as DatabaseAdapter;
  readonly started = new Map<string, ReturnType<typeof createDeferred>>();
  readonly releases = new Map<string, ReturnType<typeof createDeferred>>();

  constructor() {
    super("sqlite", "controlled-overlap");
    for (const id of ["success", "failure"]) {
      this.started.set(id, createDeferred());
      this.releases.set(id, createDeferred());
    }
  }

  protected initClient(): Promise<object> {
    return Promise.resolve({});
  }

  protected closeClient(): Promise<void> {
    return Promise.resolve();
  }

  protected execute<T>(
    client: object,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.executeRaw(client, sql, params, context);
  }

  protected async executeRaw<T>(
    _client: object,
    _sql: string,
    params?: unknown[],
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const id = String(params?.[0]);
    this.started.get(id)?.resolve();
    await this.releases.get(id)?.promise;
    if (id === "failure") throw new Error("private provider failure");
    return { rows: [{ id }] as T[], rowCount: 1 };
  }

  protected transaction<T>(
    client: object,
    fn: (tx: object) => Promise<T>
  ): Promise<T> {
    return fn(client);
  }
}

class ContextRecordingDriver extends Driver<object, object> {
  readonly adapter = {} as DatabaseAdapter;
  readonly calls: Array<{ sql: string; context: QueryExecutionContext }> = [];

  constructor() {
    super("sqlite", "context-recording");
  }

  protected initClient(): Promise<object> {
    return Promise.resolve({});
  }

  protected closeClient(): Promise<void> {
    return Promise.resolve();
  }

  protected execute<T>(
    client: object,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.executeRaw(client, sql, params, context);
  }

  protected executeRaw<T>(
    _client: object,
    sql: string,
    _params?: unknown[],
    context: QueryExecutionContext = {}
  ): Promise<QueryResult<T>> {
    this.calls.push({ sql, context });
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  protected transaction<T>(
    client: object,
    fn: (tx: object) => Promise<T>
  ): Promise<T> {
    return fn(client);
  }
}

class BatchContextDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  batchQueries: BatchQuery[] = [];

  constructor() {
    super("sqlite", "batch-context");
  }

  protected initClient(): Promise<object> {
    return Promise.resolve({});
  }

  protected closeClient(): Promise<void> {
    return Promise.resolve();
  }

  protected execute<T>(): Promise<QueryResult<T>> {
    return Promise.resolve({ rows: [{ id: "row" }] as T[], rowCount: 1 });
  }

  protected executeRaw<T>(): Promise<QueryResult<T>> {
    return Promise.resolve({ rows: [{ id: "row" }] as T[], rowCount: 1 });
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
    this.batchQueries = queries;
    return Promise.resolve(
      queries.map(() => ({
        rows: [{ id: "row" }] as T[],
        rowCount: 1,
      }))
    );
  }
}

class CacheReadDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();

  constructor() {
    super("sqlite", "cache-read");
  }

  protected initClient(): Promise<object> {
    return Promise.resolve({});
  }

  protected closeClient(): Promise<void> {
    return Promise.resolve();
  }

  protected execute<T>(): Promise<QueryResult<T>> {
    return Promise.resolve({
      rows: [{ id: "cached-row" }] as T[],
      rowCount: 1,
    });
  }

  protected executeRaw<T>(): Promise<QueryResult<T>> {
    return this.execute<T>();
  }

  protected transaction<T>(
    client: object,
    fn: (tx: object) => Promise<T>
  ): Promise<T> {
    return fn(client);
  }
}

describe("driver execution context concurrency", () => {
  it("keeps an in-flight operation on its original logging handler", async () => {
    const original = captureLogs();
    const mutated = captureLogs();
    const logging = {
      includeParams: true,
      includeSql: true,
      query: original.callback,
    };
    const driver = new ControlledOverlapDriver();
    driver.setInstrumentation(createInstrumentationContext({ logging }));

    const execution = driver._executeRaw(QUERY, ["success"], {
      model: "user",
      operation: "findMany",
      correlationId: "handler-snapshot",
    });
    await driver.started.get("success")?.promise;
    logging.includeParams = false;
    logging.includeSql = false;
    logging.query = mutated.callback;
    driver.releases.get("success")?.resolve();

    await expect(execution).resolves.toMatchObject({ rowCount: 1 });
    expect(original.events).toHaveLength(1);
    expect(original.events[0]).toMatchObject({
      correlationId: "handler-snapshot",
      sql: QUERY,
      params: ["success"],
    });
    expect(mutated.events).toHaveLength(0);
  });

  it("keeps overlapping success and failure attribution request-scoped", async () => {
    const capture = captureLogs();
    const spans: Array<{
      model: unknown;
      operation: unknown;
      correlationId: unknown;
    }> = [];
    const instrumentation = createInstrumentationContext({
      logging: { query: capture.callback, error: capture.callback },
    });
    const driver = new ControlledOverlapDriver();
    driver.setInstrumentation({
      ...instrumentation,
      tracer: {
        async startActiveSpan(options, fn) {
          spans.push({
            model: options.attributes?.[ATTR_DB_COLLECTION],
            operation: options.attributes?.[ATTR_DB_OPERATION_NAME],
            correlationId: options.attributes?.[ATTR_VIBORM_CORRELATION_ID],
          });
          return fn();
        },
        startActiveSpanSync(_options, fn) {
          return fn();
        },
        isEnabled: () => true,
      },
    });

    const success = driver._executeRaw(QUERY, ["success"], {
      model: "user",
      operation: "findMany",
      correlationId: "success-correlation",
    });
    const failure = driver
      ._executeRaw(QUERY, ["failure"], {
        model: "post",
        operation: "delete",
        correlationId: "failure-correlation",
      })
      .catch((error) => error);
    await Promise.all([
      driver.started.get("success")?.promise,
      driver.started.get("failure")?.promise,
    ]);
    driver.releases.get("failure")?.resolve();
    driver.releases.get("success")?.resolve();

    await expect(success).resolves.toMatchObject({ rowCount: 1 });
    const failed = await failure;
    expect(failed).toMatchObject({
      meta: {
        model: "post",
        operation: "delete",
        correlationId: "failure-correlation",
      },
    });
    expect(
      capture.events.map((event) => ({
        level: event.level,
        model: event.model,
        operation: event.operation,
        correlationId: event.correlationId,
        hasDuration: typeof event.duration === "number",
      }))
    ).toEqual([
      {
        level: "error",
        model: "post",
        operation: "delete",
        correlationId: "failure-correlation",
        hasDuration: true,
      },
      {
        level: "query",
        model: "user",
        operation: "findMany",
        correlationId: "success-correlation",
        hasDuration: true,
      },
    ]);
    expect(spans).toEqual([
      {
        model: "user",
        operation: "findMany",
        correlationId: "success-correlation",
      },
      {
        model: "post",
        operation: "delete",
        correlationId: "failure-correlation",
      },
    ]);
  });

  it("inherits immutable context through outer and nested transaction drivers", async () => {
    const driver = new ContextRecordingDriver();
    const outerContext = {
      model: "user",
      operation: "update",
      correlationId: "outer-correlation",
    };
    const nestedContext = {
      model: "post",
      operation: "create",
      correlationId: "nested-correlation",
    };

    await driver.withTransaction(
      async (outer) => {
        await outer._executeRaw("outer query");
        await outer.withTransaction(
          async (nested) => {
            await nested._executeRaw("nested query");
          },
          undefined,
          nestedContext
        );
      },
      undefined,
      outerContext
    );

    expect(
      driver.calls.find((call) => call.sql === "outer query")?.context
    ).toEqual(outerContext);
    expect(
      driver.calls.find((call) => call.sql === "nested query")?.context
    ).toEqual(nestedContext);
    for (const savepointCall of driver.calls.filter((call) =>
      call.sql.includes("SAVEPOINT")
    )) {
      expect(savepointCall.context).toEqual(nestedContext);
    }
  });

  it("creates one correlation per ORM operation and retains it in native batches", async () => {
    const user = s.model({ id: s.string().id() });
    const driver = new BatchContextDriver();
    const client = createClient({ schema: { user }, driver });
    const first = client.user.findMany();
    const second = client.user.findMany();
    const firstContext = first.getExecutionContext();
    const secondContext = second.getExecutionContext();

    expect(first.prepare(driver)?.context).toBe(firstContext);
    expect(firstContext.correlationId).toEqual(expect.any(String));
    expect(secondContext.correlationId).toEqual(expect.any(String));
    expect(secondContext.correlationId).not.toBe(firstContext.correlationId);

    await client.$transaction([first, second]);

    expect(driver.batchQueries.map((query) => query.context)).toEqual([
      firstContext,
      secondContext,
    ]);
  });

  it("keeps two clients on one driver bound to their own sinks and disclosure", async () => {
    const model = s.model({ id: s.string().id() });
    const driver = new ControlledOverlapDriver();
    const firstCapture = captureLogs();
    const secondCapture = captureLogs();
    const firstClient = createClient({
      schema: { model },
      driver,
      instrumentation: {
        logging: {
          error: firstCapture.callback,
          query: firstCapture.callback,
        },
      },
    });

    const firstRequest = firstClient
      .$queryRawUnsafe(QUERY, "failure")
      .catch((error) => error);
    await driver.started.get("failure")?.promise;

    const secondClient = createClient({
      schema: { model },
      driver,
      instrumentation: {
        diagnostics: { includeParams: true, includeSql: true },
        logging: {
          error: secondCapture.callback,
          includeParams: true,
          includeSql: true,
          query: secondCapture.callback,
        },
      },
    });
    const secondRequest = secondClient.$queryRawUnsafe(QUERY, "success");
    await driver.started.get("success")?.promise;
    driver.releases.get("success")?.resolve();
    driver.releases.get("failure")?.resolve();

    await expect(secondRequest).resolves.toEqual([{ id: "success" }]);
    const firstError = await firstRequest;
    if (!isVibORMError(firstError)) throw new Error("expected a VibORMError");
    expect(firstError).toMatchObject({
      meta: { model: "$raw", operation: "$queryRawUnsafe" },
    });
    expect(firstError.meta).not.toHaveProperty("query");
    expect(firstError.meta).not.toHaveProperty("params");
    expect(firstCapture.events).toHaveLength(1);
    expect(firstCapture.events[0]).toMatchObject({
      level: "error",
      model: "$raw",
      operation: "$queryRawUnsafe",
    });
    expect(secondCapture.events).toHaveLength(1);
    expect(secondCapture.events[0]).toMatchObject({
      level: "query",
      model: "$raw",
      operation: "$queryRawUnsafe",
      sql: QUERY,
      params: ["success"],
    });
  });

  it("keeps shared-cache miss, hit, and stale events client-scoped", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T00:00:00.000Z"));
    try {
      const model = s.model({ id: s.string().id() });
      const driver = new CacheReadDriver();
      const cache = new MemoryCache();
      const firstCapture = captureLogs();
      const secondCapture = captureLogs();
      const firstClient = createClient({
        schema: { model },
        driver,
        cache,
        instrumentation: { logging: { cache: firstCapture.callback } },
      });
      const secondClient = createClient({
        schema: { model },
        driver,
        cache,
        instrumentation: { logging: { cache: secondCapture.callback } },
      });

      await firstClient
        .$withCache({ key: "shared", ttl: 10, swr: 100 })
        .model.findMany();
      await Promise.resolve();
      await Promise.resolve();
      await secondClient
        .$withCache({ key: "shared", ttl: 10, swr: 100 })
        .model.findMany();
      vi.setSystemTime(new Date("2026-07-10T00:00:00.020Z"));
      await secondClient
        .$withCache({ key: "shared", ttl: 10, swr: 100 })
        .model.findMany();
      await Promise.resolve();
      await Promise.resolve();

      expect(firstCapture.events).toEqual([
        expect.objectContaining({
          level: "cache",
          model: "model",
          operation: "findMany",
          meta: expect.objectContaining({ event: "miss" }),
        }),
      ]);
      expect(secondCapture.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: "cache",
            model: "model",
            operation: "findMany",
            meta: expect.objectContaining({ event: "hit" }),
          }),
          expect.objectContaining({
            level: "cache",
            model: "model",
            operation: "findMany",
            meta: expect.objectContaining({
              event: "hit",
              status: "stale",
            }),
          }),
        ])
      );
      expect(
        firstCapture.events.every(
          (event) => typeof event.correlationId === "string"
        )
      ).toBe(true);
      expect(
        secondCapture.events.every(
          (event) => typeof event.correlationId === "string"
        )
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
