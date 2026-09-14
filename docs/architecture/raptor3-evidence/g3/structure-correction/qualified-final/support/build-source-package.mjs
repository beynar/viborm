import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const finalRoot = path.resolve(new URL("..", import.meta.url).pathname);
const repositoryRoot = path.resolve(finalRoot, "../../../../../..");
const baselineCommit = "cf2cbc4e6eed445816e70b0d98ca117db90c86b0";
const files = [
  "scripts/raptor3-manifest.mjs",
  "src/query-engine/raptor3/AGENTS.md",
  "src/query-engine/raptor3/commands/execution.ts",
  "src/query-engine/raptor3/program/program.ts",
  "src/query-engine/raptor3/shared/operation-context.ts",
  "src/query-engine/raptor3/shared/query.ts",
  "tests/raptor3/g3/author-execution-regressions.test.ts",
  "tests/raptor3/g3/bulk-result-boundary.test.ts",
  "tests/raptor3/g3/review-execution-boundaries.test.ts",
];

function git(args, encoding = "utf8") {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding });
  if (result.status !== 0) throw new Error(result.stderr?.toString() || `git ${args.join(" ")} failed`);
  return result.stdout;
}

const changedIdentityScope = git([
  "diff",
  "--name-only",
  baselineCommit,
  "--",
  "scripts",
  "src",
  "tests/raptor3",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "vitest.config.ts",
  "vitest.workspace.ts",
  "vitest.d1.config.ts",
]).trim().split("\n").filter(Boolean).sort();
assert.deepEqual(changedIdentityScope, [...files].sort());

const patch = git(["diff", "--binary", baselineCommit, "--", ...files], null);
const patchFile = path.join(finalRoot, "source.patch");
await writeFile(patchFile, patch);

const records = [];
for (const file of files) {
  const absolute = path.join(repositoryRoot, file);
  const bytes = await readFile(absolute);
  records.push({
    file,
    baseline: "tracked",
    bytes: (await stat(absolute)).size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
const patchBytes = await readFile(patchFile);
const identity = JSON.parse(await readFile(path.join(finalRoot, "support", "final-identity.json"), "utf8"));
const report = {
  formatVersion: 1,
  baselineCommit,
  frozenIdentity: {
    production: identity.production,
    harness: identity.harness,
  },
  scope: "Exact structural-correction production, harness registration/tests, and private architecture-guide changes. Qualification documentation/evidence and unrelated CONTEXT.md, memory.md, Pattern work, and historical archives are excluded.",
  files: records,
  sourcePatch: {
    file: "source.patch",
    bytes: patchBytes.length,
    sha256: createHash("sha256").update(patchBytes).digest("hex"),
  },
};
await writeFile(path.join(finalRoot, "source-allowlist.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Source package verified: ${records.length} files, ${patchBytes.length} patch bytes.`);
