/**
 * G4-03 C13 — the official cache over the candidate route.
 *
 * The cache extension, its keys and its invalidation rules are the existing
 * owners'; the candidate supplies the executed operation and, for a cached
 * read, the canonical result codec. Two halves are separable and are reported
 * separately here:
 *
 *  - invalidation (LX-08) and every documented BYPASS (LX-07, RF-10) never need
 *    the result codec and are verified against the shipped client;
 *  - the cached-read STORE/MATERIALIZE half needs one value codec per prepared
 *    LEAF, and a leaf publishes a projection of its scalar's state rather than
 *    the `Scalar` the official codec owner is addressed by (note.md FU.6 B-1c).
 *    Its refusal is pinned exactly, so the pin fails the day the requested seam
 *    lands. The cache KEY half is no longer pending: see the NS-04 cell.
 *
 * Inventory rows: LX-07, LX-08, RF-10, NS-04.
 */

import assert from "node:assert/strict";
import type { VibORMClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { UnsupportedOperationError } from "@errors";
import {
  createCandidateClient,
  createCandidateRoute,
} from "@query-engine/raptor3/route/client-route";
import { s } from "@schema";
import { MemoryCache } from "@src/cache/drivers/memory";
import type { CacheEntry } from "@src/cache/exports";
import { cache } from "@src/cache/exports";
import { createClient, sql } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";

const entry = s
  .model({
    id: s.int().id().increment(),
    label: s.string().unique(),
  })
  .map("g4_cache_entries");

const schema = { entry };

/**
 * The exact seam the official cache reads a key from
 * (`PendingOperation.cacheKeyArgs`, reached through
 * `readPendingCacheResultFriend`). Naming it here keeps the NS-04 cell an
 * assertion about the cache's own input rather than about a stored key string.
 */
interface KeyedOperation {
  cacheKeyArgs(): Record<string, unknown>;
}

class RecordingCache extends MemoryCache {
  readonly gets: string[] = [];
  readonly invalidations: string[] = [];
  readonly sets: string[] = [];

  protected override async get<T>(key: string): Promise<CacheEntry<T> | null> {
    this.gets.push(key);
    return super.get<T>(key);
  }

  protected override async set<T>(
    key: string,
    storageTtl: number,
    entry: CacheEntry<T>
  ): Promise<void> {
    this.sets.push(key);
    return super.set<T>(key, storageTtl, entry);
  }

  protected override async delete(keys: string[]): Promise<void> {
    this.invalidations.push(`delete:${keys.join(",")}`);
    return super.delete(keys);
  }

  protected override async clear(prefix: string): Promise<void> {
    this.invalidations.push(`clear:${prefix}`);
    return super.clear(prefix);
  }
}

type BaseClient = VibORMClient<{
  driver: SQLite3Driver;
  schema: typeof schema;
}>;

/** Open worlds, closed in `afterEach` without naming the extended client type. */
const openWorlds: {
  close(): Promise<void>;
  database: Database.Database;
}[] = [];

async function createCacheWorld(route: "shipped" | "candidate") {
  const database = new Database(":memory:");
  const driver = new SQLite3Driver({ client: database });
  const config = { driver, schema };
  const base: BaseClient =
    route === "shipped" ? createClient(config) : createCandidateClient(config);
  const migration = await syncLiveSchema(base);
  if (!migration.applied) throw new Error("The world's schema did not apply");
  const cacheDriver = new RecordingCache();
  const background: Promise<unknown>[] = [];
  const client = base.$extends(
    cache({
      driver: cacheDriver,
      waitUntil(promise) {
        background.push(promise);
      },
    })
  );
  openWorlds.push({
    close: () => client.$disconnect(),
    database,
  });
  return {
    cacheDriver,
    client,
    database,
    async settle(): Promise<void> {
      await Promise.all(background.splice(0));
    },
  };
}

afterEach(async () => {
  for (const world of openWorlds.splice(0)) {
    await world.close();
    world.database.close();
  }
});

describe("G4-03 C13 official cache over the candidate route", () => {
  test("LX-08/NS-04 a committed candidate write publishes exactly one invalidation", async () => {
    const shipped = await createCacheWorld("shipped");
    const candidate = await createCacheWorld("candidate");
    for (const world of [shipped, candidate]) {
      await world.client.entry.create({
        cache: { autoInvalidate: true },
        data: { label: "published" },
      });
      await world.settle();
    }
    assert.equal(candidate.cacheDriver.invalidations.length, 1);
    assert.deepEqual(
      candidate.cacheDriver.invalidations.map((entryKey) =>
        entryKey.slice(0, entryKey.indexOf(":"))
      ),
      shipped.cacheDriver.invalidations.map((entryKey) =>
        entryKey.slice(0, entryKey.indexOf(":"))
      )
    );
  });

  test("LX-08 a rolled-back candidate write publishes no invalidation", async () => {
    const world = await createCacheWorld("candidate");
    const rollback = new Error("caller rollback");
    await assert.rejects(
      world.client.$transaction(async (tx) => {
        await tx.entry.create({
          cache: { autoInvalidate: true },
          data: { label: "rolled-back" },
        });
        throw rollback;
      }),
      (error) => error === rollback
    );
    await world.settle();
    assert.deepEqual(world.cacheDriver.invalidations, []);
    assert.deepEqual(
      world.database.prepare("SELECT label FROM g4_cache_entries").all(),
      []
    );
  });

  test("LX-08 a transaction publishes its members' invalidations only after commit", async () => {
    const world = await createCacheWorld("candidate");
    await world.client.$transaction(async (tx) => {
      await tx.entry.create({
        cache: { autoInvalidate: true },
        data: { label: "inside" },
      });
      assert.deepEqual(world.cacheDriver.invalidations, []);
    });
    await world.settle();
    assert.equal(world.cacheDriver.invalidations.length, 1);
  });

  test("RF-10/LX-07 a cached read inside a transaction bypasses the cache entirely", async () => {
    const world = await createCacheWorld("candidate");
    await world.client.entry.create({ data: { label: "bypassed" } });
    const rows = await world.client.$transaction(async (tx) => {
      const cached = (
        tx as unknown as { $withCache?: () => typeof tx }
      ).$withCache?.();
      // A transaction view exposes no cached proxy; the read runs unchanged.
      assert.equal(cached, undefined);
      return tx.entry.findMany({ select: { label: true } });
    });
    await world.settle();
    assert.deepEqual(rows, [{ label: "bypassed" }]);
    assert.deepEqual(world.cacheDriver.gets, []);
    assert.deepEqual(world.cacheDriver.sets, []);
  });

  test("LX-07 a raw read is never a cached operation on either route", async () => {
    const world = await createCacheWorld("candidate");
    await world.client.entry.create({ data: { label: "raw" } });
    const rows = await world.client.$queryRaw<{ label: string }[]>(
      sql`SELECT label FROM g4_cache_entries`
    );
    await world.settle();
    expect(rows).toEqual([{ label: "raw" }]);
    assert.deepEqual(world.cacheDriver.gets, []);
    assert.deepEqual(world.cacheDriver.sets, []);
  });

  test("NS-04 the payload a cache entry is keyed on is identical on both routes", async () => {
    const shipped = await createCacheWorld("shipped");
    const candidate = await createCacheWorld("candidate");
    const keyed = (
      world: Awaited<ReturnType<typeof createCacheWorld>>
    ): Record<string, unknown> =>
      (
        world.client.entry.findMany({
          select: { label: true },
          where: { label: "keyed" },
        }) as unknown as KeyedOperation
      ).cacheKeyArgs();
    // The cache keys on the ADMITTED payload, so an operand callback keys
    // stably. The candidate publishes its one admission through `prepare(...)`,
    // which is the same payload the shipped route's constructed operation
    // retains — the seam blocker B-1 named, now consumed.
    assert.deepEqual(keyed(shipped), keyed(candidate));
    assert.deepEqual(keyed(candidate), {
      select: { label: true },
      where: { label: { equals: "keyed" } },
    });
  });

  test("LX-07 a cached read stores and materializes identically on both routes", async () => {
    const worlds = {
      shipped: await createCacheWorld("shipped"),
      candidate: await createCacheWorld("candidate"),
    };
    const observed: Record<string, unknown[]> = {};
    for (const [route, world] of Object.entries(worlds)) {
      await world.client.entry.create({ data: { label: "cacheable" } });
      const cached = world.client.$withCache();
      assert(cached);
      // First call: a miss that stores one entry under the canonical key.
      const fresh = await cached.entry.findMany({ select: { label: true } });
      await world.settle();
      assert.equal(world.cacheDriver.sets.length, 1, `${route} stored once`);
      // Second call: served from the store, and materialized as a FRESH graph.
      const hit = await cached.entry.findMany({ select: { label: true } });
      await world.settle();
      assert.equal(world.cacheDriver.sets.length, 1, `${route} stored once`);
      assert.notEqual(hit, fresh);
      assert.notEqual(hit[0], fresh[0]);
      observed[route] = [fresh, hit];
    }
    assert.deepEqual(observed.candidate, [
      [{ label: "cacheable" }],
      [{ label: "cacheable" }],
    ]);
    assert.deepEqual(
      observed.candidate,
      observed.shipped,
      "NS-04: the cached value the candidate route serves is the shipped one"
    );
    // The same route refuses what it cannot encode rather than storing half of
    // it: a write verb publishes no prepared read at all.
    const database = new Database(":memory:");
    try {
      const route = createCandidateRoute(
        schema,
        new SQLite3Driver({ client: database })
      );
      assert.throws(
        () =>
          route
            .operation(entry, "create", { data: { label: "x" } })
            .cacheResultCodec(),
        (error: Error) =>
          error.constructor.name === UnsupportedOperationError.name &&
          error.message.includes("publishes no prepared read")
      );
    } finally {
      database.close();
    }
  });
});
