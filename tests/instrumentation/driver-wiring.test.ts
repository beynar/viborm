/**
 * Integration: src/drivers/driver.ts instrumentation wiring.
 *
 * Drives real query execution through a minimal in-memory Driver subclass and
 * asserts the logs + spans that flow out via the actual `withInstrumentation`
 * path (fast-path skip, logger dispatch, tracer dispatch, error handling).
 *
 * Uses the shared `_capture.ts` helpers — no bespoke capture code.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { Driver } from "@drivers/driver";
import type { QueryResult } from "@drivers/types";
import { isVibORMError } from "@errors";
import { createInstrumentationContext } from "@instrumentation/context";
import {
  ATTR_DB_COLLECTION,
  ATTR_DB_OPERATION_NAME,
  ATTR_DB_QUERY_TEXT,
  ATTR_DB_SYSTEM,
  SPAN_EXECUTE,
} from "@instrumentation/spans";
import { trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import { captureLogs, withOtelRecorder } from "./_capture";

// ---------------------------------------------------------------------------
// Minimal real Driver subclass. Executes against an in-memory row set so the
// full base-class `_executeRaw` → `withInstrumentation` path runs for real.
// A per-instance `failWith` lets a test make the underlying execute throw.
// ---------------------------------------------------------------------------

interface Row {
  id: number;
}

class FakeDriver extends Driver<{ tag: "client" }, { tag: "tx" }> {
  readonly adapter = {} as DatabaseAdapter;
  failWith: Error | undefined;
  lastSql: string | undefined;
  lastParams: unknown[] | undefined;

  constructor() {
    super("sqlite", "fake");
  }

  protected initClient(): Promise<{ tag: "client" }> {
    return Promise.resolve({ tag: "client" });
  }

  protected closeClient(): Promise<void> {
    return Promise.resolve();
  }

  protected execute<T>(
    _client: unknown,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    return this.run<T>(sql, params);
  }

  protected executeRaw<T>(
    _client: unknown,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    return this.run<T>(sql, params ?? []);
  }

  protected transaction<T>(
    _client: unknown,
    fn: (tx: { tag: "tx" }) => Promise<T>
  ): Promise<T> {
    return fn({ tag: "tx" });
  }

  private run<T>(sql: string, params: unknown[]): Promise<QueryResult<T>> {
    this.lastSql = sql;
    this.lastParams = params;
    if (this.failWith) {
      return Promise.reject(this.failWith);
    }
    const rows = [{ id: 1 }] as unknown as T[];
    return Promise.resolve({ rows, rowCount: rows.length });
  }
}

const QUERY = "SELECT id FROM user WHERE id = ?";

describe("driver instrumentation wiring", () => {
  let recorder: ReturnType<typeof withOtelRecorder> | undefined;

  afterEach(async () => {
    if (recorder) {
      await recorder.dispose();
      recorder = undefined;
    }
    // The shared recorder's dispose() shuts the provider down but leaves it
    // registered as the OTel global; a later register() would silently no-op.
    // Reset the global so each span test starts from a clean slate.
    trace.disable();
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
    driver.setContext({ model: "user", operation: "findMany" });

    const error = await driver._executeRaw(QUERY, [1]).then(
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
      logging: { query: capture.callback, includeParams: true },
    });
    const driver = new FakeDriver();
    driver.setInstrumentation(ctx);
    driver.setContext({ model: "user", operation: "findMany" });

    await driver._executeRaw<Row>(QUERY, [42]);

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
    driver.setContext({ model: "user", operation: "findMany" });

    await driver._executeRaw<Row>(QUERY, [42]);

    expect(capture.events[0]!.sql).toBe(QUERY);
    expect(capture.events[0]!.params).toBeUndefined();
  });

  it("logs an error event (not query) on failure and propagates the thrown error", async () => {
    const capture = captureLogs();
    const ctx = createInstrumentationContext({
      logging: { query: capture.callback, error: capture.callback },
    });
    const driver = new FakeDriver();
    driver.setInstrumentation(ctx);
    driver.setContext({ model: "user", operation: "findMany" });
    driver.failWith = new Error("db exploded");

    const thrown = await driver._executeRaw(QUERY, [1]).then(
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

  // -------------------------------------------------------------------------
  // Tracing wiring.
  // -------------------------------------------------------------------------

  it("records a viborm.execute span with db context attributes and query text", async () => {
    recorder = withOtelRecorder();
    const ctx = createInstrumentationContext({ tracing: true });
    const driver = new FakeDriver();
    driver.setInstrumentation(ctx);
    driver.setContext({ model: "user", operation: "findMany" });

    await driver._executeRaw<Row>(QUERY, [1]);

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
    driver.setContext({ model: "user", operation: "findMany" });
    driver.failWith = new Error("db exploded");

    await driver._executeRaw(QUERY, [1]).catch(() => undefined);

    const span = recorder.find(SPAN_EXECUTE);
    expect(span).toBeDefined();
    // SpanStatusCode.ERROR === 2
    expect(span?.status.code).toBe(2);
    expect(span?.events.some((e) => e.name === "exception")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // setContext / clearContext lifecycle.
  // -------------------------------------------------------------------------

  it("setContext supplies attributes; clearContext removes them from the next span", async () => {
    recorder = withOtelRecorder();
    const ctx = createInstrumentationContext({ tracing: true });
    const driver = new FakeDriver();
    driver.setInstrumentation(ctx);

    driver.setContext({ model: "user", operation: "findMany" });
    await driver._executeRaw<Row>(QUERY, [1]);

    driver.clearContext();
    await driver._executeRaw<Row>("SELECT id FROM post", []);

    const spans = recorder.spans().filter((s) => s.name === SPAN_EXECUTE);
    expect(spans).toHaveLength(2);
    // First span carried the context.
    expect(spans[0]!.attributes[ATTR_DB_COLLECTION]).toBe("user");
    expect(spans[0]!.attributes[ATTR_DB_OPERATION_NAME]).toBe("findMany");
    // Second span, after clearContext, carries neither model nor operation.
    expect(spans[1]!.attributes[ATTR_DB_COLLECTION]).toBeUndefined();
    expect(spans[1]!.attributes[ATTR_DB_OPERATION_NAME]).toBeUndefined();
    // But base attributes (system) are always present.
    expect(spans[1]!.attributes[ATTR_DB_SYSTEM]).toBe("sqlite");
  });
});
