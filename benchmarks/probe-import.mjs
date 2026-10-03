/**
 * What runs while VibORM's modules evaluate (before any user code): functions
 * executed at import, by own source bytes, source-mapped.
 *   node benchmarks/probe-import.mjs --dir dist [--top 40]
 */
import { Session } from "node:inspector/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { origin } from "./probe.mjs";

const { values: o } = parseArgs({
  strict: false,
  options: { dir: { type: "string", default: "dist" }, top: { type: "string", default: "40" } },
});
const dir = resolve(o.dir);
const session = new Session();
session.connect();
await session.post("Profiler.enable");
await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
const t0 = performance.now();
for (const entry of ["schema.mjs", "index.mjs", "sqlite3.mjs"])
  await import(pathToFileURL(`${dir}/${entry}`));
const ms = performance.now() - t0;
const { result } = await session.post("Profiler.takePreciseCoverage");
const rows = [];
const byFile = new Map();
for (const script of result) {
  if (!script.url.startsWith(pathToFileURL(dir).href)) continue;
  const fns = script.functions
    .map((fn) => ({ name: fn.functionName, ...fn.ranges[0] }))
    .sort((a, b) => a.startOffset - b.startOffset);
  const stack = [];
  for (const f of fns) {
    f.own = f.endOffset - f.startOffset;
    while (stack.length && stack.at(-1).endOffset <= f.startOffset) stack.pop();
    if (stack.length) stack.at(-1).own -= f.endOffset - f.startOffset;
    stack.push(f);
  }
  for (const f of fns) {
    if (!(f.count > 0) || f.startOffset === 0) continue;
    const at = origin(script.url, f.startOffset) || fileURLToPath(script.url).split("/").pop();
    rows.push([f.own, f.count, `${f.name || "(anon)"}  ${at}`]);
    const file = at.replace(/:\d+$/, "");
    byFile.set(file, (byFile.get(file) ?? 0) + f.own);
  }
}
console.log(`import ${ms.toFixed(1)} ms; ${rows.length} functions ran, ${(rows.reduce((t, r) => t + r[0], 0) / 1024).toFixed(1)} KiB own source`);
console.log("-- by file");
for (const [k, b] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${String(b).padStart(7)} B  ${k}`);
console.log("-- by function (bytes, calls)");
for (const [b, n, k] of rows.sort((a, b) => b[0] - a[0]).slice(0, Number(o.top))) console.log(`${String(b).padStart(7)} B ${String(n).padStart(5)}x  ${k}`);
