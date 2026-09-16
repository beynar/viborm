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
const baselineCommit = "0cc61e61f372945026b0b564fa643de67168c08e";
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
const evidenceFiles = (await listFiles(evidenceRoot)).map((file) =>
  path.relative(repositoryRoot, file),
);
const predictedSealFiles = [
  path.relative(repositoryRoot, commitAllowlistFile),
  path.relative(repositoryRoot, retainedManifestFile),
  path.relative(repositoryRoot, checksumFile),
];
const commitFiles = [
  ...new Set([
    ...sourceFiles,
    "docs/architecture/raptor3-evidence/g4.md",
    ...evidenceFiles,
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
      "Everything dirty under scripts/, src/, tests/raptor3/, tests/types/raptor3/, tests/contracts/adapters/dialect-vocabulary.core.test.ts and vitest.workspace.ts, as listed by source-allowlist.json",
    evidence: "docs/architecture/raptor3-evidence/g4.md and the whole docs/architecture/raptor3-evidence/g4/ tree",
  },
  counts: {
    source: sourceFiles.length,
    evidence: evidenceFiles.length + 1,
    total: commitFiles.length,
  },
  files: commitFiles,
  externalReviewAttestations:
    "The pending qualification-review and root attestations are not listed because they do not yet exist and must remain outside the sealed author checksum tree. Root adds each exact reviewed path separately after acceptance.",
  knownExcludedDirty: [
    "CONTEXT.md",
    "memory.md",
    "tests/pattern/pack/program-dump.ts",
    "tests/pattern/match/decode-malformed.core.test.ts",
    "exa-results/",
    "the pre-G4 untracked evidence archives at docs/architecture/raptor3-evidence/*.gz and *.json",
    "every docs/architecture/raptor3-evidence path outside g4.md and g4/",
  ],
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
