import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const finalRoot = path.resolve(new URL("..", import.meta.url).pathname);
const packagingFile = path.join(finalRoot, "support", "g2-corpus-packaging.json");
const reportFile = path.join(finalRoot, "support", "g2-corpus-retention.json");
const packaging = JSON.parse(await readFile(packagingFile, "utf8"));

async function sha256(file) {
  const bytes = await readFile(file);
  return createHash("sha256").update(bytes).digest("hex");
}

const retained = [];
for (const record of packaging.records) {
  const sourceDirectory = record.directory;
  const destinationParent = path.join(finalRoot, "campaigns", record.campaign);
  const destinationDirectory = path.join(
    destinationParent,
    `seed-${record.firstSeed}.receipt`,
  );

  await mkdir(destinationParent, { recursive: true });
  await stat(path.join(sourceDirectory, record.file));
  await stat(path.join(sourceDirectory, record.childReceipt));

  const archive = path.join(sourceDirectory, record.file);
  if ((await stat(archive)).size !== record.archiveBytes) {
    throw new Error(`Archive byte mismatch: ${archive}`);
  }
  if ((await sha256(archive)) !== record.archiveSha256) {
    throw new Error(`Archive hash mismatch: ${archive}`);
  }

  await rename(sourceDirectory, destinationDirectory);
  retained.push({
    campaign: record.campaign,
    firstSeed: record.firstSeed,
    originalDirectory: sourceDirectory,
    retainedDirectory: path.relative(finalRoot, destinationDirectory),
    archive: path.relative(finalRoot, path.join(destinationDirectory, record.file)),
    archiveBytes: record.archiveBytes,
    archiveSha256: record.archiveSha256,
    originalBytes: record.originalBytes,
    originalSha256: record.originalSha256,
    childReceipt: path.relative(
      finalRoot,
      path.join(destinationDirectory, record.childReceipt),
    ),
  });
}

const report = {
  formatVersion: 1,
  purpose: "Durable retention map for the exact packaged G2 child receipts",
  identity: packaging.identity,
  packagingReport: "support/g2-corpus-packaging.json",
  targetCount: retained.length,
  originalBytes: retained.reduce((total, entry) => total + entry.originalBytes, 0),
  archiveBytes: retained.reduce((total, entry) => total + entry.archiveBytes, 0),
  records: retained,
};

await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `Retained ${report.targetCount} G2 child receipts (${report.archiveBytes} archive bytes).`,
);
