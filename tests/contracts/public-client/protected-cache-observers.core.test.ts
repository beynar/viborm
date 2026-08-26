import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { CacheDriver, type CacheEntry } from "@cache/driver";
import { cache as cacheExtension } from "@cache/extension";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { Driver } from "@drivers";
import { createClient, s } from "@src/index";
import { createTestClock } from "@tests/fixtures/test-clock";
import { readTestTransactionOperation } from "@tests/fixtures/transaction-operation";
import { afterEach, describe, expect, test } from "vitest";

const record = s.model({
  id: s.string().id(),
  name: s.string(),
});
const schema = { record };

function transactionContext(operation: unknown) {
  const capability = readTestTransactionOperation(operation);
  if (!capability) throw new Error("expected a transaction operation");
  return capability.context;
}

type Completion = Readonly<{
  status: "success" | "failure";
  commitCertainty?: "committed" | "may-have-committed";
  error?: Readonly<{ name: string; message: string; code?: string }>;
}>;

interface CacheObservation {
  readonly unit: Readonly<{
    kind: string;
    model?: string;
    operation?: string;
  }>;
  readonly completion: Promise<Completion>;
  summary?: Completion;
}

class CacheTestDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly timeline: string[];
  rows: Array<{ id: string; name: string }> = [{ id: "record-1", name: "Ada" }];
  failNextRead: unknown;

  constructor(timeline: string[] = []) {
    super("sqlite", "protected-cache-test");
    this.timeline = timeline;
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
    this.timeline.push("provider");
    if (statement.trimStart().startsWith("SELECT")) {
      if (this.failNextRead !== undefined) {
        const failure = this.failNextRead;
        this.failNextRead = undefined;
        throw failure;
      }
      return { rows: this.rows as T[], rowCount: this.rows.length };
    }
    return { rows: [], rowCount: 1 };
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

class ObservableCache extends CacheDriver {
  readonly timeline: string[];
  failGet: unknown;
  failSet: unknown;
  failDelete: unknown;
  failClear: unknown;
  private readonly entries = new Map<string, CacheEntry>();

  constructor(timeline: string[], clock: ReturnType<typeof createTestClock>) {
    super("protected-cache", clock);
    this.timeline = timeline;
  }

  protected async get<T>(key: string): Promise<CacheEntry<T> | null> {
    this.timeline.push("backend:get");
    if (this.failGet !== undefined) throw this.takeFailure("failGet");
    return (this.entries.get(key) as CacheEntry<T> | undefined) ?? null;
  }

  protected async set<T>(
    key: string,
    _storageTtl: number,
    entry: CacheEntry<T>
  ): Promise<void> {
    this.timeline.push("backend:set");
    if (this.failSet !== undefined) throw this.takeFailure("failSet");
    this.entries.set(key, entry);
  }

  protected async delete(keys: string[]): Promise<void> {
    this.timeline.push("backend:delete");
    if (this.failDelete !== undefined) throw this.takeFailure("failDelete");
    for (const key of keys) this.entries.delete(key);
  }

  protected async clear(prefix: string): Promise<void> {
    this.timeline.push("backend:clear");
    if (this.failClear !== undefined) throw this.takeFailure("failClear");
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  private takeFailure(
    property: "failGet" | "failSet" | "failDelete" | "failClear"
  ): unknown {
    const failure = this[property];
    this[property] = undefined;
    return failure;
  }
}

const clients: Array<{ $disconnect(): Promise<void> }> = [];

function createObservedCacheClient(options?: { hostile?: boolean }) {
  const clock = createTestClock();
  const timeline: string[] = [];
  const cache = new ObservableCache(timeline, clock);
  const driver = new CacheTestDriver(timeline);
  const background: Promise<unknown>[] = [];
  const observations: CacheObservation[] = [];
  const base = createClient({ schema, driver }).$extends(
    cacheExtension({
      driver: cache,
      waitUntil: (promise) => {
        background.push(promise);
      },
    })
  );
  const client = base.$extends({
    name: "protected-cache-observer",
    observe(unit, proceed) {
      if (unit.kind !== "cache") return;
      timeline.push(`observer:${unit.operation}:in`);
      const completion = proceed();
      const observation: CacheObservation = { unit, completion };
      observations.push(observation);
      completion.then((summary) => {
        observation.summary = summary;
        timeline.push(`observer:${unit.operation}:out:${summary.status}`);
      });
      if (options?.hostile) {
        Reflect.set(unit, "key", "stolen");
        return Promise.reject(new Error("hostile observer failure"));
      }
    },
  });
  clients.push(client);

  return {
    background,
    cache,
    client,
    clock,
    driver,
    observations,
    timeline,
  };
}

async function waitForCacheOperation(
  observations: readonly CacheObservation[],
  operation: string
): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    if (observations.some(({ unit }) => unit.operation === operation)) return;
    await Promise.resolve();
  }
  throw new Error(`Cache operation '${operation}' did not begin`);
}

