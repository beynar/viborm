import { execFileSync } from "node:child_process";
import {
  accessSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Decimal from "decimal.js";

const NODE_PROTOCOL_PATTERN = /^node:/;
const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const packageJson = JSON.parse(
  readFileSync(join(repositoryRoot, "package.json"), "utf8")
);
const typeConsumerImports = [];
const runtimeExports = new Map();
const nodeBuiltins = new Set(
  builtinModules.flatMap((specifier) => [
    specifier,
    specifier.replace(NODE_PROTOCOL_PATTERN, ""),
  ])
);
const staticModuleSpecifier =
  /\b(?:import|export)\s*(?:[^"'`;]*?\bfrom\s*)?["']([^"']+)["']/g;

if (Object.hasOwn(packageJson.exports, "./internal/benchmark-operation")) {
  throw new Error(
    "The internal benchmark operation friend must not be exported"
  );
}

let exportIndex = 0;
for (const [exportName, target] of Object.entries(packageJson.exports)) {
  if (!(target && typeof target === "object")) {
    throw new Error(
      `Export ${exportName} must declare import and types targets`
    );
  }
  const runtimeTarget = target.import;
  const typesTarget = target.types;
  if (typeof runtimeTarget !== "string" || typeof typesTarget !== "string") {
    throw new Error(
      `Export ${exportName} must declare string import and types targets`
    );
  }

  const runtimeFile = resolve(repositoryRoot, runtimeTarget);
  const typesFile = resolve(repositoryRoot, typesTarget);
  accessSync(runtimeFile);
  accessSync(typesFile);
  runtimeExports.set(exportName, await import(pathToFileURL(runtimeFile).href));

  typeConsumerImports.push(
    `import * as export${exportIndex} from ${JSON.stringify(runtimeFile)};`,
    `void export${exportIndex};`
  );
  exportIndex += 1;
}

/**
 * Follow only the relative ESM chunks the package build emitted. External
 * dependencies stop the walk; a Node builtin may never occur anywhere in the
 * root/schema/D1 graph that a Worker application loads.
 */
function assertWorkerSafeBuiltGraph(exportNames) {
  const pending = exportNames.map((exportName) => ({
    exportName,
    file: resolve(repositoryRoot, packageJson.exports[exportName].import),
  }));
  const visited = new Set();

  while (pending.length > 0) {
    const entry = pending.pop();
    if (!entry || visited.has(entry.file)) continue;
    visited.add(entry.file);

    const source = readFileSync(entry.file, "utf8");
    staticModuleSpecifier.lastIndex = 0;
    for (const match of source.matchAll(staticModuleSpecifier)) {
      const specifier = match[1];
      if (!specifier) continue;
      if (specifier.startsWith("node:") || nodeBuiltins.has(specifier)) {
        throw new Error(
          `Export ${entry.exportName} reaches Node builtin ${specifier} through ${entry.file}`
        );
      }
      if (!specifier.startsWith(".")) continue;

      const dependency = resolve(dirname(entry.file), specifier);
      if (!dependency.endsWith(".mjs")) continue;
      accessSync(dependency);
      pending.push({ exportName: entry.exportName, file: dependency });
    }
  }
}

assertWorkerSafeBuiltGraph([".", "./schema", "./d1"]);

function requireRuntimeFunction(exportName, member) {
  const namespace = runtimeExports.get(exportName);
  if (typeof namespace?.[member] !== "function") {
    throw new Error(
      `Export ${exportName} must provide runtime function ${member}`
    );
  }
}

function requireRuntimeAbsence(exportName, member) {
  const namespace = runtimeExports.get(exportName);
  if (namespace && member in namespace) {
    throw new Error(`Export ${exportName} must not provide ${member}`);
  }
}

requireRuntimeFunction(".", "defineExtension");
for (const member of [
  "getOperationPayloadSchema",
  "renderOperationResultType",
  "renderSchemaType",
  "validateOperationPayload",
]) {
  requireRuntimeFunction(".", member);
  requireRuntimeFunction("./client", member);
}
const packagedDecimal = runtimeExports.get(".")?.Decimal;
if (packagedDecimal !== Decimal) {
  throw new Error(
    "Export . must re-export the package-resolved decimal.js constructor by identity"
  );
}
if (!(new packagedDecimal("1.2") instanceof Decimal)) {
  throw new Error(
    "Export . must construct values belonging to the package-resolved Decimal family"
  );
}
requireRuntimeAbsence(".", "defaultOmit");
requireRuntimeAbsence(".", "instrumentation");
requireRuntimeAbsence(".", "readBenchmarkOperation");
// The approximate-number scalar, on the BUILT builder. The source barrel pins
// the whole key set; this pins that bundling publishes the surviving factory
// and publishes no retired one.
const schemaBuilder = runtimeExports.get("./schema")?.s;
if (typeof schemaBuilder?.number !== "function") {
  throw new Error("Export ./schema must provide the s.number() scalar factory");
}
if (schemaBuilder && "float" in schemaBuilder) {
  throw new Error("Export ./schema must not provide a retired s.float()");
}

// The adapter namespace fact, on the BUILT adapters subpath: one spelling, the
// PostgreSQL default bound, MySQL deliberately unbound, SQLite without the
// member at all.
const packagedAdapters = runtimeExports.get("./adapters");
if (packagedAdapters?.postgresAdapter?.namespace !== "public") {
  throw new Error(
    "Export ./adapters must publish a postgresAdapter bound to the public schema"
  );
}
if (packagedAdapters.mysqlAdapter?.namespace !== undefined) {
  throw new Error("Export ./adapters must publish an unbound mysqlAdapter");
}
if ("namespace" in packagedAdapters.sqliteAdapter) {
  throw new Error(
    "Export ./adapters must publish a sqliteAdapter with no namespace"
  );
}
if (new packagedAdapters.PostgresAdapter("alpha").namespace !== "alpha") {
  throw new Error(
    "Export ./adapters must publish a PostgresAdapter that selects its schema"
  );
}
if (new packagedAdapters.MySQLAdapter("alpha").namespace !== "alpha") {
  throw new Error(
    "Export ./adapters must publish a MySQLAdapter that selects its database"
  );
}
for (const alias of ["databaseNamespace", "databaseSchema", "keyspace"]) {
  if (alias in packagedAdapters.postgresAdapter) {
    throw new Error(`Export ./adapters must not publish the alias ${alias}`);
  }
}

// The persistent-table renderer, on the BUILT bundle: an optional alias is the
// published signature, so both forms must survive bundling.
const packagedTableRenders = [
  [
    packagedAdapters.postgresAdapter.identifiers.table("users"),
    '"public"."users"',
  ],
  [
    packagedAdapters.postgresAdapter.identifiers.table("users", "t0"),
    '"public"."users" AS "t0"',
  ],
  [packagedAdapters.mysqlAdapter.identifiers.table("users"), "`users`"],
  [
    new packagedAdapters.MySQLAdapter("alpha").identifiers.table("users", "t0"),
    "`alpha`.`users` AS `t0`",
  ],
  [packagedAdapters.sqliteAdapter.identifiers.table("users"), '"users"'],
];
for (const [fragment, expected] of packagedTableRenders) {
  if (fragment.toStatement() !== expected) {
    throw new Error(
      `Export ./adapters must render ${expected}, got ${fragment.toStatement()}`
    );
  }
}

// The two driver-installed facts, on the BUILT bundles: the bundler must not
// re-declare either member as a class field, which would silently replace the
// installed property with `undefined`.
const packagedPgDriver = new (runtimeExports.get("./pg").PgDriver)({
  namespace: "alpha",
});
if (packagedPgDriver.adapter.namespace !== "alpha") {
  throw new Error(
    "Export ./pg must build a driver whose adapter carries the selected schema"
  );
}
if (Reflect.set(packagedPgDriver, "adapter", {})) {
  throw new Error("Export ./pg must build a non-writable adapter reference");
}
const packagedMySQL2Driver = new (runtimeExports.get("./mysql2").MySQL2Driver)({
  namespace: "alpha",
  migrationNamespaceAttestation: "non-redirecting",
});
if (packagedMySQL2Driver.migrationNamespaceAttestation !== "non-redirecting") {
  throw new Error(
    "Export ./mysql2 must build a driver carrying its transport assertion"
  );
}
if (
  Reflect.set(packagedMySQL2Driver, "migrationNamespaceAttestation", undefined)
) {
  throw new Error(
    "Export ./mysql2 must build a non-writable transport assertion"
  );
}

requireRuntimeFunction("./client", "defineExtension");
requireRuntimeFunction("./client", "defaultOmit");
// The migration context is internal. Its raw, lock, tracking and statement
// methods would be a public route around the one estate gate and the one
// live-capability admission decision, so the bundled surface must not carry it.
requireRuntimeFunction("./migrations", "createMigrationClient");
requireRuntimeFunction("./migrations", "createFsStorageWriter");
requireRuntimeFunction("./migrations", "lenientResolver");
for (const operation of [
  "generate",
  "checkEstate",
  "apply",
  "push",
  "previewPush",
  "status",
  "verify",
  "log",
  "down",
  "baseline",
  "resolve",
  "reset",
]) {
  requireRuntimeAbsence("./migrations", operation);
}
requireRuntimeAbsence("./migrations", "MigrationContext");
requireRuntimeAbsence("./migrations", "squash");
requireRuntimeAbsence("./migrations", "journal");
requireRuntimeAbsence("./migrations", "parseStatements");
requireRuntimeAbsence("./migrations", "createFsStorageDriver");
requireRuntimeAbsence("./migrations", "storageDriver");
requireRuntimeAbsence("./migrations", "pending");
requireRuntimeAbsence("./migrations", "MigrationStorageDriver");
requireRuntimeAbsence("./migrations", "diff");
requireRuntimeFunction("./cache", "cache");
requireRuntimeFunction("./instrumentation", "instrumentation");

const adaptersRuntimeFile = resolve(
  repositoryRoot,
  packageJson.exports["./adapters"].import
);
const rootRuntimeFile = resolve(
  repositoryRoot,
  packageJson.exports["."].import
);
const schemaRuntimeFile = resolve(
  repositoryRoot,
  packageJson.exports["./schema"].import
);
const clientRuntimeFile = resolve(
  repositoryRoot,
  packageJson.exports["./client"].import
);
typeConsumerImports.push(
  `import type { DatabaseAdapter as PackagedDatabaseAdapter } from ${JSON.stringify(adaptersRuntimeFile)};`,
  `import { Decimal as PackagedDecimal } from ${JSON.stringify(rootRuntimeFile)};`,
  `import type { GeoPoint as SchemaGeoPoint } from ${JSON.stringify(schemaRuntimeFile)};`,
  `import type { ClientExtension as RootClientExtension, ExtendedClient as RootExtendedClient, VibORMClient as RootVibORMClient } from ${JSON.stringify(rootRuntimeFile)};`,
  `import type { ClientExtension as ClientSubpathExtension, ExtendedClient as ClientSubpathExtendedClient, OperationPayloadSchema as ClientOperationPayloadSchema, ValidatedOperationPayload as ClientValidatedOperationPayload } from ${JSON.stringify(clientRuntimeFile)};`,
  `import type { ObservationCompletion as RootObservationCompletion, ObservationUnit as RootObservationUnit, ObserveHandler as RootObserveHandler, StatementContext as RootStatementContext, StatementHandler as RootStatementHandler } from ${JSON.stringify(rootRuntimeFile)};`,
  `import type { ObservationCompletion as ClientObservationCompletion, ObservationUnit as ClientObservationUnit, ObserveHandler as ClientObserveHandler, StatementContext as ClientStatementContext, StatementHandler as ClientStatementHandler } from ${JSON.stringify(clientRuntimeFile)};`,
  'const rootExtension: RootClientExtension = { name: "root-type-smoke" };',
  'const clientExtension: ClientSubpathExtension = { name: "client-type-smoke" };',
  'const packagedDecimalValue: PackagedDecimal = new PackagedDecimal("1.2");',
  "const packagedGeoPoint: SchemaGeoPoint = { longitude: 2, latitude: 48 };",
  "type ExtensionSmokeConfig = { schema: Record<never, never>; driver: never };",
  "declare const extensionSmokeBase: RootVibORMClient<ExtensionSmokeConfig>;",
  'const extensionSmokeDefinition = { name: "package-type-smoke", client: () => ({ $packageTypeSmoke: () => 1 as const }) } as const;',
  "type RootExtendedClientSmoke = RootExtendedClient<typeof extensionSmokeBase, readonly [typeof extensionSmokeDefinition]>;",
  "type ClientSubpathExtendedClientSmoke = ClientSubpathExtendedClient<typeof extensionSmokeBase, readonly [typeof extensionSmokeDefinition]>;",
  'type ClientOperationPayloadSchemaSmoke = ClientOperationPayloadSchema<"findMany", never>;',
  'type ClientValidatedPayloadSmoke = ClientValidatedOperationPayload<"findMany", never>;',
  "declare const rootExtendedClientSmoke: RootExtendedClientSmoke;",
  "declare const clientSubpathExtendedClientSmoke: ClientSubpathExtendedClientSmoke;",
  "declare const clientOperationPayloadSchemaSmoke: ClientOperationPayloadSchemaSmoke;",
  "declare const clientValidatedPayloadSmoke: ClientValidatedPayloadSmoke;",
  "const rootObserver: RootObserveHandler = (unit: RootObservationUnit, proceed: () => Promise<RootObservationCompletion>) => proceed();",
  "const clientObserver: ClientObserveHandler = (unit: ClientObservationUnit, proceed: () => Promise<ClientObservationCompletion>) => proceed();",
  "const rootStatement: RootStatementHandler = (context: RootStatementContext) => context.statement;",
  "const clientStatement: ClientStatementHandler = (context: ClientStatementContext) => context.statement;",
  "void rootExtension;",
  "void clientExtension;",
  "void packagedDecimalValue;",
  "void packagedGeoPoint;",
  "rootExtendedClientSmoke.$packageTypeSmoke();",
  "clientSubpathExtendedClientSmoke.$packageTypeSmoke();",
  "void clientOperationPayloadSchemaSmoke;",
  "void clientValidatedPayloadSmoke;",
  "void rootObserver;",
  "void clientObserver;",
  "void rootStatement;",
  "void clientStatement;",
  "declare const packagedAdapter: PackagedDatabaseAdapter;",
  "const packagedNamespace: string | undefined = packagedAdapter.namespace;",
  "const packagedTable: (tableName: string, alias?: string) => unknown = packagedAdapter.identifiers.table;",
  "void packagedNamespace;",
  "void packagedTable;"
);

for (const binTarget of Object.values(packageJson.bin ?? {})) {
  if (typeof binTarget !== "string") {
    throw new Error("Every package bin target must be a string");
  }
  accessSync(resolve(repositoryRoot, binTarget));
}

const consumerRoot = mkdtempSync(join(tmpdir(), "viborm-exports-"));
try {
  const consumerFile = join(consumerRoot, "consumer.ts");
  writeFileSync(consumerFile, `${typeConsumerImports.join("\n")}\n`);
  execFileSync(
    // By path, not `.bin/tsc`: two TypeScripts are installed and that link is
    // whichever won pnpm's bin collision - today the native 7.0.2, which
    // refuses files on the command line beside a tsconfig (TS5112).
    join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
    [
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "es2022",
      "--module",
      "esnext",
      "--moduleResolution",
      "bundler",
      consumerFile,
    ],
    { cwd: repositoryRoot, stdio: "pipe" }
  );
} finally {
  rmSync(consumerRoot, { force: true, recursive: true });
}

console.log(
  `package exports: ${exportIndex} runtime imports and type entries passed`
);
