import { MemoryCache } from "@cache/drivers/memory";
import { cache as cacheExtension } from "@cache/extension";
import { generateCacheKey } from "@cache/key";
import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { CacheInvalidKeyError } from "@errors";

import { sql } from "@sql";
import { fieldRefSchema } from "@tests/fixtures/field-ref-schema";
import type { OperandCtx } from "@validation/primitives/operand";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

/**
 * Cache keys and operand callbacks (W8-A Unit 3).
 *
 * A cache key is computed from the payload that will RUN, and a payload may
 * carry a callback — a function has no stable serialization, so keying has to
 * wait for validation to resolve it. These pin both halves: the raw payload is
 * NOT keyable (the falsification), and two spellings of the same comparison
 * land on one key (the property).
 */

const schema = fieldRefSchema;

type PostCtx = OperandCtx<typeof schema.post>;

let pglite: PGlite;
let driver: PGliteDriver;

beforeAll(async () => {
  pglite = new PGlite();
  driver = new PGliteDriver({ client: pglite });
  await syncLiveSchema(createClient({ schema, driver }));
});

beforeEach(async () => {
  await pglite.exec(
    `DELETE FROM "fieldref_posts"; DELETE FROM "fieldref_users";`
  );
});

const makeClient = () => createClient({ schema, driver });
const makeCachedClient = (cache: MemoryCache) =>
  createClient({ schema, driver }).$extends(cacheExtension({ driver: cache }));

const seed = async (client: ReturnType<typeof makeClient>) => {
  await client.user.createMany({
    data: [{ id: "u1", name: "alice", nickname: "alice" }],
  });
  await client.post.createMany({
    data: [
      {
        id: "hot",
        title: "hot",
        slug: "hot",
        views: 100,
        likes: 5,
        authorId: "u1",
      },
      {
        id: "cold",
        title: "cold",
        slug: "cold",
        views: 1,
        likes: 50,
        authorId: "u1",
      },
    ],
  });
};

/** Inserts a row BEHIND the client, so no cache invalidation runs. */
const sneakInsert = (id: string, views: number, likes: number) =>
  pglite.exec(
    `INSERT INTO "fieldref_posts" ("id","title","slug_column","views","likes","status","review_status","authorId") VALUES ('${id}','${id}','${id}',${views},${likes},'draft','published','u1')`
  );

describe("keying a payload that carries an operand callback", () => {
  test("the raw payload is not keyable — which is why keying waits for validation", () => {
    // The falsification. If the cache flow keyed the caller's args, THIS is what
    // every callback payload would do.
    expect(() =>
      generateCacheKey("post", "findMany", {
        where: { views: { gt: (ctx: PostCtx) => ctx.fields.likes } },
      })
    ).toThrow(CacheInvalidKeyError);
  });

  test("two spellings of the same comparison share one cache entry", async () => {
    const client = makeCachedClient(new MemoryCache());
    await seed(client);

    const first = await client.$withCache({ ttl: 60_000 }).post.findMany({
      where: { views: { gt: (ctx: PostCtx) => ctx.fields.likes } },
    });
    expect(first.map((p) => p.id)).toEqual(["hot"]);

    // A row the cached answer must NOT know about.
    await sneakInsert("sneaky", 999, 1);

    // A DIFFERENT function object, spelled differently, meaning the same thing.
    const second = await client.$withCache({ ttl: 60_000 }).post.findMany({
      where: {
        views: {
          gt: (context: PostCtx) => {
            const table = context.fields;
            return table.likes;
          },
        },
      },
    });
    expect(second.map((p) => p.id)).toEqual(["hot"]);

    // Control: a genuinely different comparison must MISS and see the new row.
    const third = await client.$withCache({ ttl: 60_000 }).post.findMany({
      where: { views: { gte: (ctx: PostCtx) => ctx.fields.likes } },
    });
    expect(third.map((p) => p.id).sort()).toEqual(["hot", "sneaky"]);
  });

  test("a fragment spelling keys apart from a reference spelling", async () => {
    const client = makeCachedClient(new MemoryCache());
    await seed(client);

    const viaCallback = await client.$withCache({ ttl: 60_000 }).post.findMany({
      where: { views: { gt: (ctx: PostCtx) => ctx.fields.likes } },
    });
    expect(viaCallback.map((p) => p.id)).toEqual(["hot"]);

    await sneakInsert("sneaky", 999, 1);

    const viaToken = await client
      .$withCache({ ttl: 60_000 })
      .post.findMany({ where: { views: { gt: sql`"likes"` } } });
    // A fragment is not a reference, so this is a different query and a
    // different key: it MISSES and sees the row inserted behind the client.
    expect(viaToken.map((p) => p.id).sort()).toEqual(["hot", "sneaky"]);

    // …while the callback spelling still serves the earlier entry.
    const again = await client.$withCache({ ttl: 60_000 }).post.findMany({
      where: { views: { gt: (ctx: PostCtx) => ctx.fields.likes } },
    });
    expect(again.map((p) => p.id)).toEqual(["hot"]);
  });
});

describe("keying a fragment operand", () => {
  const keyFor = (fragment: unknown) =>
    generateCacheKey("post", "findMany", {
      where: { views: { gt: fragment } },
    });

  test("two identical fragments key identically", () => {
    expect(keyFor(sql`${1} + ${2}`)).toBe(keyFor(sql`${1} + ${2}`));
  });

  test("an interpolated value is part of the key", () => {
    expect(keyFor(sql`${1} + ${2}`)).not.toBe(keyFor(sql`${1} + ${3}`));
  });

  test("the fragment's text is part of the key", () => {
    expect(keyFor(sql`${1} + ${2}`)).not.toBe(keyFor(sql`${1} - ${2}`));
  });

  test("a fragment keys the same before and after it has been compiled", () => {
    // An `Sql` memoizes its flattened text on first read. A key that enumerated
    // instance fields would drift the moment anything compiled the fragment.
    const fragment = sql`${1} + ${2}`;
    const before = keyFor(fragment);
    fragment.toStatement("$n");
    expect(keyFor(fragment)).toBe(before);
  });

  test("a field reference keys by what it names", () => {
    const key = generateCacheKey("post", "findMany", {
      where: {
        views: {
          gt: { model: "post", field: "likes", type: "int", list: false },
        },
      },
    });
    expect(key).toContain("post:findMany:");
  });
});

describe("batch preparation sees the resolved payload", () => {
  test("$transaction([...]) runs a callback payload without a function reaching SQL", async () => {
    const client = makeClient();
    await seed(client);

    const [posts] = (await client.$transaction([
      client.post.findMany({
        where: { views: { gt: (ctx: PostCtx) => ctx.fields.likes } },
      }),
    ])) as [{ id: string }[]];

    expect(posts.map((p) => p.id)).toEqual(["hot"]);
  });

  test("the raw payload keeps the function; the compiled statement does not", () => {
    const client = makeClient();
    const pending = client.post.findMany({
      where: { views: { gt: (ctx: PostCtx) => ctx.fields.likes } },
    });

    // Construction is lazy, so the caller's payload is untouched…
    expect(typeof (pending.getArgs() as any).where.views.gt).toBe("function");
    // …and what compiles is the resolved column comparison.
    const statement = pending.buildStatement()?.toStatement("$n") ?? "";
    expect(statement).toContain(`"likes"`);
    expect(statement).toContain(`"views"`);
  });
});
