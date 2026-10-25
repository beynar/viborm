/**
 * Neon Realtime on embedded PostgreSQL: each live read's exact sealed SQL and
 * parameters run here, and the browser half decodes their rows into the value
 * the ordinary read returns. The family lives in a non-public namespace.
 */

import type { PGlite } from "@electric-sql/pglite";
import type { RawSqlQuery } from "@neon/realtime/server";
import { s } from "@schema";
import { permissions } from "@src/permissions";
import { v } from "@src/validation";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { Decimal } from "@validation/primitives/decimal-value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { neonRealtime } from "../../../src/neon-realtime";
import { realtimeData, subscribe } from "../../../src/neon-realtime/client";

const native = vi.hoisted(() => ({
  data: undefined as readonly Record<string, unknown>[] | undefined,
}));
vi.mock("@neon/realtime/client", async (original) => ({
  ...(await original<typeof import("@neon/realtime/client")>()),
  createRealtimeClient: () => ({
    subscribe: () => ({
      getSnapshot: () => ({
        status: "live",
        error: undefined,
        data: native.data,
      }),
      onChange: () => () => undefined,
      renew: async () => undefined,
      unsubscribe: () => undefined,
    }),
    close: () => undefined,
  }),
}));

// Neon's text-transport parsing: int8 and numeric stay text, and the browser
// half keeps timestamps as PostgreSQL text.
const exact = (text: string) => text;
const NEON_PARSERS = {
  20: exact,
  1700: exact,
  1082: exact,
  1114: exact,
  1184: exact,
};
// Neon refuses every function that is not immutable.
const REFUSED =
  /json_build|json_agg|jsonb_agg|row_to_json|to_json|array_to_|unnest/i;
const POST_ID = /p[1-5]/;

const author = s
  .model({
    id: s.int().id(),
    name: s.string().map("display_name"),
    posts: s.toMany(() => post),
  })
  .map("rt_authors");
const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    subtitle: s.string().nullable(),
    published: s.boolean(),
    rank: s.int().nullable().map("rank_value"),
    score: s.number(),
    views: s.bigInt(),
    price: s.decimal({ precision: 12, scale: 2 }),
    createdAt: s.dateTime().map("created_at"),
    day: s.date(),
    at: s.time(),
    payload: s.blob(),
    meta: s.json(),
    status: s.enum(["draft", "live, now"]),
    tags: s.string().array(),
    flags: s.boolean().array(),
    counts: s.int().array(),
    ratios: s.number().array(),
    bigs: s.bigInt().array(),
    amounts: s.decimal({ precision: 12, scale: 2 }).array(),
    moments: s.dateTime().array(),
    statuses: s.enum(["draft", "live, now"]).array(),
    authorId: s.int(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => post)
      .fields("parentId")
      .references("id")
      .name("thread"),
    replies: s.toMany(() => post).name("thread"),
  })
  .map("rt_posts");
const schema = { author, post };

const row = (
  id: string,
  index: number,
  extra: { readonly authorId: number; readonly parentId: string | null }
) => ({
  id,
  title: `Title "${id}", with \\ and ü`,
  subtitle: index % 2 ? null : `sub ${id}`,
  published: index % 2 === 0,
  rank: index === 2 ? null : 10 - index,
  score: index + 0.25,
  views: 9_007_199_254_740_993n + BigInt(index),
  price: new Decimal(`${index}12.30`),
  createdAt: new Date(Date.UTC(2026, 0, index + 1, 12, 30, 15, 123)),
  day: new Date(Date.UTC(2025, 5, index + 1)),
  at: `0${index}:15:30`,
  payload: new Uint8Array([index, 255, 0]),
  meta: { id, nested: [1, "two", { three: null }], quote: 'a"b' },
  status: index % 2 ? ("live, now" as const) : ("draft" as const),
  tags: ["a,b", 'q"uote', `t${index}`],
  flags: [true, false],
  counts: [index, -1],
  ratios: [0.5, index],
  bigs: [9_007_199_254_740_993n],
  amounts: [new Decimal("1.10"), new Decimal(`${index}.25`)],
  moments: [new Date(Date.UTC(2026, 1, 2, 3, 4, 5, 6))],
  statuses: ["live, now" as const, "draft" as const],
  ...extra,
});

