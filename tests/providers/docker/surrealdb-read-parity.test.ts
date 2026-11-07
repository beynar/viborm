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

const entry = s
  .model({
    id: s.string().id(),
    bookId: s.string(),
    rank: s.int(),
    at: s.dateTime(),
    note: s.string().nullable(),
    amount: s.int().nullable(),
  })
  .index(["rank"])
  .index(["bookId", "rank"])
  .index(["amount"]);
const empty = s.model({ id: s.string().id(), rank: s.int() });
const byRank = (extra: object = {}) => ({
  orderBy: { rank: "desc" },
  select: { id: true },
  ...extra,
});
reads(
  "pages an index walks, and what bounds them",
  { entry, empty },
  async (db) => {
    await db.entry.createMany({
      data: Array.from({ length: 40 }, (_, at) => ({
        // Listed out of key order, so a tie read in the wrong order shows.
        id: `e${String((at * 7) % 40).padStart(2, "0")}`,
        bookId: at % 2 ? "odd" : "even",
        rank: at % 5,
        at: new Date(1_700_000_000_000 + (at % 4) * 1000),
        note: at % 3 ? `n${at % 4}` : null,
        amount: at % 3 ? at : null,
      })),
    });
  },
  [
    [
      "descending, ties by the ascending key",
      "entry",
      "findMany",
      byRank({ take: 10 }),
    ],
    ["the page ends inside a tie", "entry", "findMany", byRank({ take: 3 })],
    ["with a skip", "entry", "findMany", byRank({ take: 5, skip: 7 })],
    [
      "with a skip past the rows",
      "entry",
      "findMany",
      byRank({ take: 5, skip: 100 }),
    ],
    ["longer than the table", "entry", "findMany", byRank({ take: 100 })],
    ["taken from the end", "entry", "findMany", byRank({ take: -6 })],
    [
      "with a filter",
      "entry",
      "findMany",
      byRank({ take: 4, where: { bookId: "odd" } }),
    ],
    [
      "with a filter no row passes",
      "entry",
      "findMany",
      byRank({ take: 4, where: { bookId: "none" } }),
    ],
    [
      "a further term",
      "entry",
      "findMany",
      {
        orderBy: [{ rank: "desc" }, { at: "asc" }],
        select: { id: true },
        take: 7,
      },
    ],
    [
      "ascending under a descending term",
      "entry",
      "findMany",
      {
        orderBy: [{ rank: "asc" }, { id: "desc" }],
        select: { id: true },
        take: 7,
      },
    ],
    [
      "a cursor descending",
      "entry",
      "findMany",
      byRank({ take: 6, cursor: { id: "e13" } }),
    ],
    [
      "a cursor with a skip",
      "entry",
      "findMany",
      byRank({ take: 6, skip: 1, cursor: { id: "e13" } }),
    ],
    [
      "a cursor ascending over two terms",
      "entry",
      "findMany",
      {
        orderBy: [{ rank: "asc" }, { at: "desc" }],
        select: { id: true },
        take: 6,
        cursor: { id: "e21" },
      },
    ],
    [
      "a cursor over a column that may be unset",
      "entry",
      "findMany",
      {
        orderBy: [{ note: { sort: "desc", nulls: "first" } }],
        select: { id: true },
        take: 6,
        cursor: { id: "e21" },
      },
    ],
    [
      "a cursor on a row holding nothing there",
      "entry",
      "findMany",
      {
        orderBy: [{ note: { sort: "asc", nulls: "last" } }],
        select: { id: true },
        take: 6,
        cursor: { id: "e00" },
      },
    ],
    [
      "a cursor that is not there",
      "entry",
      "findMany",
      byRank({ take: 6, cursor: { id: "missing" } }),
    ],
    ["the highest", "entry", "aggregate", { _max: { rank: true } }],
    ["the lowest", "entry", "aggregate", { _min: { rank: true } }],
    [
      "both, of several fields",
      "entry",
      "aggregate",
      { _min: { rank: true, at: true }, _max: { rank: true, at: true } },
    ],
    [
      "of a field that may be unset",
      "entry",
      "aggregate",
      {
        _min: { amount: true, note: true },
        _max: { amount: true, note: true },
      },
    ],
    [
      "of the key",
      "entry",
      "aggregate",
      { _min: { id: true }, _max: { id: true } },
    ],
    [
      "under a filter",
      "entry",
      "aggregate",
      { where: { bookId: "odd" }, _max: { rank: true } },
    ],
    [
      "under a filter no row passes",
      "entry",
      "aggregate",
      {
        where: { bookId: "none" },
        _max: { rank: true },
        _min: { amount: true },
      },
    ],
    ["of no rows", "empty", "aggregate", { _max: { rank: true } }],
    [
      "beside a count",
      "entry",
      "aggregate",
      { _count: true, _max: { rank: true } },
    ],
    ["of a page", "entry", "aggregate", { take: 3, _max: { rank: true } }],
    ...(
      [
        ["first groups", { take: 2 }],
        ["first groups, ascending", { take: 2, orderBy: { rank: "asc" } }],
        ["first groups, descending", { take: 2, orderBy: { rank: "desc" } }],
        ["one group", { take: 1, orderBy: { rank: "desc" } }],
        ["past a skip", { take: 2, skip: 1, orderBy: { rank: "asc" } }],
        ["more than there are", { take: 12, orderBy: { rank: "asc" } }],
        ["past the groups", { take: 2, skip: 9, orderBy: { rank: "asc" } }],
        ["under a filter", { take: 2, where: { bookId: "odd" } }],
        [
          "under a filter no row passes",
          { take: 2, where: { bookId: "none" } },
        ],
        ["with a having", { take: 2, having: { rank: { gt: 1 } } }],
        [
          "of another field",
          { take: 2, orderBy: { _count: { rank: "desc" } } },
        ],
      ] as const
    ).map(
      ([title, input]) =>
        [
          `a group by: ${title}`,
          "entry",
          "groupBy",
          {
            by: ["rank"],
            _count: { _all: true },
            _sum: { amount: true },
            ...input,
          },
        ] as const
    ),
    [
      "a group by over two fields",
      "entry",
      "groupBy",
      {
        by: ["rank", "bookId"],
        _count: { _all: true },
        take: 3,
        orderBy: [{ rank: "desc" }, { bookId: "asc" }],
      },
    ],
    [
      "a group by over a field that may be unset",
      "entry",
      "groupBy",
      {
        by: ["amount"],
        _count: { _all: true },
        take: 3,
        orderBy: { amount: "asc" },
      },
    ],
  ]
);

