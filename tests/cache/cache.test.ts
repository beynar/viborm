import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryCache } from "@cache/drivers/memory";
import { PGlite } from "@electric-sql/pglite";
import { VibORM, type VibORMClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";

// Test schema
const user = s.model({
  id: s.string().id(),
  name: s.string(),
  email: s.string().unique(),
});

const schema = { user };

// Test helpers
let pglite: PGlite;
let driver: PGliteDriver;

beforeAll(async () => {
  pglite = new PGlite();
  driver = new PGliteDriver({ client: pglite });

  await pglite.exec(`
    CREATE TABLE IF NOT EXISTS "user" (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE
    )
  `);
});

beforeEach(async () => {
  // Clean up data between tests
  await pglite.exec(`DELETE FROM "user"`);
});

describe("Cache", () => {
  describe("$withCache basic operations", () => {
    it("caches findMany results", async () => {
      const cache = new MemoryCache();
      const client = VibORM.create({
        schema,
        driver,
        cache,
      });

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
      await pglite.exec(`INSERT INTO "user" VALUES ('2', 'Bob', 'bob@test.com')`);

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
      const client = VibORM.create({
        schema,
        driver,
        cache,
      });

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
      const client = VibORM.create({
        schema,
        driver,
        cache,
      });

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
      const client = VibORM.create({
        schema,
        driver,
        cache,
      });

      await client.user.create({
        data: { id: "1", name: "Alice", email: "alice@test.com" },
      });

      const count1 = await client.$withCache({ key: "user-count" }).user.count();
      expect(count1).toBe(1);

      // Add more data directly
      await pglite.exec(`INSERT INTO "user" VALUES ('2', 'Bob', 'bob@test.com')`);

      // Cache hit - should still return 1
      const count2 = await client.$withCache({ key: "user-count" }).user.count();
      expect(count2).toBe(1);
    });

    it("caches exist results", async () => {
      const cache = new MemoryCache();
      const client = VibORM.create({
        schema,
        driver,
        cache,
      });

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
      const cache = new MemoryCache();
      const client = VibORM.create({
        schema,
        driver,
        cache,
      });

      await client.user.create({
        data: { id: "1", name: "Alice", email: "alice@test.com" },
      });

      // Cache with short TTL
      const result1 = await client
        .$withCache({ key: "short-ttl", ttl: 50 }) // 50ms
        .user.findMany();
      expect(result1).toHaveLength(1);

      // Add more data
      await pglite.exec(`INSERT INTO "user" VALUES ('2', 'Bob', 'bob@test.com')`);

      // Wait for TTL to expire
      await new Promise((r) => setTimeout(r, 100));

      // Should fetch fresh data (cache expired)
      const result2 = await client
        .$withCache({ key: "short-ttl", ttl: 50 })
        .user.findMany();
      expect(result2).toHaveLength(2);
    });

    it("parses string TTL correctly", async () => {
      const cache = new MemoryCache();
      const client = VibORM.create({
        schema,
        driver,
        cache,
      });

      await client.user.create({
        data: { id: "1", name: "Alice", email: "alice@test.com" },
      });

      // Use string TTL
      const result = await client
        .$withCache({ key: "string-ttl", ttl: "1 hour" })
        .user.findMany();
      expect(result).toHaveLength(1);

      // Should be cached
      await pglite.exec(`INSERT INTO "user" VALUES ('2', 'Bob', 'bob@test.com')`);
      const result2 = await client
        .$withCache({ key: "string-ttl", ttl: "1 hour" })
        .user.findMany();
      expect(result2).toHaveLength(1);
    });
  });

  describe("SWR (stale-while-revalidate)", () => {
    it("returns stale data and revalidates in background", async () => {
      const cache = new MemoryCache();
      const client = VibORM.create({
        schema,
        driver,
        cache,
      });

      await client.user.create({
        data: { id: "1", name: "Alice", email: "alice@test.com" },
      });

      // Initial cache with short TTL
      await client
        .$withCache({ key: "swr-test", ttl: 30, swr: true })
        .user.findMany();

      // Wait for cache to become stale (but not expired from storage - 2x TTL)
      await new Promise((r) => setTimeout(r, 50));

      // Add more data AFTER cache is stale
      await pglite.exec(`INSERT INTO "user" VALUES ('2', 'Bob', 'bob@test.com')`);

      // Should return stale data immediately (SWR pattern)
      const staleResult = await client
        .$withCache({ key: "swr-test", ttl: 30, swr: true })
        .user.findMany();
      expect(staleResult).toHaveLength(1); // Stale data returned immediately

      // Wait for background revalidation to complete
      await new Promise((r) => setTimeout(r, 100));

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
      const client = VibORM.create({
        schema,
        driver,
        cache,
      });

      await client.user.create({
        data: { id: "1", name: "Alice", email: "alice@test.com" },
      });

      // Initial cache
      await client.$withCache({ key: "bypass-test" }).user.findMany();

      // Add more data
      await pglite.exec(`INSERT INTO "user" VALUES ('2', 'Bob', 'bob@test.com')`);

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
      const client = VibORM.create({
        schema,
        driver,
        cache,
      });

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
    it("invalidates cache on mutation with autoInvalidate", async () => {
      const cache = new MemoryCache();
      const client = VibORM.create({
        schema,
        driver,
        cache,
      });

      await client.user.create({
        data: { id: "1", name: "Alice", email: "alice@test.com" },
      });

      // Cache the result with explicit key (autoInvalidate clears by model prefix)
      await client.$withCache({ key: "user:all" }).user.findMany();

      // Create with autoInvalidate - this clears all "user" prefixed cache entries
      await client.user.create({
        data: { id: "2", name: "Bob", email: "bob@test.com" },
        cache: { autoInvalidate: true },
      });

      // Use a fresh key to verify new data is fetched
      const result = await client.$withCache({ key: "user:fresh" }).user.findMany();
      expect(result).toHaveLength(2);
    });

    it("invalidates specific keys", async () => {
      const cache = new MemoryCache();
      const client = VibORM.create({
        schema,
        driver,
        cache,
      });

      await client.user.create({
        data: { id: "1", name: "Alice", email: "alice@test.com" },
      });

      // Cache with specific key
      await client.$withCache({ key: "my-users" }).user.findMany();

      // Invalidate that key
      await client.$invalidate("my-users");

      // Add more data
      await pglite.exec(`INSERT INTO "user" VALUES ('2', 'Bob', 'bob@test.com')`);

      // Should get fresh data
      const result = await client.$withCache({ key: "my-users" }).user.findMany();
      expect(result).toHaveLength(2);
    });

    it("invalidates by prefix pattern", async () => {
      const cache = new MemoryCache();
      const client = VibORM.create({
        schema,
        driver,
        cache,
      });

      await client.user.create({
        data: { id: "1", name: "Alice", email: "alice@test.com" },
      });

      // Cache with prefixed keys
      await client.$withCache({ key: "users:all" }).user.findMany();
      await client.$withCache({ key: "users:count" }).user.count();

      // Invalidate all keys starting with "users:"
      await client.$invalidate("users:*");

      // Add more data
      await pglite.exec(`INSERT INTO "user" VALUES ('2', 'Bob', 'bob@test.com')`);

      // Both should get fresh data
      const result = await client.$withCache({ key: "users:all" }).user.findMany();
      expect(result).toHaveLength(2);

      const count = await client.$withCache({ key: "users:count" }).user.count();
      expect(count).toBe(2);
    });
  });

  describe("cache versioning", () => {
    it("different cache versions have different keys", async () => {
      // Use separate cache instances to avoid cross-test pollution
      const cache1 = new MemoryCache();
      const cache2 = new MemoryCache();

      await pglite.exec(`INSERT INTO "user" VALUES ('1', 'Alice', 'alice@test.com')`);

      // Client with version 1
      const client1 = VibORM.create({
        schema,
        driver,
        cache: cache1,
        cacheVersion: 1,
      });

      // Client with version 2
      const client2 = VibORM.create({
        schema,
        driver,
        cache: cache2,
        cacheVersion: 2,
      });

      // Cache with client1
      const result1 = await client1.$withCache({ key: "users" }).user.findMany();
      expect(result1).toHaveLength(1);

      // Add more data
      await pglite.exec(`INSERT INTO "user" VALUES ('2', 'Bob', 'bob@test.com')`);

      // Client2 should miss cache (different cache instance)
      const result2 = await client2.$withCache({ key: "users" }).user.findMany();
      expect(result2).toHaveLength(2);

      // Client1 should still have cached data
      const result1Cached = await client1.$withCache({ key: "users" }).user.findMany();
      expect(result1Cached).toHaveLength(1);
    });

    it("same cache with different versions isolates keys", async () => {
      const sharedCache = new MemoryCache();

      await pglite.exec(`INSERT INTO "user" VALUES ('1', 'Alice', 'alice@test.com')`);

      // Client with version 1
      const client1 = VibORM.create({
        schema,
        driver,
        cache: sharedCache,
        cacheVersion: 1,
      });

      // Cache with version 1
      await client1.$withCache({ key: "users" }).user.findMany();

      // Add more data
      await pglite.exec(`INSERT INTO "user" VALUES ('2', 'Bob', 'bob@test.com')`);

      // Client with version 2 (same cache)
      const client2 = VibORM.create({
        schema,
        driver,
        cache: sharedCache,
        cacheVersion: 2,
      });

      // Version 2 should miss (different version prefix)
      const result2 = await client2.$withCache({ key: "users" }).user.findMany();
      expect(result2).toHaveLength(2);
    });
  });

  describe("error handling", () => {
    it("throws when cache driver not configured", () => {
      const client = VibORM.create({
        schema,
        driver,
        // No cache
      });

      expect(() => client.$withCache()).toThrow(
        "Cache driver not configured"
      );
    });

    it("throws on non-cacheable operations", async () => {
      const cache = new MemoryCache();
      const client = VibORM.create({
        schema,
        driver,
        cache,
      });

      const cachedClient = client.$withCache();

      // @ts-expect-error - Testing runtime error for non-cacheable operation
      await expect(cachedClient.user.create({ data: { id: "1", name: "Test", email: "test@test.com" } }))
        .rejects.toThrow();
    });

    it("throws on invalid cache options", () => {
      const cache = new MemoryCache();
      const client = VibORM.create({
        schema,
        driver,
        cache,
      });

      // @ts-expect-error - Testing runtime validation of invalid options
      expect(() => client.$withCache({ ttl: {} })).toThrow("Invalid cache options");

      // @ts-expect-error - Testing runtime validation of invalid options
      expect(() => client.$withCache({ swr: "yes" })).toThrow("Invalid cache options");
    });
  });

  describe("OrThrow variants", () => {
    it("caches findUniqueOrThrow results", async () => {
      const cache = new MemoryCache();
      const client = VibORM.create({
        schema,
        driver,
        cache,
      });

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
      const client = VibORM.create({
        schema,
        driver,
        cache,
      });

      await expect(
        client
          .$withCache({ key: "not-found" })
          .user.findUniqueOrThrow({ where: { id: "nonexistent" } })
      ).rejects.toThrow();
    });
  });
});
