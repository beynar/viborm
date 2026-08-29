/** Settles one hostile record into an exact immutable property snapshot. */

import { errorCause } from "../drivers/shared/driver-options";

export function snapshotExactRecord(
  value: unknown,
  allowed: readonly string[],
  label: string,
  refuse: (message: string, cause?: Error) => never
): Readonly<Record<string, unknown>> {
  let objectValue: object | undefined;
  let keys: readonly PropertyKey[] = [];
  try {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      objectValue = value;
      keys = Reflect.ownKeys(value);
    }
  } catch (failure) {
    return refuse(`${label} could not be inspected`, errorCause(failure));
  }
  if (!objectValue) return refuse(`${label} must be an object`);
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.includes(key)) {
      return refuse(`${label} contains an unknown key`);
    }
    try {
      snapshot[key] = Reflect.get(objectValue, key);
    } catch (failure) {
      return refuse(`${label}.${key} could not be read`, errorCause(failure));
    }
  }
  return Object.freeze(snapshot);
}
