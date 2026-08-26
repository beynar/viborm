import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { REPOSITORY_ROOT, SOURCE_ROOT } from "@tests/fixtures/repo-paths";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const CANONICAL_CHAIN_OWNER = "src/extensions/chain.ts appendResolvedExtension";
const SUPERSEDED_EXTENSION_OWNERS = Object.freeze([
  "src/client/extension-chain.ts",
  "src/client/extension-definition.ts",
  "src/client/extensions.ts",
  "src/client/request-transforms.ts",
  "src/drivers/extension-chain.ts",
  "src/query-engine/query-interceptors.ts",
  "src/query-engine/write-outcomes.ts",
  "src/drivers/protected-observers.ts",
  "src/drivers/statement-transforms.ts",
  "src/instrumentation/official-extension.ts",
]);
const DUPLICATE_HANDLER_CARRIERS = new Set([
  "ProtectedObserver",
  "ResolvedProtectedObserver",
  "ResolvedStatementTransform",
  "RuntimeQueryInterceptor",
  "RuntimeRequestTransform",
  "StatementTransform",
]);
const COLLECTION_NAMES = new Set(["Map", "Set", "WeakMap", "WeakSet"]);
const MIDDLEWARE_OR_PLUGIN = /middleware|plugin/i;
const EXTENSION_REGISTRY_SUBJECT = /extension|interceptor/i;
const REGISTRY_ROLE = /registry|map|set|chain|handlers/i;
const CHAIN_OWNER_PREFIX = /^(?:append|build|compile|create|resolve)/i;
const CHAIN_OWNER_SUBJECT = /extension|middleware|plugin/i;
const CHAIN_OWNER_ROLE = /chain|registry|handlers?/i;
const TRANSACTION_OPERATION_AUTHORITY =
  /transactionOperation|arrayTransactionOperation/i;
const OPERATION_NAME = /operation/i;
const AUTHORITY_ROLE = /program|fragment|step|token|capability/i;
const RUNTIME_EXTENSION = /\.js$/;
const PROTOTYPE_OWNER_MAP = "transactionOperationOwnersByPrototype";

interface ExtensionSystemCensus {
  readonly chainOwners: string[];
  readonly executableRegistries: string[];
  readonly publicAuthorityExports: string[];
}

interface TransactionAuthorityCensus {
  readonly registrationFiles: string[];
  readonly registrationsOutsideClassStaticBlocks: string[];
  readonly ownerWeakMapDeclarations: string[];
  readonly ownerWeakMapSetKeys: string[];
}

function sourceFile(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (entry.isFile() && extname(entry.name) === ".ts") {
      files.push(path);
    }
  }
  return files;
}

function nodeName(node: ts.Node): string | undefined {
  if (
    ts.isClassDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isTypeAliasDeclaration(node)
  ) {
    return node.name && ts.isIdentifier(node.name) ? node.name.text : undefined;
  }
  return undefined;
}

function isCollectionInitializer(node: ts.Expression | undefined): boolean {
  return (
    node !== undefined &&
    (ts.isArrayLiteralExpression(node) ||
      ts.isObjectLiteralExpression(node) ||
      (ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        COLLECTION_NAMES.has(node.expression.text)))
  );
}

function isExecutableRegistryName(name: string): boolean {
  if (MIDDLEWARE_OR_PLUGIN.test(name)) return true;
  return EXTENSION_REGISTRY_SUBJECT.test(name) && REGISTRY_ROLE.test(name);
}

function isChainOwnerName(name: string): boolean {
  if (name === "appendResolvedExtension") return true;
  return (
    CHAIN_OWNER_PREFIX.test(name) &&
    CHAIN_OWNER_SUBJECT.test(name) &&
    CHAIN_OWNER_ROLE.test(name)
  );
}

