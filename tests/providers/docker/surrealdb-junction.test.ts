/**
 * The SurrealDB prototype's many-to-many relations, as edge tables, against
 * PostgreSQL's junction tables.
 */

import {
  type Client,
  describeWrites,
  type Step,
} from "./surrealdb-write-fixture";

const ids = { orderBy: { id: "asc" }, select: { id: true } } as const;
const byRank = {
  orderBy: { rank: "desc" },
  take: 2,
  select: { id: true, name: true },
} as const;
const postIds = { orderBy: { id: "asc" }, select: { id: true } } as const;
const where = (filter: unknown) => (db: Client) =>
  db.post.findMany({ where: filter, ...postIds });

const STEPS: readonly Step[] = [
  [
    "rows to link",
    async (db) => {
      await db.user.createMany({
        data: ["a", "b", "c"].map((id) => ({ id, email: `${id}@x.io` })),
      });
      return db.tag.createMany({
        data: [
          { id: "x", name: "x", rank: 3, note: "n" },
          { id: "y", name: "y", rank: 1 },
          { id: "z", name: "z", rank: 2, note: "m" },
          { id: "w", name: "w", rank: 9 },
        ],
      });
    },
  ],
  [
    "create, connect several",
    (db) =>
      db.post.create({
        data: {
          id: 1,
          title: "p1",
          rank: 1,
          author: { connect: { id: "a" } },
          tags: { connect: [{ id: "x" }, { id: "y" }, { id: "z" }] },
        },
        select: { id: true, tags: ids },
      }),
  ],
  [
    "create, connect one",
    (db) =>
      db.post.create({
        data: {
          id: 2,
          title: "p2",
          rank: 5,
          author: { connect: { id: "a" } },
          tags: { connect: { id: "y" } },
        },
        select: { id: true, tags: ids },
      }),
  ],
  [
    "connect again changes nothing",
    (db) =>
      db.post.update({
        where: { id: 1 },
        data: { tags: { connect: { id: "x" } } },
        select: { tags: ids },
      }),
  ],
  [
    "connect again, several, changes nothing",
    (db) =>
      db.post.update({
        where: { id: 2 },
        data: { tags: { connect: [{ id: "y" }, { id: "w" }] } },
        select: { tags: ids },
      }),
  ],
  [
    "connect, a missing record refuses",
    (db) =>
      db.post.update({
        where: { id: 1 },
        data: { tags: { connect: { id: "missing" } } },
      }),
  ],
  [
    "create, nested create",
    (db) =>
      db.post.create({
        data: {
          id: 3,
          title: "p3",
          rank: 3,
          author: { connect: { id: "b" } },
          tags: { create: { id: "c1", name: "c1", rank: 4 } },
        },
        select: { tags: ids },
      }),
  ],
  [
    "from the other side, nested create",
    (db) =>
      db.tag.create({
        data: {
          id: "t1",
          name: "t1",
          rank: 7,
          posts: {
            create: {
              id: 4,
              title: "p4",
              rank: 4,
              author: { connect: { id: "c" } },
            },
          },
        },
        select: { posts: ids },
      }),
  ],
  [
    "connectOrCreate, found and created",
    (db) =>
      db.post.update({
        where: { id: 3 },
        data: {
          tags: {
            connectOrCreate: [
              { where: { id: "x" }, create: { id: "x", name: "x", rank: 3 } },
              {
                where: { id: "n1" },
                create: { id: "n1", name: "n1", rank: 6 },
              },
            ],
          },
        },
        select: { tags: ids },
      }),
  ],
  [
    "a second relation between the same models",
    (db) =>
      db.post.update({
        where: { id: 1 },
        data: { highlights: { connect: { id: "w" } } },
        select: { tags: ids, highlights: ids },
      }),
  ],
  [
    "read, each post's highest tags",
    (db) =>
      db.post.findMany({ ...postIds, select: { id: true, tags: byRank } }),
  ],
  [
    "read, skipping",
    (db) =>
      db.post.findUnique({
        where: { id: 1 },
        select: {
          tags: { orderBy: { rank: "asc" }, skip: 1, select: { id: true } },
        },
      }),
  ],
  [
    "read, filtered",
    (db) =>
      db.post.findMany({
        ...postIds,
        select: {
          id: true,
          tags: { where: { rank: { gt: 1 } }, ...ids },
        },
      }),
  ],
  [
    "read from the other side",
    (db) =>
      db.tag.findMany({
        orderBy: { id: "asc" },
        select: {
          id: true,
          posts: { orderBy: { rank: "desc" }, take: 1, select: { id: true } },
          shown: ids,
        },
      }),
  ],
  [
    "read three levels",
    (db) =>
      db.post.findUnique({
        where: { id: 1 },
        select: {
          tags: {
            ...ids,
            select: {
              id: true,
              posts: {
                ...postIds,
                select: {
                  id: true,
                  author: { select: { email: true } },
                  tags: ids,
                },
              },
            },
          },
        },
      }),
  ],
  ["filter, some", where({ tags: { some: { name: "y" } } })],
  ["filter, some with no body", where({ tags: { some: {} } })],
  ["filter, none", where({ tags: { none: { name: "y" } } })],
  ["filter, none with no body", where({ highlights: { none: {} } })],
  ["filter, every", where({ tags: { every: { rank: { gt: 1 } } } })],
  [
    "filter, a negation over a missing value",
    where({ tags: { some: { note: { not: "n" } } } }),
  ],
  [
    "filter, through two relations",
    where({ tags: { some: { posts: { some: { rank: { gt: 3 } } } } } }),
  ],
  [
    "filter, from the other side",
    (db) =>
      db.tag.findMany({
        where: { posts: { some: { title: "p1" } } },
        ...ids,
      }),
  ],
  [
    "follow, a self relation",
    (db) =>
      db.user.update({
        where: { id: "a" },
        data: { following: { connect: [{ id: "b" }, { id: "c" }] } },
        select: { following: ids, followers: ids },
      }),
  ],
  [
    "follow, the other direction",
    (db) =>
      db.user.update({
        where: { id: "b" },
        data: { followers: { connect: { id: "c" } } },
        select: { following: ids, followers: ids },
      }),
  ],
  [
    "read a self relation in both directions",
    (db) =>
      db.user.findMany({
        orderBy: { id: "asc" },
        select: { id: true, following: ids, followers: ids },
      }),
  ],
  [
    "filter a self relation",
    (db) =>
      db.user.findMany({
        where: { followers: { some: { id: "c" } } },
        ...ids,
      }),
  ],
  [
    "update a member",
    (db) =>
      db.post.update({
        where: { id: 1 },
        data: {
          tags: { update: { where: { id: "x" }, data: { name: "x2" } } },
        },
        select: { tags: { ...ids, select: { id: true, name: true } } },
      }),
  ],
  [
    "update a record that is not a member refuses",
    (db) =>
      db.post.update({
        where: { id: 2 },
        data: {
          tags: { update: { where: { id: "x" }, data: { name: "x3" } } },
        },
      }),
  ],
  [
    "updateMany members",
    (db) =>
      db.post.update({
        where: { id: 1 },
        data: {
          tags: {
            updateMany: { where: { rank: { gt: 1 } }, data: { note: "u" } },
          },
        },
        select: { tags: { ...ids, select: { id: true, note: true } } },
      }),
  ],
  [
    "upsert a member, found",
    (db) =>
      db.post.update({
        where: { id: 1 },
        data: {
          tags: {
            upsert: {
              where: { id: "y" },
              create: { id: "y", name: "y", rank: 1 },
              update: { name: "y2" },
            },
          },
        },
        select: { tags: { ...ids, select: { id: true, name: true } } },
      }),
  ],
  [
    "upsert a member, created",
    (db) =>
      db.post.update({
        where: { id: 2 },
        data: {
          tags: {
            upsert: {
              where: { id: "u1" },
              create: { id: "u1", name: "u1", rank: 8 },
              update: { name: "never" },
            },
          },
        },
        select: { tags: ids },
      }),
  ],
  [
    "disconnect",
    (db) =>
      db.post.update({
        where: { id: 1 },
        data: { tags: { disconnect: { id: "y" } } },
        select: { tags: ids },
      }),
  ],
  [
    "disconnect a record that is not a member",
    (db) =>
      db.post.update({
        where: { id: 1 },
        data: { tags: { disconnect: { id: "w" } } },
        select: { tags: ids },
      }),
  ],
  [
    "disconnect leaves the other relation",
    (db) =>
      db.post.findUnique({
        where: { id: 1 },
        select: { tags: ids, highlights: ids },
      }),
  ],
  [
    "set",
    (db) =>
      db.post.update({
        where: { id: 3 },
        data: { tags: { set: [{ id: "x" }, { id: "w" }] } },
        select: { tags: ids },
      }),
  ],
  [
    "set, nothing",
    (db) =>
      db.post.update({
        where: { id: 4 },
        data: { tags: { set: [] } },
        select: { tags: ids },
      }),
  ],
  [
    "delete a member",
    (db) =>
      db.post.update({
        where: { id: 2 },
        data: { tags: { delete: { id: "u1" } } },
        select: { tags: ids },
      }),
  ],
  [
    "deleteMany members",
    (db) =>
      db.post.update({
        where: { id: 3 },
        data: { tags: { deleteMany: { rank: { gt: 8 } } } },
        select: { tags: ids },
      }),
  ],
  [
    "a failure leaves no link",
    (db) =>
      db.post.update({
        where: { id: 1 },
        data: {
          title: "never",
          tags: {
            connect: { id: "c1" },
            update: { where: { id: "missing" }, data: { name: "never" } },
          },
        },
      }),
  ],
  [
    "links in a transaction",
    (db) =>
      db.$transaction(async (t: Client) => {
        await t.post.update({
          where: { id: 4 },
          data: { tags: { connect: { id: "c1" } } },
        });
        return t.post.findUnique({
          where: { id: 4 },
          select: { tags: ids },
        });
      }),
  ],
  [
    "deleting a record takes its links",
    async (db) => {
      await db.tag.delete({ where: { id: "z" } });
      return db.post.findUnique({ where: { id: 1 }, select: { tags: ids } });
    },
  ],
  [
    "deleting the other side takes its links",
    async (db) => {
      await db.post.delete({ where: { id: 4 } });
      return db.tag.findUnique({ where: { id: "c1" }, select: { posts: ids } });
    },
  ],
  [
    "deleting a follower takes both directions",
    async (db) => {
      await db.post.deleteMany({ where: { authorId: "c" } });
      await db.user.delete({ where: { id: "c" } });
      return db.user.findMany({
        orderBy: { id: "asc" },
        select: { id: true, following: ids, followers: ids },
      });
    },
  ],
];

describeWrites(
  "SurrealDB many-to-many relations against PostgreSQL",
  STEPS,
  () => undefined
);
