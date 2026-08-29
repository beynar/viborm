import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertEvidenceProgramCommits,
  CROSS_PROVIDER_BASELINE_COMMIT,
  defaultMeasurementIterations,
  EXTENSION_ARMS,
  FIXED_DECIMAL_BASELINE_COMMIT,
  PROVIDERS,
  resolveEvidenceProgram,
  WORKLOADS,
} from "./operation-pipeline-catalog.mjs";
import {
  findProtocolOverlayImplementationPaths,
  PROTOCOL_PATHS,
  protocolSha256,
} from "./operation-pipeline-protocol.mjs";
import { providerRows } from "./operation-pipeline-provider-fixtures.mjs";
import {
  constructAndRetainFixedDecimalFloor,
  constructFixedDecimalFloorValues,
  consumeAndRetainFixedDecimalResult,
  retainsFixedDecimalResult,
} from "./operation-pipeline-provider-workloads.mjs";
import {
  aggregateCandidateTarget,
  aggregateTarget,
  catalogRegressionCeilings,
  checkoutOrder,
  diagnosticMeasurementCounts,
  evaluateFixedDecimalCandidateGate,
  evaluateKeepGate,
  isExactFixedDecimalLockDelta,
  isPerOperationMetric,
  measuredFields,
  parseDeclaredBudgets,
  verifyCrossStageSemantics,
} from "./operation-pipeline-report.mjs";

const DID_NOT_IMPROVE_PATTERN = /did not improve by more than 2×MAD/;
const NO_TARGET_PATTERN = /No target, ceiling, or budget metric contract/;
const REPLICATE_CHECKSUM_DRIFT_PATTERN =
  /sqlite3\/scalar-find-unique\/full\/cpu changed semantic checksum across replicates/;
const MODE_CHECKSUM_DRIFT_PATTERN =
  /sqlite3\/scalar-find-unique\/full\/baseline changed semantic checksum across modes/;
const D1_MIXED_SCALAR_PATTERN = /d1\/provider-mixed-scalar-20/;
const DIAGNOSTIC_MODE_PATTERN = /Diagnostic mode/;
const INVALID_BUDGET_CONTRACT_PATTERN =
  /Invalid --budget .* expected provider\/workload\/stage\/mode\/metric\/\(absolute\|percent\)\/non-negative-maximum/;
const DUPLICATE_BUDGET_PATTERN = /Duplicate --budget metric contract/;
const ALLOCATION_ROW_BUDGET_PATTERN =
  /Budget metric allocatedBytesPerRow is not a per-operation metric measured in alloc mode/;
const ALLOCATION_CPU_BUDGET_PATTERN =
  /Budget metric cpuMicrosecondsPerOperation is not a per-operation metric measured in alloc mode/;
const INVALID_BUDGET_PATTERN = /Invalid --budget/;
const ABSOLUTE_BUDGET_PATTERN =
  /exceeded its absolute 100 allowed-overhead budget/;
const WALL_REGRESSION_PATTERN =
  /wallMicrosecondsPerOperation regressed beyond 2×MAD/;
const ROW_SCALING_PATTERN = /added row-scaled overhead/;
const FULL_CPU_EVIDENCE_PATTERN = /missing corresponding full\/cpu evidence/;
const PERCENT_BUDGET_PATTERN = /exceeded its percent 8 allowed-overhead budget/;
const FIVE_PERCENT_CEILING_PATTERN = /exceeded its 5% ceiling/;
const FIXED_DECIMAL_CEILING_PATTERN = /3% ceiling or 2×MAD/;
const MIXED_EVIDENCE_PROGRAM_PATTERN = /mixes evidence programs/;
const MISSING_FIXED_DECIMAL_EVIDENCE_PATTERN = /missing fixed-decimal evidence/;
const FIXED_DECIMAL_BASELINE_PATTERN =
  /requires baseline 1d796d4e01841becfbb2f6805668ef11d270aa0e/;
const CANDIDATE_PROTOCOL_COMMIT_PATTERN =
  /must run from candidate protocol commit/;
