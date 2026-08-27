import { MemoryCache } from "@src/cache/drivers/memory";
import type { CacheEntry } from "@src/cache/exports";
import { cache } from "@src/cache/exports";
import { defaultOmit } from "@src/client/exports";
import { CacheInvalidKeyError, ValidationError } from "@src/errors";
import { createClient, s } from "@src/index";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { readTestTransactionOperation } from "@tests/fixtures/transaction-operation";
import { describe, expect, test } from "vitest";

const author = s
  .model({
    id: s.string().id(),
    name: s.string(),
    secret: s.string(),
    happenedAt: s.dateTime(),
    metadata: s.json(),
    large: s.bigInt(),
    bytes: s.blob(),
    posts: s.toMany(() => post),
  })
  .map("official_cache_read_author");
const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    authorId: s.string(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
  })
  .map("official_cache_read_post");
const schema = { author, post };
const family = usePGliteSchemaFamily(schema);
const nativeFamily = usePGliteSchemaFamily(schema, "atomicBatch");

class RecordingCache extends MemoryCache {
  readonly clears: string[] = [];
  readonly deletes: string[][] = [];
  readonly gets: string[] = [];
  readonly sets: string[] = [];
  private corruptedRead: { readonly value: unknown } | undefined;
  private nextSetBarrier: Promise<void> | undefined;

  corruptNextRead(value: unknown): void {
    this.corruptedRead = { value };
  }

  holdNextSet(): () => void {
    let release = (): void => undefined;
    this.nextSetBarrier = new Promise((resolve) => {
      release = resolve;
    });
    return release;
  }

  protected override async get<T>(key: string): Promise<CacheEntry<T> | null> {
    this.gets.push(key);
    const entry = await super.get<T>(key);
    const corruption = this.corruptedRead;
    this.corruptedRead = undefined;
    if (entry !== null && corruption !== undefined) {
      Object.defineProperty(entry, "value", {
        configurable: true,
        enumerable: true,
        value: corruption.value,
        writable: true,
      });
    }
    return entry;
  }

  protected override async set<T>(
    key: string,
    storageTtl: number,
    entry: CacheEntry<T>
  ): Promise<void> {
    this.sets.push(key);
    const barrier = this.nextSetBarrier;
    this.nextSetBarrier = undefined;
    if (barrier !== undefined) await barrier;
    await super.set(key, storageTtl, entry);
  }

  protected override async delete(keys: string[]): Promise<void> {
    this.deletes.push([...keys]);
    await super.delete(keys);
  }

  protected override async clear(prefix: string): Promise<void> {
    this.clears.push(prefix);
    await super.clear(prefix);
  }
}

function officialCache(cacheDriver: RecordingCache, version?: string | number) {
  const background: Promise<unknown>[] = [];
  const extension = cache({
    driver: cacheDriver,
    version,
    waitUntil(promise) {
      background.push(promise);
    },
  });
  return {
    extension,
    async settle(): Promise<void> {
      await Promise.all(background.splice(0));
    },
  };
}

async function seed(target = family()): Promise<void> {
  const { client } = target;
  await client.author.create({
    data: {
      id: "a1",
      name: "Ada",
      secret: "classified",
      happenedAt: new Date("2026-01-02T03:04:05.678Z"),
      metadata: { nested: { enabled: true }, zero: 0 },
      large: 9_007_199_254_740_993n,
      bytes: new Uint8Array([1, 2, 3]),
    },
  });
  await client.author.create({
    data: {
      id: "a2",
      name: "Grace",
      secret: "also-classified",
      happenedAt: new Date("2026-02-03T04:05:06.789Z"),
      metadata: { nested: { enabled: false } },
      large: 9_007_199_254_740_994n,
      bytes: new Uint8Array([4, 5, 6]),
    },
  });
  await client.post.create({
    data: { id: "p1", title: "First", authorId: "a1" },
  });
}

