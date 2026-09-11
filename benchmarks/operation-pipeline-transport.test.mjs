import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { RAPTOR3_WORKLOADS } from "./operation-pipeline-catalog.mjs";
import { calibrationSourceIdentity } from "./operation-pipeline-semantics.mjs";

function runMeasuredWorker(workload) {
  const output = execFileSync(
    process.execPath,
    [
      "--expose-gc",
      "--max-old-space-size=768",
      "benchmarks/operation-pipeline-worker.mjs",
    ],
    {
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        VIBORM_BENCH_PROVIDER: "sqlite3",
        VIBORM_BENCH_WORKLOAD: workload,
        VIBORM_BENCH_STAGE: "full",
        VIBORM_BENCH_MODE: "cpu",
        VIBORM_BENCH_EXPECTED_COMMIT: execFileSync(
          "git",
          ["rev-parse", "HEAD"],
          { encoding: "utf8" }
        ).trim(),
        VIBORM_BENCH_ITERATIONS: "1",
        VIBORM_BENCH_WARMUP_ITERATIONS: "1",
        VIBORM_BENCH_CALIBRATION_SOURCE_SHA256: calibrationSourceIdentity(
          process.cwd(),
          true
        ).sha256,
      },
    }
  );
  return output;
}

for (const workload of RAPTOR3_WORKLOADS) {
  test(`${workload} survives worker and saved-report transport`, async () => {
    const { parseEvidenceReport, serializeEvidenceReport } = await import(
      "./operation-pipeline-evidence.mjs"
    );
    const sample = parseEvidenceReport(runMeasuredWorker(workload));
    assert.equal(sample.status, "measured");
    if (workload === "nested-conditional-found") {
      assert.equal(sample.witness.statements[2].params[0], 10001n);
      assert.equal(sample.witness.statements[3].params[3], 10001n);
    }
    const report = { comparisons: [{ samples: [{ output: sample }] }] };
    assert.deepEqual(
      parseEvidenceReport(serializeEvidenceReport(report)),
      report
    );
  });
}

test("evidence transport preserves types, record order and user-shaped tags", async () => {
  const { encodeEvidenceValue, parseEvidenceReport, serializeEvidenceReport } =
    await import("./operation-pipeline-evidence.mjs");
  const distinctions = [
    [1n, "1"],
    [1n, ["bigint", "1"]],
    [undefined, ["undefined"]],
    [{ value: undefined }, {}],
    [new Date("2026-09-07T00:00:00.000Z"), "2026-09-07T00:00:00.000Z"],
    [-0, 0],
    [Object.assign(Object.create(null), { id: 1 }), { id: 1 }],
    [
      { first: 1, second: 2 },
      { second: 2, first: 1 },
    ],
  ];
  for (const [left, right] of distinctions) {
    assert.notEqual(
      JSON.stringify(encodeEvidenceValue(left)),
      JSON.stringify(encodeEvidenceValue(right))
    );
    for (const value of [left, right]) {
      assert.deepEqual(
        parseEvidenceReport(serializeEvidenceReport(value)),
        value
      );
    }
  }
  assert.throws(
    () => serializeEvidenceReport(Array(1)),
    /Sparse evidence fixture array/
  );
  assert.deepEqual(parseEvidenceReport(serializeEvidenceReport([undefined])), [
    undefined,
  ]);
});
