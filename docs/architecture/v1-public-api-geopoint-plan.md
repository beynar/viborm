# V1 Public API and GeoPoint Completion Plan

## Status

Implementation plan, 2026-08-29. Not implemented.

This plan closes item 2 of
[V1 Release Closure](./v1-release-closure.md): cut the final public API and make
the public point scalar a complete V1 feature. It supersedes that record's
preference to remove `s.point()`.

The migration V1 surface is already curated. Do not reopen its state graph,
storage, apply, push, or recovery design. This program changes migration code
only where GeoPoint physical types, indexes, introspection, and snapshots need
it, plus the one known filesystem-storage export leak.

## Summary

V1 keeps one point language:

```ts
export interface GeoPoint {
  longitude: number;
  latitude: number;
}

const place = s.model({
  id: s.string().id(),
  location: s.point(),
}).index(["location"], { type: "spatial" });
```

`s.point()` means an EPSG:4326 geographic point. It does not mean PostgreSQL's
built-in Cartesian `point`, an arbitrary PostGIS geometry, GeoJSON, or a
caller-selected SRID.

The common PostgreSQL/PostGIS and MySQL language is deliberately small:

- create, read, update, bulk, returning, nullable, mapped columns, and
  application defaults;
- exact coordinate equality and negation;
- numeric distance comparisons in meters, including near, far, and distance
  bands;
- inclusive area membership over rectangular bounds or a polygon with holes;
- distance selection and distance ordering in meters; and
- one portable spatial-index declaration.

SQLite-family providers store and compare the same logical value, but they do
not pretend to have a topology or distance engine. Exact rectangular-bounds
membership is available through coordinate comparison; polygon membership,
distance filtering, and distance selection/ordering fail before execution with
`FeatureNotSupportedError`.

The same program removes pre-V1 compatibility and leaked implementation
surfaces, then freezes the exact built package. No alias is retained because
the ORM is unreleased.

## 1. Goal, constraints, and completion boundary

### Goal

Ship one intentional V1 public package in which every exported symbol is a
supported promise and `s.point()` is a trustworthy geographic scalar on its
declared provider tier.

### Constraints

1. Keep the existing `s.point()` factory name.
2. The only public stored point value is `{ longitude, latitude }`; `{ x, y }`,
   `{ lat, lng }`, tuples, WKT, WKB, and GeoJSON are not alternate inputs.
3. `GeoArea` is a query operand only. It does not add a stored polygon scalar,
   geometry hierarchy, GeoJSON escape hatch, or area result type.
4. EPSG:4326 and meters are fixed facts, not options.
5. PostgreSQL GeoPoint requires PostGIS. VibORM does not install extensions.
6. MySQL uses its geographic SRS, not Cartesian SRID 0.
7. SQLite has a storage tier, not emulated application-side spatial filtering.
8. Raw SQL keeps physical provider values and functions.
9. The query engine decides the requested operation; adapters alone spell
   geographic SQL.
10. Add no geometry hierarchy, SRID registry, spatial manager, strategy,
   operation context, or second result parser.
11. Preserve the migration V1 state graph and authenticated execution model.
12. Preserve the unextended client hot path and non-point query performance.

### Done when

- all public GeoPoint operations round-trip on PostgreSQL/PostGIS and MySQL;
- SQLite-family providers pass the storage/equality/bounds tier and refuse
  polygon and distance work before provider execution;
- migrations converge on all admitted physical representations;
- every invalid GeoPoint role is refused through public types and the single
  runtime definition boundary;
- the built package matches a reviewed exact export manifest; and
- active docs contain no Cartesian point, generic geospatial, experimental
  point, or pre-V1 compatibility claim.

## 2. Confirmed baseline defects

The current point surface is public but not coherent:

1. `s.point()` and its result type exist, but the public value is still
   `{ x, y }` and documentation disagrees about whether the scalar exists.
2. `values-builder.ts` binds the point object directly. PostgreSQL `point`,
   MySQL `POINT`, and SQLite JSON do not share that parameter representation.
3. `where-builder.ts` uses generic `=`. PostgreSQL's built-in `point` does not
   provide ordinary scalar equality, and a geographic point needs spatial or
   coordinate-aware lowering anyway.
4. Result parsing accepts a mixture of accidental provider representations,
   including PostgreSQL `"(x,y)"` text. There is no ORM-owned projection.
5. Input validation accepts inherited properties, extra keys, and infinite
   coordinates while result and JSON Schema validation are stricter.
6. Point fields leak into IDs, unique constraints, foreign keys, ordinary
   indexes, ordering, distinct, grouping, and min/max despite the physical
   types not supporting those roles portably.
7. PostgreSQL driver options advertise PostGIS, but the query engine does not
   call the reserved geospatial operations. MySQL's real geographic support is
   hidden behind an unsupported stub.
8. PostgreSQL migrations currently emit the built-in Cartesian `point`; MySQL
   emits an unrestricted `POINT`; SQLite emits generic `JSON`. None proves the
   final logical contract through introspection and a second push.
9. No stock provider runs a complete GeoPoint
   create/filter/bounds/polygon/distance/index/migration contract.

One stale statement must not guide implementation: `ScalarTypeToTS` already
has a point result arm. The missing work is semantic transport and provider
qualification, not that type arm.

## 3. Frozen public GeoPoint language

### 3.1 Value and canonicalization

Export `GeoPoint` from `viborm`, `viborm/schema`, and `viborm/validation`.
`v.point()` and `s.point()` consume and produce that same type.

Export the query-only area values from `viborm` and `viborm/validation`:

