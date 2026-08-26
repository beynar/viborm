import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { CacheDriver, type CacheEntry } from "@cache/driver";
import { cache as cacheExtension } from "@src/cache/exports";
import type { QueryExecutionContext, QueryResult } from "@src/drivers";
import { Driver } from "@src/drivers";
import { createClient, s } from "@src/index";
import type { Operation } from "@src/query-engine/types";
import type { JsonValue } from "@src/validation";
import { validateJson } from "@src/validation/primitives/json";
import { isRecord } from "@src/validation/value-guards";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createTestClock } from "@tests/fixtures/test-clock";
import { afterEach, describe, expect, test } from "vitest";

let publishHostileJson = false;
let hostileJsonGetterReads = 0;
let hostileJsonReadsAtCoreBoundary = 0;

const snapshotFailureSchema: StandardSchemaV1<JsonValue, JsonValue> = {
  "~standard": {
    version: 1,
    vendor: "official-cache-swr-test",
    validate(value) {
      if (!publishHostileJson) return validateJson(value);
      const hostile = { version: 2 };
      Object.defineProperty(hostile, "version", {
        configurable: true,
        enumerable: true,
        get() {
          hostileJsonGetterReads += 1;
          return 2;
        },
      });
      return { value: hostile };
    },
  },
};

const record = s.model({
  id: s.string().id(),
  name: s.string(),
  payload: s.json().schema(snapshotFailureSchema),
});
const schema = { record };

interface ProviderRow {
  readonly id: string;
  readonly name: string;
  readonly payload: JsonValue;
}

interface ObserverCompletion {
  readonly status: "success" | "failure";
  readonly error?: Readonly<{ readonly name: string }>;
}

class SwrDriver extends Driver<object, object> {
  readonly adapter = new SQLiteAdapter();
  readonly result = {
    parseResult(
      raw: unknown,
      operation: Operation,
      next: (raw: unknown, operation: Operation) => unknown
    ): unknown {
      const parsed = next(raw, operation);
      if (!publishHostileJson) return parsed;
      hostileJsonReadsAtCoreBoundary = hostileJsonGetterReads;
      if (!Array.isArray(parsed)) return parsed;
      const first = parsed[0];
      if (!isRecord(first)) return parsed;
      const hostile = { version: 2 };
      Object.defineProperty(hostile, "version", {
        configurable: true,
        enumerable: true,
        get() {
          hostileJsonGetterReads += 1;
          return 2;
        },
      });
      Object.defineProperty(first, "payload", {
        configurable: true,
        enumerable: true,
        value: hostile,
        writable: true,
      });
      return parsed;
    },
  };
  rows: ProviderRow[] = [
    { id: "record-1", name: "old", payload: { nested: { version: 1 } } },
  ];
  readCalls = 0;
  failNextRead: unknown;
  private nextReadBarrier:
    | {
        readonly promise: Promise<void>;
        readonly started: () => void;
      }
    | undefined;

  constructor() {
    super("sqlite", "official-cache-swr-test");
    this.client = {};
  }

