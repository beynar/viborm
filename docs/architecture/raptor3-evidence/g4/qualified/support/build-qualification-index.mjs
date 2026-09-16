import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
 *
 * `readChildReproductions` counts the two G4 read-child re-runs, which the
 * generic replay loop deliberately skips so that each receipt is counted once,
 * in the list that describes what it is.
 */
const PINNED_TOTALS = {
  fixedModes: 65,
  fixedTestExecutions: 1742,
  fixedModesNotPassed: 0,
  laneFixedModes: 1,
  laneFixedTestExecutions: 33,
  laneFixedModesNotPassed: 0,
  postgresModes: 12,
  postgresTests: 64,
  postgresModesNotPassed: 0,
  mysqlModes: 11,
  mysqlTests: 69,
  mysqlModesNotPassed: 0,
  campaignModes: 15,
  campaignCells: 265_000,
  campaignExactReplays: 795_000,
  campaignSkips: 0,
  campaignModesNotPassed: 0,
  selectedReplays: 7,
  unsupportedReplayInputs: 2,
  readChildReproductions: 2,
  staleIdentityRefusals: 9,
};

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

/**
 * Replay receipts land as `<name>.receipt` under `replays/receipts/` (or
 * `replays/`), each with its `<name>.log` beside them. Three kinds live there
 * and the name says which: a `-stale` entry is a refusal the gate is supposed
 * to produce, a `.not-a-replay-input` entry is an input the generic `replay`
 * gate does not accept, and everything else is a replay that had to pass.
 */
const STALE_SENTENCE = /Stale Raptor 3 evidence: executed source or runtime changed/;
/** The two G4 read reproductions the replay note promises after the performance series. */
const promisedReproductions = ["g4-seed-batch-20000", "g4-transport-seed-batch-50000"];
const replay = [];
const staleIdentityRefusals = [];
const unsupportedReplayInputs = [];
const replaySeen = new Set();
for (const group of ["replays/receipts", "replays"]) {
  for (const directory of await receiptDirectories(group)) {
    const name = path.basename(directory, ".receipt");
    if (replaySeen.has(name) || promisedReproductions.includes(name)) continue;
    replaySeen.add(name);
    const label = `${group}/${name}`;
    const logFile = path.join(finalRoot, "replays", `${name}.log`);
    const log = existsSync(logFile) ? await readFile(logFile, "utf8") : undefined;
    const verifiedFile = path.join(directory, "verified.json");

    if (name.endsWith("-stale")) {
      // The expected refusal writes no verified receipt; the sentence is the evidence.
      const refused = log !== undefined && STALE_SENTENCE.test(log);
      if (!refused) gaps.push({ kind: "stale-refusal-missing-sentence", subject: label });
      staleIdentityRefusals.push({
        name,
        receipt: relative(directory),
        evidence: `replays/${name}.log`,
        exitCode: 1,
        status: refused ? "expected-refusal" : "unverified",
      });
      continue;
    }

    if (name.endsWith(".not-a-replay-input")) {
      // The gate prints a ZodError whose inner quotes are escaped, so match the
      // code and the key name rather than the rendered message sentence.
      const rejectedSubjectKey =
        log !== undefined &&
        /"code":\s*"unrecognized_keys"/.test(log) &&
        /"subject"/.test(log);
      if (!rejectedSubjectKey) {
        gaps.push({ kind: "unclassified-replay-refusal", subject: label });
      }
      unsupportedReplayInputs.push({
        name: name.replace(/\.not-a-replay-input$/, ""),
        receipt: relative(directory),
        evidence: `replays/${name}.log`,
        reason:
          'A G4 read child corpus carries the campaign subject ("candidate"/"shipped"); the generic replay gate\'s corpus schema rejects unknown keys. The runner reproduces a G4 read child by re-running its own seed batch, which is what that family\'s archive descriptor names as its replayCommand.',
        reproduction: `scripts/run-raptor3.mjs ${name.replace(/^g4-(seeds|transport-seeds)-(\d+)\.not-a-replay-input$/, (_, family, seed) => `g4-${family === "seeds" ? "seed-batch" : "transport-seed-batch"} ${seed}`)} --subject=candidate`,
        note: "replays/NOTE.md",
        status: rejectedSubjectKey ? "input-not-accepted-by-replay-gate" : "unclassified",
      });
      continue;
    }

    if (!existsSync(verifiedFile)) {
      gaps.push({ kind: "incomplete-receipt", subject: label });
      replay.push({ name, receipt: relative(directory), status: "incomplete" });
      continue;
    }
    const verified = JSON.parse(await readFile(verifiedFile, "utf8"));
    const identityOk = checkIdentity(verified.identity, label);
    replay.push({ name, receipt: relative(directory), status: identityOk ? "passed" : "failed" });
  }
}
replay.sort((left, right) => left.name.localeCompare(right.name));
staleIdentityRefusals.sort((left, right) => left.name.localeCompare(right.name));
unsupportedReplayInputs.sort((left, right) => left.name.localeCompare(right.name));