```ts
export interface GeoBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface GeoPolygon {
  outer: readonly GeoPoint[];
  holes?: readonly (readonly GeoPoint[])[];
}

export type GeoArea =
  | { readonly bounds: GeoBounds }
  | { readonly polygon: GeoPolygon };
```

`src/validation/primitives/geo-point-codec.ts` becomes the one value owner. It
must:

- accept only a plain object with exactly the own keys `longitude` and
  `latitude`;
- read each property once through the existing hostile-safe validation
  boundary;
- require finite JavaScript numbers;
- require latitude in `[-90, 90]`;
- accept longitude in `[-180, 180]`, canonicalizing `-180` to `180` because
  MySQL's geographic SRS admits `(-180, 180]`;
- canonicalize `-0` to `0`;
- return a fresh ordinary `{ longitude, latitude }` object; and
- translate access, key enumeration, prototype, and coercion failures into the
  existing validation error model without reading hostile input again.

The codec owns input normalization, provider-result normalization, cache
snapshot validation, literal default normalization, and JSON Schema examples.
Downstream consumers do not reinterpret coordinate ranges or aliases.

`src/validation/primitives/geo-area-codec.ts` is the separate owner of the
query-only area language. The outer object has exactly one own key, `bounds` or
`polygon`; there is no shape guessing and no arbitrary GeoJSON arm.

For bounds, it applies the same hostile-safe, own-key, finite-number, and
fresh-output rules. `south` and `north` must be in `[-90, 90]`, `west` and
`east` in `[-180, 180]`, and `south <= north`. An ordinary rectangle has
`west <= east`; `west > east` deliberately means a rectangle crossing the
antimeridian. Bounds keep `-180` distinct from `180`, so `{ west: -180, east:
180 }` can name the whole longitude range. All four boundaries are inclusive.

For polygons, every ring uses one open representation: at least three distinct
vertices, with no repeated closing vertex. The codec delegates every vertex to
the GeoPoint codec, then closes each ring exactly once for physical SQL. It
refuses self-intersections, repeated edges, zero-area rings, a hole outside or
touching the outer ring, and holes that touch or overlap one another. Input
winding is not semantic; the codec normalizes outer and hole directions.

The polygon owner unwraps antimeridian crossings before topology validation.
It refuses an exactly 180-degree edge, a polygon containing a pole, or a
polygon covering half the globe or more. Those shapes have complement and ring
orientation semantics that PostgreSQL and MySQL do not make portable enough
for this V1 contract. Multiple disjoint polygons use ordinary `OR`, not a
`MultiPolygon` type.

The public bounds area and the conservative prefilter derived for a distance
query consume the same trusted bounds representation. The derived path
constructs a trusted value directly; it does not feed internal numbers back
through the hostile public boundary.

`v.point({ array: true })` remains a validation-library composition only.
`s.point()` has no `.array()` in V1. The ORM does not define a second physical
GeoPoint-list language.

### 3.2 Scalar declaration

The sole factory is:

```ts
s.point()
  .nullable()
  .default({ longitude: 2.3522, latitude: 48.8566 })
  .map("location");
```

The factory takes no native type and no options. Remove `PG.POINT.POINT`,
`PG.POINT.GEOMETRY_POINT`, and `PG.POINT.GEOGRAPHY_POINT`. A native override
would let one logical scalar silently acquire a different SRID or distance
model.

A literal point default remains application-owned, as object defaults already
are. It is validated and canonicalized at declaration, but migrations do not
invent a database default expression. A function default remains
application-owned and is validated on each invocation.

### 3.3 Query language

#### Equality

Shorthand remains exact coordinate equality:

```ts
where: {
  location: { longitude: 2.3522, latitude: 48.8566 },
}
```

The explicit forms are `equals` and `not`. Equality means equal canonical
longitude and latitude, not approximate distance and not shape equality. This
definition is stable at the poles and across provider topology functions.

#### Distance predicate

Distance filtering uses the same numeric comparison vocabulary as VibORM's
other ordered values:

```ts
where: {
  location: {
    distance: {
      to: { longitude: 2.3522, latitude: 48.8566 },
      lte: 5_000,
    },
  },
}
```

The object requires `to` and at least one of `lt`, `lte`, `gt`, or `gte`.
Every comparison value is a finite non-negative number of meters. Sibling
comparisons are ANDed, so the same language expresses:

```ts
// Strictly farther than 5 km.
{ distance: { to: paris, gt: 5_000 } }

// A ring from 5 km through 10 km, inclusive.
{ distance: { to: paris, gte: 5_000, lte: 10_000 } }
```

There is no floating-point distance `equals`; point equality already owns
exact coordinate equality. A null field does not match a distance predicate.

#### Area membership

`within` tests one stored point against one explicit `GeoArea`. Bounds are the
compact viewport form:

```ts
where: {
  location: {
    within: {
      bounds: {
        south: 48.80,
        west: 2.20,
        north: 48.92,
        east: 2.48,
      },
    },
  },
}
```

`west > east` crosses the antimeridian. The compiler lowers it as the union of
two ordinary longitude intervals; callers do not split it themselves. The
exact contract is coordinate comparison, not the curved edge of a provider
geography polygon. PostgreSQL and MySQL may add a conservative spatial
prefilter when their query plan proves it useful. SQLite uses the same exact
inclusive coordinate semantics without claiming spatial-index acceleration.

An arbitrary simple geofence uses the polygon form, including optional holes:

