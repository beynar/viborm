import { CloudflareKVCache } from "@cache/drivers/cloudflare-kv";
import { MemoryCache } from "@cache/drivers/memory";
import {
  createOfficialCacheScope,
  CacheDriver,
  type CacheEntry,
  executeCachedWithResultCodec,
  invalidateOfficialCache,
} from "@cache/driver";
import {
  CacheDriver as ExportedCacheDriver,
  cache as exportedCache,
} from "@cache/exports";
import {
  bindOfficialCacheChain,
  cache,
  getOfficialCacheChainCapability,
  getOfficialCacheChainDefinition,
  getOfficialCacheQueryCapability,
  registerOfficialCacheChain,
} from "@cache/extension";
import {
  CACHE_PREFIX,
  generateCacheKey,
  generateCachePrefix,
  generateUnprefixedCacheKey,
} from "@cache/key";
import {
  completeOfficialCacheSetFailure,
  createCacheInstrumentationLogEvent,
  createCacheLifecycleInstrumentationFacts,
  createOfficialCacheExecutionLogReader,
  emitCacheLogEvent,
  getCacheOperationAttributes,
  hasOfficialCacheInstrumentation,
  hasOfficialCacheLogging,
} from "@cache/cache-instrumentation";
import { scheduleBackground } from "@cache/cache-background";
import { hasCacheInvalidationWork } from "@cache/schema";
import { parseTTL } from "@cache/ttl";
import type { KVNamespace } from "@cloudflare/workers-types";
import { createExecutionContext } from "@drivers/execution-context";
import {
  CacheConfigurationError,
  CacheInvalidKeyError,
  CacheInvalidTTLError,
} from "@errors";
import {
  appendResolvedExtension,
  type ResolvedExtensionChain,
} from "@extensions/chain";
import { instrumentation } from "@instrumentation/extension";
import { createInstrumentationContext } from "@instrumentation/context";
import { SPAN_CACHE_GET } from "@instrumentation/spans";
import { createTestClock } from "@tests/fixtures/test-clock";
import { describe, expect, test, vi } from "vitest";

class RecordingCache extends CacheDriver {
  readonly entries = new Map<string, CacheEntry>();
  readonly sets: Array<{
    readonly key: string;
    readonly storageTtl: number;
    readonly entry: CacheEntry;
  }> = [];
  readonly deletes: string[][] = [];
  readonly clears: string[] = [];
  failMarkerGet: unknown;
  failDataSet: unknown;
  failDelete: unknown;
  failGet: unknown;

  constructor(clock = createTestClock()) {
    super("recording", clock);
  }

  protected async get<T>(key: string): Promise<CacheEntry<T> | null> {
    if (key.endsWith(":reval") && this.failMarkerGet !== undefined) {
      const failure = this.failMarkerGet;
      this.failMarkerGet = undefined;
      throw failure;
    }
    if (!key.endsWith(":reval") && this.failGet !== undefined) {
      const failure = this.failGet;
      this.failGet = undefined;
      throw failure;
    }
    return (this.entries.get(key) as CacheEntry<T> | undefined) ?? null;
  }

  protected async set<T>(
    key: string,
    storageTtl: number,
    entry: CacheEntry<T>
  ): Promise<void> {
    if (!key.endsWith(":reval") && this.failDataSet !== undefined) {
      const failure = this.failDataSet;
      this.failDataSet = undefined;
      throw failure;
    }
    this.sets.push({ key, storageTtl, entry });
    this.entries.set(key, entry);
  }

  protected async delete(keys: string[]): Promise<void> {
    this.deletes.push(keys);
    if (this.failDelete !== undefined) {
      const failure = this.failDelete;
      this.failDelete = undefined;
      throw failure;
    }
    for (const key of keys) this.entries.delete(key);
  }

  protected async clear(prefix: string): Promise<void> {
    this.clears.push(prefix);
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }
}

function officialInstrumentationContext(options?: {
  readonly logging?: boolean;
  readonly queryLogging?: boolean;
  readonly tracing?: boolean;
  readonly correlationId?: string;
}) {
  const extension = instrumentation({
    ...(options?.logging === true
      ? { logging: { cache: () => undefined } }
      : options?.queryLogging === true
        ? { logging: { query: () => undefined } }
        : {}),
    ...(options?.tracing === true ? { tracing: true } : {}),
  });
  const chain = appendResolvedExtension(undefined, extension, {});
  return createExecutionContext(
    { model: "record", operation: "findMany" },
    undefined,
    options?.correlationId === undefined
      ? undefined
      : () => options.correlationId ?? "",
    chain
  );
}

