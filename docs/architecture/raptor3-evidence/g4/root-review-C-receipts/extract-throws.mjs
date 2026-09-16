import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = "/Users/arnaud/code/viborm/src/query-engine/raptor3";
const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".ts")) files.push(p);
  }
};
walk(root);
files.sort();
const out = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/\bthrow\b/.test(lines[i])) continue;
    // capture up to 12 lines from the throw until balanced-ish
    const chunk = lines.slice(i, i + 12).join("\n");
    // the class name
    const cls = /throw\s+new\s+([A-Za-z0-9_]+)/.exec(chunk)?.[1] ?? /throw\s+([A-Za-z0-9_.(]+)/.exec(chunk)?.[1] ?? "?";
    out.push({ file: file.replace("/Users/arnaud/code/viborm/", ""), line: i + 1, cls, text: chunk.split("\n").slice(0, 8).map(s=>s.trim()).join(" ").slice(0, 320) });
  }
}
console.log(JSON.stringify(out, null, 1));