```ts
where: {
  location: {
    within: {
      polygon: {
        outer: [northWest, northEast, southEast, southWest],
        holes: [[lakeWest, lakeNorth, lakeEast, lakeSouth]],
      },
    },
  },
}
```

The caller supplies open rings; VibORM closes and normalizes them. Polygon
membership is inclusive: a point on the outer boundary or a hole boundary
matches, while a point in a hole does not. PostgreSQL and MySQL use an
index-aware geographic point/polygon relationship. SQLite-family providers
refuse only the polygon arm before provider execution; the bounds arm remains
portable there.

The existing recursive `not` owns every inverse:

```ts
// The useful spelling of “notWithin”.
{ not: { within: { bounds } } }

// The useful spelling of “notNear”.
{ not: { distance: { to: paris, lte: 5_000 } } }
```

Do not add `notWithin`, `notNear`, `outside`, `far`, or `between`. They would
duplicate `not` or the four comparison operators. `equals`, `distance`, and
`within` compose with each other and with `not`, `AND`, `OR`, relation filters,
and variant relation filters through the current filter builders. SQL null
semantics remain deliberate: a nullable point matches neither a positive
spatial predicate nor its negation unless the caller also writes a null test.

Do not expose generic `intersects`, `contains`, `crosses`, `overlaps`,
`touches`, or `covers`. The stored value is always a point: point/area
`intersects` is the same inclusive membership already named `within`, while
the other useful topologies need stored lines or polygons. `within` accepts
exactly `GeoArea`, not arbitrary GeoJSON or a hidden generic geometry.

#### Distance selection and ordering

Generalize the existing vector `_distance` projection rather than inventing a
second computed-field mechanism:

```ts
const nearest = await db.place.findMany({
  select: {
    id: true,
    location: {
      _distance: {
        to: { longitude: 2.3522, latitude: 48.8566 },
      },
    },
  },
  orderBy: {
    location: {
      _distance: {
        to: { longitude: 2.3522, latitude: 48.8566 },
        sort: "asc",
      },
    },
  },
  take: 20,
});

nearest[0]?._distance; // number, in meters
```

The existing one-`_distance`-output-per-projection and real-field collision
rules remain. A nullable point produces `number | null`; null distance sorts
last in both directions. The same typed behavior must work at root, nested
to-one and to-many selections, variant relations, returning writes, cache
hits, and extension request/result-shape projection.

### 3.4 Distance model

V1 defines spherical distance with a fixed Earth radius of `6_371_008.8`
meters. PostgreSQL and MySQL receive that same explicit radius. This is more
portable than silently mixing PostGIS spheroid distance with a provider's
different ellipsoid implementation.

The contract is suitable for proximity search. It is not survey-grade,
routing, altitude-aware, or a promise of bit-identical floating-point answers
across engines. Tests use meter tolerances and keep threshold fixtures away
from floating-point boundaries.

### 3.5 Indexes and refused roles

The portable declaration is the existing index language:

```ts
place.index(["location"], { type: "spatial" });
```

For a GeoPoint, `spatial` means PostgreSQL GiST or MySQL SPATIAL. It is legal
only for one non-null GeoPoint field, with no `unique` or `where`. An omitted
type does not silently change meaning: `.index(["location"])` is refused and
the diagnostic asks for `type: "spatial"`. SQLite-family migrations refuse the
spatial index before effects.

The bounds arm of `within` lowers to inclusive latitude and longitude
comparisons. An antimeridian-crossing rectangle becomes two longitude
intervals joined by `OR`. A provider spatial predicate may be added only as a
conservative prefilter; it never defines the public bounds semantics.

The polygon arm lowers to the provider's inclusive geographic point/polygon
relationship over the codec's already-valid canonical rings. PostgreSQL and
MySQL query-plan controls must prove whether the declared spatial index is
considered for both area arms; SQLite makes no index claim and refuses the
polygon arm.

A non-negated distance predicate with `lt` or `lte` may use the same bounds
owner to derive a conservative, antimeridian-aware prefilter, followed by the
exact spherical-distance comparison. The prefilter may admit extra rows but
may never reject a qualifying row. A lower-bound-only predicate, a negated
upper bound, and distance ordering without an upper filter remain full
candidate scans. Users combine `distance: { lte: ... }` with `_distance`
ordering for bounded nearest-neighbor queries.

GeoPoint remains selectable and countable, but it is not legal as:

- a scalar or compound ID;
- a scalar or compound unique member;
- a foreign-key or relation-identity member;
- an ordinary, unique, partial, or compound index member;
- a field reference operand;
- a scalar `orderBy` value outside `_distance`;
- `distinct` or `groupBy`;
- `_min`, `_max`, `_sum`, or `_avg`; or
- an array/list scalar.

Refuse each role at its current owning boundary. Do not add a late query-engine
backstop for a role already excluded by operation validation.

## 4. Provider tiers and physical representation

| Provider family | Physical column | Stable tier |
| --- | --- | --- |
| PostgreSQL with PostGIS | `geography(Point,4326)` | Full GeoPoint language |
| MySQL 8 / qualified PlanetScale | `POINT SRID 4326` | Full GeoPoint language |
| SQLite / D1 / LibSQL / Bun SQLite | checked canonical JSON text | CRUD, equality, bounds, nullability, cache |
| PostgreSQL without PostGIS | none | Definition/migration refusal |

### PostgreSQL

- `postgis: true` remains the explicit driver assertion. It enables the exact
  GeoPoint protocol; it does not install `postgis` or turn on a generic geometry
  language.
- Writes use `ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography`.
- Reads project `ST_X(column::geometry)` and `ST_Y(column::geometry)` into the
  common JSON carrier.
