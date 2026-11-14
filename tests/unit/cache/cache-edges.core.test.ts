/**
 * The official cache at its edges: what passes through it untouched, what
 * its read view refuses, how an invalidation that fails is said, a fill
 * that loses a race with an invalidation, keys it reserves, and the memory
 * backend's sweep of expired entries.
 */

import type { CacheDriver, CacheEntry } from "@cache/driver";
import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import type { QueryResult } from "@drivers";
import {
  CacheConfigurationError,
  CacheInvalidKeyError,
  CacheOperationNotCacheableError,
} from "@errors";
import { createClient, s } from "@src/index";
import { ClockedMemoryCache } from "@tests/fixtures/clocked-memory-cache";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { createTestClock } from "@tests/fixtures/test-clock";
import { afterEach, describe, expect, it, vi } from "vitest";

const item = s.model({ id: s.string().id(), name: s.string() });
const schema = { item };

/** Answers every statement with `rows`; a statement may be held until released. */
class RowsDriver extends PlanningDriver {
  sent = 0;
  rows: Record<string, unknown>[] = [{ id: "i1", name: "one" }];
  hold: Promise<void> | undefined;
  constructor() {
    super("postgresql");
  }
  protected override async execute<T>(): Promise<QueryResult<T>> {
    this.sent += 1;
    const rows = this.rows;
    if (this.hold) await this.hold;
    return { rows: rows as T[], rowCount: rows.length };
  }
}

/** A clocked backend that records every value it is asked to store. */
class RecordingCache extends ClockedMemoryCache {
  readonly stored: unknown[] = [];
  protected override async set<T>(
    key: string,
    storageTtl: number,
    entry: CacheEntry<T>
  ): Promise<void> {
    this.stored.push(entry.value);
    await super.set(key, storageTtl, entry);
  }
}

/** A backend whose deletions and clears fail with `failure`. */
class FailingCache extends MemoryCache {
  failure: unknown;
  protected override async delete(keys: string[]): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    await super.delete(keys);
  }
  protected override async clear(prefix: string): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    await super.clear(prefix);
  }
}

type Row = Record<string, unknown>;
interface Delegate {
  findMany(args?: object): Promise<Row[]>;
  create(args: object): Promise<Row>;
}
interface Cached {
  item: Delegate;
  $withCache(options?: object): { item: Delegate };
  $invalidate(...keys: string[]): Promise<void>;
  $disconnect(): Promise<void>;
}

const opened: Cached[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const client of opened.splice(0)) await client.$disconnect();
});

function cached(
  driver: RowsDriver,
  store: CacheDriver = new MemoryCache()
): Cached {
  const client = createClient({ schema, driver }).$extends(
    cache({ driver: store })
  ) as never as Cached;
  opened.push(client);
  return client;
}

