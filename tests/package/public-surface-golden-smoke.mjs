// biome-ignore-all lint/suspicious/noMisplacedAssertion: This standalone packed-package smoke uses node:assert as its runner.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import {
  ABSENT_EXPORT_SUBPATHS,
  ABSENT_PUBLIC_NAMES,
  PACKAGE_SURFACE_GOLDEN,
  PUBLIC_CLIENT_CAPABILITY_KEYS,
  SCHEMA_BUILDER_KEYS,
} from "./public-surface-golden.mjs";

// The same pnpm this smoke runs under - not whichever `pnpm` is first on PATH.
// The CI runner image ships pnpm v11 beside the pinned v10.11.0, and a bare
// `pnpm` inside the sandbox resolved the other one, whose store is empty, so
// `--offline` failed. Its stderr is surfaced too: a bare "Command failed" cost
// a CI round trip to read.
const PNPM_JS_ENTRY = /\.[cm]?js$/;
function runPnpm(args, options) {
  const entry = process.env.npm_execpath;
  const [command, prefix] =
    entry && PNPM_JS_ENTRY.test(entry)
      ? [process.execPath, [entry]]
      : ["pnpm", []];
  try {
    return execFileSync(command, [...prefix, ...args], {
      ...options,
      stdio: "pipe",
    });
  } catch (error) {
    // pnpm reports its errors on STDOUT (ERR_PNPM_* lines), so both streams
    // go into the message.
    const output = [error?.stdout, error?.stderr]
      .map((stream) => stream?.toString?.() ?? "")
      .filter((text) => text.trim().length > 0)
      .join("\n");
    throw new Error(
      `pnpm ${args.join(" ")} failed${output ? `:\n${output}` : ""}`,
      { cause: error }
    );
  }
}

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const repositoryPackage = JSON.parse(
  readFileSync(join(repositoryRoot, "package.json"), "utf8")
);

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sortedPairs(values) {
  return [...values].sort(([left], [right]) => left.localeCompare(right));
}

function expectedDeclarations(contract) {
  const declarations = new Map();
  for (const name of contract.runtime) declarations.set(name, "value");
  for (const name of contract.typeOnly) declarations.set(name, "type");
  for (const name of contract.both) declarations.set(name, "both");
  for (const name of contract.namespaces) declarations.set(name, "namespace");
  return sortedPairs(declarations);
}

