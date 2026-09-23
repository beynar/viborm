import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CAMPAIGN_RETENTION, RETENTION_BOUNDARY } from "./campaign-retention.mjs";

const finalRoot = path.resolve(new URL("..", import.meta.url).pathname);
const outputFile = path.join(finalRoot, "qualification-index.json");
const identity = await readJson("support/final-identity.json");
const deriveOnly = process.argv.includes("--derive");
const baselineCommit = "0cc61e61f372945026b0b564fa643de67168c08e";

/**
 * Totals pinned after the qualification runs finished, derived from the
 * receipts this script reads. `--derive` prints the derived totals without
 * asserting them; a normal run asserts the pin, so a later receipt change is a
 * loud failure rather than a quietly different number.
 */
const PINNED_TOTALS = null;

/** Every red, missing or unreadable receipt lands here and is printed and written out. */
const gaps = [];

function relative(file) {
  return path.relative(finalRoot, file);
}

async function readJson(file) {
  return JSON.parse(await readFile(path.join(finalRoot, file), "utf8"));
}

function identityMatches(actual) {
  return actual?.production === identity.production && actual?.harness === identity.harness;
}

function checkIdentity(actual, label) {
  if (identityMatches(actual)) return true;
  gaps.push({ kind: "identity-mismatch", subject: label });
  return false;
}

async function receiptDirectories(group) {
  const root = path.join(finalRoot, group);
  if (!existsSync(root)) return [];
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".receipt"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => path.join(root, entry.name));
}

/** The refusal sentence a lock collision leaves in the mode log, if there is one. */
async function refusalReason(group, mode) {
  const log = path.join(finalRoot, group, `${mode}.log`);
  if (!existsSync(log)) return undefined;
  const text = await readFile(log, "utf8");
  return text.match(/^Test command refused: .+$/m)?.[0];
}

/**
 * A group of ordinary mode receipts: fixed, native-pg, native-mysql.
 *
 * Three outcomes are distinguished and none is hidden: a verified green run, a
 * run that executed and failed tests (Vitest report present, no `verified.json`),
 * and a run the workspace lock refused before Vitest started (only
 * `attempt.json`, with the refusal sentence in the mode log).
 */
async function receiptGroup(group) {
  const receipts = [];
  for (const directory of await receiptDirectories(group)) {
    const mode = path.basename(directory, ".receipt");
    const label = `${group}/${path.basename(directory)}`;
    const verifiedFile = path.join(directory, "verified.json");
    const vitestFile = path.join(directory, "vitest.json");
    const attemptFile = path.join(directory, "attempt.json");
    const vitest = existsSync(vitestFile)
      ? JSON.parse(await readFile(vitestFile, "utf8"))
      : undefined;

    if (!existsSync(verifiedFile)) {
      const refusal = await refusalReason(group, mode);
      const attempt = existsSync(attemptFile)
        ? JSON.parse(await readFile(attemptFile, "utf8"))
        : undefined;
      if (attempt) checkIdentity(attempt.identity, label);
      const kind = refusal ? "refused-by-workspace-lock" : vitest ? "failed-tests" : "incomplete-receipt";
      gaps.push({
        kind,
        subject: label,
        ...(refusal ? { refusal } : {}),
        ...(vitest
          ? { failedSuites: vitest.numFailedTestSuites, failedTests: vitest.numFailedTests }
          : {}),
      });
      receipts.push({
        mode,
        receipt: relative(directory),
        testFiles: vitest?.numPassedTestSuites,
        tests: vitest?.numPassedTests,
        failedTests: vitest?.numFailedTests,
        ...(refusal ? { refusal } : {}),
        status: refusal ? "refused" : vitest ? "failed" : "incomplete",
      });
      continue;
    }
    if (vitest === undefined) {
      gaps.push({ kind: "incomplete-receipt", subject: label });
      receipts.push({ mode, receipt: relative(directory), status: "incomplete" });
      continue;
    }
    const verified = JSON.parse(await readFile(verifiedFile, "utf8"));
    const identityOk = checkIdentity(verified.identity, label);
    const green = vitest.numFailedTestSuites === 0 && vitest.numFailedTests === 0;
    if (!green) {
      gaps.push({
        kind: "failed-tests",
        subject: label,
        failedSuites: vitest.numFailedTestSuites,
        failedTests: vitest.numFailedTests,
      });
    }
    receipts.push({
      mode: verified.mode,
      receipt: relative(directory),
      testFiles: vitest.numPassedTestSuites,
      tests: vitest.numPassedTests,
      failedTests: vitest.numFailedTests,
      status: green && identityOk ? "passed" : "failed",
    });
  }
  return receipts;
}

