/**
 * `viborm/snowflake` end to end, against a local server that answers as the
 * SQL API v2 does (`tests/fixtures/snowflake-server.ts`). Nothing here has run
 * against a real Snowflake: these pin the statements the client sends, their
 * bindings and session, how it reads the answers — and that a write,
 * `$executeRaw`, a transaction and a shape Snowflake cannot evaluate send
 * nothing at all.
 */

import { createClient } from "@drivers/snowflake";
import {
  ClientInitializationError,
  FeatureNotSupportedError,
  QueryError,
  UnsupportedOperationError,
  VibORMErrorCode,
} from "@errors";
import { s } from "@schema";
import {
  type FakeAnswer,
  type FakeSnowflake,
  type FakeStatement,
  rows,
  startFakeSnowflake,
} from "@tests/fixtures/snowflake-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const author = s
  .model({
    id: s.int().id(),
    name: s.string(),
    email: s.string().unique(),
    posts: s.toMany(() => post),
  })
  .map("AUTHORS");

const post = s
  .model({
    id: s.int().id(),
    authorId: s.int(),
    title: s.string(),
    createdAt: s.dateTime(),
    views: s.bigInt(),
    price: s.decimal({ precision: 10, scale: 2 }),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
    tags: s.toMany(() => tag),
  })
  .map("POSTS");

const tag = s
  .model({
    id: s.int().id(),
    label: s.string(),
    posts: s.toMany(() => post),
  })
  .map("TAGS");

const schema = { author, post, tag };

let server: FakeSnowflake;
let respond: (statement: FakeStatement) => FakeAnswer;

beforeEach(async () => {
  respond = () => rows([], []);
  server = await startFakeSnowflake((statement) => respond(statement));
});

afterEach(async () => {
  await server.close();
});

function client() {
  return createClient({
    schema,
    account: "myorg-acct",
    token: "oauth-token",
    warehouse: "WH",
    database: "DB",
    namespace: "PUBLIC",
    role: "READER",
    host: server.url,
  });
}

type Client = ReturnType<typeof client>;

const fixed = (name: string) => ({ name, type: "fixed", scale: 0 });
const text = (name: string) => ({ name, type: "text" });

/** The nested read Snowflake evaluates: uncorrelated pages, keyed aggregates. */
const NESTED_INCLUDE =
  'SELECT "q0"."id", "q0"."name", "q0"."email", ' +
  'COALESCE((SELECT ARRAY_AGG(OBJECT_CONSTRUCT_KEEP_NULL(\'id\', "q5"."id", \'authorId\', "q5"."authorId", \'title\', "q5"."title", \'createdAt\', TO_VARCHAR(CAST("q5"."createdAt" AS TIMESTAMP_TZ), \'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM\'), \'views\', CAST("q5"."views" AS VARCHAR), \'price\', CAST("q5"."price" AS VARCHAR), \'tags\', "q5"."tags")) WITHIN GROUP (ORDER BY "q5"."$rn" ASC) ' +
  'FROM (SELECT "q1"."id", "q1"."authorId", "q1"."title", "q1"."createdAt", CAST("q1"."views" AS VARCHAR) AS "views", CAST("q1"."price" AS VARCHAR) AS "price", ' +
  'COALESCE((SELECT ARRAY_AGG(OBJECT_CONSTRUCT_KEEP_NULL(\'id\', "q4"."id", \'label\', "q4"."label")) WITHIN GROUP (ORDER BY "q4"."$o0" ASC) ' +
  'FROM (SELECT "q2"."id", "q2"."label", "q3"."postId" AS "$k0", "q2"."id" AS "$o0" FROM "PUBLIC"."post_tag" AS "q3" INNER JOIN "PUBLIC"."TAGS" AS "q2" ON "q3"."tagId" = "q2"."id") AS "q4" WHERE "q4"."$k0" = "q1"."id"), ARRAY_CONSTRUCT()) AS "tags", ' +
  '"q1"."authorId" AS "$k0", ROW_NUMBER() OVER (PARTITION BY "q1"."authorId" ORDER BY "q1"."id" DESC) AS "$rn" FROM "PUBLIC"."POSTS" AS "q1" QUALIFY "$rn" <= ?) AS "q5" WHERE "q5"."$k0" = "q0"."id"), ARRAY_CONSTRUCT()) AS "posts" ' +
  'FROM "PUBLIC"."AUTHORS" AS "q0" WHERE CONTAINS("q0"."name", ?) ORDER BY "q0"."id" ASC LIMIT ?';

