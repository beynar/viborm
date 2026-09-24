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
 * Polygon geometry, judged after the record walker admitted the shape.
 * PostGIS geography reads an edge as the great-circle arc between its
 * vertices, so crossings, touches and containment are judged on the unit
 * sphere, never on straight longitude/latitude lines. MySQL reads the edge on
 * the ellipsoid instead, a band beside the arc that grows with the edge (the
 * limits below and CHANGELOG "Geo" give the measured widths). PostGIS and
 * MySQL answer most malformed polygons silently rather than raising, so each
 * refusal below is a polygon whose answer the probe measured as wrong, as
 * different between the two databases, or as resting on a reading the docs do
 * not state (PGlite 0.5.8 + PostGIS 3.6.2 and MySQL 8, the exact
 * withinPolygon predicates). Everything else is admitted.
 */

type Vector = readonly [x: number, y: number, z: number];

/** One ring vertex, its longitude unwrapped past ±180 along the ring. */
interface UnwrappedPoint {
  readonly longitude: number;
  readonly latitude: number;
  /** The longitude as written, where the sweep in `firstMeeting` places it. */
  readonly written: number;
  readonly vector: Vector;
}

/** One ring edge: the great-circle arc from `from` to `to`. */
interface Arc {
  readonly from: UnwrappedPoint;
  readonly to: UnwrappedPoint;
  readonly start: Vector;
  readonly end: Vector;
  /** The unit normal of the arc's great circle, start × end. */
  readonly normal: Vector;
}

/** A ring's arcs; a ring is refused before it could have fewer than two. */
type Ring = readonly [Arc, ...Arc[]];

const RADIANS = Math.PI / 180;
/** An angle of 1e-9 degrees, about 0.1 mm: a point this near an arc is on it. */
const TOLERANCE = 1e-9 * RADIANS;
const HALF_GLOBE_STERADIANS = 2 * Math.PI;

function toVector(longitude: number, latitude: number): Vector {
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

function chord(first: Vector, second: Vector): number {
  return Math.hypot(
    first[0] - second[0],
    first[1] - second[1],
    first[2] - second[2]
  );
}

/**
 * The ring's arcs, each taking the short way round in longitude. A repeated
 * consecutive vertex, the caller's closing vertex included, is admitted as the
 * zero-length edge both databases ignore, and dropped here.
 */
function ringArcs(
  ring: readonly GeoPoint[],
  path: readonly PropertyKey[]
): ValidationResult<Ring> {
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
    const longitude = vertex.longitude + wrap;
    const vector = toVector(longitude, vertex.latitude);
    const to = {
      longitude,
      latitude: vertex.latitude,
      written: vertex.longitude,
      vector,
    };
    if (!from || chord(from.vector, vector) > TOLERANCE) {
      if (from) {
        arcs.push({
          from,
          to,
          start: from.vector,
          end: vector,
          normal: unit(cross(from.vector, vector)),
        });
      }
      from = to;
    }
  }
  // Longitudes that went once around the globe enclose a pole on both
  // databases' unstated "smaller side" reading.
  if (wrap !== 0) return fail("A GeoPolygon cannot contain a pole", [...path]);
  // The self-intersection no pair of non-neighbor arcs shows: a ring of at
  // most three arcs on one great circle retraces itself, and both databases
  // matched its outline only; a ring of one distinct vertex has no arc.
  const [first, ...rest] = arcs;
  if (
    !first ||
    (rest.length < 3 &&
      rest.every(({ start }) => Math.abs(side(first, start)) <= TOLERANCE))
  ) {
    return fail("A GeoPolygon ring must have non-zero area", [...path]);
  }
  // Neighbors meet at their shared vertex, which the sweep in
  // `firstMeeting` excuses, unless one doubles back along the other: such
  // arcs overlap, and the sweep cannot order arcs that overlap.
  let behind = rest.at(-1) ?? first;
  for (const arc of arcs) {
    if (onArc(arc.end, behind) || onArc(behind.start, arc)) {
      return fail("A GeoPolygon ring cannot self-intersect", [...path]);
    }
    behind = arc;
  }
  return ok([first, ...rest]);
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
    crosses(first, second) ||
    onArc(first.start, second) ||
    onArc(first.end, second) ||
    onArc(second.start, first) ||
    onArc(second.end, first)
  );
}

