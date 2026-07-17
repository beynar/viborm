import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const RESULT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/query-engine/result"
);

function getRuntimeResultImports(fileName: string): string[] {
  const source = ts.createSourceFile(
    fileName,
    readFileSync(join(RESULT_DIR, fileName), "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const imports: string[] = [];

  for (const statement of source.statements) {
    const moduleName = getRuntimeModuleName(statement);
    if (!moduleName?.startsWith("./")) {
      continue;
    }
    imports.push(`${moduleName.slice(2)}.ts`);
  }
  return imports;
}

function getRuntimeModuleName(statement: ts.Statement): string | undefined {
  if (ts.isImportDeclaration(statement)) {
    if (!isRuntimeImport(statement.importClause)) return undefined;
    return ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : undefined;
  }
  if (ts.isExportDeclaration(statement)) {
    if (statement.isTypeOnly || !statement.moduleSpecifier) return undefined;
    if (
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.every((element) => element.isTypeOnly)
    ) {
      return undefined;
    }
    return ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : undefined;
  }
  return undefined;
}

function isRuntimeImport(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name || !clause.namedBindings) return true;
  if (ts.isNamespaceImport(clause.namedBindings)) return true;
  return clause.namedBindings.elements.some((element) => !element.isTypeOnly);
}

function findRuntimeCycles(
  graph: ReadonlyMap<string, readonly string[]>
): string[][] {
  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (fileName: string): void => {
    if (visiting.has(fileName)) {
      const cycleStart = path.indexOf(fileName);
      cycles.push([...path.slice(cycleStart), fileName]);
      return;
    }
    if (visited.has(fileName)) return;
    visiting.add(fileName);
    path.push(fileName);
    for (const dependency of graph.get(fileName) ?? []) visit(dependency);
    path.pop();
    visiting.delete(fileName);
    visited.add(fileName);
  };

  for (const fileName of graph.keys()) visit(fileName);
  return cycles;
}

describe("result parser module architecture", () => {
  it("contains no runtime import cycle among parser modules", () => {
    const fileNames = readdirSync(RESULT_DIR).filter((fileName) =>
      fileName.endsWith(".ts")
    );
    const graph = new Map(
      fileNames.map((fileName) => [fileName, getRuntimeResultImports(fileName)])
    );

    expect(findRuntimeCycles(graph)).toEqual([]);
  });

  it.each([
    {
      loaders: [
        () => import("../../src/query-engine/result/scalar-result-parser"),
        () => import("../../src/query-engine/result/scalar-structured-parser"),
        () => import("../../src/query-engine/result/ResultParser"),
        () => import("../../src/query-engine/result/result-row-parser"),
      ],
    },
    {
      loaders: [
        () => import("../../src/query-engine/result/result-row-parser"),
        () => import("../../src/query-engine/result/relation-result-parser"),
        () => import("../../src/query-engine/result/result-aggregate-parser"),
        () => import("../../src/query-engine/result/ResultParser"),
      ],
    },
    {
      loaders: [
        () => import("../../src/query-engine/result/ResultParser"),
        () => import("../../src/query-engine/result/result-aggregate-parser"),
        () => import("../../src/query-engine/result/relation-result-parser"),
        () => import("../../src/query-engine/result/result-row-parser"),
      ],
    },
  ])("loads result parser modules in order %#", async ({ loaders }) => {
    vi.resetModules();
    for (const load of loaders) {
      await expect(load()).resolves.toBeDefined();
    }
  });
});
