import assert from "node:assert/strict";
import test from "node:test";
import { WORKLOADS } from "./operation-pipeline-catalog.mjs";
import {
  PROTOCOL_PATHS,
  protocolSha256,
} from "./operation-pipeline-protocol.mjs";
import {
  evaluateKeepGate,
  verifyCrossStageSemantics,
} from "./operation-pipeline-report.mjs";

const DID_NOT_IMPROVE_PATTERN = /did not improve by more than 2×MAD/;
const NO_TARGET_PATTERN = /No target metric contract/;
const REPLICATE_CHECKSUM_DRIFT_PATTERN =
  /scalar-find-unique\/full\/cpu changed semantic checksum across replicates/;

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
      `${workload} is missing corresponding full/alloc evidence.`,
      `${workload} is missing corresponding full/cpu evidence.`,
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