async function settleBackground(background: Promise<unknown>[]): Promise<void> {
  while (background.length > 0) {
    await Promise.all(background.splice(0));
  }
  await Promise.resolve();
}

async function settleObservations(
  observations: readonly CacheObservation[]
): Promise<void> {
  await Promise.all(observations.map(({ completion }) => completion));
  await Promise.resolve();
}

function cacheOperations(observations: readonly CacheObservation[]): string[] {
  return observations.map(({ unit }) => unit.operation ?? "missing");
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

describe("public protected cache observers", () => {
  test("observes only get, set, and outer invalidate without disclosing cache state", async () => {
    const state = createObservedCacheClient({ hostile: true });

    await expect(
      state.client.$withCache({ key: "records" }).record.findMany()
    ).resolves.toEqual([{ id: "record-1", name: "Ada" }]);
    await settleBackground(state.background);
    await expect(
      state.client.$withCache({ key: "records" }).record.findMany()
    ).resolves.toEqual([{ id: "record-1", name: "Ada" }]);
    await state.client.$invalidate("records");
    await settleObservations(state.observations);

    expect(cacheOperations(state.observations)).toEqual([
      "get",
      "set",
      "get",
      "invalidate",
    ]);
    for (const observation of state.observations) {
      expect(observation.unit).toEqual({
        kind: "cache",
        operation: observation.unit.operation,
      });
      expect(Object.isFrozen(observation.unit)).toBe(true);
      expect(observation.summary).toMatchObject({ status: "success" });
      expect(observation.summary).not.toHaveProperty("commitCertainty");
      expect(observation.unit).not.toHaveProperty("key");
      expect(observation.unit).not.toHaveProperty("value");
      expect(observation.unit).not.toHaveProperty("provider");
    }
    expect(
      state.timeline.filter((event) => event === "backend:delete")
    ).toHaveLength(1);
  });

  test("contains get, background set, and invalidate failures without changing their owners", async () => {
    const state = createObservedCacheClient();
    const setFailure = new Error("cache set refused");
    state.cache.failSet = setFailure;

    await expect(
      state.client.$withCache({ key: "set-failure" }).record.findMany()
    ).resolves.toEqual([{ id: "record-1", name: "Ada" }]);
    await expect(Promise.all(state.background)).resolves.toBeDefined();
    await settleObservations(state.observations);
    expect(
      state.observations.find(({ unit }) => unit.operation === "set")?.summary
    ).toMatchObject({
      status: "failure",
    });

    const getFailure = new Error("cache get refused");
    state.cache.failGet = getFailure;
    await expect(
      state.client.$withCache({ key: "get-failure" }).record.findMany()
    ).rejects.toBe(getFailure);

    const invalidateFailure = new Error("cache delete refused");
    state.cache.failDelete = invalidateFailure;
    await expect(state.client.$invalidate("get-failure")).rejects.toBe(
      invalidateFailure
    );
    await settleObservations(state.observations);
    expect(
      state.observations
        .filter(({ summary }) => summary?.status === "failure")
        .map(({ unit }) => unit.operation)
    ).toEqual(["set", "get", "invalidate"]);
    expect(
      state.observations
        .filter(({ summary }) => summary?.status === "failure")
        .every(({ summary }) => summary?.commitCertainty === undefined)
    ).toBe(true);
  });

  test("observes actual SWR work around its nested set and keeps waitUntil swallowed", async () => {
    const state = createObservedCacheClient();
    await state.client
      .$withCache({ key: "swr", ttl: 10, swr: 100 })
      .record.findMany();
    await settleBackground(state.background);
    state.clock.advance(20);
    state.timeline.length = 0;
    state.observations.length = 0;

    state.driver.failNextRead = new Error("background provider failure");
    await expect(
      state.client
        .$withCache({ key: "swr", ttl: 10, swr: 100 })
        .record.findMany()
    ).resolves.toEqual([{ id: "record-1", name: "Ada" }]);
    await waitForCacheOperation(state.observations, "revalidate");
    await settleBackground(state.background);
    await settleObservations(state.observations);
    expect(cacheOperations(state.observations)).toEqual(["get", "revalidate"]);
    expect(state.observations[1]?.summary).toMatchObject({ status: "failure" });

    state.timeline.length = 0;
    state.observations.length = 0;
    state.driver.rows = [
      { id: "record-1", name: "Ada" },
      { id: "record-2", name: "Grace" },
    ];
    await state.client
      .$withCache({ key: "swr", ttl: 10, swr: 100 })
      .record.findMany();
    await waitForCacheOperation(state.observations, "revalidate");
    await settleBackground(state.background);
    await settleObservations(state.observations);

    expect(cacheOperations(state.observations)).toEqual([
      "get",
      "revalidate",
      "set",
    ]);
    expect(state.timeline.indexOf("observer:revalidate:in")).toBeLessThan(
      state.timeline.indexOf("provider")
    );
    expect(
      state.timeline.filter((event) => event === "backend:set")
    ).toHaveLength(2);
    expect(state.timeline.indexOf("observer:set:in")).toBeLessThan(
      state.timeline.lastIndexOf("backend:set")
    );
    expect(
      state.observations.every(({ summary }) => summary?.status === "success")
    ).toBe(true);
  });

  test("reports invisible SWR cleanup failure without rejecting background work", async () => {
    const state = createObservedCacheClient();
    await state.client
      .$withCache({ key: "cleanup", ttl: 10, swr: 100 })
      .record.findMany();
    await settleBackground(state.background);
    state.clock.advance(20);
    state.observations.length = 0;
    state.cache.failDelete = new Error("revalidation marker cleanup refused");

    await expect(
      state.client
        .$withCache({ key: "cleanup", ttl: 10, swr: 100 })
        .record.findMany()
    ).resolves.toEqual([{ id: "record-1", name: "Ada" }]);
    await waitForCacheOperation(state.observations, "revalidate");
    await settleBackground(state.background);
    await settleObservations(state.observations);

    expect(cacheOperations(state.observations)).toEqual([
      "get",
      "revalidate",
      "set",
    ]);
    expect(state.observations[1]?.summary).toMatchObject({
      status: "failure",
      error: { name: "Error" },
    });
    expect(state.observations[2]?.summary).toMatchObject({ status: "success" });
  });

  test("keeps worker failure primary when invisible SWR cleanup also fails", async () => {
    const state = createObservedCacheClient();
    await state.client
      .$withCache({ key: "dual", ttl: 10, swr: 100 })
      .record.findMany();
    await settleBackground(state.background);
    state.clock.advance(20);
    state.observations.length = 0;
    state.driver.failNextRead = new Error("revalidation worker refused");
    state.cache.failDelete = new Error("revalidation cleanup refused");

    await expect(
      state.client
        .$withCache({ key: "dual", ttl: 10, swr: 100 })
        .record.findMany()
    ).resolves.toEqual([{ id: "record-1", name: "Ada" }]);
    await waitForCacheOperation(state.observations, "revalidate");
    await settleBackground(state.background);
    await settleObservations(state.observations);

    expect(cacheOperations(state.observations)).toEqual(["get", "revalidate"]);
    expect(state.observations[1]?.summary).toMatchObject({
      status: "failure",
      error: { name: "Error" },
    });
  });

  test("accepts protected provenance only from the exact trusted execution context", async () => {
    const state = createObservedCacheClient();
    const trusted = transactionContext(state.client.record.findMany());

    await state.cache._get("trusted", trusted);
    await state.cache._get("copied", { ...trusted });
    await settleObservations(state.observations);

    expect(cacheOperations(state.observations)).toEqual(["get"]);
  });

  test("keeps the unobserved cache path operational without lifecycle units", async () => {
    const clock = createTestClock();
    const timeline: string[] = [];
    const cache = new ObservableCache(timeline, clock);
    const driver = new CacheTestDriver();
    const base = createClient({ schema, driver }).$extends(
      cacheExtension({ driver: cache })
    );
    clients.push(base);

    await expect(
      base.$withCache({ key: "base" }).record.findMany()
    ).resolves.toEqual([{ id: "record-1", name: "Ada" }]);
    expect(timeline).toEqual(["backend:get", "backend:set"]);
  });
});
