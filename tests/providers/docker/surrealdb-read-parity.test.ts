/**
 * The same public reads on SurrealDB and on PGlite, compared whole. Gated on
 * SURREAL_TEST_URL.
 */

import { createClient } from "@client/client";
import { UnsupportedOperationError } from "@errors";
import { s } from "@schema";
import {
  createSurrealTestDriver,
  surrealUrl,
} from "@tests/fixtures/drivers/surrealdb";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, it } from "vitest";
import { reads } from "./surrealdb-parity-fixture";

const seat = s
  .model({
    roomId: s.string(),
    guestId: s.string(),
    note: s.string().nullable(),
    room: s
      .toOne(() => room)
      .fields("roomId")
      .references("id"),
    guest: s
      .toOne(() => guest)
      .fields("guestId")
      .references("id"),
  })
  .id(["roomId", "guestId"]);
const room = s.model({
  id: s.string().id(),
  guests: s
    .toMany(() => guest)
    .through(() => seat)
    .source("room")
    .target("guest"),
});
const guest = s.model({
  id: s.string().id(),
  name: s.string().nullable(),
  rooms: s.toMany(() => room),
});
const yes = { guests: { every: { $through: { note: "yes" } } } };
reads(
  "every through a link field that may be unset",
  { room, guest, seat },
  async (db) => {
    await db.room.createMany({
      data: [
        { id: "unknown" },
        { id: "no" },
        { id: "yes" },
        { id: "both" },
        { id: "empty" },
      ],
    });
    await db.guest.createMany({
      data: [{ id: "g1", name: "a" }, { id: "g2" }],
    });
    await db.seat.createMany({
      data: [
        { roomId: "unknown", guestId: "g1", note: null },
        { roomId: "no", guestId: "g1", note: "no" },
        { roomId: "yes", guestId: "g1", note: "yes" },
        { roomId: "both", guestId: "g2", note: "yes" },
      ],
    });
  },
  [
    [
      "every keeps an unknown comparison",
      "room",
      "findMany",
      { where: yes, select: { id: true }, orderBy: { id: "asc" } },
    ],
    [
      "its negation keeps it too",
      "room",
      "findMany",
      { where: { NOT: yes }, select: { id: true }, orderBy: { id: "asc" } },
    ],
    [
      "with a test of the row beside it",
      "room",
      "findMany",
      {
        where: { guests: { every: { name: "a", $through: { note: "yes" } } } },
        select: { id: true },
        orderBy: { id: "asc" },
      },
    ],
  ]
);

const owner = s.model({ id: s.int().id(), items: s.toMany(() => item) });
const item = s.model({
  id: s.int().id(),
  category: s.string(),
  rank: s.int(),
  ownerId: s.int(),
  owner: s
    .toOne(() => owner)
    .fields("ownerId")
    .references("id"),
});
const page = {
  distinct: ["category"],
  cursor: { id: 2 },
  orderBy: { id: "asc" },
  select: { id: true },
};
reads(
  "a tuple's row is chosen after the cursor",
  { item, owner },
  async (db) => {
    await db.owner.create({ data: { id: 1 } });
    await db.item.createMany({
      data: [
        { id: 1, category: "a", rank: 5, ownerId: 1 },
        { id: 2, category: "a", rank: 4, ownerId: 1 },
        { id: 3, category: "b", rank: 3, ownerId: 1 },
        { id: 4, category: "a", rank: 2, ownerId: 1 },
        { id: 5, category: "b", rank: 1, ownerId: 1 },
      ],
    });
  },
  [
    ["the root", "item", "findMany", page],
    ["a relation", "owner", "findMany", { select: { id: true, items: page } }],
    [
      "the root, backward",
      "item",
      "findMany",
      { ...page, cursor: { id: 4 }, take: -2 },
    ],
    [
      "a relation, backward",
      "owner",
      "findMany",
      { select: { id: true, items: { ...page, cursor: { id: 4 }, take: -2 } } },
    ],
    [
      "the root, by another order",
      "item",
      "findMany",
      { ...page, orderBy: { rank: "desc" }, cursor: { id: 2 }, take: 5 },
    ],
    ["a page past it", "item", "findMany", { ...page, take: 1, skip: 1 }],
  ]
);

