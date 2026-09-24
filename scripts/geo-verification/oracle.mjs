/**
 * Independent judges of GeoPolygon geometry. Nothing here imports VibORM: each
 * judge was written apart from `src/validation/primitives/geo-area-codec.ts`
 * so that agreeing with it means something.
 *
 * - `parityInside`: even-odd point in polygon on the sphere, counting the
 *   great-circle arcs a path from the point to a reference point outside the
 *   polygon crosses (review round 3). Judges database answers.
 * - `judgeGeometry`: brute-force float64 judge of a polygon, every pair of
 *   arcs compared, holes placed by a meridian ray to the north pole (review
 *   round 7). Judges VibORM's verdict on rings away from the poles.
 * - `judgeNearPole`: 80-digit fixed-point geometry in the gnomonic projection
 *   from the north pole, where every great circle is a straight line
 *   (owner-rule second pass). Judges verdict, message and winding for rings a
 *   few 1e-9 to 80 degrees from a pole, over it included.
 */

const RADIANS = Math.PI / 180;

/** VibORM's resolution, 1e-9 degrees, restated here as a number of radians. */
export const TOLERANCE = 1e-9 * RADIANS;

// ---------------------------------------------------------------------------
// float64 vectors on the unit sphere
// ---------------------------------------------------------------------------

export const vec = (point) => [
  Math.cos(point.latitude * RADIANS) * Math.cos(point.longitude * RADIANS),
  Math.cos(point.latitude * RADIANS) * Math.sin(point.longitude * RADIANS),
  Math.sin(point.latitude * RADIANS),
];
export const toPoint = (vector) => ({
  longitude: Math.atan2(vector[1], vector[0]) / RADIANS,
  latitude:
    Math.asin(Math.max(-1, Math.min(1, vector[2] / Math.hypot(...vector)))) /
    RADIANS,
});
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const plus = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const normalize = (a) => {
  const length = Math.hypot(...a);
  return [a[0] / length, a[1] / length, a[2] / length];
};
export const angle = (a, b) =>
  Math.atan2(Math.hypot(...cross(a, b)), dot(a, b));
/** a × b from the vertex difference and sum, (a − b) × (a + b) / 2: keeps a short arc's direction. */
export const differenceCross = (a, b) =>
  scale(cross(plus(a, scale(b, -1)), plus(a, b)), 0.5);

export const rings = (polygon) => [polygon.outer, ...(polygon.holes ?? [])];

// ---------------------------------------------------------------------------
// Points: even-odd parity on the sphere (review round 3)
// ---------------------------------------------------------------------------

/** Is x, on the circle of the minor arc a → b with normal n, on that arc? */
const onMinorArc = (x, a, b, n) =>
  dot(cross(a, x), n) >= 0 && dot(cross(x, b), n) >= 0;

function arcsCross(a, b, c, d) {
  const n1 = cross(a, b);
  const n2 = cross(c, d);
  const line = cross(n1, n2);
  if (Math.hypot(...line) < 1e-15) return false;
  for (const sign of [1, -1]) {
    const x = normalize(scale(line, sign));
    if (onMinorArc(x, a, b, n1) && onMinorArc(x, c, d, n2)) return true;
  }
  return false;
}

/** Angular distance, in radians, from x to the minor arc a → b. */
export function distanceToArc(x, a, b) {
  const n = differenceCross(a, b);
  const length = Math.hypot(...n);
  if (length < 1e-18) return angle(x, a);
  const unit = scale(n, 1 / length);
  const h = dot(x, unit);
  const projection = normalize(plus(x, scale(unit, -h)));
  if (angle(a, projection) + angle(projection, b) - angle(a, b) < 1e-12) {
    return Math.asin(Math.min(1, Math.abs(h)));
  }
  return Math.min(angle(x, a), angle(x, b));
}

/**
 * The point's clearance from every edge: `degrees`, the smallest distance,
 * and `relative`, the smallest distance divided by its edge's length.
 */
