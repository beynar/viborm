import { readFileSync } from "node:fs";
import { decodeEvidenceValue } from "/private/tmp/viborm-perf-baseline/benchmarks/operation-pipeline-evidence.mjs";
for (const file of process.argv.slice(2)) {
  const d = JSON.parse(readFileSync(file, "utf8"));
  const v = d.value !== undefined ? decodeEvidenceValue(d.value) : d;
  for (const c of v.comparisons ?? []) {
    const b = c.byCheckout.baseline.metrics, k = c.byCheckout.candidate.metrics;
    const r = (m) => (k[m].median / b[m].median).toFixed(4);
    console.log(
      `${c.workload}/${c.stage}/${c.mode}  stmt=${c.witness?.statementCount}  ` +
      `cpu B=${b.cpuMicrosecondsPerOperation.median.toFixed(2)} C=${k.cpuMicrosecondsPerOperation.median.toFixed(2)} ratio=${r("cpuMicrosecondsPerOperation")}  ` +
      `wall B=${b.wallMicrosecondsPerOperation.median.toFixed(2)} C=${k.wallMicrosecondsPerOperation.median.toFixed(2)} ratio=${r("wallMicrosecondsPerOperation")}`
    );
    const s = (side) => c.byCheckout[side].samples.map(x => x.measurement.cpuMicrosecondsPerOperation.toFixed(2)).join(" · ");
    console.log(`   baseline samples: ${s("baseline")}`);
    console.log(`   candidate samples: ${s("candidate")}`);
  }
}
