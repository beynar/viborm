/**
 * The `order` capability: the order a model's reads take when the caller
 * gives none, at the root, in to-many relation reads at any depth, and in a
 * paged aggregate's window; an explicit `orderBy` replaces it; `$extends`
 * refuses what cannot order.
 *
 * Runs on in-memory SQLite.
 */

import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@client/client";
import { ClientInitializationError } from "@errors";
import { defineExtension } from "@extensions/definition";
import { s } from "@schema";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

const board = s.model({
  id: s.string().id(),
  columns: s.toMany(() => column),
});

const column = s.model({
  id: s.string().id(),
  boardId: s.string(),
  board: s
    .toOne(() => board)
    .fields("boardId")
    .references("id"),
  cards: s.toMany(() => card),
});

const card = s.model({
  id: s.string().id(),
  columnId: s.string(),
  rank: s.string(),
  column: s
    .toOne(() => column)
    .fields("columnId")
    .references("id"),
});

const keyless = s.model({ label: s.string() });

const schema = { board, column, card };

// Ids sort the other way round from ranks: a read in key order is visibly
// not in rank order.
const CARDS = [
  { id: "a", columnId: "c1", rank: "4" },
  { id: "b", columnId: "c1", rank: "3" },
  { id: "c", columnId: "c1", rank: "2" },
  { id: "d", columnId: "c2", rank: "1" },
  { id: "e", columnId: "c2", rank: "0" },
];

const byRank = defineExtension({
  name: "by-rank",
  order: { models: { card: [{ columnId: "asc" }, { rank: "asc" }] } },
});

async function fixture() {
  const base = createClient({ schema, driver: createInMemorySQLite3Driver() });
  await syncLiveSchema(base);
  await base.board.create({ data: { id: "b1" } });
  await base.column.createMany({
    data: [
      { id: "c1", boardId: "b1" },
      { id: "c2", boardId: "b1" },
    ],
  });
  await base.card.createMany({ data: CARDS });
  return { base, db: base.$extends(byRank) };
}

const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);

describe("order: reads without orderBy", () => {
  test("a root findMany takes the default order", async () => {
    const { base, db } = await fixture();
    expect(ids(await db.card.findMany())).toEqual(["c", "b", "a", "e", "d"]);
    // The unextended client keeps key order.
    expect(ids(await base.card.findMany())).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("findFirst takes the first row of the default order, and the last with a negative take", async () => {
    const { db } = await fixture();
    expect((await db.card.findFirst())?.id).toBe("c");
    expect((await db.card.findFirst({ take: -1 }))?.id).toBe("d");
  });

  test("a page and a cursor follow the default order", async () => {
    const { db } = await fixture();
    expect(ids(await db.card.findMany({ take: 2, skip: 1 }))).toEqual([
      "b",
      "a",
    ]);
    expect(
      ids(await db.card.findMany({ cursor: { id: "a" }, skip: 1, take: 2 }))
    ).toEqual(["e", "d"]);
    expect(ids(await db.card.findMany({ take: -2 }))).toEqual(["e", "d"]);
  });

  test("a to-many include and select take the default order, nested", async () => {
    const { db } = await fixture();
    const columns = await db.column.findMany({
      orderBy: { id: "asc" },
      include: { cards: true },
    });
    expect(columns.map((entry) => ids(entry.cards))).toEqual([
      ["c", "b", "a"],
      ["e", "d"],
    ]);
    const boards = await db.board.findMany({
      select: { columns: { select: { cards: { select: { id: true } } } } },
    });
    expect(boards[0]!.columns.map((entry) => ids(entry.cards))).toEqual([
      ["c", "b", "a"],
      ["e", "d"],
    ]);
  });

  test("a write's returned relation reads take the default order", async () => {
    const { db } = await fixture();
    const updated = await db.column.update({
      where: { id: "c1" },
      data: {},
      include: { cards: true },
    });
    expect(ids(updated.cards)).toEqual(["c", "b", "a"]);
  });

  test("a paged count counts the rows of the default order's page", async () => {
    const { db } = await fixture();
    // The first two cards in rank order are both in c1; in key order, too.
    expect(await db.card.count({ where: { columnId: "c2" }, take: 1 })).toBe(1);
    const page = await db.card.aggregate({
      take: 2,
      _max: { rank: true },
    });
    // c (rank 2) and b (rank 3): the max is "3". In key order it would be "4".
    expect(page._max.rank).toBe("3");
  });
});

describe("order: the caller's orderBy", () => {
  test("an explicit orderBy replaces the default, at the root and in an include", async () => {
    const { db } = await fixture();
    expect(ids(await db.card.findMany({ orderBy: { id: "desc" } }))).toEqual([
      "e",
      "d",
      "c",
      "b",
      "a",
    ]);
    const [first] = await db.column.findMany({
      where: { id: "c1" },
      include: { cards: { orderBy: { id: "asc" } } },
    });
    expect(ids(first!.cards)).toEqual(["a", "b", "c"]);
  });

  test("orderBy: [] reads in key order", async () => {
    const { db } = await fixture();
    expect(ids(await db.card.findMany({ orderBy: [] }))).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  test("findUnique and groupBy are not ordered by it", async () => {
    const { db } = await fixture();
    expect((await db.card.findUnique({ where: { id: "a" } }))?.rank).toBe("4");
    const groups = await db.card.groupBy({
      by: ["columnId"],
      _count: true,
      orderBy: { columnId: "asc" },
    });
    expect(groups.map((group) => group._count)).toEqual([3, 2]);
  });

  test("a later extension's order replaces an earlier one's for its model", async () => {
    const { db } = await fixture();
    const reversed = db.$extends(
      defineExtension({
        name: "by-rank-desc",
        order: { models: { card: { rank: "desc" } } },
      })
    );
    expect(ids(await reversed.card.findMany())).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });
});

describe("order: cache", () => {
  test("two clients sharing a cache store, one ordered, never share an entry", async () => {
    const { base } = await fixture();
    const store = new MemoryCache();
    const plain = base.$extends(cache({ driver: store }));
    const ordered = plain.$extends(byRank);
    const read = { include: { cards: true }, orderBy: { id: "asc" } } as const;
    const first = await plain.$withCache({ ttl: 60_000 }).column.findMany(read);
    const second = await ordered
      .$withCache({ ttl: 60_000 })
      .column.findMany(read);
    expect(ids(first[0]!.cards)).toEqual(["a", "b", "c"]);
    expect(ids(second[0]!.cards)).toEqual(["c", "b", "a"]);
  });
});

describe("order: admission", () => {
  const base = () =>
    createClient({
      schema: { ...schema, keyless },
      driver: createInMemorySQLite3Driver(),
    });
  const refused = (order: unknown) => () =>
    base().$extends({ name: "bad", order } as never);

  test.each([
    ["not an object", 1],
    ["no models", {}],
    ["an unknown model", { models: { nope: { id: "asc" } } }],
    ["an unknown field", { models: { card: { nope: "asc" } } }],
    ["a relation", { models: { card: { column: "asc" } } }],
    ["a bad direction", { models: { card: { rank: "up" } } }],
    [
      "two fields in one term",
      { models: { card: { rank: "asc", id: "asc" } } },
    ],
    ["no terms", { models: { card: [] } }],
    ["a term that is not an object", { models: { card: ["rank"] } }],
    ["a model without a key", { models: { keyless: { label: "asc" } } }],
  ])("refuses %s", (_, order) => {
    expect(refused(order)).toThrow(ClientInitializationError);
  });
});
