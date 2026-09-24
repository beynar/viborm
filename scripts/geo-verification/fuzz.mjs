/**
 * Differential fuzz of VibORM's GeoPolygon admission (validateGeoPolygon)
 * against the independent judges in ./oracle.mjs and against the databases.
 * Every generator and seed is the one behind a documented figure; see
 * README.md for which suite backs which sentence.
 *
 *   node scripts/geo-verification/fuzz.mjs <suite> [--seeds=a,b|a-b] [--n=N] [--kinds=a,b]
 *
 * Suites without a database: verdicts, pole, corpus [--write].
 * Suites with PGlite + PostGIS (and MySQL 8 when MYSQL_TEST_CONNECTION_STRING
 * is set): databases, bands (needs MySQL), overpole.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  answer,
  closeDatabases,
  flags,
  loadCodec,
  minimalStandard,
  mysqlConfigured,
  openDatabases,
  repoRoot,
  seedList,
  table,
  xorshift32,
  xorshift32Arithmetic,
} from "./harness.mjs";
import {
  antipodalReference,
  checkFixedPoint,
  edgeClearance,
  insideFromPole,
  judgeGeometry,
  judgeNearPole,
  parityInside,
  rings,
  vec,
} from "./oracle.mjs";

const RADIANS = Math.PI / 180;
const NORTH_POLE = [0, 0, 1];
const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "corpus.json");

const RING_POLE = /ring cannot contain a pole/;
const CONTAINS_POLE = /cannot contain a pole/;
const ANTIPODAL = /antipodal/;
const ZERO_AREA = /non-zero area/;
const SELF = /self-intersect/;
const OUTSIDE = /strictly inside/;
const OVERLAP = /touch or overlap/;

/** The judges' name for a VibORM refusal message. */
function category(message) {
  if (RING_POLE.test(message)) return "pole";
  if (CONTAINS_POLE.test(message)) return "pole-enclosed";
  if (ANTIPODAL.test(message)) return "antipodal";
  if (ZERO_AREA.test(message)) return "zero-area";
  if (SELF.test(message)) return "self";
  if (OUTSIDE.test(message)) return "outside";
  if (OVERLAP.test(message)) return "overlap";
  return `unknown: ${message}`;
}

const g = (longitude, latitude) => ({ longitude, latitude });
const increment = (counts, key) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

/** Does the outer ring have vertices on both sides of all three coordinate planes? */
function acrossThreePlanes(polygon) {
  const vectors = polygon.outer.map(vec);
  return [0, 1, 2].every(
    (axis) =>
      vectors.some((v) => v[axis] > 0) && vectors.some((v) => v[axis] < 0)
  );
}

// ---------------------------------------------------------------------------
// verdicts: review round 7's oracle fuzz (geo-repair7 fuzz.mjs / gen.mjs)
// ---------------------------------------------------------------------------

/** Destination from (lon, lat) at azimuth `az` and distance `d`, in degrees. */
function destination(lon, lat, az, d) {
  const p1 = lat * RADIANS;
  const l1 = lon * RADIANS;
  const t = az * RADIANS;
  const dd = d * RADIANS;
  const p2 = Math.asin(
    Math.sin(p1) * Math.cos(dd) + Math.cos(p1) * Math.sin(dd) * Math.cos(t)
  );
  const l2 =
    l1 +
    Math.atan2(
      Math.sin(t) * Math.sin(dd) * Math.cos(p1),
      Math.cos(dd) - Math.sin(p1) * Math.sin(p2)
    );
  return g(
    ((l2 / RADIANS + 540) % 360) - 180,
    Math.max(-90, Math.min(90, p2 / RADIANS))
  );
}

function roundStar(r, lon, lat, radius, n, shuffle) {
  const angles = [];
  for (let i = 0; i < n; i += 1) angles.push(r() * 360);
  angles.sort((a, b) => a - b);
  if (shuffle) {
    for (let i = n - 1; i > 0; i -= 1) {
      const j = Math.floor(r() * (i + 1));
      [angles[i], angles[j]] = [angles[j], angles[i]];
    }
  }
  return angles.map((a) =>
    destination(lon, lat, a, radius * (0.3 + 0.7 * r()))
  );
}

function doubleSpiral(lon, lat, radius, turns, per, gap) {
  const inward = [];
  const outward = [];
  const count = Math.floor(turns * per);
  for (let i = 0; i <= count; i += 1) {
    const theta = (i / per) * 360;
    const distance = radius * (1 - (i / count) * 0.9);
    inward.push(destination(lon, lat, theta, distance));
    outward.push(destination(lon, lat, theta, distance * (1 - gap)));
  }
  return [...inward, ...outward.reverse()];
}

function jaggedBand(r, n) {
  const west = -180 + r() * 360;
  const span = 30 + r() * 329;
  const south = -80 + r() * 100;
  const height = 1 + r() * 40;
  const top = [];
  const bottom = [];
  for (let i = 0; i <= n; i += 1) {
    const longitude = ((west + (span * i) / n + 540) % 360) - 180;
    bottom.push(g(longitude, Math.max(-89, south + r() * height * 0.3)));
    top.push(g(longitude, Math.min(89, south + height + r() * height * 0.3)));
  }
  return [...bottom, ...top.reverse()];
}

const VERDICT_KINDS = ["star", "holes", "spiral", "band", "long"];

function verdictPolygon(kind, r) {
  const lon = -180 + r() * 360;
  const lat =
    r() < 0.15 ? (r() < 0.5 ? -1 : 1) * (85 + r() * 4.99) : -80 + r() * 160;
  if (kind === "star") {
    const radius = 10 ** (-6 + r() * 8.2);
    const n = 3 + Math.floor(r() * 30);
    return {
      outer: roundStar(r, lon, lat, Math.min(radius, 170), n, r() < 0.25),
    };
  }
  if (kind === "holes") {
    const radius = Math.min(10 ** (-4 + r() * 6), 120);
    const outer = roundStar(
      r,
      lon,
      lat,
      radius,
      5 + Math.floor(r() * 25),
      false
    );
    const holes = [];
    const count = 1 + Math.floor(r() * 12);
    for (let i = 0; i < count; i += 1) {
      const c = destination(lon, lat, r() * 360, radius * r());
      holes.push(
        roundStar(
          r,
          c.longitude,
          c.latitude,
          radius * 10 ** (-2 + r() * 1.7),
          3 + Math.floor(r() * 8),
          r() < 0.1
        )
      );
    }
    return { outer, holes };
  }
  if (kind === "spiral") {
    const radius = 10 ** (-3 + r() * 4.2);
    const s = doubleSpiral(
      lon,
      lat,
      Math.min(radius, 60),
      1 + r() * 4,
      6 + Math.floor(r() * 20),
      0.02 + r() * 0.2
    );
    if (r() < 0.5) {
      const i = Math.floor(r() * s.length);
      const j = Math.floor(r() * s.length);
      s[i] = { ...s[j], latitude: s[j].latitude * (1 - 1e-3 * r()) };
    }
    return { outer: s };
  }
  if (kind === "band") {
    const outer = jaggedBand(r, 2 + Math.floor(r() * 6));
    const holes = [];
    if (r() < 0.5) {
      // The bound is drawn again before every iteration, as in the original.
      for (let i = 0; i < 1 + Math.floor(r() * 4); i += 1) {
        const o = outer[Math.floor(r() * outer.length)];
        holes.push(
          roundStar(
            r,
            o.longitude,
            o.latitude,
            r() * 20,
            3 + Math.floor(r() * 6),
            false
          )
        );
      }
    }
    return holes.length ? { outer, holes } : { outer };
  }
  // long: an edge of 150 to 179.995 degrees
  const length = 150 + r() * 29.995;
  destination(lon, lat, r() * 360, 0);
  const b = destination(lon, lat, r() * 360, length);
  const c = destination(lon, lat, r() * 360, r() * 170);
  return { outer: [g(lon, lat), b, c] };
}