- Bounds membership uses exact coordinate comparisons. An index-aware PostGIS
  relationship may precede them only when it is a proven conservative
  prefilter; antimeridian-crossing bounds split before SQL composition.
- Polygon membership constructs one bound geography polygon from canonical
  rings and uses boundary-inclusive `ST_Covers(polygon, point)`. No WKT built
  from caller text enters SQL.
- Distance uses `ST_DistanceSphere(column::geometry, target::geometry,
  6371008.8)`.
- Spatial indexes lower to GiST.
- Push/apply preflight proves the extension and the required functions exist
  before the first effect. Offline generation records the requirement but does
  not connect or emit `CREATE EXTENSION`.

PGlite, `pg`, postgres.js, Neon HTTP, and Bun SQL enter the full tier only when
their real provider contract loads/proves PostGIS. A boolean option without an
executed function/type proof is not qualification.

### MySQL

- Writes construct SRID 4326 points with an explicit `axis-order=long-lat`
  path. Never assume EPSG axis order from `ST_X`/`ST_Y`.
- Reads use `ST_Longitude()` and `ST_Latitude()`.
- Bounds membership uses exact longitude/latitude comparisons. An index-aware
  spatial relationship against an SRID 4326 rectangle may precede them only as
  a proven conservative prefilter. Do not use `ST_MakeEnvelope()` for that
  rectangle: MySQL refuses that function for geographic SRS values.
- Polygon membership constructs one SRID 4326 polygon from canonical rings and
  uses a boundary-inclusive point/polygon relationship. It must not depend on
  `ST_Within`, whose boundary semantics are narrower than this contract.
- Distance uses `ST_Distance_Sphere(left, right, 6371008.8)`.
- Spatial indexes emit `SPATIAL INDEX` and require the portable non-null rule.
- Introspection reads both the geometry subtype and SRS identifier, not merely
  the display type `point`.

MySQL2 is the reference provider. PlanetScale enters the same tier only after
its deterministic fixture and hosted sentinel prove the exact DDL, functions,
binds, reads, and migration convergence. Otherwise it is documented as
GeoPoint-preview rather than silently inheriting MySQL2's evidence.

### SQLite family

Store canonical JSON text under a reserved declared type that has TEXT
affinity; do not use a type name containing `POINT` because SQLite's affinity
rules would give it INTEGER affinity. Add the migration-owned CHECK that proves
an object with exactly finite numeric `longitude` and `latitude` members in the
canonical ranges.

Writes use `json_object`; reads, equality, and inclusive bounds membership use
`json_extract` through the same adapter GeoPoint protocol. Antimeridian
crossing uses the same two-longitude-interval rule as the full tier.
Introspection recognizes the reserved type and CHECK as one physical GeoPoint
column, so the second push is empty and a JSON column is not mistaken for a
point.

Do not use application-side filtering, unbounded row materialization,
SpatiaLite, SQLite Geopoly, provider-specific JavaScript functions, or optional
math builds to fake polygon or distance support. Polygon and distance arms fail
during compilation, before provider execution or cache lookup. Emulation would
create a different query engine and inconsistent pagination.

## 5. One ownership chain

```text
GeoPoint codec
  -> trusted { longitude, latitude }
  -> scalar state says only "point"
  -> GeoArea codec supplies one trusted bounds or polygon value
  -> operation schemas expose equality / distance / within / _distance
  -> query engine requests point value, coordinates, or distance
  -> adapter spells provider SQL
  -> migration driver owns physical type/index/introspection
  -> existing result projection reaches the same codec
  -> cache snapshots the canonical logical value
```

### 5.1 Validation owner

`geo-point-codec.ts` is the only interpreter of the public value. The existing
point primitive, scalar default modifier, result parser, JSON Schema converter,
and cache codec delegate to it. Delete their separate coordinate checks and
the PostgreSQL `(x,y)` text parser.

`geo-area-codec.ts` is the only interpreter of public bounds and polygons. The
`within` operation schema and the derived-distance constructor delegate to it;
no adapter or query builder redefines range, rings, holes, winding,
antimeridian, or boundary rules.

### 5.2 Adapter owner

Replace the unused broad `geospatial` object and its parallel
`supportsGeospatial` boolean with one exact adapter vocabulary:

```ts
interface GeoPointSql {
  value(longitude: Sql, latitude: Sql): Sql;
  longitude(point: Sql): Sql;
  latitude(point: Sql): Sql;
  withinBounds(point: Sql, bounds: GeoBounds): Sql;
  withinPolygon?: (point: Sql, polygon: GeoPolygon): Sql;
  distance?: (left: Sql, right: Sql) => Sql;
}
```

The shape above is illustrative; implementation may pass four already-bound
coordinate fragments instead of the trusted object when that makes parameter
ownership clearer. The invariants are:

- `geoPoint` presence proves storage, equality, and bounds support;
- `withinPolygon` presence proves polygon membership;
- `distance` presence proves distance filtering/projection/ordering;
- no parallel capability boolean exists;
- the query engine never writes `ST_*`, casts, WKT, JSON paths, or index
  syntax; and
- adapters receive already trusted coordinate values.

Construct the PostgreSQL adapter with its settled PostGIS option. Do not mutate
capabilities after construction. MySQL and SQLite install their fixed protocol
at construction.

### 5.3 Query owner

Extend `projectScalarForTransport()` so every flat field, nested relation
carrier, variant carrier, aggregate/result read, returning write, internal
refetch, and consumable-row path receives the same canonical point projection.

