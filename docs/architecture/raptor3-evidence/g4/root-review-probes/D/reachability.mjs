// Bounded runtime-import reachability from the candidate's entry files, using
// the census script's own runtime-import rules (type-only imports excluded).
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dirname, "../../../../../..");
const ALIASES = {
  "@src/": "src/", "@schema/": "src/schema/", "@client/": "src/client/",
  "@extensions/": "src/extensions/", "@validation/": "src/validation/",
  "@query-engine/": "src/query-engine/", "@adapters/": "src/adapters/",
  "@drivers/": "src/drivers/", "@migrations/": "src/migrations/",
  "@instrumentation/": "src/instrumentation/", "@cache/": "src/cache/",
};
const EXACT = {
  "@schema": "src/schema/index.ts", "@client": "src/client/index.ts",
  "@extensions": "src/extensions/index.ts", "@validation": "src/validation/index.ts",
  "@adapters": "src/adapters/index.ts", "@drivers": "src/drivers/index.ts",
  "@sql": "src/sql/sql.ts", "@migrations": "src/migrations/index.ts",
  "@standard-schema": "src/standardSchema.ts", "@errors": "src/errors.ts",
  "@instrumentation": "src/instrumentation/index.ts", "@cache": "src/cache/index.ts",
};

function hasRuntimeImport(importClause) {
  if (!importClause) return true;
  if (importClause.isTypeOnly) return false;
  if (importClause.name || !importClause.namedBindings) return true;
  if (ts.isNamespaceImport(importClause.namedBindings)) return true;
  return importClause.namedBindings.elements.some((e) => !e.isTypeOnly);
}

function resolveSpecifier(fromFile, spec) {
  let rel;
  if (spec.startsWith(".")) rel = resolve(dirname(fromFile), spec);
  else if (EXACT[spec]) rel = resolve(ROOT, EXACT[spec]);
  else {
    const alias = Object.keys(ALIASES).find((a) => spec.startsWith(a));
    if (!alias) return undefined;
    rel = resolve(ROOT, ALIASES[alias] + spec.slice(alias.length));
  }
  for (const cand of [`${rel}.ts`, `${rel}/index.ts`, rel]) {
    if (existsSync(cand) && cand.endsWith(".ts")) return cand;
  }
  return undefined;
}

const LEAVES = new Set(["src/client/client.ts","src/query-engine/pending-operation.ts","src/query-engine/query-engine.ts"].map((f) => resolve(ROOT, f)));
const seed = [
  "src/query-engine/raptor3/commands/index.ts",
  "src/query-engine/raptor3/route/client-route.ts",
  "src/query-engine/raptor3/program/index.ts",
].map((f) => resolve(ROOT, f));

const seen = new Set(seed);
const queue = [...seed];
while (queue.length) {
  const file = queue.pop();
  if (LEAVES.has(file)) continue;
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    let moduleName;
    if (ts.isImportDeclaration(node)) {
      if (hasRuntimeImport(node.importClause) && ts.isStringLiteral(node.moduleSpecifier))
        moduleName = node.moduleSpecifier.text;
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const allType = node.exportClause && ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.every((e) => e.isTypeOnly);
        if (!allType) moduleName = node.moduleSpecifier.text;
      }
    }
    if (moduleName) {
      const target = resolveSpecifier(file, moduleName);
      if (target && !seen.has(target)) { seen.add(target); queue.push(target); }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const rel = [...seen].map((f) => f.slice(ROOT.length + 1)).sort();
const g3 = JSON.parse(readFileSync(resolve(ROOT, "docs/architecture/raptor3-evidence/g3/structure-correction/qualified-final/support/source-cost.json"), "utf8"));
const charged = new Set(g3.privateCandidates.candidates.commands.files);
const classification = new Map(g3.files.map((r) => [r.file, r.classification]));
const tokenLines = new Map(g3.files.map((r) => [r.file, r.tokenLines]));

const reachedNotCharged = rel.filter((f) => !charged.has(f) && !f.startsWith("src/query-engine/raptor3/"));
const chargedNotReached = [...charged].filter((f) => !seen.has(resolve(ROOT, f)));

console.log(JSON.stringify({
  reachedFiles: rel.length,
  reachedEngineOwnersNotInG3Perimeter: reachedNotCharged
    .filter((f) => (classification.get(f) ?? "").startsWith("charged"))
    .map((f) => ({ file: f, classification: classification.get(f), g3TokenLines: tokenLines.get(f) })),
  reachedExcludedBoundaries: reachedNotCharged.filter((f) => (classification.get(f) ?? "excluded").startsWith("excluded")).length,
  g3ChargedFilesNoLongerReached: chargedNotReached.map((f) => ({ file: f, classification: classification.get(f), g3TokenLines: tokenLines.get(f) })),
}, null, 2));
