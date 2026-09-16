/**
 * Stage 2d: cell-by-cell comparison of the identity-3 and identity-4 records.
 *
 * Successor of receipts-stage2c/compare-identity2-identity3.mjs. One difference
 * of substance: at identity 3 the protocol identity had moved (D-8), so that
 * script could only compare within-series ratios. Here the protocol identity is
 * the SAME on both sides (f23e0aac…, protocol.md §10.2), the workload version is
 * the same (1), the baseline commit is the same (e532bbec) and the commands are
 * the same, so absolute medians are comparable too and both are printed.
 */
import { readFileSync } from "node:fs";
const DIR = "/Users/arnaud/code/viborm/docs/architecture/raptor3-evidence/g4/cutover";
const id3 = JSON.parse(readFileSync(`${DIR}/performance-identity3.json`, "utf8"));
const id4 = JSON.parse(readFileSync(`${DIR}/performance-identity4.json`, "utf8"));
const key = (c) => `${c.workload}/${c.stage}`;
const byKey = (r) => new Map(r.cells.map((c) => [key(c), c]));
const m3 = byKey(id3), m4 = byKey(id4);
const worstPass = (cell, metric) => {
  const passes = ["pass1", "pass2"].map((p) => cell.perPass?.[p]?.metrics?.[metric]).filter(Boolean);
  if (!passes.length) return null;
  return passes.reduce((a, b) => (b.ratio > a.ratio ? b : a));
};
const fmt = (x, d = 3) => (x === null || x === undefined ? "—" : Number(x).toFixed(d));
const rows = [];
for (const [k, c4] of m4) {
  const c3 = m3.get(k);
  const row = { cell: k, verdict3: c3?.verdict ?? "—", verdict4: c4.verdict };
  for (const [label, metric] of [["cpu", "cpuMicrosecondsPerOperation"], ["wall", "wallMicrosecondsPerOperation"], ["rss", "peakRssBytes"]]) {
    const w3 = c3 ? worstPass(c3, metric) : null;
    const w4 = worstPass(c4, metric);
    row[label] = {
      id3Ratio: w3?.ratio ?? null, id4Ratio: w4?.ratio ?? null,
      id3B: w3?.B ?? null, id3N: w3?.N ?? null, id4B: w4?.B ?? null, id4N: w4?.N ?? null,
      id3EoverB: w3 ? w3.E / w3.B : null, id4EoverB: w4 ? w4.E / w4.B : null,
      id4E: w4?.E ?? null, id4MadBaseline: w4?.madBaseline ?? null, id4MadCandidate: w4?.madCandidate ?? null,
      id4DeltaPlusE: w4?.deltaPlusE ?? null, id4Budget: w4?.budget ?? null,
      id4ImprovementBeyondE: w4?.improvementBeyondE ?? null,
    };
  }
  rows.push(row);
}
if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(rows, null, 1)}\n`);
} else {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad("cell", 38), pad("id3 verdict", 22), pad("id4 verdict", 22), "cpu3→cpu4      wall3→wall4    rss3→rss4      E/B(cpu) id4");
  for (const r of rows) {
    console.log(
      pad(r.cell, 38),
      pad(String(r.verdict3).slice(0, 21), 22),
      pad(String(r.verdict4).slice(0, 21), 22),
      `${fmt(r.cpu.id3Ratio)}→${fmt(r.cpu.id4Ratio)}  ${fmt(r.wall.id3Ratio)}→${fmt(r.wall.id4Ratio)}  ${fmt(r.rss.id3Ratio)}→${fmt(r.rss.id4Ratio)}  ${r.cpu.id4EoverB === null ? "—" : `${(r.cpu.id4EoverB * 100).toFixed(1)}%`}`
    );
  }
}
