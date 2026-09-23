// Reverse-import index over src/ + tests/ + benchmarks/ + scripts-referenced files.
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { dirname, resolve, relative, join } from "node:path";
const ROOT = "/Users/arnaud/code/viborm";
const tsconfig = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
const PATHS = tsconfig.compilerOptions.paths;
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
    } else if (spec === key) {
      for (const t of targets) { const f = tryFile(resolve(ROOT, t)); if (f) return f; }
    }
  }
  return null;
}
const IMPORT_RE = /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\sfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name); const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(p)) acc.push(p);
  }
  return acc;
}
const files = [
  ...walk(join(ROOT, "src")),
  ...walk(join(ROOT, "tests")),
  ...walk(join(ROOT, "benchmarks")),
  ...walk(join(ROOT, "scripts")),
];
const rel = (p) => relative(ROOT, p);
const importers = new Map(); // target -> [{from, spec}]
for (const f of files) {
  let src; try { src = readFileSync(f, "utf8"); } catch { continue; }
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, (m) => (m.includes("import(") ? m : " "))
                      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const specs = new Set();
  for (const m of stripped.matchAll(IMPORT_RE)) { const s = m[1] ?? m[2]; if (s) specs.add(s); }
  for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) specs.add(m[1]);
  for (const s of specs) {
    const t = resolveSpecifier(s, f);
    if (!t) continue;
    if (!importers.has(t)) importers.set(t, []);
    importers.get(t).push({ from: rel(f), spec: s });
  }
}
const targets = process.argv.slice(2);
if (targets.length === 0) {
  const out = {};
  for (const [t, v] of importers) out[rel(t)] = v.map((x) => x.from).sort();
  console.log(JSON.stringify(out, null, 1));
} else {
  for (const t of targets) {
    const abs = resolve(ROOT, t);
    const v = importers.get(abs) ?? [];
    console.log(`${t}  <-  ${v.length} importer(s)`);
    for (const x of [...v].sort((a,b)=>a.from.localeCompare(b.from))) console.log(`    ${x.from}   (${x.spec})`);
  }
}
