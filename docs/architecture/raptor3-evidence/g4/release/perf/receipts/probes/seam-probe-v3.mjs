/**
 * Seam probe v3 — the same question as v2, with the SERIES' OWN SETUP.
 *
 * v2 built one bare fixture of its own; the 20-cell series builds the world
 * through `createWorkloadHarness`, which creates TWO fixtures and runs the
 * workload's independent contract observation before any timing. v2's
 * statement-seam ratio (1.394 on scalar-find-unique) did not reproduce the
 * series' (1.711), so the setup is a variable and v3 removes it: the world is
 * built exactly as the series builds it, the operation is taken from that
 * world's client, and the ONLY difference between the two arms is which seam
 * is timed. One seam per process; v2's receipts are kept.
 *
 * usage: node seam-probe-v3.mjs <root> <workload> <seam:statement|package> <iterations> <warmup>
 */
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const [root, workload, seam, itersRaw, warmupRaw] = process.argv.slice(2);
if (seam !== "statement" && seam !== "package") throw new Error("seam must be statement|package");
const iterations = Number(itersRaw);
const warmup = Number(warmupRaw);

const url = (p) => pathToFileURL(resolve(root, p)).href;
const { createWorkloadHarness } = await import(url("benchmarks/operation-pipeline-workloads.mjs"));
const { benchmarkOperation } = await import(url("benchmarks/operation-pipeline-harness.mjs"));

const { fixture } = await createWorkloadHarness(
  workload, "prepare", iterations + warmup, "sqlite3", root, "unextended"
);
const { client, driver } = fixture;

const rowref = (take) =>
  client.user.findMany({
    where: { id: { startsWith: "user_" } },
    orderBy: { id: "asc" },
    select: { id: true, posts: { select: { title: true } } },
    take,
  });
const OPERATIONS = {
  "scalar-find-unique": () => client.user.findUnique({ where: { id: "user_42" } }),
  "fixed-collection-rowref-20": () => rowref(20),
  "fixed-collection-rowref-1000": () => rowref(1000),
};
const makeOperation = OPERATIONS[workload];
if (!makeOperation) throw new Error(`seam-probe does not build ${workload}`);

const statementSeam = benchmarkOperation(makeOperation()).prepare();
const packageSeam = await benchmarkOperation(makeOperation()).prepareBatch(driver);
const published = {
  statement: statementSeam ? { answered: true, statementCount: 1 } : { answered: false },
  package: packageSeam
    ? { answered: true, statementCount: packageSeam.queries.length,
        sql: packageSeam.queries.map((q) => String(q.sql).replace(/\s+/g, " ")) }
    : { answered: false },
};

const run = seam === "statement"
  ? () => {
      const q = benchmarkOperation(makeOperation()).prepare();
      return q.sql.length + (q.params?.length ?? 0);
    }
  : async () => {
      const plan = await benchmarkOperation(makeOperation()).prepareBatch(driver);
      return plan.queries.length + plan.queries[0].sql.length;
    };

let checksum = 0;
for (let i = 0; i < warmup; i++) checksum += (await run()) ?? 0;
globalThis.gc?.();
const cpuBefore = process.cpuUsage();
const wallBefore = performance.now();
for (let i = 0; i < iterations; i++) checksum += (await run()) ?? 0;
const wall = performance.now() - wallBefore;
const cpu = process.cpuUsage(cpuBefore);

process.stdout.write(`${JSON.stringify({
  root, workload, seam, iterations, warmup, published,
  results: [{
    label: `${seam}-seam`,
    cpuUsPerOp: (cpu.user + cpu.system) / iterations,
    wallUsPerOp: (wall * 1000) / iterations,
    checksum,
  }],
}, null, 1)}\n`);