/** The review's slack: 1e-4 of the ring's planar size, clamped to [1e-13, 1e-7] radians. */
function verdictSlack(polygon) {
  let size = 0;
  for (const a of polygon.outer) {
    for (const b of polygon.outer) {
      size = Math.max(
        size,
        Math.hypot(a.longitude - b.longitude, a.latitude - b.latitude)
      );
    }
  }
  return Math.min(
    1e-7,
    Math.max(1e-13, 1e-4 * ((Math.min(size, 1) * Math.PI) / 180))
  );
}

/** The judge's verdict when lenient and strict slack agree, else undefined. */
function judgeUnambiguous(polygon) {
  const slack = verdictSlack(polygon);
  const strict = judgeGeometry(polygon, -slack);
  if (strict === "domain" || judgeGeometry(polygon, slack) !== strict)
    return undefined;
  return strict;
}

function runVerdicts(codec, options) {
  const seeds = seedList(options.seeds ?? "1");
  const n = Number(options.n ?? 5000);
  const kinds = options.kinds
    ? String(options.kinds).split(",")
    : VERDICT_KINDS;
  const rows = [];
  const bad = [];
  const otherReasons = {};
  for (const seed of seeds) {
    for (const kind of kinds) {
      // One stream per kind and seed, as `fuzz.mjs <kind> <N> <seed>` ran.
      const r = xorshift32Arithmetic(seed);
      const row = {
        seed,
        kind,
        polygons: 0,
        ambiguous: 0,
        admitted: 0,
        refused: 0,
        falseAdmit: 0,
        falseRefuse: 0,
        otherReason: 0,
        slowestMs: 0,
      };
      for (let i = 0; i < n; i += 1) {
        const polygon = verdictPolygon(kind, r);
        row.polygons += 1;
        const expected = judgeUnambiguous(polygon);
        if (expected === undefined) {
          row.ambiguous += 1;
          continue;
        }
        const started = performance.now();
        const result = codec.validateGeoPolygon(structuredClone(polygon));
        row.slowestMs = Math.max(
          row.slowestMs,
          Math.round(performance.now() - started)
        );
        const got = result.issues ? category(result.issues[0].message) : "ok";
        row[got === "ok" ? "admitted" : "refused"] += 1;
        if ((got === "ok") === (expected === "ok")) {
          if (got !== expected) {
            row.otherReason += 1;
            increment(
              otherReasons,
              `${kind}: oracle ${expected}, VibORM ${got}`
            );
          }
        } else {
          row[got === "ok" ? "falseAdmit" : "falseRefuse"] += 1;
          bad.push({ seed, kind, expected, got, polygon });
        }
      }
      rows.push(row);
    }
  }
  process.stdout.write(
    `refused for another reason than the oracle's first: ${JSON.stringify(otherReasons)}\n`
  );
  return { rows, bad, failed: bad.length };
}

// ---------------------------------------------------------------------------
// pole: near-pole and over-the-pole rings (geo-pole probe.mjs)
// ---------------------------------------------------------------------------

const POLE_KINDS = [
  "star",
  "shuffled",
  "holes",
  "holesIn",
  "poleEdge",
  "poleEdgeBig",
  "poleEdgeShuffled",
  "poleEdgeHoles",
  "poleEdgeHolesBig",
];
const POLE_MESSAGES = {
  "A GeoPolygon ring cannot self-intersect": "self",
  "A GeoPolygon cannot contain a pole": "pole",
  "A GeoPolygon hole must be strictly inside its outer ring": "outside",
  "GeoPolygon holes cannot touch or overlap": "overlap",
  "A GeoPolygon ring must have non-zero area": "zero",
};