export function edgeClearance(point, polygon) {
  const x = vec(point);
  let degrees = Number.POSITIVE_INFINITY;
  let relative = Number.POSITIVE_INFINITY;
  for (const ring of rings(polygon)) {
    const vectors = ring.map(vec);
    for (const [index, a] of vectors.entries()) {
      const b = vectors[(index + 1) % vectors.length];
      const distance = distanceToArc(x, a, b);
      degrees = Math.min(degrees, distance / RADIANS);
      relative = Math.min(relative, distance / Math.max(angle(a, b), 1e-12));
    }
  }
  return { degrees, relative };
}

/** The antipode of the outer ring's vertex mean: outside any small polygon. */
export const antipodalReference = (polygon) =>
  normalize(scale(polygon.outer.map(vec).reduce(plus, [0, 0, 0]), -1));

/** Even-odd count of the arcs crossed on the way from the point to `reference`. */
export function parityInside(point, polygon, reference) {
  const x = vec(point);
  let inside = false;
  for (const ring of rings(polygon)) {
    const vectors = ring.map(vec);
    for (const [index, a] of vectors.entries()) {
      const b = vectors[(index + 1) % vectors.length];
      if (angle(a, b) >= 1e-14 && arcsCross(x, reference, a, b)) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/**
 * Inside a polygon lying in the hemisphere of `sign` (1 north, -1 south):
 * gnomonic projection from that pole, then the planar even-odd rule.
 */
export function insideFromPole(point, polygon, sign) {
  if (Math.sign(point.latitude) !== sign) return false;
  const project = (q) => {
    const radius = Math.tan((90 - sign * q.latitude) * RADIANS);
    return [
      radius * Math.cos(q.longitude * RADIANS),
      radius * Math.sin(q.longitude * RADIANS),
    ];
  };
  const x = project(point);
  const inRing = (ring) => {
    let inside = false;
    const plane = ring.map(project);
    for (const [index, a] of plane.entries()) {
      const b = plane[(index + 1) % plane.length];
      if (a[1] > x[1] !== b[1] > x[1]) {
        const crossing = ((b[0] - a[0]) * (x[1] - a[1])) / (b[1] - a[1]) + a[0];
        if (x[0] < crossing) inside = !inside;
      }
    }
    return inside;
  };
  return inRing(polygon.outer) && !(polygon.holes ?? []).some(inRing);
}

// ---------------------------------------------------------------------------
// Verdicts away from the poles: every pair of arcs (review round 7)
// ---------------------------------------------------------------------------

/** Is p, on the circle of arc s → e, within `slack` radians of the arc? */
const withinArc = (p, s, e, slack) =>
  angle(s, p) + angle(p, e) - angle(s, e) <= slack;

function pointToArc(p, s, e) {
  const n = normalize(differenceCross(s, e));
  const h = dot(n, p);
  const projection = normalize(plus(p, scale(n, -h)));
  if (withinArc(projection, s, e, 1e-15)) {
    return Math.asin(Math.min(1, Math.abs(h)));
  }
  return Math.min(angle(p, s), angle(p, e));
}

/**
 * Do two arcs meet? `slack` > 0 counts arcs within `slack` radians as meeting
 * (lenient); `slack` < 0 asks for a crossing clear of the ends by |slack| or an
 * exact touch (strict). A polygon judged the same both ways is unambiguous at
 * that scale.
 */
function arcsMeet(a1, a2, b1, b2, slack) {
  const m = cross(
    normalize(differenceCross(a1, a2)),
    normalize(differenceCross(b1, b2))
  );
  if (Math.hypot(...m) > 1e-12) {
    const p = normalize(m);
    for (const q of [p, scale(p, -1)]) {
      const onBoth = withinArc(q, a1, a2, 1e-15) && withinArc(q, b1, b2, 1e-15);
      if (onBoth && slack >= 0) return true;
      const clear = [a1, a2, b1, b2].every((end) => angle(q, end) > -slack);
      if (onBoth && clear) return true;
    }
  }
  const nearest = Math.min(
    pointToArc(a1, b1, b2),
    pointToArc(a2, b1, b2),
    pointToArc(b1, a1, a2),
    pointToArc(b2, a1, a2)
  );
  return slack >= 0 ? nearest <= slack : nearest <= 0;
}

/** A ring's distinct vertices with unwrapped longitudes, or the reason it has none. */
function ringInfo(ring) {
  let wrap = 0;
  let previous;
  const points = [];
  for (const p of [...ring, ring[0]]) {
    const v = vec(p);
    if (Math.hypot(v[0], v[1]) <= TOLERANCE) return { error: "pole" };
    if (previous) {
      const step = p.longitude - previous.longitude;
      // An edge of exactly 180 degrees runs over a pole: judgeNearPole's domain.
      if (Math.abs(step) === 180) return { error: "domain" };
      if (step > 180) wrap -= 360;
      if (step < -180) wrap += 360;
    }
    previous = p;
    const last = points.at(-1);
    if (!last || angle(last.v, v) > TOLERANCE) {
      points.push({
        lon: p.longitude,
        lat: p.latitude,
        ulon: p.longitude + wrap,
        v,
      });
    }
  }
  if (wrap !== 0) return { error: "pole-enclosed" };
  if (angle(points.at(-1).v, points[0].v) <= TOLERANCE) points.pop();
  if (points.length < 3) return { error: "zero-area" };
  for (const [index, p] of points.entries()) {
    const q = points[(index + 1) % points.length];
    if (angle(p.v, scale(q.v, -1)) < 0.01 * RADIANS)
      return { error: "antipodal" };
  }
  return { points };
}

const arcsOf = (points) =>
  points.map((p, index) => {
    const q = points[(index + 1) % points.length];
    return { s: p.v, e: q.v, sl: p.ulon, el: q.ulon };
  });

/** Meridian ray from the point to the north pole: odd crossings, inside. */
function insideByRay(point, arcs) {
  const { longitude, latitude } = point;
  let count = 0;
  for (const arc of arcs) {
    const turns = Math.floor((arc.sl - longitude + 180) / 360);
    const west = arc.sl - 360 * turns;
    const east = arc.el - 360 * turns;
    const spans = [longitude - 360, longitude, longitude + 360].some(
      (x) =>
        (west < east && x > west && x <= east) ||
        (east < west && x > east && x <= west)
    );
    if (!spans) continue;
    const meridian = [
      -Math.sin(longitude * RADIANS),
      Math.cos(longitude * RADIANS),
      0,
    ];
    let q = normalize(cross(differenceCross(arc.s, arc.e), meridian));
    const facing = [
      Math.cos(longitude * RADIANS),
      Math.sin(longitude * RADIANS),
      0,
    ];
    if (dot(q, facing) < 0) q = scale(q, -1);
    if (Math.asin(Math.max(-1, Math.min(1, q[2]))) / RADIANS > latitude)
      count += 1;
  }
  return count % 2 === 1;
}

/**
 * "ok", or the first reason the polygon has no single meaning: "pole",
 * "pole-enclosed", "zero-area", "antipodal", "self", "outside", "overlap";
 * "domain" for an edge over a pole, which this judge does not read.
 */
export function judgeGeometry(polygon, slack) {
  const all = rings(polygon);
  const arcSets = [];
  for (const ring of all) {
    const info = ringInfo(ring);
    if (info.error) return info.error;
    arcSets.push(arcsOf(info.points));
  }
  const touch = Math.max(slack, TOLERANCE);
  for (const arcs of arcSets) {
    const n = arcs.length;
    for (let i = 0; i < n; i += 1) {
      const a = arcs[i];
      const b = arcs[(i + 1) % n];
      if (
        pointToArc(b.e, a.s, a.e) <= touch ||
        pointToArc(a.s, b.s, b.e) <= touch
      ) {
        return "self";
      }
      for (let j = i + 2; j < n; j += 1) {
        const neighbours = i === 0 && j === n - 1;
        if (!neighbours && arcsMeet(a.s, a.e, arcs[j].s, arcs[j].e, slack)) {
          return "self";
        }
      }
    }
  }
  for (let r1 = 0; r1 < arcSets.length; r1 += 1) {
    for (let r2 = r1 + 1; r2 < arcSets.length; r2 += 1) {
      for (const a of arcSets[r1]) {
        for (const b of arcSets[r2]) {
          if (arcsMeet(a.s, a.e, b.s, b.e, slack)) {
            return r1 === 0 ? "outside" : "overlap";
          }
        }
      }
    }
  }
  const firsts = all.map((ring) => ring[0]);
  for (let h = 1; h < arcSets.length; h += 1) {
    if (!insideByRay(firsts[h], arcSets[0])) return "outside";
  }
  for (let h = 1; h < arcSets.length; h += 1) {
    for (let k = 1; k < arcSets.length; k += 1) {
      if (h !== k && insideByRay(firsts[h], arcSets[k])) return "overlap";
    }
  }
  return "ok";
}

/** A ring set the judge can place a hole in (for generators). */
export function insideRing(point, ring) {
  const info = ringInfo(ring);
  return !info.error && insideByRay(point, arcsOf(info.points));
}

// ---------------------------------------------------------------------------
// Near the poles: 80-digit gnomonic geometry (owner-rule second pass)
// ---------------------------------------------------------------------------

// Fixed point: a BigInt n stands for n / 10^DIGITS. The judge's decisions
// involve products of plane coordinates down to about 1e-24, far above the
// 1e-80 step.
const DIGITS = 80;
const ONE = 10n ** BigInt(DIGITS);
const absolute = (n) => (n < 0n ? -n : n);
function roundedQuotient(numerator, denominator) {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (2n * absolute(remainder) < absolute(denominator)) return quotient;
  return numerator < 0n === denominator < 0n ? quotient + 1n : quotient - 1n;
}
const times = (a, b) => roundedQuotient(a * b, ONE);
const over = (a, b) => roundedQuotient(a * ONE, b);
function squareRoot(a) {
  if (a <= 0n) return 0n;
  const n = a * ONE;
  // Newton's method from above: the float guess, raised past its rounding.
  const guess = Math.sqrt(Number(a) / Number(ONE)) * (1 + 1e-12);
  let x = BigInt(Math.ceil(guess * 1e15)) * 10n ** BigInt(DIGITS - 15) + 1n;
  for (;;) {
    const next = (x + n / x) / 2n;
    if (next >= x) return x;
    x = next;
  }
}
/** The written coordinate as JavaScript prints it, as decimal.js reads a number. */
function fixed(number) {
  const [mantissa, exponent = "0"] = String(number).toLowerCase().split("e");
  const negative = mantissa.startsWith("-");
  const [whole, fraction = ""] = mantissa.replace("-", "").split(".");
  const digits = BigInt(whole + fraction);
  const shift = Number(exponent) - fraction.length + DIGITS;
  const value =
    shift >= 0
      ? digits * 10n ** BigInt(shift)
      : roundedQuotient(digits, 10n ** BigInt(-shift));
  return negative ? -value : value;
}
function arctangentOfInverse(x) {
  // atan(1/x) = Σ (-1)^k / ((2k + 1) x^(2k + 1))
  const square = BigInt(x) * BigInt(x);
  let power = ONE / BigInt(x);
  let sum = power;
  for (let k = 1; power !== 0n; k += 1) {
    power /= square;
    const term = power / BigInt(2 * k + 1);
    sum += k % 2 === 1 ? -term : term;
  }
  return sum;
}
const PI = 16n * arctangentOfInverse(5) - 4n * arctangentOfInverse(239); // Machin
const DEGREE = PI / 180n;
function sineAndCosine(x) {
  // Taylor series; |x| <= π here, so every term below 1e-80 is reached.
  const square = times(x, x);
  let sine = x;
  let cosine = ONE;
  let sineTerm = x;
  let cosineTerm = ONE;
  for (let k = 1; sineTerm !== 0n || cosineTerm !== 0n; k += 1) {
    cosineTerm = -times(cosineTerm, square) / BigInt((2 * k - 1) * (2 * k));
    sineTerm = -times(sineTerm, square) / BigInt(2 * k * (2 * k + 1));
    cosine += cosineTerm;
    sine += sineTerm;
  }
  return [sine, cosine];
}
function exactVector(point) {
  const [sinLat, cosLat] = sineAndCosine(times(fixed(point.latitude), DEGREE));
  const [sinLon, cosLon] = sineAndCosine(times(fixed(point.longitude), DEGREE));
  return [times(cosLat, cosLon), times(cosLat, sinLon), sinLat];
}
const exactDot = (a, b) =>
  times(a[0], b[0]) + times(a[1], b[1]) + times(a[2], b[2]);
const exactCross = (a, b) => [
  times(a[1], b[2]) - times(a[2], b[1]),
  times(a[2], b[0]) - times(a[0], b[2]),
  times(a[0], b[1]) - times(a[1], b[0]),
];
const exactMinus = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const exactLength = (a) => squareRoot(exactDot(a, a));
const chord = (a, b) => exactLength(exactMinus(a, b));
const smallest = (...values) => values.reduce((m, v) => (v < m ? v : m));
const EXACT_TOLERANCE = times(fixed(1e-9), DEGREE);
const GRAY = 2n * EXACT_TOLERANCE;
const NORTH = [0n, 0n, ONE];

/** Chord-scale distance from p to the minor arc a → b. */
function exactDistance(p, a, b) {
  const normal = exactCross(a, b);
  const length = exactLength(normal);
  if (length === 0n) return chord(p, a);
  const n = normal.map((x) => over(x, length));
  const h = exactDot(n, p);
  const q = exactMinus(
    p,
    n.map((x) => times(x, h))
  );
  if (
    exactDot(exactCross(a, q), n) >= 0n &&
    exactDot(exactCross(q, b), n) >= 0n
  ) {
    return absolute(h);
  }
  return smallest(chord(p, a), chord(p, b));
}
const gnomonic = (v) => [over(v[0], v[2]), over(v[1], v[2])];
const orientation = (a, b, c) => {
  const value =
    times(b[0] - a[0], c[1] - a[1]) - times(b[1] - a[1], c[0] - a[0]);
  if (value === 0n) return 0;
  return value > 0n ? 1 : -1;
};
function properCross(a, b, c, d) {
  return (
    orientation(a, b, c) * orientation(a, b, d) < 0 &&
    orientation(c, d, a) * orientation(c, d, b) < 0
  );
}
function planarInside(point, polygon) {
  let inside = false;
  for (const [index, a] of polygon.entries()) {
    const b = polygon[(index + 1) % polygon.length];
    if (a[1] > point[1] !== b[1] > point[1]) {
      const x = over(times(b[0] - a[0], point[1] - a[1]), b[1] - a[1]) + a[0];
      if (point[0] < x) inside = !inside;
    }
  }
  return inside;
}
function twiceArea(polygon) {
  let sum = 0n;
  for (const [index, a] of polygon.entries()) {
    const b = polygon[(index + 1) % polygon.length];
    sum += times(a[0], b[1]) - times(a[1], b[0]);
  }
  return sum;
}
function exactRing(points) {
  const vectors = [];
  for (const p of points) {
    const v = exactVector(p);
    const last = vectors.at(-1);
    const step = last ? chord(last, v) : undefined;
    if (step !== undefined && step <= GRAY) {
      if (step > 0n) return { gray: "short" };
      continue;
    }
    vectors.push(v);
  }
  if (vectors.length > 1) {
    const closing = chord(vectors.at(-1), vectors[0]);
    if (closing <= GRAY) {
      if (closing > 0n) return { gray: "short" };
      vectors.pop();
    }
  }
  if (vectors.length < 3) return { zero: true };
  if (vectors.some((v) => v[2] <= 0n))
    throw new Error("judgeNearPole takes northern rings only");
  return { vectors, plane: vectors.map(gnomonic) };
}
const nearest = (p, q, a, b) =>
  smallest(
    exactDistance(p, a, b),
    exactDistance(q, a, b),
    exactDistance(a, p, q),
    exactDistance(b, p, q)
  );

/**
 * Judges a polygon in the open northern hemisphere. Returns `{ gray }` when a
 * feature lies within twice VibORM's tolerance (the verdict is then VibORM's
 * call, not a fact), else `{ issues, counterclockwise }`: the set of reasons
 * ("self", "pole", "outside", "overlap", "zero") and each ring's winding seen
 * from above the north pole.
 */
export function judgeNearPole(polygon) {
  const all = rings(polygon).map(exactRing);
  const gray = all.find((ring) => ring.gray);
  if (gray) return { gray: gray.gray };
  if (all.some((ring) => ring.zero)) return { issues: new Set(["zero"]) };
  const issues = new Set();
  const arcs = all.map((ring) =>
    ring.vectors.map((v, index) => {
      const next = (index + 1) % ring.vectors.length;
      return [v, ring.vectors[next], ring.plane[index], ring.plane[next]];
    })
  );
  for (const [index, ring] of arcs.entries()) {
    const n = ring.length;
    for (let i = 0; i < n; i += 1) {
      const [a, b, ap, bp] = ring[i];
      const [, c] = ring[(i + 1) % n];
      if (exactDistance(c, a, b) <= GRAY || exactDistance(a, b, c) <= GRAY) {
        return { gray: "adjacent" };
      }
      for (let j = i + 2; j < n; j += 1) {
        if (i === 0 && j === n - 1) continue;
        const [p, q, pp, qp] = ring[j];
        if (properCross(ap, bp, pp, qp)) {
          issues.add("self");
          continue;
        }
        const m = nearest(p, q, a, b);
        if (m === 0n) issues.add("self");
        else if (m <= GRAY) return { gray: "near-self" };
      }
    }
    const poleClearance = smallest(
      ...ring.map(([a, b]) => exactDistance(NORTH, a, b))
    );
    if (poleClearance > GRAY) {
      if (planarInside([0n, 0n], all[index].plane)) issues.add("pole");
    } else if (poleClearance > fixed(1e-40)) {
      return { gray: "near-pole" };
    }
  }
  for (let r1 = 0; r1 < arcs.length; r1 += 1) {
    for (let r2 = r1 + 1; r2 < arcs.length; r2 += 1) {
      let met = false;
      for (const [a, b, ap, bp] of arcs[r1]) {
        for (const [p, q, pp, qp] of arcs[r2]) {
          if (properCross(ap, bp, pp, qp)) {
            met = true;
            continue;
          }
          const m = nearest(p, q, a, b);
          if (m === 0n) met = true;
          else if (m <= GRAY) return { gray: "near-ring" };
        }
      }
      if (met) issues.add(r1 === 0 ? "outside" : "overlap");
      else if (r1 === 0 && !planarInside(all[r2].plane[0], all[0].plane)) {
        issues.add("outside");
      } else if (
        r1 > 0 &&
        (planarInside(all[r2].plane[0], all[r1].plane) ||
          planarInside(all[r1].plane[0], all[r2].plane))
      ) {
        issues.add("overlap");
      }
    }
  }
  return {
    issues,
    counterclockwise: all.map((ring) => twiceArea(ring.plane) > 0n),
  };
}

/** Self-check of the fixed-point arithmetic against float64. */
export function checkFixedPoint() {
  const pi = Number(PI) / Number(ONE);
  const [s, c] = sineAndCosine(times(fixed(30), DEGREE));
  return (
    Math.abs(pi - Math.PI) < 1e-15 &&
    Math.abs(Number(s) / Number(ONE) - 0.5) < 1e-15 &&
    Math.abs(Number(c) / Number(ONE) - Math.sqrt(3) / 2) < 1e-15 &&
    squareRoot(4n * ONE) === 2n * ONE
  );
}
