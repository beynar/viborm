/**
 * The SurrealDB write prototype's root writes against PostgreSQL.
 */

import {
  type Client,
  describeWrites,
  type Step,
} from "./surrealdb-write-fixture";

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

describeWrites(
  "SurrealDB root writes against PostgreSQL",
  STEPS,
  () => undefined
);