describe("cache duration and key contracts", () => {
  test("parses every duration family and rejects each invalid class", () => {
    expect(parseTTL(25)).toBe(25);
    expect(parseTTL("2.5 hours")).toBe(9_000_000);
    expect(parseTTL("1 millisecond")).toBe(1);
    expect(parseTTL("2 seconds")).toBe(2_000);
    expect(parseTTL("3 min")).toBe(180_000);
    expect(parseTTL("4 hr")).toBe(14_400_000);
    expect(parseTTL("5 days")).toBe(432_000_000);
    expect(parseTTL("2 weeks")).toBe(1_209_600_000);
    expect(parseTTL("1 month")).toBe(2_592_000_000);

    expect(() => parseTTL(0)).toThrow(CacheInvalidTTLError);
    expect(() => parseTTL(-1)).toThrow(CacheInvalidTTLError);
    expect(() => parseTTL("tomorrow")).toThrow(CacheInvalidTTLError);
    expect(() => parseTTL("1 fortnight")).toThrow(CacheInvalidTTLError);
    expect(() => parseTTL("0.1ms")).toThrow(CacheInvalidTTLError);
  });

  test("keeps public prefixes and canonical argument identity deterministic", () => {
    expect(CACHE_PREFIX).toBe("viborm");
    expect(generateCachePrefix()).toBe("viborm");
    expect(generateCachePrefix("user")).toBe("viborm:user");
    expect(generateCachePrefix("user", 2)).toBe("viborm:v2:user");
    expect(generateCachePrefix(undefined, "blue")).toBe("viborm:vblue");

    expect(generateUnprefixedCacheKey("user", "findMany", { b: 2, a: 1 }))
      .toBe(generateUnprefixedCacheKey("user", "findMany", { a: 1, b: 2 }));
    expect(generateCacheKey("user", "findMany", null)).not.toBe(
      generateCacheKey("user", "findMany", undefined)
    );
    expect(generateCacheKey("user", "findMany", { present: 1 })).toBe(
      generateCacheKey("user", "findMany", {
        omitted: undefined,
        present: 1,
      })
    );
    expect(generateCacheKey("user", "findMany", true, "blue")).toContain(
      "viborm:vblue:user:findMany:"
    );
  });

  test("refuses values whose identity cannot be serialized", () => {
    expect(() => generateCacheKey("user", "findMany", Symbol("x"))).toThrow(
      CacheInvalidKeyError
    );
    expect(() => generateCacheKey("user", "findMany", () => 1)).toThrow(
      CacheInvalidKeyError
    );

    const circularArray: unknown[] = [];
    circularArray.push(circularArray);
    expect(() =>
      generateCacheKey("user", "findMany", circularArray)
    ).toThrow(CacheInvalidKeyError);

    const circularObject: Record<string, unknown> = {};
    circularObject.self = circularObject;
    expect(() =>
      generateCacheKey("user", "findMany", circularObject)
    ).toThrow(CacheInvalidKeyError);
  });
});