/** The two G4 read reproductions the replay note promises after the performance series. */
const reproductions = [];
for (const name of promisedReproductions) {
  const directory = path.join(finalRoot, "replays", "receipts", `${name}.receipt`);
  if (!existsSync(path.join(directory, "verified.json"))) {
    gaps.push({ kind: "pending-read-child-reproduction", subject: `replays/receipts/${name}.receipt` });
    reproductions.push({ name, receipt: `replays/receipts/${name}.receipt`, status: "pending" });
    continue;
  }
  const verified = JSON.parse(await readFile(path.join(directory, "verified.json"), "utf8"));
  const identityOk = checkIdentity(verified.identity, `replays/receipts/${name}`);
  const campaignFile = path.join(directory, "generated-campaign.json");
  const campaign = existsSync(campaignFile)
    ? JSON.parse(await readFile(campaignFile, "utf8"))
    : undefined;
  const descriptorFile = path.join(directory, "generated-corpus.archive.json");
  const descriptor = existsSync(descriptorFile)
    ? JSON.parse(await readFile(descriptorFile, "utf8"))
    : undefined;
  if (descriptor?.byteIdenticalToRetainedChild !== true) {
    gaps.push({ kind: "reproduction-not-byte-identical", subject: `replays/receipts/${name}` });
  }
  reproductions.push({
    name,
    receipt: relative(directory),
    subject: verified.subject,
    cells: campaign?.completed?.length,
    exactReplays: campaign?.replays,
    skipped: campaign?.skipped,
    reproducesRetainedChild: descriptor?.reproducesRetainedChild,
    byteIdenticalToRetainedChild: descriptor?.byteIdenticalToRetainedChild === true,
    status: identityOk ? "passed" : "failed",
  });
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

/** The driver's spelling first, the G3 spelling as a fallback, so either layout reads. */
async function firstSupportFile(candidates, label) {
  for (const file of candidates) {
    if (existsSync(path.join(finalRoot, file))) return file;
  }
  gaps.push({ kind: "missing-support-evidence", subject: label ?? candidates[0] });
  return undefined;
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

const receiptSelftestLog = await firstSupportFile(
  ["support/receipts-selftest.log", "support/campaign-receipts.log"],
  "support/receipts-selftest.log",
);
const cliSelftestLog = await firstSupportFile(
  ["support/cli-selftest.log", "support/cli.log"],
  "support/cli-selftest.log",
);

/** Both self-tests are node:test runs: the pass/fail tallies are the evidence. */
async function nodeTestCounts(file, label) {
  if (!file) return undefined;
  const text = await readFile(path.join(finalRoot, file), "utf8");
  const pass = text.match(/ℹ pass (\d+)\n/)?.[1];
  const fail = text.match(/ℹ fail (\d+)\n/)?.[1];
  if (pass === undefined || fail === undefined) {
    gaps.push({ kind: "unparsed-support-log", subject: file, expected: "node:test pass/fail tallies" });
    return undefined;
  }
  if (Number(fail) !== 0) {
    gaps.push({ kind: "failed-tests", subject: label, evidence: file, failedTests: Number(fail) });
  }
  return { tests: Number(pass), failed: Number(fail), evidence: file };
}

const receiptSelftests = await nodeTestCounts(receiptSelftestLog, "receipt self-tests");
const cliSelftests = await nodeTestCounts(cliSelftestLog, "CLI self-tests");

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

const sourceCostFile = await supportFile("support/source-cost.json");
await supportFile("support/query-engine-structure.log");
let sourceCost;
if (sourceCostFile) {
  const cost = await readJson("support/source-cost.json");
  if (cost.source?.commit !== baselineCommit) {
    gaps.push({
      kind: "source-cost-commit",
      subject: "support/source-cost.json",
      commit: cost.source?.commit,
      expected: baselineCommit,
    });
  }
  sourceCost = {
    charged: cost.accounting?.charged,
    navigationSubtotal: cost.accounting?.navigationSubtotal,
    censusOwner: cost.accounting?.censusOwner,
    censusFunctionSha256: cost.accounting?.censusFunctionSha256,
    status: cost.status,
  };
}
/**
 * G3 carried a separate `parser-token-census.json`. G4 does not need one: the
 * same census owner and function hash produce the per-file token-line census
 * inside `source-cost.json`, so the count has one authority instead of two.
 */
const parserTokenCensus = existsSync(path.join(finalRoot, "support/parser-token-census.json"))
  ? "support/parser-token-census.json"
  : "support/source-cost.json#files (per-file token-line census by the same census owner and function hash)";

/**
 * The two credential-free selectors are log-only: their launchers print
 * selection and resource lines but write no JSON identity companion. The
 * provenance record therefore states the command, the summed selection, the
 * resource line and the log's own hash — and says plainly that the log does
 * not embed the identity.
 */
const selectorSpecs = [
  {
    name: "credential-free aggregate",
    only: "Raptor 3 fixed",
    candidates: ["support/credential-free-fixed.log"],
  },
  {
    name: "PGlite provider selector",
    only: "raptor3-provider:",
    candidates: ["support/credential-free-provider.log", "support/pglite.log"],
  },
];
const nodeBin = "/Users/arnaud/.vite-plus/js_runtime/node/24.21.0/bin/node";
const selectors = [];
for (const spec of selectorSpecs) {
  const file = await firstSupportFile(spec.candidates, spec.candidates[0]);
  if (!file) {
    selectors.push({ name: spec.name, evidence: spec.candidates[0], status: "missing" });
    continue;
  }
  const text = await readFile(path.join(finalRoot, file), "utf8");
  const testFiles = [...text.matchAll(/^\s*Test Files\s+(\d+) passed \(\d+\)$/gm)].reduce(
    (total, match) => total + Number(match[1]),
    0,
  );
  const tests = [...text.matchAll(/^\s*Tests\s+(\d+) passed \(\d+\)$/gm)].reduce(
    (total, match) => total + Number(match[1]),
    0,
  );
  const failed = /\bfailed\b/.test(text);
  if (failed) gaps.push({ kind: "failed-tests", subject: spec.name, evidence: file });
  selectors.push({
    name: spec.name,
    command: `${nodeBin} scripts/run-credential-free-tests.mjs --only ${JSON.stringify(spec.only)}`,
    evidence: file,
    evidenceSha256: createHash("sha256").update(text).digest("hex"),
    selection: { testFiles, tests },
    resourceLines: [...text.matchAll(/^.*peak sampled process-group RSS.*$/gm)]
      .map((match) => match[0].trim())
      .slice(-2),
    status: failed ? "failed" : "passed",
  });
}
const selectorProvenance = {
  formatVersion: 1,
  milestone: "g4",
  identity,
  qualificationFreeze:
    "Both selectors ran during the frozen no-edit qualification window. Their launchers emit bounded stdout and resource evidence but no JSON identity companion; this record does not claim the logs embed identity.",
  runtimeInvocation: { node: nodeBin, pathPrefix: path.dirname(nodeBin) },
  selectors,
};
await writeFile(
  path.join(finalRoot, "selector-launch-provenance.json"),
  `${JSON.stringify(selectorProvenance, null, 2)}\n`,
);

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
  unsupportedReplayInputs: unsupportedReplayInputs.length,
  readChildReproductions: reproductions.filter((entry) => entry.status === "passed").length,
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
  native: { postgres, mysql },
  campaigns,
  replay: {
    passed: replay,
    staleIdentityRefusals,
    unsupportedReplayInputs,
    readChildReproductions: reproductions,
    note: existsSync(path.join(finalRoot, "replays/NOTE.md")) ? "replays/NOTE.md" : null,
  },
  support: {
    driverIntegration: driverIntegration
      ? {
          // testResults is the file list; numPassedTestSuites double-counts a
          // file that a workspace project reports more than once.
          files: driverIntegration.testResults?.length ?? driverIntegration.numPassedTestSuites,
          tests: driverIntegration.numPassedTests,
          evidence: "support/driver-integration.vitest.json",
        }
      : { status: "missing" },
    receiptSelftests: receiptSelftests ?? { status: "missing" },
    cli: cliSelftests ?? { status: "missing" },
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
    current: sourceCost ?? { status: "missing" },
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
