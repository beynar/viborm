// Prints uncovered lines/branches/functions for a source file from a focused
// coverage run. Reads JSON only; never loads src. Safe to run at any time.
//   node scripts/uncovered.mjs <lane> <src/path/to/file.ts>
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const [lane, target] = process.argv.slice(2);
if (!(lane && target)) {
  console.error("usage: node scripts/uncovered.mjs <lane> <src/path.ts>");
  process.exit(1);
}
const data = JSON.parse(
  readFileSync(`coverage/${lane}/coverage-final.json`, "utf8")
);
const key = Object.keys(data).find((f) => f.endsWith(target));
if (!key) {
  console.error(`no coverage entry ending in ${target} for lane ${lane}`);
  process.exit(1);
}
const e = data[key];
const ranges = (nums) => {
  const s = [...new Set(nums)].sort((a, b) => a - b);
  const out = [];
  for (const n of s) {
    const last = out.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ");
};
const stmts = Object.entries(e.s)
  .filter(([, c]) => c === 0)
  .map(([id]) => e.statementMap[id].start.line);
const fns = Object.entries(e.f)
  .filter(([, c]) => c === 0)
  .map(([id]) => `${e.fnMap[id].name}@${e.fnMap[id].decl.start.line}`);
const brs = [];
for (const [id, counts] of Object.entries(e.b)) {
  counts.forEach((c, i) => {
    if (c === 0) {
      const loc = e.branchMap[id].locations[i] ?? e.branchMap[id].loc;
      brs.push(loc.start.line);
    }
  });
}
console.log(`file: ${resolve(key)}`);
console.log(
  `uncovered statements (${stmts.length}): ${ranges(stmts) || "none"}`
);
console.log(`uncovered branches   (${brs.length}): ${ranges(brs) || "none"}`);
console.log(
  `uncovered functions  (${fns.length}): ${fns.join(", ") || "none"}`
);
