# GeoPolygon verification kit

Manual tools that reproduce the figures written about GeoPolygon admission
(`src/validation/primitives/geo-area-codec.ts`) and about how PostgreSQL
(PostGIS `geography`) and MySQL 8 (SRID 4326) read an admitted polygon. They
back the addendum "Retired, then restored: the polygon geometry pre-checks" in
`docs/architecture/guard-ownership-ledger.md`, the "Geo" entry of
`CHANGELOG.md`, and "How each database reads a polygon" in
`docs/content/docs/schema/scalars/point.mdx`.

They are not part of any Vitest project or CI lane: they take seconds to
minutes and some need a MySQL server. `fuzz.mjs corpus` is the exception
meant to be run whenever the codec changes (below).

| File | What it is |
| --- | --- |
| `oracle.mjs` | The independent judges. Imports nothing from VibORM. |
| `fuzz.mjs` | The seeded differential fuzz, and the corpus check. |
| `perf.mjs` | The adversarial performance inputs. |
| `mysql-departure.mjs` | MySQL's edge against the great-circle arc; near-antipodal triangles. |
| `harness.mjs` | The codec bundled from `src/` with the repository's esbuild and tsconfig paths, the seeded generators, and the adapters' `withinPolygon` SQL on PGlite and MySQL. |
| `corpus.json` | 384 polygons with VibORM's verdict, each confirmed by an oracle when drawn. |

## Setup

`pnpm install` is enough for everything except MySQL: the codec is bundled in
memory from this checkout (no build), and PGlite 0.5.8 with
`@electric-sql/pglite-postgis` are devDependencies. MySQL parts run only when
`MYSQL_TEST_CONNECTION_STRING` is set, and say "MySQL skipped" otherwise. The
figures below were taken on MySQL 8 in Docker:

```sh
export MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm
```

Each script creates its own `geo_verification_<pid>` table and drops it.

## The judges (`oracle.mjs`)

- `parityInside`: even-odd point in polygon on the sphere, counting the
  great-circle arcs crossed between the point and a reference point outside
  the polygon (review round 3). Used to say which database answered a point
  wrongly.