Extend the existing `_distance` selection/order/result aliases to distinguish
vector and GeoPoint operands from the selected scalar state. Do not add another
private carrier or parser. The `distance` filter consumes that same distance
expression. Its upper-bound prefilter consumes the trusted bounds arm, while
the public `within` predicate dispatches the already-normalized `GeoArea` to
exactly one adapter operation.

### 5.4 Migration owner

Migration drivers alone own GeoPoint DDL, spatial-index lowering, extension
requirements, catalog interpretation, and live fingerprint normalization.
Snapshots record the logical point fact once and the normalized physical
facts required to prove it. They do not store a second public SRID or distance
configuration because both are frozen constants.

## 6. Implementation program

### Unit 1 — Establish the surface baseline

1. Build and pack the current package from a clean worktree.
2. Record exact export subpaths, runtime names, declaration names, and whether
   each declaration is a type, value, or both.
3. Add public type probes for today's point, raw SQL, schema, driver, adapter,
   cache, instrumentation, validation, and migration surfaces.
4. Keep this as evidence only. The final golden is written after the cuts; do
   not auto-accept the current barrel.

### Unit 2 — Replace the point value language

1. Add the GeoPoint codec and `GeoPoint` export.
2. Change `v.point()` and `s.point()` from `{ x, y }` to
   `{ longitude, latitude }`.
3. Remove the point native-type argument and all point native constants.
4. Route defaults, JSON Schema, result parsing, and cache through the codec.
5. Pin exact hostile-input, ranges, `-180`, `-0`, fresh-output, and read-once
   behavior.
6. Add the GeoArea codec and the `GeoBounds`, `GeoPolygon`, and `GeoArea`
   exports. Pin inclusive bounds, antimeridian/whole-world bounds, open-ring
   canonicalization, holes, winding, validity, fresh output, and hostile-input
   semantics.
7. Add a scalar-language census that prevents `{x,y}`, `lat/lng`, arbitrary
   SRID, point arrays, and point native overrides from returning in shipped
   source.

### Unit 3 — Close every invalid schema and query role

1. Exclude GeoPoint from IDs, uniques, foreign keys, compound keys, ordinary
   indexes, field references, scalar ordering, distinct, groupBy, and numeric
   aggregates at the existing type owners.
2. Add the matching runtime definition/operation refusals for hostile
   JavaScript and Schema JSON.
3. Admit only the one-field non-null spatial index form.
4. Keep `_count` and ordinary selection legal.
5. Prove each refusal through the public API with typo-beside-real-key and
   non-fresh-object controls where applicable.

### Unit 4 — Install the exact adapter protocol

1. Replace the reserved generic geospatial methods and capability flag with
   the GeoPoint protocol.
2. Implement PostgreSQL/PostGIS, MySQL, and SQLite storage/equality/bounds
   projection.
3. Implement canonical polygon construction and inclusive point/polygon
   membership only on PostgreSQL/PostGIS and MySQL.
4. Implement the shared fixed-radius distance only on PostgreSQL/PostGIS and
   MySQL.
5. Lower point writes in the existing scalar value builder.
6. Lower point equality, both `within` arms, and numeric `distance` comparisons in the
   existing scalar filter builder.
7. Generalize the existing `_distance` select/order/result path.
8. Make unsupported polygon or distance work fail during compilation, before
   provider execution or cache lookup.
9. Keep verbatim raw SQL unchanged.

### Unit 5 — Add areas and spatial-indexed proximity

1. Make the GeoArea owner lower ordinary, antimeridian-crossing, degenerate,
   polar, and whole-world bounds with inclusive boundaries.
2. Validate and canonicalize simple polygons and holes once, including
   antimeridian unwrapping and the portable half-globe/pole refusals.
3. Make each full-tier adapter construct the same canonical polygon without
   concatenating caller strings, and use an inclusive point/polygon predicate.
4. Use the bounds representation to derive conservative bounds for a spherical
   distance upper limit, including zero radius and a radius covering the world.
5. Emit the provider bounds predicate before the exact distance comparison only
   where Boolean polarity makes the prefilter valid.
6. Prove with adversarial coordinates that the prefilter never creates a false
   negative and that negation never reuses it incorrectly.
7. Pin PostgreSQL and MySQL query plans for bounds, polygon, and bounded
   distance queries. If a provider cannot use the declared spatial index,
   document that provider's limitation rather than claim acceleration.

### Unit 6 — Finish migrations and push

1. Emit `geography(Point,4326)`, `POINT SRID 4326`, and the reserved SQLite
   JSON-text form.
2. Lower `type: "spatial"` to GiST or SPATIAL and refuse it on SQLite.
3. Add PostGIS preflight without extension installation.
4. Introspect exact subtype, SRID, nullability, index kind, and SQLite marker.
5. Normalize catalog aliases in the current live-fingerprint owner.
6. Cover create, add, drop, rename/map, nullable changes, spatial-index changes,
   point-to-non-point transitions, and namespace qualification.
7. Keep generated SQL, authenticated SQL blobs, dispatches, and migration
   state semantics unchanged.
8. Prove second push empty and generated-estate apply/verify/down/reset on each
   full provider family.

### Unit 7 — Execute provider qualification

Run one shared GeoPoint behavior contract for:

- PGlite with a real PostGIS extension;
- `pg` and postgres.js against Docker PostGIS;
- MySQL2 against Docker MySQL 8;
- SQLite3, LibSQL, Bun SQLite, and D1 at the
  storage/equality/bounds tier;
