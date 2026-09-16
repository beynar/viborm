import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
const REPO = "/Users/arnaud/code/viborm";
const SENTINEL = String.fromCharCode(0);
const collect = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) {
      if (!p.includes("/raptor3")) collect(p, out);
    } else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
};
const shippedFiles = collect(resolve(REPO, "src"));
let haystack = "";
for (const f of shippedFiles) haystack += readFileSync(f, "utf8");
const norm = (s) =>
  s
    .replace(/\$\{[^}]*\}/g, SENTINEL)
    .replace(/[`"'+]/g, "")
    .replace(/\s+/g, " ");
const hay = norm(haystack);

const rows = JSON.parse(
  readFileSync(
    "/private/tmp/claude-501/-Users-arnaud-code-viborm/c2c775da-2927-4590-8677-3bb0f5d1aa98/scratchpad/C/refusals.json",
    "utf8"
  )
);
const unmatched = [];
for (const r of rows) {
  if (r.shippedHits.length) continue;
  const frags = norm(r.msg)
    .split(SENTINEL)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
  if (!frags.length) {
    unmatched.push({ sites: r.sites, msg: r.msg, missing: ["<no static fragment>"] });
    continue;
  }
  const missing = frags.filter((f) => !hay.includes(f));
  if (missing.length) unmatched.push({ sites: r.sites, msg: r.msg, missing });
}
console.log(JSON.stringify(unmatched, null, 1));
