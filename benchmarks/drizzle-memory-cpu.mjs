/**
 * Memory-allocation + CPU-time comparison: viborm vs drizzle vs raw
 * better-sqlite3 on identical schema, data, and queries (the same shapes as
 * drizzle.bench.ts). Uses the built public package so V8 samples
 * production-shaped JavaScript.
 *
 * Per workload: allocated bytes/op (V8 HeapProfiler sampling), CPU µs/op
 * (process.cpuUsage), wall µs/op and ops/sec.
 * This legacy same-process comparison is exploratory only. It is not valid
 * evidence for a performance keep decision.
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
import { readBenchmarkOperation } from "../dist/internal/benchmark-operation.mjs";
import { push } from "../dist/migrations.mjs";
import { s } from "../dist/schema.mjs";
import { SQLite3Driver } from "../dist/sqlite3.mjs";

const DDL_USERS =
  'CREATE TABLE "users" ("id" text primary key, "name" text, "email" text not null, "age" integer)';
const DDL_POSTS =
  'CREATE TABLE "posts" ("id" text primary key, "title" text not null, "content" text, "published" integer not null, "views" integer not null, "authorId" text not null)';

const seed = async (run) => {
  for (let i = 0; i < 100; i++) {
    await run(
      'INSERT INTO "users" ("id","name","email","age") VALUES (?,?,?,?)',
      [`u${i}`, `User ${i}`, `u${i}@x.com`, 20 + (i % 50)]
    );
  }
  for (let i = 0; i < 1000; i++) {
    await run(
      'INSERT INTO "posts" ("id","title","content","published","views","authorId") VALUES (?,?,?,?,?,?)',
      [`p${i}`, `Post ${i}`, `content ${i}`, i % 2, i, `u${i % 100}`]
    );
  }
};

// ---------- raw better-sqlite3 ----------
const rawDb = new Database(":memory:");
rawDb.exec(DDL_USERS);
rawDb.exec(DDL_POSTS);
await seed((sql, params) => rawDb.prepare(sql).run(...params));

// ---------- viborm ----------
const user = s
  .model({
    id: s.string().id(),
    name: s.string().nullable(),
    email: s.string(),
    age: s.int().nullable(),
    posts: s.toMany(() => post),
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
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
  })
  .map("posts");
const vibormDriver = new SQLite3Driver({ dataDir: ":memory:" });
const viborm = createClient({ schema: { user, post }, driver: vibormDriver });
await push(viborm, { force: true });
await seed((sql, params) => vibormDriver._executeRaw(sql, params));

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
  published: integer("published", { mode: "boolean" }).notNull(),
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
await seed((sql, params) => drizzleSqlite.prepare(sql).run(...params));
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

function benchmarkOperation(operation) {
  const capability = readBenchmarkOperation(operation);
  if (!capability) throw new Error("Expected a VibORM benchmark operation");
  return capability;
}

const findUniquePrepared = benchmarkOperation(
  viborm.user.findUnique({ where: { id: "u42" } })
).prepare();
const findManyPrepared = benchmarkOperation(
  viborm.post.findMany({
    where: { published: true },
    select: { id: true, title: true, views: true },
    orderBy: { views: "desc" },
    take: 20,
  })
).prepare();
const relationArgs = {
  select: {
    id: true,
    title: true,
    author: { select: { id: true, name: true } },
  },
  take: 20,
};
const relationPrepared = benchmarkOperation(
  viborm.post.findMany(relationArgs)
).prepare();
const findMany1000Prepared = benchmarkOperation(
  viborm.post.findMany({ take: 1000 })
).prepare();
const createOperation = viborm.user.create({
  data: { id: "__raw_id__", name: "B", email: "b@x.com", age: 30 },
});
const createStatement = createOperation.buildStatement();
const createPrepared =
  benchmarkOperation(createOperation).prepare() ??
  (createStatement ? vibormDriver._prepare(createStatement) : undefined);
for (const [name, prepared] of Object.entries({
  findUniquePrepared,
  findManyPrepared,
  relationPrepared,
  findMany1000Prepared,
  createPrepared,
})) {
  if (!prepared)
    throw new Error(`${name} did not produce a prepared statement`);
}
const rawCreateIdIndex = createPrepared.params.indexOf("__raw_id__");
if (rawCreateIdIndex < 0) {
  throw new Error(
    "The prepared create statement did not expose its ID parameter"
  );
}
// Prepared params are driver-level values; viborm's SQLite driver converts
// booleans at execution time, so the raw better-sqlite3 arms convert here.
const toSqliteParams = (params) =>
  params.map((value) => (typeof value === "boolean" ? Number(value) : value));
const findUniqueRawParams = toSqliteParams(findUniquePrepared.params);
const findManyRawParams = toSqliteParams(findManyPrepared.params);
const relationRawParams = toSqliteParams(relationPrepared.params);
const findMany1000RawParams = toSqliteParams(findMany1000Prepared.params);
const rawCreateParams = toSqliteParams(createPrepared.params);

function checksumRawRelation(rows) {
  const first = rows[0];
  if (!first) return 0;
  for (const value of Object.values(first)) {
    if (typeof value === "string" && value.includes("User ")) {
      const nestedScalarOffset = value.indexOf("User ");
      return value.charCodeAt(nestedScalarOffset + 5);
    }
  }
  throw new Error(
    "The exact relation SQL did not return a nested scalar carrier"
  );
}

const shapes = [
  {
    name: "findUnique by id",
    iters: 4000,
    raw: () => {
      sink += rawDb
        .prepare(findUniquePrepared.sql)
        .get(...findUniqueRawParams).age;
    },
    drizzle: () => {
      sink += ddb
        .select()
        .from(dUsers)
        .where(eq(dUsers.id, "u42"))
        .limit(1)
        .all().length;
    },
    viborm: async () => {
      sink += (await viborm.user.findUnique({ where: { id: "u42" } })).age;
    },
  },
  {
    name: "findMany 20, filter + order",
    iters: 2000,
    raw: () => {
      const rows = rawDb
        .prepare(findManyPrepared.sql)
        .all(...findManyRawParams);
      sink += rows.length + rows[0].views;
    },
    drizzle: () => {
      const rows = ddb
        .select({ id: dPosts.id, title: dPosts.title, views: dPosts.views })
        .from(dPosts)
        .where(eq(dPosts.published, true))
        .orderBy(desc(dPosts.views))
        .limit(20)
        .all();
      sink += rows.length + rows[0].views;
    },
    viborm: async () => {
      const rows = await viborm.post.findMany({
        where: { published: true },
        select: { id: true, title: true, views: true },
        orderBy: { views: "desc" },
        take: 20,
      });
      sink += rows.length + rows[0].views;
    },
  },
  {
    name: "findMany 20 with nested relation",
    iters: 1000,
    raw: () => {
      const rows = rawDb
        .prepare(relationPrepared.sql)
        .all(...relationRawParams);
      sink += rows.length + checksumRawRelation(rows);
    },
    drizzle: async () => {
      const rows = await ddb.query.posts.findMany({
        columns: { id: true, title: true },
        with: { author: { columns: { id: true, name: true } } },
        limit: 20,
      });
      sink += rows.length + (rows[0].author?.name?.charCodeAt(5) ?? 0);
    },
    viborm: async () => {
      const rows = await viborm.post.findMany(relationArgs);
      sink += rows.length + (rows[0].author?.name?.charCodeAt(5) ?? 0);
    },
  },
  {
    name: "insert 1 row",
    iters: 2000,
    raw: () => {
      rawCreateParams[rawCreateIdIndex] = `r${rawId++}`;
      sink += rawDb.prepare(createPrepared.sql).get(...rawCreateParams).age;
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
      const rows = rawDb
        .prepare(findMany1000Prepared.sql)
        .all(...findMany1000RawParams);
      sink += rows.length + rows[0].views;
    },
    drizzle: () => {
      const rows = ddb.select().from(dPosts).limit(1000).all();
      if (typeof rows[0].published !== "boolean") {
        throw new Error("Drizzle did not decode published as a boolean");
      }
      sink += rows.length + rows[0].views + Number(rows[0].published);
    },
    viborm: async () => {
      const rows = await viborm.post.findMany({ take: 1000 });
      if (typeof rows[0].published !== "boolean") {
        throw new Error("VibORM did not decode published as a boolean");
      }
      sink += rows.length + rows[0].views + Number(rows[0].published);
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

console.log(
  JSON.stringify(
    {
      measurementProtocolValid: false,
      invalidReason:
        "Libraries and modes share one process instead of fresh isolated workers.",
      results,
      sink,
    },
    null,
    2
  )
);

await vibormDriver.disconnect();
