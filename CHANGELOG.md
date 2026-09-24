# Changelog

All notable changes to VibORM are recorded here. Releases follow Semantic
Versioning.

## Unreleased

- **Behaviour change on batch-only drivers: `createMany` with `skipDuplicates`
  warns and runs instead of refusing.** Where no savepoint can isolate one
  member — D1 Workers bindings, Neon HTTP, a native array batch, and a member of
  an array `$transaction([...])` — a `createMany` with `skipDuplicates` that is
  relation-bearing, or nested under another `create`/`update` (many-to-many
  included), used to throw `TransactionError` (`V5001`) before any write. It
  now runs **without** `skipDuplicates` and warns once per client and model —
  on the `warning` log channel when logging routes warnings (the sentence in
  `meta.notice`), with `console.warn` otherwise: `createMany skipDuplicates
  cannot skip rows involving nested writes on driver "d1" (no savepoint
  available) in post.createMany; running without skipDuplicates — a duplicate
  will fail with a unique-constraint error.` A duplicate then fails with the
  ordinary `UniqueConstraintError`, and rows an earlier batch committed stay
  committed, exactly as for the same call without `skipDuplicates`. A root
  scalar `createMany` with `skipDuplicates` is unchanged (it skips in SQL),
  except on MySQL inside an array `$transaction([...])`, whose per-row skip
  needs a savepoint: it too now runs without the flag and warns instead of
  refusing. Interactive drivers keep skipping inside a savepoint.
- **Recursive relation projections.** A self-relation's node — `parent`,
  `children`, a proven one-to-one inverse or a paired junction graph — takes
  `recurse` in `select` and `include`: `true`/`{}` follow the relation to depth
  100, `{ depth: n }` to `n` levels (1–1000), `{ depth: false }` exhaustively;
  a junction graph prunes cycles path-locally by default and may unfold them
  with `{ preventCycles: false }` under a bounded depth, while a foreign-key
  cycle inside the traversed window is an error. The node's own projection
  repeats at every level, filters prune every hop, each level keeps its
  `orderBy`, and the repeated key is absent at a numeric cutoff and present
  (`[]` or `null`) where the data ends. One provider statement serves any
  depth; the result composes with the cache, `omit`, extensions, arrays and
  callback transactions like any other relation projection, and
  `renderOperationResultType` renders a recursive result as named declarations.
  Output grows with paths, not rows: a graph can return exponentially more
  occurrences than it stores, even with cycle prevention, so depth 100 is not a
  size bound. Executed locally on SQLite, PGlite, native PostgreSQL 16 and
  native MySQL 8.4 (the placement matrix and the hierarchy and graph worlds on
  all four; the composition matrix on SQLite; 300 generated cases each on
  SQLite, native PostgreSQL and native MySQL); hosted providers are not yet
  qualified. Where the provider spells `LATERAL` the carrier's recursive CTE
  lives in a lateral derived table, because MySQL materializes a correlated
  CTE that is read twice once per statement. Providers cap exhaustive
  traversals with their own limits: MySQL's `cte_max_recursion_depth` surfaces
  as the provider's error (errno 3636), never as a truncated result. The
  output key `_distance` has one producer: a relation named `_distance`
  (recursive or not) cannot be projected beside a point's distance, in either
  order — the refusal a scalar of that name already met.
- **A connection must be representable.** An explicit `connect`, and the found
  and the create arm of `connectOrCreate`, establish a relation by writing the
  value the target holds for the referenced field. Every component that
  connection needs must be present and non-NULL. A target whose
  referenced field reads NULL cannot establish the requested relation, so the
  write is refused — `NestedWriteError`, naming the relation and the field —
  instead of writing that NULL and silently disconnecting the holder from
  whatever it pointed at. One requirement covers both directions (a parent-held
  edge and a child-held one), found and produced values, and single and compound
  references; it is checked before the connection is consumed, so nothing is
  written and then discovered. Ordinary nullable scalar writes, an explicit
  `disconnect`, and a NULL field that is not part of the consumed reference are
  unaffected, and a model declaring a nullable referenced unique is not itself
  refused.
