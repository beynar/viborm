/**
 * `viborm/snowflake` against a real Snowflake account. Gated on
 * `SNOWFLAKE_TEST_CREDENTIALS`, a JSON object:
 * `{ account, user, privateKey, warehouse, database, role }`. The role needs
 * CREATE SCHEMA in that database: the suite works in a schema of its own and
 * drops it afterwards.
 *
 * The shared driver contracts (`tests/contracts/drivers/behaviors`) seed their
 * rows with VibORM writes, which Snowflake refuses by design, so none of them
 * can run here as written. This file seeds with Snowflake's own SQL (through
 * the driver's transport, outside the client) and restates the READ
 * assertions of the contracts below over the same shapes:
 *
 * | contract                          | here                                             |
 * | --------------------------------- | ------------------------------------------------ |
 * | nested-pagination                 | take, negative take, skip, per parent            |
 * | nested-orderby                    | nested orderBy, nulls placement                  |
 * | many-to-many                      | include through a junction                       |
 * | optional-relation-parity          | a to-one include that finds nothing              |
 * | relation-read-aggregate           | `_count`, some / every / none                    |
 * | count-aggregate-window            | count, aggregate, groupBy                        |
 * | scalar-roundtrip, decimal-exactness | bigint past 2^53, decimal, timestamps, bytes, JSON |
 * | client-raw                        | $queryRaw with bindings                          |
 *
 * Every other contract writes as its subject (nested writes, upserts,
 * ordering, polymorphic writes, raw indexes, migrations) and is refused on
 * Snowflake: `snowflake-client.core.test.ts` pins those refusals.
 */

import { createClient, SnowflakeDriver } from "@drivers/snowflake";
import { SnowflakeAuthenticator } from "@drivers/snowflake/auth";
import { SnowflakeTransport } from "@drivers/snowflake/transport";
import { QueryError, VibORMErrorCode } from "@errors";
import { introspectSchema } from "@migrations/introspect";
import { s } from "@schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface Credentials {
  readonly account: string;
  readonly user: string;
  readonly privateKey: string;
  readonly warehouse: string;
  readonly database: string;
  readonly role?: string;
}

const raw = process.env.SNOWFLAKE_TEST_CREDENTIALS;
const credentials: Credentials | undefined = raw ? JSON.parse(raw) : undefined;
const SCHEMA = `VIBORM_TEST_${Date.now().toString(36).toUpperCase()}`;

const author = s
  .model({
    id: s.int().id(),
    name: s.string(),
    nickname: s.string().nullable(),
    posts: s.toMany(() => post),
    tags: s.toMany(() => tag).through(() => authorTag),
  })
  .map("AUTHORS");

