import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { CacheDriver, type CacheEntry } from "@cache/driver";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { Driver } from "@drivers";
import {
  ATTR_CACHE_RESULT,
  ATTR_CACHE_TTL,
  ATTR_VIBORM_CORRELATION_ID,
  SPAN_CACHE_CLEAR,
  SPAN_CACHE_DELETE,
  SPAN_CACHE_GET,
  SPAN_CACHE_INVALIDATE,
  SPAN_CACHE_SET,
  SPAN_OPERATION,
} from "@instrumentation/spans";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { cache } from "@src/cache/exports";
import { createClient, s } from "@src/index";
import { instrumentation } from "@src/instrumentation/exports";
import { createTestClock } from "@tests/fixtures/test-clock";
import {
  captureLogs,
  withOtelRecorder,
} from "@tests/unit/instrumentation/_capture";
import { afterEach, describe, expect, test } from "vitest";

const record = s.model({ id: s.string().id(), name: s.string() });
const schema = { record };

class CacheInstrumentationDriver extends Driver<object, object> {
  readonly adapter = new SQLiteAdapter();
  rows = [{ id: "record-1", name: "Ada" }];
  readCalls = 0;
  failNextRead: unknown;

  constructor() {
    super("sqlite", "cache-instrumentation-test");
    this.client = {};
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected async closeClient(): Promise<void> {
    // No provider resource.
  }

  protected async execute<T>(
    _client: object,
    statement: string,
    _params: unknown[],
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (statement.trimStart().startsWith("SELECT")) {
      this.readCalls += 1;
      if (this.failNextRead !== undefined) {
        const failure = this.failNextRead;
        this.failNextRead = undefined;
        throw failure;
      }
      return {
        rows: this.rows.map((row) => ({ ...row })) as T[],
        rowCount: this.rows.length,
      };
    }
    return {
      rows: statement.includes("RETURNING")
        ? ([{ id: "created", name: "Created" }] as T[])
        : [],
      rowCount: 1,
    };
  }

  protected executeRaw<T>(
    client: object,
    statement: string,
    _params?: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.execute(client, statement, [], context);
  }

  protected transaction<T>(
    client: object,
    callback: (transaction: object) => Promise<T>
  ): Promise<T> {
    return callback(client);
  }
}

class ObservableInstrumentationCache extends CacheDriver {
  readonly entries = new Map<string, CacheEntry>();
  readonly timeline: string[] = [];
  failNextMarkerGet: unknown;
  failNextSet: unknown;
  failNextDelete: unknown;

  constructor(clock: ReturnType<typeof createTestClock>) {
    super("observable-instrumentation-cache", clock);
  }

  protected async get<T>(key: string): Promise<CacheEntry<T> | null> {
    this.timeline.push(`get:${key}`);
    if (key.endsWith(":reval") && this.failNextMarkerGet !== undefined) {
      const failure = this.failNextMarkerGet;
      this.failNextMarkerGet = undefined;
      throw failure;
    }
    return (this.entries.get(key) as CacheEntry<T> | undefined) ?? null;
  }

  protected async set<T>(
    key: string,
    _storageTtl: number,
    entry: CacheEntry<T>
  ): Promise<void> {
    this.timeline.push(`set:${key}`);
    if (!key.endsWith(":reval") && this.failNextSet !== undefined) {
      const failure = this.failNextSet;
      this.failNextSet = undefined;
      throw failure;
    }
    this.entries.set(key, entry);
  }

  protected async delete(keys: string[]): Promise<void> {
    this.timeline.push(`delete:${keys.join(",")}`);
    if (this.failNextDelete !== undefined) {
      const failure = this.failNextDelete;
      this.failNextDelete = undefined;
      throw failure;
    }
    for (const key of keys) this.entries.delete(key);
  }

