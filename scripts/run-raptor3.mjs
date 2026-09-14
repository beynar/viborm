import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RAPTOR3_ROOT,
  RAPTOR3_TESTS,
  G1_COMPARISON_TESTS,
  G1_COMPARISON_COUNTS,
  G1_BASELINE_TESTS,
  G1_BASELINE_COUNTS,
  G1_CONTRACT_TESTS,
  G1_CONTRACT_COUNTS,
  G2_BASELINE_TESTS,
  G2_BASELINE_COUNTS,
  G2_CONTRACT_TESTS,
  G2_DIAGNOSTIC_TESTS,
  G2_DIAGNOSTIC_COUNTS,
  G2_CONTRACT_COUNTS,
  G25_CONTRACT_COUNTS,
  G25_CONTRACT_TESTS,
  G25_PG_CONTRACT_COUNTS,
  G25_PG_CONTRACT_TESTS,
  G27_CONTRACT_COUNTS,
  G27_CONTRACT_TESTS,
  G27_MYSQL_CONTRACT_COUNTS,
  G27_MYSQL_CONTRACT_TESTS,
  G27_PG_CONTRACT_COUNTS,
  G27_PG_CONTRACT_TESTS,
  G3P02_CONTRACT_COUNTS,
  G3P02_CONTRACT_TESTS,
  G3P02_MYSQL_CONTRACT_COUNTS,
  G3P02_MYSQL_CONTRACT_TESTS,
  G3P02_PG_CONTRACT_COUNTS,
  G3P02_PG_CONTRACT_TESTS,
  G3P03_CONTRACT_COUNTS,
  G3P03_CONTRACT_TESTS,
  G3P03_MYSQL_CONTRACT_COUNTS,
  G3P03_MYSQL_CONTRACT_TESTS,
  G3P03_PG_CONTRACT_COUNTS,
  G3P03_PG_CONTRACT_TESTS,
  G3P04_CONTRACT_COUNTS,
  G3P04_CONTRACT_TESTS,
  G3P04_REVIEW_CONTRACT_COUNTS,
  G3P04_REVIEW_CONTRACT_TESTS,
  G3P04_MYSQL_CONTRACT_COUNTS,
  G3P04_MYSQL_CONTRACT_TESTS,
  G3P04_PG_CONTRACT_COUNTS,
  G3P04_PG_CONTRACT_TESTS,
  G3P05_CONTRACT_COUNTS,
  G3P05_CONTRACT_TESTS,
  POST_G3_CLEARABILITY_CONTRACT_COUNTS,
  POST_G3_CLEARABILITY_CONTRACT_TESTS,
  POST_G3_CLEARABILITY_MYSQL_CONTRACT_COUNTS,
  POST_G3_CLEARABILITY_MYSQL_CONTRACT_TESTS,
  POST_G3_CLEARABILITY_PG_CONTRACT_COUNTS,
  POST_G3_CLEARABILITY_PG_CONTRACT_TESTS,
  POST_G3_SCHEMA_VIEW_COUNTS,
  POST_G3_SCHEMA_VIEW_TESTS,
  POST_G3_PROJECTION_PREPARATION_COUNTS,
  POST_G3_PROJECTION_PREPARATION_TESTS,
  POST_G3_SELECTOR_PREPARATION_COUNTS,
  POST_G3_SELECTOR_PREPARATION_TESTS,
  POST_G3_HISTORY_ANALYSIS_COUNTS,
  POST_G3_HISTORY_ANALYSIS_TESTS,
  G29_MEMBER_DEPENDENCY_COUNTS,
  G29_MEMBER_DEPENDENCY_TESTS,
  G29_DEPENDENCY_BOUNDARY_COUNTS,
  G29_DEPENDENCY_BOUNDARY_TESTS,
  G29_DEPENDENCY_CHOICE_COUNTS,
  G29_DEPENDENCY_CHOICE_TESTS,
  G29_RESULT_PROGRESS_COUNTS,
  G29_RESULT_PROGRESS_TESTS,
  CS01_STRUCTURAL_REFERENCE_COUNTS,
  CS01_STRUCTURAL_REFERENCE_TESTS,
  CS01_EXTENSION_A_COUNTS,
  CS01_EXTENSION_A_TESTS,
  CS01_EXTENSION_B_COUNTS,
  CS01_EXTENSION_B_TESTS,
  CS01_EXTENSION_COMPOSITION_COUNTS,
  CS01_EXTENSION_COMPOSITION_TESTS,
  CS03_MEMBER_SCOPE_COUNTS,
  CS03_MEMBER_SCOPE_TESTS,
  CS03_EXTENSION_CAMPAIGNS,
  CS03_EXTENSION_CAMPAIGN_COUNTS,
  CS03_EXTENSION_CAMPAIGN_TESTS,
  CS02_STRUCTURE_MEASUREMENT_COUNTS,
  CS02_STRUCTURE_MEASUREMENT_TESTS,
  G29_MEMBER_DEPENDENCY_MYSQL_COUNTS,
  G29_MEMBER_DEPENDENCY_MYSQL_TESTS,
  G29_MEMBER_DEPENDENCY_PG_COUNTS,
  G29_MEMBER_DEPENDENCY_PG_TESTS,
  G3P05_RECURSIVE_READ_FIT_COUNTS,
  G3P05_RECURSIVE_READ_FIT_TESTS,
  G3P05_SELECTOR_DEPENDENCY_COUNTS,
  G3P05_SELECTOR_DEPENDENCY_TESTS,
  G3P05_VARIANT_COLLECTION_ORDER_COUNTS,
  G3P05_VARIANT_COLLECTION_ORDER_TESTS,
  G2_MYSQL_BASELINE_TESTS,
  G2_MYSQL_BASELINE_COUNTS,
  G2_MYSQL_CONTRACT_TESTS,
  G2_MYSQL_CONTRACT_COUNTS,
  G2_PG_BASELINE_TESTS,
  G2_PG_CONTRACT_TESTS,
  G2_PG_BASELINE_COUNTS,
  G2_PG_CONTRACT_COUNTS,
  G1_GENERATED_TESTS,
  G1_GENERATED_COUNTS,
  G1_CAMPAIGN_TESTS,
  G1_CAMPAIGN,
  G2_CAMPAIGN,
  G2_CAMPAIGN_TESTS,
  G2_GENERATED_COUNTS,
  G2_GENERATED_TESTS,
  G1_TRANSPORT_COUNTS,
  G1_TRANSPORT_TESTS,
  G1_TRANSPORT_CAMPAIGN_TESTS,
  G1_TRANSPORT_CAMPAIGN,
  G2_TRANSPORT_COUNTS,
  G2_TRANSPORT_TESTS,
  G2_TRANSPORT_CAMPAIGN,
  G2_TRANSPORT_CAMPAIGN_TESTS,
  G3P06_CAMPAIGN,
  G3P06_CAMPAIGN_TESTS,
  G3P06_TRANSPORT_CAMPAIGN,
  G3P06_TRANSPORT_CAMPAIGN_TESTS,
  assertGeneratedBatchReceipt,
  G0_RESOURCES,
  captureRaptor3Identity,
  assertRaptor3Identity,
  assertStructuralMeasurementRuntime,
  assertG0CampaignReceipt,
  assertExtensionCampaignReceipt,
} from "./raptor3-manifest.mjs";
function structuralMeasurementContext(mode, instrumentedIdentity) {
  if (mode !== "cs02-structure-measure") return undefined;
  const baseIdentityFile = process.env.VIBORM_RAPTOR3_MEASUREMENT_BASE_IDENTITY;
  const instrumentationPatchFile = process.env.VIBORM_RAPTOR3_MEASUREMENT_PATCH;
  const alternative = process.env.VIBORM_RAPTOR3_MEASUREMENT_ALTERNATIVE;
  assert(
    baseIdentityFile,
    "Structural measurement requires its base identity file"
  );
  assert(
    instrumentationPatchFile,
    "Structural measurement requires its instrumentation patch"
  );
  assert(
    alternative === "flat-history-reference" ||
      alternative === "shared-occurrence-candidate",
    "Structural measurement requires one named alternative"
  );
  const resolvedBaseIdentity = resolve(baseIdentityFile);
  const resolvedPatch = resolve(instrumentationPatchFile);
  assert(
    existsSync(resolvedBaseIdentity),
    "Structural measurement base identity is missing"
  );
  assert(existsSync(resolvedPatch), "Structural measurement patch is missing");
  const baseIdentity = JSON.parse(readFileSync(resolvedBaseIdentity, "utf8"));
  assertStructuralMeasurementRuntime(baseIdentity, instrumentedIdentity);
  assert.notDeepEqual(
    baseIdentity,
    instrumentedIdentity,
    "Structural measurement instrumentation did not change the executed identity"
  );
  return {
    alternative,
    baseIdentity,
    instrumentedIdentity,
    instrumentationPatchFile: resolvedPatch,
  };
}

