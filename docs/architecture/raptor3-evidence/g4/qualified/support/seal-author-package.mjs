import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const finalRoot = path.resolve(new URL("..", import.meta.url).pathname);
const evidenceRoot = path.dirname(finalRoot); // docs/architecture/raptor3-evidence/g4
const repositoryRoot = path.resolve(finalRoot, "../../../../..");
const retainedManifestFile = path.join(finalRoot, "retained-files.json");
const checksumFile = path.join(finalRoot, "SHA256SUMS");
const commitAllowlistFile = path.join(finalRoot, "task-commit-allowlist.json");
const baselineCommit = "0f25637bcd73b3f402c0bb41aadbb70e67a0a964";
const identity = JSON.parse(
  await readFile(path.join(finalRoot, "support", "final-identity.json"), "utf8"),
);
const sourceAllowlist = JSON.parse(
  await readFile(path.join(finalRoot, "source-allowlist.json"), "utf8"),
);

async function listFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  await visit(root);
  return files.sort();
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

// 1. The commit allowlist: the exact task source set plus the whole G4 evidence tree.
const sourceFiles = sourceAllowlist.files.map((record) => record.file);

/**
 * The evidence half is everything **dirty or untracked** under `g4.md` and
 * `g4/` — which is exactly what a commit can stage. It is derived from
 * `git status`, not from a directory walk, so the list is verifiable line for
 * line against `git status --porcelain=v1 -uall` and carries no path the commit
 * would touch as a no-op. A file under `g4/` that is committed and unchanged is
 * therefore absent by construction, not by a filter.
 *
 * Nothing under `g4/` is filtered out any more, and the superseded attempts
 * fall out of that one rule instead of a name match: attempts 1 and 2 are
 * committed in `0f25637b` and unchanged, so git reports nothing for them (this
 * script asserts that rather than assuming it); attempt 4's untracked
 * tooling-only receipts are reported, and the integrator's decision is to commit
 * them, because the ledger references them as the launch abort's evidence.
 * Attempt 3 is the package this one replaces: it is committed in `0f25637b` and
 * its files were moved out of the tree, so what remains of it here is the
 * deletions below.
 */
const evidencePathspec = [
  "docs/architecture/raptor3-evidence/g4.md",
  "docs/architecture/raptor3-evidence/g4",
];
const evidenceStatus = (() => {
  const result = spawnSync("git", ["status", "--porcelain=v1", "-uall", "--", ...evidencePathspec], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || "git status failed");
  return result.stdout
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => ({ code: line.slice(0, 2), file: line.slice(3) }));
})();

/**
 * Only working-tree states are expected: modified, untracked, deleted. A staged
 * or renamed entry would mean someone touched the index, which this task never
 * does, and the allowlist would no longer describe what the integrator is about
 * to stage — so it fails loudly instead of listing it.
 */
const statusCodeCounts = {};
for (const entry of evidenceStatus) {
  statusCodeCounts[entry.code] = (statusCodeCounts[entry.code] ?? 0) + 1;
}
const unexpectedCodes = Object.keys(statusCodeCounts).filter(
  (code) => code !== " M" && code !== "??" && code !== " D",
);
if (unexpectedCodes.length > 0) {
  throw new Error(`unexpected git status codes in the evidence tree: ${unexpectedCodes.join(", ")}`);
}

/** Attempts 1 and 2 must be committed and unchanged; a dirty one is a decision, not a default. */
const committedStaleAttempts = /(^|\/)qualified-attempt-[12]-stale-identity\//;
const dirtyCommittedAttempts = evidenceStatus.filter((entry) =>
  committedStaleAttempts.test(entry.file),
);
if (dirtyCommittedAttempts.length > 0) {
  throw new Error(
    `qualification attempts 1-2 are expected committed and unchanged, but git reports ${dirtyCommittedAttempts.length} dirty paths under them`,
  );
}

const evidenceFiles = evidenceStatus
  .filter((entry) => entry.code !== " D")
  .map((entry) => entry.file)
  .sort();

/**
 * The previous sealed package (attempt 3, committed in `0f25637b`) was moved
 * out of the tree by the integrator. Its paths are deletions the commit must
 * stage, so they belong in the allowlist even though no file is there to walk.
 */
const deletedEvidenceFiles = evidenceStatus
  .filter((entry) => entry.code === " D")
  .map((entry) => entry.file)
  .sort();
