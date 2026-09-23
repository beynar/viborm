/** v6 runner — the ONE cell review finding F2 asks for, with v5's method.
 *
 * Five fresh-process pairs per (seam, side), medians; ONE seam per process; the
 * frozen protocol's own counts for this cell (1,000 iterations / 200 warmup, the
 * counts the series ran it at). One difference from `seam-run-v5.mjs`: the SIDE
 * ORDER alternates per pair (the reviewer's §3 caveat), where v5 always ran
 * baseline first. v5's receipts are untouched; this writes its own.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const SIDES = {
  baseline: "/private/tmp/viborm-perf-baseline",
  candidate: "/private/tmp/viborm-perf-cand",
};
const CELLS = [["bulk-update-returning-100", 1000, 200]];
const SEAMS = ["statement", "package"];
const PROBE =
  "/private/tmp/viborm-perf/docs/architecture/raptor3-evidence/g4/release/perf/receipts/probes/seam-probe-v6.mjs";
const OUT =
  "/private/tmp/viborm-perf/docs/architecture/raptor3-evidence/g4/release/perf/receipts/probes";
const median = (xs) => { const s=[...xs].sort((a,b)=>a-b); const n=s.length; return n%2?s[(n-1)/2]:(s[n/2-1]+s[n/2])/2; };

const samples = [];
for (const [workload, iterations, warmup] of CELLS) {
 for (const seam of SEAMS) {
  for (let pair = 0; pair < 5; pair++) {
    const order = pair % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    for (const side of order) {
      const out = execFileSync(
        process.execPath,
        ["--expose-gc", PROBE, SIDES[side], workload, seam, String(iterations), String(warmup)],
        { cwd: SIDES[side], encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, TMPDIR: "/private/tmp/viborm-perf-tmp/run" } }
      );
      const parsed = JSON.parse(out);
      samples.push({ side, pair, sideOrder: order.join(">"), ...parsed });
      process.stdout.write(`${workload} ${seam} ${side} pair${pair} (${order.join(">")}) cpu=${parsed.results[0].cpuUsPerOp.toFixed(2)}\n`);
    }
  }
 }
}

const summary = [];
for (const [workload] of CELLS) {
  const row = { workload, published: {}, seams: {} };
  for (const seam of SEAMS) {
    const value = (side, metric) =>
      samples.filter((s) => s.workload === workload && s.side === side && s.seam === seam)
        .map((s) => s.results[0]?.[metric])
        .filter((v) => typeof v === "number");
    const B = value("baseline", "cpuUsPerOp"), N = value("candidate", "cpuUsPerOp");
    const Bw = value("baseline", "wallUsPerOp"), Nw = value("candidate", "wallUsPerOp");
    if (!B.length || !N.length) continue;
    row.seams[seam] = {
      baselineCpuMedian: median(B), candidateCpuMedian: median(N), cpuRatio: median(N) / median(B),
      baselineWallMedian: median(Bw), candidateWallMedian: median(Nw), wallRatio: median(Nw) / median(Bw),
      baselineCpuSamples: B, candidateCpuSamples: N,
    };
  }
  for (const side of ["baseline", "candidate"]) {
    row.published[side] = samples.find((s) => s.workload === workload && s.side === side)?.published;
  }
  row.stageKind = samples.find((s) => s.workload === workload)?.stageKind;
  summary.push(row);
}

writeFileSync(`${OUT}/seam-samples-v6.json`, `${JSON.stringify(samples, null, 1)}\n`);
writeFileSync(
  `${OUT}/seam-summary-v6.json`,
  `${JSON.stringify({
    method: "v6 (v5's method, one added workload: series setup, the catalog's stage kind for the statement-arm loop, NO forced collection between warmup and the measured loop): 5 fresh-process pairs per (seam, side) with the SIDE ORDER ALTERNATED per pair, medians; ONE seam per process; the counts the series ran this cell at (1000/200); sqlite3 :memory:, Node v24.21.0, darwin/arm64.",
    seriesComparison: {
      cell: "bulk-update-returning-100/prepare",
      seriesCpuRatioPass1: 1.5558,
      seriesCpuRatioPass2: 1.4316,
      note: "the series brackets prepareOperationPlan(op, driver) + witness checksum, which returns capability.prepare() when that seam answers; both sides answer it here (see published)",
    },
    trees: SIDES, cells: summary,
  }, null, 1)}\n`
);
for (const row of summary) {
  for (const [seam, m] of Object.entries(row.seams)) {
    console.log(`${row.workload.padEnd(30)} ${seam.padEnd(12)} cpu ${m.baselineCpuMedian.toFixed(2)} -> ${m.candidateCpuMedian.toFixed(2)} = ${m.cpuRatio.toFixed(3)}  wall ratio ${m.wallRatio.toFixed(3)}`);
  }
}
