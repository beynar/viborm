/** Dump what one cell PUBLISHES at the package seam: statements, params, and the
 *  decoded value of the first operation. Used to compare arms byte for byte. */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const [root, workload, stage] = process.argv.slice(2);
const { createWorkloadHarness } = await import(
  pathToFileURL(resolve(root, "benchmarks/operation-pipeline-workloads.mjs")).href
);
const { harness } = await createWorkloadHarness(workload, stage, 8, "sqlite3", root, "unextended");
const runOne = harness[stage];
const checks = [];
for (let i = 0; i < 4; i++) checks.push(await runOne(i));
process.stdout.write(`${JSON.stringify({
  workload, stage, engine: process.env.VIBORM_BENCH_ENGINE ?? "shipped",
  checks, preparation: harness.preparation ?? null,
}, null, 1)}\n`);
