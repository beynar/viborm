import { MemoryCache } from "@cache/drivers/memory";
import { cache as cacheExtension } from "@cache/extension";
import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "@sql";
import { fieldRefSchema } from "@tests/fixtures/field-ref-schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import type { OperandCtx } from "@validation/primitives/operand";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

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

afterAll(async () => {
  await pglite.close();
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

const sneakInsert = (id: string, views: number, likes: number) =>
  pglite.exec(
    `INSERT INTO "fieldref_posts" ("id","title","slug_column","views","likes","status","review_status","authorId") VALUES ('${id}','${id}','${id}',${views},${likes},'draft','published','u1')`
  );

describe("resolved operand callback cache identity", () => {
  test("two spellings of the same comparison share one cache entry", async () => {
    const client = makeCachedClient(new MemoryCache());
    await seed(client);

    const first = await client.$withCache({ ttl: 60_000 }).post.findMany({
      where: { views: { gt: (ctx: PostCtx) => ctx.fields.likes } },
    });
    expect(first.map((post) => post.id)).toEqual(["hot"]);

    await sneakInsert("sneaky", 999, 1);

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
    expect(second.map((post) => post.id)).toEqual(["hot"]);

    const third = await client.$withCache({ ttl: 60_000 }).post.findMany({
      where: { views: { gte: (ctx: PostCtx) => ctx.fields.likes } },
    });
    expect(third.map((post) => post.id).sort()).toEqual(["hot", "sneaky"]);
  });

  test("a fragment spelling keys apart from a reference spelling", async () => {
    const client = makeCachedClient(new MemoryCache());
    await seed(client);

    const viaCallback = await client.$withCache({ ttl: 60_000 }).post.findMany({
      where: { views: { gt: (ctx: PostCtx) => ctx.fields.likes } },
    });
    expect(viaCallback.map((post) => post.id)).toEqual(["hot"]);

    await sneakInsert("sneaky", 999, 1);

    const viaToken = await client
      .$withCache({ ttl: 60_000 })
      .post.findMany({ where: { views: { gt: sql`"likes"` } } });
    expect(viaToken.map((post) => post.id).sort()).toEqual(["hot", "sneaky"]);

    const again = await client.$withCache({ ttl: 60_000 }).post.findMany({
      where: { views: { gt: (ctx: PostCtx) => ctx.fields.likes } },
    });
    expect(again.map((post) => post.id)).toEqual(["hot"]);
  });

  test("batch execution receives the resolved callback payload", async () => {
    const client = makeClient();
    await seed(client);

    const [posts] = await client.$transaction([
      client.post.findMany({
        where: { views: { gt: (ctx: PostCtx) => ctx.fields.likes } },
      }),
    ]);

    expect(posts.map((post) => post.id)).toEqual(["hot"]);
  });
});
