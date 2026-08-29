import type { ValidationResult, VibSchema } from "../types";
import {
  GEO_LATITUDE_MAX,
  GEO_LATITUDE_MIN,
  GEO_LONGITUDE_MAX,
  GEO_LONGITUDE_MIN,
  prefixGeoFailure,
  readExactGeoRecord,
  readGeoRecordWithOptional,
  readGeoVariantRecord,
  validateGeoPoint,
} from "./geo-point-codec";
import type { GeoArea, GeoBounds, GeoPoint, GeoPolygon } from "./geo-values";
import { createSchema, fail, ok } from "./helpers";

export type { GeoArea, GeoBounds, GeoPolygon } from "./geo-values";

export const GEO_BOUNDS_KEYS = ["south", "west", "north", "east"] as const;
export const GEO_POLYGON_MIN_RING_POINTS = 3;

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

function finiteBound(
  values: Readonly<Record<string, unknown>>,
  key: keyof GeoBounds,
  low: number,
  high: number
): ValidationResult<number> {
  const value = values[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fail(`Expected finite ${key}`, [key]);
  }
  if (value < low || value > high) {
    return fail(`${key} must be between ${low} and ${high}`, [key]);
  }
  return ok(Object.is(value, -0) ? 0 : value);
}

export function validateGeoBounds(value: unknown): ValidationResult<GeoBounds> {
  const snapshot = readExactGeoRecord(value, GEO_BOUNDS_KEYS, "GeoBounds");
  if (snapshot.issues) return snapshot;
  const { values } = snapshot.value;
  const south = finiteBound(
    values,
    "south",
    GEO_LATITUDE_MIN,
    GEO_LATITUDE_MAX
  );
  if (south.issues) return south;
  const west = finiteBound(
    values,
    "west",
    GEO_LONGITUDE_MIN,
    GEO_LONGITUDE_MAX
  );
  if (west.issues) return west;
  const north = finiteBound(
    values,
    "north",
    GEO_LATITUDE_MIN,
    GEO_LATITUDE_MAX
  );
  if (north.issues) return north;
  const east = finiteBound(
    values,
    "east",
    GEO_LONGITUDE_MIN,
    GEO_LONGITUDE_MAX
  );
  if (east.issues) return east;
  if (south.value > north.value) {
    return fail("GeoBounds south must be less than or equal to north", [
      "south",
    ]);
  }
  return ok({
    south: south.value,
    west: west.value,
    north: north.value,
    east: east.value,
  });
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

export function validateGeoArea(value: unknown): ValidationResult<GeoArea> {
  const area = readGeoVariantRecord(value, ["bounds", "polygon"], "GeoArea");
  if (area.issues) return area;
  if (area.value.variant === "bounds") {
    const decoded = prefix(validateGeoBounds(area.value.value), ["bounds"]);
    return decoded.issues ? decoded : ok({ bounds: decoded.value });
  }
  const decoded = prefix(validateGeoPolygon(area.value.value), ["polygon"]);
  return decoded.issues ? decoded : ok({ polygon: decoded.value });
}

export function geoAreaSchema(): VibSchema<GeoArea, GeoArea> {
  return createSchema("geo_area", validateGeoArea);
}
