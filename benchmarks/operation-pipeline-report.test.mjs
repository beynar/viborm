import assert from "node:assert/strict";
import test from "node:test";
import {
  CROSS_PROVIDER_BASELINE_COMMIT,
  EXTENSION_ARMS,
  PROVIDERS,
  WORKLOADS,
} from "./operation-pipeline-catalog.mjs";
import {
  PROTOCOL_PATHS,
  protocolSha256,
} from "./operation-pipeline-protocol.mjs";
import {
  aggregateTarget,
  diagnosticMeasurementCounts,
  evaluateKeepGate,
  isPerOperationMetric,
  measuredFields,
  parseDeclaredBudgets,
  verifyCrossStageSemantics,
} from "./operation-pipeline-report.mjs";

const DID_NOT_IMPROVE_PATTERN = /did not improve by more than 2×MAD/;
const NO_TARGET_PATTERN = /No target, ceiling, or budget metric contract/;
const REPLICATE_CHECKSUM_DRIFT_PATTERN =
  /sqlite3\/scalar-find-unique\/full\/cpu changed semantic checksum across replicates/;
const D1_MIXED_SCALAR_PATTERN = /d1\/provider-mixed-scalar-20/;
const DIAGNOSTIC_MODE_PATTERN = /Diagnostic mode/;

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

test("allowed-overhead budgets parse discriminated per-operation contracts", () => {
  assert.deepEqual(
    parseDeclaredBudgets(
      [
        "pglite/scalar-find-unique/full/cpu/cpuMicrosecondsPerOperation/absolute/12.5",
        "pglite/scalar-find-unique/full/cpu/wallMicrosecondsPerOperation/percent/8",
      ],
      {
        [workload]: {
          stages: ["prepare", "full"],
          providers: ["sqlite3", "pglite"],
        },
      }
    ),
    [
      {
        provider: "pglite",
        workload,
        stage: "full",
        mode: "cpu",
        metric: "cpuMicrosecondsPerOperation",
        limit: { kind: "absolute", maximum: 12.5 },
      },
      {
        provider: "pglite",
        workload,
        stage: "full",
        mode: "cpu",
        metric: "wallMicrosecondsPerOperation",
        limit: { kind: "percent", maximum: 8 },
      },
    ]
  );
});

test("allowed-overhead budget parsing refuses malformed, duplicate, and non-operation metrics", () => {
  const budgetWorkloads = {
    [workload]: { stages: ["full"], providers: ["sqlite3"] },
  };
  assert.throws(
    () =>
      parseDeclaredBudgets(
        [
          "scalar-find-unique/full/alloc/allocatedBytesPerOperation/absolute/10",
        ],
        budgetWorkloads
      ),
    /Invalid --budget .* expected provider\/workload\/stage\/mode\/metric\/\(absolute\|percent\)\/non-negative-maximum/
  );
  assert.throws(
    () =>
      parseDeclaredBudgets(
        [
          "sqlite3/scalar-find-unique/full/alloc/allocatedBytesPerOperation/absolute/10",
          "sqlite3/scalar-find-unique/full/alloc/allocatedBytesPerOperation/percent/20",
        ],
        budgetWorkloads
      ),
    /Duplicate --budget metric contract/
  );
  assert.throws(
    () =>
      parseDeclaredBudgets(
        [
          "sqlite3/scalar-find-unique/full/alloc/allocatedBytesPerRow/absolute/10",
        ],
        budgetWorkloads
      ),
    /Budget metric allocatedBytesPerRow is not a per-operation metric measured in alloc mode/
  );
  assert.throws(
    () =>
      parseDeclaredBudgets(
        [
          "sqlite3/scalar-find-unique/full/alloc/cpuMicrosecondsPerOperation/absolute/10",
        ],
        budgetWorkloads
      ),
    /Budget metric cpuMicrosecondsPerOperation is not a per-operation metric measured in alloc mode/
  );
  assert.throws(
    () =>
      parseDeclaredBudgets(
        [
          "sqlite3/scalar-find-unique/full/alloc/allocatedBytesPerOperation/ratio/10",
        ],
        budgetWorkloads
      ),
    /Invalid --budget/
  );
});

