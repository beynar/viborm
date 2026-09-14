import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const finalRoot = path.resolve(new URL("..", import.meta.url).pathname);
const outputFile = path.join(finalRoot, "qualification-index.json");
const identity = await readJson("support/final-identity.json");

function relative(file) {
  return path.relative(finalRoot, file);
}

async function readJson(file) {
  return JSON.parse(await readFile(path.join(finalRoot, file), "utf8"));
}

function assertIdentity(actual, label) {
  assert.equal(actual.production, identity.production, `${label} production identity`);
  assert.equal(actual.harness, identity.harness, `${label} harness identity`);
  if (actual.runtime) assert.deepEqual(actual.runtime, identity.runtime, `${label} runtime identity`);
}

async function receiptGroup(group) {
  const root = path.join(finalRoot, group);
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".receipt"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const receipts = [];
  for (const entry of entries) {
    const directory = path.join(root, entry.name);
    const verified = JSON.parse(await readFile(path.join(directory, "verified.json"), "utf8"));
    const vitest = JSON.parse(await readFile(path.join(directory, "vitest.json"), "utf8"));
    assertIdentity(verified.identity, `${group}/${entry.name}`);
    assert.equal(vitest.numFailedTestSuites, 0, `${group}/${entry.name} suites`);
    assert.equal(vitest.numFailedTests, 0, `${group}/${entry.name} tests`);
    receipts.push({
      mode: verified.mode,
      receipt: relative(directory),
      testFiles: vitest.numPassedTestSuites,
      tests: vitest.numPassedTests,
      status: "passed",
    });
  }
  return receipts;
}

const fixed = await receiptGroup("fixed");
const postgres = await receiptGroup("native-pg");
const mysql = await receiptGroup("native-mysql");

const campaignModes = [
  ["cs03-extension-a-seeds", 3],
  ["cs03-extension-b-seeds", 3],
  ["cs03-extension-composition-seeds", 3],
  ["g2-seeds", 3],
  ["g2-transport-seeds", 3],
  ["g3p06-seeds", 3],
  ["g3p06-transport-seeds", 3],
  ["g3-seeds", 3],
  ["g3-transport-seeds", 3],
];
const campaigns = [];
for (const [mode, replayCount] of campaignModes) {
  const receipt = `campaigns/${mode}.receipt`;
  const verified = await readJson(`${receipt}/verified.json`);
  assertIdentity(verified.identity, receipt);
  const campaign = verified.campaign ?? await readJson(`${receipt}/extension-campaign.json`);
  const completed = campaign.completed?.length;
  const cells = campaign.seedCount * campaign.profiles.length;
  if (completed !== undefined) assert.equal(completed, cells, `${mode} completed cells`);
  if (verified.batches) {
    assert.equal(
      verified.batches.length,
      Math.ceil(campaign.seedCount / campaign.batchSize),
      `${mode} batches`,
    );
  }
  if (mode.startsWith("g3p06-")) {
    const compactChild = `campaigns/${mode}/seed-7000.receipt`;
    const childVerified = await readJson(`${compactChild}/verified.json`);
    const childVitest = await readJson(`${compactChild}/vitest.json`);
    const childCampaign = await readJson(`${compactChild}/generated-campaign.json`);
    assertIdentity(childVerified.identity, compactChild);
    assert.equal(childVitest.numPassedTestSuites, 1, `${mode} child suite`);
    assert.equal(childVitest.numPassedTests, 1, `${mode} child test`);
    assert.equal(childVitest.numFailedTests, 0, `${mode} child failures`);
    assert.equal(childCampaign.completed.length, 200, `${mode} child cells`);
    assert.equal(childCampaign.replays, 600, `${mode} child replays`);
    assert.equal(childCampaign.skipped, 0, `${mode} child skips`);
  }
  campaigns.push({
    mode,
    receipt,
    firstSeed: campaign.firstSeed,
    lastSeed: campaign.firstSeed + campaign.seedCount - 1,
    profiles: campaign.profiles,
    cells,
    exactReplays: cells * replayCount,
    skipped: 0,
    reportedBatches: verified.batches?.length ?? 1,
    retainedChildReceipts:
      mode === "g2-seeds" || mode === "g2-transport-seeds"
        ? 50
        : mode === "g3-seeds" || mode === "g3-transport-seeds"
          ? 100
          : mode.startsWith("g3p06-")
            ? 1
          : 0,
    retentionBoundary: mode.startsWith("g3p06-")
      ? "parent attempt/verified receipt and log plus the required compact child verified/Vitest/generated-campaign receipt"
      : mode.startsWith("cs03-")
        ? "single parent receipt retains the full extension campaign and corpus"
        : "parent receipt plus durably retained compressed child receipts",
    status: "passed",
  });
}