const post = s
  .model({
    id: s.int().id(),
    authorId: s.int().nullable(),
    title: s.string(),
    views: s.bigInt(),
    price: s.decimal({ precision: 12, scale: 2 }),
    createdAt: s.dateTime(),
    payload: s.json().nullable(),
    digest: s.blob().nullable(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
  })
  .map("POSTS");

const tag = s
  .model({
    id: s.int().id(),
    label: s.string(),
    authors: s.toMany(() => author),
  })
  .map("TAGS");

const authorTag = s
  .model({
    authorId: s.int(),
    tagId: s.int(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
    tag: s
      .toOne(() => tag)
      .fields("tagId")
      .references("id"),
  })
  .id(["authorId", "tagId"])
  .map("AUTHOR_TAGS");

const schema = { author, post, tag, authorTag };

const SEED = [
  `CREATE SCHEMA "${SCHEMA}"`,
  `CREATE TABLE "${SCHEMA}"."AUTHORS" ("id" NUMBER(9,0) NOT NULL PRIMARY KEY, "name" VARCHAR NOT NULL, "nickname" VARCHAR)`,
  `CREATE TABLE "${SCHEMA}"."POSTS" ("id" NUMBER(9,0) NOT NULL PRIMARY KEY, "authorId" NUMBER(9,0) REFERENCES "${SCHEMA}"."AUTHORS" ("id"), "title" VARCHAR NOT NULL, "views" NUMBER(38,0) NOT NULL, "price" NUMBER(12,2) NOT NULL, "createdAt" TIMESTAMP_NTZ(9) NOT NULL, "payload" VARIANT, "digest" BINARY)`,
  `CREATE TABLE "${SCHEMA}"."TAGS" ("id" NUMBER(9,0) NOT NULL PRIMARY KEY, "label" VARCHAR NOT NULL)`,
  `CREATE TABLE "${SCHEMA}"."AUTHOR_TAGS" ("authorId" NUMBER(9,0) NOT NULL REFERENCES "${SCHEMA}"."AUTHORS" ("id"), "tagId" NUMBER(9,0) NOT NULL REFERENCES "${SCHEMA}"."TAGS" ("id"), PRIMARY KEY ("authorId", "tagId"))`,
  `INSERT INTO "${SCHEMA}"."AUTHORS" VALUES (1, 'Ada', NULL), (2, 'Bob', 'b'), (3, 'Cy', NULL)`,
  `INSERT INTO "${SCHEMA}"."POSTS" SELECT column1, column2, column3, column4, column5, column6, PARSE_JSON(column7), TO_BINARY(column8, 'HEX') FROM VALUES
    (1, 1, 'a1', 9007199254740993, 12.50, '2024-01-02 03:04:05.678', '{"k":[1,2]}', '00ff'),
    (2, 1, 'a2', 1, 0.10, '2024-01-03 00:00:00', NULL, NULL),
    (3, 1, 'a3', 2, 3.00, '2024-01-04 00:00:00', NULL, NULL),
    (4, 1, 'a4', 3, 4.00, '2024-01-05 00:00:00', NULL, NULL),
    (5, 2, 'b1', 4, 5.00, '2024-01-06 00:00:00', NULL, NULL),
    (6, NULL, 'orphan', 5, 6.00, '2024-01-07 00:00:00', NULL, NULL)`,
  `INSERT INTO "${SCHEMA}"."TAGS" VALUES (1, 'sql'), (2, 'warehouse')`,
  `INSERT INTO "${SCHEMA}"."AUTHOR_TAGS" VALUES (1, 1), (1, 2), (2, 2)`,
];

function transport(credentials: Credentials): SnowflakeTransport {
  return new SnowflakeTransport({
    baseUrl: `https://${credentials.account.toLowerCase()}.snowflakecomputing.com`,
    authenticator: new SnowflakeAuthenticator({
      account: credentials.account,
      username: credentials.user,
      privateKey: credentials.privateKey,
    }),
    context: {
      warehouse: credentials.warehouse,
      database: credentials.database,
      ...(credentials.role ? { role: credentials.role } : {}),
    },
    parameters: { TIMEZONE: "UTC" },
    fetch: (input, init) => fetch(input, init),
  });
}

function client(credentials: Credentials) {
  return createClient({
    schema,
    account: credentials.account,
    username: credentials.user,
    privateKey: credentials.privateKey,
    warehouse: credentials.warehouse,
    database: credentials.database,
    namespace: SCHEMA,
    ...(credentials.role ? { role: credentials.role } : {}),
  });
}

describe.skipIf(credentials === undefined)("Snowflake, a real account", () => {
  const sql = credentials ? transport(credentials) : undefined;
  const db = credentials ? client(credentials) : undefined;

  beforeAll(async () => {
    for (const statement of SEED) await sql!.run(statement, undefined);
  }, 300_000);

  afterAll(async () => {
    await sql?.run(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`, undefined);
  }, 120_000);

  it("pages each author's posts: take, negative take and skip", async () => {
    const authors = await db!.author.findMany({
      orderBy: { id: "asc" },
      include: { posts: { orderBy: { id: "asc" }, take: 2 } },
    });
    expect(authors.map((row) => row.posts.map((p) => p.id))).toEqual([
      [1, 2],
      [5],
      [],
    ]);
    const last = await db!.author.findUnique({
      where: { id: 1 },
      include: { posts: { orderBy: { id: "asc" }, take: -2, skip: 1 } },
    });
    expect(last!.posts.map((p) => p.id)).toEqual([2, 3]);
  });

  it("orders nested rows, NULLs where asked", async () => {
    const found = await db!.post.findMany({
      orderBy: { id: "asc" },
      select: { id: true, author: { select: { nickname: true } } },
    });
    expect(found.map((row) => row.author?.nickname ?? null)).toEqual([
      null,
      null,
      null,
      null,
      "b",
      null,
    ]);
    const authors = await db!.author.findMany({
      orderBy: [{ nickname: { sort: "asc", nulls: "first" } }, { id: "asc" }],
      select: { id: true },
    });
    expect(authors.map((row) => row.id)).toEqual([1, 3, 2]);
  });

  it("reads a junction relation and a to-one that finds nothing", async () => {
    const authors = await db!.author.findMany({
      orderBy: { id: "asc" },
      include: { tags: { orderBy: { label: "desc" } } },
    });
    expect(authors.map((row) => row.tags.map((t) => t.label))).toEqual([
      ["warehouse", "sql"],
      ["warehouse"],
      [],
    ]);
    const orphan = await db!.post.findUnique({
      where: { id: 6 },
      include: { author: true },
    });
    expect(orphan!.author).toBeNull();
  });

  it("filters and counts through relations", async () => {
    expect(
      await db!.author.count({ where: { posts: { some: { title: "b1" } } } })
    ).toBe(1);
    expect(await db!.author.count({ where: { posts: { none: {} } } })).toBe(1);
    expect(
      await db!.author.count({
        where: { posts: { every: { title: { startsWith: "a" } } } },
      })
    ).toBe(2);
    const counted = await db!.author.findMany({
      orderBy: { id: "asc" },
      select: { id: true, _count: { select: { posts: true } } },
    });
    expect(counted.map((row) => row._count.posts)).toEqual([4, 1, 0]);
  });

  it("aggregates and groups exactly", async () => {
    const aggregate = await db!.post.aggregate({
      _sum: { views: true, price: true },
      _max: { createdAt: true },
      _count: true,
    });
    expect(aggregate._count).toBe(6);
    expect(aggregate._sum.views).toBe(9_007_199_254_741_008n);
    expect(String(aggregate._sum.price)).toBe("30.6");
    expect(aggregate._max.createdAt).toEqual(new Date("2024-01-07T00:00:00Z"));
    const groups = await db!.post.groupBy({
      by: ["authorId"],
      _count: true,
      orderBy: { authorId: "asc" },
    });
    expect(groups).toEqual([
      { authorId: 1, _count: 4 },
      { authorId: 2, _count: 1 },
      { authorId: null, _count: 1 },
    ]);
  });

  it("reads every scalar exactly, flat and nested", async () => {
    const flat = await db!.post.findUnique({ where: { id: 1 } });
    expect(flat).toMatchObject({
      views: 9_007_199_254_740_993n,
      createdAt: new Date("2024-01-02T03:04:05.678Z"),
      payload: { k: [1, 2] },
      digest: new Uint8Array([0, 255]),
    });
    expect(String(flat!.price)).toBe("12.5");
    const nested = await db!.author.findUnique({
      where: { id: 1 },
      include: { posts: { where: { id: 1 } } },
    });
    expect(nested!.posts[0]).toEqual(flat);
  });

  it("runs $queryRaw with typed bindings", async () => {
    const rows = await db!.$queryRaw<{ N: number; AT: string }>`
      SELECT ${41} + 1 AS N, ${new Date("2021-03-19T17:06:59.5Z")}::TIMESTAMP_TZ AS AT`;
    expect(rows).toEqual([
      { N: 42, AT: "2021-03-19T17:06:59.500000000+00:00" },
    ]);
  });

  it("reads a result of several partitions, in order", async () => {
    const rows = await db!.$queryRaw<{ N: number }>`
      SELECT SEQ4() AS N, RANDSTR(64, RANDOM()) AS PAD
      FROM TABLE(GENERATOR(ROWCOUNT => 200000)) ORDER BY N`;
    expect(rows).toHaveLength(200_000);
    expect(rows.every((row, index) => row.N === index)).toBe(true);
  });

  it("polls a statement Snowflake answers 202 to, past its 45 s", async () => {
    const [row] = await db!.$queryRaw<{ DONE: string }>`
      SELECT SYSTEM$WAIT(50) AS DONE`;
    expect(row!.DONE).toContain("waited");
  }, 120_000);

  it("cancels a statement past the driver's timeout", async () => {
    const timed = createClient({
      schema,
      account: credentials!.account,
      username: credentials!.user,
      privateKey: credentials!.privateKey,
      warehouse: credentials!.warehouse,
      database: credentials!.database,
      namespace: SCHEMA,
      timeout: 5,
      ...(credentials!.role ? { role: credentials!.role } : {}),
    });
    const failure = await timed.$queryRaw`SELECT SYSTEM$WAIT(60) AS DONE`.catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(QueryError);
    expect((failure as QueryError).code).toBe(VibORMErrorCode.QUERY_TIMEOUT);
  }, 60_000);

  it("introspects the schema, its declared keys as relations", async () => {
    const result = await introspectSchema({
      driver: new SnowflakeDriver({
        account: credentials!.account,
        username: credentials!.user,
        privateKey: credentials!.privateKey,
        warehouse: credentials!.warehouse,
        database: credentials!.database,
        namespace: SCHEMA,
        ...(credentials!.role ? { role: credentials!.role } : {}),
      }),
      light: true,
    });
    expect(Object.keys(result.document.models)).toEqual(
      expect.arrayContaining(["AUTHORS", "POSTS", "TAGS"])
    );
    expect(Object.values(result.document.models.POSTS!.fields)).toContainEqual(
      expect.objectContaining({
        type: "toOne",
        target: "AUTHORS",
        fields: ["authorId"],
        references: ["id"],
      })
    );
  });
});