- `judgeGeometry`: float64 brute force, every pair of arcs compared, holes
  placed by a meridian ray to the north pole (review round 7), updated to the
  owner rule: a vertex within 1e-9 degrees of a pole is refused, an edge of
  exactly 180 degrees of longitude (over a pole) is outside its domain and
  skipped. A polygon is judged only when a lenient and a strict slack (1e-4 of
  the ring's size, 1e-13 to 1e-7 radians) give the same verdict.
- `judgeNearPole`: exact geometry in the gnomonic projection from the north
  pole, where every great circle is a straight line, on 80-digit fixed-point
  BigInts (sines and cosines by Taylor series, pi by Machin's formula). A ring
  whose feature lies within twice VibORM's 1e-9-degree tolerance is "gray"
  and left out: there the verdict is VibORM's resolution, not a fact. It
  replaces the lane's 60-digit decimal.js judge and gives the same counts on
  every seed below.

## What each run reproduces

Times are from one run on an Apple silicon laptop, MySQL in Docker.

### Admission verdicts against the float judge

```sh
node scripts/geo-verification/fuzz.mjs verdicts            # --seeds=1 --n=5000, about 50 s
```

Backs the ledger: "The review's oracle fuzz (fuzz.mjs, 5,000 each of star,
holes, spiral, band, long: 0 false refusals, 0 false admissions)". Generators
from review round 7 (stars 1e-6 to 170 degrees, stars with up to 12 holes,
double spirals, jagged bands up to 359 degrees wide with holes, triangles with
a 150 to 179.995-degree edge), one xorshift stream per kind at seed 1.
Observed:

```text
seed   kind    polygons  ambiguous  admitted  refused  falseAdmit  falseRefuse  otherReason  slowestMs
-----  ------  --------  ---------  --------  -------  ----------  -----------  -----------  ---------
1      star    5000      13         3607      1380     0           0            0            3
1      holes   5000      146        249       4605     0           0            1366         1
1      spiral  5000      16         2701      2283     0           0            0            3
1      band    5000      0          2477      2523     0           0            244          0
1      long    5000      0          2992      2008     0           0            1            0
total          25000     175        12026     12799    0           0            1611         3
verdicts: 0 listed, 0 failing, 54.9 s
```

`otherReason` counts polygons both refuse, for a different first reason: the
judge tests each ring against itself before rings against each other, the
codec reports the first meeting its sweep finds (1,017 of the 1,366 for holes
are a self-crossing ring the codec reports as a hole leaving the outer ring). The run
prints the pairs.

### Near-pole and over-the-pole rings against the exact judge

```sh
node scripts/geo-verification/fuzz.mjs pole                # --seeds=301-306 --n=150, about 45 s
```

Backs the ledger's second pass ("Oracle runs on the final codec
(geo-pole/probe.mjs against 60-digit gnomonic geometry from the pole, seeds
301-306, 150 per kind): 6,190 polygons judged, 3,193 admitted and 2,997
refused, 0 wrong in verdict, message or winding; 1,664 with a clearance within
twice `TOLERANCE` left out") and the CHANGELOG's "every one of 6,190 polygons
with vertices 3.5e-9 to 3.6e-4 degrees from a pole, over it or with holes by
it". Nine kinds: stars, shuffled rings, rings with holes (anywhere, or inside)
1e-8 to 1e-4 degrees across near the pole; rings with an edge over the pole
(small, 5 to 80 degrees from it, shuffled, with holes by the pole). Each
polygon is mirrored to the south pole by a coin flip. Observed (totals row;
every per-seed row matches the lane's `final-30x.txt`):

```text
seed   kind              admitted  refused  gray  skipped  wrong  nearestColatitude  farthestColatitude
-----  ----------------  --------  -------  ----  -------  -----  -----------------  ------------------
total                    3193      2997     1664  246      0
pole: 0 listed, 0 failing, 46.1 s
```

### PostGIS, MySQL and the sphere on random polygons

```sh
node scripts/geo-verification/fuzz.mjs databases           # --seeds=1111,2222,3333,4444 --n=1500, about 70 s
```

Review round 3's differential fuzz: polygons of 5 to 12 vertices, 1e-3 to 110
degrees across, 30% near a pole, 25% on the antimeridian, half with up to 3
holes; 87 sample points each; PostGIS and MySQL table scans with the adapters'
exact predicates against `parityInside`, points within 1e-6 degrees or 1% of
an edge's length of an edge left out. Every admitted polygon must be answered
alike by both databases and the sphere. Observed:

```text
seed   polygons  admitted  admittedAgree  admittedDisagree  disagreeAcrossPlanes  refused  refusedDbDisagree  pgRaised
-----  --------  --------  -------------  ----------------  --------------------  -------  -----------------  --------
1111   1500      695       695            0                 0                     805      407                0
2222   1500      723       723            0                 0                     777      371                0
3333   1500      719       719            0                 0                     781      384                0
4444   1500      735       735            0                 0                     765      360                0
total  6000      2872      2872           0                 0                     3128     1522               0
databases: 0 listed, 0 failing, 77.3 s
```

The admitted counts (695, 723, 719, 735, all agreeing) and the refusal totals
are the round 3 files' exactly. How the refusals split between messages moved
since round 3, because the codec now reports the first meeting its sweep finds
(seed 1111: round 3 had 448 self-intersecting, 226 holes outside, 83 poles, 48
holes overlapping; now 407, 241, 83, 74). `refusedDbDisagree` counts refused
polygons the databases answer unlike the sphere: what refusing them prevents.
Without MySQL the comparison is PostGIS against the sphere.

### Large bands, and triangles near the antipode (needs MySQL)

```sh
node scripts/geo-verification/fuzz.mjs bands               # --seeds=5151,6262 --n=400, about 10 s
```

Review round 3's second fuzz: 60% bands 120 to 359 degrees wide, 40%
triangles with an edge 1e-3 to 1e-8 degrees short of antipodal; 150 random
points each. Observed:

```text
seed   polygons  admitted  agree  disagree  disagreeAcrossPlanes  pgUnlikeSphere  myUnlikeSphere  refused
-----  --------  --------  -----  --------  --------------------  --------------  --------------  -------
5151   400       226       220    6         6                     6               0               174
6262   400       228       212    16        16                    16              0               172
total  800       454       432    22        22                    22              0               346
bands: 0 listed, 0 failing, 9.9 s
```

At round 3 the codec admitted the triangles and 56 and 66 polygons were
answered differently. Now every triangle is refused (`A GeoPolygon edge cannot
join vertices within 0.01 degrees of antipodal`), and every remaining
difference is PostGIS unlike the sphere on a ring across the equator and both
meridian planes, MySQL never: the "PostGIS falls back to a guess" sentence of
`point.mdx` and the CHANGELOG, and "MySQL none".

### Edges over a pole in the databases

```sh
node scripts/geo-verification/fuzz.mjs overpole            # --seeds=4242,777 --n=70, about 12 s
```

Backs point.mdx "Over a pole" and the ledger's "8 named rings over a pole and
140 random ones (5 to 80 degrees from the pole, both poles, PGlite + PostGIS
and MySQL 8, table and index scans, about 118,000 points at least 0.01 degrees
from every edge; geo-pole/dbpole.mjs, seeds 4242 and 777) gave no wrong answer
on PostGIS and one on MySQL, a point 0.02 degrees from a long non-meridian
edge". Truth is the planar even-odd rule in the gnomonic projection from the
ring's pole. Observed:

```text
name                                           points  pg  pgIndex  my  myIndex
---------------------------------------------  ------  --  -------  --  -------
(0,10)-(180,20) over the north pole            797     0   0        0   0
closing edge (180,80)-(0,80)                   797     0   0        0   0
(0,10)-(180,10) with (90,5)                    797     0   0        0   0
over the south pole                            798     0   0        0   0
small, near the pole                           798     0   0        0   0
(-90,20)-(90,10) across the antimeridian side  799     0   0        0   0
with a hole by the pole                        797     0   0        0   0
(45,30)-(-135,40) over the pole                800     0   0        0   0

rings  points  pg  pgIndex  my  myIndex  ringsWrongPg  ringsWrongMy
-----  ------  --  -------  --  -------  ------------  ------------
148    118277  0   0        1   1        0             1
overpole: 1 listed, 0 failing, 12.7 s
```

The one listed ring is MySQL's wrong answer (table and index scan) at
(-85.56135, 55.338794), 0.02 degrees from an edge of the random ring
(-29.25, 19.08), (-157.67, 43.98), (175.14, 69.47), (150.75, 44.41).

### MySQL's edge against the great-circle arc (needs MySQL)

```sh
node scripts/geo-verification/mysql-departure.mjs          # --groups=d,f,g,h,i, about 16 s
node scripts/geo-verification/mysql-departure.mjs edges --groups=a,c   # the lane's 10-edge runs
node scripts/geo-verification/mysql-departure.mjs edges --lengths=10,30 --edges=30 --seed=99
```

Backs the "largest observed departure" table (point.mdx, CHANGELOG, ledger
"Remaining gap" and the retired 150-degree entry). For each random edge of the
given length, the triangle with its third vertex 60 degrees off the edge's
middle is sent to MySQL, and at 1/10, 1/4, 1/2, 3/4 and 9/10 along the edge a
point is bisected (40 steps from 20 degrees either side) onto the boundary
MySQL draws; the departure is its distance from the arc. The query is the
adapter's `withinPolygon` over the adapter's point expression. Each group is
one run, a fresh stream at its seed, its lengths drawn in turn. Observed
(2026-09-24, MySQL 8 in Docker):

```text
group  seed  lengthDeg  edges  largestDeg  meanDeg    largestOverLength  notFoundWithinRange
-----  ----  ---------  -----  ----------  ---------  -----------------  -------------------
d      11    140        30     0.2912      0.07678    2.08e-3            0
d      11    150        30     0.4632      0.1282     3.09e-3            0
d      11    155        30     0.4444      0.1516     2.87e-3            0
f      13    170        30     1.557       0.4286     9.16e-3            0
f      13    172        30     1.780       0.4530     1.03e-2            0
f      13    174        30     2.731       0.6855     1.57e-2            0
g      14    90         30     0.07524     0.02205    8.36e-4            0
g      14    120        30     0.1702      0.05522    1.42e-3            0
g      14    130        30     0.2302      0.06718    1.77e-3            0
h      5     10         30     0.0007121   0.0002927  7.12e-5            60
h      5     30         30     0.006700    0.001970   2.23e-4            60
h      5     60         30     0.02903     0.01316    4.84e-4            60
i      7     178        30     8.355       2.591      4.69e-2            0
i      7     179        30     16.24       3.898      9.07e-2            0
edges: 16.1 s
```

The table's rows, each over 30 random edges: 10, 30 and 60 degrees from h,
90 and 120 from g, 150 from d, 170 and 174 from f, 178 and 179 from i.
`notFoundWithinRange` counts bisections whose start points 20 degrees out fall
outside the triangle: on edges of 60 degrees or less, the points at 1/10 and
9/10 (60 of 150), so those three rows rest on the three middle points of each
edge.

Groups h and i rerun, at 30 edges, the five rows the lane first measured on
10 edges per length (groups a and c; until 2026-09-24 the documents said "30
random edges per length" for them too). The rerun moved 10 degrees from
0.00068 to 0.00071, 60 degrees from 0.019 to 0.029, 179 degrees from 16.61
to 16.24 (its 30 edges are later draws of the stream than group c's 10);
30 and 178 degrees are unchanged. Groups a and c, replayed:

```text
group  seed  lengthDeg  edges  largestDeg   meanDeg      largestOverLength  notFoundWithinRange
-----  ----  ---------  -----  -----------  -----------  -----------------  -------------------
a      5     1          10     0.000006633  0.000002462  6.63e-6            13
a      5     5          10     0.0001766    0.00006915   3.53e-5            20
a      5     10         10     0.0006824    0.0003478    6.82e-5            20
a      5     30         10     0.006700     0.002081     2.23e-4            20
a      5     60         10     0.01895      0.006468     3.16e-4            20
a      5     90         10     0.07164      0.02344      7.96e-4            0
c      7     175        10     3.203        1.065        1.83e-2            0
c      7     178        10     8.355        2.648        4.69e-2            0
c      7     179        10     16.61        4.910        9.28e-2            0
c      7     179.5      10     16.97        6.097        9.45e-2            10
c      7     179.9      10     19.80        6.063        1.10e-1            15
```

```sh
node scripts/geo-verification/mysql-departure.mjs triangles   # --seeds=1,2 --n=30, about 50 s
```

Backs "random triangles with an edge 0.000001 to 2 degrees short of antipodal
were answered unlike PostGIS and the sphere far from the edge in every one of
32 runs of 30" (ledger) and the CHANGELOG/point.mdx sentence on triangles up
to 2 degrees short of opposite points. 16 gaps, 30 triangles each, seeds 1 and
2, 200 random points per triangle, points within 1 degree of an edge left out.
Observed: `pgVsSphere` is 0 in all 32 runs; `myVsSphere` ranges from 30 (seed
2, gap 2) to 1,242 (seed 2, gap 1e-6), never 0; every row equals the lane's
`anti-1.out` / `anti-2.out`.

### Performance

```sh
node scripts/geo-verification/perf.mjs                     # --repeat=3, about 10 s
```

Backs the ledger's timing sentences: the review's star "now 27 ms, 65 ms and
53 ms" (20,000 vertices, 40,000, 20,000 with 50 small holes; "every input of
the review's perf script is under 0.1 s"), hole placement "59 ms for the
10,000 holes, 61 ms for the star with 2,500", the skip-list strips "40 / 68 /
125 / 250 ms" for 20,004 to 160,004 arcs whichever strips are long, and
"admits 130,000 holes that reach the sweep on one meridian" (commit
3afd2c0d6). Best of three:

```text
group     case                             vertices  bestMs  verdict
--------  -------------------------------  --------  ------  --------
round3    circle 20000                     20000     27      admitted
round3    circle 20000 + 50 holes x 8      20400     26      admitted
round3    circle 20000 + 50 holes x 400    40000     48      admitted
round3    star 20000 (r 0.5..20)           20000     25      admitted
round3    star 20000 + 50 holes x 8        20400     26      admitted
round3    comb 20000                       20003     17      admitted
round3    star 40000                       40000     48      admitted
round4    star 40k                         40000     49      admitted
round4    star 100k                        100000    143     admitted
round4    spiral 40k                       40000     62      admitted
round4    comb 5k teeth                    20003     20      admitted
round4    meridian comb 5k teeth           20003     32      admitted
round4    antimeridian star 40k            40000     56      admitted
round4    64-gon + 400 holes               1664      2       admitted
round4    64-gon + 2500 holes              10064     14      admitted
round4    64-gon + 10000 holes             40064     59      admitted
round4    star 40k + 2500 holes            50000     93      admitted
round4    near-edge star 20k + 1000 holes  24000     34      admitted
strips    5000 strips, control             20004     30      admitted
strips    5000 strips, adversarial         20004     30      admitted
strips    10000 strips, control            40004     61      admitted
strips    10000 strips, adversarial        40004     73      admitted
strips    20000 strips, control            80004     138     admitted
strips    20000 strips, adversarial        80004     149     admitted
strips    40000 strips, control            160004    301     admitted
strips    40000 strips, adversarial        160004    320     admitted
meridian  130,000 holes on one meridian    390004    644     admitted
```

Timings move with the machine's load: an earlier run on the same laptop took
214 and 224 ms for the 40,000 strips and 54 ms for the 40,000-vertex star.

## The corpus

```sh
node scripts/geo-verification/fuzz.mjs corpus          # check, under a second; exits 1 on any moved verdict
node scripts/geo-verification/fuzz.mjs corpus --write  # regenerate corpus.json
```

`corpus.json` holds 384 polygons: the ledger's table and owner-rule rows
(36, each with the verdict the ledger states), 150 from the `verdicts`
generators at seed 1 (30 per kind), 108 near-pole and over-the-pole rings from
the `pole` generators at seed 301 (12 per kind), 60 from the `databases`
generator at seed 1111 and 30 from the `bands` generator at seed 5151, rings of
at most 60 vertices. Each case records VibORM's verdict: the refusal message
and path, or admission with which rings were sent reversed (outer
counterclockwise, holes clockwise). `--write` keeps a drawn polygon only where
an oracle judges it unambiguously and agrees with VibORM, and refuses to write
when a named case departs from the ledger.

The check replays every case against the codec in `src/` and lists each case
whose verdict, message, path or winding moved. After a deliberate change to a
tolerance or a sweep rule, read that list: each moved case is a polygon whose
meaning for callers changed. Regenerate only when every move is intended.
Falsified on 2026-09-24 by bundling the codec with one constant changed in
memory: `NEAREST_ANTIPODE` at 0.001 degrees moved 1 case ("edge 0.009 degrees
short of antipodal"), `TOLERANCE` at 1e-7 degrees moved 38.

## Not in the kit

These figures in the documents came from the lane's scratch scripts that the
kit does not keep; they are reproducible only by rewriting the probe the
sentence describes:

- 9,000 random rings 1e-9 to 1e-4 degrees across (4,048 admitted, 2,135
  refused, 0 wrong; `tinygen.mjs` / `tinyjudge.py`, seeds 1 to 3).
- the near-antipode jitter (3.1e-9 degrees at 0.001, 3.0e-10 at 0.01;
  `antijitter.mjs`) and the antipode test in `crosses` against an angle-sum
  judge (400,000 and 400,000 arc pairs; `crosscheck.mjs`).
- the deleted column comparison (160,000 and 280,000 polygons; `diff.mjs`),
  the pairwise hole placement comparison (95,000), the sweep against every
  pair (120,000), determinism (24,000 polygons validated 8 times), `msgcheck`
  and `gridneg`.
- PostGIS's three-planes fallback counts (23 of 372 rings, 42 of 44
  rotations; the witnesses' 38 of 394, 398 of 398, 347 of 397), MySQL near a
  vertex (about 13% within 1e-6 degrees; 152 index/table disagreements) and in
  tiny rings (0.4% at 5e-6 across to 34-56% below 1e-6), the near-pole
  database clearance (about 1,500 rings from 5.6e-6 degrees), PostGIS's
  4e-12-degree edge reading, and the 4,800-case differential of holes and
  quadrilaterals.
- the falsifier counts (`falsify.py`): those are rerun by mutating the codec
  and running `tests/unit/validation/geo-area.core.test.ts` and
  `tests/contracts/engine/query/geopoint-sql.core.test.ts`.
