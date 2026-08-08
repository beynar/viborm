/**
 * Integration: src/drivers/driver.ts instrumentation wiring.
 *
 * Drives real query execution through a minimal in-memory Driver subclass and
 * asserts the logs + spans that flow out via the actual `withInstrumentation`
 * path (fast-path skip, logger dispatch, tracer dispatch, error handling).
 *
 * Uses the shared `_capture.ts` helpers — no bespoke capture code.
 */

import { isVibORMError } from "@errors";
import { createInstrumentationContext } from "@instrumentation/context";
import {
  ATTR_DB_COLLECTION,
  ATTR_DB_OPERATION_NAME,
  ATTR_DB_QUERY_TEXT,
  ATTR_DB_SYSTEM,
  SPAN_DISCONNECT,
  SPAN_EXECUTE,
} from "@instrumentation/spans";
import {
  captureLogs,
  withOtelRecorder,
} from "@tests/unit/instrumentation/_capture";
import {
  FakeDriver,
  type FakeRow as Row,
} from "@tests/unit/instrumentation/_fake-driver";
import { afterEach, describe, expect, it } from "vitest";

const QUERY = "SELECT id FROM user WHERE id = ?";

describe("driver instrumentation wiring", () => {
  let recorder: ReturnType<typeof withOtelRecorder> | undefined;

  afterEach(async () => {
    if (recorder) {
      await recorder.dispose();
      recorder = undefined;
    }
  });

  // -------------------------------------------------------------------------
  // Fast path: nothing configured.
  // -------------------------------------------------------------------------

  it("fast path: no instrumentation emits zero spans and zero logs but still runs the query", async () => {
    recorder = withOtelRecorder();
    const capture = captureLogs();
    const driver = new FakeDriver();
    // Never call setInstrumentation → this.instrumentation is undefined.

    const result = await driver._executeRaw<Row>(QUERY, [1]);

    expect(result.rows).toEqual([{ id: 1 }]);
    expect(capture.events).toHaveLength(0);
    // No span named viborm.execute (or any span) should be recorded.
    expect(recorder.find(SPAN_EXECUTE)).toBeUndefined();
    expect(recorder.spans()).toHaveLength(0);
  });

  it("fast path still normalizes driver errors into a typed VibORM error", async () => {
    const driver = new FakeDriver();
    driver.failWith = new Error("raw boom");
    const error = await driver
      ._executeRaw(QUERY, [1], { model: "user", operation: "findMany" })
      .then(
        () => undefined,
        (e) => e
      );

    expect(error).toBeInstanceOf(Error);
    // normalizeDriverError wraps a plain error into a VibORM error.
    expect(isVibORMError(error)).toBe(true);
    expect((error as Error).message).not.toBe("");
  });

  // -------------------------------------------------------------------------
  // Logging wiring.
  // -------------------------------------------------------------------------

  it("logs a query event on success with model, operation, duration, sql, params", async () => {
    const capture = captureLogs();
    const ctx = createInstrumentationContext({
      logging: {
        query: capture.callback,
        includeSql: true,
        includeParams: true,
      },
    });
    const driver = new FakeDriver();
    driver.setInstrumentation(ctx);
    await driver._executeRaw<Row>(QUERY, [42], {
      model: "user",
      operation: "findMany",
    });

    expect(capture.events).toHaveLength(1);
    const event = capture.events[0]!;
    expect(event.level).toBe("query");
    expect(event.model).toBe("user");
    expect(event.operation).toBe("findMany");
    expect(typeof event.duration).toBe("number");
    expect(event.sql).toBe(QUERY);
    // includeParams:true → params survive sanitization end-to-end.
    expect(event.params).toEqual([42]);
  });

  it("strips params from the log event when includeParams is false (default)", async () => {
    const capture = captureLogs();
    const ctx = createInstrumentationContext({
      logging: { query: capture.callback },
      // no tracing config → params default to stripped
    });
    const driver = new FakeDriver();
    driver.setInstrumentation(ctx);
    await driver._executeRaw<Row>(QUERY, [42], {
      model: "user",
      operation: "findMany",
    });

    expect(capture.events[0]!.sql).toBeUndefined();
    expect(capture.events[0]!.params).toBeUndefined();
  });

  it("logs an error event (not query) on failure and propagates the thrown error", async () => {
    const capture = captureLogs();
    const ctx = createInstrumentationContext({
      logging: { query: capture.callback, error: capture.callback },
    });
    const driver = new FakeDriver();
    driver.setInstrumentation(ctx);
    driver.failWith = new Error("db exploded");

    const thrown = await driver
      ._executeRaw(QUERY, [1], { model: "user", operation: "findMany" })
      .then(
        () => undefined,
        (e) => e
      );

    // The error propagates to the caller, normalized to a VibORM error.
    expect(thrown).toBeInstanceOf(Error);
    expect(isVibORMError(thrown)).toBe(true);

    // Exactly one event, at error level — never a query-level event on failure.
    expect(capture.events).toHaveLength(1);
    const event = capture.events[0]!;
    expect(event.level).toBe("error");
    expect(event.model).toBe("user");
    expect(event.operation).toBe("findMany");
    expect(event.error).toBeInstanceOf(Error);
  });

  it("snapshots opted-in parameter diagnostics before caller and provider mutation", async () => {
    const capture = captureLogs();
    const driver = new FakeDriver();
    driver.setInstrumentation(
      createInstrumentationContext({
        diagnostics: { includeParams: true },
        logging: { error: capture.callback, includeParams: true },
      })
    );
    driver.failWith = new Error("private provider failure");
    driver.mutateParams = (params) => {
      params[0] = { value: "provider-mutated" };
    };

    const parameter = { value: "original" };
    const input: unknown[] = [parameter];
    const execution = driver
      ._executeRaw(QUERY, input, {
        model: "user",
        operation: "findMany",
        correlationId: "parameter-snapshot-correlation",
      })
      .catch((error) => error);

    input[0] = { value: "caller-array-mutated" };
    parameter.value = "caller-object-mutated";
    const error = await execution;

    if (!isVibORMError(error)) throw new Error("expected a VibORMError");
    expect(error.meta.params).toEqual([{ value: "original" }]);
    expect(capture.events).toHaveLength(1);
    expect(capture.events[0]?.params).toEqual([{ value: "original" }]);
    expect(JSON.stringify({ error, events: capture.events })).not.toContain(
      "mutated"
    );
  });

  // -------------------------------------------------------------------------
  // Tracing wiring.
  // -------------------------------------------------------------------------

  it("records a viborm.execute span with db context attributes and query text", async () => {
    recorder = withOtelRecorder();
    const ctx = createInstrumentationContext({
      tracing: { includeSql: true },
    });
    const driver = new FakeDriver();
    driver.setInstrumentation(ctx);
    await driver._executeRaw<Row>(QUERY, [1], {
      model: "user",
      operation: "findMany",
    });

    const span = recorder.find(SPAN_EXECUTE);
    expect(span).toBeDefined();
    const attrs = span?.attributes ?? {};
    expect(attrs[ATTR_DB_SYSTEM]).toBe("sqlite");
    expect(attrs[ATTR_DB_COLLECTION]).toBe("user");
    expect(attrs[ATTR_DB_OPERATION_NAME]).toBe("findMany");
    expect(attrs[ATTR_DB_QUERY_TEXT]).toBe(QUERY);
  });

  it("sets span status ERROR and records the exception on a failing query", async () => {
    recorder = withOtelRecorder();
    const ctx = createInstrumentationContext({ tracing: true });
    const driver = new FakeDriver();
    driver.setInstrumentation(ctx);
    driver.failWith = new Error("db exploded");

    await driver
      ._executeRaw(QUERY, [1], { model: "user", operation: "findMany" })
      .catch(() => undefined);

    const span = recorder.find(SPAN_EXECUTE);
    expect(span).toBeDefined();
    // SpanStatusCode.ERROR === 2
    expect(span?.status.code).toBe(2);
    expect(span?.events.some((e) => e.name === "exception")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Explicit context lifecycle.
  // -------------------------------------------------------------------------

  it("scopes attributes to only the execution that receives explicit context", async () => {
    recorder = withOtelRecorder();
    const ctx = createInstrumentationContext({ tracing: true });
    const driver = new FakeDriver();
    driver.setInstrumentation(ctx);

    await driver._executeRaw<Row>(QUERY, [1], {
      model: "user",
      operation: "findMany",
    });
    await driver._executeRaw<Row>("SELECT id FROM post", []);

    const spans = recorder.spans().filter((s) => s.name === SPAN_EXECUTE);
    expect(spans).toHaveLength(2);
    // First span carried the context.
    expect(spans[0]!.attributes[ATTR_DB_COLLECTION]).toBe("user");
    expect(spans[0]!.attributes[ATTR_DB_OPERATION_NAME]).toBe("findMany");
    // The unrelated second execution carries neither model nor operation.
    expect(spans[1]!.attributes[ATTR_DB_COLLECTION]).toBeUndefined();
    expect(spans[1]!.attributes[ATTR_DB_OPERATION_NAME]).toBe("executeRaw");
    // But base attributes (system) are always present.
    expect(spans[1]!.attributes[ATTR_DB_SYSTEM]).toBe("sqlite");
  });

  it("normalizes provider transaction failures with private context", async () => {
    const driver = new FakeDriver();
    driver.transactionFailWith = Object.assign(
      new Error("private transaction provider detail"),
      { status: 503 }
    );

    const error = await driver
      ._transaction(() => Promise.resolve("unreachable"), undefined, {
        model: "user",
        operation: "$transaction(callback)",
        correlationId: "transaction-correlation",
      })
      .catch((caught) => caught);

    expect(error).toMatchObject({
      message: "Query execution failed",
      meta: {
        driver: "fake",
        model: "user",
        operation: "$transaction(callback)",
        correlationId: "transaction-correlation",
        providerStatus: 503,
      },
      originalCause: { message: "Underlying error details redacted" },
    });
  });

  it("preserves callback failures passed through a transaction provider", async () => {
    const driver = new FakeDriver();
    const callbackError = new Error("public callback failure");

    await expect(
      driver._transaction(() => Promise.reject(callbackError))
    ).rejects.toBe(callbackError);
  });

  it("normalizes connection initialization failures without provider details", async () => {
    const driver = new FakeDriver();
    driver.initFailWith = Object.assign(
      new Error("connection failed for postgres://user:private@host/db"),
      { code: "ECONNREFUSED", status: 503 }
    );

    const error = await driver
      ._executeRaw(QUERY, [], {
        model: "user",
        operation: "findMany",
        correlationId: "connection-correlation",
      })
      .catch((caught) => caught);

    expect(error).toMatchObject({
      name: "ConnectionError",
      message: "Database connection failed",
      meta: {
        driver: "fake",
        model: "user",
        operation: "findMany",
        correlationId: "connection-correlation",
        providerCode: "ECONNREFUSED",
        providerStatus: 503,
      },
      originalCause: { message: "Underlying error details redacted" },
    });
    expect(JSON.stringify(error)).not.toContain("postgres://");
  });

  it("normalizes disconnection failures and still clears driver state", async () => {
    const driver = new FakeDriver();
    await driver._executeRaw(QUERY);
    driver.closeFailWith = new Error("close failed with private endpoint");

    const error = await driver
      ._disconnect({
        model: "$connection",
        operation: "$disconnect",
        correlationId: "disconnect-correlation",
      })
      .catch((caught) => caught);

    expect(error).toMatchObject({
      name: "ConnectionError",
      message: "Database disconnection failed",
      meta: {
        driver: "fake",
        model: "$connection",
        operation: "$disconnect",
        correlationId: "disconnect-correlation",
      },
      originalCause: { message: "Underlying error details redacted" },
    });
    expect(JSON.stringify(error)).not.toContain("private endpoint");
    driver.closeFailWith = undefined;
    await expect(driver._executeRaw(QUERY)).resolves.toMatchObject({
      rowCount: 1,
    });
  });

  it("rejects work started during disconnect with typed operation context", async () => {
    const driver = new FakeDriver();
    await driver._executeRaw(QUERY);

    let releaseClose: () => void = () => undefined;
    driver.closeBarrier = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const closeStarted = new Promise<void>((resolve) => {
      driver.closeStarted = resolve;
    });
    const disconnect = driver._disconnect({
      model: "$connection",
      operation: "$disconnect",
      correlationId: "disconnect-overlap-correlation",
    });
    await closeStarted;
    const overlappingDisconnect = driver
      ._disconnect({
        model: "$connection",
        operation: "$disconnect",
        correlationId: "second-disconnect-correlation",
      })
      .catch((caught) => caught);

    let error: unknown;
    try {
      error = await driver
        ._executeRaw(QUERY, [], {
          model: "user",
          operation: "findMany",
          correlationId: "query-during-disconnect-correlation",
        })
        .catch((caught) => caught);
    } finally {
      releaseClose();
      await disconnect;
    }

    const overlapError = await overlappingDisconnect;

    if (!isVibORMError(error)) throw new Error("expected a VibORMError");
    expect(error).toMatchObject({
      name: "ConnectionError",
      code: "V1003",
      message: "Database connection is closing",
      meta: {
        driver: "fake",
        model: "user",
        operation: "findMany",
        correlationId: "query-during-disconnect-correlation",
      },
    });
    if (!isVibORMError(overlapError)) {
      throw new Error("expected an overlapping disconnect VibORMError");
    }
    expect(overlapError).toMatchObject({
      name: "ConnectionError",
      code: "V1003",
      meta: {
        model: "$connection",
        operation: "$disconnect",
        correlationId: "second-disconnect-correlation",
      },
    });
    expect(driver.closeCount).toBe(1);
  });

  it("rejects tracer-reentrant disconnect with the reentrant context", async () => {
    const driver = new FakeDriver();
    await driver._executeRaw(QUERY);
    let reentrantDisconnect: Promise<unknown> | undefined;
    driver.setInstrumentation({
      ...createInstrumentationContext({ tracing: true }),
      tracer: {
        async startActiveSpan(options, fn) {
          if (options.name === SPAN_DISCONNECT) {
            reentrantDisconnect = driver
              ._disconnect({
                model: "$connection",
                operation: "$disconnect",
                correlationId: "reentrant-disconnect-correlation",
              })
              .catch((caught) => caught);
          }
          return fn();
        },
        startActiveSpanSync(_options, fn) {
          return fn();
        },
        isEnabled: () => true,
      },
    });

    await driver._disconnect({
      model: "$connection",
      operation: "$disconnect",
      correlationId: "originating-disconnect-correlation",
    });

    if (!reentrantDisconnect) {
      throw new Error("expected a reentrant disconnect attempt");
    }
    const error = await reentrantDisconnect;
    if (!isVibORMError(error)) throw new Error("expected a VibORMError");
    expect(error).toMatchObject({
      name: "ConnectionError",
      code: "V1003",
      meta: {
        driver: "fake",
        model: "$connection",
        operation: "$disconnect",
        correlationId: "reentrant-disconnect-correlation",
      },
    });
    expect(driver.closeCount).toBe(1);
  });
});
