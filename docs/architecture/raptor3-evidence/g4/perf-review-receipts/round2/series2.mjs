// Round-2 reviewer driver: run the relation-series-2 contract on one engine and
// report what the contract observed, or the exact failure sentence.
import { createWorkloadHarness } from "../review-ab/after/benchmarks/operation-pipeline-workloads.mjs";

const engine = process.env.VIBORM_BENCH_ENGINE === "candidate" ? "candidate" : "shipped";
try {
  const { harness } = await createWorkloadHarness(
    "relation-series-2",
    "full",
    2,
    "sqlite3"
  );
  const o = harness.contractObservation;
  console.log(
    JSON.stringify({
      engine,
      verdict: "green",
      defaults: o.defaults.length,
      defaultValues: o.defaults.map((d) => d.value),
      statements: harness.witness.statementCount,
      children: o.final.bench_generated_children
        .filter((c) => c.label === "series-child")
        .map((c) => ({ id: c.id, parentId: c.parentId })),
      reachedCuts: o.reachedCuts,
    })
  );
} catch (failure) {
  console.log(
    JSON.stringify({
      engine,
      verdict: "red",
      name: failure?.name,
      message: String(failure?.message).split("\n")[0],
      cause: failure?.cause ? String(failure.cause.message).split("\n")[0] : undefined,
      actual: failure?.actual,
      expected: failure?.expected,
    })
  );
  process.exitCode = 2;
}
