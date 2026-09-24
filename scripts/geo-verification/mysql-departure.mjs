/**
 * How far MySQL 8's edge (the ellipsoid's shortest path, SRID 4326) leaves the
 * great-circle arc VibORM and PostGIS read, by edge length: the "largest
 * observed departure" table of point.mdx, the CHANGELOG and the ledger.
 *
 *   MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm \
 *     node scripts/geo-verification/mysql-departure.mjs [edges|triangles] [--groups=d,f,g,h,i]
 *     node scripts/geo-verification/mysql-departure.mjs edges --lengths=10,30 --edges=30 --seed=99
 *
 * edges: for random edges of each length, the triangle (A, B, C) with C 60
 * degrees off the edge's middle is sent to MySQL, and at five fractions along
 * the edge a point is bisected (40 steps from 20 degrees either side) across
 * the boundary MySQL draws; the departure is its distance from the arc.
 * triangles: random triangles with an edge `gap` degrees short of antipodal,
 * 200 random points each, PostGIS and MySQL against the sphere, points within
 * 1 degree of an edge left out.
 */
import {
  answer,
  closeDatabases,
  flags,
  mysqlConfigured,
  openDatabases,
  seedList,
  table,
  xorshift32,
} from "./harness.mjs";
import {
  angle,
  cross,
  dot,
  edgeClearance,
  normalize,
  plus,
  scale,
  vec,
} from "./oracle.mjs";

const RADIANS = Math.PI / 180;
const round9 = (x) => Math.round(x * 1e9) / 1e9;
// Review round 3's conversion back to degrees (no renormalization).
const toPoint = (v) => ({
  longitude: Math.atan2(v[1], v[0]) / RADIANS,
  latitude: Math.asin(Math.max(-1, Math.min(1, v[2]))) / RADIANS,
});
const rounded = (p) => ({
  longitude: round9(p.longitude),
  latitude: round9(p.latitude),
});
const randomPoint = (rnd) => ({
  longitude: rnd() * 360 - 180,
  latitude: Math.asin(2 * rnd() - 1) / RADIANS,
});

// mysql-adapter.ts: withinPolygon over geoPoint.value, evaluated on one point.
const MYSQL_WITHIN_POINT =
  "SELECT ST_Intersects(ST_GeomFromGeoJSON(?, 1, 4326), ST_GeomFromText(CONCAT('POINT(', ?, ' ', ?, ')'), 4326, 'axis-order=long-lat')) AS inside";

/**
 * The runs behind the documented table, each a fresh stream at its own seed,
 * 30 edges per length: 10, 30 and 60 degrees come from h, 90 and 120 from g,
 * 150 from d, 170 and 174 from f, 178 and 179 from i. a and c are the lane's
 * 10-edge runs that first gave those five rows (h and i rerun them at 30
 * edges from the same seeds); b and e measured the lengths between.
 */
const GROUPS = {
  a: { seed: 5, lengths: [1, 5, 10, 30, 60, 90], edges: 10 },
  b: { seed: 6, lengths: [120, 150, 160, 170], edges: 10 },
  c: { seed: 7, lengths: [175, 178, 179, 179.5, 179.9], edges: 10 },
  d: { seed: 11, lengths: [140, 150, 155], edges: 30 },
  e: { seed: 12, lengths: [160, 165, 168], edges: 30 },
  f: { seed: 13, lengths: [170, 172, 174], edges: 30 },
  g: { seed: 14, lengths: [90, 120, 130], edges: 30 },
  h: { seed: 5, lengths: [10, 30, 60], edges: 30 },
  i: { seed: 7, lengths: [178, 179], edges: 30 },
};

async function departures(my, options) {
  const fractions = [0.1, 0.25, 0.5, 0.75, 0.9];
  const range = Number(options.range ?? 20);
  const custom = options.lengths
    ? {
        custom: {
          seed: Number(options.seed ?? 99),
          lengths: String(options.lengths).split(",").map(Number),
          edges: Number(options.edges ?? 30),
        },
      }
    : undefined;
  const groups =
    custom ??
    Object.fromEntries(
      String(options.groups ?? "d,f,g,h,i")
        .split(",")
        .map((name) => [name, GROUPS[name]])
    );
  const rows = [];
  for (const [group, { seed, lengths, edges }] of Object.entries(groups)) {
    const rnd = xorshift32(seed);
    for (const length of lengths) {
      let largest = 0;
      let sum = 0;
      let found = 0;
      let lost = 0;
      for (let t = 0; t < edges; t += 1) {
        const a0 = vec(randomPoint(rnd));
        const u = normalize(cross(a0, vec(randomPoint(rnd))));
        const tangent = normalize(cross(u, a0));
        const b0 = normalize(
          plus(
            scale(a0, Math.cos(length * RADIANS)),
            scale(tangent, Math.sin(length * RADIANS))
          )
        );
        const A = rounded(toPoint(a0));
        const B = rounded(toPoint(b0));
        const a = vec(A);
        const b = vec(B);
        const n = normalize(cross(a, b));
        const middle = normalize(plus(a, b));
        const C = rounded(
          toPoint(
            normalize(
              plus(
                scale(middle, Math.cos(60 * RADIANS)),
                scale(n, Math.sin(60 * RADIANS))
              )
            )
          )
        );
        const json = JSON.stringify({
          type: "Polygon",
          coordinates: [[A, B, C, A].map((p) => [p.longitude, p.latitude])],
        });
        const w = angle(a, b);
        for (const f of fractions) {
          const m = normalize(
            plus(scale(a, Math.sin((1 - f) * w)), scale(b, Math.sin(f * w)))
          );
          const inside = async (d) => {
            const p = toPoint(
              normalize(
                plus(
                  scale(m, Math.cos(d * RADIANS)),
                  scale(n, Math.sin(d * RADIANS))
                )
              )
            );
            const [[row]] = await my.query(MYSQL_WITHIN_POINT, [
              json,
              p.longitude,
              p.latitude,
            ]);
            return Boolean(row.inside);
          };
          let lo = -range;
          let hi = range;
          if ((await inside(lo)) || !(await inside(hi))) {
            lost += 1;
            continue;
          }
          for (let step = 0; step < 40; step += 1) {
            const mid = (lo + hi) / 2;
            if (await inside(mid)) hi = mid;
            else lo = mid;
          }
          largest = Math.max(largest, Math.abs(hi));
          sum += Math.abs(hi);
          found += 1;
        }
      }
      rows.push({
        group,
        seed,
        lengthDeg: length,
        edges,
        largestDeg: largest.toPrecision(4),
        meanDeg: (sum / found).toPrecision(4),
        largestOverLength: (largest / length).toExponential(2),
        notFoundWithinRange: lost,
      });
    }
  }
  return rows;
}

