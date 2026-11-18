/**
 * The literal renderer of a view body (`src/adapters/inline-literals.ts`)
 * against a real database: for every read of the corpus, the statement the
 * engine compiles, executed with its values bound through the driver, and the
 * same statement with each value written as a literal (`inlineLiterals`),
 * executed without parameters, return the same raw driver rows.
 *
 * That equality is the renderer's whole claim (schema views plan §3.1): a
 * view's body means the read it was compiled from. The corpus crosses every
 * value kind a read binds — strings with quotes, backslashes, `%`/`_`, `?`
 * and `$1`, emoji; negative, fractional and wide numbers; bigints past 2^53;
 * booleans; null; instants; bytes; decimals; JSON documents and paths; enum
 * members; uuid and ulid keys; short and long `in`/`notIn` lists; scalar lists;
 * `take`/`skip`; nested `include` with `where`/`orderBy`/`take`; `_count` —
 * and each case must reach at least one row unless it says otherwise, so no
 * equality is the equality of two empty answers.
 */

import { inlineLiterals } from "@adapters/inline-literals";
import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { s } from "@schema";
import { type Sql, sql } from "@sql";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const author = s
  .model({
    id: s.int().id(),
    uid: s.string().uuid().unique(),
    ref: s.string().ulid().unique(),
    name: s.string(),
    nickname: s.string().nullable(),
    big: s.bigInt(),
    score: s.number(),
    balance: s.decimal({ precision: 12, scale: 2 }),
    active: s.boolean(),
    role: s.enum(["admin", "editor", "it's"]),
    bornAt: s.dateTime(),
    data: s.json(),
    avatar: s.blob(),
    tags: s.string().array(),
    posts: s.toMany(() => post),
  })
  .map("inl_authors");

