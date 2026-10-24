/**
 * Manual hosted smoke for Neon Realtime (not in CI): needs `pnpm package:build`
 * and ./.env (DATABASE_URL, NEON_REALTIME_SECRET, NEON_REALTIME_DATABASE,
 * NEON_REALTIME_URL) for a disposable Neon database with Realtime enabled. One
 * namespace, the nine live reads through JSON, one update, one renewal, a
 * recursive read without its keys, and permission-filtered reads with a
 * permitted and a forbidden update; prints check names only.
 *   node scripts/run-node-safe.mjs 512 300000 tests/providers/hosted/neon-realtime-smoke.mjs
 */
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createRealtime } from "@neon/realtime/server";
import { Decimal, s } from "../../../dist/index.mjs";
import {
  Decimal as BrowserDecimal,
  subscribe,
} from "../../../dist/neon-realtime/client.mjs";
import { neonRealtime } from "../../../dist/neon-realtime.mjs";
import { permissions } from "../../../dist/permissions.mjs";
import { createClient } from "../../../dist/pg.mjs";
import { v } from "../../../dist/validation.mjs";

process.loadEnvFile(new URL("../../../.env", import.meta.url));
const env = (key) => {
  if (!process.env[key]) throw new Error(`Missing ${key} in .env`);
  return process.env[key];
};

const author = s
  .model({
    id: s.string().id(),
    name: s.string().map("display_name"),
    posts: s.toMany(() => post),
  })
  .map("rt_authors");
const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    rank: s.int(),
    price: s.decimal({ precision: 12, scale: 2 }),
    at: s.dateTime().map("created_at"),
    tags: s.string().array(),
    meta: s.json(),
    authorId: s.string(),
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

const namespace = `viborm_rt_${randomBytes(4).toString("hex")}`;
const base = createClient({
  schema: { author, post },
  databaseUrl: env("DATABASE_URL"),
  namespace,
});
const realtime = createRealtime({
  secret: env("NEON_REALTIME_SECRET"),
  db: env("NEON_REALTIME_DATABASE"),
});
const db = base.$extends(neonRealtime({ realtime }));
// Ada reads her own posts and Bob's; `price` only on her own. A relation
// predicate, an `$exists` with a `$row` reference and actor parameters.
const governed = base
  .$extends(
    permissions({
      actor: v.object({ id: v.string() }),
      levels: ["read", "full"],
      models: {
        author: { read: true },
        post: {
          read: {
            OR: [
              { author: { is: { name: "Bob" } } },
              {
                $exists: {
                  author: {
                    id: { $row: "authorId", up: 1 },
                    AND: [{ id: { actor: "id" } }],
                  },
                },
              },
            ],
          },
          full: { authorId: { actor: "id" } },
          fields: { price: { read: "full" } },
        },
      },
    })
  )
  .$extends(neonRealtime({ realtime }))
  .$as({ id: "a1" });
const url = env("NEON_REALTIME_URL");
const subscriptions = [];
const wire = (value) => JSON.parse(JSON.stringify(value));

/** A value compared by meaning: the browser decodes into its own Decimal class. */
const comparable = (value) =>
  JSON.parse(
    JSON.stringify(value ?? null, function (key, item) {
      const raw = this[key];
      if (raw instanceof Date) return { date: item };
      if (raw instanceof Decimal || raw instanceof BrowserDecimal)
        return { decimal: item };
      return item;
    })
  );

/** Resolve once the subscription is live with `expected`, or fail in 20 s. */
function liveWith(subscription, value) {
  const expected = comparable(value);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const { status, error, data } = subscription.getSnapshot();
      const done =
        status === "live" && isDeepStrictEqual(comparable(data), expected);
      if (status !== "error" && !done && Date.now() - started < 20_000) return;
      clearInterval(timer);
      if (done) resolve();
      else reject(error ?? new Error("not live with the expected value"));
    }, 50);
  });
}

async function check(name, work) {
  const started = Date.now();
  await work();
  process.stdout.write(`ok  ${name} (${Date.now() - started} ms)\n`);
}

const READS = [
  ["findMany", { orderBy: { rank: "desc" }, include: { author: true } }],
  ["findFirst", { where: { rank: { gt: 1 } }, orderBy: { rank: "asc" } }],
  [
    "findUnique",
    { where: { id: "p1" }, select: { id: true, tags: true, meta: true } },
  ],
  [
    "findFirstOrThrow",
    { orderBy: { at: "desc" }, select: { id: true, at: true } },
  ],
  [
    "findUniqueOrThrow",
    { where: { id: "p2" }, include: { author: { select: { name: true } } } },
  ],
  ["count", { where: { rank: { gte: 2 } } }],
  ["exist", { where: { title: "Second" } }],
  [
    "aggregate",
    { _sum: { price: true }, _max: { at: true }, _count: { _all: true } },
  ],
  [
    "groupBy",
    { by: ["authorId"], _count: { _all: true }, orderBy: { authorId: "asc" } },
  ],
];

