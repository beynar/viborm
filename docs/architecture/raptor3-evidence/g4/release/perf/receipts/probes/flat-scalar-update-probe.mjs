/**
 * flat-scalar-update: what each side publishes, and the end-to-end evidence the
 * frozen harness cannot retain on this protocol identity.
 *
 * The un-adapted `createMutationHarness` calls `prepareForRawExecution` for
 * EVERY stage, so on the release tree it refuses the whole workload — including
 * `full`, which the protocol says must stay measurable end to end. This probe
 * builds the same world with `createBenchmarkFixture` (same fixture, same
 * substrate the catalog declares) and drives the PUBLIC entry, which is what
 * the harness's own `full` stage does. It adds no file to benchmarks/.
 *
 * usage: node flat-scalar-update-probe.mjs <root> <mode:publish|full> <iterations> <warmup>
 */
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const [root, mode, itersRaw, warmupRaw] = process.argv.slice(2);
const iterations = Number(itersRaw ?? 2000);
const warmup = Number(warmupRaw ?? 400);
const url = (p) => pathToFileURL(resolve(root, p)).href;
const { createBenchmarkFixture } = await import(url("benchmarks/operation-pipeline-fixtures.mjs"));
const { benchmarkOperation } = await import(url("benchmarks/operation-pipeline-harness.mjs"));
const { WORKLOADS } = await import(url("benchmarks/operation-pipeline-catalog.mjs"));

const definition = WORKLOADS["flat-scalar-update"];
const fixture = await createBenchmarkFixture(
  definition.fixture, definition.substrate, "unextended", "sqlite3"
);
const { client, driver } = fixture;
const makeOperation = () =>
  client.user.update({ where: { id: "update_target" }, data: { age: { increment: 1 } } });

if (mode === "publish") {
  const capability = benchmarkOperation(makeOperation());
  const statement = capability.prepare();
  // §2.3 of the protocol records that the shipped side's package seam REFUSES
  // this operation; the refusal sentence is part of the evidence, not an error.
  let pkg;
  let packageRefusal;
  try {
    pkg = await benchmarkOperation(makeOperation()).prepareBatch(driver);
  } catch (failure) {
    packageRefusal = failure instanceof Error ? failure.message : String(failure);
  }
  const built = makeOperation().buildStatement?.();
  process.stdout.write(`${JSON.stringify({
    root,
    statementSeam: statement
      ? { answered: true, sql: String(statement.sql).replace(/\s+/g, " ") }
      : { answered: false },
    packageSeam: pkg
      ? { answered: true, statementCount: pkg.queries.length,
          sql: pkg.queries.map((q) => String(q.sql).replace(/\s+/g, " ")) }
      : { answered: false, refusal: packageRefusal ?? null },
    buildStatement: built ? String(built.sql ?? built).replace(/\s+/g, " ") : null,
  }, null, 1)}\n`);
} else {
  // the harness's own `full`: `parsedConsumer(await makeOperation())`, awaited,
  // with no forced collection between warmup and the measured loop.
  let checksum = 0;
  for (let i = 0; i < warmup; i++) checksum += (await makeOperation()).id.charCodeAt(0);
  const cpuBefore = process.cpuUsage();
  const wallBefore = performance.now();
  for (let i = 0; i < iterations; i++) checksum += (await makeOperation()).id.charCodeAt(0);
  const wall = performance.now() - wallBefore;
  const cpu = process.cpuUsage(cpuBefore);
  process.stdout.write(`${JSON.stringify({
    root, mode, iterations, warmup,
    cpuUsPerOp: (cpu.user + cpu.system) / iterations,
    wallUsPerOp: (wall * 1000) / iterations,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
    checksum,
  })}\n`);
}
