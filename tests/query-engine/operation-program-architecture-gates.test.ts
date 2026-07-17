import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { findRuntimeBoundaryOffenders } from "./runtime-import-boundary";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const QUERY_ENGINE = join(ROOT, "src/query-engine");
const CAPABILITY_READ = /\.(supportsTransactions|supportsBatch)\b/g;
const CALLBACK_PROPERTY = /^(build|builder|callback|execute|prepare|run)$/i;
const OPERATION_PROGRAM_FILE = /operation-program/i;
const OPERATION_RUNTIME_FILE = /^Operation.*Runtime\.ts$/;
const QUERY_METADATA_INTERFACE = /interface\s+QueryMetadata/;
const QUERY_ENGINE_DEPENDENCIES_INTERFACE =
  /interface\s+QueryEngineDependencies/;
const DUPLICATE_CLIENT_INFRASTRUCTURE =
  /private readonly (driver|registry|schemaRegistry|instrumentation):/;
const RELATION_OWNER_FILE = /(?:Relation|ManyToMany).*\.ts$/;
const INTERPRET_IMPORT = /from\s+["'][^"']*interpret/;
const INTERPRETER_IMPORT = /from\s+["'][^"']*interpreter["']/;

function listTypeScriptFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? listTypeScriptFiles(path) : [path];
    })
    .filter((path) => path.endsWith(".ts"));
}

function runtimeFiles(): string[] {
  return [
    ...listTypeScriptFiles(QUERY_ENGINE).filter((file) =>
      OPERATION_RUNTIME_FILE.test(basename(file))
    ),
    ...listTypeScriptFiles(join(QUERY_ENGINE, "runtime")),
  ];
}

function programVocabularyFiles(): string[] {
  return listTypeScriptFiles(QUERY_ENGINE).filter((file) =>
    OPERATION_PROGRAM_FILE.test(basename(file))
  );
}

