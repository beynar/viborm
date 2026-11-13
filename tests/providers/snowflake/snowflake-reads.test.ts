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
 * | cursor-pagination, distinct       | a root cursor in key order, with distinct        |
 * | string-filter, json-filter        | LIKE metacharacters, insensitive, JSON paths     |
 *
 * Every other contract writes as its subject (nested writes, upserts,
 * ordering, polymorphic writes, raw indexes, migrations) and is refused on
 * Snowflake: `snowflake-client.core.test.ts` pins those refusals.
 *
 * What the driver states of the SQL API — several partitions, a 202 then
 * polls, a cancel — is read from the exchanges themselves (`recording`), not
 * assumed from the statement sent.
 */

import {
  createClient,
  SnowflakeDriver,
  type SnowflakeDriverOptions,
} from "@drivers/snowflake";
import { SnowflakeAuthenticator } from "@drivers/snowflake/auth";
import { SnowflakeTransport } from "@drivers/snowflake/transport";
import { QueryError, VibORMErrorCode } from "@errors";
import { introspectSchema } from "@migrations/introspect";
import { s } from "@schema";
import { parseSchema } from "@schema/json";
import { permissions } from "@src/permissions";
import { v } from "@src/validation";
import { GEO_POINT_EARTH_RADIUS_METERS } from "@validation/primitives/geo-area-codec";
import type { GeoPoint } from "@validation/primitives/geo-values";
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
/** How Snowflake's history names a statement that ended in failure. */
const FAILED = /^FAILED/;
const STOPPED = /timeout|cancel/i;
/** A second schema, holding the target of a key out of `SCHEMA`. */
const ELSEWHERE = `${SCHEMA}_X`;

