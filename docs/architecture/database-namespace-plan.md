# Database Namespace Support Plan

## Status

Implementation-ready design. This document plans one public namespace setting
that selects a PostgreSQL schema or the SQL database qualifier used by MySQL.
Under Vitess, a requested keyspace qualifier occupies that MySQL database
position before VTGate applies routing rules. The setting never denotes a
PlanetScale database resource or proves the final routed backend. SQLite stays
on its provider's primary database. This document does not implement the feature.

## Summary

Add one cross-dialect setting at each supported PostgreSQL and MySQL driver
boundary:

```ts
// PostgreSQL and MySQL drivers
namespace?: string;
```

MySQL2 has one additional, deliberately separate migration-safety assertion:

```ts
migrationNamespaceAttestation?: "non-redirecting";
```

It does not select a target. It states that, for this driver instance, a
database-qualified reference and the pinned migration session's `USE` cannot
be remapped by VTGate schema-routing rules or an equivalent routing proxy.
Effectful MySQL2 migration work requires this explicit assertion. It is never
inferred from the driver class, URL, host, server version, handshake, or resolved
namespace. Runtime ORM work and read-only/offline migration work do not require
it. PlanetScale does not expose the option.

A **namespace** is the SQL qualification value used for one driver's VibORM
persistent objects. It maps to a PostgreSQL schema and to a
MySQL database; under Vitess, the MySQL database position submits a keyspace
qualifier that routing rules may redirect. It is deliberately not a promise
that the dialects share catalog, migration, transaction, sharding,
provider-resource, or physical-containment semantics.

| Driver family | `namespace` selects | Omitted value |
|---|---|---|
| PostgreSQL | Schema | `public` |
| MySQL2 | MySQL database | Derive only from proven driver-created configuration; otherwise remain unbound |
| PlanetScale Vitess | Keyspace qualifier submitted before VTGate routing | Remain unbound so PlanetScale and VTGate retain full routing authority |
| SQLite | Unsupported | Continue using the provider's primary database |

PostgreSQL defaults to `"public"` and always qualifies ORM-owned persistent
objects. MySQL qualifies them when a database can be resolved from the explicit
option or MySQL2 connection configuration; an otherwise unqualified MySQL
runtime client remains valid. A resolved MySQL2 database is target evidence,
not non-redirection evidence. SQLite receives no corresponding option.

The selected value is immutable for the lifetime of a driver and applies to
every VibORM-owned persistent object:

- model tables;
- implicit and explicit junction tables;
- variant-member junction tables;
- foreign-key targets;
- indexes;
- ORM-managed PostgreSQL enum types; and
- the migration tracking table.

The public API remains one namespace per driver. A user who needs two
PostgreSQL schemas, two MySQL databases, or two requested Vitess keyspace
qualifiers creates two drivers. The namespace value does not become model
state: callers may reuse one model graph or supply a genuinely different model
graph for each namespace.

VibORM-generated runtime SQL and live migration SQL must explicitly qualify
every VibORM-owned persistent identifier when the adapter is bound:

```sql
-- PostgreSQL
SELECT "user"."id"
FROM "billing"."user" AS "user"

-- MySQL with namespace: "billing"
SELECT `user`.`id`
FROM `billing`.`user` AS `user`
```

PostgreSQL table routing, ORM-managed enums, indexes, and tracking must not
depend on `search_path`. MySQL runtime routing, live DDL, catalog reads, and
tracking must not depend on `DATABASE()` or a pooled connection's ambient
default once a database is selected. Caller-authored raw SQL and manual
migration artifacts remain explicit exceptions.

