/**
 * P1 direct-worker driver. Mirrors `operation-pipeline-compare.mjs`'s
 * measurement loop exactly — five replicates, the same alternating checkout
 * order (`checkoutOrder`), one fresh process per sample, the same env and
 * NODE_OPTIONS — for a candidate worktree that is DIRTY and therefore refused
 * by `validateCheckout`. The candidate arm runs in the worker's own CALIBRATION
 * mode (`VIBORM_BENCH_CALIBRATION_SOURCE_SHA256`), which is the protocol's own
 * mechanism for measuring a tree that is not a committed checkout: it pins the
 * src+benchmarks+scripts+dist fingerprint before AND after the measured loop.
 *
 * Usage: node pair-run.mjs <workload> <stage> <mode> <out.json> [iterations] [warmup]
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { calibrationSourceIdentity } from "/private/tmp/viborm-p1/benchmarks/operation-pipeline-semantics.mjs";
import { parseEvidenceReport } from "/private/tmp/viborm-p1/benchmarks/operation-pipeline-evidence.mjs";

const BASE = { label: "baseline", dir: "/private/tmp/viborm-perf-baseline", commit: "5a37bcd7f371fe393cf7cecb8ec9f82ef8bd3062" };
const CAND = { label: "candidate", dir: "/private/tmp/viborm-p1", commit: "9058df3bf448a64959ebb43ea2839f56602f7e5f" };
const [workload, stage, mode, out, iterRaw, warmRaw] = process.argv.slice(2);

const candIdentity = calibrationSourceIdentity(CAND.dir, true).sha256;

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function run(checkout) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, ["--expose-gc", `${checkout.dir}/benchmarks/operation-pipeline-worker.mjs`], {
      cwd: checkout.dir,
      env: {
        ...process.env,
        TMPDIR: "/private/tmp/viborm-p1-tmp",
        VIBORM_BENCH_PROVIDER: "sqlite3",
        VIBORM_BENCH_WORKLOAD: workload,
        VIBORM_BENCH_STAGE: stage,
        VIBORM_BENCH_MODE: mode,
        VIBORM_BENCH_EXPECTED_COMMIT: checkout.commit,
        VIBORM_BENCH_TARGET_DIRECTORY: checkout.dir,
        VIBORM_BENCH_EXTENSION_ARM: "unextended",
        VIBORM_BENCH_SMOKE: "0",
        ...(iterRaw ? { VIBORM_BENCH_ITERATIONS: iterRaw, VIBORM_BENCH_WARMUP_ITERATIONS: warmRaw } : {}),
        ...(checkout.label === "candidate" ? { VIBORM_BENCH_CALIBRATION_SOURCE_SHA256: candIdentity } : {}),
        NODE_OPTIONS: "--max-old-space-size=2048",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let o = "", e = "";
    child.stdout.on("data", (d) => (o += d));
    child.stderr.on("data", (d) => (e += d));
    child.once("exit", (code) => (code === 0 ? res(parseEvidenceReport(o.trim().split("\n").pop())) : rej(new Error(`${checkout.label} exit ${code}\n${e || o}`))));
  });
}

const samples = { baseline: [], candidate: [] };
for (let replicate = 0; replicate < 5; replicate++) {
  const order = replicate % 2 === 0 ? [BASE, CAND] : [CAND, BASE];
  for (const checkout of order) {
    process.stderr.write(`sqlite3/${workload}/${stage}/${mode} replicate ${replicate + 1}/5: ${checkout.label}\n`);
    const s = await run(checkout);
    if (s.status !== "measured") throw new Error(`not measured: ${JSON.stringify(s).slice(0, 300)}`);
    if (s.metadata.commit !== checkout.commit) throw new Error("commit mismatch");
    if (s.witness?.statementCount === undefined) throw new Error("no witness");
    samples[checkout.label].push(s);
  }
}
const metricNames = Object.keys(samples.baseline[0].measurement).filter(
  (k) => typeof samples.baseline[0].measurement[k] === "number" && k !== "checksum"
);
const report = { workload, stage, mode, iterations: samples.baseline[0].iterations, warmupIterations: samples.baseline[0].warmupIterations, candidateCalibrationSourceSha256: candIdentity, metrics: {}, witness: {}, semanticDigest: {}, samples };
for (const side of ["baseline", "candidate"]) {
  report.witness[side] = samples[side].map((s) => s.witness.statementCount);
  report.semanticDigest[side] = [...new Set(samples[side].map((s) => s.semanticDigest))];
}
for (const m of metricNames) {
  const b = median(samples.baseline.map((s) => s.measurement[m]));
  const c = median(samples.candidate.map((s) => s.measurement[m]));
  report.metrics[m] = { baseline: b, candidate: c, ratio: c / b };
}
writeFileSync(out, JSON.stringify(report, null, 1));
for (const m of metricNames)
  console.log(`${workload}/${stage}/${mode} ${m}: B=${report.metrics[m].baseline.toFixed(3)} C=${report.metrics[m].candidate.toFixed(3)} ratio=${report.metrics[m].ratio.toFixed(4)}`);
console.log(`statementCount B=${report.witness.baseline.join("/")} C=${report.witness.candidate.join("/")}`);
console.log(`semanticDigest B=${report.semanticDigest.baseline.join(",")} C=${report.semanticDigest.candidate.join(",")}`);
