/**
 * Deterministic cold-start proxy: how much function source V8 must compile to
 * construct a client and run its first query. Functions already run during
 * import are excluded. Reports function count and source bytes per file.
 *   node benchmarks/probe-coverage.mjs --lib viborm --dir dist --workload rows20
 */
import { Session } from "node:inspector/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  loadDrizzle,
  loadViborm,
  openSeededDatabase,
  origin,
} from "./probe.mjs";

const { values: o } = parseArgs({
  strict: false,
  options: {
    lib: { type: "string", default: "viborm" },
    dir: { type: "string", default: "dist" },
    workload: { type: "string", default: "rows20" },
    files: { type: "boolean", default: false },
    top: { type: "string", default: "40" },
    phase: { type: "string", default: "all" },
  },
});
const session = new Session();
session.connect();
await session.post("Profiler.enable");
await session.post("Profiler.startPreciseCoverage", {
  callCount: true,
  detailed: false,
});
const make = await (o.lib === "drizzle" ? loadDrizzle : loadViborm)(
  resolve(o.dir)
);
const db = await openSeededDatabase();
const executed = async () => {
  const { result } = await session.post("Profiler.takePreciseCoverage");
  const seen = new Map();
  for (const script of result) {
    if (!script.url.startsWith("file:") || script.url.includes("/benchmarks/"))
      continue;
    const fns = script.functions
      .map((fn) => ({ name: fn.functionName, ...fn.ranges[0] }))
      .filter((f) => f.startOffset > 0)
      .sort((a, b) => a.startOffset - b.startOffset);
    // Own bytes: a function's range minus its directly nested functions,
    // which V8 skips (preparsed) when it compiles the outer one.
    const stack = [];
    for (const f of fns) {
      f.own = f.endOffset - f.startOffset;
      while (stack.length && stack.at(-1).endOffset <= f.startOffset)
        stack.pop();
      if (stack.length) stack.at(-1).own -= f.endOffset - f.startOffset;
      stack.push(f);
    }
    for (const f of fns)
      if (f.count > 0)
        seen.set(`${script.url}@${f.startOffset}`, {
          url: script.url,
          bytes: f.own,
          name: f.name,
          at: f.startOffset,
        });
  }
  return seen;
};
// takePreciseCoverage resets counts, so the second call sees only new calls.
await executed();
// --phase construct|query isolates one half of the first use.
const client = make(db);
if (o.phase === "query") await executed();
if (o.phase !== "construct") await client[o.workload]();
const after = await executed();
const byFile = new Map();
let bytes = 0;
const top = [...after.values()].sort((a, b) => b.bytes - a.bytes);
for (const { url, bytes: b } of after.values()) {
  bytes += b;
  const f = fileURLToPath(url).split("/").pop();
  const e = byFile.get(f) ?? { fns: 0, bytes: 0 };
  e.fns++;
  e.bytes += b;
  byFile.set(f, e);
}
console.log(
  `${o.lib} ${o.workload}: ${after.size} functions, ${(bytes / 1024).toFixed(1)} KiB source executed`
);
if (o.files)
  for (const [f, e] of [...byFile].sort((a, b) => b[1].bytes - a[1].bytes))
    console.log(
      `  ${(e.bytes / 1024).toFixed(1).padStart(7)} KiB ${String(e.fns).padStart(5)} fns  ${f}`
    );
if (o.files)
  for (const f of top.slice(0, Number(o.top ?? 40)))
    console.log(
      `  ${String(f.bytes).padStart(6)} B  ${(f.name || "(anon)").padEnd(28)} ${origin(f.url, f.at)}`
    );
