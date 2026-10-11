import { createClient } from "@drivers/sqlite3";
import { s } from "@schema";
import { type Sql, sql } from "@sql";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, expect, test } from "vitest";

const TAG_ALIAS = /"tag" AS "(q\d+)"/;

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

const JUNCTION_DRIVEN = {
  statements: 1,
  targetSearchedByKey: true,
  targetScanned: false,
  junctionCovering: true,
};

/** Articles and tags joined by the generated `article_tag` junction. */
function membershipClient() {
  const article = s.model({
    id: s.int().id(),
    title: s.string().nullable(),
    tags: s.toMany(() => tag),
  });
  const tag = s.model({
    id: s.int().id(),
    name: s.string().nullable(),
    articles: s.toMany(() => article),
  });
  return createClient({ schema: { article, tag } });
}

test("relation-filtered pages do not duplicate parents with multiple matching junction rows", async () => {
  const db = membershipClient();
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
    expect(await includePlan(db, 7)).toMatchObject({
      parents: 7,
      memberships: 14,
      ...JUNCTION_DRIVEN,
    });
  } finally {
    await db.$disconnect();
  }
});

/**
 * The m:n include plan after ANALYZE, on a target table smaller than the
 * parents' (the case SQLite's planner prefers to scan) and on a large one:
 * `memberships` junction rows over `articles` parents and `tags` targets.
 */
test.each([
  { articles: 10_000, tags: 50, perArticle: 3 },
  { articles: 10_000, tags: 10_000, perArticle: 5 },
])("an m:n include after ANALYZE stays junction-driven: $articles parents, $tags targets, $perArticle each", async ({
  articles,
  tags,
  perArticle,
}) => {
  const db = membershipClient();
  try {
    await syncLiveSchema(db);
    const series = (count: number) =>
      sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count}) `;
    await db.$executeRaw(
      sql`INSERT INTO "article" ("id", "title") ${series(articles)}SELECT i, 'article ' || i FROM n`
    );
    await db.$executeRaw(
      sql`INSERT INTO "tag" ("id", "name") ${series(tags)}SELECT i, 'tag ' || i FROM n`
    );
    for (let k = 0; k < perArticle; k++) {
      await db.$executeRaw(
        sql`INSERT INTO "article_tag" ("articleId", "tagId") SELECT "id", 1 + (("id" * 7 + ${k * 13}) % ${tags}) FROM "article"`
      );
    }
    expect(
      await db.$queryRawUnsafe<{ n: number }>(
        'SELECT count(*) AS n FROM "article_tag"'
      )
    ).toEqual([{ n: articles * perArticle }]);
    await db.$executeRawUnsafe("ANALYZE");
    expect(await includePlan(db, 100)).toMatchObject({
      parents: 100,
      memberships: 100 * perArticle,
      ...JUNCTION_DRIVEN,
    });
  } finally {
    await db.$disconnect();
  }
}, 60_000);

/**
 * The one statement of a page of `take` articles with their tags, and the
 * facts of its plan the witnesses assert: the target is searched by primary
 * key from the junction's covering index on the parent side, never scanned.
 */
async function includePlan(
  db: ReturnType<typeof membershipClient>,
  take: number
) {
  const statements: Sql[] = [];
  const observed = db.$extends({
    name: "plan-witness",
    statement(context) {
      if (context.model === "article" && context.operation === "findMany")
        statements.push(context.statement);
      return context.statement;
    },
  });
  const rows = await observed.article.findMany({
    where: { id: { gte: 1 } },
    orderBy: { id: "asc" },
    take,
    include: { tags: true },
  });
  const statement = statements[0]!;
  const alias = TAG_ALIAS.exec(statement.toStatement("?"))?.[1];
  const plan = (
    await db.$queryRaw<{ detail: string }>(sql`EXPLAIN QUERY PLAN ${statement}`)
  ).map((row) => row.detail);
  return {
    parents: rows.length,
    memberships: rows.reduce((sum, row) => sum + row.tags.length, 0),
    statements: statements.length,
    targetSearchedByKey: plan.some((detail) =>
      detail.startsWith(`SEARCH ${alias} USING INTEGER PRIMARY KEY`)
    ),
    targetScanned: plan.some(
      (detail) =>
        detail === `SCAN ${alias}` || detail.startsWith(`SCAN ${alias} `)
    ),
    junctionCovering: plan.some(
      (detail) =>
        detail.includes("USING COVERING INDEX") &&
        detail.includes("(articleId=?)")
    ),
  };
}
