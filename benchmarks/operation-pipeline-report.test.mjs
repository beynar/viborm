import assert from "node:assert/strict";
import test from "node:test";
import {
  CROSS_PROVIDER_BASELINE_COMMIT,
  PROVIDERS,
  WORKLOADS,
} from "./operation-pipeline-catalog.mjs";
import {
  PROTOCOL_PATHS,
  protocolSha256,
} from "./operation-pipeline-protocol.mjs";
import {
  aggregateTarget,
  evaluateKeepGate,
  measuredFields,
  verifyCrossStageSemantics,
} from "./operation-pipeline-report.mjs";

const DID_NOT_IMPROVE_PATTERN = /did not improve by more than 2×MAD/;
const NO_TARGET_PATTERN = /No target metric contract/;
const REPLICATE_CHECKSUM_DRIFT_PATTERN =
  /sqlite3\/scalar-find-unique\/full\/cpu changed semantic checksum across replicates/;

const workload = "scalar-find-unique";
const targets = [
  { workload, stage: "prepare", mode: "cpu" },
  { workload, stage: "full", mode: "cpu" },
  { workload, stage: "full", mode: "alloc" },
];
const workloads = {
  [workload]: { stages: ["prepare", "full"] },
};
const comparisons = targets.map((target) => ({
  ...target,
  deltas:
    target.stage === "prepare"
      ? {
          cpuMicrosecondsPerOperation: {
            percent: 0,
            significantImprovement: false,
            significantRegression: false,
          },
          wallMicrosecondsPerOperation: {
            percent: -20,
            significantImprovement: true,
            significantRegression: false,
          },
        }
      : {},
}));

test("an identical declared target cannot become keep-eligible from non-target noise", () => {
  const gate = evaluateKeepGate({
    smoke: false,
    hasOverrides: false,
    targets,
    declaredTargets: [
      {
        workload,
        stage: "prepare",
        mode: "cpu",
        metric: "cpuMicrosecondsPerOperation",
      },
    ],
    comparisons,
    workloads,
  });
  assert.equal(gate.eligible, false);
  assert.match(gate.reasons.join("\n"), DID_NOT_IMPROVE_PATTERN);
});

test("a valid measurement without a target contract is not keep-eligible", () => {
  const gate = evaluateKeepGate({
    smoke: false,
    hasOverrides: false,
    targets,
    declaredTargets: [],
    comparisons,
    workloads,
  });
  assert.equal(gate.eligible, false);
  assert.match(gate.reasons.join("\n"), NO_TARGET_PATTERN);
});

test("prepare alloc/cpu plus full retained does not satisfy full evidence", () => {
  const incompleteTargets = [
    { workload, stage: "prepare", mode: "alloc" },
    { workload, stage: "prepare", mode: "cpu" },
    { workload, stage: "full", mode: "retained" },
  ];
  const gate = evaluateKeepGate({
    smoke: false,
    hasOverrides: false,
    targets: incompleteTargets,
    declaredTargets: [
      {
        workload,
        stage: "prepare",
        mode: "cpu",
        metric: "cpuMicrosecondsPerOperation",
      },
    ],
    comparisons: [
      {
        workload,
        stage: "prepare",
        mode: "cpu",
        deltas: {
          cpuMicrosecondsPerOperation: {
            percent: -20,
            significantImprovement: true,
            significantRegression: false,
          },
        },
      },
    ],
    workloads,
  });
  assert.equal(gate.eligible, false);
  assert.deepEqual(
    gate.reasons.filter((reason) => reason.includes("corresponding full/")),
    [
      `sqlite3/${workload} is missing corresponding full/alloc evidence.`,
      `sqlite3/${workload} is missing corresponding full/cpu evidence.`,
    ]
  );
});

test("the shared lock implementation contributes bytes to the protocol SHA", () => {
  const contents = new Map(
    PROTOCOL_PATHS.map((path) => [path, Buffer.from(`fixture:${path}`)])
  );
  const baseline = protocolSha256((path) => contents.get(path));
  contents.set("scripts/test-run-lock.mjs", Buffer.from("changed lock bytes"));
  const changed = protocolSha256((path) => contents.get(path));
  assert.notEqual(changed, baseline);
});

