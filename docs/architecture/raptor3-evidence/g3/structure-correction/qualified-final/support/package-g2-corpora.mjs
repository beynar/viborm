import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  closeSync,
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
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";

const repositoryRoot = resolve(import.meta.dirname, "../../../../../../..");
const qualificationRoot = resolve(import.meta.dirname, "..");
const productionIdentity =
  "fe544577cbc3c6747806f4b6a178ffe284d52d7ac3b5dd87fcd39adc2c3d54da";
const harnessIdentity =
  "3d9977876d5b8c0c80aec1ea6902f34b39ea80ab52e07e7242a287312dd2b922";
const manifestPaths = [
  resolve(qualificationRoot, "campaigns/g2-seeds.receipt/verified.json"),
  resolve(
    qualificationRoot,
    "campaigns/g2-transport-seeds.receipt/verified.json"
  ),
];
const reportPath = resolve(import.meta.dirname, "g2-corpus-packaging.json");
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
  if (encoding === "gzip")
    await pipeline(createReadStream(path), createGunzip(), sink);
  else await pipeline(createReadStream(path), sink);
  return { bytes, sha256: hash.digest("hex") };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertIdentity(receipt, label) {
  assert.equal(receipt.identity?.production, productionIdentity, `${label} production identity`);
  assert.equal(receipt.identity?.harness, harnessIdentity, `${label} harness identity`);
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

assert(!existsSync(reportPath), "G2 corpus packaging report already exists");
assert(!existsSync(reportTemporaryPath), "G2 corpus packaging report temporary file exists");

const targets = [];
const directories = new Set();
for (const manifestPath of manifestPaths) {
  const manifest = readJson(manifestPath);
  assert(["g2-seeds", "g2-transport-seeds"].includes(manifest.mode));
  assertIdentity(manifest, manifest.mode);
  assert.equal(manifest.batches.length, 50, `${manifest.mode} batch count`);
  for (const batch of manifest.batches) {
    assert.equal(typeof batch.directory, "string");
    assert(!directories.has(batch.directory), `Duplicate child directory ${batch.directory}`);
    directories.add(batch.directory);
    const childReceiptPath = join(batch.directory, "verified.json");
    const sourcePath = join(batch.directory, "corpus.json");
    const archivePath = join(batch.directory, "corpus.json.gz");
    const archiveTemporaryPath = `${archivePath}.tmp`;
    const descriptorPath = join(batch.directory, "corpus.archive.json");
    const descriptorTemporaryPath = `${descriptorPath}.tmp`;
    assert(existsSync(childReceiptPath), `Missing child receipt ${childReceiptPath}`);
    assert(existsSync(sourcePath), `Missing raw corpus ${sourcePath}`);
    assert(!existsSync(archivePath), `Archive already exists ${archivePath}`);
    assert(!existsSync(archiveTemporaryPath), `Archive temporary exists ${archiveTemporaryPath}`);
    assert(!existsSync(descriptorPath), `Descriptor already exists ${descriptorPath}`);
    assert(!existsSync(descriptorTemporaryPath), `Descriptor temporary exists ${descriptorTemporaryPath}`);
    const childReceipt = readJson(childReceiptPath);
    assertIdentity(childReceipt, `${manifest.mode}:${batch.firstSeed}`);
    targets.push({
      manifestPath,
      manifestMode: manifest.mode,
      firstSeed: batch.firstSeed,
      directory: batch.directory,
      childReceiptPath,
      sourcePath,
      archivePath,
      archiveTemporaryPath,
      descriptorPath,
      descriptorTemporaryPath,
    });
  }
}
assert.equal(targets.length, 100, "Exact G2 corpus target count");

const records = [];
for (const target of targets) {
  const original = await fileIdentity(target.sourcePath);
  await pipeline(
    createReadStream(target.sourcePath),
    createGzip({ level: 9 }),
    createWriteStream(target.archiveTemporaryPath, { flags: "wx" })
  );
  const restored = await fileIdentity(target.archiveTemporaryPath, "gzip");
  assert.deepEqual(
    restored,
    original,
    `Archived G2 corpus does not restore exact bytes for ${target.manifestMode}:${target.firstSeed}`
  );
  const compressed = await fileIdentity(target.archiveTemporaryPath);
  renameSync(target.archiveTemporaryPath, target.archivePath);
  syncFileAndDirectory(target.archivePath);

  const descriptor = {
    formatVersion: 1,
    source: "corpus.json",
    file: "corpus.json.gz",
    encoding: "gzip",
    originalBytes: original.bytes,
    originalSha256: original.sha256,
    archiveBytes: compressed.bytes,
    archiveSha256: compressed.sha256,
    identity: {
      production: productionIdentity,
      harness: harnessIdentity,
    },
    campaign: target.manifestMode,
    firstSeed: target.firstSeed,
    targetManifest: relative(target.directory, target.manifestPath),
    childReceipt: "verified.json",
    restoreWorkingDirectory: "the directory containing corpus.archive.json",
    restoreCommand:
      'g2_corpus_restore_dir=$(mktemp -d); gzip -dc "corpus.json.gz" > "$g2_corpus_restore_dir/corpus.json"',
    replayCommand: `cd ${JSON.stringify(repositoryRoot)}; node scripts/run-raptor3.mjs replay "$g2_corpus_restore_dir/corpus.json"`,
  };
  writeFileSync(
    target.descriptorTemporaryPath,
    `${JSON.stringify(descriptor, null, 2)}\n`,
    { flag: "wx" }
  );
  renameSync(target.descriptorTemporaryPath, target.descriptorPath);
  syncFileAndDirectory(target.descriptorPath);
  assert.deepEqual(readJson(target.descriptorPath), descriptor);
  unlinkSync(target.sourcePath);
  records.push({
    campaign: target.manifestMode,
    firstSeed: target.firstSeed,
    directory: target.directory,
    descriptor: target.descriptorPath,
    ...descriptor,
  });
  process.stdout.write(
    `${records.length}/100 ${target.manifestMode}:${target.firstSeed} ${original.bytes} -> ${compressed.bytes}\n`
  );
}

const tool = await fileIdentity(new URL(import.meta.url));
const report = {
  formatVersion: 1,
  purpose: "Lossless packaging of the exact current-final G2 campaign corpora",
  identity: {
    production: productionIdentity,
    harness: harnessIdentity,
  },
  tooling: {
    file: relative(qualificationRoot, new URL(import.meta.url).pathname),
    bytes: tool.bytes,
    sha256: tool.sha256,
    runtime: process.version,
    compression: "node:zlib createGzip level 9",
    verification: "node:stream/promises pipeline through createGunzip and SHA-256 sink",
  },
  targetManifests: await Promise.all(
    manifestPaths.map(async (path) => ({
      file: relative(qualificationRoot, path),
      ...(await fileIdentity(path)),
    }))
  ),
  targetCount: records.length,
  originalBytes: records.reduce((sum, record) => sum + record.originalBytes, 0),
  archiveBytes: records.reduce((sum, record) => sum + record.archiveBytes, 0),
  records,
};
writeFileSync(reportTemporaryPath, `${JSON.stringify(report, null, 2)}\n`, {
  flag: "wx",
});
renameSync(reportTemporaryPath, reportPath);
syncFileAndDirectory(reportPath);
process.stdout.write(`${JSON.stringify({
  report: reportPath,
  targetCount: report.targetCount,
  originalBytes: report.originalBytes,
  archiveBytes: report.archiveBytes,
})}\n`);
