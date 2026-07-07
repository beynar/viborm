/**
 * Logger unit tests — createLogger dispatch/level thresholds, sanitization,
 * the pretty formatter branches, and the createXLogEvent factory shapes.
 *
 * Real behavior only: we drive the genuine createLogger emit/sanitize path via
 * captureLogs(), and assert prettyLog console output via spied console methods.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CacheEventType,
  createCacheLogEvent,
  createErrorLogEvent,
  createLogger,
  createQueryLogEvent,
} from "../../src/instrumentation/logger";
import type { LogEvent } from "../../src/instrumentation/types";
import { captureLogs } from "./_capture";

const ts = new Date("2026-07-07T00:00:00.000Z");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createLogger — dispatch & level isolation", () => {
  it("routes logger.query to the query handler; other levels do not reach it", () => {
    const q = captureLogs();
    const logger = createLogger({ query: q.callback });

    logger.query({ timestamp: ts, model: "user", operation: "findMany" });
    logger.cache({ timestamp: ts });
    logger.warn({ timestamp: ts });
    logger.error({ timestamp: ts });

    expect(q.events).toHaveLength(1);
    expect(q.events[0]?.level).toBe("query");
    expect(q.events[0]?.model).toBe("user");
  });

  it("stamps the correct level per method (warn → 'warning')", () => {
    const all = captureLogs();
    const logger = createLogger({ all: all.callback });

    logger.query({ timestamp: ts });
    logger.cache({ timestamp: ts });
    logger.warn({ timestamp: ts });
    logger.error({ timestamp: ts });

    expect(all.events.map((e) => e.level)).toEqual([
      "query",
      "cache",
      "warning",
      "error",
    ]);
  });

  it("logger.log emits with the event's already-set level (no re-stamping)", () => {
    const all = captureLogs();
    const logger = createLogger({ all: all.callback });

    const event: LogEvent = { timestamp: ts, level: "error", model: "post" };
    logger.log(event);

    expect(all.events).toHaveLength(1);
    expect(all.events[0]?.level).toBe("error");
    expect(all.events[0]?.model).toBe("post");
  });

  it("`all` catch-all fires for a level with no specific handler", () => {
    const all = captureLogs();
    const logger = createLogger({ all: all.callback });

    logger.cache({ timestamp: ts });

    expect(all.events).toHaveLength(1);
    expect(all.events[0]?.level).toBe("cache");
  });

  it("a specific level handler takes precedence over `all`", () => {
    const specific = captureLogs();
    const fallback = captureLogs();
    const logger = createLogger({
      query: specific.callback,
      all: fallback.callback,
    });

    logger.query({ timestamp: ts });

    expect(specific.events).toHaveLength(1);
    expect(fallback.events).toHaveLength(0);
  });

  it("drops a level with neither specific nor `all` handler (no throw, no output)", () => {
    const logger = createLogger({ query: captureLogs().callback });
    const consoleLog = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    expect(() => logger.error({ timestamp: ts })).not.toThrow();
    expect(consoleLog).not.toHaveBeenCalled();
  });
});

describe("createLogger — isLevelEnabled", () => {
  it("true with a specific handler, true with only `all`, false with neither", () => {
    const withQuery = createLogger({ query: true });
    expect(withQuery.isLevelEnabled("query")).toBe(true);
    expect(withQuery.isLevelEnabled("cache")).toBe(false);

    const withAll = createLogger({ all: true });
    expect(withAll.isLevelEnabled("cache")).toBe(true);
    expect(withAll.isLevelEnabled("error")).toBe(true);

    const empty = createLogger({});
    expect(empty.isLevelEnabled("query")).toBe(false);
    expect(empty.isLevelEnabled("warning")).toBe(false);
  });
});

describe("createLogger — handler === true invokes prettyLog", () => {
  it("query true → console.log", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createLogger({ query: true });

    logger.query({ timestamp: ts, model: "user", operation: "findMany" });

    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0]?.join(" ")).toContain("user");
  });

  it("warn true → console.warn; error true → console.error", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const logger = createLogger({ warning: true, error: true });

    logger.warn({ timestamp: ts });
    logger.error({ timestamp: ts, error: new Error("boom") });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
  });
});

describe("createLogger — callback receives (sanitizedEvent, defaultLog)", () => {
  it("calling defaultLog() invokes the real pretty logger", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    // invokeDefault=true → callback also calls log()
    const cap = captureLogs(true);
    const logger = createLogger({ query: cap.callback });

    logger.query({ timestamp: ts, model: "user", operation: "findMany" });

    expect(cap.events).toHaveLength(1);
    expect(spy).toHaveBeenCalled();
  });
});

describe("sanitizeEvent — sql/params gating", () => {
  it("includeSql default true: sql passes through", () => {
    const cap = captureLogs();
    const logger = createLogger({ query: cap.callback });

    logger.query({ timestamp: ts, sql: "SELECT 1" });

    expect(cap.events[0]?.sql).toBe("SELECT 1");
  });

  it("includeSql:false: emitted sql is undefined even when source carried it", () => {
    const cap = captureLogs();
    const logger = createLogger({ query: cap.callback, includeSql: false });

    logger.query({ timestamp: ts, sql: "SELECT 1" });

    expect(cap.events[0]?.sql).toBeUndefined();
  });

  it("includeParams default false: params undefined even when source carried them", () => {
    const cap = captureLogs();
    const logger = createLogger({ query: cap.callback });

    logger.query({ timestamp: ts, params: [1, 2, 3] });

    expect(cap.events[0]?.params).toBeUndefined();
  });

  it("includeParams:true: params pass through", () => {
    const cap = captureLogs();
    const logger = createLogger({ query: cap.callback, includeParams: true });

    logger.query({ timestamp: ts, params: [1, 2, 3] });

    expect(cap.events[0]?.params).toEqual([1, 2, 3]);
  });

  it("preserves all other fields while nulling sql/params per config", () => {
    const cap = captureLogs();
    const logger = createLogger({
      query: cap.callback,
      includeSql: false,
      includeParams: false,
    });

    const meta = { region: "eu" };
    logger.query({
      timestamp: ts,
      model: "user",
      operation: "findMany",
      duration: 42,
      meta,
      sql: "SELECT 1",
      params: [1],
    });

    const e = cap.events[0];
    expect(e?.model).toBe("user");
    expect(e?.operation).toBe("findMany");
    expect(e?.duration).toBe(42);
    expect(e?.meta).toEqual(meta);
    expect(e?.timestamp).toBe(ts);
    expect(e?.sql).toBeUndefined();
    expect(e?.params).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// prettyLog branches — asserted via spied console methods with `true` handlers
// ---------------------------------------------------------------------------

describe("prettyLog — query branch", () => {
  it("with model → colored model.operation and sql/params lines", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createLogger({
      query: true,
      includeSql: true,
      includeParams: true,
    });

    logger.query({
      timestamp: ts,
      model: "user",
      operation: "findMany",
      sql: "SELECT * FROM user",
      params: [1, 2],
    });

    const out = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain("user");
    expect(out).toContain("findMany");
    expect(out).toContain("SELECT * FROM user");
    expect(out).toContain("params: [1,2]");
  });

  it("without model → falls back to operation, then to literal 'query'", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createLogger({ query: true });

    logger.query({ timestamp: ts, operation: "count" });
    logger.query({ timestamp: ts });

    const first = spy.mock.calls[0]?.join(" ") ?? "";
    const second = spy.mock.calls[1]?.join(" ") ?? "";
    expect(first).toContain("count");
    expect(second).toContain("query");
  });

  it("no sql line when sql absent; no params line when params empty", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createLogger({ query: true, includeParams: true });

    // sql absent, params empty array → only the header line
    logger.query({
      timestamp: ts,
      model: "user",
      operation: "findMany",
      params: [],
    });

    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("prettyLog — cache branch", () => {
  it("reads meta.event/status/key; uses console.log", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createLogger({ cache: true });

    logger.cache({
      timestamp: ts,
      meta: { event: "hit", status: "fresh", key: "user:1" },
    });

    const out = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain("hit");
    expect(out).toContain("(fresh)");
    expect(out).toContain("user:1");
  });

  it("defaults cacheEvent to 'unknown' when meta absent", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createLogger({ cache: true });

    logger.cache({ timestamp: ts });

    expect(spy.mock.calls[0]?.join(" ")).toContain("unknown");
  });
});

describe("prettyLog — warning branch", () => {
  it("uses console.warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createLogger({ warning: true });

    logger.warn({
      timestamp: ts,
      model: "user",
      meta: { reason: "disk slow" },
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
    expect(warn.mock.calls[0]?.join(" ")).toContain("user");
  });
});

describe("prettyLog — error branch", () => {
  it("uses console.error; logs error.message and sql lines", () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const logger = createLogger({ error: true, includeSql: true });

    logger.error({
      timestamp: ts,
      model: "user",
      operation: "create",
      error: new Error("constraint violation"),
      sql: "INSERT INTO user",
    });

    const out = error.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain("constraint violation");
    expect(out).toContain("INSERT INTO user");
  });

  it("no error.message line when error absent", () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const logger = createLogger({ error: true });

    logger.error({ timestamp: ts, model: "user", operation: "create" });

    // Only the header line; no message/sql follow-ups.
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("getHandler — unknown level is dropped", () => {
  // NOTE: this does NOT reach prettyLog's default branch. With `all: true`,
  // getHandler('trace') hits its own default case and returns undefined, so
  // emit() short-circuits at `if (!handler) return;` before prettyLog runs.
  // prettyLog's own default branch is unreachable via the public createLogger
  // surface (getHandler only ever returns handlers for the four known levels),
  // so no public-API test can genuinely close it — it is inert dead code.
  it("an unrecognized level produces no output and does not throw", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const logger = createLogger({ all: true });

    expect(() =>
      logger.log({ timestamp: ts, level: "trace" as never })
    ).not.toThrow();

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("formatDuration — via query pretty output", () => {
  it("undefined duration yields no duration segment", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createLogger({ query: true });

    logger.query({ timestamp: ts, model: "user", operation: "findMany" });

    expect(spy.mock.calls[0]?.join(" ")).not.toContain("ms");
  });

  it("renders the ms value across green/yellow/red thresholds", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createLogger({ query: true });

    logger.query({ timestamp: ts, operation: "findFirst", duration: 5 }); // green <10
    logger.query({ timestamp: ts, operation: "findMany", duration: 50 }); // yellow <100
    logger.query({ timestamp: ts, operation: "count", duration: 500 }); // red >=100

    const rows = spy.mock.calls.map((c) => c.join(" "));
    expect(rows[0]).toContain("5ms");
    expect(rows[1]).toContain("50ms");
    expect(rows[2]).toContain("500ms");
  });
});

// ---------------------------------------------------------------------------
// Event factory shapes
// ---------------------------------------------------------------------------

describe("createQueryLogEvent", () => {
  it("maps sqlParams → params, sets fresh Date timestamp, no level key", () => {
    const before = Date.now();
    const e = createQueryLogEvent({
      model: "user",
      operation: "findMany",
      duration: 12,
      sql: "SELECT 1",
      sqlParams: [1, 2],
      meta: { region: "eu" },
    });

    expect(e).not.toHaveProperty("level");
    expect(e.model).toBe("user");
    expect(e.operation).toBe("findMany");
    expect(e.duration).toBe(12);
    expect(e.sql).toBe("SELECT 1");
    expect(e.params).toEqual([1, 2]);
    expect(e.meta).toEqual({ region: "eu" });
    expect(e.timestamp).toBeInstanceOf(Date);
    expect(e.timestamp.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe("createErrorLogEvent", () => {
  it("sets error/timestamp/model/operation/duration/meta, no level key", () => {
    const err = new Error("boom");
    const e = createErrorLogEvent({
      error: err,
      model: "user",
      operation: "create",
      duration: 3,
      meta: { attempt: 1 },
    });

    expect(e).not.toHaveProperty("level");
    expect(e.error).toBe(err);
    expect(e.model).toBe("user");
    expect(e.operation).toBe("create");
    expect(e.duration).toBe(3);
    expect(e.meta).toEqual({ attempt: 1 });
    expect(e.timestamp).toBeInstanceOf(Date);
  });
});

describe("createCacheLogEvent", () => {
  it("builds meta={event,key,status}, optional error, no top-level model/operation, no level key", () => {
    const err = new Error("stale read");
    const e = createCacheLogEvent({
      event: "revalidate",
      key: "user:1",
      status: "stale",
      error: err,
    });

    expect(e).not.toHaveProperty("level");
    expect(e).not.toHaveProperty("model");
    expect(e).not.toHaveProperty("operation");
    expect(e.error).toBe(err);
    expect(e.meta).toEqual({
      event: "revalidate",
      key: "user:1",
      status: "stale",
    });
    expect(e.timestamp).toBeInstanceOf(Date);
  });

  it("accepts all CacheEventType values", () => {
    const kinds: CacheEventType[] = ["hit", "miss", "revalidate"];
    for (const event of kinds) {
      const e = createCacheLogEvent({ event, key: "k" });
      expect((e.meta as { event: string }).event).toBe(event);
    }
  });
});
