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

export function checkoutOrder(comparison, replicate) {
  if (comparison === "candidate-only") return ["candidate"];
  if (comparison !== "baseline-candidate") {
    throw new Error(`Unknown comparison kind: ${comparison}`);
  }
  return replicate % 2 === 0
    ? ["baseline", "candidate"]
    : ["candidate", "baseline"];
}

const RETAINED_LEVEL_FIELDS = new Set(["peakRssBytes"]);
const PER_OPERATION_SUFFIX_PATTERN = /PerOperation$/;
const FIXED_DECIMAL_LOCK_ENTRIES = Object.freeze([
  "      decimal.js:\n        specifier: 10.6.0\n        version: 10.6.0\n",
  "\n  decimal.js@10.6.0:\n    resolution: {integrity: sha512-YpgQiITW3JXGntzdUmyUR1V812Hn8T1YVXhCu+wO3OpS4eU9l4YdD3qjyiKdV6mvV29zapkMeD390UVEf2lkUg==}\n",
  "\n  decimal.js@10.6.0: {}\n",
]);

export function isExactFixedDecimalLockDelta(baseline, candidate) {
  if (baseline.includes("decimal.js")) return false;
  let normalizedCandidate = candidate;
  for (const entry of FIXED_DECIMAL_LOCK_ENTRIES) {
    const first = normalizedCandidate.indexOf(entry);
    if (first < 0 || normalizedCandidate.indexOf(entry, first + 1) >= 0) {
      return false;
    }
    normalizedCandidate = normalizedCandidate.replace(entry, "");
  }
  return normalizedCandidate === baseline;
}

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
  const perRow = budget.metric.replace(PER_OPERATION_SUFFIX_PATTERN, "PerRow");
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
export function diagnosticMeasurementCounts(definition, mode) {
  const rowsPerOperation = definition.rowsPerOperation;
  const scaleDivisor = Math.max(1, rowsPerOperation / 20);
  const iterations =
    mode === "retained" && definition.evidenceProgram === "fixed-decimal"
      ? 10
      : mode === "retained"
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

export function aggregateCandidateTarget(target, samples) {
  if (
    samples.length === 0 ||
    samples.some((sample) => sample.checkout !== "candidate")
  ) {
    throw new Error(
      `${target.provider ?? "sqlite3"}/${target.workload}/${target.stage}/${target.mode} candidate-only evidence must contain candidate samples only`
    );
  }
  const responseAvailability = new Set(
    samples.map(
      (sample) =>
        typeof sample.output.measurement.responseBytesPerOperation === "number"
    )
  );
  if (responseAvailability.size !== 1) {
    throw new Error(
      `${target.provider ?? "sqlite3"}/${target.workload}/${target.stage}/${target.mode} changed response-byte availability across candidate samples`
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
      `${target.provider ?? "sqlite3"}/${target.workload}/${target.stage}/${target.mode} changed response-byte source across candidate samples`
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
  return {
    ...target,
    checkout: "candidate",
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
    metrics: Object.fromEntries(
      fields.map((field) => [
        field,
        summarize(samples.map((sample) => sample.output.measurement[field])),
      ])
    ),
    samples: samples.map((sample) => sample.output),
  };
}

export function catalogRegressionCeilings(targets, workloads) {
  return targets.flatMap((target) => {
    const maximumPercent = workloads[target.workload]?.regressionCeilingPercent;
    if (!(target.stage === "full" && Number.isFinite(maximumPercent))) {
      return [];
    }
    const metric =
      target.mode === "alloc"
        ? "allocatedBytesPerOperation"
        : target.mode === "cpu"
          ? "cpuMicrosecondsPerOperation"
          : undefined;
    return metric
      ? [
          {
            ...target,
            metric,
            maximumPercent,
            source: "catalog",
          },
        ]
      : [];
  });
}

const FIXED_DECIMAL_MODES = Object.freeze(["alloc", "cpu", "retained"]);
const FIXED_DECIMAL_PROVIDER_MODES = Object.freeze(["alloc", "cpu"]);
const FIXED_DECIMAL_METRICS = Object.freeze([
  Object.freeze({
    mode: "alloc",
    metric: "allocatedBytesPerOperation",
    usesProviderDelta: true,
  }),
  Object.freeze({
    mode: "cpu",
    metric: "cpuMicrosecondsPerOperation",
    usesProviderDelta: true,
  }),
  Object.freeze({
    mode: "cpu",
    metric: "wallMicrosecondsPerOperation",
    usesProviderDelta: true,
  }),
  Object.freeze({ mode: "retained", metric: "retainedBytesPerOperation" }),
  Object.freeze({ mode: "retained", metric: "releasedBytesPerOperation" }),
  Object.freeze({
    mode: "retained",
    metric: "peakRssBytes",
    nonAdditive: true,
  }),
  Object.freeze({
    mode: "retained",
    metric: "peakRssGrowthBytes",
    nonAdditive: true,
  }),
]);

function scaleSummary(summary, divisor) {
  return {
    median: summary.median / divisor,
    mad: summary.mad / divisor,
    min: summary.min / divisor,
    max: summary.max / divisor,
  };
}

function candidateMetricSummary(measurement, metric) {
  return (
    measurement?.metrics?.[metric] ??
    measurement?.byCheckout?.candidate?.metrics?.[metric]
  );
}

function candidateMeasurement(measurements, provider, workload, stage, mode) {
  return measurements.find(
    (measurement) =>
      measurement.provider === provider &&
      measurement.workload === workload &&
      measurement.stage === stage &&
      measurement.mode === mode
  );
}

function decimalAttributionMetric({
  provider,
  cardinality,
  metric,
  nonAdditive,
  decimal,
  textControl,
  constructorFloor,
  providerDecimal,
  providerTextControl,
  usesProviderDelta,
}) {
  const isSignedRetained = metric === "retainedBytesPerOperation";
  const nonAdditiveControl =
    textControl.median >= constructorFloor.median
      ? textControl
      : constructorFloor;
  const providerDelta = usesProviderDelta
    ? {
        stage: "provider-execute",
        decimal: providerDecimal,
        textControl: providerTextControl,
        median: providerDecimal.median - providerTextControl.median,
        twoMadThreshold: 2 * (providerDecimal.mad + providerTextControl.mad),
      }
    : undefined;
  const excessMedian = nonAdditive
    ? decimal.median - nonAdditiveControl.median
    : decimal.median -
      textControl.median -
      (providerDelta?.median ?? 0) -
      constructorFloor.median;
  const twoMadThreshold = nonAdditive
    ? 2 * (decimal.mad + nonAdditiveControl.mad)
    : 2 *
      (decimal.mad +
        textControl.mad +
        (providerDecimal?.mad ?? 0) +
        (providerTextControl?.mad ?? 0) +
        constructorFloor.mad);
  const percentageBase = nonAdditive
    ? nonAdditiveControl.median
    : constructorFloor.median;
  const percentageApplied = !isSignedRetained && percentageBase !== 0;
  const tenPercentLimit = percentageApplied
    ? Math.abs(percentageBase) * 0.1
    : null;
  const passedNoise = excessMedian <= twoMadThreshold;
  const passedPercentage =
    tenPercentLimit === null || excessMedian <= tenPercentLimit;
  return {
    provider,
    cardinality,
    metric,
    formula: nonAdditive
      ? "decimal - max(text-control, constructor-floor)"
      : usesProviderDelta
        ? "decimal-full - text-full - (decimal-provider-execute - text-provider-execute) - constructor-floor"
        : "decimal - text-control - constructor-floor",
    decimal,
    textControl,
    constructorFloor,
    ...(providerDelta === undefined ? {} : { providerDelta }),
    excessMedian,
    twoMadThreshold,
    tenPercentLimit,
    percentageApplied,
    passedNoise,
    passedPercentage,
    passed: passedNoise && passedPercentage,
    ...(nonAdditive
      ? {}
      : {
          perRow: {
            decimal: scaleSummary(decimal, cardinality),
            textControl: scaleSummary(textControl, cardinality),
            constructorFloor: scaleSummary(constructorFloor, cardinality),
            excessMedian: excessMedian / cardinality,
            twoMadThreshold: twoMadThreshold / cardinality,
            tenPercentLimit:
              tenPercentLimit === null ? null : tenPercentLimit / cardinality,
          },
        }),
  };
}

/** Fixed candidate-only decimal acceptance; this is not a generic budget API. */
export function evaluateFixedDecimalCandidateGate({
  providers,
  measurements,
  workloads,
}) {
  const reasons = [];
  const fixedWorkloads = Object.entries(workloads).filter(
    ([, definition]) => definition.evidenceProgram === "fixed-decimal"
  );
  for (const provider of providers) {
    for (const [workload, definition] of fixedWorkloads) {
      if (!definition.providers.includes(provider)) {
        reasons.push(
          `${provider}/${workload} is not admitted by the fixed-decimal catalog.`
        );
        continue;
      }
      const requiredStage =
        definition.providerShape.kind === "fixed-decimal-floor"
          ? "decimal-construct"
          : "full";
      for (const mode of FIXED_DECIMAL_MODES) {
        const measurement = candidateMeasurement(
          measurements,
          provider,
          workload,
          requiredStage,
          mode
        );
        if (!measurement || measurement.status === "skipped") {
          reasons.push(
            `${provider}/${workload}/${requiredStage}/${mode} is missing fixed-decimal evidence${measurement?.reason ? `: ${measurement.reason}` : "."}`
          );
        }
      }
      if (definition.fixedDecimalAttribution !== undefined) {
        for (const transportWorkload of [
          workload,
          definition.fixedDecimalAttribution.textControlWorkload,
        ]) {
          for (const mode of FIXED_DECIMAL_PROVIDER_MODES) {
            const providerMeasurement = candidateMeasurement(
              measurements,
              provider,
              transportWorkload,
              "provider-execute",
              mode
            );
            if (
              !providerMeasurement ||
              providerMeasurement.status === "skipped"
            ) {
              reasons.push(
                `${provider}/${transportWorkload}/provider-execute/${mode} is missing fixed-decimal evidence${providerMeasurement?.reason ? `: ${providerMeasurement.reason}` : "."}`
              );
            }
          }
        }
      }
    }
  }

  const attribution = [];
  const decimalRows = fixedWorkloads.filter(
    ([, definition]) => definition.fixedDecimalAttribution !== undefined
  );
  for (const provider of providers) {
    for (const [decimalWorkload, definition] of decimalRows) {
      const cardinality = definition.rowsPerOperation;
      const { textControlWorkload, constructorFloorWorkload } =
        definition.fixedDecimalAttribution;
      for (const {
        mode,
        metric,
        nonAdditive = false,
        usesProviderDelta = false,
      } of FIXED_DECIMAL_METRICS) {
        const decimal = candidateMetricSummary(
          candidateMeasurement(
            measurements,
            provider,
            decimalWorkload,
            "full",
            mode
          ),
          metric
        );
        const textControl = candidateMetricSummary(
          candidateMeasurement(
            measurements,
            provider,
            textControlWorkload,
            "full",
            mode
          ),
          metric
        );
        const constructorFloor = candidateMetricSummary(
          candidateMeasurement(
            measurements,
            provider,
            constructorFloorWorkload,
            "decimal-construct",
            mode
          ),
          metric
        );
        const providerDecimal = usesProviderDelta
          ? candidateMetricSummary(
              candidateMeasurement(
                measurements,
                provider,
                decimalWorkload,
                "provider-execute",
                mode
              ),
              metric
            )
          : undefined;
        const providerTextControl = usesProviderDelta
          ? candidateMetricSummary(
              candidateMeasurement(
                measurements,
                provider,
                textControlWorkload,
                "provider-execute",
                mode
              ),
              metric
            )
          : undefined;
        if (
          !(decimal && textControl && constructorFloor) ||
          (usesProviderDelta && !(providerDecimal && providerTextControl))
        ) {
          continue;
        }
        const metricAttribution = decimalAttributionMetric({
          provider,
          cardinality,
          metric,
          nonAdditive,
          decimal,
          textControl,
          constructorFloor,
          providerDecimal,
          providerTextControl,
          usesProviderDelta,
        });
        attribution.push(metricAttribution);
        if (!metricAttribution.passed) {
          reasons.push(
            `${provider}/${decimalWorkload}/${metric} exceeded its fixed-decimal constructor-floor ${metricAttribution.percentageApplied ? "10% and " : ""}additive 2×MAD bound.`
          );
        }
      }
    }
  }

  const rowScaling = [];
  for (const provider of providers) {
    for (const { metric, nonAdditive = false } of FIXED_DECIMAL_METRICS) {
      const one = attribution.find(
        (entry) =>
          entry.provider === provider &&
          entry.cardinality === 1 &&
          entry.metric === metric
      );
      const many = attribution.find(
        (entry) =>
          entry.provider === provider &&
          entry.cardinality === 1000 &&
          entry.metric === metric
      );
      if (!(one && many)) continue;
      const scaledExcess = many.excessMedian - one.excessMedian;
      const twoMadThreshold = many.twoMadThreshold + one.twoMadThreshold;
      const percentageBase = (entry) =>
        nonAdditive
          ? Math.max(entry.textControl.median, entry.constructorFloor.median)
          : entry.constructorFloor.median;
      const percentageBaseDelta = percentageBase(many) - percentageBase(one);
      const percentageApplied =
        metric !== "retainedBytesPerOperation" && percentageBaseDelta !== 0;
      const tenPercentLimit = percentageApplied
        ? Math.abs(percentageBaseDelta) * 0.1
        : null;
      const passedNoise = scaledExcess <= twoMadThreshold;
      const passedPercentage =
        tenPercentLimit === null || scaledExcess <= tenPercentLimit;
      const scaling = {
        provider,
        metric,
        formula: "excess(1000 rows) - excess(1 row)",
        scaledExcess,
        twoMadThreshold,
        percentageBaseDelta,
        tenPercentLimit,
        percentageApplied,
        perAddedRow: {
          scaledExcess: scaledExcess / 999,
          twoMadThreshold: twoMadThreshold / 999,
          tenPercentLimit:
            tenPercentLimit === null ? null : tenPercentLimit / 999,
        },
        passedNoise,
        passedPercentage,
        passed: passedNoise && passedPercentage,
      };
      rowScaling.push(scaling);
      if (!scaling.passed) {
        reasons.push(
          `${provider}/fixed-decimal-row-1→1000/${metric} exceeded its candidate-only row-scaling ${percentageApplied ? "10% and " : ""}additive 2×MAD bound.`
        );
      }
    }
  }

  return {
    eligible: reasons.length === 0,
    rule: "For allocation, CPU, and wall time, candidate decimal full cost minus text full cost, their separately reported provider-execute delta, and the direct ORM-result Decimal construction floor must stay within 10% of that floor and additive 2×MAD. Released and signed retained heap keep the full/text/floor attribution; signed retained heap blocks only positive excess beyond additive 2×MAD. Peak RSS levels and growth use decimal minus max(control, floor). The 1→1000 excess must obey the same per-operation bounds.",
    attribution,
    rowScaling,
    reasons,
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
  const checkoutStages = new Set(
    samples.map((sample) =>
      JSON.stringify([
        sample.provider ?? "sqlite3",
        sample.workload,
        sample.stage,
        sample.checkout,
      ])
    )
  );
  for (const serializedCheckoutStage of checkoutStages) {
    const [provider, workload, stage, checkout] = JSON.parse(
      serializedCheckoutStage
    );
    const checkoutSamples = samples.filter(
      (sample) =>
        sample.workload === workload &&
        (sample.provider ?? "sqlite3") === provider &&
        sample.stage === stage &&
        sample.checkout === checkout
    );
    if (new Set(checkoutSamples.map((sample) => sample.mode)).size < 2) {
      continue;
    }
    const checksums = checkoutSamples.map(
      (sample) => sample.output.measurement.checksum / sample.output.iterations
    );
    if (
      checksums.some((checksum) => !Number.isFinite(checksum)) ||
      new Set(checksums).size !== 1
    ) {
      throw new Error(
        `${provider}/${workload}/${stage}/${checkout} changed semantic checksum across modes`
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
    [...declaredTargets, ...declaredCeilings, ...declaredBudgets].map(
      (target) =>
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
