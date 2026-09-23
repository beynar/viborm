/** Attribute sampled allocation to source functions. */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
const [profilePath, traceDir, iterRaw, topRaw] = process.argv.slice(2);
const iterations = Number(iterRaw ?? 20000);
const top = Number(topRaw ?? 25);
const { TraceMap, originalPositionFor } = await import(pathToFileURL(resolve(traceDir, "dist/trace-mapping.mjs")).href);
const profile = JSON.parse(readFileSync(profilePath, "utf8"));
const maps = new Map();
function mapFor(url) {
  if (maps.has(url)) return maps.get(url);
  let tm = null;
  try { const file = url.startsWith("file://") ? fileURLToPath(url) : url;
    if (existsSync(`${file}.map`)) tm = { map: new TraceMap(JSON.parse(readFileSync(`${file}.map`, "utf8"))), dir: dirname(file) }; } catch {}
  maps.set(url, tm); return tm;
}
function label(cf) {
  const url = cf.url ?? "";
  const short = (f) => f.replace(/^.*\/(src|dist|benchmarks|node_modules)\//, "$1/");
  if (!url.endsWith(".mjs") && !url.endsWith(".js")) return `${cf.functionName || "(anon)"} @ ${url || "(vm)"}`;
  const tm = mapFor(url);
  const pos = tm && originalPositionFor(tm.map, { line: (cf.lineNumber ?? 0) + 1, column: cf.columnNumber ?? 0 });
  return pos && pos.source != null
    ? `${cf.functionName || pos.name || "(anon)"} @ ${short(resolve(tm.dir, pos.source))}:${pos.line}`
    : `${cf.functionName || "(anon)"} @ ${short(url)}`;
}
const self = new Map();
let total = 0;
(function walk(n) {
  const b = n.selfSize ?? 0;
  if (b) { const k = label(n.callFrame); self.set(k, (self.get(k) ?? 0) + b); total += b; }
  for (const c of n.children ?? []) walk(c);
})(profile.head);
console.log(`# ${profilePath}\n# total ${(total / 1024 / 1024).toFixed(1)} MB over ${iterations} ops = ${(total / iterations).toFixed(0)} B/op`);
for (const [k, b] of [...self].sort((a, b) => b[1] - a[1]).slice(0, top))
  console.log(`${(b / iterations).toFixed(0).padStart(7)} B/op ${((b / total) * 100).toFixed(2).padStart(6)}%  ${k}`);
