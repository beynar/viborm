import { MemoryCache } from "@cache/drivers/memory";
import { cache as cacheExtension } from "@cache/extension";
import { VibORM } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { instrumentation } from "@instrumentation/extension";
import { push } from "@migrations";
import { s } from "@schema";
import { createTestClock } from "@tests/fixtures/test-clock";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

// Test schema
const user = s.model({
  id: s.string().id(),
  name: s.string(),
  email: s.string().unique(),
});

const userProfile = s
  .model({
    id: s.string().id(),
    displayName: s.string(),
  })
  .map("cache_user_profile");

const schema = { user, userProfile };

// Test helpers
let pglite: PGlite;
let driver: PGliteDriver;

beforeAll(async () => {
  pglite = new PGlite();
  driver = new PGliteDriver({ client: pglite });

  // Use push() to create tables via the migration engine
  const tempClient = VibORM.create({ schema, driver });
  await push(tempClient, { force: true });
});

beforeEach(async () => {
  // Clean up data between tests
  await pglite.exec(`DELETE FROM "cache_user_profile"`);
  await pglite.exec(`DELETE FROM "user"`);
});

function createCachedClient(
  cacheDriver: MemoryCache,
  waitUntil?: (promise: Promise<unknown>) => void
) {
  return VibORM.create({ schema, driver }).$extends(
    cacheExtension({ driver: cacheDriver, waitUntil })
  );
}

/**
 * A client for the tests that turn on time passing.
 *
 * Three things a TTL test needs, none of which is a sleep:
 *
 * - `clock` — the cache's source of time. `advance(ms)` ages entries and fires
 *   the memory driver's eviction timers, so "the TTL passed" becomes a fact the
 *   test states rather than a duration it hopes was long enough.
 * - `settle()` — the cache writes on a miss in the background. `waitUntil` is
 *   the production hook for exactly that promise (it is what a Worker hands to
 *   `ctx.waitUntil`), and `setInBackground` schedules through it before the
 *   read returns, so draining it is enough to know the entry has landed.
 * - `nextRevalidation()` — SWR revalidation runs a real query. Snapshot it
 *   BEFORE the stale read that triggers it, await it after: the cache reports
 *   the revalidation finished, which is the event the old sleeps were guessing
 *   at.
 */
function cachedClient() {
  const clock = createTestClock();
  const background: Promise<unknown>[] = [];
  let finishedRevalidations = 0;
  const waiting: Array<{ target: number; resolve: () => void }> = [];

  const client = createCachedClient(new MemoryCache({ clock }), (promise) => {
    background.push(promise);
  }).$extends(
    instrumentation({
      logging: {
        cache: (event) => {
          const { event: name, status } = event.meta ?? {};
          // "start" opens a revalidation; anything else closes it.
          if (name !== "revalidate" || status === "start") return;
          finishedRevalidations += 1;
          for (const waiter of waiting.splice(0)) {
            if (finishedRevalidations >= waiter.target) waiter.resolve();
            else waiting.push(waiter);
          }
        },
      },
    })
  );

  return {
    client,
    clock,
    /** Drain every background cache write this client has scheduled. */
    settle: async () => {
      while (background.length > 0) {
        await Promise.all(background.splice(0));
      }
    },
    /** Take before the stale read; await after. */
    nextRevalidation: (): Promise<void> => {
      const target = finishedRevalidations + 1;
      return new Promise<void>((resolve) => {
        waiting.push({ target, resolve });
      });
    },
  };
}