try {
  await check("namespace and fixture rows", async () => {
    await base.$executeRawUnsafe(`CREATE SCHEMA "${namespace}"`);
    await base.$executeRawUnsafe(
      `CREATE TABLE "${namespace}".rt_authors (id text PRIMARY KEY, display_name text NOT NULL)`
    );
    await base.$executeRawUnsafe(
      `CREATE TABLE "${namespace}".rt_posts (id text PRIMARY KEY, title text NOT NULL, rank integer NOT NULL, price numeric(12,2) NOT NULL, created_at timestamptz NOT NULL, tags text[] NOT NULL, meta jsonb NOT NULL, "authorId" text NOT NULL REFERENCES "${namespace}".rt_authors (id), "parentId" text REFERENCES "${namespace}".rt_posts (id))`
    );
    await base.author.createMany({
      data: [
        { id: "a1", name: "Ada" },
        { id: "a2", name: "Bob" },
        { id: "a3", name: "Cy" },
      ],
    });
    await base.post.createMany({
      data: [
        {
          id: "p1",
          title: "First",
          rank: 1,
          price: new Decimal("10.50"),
          at: new Date("2026-01-01T10:00:00.123Z"),
          tags: ["a,b", 'q"'],
          meta: { n: 1 },
          authorId: "a1",
        },
        {
          id: "p2",
          title: "Second",
          rank: 2,
          price: new Decimal("0.25"),
          at: new Date("2026-02-01T10:00:00.000Z"),
          tags: [],
          meta: [1, "two"],
          authorId: "a2",
        },
      ],
    });
  });

  for (const [operation, args] of READS)
    await check(
      `${operation}Realtime is live with the ordinary value`,
      async () => {
        const query = wire(await db.post[`${operation}Realtime`](args));
        const subscription = subscribe(query, { url });
        subscriptions.push(subscription);
        await liveWith(subscription, await db.post[operation](args));
      }
    );

  const live = subscriptions[0];
  await check("a committed update reaches the live read", async () => {
    await base.post.update({
      where: { id: "p1" },
      data: { rank: 3, price: new Decimal("11.00") },
    });
    await liveWith(live, await db.post.findMany(READS[0][1]));
  });

  await check("a renewal keeps the subscription live", async () => {
    const renewal = wire(
      await db.post.findManyRealtime(READS[0][1], { initialData: false })
    );
    await live.renew(renewal);
    await base.post.create({
      data: {
        id: "p3",
        title: "Third",
        rank: 5,
        price: new Decimal("1.00"),
        at: new Date(),
        tags: ["x"],
        meta: { n: 3 },
        authorId: "a1",
      },
    });
    await liveWith(live, await db.post.findMany(READS[0][1]));
  });

  await check("a recursive read without its keys is live", async () => {
    await base.post.update({ where: { id: "p2" }, data: { parentId: "p1" } });
    const args = {
      where: { parentId: null },
      orderBy: { title: "asc" },
      select: {
        title: true,
        replies: { recurse: { depth: 2 }, select: { title: true } },
      },
    };
    const subscription = subscribe(wire(await db.post.findManyRealtime(args)), {
      url,
    });
    subscriptions.push(subscription);
    await liveWith(subscription, await db.post.findMany(args));
    await base.post.update({ where: { id: "p3" }, data: { parentId: "p2" } });
    await liveWith(subscription, await db.post.findMany(args));
  });

  await check("permission-filtered reads are live", async () => {
    await base.post.create({
      data: {
        id: "p4",
        title: "Hidden",
        rank: 9,
        price: new Decimal("9.00"),
        at: new Date(),
        tags: [],
        meta: {},
        authorId: "a3",
      },
    });
    const reads = [
      ["findMany", { omit: { price: true }, orderBy: { id: "asc" } }],
      ["aggregate", { _sum: { price: true }, _count: { _all: true } }],
      ["count", { where: { price: { gt: "0" } } }],
    ];
    const seen = [];
    const live = [];
    for (const [operation, args] of reads) {
      const subscription = subscribe(
        wire(await governed.post[`${operation}Realtime`](args)),
        { url, onChange: ({ data }) => seen.push(JSON.stringify(data)) }
      );
      subscriptions.push(subscription);
      live.push([subscription, operation, args]);
      await liveWith(subscription, await governed.post[operation](args));
    }
    // A forbidden row changes, then a permitted one: only the second shows.
    await base.post.update({ where: { id: "p4" }, data: { title: "Moved" } });
    await base.post.update({
      where: { id: "p2" },
      data: { title: "Second, edited", price: new Decimal("2.00") },
    });
    await base.post.update({
      where: { id: "p1" },
      data: { price: new Decimal("12.00") },
    });
    for (const [subscription, operation, args] of live)
      await liveWith(subscription, await governed.post[operation](args));
    // A renewal is admitted again, as Ada.
    const [[first, , firstArgs]] = live;
    await first.renew(
      wire(
        await governed.post.findManyRealtime(firstArgs, { initialData: false })
      )
    );
    await base.post.update({ where: { id: "p2" }, data: { rank: 7 } });
    await liveWith(first, await governed.post.findMany(firstArgs));
    if (
      seen.some((data) => data?.includes("Hidden") || data?.includes("Moved"))
    )
      throw new Error("a forbidden row reached a live read");
  });
} finally {
  for (const subscription of subscriptions) subscription.unsubscribe();
  await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
  await base.$disconnect();
}
process.stdout.write("Neon Realtime hosted smoke passed\n");
// Node's WebSocket holds a closed socket until the server's closing handshake.
process.exit(0);
