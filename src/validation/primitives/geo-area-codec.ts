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
  /** The longitude as written, where `sweep` places it. */
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
/**
 * The smallest ring MySQL answers. MySQL answers points within about 1e-6
 * degrees of any vertex unlike PostGIS and the sphere (about 13% of them, at
 * every edge length; none from 1.8e-6 out), and in a ring a few 1e-6 degrees
 * across every point is that near a vertex: it put up to 9% of the points
 * 0.1 of the ring away from every edge on the wrong side (PostGIS none), and
 * none of 16,000 in rings 1.4e-5 across. A ring must reach this far, about
 * 2 m, from its first vertex, so that it is at least 1.4e-5 degrees across.
 */
const SMALLEST_RING = 2e-5 * RADIANS;
/**
 * MySQL's edge leaves the great-circle arc by at most 0.075 degrees on a
 * 90-degree edge and 0.46 on a 150-degree one, then by 1% of the edge from
 * about 171 degrees and by 16 at 179, where it answers points far from the
 * edge unlike the sphere; the dot product of an edge's end vectors must exceed
 * the cosine of 150 degrees.
 */
const LONGEST_EDGE_COSINE = Math.cos(150 * RADIANS);
/**
 * The nearest a vertex may come to a pole, about 11 m. With two consecutive
 * vertices a few 1e-6 degrees from a pole, MySQL (from 3e-6 down) and PostGIS
 * (from 6e-7 down) answered points 70 degrees from the ring wrongly, and none
 * of about 1,500 such rings from 5.6e-6 out; a vertex on the pole has no
 * longitude, and PostGIS drew its edges along meridians while MySQL matched
 * the equator and the opposite pole.
 */
const POLE_CLEARANCE = 1e-4;
const AXES: readonly (0 | 1 | 2)[] = [0, 1, 2];

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

/**
 * first × second, taken as (first − second) × (first + second) / 2: the same
 * vector, but the difference of two nearby points is exact, so the normal of
 * a short arc keeps its direction; taken plainly it loses it at 1e-7 degrees
 * (a bowtie that size at latitude 45 was admitted).
 */
