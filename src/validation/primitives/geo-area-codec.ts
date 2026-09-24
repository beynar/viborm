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
 * Polygon geometry, judged after the record walker admitted the shape. Both
 * databases read an edge as the great-circle arc between its vertices (in the
 * box (0,40)-(10,50), PostGIS and MySQL both put (5,40.05) outside and
 * (5,50.05) inside), so crossings, touches and containment are judged on the
 * unit sphere, never on straight longitude/latitude lines. PostGIS and MySQL
 * answer most malformed polygons silently rather than raising, so each refusal
 * below is a polygon whose answer the probe measured as wrong, as different
 * between the two databases, or as resting on a reading the docs do not state
 * (PGlite 0.5.8 + PostGIS 3.6.2 and MySQL 8, the exact withinPolygon
 * predicates; CHANGELOG "Geo"). Everything else is admitted.
 */

/** One ring vertex, its longitude unwrapped past ±180 along the ring. */
interface UnwrappedPoint {
  readonly longitude: number;
  readonly latitude: number;
}

type Vector = readonly [x: number, y: number, z: number];
type Axis = 0 | 1 | 2;
const AXES: readonly Axis[] = [0, 1, 2];

/** One ring edge: the great-circle arc from `from` to `to`. */
interface Arc {
  readonly from: UnwrappedPoint;
  readonly to: UnwrappedPoint;
  readonly start: Vector;
  readonly end: Vector;
  /** The unit normal of the arc's great circle, start × end. */
  readonly normal: Vector;
  /** A box holding the arc: its chord's box widened by the arc's bulge. */
  readonly low: Vector;
  readonly high: Vector;
}

/** A ring's arcs; a ring with no arc is refused as having no area. */
type Ring = readonly [Arc, ...Arc[]];

const RADIANS = Math.PI / 180;
/** An angle of 1e-9 degrees, about 0.1 mm: a point this near an arc is on it. */
const TOLERANCE = 1e-9 * RADIANS;
const HALF_GLOBE_STERADIANS = 2 * Math.PI;

function toVector({ longitude, latitude }: UnwrappedPoint): Vector {
  const cosine = Math.cos(latitude * RADIANS);
  return [
    cosine * Math.cos(longitude * RADIANS),
    cosine * Math.sin(longitude * RADIANS),
    Math.sin(latitude * RADIANS),
  ];
}

function dot(first: Vector, second: Vector): number {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

function cross(first: Vector, second: Vector): Vector {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

function unit(vector: Vector): Vector {
  const length = Math.hypot(...vector);
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

/** The arc between two vertices, or none when they are the same point. */
function arcBetween(from: UnwrappedPoint, to: UnwrappedPoint): Arc | undefined {
  const start = toVector(from);
  const end = toVector(to);
  if (
    Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]) <=
    TOLERANCE
  ) {
    return;
  }
  const bulge = 1 - Math.sqrt((1 + dot(start, end)) / 2) + TOLERANCE;
  return {
    from,
    to,
    start,
    end,
    normal: unit(cross(start, end)),
    low: [
      Math.min(start[0], end[0]) - bulge,
      Math.min(start[1], end[1]) - bulge,
      Math.min(start[2], end[2]) - bulge,
    ],
    high: [
      Math.max(start[0], end[0]) + bulge,
      Math.max(start[1], end[1]) + bulge,
      Math.max(start[2], end[2]) + bulge,
    ],
  };
}

/**
 * The ring's arcs, each taking the short way round in longitude. A repeated
 * consecutive vertex, the caller's closing vertex included, is admitted as the
 * zero-length edge both databases ignore, and dropped here.
 */
function ringArcs(
  ring: readonly GeoPoint[],
  path: readonly PropertyKey[]
): ValidationResult<Arc[]> {
  const arcs: Arc[] = [];
  let wrap = 0;
  let previous: GeoPoint | undefined;
  let from: UnwrappedPoint | undefined;
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
    previous = vertex;
    const to = {
      longitude: vertex.longitude + wrap,
      latitude: vertex.latitude,
    };
    const arc = from && arcBetween(from, to);
    if (arc) arcs.push(arc);
    if (!from || arc) from = to;
  }
  // Longitudes that went once around the globe enclose a pole on both
  // databases' unstated "smaller side" reading.
  if (wrap !== 0) return fail("A GeoPolygon cannot contain a pole", [...path]);
  return ok(arcs);
}

