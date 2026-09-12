import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RAPTOR3_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const RAPTOR3_TESTS = Object.freeze([
  "tests/raptor3/fixed.test.ts",
  "tests/raptor3/gate.test.ts",
]);
export const G1_COMPARISON_COUNTS = Object.freeze({
  "tests/raptor3/candidate.test.ts": 48,
  "tests/raptor3/candidate-handoff.test.ts": 6,
  "tests/raptor3/candidate-ordering.test.ts": 4,
  "tests/raptor3/candidate-pagination.test.ts": 8,
});
export const G1_COMPARISON_TESTS = Object.freeze(
  Object.keys(G1_COMPARISON_COUNTS),
);
export const G1_BASELINE_COUNTS = Object.freeze({
  "tests/raptor3/expanded/variant-identity-legacy.test.ts": 42,
  "tests/raptor3/expanded/legacy.test.ts": 82,
  "tests/raptor3/expanded/lifetime-legacy.test.ts": 16,
  "tests/raptor3/expanded/compound-falsifier.test.ts": 1,
});
export const G1_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/cleanup-failure.test.ts": 2,
  "tests/raptor3/expanded/variant-identity-commands.test.ts": 42,
  "tests/raptor3/expanded/commands.test.ts": 82,
  "tests/raptor3/expanded/lifetime-commands.test.ts": 16,
  "tests/raptor3/expanded/compound-falsifier.test.ts": 1,
});
export const G1_BASELINE_TESTS = Object.freeze(Object.keys(G1_BASELINE_COUNTS));
export const G1_CONTRACT_TESTS = Object.freeze(Object.keys(G1_CONTRACT_COUNTS));
export const G2_BASELINE_COUNTS = Object.freeze({
  "tests/raptor3/transitions/keys-legacy.test.ts": 14,
  "tests/raptor3/transitions/singular-legacy.test.ts": 20,
  "tests/raptor3/transitions/staleness-legacy.test.ts": 3,
  "tests/raptor3/transitions/junctions-legacy.test.ts": 26,
  "tests/raptor3/transitions/junction-identity-legacy.test.ts": 2,
  "tests/raptor3/transitions/membership-own-write-legacy.test.ts": 8,
  "tests/raptor3/transitions/series-staleness-legacy.test.ts": 4,
  "tests/raptor3/transitions/required-legacy.test.ts": 8,
  "tests/raptor3/transitions/own-write-legacy.test.ts": 18,
  "tests/raptor3/transitions/occupied-keys-legacy.test.ts": 8,
  "tests/raptor3/transitions/supplier-continuations-legacy.test.ts": 10,
  "tests/raptor3/transitions/singular-lattice-legacy.test.ts": 58,
  "tests/raptor3/transitions/conditional-upsert-legacy.test.ts": 11,
  "tests/raptor3/transitions/shared-key-suppliers-legacy.test.ts": 4,
  "tests/raptor3/transitions/mixed-key-transitions-legacy.test.ts": 8,
  "tests/raptor3/transitions/variant-removals-legacy.test.ts": 14,
});
export const G2_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/transitions/keys-commands.test.ts": 14,
  "tests/raptor3/transitions/singular-commands.test.ts": 20,
  "tests/raptor3/transitions/staleness-commands.test.ts": 3,
  "tests/raptor3/transitions/junctions-commands.test.ts": 26,
  "tests/raptor3/transitions/junction-identity-commands.test.ts": 2,
  "tests/raptor3/transitions/membership-own-write-commands.test.ts": 8,
  "tests/raptor3/transitions/series-staleness-commands.test.ts": 4,
  "tests/raptor3/transitions/required-commands.test.ts": 8,
  "tests/raptor3/transitions/own-write-commands.test.ts": 18,
  "tests/raptor3/transitions/occupied-keys-commands.test.ts": 8,
  "tests/raptor3/transitions/supplier-continuations-commands.test.ts": 10,
  "tests/raptor3/transitions/singular-lattice-commands.test.ts": 58,
  "tests/raptor3/transitions/conditional-upsert-commands.test.ts": 11,
  "tests/raptor3/transitions/shared-key-suppliers-commands.test.ts": 4,
  "tests/raptor3/transitions/mixed-key-transitions-commands.test.ts": 8,
  "tests/raptor3/transitions/variant-removals-commands.test.ts": 14,
});
export const G2_DIAGNOSTIC_COUNTS = Object.freeze({
  "tests/raptor3/transitions/diagnostics.test.ts": 2,
});
export const G2_DIAGNOSTIC_TESTS = Object.freeze(
  Object.keys(G2_DIAGNOSTIC_COUNTS),
);
export const G25_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/polish/commands.test.ts": 6,
});
export const G25_CONTRACT_TESTS = Object.freeze(
  Object.keys(G25_CONTRACT_COUNTS),
);
export const G25_PG_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/polish/recovery-live.test.ts": 2,
});
export const G25_PG_CONTRACT_TESTS = Object.freeze(
  Object.keys(G25_PG_CONTRACT_COUNTS),
);
export const G27_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/ownership/commands.test.ts": 6,
});
export const G27_CONTRACT_TESTS = Object.freeze(
  Object.keys(G27_CONTRACT_COUNTS),
);
export const G27_PROVIDER_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/ownership/live.test.ts": 1,
});
export const G27_PG_CONTRACT_COUNTS = G27_PROVIDER_CONTRACT_COUNTS;
export const G27_PG_CONTRACT_TESTS = Object.freeze(
  Object.keys(G27_PG_CONTRACT_COUNTS),
);
export const G27_MYSQL_CONTRACT_COUNTS = G27_PROVIDER_CONTRACT_COUNTS;
export const G27_MYSQL_CONTRACT_TESTS = Object.freeze(
  Object.keys(G27_MYSQL_CONTRACT_COUNTS),
);
export const G3P02_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/transport.test.ts": 4,
});
export const G3P02_CONTRACT_TESTS = Object.freeze(
  Object.keys(G3P02_CONTRACT_COUNTS),
);
export const G3P02_PROVIDER_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/prep/native-constraint-ownership.test.ts": 5,
});
export const G3P02_PG_CONTRACT_COUNTS = G3P02_PROVIDER_CONTRACT_COUNTS;
export const G3P02_PG_CONTRACT_TESTS = Object.freeze(
  Object.keys(G3P02_PG_CONTRACT_COUNTS),
);
export const G3P02_MYSQL_CONTRACT_COUNTS = G3P02_PROVIDER_CONTRACT_COUNTS;
export const G3P02_MYSQL_CONTRACT_TESTS = Object.freeze(
  Object.keys(G3P02_MYSQL_CONTRACT_COUNTS),
);
export const G3P03_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/prep/set-preparation.test.ts": 6,
});
export const G3P03_CONTRACT_TESTS = Object.freeze(
  Object.keys(G3P03_CONTRACT_COUNTS),
);
export const G3P03_PROVIDER_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/prep/native-set-preparation.test.ts": 3,
});
export const G3P03_PG_CONTRACT_COUNTS = G3P03_PROVIDER_CONTRACT_COUNTS;
export const G3P03_PG_CONTRACT_TESTS = Object.freeze(
  Object.keys(G3P03_PG_CONTRACT_COUNTS),
);
export const G3P03_MYSQL_CONTRACT_COUNTS = G3P03_PROVIDER_CONTRACT_COUNTS;
export const G3P03_MYSQL_CONTRACT_TESTS = Object.freeze(
  Object.keys(G3P03_MYSQL_CONTRACT_COUNTS),
);
export const G3P04_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/prep/suppression-replay.test.ts": 5,
});
export const G3P04_CONTRACT_TESTS = Object.freeze(
  Object.keys(G3P04_CONTRACT_COUNTS),
);
export const G3P04_REVIEW_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/prep/g3p04-review-regressions.test.ts": 5,
});
export const G3P04_REVIEW_CONTRACT_TESTS = Object.freeze(
  Object.keys(G3P04_REVIEW_CONTRACT_COUNTS),
);
export const G3P04_PROVIDER_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/prep/native-suppression-replay.test.ts": 4,
});
export const G3P04_PG_CONTRACT_COUNTS = G3P04_PROVIDER_CONTRACT_COUNTS;
export const G3P04_PG_CONTRACT_TESTS = Object.freeze(
  Object.keys(G3P04_PG_CONTRACT_COUNTS),
);
export const G3P04_MYSQL_CONTRACT_COUNTS = G3P04_PROVIDER_CONTRACT_COUNTS;
export const G3P04_MYSQL_CONTRACT_TESTS = Object.freeze(
  Object.keys(G3P04_MYSQL_CONTRACT_COUNTS),
);
export const G3P05_SELECTOR_DEPENDENCY_COUNTS = Object.freeze({
  "tests/raptor3/prep/selector-dependencies.test.ts": 11,
});
export const G3P05_SELECTOR_DEPENDENCY_TESTS = Object.freeze(
  Object.keys(G3P05_SELECTOR_DEPENDENCY_COUNTS),
);
export const G3P05_VARIANT_COLLECTION_ORDER_COUNTS = Object.freeze({
  "tests/raptor3/prep/variant-collection-order.test.ts": 4,
});
export const G3P05_VARIANT_COLLECTION_ORDER_TESTS = Object.freeze(
  Object.keys(G3P05_VARIANT_COLLECTION_ORDER_COUNTS),
);
export const G3P05_RECURSIVE_READ_FIT_COUNTS = Object.freeze({
  "tests/raptor3/prep/recursive-read-fit.test.ts": 6,
});
export const G3P05_RECURSIVE_READ_FIT_TESTS = Object.freeze(
  Object.keys(G3P05_RECURSIVE_READ_FIT_COUNTS),
);
export const POST_G3_CLEARABILITY_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/post-prep/clearability-consumption.test.ts": 4,
});
export const POST_G3_CLEARABILITY_CONTRACT_TESTS = Object.freeze(
  Object.keys(POST_G3_CLEARABILITY_CONTRACT_COUNTS),
);
export const POST_G3_SCHEMA_VIEW_COUNTS = Object.freeze({
  "tests/raptor3/post-prep/schema-view-reuse.test.ts": 1,
});
export const POST_G3_SCHEMA_VIEW_TESTS = Object.freeze(
  Object.keys(POST_G3_SCHEMA_VIEW_COUNTS),
);
export const POST_G3_PROJECTION_PREPARATION_COUNTS = Object.freeze({
  "tests/raptor3/post-prep/projection-preparation.test.ts": 4,
});
export const POST_G3_PROJECTION_PREPARATION_TESTS = Object.freeze(
  Object.keys(POST_G3_PROJECTION_PREPARATION_COUNTS),
);
export const POST_G3_SELECTOR_PREPARATION_COUNTS = Object.freeze({
  "tests/raptor3/post-prep/selector-preparation.test.ts": 4,
});
export const POST_G3_SELECTOR_PREPARATION_TESTS = Object.freeze(
  Object.keys(POST_G3_SELECTOR_PREPARATION_COUNTS),
);
export const POST_G3_HISTORY_ANALYSIS_COUNTS = Object.freeze({
  "tests/raptor3/post-prep/history-analysis.test.ts": 4,
});
export const POST_G3_HISTORY_ANALYSIS_TESTS = Object.freeze(
  Object.keys(POST_G3_HISTORY_ANALYSIS_COUNTS),
);
export const POST_G3_CLEARABILITY_PROVIDER_COUNTS = Object.freeze({
  "tests/raptor3/prep/native-clearability-ownership.test.ts": 2,
});
export const POST_G3_CLEARABILITY_PG_CONTRACT_COUNTS =
  POST_G3_CLEARABILITY_PROVIDER_COUNTS;
