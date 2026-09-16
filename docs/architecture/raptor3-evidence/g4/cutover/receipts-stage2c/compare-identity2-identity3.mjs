/** Cell-by-cell comparison of the identity-2 and identity-3 series. */
import { readFileSync } from "node:fs";
const ROOT = "/Users/arnaud/code/viborm/docs/architecture/raptor3-evidence/g4/cutover";
const two = JSON.parse(readFileSync(`${ROOT}/performance.json`, "utf8"));
const three = JSON.parse(readFileSync(`${ROOT}/performance-identity3.json`, "utf8"));
const key = (c) => `${c.workload}/${c.stage}`;
const byKey = (r) => new Map(r.cells.map((c) => [key(c), c]));
const m2 = byKey(two), m3 = byKey(three);
const num = (c, pass, metric, field = "ratio") => {
  const v = c.perPass?.[pass]?.metrics?.[metric];
  return v ? v[field] : undefined;
};
const f = (x, d = 3) => (typeof x === "number" ? x.toFixed(d) : "—");
const rows = [];
for (const k of m3.keys()) {
  const a = m2.get(k), b = m3.get(k);
  const passes2 = two.passes, passes3 = three.passes;
  const last2 = passes2.at(-1), last3 = passes3.at(-1);
  rows.push({
    cell: k,
    v2: a?.verdict ?? "—",
    v3: b.verdict,
    cpu2: num(a, last2, "cpuMicrosecondsPerOperation"),
    cpu3: num(b, last3, "cpuMicrosecondsPerOperation"),
    wall2: num(a, last2, "wallMicrosecondsPerOperation"),
    wall3: num(b, last3, "wallMicrosecondsPerOperation"),
    rss2: num(a, last2, "peakRssBytes"),
    rss3: num(b, last3, "peakRssBytes"),
    B3cpu: num(b, last3, "cpuMicrosecondsPerOperation", "B"),
    N3cpu: num(b, last3, "cpuMicrosecondsPerOperation", "N"),
    E3cpu: num(b, last3, "cpuMicrosecondsPerOperation", "E"),
    B2cpu: num(a, last2, "cpuMicrosecondsPerOperation", "B"),
    N2cpu: num(a, last2, "cpuMicrosecondsPerOperation", "N"),
    passAgree: b.passesAgree,
    perPass3: three.passes.map((p) => b.perPass?.[p]?.verdict ?? "—").join(" | "),
  });
}
console.log("| Cell | id2 verdict | id3 verdict | cpu id2→id3 | wall id2→id3 | rss id2→id3 |");
console.log("| --- | --- | --- | ---: | ---: | ---: |");
for (const r of rows) {
  console.log(`| \`${r.cell}\` | ${r.v2} | ${r.v3} | ${f(r.cpu2)} → **${f(r.cpu3)}** | ${f(r.wall2)} → ${f(r.wall3)} | ${f(r.rss2)} → ${f(r.rss3)} |`);
}
console.log("\n--- absolutes (cpu µs/op, last pass) ---");
console.log("cell,B_id2,N_id2,B_id3,N_id3,E_id3,perPass_id3,agree");
for (const r of rows) {
  console.log(`${r.cell},${f(r.B2cpu,4)},${f(r.N2cpu,4)},${f(r.B3cpu,4)},${f(r.N3cpu,4)},${f(r.E3cpu,4)},${r.perPass3},${r.passAgree}`);
}
console.log("\n--- tallies ---");
console.log("identity 2:", JSON.stringify(two.tally));
console.log("identity 3:", JSON.stringify(three.tally));
