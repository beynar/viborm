/**
 * Bytes a minimal app (schema + createClient + SQLite3Driver) bundles from
 * src/, per source file. Parse cost on a cold isolate scales with this.
 *   node benchmarks/probe-bundle.mjs [--top 60] [--why src/path.ts]
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({
  strict: false,
  options: { top: { type: "string", default: "60" }, why: { type: "string" } },
});
const root = resolve(import.meta.dirname, "..");
const esbuild = await import(`${root}/node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/lib/main.js`);
const entry = `import { s } from "${root}/src/schema/index.ts";
import { createClient } from "${root}/src/index.ts";
import { SQLite3Driver } from "${root}/src/drivers/sqlite3/index.ts";
const user = s.model({ id: s.string().id(), name: s.string().nullable(), posts: s.toMany(() => post) });
const post = s.model({ id: s.string().id(), authorId: s.string(), author: s.toOne(() => user).fields("authorId").references("id") });
export const c = createClient({ schema: { user, post }, driver: new SQLite3Driver() });`;
const r = await esbuild.build({
  stdin: { contents: entry, resolveDir: root, loader: "js" },
  bundle: true, minify: true, format: "esm", platform: "neutral",
  external: ["better-sqlite3", "node:*"], mainFields: ["module", "main"],
  write: false, metafile: true, outfile: "out.mjs",
  tsconfig: `${root}/tsconfig.json`, logLevel: "error",
});
const out = Object.values(r.metafile.outputs)[0];
const short = (k) => k.replace(/^.*?src\//, "src/");
const rows = Object.entries(out.inputs).map(([k, v]) => [v.bytesInOutput, short(k)]).sort((a, b) => b[0] - a[0]);
console.log(`bundle ${(out.bytes / 1024).toFixed(1)} KiB from ${rows.length} files`);
if (o.why) {
  // Import chain from the entry to --why, through the metafile's import graph.
  const graph = r.metafile.inputs;
  const target = Object.keys(graph).find((k) => short(k) === o.why);
  const prev = new Map([["<stdin>", null]]);
  const queue = ["<stdin>"];
  while (queue.length) {
    const at = queue.shift();
    for (const { path } of graph[at]?.imports ?? [])
      if (!prev.has(path)) { prev.set(path, at); queue.push(path); }
  }
  const chain = [];
  for (let at = target; at; at = prev.get(at)) chain.unshift(short(at));
  console.log(chain.join("\n  <- imported by ... ->\n").replaceAll("\n  <- imported by ... ->\n", "\n  → "));
} else for (const [b, k] of rows.slice(0, Number(o.top))) console.log(`${(b / 1024).toFixed(1).padStart(6)} KiB  ${k}`);
