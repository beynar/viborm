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
  `import type { ClientExtension as RootClientExtension } from ${JSON.stringify(rootRuntimeFile)};`,
  `import type { ClientExtension as ClientSubpathExtension } from ${JSON.stringify(clientRuntimeFile)};`,
  'const rootExtension: RootClientExtension = { name: "root-type-smoke" };',
  'const clientExtension: ClientSubpathExtension = { name: "client-type-smoke" };',
  "void rootExtension;",
  "void clientExtension;"
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
