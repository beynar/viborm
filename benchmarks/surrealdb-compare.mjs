/**
 * SurrealDB against PostgreSQL on one machine, through the public API, plain and under
 * each official extension. Both servers local, so the numbers compare the statements
 * and the engines, not a network.
 *
 *   pnpm package:build
 *   PG_URL=postgresql://postgres:password@127.0.0.1:5434/viborm \
 *   SURREAL_URL=ws://127.0.0.1:8765/rpc node benchmarks/surrealdb-compare.mjs
 *
 * SURREAL_MAX_QUERY_PARSING_DEPTH=128 on the server, as for permissions at any depth.
 */

import { randomBytes } from "node:crypto";
import pg from "pg";
import { Surreal } from "surrealdb";
import { s } from "../dist/index.mjs";
import { createMigrationClient as pgMigrations } from "../dist/migrations/postgres.mjs";
import { createMigrationClient as surrealMigrations } from "../dist/migrations/surrealdb.mjs";
import { on } from "../dist/on.mjs";
import { ordering, orderingKey } from "../dist/ordering.mjs";
import { permissions } from "../dist/permissions.mjs";
import { createClient as pgClient } from "../dist/pg.mjs";
import { softDelete } from "../dist/soft-delete.mjs";
import { createClient as surrealClient } from "../dist/surrealdb.mjs";
import { v } from "../dist/validation.mjs";

const AUTHORS = 200;
const POSTS = 20;
const CARDS = 100;
const ROUNDS = Number(process.env.ROUNDS ?? 200);

