import { MemoryCache } from "@cache/drivers/memory";
import {
  createInstrumentationContext,
  type InstrumentationContext,
} from "@instrumentation/context";
import {
  ATTR_CACHE_KEY,
  ATTR_VIBORM_CORRELATION_ID,
} from "@instrumentation/spans";
import type { LogEvent } from "@instrumentation/types";
import { describe, expect, it } from "vitest";

const options = {
  ttlMs: 10_000,
  swr: false as const,
  bypass: false,
};

function throwingLogger(): NonNullable<InstrumentationContext["logger"]> {
  const fail = async () => {
    throw new Error("logger failed");
  };
  return {
    log: fail,
    query: fail,
    cache: fail,
    warn: fail,
    error: fail,
    isLevelEnabled: () => true,
  };
}

describe("cache instrumentation isolation", () => {
  it("preserves cached execution when tracer and logger fail", async () => {
    const cache = new MemoryCache();
    let executionCount = 0;
    cache.setInstrumentation({
      config: { logging: true, tracing: true },
      logger: throwingLogger(),
      tracer: {
        async startActiveSpan() {
          throw new Error("tracer failed before callback");
        },
        startActiveSpanSync(_options, fn) {
          return fn();
        },
        isEnabled: () => true,
      },
    });

    const result = await cache._executeCached(
      "user",
      "findMany",
      {},
      () => {
        executionCount += 1;
        return Promise.resolve([{ id: "authoritative" }]);
      },
      options
    );

    expect(result).toEqual([{ id: "authoritative" }]);
    expect(executionCount).toBe(1);
  });

  it("does not expose cache results or executor errors to a custom tracer", async () => {
    const cache = new MemoryCache();
    const observedValues: unknown[] = [];
    const observedErrors: unknown[] = [];
    cache.setInstrumentation({
      config: { tracing: true },
      tracer: {
        async startActiveSpan(_options, fn) {
          try {
            const value = await fn();
            observedValues.push(value);
            return value;
          } catch (error) {
            observedErrors.push(error);
            throw error;
          }
        },
        startActiveSpanSync(_options, fn) {
          return fn();
        },
        isEnabled: () => true,
      },
    });

    const result = await cache._executeCached(
      "user",
      "findMany",
      {},
      () => Promise.resolve([{ password: "private-result" }]),
      { ...options, bypass: true, key: "success" }
    );
    expect(result).toEqual([{ password: "private-result" }]);
    expect(observedValues.every((value) => value === undefined)).toBe(true);

    const executorError = new Error("private executor failure");
    const caught = await cache
      ._executeCached(
        "user",
        "findMany",
        {},
        () => Promise.reject(executorError),
        { ...options, bypass: true, key: "failure" }
      )
      .catch((error) => error);

    expect(caught).toBe(executorError);
    expect(observedErrors).not.toHaveLength(0);
    expect(
      observedErrors.every((error) => JSON.stringify(error) === "{}")
    ).toBe(true);
    expect(observedErrors).toEqual(
      observedErrors.map(() =>
        expect.objectContaining({ message: "Operation failed" })
      )
    );
  });

  it("retains ORM attribution on cache spans and log events", async () => {
    const events: LogEvent[] = [];
    const spanCorrelations: unknown[] = [];
    const cache = new MemoryCache();
    const instrumentation = createInstrumentationContext({
      logging: {
        cache: (event) => {
          events.push(event);
        },
      },
    });
    cache.setInstrumentation({
      ...instrumentation,
      tracer: {
        async startActiveSpan(spanOptions, fn) {
          spanCorrelations.push(
            spanOptions.attributes?.[ATTR_VIBORM_CORRELATION_ID]
          );
          return fn();
        },
        startActiveSpanSync(_options, fn) {
          return fn();
        },
        isEnabled: () => true,
      },
    });

    await cache._executeCached(
      "user",
      "findMany",
      {},
      () => Promise.resolve([{ id: 1 }]),
      {
        ...options,
        key: "attributed",
        executionContext: {
          model: "user",
          operation: "findMany",
          correlationId: "cache-correlation",
        },
      }
    );

    expect(spanCorrelations).toContain("cache-correlation");
    expect(events).toContainEqual(
      expect.objectContaining({
        model: "user",
        operation: "findMany",
        correlationId: "cache-correlation",
      })
    );
  });

  it("returns storage outcomes when a tracer hangs after invoking its callback", async () => {
    const cache = new MemoryCache();
    cache.setInstrumentation({
      config: { tracing: true },
      tracer: {
        startActiveSpan(_options, fn) {
          Promise.resolve(fn()).catch(() => undefined);
          return new Promise<never>(() => undefined);
        },
        startActiveSpanSync(_options, fn) {
          return fn();
        },
        isEnabled: () => true,
      },
    });

    await cache._set("key", { id: 1 }, { ttl: 10_000 });
    await expect(cache._get<{ id: number }>("key")).resolves.toMatchObject({
      value: { id: 1 },
    });
  });

  it("starts storage when an injected tracer never invokes its callback", async () => {
    const cache = new MemoryCache();
    cache.setInstrumentation({
      config: { tracing: true },
      tracer: {
        startActiveSpan() {
          return new Promise<never>(() => undefined);
        },
        startActiveSpanSync(_options, fn) {
          return fn();
        },
        isEnabled: () => true,
      },
    });

    await cache._set("never-started-by-tracer", { id: 2 }, { ttl: 10_000 });
    await expect(
      cache._get<{ id: number }>("never-started-by-tracer")
    ).resolves.toMatchObject({ value: { id: 2 } });
  });

  it("omits deceptive custom keys from cache logs and spans", async () => {
    const cache = new MemoryCache();
    const events: LogEvent[] = [];
    const spanKeys: unknown[] = [];
    const instrumentation = createInstrumentationContext({
      logging: {
        cache: (event) => {
          events.push(event);
        },
      },
    });
    cache.setInstrumentation({
      ...instrumentation,
      tracer: {
        async startActiveSpan(spanOptions, fn) {
          spanKeys.push(spanOptions.attributes?.[ATTR_CACHE_KEY]);
          return fn();
        },
        startActiveSpanSync(_options, fn) {
          return fn();
        },
        isEnabled: () => true,
      },
    });

    await cache._executeCached(
      "user",
      "findMany",
      {},
      () => Promise.resolve([{ id: 1 }]),
      { ...options, key: "cache-key:secret-password" }
    );
    await Promise.resolve();

    const diagnostics = JSON.stringify({ events, spanKeys });
    expect(diagnostics).not.toContain("secret-password");
    expect(diagnostics).not.toContain("cache-key:");
    expect(spanKeys.every((key) => key === undefined)).toBe(true);
  });

  it("ignores synchronous waitUntil failures after successful execution", async () => {
    const cache = new MemoryCache();

    await expect(
      cache._executeCached(
        "user",
        "findMany",
        {},
        () => Promise.resolve([{ id: "authoritative" }]),
        {
          ...options,
          bypass: true,
          waitUntil() {
            throw new Error("scheduler failed");
          },
        }
      )
    ).resolves.toEqual([{ id: "authoritative" }]);
  });
});
