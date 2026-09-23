import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const expectedIdentity = {
  production: "fe544577cbc3c6747806f4b6a178ffe284d52d7ac3b5dd87fcd39adc2c3d54da",
  harness: "3d9977876d5b8c0c80aec1ea6902f34b39ea80ab52e07e7242a287312dd2b922",
};
const finalRoot = path.resolve(new URL("..", import.meta.url).pathname);
const campaignsRoot = path.join(finalRoot, "campaigns");
const reportFile = path.join(finalRoot, "support", "retained-corpora-audit.json");
const campaignExpectations = [
  { campaign: "g2-seeds", firstSeed: 2000, lastSeed: 6900, count: 50 },
  {
    campaign: "g2-transport-seeds",
    firstSeed: 2000,
    lastSeed: 6900,
    count: 50,
  },
  { campaign: "g3-seeds", firstSeed: 8000, lastSeed: 17900, count: 100 },
  {
    campaign: "g3-transport-seeds",
    firstSeed: 8000,
    lastSeed: 17900,
    count: 100,
  },
];

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
  await pipeline(createReadStream(file), new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback();
    },
  }));
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

const records = [];
for (const expectation of campaignExpectations) {
  const campaignRoot = path.join(campaignsRoot, expectation.campaign);
  const directories = await listDirectories(campaignRoot);
  const campaignRecords = [];

  for (const directory of directories) {
    const attempt = JSON.parse(await readFile(path.join(directory, "attempt.json"), "utf8"));
    const verified = JSON.parse(await readFile(path.join(directory, "verified.json"), "utf8"));
    assertIdentity(attempt.identity, `${directory}/attempt.json`);
    assertIdentity(verified.identity, `${directory}/verified.json`);

    const descriptorName = expectation.campaign.startsWith("g2-")
      ? "corpus.archive.json"
      : "generated-corpus.archive.json";
    const descriptorFile = path.join(directory, descriptorName);
    const descriptor = JSON.parse(await readFile(descriptorFile, "utf8"));
    if (descriptor.identity) {
      assertIdentity(descriptor.identity, descriptorFile);
    }

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
      campaign: expectation.campaign,
      firstSeed: attempt.firstSeed,
      directory: path.relative(finalRoot, directory),
      descriptor: path.relative(finalRoot, descriptorFile),
      archive: path.relative(finalRoot, archiveFile),
      archiveBytes,
      archiveSha256,
      originalBytes: restored.bytes,
      originalSha256: restored.sha256,
    });
    if ((records.length + campaignRecords.length) % 10 === 0) {
      console.log(`Audited ${records.length + campaignRecords.length} corpora.`);
    }
  }

  campaignRecords.sort((left, right) => left.firstSeed - right.firstSeed);
  const expectedSeeds = Array.from(
    { length: expectation.count },
    (_, index) => expectation.firstSeed + index * 100,
  );
  const actualSeeds = campaignRecords.map((record) => record.firstSeed);
  if (JSON.stringify(actualSeeds) !== JSON.stringify(expectedSeeds)) {
    throw new Error(`Seed sequence mismatch: ${expectation.campaign}`);
  }
  if (actualSeeds.at(-1) !== expectation.lastSeed) {
    throw new Error(`Last seed mismatch: ${expectation.campaign}`);
  }
  records.push(...campaignRecords);
}

const report = {
  formatVersion: 1,
  purpose: "Streaming integrity audit of every retained compressed G2 and G3 corpus",
  identity: expectedIdentity,
  verification:
    "archive byte/hash check plus streaming gunzip byte/hash check against each descriptor",
  campaigns: campaignExpectations.map((expectation) => {
    const matching = records.filter((record) => record.campaign === expectation.campaign);
    return {
      campaign: expectation.campaign,
      count: matching.length,
      firstSeed: matching[0].firstSeed,
      lastSeed: matching.at(-1).firstSeed,
      archiveBytes: matching.reduce((total, record) => total + record.archiveBytes, 0),
      originalBytes: matching.reduce((total, record) => total + record.originalBytes, 0),
    };
  }),
  targetCount: records.length,
  archiveBytes: records.reduce((total, record) => total + record.archiveBytes, 0),
  originalBytes: records.reduce((total, record) => total + record.originalBytes, 0),
  records,
};

await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `Audited ${report.targetCount} retained corpora (${report.originalBytes} restored bytes).`,
);
