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

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageJson = JSON.parse(
  readFileSync(join(repositoryRoot, "package.json"), "utf8")
);
const typeConsumerImports = [];

let exportIndex = 0;
for (const [exportName, target] of Object.entries(packageJson.exports)) {
  if (!(target && typeof target === "object")) {
    throw new Error(`Export ${exportName} must declare import and types targets`);
  }
  const runtimeTarget = target.import;
  const typesTarget = target.types;
  if (typeof runtimeTarget !== "string" || typeof typesTarget !== "string") {
    throw new Error(`Export ${exportName} must declare string import and types targets`);
  }

  const runtimeFile = resolve(repositoryRoot, runtimeTarget);
  const typesFile = resolve(repositoryRoot, typesTarget);
  accessSync(runtimeFile);
  accessSync(typesFile);
  await import(pathToFileURL(runtimeFile).href);

  typeConsumerImports.push(
    `import * as export${exportIndex} from ${JSON.stringify(runtimeFile)};`,
    `void export${exportIndex};`
  );
  exportIndex += 1;
}

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