function cross(first: Vector, second: Vector): Vector {
  const [dx, dy, dz] = [
    first[0] - second[0],
    first[1] - second[1],
    first[2] - second[2],
  ];
  const [sx, sy, sz] = [
    first[0] + second[0],
    first[1] + second[1],
    first[2] + second[2],
  ];
  return [
    (dy * sz - dz * sy) / 2,
    (dz * sx - dx * sz) / 2,
    (dx * sy - dy * sx) / 2,
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
  let reach = 0;
  let origin: Vector | undefined;
  let previous: GeoPoint | undefined;
  let from: UnwrappedPoint | undefined;
  for (const [index, vertex] of [...ring, ...ring.slice(0, 1)].entries()) {
    const at = [...path, index % ring.length];
    if (GEO_LATITUDE_MAX - Math.abs(vertex.latitude) < POLE_CLEARANCE) {
      return fail(
        "A GeoPolygon vertex must be at least 1e-4 degrees from a pole",
        at
      );
    }
    if (previous) {
      const delta = vertex.longitude - previous.longitude;
      // No short way round in longitude: the arc runs through a pole, where
      // the two databases answered (0, 80) differently for (0, 10) to
      // (180, 10), or joins antipodal endpoints, which PostGIS raises for.
      if (Math.abs(delta) === 180) {
        return fail("A GeoPolygon edge cannot span exactly 180 degrees", at);
      }
      if (delta > 180) wrap -= 360;
      if (delta < -180) wrap += 360;
    }
    previous = vertex;
    const longitude = vertex.longitude + wrap;
    const vector = toVector(longitude, vertex.latitude);
    origin ??= vector;
    reach = Math.max(reach, chord(origin, vector));
    const to = {
      longitude,
      latitude: vertex.latitude,
      written: vertex.longitude,
      vector,
    };
    if (!from || chord(from.vector, vector) > TOLERANCE) {
      if (from && dot(from.vector, vector) <= LONGEST_EDGE_COSINE) {
        return fail("A GeoPolygon edge must be shorter than 150 degrees", at);
      }
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
  const [first, ...rest] = arcs;
  if (!first || reach < SMALLEST_RING) {
    return fail("A GeoPolygon ring must be at least 2e-5 degrees across", [
      ...path,
    ]);
  }
  // The self-intersection no pair of non-neighbor arcs shows: a ring of at
  // most three arcs on one great circle retraces itself, and both databases
  // matched its outline only.
  if (
    rest.length < 3 &&
    rest.every(({ start }) => Math.abs(side(first, start)) <= TOLERANCE)
  ) {
    return fail("A GeoPolygon ring must have non-zero area", [...path]);
  }
  // Neighbors meet at their shared vertex, which `sweep` excuses, unless
  // one doubles back along the other: such arcs overlap, and the sweep
  // cannot order arcs that overlap.
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
 * The two arcs cross at one point interior to both: each straddles the
 * other's great circle. The circles also meet at the antipode, but arcs that
 * straddle each other and meet only there hold two antipodal points, which
 * the rings of no admitted polygon do: each lies on one side of the equator
 * or of a meridian plane (`across` in `validateGeoPolygon`), where two
 * antipodal points share the plane and so the arcs through them the circle.
 */
function crosses(first: Arc, second: Arc): boolean {
  return (
    opposite(side(first, second.start), side(first, second.end)) &&
    opposite(side(second, first.start), side(second, first.end))
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
  /** Whether the arc runs east, so that its normal is `north`. */
  readonly eastward: boolean;
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
      stretch: { placed, west: point, east: east.vector, north, eastward },
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
 * A ring on the meridian where the sweep first meets it, and the arc of
 * another ring first north of it there, if any.
 */
interface Placement {
  readonly ring: number;
  readonly north: Stretch | undefined;
}

type Swept =
  | { readonly meeting: readonly [Placed, Placed] }
  | { readonly meeting?: undefined; readonly placements: Placement[] };

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
 *
 * Failing a meeting, where each ring was first met: once the arcs starting
 * on that meridian have entered, the arc north of the ring's northernmost
 * point there, skipping the ring's own arcs through that point. The rings
 * met on one meridian are listed north to south, so every ring is listed
 * after the ring of the arc north of it.
 */
function sweep(
  arcs: readonly Placed[],
  apart: (first: Placed, second: Placed) => boolean
): Swept {
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
  const placements: Placement[] = [];
  // Each ring met for the first time on the sweep's meridian, with its
  // northernmost entry there so far.
  const arrivals = new Map<number, { entry: Entry; west: Vector }>();
  const placeArrivals = (): void => {
    const arrived = [...arrivals].map(([ring, { entry, west }]) => {
      let next = entry.links[0]?.next;
      while (next?.stretch?.placed.ring === ring) next = next.links[0]?.next;
      return { ring, height: west[2], north: next?.stretch };
    });
    arrived.sort((left, right) => right.height - left.height);
    placements.push(...arrived.map(({ ring, north }) => ({ ring, north })));
    arrivals.clear();
  };
  const met = new Set<number>();
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
      if (found) return { meeting: found };
      const { placed, west } = event.slot.stretch;
      const top = arrivals.get(placed.ring);
      if (!met.has(placed.ring) || (top && west[2] > top.west[2])) {
        met.add(placed.ring);
        arrivals.set(placed.ring, { entry, west });
      }
      const next = events[index + 1];
      if (next?.rank !== 0 || next.longitude !== event.longitude) {
        placeArrivals();
      }
    } else if (event.rank === 1) {
      const { upright } = event;
      // Every arc crossing the meridian within the span meets this one, so
      // the walk stops at the first not excused, or past the north end.
      let entry: Entry | undefined = southOf(head, upright.south, LEVELS - 1);
      entry = entry.stretch ? entry : entry.links[0]?.next;
      while (entry?.stretch) {
        const found = meeting(upright.placed, entry.stretch.placed);
        if (found) return { meeting: found };
        if (dot(entry.stretch.north, upright.north) < -TOLERANCE) break;
        entry = entry.links[0]?.next;
      }
      column.push(upright);
      const next = events[index + 1];
      if (next?.rank !== 1 || next.longitude !== event.longitude) {
        const found = columnMeeting();
        if (found) return { meeting: found };
      }
    } else if (event.slot.entry) {
      const [link] = event.slot.entry.links;
      leave(event.slot.entry);
      const found = meeting(
        link?.previous?.stretch?.placed,
        link?.next?.stretch?.placed
      );
      if (found) return { meeting: found };
    }
  }
  return { placements };
}

/**
 * The ring's signed area in steradians, positive when counterclockwise: the
 * sum of the triangles each arc makes with the north pole (Van Oosterom and
 * Strackee), taken through the south pole's triangle and the lune between the
 * arc's meridians when the arc lies nearer the south pole, where the north
 * pole's triangle loses its precision. Both poles lie outside every admitted
 * ring (`wrap` in `ringArcs`), so this is the area on the ring's pole-free
 * side, and its sign says on which side of its arcs that area lies.
 */
function signedArea(ring: Ring): number {
  let sum = 0;
  for (const { from, to, start, end } of ring) {
    const turn = cross(start, end)[2];
    const along = 1 + dot(start, end);
    const lift = start[2] + end[2];
    sum +=
      lift >= 0
        ? 2 * Math.atan2(turn, along + lift)
        : 2 * Math.atan2(-turn, along - lift) +
          2 * (to.longitude - from.longitude) * RADIANS;
  }
  return sum;
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
  counterClockwise: boolean | undefined,
  wanted: boolean
): GeoPoint[] {
  return counterClockwise === wanted ? ring : ring.reverse();
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
  // PostGIS tests a point against a reference point outside the polygon's
  // box, which it widens to the pole of every axis whose other two
  // coordinates the rings take on both sides of zero (liblwgeom
  // gbox_check_poles; an arc takes no sign its ends lack). An outer ring with
  // vertices on both sides of the equator, of the 0/180 meridian and of the
  // 90/-90 meridian widens it to the whole globe (gbox_pt_outside fails), and
  // PostGIS falls back to one of two points depending on the query path: 0.2
  // of a unit normal right of the first edge sent (lwpoly_pt_outside_hack),
  // or the antipode of the centre of its circle tree over the edges
  // (circ_tree_get_point_outside), which its incremental merge of the edges'
  // circles in groups of eight decides. Table scans went wrong on 42 of 44
  // random ring rotations where either point fell inside and on none of 436
  // where both fell outside (MySQL on none); 23 of 372 random such rings
  // were misread, one of them 27% of half the globe, and none of 494 across
  // at most two planes. The
  // refusal is deliberately wider than those rings: which side the second
  // point falls depends on liblwgeom's tree arithmetic, so it refuses rings
  // both databases answer correctly, such as the Pacific from 115 to -75
  // degrees. A ring of half the globe or more reaches across all three,
  // since a ring on one side of a plane through the poles or of the equator
  // encloses less, and holes inside it add no side.
  const across = AXES.every((axis) => {
    const signs = polygon.value.outer.map(
      ({ longitude, latitude }) => toVector(longitude, latitude)[axis]
    );
    return signs.some((sign) => sign < 0) && signs.some((sign) => sign > 0);
  });
  if (across) {
    return fail(
      "A GeoPolygon cannot reach across the equator and the 0/180 and 90/-90 meridians at once",
      ["outer"]
    );
  }
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
  const swept = sweep(
    placed,
    (first, second) =>
      first.ring === second.ring &&
      [1, first.count - 1].includes(Math.abs(first.index - second.index))
  );
  if (swept.meeting) {
    const [first, second] = swept.meeting;
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
  const counterClockwise = rings.map((ring) => signedArea(ring) > 0);
  // No two rings meet, so where the sweep first met a ring places all of it:
  // inside the ring of the arc north of it when that arc has its ring's
  // interior to the south (a counterclockwise ring's interior is on the left
  // of its arcs), else beside that ring, in the ring around it, which the
  // sweep placed first. `around` is the innermost ring around each ring;
  // `firstAround` and `firstWithin` the first hole around it and inside it.
  const none = Number.POSITIVE_INFINITY;
  const around: (number | undefined)[] = [];
  const inOuter: boolean[] = [];
  const firstAround: number[] = [];
  const firstWithin: number[] = rings.map(() => none);
  for (const { ring, north } of swept.placements) {
    const other = north?.placed.ring;
    const enclosing =
      other === undefined || counterClockwise[other] !== north?.eastward
        ? other
        : around[other];
    around[ring] = enclosing;
    inOuter[ring] =
      enclosing !== undefined &&
      (enclosing === 0 || inOuter[enclosing] === true);
    firstAround[ring] = enclosing
      ? Math.min(enclosing - 1, firstAround[enclosing] ?? none)
      : none;
  }
  for (const { ring } of [...swept.placements].reverse()) {
    const enclosing = around[ring];
    if (enclosing) {
      firstWithin[enclosing] = Math.min(
        firstWithin[enclosing] ?? none,
        ring - 1,
        firstWithin[ring] ?? none
      );
    }
  }
  for (const index of holes.keys()) {
    if (!inOuter[index + 1]) {
      return fail("A GeoPolygon hole must be strictly inside its outer ring", [
        "holes",
        index,
      ]);
    }
    const first = Math.min(
      firstAround[index + 1] ?? none,
      firstWithin[index + 1] ?? none
    );
    if (first < index) {
      return fail("GeoPolygon holes cannot touch or overlap", ["holes", index]);
    }
  }
  const wide = wound(polygon.value.outer, counterClockwise[0], true);
  const cut = holes.map(({ points }, index) =>
    wound(points, counterClockwise[index + 1], false)
  );
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
