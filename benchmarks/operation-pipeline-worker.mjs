/** One fresh-process measurement for the operation-pipeline proof surface. */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import inspector from "node:inspector";
import { cpus, type as osType, release } from "node:os";
import { performance } from "node:perf_hooks";
import process from "node:process";
import {
  ALL_MODES,
  ALLOCATION_SAMPLING_INTERVAL,
  WORKLOADS,
} from "./operation-pipeline-catalog.mjs";
import { protocolIdentity } from "./operation-pipeline-protocol.mjs";
import { createWorkloadHarness } from "./operation-pipeline-workloads.mjs";

function workspaceMetadata() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const branch = execFileSync("git", ["branch", "--show-current"], {
    encoding: "utf8",
  }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  }).trim();
  return {
    commit,
    branch: branch || null,
    clean: dirty.length === 0,
    lockSha256: createHash("sha256")
      .update(readFileSync("pnpm-lock.yaml"))
      .digest("hex"),
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
      os: `${osType()} ${release()}`,
      cpu: cpus()[0]?.model ?? "unknown",
    },
  };
}

if (process.argv.includes("--describe")) {
  process.stdout.write(
    `${JSON.stringify({
      allocationSamplingInterval: ALLOCATION_SAMPLING_INTERVAL,
      protocol: protocolIdentity(process.cwd()),
      modes: ALL_MODES,
      workloads: WORKLOADS,
    })}\n`
  );
  process.exit(0);
}

if (typeof globalThis.gc !== "function") {
  throw new Error("The benchmark worker must run with --expose-gc");
}

const workloadName = process.env.VIBORM_BENCH_WORKLOAD;
const stage = process.env.VIBORM_BENCH_STAGE;
const mode = process.env.VIBORM_BENCH_MODE;
const expectedCommit = process.env.VIBORM_BENCH_EXPECTED_COMMIT;
const smoke = process.env.VIBORM_BENCH_SMOKE === "1";
const workload = WORKLOADS[workloadName];
if (!workload) throw new Error(`Unknown benchmark workload: ${workloadName}`);
if (!workload.stages.includes(stage)) {
  throw new Error(`Stage ${stage} is not defined for ${workloadName}`);
}
if (!ALL_MODES.includes(mode)) {
  throw new Error(`Unknown benchmark mode: ${mode}`);
}
const stageKind = workload.stageKinds[stage];
if (!(stageKind === "sync" || stageKind === "async")) {
  throw new Error(`Stage ${stage} has no sync/async protocol declaration`);
}

const metadata = workspaceMetadata();
const dirtySmokeAllowed =
  smoke && process.env.VIBORM_BENCH_ALLOW_DIRTY_SMOKE === "1";
if (!(metadata.clean || dirtySmokeAllowed)) {
  throw new Error("Benchmark worker refused a dirty worktree");
}
if (!expectedCommit || metadata.commit !== expectedCommit) {
  throw new Error(
    `Benchmark worker commit mismatch: expected ${expectedCommit}, got ${metadata.commit}`
  );
}

function positiveInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

const scaleDivisor = Math.max(1, workload.rowsPerOperation / 20);
const defaultIterations = smoke
  ? 2
  : mode === "retained"
    ? Math.max(20, Math.floor(500 / scaleDivisor))
    : Math.max(50, Math.floor(5000 / scaleDivisor));
const iterations = positiveInteger(
  "VIBORM_BENCH_ITERATIONS",
  defaultIterations
);
const warmupIterations = positiveInteger(
  "VIBORM_BENCH_WARMUP_ITERATIONS",
  smoke ? 1 : Math.max(10, Math.ceil(iterations / 5))
);

function postSession(session, method, params = {}) {
  return new Promise((resolve, reject) => {
    session.post(method, params, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
}

function sampledBytes(node) {
  let bytes = node.selfSize ?? 0;
  for (const child of node.children ?? []) bytes += sampledBytes(child);
  return bytes;
}

function runIterationsSync(runOne, count) {
  let checksum = 0;
  for (let index = 0; index < count; index++) checksum += runOne(index);
  if (!Number.isFinite(checksum)) {
    throw new Error("Benchmark checksum is not finite");
  }
  return checksum;
}

async function runIterationsAsync(runOne, count) {
  let checksum = 0;
  for (let index = 0; index < count; index++) checksum += await runOne(index);
  if (!Number.isFinite(checksum)) {
    throw new Error("Benchmark checksum is not finite");
  }
  return checksum;
}

async function measureAllocation(runOne) {
  const session = new inspector.Session();
  session.connect();
  try {
    await postSession(session, "HeapProfiler.enable");
    await postSession(session, "HeapProfiler.startSampling", {
      samplingInterval: ALLOCATION_SAMPLING_INTERVAL,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const checksum =
      stageKind === "sync"
        ? runIterationsSync(runOne, iterations)
        : await runIterationsAsync(runOne, iterations);
    const { profile } = await postSession(session, "HeapProfiler.stopSampling");
    const allocatedBytes = sampledBytes(profile.head);
    return {
      checksum,
      allocatedBytes,
      allocatedBytesPerOperation: allocatedBytes / iterations,
      allocatedBytesPerRow:
        allocatedBytes / (iterations * workload.rowsPerOperation),
    };
  } finally {
    session.disconnect();
  }
}

async function measureCpu(runOne) {
  const cpuBefore = process.cpuUsage();
  const wallBefore = performance.now();
  const checksum =
    stageKind === "sync"
      ? runIterationsSync(runOne, iterations)
      : await runIterationsAsync(runOne, iterations);
  const wallMilliseconds = performance.now() - wallBefore;
  const cpu = process.cpuUsage(cpuBefore);
  return {
    checksum,
    cpuMicrosecondsPerOperation: (cpu.user + cpu.system) / iterations,
    wallMicrosecondsPerOperation: (wallMilliseconds * 1000) / iterations,
  };
}

async function measureRetained(runOne) {
  globalThis.gc();
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  const checksum =
    stageKind === "sync"
      ? runIterationsSync(runOne, iterations)
      : await runIterationsAsync(runOne, iterations);
  globalThis.gc();
  globalThis.gc();
  const retainedBytes = process.memoryUsage().heapUsed - before;
  return {
    checksum,
    retainedBytes,
    retainedBytesPerOperation: retainedBytes / iterations,
    retainedBytesPerRow:
      retainedBytes / (iterations * workload.rowsPerOperation),
  };
}

const { fixture, semanticFixture, harness } = await createWorkloadHarness(
  workloadName,
  stage,
  iterations + warmupIterations
);
const runOne = harness[stage];
if (!runOne) {
  throw new Error(`Harness ${workloadName} does not implement ${stage}`);
}
if (stageKind === "sync") runIterationsSync(runOne, warmupIterations);
else await runIterationsAsync(runOne, warmupIterations);
const measurement =
  mode === "alloc"
    ? await measureAllocation(runOne)
    : mode === "cpu"
      ? await measureCpu(runOne)
      : await measureRetained(runOne);
await fixture.driver.disconnect();
await semanticFixture.driver.disconnect();

process.stdout.write(
  `${JSON.stringify({
    metadata,
    protocol: protocolIdentity(process.cwd()),
    workload: workloadName,
    stage,
    stageKind,
    mode,
    rowsPerOperation: workload.rowsPerOperation,
    iterations,
    warmupIterations,
    allocationSamplingInterval: ALLOCATION_SAMPLING_INTERVAL,
    witness: harness.witness,
    semanticDigest: harness.semanticDigest,
    measurement,
  })}\n`
);