- Neon HTTP and PlanetScale when hosted credentials exist; and
- Bun SQL under Bun, not a Node stand-in.

The contract covers direct, prepared, callback transaction, array transaction,
fallback batch, native batch, createMany, returning, nested relation JSON,
variant relations, bounds, canonical polygons with holes, cache, extensions,
and raw-boundary controls. A provider without executed evidence receives a
narrower documented tier.

### Unit 8 — Cut the remaining public API

Remove the confirmed pre-V1 and implementation-only surfaces:

1. Delete string overloads, warning state, and runtime compatibility from safe
   `$queryRaw` and `$executeRaw`. Keep tagged `Sql` and the explicitly unsafe
   string methods.
2. Delete `QueryMetadata`. Keep the documented public `PendingOperation`, but
   remove undocumented root `RawQueryResult` and `ResultParser` exports.
3. Narrow `viborm/cache` to `cache`, its public configuration/value types,
   `CacheDriver`, `CacheEntry`, and the driver-author contract. Delete legacy
   key helpers, schema instances, internal execution types, `parseTTL`, and the
   public memory-cache clock seam.
4. Export only `createFsStorageWriter` from
   `viborm/migrations/storage/fs`; keep the implementation class private.
5. Remove dead instrumentation span names and `ATTR_CACHE_KEY`. Retain and
   document only telemetry vocabulary the official extension actually emits.
6. Remove `LogFunction` and public `TransactionBoundDriver`; retain the custom
   transport contracts users genuinely need.
7. Keep `validateSchema`, `validateSchemaOrThrow`, result/error types, and make
   the throwing function return `void`. Keep `SchemaValidator`, custom
   `ValidationRule`, and `ResolvedRelationIndex` internal.
8. Replace `viborm/schema`'s star-like advanced surface with an explicit list.
   Remove hydration mutators and raw `ModelState`/`RelationState` carriers.
9. Remove the historical generic from public `OperationResult`; keep richer
   machinery internal.
10. Remove the obsolete adapter error hierarchy and every `export *` from
    `viborm/adapters`. Retain exactly `DatabaseAdapter`, `PostgresAdapter`,
    `MySQLAdapter`, `SQLiteAdapter`, `postgresAdapter`, `mysqlAdapter`, and
    `sqliteAdapter`. Move batch-reference and query-part seams behind internal
    symbol-keyed access so they are not part of the adapter subclass contract.
    The retained adapter contract, including GeoPoint SQL, gets a packed
    external-subclass fixture and complete documentation.
11. Retain from `viborm/driver` the base `Driver`, `AnyDriver`,
    `DriverResultParser`, `QueryExecutionContext`, `BatchQuery`, `Dialect`,
    `QueryResult`, and the documented driver-facing errors. These are the
    minimum custom-transport contract. Do not expose transaction-bound driver
    construction or logging remnants.

Migration V1's resolver presets, storage contract, conformance suite, memory
and object-store implementations, result types, and `MigrationTarget` remain
public. Do not repeat the already completed migration cut.

### Unit 9 — Freeze the package

Check in one manually reviewed public-surface manifest. It contains:

- exact `package.json` export subpaths;
- exact runtime names for each subpath;
- exact declaration names and kind (`type`, `value`, or both);
- exact `s` factory keys and public client capability keys; and
- explicit absences for retired compatibility and internal-only entry points.

`pnpm test:package` must build and pack first, install the tarball into fresh
consumer fixtures, inspect runtime modules, and use the TypeScript compiler API
against emitted `.d.mts` files. It must not derive expected values from source
barrels, current `package.json.exports`, or an old `dist` directory. Additions,
removals, and type/value-kind changes fail until a maintainer edits the reviewed
manifest.

### Unit 10 — Documentation and elegance pass

1. Add a complete GeoPoint scalar page with values, GeoArea bounds and polygon
   examples, holes and polygon limits, distance comparisons, distance
   projection/order, indexes, provider tiers, limitations, and raw physical
   forms.
2. Update scalar, filtering, sorting, migration, provider, native-type, cache,
   Schema JSON, and compatibility pages.
3. Delete claims that point is experimental, absent from `s`, PostgreSQL
   built-in `point`, arbitrary PostGIS geometry, or universally spatial on
   SQLite.
4. Document every retained package subpath and remove pages for deleted
   symbols.
5. Update applicable `AGENTS.md` files with the codec, adapter, migration, and
   provider-tier owners.
6. Run an `ELEGANCE.md` pass that proves there is one GeoPoint codec, one
   GeoArea codec, one adapter vocabulary, one distance computation path, one
   area representation, one migration physical owner, and one package golden.
   Delete every superseded point and generic-geospatial path in the same
   change.

## 7. Public contract changes

### Added or stabilized

- `GeoPoint` with exact `{ longitude, latitude }` fields.
- `GeoBounds` with exact `{ south, west, north, east }` fields.
- `GeoPolygon` with one outer ring and optional hole rings.
- `GeoArea` as the exact `{ bounds } | { polygon }` query operand.
- `s.point()` as fixed EPSG:4326 geography.
- point `distance` filtering with `lt`, `lte`, `gt`, and `gte` in meters.
- inclusive point `within` filtering over ordinary/antimeridian bounds and
  valid polygons with holes.
- point `_distance` selection and ordering in meters.
- portable `type: "spatial"` for one non-null point field.
- complete provider-tier and migration contracts.

### Removed