describe("Snowflake reads", () => {
  it("reads a nested include as uncorrelated keyed pages, in a UTC session with the caller's context", async () => {
    respond = () =>
      rows(
        [
          fixed("id"),
          text("name"),
          text("email"),
          { name: "posts", type: "array" },
        ],
        [
          [
            "1",
            "Ada",
            "ada@example.test",
            JSON.stringify([
              {
                id: 12,
                authorId: 1,
                title: "second",
                createdAt: "2024-01-02T03:04:05.678+00:00",
                views: "9007199254740993",
                price: "12.50",
                tags: [{ id: 7, label: "sql" }],
              },
            ]),
          ],
        ]
      );
    const authors = await client().author.findMany({
      where: { name: { contains: "a" } },
      include: {
        posts: { take: 2, orderBy: { id: "desc" }, include: { tags: true } },
      },
      take: 10,
    });

    const [sent] = server.statements();
    expect(sent!.statement).toBe(NESTED_INCLUDE);
    expect(sent!.bindings).toEqual({
      "1": { type: "FIXED", value: "2" },
      "2": { type: "TEXT", value: "a" },
      "3": { type: "FIXED", value: "10" },
    });
    expect(sent).toMatchObject({
      warehouse: "WH",
      database: "DB",
      schema: "PUBLIC",
      role: "READER",
      parameters: { TIMEZONE: "UTC" },
    });
    const headers = server.requests[0]!.headers;
    expect(headers.authorization).toBe("Bearer oauth-token");
    expect(headers["x-snowflake-authorization-token-type"]).toBe("OAUTH");

    expect(authors).toHaveLength(1);
    const [first] = authors[0]!.posts;
    expect(first!.createdAt).toEqual(new Date("2024-01-02T03:04:05.678Z"));
    expect(first!.views).toBe(9_007_199_254_740_993n);
    expect(String(first!.price)).toBe("12.5");
    expect(first!.tags).toEqual([{ id: 7, label: "sql" }]);
  });

  it("reads a to-one include as the first row of its key, and null where there is none", async () => {
    respond = () =>
      rows(
        [
          fixed("id"),
          fixed("authorId"),
          text("title"),
          { name: "createdAt", type: "timestamp_ntz" },
          text("views"),
          text("price"),
          { name: "author", type: "object" },
        ],
        [["5", "9", "t", "1704164645.678901234", "1", "0.10", null]]
      );
    const found = await client().post.findFirst({ include: { author: true } });
    const statement = server.statements()[0]!.statement;
    expect(statement).toContain(
      'GET(ARRAY_AGG(OBJECT_CONSTRUCT_KEEP_NULL(\'id\', "q2"."id", \'name\', "q2"."name", \'email\', "q2"."email")) WITHIN GROUP (ORDER BY "q2"."$rn" ASC), 0)'
    );
    expect(statement).toContain(
      'ROW_NUMBER() OVER (PARTITION BY "q1"."id" ORDER BY "q1"."id" ASC) AS "$rn" FROM "PUBLIC"."AUTHORS" AS "q1" QUALIFY "$rn" = ?) AS "q2" WHERE "q2"."$k0" = "q0"."authorId"'
    );
    expect(found).toMatchObject({ id: 5, author: null, views: 1n });
    // A TIMESTAMP_NTZ is read as UTC, to the millisecond VibORM holds.
    expect(found!.createdAt).toEqual(new Date("2024-01-02T03:04:05.678Z"));
  });

  it("reads a negative take backwards and skips from the end, as the decoder restores", async () => {
    respond = () =>
      rows(
        [fixed("id"), { name: "posts", type: "array" }],
        [["1", JSON.stringify([{ id: 4 }, { id: 3 }])]]
      );
    const [found] = await client().author.findMany({
      select: { id: true, posts: { select: { id: true }, take: -2, skip: 1 } },
    });
    const sent = server.statements()[0]!;
    expect(sent.statement).toContain(
      'ROW_NUMBER() OVER (PARTITION BY "q1"."authorId" ORDER BY "q1"."id" DESC) AS "$rn"'
    );
    expect(sent.statement).toContain('QUALIFY ("$rn" > ? AND "$rn" <= ?)');
    expect(sent.bindings).toEqual({
      "1": { type: "FIXED", value: "1" },
      "2": { type: "FIXED", value: "3" },
    });
    expect(found!.posts.map((row) => row.id)).toEqual([3, 4]);
  });

  it("filters with a correlated EXISTS and counts, aggregates and groups", async () => {
    respond = (statement) => {
      if (statement.statement.startsWith('SELECT COUNT(*) AS "_count"'))
        return rows([fixed("_count")], [["3"]]);
      if (statement.statement.includes("GROUP BY"))
        return rows(
          [fixed("authorId"), fixed("_count")],
          [
            ["1", "2"],
            ["2", "1"],
          ]
        );
      return rows(
        [
          { name: "_avg", type: "object" },
          { name: "_sum", type: "object" },
        ],
        [['{"price":"1.25"}', '{"views":"12345678901234567890"}']]
      );
    };
    const db = client();
    expect(
      await db.author.count({ where: { posts: { some: { title: "x" } } } })
    ).toBe(3);
    const aggregate = await db.post.aggregate({
      _sum: { views: true },
      _avg: { price: true },
    });
    expect(aggregate._sum.views).toBe(12_345_678_901_234_567_890n);
    expect(String(aggregate._avg.price)).toBe("1.25");
    expect(await db.post.groupBy({ by: ["authorId"], _count: true })).toEqual([
      { authorId: 1, _count: 2 },
      { authorId: 2, _count: 1 },
    ]);
    const [count, aggregated, grouped] = server
      .statements()
      .map((sent) => sent.statement);
    expect(count).toBe(
      'SELECT COUNT(*) AS "_count" FROM "PUBLIC"."AUTHORS" AS "q0" WHERE EXISTS (SELECT 1 FROM "PUBLIC"."POSTS" AS "q1" WHERE ("q0"."id" = "q1"."authorId" AND "q1"."title" = ?))'
    );
    expect(aggregated).toContain(
      'OBJECT_CONSTRUCT_KEEP_NULL(\'views\', CAST(SUM("q0"."views") AS VARCHAR)) AS "_sum"'
    );
    expect(grouped).toBe(
      'SELECT "q0"."authorId", COUNT(*) AS "_count" FROM "PUBLIC"."POSTS" AS "q0" GROUP BY "q0"."authorId" ORDER BY "q0"."authorId" ASC'
    );
  });

  it("sends $queryRaw as written, with typed bindings, and reads its rows", async () => {
    respond = () =>
      rows(
        [fixed("N"), { name: "AT", type: "timestamp_tz" }],
        [["7", "1616173619.000000000 960"]]
      );
    const answer = await client().$queryRaw<{ N: number; AT: string }>`
      SELECT 7 AS N, ${new Date("2021-03-19T17:06:59Z")} AS AT`;
    expect(answer).toEqual([
      { N: 7, AT: "2021-03-19T09:06:59.000000000-08:00" },
    ]);
    expect(server.statements()[0]!.bindings).toEqual({
      "1": { type: "TIMESTAMP_TZ", value: "1616173619000000000 1440" },
    });
  });
});