/** Generators in the gnomonic plane from the north pole (x, y = tan of colatitude). */
function poleGenerators(rnd) {
  const wrap = (x) => {
    const l = ((x + 540) % 360) - 180;
    return l === -180 ? 180 : l;
  };
  const toPoint = ([x, y]) =>
    g(
      wrap(Math.atan2(y, x) / RADIANS),
      90 - Math.atan(Math.hypot(x, y)) / RADIANS
    );
  const shuffled = (points) =>
    points
      .map((p) => [rnd(), p])
      .sort((a, b) => a[0] - b[0])
      .map((x) => x[1]);
  function star(cx, cy, radius, k, shuffle) {
    const angles = Array.from({ length: k }, () => rnd() * 2 * Math.PI).sort(
      (a, b) => a - b
    );
    let points = angles.map((t) => {
      const r = radius * (0.3 + 0.7 * rnd());
      return [cx + r * Math.cos(t), cy + r * Math.sin(t)];
    });
    if (rnd() < 0.5) points.reverse();
    if (shuffle) points = shuffled(points);
    return points;
  }
  let lastSide;
  function poleEdgeRing(extent, k, shuffle) {
    const lon0 = Math.floor(rnd() * 360 * 64) / 64 - 180;
    const u = [Math.cos(lon0 * RADIANS), Math.sin(lon0 * RADIANS)];
    const v = [-u[1], u[0]];
    const a = extent * (0.2 + rnd());
    const b = extent * (0.2 + rnd());
    const side = rnd() < 0.5 ? 1 : -1;
    lastSide = [side * v[0], side * v[1], u];
    const mids = Array.from({ length: k }, () => rnd() * Math.PI)
      .sort((x, y) => x - y)
      .map((t) => {
        const r = extent * (0.2 + rnd());
        return [
          r * (Math.cos(t) * u[0] + side * Math.sin(t) * v[0]),
          r * (Math.cos(t) * u[1] + side * Math.sin(t) * v[1]),
        ];
      });
    let ring = [
      g(lon0, 90 - Math.atan(a) / RADIANS),
      ...mids.map(toPoint),
      g(wrap(lon0 + 180), 90 - Math.atan(b) / RADIANS),
    ];
    if (Math.abs(ring.at(-1).longitude - ring[0].longitude) !== 180)
      return undefined;
    if (shuffle) ring = shuffled(ring);
    const rotation = Math.floor(rnd() * ring.length);
    ring = [...ring.slice(rotation), ...ring.slice(0, rotation)];
    if (rnd() < 0.5) ring.reverse();
    return ring;
  }
  return function generate(kind) {
    const extent = Math.tan(10 ** (-8 + 4 * rnd()) * RADIANS); // 1e-8 .. 1e-4 degrees
    const big = Math.tan((5 + 75 * rnd()) * RADIANS);
    if (kind === "star" || kind === "shuffled") {
      const d = extent * 3 * rnd();
      const t = rnd() * 2 * Math.PI;
      return {
        outer: star(
          d * Math.cos(t),
          d * Math.sin(t),
          extent,
          3 + Math.floor(rnd() * 8),
          kind === "shuffled"
        ).map(toPoint),
      };
    }
    if (kind === "holes" || kind === "holesIn") {
      const inner = kind === "holesIn";
      const d = extent * 3 * rnd();
      const t = rnd() * 2 * Math.PI;
      const cx = d * Math.cos(t);
      const cy = d * Math.sin(t);
      const holes = Array.from(
        { length: 1 + Math.floor(rnd() * (inner ? 4 : 3)) },
        () => {
          const hd = extent * (inner ? 0.6 : 1) * rnd();
          const ht = rnd() * 2 * Math.PI;
          return star(
            cx + hd * Math.cos(ht),
            cy + hd * Math.sin(ht),
            extent * (inner ? 0.15 : 0.3) * rnd(),
            3 + Math.floor(rnd() * 4),
            false
          ).map(toPoint);
        }
      );
      return {
        outer: star(
          cx,
          cy,
          extent,
          (inner ? 12 : 5) + Math.floor(rnd() * 8),
          false
        ).map(toPoint),
        holes,
      };
    }
    if (kind === "poleEdgeHoles" || kind === "poleEdgeHolesBig") {
      const sc =
        kind === "poleEdgeHolesBig"
          ? Math.tan((5 + 75 * rnd()) * RADIANS)
          : extent;
      const outer = poleEdgeRing(sc, 3 + Math.floor(rnd() * 6), false);
      if (!outer) return undefined;
      const [vx, vy, u] = lastSide;
      const holes = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => {
        const ht = rnd() * Math.PI;
        const hd = sc * (rnd() < 0.5 ? 0.02 + 0.2 * rnd() : 0.5 * rnd());
        const cx = hd * (Math.cos(ht) * u[0] + Math.sin(ht) * vx);
        const cy = hd * (Math.cos(ht) * u[1] + Math.sin(ht) * vy);
        return star(
          cx,
          cy,
          hd * 0.5 * rnd(),
          3 + Math.floor(rnd() * 3),
          false
        ).map(toPoint);
      });
      return { outer, holes };
    }
    // poleEdge, poleEdgeBig, poleEdgeShuffled
    const sc = kind === "poleEdgeBig" ? big : extent;
    const outer = poleEdgeRing(
      sc,
      1 + Math.floor(rnd() * 5),
      kind === "poleEdgeShuffled"
    );
    if (!outer) return undefined;
    if (rnd() < 0.5) return { outer };
    const holes = Array.from({ length: 1 + Math.floor(rnd() * 2) }, () => {
      const hd = sc * rnd();
      const ht = rnd() * 2 * Math.PI;
      return star(
        hd * Math.cos(ht),
        hd * Math.sin(ht),
        sc * 0.2 * rnd(),
        3 + Math.floor(rnd() * 3),
        false
      ).map(toPoint);
    });
    return { outer, holes };
  };
}

const mirrored = (polygon) => ({
  outer: polygon.outer.map((p) => g(p.longitude, -p.latitude)),
  ...(polygon.holes
    ? {
        holes: polygon.holes.map((h) =>
          h.map((p) => g(p.longitude, -p.latitude))
        ),
      }
    : {}),
});

/**
 * One drawn near-pole polygon judged: undefined when skipped (a vertex within
 * 3e-9 degrees of the pole, or the generator gave up), `{ gray }` when a
 * feature is within twice VibORM's tolerance, else the polygon as sent (north,
 * or mirrored south by a coin flip), the judge's verdict, and VibORM's.
 */
function drawPole(codec, generate, rnd, kind) {
  const north = generate(kind);
  if (!north) return undefined;
  const colatitudes = rings(north)
    .flat()
    .map((p) => 90 - p.latitude);
  if (Math.min(...colatitudes) < 3e-9) return undefined;
  const judged = judgeNearPole(north);
  if (judged.gray) return { gray: judged.gray };
  const south = rnd() < 0.5;
  const polygon = south ? mirrored(north) : north;
  const result = codec.validateGeoPolygon(structuredClone(polygon));
  const reasons = [...judged.issues].sort().join("+") || "ok";
  let wrong;
  if (Boolean(result.issues) !== judged.issues.size > 0) wrong = "verdict";
  else if (result.issues) {
    const named = POLE_MESSAGES[result.issues[0].message];
    const excused = judged.issues.has("self") && named === "pole";
    if (!(judged.issues.has(named) || excused)) wrong = "message";
  } else {
    const sent = rings(polygon);
    const out = rings(result.value);
    for (const [index, ring] of sent.entries()) {
      const counterclockwise = judged.counterclockwise[index] !== south;
      const keep = index === 0 ? counterclockwise : !counterclockwise;
      const want = keep ? ring : [...ring].reverse();
      if (JSON.stringify(want) !== JSON.stringify(out[index]))
        wrong = "winding";
    }
  }
  return { polygon, reasons, result, wrong, colatitudes };
}

