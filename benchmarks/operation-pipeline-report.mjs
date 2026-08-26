/** Statistical summaries, semantic aggregation, and keep-gate evaluation. */

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(values) {
  const center = median(values);
  return {
    median: center,
    mad: median(values.map((value) => Math.abs(value - center))),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

const RETAINED_LEVEL_FIELDS = new Set(["peakRssBytes"]);

function relativePercent(baseline, absolute) {
  return baseline > 0 ? (absolute / baseline) * 100 : null;
}

function hasMeaningfulTenPercentBaseline(comparison, metric) {
  return comparison.mode !== "retained" || RETAINED_LEVEL_FIELDS.has(metric);
}

function metricContractKey(contract, metric = contract.metric) {
  return JSON.stringify([
    contract.provider ?? "sqlite3",
    contract.workload,
    contract.stage,
    contract.mode,
    metric,
  ]);
}

export function measuredFields(mode) {
  if (mode === "alloc") {
    return ["allocatedBytesPerOperation", "allocatedBytesPerRow"];
  }
  if (mode === "cpu") {
    return ["cpuMicrosecondsPerOperation", "wallMicrosecondsPerOperation"];
  }
  if (mode === "retained") {
    return [
      "retainedBytesPerOperation",
      "retainedBytesPerRow",
      "releasedBytesPerOperation",
      "releasedBytesPerRow",
      "peakRssBytes",
      "peakRssGrowthBytes",
    ];
  }
  throw new Error(`Unknown measurement mode: ${mode}`);
}

export function targetableFields(mode) {
  return [
    ...measuredFields(mode),
    ...(mode === "cpu"
      ? ["responseBytesPerOperation", "responseBytesPerRow"]
      : []),
  ];
}

export function isPerOperationMetric(mode, metric) {
  return (
    metric.endsWith("PerOperation") && targetableFields(mode).includes(metric)
  );
}

function coveredBudgetFields(budget) {
  const perRow = budget.metric.replace(/PerOperation$/, "PerRow");
  return perRow !== budget.metric &&
    targetableFields(budget.mode).includes(perRow)
    ? [budget.metric, perRow]
    : [budget.metric];
}

export function parseDeclaredBudgets(values, workloads) {
  const budgets = values.map((value) => {
    const [
      provider,
      workload,
      stage,
      mode,
      metric,
      limitKind,
      rawMaximum,
      ...extra
    ] = value.split("/");
    const maximum = Number(rawMaximum);
    if (
      !(
        provider &&
        workload &&
        stage &&
        mode &&
        metric &&
        limitKind &&
        rawMaximum
      ) ||
      extra.length > 0 ||
      !["absolute", "percent"].includes(limitKind) ||
      !Number.isFinite(maximum) ||
      maximum < 0
    ) {
      throw new Error(
        `Invalid --budget ${value}; expected provider/workload/stage/mode/metric/(absolute|percent)/non-negative-maximum`
      );
    }
    const definition = workloads[workload];
    if (!definition) throw new Error(`Unknown budget workload: ${workload}`);
    if (!definition.stages.includes(stage)) {
      throw new Error(`Budget stage ${stage} is not defined for ${workload}`);
    }
    if (!(definition.providers ?? ["sqlite3"]).includes(provider)) {
      throw new Error(`${workload} is not defined for provider ${provider}`);
    }
    if (!isPerOperationMetric(mode, metric)) {
      throw new Error(
        `Budget metric ${metric} is not a per-operation metric measured in ${mode} mode`
      );
    }
    return {
      provider,
      workload,
      stage,
      mode,
      metric,
      limit: { kind: limitKind, maximum },
    };
  });
  const keys = budgets.map((budget) => metricContractKey(budget));
  if (new Set(keys).size !== keys.length) {
    throw new Error("Duplicate --budget metric contract");
  }
  return budgets;
}

/** Reduced counts for directional tuning; these can never authorize a keep. */
export function diagnosticMeasurementCounts(rowsPerOperation, mode) {
  const scaleDivisor = Math.max(1, rowsPerOperation / 20);
  const iterations =
    mode === "retained"
      ? Math.max(10, Math.floor(100 / scaleDivisor))
      : Math.max(50, Math.floor(1000 / scaleDivisor));
  return {
    iterations,
    warmupIterations: Math.max(10, Math.ceil(iterations / 5)),
  };
}

export function aggregateTarget(target, samples) {
  const responseAvailability = new Set(
    samples.map(
      (sample) =>
        typeof sample.output.measurement.responseBytesPerOperation === "number"
    )
  );
  if (responseAvailability.size !== 1) {
    throw new Error(
      `${target.provider ?? "sqlite3"}/${target.workload}/${target.stage}/${target.mode} changed response-byte availability across samples`
    );
  }
  const responseSources = new Set(
    samples.flatMap((sample) =>
      sample.output.measurement.responseBytesSource === undefined
        ? []
        : [sample.output.measurement.responseBytesSource]
    )
  );
  if (responseSources.size > 1) {
    throw new Error(
      `${target.provider ?? "sqlite3"}/${target.workload}/${target.stage}/${target.mode} changed response-byte source across samples`
    );
  }
  const optionalFields = [
    "responseBytesPerOperation",
    "responseBytesPerRow",
  ].filter((field) =>
    samples.every(
      (sample) => typeof sample.output.measurement[field] === "number"
    )
  );
  const fields = [...measuredFields(target.mode), ...optionalFields];
  const byCheckout = Object.fromEntries(
    ["baseline", "candidate"].map((label) => {
      const checkoutSamples = samples.filter(
        (sample) => sample.checkout === label
      );
      const metrics = Object.fromEntries(
        fields.map((field) => [
          field,
          summarize(
            checkoutSamples.map((sample) => sample.output.measurement[field])
          ),
        ])
      );
      return [
        label,
        { metrics, samples: checkoutSamples.map((sample) => sample.output) },
      ];
    })
  );
  const deltas = Object.fromEntries(
    fields.map((field) => {
      const baseline = byCheckout.baseline.metrics[field].median;
      const candidate = byCheckout.candidate.metrics[field].median;
      const noiseThreshold =
        2 *
        Math.max(
          byCheckout.baseline.metrics[field].mad,
          byCheckout.candidate.metrics[field].mad
        );
      const absolute = candidate - baseline;
      return [
        field,
        {
          absolute,
          percent: relativePercent(baseline, absolute),
          twoMadThreshold: noiseThreshold,
          significantImprovement: -absolute > noiseThreshold,
          significantRegression: absolute > noiseThreshold,
        },
      ];
    })
  );
  return {
    ...target,
    semanticChecksum: samples[0].output.measurement.checksum,
    semanticDigest: samples[0].output.semanticDigest,
    witness: samples[0].output.witness,
    responseBytes:
      optionalFields.length === 0
        ? { available: false }
        : {
            available: true,
            source: samples[0].output.measurement.responseBytesSource,
          },
    byCheckout,
    deltas,
  };
}

export function verifyCrossStageSemantics(samples) {
  const providerWorkloads = new Set(
    samples.map((sample) =>
      JSON.stringify([sample.provider ?? "sqlite3", sample.workload])
    )
  );
  for (const serializedProviderWorkload of providerWorkloads) {
    const [provider, workload] = JSON.parse(serializedProviderWorkload);
    const digests = new Set(
      samples
        .filter(
          (sample) =>
            (sample.provider ?? "sqlite3") === provider &&
            sample.workload === workload
        )
        .map((sample) => sample.output.semanticDigest)
    );
    if (digests.size !== 1 || digests.has(undefined)) {
      throw new Error(
        `${provider}/${workload} changed semantic digest across stages`
      );
    }
  }
  const targets = new Set(
    samples.map((sample) =>
      JSON.stringify([
        sample.provider ?? "sqlite3",
        sample.workload,
        sample.stage,
        sample.mode,
      ])
    )
  );
  for (const serializedTarget of targets) {
    const [provider, workload, stage, mode] = JSON.parse(serializedTarget);
    const checksums = new Set(
      samples
        .filter(
          (sample) =>
            sample.workload === workload &&
            (sample.provider ?? "sqlite3") === provider &&
            sample.stage === stage &&
            sample.mode === mode
        )
        .map((sample) => sample.output.measurement.checksum)
    );
    if (checksums.size !== 1 || checksums.has(undefined)) {
      throw new Error(
        `${provider}/${workload}/${stage}/${mode} changed semantic checksum across replicates`
      );
    }
  }
}

export function evaluateKeepGate({
  smoke,
  diagnosticOnly = false,
  hasOverrides,
  targets,
  declaredTargets,
  declaredCeilings = [],
  declaredBudgets = [],
  rowScalings = [],
  comparisons,
  skippedComparisons = [],
}) {
  const reasons = [];
  if (smoke) reasons.push("Smoke mode uses one replicate.");
  if (diagnosticOnly) {
    reasons.push(
      "Diagnostic mode uses two reduced-count replicates and cannot authorize a keep."
    );
  }
  if (hasOverrides)
    reasons.push("Iteration or warmup overrides were supplied.");
  if (
    declaredTargets.length === 0 &&
    declaredCeilings.length === 0 &&
    declaredBudgets.length === 0
  ) {
    reasons.push("No target, ceiling, or budget metric contract was declared.");
  }
  for (const skipped of skippedComparisons) {
    reasons.push(
      `${skipped.provider}/${skipped.workload}/${skipped.stage}/${skipped.mode} was skipped: ${skipped.reason}`
    );
  }
  const targetedWorkloads = new Set(
    [...declaredTargets, ...declaredCeilings, ...declaredBudgets].map((target) =>
      JSON.stringify([target.provider ?? "sqlite3", target.workload])
    )
  );
  for (const serializedProviderWorkload of targetedWorkloads) {
    const [provider, workload] = JSON.parse(serializedProviderWorkload);
    const workloadTargets = targets.filter(
      (target) =>
        (target.provider ?? "sqlite3") === provider &&
        target.workload === workload
    );
    for (const requiredMode of ["alloc", "cpu"]) {
      if (
        !workloadTargets.some(
          (target) => target.stage === "full" && target.mode === requiredMode
        )
      ) {
        reasons.push(
          `${provider}/${workload} is missing corresponding full/${requiredMode} evidence.`
        );
      }
    }
  }
  for (const target of declaredTargets) {
    const comparison = comparisons.find(
      (entry) =>
        entry.workload === target.workload &&
        (entry.provider ?? "sqlite3") === (target.provider ?? "sqlite3") &&
        entry.stage === target.stage &&
        entry.mode === target.mode
    );
    const delta = comparison?.deltas[target.metric];
    if (!delta?.significantImprovement) {
      reasons.push(
        `${target.provider ?? "sqlite3"}/${target.workload}/${target.stage}/${target.mode}/${target.metric} did not improve by more than 2×MAD.`
      );
    }
  }
  for (const ceiling of declaredCeilings) {
    const comparison = comparisons.find(
      (entry) =>
        entry.workload === ceiling.workload &&
        (entry.provider ?? "sqlite3") === (ceiling.provider ?? "sqlite3") &&
        entry.stage === ceiling.stage &&
        entry.mode === ceiling.mode
    );
    const delta = comparison?.deltas[ceiling.metric];
    if (
      !delta ||
      delta.percent === null ||
      delta.percent > ceiling.maximumPercent ||
      delta.significantRegression
    ) {
      reasons.push(
        `${ceiling.provider ?? "sqlite3"}/${ceiling.workload}/${ceiling.stage}/${ceiling.mode}/${ceiling.metric} exceeded its ${ceiling.maximumPercent}% ceiling or 2×MAD noise bound.`
      );
    }
  }
  const coveredBudgetMetrics = new Set();
  for (const budget of declaredBudgets) {
    const comparison = comparisons.find(
      (entry) =>
        entry.workload === budget.workload &&
        (entry.provider ?? "sqlite3") === (budget.provider ?? "sqlite3") &&
        entry.stage === budget.stage &&
        entry.mode === budget.mode
    );
    const delta = comparison?.deltas[budget.metric];
    const observed =
      budget.limit.kind === "absolute" ? delta?.absolute : delta?.percent;
    if (!Number.isFinite(observed) || observed > budget.limit.maximum) {
      reasons.push(
        `${budget.provider ?? "sqlite3"}/${budget.workload}/${budget.stage}/${budget.mode}/${budget.metric} exceeded its ${budget.limit.kind} ${budget.limit.maximum} allowed-overhead budget.`
      );
      continue;
    }
    for (const metric of coveredBudgetFields(budget)) {
      coveredBudgetMetrics.add(metricContractKey(budget, metric));
    }
  }
  for (const scaling of rowScalings) {
    const findComparison = (workload) =>
      comparisons.find(
        (entry) =>
          entry.workload === workload &&
          (entry.provider ?? "sqlite3") === (scaling.provider ?? "sqlite3") &&
          entry.stage === scaling.stage &&
          entry.mode === scaling.mode
      );
    const oneDelta = findComparison(scaling.oneRowWorkload)?.deltas[
      scaling.metric
    ];
    const manyDelta = findComparison(scaling.manyRowWorkload)?.deltas[
      scaling.metric
    ];
    const excess =
      oneDelta && manyDelta
        ? manyDelta.absolute - oneDelta.absolute
        : Number.POSITIVE_INFINITY;
    const noiseBound =
      oneDelta && manyDelta
        ? oneDelta.twoMadThreshold + manyDelta.twoMadThreshold
        : Number.NEGATIVE_INFINITY;
    if (excess > noiseBound) {
      reasons.push(
        `${scaling.provider ?? "sqlite3"}/${scaling.oneRowWorkload}→${scaling.manyRowWorkload}/${scaling.stage}/${scaling.mode}/${scaling.metric} added row-scaled overhead beyond the combined 2×MAD bound.`
      );
    }
  }
  const significantRegressions = comparisons.flatMap((comparison) =>
    comparison.mode === "retained"
      ? []
      : Object.entries(comparison.deltas)
          .filter(
            ([metric, delta]) =>
              delta.significantRegression &&
              !coveredBudgetMetrics.has(metricContractKey(comparison, metric))
          )
          .map(
            ([metric]) =>
              `${comparison.provider ?? "sqlite3"}/${comparison.workload}/${comparison.stage}/${comparison.mode}/${metric} regressed beyond 2×MAD.`
          )
  );
  const fullRegressions = comparisons.flatMap((comparison) =>
    comparison.stage !== "full"
      ? []
      : Object.entries(comparison.deltas)
          .filter(
            ([metric, delta]) =>
              hasMeaningfulTenPercentBaseline(comparison, metric) &&
              delta.percent !== null &&
              delta.percent > 10 &&
              !coveredBudgetMetrics.has(metricContractKey(comparison, metric))
          )
          .map(
            ([metric, delta]) =>
              `${comparison.provider ?? "sqlite3"}/${comparison.workload}/${metric} regressed ${delta.percent.toFixed(2)}%.`
          )
  );
  reasons.push(...significantRegressions);
  reasons.push(...fullRegressions);
  return {
    eligible: reasons.length === 0,
    rule: "Every improvement target must clear 2×MAD. Every ceiling target must stay under its percentage ceiling and within 2×MAD. Every allowed-overhead budget must stay within its declared absolute or percentage cap; a passed budget covers only that metric and its mechanically derived same-base per-row projection under the 2×MAD and 10% regression rules. CPU and wall metrics need separate budgets. Declared row-scaling pairs must use per-operation metrics and must not add overhead beyond their combined 2×MAD bound. No other non-retained metric may regress beyond 2×MAD; corresponding full stages and retained peak RSS must stay within the applicable 10% ceiling.",
    twoMadReportedPerMetric: true,
    tenPercentEndToEndCeilingPassed: fullRegressions.length === 0,
    reasons,
  };
}