describe("Snowflake vectors and points", () => {
  const place = s
    .model({
      id: s.int().id(),
      location: s.point().nullable(),
      embedding: s.vector().dimension(3),
      score: s.number(),
    })
    .map("PLACES");
  const places = () =>
    createClient({
      schema: { place },
      account: "a",
      token: "t",
      host: server.url,
    });

  it("projects a point, a vector and a double in spellings no print rounds", async () => {
    await places().place.findMany();
    expect(server.statements()[0]!.statement).toBe(
      'SELECT "q0"."id", IFF("q0"."location" IS NULL, NULL, OBJECT_CONSTRUCT_KEEP_NULL(\'longitude\', PARSE_JSON(TO_VARCHAR(ST_X("q0"."location"))), \'latitude\', PARSE_JSON(TO_VARCHAR(ST_Y("q0"."location"))))) AS "location", (\'[\' || ARRAY_TO_STRING(TRANSFORM(CAST("q0"."embedding" AS ARRAY), member VARIANT -> TO_VARCHAR(member::FLOAT)), \',\') || \']\') AS "embedding", "q0"."score" FROM "PLACES" AS "q0" ORDER BY "q0"."id" ASC'
    );
  });

  it("reads the projected point and vector back", async () => {
    respond = () =>
      rows(
        [
          fixed("id"),
          { name: "location", type: "object" },
          text("embedding"),
          { name: "score", type: "real" },
        ],
        [
          [
            "1",
            '{"longitude": 2.3522219, "latitude": 48.856614}',
            "[0.10000000149011612,-2.25,3]",
            "0.30000000000000004",
          ],
        ]
      );
    expect(await places().place.findMany()).toEqual([
      {
        id: 1,
        location: { longitude: 2.352_221_9, latitude: 48.856_614 },
        embedding: [Math.fround(0.1), -2.25, 3],
        score: 0.300_000_000_000_000_04,
      },
    ]);
  });

  it("binds vector distances, point equality and polygons as Snowflake spells them", async () => {
    const db = places();
    await db.place.findMany({
      select: {
        id: true,
        embedding: { _distance: { to: [1, 0, 0], metric: "cosine" } },
      },
      orderBy: { embedding: { _distance: { to: [1, 0, 0], metric: "l2" } } },
    });
    await db.place.findMany({
      where: {
        location: {
          equals: { longitude: 2.352_221_9, latitude: 48.856_614 },
        },
      },
    });
    await db.place.findMany({
      where: {
        location: {
          within: {
            polygon: {
              outer: [
                { longitude: 0, latitude: 0 },
                { longitude: 1, latitude: 0 },
                { longitude: 1, latitude: 1 },
              ],
            },
          },
        },
      },
    });
    const [distance, equality, polygon] = server
      .statements()
      .map((sent) => sent.statement);
    expect(distance).toContain(
      'NULLIF(1 - VECTOR_COSINE_SIMILARITY("q0"."embedding", CAST(PARSE_JSON(?) AS ARRAY)::VECTOR(FLOAT, 3)), \'NaN\'::FLOAT) AS "_distance"'
    );
    expect(distance).toContain(
      'ORDER BY VECTOR_L2_DISTANCE("q0"."embedding", CAST(PARSE_JSON(?) AS ARRAY)::VECTOR(FLOAT, 3)) ASC'
    );
    expect(equality).toContain(
      'WHERE (ST_X("q0"."location") = ? AND ST_Y("q0"."location") = ?)'
    );
    expect(polygon).toContain(
      'ST_INTERSECTS(TO_GEOGRAPHY(?), "q0"."location")'
    );
    expect(server.statements()[1]!.bindings).toEqual({
      "1": { type: "REAL", value: "2.3522219" },
      "2": { type: "REAL", value: "48.856614" },
    });
  });
});