test("a passed absolute budget covers its operation and derived row metrics only", () => {
  const budgetTargets = [
    { provider: "sqlite3", workload, stage: "full", mode: "alloc" },
    { provider: "sqlite3", workload, stage: "full", mode: "cpu" },
  ];
  const budget = {
    provider: "sqlite3",
    workload,
    stage: "full",
    mode: "alloc",
    metric: "allocatedBytesPerOperation",
    limit: { kind: "absolute", maximum: 100 },
  };
  const budgetComparisons = (absolute, wallRegression = false) => [
    {
      provider: "sqlite3",
      workload,
      stage: "full",
      mode: "alloc",
      deltas: {
        allocatedBytesPerOperation: {
          absolute,
          percent: 25,
          significantImprovement: false,
          significantRegression: true,
        },
        allocatedBytesPerRow: {
          absolute: absolute / 10,
          percent: 25,
          significantImprovement: false,
          significantRegression: true,
        },
      },
    },
    {
      provider: "sqlite3",
      workload,
      stage: "full",
      mode: "cpu",
      deltas: {
        wallMicrosecondsPerOperation: {
          absolute: 1,
          percent: 1,
          significantImprovement: false,
          significantRegression: wallRegression,
        },
      },
    },
  ];
  const evaluate = (absolute, wallRegression = false) =>
    evaluateKeepGate({
      smoke: false,
      hasOverrides: false,
      targets: budgetTargets,
      declaredTargets: [],
      declaredBudgets: [budget],
      comparisons: budgetComparisons(absolute, wallRegression),
    });

  assert.equal(evaluate(100).eligible, true);
  assert.equal(evaluate(101).eligible, false);
  assert.match(
    evaluate(101).reasons.join("\n"),
    /exceeded its absolute 100 allowed-overhead budget/
  );
  assert.equal(evaluate(100, true).eligible, false);
  assert.match(
    evaluate(100, true).reasons.join("\n"),
    /wallMicrosecondsPerOperation regressed beyond 2×MAD/
  );
});

test("an absolute budget cannot suppress the independent row-scaling proof", () => {
  const oneRowWorkload = "budget-one-row";
  const manyRowWorkload = "budget-many-row";
  const budgetTargets = [oneRowWorkload, manyRowWorkload].flatMap(
    (selectedWorkload) => [
      {
        provider: "sqlite3",
        workload: selectedWorkload,
        stage: "full",
        mode: "alloc",
      },
      {
        provider: "sqlite3",
        workload: selectedWorkload,
        stage: "full",
        mode: "cpu",
      },
    ]
  );
  const comparison = (selectedWorkload, absolute) => ({
    provider: "sqlite3",
    workload: selectedWorkload,
    stage: "full",
    mode: "alloc",
    deltas: {
      allocatedBytesPerOperation: {
        absolute,
        percent: 20,
        twoMadThreshold: 1,
        significantImprovement: false,
        significantRegression: true,
      },
      allocatedBytesPerRow: {
        absolute,
        percent: 20,
        significantImprovement: false,
        significantRegression: true,
      },
    },
  });
  const gate = evaluateKeepGate({
    smoke: false,
    hasOverrides: false,
    targets: budgetTargets,
    declaredTargets: [],
    declaredBudgets: [oneRowWorkload, manyRowWorkload].map(
      (selectedWorkload) => ({
        provider: "sqlite3",
        workload: selectedWorkload,
        stage: "full",
        mode: "alloc",
        metric: "allocatedBytesPerOperation",
        limit: { kind: "absolute", maximum: 100 },
      })
    ),
    rowScalings: [
      {
        provider: "sqlite3",
        oneRowWorkload,
        manyRowWorkload,
        stage: "full",
        mode: "alloc",
        metric: "allocatedBytesPerOperation",
      },
    ],
    comparisons: [
      comparison(oneRowWorkload, 10),
      {
        provider: "sqlite3",
        workload: oneRowWorkload,
        stage: "full",
        mode: "cpu",
        deltas: {},
      },
      comparison(manyRowWorkload, 20),
      {
        provider: "sqlite3",
        workload: manyRowWorkload,
        stage: "full",
        mode: "cpu",
        deltas: {},
      },
    ],
  });

  assert.equal(gate.eligible, false);
  assert.match(gate.reasons.join("\n"), /added row-scaled overhead/);
  assert.equal(
    gate.reasons.some((reason) => reason.includes("regressed beyond 2×MAD")),
    false
  );
});

test("an absolute budget still requires full allocation and CPU evidence", () => {
  const gate = evaluateKeepGate({
    smoke: false,
    hasOverrides: false,
    targets: [
      { provider: "sqlite3", workload, stage: "full", mode: "alloc" },
    ],
    declaredTargets: [],
    declaredBudgets: [
      {
        provider: "sqlite3",
        workload,
        stage: "full",
        mode: "alloc",
        metric: "allocatedBytesPerOperation",
        limit: { kind: "absolute", maximum: 100 },
      },
    ],
    comparisons: [
      {
        provider: "sqlite3",
        workload,
        stage: "full",
        mode: "alloc",
        deltas: {
          allocatedBytesPerOperation: {
            absolute: 50,
            percent: 20,
            significantImprovement: false,
            significantRegression: true,
          },
        },
      },
    ],
  });
  assert.equal(gate.eligible, false);
  assert.match(
    gate.reasons.join("\n"),
    /missing corresponding full\/cpu evidence/
  );
});