  holdNextRead(): { readonly started: Promise<void>; release(): void } {
    let markStarted = (): void => undefined;
    let release = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextReadBarrier = { promise, started: markStarted };
    return { started, release };
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
    if (!statement.trimStart().startsWith("SELECT")) {
      return { rows: [], rowCount: 0 };
    }
    this.readCalls += 1;
    const barrier = this.nextReadBarrier;
    this.nextReadBarrier = undefined;
    if (barrier !== undefined) {
      barrier.started();
      await barrier.promise;
    }
    if (this.failNextRead !== undefined) {
      const failure = this.failNextRead;
      this.failNextRead = undefined;
      throw failure;
    }
    const rows = this.rows.map((row) => ({ ...row }));
    return { rows: rows as T[], rowCount: rows.length };
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

class SwrCache extends CacheDriver {
  readonly entries = new Map<string, CacheEntry>();
  readonly gets: string[] = [];
  readonly sets: Array<{ readonly key: string; readonly storageTtl: number }> =
    [];
  readonly deletes: string[][] = [];
  failNextValueSet: unknown;
  failNextMarkerDelete: unknown;
  private nextMarkerReadBarrier:
    | {
        readonly promise: Promise<void>;
        readonly started: () => void;
      }
    | undefined;

  constructor(clock: ReturnType<typeof createTestClock>) {
    super("official-cache-swr-test", clock);
  }

  valueWrites(): Array<{ readonly key: string; readonly storageTtl: number }> {
    return this.sets.filter(({ key }) => !key.endsWith(":reval"));
  }

  holdNextMarkerRead(): { readonly started: Promise<void>; release(): void } {
    let markStarted = (): void => undefined;
    let release = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextMarkerReadBarrier = { promise, started: markStarted };
    return { started, release };
  }

  protected async get<T>(key: string): Promise<CacheEntry<T> | null> {
    this.gets.push(key);
    const markerBarrier = key.endsWith(":reval")
      ? this.nextMarkerReadBarrier
      : undefined;
    if (markerBarrier !== undefined) {
      this.nextMarkerReadBarrier = undefined;
      markerBarrier.started();
      await markerBarrier.promise;
    }
    return (this.entries.get(key) as CacheEntry<T> | undefined) ?? null;
  }

  protected async set<T>(
    key: string,
    storageTtl: number,
    entry: CacheEntry<T>
  ): Promise<void> {
    this.sets.push({ key, storageTtl });
    if (!key.endsWith(":reval") && this.failNextValueSet !== undefined) {
      const failure = this.failNextValueSet;
      this.failNextValueSet = undefined;
      throw failure;
    }
    this.entries.set(key, entry);
  }

  protected async delete(keys: string[]): Promise<void> {
    this.deletes.push([...keys]);
    if (
      keys.some((key) => key.endsWith(":reval")) &&
      this.failNextMarkerDelete !== undefined
    ) {
      const failure = this.failNextMarkerDelete;
      this.failNextMarkerDelete = undefined;
      throw failure;
    }
    for (const key of keys) this.entries.delete(key);
  }

  protected async clear(prefix: string): Promise<void> {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }
}

function createOfficialState(
  driver: SwrCache,
  version?: string | number
): {
  readonly extension: ReturnType<typeof cacheExtension>;
  readonly scheduled: Promise<unknown>[];
  readonly scheduleCalls: () => number;
  readonly settle: () => Promise<void>;
} {
  const scheduled: Promise<unknown>[] = [];
  let calls = 0;
  return {
    extension: cacheExtension({
      driver,
      version,
      waitUntil(promise) {
        calls += 1;
        scheduled.push(promise);
      },
    }),
    scheduled,
    scheduleCalls: () => calls,
    async settle(): Promise<void> {
      while (scheduled.length > 0) {
        await Promise.all(scheduled.splice(0));
      }
    },
  };
}

const clients: Array<{ $disconnect(): Promise<void> }> = [];

function trackClient<T extends { $disconnect(): Promise<void> }>(client: T): T {
  clients.push(client);
  return client;
}

function adoptUnknown(value: PromiseLike<unknown>): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    value.then(resolve, reject);
  });
}

afterEach(async () => {
  publishHostileJson = false;
  hostileJsonGetterReads = 0;
  hostileJsonReadsAtCoreBoundary = 0;
  for (const client of clients.splice(0)) await client.$disconnect();
});

