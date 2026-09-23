/** Show the top self-time nodes with their caller chain, sourcemapped. */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const [profilePath, traceDir, topRaw] = process.argv.slice(2);
const top = Number(topRaw ?? 12);
const { TraceMap, originalPositionFor } = await import(
  pathToFileURL(resolve(traceDir, "dist/trace-mapping.mjs")).href
);

const profile = JSON.parse(readFileSync(profilePath, "utf8"));
const byId = new Map();
const parent = new Map();
for (const node of profile.nodes) {
  byId.set(node.id, node);
  for (const c of node.children ?? []) parent.set(c, node.id);
}
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
    if (existsSync(mapFile)) tm = { map: new TraceMap(JSON.parse(readFileSync(mapFile, "utf8"))), dir: dirname(file) };
  } catch { tm = null; }
  maps.set(url, tm);
  return tm;
}
function label(cf) {
  const url = cf.url ?? "";
  const short = (f) => f.replace(/^.*\/(src|dist|benchmarks|node_modules)\//, "$1/");
  if (!url.endsWith(".mjs") && !url.endsWith(".js")) return `${cf.functionName || "(anon)"} @ ${url || "(vm)"}:${(cf.lineNumber ?? -1) + 1}`;
  const tm = mapFor(url);
  if (!tm) return `${cf.functionName || "(anon)"} @ ${short(url)}:${(cf.lineNumber ?? 0) + 1}`;
  const pos = originalPositionFor(tm.map, { line: (cf.lineNumber ?? 0) + 1, column: cf.columnNumber ?? 0 });
  if (!pos || pos.source == null) return `${cf.functionName || "(anon)"} @ ${short(url)}:${(cf.lineNumber ?? 0) + 1}`;
  return `${cf.functionName || "(anon)"}${pos.name ? ` [${pos.name}]` : ""} @ ${short(resolve(tm.dir, pos.source))}:${pos.line}:${pos.column}`;
}
const rows = [...self].sort((a, b) => b[1] - a[1]).slice(0, top);
console.log(`# ${profilePath}\n# total ${(total / 1000).toFixed(1)} ms`);
for (const [id, micros] of rows) {
  const node = byId.get(id);
  console.log(`\n=== ${(micros / 1000).toFixed(2)} ms  ${((micros / total) * 100).toFixed(2)}%  ${label(node.callFrame)}`);
  let p = parent.get(id);
  let depth = 0;
  while (p !== undefined && depth < 9) {
    console.log(`      <- ${label(byId.get(p).callFrame)}`);
    p = parent.get(p);
    depth++;
  }
}
