/**
 * The adversarial inputs behind the ledger's timing figures for
 * validateGeoPolygon: review round 3's stars and combs, review round 4's
 * spirals and hole grids, review round 7's strips against predictable
 * skip-list heights, and 130,000 holes reaching the sweep on one meridian.
 *
 *   node scripts/geo-verification/perf.mjs [--repeat=3] [--groups=round3,round4,strips,meridian]
 *
 * Each case is validated `repeat` times on a fresh copy; the best time is shown.
 */
import { flags, loadCodec, table } from "./harness.mjs";

const g = (longitude, latitude) => ({ longitude, latitude });
const nano = (x) => Math.round(x * 1e9) / 1e9;
const P = (longitude, latitude) => g(nano(longitude), nano(latitude));

// review round 3 (geo-review3 perf.mjs): planar shapes in degrees around (0, 0)
const circle3 = (cx, cy, r, n, clockwise) =>
  Array.from({ length: n }, (_, i) => {
    const a = ((clockwise ? -1 : 1) * 2 * Math.PI * i) / n;
    return g(cx + r * Math.cos(a), cy + r * Math.sin(a));
  });
const star3 = (cx, cy, r0, r1, n) =>
  Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    const r = i % 2 ? r0 : r1;
    return g(cx + r * Math.cos(a), cy + r * Math.sin(a));
  });
function comb3(n) {
  const teeth = n / 4;
  const out = [];
  for (let t = 0; t < teeth; t += 1) {
    const x = -40 + (80 * t) / teeth;
    const w = 80 / teeth;
    out.push(g(x, -30), g(x, 30), g(x + w / 2, 30), g(x + w / 2, -29));
  }
  out.push(g(40, -30), g(40, -35), g(-40, -35));
  return out;
}
const holes50 = (n) =>
  Array.from({ length: 50 }, (_, k) =>
    circle3(-14 + (k % 10) * 3.1, -8 + Math.floor(k / 10) * 3.5, 1.2, n, true)
  );
const smallHoles50 = () =>
  Array.from({ length: 50 }, (_, k) =>
    circle3(Math.cos(k) * 0.2, Math.sin(k) * 0.2, 0.001, 8, true)
  );

// review round 4 (geo-review5 perf5.mjs): coordinates rounded to 1e-9
const circle4 = (cx, cy, r, n) =>
  Array.from({ length: n }, (_, i) =>
    P(
      cx + r * Math.cos((2 * Math.PI * i) / n),
      cy + r * Math.sin((2 * Math.PI * i) / n)
    )
  );
const star4 = (n, r1 = 10, r2 = 2) =>
  Array.from({ length: n }, (_, i) => {
    const r = i % 2 ? r2 : r1;
    const t = (2 * Math.PI * i) / n;
    return P(r * Math.cos(t), r * Math.sin(t));
  });
function comb4(teeth) {
  const out = [];
  const w = 20 / teeth;
  for (let i = 0; i < teeth; i += 1) {
    out.push(
      P(-10 + i * w, 0),
      P(-10 + i * w, 10),
      P(-10 + i * w + w / 2, 10),
      P(-10 + i * w + w / 2, 0.01)
    );
  }
  out.push(P(10, 0), P(10, -1), P(-10, -1));
  return out;
}
function meridianComb(teeth) {
  const out = [];
  const h = 20 / teeth;
  for (let i = 0; i < teeth; i += 1) {
    out.push(
      P(0, -10 + i * h),
      P(10, -10 + i * h),
      P(10, -10 + i * h + h / 2),
      P(0.001, -10 + i * h + h / 2)
    );
  }
  out.push(P(0, 10), P(-1, 10), P(-1, -10));
  return out;
}
function spiral4(n, turns = 30) {
  const inward = [];
  const outward = [];
  for (let i = 0; i < n; i += 1) {
    const t = (turns * 2 * Math.PI * i) / n;
    const r = 0.5 + (9 * i) / n;
    inward.push(P(r * Math.cos(t), r * Math.sin(t)));
    outward.push(P((r + 0.1) * Math.cos(t), (r + 0.1) * Math.sin(t)));
  }
  return [...inward, ...outward.reverse()];
}
function holeGrid(k, size = 4) {
  const holes = [];
  const step = 18 / k;
  for (let i = 0; i < k; i += 1) {
    for (let j = 0; j < k; j += 1)
      holes.push(
        circle4(-9 + (i + 0.5) * step, -9 + (j + 0.5) * step, step * 0.3, size)
      );
  }
  return holes;
}
const antimeridianStar = (n) =>
  Array.from({ length: n }, (_, i) => {
    const r = i % 2 ? 2 : 10;
    const t = (2 * Math.PI * i) / n;
    const lon = 180 + r * Math.cos(t);
    return P(lon > 180 ? lon - 360 : lon, r * Math.sin(t));
  });
function nearEdges(n, h) {
  const holes = [];
  for (let i = 0; i < h; i += 1) {
    const t = (2 * Math.PI * (i + 0.5)) / h;
    holes.push(
      circle4(9.5 * Math.cos(t) * 0.99, 9.5 * Math.sin(t) * 0.99, 0.001, 4)
    );
  }
  return { outer: star4(n, 10, 9.99), holes };
}

