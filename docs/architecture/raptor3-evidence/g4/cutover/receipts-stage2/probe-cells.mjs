/** Probe: build every frozen Raptor 3 cell's harness in one worktree and run each stage once. */
const root = process.argv[2];
if (!root) throw new Error("usage: probe-cells.mjs <worktree>");
process.chdir(root);
const { createWorkloadHarness } = await import(
  `${root}/benchmarks/operation-pipeline-workloads.mjs`
);
const { WORKLOADS } = await import(
  `${root}/benchmarks/operation-pipeline-catalog.mjs`
);

const CELLS = [
  ["scalar-find-unique", ["cold-prepare", "prepare", "execute", "full"]],
  ["flat-scalar-update", ["prepare", "execute", "full"]],
  ["fixed-collection-rowref-20", ["prepare", "execute", "full"]],
  ["nested-conditional-found", ["full"]],
  ["nested-conditional-missing", ["full"]],
  ["key-transition-cascade", ["full"]],
  ["bulk-update-returning-100", ["prepare", "full"]],
  ["relation-series-2", ["full"]],
  ["fixed-collection-rowref-1000", ["prepare", "execute", "parse", "full"]],
];

const results = [];
for (const [workload, stages] of CELLS) {
  for (const stage of stages) {
    const definition = WORKLOADS[workload];
    const stageKind = definition.stageKinds[stage];
    const row = { workload, stage, stageKind };
    try {
      const { fixture, semanticFixture, harness } = await createWorkloadHarness(
        workload,
        stage,
        4,
        "sqlite3",
        root
      );
      row.statementCount = harness.witness.statementCount;
      row.sql = (harness.witness.statements ?? [])
        .map((statement) => String(statement.sql).replace(/\s+/g, " ").slice(0, 110))
        .join(" | ");
      row.hasContract = harness.contractObservation !== undefined;
      row.preparationSeam = harness.preparation?.preparationSeam ?? null;
      row.packageRefusal = harness.preparation?.packageRefusal ?? null;
      row.preparedSql = (harness.preparation?.statements ?? []).map((q)=>String(q.sql).replace(/\s+/g," ")).join(" | ");
      const runOne = harness[stage];
      if (!runOne) throw new Error(`no stage function for ${stage}`);
      const value = stageKind === "sync" ? runOne(0) : await runOne(0);
      row.checksum = typeof value === "number" ? value : `NON-NUMBER:${typeof value}`;
      row.ok = Number.isFinite(row.checksum);
      await fixture.driver.disconnect();
      await semanticFixture.driver.disconnect();
    } catch (error) {
      row.ok = false;
      row.error = `${error?.message ?? error}`.split("\n")[0].slice(0, 200);
    }
    results.push(row);
    process.stderr.write(
      `${row.ok ? "ok  " : "FAIL"} ${workload}/${stage} ${row.error ?? `seam=${row.preparationSeam} stmts=${row.statementCount} checksum=${row.checksum}`}\n`
    );
  }
}
process.stdout.write(`${JSON.stringify(results, null, 1)}\n`);