function runPole(codec, options) {
  if (!checkFixedPoint())
    throw new Error(
      "the oracle's fixed-point arithmetic failed its self-check"
    );
  const seeds = seedList(options.seeds ?? "301-306");
  const n = Number(options.n ?? 150);
  const kinds = options.kinds ? String(options.kinds).split(",") : POLE_KINDS;
  const rows = [];
  const bad = [];
  for (const seed of seeds) {
    const rnd = minimalStandard(seed);
    const generate = poleGenerators(rnd);
    for (const kind of kinds) {
      const row = {
        seed,
        kind,
        admitted: 0,
        refused: 0,
        gray: 0,
        skipped: 0,
        wrong: 0,
        nearestColatitude: Number.POSITIVE_INFINITY,
        farthestColatitude: 0,
      };
      for (let t = 0; t < n; t += 1) {
        const drawn = drawPole(codec, generate, rnd, kind);
        if (!drawn) row.skipped += 1;
        else if (drawn.gray) row.gray += 1;
        else {
          row[drawn.result.issues ? "refused" : "admitted"] += 1;
          row.nearestColatitude = Math.min(
            row.nearestColatitude,
            ...drawn.colatitudes
          );
          row.farthestColatitude = Math.max(
            row.farthestColatitude,
            ...drawn.colatitudes
          );
          if (drawn.wrong) {
            row.wrong += 1;
            bad.push({
              seed,
              kind,
              wrong: drawn.wrong,
              oracle: drawn.reasons,
              viborm: drawn.result.issues?.[0]?.message ?? "admitted",
              polygon: drawn.polygon,
            });
          }
        }
      }
      row.nearestColatitude = row.nearestColatitude.toExponential(2);
      row.farthestColatitude = row.farthestColatitude.toPrecision(3);
      rows.push(row);
    }
  }
  return { rows, bad, failed: bad.length };
}

// ---------------------------------------------------------------------------
// databases: review round 3's differential fuzz (geo-review3 fuzz.mjs)
// ---------------------------------------------------------------------------

function review3Generators(rnd) {
  const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
  function dest(c, bearing, distance) {
    const p1 = c.latitude * RADIANS;
    const l1 = c.longitude * RADIANS;
    const t = bearing * RADIANS;
    const d = distance * RADIANS;
    const p2 = Math.asin(
      Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t)
    );
    const l2 =
      l1 +
      Math.atan2(
        Math.sin(t) * Math.sin(d) * Math.cos(p1),
        Math.cos(d) - Math.sin(p1) * Math.sin(p2)
      );
    let lon = ((l2 / RADIANS + 540) % 360) - 180;
    if (lon === -180 && rnd() < 0.5) lon = 180;
    return g(lon, p2 / RADIANS);
  }
  function ring(center, n, radius, sorted, decimals) {
    let bearings = Array.from({ length: n }, () => rnd() * 360);
    if (sorted) bearings.sort((a, b) => a - b);
    if (rnd() < 0.5) bearings = bearings.reverse();
    return bearings.map((b) => {
      const p = dest(center, b, radius * (0.35 + 0.65 * rnd()));
      return g(
        Math.max(-180, Math.min(180, round(p.longitude, decimals))),
        Math.max(-90, Math.min(90, round(p.latitude, decimals)))
      );
    });
  }
  function polygon() {
    const high = rnd() < 0.3;
    const antimeridian = rnd() < 0.25;
    const lat = high
      ? (rnd() < 0.5 ? -1 : 1) * (75 + rnd() * 14.99)
      : Math.asin(2 * rnd() - 1) / RADIANS;
    const lon = antimeridian
      ? (rnd() < 0.5 ? -1 : 1) * (178 + rnd() * 2)
      : rnd() * 360 - 180;
    const center = g(lon, lat);
    const u = rnd();
    const radius = u < 0.05 ? 60 + rnd() * 50 : 10 ** (-3 + rnd() * 4.6);
    const decimals = rnd() < 0.2 ? 9 : 6;
    const outer = ring(
      center,
      5 + Math.floor(rnd() * 8),
      radius,
      rnd() < 0.75,
      decimals
    );
    const holeCount = rnd() < 0.5 ? 0 : 1 + Math.floor(rnd() * 3);
    const holes = [];
    for (let k = 0; k < holeCount; k += 1) {
      const hc = dest(center, rnd() * 360, radius * 0.5 * rnd());
      holes.push(
        ring(
          hc,
          3 + Math.floor(rnd() * 4),
          radius * (0.05 + 0.3 * rnd()),
          rnd() < 0.9,
          decimals
        )
      );
    }
    return {
      center,
      radius,
      polygon: holeCount ? { outer, holes } : { outer },
    };
  }
  function samples(center, radius, poly) {
    const points = [];
    for (let i = 0; i < 70; i += 1)
      points.push(dest(center, rnd() * 360, radius * 1.3 * Math.sqrt(rnd())));
    for (const hole of poly.holes ?? []) {
      for (let i = 0; i < 12; i += 1) {
        const vertex = hole[Math.floor(rnd() * hole.length)];
        points.push(dest(vertex, rnd() * 360, radius * 0.15 * rnd()));
      }
    }
    for (let i = 0; i < 15; i += 1)
      points.push(g(rnd() * 360 - 180, Math.asin(2 * rnd() - 1) / RADIANS));
    points.push(g(0, 89.9999), g(0, -89.9999));
    return points.map((p) => g(round(p.longitude, 9), round(p.latitude, 9)));
  }
  return { polygon, samples };
}

async function runDatabases(codec, options) {
  const seeds = seedList(options.seeds ?? "1111,2222,3333,4444");
  const n = Number(options.n ?? 1500);
  const db = await openDatabases();
  const rows = [];
  const bad = [];
  for (const seed of seeds) {
    const generate = review3Generators(xorshift32(seed));
    const row = {
      seed,
      polygons: n,
      admitted: 0,
      admittedAgree: 0,
      admittedDisagree: 0,
      disagreeAcrossPlanes: 0,
      refused: 0,
      refusedDbDisagree: 0,
      pgRaised: 0,
    };
    const reasons = {};
    for (let i = 0; i < n; i += 1) {
      const { center, radius, polygon } = generate.polygon();
      const result = codec.validateGeoPolygon(structuredClone(polygon));
      const points = generate.samples(center, radius, polygon);
      const answers = await answer(
        db,
        codec.geoPolygonJson(result.issues ? polygon : result.value),
        points,
        { index: false }
      );
      const reference = antipodalReference(polygon);
      let disagreements = 0;
      const raised =
        typeof answers.pg === "string" || typeof answers.my === "string";
      if (raised) row.pgRaised += 1;
      else {
        for (const [k, p] of points.entries()) {
          const clearance = edgeClearance(p, polygon);
          if (clearance.degrees < 1e-6 || clearance.relative < 0.01) continue;
          const sphere = parityInside(p, polygon, reference);
          const pg = answers.pg.has(k);
          const my = answers.my ? answers.my.has(k) : pg;
          if (pg !== sphere || my !== sphere) disagreements += 1;
        }
      }
      if (result.issues) {
        row.refused += 1;
        increment(reasons, result.issues[0].message);
        if (raised || disagreements) row.refusedDbDisagree += 1;
      } else {
        row.admitted += 1;
        if (raised || disagreements) {
          row.admittedDisagree += 1;
          if (acrossThreePlanes(polygon)) row.disagreeAcrossPlanes += 1;
          else bad.push({ seed, index: i, disagreements, polygon });
        } else row.admittedAgree += 1;
      }
    }
    rows.push(row);
    process.stdout.write(`seed ${seed} refusals: ${JSON.stringify(reasons)}\n`);
  }
  await closeDatabases(db);
  return { rows, bad };
}