async function triangles(options) {
  const gaps = String(
    options.gaps ??
      "2,1,0.5,0.2,0.1,0.05,0.02,0.01,0.005,0.002,0.001,0.0005,0.0002,0.0001,0.00001,0.000001"
  )
    .split(",")
    .map(Number);
  const count = Number(options.n ?? 30);
  const db = await openDatabases();
  const differenceCross = (a, b) => cross(plus(a, scale(b, -1)), plus(a, b));
  const side = (a, b, p) => Math.sign(dot(differenceCross(a, b), p));
  const rows = [];
  for (const seed of seedList(options.seeds ?? "1,2")) {
    const rnd = xorshift32(seed);
    for (const gap of gaps) {
      const row = {
        seed,
        gapDeg: gap,
        triangles: 0,
        pgRaised: 0,
        pgVsMy: 0,
        pgVsSphere: 0,
        myVsSphere: 0,
      };
      for (let t = 0; t < count; t += 1) {
        const A = randomPoint(rnd);
        const a = vec(A);
        const anti = scale(a, -1);
        let d = normalize(cross(anti, vec(randomPoint(rnd))));
        const theta = rnd() * 2 * Math.PI;
        const e = normalize(cross(anti, d));
        d = normalize(
          plus(scale(d, Math.cos(theta)), scale(e, Math.sin(theta)))
        );
        const B = rounded(
          toPoint(
            normalize(
              plus(
                scale(anti, Math.cos(gap * RADIANS)),
                scale(d, Math.sin(gap * RADIANS))
              )
            )
          )
        );
        const c0 = normalize(cross(a, vec(B)));
        const sign = rnd() < 0.5 ? 1 : -1;
        const C = rounded(
          toPoint(
            normalize(
              plus(
                scale(c0, sign),
                a.map((x) => x * (rnd() - 0.5))
              )
            )
          )
        );
        const A9 = rounded(A);
        const [va, vb, vc] = [vec(A9), vec(B), vec(C)];
        const orientation = side(va, vb, vc);
        const ring = orientation > 0 ? [A9, B, C] : [A9, C, B];
        const json = JSON.stringify({
          type: "Polygon",
          coordinates: [
            [...ring, ring[0]].map((p) => [p.longitude, p.latitude]),
          ],
        });
        const points = Array.from({ length: 200 }, () =>
          rounded(randomPoint(rnd))
        );
        const answers = await answer(db, json, points, { index: false });
        row.triangles += 1;
        if (typeof answers.pg === "string" || typeof answers.my === "string") {
          row.pgRaised += 1;
          continue;
        }
        for (const [k, p] of points.entries()) {
          if (edgeClearance(p, { outer: [A9, B, C] }).degrees < 1) continue;
          const v = vec(p);
          const sphere =
            side(va, vb, v) === orientation &&
            side(vb, vc, v) === orientation &&
            side(vc, va, v) === orientation;
          const pg = answers.pg.has(k);
          const my = answers.my.has(k);
          if (pg !== my) row.pgVsMy += 1;
          if (pg !== sphere) row.pgVsSphere += 1;
          if (my !== sphere) row.myVsSphere += 1;
        }
      }
      rows.push(row);
    }
  }
  await closeDatabases(db);
  return rows;
}

const options = flags();
const part = options._[0] ?? "edges";
if (!mysqlConfigured()) {
  process.stdout.write(
    "mysql-departure measures MySQL: skipped, MYSQL_TEST_CONNECTION_STRING is not set (e.g. mysql://root:password@127.0.0.1:3307/viborm)\n"
  );
  process.exit(0);
}
const started = performance.now();
let rows;
if (part === "triangles") rows = await triangles(options);
else {
  const { default: mysql } = await import("mysql2/promise");
  const my = await mysql.createConnection(
    process.env.MYSQL_TEST_CONNECTION_STRING
  );
  rows = await departures(my, options);
  await my.end();
}
process.stdout.write(
  `${table(rows)}\n${part}: ${((performance.now() - started) / 1000).toFixed(1)} s\n`
);
