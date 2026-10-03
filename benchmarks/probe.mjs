/**
 * Quick CPU + allocation probe for iterating on VibORM performance (SQLite).
 *
 *   node benchmarks/probe.mjs --a dist [--b /abs/other/dist] [--drizzle /dir]
 *     [--workloads unique,filtered20,...] [--modes warm,fresh,cold] [--rounds 3]
 *
 * warm  : one client, repeated query.
 * fresh : new schema + driver + client + first query each op (code is JIT-warm).
 * client: schema built once, new driver + client + first query each op.
 * cold  : one new process per sample: import time, then construct + first query.
 *
 * ns/op is the median of batch means; bytes/op is the heapUsed delta over a
 * batch run with a 256 MiB young generation and no GC inside the batch, which
 * makes it near-deterministic (a GC inside the batch voids the sample).
 * Each (build, workload, mode) runs in its own process; builds alternate.
 * --drizzle points at a directory whose node_modules has drizzle-orm (1.0 RC).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { SourceMap } from "node:module";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { GCProfiler } from "node:v8";

const { values: opt } = parseArgs({
  strict: false,
  options: {
    a: { type: "string" },
    b: { type: "string" },
    drizzle: { type: "string" },
    workloads: {
      type: "string",
      default: "unique,filtered20,relation20,insert,rows20,rows1000",
    },
    modes: { type: "string", default: "warm,client,fresh,cold" },
    rounds: { type: "string", default: "3" },
    "cold-samples": { type: "string", default: "15" },
    worker: { type: "string" }, // internal: "<lib>|<dir>|<workload>|<mode>"
  },
});
const self = fileURLToPath(import.meta.url);
const root = resolve(self, "../..");

// ---------------------------------------------------------------- fixture
const users = Array.from({ length: 100 }, (_, i) => ({
  id: `u${i}`,
  name: i % 7 === 0 ? null : `User ${i}`,
  email: `u${i}@x.com`,
  age: 20 + (i % 50),
}));
const posts = Array.from({ length: 1000 }, (_, i) => ({
  id: `p${i}`,
  title: `Post ${i}`,
  content: `content ${i}`,
  published: Boolean(i % 2),
  views: i,
  authorId: `u${i % 100}`,
}));

export async function openSeededDatabase() {
  const require = (await import("node:module")).createRequire(
    `${root}/package.json`
  );
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT NOT NULL, age INTEGER); CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT, published INTEGER NOT NULL, views INTEGER NOT NULL, authorId TEXT NOT NULL)"
  );
  const u = db.prepare("INSERT INTO users VALUES (?,?,?,?)");
  const p = db.prepare("INSERT INTO posts VALUES (?,?,?,?,?,?)");
  db.transaction(() => {
    for (const x of users) u.run(x.id, x.name, x.email, x.age);
    for (const x of posts)
      p.run(x.id, x.title, x.content, +x.published, x.views, x.authorId);
  })();
  return db;
}

let nextId = 0;
const inserted = () => ({
  id: `n${process.pid}_${nextId++}`,
  name: "B",
  email: "b@x.com",
  age: 30,
});

const maps = new Map();
const SOURCE_PREFIX = /.*\/src\//;
/** Map a built-file URL + offset (or line/column) to `src/file.ts:line`. */
export const origin = (url, offset, line, column) => {
  const path = fileURLToPath(url);
  if (!maps.has(path)) {
    const text = readFileSync(path, "utf8");
    maps.set(
      path,
      existsSync(`${path}.map`)
        ? {
            text,
            map: new SourceMap(JSON.parse(readFileSync(`${path}.map`, "utf8"))),
          }
        : { text }
    );
  }
  const { text, map } = maps.get(path);
  if (!map) return "";
  let e;
  if (offset === undefined) e = map.findEntry(line, column);
  else {
    const before = text.slice(0, offset).split("\n");
    e = map.findEntry(before.length - 1, before.at(-1).length);
  }
  return e.originalSource
    ? `${e.originalSource.replace(SOURCE_PREFIX, "src/")}:${e.originalLine + 1}`
    : "";
};