describe("public cache-driver storage contract", () => {
  test("prefixes, stores, reads, deletes, and clears without crossing namespaces", async () => {
    const clock = createTestClock();
    const driver = new RecordingCache(clock);

    await driver._set("entry", { value: 1 }, { ttl: 100, swrTtl: 250 });
    expect(driver.sets[0]).toMatchObject({
      key: "viborm:entry",
      storageTtl: 250,
      entry: { value: { value: 1 }, ttl: 100 },
    });
    await expect(driver._get("entry")).resolves.toMatchObject({
      value: { value: 1 },
      ttl: 100,
    });
    await expect(driver._get("missing")).resolves.toBeNull();

    clock.advance(101);
    await expect(driver._get("entry")).resolves.toMatchObject({
      value: { value: 1 },
    });

    expect(await driver._markRevalidating("entry")).toBe(true);
    expect(await driver._markRevalidating("entry")).toBe(false);
    await driver._clearRevalidating("entry");
    expect(await driver._markRevalidating("entry")).toBe(true);

    await driver._delete("entry");
    expect(driver.deletes.at(-1)).toEqual([
      "viborm:entry",
      "viborm:entry:reval",
    ]);

    await driver._set("tenant:a", 1, { ttl: 100 });
    await driver._set("other:a", 2, { ttl: 100 });
    await driver._clear("tenant:");
    expect(driver.clears.at(-1)).toBe("viborm:tenant:");
    expect(driver.entries.has("viborm:other:a")).toBe(true);
    await driver._clear();
    expect(driver.clears.at(-1)).toBe("viborm");
  });

  test("accepts legacy prefixed keys but reserves official scope and hidden arguments", async () => {
    const driver = new RecordingCache();
    await driver._set("viborm:v2:user:key", 1, { ttl: 10 });
    expect(driver.sets[0]?.key).toBe("viborm:v2:user:key");

    await expect(driver._get("viborm:cache")).rejects.toThrow(
      CacheInvalidKeyError
    );
    await expect(driver._get("viborm:cache:r3:forged")).rejects.toThrow(
      CacheInvalidKeyError
    );
    await expect(
      Reflect.apply(driver._get, driver, ["entry", undefined, {}])
    ).rejects.toThrow(CacheInvalidKeyError);
  });

  test("keeps ordinary cache observers on the public storage boundary", async () => {
    const units: unknown[] = [];
    const chain = appendResolvedExtension(
      undefined,
      {
        name: "ordinary-cache-observer",
        observe(unit, proceed) {
          units.push(unit);
          return proceed();
        },
      },
      {}
    );
    const context = createExecutionContext(
      { model: "record", operation: "findMany" },
      undefined,
      undefined,
      chain
    );
    const driver = new RecordingCache();

    await expect(driver._get("missing", context)).resolves.toBeNull();
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ kind: "cache", operation: "get" });
  });

  test("prepares invalidation before effects and preserves backend failures", async () => {
    const driver = new RecordingCache();
    expect(hasCacheInvalidationWork(undefined)).toBe(false);
    expect(hasCacheInvalidationWork({ autoInvalidate: false })).toBe(false);
    expect(hasCacheInvalidationWork({ invalidate: [] })).toBe(false);
    expect(hasCacheInvalidationWork({ autoInvalidate: true })).toBe(true);
    expect(hasCacheInvalidationWork({ invalidate: ["one"] })).toBe(true);

    await driver._invalidate("user");
    expect(driver.clears).toEqual([]);
    await driver._invalidate("user", {
      autoInvalidate: true,
      invalidate: ["exact", "prefix:*"],
    });
    expect(driver.clears).toEqual([
      "viborm:user:",
      "viborm:prefix:",
    ]);
    expect(driver.deletes).toContainEqual([
      "viborm:exact",
      "viborm:exact:reval",
    ]);

    driver.failDelete = new Error("delete refused");
    await expect(
      driver._invalidate("user", { invalidate: ["exact"] })
    ).rejects.toThrow("delete refused");
  });

  test("authenticates the internal official-result seam", async () => {
    const driver = new RecordingCache();
    const codec = {
      snapshot: (value: { id: string }) => ({ ...value }),
      materialize: () => ({ id: "cached" }),
    };
    const options = { ttlMs: 100, swr: false as const, bypass: false };

    expect(() =>
      executeCachedWithResultCodec(
        driver,
        "user",
        "findMany",
        {},
        async () => ({ id: "one" }),
        options,
        codec,
        Object.freeze({})
      )
    ).toThrow(CacheInvalidKeyError);

    const scope = createOfficialCacheScope("viborm:cache:test");
    await expect(
      executeCachedWithResultCodec(
        driver,
        "user",
        "findMany",
        {},
        async () => ({ id: "one" }),
        options,
        codec,
        scope
      )
    ).resolves.toEqual({ id: "one" });
  });

  test("authenticates and confines the internal official-invalidation seam", async () => {
    const driver = new RecordingCache();
    const forgedScope = Object.freeze({});
    expect(() =>
      invalidateOfficialCache(
        driver,
        "user",
        { autoInvalidate: true },
        undefined,
        forgedScope
      )
    ).toThrow(CacheInvalidKeyError);

    const scope = createOfficialCacheScope("viborm:cache:scope");
    await invalidateOfficialCache(
      driver,
      "user",
      { autoInvalidate: true, invalidate: ["one", "prefix:*", "*"] },
      undefined,
      scope
    );
    expect(driver.clears).toEqual([
      "viborm:cache:scope:user:",
      "viborm:cache:scope:prefix:",
      "viborm:cache:scope:",
    ]);
    expect(driver.deletes).toContainEqual([
      "viborm:cache:scope:one",
      "viborm:cache:scope:one:reval",
    ]);
    await expect(
      invalidateOfficialCache(
        driver,
        "user",
        { invalidate: ["viborm:forged"] },
        undefined,
        scope
      )
    ).rejects.toThrow(CacheInvalidKeyError);
  });

  test("uses the trusted instrumentation tracer for direct storage work", async () => {
    const driver = new RecordingCache();
    const context = createExecutionContext(
      { model: "record", operation: "findMany" },
      createInstrumentationContext({ tracing: true })
    );

    await expect(driver._delete("missing", context)).resolves.toBeUndefined();
    expect(driver.deletes).toEqual([
      ["viborm:missing", "viborm:missing:reval"],
    ]);
  });
});

