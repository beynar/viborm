/**
 * The same viborm calls on PostgreSQL and SurrealDB, over the same rows, in
 * alternating rounds. Not a test: it runs only with SURREAL_PERF set, writes its
 * medians to that path, and asserts that both answers agree.
 */

import { writeFileSync } from "node:fs";
import { createClient } from "@client/client";
import { PgDriver } from "@drivers/pg";
import { s } from "@schema";
import {
  createSurrealTestDriver,
  surrealUrl,
} from "@tests/fixtures/drivers/surrealdb";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { expect, it } from "vitest";

const output = process.env.SURREAL_PERF;
const scale = Number(process.env.SURREAL_PERF_SCALE ?? 1);
const USERS = 2000 * scale;
const POSTS = 20_000 * scale;
const COMMENTS = 20_000 * scale;
const TAGS = 200 * scale;
const ROUNDS = Number(process.env.SURREAL_PERF_ROUNDS ?? 9);
const pgUrl =
  process.env.SURREAL_PERF_PG ??
  "postgresql://postgres:password@127.0.0.1:5434/viborm_bench";

const user = s.model({
  id: s.string().id(),
  email: s.string().unique(),
  age: s.int().nullable(),
  score: s.int(),
  posts: s.toMany(() => post),
  invoices: s.toMany(() => invoice),
  following: s.toMany(() => user).name("follows"),
  followers: s.toMany(() => user).name("follows"),
});
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  rank: s.int(),
  published: s.boolean(),
  note: s.string().nullable(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id")
    .onDelete("cascade"),
  comments: s.toMany(() => comment),
  tags: s.toMany(() => tag),
});
const comment = s.model({
  id: s.string().id(),
  body: s.string(),
  rank: s.int(),
  postId: s.string(),
  post: s
    .toOne(() => post)
    .fields("postId")
    .references("id")
    .onDelete("cascade"),
});
const tag = s.model({
  id: s.string().id(),
  name: s.string().unique(),
  rank: s.int(),
  posts: s.toMany(() => post),
});
const account = s
  .model({
    tenant: s.string(),
    code: s.string(),
    label: s.string(),
    invoices: s.toMany(() => invoice),
  })
  .id(["tenant", "code"]);
const invoice = s.model({
  id: s.string().id(),
  tenant: s.string(),
  code: s.string(),
  total: s.int(),
  userId: s.string(),
  user: s
    .toOne(() => user)
    .fields("userId")
    .references("id")
    .onDelete("cascade"),
  account: s
    .toOne(() => account)
    .fields("tenant", "code")
    .references("tenant", "code")
    .onDelete("cascade"),
});
const node = s.model({
  id: s.string().id(),
  rank: s.int(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => node)
    .name("tree")
    .fields("parentId")
    .references("id")
    .onDelete("setNull"),
  children: s.toMany(() => node).name("tree"),
});
const schema = { user, post, comment, tag, account, invoice, node };

type Client = any;
type Operation = readonly [
  string,
  (db: Client, turn: number) => Promise<unknown>,
];

const u = (n: number) => `u${n % USERS}`;
const p = (n: number) => `p${n % POSTS}`;
const t = (n: number) => `t${n % TAGS}`;
const a = (n: number) => `c${n % 100}`;

