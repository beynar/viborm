/**
 * Logger unit tests — createLogger dispatch/level thresholds, sanitization,
 * the pretty formatter branches, and the createXLogEvent factory shapes.
 *
 * Real behavior only: we drive the genuine createLogger emit/sanitize path via
 * captureLogs(), and assert prettyLog console output via spied console methods.
 */

import { disclosed } from "@src/extensions/disclosed";
import { createLogger } from "@src/instrumentation/logger";
import type { LogEvent } from "@src/instrumentation/types";
import { captureLogs } from "@tests/unit/instrumentation/_capture";
import { afterEach, describe, expect, it, vi } from "vitest";

const ts = new Date("2026-07-07T00:00:00.000Z");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createLogger — dispatch & level isolation", () => {
  it("hands an event on as it was made, and freezes the logger facade", () => {
    const original = captureLogs();
    const logger = createLogger({ query: original.callback });

    logger.log({
      level: "query",
      timestamp: ts,
      sql: "SELECT private_sql",
      params: ["private-param"],
    });

    expect(Object.isFrozen(logger)).toBe(true);
    expect(original.events).toHaveLength(1);
    expect(original.events[0]).toMatchObject({
      sql: "SELECT private_sql",
      params: ["private-param"],
    });
  });

  it("routes a query event to the query handler; other levels do not reach it", () => {
    const q = captureLogs();
    const logger = createLogger({ query: q.callback });

    logger.log({
      level: "query",
      timestamp: ts,
      model: "user",
      operation: "findMany",
    });
    logger.log({ level: "cache", timestamp: ts });
    logger.log({ level: "error", timestamp: ts });

    expect(q.events).toHaveLength(1);
    expect(q.events[0]?.level).toBe("query");
    expect(q.events[0]?.model).toBe("user");
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

    logger.log({ level: "cache", timestamp: ts });

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

    logger.log({ level: "query", timestamp: ts });

    expect(specific.events).toHaveLength(1);
    expect(fallback.events).toHaveLength(0);
  });

  it("drops a level with neither specific nor `all` handler (no throw, no output)", () => {
    const logger = createLogger({ query: captureLogs().callback });
    const consoleLog = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    expect(() => logger.log({ level: "error", timestamp: ts })).not.toThrow();
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
    expect(empty.isLevelEnabled("error")).toBe(false);
  });
});

describe("createLogger — handler === true invokes prettyLog", () => {
  it("query true → console.log", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createLogger({ query: true });

    logger.log({
      level: "query",
      timestamp: ts,
      model: "user",
      operation: "findMany",
    });

    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0]?.join(" ")).toContain("user");
  });

  it("error true → console.error", () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const logger = createLogger({ error: true });

    logger.log({ level: "error", timestamp: ts, error: new Error("boom") });

    expect(error).toHaveBeenCalled();
  });
});

describe("createLogger — callback receives (sanitizedEvent, defaultLog)", () => {
  it("calling defaultLog() invokes the real pretty logger", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    // invokeDefault=true → callback also calls log()
    const cap = captureLogs(true);
    const logger = createLogger({ query: cap.callback });

    logger.log({
      level: "query",
      timestamp: ts,
      model: "user",
      operation: "findMany",
    });

    expect(cap.events).toHaveLength(1);
    expect(spy).toHaveBeenCalled();
  });
});

describe("createLogger — the event it hands on", () => {
  // The presentation decides what an event shows (`disclosed`, the
  // `parameters` snapshot, the channel's flags); the logger hands it on.
  it("hands on the params it is given", () => {
    const cap = captureLogs();
    const logger = createLogger({ query: cap.callback, includeParams: true });

    logger.log({ level: "query", timestamp: ts, params: [1, 2, 3] });

    expect(cap.events[0]?.params).toEqual([1, 2, 3]);
  });

  it("isolates throwing callbacks and pretty-console failures", () => {
    const callbackLogger = createLogger({
      query: () => {
        throw new Error("callback failed");
      },
    });
    expect(() =>
      callbackLogger.log({ level: "query", timestamp: ts })
    ).not.toThrow();

    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("console failed");
    });
    const prettyLogger = createLogger({ query: true });
    expect(() =>
      prettyLogger.log({ level: "query", timestamp: ts })
    ).not.toThrow();

    let deferredDefaultLog: (() => void) | undefined;
    const callbackLoggerWithDeferredConsole = createLogger({
      query: (_event, defaultLog) => {
        deferredDefaultLog = defaultLog;
      },
    });
    callbackLoggerWithDeferredConsole.log({ level: "query", timestamp: ts });
    expect(() => deferredDefaultLog?.()).not.toThrow();
  });

  it("observes and contains async callback rejections", async () => {
    const logger = createLogger({
      query: async () => {
        throw new Error("async callback failed");
      },
    });

    expect(() => logger.log({ level: "query", timestamp: ts })).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("drops undeclared aliases from emitted events", () => {
    const cap = captureLogs();
    const logger = createLogger({ query: cap.callback });
    const aliasedSecrets = {
      level: "query" as const,
      timestamp: ts,
      statement: "SELECT private",
      bindings: ["private-value"],
    };

    logger.log(aliasedSecrets);

    expect(cap.events).toHaveLength(1);
    expect(cap.events[0]).not.toHaveProperty("statement");
    expect(cap.events[0]).not.toHaveProperty("bindings");
  });
});

