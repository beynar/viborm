/**
 * Release unit "perf": aggregate the per-cell reports into performance-release.json,
 * in the shape g4/cutover/performance-identity4.json uses.
 *
 * This is g4/cutover/receipts-stage2d/aggregate.mjs with FIVE mechanical
 * adaptations and NO change to any straddle test, roll-up or metric set:
 *   1. reports are read from this unit's cells directory;
 *   2. the output file is performance-release.json;
 *   3. the unit label, protocol section and commit metadata are this unit's;
 *   4. the BUDGET carries D-9: the three preparation cells D-9 accepted at
 *      1.12x get budgetFraction 0.12; every other CPU/wall cell keeps plan
 *      §7's 0.05 and peak RSS keeps 0.10. The gate itself — (N-B)+E <= budget,
 *      no outlier removal, improvement must exceed E — is unchanged;
 *   5. one refusal matcher is added, exactly as stage 2c added its
 *      AssertionError matcher: the un-adapted harness refuses the whole
 *      flat-scalar-update workload with "Mutation workload did not build one
 *      executable statement" instead of stage 2d's "does not implement".
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const { parseEvidenceReport } = await import(
  "/private/tmp/viborm-perf-baseline/benchmarks/operation-pipeline-evidence.mjs"
);
const DIR =
  "/private/tmp/viborm-perf/docs/architecture/raptor3-evidence/g4/release/perf/receipts/cells";
const OUT =
  process.env.AGGREGATE_OUT ??
  "/private/tmp/viborm-perf/docs/architecture/raptor3-evidence/g4/release/perf/performance-release.json";
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

/**
 * D-9 (ledger g4.md, 18:30 2026-09-16) accepted the remaining preparation cost.
 * The three cells it accepted are the three preparation cells the final report
 * names as "the three cells that were 1.40-2.15x at the start" and stage 2d
 * measured at 1.19-1.40: scalar-find-unique/prepare (1.45 -> 1.19-1.32),
 * bulk-update-returning-100/prepare (1.48 -> 1.31-1.40) and
 * fixed-collection-rowref-1000/prepare (1.40 -> 1.25).
 */
const D9_ACCEPTED = new Set([
  "scalar-find-unique/prepare",
  "bulk-update-returning-100/prepare",
  "fixed-collection-rowref-1000/prepare",
]);
const timeBudgetFor = (workload, stage) =>
  D9_ACCEPTED.has(`${workload}/${stage}`) ? 0.12 : 0.05;