const READS: readonly Operation[] = [
  ["findUnique, key", (db, i) => db.user.findUnique({ where: { id: u(i) } })],
  [
    "findUnique, unique field",
    (db, i) => db.user.findUnique({ where: { email: `${u(i)}@x.io` } }),
  ],
  [
    "findMany, indexed filter, order, take",
    (db, i) =>
      db.post.findMany({
        where: { authorId: u(i) },
        orderBy: { rank: "desc" },
        take: 10,
      }),
  ],
  [
    "findMany, unindexed filter, take",
    (db, i) =>
      db.post.findMany({
        where: { rank: { gt: 900 + (i % 50) } },
        orderBy: { id: "asc" },
        take: 20,
      }),
  ],
  [
    "findMany, nullable order, take",
    (db) =>
      db.user.findMany({
        orderBy: { age: "desc" },
        take: 20,
        select: { id: true, age: true },
      }),
  ],
  [
    "include to-many, take",
    (db, i) =>
      db.user.findUnique({
        where: { id: u(i) },
        include: { posts: { orderBy: { rank: "desc" }, take: 5 } },
      }),
  ],
  [
    "include to-one, 20 rows",
    (db, i) =>
      db.post.findMany({
        where: { authorId: u(i) },
        take: 20,
        orderBy: { id: "asc" },
        include: { author: true },
      }),
  ],
  [
    "include three levels",
    (db, i) =>
      db.user.findUnique({
        where: { id: u(i) },
        select: {
          id: true,
          posts: {
            orderBy: { rank: "desc" },
            take: 3,
            select: {
              id: true,
              comments: {
                orderBy: { rank: "desc" },
                take: 3,
                select: { id: true, post: { select: { title: true } } },
              },
            },
          },
        },
      }),
  ],
  [
    "include many-to-many",
    (db, i) =>
      db.post.findUnique({
        where: { id: p(i) },
        include: { tags: { orderBy: { rank: "desc" }, take: 5 } },
      }),
  ],
  [
    "_count of a to-many, 20 rows",
    (db) =>
      db.user.findMany({
        take: 20,
        orderBy: { id: "asc" },
        select: { id: true, _count: { select: { posts: true } } },
      }),
  ],
  [
    "filter some, broad, take 1",
    (db) =>
      db.user.findMany({
        where: { posts: { some: { id: { startsWith: "p" } } } },
        take: 1,
        orderBy: { id: "asc" },
        select: { id: true },
      }),
  ],
  [
    "filter some, to-many",
    (db, i) =>
      db.user.findMany({
        where: { posts: { some: { rank: 500 + (i % 50) } } },
        take: 20,
        orderBy: { id: "asc" },
        select: { id: true },
      }),
  ],
  [
    "filter none, to-many",
    (db, i) =>
      db.user.count({
        where: { posts: { none: { rank: { gt: 990 + (i % 5) } } } },
      }),
  ],
  [
    "filter every, to-many",
    (db, i) =>
      db.user.count({
        where: { posts: { every: { rank: { gt: i % 5 } } } },
      }),
  ],
  [
    "filter some, to-one",
    (db, i) =>
      db.post.findMany({
        where: { author: { email: `${u(i)}@x.io` } },
        take: 20,
        orderBy: { id: "asc" },
        select: { id: true },
      }),
  ],
  [
    "filter some, many-to-many",
    (db, i) =>
      db.post.findMany({
        where: { tags: { some: { name: `${t(i)}` } } },
        take: 20,
        orderBy: { id: "asc" },
        select: { id: true },
      }),
  ],
  [
    "filter, two relations down",
    (db, i) =>
      db.user.findMany({
        where: { posts: { some: { comments: { some: { rank: i % 50 } } } } },
        take: 20,
        orderBy: { id: "asc" },
        select: { id: true },
      }),
  ],
  ["count, whole table", (db) => db.post.count()],
  ["count, filtered", (db, i) => db.post.count({ where: { authorId: u(i) } })],
  [
    "aggregate, filtered",
    (db, i) =>
      db.post.aggregate({
        where: { authorId: u(i) },
        _sum: { rank: true },
        _avg: { rank: true },
        _max: { rank: true },
      }),
  ],
  [
    "groupBy, having, take",
    (db) =>
      db.post.groupBy({
        by: ["published"],
        _count: true,
        _sum: { rank: true },
        orderBy: { published: "asc" },
      }),
  ],
  [
    "distinct, take",
    (db) =>
      db.post.findMany({
        distinct: ["published"],
        orderBy: { rank: "desc" },
        take: 2,
        select: { id: true },
      }),
  ],
  [
    "cursor page",
    (db, i) =>
      db.post.findMany({
        cursor: { id: p(i) },
        orderBy: { id: "asc" },
        take: 10,
        select: { id: true },
      }),
  ],
  [
    "compound key, findUnique",
    (db, i) =>
      db.account.findUnique({
        where: { tenant_code: { tenant: "t", code: a(i) } },
      }),
  ],
  [
    "compound key, filter a part",
    (db) => db.account.findMany({ where: { tenant: "t" }, take: 5 }),
  ],
  [
    "compound relation, include to-many",
    (db, i) =>
      db.account.findUnique({
        where: { tenant_code: { tenant: "t", code: a(i) } },
        include: { invoices: { take: 5, orderBy: { id: "asc" } } },
      }),
  ],
  [
    "compound relation, include to-one, 20 rows",
    (db) =>
      db.invoice.findMany({
        take: 20,
        orderBy: { id: "asc" },
        include: { account: true },
      }),
  ],
  [
    "recurse, depth 3",
    (db) =>
      db.node.findUnique({
        where: { id: "n0" },
        select: {
          id: true,
          children: {
            recurse: { depth: 3 },
            orderBy: { id: "asc" },
            select: { id: true },
          },
        },
      }),
  ],
  [
    "recurse, exhaustive",
    (db) =>
      db.node.findUnique({
        where: { id: "n0" },
        select: {
          id: true,
          children: {
            recurse: { depth: false },
            orderBy: { id: "asc" },
            select: { id: true },
          },
        },
      }),
  ],
];