- `{ x, y }` point values and PostgreSQL point-text results.
- point native-type arguments and all `PG.POINT.*` constants.
- generic geospatial/PostGIS predicate promises outside the point language.
- point arrays in the ORM scalar language.
- every invalid point role listed in section 3.5.
- safe raw string compatibility.
- `QueryMetadata` and the other confirmed leaked symbols in Unit 8.

No compatibility alias, coercion, deprecation window, or migration conversion
is added.

## 8. Focused falsifiers

### Value boundary

- canonical equator, poles, date line, `-180 -> 180`, and `-0 -> 0`;
- NaN, infinities, out-of-range latitude/longitude, missing/extra/inherited
  keys, arrays, tuples, WKT, GeoJSON, accessors, proxies, revoked proxies, and
  throwing enumeration;
- one read per hostile property and fresh public outputs;
- literal/function defaults, nullable values, Schema JSON, cache hits, and
  nested/variant result graphs.

### Types and operation validation

- root/nested/variant create, update, createMany, updateMany, upsert, returning,
  select, equality, recursive negation, bounds membership, distance comparison,
  distance select, and distance order;
- exact `GeoBounds` keys and ranges, inclusive edges, `south <= north`,
  ordinary/antimeridian/whole-world longitude spans, and hostile property
  access;
- exact `GeoArea` discrimination; open polygon rings; three-vertex minimum;
  holes; winding normalization; antimeridian unwrapping; and refusals for
  closure duplication, self-intersection, repeated/zero-area edges, invalid
  holes, poles, exactly-180-degree edges, and half-globe-or-larger polygons;
- distance filters with each comparator, upper/lower pairs, missing comparator,
  negative/non-finite operands, and multiple sibling point predicates;
- `not: { within: ... }` and `not: { distance: ... }` are legal while
  `notWithin`, `notNear`, `far`, and `between` are absent through the public
  call surface;
- point refusals in IDs, unique, FK, compound keys, indexes, field refs,
  ordinary order, distinct, groupBy, and numeric aggregates;
- fresh and non-fresh objects, typo beside a real key, and direct hostile
  JavaScript calls;
- nullable distance result type and `_distance` output collision.

### SQL and providers

- longitude/latitude are never swapped, including MySQL EPSG axis order;
- fixed SRID and fixed radius appear through adapter-owned SQL only;
- equality, zero distance, Paris/London and date-line controls agree within
  declared meter tolerance;
- strict/inclusive distance boundaries, distance bands, null behavior,
  antimeridian, polar cap, and whole-world upper distance;
- inclusive bounds edges, a degenerate bound, whole-world bounds, and both
  antimeridian arms agree on PostgreSQL, MySQL, and SQLite;
- polygon interior, outer boundary, hole exterior, hole boundary,
  antimeridian-crossing polygon, normalized reverse winding, and malformed
  polygon results agree on PostgreSQL and MySQL;
- malformed provider point rows fail before partial result mutation;
- SQLite bounds compile and execute, while SQLite polygon and distance
  operations produce zero provider calls;
- indexed bounds, polygon, and upper-bounded distance `EXPLAIN` controls on
  PostgreSQL and MySQL, with lower-only and negated controls not falsely
  claimed as accelerated;
- tagged raw remains typed and unsafe raw remains physical.

### Migrations

- physical type, SRID, subtype, nullability, spatial index, SQLite CHECK, and
  namespace round trips;
- missing PostGIS refusal before effects;
- wrong SRID, Cartesian PostgreSQL point, geometry instead of geography,
  unrestricted MySQL point, and generic SQLite JSON all produce a real diff;
- generate/apply/verify/down/reset and second-push-empty;
- authenticated migration bytes and dispatch identity remain unchanged.

### Public package

- every expected subpath and name imports from a packed tarball;
- every removed name fails both runtime and TypeScript import;
- type/value-kind changes fail the golden;
- no emitted declaration contains an unadjudicated `@deprecated`,
  `historical`, point alias, or internal relation-resolution type.

## 9. Sequential validation gates

Run coordinators sequentially because the workspace lock forbids overlap.

1. Focused GeoPoint/GeoArea codec, scalar, operation-schema, SQL, result,
   cache, migration, public-type, census, and package-golden tests.
2. `pnpm test:layer:validation`
3. `pnpm test:coverage:schema`
4. `pnpm test:layer:schema-validation`
5. `pnpm test:layer:query-engine`
6. `pnpm test:layer:adapters`
7. `pnpm test:layer:drivers`
8. `pnpm test:layer:client`
9. `pnpm test:layer:cache`
10. `pnpm test:layer:migrations`
11. Relevant schema, validation, cache, migration, and write-engine coverage
    gates.
12. `pnpm test:types`, with zero TS2589/TS2590 and deterministic
    instantiations no more than 5% above baseline.
13. Repository-pinned Biome on every touched TypeScript file and
    `git diff --check`.
14. `pnpm --dir docs validate` plus executable GeoPoint examples.
15. `pnpm package:build` and `pnpm test:package` from a clean package build.
16. PGlite/PostGIS, Docker PostgreSQL/PostGIS, MySQL2, SQLite3, LibSQL, D1,
    Bun SQLite, and Bun SQL contracts.
17. Hosted Neon and PlanetScale contracts when credentials exist; otherwise
    record the exact skip and retain the narrower tier.
18. `pnpm test:core`
19. `pnpm test:all`
20. `pnpm test:providers`
21. Five alternating fresh-process controls for ordinary scalar read/write and
    1,000-row non-point reads. No non-point regression above 3% and `2xMAD`;
    report GeoPoint cost separately.
22. Final public-manifest review and `ELEGANCE.md` owner census.

## 10. Completion checklist