function campaignFor(mode) {
  const campaigns = mode.startsWith("g3p06-")
    ? {
        sqlite: G3P06_CAMPAIGN,
        transport: G3P06_TRANSPORT_CAMPAIGN,
      }
    : mode.startsWith("g2-")
      ? { sqlite: G2_CAMPAIGN, transport: G2_TRANSPORT_CAMPAIGN }
      : { sqlite: G1_CAMPAIGN, transport: G1_TRANSPORT_CAMPAIGN };
  return campaigns[mode.includes("-transport") ? "transport" : "sqlite"];
}

export function parseRaptor3Request(arguments_) {
  const limitArguments = arguments_.filter((argument) =>
    argument.startsWith("--wall-limit-ms=")
  );
  assert(limitArguments.length <= 1, "Wall limit may be specified only once");
  const wallMs =
    limitArguments.length === 0
      ? G0_RESOURCES.wallMs
      : Number(limitArguments[0].slice("--wall-limit-ms=".length));
  assert(
    Number.isSafeInteger(wallMs) && wallMs > 0 && wallMs <= G0_RESOURCES.wallMs,
    "Wall limit can only lower the G0 ceiling"
  );
  const positional = arguments_.filter(
    (argument) => !limitArguments.includes(argument)
  );
  if (
    positional.length === 1 &&
    [
      "g0",
      "g1-compare",
      "g1-baseline",
      "g1-contracts",
      "g1-generated",
      "g1-seeds",
      "g1-transport",
      "g1-transport-seeds",
      "g2-baseline",
      "g2-contracts",
      "g25-contracts",
      "g25-pg-contracts",
      "g27-contracts",
      "g27-pg-contracts",
      "g27-mysql-contracts",
      "g3p02-contracts",
      "g3p02-pg-contracts",
      "g3p02-mysql-contracts",
      "g3p03-contracts",
      "g3p03-pg-contracts",
      "g3p03-mysql-contracts",
      "g3p04-contracts",
      "g3p04-review-contracts",
      "g3p04-pg-contracts",
      "g3p04-mysql-contracts",
      "g3p05-contracts",
      "g3p05-selector-dependencies",
      "g3p05-variant-collection-order",
      "g3p05-recursive-read-fit",
      "post-g3-clearability-contracts",
      "post-g3-clearability-pg-contracts",
      "post-g3-clearability-mysql-contracts",
      "post-g3-schema-views",
      "post-g3-projection-preparation",
      "post-g3-selector-preparation",
      "post-g3-history-analysis",
      "g29-member-dependency",
      "g29-dependency-boundaries",
      "g29-dependency-choices",
      "g29-result-progress",
      "cs01-structural-reference",
      "cs01-extension-a",
      "cs01-extension-b",
      "cs01-extension-composition",
      "cs03-member-scope",
      "cs03-extension-a-seeds",
      "cs03-extension-b-seeds",
      "cs03-extension-composition-seeds",
      "cs02-structure-measure",
      "g29-member-dependency-pg",
      "g29-member-dependency-mysql",
      "g3p06-seeds",
      "g3p06-transport-seeds",
      "g2-diagnostics",
      "g2-pg-baseline",
      "g2-pg-contracts",
      "g2-mysql-baseline",
      "g2-mysql-contracts",
      "g2-seeds",
      "g2-generated",
      "g2-transport",
      "g2-transport-seeds",
    ].includes(positional[0])
  )
    return { mode: positional[0], wallMs };
  if (
    positional.length === 2 &&
    [
      "g1-seed-batch",
      "g1-transport-seed-batch",
      "g2-seed-batch",
      "g2-transport-seed-batch",
      "g3p06-seed-batch",
      "g3p06-transport-seed-batch",
    ].includes(positional[0])
  ) {
    const firstSeed = Number(positional[1]);
    const campaign = campaignFor(positional[0]);
    assert(
      Number.isInteger(firstSeed) &&
        firstSeed >= campaign.firstSeed &&
        firstSeed + campaign.batchSize <=
          campaign.firstSeed + campaign.seedCount &&
        (firstSeed - campaign.firstSeed) % campaign.batchSize === 0,
      "Generated batch must start at an exact frozen boundary"
    );
    return { mode: positional[0], firstSeed, wallMs };
  }
  if (positional.length === 2 && positional[0] === "replay" && positional[1]) {
    const path = resolve(positional[1]);
    assert(existsSync(path), "The replay corpus does not exist");
    return { mode: "replay", path, wallMs };
  }
  throw new Error(
    "Usage: node scripts/run-raptor3.mjs g0 | g1-compare | g1-baseline | g1-contracts | g1-generated | g1-seeds | g1-seed-batch <first-seed> | g1-transport | g1-transport-seeds | g1-transport-seed-batch <first-seed> | g2-baseline | g2-contracts | g25-contracts | g25-pg-contracts | g27-contracts | g27-pg-contracts | g27-mysql-contracts | g3p02-contracts | g3p02-pg-contracts | g3p02-mysql-contracts | g3p03-contracts | g3p03-pg-contracts | g3p03-mysql-contracts | g3p04-contracts | g3p04-review-contracts | g3p04-pg-contracts | g3p04-mysql-contracts | g3p05-contracts | g3p05-selector-dependencies | g3p05-variant-collection-order | g3p05-recursive-read-fit | post-g3-clearability-contracts | post-g3-clearability-pg-contracts | post-g3-clearability-mysql-contracts | post-g3-schema-views | post-g3-projection-preparation | post-g3-selector-preparation | post-g3-history-analysis | g29-member-dependency | g29-dependency-boundaries | g29-dependency-choices | g29-result-progress | cs01-structural-reference | cs01-extension-a | cs01-extension-b | cs01-extension-composition | cs03-member-scope | cs03-extension-a-seeds | cs03-extension-b-seeds | cs03-extension-composition-seeds | cs02-structure-measure | g29-member-dependency-pg | g29-member-dependency-mysql | g3p06-seeds | g3p06-seed-batch <first-seed> | g3p06-transport-seeds | g3p06-transport-seed-batch <first-seed> | g2-generated | g2-seeds | g2-seed-batch <first-seed> | g2-transport | g2-transport-seeds | g2-transport-seed-batch <first-seed> | g2-diagnostics | g2-pg-baseline | g2-pg-contracts | g2-mysql-baseline | g2-mysql-contracts | replay <corpus.json>. Gate selection cannot be filtered."
  );
}

