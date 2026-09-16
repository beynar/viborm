/** Synthetic unit receipts only: this file does not claim campaign execution. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import {
  EXTENDED_LOCAL_TESTS,
  RAPTOR3_FIXED_LOCAL_TESTS,
} from "./credential-free-test-manifest.mjs";
import {
  assertEquivalentExtensionCampaignReceipts,
  assertExtensionCampaignReceipt,
  assertGeneratedBatchReceipt,
  assertG3GeneratedBatchReceipt,
  assertStructuralMeasurementRuntime,
  G2_CAMPAIGN,
  G2_TRANSPORT_CAMPAIGN,
  G3P06_CAMPAIGN,
  G3P06_TRANSPORT_CAMPAIGN,
  G3_GENERATED_CAMPAIGN,
  G3_GENERATED_TRANSPORT_CAMPAIGN,
  G27_CONTRACT_TESTS,
  G27_PG_CONTRACT_TESTS,
  G3P03_CONTRACT_TESTS,
  G3P03_PG_CONTRACT_TESTS,
  G3P04_CONTRACT_TESTS,
  G3P04_PG_CONTRACT_TESTS,
  G3P04_REVIEW_CONTRACT_TESTS,
  G3P05_CONTRACT_TESTS,
  G3_BULK_SERIES_TESTS,
  G3_SUPPRESSION_RETRY_TESTS,
  G3_TRANSACTION_ARRAY_TESTS,
  G3_DEPTH_RECURRENCE_TESTS,
  G3_SCOPE_COMPOSITION_PG_TESTS,
  G3_GENERATED_SMOKE_TESTS,
  G3_GENERATED_TRANSPORT_SMOKE_TESTS,
  G3_GENERATED_CAMPAIGN_TESTS,
  G3_GENERATED_TRANSPORT_CAMPAIGN_TESTS,
  G3_EXECUTION_REVIEW_TESTS,
  G3_AUTHOR_EXECUTION_REGRESSION_TESTS,
  G3_SCOPE_FAILURE_TESTS,
  G3_BULK_RESULT_BOUNDARY_TESTS,
  POST_G3_CLEARABILITY_CONTRACT_TESTS,
  POST_G3_CLEARABILITY_MYSQL_CONTRACT_TESTS,
  POST_G3_CLEARABILITY_PG_CONTRACT_TESTS,
  POST_G3_SCHEMA_VIEW_TESTS,
  POST_G3_PROJECTION_PREPARATION_TESTS,
  POST_G3_SELECTOR_PREPARATION_TESTS,
  POST_G3_HISTORY_ANALYSIS_TESTS,
  G29_MEMBER_DEPENDENCY_TESTS,
  G29_DEPENDENCY_BOUNDARY_TESTS,
  G29_DEPENDENCY_CHOICE_TESTS,
  G29_RESULT_PROGRESS_TESTS,
  CS01_STRUCTURAL_REFERENCE_TESTS,
  CS01_EXTENSION_A_TESTS,
  CS01_EXTENSION_B_TESTS,
  CS01_EXTENSION_COMPOSITION_TESTS,
  CS03_MEMBER_SCOPE_TESTS,
  CS03_EXTENSION_CAMPAIGNS,
  CS03_EXTENSION_CAMPAIGN_TESTS,
  CS03_EXTENSION_SUPPORT_TESTS,
  CS02_REPEATED_OCCURRENCE_TESTS,
  G29_MEMBER_DEPENDENCY_MYSQL_TESTS,
  G29_MEMBER_DEPENDENCY_PG_TESTS,
  G4_READ_TESTS,
  G4_READ_COUNTS,
  G4_LIFECYCLE_EVENTS_TESTS,
  G4_LIFECYCLE_ADMISSION_TESTS,
  G4_ROUTE_LIFECYCLE_TESTS,
  G4_ROUTE_ADMISSION_TESTS,
  G4_ROUTE_CACHE_TESTS,
  G4_ROUTE_TRANSACTION_TESTS,
  G4_GENERATION_SELFTEST_TESTS,
  G4_GENERATED_CAMPAIGN,
  G4_GENERATED_CAMPAIGN_TESTS,
  G4_GENERATED_TRANSPORT_CAMPAIGN,
  G4_GENERATED_TRANSPORT_CAMPAIGN_TESTS,
  G4_WRITE_CAMPAIGN,
  G4_WRITE_CAMPAIGN_TESTS,
  G4_WRITE_TRANSPORT_CAMPAIGN,
  G4_WRITE_TRANSPORT_CAMPAIGN_TESTS,
  G4_UNIT01_AUTHOR_COUNTS,
  G4_UNIT01_AUTHOR_TESTS,
  G4_UNIT01_REVIEW_COUNTS,
  G4_UNIT01_REVIEW_TESTS,
  G4_NATIVE_PG_TESTS,
  G4_NATIVE_MYSQL_TESTS,
  G4_READ_CONTRACT_FAMILIES,
  G4_TRANSPORT_MODELS,
  assertG4GeneratedBatchReceipt,
  assertG4OracleValidationReceipt,
} from "./raptor3-manifest.mjs";
import * as manifest from "./raptor3-manifest.mjs";
import {
  archiveG3GeneratedCorpus,
  parseRaptor3Request,
} from "./run-raptor3.mjs";

const lanes = [
  {
    name: "SQLite",
    mode: "g2-seeds",
    batchMode: "g2-seed-batch",
    campaign: G2_CAMPAIGN,
    profiles: ["sqlite-interactive", "sqlite-atomic-batch"],
  },
  {
    name: "scripted transport",
    mode: "g2-transport-seeds",
    batchMode: "g2-transport-seed-batch",
    campaign: G2_TRANSPORT_CAMPAIGN,
    profiles: ["scripted-returning-weak", "scripted-returning-ack"],
  },
];

const prepLanes = [
  {
    name: "SQLite",
    mode: "g3p06-seeds",
    batchMode: "g3p06-seed-batch",
    campaign: G3P06_CAMPAIGN,
    profiles: ["sqlite-interactive", "sqlite-atomic-batch"],
  },
  {
    name: "scripted transport",
    mode: "g3p06-transport-seeds",
    batchMode: "g3p06-transport-seed-batch",
    campaign: G3P06_TRANSPORT_CAMPAIGN,
    profiles: ["scripted-returning-weak", "scripted-returning-ack"],
  },
];

const g3GeneratedLanes = [
  { name: "SQLite", campaign: G3_GENERATED_CAMPAIGN },
  {
    name: "scripted transport",
    campaign: G3_GENERATED_TRANSPORT_CAMPAIGN,
  },
];

test("a verified G3 child corpus archives and restores byte-for-byte", async () => {
  const directory = mkdtempSync(join(tmpdir(), "viborm-g3-archive-selftest-"));
  try {
    const source = Buffer.from('{"records":["repeated","repeated"]}\n');
    writeFileSync(join(directory, "generated-corpus.json"), source);
    const archive = await archiveG3GeneratedCorpus(directory);
    assert.equal(existsSync(join(directory, "generated-corpus.json")), false);
    const restoredPath = execFileSync(
      "/bin/sh",
      [
        "-c",
        `${archive.restoreCommand}; printf '%s' "$g3_corpus_restore_dir/generated-corpus.json"`,
      ],
      { cwd: directory, encoding: "utf8" }
    );
    try {
      assert.deepEqual(readFileSync(restoredPath), source);
    } finally {
      rmSync(dirname(restoredPath), { recursive: true, force: true });
    }
    assert.deepEqual(
      gunzipSync(readFileSync(join(directory, archive.file))),
      source
    );
    assert.deepEqual(
      JSON.parse(
        readFileSync(join(directory, "generated-corpus.archive.json"), "utf8")
      ),
      archive
    );
    assert.equal(archive.originalBytes, source.length);
    assert.match(archive.originalSha256, /^[0-9a-f]{64}$/);
    assert.match(archive.restoreCommand, /gzip -dc .*generated-corpus\.json\.gz/);
    assert.match(archive.replayCommand, /^cd /);
    assert.match(
      archive.replayCommand,
      /node scripts\/run-raptor3\.mjs replay/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a child corpus archive carries the replay command of its own lane", async () => {
  // The optional second parameter exists because the G0/G3 default routes a
  // G4 read corpus into tests/raptor3/gate.test.ts, where it fails. Without
  // this cell nothing noticed a G4 receipt that kept the G3 default.
  const directory = mkdtempSync(join(tmpdir(), "viborm-g4-archive-selftest-"));
  try {
    writeFileSync(
      join(directory, "generated-corpus.json"),
      Buffer.from('{"records":[]}\n')
    );
    const g4Command =
      'cd "/repo"; node scripts/run-raptor3.mjs g4-seed-batch 20000 --subject=candidate';
    const archive = await archiveG3GeneratedCorpus(directory, g4Command);
    assert.equal(archive.replayCommand, g4Command);
    assert.deepEqual(
      JSON.parse(
        readFileSync(join(directory, "generated-corpus.archive.json"), "utf8")
      ).replayCommand,
      g4Command
    );
    assert.doesNotMatch(
      archive.replayCommand,
      /run-raptor3\.mjs replay/,
      "a G4 lane receipt kept the G0/G3 replay default"
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  // ...and the one-argument call still spells the G0/G3 default exactly.
  const g3Directory = mkdtempSync(
    join(tmpdir(), "viborm-g3-archive-default-")
  );
  try {
    writeFileSync(
      join(g3Directory, "generated-corpus.json"),
      Buffer.from('{"records":[]}\n')
    );
    const archive = await archiveG3GeneratedCorpus(g3Directory);
    assert.match(
      archive.replayCommand,
      /node scripts\/run-raptor3\.mjs replay "\$g3_corpus_restore_dir\/generated-corpus\.json"$/
    );
  } finally {
    rmSync(g3Directory, { recursive: true, force: true });
  }
});

test("a failed G3 child archive leaves the raw corpus unchanged", async () => {
  const directory = mkdtempSync(join(tmpdir(), "viborm-g3-archive-selftest-"));
  try {
    const source = Buffer.from('{"records":["keep-raw"]}\n');
    const sourcePath = join(directory, "generated-corpus.json");
    const temporaryPath = join(directory, "generated-corpus.json.gz.tmp");
    writeFileSync(sourcePath, source);
    writeFileSync(temporaryPath, "occupied");
    await assert.rejects(
      () => archiveG3GeneratedCorpus(directory),
      (failure) =>
        failure instanceof Error &&
        "code" in failure &&
        failure.code === "EEXIST"
    );
    assert.deepEqual(readFileSync(sourcePath), source);
    assert.equal(readFileSync(temporaryPath, "utf8"), "occupied");
    assert.equal(
      existsSync(join(directory, "generated-corpus.archive.json")),
      false
    );
    const receiptFailureDirectory = mkdtempSync(
      join(tmpdir(), "viborm-g3-archive-selftest-")
    );
    try {
      const receiptFailureSource = Buffer.from(
        '{"records":["keep-after-gzip"]}\n'
      );
      const receiptFailureSourcePath = join(
        receiptFailureDirectory,
        "generated-corpus.json"
      );
      const receiptTemporaryPath = join(
        receiptFailureDirectory,
        "generated-corpus.archive.json.tmp"
      );
      writeFileSync(receiptFailureSourcePath, receiptFailureSource);
      writeFileSync(receiptTemporaryPath, "occupied-receipt");
      await assert.rejects(
        () => archiveG3GeneratedCorpus(receiptFailureDirectory),
        (failure) =>
          failure instanceof Error &&
          "code" in failure &&
          failure.code === "EEXIST"
      );
      assert.deepEqual(
        readFileSync(receiptFailureSourcePath),
        receiptFailureSource
      );
      assert.equal(
        readFileSync(receiptTemporaryPath, "utf8"),
        "occupied-receipt"
      );
      assert.equal(
        existsSync(
          join(receiptFailureDirectory, "generated-corpus.archive.json")
        ),
        false
      );
      assert.deepEqual(
        gunzipSync(
          readFileSync(
            join(receiptFailureDirectory, "generated-corpus.json.gz")
          )
        ),
        receiptFailureSource
      );
    } finally {
      rmSync(receiptFailureDirectory, { recursive: true, force: true });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("structural measurement qualification pins the exact Node runtime", () => {
  const qualified = { runtime: { node: "v24.21.0" } };
  assert.doesNotThrow(() =>
    assertStructuralMeasurementRuntime(qualified, qualified)
  );
  const wrong = { runtime: { node: "v24.14.0" } };
  assert.throws(
    () => assertStructuralMeasurementRuntime(wrong, wrong),
    /base runtime is not the qualified Node version/
  );
});

test("credential-free registration isolates native Raptor suites and retains local fixed suites", () => {
  const localFixed = [
    ...G27_CONTRACT_TESTS,
    ...G3P03_CONTRACT_TESTS,
    ...G3P04_CONTRACT_TESTS,
    ...G3P04_REVIEW_CONTRACT_TESTS,
    ...G3P05_CONTRACT_TESTS,
    ...G3_BULK_SERIES_TESTS,
    ...G3_SUPPRESSION_RETRY_TESTS,
    ...G3_TRANSACTION_ARRAY_TESTS,
    ...G3_DEPTH_RECURRENCE_TESTS,
    ...G3_GENERATED_SMOKE_TESTS,
    ...G3_GENERATED_TRANSPORT_SMOKE_TESTS,
    ...G3_EXECUTION_REVIEW_TESTS,
    ...G3_AUTHOR_EXECUTION_REGRESSION_TESTS,
    ...G3_SCOPE_FAILURE_TESTS,
    ...G3_BULK_RESULT_BOUNDARY_TESTS,
    ...POST_G3_CLEARABILITY_CONTRACT_TESTS,
    ...POST_G3_SCHEMA_VIEW_TESTS,
    ...POST_G3_PROJECTION_PREPARATION_TESTS,
    ...POST_G3_SELECTOR_PREPARATION_TESTS,
    ...POST_G3_HISTORY_ANALYSIS_TESTS,
    ...G29_MEMBER_DEPENDENCY_TESTS,
    ...G29_DEPENDENCY_BOUNDARY_TESTS,
    ...G29_DEPENDENCY_CHOICE_TESTS,
    ...G29_RESULT_PROGRESS_TESTS,
    ...CS01_STRUCTURAL_REFERENCE_TESTS,
    ...CS01_EXTENSION_A_TESTS,
    ...CS01_EXTENSION_B_TESTS,
    ...CS01_EXTENSION_COMPOSITION_TESTS,
    ...CS03_MEMBER_SCOPE_TESTS,
    ...CS03_EXTENSION_SUPPORT_TESTS,
    ...CS02_REPEATED_OCCURRENCE_TESTS,
  ];
  const native = [
    ...G27_PG_CONTRACT_TESTS,
    ...G3P03_PG_CONTRACT_TESTS,
    ...G3P04_PG_CONTRACT_TESTS,
    ...G3_SCOPE_COMPOSITION_PG_TESTS,
    ...POST_G3_CLEARABILITY_MYSQL_CONTRACT_TESTS,
    ...POST_G3_CLEARABILITY_PG_CONTRACT_TESTS,
    ...G29_MEMBER_DEPENDENCY_MYSQL_TESTS,
    ...G29_MEMBER_DEPENDENCY_PG_TESTS,
  ];
  const explicitCampaigns = [
    ...CS03_EXTENSION_CAMPAIGN_TESTS,
    ...G3_GENERATED_CAMPAIGN_TESTS,
    ...G3_GENERATED_TRANSPORT_CAMPAIGN_TESTS,
  ];

  for (const file of localFixed) {
    assert.equal(EXTENDED_LOCAL_TESTS.includes(file), false, file);
    assert.equal(RAPTOR3_FIXED_LOCAL_TESTS.includes(file), true, file);
  }
  for (const file of native) {
    assert.equal(EXTENDED_LOCAL_TESTS.includes(file), false, file);
    assert.equal(RAPTOR3_FIXED_LOCAL_TESTS.includes(file), false, file);
  }
  for (const file of explicitCampaigns) {
    assert.equal(EXTENDED_LOCAL_TESTS.includes(file), false, file);
    assert.equal(RAPTOR3_FIXED_LOCAL_TESTS.includes(file), false, file);
  }
});

function unitReceipt(firstSeed, profiles) {
  const completed = [];
  for (const profile of profiles) {
    for (let seed = firstSeed; seed < firstSeed + 100; seed++) {
      completed.push({
        seed,
        profile,
        actors: seed < firstSeed + 20 ? 2 : 1,
        faults: seed < firstSeed + 20 ? 1 : 0,
      });
    }
  }
  return {
    firstSeed,
    seedCount: 100,
    profiles: [...profiles],
    completed,
    replays: 600,
    skipped: 0,
  };
}

function unitExtensionReceipt(campaign, identity) {
  const completed = campaign.profiles.flatMap((profile) =>
    Array.from({ length: campaign.seedCount }, (_, offset) => {
      const seed = campaign.firstSeed + offset;
      const recipe = {
        formatVersion: 1,
        slice: campaign.slice,
        seed,
        outcome: "success",
        schedule: ["before:admit<effect"],
      };
      return {
        seed,
        profile,
        recipe,
        schedule: [...recipe.schedule],
        observation: { outcome: { kind: "success", value: seed } },
      };
    })
  );
  return {
    identity,
    slice: campaign.slice,
    firstSeed: campaign.firstSeed,
    seedCount: campaign.seedCount,
    profiles: [...campaign.profiles],
    completed,
    replays:
      campaign.seedCount * campaign.profiles.length * campaign.replayCount,
    skipped: 0,
  };
}

test("CS-03 extension modes bind exact ranges, identities, cells, and replays", () => {
  const identity = { production: "reference", harness: "shared" };
  for (const [mode, campaign] of Object.entries(CS03_EXTENSION_CAMPAIGNS)) {
    assert.equal(parseRaptor3Request([mode]).mode, mode);
    for (const extra of ["7100", "--profile=sqlite-interactive"])
      assert.throws(
        () => parseRaptor3Request([mode, extra]),
        /cannot be filtered/
      );
    const valid = unitExtensionReceipt(campaign, identity);
    assertExtensionCampaignReceipt(valid, campaign, identity);
    for (const mutate of [
      (receipt) => receipt.completed.pop(),
      (receipt) => {
        receipt.completed[0].seed += 1;
      },
      (receipt) => {
        receipt.completed[0].schedule = ["before:different<effect"];
      },
      (receipt) => {
        receipt.completed[0].observation.outcome.kind = "failure";
      },
      (receipt) => {
        receipt.replays -= 1;
      },
      (receipt) => {
        receipt.skipped = 1;
      },
      (receipt) => {
        receipt.identity = { production: "stale", harness: "shared" };
      },
    ]) {
      const invalid = structuredClone(valid);
      mutate(invalid);
      assert.throws(
        () => assertExtensionCampaignReceipt(invalid, campaign, identity),
        { name: "AssertionError" }
      );
    }
  }
});

test("CS-03 extension alternatives compare canonical recipes, schedules, and outcomes", () => {
  const campaign = CS03_EXTENSION_CAMPAIGNS["cs03-extension-b-seeds"];
  const reference = unitExtensionReceipt(campaign, {
    production: "reference",
    harness: "shared",
  });
  const candidate = structuredClone(reference);
  candidate.identity.production = "candidate";
  assertEquivalentExtensionCampaignReceipts(reference, candidate);
  for (const mutate of [
    (receipt) => {
      receipt.completed[0].recipe.seed += 1;
    },
    (receipt) => {
      receipt.completed[0].schedule = ["before:different<effect"];
    },
    (receipt) => {
      receipt.completed[0].observation.outcome.value = "different";
    },
  ]) {
    const divergent = structuredClone(candidate);
    mutate(divergent);
    assert.throws(
      () => assertEquivalentExtensionCampaignReceipts(reference, divergent),
      /CS-03 alternatives diverged/
    );
  }
});

test("G2.5 admits its fixed unfiltered checkpoint without changing G2 campaigns", () => {
  assert.equal(parseRaptor3Request(["g25-contracts"]).mode, "g25-contracts");
  assert.equal(
    parseRaptor3Request(["g25-pg-contracts"]).mode,
    "g25-pg-contracts"
  );
  for (const filter of [
    "--testNamePattern=absent",
    "--profile=sqlite-interactive",
  ])
    assert.throws(
      () => parseRaptor3Request(["g25-contracts", filter]),
      /cannot be filtered/
    );
});

test("G3 bulk series admits its exact fixed contract without filters", () => {
  assert.equal(parseRaptor3Request(["g3-bulk-series"]).mode, "g3-bulk-series");
  for (const filter of [
    "--testNamePattern=absent",
    "--profile=sqlite-interactive",
  ])
    assert.throws(
      () => parseRaptor3Request(["g3-bulk-series", filter]),
      /cannot be filtered/
    );
});

test("G3 suppression retry admits its exact fixed contract without filters", () => {
  assert.equal(
    parseRaptor3Request(["g3-suppression-retry"]).mode,
    "g3-suppression-retry"
  );
  for (const filter of [
    "--testNamePattern=absent",
    "--profile=sqlite-interactive",
  ])
    assert.throws(
      () => parseRaptor3Request(["g3-suppression-retry", filter]),
      /cannot be filtered/
    );
});

test("G3 transaction array admits its exact fixed contract without filters", () => {
  assert.equal(
    parseRaptor3Request(["g3-transaction-array"]).mode,
    "g3-transaction-array"
  );
  for (const filter of [
    "--testNamePattern=absent",
    "--profile=sqlite-interactive",
  ])
    assert.throws(
      () => parseRaptor3Request(["g3-transaction-array", filter]),
      /cannot be filtered/
    );
});

test("G3 generated smoke admits its exact contract without filters", () => {
  assert.equal(
    parseRaptor3Request(["g3-generated-smoke"]).mode,
    "g3-generated-smoke"
  );
  for (const filter of [
    "--testNamePattern=absent",
    "--profile=sqlite-interactive",
  ])
    assert.throws(
      () => parseRaptor3Request(["g3-generated-smoke", filter]),
      /cannot be filtered/
    );
});

test("G3 transport smoke admits its exact contract without filters", () => {
  assert.equal(
    parseRaptor3Request(["g3-generated-transport-smoke"]).mode,
    "g3-generated-transport-smoke"
  );
  assert.throws(
    () =>
      parseRaptor3Request([
        "g3-generated-transport-smoke",
        "--profile=scripted-returning-ack",
      ]),
    /cannot be filtered/
  );
});

test("G3 failure minimization admits its exact contract without filters", () => {
  assert.equal(
    parseRaptor3Request(["g3-generated-minimization"]).mode,
    "g3-generated-minimization"
  );
  assert.throws(
    () =>
      parseRaptor3Request([
        "g3-generated-minimization",
        "--testNamePattern=absent",
      ]),
    /cannot be filtered/
  );
});

test("G3 depth recurrence admits its exact fixed contract without filters", () => {
  assert.equal(
    parseRaptor3Request(["g3-depth-recurrence"]).mode,
    "g3-depth-recurrence"
  );
  assert.throws(
    () => parseRaptor3Request(["g3-depth-recurrence", "--profile=sqlite"]),
    /cannot be filtered/
  );
});

test("G3 execution review admits its exact diagnostic contract", () => {
  assert.equal(
    parseRaptor3Request(["g3-execution-review"]).mode,
    "g3-execution-review"
  );
  assert.throws(
    () =>
      parseRaptor3Request(["g3-execution-review", "--testNamePattern=absent"]),
    /cannot be filtered/
  );
});

test("G3 author execution regressions admit their exact fixed contract", () => {
  assert.equal(
    parseRaptor3Request(["g3-author-execution-regressions"]).mode,
    "g3-author-execution-regressions"
  );
  assert.throws(
    () =>
      parseRaptor3Request([
        "g3-author-execution-regressions",
        "--testNamePattern=absent",
      ]),
    /cannot be filtered/
  );
});

for (const mode of ["g3-scope-failure", "g3-bulk-result-boundary"]) {
  test(`${mode} admits its exact local fixed contract`, () => {
    assert.equal(parseRaptor3Request([mode]).mode, mode);
    assert.throws(
      () => parseRaptor3Request([mode, "--testNamePattern=absent"]),
      /cannot be filtered/
    );
  });
}

for (const provider of ["pg", "mysql"]) {
  test(`G3 ${provider} scope composition admits its exact native contract`, () => {
    const mode = `g3-scope-composition-${provider}`;
    assert.equal(parseRaptor3Request([mode]).mode, mode);
    assert.throws(
      () => parseRaptor3Request([mode, "--testNamePattern=absent"]),
      /cannot be filtered/
    );
  });
}

for (const lane of g3GeneratedLanes) {
  test(`${lane.name}: G3 generated receipts fail closed when stale, missing, or corrupt`, () => {
    const identity = {
      production: "production-source",
      harness: "harness-source",
      runtime: { node: "v24.21.0" },
    };
    const completion = (seed, profile) => ({
      seed,
      profile,
      contract: ["C08", "C09", "C10", "C11"][(seed - 8000) % 4],
      actors: seed % 5 === 0 ? 2 : 1,
      actorOverlap: seed % 5 === 0,
      faults: seed % 5 === 1 ? 1 : 0,
      operations: 3,
      completions: 1,
    });
    const completed = lane.campaign.profiles.flatMap((profile) =>
      Array.from({ length: lane.campaign.batchSize }, (_, offset) =>
        completion(8000 + offset, profile)
      )
    );
    const receipt = {
      formatVersion: 1,
      qualifying: true,
      status: "complete",
      identity,
      firstSeed: 8000,
      seedCount: lane.campaign.batchSize,
      profiles: lane.campaign.profiles,
      completed,
      replays:
        lane.campaign.batchSize *
        lane.campaign.profiles.length *
        lane.campaign.replayCount,
      skipped: 0,
    };
    assert.doesNotThrow(() =>
      assertG3GeneratedBatchReceipt(receipt, 8000, lane.campaign, identity)
    );
    const short = {
      ...receipt,
      seedCount: 7,
      completed: lane.campaign.profiles.flatMap((profile) =>
        Array.from({ length: 7 }, (_, offset) =>
          completion(8000 + offset, profile)
        )
      ),
      replays: 7 * lane.campaign.profiles.length * lane.campaign.replayCount,
    };
    assert.doesNotThrow(() =>
      assertG3GeneratedBatchReceipt(short, 8000, lane.campaign, identity)
    );

    const stale = structuredClone(receipt);
    stale.identity.harness = "stale-harness-source";
    assert.throws(
      () => assertG3GeneratedBatchReceipt(stale, 8000, lane.campaign, identity),
      /Stale Raptor 3 evidence/
    );

    const missing = structuredClone(receipt);
    missing.completed.pop();
    assert.throws(
      () =>
        assertG3GeneratedBatchReceipt(missing, 8000, lane.campaign, identity),
      /Expected values to be strictly equal/
    );

    const corrupt = structuredClone(receipt);
    for (const cell of corrupt.completed) cell.actorOverlap = false;
    assert.throws(
      () =>
        assertG3GeneratedBatchReceipt(corrupt, 8000, lane.campaign, identity),
      /actual overlap cut/
    );
  });
}

for (const [mode, batchMode, campaign] of [
  ["g3-seeds", "g3-seed-batch", G3_GENERATED_CAMPAIGN],
  [
    "g3-transport-seeds",
    "g3-transport-seed-batch",
    G3_GENERATED_TRANSPORT_CAMPAIGN,
  ],
]) {
  test(`${mode} binds the exact G3 range and batch boundary`, () => {
    assert.equal(parseRaptor3Request([mode]).mode, mode);
    assert.equal(parseRaptor3Request([batchMode, "8000"]).firstSeed, 8000);
    assert.equal(parseRaptor3Request([batchMode, "17900"]).firstSeed, 17900);
    for (const firstSeed of [7999, 8001, 17901, 18000])
      assert.throws(
        () => parseRaptor3Request([batchMode, String(firstSeed)]),
        /exact frozen boundary/
      );
    assert.equal(campaign.seedCount, 10_000);
  });
}

for (const lane of lanes) {
  test(`${lane.name}: G2 admits only the frozen range and unfiltered commands`, () => {
    assert.equal(lane.campaign.firstSeed, 2000);
    assert.equal(lane.campaign.seedCount, 5000);
    assert.equal(lane.campaign.batchSize, 100);
    assert.equal(lane.campaign.replayCount, 3);
    assert.deepEqual(lane.campaign.profiles, lane.profiles);
    assert.equal(parseRaptor3Request([lane.mode]).mode, lane.mode);
    for (const firstSeed of [2000, 6900]) {
      const request = parseRaptor3Request([lane.batchMode, String(firstSeed)]);
      assert.equal(request.mode, lane.batchMode);
      assert.equal(request.firstSeed, firstSeed);
    }
    for (const firstSeed of [1900, 1999, 2001, 6999, 7000, 2000.5]) {
      assert.throws(
        () => parseRaptor3Request([lane.batchMode, String(firstSeed)]),
        /exact frozen boundary/,
        `Must reject batch start ${firstSeed}`
      );
    }
    for (const args of [
      [lane.mode, "2000"],
      [lane.mode, "--seed-count=100"],
      [lane.mode, "--testNamePattern=absent"],
      [lane.batchMode, "2000", "--seed-count=1"],
      [lane.batchMode, "2000", "--testNamePattern=absent"],
      [lane.batchMode, "2000", "--profile=" + lane.profiles[0]],
    ]) {
      assert.throws(() => parseRaptor3Request(args), /cannot be filtered/);
    }
  });

  test(`${lane.name}: unit receipts require every exact cell, replay and zero skips`, () => {
    const valid = unitReceipt(2000, lane.profiles);
    assertGeneratedBatchReceipt(valid, 2000, lane.campaign);
    const mutations = [
      ["missing cell", (receipt) => receipt.completed.pop()],
      [
        "duplicate replacing a cell",
        (receipt) => {
          receipt.completed[1] = { ...receipt.completed[0] };
        },
      ],
      [
        "out-of-batch seed",
        (receipt) => {
          receipt.completed[0].seed = 2100;
        },
      ],
      [
        "wrong cell profile",
        (receipt) => {
          receipt.completed[0].profile = lane.profiles[1];
        },
      ],
      ["missing advertised profile", (receipt) => receipt.profiles.pop()],
      [
        "wrong batch start",
        (receipt) => {
          receipt.firstSeed = 2100;
        },
      ],
      [
        "shortened batch",
        (receipt) => {
          receipt.seedCount = 99;
        },
      ],
      [
        "missing replay",
        (receipt) => {
          receipt.replays = 599;
        },
      ],
      [
        "skipped cell",
        (receipt) => {
          receipt.skipped = 1;
        },
      ],
    ];
    for (const [name, mutate] of mutations) {
      const invalid = structuredClone(valid);
      mutate(invalid);
      assert.throws(
        () => assertGeneratedBatchReceipt(invalid, 2000, lane.campaign),
        { name: "AssertionError" },
        name
      );
    }
  });

  test(`${lane.name}: unit quota claims must reach twenty percent in EACH profile`, () => {
    const valid = unitReceipt(2000, lane.profiles);
    assertGeneratedBatchReceipt(valid, 2000, lane.campaign);
    for (const deficientProfile of lane.profiles) {
      for (const [field, below, extra, reason] of [
        ["actors", 1, 2, /Missing two-actor quota/],
        ["faults", 0, 1, /Missing actually injected fault quota/],
      ]) {
        const invalid = structuredClone(valid);
        // Keep the aggregate at forty qualifying cells: a healthy profile
        // cannot compensate for the other profile's nineteen.
        invalid.completed.find(
          (cell) => cell.profile === deficientProfile && cell.seed === 2019
        )[field] = below;
        invalid.completed.find(
          (cell) => cell.profile !== deficientProfile && cell.seed === 2020
        )[field] = extra;
        assert.throws(
          () => assertGeneratedBatchReceipt(invalid, 2000, lane.campaign),
          reason
        );
      }
    }
  });
}

for (const lane of prepLanes) {
  test(`${lane.name}: G3P-06 reserves exactly one new unfiltered batch`, () => {
    assert.equal(lane.campaign.firstSeed, 7000);
    assert.equal(lane.campaign.seedCount, 100);
    assert.equal(lane.campaign.batchSize, 100);
    assert.equal(lane.campaign.replayCount, 3);
    assert.deepEqual(lane.campaign.profiles, lane.profiles);
    assert.equal(parseRaptor3Request([lane.mode]).mode, lane.mode);

    const request = parseRaptor3Request([lane.batchMode, "7000"]);
    assert.equal(request.mode, lane.batchMode);
    assert.equal(request.firstSeed, 7000);

    for (const firstSeed of [6900, 6999, 7001, 7100, 7000.5]) {
      assert.throws(
        () => parseRaptor3Request([lane.batchMode, String(firstSeed)]),
        /exact frozen boundary/,
        `Must reject prep batch start ${firstSeed}`
      );
    }
    for (const args of [
      [lane.mode, "7000"],
      [lane.mode, "--seed-count=100"],
      [lane.mode, "--testNamePattern=absent"],
      [lane.batchMode, "7000", "--seed-count=1"],
      [lane.batchMode, "7000", "--testNamePattern=absent"],
      [lane.batchMode, "7000", "--profile=" + lane.profiles[0]],
    ])
      assert.throws(() => parseRaptor3Request(args), /cannot be filtered/);
  });

  test(`${lane.name}: G3P-06 receipts bind every new profile/seed cell`, () => {
    const valid = unitReceipt(7000, lane.profiles);
    assertGeneratedBatchReceipt(valid, 7000, lane.campaign);

    for (const [name, mutate] of [
      [
        "old seed substituted",
        (receipt) => {
          receipt.completed[0].seed = 6900;
        },
      ],
      [
        "wrong batch start",
        (receipt) => {
          receipt.firstSeed = 2000;
        },
      ],
    ]) {
      const invalid = structuredClone(valid);
      mutate(invalid);
      assert.throws(
        () => assertGeneratedBatchReceipt(invalid, 7000, lane.campaign),
        { name: "AssertionError" },
        name
      );
    }
  });
}

const G4_FIXED_SUITES = [
  ...G4_READ_TESTS,
  ...G4_LIFECYCLE_EVENTS_TESTS,
  ...G4_LIFECYCLE_ADMISSION_TESTS,
  ...G4_ROUTE_LIFECYCLE_TESTS,
  ...G4_ROUTE_ADMISSION_TESTS,
  ...G4_ROUTE_CACHE_TESTS,
  ...G4_ROUTE_TRANSACTION_TESTS,
  ...G4_GENERATION_SELFTEST_TESTS,
  ...G4_UNIT01_AUTHOR_TESTS,
  ...G4_UNIT01_REVIEW_TESTS,
];

test("G4 suites stay outside credential-free discovery while they are red", () => {
  for (const file of [
    ...G4_FIXED_SUITES,
    ...G4_GENERATED_CAMPAIGN_TESTS,
    ...G4_GENERATED_TRANSPORT_CAMPAIGN_TESTS,
    ...G4_WRITE_CAMPAIGN_TESTS,
    ...G4_WRITE_TRANSPORT_CAMPAIGN_TESTS,
    ...G4_NATIVE_PG_TESTS,
    ...G4_NATIVE_MYSQL_TESTS,
  ]) {
    assert.equal(EXTENDED_LOCAL_TESTS.includes(file), false, file);
    // Deliberately NOT in the Raptor fixed stage: these witnesses are red
    // against the frozen candidate. They join that stage when they pass, and
    // this assertion is what makes the promotion an explicit decision.
    assert.equal(RAPTOR3_FIXED_LOCAL_TESTS.includes(file), false, file);
  }
});

test("G4 fixed modes admit their exact contract without filters", () => {
  const modes = [
    "g4-read-contracts",
    "g4-read-operations",
    "g4-read-filters",
    "g4-read-ordering",
    "g4-read-pagination",
    "g4-read-projection",
    "g4-read-aggregates",
    "g4-read-codecs",
    "g4-read-recursive-fit",
    "g4-lifecycle-events",
    "g4-lifecycle-admission",
    "g4-route-lifecycle",
    "g4-route-admission",
    "g4-route-cache",
    "g4-route-transactions",
    "g4-generation-selftests",
    "g4-unit01-author",
    "g4-unit01-review",
    "g4-unit02-author",
    "g4-unit02-mysql-contracts",
    "g4-unit02-pg-contracts",
    "g4-read-envelope-pg-contracts",
    "g4-read-envelope-mysql-contracts",
  ];
  for (const mode of modes) {
    assert.equal(parseRaptor3Request([mode]).mode, mode);
    for (const extra of ["20000", "--testNamePattern=absent"])
      assert.throws(
        () => parseRaptor3Request([mode, extra]),
        /cannot be filtered/
      );
  }
  const total = Object.values(G4_READ_COUNTS).reduce(
    (sum, count) => sum + count,
    0
  );
  assert.equal(
    total,
    62,
    "The fixed C01/C12 read family lost or gained a witness cell"
  );
  // The G4-01 evidence landed from that unit's worktree. Its two registered
  // totals are the numbers the unit reported (83 author checks) and the number
  // the reviewer probes actually contain, measured on the landed files.
  const sum = (counts) =>
    Object.values(counts).reduce((carried, count) => carried + count, 0);
  assert.equal(
    sum(G4_UNIT01_AUTHOR_COUNTS),
    83,
    "The landed G4-01 author checks lost or gained a cell"
  );
  assert.equal(
    sum(G4_UNIT01_REVIEW_COUNTS),
    200,
    "The landed G4-01 reviewer probes lost or gained a cell"
  );
});

/**
 * The write lanes are the G3 write campaign on seeds no child has ever run.
 *
 * What this cell protects is that "data-only" is true: the two constants carry
 * G3's batch size, replay count, completion limit and profiles, their ranges
 * are disjoint from every other lane, and the SAME
 * `assertG3GeneratedBatchReceipt` still re-derives the contract rotation and
 * the actor/fault quotas from the seed. A campaign constant that widened what
 * qualifies, or a range that overlapped an already-qualified one, fails here.
 */