describe("official cache stale-while-revalidate", () => {
  test("returns a detached stale value and replays only the inner core executor", async () => {
    const clock = createTestClock();
    const cache = new SwrCache(clock);
    const driver = new SwrDriver();
    const state = createOfficialState(cache, "inner-replay");
    let requestCalls = 0;
    let queryCalls = 0;
    const client = trackClient(
      createClient({ schema, driver })
        .$extends({
          name: "official-swr-request",
          request: {
            record: {
              findMany() {
                requestCalls += 1;
                return {};
              },
            },
          },
        })
        .$extends(state.extension)
        .$extends({
          name: "official-swr-query",
          query: {
            record: {
              async findMany({ proceed }) {
                const rows = await proceed();
                queryCalls += 1;
                for (const row of rows) {
                  if (!isRecord(row)) throw new Error("Expected a result row");
                  const name = Reflect.get(row, "name");
                  if (typeof name !== "string") {
                    throw new Error("Expected a result row name");
                  }
                  Reflect.set(row, "name", `${name}:outer-${queryCalls}`);
                }
                return rows;
              },
            },
          },
        })
    );
    const cached = client.$withCache({ key: "detached", ttl: 10, swr: true });

    const first = await cached.record.findMany();
    await state.settle();
    const scheduledBeforeStale = state.scheduleCalls();
    clock.advance(11);
    driver.rows = [
      {
        id: "record-1",
        name: "new",
        payload: { nested: { version: 2 } },
      },
    ];

    const stale = await cached.record.findMany();

    expect(first).toEqual([
      {
        id: "record-1",
        name: "old:outer-1",
        payload: { nested: { version: 1 } },
      },
    ]);
    expect(stale).toEqual([
      {
        id: "record-1",
        name: "old:outer-2",
        payload: { nested: { version: 1 } },
      },
    ]);
    expect(stale).not.toBe(first);
    const staleRow: unknown = Reflect.get(stale, "0");
    const firstRow: unknown = Reflect.get(first, "0");
    if (!(isRecord(staleRow) && isRecord(firstRow))) {
      throw new Error("Expected cached result rows");
    }
    expect(Reflect.get(staleRow, "payload")).not.toBe(
      Reflect.get(firstRow, "payload")
    );
    expect(state.scheduleCalls() - scheduledBeforeStale).toBe(1);
    await state.settle();
    expect(driver.readCalls).toBe(2);
    expect(queryCalls).toBe(2);
    expect(requestCalls).toBe(2);

    const refreshed = await cached.record.findMany();
    expect(refreshed).toEqual([
      {
        id: "record-1",
        name: "new:outer-3",
        payload: { nested: { version: 2 } },
      },
    ]);
    expect(refreshed).not.toBe(stale);
    const refreshedRow: unknown = Reflect.get(refreshed, "0");
    if (!isRecord(refreshedRow)) throw new Error("Expected a refreshed row");
    expect(Reflect.get(refreshedRow, "payload")).not.toBe(
      Reflect.get(staleRow, "payload")
    );
    expect(driver.readCalls).toBe(2);
    expect(queryCalls).toBe(3);
    expect(requestCalls).toBe(3);
  });

  test("keeps true and numeric stale windows and the exact chain scheduler", async () => {
    const clock = createTestClock();
    const cache = new SwrCache(clock);
    const driver = new SwrDriver();
    const firstState = createOfficialState(cache, "first");
    const secondState = createOfficialState(cache, "second");
    const first = trackClient(
      createClient({ schema, driver }).$extends(firstState.extension)
    );
    const second = trackClient(
      createClient({ schema, driver }).$extends(secondState.extension)
    );

    await first
      .$withCache({ key: "shared", ttl: 10, swr: true })
      .record.findMany();
    await first
      .$withCache({ key: "other", ttl: 10, swr: 40 })
      .record.findMany();
    await second
      .$withCache({ key: "shared", ttl: 10, swr: true })
      .record.findMany();
    await firstState.settle();
    await secondState.settle();

    expect(cache.valueWrites().map(({ storageTtl }) => storageTtl)).toEqual([
      20, 50, 20,
    ]);
    expect(new Set(cache.valueWrites().map(({ key }) => key)).size).toBe(3);

    const firstCalls = firstState.scheduleCalls();
    const secondCalls = secondState.scheduleCalls();
    clock.advance(11);
    await second
      .$withCache({ key: "shared", ttl: 10, swr: true })
      .record.findMany();
    expect(firstState.scheduleCalls()).toBe(firstCalls);
    expect(secondState.scheduleCalls()).toBe(secondCalls + 1);
    await secondState.settle();
  });

  test("hands claim acquisition to waitUntil before the stale response settles", async () => {
    const clock = createTestClock();
    const cache = new SwrCache(clock);
    const driver = new SwrDriver();
    const state = createOfficialState(cache, "claim-scheduler");
    const client = trackClient(
      createClient({ schema, driver }).$extends(state.extension)
    );
    const cached = client.$withCache({ ttl: 10, swr: 100 });

    await cached.record.findMany();
    await state.settle();
    clock.advance(11);
    const callsBeforeStale = state.scheduleCalls();
    const heldClaim = cache.holdNextMarkerRead();

    const stale = adoptUnknown(cached.record.findMany());
    await heldClaim.started;
    await expect(stale).resolves.toMatchObject([{ name: "old" }]);
    expect(state.scheduleCalls()).toBe(callsBeforeStale + 1);

    heldClaim.release();
    await state.settle();
  });

  test("suppresses a later stale replay after the shared marker is acquired", async () => {
    const clock = createTestClock();
    const cache = new SwrCache(clock);
    const driver = new SwrDriver();
    const state = createOfficialState(cache, "marker");
    const client = trackClient(
      createClient({ schema, driver }).$extends(state.extension)
    );
    const cached = client.$withCache({ ttl: 10, swr: 100 });

    await cached.record.findMany();
    await state.settle();
    clock.advance(11);
    driver.rows = [
      { id: "record-1", name: "new", payload: { nested: { version: 2 } } },
    ];
    const held = driver.holdNextRead();

    await expect(adoptUnknown(cached.record.findMany())).resolves.toMatchObject(
      [{ name: "old" }]
    );
    await held.started;
    await expect(adoptUnknown(cached.record.findMany())).resolves.toMatchObject(
      [{ name: "old" }]
    );
    held.release();
    await state.settle();

    expect(driver.readCalls).toBe(2);
    expect(
      cache.deletes.filter((keys) => keys[0]?.endsWith(":reval"))
    ).toHaveLength(1);
  });

  test("contains provider, snapshot, set, and cleanup failures", async () => {
    const scenarios = ["provider", "snapshot", "set", "cleanup"] as const;

    for (const scenario of scenarios) {
      const clock = createTestClock();
      const cache = new SwrCache(clock);
      const driver = new SwrDriver();
      const state = createOfficialState(cache, `failure-${scenario}`);
      const client = trackClient(
        createClient({ schema, driver }).$extends(state.extension)
      );
      const cached = client.$withCache({ ttl: 10, swr: 100 });

      await cached.record.findMany();
      await state.settle();
      clock.advance(11);
      driver.rows = [
        {
          id: "record-1",
          name: "new",
          payload: { nested: { version: 2 } },
        },
      ];
      if (scenario === "provider") {
        driver.failNextRead = new Error("background provider refused");
      } else if (scenario === "snapshot") {
        publishHostileJson = true;
      } else if (scenario === "set") {
        cache.failNextValueSet = new Error("background cache set refused");
      } else {
        cache.failNextMarkerDelete = new Error(
          "background marker cleanup refused"
        );
      }

      await expect(
        adoptUnknown(cached.record.findMany())
      ).resolves.toMatchObject([{ name: "old" }]);
      await expect(state.settle()).resolves.toBeUndefined();
      expect(state.scheduled).toEqual([]);
      if (scenario === "snapshot") {
        expect(hostileJsonReadsAtCoreBoundary).toBe(1);
        expect(hostileJsonGetterReads).toBe(hostileJsonReadsAtCoreBoundary);
        publishHostileJson = false;
        hostileJsonGetterReads = 0;
        hostileJsonReadsAtCoreBoundary = 0;
      }
    }
  });

  test("retains combined worker and cleanup failure for protected observation", async () => {
    const clock = createTestClock();
    const cache = new SwrCache(clock);
    const driver = new SwrDriver();
    const state = createOfficialState(cache, "observed-failure");
    const completions: Promise<ObserverCompletion>[] = [];
    const client = trackClient(
      createClient({ schema, driver })
        .$extends(state.extension)
        .$extends({
          name: "official-swr-observer",
          observe(unit, proceed) {
            if (unit.kind !== "cache" || unit.operation !== "revalidate") {
              return;
            }
            completions.push(proceed());
          },
        })
    );
    const cached = client.$withCache({ ttl: 10, swr: 100 });

    await cached.record.findMany();
    await state.settle();
    clock.advance(11);
    driver.failNextRead = new Error("background provider refused");
    cache.failNextMarkerDelete = new Error("background cleanup refused");

    await expect(adoptUnknown(cached.record.findMany())).resolves.toMatchObject(
      [{ name: "old" }]
    );
    await expect(state.settle()).resolves.toBeUndefined();
    await expect(Promise.all(completions)).resolves.toMatchObject([
      { status: "failure", error: { name: "Error" } },
    ]);
    expect(driver.readCalls).toBe(2);
    expect(cache.deletes.some((keys) => keys[0]?.endsWith(":reval"))).toBe(
      true
    );
  });

  test("keeps array and statement-transform executions outside official SWR", async () => {
    const clock = createTestClock();
    const arrayCache = new SwrCache(clock);
    const arrayDriver = new SwrDriver();
    const arrayState = createOfficialState(arrayCache, "array");
    const arrayClient = trackClient(
      createClient({ schema, driver: arrayDriver }).$extends(
        arrayState.extension
      )
    );
    const operation = arrayClient
      .$withCache({ ttl: 10, swr: true })
      .record.findMany();

    await expect(
      Reflect.apply(Reflect.get(arrayClient, "$transaction"), arrayClient, [
        [operation],
      ])
    ).resolves.toMatchObject([[{ id: "record-1" }]]);
    expect(arrayCache.gets).toEqual([]);
    expect(arrayCache.sets).toEqual([]);

    const statementCache = new SwrCache(clock);
    const statementDriver = new SwrDriver();
    const statementState = createOfficialState(statementCache, "statement");
    let transforms = 0;
    const statementClient = trackClient(
      createClient({ schema, driver: statementDriver })
        .$extends(statementState.extension)
        .$extends({
          name: "official-swr-statement",
          statement({ statement }) {
            transforms += 1;
            return statement;
          },
        })
    );
    const cached = statementClient.$withCache({ ttl: 10, swr: true });
    await cached.record.findMany();
    await cached.record.findMany();

    expect(transforms).toBe(2);
    expect(statementDriver.readCalls).toBe(2);
    expect(statementCache.gets).toEqual([]);
    expect(statementCache.sets).toEqual([]);
  });
});