/** The sine of the point's signed angular distance from the arc's circle. */
function side(arc: Arc, point: Vector): number {
  return dot(arc.normal, point);
}

function onArc(point: Vector, arc: Arc): boolean {
  return (
    Math.abs(side(arc, point)) <= TOLERANCE &&
    dot(cross(arc.start, point), arc.normal) >= -TOLERANCE &&
    dot(cross(point, arc.end), arc.normal) >= -TOLERANCE
  );
}

function opposite(first: number, second: number): boolean {
  return (
    (first > TOLERANCE && second < -TOLERANCE) ||
    (first < -TOLERANCE && second > TOLERANCE)
  );
}

/**
 * The two arcs cross at one point interior to both. Each straddling the
 * other's circle still allows the circles' other meeting point, the antipode;
 * the third sign picks the near one.
 */
function crosses(first: Arc, second: Arc): boolean {
  const third = side(first, second.start);
  return (
    opposite(third, side(first, second.end)) &&
    opposite(side(second, first.start), side(second, first.end)) &&
    opposite(third, side(second, first.start))
  );
}

function meet(first: Arc, second: Arc): boolean {
  return (
    AXES.every(
      (axis) =>
        first.low[axis] <= second.high[axis] &&
        second.low[axis] <= first.high[axis]
    ) &&
    (crosses(first, second) ||
      onArc(first.start, second) ||
      onArc(first.end, second) ||
      onArc(second.start, first) ||
      onArc(second.end, first))
  );
}

interface Placed {
  readonly arc: Arc;
  readonly ring: number;
  readonly index: number;
}

/**
 * Whether two arcs that `compared` pairs meet. The arcs are swept along the
 * axis their boxes spread widest on, so only arcs whose boxes overlap there
 * are compared: admission stays near-linear in the vertex count.
 */
function anyMeet(
  arcs: readonly Placed[],
  compared: (first: Placed, second: Placed) => boolean
): boolean {
  const spread = (axis: Axis) =>
    arcs.reduce((most, { arc }) => Math.max(most, arc.low[axis]), -2) -
    arcs.reduce((least, { arc }) => Math.min(least, arc.low[axis]), 2);
  const axis = AXES.reduce((best, next) =>
    spread(next) > spread(best) ? next : best
  );
  const sorted = [...arcs].sort(
    (left, right) => left.arc.low[axis] - right.arc.low[axis]
  );
  let open: Placed[] = [];
  for (const current of sorted) {
    const reach = current.arc.low[axis];
    open = open.filter(({ arc }) => arc.high[axis] >= reach);
    if (
      open.some(
        (other) => compared(other, current) && meet(other.arc, current.arc)
      )
    ) {
      return true;
    }
    open.push(current);
  }
  return false;
}

/** Two arcs that are not neighbors along the ring meet. */
function selfIntersects(arcs: readonly Arc[]): boolean {
  return anyMeet(
    arcs.map((arc, index) => ({ arc, ring: 0, index })),
    (first, second) => {
      const gap = Math.abs(first.index - second.index);
      return gap !== 1 && gap !== arcs.length - 1;
    }
  );
}

function ringsMeet(first: Ring, second: Ring): boolean {
  return anyMeet(
    [
      ...first.map((arc, index) => ({ arc, ring: 0, index })),
      ...second.map((arc, index) => ({ arc, ring: 1, index })),
    ],
    (left, right) => left.ring !== right.ring
  );
}

/**
 * A point on no arc of the ring lies inside it when the meridian from the
 * point to the north pole, which no admitted ring encloses, crosses the ring
 * an odd number of times.
 */
function inside(point: UnwrappedPoint, ring: Ring): boolean {
  const facing: Vector = [
    Math.cos(point.longitude * RADIANS),
    Math.sin(point.longitude * RADIANS),
    0,
  ];
  const meridian: Vector = [-facing[1], facing[0], 0];
  const height = Math.sin(point.latitude * RADIANS);
  const offset = (longitude: number) =>
    normalizeLongitude(longitude - point.longitude);
  let odd = false;
  for (const { from, to, normal } of ring) {
    // A vertex shared by two arcs gets one offset, so a meridian through it
    // counts once or twice, never by rounding; an arc whose offsets are
    // 180 degrees apart or more meets the meridian behind the pole instead.
    const start = offset(from.longitude);
    const end = offset(to.longitude);
    if (start > 0 === end > 0 || Math.abs(end - start) >= 180) continue;
    const meeting = unit(cross(normal, meridian));
    const crossing = dot(meeting, facing) < 0 ? -meeting[2] : meeting[2];
    if (crossing > height) odd = !odd;
  }
  return odd;
}

