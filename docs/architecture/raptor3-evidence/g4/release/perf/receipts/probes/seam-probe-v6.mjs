/**
 * Seam probe v6 — v5 with ONE added workload, for review finding F2.
 *
 * F2: §4.3's second table carried the "most of this is the bracket" argument
 * for three cells while the first table listed four over budget, and the cell
 * it omitted — `bulk-update-returning-100/prepare` at 1.556 — is one of the
 * three D-9 named. v5's `OPERATIONS` map builds only the three reads and
 * throws for anything else. v6 adds the bulk write, exactly as
 * `operation-pipeline-batch-workloads.mjs` builds it, and changes nothing else
 * about v5's method.
 *
 * Two mechanical differences from v5, both forced by the added cell:
 *
 *  1. The STATEMENT-ARM LOOP KIND is read from the catalog instead of being
 *     hardcoded sync. v5's finding (v3 -> v4) is that each arm must run the way
 *     `operation-pipeline-worker.mjs` runs its stage kind, because one await
 *     per iteration is a constant added to both sides that compresses exactly
 *     the ratio under test. The catalog owns that fact: the three reads declare
 *     `prepare` sync, and `bulk-update-returning-100` declares it async
 *     (`asyncStages: ["cold-prepare", "prepare"]`). For the three read cells
 *     `stageKinds.prepare === "sync"`, so v6 runs them exactly as v5 did.
 *  2. Its runner alternates which SIDE goes first per pair (the reviewer's §3
 *     caveat: v5 always ran baseline before candidate within a pair, where the
 *     comparator alternates between replicates).
 *
 * v5 and its receipts are untouched: this file is a copy, not an edit, so
 * `seam-samples-v5.json` / `seam-summary-v5.json` keep their provenance.
 *
 * What each arm brackets is unchanged from v5:
 *   statement seam = `capability.prepare()`   package seam = `capability.prepareBatch(driver)`.
 * For the bulk cell the series brackets `prepareOperationPlan(op, driver)`,
 * which RETURNS `capability.prepare()` whenever that seam answers and only
 * falls through to `prepareBatch` when it does not, plus a witness checksum.
 * The `published` block of every sample records which seam each side answered,
 * so the fidelity check (does the statement arm reproduce the series?) can be
 * read against the right bracket.
 *
 * usage: node seam-probe-v6.mjs <root> <workload> <seam:statement|package> <iterations> <warmup>
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
const { WORKLOADS } = await import(url("benchmarks/operation-pipeline-catalog.mjs"));

const stageKind = WORKLOADS[workload]?.stageKinds?.prepare;
if (stageKind !== "sync" && stageKind !== "async") {
  throw new Error(`${workload} declares no prepare stage kind`);
}

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
// Verbatim from operation-pipeline-batch-workloads.mjs's bulk-update-returning-100.
const bulkIds = Array.from({ length: 100 }, (_, index) => `user_${index}`);
const OPERATIONS = {
  "scalar-find-unique": () => client.user.findUnique({ where: { id: "user_42" } }),
  "fixed-collection-rowref-20": () => rowref(20),
  "fixed-collection-rowref-1000": () => rowref(1000),
  "bulk-update-returning-100": () =>
    client.user.updateMany({
      where: { id: { in: bulkIds } },
      data: { age: { increment: 1 } },
      select: { id: true, age: true },
    }),
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
const runStatementAsync = async () => runSync();
const runAsync = async () => {
  const plan = await benchmarkOperation(makeOperation()).prepareBatch(driver);
  return plan.queries.length + plan.queries[0].sql.length;
};

let checksum = 0;
let cpuBefore;
let wallBefore;
let wall;
let cpu;
if (seam === "statement" && stageKind === "sync") {
  // worker.mjs: runIterationsSync for a sync stage kind — no await per iteration.
  for (let i = 0; i < warmup; i++) checksum += runSync();
  // worker.mjs runs warmup then measureCpu with no forced collection between.
  cpuBefore = process.cpuUsage();
  wallBefore = performance.now();
  for (let i = 0; i < iterations; i++) checksum += runSync();
  wall = performance.now() - wallBefore;
  cpu = process.cpuUsage(cpuBefore);
} else {
  // worker.mjs: runIterationsAsync — one await per iteration. The package arm is
  // awaited on every cell (prepareBatch is async); the statement arm is awaited
  // only where the catalog declares `prepare` an async stage.
  const runOne = seam === "statement" ? runStatementAsync : runAsync;
  for (let i = 0; i < warmup; i++) checksum += await runOne();
  cpuBefore = process.cpuUsage();
  wallBefore = performance.now();
  for (let i = 0; i < iterations; i++) checksum += await runOne();
  wall = performance.now() - wallBefore;
  cpu = process.cpuUsage(cpuBefore);
}

process.stdout.write(`${JSON.stringify({
  root, workload, seam, stageKind, iterations, warmup, published,
  results: [{
    label: `${seam}-seam`,
    cpuUsPerOp: (cpu.user + cpu.system) / iterations,
    wallUsPerOp: (wall * 1000) / iterations,
    checksum,
  }],
}, null, 1)}\n`);
