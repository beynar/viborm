/**
 * Compiled-but-unexecuted code on the first use. V8 compiles a whole function
 * body on its first call; branches that never run in it are compiled for
 * nothing, while code in a separate uncalled function is only skimmed. This
 * ranks functions compiled during construct + first query by those wasted
 * bytes (nested function bodies excluded), source-mapped.
 *   node benchmarks/probe-waste.mjs --workload unique [--top 40]
 */
import { Session } from "node:inspector/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadViborm, openSeededDatabase, origin } from "./probe.mjs";

const { values: o } = parseArgs({
  strict: false,
  options: {
    dir: { type: "string", default: "dist" },
    workload: { type: "string", default: "unique" },
    top: { type: "string", default: "40" },
  },
});
const session = new Session();
session.connect();
await session.post("Profiler.enable");
await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
const make = await loadViborm(resolve(o.dir));
const db = await openSeededDatabase();
await session.post("Profiler.takePreciseCoverage");
await make(db)[o.workload]();
const { result } = await session.post("Profiler.takePreciseCoverage");

const rows = [];
let compiled = 0;
let wasted = 0;
for (const script of result) {
  if (!script.url.startsWith("file:") || script.url.includes("/benchmarks/")) continue;
  const fnRanges = script.functions.map((f) => f.ranges[0]).filter((r) => r.startOffset > 0);
  for (const fn of script.functions) {
    const [head, ...blocks] = fn.ranges;
    if (!(head.startOffset > 0 && head.count > 0)) continue;
    const nested = fnRanges.filter(
      (r) => r !== head && r.startOffset >= head.startOffset && r.endOffset <= head.endOffset &&
        !fnRanges.some((p) => p !== head && p !== r && p.startOffset <= r.startOffset && p.endOffset >= r.endOffset && p.startOffset >= head.startOffset && p.endOffset <= head.endOffset)
    );
    const inside = (r, s) => r.startOffset >= s.startOffset && r.endOffset <= s.endOffset;
    const own = head.endOffset - head.startOffset - nested.reduce((t, r) => t + r.endOffset - r.startOffset, 0);
    // Outermost unexecuted blocks, minus the nested functions they contain.
    const zero = blocks.filter((b) => b.count === 0);
    const outer = zero.filter((b) => !zero.some((p) => p !== b && inside(b, p)));
    let waste = 0;
    for (const b of outer) {
      waste += b.endOffset - b.startOffset;
      for (const r of nested) if (inside(r, b)) waste -= r.endOffset - r.startOffset;
    }
    compiled += own;
    wasted += waste;
    if (waste > 0)
      rows.push([waste, own, `${fn.functionName || "(anon)"}  ${origin(script.url, head.startOffset)}`]);
  }
}
console.log(`${o.workload}: compiled ${(compiled / 1024).toFixed(1)} KiB, of which unexecuted ${(wasted / 1024).toFixed(1)} KiB`);
for (const [w, own, k] of rows.sort((a, b) => b[0] - a[0]).slice(0, Number(o.top)))
  console.log(`${String(w).padStart(6)} / ${String(own).padEnd(5)} B  ${k}`);