const sealed: RawSqlQuery<unknown>[] = [];
const realtime = {
  seal: async ({ query }: { readonly query: RawSqlQuery<never> }) => {
    sealed.push(query);
    return {
      capability: "capability",
      queryFingerprint: "fingerprint",
      expiresAt: Date.now() + 60_000,
    };
  },
};

/** The live value Neon's rows decode to, through the real browser half. */
async function liveRead(
  db: object,
  database: PGlite,
  model: string,
  operation: string,
  args: unknown
) {
  const delegate = (db as Record<string, unknown>)[model] as Record<
    string,
    (args: unknown) => Promise<unknown>
  >;
  const query = await delegate[`${operation}Realtime`]!(args);
  const statement = sealed.at(-1)!;
  const { rows } = await database.query<Record<string, unknown>>(
    statement.sql,
    statement.parameters.map((parameter) => parameter.value),
    {
      parsers: NEON_PARSERS,
      paramTypes: statement.parameters.map((parameter) => parameter.typeOid),
    }
  );
  // A materialized live result has no order of its own.
  native.data = [...rows].reverse();
  const transported = JSON.parse(JSON.stringify(query));
  const subscription = subscribe(transported, { url: "wss://realtime" });
  return {
    ordinary: await delegate[operation]!(args),
    seed: realtimeData(transported),
    live: subscription.getSnapshot(),
    rows,
    sql: statement.sql,
  };
}