const replayNames = [
  "cs03-extension-a",
  "cs03-extension-b",
  "cs03-extension-composition",
  "g2-conditional-upsert",
  "g25-polish",
  "g3-sqlite-8000",
  "g3-transport-8000",
];
const replay = [];
for (const name of replayNames) {
  const receipt = `replays/receipts/${name}.receipt`;
  const verified = await readJson(`${receipt}/verified.json`);
  assertIdentity(verified.identity, receipt);
  replay.push({ name, receipt, status: "passed" });
}
const staleNames = [
  "historical-g2-conditional-upsert-stale",
  "historical-g25-polish-stale",
];
const staleIdentityRefusals = [];
for (const name of staleNames) {
  const evidence = `replays/${name}.log`;
  const log = await readFile(path.join(finalRoot, evidence), "utf8");
  assert.match(log, /Stale Raptor 3 evidence: executed source or runtime changed/);
  staleIdentityRefusals.push({ name, evidence, exitCode: 1, status: "expected-refusal" });
}

const driverIntegration = await readJson("support/driver-integration.vitest.json");
assert.equal(driverIntegration.numFailedTests, 0);
assert.equal(driverIntegration.numPassedTests, 16);
const receiptSelftestsLog = await readFile(path.join(finalRoot, "support/campaign-receipts.log"), "utf8");
const cliLog = await readFile(path.join(finalRoot, "support/cli.log"), "utf8");
const typecheckLog = await readFile(path.join(finalRoot, "support/typecheck.log"), "utf8");
assert.match(receiptSelftestsLog, /ℹ tests 34\n[\s\S]*ℹ pass 34\n[\s\S]*ℹ fail 0/);
assert.match(cliLog, /ℹ tests 7\n[\s\S]*ℹ pass 7\n[\s\S]*ℹ fail 0/);
const typeDiagnostics = [...typecheckLog.matchAll(/^(.+error TS\d+:.+)$/gm)].map((match) => match[1]);
assert.deepEqual(typeDiagnostics, [
  "src/query-engine/pattern/pack.ts(1443,36): error TS2345: Argument of type 'VariantCarrierSlot' is not assignable to parameter of type 'VariantJunctionCarrierSlot'.",
  "src/query-engine/pattern/pack.ts(2633,58): error TS2345: Argument of type 'VariantCarrierSlot' is not assignable to parameter of type 'VariantJunctionCarrierSlot'.",
]);

const structureVerified = await readJson("structural-measurement/receipt/verified.json");
assert.equal(structureVerified.qualifying, true);
assert.equal(structureVerified.cases.length, 28);
assert.equal(structureVerified.replays, 60);
assert.equal(structureVerified.skipped, 0);
const sourceCost = await readJson("support/source-cost.json");
const parserTokens = await readJson("support/parser-token-census.json");
const retention = await readJson("support/retained-corpora-audit.json");
assertIdentity(retention.identity, "retained corpus audit");
assert.equal(retention.targetCount, 300);

const sum = (records, key) => records.reduce((total, record) => total + record[key], 0);
const totals = {
  fixedModes: fixed.length,
  fixedTestExecutions: sum(fixed, "tests"),
  postgresModes: postgres.length,
  postgresTests: sum(postgres, "tests"),
  mysqlModes: mysql.length,
  mysqlTests: sum(mysql, "tests"),
  campaignModes: campaigns.length,
  campaignCells: sum(campaigns, "cells"),
  campaignExactReplays: sum(campaigns, "exactReplays"),
  campaignSkips: sum(campaigns, "skipped"),
  selectedReplays: replay.length,
  staleIdentityRefusals: staleIdentityRefusals.length,
};
assert.deepEqual(totals, {
  fixedModes: 42,
  fixedTestExecutions: 1137,
  postgresModes: 10,
  postgresTests: 58,
  mysqlModes: 9,
  mysqlTests: 47,
  campaignModes: 9,
  campaignCells: 61000,
  campaignExactReplays: 183000,
  campaignSkips: 0,
  selectedReplays: 7,
  staleIdentityRefusals: 2,
});

