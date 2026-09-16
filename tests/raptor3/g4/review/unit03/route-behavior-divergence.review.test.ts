/**
 * G4-03 independent review probe — supported verbs that behave differently.
 *
 * The unit's own oracles only run the verbs/options its author chose. These
 * probes run SUPPORTED verbs with options the candidate route reaches by a
 * different binding, and compare the public outcome against the shipped route:
 *
 *  1. `createMany({ skipDuplicates: true })` inside `$transaction([...])`
 *     (note.md B-2: the array owner's sequential fallback grants no member
 *     rollback, so the candidate refuses where the shipped route succeeds).
 *  2. the same option inside `$transaction(callback)` (the route DOES open a
 *     region there, so this half should match).
 *  3. official-cache INVALIDATION KEYS, not just their count (NS-04 identity).
 */

import assert from "node:assert/strict";
import { VibORM, type VibORMClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCandidateRoute } from "@query-engine/raptor3/route/client-route";
import { s } from "@schema";
import { MemoryCache } from "@src/cache/drivers/memory";
import { cache } from "@src/cache/exports";
import { createClient } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, test } from "vitest";

const author = s
  .model({
    id: s.int().id().increment(),
    email: s.string().unique(),
    name: s.string(),
  })
  .map("g4r_div_authors");

const schema = { author };

type WorldClient = VibORMClient<{
  driver: SQLite3Driver;
  schema: typeof schema;
}>;

const closers: (() => Promise<void>)[] = [];

async function createWorld(route: "shipped" | "candidate") {
  const database = new Database(":memory:");
  const driver = new SQLite3Driver({ client: database });
  const config = { driver, schema };
  const client = (
    route === "shipped"
      ? createClient(config)
      : VibORM.create(config, createCandidateRoute)
  ) as WorldClient;
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("schema did not apply");
  closers.push(async () => {
    await client.$disconnect();
    database.close();
  });
  return { client, database, driver };
}

class RecordingCache extends MemoryCache {
  readonly invalidations: string[] = [];

  protected override async delete(keys: string[]): Promise<void> {
    this.invalidations.push(`delete:${keys.join(",")}`);
    return super.delete(keys);
  }

  protected override async clear(prefix: string): Promise<void> {
    this.invalidations.push(`clear:${prefix}`);
    return super.clear(prefix);
  }
}

async function createCacheWorld(route: "shipped" | "candidate") {
  const base = await createWorld(route);
  const cacheDriver = new RecordingCache();
  const background: Promise<unknown>[] = [];
  const client = base.client.$extends(
    cache({
      driver: cacheDriver,
      waitUntil(promise) {
        background.push(promise);
      },
    })
  );
  return {
    cacheDriver,
    client,
    async settle() {
      await Promise.all(background.splice(0));
    },
  };
}

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function outcome<T>(run: () => Promise<T>): Promise<string> {
  try {
    const value = await run();
    return `ok:${JSON.stringify(value)}`;
  } catch (error) {
    return `${(error as Error).constructor.name}:${(error as Error).message}`;
  }
}

describe("G4-03 review — supported-verb behavior divergence", () => {
  test("createMany({ skipDuplicates }) inside an array transaction behaves the same on both routes", async () => {
    const results: Record<string, string> = {};
    for (const route of ["shipped", "candidate"] as const) {
      const world = await createWorld(route);
      await world.client.author.create({
        data: { email: "dup@example.test", name: "Existing" },
      });
      results[route] = await outcome(() =>
        world.client.$transaction([
          world.client.author.createMany({
            data: [
              { email: "dup@example.test", name: "Duplicate" },
              { email: "fresh@example.test", name: "Fresh" },
            ],
            skipDuplicates: true,
          }),
        ])
      );
    }
    assert.equal(
      results.candidate,
      results.shipped,
      `candidate=${results.candidate}\nshipped=${results.shipped}`
    );
  });

  test("createMany({ skipDuplicates }) inside a callback transaction behaves the same on both routes", async () => {
    const results: Record<string, string> = {};
    for (const route of ["shipped", "candidate"] as const) {
      const world = await createWorld(route);
      await world.client.author.create({
        data: { email: "cb-dup@example.test", name: "Existing" },
      });
      results[route] = await outcome(() =>
        world.client.$transaction((tx) =>
          tx.author.createMany({
            data: [
              { email: "cb-dup@example.test", name: "Duplicate" },
              { email: "cb-fresh@example.test", name: "Fresh" },
            ],
            skipDuplicates: true,
          })
        )
      );
    }
    assert.equal(
      results.candidate,
      results.shipped,
      `candidate=${results.candidate}\nshipped=${results.shipped}`
    );
  });

  test("a committed write publishes the same invalidation KEYS on both routes", async () => {
    const observed: Record<string, string[]> = {};
    for (const route of ["shipped", "candidate"] as const) {
      const world = await createCacheWorld(route);
      await world.client.author.create({
        data: { email: `key-${route}@example.test`, name: "Key" },
      });
      await world.settle();
      observed[route] = [...world.cacheDriver.invalidations];
    }
    assert.deepEqual(
      observed.candidate,
      observed.shipped,
      `candidate=${JSON.stringify(observed.candidate)} shipped=${JSON.stringify(observed.shipped)}`
    );
  });
  test("an array transaction with two invalid members surfaces the same error on both routes", async () => {
    const results: Record<string, string> = {};
    for (const route of ["shipped", "candidate"] as const) {
      const world = await createWorld(route);
      results[route] = await outcome(() =>
        world.client.$transaction([
          world.client.author.create({
            // Wrong scalar type for `name`.
            data: { email: "bad-one@example.test", name: 1 as unknown as string },
          }),
          world.client.author.create({
            // Wrong scalar type for `email`.
            data: { email: 2 as unknown as string, name: "Bad Two" },
          }),
        ])
      );
    }
    assert.equal(
      results.candidate,
      results.shipped,
      `candidate=${results.candidate}\nshipped=${results.shipped}`
    );
  });
});
