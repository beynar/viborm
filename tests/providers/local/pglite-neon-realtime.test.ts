/**
 * Neon Realtime on embedded PostgreSQL: each live read's exact sealed SQL and
 * parameters run here, and the browser half decodes their rows into the value
 * the ordinary read returns. The family lives in a non-public namespace.
 */

import type { RawSqlQuery } from "@neon/realtime/server";
import { s } from "@schema";
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

describe("Neon Realtime reads on embedded PostgreSQL", () => {
  const getFamily = usePGliteSchemaFamily(schema);
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

  /** The live value Neon's rows decode to, through the real browser half. */
  async function live(
    model: "author" | "post",
    operation: string,
    args: unknown
  ) {
    const { client, database } = getFamily();
    const db = client.$extends(neonRealtime({ realtime }));
    const delegate = db[model] as unknown as Record<
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
          title: true,
          replies: {
            recurse: { depth: 3 },
            select: { id: true, counts: true },
          },
        },
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

  it("refuses a recursive projection that leaves its key out", async () => {
    const { client } = getFamily();
    const db = client.$extends(neonRealtime({ realtime }));
    await expect(
      db.post.findManyRealtime({
        select: {
          title: true,
          replies: { recurse: { depth: 2 }, select: { title: true } },
        },
      })
    ).rejects.toThrow("recursive 'replies' without its key fields selected");
  });

  it("publishes an OrThrow read losing its row as a NotFoundError", async () => {
    const { client } = getFamily();
    const db = client.$extends(neonRealtime({ realtime }));
    const query = await db.post.findUniqueOrThrowRealtime({
      where: { id: "p1" },
    });
    native.data = [];
    const snapshot = subscribe(JSON.parse(JSON.stringify(query)), {
      url: "wss://realtime",
    }).getSnapshot();
    expect(snapshot.status).toBe("error");
    expect(snapshot.error?.cause).toMatchObject({ name: "NotFoundError" });
    expect(snapshot.data).toMatchObject({ id: "p1" });
  });
});
