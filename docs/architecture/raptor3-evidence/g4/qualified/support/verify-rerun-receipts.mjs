/**
 * Verifies the two gap-closure re-run receipts against the frozen identity, and
 * writes `support/rerun-verification.json`.
 *
 * The CLI self-test re-ran in the main tree; the source-cost measurement re-ran
 * in the lane-5 worktree, because the main tree's `git status --porcelain`
 * overflows the measuring tool's default 1 MiB `maxBuffer` (that is gap 2's own
 * cause). Measuring in another worktree is only sound if the bytes it read are
 * the frozen bytes, so this script does not stop at "the lane's identity
 * matches": it checks every file the census actually read against
 * `support/frozen-identity-manifest.json`, file by file, by SHA-256.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const finalRoot = path.resolve(new URL("..", import.meta.url).pathname);
const read = async (file) => JSON.parse(await readFile(path.join(finalRoot, file), "utf8"));
const sha256 = async (file) =>
  createHash("sha256")
    .update(await readFile(path.join(finalRoot, file)))
    .digest("hex");

const identity = await read("support/final-identity.json");
const manifest = await read("support/frozen-identity-manifest.json");
const cost = await read("support/source-cost.json");
const frozen = new Map(manifest.files.map((entry) => [entry.file, entry.sha256]));

/** A file the census read but the identity does not hash, or reads differently, breaks the claim. */
function compare(files, label) {
  const outsideIdentity = [];
  const differingFromFreeze = [];
  for (const entry of files) {
    const frozenHash = frozen.get(entry.file);
    if (frozenHash === undefined) outsideIdentity.push(entry.file);
    else if (frozenHash !== entry.sha256) differingFromFreeze.push(entry.file);
  }
  return { label, files: files.length, outsideIdentity, differingFromFreeze };
}

const census = compare(cost.files, "source-cost.json#files (the token-line census)");
const toolIdentity = compare(
  cost.source.sourceIdentity.files,
  "source-cost.json#source.sourceIdentity.files (the tool's own source attestation)",
);

const laneIdentity = await read("support/rerun-lane5-identity.json");
const mainIdentity = await read("support/rerun-main-tree-identity.json");
const identityEqual = (actual) =>
  actual.production === identity.production && actual.harness === identity.harness;

const cliLog = await readFile(path.join(finalRoot, "support/cli-selftest.log"), "utf8");
const cliPass = Number(cliLog.match(/ℹ pass (\d+)\n/)?.[1]);
const cliFail = Number(cliLog.match(/ℹ fail (\d+)\n/)?.[1]);

const verification = {
  formatVersion: 1,
  milestone: "g4",
  purpose:
    "Prove the two gap-closure re-runs were taken on the frozen bytes: the CLI self-test in the main tree, the source-cost census in lane 5, both against g4/freeze/identity.json",
  frozenIdentity: { production: identity.production, harness: identity.harness },
  laneFiveIdentity: {
    receipt: "support/rerun-lane5-identity.json",
    capturedAt: laneIdentity.capturedAt,
    equalToFreeze: identityEqual(laneIdentity),
  },
  mainTreeIdentity: {
    receipt: "support/rerun-main-tree-identity.json",
    capturedAt: mainIdentity.capturedAt,
    equalToFreeze: identityEqual(mainIdentity),
  },
  cliSelfTest: {
    receipt: "support/cli-selftest.log",
    pass: cliPass,
    fail: cliFail,
    keptFirstAttempt: "support/cli-selftest.attempt1-red.log",
  },
  sourceCost: {
    receipt: "support/source-cost.json",
    sha256: await sha256("support/source-cost.json"),
    status: cost.status,
    sourceCommit: cost.source.commit,
    sourceClean: cost.source.clean,
    charged: cost.accounting.charged,
    navigationSubtotal: cost.accounting.navigationSubtotal,
    censusOwner: cost.accounting.censusOwner,
    censusFunctionSha256: cost.accounting.censusFunctionSha256,
    keptFirstAttempt: "support/source-cost.attempt1-enobufs.log",
    censusReadFrozenBytes: census,
    toolSourceAttestation: toolIdentity,
    filesOutsideIdentityAreConfigOnly:
      "captureRaptor3Identity does not hash biome.jsonc or tsdown.config.ts; they are the only files the tool's own attestation covers and the identity does not",
  },
  verdict:
    census.outsideIdentity.length === 0 &&
    census.differingFromFreeze.length === 0 &&
    identityEqual(laneIdentity) &&
    identityEqual(mainIdentity) &&
    cliFail === 0
      ? "both re-runs are on the frozen identity and green"
      : "re-run verification failed — see the lists above",
};
await writeFile(
  path.join(finalRoot, "support/rerun-verification.json"),
  `${JSON.stringify(verification, null, 2)}\n`,
);
console.log(verification.verdict);
console.log(
  `census ${census.files} files: ${census.outsideIdentity.length} outside the identity, ${census.differingFromFreeze.length} differing from the freeze; CLI ${cliPass} pass / ${cliFail} fail.`,
);
