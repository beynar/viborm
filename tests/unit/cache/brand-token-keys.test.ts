import { MemoryCache } from "@cache/drivers/memory";
import { cache as cacheExtension } from "@cache/extension";
import { createClient } from "@client/client";
import { DbNull, s } from "@schema";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

const entry = s
  .model({
    id: s.string().id(),
    meta: s.json().nullable(),
    required: s.json(),
  })
  .map("cache_brand_token_entries");

const schema = { entry };

const family = usePGliteSchemaFamily(schema);

const makeClient = () => createClient({ schema, driver: family().driver });
const makeCachedClient = (cache: MemoryCache) =>
  createClient({ schema, driver: family().driver }).$extends(
    cacheExtension({ driver: cache })
  );

const seed = async () => {
  // Written by a cacheless client: seeding must not populate anything.
  await makeClient().entry.createMany({
    data: [
      { id: "db", meta: DbNull, required: { r: 1 } },
      { id: "shape", meta: { kind: "DbNull" }, required: { r: 1 } },
    ],
  });
};

describe("a cached client answers each question with its own rows", () => {
  test("the sentinel query does not serve the document query's entry", async () => {
    const client = makeCachedClient(new MemoryCache());
    await seed();

    const sentinel = await client
      .$withCache({ ttl: 60_000 })
      .entry.findMany({ where: { meta: { equals: DbNull } } });
    expect(sentinel.map((row) => row.id)).toEqual(["db"]);

    const document = await client
      .$withCache({ ttl: 60_000 })
      .entry.findMany({ where: { meta: { equals: { kind: "DbNull" } } } });
    expect(document.map((row) => row.id)).toEqual(["shape"]);
  });

  test("and the reverse order poisons nothing either", async () => {
    const client = makeCachedClient(new MemoryCache());
    await seed();

    const document = await client
      .$withCache({ ttl: 60_000 })
      .entry.findMany({ where: { meta: { equals: { kind: "DbNull" } } } });
    expect(document.map((row) => row.id)).toEqual(["shape"]);

    const sentinel = await client
      .$withCache({ ttl: 60_000 })
      .entry.findMany({ where: { meta: { equals: DbNull } } });
    expect(sentinel.map((row) => row.id)).toEqual(["db"]);
  });

  test("the cached answers are the uncached ones", async () => {
    const client = makeCachedClient(new MemoryCache());
    const uncached = makeClient();
    await seed();

    for (const operand of [DbNull, { kind: "DbNull" }]) {
      const cached = await client
        .$withCache({ ttl: 60_000 })
        .entry.findMany({ where: { meta: { equals: operand } } });
      const fresh = await uncached.entry.findMany({
        where: { meta: { equals: operand } },
      });
      expect(cached.map((row) => row.id)).toEqual(fresh.map((row) => row.id));
    }
  });

  test("the same question twice is still one cache entry", async () => {
    const client = makeCachedClient(new MemoryCache());
    await seed();

    const first = await client
      .$withCache({ ttl: 60_000 })
      .entry.findMany({ where: { meta: { equals: DbNull } } });
    expect(first.map((row) => row.id)).toEqual(["db"]);

    await makeClient().entry.create({
      data: { id: "sneaky", meta: DbNull, required: { r: 2 } },
    });

    const second = await client
      .$withCache({ ttl: 60_000 })
      .entry.findMany({ where: { meta: { equals: DbNull } } });
    expect(second.map((row) => row.id)).toEqual(["db"]);
  });
});