const doc = s.model({ id: s.int().id(), data: s.json() });
reads(
  "a JSON path is text an index may read",
  { doc },
  async (db) => {
    await db.doc.createMany({
      data: [
        { id: 1, data: { "01": "leading" } },
        { id: 2, data: { "1": "plain" } },
        { id: 3, data: ["zero", "plain"] },
        { id: 4, data: { list: [{ "a b": "deep" }] } },
      ],
    });
  },
  [
    [
      "an index past the end reads nothing",
      "doc",
      "findMany",
      {
        where: { data: { path: ["-9"], equals: "zero" } },
        select: { id: true },
      },
    ],
    [
      "and neither does its negation",
      "doc",
      "findMany",
      {
        where: { NOT: { data: { path: ["-9"], equals: "zero" } } },
        select: { id: true },
      },
    ],
    [
      "a leading zero reads an index and no other key",
      "doc",
      "findMany",
      {
        where: { data: { path: ["01"], equals: "plain" } },
        select: { id: true },
      },
    ],
    [
      "a negative index counts from the end",
      "doc",
      "findMany",
      {
        where: { data: { path: ["-1"], equals: "plain" } },
        select: { id: true },
      },
    ],
    [
      "01 reads no other key",
      "doc",
      "findMany",
      {
        where: { data: { path: ["01"], equals: "leading" } },
        select: { id: true },
      },
    ],
    [
      "1 reads a key and an index",
      "doc",
      "findMany",
      {
        where: { data: { path: ["1"], equals: "plain" } },
        select: { id: true },
        orderBy: { id: "asc" },
      },
    ],
    [
      "a key spelled with anything",
      "doc",
      "findMany",
      {
        where: { data: { path: ["list", "0", "a b"], equals: "deep" } },
        select: { id: true },
      },
    ],
  ]
);

const row = s.model({
  id: s.int().id(),
  category: s.string(),
  n: s.int().nullable(),
});
const summed = (having: object) => ({
  by: ["category"],
  having,
  _sum: { n: true },
  orderBy: { category: "asc" },
});
const group = (orderBy: object, extra: object = {}) => ({
  _count: true,
  orderBy,
  ...extra,
});
reads(
  "an aggregate of no values is NULL",
  { row },
  async (db) => {
    await db.row.createMany({
      data: [
        { id: 1, category: "none", n: null },
        { id: 2, category: "low", n: 1 },
        { id: 3, category: "high", n: 9 },
      ],
    });
  },
  [
    [
      "NOT keeps an unknown comparison",
      "row",
      "groupBy",
      summed({ NOT: { n: { _sum: { gt: 0 } } } }),
    ],
    [
      "two NOTs read as neither",
      "row",
      "groupBy",
      summed({ NOT: [{ n: { _sum: { gt: 5 } } }, { n: { _sum: { lt: 0 } } }] }),
    ],
    [
      "NOT over OR",
      "row",
      "groupBy",
      summed({
        NOT: { OR: [{ n: { _sum: { gt: 5 } } }, { category: "none" }] },
      }),
    ],
    [
      "equals null beside another test",
      "row",
      "groupBy",
      summed({ n: { _sum: { equals: null, gt: 0 } } }),
    ],
    [
      "equals null alone",
      "row",
      "groupBy",
      summed({ n: { _sum: { equals: null } } }),
    ],
    ["not null", "row", "groupBy", summed({ n: { _sum: { not: null } } })],
    [
      "not a value keeps it out",
      "row",
      "groupBy",
      summed({ n: { _sum: { not: 1 } } }),
    ],
    [
      "NOT equals null",
      "row",
      "groupBy",
      summed({ NOT: { n: { _sum: { equals: null } } } }),
    ],
    ["in an empty list", "row", "groupBy", summed({ n: { _sum: { in: [] } } })],
    [
      "not in an empty list",
      "row",
      "groupBy",
      summed({ n: { _sum: { notIn: [] } } }),
    ],
    [
      "a nullable key, ascending",
      "row",
      "groupBy",
      { by: ["n"], ...group({ n: "asc" }, { take: 1 }) },
    ],
    [
      "a nullable key, descending",
      "row",
      "groupBy",
      { by: ["n"], ...group({ n: "desc" }, { take: 1 }) },
    ],
    [
      "a nullable key, nulls first",
      "row",
      "groupBy",
      { by: ["n"], ...group({ n: { sort: "asc", nulls: "first" } }) },
    ],
    [
      "a nullable key, by default",
      "row",
      "groupBy",
      { by: ["n"], _count: true },
    ],
    [
      "a sum, ascending",
      "row",
      "groupBy",
      { by: ["category"], _sum: { n: true }, orderBy: { _sum: { n: "asc" } } },
    ],
    [
      "a sum, descending",
      "row",
      "groupBy",
      { by: ["category"], _sum: { n: true }, orderBy: { _sum: { n: "desc" } } },
    ],
    [
      "a minimum, ascending",
      "row",
      "groupBy",
      { by: ["category"], _min: { n: true }, orderBy: { _min: { n: "asc" } } },
    ],
    [
      "an average, descending",
      "row",
      "groupBy",
      { by: ["category"], _avg: { n: true }, orderBy: { _avg: { n: "desc" } } },
    ],
  ]
);

