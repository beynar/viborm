/**
 * Read-only CPU profiling driver for one benchmark cell.
 * Profiles ONLY the measured loop (inspector Profiler start/stop around it),
 * so module loading and fixture setup are excluded.
 *
 * Usage: node --expose-gc prof-stage.mjs <worktree> <workload> <stage> <iters> <warmup> <outProfile>
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import inspector from "node:inspector";

const [worktree, workloadName, stage, iterRaw, warmRaw, outProfile] =
  process.argv.slice(2);
const iterations = Number(iterRaw ?? 5000);
const warmup = Number(warmRaw ?? 1000);

const workloadsUrl = pathToFileURL(
  resolve(worktree, "benchmarks/operation-pipeline-workloads.mjs")
).href;
const { createWorkloadHarness } = await import(workloadsUrl);

const { fixture, semanticFixture, harness } = await createWorkloadHarness(
  workloadName,
  stage,
  iterations + warmup,
  "sqlite3",
  worktree,
  "unextended"
);
const runOne = harness[stage];
if (!runOne) throw new Error(`no stage ${stage} on ${workloadName}`);

const post = (session, method, params = {}) =>
  new Promise((res, rej) =>
    session.post(method, params, (e, v) => (e ? rej(e) : res(v)))
  );

if (process.env.NO_STACK === "1") Error.stackTraceLimit = 0;
let checksum = 0;
for (let i = 0; i < warmup; i++) checksum += await runOne(i);

const allocMode = process.env.ALLOC === "1";
let session;
if (outProfile) {
  session = new inspector.Session();
  session.connect();
  if (allocMode) {
    await post(session, "HeapProfiler.enable");
    await post(session, "HeapProfiler.startSampling", {
      samplingInterval: 128,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  } else {
    await post(session, "Profiler.enable");
    await post(session, "Profiler.setSamplingInterval", { interval: 50 });
    await post(session, "Profiler.start");
  }
}
const cpuBefore = process.cpuUsage();
const wallBefore = performance.now();
for (let i = 0; i < iterations; i++) checksum += await runOne(i);
const wallMs = performance.now() - wallBefore;
const cpu = process.cpuUsage(cpuBefore);
let allocatedBytes;
if (session) {
  if (allocMode) {
    const { profile } = await post(session, "HeapProfiler.stopSampling");
    writeFileSync(outProfile, JSON.stringify(profile));
    const sum = (n) => (n.selfSize ?? 0) + (n.children ?? []).reduce((a, c) => a + sum(c), 0);
    allocatedBytes = sum(profile.head);
  } else {
    const { profile } = await post(session, "Profiler.stop");
    writeFileSync(outProfile, JSON.stringify(profile));
  }
  session.disconnect();
}
await fixture.driver.disconnect();
await semanticFixture.driver.disconnect();
process.stdout.write(
  `${JSON.stringify({
    worktree,
    workload: workloadName,
    stage,
    iterations,
    warmup,
    checksum,
    cpuMicrosecondsPerOperation: (cpu.user + cpu.system) / iterations,
    wallMicrosecondsPerOperation: (wallMs * 1000) / iterations,
    preparation: harness.preparation ?? null,
    ...(allocatedBytes === undefined ? {} : { allocatedBytes, allocatedBytesPerOperation: allocatedBytes / iterations }),
  })}\n`
);
