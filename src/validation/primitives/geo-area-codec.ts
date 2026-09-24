import type { ValidationResult, VibSchema } from "../types";
import { geoLatitude, geoLongitude, validateGeoPoint } from "./geo-point-codec";
import {
  GEO_BOUNDS_KEYS,
  GEO_LATITUDE_MAX,
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
 * (adapters/shared/geo-point.ts) reads the first vertex of every ring. The
 * count is judged before any vertex, so a short ring reports its length.
 */
function validateRing(value: unknown): ValidationResult<GeoPoint[]> {
  const members = validateArray(value, ok);
  if (members.issues) return members;
  if (members.value.length < GEO_POLYGON_MIN_RING_POINTS) {
    return fail(
      `A GeoPolygon ring needs at least ${GEO_POLYGON_MIN_RING_POINTS} vertices`
    );
  }
  return validateArray(members.value, validateGeoPoint);
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

/*
 * Polygon geometry, judged after the record walker admitted the shape, in the
 * plane of longitudes unwrapped across the antimeridian. PostGIS and MySQL
 * answer most malformed polygons silently rather than raising, so each
 * refusal below is a polygon whose answer the probe measured as wrong, as
 * different between the two databases, or as resting on a reading the docs do
 * not state (PGlite 0.5.8 + PostGIS 3.6.2 and MySQL 8, the exact
 * withinPolygon predicates; CHANGELOG "Geo"). Everything else is admitted.
 */

/** One ring vertex, its longitude unwrapped past ±180 along the ring. */
interface UnwrappedPoint {
  readonly longitude: number;
  readonly latitude: number;
}

/** One ring edge, never of zero length. */
type Edge = readonly [start: UnwrappedPoint, end: UnwrappedPoint];

const EPSILON = 1e-12;
const HALF_GLOBE_STERADIANS = 2 * Math.PI;

/**
 * The ring's edges, each taking the short way round in longitude. A repeated
 * consecutive vertex, the caller's closing vertex included, is admitted as the
 * zero-length edge both databases ignore, and dropped here.
 */
function ringEdges(
  ring: readonly GeoPoint[],
  path: readonly PropertyKey[]
): ValidationResult<Edge[]> {
  const edges: Edge[] = [];
  let wrap = 0;
  let previous: GeoPoint | undefined;
  let start: UnwrappedPoint | undefined;
  for (const [index, vertex] of [...ring, ...ring.slice(0, 1)].entries()) {
    const at = [...path, index % ring.length];
    // A pole has no longitude of its own: PostGIS drew this ring's edges along
    // meridians while MySQL matched the equator and the opposite pole.
    if (Math.abs(vertex.latitude) === GEO_LATITUDE_MAX) {
      return fail("A GeoPolygon ring cannot contain a pole", at);
    }
    if (previous) {
      const delta = vertex.longitude - previous.longitude;
      // No short way round: PostGIS raises "Antipodal (180 degrees long)
      // edge detected!" and MySQL answers.
      if (Math.abs(delta) === 180) {
        return fail("A GeoPolygon edge cannot span exactly 180 degrees", at);
      }
      if (delta > 180) wrap -= 360;
      if (delta < -180) wrap += 360;
    }
    const end = {
      longitude: vertex.longitude + wrap,
      latitude: vertex.latitude,
    };
    if (
      start &&
      (start.longitude !== end.longitude || start.latitude !== end.latitude)
    ) {
      edges.push([start, end]);
    }
    previous = vertex;
    start = end;
  }
  // Longitudes that went once around the globe enclose a pole on both
  // databases' unstated "smaller side" reading, and have no plane to judge in.
  if (wrap !== 0) return fail("A GeoPolygon cannot contain a pole", [...path]);
  return ok(edges);
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

function onEdge(point: UnwrappedPoint, [start, end]: Edge): boolean {
  return (
    Math.abs(orientation(start, end, point)) <= EPSILON &&
    point.longitude >= Math.min(start.longitude, end.longitude) - EPSILON &&
    point.longitude <= Math.max(start.longitude, end.longitude) + EPSILON &&
    point.latitude >= Math.min(start.latitude, end.latitude) - EPSILON &&
    point.latitude <= Math.max(start.latitude, end.latitude) + EPSILON
  );
}

function opposite(first: number, second: number): boolean {
  return (
    (first > EPSILON && second < -EPSILON) ||
    (first < -EPSILON && second > EPSILON)
  );
}

/** The two edges cross at one point interior to both. */
function cross([a, b]: Edge, [c, d]: Edge): boolean {
  return (
    opposite(orientation(a, b, c), orientation(a, b, d)) &&
    opposite(orientation(c, d, a), orientation(c, d, b))
  );
}

function meet(first: Edge, second: Edge): boolean {
  return (
    cross(first, second) ||
    onEdge(first[0], second) ||
    onEdge(first[1], second) ||
    onEdge(second[0], first) ||
    onEdge(second[1], first)
  );
}

/** Two edges that are not neighbors along the ring meet. */
function selfIntersects(edges: readonly Edge[]): boolean {
  return edges.some((first, index) =>
    edges
      .slice(index + 2, index === 0 ? -1 : undefined)
      .some((second) => meet(first, second))
  );
}

/** Signed shoelace area: positive for a counterclockwise ring. */
function planarArea(edges: readonly Edge[]): number {
  let twiceArea = 0;
  for (const [start, end] of edges) {
    twiceArea +=
      start.longitude * end.latitude - end.longitude * start.latitude;
  }
  return twiceArea / 2;
}

function sphericalArea(edges: readonly Edge[]): number {
  let sum = 0;
  for (const [start, end] of edges) {
    sum +=
      (((end.longitude - start.longitude) * Math.PI) / 180) *
      (2 +
        Math.sin((start.latitude * Math.PI) / 180) +
        Math.sin((end.latitude * Math.PI) / 180));
  }
  return Math.abs(sum / 2);
}

function ringGeometry(
  ring: readonly GeoPoint[],
  path: readonly PropertyKey[]
): ValidationResult<Edge[]> {
  const edges = ringEdges(ring, path);
  if (edges.issues) return edges;
  // A bowtie matched both lobes and its crossing point on both databases, a
  // parity reading the docs do not state.
  if (selfIntersects(edges.value)) {
    return fail("A GeoPolygon ring cannot self-intersect", [...path]);
  }
  // The self-intersection no pair of non-neighbor edges shows: a collinear
  // ring retraces itself, and both databases matched its outline only.
  if (Math.abs(planarArea(edges.value)) <= EPSILON) {
    return fail("A GeoPolygon ring must have non-zero area", [...path]);
  }
  // PostGIS and MySQL read such a ring as opposite regions: for a 340-degree
  // band PostGIS matched the poles and the antimeridian, MySQL the band.
  if (sphericalArea(edges.value) >= HALF_GLOBE_STERADIANS - EPSILON) {
    return fail("A GeoPolygon must cover less than half the globe", [...path]);
  }
  return edges;
}

/** The ring moved by whole turns to lie beside the reference ring. */
function shiftNear(edges: readonly Edge[], reference: readonly Edge[]): Edge[] {
  const mean = (ring: readonly Edge[]) =>
    ring.reduce((sum, [start]) => sum + start.longitude, 0) / ring.length;
  const shift = Math.round((mean(reference) - mean(edges)) / 360) * 360;
  const moved = (point: UnwrappedPoint) => ({
    longitude: point.longitude + shift,
    latitude: point.latitude,
  });
  return edges.map(([start, end]) => [moved(start), moved(end)]);
}

/** Even-odd ray casting, for a point on no edge of the ring. */
function strictlyInside(
  point: UnwrappedPoint,
  edges: readonly Edge[]
): boolean {
  let inside = false;
  for (const [start, end] of edges) {
    if (start.latitude > point.latitude === end.latitude > point.latitude)
      continue;
    const x =
      start.longitude +
      ((point.latitude - start.latitude) * (end.longitude - start.longitude)) /
        (end.latitude - start.latitude);
    if (x > point.longitude) inside = !inside;
  }
  return inside;
}

type Side = "inside" | "outside" | "boundary";

/**
 * Where each piece of one ring's boundary lies against the other ring, the
 * rings crossing nowhere: an edge is cut at the other ring's vertices on it,
 * so every piece lies wholly inside, outside, or along the other ring.
 */
function sides(edges: readonly Edge[], other: readonly Edge[]): Set<Side> {
  const found = new Set<Side>();
  for (const edge of edges) {
    const [start, end] = edge;
    const dx = end.longitude - start.longitude;
    const dy = end.latitude - start.latitude;
    const cuts = other
      .map(([corner]) => corner)
      .filter((corner) => onEdge(corner, edge))
      .map(
        (corner) =>
          ((corner.longitude - start.longitude) * dx +
            (corner.latitude - start.latitude) * dy) /
          (dx * dx + dy * dy)
      )
      .concat(1)
      .sort((left, right) => left - right);
    let from = 0;
    for (const to of cuts) {
      if (to - from > EPSILON) {
        const t = (from + to) / 2;
        const middle = {
          longitude: start.longitude + t * dx,
          latitude: start.latitude + t * dy,
        };
        if (other.some((otherEdge) => onEdge(middle, otherEdge))) {
          found.add("boundary");
        } else {
          found.add(strictlyInside(middle, other) ? "inside" : "outside");
        }
      }
      from = to;
    }
  }
  return found;
}

function ringsCross(first: readonly Edge[], second: readonly Edge[]): boolean {
  return first.some((edge) => second.some((other) => cross(edge, other)));
}

/**
 * PostGIS reads rings by parity: a hole outside its outer ring added its own
 * area (MySQL ignored it), and a point in two holes matched (MySQL excluded
 * it). A hole may touch the outer ring or another hole, at a point or along an
 * edge: both databases answered every touching probe as "inside the outer ring
 * and in no hole".
 */
function holeEscapes(hole: readonly Edge[], outer: readonly Edge[]): boolean {
  return ringsCross(hole, outer) || sides(hole, outer).has("outside");
}

/**
 * Without a crossing, two holes overlap when the first lies within the second
 * (the same ring twice has no piece outside) or the second enters the first;
 * a partial overlap does both, so "the first enters the second" adds nothing.
 */
function holesOverlap(
  first: readonly Edge[],
  second: readonly Edge[]
): boolean {
  return (
    ringsCross(first, second) ||
    !sides(first, second).has("outside") ||
    sides(second, first).has("inside")
  );
}

/**
 * Kept output normalization, not a refusal: the GeoJSON that withinPolygon
 * binds (adapters/databases/{postgres,mysql}) always carries a counterclockwise
 * outer ring and clockwise holes, because neither database's reading of ring
 * orientation is proven portable (v1-public-api-geopoint-plan.md).
 */
function wound(
  ring: GeoPoint[],
  edges: readonly Edge[],
  counterClockwise: boolean
): GeoPoint[] {
  return planarArea(edges) < 0 === counterClockwise ? ring.reverse() : ring;
}

/**
 * The walker admits the polygon's shape (exact keys, finite in-range
 * vertices, at least three per ring); the geometry above then refuses the
 * polygons the databases answer wrongly, and the rings are wound canonically.
 */
export function validateGeoPolygon(
  value: unknown
): ValidationResult<GeoPolygon> {
  const polygon = validateSchema(polygonRecord, value);
  if (polygon.issues) return polygon;
  const outer = ringGeometry(polygon.value.outer, ["outer"]);
  if (outer.issues) return outer;
  const holes: GeoPoint[][] = [];
  const placed: Edge[][] = [];
  for (const [index, ring] of (polygon.value.holes ?? []).entries()) {
    const path = ["holes", index];
    const hole = ringGeometry(ring, path);
    if (hole.issues) return hole;
    const edges = shiftNear(hole.value, outer.value);
    if (holeEscapes(edges, outer.value)) {
      return fail("A GeoPolygon hole must be inside its outer ring", path);
    }
    if (placed.some((previous) => holesOverlap(previous, edges))) {
      return fail("GeoPolygon holes cannot overlap", path);
    }
    placed.push(edges);
    holes.push(wound(ring, edges, false));
  }
  const wide = wound(polygon.value.outer, outer.value, true);
  // An empty and an absent holes list emit the same GeoJSON; one spelling
  // keeps them one validated argument, and so one cache key.
  return ok(holes.length > 0 ? { outer: wide, holes } : { outer: wide });
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