const COMPARE_SCRIPT = fileURLToPath(
  new URL("./operation-pipeline-compare.mjs", import.meta.url)
);

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
    INVALID_BUDGET_CONTRACT_PATTERN
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
    DUPLICATE_BUDGET_PATTERN
  );
  assert.throws(
    () =>
      parseDeclaredBudgets(
        [
          "sqlite3/scalar-find-unique/full/alloc/allocatedBytesPerRow/absolute/10",
        ],
        budgetWorkloads
      ),
    ALLOCATION_ROW_BUDGET_PATTERN
  );
  assert.throws(
    () =>
      parseDeclaredBudgets(
        [
          "sqlite3/scalar-find-unique/full/alloc/cpuMicrosecondsPerOperation/absolute/10",
        ],
        budgetWorkloads
      ),
    ALLOCATION_CPU_BUDGET_PATTERN
  );
  assert.throws(
    () =>
      parseDeclaredBudgets(
        [
          "sqlite3/scalar-find-unique/full/alloc/allocatedBytesPerOperation/ratio/10",
        ],
        budgetWorkloads
      ),
    INVALID_BUDGET_PATTERN
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
  assert.match(evaluate(101).reasons.join("\n"), ABSOLUTE_BUDGET_PATTERN);
  assert.equal(evaluate(100, true).eligible, false);
  assert.match(evaluate(100, true).reasons.join("\n"), WALL_REGRESSION_PATTERN);
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
  assert.match(gate.reasons.join("\n"), ROW_SCALING_PATTERN);
  assert.equal(
    gate.reasons.some((reason) => reason.includes("regressed beyond 2×MAD")),
    false
  );
});