  protected async clear(prefix: string): Promise<void> {
    this.timeline.push(`clear:${prefix}`);
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }
}

interface CacheObservation {
  readonly operation: string | undefined;
  readonly completion: Promise<{
    readonly status: "success" | "failure";
  }>;
}

const clients: Array<{ $disconnect(): Promise<void> }> = [];

function trackClient<T extends { $disconnect(): Promise<void> }>(client: T): T {
  clients.push(client);
  return client;
}

function createBackgroundQueue(): {
  readonly promises: Promise<unknown>[];
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly settle: () => Promise<void>;
} {
  const promises: Promise<unknown>[] = [];
  return {
    promises,
    waitUntil(promise) {
      promises.push(promise);
    },
    async settle() {
      while (promises.length > 0) {
        await Promise.all(promises.splice(0));
      }
      await Promise.resolve();
    },
  };
}

function cacheEvents(events: ReturnType<typeof captureLogs>["events"]) {
  return events.map((event) => ({
    level: event.level,
    model: event.model,
    operation: event.operation,
    event: event.meta?.event,
    status: event.meta?.status,
    error: event.error?.name,
  }));
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (check()) return;
    await Promise.resolve();
  }
  throw new Error("Expected cache instrumentation work did not settle");
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

describe("official cache instrumentation", () => {
  test("correlates cache telemetry without disclosing the custom key", async () => {
    const recorder = withOtelRecorder();
    try {
      const secretKey = "secret-cache-suffix-never-disclose";
      const cacheDriver = new ObservableInstrumentationCache(createTestClock());
      const logs = captureLogs();
      const background = createBackgroundQueue();
      const publicUnits: Readonly<Record<string, unknown>>[] = [];
      const client = trackClient(
        createClient({ schema, driver: new CacheInstrumentationDriver() })
          .$extends(
            cache({ driver: cacheDriver, waitUntil: background.waitUntil })
          )
          .$extends(
            instrumentation({
              logging: { cache: logs.callback },
              tracing: true,
            })
          )
          .$extends({
            name: "cache-disclosure-observer",
            observe(unit, proceed) {
              if (unit.kind !== "cache") return;
              publicUnits.push({ ...unit });
              return proceed();
            },
          })
      );

      await client.$withCache({ key: secretKey, ttl: 10 }).record.findMany();
      await background.settle();
      await waitFor(
        () =>
          logs.events.length === 1 &&
          recorder.spans().some(({ name }) => name === SPAN_OPERATION)
      );

      const correlationId = logs.events[0]?.correlationId;
      expect(correlationId).toEqual(expect.any(String));
      expect(
        recorder
          .spans()
          .filter(({ name }) => name === SPAN_OPERATION)
          .map(({ attributes }) => attributes[ATTR_VIBORM_CORRELATION_ID])
      ).toContain(correlationId);
      for (const spanName of [SPAN_CACHE_GET, SPAN_CACHE_SET]) {
        const cacheSpans = recorder
          .spans()
          .filter(({ name }) => name === spanName);
        expect(cacheSpans).toHaveLength(1);
        expect(cacheSpans[0]?.attributes[ATTR_VIBORM_CORRELATION_ID]).toBe(
          correlationId
        );
      }
      expect(
        publicUnits.map(({ kind, operation }) => ({ kind, operation }))
      ).toEqual([
        { kind: "cache", operation: "get" },
        { kind: "cache", operation: "set" },
      ]);

      const disclosedTelemetry = JSON.stringify({
        logs: logs.events,
        spans: recorder.spans().map(({ attributes, events, name }) => ({
          attributes,
          events,
          name,
        })),
        units: publicUnits,
      });
      expect(disclosedTelemetry).not.toContain(secretKey);
    } finally {
      await recorder.dispose();
    }
  });

  test("contains a synchronously throwing waitUntil on miss and stale hit", async () => {
    const clock = createTestClock();
    const cacheDriver = new ObservableInstrumentationCache(clock);
    const databaseDriver = new CacheInstrumentationDriver();
    const schedulerFailure = new Error("scheduler refused");
    const unhandled: unknown[] = [];
    let scheduleCalls = 0;
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const client = trackClient(
        createClient({ schema, driver: databaseDriver })
          .$extends(
            cache({
              driver: cacheDriver,
              waitUntil() {
                scheduleCalls += 1;
                throw schedulerFailure;
              },
            })
          )
          .$extends(instrumentation({ tracing: true }))
      );
      const cached = client.$withCache({ ttl: 10, swr: 100 });

      await expect(cached.record.findMany()).resolves.toEqual([
        { id: "record-1", name: "Ada" },
      ]);
      await waitFor(() => cacheDriver.entries.size === 1);
      expect(scheduleCalls).toBe(1);

      clock.advance(11);
      databaseDriver.rows = [{ id: "record-1", name: "Grace" }];
      await expect(cached.record.findMany()).resolves.toEqual([
        { id: "record-1", name: "Ada" },
      ]);
      await waitFor(() => databaseDriver.readCalls === 2);
      await waitFor(() =>
        cacheDriver.timeline.some(
          (entry) => entry.startsWith("delete:") && entry.endsWith(":reval")
        )
      );
      expect(scheduleCalls).toBe(2);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  test("isolates sibling instrumentation on one shared cache capability", async () => {
    const recorder = withOtelRecorder();
    try {
      const clock = createTestClock();
      const cacheDriver = new ObservableInstrumentationCache(clock);
      const databaseDriver = new CacheInstrumentationDriver();
      const background = createBackgroundQueue();
      const sharedCache = cache({
        driver: cacheDriver,
        version: "shared-capability",
        waitUntil: background.waitUntil,
      });
      const firstLogs = captureLogs();
      const secondLogs = captureLogs();
      const base = createClient({ schema, driver: databaseDriver });
      clients.push(base);
      const first = trackClient(
        base.$extends(sharedCache).$extends(
          instrumentation({
            logging: { cache: firstLogs.callback },
            tracing: true,
          })
        )
      );
      const second = trackClient(
        base.$extends(sharedCache).$extends(
          instrumentation({
            logging: { cache: secondLogs.callback },
            tracing: true,
          })
        )
      );
      const firstCached = first.$withCache({ ttl: 10, swr: 100 });
      const secondCached = second.$withCache({ ttl: 10, swr: 100 });

      await firstCached.record.findMany();
      await background.settle();
      expect(databaseDriver.readCalls).toBe(1);

      await secondCached.record.findMany();
      expect(databaseDriver.readCalls).toBe(1);

      clock.advance(11);
      databaseDriver.rows = [{ id: "record-1", name: "Grace" }];
      await expect(secondCached.record.findMany()).resolves.toEqual([
        { id: "record-1", name: "Ada" },
      ]);
      await background.settle();
      await waitFor(
        () =>
          firstLogs.events.length === 1 &&
          secondLogs.events.some(
            ({ meta }) =>
              meta?.event === "revalidate" && meta.status === "success"
          )
      );

      expect(cacheEvents(firstLogs.events)).toEqual([
        {
          level: "cache",
          model: "record",
          operation: "findMany",
          event: "miss",
          status: undefined,
          error: undefined,
        },
      ]);
      expect(cacheEvents(secondLogs.events)).toEqual([
        {
          level: "cache",
          model: "record",
          operation: "findMany",
          event: "hit",
          status: undefined,
          error: undefined,
        },
        {
          level: "cache",
          model: "record",
          operation: "findMany",
          event: "revalidate",
          status: "start",
          error: undefined,
        },
        {
          level: "cache",
          model: "record",
          operation: "findMany",
          event: "hit",
          status: "stale",
          error: undefined,
        },
        {
          level: "cache",
          model: "record",
          operation: "findMany",
          event: "revalidate",
          status: "success",
          error: undefined,
        },
      ]);
      expect(databaseDriver.readCalls).toBe(2);

      const firstCorrelation = firstLogs.events[0]?.correlationId;
      const secondCorrelations = new Set(
        secondLogs.events.map(({ correlationId }) => correlationId)
      );
      expect(firstCorrelation).toEqual(expect.any(String));
      expect(
        [...secondCorrelations].every(
          (correlationId) => typeof correlationId === "string"
        )
      ).toBe(true);
      expect(secondCorrelations.has(firstCorrelation)).toBe(false);
      const spanCorrelations = new Set(
        recorder
          .spans()
          .filter(({ name }) => name === SPAN_OPERATION)
          .map(({ attributes }) => attributes[ATTR_VIBORM_CORRELATION_ID])
      );
      expect(spanCorrelations.has(firstCorrelation)).toBe(true);
      for (const correlationId of secondCorrelations) {
        expect(spanCorrelations.has(correlationId)).toBe(true);
      }
    } finally {
      await recorder.dispose();
    }
  });

  test("presents cold, fresh, bypass, and set failure without duplicate spans", async () => {
    const recorder = withOtelRecorder();
    try {
      const officialClock = createTestClock();
      const officialCache = new ObservableInstrumentationCache(officialClock);
      const officialDriver = new CacheInstrumentationDriver();
      const officialLogs = captureLogs();
      const officialBackground = createBackgroundQueue();
      const official = trackClient(
        createClient({ schema, driver: officialDriver })
          .$extends(
            cache({
              driver: officialCache,
              version: "official-parity",
              waitUntil: officialBackground.waitUntil,
            })
          )
          .$extends(
            instrumentation({
              logging: { cache: officialLogs.callback },
              tracing: true,
            })
          )
      );
      const officialStart = recorder.spans().length;

      await official
        .$withCache({ key: "records", ttl: 10, swr: 100 })
        .record.findMany();
      await officialBackground.settle();
      await official
        .$withCache({ key: "records", ttl: 10, swr: 100 })
        .record.findMany();
      await official
        .$withCache({ key: "records", ttl: 10, swr: 100, bypass: true })
        .record.findMany();
      await officialBackground.settle();
      officialCache.failNextSet = new Error("cache set refused");
      await official
        .$withCache({ key: "set-failure", ttl: 10, swr: 100 })
        .record.findMany();
      await officialBackground.settle();
      await waitFor(
        () => officialLogs.events.length === 5 && recorder.spans().length >= 10
      );
      const officialSpans = recorder.spans().slice(officialStart);

      expect(cacheEvents(officialLogs.events)).toEqual([
        {
          level: "cache",
          model: "record",
          operation: "findMany",
          event: "miss",
          status: undefined,
          error: undefined,
        },
        {
          level: "cache",
          model: "record",
          operation: "findMany",
          event: "hit",
          status: undefined,
          error: undefined,
        },
        {
          level: "cache",
          model: "record",
          operation: "findMany",
          event: "bypass",
          status: undefined,
          error: undefined,
        },
        {
          level: "cache",
          model: "record",
          operation: "findMany",
          event: "miss",
          status: undefined,
          error: undefined,
        },
        {
          level: "cache",
          model: "record",
          operation: "findMany",
          event: "miss",
          status: "cache-set-failed",
          error: "Error",
        },
      ]);

      expect(
        officialSpans.filter(({ name }) => name === SPAN_OPERATION)
      ).toHaveLength(4);
      expect(
        officialSpans.filter(({ name }) => name === SPAN_CACHE_GET)
      ).toHaveLength(3);
      expect(
        officialSpans.filter(({ name }) => name === SPAN_CACHE_SET)
      ).toHaveLength(3);
      expect(
        officialSpans
          .filter(({ name }) => name === SPAN_CACHE_GET)
          .map(({ attributes }) => attributes[ATTR_CACHE_RESULT])
      ).toEqual(["miss", "hit", "miss"]);
      expect(
        officialSpans
          .filter(({ name }) => name === SPAN_CACHE_SET)
          .map(({ attributes }) => attributes[ATTR_CACHE_TTL])
      ).toEqual(["10", "10", "10"]);
    } finally {
      await recorder.dispose();
    }
  });

  test("does not leak ignored get attributes onto the operation or external parent", async () => {
    const recorder = withOtelRecorder();
    try {
      const cacheDriver = new ObservableInstrumentationCache(createTestClock());
      const background = createBackgroundQueue();
      const client = trackClient(
        createClient({ schema, driver: new CacheInstrumentationDriver() })
          .$extends(
            cache({ driver: cacheDriver, waitUntil: background.waitUntil })
          )
          .$extends(
            instrumentation({
              tracing: { ignoreSpanTypes: [SPAN_CACHE_GET] },
            })
          )
      );

      await trace
        .getTracer("cache-ignore-test")
        .startActiveSpan("external.cache-parent", async (span) => {
          try {
            await client.$withCache({ ttl: 10 }).record.findMany();
            await background.settle();
          } finally {
            span.end();
          }
        });
      await waitFor(
        () =>
          recorder.spans().some(({ name }) => name === SPAN_OPERATION) &&
          recorder.spans().some(({ name }) => name === "external.cache-parent")
      );

      expect(
        recorder.spans().filter(({ name }) => name === SPAN_CACHE_GET)
      ).toEqual([]);
      for (const span of recorder
        .spans()
        .filter(
          ({ name }) =>
            name === SPAN_OPERATION || name === "external.cache-parent"
        )) {
        expect(span.attributes).not.toHaveProperty(ATTR_CACHE_RESULT);
      }
    } finally {
      await recorder.dispose();
    }
  });

  test("keeps invalidation children nested and contains independent ordinary observers", async () => {
    const recorder = withOtelRecorder();
    try {
      const cacheDriver = new ObservableInstrumentationCache(createTestClock());
      const databaseDriver = new CacheInstrumentationDriver();
      const first: CacheObservation[] = [];
      const second: CacheObservation[] = [];
      const client = trackClient(
        createClient({ schema, driver: databaseDriver })
          .$extends(cache({ driver: cacheDriver, version: "invalidate" }))
          .$extends({
            name: "cache-observer-before",
            observe(unit, proceed) {
              if (unit.kind !== "cache") return;
              first.push({ operation: unit.operation, completion: proceed() });
              throw new Error("contained observer failure");
            },
          })
          .$extends(instrumentation({ tracing: true }))
          .$extends({
            name: "cache-observer-after",
            observe(unit, proceed) {
              if (unit.kind !== "cache") return;
              second.push({ operation: unit.operation, completion: proceed() });
              return Promise.reject(new Error("contained observer rejection"));
            },
          })
      );

      await expect(
        client.$invalidate("record:*", "one")
      ).resolves.toBeUndefined();
      await expect(
        client.record.create({
          data: { id: "created", name: "Created" },
          cache: { invalidate: ["one"] },
        })
      ).resolves.toMatchObject({ id: "created" });
      await Promise.all([
        ...first.map(({ completion }) => completion),
        ...second.map(({ completion }) => completion),
      ]);

      expect(first.map(({ operation }) => operation)).toEqual([
        "invalidate",
        "invalidate",
      ]);
      expect(second.map(({ operation }) => operation)).toEqual([
        "invalidate",
        "invalidate",
      ]);
      const spans = recorder.spans();
      const invalidations = spans.filter(
        ({ name }) => name === SPAN_CACHE_INVALIDATE
      );
      expect(invalidations).toHaveLength(2);
      expect(
        spans.filter(({ name }) => name === SPAN_CACHE_CLEAR)
      ).toHaveLength(1);
      expect(
        spans.filter(({ name }) => name === SPAN_CACHE_DELETE)
      ).toHaveLength(2);
      const invalidationSpanIds = new Set(
        invalidations.map((span) => span.spanContext().spanId)
      );
      for (const child of spans.filter(
        ({ name }) => name === SPAN_CACHE_CLEAR || name === SPAN_CACHE_DELETE
      )) {
        expect(
          invalidationSpanIds.has(child.parentSpanContext?.spanId ?? "")
        ).toBe(true);
      }
    } finally {
      await recorder.dispose();
    }
  });

  test("presents one SWR root with nested set and the exact protected failure", async () => {
    const recorder = withOtelRecorder();
    try {
      const clock = createTestClock();
      const cacheDriver = new ObservableInstrumentationCache(clock);
      const databaseDriver = new CacheInstrumentationDriver();
      const logs = captureLogs();
      const background = createBackgroundQueue();
      const revalidations: CacheObservation[] = [];
      const client = trackClient(
        createClient({ schema, driver: databaseDriver })
          .$extends(
            cache({
              driver: cacheDriver,
              version: "swr-instrumentation",
              waitUntil: background.waitUntil,
            })
          )
          .$extends(
            instrumentation({
              logging: { cache: logs.callback },
              tracing: true,
            })
          )
          .$extends({
            name: "swr-completion-observer",
            observe(unit, proceed) {
              if (unit.kind !== "cache" || unit.operation !== "revalidate") {
                return;
              }
              revalidations.push({
                operation: unit.operation,
                completion: proceed(),
              });
            },
          })
      );
      const cached = client.$withCache({ ttl: 10, swr: 100 });

      await cached.record.findMany();
      await background.settle();
      clock.advance(11);
      databaseDriver.rows = [{ id: "record-1", name: "Grace" }];
      const successfulStart = recorder.spans().length;
      await expect(cached.record.findMany()).resolves.toMatchObject([
        { name: "Ada" },
      ]);
      await background.settle();
      await waitFor(
        () =>
          cacheEvents(logs.events).some(
            ({ event, status }) =>
              event === "revalidate" && status === "success"
          ) &&
          recorder
            .spans()
            .slice(successfulStart)
            .filter(
              ({ name, parentSpanContext }) =>
                name === SPAN_OPERATION && parentSpanContext === undefined
            ).length === 2
      );
      const successfulSpans = recorder.spans().slice(successfulStart);
      const successfulRoots = successfulSpans.filter(
        ({ name, parentSpanContext }) =>
          name === SPAN_OPERATION && parentSpanContext === undefined
      );
      expect(successfulRoots).toHaveLength(2);
      const revalidationRoot = successfulRoots.at(-1);
      const nestedSet = successfulSpans.find(
        ({ name }) => name === SPAN_CACHE_SET
      );
      expect(
        successfulSpans.find(({ name }) => name === SPAN_CACHE_GET)?.attributes[
          ATTR_CACHE_RESULT
        ]
      ).toBe("stale");
      expect(nestedSet?.parentSpanContext?.spanId).toBe(
        revalidationRoot?.spanContext().spanId
      );
      expect(revalidationRoot?.status.code).toBe(SpanStatusCode.OK);

      clock.advance(11);
      databaseDriver.failNextRead = new Error("worker refused");
      cacheDriver.failNextDelete = new Error("cleanup refused");
      const failedStart = recorder.spans().length;
      await expect(cached.record.findMany()).resolves.toMatchObject([
        { name: "Grace" },
      ]);
      await background.settle();
      await Promise.all(revalidations.map(({ completion }) => completion));
      await waitFor(
        () =>
          cacheEvents(logs.events).some(
            ({ event, status }) => event === "revalidate" && status === "error"
          ) &&
          recorder
            .spans()
            .slice(failedStart)
            .some(
              ({ name, status }) =>
                name === SPAN_OPERATION && status.code === SpanStatusCode.ERROR
            )
      );
      const failedSpans = recorder.spans().slice(failedStart);
      const failedRoot = failedSpans.find(
        ({ name, status }) =>
          name === SPAN_OPERATION && status.code === SpanStatusCode.ERROR
      );

      expect(failedRoot).toBeDefined();
      expect(
        cacheEvents(logs.events).filter(
          ({ event, status }) => event === "hit" && status === "stale"
        )
      ).toHaveLength(2);
      expect(revalidations.map(({ completion }) => completion).length).toBe(2);
      await expect(revalidations[1]?.completion).resolves.toMatchObject({
        status: "failure",
      });

      const officialRevalidationEvents = cacheEvents(logs.events).filter(
        ({ event }) => event === "revalidate"
      );
      expect(officialRevalidationEvents).toEqual([
        {
          level: "cache",
          model: "record",
          operation: "findMany",
          event: "revalidate",
          status: "start",
          error: undefined,
        },
        {
          level: "cache",
          model: "record",
          operation: "findMany",
          event: "revalidate",
          status: "success",
          error: undefined,
        },
        {
          level: "cache",
          model: "record",
          operation: "findMany",
          event: "revalidate",
          status: "start",
          error: undefined,
        },
        {
          level: "cache",
          model: "record",
          operation: "findMany",
          event: "revalidate",
          status: "error",
          error: "QueryError",
        },
      ]);
    } finally {
      await recorder.dispose();
    }
  });

  test("keeps marker refusal invisible and isolates sibling official loggers", async () => {
    const clock = createTestClock();
    const cacheDriver = new ObservableInstrumentationCache(clock);
    const databaseDriver = new CacheInstrumentationDriver();
    const firstLogs = captureLogs();
    const secondLogs = captureLogs();
    const firstBackground = createBackgroundQueue();
    const secondBackground = createBackgroundQueue();
    const base = createClient({ schema, driver: databaseDriver });
    clients.push(base);
    const first = trackClient(
      base
        .$extends(
          cache({
            driver: cacheDriver,
            version: "first",
            waitUntil: firstBackground.waitUntil,
          })
        )
        .$extends(instrumentation({ logging: { cache: firstLogs.callback } }))
    );
    const second = trackClient(
      base
        .$extends(
          cache({
            driver: cacheDriver,
            version: "second",
            waitUntil: secondBackground.waitUntil,
          })
        )
        .$extends(instrumentation({ logging: { cache: secondLogs.callback } }))
    );

    await first.$withCache({ ttl: 10, swr: 100 }).record.findMany();
    await firstBackground.settle();
    await waitFor(() => firstLogs.events.length === 1);
    expect(cacheEvents(firstLogs.events)).toHaveLength(1);
    expect(cacheEvents(secondLogs.events)).toHaveLength(0);

    await second.$withCache({ ttl: 10, swr: 100 }).record.findMany();
    await secondBackground.settle();
    await waitFor(() => secondLogs.events.length === 1);
    expect(cacheEvents(firstLogs.events)).toHaveLength(1);
    expect(cacheEvents(secondLogs.events)).toHaveLength(1);

    clock.advance(11);
    cacheDriver.failNextMarkerGet = new Error("marker refused");
    await first.$withCache({ ttl: 10, swr: 100 }).record.findMany();
    await firstBackground.settle();
    await Promise.resolve();
    expect(
      cacheEvents(firstLogs.events).filter(
        ({ event }) => event === "revalidate"
      )
    ).toEqual([]);
    expect(cacheEvents(secondLogs.events)).toHaveLength(1);
  });
});
