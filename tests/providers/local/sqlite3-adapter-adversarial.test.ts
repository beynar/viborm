import { createClient } from "@drivers/sqlite3";
import { s } from "@schema";
import { type Sql, sql } from "@sql";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, expect, test } from "vitest";

const TAG_ALIAS = /FROM "tag" AS "(q\d+)"/;

const parent = s.model({ id: s.int().id(), entries: s.toMany(() => entry) });
const entry = s.model({
  id: s.int().id(),
  parentId: s.int(),
  parent: s
    .toOne(() => parent)
    .fields("parentId")
    .references("id"),
  amount: s.number(),
  location: s.point(),
  body: s.json(),
  large: s.bigInt(),
  title: s.string().nullable(),
  embedding: s.vector().dimension(3).nullable(),
});
const client = createClient({ schema: { parent, entry } });
const location = {
  longitude: Math.PI,
  latitude: 48.123_456_789_123_45,
};

beforeAll(async () => {
  await syncLiveSchema(client);
  await client.parent.create({ data: { id: 1 } });
  await client.entry.create({
    data: {
      id: 1,
      parentId: 1,
      amount: Math.PI,
      location,
      body: 9_007_199_254_740_994,
      large: 9223372036854775807n,
      title: "hello",
    },
  });
});
afterAll(() => client.$disconnect());

test("nested numeric and point projections preserve binary64 precision", async () => {
  const row = await client.parent.findUniqueOrThrow({
    where: { id: 1 },
    include: { entries: true },
  });
  expect(row.entries[0]!.amount).toBe(Math.PI);
  expect(row.entries[0]!.location).toEqual(location);
  expect(row.entries[0]!.body).toBe(9_007_199_254_740_994);
  expect(row.entries[0]!.large).toBe(9223372036854775807n);
  const aggregate = await client.entry.aggregate({
    _avg: { amount: true },
    _sum: { amount: true },
    _min: { amount: true },
    _max: { amount: true },
  });
  expect(aggregate).toEqual({
    _avg: { amount: Math.PI },
    _sum: { amount: Math.PI },
    _min: { amount: Math.PI },
    _max: { amount: Math.PI },
  });
});

test("extreme and subnormal binary64 carriers survive includes and aggregates", async () => {
  try {
    for (const amount of [
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      Number.MIN_VALUE,
    ]) {
      await client.entry.update({ where: { id: 1 }, data: { amount } });
      const row = await client.parent.findUniqueOrThrow({
        where: { id: 1 },
        include: { entries: true },
      });
      expect(row.entries[0]!.amount).toBe(amount);
      expect(
        await client.entry.aggregate({
          where: { id: 1 },
          _avg: { amount: true },
          _sum: { amount: true },
          _min: { amount: true },
          _max: { amount: true },
        })
      ).toEqual({
        _avg: { amount },
        _sum: { amount },
        _min: { amount },
        _max: { amount },
      });
    }
  } finally {
    await client.entry.update({ where: { id: 1 }, data: { amount: Math.PI } });
  }
});

test("empty suffix matches non-null text and not SQL NULL", async () => {
  expect(await client.entry.count({ where: { title: { endsWith: "" } } })).toBe(
    1
  );
  await client.entry.update({ where: { id: 1 }, data: { title: null } });
  expect(await client.entry.count({ where: { title: { endsWith: "" } } })).toBe(
    0
  );
});

test("an out-of-range bigint cannot be clamped or committed", async () => {
  await expect(
    client.entry.update({
      where: { id: 1 },
      data: { large: 9223372036854775808n },
    })
  ).rejects.toThrow("signed 64-bit");
  expect(
    (await client.entry.findUniqueOrThrow({ where: { id: 1 } })).large
  ).toBe(9223372036854775807n);
});

test("vector JSON storage retains dimensions across create, update and reads", async () => {
  await client.entry.update({
    where: { id: 1 },
    data: { embedding: [1, 2, 3] },
  });
  expect(
    (await client.entry.findUniqueOrThrow({ where: { id: 1 } })).embedding
  ).toEqual([1, 2, 3]);
  const parent = await client.parent.findUniqueOrThrow({
    where: { id: 1 },
    include: { entries: true },
  });
  expect(parent.entries[0]!.embedding).toEqual([1, 2, 3]);
  await expect(
    client.entry.update({ where: { id: 1 }, data: { embedding: [1, 2] } })
  ).rejects.toThrow("3 dimensions");
  expect(
    (await client.entry.findUniqueOrThrow({ where: { id: 1 } })).embedding
  ).toEqual([1, 2, 3]);
});

test("unsafe integer input is rejected before a write", async () => {
  await expect(client.parent.create({ data: { id: 2 ** 60 } })).rejects.toThrow(
    "safe integer"
  );
  expect(await client.parent.count()).toBe(1);
});