describe("Cache", () => {
  describe("$withCache basic operations", () => {
    it("caches findMany results", async () => {
      const cache = new MemoryCache();
      const client = createCachedClient(cache);

      // Seed data
      await client.user.create({
        data: { id: "1", name: "Alice", email: "alice@test.com" },
      });

      // First call - cache miss
      const result1 = await client
        .$withCache({ key: "all-users" })
        .user.findMany();
      expect(result1).toHaveLength(1);

      // Add more data directly to DB (bypass ORM)
      await pglite.exec(
        `INSERT INTO "user" VALUES ('2', 'Bob', 'bob@test.com')`
      );

      // Second call - cache hit (should still return 1 user)
      const result2 = await client
        .$withCache({ key: "all-users" })
        .user.findMany();
      expect(result2).toHaveLength(1);

      // Without cache - should see both users
      const result3 = await client.user.findMany();
      expect(result3).toHaveLength(2);
    });

    it("caches findFirst results", async () => {
      const cache = new MemoryCache();
      const client = createCachedClient(cache);

      await client.user.create({
        data: { id: "1", name: "Alice", email: "alice@test.com" },
      });

      const result1 = await client
        .$withCache({ key: "first-user" })
        .user.findFirst();
      expect(result1?.name).toBe("Alice");

      // Update directly in DB
      await pglite.exec(`UPDATE "user" SET name = 'Updated' WHERE id = '1'`);

      // Cache hit - should still return "Alice"
      const result2 = await client
        .$withCache({ key: "first-user" })
        .user.findFirst();
      expect(result2?.name).toBe("Alice");
    });

    it("caches findUnique results", async () => {
      const cache = new MemoryCache();
      const client = createCachedClient(cache);

      await client.user.create({
        data: { id: "1", name: "Alice", email: "alice@test.com" },
      });

      const result1 = await client
        .$withCache({ key: "user-1" })
        .user.findUnique({ where: { id: "1" } });
      expect(result1?.name).toBe("Alice");

      // Update directly in DB
      await pglite.exec(`UPDATE "user" SET name = 'Updated' WHERE id = '1'`);

      // Cache hit
      const result2 = await client
        .$withCache({ key: "user-1" })
        .user.findUnique({ where: { id: "1" } });
      expect(result2?.name).toBe("Alice");
    });

    it("caches count results", async () => {
      const cache = new MemoryCache();
      const client = createCachedClient(cache);

      await client.user.create({
        data: { id: "1", name: "Alice", email: "alice@test.com" },
      });

      const count1 = await client
        .$withCache({ key: "user-count" })
        .user.count();
      expect(count1).toBe(1);

      // Add more data directly
      await pglite.exec(
        `INSERT INTO "user" VALUES ('2', 'Bob', 'bob@test.com')`
      );

      // Cache hit - should still return 1
      const count2 = await client
        .$withCache({ key: "user-count" })
        .user.count();
      expect(count2).toBe(1);
    });

    it("caches exist results", async () => {
      const cache = new MemoryCache();
      const client = createCachedClient(cache);

      await client.user.create({
        data: { id: "1", name: "Alice", email: "alice@test.com" },
      });

      const exists1 = await client
        .$withCache({ key: "user-exists" })
        .user.exist({ where: { id: "1" } });
      expect(exists1).toBe(true);

      // Delete directly
      await pglite.exec(`DELETE FROM "user" WHERE id = '1'`);

      // Cache hit - should still return true
      const exists2 = await client
        .$withCache({ key: "user-exists" })
        .user.exist({ where: { id: "1" } });
      expect(exists2).toBe(true);
    });
  });

  describe("TTL expiration", () => {
    it("expires cache after TTL", async () => {
      const { client, clock, settle } = cachedClient();

      await client.user.create({
        data: { id: "1", name: "Alice", email: "alice@test.com" },
      });

      // Cache with short TTL
      const result1 = await client
        .$withCache({ key: "short-ttl", ttl: 50 }) // 50ms
        .user.findMany();
      expect(result1).toHaveLength(1);
      await settle();

      // Add more data
      await pglite.exec(
        `INSERT INTO "user" VALUES ('2', 'Bob', 'bob@test.com')`
      );

      // Let the TTL expire
      clock.advance(100);

      // Should fetch fresh data (cache expired)
      const result2 = await client
        .$withCache({ key: "short-ttl", ttl: 50 })
        .user.findMany();
      expect(result2).toHaveLength(2);
    });

    it("parses string TTL correctly", async () => {
      const cache = new MemoryCache();
      const client = createCachedClient(cache);

      await client.user.create({
        data: { id: "1", name: "Alice", email: "alice@test.com" },
      });

      // Use string TTL
      const result = await client
        .$withCache({ key: "string-ttl", ttl: "1 hour" })
        .user.findMany();
      expect(result).toHaveLength(1);

      // Should be cached
      await pglite.exec(
        `INSERT INTO "user" VALUES ('2', 'Bob', 'bob@test.com')`
      );
      const result2 = await client
        .$withCache({ key: "string-ttl", ttl: "1 hour" })
        .user.findMany();
      expect(result2).toHaveLength(1);
    });
  });

  describe("SWR (stale-while-revalidate)", () => {
    it("swr: true defaults to 2x TTL for stale window", async () => {
      const { client, clock, settle, nextRevalidation } = cachedClient();

      await client.user.create({
        data: { id: "1", name: "Alice", email: "alice@test.com" },
      });

      // Cache with ttl: 30ms, swr: true should use 60ms (2x) as storage TTL
      await client
        .$withCache({ key: "swr-default-ttl", ttl: 30, swr: true })
        .user.findMany();
      await settle();

      // Move past TTL (30ms) but within 2x TTL (60ms) - data should still be in storage
      clock.advance(40);

      // Add more data
      await pglite.exec(
        `INSERT INTO "user" VALUES ('swr-default-1', 'DefaultBob', 'defaultbob@test.com')`
      );

      // Should return stale data (SWR serves from storage)
      const revalidated = nextRevalidation();
      const staleResult = await client
        .$withCache({ key: "swr-default-ttl", ttl: 30, swr: true })
        .user.findMany();
      expect(staleResult).toHaveLength(1);

      // Cleanup — after the revalidation this read kicked off has read the row
      // it is about to delete.
      await revalidated;
      await pglite.exec(`DELETE FROM "user" WHERE id = 'swr-default-1'`);
    });

    it("swr: false disables stale-while-revalidate", async () => {
      const { client, clock, settle } = cachedClient();

      await client.user.create({
        data: { id: "1", name: "Alice", email: "alice@test.com" },
      });

      // Cache with swr: false
      await client
        .$withCache({ key: "swr-disabled", ttl: 30, swr: false })
        .user.findMany();
      await settle();

      // Move past TTL
      clock.advance(50);

      // Add more data
      await pglite.exec(
        `INSERT INTO "user" VALUES ('swr-disabled-1', 'DisabledBob', 'disabledbob@test.com')`
      );

      // With SWR disabled, stale data should NOT be returned - fresh fetch happens
      const result = await client
        .$withCache({ key: "swr-disabled", ttl: 30, swr: false })
        .user.findMany();
      expect(result).toHaveLength(2); // Gets fresh data, not stale

      // Cleanup
      await pglite.exec(`DELETE FROM "user" WHERE id = 'swr-disabled-1'`);
    });

    it("accepts custom SWR TTL as number", async () => {
      const { client, clock, settle, nextRevalidation } = cachedClient();

      await client.user.create({
        data: { id: "1", name: "Alice", email: "alice@test.com" },
      });

      // Initial cache with ttl: 30ms and custom swr: 100ms (instead of default 60ms)
      await client
        .$withCache({ key: "swr-custom-ttl", ttl: 30, swr: 100 })
        .user.findMany();
      await settle();

      // Age the entry past its 30ms TTL, into the stale window
      clock.advance(50);

      // Add more data AFTER cache is stale
      await pglite.exec(
        `INSERT INTO "user" VALUES ('swr-custom-1', 'Bob', 'bob-custom@test.com')`
      );

      // Should return stale data immediately (SWR pattern)
      const revalidated = nextRevalidation();
      const staleResult = await client
        .$withCache({ key: "swr-custom-ttl", ttl: 30, swr: 100 })
        .user.findMany();
      expect(staleResult).toHaveLength(1);

      // Wait for background revalidation
      await revalidated;

      // Now should have fresh data
      const freshResult = await client
        .$withCache({ key: "swr-custom-ttl", ttl: 30, swr: 100 })
        .user.findMany();
      expect(freshResult).toHaveLength(2);

      // Cleanup
      await pglite.exec(`DELETE FROM "user" WHERE id = 'swr-custom-1'`);
    });

    it("accepts custom SWR TTL as string", async () => {
      const { client, clock, settle, nextRevalidation } = cachedClient();

      await client.user.create({
        data: { id: "1", name: "Alice", email: "alice@test.com" },
      });

      // Initial cache with string TTL for swr
      await client
        .$withCache({ key: "swr-string-ttl", ttl: 30, swr: "200ms" })
        .user.findMany();
      await settle();

      // Age the entry until it is stale
      clock.advance(50);

      // Add more data
      await pglite.exec(
        `INSERT INTO "user" VALUES ('swr-string-1', 'Charlie', 'charlie@test.com')`
      );

      // Should return stale data
      const revalidated = nextRevalidation();
      const staleResult = await client
        .$withCache({ key: "swr-string-ttl", ttl: 30, swr: "200ms" })
        .user.findMany();
      expect(staleResult).toHaveLength(1);

      // Wait for revalidation
      await revalidated;

      const freshResult = await client
        .$withCache({ key: "swr-string-ttl", ttl: 30, swr: "200ms" })
        .user.findMany();
      expect(freshResult).toHaveLength(2);

      // Cleanup
      await pglite.exec(`DELETE FROM "user" WHERE id = 'swr-string-1'`);
    });

    it("returns stale data and revalidates in background", async () => {
      const { client, clock, settle, nextRevalidation } = cachedClient();

      await client.user.create({
        data: { id: "1", name: "Alice", email: "alice@test.com" },
      });

      // Initial cache with short TTL
      await client
        .$withCache({ key: "swr-test", ttl: 30, swr: true })
        .user.findMany();
      await settle();

      // Age the entry until it is stale (but not expired from storage - 2x TTL)
      clock.advance(50);

      // Add more data AFTER cache is stale
      await pglite.exec(
        `INSERT INTO "user" VALUES ('2', 'Bob', 'bob@test.com')`
      );

      // Should return stale data immediately (SWR pattern)
      const revalidated = nextRevalidation();
      const staleResult = await client
        .$withCache({ key: "swr-test", ttl: 30, swr: true })
        .user.findMany();
      expect(staleResult).toHaveLength(1); // Stale data returned immediately

      // Wait for background revalidation to complete
      await revalidated;

      // Now should have fresh data (revalidation completed)
      const freshResult = await client
        .$withCache({ key: "swr-test", ttl: 30, swr: true })
        .user.findMany();
      expect(freshResult).toHaveLength(2); // Fresh data
    });
  });

  describe("bypass option", () => {
    it("bypasses cache read but still writes to cache", async () => {
      const cache = new MemoryCache();
      const client = createCachedClient(cache);

      await client.user.create({
        data: { id: "1", name: "Alice", email: "alice@test.com" },
      });

      // Initial cache
      await client.$withCache({ key: "bypass-test" }).user.findMany();

      // Add more data
      await pglite.exec(
        `INSERT INTO "user" VALUES ('2', 'Bob', 'bob@test.com')`
      );

      // Bypass should get fresh data
      const bypassResult = await client
        .$withCache({ key: "bypass-test", bypass: true })
        .user.findMany();
      expect(bypassResult).toHaveLength(2);

      // Cache should now have fresh data
      const cachedResult = await client
        .$withCache({ key: "bypass-test" })
        .user.findMany();
      expect(cachedResult).toHaveLength(2);
    });
  });

  describe("auto-generated cache keys", () => {
    it("generates different keys for different queries", async () => {
      const cache = new MemoryCache();
      const client = createCachedClient(cache);

      await client.user.create({
        data: { id: "1", name: "Alice", email: "alice@test.com" },
      });
      await client.user.create({
        data: { id: "2", name: "Bob", email: "bob@test.com" },
      });

      // Different where clauses should have different cache keys
      const result1 = await client
        .$withCache()
        .user.findMany({ where: { name: "Alice" } });
      expect(result1).toHaveLength(1);

      const result2 = await client
        .$withCache()
        .user.findMany({ where: { name: "Bob" } });
      expect(result2).toHaveLength(1);

      // Verify they're actually different (not sharing cache)
      expect(result1[0]?.name).toBe("Alice");
      expect(result2[0]?.name).toBe("Bob");
    });
  });

  describe("cache invalidation", () => {
    it("auto-invalidates the exact model without clearing a delimiter sibling", async () => {
      const { client, settle } = cachedClient();

      await client.user.create({
        data: { id: "1", name: "Alice", email: "alice@test.com" },
      });
      await client.userProfile.create({
        data: { id: "profile-1", displayName: "Alice" },
      });

      const readUsers = () =>
        client
          .$withCache({ key: "tenant-a" })
          .user.findMany({ orderBy: { id: "asc" } });
      const readProfiles = () =>
        client
          .$withCache({ key: "tenant-a" })
          .userProfile.findMany({ orderBy: { id: "asc" } });

      expect(await readUsers()).toHaveLength(1);
      expect(await readProfiles()).toHaveLength(1);
      await settle();

      await pglite.exec(
        `INSERT INTO "cache_user_profile" ("id", "displayName") VALUES ('profile-2', 'Bob')`
      );
      expect(await client.userProfile.findMany()).toHaveLength(2);

      await client.user.create({
        data: { id: "2", name: "Bob", email: "bob@test.com" },
        cache: { autoInvalidate: true },
      });

      // The exact warmed user operation is fresh. The neighboring
      // `userProfile` model remains warm: model invalidation owns `user:`, not
      // the raw string prefix `user`.
      expect(await readUsers()).toHaveLength(2);
      expect(await readProfiles()).toHaveLength(1);
    });

    it("invalidates every cached operation under a model prefix", async () => {
      const { client, settle } = cachedClient();

      await client.user.create({
        data: { id: "1", name: "Alice", email: "alice@test.com" },
      });

      const readUsers = () =>
        client
          .$withCache({ key: "manual-model" })
          .user.findMany({ orderBy: { id: "asc" } });
      const readCount = () =>
        client.$withCache({ key: "manual-model" }).user.count();

      expect(await readUsers()).toHaveLength(1);
      expect(await readCount()).toBe(1);
      await settle();

      await pglite.exec(
        `INSERT INTO "user" VALUES ('2', 'Bob', 'bob@test.com')`
      );

      // Both exact warmed reads are stale before invalidation.
      expect(await readUsers()).toHaveLength(1);
      expect(await readCount()).toBe(1);

      await client.$invalidate("user:*");

      expect(await readUsers()).toHaveLength(2);
      expect(await readCount()).toBe(2);
    });
  });

  describe("error handling", () => {
    it("throws on non-cacheable operations", async () => {
      const cache = new MemoryCache();
      const client = createCachedClient(cache);

      const cachedClient = client.$withCache();

      const cachedUser = cachedClient.user as unknown as {
        create(args: {
          data: { id: string; name: string; email: string };
        }): Promise<unknown>;
      };

      await expect(
        cachedUser.create({
          data: { id: "1", name: "Test", email: "test@test.com" },
        })
      ).rejects.toThrow();
    });

    it("throws on invalid cache options", () => {
      const cache = new MemoryCache();
      const client = createCachedClient(cache);

      expect(() => client.$withCache({ ttl: {} as unknown as string })).toThrow(
        "Invalid cache options"
      );

      expect(() => client.$withCache({ swr: "yes" })).toThrow(
        "Invalid TTL format"
      );
    });
  });

  describe("OrThrow variants", () => {
    it("caches findUniqueOrThrow results", async () => {
      const cache = new MemoryCache();
      const client = createCachedClient(cache);

      await client.user.create({
        data: { id: "1", name: "Alice", email: "alice@test.com" },
      });

      const result1 = await client
        .$withCache({ key: "user-or-throw" })
        .user.findUniqueOrThrow({ where: { id: "1" } });
      expect(result1.name).toBe("Alice");

      // Update directly
      await pglite.exec(`UPDATE "user" SET name = 'Updated' WHERE id = '1'`);

      // Cache hit
      const result2 = await client
        .$withCache({ key: "user-or-throw" })
        .user.findUniqueOrThrow({ where: { id: "1" } });
      expect(result2.name).toBe("Alice");
    });

    it("throws NotFoundError for findUniqueOrThrow cache miss with no result", async () => {
      const cache = new MemoryCache();
      const client = createCachedClient(cache);

      await expect(
        client
          .$withCache({ key: "not-found" })
          .user.findUniqueOrThrow({ where: { id: "nonexistent" } })
      ).rejects.toThrow();
    });
  });
});