- **A selected bulk mutation carries its selector to the
  effect.** An `updateMany` or `deleteMany` that captures an identity set and
  then consumes it sends BOTH the complete captured identity set and that
  statement's original prepared selector in the consuming statement. A row that
  stopped matching the selector between the capture and the effect is therefore
  not mutated, on the batch route as on the interactive one, and the existing
  `selected-row cardinality changed` error is the answer when fewer rows are
  affected than were captured. Failure and commit stay separate facts: on an
  operation-owned interactive transaction its owner rolls back; on an already
  acknowledged atomic batch the acknowledged effects and the result-phase
  failure are both reported truthfully — a check after dispatch cannot undo that
  batch and does not claim to. Compound and mapped keys, `limit` and the
  zero-result answer are unchanged.
  A nested captured series is BOUNDED in the same spirit: the initial filter
  selects the worklist ONCE, and a qualifying row that joins after that boundary
  is not adopted into it. The filter is not re-evaluated before every member —
  an earlier member may legally change the facts a later one was selected by —
  but the actual identity, parent and relation-membership requirements are still
  enforced where they always were, so a member that loses or changes its
  membership is still not consumed. `FOR UPDATE` locks rows; it does not exclude
  phantoms, and nothing here claims otherwise.
- **Native MySQL is part of local release qualification.**
  The `mysql2` driver is qualified against a local MySQL 8.4 — schema push and
  re-push, the migration and namespace boundaries, the read and nested-write
  inventory, and concurrency — rather than inheriting its status from shared
  transport code. A database-selected deadlock victim is a FAILED transaction:
  it is reported as the provider failure it is, with no committed victim
  effects, and it is never treated as an eligible unique-key race or silently
  replayed. The recoverable unique-key race that `upsert` and `connectOrCreate`
  already converge under is unchanged. Hosted MySQL (PlanetScale) qualification
  remains deferred.

- Prepare the V1 release and publication system.
- **The query engine is replaced.** Raptor 3 (the name that appears in some
  engine error messages) is now the only engine behind the public client API,
  which is unchanged: every operation, filter, nested
  write, transaction form and result shape is the same, and the differences
  the cutover surfaced were repaired to the old engine's answers or ruled and
  documented one by one. What changed at the adapter and driver contracts is
  listed below. Every refusal the engine raises is a documented sentence, and
  the sentences fall into three kinds that are easy to confuse:

    - **An invalid request.** The operation asked for something the data cannot
      represent — a connection whose reference value is NULL, a `_distance`
      selection beside a field of that name. Nothing is written; correcting the
      request is the whole remedy.
    - **An operational database failure.** The provider refused the work or
      aborted the transaction — a deadlock victim, a constraint violation, a
      driver that answered a malformed or missing result. The driver normalizes
      it; it is a fact about that run, not a limit of the ORM, and the same
      request can succeed on the next one.
    - **A capability refusal.** The engine will not do this here — building a
      write to one SQL statement, a generated non-increment key on a transport
      with no interactive transaction. This one names a boundary that will not
      move by retrying.

  A failed internal invariant is none of the three: it is thrown as an
  `EngineInvariantError`, carries no `V####` code, and is a defect to report.
  Counting sentences does not measure any of this. The three kinds above are
  this changelog's own reading of what a failure means to a caller; the census
  (`scripts/raptor3-refusal-census.mjs`) separates a different three by
  construction — invariants, private-fit internals and refusals — and reports
  23 distinct candidate sentences this engine spells that the previous one did
  not: a count of SENTENCES, not of operations you can no longer perform, and
  not a coverage figure. What the engine does and does not support is the
  behavioural inventory's fact, one row per admitted fact.
- `DatabaseAdapter["expressions"]["integerDivide"](left, right)` is a
  **required** adapter member: the portable integer quotient the engine uses when it has to state in SQL
  the value an integer or bigint column will hold after a `{ divide }` (PostgreSQL integer
  division, `TRUNCATE(a / b, 0)` on MySQL, `a / CAST(b AS INTEGER)` on SQLite).
  A third-party adapter must add it; this is a compile-time change for adapter
  authors and invisible to client code.
- `PendingOperation.buildStatement()` (and the engine's internal
  `QueryEngine.build()`, which backs it) answers the one SQL statement a
  **read** compiles to, taken from the prepared read the execution itself
  runs. Every write now answers the `does not compile to one SQL statement`
  refusal — including a write the previous engine could fold into a single
  statement, such as a scalar `delete` on a driver with `RETURNING`. Run the
  operation instead of building it.
