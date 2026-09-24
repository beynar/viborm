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
 * VibORM reads an edge as the great-circle arc between its vertices, so
 * crossings, touches and containment are judged on the unit sphere, never on
 * straight longitude/latitude lines, and the polygon is the side of its outer
 * ring away from both poles. A polygon is refused only when it has no single
 * meaning on that reading: a ring crossing, touching or retracing itself, a
 * ring of zero area, a hole not strictly inside its outer ring, holes touching
 * or overlapping, a vertex on a pole, which has no longitude, an edge whose
 * vertices are too nearly antipodal to fix its great circle. A valid polygon a
 * database reads differently is admitted: MySQL draws edges on the ellipsoid,
 * PostGIS misreads some rings reaching across all three coordinate planes
 * (docs/content/docs/schema/scalars/point.mdx, "How each database reads a
 * polygon", gives the measured differences).
 */

type Vector = readonly [x: number, y: number, z: number];

/** One ring vertex, its longitude unwrapped past ±180 along the ring. */
interface UnwrappedPoint {
  /**
   * The longitude unwrapped: it records how the ring travels (the edges'
   * directions, the area's lunes), never where the vertex lies.
   */
  readonly longitude: number;
  readonly latitude: number;
  /** The longitude as written, where `sweep` places it. */
  readonly written: number;
  /** The vertex on the unit sphere, from its written coordinates. */
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
  /**
   * The pole the arc runs over, when its longitudes differ by exactly 180
   * degrees: it rises along one meridian and falls along the other.
   */
  readonly pole: Vector | undefined;
}

/** A ring's arcs; a ring is refused before it could have fewer than two. */
type Ring = readonly [Arc, ...Arc[]];

const RADIANS = Math.PI / 180;
/**
 * An angle of 1e-9 degrees, about 0.1 mm: a point this near an arc is on it,
 * and an edge this short is a repeated vertex. It is VibORM's resolution,
 * at every ring size: against 60-digit geometry on 9,000 random rings 1e-9
 * to 1e-4 degrees across (every latitude, near the poles, on the
 * antimeridian), every ring whose edges and clearances exceed twice it was
 * judged exactly (4,048 simple rings admitted with the right winding, 2,135
 * crossing or touching ones refused), and so was every one of 6,190 polygons
 * with vertices 3.5e-9 to 3.6e-4 degrees from a pole, over it or around
 * holes. A smaller feature reads as a touch or a repeated vertex, so a ring
 * needs no size bound of its own, and a vertex needs no pole clearance.
 */
const TOLERANCE = 1e-9 * RADIANS;
/**
 * The chord between an edge's end and the antipode of its start below which
 * the edge is refused: 0.01 degrees. Two antipodal points lie on every great
 * circle through them, and near the antipode the circle an edge takes turns
 * by up to about 3e-12 / d degrees when a written coordinate moves by one
 * float64 step, d degrees from antipodal (measured over 2,000 random edges
 * per distance: at most 3.1e-9 degrees at d = 0.001, 9.8e-10 at 0.0032,
 * 3.0e-10 at 0.01). From 0.01 degrees out the edge's path is fixed to a
 * third of TOLERANCE; nearer, the written coordinates do not decide on which
 * side of it a point lies.
 */
const NEAREST_ANTIPODE = 2 * Math.sin(0.005 * RADIANS);

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
  const dx = first[0] - second[0];
  const dy = first[1] - second[1];
  const dz = first[2] - second[2];
  const sx = first[0] + second[0];
  const sy = first[1] + second[1];
  const sz = first[2] + second[2];
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

function antipode(vector: Vector): Vector {
  return [-vector[0], -vector[1], -vector[2]];
}

/** What an edge adds to its end's longitude to take the short way round. */
function shortWay(delta: number): number {
  if (delta > 180) return -360;
  if (delta < -180) return 360;
  return 0;
}

/** One distinct ring vertex, at its index in the ring. */
interface Distinct {
  readonly vertex: GeoPoint;
  readonly index: number;
  readonly vector: Vector;
}

/**
 * The ring's distinct vertices, closed on the first. A vertex within TOLERANCE
 * of a pole is refused: on the pole it has no longitude, and so no meridian
 * for its edges. A repeated consecutive vertex, the caller's closing vertex
 * included, is admitted as the zero-length edge both databases ignore, and
 * dropped here.
 */
function distinctVertices(
  ring: readonly GeoPoint[],
  path: readonly PropertyKey[]
): ValidationResult<Distinct[]> {
  const distinct: Distinct[] = [];
  for (const [index, vertex] of ring.entries()) {
    const vector = toVector(vertex.longitude, vertex.latitude);
    if (Math.hypot(vector[0], vector[1]) <= TOLERANCE) {
      return fail("A GeoPolygon ring cannot contain a pole", [...path, index]);
    }
    const last = distinct.at(-1);
    if (!last || chord(last.vector, vector) > TOLERANCE) {
      distinct.push({ vertex, index, vector });
    }
  }
  const [first] = distinct;
  const last = distinct.at(-1);
  if (first && last && chord(last.vector, first.vector) > TOLERANCE) {
    distinct.push(first);
  }
  return ok(distinct);
}

/**
 * The ring's arcs, each taking the short way round in longitude. An edge
 * whose longitudes differ by exactly 180 degrees has no short way: it runs
 * over the pole on the side of its endpoints' mean latitude, along one great
 * circle, and goes round whichever way leaves the ring no turn.
 */
function ringArcs(
  ring: readonly GeoPoint[],
  path: readonly PropertyKey[]
): ValidationResult<Ring> {
  const distinct = distinctVertices(ring, path);
  if (distinct.issues) return distinct;
  // The ring's turn in longitude, an edge over a pole taken as written.
  let turn = 0;
  for (const [position, { vertex }] of distinct.value.entries()) {
    const previous = distinct.value[position - 1];
    if (previous) {
      turn += shortWay(vertex.longitude - previous.vertex.longitude);
    }
  }
  const arcs: Arc[] = [];
  let wrap = 0;
  let from: UnwrappedPoint | undefined;
  let overPole: Vector | undefined;
  for (const { vertex, index, vector } of distinct.value) {
    let pole: Vector | undefined;
    if (from) {
      const delta = vertex.longitude - from.written;
      if (Math.abs(delta) === 180) {
        pole = [0, 0, Math.sign(vertex.latitude + from.latitude)];
        if (Math.abs(delta - turn) === 180) wrap -= turn;
      }
      wrap += shortWay(delta);
    }
    const to = {
      longitude: vertex.longitude + wrap,
      latitude: vertex.latitude,
      written: vertex.longitude,
      vector,
    };
    if (from) {
      if (chord(antipode(from.vector), vector) < NEAREST_ANTIPODE) {
        return fail(
          "A GeoPolygon edge cannot join vertices within 0.01 degrees of antipodal",
          [...path, index]
        );
      }
      // Over both poles the ring has no side away from both, and no way
      // round that leaves it no turn. Over one pole twice it crosses itself
      // there, which the sweep finds.
      if (pole && overPole && pole[2] !== overPole[2]) {
        return fail("A GeoPolygon cannot contain a pole", [...path]);
      }
      overPole ??= pole;
      arcs.push({
        from,
        to,
        start: from.vector,
        end: vector,
        normal: unit(cross(from.vector, vector)),
        pole,
      });
    }
    from = to;
  }
  // Longitudes that went once around the globe enclose a pole, and the ring
  // then has no side away from both poles.
  if (wrap !== 0) return fail("A GeoPolygon cannot contain a pole", [...path]);
  const [first, ...rest] = arcs;
  // The self-intersection no pair of non-neighbor arcs shows: a ring of at
  // most three arcs on one great circle retraces itself, and a ring of one
  // distinct vertex has no arc at all.
  if (
    !first ||
    (rest.length < 3 &&
      rest.every(({ start }) => Math.abs(side(first, start)) <= TOLERANCE))
  ) {
    return fail("A GeoPolygon ring must have non-zero area", [...path]);
  }
  // Neighbors meet at their shared vertex, which `sweep` excuses, unless
  // one doubles back along the other: such arcs overlap, and the sweep
  // cannot order arcs that overlap.
  let behind = first;
  for (const arc of [...rest, first]) {
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
 * other's great circle, and they hold the same one of the two antipodal
 * points where the circles meet. An arc shorter than half a circle holds a
 * point of it when the point lies on the side of the arc's middle, where
 * start + end points; arcs that straddle each other but hold opposite points
 * (a ring reaching across all three coordinate planes has such pairs) are
 * apart.
 */
function crosses(first: Arc, second: Arc): boolean {
  if (
    !(
      opposite(side(first, second.start), side(first, second.end)) &&
      opposite(side(second, first.start), side(second, first.end))
    )
  ) {
    return false;
  }
  const meeting = cross(first.normal, second.normal);
  return (
    dot(meeting, first.start) + dot(meeting, first.end) > 0 ===
    dot(meeting, second.start) + dot(meeting, second.end) > 0
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

/**
 * One ring of the polygon, and where `sweep` places it among the others:
 * `around` is the innermost ring around it, `inside` whether it lies inside
 * the outer ring, `firstAround` and `firstWithin` the first hole around it
 * and inside it.
 */
interface RingNode {
  /** 0 the outer ring, then the holes. */
  readonly index: number;
  /** The ring's index in `holes`, none for the outer ring. */
  readonly hole: number;
  readonly points: GeoPoint[];
  readonly arcs: Ring;
  readonly counterClockwise: boolean;
  around: RingNode | undefined;
  inside: boolean;
  firstAround: number;
  firstWithin: number;
}

/** An arc of `ring` at `index` along it. */
interface Placed {
  readonly arc: Arc;
  readonly ring: RingNode;
  readonly index: number;
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

/** The antimeridian on the equator. */
const ANTIMERIDIAN = toVector(180, 0);

/** The point where the arc crosses the antimeridian. */
function atAntimeridian(arc: Arc): Vector {
  const meeting = unit(
    cross(arc.normal, [-ANTIMERIDIAN[1], ANTIMERIDIAN[0], 0])
  );
  return dot(meeting, ANTIMERIDIAN) < 0 ? antipode(meeting) : meeting;
}

/**
 * At one longitude the arcs over a pole leave first, then the stretches
 * starting there enter, then the arcs along the meridian are walked, then the
 * stretches ending there leave.
 */
type Event =
  | { readonly longitude: number; readonly rank: 0 | 3; readonly slot: Slot }
  | { readonly longitude: number; readonly rank: 1; readonly slot: Slot }
  | { readonly longitude: number; readonly rank: 2; readonly upright: Upright };

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
  const { from, to, normal, pole } = placed.arc;
  const first = from.written === 180 ? -180 : from.written;
  const second = to.written === 180 ? -180 : to.written;
  if (first === second) {
    const [south, north] =
      from.latitude < to.latitude ? [from, to] : [to, from];
    const upright = { placed, south: south.vector, north: north.vector };
    return [{ longitude: first, rank: 2, upright }];
  }
  const eastward = from.longitude < to.longitude;
  const [west, east] = eastward ? [from, to] : [to, from];
  const north: Vector = eastward
    ? normal
    : [-normal[0], -normal[1], -normal[2]];
  const [low, high] = eastward ? [first, second] : [second, first];
  if (pole) return polarEvents(placed, pole, north, eastward, low, high);
  const span = (start: number, end: number, point: Vector): Event[] => {
    const slot = {
      stretch: { placed, west: point, east: east.vector, north, eastward },
      entry: undefined,
    };
    return [
      { longitude: start, rank: 1, slot },
      { longitude: end, rank: 3, slot },
    ];
  };
  return low < high
    ? span(low, high, west.vector)
    : [
        ...span(low, 180, west.vector),
        ...span(-180, high, atAntimeridian(placed.arc)),
      ];
}

/**
 * The sweep events of an arc over a pole: an arc along each of its meridians,
 * from its vertex to the pole, and between them a stretch at the pole, beyond
 * every other arc crossing those longitudes. The stretch keeps the arc's
 * circle, which has every point of the meridians between on its far side
 * from the pole. It leaves before the stretches starting on the arc's last
 * meridian enter, since the arc runs along that meridian there, which its
 * walk there covers.
 */
function polarEvents(
  placed: Placed,
  pole: Vector,
  north: Vector,
  eastward: boolean,
  low: number,
  high: number
): Event[] {
  const walks = [placed.arc.from, placed.arc.to].map(
    ({ written, vector }): Event => ({
      longitude: written === 180 ? -180 : written,
      rank: 2,
      upright: {
        placed,
        south: pole[2] > 0 ? vector : pole,
        north: pole[2] > 0 ? pole : vector,
      },
    })
  );
  const across = (start: number, end: number): Event[] => {
    const slot = {
      stretch: { placed, west: pole, east: pole, north, eastward },
      entry: undefined,
    };
    return [
      { longitude: start, rank: 1, slot },
      { longitude: end, rank: 0, slot },
    ];
  };
  if (low < high) return [...walks, ...across(low, high)];
  return [
    ...walks,
    ...across(low, 180),
    ...(high > -180 ? across(-180, high) : []),
  ];
}

/**
 * The point's latitude, in radians, which orders points on one meridian. Its
 * z coordinate alone does not: z rounds to ±1 within about 6e-7 degrees of a
 * pole, where rings arriving together would tie.
 */
function latitude(point: Vector): number {
  return Math.atan2(point[2], Math.hypot(point[0], point[1]));
}

/**
 * A ring on the meridian where the sweep first meets it, and the arc of
 * another ring first north of it there, if any.
 */
interface Placement {
  readonly ring: RingNode;
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
 * westernmost meeting, so admission takes expected n log n time in the arc
 * count however the arcs lie. At each longitude the arcs starting there enter
 * first; then each arc along that meridian is compared with the arcs crossing
 * its span, found by position; then the arcs ending there leave. Two arcs
 * along one meridian need no comparison of their own: where they meet, one
 * ends on the other, and the arc continuing its ring from that end crosses
 * the meridian there (a ring's arcs along one meridian that continue each
 * other end where the last one does, and a ring doubling back along a
 * meridian is refused in `ringArcs`), so the walk along the other one meets
 * it. An arc over a pole is walked along both its meridians, with a stretch
 * at the pole between them (`polarEvents`): two arcs over one pole meet
 * there, where either their stretches are neighbors at the pole or, when
 * their longitudes only touch, one's walk finds the other's stretch.
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
  const meeting = (
    first: Placed | undefined,
    second: Placed | undefined
  ): readonly [Placed, Placed] | undefined => {
    if (!(first && second)) return;
    if (apart(first, second) || !meet(first.arc, second.arc)) return;
    return [first, second];
  };
  const placements: Placement[] = [];
  // Each ring met for the first time on the sweep's meridian, with its
  // northernmost entry there so far.
  const arrivals = new Map<RingNode, { entry: Entry; west: Vector }>();
  const placeArrivals = (): void => {
    const arrived = Array.from(arrivals, ([ring, { entry, west }]) => {
      let next = entry.links[0]?.next;
      while (next?.stretch?.placed.ring === ring) next = next.links[0]?.next;
      return { ring, height: latitude(west), north: next?.stretch };
    });
    arrived.sort((left, right) => right.height - left.height);
    // One push per ring: a spread would pass every ring arriving on this
    // meridian as a call argument, past the engine's argument limit.
    for (const { ring, north } of arrived) placements.push({ ring, north });
    arrivals.clear();
  };
  const met = new Set<RingNode>();
  for (const [index, event] of events.entries()) {
    if (event.rank === 1) {
      // A skip list's heights are coin flips the input cannot know: heights
      // a polygon could predict let it keep its long-lived arcs low and make
      // every search walk them one by one. The verdict does not depend on
      // them: arcs that meet are neighbors before they meet at any height.
      const height = 1 + Math.floor(-Math.log2(1 - Math.random()));
      const entry = enter(head, event.slot.stretch, Math.min(LEVELS, height));
      event.slot.entry = entry;
      const [link] = entry.links;
      const found =
        meeting(link?.previous?.stretch?.placed, entry.stretch?.placed) ??
        meeting(entry.stretch?.placed, link?.next?.stretch?.placed);
      if (found) return { meeting: found };
      const { placed, west } = event.slot.stretch;
      const top = arrivals.get(placed.ring);
      if (
        !met.has(placed.ring) ||
        (top && latitude(west) > latitude(top.west))
      ) {
        met.add(placed.ring);
        arrivals.set(placed.ring, { entry, west });
      }
      const next = events[index + 1];
      if (next?.rank !== 1 || next.longitude !== event.longitude) {
        placeArrivals();
      }
    } else if (event.rank === 2) {
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
 * pole's triangle loses its precision. The lunes' longitudes telescope, so
 * each run of such arcs adds the longitude from its start to its end: a ring
 * near the south pole is one run, and its lunes add exactly nothing, where
 * summed arc by arc their rounding would outweigh its area. No admitted ring
 * has a pole inside it (`wrap` in `ringArcs`), so this is the area on the
 * ring's pole-free side, and its sign says on which side of its arcs that
 * area lies.
 */
function signedArea(ring: Ring): number {
  let sum = 0;
  let lune = 0;
  let run: number | undefined;
  let end = 0;
  for (const arc of ring) {
    const turn = cross(arc.start, arc.end)[2];
    const along = 1 + dot(arc.start, arc.end);
    const lift = arc.start[2] + arc.end[2];
    if (lift >= 0) {
      sum += 2 * Math.atan2(turn, along + lift);
      if (run !== undefined) lune += arc.from.longitude - run;
      run = undefined;
    } else {
      sum += 2 * Math.atan2(-turn, along - lift);
      run ??= arc.from.longitude;
    }
    end = arc.to.longitude;
  }
  if (run !== undefined) lune += end - run;
  return sum + 2 * lune * RADIANS;
}

/*
 * A hole must lie strictly inside its outer ring, and holes must neither touch
 * nor overlap: a hole reaching outside its outer ring, or a point in two
 * holes, has no single reading (PostGIS reads rings by parity and added the
 * hole's area, or matched the point; MySQL ignored the hole, or excluded the
 * point). A touch is refused with them: a hole written touching a straight
 * parallel edge crosses that edge's arc.
 */

/**
 * Kept output normalization, not a refusal: the GeoJSON that withinPolygon
 * binds (adapters/databases/{postgres,mysql}) always carries a counterclockwise
 * outer ring and clockwise holes, because neither database's reading of ring
 * orientation is proven portable (v1-public-api-geopoint-plan.md).
 */
function wound(
  ring: GeoPoint[],
  counterClockwise: boolean,
  wanted: boolean
): GeoPoint[] {
  return counterClockwise === wanted ? ring : ring.reverse();
}

function ringPath(ring: number): PropertyKey[] {
  return ring === 0 ? ["outer"] : ["holes", ring - 1];
}

function ringNode(points: GeoPoint[], arcs: Ring, index: number): RingNode {
  return {
    index,
    hole: index === 0 ? Number.POSITIVE_INFINITY : index - 1,
    points,
    arcs,
    counterClockwise: signedArea(arcs) > 0,
    around: undefined,
    inside: false,
    firstAround: Number.POSITIVE_INFINITY,
    firstWithin: Number.POSITIVE_INFINITY,
  };
}

/**
 * The walker admits the polygon's shape (exact keys, finite in-range
 * vertices, at least three per ring); the geometry then refuses the polygons
 * with no single meaning: each ring alone, then the rings together.
 */
export function validateGeoPolygon(
  value: unknown
): ValidationResult<GeoPolygon> {
  const polygon = validateSchema(polygonRecord, value);
  if (polygon.issues) return polygon;
  const outer = ringArcs(polygon.value.outer, ["outer"]);
  if (outer.issues) return outer;
  const shell = ringNode(polygon.value.outer, outer.value, 0);
  const holes: RingNode[] = [];
  for (const [index, points] of (polygon.value.holes ?? []).entries()) {
    const hole = ringArcs(points, ["holes", index]);
    if (hole.issues) return hole;
    holes.push(ringNode(points, hole.value, index + 1));
  }
  const placed = [shell, ...holes].flatMap((ring) =>
    ring.arcs.map((arc, index) => ({ arc, ring, index }))
  );
  // Neighbors along a ring meet at their shared vertex; an arc over a pole
  // meets itself where its walks find its stretch.
  const swept = sweep(
    placed,
    (first, second) =>
      first.ring === second.ring &&
      [0, 1, first.ring.arcs.length - 1].includes(
        Math.abs(first.index - second.index)
      )
  );
  if (swept.meeting) {
    const [first, second] = swept.meeting;
    const later = ringPath(Math.max(first.ring.index, second.ring.index));
    // A bowtie matched both lobes and its crossing point on both databases, a
    // parity reading the docs do not state; a ring going past a whole turn
    // over itself (0 to 400 degrees along a band) split them.
    if (first.ring === second.ring) {
      return fail("A GeoPolygon ring cannot self-intersect", later);
    }
    return Math.min(first.ring.index, second.ring.index) === 0
      ? fail("A GeoPolygon hole must be strictly inside its outer ring", later)
      : fail("GeoPolygon holes cannot touch or overlap", later);
  }
  // No two rings meet, so where the sweep first met a ring places all of it:
  // inside the ring of the arc north of it when that arc has its ring's
  // interior to the south (a counterclockwise ring's interior is on the left
  // of its arcs), else beside that ring, in the ring around it, which the
  // sweep placed first.
  for (const { ring, north } of swept.placements) {
    const other = north?.placed.ring;
    const around =
      other === undefined || other.counterClockwise !== north?.eastward
        ? other
        : other.around;
    ring.around = around;
    ring.inside = around !== undefined && (around.index === 0 || around.inside);
    ring.firstAround = around
      ? Math.min(around.hole, around.firstAround)
      : Number.POSITIVE_INFINITY;
  }
  // Reversed in place, the list's last use: every ring now comes before the
  // ring around it, which collects the first hole within it.
  for (const { ring } of swept.placements.reverse()) {
    const { around } = ring;
    if (around) {
      around.firstWithin = Math.min(
        around.firstWithin,
        ring.hole,
        ring.firstWithin
      );
    }
  }
  for (const { hole, inside, firstAround, firstWithin } of holes) {
    if (!inside) {
      return fail("A GeoPolygon hole must be strictly inside its outer ring", [
        "holes",
        hole,
      ]);
    }
    if (Math.min(firstAround, firstWithin) < hole) {
      return fail("GeoPolygon holes cannot touch or overlap", ["holes", hole]);
    }
  }
  const wide = wound(shell.points, shell.counterClockwise, true);
  const cut = holes.map(({ points, counterClockwise }) =>
    wound(points, counterClockwise, false)
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