function sourceRegistryEntries(
  fileName: string,
  source: string
): Pick<ExtensionSystemCensus, "chainOwners" | "executableRegistries"> {
  const parsed = sourceFile(fileName, source);
  const chainOwners: string[] = [];
  const executableRegistries: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isMethodDeclaration(node)
    ) {
      const name = nodeName(node);
      if (name && isChainOwnerName(name)) {
        chainOwners.push(`${fileName} ${name}`);
      } else if (name && MIDDLEWARE_OR_PLUGIN.test(name)) {
        executableRegistries.push(`${fileName} ${name}`);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      if (
        node.initializer !== undefined &&
        (ts.isArrowFunction(node.initializer) ||
          ts.isFunctionExpression(node.initializer))
      ) {
        if (isChainOwnerName(name)) {
          chainOwners.push(`${fileName} ${name}`);
        } else if (MIDDLEWARE_OR_PLUGIN.test(name)) {
          executableRegistries.push(`${fileName} ${name}`);
        }
      }
      if (
        isCollectionInitializer(node.initializer) &&
        isExecutableRegistryName(name)
      ) {
        executableRegistries.push(`${fileName} ${name}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return {
    chainOwners: chainOwners.sort(),
    executableRegistries: executableRegistries.sort(),
  };
}

function publicEntryFiles(): Array<readonly [string, string]> {
  const configPath = join(REPOSITORY_ROOT, "tsdown.config.ts");
  const parsed = sourceFile(configPath, readFileSync(configPath, "utf8"));
  const entries: Array<readonly [string, string]> = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === "entry") ||
        (ts.isStringLiteral(node.name) && node.name.text === "entry")) &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const property of node.initializer.properties) {
        if (
          !(
            ts.isPropertyAssignment(property) &&
            ts.isStringLiteral(property.initializer)
          )
        ) {
          continue;
        }
        const name = property.name.getText(parsed).replaceAll(/["']/g, "");
        entries.push([
          name,
          resolve(REPOSITORY_ROOT, property.initializer.text),
        ]);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return entries;
}

function exportedNames(source: string, fileName = "witness.ts"): string[] {
  const parsed = sourceFile(fileName, source);
  const names: string[] = [];
  for (const statement of parsed.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (element.propertyName) names.push(element.propertyName.text);
          names.push(element.name.text);
        }
      }
      continue;
    }
    if (!ts.canHaveModifiers(statement)) continue;
    const modifiers = ts.getModifiers(statement);
    if (!modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)) {
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name))
          names.push(declaration.name.text);
      }
      continue;
    }
    const name = nodeName(statement);
    if (name) names.push(name);
  }
  return names;
}

function isPublicAuthorityName(name: string): boolean {
  return (
    TRANSACTION_OPERATION_AUTHORITY.test(name) ||
    (OPERATION_NAME.test(name) && AUTHORITY_ROLE.test(name))
  );
}

function resolveReexport(fromFile: string, moduleName: string): string {
  const unresolved = resolve(dirname(fromFile), moduleName);
  const withoutRuntimeExtension = unresolved.replace(RUNTIME_EXTENSION, "");
  for (const candidate of [
    `${withoutRuntimeExtension}.ts`,
    join(withoutRuntimeExtension, "index.ts"),
  ]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // Try the next exact TypeScript source representation.
    }
  }
  throw new Error(
    `Could not resolve public re-export ${moduleName} from ${fromFile}`
  );
}

function publicAuthorityExports(
  entryName: string,
  entryFile: string,
  visited = new Set<string>()
): string[] {
  if (visited.has(entryFile)) return [];
  visited.add(entryFile);
  const source = readFileSync(entryFile, "utf8");
  const parsed = sourceFile(entryFile, source);
  const entries = exportedNames(source, entryFile)
    .filter(isPublicAuthorityName)
    .map(
      (name) => `${entryName} ${relative(REPOSITORY_ROOT, entryFile)} ${name}`
    );
  for (const statement of parsed.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.exportClause !== undefined ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.startsWith(".")
    ) {
      continue;
    }
    entries.push(
      ...publicAuthorityExports(
        entryName,
        resolveReexport(entryFile, statement.moduleSpecifier.text),
        visited
      )
    );
  }
  return entries.sort();
}

function collectCensus(): ExtensionSystemCensus {
  const chainOwners: string[] = [];
  const executableRegistries: string[] = [];
  for (const path of sourceFiles(SOURCE_ROOT)) {
    const fileName = relative(REPOSITORY_ROOT, path);
    const entries = sourceRegistryEntries(fileName, readFileSync(path, "utf8"));
    chainOwners.push(...entries.chainOwners);
    executableRegistries.push(...entries.executableRegistries);
  }
  const publicExports = publicEntryFiles().flatMap(([name, path]) =>
    publicAuthorityExports(name, path)
  );
  return {
    chainOwners: chainOwners.sort(),
    executableRegistries: executableRegistries.sort(),
    publicAuthorityExports: publicExports.sort(),
  };
}

function duplicateHandlerCarriers(): string[] {
  const carriers: string[] = [];
  for (const path of sourceFiles(SOURCE_ROOT)) {
    const fileName = relative(REPOSITORY_ROOT, path);
    const parsed = sourceFile(fileName, readFileSync(path, "utf8"));
    const visit = (node: ts.Node): void => {
      const name = nodeName(node);
      if (name && DUPLICATE_HANDLER_CARRIERS.has(name)) {
        carriers.push(`${fileName} ${name}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
  return carriers.sort();
}

function resolvedExtensionProperties(): string[] {
  const path = join(SOURCE_ROOT, "extensions/chain.ts");
  const parsed = sourceFile(path, readFileSync(path, "utf8"));
  for (const statement of parsed.statements) {
    if (
      !ts.isInterfaceDeclaration(statement) ||
      statement.name.text !== "ResolvedExtension"
    ) {
      continue;
    }
    return statement.members
      .flatMap((member) => {
        const name = member.name;
        if (name === undefined) return [];
        if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
          return [name.text];
        }
        return [];
      })
      .sort();
  }
  return [];
}

function transactionOwnerStorageEntries(
  source: string,
  fileName = "transaction-operation.ts"
): Pick<
  TransactionAuthorityCensus,
  "ownerWeakMapDeclarations" | "ownerWeakMapSetKeys"
> {
  const parsed = sourceFile(fileName, source);
  const ownerWeakMapDeclarations: string[] = [];
  const ownerWeakMapSetKeys: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isNewExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "WeakMap"
    ) {
      ownerWeakMapDeclarations.push(node.name.text);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === PROTOTYPE_OWNER_MAP &&
      node.expression.name.text === "set"
    ) {
      ownerWeakMapSetKeys.push(
        node.arguments[0]?.getText(parsed) ?? "<missing>"
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return {
    ownerWeakMapDeclarations: ownerWeakMapDeclarations.sort(),
    ownerWeakMapSetKeys: ownerWeakMapSetKeys.sort(),
  };
}

function collectTransactionAuthorityCensus(): TransactionAuthorityCensus {
  const registrationFiles: string[] = [];
  const registrationsOutsideClassStaticBlocks: string[] = [];
  for (const path of sourceFiles(SOURCE_ROOT)) {
    const fileName = relative(REPOSITORY_ROOT, path);
    const parsed = sourceFile(fileName, readFileSync(path, "utf8"));
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "registerTransactionOperationOwner"
      ) {
        registrationFiles.push(fileName);
        let scope = node.parent;
        while (
          scope !== undefined &&
          scope.kind !== ts.SyntaxKind.ClassStaticBlockDeclaration &&
          !ts.isSourceFile(scope)
        ) {
          scope = scope.parent;
        }
        if (scope?.kind !== ts.SyntaxKind.ClassStaticBlockDeclaration) {
          registrationsOutsideClassStaticBlocks.push(fileName);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
  const authorityPath = join(
    SOURCE_ROOT,
    "query-engine/transaction-operation.ts"
  );
  const storage = transactionOwnerStorageEntries(
    readFileSync(authorityPath, "utf8"),
    relative(REPOSITORY_ROOT, authorityPath)
  );
  return {
    registrationFiles: registrationFiles.sort(),
    registrationsOutsideClassStaticBlocks:
      registrationsOutsideClassStaticBlocks.sort(),
    ...storage,
  };
}

describe("extension-system source census", () => {
  const census = collectCensus();
  const transactionAuthority = collectTransactionAuthorityCensus();

  test("keeps one executable extension-chain owner and no parallel registry", () => {
    expect(census.chainOwners).toEqual([CANONICAL_CHAIN_OWNER]);
    expect(census.executableRegistries).toEqual([]);
  });

  test("keeps no superseded owner or parallel runtime handler carrier", () => {
    expect(
      SUPERSEDED_EXTENSION_OWNERS.filter((path) =>
        existsSync(join(REPOSITORY_ROOT, path))
      )
    ).toEqual([]);
    expect(duplicateHandlerCarriers()).toEqual([]);
  });

  test("retains no normalized definition beside compiled execution handlers", () => {
    expect(resolvedExtensionProperties()).toEqual(["client", "model", "name"]);
  });

  test("exports no operation program, token, or capability", () => {
    expect(census.publicAuthorityExports).toEqual([]);
  });

  test("keeps array authority class-owned without per-operation registration state", () => {
    expect(transactionAuthority).toEqual({
      registrationFiles: [
        "src/client/raw.ts",
        "src/query-engine/pending-operation.ts",
      ],
      registrationsOutsideClassStaticBlocks: [],
      ownerWeakMapDeclarations: [PROTOTYPE_OWNER_MAP],
      ownerWeakMapSetKeys: ["prototype"],
    });
  });

  test("detects a second owner map and per-operation storage key", () => {
    expect(
      transactionOwnerStorageEntries(`
        const transactionOperationOwnersByPrototype = new WeakMap<object, object>();
        const transactionOperationOwnersByOperation = new WeakMap<object, object>();
        transactionOperationOwnersByPrototype.set(operation, owner);
      `)
    ).toEqual({
      ownerWeakMapDeclarations: [
        "transactionOperationOwnersByOperation",
        PROTOTYPE_OWNER_MAP,
      ],
      ownerWeakMapSetKeys: ["operation"],
    });
  });

  test("detects executable registries but ignores prose and string payloads", () => {
    const witness = sourceRegistryEntries(
      "witness/parallel-registry.ts",
      `
        // const pluginRegistry = new Map();
        const prose = "const middlewareRegistry = new Map()";
        const pluginRegistry = new Map<string, CallableFunction>();
        const extensionHandlerRegistry = new WeakMap<object, CallableFunction>();
        const runPluginPipeline = () => [];
        function createExtensionMiddlewareChain() { return []; }
      `
    );
    expect(witness.executableRegistries).toEqual([
      "witness/parallel-registry.ts extensionHandlerRegistry",
      "witness/parallel-registry.ts pluginRegistry",
      "witness/parallel-registry.ts runPluginPipeline",
    ]);
    expect(witness.chainOwners).toEqual([
      "witness/parallel-registry.ts createExtensionMiddlewareChain",
    ]);
  });

  test("detects public authority spellings but ignores comments and strings", () => {
    expect(
      exportedNames(`
        // export const operationToken = true;
        const prose = "export type TransactionOperation = unknown";
        const hidden = true;
        export const operationProgram = {};
        export interface OperationFragment {}
        export type operationStep = unknown;
        export interface TransactionOperation {}
        export { hidden as operationCapability };
      `)
        .filter(isPublicAuthorityName)
        .sort()
    ).toEqual([
      "OperationFragment",
      "TransactionOperation",
      "operationCapability",
      "operationProgram",
      "operationStep",
    ]);
  });
});
