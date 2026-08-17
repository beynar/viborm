/**
 * Memory-allocation + CPU-time comparison: viborm vs drizzle vs raw
 * better-sqlite3 on identical schema, data, and queries (the same shapes as
 * drizzle.bench.ts). Uses the built public package so V8 samples
 * production-shaped JavaScript.
 *
 * Per workload: allocated bytes/op (V8 HeapProfiler sampling), CPU µs/op
 * (process.cpuUsage), wall µs/op and ops/sec.
 *
 * Run:
 *   pnpm package:build
 *   node benchmarks/drizzle-memory-cpu.mjs
 */
import inspector from "node:inspector";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { desc, eq, relations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createClient } from "../dist/index.mjs";
import { push } from "../dist/migrations.mjs";
import { s } from "../dist/schema.mjs";
import { SQLite3Driver } from "../dist/sqlite3.mjs";

const DDL_USERS =
  'CREATE TABLE "users" ("id" text primary key, "name" text, "email" text not null, "age" integer)';
const DDL_POSTS =
  'CREATE TABLE "posts" ("id" text primary key, "title" text not null, "content" text, "published" integer not null, "views" integer not null, "authorId" text not null)';

const seed = (run) => {
  for (let i = 0; i < 100; i++) {
    run('INSERT INTO "users" ("id","name","email","age") VALUES (?,?,?,?)', [
      `u${i}`,
      `User ${i}`,
      `u${i}@x.com`,
      20 + (i % 50),
    ]);
  }
  for (let i = 0; i < 1000; i++) {
    run(
      'INSERT INTO "posts" ("id","title","content","published","views","authorId") VALUES (?,?,?,?,?,?)',
      [`p${i}`, `Post ${i}`, `content ${i}`, i % 2, i, `u${i % 100}`]
    );
  }
};

// ---------- raw better-sqlite3 ----------
const rawDb = new Database(":memory:");
rawDb.exec(DDL_USERS);
rawDb.exec(DDL_POSTS);
seed((sql, params) => rawDb.prepare(sql).run(...params));

// ---------- viborm ----------
const user = s
  .model({
    id: s.string().id(),
    name: s.string().nullable(),
    email: s.string(),
    age: s.int().nullable(),
    posts: s.oneToMany(() => post),
  })
  .map("users");
const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    content: s.string().nullable(),
    published: s.boolean().default(false),
    views: s.int().default(0),
    authorId: s.string(),
    author: s
      .manyToOne(() => user)
      .fields("authorId")
      .references("id"),
  })
  .map("posts");
const vibormDriver = new SQLite3Driver({ dataDir: ":memory:" });
const viborm = createClient({ schema: { user, post }, driver: vibormDriver });
await push(viborm, { force: true });
seed((sql, params) => vibormDriver._executeRaw(sql, params));

// ---------- drizzle ----------
const dUsers = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name"),
  email: text("email").notNull(),
  age: integer("age"),
});
const dPosts = sqliteTable("posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content"),
  published: integer("published").notNull(),
  views: integer("views").notNull(),
  authorId: text("authorId").notNull(),
});
const dUsersRel = relations(dUsers, ({ many }) => ({ posts: many(dPosts) }));
const dPostsRel = relations(dPosts, ({ one }) => ({
  author: one(dUsers, { fields: [dPosts.authorId], references: [dUsers.id] }),
}));
const drizzleSqlite = new Database(":memory:");
drizzleSqlite.exec(DDL_USERS);
drizzleSqlite.exec(DDL_POSTS);
seed((sql, params) => drizzleSqlite.prepare(sql).run(...params));
const ddb = drizzle(drizzleSqlite, {
  schema: {
    users: dUsers,
    posts: dPosts,
    usersRelations: dUsersRel,
    postsRelations: dPostsRel,
  },
});

// ---------- workloads (identical shapes to drizzle.bench.ts) ----------
let sink = 0;
let rawId = 0;
let drizzleId = 0;
let vibormId = 0;