// ---------------------------------------------------------------------------
// bands: review round 3's large polygons (geo-review3 fuzz2.mjs)
// ---------------------------------------------------------------------------

function bandGenerators(rnd) {
  const round = (x) => Math.round(x * 1e6) / 1e6;
  const wrapLon = (l) => round(((l + 540) % 360) - 180);
  function band() {
    const west = rnd() * 360 - 180;
    const span = 120 + rnd() * 239;
    const k = Math.max(1, Math.ceil(span / 179.5)) + Math.floor(rnd() * 3);
    const step = span / k;
    if (step >= 180) return undefined;
    const midLat = (rnd() - 0.5) * 120;
    const half = 2 + rnd() * 40;
    const bottom = [];
    const top = [];
    for (let i = 0; i <= k; i += 1)
      bottom.push(
        g(
          wrapLon(west + i * step),
          round(Math.max(-89, midLat - half + (rnd() - 0.5) * 10))
        )
      );
    for (let i = k; i >= 0; i -= 1)
      top.push(
        g(
          wrapLon(west + i * step),
          round(Math.min(89, midLat + half + (rnd() - 0.5) * 10))
        )
      );
    return { outer: [...bottom, ...top] };
  }
  function nearAntipodal() {
    const a = g(round(rnd() * 360 - 180), round((rnd() - 0.5) * 170));
    const eps = 10 ** -(3 + rnd() * 5);
    const b = g(
      wrapLon(a.longitude + 180 - eps * (rnd() < 0.5 ? 1 : -1)),
      round(-a.latitude + (rnd() - 0.5) * 1e-5)
    );
    const c = g(
      wrapLon(a.longitude + 90 * (rnd() < 0.5 ? 1 : -1)),
      round((rnd() - 0.5) * 120)
    );
    return { outer: [a, b, c] };
  }
  return {
    polygon: () => (rnd() < 0.6 ? band() : nearAntipodal()),
    points: () =>
      Array.from({ length: 150 }, () =>
        g(round(rnd() * 360 - 180), round(Math.asin(2 * rnd() - 1) / RADIANS))
      ),
  };
}

async function runBands(codec, options) {
  if (!mysqlConfigured()) {
    process.stdout.write(
      "bands compares PostGIS with MySQL: skipped, MYSQL_TEST_CONNECTION_STRING is not set\n"
    );
    return { rows: [], bad: [] };
  }
  const seeds = seedList(options.seeds ?? "5151,6262");
  const n = Number(options.n ?? 400);
  const db = await openDatabases();
  const rows = [];
  const bad = [];
  for (const seed of seeds) {
    const rnd = xorshift32(seed);
    const generate = bandGenerators(rnd);
    const row = {
      seed,
      polygons: n,
      admitted: 0,
      agree: 0,
      disagree: 0,
      disagreeAcrossPlanes: 0,
      pgUnlikeSphere: 0,
      myUnlikeSphere: 0,
      refused: 0,
    };
    const reasons = {};
    for (let i = 0; i < n; i += 1) {
      const polygon = generate.polygon();
      if (!polygon) {
        i -= 1;
        continue;
      }
      const result = codec.validateGeoPolygon(structuredClone(polygon));
      if (result.issues) {
        row.refused += 1;
        increment(reasons, result.issues[0].message);
        continue;
      }
      row.admitted += 1;
      const points = generate.points();
      const answers = await answer(
        db,
        codec.geoPolygonJson(result.value),
        points,
        { index: false }
      );
      let disagreements = 0;
      let pgWrong = 0;
      let myWrong = 0;
      if (typeof answers.pg === "string" || typeof answers.my === "string")
        disagreements = -1;
      else {
        for (const [k, p] of points.entries()) {
          const clearance = edgeClearance(p, polygon);
          if (clearance.degrees < 1e-4 || clearance.relative < 0.01) continue;
          if (answers.pg.has(k) !== answers.my.has(k)) disagreements += 1;
          // VibORM's reading: the side of the ring away from both poles.
          const sphere = parityInside(p, polygon, NORTH_POLE);
          if (answers.pg.has(k) !== sphere) pgWrong += 1;
          if (answers.my.has(k) !== sphere) myWrong += 1;
        }
      }
      if (pgWrong) row.pgUnlikeSphere += 1;
      if (myWrong) row.myUnlikeSphere += 1;
      if (disagreements === 0) row.agree += 1;
      else {
        row.disagree += 1;
        if (acrossThreePlanes(polygon)) row.disagreeAcrossPlanes += 1;
        else bad.push({ seed, index: i, disagreements, polygon });
      }
    }
    rows.push(row);
    process.stdout.write(`seed ${seed} refusals: ${JSON.stringify(reasons)}\n`);
  }
  await closeDatabases(db);
  return { rows, bad };
}

// ---------------------------------------------------------------------------
// overpole: edges of 180 degrees of longitude (geo-pole dbpole.mjs)
// ---------------------------------------------------------------------------

const OVER_THE_POLE = {
  "(0,10)-(180,20) over the north pole": {
    outer: [g(0, 10), g(90, 15), g(180, 20)],
  },
  "closing edge (180,80)-(0,80)": { outer: [g(0, 80), g(90, 70), g(180, 80)] },
  "(0,10)-(180,10) with (90,5)": { outer: [g(90, 5), g(180, 10), g(0, 10)] },
  "over the south pole": { outer: [g(0, -10), g(180, -20), g(90, -15)] },
  "small, near the pole": { outer: [g(0, 89), g(90, 89.5), g(180, 89)] },
  "(-90,20)-(90,10) across the antimeridian side": {
    outer: [g(90, 10), g(180, 15), g(-90, 20)],
  },
  "with a hole by the pole": {
    outer: [g(0, 10), g(90, 15), g(180, 20)],
    holes: [[g(80, 85), g(90, 86), g(100, 85)]],
  },
  "(45,30)-(-135,40) over the pole": {
    outer: [g(45, 30), g(135, 35), g(-135, 40)],
  },
};

