import type { ValidationFailure, ValidationResult } from "../types";
import type { GeoPoint } from "./geo-values";
import { fail, ok } from "./helpers";

export type { GeoPoint } from "./geo-values";

export const GEO_POINT_KEYS = ["longitude", "latitude"] as const;
export const GEO_LONGITUDE_MIN = -180;
export const GEO_LONGITUDE_MAX = 180;
export const GEO_LATITUDE_MIN = -90;
export const GEO_LATITUDE_MAX = 90;

type GeoProperty = string | symbol;

export interface ExactGeoRecord {
  readonly values: Readonly<Record<string, unknown>>;
}

interface GeoRecordSnapshot extends ExactGeoRecord {
  readonly keys: readonly string[];
}

/** Prefix the first issue from one geographic value boundary. */
export function prefixGeoFailure(
  failure: ValidationFailure,
  path: readonly PropertyKey[]
): ValidationFailure {
  const issue = failure.issues[0]!;
  return {
    issues: [
      {
        message: issue.message,
        path: issue.path
          ? [...path, ...(issue.path as readonly PropertyKey[])]
          : [...path],
      },
    ],
  };
}

/**
 * Snapshot one exact plain geographic operand without trusting its reflection.
 *
 * This is shared by the point and area codecs because both public values make
 * the same promise: own string keys only, one property read, and no prototype
 * vocabulary. The returned record is ours; no downstream consumer re-enters
 * the caller's object.
 */
function snapshotGeoRecord(
  source: unknown,
  label: string
): ValidationResult<GeoRecordSnapshot> {
  let candidate: object;
  try {
    if (
      source === null ||
      typeof source !== "object" ||
      Array.isArray(source)
    ) {
      return fail(`Expected ${label} object`);
    }
    candidate = source;
  } catch {
    return fail(`Could not inspect ${label}`);
  }

  let prototype: object | null;
  let keys: GeoProperty[];
  try {
    prototype = Reflect.getPrototypeOf(candidate);
    keys = Reflect.ownKeys(candidate);
  } catch {
    return fail(`Could not inspect ${label}`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(`Expected ${label} to be a plain object`);
  }

  const stringKeys: string[] = [];
  for (const key of keys) {
    if (typeof key !== "string") {
      return fail(`Expected ${label} to use string keys only`);
    }
    stringKeys.push(key);
  }

  const values: Record<string, unknown> = Object.create(null);
  for (const key of stringKeys) {
    try {
      if (!Object.hasOwn(candidate, key)) {
        return fail(`Could not snapshot ${label}`);
      }
      values[key] = Reflect.get(candidate, key);
    } catch {
      return fail(`Could not read ${label}.${key}`, [key]);
    }
  }
  return ok({ keys: stringKeys, values });
}

export function readExactGeoRecord(
  source: unknown,
  expectedKeys: readonly string[],
  label: string
): ValidationResult<ExactGeoRecord> {
  const snapshot = snapshotGeoRecord(source, label);
  if (snapshot.issues) return snapshot;
  const expected = new Set(expectedKeys);
  if (
    snapshot.value.keys.length !== expected.size ||
    snapshot.value.keys.some((key) => !expected.has(key))
  ) {
    return fail(`Expected ${label} with exactly ${expectedKeys.join(" and ")}`);
  }
  return ok({ values: snapshot.value.values });
}

export function readGeoRecordWithOptional(
  source: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly [string, ...string[]],
  label: string
): ValidationResult<ExactGeoRecord> {
  const snapshot = snapshotGeoRecord(source, label);
  if (snapshot.issues) return snapshot;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    requiredKeys.some((key) => !snapshot.value.keys.includes(key)) ||
    snapshot.value.keys.some((key) => !allowed.has(key))
  ) {
    return fail(
      `Expected ${label} with ${requiredKeys.join(" and ")} and optional ${optionalKeys.join(" and ")}`
    );
  }
  return ok({ values: snapshot.value.values });
}

export function readGeoVariantRecord(
  source: unknown,
  variants: readonly string[],
  label: string
): ValidationResult<{ readonly variant: string; readonly value: unknown }> {
  const snapshot = snapshotGeoRecord(source, label);
  if (snapshot.issues) {
    return fail(
      `Expected ${label} with exactly one of ${variants.join(" or ")}`
    );
  }
  if (
    snapshot.value.keys.length !== 1 ||
    !variants.includes(snapshot.value.keys[0]!)
  ) {
    return fail(
      `Expected ${label} with exactly one of ${variants.join(" or ")}`
    );
  }
  const variant = snapshot.value.keys[0]!;
  return ok({ variant, value: snapshot.value.values[variant] });
}

function canonicalCoordinate(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

/** Validate and snapshot the one public GeoPoint representation. */
export function validateGeoPoint(value: unknown): ValidationResult<GeoPoint> {
  const snapshot = readExactGeoRecord(value, GEO_POINT_KEYS, "GeoPoint");
  if (snapshot.issues) return snapshot;

  const longitude = snapshot.value.values.longitude;
  const latitude = snapshot.value.values.latitude;
  if (typeof longitude !== "number" || !Number.isFinite(longitude)) {
    return fail("Expected finite longitude", ["longitude"]);
  }
  if (longitude < GEO_LONGITUDE_MIN || longitude > GEO_LONGITUDE_MAX) {
    return fail(
      `Longitude must be between ${GEO_LONGITUDE_MIN} and ${GEO_LONGITUDE_MAX}`,
      ["longitude"]
    );
  }
  if (typeof latitude !== "number" || !Number.isFinite(latitude)) {
    return fail("Expected finite latitude", ["latitude"]);
  }
  if (latitude < GEO_LATITUDE_MIN || latitude > GEO_LATITUDE_MAX) {
    return fail(
      `Latitude must be between ${GEO_LATITUDE_MIN} and ${GEO_LATITUDE_MAX}`,
      ["latitude"]
    );
  }

  return ok({
    longitude:
      longitude === GEO_LONGITUDE_MIN
        ? GEO_LONGITUDE_MAX
        : canonicalCoordinate(longitude),
    latitude: canonicalCoordinate(latitude),
  });
}