// review round 7 (geo-repair7 skipadv.mjs): thin strips in a box, a quarter of
// them long. "adversarial" picks the long ones where Park and Miller's
// generator at seed 1 (the old fixed heights) drew height 1 for both of a
// strip's arcs, which left long-lived arcs at the lowest level of the skip
// list; "control" picks the same share from an independent stream.
const MODULUS = 2_147_483_647;
function strips(n, adversarial) {
  const long = [];
  if (adversarial) {
    let s = 1;
    const heights = [];
    for (let i = 0; i < 2 * n + 2; i += 1) {
      s = (s * 16_807) % MODULUS;
      heights.push(1 + Math.floor(-Math.log2(s / MODULUS)));
    }
    for (let k = 0; k < n; k += 1)
      long.push(heights[2 + 2 * k] === 1 && heights[3 + 2 * k] === 1);
  } else {
    let x = 12_345;
    for (let k = 0; k < n; k += 1) {
      x = (x * 48_271) % MODULUS;
      long.push(x / MODULUS < 0.25);
    }
  }
  const holes = [];
  for (let k = 0; k < n; k += 1) {
    const w = k * (0.1 / n);
    const y = -0.5 + k / n;
    const s = 0.3 / n;
    const e = long[k] ? 0.1 : w + 0.05 / n;
    holes.push([g(w, y), g(e, y), g(e, y + s), g(w, y + s)]);
  }
  return {
    outer: [g(-0.01, -0.6), g(0.11, -0.6), g(0.11, 0.6), g(-0.01, 0.6)],
    holes,
  };
}

// 3afd2c0d6: every hole starts on longitude 1, so the sweep places all at once.
function oneMeridian(count) {
  const holes = Array.from({ length: count }, (_, index) => {
    const latitude = 1 + index * 0.0001;
    return [
      g(1, latitude),
      g(1.000_01, latitude + 0.000_01),
      g(1.000_01, latitude - 0.000_01),
    ];
  });
  return { outer: [g(0, 0), g(4, 0), g(4, 40), g(0, 40)], holes };
}

const GROUPS = {
  round3: {
    "circle 20000": () => ({ outer: circle3(0, 0, 20, 20_000) }),
    "circle 20000 + 50 holes x 8": () => ({
      outer: circle3(0, 0, 20, 20_000),
      holes: holes50(8),
    }),
    "circle 20000 + 50 holes x 400": () => ({
      outer: circle3(0, 0, 20, 20_000),
      holes: holes50(400),
    }),
    "star 20000 (r 0.5..20)": () => ({ outer: star3(0, 0, 0.5, 20, 20_000) }),
    "star 20000 + 50 holes x 8": () => ({
      outer: star3(0, 0, 0.5, 20, 20_000),
      holes: smallHoles50(),
    }),
    "comb 20000": () => ({ outer: comb3(20_000) }),
    "star 40000": () => ({ outer: star3(0, 0, 0.5, 20, 40_000) }),
  },
  round4: {
    "star 40k": () => ({ outer: star4(40_000) }),
    "star 100k": () => ({ outer: star4(100_000) }),
    "spiral 40k": () => ({ outer: spiral4(20_000) }),
    "comb 5k teeth": () => ({ outer: comb4(5000) }),
    "meridian comb 5k teeth": () => ({ outer: meridianComb(5000) }),
    "antimeridian star 40k": () => ({ outer: antimeridianStar(40_000) }),
    "64-gon + 400 holes": () => ({
      outer: circle4(0, 0, 12.8, 64),
      holes: holeGrid(20),
    }),
    "64-gon + 2500 holes": () => ({
      outer: circle4(0, 0, 12.8, 64),
      holes: holeGrid(50),
    }),
    "64-gon + 10000 holes": () => ({
      outer: circle4(0, 0, 12.8, 64),
      holes: holeGrid(100),
    }),
    "star 40k + 2500 holes": () => ({
      outer: star4(40_000, 13, 12.9),
      holes: holeGrid(50),
    }),
    "near-edge star 20k + 1000 holes": () => nearEdges(20_000, 1000),
  },
  strips: Object.fromEntries(
    [5000, 10_000, 20_000, 40_000].flatMap((n) => [
      [`${n} strips, control`, () => strips(n, false)],
      [`${n} strips, adversarial`, () => strips(n, true)],
    ])
  ),
  meridian: { "130,000 holes on one meridian": () => oneMeridian(130_000) },
};

const options = flags();
const repeat = Number(options.repeat ?? 3);
const groups = options.groups
  ? String(options.groups).split(",")
  : Object.keys(GROUPS);
const { validateGeoPolygon } = await loadCodec();
const rows = [];
for (const group of groups) {
  for (const [name, make] of Object.entries(GROUPS[group])) {
    const polygon = make();
    const vertices =
      polygon.outer.length +
      (polygon.holes ?? []).reduce((sum, hole) => sum + hole.length, 0);
    let best = Number.POSITIVE_INFINITY;
    let result;
    for (let run = 0; run < repeat; run += 1) {
      const copy = structuredClone(polygon);
      const started = performance.now();
      result = validateGeoPolygon(copy);
      best = Math.min(best, performance.now() - started);
    }
    const verdict = result.issues
      ? `refused: ${result.issues[0].message}`
      : "admitted";
    rows.push({
      group,
      case: name,
      vertices,
      bestMs: best.toFixed(0),
      verdict,
    });
  }
}
process.stdout.write(`${table(rows)}\n`);
