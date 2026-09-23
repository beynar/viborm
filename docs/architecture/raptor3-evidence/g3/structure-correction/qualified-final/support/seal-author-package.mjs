import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const finalRoot = path.resolve(new URL("..", import.meta.url).pathname);
const structureCorrectionRoot = path.dirname(finalRoot);
const repositoryRoot = path.resolve(finalRoot, "../../../../../..");
const retainedManifestFile = path.join(finalRoot, "retained-files.json");
const checksumFile = path.join(finalRoot, "SHA256SUMS");
const commitAllowlistFile = path.join(finalRoot, "task-commit-allowlist.json");
const identity = JSON.parse(await readFile(path.join(finalRoot, "support", "final-identity.json"), "utf8"));

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

const exactTrackedFiles = [
  "docs/architecture/raptor3-evidence/g3.md",
  "docs/architecture/raptor3-implementation-plan.md",
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
const evidenceFiles = (await listFiles(structureCorrectionRoot)).map((file) =>
  path.relative(repositoryRoot, file),
);
const predictedSealFiles = [
  path.relative(repositoryRoot, commitAllowlistFile),
  path.relative(repositoryRoot, retainedManifestFile),
  path.relative(repositoryRoot, checksumFile),
];
const commitFiles = [...new Set([
  ...exactTrackedFiles,
  ...evidenceFiles,
  ...predictedSealFiles,
])].sort();
const commitAllowlist = {
  formatVersion: 1,
  baselineCommit: "cf2cbc4e6eed445816e70b0d98ca117db90c86b0",
  purpose: "Exact author task commit allowlist before independent qualification and root acceptance",
  approvalStatus: "root-approval-pending-do-not-stage-or-commit",
  fileCount: commitFiles.length,
  files: commitFiles,
  externalReviewAttestations: "The pending qualification-review and root attestations are not listed because they do not yet exist and must remain outside the sealed author checksum tree. Root adds each exact reviewed path separately after acceptance.",
  knownExcludedDirty: [
    "CONTEXT.md",
    "memory.md",
    "tests/pattern/pack/program-dump.ts",
    "tests/pattern/match/decode-malformed.core.test.ts",
    "exa-results/",
    "all docs/architecture/raptor3-evidence paths outside g3/structure-correction/",
    "repository-root transport-*-corpus.json files",
  ],
};
await writeFile(commitAllowlistFile, `${JSON.stringify(commitAllowlist, null, 2)}\n`);

const retainedFiles = (await listFiles(finalRoot)).filter(
  (file) => file !== retainedManifestFile && file !== checksumFile,
);
const retainedEntries = [];
let retainedBytes = 0;
for (const file of retainedFiles) {
  const bytes = (await stat(file)).size;
  retainedBytes += bytes;
  retainedEntries.push({
    file: path.relative(finalRoot, file),
    bytes,
    sha256: await sha256(file),
  });
}
const retainedManifest = {
  formatVersion: 1,
  pathRoot: path.relative(repositoryRoot, finalRoot),
  frozenIdentity: {
    production: identity.production,
    harness: identity.harness,
  },
  policy: "Retain every current author-package file, including raw reports, selected replay inputs, every compressed G2/G3 child receipt, and the interrupted ENOSPC diagnostic. Review attestations remain outside this sealed tree.",
  checksumFile: "SHA256SUMS",
  manifestSelfEntry: "SHA256SUMS contains retained-files.json; this manifest does not contain itself, which avoids a circular digest.",
  retained: {
    files: retainedEntries.length,
    bytes: retainedBytes,
    entries: retainedEntries,
  },
};
await writeFile(retainedManifestFile, `${JSON.stringify(retainedManifest, null, 2)}\n`);

const checksumFiles = (await listFiles(finalRoot)).filter((file) => file !== checksumFile);
const checksumLines = [];
for (const file of checksumFiles) {
  checksumLines.push(`${await sha256(file)}  ${path.relative(finalRoot, file)}`);
}
await writeFile(checksumFile, `${checksumLines.join("\n")}\n`);
console.log(
  `Sealed ${checksumFiles.length} files; commit allowlist has ${commitFiles.length} exact paths.`,
);