export const POST_G3_CLEARABILITY_PG_CONTRACT_TESTS = Object.freeze(
  Object.keys(POST_G3_CLEARABILITY_PG_CONTRACT_COUNTS),
);
export const POST_G3_CLEARABILITY_MYSQL_CONTRACT_COUNTS =
  POST_G3_CLEARABILITY_PROVIDER_COUNTS;
export const POST_G3_CLEARABILITY_MYSQL_CONTRACT_TESTS = Object.freeze(
  Object.keys(POST_G3_CLEARABILITY_MYSQL_CONTRACT_COUNTS),
);
export const G3P05_CONTRACT_COUNTS = Object.freeze({
  ...G3P05_SELECTOR_DEPENDENCY_COUNTS,
  ...G3P05_VARIANT_COLLECTION_ORDER_COUNTS,
  ...G3P05_RECURSIVE_READ_FIT_COUNTS,
});
export const G3P05_CONTRACT_TESTS = Object.freeze(
  Object.keys(G3P05_CONTRACT_COUNTS),
);
export const G2_BASELINE_TESTS = Object.freeze(Object.keys(G2_BASELINE_COUNTS));
export const G2_CONTRACT_TESTS = Object.freeze(Object.keys(G2_CONTRACT_COUNTS));
export const G2_PROVIDER_BASELINE_COUNTS = Object.freeze({
  "tests/raptor3/transitions/keys-live-legacy.test.ts": 7,
  "tests/raptor3/transitions/unique-races-live-legacy.test.ts": 3,
  "tests/raptor3/transitions/occupancy-live-legacy.test.ts": 1,
});
export const G2_PROVIDER_CONTRACT_COUNTS = Object.freeze({
  "tests/raptor3/transitions/keys-live-commands.test.ts": 7,
  "tests/raptor3/transitions/unique-races-live-commands.test.ts": 3,
  "tests/raptor3/transitions/occupancy-live-commands.test.ts": 1,
});
export const G2_PG_BASELINE_COUNTS = Object.freeze({
  ...G2_PROVIDER_BASELINE_COUNTS,
  "tests/raptor3/transitions/staleness-live-pg-legacy.test.ts": 2,
  "tests/raptor3/transitions/junction-races-live-legacy.test.ts": 3,
  "tests/raptor3/transitions/recovery-boundaries-live-legacy.test.ts": 1,
});
export const G2_PG_CONTRACT_COUNTS = Object.freeze({
  ...G2_PROVIDER_CONTRACT_COUNTS,
  "tests/raptor3/transitions/staleness-live-pg-commands.test.ts": 2,
  "tests/raptor3/transitions/junction-races-live-commands.test.ts": 3,
  "tests/raptor3/transitions/recovery-boundaries-live-commands.test.ts": 2,
});
export const G2_MYSQL_BASELINE_COUNTS = Object.freeze({
  ...G2_PROVIDER_BASELINE_COUNTS,
  "tests/raptor3/transitions/junction-races-live-legacy.test.ts": 2,
});
export const G2_MYSQL_CONTRACT_COUNTS = Object.freeze({
  ...G2_PROVIDER_CONTRACT_COUNTS,
  "tests/raptor3/transitions/junction-races-live-commands.test.ts": 2,
});
export const G2_MYSQL_BASELINE_TESTS = Object.freeze(
  Object.keys(G2_MYSQL_BASELINE_COUNTS),
);
export const G2_MYSQL_CONTRACT_TESTS = Object.freeze(
  Object.keys(G2_MYSQL_CONTRACT_COUNTS),
);
export const G2_PG_BASELINE_TESTS = Object.freeze(
  Object.keys(G2_PG_BASELINE_COUNTS),
);
export const G2_PG_CONTRACT_TESTS = Object.freeze(
  Object.keys(G2_PG_CONTRACT_COUNTS),
);
export const G2_PROVIDER_BASELINE_TESTS = Object.freeze(
  Object.keys(G2_PROVIDER_BASELINE_COUNTS),
);
export const G2_PROVIDER_CONTRACT_TESTS = Object.freeze(
  Object.keys(G2_PROVIDER_CONTRACT_COUNTS),
);
export const G1_GENERATED_COUNTS = Object.freeze({
  "tests/raptor3/generated-smoke.test.ts": 32,
  "tests/raptor3/generated-gate.test.ts": 3,
});
export const G1_GENERATED_TESTS = Object.freeze(
  Object.keys(G1_GENERATED_COUNTS),
);
export const G1_CAMPAIGN_TESTS = Object.freeze([
  "tests/raptor3/generated-campaign.test.ts",
]);
export const G1_CAMPAIGN = Object.freeze({
  firstSeed: 1000,
  seedCount: 1000,
  batchSize: 100,
  replayCount: 3,
  profiles: ["sqlite-interactive", "sqlite-atomic-batch"],
});
export const G2_CAMPAIGN = Object.freeze({
  firstSeed: 2000,
  seedCount: 5000,
  batchSize: 100,
  replayCount: 3,
  completionLimit: 5000,
  profiles: ["sqlite-interactive", "sqlite-atomic-batch"],
});
export const G2_CAMPAIGN_TESTS = Object.freeze([
  "tests/raptor3/g2-campaign.test.ts",
]);
export const G2_GENERATED_COUNTS = Object.freeze({
  "tests/raptor3/g2-generated.test.ts": 46,
  "tests/raptor3/g2-harness.test.ts": 6,
});
export const G2_GENERATED_TESTS = Object.freeze(
  Object.keys(G2_GENERATED_COUNTS),
);
export const G1_TRANSPORT_COUNTS = Object.freeze({
  "tests/raptor3/transport.test.ts": 44,
});
export const G1_TRANSPORT_TESTS = Object.freeze(
  Object.keys(G1_TRANSPORT_COUNTS),
);
export const G1_TRANSPORT_CAMPAIGN_TESTS = Object.freeze([
  "tests/raptor3/transport-campaign.test.ts",
]);
export const G1_TRANSPORT_CAMPAIGN = Object.freeze({
  ...G1_CAMPAIGN,
  profiles: ["scripted-returning-weak", "scripted-returning-ack"],
});
export const G2_TRANSPORT_COUNTS = Object.freeze({
  "tests/raptor3/g2-transport.test.ts": 16,
});
export const G2_TRANSPORT_TESTS = Object.freeze(
  Object.keys(G2_TRANSPORT_COUNTS),
);
export const G2_TRANSPORT_CAMPAIGN_TESTS = G1_TRANSPORT_CAMPAIGN_TESTS;
export const G2_TRANSPORT_CAMPAIGN = Object.freeze({
  ...G2_CAMPAIGN,
  profiles: G1_TRANSPORT_CAMPAIGN.profiles,
});
export const G3P06_CAMPAIGN_TESTS = G2_CAMPAIGN_TESTS;
export const G3P06_CAMPAIGN = Object.freeze({
  ...G2_CAMPAIGN,
  firstSeed: 7000,
  seedCount: 100,
});
export const G3P06_TRANSPORT_CAMPAIGN_TESTS = G2_TRANSPORT_CAMPAIGN_TESTS;
export const G3P06_TRANSPORT_CAMPAIGN = Object.freeze({
  ...G3P06_CAMPAIGN,
  profiles: G2_TRANSPORT_CAMPAIGN.profiles,
});
export const G1_PROVIDER_TESTS = Object.freeze([
  "tests/raptor3/expanded/produced-commands.test.ts",
  "tests/raptor3/expanded/batch-produced-commands.test.ts",
]);
export const G1_PROVIDER_BASELINE_TESTS = Object.freeze([
  "tests/raptor3/expanded/produced-legacy.test.ts",
  "tests/raptor3/expanded/batch-produced-legacy.test.ts",
]);
export const G0_CAMPAIGN = Object.freeze({
  firstSeed: 0,
  seedCount: 100,
  replayCount: 3,
  completionLimit: 2000,
  profiles: ["sqlite-interactive", "sqlite-atomic-batch"],
});
export const G0_RESOURCES = Object.freeze({
  heapMb: 768,
  rssMb: 1536,
  wallMs: 120_000,
});
export const G0_FALSIFIERS = Object.freeze([
  "wrong-row",
  "missing-write",
  "changed-value",
  "changed-error",
  "rollback-leak",
  "equivalent-changed-sql",
  "success-failure-replay",
  "corrupt-event-tape",
  "controlled-default-clock",
  "uncontrolled-source",
  "missing-event",
  "invalid-replay",
  "harness-exception",
  "swallowed-failure",
  "event-limit",
  "split-atomic-cut",
  "missing-eligible-cut",
  "controlled-cut-failure",
  "atomic-surrounding-faults",
  "zero-case-selection",
  "stale-evidence",
]);