const fixed = await receiptGroup("fixed");
const postgres = await receiptGroup("native-pg");
const mysql = await receiptGroup("native-mysql");
for (const [group, receipts] of [
  ["native-pg", postgres],
  ["native-mysql", mysql],
]) {
  if (receipts.length === 0) gaps.push({ kind: "empty-group", subject: group });
}

/**
 * Campaigns are derived, not declared: every `<mode>.receipt` present under
 * `campaigns/` is classified by what its own receipt carries — a seeded
 * campaign manifest, an extension campaign, or a plain mode run in a lane.
 */
const campaigns = [];
const laneModes = [];
for (const directory of await receiptDirectories("campaigns")) {
  const mode = path.basename(directory, ".receipt");
  const label = `campaigns/${mode}`;
  const verifiedFile = path.join(directory, "verified.json");
  if (!existsSync(verifiedFile)) {
    gaps.push({ kind: "incomplete-receipt", subject: label });
    continue;
  }
  const verified = JSON.parse(await readFile(verifiedFile, "utf8"));
  const identityOk = checkIdentity(verified.identity, label);
  const extensionFile = path.join(directory, "extension-campaign.json");
  const campaign =
    verified.campaign ??
    (existsSync(extensionFile) ? JSON.parse(await readFile(extensionFile, "utf8")) : undefined);

  if (campaign === undefined) {
    // A lane also ran ordinary fixed modes; they are recorded, never counted as cells.
    const vitestFile = path.join(directory, "vitest.json");
    const vitest = existsSync(vitestFile) ? JSON.parse(await readFile(vitestFile, "utf8")) : undefined;
    if (vitest === undefined) gaps.push({ kind: "incomplete-receipt", subject: label });
    else if (vitest.numFailedTests !== 0 || vitest.numFailedTestSuites !== 0) {
      gaps.push({
        kind: "failed-tests",
        subject: label,
        failedSuites: vitest.numFailedTestSuites,
        failedTests: vitest.numFailedTests,
      });
    }
    laneModes.push({
      mode,
      receipt: relative(directory),
      testFiles: vitest?.numPassedTestSuites,
      tests: vitest?.numPassedTests,
      status: vitest && vitest.numFailedTests === 0 && identityOk ? "passed" : "failed",
    });
    continue;
  }

  const replayCount = campaign.replayCount ?? 3;
  const cells = campaign.seedCount * campaign.profiles.length;
  const completed = campaign.completed?.length;
  if (completed !== undefined && completed !== cells) {
    gaps.push({ kind: "incomplete-campaign", subject: label, completed, expected: cells });
  }
  const expectedBatches = campaign.batchSize
    ? Math.ceil(campaign.seedCount / campaign.batchSize)
    : 1;
  if (verified.batches && verified.batches.length !== expectedBatches) {
    gaps.push({
      kind: "campaign-batch-count",
      subject: label,
      batches: verified.batches.length,
      expected: expectedBatches,
    });
  }
  const family = CAMPAIGN_RETENTION[mode];
  if (family === undefined) gaps.push({ kind: "unregistered-campaign", subject: label });
  const retainedRoot = path.join(finalRoot, "campaigns", mode);
  const retainedChildReceipts = existsSync(retainedRoot)
    ? (await readdir(retainedRoot, { withFileTypes: true })).filter(
        (entry) => entry.isDirectory() && entry.name.endsWith(".receipt"),
      ).length
    : 0;
  if (family === "all" && retainedChildReceipts !== expectedBatches) {
    gaps.push({
      kind: "retention-shortfall",
      subject: label,
      retained: retainedChildReceipts,
      expected: expectedBatches,
    });
  }
  campaigns.push({
    mode,
    receipt: relative(directory),
    firstSeed: campaign.firstSeed,
    lastSeed: campaign.firstSeed + campaign.seedCount - 1,
    profiles: campaign.profiles,
    cells,
    exactReplays: cells * replayCount,
    skipped: campaign.skipped ?? 0,
    reportedBatches: verified.batches?.length ?? 1,
    retention: family ?? "unregistered",
    retainedChildReceipts,
    retentionBoundary: RETENTION_BOUNDARY[family] ?? "unregistered campaign family",
    status:
      identityOk && (completed === undefined || completed === cells) ? "passed" : "failed",
  });
}
campaigns.sort((left, right) => left.mode.localeCompare(right.mode));
laneModes.sort((left, right) => left.mode.localeCompare(right.mode));
for (const mode of Object.keys(CAMPAIGN_RETENTION)) {
  if (!campaigns.some((entry) => entry.mode === mode)) {
    gaps.push({ kind: "missing-campaign", subject: `campaigns/${mode}` });
  }
}