const post = s
  .model({
    id: s.int().id(),
    title: s.string(),
    views: s.int(),
    rating: s.number().nullable(),
    authorId: s.int(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
  })
  .map("inl_posts");

const schema = { author, post };
const open = (driver: AnyDriver) => createClient({ schema, driver });
type Client = ReturnType<typeof open>;

const NAMES = ["O'Brien \\ back", "50%_off", "🦀 crab", "plain ?$1 $2"];
const UIDS = [
  "0b7a3c9e-5f1d-4e2a-9c8b-1d2e3f4a5b6c",
  "1c8b4daf-6a2e-4f3b-8d9c-2e3f4a5b6c7d",
  "2d9c5eb0-7b3f-4a4c-9ead-3f4a5b6c7d8e",
  "3e0d6fc1-8c4a-4b5d-8fbe-4a5b6c7d8e9f",
];
const REFS = [
  "01J9Z8Y7X6W5V4T3S2R1Q0P9N8",
  "01J9Z8Y7X6W5V4T3S2R1Q0P9N9",
  "01J9Z8Y7X6W5V4T3S2R1Q0P9NA",
  "01J9Z8Y7X6W5V4T3S2R1Q0P9NB",
];
const BIGS = [
  9_007_199_254_740_993n,
  -9_007_199_254_740_993n,
  9_223_372_036_854_775_807n,
  0n,
];
const SCORES = [-1.5, 0.1, 2 ** 60, 3];
const BALANCES = ["12.50", "-0.01", "9999999999.99", "0.00"];
const BORN = [
  new Date("1970-01-01T00:00:00.000Z"),
  new Date("1999-12-31T23:59:59.999Z"),
  new Date("2024-02-29T12:34:56.789Z"),
  new Date("2038-01-19T03:14:08.000Z"),
];
const DATA = [
  { a: 1, s: "x'y\\z", arr: [1, 2], nested: { k: "v" } },
  { a: 2, s: "plain", arr: [], nested: { k: "w" } },
  { a: -3.5, s: "🦀", arr: [3], nested: null },
  { a: 1, s: "%_", arr: [0, -1], nested: { k: "it's" } },
];
const AVATARS = [
  new Uint8Array([0, 1, 0xff]),
  new Uint8Array([0x27, 0x5c, 0x00]),
  new Uint8Array([0x3f]),
  new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
];
const TAGS = [["a", "it's"], ["back\\slash", 'q"uote'], [], ["a"]];
const ROLES = ["admin", "it's", "editor", "it's"] as const;

/** Long lists: past every inline-list form, into the one-parameter one. */
const LONG_NAMES = [
  ...NAMES,
  ...Array.from({ length: 300 }, (_, at) => `name ${at} '\\`),
];
const LONG_IDS = Array.from({ length: 2000 }, (_, at) => at - 1000);

interface ReadCase {
  readonly name: string;
  readonly read: (client: Client) => { buildStatement(): Sql | undefined };
  /** The read is expected to reach no row. */
  readonly empty?: true;
}

const byId = { orderBy: { id: "asc" } } as const;

const CASES: readonly ReadCase[] = [
  {
    name: "a string with a quote and a backslash",
    read: (c) => c.author.findMany({ where: { name: NAMES[0]! }, ...byId }),
  },
  {
    name: "contains a percent and an underscore",
    read: (c) =>
      c.author.findMany({ where: { name: { contains: "%_" } }, ...byId }),
  },
  {
    name: "contains a backslash",
    read: (c) =>
      c.author.findMany({ where: { name: { contains: "\\" } }, ...byId }),
  },
  {
    name: "starts with an emoji",
    read: (c) =>
      c.author.findMany({ where: { name: { startsWith: "🦀" } }, ...byId }),
  },
  {
    name: "ends with a placeholder spelling",
    read: (c) =>
      c.author.findMany({ where: { name: { endsWith: "?$1 $2" } }, ...byId }),
  },
  {
    name: "a short in list of strings",
    read: (c) => c.author.findMany({ where: { name: { in: NAMES } }, ...byId }),
  },
  {
    name: "a notIn list",
    read: (c) =>
      c.author.findMany({ where: { name: { notIn: [NAMES[0]!] } }, ...byId }),
  },
  {
    name: "a long in list of strings",
    read: (c) =>
      c.author.findMany({ where: { name: { in: LONG_NAMES } }, ...byId }),
  },
  {
    name: "a long in list of negative and positive ints",
    read: (c) => c.post.findMany({ where: { id: { in: LONG_IDS } }, ...byId }),
  },
  {
    name: "a long notIn list of ints",
    read: (c) =>
      c.post.findMany({ where: { views: { notIn: LONG_IDS } }, ...byId }),
    empty: true,
  },
  {
    name: "a bigint past 2^53, negative",
    read: (c) =>
      c.author.findMany({
        where: { big: { gt: -9_007_199_254_740_993n } },
        ...byId,
      }),
  },
  {
    name: "the largest bigint",
    read: (c) =>
      c.author.findMany({
        where: { big: 9_223_372_036_854_775_807n },
        ...byId,
      }),
  },
  {
    name: "a bigint list",
    read: (c) => c.author.findMany({ where: { big: { in: BIGS } }, ...byId }),
  },
  {
    name: "a negative fractional number",
    read: (c) => c.author.findMany({ where: { score: { lt: -1 } }, ...byId }),
  },
  {
    name: "a small fraction",
    read: (c) => c.author.findMany({ where: { score: { gte: 0.1 } }, ...byId }),
  },
  {
    name: "a double past 2^53",
    read: (c) => c.author.findMany({ where: { score: 2 ** 60 }, ...byId }),
  },
  {
    name: "a number list",
    read: (c) =>
      c.author.findMany({ where: { score: { in: SCORES } }, ...byId }),
  },
  {
    name: "a decimal bound",
    read: (c) =>
      c.author.findMany({ where: { balance: { gte: "12.50" } }, ...byId }),
  },
  {
    name: "a negative decimal",
    read: (c) => c.author.findMany({ where: { balance: "-0.01" }, ...byId }),
  },
  {
    name: "a decimal list",
    read: (c) =>
      c.author.findMany({ where: { balance: { in: BALANCES } }, ...byId }),
  },
  {
    name: "a boolean",
    read: (c) => c.author.findMany({ where: { active: true }, ...byId }),
  },
  {
    name: "a negated boolean",
    read: (c) =>
      c.author.findMany({ where: { active: { not: true } }, ...byId }),
  },
  {
    name: "null",
    read: (c) => c.author.findMany({ where: { nickname: null }, ...byId }),
  },
  {
    name: "not null",
    read: (c) =>
      c.author.findMany({ where: { nickname: { not: null } }, ...byId }),
  },
  {
    name: "an instant bound",
    read: (c) =>
      c.author.findMany({ where: { bornAt: { gte: BORN[1]! } }, ...byId }),
  },
  {
    name: "an exact instant",
    read: (c) => c.author.findMany({ where: { bornAt: BORN[2]! }, ...byId }),
  },
  {
    name: "an instant list",
    read: (c) =>
      c.author.findMany({ where: { bornAt: { in: BORN } }, ...byId }),
  },
  {
    name: "json equality",
    read: (c) =>
      c.author.findMany({ where: { data: { equals: DATA[0]! } }, ...byId }),
  },
  {
    name: "a json path number",
    read: (c) =>
      c.author.findMany({
        where: { data: { path: ["a"], equals: 1 } },
        ...byId,
      }),
  },
  {
    name: "a json path string with a quote and a backslash",
    read: (c) =>
      c.author.findMany({
        where: { data: { path: ["s"], equals: "x'y\\z" } },
        ...byId,
      }),
  },
  {
    name: "a json path into an array, compared",
    read: (c) =>
      c.author.findMany({
        where: { data: { path: ["arr", "0"], gt: 0 } },
        ...byId,
      }),
  },
  {
    name: "a nested json path with a quote",
    read: (c) =>
      c.author.findMany({
        where: { data: { path: ["nested", "k"], equals: "it's" } },
        ...byId,
      }),
  },
  {
    name: "json string_contains",
    read: (c) =>
      c.author.findMany({
        where: { data: { path: ["s"], string_contains: "'" } },
        ...byId,
      }),
  },
  {
    name: "bytes holding a quote, a backslash and NUL",
    read: (c) => c.author.findMany({ where: { avatar: AVATARS[1]! }, ...byId }),
  },
  {
    name: "a bytes list",
    read: (c) =>
      c.author.findMany({ where: { avatar: { in: AVATARS } }, ...byId }),
  },
  {
    name: "a scalar list has a member with a quote",
    read: (c) =>
      c.author.findMany({ where: { tags: { has: "it's" } }, ...byId }),
  },
  {
    name: "a scalar list hasSome with a backslash and a double quote",
    read: (c) =>
      c.author.findMany({
        where: { tags: { hasSome: ["back\\slash", 'q"uote'] } },
        ...byId,
      }),
  },
  {
    name: "a scalar list hasEvery",
    read: (c) =>
      c.author.findMany({
        where: { tags: { hasEvery: ["a", "it's"] } },
        ...byId,
      }),
  },
  {
    name: "a scalar list equals",
    read: (c) =>
      c.author.findMany({ where: { tags: { equals: ["a"] } }, ...byId }),
  },
  {
    name: "a uuid key",
    read: (c) => c.author.findMany({ where: { uid: UIDS[2]! }, ...byId }),
  },
  {
    name: "a uuid list",
    read: (c) => c.author.findMany({ where: { uid: { in: UIDS } }, ...byId }),
  },
  {
    name: "a ulid key list",
    read: (c) => c.author.findMany({ where: { ref: { in: REFS } }, ...byId }),
  },
  {
    name: "an enum member with a quote",
    read: (c) => c.author.findMany({ where: { role: "it's" }, ...byId }),
  },
  {
    name: "an enum list",
    read: (c) =>
      c.author.findMany({
        where: { role: { in: ["admin", "it's"] } },
        ...byId,
      }),
  },
  {
    name: "some related row, with a negative bound",
    read: (c) =>
      c.author.findMany({
        where: { posts: { some: { views: { gt: -5 } } } },
        ...byId,
      }),
  },
  {
    name: "no related row",
    read: (c) =>
      c.author.findMany({
        where: { posts: { none: { title: { contains: "'" } } } },
        ...byId,
      }),
  },
  {
    name: "every related row",
    read: (c) =>
      c.author.findMany({
        where: { posts: { every: { rating: { gte: -0.5 } } } },
        ...byId,
      }),
  },
  {
    name: "OR and NOT",
    read: (c) =>
      c.author.findMany({
        where: {
          OR: [{ score: { lt: -1 } }, { big: { lt: 0n } }],
          NOT: { name: "nobody" },
        },
        ...byId,
      }),
  },
  {
    name: "take and skip",
    read: (c) =>
      c.author.findMany({ orderBy: { name: "desc" }, take: 2, skip: 1 }),
  },
  {
    name: "include with where, orderBy and take",
    read: (c) =>
      c.author.findMany({
        include: {
          posts: {
            where: { views: { gte: -5 } },
            orderBy: { views: "desc" },
            take: 2,
          },
        },
        ...byId,
      }),
  },
  {
    name: "include two levels with skip",
    read: (c) =>
      c.post.findMany({
        include: {
          author: {
            include: {
              posts: { orderBy: { id: "desc" }, skip: 1, take: 1 },
            },
          },
        },
        ...byId,
      }),
  },
  {
    name: "a count of related rows",
    read: (c) =>
      c.author.findMany({
        select: { id: true, _count: { select: { posts: true } } },
        ...byId,
      }),
  },
  {
    name: "a filtered count of related rows",
    read: (c) =>
      c.author.findMany({
        select: {
          id: true,
          _count: { select: { posts: { where: { views: { gt: 0 } } } } },
        },
        ...byId,
      }),
  },
  {
    name: "a to-one filter, every scalar kind selected",
    read: (c) =>
      c.post.findMany({
        where: { author: { is: { name: { contains: "'" } } } },
        include: { author: true },
        ...byId,
      }),
  },
  {
    name: "a nullable number",
    read: (c) => c.post.findMany({ where: { rating: { lt: -0.25 } }, ...byId }),
  },
  {
    name: "a first row",
    read: (c) =>
      c.post.findFirst({
        where: { views: { lte: 100 } },
        orderBy: { id: "desc" },
      }),
  },
  {
    name: "a count",
    read: (c) => c.post.count({ where: { views: { gt: -1000 } } }),
  },
];

/**
 * Positions no read of the corpus tells apart, written by hand: a value in a
 * select list (its type is the literal's type), compared to a text column,
 * as a `LIMIT`, after a `-` of the statement's own, and SQLite's storage
 * class of it. A rule that wrote a PostgreSQL number bare (`int4`, not the
 * driver's unknown text), a SQLite number as INTEGER (the driver binds REAL)
 * or a negative number unparenthesized (`--` opens a comment) fails here.
 * Bytes are not selected bare: node-postgres sends them untyped, and the
 * server reads them as text there (22021 on a NUL), so the bound statement
 * has no answer to compare; the corpus compares them to a column.
 */
const SELECTED: readonly unknown[] = [
  10,
  -1.5,
  2 ** 60,
  0.1,
  9_007_199_254_740_993n,
  -42n,
  true,
  false,
  "it's \\ ?$1 🦀",
  "",
  null,
];

interface Position {
  readonly name: string;
  readonly statement: Sql;
  readonly only?: "sqlite";
}

const POSITIONS: readonly Position[] = [
  ...SELECTED.map((value, at) => ({
    name: `selected value ${at}`,
    statement: sql`SELECT ${value} AS v`,
  })),
  {
    name: "a number compared to a text column",
    statement: sql`SELECT COUNT(*) AS v FROM (SELECT ${"10"} AS t) AS q WHERE q.t <> ${1}`,
  },
  {
    name: "a limit",
    statement: sql`SELECT v FROM (SELECT 1 AS v UNION ALL SELECT 2 UNION ALL SELECT 3) AS q ORDER BY v LIMIT ${2}`,
  },
  {
    name: "a negative number after a minus",
    statement: sql`SELECT 5 -${-3} AS v, 5 -${-3n} AS w`,
  },
  ...SELECTED.map((value, at) => ({
    name: `storage class ${at}`,
    statement: sql`SELECT typeof(${value}) AS v`,
    only: "sqlite" as const,
  })),
];

export interface InlineLiteralsBehaviorOptions {
  readonly name: string;
  readonly dialect: "postgresql" | "mysql" | "sqlite";
  readonly createDriver: () => AnyDriver;
}

export function runInlineLiteralsBehavior({
  name,
  dialect,
  createDriver,
}: InlineLiteralsBehaviorOptions): void {
  describe(`${name}: a read's values written as literals`, () => {
    const driver = createDriver();
    const client = open(driver);

    beforeAll(async () => {
      // Only this corpus's tables: a shared database holds other suites'.
      await syncLiveSchema(client, { tables: ["inl_authors", "inl_posts"] });
      await client.post.deleteMany({});
      await client.author.deleteMany({});
      for (const [at, label] of NAMES.entries())
        await client.author.create({
          data: {
            id: at + 1,
            uid: UIDS[at]!,
            ref: REFS[at]!,
            name: label,
            nickname: at % 2 === 0 ? null : `nick ${at}`,
            big: BIGS[at]!,
            score: SCORES[at]!,
            balance: BALANCES[at]!,
            active: at % 2 === 0,
            role: ROLES[at]!,
            bornAt: BORN[at]!,
            data: DATA[at]!,
            avatar: AVATARS[at]!,
            tags: TAGS[at]!,
          },
        });
      const posts = [
        [1, "first 'post'", 10, 4.5, 1],
        [2, "second", -3, -0.5, 1],
        [3, "100% done", 0, null, 2],
        [4, "back\\slash", 7, -1.25, 2],
        [5, "🦀", 100, 0.1, 3],
        [6, "it's", -100, 2, 4],
      ] as const;
      for (const [id, title, views, rating, authorId] of posts)
        await client.post.create({
          data: { id, title, views, rating, authorId },
        });
    });

    afterAll(async () => {
      await client.$disconnect();
    });

    test.each(CASES)("$name", async ({ read, empty }) => {
      const statement = read(client).buildStatement();
      if (statement === undefined)
        throw new Error("the read built no statement");
      const inlined = inlineLiterals(dialect, statement);
      const bound = await driver._execute(statement);
      const literal = await driver._execute(sql.raw(inlined));
      expect(literal.rows).toEqual(bound.rows);
      if (empty) expect(bound.rows).toEqual([]);
      else expect(bound.rows.length).toBeGreaterThan(0);
    });

    test.each(
      POSITIONS.filter((position) => (position.only ?? dialect) === dialect)
    )("$name", async ({ statement }) => {
      const inlined = inlineLiterals(dialect, statement);
      const bound = await driver._execute(statement);
      const literal = await driver._execute(sql.raw(inlined));
      expect(literal.rows).toEqual(bound.rows);
    });
  });
}