const book = s.model({
  id: s.string().id(),
  galleries: s.toMany(() => gallery),
});
const clip = s.model({
  id: s.string().id(),
  galleries: s.toMany(() => gallery),
});
const gallery = s.model({
  id: s.string().id(),
  items: s.toMany({ book: () => book, clip: () => clip }),
});
const counted = (sort: string) => ({
  orderBy: { items: { _count: sort } },
  select: { id: true, _count: { select: { items: true } } },
});
reads(
  "a polymorphic collection counts every variant",
  { gallery, book, clip },
  async (db) => {
    await db.book.create({ data: { id: "b1" } });
    await db.clip.createMany({ data: [{ id: "c1" }, { id: "c2" }] });
    await db.gallery.create({
      data: {
        id: "g1",
        items: {
          connect: [
            { type: "clip", where: { id: "c1" } },
            { type: "clip", where: { id: "c2" } },
          ],
        },
      },
    });
    await db.gallery.create({
      data: {
        id: "g2",
        items: { connect: [{ type: "book", where: { id: "b1" } }] },
      },
    });
  },
  [
    ["descending", "gallery", "findMany", counted("desc")],
    ["ascending", "gallery", "findMany", counted("asc")],
  ]
);

const person = s.model({
  id: s.string().id(),
  teamId: s.string().nullable(),
  team: s
    .toOne(() => team)
    .fields("teamId")
    .references("id"),
});
const team = s.model({ id: s.string().id(), people: s.toMany(() => person) });
const member = s
  .model({ org: s.string(), slug: s.string() })
  .id(["org", "slug"]);
const insensitive = (filter: object) => ({ ...filter, mode: "insensitive" });
const persons = (where: object) => ({
  where,
  select: { id: true },
  orderBy: { id: "asc" },
});
reads(
  "a key or a link read as text",
  { person, team, member },
  async (db) => {
    await db.team.create({ data: { id: "Blue" } });
    await db.person.create({ data: { id: "A", teamId: "Blue" } });
    await db.person.create({ data: { id: "b" } });
    await db.member.create({ data: { org: "Acme", slug: "x" } });
  },
  [
    [
      "a key equals, in any case",
      "person",
      "findMany",
      persons({ id: insensitive({ equals: "a" }) }),
    ],
    [
      "a key in a list",
      "person",
      "findMany",
      persons({ id: insensitive({ in: ["a", "B"] }) }),
    ],
    [
      "a key outside a list",
      "person",
      "findMany",
      persons({ id: insensitive({ notIn: ["a"] }) }),
    ],
    [
      "a key, negated",
      "person",
      "findMany",
      persons({ NOT: { id: insensitive({ equals: "a" }) } }),
    ],
    [
      "a link equals, in any case",
      "person",
      "findMany",
      persons({ teamId: insensitive({ equals: "BLUE" }) }),
    ],
    [
      "a link's pattern",
      "person",
      "findMany",
      persons({ teamId: { contains: "lu" } }),
    ],
    [
      "a link's pattern, in any case",
      "person",
      "findMany",
      persons({ teamId: insensitive({ startsWith: "BL" }) }),
    ],
    [
      "a key's pattern",
      "person",
      "findMany",
      persons({ id: { startsWith: "A" } }),
    ],
    [
      "a compound key's part",
      "member",
      "findMany",
      { where: { org: insensitive({ equals: "ACME" }) } },
    ],
    [
      "a compound key's pattern",
      "member",
      "findMany",
      { where: { org: { contains: "cm" } } },
    ],
  ]
);

