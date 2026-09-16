import { createReadStream, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { CAMPAIGN_RETENTION, COMPACT_FILES, CORPUS_NAMES } from "./campaign-retention.mjs";

const finalRoot = path.resolve(new URL("..", import.meta.url).pathname);
const campaignsRoot = path.join(finalRoot, "campaigns");
const reportFile = path.join(finalRoot, "support", "retained-corpora-audit.json");
const expectedIdentity = JSON.parse(
  await readFile(path.join(finalRoot, "support", "final-identity.json"), "utf8"),
);

function assertIdentity(identity, label) {
  if (
    identity?.production !== expectedIdentity.production ||
    identity?.harness !== expectedIdentity.harness
  ) {
    throw new Error(`Identity mismatch: ${label}`);
  }
}

async function listDirectories(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name));
}

async function hashFile(file) {
  const hash = createHash("sha256");
  await pipeline(
    createReadStream(file),
    new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        callback();
      },
    }),
  );
  return hash.digest("hex");
}

async function hashGunzip(file) {
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(
    createReadStream(file),
    createGunzip(),
    new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        hash.update(chunk);
        callback();
      },
    }),
  );
  return { bytes, sha256: hash.digest("hex") };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

const records = [];
const campaignSummaries = [];
const compactSummaries = [];
let audited = 0;

for (const [campaign, family] of Object.entries(CAMPAIGN_RETENTION)) {
  if (family === "parent") continue;
  const parentReceipt = path.join(campaignsRoot, `${campaign}.receipt`, "verified.json");
  if (!existsSync(parentReceipt)) throw new Error(`Missing campaign parent receipt: ${parentReceipt}`);
  const manifest = await readJson(parentReceipt);
  assertIdentity(manifest.identity, parentReceipt);
  const { firstSeed, seedCount, batchSize } = manifest.campaign;
  const campaignRoot = path.join(campaignsRoot, campaign);
  const directories = (await listDirectories(campaignRoot)).sort();

  if (family === "compact") {
    // One child, no corpus: the parent manifest binds the run, the child proves a cell.
    if (directories.length !== 1) {
      throw new Error(`${campaign} retains ${directories.length} compact children, expected 1`);
    }
    const [directory] = directories;
    const files = [];
    for (const name of COMPACT_FILES) {
      const file = path.join(directory, name);
      if (!existsSync(file)) throw new Error(`Missing compact child file: ${file}`);
      files.push({ file: name, bytes: (await stat(file)).size, sha256: await hashFile(file) });
    }
    const childVerified = await readJson(path.join(directory, "verified.json"));
    const childCampaign = await readJson(path.join(directory, "generated-campaign.json"));
    assertIdentity(childVerified.identity, `${directory}/verified.json`);
    // A G2-family child campaign record carries counts, not identity: the
    // child's own verified.json is where the identity lives.
    if (childCampaign.identity) {
      assertIdentity(childCampaign.identity, `${directory}/generated-campaign.json`);
    }
    compactSummaries.push({
      campaign,
      retention: "compact",
      directory: path.relative(finalRoot, directory),
      firstSeed: childCampaign.firstSeed,
      cells: childCampaign.completed.length,
      replays: childCampaign.replays,
      skipped: childCampaign.skipped,
      corpusRetained: false,
      files,
    });
    continue;
  }

  const campaignRecords = [];
  for (const directory of directories) {
    const attempt = await readJson(path.join(directory, "attempt.json"));
    const verified = await readJson(path.join(directory, "verified.json"));
    assertIdentity(attempt.identity, `${directory}/attempt.json`);
    assertIdentity(verified.identity, `${directory}/verified.json`);

    const naming = CORPUS_NAMES.find((candidate) =>
      existsSync(path.join(directory, candidate.descriptor)),
    );
    if (!naming) throw new Error(`No archive descriptor in ${directory}`);
    const descriptorFile = path.join(directory, naming.descriptor);
    const descriptor = await readJson(descriptorFile);
    if (descriptor.identity) assertIdentity(descriptor.identity, descriptorFile);

    const archiveFile = path.join(directory, descriptor.file);
    const archiveBytes = (await stat(archiveFile)).size;
    const archiveSha256 = await hashFile(archiveFile);
    if (archiveBytes !== descriptor.archiveBytes) {
      throw new Error(`Archive byte mismatch: ${archiveFile}`);
    }
    if (descriptor.archiveSha256 && archiveSha256 !== descriptor.archiveSha256) {
      throw new Error(`Archive hash mismatch: ${archiveFile}`);
    }
    const restored = await hashGunzip(archiveFile);
    if (
      restored.bytes !== descriptor.originalBytes ||
      restored.sha256 !== descriptor.originalSha256
    ) {
      throw new Error(`Restored corpus mismatch: ${archiveFile}`);
    }

    campaignRecords.push({
      campaign,
      firstSeed: attempt.firstSeed,
      directory: path.relative(finalRoot, directory),
      descriptor: path.relative(finalRoot, descriptorFile),
      archive: path.relative(finalRoot, archiveFile),
      archiveBytes,
      archiveSha256,
      originalBytes: restored.bytes,
      originalSha256: restored.sha256,
    });
    audited += 1;
    if (audited % 50 === 0) console.log(`Audited ${audited} corpora.`);
  }

  campaignRecords.sort((left, right) => left.firstSeed - right.firstSeed);
  const expectedCount = Math.ceil(seedCount / batchSize);
  const expectedSeeds = Array.from({ length: expectedCount }, (_, index) => firstSeed + index * batchSize);
  const actualSeeds = campaignRecords.map((record) => record.firstSeed);
  if (JSON.stringify(actualSeeds) !== JSON.stringify(expectedSeeds)) {
    throw new Error(
      `Seed sequence mismatch: ${campaign} (retained ${actualSeeds.length}, expected ${expectedCount})`,
    );
  }
  campaignSummaries.push({
    campaign,
    retention: "all",
    count: campaignRecords.length,
    firstSeed: campaignRecords[0].firstSeed,
    lastSeed: campaignRecords.at(-1).firstSeed,
    archiveBytes: campaignRecords.reduce((total, record) => total + record.archiveBytes, 0),
    originalBytes: campaignRecords.reduce((total, record) => total + record.originalBytes, 0),
  });
  records.push(...campaignRecords);
}

const report = {
  formatVersion: 1,
  purpose: "Streaming integrity audit of every retained compressed G4-qualification corpus",
  milestone: "g4",
  identity: expectedIdentity,
  verification:
    "archive byte/hash check plus streaming gunzip byte/hash check against each descriptor, with the retained seed sequence proved against the parent campaign manifest",
  retentionFamilies: CAMPAIGN_RETENTION,
  campaigns: campaignSummaries,
  compact: compactSummaries,
  targetCount: records.length,
  archiveBytes: records.reduce((total, record) => total + record.archiveBytes, 0),
  originalBytes: records.reduce((total, record) => total + record.originalBytes, 0),
  records,
};

await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `Audited ${report.targetCount} retained corpora (${report.originalBytes} restored bytes from ${report.archiveBytes} archive bytes).`,
);
