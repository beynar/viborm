import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import ts from "typescript";

const ROOT = process.env.QUERY_ENGINE_CENSUS_ROOT
  ? resolve(process.env.QUERY_ENGINE_CENSUS_ROOT)
  : resolve(import.meta.dirname, "..");
const QUERY_ENGINE = join(ROOT, "src/query-engine");
const WRITE_ENGINE = join(QUERY_ENGINE, "write-engine");

function listTypeScriptFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? listTypeScriptFiles(path) : [path];
    })
    .filter((path) => extname(path) === ".ts")
    .sort();
}

function isMeasuredFunction(node) {
  return (
    ts.isFunctionLike(node) &&
    node.body !== undefined &&
    !ts.isConstructorDeclaration(node) &&
    !ts.isGetAccessorDeclaration(node) &&
    !ts.isSetAccessorDeclaration(node)
  );
}

function isBranchNode(node) {
  if (
    ts.isIfStatement(node) ||
    ts.isConditionalExpression(node) ||
    ts.isCaseClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isCatchClause(node)
  ) {
    return true;
  }
  return (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  );
}

function hasRuntimeImport(importClause) {
  if (!importClause) return true;
  if (importClause.isTypeOnly) return false;
  if (importClause.name || !importClause.namedBindings) return true;
  if (ts.isNamespaceImport(importClause.namedBindings)) return true;
  return importClause.namedBindings.elements.some(
    (element) => !element.isTypeOnly
  );
}

function getRuntimeModule(node) {
  if (ts.isImportDeclaration(node)) {
    if (!hasRuntimeImport(node.importClause)) return undefined;
    return ts.isStringLiteral(node.moduleSpecifier)
      ? node.moduleSpecifier.text
      : undefined;
  }
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly || !node.moduleSpecifier) return undefined;
    if (
      node.exportClause &&
      ts.isNamedExports(node.exportClause) &&
      node.exportClause.elements.every((element) => element.isTypeOnly)
    ) {
      return undefined;
    }
    return ts.isStringLiteral(node.moduleSpecifier)
      ? node.moduleSpecifier.text
      : undefined;
  }
  return undefined;
}

function resolveInternalModule(fromFile, moduleName) {
  let candidate;
  if (moduleName.startsWith(".")) {
    candidate = resolve(fromFile, "..", moduleName);
  } else if (moduleName === "@query-engine") {
    candidate = join(QUERY_ENGINE, "index");
  } else if (moduleName.startsWith("@query-engine/")) {
    candidate = join(QUERY_ENGINE, moduleName.slice("@query-engine/".length));
  } else {
    return undefined;
  }

  const candidates = [
    candidate,
    `${candidate}.ts`,
    join(candidate, "index.ts"),
  ];
  return candidates.find((path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
}

function stronglyConnectedComponents(graph) {
  const components = [];
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  let index = 0;

  function visit(file) {
    indices.set(file, index);
    lowLinks.set(file, index);
    index += 1;
    stack.push(file);
    onStack.add(file);

    for (const dependency of graph.get(file) ?? []) {
      if (!indices.has(dependency)) {
        visit(dependency);
        lowLinks.set(
          file,
          Math.min(lowLinks.get(file), lowLinks.get(dependency))
        );
      } else if (onStack.has(dependency)) {
        lowLinks.set(
          file,
          Math.min(lowLinks.get(file), indices.get(dependency))
        );
      }
    }

    if (lowLinks.get(file) !== indices.get(file)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== file);
    components.push(component);
  }

  for (const file of graph.keys()) {
    if (!indices.has(file)) visit(file);
  }
  return components;
}

function measure(directory) {
  const files = listTypeScriptFiles(directory);
  const fileSet = new Set(files);
  const graph = new Map(files.map((file) => [file, []]));
  const largeFiles = [];
  let lines = 0;
  let tokenLines = 0;
  let functions = 0;
  let parameters = 0;
  let highParameterFunctions = 0;
  let branchNodes = 0;

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const lineCount = source.match(/\n/g)?.length ?? 0;
    lines += lineCount;
    if (lineCount > 300) {
      largeFiles.push({ file: relative(ROOT, file), lines: lineCount });
    }

    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true
    );
    const tokenLineNumbers = new Set();
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      false,
      ts.LanguageVariant.Standard,
      source
    );
    for (
      let token = scanner.scan();
      token !== ts.SyntaxKind.EndOfFileToken;
      token = scanner.scan()
    ) {
      if (
        token >= ts.SyntaxKind.FirstTriviaToken &&
        token <= ts.SyntaxKind.LastTriviaToken
      ) {
        continue;
      }
      tokenLineNumbers.add(
        sourceFile.getLineAndCharacterOfPosition(scanner.getTokenPos()).line
      );
    }
    tokenLines += tokenLineNumbers.size;
    const dependencies = graph.get(file);

    function visit(node) {
      if (isMeasuredFunction(node)) {
        functions += 1;
        parameters += node.parameters.length;
        if (node.parameters.length >= 5) highParameterFunctions += 1;
      }
      if (isBranchNode(node)) branchNodes += 1;

      const moduleName = getRuntimeModule(node);
      if (moduleName) {
        const dependency = resolveInternalModule(file, moduleName);
        if (dependency && fileSet.has(dependency))
          dependencies.push(dependency);
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }

  const cyclicComponents = stronglyConnectedComponents(graph)
    .filter(
      (component) =>
        component.length > 1 ||
        (graph.get(component[0]) ?? []).includes(component[0])
    )
    .map((component) => component.map((file) => relative(ROOT, file)).sort())
    .sort((left, right) => left[0].localeCompare(right[0]));

  return {
    files: files.length,
    lines,
    tokenLines,
    functions,
    parameters,
    highParameterFunctions,
    branchNodes,
    runtimeImportCycleComponents: cyclicComponents.length,
    runtimeFilesInCycles: new Set(cyclicComponents.flat()).size,
    filesOver300Lines: largeFiles.length,
    filesOver600Lines: largeFiles.filter((file) => file.lines > 600).length,
    largeFiles,
    runtimeImportCycles: cyclicComponents,
  };
}

const report = {
  definitions: {
    functions:
      "Function-like declarations with bodies, excluding constructors and accessors.",
    highParameterFunctions: "Measured functions with at least five parameters.",
    branchNodes:
      "if, ternary, case, loops, catch, &&, and || nodes; excludes ?? and default clauses.",
    importCycles:
      "Strongly connected components of runtime imports internal to the measured directory; type-only imports are excluded.",
    lines: "Physical newline count, equivalent to wc -l for these files.",
    tokenLines:
      "Physical lines containing at least one non-trivia TypeScript token; comments and blank lines are excluded.",
  },
  queryEngine: measure(QUERY_ENGINE),
  writeEngine: measure(WRITE_ENGINE),
};

console.log(JSON.stringify(report, null, 2));
