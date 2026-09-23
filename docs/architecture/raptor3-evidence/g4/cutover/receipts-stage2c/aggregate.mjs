/**
 * Stage 2c: aggregate the per-cell reports into performance-identity3.json,
 * in the shape stage 2b's performance.json uses.
 *
 * This is aggregate2.mjs (the program that produced the identity-2 record)
 * with three adaptations and NO change to any verdict rule:
 *   1. reports are read from receipts-stage2c/cells and are gzipped;
 *   2. the output file is performance-identity3.json;
 *   3. the commits/protocol metadata are stage 2c's, and `protocol` additionally
 *      carries `protocolIdentity` and `raptor3WorkloadVersion` because the D-8
 *      overlay moved the protocol identity (protocol.md §9.2).
 *
 * The predecessor's aggregate.mjs was NOT used: it changed four load-bearing
 * rules relative to the identity-2 record (straddle definition; last-pass
 * instead of worst-pass roll-up; a differing preparation seam overriding a
 * measured `full` cell to "not measurable comparably"; an empty metric set
 * scoring "pass"). Reproducing the identity-2 shape AND its verdict rules is
 * what makes the cell-by-cell comparison this stage must write meaningful.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const { parseEvidenceReport } = await import(
  "/private/tmp/viborm-g4-perf-baseline/benchmarks/operation-pipeline-evidence.mjs"
);
const DIR =
  "/Users/arnaud/code/viborm/docs/architecture/raptor3-evidence/g4/cutover/receipts-stage2c/cells";
const OUT =
  process.env.AGGREGATE_OUT ??
  "/Users/arnaud/code/viborm/docs/architecture/raptor3-evidence/g4/cutover/performance-identity3.json";
const PASSES = process.argv.slice(2).length ? process.argv.slice(2) : ["pass1", "pass2"];

const CELLS = [
  ["scalar-find-unique", "cold-prepare"], ["scalar-find-unique", "prepare"],
  ["scalar-find-unique", "execute"], ["scalar-find-unique", "full"],
  ["flat-scalar-update", "prepare"], ["flat-scalar-update", "execute"], ["flat-scalar-update", "full"],
  ["fixed-collection-rowref-20", "prepare"], ["fixed-collection-rowref-20", "execute"], ["fixed-collection-rowref-20", "full"],
  ["nested-conditional-found", "full"], ["nested-conditional-missing", "full"], ["key-transition-cascade", "full"],
  ["bulk-update-returning-100", "prepare"], ["bulk-update-returning-100", "full"],
  ["relation-series-2", "full"],
  ["fixed-collection-rowref-1000", "prepare"], ["fixed-collection-rowref-1000", "execute"],
  ["fixed-collection-rowref-1000", "parse"], ["fixed-collection-rowref-1000", "full"],
];
const TIME_METRICS = ["cpuMicrosecondsPerOperation", "wallMicrosecondsPerOperation"];
const MEM_METRIC = "peakRssBytes";

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const mad = (xs) => { const m = median(xs); return median(xs.map((x) => Math.abs(x - m))); };
const shortError = (text) => {
  const lines = text.split("\n").filter((l) => l.length < 300);
  const implement = lines.find((l) => /^Error: Harness .* does not implement/.test(l.trim()));
  if (implement) return implement.trim();
  // Added at stage 2c: the between-engine semantic comparison refuses with an
  // AssertionError, which the identity-2 matcher (/Error:/) did not catch.
  const semantic = lines.find((l) => /AssertionError .*changed (final|outcome|initial|defaults|cuts)/.test(l));
  if (semantic) return semantic.trim();
  const query = lines.find((l) => /QueryError/.test(l));
  if (query) {
    const meta = lines.filter((l) => /^\s+(code|model|operation):/.test(l)).map((l) => l.trim());
    return [query.trim(), ...meta].join(" ");
  }
  const assertion = lines.find((l) => /AssertionError/.test(l));
  if (assertion) return assertion.trim();
  return (lines.find((l) => /Error:/.test(l)) ?? lines.slice(-1)[0] ?? "").trim();
};

function readReport(base) {
  if (existsSync(`${base}.json.gz`)) {
    return execFileSync("gzip", ["-dc", `${base}.json.gz`], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
  }
  if (existsSync(`${base}.json`)) return readFileSync(`${base}.json`, "utf8");
  return undefined;
}

function loadSide(pass, workload, stage, mode) {
  const base = `${DIR}/${pass}__${workload}__${stage}__${mode}`;
  const text = readReport(base);
  if (text === undefined) {
    const log = existsSync(`${base}.log`) ? readFileSync(`${base}.log`, "utf8") : "";
    return { status: "refused", detail: shortError(log), log: `${pass}__${workload}__${stage}__${mode}.log` };
  }
  const report = parseEvidenceReport(text);
  const comparison = report.comparisons.find((c) => c.workload === workload && c.stage === stage && c.mode === mode);
  if (!comparison) return { status: "refused", detail: "no comparison row in report" };
  const side = (name) => {
    const checkout = comparison.byCheckout[name];
    const samples = checkout.samples ?? [];
    return {
      samples,
      values: (metric) => samples.map((s) => s.measurement?.[metric]).filter((v) => typeof v === "number"),
      preparation: samples[0]?.preparation ?? null,
      iterations: samples[0]?.iterations,
      warmupIterations: samples[0]?.warmupIterations,
      statementCount: samples[0]?.witness?.statementCount ?? null,
      sampleCount: samples.length,
    };
  };
  return {
    status: "measured", report, comparison,
    protocolValid: report.measurementProtocolValid,
    baseline: side("baseline"), candidate: side("candidate"),
    reportFile: `${pass}__${workload}__${stage}__${mode}.json.gz`,
    log: `${pass}__${workload}__${stage}__${mode}.log`,
  };
}

function metricRow(metric, base, cand, budgetFraction) {
  const bv = base.values(metric), nv = cand.values(metric);
  if (!bv.length || !nv.length) return null;
  const B = median(bv), N = median(nv);
  const madB = mad(bv), madN = mad(nv);
  const E = 2 * Math.max(madB, madN);
  const budget = budgetFraction * B;
  const signedDelta = N - B;
  const deltaPlusE = signedDelta + E;
  const withinBudget = deltaPlusE <= budget;
  const straddles = !withinBudget && signedDelta - E <= budget;
  return {
    B, N, madBaseline: madB, madCandidate: madN, E, budgetFraction, budget,
    signedDelta, ratio: N / B, deltaPlusE, withinBudget, straddles,
    improvementBeyondE: -signedDelta > E,
    samplesBaseline: bv, samplesCandidate: nv,
    verdict: withinBudget ? "pass" : straddles ? "inconclusive-repeat" : "blocks adoption",
  };
}

const RANK = { pass: 0, "inconclusive-repeat": 1, "blocks adoption": 2 };

const rows = [];
for (const [workload, stage] of CELLS) {
  const row = { workload, stage, perPass: {} };
  for (const pass of PASSES) {
    const cpu = loadSide(pass, workload, stage, "cpu");
    const retained = loadSide(pass, workload, stage, "retained");
    const entry = { cpu: { status: cpu.status, detail: cpu.detail, report: cpu.reportFile, log: cpu.log },
                    retained: { status: retained.status, detail: retained.detail, report: retained.reportFile, log: retained.log } };
    if (cpu.status === "measured" || retained.status === "measured") {
      const metrics = {};
      if (cpu.status === "measured") {
        for (const m of TIME_METRICS) { const r = metricRow(m, cpu.baseline, cpu.candidate, 0.05); if (r) metrics[m] = r; }
        entry.iterations = { cpu: cpu.baseline.iterations };
        entry.warmupIterations = { cpu: cpu.baseline.warmupIterations };
        entry.replicates = { cpu: { baseline: cpu.baseline.sampleCount, candidate: cpu.candidate.sampleCount } };
        entry.measurementProtocolValid = cpu.protocolValid;
        const prep = (side) => side.preparation
          ? { seam: side.preparation.preparationSeam, statementCount: side.preparation.statementCount, packageRefusal: side.preparation.packageRefusal ?? null }
          : null;
        entry.preparationSeam = { baseline: prep(cpu.baseline), candidate: prep(cpu.candidate) };
        entry.observedStatementCount = { baseline: cpu.baseline.statementCount, candidate: cpu.candidate.statementCount };
        entry.preparedSql = {
          baseline: (cpu.baseline.preparation?.statements ?? []).map((s) => String(s.sql).replace(/\s+/g, " ")),
          candidate: (cpu.candidate.preparation?.statements ?? []).map((s) => String(s.sql).replace(/\s+/g, " ")),
        };
      }
      if (retained.status === "measured") {
        const r = metricRow(MEM_METRIC, retained.baseline, retained.candidate, 0.10);
        if (r) metrics[MEM_METRIC] = r;
        entry.iterations = { ...(entry.iterations ?? {}), retained: retained.baseline.iterations };
        entry.warmupIterations = { ...(entry.warmupIterations ?? {}), retained: retained.baseline.warmupIterations };
        entry.replicates = { ...(entry.replicates ?? {}), retained: { baseline: retained.baseline.sampleCount, candidate: retained.candidate.sampleCount } };
      }
      entry.metrics = metrics;
      const verdicts = Object.values(metrics).map((m) => m.verdict);
      entry.verdict = verdicts.length ? verdicts.reduce((a, b) => (RANK[b] > RANK[a] ? b : a)) : "not run";
      entry.status = "measured";
    } else {
      entry.status = "refused";
      entry.verdict = "refused";
    }
    row.perPass[pass] = entry;
  }

  const passEntries = PASSES.map((p) => row.perPass[p]);
  const measured = passEntries.filter((p) => p.status === "measured");
  const seamRow = measured.find((p) => p.preparationSeam)?.preparationSeam ?? null;
  const bracketedAtTheSameSeam = seamRow && seamRow.baseline && seamRow.candidate
    ? seamRow.baseline.seam === seamRow.candidate.seam && seamRow.baseline.statementCount === seamRow.candidate.statementCount
    : (stage === "full" ? "n/a — end-to-end through the public entry" : null);
  row.preparationSeam = seamRow;
  row.bracketedAtTheSameSeam = bracketedAtTheSameSeam;
  row.observedStatementCount = measured.find((p) => p.observedStatementCount)?.observedStatementCount ?? null;
  row.preparedSql = measured.find((p) => p.preparedSql)?.preparedSql ?? null;

  if (!measured.length) {
    const detail = passEntries[0].cpu.detail || passEntries[0].retained.detail || "";
    if (/does not implement/.test(detail)) {
      row.status = "not measurable comparably";
      row.verdict = "not measurable comparably — end-to-end evidence retained";
      row.reason = `The candidate harness has no isolated '${stage}' stage for this workload: its prepared package holds two statements (an EXISTS premise probe plus the UPDATE), while the shipped side brackets one statement through its 'built-statement' seam. Refusal: ${detail}`;
      row.endToEndEvidence = `${workload}/full, measured in ${PASSES.length === 1 ? "the one series" : "both passes"}`;
    } else if (/changed (final|outcome|initial|defaults|cuts)/.test(detail)) {
      const replicates = (passEntries[0].cpu.log ? readFileSync(`${DIR}/${passEntries[0].cpu.log}`, "utf8") : "")
        .split("\n").filter((l) => /replicate \d+\/\d+:/.test(l)).length;
      row.status = "not measured";
      row.verdict = "blocks adoption — required contract divergence";
      row.reason = `Every replicate ran, and the BETWEEN-ENGINE comparison then refused the cell: ${detail}. The two engines' authoritative final state differs (plan §7: compare public outcomes, authoritative state and causal contracts between engines). D-8's per-engine ledger removed the within-engine contract failure that blocked this cell at identity 2, so the cell is now measured and refused at the state comparison rather than throwing inside the harness.`;
      row.endToEndEvidence = `${replicates} replicate runs completed (both sides) before the comparator refused; no evidence report was written, the log is the receipt`;
    } else {
      row.status = "not measured";
      row.verdict = "blocks adoption — required contract divergence";
      row.reason = `The candidate fails this workload's independent contract observation before any timing is taken: ${detail}`;
      row.endToEndEvidence = "none — the workload cannot complete comparably";
    }
    rows.push(row);
    continue;
  }

  row.status = "measured";
  const verdictsByPass = passEntries.map((p) => p.verdict);
  const allInconclusive = measured.length > 1 && measured.every((p) => p.verdict === "inconclusive-repeat");
  let verdict;
  if (allInconclusive) verdict = "inconclusive after the one permitted repeat — blocks adoption";
  else verdict = verdictsByPass.filter((v) => v in RANK).reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "pass");
  if (verdict === "inconclusive-repeat") {
    verdict = measured.length > 1
      ? "inconclusive after the one permitted repeat — blocks adoption"
      : "inconclusive — repeat the full series";
  }
  row.verdict = verdict;
  row.verdictRule = "the worse of the two full series; a cell inconclusive on both is inconclusive and blocks adoption (plan §7)";
  row.passesAgree = new Set(verdictsByPass).size === 1;
  rows.push(row);
}

const tally = {};
for (const r of rows) tally[r.verdict] = (tally[r.verdict] ?? 0) + 1;

writeFileSync(OUT, `${JSON.stringify({
  unit: "g4-cutover-measurement (stage 2c, frozen identity 3, performance pass)",
  passes: PASSES,
  generatedAt: new Date().toISOString(),
  protocol: {
    document: "docs/architecture/raptor3-evidence/g4/cutover/protocol.md",
    section: "§9 (stage 2c)",
    frozenMatrix: "g0.md, Frozen representative calibration version 1 (20 cells)",
    replicatesPerSide: 5, alternating: true, freshProcessPerSample: true,
    provider: "sqlite3", comparisonMode: "semantic", oneModePerCommand: true,
    timeBudgetFraction: 0.05, peakMemoryBudgetFraction: 0.1,
    uncertainty: "E = 2 x max(MAD_baseline, MAD_candidate)",
    gate: "(N - B) + E <= budget", outlierRemoval: "none",
    improvementClaim: "improvement > E",
    protocolIdentity: "f23e0aace9f0a8de55a1218d054870c1353a8456ec441f91d8bc5e437e0af22a",
    raptor3WorkloadVersion: 1,
  },
  commits: {
    baselineSource: "e67b511b2c1e9db738b23ed5f6b6f1f16cd449b0",
    baselineProtocolOverlay: "e532bbec7667343fc5471929d5051dd15be1852b",
    candidateCutover: "59c44d3c76d9ae112e7e497cb770772354f61177",
    candidateCutoverPlusOverlays: "90d4bb4769e1746181633fa0eb76335d119f798a",
    frozenProductionIdentity: "2e92354bafaaccb7cab5f54041992b552664a7865fb69370be70ebccb63a1975",
  },
  tally,
  cells: rows,
  receipts: {
    perCellReports: "docs/architecture/raptor3-evidence/g4/cutover/receipts-stage2c/cells/ (gzip -9 per-cell evidence reports; refused cells have only a .log)",
    perCellLogs: "same directory, .log",
    journals: PASSES.map((p) => `${p}-journal.txt`).join(", "),
  },
}, null, 1)}\n`);
console.log(JSON.stringify(tally, null, 1));
for (const r of rows) {
  const m = (pass, key) => r.perPass[pass]?.metrics?.[key];
  const fmt = (x) => (x ? x.ratio.toFixed(3) : "—");
  console.log(`${(r.verdict ?? "").padEnd(56)} ${`${r.workload}/${r.stage}`.padEnd(38)} ${PASSES.map((p) => `${p}=${r.perPass[p].verdict}`).join(" ")}  cpu=${PASSES.map((p) => fmt(m(p, "cpuMicrosecondsPerOperation"))).join("/")} wall=${PASSES.map((p) => fmt(m(p, "wallMicrosecondsPerOperation"))).join("/")} rss=${PASSES.map((p) => fmt(m(p, "peakRssBytes"))).join("/")}`);
}