// ---------------------------------------------------------------- libraries
export async function loadViborm(dir) {
  const { s } = await import(pathToFileURL(`${dir}/schema.mjs`));
  const { createClient } = await import(pathToFileURL(`${dir}/index.mjs`));
  const { SQLite3Driver } = await import(pathToFileURL(`${dir}/sqlite3.mjs`));
  const buildSchema = () => {
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
        published: s.boolean(),
        views: s.int(),
        authorId: s.string(),
        author: s
          .toOne(() => user)
          .fields("authorId")
          .references("id"),
      })
      .map("posts");
    return { user, post };
  };
  const make = (db, schema = buildSchema()) => {
    const c = createClient({
      schema,
      driver: new SQLite3Driver({ client: db }),
    });
    return {
      unique: () => c.user.findUnique({ where: { id: "u42" } }),
      filtered20: () =>
        c.post.findMany({
          where: { published: true },
          select: { id: true, title: true, views: true },
          orderBy: { views: "desc" },
          take: 20,
        }),
      relation20: () =>
        c.post.findMany({
          select: {
            id: true,
            title: true,
            author: { select: { id: true, name: true } },
          },
          orderBy: { id: "asc" },
          take: 20,
        }),
      insert: () => c.user.create({ data: inserted() }),
      rows20: () => c.post.findMany({ orderBy: { id: "asc" }, take: 20 }),
      rows1000: () => c.post.findMany({ orderBy: { id: "asc" }, take: 1000 }),
    };
  };
  return Object.assign(make, { buildSchema });
}

export async function loadDrizzle(dir) {
  const m = `${dir}/node_modules/drizzle-orm`;
  const { defineRelations } = await import(pathToFileURL(`${m}/index.js`));
  const { sqliteTable, text, integer } = await import(
    pathToFileURL(`${m}/sqlite-core/index.js`)
  );
  const { drizzle } = await import(
    pathToFileURL(`${m}/better-sqlite3/index.js`)
  );
  const buildSchema = () => {
    const usersT = sqliteTable("users", {
      id: text("id").primaryKey(),
      name: text("name"),
      email: text("email").notNull(),
      age: integer("age"),
    });
    const postsT = sqliteTable("posts", {
      id: text("id").primaryKey(),
      title: text("title").notNull(),
      content: text("content"),
      published: integer("published", { mode: "boolean" }).notNull(),
      views: integer("views").notNull(),
      authorId: text("authorId").notNull(),
    });
    const schema = { users: usersT, posts: postsT };
    const relations = defineRelations(schema, (r) => ({
      users: { posts: r.many.posts() },
      posts: {
        author: r.one.users({ from: r.posts.authorId, to: r.users.id }),
      },
    }));
    return { usersT, relations };
  };
  const make = (client, { usersT, relations } = buildSchema()) => {
    const db = drizzle({ client, relations, jit: false });
    return {
      unique: () => db.query.users.findFirst({ where: { id: "u42" } }),
      filtered20: () =>
        db.query.posts.findMany({
          where: { published: true },
          columns: { id: true, title: true, views: true },
          orderBy: { views: "desc", id: "asc" },
          limit: 20,
        }),
      relation20: () =>
        db.query.posts.findMany({
          columns: { id: true, title: true },
          with: { author: { columns: { id: true, name: true } } },
          orderBy: { id: "asc" },
          limit: 20,
        }),
      insert: () => db.insert(usersT).values(inserted()).returning().get(),
      rows20: () =>
        db.query.posts.findMany({ orderBy: { id: "asc" }, limit: 20 }),
      rows1000: () =>
        db.query.posts.findMany({ orderBy: { id: "asc" }, limit: 1000 }),
    };
  };
  return Object.assign(make, { buildSchema });
}

// ---------------------------------------------------------------- worker
const median = (xs) => {
  const s = [...xs].sort((x, y) => x - y);
  const h = Math.floor(s.length / 2);
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};

