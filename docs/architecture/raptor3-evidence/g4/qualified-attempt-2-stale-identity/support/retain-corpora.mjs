import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { CAMPAIGN_RETENTION, COMPACT_FILES } from "./campaign-retention.mjs";

/**
 * `--move` relinquishes the lane copy after the retained archive is re-hashed.
 *
 * Copy is the default so a failed retention never costs the only copy of a
 * corpus. Pass `--move` only when free disk cannot hold both, and only after
 * the retained bytes and hash have been re-proved — which is where the removal
 * happens below, never before.
 */
const moveAfterVerify = process.argv.includes("--move");

const finalRoot = path.resolve(new URL("..", import.meta.url).pathname);
const packagingFile = path.join(finalRoot, "support", "corpus-packaging.json");
const reportFile = path.join(finalRoot, "support", "corpus-retention.json");
const packaging = JSON.parse(await readFile(packagingFile, "utf8"));

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function copyDirectory(source, destination) {
  await mkdir(destination, { recursive: true });
  const copied = [];
  for (const entry of await readdir(source, { withFileTypes: true })) {
    assert(entry.isFile(), `Unexpected non-file child receipt entry ${entry.name} in ${source}`);
    await copyFile(path.join(source, entry.name), path.join(destination, entry.name));
    copied.push(entry.name);
  }
  return copied.sort();
}

const retained = [];
for (const record of packaging.records) {
  const destinationParent = path.join(finalRoot, "campaigns", record.campaign);
  const destinationDirectory = path.join(destinationParent, `seed-${record.firstSeed}.receipt`);
  await mkdir(destinationParent, { recursive: true });

  const sourceArchive = path.join(record.directory, record.file);
  if ((await stat(sourceArchive)).size !== record.archiveBytes) {
    throw new Error(`Archive byte mismatch: ${sourceArchive}`);
  }
  if ((await sha256(sourceArchive)) !== record.archiveSha256) {
    throw new Error(`Archive hash mismatch: ${sourceArchive}`);
  }

  const files = await copyDirectory(record.directory, destinationDirectory);
  const retainedArchive = path.join(destinationDirectory, record.file);
  if ((await stat(retainedArchive)).size !== record.archiveBytes) {
    throw new Error(`Retained archive byte mismatch: ${retainedArchive}`);
  }
  if ((await sha256(retainedArchive)) !== record.archiveSha256) {
    throw new Error(`Retained archive hash mismatch: ${retainedArchive}`);
  }
  if (moveAfterVerify) await rm(record.directory, { recursive: true, force: true });

  retained.push({
    campaign: record.campaign,
    retention: "all",
    firstSeed: record.firstSeed,
    originalDirectory: record.directory,
    retainedDirectory: path.relative(finalRoot, destinationDirectory),
    files,
    archive: path.relative(finalRoot, retainedArchive),
    archiveBytes: record.archiveBytes,
    archiveSha256: record.archiveSha256,
    originalBytes: record.originalBytes,
    originalSha256: record.originalSha256,
    childReceipt: path.relative(finalRoot, path.join(destinationDirectory, record.childReceipt)),
  });
}

// G3P06: the one required compact child, corpus deliberately not retained.
const compact = [];
for (const [campaign, family] of Object.entries(CAMPAIGN_RETENTION)) {
  if (family !== "compact") continue;
  const manifestFile = path.join(finalRoot, "campaigns", `${campaign}.receipt`, "verified.json");
  if (!existsSync(manifestFile)) throw new Error(`Missing campaign parent receipt: ${manifestFile}`);
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const batch = manifest.batches[0];
  const destinationDirectory = path.join(
    finalRoot,
    "campaigns",
    campaign,
    `seed-${batch.firstSeed}.receipt`,
  );
  await mkdir(destinationDirectory, { recursive: true });
  const files = [];
  for (const name of COMPACT_FILES) {
    const source = path.join(batch.directory, name);
    if (!existsSync(source)) throw new Error(`Missing compact child file: ${source}`);
    await copyFile(source, path.join(destinationDirectory, name));
    files.push({ file: name, sha256: await sha256(path.join(destinationDirectory, name)) });
  }
  compact.push({
    campaign,
    retention: "compact",
    firstSeed: batch.firstSeed,
    originalDirectory: batch.directory,
    retainedDirectory: path.relative(finalRoot, destinationDirectory),
    files,
    corpusRetained: false,
  });
}

const report = {
  formatVersion: 1,
  purpose: "Durable retention map for the exact packaged G4-qualification child receipts",
  milestone: "g4",
  identity: packaging.identity,
  packagingReport: "support/corpus-packaging.json",
  retentionMode: moveAfterVerify ? "copy-verify-then-remove-lane-copy" : "copy-and-verify",
  retentionFamilies: CAMPAIGN_RETENTION,
  targetCount: retained.length,
  compactCount: compact.length,
  originalBytes: retained.reduce((total, entry) => total + entry.originalBytes, 0),
  archiveBytes: retained.reduce((total, entry) => total + entry.archiveBytes, 0),
  campaigns: [...new Set(retained.map((entry) => entry.campaign))].map((campaign) => {
    const matching = retained.filter((entry) => entry.campaign === campaign);
    return {
      campaign,
      count: matching.length,
      archiveBytes: matching.reduce((total, entry) => total + entry.archiveBytes, 0),
      originalBytes: matching.reduce((total, entry) => total + entry.originalBytes, 0),
    };
  }),
  records: retained,
  compact,
};

await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `Retained ${report.targetCount} child receipts (${report.archiveBytes} archive bytes) plus ${report.compactCount} compact receipts.`,
);
