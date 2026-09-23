/**
 * P1 adaptation of perf2's analyze-prof.mjs: same aggregation (SELF time by
 * file and by function, bundled dist positions mapped back to TypeScript),
 * but resolving positions with Node's built-in SourceMap instead of the
 * @jridgewell/trace-mapping copy perf2 had in its tree.
 * Usage: node analyze-prof2.mjs <profile.cpuprofile> [topN]
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { SourceMap } from "node:module";

const [profilePath, topRaw] = process.argv.slice(2);
const top = Number(topRaw ?? 40);
const profile = JSON.parse(readFileSync(profilePath, "utf8"));
const byId = new Map();
for (const node of profile.nodes) byId.set(node.id, node);

const self = new Map();
let total = 0;
for (let i = 0; i < profile.samples.length; i++) {
  const id = profile.samples[i];
  const dt = profile.timeDeltas[i] ?? 0;
  self.set(id, (self.get(id) ?? 0) + dt);
  total += dt;
}

const maps = new Map();
function mapFor(url) {
  if (maps.has(url)) return maps.get(url);
  let tm = null;
  try {
    const file = url.startsWith("file://") ? fileURLToPath(url) : url;
    if (existsSync(`${file}.map`))
      tm = { map: new SourceMap(JSON.parse(readFileSync(`${file}.map`, "utf8"))), dir: dirname(file) };
  } catch { tm = null; }
  maps.set(url, tm);
  return tm;
}

function origin(cf) {
  const url = cf.url ?? "";
  if (!url.endsWith(".mjs") && !url.endsWith(".js")) return { file: url || "(vm)", line: 0 };
  const tm = mapFor(url);
  if (!tm) return { file: url, line: (cf.lineNumber ?? 0) + 1 };
  const e = tm.map.findEntry(cf.lineNumber ?? 0, cf.columnNumber ?? 0);
  if (!e || e.originalSource == null) return { file: url, line: (cf.lineNumber ?? 0) + 1 };
  const src = e.originalSource.startsWith("file://") ? fileURLToPath(e.originalSource) : resolve(tm.dir, e.originalSource);
  return { file: src, line: (e.originalLine ?? 0) + 1, name: e.name };
}

const short = (f) => f.replace(/^.*\/(src|dist|benchmarks|node_modules)\//, "$1/");
const rows = [];
for (const [id, micros] of self) {
  const node = byId.get(id);
  if (!node) continue;
  const o = origin(node.callFrame);
  rows.push({ micros, fn: node.callFrame.functionName || o.name || "(anonymous)", file: short(o.file), line: o.line });
}
const files = new Map();
for (const r of rows) files.set(r.file, (files.get(r.file) ?? 0) + r.micros);
const fns = new Map();
for (const r of rows) {
  const key = `${r.fn}\t${r.file}:${r.line}`;
  fns.set(key, (fns.get(key) ?? 0) + r.micros);
}
console.log(`# profile ${profilePath}`);
console.log(`# total sampled: ${(total / 1000).toFixed(1)} ms`);
console.log("\n## SELF time by source file");
for (const [f, m] of [...files].sort((a, b) => b[1] - a[1]).slice(0, top))
  console.log(`${(m / 1000).toFixed(2).padStart(9)} ms  ${((m / total) * 100).toFixed(2).padStart(6)}%  ${f}`);
console.log("\n## SELF time by function");
for (const [k, m] of [...fns].sort((a, b) => b[1] - a[1]).slice(0, top)) {
  const [fn, loc] = k.split("\t");
  console.log(`${(m / 1000).toFixed(2).padStart(9)} ms  ${((m / total) * 100).toFixed(2).padStart(6)}%  ${fn}  @ ${loc}`);
}