describe("memory cache storage lifecycle", () => {
  test("replaces timers and expires, deletes, and clears only owned entries", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    try {
      const driver = new MemoryCache();
      await driver._set("expiring", "first", { ttl: 10 });
      await driver._set("expiring", "replacement", { ttl: 20 });
      await expect(driver._get("expiring")).resolves.toMatchObject({
        value: "replacement",
      });

      vi.advanceTimersByTime(10);
      await expect(driver._get("expiring")).resolves.toMatchObject({
        value: "replacement",
      });
      vi.advanceTimersByTime(10);
      await expect(driver._get("expiring")).resolves.toBeNull();

      await driver._set("tenant:one", 1, { ttl: 100 });
      await driver._set("tenant:two", 2, { ttl: 100 });
      await driver._set("other:one", 3, { ttl: 100 });
      await driver._delete("tenant:one");
      await expect(driver._get("tenant:one")).resolves.toBeNull();
      await driver._clear("tenant:");
      await expect(driver._get("tenant:two")).resolves.toBeNull();
      await expect(driver._get("other:one")).resolves.toMatchObject({
        value: 3,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Cloudflare KV backend contract", () => {
  test("maps entries, TTLs, deletion, and every list cursor to KV", async () => {
    const stored = new Map<string, string>();
    const deleted: string[] = [];
    const listCalls: Array<{ prefix?: string; cursor?: string }> = [];
    const putCalls: Array<{
      key: string;
      value: string;
      expirationTtl: number | undefined;
    }> = [];
    const kv = {
      async get(key: string) {
        const value = stored.get(key);
        return value === undefined ? null : JSON.parse(value);
      },
      async put(
        key: string,
        value: string,
        options?: { expirationTtl?: number }
      ) {
        putCalls.push({ key, value, expirationTtl: options?.expirationTtl });
        stored.set(key, value);
      },
      async delete(key: string) {
        deleted.push(key);
        stored.delete(key);
      },
      async list(options: { prefix?: string; cursor?: string }) {
        listCalls.push(options);
        return options.cursor === undefined
          ? {
              keys: [{ name: "viborm:tenant:a" }],
              list_complete: false,
              cursor: "next",
            }
          : {
              keys: [{ name: "viborm:tenant:b" }],
              list_complete: true,
              cursor: "",
            };
      },
    } as unknown as KVNamespace;
    const driver = new CloudflareKVCache(kv);

    await expect(driver._get("missing")).resolves.toBeNull();
    await driver._set("tenant:a", { answer: 42 }, { ttl: 1_501 });
    expect(putCalls[0]).toMatchObject({
      key: "viborm:tenant:a",
      expirationTtl: 2,
    });
    await expect(driver._get("tenant:a")).resolves.toMatchObject({
      value: { answer: 42 },
      ttl: 1_501,
    });

    await driver._delete("tenant:a");
    expect(deleted).toEqual([
      "viborm:tenant:a",
      "viborm:tenant:a:reval",
    ]);
    deleted.length = 0;
    await driver._clear("tenant:");
    expect(listCalls).toEqual([
      { prefix: "viborm:tenant:", cursor: undefined },
      { prefix: "viborm:tenant:", cursor: "next" },
    ]);
    expect(deleted).toEqual(["viborm:tenant:a", "viborm:tenant:b"]);
  });
});

describe("official cache definition and hostile configuration", () => {
  test("snapshots exact configuration and binds one pure client scope", () => {
    const driver = new MemoryCache();
    const waitUntil = () => undefined;
    const reads = { driver: 0, version: 0, waitUntil: 0 };
    const extension = cache({
      get driver() {
        reads.driver += 1;
        return driver;
      },
      get version() {
        reads.version += 1;
        return "blue";
      },
      get waitUntil() {
        reads.waitUntil += 1;
        return waitUntil;
      },
    });
    const capability = getOfficialCacheQueryCapability(extension.query);
    expect(capability).toMatchObject({ driver, version: "blue", waitUntil });
    expect(
      getOfficialCacheQueryCapability(cache({ driver, version: 2 }).query)
        ?.version
    ).toBe(2);
    expect(getOfficialCacheQueryCapability(undefined)).toBeUndefined();
    expect(Object.isFrozen(extension)).toBe(true);
    expect(reads).toEqual({ driver: 1, version: 1, waitUntil: 1 });

    const chain = Object.freeze({}) as ResolvedExtensionChain;
    expect(getOfficialCacheChainDefinition(undefined)).toBeUndefined();
    expect(getOfficialCacheChainCapability(undefined)).toBeUndefined();
    bindOfficialCacheChain(chain, {
      dialect: "sqlite",
      adapter: {},
    });
    expect(getOfficialCacheChainCapability(chain)).toBeUndefined();
    if (capability === undefined) throw new Error("missing cache capability");
    registerOfficialCacheChain(chain, capability);
    expect(getOfficialCacheChainDefinition(chain)).toBe(capability);
    bindOfficialCacheChain(chain, {
      dialect: "sqlite",
      adapter: {},
    });
    expect(getOfficialCacheChainCapability(chain)).toMatchObject({
      driver,
      version: "blue",
      waitUntil,
      scope: expect.any(Object),
    });
  });

  test.each([
    null,
    {},
    { driver: {} },
    { driver: new MemoryCache(), version: Number.NaN },
    { driver: new MemoryCache(), version: Number.POSITIVE_INFINITY },
    { driver: new MemoryCache(), waitUntil: true },
    { driver: new MemoryCache(), extra: true },
    Object.defineProperty({ driver: new MemoryCache() }, Symbol("extra"), {
      value: true,
    }),
  ])("rejects invalid cache configuration %#", (config) => {
    expect(() => Reflect.apply(cache, undefined, [config])).toThrow(
      CacheConfigurationError
    );
  });

  test("normalizes reflection, member-read, and prototype failures", () => {
    const reflectionFailure = new Proxy(
      {},
      {
        ownKeys() {
          throw "reflection refused";
        },
      }
    );
    const memberFailure = Object.defineProperty({}, "driver", {
      enumerable: true,
      get() {
        throw new Error("member refused");
      },
    });
    const prototypeFailure = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("prototype refused");
        },
      }
    );

    for (const config of [
      reflectionFailure,
      memberFailure,
      { driver: prototypeFailure },
    ]) {
      expect(() => Reflect.apply(cache, undefined, [config])).toThrow(
        CacheConfigurationError
      );
    }
  });
});

describe("cache lifecycle presentation facts", () => {
  test("records logical events once and keeps late set failures presentable", () => {
    const context = officialInstrumentationContext({
      logging: true,
      correlationId: "correlation-1",
    });
    expect(hasOfficialCacheInstrumentation(context)).toBe(true);
    expect(hasOfficialCacheLogging(context)).toBe(true);

    emitCacheLogEvent("private-key", "miss", undefined, undefined, context);
    expect(
      completeOfficialCacheSetFailure(context, new Error("set refused"))
    ).toBeUndefined();
    const read = createOfficialCacheExecutionLogReader(context);
    expect(read?.().map(({ meta }) => meta)).toEqual([
      { event: "miss", status: undefined },
      { event: "miss", status: "cache-set-failed" },
    ]);
    expect(
      completeOfficialCacheSetFailure(context, new Error("late refusal"))
    ).toHaveLength(1);

    expect(createOfficialCacheExecutionLogReader({})).toBeUndefined();
    expect(completeOfficialCacheSetFailure(undefined, "failure")).toBeUndefined();
    expect(hasOfficialCacheInstrumentation({})).toBe(false);
    expect(hasOfficialCacheLogging({})).toBe(false);
  });

  test("builds tracing and logging facts without disclosing cache identity", () => {
    const context = officialInstrumentationContext({
      logging: true,
      tracing: true,
      correlationId: "correlation-2",
    });
    const factsReader = createCacheLifecycleInstrumentationFacts({
      context,
      driverName: "memory",
      spanName: SPAN_CACHE_GET,
      spanAttributes: { custom: "attribute" },
      rootSpan: true,
      readStartLogEvents: () => [
        createCacheInstrumentationLogEvent(context, "revalidate", "start"),
      ],
      readSpanAttributes: () => ({ "cache.result": "hit" }),
      readCompletionLogEvents: () => [
        createCacheInstrumentationLogEvent(context, "revalidate", "success"),
      ],
    });
    const facts = factsReader?.();
    expect(facts?.kind).toBe("cache");
    if (facts?.kind !== "cache") throw new Error("missing cache facts");
    expect(facts.spanOptions).toMatchObject({
      name: SPAN_CACHE_GET,
      root: true,
      attributes: {
        "cache.driver": "memory",
        custom: "attribute",
        "viborm.correlation.id": "correlation-2",
      },
    });
    expect(facts.startLogEvents).toHaveLength(1);
    expect(facts.complete({ status: "success", durationMs: 0 })).toMatchObject({
      kind: "cache",
      spanAttributes: { "cache.result": "hit" },
      logEvents: [expect.any(Object)],
    });

    expect(getCacheOperationAttributes("user", "findMany", undefined)).toEqual({
      "db.collection.name": "user",
      "db.operation.name": "findMany",
    });
    expect(
      getCacheOperationAttributes("user", "count", { "db.namespace": "app" })
    ).toEqual({
      "db.namespace": "app",
      "db.collection.name": "user",
      "db.operation.name": "count",
    });
  });

  test("omits unavailable presentation channels and empty completions", () => {
    const loggingContext = officialInstrumentationContext({ logging: true });
    const loggingFacts = createCacheLifecycleInstrumentationFacts({
      context: loggingContext,
      spanName: SPAN_CACHE_GET,
    })?.();
    expect(loggingFacts?.spanOptions).toBeUndefined();
    expect(loggingFacts?.startLogEvents).toBeUndefined();
    expect(
      loggingFacts?.complete({ status: "success", durationMs: 0 })
    ).toBeUndefined();

    const tracingContext = officialInstrumentationContext({ tracing: true });
    const tracingFacts = createCacheLifecycleInstrumentationFacts({
      context: tracingContext,
      spanName: SPAN_CACHE_GET,
      readSpanAttributes: () => undefined,
    })?.();
    expect(tracingFacts?.spanOptions).toMatchObject({
      name: SPAN_CACHE_GET,
      attributes: {},
    });
    expect(
      tracingFacts?.complete({ status: "success", durationMs: 0 })
    ).toBeUndefined();

    const tracingCompletion = createCacheLifecycleInstrumentationFacts({
      context: tracingContext,
      spanName: SPAN_CACHE_GET,
      readSpanAttributes: () => ({ "cache.result": "hit" }),
    })?.().complete({ status: "success", durationMs: 0 });
    expect(tracingCompletion).toEqual({
      kind: "cache",
      spanAttributes: { "cache.result": "hit" },
    });

    const unrelatedLoggingContext = officialInstrumentationContext({
      queryLogging: true,
    });
    expect(
      createCacheLifecycleInstrumentationFacts({
        context: unrelatedLoggingContext,
        spanName: SPAN_CACHE_GET,
      })
    ).toBeUndefined();

    const inertContext = officialInstrumentationContext();
    expect(
      createCacheLifecycleInstrumentationFacts({
        context: inertContext,
        spanName: SPAN_CACHE_GET,
      })
    ).toBeUndefined();
    expect(
      createCacheLifecycleInstrumentationFacts({
        context: undefined,
        spanName: SPAN_CACHE_GET,
      })
    ).toBeUndefined();
  });
});

describe("background cache failure integrity", () => {
  test("contains scheduler and promise failures without an unhandled rejection", async () => {
    const scheduled: Promise<unknown>[] = [];
    scheduleBackground(Promise.reject(new Error("work refused")), (promise) => {
      scheduled.push(promise);
      throw new Error("scheduler refused");
    });
    await expect(Promise.all(scheduled)).resolves.toEqual([undefined]);
    scheduleBackground(Promise.resolve(), undefined);
  });

  test("contains snapshot, marker, worker, set, and cleanup failures", async () => {
    const clock = createTestClock();
    const driver = new RecordingCache(clock);
    const scope = createOfficialCacheScope("viborm:cache:failure-test");
    const background: Promise<unknown>[] = [];
    const context = officialInstrumentationContext({ logging: true });
    let providerValue = "first";
    const options = {
      ttlMs: 10,
      swr: 100,
      bypass: false,
      executionContext: context,
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
    };
    const codec = {
      snapshot: (value: string) => value,
      materialize: (value: unknown) => String(value),
    };
    const execute = () =>
      executeCachedWithResultCodec(
        driver,
        "record",
        "findMany",
        {},
        async () => providerValue,
        options,
        codec,
        scope
      );

    await expect(execute()).resolves.toBe("first");
    await Promise.all(background.splice(0));
    clock.advance(11);

    driver.failMarkerGet = new Error("marker refused");
    await expect(execute()).resolves.toBe("first");
    await Promise.all(background.splice(0));

    providerValue = "second";
    driver.failDataSet = new Error("set refused");
    driver.failDelete = new Error("cleanup refused");
    await expect(execute()).resolves.toBe("first");
    await expect(Promise.all(background.splice(0))).resolves.toEqual([
      undefined,
    ]);

    const snapshotFailureCodec = {
      snapshot() {
        throw new Error("snapshot refused");
      },
      materialize: codec.materialize,
    };
    await expect(
      executeCachedWithResultCodec(
        driver,
        "record",
        "count",
        {},
        async () => "uncached",
        { ...options, swr: false },
        snapshotFailureCodec,
        scope
      )
    ).resolves.toBe("uncached");
  });

  test("reports a successful revalidation's cleanup failure to observers", async () => {
    const clock = createTestClock();
    const driver = new RecordingCache(clock);
    const scope = createOfficialCacheScope("viborm:cache:cleanup-test");
    const background: Promise<unknown>[] = [];
    let revalidationCompletion: unknown;
    const chain = appendResolvedExtension(
      undefined,
      {
        name: "cache-cleanup-observer",
        async observe(unit, proceed) {
          const completion = await proceed();
          if (unit.kind === "cache" && unit.operation === "revalidate") {
            revalidationCompletion = completion;
          }
        },
      },
      {}
    );
    const context = createExecutionContext(
      { model: "record", operation: "findMany" },
      undefined,
      undefined,
      chain
    );
    let providerValue = "first";
    const execute = () =>
      executeCachedWithResultCodec(
        driver,
        "record",
        "findMany",
        {},
        async () => providerValue,
        {
          ttlMs: 10,
          swr: 100,
          bypass: false,
          executionContext: context,
          waitUntil: (promise) => background.push(promise),
        },
        {
          snapshot: (value: string) => value,
          materialize: (value: unknown) => String(value),
        },
        scope
      );

    await expect(execute()).resolves.toBe("first");
    await Promise.all(background.splice(0));
    clock.advance(11);
    providerValue = "second";
    driver.failDelete = new Error("cleanup refused");
    await expect(execute()).resolves.toBe("first");
    await expect(Promise.all(background.splice(0))).resolves.toEqual([
      undefined,
    ]);
    expect(revalidationCompletion).toMatchObject({
      status: "failure",
      error: { message: "Error details redacted" },
    });
  });

  test("publishes a late cache-set failure through official logging", async () => {
    const driver = new RecordingCache();
    const scope = createOfficialCacheScope("viborm:cache:set-failure-test");
    const background: Promise<unknown>[] = [];
    const context = officialInstrumentationContext({ logging: true });
    driver.failDataSet = new Error("late set refused");

    await expect(
      executeCachedWithResultCodec(
        driver,
        "record",
        "findMany",
        {},
        async () => "fresh",
        {
          ttlMs: 10,
          swr: false,
          bypass: false,
          executionContext: context,
          waitUntil: (promise) => background.push(promise),
        },
        {
          snapshot: (value: string) => value,
          materialize: (value: unknown) => String(value),
        },
        scope
      )
    ).resolves.toBe("fresh");
    await expect(Promise.all(background.splice(0))).resolves.toEqual([
      undefined,
    ]);
    expect(
      createOfficialCacheExecutionLogReader(context)?.().map(({ meta }) => meta)
    ).toContainEqual({ event: "miss", status: "cache-set-failed" });
  });

  test("revalidates under tracing without fabricating a log event", async () => {
    const clock = createTestClock();
    const driver = new RecordingCache(clock);
    const scope = createOfficialCacheScope("viborm:cache:tracing-only-test");
    const background: Promise<unknown>[] = [];
    const context = officialInstrumentationContext({ tracing: true });
    let providerValue = "first";
    const execute = () =>
      executeCachedWithResultCodec(
        driver,
        "record",
        "findMany",
        {},
        async () => providerValue,
        {
          ttlMs: 10,
          swr: 100,
          bypass: false,
          executionContext: context,
          waitUntil: (promise) => background.push(promise),
        },
        {
          snapshot: (value: string) => value,
          materialize: (value: unknown) => String(value),
        },
        scope
      );

    await expect(execute()).resolves.toBe("first");
    await Promise.all(background.splice(0));
    clock.advance(11);
    providerValue = "second";
    await expect(execute()).resolves.toBe("first");
    await Promise.all(background.splice(0));
    await expect(execute()).resolves.toBe("second");
    expect(createOfficialCacheExecutionLogReader(context)).toBeUndefined();
  });

  test("contains ordinary background writes and stale revalidation failures", async () => {
    const clock = createTestClock();
    const driver = new RecordingCache(clock);
    const scope = createOfficialCacheScope("viborm:cache:ordinary-test");
    const background: Promise<unknown>[] = [];
    let providerValue = "first";
    let providerFailure: Error | undefined;
    const options = {
      ttlMs: 10,
      swr: 100,
      bypass: false,
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
    };
    const codec = {
      snapshot: (value: string) => value,
      materialize: (value: unknown) => String(value),
    };
    const execute = () =>
      executeCachedWithResultCodec(
        driver,
        "record",
        "findMany",
        {},
        async () => {
          if (providerFailure) throw providerFailure;
          return providerValue;
        },
        options,
        codec,
        scope
      );

    driver.failDataSet = new Error("initial set refused");
    await expect(execute()).resolves.toBe("first");
    await expect(Promise.all(background.splice(0))).resolves.toEqual([
      undefined,
    ]);

    await expect(execute()).resolves.toBe("first");
    await Promise.all(background.splice(0));
    clock.advance(11);
    providerValue = "second";
    await expect(execute()).resolves.toBe("first");
    await Promise.all(background.splice(0));
    await expect(execute()).resolves.toBe("second");

    clock.advance(11);
    providerFailure = new Error("revalidation refused");
    await expect(execute()).resolves.toBe("second");
    await expect(Promise.all(background.splice(0))).resolves.toEqual([
      undefined,
    ]);
  });

  test("suppresses a stale revalidation while its marker exists", async () => {
    const clock = createTestClock();
    const driver = new RecordingCache(clock);
    const scope = createOfficialCacheScope("viborm:cache:marker-test");
    const background: Promise<unknown>[] = [];
    let providerCalls = 0;
    const execute = () =>
      executeCachedWithResultCodec(
        driver,
        "record",
        "findMany",
        {},
        async () => String(++providerCalls),
        {
          ttlMs: 10,
          swr: 100,
          bypass: false,
          waitUntil: (promise: Promise<unknown>) => background.push(promise),
        },
        {
          snapshot: (value: string) => value,
          materialize: (value: unknown) => String(value),
        },
        scope
      );

    await expect(execute()).resolves.toBe("1");
    await Promise.all(background.splice(0));
    const dataKey = driver.sets.find(({ key }) => !key.endsWith(":reval"))?.key;
    if (dataKey === undefined) throw new Error("missing cached data key");
    driver.entries.set(`${dataKey}:reval`, {
      value: true,
      createdAt: clock.now(),
      ttl: 10_000,
    });

    clock.advance(11);
    await expect(execute()).resolves.toBe("1");
    await Promise.all(background.splice(0));
    expect(providerCalls).toBe(1);
  });

  test("reports get and late set failures through official tracing", async () => {
    const driver = new RecordingCache();
    const scope = createOfficialCacheScope("viborm:cache:traced-failure-test");
    const background: Promise<unknown>[] = [];
    const context = officialInstrumentationContext({ tracing: true });
    const options = {
      ttlMs: 10,
      swr: false as const,
      bypass: false,
      executionContext: context,
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
    };
    const codec = {
      snapshot: (value: string) => value,
      materialize: (value: unknown) => String(value),
    };

    driver.failGet = new Error("get refused");
    await expect(
      executeCachedWithResultCodec(
        driver,
        "record",
        "findMany",
        {},
        async () => "never",
        options,
        codec,
        scope
      )
    ).rejects.toThrow("get refused");

    driver.failDataSet = new Error("late set refused");
    await expect(
      executeCachedWithResultCodec(
        driver,
        "record",
        "count",
        {},
        async () => "fresh",
        options,
        codec,
        scope
      )
    ).resolves.toBe("fresh");
    await expect(Promise.all(background.splice(0))).resolves.toEqual([
      undefined,
    ]);
  });

  test("publishes a successful stale revalidation through official presentation", async () => {
    const clock = createTestClock();
    const driver = new RecordingCache(clock);
    const scope = createOfficialCacheScope("viborm:cache:success-test");
    const background: Promise<unknown>[] = [];
    const context = officialInstrumentationContext({
      logging: true,
      tracing: true,
    });
    let providerValue = "first";
    const options = {
      ttlMs: 10,
      swr: 100,
      bypass: false,
      executionContext: context,
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
    };
    const codec = {
      snapshot: (value: string) => value,
      materialize: (value: unknown) => String(value),
    };
    const execute = () =>
      executeCachedWithResultCodec(
        driver,
        "record",
        "findMany",
        {},
        async () => providerValue,
        options,
        codec,
        scope
      );

    await expect(execute()).resolves.toBe("first");
    await Promise.all(background.splice(0));
    clock.advance(11);
    providerValue = "second";
    await expect(execute()).resolves.toBe("first");
    await Promise.all(background.splice(0));
    await expect(execute()).resolves.toBe("second");
  });
});

describe("coverage low value", () => {
  test("executes the public cache barrel", () => {
    expect(ExportedCacheDriver).toBe(CacheDriver);
    expect(exportedCache).toBe(cache);
  });

  test("executes the browser byte encoder and fixed official query token", async () => {
    const nodeBuffer = globalThis.Buffer;
    vi.stubGlobal("Buffer", undefined);
    try {
      expect(generateCacheKey("blob", "findMany", new Uint8Array([1, 2, 3])))
        .toEqual(expect.any(String));
    } finally {
      vi.stubGlobal("Buffer", nodeBuffer);
    }

    const extension = cache({ driver: new MemoryCache() });
    const value = { answer: 42 };
    await expect(
      Reflect.apply(extension.query, undefined, [
        { proceed: async () => value },
      ])
    ).resolves.toBe(value);
  });
});