// ---------------------------------------------------------------------------
// prettyLog branches — asserted via spied console methods with `true` handlers
// ---------------------------------------------------------------------------

describe("prettyLog — query branch", () => {
  it("with model → model.operation and sql/params lines", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createLogger({
      query: true,
      includeSql: true,
      includeParams: true,
    });

    logger.log({
      level: "query",
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

    logger.log({ level: "query", timestamp: ts, operation: "count" });
    logger.log({ level: "query", timestamp: ts });

    const first = spy.mock.calls[0]?.join(" ") ?? "";
    const second = spy.mock.calls[1]?.join(" ") ?? "";
    expect(first).toContain("count");
    expect(second).toContain("query");
  });

  it("no sql line when sql absent; no params line when params empty", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createLogger({ query: true, includeParams: true });

    // sql absent, params empty array → only the header line
    logger.log({
      level: "query",
      timestamp: ts,
      model: "user",
      operation: "findMany",
      params: [],
    });

    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("prettyLog — cache branch", () => {
  it("reads event/status and omits the cache key", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createLogger({ cache: true });

    logger.log({
      level: "cache",
      timestamp: ts,
      meta: { event: "hit", status: "fresh", key: "user:1" },
    });

    const out = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain("hit");
    expect(out).toContain("(fresh)");
    expect(out).not.toContain("cache-key:");
    expect(out).not.toContain("user:1");
  });

  it("defaults cacheEvent to 'unknown' when meta absent", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createLogger({ cache: true });

    logger.log({ level: "cache", timestamp: ts });

    expect(spy.mock.calls[0]?.join(" ")).toContain("unknown");
  });
});

describe("prettyLog — error branch", () => {
  it("uses console.error; prints the presented error and SQL", () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const logger = createLogger({ error: true, includeSql: true });

    logger.log({
      level: "error",
      timestamp: ts,
      model: "user",
      operation: "create",
      error: disclosed(new Error("constraint violation")),
      sql: "INSERT INTO user",
    });

    const out = error.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain("Error details redacted");
    expect(out).not.toContain("constraint violation");
    expect(out).toContain("INSERT INTO user");
  });

  it("no error.message line when error absent", () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const logger = createLogger({ error: true });

    logger.log({
      level: "error",
      timestamp: ts,
      model: "user",
      operation: "create",
    });

    // Only the header line; no message/sql follow-ups.
    expect(error).toHaveBeenCalledTimes(1);
  });
});

it("adds no ANSI codes and preserves fractional durations in captured logs", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const logger = createLogger({ all: true });
  logger.log({
    level: "query",
    timestamp: ts,
    model: "user",
    operation: "findMany",
    duration: 0.125,
  });
  logger.log({ level: "cache", timestamp: ts, meta: { event: "hit" } });
  logger.log({ level: "error", timestamp: ts });
  const output = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]
    .flat()
    .join(" ");
  expect(output).not.toContain("\x1b[");
  expect(output).toContain("0.125ms");
});

describe("formatDuration — via query pretty output", () => {
  it("undefined duration yields no duration segment", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createLogger({ query: true });

    logger.log({
      level: "query",
      timestamp: ts,
      model: "user",
      operation: "findMany",
    });

    expect(spy.mock.calls[0]?.join(" ")).not.toContain("ms");
  });

  it("renders the original millisecond value", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createLogger({ query: true });

    logger.log({
      level: "query",
      timestamp: ts,
      operation: "findFirst",
      duration: 5,
    }); // green <10
    logger.log({
      level: "query",
      timestamp: ts,
      operation: "findMany",
      duration: 50,
    }); // yellow <100
    logger.log({
      level: "query",
      timestamp: ts,
      operation: "count",
      duration: 500,
    }); // red >=100

    const rows = spy.mock.calls.map((c) => c.join(" "));
    expect(rows[0]).toContain("5ms");
    expect(rows[1]).toContain("50ms");
    expect(rows[2]).toContain("500ms");
  });
});