/** Lets the background set of a miss land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("what the cache leaves alone", () => {
  it("a read outside the view and a write with no invalidation run as they would", async () => {
    const driver = new RowsDriver();
    const db = cached(driver);
    await db.item.findMany({});
    await db.item.findMany({});
    expect(driver.sent).toBe(2);
    await db.item.create({ data: { id: "i2", name: "two" } });
    expect(driver.sent).toBe(3);
  });

  it("the read view refuses a write", async () => {
    const driver = new RowsDriver();
    const db = cached(driver);
    await expect(
      db.$withCache().item.create({ data: { id: "i2", name: "two" } })
    ).rejects.toThrow(CacheOperationNotCacheableError);
    expect(driver.sent).toBe(0);
  });
});

describe("an invalidation that fails", () => {
  it("after a write, is the cache's error, with the commit certainty", async () => {
    const store = new FailingCache();
    const db = cached(new RowsDriver(), store);
    store.failure = new Error("backend down");
    const failed = await db.item
      .create({
        data: { id: "i2", name: "two" },
        cache: { invalidate: ["item"] },
      })
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(CacheConfigurationError);
    // The backend's error is carried, its details redacted.
    expect((failed as CacheConfigurationError).cause).toBeInstanceOf(Error);
    expect((failed as CacheConfigurationError).meta).toMatchObject({
      method: "invalidate",
      operation: "create",
      commitCertainty: "committed",
    });
    // A backend that throws something other than an Error carries no cause.
    store.failure = "down";
    const bare = await db.item
      .create({
        data: { id: "i3", name: "three" },
        cache: { invalidate: ["item"] },
      })
      .catch((error: unknown) => error);
    expect(bare).toBeInstanceOf(CacheConfigurationError);
    expect((bare as Error).cause).toBeUndefined();
  });

  it("through $invalidate, is the cache's error; a refused key is said as it is", async () => {
    const store = new FailingCache();
    const db = cached(new RowsDriver(), store);
    store.failure = new Error("backend down");
    const failed = await db
      .$invalidate("item")
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(CacheConfigurationError);
    expect((failed as Error).message).toBe("Cache invalidation failed.");
    expect((failed as Error).cause).toBeInstanceOf(Error);
    store.failure = 7;
    const bare = await db.$invalidate("item").catch((error: unknown) => error);
    expect((bare as Error).cause).toBeUndefined();
    store.failure = undefined;
    await expect(db.$invalidate("viborm:item")).rejects.toThrow(
      CacheInvalidKeyError
    );
  });

  it("$invalidate with no key touches nothing", async () => {
    const store = new FailingCache();
    const db = cached(new RowsDriver(), store);
    store.failure = new Error("must not be reached");
    await expect(db.$invalidate()).resolves.toBeUndefined();
  });
});

describe("a fill and an invalidation", () => {
  it("a read that started before an invalidation does not store what it read", async () => {
    const driver = new RowsDriver();
    const db = cached(driver);
    let release = () => undefined as void;
    driver.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A call runs once it is awaited: `then` starts it.
    const first = db
      .$withCache()
      .item.findMany({})
      .then((rows) => rows);
    await vi.waitFor(() => expect(driver.sent).toBe(1));
    // The rows change and the cache is told before the first read lands.
    driver.rows = [{ id: "i1", name: "renamed" }];
    await db.$invalidate("*");
    driver.hold = undefined;
    release();
    expect(await first).toEqual([{ id: "i1", name: "one" }]);
    await settle();
    expect(await db.$withCache().item.findMany({})).toEqual([
      { id: "i1", name: "renamed" },
    ]);
    expect(driver.sent).toBe(2);
  });
});

describe("a revalidation and an invalidation", () => {
  it("a stale entry's refresh that an invalidation overtakes is not stored", async () => {
    const clock = createTestClock();
    const driver = new RowsDriver();
    const store = new RecordingCache(clock);
    const db = cached(driver, store);
    const view = db.$withCache({ ttl: 10, swr: 100 });
    await view.item.findMany({});
    await settle();
    clock.advance(11);
    let release = () => undefined as void;
    driver.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    driver.rows = [{ id: "i1", name: "refreshed" }];
    // The stale entry is served; its refresh reads, held.
    expect(await view.item.findMany({})).toEqual([{ id: "i1", name: "one" }]);
    await vi.waitFor(() => expect(driver.sent).toBe(2));
    await db.$invalidate("*");
    driver.rows = [{ id: "i1", name: "fresh" }];
    driver.hold = undefined;
    release();
    await settle();
    // The refresh read before the invalidation is never written.
    expect(JSON.stringify(store.stored)).not.toContain("refreshed");
    expect(await view.item.findMany({})).toEqual([{ id: "i1", name: "fresh" }]);
  });
});

describe("the memory backend", () => {
  it("sweeps an expired entry, so a live one keeps its place within the bound", async () => {
    vi.useFakeTimers();
    const driver = new RowsDriver();
    const db = cached(driver, new MemoryCache({ maxEntries: 2 }));
    // The live entry first, then one that expires within the sweep's minute.
    await db
      .$withCache({ ttl: "10m" })
      .item.findMany({ where: { id: "live" } });
    await db
      .$withCache({ ttl: "1s" })
      .item.findMany({ where: { id: "brief" } });
    await vi.advanceTimersByTimeAsync(61_000);
    // A third entry: without the sweep, the bound would evict the live one.
    await db.$withCache({ ttl: "10m" }).item.findMany({ where: { id: "new" } });
    const sent = driver.sent;
    await db
      .$withCache({ ttl: "10m" })
      .item.findMany({ where: { id: "live" } });
    expect(driver.sent).toBe(sent);
  });
});
