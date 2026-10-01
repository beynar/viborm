/**
 * Cold-start probe shaped like a Worker: each arm is bundled into ONE minified
 * file (as wrangler does), then every sample is a fresh process that seeds a
 * database (untimed), evaluates the bundle, builds schema + client, and runs
 * one first query. Phases are timed separately; medians are reported.
 *
 *   node benchmarks/probe-cold.mjs --a dist [--b /abs/dist] [--drizzle /dir]
 *     [--workload unique|rows20|relation20] [--samples 15]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({
  strict: false,
  options: {
    a: { type: "string" },
    b: { type: "string" },
    drizzle: { type: "string" },
    workload: { type: "string", default: "unique" },
    samples: { type: "string", default: "15" },
    worker: { type: "string" },
    out: { type: "string", default: "/tmp/viborm-probe-cold" },
  },
});
const self = fileURLToPath(import.meta.url);
const root = resolve(dirname(self), "..");
const require = createRequire(`${root}/package.json`);

const query = {
  viborm: {
    unique: `c.user.findUnique({ where: { id: "u42" } })`,
    rows20: `c.post.findMany({ orderBy: { id: "asc" }, take: 20 })`,
    relation20: `c.post.findMany({ select: { id: true, title: true, author: { select: { id: true, name: true } } }, orderBy: { id: "asc" }, take: 20 })`,
  },
  drizzle: {
    unique: `db.query.users.findFirst({ where: { id: "u42" } })`,
    rows20: `db.query.posts.findMany({ orderBy: { id: "asc" }, limit: 20 })`,
    relation20: `db.query.posts.findMany({ columns: { id: true, title: true }, with: { author: { columns: { id: true, name: true } } }, orderBy: { id: "asc" }, limit: 20 })`,
  },
};

const entry = (lib, dir, workload) =>
  lib === "drizzle"
    ? `import { defineRelations } from "${dir}/node_modules/drizzle-orm/index.js";
import { sqliteTable, text, integer } from "${dir}/node_modules/drizzle-orm/sqlite-core/index.js";
import { drizzle } from "${dir}/node_modules/drizzle-orm/better-sqlite3/index.js";
export function schema() {
  const users = sqliteTable("users", { id: text("id").primaryKey(), name: text("name"), email: text("email").notNull(), age: integer("age") });
  const posts = sqliteTable("posts", { id: text("id").primaryKey(), title: text("title").notNull(), content: text("content"), published: integer("published", { mode: "boolean" }).notNull(), views: integer("views").notNull(), authorId: text("authorId").notNull() });
  return defineRelations({ users, posts }, (r) => ({ users: { posts: r.many.posts() }, posts: { author: r.one.users({ from: r.posts.authorId, to: r.users.id }) } }));
}
export const client = (relations, database) => drizzle({ client: database, relations, jit: false });
export const first = (db) => ${query.drizzle[workload]};`
    : `import { s } from "${dir}/schema.mjs";
import { createClient } from "${dir}/index.mjs";
import { SQLite3Driver } from "${dir}/sqlite3.mjs";
export function schema() {
  const user = s.model({ id: s.string().id(), name: s.string().nullable(), email: s.string(), age: s.int().nullable(), posts: s.toMany(() => post) }).map("users");
  const post = s.model({ id: s.string().id(), title: s.string(), content: s.string().nullable(), published: s.boolean(), views: s.int(), authorId: s.string(), author: s.toOne(() => user).fields("authorId").references("id") }).map("posts");
  return { user, post };
}
export const client = (schema, database) => createClient({ schema, driver: new SQLite3Driver({ client: database }) });
export const first = (c) => ${query.viborm[workload]};`;

async function bundle(label, lib, dir, workload) {
  const esbuild = await import(
    pathToFileURL(
      require.resolve("esbuild", {
        paths: [`${root}/node_modules/.pnpm/esbuild@0.28.1/node_modules`],
      })
    )
  );
  mkdirSync(o.out, { recursive: true });
  const input = `${o.out}/${label}-entry.mjs`;
  const output = `${o.out}/${label}-${workload}.mjs`;
  writeFileSync(input, entry(lib, dir, workload));
  await esbuild.build({
    entryPoints: [input],
    outfile: output,
    bundle: true,
    minify: true,
    format: "esm",
    platform: "neutral",
    external: ["better-sqlite3", "node:*"],
    mainFields: ["module", "main"],
    logLevel: "error",
  });
  return output;
}

async function sample(file) {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT NOT NULL, age INTEGER); CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT, published INTEGER NOT NULL, views INTEGER NOT NULL, authorId TEXT NOT NULL)"
  );
  const u = db.prepare("INSERT INTO users VALUES (?,?,?,?)");
  const p = db.prepare("INSERT INTO posts VALUES (?,?,?,?,?,?)");
  for (let i = 0; i < 100; i++) u.run(`u${i}`, `User ${i}`, `u${i}@x.com`, 20 + i);
  for (let i = 0; i < 1000; i++)
    p.run(`p${i}`, `Post ${i}`, `c${i}`, i % 2, i, `u${i % 100}`);
  const t0 = performance.now();
  const app = await import(pathToFileURL(file));
  const t1 = performance.now();
  const c = app.client(app.schema(), db);
  const t2 = performance.now();
  await app.first(c);
  const t3 = performance.now();
  return { evaluate: t1 - t0, construct: t2 - t1, first: t3 - t2, total: t3 - t0 };
}

if (o.worker) {
  process.stdout.write(JSON.stringify(await sample(o.worker)));
  process.exit(0);
}

const median = (xs) => {
  const s = [...xs].sort((x, y) => x - y);
  const h = Math.floor(s.length / 2);
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
const arms = [];
if (o.a) arms.push(["A", "viborm", resolve(o.a)]);
if (o.b) arms.push(["B", "viborm", resolve(o.b)]);
if (o.drizzle) arms.push(["drizzle", "drizzle", resolve(o.drizzle)]);
const files = [];
for (const [label, lib, dir] of arms)
  files.push([label, await bundle(label, lib, dir, o.workload)]);
const results = new Map(files.map(([label]) => [label, []]));
for (let i = 0; i < Number(o.samples); i++)
  for (const [label, file] of i % 2 ? [...files].reverse() : files)
    results
      .get(label)
      .push(
        JSON.parse(
          execFileSync(process.execPath, [self, "--worker", file], {
            encoding: "utf8",
          })
        )
      );
for (const [label, file] of files) {
  const xs = results.get(label);
  const m = (k) => median(xs.map((x) => x[k])).toFixed(2);
  console.log(
    `${o.workload.padEnd(10)} ${label.padEnd(8)} bundle ${(statSync(file).size / 1024).toFixed(0)} KiB | evaluate ${m("evaluate")} ms  construct ${m("construct")} ms  first ${m("first")} ms  total ${m("total")} ms`
  );
}
