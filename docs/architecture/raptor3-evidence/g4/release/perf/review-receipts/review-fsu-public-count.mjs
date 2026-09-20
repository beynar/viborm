/**
 * Reviewer probe: how many statements does the PUBLIC flat-scalar-update entry
 * send on each side? The note's §2.2 claims "on none of the 20 cells does the
 * release tree send one statement more than the shipped engine", while its
 * §2.1 records the candidate's package seam publishing two statements for this
 * cell. This counts at the same seam the author's statement-count-probe uses.
 * usage: node review-fsu-public-count.mjs <root>
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const [root] = process.argv.slice(2);
const url = (p) => pathToFileURL(resolve(root, p)).href;
const { createBenchmarkFixture } = await import(url("benchmarks/operation-pipeline-fixtures.mjs"));
const { WORKLOADS } = await import(url("benchmarks/operation-pipeline-catalog.mjs"));
const definition = WORKLOADS["flat-scalar-update"];
const fixture = await createBenchmarkFixture(definition.fixture, definition.substrate, "unextended", "sqlite3");
const { client, driver } = fixture;
const run = () => client.user.update({ where: { id: "update_target" }, data: { age: { increment: 1 } } });
for (let i = 0; i < 5; i++) await run();
const counts = {}; const sql = [];
for (const name of ["_prepare", "_execute", "_executeRaw", "_executeBatch", "withTransaction", "execute", "executeRaw"]) {
  const original = driver[name];
  if (typeof original !== "function") continue;
  counts[name] = 0;
  const statementArgument = name === "execute" || name === "executeRaw" ? 1 : 0;
  Object.defineProperty(driver, name, { configurable: true, value: function (...args) {
    counts[name]++;
    const c = args[statementArgument];
    if (sql.length < 20 && typeof c === "string") sql.push(`${name}: ${c.replace(/\s+/g, " ")}`);
    else if (sql.length < 20 && c && typeof c.sql === "string") sql.push(`${name}: ${c.sql.replace(/\s+/g, " ")}`);
    return original.apply(this, args);
  } });
}
const iterations = 20;
for (let i = 0; i < iterations; i++) await run();
process.stdout.write(`${JSON.stringify({ root, workload: "flat-scalar-update", stage: "full(public)", iterations,
  perOperation: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / iterations])), firstStatements: sql }, null, 1)}\n`);
