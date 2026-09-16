import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { CAMPAIGN_RETENTION, CORPUS_NAMES } from "./campaign-retention.mjs";

const qualificationRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(qualificationRoot, "../../../../..");
const identity = JSON.parse(
  readFileSync(join(import.meta.dirname, "final-identity.json"), "utf8"),
);
const reportPath = join(import.meta.dirname, "corpus-packaging.json");
const reportTemporaryPath = `${reportPath}.tmp`;

async function fileIdentity(path, encoding = "identity") {
  const hash = createHash("sha256");
  let bytes = 0;
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback();
    },
  });
  if (encoding === "gzip") await pipeline(createReadStream(path), createGunzip(), sink);
  else await pipeline(createReadStream(path), sink);
  return { bytes, sha256: hash.digest("hex") };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertIdentity(receipt, label) {
  assert.equal(receipt.identity?.production, identity.production, `${label} production identity`);
  assert.equal(receipt.identity?.harness, identity.harness, `${label} harness identity`);
}

function syncPath(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncFileAndDirectory(path) {
  syncPath(path);
  syncPath(dirname(path));
}

/**
 * `--reproductions` packages only the two G4 read-child re-runs, which arrive
 * after the main packaging pass. Each is checked against the retained archive
 * of the same child: a reproduction that does not restore to the same bytes is
 * a finding, not a formality.
 */
if (process.argv.includes("--reproductions")) {
  const reproductionReportPath = join(import.meta.dirname, "reproduction-packaging.json");
  assert(!existsSync(reproductionReportPath), "Reproduction packaging report already exists");
  const receiptsRoot = join(qualificationRoot, "replays", "receipts");
  const pairs = [
    ["g4-seed-batch-20000", "g4-seeds", 20000],
    ["g4-transport-seed-batch-50000", "g4-transport-seeds", 50000],
  ];
  const reproductionRecords = [];
  for (const [name, campaign, firstSeed] of pairs) {
    const directory = join(receiptsRoot, `${name}.receipt`);
    assert(existsSync(directory), `Missing reproduction receipt ${directory}`);
    assertIdentity(readJson(join(directory, "verified.json")), name);
    const retainedDescriptor = readJson(
      join(qualificationRoot, "campaigns", campaign, `seed-${firstSeed}.receipt`, "generated-corpus.archive.json"),
    );
    const sourcePath = join(directory, "generated-corpus.json");
    const archivePath = `${sourcePath}.gz`;
    const descriptorPath = join(directory, "generated-corpus.archive.json");
    const original = await fileIdentity(sourcePath);
    assert.deepEqual(
      original,
      { bytes: retainedDescriptor.originalBytes, sha256: retainedDescriptor.originalSha256 },
      `Reproduction ${name} does not reproduce the retained child corpus byte for byte`,
    );
    await pipeline(
      createReadStream(sourcePath),
      createGzip({ level: 9 }),
      createWriteStream(`${archivePath}.tmp`, { flags: "wx" }),
    );
    const restored = await fileIdentity(`${archivePath}.tmp`, "gzip");
    assert.deepEqual(restored, original, `Reproduction archive does not restore exact bytes: ${name}`);
    const compressed = await fileIdentity(`${archivePath}.tmp`);
    renameSync(`${archivePath}.tmp`, archivePath);
    syncFileAndDirectory(archivePath);
    const descriptor = {
      formatVersion: 1,
      source: "generated-corpus.json",
      file: "generated-corpus.json.gz",
      encoding: "gzip",
      originalBytes: original.bytes,
      originalSha256: original.sha256,
      archiveBytes: compressed.bytes,
      archiveSha256: compressed.sha256,
      identity: { production: identity.production, harness: identity.harness },
      role: "G4 read child reproduction",
      campaign,
      firstSeed,
      reproducesRetainedChild: relative(
        directory,
        join(qualificationRoot, "campaigns", campaign, `seed-${firstSeed}.receipt`),
      ),
      byteIdenticalToRetainedChild: true,
      restoreWorkingDirectory: "the directory containing generated-corpus.archive.json",
      restoreCommand:
        'g4_corpus_restore_dir=$(mktemp -d); gzip -dc "generated-corpus.json.gz" > "$g4_corpus_restore_dir/generated-corpus.json"',
      replayCommand: `cd ${JSON.stringify(repositoryRoot)}; node scripts/run-raptor3.mjs ${name.replace(/-(\d+)$/, " $1")} --subject=candidate`,
    };
    writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, { flag: "wx" });
    syncFileAndDirectory(descriptorPath);
    unlinkSync(sourcePath);
    reproductionRecords.push({ name, ...descriptor });
    process.stdout.write(`reproduction ${name} ${original.bytes} -> ${compressed.bytes} (byte-identical)\n`);
  }
  writeFileSync(
    reproductionReportPath,
    `${JSON.stringify(
      {
        formatVersion: 1,
        purpose:
          "The two G4 read-child re-runs, each proved byte-identical to the retained child corpus it reproduces",
        milestone: "g4",
        identity: { production: identity.production, harness: identity.harness },
        records: reproductionRecords,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

assert(!existsSync(reportPath), "G4 corpus packaging report already exists");
assert(!existsSync(reportTemporaryPath), "G4 corpus packaging report temporary file exists");

const campaignsRoot = join(qualificationRoot, "campaigns");
const modes = Object.entries(CAMPAIGN_RETENTION)
  .filter(([, family]) => family === "all")
  .map(([mode]) => mode);

const targets = [];
const seen = new Set();
const missingParents = [];
for (const mode of modes) {
  const manifestPath = join(campaignsRoot, `${mode}.receipt`, "verified.json");
  if (!existsSync(manifestPath)) {
    missingParents.push(mode);
    continue;
  }
  const manifest = readJson(manifestPath);
  assert.equal(manifest.mode, mode, `${mode} parent mode`);
  assertIdentity(manifest, mode);
  assert(Array.isArray(manifest.batches), `${mode} parent receipt has batches`);
  const expected = Math.ceil(manifest.campaign.seedCount / manifest.campaign.batchSize);
  assert.equal(manifest.batches.length, expected, `${mode} child count`);
  for (const batch of manifest.batches) {
    assert.equal(typeof batch.directory, "string", `${mode}:${batch.firstSeed} directory`);
    assert(!seen.has(batch.directory), `Duplicate child directory ${batch.directory}`);
    seen.add(batch.directory);
    const childReceiptPath = join(batch.directory, "verified.json");
    assert(existsSync(childReceiptPath), `Missing child receipt ${childReceiptPath}`);
    assertIdentity(readJson(childReceiptPath), `${mode}:${batch.firstSeed}`);
    const naming = CORPUS_NAMES.find(
      (candidate) =>
        existsSync(join(batch.directory, candidate.source)) ||
        existsSync(join(batch.directory, candidate.descriptor)),
    );
    assert(naming, `No corpus or archive descriptor in ${batch.directory}`);
    targets.push({
      mode,
      firstSeed: batch.firstSeed,
      directory: batch.directory,
      manifestPath,
      naming,
      sourcePath: join(batch.directory, naming.source),
      archivePath: join(batch.directory, `${naming.source}.gz`),
      descriptorPath: join(batch.directory, naming.descriptor),
    });
  }
}
assert.equal(missingParents.length, 0, `Missing campaign parents: ${missingParents.join(", ")}`);

const records = [];
let index = 0;
for (const target of targets) {
  index += 1;
  let descriptor;
  let action;
  if (existsSync(target.descriptorPath)) {
    // The runner already archived this child; re-prove restore before trusting it.
    descriptor = readJson(target.descriptorPath);
    assert.equal(descriptor.file, `${target.naming.source}.gz`, `${target.mode}:${target.firstSeed} archive name`);
    assert(existsSync(target.archivePath), `Missing archive ${target.archivePath}`);
    assert(
      !existsSync(target.sourcePath),
      `Raw corpus still present beside an archive: ${target.sourcePath}`,
    );
    const compressed = await fileIdentity(target.archivePath);
    assert.equal(compressed.bytes, descriptor.archiveBytes, `${target.mode}:${target.firstSeed} archive bytes`);
    if (descriptor.archiveSha256) {
      assert.equal(compressed.sha256, descriptor.archiveSha256, `${target.mode}:${target.firstSeed} archive hash`);
    }
    const restored = await fileIdentity(target.archivePath, "gzip");
    assert.deepEqual(
      restored,
      { bytes: descriptor.originalBytes, sha256: descriptor.originalSha256 },
      `Runner archive does not restore exact bytes for ${target.mode}:${target.firstSeed}`,
    );
    descriptor = { ...descriptor, archiveSha256: compressed.sha256 };
    action = "runner-archived";
  } else {
    assert(existsSync(target.sourcePath), `Missing raw corpus ${target.sourcePath}`);
    const archiveTemporaryPath = `${target.archivePath}.tmp`;
    const descriptorTemporaryPath = `${target.descriptorPath}.tmp`;
    assert(!existsSync(target.archivePath), `Archive already exists ${target.archivePath}`);
    assert(!existsSync(archiveTemporaryPath), `Archive temporary exists ${archiveTemporaryPath}`);
    assert(!existsSync(descriptorTemporaryPath), `Descriptor temporary exists ${descriptorTemporaryPath}`);
    const original = await fileIdentity(target.sourcePath);
    await pipeline(
      createReadStream(target.sourcePath),
      createGzip({ level: 9 }),
      createWriteStream(archiveTemporaryPath, { flags: "wx" }),
    );
    const restored = await fileIdentity(archiveTemporaryPath, "gzip");
    assert.deepEqual(
      restored,
      original,
      `Archived corpus does not restore exact bytes for ${target.mode}:${target.firstSeed}`,
    );
    const compressed = await fileIdentity(archiveTemporaryPath);
    renameSync(archiveTemporaryPath, target.archivePath);
    syncFileAndDirectory(target.archivePath);
    descriptor = {
      formatVersion: 1,
      source: target.naming.source,
      file: `${target.naming.source}.gz`,
      encoding: "gzip",
      originalBytes: original.bytes,
      originalSha256: original.sha256,
      archiveBytes: compressed.bytes,
      archiveSha256: compressed.sha256,
      identity: { production: identity.production, harness: identity.harness },
      campaign: target.mode,
      firstSeed: target.firstSeed,
      targetManifest: relative(target.directory, target.manifestPath),
      childReceipt: "verified.json",
      restoreWorkingDirectory: `the directory containing ${target.naming.descriptor}`,
      restoreCommand: `g4_corpus_restore_dir=$(mktemp -d); gzip -dc ${JSON.stringify(`${target.naming.source}.gz`)} > "$g4_corpus_restore_dir/${target.naming.source}"`,
      replayCommand: `cd ${JSON.stringify(repositoryRoot)}; node scripts/run-raptor3.mjs replay "$g4_corpus_restore_dir/${target.naming.source}"`,
    };
    writeFileSync(descriptorTemporaryPath, `${JSON.stringify(descriptor, null, 2)}\n`, { flag: "wx" });
    renameSync(descriptorTemporaryPath, target.descriptorPath);
    syncFileAndDirectory(target.descriptorPath);
    assert.deepEqual(readJson(target.descriptorPath), descriptor);
    // Only now — restore proven, descriptor durable — does the raw corpus go.
    unlinkSync(target.sourcePath);
    action = "packaged";
  }
  records.push({
    campaign: target.mode,
    firstSeed: target.firstSeed,
    directory: target.directory,
    descriptor: target.descriptorPath,
    action,
    childReceipt: "verified.json",
    ...descriptor,
  });
  if (index % 25 === 0 || index === targets.length) {
    process.stdout.write(`${index}/${targets.length} ${target.mode}:${target.firstSeed} ${action}\n`);
  }
}

/**
 * The replay inputs are restores of corpora this package already retains
 * compressed, so they are kept compressed too — by the same prove-then-unlink
 * rule, with a descriptor naming the archive they came from.
 */
const replayInputsRoot = join(qualificationRoot, "replays", "inputs");
const replayInputs = [];
if (existsSync(replayInputsRoot)) {
  const { readdirSync } = await import("node:fs");
  for (const name of readdirSync(replayInputsRoot).sort()) {
    if (!name.endsWith(".json")) continue;
    const sourcePath = join(replayInputsRoot, name);
    const archivePath = `${sourcePath}.gz`;
    const archiveTemporaryPath = `${archivePath}.tmp`;
    const descriptorPath = join(replayInputsRoot, `${name}.archive.json`);
    assert(!existsSync(archivePath), `Replay input archive already exists ${archivePath}`);
    const original = await fileIdentity(sourcePath);
    await pipeline(
      createReadStream(sourcePath),
      createGzip({ level: 9 }),
      createWriteStream(archiveTemporaryPath, { flags: "wx" }),
    );
    const restored = await fileIdentity(archiveTemporaryPath, "gzip");
    assert.deepEqual(restored, original, `Replay input does not restore exact bytes: ${name}`);
    const compressed = await fileIdentity(archiveTemporaryPath);
    renameSync(archiveTemporaryPath, archivePath);
    syncFileAndDirectory(archivePath);
    const descriptor = {
      formatVersion: 1,
      source: name,
      file: `${name}.gz`,
      encoding: "gzip",
      originalBytes: original.bytes,
      originalSha256: original.sha256,
      archiveBytes: compressed.bytes,
      archiveSha256: compressed.sha256,
      identity: { production: identity.production, harness: identity.harness },
      role: "replay input",
      restoreWorkingDirectory: "the directory containing this descriptor",
      restoreCommand: `g4_replay_restore_dir=$(mktemp -d); gzip -dc ${JSON.stringify(`${name}.gz`)} > "$g4_replay_restore_dir/${name}"`,
      replayCommand: `cd ${JSON.stringify(repositoryRoot)}; node scripts/run-raptor3.mjs replay "$g4_replay_restore_dir/${name}"`,
    };
    writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, { flag: "wx" });
    syncFileAndDirectory(descriptorPath);
    unlinkSync(sourcePath);
    replayInputs.push({ input: name, ...descriptor });
    process.stdout.write(`replay input ${name} ${original.bytes} -> ${compressed.bytes}\n`);
  }
}

const tool = await fileIdentity(new URL(import.meta.url));
const byCampaign = modes.map((campaign) => {
  const matching = records.filter((record) => record.campaign === campaign);
  return {
    campaign,
    count: matching.length,
    packaged: matching.filter((record) => record.action === "packaged").length,
    runnerArchived: matching.filter((record) => record.action === "runner-archived").length,
    originalBytes: matching.reduce((total, record) => total + record.originalBytes, 0),
    archiveBytes: matching.reduce((total, record) => total + record.archiveBytes, 0),
  };
});
const report = {
  formatVersion: 1,
  purpose: "Lossless packaging of every G4-qualification child campaign corpus",
  milestone: "g4",
  identity: { production: identity.production, harness: identity.harness },
  tooling: {
    file: relative(qualificationRoot, new URL(import.meta.url).pathname),
    bytes: tool.bytes,
    sha256: tool.sha256,
    runtime: process.version,
    compression: "node:zlib createGzip level 9",
    verification: "node:stream/promises pipeline through createGunzip and SHA-256 sink",
    runnerArchives:
      "Children the runner already archived are not recompressed; their archive bytes and restored bytes/hash are re-proved against the runner descriptor.",
  },
  retentionFamilies: CAMPAIGN_RETENTION,
  campaigns: byCampaign,
  replayInputs,
  replayInputOriginalBytes: replayInputs.reduce((total, entry) => total + entry.originalBytes, 0),
  replayInputArchiveBytes: replayInputs.reduce((total, entry) => total + entry.archiveBytes, 0),
  targetCount: records.length,
  originalBytes: records.reduce((total, record) => total + record.originalBytes, 0),
  archiveBytes: records.reduce((total, record) => total + record.archiveBytes, 0),
  records,
};
writeFileSync(reportTemporaryPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
renameSync(reportTemporaryPath, reportPath);
syncFileAndDirectory(reportPath);
process.stdout.write(
  `${JSON.stringify({
    report: reportPath,
    targetCount: report.targetCount,
    originalBytes: report.originalBytes,
    archiveBytes: report.archiveBytes,
  })}\n`,
);
