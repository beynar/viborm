/** Same as analyze-lines.mjs, but also prints the GENERATED line's text. */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { SourceMap } from "node:module";
const [profilePath, fnFilter, topRaw] = process.argv.slice(2);
const top = Number(topRaw ?? 30);
const profile = JSON.parse(readFileSync(profilePath, "utf8"));
const src = new Map();
const maps = new Map();
function load(url) {
  if (maps.has(url)) return maps.get(url);
  let tm = null;
  try {
    const file = url.startsWith("file://") ? fileURLToPath(url) : url;
    src.set(url, readFileSync(file, "utf8").split("\n"));
    if (existsSync(`${file}.map`))
      tm = { map: new SourceMap(JSON.parse(readFileSync(`${file}.map`, "utf8"))), dir: dirname(file) };
  } catch { tm = null; }
  maps.set(url, tm); return tm;
}
let totalTicks = 0;
for (const n of profile.nodes) for (const t of n.positionTicks ?? []) totalTicks += t.ticks;
const buckets = new Map();
let fnTicks = 0;
for (const n of profile.nodes) {
  const cf = n.callFrame;
  if (!(cf.functionName ?? "").includes(fnFilter)) continue;
  const tm = load(cf.url ?? "");
  for (const t of n.positionTicks ?? []) {
    fnTicks += t.ticks;
    const text = (src.get(cf.url)?.[t.line - 1] ?? "").trim().slice(0, 110);
    let orig = "";
    if (tm) {
      const e = tm.map.findEntry(t.line - 1, 0);
      if (e && e.originalSource != null) orig = `${e.originalSource.replace(/^.*\/(src|benchmarks)\//, "$1/")}:${(e.originalLine ?? 0) + 1}`;
    }
    const key = `gen:${t.line}\t${orig}\t${text}`;
    buckets.set(key, (buckets.get(key) ?? 0) + t.ticks);
  }
}
console.log(`# ${profilePath} — "${fnFilter}" : ${fnTicks} of ${totalTicks} ticks (${((fnTicks/totalTicks)*100).toFixed(2)}%)`);
for (const [k, v] of [...buckets].sort((a, b) => b[1] - a[1]).slice(0, top)) {
  const [g, o, text] = k.split("\t");
  console.log(`${String(v).padStart(7)} ${((v/fnTicks)*100).toFixed(2).padStart(6)}%fn ${((v/totalTicks)*100).toFixed(2).padStart(6)}%prof  ${g}  ${o}\n          | ${text}`);
}