const TIME_METRICS = ["cpuMicrosecondsPerOperation", "wallMicrosecondsPerOperation"];
const MEM_METRIC = "peakRssBytes";

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const mad = (xs) => { const m = median(xs); return median(xs.map((x) => Math.abs(x - m))); };
const shortError = (text) => {
  const lines = text.split("\n").filter((l) => l.length < 300);
  const implement = lines.find((l) => /^Error: Harness .* does not implement/.test(l.trim()));
  if (implement) return implement.trim();
  // Added at this unit: the un-adapted harness refuses the whole workload here.
  const oneStatement = lines.find((l) => /^Error: (Mutation workload did not build one executable statement|Read workload did not prepare one statement|Operation exposed no executable preparation seam)/.test(l.trim()));
  if (oneStatement) return oneStatement.trim();
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
      witnessSql: (samples[0]?.witness?.statements ?? []).map((s) => String(s.sql).replace(/\s+/g, " ")),
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
  const budgetFraction = timeBudgetFor(workload, stage);
  const row = { workload, stage, timeBudgetFraction: budgetFraction, d9Accepted: D9_ACCEPTED.has(`${workload}/${stage}`), perPass: {} };
  for (const pass of PASSES) {
    const cpu = loadSide(pass, workload, stage, "cpu");
    const retained = loadSide(pass, workload, stage, "retained");
    const entry = { cpu: { status: cpu.status, detail: cpu.detail, report: cpu.reportFile, log: cpu.log },
                    retained: { status: retained.status, detail: retained.detail, report: retained.reportFile, log: retained.log } };
    if (cpu.status === "measured" || retained.status === "measured") {
      const metrics = {};
      if (cpu.status === "measured") {
        for (const m of TIME_METRICS) { const r = metricRow(m, cpu.baseline, cpu.candidate, budgetFraction); if (r) metrics[m] = r; }
        entry.iterations = { cpu: cpu.baseline.iterations };
        entry.warmupIterations = { cpu: cpu.baseline.warmupIterations };
        entry.replicates = { cpu: { baseline: cpu.baseline.sampleCount, candidate: cpu.candidate.sampleCount } };
        entry.measurementProtocolValid = cpu.protocolValid;
        const prep = (side) => side.preparation
          ? { seam: side.preparation.preparationSeam, statementCount: side.preparation.statementCount, packageRefusal: side.preparation.packageRefusal ?? null }
          : null;
        entry.preparationSeam = { baseline: prep(cpu.baseline), candidate: prep(cpu.candidate) };
        entry.observedStatementCount = { baseline: cpu.baseline.statementCount, candidate: cpu.candidate.statementCount };
        entry.preparedSql = { baseline: cpu.baseline.witnessSql, candidate: cpu.candidate.witnessSql };
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
  row.preparationSeam = seamRow;
  row.observedStatementCount = measured.find((p) => p.observedStatementCount)?.observedStatementCount ?? null;
  row.preparedSql = measured.find((p) => p.preparedSql)?.preparedSql ?? null;
  const counts = row.observedStatementCount;
  row.bracketedAtTheSameSeam = counts && counts.baseline !== null && counts.candidate !== null
    ? counts.baseline === counts.candidate
    : (stage === "full" ? "n/a — end-to-end through the public entry" : null);

  if (!measured.length) {
    const detail = passEntries[0].cpu.detail || passEntries[0].retained.detail || "";
    if (/does not implement|did not build one executable statement|did not prepare one statement|no executable preparation seam/.test(detail)) {
      row.status = "not measurable comparably";
      row.verdict = "not measurable comparably — NO end-to-end evidence retained";
      row.reason = `The two sides do not bracket the same work and this protocol identity carries no phase adapter, so the harness refuses the WHOLE workload before any stage is timed — the end-to-end 'full' evidence the protocol promises for this case is therefore NOT retained. Refusal: ${detail}`;
      row.endToEndEvidence = "none through the frozen harness — see the unit's separate public-entry probe";
    } else if (/changed (final|outcome|initial|defaults|cuts)/.test(detail)) {
      const replicates = (passEntries[0].cpu.log ? readFileSync(`${DIR}/${passEntries[0].cpu.log}`, "utf8") : "")
        .split("\n").filter((l) => /replicate \d+\/\d+:/.test(l)).length;
      row.status = "not measured";
      row.verdict = "blocks adoption — required contract divergence";
      row.reason = `Every replicate ran, and the BETWEEN-ENGINE comparison then refused the cell: ${detail}. The two engines' authoritative final state differs (plan §7: compare public outcomes, authoritative state and causal contracts between engines).`;
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
  unit: "g4-release-perf (shipped-engine tree 5a37bcd7 against the release tree 36c87710a)",
  passes: PASSES,
  generatedAt: new Date().toISOString(),
  protocol: {
    document: "docs/architecture/raptor3-evidence/g4/cutover/protocol.md",
    section: "§5 (the frozen 20 cells and their verdict rules); NO phase adapter — see §2",
    frozenMatrix: "g0.md, Frozen representative calibration version 1 (20 cells)",
    replicatesPerSide: 5, alternating: true, freshProcessPerSample: true,
    provider: "sqlite3", comparisonMode: "semantic", oneModePerCommand: true,
    timeBudgetFraction: "0.12 on the three cells D-9 accepted, 0.05 elsewhere",
    peakMemoryBudgetFraction: 0.1,
    uncertainty: "E = 2 x max(MAD_baseline, MAD_candidate)",
    gate: "(N - B) + E <= budget", outlierRemoval: "none",
    improvementClaim: "improvement > E",
    protocolIdentity: "2e35d9a73c57468f7a840a1ab8251393f489ae3b933db8e511e26a8591d5f087",
    protocolIdentityNote:
      "NEW identity. Stages 2a/2b were 6716a222…, stages 2c/2d f23e0aac… (the phase-adapter overlay). This series carries NO overlay: the 24 PROTOCOL_PATHS files are byte-identical between the two release trees. The bracket is therefore the frozen protocol's ORIGINAL statement seam on both sides, not stage 2c/2d's package seam, and the ratios are NOT comparable command for command with stage 2c/2d's.",
    raptor3WorkloadVersion: 1,
  },
  commits: {
    baselineShippedOldEngine: "5a37bcd7f371fe393cf7cecb8ec9f82ef8bd3062",
    candidateRelease: "36c87710aa2526652867430f6e24f30005556394",
  },
  worktrees: {
    baseline: "/private/tmp/viborm-perf-baseline (detached, clean)",
    candidate: "/private/tmp/viborm-perf-cand (detached, clean, sparse-checkout src+benchmarks+scripts)",
    coordinator: "/private/tmp/viborm-perf-baseline",
  },
  tally,
  cells: rows,
  receipts: {
    perCellReports: "docs/architecture/raptor3-evidence/g4/release/perf/receipts/cells/ (gzip -9 per-cell evidence reports; refused cells have only a .log)",
    perCellLogs: "same directory, .log",
    journals: PASSES.map((p) => `${p}-journal.txt`).join(", "),
  },
}, null, 1)}\n`);
console.log(JSON.stringify(tally, null, 1));
for (const r of rows) {
  const m = (pass, key) => r.perPass[pass]?.metrics?.[key];
  const fmt = (x) => (x ? x.ratio.toFixed(3) : "—");
  console.log(`${(r.verdict ?? "").padEnd(58)} ${`${r.workload}/${r.stage}`.padEnd(38)} ${PASSES.map((p) => `${p}=${r.perPass[p].verdict}`).join(" ")}  cpu=${PASSES.map((p) => fmt(m(p, "cpuMicrosecondsPerOperation"))).join("/")} wall=${PASSES.map((p) => fmt(m(p, "wallMicrosecondsPerOperation"))).join("/")} rss=${PASSES.map((p) => fmt(m(p, "peakRssBytes"))).join("/")}`);
}