async function wrongOverPole(codec, db, polygon, points) {
  const result = codec.validateGeoPolygon(structuredClone(polygon));
  if (result.issues) return { refused: result.issues[0].message };
  const sign = Math.sign(polygon.outer[0].latitude);
  const answers = await answer(db, codec.geoPolygonJson(result.value), points);
  const row = { points: 0, pg: 0, pgIndex: 0, my: "-", myIndex: "-" };
  if (answers.my !== undefined) Object.assign(row, { my: 0, myIndex: 0 });
  const examples = [];
  for (const [k, p] of points.entries()) {
    if (edgeClearance(p, polygon).degrees < 0.01) continue;
    row.points += 1;
    const truth = insideFromPole(p, polygon, sign);
    for (const key of ["pg", "pgIndex", "my", "myIndex"]) {
      const set = answers[key];
      if (set === undefined) continue;
      if (typeof set === "string") throw new Error(`${key}: ${set}`);
      if (set.has(k) !== truth) {
        row[key] += 1;
        examples.push({ key, point: p, truth });
      }
    }
  }
  return { row, examples };
}

async function runOverPole(codec, options) {
  const seeds = seedList(options.seeds ?? "4242,777");
  const n = Number(options.n ?? 70);
  const db = await openDatabases();
  const named = [];
  const totals = {
    rings: 0,
    points: 0,
    pg: 0,
    pgIndex: 0,
    my: 0,
    myIndex: 0,
    ringsWrongPg: 0,
    ringsWrongMy: 0,
  };
  if (!db.my)
    Object.assign(totals, { my: "-", myIndex: "-", ringsWrongMy: "-" });
  const bad = [];
  const add = (row, examples, polygon) => {
    totals.rings += 1;
    totals.points += row.points;
    for (const key of ["pg", "pgIndex", "my", "myIndex"])
      if (typeof row[key] === "number") totals[key] += row[key];
    if (row.pg || row.pgIndex) totals.ringsWrongPg += 1;
    if (db.my && (row.my > 0 || row.myIndex > 0)) totals.ringsWrongMy += 1;
    if (examples.length) {
      const clearance = (point) =>
        Number(edgeClearance(point, polygon).degrees.toPrecision(3));
      bad.push({
        examples: examples
          .slice(0, 3)
          .map((x) => ({ ...x, clearanceDeg: clearance(x.point) })),
        polygon,
      });
    }
  };
  for (const [position, seed] of seeds.entries()) {
    const rnd = minimalStandard(seed);
    const round6 = (x) => Math.round(x * 1e6) / 1e6;
    const points = [];
    for (let i = 0; i < 500; i += 1)
      points.push(
        g(round6(rnd() * 360 - 180), round6(Math.asin(2 * rnd() - 1) / RADIANS))
      );
    for (let i = 0; i < 300; i += 1)
      points.push(
        g(
          round6(rnd() * 360 - 180),
          ((rnd() < 0.5 ? 1 : -1) * Math.round((80 + 9.99 * rnd()) * 1e6)) / 1e6
        )
      );
    if (position === 0) {
      for (const [name, polygon] of Object.entries(OVER_THE_POLE)) {
        const { refused, row, examples } = await wrongOverPole(
          codec,
          db,
          polygon,
          points
        );
        if (refused) named.push({ name, refused });
        else {
          named.push({ name, ...row });
          add(row, examples, polygon);
        }
      }
    }
    for (let t = 0; t < n; t += 1) {
      const lon0 = Math.floor(rnd() * 360 * 4) / 4 - 180;
      const a = 10 + 75 * rnd();
      const b = 10 + 75 * rnd();
      const side = rnd() < 0.5 ? 1 : -1;
      const sign = rnd() < 0.5 ? 1 : -1;
      const mids = Array.from(
        { length: 1 + Math.floor(rnd() * 3) },
        () => rnd() * 180
      )
        .sort((x, y) => x - y)
        .map((d) => g(((lon0 + side * d + 540) % 360) - 180, 5 + 80 * rnd()));
      const far = lon0 + 180 > 180 ? lon0 - 180 : lon0 + 180;
      const outer = [g(lon0, a), ...mids, g(far, b)].map((p) =>
        g(p.longitude, sign * p.latitude)
      );
      const { refused, row, examples } = await wrongOverPole(
        codec,
        db,
        { outer },
        points
      );
      if (!refused) add(row, examples, { outer });
    }
  }
  await closeDatabases(db);
  process.stdout.write(`${table(named)}\n\n`);
  return { rows: [totals], bad };
}

// ---------------------------------------------------------------------------
// corpus: a committed, deterministic set of verdicts
// ---------------------------------------------------------------------------

const SELF_INTERSECT = "A GeoPolygon ring cannot self-intersect";
const NON_ZERO = "A GeoPolygon ring must have non-zero area";
const RING_POLE_MESSAGE = "A GeoPolygon ring cannot contain a pole";
const AROUND_POLE = "A GeoPolygon cannot contain a pole";
const NEAR_ANTIPODE =
  "A GeoPolygon edge cannot join vertices within 0.01 degrees of antipodal";
const HOLE_OUTSIDE = "A GeoPolygon hole must be strictly inside its outer ring";
const HOLES_OVERLAP = "GeoPolygon holes cannot touch or overlap";
const box = [g(0, 40), g(10, 40), g(10, 50), g(0, 50)];
const square = (lon, lat, side) => [
  g(lon, lat),
  g(lon + side, lat),
  g(lon + side, lat + side),
  g(lon, lat + side),
];