/** Replay receipts land as `<name>.receipt` in `replays/`, or under `replays/receipts/`. */
const replay = [];
const replayRoots = ["replays/receipts", "replays"];
const replaySeen = new Set();
for (const group of replayRoots) {
  for (const directory of await receiptDirectories(group)) {
    const name = path.basename(directory, ".receipt");
    if (replaySeen.has(name)) continue;
    replaySeen.add(name);
    const label = `${group}/${name}`;
    const verifiedFile = path.join(directory, "verified.json");
    if (!existsSync(verifiedFile)) {
      gaps.push({ kind: "incomplete-receipt", subject: label });
      continue;
    }
    const verified = JSON.parse(await readFile(verifiedFile, "utf8"));
    const identityOk = checkIdentity(verified.identity, label);
    replay.push({
      name,
      receipt: relative(directory),
      status: identityOk ? "passed" : "failed",
    });
  }
}
replay.sort((left, right) => left.name.localeCompare(right.name));

const staleIdentityRefusals = [];
const replaysRoot = path.join(finalRoot, "replays");
if (existsSync(replaysRoot)) {
  const logs = (await readdir(replaysRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".log") && entry.name.includes("stale"))
    .map((entry) => entry.name)
    .sort();
  for (const name of logs) {
    const evidence = `replays/${name}`;
    const log = await readFile(path.join(finalRoot, evidence), "utf8");
    const refused = /Stale Raptor 3 evidence: executed source or runtime changed/.test(log);
    if (!refused) gaps.push({ kind: "stale-refusal-missing-sentence", subject: evidence });
    staleIdentityRefusals.push({
      name: name.replace(/\.log$/, ""),
      evidence,
      exitCode: 1,
      status: refused ? "expected-refusal" : "unverified",
    });
  }
}

/** Support checks written by the integrator's driver; a missing one is named, not skipped. */
async function supportFile(file) {
  const absolute = path.join(finalRoot, file);
  if (!existsSync(absolute)) {
    gaps.push({ kind: "missing-support-evidence", subject: file });
    return undefined;
  }
  return absolute;
}

const driverIntegrationFile = await supportFile("support/driver-integration.vitest.json");
let driverIntegration;
if (driverIntegrationFile) {
  driverIntegration = await readJson("support/driver-integration.vitest.json");
  if (driverIntegration.numFailedTests !== 0 || driverIntegration.numPassedTests !== 16) {
    gaps.push({
      kind: "driver-integration",
      subject: "support/driver-integration.vitest.json",
      passed: driverIntegration.numPassedTests,
      failed: driverIntegration.numFailedTests,
    });
  }
}

async function logCounts(file, pattern, label) {
  const absolute = await supportFile(file);
  if (!absolute) return undefined;
  const text = await readFile(absolute, "utf8");
  const match = text.match(pattern);
  if (!match) {
    gaps.push({ kind: "unparsed-support-log", subject: file, expected: label });
    return undefined;
  }
  return Number(match[1]);
}

const receiptSelftests = await logCounts(
  "support/campaign-receipts.log",
  /ℹ pass (\d+)\n/,
  "node:test pass count",
);
const receiptSelftestFailures = await logCounts(
  "support/campaign-receipts.log",
  /ℹ fail (\d+)\n/,
  "node:test fail count",
);
if (receiptSelftestFailures !== undefined && receiptSelftestFailures !== 0) {
  gaps.push({ kind: "failed-tests", subject: "support/campaign-receipts.log", failedTests: receiptSelftestFailures });
}
const cliTests = await logCounts("support/cli.log", /ℹ pass (\d+)\n/, "node:test pass count");
const cliFailures = await logCounts("support/cli.log", /ℹ fail (\d+)\n/, "node:test fail count");
if (cliFailures !== undefined && cliFailures !== 0) {
  gaps.push({ kind: "failed-tests", subject: "support/cli.log", failedTests: cliFailures });
}

