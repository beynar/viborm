// INDEPENDENT reachability: build a real ts.Program from the tsdown entry points
// and take program.getSourceFiles() as the reachable set. Module resolution is
// TypeScript's own (moduleResolution: bundler + tsconfig paths), so type-only
// imports and import("...") type nodes are followed exactly as tsc follows them.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createRequire } from "node:module";

const ROOT = process.argv[2];
const EXTRA_SEED_DIR = process.argv[3] || null; // e.g. src/query-engine/pattern
const require = createRequire(join(ROOT, "package.json"));
const ts = require("typescript");

const cfgPath = join(ROOT, "tsconfig.json");
const cfgFile = ts.readConfigFile(cfgPath, ts.sys.readFile);
if (cfgFile.error) throw new Error(ts.flattenDiagnosticMessageText(cfgFile.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(cfgFile.config, ts.sys, ROOT);
const options = { ...parsed.options, noEmit: true, types: [] };

// tsdown entries
const tsdown = readFileSync(join(ROOT, "tsdown.config.ts"), "utf8");
const entryBlock = tsdown.slice(tsdown.indexOf("entry: {"), tsdown.indexOf("format:"));
const entries = [];
for (const m of entryBlock.matchAll(/^\s*"?([\w./@-]+)"?\s*:\s*"(\.\/[^"]+)",?\s*$/gm)) {
  entries.push(resolve(ROOT, m[2]));
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const allSrc = walk(join(ROOT, "src")).map((p) => relative(ROOT, p)).sort();

const seeds = [...entries];
if (EXTRA_SEED_DIR) {
  for (const f of walk(join(ROOT, EXTRA_SEED_DIR))) seeds.push(f);
}

const program = ts.createProgram(seeds, options);
const reachable = new Set();
for (const sf of program.getSourceFiles()) {
  const rel = relative(ROOT, sf.fileName);
  if (rel.startsWith("src/")) reachable.add(rel);
}

const unreachable = allSrc.filter((f) => !reachable.has(f));
console.log(JSON.stringify({
  root: ROOT,
  extraSeedDir: EXTRA_SEED_DIR,
  entryCount: entries.length,
  entries: entries.map((e) => relative(ROOT, e)).sort(),
  srcFileCount: allSrc.length,
  reachableCount: reachable.size,
  reachable: [...reachable].sort(),
  unreachableCount: unreachable.length,
  unreachable,
}, null, 2));