test("pairwise checksum agreement cannot hide drift across replicates", () => {
  const samples = [
    { checkout: "baseline", replicate: 0, checksum: 10 },
    { checkout: "candidate", replicate: 0, checksum: 10 },
    { checkout: "candidate", replicate: 1, checksum: 20 },
    { checkout: "baseline", replicate: 1, checksum: 20 },
  ].map((sample) => ({
    ...sample,
    workload,
    stage: "full",
    mode: "cpu",
    output: {
      semanticDigest: "same-complete-result",
      measurement: { checksum: sample.checksum },
    },
  }));

  assert.throws(
    () => verifyCrossStageSemantics(samples),
    REPLICATE_CHECKSUM_DRIFT_PATTERN
  );
});

test("the width and relation-depth proof matrices are complete", () => {
  for (const width of [1, 20, 100]) {
    assert.equal(WORKLOADS[`wide-scalar-select-${width}`]?.fixture, "wide");
  }
  for (const width of [1, 20]) {
    assert.equal(WORKLOADS[`wide-create-${width}`]?.fixture, "wide");
    assert.equal(WORKLOADS[`wide-update-${width}`]?.fixture, "wide");
  }
  assert.equal(WORKLOADS["wide-scalar-predicates-10"]?.fixture, "wide");
  for (const fieldCount of [2, 20, 100]) {
    for (const depth of [1, 2, 3]) {
      assert.equal(
        WORKLOADS[`relation-projection-${fieldCount}-depth-${depth}`]?.fixture,
        "wide"
      );
    }
  }
});

test("the cross-provider catalog pins every Unit 2 provider and stage", () => {
  assert.equal(
    CROSS_PROVIDER_BASELINE_COMMIT,
    "52eef9ebfc710407e1e5fe6042e2ed5a11adf19e"
  );
  assert.deepEqual(Object.keys(PROVIDERS), [
    "sqlite3",
    "bun-sqlite",
    "libsql",
    "pglite",
    "pg",
    "postgres.js",
    "bun-sql",
    "mysql2",
    "planetscale",
    "neon-http",
    "d1",
  ]);
  assert.deepEqual(WORKLOADS["provider-mixed-scalar-20"].stages, [
    "provider-execute",
    "driver-wrapper",
    "unowned-parse",
    "provider-parse",
    "full",
  ]);
  assert.deepEqual(
    WORKLOADS["provider-mixed-scalar-20"].providers,
    Object.keys(PROVIDERS)
  );
  for (const rows of [1, 20, 1000, 10000]) {
    assert.equal(WORKLOADS[`provider-identity-${rows}`].rowsPerOperation, rows);
    assert.equal(
      WORKLOADS[`provider-mixed-scalar-${rows}`].rowsPerOperation,
      rows
    );
  }
  for (const workloadName of [
    "provider-wide-scalar-100",
    "provider-fixed-nested-20",
    "provider-variant-nested-20",
    "provider-count-10000",
    "provider-aggregate-10000",
    "provider-returning-one",
    "provider-relation-count-20",
    "provider-execution-forms",
  ]) {
    assert.ok(WORKLOADS[workloadName]);
  }
  assert.deepEqual(WORKLOADS["provider-execution-forms"].stages, [
    "direct",
    "prepared",
    "transaction",
    "fallback-batch",
    "native-batch",
  ]);
});

test("retained mode reports retained, released, and peak process memory", () => {
  assert.deepEqual(measuredFields("retained"), [
    "retainedBytesPerOperation",
    "retainedBytesPerRow",
    "releasedBytesPerOperation",
    "releasedBytesPerRow",
    "peakRssBytes",
    "peakRssGrowthBytes",
  ]);
});