function containingExportDeclaration(node) {
  let current = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isExportDeclaration(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function isTypeOnlyExportAlias(symbol) {
  const exportDeclarations = (symbol.declarations ?? []).filter(
    (declaration) => containingExportDeclaration(declaration) !== undefined
  );
  return (
    exportDeclarations.length > 0 &&
    exportDeclarations.every((declaration) => {
      if (ts.isExportSpecifier(declaration) && declaration.isTypeOnly) {
        return true;
      }
      return containingExportDeclaration(declaration)?.isTypeOnly === true;
    })
  );
}

function hasSymbolFlag(symbol, flag) {
  // biome-ignore lint/suspicious/noBitwiseOperators: TypeScript SymbolFlags is a bitmask contract.
  return (symbol.flags & flag) !== 0;
}

function classifyDeclaration(checker, symbol) {
  if (isTypeOnlyExportAlias(symbol)) return "type";
  let target = symbol;
  if (hasSymbolFlag(symbol, ts.SymbolFlags.Alias)) {
    target = checker.getAliasedSymbol(symbol);
  }
  const isValue = hasSymbolFlag(target, ts.SymbolFlags.Value);
  const isType = hasSymbolFlag(target, ts.SymbolFlags.Type);
  if (isValue && isType) return "both";
  if (isValue) return "value";
  if (isType) return "type";
  if (hasSymbolFlag(target, ts.SymbolFlags.Namespace)) return "namespace";
  throw new Error(
    `Cannot classify declaration ${symbol.name} with flags ${target.flags}`
  );
}

const consumerRoot = mkdtempSync(join(tmpdir(), "viborm-package-golden-"));
try {
  let archive = process.env.VIBORM_PACKAGE_TARBALL;
  if (archive === undefined) {
    runPnpm(["pack", "--pack-destination", consumerRoot], {
      cwd: repositoryRoot,
    });
    const archives = readdirSync(consumerRoot).filter((name) =>
      name.endsWith(".tgz")
    );
    assert.equal(archives.length, 1, "pnpm pack must produce one archive");
    archive = join(consumerRoot, archives[0]);
  }
  const linkedDependencies = Object.fromEntries(
    Object.keys({
      ...repositoryPackage.devDependencies,
      ...repositoryPackage.dependencies,
      ...repositoryPackage.peerDependencies,
    }).map((name) => [
      name,
      `link:${join(repositoryRoot, "node_modules", name)}`,
    ])
  );
  writeFileSync(
    join(consumerRoot, "package.json"),
    JSON.stringify({
      name: "viborm-package-golden-consumer",
      private: true,
      type: "module",
      dependencies: {
        ...linkedDependencies,
        viborm: `file:${archive}`,
      },
    })
  );
  // `--prefer-offline`, not `--offline`: the sandbox has no lockfile, so pnpm
  // must resolve the linked dependencies' ranges from its registry METADATA
  // cache, which is not the content store. A developer machine has that cache
  // warm; the CI runner restores only the store, and `--offline` then fails
  // with ERR_PNPM_NO_OFFLINE_META. prefer-offline keeps a warm cache hermetic
  // and lets a cold one fetch metadata.
  runPnpm(
    ["install", "--prefer-offline", "--ignore-scripts", "--no-frozen-lockfile"],
    {
      cwd: consumerRoot,
    }
  );

  const installedRoot = join(consumerRoot, "node_modules", "viborm");
  const installedPackage = JSON.parse(
    readFileSync(join(installedRoot, "package.json"), "utf8")
  );
  const expectedSubpaths = Object.keys(PACKAGE_SURFACE_GOLDEN);
  assert.deepEqual(
    Object.keys(installedPackage.exports),
    expectedSubpaths,
    "packed export subpaths changed"
  );
  for (const subpath of ABSENT_EXPORT_SUBPATHS) {
    assert.equal(
      Object.hasOwn(installedPackage.exports, subpath),
      false,
      `retired export subpath ${subpath} returned`
    );
  }

  const runtimeNamespaces = new Map();
  for (const [subpath, expected] of Object.entries(PACKAGE_SURFACE_GOLDEN)) {
    const target = installedPackage.exports[subpath];
    assert.equal(typeof target?.import, "string");
    assert.equal(typeof target?.types, "string");
    const namespace = await import(
      pathToFileURL(resolve(installedRoot, target.import)).href
    );
    runtimeNamespaces.set(subpath, namespace);
    assert.deepEqual(
      sorted(Object.keys(namespace)),
      sorted(expected.runtime),
      `${subpath} runtime names changed`
    );
    for (const name of ABSENT_PUBLIC_NAMES[subpath] ?? []) {
      assert.equal(name in namespace, false, `${subpath} leaked ${name}`);
    }
  }

  const rootBuilder = runtimeNamespaces.get(".").s;
  const schemaBuilder = runtimeNamespaces.get("./schema").s;
  assert.deepEqual(sorted(Object.keys(rootBuilder)), SCHEMA_BUILDER_KEYS);
  assert.deepEqual(sorted(Object.keys(schemaBuilder)), SCHEMA_BUILDER_KEYS);
  assert.equal("POINT" in runtimeNamespaces.get("./schema").PG, false);

  const { MemoryCache } = runtimeNamespaces.get("./cache/memory");
  assert.ok(new MemoryCache() instanceof MemoryCache);
  let hostileReads = 0;
  const hostileClock = Object.defineProperty({}, "now", {
    get() {
      hostileReads += 1;
      throw new Error("must not read retired clock configuration");
    },
  });
  assert.throws(() => new MemoryCache(hostileClock));
  assert.equal(hostileReads, 0);
  assert.throws(() => new MemoryCache(undefined));

  const { PostgresAdapter } = runtimeNamespaces.get("./adapters");
  class ExternalPostgresAdapter extends PostgresAdapter {}
  const externalAdapter = new ExternalPostgresAdapter("golden");
  assert.equal(
    externalAdapter.identifiers.table("user").toStatement(),
    '"golden"."user"'
  );

  const consumerTypeFile = join(consumerRoot, "surface-consumer.ts");
  writeFileSync(
    consumerTypeFile,
    `
import type { VibORMClient } from "viborm";
import type { AnyDriver } from "viborm/driver";
import { PostgresAdapter } from "viborm/adapters";
import type { DatabaseAdapter } from "viborm/adapters";
import type { OperationResult } from "viborm/client";
import type { Model, NumberScalar } from "viborm/schema";
// @ts-expect-error Model is exported only in the type namespace
import { Model as ModelValue } from "viborm/schema";
// @ts-expect-error NumberScalar is exported only in the type namespace
import { NumberScalar as NumberScalarValue } from "viborm/schema";

export type GoldenClient = VibORMClient<{ schema: {}; driver: AnyDriver }>;
declare const client: GoldenClient;
// @ts-expect-error safe raw calls do not accept strings
client.$queryRaw("SELECT 1");
// @ts-expect-error the retired explicit legacy array shape is not accepted
client.$executeRaw(["DELETE FROM user"], []);
// @ts-expect-error OperationResult has exactly four public generic arguments
type RetiredOperationResult = OperationResult<"findMany", {}, {}, {}, {}>;

class ExternalPostgresAdapter extends PostgresAdapter {}
const externalAdapter: DatabaseAdapter = new ExternalPostgresAdapter("golden");
void externalAdapter;
declare const model: Model<never>;
declare const numberScalar: NumberScalar<never>;
void model;
void numberScalar;
// @ts-expect-error a type-only Model export cannot be used as a value
void ModelValue;
// @ts-expect-error a type-only NumberScalar export cannot be used as a value
void NumberScalarValue;
`,
    "utf8"
  );

  const declarationFiles = Object.values(installedPackage.exports).map(
    (target) => resolve(installedRoot, target.types)
  );
  const declarationKindFixtureFile = join(
    consumerRoot,
    "export-kind-fixture.d.ts"
  );
  writeFileSync(
    declarationKindFixtureFile,
    `
declare class ExportKindFixture {}
export type { ExportKindFixture as DeclarationTypeOnly };
export { type ExportKindFixture as SpecifierTypeOnly };
export { ExportKindFixture as ValueAndType };
`,
    "utf8"
  );
  const forbiddenDeclarationText = [
    [/@deprecated\b/i, "unadjudicated @deprecated marker"],
    [/\bhistorical\b/i, "unadjudicated historical contract"],
    [
      /\bResolved(?:RelationIndex|RelationEdge|Slot)\b/,
      "internal relation-resolution type",
    ],
  ];
  for (const declarationFile of declarationFiles) {
    const declarationText = readFileSync(declarationFile, "utf8");
    for (const [pattern, label] of forbiddenDeclarationText) {
      assert.doesNotMatch(
        declarationText,
        pattern,
        `${declarationFile} leaked ${label}`
      );
    }
  }
  assert.doesNotMatch(
    readFileSync(
      resolve(installedRoot, installedPackage.exports["./schema"].types),
      "utf8"
    ),
    /\bPOINT\s*:/,
    "viborm/schema declarations leaked the retired PG.POINT alias"
  );
  const program = ts.createProgram({
    rootNames: [
      ...declarationFiles,
      consumerTypeFile,
      declarationKindFixtureFile,
    ],
    options: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(
    diagnostics.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
    ),
    [],
    "packed consumer type contract failed"
  );

  const checker = program.getTypeChecker();
  const declarationKindFixture = program.getSourceFile(
    declarationKindFixtureFile
  );
  assert.ok(declarationKindFixture, "export-kind fixture was not loaded");
  const declarationKindFixtureSymbol = checker.getSymbolAtLocation(
    declarationKindFixture
  );
  assert.ok(
    declarationKindFixtureSymbol,
    "export-kind fixture has no module symbol"
  );
  assert.deepEqual(
    sortedPairs(
      checker
        .getExportsOfModule(declarationKindFixtureSymbol)
        .map((symbol) => [symbol.name, classifyDeclaration(checker, symbol)])
    ),
    [
      ["DeclarationTypeOnly", "type"],
      ["SpecifierTypeOnly", "type"],
      ["ValueAndType", "both"],
    ],
    "export-side declaration kind classification changed"
  );
  for (const [subpath, expected] of Object.entries(PACKAGE_SURFACE_GOLDEN)) {
    const declarationFile = resolve(
      installedRoot,
      installedPackage.exports[subpath].types
    );
    const source = program.getSourceFile(declarationFile);
    assert.ok(source, `${subpath} declaration file was not loaded`);
    const moduleSymbol = checker.getSymbolAtLocation(source);
    assert.ok(moduleSymbol, `${subpath} declaration module has no symbol`);
    const actual = checker
      .getExportsOfModule(moduleSymbol)
      .map((symbol) => [symbol.name, classifyDeclaration(checker, symbol)]);
    assert.deepEqual(
      sortedPairs(actual),
      expectedDeclarations(expected),
      `${subpath} declaration names or kinds changed`
    );
    for (const name of ABSENT_PUBLIC_NAMES[subpath] ?? []) {
      assert.equal(
        actual.some(([actualName]) => actualName === name),
        false,
        `${subpath} declarations leaked ${name}`
      );
    }
  }

  const consumerSource = program.getSourceFile(consumerTypeFile);
  const clientAlias = consumerSource.statements.find(
    (statement) =>
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === "GoldenClient"
  );
  assert.ok(clientAlias, "GoldenClient alias is missing");
  const clientType = checker.getTypeFromTypeNode(clientAlias.type);
  const clientCapabilities = checker
    .getPropertiesOfType(clientType)
    .map((property) => property.name)
    .filter((name) => name.startsWith("$"));
  assert.deepEqual(sorted(clientCapabilities), PUBLIC_CLIENT_CAPABILITY_KEYS);

  console.log(
    `package surface golden: ${expectedSubpaths.length} packed subpaths passed`
  );
} finally {
  rmSync(consumerRoot, { force: true, recursive: true });
}
