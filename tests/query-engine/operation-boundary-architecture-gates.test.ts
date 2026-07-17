import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  findRuntimeBoundaryOffenders,
  findRuntimeImportCycles,
} from "./runtime-import-boundary";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const QUERY_ENGINE = join(ROOT, "src/query-engine");
const BUILDERS = join(QUERY_ENGINE, "builders");
const RESULTS = join(QUERY_ENGINE, "result");
const COMPILER_OWNER =
  /^(?:OperationCompiler|WriteOperations|WritePrograms|MutationStatements|Relation.*|ManyToMany.*|OwnWrite.*|Target.*|ToOne.*)\.ts$/;
const RUNTIME_FILE = /^Operation.*Runtime\.ts$/;
const RETIRED_RUNTIME =
  /(?:LiveMode|PlannedMode|selectMode|NestedWriteEffect|NestedWriteProbe)/;
const BUILDER_CAPABILITY_ACCESS =
  /\b(?:ctx|scope)\.(?:driver|registry|schemaRegistry)\b|\bResultParser\b/;
const OPERATION_RUNTIME_IMPORT = /Operation.*Runtime/;
const RESULT_OWNER_IMPORT =
  /(?:OperationCompiler|Operation.*Runtime|RelationMutations|WriteOperations)/;

function listTypeScriptFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? listTypeScriptFiles(path) : [path];
    })
    .filter((path) => path.endsWith(".ts"));
}

function imports(source: string): string[] {
  const file = ts.createSourceFile(
    "source.ts",
    source,
    ts.ScriptTarget.Latest,
    true
  );
  const modules: string[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      modules.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return modules;
}

function queryScopeFields(): string[] {
  const source = readFileSync(join(QUERY_ENGINE, "types.ts"), "utf8");
  const file = ts.createSourceFile(
    "types.ts",
    source,
    ts.ScriptTarget.Latest,
    true
  );
  const declaration = file.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === "QueryScope"
  );
  if (!declaration) return [];
  return declaration.members.flatMap((member) => {
    if (!(ts.isPropertySignature(member) && member.name)) return [];
    return ts.isIdentifier(member.name) ? [member.name.text] : [];
  });
}

describe("operation-program target boundaries", () => {
  it("removes the nested-write execution subsystem and compatibility routes", () => {
    for (const path of [
      "operations/nested-writes",
      "builders/nested-write-detector.ts",
      "executor.ts",
      "transaction-flow.ts",
      "operation-preparation.ts",
    ]) {
      expect(existsSync(join(QUERY_ENGINE, path)), path).toBe(false);
    }

    const source = listTypeScriptFiles(QUERY_ENGINE)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(source).not.toContain("QueryContext");
    expect(source).not.toContain("hasNestedWrites");
    expect(source).not.toMatch(RETIRED_RUNTIME);
  });

  it("keeps QueryScope limited to SQL-construction state", () => {
    expect(queryScopeFields().sort()).toEqual([
      "adapter",
      "model",
      "mutationTable",
      "nextAlias",
      "rootAlias",
    ]);

    const builderSource = listTypeScriptFiles(BUILDERS)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    const resultSource = listTypeScriptFiles(RESULTS)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(builderSource).not.toMatch(BUILDER_CAPABILITY_ACCESS);
    expect(resultSource).not.toContain("QueryScope");
  });

  it("keeps runtime value imports inside runtime, program, and driver contracts", () => {
    const runtimeFiles = listTypeScriptFiles(QUERY_ENGINE).filter((file) =>
      RUNTIME_FILE.test(basename(file))
    );
    expect(findRuntimeBoundaryOffenders(runtimeFiles, QUERY_ENGINE)).toEqual(
      []
    );
  });

  it("keeps query-engine runtime imports acyclic", () => {
    expect(
      findRuntimeImportCycles(listTypeScriptFiles(QUERY_ENGINE), QUERY_ENGINE)
    ).toEqual([]);
  });

  it("prevents compiler owners from importing concrete runtimes", () => {
    const offenders = listTypeScriptFiles(QUERY_ENGINE)
      .filter((file) => COMPILER_OWNER.test(basename(file)))
      .flatMap((file) =>
        imports(readFileSync(file, "utf8"))
          .filter((moduleName) => OPERATION_RUNTIME_IMPORT.test(moduleName))
          .map(
            (moduleName) => `${relative(QUERY_ENGINE, file)} -> ${moduleName}`
          )
      );
    expect(offenders).toEqual([]);
  });

  it("keeps results independent from compiler and runtime implementations", () => {
    const offenders = listTypeScriptFiles(RESULTS).flatMap((file) =>
      imports(readFileSync(file, "utf8"))
        .filter((moduleName) => RESULT_OWNER_IMPORT.test(moduleName))
        .map((moduleName) => `${relative(QUERY_ENGINE, file)} -> ${moduleName}`)
    );
    expect(offenders).toEqual([]);
  });

  it("keeps PendingOperation as the sole lifecycle composition root", () => {
    const pending = readFileSync(
      join(QUERY_ENGINE, "pending-operation.ts"),
      "utf8"
    );
    const engine = readFileSync(join(QUERY_ENGINE, "query-engine.ts"), "utf8");
    const compiler = readFileSync(
      join(QUERY_ENGINE, "OperationCompiler.ts"),
      "utf8"
    );

    for (const dependency of [
      "OperationCompiler",
      "OperationRuntime",
      "OperationResults",
    ]) {
      expect(pending).toContain(`from "./${dependency}"`);
    }
    expect(engine).toContain("return PendingOperation.create<T>");
    expect(compiler).toContain(
      "return this.writes.compile(ctx, operation, args)"
    );
    expect(compiler).not.toContain("OperationRuntime");
  });
});
