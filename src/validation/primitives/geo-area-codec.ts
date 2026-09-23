import type { ValidationResult, VibSchema } from "../types";
import {
  geoLatitude,
  geoLongitude,
  prefixGeoFailure,
  readGeoRecordWithOptional,
  validateGeoPoint,
} from "./geo-point-codec";
import {
  GEO_BOUNDS_KEYS,
  GEO_LATITUDE_MAX,
  GEO_POLYGON_MIN_RING_POINTS,
  type GeoArea,
  type GeoBounds,
  type GeoPoint,
  type GeoPolygon,
} from "./geo-values";
import { createSchema, fail, ok, validateSchema } from "./helpers";
import { object } from "./object";

export type { GeoArea, GeoBounds, GeoPolygon } from "./geo-values";

type CanonicalRing = GeoPoint[];
type UnwrappedPoint = { longitude: number; latitude: number };

const EPSILON = 1e-12;
const HALF_GLOBE_STERADIANS = 2 * Math.PI;
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

function prefix<T>(
  result: ValidationResult<T>,
  path: readonly PropertyKey[]
): ValidationResult<T> {
  return result.issues ? prefixGeoFailure(result, path) : result;
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

function snapshotDenseArray(
  value: unknown,
  label: string
): ValidationResult<unknown[]> {
  let candidate: unknown[];
  let keys: (string | symbol)[];
  let length: unknown;
  try {
    if (!Array.isArray(value)) return fail(`Expected ${label} array`);
    candidate = value;
    keys = Reflect.ownKeys(candidate);
    length = Reflect.get(candidate, "length");
  } catch {
    return fail(`Could not inspect ${label}`);
  }
  if (
    typeof length !== "number" ||
    !Number.isInteger(length) ||
    length < 0 ||
    keys.length !== length + 1
  ) {
    return fail(`Expected ${label} to be a dense array`);
  }
  const keySet = new Set<PropertyKey>(keys);
  const snapshot = new Array<unknown>(length);
  for (let index = 0; index < length; index++) {
    const key = String(index);
    if (!keySet.has(key)) {
      return fail(`Expected ${label} to be a dense array`);
    }
    try {
      if (!Object.hasOwn(candidate, key)) {
        return fail(`Expected ${label} to be a dense array`);
      }
      snapshot[index] = Reflect.get(candidate, key);
    } catch {
      return fail(`Could not read ${label} member`, [index]);
    }
  }
  return ok(snapshot);
}

function samePoint(left: GeoPoint, right: GeoPoint): boolean {
  return left.longitude === right.longitude && left.latitude === right.latitude;
}

function unwrapRing(
  ring: readonly GeoPoint[]
): ValidationResult<UnwrappedPoint[]> {
  const first = ring[0]!;
  const unwrapped: UnwrappedPoint[] = [
    { longitude: first.longitude, latitude: first.latitude },
  ];
  let previous = first.longitude;
  for (let index = 1; index <= ring.length; index++) {
    const point = ring[index % ring.length]!;
    let longitude = point.longitude;
    let delta = longitude - previous;
    if (Math.abs(delta) === 180) {
      return fail("A GeoPolygon edge cannot span exactly 180 degrees", [
        index % ring.length,
      ]);
    }
    while (delta > 180) {
      longitude -= 360;
      delta -= 360;
    }
    while (delta < -180) {
      longitude += 360;
      delta += 360;
    }
    if (index < ring.length) {
      unwrapped.push({ longitude, latitude: point.latitude });
    } else if (Math.abs(longitude - first.longitude) > EPSILON) {
      return fail("A GeoPolygon cannot contain a pole");
    }
    previous = longitude;
  }
  return ok(unwrapped);
}

function planarArea(ring: readonly UnwrappedPoint[]): number {
  let twiceArea = 0;
  for (let index = 0; index < ring.length; index++) {
    const current = ring[index]!;
    const next = ring[(index + 1) % ring.length]!;
    twiceArea +=
      current.longitude * next.latitude - next.longitude * current.latitude;
  }
  return twiceArea / 2;
}

function sphericalArea(ring: readonly UnwrappedPoint[]): number {
  let sum = 0;
  for (let index = 0; index < ring.length; index++) {
    const current = ring[index]!;
    const next = ring[(index + 1) % ring.length]!;
    const longitudeDelta =
      ((next.longitude - current.longitude) * Math.PI) / 180;
    const currentLatitude = (current.latitude * Math.PI) / 180;
    const nextLatitude = (next.latitude * Math.PI) / 180;
    sum +=
      longitudeDelta * (2 + Math.sin(currentLatitude) + Math.sin(nextLatitude));
  }
  return Math.abs(sum / 2);
}

function orientation(
  first: UnwrappedPoint,
  second: UnwrappedPoint,
  third: UnwrappedPoint
): number {
  return (
    (second.longitude - first.longitude) * (third.latitude - first.latitude) -
    (second.latitude - first.latitude) * (third.longitude - first.longitude)
  );
}

function between(value: number, first: number, second: number): boolean {
  return (
    value >= Math.min(first, second) - EPSILON &&
    value <= Math.max(first, second) + EPSILON
  );
}

function onSegment(
  point: UnwrappedPoint,
  first: UnwrappedPoint,
  second: UnwrappedPoint
): boolean {
  return (
    Math.abs(orientation(first, second, point)) <= EPSILON &&
    between(point.longitude, first.longitude, second.longitude) &&
    between(point.latitude, first.latitude, second.latitude)
  );
}

function segmentsIntersect(
  firstStart: UnwrappedPoint,
  firstEnd: UnwrappedPoint,
  secondStart: UnwrappedPoint,
  secondEnd: UnwrappedPoint
): boolean {
  const first = orientation(firstStart, firstEnd, secondStart);
  const second = orientation(firstStart, firstEnd, secondEnd);
  const third = orientation(secondStart, secondEnd, firstStart);
  const fourth = orientation(secondStart, secondEnd, firstEnd);
  if (
    ((first > EPSILON && second < -EPSILON) ||
      (first < -EPSILON && second > EPSILON)) &&
    ((third > EPSILON && fourth < -EPSILON) ||
      (third < -EPSILON && fourth > EPSILON))
  ) {
    return true;
  }
  return (
    onSegment(secondStart, firstStart, firstEnd) ||
    onSegment(secondEnd, firstStart, firstEnd) ||
    onSegment(firstStart, secondStart, secondEnd) ||
    onSegment(firstEnd, secondStart, secondEnd)
  );
}

function ringSelfIntersects(ring: readonly UnwrappedPoint[]): boolean {
  for (let first = 0; first < ring.length; first++) {
    const firstEnd = (first + 1) % ring.length;
    for (let second = first + 1; second < ring.length; second++) {
      const secondEnd = (second + 1) % ring.length;
      if (first === second || firstEnd === second || secondEnd === first) {
        continue;
      }
      if (
        segmentsIntersect(
          ring[first]!,
          ring[firstEnd]!,
          ring[second]!,
          ring[secondEnd]!
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function validateRing(
  value: unknown,
  label: string
): ValidationResult<{ canonical: CanonicalRing; unwrapped: UnwrappedPoint[] }> {
  const snapshot = snapshotDenseArray(value, label);
  if (snapshot.issues) return snapshot;
  if (snapshot.value.length < GEO_POLYGON_MIN_RING_POINTS) {
    return fail(
      `A GeoPolygon ring needs at least ${GEO_POLYGON_MIN_RING_POINTS} vertices`
    );
  }

  const canonical = new Array<GeoPoint>(snapshot.value.length);
  for (let index = 0; index < snapshot.value.length; index++) {
    const point = prefix(validateGeoPoint(snapshot.value[index]), [index]);
    if (point.issues) return point;
    if (Math.abs(point.value.latitude) === GEO_LATITUDE_MAX) {
      return fail("A GeoPolygon ring cannot contain a pole", [index]);
    }
    canonical[index] = point.value;
  }
  if (samePoint(canonical[0]!, canonical.at(-1)!)) {
    return fail("GeoPolygon rings are open; omit the repeated closing vertex");
  }
  for (let first = 0; first < canonical.length; first++) {
    for (let second = first + 1; second < canonical.length; second++) {
      if (samePoint(canonical[first]!, canonical[second]!)) {
        return fail("A GeoPolygon ring cannot repeat a vertex", [second]);
      }
    }
  }

  const unwrapped = unwrapRing(canonical);
  if (unwrapped.issues) return unwrapped;
  if (ringSelfIntersects(unwrapped.value)) {
    return fail("A GeoPolygon ring cannot self-intersect");
  }
  const area = planarArea(unwrapped.value);
  if (Math.abs(area) <= EPSILON) {
    return fail("A GeoPolygon ring must have non-zero area");
  }
  if (sphericalArea(unwrapped.value) >= HALF_GLOBE_STERADIANS - EPSILON) {
    return fail("A GeoPolygon must cover less than half the globe");
  }

  if (area < 0) {
    canonical.reverse();
    unwrapped.value.reverse();
  }
  return ok({ canonical, unwrapped: unwrapped.value });
}

function shiftRingNear(
  ring: readonly UnwrappedPoint[],
  reference: readonly UnwrappedPoint[]
): UnwrappedPoint[] {
  const ringMean =
    ring.reduce((sum, point) => sum + point.longitude, 0) / ring.length;
  const referenceMean =
    reference.reduce((sum, point) => sum + point.longitude, 0) /
    reference.length;
  const shift = Math.round((referenceMean - ringMean) / 360) * 360;
  return ring.map((point) => ({
    longitude: point.longitude + shift,
    latitude: point.latitude,
  }));
}

type PointLocation = "inside" | "outside";

function locatePoint(
  point: UnwrappedPoint,
  ring: readonly UnwrappedPoint[]
): PointLocation {
  let inside = false;
  for (let index = 0; index < ring.length; index++) {
    const current = ring[index]!;
    const next = ring[(index + 1) % ring.length]!;
    const crosses =
      current.latitude > point.latitude !== next.latitude > point.latitude;
    if (!crosses) continue;
    const longitude =
      current.longitude +
      ((point.latitude - current.latitude) *
        (next.longitude - current.longitude)) /
        (next.latitude - current.latitude);
    if (longitude > point.longitude) inside = !inside;
  }
  return inside ? "inside" : "outside";
}

function ringsIntersect(
  first: readonly UnwrappedPoint[],
  second: readonly UnwrappedPoint[]
): boolean {
  for (let firstIndex = 0; firstIndex < first.length; firstIndex++) {
    for (let secondIndex = 0; secondIndex < second.length; secondIndex++) {
      if (
        segmentsIntersect(
          first[firstIndex]!,
          first[(firstIndex + 1) % first.length]!,
          second[secondIndex]!,
          second[(secondIndex + 1) % second.length]!
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

export function validateGeoPolygon(
  value: unknown
): ValidationResult<GeoPolygon> {
  const snapshot = readGeoRecordWithOptional(
    value,
    ["outer"],
    ["holes"],
    "GeoPolygon"
  );
  if (snapshot.issues) return snapshot;
  const outer = prefix(
    validateRing(snapshot.value.values.outer, "outer ring"),
    ["outer"]
  );
  if (outer.issues) return outer;

  const holesValue = snapshot.value.values.holes;
  const holesSnapshot =
    holesValue === undefined
      ? ok<unknown[]>([])
      : snapshotDenseArray(holesValue, "GeoPolygon holes");
  if (holesSnapshot.issues) return prefix(holesSnapshot, ["holes"]);

  const holes: CanonicalRing[] = [];
  const unwrappedHoles: UnwrappedPoint[][] = [];
  for (let index = 0; index < holesSnapshot.value.length; index++) {
    const hole = prefix(validateRing(holesSnapshot.value[index], "hole ring"), [
      "holes",
      index,
    ]);
    if (hole.issues) return hole;
    const shifted = shiftRingNear(hole.value.unwrapped, outer.value.unwrapped);
    if (
      ringsIntersect(outer.value.unwrapped, shifted) ||
      shifted.some(
        (point) => locatePoint(point, outer.value.unwrapped) !== "inside"
      )
    ) {
      return fail("A GeoPolygon hole must be strictly inside its outer ring", [
        "holes",
        index,
      ]);
    }
    for (const previous of unwrappedHoles) {
      if (
        ringsIntersect(previous, shifted) ||
        locatePoint(shifted[0]!, previous) !== "outside" ||
        locatePoint(previous[0]!, shifted) !== "outside"
      ) {
        return fail("GeoPolygon holes cannot touch or overlap", [
          "holes",
          index,
        ]);
      }
    }
    hole.value.canonical.reverse();
    holes.push(hole.value.canonical);
    unwrappedHoles.push(shifted);
  }
  return ok({
    outer: outer.value.canonical,
    ...(holes.length > 0 ? { holes } : {}),
  });
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
