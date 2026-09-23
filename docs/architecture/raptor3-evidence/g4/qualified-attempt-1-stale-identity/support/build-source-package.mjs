import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const finalRoot = path.resolve(new URL("..", import.meta.url).pathname);
const repositoryRoot = path.resolve(finalRoot, "../../../../..");
const baselineCommit = "0cc61e61f372945026b0b564fa643de67168c08e";

/**
 * The exact G4 task file set (packaging brief §3).
 *
 * Scope is a path list, not a judgement: everything dirty under these paths is
 * task source. Evidence lives under `docs/` and is never patched here; the
 * excluded list below names the dirty work that is NOT this task's.
 */
const scopes = [
  "scripts",
  "src",
  "tests/raptor3",
  "tests/types/raptor3",
  "tests/contracts/adapters/dialect-vocabulary.core.test.ts",
  "vitest.workspace.ts",
];
/** Everything `captureRaptor3Identity` hashes, so a tracked change cannot escape the allowlist. */
const identityScope = [
  "scripts",
  "src",
  "tests",
  "benchmarks",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "vitest.config.ts",
  "vitest.workspace.ts",
  "vitest.d1.config.ts",
];
const excludedDirty = [
  "CONTEXT.md",
  "memory.md",
  "tests/pattern/pack/program-dump.ts",
  "tests/pattern/match/decode-malformed.core.test.ts",
];

function git(args, encoding = "utf8") {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

/** `git diff --no-index` exits 1 when the two inputs differ, which is the point here. */
function gitDiffNoIndex(file, encoding = "utf8") {
  const result = spawnSync("git", ["diff", "--no-index", "--binary", "--", "/dev/null", file], {
    cwd: repositoryRoot,
    encoding,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr?.toString() || `git diff --no-index ${file} failed`);
  }
  return result.stdout;
}

const statusLines = git(["status", "--porcelain=v1", "-uall", "--", ...scopes])
  .split("\n")
  .filter(Boolean);
const tracked = [];
const untracked = [];
for (const line of statusLines) {
  const code = line.slice(0, 2);
  const file = line.slice(3);
  if (code === "??") untracked.push(file);
  else if (code === " M" || code === "M " || code === "MM") tracked.push(file);
  else throw new Error(`Unhandled git status code ${JSON.stringify(code)} for ${file}`);
}
tracked.sort();
untracked.sort();

// No tracked change anywhere in the identity scope may sit outside the allowlist.
const identityChanged = git(["diff", "--name-only", baselineCommit, "--", ...identityScope])
  .split("\n")
  .filter(Boolean)
  .sort();
assert.deepEqual(
  identityChanged.filter((file) => !excludedDirty.includes(file)),
  tracked,
  "tracked identity-scope changes equal the G4 task file set",
);
for (const file of excludedDirty) {
  assert(!tracked.includes(file), `${file} is excluded unrelated dirty work`);
  assert(!untracked.includes(file), `${file} is excluded unrelated dirty work`);
}
assert(
  !tracked.concat(untracked).some((file) => file.startsWith("docs/") || file.startsWith("exa-results/")),
  "documentation and exa-results never enter the source patch",
);

const patchParts = [git(["diff", "--binary", baselineCommit, "--", ...tracked], null)];
for (const file of untracked) patchParts.push(Buffer.from(gitDiffNoIndex(file, "buffer")));
const patchFile = path.join(finalRoot, "source.patch");
await writeFile(patchFile, Buffer.concat(patchParts.map((part) => Buffer.from(part))));

const records = [];
for (const [file, baseline] of [
  ...tracked.map((file) => [file, "tracked"]),
  ...untracked.map((file) => [file, "untracked"]),
]) {
  const absolute = path.join(repositoryRoot, file);
  const bytes = await readFile(absolute);
  records.push({
    file,
    baseline,
    bytes: (await stat(absolute)).size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
records.sort((left, right) => left.file.localeCompare(right.file));

const patchBytes = await readFile(patchFile);
const identity = JSON.parse(
  await readFile(path.join(finalRoot, "support", "final-identity.json"), "utf8"),
);
const report = {
  formatVersion: 1,
  milestone: "g4",
  baselineCommit,
  frozenIdentity: { production: identity.production, harness: identity.harness },
  scope:
    "Exact G4 production, route, harness registration/tests and private architecture-guide changes under scripts/, src/, tests/raptor3/, tests/types/raptor3/, tests/contracts/adapters/dialect-vocabulary.core.test.ts and vitest.workspace.ts. Qualification documentation and evidence under docs/ are excluded, as are the unrelated dirty CONTEXT.md, memory.md, Pattern files, exa-results/ and the pre-G4 untracked evidence archives.",
  excludedDirty,
  counts: { tracked: tracked.length, untracked: untracked.length, total: records.length },
  files: records,
  sourcePatch: {
    file: "source.patch",
    bytes: patchBytes.length,
    sha256: createHash("sha256").update(patchBytes).digest("hex"),
    composition:
      "git diff --binary against the baseline commit for every tracked change, then git diff --no-index --binary against /dev/null for every untracked file, concatenated in that order",
    apply: `git checkout ${baselineCommit} && git apply source.patch`,
  },
};
await writeFile(path.join(finalRoot, "source-allowlist.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `Source package verified: ${records.length} files (${tracked.length} tracked, ${untracked.length} untracked), ${patchBytes.length} patch bytes.`,
);