const author = s
  .model({
    id: s.int().id(),
    name: s.string(),
    nickname: s.string().nullable(),
    posts: s.toMany(() => post),
    tags: s.toMany(() => tag).through(() => authorTag),
    places: s.toMany(() => place),
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

const place = s
  .model({
    id: s.int().id(),
    authorId: s.int(),
    name: s.string(),
    location: s.point(),
    optionalLocation: s.point().nullable(),
    embedding: s.vector().dimension(3),
    score: s.number(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
  })
  .map("PLACES");

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

const note = s
  .model({
    id: s.int().id(),
    body: s.string().unique(),
    kind: s.string().nullable(),
    at: s.dateTime().nullable(),
    data: s.json().nullable(),
    revisions: s.toMany(() => revision),
  })
  .map("NOTES");

const revision = s
  .model({
    noteId: s.int(),
    rev: s.int(),
    body: s.string().nullable(),
    scores: s.number().array().nullable(),
    note: s
      .toOne(() => note)
      .fields("noteId")
      .references("id"),
  })
  .id(["noteId", "rev"])
  .map("REVISIONS");

const shop = s
  .model({
    id: s.int().id(),
    opensAt: s.time().nullable(),
    shifts: s.toMany(() => shift),
  })
  .map("SHOPS");

const shift = s
  .model({
    id: s.int().id(),
    shopId: s.int(),
    startsAt: s.time(),
    shop: s
      .toOne(() => shop)
      .fields("shopId")
      .references("id"),
  })
  .map("SHIFTS");

const schema = {
  author,
  post,
  tag,
  authorTag,
  place,
  note,
  revision,
  shop,
  shift,
};

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
  `CREATE TABLE "${SCHEMA}"."PLACES" ("id" NUMBER(9,0) NOT NULL PRIMARY KEY, "authorId" NUMBER(9,0) NOT NULL REFERENCES "${SCHEMA}"."AUTHORS" ("id"), "name" VARCHAR NOT NULL, "location" GEOGRAPHY NOT NULL, "optionalLocation" GEOGRAPHY, "embedding" VECTOR(FLOAT, 3) NOT NULL, "score" FLOAT NOT NULL)`,
  `INSERT INTO "${SCHEMA}"."PLACES" SELECT column1, column2, column3, ST_MAKEPOINT(column4, column5), IFF(column6 IS NULL, NULL, ST_MAKEPOINT(column6, column7)), PARSE_JSON(column8)::ARRAY::VECTOR(FLOAT, 3), column9 FROM VALUES
    (1, 1, 'paris', 2.3522219, 48.856614, NULL, NULL, '[1, 0, 0]', 0.30000000000000004::FLOAT),
    (2, 1, 'london', -0.1276, 51.5072, 0, 0, '[0.1, 0.2, 0.3]', 1e-7::FLOAT),
    (3, 2, 'outer', 179, 5, NULL, NULL, '[0, 1, 0]', 1.5::FLOAT),
    (4, 2, 'hole', 179, 0, NULL, NULL, '[-1, 0, 0]', 2::FLOAT),
    (5, 2, 'outer-boundary', 170, 0, NULL, NULL, '[0, 0, 0]', 3::FLOAT),
    (6, 2, 'hole-boundary', 175, 0, NULL, NULL, '[0.5, 0.5, 0]', 4::FLOAT),
    (7, 3, 'west-dateline', -175, 0, NULL, NULL, '[0, 0, 1]', 5::FLOAT)`,
  `INSERT INTO "${SCHEMA}"."AUTHOR_TAGS" VALUES (1, 1), (1, 2), (2, 2)`,
  `CREATE TABLE "${SCHEMA}"."NOTES" ("id" NUMBER(9,0) NOT NULL PRIMARY KEY, "body" VARCHAR NOT NULL UNIQUE, "kind" VARCHAR DEFAULT 'memo', "at" TIMESTAMP_NTZ(9) DEFAULT CURRENT_TIMESTAMP(), "data" VARIANT)`,
  // A Snowflake string literal escapes with a backslash: this template's
  // 'a\\\\b' is the SQL 'a\\b', the text a\b.
  `INSERT INTO "${SCHEMA}"."NOTES" ("id", "body", "data") SELECT column1, column2, PARSE_JSON(column3) FROM VALUES
    (1, '50% off', '{"k":2}'),
    (2, '5_0', '{"k":[1,null]}'),
    (3, 'a\\\\b', '{"k":"3"}'),
    (4, 'A%b', '{"s":"hello","arr":[1,2]}'),
    (5, 'plain', NULL)`,
  `UPDATE "${SCHEMA}"."NOTES" SET "at" = '1969-12-31 23:59:58.5' WHERE "id" = 5`,
  `CREATE TABLE "${SCHEMA}"."REVISIONS" ("noteId" NUMBER(9,0) NOT NULL REFERENCES "${SCHEMA}"."NOTES" ("id"), "rev" NUMBER(9,0) NOT NULL, "body" VARCHAR, "scores" ARRAY, PRIMARY KEY ("noteId", "rev"))`,
  // A list column: exact members, and one holding a null member.
  `INSERT INTO "${SCHEMA}"."REVISIONS" SELECT column1, column2, column3, PARSE_JSON(column4)::ARRAY FROM VALUES
    (1, 1, 'r1', '[1.5, 0.30000000000000004]'),
    (1, 2, 'r2', '[1, null]')`,
  // TIME at three precisions; shop 3's has a digit past the millisecond.
  `CREATE TABLE "${SCHEMA}"."SHOPS" ("id" NUMBER(9,0) NOT NULL PRIMARY KEY, "opensAt" TIME(9))`,
  `INSERT INTO "${SCHEMA}"."SHOPS" VALUES (1, '12:34:56.12'), (2, '08:00:00'), (3, '12:34:56.123456789')`,
  `CREATE TABLE "${SCHEMA}"."SHIFTS" ("id" NUMBER(9,0) NOT NULL PRIMARY KEY, "shopId" NUMBER(9,0) NOT NULL REFERENCES "${SCHEMA}"."SHOPS" ("id"), "startsAt" TIME(3) NOT NULL)`,
  `INSERT INTO "${SCHEMA}"."SHIFTS" VALUES (1, 1, '09:15:30.5'), (2, 1, '00:00:00')`,
  `CREATE SCHEMA "${ELSEWHERE}"`,
  `CREATE TABLE "${ELSEWHERE}"."CUSTOMERS" ("id" NUMBER(9,0) NOT NULL PRIMARY KEY)`,
  `CREATE TABLE "${SCHEMA}"."INVOICES" ("id" NUMBER(9,0) NOT NULL PRIMARY KEY, "customerId" NUMBER(9,0) REFERENCES "${ELSEWHERE}"."CUSTOMERS" ("id"))`,
];

/** One request the driver sent, and the status Snowflake answered. */
interface Exchange {
  readonly method: string;
  readonly path: string;
  readonly status: number;
}

/** A `fetch` that records each exchange. */
function recording() {
  const exchanges: Exchange[] = [];
  const send = async (input: string, init: RequestInit) => {
    const response = await fetch(input, init);
    const url = new URL(input);
    exchanges.push({
      method: init.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      status: response.status,
    });
    return response;
  };
  return { exchanges, fetch: send };
}

function transport(
  credentials: Credentials,
  send: (input: string, init: RequestInit) => Promise<Response> = (
    input,
    init
  ) => fetch(input, init)
): SnowflakeTransport {
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
    fetch: send,
  });
}