- [ ] `GeoPoint` is the only public point value and `GeoArea` is the only public
      area operand, with exactly `GeoBounds` and `GeoPolygon` variants.
- [ ] The public language fixes EPSG:4326, coordinate names, ranges, and meters.
- [ ] PostgreSQL stores geography, not built-in point or generic geometry.
- [ ] MySQL stores an SRID-restricted geographic point with correct axis order.
- [ ] SQLite storage, equality, and bounds membership are exact; polygon and
      distance support are refused honestly.
- [ ] Equality, `within`, numeric distance filtering, distance selection,
      distance ordering, and spatial indexes work on the full tier.
- [ ] Every invalid point role fails at its rightful owner.
- [ ] One GeoPoint codec, one GeoArea codec, and one adapter protocol replaced
      all point/geospatial twins.
- [ ] Migration introspection and second push converge on all admitted tiers.
- [ ] The provider matrix distinguishes executed evidence from family
      inference.
- [ ] Every confirmed pre-V1 export leak is removed.
- [ ] The packed package matches the reviewed golden exactly.
- [ ] Active documentation and `AGENTS.md` name only the final owners.
- [ ] No legacy and replacement path coexist.

## Sources

Primary references used for the contract:

- [PostGIS `ST_Point`](https://postgis.net/docs/ST_Point.html) — geodetic X is
  longitude, Y is latitude, and SRID 4326 point construction.
- [PostGIS geography introduction](https://postgis.net/workshops/postgis-intro/geography.html)
  — geography distance is measured over the Earth and reported in meters.
- [PostGIS `ST_DistanceSphere`](https://postgis.net/docs/ST_DistanceSphere.html)
  — spherical point distance and explicit radius.
- [PostGIS `ST_DWithin`](https://postgis.net/docs/ST_DWithin.html) — geography
  radius semantics and index-assisted filtering background.
- [PostGIS `ST_Covers`](https://postgis.net/docs/ST_Covers.html) — inclusive
  interior-or-boundary membership and automatic spatial-index bounding checks.
- [PostGIS `ST_IsValid`](http://postgis.net/docs//ST_IsValid.html) — OGC
  polygon validity and self-intersection refusal.
- [PostGIS spatial queries](https://postgis.net/docs/using_postgis_query.html)
  — index-aware relationship predicates and distance predicates.
- [MySQL point property functions](https://dev.mysql.com/doc/refman/8.4/en/gis-point-property-functions.html)
  — `ST_Longitude`, `ST_Latitude`, geographic ranges, and SRS axis order.
- [MySQL spatial relation functions](https://dev.mysql.com/doc/refman/8.4/en/spatial-relation-functions-object-shapes.html)
  — geographic relationship, distance, and equality behavior.
- [MySQL spatial function reference](https://dev.mysql.com/doc/refman/8.4/en/spatial-function-reference.html)
  — `ST_Within`, minimum-bounding-rectangle coverage functions, and the
  supported common spatial vocabulary.
- [MySQL polygon class](https://dev.mysql.com/doc/refman/8.3/en/gis-class-polygon.html)
  — one exterior ring, interior rings as holes, and simple-polygon rules.
- [MySQL geometry well-formedness and validity](https://dev.mysql.com/doc/refman/8.3/en/geometry-well-formedness-validity.html)
  — ring closure, minimum ring size, self-intersection, and hole validity.
- [MySQL spatial convenience functions](https://dev.mysql.com/doc/refman/8.4/en/spatial-convenience-functions.html)
  — `ST_Distance_Sphere`, meters, coordinate ranges, explicit radius, and the
  refusal of `ST_MakeEnvelope` for geographic SRS values.
- [MySQL spatial columns](https://dev.mysql.com/doc/refman/8.4/en/creating-spatial-columns.html)
  — SRID-restricted physical columns.
- [MySQL spatial index optimization](https://dev.mysql.com/doc/refman/8.4/en/spatial-index-optimization.html)
  — SRID and spatial-index requirements.
- [PlanetScale geospatial MySQL guide](https://planetscale.com/blog/geospatial-features-mysql)
  — PlanetScale/Vitess point, distance, SRID, and spatial-index evidence to be
  confirmed by the provider contract.
- [SQLite type affinity](https://www.sqlite.org/datatype3.html) — declared type
  names and affinity rules.
- [SQLite JSON functions](https://sqlite.org/json1.html) — canonical JSON
  storage and extraction.
- [Cloudflare D1 supported SQLite extensions](https://developers.cloudflare.com/d1/sql-api/sql-statements/)
  — the boundary for D1's distance-free tier.

Search result archives:

- `/tmp/viborm-geopoint-postgis.json`
- `/tmp/viborm-geopoint-postgis-ops.json`
- `/tmp/viborm-geopoint-postgis-index.json`
- `/tmp/viborm-geopoint-postgis-radius-version.json`
- `/tmp/viborm-geopoint-mysql84.json`
- `/tmp/viborm-geopoint-mysql-coordinates.json`
- `/tmp/viborm-geopoint-mysql-index.json`
- `/tmp/viborm-geopoint-intersection.json`
- `/tmp/viborm-geopoint-planetscale-current.json`
- `/tmp/viborm-geopoint-sqlite.json`
- `/tmp/viborm-geopoint-sphere-model.json`
- `/tmp/viborm-geopoint-filter-api.json`
- `/tmp/viborm-geopoint-mysql-within.json`
- `/tmp/viborm-geopoint-polygon-common.json`
- `/tmp/viborm-mysql-geopolygon-contract.json`