test("JSON transformations to null store a JSON document on create, default and update", async () => {
  const document = s
    .json()
    .schema({
      "~standard": {
        version: 1,
        vendor: "fixture",
        validate: () => ({ value: null }),
      },
    })
    .default({ input: true });
  const db = createClient({
    schema: { record: s.model({ id: s.int().id(), document }) },
  });
  try {
    await syncLiveSchema(db);
    await db.record.create({ data: { id: 1, document: { input: true } } });
    await db.record.create({ data: { id: 2 } });
    await db.record.update({
      where: { id: 1 },
      data: { document: { set: { next: true } } },
    });
    expect(
      await db.$queryRawUnsafe(
        "SELECT id, json_type(document) AS kind, document IS NULL AS absent FROM record ORDER BY id"
      )
    ).toEqual([
      { id: 1, kind: "null", absent: 0 },
      { id: 2, kind: "null", absent: 0 },
    ]);
    expect(await db.record.findMany({ orderBy: { id: "asc" } })).toEqual([
      { id: 1, document: null },
      { id: 2, document: null },
    ]);
  } finally {
    await db.$disconnect();
  }
});

test("insensitive string ranges fold both sides like equality", async () => {
  await client.entry.update({ where: { id: 1 }, data: { title: "Z" } });
  expect(
    await client.entry.count({
      where: { title: { gt: "a", mode: "insensitive" } },
    })
  ).toBe(1);
  expect(await client.entry.count({ where: { title: { gt: "a" } } })).toBe(0);
});

test("JSON equality and array membership compare structure and scalar types", async () => {
  const document = s.model({ id: s.int().id(), body: s.json() });
  const db = createClient({ schema: { document } });
  try {
    await syncLiveSchema(db);
    const object = { b: [1, null, true], a: { y: 2, x: 1 }, "a.b": {} };
    const reordered = { "a.b": {}, a: { x: 1, y: 2 }, b: [1, null, true] };
    await db.document.createMany({
      data: [
        { id: 1, body: object },
        { id: 2, body: [object, false, "1", null] },
      ],
    });
    expect(
      await db.document.count({ where: { body: { equals: reordered } } })
    ).toBe(1);
    expect(
      await db.document.count({
        where: { body: { not: { equals: reordered } } },
      })
    ).toBe(1);
    expect(
      await db.document.count({
        where: { body: { array_contains: [reordered, null] } },
      })
    ).toBe(1);
    expect(
      await db.document.count({
        where: { body: { array_starts_with: reordered } },
      })
    ).toBe(1);
    expect(
      await db.document.count({ where: { body: { array_contains: [1] } } })
    ).toBe(0);
    expect(
      await db.document.count({
        where: { body: { path: ["missing"], equals: null } },
      })
    ).toBe(0);
    expect(
      await db.document.count({
        where: { body: { equals: { ...reordered, b: [true, null, 1] } } },
      })
    ).toBe(0);
  } finally {
    await db.$disconnect();
  }
});

test("relation-filtered pages do not duplicate parents with multiple matching junction rows", async () => {
  const article = s.model({ id: s.int().id(), tags: s.toMany(() => tag) });
  const tag = s.model({ id: s.int().id(), articles: s.toMany(() => article) });
  const db = createClient({ schema: { article, tag } });
  try {
    await syncLiveSchema(db);
    await db.tag.createMany({ data: [{ id: 1 }, { id: 2 }] });
    for (let id = 1; id <= 7; id++) {
      await db.article.create({
        data: { id, tags: { connect: [{ id: 1 }, { id: 2 }] } },
      });
    }
    const where = { tags: { some: { id: { in: [1, 2] } } } };
    expect(await db.article.count({ where })).toBe(7);
    expect(
      (
        await db.article.findMany({
          where,
          orderBy: { id: "asc" },
          skip: 2,
          take: 3,
        })
      ).map(({ id }) => id)
    ).toEqual([3, 4, 5]);
    const statements: Sql[] = [];
    const observed = db.$extends({
      name: "plan-witness",
      statement(context) {
        if (context.model === "article" && context.operation === "findMany")
          statements.push(context.statement);
        return context.statement;
      },
    });
    expect(
      (await observed.article.findMany({ include: { tags: true } })).length
    ).toBe(7);
    expect(statements).toHaveLength(1);
    const statement = statements[0]!;
    const targetAlias = TAG_ALIAS.exec(statement.toStatement("?"))?.[1];
    expect(targetAlias).toBeDefined();
    const plan = await db.$queryRaw<{ detail: string }>(
      sql`EXPLAIN QUERY PLAN ${statement}`
    );
    const details = plan.map((row) => row.detail);
    expect(
      details.some((detail) =>
        detail.startsWith(`SEARCH ${targetAlias} USING INTEGER PRIMARY KEY`)
      )
    ).toBe(true);
    expect(
      details.some((detail) => detail.startsWith(`SCAN ${targetAlias}`))
    ).toBe(false);
    expect(
      details.some(
        (detail) =>
          detail.includes("USING COVERING INDEX") &&
          detail.includes("(articleId=?)")
      )
    ).toBe(true);
  } finally {
    await db.$disconnect();
  }
});