function sourceFiles(root, directory) {
  const files = [];
  for (const entry of readdirSync(resolve(root, directory), {
    withFileTypes: true,
  })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...sourceFiles(root, path));
    else if (/\.(?:ts|mts|mjs|js|json)$/.test(entry.name)) files.push(path);
  }
  return files;
}

function fingerprint(root, files) {
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].sort()) {
    hash
      .update(file)
      .update("\0")
      .update(readFileSync(resolve(root, file)))
      .update("\0");
  }
  return hash.digest("hex");
}

/** Conservative executed-source identity, independent of Git's dirty-doc state. */
export function captureRaptor3Identity(root = RAPTOR3_ROOT) {
  const require = createRequire(resolve(root, "package.json"));
  const configuration = [
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "vitest.config.ts",
    "vitest.workspace.ts",
    "vitest.d1.config.ts",
  ];
  return {
    production: fingerprint(root, [
      ...sourceFiles(root, "src"),
      ...configuration,
    ]),
    harness: fingerprint(root, [
      ...sourceFiles(root, "tests/raptor3"),
      ...sourceFiles(root, "scripts"),
      ...sourceFiles(root, "benchmarks"),
      "tests/contracts/public-client/cli/_clack.ts",
      ...configuration,
    ]),
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      sqliteDriver: require("better-sqlite3/package.json").version,
      vitest: require("vitest/package.json").version,
    },
  };
}