const shelf = s.model({
  id: s.string().id(),
  volumes: s.toMany(() => volume),
});
const volume = s.model({
  id: s.string().id(),
  shelfId: s.string(),
  pages: s.int(),
  shelf: s
    .toOne(() => shelf)
    .fields("shelfId")
    .references("id"),
});
reads(
  "pages and groups over a foreign key's own index",
  { shelf, volume },
  async (db) => {
    await db.shelf.createMany({
      data: ["s1", "s2", "s3", "s4"].map((id) => ({ id })),
    });
    await db.volume.createMany({
      data: Array.from({ length: 20 }, (_, at) => ({
        id: `v${String((at * 3) % 20).padStart(2, "0")}`,
        shelfId: `s${(at % 4) + 1}`,
        pages: at,
      })),
    });
  },
  [
    [
      "a descending page",
      "volume",
      "findMany",
      { orderBy: { shelfId: "desc" }, select: { id: true }, take: 7 },
    ],
    [
      "a cursor over it",
      "volume",
      "findMany",
      {
        orderBy: { shelfId: "desc" },
        select: { id: true, shelfId: true },
        take: 5,
        cursor: { id: "v09" },
      },
    ],
    [
      "first groups",
      "volume",
      "groupBy",
      { by: ["shelfId"], _sum: { pages: true }, take: 2 },
    ],
    [
      "first groups, descending, past a skip",
      "volume",
      "groupBy",
      {
        by: ["shelfId"],
        _count: { _all: true },
        take: 2,
        skip: 1,
        orderBy: { shelfId: "desc" },
      },
    ],
    [
      "under a filter",
      "volume",
      "groupBy",
      {
        by: ["shelfId"],
        _count: { _all: true },
        take: 2,
        where: { pages: { gt: 10 } },
      },
    ],
    ["its highest", "volume", "aggregate", { _max: { shelfId: true } }],
  ]
);

const library = s.model({
  id: s.string().id(),
  rank: s.int().nullable(),
  books: s.toMany(() => tome),
  loans: s.toMany(() => loan),
});
const tome = s
  .model({
    id: s.string().id(),
    libraryId: s.string(),
    pages: s.int(),
    title: s.string().nullable(),
    library: s
      .toOne(() => library)
      .fields("libraryId")
      .references("id"),
    chapters: s.toMany(() => chapter),
  })
  .index(["libraryId", "pages"]);