test("G4 write lanes reuse the G3 campaign on fresh disjoint ranges", () => {
  const lanes = [
    {
      mode: "g4-write-seeds",
      batchMode: "g4-write-seed-batch",
      campaign: G4_WRITE_CAMPAIGN,
      inherited: G3_GENERATED_CAMPAIGN,
      firstSeed: 75_000,
    },
    {
      mode: "g4-write-transport-seeds",
      batchMode: "g4-write-transport-seed-batch",
      campaign: G4_WRITE_TRANSPORT_CAMPAIGN,
      inherited: G3_GENERATED_TRANSPORT_CAMPAIGN,
      firstSeed: 100_000,
    },
  ];
  // Every frozen seed range the manifest declares, not a hand-kept list of
  // three: a campaign constant added later must be compared too, and nothing
  // outside the manifest decides which ranges have been run. One level of
  // nesting is descended so the CS-03 extension slices, which live in a map
  // keyed by mode, are compared like any other lane.
  const ranges = (value) =>
    value === null || typeof value !== "object"
      ? []
      : Number.isInteger(value.firstSeed) && Number.isInteger(value.seedCount)
        ? [value]
        : Object.values(value).filter(
            (nested) =>
              nested !== null &&
              typeof nested === "object" &&
              Number.isInteger(nested.firstSeed) &&
              Number.isInteger(nested.seedCount)
          );
  const occupied = Object.values(manifest).flatMap(ranges);
  assert.ok(
    occupied.length >= 16,
    `only ${occupied.length} frozen seed ranges were found in the manifest`
  );
  const identity = {
    production: "production-source",
    harness: "harness-source",
    runtime: { node: "v24.21.0" },
  };
  for (const lane of lanes) {
    const { campaign, inherited, firstSeed } = lane;
    assert.equal(campaign.firstSeed, firstSeed);
    assert.equal(campaign.seedCount, 25_000);
    assert.equal(campaign.batchSize, inherited.batchSize);
    assert.equal(campaign.replayCount, inherited.replayCount);
    assert.equal(campaign.completionLimit, inherited.completionLimit);
    assert.deepEqual(campaign.profiles, inherited.profiles);
    // The rotation `(seed - firstSeed) % 4` the receipt re-derives has to
    // agree with the generator's `(seed - 8000) % 4`, or every cell of every
    // child would report the wrong contract family.
    assert.equal(
      (campaign.firstSeed - G3_GENERATED_CAMPAIGN.firstSeed) % 4,
      0,
      "A write lane's first seed must keep the G3 contract rotation"
    );
    for (const other of [...occupied, ...lanes.map((l) => l.campaign)]) {
      if (other === campaign) continue;
      assert(
        campaign.firstSeed + campaign.seedCount <= other.firstSeed ||
          other.firstSeed + other.seedCount <= campaign.firstSeed,
        "A write lane overlaps an already-run range"
      );
    }

    assert.equal(parseRaptor3Request([lane.mode]).mode, lane.mode);
    assert.equal(
      parseRaptor3Request([lane.batchMode, String(firstSeed)]).firstSeed,
      firstSeed
    );
    const last = firstSeed + campaign.seedCount - campaign.batchSize;
    assert.equal(
      parseRaptor3Request([lane.batchMode, String(last)]).firstSeed,
      last
    );
    for (const off of [firstSeed - 1, firstSeed + 1, last + 1, last + 100])
      assert.throws(
        () => parseRaptor3Request([lane.batchMode, String(off)]),
        /exact frozen boundary/
      );
    // One subject, so the read campaign's flag is refused rather than ignored.
    for (const args of [
      [lane.mode, "--subject=shipped"],
      [lane.batchMode, String(firstSeed), "--subject=candidate"],
    ])
      assert.throws(
        () => parseRaptor3Request(args),
        /Subject selection applies only to the G4 generated read campaign/
      );
    assert.throws(
      () => parseRaptor3Request([lane.mode, "--testNamePattern=absent"]),
      /cannot be filtered/
    );

    const completion = (seed, profile) => ({
      seed,
      profile,
      contract: ["C08", "C09", "C10", "C11"][(seed - campaign.firstSeed) % 4],
      actors: seed % 5 === 0 ? 2 : 1,
      actorOverlap: seed % 5 === 0,
      faults: seed % 5 === 1 ? 1 : 0,
      operations: 3,
      completions: 1,
    });
    const completed = campaign.profiles.flatMap((profile) =>
      Array.from({ length: campaign.batchSize }, (_, offset) =>
        completion(firstSeed + offset, profile)
      )
    );
    const receipt = {
      formatVersion: 1,
      qualifying: true,
      status: "complete",
      identity,
      firstSeed,
      seedCount: campaign.batchSize,
      profiles: campaign.profiles,
      completed,
      replays:
        campaign.batchSize *
        campaign.profiles.length *
        campaign.replayCount,
      skipped: 0,
    };
    assert.doesNotThrow(() =>
      assertG3GeneratedBatchReceipt(receipt, firstSeed, campaign, identity)
    );
    // A child that strayed outside its own frozen range still fails, which is
    // what stops a write lane from re-running an already-qualified G3 seed.
    assert.throws(
      () =>
        assertG3GeneratedBatchReceipt(
          receipt,
          firstSeed,
          G3_GENERATED_CAMPAIGN,
          identity
        ),
      /outside the frozen campaign/
    );
    const corrupt = structuredClone(receipt);
    for (const cell of corrupt.completed) cell.faults = 1;
    assert.throws(
      () =>
        assertG3GeneratedBatchReceipt(corrupt, firstSeed, campaign, identity),
      /legal injected failure/
    );
  }
});

