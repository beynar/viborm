import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { dirname, resolve, relative, join } from "node:path";
const ROOT = "/Users/arnaud/code/viborm";
const tsconfig = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
const PATHS = tsconfig.compilerOptions.paths;
function tryFile(p) { for (const c of [p, p + ".ts", p + ".tsx", p + ".d.ts", join(p, "index.ts")]) if (existsSync(c) && statSync(c).isFile()) return c; return null; }
function resolveSpecifier(spec, fromFile) {
  if (spec.startsWith(".")) { const base = resolve(dirname(fromFile), spec);
    if (base.endsWith(".js")) { const t = tryFile(base.slice(0, -3)); if (t) return t; } return tryFile(base); }
  for (const [key, targets] of Object.entries(PATHS)) {
    if (key.endsWith("/*")) { const prefix = key.slice(0, -1);
      if (spec.startsWith(prefix)) { const rest = spec.slice(prefix.length);
        for (const t of targets) { const base = resolve(ROOT, t.replace("/*", "/" + rest));
          if (base.endsWith(".js")) { const f = tryFile(base.slice(0, -3)); if (f) return f; }
          const f = tryFile(base); if (f) return f; } } }
    else if (spec === key) { for (const t of targets) { const f = tryFile(resolve(ROOT, t)); if (f) return f; } }
  } return null;
}
const IMPORT_RE = /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\sfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const cache = new Map();
function edges(file) {
  if (cache.has(file)) return cache.get(file);
  let src; try { src = readFileSync(file, "utf8"); } catch { cache.set(file, []); return []; }
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, (m) => (m.includes("import(") ? m : " ")).replace(/(^|[^:])\/\/.*$/gm, "$1");
  const out = new Set();
  for (const m of stripped.matchAll(IMPORT_RE)) { const s = m[1] ?? m[2]; if (!s) continue; const r = resolveSpecifier(s, file); if (r) out.add(r); }
  for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) { const r = resolveSpecifier(m[1], file); if (r) out.add(r); }
  const a = [...out]; cache.set(file, a); return a;
}
function walk(dir, acc = []) { if (!existsSync(dir)) return acc;
  for (const n of readdirSync(dir)) { const p = join(dir, n); const s = statSync(p);
    if (s.isDirectory()) walk(p, acc); else if (/\.(ts|tsx)$/.test(p)) acc.push(p); } return acc; }
const A = (p) => resolve(ROOT, p);
const deleted = new Set(JSON.parse(readFileSync(process.env.DELETED, "utf8")).map(A));
// Harness files that will be PRUNED (edge to a deleted owner removed by hand) rather than deleted.
const PRUNED = new Map([
  [A("tests/fixtures/query-scope.ts"), new Set([A("src/query-engine/result/ResultParser.ts")])],
  [A("tests/contracts/drivers/transaction-lifecycle.core.test.ts"), new Set([A("src/query-engine/skippable-write.ts")])],
  [A("tests/contracts/public-client/errors/prisma-codes.test.ts"), new Set([A("src/query-engine/write-engine/shared.ts")])],
  [A("tests/contracts/public-client/errors/failure-classification.test.ts"), new Set([A("src/query-engine/write-engine/race-retry.ts")])],
]);
const harness = [...walk(join(ROOT, "tests")), ...walk(join(ROOT, "benchmarks"))];
const hit = new Set();
let changed = true;
while (changed) { changed = false;
  for (const f of harness) { if (hit.has(f)) continue;
    const pruned = PRUNED.get(f);
    for (const e of edges(f)) { if (pruned?.has(e)) continue;
      if (deleted.has(e) || hit.has(e)) { hit.add(f); changed = true; break; } } } }
const rel = (p) => relative(ROOT, p);
const wc = (p) => { const s = readFileSync(p, "utf8"); const n = s.split("\n").length; return s.endsWith("\n") ? n - 1 : n; };
const list = [...hit].sort().map((f) => ({ file: rel(f), lines: wc(f) }));
console.log(JSON.stringify({ count: list.length, lines: list.reduce((a, x) => a + x.lines, 0), files: list }, null, 1));