async function worker(spec) {
  const [lib, dir, workload, mode] = spec.split("|");
  const t0 = performance.now();
  const make = await (lib === "drizzle" ? loadDrizzle : loadViborm)(dir);
  const importMs = performance.now() - t0;
  const db = await openSeededDatabase();

  if (mode === "cold") {
    const t1 = performance.now();
    await make(db)[workload]();
    const firstMs = performance.now() - t1;
    return { importMs, firstMs };
  }

  const shared = mode === "warm" ? make(db) : undefined;
  // client: the schema is built once (module scope), a client per request.
  const schema = mode === "client" ? make.buildSchema() : undefined;
  const op =
    mode === "warm" ? shared[workload] : () => make(db, schema)[workload]();
  const result = await op();
  const witness = Array.isArray(result) ? result.length : result?.id;

  // Size batches to ~10 ms.
  for (let i = 0; i < 200; i++) await op();
  let n = 1;
  for (;;) {
    const s = performance.now();
    for (let i = 0; i < n; i++) await op();
    if (performance.now() - s > 10 || n > 1e5) break;
    n *= 2;
  }
  const times = [];
  for (let b = 0; b < 25; b++) {
    const s = process.hrtime.bigint();
    for (let i = 0; i < n; i++) await op();
    times.push(Number(process.hrtime.bigint() - s) / n);
  }

  const bytes = [];
  const allocN = Math.max(20, Math.min(n, 400));
  for (let b = 0; b < 5; b++) {
    globalThis.gc();
    const profiler = new GCProfiler();
    profiler.start();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < allocN; i++) await op();
    const h1 = process.memoryUsage().heapUsed;
    if (profiler.stop().statistics.length === 0) bytes.push((h1 - h0) / allocN);
  }
  return {
    importMs,
    witness,
    nsPerOp: median(times),
    nsMin: Math.min(...times),
    bytesPerOp: bytes.length ? Math.min(...bytes) : null,
  };
}

const isMain = process.argv[1] === self;
if (isMain && opt.worker) {
  const out = await worker(opt.worker);
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
if (isMain) await coordinate();

async function coordinate() {
  // ---------------------------------------------------------------- coordinator
  const arms = [];
  if (opt.a) arms.push(["A", "viborm", resolve(opt.a)]);
  if (opt.b) arms.push(["B", "viborm", resolve(opt.b)]);
  if (opt.drizzle) arms.push(["drizzle", "drizzle", resolve(opt.drizzle)]);
  if (!arms.length) throw new Error("pass --a <dist> (and --b / --drizzle)");

  const run = (lib, dir, workload, mode) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--expose-gc",
          "--max-semi-space-size=256",
          "--min-semi-space-size=256",
          self,
          "--worker",
          `${lib}|${dir}|${workload}|${mode}`,
        ],
        { encoding: "utf8", maxBuffer: 1_048_576 }
      )
    );

  const rows = [];
  for (const mode of opt.modes.split(",")) {
    for (const workload of opt.workloads.split(",")) {
      const acc = new Map(arms.map(([label]) => [label, []]));
      const rounds =
        mode === "cold" ? Number(opt["cold-samples"]) : Number(opt.rounds);
      for (let r = 0; r < rounds; r++) {
        const order = r % 2 ? [...arms].reverse() : arms;
        for (const [label, lib, dir] of order)
          acc.get(label).push(run(lib, dir, workload, mode));
      }
      const row = { mode, workload };
      for (const [label, xs] of acc) {
        row[label] =
          mode === "cold"
            ? {
                importMs: median(xs.map((x) => x.importMs)),
                firstMs: median(xs.map((x) => x.firstMs)),
              }
            : {
                ns: median(xs.map((x) => x.nsPerOp)),
                nsMin: Math.min(...xs.map((x) => x.nsMin)),
                bytes: median(
                  xs.map((x) => x.bytesPerOp).filter((x) => x != null)
                ),
                witness: xs[0].witness,
              };
      }
      rows.push(row);
      const fmt = (v) =>
        mode === "cold"
          ? `import ${v.importMs.toFixed(2)}ms first ${v.firstMs.toFixed(3)}ms`
          : `${(v.ns / 1000).toFixed(2)}µs (min ${(v.nsMin / 1000).toFixed(2)}) ${(v.bytes / 1024).toFixed(1)}KiB`;
      const delta = () => {
        if (!(row.A && row.B)) return "";
        const d = (x, y) => `${(((y - x) / x) * 100).toFixed(1)}%`;
        return mode === "cold"
          ? ` | B/A first ${d(row.A.firstMs, row.B.firstMs)}`
          : ` | B/A time ${d(row.A.ns, row.B.ns)} min ${d(row.A.nsMin, row.B.nsMin)} bytes ${d(row.A.bytes, row.B.bytes)}`;
      };
      console.log(
        `${mode.padEnd(5)} ${workload.padEnd(10)} ${arms.map(([l]) => `${l}: ${fmt(row[l])}`).join("  ")}${delta()}`
      );
    }
  }
}
