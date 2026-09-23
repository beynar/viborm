import { readFileSync } from "node:fs";
import { decodeEvidenceValue } from "/private/tmp/viborm-perf-baseline/benchmarks/operation-pipeline-evidence.mjs";
for (const file of process.argv.slice(2)) {
  const d = JSON.parse(readFileSync(file, "utf8"));
  const v = d.value !== undefined ? decodeEvidenceValue(d.value) : d;
  for (const c of v.comparisons ?? []) {
    const b = c.byCheckout.baseline.metrics, k = c.byCheckout.candidate.metrics;
    for (const m of Object.keys(b)) {
      if (!k[m]) continue;
      console.log(`${c.workload}/${c.stage}/${c.mode} ${m}: B=${b[m].median.toFixed(2)} C=${k[m].median.toFixed(2)} ratio=${(k[m].median/b[m].median).toFixed(4)}`);
    }
  }
}