const predictedSealFiles = [
  path.relative(repositoryRoot, commitAllowlistFile),
  path.relative(repositoryRoot, retainedManifestFile),
  path.relative(repositoryRoot, checksumFile),
];
const commitFiles = [
  ...new Set([
    ...sourceFiles,
    ...evidenceFiles,
    ...deletedEvidenceFiles,
    ...predictedSealFiles,
  ]),
].sort();
const commitAllowlist = {
  formatVersion: 1,
  milestone: "g4",
  baselineCommit,
  purpose: "Exact author task commit allowlist before independent qualification and root acceptance",
  approvalStatus: "root-approval-pending-do-not-stage-or-commit",
  scope: {
    source:
      "Everything dirty under scripts/, src/, tests/raptor3/, tests/types/raptor3/, benchmarks/ and vitest.workspace.ts, as listed by source-allowlist.json",
    evidence:
      "Everything dirty or untracked under docs/architecture/raptor3-evidence/g4.md and the docs/architecture/raptor3-evidence/g4/ tree, exactly as git status --porcelain=v1 -uall reports it: the qualified/ package, the finished cutover stage-2c receipts under g4/cutover/, g4/final-report.md, and — integrator decision — the untracked tooling-only receipts of the aborted attempt 4 under g4/qualified-attempt-4-stale-identity/. Attempts 1 and 2 are committed in 0f25637b and unchanged, so git reports nothing for them and they are not listed; this script fails if that stops being true. Committed, unchanged files elsewhere under g4/ are likewise absent: a commit has nothing to stage for them.",
    deletions:
      "The previous sealed package (qualification attempt 3, committed in 0f25637b) was moved out of the tree by the integrator before this attempt. Most of its paths are written again by this attempt and appear above as ordinary modified files; what remains here is what attempt 3 had and this package does not — the structural-measurement/ directory, which this attempt's driver writes as structure/. Every one of these deleted paths is in the list so that the commit records the replacement rather than leaving the superseded package half-present.",
  },
  counts: {
    source: sourceFiles.length,
    evidence: evidenceFiles.length,
    deleted: deletedEvidenceFiles.length,
    total: commitFiles.length,
  },
  gitStatusCodeCounts: statusCodeCounts,
  deletedEvidenceFiles,
  files: commitFiles,
  externalReviewAttestations:
    "The pending qualification-review and root attestations are not listed because they do not yet exist and must remain outside the sealed author checksum tree. Root adds each exact reviewed path separately after acceptance.",
  knownExcludedDirty: [
    "CONTEXT.md",
    "memory.md",
    "tests/pattern/pack/program-dump.ts",
    "tests/pattern/match/decode-malformed.core.test.ts",
    "exa-results/ (2 untracked files)",
    "the eight untracked transport-*-corpus.json files at the repository root",
    "docs/architecture/raptor3-g4-claude-handoff.md",
    "the pre-G4 evidence archives at docs/architecture/raptor3-evidence/*.gz, *.tar.gz, *.sha256 and *.json",
    "every docs/architecture/raptor3-evidence path outside g4.md and g4/ — the g3/ and g3-prep-*/ milestone trees above all",
    "docs/architecture/raptor3-evidence/g4/qualified-attempt-{1,2}-stale-identity/ — committed in 0f25637b and unchanged, so there is nothing to stage; kept whole on disk either way",
  ],
  verification:
    "Every path in files[] is reported dirty or untracked by git status --porcelain=v1 -uall, and every path git reports under the two evidence pathspecs is in files[]; checked in both directions at seal time.",
};
await writeFile(commitAllowlistFile, `${JSON.stringify(commitAllowlist, null, 2)}\n`);
if (process.argv.includes("--allowlist-only")) {
  // The allowlist is drafted while the runs are still writing; the seal is not.
  console.log(`Commit allowlist drafted with ${commitFiles.length} exact paths.`);
  process.exit(0);
}

// 2. Hash the package once; retained-files.json and SHA256SUMS share the digests.
const packageFiles = (await listFiles(finalRoot)).filter(
  (file) => file !== retainedManifestFile && file !== checksumFile,
);
const digests = new Map();
const retainedEntries = [];
let retainedBytes = 0;
for (const file of packageFiles) {
  const bytes = (await stat(file)).size;
  const digest = await sha256(file);
  digests.set(file, digest);
  retainedBytes += bytes;
  retainedEntries.push({ file: path.relative(finalRoot, file), bytes, sha256: digest });
}
const retainedManifest = {
  formatVersion: 1,
  milestone: "g4",
  pathRoot: path.relative(repositoryRoot, finalRoot),
  frozenIdentity: { production: identity.production, harness: identity.harness },
  policy:
    "Retain every current author-package file: raw reports and logs, every mode and campaign parent receipt, every retained compressed child receipt of the four G4 and the inherited campaigns, the G3P06 compact children, the selected replay receipts and the stale-identity refusal logs. Review attestations remain outside this sealed tree.",
  checksumFile: "SHA256SUMS",
  manifestSelfEntry:
    "SHA256SUMS contains retained-files.json; this manifest does not contain itself, which avoids a circular digest.",
  retained: { files: retainedEntries.length, bytes: retainedBytes, entries: retainedEntries },
};
await writeFile(retainedManifestFile, `${JSON.stringify(retainedManifest, null, 2)}\n`);

// 3. SHA256SUMS covers everything except itself, including retained-files.json.
const checksumLines = packageFiles.map(
  (file) => `${digests.get(file)}  ${path.relative(finalRoot, file)}`,
);
checksumLines.push(
  `${await sha256(retainedManifestFile)}  ${path.relative(finalRoot, retainedManifestFile)}`,
);
checksumLines.sort((left, right) => left.slice(66).localeCompare(right.slice(66)));
await writeFile(checksumFile, `${checksumLines.join("\n")}\n`);
console.log(
  `Sealed ${checksumLines.length} files (${retainedBytes} bytes); commit allowlist has ${commitFiles.length} exact paths.`,
);
