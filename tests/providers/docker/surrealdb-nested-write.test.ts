/**
 * The SurrealDB write prototype's nested writes against PostgreSQL.
 */

import {
  type Client,
  describeWrites,
  type Step,
} from "./surrealdb-write-fixture";

const posts = {
  orderBy: { id: "asc" },
  select: { id: true, title: true },
} as const;
const STEPS: readonly Step[] = [
  [
    "a parent to connect to",
    (db) =>
      db.user.createMany({
        data: [
          { id: "a", email: "a@x.io" },
          { id: "b", email: "b@x.io" },
        ],
      }),
  ],
  [
    "create, connect",
    (db) =>
      db.post.create({
        data: { id: 1, title: "p1", rank: 1, author: { connect: { id: "a" } } },
      }),
  ],
  [
    "create, connect by unique",
    (db) =>
      db.post.create({
        data: {
          id: 2,
          title: "p2",
          rank: 2,
          author: { connect: { email: "a@x.io" } },
        },
      }),
  ],
  [
    "refused: connect to a missing row",
    (db) =>
      db.post.create({
        data: {
          id: 3,
          title: "x",
          rank: 0,
          author: { connect: { id: "nope" } },
        },
      }),
  ],
  [
    "nothing written by that refusal",
    (db) => db.post.findMany({ where: { id: 3 } }),
  ],
  [
    "create, a to-one created first",
    (db) =>
      db.post.create({
        data: {
          id: 4,
          title: "p4",
          rank: 4,
          author: { create: { id: "c", email: "c@x.io" } },
        },
        select: { id: true, author: { select: { email: true } } },
      }),
  ],
  [
    "create, to-many created after",
    (db) =>
      db.user.create({
        data: {
          id: "d",
          email: "d@x.io",
          posts: {
            create: [
              { id: 5, title: "p5", rank: 5 },
              { id: 6, title: "p6", rank: 6 },
            ],
          },
        },
        select: { id: true, posts },
      }),
  ],
  [
    "create, two levels",
    (db) =>
      db.user.create({
        data: {
          id: "e",
          email: "e@x.io",
          posts: {
            create: {
              id: 7,
              title: "p7",
              rank: 7,
              comments: {
                create: [
                  { id: 1, body: "c1" },
                  { id: 2, body: "c2" },
                ],
              },
            },
          },
        },
        select: {
          id: true,
          posts: {
            select: {
              id: true,
              comments: { orderBy: { id: "asc" }, select: { body: true } },
            },
          },
        },
      }),
  ],
  [
    "refused: a failing child rolls the parent back",
    (db) =>
      db.user.create({
        data: {
          id: "f",
          email: "f@x.io",
          posts: { create: { id: 1, title: "dup", rank: 0 } },
        },
      }),
  ],
  ["the parent is gone", (db) => db.user.findUnique({ where: { id: "f" } })],
  [
    "connectOrCreate, found",
    (db) =>
      db.post.create({
        data: {
          id: 8,
          title: "p8",
          rank: 8,
          author: {
            connectOrCreate: {
              where: { id: "a" },
              create: { id: "a", email: "a@x.io" },
            },
          },
        },
        select: { authorId: true },
      }),
  ],
  [
    "connectOrCreate, created",
    (db) =>
      db.post.create({
        data: {
          id: 9,
          title: "p9",
          rank: 9,
          author: {
            connectOrCreate: {
              where: { id: "g" },
              create: { id: "g", email: "g@x.io" },
            },
          },
        },
        select: { authorId: true },
      }),
  ],
  [
    "create, to-many connect",
    (db) =>
      db.user.create({
        data: { id: "h", email: "h@x.io", posts: { connect: { id: 9 } } },
        select: { id: true, posts },
      }),
  ],
  [
    "update, to-many create",
    (db) =>
      db.user.update({
        where: { id: "b" },
        data: { posts: { create: { id: 10, title: "p10", rank: 10 } } },
        select: { id: true, posts },
      }),
  ],
  [
    "update, to-one connect",
    (db) =>
      db.post.update({
        where: { id: 10 },
        data: { author: { connect: { id: "a" } } },
        select: { authorId: true },
      }),
  ],
  [
    "update, to-one nested update",
    (db) =>
      db.post.update({
        where: { id: 1 },
        data: { author: { update: { name: "Ann" } } },
        select: { author: { select: { name: true } } },
      }),
  ],
  [
    "update, to-many update",
    (db) =>
      db.user.update({
        where: { id: "a" },
        data: {
          posts: { update: { where: { id: 2 }, data: { title: "p2b" } } },
        },
        select: { posts },
      }),
  ],
  [
    "refused: update a child of another parent",
    (db) =>
      db.user.update({
        where: { id: "a" },
        data: {
          posts: { update: { where: { id: 5 }, data: { title: "no" } } },
        },
      }),
  ],
  [
    "update, to-many updateMany",
    (db) =>
      db.user.update({
        where: { id: "a" },
        data: {
          posts: {
            updateMany: { where: { rank: { gt: 1 } }, data: { rank: 50 } },
          },
        },
        select: {
          posts: { orderBy: { id: "asc" }, select: { id: true, rank: true } },
        },
      }),
  ],
  [
    "update, nullable to-one connect",
    (db) =>
      db.post.update({
        where: { id: 1 },
        data: { reviewer: { connect: { id: "b" } } },
        select: { reviewerId: true },
      }),
  ],
  [
    "update, to-one disconnect",
    (db) =>
      db.post.update({
        where: { id: 1 },
        data: { reviewer: { disconnect: true } },
        select: { reviewerId: true },
      }),
  ],
  [
    "update, to-many connect a reviewer",
    (db) =>
      db.user.update({
        where: { id: "b" },
        data: { reviews: { connect: [{ id: 1 }, { id: 2 }] } },
        select: { reviews: posts },
      }),
  ],
  [
    "update, to-many disconnect",
    (db) =>
      db.user.update({
        where: { id: "b" },
        data: { reviews: { disconnect: { id: 1 } } },
        select: { reviews: posts },
      }),
  ],
  [
    "update, to-many set",
    (db) =>
      db.user.update({
        where: { id: "b" },
        data: { reviews: { set: [{ id: 4 }, { id: 5 }] } },
        select: { reviews: posts },
      }),
  ],
  [
    "update, to-many delete",
    (db) =>
      db.user.update({
        where: { id: "d" },
        data: { posts: { delete: { id: 5 } } },
        select: { posts },
      }),
  ],
  [
    "update, to-many deleteMany",
    (db) =>
      db.user.update({
        where: { id: "d" },
        data: { posts: { deleteMany: { rank: { gt: 100 } } } },
        select: { posts },
      }),
  ],
  [
    "update, to-many upsert, created",
    (db) =>
      db.user.update({
        where: { id: "d" },
        data: {
          posts: {
            upsert: {
              where: { id: 11 },
              create: { id: 11, title: "p11", rank: 11 },
              update: { title: "no" },
            },
          },
        },
        select: { posts },
      }),
  ],
  [
    "update, to-many upsert, updated",
    (db) =>
      db.user.update({
        where: { id: "d" },
        data: {
          posts: {
            upsert: {
              where: { id: 11 },
              create: { id: 11, title: "no", rank: 0 },
              update: { title: "p11b" },
            },
          },
        },
        select: { posts },
      }),
  ],
  [
    "createMany with a relation",
    (db) =>
      db.user.createMany({
        data: [
          {
            id: "i",
            email: "i@x.io",
            posts: { create: { id: 12, title: "p12", rank: 12 } },
          },
        ],
      }),
  ],
  [
    "nested in a transaction",
    (db) =>
      db.$transaction(async (t: Client) => {
        await t.user.create({
          data: {
            id: "j",
            email: "j@x.io",
            posts: { create: { id: 13, title: "p13", rank: 13 } },
          },
        });
        return t.post.findUnique({
          where: { id: 13 },
          select: { authorId: true },
        });
      }),
  ],
];

describeWrites(
  "SurrealDB nested writes against PostgreSQL",
  STEPS,
  () => undefined
);
