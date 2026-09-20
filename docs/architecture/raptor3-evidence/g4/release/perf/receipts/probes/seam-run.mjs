/** v2: five alternating fresh-process pairs per (workload, seam, side); medians.
 * ONE seam per process; the frozen protocol's own iteration counts per cell. */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const SIDES = {
  baseline: "/private/tmp/viborm-perf-baseline",
  candidate: "/private/tmp/viborm-perf-cand",
};
const CELLS = [
  ["scalar-find-unique", 5000, 1000],
  ["fixed-collection-rowref-20", 5000, 1000],
  ["fixed-collection-rowref-1000", 1000, 200],
];
const SEAMS = ["statement", "package"];
const PROBE =
  "/private/tmp/viborm-perf/docs/architecture/raptor3-evidence/g4/release/perf/receipts/probes/seam-probe.mjs";
const median = (xs) => { const s=[...xs].sort((a,b)=>a-b); const n=s.length; return n%2?s[(n-1)/2]:(s[n/2-1]+s[n/2])/2; };

const samples = [];
for (const [workload, iterations, warmup] of CELLS) {
 for (const seam of SEAMS) {
  for (let pair = 0; pair < 5; pair++) {
    for (const side of ["baseline", "candidate"]) {
      const out = execFileSync(
        process.execPath,
        ["--expose-gc", PROBE, SIDES[side], workload, seam, String(iterations), String(warmup)],
        { cwd: SIDES[side], encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, TMPDIR: "/private/tmp/viborm-perf-tmp/run" } }
      );
      const parsed = JSON.parse(out);
      samples.push({ side, pair, ...parsed });
      process.stdout.write(`${workload} ${seam} ${side} pair${pair} cpu=${parsed.results[0].cpuUsPerOp.toFixed(2)}\n`);
    }
  }
 }
}

const summary = [];
for (const [workload] of CELLS) {
  const row = { workload, published: {}, seams: {} };
  for (const seam of ["statement", "package"]) {
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
  summary.push(row);
}

writeFileSync(
  "/private/tmp/viborm-perf/docs/architecture/raptor3-evidence/g4/release/perf/receipts/probes/seam-samples-v2.json",
  `${JSON.stringify(samples, null, 1)}\n`
);
writeFileSync(
  "/private/tmp/viborm-perf/docs/architecture/raptor3-evidence/g4/release/perf/receipts/probes/seam-summary-v2.json",
  `${JSON.stringify({
    method: "v2: 5 alternating fresh-process pairs per (workload, seam, side), medians; ONE seam per process; the frozen protocol own iteration counts per cell (5000/1000; rowref-1000 1000/200); sqlite3 :memory:, Node v24.21.0, darwin/arm64.",
    trees: SIDES, cells: summary,
  }, null, 1)}\n`
);
for (const row of summary) {
  for (const [seam, m] of Object.entries(row.seams)) {
    console.log(`${row.workload.padEnd(30)} ${seam.padEnd(40)} cpu ${m.baselineCpuMedian.toFixed(2)} -> ${m.candidateCpuMedian.toFixed(2)} = ${m.cpuRatio.toFixed(3)}  wall ratio ${m.wallRatio.toFixed(3)}`);
  }
}
