import type { CacheExecutionOptions } from "@cache";
import { MemoryCache } from "@cache/drivers/memory";
import {
  createInstrumentationContext,
} from "@instrumentation/context";
import {
  ATTR_CACHE_KEY,
  ATTR_VIBORM_CORRELATION_ID,
} from "@instrumentation/spans";
import type { LogEvent } from "@instrumentation/types";
import { describe, expect, it } from "vitest";

const options = {
  ttlMs: 10_000,
  swr: false,
  bypass: false,
} satisfies CacheExecutionOptions;

describe("cache instrumentation isolation", () => {
  it("preserves cached execution when a log callback fails", async () => {
    const cache = new MemoryCache();
    let executionCount = 0;
    cache.setInstrumentation(
      createInstrumentationContext({
        logging: {
          cache() {
            throw new Error("logger failed");
          },
        },
      })
    );

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