describe("official cache reads", () => {
  test("keys the post-request validated payload and applies client omit on hits", async () => {
    await seed();
    const { driver } = family();
    const cacheDriver = new RecordingCache();
    const cacheState = officialCache(cacheDriver, "request");
    let requestCalls = 0;
    const client = createClient({
      schema,
      driver,
    })
      .$extends(defaultOmit<typeof schema>()({ author: { secret: true } }))
      .$extends({
        name: "canonical-cache-request",
        request: {
          author: {
            findMany() {
              requestCalls += 1;
              return { where: { name: "Ada" } };
            },
          },
        },
      })
      .$extends(cacheState.extension);
    const cached = client.$withCache({ key: "caller-suffix" });

    const firstOperation = cached.author.findMany({
      where: { name: "first" },
    });
    expect(requestCalls).toBe(0);
    expect(cacheDriver.gets).toEqual([]);
    const first = await firstOperation;
    await cacheState.settle();
    const second = await cached.author.findMany({
      where: { name: "second" },
    });

    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ id: "a1", name: "Ada" });
    expect(first[0]).not.toHaveProperty("secret");
    expect(requestCalls).toBe(2);
    expect(cacheDriver.sets).toHaveLength(1);
    expect(cacheDriver.sets[0]?.endsWith(":caller-suffix")).toBe(true);
    expect(new Set(cacheDriver.gets).size).toBe(1);
  });

  test("uses a custom key only as a canonical-key contribution", async () => {
    await seed();
    const { client: base } = family();
    const cacheDriver = new RecordingCache();
    const cacheState = officialCache(cacheDriver, "suffix");
    const client = base.$extends(cacheState.extension);
    const cached = client.$withCache({ key: "same-suffix" });

    const invalid = Reflect.apply(cached.author.findMany, undefined, [
      { where: { name: 42 } },
    ]);
    await expect(invalid).rejects.toBeInstanceOf(ValidationError);
    expect(cacheDriver.gets).toEqual([]);

    await expect(
      cached.author.findMany({ where: { name: "Ada" } })
    ).resolves.toMatchObject([{ id: "a1" }]);
    await cacheState.settle();
    await expect(
      cached.author.findMany({ where: { name: "Grace" } })
    ).resolves.toMatchObject([{ id: "a2" }]);
    await cacheState.settle();
    await expect(
      cached.author.findMany({
        where: { name: "Ada" },
        select: { name: true },
      })
    ).resolves.toEqual([{ name: "Ada" }]);
    await cacheState.settle();

    expect(cacheDriver.sets).toHaveLength(3);
    expect(new Set(cacheDriver.sets).size).toBe(3);
    expect(cacheDriver.sets.every((key) => key.endsWith(":same-suffix"))).toBe(
      true
    );
    await expect(
      cached.author.findMany({ where: { name: "Ada" } })
    ).resolves.toMatchObject([{ id: "a1" }]);
    await expect(
      cached.author.findMany({ where: { name: "Grace" } })
    ).resolves.toMatchObject([{ id: "a2" }]);
    expect(cacheDriver.sets).toHaveLength(3);
  });

  test("keeps query post-processing outside the stored core snapshot", async () => {
    await seed();
    const { client: base } = family();
    const cacheDriver = new RecordingCache();
    const cacheState = officialCache(cacheDriver, "outer-query");
    let beforeCalls = 0;
    let afterCalls = 0;
    const client = base
      .$extends({
        name: "query-before-cache",
        query: {
          author: {
            async findMany({ proceed }) {
              const rows = await proceed();
              beforeCalls += 1;
              const first = rows[0];
              if (first !== undefined) {
                const name = Reflect.get(first, "name");
                if (typeof name === "string") {
                  Reflect.set(first, "name", `${name}:before${beforeCalls}`);
                }
              }
              return rows;
            },
          },
        },
      })
      .$extends(cacheState.extension)
      .$extends({
        name: "query-after-cache",
        query: {
          author: {
            async findMany({ proceed }) {
              const rows = await proceed();
              afterCalls += 1;
              const first = rows[0];
              if (first !== undefined) {
                const name = Reflect.get(first, "name");
                if (typeof name === "string") {
                  Reflect.set(first, "name", `${name}:after${afterCalls}`);
                }
              }
              return rows;
            },
          },
        },
      });
    const cached = client.$withCache();
    const releaseSet = cacheDriver.holdNextSet();

    const first = await cached.author.findMany({
      where: { id: "a1" },
      select: { id: true, name: true },
    });
    const firstRow = first[0];
    if (firstRow === undefined) throw new Error("Expected the seeded author.");
    firstRow.name = "caller-poison";
    releaseSet();
    await cacheState.settle();
    const second = await cached.author.findMany({
      where: { id: "a1" },
      select: { id: true, name: true },
    });

    expect(first).toEqual([{ id: "a1", name: "caller-poison" }]);
    expect(second).toEqual([{ id: "a1", name: "Ada:after2:before2" }]);
    expect(second).not.toBe(first);
    expect({ beforeCalls, afterCalls }).toEqual({
      beforeCalls: 2,
      afterCalls: 2,
    });
    expect(cacheDriver.sets).toHaveLength(1);
  });

  test("materializes a fresh complete scalar and relation graph per hit", async () => {
    await seed();
    const { client: base } = family();
    const cacheDriver = new RecordingCache();
    const cacheState = officialCache(cacheDriver, "fidelity");
    const cached = base.$extends(cacheState.extension).$withCache();

    const first = await cached.author.findUniqueOrThrow({
      where: { id: "a1" },
      include: { posts: true },
    });
    await cacheState.settle();
    first.name = "mutated";
    first.bytes[0] = 99;
    const firstPost = first.posts[0];
    if (firstPost === undefined) throw new Error("Expected the seeded post.");
    firstPost.title = "mutated";
    if (typeof first.metadata === "object" && first.metadata !== null) {
      Reflect.set(first.metadata, "newKey", true);
    }

    const second = await cached.author.findUniqueOrThrow({
      where: { id: "a1" },
      include: { posts: true },
    });

    expect(second).not.toBe(first);
    expect(second.posts).not.toBe(first.posts);
    expect(second.posts[0]).not.toBe(first.posts[0]);
    expect(second.bytes).not.toBe(first.bytes);
    expect(second.metadata).not.toBe(first.metadata);
    expect(second).toMatchObject({
      id: "a1",
      name: "Ada",
      large: 9_007_199_254_740_993n,
      posts: [{ id: "p1", title: "First", authorId: "a1" }],
    });
    expect(second.happenedAt.toISOString()).toBe("2026-01-02T03:04:05.678Z");
    expect(Array.from(second.bytes)).toEqual([1, 2, 3]);
    expect(second.metadata).toEqual({ nested: { enabled: true }, zero: 0 });
  });

  test("rejects a malformed stored snapshot at the materialization boundary", async () => {
    await seed();
    const { client: base } = family();
    const cacheDriver = new RecordingCache();
    const cacheState = officialCache(cacheDriver, "malformed");
    const cached = base.$extends(cacheState.extension).$withCache();

    await cached.author.findMany({ where: { id: "a1" } });
    await cacheState.settle();
    cacheDriver.corruptNextRead({ not: "a cache snapshot" });

    await expect(
      cached.author.findMany({ where: { id: "a1" } })
    ).rejects.toMatchObject({
      name: "CacheConfigurationError",
      meta: { method: "materialize", operation: "findMany" },
    });
  });

  test("bypasses cache work for arrays, statement transforms, transactions, and raw", async () => {
    await seed();
    const { client: base } = family();

    const arrayCache = new RecordingCache();
    const arrayState = officialCache(arrayCache, "array");
    const arrayClient = base.$extends(arrayState.extension);
    const cachedOperation = arrayClient
      .$withCache()
      .author.findMany({ where: { id: "a1" } });
    await expect(
      Reflect.apply(Reflect.get(arrayClient, "$transaction"), arrayClient, [
        [cachedOperation],
      ])
    ).resolves.toMatchObject([[{ id: "a1" }]]);
    expect(arrayCache.gets).toEqual([]);
    expect(arrayCache.sets).toEqual([]);

    await seed(nativeFamily());
    const nativeCache = new RecordingCache();
    const nativeState = officialCache(nativeCache, "native-array");
    const nativeClient = nativeFamily().client.$extends(nativeState.extension);
    const nativeOperation = nativeClient
      .$withCache()
      .author.findMany({ where: { id: "a1" } });
    await expect(
      Reflect.apply(Reflect.get(nativeClient, "$transaction"), nativeClient, [
        [nativeOperation],
      ])
    ).resolves.toMatchObject([[{ id: "a1" }]]);
    expect({
      clears: nativeCache.clears,
      deletes: nativeCache.deletes,
      gets: nativeCache.gets,
      sets: nativeCache.sets,
    }).toEqual({ clears: [], deletes: [], gets: [], sets: [] });

    const statementCache = new RecordingCache();
    const statementState = officialCache(statementCache, "statement");
    let statements = 0;
    const statementClient = base.$extends(statementState.extension).$extends({
      name: "cache-bypass-statement",
      statement({ statement }) {
        statements += 1;
        return statement;
      },
    });
    await statementClient.$withCache().author.findMany({ where: { id: "a1" } });
    await statementClient.$withCache().author.findMany({ where: { id: "a1" } });
    expect(statements).toBe(2);
    expect(statementCache.gets).toEqual([]);
    expect(statementCache.sets).toEqual([]);

    await arrayClient.$transaction(async (tx) => {
      expect(Reflect.get(tx, "$withCache")).toBeUndefined();
      expect(Reflect.get(tx, "$invalidate")).toBeUndefined();
      await tx.$transaction(async (nested) => {
        expect(Reflect.get(nested, "$withCache")).toBeUndefined();
        expect(Reflect.get(nested, "$invalidate")).toBeUndefined();
        await nested.author.findMany({ where: { id: "a1" } });
      });
    });
    const overridden = arrayClient
      .$withCache()
      .author.findMany({ where: { id: "a1" } });
    const overriddenCapability = readTestTransactionOperation(overridden);
    if (overriddenCapability === undefined) {
      throw new Error("Expected a pending operation");
    }
    await expect(
      overriddenCapability.executeWith(family().driver)
    ).resolves.toMatchObject([{ id: "a1" }]);
    await arrayClient.$queryRaw`SELECT 1 AS value`;
    await arrayClient.$queryRawUnsafe("SELECT 2 AS value");
    await arrayClient.$executeRaw`
      UPDATE "official_cache_read_author"
      SET "name" = "name"
      WHERE 1 = 0
    `;
    await arrayClient.$executeRawUnsafe(
      'UPDATE "official_cache_read_author" SET "name" = "name" WHERE 1 = 0'
    );
    expect({
      clears: arrayCache.clears,
      deletes: arrayCache.deletes,
      gets: arrayCache.gets,
      sets: arrayCache.sets,
    }).toEqual({ clears: [], deletes: [], gets: [], sets: [] });
  });

  test("isolates sibling projections that share one official namespace", async () => {
    await seed();
    const { driver } = family();
    const cacheDriver = new RecordingCache();
    const omittedState = officialCache(cacheDriver, "projection");
    const completeState = officialCache(cacheDriver, "projection");
    const matchingState = officialCache(cacheDriver, "projection");
    const omitted = createClient({
      schema,
      driver,
    })
      .$extends(defaultOmit<typeof schema>()({ author: { secret: true } }))
      .$extends(omittedState.extension)
      .$withCache();
    const complete = createClient({ schema, driver })
      .$extends(completeState.extension)
      .$withCache();
    const matching = createClient({ schema, driver })
      .$extends(matchingState.extension)
      .$withCache();

    const omittedMiss = await omitted.author.findMany({
      where: { id: "a1" },
    });
    await omittedState.settle();
    const completeMiss = await complete.author.findMany({
      where: { id: "a1" },
    });
    await completeState.settle();

    expect(omittedMiss[0]).not.toHaveProperty("secret");
    expect(completeMiss[0]).toMatchObject({ secret: "classified" });
    expect(cacheDriver.sets).toHaveLength(2);
    expect(new Set(cacheDriver.sets).size).toBe(2);
    await expect(
      family().client.author.update({
        where: { id: "a1" },
        data: { name: "Database changed" },
      })
    ).resolves.toMatchObject({ name: "Database changed" });
    await expect(
      omitted.author.findMany({ where: { id: "a1" } })
    ).resolves.toEqual(omittedMiss);
    await expect(
      complete.author.findMany({ where: { id: "a1" } })
    ).resolves.toEqual(completeMiss);
    await expect(
      matching.author.findMany({ where: { id: "a1" } })
    ).resolves.toEqual(completeMiss);
    expect(cacheDriver.sets).toHaveLength(2);
  });

  test("refuses reflected structural cache scopes before backend work", async () => {
    const cacheDriver = new RecordingCache();
    const fakeScope: object = Reflect.construct(Object, []);
    Reflect.defineProperty(fakeScope, "namespace", {
      enumerable: true,
      value:
        "viborm:cache:r2:d:0070006f0073007400670072006500730071006c:k:007000750062006c00690063:u",
    });
    const publicCalls = [
      () =>
        Reflect.apply(cacheDriver._get, cacheDriver, [
          "forged",
          undefined,
          fakeScope,
        ]),
      () =>
        Reflect.apply(cacheDriver._set, cacheDriver, [
          "forged",
          1,
          { ttl: 1000 },
          undefined,
          fakeScope,
        ]),
      () =>
        Reflect.apply(cacheDriver._delete, cacheDriver, [
          "forged",
          undefined,
          fakeScope,
        ]),
      () =>
        Reflect.apply(cacheDriver._clear, cacheDriver, [
          "forged",
          undefined,
          fakeScope,
        ]),
      () =>
        Reflect.apply(cacheDriver._invalidate, cacheDriver, [
          "author",
          { autoInvalidate: true },
          undefined,
          fakeScope,
        ]),
      () =>
        Reflect.apply(cacheDriver._markRevalidating, cacheDriver, [
          "forged",
          fakeScope,
        ]),
      () =>
        Reflect.apply(cacheDriver._clearRevalidating, cacheDriver, [
          "forged",
          fakeScope,
        ]),
    ];

    for (const call of publicCalls) {
      await expect(call()).rejects.toBeInstanceOf(CacheInvalidKeyError);
    }
    expect({
      clears: cacheDriver.clears,
      deletes: cacheDriver.deletes,
      gets: cacheDriver.gets,
      sets: cacheDriver.sets,
    }).toEqual({ clears: [], deletes: [], gets: [], sets: [] });
  });

  test("reserves the official namespace on normal public cache calls", async () => {
    const cacheDriver = new RecordingCache();
    const reservedKey =
      "viborm:cache:r2:d:0070006f0073007400670072006500730071006c:k:007000750062006c00690063:u:author:findMany:forged";
    const publicCalls = [
      () => cacheDriver._get(reservedKey),
      () => cacheDriver._set(reservedKey, 1, { ttl: 1000 }),
      () => cacheDriver._delete(reservedKey),
      () => cacheDriver._clear("viborm:cache"),
      () =>
        cacheDriver._invalidate("author", {
          invalidate: [reservedKey],
        }),
    ];

    for (const call of publicCalls) {
      await expect(call()).rejects.toBeInstanceOf(CacheInvalidKeyError);
    }
    expect({
      clears: cacheDriver.clears,
      deletes: cacheDriver.deletes,
      gets: cacheDriver.gets,
      sets: cacheDriver.sets,
    }).toEqual({ clears: [], deletes: [], gets: [], sets: [] });
  });

  test("isolates read entries for sibling official version scopes", async () => {
    await seed();
    const { client: base } = family();
    const cacheDriver = new RecordingCache();
    const firstState = officialCache(cacheDriver, "v1");
    const secondState = officialCache(cacheDriver, "v2");
    const first = base.$extends(firstState.extension).$withCache();
    const second = base.$extends(secondState.extension).$withCache();

    await first.author.findMany({ where: { id: "a1" } });
    await firstState.settle();
    await second.author.findMany({ where: { id: "a1" } });
    await secondState.settle();

    expect(cacheDriver.sets).toHaveLength(2);
    expect(new Set(cacheDriver.sets).size).toBe(2);
    await first.author.findMany({ where: { id: "a1" } });
    await second.author.findMany({ where: { id: "a1" } });
    expect(cacheDriver.sets).toHaveLength(2);
  });
});
