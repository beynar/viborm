/** One hostile-input boundary for the public down() selector. */

import { MigrationError, VibORMErrorCode } from "../errors";
import { snapshotExactRecord } from "./input-boundary";
import type { StateSelector } from "./v1-types";

export interface NormalizedDownOptions {
  readonly steps: number;
  readonly to?: StateSelector;
  readonly dryRun: boolean;
}

export function normalizeDownOptions(options: unknown): NormalizedDownOptions {
  const record = snapshotExactRecord(
    options,
    ["steps", "to", "dryRun"],
    "down options",
    refuseDownOptions
  );
  const { steps, to, dryRun } = record;
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
  return Object.freeze({
    steps: normalizedSteps,
    ...(to === undefined ? {} : { to: normalizeStateSelector(to) }),
    dryRun: dryRun === true,
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
  const key = keys[0];
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

function refuseDownOptions(message: string, cause?: Error): never {
  throw new MigrationError(message, VibORMErrorCode.INVALID_INPUT, { cause });
}
