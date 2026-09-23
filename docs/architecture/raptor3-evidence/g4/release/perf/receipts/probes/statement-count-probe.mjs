/**
 * Statement-count probe — what each engine actually sends per public operation.
 *
 * This is g4/perf2/receipts/instruments/count-driver.mjs with the driver method
 * list widened to `_executeRaw` and the counted stage fixed at `full`, so the
 * count is per PUBLIC operation. It is the evidence for which cells the rulings
 * can touch: D-29 (a queued premise rides the atomic unit it protects) and D-58
 * (a value produced in one segment is carried into the next; a dispatched unit
 * that stored a produced value and is followed by another unit reads it back).
 *
 * usage: node statement-count-probe.mjs <root> <workload> <iterations>
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const [root, workload, itersRaw] = process.argv.slice(2);
const iterations = Number(itersRaw ?? 50);
const { createWorkloadHarness } = await import(
  pathToFileURL(resolve(root, "benchmarks/operation-pipeline-workloads.mjs")).href
);
const { fixture, harness } = await createWorkloadHarness(
  workload, "full", iterations + 5, "sqlite3", root, "unextended"
);
const runOne = harness.full;
for (let i = 0; i < 5; i++) await runOne(i);
const counts = {};
const sql = [];
// `execute`/`executeRaw` are the (client, sql, params) seam every statement
// crosses, INCLUDING the ones a nested write sends inside withTransaction;
// `observeBenchmarkContract` counts there for the same reason.
for (const name of ["_prepare", "_execute", "_executeRaw", "_executeBatch", "withTransaction", "execute", "executeRaw"]) {
  const original = fixture.driver[name];
  if (typeof original !== "function") continue;
  counts[name] = 0;
  const statementArgument = name === "execute" || name === "executeRaw" ? 1 : 0;
  Object.defineProperty(fixture.driver, name, {
    configurable: true,
    value: function (...args) {
      counts[name]++;
      const candidate = args[statementArgument];
      if (sql.length < 60 && typeof candidate === "string") sql.push(`${name}: ${candidate.replace(/\s+/g, " ")}`);
      else if (sql.length < 60 && candidate && typeof candidate.sql === "string") sql.push(`${name}: ${candidate.sql.replace(/\s+/g, " ")}`);
      return original.apply(this, args);
    },
  });
}
for (let i = 0; i < iterations; i++) await runOne(i);
process.stdout.write(`${JSON.stringify({
  root, workload, stage: "full", iterations,
  perOperation: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / iterations])),
  firstStatements: sql,
}, null, 1)}\n`);
