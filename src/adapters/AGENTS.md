# Database Adapters - SQL Dialect Layer

**Location:** `src/adapters/`  
**Layer:** L7 - Database-Specific SQL (see [root AGENTS.md](../../AGENTS.md))

> **Three provenance citations in this layer name V1 files that no longer exist.**
> The pattern retirement (Arnaud's decision D-15) deleted `query-engine/builders/`
> whole and all of `query-engine/operations/`; follow-up F-2 then moved its one
> survivor, `groupby-fields.ts`, to `query-engine/result/` and deleted the
> directory.
> `database-adapter.ts:664` and `databases/mysql/mysql-adapter.ts:886` cite
> `junctionDuplicateSkip` in `builders/many-to-many-utils.ts`, and
> `adapter-capabilities.ts:42` cites `buildBulkLimitWhere` in
> `operations/bulk-limit.ts`. Each records WHAT V1 did and where the seam came
> from; read it in git history (`e8114ed9`), not on disk.

## Purpose

ALL database-specific SQL generation lives here. Query engine calls adapter methods to build dialect-correct SQL.

**The Separation Principle:** Query engine = WHAT to query. Adapter = HOW to express it.

## Why This Layer Exists

VibORM supports PostgreSQL, MySQL, and SQLite from one codebase. These databases have dozens of syntax differences:

| Concept | PostgreSQL | MySQL | SQLite |
|---------|------------|-------|--------|
| Identifier quotes | `"column"` | `` `column` `` | `"column"` |
| JSON aggregation | `json_agg()` | `JSON_ARRAYAGG()` | `json_group_array()` |
| Case-insensitive | `ILIKE` | `LIKE` (default) | `LIKE` + COLLATE |
| Array contains | `= ANY(col)` | `JSON_CONTAINS()` | `json_each()` subquery |
| Empty JSON array | `'[]'::json` | `JSON_ARRAY()` | `json_array()` |

Without adapters, we'd have `if (postgres) ... else if (mysql) ...` scattered everywhere. The adapter pattern centralizes all dialect knowledge in one place per database.

---

## Entry Points

| File | Purpose | Lines |
|------|---------|-------|
| `database-adapter.ts` | Interface & base implementation | ~720 |
| `databases/postgres/postgres-adapter.ts` | PostgreSQL dialect | ~570 |
| `databases/mysql/mysql-adapter.ts` | MySQL dialect | ~620 |
| `databases/sqlite/sqlite-adapter.ts` | SQLite dialect | ~570 |
| `databases/*/migrations.ts` | DDL for each database | varies |
| `shared/` | Cross-dialect helpers (standard SQL ops, SELECT/JSON assembly) | varies |

---

## DatabaseAdapter Interface

**12+ method groups** (all return `Sql` fragments):

| Group | Methods | Critical For |
|-------|---------|--------------|
| `identifiers` | escape, column, table, aliased | Identifier quoting; `table()` also applies `namespace` |
| `literals` | value, null, true, false, list, json | Value formatting |
| `operators` | eq, neq, like, ilike, in, between, and, or | WHERE conditions |
| `json` | object, array, agg, extract | **Nested includes!** |
| `arrays` | literal, has, hasEvery, hasSome | Array operations |
| `aggregates` | count, sum, avg, min, max | Aggregate queries |
| `orderBy` | asc, desc, nullsFirst, nullsLast | Sorting |
| `clauses` | select, where, orderBy, limit | Query structure |
| `subqueries` | scalar, correlate, existsCheck, isolated | Relation filters (SQLite: a derived table where the driver declares `deepExpressions: false`, which also nests a conjunction of many members as a balanced tree and isolates a nesting level's row domain; `isolated` is the identity elsewhere) |
| `setOperations` | union, unionAll, intersect, except, typedRows | `typedRows`: the rows a judged write produces, typed by the table. One `UNION ALL SELECT` arm per row by default (MySQL); a `VALUES` list after the typed head on SQLite (`SQLITE_MAX_COMPOUND_SELECT`, 500, does not count it); a `VALUES` list typed by its first row on PostgreSQL (each `UNION ALL` arm is one parser recursion: `54001` at 8,000 rows). The bind budget is a chunk's only bound |
| `mutations` | insert, update, delete, returning | Write operations |

---

## Core Rules

### Rule 1: All Methods Return Sql Fragments
Every adapter method takes primitives/Sql and returns Sql. Never return strings. Fragments preserve parameterization.

`mutations.insert` accepts either literal row tuples or `{ select: Sql }`.
Adapters own the dialect spelling of both `INSERT ... VALUES` and
`INSERT ... SELECT`; query-engine code must not hand-build either form.

### Rule 2: Implement for ALL Databases
Every interface method MUST be implemented in postgres, mysql, AND sqlite. TypeScript enforces this, but incomplete implementations can return wrong results.

### Rule 3: No Query Logic
Adapters transform syntax only. Don't decide which tables to join or what conditions to apply - that's query engine's job.

### Rule 4: Test Across All Databases
A change that works in PostgreSQL might break MySQL or SQLite. Always run the full test suite.

### Rule 5: The Adapter Owns The One Namespace Fact
`adapter.namespace` is the sole normalized SQL qualification value — a
PostgreSQL schema, a MySQL database, a requested Vitess keyspace qualifier.
`PostgresAdapter` defaults it to `public`; `MySQLAdapter` leaves it `undefined`
when unbound; SQLite adapters carry no such property at all (`"namespace" in
sqliteAdapter === false`). It is selected once in the constructor and installed
non-writable, and THAT INSTALL is where its immutability lives — not in a ban on
copies: models, relations, query scopes, operation programs, result types,
journals, cache identity, and instrumentation all read it or do without it, and
the two readers that capture it once — the bound migration driver at bind time
(`getMigrationDriver`), and the `readDriverIdentity` snapshot a cached read
takes at `$withCache` — are safe precisely because the property they read cannot be
reassigned under them.

`identifiers.table()` is the one renderer that applies it, and its alias is
optional. Everything statement-local — CTEs, aliases, columns, constraints,
temporaries — goes through `escape()`, which must never become namespace-aware.
Compose the qualified text through `renderQualifiedIdentifier` /
`createQualifiedIdentifierRenderer` in `src/sql/identifiers.ts`; never build
`schema.table` by hand, and never hand a dotted name to a quoter.

Do not add a second configurable namespace source, a per-model or per-query
namespace, a compatibility alias (`databaseSchema`, `databaseName`,
`databaseNamespace`, `pgSchema`, `keyspace`, `searchPath`), or a SQLite
attachment equivalent. Runtime emits neither `SET search_path` nor `USE`.

### Rule 6: Exact Decimal Is Adapter Vocabulary, Not A Capability Flag

One schema descriptor, `{ precision, scale }`, reaches every dialect. Adapters
own only its SQL representation and exact operations:

- PostgreSQL uses `NUMERIC(p,s)` and text-decoded `NUMERIC[]` members;
- MySQL uses `DECIMAL(p,s)` and coefficient-string JSON list members;
- SQLite uses a checked scaled `INTEGER` and coefficient-string JSON list
  members.

Scalar and list values remain exact across literals, predicates, ordering,
arithmetic, aggregates, relation-key comparisons, and result decoding. Never
coerce a decimal through JavaScript `number`, add an adapter-wide
`supportsExactDecimal` flag, or expose a public string-result mode. The pinned
migration owner proves MySQL 8.0.16-or-later and a strict SQL mode once for each
effectful command. That proof is command-wide because provider-authored DDL and
manual artifacts cannot be classified safely by decimal effect. Ordinary typed
writes do not add a session-admission query: arithmetic protects non-strict
sessions inside the same statement by refusing unsafe intermediate or final
domains before assignment. Raw SQL deliberately sees the provider
representation, including SQLite's scaled coefficient, and owns its session
mode.

### Rule 7: An Identifier Is Three Dialect Facts And Nothing More

A declared identifier format is stored as the identifier itself, and the adapter
owns exactly three statements about that:

| Member | What it says |
| --- | --- |
| `result.idRepresentation(domain, nativeType)` | what the column physically holds here — `"text"`, `"uuid"` or `"bytes"`; `nativeType` is the field's whole declaration (shorthand or per-dialect map), resolved for this dialect by `idStorageOf` |
| `literals.id(physical, representation)` | how an operand in that form BINDS |
| `expressions.idCast(expr, representation)` | how a DEFERRED value is cast into the column's type (no engine caller since the Raptor 3 port; see below) |

All three derive from `@schema/scalars/string/id-domain`'s `idStorageOf`, which
is also where the migration column type comes from — so the column a push
creates and the parameter a write binds cannot be two decisions. Do not add a
second per-format table, and do not read a format, a prefix or an alphabet in an
adapter: the value arrives already encoded by the codec.

A PostgreSQL `uuid` operand is TYPED (`CAST($1 AS UUID)`) because there is no
`uuid = text` operator; every byte-stored column takes the payload as the
ordinary binary parameter blob scalars already bind, so nine drivers' nine
binary spellings stay the drivers' business. `idCast` was written for the same
reason `decimalCast` was: a relation key whose value does not exist at build
time cannot go through `literals.id`. The engine that replaced the one that
needed it has no such value — a located key is a raw column sub-select, already
physical — so `idCast` has NO engine caller since the Raptor 3 port
(`query-engine/raptor3/shared/identifier.ts`). It remains a declared member,
pinned by `tests/contracts/adapters/identifier-storage.core.test.ts`, until its
owner retires or re-adopts it.

The engine's half: `result.idRepresentation` is read once per column into the
projection leaf; `literals.id` is the one binding (`Queries.scalarValue`); and
`expressions.blobToHex` is how a byte column TRAVELS, flat and inside a JSON
carrier, and what `MIN`/`MAX` run over — with `expressions.cast(…, "text")` for
a PostgreSQL `uuid` inside an aggregate, which PostgreSQL has no `min(uuid)`
for.

### Rule 8: GeoPoint Is One Settled Protocol

`DatabaseAdapter.geoPoint` is the sole GeoPoint SQL vocabulary: value,
longitude, latitude, equality, inclusive bounds, and optional polygon/distance.
`installGeoPointSql` snapshots and freezes that exact object and installs the
adapter property non-writable. Absence means no point definition support;
presence of the optional members proves the full query tier. Do not add a
geospatial capability boolean, mutable member, strategy, generic geometry, or
second parser.

### Rule 9: List Updates Receive One Complete Container

`DatabaseAdapter.set.push()` and `.unshift()` receive one already encoded `Sql`
container, never loose JavaScript members. The query engine's scalar-value
boundary chooses the destination vocabulary once: a native PostgreSQL array,
an untyped managed-enum array literal, an exact-decimal list, or a JSON
container. Adapters own only dialect concatenation. Do not expand a list into
one SQL node or bind per member, and do not serialize its members a second time.

The query engine chooses the operation and passes trusted codec values. The
adapter alone spells PostgreSQL/PostGIS, MySQL SRID 4326, or SQLite JSON SQL.
All coordinates and polygon JSON are bound. PostgreSQL/MySQL spatial predicates
may only be conservative index prefilters before exact public semantics.

---

## Database Capability Matrix

| Feature | PostgreSQL | MySQL | SQLite | Handling |
|---------|:----------:|:-----:|:------:|----------|
| RETURNING | ✅ | ❌ | ✅ (3.35+) | MySQL: follow-up SELECT |
| Native arrays | ✅ | ❌ | ❌ | Use JSON columns |
| JSON functions | ✅ | ✅ (8.0+) | ✅ (3.38+) | All supported |
| ILIKE | ✅ | ❌ | ❌ | MySQL/SQLite: COLLATE |
| NULLS FIRST/LAST | ✅ | ❌ | ❌ | Emulate with `(col IS NULL)` sort key |

**Important:** When PostgreSQL has a feature others lack, the adapter must either emulate it or the capability check must prevent its use.

`capabilities.sharesRelationBodies` is a transport fact, never a dialect
one: declared by D1 (`SQLiteAdapter({ sharedRelationBodies: true })`) and by
every PostgreSQL driver by default (`installPostgresAdapter`;
`sharedRelationBodies: false` keeps the bodies inline), absent on SQLite3,
libSQL, Bun SQLite and MySQL. The engine then states each relation body a
statement repeats once, through `cte.with`. An in-process SQLite pays for
sharing and gains nothing a transport charges: measured on better-sqlite3
(2026-10-19, acceptance policy with soft delete), SQLite runs both spellings
in about the same time, and finding the repeats costs the engine about
230 µs per governed statement (`can` 0.30 → 0.53 ms). Re-measured for 1.4.0,
with SQLite's nested members `MATERIALIZED` and the cheaper key (2026-10-20,
end to end, default adapter): set reads are faster shared (`page` including
its group 1.76 → 1.28 ms, `accessGrant.findMany` 3.18 → 1.71 ms) and point
reads slower (`can` 0.38 → 0.78 ms, `findMany` `take: 10` 0.76 → 1.02 ms),
so the in-process default stays off.

`cte.with` hints: `createCteBuilders(quoteIdent, { inlining, materializing })`.
PostgreSQL passes `inlining` (`NOT MATERIALIZED` for a correlated leaf
member: it would otherwise materialize a member read twice); SQLite passes
`materializing` (`MATERIALIZED` for a member `inlined: false`, every other
member the engine shares: it would otherwise inline each member at every
use, compiling a nested one again inside each use of the body reading it,
which D1 refuses as `SQLITE_NOMEM`); a member without `inlined` is left to
the database. MySQL
passes neither (it has no such syntax). MySQL sharing works when declared
(its backtick aliases renumber like quoted ones) but no MySQL driver declares
it: no transport bound asks for it, and no MySQL plan has been measured.
A `recursive` member (since 1.4.0, a recursive filter's reaching set) is its
two terms, `anchor UNION recursive`, states no hint, and makes the clause
`WITH RECURSIVE` (one keyword for the list, on every dialect).

`capabilities.boundsRecursionIterations` is a dialect fact: MySQL fails a
recursive CTE past `cte_max_recursion_depth` iterations (1000 by default), so
its recursive filters keep their walk in place, whose anchor holds the first
hop, even where it shares bodies; a reaching set would spend one iteration
per depth from its anchor. Absent elsewhere.
`capabilities.compoundSelectTerms` is a transport fact: D1 compiles SQLite
with 5 terms per compound `SELECT` ("too many terms in compound SELECT"), so
a flag member's union over more key sets nests in derived tables of 5.
`capabilities.boundsExpressionDepth` is set by `SQLiteAdapter({
deepExpressions: false })` (D1, depth 100): a relation filter's own `EXISTS`
joins no flag member there, since the join keeps SQLite from flattening the
derived table each nested level reads from.
`capabilities.relationsPerStatement` is a transport bound: PlanetScale Neki
refuses a statement referencing over 256 relations (every `FROM` item). Plain
PostgreSQL bounds none, and a statement escalated to fit pays in its plan, so
`installPostgresAdapter` sets it from the driver's `relationsPerStatement`
option (a positive integer, refused otherwise), and only where bodies are
shared. Absent the option, `src/drivers/shared/relation-bound.ts` fills it
from the server: 256 where a connection's startup `server_version` ends
`(Neki)` (node-postgres on a pool the driver makes, whose `Client` reads it;
postgres.js's `sql.parameters`), or the limit Neki's refusal names (54000,
"references more than N relations"; Bun SQL and a supplied pool keep no
startup, so their refused statement fails and the next fit). It fills an
absent bound only: a stated one always wins. The driver's `serverFacts()` is
pending until its first connection's startup was read, and the engine waits
for it before building an operation or an array transaction's members
(`PendingOperation`, `$transaction([...])`): that connection is the one the
statement needs, so no server pays a round trip (Neki: a refusal takes
~0.4 s, a round trip ~36 ms). postgres.js 3.4 never answers a first
`reserve()` that fetches no types, so with `fetch_types: false` it is read
once a statement connected. Nothing caches built SQL across operations, so
the next statement built reads the bound. A statement over it states its
repeated recursive walks as reaching sets, then joins key sets per row, only
as far as it needs; one within it keeps every walk in place. PostgreSQL
holds a joined one-column key set as an array (`arrays.ofRows`, `ARRAY(…)`,
tested by `arrays.has`), computed once per statement; a dialect without
`ofRows` joins a flag member. D1 bounds no relations and takes 256
(`SQLiteAdapter({ relationsPerStatement })`): on better-sqlite3 no read is
slower with it (the 10× page read three depths: 385 ms without, 260 ms
with), and the largest reads stay well inside 100 KB. Absent, nothing
escalates.

`assertions.holds` (a write's judgement of the row it produces) fails with its
own sentinel, under the `__viborm_judged__` alias: PostgreSQL a text sublink
cast to `integer` (22P02 naming `__viborm_refused__`), SQLite a JSON path
naming it, MySQL an invalid JSON path (3143). `exists`/`notExists` (a batch's
premises) keep `__viborm_assert__` and their division by zero or invalid JSON
text; `src/drivers/error-mapping.ts` tells the two apart.

---

## Anti-Patterns

### Query Logic in Adapter
Putting WHERE clause construction or JOIN decisions in adapter. Adapters only transform syntax, not structure. If you're writing control flow, it belongs in query-engine.

### Returning Strings Instead of Sql
Returning raw strings breaks composition and parameterization. Always return `Sql` fragments.

### Assuming PostgreSQL Features
Using RETURNING, native arrays, or ILIKE without checking capability. MySQL lacks all three. Your PostgreSQL tests pass but MySQL users hit errors.

### Copy-Paste Between Adapters
Copying implementation between databases without adjusting syntax. Each dialect has quirks. Review carefully.

### Incomplete Method Groups
Adding a method to PostgreSQL but forgetting MySQL/SQLite. All 3 must implement every interface method.

---

## Common Tasks

### Adding New Adapter Method

1. **Define in interface** (`database-adapter.ts`):
   ```typescript
   myNewOp(left: Sql, right: Sql): Sql;
   ```

2. **Implement in PostgreSQL** (`databases/postgres/postgres-adapter.ts`)

3. **Implement in MySQL** (`databases/mysql/mysql-adapter.ts`)

4. **Implement in SQLite** (`databases/sqlite/sqlite-adapter.ts`)

5. **Use in query-engine** via `ctx.adapter.myNewOp()`

6. **Test on all 3 databases**

### Debugging Dialect Issues

If a query works in PostgreSQL but fails in MySQL:
1. Log the generated SQL: `console.log(sql.text, sql.values)`
2. Compare output between adapters
3. Check the capability matrix - is the feature supported?
4. Look for hardcoded syntax that slipped through

---

## Critical Dialect Differences (Detail)

### JSON Aggregation

This is the #1 source of multi-database bugs. Used for every nested include.

```sql
-- PostgreSQL
COALESCE(json_agg("t1".*), '[]'::json)

-- MySQL  
COALESCE(JSON_ARRAYAGG(JSON_OBJECT('id', t1.id, ...)), JSON_ARRAY())

-- SQLite: an aggregate over no rows is already '[]'
json_group_array(json_object('id', t1.id, ...))
```

`json.agg` is the one owner of the empty-array answer: no caller wraps it in
its own COALESCE. On SQLite its argument must carry the JSON subtype — a
`json_object` call does; a value read back through a subquery column has lost
it and goes through `json.document` (`json(...)`) first, or it is aggregated
as a quoted string.

### Identifier Quoting

```sql
-- PostgreSQL/SQLite
SELECT "user"."email" FROM "users" AS "user"

-- MySQL
SELECT `user`.`email` FROM `users` AS `user`
```

### Boolean Literals

```sql
-- PostgreSQL
WHERE "active" = TRUE

-- MySQL/SQLite
WHERE `active` = 1
```

### Private constraint naming

`getAdapterInternals(adapter).constraints` is the one private projection from a
schema key to its physical constraint name and the exact normalized provider
descriptor for that dialect. Query engines pass the physical table, columns,
and the schema key's compound name or mapped scalar column; they do not
synthesize `_pkey`, `PRIMARY`, `_key`, or SQLite's table/column evidence.
Driver error normalization owns the inverse provider boundary. Candidate
recovery compares its output exactly and fails closed; it does not reinterpret
provider messages. This vocabulary must not appear on the public
`DatabaseAdapter` interface.

## Coverage Gate

`pnpm test:coverage:adapters` is the exact adapter-subsystem report. It uses the
deterministic adapter core project, requires 100% statements, branches,
functions, and lines, and writes `coverage/adapters/index.html`. Live provider
execution belongs to provider projects and is not admitted to this core gate.

---

## Related Layers

| Layer | Relationship |
|-------|--------------|
| **Query Engine** ([query-engine/AGENTS.md](../query-engine/AGENTS.md)) | Calls adapter methods. **CRITICAL BOUNDARY!** |
| **Migrations** ([migrations/AGENTS.md](../migrations/AGENTS.md)) | Uses adapter for DDL generation |
| **SQL Utils** (`src/sql/`) | Provides Sql template tag for composition |
| **Drivers** | Executes the SQL that adapters generate |