/** An arc of ring `ring` (0 the outer ring, then the holes) at `index`. */
interface Placed {
  readonly arc: Arc;
  readonly ring: number;
  readonly index: number;
  readonly count: number;
}

/**
 * One stretch of an arc between two meridians, as the sweep orders it, from
 * its west end.
 */
interface Stretch {
  readonly placed: Placed;
  readonly west: Vector;
  readonly east: Vector;
  /** The arc's unit normal, turned north. */
  readonly north: Vector;
}

/** An arc along a meridian, which the sweep meets at one longitude. */
interface Upright {
  readonly placed: Placed;
  readonly south: Vector;
  readonly north: Vector;
}

interface Link {
  previous: Entry | undefined;
  next: Entry | undefined;
}

/** A stretch in the sweep's south-to-north order, a skip list. */
interface Entry {
  readonly stretch: Stretch | undefined;
  readonly links: readonly Link[];
}

const LEVELS = 24;

function createLinks(height: number): Link[] {
  return Array.from({ length: height }, () => ({
    previous: undefined,
    next: undefined,
  }));
}

/**
 * Whether `entering` starts south of `resident` on the meridian where it
 * enters the sweep; one starting on the resident is ordered by where it
 * heads. Only neighbors in this order are compared, so the order must only
 * be right between arcs that do not meet.
 */
function below(entering: Stretch, resident: Stretch): boolean {
  const height = dot(resident.north, entering.west);
  if (Math.abs(height) > TOLERANCE) return height < 0;
  return dot(resident.north, entering.east) < 0;
}

/** The last entry south of `point` on the sweep's meridian, or the head. */
function southOf(head: Entry, point: Vector, level: number): Entry {
  let cursor = head;
  for (let at = level; at >= 0; at -= 1) {
    let next = cursor.links[at]?.next;
    while (next?.stretch && dot(next.stretch.north, point) > TOLERANCE) {
      cursor = next;
      next = cursor.links[at]?.next;
    }
  }
  return cursor;
}

function enter(head: Entry, stretch: Stretch, height: number): Entry {
  const entry: Entry = { stretch, links: createLinks(height) };
  let cursor = head;
  for (let level = LEVELS - 1; level >= 0; level -= 1) {
    let next = cursor.links[level]?.next;
    while (next?.stretch && !below(stretch, next.stretch)) {
      cursor = next;
      next = cursor.links[level]?.next;
    }
    const link = entry.links[level];
    const before = cursor.links[level];
    if (link && before) {
      link.previous = cursor;
      link.next = before.next;
      const after = before.next?.links[level];
      if (after) after.previous = entry;
      before.next = entry;
    }
  }
  return entry;
}

function leave(entry: Entry): void {
  for (const [level, { previous, next }] of entry.links.entries()) {
    const before = previous?.links[level];
    if (before) before.next = next;
    const after = next?.links[level];
    if (after) after.previous = previous;
  }
}

/** The point where the arc crosses the meridian at `longitude`. */
function atMeridian(arc: Arc, longitude: number): Vector {
  const facing = toVector(longitude, 0);
  const meeting = unit(cross(arc.normal, [-facing[1], facing[0], 0]));
  return dot(meeting, facing) < 0
    ? [-meeting[0], -meeting[1], -meeting[2]]
    : meeting;
}

type Event =
  | { readonly longitude: number; readonly rank: 0; readonly slot: Slot }
  | { readonly longitude: number; readonly rank: 1; readonly upright: Upright }
  | { readonly longitude: number; readonly rank: 2; readonly slot: Slot };

interface Slot {
  readonly stretch: Stretch;
  entry: Entry | undefined;
}

/**
 * The arc's sweep events at its written longitudes, west to east, ±180 read
 * as -180 so that arcs meeting on the antimeridian are in the sweep
 * together: one for an arc along a meridian, else an entry and an exit per
 * stretch, two stretches when the arc crosses the antimeridian, split there.
 */
