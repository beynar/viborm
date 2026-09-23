import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const ROOT = "/Users/arnaud/code/viborm";
const { captureRaptor3Identity } = await import(
  `${ROOT}/scripts/raptor3-manifest.mjs`
);
function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(resolve(ROOT, directory), {
    withFileTypes: true,
  })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:ts|mts|mjs|js|json)$/.test(entry.name)) files.push(path);
  }
  return files;
}
const fingerprint = (files) => {
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].sort())
    hash
      .update(file)
      .update("\0")
      .update(readFileSync(resolve(ROOT, file)))
      .update("\0");
  return hash.digest("hex");
};
const configuration = [
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "vitest.config.ts",
  "vitest.workspace.ts",
  "vitest.d1.config.ts",
];
const foreign = "tests/raptor3/g4/review/unit02-phase2";
const identity = captureRaptor3Identity();
const all = [
  ...sourceFiles("tests/raptor3"),
  ...sourceFiles("scripts"),
  ...sourceFiles("benchmarks"),
  "tests/contracts/public-client/cli/_clack.ts",
  ...configuration,
];
const foreignFiles = existsSync(resolve(ROOT, foreign))
  ? all.filter((file) => file.startsWith(`${foreign}/`))
  : [];
const kept = all.filter((file) => !foreignFiles.includes(file));
process.stdout.write(
  `${JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      ...identity,
      harnessDelta: {
        excludedDirectory: foreign,
        excludedFiles: foreignFiles,
        allFiles: all.length,
        keptFiles: kept.length,
        harnessWithAll: fingerprint(all),
        harnessWithoutExcluded: fingerprint(kept),
        openingHarness:
          "32af4729d18119fd133f817ca416c1deee6afb99ff94361965bd3d446c18e0dc",
        reproducesOpeningHarness:
          fingerprint(kept) ===
          "32af4729d18119fd133f817ca416c1deee6afb99ff94361965bd3d446c18e0dc",
      },
    },
    null,
    2
  )}\n`
);
