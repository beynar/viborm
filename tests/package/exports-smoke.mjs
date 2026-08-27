import { execFileSync } from "node:child_process";
import {
  accessSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const packageJson = JSON.parse(
  readFileSync(join(repositoryRoot, "package.json"), "utf8")
);
const typeConsumerImports = [];
const runtimeExports = new Map();

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

requireRuntimeFunction("./client", "defineExtension");
requireRuntimeFunction("./client", "defaultOmit");
requireRuntimeFunction("./cache", "cache");
requireRuntimeFunction("./instrumentation", "instrumentation");

const rootRuntimeFile = resolve(
  repositoryRoot,
  packageJson.exports["."].import
);
const clientRuntimeFile = resolve(
  repositoryRoot,
  packageJson.exports["./client"].import
);
typeConsumerImports.push(
  `import type { ClientExtension as RootClientExtension, ExtendedClient as RootExtendedClient, VibORMClient as RootVibORMClient } from ${JSON.stringify(rootRuntimeFile)};`,
  `import type { ClientExtension as ClientSubpathExtension, ExtendedClient as ClientSubpathExtendedClient } from ${JSON.stringify(clientRuntimeFile)};`,
  `import type { ObservationCompletion as RootObservationCompletion, ObservationUnit as RootObservationUnit, ObserveHandler as RootObserveHandler, StatementContext as RootStatementContext, StatementHandler as RootStatementHandler } from ${JSON.stringify(rootRuntimeFile)};`,
  `import type { ObservationCompletion as ClientObservationCompletion, ObservationUnit as ClientObservationUnit, ObserveHandler as ClientObserveHandler, StatementContext as ClientStatementContext, StatementHandler as ClientStatementHandler } from ${JSON.stringify(clientRuntimeFile)};`,
  'const rootExtension: RootClientExtension = { name: "root-type-smoke" };',
  'const clientExtension: ClientSubpathExtension = { name: "client-type-smoke" };',
  "type ExtensionSmokeConfig = { schema: Record<never, never>; driver: never };",
  "declare const extensionSmokeBase: RootVibORMClient<ExtensionSmokeConfig>;",
  'const extensionSmokeDefinition = { name: "package-type-smoke", client: () => ({ $packageTypeSmoke: () => 1 as const }) } as const;',
  "type RootExtendedClientSmoke = RootExtendedClient<typeof extensionSmokeBase, readonly [typeof extensionSmokeDefinition]>;",
  "type ClientSubpathExtendedClientSmoke = ClientSubpathExtendedClient<typeof extensionSmokeBase, readonly [typeof extensionSmokeDefinition]>;",
  "declare const rootExtendedClientSmoke: RootExtendedClientSmoke;",
  "declare const clientSubpathExtendedClientSmoke: ClientSubpathExtendedClientSmoke;",
  "const rootObserver: RootObserveHandler = (unit: RootObservationUnit, proceed: () => Promise<RootObservationCompletion>) => proceed();",
  "const clientObserver: ClientObserveHandler = (unit: ClientObservationUnit, proceed: () => Promise<ClientObservationCompletion>) => proceed();",
  "const rootStatement: RootStatementHandler = (context: RootStatementContext) => context.statement;",
  "const clientStatement: ClientStatementHandler = (context: ClientStatementContext) => context.statement;",
  "void rootExtension;",
  "void clientExtension;",
  "rootExtendedClientSmoke.$packageTypeSmoke();",
  "clientSubpathExtendedClientSmoke.$packageTypeSmoke();",
  "void rootObserver;",
  "void clientObserver;",
  "void rootStatement;",
  "void clientStatement;"
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
    join(repositoryRoot, "node_modules", ".bin", "tsc"),
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