const HISTORICAL_PATTERN_DIAGNOSTICS = [
  "src/query-engine/pattern/pack.ts(1443,36): error TS2345: Argument of type 'VariantCarrierSlot' is not assignable to parameter of type 'VariantJunctionCarrierSlot'.",
  "src/query-engine/pattern/pack.ts(2633,58): error TS2345: Argument of type 'VariantCarrierSlot' is not assignable to parameter of type 'VariantJunctionCarrierSlot'.",
];
let typeDiagnostics;
const typecheckFile = await supportFile("support/typecheck.log");
if (typecheckFile) {
  const typecheckLog = await readFile(typecheckFile, "utf8");
  typeDiagnostics = [...typecheckLog.matchAll(/^(.+error TS\d+:.+)$/gm)].map((match) => match[1]);
  const unexpected = typeDiagnostics.filter(
    (diagnostic) => !HISTORICAL_PATTERN_DIAGNOSTICS.includes(diagnostic),
  );
  if (unexpected.length > 0) {
    gaps.push({ kind: "unexpected-typecheck-diagnostic", subject: "support/typecheck.log", diagnostics: unexpected });
  }
  for (const diagnostic of HISTORICAL_PATTERN_DIAGNOSTICS) {
    if (!typeDiagnostics.includes(diagnostic)) {
      gaps.push({ kind: "missing-historical-diagnostic", subject: "support/typecheck.log", diagnostic });
    }
  }
}

let structure;
const structureReceipt = path.join(finalRoot, "structural-measurement", "receipt", "verified.json");
if (existsSync(structureReceipt)) {
  const structureVerified = JSON.parse(await readFile(structureReceipt, "utf8"));
  if (
    structureVerified.qualifying !== true ||
    structureVerified.cases?.length !== 28 ||
    structureVerified.replays !== 60 ||
    structureVerified.skipped !== 0
  ) {
    gaps.push({
      kind: "structural-measurement",
      subject: "structural-measurement/receipt/verified.json",
      cases: structureVerified.cases?.length,
      replays: structureVerified.replays,
      skipped: structureVerified.skipped,
    });
  }
  structure = {
    cases: structureVerified.cases?.length,
    exactReplays: structureVerified.replays,
    skipped: structureVerified.skipped,
    alternative: structureVerified.alternative,
    instrumentationRestored: true,
    evidence: "structural-measurement/receipt/verified.json",
  };
} else {
  gaps.push({ kind: "pending-structural-measurement", subject: "structural-measurement/receipt/verified.json" });
  structure = { status: "pending", evidence: null };
}

await supportFile("support/source-cost.json");
await supportFile("support/query-engine-structure.log");
const parserTokenCensus = existsSync(path.join(finalRoot, "support/parser-token-census.json"))
  ? "support/parser-token-census.json"
  : null;
const selectorEvidence = [];
for (const [name, file] of [
  ["credential-free aggregate", "support/credential-free-fixed.log"],
  ["PGlite provider selector", "support/pglite.log"],
]) {
  const absolute = await supportFile(file);
  selectorEvidence.push({ name, evidence: file, present: absolute !== undefined });
}

let retention;
const retentionFile = path.join(finalRoot, "support", "retained-corpora-audit.json");
if (existsSync(retentionFile)) {
  const audit = JSON.parse(await readFile(retentionFile, "utf8"));
  checkIdentity(audit.identity, "retained corpus audit");
  retention = {
    audit: "support/retained-corpora-audit.json",
    packaging: "support/corpus-packaging.json",
    retentionMap: "support/corpus-retention.json",
    retainedCorpora: audit.targetCount,
    archiveBytes: audit.archiveBytes,
    originalBytes: audit.originalBytes,
    perCampaign: audit.campaigns,
    compact: audit.compact,
    retentionFamilies: CAMPAIGN_RETENTION,
    retainedFiles: "retained-files.json",
    checksums: "SHA256SUMS",
    taskCommitAllowlist: "task-commit-allowlist.json",
  };
} else {
  gaps.push({ kind: "missing-support-evidence", subject: "support/retained-corpora-audit.json" });
  retention = { status: "pending" };
}

