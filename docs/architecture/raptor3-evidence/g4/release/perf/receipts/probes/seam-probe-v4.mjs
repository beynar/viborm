/**
 * Seam probe v3 — the same question as v2, with the SERIES' OWN SETUP.
 *
 * v2 built a bare fixture of its own; v3 built the world exactly as the series
 * does (`createWorkloadHarness`). Neither reproduced the series' statement-seam
 * ratio (v2 1.394, v3 1.353 against the series' 1.711 on scalar-find-unique).
 * The cause is in the LOOP, not the setup: the catalog declares `prepare` a
 * SYNC stage, and `operation-pipeline-worker.mjs` therefore runs it through
 * `runIterationsSync` with no await per iteration, while v2/v3 awaited every
 * iteration in both arms. One microtask tick per iteration is a constant added
 * to BOTH sides, which compresses exactly the ratio under test.
 *
 * v4 runs each arm the way the worker runs its stage kind: the statement arm
 * synchronously, the package arm awaited (prepareBatch returns a promise on
 * both engines, so its await is intrinsic). The statement arm is therefore a
 * falsifier against the 20-cell series' own ratio. v2's and v3's receipts are
 * kept.
 *
 * usage: node seam-probe-v4.mjs <root> <workload> <seam:statement|package> <iterations> <warmup>
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

const runSync = () => {
  const q = benchmarkOperation(makeOperation()).prepare();
  return q.sql.length + (q.params?.length ?? 0);
};
const runAsync = async () => {
  const plan = await benchmarkOperation(makeOperation()).prepareBatch(driver);
  return plan.queries.length + plan.queries[0].sql.length;
};

let checksum = 0;
let cpuBefore;
let wallBefore;
let wall;
let cpu;
if (seam === "statement") {
  // worker.mjs: runIterationsSync for a sync stage kind — no await per iteration.
  for (let i = 0; i < warmup; i++) checksum += runSync();
  globalThis.gc?.();
  cpuBefore = process.cpuUsage();
  wallBefore = performance.now();
  for (let i = 0; i < iterations; i++) checksum += runSync();
  wall = performance.now() - wallBefore;
  cpu = process.cpuUsage(cpuBefore);
} else {
  for (let i = 0; i < warmup; i++) checksum += await runAsync();
  globalThis.gc?.();
  cpuBefore = process.cpuUsage();
  wallBefore = performance.now();
  for (let i = 0; i < iterations; i++) checksum += await runAsync();
  wall = performance.now() - wallBefore;
  cpu = process.cpuUsage(cpuBefore);
}

process.stdout.write(`${JSON.stringify({
  root, workload, seam, iterations, warmup, published,
  results: [{
    label: `${seam}-seam`,
    cpuUsPerOp: (cpu.user + cpu.system) / iterations,
    wallUsPerOp: (wall * 1000) / iterations,
    checksum,
  }],
}, null, 1)}\n`);