function importedModules(source: string): string[] {
  const sourceFile = ts.createSourceFile(
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

function findProgramCallbackProperties(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "operation-program.ts",
    source,
    ts.ScriptTarget.Latest,
    true
  );
  const offenders: string[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isMethodSignature(node) || ts.isMethodDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      offenders.push(node.name.text);
    }
    if (
      (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      const name = node.name.text;
      const hasFunctionType = Boolean(
        node.type && ts.isFunctionTypeNode(node.type)
      );
      const hasFunctionInitializer = Boolean(
        ts.isPropertyDeclaration(node) &&
          node.initializer &&
          (ts.isArrowFunction(node.initializer) ||
            ts.isFunctionExpression(node.initializer))
      );
      if (
        CALLBACK_PROPERTY.test(name) ||
        hasFunctionType ||
        hasFunctionInitializer
      ) {
        offenders.push(name);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return offenders;
}

describe("operation-program architecture", () => {
  it("keeps lifecycle ownership in PendingOperation without metadata closure bags", () => {
    const engineSource = readFileSync(
      join(QUERY_ENGINE, "query-engine.ts"),
      "utf8"
    );
    const pendingSource = readFileSync(
      join(QUERY_ENGINE, "pending-operation.ts"),
      "utf8"
    );
    const typesSource = readFileSync(join(QUERY_ENGINE, "types.ts"), "utf8");
    const clientSource = readFileSync(
      join(ROOT, "src/client/client.ts"),
      "utf8"
    );

    expect(existsSync(join(ROOT, "src/client/pending-operation.ts"))).toBe(
      false
    );
    expect(pendingSource).toContain("export class PendingOperation");
    expect(engineSource).not.toContain("QueryEngineDependencies");
    expect(engineSource).not.toContain("getDependencies(");
    expect(engineSource).not.toContain("getDriver(");
    expect(typesSource).not.toMatch(QUERY_METADATA_INTERFACE);
    expect(typesSource).not.toMatch(QUERY_ENGINE_DEPENDENCIES_INTERFACE);
    expect(existsSync(join(QUERY_ENGINE, "executor.ts"))).toBe(false);
    expect(clientSource).not.toMatch(DUPLICATE_CLIENT_INFRASTRUCTURE);
  });

  it("removes the temporary migration registry after every operation migrates", () => {
    expect(
      existsSync(
        join(ROOT, "tests/query-engine/operation-program-migration-registry.ts")
      )
    ).toBe(false);

    const compilerSource = readFileSync(
      join(QUERY_ENGINE, "OperationCompiler.ts"),
      "utf8"
    );
    const writesSource = readFileSync(
      join(QUERY_ENGINE, "WriteOperations.ts"),
      "utf8"
    );
    expect(compilerSource).toContain("this.compileReadProgram(");
    expect(compilerSource).toContain("this.writes.compile(");
    expect(writesSource).toContain("this.relations.compileCreate(");
    expect(writesSource).toContain("this.relations.compileUpdate(");
    expect(writesSource).toContain("this.relations.compileUpsert(");
  });

  it("keeps runtime modules independent from relation semantics", () => {
    const offenders = findRuntimeBoundaryOffenders(
      runtimeFiles(),
      QUERY_ENGINE
    );

    expect(offenders).toEqual([]);
  });

  it("stores declarative data rather than callbacks in program vocabulary", () => {
    const offenders = programVocabularyFiles().flatMap((file) =>
      findProgramCallbackProperties(readFileSync(file, "utf8")).map(
        (property) => `${basename(file)}:${property}`
      )
    );

    expect(offenders).toEqual([]);
    expect(
      findProgramCallbackProperties(
        "interface WriteStep { builder: () => unknown; statement: string }"
      )
    ).toEqual(["builder"]);
  });

  it("keeps dynamic program vocabulary declarative and runtime-owned", () => {
    const programSource = readFileSync(
      join(QUERY_ENGINE, "operation-program.ts"),
      "utf8"
    );
    const runtimeSource = readFileSync(
      join(QUERY_ENGINE, "OperationRuntime.ts"),
      "utf8"
    );
    const batchRuntimeSource = readFileSync(
      join(QUERY_ENGINE, "OperationBatchRuntime.ts"),
      "utf8"
    );
    const pendingSource = readFileSync(
      join(QUERY_ENGINE, "pending-operation.ts"),
      "utf8"
    );

    for (const declaration of [
      "export interface GuardStep",
      "export interface BranchStep",
      "export interface FailureStep",
      "export interface ProducedValue",
      "export interface ProducedRows",
      "export interface WriteStep",
    ]) {
      expect(programSource).toContain(declaration);
    }
    expect(programSource).toContain('readonly kind: "capturedMutation"');
    expect(programSource).toContain('readonly kind: "capturedRead"');
    expect(programSource).toContain("expectedCardinality");
    expect(programSource).toContain("affectedRows");
    expect(programSource).toContain("producedValues");
    expect(runtimeSource).toContain("driver.withTransaction(");
    expect(runtimeSource).toContain("driver._execute(");
    expect(batchRuntimeSource).toContain("driver._executeBatch(");
    expect(batchRuntimeSource).toContain("collectBranchDecisionIds");
    expect(batchRuntimeSource).toContain("storeLastInsertId");
    expect(pendingSource).toContain("this.runtime.execute(driverOverride)");
  });

  it("keeps relation mutation semantics under WriteOperations", () => {
    const compilerSource = readFileSync(
      join(QUERY_ENGINE, "OperationCompiler.ts"),
      "utf8"
    );
    const runtimeSource = readFileSync(
      join(QUERY_ENGINE, "OperationRuntime.ts"),
      "utf8"
    );
    const writesSource = readFileSync(
      join(QUERY_ENGINE, "WriteOperations.ts"),
      "utf8"
    );
    const relationOwnerFiles = listTypeScriptFiles(QUERY_ENGINE).filter(
      (file) => RELATION_OWNER_FILE.test(basename(file))
    );
    const interpreterImports = relationOwnerFiles.flatMap((file) =>
      importedModules(readFileSync(file, "utf8")).filter((moduleName) =>
        INTERPRET_IMPORT.test(`from "${moduleName}"`)
      )
    );

    expect(writesSource).toContain("readonly relations: RelationMutations<T>");
    expect(writesSource).toContain(
      "this.relations = new RelationMutations(this)"
    );
    expect(interpreterImports).toEqual([]);
    expect(runtimeSource).not.toContain("RelationMutations");
    expect(compilerSource).toContain(
      "this.writes.compile(ctx, operation, args)"
    );
    expect(writesSource).toContain("this.relations.compileCreate");
    expect(writesSource).toContain("this.relations.compileUpdate");
    expect(writesSource).toContain("this.relations.compileUpsert");
  });

  it("keeps operation and relation statements as closed lowering vocabularies", () => {
    const programSource = readFileSync(
      join(QUERY_ENGINE, "operation-program.ts"),
      "utf8"
    );
    const statements = programSource.slice(
      programSource.indexOf("export interface OperationStatement"),
      programSource.indexOf("export interface ProducedValue")
    );

    for (const operation of [
      '"create"',
      '"createMany"',
      '"delete"',
      '"deleteMany"',
      '"findMany"',
      '"findUnique"',
      '"update"',
      '"updateMany"',
      '"junctionInsert"',
      '"membershipRead"',
    ]) {
      expect(statements).toContain(operation);
    }
    expect(statements).not.toContain('| "upsert"');
    expect(statements).not.toContain("callback");
  });

  it("deletes replaced direct-operation infrastructure", () => {
    for (const relativeFile of [
      "operation-builder.ts",
      "operation-preparation.ts",
      "result-flow.ts",
      "transaction-flow.ts",
      "operations/bulk-create-preparation.ts",
      "operations/bulk-create.ts",
      "operations/many-returns.ts",
      "operations/mutation-returns.ts",
    ]) {
      expect(existsSync(join(QUERY_ENGINE, relativeFile))).toBe(false);
    }

    expect(existsSync(join(QUERY_ENGINE, "executor.ts"))).toBe(false);
    const resultsSource = readFileSync(
      join(QUERY_ENGINE, "OperationResults.ts"),
      "utf8"
    );
    expect(resultsSource).toContain("export class OperationResults");
    expect(resultsSource).toContain("step.expectedCardinality");
  });

  it("derives read preparation and count carriers from the program contract", () => {
    const runtimeSource = readFileSync(
      join(QUERY_ENGINE, "OperationRuntime.ts"),
      "utf8"
    );
    const resultSource = readFileSync(
      join(QUERY_ENGINE, "result/result-row-parser.ts"),
      "utf8"
    );

    expect(runtimeSource).toContain(
      "this.compiler.compileValidated(validated)"
    );
    expect(runtimeSource).not.toContain("if (!program)");
    expect(
      readFileSync(join(QUERY_ENGINE, "OperationCompiler.ts"), "utf8")
    ).not.toContain("tryCompileValidated");
    expect(runtimeSource).toContain("driver._prepare(");
    expect(resultSource).toContain('shape.carrier !== "rows"');
    expect(resultSource).not.toContain('operation === "count"');
    expect(resultSource).not.toContain('operation === "exist"');
  });

  it("removes executor and PendingOperation legacy fallbacks", () => {
    const sources = ["pending-operation.ts", "OperationRuntime.ts"]
      .map((file) => readFileSync(join(QUERY_ENGINE, file), "utf8"))
      .join("\n");

    for (const token of [
      "executeLegacyOperation",
      "prepareNestedBatchOperation",
      "runInterpreter",
      "strategy selection",
    ]) {
      expect(sources).not.toContain(token);
    }
    expect(sources).not.toMatch(INTERPRETER_IMPORT);
    expect(sources).not.toContain("needsUpsertWhereFallback");
    expect(sources).not.toContain("supportsReturning");
  });

  it("has one runtime capability-selection point", () => {
    const capabilityReaders = runtimeFiles().filter((file) => {
      const source = readFileSync(file, "utf8");
      CAPABILITY_READ.lastIndex = 0;
      return CAPABILITY_READ.test(source);
    });

    expect(capabilityReaders.map((file) => basename(file))).toEqual([
      "OperationRuntime.ts",
    ]);
  });
});
