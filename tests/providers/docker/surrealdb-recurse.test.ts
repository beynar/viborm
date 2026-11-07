/**
 * The SurrealDB prototype's `recurse`, in a read and in a filter, against
 * PostgreSQL's recursive queries: a tree over a foreign key, and a graph with a
 * cycle over a junction.
 */

import {
  type Client,
  describeWrites,
  type Step,
} from "./surrealdb-write-fixture";

const seed = async (db: Client) => {
  for (const [id, parentId, rank] of [
    ["root", null, 1],
    ["a", "root", 2],
    ["b", "root", 1],
    ["a1", "a", 1],
    ["a2", "a", 2],
    ["a11", "a1", 1],
    ["other", null, 9],
  ] as const)
    await db.node.create({
      data: { id, name: id, rank, ...(parentId ? { parentId } : {}) },
    });
  await db.node.update({
    where: { id: "root" },
    data: { links: { connect: [{ id: "a" }, { id: "b" }] } },
  });
  await db.node.update({
    where: { id: "a" },
    data: { links: { connect: { id: "a1" } } },
  });
  await db.node.update({
    where: { id: "a1" },
    data: { links: { connect: { id: "root" } } },
  });
  return true;
};

const read =
  (select: Record<string, unknown>, id = "root") =>
  (db: Client) =>
    db.node.findUnique({ where: { id }, select: { id: true, ...select } });
const ids = (where: unknown) => (db: Client) =>
  db.node.findMany({ where, orderBy: { id: "asc" }, select: { id: true } });
const name = { id: true, name: true } as const;

const STEPS: readonly Step[] = [
  ["rows to walk", seed],
  [
    "a tree, one level",
    read({
      children: {
        recurse: { depth: 1 },
        orderBy: { rank: "asc" },
        select: name,
      },
    }),
  ],
  [
    "a tree, three levels",
    read({
      children: {
        recurse: { depth: 3 },
        orderBy: { rank: "desc" },
        select: name,
      },
    }),
  ],
  [
    "a tree, every level",
    read({
      children: {
        recurse: { depth: false },
        orderBy: { id: "asc" },
        select: name,
      },
    }),
  ],
  [
    "a tree, narrowed at each level",
    read({
      children: {
        recurse: { depth: false },
        where: { rank: { lt: 2 } },
        orderBy: { id: "asc" },
        select: name,
      },
    }),
  ],
  [
    "up a tree, to one parent at a time",
    read({ parent: { recurse: { depth: false }, select: name } }, "a11"),
  ],
  [
    "up a tree, stopping short",
    read({ parent: { recurse: { depth: 1 }, select: name } }, "a11"),
  ],
  [
    "a record with nothing to walk",
    read({ children: { recurse: { depth: false }, select: name } }, "other"),
  ],
  [
    "a graph, cut off at a depth",
    read({
      links: { recurse: { depth: 2 }, orderBy: { id: "asc" }, select: name },
    }),
  ],
  [
    "a graph with a cycle refuses by default",
    read({
      links: {
        recurse: { depth: false },
        orderBy: { id: "asc" },
        select: name,
      },
    }),
  ],
  [
    "a graph with a cycle, prevented",
    read({
      links: {
        recurse: { depth: false, cycles: "prevent" },
        orderBy: { id: "asc" },
        select: name,
      },
    }),
  ],
  [
    "a walk beside other rows",
    (db) =>
      db.node.findMany({
        where: { parentId: null },
        orderBy: { id: "asc" },
        select: {
          id: true,
          children: {
            recurse: { depth: 2 },
            orderBy: { id: "asc" },
            select: name,
          },
        },
      }),
  ],
  [
    "filter, some descendant",
    ids({ children: { recurse: { depth: false }, some: { name: "a11" } } }),
  ],
  [
    "filter, some within a depth",
    ids({ children: { recurse: { depth: 1 }, some: { name: "a11" } } }),
  ],
  [
    "filter, no descendant",
    ids({ children: { recurse: { depth: false }, none: { name: "a11" } } }),
  ],
  [
    "filter, every descendant",
    ids({
      children: { recurse: { depth: false }, every: { rank: { lt: 2 } } },
    }),
  ],
  [
    "filter, the record itself counts",
    ids({
      children: {
        recurse: { depth: false },
        self: true,
        some: { name: "a11" },
      },
    }),
  ],
  [
    "filter, an ancestor",
    ids({ parent: { recurse: { depth: false }, some: { name: "root" } } }),
  ],
  [
    "filter, across a cycle",
    ids({ links: { recurse: { depth: false }, some: { name: "b" } } }),
  ],
];

describeWrites("SurrealDB recurse against PostgreSQL", STEPS, () => undefined);
