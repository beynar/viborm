/** One hostile-input boundary for the public down() selector. */

import { MigrationError, VibORMErrorCode } from "../errors";
import { snapshotExactRecord } from "./input-boundary";
import type { ResolveCallback } from "./types";
import type { StateSelector } from "./v1-types";

export interface NormalizedDownOptions {
  readonly steps: number;
  readonly to?: StateSelector;
  readonly dryRun: boolean;
  readonly expectRevision?: number;
  readonly resolve?: ResolveCallback;
}

export function normalizeDownOptions(options: unknown): NormalizedDownOptions {
  const record = snapshotExactRecord(
    options,
    ["steps", "to", "dryRun", "expectRevision", "resolve"],
    "down options",
    refuseDownOptions
  );
  const { steps, to, dryRun, expectRevision, resolve } = record;
  if (steps !== undefined && to !== undefined) {
    return refuseDownOptions("down accepts either steps or to, not both");
  }
  let normalizedSteps = 1;
  if (steps !== undefined) {
    if (
      typeof steps !== "number" ||
      !Number.isSafeInteger(steps) ||
      steps <= 0
    ) {
      return refuseDownOptions("down steps must be a positive safe integer");
    }
    normalizedSteps = steps;
  }
  if (dryRun !== undefined && typeof dryRun !== "boolean") {
    return refuseDownOptions("down dryRun must be a boolean");
  }
  if (
    expectRevision !== undefined &&
    (typeof expectRevision !== "number" ||
      !Number.isSafeInteger(expectRevision) ||
      expectRevision <= 0)
  ) {
    return refuseDownOptions(
      "down expectRevision must be a positive safe integer"
    );
  }
  if (resolve !== undefined && !isResolveCallback(resolve)) {
    return refuseDownOptions("down resolve must be a function");
  }
  return Object.freeze({
    steps: normalizedSteps,
    ...(to === undefined ? {} : { to: normalizeStateSelector(to) }),
    dryRun: dryRun === true,
    ...(expectRevision === undefined ? {} : { expectRevision }),
    ...(resolve === undefined ? {} : { resolve }),
  });
}

function normalizeStateSelector(value: unknown): StateSelector {
  const record = snapshotExactRecord(
    value,
    ["id", "prefix", "name"],
    "down to",
    refuseDownOptions
  );
  const keys = Object.keys(record);
  if (keys.length !== 1) {
    return refuseDownOptions("down to must contain exactly one selector key");
  }
  // The sole OWN key. `"id" in record` walks the prototype chain, so a polluted
  // Object.prototype.id made `down({ to: { name: "baseline" } })` select the
  // inherited id and roll back to the wrong state.
  const [key] = keys;
  if (!key) {
    return refuseDownOptions("down to must contain exactly one selector key");
  }
  const selected = record[key];
  if (typeof selected !== "string" || selected.length === 0) {
    return refuseDownOptions(`down to.${key} must be a non-empty string`);
  }
  if (key === "id") return { id: selected };
  if (key === "prefix") return { prefix: selected };
  return { name: selected };
}

function isResolveCallback(value: unknown): value is ResolveCallback {
  return typeof value === "function";
}

function refuseDownOptions(message: string, cause?: Error): never {
  throw new MigrationError(message, VibORMErrorCode.INVALID_INPUT, { cause });
}
