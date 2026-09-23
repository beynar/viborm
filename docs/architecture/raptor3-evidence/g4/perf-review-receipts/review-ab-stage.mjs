/**
 * Independent A/B instrument for the G4 perf-pass review.
 *
 * Drives the checkout's own benchmark harness, exactly the function
 * benchmarks/operation-pipeline-worker.mjs measures, and reports process CPU
 * and wall per operation over the measured loop only. Also reports the summed
 * prepared-SQL length witness, so alias drift is visible as a moving checksum.
 *
 * usage: node --expose-gc review-ab-stage.mjs <root> <workload> <stage> <iters> <warmup>
 */
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const [root, workload, stage, itersRaw, warmupRaw] = process.argv.slice(2);
const iterations = Number(itersRaw);
const warmup = Number(warmupRaw);

const { createWorkloadHarness } = await import(
  pathToFileURL(resolve(root, "benchmarks/operation-pipeline-workloads.mjs")).href
);
const { harness } = await createWorkloadHarness(
  workload,
  stage,
  iterations + warmup,
  "sqlite3",
  root,
  "unextended"
);
const runOne = harness[stage];
if (!runOne) throw new Error(`no ${stage} stage for ${workload}`);

let checksum = 0;
for (let index = 0; index < warmup; index++) checksum += await runOne(index);
globalThis.gc?.();

const nativeCapture = Error.captureStackTrace;
let captures = 0;
Error.captureStackTrace = function counted(...args) {
  captures++;
  return nativeCapture.apply(this, args);
};
const cpuBefore = process.cpuUsage();
const wallBefore = performance.now();
for (let index = 0; index < iterations; index++) checksum += await runOne(index);
const wall = performance.now() - wallBefore;
const cpu = process.cpuUsage(cpuBefore);
Error.captureStackTrace = nativeCapture;

process.stdout.write(
  `${JSON.stringify({
    engine: process.env.VIBORM_BENCH_ENGINE ?? "shipped",
    workload,
    stage,
    iterations,
    cpuUsPerOp: (cpu.user + cpu.system) / iterations,
    wallUsPerOp: (wall * 1000) / iterations,
    capturesPerOp: captures / iterations,
    checksum,
  })}\n`
);
