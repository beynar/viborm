import { readFileSync } from "node:fs";

const SCR =
  "/private/tmp/claude-501/-Users-arnaud-code-viborm/c2c775da-2927-4590-8677-3bb0f5d1aa98/scratchpad/C";
const unmatched = JSON.parse(readFileSync(`${SCR}/unmatched.json`, "utf8"));
const newness = JSON.parse(readFileSync(`${SCR}/newness.json`, "utf8"));
const base = new Map(newness.map((r) => [r.sites.join(","), r.atBaseline]));
const REPO = "/Users/arnaud/code/viborm";

const rows = [];
for (const r of unmatched) {
  const [file, line] = r.sites[0].split(":");
  const src = readFileSync(`${REPO}/${file}`, "utf8").split("\n");
  const chunk = src.slice(Number(line) - 1, Number(line) + 6).join(" ");
  const cls =
    /throw\s+new\s+([A-Za-z0-9_]+)/.exec(chunk)?.[1] ??
    /throw\s+([A-Za-z0-9_.]+)/.exec(chunk)?.[1] ??
    "?";
  rows.push({
    class: cls,
    atBaseline: base.get(r.sites.join(",")) ?? null,
    sites: r.sites.length,
    first: r.sites[0],
    msg: r.msg.slice(0, 110).replace(/\s+/g, " "),
  });
}
rows.sort((a, b) => a.class.localeCompare(b.class) || a.first.localeCompare(b.first));
const counts = {};
for (const r of rows) counts[r.class] = (counts[r.class] ?? 0) + 1;
console.log("class histogram:", JSON.stringify(counts));
console.log();
for (const r of rows)
  console.log(
    `${r.class.padEnd(24)} ${r.atBaseline ? "inherited" : "NEW-in-G4"} ${r.first}\n    ${r.msg}`
  );
