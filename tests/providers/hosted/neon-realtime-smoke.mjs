/**
 * Manual hosted smoke for Neon Realtime (not in CI): needs `pnpm package:build`
 * and ./.env (DATABASE_URL, NEON_REALTIME_SECRET, NEON_REALTIME_DATABASE,
 * NEON_REALTIME_URL) for a disposable Neon database with Realtime enabled. One
 * namespace, the nine live reads through JSON, one update, one renewal; prints
 * check names only.
 *   node scripts/run-node-safe.mjs 512 300000 tests/providers/hosted/neon-realtime-smoke.mjs
 */
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createRealtime } from "@neon/realtime/server";
import { Decimal, s } from "../../../dist/index.mjs";
import { subscribe } from "../../../dist/neon-realtime/client.mjs";
import { neonRealtime } from "../../../dist/neon-realtime.mjs";
import { createClient } from "../../../dist/pg.mjs";

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
const url = env("NEON_REALTIME_URL");
const subscriptions = [];
const wire = (value) => JSON.parse(JSON.stringify(value));

/** Resolve once the subscription is live with `expected`, or fail in 20 s. */
function liveWith(subscription, expected) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const { status, error, data } = subscription.getSnapshot();
      const done = status === "live" && isDeepStrictEqual(data, expected);
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
      `CREATE TABLE "${namespace}".rt_posts (id text PRIMARY KEY, title text NOT NULL, rank integer NOT NULL, price numeric(12,2) NOT NULL, created_at timestamptz NOT NULL, tags text[] NOT NULL, meta jsonb NOT NULL, "authorId" text NOT NULL REFERENCES "${namespace}".rt_authors (id))`
    );
    await base.author.createMany({
      data: [
        { id: "a1", name: "Ada" },
        { id: "a2", name: "Bob" },
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
} finally {
  for (const subscription of subscriptions) subscription.unsubscribe();
  await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
  await base.$disconnect();
}
process.stdout.write("Neon Realtime hosted smoke passed\n");
// Node's WebSocket holds a closed socket until the server's closing handshake.
process.exit(0);