test("a signed retained-heap delta has no relative percentage at a non-positive baseline", () => {
  const target = {
    provider: "sqlite3",
    workload,
    stage: "full",
    mode: "retained",
  };
  const retainedMeasurement = (retainedBytesPerOperation) => ({
    checksum: 1,
    retainedBytesPerOperation,
    retainedBytesPerRow: retainedBytesPerOperation,
    releasedBytesPerOperation: 100,
    releasedBytesPerRow: 100,
    peakRssBytes: 100_000,
    peakRssGrowthBytes: 0,
  });
  const samples = [
    ...Array.from({ length: 5 }, (_, replicate) => ({
      ...target,
      checkout: "baseline",
      replicate,
      output: {
        semanticDigest: "same-result",
        witness: {},
        measurement: retainedMeasurement(-1_030),
      },
    })),
    ...Array.from({ length: 5 }, (_, replicate) => ({
      ...target,
      checkout: "candidate",
      replicate,
      output: {
        semanticDigest: "same-result",
        witness: {},
        measurement: retainedMeasurement(-2_949),
      },
    })),
  ];

  const comparison = aggregateTarget(target, samples);
  assert.equal(
    comparison.deltas.retainedBytesPerOperation.absolute,
    -1_919
  );
  assert.equal(comparison.deltas.retainedBytesPerOperation.percent, null);
  assert.equal(
    comparison.deltas.retainedBytesPerOperation.significantImprovement,
    true
  );
  assert.equal(
    comparison.deltas.retainedBytesPerOperation.significantRegression,
    false
  );

  const zeroBaselineComparison = aggregateTarget(
    target,
    samples.map((sample) => ({
      ...sample,
      output: {
        ...sample.output,
        measurement: retainedMeasurement(
          sample.checkout === "baseline" ? 0 : 100
        ),
      },
    }))
  );
  assert.equal(
    zeroBaselineComparison.deltas.retainedBytesPerOperation.percent,
    null
  );
});

test("retained growth stays diagnostic while memory levels and ordinary metrics block", () => {
  const retainedGate = evaluateKeepGate({
    smoke: false,
    hasOverrides: false,
    targets: [],
    declaredTargets: [],
    comparisons: [
      {
        workload,
        stage: "full",
        mode: "retained",
        deltas: {
          retainedBytesPerOperation: {
            percent: 100,
            significantImprovement: false,
            significantRegression: true,
          },
          peakRssBytes: {
            percent: 11,
            significantImprovement: false,
            significantRegression: true,
          },
        },
      },
    ],
  });
  assert.equal(
    retainedGate.reasons.some((reason) =>
      reason.includes("retainedBytesPerOperation regressed 100.00%")
    ),
    false
  );
  assert.equal(
    retainedGate.reasons.some((reason) =>
      reason.includes("retainedBytesPerOperation regressed beyond 2×MAD")
    ),
    false
  );
  assert.equal(
    retainedGate.reasons.some((reason) =>
      reason.includes("peakRssBytes regressed beyond 2×MAD")
    ),
    false
  );
  assert.equal(
    retainedGate.reasons.some((reason) =>
      reason.includes("peakRssBytes regressed 11.00%")
    ),
    true
  );

  const cpuGate = evaluateKeepGate({
    smoke: false,
    hasOverrides: false,
    targets: [],
    declaredTargets: [],
    comparisons: [
      {
        workload,
        stage: "full",
        mode: "cpu",
        deltas: {
          cpuMicrosecondsPerOperation: {
            percent: 1,
            significantImprovement: false,
            significantRegression: true,
          },
        },
      },
    ],
  });
  assert.equal(
    cpuGate.reasons.some((reason) =>
      reason.includes(
        "cpu/cpuMicrosecondsPerOperation regressed beyond 2×MAD"
      )
    ),
    true
  );
});

test("a skipped provider leg is visible and cannot pass the keep gate", () => {
  const gate = evaluateKeepGate({
    smoke: false,
    hasOverrides: false,
    targets: [],
    declaredTargets: [],
    comparisons: [],
    skippedComparisons: [
      {
        provider: "d1",
        workload: "provider-mixed-scalar-20",
        stage: "full",
        mode: "cpu",
        reason: "Workers runtime unavailable",
      },
    ],
  });
  assert.equal(gate.eligible, false);
  assert.match(gate.reasons.join("\n"), /d1\/provider-mixed-scalar-20/);
});