const chapter = s.model({
  id: s.string().id(),
  bookId: s.string(),
  tome: s
    .toOne(() => tome)
    .fields("bookId")
    .references("id"),
});
const loan = s.model({
  id: s.string().id(),
  libraryId: s.string(),
  library: s
    .toOne(() => library)
    .fields("libraryId")
    .references("id"),
});
const firstBooks = (extra: object = {}) => ({
  include: { books: { take: 2, select: { id: true }, ...extra } },
  orderBy: { id: "asc" },
});
const newestBooks = { orderBy: { pages: "desc" } };
reads(
  "a page of rows, each with its own page of children",
  { library, tome, chapter, loan },
  async (db) => {
    await db.library.createMany({
      data: ["l1", "l2", "l3", "l4"].map((id, at) => ({
        id,
        rank: at % 2 ? at : null,
      })),
    });
    await db.tome.createMany({
      data: Array.from({ length: 30 }, (_, at) => ({
        id: `b${String((at * 7) % 30).padStart(2, "0")}`,
        // l4 holds nothing.
        libraryId: `l${(at % 3) + 1}`,
        pages: at % 4,
        title: at % 5 ? `t${at % 3}` : null,
      })),
    });
    await db.chapter.createMany({
      data: ["b00", "b01", "b02", "b03", "b07"].map((bookId, at) => ({
        id: `c${at}`,
        bookId,
      })),
    });
    await db.loan.createMany({
      data: [
        { id: "x1", libraryId: "l1" },
        { id: "x2", libraryId: "l1" },
        { id: "x3", libraryId: "l2" },
      ],
    });
  },
  [
    ["in the key's order", "library", "findMany", { ...firstBooks(), take: 3 }],
    [
      "descending, ties by the key",
      "library",
      "findMany",
      { ...firstBooks(newestBooks), take: 3 },
    ],
    [
      "a row holding no children",
      "library",
      "findMany",
      { ...firstBooks(newestBooks), take: 4 },
    ],
    [
      "more rows asked for than there are",
      "library",
      "findMany",
      { ...firstBooks(newestBooks), take: 20 },
    ],
    [
      "past a skip of rows",
      "library",
      "findMany",
      { ...firstBooks(), take: 2, skip: 1 },
    ],
    [
      "past a skip of children",
      "library",
      "findMany",
      { ...firstBooks({ ...newestBooks, skip: 1 }), take: 2 },
    ],
    [
      "children under a filter",
      "library",
      "findMany",
      {
        ...firstBooks({ ...newestBooks, where: { pages: { lt: 2 } } }),
        take: 3,
      },
    ],
    [
      "rows under a filter",
      "library",
      "findMany",
      {
        ...firstBooks(newestBooks),
        take: 2,
        where: { id: { in: ["l3", "l1"] } },
      },
    ],
    [
      "rows descending",
      "library",
      "findMany",
      {
        include: { books: { take: 2, select: { id: true }, ...newestBooks } },
        orderBy: { id: "desc" },
        take: 3,
      },
    ],
    [
      "rows ordered by what may be unset",
      "library",
      "findMany",
      {
        include: { books: { take: 2, select: { id: true } } },
        orderBy: [{ rank: { sort: "desc", nulls: "last" } }, { id: "asc" }],
        take: 3,
      },
    ],
    [
      "children ordered by what may be unset",
      "library",
      "findMany",
      {
        ...firstBooks({ orderBy: { title: { sort: "desc", nulls: "first" } } }),
        take: 3,
      },
    ],
    [
      "two relations",
      "library",
      "findMany",
      {
        include: {
          books: { take: 1, select: { id: true }, ...newestBooks },
          loans: { take: 1, select: { id: true }, orderBy: { id: "desc" } },
        },
        orderBy: { id: "asc" },
        take: 3,
      },
    ],
    [
      "children with their own children",
      "library",
      "findMany",
      {
        include: {
          books: {
            take: 2,
            orderBy: { id: "asc" },
            select: {
              id: true,
              chapters: {
                take: 1,
                select: { id: true },
                orderBy: { id: "desc" },
              },
            },
          },
        },
        orderBy: { id: "asc" },
        take: 2,
      },
    ],
    [
      "the row one key names",
      "library",
      "findUnique",
      {
        where: { id: "l2" },
        include: { books: { take: 2, select: { id: true }, ...newestBooks } },
      },
    ],
    [
      "the row one key does not name",
      "library",
      "findUnique",
      {
        where: { id: "gone" },
        include: { books: { take: 2, select: { id: true }, ...newestBooks } },
      },
    ],
    [
      "the first row",
      "library",
      "findFirst",
      { ...firstBooks(newestBooks), where: { id: "l3" } },
    ],
    [
      "more rows than are read apart",
      "library",
      "findMany",
      { ...firstBooks(newestBooks), take: 21 },
    ],
    ["no take of rows", "library", "findMany", firstBooks(newestBooks)],
    [
      "from a row's own children, up to the row",
      "tome",
      "findMany",
      {
        include: { library: { select: { id: true } } },
        orderBy: { id: "asc" },
        take: 2,
      },
    ],
    [
      "under a relation filter",
      "library",
      "findMany",
      {
        ...firstBooks(),
        where: { books: { some: { pages: 3 } } },
        take: 2,
      },
    ],
    [
      "children under a relation filter",
      "library",
      "findMany",
      {
        ...firstBooks({ where: { chapters: { some: {} } } }),
        take: 2,
      },
    ],
  ]
);

