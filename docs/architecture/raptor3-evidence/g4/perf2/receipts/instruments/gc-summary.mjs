/** Parse a --trace-gc stdout mixed with one JSON result line. */
import { readFileSync } from "node:fs";
const path = process.argv[2];
const text = readFileSync(path, "utf8");
const lines = text.split("\n");
const jsonLine = lines.find((l) => l.startsWith('{"worktree"'));
const res = jsonLine ? JSON.parse(jsonLine) : null;
// Steady state = the last 60 % of the trace lines (post-warm-up shape).
const gcLines = lines.filter((l) => /\]\s+\d+ ms: /.test(l));
const parse = (l) => {
  const m = l.match(/\]\s+(\d+) ms: ([A-Za-z-]+) ([\d.]+) \(([\d.]+)\) -> ([\d.]+) \(([\d.]+)\) MB.*?([\d.]+) \/ ([\d.]+) ms/);
  if (!m) return null;
  return { t: +m[1], kind: m[2], before: +m[3], cap: +m[4], after: +m[5], capAfter: +m[6], ms: +m[7], ms2: +m[8] };
};
const ev = gcLines.map(parse).filter(Boolean);
const scav = ev.filter((e) => e.kind === "Scavenge");
const major = ev.filter((e) => e.kind !== "Scavenge");
const sum = (a, f) => a.reduce((x, e) => x + f(e), 0);
const tail = scav.slice(Math.floor(scav.length * 0.5));
console.log(JSON.stringify({
  file: path.split("/").pop(),
  cpuUsPerOp: res?.cpuUsPerOp, wallUsPerOp: res?.wallUsPerOp, iterations: res?.iterations,
  scavenges: scav.length,
  scavengeMs: +sum(scav, (e) => e.ms + e.ms2).toFixed(2),
  majorCount: major.length,
  majorMs: +sum(major, (e) => e.ms + e.ms2).toFixed(2),
  totalGcMs: +sum(ev, (e) => e.ms + e.ms2).toFixed(2),
  gcUsPerOp: res ? +((sum(ev, (e) => e.ms + e.ms2) * 1000) / res.iterations).toFixed(3) : null,
  steadyScavengeMsMedian: tail.length ? +[...tail.map((e) => e.ms)].sort((a, b) => a - b)[Math.floor(tail.length / 2)].toFixed(3) : null,
  steadyCapMB: tail.length ? tail[Math.floor(tail.length / 2)].cap : null,
  steadyBeforeMB: tail.length ? tail[Math.floor(tail.length / 2)].before : null,
  steadyAfterMB: tail.length ? tail[Math.floor(tail.length / 2)].after : null,
}));
