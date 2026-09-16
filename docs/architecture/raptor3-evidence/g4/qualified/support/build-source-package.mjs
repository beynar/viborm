import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const finalRoot = path.resolve(new URL("..", import.meta.url).pathname);
const repositoryRoot = path.resolve(finalRoot, "../../../../..");
const baselineCommit = "0f25637bcd73b3f402c0bb41aadbb70e67a0a964";

/**
 * The exact task file set of this package (the performance pass on top of the
 * committed G4 tree `0f25637b`).
 *
 * Scope is a path list, not a judgement: everything dirty under these paths is
 * task source. `benchmarks/` is inside the frozen harness identity and carries
 * the D-8 benchmark-contract pin, so it is task source here; it was not in the
 * previous package's scope because nothing under it had changed.
 *
 * Evidence lives under `docs/` and is never patched here: the evidence tree is
 * 9,791 deletions of the previous package plus the receipts this run writes,
 * which reconstruct nothing and would make the patch unusable. The evidence
 * scope is summarised below and enumerated, path by path, in
 * `task-commit-allowlist.json` — that file, not this patch, is what the
 * integrator's commit stages.
 */
const scopes = [
  "scripts",
  "src",
  "tests/raptor3",
  "tests/types/raptor3",
  "benchmarks",
  "vitest.workspace.ts",
];
/** The evidence half of the task file set: listed and hashed, never patched. */
const evidenceScopes = [
  "docs/architecture/raptor3-evidence/g4.md",
  "docs/architecture/raptor3-evidence/g4",
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
/** Untracked dirty work outside every scope above, named so it is excluded on purpose. */
const excludedUntracked = [
  "exa-results/",
  "the eight untracked transport-*-corpus.json files at the repository root",
  "the pre-G4 untracked evidence archives at docs/architecture/raptor3-evidence/*.gz and *.json",
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
assert(
  !tracked.concat(untracked).some((file) => /^transport-.*-corpus\.json$/.test(file)),
  "the untracked root transport corpora never enter the source patch",
);

/**
 * The evidence half of the task file set, counted from the same `git status`
 * the commit allowlist enumerates. Deletions matter: this package replaces the
 * previous sealed package, whose files the integrator's commit must remove.
 */
const staleAttemptDirectory = /(^|\/)qualified-attempt-\d+-stale-identity\//;
const evidenceStatus = { modified: 0, untracked: 0, deleted: 0, excludedStaleAttempt: 0 };
for (const line of git(["status", "--porcelain=v1", "-uall", "--", ...evidenceScopes])
  .split("\n")
  .filter(Boolean)) {
  if (staleAttemptDirectory.test(line.slice(3))) {
    // Superseded attempts stay on disk, unmodified; they are not staged.
    evidenceStatus.excludedStaleAttempt += 1;
    continue;
  }
  const code = line.slice(0, 2);
  if (code === "??") evidenceStatus.untracked += 1;
  else if (code === " D" || code === "D ") evidenceStatus.deleted += 1;
  else if (code === " M" || code === "M " || code === "MM") evidenceStatus.modified += 1;
  else throw new Error(`Unhandled evidence git status code ${JSON.stringify(code)}`);
}

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

/**
 * The patch is checked against the tree it claims to describe: reverse-applying
 * it succeeds only if every "after" side equals the current file. `--check`
 * writes nothing, so this verification cannot disturb the frozen tree.
 */
const reverseCheck = spawnSync("git", ["apply", "--check", "-R", patchFile], {
  cwd: repositoryRoot,
  encoding: "utf8",
});
assert.equal(
  reverseCheck.status,
  0,
  `source.patch does not describe the current tree: ${reverseCheck.stderr}`,
);

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
    "Exact performance-pass production, harness registration/tests, benchmark-contract and private architecture-guide changes on top of the committed G4 tree, under scripts/, src/, tests/raptor3/, tests/types/raptor3/, benchmarks/ and vitest.workspace.ts. Qualification documentation and evidence under docs/ are excluded from the patch, as are the unrelated dirty CONTEXT.md, memory.md, Pattern files, exa-results/, the eight untracked root transport-*-corpus.json files and the pre-G4 untracked evidence archives.",
  evidence: {
    scopes: evidenceScopes,
    status: evidenceStatus,
    patched: false,
    boundary:
      "The evidence half of the task file set is listed path by path in task-commit-allowlist.json, not in source.patch: it is the removal of the previous sealed package plus the receipts this qualification wrote, which reconstruct no source.",
    countedWhen:
      "Snapshot taken when this report was written; the package's own sealing files are added afterwards. task-commit-allowlist.json, written last by seal-author-package.mjs, is the authoritative enumeration.",
    excludedStaleAttempts:
      "docs/architecture/raptor3-evidence/g4/qualified-attempt-*-stale-identity/ — the superseded attempts, kept whole on disk and excluded from both the count above and the commit allowlist.",
  },
  excludedDirty,
  excludedUntracked,
  counts: { tracked: tracked.length, untracked: untracked.length, total: records.length },
  files: records,
  sourcePatch: {
    file: "source.patch",
    bytes: patchBytes.length,
    sha256: createHash("sha256").update(patchBytes).digest("hex"),
    composition:
      "git diff --binary against the baseline commit for every tracked change, then git diff --no-index --binary against /dev/null for every untracked file, concatenated in that order",
    apply: `git checkout ${baselineCommit} && git apply source.patch`,
    verifiedAgainstWorkingTree:
      "git apply --check -R source.patch exited 0 against the frozen tree, so every 'after' side of the patch equals the file this qualification ran",
  },
};
await writeFile(path.join(finalRoot, "source-allowlist.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `Source package verified: ${records.length} files (${tracked.length} tracked, ${untracked.length} untracked), ${patchBytes.length} patch bytes.`,
);