- A nested write that must observe its own earlier writes — a member that
  reads a row an earlier member wrote, a series of dependent members — now
  runs on a **batch-only** transport that keeps no session between requests
  (Neon HTTP, D1) as a succession of atomic batches, each committing as it
  completes. A key the database generated in one batch is read back at the
  end of that batch and carried into the next as a literal, so such a write
  no longer fails with a bare provider error once its first batch has
  committed. This is verified on a batch-only fixture that keeps no session
  between requests; the live Neon suite is credential-gated on
  `NEON_TEST_DATABASE_URL` and was not run for this release, and the D1 driver
  is exercised on the Workers runtime's own local D1 and on no hosted
  Cloudflare D1. A failure in a later batch leaves the earlier batches committed,
  and the error says so (`atomicity: "segment"`, `committedSegments`). Nothing
  changes on a transport with an interactive transaction, where the whole
  write is one transaction.
- The transport facts each driver guarantees for a nested write — how it runs,
  what a mid-way failure leaves behind and how it is reported, the bind
  capacity per statement, and which of these are verified live — are stated
  per driver in the [drivers overview](/docs/drivers)
  under "Nested writes and failures per driver".
- The SQLite drivers (`sqlite3`, `bun-sqlite`, `d1`, `libsql`) no longer
  normalize `count`/`exist` results in their driver-level `parseResult`
  middleware. The query engine's decoder owns the meaning of a count and an
  exists answer — it asks for its own `_count` alias and reads it back — so
  those answers are unchanged on every SQLite driver. The
  `DriverResultParser.parseResult` contract itself is untouched: a consumer
  that wrapped `driver.result.parseResult` is still asked once per operation
  with the provider's raw result, and is unaffected in outcome. The shipped
  `parseResult` function itself no longer exists on those drivers: a wrapper
  that captured it before installing its own must check for its absence
  before calling it.
- The MySQL adapter no longer normalizes `count`/`exist` results in its
  adapter-level `parseResult`. The query engine's decoder owns the meaning of a
  count and an exists answer — it asks for its own `_count` alias and reads it
  back, and a count carried under any other column was refused before this
  deletion exactly as it is after it — so those answers are unchanged, on the
  live route and inside `$transaction([…])`.
- The PostgreSQL adapter no longer converts a bigint in its adapter-level
  `parseResult`. That leg was offered the operation's row array rather than a
  value, and an integer's width is owned by the query engine's own scalar
  codec, which turns a bigint or an integer text into a number and refuses one
  outside the safe integer range. Count answers are unchanged on both the `pg`
  and the `postgres.js` transport.
- `DatabaseAdapter["result"]["parseResult"]` is untouched: it remains a
  required member, still asked once per operation with the provider's raw
  result, and on all three shipped adapters it is now the pass-through the
  SQLite adapter has always installed.
