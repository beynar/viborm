/**
 * Falsifier specimens for the G4 cutover measurement protocol, built from the
 * REAL samples of a completed run: (1) a changed-SQL specimen must still pass
 * the semantic comparison, (2) a wrong-result specimen must still fail it.
 */
import { readFileSync } from "node:fs";
const root = process.argv[2];
const reportPath = process.argv[3];
const { parseEvidenceReport } = await import(
  `${root}/benchmarks/operation-pipeline-evidence.mjs`
);
const { verifyRewriteBenchmarkEvidence } = await import(
  `${root}/benchmarks/operation-pipeline-semantics.mjs`
);

const report = parseEvidenceReport(readFileSync(reportPath, "utf8"));
const comparison = report.comparisons.find((entry) => entry.stage === "full");
const sampleOf = (label) => ({
  provider: "sqlite3",
  workload: comparison.workload,
  stage: comparison.stage,
  mode: comparison.mode,
  checkout: label,
  output: structuredClone(comparison.byCheckout[label].samples[0]),
});

const attempt = (name, samples) => {
  try {
    verifyRewriteBenchmarkEvidence(samples);
    console.log(`${name}: ACCEPTED`);
    return "accepted";
  } catch (error) {
    console.log(`${name}: REFUSED — ${String(error.message).split("\n")[0].slice(0, 160)}`);
    return "refused";
  }
};

const unchanged = [sampleOf("baseline"), sampleOf("candidate")];
const control = attempt("control (as measured)", unchanged);

const changedSql = [sampleOf("baseline"), sampleOf("candidate")];
changedSql[1].output.witness = {
  ...changedSql[1].output.witness,
  statements: changedSql[1].output.witness.statements.map((statement) => ({
    ...statement,
    sql: `${statement.sql} /* a different physical spelling */`,
  })),
};
const changed = attempt("changed-SQL specimen (must be accepted)", changedSql);

const wrongResult = [sampleOf("baseline"), sampleOf("candidate")];
const observation = wrongResult[1].output.contractObservation;
wrongResult[1].output.contractObservation = {
  ...observation,
  outcome: { ...observation.outcome, value: { ...observation.outcome.value, __wrong: true } },
};
const wrong = attempt("wrong-result specimen (must be refused)", wrongResult);

const wrongState = [sampleOf("baseline"), sampleOf("candidate")];
const stateObservation = wrongState[1].output.contractObservation;
wrongState[1].output.contractObservation = {
  ...stateObservation,
  final: { ...stateObservation.final, __extraRow: [{ id: "phantom" }] },
};
const state = attempt("wrong-final-state specimen (must be refused)", wrongState);

const verdict =
  control === "accepted" &&
  changed === "accepted" &&
  wrong === "refused" &&
  state === "refused";
console.log(`workload=${comparison.workload}/${comparison.stage} VERDICT=${verdict ? "FALSIFIERS HOLD" : "FALSIFIERS BROKEN"}`);
process.exit(verdict ? 0 : 1);
