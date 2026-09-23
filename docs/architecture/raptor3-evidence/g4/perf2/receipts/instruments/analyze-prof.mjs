/**
 * Aggregate a .cpuprofile by SELF time, mapping bundled dist positions back to
 * original TypeScript sources through the emitted sourcemaps.
 * Usage: node analyze-prof.mjs <profile.cpuprofile> <trace-mapping-dir> [topN]
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const [profilePath, traceDir, topRaw] = process.argv.slice(2);
const top = Number(topRaw ?? 40);
const { TraceMap, originalPositionFor } = await import(
  pathToFileURL(resolve(traceDir, "dist/trace-mapping.mjs")).href
);
if (typeof TraceMap !== "function") throw new Error("TraceMap did not load");

const profile = JSON.parse(readFileSync(profilePath, "utf8"));
const byId = new Map();
for (const node of profile.nodes) byId.set(node.id, node);

// self time per node id
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
    const mapFile = `${file}.map`;
    if (existsSync(mapFile)) {
      const raw = JSON.parse(readFileSync(mapFile, "utf8"));
      tm = { map: new TraceMap(raw), dir: dirname(file) };
    }
  } catch {
    tm = null;
  }
  maps.set(url, tm);
  return tm;
}

function origin(cf) {
  const url = cf.url ?? "";
  if (!url.endsWith(".mjs") && !url.endsWith(".js")) return { file: url || "(vm)", line: 0 };
  const tm = mapFor(url);
  if (!tm) return { file: url, line: (cf.lineNumber ?? 0) + 1 };
  const pos = originalPositionFor(tm.map, {
    line: (cf.lineNumber ?? 0) + 1,
    column: cf.columnNumber ?? 0,
  });
  if (!pos || pos.source == null) return { file: url, line: (cf.lineNumber ?? 0) + 1 };
  return { file: resolve(tm.dir, pos.source), line: pos.line ?? 0, name: pos.name };
}

const rows = [];
for (const [id, micros] of self) {
  const node = byId.get(id);
  if (!node) continue;
  const cf = node.callFrame;
  const o = origin(cf);
  rows.push({
    micros,
    fn: cf.functionName || "(anonymous)",
    file: o.file,
    line: o.line,
    origName: o.name,
    url: cf.url,
  });
}
rows.sort((a, b) => b.micros - a.micros);

// aggregate by file
const files = new Map();
for (const r of rows) {
  const key = r.file.replace(/^.*\/(src|dist|benchmarks|node_modules)\//, "$1/");
  files.set(key, (files.get(key) ?? 0) + r.micros);
}
const fileRows = [...files].sort((a, b) => b[1] - a[1]);

// aggregate by function identity (file:line:fn)
const fns = new Map();
for (const r of rows) {
  const key = `${r.fn}\t${r.file.replace(/^.*\/(src|dist|benchmarks|node_modules)\//, "$1/")}:${r.line}`;
  fns.set(key, (fns.get(key) ?? 0) + r.micros);
}
const fnRows = [...fns].sort((a, b) => b[1] - a[1]);

console.log(`# profile ${profilePath}`);
console.log(`# total sampled: ${(total / 1000).toFixed(1)} ms`);
console.log("\n## SELF time by source file");
for (const [f, m] of fileRows.slice(0, top)) {
  console.log(`${(m / 1000).toFixed(2).padStart(9)} ms  ${((m / total) * 100).toFixed(2).padStart(6)}%  ${f}`);
}
console.log("\n## SELF time by function");
for (const [k, m] of fnRows.slice(0, top)) {
  const [fn, loc] = k.split("\t");
  console.log(`${(m / 1000).toFixed(2).padStart(9)} ms  ${((m / total) * 100).toFixed(2).padStart(6)}%  ${fn}  @ ${loc}`);
}
