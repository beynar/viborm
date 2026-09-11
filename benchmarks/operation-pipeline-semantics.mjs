/** Deterministic semantic evidence computed outside timed benchmark stages. */

import { createHash } from "node:crypto";
import { deepStrictEqual } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/** Complete executable source/protocol fingerprint for calibration, never a keep waiver. */
export function calibrationSourceIdentity(directory, includeBuild = false) {
  const visit = (folder) =>
    readdirSync(resolve(directory, folder), { withFileTypes: true }).flatMap(
      (entry) =>
        entry.isDirectory()
          ? visit(`${folder}/${entry.name}`)
          : /\.(?:[cm]?[jt]sx?|json)$/.test(entry.name)
            ? [`${folder}/${entry.name}`]
            : []
    );
  const paths = [
    ...visit("src"),
    ...visit("benchmarks"),
    ...visit("scripts"),
    ...(includeBuild ? visit("dist") : []),
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "tsdown.config.ts",
    "biome.jsonc",
  ].sort();
  const hash = createHash("sha256");
  const files = paths.map((file) => {
    const contents = readFileSync(resolve(directory, file));
    const sha256 = createHash("sha256").update(contents).digest("hex");
    hash.update(file).update("\0").update(sha256).update("\0");
    return { file, sha256 };
  });
  return { sha256: hash.digest("hex"), includeBuild, files };
}

/** Only the observed outer error owns diagnostic identity; opaque causes stay exact. */
function comparableOutcome(outcome) {
  if (outcome.kind !== "failure") return outcome;
  const { failure } = outcome;
  if (!failure.meta || !Object.hasOwn(failure.meta, "correlationId"))
    return outcome;
  const identity = failure.meta.correlationId;
  if (typeof identity !== "string" || identity.length === 0)
    throw new Error("Observed failure has an invalid correlation identity");
  return {
    ...outcome,
    failure: {
      ...failure,
      meta: Object.assign(
        Object.create(Object.getPrototypeOf(failure.meta)),
        failure.meta,
        { correlationId: "<diagnostic identity>" }
      ),
    },
  };
}

/** @param {import('../tests/raptor3/harness/protocol.ts').RunObservation} baseline */
export function assertEquivalentRunObservations(label, baseline, candidate) {
  for (const field of [
    "outcome",
    "initial",
    "final",
    "defaults",
    "reachedCuts",
  ]) {
    if (!Object.hasOwn(baseline, field) || !Object.hasOwn(candidate, field)) {
      throw new Error(`${label} omitted required observation ${field}`);
    }
    deepStrictEqual(
      field === "outcome"
        ? comparableOutcome(candidate[field])
        : candidate[field],
      field === "outcome"
        ? comparableOutcome(baseline[field])
        : baseline[field],
      `${label} changed ${field}`
    );
  }
  deepStrictEqual(
    candidate.subsequentOutcomes?.map(comparableOutcome),
    baseline.subsequentOutcomes?.map(comparableOutcome),
    `${label} changed subsequent public operation outcomes`
  );
}

/** Physical repeatability stays engine-local; semantic observations compare across engines. */
export function verifyRewriteBenchmarkEvidence(samples) {
  if (samples.length === 0) throw new Error("No semantic benchmark evidence");
  const observations = new Map();
  const physical = new Map();
  for (const sample of samples) {
    const { output } = sample;
    if (!output.contractObservation)
      throw new Error(
        `${sample.workload} omitted independent contractObservation`
      );
    if (
      !output.witness ||
      !Number.isInteger(output.witness.statementCount) ||
      output.witness.statementCount < 1 ||
      output.witness.statements.length !== output.witness.statementCount
    ) {
      throw new Error(`${sample.workload} omitted a complete physical witness`);
    }
    const meaningKey = JSON.stringify([sample.provider, sample.workload]);
    const previous = observations.get(meaningKey);
    if (previous)
      assertEquivalentRunObservations(
        meaningKey,
        previous,
        output.contractObservation
      );
    else {
      assertEquivalentRunObservations(
        meaningKey,
        output.contractObservation,
        output.contractObservation
      );
      observations.set(meaningKey, output.contractObservation);
    }
    const physicalKey = JSON.stringify([
      sample.checkout,
      sample.provider,
      sample.workload,
      sample.stage,
      sample.mode,
    ]);
    const previousPhysical = physical.get(physicalKey);
    if (previousPhysical) {
      deepStrictEqual(
        output.witness,
        previousPhysical.witness,
        `${physicalKey} changed physical witness`
      );
      deepStrictEqual(
        output.measurement.checksum,
        previousPhysical.measurement.checksum,
        `${physicalKey} changed checksum`
      );
    } else physical.set(physicalKey, output);
  }
}

function canonicalize(value) {
  if (value === undefined) return ["undefined"];
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (value instanceof Date) return ["date", value.toISOString()];
  if (value instanceof Uint8Array) return ["bytes", ...value];
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

export function semanticDigest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function assertSemanticDigest(label, canonicalValue, comparedValue) {
  const canonical = semanticDigest(canonicalValue);
  const compared = semanticDigest(comparedValue);
  if (canonical !== compared) {
    throw new Error(
      `${label} semantic digest mismatch: ${canonical} vs ${compared}`
    );
  }
  return canonical;
}

export function freezeRawResult(raw) {
  const rows = raw.rows.map((row) => Object.freeze(row));
  return Object.freeze({
    rows: Object.freeze(rows),
    rowCount: raw.rowCount,
    ...(raw.insertId === undefined ? {} : { insertId: raw.insertId }),
  });
}

export function freezeRawResults(results) {
  return Object.freeze(results.map(freezeRawResult));
}