test("a percentage budget covers significant overhead only within its cap", () => {
  const evaluate = (percent) =>
    evaluateKeepGate({
      smoke: false,
      hasOverrides: false,
      targets: [
        { provider: "sqlite3", workload, stage: "full", mode: "alloc" },
        { provider: "sqlite3", workload, stage: "full", mode: "cpu" },
      ],
      declaredTargets: [],
      declaredBudgets: [
        {
          provider: "sqlite3",
          workload,
          stage: "full",
          mode: "alloc",
          metric: "allocatedBytesPerOperation",
          limit: { kind: "percent", maximum: 8 },
        },
      ],
      comparisons: [
        {
          provider: "sqlite3",
          workload,
          stage: "full",
          mode: "alloc",
          deltas: {
            allocatedBytesPerOperation: {
              absolute: 100,
              percent,
              significantImprovement: false,
              significantRegression: true,
            },
            allocatedBytesPerRow: {
              absolute: 10,
              percent,
              significantImprovement: false,
              significantRegression: true,
            },
          },
        },
        {
          provider: "sqlite3",
          workload,
          stage: "full",
          mode: "cpu",
          deltas: {},
        },
      ],
    });

  assert.equal(evaluate(8).eligible, true);
  assert.equal(evaluate(8.01).eligible, false);
  assert.match(
    evaluate(8.01).reasons.join("\n"),
    /exceeded its percent 8 allowed-overhead budget/
  );
  assert.equal(evaluate(null).eligible, false);
  assert.match(
    evaluate(null).reasons.join("\n"),
    /exceeded its percent 8 allowed-overhead budget/
  );
});

test("a strict ceiling can reject a metric whose allowed-overhead budget passes", () => {
  const gate = evaluateKeepGate({
    smoke: false,
    hasOverrides: false,
    targets: [
      { provider: "sqlite3", workload, stage: "full", mode: "alloc" },
      { provider: "sqlite3", workload, stage: "full", mode: "cpu" },
    ],
    declaredTargets: [],
    declaredCeilings: [
      {
        provider: "sqlite3",
        workload,
        stage: "full",
        mode: "alloc",
        metric: "allocatedBytesPerOperation",
        maximumPercent: 5,
      },
    ],
    declaredBudgets: [
      {
        provider: "sqlite3",
        workload,
        stage: "full",
        mode: "alloc",
        metric: "allocatedBytesPerOperation",
        limit: { kind: "percent", maximum: 10 },
      },
    ],
    comparisons: [
      {
        provider: "sqlite3",
        workload,
        stage: "full",
        mode: "alloc",
        deltas: {
          allocatedBytesPerOperation: {
            absolute: 50,
            percent: 7,
            significantImprovement: false,
            significantRegression: false,
          },
        },
      },
      {
        provider: "sqlite3",
        workload,
        stage: "full",
        mode: "cpu",
        deltas: {},
      },
    ],
  });

  assert.equal(gate.eligible, false);
  assert.match(gate.reasons.join("\n"), /exceeded its 5% ceiling/);
});

test("row scaling accepts only the shared per-operation metric surface", () => {
  assert.equal(
    isPerOperationMetric("alloc", "allocatedBytesPerOperation"),
    true
  );
  assert.equal(isPerOperationMetric("alloc", "allocatedBytesPerRow"), false);
  assert.equal(
    isPerOperationMetric("cpu", "cpuMicrosecondsPerOperation"),
    true
  );
  assert.equal(isPerOperationMetric("cpu", "responseBytesPerRow"), false);
});

test("diagnostic mode uses reduced row-scaled counts and can never authorize a keep", () => {
  assert.deepEqual(diagnosticMeasurementCounts(1, "alloc"), {
    iterations: 1000,
    warmupIterations: 200,
  });
  assert.deepEqual(diagnosticMeasurementCounts(100, "cpu"), {
    iterations: 200,
    warmupIterations: 40,
  });
  assert.deepEqual(diagnosticMeasurementCounts(1000, "retained"), {
    iterations: 10,
    warmupIterations: 10,
  });

  const gate = evaluateKeepGate({
    smoke: false,
    diagnosticOnly: true,
    hasOverrides: false,
    targets: [],
    declaredTargets: [],
    comparisons: [],
  });
  assert.equal(gate.eligible, false);
  assert.match(gate.reasons.join("\n"), DIAGNOSTIC_MODE_PATTERN);
});