const writer = s.model({ id: s.int().id(), posts: s.toMany(() => article) });
const article = s.model({
  id: s.int().id(),
  title: s.string(),
  writerId: s.int(),
  writer: s
    .toOne(() => writer)
    .fields("writerId")
    .references("id"),
});
const WRITERS = 40;
const ARTICLES = 1200;
const writers = (where: object, extra: object = {}) => ({
  where,
  select: { id: true },
  orderBy: { id: "asc" },
  ...extra,
});
reads(
  "a page over a filter whose rows pass what it reads ahead",
  { writer, article },
  async (db) => {
    await db.writer.createMany({
      data: Array.from({ length: WRITERS }, (_, index) => ({ id: index + 1 })),
    });
    await db.article.createMany({
      data: Array.from({ length: ARTICLES }, (_, index) => ({
        id: index + 1,
        // Past the list's reach, only the last writers have what it asks.
        title: index < 1100 ? `broad ${index}` : `rare ${index}`,
        writerId: index < 1100 ? WRITERS : (index % 3) + 1,
      })),
    });
  },
  [
    [
      "a broad body, by walking",
      "writer",
      "findMany",
      writers(
        { posts: { some: { title: { startsWith: "broad" } } } },
        { take: 2 }
      ),
    ],
    [
      "a rare body, by its list",
      "writer",
      "findMany",
      writers(
        { posts: { some: { title: { startsWith: "rare" } } } },
        { take: 2 }
      ),
    ],
    [
      "a broad body with a test beside it",
      "writer",
      "findMany",
      writers(
        { id: { lt: 41 }, posts: { some: { title: { startsWith: "broad" } } } },
        { take: 1 }
      ),
    ],
    [
      "a broad body, past a cursor",
      "writer",
      "findMany",
      writers(
        { posts: { some: { title: { contains: "a" } } } },
        { cursor: { id: 2 }, take: 5 }
      ),
    ],
    [
      "a broad body, from the end",
      "writer",
      "findMany",
      writers(
        { posts: { some: { title: { startsWith: "broad" } } } },
        { take: -1 }
      ),
    ],
    [
      "no page at all",
      "writer",
      "findMany",
      writers({ posts: { some: { title: { startsWith: "broad" } } } }),
    ],
  ]
);

describe.skipIf(!surrealUrl)("a page's reach", () => {
  it("a page lists no further than it reads ahead, whichever way it answers", async () => {
    const driver = createSurrealTestDriver() as unknown as {
      execute: (...args: unknown[]) => Promise<unknown>;
    };
    const statements: string[] = [];
    const execute = driver.execute;
    driver.execute = function (this: unknown, ...args: unknown[]) {
      statements.push(args[1] as string);
      return execute.apply(this, args);
    };
    const db: any = createClient({
      schema: { writer, article },
      driver: driver as never,
    });
    try {
      await syncLiveSchema(db);
      await db.writer.findMany({
        where: { posts: { some: { title: { startsWith: "b" } } } },
        take: 1,
      });
      const read = statements.at(-1)!;
      expect(read).toContain("LIMIT 1000");
      // The rows it read ahead, and those made a list: the walk lists nothing more.
      expect(read.match(/LET /g)).toHaveLength(2);
    } finally {
      await db.$disconnect();
    }
  });
});

describe.skipIf(!surrealUrl)("what a server refuses", () => {
  it("a read past the parser's depth names what to change", async () => {
    const node = s.model({
      id: s.string().id(),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => node)
        .name("tree")
        .fields("parentId")
        .references("id"),
      children: s.toMany(() => node).name("tree"),
    });
    const db: any = createClient({
      schema: { node },
      driver: createSurrealTestDriver(),
    });
    try {
      await syncLiveSchema(db);
      let select: object = { id: true };
      for (let depth = 0; depth < 20; depth++)
        select = { id: true, children: { select } };
      const failure = await db.node
        .findMany({ select })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(UnsupportedOperationError);
      expect((failure as Error).message).toContain(
        "SURREAL_MAX_QUERY_PARSING_DEPTH"
      );
    } finally {
      await db.$disconnect();
    }
  });
});
