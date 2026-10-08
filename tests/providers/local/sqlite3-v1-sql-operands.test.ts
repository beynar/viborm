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
const db = createClient({ schema: { parent, entry } });
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
  ).rejects.toThrow("same model");
  await expect(
    db.entry.count({
      where: {
        score: { gt: (ctx) => ctx.sql`${{ deep: [ctx.fields.floor] }}` },
      },
    })
  ).rejects.toThrow("direct interpolation");
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
