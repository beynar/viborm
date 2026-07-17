import { readFileSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import ts from "typescript";

const RUNTIME_FILE = /^Operation.*Runtime\.ts$/;
const RUNTIME_DATA_MODULES = new Set([
  "execution-context.ts",
  "operation-program.ts",
]);

export function findRuntimeBoundaryOffenders(
  files: readonly string[],
  queryEngine: string
): string[] {
  return files.flatMap((file) =>
    findForbiddenRuntimeImports(
      readFileSync(file, "utf8"),
      file,
      queryEngine
    ).map((moduleName) => `${relative(queryEngine, file)} -> ${moduleName}`)
  );
}

export function findForbiddenRuntimeImports(
  source: string,
  importer: string,
  queryEngine: string
): string[] {
  return runtimeImportedModules(source).filter((moduleName) => {
    const target = resolveInternalModule(importer, moduleName, queryEngine);
    if (target === undefined) return isInternalModule(moduleName);
    return !isRuntimeDependency(target, queryEngine);
  });
}

export function findRuntimeImportCycles(
  files: readonly string[],
  queryEngine: string
): string[][] {
  const fileSet = new Set(files);
  const graph = new Map(
    files.map((file) => [
      file,
      runtimeImportedModules(readFileSync(file, "utf8")).flatMap(
        (moduleName) => {
          const target = resolveInternalModule(file, moduleName, queryEngine);
          return target && fileSet.has(target) ? [target] : [];
        }
      ),
    ])
  );
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const path: string[] = [];
  const cycles: string[][] = [];

  const visit = (file: string): void => {
    if (visiting.has(file)) {
      const start = path.indexOf(file);
      cycles.push(
        [...path.slice(start), file].map((entry) =>
          relative(queryEngine, entry)
        )
      );
      return;
    }
    if (visited.has(file)) return;
    visiting.add(file);
    path.push(file);
    for (const dependency of graph.get(file) ?? []) visit(dependency);
    path.pop();
    visiting.delete(file);
    visited.add(file);
  };

  for (const file of files) visit(file);
  return cycles;
}

function runtimeImportedModules(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "source.ts",
    source,
    ts.ScriptTarget.Latest,
    true
  );
  const modules: string[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      importHasRuntimeValue(node)
    ) {
      modules.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      exportHasRuntimeValue(node)
    ) {
      modules.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) {
        modules.push(argument.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return modules;
}

function importHasRuntimeValue(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  const bindings = clause.namedBindings;
  if (!bindings || ts.isNamespaceImport(bindings)) return Boolean(bindings);
  return (
    bindings.elements.length === 0 ||
    bindings.elements.some((element) => !element.isTypeOnly)
  );
}

function exportHasRuntimeValue(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false;
  const clause = node.exportClause;
  if (!clause || ts.isNamespaceExport(clause)) return true;
  return (
    clause.elements.length === 0 ||
    clause.elements.some((element) => !element.isTypeOnly)
  );
}

function resolveInternalModule(
  importer: string,
  moduleName: string,
  queryEngine: string
): string | undefined {
  let candidate: string;
  if (moduleName.startsWith(".")) {
    candidate = resolve(dirname(importer), moduleName);
  } else if (moduleName === "@query-engine") {
    candidate = join(queryEngine, "index");
  } else if (moduleName.startsWith("@query-engine/")) {
    candidate = join(queryEngine, moduleName.slice("@query-engine/".length));
  } else {
    return undefined;
  }

  return [candidate, `${candidate}.ts`, join(candidate, "index.ts")].find(
    isFile
  );
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isInternalModule(moduleName: string): boolean {
  return (
    moduleName.startsWith(".") ||
    moduleName === "@query-engine" ||
    moduleName.startsWith("@query-engine/")
  );
}

function isRuntimeDependency(target: string, queryEngine: string): boolean {
  const runtimeRelative = relative(join(queryEngine, "runtime"), target);
  const isRuntimeDirectoryFile =
    runtimeRelative !== "" &&
    !runtimeRelative.startsWith("..") &&
    !isAbsolute(runtimeRelative);
  return (
    isRuntimeDirectoryFile ||
    RUNTIME_FILE.test(basename(target)) ||
    RUNTIME_DATA_MODULES.has(relative(queryEngine, target))
  );
}