function arcEvents(placed: Placed): Event[] {
  const { from, to, normal } = placed.arc;
  const first = from.written === 180 ? -180 : from.written;
  const second = to.written === 180 ? -180 : to.written;
  if (first === second) {
    const [south, north] =
      from.latitude < to.latitude ? [from, to] : [to, from];
    const upright = { placed, south: south.vector, north: north.vector };
    return [{ longitude: first, rank: 1, upright }];
  }
  const eastward = from.longitude < to.longitude;
  const [west, east] = eastward ? [from, to] : [to, from];
  const north: Vector = eastward
    ? normal
    : [-normal[0], -normal[1], -normal[2]];
  const [low, high] = eastward ? [first, second] : [second, first];
  const span = (start: number, end: number, point: Vector): Event[] => {
    const slot = {
      stretch: { placed, west: point, east: east.vector, north },
      entry: undefined,
    };
    return [
      { longitude: start, rank: 0, slot },
      { longitude: end, rank: 2, slot },
    ];
  };
  return low < high
    ? span(low, high, west.vector)
    : [
        ...span(low, 180, west.vector),
        ...span(-180, high, atMeridian(placed.arc, 180)),
      ];
}

/**
 * The first two arcs found meeting that `apart` does not excuse, by a sweep
 * from the antimeridian eastward that keeps the arcs it crosses in
 * south-to-north order and compares each only with its neighbors in it
 * (Shamos and Hoey): two arcs that meet are neighbors just before the
 * westernmost meeting, so admission is n log n in the arc count however the
 * arcs lie. At each longitude the arcs starting there enter first; then each
 * arc along that meridian is compared with the arcs crossing its span, found
 * by position, and with the other such arcs overlapping it; then the arcs
 * ending there leave.
 */
function firstMeeting(
  arcs: readonly Placed[],
  apart: (first: Placed, second: Placed) => boolean
): readonly [Placed, Placed] | undefined {
  const events = arcs.flatMap(arcEvents);
  events.sort(
    (left, right) => left.longitude - right.longitude || left.rank - right.rank
  );
  const head: Entry = { stretch: undefined, links: createLinks(LEVELS) };
  let seed = 1;
  const meeting = (
    first: Placed | undefined,
    second: Placed | undefined
  ): readonly [Placed, Placed] | undefined => {
    if (!(first && second)) return;
    if (apart(first, second) || !meet(first.arc, second.arc)) return;
    return [first, second];
  };
  // The arcs along the meridian the sweep is on, compared among themselves,
  // south to north, before it moves on.
  let column: Upright[] = [];
  const columnMeeting = (): readonly [Placed, Placed] | undefined => {
    column.sort((left, right) => left.south[2] - right.south[2]);
    for (const [index, upright] of column.entries()) {
      for (const other of column.slice(index + 1)) {
        if (other.south[2] > upright.north[2] + TOLERANCE) break;
        const found = meeting(upright.placed, other.placed);
        if (found) return found;
      }
    }
    column = [];
    return;
  };
  for (const [index, event] of events.entries()) {
    if (event.rank === 0) {
      // Park and Miller's generator, fixed seed: a skip list's heights are
      // coin flips, and the same polygon always builds the same list.
      seed = (seed * 16_807) % 2_147_483_647;
      const height = 1 + Math.floor(-Math.log2(seed / 2_147_483_647));
      const entry = enter(head, event.slot.stretch, Math.min(LEVELS, height));
      event.slot.entry = entry;
      const [link] = entry.links;
      const found =
        meeting(link?.previous?.stretch?.placed, entry.stretch?.placed) ??
        meeting(entry.stretch?.placed, link?.next?.stretch?.placed);
      if (found) return found;
    } else if (event.rank === 1) {
      const { upright } = event;
      // Every arc crossing the meridian within the span meets this one, so
      // the walk stops at the first not excused, or past the north end.
      let entry: Entry | undefined = southOf(head, upright.south, LEVELS - 1);
      entry = entry.stretch ? entry : entry.links[0]?.next;
      while (entry?.stretch) {
        const found = meeting(upright.placed, entry.stretch.placed);
        if (found) return found;
        if (dot(entry.stretch.north, upright.north) < -TOLERANCE) break;
        entry = entry.links[0]?.next;
      }
      column.push(upright);
      const next = events[index + 1];
      if (next?.rank !== 1 || next.longitude !== event.longitude) {
        const found = columnMeeting();
        if (found) return found;
      }
    } else if (event.slot.entry) {
      const [link] = event.slot.entry.links;
      leave(event.slot.entry);
      const found = meeting(
        link?.previous?.stretch?.placed,
        link?.next?.stretch?.placed
      );
      if (found) return found;
    }
  }
  return;
}

