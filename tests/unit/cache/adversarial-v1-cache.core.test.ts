import {
  type CacheEntry,
  createOfficialCacheScope,
  executeCachedWithResultCodec,
  invalidateOfficialCache,
} from "@cache/driver";
import { MemoryCache } from "@cache/drivers/memory";
import { parseTTL } from "@cache/ttl";
import type { Clock } from "@src/clock";
import { createTestClock } from "@tests/fixtures/test-clock";
import { describe, expect, it } from "vitest";

class ClockedMemory extends MemoryCache {
  protected override readonly clock: Clock;
  constructor(clock: Clock, maxEntries = 1024) {
    super({ maxEntries });
    this.clock = clock;
  }
}
class AliasedMemory extends ClockedMemory {
  alias?: string;
  protected override async set<T>(
    key: string,
    ttl: number,
    entry: CacheEntry<T>
  ): Promise<void> {
    this.alias ??= key;
    await super.set(key, ttl, entry);
  }
  protected override get<T>(key: string): Promise<CacheEntry<T> | null> {
    return super.get<T>(this.alias ?? key);
  }
}
const codec = {
  snapshot: (value: number) => value,
  materialize(value: unknown): number {
    if (typeof value !== "number") throw new Error("bad snapshot");
    return value;
  },
};
function reader(
  cache: MemoryCache,
  pending: Promise<unknown>[],
  swr: number | false = false
) {
  const scope = createOfficialCacheScope("viborm:cache:adversarial");
  return {
    scope,
    read: (args: unknown, execute: () => Promise<number>) =>
      executeCachedWithResultCodec(
        cache,
        "post",
        "count",
        args,
        execute,
        { ttlMs: 10, swr, bypass: false, waitUntil: (p) => pending.push(p) },
        codec,
        scope
      ),
  };
}

describe("adversarial cache boundaries", () => {
  it("bounds memory by LRU entries and owns only one sweep timer", async () => {
    const clock = createTestClock();
    const cache = new ClockedMemory(clock, 2);
    await cache._set("a", 1, { ttl: 3_000_000_000 });
    await cache._set("b", 2, { ttl: 3_000_000_000 });
    expect(clock.pendingCount()).toBe(1);
    expect((await cache._get("a"))?.value).toBe(1);
    await cache._set("c", 3, { ttl: 3_000_000_000 });
    expect(await cache._get("b")).toBeNull();
    expect((await cache._get("c"))?.value).toBe(3);
    clock.advance(60_000);
    expect(clock.pendingCount()).toBe(1);
    await cache.disconnect();
    expect(clock.pendingCount()).toBe(0);
  });
  it("rejects aliased hash lookups by exact identity", async () => {
    const cache = new AliasedMemory(createTestClock());
    const pending: Promise<unknown>[] = [];
    const { read } = reader(cache, pending);
    expect(await read({ where: { id: 1 } }, async () => 11)).toBe(11);
    await Promise.all(pending.splice(0));
    expect(await read({ where: { id: 2 } }, async () => 22)).toBe(22);
    await Promise.all(pending.splice(0));
    await cache.disconnect();
  });
  it("does not serve a stale entry beyond the logical storage window", async () => {
    const clock = createTestClock();
    const pending: Promise<unknown>[] = [];
    // This backend intentionally retains data beyond storage TTL, as KV's minimum TTL does.
    class RetainedMemory extends ClockedMemory {
      protected override set<T>(
        key: string,
        _ttl: number,
        entry: CacheEntry<T>
      ): Promise<void> {
        return super.set(key, 60_000, entry);
      }
    }
    const cache = new RetainedMemory(clock);
    const { read } = reader(cache, pending, 20);
    await read({}, async () => 1);
    await Promise.all(pending.splice(0));
    clock.advance(21);
    expect(await read({}, async () => 2)).toBe(2);
    await Promise.all(pending.splice(0));
    await cache.disconnect();
  });
  it("suppresses a query fill begun before durable invalidation", async () => {
    const cache = new ClockedMemory(createTestClock());
    const pending: Promise<unknown>[] = [];
    const { scope, read } = reader(cache, pending);
    let resolve!: (value: number) => void;
    let started!: () => void;
    const begun = new Promise<void>((r) => {
      started = r;
    });
    const old = read(
      {},
      () =>
        new Promise<number>((r) => {
          resolve = r;
          started();
        })
    );
    await begun;
    await invalidateOfficialCache(cache, "other", undefined, undefined, scope);
    resolve(1);
    expect(await old).toBe(1);
    await Promise.all(pending.splice(0));
    expect(await read({}, async () => 2)).toBe(2);
    await Promise.all(pending.splice(0));
    await cache.disconnect();
  });
  it("cleans a backend fill that finishes after invalidation", async () => {
    const clock = createTestClock();
    const pending: Promise<unknown>[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let announce!: () => void;
    const started = new Promise<void>((r) => {
      announce = r;
    });
    class PausedMemory extends ClockedMemory {
      first = true;
      protected override async set<T>(
        key: string,
        ttl: number,
        entry: CacheEntry<T>
      ): Promise<void> {
        if (this.first) {
          this.first = false;
          announce();
          await gate;
        }
        await super.set(key, ttl, entry);
      }
    }
    const cache = new PausedMemory(clock);
    const { scope, read } = reader(cache, pending);
    expect(await read({}, async () => 1)).toBe(1);
    await started;
    await invalidateOfficialCache(cache, "post", undefined, undefined, scope);
    release();
    await Promise.all(pending.splice(0));
    expect(await read({}, async () => 2)).toBe(2);
    await Promise.all(pending.splice(0));
    await cache.disconnect();
  });
  it("expires retained revalidation markers by their own age", async () => {
    const clock = createTestClock();
    class RetainedMemory extends ClockedMemory {
      protected override set<T>(
        key: string,
        _ttl: number,
        entry: CacheEntry<T>
      ): Promise<void> {
        return super.set(key, 60_000, entry);
      }
    }
    const cache = new RetainedMemory(clock);
    expect(await cache._markRevalidating("row")).toBe(true);
    expect(await cache._markRevalidating("row")).toBe(false);
    clock.advance(30_001);
    expect(await cache._markRevalidating("row")).toBe(true);
    await cache.disconnect();
  });
  it("defaults durable invalidation to the complete bound scope", async () => {
    const cache = new ClockedMemory(createTestClock());
    const pending: Promise<unknown>[] = [];
    const { scope, read } = reader(cache, pending);
    await read({}, async () => 1);
    await Promise.all(pending.splice(0));
    await invalidateOfficialCache(
      cache,
      "relatedModel",
      undefined,
      undefined,
      scope
    );
    expect(await read({}, async () => 2)).toBe(2);
    await Promise.all(pending.splice(0));
    await cache.disconnect();
  });
  it("refuses non-finite and overflowing TTL", () => {
    expect(() => parseTTL(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => parseTTL("999999999999999999days")).toThrow();
  });
  it("keys the maxEntries option through non-fresh public construction", () => {
    const good = { maxEntries: 2 };
    new MemoryCache(good);
    const bad = { maxEntries: 2, maxEntires: 3 };
    const probe = () => {
      // @ts-expect-error a typo beside the real key is structurally refused
      new MemoryCache(bad);
    };
    expect(probe).toBeTypeOf("function");
  });
});
