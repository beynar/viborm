/**
 * Which bundled source files a cold isolate parses but never runs. Bundles a
 * minimal app from src/ (with a sourcemap), runs import + client + the common
 * first queries under V8 coverage, and reports per source file: bytes in the
 * bundle and bytes of functions that executed. A file with bundle bytes and no
 * executed bytes is parse cost only.
 *   node benchmarks/probe-dead.mjs [--top 60]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { SourceMap } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { openSeededDatabase } from "./probe.mjs";

const { values: o } = parseArgs({
  strict: false,
  options: { top: { type: "string", default: "60" }, out: { type: "string", default: "/tmp/viborm-probe-dead" } },
});
const root = resolve(import.meta.dirname, "..");
const esbuild = await import(`${root}/node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/lib/main.js`);
mkdirSync(o.out, { recursive: true });
const outfile = `${o.out}/app.mjs`;
const entry = `import { s } from "${root}/src/schema/index.ts";
import { createClient } from "${root}/src/index.ts";
import { SQLite3Driver } from "${root}/src/drivers/sqlite3/index.ts";
export function run(db) {
  const user = s.model({ id: s.string().id(), name: s.string().nullable(), email: s.string(), age: s.int().nullable(), posts: s.toMany(() => post) }).map("users");
  const post = s.model({ id: s.string().id(), title: s.string(), content: s.string().nullable(), published: s.boolean(), views: s.int(), authorId: s.string(), author: s.toOne(() => user).fields("authorId").references("id") }).map("posts");
  const c = createClient({ schema: { user, post }, driver: new SQLite3Driver({ client: db }) });
  return Promise.all([
    c.user.findUnique({ where: { id: "u42" } }),
    c.post.findMany({ orderBy: { id: "asc" }, take: 20 }),
    c.post.findMany({ where: { published: true }, select: { id: true, title: true, views: true }, orderBy: { views: "desc" }, take: 20 }),
    c.post.findMany({ select: { id: true, title: true, author: { select: { id: true, name: true } } }, orderBy: { id: "asc" }, take: 20 }),
    c.user.create({ data: { id: "dead1", name: "B", email: "b@x.com", age: 30 } }),
    c.post.update({ where: { id: "p1" }, data: { views: 5 } }),
    c.post.count({ where: { published: true } }),
  ]);
}`;
const result = await esbuild.build({
  stdin: { contents: entry, resolveDir: root, loader: "js" },
  bundle: true, minify: true, format: "esm", platform: "neutral",
  external: ["better-sqlite3", "node:*"], mainFields: ["module", "main"],
  outfile, sourcemap: "external", metafile: true, write: true,
  tsconfig: `${root}/tsconfig.json`, logLevel: "error",
});
const short = (k) => k.replace(/^.*?src\//, "src/");
const inBundle = new Map();
for (const [k, v] of Object.entries(Object.entries(result.metafile.outputs).find(([k]) => k.endsWith(".mjs"))[1].inputs))
  inBundle.set(short(k), v.bytesInOutput);

const session = new Session();
session.connect();
await session.post("Profiler.enable");
await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
const db = await openSeededDatabase();
const app = await import(pathToFileURL(outfile));
await app.run(db);
const { result: coverage } = await session.post("Profiler.takePreciseCoverage");
const script = coverage.find((s) => s.url === pathToFileURL(outfile).href);
const map = new SourceMap(JSON.parse((await import("node:fs")).readFileSync(`${outfile}.map`, "utf8")));
const text = (await import("node:fs")).readFileSync(outfile, "utf8");
const lineStarts = [0];
for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
const at = (offset) => {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; }
  const e = map.findEntry(lo, offset - lineStarts[lo]);
  return e.originalSource ? short(e.originalSource) : "?";
};
const ran = new Map();
const fns = script.functions.map((f) => ({ ...f.ranges[0] })).filter((r) => r.startOffset > 0).sort((a, b) => a.startOffset - b.startOffset);
const stack = [];
for (const f of fns) {
  f.own = f.endOffset - f.startOffset;
  while (stack.length && stack.at(-1).endOffset <= f.startOffset) stack.pop();
  if (stack.length) stack.at(-1).own -= f.endOffset - f.startOffset;
  stack.push(f);
}
for (const f of fns) if (f.count > 0) { const k = at(f.startOffset); ran.set(k, (ran.get(k) ?? 0) + f.own); }
const rows = [...inBundle].map(([k, b]) => [k, b, ran.get(k) ?? 0]).sort((a, b) => b[1] - b[2] - (a[1] - a[2]));
const total = [...inBundle.values()].reduce((t, b) => t + b, 0);
const executed = [...ran.values()].reduce((t, b) => t + b, 0);
const dead = rows.filter((r) => r[2] === 0).reduce((t, r) => t + r[1], 0);
console.log(`bundle ${(total / 1024).toFixed(0)} KiB; functions executed ${(executed / 1024).toFixed(0)} KiB; files never executed ${(dead / 1024).toFixed(0)} KiB`);
console.log("bundle KiB  executed KiB  file   (sorted by never-run bytes)");
for (const [k, b, r] of rows.slice(0, Number(o.top)))
  console.log(`${(b / 1024).toFixed(1).padStart(7)}  ${(r / 1024).toFixed(1).padStart(7)}   ${k}`);
writeFileSync(`${o.out}/rows.json`, JSON.stringify(rows));
