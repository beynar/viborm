/**
 * Seam probe — the falsifier for "the preparation ratios moved because the
 * BRACKET moved, not because the engine did".
 *
 * The release series brackets `prepare` at capability.prepare() (one statement)
 * on BOTH sides, because neither release tree carries the phase adapter
 * (g4/cutover/protocol.md §2). Stages 2c/2d, and the A/B that D-9 accepted at
 * 1.12x, bracketed at capability.prepareBatch(driver) (the package the owner
 * publishes). This probe times BOTH seams on the SAME operation in the SAME
 * process on each tree, so the two brackets can be read against each other
 * instead of assumed equal.
 *
 * It drives the checkout's OWN fixture and its OWN benchmarkOperation
 * capability; it adds no file to benchmarks/ and changes no production code.
 *
 * usage: node seam-probe.mjs <root> <workload> <iterations> <warmup>
 */
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const [root, workload, itersRaw, warmupRaw] = process.argv.slice(2);
const iterations = Number(itersRaw);
const warmup = Number(warmupRaw);

const url = (p) => pathToFileURL(resolve(root, p)).href;
const { createBenchmarkFixture } = await import(url("benchmarks/operation-pipeline-fixtures.mjs"));
const { benchmarkOperation } = await import(url("benchmarks/operation-pipeline-harness.mjs"));
const { WORKLOADS } = await import(url("benchmarks/operation-pipeline-catalog.mjs"));

const definition = WORKLOADS[workload];
if (!definition) throw new Error(`unknown workload ${workload}`);
const fixture = await createBenchmarkFixture(
  definition.fixture, definition.substrate, "unextended", "sqlite3"
);
const { client, driver } = fixture;

const OPERATIONS = {
  "scalar-find-unique": () => client.user.findUnique({ where: { id: "user_42" } }),
  "fixed-collection-rowref-20": () => rowref(20),
  "fixed-collection-rowref-1000": () => rowref(1000),
};
const rowref = (take) =>
  client.user.findMany({
    where: { id: { startsWith: "user_" } },
    orderBy: { id: "asc" },
    select: { id: true, posts: { select: { title: true } } },
    take,
  });
const makeOperation = OPERATIONS[workload];
if (!makeOperation) throw new Error(`seam-probe does not build ${workload}`);

/** What each seam publishes, before any timing. */
const statementSeam = benchmarkOperation(makeOperation()).prepare();
const packageSeam = await benchmarkOperation(makeOperation()).prepareBatch(driver);
const published = {
  statement: statementSeam
    ? { answered: true, statementCount: 1, sql: [String(statementSeam.sql).replace(/\s+/g, " ")] }
    : { answered: false },
  package: packageSeam
    ? {
        answered: true,
        statementCount: packageSeam.queries.length,
        sql: packageSeam.queries.map((q) => String(q.sql).replace(/\s+/g, " ")),
      }
    : { answered: false },
};

async function time(label, run) {
  let checksum = 0;
  for (let i = 0; i < warmup; i++) checksum += (await run()) ?? 0;
  globalThis.gc?.();
  const cpuBefore = process.cpuUsage();
  const wallBefore = performance.now();
  for (let i = 0; i < iterations; i++) checksum += (await run()) ?? 0;
  const wall = performance.now() - wallBefore;
  const cpu = process.cpuUsage(cpuBefore);
  return {
    label,
    cpuUsPerOp: (cpu.user + cpu.system) / iterations,
    wallUsPerOp: (wall * 1000) / iterations,
    checksum,
  };
}

const results = [];
if (published.statement.answered) {
  results.push(
    await time("statement-seam (capability.prepare)", () => {
      const q = benchmarkOperation(makeOperation()).prepare();
      return q.sql.length + (q.params?.length ?? 0);
    })
  );
}
if (published.package.answered) {
  results.push(
    await time("package-seam (capability.prepareBatch)", async () => {
      const plan = await benchmarkOperation(makeOperation()).prepareBatch(driver);
      return plan.queries.length + plan.queries[0].sql.length;
    })
  );
}

process.stdout.write(
  `${JSON.stringify({ root, workload, iterations, warmup, published, results }, null, 1)}\n`
);
await driver.disconnect?.();
