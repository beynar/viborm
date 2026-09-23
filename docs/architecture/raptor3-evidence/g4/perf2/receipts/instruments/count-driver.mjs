/** Count driver-seam crossings per operation, from OUTSIDE the engine. */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const [root, workload, stage, itersRaw] = process.argv.slice(2);
const iterations = Number(itersRaw ?? 50);
const { createWorkloadHarness } = await import(
  pathToFileURL(resolve(root, "benchmarks/operation-pipeline-workloads.mjs")).href
);
const { fixture, harness } = await createWorkloadHarness(
  workload, stage, iterations + 5, "sqlite3", root, "unextended"
);
const runOne = harness[stage];
for (let i = 0; i < 5; i++) await runOne(i);
const counts = {};
for (const name of ["_prepare", "_execute", "_executeBatch", "withTransaction"]) {
  const original = fixture.driver[name];
  if (typeof original !== "function") continue;
  counts[name] = 0;
  fixture.driver[name] = function (...args) {
    counts[name]++;
    return original.apply(this, args);
  };
}
for (let i = 0; i < iterations; i++) await runOne(i);
process.stdout.write(`${JSON.stringify({
  engine: process.env.VIBORM_BENCH_ENGINE ?? "shipped", workload, stage, iterations,
  perOperation: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / iterations])),
})}\n`);
