/** Median-summarise ab-samples.jsonl into a cell/engine/arm table. */
import { readFileSync } from "node:fs";
const rows = readFileSync(process.argv[2], "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const med = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const key = (r) => `${r.workload}/${r.stage}`;
const cells = [...new Set(rows.map(key))];
const arms = [...new Set(rows.map((r) => r.arm))];
const out = {};
for (const c of cells) {
  out[c] = {};
  for (const e of ["shipped", "candidate"]) {
    out[c][e] = {};
    for (const a of arms) {
      const s = rows.filter((r) => key(r) === c && r.engine === e && r.arm === a);
      if (!s.length) continue;
      out[c][e][a] = {
        n: s.length,
        cpu: +med(s.map((r) => r.cpuUsPerOp)).toFixed(3),
        wall: +med(s.map((r) => r.wallUsPerOp)).toFixed(3),
        captures: +med(s.map((r) => r.explicitStackCapturesPerOp ?? 0)).toFixed(3),
      };
    }
  }
  for (const a of arms) {
    const b = out[c].shipped[a], n = out[c].candidate[a];
    if (b && n) out[c][`ratio_${a}`] = { cpu: +(n.cpu / b.cpu).toFixed(3), wall: +(n.wall / b.wall).toFixed(3) };
  }
}
console.log(JSON.stringify(out, null, 1));