function client(
  credentials: Credentials,
  options: Pick<SnowflakeDriverOptions, "fetch" | "timeout" | "parameters"> = {}
) {
  return createClient({
    schema,
    account: credentials.account,
    username: credentials.user,
    privateKey: credentials.privateKey,
    warehouse: credentials.warehouse,
    database: credentials.database,
    namespace: SCHEMA,
    ...(credentials.role ? { role: credentials.role } : {}),
    ...options,
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
    await sql?.run(`DROP SCHEMA IF EXISTS "${ELSEWHERE}" CASCADE`, undefined);
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
    const { exchanges, fetch: send } = recording();
    const rows = await client(credentials!, { fetch: send }).$queryRaw<{
      N: number;
    }>`
      SELECT SEQ4() AS N, RANDSTR(64, RANDOM()) AS PAD
      FROM TABLE(GENERATOR(ROWCOUNT => 200000)) ORDER BY N`;
    expect(rows).toHaveLength(200_000);
    expect(rows.every((row, index) => row.N === index)).toBe(true);
    // The result did come in partitions past the first, each read.
    const partitions = exchanges.filter((exchange) =>
      exchange.path.includes("partition=")
    );
    expect(partitions.length).toBeGreaterThan(0);
    expect(partitions.every((exchange) => exchange.status === 200)).toBe(true);
  });

  it("polls a statement Snowflake answers 202 to, past its 45 s", async () => {
    const { exchanges, fetch: send } = recording();
    const [row] = await client(credentials!, { fetch: send }).$queryRaw<{
      DONE: string;
    }>`
      SELECT SYSTEM$WAIT(50) AS DONE`;
    expect(row!.DONE).toContain("waited");
    // Snowflake did answer 202, and the driver polled until the result.
    expect(exchanges[0]).toMatchObject({ method: "POST", status: 202 });
    expect(exchanges.at(-1)).toMatchObject({ method: "GET", status: 200 });
  }, 120_000);

  /** What Snowflake's history says of the statements tagged `tag`. */
  async function history(tag: string) {
    for (let attempt = 0; ; attempt++) {
      const rows = await db!.$queryRaw<{
        STATUS: string;
        MESSAGE: string | null;
      }>`
        SELECT EXECUTION_STATUS AS STATUS, ERROR_MESSAGE AS MESSAGE
        FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY_BY_USER(RESULT_LIMIT => 100))
        WHERE QUERY_TAG = ${tag}`;
      // The history records a statement's end a little after it.
      if (
        (rows.length > 0 && rows.every((row) => row.STATUS !== "RUNNING")) ||
        attempt === 10
      )
        return rows;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  it("answers a timeout past the driver's timeout, and Snowflake stops the statement", async () => {
    const tag = `${SCHEMA}_TIMEOUT`;
    const { exchanges, fetch: send } = recording();
    const failure = await client(credentials!, {
      timeout: 5,
      fetch: send,
      parameters: { QUERY_TAG: tag },
    }).$queryRaw`SELECT SYSTEM$WAIT(60) AS DONE`.catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(QueryError);
    expect(failure).toMatchObject({ code: VibORMErrorCode.QUERY_TIMEOUT });
    // Snowflake answers no handle before its first 202 (45 s): the statement's
    // own timeout, sent with it, is what stops it there.
    expect(
      exchanges.some((exchange) => exchange.path.endsWith("/cancel"))
    ).toBe(false);
    expect(await history(tag)).toEqual([
      expect.objectContaining({
        STATUS: expect.stringMatching(FAILED),
        MESSAGE: expect.stringMatching(STOPPED),
      }),
    ]);
  }, 90_000);

  it("cancels a statement it abandons after Snowflake's 202, and Snowflake stops it", async () => {
    const tag = `${SCHEMA}_CANCEL`;
    const { exchanges, fetch: send } = recording();
    const tagged = new SnowflakeTransport({
      baseUrl: `https://${credentials!.account.toLowerCase()}.snowflakecomputing.com`,
      authenticator: new SnowflakeAuthenticator({
        account: credentials!.account,
        username: credentials!.user,
        privateKey: credentials!.privateKey,
      }),
      context: {
        warehouse: credentials!.warehouse,
        ...(credentials!.role ? { role: credentials!.role } : {}),
      },
      parameters: { TIMEZONE: "UTC", QUERY_TAG: tag },
      fetch: send,
    });
    // No server-side timeout: past the 202 at 45 s, only the cancel stops it.
    const started = Date.now();
    const failure = await tagged
      .run(
        "SELECT SYSTEM$WAIT(90) AS DONE",
        undefined,
        AbortSignal.timeout(50_000)
      )
      .catch((error: unknown) => error);
    // The caller's reason, within the 2 s the cancel may take.
    expect(failure).toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - started).toBeLessThan(53_000);
    expect(exchanges[0]).toMatchObject({ method: "POST", status: 202 });
    expect(
      exchanges.filter((exchange) => exchange.path.endsWith("/cancel"))
    ).toEqual([expect.objectContaining({ method: "POST", status: 200 })]);
    expect(await history(tag)).toEqual([
      expect.objectContaining({ STATUS: expect.stringMatching(FAILED) }),
    ]);
  }, 120_000);

  const PARIS = { longitude: 2.352_221_9, latitude: 48.856_614 };
  const LONDON = { longitude: -0.1276, latitude: 51.5072 };

  it("reads points, vectors and doubles exactly, flat and nested", async () => {
    const paris = await db!.place.findUnique({ where: { id: 1 } });
    expect(paris).toEqual({
      id: 1,
      authorId: 1,
      name: "paris",
      location: PARIS,
      optionalLocation: null,
      embedding: [1, 0, 0],
      score: 0.300_000_000_000_000_04,
    });
    const london = await db!.place.findUnique({ where: { id: 2 } });
    expect(london).toMatchObject({
      location: LONDON,
      optionalLocation: { longitude: 0, latitude: 0 },
      // VECTOR(FLOAT) holds float32: each member reads as the exact double
      // it widens to.
      embedding: [0.1, 0.2, 0.3].map(Math.fround),
      score: 1e-7,
    });
    const nested = await db!.author.findUnique({
      where: { id: 1 },
      include: { places: { orderBy: { id: "asc" } } },
    });
    expect(nested!.places).toEqual([paris, london]);
  });

  it("filters points by equality, by bounds across the antimeridian, and by a polygon with a hole", async () => {
    const ids = async (args: { where: PlaceWhere }) =>
      (
        await db!.place.findMany({
          ...args,
          select: { id: true },
          orderBy: { id: "asc" },
        })
      ).map((row) => row.id);
    expect(await ids({ where: { location: { equals: PARIS } } })).toEqual([1]);
    expect(
      await ids({
        where: {
          location: {
            within: {
              bounds: { south: -10, west: 170, north: 10, east: -170 },
            },
          },
        },
      })
    ).toEqual([3, 4, 5, 6, 7]);
    const outer = [
      { longitude: 170, latitude: -10 },
      { longitude: -170, latitude: -10 },
      { longitude: -170, latitude: 10 },
      { longitude: 170, latitude: 10 },
    ];
    const hole = [
      { longitude: 175, latitude: -2 },
      { longitude: -175, latitude: -2 },
      { longitude: -175, latitude: 2 },
      { longitude: 175, latitude: 2 },
    ];
    // VibORM's polygon holds its holes' boundaries. Snowflake's ST_INTERSECTS
    // reads a point exactly on a hole's edge as outside (measured: 6 and 7),
    // while it holds the outer ring's (5): a documented provider reading,
    // pinned so a change in Snowflake shows here.
    const rings: [GeoPoint[], GeoPoint[]][] = [
      [outer, hole],
      [[...outer].reverse(), [...hole].reverse()],
    ];
    for (const [ring, inner] of rings)
      expect(
        await ids({
          where: {
            location: { within: { polygon: { outer: ring, holes: [inner] } } },
          },
        })
      ).toEqual([3, 5]);
  });

  it("measures a point distance in the fixed-radius metres every provider uses", async () => {
    const expected = sphericalDistance(PARIS, LONDON);
    const rows = await db!.place.findMany({
      where: {
        authorId: 1,
        location: { distance: { to: LONDON, lte: expected + 1 } },
      },
      select: { id: true, location: { _distance: { to: LONDON } } },
      orderBy: { location: { _distance: { to: LONDON, sort: "asc" } } },
    });
    expect(rows.map((row) => row.id)).toEqual([2, 1]);
    expect(rows[0]!._distance).toBeCloseTo(0, 6);
    expect(rows[1]!._distance).toBeCloseTo(expected, 3);
    const nullable = await db!.place.findMany({
      where: { id: { in: [1, 2] } },
      select: { id: true, optionalLocation: { _distance: { to: LONDON } } },
      orderBy: { id: "asc" },
    });
    expect(nullable[0]!._distance).toBeNull();
    expect(nullable[1]!._distance).toBeCloseTo(
      sphericalDistance({ longitude: 0, latitude: 0 }, LONDON),
      3
    );
  });

  it("orders, selects and filters by vector distance, l2 and cosine", async () => {
    const byL2 = await db!.place.findMany({
      select: {
        id: true,
        embedding: { _distance: { to: [1, 0, 0], metric: "l2" } },
      },
      orderBy: { embedding: { _distance: { to: [1, 0, 0], metric: "l2" } } },
      take: 2,
    });
    expect(byL2.map((row) => row.id)).toEqual([1, 6]);
    expect(byL2[0]!._distance).toBeCloseTo(0, 6);
    const byCosine = await db!.place.findMany({
      where: { id: { in: [1, 4, 5] } },
      select: {
        id: true,
        embedding: { _distance: { to: [1, 0, 0], metric: "cosine" } },
      },
      orderBy: { id: "asc" },
    });
    expect(byCosine[0]!._distance).toBeCloseTo(0, 6);
    expect(byCosine[1]!._distance).toBeCloseTo(2, 6);
    // A zero vector has no direction: its cosine distance reads NULL.
    expect(byCosine[2]!._distance).toBeNull();
    expect(
      await db!.place.findMany({
        where: { embedding: { equals: [0, 1, 0] } },
        select: { id: true },
      })
    ).toEqual([{ id: 3 }]);
  });

  it("pages with a root cursor in the key's order, ascending, descending and with distinct", async () => {
    const ids = (rows: readonly { id: number }[]) => rows.map((row) => row.id);
    expect(
      ids(
        await db!.post.findMany({
          cursor: { id: 2 },
          orderBy: { id: "asc" },
          select: { id: true },
        })
      )
    ).toEqual([2, 3, 4, 5, 6]);
    expect(
      ids(
        await db!.post.findMany({
          cursor: { id: 3 },
          orderBy: { id: "desc" },
          select: { id: true },
        })
      )
    ).toEqual([3, 2, 1]);
    expect(
      ids(
        await db!.post.findMany({
          cursor: { id: 2 },
          orderBy: { id: "asc" },
          distinct: ["authorId"],
          select: { id: true },
        })
      )
    ).toEqual([2, 5, 6]);
    expect(
      ids(
        await db!.post.findMany({
          orderBy: { id: "asc" },
          distinct: ["authorId"],
          skip: 1,
          take: 1,
          select: { id: true },
        })
      )
    ).toEqual([5]);
  });

  it("refuses the recursive walk VibORM would write, which is why recursive filters are refused", async () => {
    // A recursive filter's form: a WITH RECURSIVE inside a correlated EXISTS,
    // its members joined by UNION, no column list.
    const failure = await db!
      .$queryRawUnsafe(
        'SELECT "q0"."id" FROM "AUTHORS" AS "q0" WHERE EXISTS (WITH RECURSIVE "w" AS (SELECT "q0"."id" AS "k" UNION SELECT "w"."k" + 1 FROM "w" WHERE "w"."k" < 3) SELECT 1 FROM "w" WHERE "w"."k" = 2)'
      )
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QueryError);
    expect(failure).toMatchObject({
      message: expect.stringContaining("invalid Recursive CTE"),
    });
  });

  it("reads nested relations under an extension's domain", async () => {
    const gated = db!
      .$extends(
        permissions({
          actor: v.object({ userId: v.number() }),
          models: {
            author: { read: true },
            post: { read: { title: { startsWith: "a" } } },
            tag: { read: true },
            authorTag: { read: true },
            place: { read: true },
            note: { read: true },
          },
        })
      )
      .$as({ userId: 1 });
    const authors = await gated.author.findMany({
      orderBy: { id: "asc" },
      select: {
        id: true,
        posts: { orderBy: { id: "desc" }, take: 2, select: { id: true } },
      },
    });
    expect(authors).toEqual([
      { id: 1, posts: [{ id: 4 }, { id: 3 }] },
      { id: 2, posts: [] },
      { id: 3, posts: [] },
    ]);
  });

  it("reads two levels of nested relations", async () => {
    const authors = await db!.author.findMany({
      orderBy: { id: "asc" },
      select: {
        id: true,
        posts: {
          orderBy: { id: "asc" },
          take: 1,
          select: { id: true, author: { select: { name: true } } },
        },
      },
    });
    expect(authors).toEqual([
      { id: 1, posts: [{ id: 1, author: { name: "Ada" } }] },
      { id: 2, posts: [{ id: 5, author: { name: "Bob" } }] },
      { id: 3, posts: [] },
    ]);
  });

  it("reads instants before 1970, non-finite doubles and NULL members exactly", async () => {
    const [row] = await db!.$queryRaw<Record<string, unknown>>`
      SELECT '1969-12-31 23:59:58.5'::TIMESTAMP_NTZ AS NTZ,
        '1900-01-01 00:00:00'::TIMESTAMP_LTZ AS LTZ,
        '1969-12-31 22:30:00 -01:30'::TIMESTAMP_TZ AS TZ,
        '1969-12-31'::DATE AS D,
        ${Number.POSITIVE_INFINITY}::FLOAT AS PINF,
        ${Number.NEGATIVE_INFINITY}::FLOAT AS NINF,
        ${Number.NaN}::FLOAT AS NOT_A_NUMBER,
        ARRAY_CONSTRUCT(1, NULL) AS LIST,
        OBJECT_CONSTRUCT_KEEP_NULL('a', NULL) AS DOC`;
    expect(row).toEqual({
      NTZ: "1969-12-31T23:59:58.500000000Z",
      LTZ: "1900-01-01T00:00:00.000000000Z",
      TZ: "1969-12-31T22:30:00.000000000-01:30",
      D: "1969-12-31",
      PINF: Number.POSITIVE_INFINITY,
      NINF: Number.NEGATIVE_INFINITY,
      NOT_A_NUMBER: Number.NaN,
      LIST: [1, null],
      DOC: { a: null },
    });
  });

  it("reads a list exactly, flat and nested, and refuses a null member either way", async () => {
    const exact = await db!.revision.findUnique({
      where: { noteId_rev: { noteId: 1, rev: 1 } },
      select: { scores: true },
    });
    expect(exact).toEqual({ scores: [1.5, 0.300_000_000_000_000_04] });
    const nested = await db!.note.findUnique({
      where: { id: 1 },
      select: { revisions: { where: { rev: 1 }, select: { scores: true } } },
    });
    expect(nested!.revisions).toEqual([exact]);
    // A list member is never null in VibORM: the row is refused, nested
    // (each member carried as text) as flat, not read as another value.
    for (const read of [
      db!.revision.findUnique({
        where: { noteId_rev: { noteId: 1, rev: 2 } },
        select: { scores: true },
      }),
      db!.note.findUnique({
        where: { id: 1 },
        select: { revisions: { where: { rev: 2 }, select: { scores: true } } },
      }),
    ])
      await expect(read).rejects.toThrow("a required scalar is null");
  });

  it("reads and filters an instant before 1970 through a dateTime field", async () => {
    const before = new Date("1969-12-31T23:59:58.500Z");
    const note = await db!.note.findUnique({
      where: { id: 5 },
      select: { at: true },
    });
    expect(note).toEqual({ at: before });
    const earlier = await db!.note.findMany({
      where: { at: { lt: new Date(0) } },
      select: { id: true },
    });
    expect(earlier).toEqual([{ id: 5 }]);
    expect(await db!.note.count({ where: { at: { equals: before } } })).toBe(1);
  });

  it("filters text with LIKE's metacharacters, insensitively, and JSON at a path; omits", async () => {
    const ids = async (where: NoteWhere) =>
      (
        await db!.note.findMany({
          where,
          orderBy: { id: "asc" },
          select: { id: true },
        })
      ).map((row) => row.id);
    expect(await ids({ body: { contains: "%" } })).toEqual([1, 4]);
    expect(await ids({ body: { startsWith: "5_" } })).toEqual([2]);
    expect(await ids({ body: { contains: "\\" } })).toEqual([3]);
    expect(await ids({ body: { endsWith: "_0" } })).toEqual([2]);
    expect(await ids({ body: { equals: "a%B", mode: "insensitive" } })).toEqual(
      [4]
    );
    expect(
      await ids({ body: { contains: "OFF", mode: "insensitive" } })
    ).toEqual([1]);
    // An array and a string at the path are not numbers, and fail nothing.
    expect(await ids({ data: { path: ["k"], gt: 1 } })).toEqual([1]);
    expect(await ids({ data: { path: ["k"], equals: "3" } })).toEqual([3]);
    expect(
      await ids({ data: { path: ["s"], string_contains: "ell" } })
    ).toEqual([4]);
    expect(await ids({ data: { path: ["arr"], array_contains: [2] } })).toEqual(
      [4]
    );
    const omitted = await db!.note.findUnique({
      where: { id: 1 },
      omit: { data: true, at: true },
    });
    expect(omitted).toEqual({ id: 1, body: "50% off", kind: "memo" });
  });

  it("reads a time field to the millisecond, flat and nested alike, and refuses a finer one", async () => {
    const flat = await db!.shift.findMany({
      orderBy: { id: "asc" },
      select: { startsAt: true },
    });
    expect(flat).toEqual([
      { startsAt: "09:15:30.5" },
      { startsAt: "00:00:00" },
    ]);
    const nested = await db!.shop.findUnique({
      where: { id: 1 },
      select: {
        opensAt: true,
        shifts: { orderBy: { id: "asc" }, select: { startsAt: true } },
      },
    });
    // A VARIANT would drop the fraction: the nested read spells it.
    expect(nested).toEqual({ opensAt: "12:34:56.12", shifts: flat });
    expect(
      await db!.shop.findUnique({ where: { id: 2 }, select: { opensAt: true } })
    ).toEqual({ opensAt: "08:00:00" });
    await expect(
      db!.shop.findUnique({ where: { id: 3 }, select: { opensAt: true } })
    ).rejects.toMatchObject({ code: VibORMErrorCode.QUERY_RESULT_INVALID });
  });

  it("reads NaN and Infinity inside a VARIANT as the strings STRICT_JSON_OUTPUT prints", async () => {
    const [row] = await db!.$queryRaw<{ V: unknown; W: unknown }>`
      SELECT OBJECT_CONSTRUCT('a', 'NaN'::FLOAT, 'b', 'inf'::FLOAT) AS V,
        ARRAY_CONSTRUCT('-inf'::FLOAT, 1) AS W`;
    expect(row).toEqual({
      V: { a: "NaN", b: "Infinity" },
      W: ["-Infinity", 1],
    });
  });

  it("introspects a TIME column as a time field a client then reads", async () => {
    const { document } = await introspectSchema({
      driver: new SnowflakeDriver({
        account: credentials!.account,
        username: credentials!.user,
        privateKey: credentials!.privateKey,
        warehouse: credentials!.warehouse,
        database: credentials!.database,
        namespace: SCHEMA,
        ...(credentials!.role ? { role: credentials!.role } : {}),
      }),
      tables: ["SHOPS"],
    });
    expect(document.models.SHOPS!.fields.opensAt).toMatchObject({
      type: "time",
      nullable: true,
    });
    const introspected = createClient({
      schema: parseSchema(document),
      account: credentials!.account,
      username: credentials!.user,
      privateKey: credentials!.privateKey,
      warehouse: credentials!.warehouse,
      database: credentials!.database,
      namespace: SCHEMA,
      ...(credentials!.role ? { role: credentials!.role } : {}),
    }) as unknown as {
      SHOPS: {
        findMany(args: object): Promise<{ opensAt: string | null }[]>;
      };
    };
    expect(
      await introspected.SHOPS.findMany({
        where: { id: { in: [1, 2] } },
        orderBy: { id: "asc" },
        select: { opensAt: true },
      })
    ).toEqual([{ opensAt: "12:34:56.12" }, { opensAt: "08:00:00" }]);
  });

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
    });
    const { models } = result.document;
    expect(Object.keys(models)).toEqual(
      expect.arrayContaining(["AUTHORS", "POSTS", "TAGS", "PLACES", "NOTES"])
    );
    // Declared keys: a single primary key, a compound one, a unique key, and
    // the defaults Snowflake states.
    expect(models.AUTHORS!.fields.id).toMatchObject({ type: "int", id: true });
    expect(models.REVISIONS!.ids).toEqual([
      expect.objectContaining({ fields: ["noteId", "rev"] }),
    ]);
    expect(models.NOTES!.fields).toMatchObject({
      body: { type: "string", unique: true },
      kind: { type: "string", nullable: true, default: "memo" },
      at: { type: "datetime", generate: { kind: "now" } },
    });
    // A key into another schema is said, not read as a relation here.
    expect(result.skipped).toContainEqual(
      expect.objectContaining({
        kind: "foreignKey",
        table: "INVOICES",
        reason: expect.stringContaining(`${ELSEWHERE}.CUSTOMERS`),
      })
    );
    expect(result.document.models.PLACES!.fields).toMatchObject({
      location: { type: "point" },
      optionalLocation: { type: "point", nullable: true },
      embedding: { type: "vector", dimension: 3 },
      score: { type: "number" },
    });
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

type NoteWhere = NonNullable<
  Parameters<ReturnType<typeof client>["note"]["findMany"]>[0]
>["where"];

type PlaceWhere = NonNullable<
  Parameters<ReturnType<typeof client>["place"]["findMany"]>[0]
>["where"];

function sphericalDistance(
  left: { longitude: number; latitude: number },
  right: { longitude: number; latitude: number }
): number {
  const radians = Math.PI / 180;
  const latitudeDelta = (right.latitude - left.latitude) * radians;
  const longitudeDelta = (right.longitude - left.longitude) * radians;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(left.latitude * radians) *
      Math.cos(right.latitude * radians) *
      Math.sin(longitudeDelta / 2) ** 2;
  return (
    2 *
    GEO_POINT_EARTH_RADIUS_METERS *
    Math.asin(Math.min(1, Math.sqrt(haversine)))
  );
}