test("an absolute budget still requires full allocation and CPU evidence", () => {
  const gate = evaluateKeepGate({
    smoke: false,
    hasOverrides: false,
    targets: [{ provider: "sqlite3", workload, stage: "full", mode: "alloc" }],
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
  assert.match(gate.reasons.join("\n"), FULL_CPU_EVIDENCE_PATTERN);
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
  assert.match(evaluate(8.01).reasons.join("\n"), PERCENT_BUDGET_PATTERN);
  assert.equal(evaluate(null).eligible, false);
  assert.match(evaluate(null).reasons.join("\n"), PERCENT_BUDGET_PATTERN);
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
  assert.match(gate.reasons.join("\n"), FIVE_PERCENT_CEILING_PATTERN);
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
  assert.deepEqual(
    diagnosticMeasurementCounts({ rowsPerOperation: 1 }, "alloc"),
    {
      iterations: 1000,
      warmupIterations: 200,
    }
  );
  assert.deepEqual(
    diagnosticMeasurementCounts({ rowsPerOperation: 100 }, "cpu"),
    {
      iterations: 200,
      warmupIterations: 40,
    }
  );
  assert.deepEqual(
    diagnosticMeasurementCounts({ rowsPerOperation: 1000 }, "retained"),
    {
      iterations: 10,
      warmupIterations: 10,
    }
  );

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

test("fixed-decimal retained diagnostics use equal operation counts", () => {
  const one = WORKLOADS["provider-fixed-decimal-row-1"];
  const thousand = WORKLOADS["provider-fixed-decimal-row-1000"];
  assert.deepEqual(diagnosticMeasurementCounts(one, "retained"), {
    iterations: 10,
    warmupIterations: 10,
  });
  assert.deepEqual(diagnosticMeasurementCounts(thousand, "retained"), {
    iterations: 10,
    warmupIterations: 10,
  });
  assert.deepEqual(
    diagnosticMeasurementCounts({ rowsPerOperation: 1 }, "retained"),
    {
      iterations: 100,
      warmupIterations: 20,
    }
  );
});

test("fixed-decimal retained arms compare cardinalities after equal operation counts", () => {
  const one = WORKLOADS["provider-fixed-decimal-row-1"];
  const thousand = WORKLOADS["provider-fixed-decimal-row-1000"];
  assert.equal(defaultMeasurementIterations(one, "retained", false), 20);
  assert.equal(defaultMeasurementIterations(thousand, "retained", false), 20);
  assert.equal(defaultMeasurementIterations(one, "alloc", false), 5000);
  assert.equal(defaultMeasurementIterations(thousand, "alloc", false), 100);
  assert.equal(defaultMeasurementIterations(one, "retained", true), 2);
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

test("protocol overlays classify package build configuration as implementation", () => {
  assert.equal(PROTOCOL_PATHS.includes("tsdown.config.ts"), false);
  assert.deepEqual(
    findProtocolOverlayImplementationPaths([
      "benchmarks/operation-pipeline-catalog.mjs",
      "tsdown.config.ts",
    ]),
    ["tsdown.config.ts"]
  );
});

test("package build configuration differences do not change protocol identity", () => {
  const sharedContents = Object.fromEntries(
    PROTOCOL_PATHS.map((path) => [path, Buffer.from(`fixture:${path}`)])
  );
  const baselineContents = {
    ...sharedContents,
    "tsdown.config.ts": Buffer.from("baseline build configuration"),
  };
  const candidateContents = {
    ...sharedContents,
    "tsdown.config.ts": Buffer.from("candidate build configuration"),
  };

  assert.equal(
    protocolSha256((path) => baselineContents[path]),
    protocolSha256((path) => candidateContents[path])
  );
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

test("pairwise checksum agreement cannot hide drift across modes", () => {
  const samples = ["alloc", "cpu", "retained"].flatMap((mode) =>
    ["baseline", "candidate"].map((checkout) => ({
      checkout,
      workload,
      stage: "full",
      mode,
      output: {
        iterations: mode === "retained" ? 10 : 100,
        semanticDigest: "same-complete-result",
        measurement: { checksum: mode === "retained" ? 100 : 1000 },
      },
    }))
  );

  assert.doesNotThrow(() => verifyCrossStageSemantics(samples));
  for (const sample of samples) {
    if (sample.mode === "retained") sample.output.measurement.checksum = 200;
  }
  assert.throws(
    () => verifyCrossStageSemantics(samples),
    MODE_CHECKSUM_DRIFT_PATTERN
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
    assert.equal(
      WORKLOADS[`provider-mixed-scalar-${rows}`].comparison,
      "candidate-only"
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

test("provider decimal fixtures retain logical and SQLite coefficient values", () => {
  const [row] = providerRows(1);
  assert.equal(row.amount, "1.125");
  assert.equal(row.amountCoefficient, 1125);
});

test("fixed-decimal evidence admits only the pinned decimal.js lockfile delta", () => {
  const baseline =
    "dependencies:\n      commander: present\npackages:\nsnapshots:\n";
  assert.equal(isExactFixedDecimalLockDelta(baseline, baseline), false);
  const candidate = baseline
    .replace(
      "      commander: present\n",
      "      commander: present\n      decimal.js:\n        specifier: 10.6.0\n        version: 10.6.0\n"
    )
    .replace(
      "packages:\n",
      "packages:\n\n  decimal.js@10.6.0:\n    resolution: {integrity: sha512-YpgQiITW3JXGntzdUmyUR1V812Hn8T1YVXhCu+wO3OpS4eU9l4YdD3qjyiKdV6mvV29zapkMeD390UVEf2lkUg==}\n"
    )
    .replace("snapshots:\n", "snapshots:\n\n  decimal.js@10.6.0: {}\n");
  assert.equal(isExactFixedDecimalLockDelta(baseline, candidate), true);
  assert.equal(
    isExactFixedDecimalLockDelta(
      baseline,
      candidate.replace("version: 10.6.0", "version: 10.6.1")
    ),
    false
  );
  assert.equal(
    isExactFixedDecimalLockDelta(baseline, `${candidate}other: changed\n`),
    false
  );
});

test("fixed-decimal evidence separates the scalar A/B control from candidate-only decimal work", () => {
  const providers = ["sqlite3", "pglite", "mysql2"];
  const scalarControl = WORKLOADS["provider-fixed-decimal-scalar-control"];
  assert.equal(scalarControl.comparison, "baseline-candidate");
  assert.equal(scalarControl.regressionCeilingPercent, 3);
  assert.deepEqual(scalarControl.providers, providers);

  for (const [name, rows] of [
    ["provider-fixed-decimal-row-1", 1],
    ["provider-fixed-decimal-row-1000", 1000],
    ["provider-fixed-decimal-arithmetic", 1],
    ["provider-fixed-decimal-aggregate", 1],
    ["provider-fixed-decimal-list", 1],
  ]) {
    const definition = WORKLOADS[name];
    assert.equal(definition.comparison, "candidate-only");
    assert.equal(definition.rowsPerOperation, rows);
    assert.deepEqual(definition.providers, providers);
    assert.ok(definition.stages.includes("full"));
  }
  for (const rows of [1, 1000]) {
    assert.equal(
      WORKLOADS[`provider-fixed-decimal-text-row-${rows}`].comparison,
      "candidate-only"
    );
    assert.deepEqual(WORKLOADS[`provider-fixed-decimal-floor-${rows}`].stages, [
      "decimal-construct",
    ]);
    assert.deepEqual(
      WORKLOADS[`provider-fixed-decimal-row-${rows}`].fixedDecimalAttribution,
      {
        textControlWorkload: `provider-fixed-decimal-text-row-${rows}`,
        constructorFloorWorkload: `provider-fixed-decimal-floor-${rows}`,
      }
    );
  }
});

test("provider evidence programs select one exact baseline and refuse mixed programs", () => {
  assert.equal(
    FIXED_DECIMAL_BASELINE_COMMIT,
    "1d796d4e01841becfbb2f6805668ef11d270aa0e"
  );
  assert.deepEqual(
    resolveEvidenceProgram(["provider-wide-scalar-100"], WORKLOADS),
    {
      name: "provider-transport",
      baselineCommit: CROSS_PROVIDER_BASELINE_COMMIT,
      lockfileComparison: "identical",
      requiredProviders: [],
    }
  );
  assert.deepEqual(
    resolveEvidenceProgram(
      ["provider-fixed-decimal-scalar-control"],
      WORKLOADS
    ),
    {
      name: "fixed-decimal",
      baselineCommit: FIXED_DECIMAL_BASELINE_COMMIT,
      lockfileComparison: "fixed-decimal-dependency-only",
      requiredProviders: ["sqlite3", "pglite"],
    }
  );
  assert.throws(
    () =>
      resolveEvidenceProgram(
        ["provider-wide-scalar-100", "provider-fixed-decimal-scalar-control"],
        WORKLOADS
      ),
    MIXED_EVIDENCE_PROGRAM_PATTERN
  );
  assert.throws(
    () => resolveEvidenceProgram(undefined, WORKLOADS),
    MIXED_EVIDENCE_PROGRAM_PATTERN
  );
});

test("fixed-decimal protocol overlays retain the exact source baseline", () => {
  const fixedProgram = resolveEvidenceProgram(
    ["provider-fixed-decimal-scalar-control"],
    WORKLOADS
  );
  assert.doesNotThrow(() =>
    assertEvidenceProgramCommits(fixedProgram, {
      baselineCommit: FIXED_DECIMAL_BASELINE_COMMIT,
      candidateCommit: "candidate",
      coordinatorCommit: "candidate",
    })
  );
  assert.throws(
    () =>
      assertEvidenceProgramCommits(fixedProgram, {
        baselineCommit: CROSS_PROVIDER_BASELINE_COMMIT,
        candidateCommit: "candidate",
        coordinatorCommit: "candidate",
      }),
    FIXED_DECIMAL_BASELINE_PATTERN
  );
  assert.throws(
    () =>
      assertEvidenceProgramCommits(fixedProgram, {
        baselineCommit: "protocol-overlay-head",
        candidateCommit: "candidate",
        coordinatorCommit: "candidate",
      }),
    FIXED_DECIMAL_BASELINE_PATTERN
  );
  assert.throws(
    () =>
      assertEvidenceProgramCommits(fixedProgram, {
        baselineCommit: FIXED_DECIMAL_BASELINE_COMMIT,
        candidateCommit: "candidate",
        coordinatorCommit: "stale-protocol",
      }),
    CANDIDATE_PROTOCOL_COMMIT_PATTERN
  );
});

function summary(median, mad = 1) {
  return { median, mad, min: median - mad, max: median + mad };
}

function candidateMetricSet(mode, value, rowsPerOperation) {
  if (mode === "alloc") {
    return {
      allocatedBytesPerOperation: summary(value),
      allocatedBytesPerRow: summary(value / rowsPerOperation),
    };
  }
  if (mode === "cpu") {
    return {
      cpuMicrosecondsPerOperation: summary(value),
      wallMicrosecondsPerOperation: summary(value),
    };
  }
  return {
    retainedBytesPerOperation: summary(0),
    retainedBytesPerRow: summary(0),
    releasedBytesPerOperation: summary(value),
    releasedBytesPerRow: summary(value / rowsPerOperation),
    peakRssBytes: summary(100_000),
    peakRssGrowthBytes: summary(10_000),
  };
}

function completeFixedDecimalMeasurements(provider = "sqlite3") {
  const measurements = [];
  for (const [workloadName, definition] of Object.entries(WORKLOADS)) {
    if (definition.evidenceProgram !== "fixed-decimal") continue;
    const stage =
      definition.providerShape.kind === "fixed-decimal-floor"
        ? "decimal-construct"
        : "full";
    for (const mode of ["alloc", "cpu", "retained"]) {
      const rows = definition.rowsPerOperation;
      const isFloor = definition.providerShape.kind === "fixed-decimal-floor";
      const isText = definition.providerShape.kind === "fixed-decimal-text-row";
      const base = isFloor
        ? 10 * rows
        : isText
          ? 100 * rows
          : mode === "retained"
            ? 110 * rows
            : 120 * rows;
      measurements.push({
        provider,
        workload: workloadName,
        stage,
        mode,
        ...(definition.comparison === "baseline-candidate"
          ? {
              byCheckout: {
                baseline: { metrics: candidateMetricSet(mode, base, rows) },
                candidate: { metrics: candidateMetricSet(mode, base, rows) },
              },
            }
          : { metrics: candidateMetricSet(mode, base, rows) }),
      });
      if (
        mode !== "retained" &&
        (definition.providerShape.kind === "fixed-decimal-row" ||
          definition.providerShape.kind === "fixed-decimal-text-row")
      ) {
        const providerBase = isText ? 50 * rows : 60 * rows;
        measurements.push({
          provider,
          workload: workloadName,
          stage: "provider-execute",
          mode,
          metrics: candidateMetricSet(mode, providerBase, rows),
        });
      }
    }
  }
  return measurements;
}

test("fixed-decimal candidate evidence gates attribution and row scaling without synthetic baselines", () => {
  const measurements = completeFixedDecimalMeasurements();
  const gate = evaluateFixedDecimalCandidateGate({
    providers: ["sqlite3"],
    measurements,
    workloads: WORKLOADS,
  });
  assert.equal(gate.eligible, true);
  assert.equal(gate.attribution.length, 14);
  assert.equal(gate.rowScaling.length, 7);
  assert.ok(
    gate.attribution.every(
      (metric) =>
        metric.baseline === undefined && metric.syntheticBaseline === undefined
    )
  );
  const retained = gate.attribution.find(
    (metric) =>
      metric.cardinality === 1 && metric.metric === "retainedBytesPerOperation"
  );
  assert.equal(retained.tenPercentLimit, null);
  assert.equal(retained.percentageApplied, false);
  assert.equal(retained.formula, "decimal - text-control - constructor-floor");
  assert.equal(retained.providerDelta, undefined);
  const released = gate.attribution.find(
    (metric) =>
      metric.cardinality === 1 && metric.metric === "releasedBytesPerOperation"
  );
  assert.equal(
    released.formula,
    "decimal - text-control - constructor-floor"
  );
  assert.equal(released.providerDelta, undefined);
  assert.ok(
    gate.attribution.some((metric) => metric.metric === "peakRssBytes")
  );
  assert.ok(
    gate.attribution.some((metric) => metric.metric === "peakRssGrowthBytes")
  );
  const allocation = gate.attribution.find(
    (metric) =>
      metric.cardinality === 1 &&
      metric.metric === "allocatedBytesPerOperation"
  );
  assert.equal(
    allocation.formula,
    "decimal-full - text-full - (decimal-provider-execute - text-provider-execute) - constructor-floor"
  );
  assert.deepEqual(allocation.providerDelta, {
    stage: "provider-execute",
    decimal: summary(60),
    textControl: summary(50),
    median: 10,
    twoMadThreshold: 4,
  });

  const pathological = completeFixedDecimalMeasurements();
  const decimalThousandAllocation = pathological.find(
    (measurement) =>
      measurement.workload === "provider-fixed-decimal-row-1000" &&
      measurement.stage === "full" &&
      measurement.mode === "alloc"
  );
  decimalThousandAllocation.metrics.allocatedBytesPerOperation = summary(
    140 * 1000,
    1000
  );
  assert.equal(
    evaluateFixedDecimalCandidateGate({
      providers: ["sqlite3"],
      measurements: pathological,
      workloads: WORKLOADS,
    }).eligible,
    false
  );

  const zeroFloor = completeFixedDecimalMeasurements();
  for (const rows of [1, 1000]) {
    const floor = zeroFloor.find(
      (measurement) =>
        measurement.workload === `provider-fixed-decimal-floor-${rows}` &&
        measurement.mode === "alloc"
    );
    floor.metrics.allocatedBytesPerOperation = summary(0);
    floor.metrics.allocatedBytesPerRow = summary(0);
    const decimal = zeroFloor.find(
      (measurement) =>
        measurement.workload === `provider-fixed-decimal-row-${rows}` &&
        measurement.stage === "full" &&
        measurement.mode === "alloc"
    );
    decimal.metrics.allocatedBytesPerOperation = summary(100 * rows);
    decimal.metrics.allocatedBytesPerRow = summary(100);
  }
  const zeroFloorGate = evaluateFixedDecimalCandidateGate({
    providers: ["sqlite3"],
    measurements: zeroFloor,
    workloads: WORKLOADS,
  });
  assert.equal(zeroFloorGate.eligible, true);
  assert.equal(
    zeroFloorGate.attribution.find(
      (metric) =>
        metric.cardinality === 1 &&
        metric.metric === "allocatedBytesPerOperation"
    ).percentageApplied,
    false
  );
  assert.equal(
    zeroFloorGate.rowScaling.find(
      (metric) => metric.metric === "allocatedBytesPerOperation"
    ).percentageApplied,
    false
  );

  const missingFloor = measurements.filter(
    (measurement) =>
      !(
        measurement.workload === "provider-fixed-decimal-floor-1000" &&
        measurement.mode === "alloc"
      )
  );
  const incomplete = evaluateFixedDecimalCandidateGate({
    providers: ["sqlite3"],
    measurements: missingFloor,
    workloads: WORKLOADS,
  });
  assert.equal(incomplete.eligible, false);
  assert.match(
    incomplete.reasons.join("\n"),
    MISSING_FIXED_DECIMAL_EVIDENCE_PATTERN
  );

  const missingProviderDelta = measurements.filter(
    (measurement) =>
      !(
        measurement.workload === "provider-fixed-decimal-row-1000" &&
        measurement.stage === "provider-execute" &&
        measurement.mode === "cpu"
      )
  );
  const missingProviderGate = evaluateFixedDecimalCandidateGate({
    providers: ["sqlite3"],
    measurements: missingProviderDelta,
    workloads: WORKLOADS,
  });
  assert.equal(missingProviderGate.eligible, false);
  assert.match(
    missingProviderGate.reasons.join("\n"),
    /provider-fixed-decimal-row-1000\/provider-execute\/cpu is missing fixed-decimal evidence/
  );

  const scalarOnly = measurements.filter(
    (measurement) =>
      measurement.workload === "provider-fixed-decimal-scalar-control"
  );
  assert.equal(
    evaluateFixedDecimalCandidateGate({
      providers: ["sqlite3"],
      measurements: scalarOnly,
      workloads: WORKLOADS,
    }).eligible,
    false
  );
});

test("fixed-decimal retained attribution is signed but acceptance is one-sided", () => {
  const measurements = completeFixedDecimalMeasurements();
  const decimalThousandRetained = measurements.find(
    (measurement) =>
      measurement.workload === "provider-fixed-decimal-row-1000" &&
      measurement.stage === "full" &&
      measurement.mode === "retained"
  );
  decimalThousandRetained.metrics.retainedBytesPerOperation = summary(
    -1_000_000,
    0
  );

  const gate = evaluateFixedDecimalCandidateGate({
    providers: ["sqlite3"],
    measurements,
    workloads: WORKLOADS,
  });
  const retainedAttribution = gate.attribution.find(
    (entry) =>
      entry.cardinality === 1000 && entry.metric === "retainedBytesPerOperation"
  );
  const retainedScaling = gate.rowScaling.find(
    (entry) => entry.metric === "retainedBytesPerOperation"
  );
  assert.equal(gate.eligible, true);
  assert.equal(retainedAttribution.excessMedian, -1_000_000);
  assert.equal(retainedAttribution.passedNoise, true);
  assert.equal(retainedScaling.scaledExcess, -1_000_000);
  assert.equal(retainedScaling.passedNoise, true);

  decimalThousandRetained.metrics.retainedBytesPerOperation = summary(
    1_000_000,
    0
  );
  const regression = evaluateFixedDecimalCandidateGate({
    providers: ["sqlite3"],
    measurements,
    workloads: WORKLOADS,
  });
  assert.equal(regression.eligible, false);
  assert.equal(
    regression.attribution.find(
      (entry) =>
        entry.cardinality === 1000 &&
        entry.metric === "retainedBytesPerOperation"
    ).passedNoise,
    false
  );
});

test("fixed-decimal retained seams keep the consumed graph and result Decimal family", () => {
  const textRows = [{ id: "record_1", amount: "1.125" }];
  const retainedGraphs = [];
  const textChecksum = consumeAndRetainFixedDecimalResult(
    textRows,
    { kind: "fixed-decimal-text-row" },
    undefined,
    (value) => retainedGraphs.push(value)
  );
  assert.equal(textChecksum, 11);
  assert.equal(retainedGraphs[0], textRows);

  class ResultDecimal {
    constructor(value) {
      this.value = Number(value);
    }

    toNumber() {
      return this.value;
    }
  }

  const floorSink = new Array(2);
  const floorValues = constructFixedDecimalFloorValues(
    ["1.125", "2.125"],
    ResultDecimal,
    floorSink
  );
  assert.equal(floorValues, floorSink);
  assert.equal(floorValues.length, 2);
  assert.ok(floorValues.every((value) => value instanceof ResultDecimal));
  assert.deepEqual(
    floorValues.map((value) => value.toNumber()),
    [1.125, 2.125]
  );

  const decimalRows = [{ id: "record_1", amount: new ResultDecimal("1.125") }];
  const decimalChecksum = consumeAndRetainFixedDecimalResult(
    decimalRows,
    { kind: "fixed-decimal-row" },
    ResultDecimal,
    (value) => retainedGraphs.push(value)
  );
  assert.equal(decimalChecksum, 3.25);
  assert.equal(retainedGraphs[1], decimalRows);

  const arithmeticRow = {
    id: "record_1",
    amount: new ResultDecimal("1.125"),
  };
  const aggregateResult = {
    _min: { amount: new ResultDecimal("1.125") },
    _max: { amount: new ResultDecimal("2.125") },
    _sum: { amount: new ResultDecimal("3.25") },
    _avg: { amount: new ResultDecimal("1.625") },
  };
  const listRows = [
    {
      id: "record_1",
      amounts: [
        new ResultDecimal("1.125"),
        new ResultDecimal("2.125"),
        new ResultDecimal("-0.375"),
      ],
    },
  ];
  for (const [providerShape, publicResult, expectedChecksum] of [
    [{ kind: "fixed-decimal-arithmetic" }, arithmeticRow, 115.125],
    [
      { kind: "fixed-decimal-aggregate", sourceRows: 2 },
      aggregateResult,
      8.125,
    ],
    [{ kind: "fixed-decimal-list" }, listRows, 3.875],
  ]) {
    const retained = [];
    const checksum = consumeAndRetainFixedDecimalResult(
      publicResult,
      providerShape,
      ResultDecimal,
      (value) => retained.push(value)
    );
    assert.equal(checksum, expectedChecksum);
    assert.equal(retained[0], publicResult);
    assert.equal(retainsFixedDecimalResult(providerShape), true);
  }

  assert.equal(retainsFixedDecimalResult({ kind: "mixed-scalar" }), false);

  const retainedDecimals = [];
  const floorChecksum = constructAndRetainFixedDecimalFloor(
    ["1.125", "2.125"],
    ResultDecimal,
    (value) => retainedDecimals.push(value)
  );
  assert.equal(floorChecksum, 5.25);
  assert.equal(retainedDecimals.length, 2);
  assert.ok(retainedDecimals.every((value) => value instanceof ResultDecimal));
});

test("fixed-decimal RSS noise belongs to the selected larger control", () => {
  const measurements = completeFixedDecimalMeasurements();
  const findRetained = (workloadName) =>
    measurements.find(
      (measurement) =>
        measurement.workload === workloadName &&
        measurement.stage ===
          (workloadName.includes("floor") ? "decimal-construct" : "full") &&
        measurement.mode === "retained"
    );
  findRetained("provider-fixed-decimal-text-row-1").metrics.peakRssBytes =
    summary(200, 1);
  findRetained("provider-fixed-decimal-floor-1").metrics.peakRssBytes = summary(
    100,
    100
  );
  findRetained("provider-fixed-decimal-row-1").metrics.peakRssBytes = summary(
    203,
    0
  );

  const gate = evaluateFixedDecimalCandidateGate({
    providers: ["sqlite3"],
    measurements,
    workloads: WORKLOADS,
  });
  const rss = gate.attribution.find(
    (entry) => entry.cardinality === 1 && entry.metric === "peakRssBytes"
  );
  assert.equal(rss.excessMedian, 3);
  assert.equal(rss.twoMadThreshold, 2);
  assert.equal(rss.passedNoise, false);
});

test("fixed-decimal row scaling includes non-additive RSS levels and growth", () => {
  const measurements = completeFixedDecimalMeasurements();
  for (const rows of [1, 1000]) {
    for (const workload of [
      `provider-fixed-decimal-text-row-${rows}`,
      `provider-fixed-decimal-floor-${rows}`,
    ]) {
      const control = measurements.find(
        (measurement) =>
          measurement.workload === workload && measurement.mode === "retained"
      );
      control.metrics.peakRssBytes = summary(200_000, 0);
      control.metrics.peakRssGrowthBytes = summary(20_000, 0);
    }
    const decimal = measurements.find(
      (measurement) =>
        measurement.workload === `provider-fixed-decimal-row-${rows}` &&
        measurement.stage === "full" &&
        measurement.mode === "retained"
    );
    decimal.metrics.peakRssBytes = summary(rows === 1 ? 100_000 : 200_000, 0);
    decimal.metrics.peakRssGrowthBytes = summary(
      rows === 1 ? 10_000 : 20_000,
      0
    );
  }

  const gate = evaluateFixedDecimalCandidateGate({
    providers: ["sqlite3"],
    measurements,
    workloads: WORKLOADS,
  });
  const rssScaling = gate.rowScaling.find(
    (entry) => entry.metric === "peakRssBytes"
  );
  const rssGrowthScaling = gate.rowScaling.find(
    (entry) => entry.metric === "peakRssGrowthBytes"
  );
  assert.equal(gate.eligible, false);
  assert.equal(rssScaling.scaledExcess, 100_000);
  assert.equal(rssScaling.tenPercentLimit, null);
  assert.equal(rssScaling.passed, false);
  assert.equal(rssGrowthScaling.scaledExcess, 10_000);
  assert.equal(rssGrowthScaling.tenPercentLimit, null);
  assert.equal(rssGrowthScaling.passed, false);
});

test("candidate-only targets never schedule or synthesize a baseline comparison", () => {
  assert.deepEqual(checkoutOrder("candidate-only", 0), ["candidate"]);
  assert.deepEqual(checkoutOrder("candidate-only", 4), ["candidate"]);
  assert.deepEqual(checkoutOrder("baseline-candidate", 0), [
    "baseline",
    "candidate",
  ]);
  assert.deepEqual(checkoutOrder("baseline-candidate", 1), [
    "candidate",
    "baseline",
  ]);

  const target = {
    provider: "sqlite3",
    workload: "provider-fixed-decimal-row-1",
    stage: "full",
    mode: "alloc",
  };
  const samples = Array.from({ length: 5 }, (_, replicate) => ({
    ...target,
    checkout: "candidate",
    replicate,
    output: {
      semanticDigest: "fixed-decimal-value",
      witness: { statementCount: 1 },
      measurement: {
        checksum: 7,
        allocatedBytesPerOperation: 100 + replicate,
        allocatedBytesPerRow: 100 + replicate,
      },
    },
  }));
  const measurement = aggregateCandidateTarget(target, samples);
  assert.equal(measurement.checkout, "candidate");
  assert.equal(measurement.metrics.allocatedBytesPerOperation.median, 102);
  assert.equal(Object.hasOwn(measurement, "deltas"), false);
  assert.equal(Object.hasOwn(measurement, "baseline"), false);
});

test("the coordinator rotates linked fixed-decimal attribution arms by replicate", () => {
  const schedule = JSON.parse(
    execFileSync(process.execPath, [COMPARE_SCRIPT, "--schedule-self-check"], {
      encoding: "utf8",
    })
  );
  const scalar = schedule.filter(
    (run) =>
      run.workload === "provider-fixed-decimal-scalar-control" &&
      run.stage === "full" &&
      run.mode === "alloc"
  );
  assert.equal(scalar.length, 10);
  for (let replicate = 0; replicate < 5; replicate++) {
    assert.deepEqual(
      scalar
        .filter((run) => run.replicate === replicate)
        .map((run) => run.checkout),
      replicate % 2 === 0
        ? ["baseline", "candidate"]
        : ["candidate", "baseline"]
    );
  }

  const attribution = schedule.filter(
    (run) =>
      run.workload !== "provider-fixed-decimal-scalar-control" &&
      run.mode === "alloc"
  );
  assert.equal(attribution.length, 50);
  let previousOrder;
  for (let replicate = 0; replicate < 5; replicate++) {
    const cohort = attribution.filter((run) => run.replicate === replicate);
    assert.equal(cohort.length, 10);
    assert.ok(cohort.every((run) => run.checkout === "candidate"));
    const order = cohort.map((run) => `${run.workload}/${run.stage}`);
    assert.equal(new Set(order).size, 10);
    if (previousOrder !== undefined) {
      assert.deepEqual(order, [...previousOrder.slice(1), previousOrder[0]]);
    }
    previousOrder = order;
  }

  const retainedAttribution = schedule.filter(
    (run) =>
      run.workload !== "provider-fixed-decimal-scalar-control" &&
      run.mode === "retained"
  );
  assert.equal(retainedAttribution.length, 30);
  assert.ok(
    retainedAttribution.every((run) => run.stage !== "provider-execute")
  );
});

test("the fixed-decimal scalar control always carries the 3 percent and 2×MAD ceilings", () => {
  const targets = [
    {
      provider: "sqlite3",
      workload: "provider-fixed-decimal-scalar-control",
      stage: "full",
      mode: "alloc",
    },
    {
      provider: "sqlite3",
      workload: "provider-fixed-decimal-scalar-control",
      stage: "full",
      mode: "cpu",
    },
  ];
  assert.deepEqual(catalogRegressionCeilings(targets, WORKLOADS), [
    {
      provider: "sqlite3",
      workload: "provider-fixed-decimal-scalar-control",
      stage: "full",
      mode: "alloc",
      metric: "allocatedBytesPerOperation",
      maximumPercent: 3,
      source: "catalog",
    },
    {
      provider: "sqlite3",
      workload: "provider-fixed-decimal-scalar-control",
      stage: "full",
      mode: "cpu",
      metric: "cpuMicrosecondsPerOperation",
      maximumPercent: 3,
      source: "catalog",
    },
  ]);

  const gate = evaluateKeepGate({
    smoke: false,
    hasOverrides: false,
    targets,
    declaredTargets: [],
    declaredCeilings: catalogRegressionCeilings(targets, WORKLOADS),
    comparisons: [
      {
        ...targets[0],
        deltas: {
          allocatedBytesPerOperation: {
            percent: 2,
            significantImprovement: false,
            significantRegression: true,
          },
        },
      },
      {
        ...targets[1],
        deltas: {
          cpuMicrosecondsPerOperation: {
            percent: 2,
            significantImprovement: false,
            significantRegression: false,
          },
        },
      },
    ],
  });
  assert.equal(gate.eligible, false);
  assert.match(gate.reasons.join("\n"), FIXED_DECIMAL_CEILING_PATTERN);
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