/**
 * A point on no arc of the ring lies inside it when the meridian from the
 * point to the north pole, which no admitted ring encloses, crosses the ring
 * an odd number of times.
 */
function inside(point: UnwrappedPoint, ring: Ring): boolean {
  const facing = toVector(point.longitude, 0);
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

/*
 * A hole must lie strictly inside its outer ring, and holes must neither touch
 * nor overlap: PostGIS reads rings by parity, so a hole reaching outside its
 * outer ring added its own area (MySQL ignored it) and a point in two holes
 * matched (MySQL excluded it). A touch is refused as before D2, because it is
 * where the two databases' edges (sphere, ellipsoid) and tolerances part: a
 * hole written touching a straight parallel edge crosses that edge's arc, and
 * PostGIS matched the points beside the touch.
 */

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

function ringPath(ring: number): PropertyKey[] {
  return ring === 0 ? ["outer"] : ["holes", ring - 1];
}

/**
 * The walker admits the polygon's shape (exact keys, finite in-range
 * vertices, at least three per ring); the geometry then refuses the polygons
 * the databases answer wrongly: each ring alone, then the rings together.
 */
export function validateGeoPolygon(
  value: unknown
): ValidationResult<GeoPolygon> {
  const polygon = validateSchema(polygonRecord, value);
  if (polygon.issues) return polygon;
  const outer = ringArcs(polygon.value.outer, ["outer"]);
  if (outer.issues) return outer;
  const holes: { readonly points: GeoPoint[]; readonly arcs: Ring }[] = [];
  for (const [index, points] of (polygon.value.holes ?? []).entries()) {
    const hole = ringArcs(points, ["holes", index]);
    if (hole.issues) return hole;
    holes.push({ points, arcs: hole.value });
  }
  const rings = [outer.value, ...holes.map(({ arcs }) => arcs)];
  const placed = rings.flatMap((arcs, ring) =>
    arcs.map((arc, index) => ({ arc, ring, index, count: arcs.length }))
  );
  // Neighbors along a ring meet at their shared vertex.
  const found = firstMeeting(
    placed,
    (first, second) =>
      first.ring === second.ring &&
      [1, first.count - 1].includes(Math.abs(first.index - second.index))
  );
  if (found) {
    const [first, second] = found;
    const later = ringPath(Math.max(first.ring, second.ring));
    // A bowtie matched both lobes and its crossing point on both databases, a
    // parity reading the docs do not state; a ring going past a whole turn
    // over itself (0 to 400 degrees along a band) split them.
    if (first.ring === second.ring) {
      return fail("A GeoPolygon ring cannot self-intersect", later);
    }
    return Math.min(first.ring, second.ring) === 0
      ? fail("A GeoPolygon hole must be strictly inside its outer ring", later)
      : fail("GeoPolygon holes cannot touch or overlap", later);
  }
  // PostGIS and MySQL read such a ring as opposite regions: for a 340-degree
  // band PostGIS matched the poles and the antimeridian, MySQL the band. The
  // area is the trapezoid sum over longitude, a threshold, not a measure.
  for (const [ring, arcs] of rings.entries()) {
    if (sphericalArea(arcs) >= HALF_GLOBE_STERADIANS - TOLERANCE) {
      return fail(
        "A GeoPolygon must cover less than half the globe",
        ringPath(ring)
      );
    }
  }
  // No two rings meet, so one vertex places a whole ring.
  for (const [index, { arcs: hole }] of holes.entries()) {
    const [{ from }] = hole;
    if (!inside(from, outer.value)) {
      return fail("A GeoPolygon hole must be strictly inside its outer ring", [
        "holes",
        index,
      ]);
    }
    const nested = holes
      .slice(0, index)
      .some(
        ({ arcs: previous }) =>
          inside(from, previous) || inside(previous[0].from, hole)
      );
    if (nested) {
      return fail("GeoPolygon holes cannot touch or overlap", ["holes", index]);
    }
  }
  const wide = wound(polygon.value.outer, outer.value, true);
  const cut = holes.map(({ points, arcs }) => wound(points, arcs, false));
  // An empty and an absent holes list emit the same GeoJSON; one spelling
  // keeps them one validated argument, and so one cache key.
  return ok(cut.length > 0 ? { outer: wide, holes: cut } : { outer: wide });
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
