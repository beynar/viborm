import type { ValidationFailure, ValidationResult } from "../types";
import {
  GEO_LATITUDE_MAX,
  GEO_LATITUDE_MIN,
  GEO_LONGITUDE_MAX,
  GEO_LONGITUDE_MIN,
  GEO_POINT_KEYS,
  type GeoPoint,
} from "./geo-values";
import { createSchema, fail, ok, validateSchema } from "./helpers";
import { validateNumber } from "./number";
import { object } from "./object";

export type { GeoPoint } from "./geo-values";

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

/**
 * One finite coordinate inside its inclusive range, with -0 read as 0: the
 * type VibORM returns has no -0, and points decode provider rows and cache
 * snapshots through this same schema.
 */
function geoCoordinate(label: string, low: number, high: number) {
  return createSchema<number, number>("number", (value) => {
    const coordinate = validateNumber(value);
    if (coordinate.issues) return coordinate;
    if (coordinate.value < low || coordinate.value > high) {
      return fail(`${label} must be between ${low} and ${high}`);
    }
    return ok(Object.is(coordinate.value, -0) ? 0 : coordinate.value);
  });
}

export const geoLongitude = geoCoordinate(
  "Longitude",
  GEO_LONGITUDE_MIN,
  GEO_LONGITUDE_MAX
);
export const geoLatitude = geoCoordinate(
  "Latitude",
  GEO_LATITUDE_MIN,
  GEO_LATITUDE_MAX
);

const pointRecord = object(
  { [GEO_POINT_KEYS[0]]: geoLongitude, [GEO_POINT_KEYS[1]]: geoLatitude },
  { partial: false }
);

/** Validate the one public GeoPoint representation into a fresh record. */
export function validateGeoPoint(value: unknown): ValidationResult<GeoPoint> {
  const point = validateSchema(pointRecord, value);
  if (point.issues) return point;
  const { longitude, latitude } = point.value;
  // -180 and +180 are one meridian. The SQLite CHECK
  // (migrations/drivers/sqlite/geo-point.ts) refuses -180, and the coordinate
  // predicates in adapters/shared/geo-point.ts assume the +180 spelling.
  return ok({
    longitude: longitude === GEO_LONGITUDE_MIN ? GEO_LONGITUDE_MAX : longitude,
    latitude,
  });
}
