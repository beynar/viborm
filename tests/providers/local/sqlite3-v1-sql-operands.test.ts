import { createClient } from "@drivers/sqlite3";
import { UnsupportedOperationError } from "@errors";
import { s } from "@schema";
import { createModelFieldRefs } from "@schema/field-ref";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, expect, test } from "vitest";

const parent = s.model({ id: s.int().id(), entries: s.toMany(() => entry) });
const entry = s.model({
  id: s.int().id(),
  score: s.int().map("observed_score"),
  floor: s.int().map("required_floor"),
  parentId: s.int(),
  parent: s
    .toOne(() => parent)
    .fields("parentId")
    .references("id"),
});
const compact = s.model({ id: s.string().id().ulid(), group: s.string() });
const list = s.model({ id: s.int().id(), keys: s.bigInt().array() });
const db = createClient({ schema: { parent, entry, compact, list } });
const parentRefs = createModelFieldRefs("parent", parent);

beforeAll(async () => {
  await syncLiveSchema(db);
  await db.parent.createMany({ data: [{ id: 1 }, { id: 2 }] });
  await db.entry.createMany({
    data: [
      { id: 1, score: 12, floor: 10, parentId: 1 },
      { id: 2, score: 13, floor: 10, parentId: 1 },
      { id: 3, score: 4, floor: 10, parentId: 2 },
    ],
  });
});
afterAll(() => db.$disconnect());

test("SQL field interpolations resolve mapped columns in root and relation aliases", async () => {
  const delta = 2;
  expect(
    await db.entry.findMany({
      where: {
        score: { gt: (ctx) => ctx.sql`${ctx.fields.floor} + ${delta}` },
      },
      select: { id: true },
    })
  ).toEqual([{ id: 2 }]);
  expect(
    await db.parent.findMany({
      where: {
        entries: {
          some: {
            score: { gt: (ctx) => ctx.sql`${ctx.fields.floor} + ${delta}` },
          },
        },
      },
      include: {
        entries: {
          where: {
            score: { gt: (ctx) => ctx.sql`${ctx.fields.floor} + ${delta}` },
          },
        },
      },
    })
  ).toEqual([
    { id: 1, entries: [{ id: 2, score: 13, floor: 10, parentId: 1 }] },
  ]);
});

test("SQL parameters cannot smuggle references from another model or an object", async () => {
  await expect(
    db.entry.count({
      where: { score: { gt: (ctx) => ctx.sql`${parentRefs.id}` } },
    })
  ).rejects.toMatchObject({
    code: "V8003",
    message: expect.stringContaining("same model"),
  });
  await expect(
    db.entry.count({
      where: {
        score: { gt: (ctx) => ctx.sql`${{ deep: [ctx.fields.floor] }}` },
      },
    })
  ).rejects.toMatchObject({
    code: "V8003",
    message: expect.stringContaining("direct interpolation"),
  });
  expect(await db.entry.count()).toBe(3);
});

test("cursor relation order is an explicit unsupported capability", async () => {
  await expect(
    db.entry.findMany({
      cursor: { id: 1 },
      orderBy: { parent: { id: "asc" } },
    })
  ).rejects.toBeInstanceOf(UnsupportedOperationError);
  await expect(
    db.parent.findMany({
      cursor: { id: 1 },
      orderBy: { entries: { _count: "asc" } },
    })
  ).rejects.toBeInstanceOf(UnsupportedOperationError);
});

test("compact identifier HAVING min/max compares transported operands", async () => {
  const low = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const high = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
  await db.compact.createMany({
    data: [
      { id: low, group: "shared" },
      { id: high, group: "shared" },
    ],
  });
  expect(
    await db.compact.groupBy({
      by: ["group"],
      having: {
        id: {
          _min: { equals: low },
          _max: { equals: high },
          _count: { equals: 2 },
        },
      },
      _min: { id: true },
      _max: { id: true },
      _count: true,
    })
  ).toEqual([
    { group: "shared", _min: { id: low }, _max: { id: high }, _count: 2 },
  ]);
  expect(
    await db.compact.groupBy({
      by: ["group"],
      having: { id: { _min: { equals: high } } },
    })
  ).toEqual([]);
});

test("bigint list membership compares exact text members on SQLite", async () => {
  const keys = [9007199254740993n, -9007199254740993n];
  await db.list.create({ data: { id: 1, keys } });
  expect(
    await db.list.findMany({ where: { keys: { has: keys[0]! } } })
  ).toEqual([{ id: 1, keys }]);
  expect(
    await db.list.findMany({ where: { keys: { has: 9007199254740994n } } })
  ).toEqual([]);
});