describe("Neon Realtime reads on embedded PostgreSQL", () => {
  const getFamily = usePGliteSchemaFamily(schema);

  beforeEach(async () => {
    const { client } = getFamily();
    await client.author.createMany({
      data: [
        { id: 1, name: "Ada" },
        { id: 2, name: "Bob" },
      ],
    });
    const posts = [
      row("p1", 0, { authorId: 1, parentId: null }),
      row("p2", 1, { authorId: 1, parentId: "p1" }),
      row("p3", 2, { authorId: 2, parentId: "p1" }),
      row("p4", 3, { authorId: 2, parentId: "p2" }),
      row("p5", 4, { authorId: 1, parentId: "p4" }),
    ];
    for (const data of posts) await client.post.create({ data });
  });

  const live = (model: "author" | "post", operation: string, args: unknown) =>
    liveRead(
      getFamily().client.$extends(neonRealtime({ realtime })),
      getFamily().database,
      model,
      operation,
      args
    );

  const cases: [string, "author" | "post", string, unknown][] = [
    [
      "every scalar and list",
      "post",
      "findMany",
      { orderBy: { createdAt: "desc" } },
    ],
    [
      "nested relations, ordered pages and counts",
      "author",
      "findMany",
      {
        orderBy: { name: "desc" },
        select: {
          name: true,
          posts: {
            orderBy: { rank: "desc" },
            take: 2,
            select: {
              id: true,
              rank: true,
              tags: true,
              flags: true,
              author: true,
            },
          },
          _count: { select: { posts: true } },
        },
      },
    ],
    [
      "a negative take",
      "post",
      "findMany",
      { orderBy: { id: "asc" }, take: -2, select: { id: true } },
    ],
    [
      "distinct",
      "post",
      "findMany",
      {
        distinct: ["authorId"],
        orderBy: { title: "desc" },
        select: { id: true, authorId: true },
      },
    ],
    [
      "a recursive relation",
      "post",
      "findMany",
      {
        where: { parentId: null },
        select: {
          id: true,
          title: true,
          replies: {
            recurse: { depth: 3 },
            select: { id: true, counts: true },
          },
        },
      },
    ],
    [
      "parameters: dates, JSON, lists and decimals",
      "post",
      "findMany",
      {
        where: {
          createdAt: {
            in: [
              new Date(Date.UTC(2026, 0, 1, 12, 30, 15, 123)),
              new Date(Date.UTC(2026, 0, 2, 12, 30, 15, 123)),
            ],
          },
          day: { gte: new Date(Date.UTC(2025, 5, 1)) },
          price: { gt: new Decimal("0") },
          tags: { has: "a,b" },
          counts: { hasSome: [0, 1] },
          OR: [
            {
              meta: {
                equals: {
                  id: "p1",
                  nested: [1, "two", { three: null }],
                  quote: 'a"b',
                },
              },
            },
            { meta: { path: ["id"], equals: "p2" } },
          ],
        },
        orderBy: { id: "asc" },
        select: { id: true },
      },
    ],
    [
      "findFirst",
      "post",
      "findFirst",
      { orderBy: { rank: "asc" }, select: { id: true, rank: true } },
    ],
    ["findFirst without a row", "post", "findFirst", { where: { id: "none" } }],
    [
      "findUnique",
      "post",
      "findUnique",
      { where: { id: "p3" }, include: { author: true, parent: true } },
    ],
    [
      "findUniqueOrThrow",
      "post",
      "findUniqueOrThrow",
      { where: { id: "p2" }, select: { id: true } },
    ],
    [
      "findFirstOrThrow",
      "post",
      "findFirstOrThrow",
      { orderBy: { id: "desc" }, select: { id: true } },
    ],
    ["count", "post", "count", { where: { published: true } }],
    [
      "a selected count",
      "post",
      "count",
      { select: { _all: true, rank: true } },
    ],
    ["exist", "post", "exist", { where: { authorId: 2 } }],
    ["exist without a row", "post", "exist", { where: { authorId: 3 } }],
    [
      "aggregate",
      "post",
      "aggregate",
      {
        _count: { _all: true, rank: true },
        _sum: { rank: true, score: true, views: true, price: true },
        _avg: { rank: true, price: true },
        _min: { createdAt: true, title: true },
        _max: { price: true, day: true },
      },
    ],
    [
      "groupBy",
      "post",
      "groupBy",
      {
        by: ["authorId"],
        _count: { _all: true },
        _sum: { price: true },
        orderBy: { authorId: "desc" },
      },
    ],
  ];

  it.each(
    cases
  )("%s: the live value is the ordinary value", async (name, model, operation, args) => {
    const {
      ordinary,
      seed,
      live: snapshot,
      sql,
    } = await live(model, operation, args);
    expect(sql).not.toMatch(REFUSED);
    expect(sql).toContain(`"${getFamily().namespace}".`);
    // The fixture is seeded: an empty answer is only ever the asked-for one.
    if (!name.includes("without"))
      expect(ordinary === null || (ordinary as unknown[]).length === 0).toBe(
        false
      );
    expect(snapshot.status).toBe("live");
    expect(snapshot.data).toEqual(ordinary);
    expect(seed).toEqual(ordinary);
  });

  it("names recursive rows by ordinal: no omitted key reaches the rows", async () => {
    const {
      ordinary,
      live: snapshot,
      rows,
    } = await live("post", "findMany", {
      where: { parentId: null },
      select: {
        rank: true,
        replies: { recurse: { depth: 3 }, select: { score: true } },
      },
    });
    expect(snapshot.data).toEqual(ordinary);
    expect(JSON.stringify(ordinary)).toContain("4.25");
    expect(JSON.stringify(rows)).not.toMatch(POST_ID);
  });
});

const org = s
  .model({
    id: s.string().id(),
    name: s.string(),
    members: s.toMany(() => member),
    projects: s.toMany(() => project),
  })
  .map("rt_orgs");
const member = s
  .model({
    id: s.string().id(),
    userId: s.string(),
    role: s.string(),
    orgId: s.string(),
    org: s
      .toOne(() => org)
      .fields("orgId")
      .references("id"),
  })
  .map("rt_members");