const schema = () => {
  const org = s.model({
    id: s.string().id(),
    name: s.string(),
    members: s.toMany(() => member),
    authors: s.toMany(() => author),
  });
  const member = s.model({
    id: s.string().id(),
    orgId: s.string(),
    userId: s.string(),
    role: s.string(),
    org: s
      .toOne(() => org)
      .fields("orgId")
      .references("id"),
  });
  const author = s.model({
    id: s.string().id(),
    name: s.string(),
    orgId: s.string(),
    org: s
      .toOne(() => org)
      .fields("orgId")
      .references("id"),
    posts: s.toMany(() => post),
    deletedAt: s.dateTime().nullable(),
  });
  const post = s.model({
    id: s.string().id(),
    title: s.string(),
    views: s.int(),
    authorId: s.string(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
    tags: s.toMany(() => tag),
    deletedAt: s.dateTime().nullable(),
  });
  const tag = s.model({
    id: s.string().id(),
    name: s.string(),
    posts: s.toMany(() => post),
  });
  const card = s
    .model({
      id: s.string().id(),
      orgId: s.string(),
      rank: s.string().schema(orderingKey),
      title: s.string(),
    })
    .index(["orgId", "rank", "id"]);
  return { org, member, author, post, tag, card };
};

const member = (extra = {}) => ({
  members: { some: { userId: { actor: "id" }, ...extra } },
});
const policy = () =>
  permissions({
    actor: v.object({ id: v.string() }),
    models: {
      org: { read: true },
      member: { read: true },
      tag: { read: true },
      author: {
        read: { org: { is: member() } },
        update: { org: { is: member({ role: "admin" }) } },
      },
      post: {
        read: { author: { is: { org: { is: member() } } } },
        update: { author: { is: { org: { is: member({ role: "admin" }) } } } },
      },
    },
  });

async function seed(db) {
  await db.org.createMany({
    data: [
      { id: "o1", name: "one" },
      { id: "o2", name: "two" },
    ],
  });
  await db.member.createMany({
    data: [
      { id: "m1", orgId: "o1", userId: "ann", role: "admin" },
      { id: "m2", orgId: "o2", userId: "bob", role: "reader" },
    ],
  });
  await db.author.createMany({
    data: Array.from({ length: AUTHORS }, (_, at) => ({
      id: `a${at}`,
      name: `author ${at}`,
      orgId: at % 2 ? "o1" : "o2",
    })),
  });
  await db.post.createMany({
    data: Array.from({ length: AUTHORS * POSTS }, (_, at) => ({
      id: `p${at}`,
      title: `post ${at}`,
      views: at % 100,
      authorId: `a${at % AUTHORS}`,
    })),
  });
}

let unique = 0;
const operations = (db, { governed, soft, hooked, ordered }) => ({
  "findUnique by key": () =>
    db.post.findUnique({ where: { id: `p${unique++ % 1000}` } }),
  "findMany 50 rows": () =>
    db.post.findMany({ take: 50, orderBy: { id: "asc" } }),
  "findMany with to-one and to-many": () =>
    db.author.findMany({
      take: 10,
      orderBy: { id: "asc" },
      include: { org: true, posts: { take: 5, orderBy: { id: "asc" } } },
    }),
  "relation filter": () =>
    db.author.findMany({
      take: 10,
      where: { posts: { some: { views: { gt: 90 } } } },
      orderBy: { id: "asc" },
    }),
  count: () => db.post.count({ where: { views: { gt: 50 } } }),
  create: () =>
    db.post.create({
      data: { id: `n${unique++}`, title: "new", views: 0, authorId: "a1" },
    }),
  "nested create": () =>
    db.author.create({
      data: {
        id: `na${unique++}`,
        name: "new",
        orgId: "o1",
        posts: {
          create: [
            { id: `np${unique++}`, title: "a", views: 1 },
            { id: `np${unique++}`, title: "b", views: 2 },
          ],
        },
      },
    }),
  update: () =>
    db.post.update({
      where: { id: `p${unique++ % 1000}` },
      data: { views: { increment: 1 } },
    }),
  "updateMany 20 rows": () =>
    db.post.updateMany({
      where: { authorId: `a${unique++ % AUTHORS}` },
      data: { views: 5 },
    }),
  transaction: () =>
    db.$transaction(async (tx) => {
      await tx.post.update({ where: { id: "p1" }, data: { views: 1 } });
      return await tx.post.findUnique({ where: { id: "p1" } });
    }),
  "soft delete: read": () =>
    soft.author.findMany({ take: 10, orderBy: { id: "asc" } }),
  "soft delete: delete": () =>
    soft.post.delete({ where: { id: `p${2000 + (unique++ % 2000)}` } }),
  "hooks: update": () =>
    hooked.post.update({
      where: { id: `p${unique++ % 1000}` },
      data: { views: 1 },
    }),
  "ordering: create": () =>
    ordered.card.create({
      data: { id: `c${unique++}`, orgId: "o2", title: "new" },
    }),
  "ordering: move": () =>
    ordered.card.move({
      where: { id: `c${unique++ % CARDS}` },
      first: true,
    }),
  "permissions: findUnique": () =>
    governed.$as({ id: "ann" }).post.findUnique({
      where: { id: "p1" },
    }),
  "permissions: findMany 10": () =>
    governed
      .$as({ id: "ann" })
      .post.findMany({ take: 10, orderBy: { id: "asc" } }),
  "permissions: update": () =>
    governed.$as({ id: "ann" }).post.update({
      where: { id: "p1" },
      data: { views: { increment: 1 } },
    }),
});

async function measure(db) {
  const governed = db.$extends(policy());
  const soft = softDelete({
    models: {
      author: { deletedAt: "deletedAt" },
      post: { deletedAt: "deletedAt" },
    },
  })(db);
  const hooked = db.$extends(on({ post: { update: () => undefined } }));
  const ordered = ordering({
    models: { card: { key: "rank", within: ["orgId"] } },
  })(db);
  for (let at = 0; at < CARDS; at++) {
    await ordered.card.create({
      data: { id: `c${at}`, orgId: "o1", title: `card ${at}` },
    });
  }
  const results = {};
  for (const [name, run] of Object.entries(
    operations(db, { governed, soft, hooked, ordered })
  )) {
    // A first run compiles what later ones reuse.
    await run();
    const times = [];
    for (let at = 0; at < ROUNDS; at++) {
      const begin = performance.now();
      await run();
      times.push(performance.now() - begin);
    }
    times.sort((a, b) => a - b);
    results[name] = {
      median: times[Math.floor(times.length / 2)],
      p95: times[Math.floor(times.length * 0.95)],
    };
  }
  return results;
}

async function run(db, migrations) {
  const m = migrations(db);
  const preview = await m.push({ dryRun: true });
  await m.push({ consent: preview.consent });
  const begin = performance.now();
  await seed(db);
  const seeded = performance.now() - begin;
  const results = await measure(db);
  results["seed (4,202 rows)"] = { median: seeded, p95: seeded };
  await db.$disconnect();
  return results;
}

const namespace = `bench_${randomBytes(4).toString("hex")}`;
const admin = new pg.Client({ connectionString: process.env.PG_URL });
await admin.connect();
await admin.query(`CREATE SCHEMA "${namespace}"`);
const root = new Surreal();
await root.connect(process.env.SURREAL_URL, {
  authentication: { username: "root", password: "root" },
});
await root.query(
  `DEFINE NAMESPACE IF NOT EXISTS bench; USE NS bench; DEFINE DATABASE ${namespace};`
);
await root.close();
const onPg = await run(
  pgClient({
    schema: schema(),
    databaseUrl: process.env.PG_URL,
    namespace,
  }),
  pgMigrations
);
const surreal = await run(
  surrealClient({
    schema: schema(),
    url: process.env.SURREAL_URL,
    namespace: "bench",
    database: namespace,
    authentication: { username: "root", password: "root" },
  }),
  surrealMigrations
);

await admin.query(`DROP SCHEMA "${namespace}" CASCADE`);
await admin.end();

const rows = Object.keys(onPg).map((name) => ({
  operation: name,
  "pg median ms": Number(onPg[name].median.toFixed(2)),
  "surreal median ms": Number(surreal[name].median.toFixed(2)),
  ratio: Number((surreal[name].median / onPg[name].median).toFixed(2)),
  "pg p95": Number(onPg[name].p95.toFixed(2)),
  "surreal p95": Number(surreal[name].p95.toFixed(2)),
}));
console.table(rows);
process.stdout.write(`${JSON.stringify(rows)}\n`);
