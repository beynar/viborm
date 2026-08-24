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

export function measuredFields(mode) {
  if (mode === "alloc") {
    return ["allocatedBytesPerOperation", "allocatedBytesPerRow"];
  }
  if (mode === "cpu") {
    return ["cpuMicrosecondsPerOperation", "wallMicrosecondsPerOperation"];
  }
  if (mode === "retained") {
    return ["retainedBytesPerOperation", "retainedBytesPerRow"];
  }
  throw new Error(`Unknown measurement mode: ${mode}`);
}

export function aggregateTarget(target, samples) {
  const byCheckout = Object.fromEntries(
    ["baseline", "candidate"].map((label) => {
      const checkoutSamples = samples.filter(
        (sample) => sample.checkout === label
      );
      const metrics = Object.fromEntries(
        measuredFields(target.mode).map((field) => [
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
    measuredFields(target.mode).map((field) => {
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
          percent:
            baseline === 0 ? null : ((candidate - baseline) / baseline) * 100,
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
    byCheckout,
    deltas,
  };
}

export function verifyCrossStageSemantics(samples) {
  const workloads = new Set(samples.map((sample) => sample.workload));
  for (const workload of workloads) {
    const digests = new Set(
      samples
        .filter((sample) => sample.workload === workload)
        .map((sample) => sample.output.semanticDigest)
    );
    if (digests.size !== 1 || digests.has(undefined)) {
      throw new Error(`${workload} changed semantic digest across stages`);
    }
  }
  const targets = new Set(
    samples.map((sample) =>
      JSON.stringify([sample.workload, sample.stage, sample.mode])
    )
  );
  for (const serializedTarget of targets) {
    const [workload, stage, mode] = JSON.parse(serializedTarget);
    const checksums = new Set(
      samples
        .filter(
          (sample) =>
            sample.workload === workload &&
            sample.stage === stage &&
            sample.mode === mode
        )
        .map((sample) => sample.output.measurement.checksum)
    );
    if (checksums.size !== 1 || checksums.has(undefined)) {
      throw new Error(
        `${workload}/${stage}/${mode} changed semantic checksum across replicates`
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
}) {
  const reasons = [];
  if (smoke) reasons.push("Smoke mode uses one replicate.");
  if (hasOverrides)
    reasons.push("Iteration or warmup overrides were supplied.");
  if (declaredTargets.length === 0) {
    reasons.push("No target metric contract was declared.");
  }
  const targetedWorkloads = new Set(
    declaredTargets.map((target) => target.workload)
  );
  for (const workload of targetedWorkloads) {
    const workloadTargets = targets.filter(
      (target) => target.workload === workload
    );
    for (const requiredMode of ["alloc", "cpu"]) {
      if (
        !workloadTargets.some(
          (target) => target.stage === "full" && target.mode === requiredMode
        )
      ) {
        reasons.push(
          `${workload} is missing corresponding full/${requiredMode} evidence.`
        );
      }
    }
  }
  const fullRegressions = comparisons.flatMap((comparison) =>
    comparison.stage !== "full"
      ? []
      : Object.entries(comparison.deltas)
          .filter(([, delta]) => delta.percent !== null && delta.percent > 10)
          .map(
            ([metric, delta]) =>
              `${comparison.workload}/${metric} regressed ${delta.percent.toFixed(2)}%.`
          )
  );
  for (const target of declaredTargets) {
    const comparison = comparisons.find(
      (entry) =>
        entry.workload === target.workload &&
        entry.stage === target.stage &&
        entry.mode === target.mode
    );
    const delta = comparison?.deltas[target.metric];
    if (!delta?.significantImprovement) {
      reasons.push(
        `${target.workload}/${target.stage}/${target.mode}/${target.metric} did not improve by more than 2×MAD.`
      );
    }
  }
  const significantRegressions = comparisons.flatMap((comparison) =>
    Object.entries(comparison.deltas)
      .filter(([, delta]) => delta.significantRegression)
      .map(
        ([metric]) =>
          `${comparison.workload}/${comparison.stage}/${comparison.mode}/${metric} regressed beyond 2×MAD.`
      )
  );
  reasons.push(...significantRegressions);
  reasons.push(...fullRegressions);
  return {
    eligible: reasons.length === 0,
    rule: "Every explicitly declared target metric must improve by more than 2×MAD; no measured metric may regress beyond 2×MAD; corresponding full stages must stay within the 10% ceiling.",
    twoMadReportedPerMetric: true,
    tenPercentEndToEndCeilingPassed: fullRegressions.length === 0,
    reasons,
  };
}