const project = s
  .model({
    id: s.string().id(),
    name: s.string(),
    budget: s.int(),
    ownerId: s.string(),
    orgId: s.string(),
    org: s
      .toOne(() => org)
      .fields("orgId")
      .references("id"),
  })
  .map("rt_projects");
const inOrg = { members: { some: { userId: { actor: "userId" } } } } as const;
// A relation predicate, an `$exists` with a `$row` reference, an actor
// parameter and a read-gated field: all of it in the sealed SQL.
const policy = permissions({
  actor: v.object({ userId: v.string() }),
  levels: ["read", "full"],
  models: {
    org: { read: inOrg },
    member: { read: true },
    project: {
      read: { org: { is: inOrg } },
      full: {
        OR: [
          { ownerId: { actor: "userId" } },
          {
            $exists: {
              member: {
                userId: { actor: "userId" },
                role: "admin",
                orgId: { $row: "orgId", up: 1 },
              },
            },
          },
        ],
      },
      fields: { budget: { read: "full" } },
    },
  },
});
// Only u1's org (o1) and u1's own budget (pA) are readable as u1.
const HIDDEN_FROM_U1 = /o2|pC|200|300/;

describe("Neon Realtime reads through permissions on embedded PostgreSQL", () => {
  const getFamily = usePGliteSchemaFamily({ org, member, project });

  beforeEach(async () => {
    const { client } = getFamily();
    await client.org.createMany({
      data: [
        { id: "o1", name: "One" },
        { id: "o2", name: "Two" },
      ],
    });
    await client.member.createMany({
      data: [
        { id: "m1", userId: "u1", role: "member", orgId: "o1" },
        { id: "m2", userId: "u2", role: "admin", orgId: "o1" },
        { id: "m3", userId: "u3", role: "member", orgId: "o2" },
      ],
    });
    await client.project.createMany({
      data: [
        { id: "pA", name: "A", budget: 100, ownerId: "u1", orgId: "o1" },
        { id: "pB", name: "B", budget: 200, ownerId: "u3", orgId: "o1" },
        { id: "pC", name: "C", budget: 300, ownerId: "u3", orgId: "o2" },
      ],
    });
  });

  const as = (userId: string) =>
    getFamily()
      .client.$extends(policy)
      .$extends(neonRealtime({ realtime }))
      .$as({ userId });

  // A read-gated field read where the caller writes it (where, orderBy,
  // aggregates, groupBy) is masked in the SQL; projected, only the decoder
  // would withhold it, so that is refused.
  const OMIT_BUDGET = { omit: { budget: true } };
  it.each([
    ["u1", "findMany", { ...OMIT_BUDGET, include: { org: true } }],
    ["u2", "findMany", { ...OMIT_BUDGET, orderBy: { budget: "desc" } }],
    ["u1", "count", { where: { budget: { gt: 150 } } }],
    ["u1", "aggregate", { _sum: { budget: true }, _max: { budget: true } }],
    ["u1", "groupBy", { by: ["budget"], _count: { _all: true } }],
  ])("%s %s: the live value is the permitted ordinary value", async (actor, operation, args) => {
    const { ordinary, seed, live, rows, sql } = await liveRead(
      as(actor),
      getFamily().database,
      "project",
      operation,
      args
    );
    expect(sql).not.toMatch(REFUSED);
    expect(live.data).toEqual(ordinary);
    expect(seed).toEqual(ordinary);
    if (actor === "u1")
      expect(JSON.stringify(rows)).not.toMatch(HIDDEN_FROM_U1);
  });

  it("refuses a read-gated field's projection", async () => {
    await expect(as("u1").project.findManyRealtime()).rejects.toThrow(
      "read-gated field"
    );
    await expect(
      as("u1").project.findManyRealtime({ select: { budget: true } })
    ).rejects.toThrow("read-gated field");
  });
});