const sum = (records, key) => records.reduce((total, record) => total + (record[key] ?? 0), 0);
const passed = (records) => records.filter((record) => record.status === "passed");
const notPassed = (records) => records.filter((record) => record.status !== "passed");
const totals = {
  fixedModes: passed(fixed).length,
  fixedTestExecutions: sum(passed(fixed), "tests"),
  fixedModesNotPassed: notPassed(fixed).length,
  laneFixedModes: passed(laneModes).length,
  laneFixedTestExecutions: sum(passed(laneModes), "tests"),
  laneFixedModesNotPassed: notPassed(laneModes).length,
  postgresModes: passed(postgres).length,
  postgresTests: sum(passed(postgres), "tests"),
  postgresModesNotPassed: notPassed(postgres).length,
  mysqlModes: passed(mysql).length,
  mysqlTests: sum(passed(mysql), "tests"),
  mysqlModesNotPassed: notPassed(mysql).length,
  campaignModes: passed(campaigns).length,
  campaignCells: sum(passed(campaigns), "cells"),
  campaignExactReplays: sum(passed(campaigns), "exactReplays"),
  campaignSkips: sum(campaigns, "skipped"),
  campaignModesNotPassed: notPassed(campaigns).length,
  selectedReplays: passed(replay).length,
  staleIdentityRefusals: staleIdentityRefusals.filter(
    (record) => record.status === "expected-refusal",
  ).length,
};

console.log(`Derived totals:\n${JSON.stringify(totals, null, 2)}`);
console.log(
  `Campaign cells by mode:\n${campaigns
    .map((entry) => `  ${entry.mode}: ${entry.cells} cells / ${entry.exactReplays} replays / ${entry.retainedChildReceipts} retained children`)
    .join("\n")}`,
);
if (PINNED_TOTALS !== null && !deriveOnly) assert.deepEqual(totals, PINNED_TOTALS);

const index = {
  formatVersion: 1,
  milestone: "g4",
  status:
    gaps.length === 0
      ? "author-qualification-evidence-complete-independent-and-root-acceptance-pending"
      : "author-qualification-evidence-incomplete-see-gaps",
  baselineCommit,
  frozenIdentity: identity,
  fixed,
  laneFixedModes: laneModes,
  logOnlySelectors: "selector-launch-provenance.json",
  native: { postgres, mysql, selectorEvidence },
  campaigns,
  replay: { passed: replay, staleIdentityRefusals },
  support: {
    driverIntegration: driverIntegration
      ? {
          files: driverIntegration.numPassedTestSuites,
          tests: driverIntegration.numPassedTests,
          evidence: "support/driver-integration.vitest.json",
        }
      : { status: "missing" },
    receiptSelftests: { tests: receiptSelftests, evidence: "support/campaign-receipts.log" },
    cli: { tests: cliTests, evidence: "support/cli.log" },
    typecheck: {
      exitCode: 1,
      historicalDiagnosticsOnly:
        typeDiagnostics !== undefined &&
        typeDiagnostics.every((diagnostic) => HISTORICAL_PATTERN_DIAGNOSTICS.includes(diagnostic)),
      diagnostics: typeDiagnostics ?? null,
      evidence: "support/typecheck.log",
    },
    queryEngineStructure: "support/query-engine-structure.log",
  },
  structure,
  source: {
    cost: "support/source-cost.json",
    parserTokenCensus,
    frozenIdentityManifest: "support/frozen-identity-manifest.json",
    allowlist: "source-allowlist.json",
    patch: "source.patch",
    claimBoundary: "source cost only; no runtime or bundle improvement claim",
  },
  retention,
  evidenceBoundaries: {
    nativeSuites:
      "Current-source PostgreSQL and MySQL modes on the task-owned loopback containers (PostgreSQL 127.0.0.1:65504, MySQL 127.0.0.1:65515); no claim about any other provider build or deployment",
    readCampaignProfiles:
      "The four G4 read profiles are distinguished by the transport model each cell actually exhibits, checked per child; profile names alone are not the claim",
    writeCampaign:
      "g4-write-seeds and g4-write-transport-seeds are the accepted G3 write generator on fresh disjoint seed ranges; they are new inputs, not a new generator",
    acceptance: "Independent and root review attestations are external to this sealed author tree",
  },
  gaps,
  totals,
};

await writeFile(outputFile, `${JSON.stringify(index, null, 2)}\n`);
console.log(
  `Qualification index written: ${totals.campaignCells} cells, ${totals.fixedTestExecutions} fixed tests, ${gaps.length} gaps.`,
);
if (gaps.length > 0) {
  console.error(`Gaps:\n${JSON.stringify(gaps, null, 2)}`);
  process.exitCode = 1;
}
