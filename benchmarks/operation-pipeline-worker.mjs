/** One fresh-process measurement for the operation-pipeline proof surface. */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cpus, type as osType, release } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  ALL_MODES,
  ALL_PROVIDERS,
  ALLOCATION_SAMPLING_INTERVAL,
  EXTENSION_ARMS,
  PROVIDERS,
  WORKLOADS,
} from "./operation-pipeline-catalog.mjs";
import { protocolIdentity } from "./operation-pipeline-protocol.mjs";
import { createWorkloadHarness } from "./operation-pipeline-workloads.mjs";

const BENCHMARK_REPOSITORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  ".."
);

function workspaceMetadata(repositoryDirectory) {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryDirectory,
    encoding: "utf8",
  }).trim();
  const branch = execFileSync("git", ["branch", "--show-current"], {
    cwd: repositoryDirectory,
    encoding: "utf8",
  }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], {
    cwd: repositoryDirectory,
    encoding: "utf8",
  }).trim();
  return {
    commit,
    branch: branch || null,
    clean: dirty.length === 0,
    lockSha256: createHash("sha256")
      .update(readFileSync(resolve(repositoryDirectory, "pnpm-lock.yaml")))
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
      extensionArms: EXTENSION_ARMS,
      protocol: protocolIdentity(BENCHMARK_REPOSITORY),
      modes: ALL_MODES,
      providers: PROVIDERS,
      workloads: WORKLOADS,
    })}\n`
  );
  process.exit(0);
}

if (
  typeof globalThis.gc !== "function" &&
  process.versions.bun &&
  typeof globalThis.Bun?.gc === "function"
) {
  globalThis.gc = () => globalThis.Bun.gc(true);
}

if (typeof globalThis.gc !== "function") {
  throw new Error("The benchmark worker must run with --expose-gc");
}

const targetDirectory = resolve(
  process.env.VIBORM_BENCH_TARGET_DIRECTORY ?? process.cwd()
);
const workloadName = process.env.VIBORM_BENCH_WORKLOAD;
const providerName = process.env.VIBORM_BENCH_PROVIDER ?? "sqlite3";
const stage = process.env.VIBORM_BENCH_STAGE;
const mode = process.env.VIBORM_BENCH_MODE;
const extensionArm = process.env.VIBORM_BENCH_EXTENSION_ARM ?? "unextended";
const expectedCommit = process.env.VIBORM_BENCH_EXPECTED_COMMIT;
const smoke = process.env.VIBORM_BENCH_SMOKE === "1";
const workload = WORKLOADS[workloadName];
if (!workload) throw new Error(`Unknown benchmark workload: ${workloadName}`);
if (!ALL_PROVIDERS.includes(providerName)) {
  throw new Error(`Unknown benchmark provider: ${providerName}`);
}
if (!workload.providers.includes(providerName)) {
  throw new Error(`${workloadName} is not defined for ${providerName}`);
}
if (!workload.stages.includes(stage)) {
  throw new Error(`Stage ${stage} is not defined for ${workloadName}`);
}
if (!ALL_MODES.includes(mode)) {
  throw new Error(`Unknown benchmark mode: ${mode}`);
}
if (!EXTENSION_ARMS.includes(extensionArm)) {
  throw new Error(`Unknown extension benchmark arm: ${extensionArm}`);
}
if (extensionArm !== "unextended" && !workload.extensionProof) {
  throw new Error(
    `${workloadName} is not an extension-overhead proof workload`
  );
}
const stageKind = workload.stageKinds[stage];
if (!(stageKind === "sync" || stageKind === "async")) {
  throw new Error(`Stage ${stage} has no sync/async protocol declaration`);
}

const metadata = workspaceMetadata(targetDirectory);
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

const unavailableReason = PROVIDERS[providerName].unavailableReason;
if (unavailableReason) {
  process.stdout.write(
    `${JSON.stringify({
      status: "skipped",
      reason: unavailableReason,
      metadata,
      protocol: protocolIdentity(BENCHMARK_REPOSITORY),
      provider: providerName,
      workload: workloadName,
      stage,
      stageKind,
      mode,
      extensionArm,
    })}\n`
  );
  process.exit(0);
}
if (process.versions.bun && mode === "alloc") {
  process.stdout.write(
    `${JSON.stringify({
      status: "skipped",
      reason:
        "The Bun worker has no verified V8 inspector allocation sampler; CPU and retained modes remain executable.",
      metadata,
      protocol: protocolIdentity(BENCHMARK_REPOSITORY),
      provider: providerName,
      workload: workloadName,
      stage,
      stageKind,
      mode,
      extensionArm,
    })}\n`
  );
  process.exit(0);
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
  const { default: inspector } = await import("node:inspector");
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
  const peakRssBefore = process.resourceUsage().maxRSS * 1024;
  const checksum =
    stageKind === "sync"
      ? runIterationsSync(runOne, iterations)
      : await runIterationsAsync(runOne, iterations);
  const beforeCollection = process.memoryUsage().heapUsed;
  globalThis.gc();
  globalThis.gc();
  const afterCollection = process.memoryUsage().heapUsed;
  const retainedBytes = afterCollection - before;
  return {
    checksum,
    retainedBytes,
    retainedBytesPerOperation: retainedBytes / iterations,
    retainedBytesPerRow:
      retainedBytes / (iterations * workload.rowsPerOperation),
    releasedBytes: Math.max(0, beforeCollection - afterCollection),
    releasedBytesPerOperation:
      Math.max(0, beforeCollection - afterCollection) / iterations,
    releasedBytesPerRow:
      Math.max(0, beforeCollection - afterCollection) /
      (iterations * workload.rowsPerOperation),
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
    peakRssGrowthBytes: process.resourceUsage().maxRSS * 1024 - peakRssBefore,
  };
}

const workloadHarness = await createWorkloadHarness(
  workloadName,
  stage,
  iterations + warmupIterations,
  providerName,
  targetDirectory,
  extensionArm
);
if (workloadHarness.skipReason) {
  process.stdout.write(
    `${JSON.stringify({
      status: "skipped",
      reason: workloadHarness.skipReason,
      metadata,
      protocol: protocolIdentity(BENCHMARK_REPOSITORY),
      provider: providerName,
      workload: workloadName,
      stage,
      stageKind,
      mode,
      extensionArm,
    })}\n`
  );
  process.exit(0);
}
const { fixture, semanticFixture, harness } = workloadHarness;
const runOne = harness[stage];
if (!runOne) {
  throw new Error(`Harness ${workloadName} does not implement ${stage}`);
}
if (stageKind === "sync") runIterationsSync(runOne, warmupIterations);
else await runIterationsAsync(runOne, warmupIterations);
harness.responseBytes?.reset();
const measurement =
  mode === "alloc"
    ? await measureAllocation(runOne)
    : mode === "cpu"
      ? await measureCpu(runOne)
      : await measureRetained(runOne);
if (harness.responseBytes) {
  const responseBytes = harness.responseBytes.read();
  measurement.responseBytes = responseBytes;
  measurement.responseBytesPerOperation = responseBytes / iterations;
  measurement.responseBytesPerRow =
    responseBytes / (iterations * workload.rowsPerOperation);
  measurement.responseBytesSource = harness.responseBytes.source;
}
await fixture.driver.disconnect();
await semanticFixture.driver.disconnect();

process.stdout.write(
  `${JSON.stringify({
    metadata,
    status: "measured",
    protocol: protocolIdentity(BENCHMARK_REPOSITORY),
    provider: providerName,
    workload: workloadName,
    stage,
    stageKind,
    mode,
    extensionArm,
    rowsPerOperation: workload.rowsPerOperation,
    iterations,
    warmupIterations,
    allocationSamplingInterval: ALLOCATION_SAMPLING_INTERVAL,
    witness: harness.witness,
    semanticDigest: harness.semanticDigest,
    measurement,
  })}\n`
);
