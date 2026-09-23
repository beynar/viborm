/** Count GC events and total GC duration during one benchmark stage loop. */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { performance, PerformanceObserver, constants } from "node:perf_hooks";

const [worktree, workloadName, stage, iterRaw, warmRaw] = process.argv.slice(2);
const iterations = Number(iterRaw ?? 20000);
const warmup = Number(warmRaw ?? 2000);
const { createWorkloadHarness } = await import(
  pathToFileURL(resolve(worktree, "benchmarks/operation-pipeline-workloads.mjs")).href
);
const { fixture, semanticFixture, harness } = await createWorkloadHarness(
  workloadName, stage, iterations + warmup, "sqlite3", worktree, "unextended"
);
const runOne = harness[stage];
let checksum = 0;
for (let i = 0; i < warmup; i++) checksum += await runOne(i);

const kinds = { minor: 0, major: 0, incremental: 0, weakcb: 0, other: 0 };
const dur = { minor: 0, major: 0, incremental: 0, weakcb: 0, other: 0 };
let collecting = false;
const obs = new PerformanceObserver((list) => {
  if (!collecting) return;
  for (const e of list.getEntries()) {
    const k = e.detail?.kind;
    const name = k === constants.NODE_PERFORMANCE_GC_MINOR ? "minor"
      : k === constants.NODE_PERFORMANCE_GC_MAJOR ? "major"
      : k === constants.NODE_PERFORMANCE_GC_INCREMENTAL ? "incremental"
      : k === constants.NODE_PERFORMANCE_GC_WEAKCB ? "weakcb" : "other";
    kinds[name]++; dur[name] += e.duration;
  }
});
obs.observe({ entryTypes: ["gc"] });
collecting = true;
const cpuBefore = process.cpuUsage();
const w0 = performance.now();
for (let i = 0; i < iterations; i++) checksum += await runOne(i);
const wall = performance.now() - w0;
const cpu = process.cpuUsage(cpuBefore);
collecting = false;
obs.disconnect();
await fixture.driver.disconnect();
await semanticFixture.driver.disconnect();
const totalGc = Object.values(dur).reduce((a, b) => a + b, 0);
process.stdout.write(`${JSON.stringify({
  worktree: worktree.split("/").pop(), workload: workloadName, stage, iterations,
  cpuUsPerOp: +( (cpu.user + cpu.system) / iterations ).toFixed(3),
  wallUsPerOp: +((wall * 1000) / iterations).toFixed(3),
  gcEvents: kinds,
  gcMsTotal: +totalGc.toFixed(1),
  gcUsPerOp: +((totalGc * 1000) / iterations).toFixed(3),
  gcPerOpByKind: Object.fromEntries(Object.entries(dur).map(([k, v]) => [k, +((v * 1000) / iterations).toFixed(3)])),
})}\n`);