export function assertRaptor3Identity(
  expected,
  actual = captureRaptor3Identity(),
) {
  assert.deepEqual(
    actual,
    expected,
    "Stale Raptor 3 evidence: executed source or runtime changed",
  );
}

export function assertG0CampaignReceipt(receipt) {
  assert.deepEqual(
    receipt.campaign,
    G0_CAMPAIGN,
    "Incomplete or changed G0 campaign",
  );
  assert.equal(receipt.fixedCells, 24, "Missing required G0 profile/case");
  assert.equal(receipt.seededCells, 200, "Missing G0 schedule seeds");
  assert.equal(
    receipt.replays,
    (receipt.fixedCells + receipt.seededCells) * G0_CAMPAIGN.replayCount,
  );
  assert.equal(receipt.skipped, 0, "Required G0 cells cannot be skipped");
  assert.deepEqual(
    [...receipt.falsifiers].sort(),
    [...G0_FALSIFIERS].sort(),
    "Missing or duplicate G0 harness falsifier",
  );
}

export function assertGeneratedBatchReceipt(
  receipt,
  firstSeed,
  campaign = G1_CAMPAIGN,
) {
  assert.equal(receipt.firstSeed, firstSeed);
  assert.equal(receipt.seedCount, campaign.batchSize);
  assert.deepEqual(receipt.profiles, campaign.profiles);
  assert.equal(receipt.skipped, 0);
  assert.equal(
    receipt.replays,
    campaign.batchSize * campaign.profiles.length * campaign.replayCount,
  );
  const expected = campaign.profiles
    .flatMap((profile) =>
      Array.from(
        { length: campaign.batchSize },
        (_, offset) => `${profile}:${firstSeed + offset}`,
      ),
    )
    .sort();
  assert.deepEqual(
    receipt.completed.map((cell) => `${cell.profile}:${cell.seed}`).sort(),
    expected,
    "Incomplete or duplicated generated batch",
  );
  for (const profile of campaign.profiles) {
    const cells = receipt.completed.filter((cell) => cell.profile === profile);
    assert(
      cells.filter((cell) => cell.actors === 2).length >= 20,
      "Missing two-actor quota",
    );
    assert(
      cells.filter((cell) => cell.faults > 0).length >= 20,
      "Missing actually injected fault quota",
    );
  }
}
