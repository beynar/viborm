/**
 * Attribute every sample to the INNERMOST matching stage on its caller chain,
 * so the stages partition the profile (no double counting).
 * Usage: node analyze-stages.mjs <profile> <trace-dir> <side>
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const [profilePath, traceDir] = process.argv.slice(2);
const { TraceMap, originalPositionFor } = await import(
  pathToFileURL(resolve(traceDir, "dist/trace-mapping.mjs")).href
);
const profile = JSON.parse(readFileSync(profilePath, "utf8"));
const byId = new Map();
const parent = new Map();
for (const n of profile.nodes) { byId.set(n.id, n); for (const c of n.children ?? []) parent.set(c, n.id); }
const maps = new Map();
function mapFor(url) {
  if (maps.has(url)) return maps.get(url);
  let tm = null;
  try {
    const file = url.startsWith("file://") ? fileURLToPath(url) : url;
    if (existsSync(`${file}.map`)) tm = { map: new TraceMap(JSON.parse(readFileSync(`${file}.map`, "utf8"))), dir: dirname(file) };
  } catch { tm = null; }
  maps.set(url, tm); return tm;
}
const originCache = new Map();
function origin(id) {
  if (originCache.has(id)) return originCache.get(id);
  const cf = byId.get(id).callFrame;
  const url = cf.url ?? "";
  let out;
  if (!url.endsWith(".mjs") && !url.endsWith(".js")) out = { file: url || "(vm)", line: 0, fn: cf.functionName || "(anon)" };
  else {
    const tm = mapFor(url);
    const pos = tm && originalPositionFor(tm.map, { line: (cf.lineNumber ?? 0) + 1, column: cf.columnNumber ?? 0 });
    out = pos && pos.source != null
      ? { file: resolve(tm.dir, pos.source).replace(/^.*\/(src|dist|benchmarks|node_modules)\//, "$1/"), line: pos.line, fn: cf.functionName || pos.name || "(anon)" }
      : { file: url.replace(/^.*\//, "dist/"), line: (cf.lineNumber ?? 0) + 1, fn: cf.functionName || "(anon)" };
  }
  originCache.set(id, out); return out;
}

// Innermost-match stage rules, in priority order applied per frame.
const STAGES = [
  ["gc / vm",                    (o) => o.file === "(vm)"],
  ["profiler overhead",          (o) => o.file.startsWith("node:inspector") || o.file.includes("perf-diag/prof-stage")],
  ["benchmark harness",          (o) => o.file.startsWith("benchmarks/")],
  ["admission (EngineSchema.admit + validation)",
                                 (o) => o.file === "src/query-engine/raptor3/shared/schema.ts" || o.file.startsWith("src/validation/") || o.file.startsWith("src/client/unique-where-guard")],
  ["candidate: OperationContext (package build + ctor)",
                                 (o) => o.file === "src/query-engine/raptor3/shared/operation-context.ts"],
  ["candidate: Queries.read / projection / selector",
                                 (o) => o.file === "src/query-engine/raptor3/shared/query.ts" || o.file === "src/query-engine/raptor3/shared/storage.ts"],
  ["candidate: Commands (write plan)",
                                 (o) => o.file.startsWith("src/query-engine/raptor3/commands/")],
  ["candidate: route glue",      (o) => o.file.startsWith("src/query-engine/raptor3/route/") || o.file.startsWith("src/query-engine/raptor3/program/")],
  ["shipped: write-engine",      (o) => o.file.startsWith("src/query-engine/write-engine/")],
  ["shipped: builders",          (o) => o.file.startsWith("src/query-engine/builders/")],
  ["shipped: operations",        (o) => o.file.startsWith("src/query-engine/operations/")],
  ["shipped: result shape/parse",(o) => o.file.startsWith("src/query-engine/result/")],
  ["SQL fragments (src/sql)",    (o) => o.file.startsWith("src/sql/")],
  ["adapter lowering",           (o) => o.file.startsWith("src/adapters/")],
  ["driver / execution context", (o) => o.file.startsWith("src/drivers/") || o.file === "src/query-engine/execution-context.ts"],
  ["pending-operation / query-engine glue",
                                 (o) => o.file === "src/query-engine/pending-operation.ts" || o.file === "src/query-engine/query-engine.ts" || o.file === "src/query-engine/transaction-operation.ts" || o.file.startsWith("src/query-engine/cache")],
  ["client proxy",               (o) => o.file.startsWith("src/client/")],
  ["schema model access",        (o) => o.file.startsWith("src/schema/")],
  ["node builtins",              (o) => o.file.startsWith("node:")],
];
function stageOf(id) {
  let cur = id;
  let depth = 0;
  while (cur !== undefined && depth < 200) {
    const o = origin(cur);
    for (const [name, test] of STAGES) if (test(o)) return name;
    cur = parent.get(cur); depth++;
  }
  return "unattributed";
}
const stageCache = new Map();
const totals = new Map();
let total = 0;
for (let i = 0; i < profile.samples.length; i++) {
  const id = profile.samples[i];
  const dt = profile.timeDeltas[i] ?? 0;
  if (!stageCache.has(id)) stageCache.set(id, stageOf(id));
  const s = stageCache.get(id);
  totals.set(s, (totals.get(s) ?? 0) + dt);
  total += dt;
}
const iterations = Number(process.env.ITER ?? 20000);
console.log(`# ${profilePath}`);
console.log(`# total ${(total / 1000).toFixed(1)} ms over ${iterations} ops = ${(total / iterations).toFixed(3)} us/op (profiled wall, on-thread)`);
console.log(`${"stage".padEnd(52)} ${"us/op".padStart(8)} ${"ms".padStart(9)} ${"%".padStart(7)}`);
for (const [s, m] of [...totals].sort((a, b) => b[1] - a[1]))
  console.log(`${s.padEnd(52)} ${(m / iterations).toFixed(3).padStart(8)} ${(m / 1000).toFixed(2).padStart(9)} ${((m / total) * 100).toFixed(2).padStart(7)}`);
