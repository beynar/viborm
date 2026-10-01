/**
 * Where the minified bytes of a typical app bundle go, and when they run.
 * Bundles a small realistic app (two related models, common scalar kinds,
 * better-sqlite3) the way a Worker ships it (one minified ESM file), then runs
 * it under V8 function coverage in phases. Each bundled function's own bytes
 * are attributed to its source file and to the first phase that ran it:
 *   load (module evaluation) · read · write · other (aggregate, groupBy,
 *   upsert, transactions, nested writes) · never.
 *
 *   node benchmarks/probe-shrink.mjs [--json out.json] [--top 40]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { createRequire, SourceMap } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({
  options: {
    json: { type: "string" },
    top: { type: "string", default: "40" },
  },
});
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(`${root}/package.json`);
// One output folder per checkout: worktrees may share one node_modules.
const out = `${root}/node_modules/.probe-shrink-${basename(root)}`;
mkdirSync(out, { recursive: true });

writeFileSync(
  `${out}/entry.mjs`,
  `import { s } from "${root}/src/schema/index.ts";
import { createClient } from "${root}/src/index.ts";
import { SQLite3Driver } from "${root}/src/drivers/sqlite3/index.ts";
const user = s.model({
  id: s.string().id(),
  email: s.string().unique(),
  name: s.string().nullable(),
  role: s.enum(["ADMIN", "MEMBER"]).default("MEMBER"),
  profile: s.json().nullable(),
  createdAt: s.dateTime().now(),
  posts: s.toMany(() => post),
}).map("users");
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  content: s.string().nullable(),
  published: s.boolean().default(false),
  views: s.int().default(0),
  createdAt: s.dateTime().now(),
  authorId: s.string(),
  author: s.toOne(() => user).fields("authorId").references("id"),
}).map("posts");
export const client = (db) => createClient({ schema: { user, post }, driver: new SQLite3Driver({ client: db }) });
export async function read(c) {
  await c.user.findUnique({ where: { id: "u1" } });
  await c.user.findFirst({ where: { email: { contains: "@" } }, orderBy: { createdAt: "desc" } });
  await c.post.findMany({ where: { published: true, views: { gte: 1 } }, select: { id: true, title: true }, orderBy: { views: "desc" }, take: 20 });
  await c.post.findMany({ include: { author: true }, take: 20 });
  await c.user.findMany({ include: { posts: { where: { published: true }, take: 5 } } });
  await c.post.count({ where: { authorId: "u1" } });
}
export async function write(c) {
  await c.user.create({ data: { id: "w1", email: "w1@x.dev", name: "W", profile: { a: 1 } } });
  await c.post.create({ data: { id: "wp1", title: "t", authorId: "w1" } });
  await c.post.update({ where: { id: "wp1" }, data: { views: { increment: 1 }, published: true } });
  await c.post.createMany({ data: [{ id: "wp2", title: "a", authorId: "w1" }, { id: "wp3", title: "b", authorId: "w1" }] });
  await c.post.updateMany({ where: { authorId: "w1" }, data: { content: "c" } });
  await c.post.delete({ where: { id: "wp3" } });
  await c.post.deleteMany({ where: { id: "wp2" } });
}
export async function other(c) {
  await c.user.upsert({ where: { id: "w2" }, create: { id: "w2", email: "w2@x.dev" }, update: { name: "u" } });
  await c.user.create({ data: { id: "w3", email: "w3@x.dev", posts: { create: [{ id: "wp4", title: "n" }] } } });
  await c.user.update({ where: { id: "w3" }, data: { posts: { connect: { id: "wp1" } } } });
  await c.post.aggregate({ _sum: { views: true }, _max: { views: true } });
  await c.post.groupBy({ by: ["authorId"], _count: true });
  await c.$transaction(async (tx) => { await tx.user.findMany({ take: 1 }); await tx.post.update({ where: { id: "wp4" }, data: { title: "m" } }); });
}
`
);

const esbuild = await import(
  pathToFileURL(
    require.resolve("esbuild", {
      paths: [`${root}/node_modules/.pnpm/esbuild@0.28.1/node_modules`],
    })
  )
);
const bundle = `${out}/app.mjs`;
const { metafile } = await esbuild.build({
  entryPoints: [`${out}/entry.mjs`],
  outfile: bundle,
  bundle: true,
  minify: true,
  sourcemap: true,
  metafile: true,
  format: "esm",
  platform: "node",
  external: ["better-sqlite3"],
  mainFields: ["module", "main"],
  tsconfig: `${root}/tsconfig.json`,
  logLevel: "error",
});

const Database = require("better-sqlite3");
const db = new Database(":memory:");
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, role TEXT NOT NULL, profile TEXT, createdAt TEXT NOT NULL);
CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT, published INTEGER NOT NULL, views INTEGER NOT NULL, createdAt TEXT NOT NULL, authorId TEXT NOT NULL);
INSERT INTO users VALUES ('u1','u1@x.dev','U','MEMBER',NULL,'2026-01-01T00:00:00.000Z');
INSERT INTO posts VALUES ('p1','P',NULL,1,3,'2026-01-01T00:00:00.000Z','u1');`);

const session = new Session();
session.connect();
await session.post("Profiler.enable");
await session.post("Profiler.startPreciseCoverage", {
  callCount: true,
  detailed: false,
});
const url = pathToFileURL(bundle).href;
// takePreciseCoverage resets the counters: each take is one phase's delta.
const take = async () =>
  (await session.post("Profiler.takePreciseCoverage")).result.find(
    (x) => x.url.endsWith(`/.probe-shrink-${basename(root)}/app.mjs`)
  ) ?? { functions: [] };
const phases = [];
const app = await import(url);
phases.push(["load", await take()]);
const c = app.client(db);
for (const phase of ["read", "write", "other"]) {
  try {
    await app[phase](c);
  } catch (error) {
    console.error(`phase ${phase} failed:`, error.message);
  }
  phases.push([phase, await take()]);
}

const text = readFileSync(bundle, "utf8");
const map = new SourceMap(JSON.parse(readFileSync(`${bundle}.map`, "utf8")));
const lineStarts = [0];
for (let i = 0; i < text.length; i++)
  if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
const sourceAt = (offset) => {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  const e = map.findEntry(lo, offset - lineStarts[lo]);
  return {
    file: (e.originalSource ?? "?").replace(/^.*?\/(src|node_modules)\//, "$1/"),
    line: (e.originalLine ?? 0) + 1,
  };
};

// V8 lists a function only once it is compiled, so later takes add functions
// the load take folded into their parent: build the function list from every
// take, and give each function the first phase that counted a call to it.
const byRange = new Map();
for (const [phase, cov] of phases)
  for (const f of cov.functions) {
    const { startOffset, endOffset, count } = f.ranges[0];
    const key = `${startOffset}:${endOffset}`;
    const known = byRange.get(key) ?? { name: f.functionName, startOffset, endOffset, phase: "never" };
    if (count > 0 && known.phase === "never") known.phase = phase;
    byRange.set(key, known);
  }
const fns = [...byRange.values()]
  .filter((f) => f.startOffset > 0 || f.endOffset < text.length)
  .sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
const stack = [];
for (const f of fns) {
  f.own = f.endOffset - f.startOffset;
  while (stack.length && stack.at(-1).endOffset <= f.startOffset) stack.pop();
  if (stack.length) stack.at(-1).own -= f.endOffset - f.startOffset;
  stack.push(f);
}
for (const f of fns) Object.assign(f, sourceAt(f.startOffset));

const PHASES = ["load", "read", "write", "other", "never"];
const area = (file) => {
  if (!file.startsWith("src/")) return file.startsWith("node_modules/") ? "dependencies" : "app";
  const parts = file.split("/");
  if (parts[1] === "query-engine" && parts[2] === "raptor3")
    return `query-engine/raptor3/${parts[3]?.replace(/\.ts$/, "")}`;
  if (["validation", "schema", "drivers", "adapters"].includes(parts[1]) && parts.length > 3)
    return `${parts[1]}/${parts[2]}`;
  return parts[1].replace(/\.ts$/, "");
};
const byFile = new Map();
for (const f of fns) {
  const row = byFile.get(f.file) ?? Object.fromEntries(PHASES.map((p) => [p, 0]));
  row[f.phase] += f.own;
  byFile.set(f.file, row);
}
// Metafile bytes per input = the file's full output (module scope included).
const outputs = Object.entries(metafile.outputs).find(([k]) => k.endsWith(".mjs"))[1].inputs;
const fileRows = [];
for (const [input, { bytesInOutput }] of Object.entries(outputs)) {
  const file = input.replace(/^.*?\/?(src|node_modules)\//, "$1/");
  const row = byFile.get(file) ?? Object.fromEntries(PHASES.map((p) => [p, 0]));
  const fnBytes = PHASES.reduce((t, p) => t + row[p], 0);
  // Module-scope statements (outside any function) execute at load.
  const moduleScope = Math.max(0, bytesInOutput - fnBytes);
  fileRows.push({ file, area: area(file), total: bytesInOutput, ...row, load: row.load + moduleScope });
}
const areaRows = new Map();
for (const r of fileRows) {
  const a = areaRows.get(r.area) ?? { area: r.area, files: 0, total: 0, ...Object.fromEntries(PHASES.map((p) => [p, 0])) };
  a.files++;
  a.total += r.total;
  for (const p of PHASES) a[p] += r[p];
  areaRows.set(r.area, a);
}
const kib = (b) => (b / 1024).toFixed(1).padStart(6);
const sum = (rows, k) => rows.reduce((t, r) => t + r[k], 0);
const all = [...areaRows.values()];
console.log(
  `bundle ${kib(text.length)} KiB | load ${kib(sum(all, "load"))} read ${kib(sum(all, "read"))} write ${kib(sum(all, "write"))} other ${kib(sum(all, "other"))} never ${kib(sum(all, "never"))}`
);
console.log("\nKiB by area (sorted by total)");
console.log("area                                   files  total   load   read  write  other  never");
for (const a of all.sort((x, y) => y.total - x.total))
  console.log(
    `${a.area.padEnd(38)} ${String(a.files).padStart(5)} ${kib(a.total)} ${PHASES.map((p) => kib(a[p])).join(" ")}`
  );
console.log(`\nTop ${o.top} files by never-run KiB`);
for (const r of [...fileRows].sort((x, y) => y.never - x.never).slice(0, Number(o.top)))
  console.log(`${kib(r.never)} never of ${kib(r.total)}  ${r.file}`);
const fnRows = fns
  .filter((f) => f.phase === "never")
  .sort((a, b) => b.own - a.own)
  .slice(0, Number(o.top));
console.log(`\nTop ${o.top} never-run functions (own bytes)`);
for (const f of fnRows) console.log(`${String(f.own).padStart(6)}  ${f.name || "(anon)"}  ${f.file}:${f.line}`);
if (o.json)
  writeFileSync(
    o.json,
    JSON.stringify(
      {
        bundleBytes: text.length,
        areas: all,
        files: fileRows,
        functions: fns.map(({ name, own, phase, file, line }) => ({ name, own, phase, file, line })),
      },
      null,
      1
    )
  );
