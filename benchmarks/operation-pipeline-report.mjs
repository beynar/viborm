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
  hasOverrides,
  targets,
  declaredTargets,
  comparisons,
  skippedComparisons = [],
}) {
  const reasons = [];
  if (smoke) reasons.push("Smoke mode uses one replicate.");
  if (hasOverrides)
    reasons.push("Iteration or warmup overrides were supplied.");
  if (declaredTargets.length === 0) {
    reasons.push("No target metric contract was declared.");
  }
  for (const skipped of skippedComparisons) {
    reasons.push(
      `${skipped.provider}/${skipped.workload}/${skipped.stage}/${skipped.mode} was skipped: ${skipped.reason}`
    );
  }
  const targetedWorkloads = new Set(
    declaredTargets.map((target) =>
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
  const fullRegressions = comparisons.flatMap((comparison) =>
    comparison.stage !== "full"
      ? []
      : Object.entries(comparison.deltas)
          .filter(
            ([metric, delta]) =>
              hasMeaningfulTenPercentBaseline(comparison, metric) &&
              delta.percent !== null &&
              delta.percent > 10
          )
          .map(
            ([metric, delta]) =>
              `${comparison.provider ?? "sqlite3"}/${comparison.workload}/${metric} regressed ${delta.percent.toFixed(2)}%.`
          )
  );
  for (const target of declaredTargets) {
    const comparison = comparisons.find(
      (entry) =>
        entry.workload === target.workload &&
        (entry.provider ?? "sqlite3") ===
          (target.provider ?? "sqlite3") &&
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
  const significantRegressions = comparisons.flatMap((comparison) =>
    comparison.mode === "retained"
      ? []
      : Object.entries(comparison.deltas)
          .filter(([, delta]) => delta.significantRegression)
          .map(
            ([metric]) =>
              `${comparison.provider ?? "sqlite3"}/${comparison.workload}/${comparison.stage}/${comparison.mode}/${metric} regressed beyond 2×MAD.`
          )
  );
  reasons.push(...significantRegressions);
  reasons.push(...fullRegressions);
  return {
    eligible: reasons.length === 0,
    rule: "Every explicitly declared target metric must improve by more than 2×MAD; no non-retained metric may regress beyond 2×MAD; corresponding full stages and retained peak RSS must stay within the applicable 10% ceiling.",
    twoMadReportedPerMetric: true,
    tenPercentEndToEndCeilingPassed: fullRegressions.length === 0,
    reasons,
  };
}