function g4UnitReceipt(firstSeed, seedCount, campaign, subject, identity) {
  const completed = campaign.profiles.flatMap((profile) =>
    Array.from({ length: seedCount }, (_, offset) => {
      const seed = firstSeed + offset;
      const contract =
        G4_READ_CONTRACT_FAMILIES[
          (seed - campaign.firstSeed) % G4_READ_CONTRACT_FAMILIES.length
        ];
      // Q-S is the relation family; every other contract reads the codec world.
      const family = contract === "Q-S" ? "relation" : "codec";
      const transport = G4_TRANSPORT_MODELS[profile];
      return {
        seed,
        profile,
        contract,
        family,
        actors: 1,
        faults: 0,
        rows: 2,
        statements: transport === "atomic-submission" ? 3 : 1,
        transport,
      };
    })
  );
  return {
    formatVersion: 1,
    qualifying: subject === "candidate",
    status: subject === "candidate" ? "complete" : "oracle-validation",
    subject,
    identity,
    firstSeed,
    seedCount,
    profiles: [...campaign.profiles],
    completed,
    replays: completed.length * campaign.replayCount,
    skipped: 0,
  };
}

test("G4 campaign modes bind the frozen disjoint ranges and their subjects", () => {
  const identity = { production: "reference", harness: "shared" };
  assert.equal(G4_GENERATED_CAMPAIGN.firstSeed, 20_000);
  assert.equal(G4_GENERATED_CAMPAIGN.seedCount, 25_000);
  assert.equal(G4_GENERATED_TRANSPORT_CAMPAIGN.firstSeed, 50_000);
  assert.equal(G4_GENERATED_TRANSPORT_CAMPAIGN.seedCount, 25_000);
  assert.deepEqual(G4_GENERATED_CAMPAIGN.profiles, [
    "sqlite-interactive",
    "sqlite-atomic-batch",
  ]);
  assert.deepEqual(G4_GENERATED_TRANSPORT_CAMPAIGN.profiles, [
    "scripted-returning-weak",
    "scripted-returning-ack",
  ]);
  assert.equal(parseRaptor3Request(["g4-seeds"]).mode, "g4-seeds");
  assert.equal(
    parseRaptor3Request(["g4-seed-batch", "20000"]).firstSeed,
    20_000
  );
  assert.throws(
    () => parseRaptor3Request(["g4-seed-batch", "19999"]),
    /exact frozen boundary/
  );
  assert.throws(
    () => parseRaptor3Request(["g4-seed-batch", "45000"]),
    /exact frozen boundary/
  );
  assert.throws(
    () => parseRaptor3Request(["g4-transport-seed-batch", "20000"]),
    /exact frozen boundary/
  );

  // The subject belongs to the command. The default is the claim; the
  // oracle-validation lane has to be asked for by name, and no other mode
  // accepts the flag at all.
  for (const mode of [
    "g4-seeds",
    "g4-transport-seeds",
    "g4-seed-batch",
    "g4-transport-seed-batch",
  ]) {
    const positional = mode.endsWith("-seed-batch")
      ? [mode, mode.includes("transport") ? "50000" : "20000"]
      : [mode];
    assert.equal(parseRaptor3Request(positional).subject, "candidate");
    assert.equal(
      parseRaptor3Request([...positional, "--subject=shipped"]).subject,
      "shipped"
    );
    assert.throws(
      () => parseRaptor3Request([...positional, "--subject=anything"]),
      /Subject is candidate or shipped/
    );
    assert.throws(
      () =>
        parseRaptor3Request([
          ...positional,
          "--subject=shipped",
          "--subject=candidate",
        ]),
      /Subject may be specified only once/
    );
  }
  for (const mode of ["g0", "g3-seeds", "g4-read-contracts"])
    assert.throws(
      () => parseRaptor3Request([mode, "--subject=shipped"]),
      /Subject selection applies only to the G4 generated read campaign/
    );
  assert.equal(parseRaptor3Request(["g0"]).subject, undefined);

  for (const campaign of [
    G4_GENERATED_CAMPAIGN,
    G4_GENERATED_TRANSPORT_CAMPAIGN,
  ]) {
    const first = campaign.firstSeed;
    const qualifying = g4UnitReceipt(first, 5, campaign, "candidate", identity);
    assert.doesNotThrow(() =>
      assertG4GeneratedBatchReceipt(qualifying, first, campaign, identity)
    );
    assert.throws(
      () =>
        assertG4GeneratedBatchReceipt(
          { ...qualifying, identity: { production: "stale" } },
          first,
          campaign,
          identity
        ),
      /Stale Raptor 3 evidence/
    );
    assert.throws(() =>
      assertG4GeneratedBatchReceipt(
        { ...qualifying, completed: qualifying.completed.slice(1) },
        first,
        campaign,
        identity
      )
    );
    assert.throws(() =>
      assertG4GeneratedBatchReceipt(
        { ...qualifying, skipped: 1 },
        first,
        campaign,
        identity
      )
    );
    assert.throws(() =>
      assertG4GeneratedBatchReceipt(
        {
          ...qualifying,
          completed: qualifying.completed.map((cell, index) =>
            index === 0 ? { ...cell, faults: 1 } : cell
          ),
        },
        first,
        campaign,
        identity
      )
    );
    const validation = g4UnitReceipt(first, 5, campaign, "shipped", identity);
    assert.throws(
      () => assertG4GeneratedBatchReceipt(validation, first, campaign, identity),
      /candidate/
    );
    assert.doesNotThrow(() =>
      assertG4OracleValidationReceipt(validation, first, campaign, identity)
    );
    assert.throws(
      () =>
        assertG4OracleValidationReceipt(qualifying, first, campaign, identity),
      /shipped/
    );
  }
});
