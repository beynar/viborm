// Deletion closure: entry reachability in the rewired graph.
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { dirname, resolve, relative, join } from "node:path";
const ROOT = "/Users/arnaud/code/viborm";
const tsconfig = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
const PATHS = tsconfig.compilerOptions.paths;
const tsdown = readFileSync(join(ROOT, "tsdown.config.ts"), "utf8");
const entryBlock = tsdown.slice(tsdown.indexOf("entry: {"), tsdown.indexOf("format:"));
const ENTRIES = [...entryBlock.matchAll(/"?([\w./@-]+)"?\s*:\s*"(\.\/[^"]+)"/g)].map((m) => resolve(ROOT, m[2]));
function tryFile(p) {
  for (const c of [p, p + ".ts", p + ".tsx", p + ".d.ts", join(p, "index.ts")])
    if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}
function resolveSpecifier(spec, fromFile) {
  if (spec.startsWith(".")) {
    const base = resolve(dirname(fromFile), spec);
    if (base.endsWith(".js")) { const t = tryFile(base.slice(0, -3)); if (t) return t; }
    return tryFile(base);
  }
  for (const [key, targets] of Object.entries(PATHS)) {
    if (key.endsWith("/*")) {
      const prefix = key.slice(0, -1);
      if (spec.startsWith(prefix)) {
        const rest = spec.slice(prefix.length);
        for (const t of targets) {
          const base = resolve(ROOT, t.replace("/*", "/" + rest));
          if (base.endsWith(".js")) { const f = tryFile(base.slice(0, -3)); if (f) return f; }
          const f = tryFile(base); if (f) return f;
        }
      }
    } else if (spec === key) { for (const t of targets) { const f = tryFile(resolve(ROOT, t)); if (f) return f; } }
  }
  return null;
}
const IMPORT_RE = /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\sfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const cache = new Map();
function edges(file) {
  if (cache.has(file)) return cache.get(file);
  let src; try { src = readFileSync(file, "utf8"); } catch { cache.set(file, []); return []; }
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, (m) => (m.includes("import(") ? m : " "))
                      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const out = new Set();
  for (const m of stripped.matchAll(IMPORT_RE)) { const s = m[1] ?? m[2]; if (!s) continue; const r = resolveSpecifier(s, file); if (r) out.add(r); }
  for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) { const r = resolveSpecifier(m[1], file); if (r) out.add(r); }
  const a = [...out]; cache.set(file, a); return a;
}
function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const n of readdirSync(dir)) { const p = join(dir, n); const s = statSync(p);
    if (s.isDirectory()) walk(p, acc); else if (p.endsWith(".ts")) acc.push(p); }
  return acc;
}
const A = (p) => resolve(ROOT, p);
const PATTERN = join(ROOT, "src/query-engine/pattern");
const REMOVED_NODES = new Set(walk(PATTERN));
// Rewired edges: the type anchor relocation cuts these three edges to OperationFragment.
const OF = A("src/query-engine/write-engine/OperationFragment.ts");
const CUT = new Map([
  [A("src/query-engine/types.ts"), new Set([OF])],
  [A("src/query-engine/batch-error-attribution.ts"), new Set([OF])],
  [A("src/query-engine/unique-conflict-target.ts"), new Set([OF])],
]);
function reach(seeds) {
  const seen = new Set(); const st = [...seeds];
  while (st.length) {
    const f = st.pop();
    if (seen.has(f) || REMOVED_NODES.has(f)) continue;
    seen.add(f);
    const cut = CUT.get(f);
    for (const e of edges(f)) { if (REMOVED_NODES.has(e)) continue; if (cut?.has(e)) continue; if (!seen.has(e)) st.push(e); }
  }
  return seen;
}
const allSrc = walk(join(ROOT, "src"));
const after = reach(ENTRIES);
const rel = (p) => relative(ROOT, p);
const wcLines = (p) => { const s = readFileSync(p, "utf8"); const n = s.split("\n").length; return s.endsWith("\n") ? n - 1 : n; };
// Pre-existing unreachable (before any change), so we do not blame this unit for them.
const PRE_UNREACH = new Set(JSON.parse(readFileSync(process.env.REACH1, "utf8")).unreachableFromAnySeed.map((d) => A(d.file)));
const newlyDead = allSrc.filter((f) => !after.has(f) && !REMOVED_NODES.has(f) && !PRE_UNREACH.has(f)).sort();
console.log(JSON.stringify({
  patternFiles: [...REMOVED_NODES].sort().map((f) => ({ file: rel(f), lines: wcLines(f) })),
  patternLines: [...REMOVED_NODES].reduce((a, f) => a + wcLines(f), 0),
  newlyDead: newlyDead.map((f) => ({ file: rel(f), lines: wcLines(f) })),
  newlyDeadLines: newlyDead.reduce((a, f) => a + wcLines(f), 0),
  survivingSrcFiles: allSrc.filter((f) => after.has(f)).length,
  preExistingUnreachable: [...PRE_UNREACH].map(rel).sort(),
}, null, 1));