- A nested write under a parent with a generated increment key now runs on a
  PostgreSQL-family transport that has no callback transaction (Neon HTTP, a
  batch-only PGlite) as one native batch: the parent's INSERT is a
  data-modifying CTE whose own RETURNING stores the key in the batch
  reference table, and every later statement of the same batch reads it back. Such writes were
  refused before ("Raptor 3 G1 atomic output requires exact identity scratch
  or segmented RETURNING"). A generated key that is not an increment key on
  such a transport keeps that refusal.
- The batch reference contract (`@internal` `BatchReferenceSqlAdapter`) gains
  an optional `storeReturning(batchId, key, insert, column)`, present on the
  PostgreSQL adapter; the PostgreSQL batch reference table is no longer
  declared `ON COMMIT DROP`, so the table survives the batch that created it;
  each dispatched batch makes its own reference rows and drops them at its own
  end. The logical `CastType` gains `"bigint"` (`BIGINT` on
  PostgreSQL, the 64-bit integer cast the other dialects already had), so a
  `bigint` increment key is read back at its own width.

### Decimal (breaking)

A decimal field admits `Decimal | string`. A JavaScript `number` is a double
rather than an exact decimal, so it is refused at every decimal position —
create and update values, `increment`/`decrement`/`multiply`/`divide`,
`push`/`unshift`, every filter operand, `having` operands, cursors and unique
lookups — with one issue: `Expected an exact decimal: a Decimal or a string
like '-12.345' (sign, digits, at most one dot, no exponent); a JavaScript
number is a double and is not accepted`. The keys, the nullable arms and the
operand forms (literal, field reference, SQL fragment, callback) do not move;
only the literal narrows, and the input types drop `number`. Write
`{ total: "0.3" }`, not `{ total: 0.3 }`.

- `new Decimal(value)` takes a `Decimal`, a string, or a whole `bigint`
  (`new Decimal(5n)` is `5`); a number throws `TypeError`. The arithmetic and
  comparison methods take the same arguments, so `total.plus("1")` rather than
  `total.plus(1)`.
- The `String(number)` rule and the documented `0.1 + 0.2` case are gone with
  it: there is no double to spell.
- The input JSON Schema of a decimal is the string alone
  (`{ type: "string", pattern }`, with the domain in `description`); the
  `{ type: "number" }` arm is gone, so a document generated from it no longer
  describes values the validator refuses.
- A schema document's decimal default written as a JSON number (`"default":
  1.5`, or a number member of a list default) is refused with `J008`; write
  the string `"1.5"`. An invalid `precision`/`scale` in a document reports the
  per-key sentence below under `J010`.
- `s.decimal({ precision, scale })` reads its argument as the developer's own
  code. Each bad bound has one sentence at its key —
  `'precision' must be an integer between 1 and the maximum safe integer` at
  `descriptor.precision`, `'scale' must be an integer between 0 and precision`
  at `descriptor.scale` — replacing the five earlier messages. A missing or
  non-object argument (untyped JavaScript) now reports the `precision`
  sentence at `descriptor.precision` instead of
  `A decimal must declare { precision, scale }` at `descriptor`. Extra,
  inherited, symbol and non-enumerable keys are ignored at runtime (the types
  still refuse extra keys), and a throwing getter or a revoked proxy throws its
  own error instead of a `ValidationError`.
- `.default(x)` checks the default against the field's own schema and reports
  one sentence, `The decimal default did not satisfy its field schema`, in
  place of the list-specific messages (`must be an array`, `dense array with
  no shadow properties`, `Could not snapshot`). Extra properties on a list
  default are dropped rather than refused. A custom `.schema()` that throws, or
  that returns a non-object result such as `null`, lets that error (a
  `TypeError` for `null`) escape `.default()` instead of `The decimal field
  schema failed while validating its default`. The check is still eager, at
  `.default()`, `.array()` and `.schema()`.

### Geo: a geographic value is validated as the record VibORM returns (breaking for refusal wording and polygon admission)

A `GeoPoint`, `GeoBounds` or `GeoArea` argument is now read by the same record
walker as every other object operand, not by a bespoke reader. For points and
bounds the accepted values are unchanged for ordinary input; what changes is
the posture toward unusual objects and the wording of refusals. Polygons are
checked for their shape first and their geometry second; the geometry refused
is what the databases were measured to answer wrongly or differently.

- Refusals name the key: `{ longitude, latitude, latitdue }` fails with
  `Unknown key: latitdue` at path `latitdue` (was `Expected GeoPoint with
  exactly longitude and latitude`), a missing coordinate fails with
  `Missing required field: latitude`, a non-object with `Expected object`
  (was `Expected GeoPoint object`), and a non-finite coordinate with
  `Expected finite number` (was `Expected finite longitude`). Range messages
  are unchanged. Unknown-key and missing-key refusals now point at the key:
  `data.location.extra` and `data.location.longitude` where the path was
  `data.location`; an object without the coordinates, such as a `Date` or a
  `Map`, also fails at `data.location.longitude`.
- Bounds and areas follow the same rule: `{ bounds: { …, nort: 49 } }` fails
  with `Unknown key: nort` at `bounds.nort` (was `Expected GeoBounds with
  exactly south and west and north and east`), `{ bounds, extra }` with
  `Unknown key: extra`, and a bounds coordinate out of range with
  `Latitude must be between -90 and 90` or `Longitude must be between -180 and
  180` (was `south must be between -90 and 90`, and so on; paths unchanged).
  `GeoBounds south must be less than or equal to north` and `Expected GeoArea
  with exactly one of bounds or polygon` are kept word for word, but an area
  carrying both variants where one is itself invalid now reports that
  variant's refusal (for example the `south`/`north` message at
  `bounds.south`) instead of the exactly-one message.
- An area spelled `{ bounds: undefined, polygon }` is now the polygon area: an
  explicit `undefined` is an absent key, as everywhere else.
- Newly accepted: an inherited enumerable coordinate, a class instance, and an
  object carrying extra symbol or non-enumerable keys; the walker reads
  enumerable string keys only, as it does for every other argument.
- A getter or proxy trap that throws while a point is read surfaces as a
  validation issue carrying the thrown cause (through `parse` and every
  operation boundary) instead of the former `Could not read …` message; in an
  operation it is reported at `root` as `Schema validation failed
  unexpectedly` where the path named the coordinate. A direct call of a geo
  validator, and `v.point()["~standard"].validate`, now let the throw
  propagate, as every other `v.object` schema already did, and so does `s.point().default(…)`, whose value is the
  developer's own declaration: a throwing getter there is that raw error at
  declaration time instead of a `ValidationError`.
- A `GeoPolygon` is checked for its shape first: exactly `outer` and optional
  `holes`, finite in-range vertices, at least three vertices per ring
  (`A GeoPolygon ring needs at least 3 vertices`, kept), all reported by the
  record walker. Its geometry is checked second, against what PostgreSQL and
  MySQL actually answer. Measured with VibORM's own predicates on PostGIS 3.6.2
  and MySQL 8, PostGIS raises only for an edge between antipodal endpoints
  and answers every other malformed polygon silently: a hole
  reaching outside the outer ring adds its own area, a point inside two holes
  matches, a bowtie matches both lobes, a ring covering half the globe means
  opposite regions on the two databases, and MySQL answers a pole vertex with
  the equator and the opposite pole. Those polygons are refused at admission,
  the same on every dialect, with the pre-D2 messages word for word: `A
  GeoPolygon ring cannot self-intersect` (a crossing or touching ring,
  including one that repeats a vertex further on or goes past a whole turn
  over itself), `A GeoPolygon ring must have non-zero area`, `A GeoPolygon
  edge cannot span exactly 180 degrees` and `A GeoPolygon ring cannot contain
  a pole`, `A GeoPolygon cannot contain a pole` (a ring winding around one),
  `A GeoPolygon hole must be strictly inside its outer ring` and `GeoPolygon
  holes cannot touch or overlap`. Each is reported at its ring (`outer` or
  `holes.<i>`), except the edge and pole-vertex refusals (`cannot span
  exactly 180 degrees`, `must be shorter than 150 degrees`, `ring cannot
  contain a pole`), reported at the offending vertex (`outer.<j>` or
  `holes.<i>.<j>`, the vertex ending the edge).
- The geometry reads each edge as PostgreSQL does, as the great-circle arc
  between its vertices on the sphere, not as a straight line of longitude and
  latitude. MySQL reads the edge on the ellipsoid instead: its edge leaves the
  arc by at most 0.0007 degrees (about 75 m) on a 10-degree edge, 0.007 at 30,
  0.019 at 60, 0.075 at 90, 0.17 at 120 and 0.46 at 150 (30 random edges per
  length, measured by bisection), none along the equator or a meridian, so
  points within that band beside an edge can be answered differently by the two
  databases; edges are refused from 150 degrees on (above), and a long edge
  split into shorter ones narrows the band with the square of the length. Edges
  shorter than about 1e-5 degrees MySQL places up to 2e-7 degrees off.
  In the box from (0, 40) to (10, 50) both databases put (5, 40.05) outside and
  (5, 50.05) inside, because the south edge bows north to about latitude
  40.105 and the north edge to about 50.10. So a hole drawn touching or just
  inside a straight parallel edge crosses the edge's arc and is refused
  (PostGIS matched points in the hole beside it), a hole between the straight
  line and the arc on the inner side is accepted, and three vertices in a
  straight line of longitude and latitude off the equator form a thin
  triangle, not a zero-area ring. A touch is refused even where it is exact,
  as before D2: it is where the two databases' edges (sphere, ellipsoid) and
  tolerances part. A differential run of 4,800 random holes and
  quadrilaterals against PostGIS geography agreed on every verdict.
- Newly accepted, because both databases answer them correctly: a closing
  vertex repeated at the end, or any vertex repeated consecutively (it is sent
  as written and closed once more), a ring that goes past a whole turn of
  longitude beside itself. SQLite-family providers still refuse polygon
  filtering, now after admission.
- An outer ring with vertices on both sides of the equator, of the 0/180
  meridian and of the 90/-90 meridian at once is refused with `A GeoPolygon
  cannot reach across the equator and the 0/180 and 90/-90 meridians at
  once`. PostGIS then has no reference point outside the polygon's box and
  guesses one: it misread 23 of 372 such random rings, one of them 27% of
  half the globe, and none of 494 reaching across two planes or fewer. Every
  ring of half the globe or more reaches across all three, so this replaces
  `A GeoPolygon must cover less than half the globe`, whose longitude
  trapezoid sum ignored the arcs' bowing and admitted the tropics band
  (-170 to 170 at ±30, 11.18 steradians), which PostGIS read as the whole
  globe and MySQL as the band.
- An edge 150 degrees long or longer is refused with `A GeoPolygon edge must
  be shorter than 150 degrees`, at the vertex ending it. MySQL reads an edge
  on the ellipsoid, PostGIS on the sphere, and near antipodal endpoints the
  ellipsoid's path swings away: MySQL's edge left the great-circle arc by at
  most 0.46 degrees on 150-degree edges, 1.6 at 170, 8.4 at 178 and 17 at
  179, and on edges 0.000001 to 2 degrees short of antipodal it answered
  points far from the edge unlike PostGIS and the sphere in every run.
  `A GeoPolygon edge cannot span exactly 180 degrees` stays for edges 180
  degrees of longitude long however short: such an edge runs over a pole,
  where the two databases answered (0, 80) differently for (0, 10) to
  (180, 10), or joins antipodal endpoints, which PostGIS raises for.
- A ring less than 2e-5 degrees across (about 2 m, measured from its first
  vertex, the same at every latitude) is refused with `A GeoPolygon ring must
  be at least 2e-5 degrees across`, a ring of one distinct vertex included
  (it reported `must have non-zero area`): MySQL put up to 9% of the points
  inside rings a few 1e-6 degrees across, a tenth of the ring away from every
  edge, on the wrong side, and none of 16,000 in rings 1.4e-5 across; PostGIS
  answered all of them. The geometry itself resolves far finer: its cross
  products are taken from vertex differences, so a 1e-7-degree bowtie inside
  a larger ring is refused at any latitude (it was admitted at latitude 45),
  and points within 1e-9 degrees, about 0.1 mm, of an edge count as on it.
- A polygon without `outer` fails with `Missing required field: outer` (was
  `Expected GeoPolygon with outer and optional holes`), and a ring that is not
  an array with `Expected array` (was `Expected outer ring array`). A ring is
  read by index like every array operand: an empty slot in a sparse ring fails
  as `Expected object` at its index, and an inherited index is read.
- Unchanged: longitude `-180` still becomes `180`, `-0` still becomes `0`,
  `holes: []` is still the same argument as no `holes`, and an accepted
  polygon is still sent with its outer ring counterclockwise and its holes
  clockwise.

### Identifiers are generated by VibORM (breaking for the dependency graph)

`@paralleldrive/cuid2`, `nanoid` and `ulidx` leave the runtime dependency graph
and nothing joins it: SHA3-512, the one hash CUID2 needs, is VibORM's own
Keccak-f[1600] and adds no dependency at all. Every format is built here, from
`crypto.getRandomValues` and nothing else — a runtime that cannot provide secure
randomness is refused rather than served a weaker identifier. CUID2 output is
byte-identical to the package it replaces, proven by a differential test against
the pinned upstream, and the digest is byte-identical to `@noble/hashes` over
the NIST known-answer vectors and 10,000 random messages, proven by a second
differential test that keeps that package installed for development only.

- Added `s.string().uuidv7()` and `s.string().ksuid()`, with the matching
  `generate` kinds in the JSON schema document.
- `s.string().id()` now sets `hasDefault`, so a generated primary key is
  optional in the create type as it already was at runtime. `.id()` no longer
  overrides a generator declared before it, and `.id(prefix)` after a generator
  is refused (`.id("")` names no prefix, so it stays a plain key declaration).
- A nanoid length outside the range a nanoid can have — not a whole number, or
  outside 1 to 65536, the entropy source's own per-call quota — is refused at
  declaration instead of silently producing empty identifiers or throwing a
  platform error on every row.

### Identifier storage (breaking for new schemas)

Naming a format is now a promise about every value of the field, and VibORM both
holds you to it and takes advantage of it. `.uuid()`, `.uuidv7()`, `.ulid()`,
`.ksuid()`, `.nanoid()` and `.cuid()` declare a **domain**; a bare `.id()` still
declares a **key** and is unchanged in every respect — its values are whatever a
string column holds, and it is still stored as text.

- **Values are validated.** A declared or derived domain admits only its own
  values, everywhere one can appear: `create`, `update`, `where`, unique
  selectors, cursors, and every `connect` / `connectOrCreate` / `upsert` key. A
  prefix is matched whole, and aliases normalize once — an uppercase UUID and a
  lowercase ULID address the same row their canonical spelling does. Previously
  `s.string().uuid()` refused nothing.
- **Storage changes for new schemas.** `uuid`/`uuidv7` become `uuid` on
  PostgreSQL and `BINARY(16)`/`BLOB` elsewhere; `ulid` becomes
  `bytea`/`BINARY(16)`/`BLOB`; `ksuid` becomes `bytea`(20)/`BINARY(20)`/`BLOB`.
  A declared prefix is no longer stored — it is identical in every row and is
  re-applied on read. `nanoid` and `cuid` keep text storage.
- **Foreign keys derive.** A column that references a key is admitted,
  normalized and stored exactly as that key is, with no declaration of its own —
  through self-relations, compound members, one-to-one chains, junction columns
  and polymorphic carrier columns alike. Declaring a DIFFERENT domain on a
  foreign key than its target has, or reaching one column through references
  whose keys disagree, is a schema error (FK012).
- **Four operators are gone from the compact formats.** `contains`,
  `startsWith`, `endsWith` and `mode` are removed from the filter TYPE of a
  `uuid`/`uuidv7`/`ulid`/`ksuid` field and refused by the engine: sixteen bytes
  are not the text you wrote them as. `equals`, `not`, `in`, `notIn`, `lt`,
  `lte`, `gt`, `gte`, `orderBy`, cursor pagination, `_min`/`_max`, `_count` and
  `groupBy` are exact and unchanged — the byte order of all four formats IS
  their canonical text order. The loss goes by the FORMAT, not by the storage:
  a compact format that takes the text-family override below still loses them,
  because the validation schema is built before any adapter exists and one
  filter type per field rather than one per deployment is what keeps the type
  and the runtime saying the same thing. A DERIVED domain narrows at run time
  only: a foreign key has no declaration of its own to compute a type from.
- **A field reference across storage is refused.** `where: { id: { equals: (ctx)
  => ctx.fields.someString } }` compiled and matched nothing when `id` was
  compactly stored and `someString` was not — it compared payload bytes with
  public text. Both directions now raise before any I/O, naming what each column
  holds. Two TEXT columns are untouched whatever their domains: a `nanoid`
  stores exactly the string it shows, so comparing it with an ordinary string
  column asks the question it appears to ask.
- **`_min`/`_max` aggregate the transported spelling.** PostgreSQL has neither
  `min(uuid)` nor `max(bytea)`, and the answer is the same either way.
- **`DEFAULT gen_random_uuid()`** is emitted only for an unprefixed `.uuid()`
  field, and only where the column can hold one: `uuidv7` needs PostgreSQL 18,
  and no database can produce a prefixed value or a `bytea` payload.

### Existing databases

A column that already holds text has two routes, and neither is silent.

- **Keep the column.** A text-family native type
  (`s.string(PG.STRING.VARCHAR(40)).uuid()`, `TEXT`, `citext`, MySQL `CHAR(n)`,
  …) opts out of compact storage while keeping the domain validated. PostgreSQL's
  `char(n)` is not among them — `character(n)` blank-pads to its full width, so
  no value of the domain would ever be returned. A native type the domain cannot
  live in is refused where it is declared (F013), with a message naming the
  spellings that format does accept.
- **Convert the rows.** The generated `alterColumn` into a binary column is now
  **refused** rather than run: nothing can re-read stored text as bytes, and the
  refusal names the manual route. PostgreSQL's `text` → `uuid` leg still runs —
  `col::uuid` is a real per-value conversion — and is now preceded by a guard
  that says how many rows would fail it and what the two routes are, instead of
  naming one offending value.
- `identifierConversionChecks` (new, from `viborm/migrations`, alongside the
  `MigrationCheckInput` type) renders the questions a conversion has to answer
  first — every row in the domain, no two rows folding together under the
  uuid/ulid alias, every referencing foreign key still finding its parent after
  that fold — as `trusted-read` checks you can run or pass to `generate()`. The
  fold question is asked of the key and of any referencing column that is a
  complete key of its own model, never of a plain many-side foreign key. On
  MySQL every identity comparison is rendered as `CAST(… AS BINARY)`: the 8.0
  default collation folds case in `=`, which admitted a foreign key that the
  `BINARY(n)` column would then leave without a parent.
  The per-dialect recipes are in the new
  [Converting identifier columns](https://viborm.dev/docs/migration/identifiers)
  guide; every statement on that page was executed against PostgreSQL 16,
  MySQL 8 and SQLite.

### Decimal API change (breaking)

The exact decimal value type is now VibORM's own `Decimal` instead of
decimal.js, and it brings no dependency with it: an immutable signed `BigInt`
coefficient and a scale, where decimal.js was 32 KB minified.
`Decimal` is still exported from `viborm`, still constructed once per selected
leaf, and still satisfies `instanceof Decimal`. Nothing VibORM owns changed:
`s.decimal({ precision, scale })`, the frozen descriptor, exact admission,
canonical identity, provider representations, DDL, filters, updates, aggregates
and migrations all behave exactly as before, and the accepted input grammar
(`"+1.5"`, `".5"`, `"1."` accepted; `"1e3"` refused) is unchanged.

What changes for application code that does arithmetic on returned values:

- **18 prototype members instead of ~130**, every one of them distinct.
  Kept: `abs`, `cmp`, `div`, `eq`, `gt`, `gte`, `lt`, `lte`, `minus`, `neg`,
  `plus`, `times`, `toFixed`, `toJSON`, `toNumber`, `toString`, `valueOf`,
  and the constructor.
- **No aliases.** decimal.js spelled three operations twice; only `plus`,
  `minus` and `times` exist here.
- **Gone:** `pow`, `sqrt`, `mod`, `prec`, `round`, `toExponential`,
  `toPrecision`, `isZero`, `isNeg`, `isNaN`, `isFinite`, `floor`, `ceil`,
  `trunc`, `toDP`, `toSD`, `dp`, `sd`, `ln`, `log`, `exp`, the trigonometric
  methods, `toFraction`, `toNearest`, `clamp`, and the radix conversions.
  `x.isZero()` becomes `x.eq("0")`; `x.isNeg()` becomes `x.lt("0")` (a JavaScript number is refused; write the string or a bigint); rounding to a
  fixed number of places is `x.toFixed(n)`.
- **No NaN and no Infinity.** `new Decimal("abc")`, `new Decimal(NaN)` and
  `new Decimal(Infinity)` throw `TypeError` where decimal.js produced a NaN
  value, and `div(0)` throws `RangeError("Division by zero")`.
- **No configuration at all.** `Decimal.set({...})` is gone and nothing
  replaces it: the class has no static properties, so nothing an application
  sets can move a value in either direction. `div` takes its decimal places and
  its rounding as arguments — `div(other, fractionDigits = 20, rounding =
  "half-up")`, where `rounding` is `"half-up"` (ties away from zero, the
  default and what decimal.js's default produced) or `"half-even"` (ties to the
  even neighbour, what the SQL engines do). `toFixed` rounds half away from
  zero.
- **`toString()` never emits exponent notation.** There is no `toExpNeg` /
  `toExpPos` equivalent and no threshold: the canonical text of a value is
  every digit it has, which is also the text VibORM stores, compares and keys
  cache entries on.
- **`structuredClone` of a `Decimal` returns an empty object** rather than
  throwing, because the value lives in private fields. It was already not
  cloneable; it is now quietly not cloneable. Post `row.total.toString()`
  across a worker or a `structuredClone`-based cache boundary and rebuild the
  value on the other side. VibORM's own cache stores the canonical text, so
  nothing internal is affected.
- **No `@types/*` package.** The declarations are VibORM's own and ship with
  it, so `dependencies` carries no type-only package.

There is no compatibility shim, and a decimal.js instance is not accepted as
input. Convert one at the boundary:

```ts
import { Decimal } from "viborm";

const converted = new Decimal(oldDecimalJsValue.toFixed());
```

Use `toFixed()` with no argument rather than `toString()`: it is decimal.js's
complete value in plain notation, so it cannot hand the new constructor an
exponent form shaped by the old constructor's `toExpNeg`/`toExpPos`, which the
accepted grammar refuses.

## 0.1.0 - 2026-01-24

- Published the initial development package.