let serial = 0;
const WRITES: readonly Operation[] = [
  [
    "create",
    (db) =>
      db.user.create({
        data: { id: `w${++serial}`, email: `w${serial}@x.io`, score: 1 },
      }),
  ],
  [
    "createMany, 100",
    (db) => {
      const base = (serial += 100);
      return db.comment.createMany({
        data: Array.from({ length: 100 }, (_, n) => ({
          id: `wc${base - n}`,
          body: "b",
          rank: n,
          postId: "p0",
        })),
      });
    },
  ],
  [
    "update, key",
    (db, i) => db.user.update({ where: { id: u(i) }, data: { score: i } }),
  ],
  [
    "updateMany, filtered",
    (db, i) =>
      db.post.updateMany({
        where: { authorId: u(i) },
        data: { rank: { increment: 1 } },
      }),
  ],
  [
    "upsert, unique field, found",
    (db, i) =>
      db.user.upsert({
        where: { email: `${u(i)}@x.io` },
        create: { id: `nope${i}`, email: `${u(i)}@x.io`, score: 0 },
        update: { score: i },
      }),
  ],
  [
    "create, nested create",
    (db) =>
      db.user.create({
        data: {
          id: `n${++serial}`,
          email: `n${serial}@x.io`,
          score: 1,
          posts: {
            create: {
              id: `np${serial}`,
              title: "t",
              rank: 1,
              published: true,
            },
          },
        },
      }),
  ],
  [
    "connect, many-to-many, 3 targets",
    (db, i) =>
      db.post.update({
        where: { id: p(i + 7) },
        data: {
          tags: {
            connect: [{ id: t(i + 1) }, { id: t(i + 2) }, { id: t(i + 3) }],
          },
        },
      }),
  ],
  [
    "disconnect, many-to-many",
    (db, i) =>
      db.post.update({
        where: { id: p(i + 7) },
        data: { tags: { disconnect: { id: t(i + 2) } } },
      }),
  ],
  [
    "delete by key",
    (db) => {
      const id = `wd${++serial}`;
      return db.user
        .create({ data: { id, email: `${id}@x.io`, score: 0 } })
        .then(() => db.user.delete({ where: { id } }));
    },
  ],
];