PostgreSQL resolves qualified names against the named schema, while unqualified
names depend on a mutable search path; see the PostgreSQL
[schema documentation](https://www.postgresql.org/docs/current/ddl-schemas.html).
MySQL's two-part table name is `database.table`, with each component quoted
separately; see the MySQL
[identifier-qualifier documentation](https://dev.mysql.com/doc/refman/8.4/en/identifier-qualifiers.html).

Generated MySQL migration artifacts remain database-relative. A MySQL database
usually names an environment (`app_dev`, `app_test`, `app_prod`), so baking the
physical value into versioned SQL would make one migration estate unusable in
the next environment. Artifact execution establishes the selected database on
one pinned migration session; live push/reset SQL and tracking SQL remain
explicitly qualified. Generated PostgreSQL artifacts stay schema-qualified and
therefore schema-bound, as described in §3.

The namespace design adds one target truth and gives it one name at every
boundary:

> This adapter either supplies one persistent-object namespace qualifier or
> deliberately has none.

The public driver option and the adapter fact are both named `namespace`.
Query rendering, migrations, cache identity, and instrumentation consume that
adapter fact; models, relation resolution, operation programs, and result types
do not copy it. Dialect-specific code interprets the value as a PostgreSQL
schema, MySQL database, or requested Vitess keyspace qualifier.

MySQL2's optional non-redirection attestation is a second necessary truth about
transport behavior, not another target. Only migration admission consumes it.

## Goals

1. Let every stock PostgreSQL provider target an existing schema.
2. Let MySQL2 target an existing database and let PlanetScale explicitly
   qualify SQL with a requested keyspace without confusing that qualifier with
   PlanetScale's enclosing database resource, automatic VTGate routing, or the
   final routed backend.
3. Make PostgreSQL routing independent of `search_path` and bound-MySQL routing
   independent of an ambient default database.
4. Make live DDL, introspection, tracking, reset, and migration history agree
   on the selected live target while keeping MySQL artifacts portable, and
   refuse effectful MySQL work when qualifier routing is not explicitly proven
   non-redirecting.
5. Isolate official cache entries and invalidations by dialect and known
   namespace.
6. Report the configured namespace in instrumentation without inspecting
   secrets or making another provider query.
7. Preserve SQLite runtime ORM SQL plus migration DDL/artifacts, and preserve
   unconfigured-MySQL SQL, byte-for-byte. SQLite's read-only tracking correction
   is the one declared provider-ledger exception.
8. Add no per-row work and no meaningful operation-pipeline regression.

## Non-goals

This program does not add:

- per-model schemas or databases;
- a namespace map;
- cross-schema or cross-database relations and foreign keys;
- per-operation namespace switching;
- tenant routing;
- automatic `CREATE/DROP SCHEMA` or `CREATE/DROP DATABASE`;
- automatic MySQL/Vitess backend or routing detection;
- a public `searchPath` setting;
- runtime connection-state mutation;
- rewriting of tagged raw SQL, unsafe raw SQL, or manual migration artifacts;
- a second model/table naming mechanism;
- PlanetScale database-resource selection, automatic keyspace discovery, or
  treating `@primary`/`@replica` as persistent-object namespaces;
- SQLite `ATTACH`/`DETACH`, an attachment alias, or cross-file migration
  ownership;
- a pgvector/PostGIS extension-schema option; or
- compatibility aliases such as `databaseSchema`, `databaseName`,
  `databaseNamespace`, `pgSchema`, `keyspace`, `attachment`, or `searchPath`.

SQLite's `main`, `temp`, and attached aliases are connection-local names, not a
portable database namespace. `ATTACH` support and session identity also differ
across SQLite3, Bun SQLite, libSQL, and D1. V1 therefore emits the existing
unqualified SQLite SQL and continues to target the provider's primary database.
See SQLite's [`ATTACH DATABASE`](https://www.sqlite.org/lang_attach.html)
documentation. Portable attachment support, if ever added, is a separate
provider-scoped feature rather than a fake third spelling of this API.

VibORM is unreleased, so the implementation must land directly on the final
contract.

## 1. Public contract

### 1.1 Convenience clients

Each PostgreSQL convenience client accepts `namespace` beside its existing
driver options:

```ts
import { createClient } from "viborm/pg";

const db = createClient({
  schema: { user, post },
  databaseUrl: process.env.DATABASE_URL,
  namespace: "billing",
});
```

The same property is added to:

- `PgDriverOptions`;
- `PostgresDriverOptions`;
- `PGliteDriverOptions`;
- `NeonHTTPDriverOptions`;
- `BunSQLDriverOptions`.

MySQL2 and PlanetScale accept the same `namespace` property:

```ts
import { createClient } from "viborm/mysql2";

const db = createClient({
  schema: { user, post },
  databaseUrl: process.env.DATABASE_URL,
  namespace: "billing",
});
```

Add it to `MySQL2DriverOptions` and `PlanetScaleDriverOptions`. Do not add any
namespace property to the SQLite-family clients.

Only MySQL2 also accepts the following literal when the caller intends to run
effectful migrations against a topology where database qualifiers are a stable
containment boundary:

```ts
const db = createClient({
  schema: { user, post },
  databaseUrl: process.env.DATABASE_URL,
  namespace: "billing",
  migrationNamespaceAttestation: "non-redirecting",
});
```

The assertion is unnecessary for ordinary runtime queries, offline generation,
and admitted read-only migration commands. A false assertion can direct
destructive work through a rewriting proxy and is documented as a caller-owned
safety claim, not a provider-detection feature. `PlanetScaleDriverOptions` and
every SQLite/PostgreSQL option type reject this property.

Every corresponding `createClient()` wrapper must read the caller's namespace
property once through the shared hostile-safe option boundary and pass the
primitive snapshot to its driver. The MySQL2 wrapper does the same for
`migrationNamespaceAttestation`. Do not use unguarded destructuring. Wrapper
exactness must continue to reject misspellings in fresh and held configuration
objects.

### 1.2 Direct driver construction

Direct construction has the same meaning:

```ts
import { createClient } from "viborm";
import { PgDriver } from "viborm/pg";

const db = createClient({
  schema: { user, post },
  driver: new PgDriver({
    pool,
    namespace: "billing",
  }),
});
```

`PostgresAdapter` is also public through `viborm/adapters`. Both public adapter
constructors use the same term:

```ts
new PostgresAdapter(namespace?: string);
new MySQLAdapter(namespace?: string);
```

The exported `postgresAdapter` value is the schema-fixed `"public"` instance.
The exported `mysqlAdapter` remains deliberately unqualified for custom and
legacy provider use. `sqliteAdapter` remains unchanged. Do not add an
adapter-options object for either one-value constructor.

Do not add `namespace` to generic `VibORMConfig`. A configured driver is already
generic client configuration's physical database owner. Adding the same value
beside `driver` would create two possible answers and would make unsupported
dialects appear to accept the feature.

### 1.3 Target resolution and validation

PostgreSQL has one rule: omitted or explicit `undefined` means `"public"`, even
when provider options configure another `search_path`.

MySQL2 resolves one immutable ORM target in this order:

1. an explicit `namespace`;
2. for a driver-created pool, a non-empty database path in `databaseUrl`;
3. for a driver-created pool, `options.database`;
4. otherwise no bound namespace and the existing unqualified runtime mode.

This mirrors the existing provider precedence: a URL overrides the copied pool
options. If `namespace` is explicit, copy the provider options and set the
driver-created pool's default `database` to that same value. Never mutate the
caller's `options` object. A supplied `Pool` is opaque: only explicit
`namespace` can bind it, and VibORM does not inspect mysql2 internals.
An absent or empty URL path contributes no namespace and preserves unbound mode
unless another source supplies one; it is not passed to identifier validation
as an empty candidate.

None of those target sources establishes migration routing. MySQL2 accepts only
the exact optional literal `migrationNamespaceAttestation: "non-redirecting"`.
It means that, for the driver's lifetime, qualified `database.table` references
and the pinned migration session's `USE database` resolve in that named MySQL
database without qualifier rewriting. Omission or explicit `undefined` remains
unproven. A URL-derived or `options.database`-derived namespace never opts in
implicitly.

PlanetScale records a requested qualifier only from explicit `namespace`. A
PlanetScale database resource is the enclosing product/cluster resource and can
contain one or more keyspaces; it is not itself this SQL namespace. The SDK config,
endpoint, and resource name do not prove which keyspace qualifier a query should
submit. See PlanetScale's
[keyspace documentation](https://planetscale.com/docs/vitess/sharding/keyspaces).

An omitted PlanetScale value preserves unqualified runtime SQL so PlanetScale's
Global Edge Network and VTGate retain routing authority. If a connection API
requires a database selector, `@primary` or `@replica` remains provider
connection configuration under PlanetScale's
[routing guidance](https://planetscale.com/docs/vitess/sharding/targeting-correct-keyspace);
it is never accepted as `namespace`, copied to `adapter.namespace`, or emitted
as a table qualifier. An explicit `namespace` instead means that the caller
asks VibORM to submit the named Vitess keyspace qualifier. Vitess schema-routing
rules may redirect even a fully qualified `keyspace.table` reference, so this
value does not prove physical containment; see the
[schema-routing rules](https://vitess.io/docs/25.0/reference/features/schema-routing-rules/).
Every effectful PlanetScale migration, push, reset, and destructive live verb
therefore remains unsupported in this program, whether or not `namespace` is
present.

Validation has one boundary in `src/schema/identifier.ts`:

- reuse the existing ASCII identifier grammar and prototype-collision rule;
- apply the dialect's real length limit at that same boundary: PostgreSQL 63
  bytes and MySQL 64 characters under the deliberately ASCII grammar;
- preserve caller case and quote each identifier component;
- reject empty strings, dots, punctuation, quote characters, non-strings, and
  overlong values;
- allow keywords such as `select`, because the renderer quotes them.

After the common syntax check, apply exactly one dialect semantic check:

- PostgreSQL rejects exact lowercase `information_schema` and every lowercase
  `pg_` prefix.
  PostgreSQL reserves those namespaces for system use; see the
  [schema documentation](https://www.postgresql.org/docs/current/ddl-schemas.html).
- MySQL rejects `information_schema`, `mysql`, `performance_schema`, `sys`, and
  `ndbinfo` case-insensitively. These are server-owned system databases; see
  the MySQL [data-directory documentation](https://dev.mysql.com/doc/refman/8.4/en/data-directory.html).

PostgreSQL preserves quoted case semantics: `PG_CATALOG` is distinct from
lowercase `pg_catalog`. MySQL preserves the supplied spelling but performs the
system-name check case-insensitively because database-name behavior varies by
platform. The shared grammar is intentionally narrower than every identifier
MySQL can represent; document that portability choice rather than claiming full
MySQL filename syntax.

For the public `namespace` option on both dialect families, and for MySQL2's
attestation where applicable:

- Read a hostile option accessor exactly once.
- A throwing accessor or invalid value becomes the existing
  `ClientInitializationError`. A thrown `Error` remains the cause; a non-Error
  throw becomes one deterministic normalized `Error` without coercing the
  hostile value for display. An ordinary invalid value has no fabricated
  cause.
- Failure occurs at the convenience-wrapper, direct-driver, or public-adapter
  construction boundary, always before provider connection work.
- Mutating the caller's options object after construction cannot affect SQL,
  migrations, cache identity, or instrumentation.

The attestation is a driver transport fact, not identifier syntax. Add one
optional readonly `Driver.migrationNamespaceAttestation` whose only admitted
value is `"non-redirecting"`; the base driver snapshots it as an own,
non-writable, non-configurable property. `TransactionBoundDriver` and nested
views copy the exact base value and never derive or upgrade it. Existing custom
drivers default to `undefined`; a trusted custom MySQL driver may explicitly
supply the literal and thereby owns the same assertion. The PlanetScale driver
always supplies `undefined`, exposes no corresponding option, and cannot gain
the capability through later assignment or property definition.

Extend the existing base `Driver` constructor with one trailing optional
primitive for this fact; do not add an options object or setter. MySQL2's
constructor normalizes the public option before `super(...)` and supplies the
primitive. `TransactionBoundDriver` passes the base driver's exact value into
that same constructor, including for nested views. All existing `super(...)`
calls omit it and therefore install their own immutable `undefined` value.

Do not copy this fact into `DatabaseAdapter`, `MigrationTarget`, journals,
cache identity, instrumentation, SQL rendering, or per-command options.
`adapter.namespace` remains the sole target value. The one migration command
admission boundary that already distinguishes effectful/stable-live work from
read-only/offline work consumes the driver fact directly.

No public operation-input, result, model, relation, or migration-command type
depends on this value. The sole public input is MySQL2's exact driver/wrapper
configuration literal; trusted custom drivers supply the same base-constructor
fact directly.

### 1.4 Public adapter contract changes

`viborm/adapters` is a public export, so this is not only driver plumbing. The
release notes and package probes must declare these changes:

- `DatabaseAdapter.namespace` is the sole optional normalized fact;
  concrete `PostgresAdapter` exposes a required `string`, a bound
  `MySQLAdapter` exposes a string, and unbound MySQL/SQLite adapters expose
  `undefined`;
- `DatabaseAdapter.identifiers.table(tableName, alias?)` accepts an optional
  alias, so custom adapter implementations must support the one-argument form;
- `new PostgresAdapter(namespace?)` selects and snapshots the namespace;
- `new MySQLAdapter(namespace?)` selects and snapshots the namespace when
  present;
- exported `postgresAdapter` represents explicit `public` qualification;
- exported `mysqlAdapter` remains explicitly unqualified;
- custom PostgreSQL adapters must expose a normalized schema and are trusted to
  render that same namespace; VibORM can validate presence but cannot prove an
  arbitrary renderer's behavior;
- a custom MySQL adapter may remain unbound for runtime use, but effectful live
  migration commands refuse unless the execution driver supplies both an exact
  namespace and the explicit non-redirecting attestation; and
- the existing adapter capability record gains optional
  `supportsGeospatial`; stock adapters set it explicitly and absence means
  unsupported. Paired with `supportsVector`, it lets migration introspection
  distinguish enabled PostGIS types from unknown external UDTs without
  comparing function objects or breaking unrelated custom adapters.

Add public declaration probes plus runtime probes for the one- and two-argument
table renderer. Do not retain the old mandatory-alias signature as an overload.

### 1.5 Migration contract changes

These user-visible migration changes are part of the feature and must be
documented together rather than hidden in implementation notes:

- journal version 3 replaces its top-level dialect with the migration-estate
  target; version 2 is refused, with no alias, legacy reader, or automatic
  upgrader;
- `MigrationTarget` and the version-3 `MigrationJournal` shape are exported from
  `viborm/migrations`, because the public storage driver and journal accessors
  name those types;
- `MigrationContext` and its standalone `MigrationContextOptions` type stop
  being exported from `viborm/migrations`. The context is an internal
  command-composition owner, not a supported low-level execution API; its
  options remain an internal base for the concrete public command-option types.
  Retaining the raw, lock, tracking, and statement methods publicly would bypass
  the one target/capability admission boundary. No compatibility export remains;
- PostgreSQL estates bind their schema because their generated SQL is
  schema-qualified; MySQL estates stay database-relative and can be deployed to
  different database names;
- every MySQL migration command that reaches live state requires a resolved
  `namespace`; every effectful or concurrency-stable live decision additionally
  requires a non-redirecting migration-namespace attestation. Admitted
  read-only live work requires the namespace but not the attestation. An
  absent-journal storage-only return, offline generation, and unqualified
  runtime use require neither fact;
- `push()` and `push({ forceReset: true })` synchronize only the live namespace
  and never read or mutate migration storage;
- `status()` and `pending()` become genuinely read-only and never create the
  tracking table;
- PostgreSQL migration reset safely refuses a generated history containing an
  enum-addition commit boundary before destructive work;
- MySQL migration reset and force-reset preflight completely but report their
  unavoidable partial-commit boundary honestly because MySQL DDL implicitly
  commits; and
- Neon HTTP supports schema-aware runtime, read-only, and offline migration
  paths, but effectful push/migration verbs and concurrency-stable dry
  down/reset/squash decisions require a session-capable driver. PlanetScale
  supports runtime qualification plus admitted read-only and offline migration
  paths, but every effectful push/migration verb is refused because it never
  exposes the stock MySQL2 attestation option and neither an explicit qualifier
  nor a reserved session proves containment across Vitess schema-routing rules.

The ORM is unreleased, so no compatibility spelling or legacy journal reader is
retained.

### 1.6 Independent PostgreSQL schema estates

The supported PostgreSQL composition includes tenants whose schemas are
genuinely different, not only repeated copies of one model graph. Each estate
has four independent inputs:

```ts
const acme = createClient({
  schema: acmeModels,
  driver: new PgDriver({
    pool: sharedPool,
    namespace: "tenant_acme",
  }),
});
```

- `schema` supplies that estate's exact VibORM model graph;
- `namespace` selects the PostgreSQL schema containing those objects;
- one migration storage root owns that namespace-bound journal and artifact
  history; and
- one immutable client/driver view binds the three while it may share an
  externally owned connection pool with other estates.

The model graph and namespace are independent facts. Changing `namespace`
never changes the model graph, and supplying a different model graph requires
no namespace feature beyond this binding. Generated PostgreSQL artifacts and
journals intentionally retain the exact namespace, so applying tenant A's
estate to tenant B is refused after at most lock acquisition/release and the
authoritative journal read, but before snapshot/artifact reads, tracking, DDL,
other provider work, or any storage write.

This composition provides SQL-name and migration-estate containment inside one
PostgreSQL database. It does not claim separate compute, WAL, backup, failure,
or database-level security boundaries. PostgreSQL roles and grants remain
deployment concerns. VibORM does not create schemas, discover tenants, switch a
client between namespaces, cache a tenant-client registry, or infer static
types for model graphs that do not exist in application code.

## 2. One runtime owner

### 2.1 Adapter-owned immutable value

Add one optional readonly database-namespace fact to `DatabaseAdapter`:

```ts
interface DatabaseAdapter {
  readonly namespace?: string;
  // existing capabilities
}
```

`PostgresAdapter` narrows the property to a required `string` and defaults its
constructor input to `"public"`. `MySQLAdapter` exposes the normalized string
when one was resolved and `undefined` otherwise. SQLite adapters omit it. Each
driver creates its adapter with the selected primitive and does not store a
second normalized copy.

TypeScript `readonly` is not runtime immutability. Install the adapter property
as non-writable and non-configurable. Do not freeze the whole adapter: drivers
currently configure vector and geospatial capabilities after construction.

Install each stock PostgreSQL/MySQL driver's exact adapter reference as
non-writable and non-configurable too. Query rendering, migration binding, cache
scope, instrumentation, and transaction views must all read that same object;
otherwise hostile JavaScript could bind a cache scope and then replace the
driver adapter before SQL execution. Add assignment and `defineProperty`
falsifiers for both the namespace and adapter reference. Custom drivers remain a
trusted public contract; do not pretend to introspect their renderer or add a
second runtime verification query.

A custom driver with PostgreSQL dialect must supply a schema-bound adapter with
a present normalized `namespace`; its matching table renderer is an
explicit trusted-adapter obligation. Client/migration construction refuses an
absent value instead of silently assuming `public`. Only `PostgresAdapter` owns
the public default. This prevents runtime SQL from following a custom adapter's
search path while migrations alter `public`.

A custom MySQL driver may deliberately supply an unbound adapter and preserve
the existing provider-selected runtime mode. Once it supplies a namespace, ORM
SQL must qualify with it. Live migration construction requires the string and
refuses an unbound adapter; it never calls `DATABASE()` to invent the missing
fact.

This location is intentional:

- the adapter already owns dialect identifier syntax;
- `TransactionBoundDriver` shares the exact base adapter, so transactions and
  savepoints inherit the value without forwarding another field;
- native and fallback batches execute SQL already rendered by that adapter;
- cache and instrumentation can inspect the same immutable fact;
- supplied pools and clients work without changing provider connection state.

Do not add the value to `ModelState`, `QueryScope`, resolved relation slots,
operation fragments, pending operations, extension state, or provider result
objects.

### 2.2 One persistent-table renderer

Change the existing identifier contract from:

```ts
table(tableName: string, alias: string): Sql;
```

to:

```ts
table(tableName: string, alias?: string): Sql;
```

Move the existing dialect identifier quoter into one concern-named SQL module
and add one pure string primitive there:

```ts
renderQualifiedIdentifier(quoteIdentifier, namespace, object): string;
```

It quotes and combines namespace/object components once. Runtime adapters wrap
its string in `Sql`; PostgreSQL/MySQL migration drivers consume the same string.
The migration drivers still own which SQL positions are tables, indexes, enums,
or constraints, but they do not reimplement namespace composition. Delete their
superseded qualified-name concatenation paths.

`createIdentifiers()` accepts an optional prevalidated database namespace,
prequotes it once through that primitive, and renders:

```text
PostgreSQL: "billing"."user" AS "u"
MySQL:      `billing`.`user` AS `u`
MySQL none: `user` AS `u`
SQLite:     "user" AS "u"
```

Without an alias it emits only the qualified or escaped table identifier.
`identifiers.table()` becomes the query engine's sole entry for persistent model
and junction tables. `identifiers.escape()` remains the owner for one
identifier: a column, alias, CTE, constraint, or other statement-local name.

Move every current physical-table use from `escape()` to `table()`, including:

- create, update, delete, upsert, and bulk values;
- ordinary reads and mutation projections;
- ordinary relation traversal;
- implicit, explicit, self, and variant junction reads and writes;
- polymorphic row targets;
- relation filters, counts, aggregates, and nested writes.

The model and relation layers continue to publish bare table names. `.map()`
and `.through()` still choose object names; the adapter namespace supplies only
the enclosing PostgreSQL schema or MySQL database. Generated junction names
never contain namespace text.

### 2.3 Statement-local exceptions

Do not route non-persistent names through the namespace-aware table renderer.

In particular, the mutation projection currently treats its CTE as a table.
Render it as an escaped identifier plus alias instead:

```ts
adapter.identifiers.aliased(
  adapter.identifiers.escape(MUTATION_CTE),
  rootAlias,
);
```

The result must remain:

```sql
WITH "__viborm_mutation" AS (
  UPDATE "billing"."user" ...
)
SELECT ... FROM "__viborm_mutation" AS "t0"
```

Also keep unqualified:

- CTE names;
- aliases and derived-query aliases;
- columns and constraints;
- the connection-local `__viborm_batch_refs` temporary table;
- provider-internal names that the dialect adapter already owns.

### 2.4 Raw SQL and statement extensions

Raw SQL remains caller-owned:

- tagged or prebuilt `Sql` is not rewritten;
- unsafe/verbatim raw strings are not rewritten;
- internal safe-raw classification does not imply identifier rewriting;
- users qualify raw table names themselves.

A trusted statement extension receives already-qualified ORM-generated `Sql`
exactly once. It may replace that SQL under the existing statement-extension
contract. No extension API changes and no second qualification pass are
permitted. Runtime execution emits neither hidden `SET search_path` nor hidden
`USE` statements.

## 3. One estate target and one live namespace

Runtime qualification alone is insufficient. Migration storage must prove that
its artifacts and snapshots are compatible with the configured dialect, while
live database work must use the adapter's exact namespace.

Those facts coincide for PostgreSQL because generated artifacts contain the
schema. They intentionally differ for MySQL because generated artifacts remain
database-relative. This is not two owners for one value: `MigrationTarget`
describes the durable estate's declared compatibility (enforced for generated
artifacts and author-owned for manual ones), while
`adapter.namespace` describes the live execution destination.

### 3.1 Target value

Introduce one discriminated migration target:

```ts
type MigrationTarget =
  | { readonly dialect: "postgresql"; readonly namespace: string }
  | { readonly dialect: "mysql" }
  | { readonly dialect: "sqlite" };
```

Export this readonly type from `viborm/migrations` together with the exact
version-3 `MigrationJournal` shape. The resolved runtime value remains an
internal frozen object; exporting its type adds no target factory, mutable
configuration source, or second representation.

`resolveMigrationTarget(driver)` derives one frozen estate target from the
concrete driver's dialect and adapter. A custom PostgreSQL driver whose adapter
does not expose a namespace is unproven and refused; it must not silently
acquire the `"public"` default. The PostgreSQL arm copies the already-normalized
adapter string into the durable target because generated SQL contains it.

The MySQL arm deliberately contains only the dialect. Snapshots, diffs, and
generated up/down SQL are database-relative, so the same estate can deploy to
`app_dev`, `app_test`, and `app_prod` when its history is generated. Manual
artifact portability remains the author's claim, not something the journal can
prove. The bound MySQL migration driver still retains the exact adapter
reference. Before any live operation it requires
`adapter.namespace`; it does not persist that environment value in the
journal or rediscover it through `DATABASE()`.

Target resolution does not turn a MySQL namespace into routing proof. The
existing first-live-capability admission owner receives the exact execution
driver together with the bound migration driver. For a MySQL command that can
write or that promises a concurrency-stable live decision, it requires both a
present adapter namespace and
`driver.migrationNamespaceAttestation === "non-redirecting"`. Its failure
precedence is exact: an absent attestation is `DRIVER_NOT_SUPPORTED`; after the
capability is admitted, an absent namespace is `MIGRATION_INVALID_STATE`. This
keeps PlanetScale unconditionally unsupported while preserving missing-target
semantics for an attested MySQL2/custom driver and for read-only live commands.
A storage-backed verb may first perform one pre-admission journal probe and
validate its target when present. An absent journal may take the documented
storage-only return. Once a present journal establishes that live work is
required, the gate runs before every further storage read, every storage write,
lock acquisition, provider work, and snapshot or artifact read. After acquiring
the lock, the command rereads and validates the journal; this second read is the
authoritative input to the effectful/stable-live program and catches a change
while admission or lock acquisition was in progress. Direct push has no journal
and gates immediately.
Read-only point-in-time commands and offline/artifact-only commands do not pass
through this effectful gate. There is no provider-name fallback: a MySQL2 driver
without the assertion stays unproven, while a trusted custom MySQL driver may
make the same explicit assertion.

Extend the existing `DDLContext` with one required destination fact:

```ts
interface DDLContext {
  readonly destination: "artifact" | "live";
  // existing currentSchema and precedingOperations
}
```

This is the existing DDL renderer's missing input, not a second migration
driver. Generation and generated rollback pass `"artifact"`; push, live reset,
and every immediate DDL path pass `"live"`. PostgreSQL renders its schema in
both modes. MySQL renders database-relative artifact SQL and qualified live SQL.
SQLite ignores the distinction and stays byte-identical. Make the base dispatch
pass the same context to every operation renderer; do not add a mutable mode to
a singleton or a parallel artifact driver.

Registry binding passes this exact frozen object to the migration driver.
The internal `MigrationContext` reads `migrationDriver.target` (or retains the
same object by identity); it must not construct another estate target. Each
bound migration driver retains the exact concrete execution driver and adapter
references for live admission and namespace rendering. It reads the driver's
immutable attestation at the admission boundary; it does not copy it into the
migration target or another capability record. The PostgreSQL binding also
reads its existing `supportsVector` plus new `supportsGeospatial` capabilities when
classifying extension-owned catalog types. It does not copy or independently
configure the namespace.
Generate, push, preview, apply, down, status, pending, squash, reset, and the
migration-client accessors must all reach the same resolver. Delete repeated
driver-name/dialect/namespace decisions.

The migration driver registry remains the dialect implementation registry, but
lookup binds the selected target before returning a driver. SQLite may retain
its stateless singleton. PostgreSQL and MySQL return immutable adapter-bound
drivers, even when MySQL is unbound for artifact-only use. Never mutate a
registered singleton or put an active namespace in module-level state.

### 3.2 Journal binds the estate

Change the migration journal to version `"3"`:

```ts
interface MigrationJournal {
  readonly version: "3";
  readonly target: MigrationTarget;
  readonly entries: readonly MigrationEntry[];
}
```

```json
{
  "version": "3",
  "target": {
    "dialect": "postgresql",
    "namespace": "billing"
  },
  "entries": []
}
```

Replace the independent top-level `dialect` field with `target`; do not permit
both representations. MySQL and SQLite targets contain only their dialect.
`createEmptyJournal()` and `MigrationStorageDriver.getOrCreateJournal()` accept
the exact target, not a dialect plus optional schema. Delete every dialect-only
journal writer, including force-reset's current hardcoded version.

The storage driver remains the single structural journal parser. One internal
`MigrationContext` method becomes the single exact-estate-target gate: it reads
the journal, compares it with the resolved target, and returns only a matching
journal. Remove the separate `validateJournalDialect()` path. The class itself
is not exported, so raw execution, tracking writes, lock control, and parsed
migration-statement execution have no public route around that gate.

Use existing errors:

- a dialect mismatch remains `MIGRATION_DIALECT_MISMATCH`;
- a PostgreSQL schema mismatch, missing target, unsupported journal version, or
  inconsistent journal/snapshot estate is `MIGRATION_INVALID_STATE`.

For MySQL, changing `namespace` does not mismatch the journal: portability is
the contract. After a present journal or another path establishes that live
state is needed, an unbound database is `MIGRATION_INVALID_STATE` before any
provider call or storage write. A no-journal storage-only return does not require
a live target. Do not invent a second persisted execution-target document.

There is no version-2 reader or migrator. The ORM is unreleased.

Every high-level migration verb and client accessor must validate the journal
target before it reads a snapshot, creates or queries a tracking table, writes
an artifact, or executes target-specific/tracking/DDL SQL. A command whose
authoritative read occurs under a migration lock may execute only
the non-durable lock statement first; a mismatch still permits zero tracking,
DDL, artifact, or snapshot effect. In particular:

- generation reads and validates the journal before the previous snapshot,
  including no-op generation;
- apply validates before `ensureTrackingTable()`;
- `list()`, `journal()`, `snapshot()`, and `read()` use the bound context rather than
  reading storage independently;
- status and pending with a present matching journal first prove the configured
  namespace exists, then use a genuinely read-only tracking query. Only after
  that proof may they translate
  PostgreSQL SQLSTATE `42P01`, or MySQL missing-table error for the exact
  qualified tracking table, into an empty applied set; target mismatch, missing
  namespace, permissions, transport, and every other tracking failure surface.
  `ensureTrackingTable()` remains exclusively inside locked effectful owners
  such as apply.

SQLite has no namespace proof, but it participates in the read-only tracking
contract: one exact `sqlite_schema` lookup distinguishes an absent configured
tracking table from other failures. Status, pending, and dry down/squash reuse
that same applied-state reader and never call `ensureTrackingTable()`. This is a
read-only migration correction, not a SQLite namespace feature.

The exact journal/snapshot consistency algorithm is:

| Journal | Snapshot | Verdict |
| --- | --- | --- |
| absent | absent | fresh estate; use an empty in-memory baseline |
| absent | present | refuse; the snapshot has no target proof |
| matching, empty | absent | valid target-bound empty estate |
| matching, any | present | valid after both documents pass their normal structural checks |
| matching, non-empty | absent | refuse; migration history has lost its baseline |
| mismatched or invalid | either | refuse before snapshot deserialization |

Generation performs this read-only gate before `getSnapshotOrEmpty()` and
before its no-op return. It creates a journal only when it will write a
migration or a metadata-only snapshot; a fresh no-op does not create an estate.

`migrations.storage` remains the deliberately low-level caller-owned storage
escape. It may inspect arbitrary storage without a client target and therefore
is excluded from the high-level isolation guarantee; it cannot execute database
effects. All named migration-client operations, including `read(entry)`, use
the target gate. `read(entry)` additionally requires a matching journal and an
exact journal member before it reads the artifact; a fresh estate or caller-
fabricated entry cannot turn it into another unbound storage reader.

Snapshots and `DiffOperation` remain schema-relative. Adding the same namespace
to every `TableDef`, `EnumDef`, and operation would duplicate the estate target
and pollute the dialect-neutral differ.

### 3.3 Existing namespace, not infrastructure provisioning

VibORM creates or drops neither a PostgreSQL schema nor a MySQL database. A
catalog-driven operation must distinguish a configured but nonexistent or
invisible namespace from an existing namespace containing zero managed objects;
otherwise it can fabricate an empty snapshot or successful reset. An unbound
MySQL adapter is a separate earlier failure and makes no catalog call.

The bound migration driver owns this proof. Fold it into the first inventory
query where that stays clear, or use one catalog existence query. Do not
duplicate it before a qualified statement that already fails loudly.

For PostgreSQL:

- public `introspect`, push including dry-run, force-reset, and reset paths that
  inventory objects prove schema existence before publishing an empty result or
  dispatching DDL;
- apply, down, and squash first validate a present journal, then let their first
  qualified tracking/DDL statement own SQLSTATE `3F000` and translate it to
  `MigrationError(MIGRATION_INVALID_STATE)`;
- status and pending with a present matching journal first prove `pg_namespace`,
  because PostgreSQL may report a missing schema and a missing tracking table as
  the same `42P01`; only after that proof may exact-table `42P01` mean zero
  applied migrations.

For MySQL:

- before the first live call, require the adapter's bound `namespace`;
- parameterize one `information_schema.SCHEMATA` existence proof with that exact
  value before an empty inventory can be published;
- status and pending with a present matching journal prove the database first,
  then translate only the exact qualified tracking table's missing-table error
  into an empty applied set;
- never use `DATABASE()` as the proof and never accept a supplied pool/client's
  ambient default as an implicit migration target.

Absent-journal behavior is exact and occurs after only the pre-admission journal
probe:

| Command | Result with no journal |
| --- | --- |
| `apply()` / `apply({ dryRun: true })` | `{ applied: [], pending: [] }` |
| `down()` | `{ rolledBack: [] }` |
| `reset()` | `{ dropped: [], applied: [] }` |
| `status()` / `pending()` | Their existing empty read-only result |
| `squash()` including dry-run | `MIGRATION_NOT_FOUND` |

None connects, acquires a lock, reads a snapshot/artifact, or writes storage in
those arms. Offline generate and preview validate storage state but never
connect solely to prove namespace existence. Push has no journal: dry-run and
every other path that introspects are live and therefore require namespace
proof; non-dry push/force-reset also run the attestation gate before their first
provider call.

Replace `MigrationContext.getAppliedMigrations()` with one internal
`readAppliedMigrations()` owner that never creates the tracking table. It uses
the exact missing-table translation defined above for read-only callers.
`ensureTrackingTable()` remains a distinct internal write and is reachable only
after effectful admission, inside apply's locked owner. This removes the current
read-that-writes ambiguity rather than guarding it twice.

An explicitly configured but nonexistent or invisible namespace fails as
`MigrationError(MIGRATION_INVALID_STATE)` with the normalized namespace in safe
metadata. It must not become an empty database, a successful no-op, a storage
write, or a reset.

### 3.4 Generated and manual migration SQL

Generated PostgreSQL migration SQL is intentionally bound to the configured
schema. A journal produced for schema `billing` cannot be applied as an estate
for schema `public`.

Generated MySQL migration SQL is intentionally database-relative. The live
executor acquires one pinned session and reasserts the validated target with a
`USE <quoted-database>` statement immediately before every up, down, or reset
artifact. It keeps that session through artifact execution and tracking. This
per-artifact boundary is mandatory because an earlier trusted manual artifact
may change session state. The control statement is generated by the bound
migration driver; it is not written into the artifact and it never enters
runtime ORM execution. Live push/reset DDL and every tracking-table reference
remain explicitly qualified, so catalog and administrative work cannot drift
to an ambient default.

Manual migration artifacts remain author-owned trusted SQL and are not
rewritten. They may deliberately address another schema/database, select a
MySQL database for their own statements, or depend on `search_path`, just as a
statement extension may deliberately replace ORM SQL. Documentation must require
authors to qualify objects they intend to pin. Journal matching and the
executor's target selection cannot infer, enforce, or claim containment or
portability for arbitrary manual SQL. A manual MySQL artifact may retarget
itself, but that state cannot affect the next artifact because the executor
reasserts the configured target first. Executor-owned transaction and lock
controls are the safety exception classified in §3.5.

### 3.5 One pinned migration session

PostgreSQL advisory locks and MySQL named locks are session-scoped. The current
code can acquire through one pooled connection, run protected work through
others, and release through another; that protects nothing and can strand the
lock. MySQL also ignores `GET_LOCK()` results, treating timeout (`0`) and error
(`NULL`) as success.

The unavoidable requirement is one physical producer across decisions and
commit boundaries. Extend the existing driver owner with one internal final
`_withPinnedSession(callback)` entry and one protected provider hook. The
default hook is unsupported, so custom drivers gain no new abstract obligation.
Stock providers bind it as follows:

| Provider | Pinned producer |
| --- | --- |
| `pg` | one `PoolClient` from `pool.connect()` |
| postgres.js | one `reserve()` result |
| PGlite | its single client under the existing driver queue |
| Bun SQL | one `reserve()` result; transaction control uses it too |
| Neon HTTP | unavailable; the stateless HTTP API has no interactive session |
| MySQL2 | one `PoolConnection` from `pool.getConnection()`, admitted for effectful work only after the non-redirecting namespace attestation |
| PlanetScale | unavailable for effectful migration containment; session identity cannot neutralize VTGate schema-routing rules |

This new seam is only for PostgreSQL and MySQL commands that need a session
lock. SQLite3, Bun SQLite, libSQL, and D1 retain their existing queue,
transaction, and native-batch ownership; the default unsupported hook must not
become a regression for them.

`MigrationContext.withLockedSession()` calls that driver entry, creates one
context bound to the returned producer, acquires the dialect lock through it,
passes that exact context to the callback, and unlocks through the same producer
in `finally`. The callback may cross transactions without releasing the session
lock. If unlock or session cleanup fails, the provider owner discards/closes the
producer rather than returning a session carrying unknown state. Do not add a
second pool, connection manager, or public session API.

MySQL2 always destroys the pinned migration `PoolConnection` after the unlock
attempt instead of returning it to either an owned or supplied pool. The session
has executed `USE` and may have executed author-owned statements; mysql2 release
does not reset arbitrary session state. This cleanup is correctness, not an
optional optimization.

PostgreSQL retains its database-wide advisory-lock key. MySQL derives a stable
database-specific lock name from a conservative lowercase form of the normalized
target and a deterministic hash, kept within MySQL's 64-character lock-name
limit. This may serialize distinct case-sensitive databases unnecessarily, but
it cannot let two spellings of one `lower_case_table_names` database run
concurrently. Only a parsed numeric `1` from
`GET_LOCK()` means acquired; `0`, `NULL`, malformed rows, or provider errors are
`MIGRATION_LOCK_FAILED`. Emit stable `AS acquired` / `AS released` aliases and
have the existing migration lock owner inspect the pinned driver's returned row
instead of discarding `executeRaw()` output. `RELEASE_LOCK()` must likewise prove
release. PostgreSQL emits a stable unlock alias too and accepts exactly one
boolean `true` from `pg_advisory_unlock`; `false` or malformed output fails
cleanup and discards the producer. MySQL reasserts target `USE` immediately
before every relative artifact, never only once for the session.

The lock SQL is the sole provider operation allowed before the authoritative
under-lock journal read. It is non-durable. A journal mismatch after acquisition
unlocks/releases and causes zero tracking, DDL, artifact, or snapshot effects.

Every command that mutates or must make a concurrency-stable decision from live
state uses this owner. PostgreSQL keeps these transaction boundaries:

| PostgreSQL verb | Work while the session lock is held |
| --- | --- |
| effectful `apply()` | reread authoritative state before each entry; execute and mark one entry in one transaction, commit, then continue |
| effectful `down()` | preflight and execute the selected rollback group in one transaction |
| effectful migration `reset()` | preflight every artifact, then clear and replay in one transaction; refuse known enum commit-boundary histories before DDL |
| ordinary effectful `push()` | inventory and plan under lock; preserve the committed enum-addition phase followed by the transactional remainder |
| effectful force-reset push | compile before entry; inventory, clear, and rebuild in one transaction |
| `squash()` | keep database preflight and artifact publication under lock; retain its existing tracking transaction |

`apply()` deliberately does not hold one PostgreSQL transaction across all
entries. This preserves histories where migration A adds an enum value and B
uses it. PostgreSQL reset preflights and refuses generated
`ALTER TYPE ... ADD VALUE` histories that cannot be replayed atomically.
Before any artifact effect, one manual-artifact execution-safety classifier
rejects controls that can invalidate the executor's transaction, tracking, or
session lock:

- PostgreSQL refuses every transaction-control statement, including
  `BEGIN`/`START TRANSACTION`, `COMMIT`/`END`, `ROLLBACK`/`ABORT`, `SAVEPOINT`,
  and `RELEASE`, plus every `pg_advisory_*` acquisition, probe, or release
  function, including shared variants;
- MySQL refuses transaction/XA control, `SET autocommit`, table lock/unlock, and
  every named-lock function, including `GET_LOCK`, `RELEASE_LOCK`,
  `RELEASE_ALL_LOCKS`, `IS_FREE_LOCK`, and `IS_USED_LOCK`. A manual `USE` remains
  allowed for that artifact because the executor reasserts its target before
  the next one.

Extend the existing statement classifier; do not add an execution-time second
guard. Trusted manual SQL may own object effects, but it cannot terminate or
reframe VibORM's rollback/tracking boundary or release VibORM's session lock.

An attested, namespace-bound MySQL2 driver uses the same lock/session owner but
does not pretend DDL is transaction rollback-safe. The attestation gate runs
before reserving the producer; owning a `PoolConnection` proves session
identity, not qualifier routing, and cannot replace the assertion. MySQL
documents DDL as implicitly committing; see
[Statements That Cause an Implicit Commit](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html).
Before the first DDL, every effectful MySQL verb validates the journal, proves
database existence, inventories cross-database dependencies, parses all needed
artifacts, and computes the complete operation program. It then executes in a
deterministic order and updates tracking only after each complete artifact.
The MySQL artifact owner executes statements sequentially through the pinned
producer; it does not call the generic `_executeBatch()` or open a transaction
that could acquire another pool connection. The preflight classifier refuses
manual transaction/session-lock control, and the ORM does not describe
surrounding MySQL DDL as atomic.
Failure surfaces the original cause and explicit partial-commit reality; it must
not claim that earlier DDL rolled back. Never wrap MySQL DDL in a transaction to
manufacture false atomicity, and never scatter `USE` or
`FOREIGN_KEY_CHECKS` across pooled calls.

Dry down/reset/squash decisions that depend on tracking or inventory use one
locked read-only session. Push dry-run, status, and pending are point-in-time
reads without the advisory lock. Generate, preview, apply dry-run, and storage
accessors are offline/storage-only and take no database lock.

Neon HTTP cannot satisfy the PostgreSQL protocol. It supports qualified runtime,
read-only introspection, push dry-run, generate, preview, apply dry-run, status,
pending, and storage accessors; effectful push/apply/down/reset/squash and live
dry down/reset/squash fail `DRIVER_NOT_SUPPORTED` without provider calls or
storage writes beyond an already-completed target gate.

PlanetScale effectful migration and push support remains disabled in this
program. A reserved Vitess session could prove lock ownership but not that
VTGate leaves fully qualified table references in the requested keyspace;
schema-routing rules can redirect them. Runtime keyspace qualification, offline
generation, and admitted read-only paths remain available, but they describe
the logical routed view and make no physical-containment claim. Safe-migration
DDL refusal remains an additional provider policy, not namespace logic.

The same refusal applies when a `MySQL2Driver` reaches Vitess through its normal
MySQL protocol unless the caller supplies the explicit non-redirecting
attestation. VibORM never treats the MySQL2 class, a successful handshake,
server-version text, URL shape, host name, or resolved database option as
negative proof that VTGate is absent. This closes the alternate-driver path
without inventing provider detection.

Add real concurrency falsifiers for PostgreSQL and MySQL2. The second same-target
command must wait across the first command's commit boundaries; final unlock
must leave no lock on the producer. Two different MySQL databases use different
lock keys and need not block each other.

## 4. PostgreSQL DDL and introspection

### 4.1 Qualification rules

The schema-bound `PostgresMigrationDriver` owns PostgreSQL's positional DDL
rules and consumes §2.2's one qualified-identifier primitive consistently.

| SQL position | Required rendering |
| --- | --- |
| Table in `CREATE`, `ALTER`, `DROP`, `TRUNCATE` | `"schema"."table"` |
| Foreign-key target | `REFERENCES "schema"."table"` |
| ORM-managed enum type | `"schema"."enum"` |
| Migration tracking table | `"schema"."_viborm_migrations"` |
| `CREATE INDEX` target table | `ON "schema"."table"` |
| `CREATE INDEX` index name | `"index"` |
| `DROP INDEX` index name | `"schema"."index"` |
| Constraint and column name | one unqualified identifier |
| `ALTER TABLE ... RENAME TO` new table name | one unqualified identifier |
| `ALTER TYPE ... RENAME TO` new type name | one unqualified identifier |

PostgreSQL does not allow the index name in `CREATE INDEX` to include a schema;
the index is created in the target table's schema. The target table may be
schema-qualified. See [`CREATE INDEX`](https://www.postgresql.org/docs/current/sql-createindex.html).

Apply these rules to:

- create, alter, rename, and drop table operations;
- primary, unique, check, and foreign-key operations;
- create and drop index operations;
- enum creation, addition, recreation, casts, renames, and drops;
- tracking-table create/select/insert/delete/clear statements;
- table and enum inventory used by reset;
- partial-index predicate canonicalization.

Only ORM-managed enum identifiers gain the configured schema. Delete the
current `_enum` suffix guess: an explicitly named enum such as `state` is no
less managed, and an arbitrary type token cannot prove enum ownership.

Derive the managed enum-name set from `DDLContext.currentSchema.enums` plus the
preceding enum operations already materialized in that DDL batch. Pass
`DDLContext` through create-table, add-column, and column-type rendering, then
qualify a column type only when its base type is in that set. The same rule
handles enum arrays. This keeps `ColumnDef` and snapshots namespace-relative and
does not add a second enum marker.

Built-in PostgreSQL types and existing supported extension scalar spellings
such as `vector`, `geometry`, and `geography` keep their current type renderer;
do not blindly prefix every type token.

### 4.2 Introspection

Remove every executable hardcoded `public` filter from PostgreSQL
introspection. Bind the adapter-owned schema as a query parameter; never
interpolate it into a catalog predicate.

Every relevant catalog query must use the same target:

- tables and columns;
- primary, unique, and check constraints;
- foreign keys;
- indexes and predicates;
- enum types and values.

Read enough catalog identity to avoid silently collapsing external objects:

- include the referenced table's schema for foreign keys;
- add one `pg_constraint` dependency inventory joining `conrelid` and
  `confrelid` through both `pg_class`/`pg_namespace` pairs, selecting a foreign
  key when either side is in the target and the other is not; do not try to
  infer inbound dependencies from the existing target-owned FK query;
- include `udt_schema` for column types;
- distinguish managed enums in the selected schema from built-ins;
- join type dependency identity through `pg_depend` and `pg_extension`, and
  accept the existing adapter-supported pgvector/PostGIS scalar types even when
  their owning extension lives in another schema;
- refuse only an otherwise unrepresentable external enum, domain, composite,
  or user-defined type rather than pretending it belongs to the selected
  schema.

V1 supports one schema, so an inbound or outbound foreign key crossing the
target boundary is an unsupported migration topology. Push, introspection, and
reset must run the dependency inventory before publishing a snapshot or
dispatching DDL, then fail with both schemas named. The provider call ledger
must show catalog reads and zero DDL. Runtime raw SQL may still use such
database objects; the refusal is about migration ownership.

Extension-owned types and functions are provider objects, not VibORM-owned
schema objects. Known pgvector/PostGIS types keep their existing unqualified
runtime and DDL spelling and therefore still require PostgreSQL to resolve the
installed extension. Unknown extension types remain unrepresentable and are
refused. Do not introduce another schema setting for extensions in this
program.

Do not reduce an admitted extension type to `udt_name`. Read
`pg_catalog.format_type(atttypid, atttypmod)` beside its catalog provenance,
remove only the proven extension-schema prefix, and preserve all modifiers and
array structure. Required controls include `vector(3)` and
`geometry(Point,4326)`. A first custom-schema push followed by a second push
must not churn either type.

### 4.3 Canonicalization and convergence

Two existing PostgreSQL canonicalizers need the selected namespace:

1. Partial-index predicate canonicalization must create its temporary view over
   `"schema"."table"`, not a bare table that depends on `search_path`.
2. Enum-default normalization uses the column's catalog-proven `udt_schema`,
   `udt_name`, and managed-enum identity. It strips only a terminal cast that
   exactly names that enum in the configured schema, including its array form.
   It preserves parenthesized expressions and unrelated built-in, extension,
   domain, and composite casts byte-for-byte. Do not replace the current regex
   with a broader text-only regex.

Required convergence controls include defaults such as:

```sql
'active'::"billing"."state_enum"
```

and partial predicates on a table that exists with the same name in two
schemas. The second push must be empty.

PostgreSQL `SERIAL`/`BIGSERIAL` sequences remain table-owned and naturally live
in the selected schema. Introspection must continue to remove their
schema-qualified `nextval(...::regclass)` implementation default so it does not
drift. Dropping the owning table removes its owned sequence; standalone
sequences remain unmanaged and survive reset. Do not claim identity-column
support unless the current DDL surface actually emits it.

## 5. MySQL DDL and introspection

### 5.1 Qualification rules

The adapter-bound `MySQLMigrationDriver` owns MySQL's positional DDL rules and
selects live qualified versus artifact-relative table spelling only from
`DDLContext.destination`. Live spelling consumes §2.2's one
qualified-identifier primitive.

For live SQL:

| SQL position | Required rendering |
| --- | --- |
| Table in `CREATE`, `ALTER`, `DROP`, `TRUNCATE` | `` `database`.`table` `` |
| Foreign-key target | ``REFERENCES `database`.`table` `` |
| Migration tracking table | `` `database`.`_viborm_migrations` `` |
| `CREATE INDEX` target | ``CREATE INDEX `index` ON `database`.`table` `` |
| `DROP INDEX` target | ``DROP INDEX `index` ON `database`.`table` `` |
| Rename table | ``RENAME TABLE `database`.`old` TO `database`.`new` `` |
| Enum replacement update | ``UPDATE `database`.`table` ...`` |
| Constraint, column, and index name | one unqualified identifier |

Quote the database and object separately. Never pass `database.table` to
`escapeIdentifier()`, which would produce one wrong identifier. MySQL enum
columns remain inline column types; there is no standalone enum namespace.

Apply the live renderer to every push/reset operation, base-owned drop helper,
tracking-table helper, enum replacement update, and table-list query. Temporary
tables and statement-local aliases remain unqualified. Do not emit `USE` for
live push/runtime SQL; explicit qualification is authoritative there.

For generated artifacts, the same operation emitters use the relative renderer:

```sql
CREATE TABLE `user` (...);
ALTER TABLE `post` ADD CONSTRAINT ... REFERENCES `user` (`id`);
```

The up and inverted-down artifacts must be byte-identical when generated from
the same snapshots under two different MySQL database names. Push SQL is
expected to differ because it is an immediate live-target program.

### 5.2 Catalog targeting and dependency containment

Replace every MySQL migration query using `DATABASE()` with a parameterized
exact database value. This includes tables, columns, primary and unique
constraints, checks, foreign keys, indexes, enum-column metadata, table lists,
and any canonicalization query. The configured name is data in catalog
predicates, never interpolated SQL.

Before an empty snapshot is legal, query `information_schema.SCHEMATA` and prove
the configured database resolves to exactly one visible catalog row. A missing
database is not an empty database. Preserve the catalog's returned spelling in
comparisons; do not apply an ad hoc case fold after configuration validation.

Because `lower_case_table_names` can make a differently cased configured value
name the same physical database, resolve case-insensitive candidates, prefer the
single byte-exact row when present, and otherwise require exactly one candidate.
Use its returned `SCHEMA_NAME` as the command-local catalog spelling for every
subsequent filter and dependency comparison; an ambiguous case-only pair is
refused. This is a projection of the adapter target under the live server's
identity rules, not a second stored namespace; it disappears with the migration
context. Runtime/live DDL continues to quote the immutable configured spelling.

Strengthen foreign-key inventory through `KEY_COLUMN_USAGE`:

- select both `TABLE_SCHEMA` and `REFERENCED_TABLE_SCHEMA`;
- inspect constraints where either side is the selected database;
- admit only rows where both sides equal that database;
- refuse inbound and outbound cross-database foreign keys before publishing a
  snapshot, planning reset, or emitting DDL;
- include both database/table endpoints in safe error metadata.

Only after that proof may introspection discard the catalog schema columns and
publish the existing database-relative `SchemaSnapshot`. Keep table, column,
key, inline-enum, and index canonicalization otherwise unchanged. A first push
followed by a second push must converge to no operations.

Do not promise cross-keyspace foreign keys on PlanetScale. If the provider does
not expose or support the relevant catalog rows, retain its current supported
topology and fail unsupported live migration operations honestly; do not treat
missing evidence as local ownership.

### 5.3 MySQL provider and execution boundaries

MySQL2 live migration work requires two independent facts: one resolved
database from explicit `namespace` or driver-created pool configuration, and
the explicit `migrationNamespaceAttestation: "non-redirecting"`. The first
selects a target; the second asserts that the transport will not reinterpret
that target. A supplied pool without explicit `namespace` remains usable for
unqualified runtime ORM and raw SQL, but cannot become a live migration client
from the attestation alone. Conversely, a resolved namespace without the
attestation remains valid for runtime and admitted read-only/offline work but
is not admitted to effectful or concurrency-stable migration work.

The pinned MySQL2 producer owns, in order:

1. exact `GET_LOCK` acquisition proof;
2. validated target selection for relative artifact execution;
3. authoritative journal/tracking reads;
4. catalog proofs and DDL;
5. exact unlock proof;
6. unconditional connection destruction so selected/manual session state cannot
   return to the pool.

Use the same connection ID in the contract test for all six stages. Do not use
`FOREIGN_KEY_CHECKS=0`; explicitly materialize and drop known internal foreign
keys before destructive table programs. This avoids session leakage and avoids
temporarily admitting invalid data.

For PlanetScale, a present `namespace` is the requested Vitess keyspace
qualifier submitted to VTGate. An absent value preserves unqualified SQL and
provider routing; a PlanetScale database resource name and
`@primary`/`@replica` routing selector never become adapter namespace evidence.
Runtime and deterministic query contracts prove only the emitted SQL qualifier,
not the final backend after routing rules. Every effectful file migration,
push, reset, and destructive live verb refuses `DRIVER_NOT_SUPPORTED` before
provider calls or storage writes. Do not add a session-only admission path.

PlanetScale exposes no attestation option. A hostile JavaScript caller cannot
upgrade it by adding a same-named property to its options or constructed driver:
the base driver owns a non-configurable `undefined` fact. MySQL2 likewise never
derives the assertion from its URL, database option, supplied pool, provider
response, or server metadata.

## 6. Destructive-operation containment

Every provider admitted to effectful migration work must make its namespace a
real containment boundary, not merely a catalog filter followed by `CASCADE`,
`DATABASE()`, disabled foreign-key checks, or a redirectable qualifier.
PlanetScale cannot prove that boundary through VTGate and is therefore excluded
from every effectful path in this section.

### 6.1 Remove broad cascade behavior

Current PostgreSQL reset and some table/type drop paths use `CASCADE`. That can
drop dependants in another schema even when enumeration only selected the
configured schema.

For PostgreSQL:

- extend the existing operation-preparation stage beside
  `extractForwardReferenceForeignKeys` so it materializes every required
  `dropForeignKey` before a dropped-table graph;
- include foreign keys whose owning and referenced tables are both being
  dropped, regardless of emitted table order, including cycles;
- apply this same operation preparation to push SQL, generated up SQL, and the
  inverted generated down SQL;
- drop tables in dependency-safe order;
- drop managed enums after their tables;
- use PostgreSQL's default `RESTRICT` behavior for table and type drops;
- let an unknown external dependency abort the operation;
- execute reset transactionally;
- never issue `DROP SCHEMA`.

For MySQL, reuse the same prepared operation graph to emit explicit internal
foreign-key drops before table drops, including cycles and tables dropped
together. Delete the reset path's `FOREIGN_KEY_CHECKS` toggles. Use only the
selected database's qualified tables and never issue `DROP DATABASE`.

The differ currently omits a foreign-key drop when both tables disappear, so
changing `DROP TABLE ... CASCADE` to `RESTRICT` without this preparation is not
correct. The operation-preparation owner, not either dialect string emitter,
repairs the graph once for push, generated up/down, and reset consumers.

Push-generated destructive DDL follows the same rule. A manual external
dependency that is absent from the snapshot causes a safe database error rather
than collateral deletion.

### 6.2 One live-namespace reset owner

Delete the CLI's independent dynamic reset program and remove
`generateResetSQL()` from `MigrationDriver`, all three dialect implementations,
and their direct string tests. The CLI is its only semantic consumer. Keep CLI
confirmation and presentation in the CLI, but delegate the live-namespace effect
to the same programmatic target-clearing owner used by
`push({ forceReset: true })`.

The migration `reset()` command and push force-reset reuse the same private
inventory and dependency-safe drop routine, but they own different truths. The
routine therefore takes one exact local policy,
`trackingTable: "preserve" | "drop"`, plus the already-normalized tracking-table
name. It is not allowed to infer either fact from whether a storage driver
happens to exist.

`createMigrationClient()` already owns the configured tracking-table name. Its
force-push convenience call passes only that primitive through a private
command-local parameter; direct `push({ forceReset: true })` uses the default
name. Do not add a public push option or pass migration storage. This lets MySQL
clear the declared tracking rows before destructive DDL without guessing which
inventoried table is special. Any other custom-named tracking table not supplied
by the invoking migration client is an ordinary table for that direct push and
receives no tracking-history claim.

**Migration `reset()`** always has storage. Under the locked session it reads
and validates the estate journal, reads and parses every artifact, proves the
live namespace, inventories dependencies, and builds the full replay before
the first DDL. PostgreSQL also uses the existing statement classifier to refuse
a generated history requiring an enum-addition commit boundary. Its one
transaction then:

1. clear selected-schema objects while preserving the qualified tracking table
   structure;
2. clear only the tracking table's rows;
3. replay every validated journal artifact;
4. restore every tracking row.

On PostgreSQL, an artifact, DDL, or tracking failure rolls the entire
transaction back, so the original schema and tracking state survive.

On MySQL, the same preflight completes before the first effect, but DDL commits
implicitly. Its preflight refuses every inbound foreign key to the declared
tracking table, for the same fail-closed reason used by force-reset below. Then
migration reset clears and commits the qualified tracking rows before destructive
DDL, clears internal objects in dependency order, reasserts the target before
each relative artifact, and restores one tracking row only after that artifact
completes. A teardown failure therefore reports every history entry pending
instead of falsely claiming that now-missing objects are applied. A later
failure may leave a partially rebuilt database and possibly a partially executed
current artifact; report that state explicitly. Never claim rollback or restore
tracking for work whose DDL completion is unknown.

**`push({ forceReset: true })`** owns only the live driver target. Before entry,
serialize and validate the desired schema, resolve its relation index, compile
the empty-to-desired DDL, and prove that program contains no commit-boundary
statement. PostgreSQL then runs these steps in one locked transaction:

1. prove and inventory the configured namespace;
2. refuse known cross-schema dependencies;
3. clear the selected namespace with `trackingTable: "drop"`;
4. execute the already-compiled rebuild.

For PostgreSQL, clear and rebuild are one atomic operation. No other effectful
migration or push command may observe the transient empty namespace, and a
dependency or DDL failure rolls the clear back.

For MySQL, perform the same proven program under its database-specific lock with
qualified live DDL. After the full preflight and before any destructive DDL,
refuse any inbound foreign key to the declared tracking table: dropping that FK
first would open a stale-history window, while clearing/dropping the referenced
table first can be blocked. With that invariant proven, clear the qualified
tracking rows when the table exists and explicitly commit the clear. Then let
the prepared dependency graph drop the tracking table and remaining objects in
safe order; the table drop itself need not be the first DDL. A later partial
failure therefore cannot retain stale applied rows. The lock excludes another
VibORM migration command, but the clear/rebuild is not rollback-atomic. A
failure reports partial-commit reality and preserves the untouched artifact
estate.

Push is live-namespace synchronization, not migration-history reconciliation. It
never reads or mutates a migration journal, snapshot, or migration artifact,
whether invoked directly or through `createMigrationClient()`. Delete the
private `_storageDriver` option and its propagation. Retain only the normalized
tracking-table-name primitive on the migration-client force-push call; it grants
no storage access. The selected namespace's declared live tracking table is an
ordinary managed table for this purpose; force-reset clears its rows first and
then removes it through the dependency-safe program;
the versioned artifact estate remains byte-identical. A subsequent `status()`
therefore reports the unchanged journal entries as pending. Users who want a
history-aware destructive rebuild use `migrations.reset()`.

Both reset flows refuse every known inbound/outbound cross-namespace foreign key
before the first DDL.

Only an external dependency that the inventory does not represent may surface
later. PostgreSQL `RESTRICT` then rolls back the transaction; MySQL reports the
partial boundary after its last successful statement.

This leaves one namespace-containment rule and removes the current three ways
to invent reset SQL.

### 6.3 Containment proof

PostgreSQL tests must seed:

- managed objects in the selected schema;
- sentinel tables and enums in `public` and a sibling schema;
- an internal foreign-key graph;
- an external inbound dependency.

A successful reset removes only selected-schema objects. A known external
foreign key refuses before the first DDL; another unknown external dependency
may make `RESTRICT` fail inside the transaction, which rolls back every prior
drop. Sentinels remain byte-for-byte intact.

A replay-failure control must prove migration `reset()` restores the original
schema and tracking rows. A custom-schema force-reset must prove that it
atomically rebuilds only the configured namespace and performs no storage call.
The journal, snapshot, and every up/down artifact remain byte-identical after
both force-reset success and force-reset failure.

MySQL repeats the containment corpus with two databases containing identical
table names, internal cyclic foreign keys, and inbound/outbound cross-database
references. Success touches only the target. A known cross-database dependency
refuses before DDL. An injected mid-reset failure proves the error reports the
last known committed statement, makes no rollback claim, and leaves the
portable journal/snapshot/up/down estate byte-identical.

## 7. Cache and instrumentation

### 7.1 Official cache identity

The same official cache extension and backend may be reused by several clients.
The extension definition is created before it knows a concrete client's
adapter, so namespace partitioning must happen when that authenticated definition
binds to a concrete client.

Split the private capability in `src/cache/extension.ts` into:

- a definition capability created by `cache()` containing only `driver`,
  `version`, and `waitUntil`;
- a client-bound capability adding the opaque official `scope`.

Generic `appendResolvedExtension()` continues to authenticate and propagate the
definition capability. Immediately after append, the client composition root—
the existing point that uniquely has the resolved chain and concrete driver—
calls one cache-owned `bindOfficialCacheChain(chain, driver)`. That function:

- derives the effective namespace from `driver.adapter.namespace`;
- creates and registers one scope for the definition/dialect/namespace tuple;
- retains the already-bound scope when another ordinary extension is appended
  to the same target;
- lets transaction views reuse their existing chain and scope.

No dialect condition enters generic extension-chain code. An unextended or
non-cache client performs no bind call, scan, or allocation.

The cache-owned binder derives the opaque official cache scope from:

```text
official snapshot revision + cache version + dialect + adapter namespace
```

The dialect component is load-bearing: PostgreSQL schema `billing` and MySQL
database `billing` must not collide. Omitted and explicit PostgreSQL `"public"`
resolve to the same scope. SQLite and unbound MySQL preserve existing targetless
behavior; users still partition distinct physical databases that share those
facts with the existing cache `version`.

For PlanetScale, this scope component is the requested keyspace qualifier, not
the resolved backend. Vitess routing rules can make two qualifiers converge or
move one qualifier between backends. Such a routing-rule change is an external
cache-topology event: the application must invalidate every affected qualifier
scope or bump `cache({ version })` before switching traffic. The extension does
not query the PlanetScale control plane, correlate routing aliases, or claim
cross-client cache coherence across them.

Use the derived scope for every cache path:

- read lookup and storage;
- `$invalidate()`;
- automatic mutation invalidation;
- stale-while-revalidate work;
- committed and possibly committed write outcomes.

Do not expose the namespace in public cache keys or append it to operation
arguments. Bump the private official cache snapshot revision because the
storage namespace changes. Existing `cache({ version })` remains the user's
partition between physically distinct databases that otherwise share dialect
and namespace.

Acceptance falsifier: reuse one `cache()` extension instance and one memory
backend on two PGlite clients targeting `alpha` and `beta`. Identical model and
argument reads must return their own seeded values. A mutation or manual
invalidation in `alpha` must not evict or poison `beta`.

Repeat the same falsifier with one MySQL cache extension/backend and two bound
database names. Add a cross-dialect control proving PostgreSQL `billing` and
MySQL `billing` cannot share a lookup, invalidation, SWR, or write-outcome scope.

### 7.2 Instrumentation

The current instrumentation vocabulary already includes `ATTR_DB_NAMESPACE`.
When `adapter.namespace` exists, the driver's existing immutable base
attributes add:

```ts
[ATTR_DB_NAMESPACE]: adapter.namespace;
```

OpenTelemetry defines PostgreSQL `db.namespace` as database plus schema, and
allows the available component alone when the other is unavailable. VibORM
knows the configured schema without a network call, so it reports that schema
alone and documents the behavior. MySQL reports the configured database or
requested keyspace qualifier. Unbound MySQL and SQLite omit the attribute.
Instrumentation does not parse connection secrets or query a provider to guess
a value. See the
[OpenTelemetry PostgreSQL conventions](https://opentelemetry.io/docs/specs/semconv/db/postgresql/).

This one base attribute must flow through existing operation, statement,
transaction, batch, cache, and connection lifecycle units. Do not change
`db.collection.name` in this program.

## 8. Provider behavior

All five PostgreSQL providers share the same `PostgresAdapter`, so provider
drivers need configuration plumbing, not separate schema behavior.

| Provider | Required proof |
| --- | --- |
| PGlite | Real direct, prepared, callback transaction, savepoint, array-transaction, pinned-session, and advisory-lock contract |
| `pg` | Docker contract, including pinned `PoolClient` migration work and interleaved use of one supplied pool by two schema-scoped clients before any disconnect; the externally owned pool is closed once by the test |
| postgres.js | Docker contract, including `reserve()` identity and supplied client behavior |
| Neon HTTP | Deterministic SDK fixture for direct/native-batch runtime and read-only migration paths; effectful migration refusal; hosted runtime contract when credentials exist |
| Bun SQL | Runtime query plus reserved-session migration contract where the repository environment supports a real provider leg |

The MySQL providers share `MySQLAdapter` behavior but have different target
evidence and session capabilities:

| Provider | Required proof |
| --- | --- |
| MySQL2 | URL-derived, `options.database`-derived, explicit, supplied-pool, copied-options, direct/prepared/transaction/savepoint/native-or-fallback-batch, returning-emulation, explicit non-redirecting-attestation admission, unproven-topology refusal, pinned `PoolConnection`, exact lock-result, and cross-database isolation contracts |
| PlanetScale | Unbound VTGate-routing and explicit requested-keyspace qualification in deterministic direct/native-batch/transaction fixtures; routing-rule redirection disclaimer; PlanetScale database-resource and connection-selector non-inference; supplied-client opacity; hosted runtime when credentials exist; unconditional effectful migration refusal |

PostgreSQL and bound-MySQL runtime qualification occurs before provider
execution, so no runtime provider emits a setup statement. Native and fallback
batches submit their existing statement arrays with qualified SQL. The only
setup exception is MySQL's private pinned migration-artifact session described
in §3.4; it never reaches a public query or raw operation.

The capability split is deliberate: PGlite, `pg`, postgres.js, and Bun SQL can
pin one PostgreSQL session and therefore support effectful migration commands.
Neon HTTP cannot and supports only the runtime/read-only/offline subset named in
§3.5. A user may use Neon HTTP for application traffic and a `pg` or postgres.js
driver targeting the same `namespace` for deployment migrations. This does
not add a `migrationUrl` option or a hidden second client.

Tests must deliberately set a hostile `search_path` pointing at a sibling
schema containing identically named scalar-control tables. ORM queries and
writes must still reach the configured schema. Raw SQL retains ordinary
PostgreSQL `search_path` semantics because it is not rewritten, and extension
controls run with their installed extension schema visible.

MySQL2 tests use two databases with identical scalar, relation, junction, and
tracking table names while the connection default points at the sibling. The
effectful legs explicitly attest non-redirection. Qualified ORM and migration
operations must reach only the configured target. Unqualified raw SQL remains
caller-owned and follows the provider default. A supplied pool/client plus
`namespace` proves only which qualifier VibORM emits; without the separate
attestation it does not prove effectful-migration containment or claim to change
raw SQL's ambient database.

All SQLite3, Bun SQLite, libSQL, and D1 runtime ORM SQL, migration DDL/artifacts,
and unaffected database-provider calls remain byte-identical. The sole intended
database-call delta is status/pending/dry down/dry squash: replace tracking-table
creation with the exact read-only `sqlite_schema`/tracking SELECT protocol in
§3.2. Cache and instrumentation remain semantically equivalent; the intentional
private cache snapshot-revision bump may change backend key bytes. No test may
use `ATTACH` to make a non-feature appear supported.

## 9. Implementation units

Implement and review these units in order. Later units depend on the ownership
established by earlier ones.

### Unit A — Public option and immutable adapter value

- Record the exact clean baseline commit before the first feature edit; all
  performance comparisons use explicit baseline/candidate worktrees.
- Add the same `namespace` property to the five PostgreSQL and two MySQL driver
  option types and wrappers; expose no dialect-native alias.
- Add `migrationNamespaceAttestation?: "non-redirecting"` only to MySQL2's
  driver and wrapper options. Snapshot it once at construction; do not derive it
  from any namespace or provider observation.
- Extend the existing identifier owner with one hostile-safe namespace
  normalizer, shared syntax, dialect limits, and dialect system-name checks.
- Resolve MySQL2's explicit/URL/options target without mutating caller options;
  keep supplied pools opaque. Record a PlanetScale requested qualifier only
  from the explicit value.
- Construct one schema-bound `PostgresAdapter` and one optionally bound
  `MySQLAdapter` per driver.
- Install each affected stock driver's exact adapter reference plus the
  adapter's namespace as non-writable/non-configurable runtime facts.
- Install the optional attestation as one non-writable/non-configurable base
  driver fact. Forward the exact value through `TransactionBoundDriver`, nested
  transaction views, and the pinned-session execution view; every other stock
  driver, including PlanetScale, retains immutable `undefined`.
- Preserve the public one-value adapter constructors under the unified term,
  bound `postgresAdapter`, unbound `mysqlAdapter`, and unchanged SQLite
  adapters.
- Add direct, wrapper, hostile-JavaScript, typo, runtime immutability, custom
  adapter, and cross-dialect type falsifiers.

Done when invalid input fails before provider work, target precedence is exact,
every client has one immutable adapter namespace, and no URL, provider class,
or derived driver can manufacture a migration-routing assertion without
changing operation or result types.

### Unit B — Runtime table qualification

- Make `identifiers.table()` accept an optional alias.
- Extract one pure qualified-identifier string renderer from the existing
  dialect quoter and make runtime plus migration SQL consume it.
- Prequote a bound PostgreSQL/MySQL namespace once.
- Route every persistent model/junction table through that method.
- Move the mutation CTE back to statement-local identifier rendering.
- Update PostgreSQL and bound-MySQL SQL snapshots deliberately.
- Prove unbound MySQL and every SQLite snapshot are byte-identical.

Done when bound runtime table routing depends on neither `search_path` nor the
MySQL connection default, and no CTE, alias, column, temporary name, or
provider-extension type is accidentally qualified.

### Unit C — Estate target and artifact destination

- Export the readonly `MigrationTarget` and version-3 `MigrationJournal` types,
  then add the one internal runtime resolver.
- Bind migration drivers immutably through the registry.
- Remove `MigrationContext` and the standalone `MigrationContextOptions` type
  from the public `viborm/migrations` exports and make the internal class the
  shared target consumer. Concrete public command-option types retain their
  exact fields. Update package probes and public docs; retain no compatibility
  export.
- Add one migration-owned live-capability admission decision shared by
  the internal context, direct `push()`, and every public high-level migration
  command. It receives the exact execution driver and refuses MySQL
  effectful/stable-live work unless both namespace and attestation are present;
  no individual command reinterprets either fact.
- Upgrade the journal to version 3 and replace dialect-only validation.
- Implement the explicit journal/snapshot state table.
- Add required `DDLContext.destination`, thread it through the one dispatcher,
  and make MySQL artifact SQL relative while live SQL is qualified.
- Reorder every verb so target validation precedes snapshot/artifact reads,
  tracking, every storage write, and every database effect except the explicitly
  permitted lock acquisition/release.
- Require a bound MySQL namespace only at a live boundary; keep generation,
  preview, apply dry-run, and storage access portable/offline.
- Gate direct non-dry push/force-reset immediately. Storage-backed
  apply/down/reset/squash first perform only one pre-admission journal probe;
  take §3.3's exact absent-journal result without the attestation, or—when
  the journal is present—require it before any further I/O for effectful apply/
  down/reset/squash and live-state-dependent dry down/reset/squash. After the
  lock, reread and validate the authoritative journal before planning effects.
  Runtime, introspection, status/pending, push dry-run, generate, preview, apply
  dry-run, and raw storage access remain outside that gate.
- Replace the write-on-read `getAppliedMigrations()` with one internal read-only
  applied-state owner. Keep tracking-table creation exclusively inside the
  admitted effectful apply owner.
- Make status/pending SELECT-only and replace plausible-success catch-alls with
  exact dialect missing-tracking-table translations after namespace proof.
- Give SQLite status/pending/dry-down/dry-squash the same read-only applied-state
  owner through an exact `sqlite_schema` tracking-table check; do not route
  SQLite through the new pinned-session seam.

Done when no high-level PostgreSQL migration operation on a `beta` client can
consume, change, or apply an `alpha` journal, even for no-op generation and dry
paths that touch storage, while one MySQL estate can deploy to two explicitly
selected database names. The documented raw `migrations.storage` escape is not
a high-level operation.

### Unit D — PostgreSQL DDL, tracking, and introspection

- Qualify every PostgreSQL-owned persistent object using the table above.
- Parameterize all catalog schema filters.
- Add namespace existence preflight.
- Detect cross-schema dependencies and external UDTs.
- Bind extension-type admission to the concrete adapter's vector/geospatial
  capabilities and catalog extension provenance.
- Derive managed enum provenance through the existing DDL context and delete
  suffix guessing.
- Repair enum-default and partial-index canonicalization.
- Preserve built-in and extension type rendering.

Done when push into a non-public schema converges and every VibORM-generated
DDL, tracking, introspection, and reset path uses the same selected namespace.

### Unit E — MySQL DDL, tracking, and introspection

- Qualify every live persistent table position with the table-specific renderer
  while keeping artifact rendering relative.
- Parameterize every `information_schema` filter and list query; delete
  executable `DATABASE()` target inference.
- Prove database existence before publishing an empty inventory.
- Inventory both sides of every foreign key and refuse inbound/outbound
  cross-database topology.
- Qualify tracking-table create/read/write/clear and every live reset helper.
- Preserve relative snapshots and inline enum representation.
- Add MySQL2 target proofs, explicit non-redirection-attestation proofs, and
  PlanetScale requested-qualifier proofs. Neither target family can substitute
  for the other.

Done when one portable artifact estate converges independently in two MySQL
databases and every live/catalog/tracking effect reaches only its bound target.

### Unit F — Pinned sessions, destructive containment, and reset compression

- Remove PostgreSQL table/type `CASCADE` from ORM-owned destructive paths.
- Materialize dropped-table foreign-key operations once for push, generated up,
  and generated down programs.
- Add dependency-safe in-namespace teardown; delete MySQL foreign-key-check
  toggles.
- Add the one internal pinned-session driver seam and bind PostgreSQL advisory
  locks plus MySQL named locks, decisions, transactions/session state, unlock,
  and release to that exact producer.
- Keep namespace/routing admission before pinned-session reservation. A session
  capability or MySQL dialect fallback cannot substitute for the driver's exact
  attestation.
- Parse MySQL lock results and derive a database-specific bounded lock name.
- Preserve one-commit-per-entry apply semantics under the pinned lock while
  rereading authoritative journal/tracking state for every next entry.
- Execute MySQL artifact statements sequentially on the pinned producer; bypass
  generic batch/transaction dispatch that could select another connection.
- Consolidate CLI, force-push, and migration-reset inventory/drop behavior.
- Give the shared drop routine the explicit tracking-table preserve/drop policy.
- Read migration-reset's exact journal under the lock.
- Delete `_storageDriver`; push never receives or mutates migration storage.
- Thread only the already-normalized tracking-table name from the migration
  client's force-push convenience call; direct force-push uses the default.
- Before any MySQL destructive reset, refuse inbound foreign keys to that
  declared tracking table, then clear/commit its rows before DDL.
- Keep the complete force-reset clear-and-rebuild program inside one locked
  PostgreSQL transaction; preflight the full MySQL program and report its
  implicit-commit boundary honestly.
- Preflight-refuse migration reset histories containing a generated PostgreSQL
  enum-addition commit boundary.
- Preflight-refuse manual PostgreSQL transaction-control statements anywhere
  VibORM promises an enclosing apply/down/reset transaction.
- Refuse Neon HTTP's effectful migration/push verbs and live-state dry
  down/reset/squash decisions before provider calls or storage writes; retain
  its runtime, read-only, and offline schema-aware paths.
- Refuse every PlanetScale effectful migration/push path without a session-only
  admission or fallback; a requested keyspace qualifier cannot prove
  containment across VTGate schema-routing rules.
- Refuse the same paths for a MySQL2 or custom MySQL execution driver whose
  attestation is absent, including a MySQL2 connection to Vitess through the
  ordinary MySQL protocol. Do not inspect hostname, URL, handshake, vendor, or
  version strings.
- Keep confirmation at the CLI boundary and transactionality at the migration
  boundary.

Done when sibling sentinels and versioned artifacts always survive; PostgreSQL
failures roll back completely; MySQL failures never claim rollback and report
the last proven commit boundary.

### Unit G — Cache, instrumentation, docs, and architecture census

- Split definition and bound official-cache capabilities, then bind the scope at
  the concrete client composition root.
- Bind scope from revision + version + dialect + `namespace` and publish
  the same adapter fact through `db.namespace`.
- Document all seven affected drivers, migrations, MySQL artifact portability,
  raw/manual SQL, cache isolation, one-namespace-per-driver, independent
  PostgreSQL schema estates, PlanetScale resource/keyspace/routing distinctions,
  and SQLite's deliberate exclusion.
- Update the applicable root, adapter, cache, instrumentation, and migration
  `AGENTS.md` files only with retained durable rules.
- Add one architecture census for the invariants that behavior tests cannot
  enumerate reliably: no runtime `SET search_path`/`USE`, no executable
  hardcoded `public` outside the PostgreSQL default, no MySQL target
  `DATABASE()`, no executable or public type member named `databaseSchema`,
  `databaseName`, or `databaseNamespace`, no namespace field in model/query
  scope, no second configurable namespace source, and no SQLite attachment
  option. Also forbid host/version/handshake/backend-name inference of the
  migration attestation and any copy of that fact in adapter, journal, cache,
  instrumentation, or command options, plus any public `MigrationContext` or
  `MigrationContextOptions` export or second live migration executor.
  Rejected-alias tests, prose, the
  provider-owned MySQL `database`
  option, persisted PostgreSQL journal target, and immutable command-local
  projections are explicitly allowed. Include a falsifier for each detector.

Done when the feature has one representation and the documentation cannot imply
multi-namespace models, SQLite attachment support, or raw-SQL rewriting.

### Unit H — Provider and performance acceptance

- Run the provider matrix.
- Run the complete migration convergence and containment corpus.
- Measure query construction separately, then default/custom PostgreSQL and
  unbound/bound MySQL complete operations against the recorded pre-feature
  baseline.
- Remove any provider-specific workaround that duplicates adapter behavior.

Done when the complete acceptance criteria below pass.

## 10. Focused falsifiers

### Configuration and types

- All five PostgreSQL wrappers and constructors accept `namespace`.
- MySQL2 and PlanetScale wrappers and constructors accept `namespace`.
- MySQL2 wrappers and constructors accept only
  `migrationNamespaceAttestation: "non-redirecting"`. Fresh and held
  PlanetScale/PostgreSQL/SQLite configs reject that key, while MySQL2 rejects
  booleans, every other literal, and a misspelling beside a real option.
- Public `PostgresAdapter()` and exported `postgresAdapter` render explicit
  `public`; `PostgresAdapter("alpha")` renders `alpha`.
- Public `MySQLAdapter()` and exported `mysqlAdapter` remain unqualified;
  `MySQLAdapter("alpha")` renders `alpha`.
- A custom non-PostgreSQL `DatabaseAdapter` type probe may omit the optional
  namespace fact and implements both one- and two-argument table rendering.
- Generic `createClient({ driver })` rejects an independent `namespace`
  property in fresh and held objects.
- PostgreSQL and MySQL wrappers and driver option constructors reject the
  aliases `databaseSchema`, `databaseName`, `databaseNamespace`, `pgSchema`,
  and `keyspace`; generic `createClient({ driver })` rejects every alias too.
  SQLite wrappers reject `namespace` and every alias, in fresh and held
  objects.
- `DatabaseAdapter`, every stock adapter instance, and every public adapter
  declaration expose `namespace` and no `databaseNamespace` property.
- Each wrapper rejects a typo beside a valid option in fresh and held objects.
  Direct constructors reject fresh typos and wrong value types; do not add a
  constructor-exactness framework merely to reject held-object excess keys that
  TypeScript structurally permits.
- The option getter settles once; a throwing getter preserves its normalized
  cause. The MySQL2 attestation getter has the same one-read/cause contract and
  fails before provider initialization.
- Absent and explicit `undefined` PostgreSQL values both mean `public`; absent
  and explicit `undefined` MySQL values both defer to the same provider-target
  derivation.
- Invalid primitive values, empty/dotted/overlong names, punctuation, NUL, and
  prototype names fail before provider initialization.
- Lowercase `information_schema`, `pg_catalog`, `pg_toast`, `pg_temp_1`, and an
  arbitrary lowercase `pg_` prefix fail through wrappers, direct drivers, and
  the public adapter before provider work. Uppercase quoted controls preserve
  case-sensitive identifier semantics.
- PostgreSQL admits `public`, uppercase, a 63-character ASCII identifier, and a
  keyword such as `select`; 64 ASCII characters and literal quote characters
  are refusals.
- MySQL rejects `information_schema`, `mysql`, `performance_schema`, `sys`, and
  `ndbinfo` in mixed-case controls; it admits ordinary mixed case, a 64-character
  ASCII identifier, and a keyword; 65 characters are refused.
- MySQL2 proves explicit, URL-derived, and `options.database`-derived targets;
  URL precedence mirrors effective pool options, and explicit `namespace`
  becomes the copied driver-created pool default.
- None of those target sources creates an attestation. Omitted and explicit
  `undefined` remain unproven; only the exact explicit literal produces the
  immutable driver fact.
- One collision control supplies three distinct valid names and proves explicit
  `namespace` wins in both `adapter.namespace` and copied pool
  options. A second omits it and proves URL wins over `options.database`. A URL
  with no database path remains unbound rather than failing as an empty name.
- A supplied MySQL2 pool cannot derive a target. A supplied PlanetScale client,
  PlanetScale URL, and PlanetScale options cannot derive a requested qualifier.
  Each records one only from explicit `namespace` and otherwise remains
  unqualified.
- A PlanetScale database resource name is never inferred as a keyspace.
  `@primary` and `@replica` remain connection routing selectors: both are
  refused as explicit namespaces and never appear in `adapter.namespace` or an
  emitted persistent-table qualifier. Omitted `namespace` proves byte-identical
  unqualified SQL and explicit `namespace: "alpha"` proves submitted
  `alpha.table` qualification without claiming the final routed backend.
- Mutation of the original options object after construction has no effect on
  namespace or attestation.
- MySQL2 construction never mutates the caller's `options` record while merging
  defaults or a URL.
- Attempted replacement or redefinition of the adapter's `namespace`
  property fails and does not change later SQL.
- Attempted assignment or `defineProperty` replacement of a stock
  PostgreSQL/MySQL driver's adapter reference fails; query rendering, migrations,
  cache scope, instrumentation, and transaction views keep exact object identity.
- Attempted assignment or `defineProperty` replacement of the driver's
  attestation fails. Root, `$extends()`-derived, transaction-bound, nested
  transaction, and pinned-session views retain the exact primitive; PlanetScale
  remains immutable `undefined` even when hostile JavaScript adds the
  same-named input property.
- A custom PostgreSQL adapter without a proven namespace is refused instead of
  defaulted.
- A custom unbound MySQL adapter remains valid for runtime and artifact-only
  work but refuses before its first live migration effect.
- A custom MySQL execution driver defaults to an absent attestation. Only a
  trusted constructor that supplies the exact base-driver literal is admitted;
  neither a custom migration-driver registry entry nor a dialect fallback may
  grant it.
- Public `MigrationTarget`, `MigrationJournal`,
  `MigrationStorageDriver.getOrCreateJournal()`, and migration-client journal
  accessors type-check through `viborm/migrations` without naming an internal
  path.
- Fresh and held public type probes prove the exact `MigrationTarget` union:
  PostgreSQL accepts only `{ dialect: "postgresql", namespace }`; MySQL and
  SQLite accept only their dialect field. PostgreSQL rejects every namespace
  alias beside the real key, while MySQL and SQLite reject `namespace` and all
  aliases. Runtime journal-parser probes enforce the same exact target shapes.
- Version-3 journals reject the legacy top-level `dialect`, every target alias,
  and every extra target key through both public type probes and the structural
  storage parser.
- Root, `$extends()`-derived, and transaction clients retain result types and
  exact driver/adapter identity.

### Runtime SQL

- PostgreSQL and bound MySQL scalar CRUD, bulk CRUD, returning writes, upsert,
  aggregate, count, groupBy, ordering, cursor, and mutation-CTE paths qualify
  the table.
- `.map()` names remain bare objects inside the selected namespace.
- Ordinary and variant nested reads, relation filters, counts, and writes
  qualify every participant.
- Implicit, explicit `.through()`, self, and variant junction paths qualify the
  junction and target tables once.
- Columns, aliases, CTEs, carrier keys, constraints, and the batch temp table
  remain unqualified.
- Callback transactions, savepoints, prepared execution, fallback arrays, and
  native batches preserve the exact adapter target.
- Two PostgreSQL clients sharing a pool but selecting different schemas cannot
  cross-read or cross-write during interleaved use. Two MySQL2 clients with the
  same server/pool substrate but distinct databases have the same isolation.
  These tests do not claim PlanetScale routing-rule containment and do not
  change supplied-pool disconnect ownership.
- Two PostgreSQL clients with genuinely different public model graphs,
  namespaces, and migration storage roots may share one externally owned pool.
  Runtime SQL reaches only each graph's namespace; cache scopes do not collide;
  and tenant A's journal/artifacts are refused on tenant B after at most lock
  acquisition/release and the authoritative journal read, but before
  snapshot/artifact reads, tracking, DDL, other provider work, or any storage
  write. No test relies on a shared model graph to prove this case.
- Hostile `search_path` cannot redirect VibORM-owned tables, junctions, enums,
  indexes, or tracking. Supported provider extension types/functions retain
  their documented visibility requirement.
- Tagged and unsafe raw statement text is byte-identical.
- Statement transforms see already-qualified ORM SQL once.
- Unbound MySQL emits the pre-feature SQL byte-for-byte. Bound MySQL emits
  exactly one `` `database`.`` prefix per persistent table and no runtime
  `USE`.
- SQLite3, Bun SQLite, libSQL, and D1 emit no namespace prefix or attachment
  statement.

### Migrations

Common estate and command controls:

- Every journal/snapshot state-table row is pinned, including empty matching
  journal without snapshot and non-empty journal without snapshot.
- `read(entry)` refuses an absent/mismatched journal and an entry absent from the
  matching journal; raw `migrations.storage` remains explicitly unbound.
- Generate, preview, apply, down, status, pending, squash, reset, force-reset,
  and migration-client accessors use the one estate target and the bound
  migration driver's live namespace when required.
- The one shared admission owner covers direct `push()`, migration-client
  commands, and internal context/reset helpers. `MigrationContext` is absent
  from the public package surface, so no low-level raw/tracking/lock/statement
  method can bypass the same namespace plus attestation decision.
- Export/package falsifiers prove `MigrationContext` and
  `MigrationContextOptions` are no longer available from `viborm/migrations`;
  internal tests import the context module directly only when they must exercise
  command ownership.
- Status/pending with no journal and offline generate/preview/apply-dry make no
  provider call. Catalog-driven paths prove namespace existence before treating
  an inventory as empty.
- With a present SQLite journal, status/pending and dry down/squash use one exact
  `sqlite_schema` tracking-table read, never create the table, and preserve every
  existing SQLite queue/transaction path.
- Once a command needs live state, an unbound MySQL adapter fails before any
  provider call. An explicitly configured but nonexistent/invisible namespace
  fails after only its read-only catalog proof and before DDL, tracking
  mutation, or storage write; no command treats either case as an empty
  database.
- Manual migration SQL remains byte-identical and author-owned.
- Parent-first, child-first, and cyclic table removals materialize foreign-key
  drops once for push, generated up, and generated down programs.
- Ordinary push and force-reset perform zero migration-storage reads/writes,
  including through the migration-client convenience method.
- Force-reset success and failure leave journal, snapshot, and every up/down
  artifact byte-identical.
- Migration-client force-push carries its normalized custom tracking-table name
  without a storage owner and clears/commits its rows before destructive DDL;
  direct force-push uses the default. Any inbound FK to that declared table
  refuses before effects. A sibling custom name not declared by the invoking
  command is treated as an ordinary table, never guessed from inventory.

PostgreSQL controls:

- Catalog queries bind the selected schema and have no `public` fallback.
- First push creates only selected-schema objects; second push is empty.
- Tables, junctions, references, tracking, enums, casts, altered tables, and
  indexes use §4's exact qualification rules.
- `CREATE INDEX` keeps a bare index name and qualified table; `DROP INDEX`
  qualifies the index; rename targets remain bare.
- Custom-schema enum defaults and partial indexes converge. Explicit enum names
  without `_enum` and enum arrays qualify and converge.
- Proven pgvector/PostGIS types remain accepted in a custom table schema; an
  unknown external UDT is refused. Catalog formatting preserves `vector(3)` and
  `geometry(Point,4326)` typmods.
- Inbound/outbound cross-schema foreign keys refuse before planning.
- Journal schema mismatch fails before snapshot, tracking, artifacts, or DDL; a
  locked flow may have executed only its non-durable advisory lock.
- Status/pending prove schema existence, then map only `42P01` for the exact
  qualified tracking table to empty while leaving it absent. Missing schema,
  permissions, and arbitrary `42P01` controls surface on session and Neon
  drivers.
- Reset leaves public/sibling sentinels untouched and rolls back on dependency
  or replay failure. A generated `ALTER TYPE ... ADD VALUE` history refuses
  before clearing.
- Manual PostgreSQL transaction-control artifacts, with controls for every
  classifier spelling, refuse before apply/down/reset effects and preserve the
  published enclosing transaction guarantee.
- Manual PostgreSQL advisory acquisition/probe/release calls—same key, unrelated
  key, and shared variants—refuse in the same preflight, so no artifact can alter
  the enclosing migration lock count through a direct advisory function.
  String/comment controls that merely contain those names remain valid.
- Migration reset preserves the configured tracking-table structure and
  rebuilds its rows; force-reset drops that table.
- Two migrations where A adds an enum value and B uses it apply successfully
  with one commit per entry under the same session lock.
- Ordinary push preserves its enum-addition commit phase and transactional
  remainder under one lock. Force-reset validates first, then clears/rebuilds in
  one locked transaction; another migration cannot observe the empty interval.
- `SERIAL`/`BIGSERIAL` owned sequences converge and disappear with their tables;
  an unmanaged standalone sequence survives reset.
- PGlite proves advisory-lock availability and queued single-session ownership.
- Neon HTTP proves admitted runtime/read-only/offline paths and refuses every
  effectful or stable-live-decision path with `DRIVER_NOT_SUPPORTED` before
  provider calls or storage writes.
- A real two-client `pg` race proves producer identity, waiting across commit
  boundaries, exact boolean-true unlock, and no stranded pooled lock; false and
  malformed unlock results discard the producer and surface cleanup failure.

MySQL controls:

- A resolved namespace without the non-redirecting attestation refuses every
  effectful or stable-live-decision command with `DRIVER_NOT_SUPPORTED`. An
  attestation without a resolved namespace passes the capability check but
  fails `MIGRATION_INVALID_STATE`; neither fact present follows the attestation
  failure precedence. Each refusal occurs after at most the pre-admission
  journal probe and target validation, but before connection, lock,
  further storage reads, storage writes, or other provider work. An absent
  journal retains its documented storage-only return. A resolved namespace plus
  the explicit attestation admits the existing direct-MySQL capability subset.
- The command matrix is pinned: direct non-dry push/force-reset gate
  immediately. Present-journal effectful apply/down/reset/squash and live dry
  down/reset/squash require the attestation after the pre-admission journal probe,
  then reread the authoritative journal under the lock. The exact
  absent-journal returns in §3.3 do not. Runtime, introspection, status/pending,
  push dry-run, generate, preview, apply dry-run, and storage-only access remain
  outside the attestation gate.
- `readAppliedMigrations()` is proven read-only for present and absent tracking
  tables. Tracking creation occurs only inside an admitted effectful apply; no
  status, pending, dry command, or internal read path creates it.
- Explicit, URL-derived, and `options.database`-derived namespaces all require
  the same separate assertion. A MySQL2 connection speaking the ordinary MySQL
  protocol to a deterministic Vitess fixture refuses without it before the
  first provider call; no host, URL, handshake, version, or vendor-text branch
  runs.

- Manual transaction/XA, autocommit, table-lock, and named-lock
  acquisition/probe/release controls—same and unrelated keys—refuse before
  effects. No admitted direct control can alter the enclosing migration lock
  count or leave its tracking insert inside an author-opened transaction;
  literal/comment controls remain valid.
- Generated-only up/down histories and snapshots are byte-identical across two
  database names; their journals contain `{ dialect: "mysql" }` and no physical
  database name. Manual-history portability remains author-owned.
- Push/live reset SQL qualifies all table positions per §5, while generated
  artifacts remain relative. The same estate applies successfully to two
  explicitly selected databases.
- Every catalog query binds `namespace`; no executable target filter uses
  `DATABASE()`. Missing/invisible databases refuse before an empty snapshot.
- Catalog resolution prefers one exact `SCHEMATA` spelling, safely accepts one
  case-folded server match, and refuses ambiguous case-only candidates; later
  catalog/dependency comparisons use that command-local returned spelling.
- Status/pending prove database existence, then map only the exact qualified
  tracking table's missing-table error to empty and never create it.
- Inbound/outbound cross-database foreign keys refuse before DDL, including when
  the target side owns no other objects.
- An attested connection defaulting to `beta` while VibORM targets `alpha` can
  push, introspect, track, apply, down, and reset only `alpha`; `beta` sentinels
  remain.
- Create/drop/alter/rename table, foreign references, create/drop index, enum
  replacement updates, junctions, and tracking use the exact qualification
  position. Constraint/column/index names remain one identifier.
- Artifact apply issues validated target selection only on its pinned migration
  session and reasserts it before every artifact. A manual entry that issues
  `USE beta` cannot redirect the next generated entry from configured `alpha`.
  Runtime, raw calls, and versioned artifacts contain no hidden `USE`.
- MySQL2 proves one connection ID across `GET_LOCK`, target selection, protected
  work, `RELEASE_LOCK`, and destruction. Lock `0`, `NULL`, malformed results,
  and failed release all surface.
- The pinned MySQL2 connection is destroyed after every migration session and
  cannot leak `USE` or manual session state into an owned or supplied pool.
- Same-database clients, including case variants under
  `lower_case_table_names`, serialize through the conservative lowercase lock
  identity; different database names have distinct bounded lock names. A
  journal change while waiting is reread under the lock.
- Reset and force-reset complete all preflight before DDL. Injected statement-N
  failure after fail-closed tracking clear/drop reports possible partial commit,
  leaves portable storage untouched, exposes no stale applied rows, and never
  claims rollback or restores an unproven tracking row.
- No MySQL destructive path emits `FOREIGN_KEY_CHECKS=0`, `CREATE DATABASE`, or
  `DROP DATABASE`.
- PlanetScale deterministic fixtures prove both omitted-namespace unqualified
  VTGate-routing SQL and explicit requested-keyspace qualified SQL, plus
  database-resource and connection-selector non-inference, routing-rule
  redirection semantics, and supplied-client opacity. Every effectful migration,
  push, reset, and destructive live verb refuses `DRIVER_NOT_SUPPORTED` before
  provider calls or storage writes, even with an explicit namespace and a
  session-capable fixture.

### Cache and instrumentation

- Two PostgreSQL schema-scoped or two bound MySQL database-scoped clients sharing
  one official cache definition/backend cannot cross-hit, cross-invalidate, or
  cross-SWR.
- One definition used by PostgreSQL `alpha`, PostgreSQL `billing`, MySQL
  `billing`, omitted-public, and explicit-public clients gives each distinct
  dialect/namespace its own scope and the two public clients one scope.
- PlanetScale cache fixtures treat an explicit keyspace as a requested logical
  scope only: equal qualifiers share a scope, distinct qualifiers remain
  separated, and a cache-version bump partitions a routing-rule transition. No
  assertion claims automatic invalidation across two routing aliases.
- Same-dialect/same-namespace behavior remains unchanged.
- `db.namespace` contains the configured PostgreSQL schema, MySQL database, or
  requested Vitess keyspace qualifier on existing connection, operation,
  statement, transaction, batch, and cache lifecycle units. It never claims
  the final Vitess backend after routing rules. Unbound MySQL, unbound
  PlanetScale, and SQLite omit it.
- No connection string, host, username, or credential enters cache identity or
  diagnostic attributes.

### Dialect and performance controls

- SQLite, unbound MySQL2, and unbound PlanetScale runtime SQL remain
  byte-identical. Bound MySQL2 runtime/live DDL and explicitly qualified
  PlanetScale runtime snapshots change only by intended qualification;
  PlanetScale live DDL remains refused. MySQL versioned migration artifacts
  remain byte-identical across MySQL database or requested keyspace names.
- Qualification adds no binds, provider calls, handler scans, or result work.
- The feature diff does not touch result parsers, provider-row transport, or
  row loops; this structural boundary, not a noisy benchmark, proves there is
  no new per-row branch or allocation.
- PGlite and MySQL2 flat read, nested read, create, and 100-statement batch
  allocation/framework CPU are measured in five alternating fresh processes
  for default/unbound and explicit-bound targets. Reject a unit when the median
  regression is both greater than 3% and greater than `2×MAD`; record smaller
  statistically visible movements without pretending they are zero.

## 11. Sequential validation gates

Run large gates sequentially because the repository enforces a workspace lock.

1. Focused identifier, PostgreSQL/MySQL adapter, query rendering, migration
   target/destination, DDL, introspection, reset, cache, instrumentation, and
   public type suites.
2. `pnpm test:layer:adapters`
3. `pnpm test:layer:query-engine`
4. `pnpm test:layer:drivers`
5. `pnpm test:layer:client`
6. Relevant migration layer suites.
7. Relevant cache and instrumentation layer suites and coverage gates.
8. `pnpm test:types`, with no TS2589 or TS2590.
9. PGlite real runtime and migration contracts.
10. `pg` and postgres.js Docker contracts.
11. Neon HTTP and Bun SQL deterministic contracts; hosted legs may skip only
    when credentials or runtime are visibly unavailable.
12. MySQL2 Docker runtime, explicit-attestation admission, omitted-attestation
    refusal, two-database migration, pinned-lock, and partial-commit contracts.
13. PlanetScale deterministic runtime/routing/refusal contracts; hosted runtime
    legs may skip only when credentials are visibly unavailable.
14. SQLite3, Bun SQLite, libSQL, and D1 runtime/DDL/artifact byte-identity
    controls, plus an exact provider-ledger assertion for the one read-only
    tracking change.
15. Repository-pinned Biome on every touched TypeScript file.
16. `git diff --check`.
17. `pnpm --dir docs validate`.
18. `pnpm package:build` and `pnpm test:package`.
19. `pnpm test:core`.
20. `pnpm test:all`.
21. `pnpm test:providers`, with hosted skips reported honestly.
22. Five alternating fresh-process PGlite and MySQL2 baseline/candidate
    benchmark runs.
23. Re-run the architecture census and all its falsifiers.

## 12. Completion criteria

The feature is complete only when all of these statements are true:

1. The public spelling is exactly `namespace` on PostgreSQL and MySQL drivers;
   it means PostgreSQL schema, MySQL database, or requested Vitess keyspace
   qualifier. It never means a PlanetScale database resource, shard, tablet,
   connection routing selector, or proof of the final routed backend. SQLite
   has no corresponding option.
2. PostgreSQL defaults exactly to `public`. MySQL2 binds only from the explicit
   value or proven driver-created connection configuration. PlanetScale records
   only an explicit requested qualifier; omission preserves provider/VTGate
   routing.
3. `adapter.namespace` is the sole live normalized target representation.
   MySQL2's optional `"non-redirecting"` driver attestation is an independent
   transport assertion and is never interpreted as a target.
4. Every VibORM-generated PostgreSQL persistent-object reference and every
   bound-MySQL runtime/live-DDL/tracking persistent-table reference consumes the
   one qualified-identifier primitive. Statement-local identifiers, raw/manual
   SQL, extension-owned types, and stored MySQL artifacts are explicit
   exceptions.
5. Runtime emits neither `SET search_path` nor `USE`; bound routing does not
   depend on mutable session defaults.
6. Raw SQL and manual migration SQL remain unchanged.
7. Generated PostgreSQL artifacts remain schema-bound; generated MySQL
   artifacts remain database-relative and portable.
8. Models, relations, query scopes, operation programs, and result types contain
   no namespace copy.
9. All five PostgreSQL providers inherit one adapter behavior; MySQL2 and
   PlanetScale inherit one MySQL adapter behavior with provider-specific
   namespace evidence. Among stock drivers, only MySQL2 exposes the explicit
   non-redirecting attestation configuration; a trusted custom MySQL execution
   driver may supply the same base-constructor literal. PlanetScale remains
   unproven.
10. Admitted session-capable migration drivers hold lock, decisions,
    DDL/tracking, unlock, and cleanup on one pinned producer. Providers that
    cannot prove session ownership or namespace containment refuse the affected
    capability without fallback. MySQL2's session support, class, URL, and
    resolved namespace never substitute for its explicit attestation.
11. Journal version 3 binds PostgreSQL estates to the exact schema and MySQL
    estates to the portable dialect target.
12. Snapshots and diff operations remain namespace-relative.
13. Required `DDLContext.destination` is the sole artifact/live rendering
    decision; no mutable or parallel migration driver path exists.
14. PostgreSQL and MySQL2 DDL, introspection, tracking, and canonicalization
    agree on the live adapter namespace when MySQL2 is admitted by the explicit
    attestation. PlanetScale has no effectful live DDL path in this program.
15. Missing namespaces and cross-namespace foreign keys fail before unsafe
    effects.
16. PostgreSQL reset cannot delete sibling objects through `CASCADE` and remains
    transactionally atomic where admitted.
17. MySQL reset uses no disabled foreign-key checks, preflights completely, and
    refuses inbound tracking-table FKs and clears/commits tracking rows before
    destructive DDL so failure is fail-closed, then reports implicit partial
    commits without a false rollback claim.
18. Cache entries and invalidations are isolated by dialect plus known
    namespace.
19. Instrumentation reports a known SQL namespace through `db.namespace` and
    omits an unknown one.
20. SQLite runtime ORM SQL and migration DDL/artifacts remain byte-identical;
    only the declared read-only tracking ledger changes, cache/instrumentation
    remain semantically equivalent despite the private cache-key revision, and
    no attachment abstraction exists.
21. Unbound MySQL output remains byte-identical. Bound MySQL2 runtime/live SQL
    changes only by intended qualification plus the pinned artifact executor's
    private per-artifact target selection. Explicit PlanetScale qualification
    changes runtime SQL only and makes no routed-containment claim.
22. Runtime and migration contracts pass for each provider's explicit
    capability subset.
23. The operation pipeline stays within the measured performance gate.
24. Push has no migration-storage injection or artifact-history side effect.
25. No compatibility alias, duplicate target owner, alternate qualification
    path, hidden target inference, or SQLite false equivalent remains.
26. PostgreSQL clients with genuinely different model graphs and namespaces can
    share an externally owned pool while retaining separate schema-bound
    migration estates. A cross-estate attempt is refused after at most lock
    acquisition/release and the authoritative journal read, but before
    snapshot/artifact reads, tracking, DDL, other provider work, or any storage
    write.
27. PlanetScale `namespace` records only the requested SQL qualifier. Every
    effectful migration, push, reset, and destructive verb is refused because a
    reserved session and fully qualified names cannot bypass Vitess routing
    rules.
28. Every MySQL effectful or concurrency-stable live decision passes one shared
    admission owner. It requires both a resolved adapter namespace and the exact
    driver-owned `"non-redirecting"` attestation after at most the pre-admission
    journal probe and target validation, but before provider work,
    further storage reads, or any storage write. The authoritative journal is
    reread under the lock before planning effects. The assertion is immutable
    across execution views, absent from every other representation, and never
    inferred from transport metadata.
29. `MigrationContext` and `MigrationContextOptions` are internal. The context's
    applied-state reader never creates tracking state, and every public migration
    effect enters through the one target/capability admission owner; no raw,
    lock, tracking, statement, or orphan context-options surface is exported as
    a bypass.

## 13. Rejected designs

### Runtime `SET search_path` or `USE`

Rejected because it is mutable connection state, pool-sensitive, difficult to
apply consistently to HTTP/native-batch providers, observable by raw SQL, and
vulnerable to later changes on a reused connection.

The pinned MySQL migration executor's private `USE` is a narrow exception for
portable artifacts. Its owner, lifetime, lock, target, and cleanup are the same
physical session; it never becomes runtime routing or a public statement.

### Provider connection state as the sole truth

Rejected because provider spellings differ, supplied clients are opaque, and
offline migrations cannot reproduce mutable state. MySQL2 may derive an adapter
namespace from its own driver-created effective configuration as a convenience;
that constructor snapshots the result into the same adapter fact used by an
explicit option. PlanetScale and supplied MySQL2 pools never guess.

### Inferring a direct MySQL backend

Rejected because MySQL2 is also an ordinary supported Vitess/PlanetScale
client: PlanetScale supplies standard
[MySQL connection strings](https://planetscale.com/docs/vitess/connecting/connection-strings),
and Vitess exposes the
[MySQL server protocol](https://vitess.io/docs/25.0/reference/compatibility/mysql-compatibility/).
A proxy can control or emulate host, handshake, vendor, and server-version
evidence; none proves that qualified names cannot be redirected. VibORM
therefore performs no negative backend detection. Direct-MySQL effectful
migration users make the one explicit
`migrationNamespaceAttestation: "non-redirecting"` assertion, while omission
fails closed.

`allowMigrations: true` is rejected because permission does not name the safety
invariant. `backend: "mysql" | "vitess"` is rejected because provider taxonomy
still does not prove routing behavior. A migration-client or per-command flag
is rejected because the same execution driver could then provide contradictory
answers. An adapter capability or object-shaped namespace is rejected because
transport routing is independent of identifier rendering and would create a
second namespace representation. Defaulting every MySQL2 driver to attested is
the original bypass; refusing all MySQL2 effectful migrations needlessly
discards the explicitly proven direct-database case.

### PlanetScale database resource or routing selector as namespace

Rejected because a PlanetScale database is an enclosing product/cluster
resource that may contain several keyspaces, while `@primary` and `@replica`
select connection routing behavior. None occupies a proven persistent-table
qualification position. Omitted `namespace` leaves routing with PlanetScale and
VTGate; an explicit identifier names only the keyspace qualifier the caller
asks VibORM to submit, which routing rules may still redirect.

### `schema: "billing"`

Rejected because `schema` already means the model record in every client.

### Dialect-native public option names

`databaseSchema`, `databaseName`, `databaseNamespace`, `pgSchema`, and
`keyspace` are rejected. They name one driver-binding fact differently and
force cross-provider configuration to branch before it reaches the dialect
owner. `namespace` captures the shared SQL qualification relationship while the
adapter preserves the distinct PostgreSQL schema, MySQL database, and direct
Vitess-keyspace semantics.

### Generic `VibORMConfig` namespace options

Rejected because the driver already owns the physical database target, and
unsupported clients would appear to accept a value they cannot honor.

### Per-model namespace or dotted `.map()` names

Rejected because this feature needs one client target, not multi-namespace
topology. A dotted name would also be quoted as one identifier rather than
`"schema"."table"` and would contaminate logical naming and junction derivation.

### Query-scope or operation-program namespace

Rejected because physical rendering belongs to the adapter. Threading the
same constant through every operation creates copies without adding truth.

### Schema-aware `identifiers.escape()`

Rejected because `escape()` also renders columns, aliases, constraints, CTEs,
and temporary names. Only the semantic table renderer may qualify persistent
tables.

### SQL rewriting

Rejected for raw SQL, manual migration SQL, and driver output because safe
rewriting requires parsing a full dialect and still cannot infer author intent.

The MySQL artifact/live choice is generation-time rendering through the existing
DDL context, not rewriting stored SQL at execution.

### Mutable migration singleton

Rejected because concurrent clients targeting different namespaces would race.
PostgreSQL and live MySQL migration drivers bind immutably per adapter target.

### Automatic schema/database creation or deletion

Rejected because namespace provisioning is privileged infrastructure work.
VibORM manages objects inside an existing namespace and never owns the
namespace itself.

### Database-qualified MySQL migration artifacts

Rejected because physical MySQL database names commonly differ by environment.
Embedding `app_dev` in generated SQL or the journal would prevent the same
estate from deploying to `app_test` and `app_prod`. Portable relative artifacts
plus one pinned execution target preserve both safety and deployability.

### SQLite attachment alias

Rejected because `main`, `temp`, and `ATTACH ... AS` aliases belong to a
connection, not to a portable schema/database namespace. Provider support,
session persistence, cross-file foreign keys, and migration containment differ
across SQLite3, Bun SQLite, libSQL, and D1. A future attachment feature must own
those semantics explicitly rather than borrowing `namespace`.

### Dynamic per-query selection

Rejected because it is a different tenant-routing and policy problem with new
cache, security, transaction, and prepared-statement semantics.

## 14. Dated deviation notes

### 2026-08-27 — Enum-array convergence reduced to renderer-level qualification

The desired-state serializer cannot produce an enum-array column, so §10's
enum-array convergence control cannot be exercised end to end in this program.
The control is reduced to renderer-level qualification: the PostgreSQL DDL
renderer emits `"schema"."enum"[]` whenever the DDL context proves the base
enum managed, with a renderer-level witness. Full desired-side convergence is
out of scope until the serializer can express enum arrays. (Ruling N17.)

### 2026-08-27 — Missing-tracking-table translation is statement-exact, not error-exact

§3.2/§10 ask the missing-tracking-table translation to match the provider
error "for the exact qualified tracking table". `VibORMError` stores a
sanitized cause whose message is redacted (`src/errors/diagnostics.ts`); only
`meta.providerCode` survives, so the failing relation's name is structurally
unreachable from the error object. Exactness comes from the statement instead:
the translation is consulted only for the failure of the applied-state SELECT,
which references exactly one relation and runs only after the namespace
existence proof has passed. A stronger error-side proof would require changing
error normalization, which this feature does not own. (Ruling N25.)

### 2026-08-27 — SQLite adapters omit the namespace property entirely

§10's "every stock adapter instance exposes `namespace`" conflicts with
§2.1's "SQLite adapters omit it". §2.1 governs: SQLite adapters carry no
`namespace` property at all (`"namespace" in sqliteAdapter` is false), rather
than an undefined-valued one — absence is the truthful shape for a family the
feature excludes. The §10 sentence is read as scoped to the PG/MySQL
families. (Unit A review finding 8.)

### 2026-08-27 — The bound migration driver carries the live namespace read once at bind

§3.1 says the bound migration driver "does not copy or independently
configure the namespace". The MySQL migration target is deliberately portable
(no namespace member), so the live destination cannot ride in `target` and
the bound view must carry it somewhere. The landed shape reads
`adapter.namespace` exactly once at bind time and installs that value frozen
on the bound view; renderers read the frozen bind. A read-through reference
was rejected: against a custom adapter with an accessor, per-render reads
would let the destination vary between admission and DDL, which is the exact
swap the immutable install exists to prevent. The single read at bind is the
retained fact. (Unit C review finding 3.)

### 2026-08-27 — Unbound MySQL generateListTables refuses instead of rendering DATABASE()

At baseline the unbound MySQL inventory rendered `WHERE TABLE_SCHEMA =
DATABASE()` — the ambient-target shape this feature removes. The bound form
now filters the estate; the unbound form throws
`MigrationError(MIGRATION_INVALID_STATE)` rather than reproducing the
ambient read or rendering a vacuous `= NULL`. No admitted command path can
reach an unbound live inventory (the admission owner refuses first), so the
§12.21 byte-identity claim carries this one declared exception on an
unreachable arm, pinned in both directions. (Unit E review finding 2.)

### 2026-08-27 — The base attributes are a per-call literal, not a memoized snapshot

§7.2 describes `db.namespace` as joining "the driver's existing immutable base
attributes". `getBaseAttributes()` allocates a fresh unfrozen object literal on
every call (`src/drivers/driver-instrumentation.ts:399`), and it always did. The
attribute is therefore added as a conditional spread on that per-call literal
rather than to a frozen snapshot. Memoizing was rejected: it is a behavior change
in a hot path guarded by the native-batch inertness pin
(`native-batch-attribution.core.test.ts:174`) and by the performance gate, and
§7.2's immutability requirement is already satisfied where it matters — the VALUE
rides on the non-writable `adapter.namespace`, which nothing copies. (Ruling N19.)

### 2026-08-27 — The db.namespace carriers are the four units that already carry db.*

§7.2/§10 list "connection, operation, statement, transaction, batch, and cache
lifecycle units". There is no batch span: `ATTR_DB_BATCH_SIZE` is declared and
unused, and `observeTransactionBatchPhase` opens no span. The taxonomy is the five
kinds in `lifecycle-facts.ts`, of which `segment` carries only `viborm.write.*`.
The attribute therefore lands on exactly the four kinds that already carry `db.*`
— operation, statement, driver-lifecycle (transaction + connect/disconnect), and
cache — through the one choke point `getBaseAttributes()`. Within the cache kind it
reaches the stale-while-revalidate presentation, the only cache span built from the
driver's base attributes; `viborm.cache.get`/`.set` describe a cache-backend call
and carry no `db.*` at all. No unit kind was created. (Ruling N19.)

### 2026-08-27 — The bound cache scope is retained by value, not by a registry

§7.1 asks the binder to "retain the already-bound scope when another ordinary
extension is appended to the same target". The resolved chain is a fresh frozen
object on every append, so retention could only mean a registry keyed on chain or
client identity. Instead the derivation is a pure function of (revision, cache
version, dialect, adapter namespace), so a re-bind reproduces the identical
namespace string and addresses the identical storage. The per-chain WeakMap holds
the bind RESULT so the per-operation lookup stays O(1); it does not decide the
scope. Witnessed by `namespace-isolation.core.test.ts` "an ordinary extension
appended after the cache keeps the same scope" and "ten appended extensions still
address one scope", both red under a per-bind-unstable scope. (Ruling N20.)

### 2026-08-27 — Manual MySQL `USE` in an artifact remains valid; no `SET search_path` refusal exists

§3.5's letter: a manual `USE` inside a migration artifact stays allowed because
the pinned executor reasserts its target before the next artifact; the preflight
classifier refuses nothing on PostgreSQL because artifacts and tracking are
fully qualified, so a `SET search_path` refusal would be a guard with no
nameable unique coverage. Witnessed in the pinned-session suites. (Unit F
deviation 1.)

### 2026-08-27 — `push({forceReset})` compiles from the empty snapshot

§6.2's letter: force-reset clears the estate and rebuilds, so its plan is the
diff from an EMPTY snapshot, not from the live catalog it is about to empty.
The CLI therefore reports the real rebuild operations. (Unit F deviation 4.)

### 2026-08-27 — The namespace proof precedes the first pinned `USE`

§3.3 requires an absent namespace to fail on its catalog proof; a raw
`USE nonexistent` provider error would preempt it, so the pinned session runs
`proveNamespaceExists` on the reserved connection before its first `USE`.
Witnessed by the docker control that flips V11009→V2001 when reordered.
(Unit F deviation 5.)

### 2026-08-27 — MySQL migration-command DDL renders the resolved catalog spelling

§5.2 says runtime and live DDL "continues to quote the immutable configured
spelling". For MIGRATION commands that clause is superseded by §5.2's own
resolution rule: after `SCHEMATA` resolution accepts one case-folded server
match, every statement the command renders — the `USE`, the tracking DDL, the
inventory filters, and the live DDL of push/apply/reset — carries the
command-local RESOLVED spelling; the configured spelling reaches the server
only as bound catalog data. Otherwise a case-folded match would pass the
proof and then fail (or worse, act elsewhere) on the very next identifier.
Runtime ORM SQL is untouched: the adapter still quotes the immutable
configured namespace. (Unit F fix round, review finding P1-2.)

### 2026-08-27 — Correction to the N19 note's final clause

The instrumentation note above ends "…the non-writable `adapter.namespace`,
which nothing copies." Two ratified captures exist and are documented: the
bound migration driver's bind-time value (this section, N31(3)) and the
cached-read `dbAttributes` snapshot taken at `$withCache()`. The durable rule
is that the INSTALL is non-writable, so no capture can go stale — not that
no capture exists. (Unit G review finding 2.)

### 2026-08-28 — The artifact classifier refuses direct controls, and the confinement claim is retired

§3.5's closing sentence — trusted manual SQL "cannot terminate or reframe
VibORM's rollback/tracking boundary or release VibORM's session lock" — is false
and cannot be made true by lexical enumeration. A dollar-quoted body must stay
unclassified, or every ordinary `CREATE FUNCTION` is refused, and the server runs
those same bytes. Under a real acquired PGlite advisory lock,
`DO $$ BEGIN PERFORM pg_advisory_unlock_all(); END $$` released it — advisory
locks held went 1 → 0 and a later `pg_advisory_unlock(42)` answered `false` — and
`CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $$ SELECT
pg_advisory_unlock_all() $$; SELECT f();` released it identically. Pre-existing
safe-named functions and dynamic SQL are the same escape.

The CONTRACT is therefore restated rather than the scanner extended: manual
migration SQL is trusted last-mile authority, and `statement-safety.ts` refuses
DIRECT lexical transaction/advisory controls while being no sandbox for
procedural or dynamic SQL. Every direct refusal §3.5 lists is kept — what they
buy is the accident and the audit, not confinement — and the deliberate case is
answered after the fact by the pinned session's release PROOF, which fails the
command and discards the session when the lock it acquired is no longer held. No
spelling was added: the enumeration does not close, and each addition costs valid
author SQL.

The retired claim is pinned out of every shipped text a reader takes the contract
from (module header, refusal message, `src/migrations/AGENTS.md` Rule 6c, and the
namespaces page), and the escape is a LIVE control rather than a caveat:
`tests/unit/migrations/pinned-migration-session.core.test.ts` runs that artifact
through `apply()` on a real PostgreSQL, censuses the advisory locks on either
side of the `DO` block (2 → 0), and pins the command failing at the release proof
with the migration recorded as applied. The §3.5 sentence is superseded by this
note. (Maintainer directive 3, blocker 1.)

### 2026-08-28 — `PREPARE TRANSACTION` is refused as a two-word phrase

§3.5 enumerates PostgreSQL's transaction-control refusals by leading word, and
`PREPARE TRANSACTION 'g'` was accepted at e8b8725b because `PREPARE` is not a
leader and cannot become one — `PREPARE plan AS SELECT …` is ordinary author SQL
that must stay valid. The classifier's leader set therefore holds leading
PHRASES, with `PREPARE TRANSACTION` as its one two-word entry; `COMMIT PREPARED`
and `ROLLBACK PREPARED` need no entry, since they already lead with a refused
word. One lookup owner serves both dialects, so no second registry and no
execution-time guard were added, and MySQL is unchanged (its entries are all one
word). The refusal is proven at the classifier and at `apply()`'s preflight, with
zero effects. PGlite ships `max_prepared_transactions = 0`, so no live leg exists
on this substrate; that setting and PGlite's own refusal are pinned rather than
described, so a PGlite that enables prepared transactions re-opens the question.
(Maintainer directive 3, blocker 2.)