test("a ceiling contract requires both its percentage and 2×MAD bounds", () => {
  const ceilingTargets = [
    { workload, stage: "full", mode: "alloc" },
    { workload, stage: "full", mode: "cpu" },
  ];
  const comparison = (percent, significantRegression) => [
    {
      workload,
      stage: "full",
      mode: "alloc",
      deltas: {
        allocatedBytesPerOperation: {
          absolute: percent,
          percent,
          twoMadThreshold: 4,
          significantImprovement: false,
          significantRegression,
        },
      },
    },
    {
      workload,
      stage: "full",
      mode: "cpu",
      deltas: {},
    },
  ];
  const evaluate = (percent, significantRegression) =>
    evaluateKeepGate({
      smoke: false,
      hasOverrides: false,
      targets: ceilingTargets,
      declaredTargets: [],
      declaredCeilings: [
        {
          workload,
          stage: "full",
          mode: "alloc",
          metric: "allocatedBytesPerOperation",
          maximumPercent: 3,
        },
      ],
      comparisons: comparison(percent, significantRegression),
      workloads,
    });

  assert.equal(evaluate(2.9, false).eligible, true);
  assert.equal(evaluate(3.1, false).eligible, false);
  assert.equal(evaluate(2.9, true).eligible, false);
});

test("row-scaling rejects overhead that grows beyond combined 2×MAD", () => {
  const oneRowWorkload = "one-row";
  const manyRowWorkload = "many-row";
  const scalingTargets = [oneRowWorkload, manyRowWorkload].flatMap(
    (selectedWorkload) => [
      { workload: selectedWorkload, stage: "full", mode: "alloc" },
      { workload: selectedWorkload, stage: "full", mode: "cpu" },
    ]
  );
  const makeComparison = (selectedWorkload, absolute) => ({
    workload: selectedWorkload,
    stage: "full",
    mode: "alloc",
    deltas: {
      allocatedBytesPerOperation: {
        absolute,
        percent: 1,
        twoMadThreshold: 3,
        significantImprovement: false,
        significantRegression: false,
      },
    },
  });
  const evaluate = (manyAbsolute) =>
    evaluateKeepGate({
      smoke: false,
      hasOverrides: false,
      targets: scalingTargets,
      declaredTargets: [],
      declaredCeilings: [oneRowWorkload, manyRowWorkload].map(
        (selectedWorkload) => ({
          workload: selectedWorkload,
          stage: "full",
          mode: "alloc",
          metric: "allocatedBytesPerOperation",
          maximumPercent: 3,
        })
      ),
      rowScalings: [
        {
          oneRowWorkload,
          manyRowWorkload,
          stage: "full",
          mode: "alloc",
          metric: "allocatedBytesPerOperation",
        },
      ],
      comparisons: [
        makeComparison(oneRowWorkload, 10),
        { workload: oneRowWorkload, stage: "full", mode: "cpu", deltas: {} },
        makeComparison(manyRowWorkload, manyAbsolute),
        { workload: manyRowWorkload, stage: "full", mode: "cpu", deltas: {} },
      ],
      workloads: {
        [oneRowWorkload]: { stages: ["full"] },
        [manyRowWorkload]: { stages: ["full"] },
      },
    });

  assert.equal(evaluate(16).eligible, true);
  assert.equal(evaluate(17).eligible, false);
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

test("the extension overhead matrix is explicit and limited to public full workloads", () => {
  assert.deepEqual(EXTENSION_ARMS, [
    "unextended",
    "request",
    "query",
    "statement",
    "observe",
    "client",
    "model",
  ]);
  for (const selectedWorkload of [
    "scalar-find-many-1",
    "scalar-find-many-1000",
    "flat-create-explicit-id",
    "fixed-rowref-create",
    "atomic-batch-100",
  ]) {
    assert.equal(WORKLOADS[selectedWorkload]?.extensionProof, true);
    assert.ok(WORKLOADS[selectedWorkload]?.stages.includes("full"));
  }
  assert.equal(WORKLOADS["wide-scalar-select-1"]?.extensionProof, false);
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
  for (const rows of [1, 20, 1000, 10_000]) {
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
        measurement: retainedMeasurement(-1030),
      },
    })),
    ...Array.from({ length: 5 }, (_, replicate) => ({
      ...target,
      checkout: "candidate",
      replicate,
      output: {
        semanticDigest: "same-result",
        witness: {},
        measurement: retainedMeasurement(-2949),
      },
    })),
  ];

  const comparison = aggregateTarget(target, samples);
  assert.equal(comparison.deltas.retainedBytesPerOperation.absolute, -1919);
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
      reason.includes("cpu/cpuMicrosecondsPerOperation regressed beyond 2×MAD")
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
  assert.match(gate.reasons.join("\n"), D1_MIXED_SCALAR_PATTERN);
});
