/**
 * The SurrealDB write prototype against PostgreSQL: one script of public writes
 * runs on both, step by step, and every answer, every refusal and the rows left
 * behind must match. Gated on SURREAL_TEST_URL.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { SurrealDriver } from "@drivers/surrealdb";
import { PGlite } from "@electric-sql/pglite";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { Surreal } from "surrealdb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.SURREAL_TEST_URL;

const user = s.model({
  id: s.string().id(),
  email: s.string().unique(),
  name: s.string().nullable(),
  age: s.int().nullable(),
  score: s.int().default(0),
  active: s.boolean().default(true),
  seen: s.dateTime().nullable(),
  posts: s.toMany(() => post).name("wrote"),
  reviews: s.toMany(() => post).name("reviewed"),
});
const post = s.model({
  id: s.int().id(),
  title: s.string(),
  rank: s.int(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .name("wrote")
    .fields("authorId")
    .references("id")
    .onDelete("restrict"),
  reviewerId: s.string().nullable(),
  reviewer: s
    .toOne(() => user)
    .name("reviewed")
    .fields("reviewerId")
    .references("id")
    .onDelete("setNull"),
  comments: s.toMany(() => comment),
});
const comment = s.model({
  id: s.int().id(),
  body: s.string(),
  postId: s.int(),
  post: s
    .toOne(() => post)
    .fields("postId")
    .references("id")
    .onDelete("cascade"),
});
const schema = { user, post, comment };

// biome-ignore lint/suspicious/noExplicitAny: each step names its model and verb.
type Client = any;
type Step = readonly [string, (db: Client) => Promise<unknown>];

const STEPS: readonly Step[] = [
  [
    "create, every scalar",
    (db) =>
      db.user.create({
        data: {
          id: "a",
          email: "a@x.io",
          name: "Ann",
          age: 30,
          seen: new Date("2026-01-02T03:04:05.678Z"),
        },
      }),
  ],
  [
    "create, a null and a default",
    (db) => db.user.create({ data: { id: "b", email: "b@x.io", name: null } }),
  ],
  [
    "create, select",
    (db) =>
      db.user.create({
        data: { id: "c", email: "c@x.io", age: 20 },
        select: { id: true, age: true },
      }),
  ],
  [
    "createMany",
    (db) =>
      db.user.createMany({
        data: [
          { id: "d", email: "d@x.io" },
          { id: "e", email: "e@x.io", age: 7 },
        ],
      }),
  ],
  ["createMany, nothing", (db) => db.user.createMany({ data: [] })],
  [
    "createMany, skipDuplicates",
    (db) =>
      db.user.createMany({
        data: [
          { id: "a", email: "a2@x.io" },
          { id: "f", email: "f@x.io" },
        ],
        skipDuplicates: true,
      }),
  ],
  [
    "refused: duplicate key",
    (db) => db.user.create({ data: { id: "a", email: "other@x.io" } }),
  ],
  [
    "refused: duplicate unique",
    (db) => db.user.create({ data: { id: "z", email: "a@x.io" } }),
  ],
  [
    "create with a link",
    (db) =>
      db.post.create({
        data: { id: 1, title: "p1", rank: 5, authorId: "a", reviewerId: "b" },
      }),
  ],
  [
    "createMany with links",
    (db) =>
      db.post.createMany({
        data: [
          { id: 2, title: "p2", rank: 3, authorId: "a" },
          { id: 3, title: "p3", rank: 9, authorId: "b", reviewerId: "a" },
          { id: 4, title: "p4", rank: 1, authorId: "c" },
        ],
      }),
  ],
  [
    "refused: link to a missing row",
    (db) =>
      db.post.create({
        data: { id: 9, title: "x", rank: 0, authorId: "nobody" },
      }),
  ],
  [
    "comments",
    (db) =>
      db.comment.createMany({
        data: [
          { id: 1, body: "c1", postId: 1 },
          { id: 2, body: "c2", postId: 1 },
          { id: 3, body: "c3", postId: 2 },
        ],
      }),
  ],
  [
    "create, selecting a to-one",
    (db) =>
      db.comment.create({
        data: { id: 4, body: "c4", postId: 2 },
        select: { id: true, post: { select: { title: true } } },
      }),
  ],
  [
    "update",
    (db) =>
      db.user.update({ where: { id: "b" }, data: { name: "Bob", age: 40 } }),
  ],
  [
    "update to null",
    (db) =>
      db.user.update({
        where: { id: "b" },
        data: { name: null },
        select: { id: true, name: true },
      }),
  ],
  [
    "update by unique",
    (db) =>
      db.user.update({
        where: { email: "c@x.io" },
        data: { name: "Cid" },
        select: { name: true },
      }),
  ],
  [
    "update a boolean and a date",
    (db) =>
      db.user.update({
        where: { id: "c" },
        data: { active: false, seen: new Date("2026-03-04T05:06:07.000Z") },
        select: { active: true, seen: true },
      }),
  ],
  [
    "increment",
    (db) =>
      db.user.update({
        where: { id: "a" },
        data: { age: { increment: 2 } },
        select: { age: true },
      }),
  ],
  [
    "increment a null stays null",
    (db) =>
      db.user.update({
        where: { id: "d" },
        data: { age: { increment: 2 } },
        select: { age: true },
      }),
  ],
  [
    "decrement and multiply",
    (db) =>
      db.user.update({
        where: { id: "a" },
        data: { score: { decrement: 3 }, age: { multiply: 2 } },
        select: { score: true, age: true },
      }),
  ],
  [
    "update a link",
    (db) =>
      db.post.update({
        where: { id: 2 },
        data: { reviewerId: "c" },
        select: { reviewerId: true },
      }),
  ],
  [
    "update, selecting relations",
    (db) =>
      db.user.update({
        where: { id: "a" },
        data: { name: "Anna" },
        select: {
          name: true,
          posts: {
            orderBy: { rank: "desc" },
            select: {
              id: true,
              comments: { orderBy: { id: "asc" }, select: { body: true } },
            },
          },
        },
      }),
  ],
  [
    "refused: update a missing row",
    (db) => db.user.update({ where: { id: "nope" }, data: { name: "x" } }),
  ],
  [
    "refused: update to a taken unique",
    (db) => db.user.update({ where: { id: "b" }, data: { email: "a@x.io" } }),
  ],
  [
    "updateMany on a scalar",
    (db) =>
      db.user.updateMany({
        where: { age: { gte: 20 } },
        data: { active: false },
      }),
  ],
  [
    "updateMany on a nullable not",
    (db) =>
      db.user.updateMany({
        where: { age: { not: 7 } },
        data: { score: { increment: 1 } },
      }),
  ],
  [
    "updateMany matches nothing",
    (db) => db.user.updateMany({ where: { id: "nope" }, data: { name: "x" } }),
  ],
  [
    "updateMany on a relation filter",
    (db) =>
      db.user.updateMany({
        where: { posts: { some: { rank: { gt: 4 } } } },
        data: { name: "HasRank" },
      }),
  ],
  [
    "updateMany with a limit",
    (db) =>
      db.post.updateMany({
        where: { authorId: "a" },
        data: { title: "lim" },
        limit: 1,
      }),
  ],
  [
    "upsert, update arm",
    (db) =>
      db.user.upsert({
        where: { id: "b" },
        create: { id: "b", email: "b@x.io" },
        update: { name: "Bobby" },
        select: { name: true },
      }),
  ],
  [
    "upsert, create arm",
    (db) =>
      db.user.upsert({
        where: { id: "g" },
        create: { id: "g", email: "g@x.io" },
        update: { name: "no" },
        select: { id: true, name: true },
      }),
  ],
  [
    "refused: delete a referenced row",
    (db) => db.user.delete({ where: { id: "c" } }),
  ],
  [
    "delete sets a nullable link to null",
    async (db) => {
      await db.post.delete({ where: { id: 4 } });
      await db.user.delete({ where: { id: "c" } });
      return db.post.findUnique({
        where: { id: 2 },
        select: { reviewerId: true },
      });
    },
  ],
  [
    "delete cascades",
    async (db) => {
      const gone = await db.post.delete({
        where: { id: 2 },
        select: { id: true, title: true },
      });
      return [
        gone,
        await db.comment.findMany({
          orderBy: { id: "asc" },
          select: { id: true },
        }),
      ];
    },
  ],
  ["delete, every scalar", (db) => db.user.delete({ where: { id: "g" } })],
  [
    "refused: delete a missing row",
    (db) => db.user.delete({ where: { id: "nope" } }),
  ],
  ["deleteMany", (db) => db.comment.deleteMany({ where: { body: "c1" } })],
  [
    "deleteMany on a relation filter",
    (db) =>
      db.user.deleteMany({
        where: { posts: { none: {} }, reviews: { none: {} } },
      }),
  ],
  [
    "deleteMany with a limit",
    (db) => db.comment.deleteMany({ where: { postId: 1 }, limit: 1 }),
  ],
  [
    "transaction commits",
    (db) =>
      db.$transaction(async (t: Client) => {
        await t.user.create({ data: { id: "t1", email: "t1@x.io" } });
        await t.user.update({ where: { id: "t1" }, data: { name: "T" } });
        return t.user.findUnique({
          where: { id: "t1" },
          select: { name: true },
        });
      }),
  ],
  [
    "transaction rolls back",
    async (db) => {
      const failure = await db
        .$transaction(async (t: Client) => {
          await t.user.create({ data: { id: "t2", email: "t2@x.io" } });
          throw new Error("boom");
        })
        .catch((error: Error) => error.message);
      return [failure, await db.user.findUnique({ where: { id: "t2" } })];
    },
  ],
  [
    "a failing statement rolls a transaction back",
    async (db) => {
      const failed = await db
        .$transaction(async (t: Client) => {
          await t.user.create({ data: { id: "t3", email: "t3@x.io" } });
          await t.user.create({ data: { id: "t4", email: "a@x.io" } });
        })
        .then(
          () => false,
          () => true
        );
      return [failed, await db.user.findUnique({ where: { id: "t3" } })];
    },
  ],
  [
    "array transaction",
    (db) =>
      db.$transaction([
        db.user.create({
          data: { id: "t5", email: "t5@x.io" },
          select: { id: true },
        }),
        db.user.update({
          where: { id: "t5" },
          data: { age: 1 },
          select: { age: true },
        }),
      ]),
  ],
];

const outcome = async (run: () => Promise<unknown>) => {
  try {
    return { answer: await run() };
  } catch (error) {
    return {
      refused: (error as Error).constructor.name,
      code: (error as { code?: string }).code,
    };
  }
};

describe.skipIf(!url)("SurrealDB write prototype against PostgreSQL", () => {
  let surreal: Surreal;
  let pglite: PGlite;
  let onSurreal: Client;
  let onPostgres: Client;

  beforeAll(async () => {
    surreal = new Surreal();
    const database = `write_${Date.now()}`;
    await surreal.connect(url!, {
      authentication: { username: "root", password: "root" },
    });
    await surreal.query(
      `DEFINE NAMESPACE IF NOT EXISTS viborm; USE NS viborm; DEFINE DATABASE ${database};`
    );
    await surreal.use({ namespace: "viborm", database });
    await surreal.query(`
      DEFINE TABLE user SCHEMAFULL; DEFINE FIELD email ON user TYPE string; DEFINE FIELD name ON user TYPE option<string>; DEFINE FIELD age ON user TYPE option<int>; DEFINE FIELD score ON user TYPE int; DEFINE FIELD active ON user TYPE bool; DEFINE FIELD seen ON user TYPE option<datetime>;
      DEFINE INDEX user_email ON user FIELDS email UNIQUE;
      DEFINE TABLE post SCHEMAFULL; DEFINE FIELD title ON post TYPE string; DEFINE FIELD rank ON post TYPE int;
      DEFINE FIELD authorId ON post TYPE record<user> REFERENCE ON DELETE REJECT ASSERT $value.exists();
      DEFINE FIELD reviewerId ON post TYPE option<record<user>> REFERENCE ON DELETE UNSET ASSERT $value = NONE OR $value.exists();
      DEFINE INDEX post_author ON post FIELDS authorId; DEFINE INDEX post_reviewer ON post FIELDS reviewerId;
      DEFINE TABLE comment SCHEMAFULL; DEFINE FIELD body ON comment TYPE string;
      DEFINE FIELD postId ON comment TYPE record<post> REFERENCE ON DELETE CASCADE ASSERT $value.exists();
      DEFINE INDEX comment_post ON comment FIELDS postId;
    `);
    onSurreal = createClient({ schema, driver: new SurrealDriver(surreal) });
    pglite = new PGlite();
    onPostgres = createClient({
      schema,
      driver: new PGliteDriver({ client: pglite }),
    });
    await syncLiveSchema(onPostgres);
  }, 120_000);

  afterAll(async () => {
    await surreal?.close();
    await pglite?.close();
  });

  it.each(STEPS)("%s", async (_, step) => {
    const expected = await outcome(() => step(onPostgres));
    const answered = await outcome(() => step(onSurreal));
    expect(answered).toEqual(expected);
  });

  it("leaves the same rows", async () => {
    for (const [model, order] of [
      ["user", { id: "asc" }],
      ["post", { id: "asc" }],
      ["comment", { id: "asc" }],
    ] as const) {
      const expected = await onPostgres[model].findMany({ orderBy: order });
      expect(await onSurreal[model].findMany({ orderBy: order })).toEqual(
        expected
      );
    }
  });

  it("refuses what it does not cover, by name", async () => {
    await expect(
      onSurreal.user.update({ where: { id: "a" }, data: { id: "a2" } })
    ).rejects.toThrow("changing a record's key");
    await expect(
      onSurreal.post.create({
        data: { title: "x", rank: 0, id: 50, author: { connect: { id: "a" } } },
      })
    ).rejects.toThrow("speaks no SQL");
    await expect(onSurreal.user.count({})).rejects.toThrow(
      "SurrealDB read backend"
    );
  });
});
