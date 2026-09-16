// Every relative markdown link target under g4/** must exist on disk.
// A dangling link into a receipts directory is evidence that something was
// deleted or never written.
import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve, join, relative } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../../../../..");
const G4 = resolve(ROOT, "docs/architecture/raptor3-evidence/g4");

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

const LINK = /\[[^\]]*\]\(([^)\s#]+)(?:\s+"[^"]*")?\)/g;
const missing = [];
let checked = 0;
for (const file of walk(G4)) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(LINK)) {
    const href = m[1];
    if (/^(https?:|mailto:|#)/.test(href)) continue;
    if (href.startsWith("<")) continue;
    const target = resolve(dirname(file), decodeURI(href));
    checked += 1;
    if (!existsSync(target)) {
      missing.push({ from: relative(ROOT, file), href });
    }
  }
}
console.log(JSON.stringify({ markdownFiles: walk(G4).length, linksChecked: checked, missing }, null, 2));
