/** Round-2 reviewer's independent re-run of the author's seam-probe-v6.mjs.
 * Same shape as the author's seam-run-v6.mjs (5 fresh-process pairs per seam,
 * side order alternated per pair, 1000/200), but it INVOKES the author's probe
 * unchanged and writes ONLY into the reviewer's own receipts directory. */
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
  "/private/tmp/viborm-perf/docs/architecture/raptor3-evidence/g4/release/perf/review-round2-receipts";
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
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, TMPDIR: "/private/tmp/viborm-perf-tmp-r" } }
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
    const bc = median(value("baseline", "cpuUsPerOp"));
    const cc = median(value("candidate", "cpuUsPerOp"));
    const bw = median(value("baseline", "wallUsPerOp"));
    const cw = median(value("candidate", "wallUsPerOp"));
    row.seams[seam] = {
      baselineCpuMedian: bc, candidateCpuMedian: cc, cpuRatio: cc / bc,
      baselineWallMedian: bw, candidateWallMedian: cw, wallRatio: cw / bw,
      baselineCpuSamples: value("baseline", "cpuUsPerOp"),
      candidateCpuSamples: value("candidate", "cpuUsPerOp"),
    };
  }
  for (const side of ["baseline", "candidate"]) {
    row.published[side] = samples.find((s) => s.workload === workload && s.side === side)?.published;
  }
  row.allSamplesPublishOneStatementPerSeam = samples.every(
    (s) => s.published?.statement?.answered === true && s.published.statement.statementCount === 1 &&
           s.published?.package?.answered === true && s.published.package.statementCount === 1
  );
  row.stageKind = samples.find((s) => s.workload === workload)?.stageKind;
  summary.push(row);
}

writeFileSync(`${OUT}/r2-seam-samples-v6.json`, `${JSON.stringify(samples, null, 1)}\n`);
writeFileSync(`${OUT}/r2-seam-summary-v6.json`, `${JSON.stringify({
  reviewer: "round-2 independent re-run of the author's seam-probe-v6.mjs (probe unchanged; runner is the reviewer's own copy writing only to review-round2-receipts)",
  TMPDIR: "/private/tmp/viborm-perf-tmp-r",
  authorReading: { statementCpuRatio: 1.4105, packageCpuRatio: 1.3250 },
  trees: SIDES, cells: summary,
}, null, 1)}\n`);
for (const row of summary) {
  for (const [seam, m] of Object.entries(row.seams)) {
    console.log(`${row.workload.padEnd(30)} ${seam.padEnd(12)} cpu ${m.baselineCpuMedian.toFixed(2)} -> ${m.candidateCpuMedian.toFixed(2)} = ${m.cpuRatio.toFixed(3)}  wall ratio ${m.wallRatio.toFixed(3)}`);
  }
}
