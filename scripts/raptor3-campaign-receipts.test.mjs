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
} from "./raptor3-manifest.mjs";
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
