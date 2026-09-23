// Does any candidate file enter the three frozen bundle fixtures' runtime
// module graphs? Uses the census script's own runtime-import rules
// (type-only imports excluded), the same rule rolldown's treeshake applies.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
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
const hasRuntimeImport = (c) => {
  if (!c) return true;
  if (c.isTypeOnly) return false;
  if (c.name || !c.namedBindings) return true;
  if (ts.isNamespaceImport(c.namedBindings)) return true;
  return c.namedBindings.elements.some((e) => !e.isTypeOnly);
};
function resolveSpecifier(from, spec) {
  let base;
  if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else if (EXACT[spec]) base = resolve(ROOT, EXACT[spec]);
  else {
    const a = Object.keys(ALIASES).find((x) => spec.startsWith(x));
    if (!a) return undefined;
    base = resolve(ROOT, ALIASES[a] + spec.slice(a.length));
  }
  for (const c of [`${base}.ts`, `${base}/index.ts`, base])
    if (existsSync(c) && c.endsWith(".ts")) return c;
  return undefined;
}
function reach(entries) {
  const seen = new Set(entries);
  const parents = new Map();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop();
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      let m;
      if (ts.isImportDeclaration(node)) {
        if (hasRuntimeImport(node.importClause) && ts.isStringLiteral(node.moduleSpecifier))
          m = node.moduleSpecifier.text;
      } else if (ts.isExportDeclaration(node)) {
        if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const allType = node.exportClause && ts.isNamedExports(node.exportClause) &&
            node.exportClause.elements.every((e) => e.isTypeOnly);
          if (!allType) m = node.moduleSpecifier.text;
        }
      }
      if (m) {
        const t = resolveSpecifier(file, m);
        if (t && !seen.has(t)) { seen.add(t); parents.set(t, file); queue.push(t); }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { seen, parents };
}
const fixtures = {
  engine: ["src/query-engine/query-engine.ts", "src/query-engine/pending-operation.ts"],
  "pg-simple": ["src/index.ts", "src/drivers/pg/index.ts"],
  "pg-relations": ["src/index.ts", "src/drivers/pg/index.ts"],
};
const out = {};
for (const [name, entries] of Object.entries(fixtures)) {
  const { seen, parents } = reach(entries.map((e) => resolve(ROOT, e)));
  const candidate = [...seen]
    .map((f) => relative(ROOT, f))
    .filter((f) => f.startsWith("src/query-engine/raptor3/"))
    .sort();
  out[name] = {
    modulesReached: seen.size,
    candidateModulesReached: candidate,
    firstImporter: candidate.map((f) => relative(ROOT, parents.get(resolve(ROOT, f)) ?? "")),
  };
}
console.log(JSON.stringify(out, null, 2));