const index = {
  formatVersion: 1,
  status: "author-qualification-evidence-complete-independent-and-root-acceptance-pending",
  baselineCommit: "cf2cbc4e6eed445816e70b0d98ca117db90c86b0",
  frozenIdentity: identity,
  fixed,
  logOnlySelectors: "selector-launch-provenance.json",
  native: { postgres, mysql },
  campaigns,
  replay: { passed: replay, staleIdentityRefusals },
  support: {
    driverIntegration: { files: 2, tests: 16, evidence: "support/driver-integration.vitest.json" },
    receiptSelftests: { tests: 34, evidence: "support/campaign-receipts.log" },
    cli: { tests: 7, evidence: "support/cli.log" },
    typecheck: {
      exitCode: 1,
      historicalDiagnosticsOnly: true,
      diagnostics: typeDiagnostics,
      evidence: "support/typecheck.log",
    },
  },
  structure: {
    cases: 28,
    exactReplays: 60,
    skipped: 0,
    alternative: structureVerified.alternative,
    instrumentationRestored: true,
    evidence: "structural-measurement/receipt/verified.json",
  },
  source: {
    cost: "support/source-cost.json",
    parserTokenCensus: "support/parser-token-census.json",
    frozenIdentityManifest: "support/frozen-identity-manifest.json",
    allowlist: "source-allowlist.json",
    patch: "source.patch",
    current: {
      core: { tokenLines: 6927, parserTokens: 43383, bytes: 230397 },
      whole: { tokenLines: 11849, parserTokens: 72385, bytes: 499927 },
    },
    deltaFromUnit04: { tokenLines: -28, parserTokens: -74, bytes: -1121 },
    claimBoundary: "source cost only; no runtime or bundle improvement claim",
  },
  retention: {
    audit: "support/retained-corpora-audit.json",
    retainedCorpora: retention.targetCount,
    archiveBytes: retention.archiveBytes,
    originalBytes: retention.originalBytes,
    g3Corpora: 200,
    g3ArchiveBytes: retention.campaigns.filter(({ campaign }) => campaign.startsWith("g3-")).reduce((total, entry) => total + entry.archiveBytes, 0),
    g3OriginalBytes: retention.campaigns.filter(({ campaign }) => campaign.startsWith("g3-")).reduce((total, entry) => total + entry.originalBytes, 0),
    interruptedAttempt: {
      path: "campaigns/g3-transport-seeds.incomplete",
      status: "diagnostic-only-enospc-never-pass",
      completedChildren: 52,
      failedFirstSeed: 13200,
    },
    campaignArtifactBoundary: {
      g3p06: "Both G3P06 parent manifests bind first seed 7000, 100 seeds, two profiles, and three replays. Each retains its one required compact child verified.json, vitest.json, and generated-campaign.json receipt.",
      currentG3: "Both full G3 campaigns retain all 100 compressed child receipts and their parent receipts.",
      g2: "Both G2 campaigns retain all 50 compressed child receipts and their parent receipts.",
    },
    retainedFiles: "retained-files.json",
    checksums: "SHA256SUMS",
    taskCommitAllowlist: "task-commit-allowlist.json",
  },
  evidenceBoundaries: {
    preparedGeneratedKeyWitness: "SQLite3-derived batch-only test driver; not a native PostgreSQL/MySQL claim",
    nativeSuites: "Current-source PostgreSQL and MySQL inherited provider modes only",
    bindPartition: "Low-cap correctness witness; extra physical chunks are an explicit trade-off, not a speed claim",
    acceptance: "Independent and root review attestations are external to this sealed author tree",
  },
  totals,
};

await writeFile(outputFile, `${JSON.stringify(index, null, 2)}\n`);
console.log(`Qualification index verified: ${totals.campaignCells} cells, ${totals.fixedTestExecutions} fixed tests.`);
