// Import-graph reachability from the tsdown entry points.
// Method of g4/cutover/note.md §1.2 and cutover/receipts-stage2/pattern-retained-owners.json:
// resolve every import edge (tsconfig `paths`, relative, `.js`->`.ts`) from the
// tsdown.config.ts entries, with and without every file under src/query-engine/pattern/
// as an extra seed.
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { dirname, resolve, relative, join } from "node:path";

const ROOT = "/Users/arnaud/code/viborm";

// --- tsconfig paths ---
const tsconfigRaw = readFileSync(join(ROOT, "tsconfig.json"), "utf8");
const tsconfig = JSON.parse(tsconfigRaw.replace(/^\s*\/\/.*$/gm, ""));
const PATHS = tsconfig.compilerOptions.paths;

// --- tsdown entries ---
const tsdown = readFileSync(join(ROOT, "tsdown.config.ts"), "utf8");
const entryBlock = tsdown.slice(tsdown.indexOf("entry: {"), tsdown.indexOf("format:"));
const ENTRIES = [];
for (const m of entryBlock.matchAll(/"?([\w./@-]+)"?\s*:\s*"(\.\/[^"]+)"/g)) {
  ENTRIES.push(resolve(ROOT, m[2]));
}

function tryFile(p) {
  const candidates = [p, p + ".ts", p + ".tsx", p + ".d.ts", join(p, "index.ts")];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

function resolveSpecifier(spec, fromFile) {
  if (spec.startsWith(".")) {
    let base = resolve(dirname(fromFile), spec);
    if (base.endsWith(".js")) {
      const t = tryFile(base.slice(0, -3));
      if (t) return t;
    }
    return tryFile(base);
  }
  // tsconfig paths
  for (const [key, targets] of Object.entries(PATHS)) {
    if (key.endsWith("/*")) {
      const prefix = key.slice(0, -1); // keep trailing slash
      if (spec.startsWith(prefix)) {
        const rest = spec.slice(prefix.length);
        for (const t of targets) {
          let base = resolve(ROOT, t.replace("/*", "/" + rest));
          if (base.endsWith(".js")) {
            const f = tryFile(base.slice(0, -3));
            if (f) return f;
          }
          const f = tryFile(base);
          if (f) return f;
        }
      }
    } else if (spec === key) {
      for (const t of targets) {
        const f = tryFile(resolve(ROOT, t));
        if (f) return f;
      }
    }
  }
  return null; // bare package specifier / unresolved
}

const IMPORT_RE =
  /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\sfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s*\(\s*\/\*[^*]*\*\/\s*["']([^"']+)["']\s*\)/g;

const edgeCache = new Map();
const unresolvedLocal = new Map();
function edges(file) {
  if (edgeCache.has(file)) return edgeCache.get(file);
  let src;
  try { src = readFileSync(file, "utf8"); } catch { edgeCache.set(file, []); return []; }
  // strip block+line comments conservatively for import scanning, but keep
  // import("...") inside type positions (they are code, not comments).
  const out = new Set();
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => (m.includes("import(") ? m : " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const m of stripped.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec) continue;
    const r = resolveSpecifier(spec, file);
    if (r) out.add(r);
    else if (spec.startsWith(".") || spec.startsWith("@")) {
      const known = Object.keys(PATHS).some((k) =>
        k.endsWith("/*") ? spec.startsWith(k.slice(0, -1)) : spec === k
      );
      if (spec.startsWith(".") || known) {
        if (!unresolvedLocal.has(file)) unresolvedLocal.set(file, []);
        unresolvedLocal.get(file).push(spec);
      }
    }
  }
  // type-only `import("...")` in type positions
  for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
    const r = resolveSpecifier(m[1], file);
    if (r) out.add(r);
  }
  const arr = [...out];
  edgeCache.set(file, arr);
  return arr;
}

function reach(seeds) {
  const seen = new Set();
  const stack = [...seeds];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const e of edges(f)) if (!seen.has(e)) stack.push(e);
  }
  return seen;
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (p.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

const PATTERN_DIR = join(ROOT, "src/query-engine/pattern");
const patternFiles = existsSync(PATTERN_DIR) ? walk(PATTERN_DIR) : [];
const allSrc = walk(join(ROOT, "src"));

const withoutPattern = reach(ENTRIES);
const withPattern = reach([...ENTRIES, ...patternFiles]);

const rel = (p) => relative(ROOT, p);
const lineCount = (p) => readFileSync(p, "utf8").split("\n").length;

const onlyViaPattern = [...withPattern]
  .filter((f) => !withoutPattern.has(f) && !f.startsWith(PATTERN_DIR + "/"))
  .sort();

const unreachableSrc = allSrc
  .filter((f) => !withPattern.has(f))
  .sort();

const result = {
  method:
    "import-graph reachability from the tsdown entry points, with and without the pattern/ experiment as an extra seed",
  base: process.env.BASE_SHA ?? null,
  entries: ENTRIES.length,
  entryFiles: ENTRIES.map(rel).sort(),
  reachableFromEntries: [...withoutPattern].filter((f) => f.startsWith(join(ROOT, "src") + "/")).length,
  reachableFromEntriesAllFiles: withoutPattern.size,
  reachableWithPattern: [...withPattern].filter((f) => f.startsWith(join(ROOT, "src") + "/")).length,
  reachableWithPatternAllFiles: withPattern.size,
  patternFiles: patternFiles.length,
  patternLines: patternFiles.reduce((a, f) => a + lineCount(f), 0),
  patternFileList: patternFiles.map((f) => ({ file: rel(f), lines: lineCount(f) })).sort((a, b) => a.file.localeCompare(b.file)),
  retainedOnlyViaPattern: onlyViaPattern.map(rel),
  retainedOnlyViaPatternDetail: onlyViaPattern.map((f) => ({ file: rel(f), lines: lineCount(f) })),
  retainedOnlyViaPatternLines: onlyViaPattern.reduce((a, f) => a + lineCount(f), 0),
  srcFilesOnDisk: allSrc.length,
  unreachableFromAnySeed: unreachableSrc.map((f) => ({ file: rel(f), lines: lineCount(f) })),
  unresolvedLocalSpecifiers: [...unresolvedLocal.entries()].map(([f, specs]) => ({ file: rel(f), specs })),
};

console.log(JSON.stringify(result, null, 1));