/** Signed shoelace area: positive for a counterclockwise ring. */
function planarArea(ring: Ring): number {
  const [{ from: origin }] = ring;
  let twiceArea = 0;
  for (const { from, to } of ring) {
    twiceArea +=
      (from.longitude - origin.longitude) * (to.latitude - origin.latitude) -
      (to.longitude - origin.longitude) * (from.latitude - origin.latitude);
  }
  return twiceArea / 2;
}

function sphericalArea(ring: Ring): number {
  let sum = 0;
  for (const { from, to } of ring) {
    sum +=
      (to.longitude - from.longitude) *
      RADIANS *
      (2 + Math.sin(from.latitude * RADIANS) + Math.sin(to.latitude * RADIANS));
  }
  return Math.abs(sum / 2);
}

function ringGeometry(
  ring: readonly GeoPoint[],
  path: readonly PropertyKey[]
): ValidationResult<Ring> {
  const arcs = ringArcs(ring, path);
  if (arcs.issues) return arcs;
  // A bowtie matched both lobes and its crossing point on both databases, a
  // parity reading the docs do not state; a ring going past a whole turn over
  // itself (0 to 400 degrees along a band) split them.
  if (selfIntersects(arcs.value)) {
    return fail("A GeoPolygon ring cannot self-intersect", [...path]);
  }
  // The self-intersection no pair of non-neighbor arcs shows: a ring of at
  // most three arcs on one great circle retraces itself, and both databases
  // matched its outline only.
  const [first, ...rest] = arcs.value;
  if (
    !first ||
    (rest.length < 3 &&
      rest.every(({ start }) => Math.abs(side(first, start)) <= TOLERANCE))
  ) {
    return fail("A GeoPolygon ring must have non-zero area", [...path]);
  }
  const geometry: Ring = [first, ...rest];
  // PostGIS and MySQL read such a ring as opposite regions: for a 340-degree
  // band PostGIS matched the poles and the antimeridian, MySQL the band. The
  // area is the trapezoid sum over longitude, a threshold, not a measure.
  if (sphericalArea(geometry) >= HALF_GLOBE_STERADIANS - TOLERANCE) {
    return fail("A GeoPolygon must cover less than half the globe", [...path]);
  }
  return ok(geometry);
}

/*
 * A hole must lie strictly inside its outer ring, and holes must neither touch
 * nor overlap: PostGIS reads rings by parity, so a hole reaching outside its
 * outer ring added its own area (MySQL ignored it) and a point in two holes
 * matched (MySQL excluded it). A touch is refused as before D2, because it is
 * where the two databases' arcs (sphere, ellipsoid) and tolerances part: a
 * hole written touching a straight parallel edge crosses that edge's arc, and
 * PostGIS matched the points beside the touch.
 */

function holeEscapes(hole: Ring, outer: Ring): boolean {
  return ringsMeet(hole, outer) || !inside(hole[0].from, outer);
}

function holesTouch(first: Ring, second: Ring): boolean {
  return (
    ringsMeet(first, second) ||
    inside(first[0].from, second) ||
    inside(second[0].from, first)
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
  geometry: Ring,
  counterClockwise: boolean
): GeoPoint[] {
  return planarArea(geometry) < 0 === counterClockwise ? ring.reverse() : ring;
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
  const placed: Ring[] = [];
  for (const [index, ring] of (polygon.value.holes ?? []).entries()) {
    const path = ["holes", index];
    const hole = ringGeometry(ring, path);
    if (hole.issues) return hole;
    if (holeEscapes(hole.value, outer.value)) {
      return fail(
        "A GeoPolygon hole must be strictly inside its outer ring",
        path
      );
    }
    if (placed.some((previous) => holesTouch(previous, hole.value))) {
      return fail("GeoPolygon holes cannot touch or overlap", path);
    }
    placed.push(hole.value);
    holes.push(wound(ring, hole.value, false));
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