/** The ledger's table and owner-rule rows, with the verdict the ledger states (undefined: admitted). */
const NAMED = [
  ["bowtie", { outer: [g(0, 0), g(2, 2), g(2, 0), g(0, 2)] }, SELF_INTERSECT],
  [
    "retracing ring",
    { outer: [g(0, 0), g(2, 0), g(1, 0), g(1, 1)] },
    SELF_INTERSECT,
  ],
  [
    "collinear ring on the equator",
    { outer: [g(0, 0), g(1, 0), g(2, 0)] },
    NON_ZERO,
  ],
  [
    "antipodal endpoints (0,0)-(180,0)",
    { outer: [g(0, 0), g(180, 0), g(90, 10)] },
    NEAR_ANTIPODE,
  ],
  [
    "(0,10)-(180,10) over the pole",
    { outer: [g(90, 5), g(180, 10), g(0, 10)] },
  ],
  [
    "(0,10)-(179.999999,-10), 1e-6 short of antipodal",
    { outer: [g(0, 10), g(179.999_999, -10), g(90, 30)] },
    NEAR_ANTIPODE,
  ],
  [
    "pole vertex at longitude 0",
    { outer: [g(0, 90), g(0, 80), g(90, 80)] },
    RING_POLE_MESSAGE,
  ],
  [
    "ring winding around a pole",
    { outer: [g(0, 80), g(90, 80), g(180, 80), g(-90, 80)] },
    AROUND_POLE,
  ],
  [
    "340-degree band",
    {
      outer: [
        g(-170, -10),
        g(-50, -10),
        g(50, -10),
        g(170, -10),
        g(170, 10),
        g(50, 10),
        g(-50, 10),
        g(-170, 10),
      ],
    },
  ],
  [
    "tropics band",
    {
      outer: [
        g(-170, -30),
        g(0, -30),
        g(170, -30),
        g(170, 30),
        g(0, 30),
        g(-170, 30),
      ],
    },
  ],
  [
    "band with two long edges on each side",
    {
      outer: [
        g(0, -30),
        g(175, -30),
        g(-10, -30),
        g(-10, 30),
        g(175, 30),
        g(0, 30),
      ],
    },
  ],
  [
    "the Pacific",
    {
      outer: [
        g(120, -50),
        g(150, -55),
        g(-170, -60),
        g(-130, -60),
        g(-90, -55),
        g(-75, -40),
        g(-80, -5),
        g(-105, 20),
        g(-125, 45),
        g(-150, 58),
        g(175, 55),
        g(145, 40),
        g(125, 20),
        g(115, 0),
        g(115, -25),
      ],
    },
  ],
  [
    "hole outside the outer ring",
    { outer: square(0, 0, 10), holes: [square(20, 20, 1)] },
    HOLE_OUTSIDE,
  ],
  [
    "overlapping holes",
    { outer: square(0, 0, 10), holes: [square(1, 1, 3), square(2, 2, 3)] },
    HOLES_OVERLAP,
  ],
  [
    "hole nested in a hole",
    { outer: square(0, 0, 10), holes: [square(1, 1, 5), square(2, 2, 1)] },
    HOLES_OVERLAP,
  ],
  [
    "hole touching the outer ring at a vertex",
    { outer: square(0, 0, 10), holes: [[g(0, 0), g(2, 1), g(1, 2)]] },
    HOLE_OUTSIDE,
  ],
  [
    "holes sharing a vertex",
    { outer: square(0, 0, 10), holes: [square(1, 1, 2), square(3, 3, 2)] },
    HOLES_OVERLAP,
  ],
  [
    "hole touching a straight parallel edge",
    { outer: box, holes: [[g(5, 40), g(6, 41), g(4, 41)]] },
    HOLE_OUTSIDE,
  ],
  [
    "hole B touching hole A's lat-44 edge",
    {
      outer: box,
      holes: [
        [g(2, 42), g(8, 42), g(8, 44), g(2, 44)],
        [g(5, 44), g(6, 46), g(4, 46)],
      ],
    },
    HOLES_OVERLAP,
  ],
  [
    "ring past a whole turn over itself",
    {
      outer: [
        g(0, 0),
        g(80, 0),
        g(160, 0),
        g(-120, 0),
        g(-40, 0),
        g(40, 0),
        g(40, 2),
        g(-40, 2),
        g(-120, 2),
        g(160, 2),
        g(80, 2),
        g(0, 2),
      ],
    },
    SELF_INTERSECT,
  ],
  [
    "repeated consecutive and closing vertex",
    { outer: [g(0, 0), g(1, 0), g(1, 0), g(1, 1), g(0, 1), g(0, 0)] },
  ],
  ["box (0,40)-(10,50)", { outer: box }],
  [
    "antimeridian square",
    { outer: [g(170, -10), g(-170, -10), g(-170, 10), g(170, 10)] },
  ],
  ["square 1e-5 degrees across", { outer: square(10, 40, 1e-5) }],
  ["square 1e-8 degrees across", { outer: square(10, 40, 1e-8) }],
  ["square 5e-10 degrees across", { outer: square(10, 40, 5e-10) }, NON_ZERO],
  ["151-degree edge", { outer: [g(0, 0), g(151, 0), g(75, 20)] }],
  [
    "edge 0.009 degrees short of antipodal",
    { outer: [g(0, 0), g(179.991, 0), g(90, 30)] },
    NEAR_ANTIPODE,
  ],
  [
    "edge 0.011 degrees short of antipodal",
    { outer: [g(0, 0), g(179.989, 0), g(90, 30)] },
  ],
  [
    "edge over the north pole (0,10)-(180,20)",
    { outer: [g(0, 10), g(90, 15), g(180, 20)] },
  ],
  ["edge over the south pole", { outer: [g(0, -10), g(180, -20), g(90, -15)] }],
  [
    "ring over both poles",
    { outer: [g(0, 10), g(180, 10), g(180, -10), g(0, -10)] },
    AROUND_POLE,
  ],
  [
    "vertex 5e-10 degrees from a pole",
    { outer: [g(0, 89.999_999_999_5), g(0, 80), g(90, 80)] },
    RING_POLE_MESSAGE,
  ],
  [
    "vertex 1.5e-9 degrees from a pole",
    { outer: [g(0, 89.999_999_998_5), g(0, 80), g(90, 80)] },
  ],
  [
    "counterclockwise triangle 1e-7 degrees from the south pole",
    {
      outer: [
        g(-35.486, -89.999_999_9),
        g(-15.743, -89.999_999_9),
        g(-31.495, -89.999_999_8),
      ],
    },
  ],
  [
    "edge between two vertices 1e-7 degrees from the south pole",
    {
      outer: [
        g(-60, -89.999_999_9),
        g(0, -89.999_999_9),
        g(60, -89.999_999_9),
        g(120, -89.999_999_9),
        g(120, -60),
        g(60, -60),
        g(0, -60),
        g(-60, -60),
      ],
    },
  ],
];

const pairs = (ring) => ring.map((p) => [p.longitude, p.latitude]);
const points = (ring) =>
  ring.map(([longitude, latitude]) => g(longitude, latitude));
const encode = (polygon) => ({
  outer: pairs(polygon.outer),
  ...(polygon.holes ? { holes: polygon.holes.map(pairs) } : {}),
});
const decode = (polygon) => ({
  outer: points(polygon.outer),
  ...(polygon.holes ? { holes: polygon.holes.map(points) } : {}),
});
const canonical = (p) =>
  g(p.longitude === -180 ? 180 : p.longitude + 0, p.latitude + 0);

/** VibORM's verdict as the corpus records it. */
function verdictOf(codec, polygon) {
  const result = codec.validateGeoPolygon(structuredClone(polygon));
  if (result.issues) {
    const [issue] = result.issues;
    return {
      message: issue.message,
      path: issue.path.map((part) => part.key ?? part),
    };
  }
  const sent = rings(polygon).map((ring) =>
    JSON.stringify(ring.map(canonical))
  );
  const reversed = rings(result.value).map(
    (ring, index) => JSON.stringify(ring) !== sent[index]
  );
  return { admitted: true, reversed };
}

const vertexCount = (polygon) =>
  rings(polygon).reduce((sum, ring) => sum + ring.length, 0);
const MAX_CORPUS_VERTICES = 60;