const shapes = [
  {
    name: "findUnique by id",
    iters: 4000,
    raw: () => {
      sink += rawDb
        .prepare('SELECT * FROM "users" WHERE "id" = ? LIMIT 1')
        .get("u42").age;
    },
    drizzle: () => {
      sink += ddb.select().from(dUsers).where(eq(dUsers.id, "u42")).limit(1).all()
        .length;
    },
    viborm: async () => {
      sink += (await viborm.user.findUnique({ where: { id: "u42" } })).age;
    },
  },
  {
    name: "findMany 20, filter + order",
    iters: 2000,
    raw: () => {
      sink += rawDb
        .prepare(
          'SELECT "id","title","views" FROM "posts" WHERE "published" = 1 ORDER BY "views" DESC LIMIT 20'
        )
        .all().length;
    },
    drizzle: () => {
      sink += ddb
        .select({ id: dPosts.id, title: dPosts.title, views: dPosts.views })
        .from(dPosts)
        .where(eq(dPosts.published, 1))
        .orderBy(desc(dPosts.views))
        .limit(20)
        .all().length;
    },
    viborm: async () => {
      sink += (
        await viborm.post.findMany({
          where: { published: true },
          select: { id: true, title: true, views: true },
          orderBy: { views: "desc" },
          take: 20,
        })
      ).length;
    },
  },
  {
    name: "findMany 20 with nested relation",
    iters: 1000,
    raw: () => {
      sink += rawDb
        .prepare(
          'SELECT p."id", p."title", u."id" as aid, u."name" as aname FROM "posts" p JOIN "users" u ON u."id" = p."authorId" LIMIT 20'
        )
        .all().length;
    },
    drizzle: async () => {
      sink += (
        await ddb.query.posts.findMany({
          columns: { id: true, title: true },
          with: { author: { columns: { id: true, name: true } } },
          limit: 20,
        })
      ).length;
    },
    viborm: async () => {
      sink += (
        await viborm.post.findMany({
          select: {
            id: true,
            title: true,
            author: { select: { id: true, name: true } },
          },
          take: 20,
        })
      ).length;
    },
  },
  {
    name: "insert 1 row",
    iters: 2000,
    raw: () => {
      sink += rawDb
        .prepare(
          'INSERT INTO "users" ("id","name","email","age") VALUES (?,?,?,?) RETURNING *'
        )
        .get(`r${rawId++}`, "B", "b@x.com", 30).age;
    },
    drizzle: () => {
      sink += ddb
        .insert(dUsers)
        .values({ id: `d${drizzleId++}`, name: "B", email: "b@x.com", age: 30 })
        .returning()
        .all().length;
    },
    viborm: async () => {
      sink += (
        await viborm.user.create({
          data: { id: `v${vibormId++}`, name: "B", email: "b@x.com", age: 30 },
        })
      ).age;
    },
  },
  {
    name: "findMany 1000 rows",
    iters: 200,
    raw: () => {
      sink += rawDb.prepare('SELECT * FROM "posts" LIMIT 1000').all().length;
    },
    drizzle: () => {
      sink += ddb.select().from(dPosts).limit(1000).all().length;
    },
    viborm: async () => {
      sink += (await viborm.post.findMany({ take: 1000 })).length;
    },
  },
];

// ---------- measurement ----------
function postSession(session, method, params = {}) {
  return new Promise((resolve, reject) => {
    session.post(method, params, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

function sampledBytes(node) {
  let bytes = node.selfSize ?? 0;
  for (const child of node.children ?? []) bytes += sampledBytes(child);
  return bytes;
}

async function run(workload, iters) {
  for (let i = 0; i < iters; i++) await workload();
}

async function measure(workload, iters) {
  await run(workload, Math.ceil(iters / 4)); // warmup

  const session = new inspector.Session();
  session.connect();
  let allocatedBytesPerOp;
  try {
    await postSession(session, "HeapProfiler.enable");
    await postSession(session, "HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    await run(workload, iters);
    const { profile } = await postSession(session, "HeapProfiler.stopSampling");
    allocatedBytesPerOp = sampledBytes(profile.head) / iters;
  } finally {
    session.disconnect();
  }

  const cpuBefore = process.cpuUsage();
  const wallBefore = performance.now();
  await run(workload, iters);
  const wallMs = performance.now() - wallBefore;
  const cpu = process.cpuUsage(cpuBefore);

  return {
    allocatedBytesPerOp,
    cpuUsPerOp: (cpu.user + cpu.system) / iters,
    wallUsPerOp: (wallMs * 1000) / iters,
    opsPerSec: (iters / wallMs) * 1000,
  };
}

const results = [];
for (const shape of shapes) {
  for (const lib of ["raw", "drizzle", "viborm"]) {
    const m = await measure(shape[lib], shape.iters);
    results.push({ shape: shape.name, lib, iters: shape.iters, ...m });
    console.error(`done: ${shape.name} / ${lib}`);
  }
}

const rows = results.map((r) => ({
  shape: r.shape,
  lib: r.lib,
  "alloc KB/op": (r.allocatedBytesPerOp / 1024).toFixed(2),
  "cpu µs/op": r.cpuUsPerOp.toFixed(1),
  "wall µs/op": r.wallUsPerOp.toFixed(1),
  "ops/sec": Math.round(r.opsPerSec).toLocaleString("en-US"),
}));
console.table(rows);

const ratioRows = shapes.map((shape) => {
  const byLib = Object.fromEntries(
    results.filter((r) => r.shape === shape.name).map((r) => [r.lib, r])
  );
  return {
    shape: shape.name,
    "viborm/drizzle alloc": (
      byLib.viborm.allocatedBytesPerOp / byLib.drizzle.allocatedBytesPerOp
    ).toFixed(2),
    "viborm/drizzle cpu": (
      byLib.viborm.cpuUsPerOp / byLib.drizzle.cpuUsPerOp
    ).toFixed(2),
    "viborm/drizzle ops": (
      byLib.viborm.opsPerSec / byLib.drizzle.opsPerSec
    ).toFixed(2),
  };
});
console.table(ratioRows);

console.log(JSON.stringify({ results, sink }, null, 2));

await vibormDriver.disconnect();
