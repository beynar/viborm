import type { ValidationResult, VibSchema } from "../types";
import { geoLatitude, geoLongitude, validateGeoPoint } from "./geo-point-codec";
import {
  GEO_BOUNDS_KEYS,
  GEO_POLYGON_MIN_RING_POINTS,
  type GeoArea,
  type GeoBounds,
  type GeoPoint,
  type GeoPolygon,
} from "./geo-values";
import {
  createSchema,
  fail,
  ok,
  validateArray,
  validateSchema,
} from "./helpers";
import { object } from "./object";
import { optional } from "./optional";

export type { GeoArea, GeoBounds, GeoPolygon } from "./geo-values";

const OUTWARD_BOUND_DEGREES = 1e-10;

/** The fixed spherical Earth model shared by portable GeoPoint distance SQL. */
export const GEO_POINT_EARTH_RADIUS_METERS = 6_371_008.8;

/**
 * Construct the smallest conservative latitude/longitude rectangle around a
 * trusted spherical distance cap. The exact distance predicate remains the
 * membership owner; this rectangle is only an index-friendly superset.
 */
export function geoBoundsForDistance(
  point: GeoPoint,
  meters: number
): GeoBounds {
  if (meters <= 0) {
    return {
      south: point.latitude,
      west: point.longitude,
      north: point.latitude,
      east: point.longitude,
    };
  }

  const angularRadius = meters / GEO_POINT_EARTH_RADIUS_METERS;
  if (angularRadius >= Math.PI) {
    return { south: -90, west: -180, north: 90, east: 180 };
  }

  const latitudeRadians = (point.latitude * Math.PI) / 180;
  const latitudeDelta = (angularRadius * 180) / Math.PI;
  const south = Math.max(
    -90,
    point.latitude - latitudeDelta - OUTWARD_BOUND_DEGREES
  );
  const north = Math.min(
    90,
    point.latitude + latitudeDelta + OUTWARD_BOUND_DEGREES
  );
  if (south === -90 || north === 90) {
    return { south, west: -180, north, east: 180 };
  }

  const longitudeDelta =
    (Math.asin(
      Math.min(1, Math.sin(angularRadius) / Math.cos(latitudeRadians))
    ) *
      180) /
      Math.PI +
    OUTWARD_BOUND_DEGREES;
  return {
    south,
    west: normalizeLongitude(point.longitude - longitudeDelta),
    north,
    east: normalizeLongitude(point.longitude + longitudeDelta),
  };
}

function normalizeLongitude(longitude: number): number {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

const boundsRecord = object(
  {
    [GEO_BOUNDS_KEYS[0]]: geoLatitude,
    [GEO_BOUNDS_KEYS[1]]: geoLongitude,
    [GEO_BOUNDS_KEYS[2]]: geoLatitude,
    [GEO_BOUNDS_KEYS[3]]: geoLongitude,
  },
  { partial: false }
);

export function validateGeoBounds(value: unknown): ValidationResult<GeoBounds> {
  const bounds = validateSchema(boundsRecord, value);
  if (bounds.issues) return bounds;
  // An inverted rectangle is no database error: the latitude arm of
  // withinBounds (adapters/shared/geo-point.ts) would silently match nothing.
  if (bounds.value.south > bounds.value.north) {
    return fail("GeoBounds south must be less than or equal to north", [
      "south",
    ]);
  }
  return bounds;
}

/**
 * A ring is its vertices in input order, at least GEO_POLYGON_MIN_RING_POINTS
 * of them: the JSON Schema states that minimum, and closedRing
 * (adapters/shared/geo-point.ts) reads the first vertex of every ring.
 */
function validateRing(value: unknown): ValidationResult<GeoPoint[]> {
  const ring = validateArray(value, validateGeoPoint);
  if (ring.issues || ring.value.length >= GEO_POLYGON_MIN_RING_POINTS) {
    return ring;
  }
  return fail(
    `A GeoPolygon ring needs at least ${GEO_POLYGON_MIN_RING_POINTS} vertices`
  );
}

const polygonRecord = object(
  {
    outer: createSchema("array", validateRing),
    holes: optional(
      createSchema("array", (value) => validateArray(value, validateRing))
    ),
  },
  { partial: false }
);

/**
 * The polygon's shape only: exact keys, finite in-range vertices, at least
 * three per ring, in input order. Geometric validity (self-intersection, hole
 * placement, poles, extent) and the interior a winding encloses are the
 * database's execution facts.
 */
export function validateGeoPolygon(
  value: unknown
): ValidationResult<GeoPolygon> {
  const polygon = validateSchema(polygonRecord, value);
  if (polygon.issues) return polygon;
  const { outer, holes } = polygon.value;
  // An empty and an absent holes list emit the same GeoJSON; one spelling
  // keeps them one validated argument, and so one cache key.
  return ok(holes?.length ? { outer, holes } : { outer });
}

const areaRecord = object({
  bounds: createSchema("object", validateGeoBounds),
  polygon: createSchema("object", validateGeoPolygon),
});

export function validateGeoArea(value: unknown): ValidationResult<GeoArea> {
  const area = validateSchema(areaRecord, value);
  if (area.issues) return area;
  const { bounds, polygon } = area.value;
  // Exactly one variant: buildGeoPointWithin (query-engine/builders/
  // geo-point-builder.ts) branches on `"bounds" in area`, so a second variant
  // would be dropped silently and a missing one would reach geoPolygonJson as
  // undefined and throw a TypeError instead of a database error.
  if (bounds && !polygon) return ok({ bounds });
  if (polygon && !bounds) return ok({ polygon });
  return fail("Expected GeoArea with exactly one of bounds or polygon");
}

export function geoAreaSchema(): VibSchema<GeoArea, GeoArea> {
  return createSchema("geo_area", validateGeoArea);
}
