// Reconstruct the harness fingerprint while excluding a named file set, to
// prove which files a mid-round harness move is made of.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = "/Users/arnaud/code/viborm";
const exclude = new Set(process.argv.slice(2));

function sourceFiles(root, directory) {
  const files = [];
  for (const entry of readdirSync(resolve(root, directory), {
    withFileTypes: true,
  })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...sourceFiles(root, path));
    else if (/\.(?:ts|mts|mjs|js|json)$/.test(entry.name)) files.push(path);
  }
  return files;
}

function fingerprint(root, files) {
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].sort())
    hash
      .update(file)
      .update("\0")
      .update(readFileSync(resolve(root, file)))
      .update("\0");
  return hash.digest("hex");
}

const configuration = [
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "vitest.config.ts",
  "vitest.workspace.ts",
  "vitest.d1.config.ts",
];

const all = [
  ...sourceFiles(ROOT, "tests/raptor3"),
  ...sourceFiles(ROOT, "scripts"),
  ...sourceFiles(ROOT, "benchmarks"),
  "tests/contracts/public-client/cli/_clack.ts",
  ...configuration,
];
const kept = all.filter((file) => !exclude.has(file));
console.log(
  JSON.stringify(
    {
      files: all.length,
      excluded: [...exclude],
      keptFiles: kept.length,
      harnessWithAll: fingerprint(ROOT, all),
      harnessWithoutExcluded: fingerprint(ROOT, kept),
    },
    null,
    2
  )
);