function drawCorpus(codec) {
  const cases = [];
  const disagreements = [];
  for (const [name, polygon, message] of NAMED) {
    const expect = verdictOf(codec, polygon);
    if ((expect.message ?? undefined) !== message) {
      throw new Error(
        `${name}: the ledger says ${message ?? "admitted"}, VibORM says ${expect.message ?? "admitted"}`
      );
    }
    const judged = judgeUnambiguous(polygon);
    cases.push({
      name: `named: ${name}`,
      oracle: judged ?? "not judged",
      polygon: encode(polygon),
      expect,
    });
  }
  const keep = (name, polygon, oracle) => {
    const expect = verdictOf(codec, polygon);
    const got = expect.message ? category(expect.message) : "ok";
    if ((got === "ok") !== (oracle === "ok"))
      disagreements.push({ name, oracle, expect });
    else cases.push({ name, oracle, polygon: encode(polygon), expect });
  };
  for (const kind of VERDICT_KINDS) {
    const r = xorshift32Arithmetic(1);
    let kept = 0;
    for (let i = 0; kept < 30 && i < 1000; i += 1) {
      const polygon = verdictPolygon(kind, r);
      const oracle =
        vertexCount(polygon) <= MAX_CORPUS_VERTICES
          ? judgeUnambiguous(polygon)
          : undefined;
      if (oracle !== undefined) {
        keep(`verdicts ${kind} seed 1 #${i}`, polygon, oracle);
        kept += 1;
      }
    }
  }
  const rnd = minimalStandard(301);
  const generate = poleGenerators(rnd);
  for (const kind of POLE_KINDS) {
    let kept = 0;
    for (let i = 0; kept < 12 && i < 150; i += 1) {
      const drawn = drawPole(codec, generate, rnd, kind);
      if (
        drawn &&
        !drawn.gray &&
        vertexCount(drawn.polygon) <= MAX_CORPUS_VERTICES
      ) {
        if (drawn.wrong)
          disagreements.push({
            name: `pole ${kind} seed 301 #${i}`,
            oracle: drawn.reasons,
            wrong: drawn.wrong,
          });
        else {
          cases.push({
            name: `pole ${kind} seed 301 #${i}`,
            oracle: drawn.reasons,
            polygon: encode(drawn.polygon),
            expect: verdictOf(codec, drawn.polygon),
          });
          kept += 1;
        }
      }
    }
  }
  const review3 = review3Generators(xorshift32(1111));
  let kept = 0;
  for (let i = 0; kept < 60 && i < 1500; i += 1) {
    const { center, radius, polygon } = review3.polygon();
    review3.samples(center, radius, polygon);
    const oracle =
      vertexCount(polygon) <= MAX_CORPUS_VERTICES
        ? judgeUnambiguous(polygon)
        : undefined;
    if (oracle !== undefined) {
      keep(`databases seed 1111 #${i}`, polygon, oracle);
      kept += 1;
    }
  }
  const bands = bandGenerators(xorshift32(5151));
  kept = 0;
  for (let i = 0; kept < 30 && i < 400; i += 1) {
    const polygon = bands.polygon();
    if (polygon) {
      const oracle = judgeUnambiguous(polygon);
      if (oracle !== undefined) {
        keep(`bands seed 5151 #${i}`, polygon, oracle);
        kept += 1;
      }
      if (!codec.validateGeoPolygon(structuredClone(polygon)).issues)
        bands.points();
    }
  }
  return { cases, disagreements };
}

function runCorpus(codec, options) {
  if (options.write) {
    const { cases, disagreements } = drawCorpus(codec);
    if (disagreements.length) {
      process.stdout.write(`${JSON.stringify(disagreements, null, 1)}\n`);
      throw new Error(
        `${disagreements.length} drawn polygons where VibORM and the oracle disagree; corpus not written`
      );
    }
    const corpus = {
      about:
        "GeoPolygon verdicts of src/validation/primitives/geo-area-codec.ts; regenerate with `node scripts/geo-verification/fuzz.mjs corpus --write` (README.md)",
      cases,
    };
    writeFileSync(CORPUS, `${JSON.stringify(corpus)}\n`);
    execFileSync(
      join(repoRoot, "node_modules/.bin/biome"),
      ["format", "--write", CORPUS],
      { stdio: "ignore" }
    );
    process.stdout.write(`wrote ${cases.length} cases to ${CORPUS}\n`);
    return { rows: [], bad: [] };
  }
  const { cases } = JSON.parse(readFileSync(CORPUS, "utf8"));
  const moved = [];
  const counts = { cases: cases.length, admitted: 0, refused: 0, moved: 0 };
  for (const entry of cases) {
    const got = verdictOf(codec, decode(entry.polygon));
    counts[got.admitted ? "admitted" : "refused"] += 1;
    if (JSON.stringify(got) !== JSON.stringify(entry.expect)) {
      counts.moved += 1;
      moved.push({
        name: entry.name,
        oracle: entry.oracle,
        expected: entry.expect,
        got,
      });
    }
  }
  return { rows: [counts], bad: moved, failed: moved.length };
}

// ---------------------------------------------------------------------------

/** Appends a row summing each numeric column (the largest, for *Ms columns). */
function withTotal(rows) {
  if (rows.length < 2) return rows;
  const [label, ...columns] = Object.keys(rows[0]);
  const total = { [label]: "total" };
  for (const column of columns) {
    const values = rows.map((row) => row[column]);
    if (
      column === "kind" ||
      !values.every((value) => typeof value === "number")
    )
      total[column] = "";
    else if (column.endsWith("Ms")) total[column] = Math.max(...values);
    else total[column] = values.reduce((sum, value) => sum + value, 0);
  }
  return [...rows, total];
}

const SUITES = {
  verdicts: runVerdicts,
  pole: runPole,
  databases: runDatabases,
  bands: runBands,
  overpole: runOverPole,
  corpus: runCorpus,
};

const options = flags();
const suite = options._[0];
if (!SUITES[suite]) {
  process.stdout.write(
    `usage: node scripts/geo-verification/fuzz.mjs <${Object.keys(SUITES).join("|")}> [--seeds=..] [--n=..] [--kinds=..]\n`
  );
  process.exit(2);
}
const started = performance.now();
const codec = await loadCodec();
const { rows, bad, failed = 0 } = await SUITES[suite](codec, options);
if (rows.length) process.stdout.write(`${table(withTotal(rows))}\n`);
for (const entry of bad.slice(0, 10))
  process.stdout.write(`${JSON.stringify(entry).slice(0, 2000)}\n`);
if (bad.length > 10) process.stdout.write(`... and ${bad.length - 10} more\n`);
const seconds = ((performance.now() - started) / 1000).toFixed(1);
process.stdout.write(
  `${suite}: ${bad.length} listed, ${failed} failing, ${seconds} s\n`
);
// Database suites report what the databases do; only a wrong VibORM verdict
// or a moved corpus verdict fails.
process.exitCode = failed ? 1 : 0;
