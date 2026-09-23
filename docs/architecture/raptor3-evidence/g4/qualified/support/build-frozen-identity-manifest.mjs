import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// G4 layout: docs/architecture/raptor3-evidence/g4/qualified/support -> repository root
const finalRoot = path.resolve(new URL("..", import.meta.url).pathname);
const repositoryRoot = path.resolve(finalRoot, "../../../../..");
const outputFile = path.join(finalRoot, "support", "frozen-identity-manifest.json");
const { captureRaptor3Identity } = await import(
  pathToFileURL(path.join(repositoryRoot, "scripts", "raptor3-manifest.mjs"))
);

async function sourceFiles(directory) {
  const absolute = path.join(repositoryRoot, directory);
  const files = [];
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await sourceFiles(file)));
    else if (/\.(?:ts|mts|mjs|js|json)$/.test(entry.name)) files.push(file);
  }
  return files;
}

const configuration = [
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "vitest.config.ts",
  "vitest.workspace.ts",
  "vitest.d1.config.ts",
];
const productionFiles = [...(await sourceFiles("src")), ...configuration];
const harnessFiles = [
  ...(await sourceFiles("tests/raptor3")),
  ...(await sourceFiles("scripts")),
  ...(await sourceFiles("benchmarks")),
  "tests/contracts/public-client/cli/_clack.ts",
  ...configuration,
];

async function fingerprint(files) {
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].sort()) {
    hash.update(file).update("\0").update(await readFile(path.join(repositoryRoot, file))).update("\0");
  }
  return hash.digest("hex");
}

const frozen = JSON.parse(
  await readFile(path.join(finalRoot, "support", "final-identity.json"), "utf8"),
);
const identity = captureRaptor3Identity(repositoryRoot);
assert.equal(await fingerprint(productionFiles), identity.production);
assert.equal(await fingerprint(harnessFiles), identity.harness);
assert.equal(identity.production, frozen.production, "live production identity equals the G4 freeze");
assert.equal(identity.harness, frozen.harness, "live harness identity equals the G4 freeze");

const productionSet = new Set(productionFiles);
const harnessSet = new Set(harnessFiles);
const files = [];
for (const file of [...new Set([...productionFiles, ...harnessFiles])].sort()) {
  const absolute = path.join(repositoryRoot, file);
  const bytes = await readFile(absolute);
  files.push({
    file,
    roles: [
      ...(productionSet.has(file) ? ["production"] : []),
      ...(harnessSet.has(file) ? ["harness"] : []),
    ],
    bytes: (await stat(absolute)).size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

const report = {
  formatVersion: 1,
  purpose: "Complete per-file manifest of the exact captureRaptor3Identity production and harness inputs at the G4 freeze",
  milestone: "g4",
  identity,
  algorithm: "sorted unique path + NUL + file bytes + NUL, SHA-256",
  extensionAdmission: ".ts, .mts, .mjs, .js, and .json under the named trees, plus exact configuration files",
  production: { fileCount: new Set(productionFiles).size },
  harness: { fileCount: new Set(harnessFiles).size },
  files,
};
await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Frozen identity manifest verified: ${files.length} unique files.`);
