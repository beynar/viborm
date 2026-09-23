import type { ValidationResult } from "../types";
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