describe.skipIf(!surrealUrl)("a write's own answer", () => {
  it("reads the children as the write left them", async () => {
    const db: any = createClient({
      schema: { library, tome, chapter, loan },
      driver: createSurrealTestDriver(),
    });
    try {
      await syncLiveSchema(db);
      await db.library.create({ data: { id: "l" } });
      await db.tome.create({
        data: { id: "old", libraryId: "l", pages: 1 },
      });
      const include = {
        books: { take: 1, orderBy: { pages: "desc" }, select: { id: true } },
      };
      expect(
        await db.library.update({
          where: { id: "l" },
          data: { books: { create: { id: "new", pages: 9 } } },
          include,
        })
      ).toMatchObject({ books: [{ id: "new" }] });
      expect(
        await db.library.upsert({
          where: { id: "l" },
          update: { books: { create: { id: "newer", pages: 10 } } },
          create: { id: "l" },
          include,
        })
      ).toMatchObject({ books: [{ id: "newer" }] });
      await db.$transaction(async (tx: any) => {
        await tx.tome.create({
          data: { id: "inside", libraryId: "l", pages: 11 },
        });
        expect(
          await tx.library.findUnique({ where: { id: "l" }, include })
        ).toMatchObject({ books: [{ id: "inside" }] });
      });
    } finally {
      await db.$disconnect();
    }
  });
});

describe.skipIf(!surrealUrl)("a page's reach", () => {
  it("a descending page reads its bound from the index, and only with one", async () => {
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
      schema: { entry, empty, shelf, volume },
      driver: driver as never,
    });
    try {
      await syncLiveSchema(db);
      await db.entry.findMany({ orderBy: { rank: "desc" }, take: 2, skip: 3 });
      expect(statements.at(-1)).toContain("LIMIT 1 START 4");
      await db.entry.findMany({ orderBy: { at: "desc" }, take: 2 });
      expect(statements.at(-1)).not.toContain("START");
      await db.entry.findMany({ orderBy: { rank: "asc" }, take: 2 });
      expect(statements.at(-1)).not.toContain("START");
      await db.entry.findMany({ orderBy: { rank: "desc" } });
      expect(statements.at(-1)).not.toContain("START");
      await db.entry.aggregate({ _max: { rank: true } });
      expect(statements.at(-1)).not.toContain("GROUP ALL");
      await db.entry.aggregate({ _max: { rank: true }, _count: true });
      expect(statements.at(-1)).toContain("GROUP ALL");
      const groups = { by: ["rank"], _count: { _all: true } };
      await db.entry.groupBy({ ...groups, take: 2 });
      expect(statements.at(-1)).toContain("rank IN [");
      await db.entry.groupBy({ ...groups, take: 21 });
      expect(statements.at(-1)).not.toContain("rank IN [");
      await db.entry.groupBy(groups);
      expect(statements.at(-1)).not.toContain("rank IN [");
      await db.shelf.findMany({
        take: 2,
        orderBy: { id: "asc" },
        include: { volumes: { take: 1, orderBy: { pages: "desc" } } },
      });
      expect(statements.at(-1)).toContain("array::find_index");
      await db.shelf.findMany({
        take: 21,
        orderBy: { id: "asc" },
        include: { volumes: { take: 1 } },
      });
      expect(statements.at(-1)).not.toContain("array::find_index");
      await db.shelf.findMany({
        take: 2,
        orderBy: { id: "asc" },
        include: { volumes: true },
      });
      expect(statements.at(-1)).not.toContain("array::find_index");
      await db.volume.groupBy({
        by: ["shelfId"],
        _count: { _all: true },
        take: 2,
      });
      expect(statements.at(-1)).toContain("shelfId IN [");
    } finally {
      await db.$disconnect();
    }
  });

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
      for (let depth = 0; depth < 80; depth++)
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