describe("Snowflake refusals", () => {
  const writes: Record<string, (db: Client) => Promise<unknown>> = {
    create: (db) =>
      db.author.create({ data: { id: 1, name: "a", email: "a@x" } }),
    createMany: (db) =>
      db.author.createMany({ data: [{ id: 1, name: "a", email: "a@x" }] }),
    update: (db) => db.author.update({ where: { id: 1 }, data: { name: "b" } }),
    updateMany: (db) =>
      db.author.updateMany({ where: {}, data: { name: "b" } }),
    upsert: (db) =>
      db.author.upsert({
        where: { id: 1 },
        create: { id: 1, name: "a", email: "a@x" },
        update: { name: "b" },
      }),
    delete: (db) => db.author.delete({ where: { id: 1 } }),
    deleteMany: (db) => db.author.deleteMany({ where: {} }),
    "a nested create": (db) =>
      db.author.update({
        where: { id: 1 },
        data: {
          posts: {
            create: {
              id: 2,
              title: "t",
              createdAt: new Date(0),
              views: 1n,
              price: "1.00",
            },
          },
        },
      }),
  };

  for (const [name, write] of Object.entries(writes))
    it(`refuses ${name} before sending anything`, async () => {
      const failure = await write(client()).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(FeatureNotSupportedError);
      expect(failure).toMatchObject({
        code: VibORMErrorCode.FEATURE_NOT_SUPPORTED,
      });
      expect(failure).toMatchObject({
        message: expect.stringContaining("VibORM only reads Snowflake"),
      });
      expect(server.requests).toEqual([]);
    });

  it("refuses $executeRaw and $executeRawUnsafe, and still runs $queryRaw", async () => {
    const db = client();
    await expect(db.$executeRaw`DELETE FROM T`).rejects.toBeInstanceOf(
      FeatureNotSupportedError
    );
    await expect(db.$executeRawUnsafe("DELETE FROM T")).rejects.toBeInstanceOf(
      FeatureNotSupportedError
    );
    expect(server.requests).toEqual([]);
    await db.$queryRawUnsafe("SELECT 1");
    expect(server.statements().map((sent) => sent.statement)).toEqual([
      "SELECT 1",
    ]);
  });

  it("refuses a transaction, callback or array, before sending anything", async () => {
    const db = client();
    await expect(
      db.$transaction(async (tx) => tx.author.count())
    ).rejects.toThrow("does not support callback transactions");
    await expect(
      db.$transaction([db.author.count(), db.post.count()])
    ).rejects.toThrow("supports neither transactions nor atomic batch");
    expect(server.requests).toEqual([]);
  });

  it("refuses a decimal operand wider than Snowflake's 38 digits, and binds one that fits", async () => {
    const db = createClient({
      schema: {
        ledger: s
          .model({
            id: s.int().id(),
            amount: s.decimal({ precision: 40, scale: 2 }),
          })
          .map("LEDGER"),
      },
      account: "a",
      token: "t",
      host: server.url,
    });
    // 37 integer digits and 2 of scale: 39.
    await expect(
      db.ledger.findMany({ where: { amount: { gt: "1".repeat(37) } } })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(server.requests).toEqual([]);
    await db.ledger.findMany({ where: { amount: { gt: "1".repeat(36) } } });
    const sent = server.statements()[0]!;
    expect(sent.statement).toContain('"q0"."amount" > CAST(? AS NUMBER(38,2))');
    expect(sent.bindings!["1"]).toEqual({
      type: "TEXT",
      value: "1".repeat(36),
    });
  });

  it("refuses the nested shapes Snowflake cannot evaluate, before sending anything", async () => {
    const db = client();
    const shapes = [
      db.author.findMany({ include: { posts: { cursor: { id: 1 } } } }),
      db.author.findMany({ include: { posts: { distinct: ["title"] } } }),
      db.author.findMany({
        include: { posts: { orderBy: { author: { name: "asc" } } } },
      }),
    ];
    for (const shape of shapes)
      await expect(shape).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(server.requests).toEqual([]);
  });
});

describe("Snowflake failures", () => {
  it("reads Snowflake's error codes into VibORM's", async () => {
    respond = () => ({
      error: {
        code: "002003",
        sqlState: "42S02",
        message:
          "SQL compilation error:\nObject 'AUTHORS' does not exist or not authorized.",
      },
    });
    const failure = await client()
      .author.findMany()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QueryError);
    expect(failure).toMatchObject({
      code: VibORMErrorCode.QUERY_SCHEMA_MISMATCH,
    });
    // Snowflake's own code is a provider detail: disclosed only on request.
  });

  it("refuses, before any request, a session parameter that changes what the driver decodes", () => {
    const refused: Record<string, string>[] = [
      { DATE_OUTPUT_FORMAT: "YYYYMMDD" },
      { binary_output_format: "BASE64" },
      { timezone: "America/New_York" },
      { MULTI_STATEMENT_COUNT: "0" },
      { Rows_Per_ResultSet: "2" },
    ];
    for (const parameters of refused)
      expect(() =>
        createClient({
          schema,
          account: "myorg-acct",
          token: "t",
          host: server.url,
          parameters,
        })
      ).toThrow(ClientInitializationError);
    expect(server.requests).toHaveLength(0);
  });

  it("passes a harmless session parameter beside the UTC session", async () => {
    const db = createClient({
      schema,
      account: "myorg-acct",
      token: "t",
      host: server.url,
      parameters: { QUERY_TAG: "reports" },
    });
    await db.$queryRaw`SELECT 1`;
    expect(server.statements()[0]!.parameters).toEqual({
      QUERY_TAG: "reports",
      TIMEZONE: "UTC",
    });
  });

  it("refuses, before any request, an account that would send the token to another host", async () => {
    const sent: string[] = [];
    const send = (input: string) => {
      sent.push(String(input));
      return Promise.reject(new Error("not sent"));
    };
    for (const account of [
      "evil.example/x",
      "https://myorg-acct.snowflakecomputing.com",
      "evil.example?",
      "evil.example#",
      "user@evil.example",
      "evil.example:8443",
    ]) {
      expect(() =>
        createClient({ schema, account, token: "t", fetch: send })
      ).toThrow(ClientInitializationError);
      expect(() =>
        createClient({
          schema,
          databaseUrl: `snowflake://u@${encodeURIComponent(account)}/DB`,
          token: "t",
          fetch: send,
        })
      ).toThrow(ClientInitializationError);
    }
    // The documented forms reach their own host.
    for (const [account, host] of [
      ["MyOrg-Acct", "myorg-acct.snowflakecomputing.com"],
      ["xy12345.us-east-1", "xy12345.us-east-1.snowflakecomputing.com"],
      [
        "xy12345.us-east-1.privatelink",
        "xy12345.us-east-1.privatelink.snowflakecomputing.com",
      ],
    ]) {
      await createClient({ schema, account, token: "t", fetch: send })
        .$queryRaw`SELECT 1`.catch(() => undefined);
      expect(new URL(sent.at(-1)!).host).toBe(host);
    }
  });

  it("reads a refused credential as a configuration failure", async () => {
    server.failNext(401);
    const failure = await client()
      .author.findMany()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ClientInitializationError);
  });
});