async function seed(db: Client) {
  const batches = async (
    total: number,
    row: (n: number) => unknown,
    run: (rows: unknown[]) => Promise<unknown>
  ) => {
    for (let start = 0; start < total; start += 1000)
      await run(
        Array.from({ length: Math.min(1000, total - start) }, (_, n) =>
          row(start + n)
        )
      );
  };
  await batches(
    USERS,
    (n) => ({
      id: `u${n}`,
      email: `u${n}@x.io`,
      score: n % 100,
      ...(n % 3 ? { age: n % 80 } : {}),
    }),
    (data) => db.user.createMany({ data })
  );
  await batches(
    POSTS,
    (n) => ({
      id: `p${n}`,
      title: `title ${n}`,
      rank: (n * 7919) % 1000,
      published: n % 2 === 0,
      authorId: `u${(n * 31) % USERS}`,
      ...(n % 4 ? { note: "x" } : {}),
    }),
    (data) => db.post.createMany({ data })
  );
  await batches(
    COMMENTS,
    (n) => ({
      id: `c${n}`,
      body: "b",
      rank: n % 1000,
      postId: `p${(n * 17) % POSTS}`,
    }),
    (data) => db.comment.createMany({ data })
  );
  await batches(
    TAGS,
    (n) => ({ id: `t${n}`, name: `t${n}`, rank: (n * 37) % 100 }),
    (data) => db.tag.createMany({ data })
  );
  await batches(
    100,
    (n) => ({ tenant: "t", code: `c${n}`, label: `l${n}` }),
    (data) => db.account.createMany({ data })
  );
  await batches(
    2000 * scale,
    (n) => ({
      id: `i${n}`,
      tenant: "t",
      code: `c${n % 100}`,
      total: n % 500,
      userId: `u${n % USERS}`,
    }),
    (data) => db.invoice.createMany({ data })
  );
  await batches(
    1000,
    (n) => ({
      id: `n${n}`,
      rank: n,
      ...(n === 0 ? {} : { parentId: `n${Math.floor((n - 1) / 3)}` }),
    }),
    (data) => db.node.createMany({ data })
  );
  // Three tags a post, on one in ten: connects go through the engine's own path.
  for (let n = 0; n < POSTS / 10; n += 1)
    await db.post.update({
      where: { id: `p${n * 10}` },
      data: {
        tags: {
          connect: [
            { id: `t${n % TAGS}` },
            { id: `t${(n + 13) % TAGS}` },
            { id: `t${(n + 57) % TAGS}` },
          ],
        },
      },
    });
}

const median = (values: readonly number[]) =>
  [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)]!;

it.skipIf(!(output && surrealUrl))(
  "the same calls on PostgreSQL and SurrealDB",
  { timeout: 3_600_000 },
  async () => {
    const onPg: Client = createClient({
      schema,
      driver: new PgDriver({ databaseUrl: pgUrl }),
    });
    const onSurreal: Client = createClient({
      schema,
      driver: createSurrealTestDriver(),
    });
    await syncLiveSchema(onPg, { force: true, forceReset: true });
    await syncLiveSchema(onSurreal);
    const started = Date.now();
    await seed(onPg);
    const pgSeed = Date.now() - started;
    await seed(onSurreal);
    const surrealSeed = Date.now() - started - pgSeed;
    const rows: Record<string, unknown>[] = [
      {
        op: "seed",
        pg: pgSeed,
        surreal: surrealSeed,
        ratio: surrealSeed / pgSeed,
      },
    ];
    const disagreements: string[] = [];
    const time = async (run: () => Promise<unknown>) => {
      const at = performance.now();
      const value = await run();
      return [performance.now() - at, value] as const;
    };
    for (const [op, run] of [...READS, ...WRITES]) {
      const pg: number[] = [];
      const surreal: number[] = [];
      for (let round = 0; round < ROUNDS; round += 1) {
        try {
          // Who goes first alternates, and so whose cache is warm.
          const [first, second] =
            round % 2 ? [onSurreal, onPg] : [onPg, onSurreal];
          const [a0, a1] = await time(() => run(first, round));
          const [b0, b1] = await time(() => run(second, round));
          (round % 2 ? surreal : pg).push(a0);
          (round % 2 ? pg : surreal).push(b0);
          if (
            READS.some((read) => read[0] === op) &&
            JSON.stringify(a1) !== JSON.stringify(b1)
          )
            disagreements.push(`${op}, round ${round}`);
        } catch (error) {
          rows.push({
            op,
            error: String((error as Error).message).slice(0, 160),
          });
          break;
        }
      }
      if (pg.length && surreal.length)
        rows.push({
          op,
          pg: median(pg),
          surreal: median(surreal),
          ratio: median(surreal) / median(pg),
        });
    }
    writeFileSync(
      output!,
      JSON.stringify({ scale, ROUNDS, rows, disagreements }, null, 1)
    );
    await onPg.$disconnect();
    await onSurreal.$disconnect();
    // A timing of a wrong answer, or of none, measures nothing.
    expect(disagreements).toEqual([]);
    expect(rows.filter((row) => "error" in row)).toEqual([]);
  }
);