export function assertRaptor3TestReport(report, files) {
  assert.equal(report.success, true, "The executed Raptor 3 tests failed");
  assert(report.numTotalTests > 0, "Zero-case execution cannot pass the gate");
  assert.equal(
    report.numPendingTests,
    0,
    "Required Raptor 3 tests were skipped"
  );
  assert.deepEqual(
    report.testResults.map((suite) => suite.name).sort(),
    files.map((file) => resolve(RAPTOR3_ROOT, file)).sort(),
    "Missing required Raptor 3 test file"
  );
  for (const suite of report.testResults) {
    assert(
      suite.assertionResults.length > 0,
      "Empty required Raptor 3 test file"
    );
    for (const test of suite.assertionResults)
      assert.equal(test.status, "passed");
  }
}

async function run(request) {
  const identity = captureRaptor3Identity();
  const measurement = structuralMeasurementContext(request.mode, identity);
  const extensionCampaign = CS03_EXTENSION_CAMPAIGNS[request.mode];
  const campaign = extensionCampaign ?? campaignFor(request.mode);
  if (request.mode.endsWith("-seeds") && !extensionCampaign) {
    const directory = mkdtempSync(
      join(tmpdir(), `viborm-raptor3-${request.mode}-`)
    );
    const batches = [];
    for (
      let firstSeed = campaign.firstSeed;
      firstSeed < campaign.firstSeed + campaign.seedCount;
      firstSeed += campaign.batchSize
    ) {
      assertRaptor3Identity(identity);
      const receiptDirectory = await run({
        mode: request.mode.replace(/seeds$/, "seed-batch"),
        firstSeed,
        wallMs: request.wallMs,
      });
      batches.push({ firstSeed, directory: receiptDirectory });
    }
    assertRaptor3Identity(identity);
    writeFileSync(
      join(directory, "verified.json"),
      JSON.stringify(
        { mode: request.mode, identity, campaign, batches },
        null,
        2
      )
    );
    process.stdout.write(
      `Raptor 3 ${request.mode} campaign verified (not the full milestone). Evidence: ${directory}\n`
    );
    return directory;
  }
  const replayInput =
    request.mode === "replay"
      ? {
          path: request.path,
          sha256: createHash("sha256")
            .update(readFileSync(request.path))
            .digest("hex"),
        }
      : undefined;
  const directory = mkdtempSync(join(tmpdir(), "viborm-raptor3-g0-"));
  const files = {
    g0: RAPTOR3_TESTS,
    "g1-compare": G1_COMPARISON_TESTS,
    "g1-baseline": G1_BASELINE_TESTS,
    "g1-contracts": G1_CONTRACT_TESTS,
    "g2-baseline": G2_BASELINE_TESTS,
    "g2-contracts": G2_CONTRACT_TESTS,
    "g25-contracts": G25_CONTRACT_TESTS,
    "g25-pg-contracts": G25_PG_CONTRACT_TESTS,
    "g27-contracts": G27_CONTRACT_TESTS,
    "g27-pg-contracts": G27_PG_CONTRACT_TESTS,
    "g27-mysql-contracts": G27_MYSQL_CONTRACT_TESTS,
    "g3p02-contracts": G3P02_CONTRACT_TESTS,
    "g3p02-pg-contracts": G3P02_PG_CONTRACT_TESTS,
    "g3p02-mysql-contracts": G3P02_MYSQL_CONTRACT_TESTS,
    "g3p03-contracts": G3P03_CONTRACT_TESTS,
    "g3p03-pg-contracts": G3P03_PG_CONTRACT_TESTS,
    "g3p03-mysql-contracts": G3P03_MYSQL_CONTRACT_TESTS,
    "g3p04-contracts": G3P04_CONTRACT_TESTS,
    "g3p04-review-contracts": G3P04_REVIEW_CONTRACT_TESTS,
    "g3p04-pg-contracts": G3P04_PG_CONTRACT_TESTS,
    "g3p04-mysql-contracts": G3P04_MYSQL_CONTRACT_TESTS,
    "g3p05-contracts": G3P05_CONTRACT_TESTS,
    "g3p05-selector-dependencies": G3P05_SELECTOR_DEPENDENCY_TESTS,
    "g3p05-variant-collection-order": G3P05_VARIANT_COLLECTION_ORDER_TESTS,
    "g3p05-recursive-read-fit": G3P05_RECURSIVE_READ_FIT_TESTS,
    "post-g3-clearability-contracts": POST_G3_CLEARABILITY_CONTRACT_TESTS,
    "post-g3-clearability-pg-contracts": POST_G3_CLEARABILITY_PG_CONTRACT_TESTS,
    "post-g3-clearability-mysql-contracts":
      POST_G3_CLEARABILITY_MYSQL_CONTRACT_TESTS,
    "post-g3-schema-views": POST_G3_SCHEMA_VIEW_TESTS,
    "post-g3-projection-preparation": POST_G3_PROJECTION_PREPARATION_TESTS,
    "post-g3-selector-preparation": POST_G3_SELECTOR_PREPARATION_TESTS,
    "post-g3-history-analysis": POST_G3_HISTORY_ANALYSIS_TESTS,
    "g29-member-dependency": G29_MEMBER_DEPENDENCY_TESTS,
    "g29-dependency-boundaries": G29_DEPENDENCY_BOUNDARY_TESTS,
    "g29-dependency-choices": G29_DEPENDENCY_CHOICE_TESTS,
    "g29-result-progress": G29_RESULT_PROGRESS_TESTS,
    "cs01-structural-reference": CS01_STRUCTURAL_REFERENCE_TESTS,
    "cs01-extension-a": CS01_EXTENSION_A_TESTS,
    "cs01-extension-b": CS01_EXTENSION_B_TESTS,
    "cs01-extension-composition": CS01_EXTENSION_COMPOSITION_TESTS,
    "cs03-member-scope": CS03_MEMBER_SCOPE_TESTS,
    "cs03-extension-a-seeds": CS03_EXTENSION_CAMPAIGN_TESTS,
    "cs03-extension-b-seeds": CS03_EXTENSION_CAMPAIGN_TESTS,
    "cs03-extension-composition-seeds": CS03_EXTENSION_CAMPAIGN_TESTS,
    "cs02-structure-measure": CS02_STRUCTURE_MEASUREMENT_TESTS,
    "g29-member-dependency-pg": G29_MEMBER_DEPENDENCY_PG_TESTS,
    "g29-member-dependency-mysql": G29_MEMBER_DEPENDENCY_MYSQL_TESTS,
    "g2-diagnostics": G2_DIAGNOSTIC_TESTS,
    "g2-pg-baseline": G2_PG_BASELINE_TESTS,
    "g2-pg-contracts": G2_PG_CONTRACT_TESTS,
    "g2-mysql-baseline": G2_MYSQL_BASELINE_TESTS,
    "g2-mysql-contracts": G2_MYSQL_CONTRACT_TESTS,
    "g1-generated": G1_GENERATED_TESTS,
    "g2-generated": G2_GENERATED_TESTS,
    "g1-seed-batch": G1_CAMPAIGN_TESTS,
    "g2-seed-batch": G2_CAMPAIGN_TESTS,
    "g3p06-seed-batch": G3P06_CAMPAIGN_TESTS,
    "g1-transport": G1_TRANSPORT_TESTS,
    "g1-transport-seed-batch": G1_TRANSPORT_CAMPAIGN_TESTS,
    "g2-transport": G2_TRANSPORT_TESTS,
    "g2-transport-seed-batch": G2_TRANSPORT_CAMPAIGN_TESTS,
    "g3p06-transport-seed-batch": G3P06_TRANSPORT_CAMPAIGN_TESTS,
    replay: ["tests/raptor3/gate.test.ts"],
  }[request.mode];
  for (const file of files)
    assert(
      existsSync(resolve(RAPTOR3_ROOT, file)),
      `Missing required test ${file}`
    );
  const reportPath = join(directory, "vitest.json");
  const environment = { ...process.env };
  const provider =
    /^g(?:2|25|27|3p02|3p03|3p04)-(pg|mysql)-/.exec(request.mode)?.[1] ??
    /^post-g3-clearability-(pg|mysql)-/.exec(request.mode)?.[1] ??
    /^g29-member-dependency-(pg|mysql)$/.exec(request.mode)?.[1];
  if (provider) environment.VIBORM_RAPTOR3_PROVIDER = provider;
  delete environment.VIBORM_RAPTOR3_REPLAY_PATH;
  delete environment.VIBORM_RAPTOR3_GENERATED_FIRST_SEED;
  delete environment.VIBORM_RAPTOR3_EXTENSION_SLICE;
  if (extensionCampaign)
    environment.VIBORM_RAPTOR3_EXTENSION_SLICE = extensionCampaign.slice;
  if (request.mode.endsWith("seed-batch"))
    environment.VIBORM_RAPTOR3_GENERATED_FIRST_SEED = String(request.firstSeed);
  if (/^g(?:1|2|25|27|29|3p02|3p03|3p04|3p06)-/.test(request.mode))
    delete environment.VIBORM_RAPTOR3_SPECIMEN;
  if (request.mode === "g3p02-contracts")
    environment.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY_CONTRACT = "1";
  else delete environment.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY_CONTRACT;
  environment.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY = directory;
  if (request.mode === "replay")
    environment.VIBORM_RAPTOR3_REPLAY_PATH = request.path;
  const child = spawn(
    process.execPath,
    [
      "scripts/run-vitest-safe.mjs",
      "run",
      "--workspace",
      "vitest.workspace.ts",
      provider ? "--project=raptor3-live-provider" : "--project=raptor3",
      `--wall-limit-ms=${request.wallMs}`,
      `--heap-limit-mb=${G0_RESOURCES.heapMb}`,
      `--rss-limit-mb=${G0_RESOURCES.rssMb}`,
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${reportPath}`,
      ...files,
    ],
    { cwd: RAPTOR3_ROOT, env: environment, stdio: "inherit" }
  );
  let interrupted = false;
  const interrupt = (signal) => {
    interrupted = true;
    child.kill(signal);
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = signals.map((signal) => () => interrupt(signal));
  signals.forEach((signal, index) => process.on(signal, handlers[index]));
  try {
    const exitCode = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    });
    assert(
      !interrupted && exitCode === 0,
      `Raptor 3 verification failed; diagnostics: ${directory}`
    );
    assertRaptor3Identity(identity);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assertRaptor3TestReport(report, files);
    const expectedCounts = {
      "g1-compare": G1_COMPARISON_COUNTS,
      "g1-baseline": G1_BASELINE_COUNTS,
      "g1-contracts": G1_CONTRACT_COUNTS,
      "g2-baseline": G2_BASELINE_COUNTS,
      "g2-contracts": G2_CONTRACT_COUNTS,
      "g25-contracts": G25_CONTRACT_COUNTS,
      "g25-pg-contracts": G25_PG_CONTRACT_COUNTS,
      "g27-contracts": G27_CONTRACT_COUNTS,
      "g27-pg-contracts": G27_PG_CONTRACT_COUNTS,
      "g27-mysql-contracts": G27_MYSQL_CONTRACT_COUNTS,
      "g3p02-contracts": G3P02_CONTRACT_COUNTS,
      "g3p02-pg-contracts": G3P02_PG_CONTRACT_COUNTS,
      "g3p02-mysql-contracts": G3P02_MYSQL_CONTRACT_COUNTS,
      "g3p03-contracts": G3P03_CONTRACT_COUNTS,
      "g3p03-pg-contracts": G3P03_PG_CONTRACT_COUNTS,
      "g3p03-mysql-contracts": G3P03_MYSQL_CONTRACT_COUNTS,
      "g3p04-contracts": G3P04_CONTRACT_COUNTS,
      "g3p04-review-contracts": G3P04_REVIEW_CONTRACT_COUNTS,
      "g3p04-pg-contracts": G3P04_PG_CONTRACT_COUNTS,
      "g3p04-mysql-contracts": G3P04_MYSQL_CONTRACT_COUNTS,
      "g3p05-contracts": G3P05_CONTRACT_COUNTS,
      "g3p05-selector-dependencies": G3P05_SELECTOR_DEPENDENCY_COUNTS,
      "g3p05-variant-collection-order": G3P05_VARIANT_COLLECTION_ORDER_COUNTS,
      "g3p05-recursive-read-fit": G3P05_RECURSIVE_READ_FIT_COUNTS,
      "post-g3-clearability-contracts": POST_G3_CLEARABILITY_CONTRACT_COUNTS,
      "post-g3-clearability-pg-contracts":
        POST_G3_CLEARABILITY_PG_CONTRACT_COUNTS,
      "post-g3-clearability-mysql-contracts":
        POST_G3_CLEARABILITY_MYSQL_CONTRACT_COUNTS,
      "post-g3-schema-views": POST_G3_SCHEMA_VIEW_COUNTS,
      "post-g3-projection-preparation": POST_G3_PROJECTION_PREPARATION_COUNTS,
      "post-g3-selector-preparation": POST_G3_SELECTOR_PREPARATION_COUNTS,
      "post-g3-history-analysis": POST_G3_HISTORY_ANALYSIS_COUNTS,
      "g29-member-dependency": G29_MEMBER_DEPENDENCY_COUNTS,
      "g29-dependency-boundaries": G29_DEPENDENCY_BOUNDARY_COUNTS,
      "g29-dependency-choices": G29_DEPENDENCY_CHOICE_COUNTS,
      "g29-result-progress": G29_RESULT_PROGRESS_COUNTS,
      "cs01-structural-reference": CS01_STRUCTURAL_REFERENCE_COUNTS,
      "cs01-extension-a": CS01_EXTENSION_A_COUNTS,
      "cs01-extension-b": CS01_EXTENSION_B_COUNTS,
      "cs01-extension-composition": CS01_EXTENSION_COMPOSITION_COUNTS,
      "cs03-member-scope": CS03_MEMBER_SCOPE_COUNTS,
      "cs03-extension-a-seeds": CS03_EXTENSION_CAMPAIGN_COUNTS,
      "cs03-extension-b-seeds": CS03_EXTENSION_CAMPAIGN_COUNTS,
      "cs03-extension-composition-seeds": CS03_EXTENSION_CAMPAIGN_COUNTS,
      "cs02-structure-measure": CS02_STRUCTURE_MEASUREMENT_COUNTS,
      "g29-member-dependency-pg": G29_MEMBER_DEPENDENCY_PG_COUNTS,
      "g29-member-dependency-mysql": G29_MEMBER_DEPENDENCY_MYSQL_COUNTS,
      "g2-diagnostics": G2_DIAGNOSTIC_COUNTS,
      "g2-pg-baseline": G2_PG_BASELINE_COUNTS,
      "g2-pg-contracts": G2_PG_CONTRACT_COUNTS,
      "g2-mysql-baseline": G2_MYSQL_BASELINE_COUNTS,
      "g2-mysql-contracts": G2_MYSQL_CONTRACT_COUNTS,
      "g1-generated": G1_GENERATED_COUNTS,
      "g2-generated": G2_GENERATED_COUNTS,
      "g1-seed-batch": { "tests/raptor3/generated-campaign.test.ts": 1 },
      "g2-seed-batch": { "tests/raptor3/g2-campaign.test.ts": 1 },
      "g3p06-seed-batch": { "tests/raptor3/g2-campaign.test.ts": 1 },
      "g1-transport": G1_TRANSPORT_COUNTS,
      "g1-transport-seed-batch": {
        "tests/raptor3/transport-campaign.test.ts": 1,
      },
      "g2-transport": G2_TRANSPORT_COUNTS,
      "g2-transport-seed-batch": {
        "tests/raptor3/transport-campaign.test.ts": 1,
      },
      "g3p06-transport-seed-batch": {
        "tests/raptor3/transport-campaign.test.ts": 1,
      },
    }[request.mode];
    if (expectedCounts) {
      for (const [file, expected] of Object.entries(expectedCounts)) {
        const comparison = report.testResults.find(
          (suite) => suite.name === resolve(RAPTOR3_ROOT, file)
        );
        assert.equal(
          comparison.assertionResults.length,
          expected,
          `Missing candidate/profile/scenario cell in ${file}`
        );
      }
    }
    if (replayInput) {
      assert.equal(
        createHash("sha256")
          .update(readFileSync(replayInput.path))
          .digest("hex"),
        replayInput.sha256,
        "Replay input changed during verification"
      );
    }
    if (request.mode === "g0") {
      const receipt = JSON.parse(
        readFileSync(join(directory, "campaign.json"), "utf8")
      );
      assertRaptor3Identity(receipt.identity, identity);
      assertG0CampaignReceipt(receipt);
    }
    if (extensionCampaign) {
      const receipt = JSON.parse(
        readFileSync(join(directory, "extension-campaign.json"), "utf8")
      );
      assertExtensionCampaignReceipt(receipt, extensionCampaign, identity);
      const corpus = JSON.parse(
        readFileSync(join(directory, "corpus.json"), "utf8")
      );
      assert.equal(corpus.formatVersion, 1);
      assertRaptor3Identity(corpus.identity, identity);
      assert.equal(corpus.records[0], "array");
      assert.equal(
        corpus.records[1].length,
        extensionCampaign.seedCount * extensionCampaign.profiles.length
      );
    }
    if (request.mode.endsWith("seed-batch"))
      assertGeneratedBatchReceipt(
        JSON.parse(
          readFileSync(join(directory, "generated-campaign.json"), "utf8")
        ),
        request.firstSeed,
        campaign
      );
    if (measurement) {
      const receipt = JSON.parse(
        readFileSync(join(directory, "verified.json"), "utf8")
      );
      assert.equal(receipt.mode, request.mode);
      assert.equal(receipt.alternative, measurement.alternative);
      assert.deepEqual(receipt.baseIdentity, measurement.baseIdentity);
      assert.deepEqual(receipt.instrumentedIdentity, identity);
      assert.equal(receipt.cases.length, 28);
      assert.equal(receipt.replays, 60);
      assert.equal(receipt.skipped, 0);
      process.stdout.write(
        `Raptor 3 ${request.mode} measurement verified. Evidence: ${directory}\n`
      );
      return directory;
    }
    writeFileSync(
      join(directory, "verified.json"),
      JSON.stringify(
        {
          mode: request.mode,
          identity,
          replayInput,
          resourceBounds: { ...G0_RESOURCES, wallMs: request.wallMs },
        },
        null,
        2
      )
    );
    process.stdout.write(
      `Raptor 3 ${request.mode} ${request.mode === "g2-diagnostics" ? "disputed behavior reproduced (not accepted)" : "contract gate verified"}. Evidence: ${directory}\n`
    );
    return directory;
  } finally {
    signals.forEach((signal, index) => process.off(signal, handlers[index]));
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await run(parseRaptor3Request(process.argv.slice(2)));
  } catch (failure) {
    process.stderr.write(
      `${failure instanceof Error ? failure.message : String(failure)}\n`
    );
    process.exitCode = 1;
  }
}
