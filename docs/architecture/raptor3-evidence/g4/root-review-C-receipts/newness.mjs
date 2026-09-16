import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REPO = "/Users/arnaud/code/viborm";
const SENTINEL = String.fromCharCode(0);
const baseline = execFileSync(
  "bash",
  [
    "-lc",
    "git -C " +
      REPO +
      " grep -h '' 0cc61e61 -- 'src/query-engine/raptor3/**/*.ts' || true",
  ],
  { encoding: "utf8", maxBuffer: 200 * 1024 * 1024 }
);
const norm = (s) =>
  s
    .replace(/\$\{[^}]*\}/g, SENTINEL)
    .replace(/[`"'+]/g, "")
    .replace(/\s+/g, " ");
const hay = norm(baseline);

const unmatched = JSON.parse(
  readFileSync(
    "/private/tmp/claude-501/-Users-arnaud-code-viborm/c2c775da-2927-4590-8677-3bb0f5d1aa98/scratchpad/C/unmatched.json",
    "utf8"
  )
);
const out = [];
for (const r of unmatched) {
  const frags = norm(r.msg)
    .split(SENTINEL)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
  const present = frags.length > 0 && frags.every((f) => hay.includes(f));
  out.push({ sites: r.sites, msg: r.msg.slice(0, 200), atBaseline: present });
}
console.log(JSON.stringify(out, null, 1));
