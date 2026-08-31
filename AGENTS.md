# AGENTS.md - VibORM Architecture Guide

## 30-Second Summary

Type-safe ORM with zero codegen. Types inferred from validation schemas, not generated.
**12-layer architecture:** validation → schema → query-engine → adapters → drivers → client → cache → instrumentation.

See `FEATURE_IMPLEMENTATION_TEMPLATE.md` for detailed layer-by-layer implementation guidance.

---

## Why This Architecture Exists

VibORM was designed to solve three problems that plagued existing ORMs:

1. **Code generation lock-in**: Prisma requires `prisma generate` after every schema change. We wanted instant type updates on save.

2. **Multi-database support without forking**: Drizzle has separate packages per database. We wanted one codebase supporting PostgreSQL, MySQL, and SQLite through adapter pattern.

3. **Type inference that scales**: Early attempts using `schema.infer` caused 10+ second type checking. The State generic pattern with branded types solved this.

These constraints shaped every architectural decision. When you wonder "why is this so complex?", the answer is usually one of these three.

---

## Layer Responsibility Matrix

| Layer | Location | Owns | Doesn't Own | Guide |
|-------|----------|------|-------------|-------|
| **L1: Validation** | `src/validation/` | v.* primitives, Standard Schema V1, the one fixed-decimal descriptor shape and codec, the one DateTime logical domain and physical codec, `SchemaRegistry` operation schemas | Scalar declaration logic | [validation/AGENTS.md](src/validation/AGENTS.md) |
| **L2: Scalars** | `src/schema/scalars/`, `src/schema/field-ref.ts`, `src/schema/hydration.ts` | Scalar classes, State generics, base scalar schemas, each field's frozen decimal-descriptor instance, runtime schema metadata | Operation schemas or a second decimal representation | [schema/scalars/AGENTS.md](src/schema/scalars/AGENTS.md) |
| **L3: Operation Schemas** | `src/validation/model/`, `src/validation/relations/` | where, create, update, args schemas | SQL generation | — |
| **L4: Relations** | `src/schema/relation/` | The two factories, the declaration state, the terminal capability surfaces | Pairing, ownership, query execution | [schema/relation/AGENTS.md](src/schema/relation/AGENTS.md) |
| **L5: Schema Validation** | `src/schema/validation/` | Definition-time validation; the ONE schema-wide relation topology owner (`relation-resolution.ts`) | Runtime validation | — |
| **L6: Query Engine** | `src/query-engine/` | Query structure, logic | **Database SQL** | [query-engine/AGENTS.md](src/query-engine/AGENTS.md) |
| **L7: Adapters** | `src/adapters/` | **Database-specific SQL** | Query logic | [adapters/AGENTS.md](src/adapters/AGENTS.md) |
| **L8: Drivers** | `src/drivers/` | Connection, execution | Query building | — |
| **L9: Client** | `src/client/` | Result types, proxies, schema/operation introspection | Query construction | [client/AGENTS.md](src/client/AGENTS.md) |
| **L10: Cache** | `src/cache/` | Query caching, invalidation | Query execution | [cache/AGENTS.md](src/cache/AGENTS.md) |
| **L11: Instrumentation** | `src/instrumentation/` | Tracing, logging | Query logic | [instrumentation/AGENTS.md](src/instrumentation/AGENTS.md) |
| **L12: Migrations** | `src/migrations/` | Schema sync, migration files, DDL | Schema definition | [migrations/AGENTS.md](src/migrations/AGENTS.md) |

**Two declared facts, everything else derived.** A relation declaration states
exactly two things at L4: the SLOT CARDINALITY its factory was spelled with
(`s.toOne` / `s.toMany`) and the TARGET DOMAIN its argument names (one model, or
a map of named variants). Who its partner is, which endpoint owns the foreign
key, whether storage is a row reference or a junction, whether that storage is
unique, and whether a singular slot may be empty are DERIVED once per schema by
L5's `relation-resolution.ts`, which publishes a `ResolvedRelationIndex`: one
contextual `ResolvedSlot` per (model, field). Every layer above threads that same
index by identity and reads the view it needs — clearability
(`@schema/relation/clearability`), and inside L6 the bound membership. No layer
stores a second copy of a topology fact, no consumer rescans for an inverse, and
no consumer invokes a raw target getter. When a question about an edge has an
answer, it has exactly one place that answers it.

**What that replaced.** These concepts are gone and must not come back under any
spelling: six cardinality-named relation factories; a declared four-way relation
type discriminant; a separate polymorphic relation field category with its own
model map; standalone pairing-name registries and consumer-side inverse scans; a
mutable relation source and `setSource()`; every inverse precedence ladder and
first-candidate fallback; ownerless warning-only edges; relation `.unique()`;
ordinary relation `.optional()`; partial foreign-key state admitted as a
relation, including zero-argument `.fields()`; junction `.A()` / `.B()`; parallel
variant target/value/through maps; the model-owned variant storage map and its
accessors; the query-scope polymorphic caches and `RelationInfo` facades;
synthetic carrier relations. There is no compatibility alias for any of them —
[docs/architecture/global-relation-cardinality-plan.md](docs/architecture/global-relation-cardinality-plan.md)
is the record of why.

---

## Schema Taxonomy

Use these terms precisely:

| Term | Meaning | Examples |
|------|---------|----------|
| **Field** | Umbrella model member. A model field is either a scalar or a relation. | `ModelShape = Record<string, Scalar \| AnyRelation>` |
| **Scalar** | Primitive/value field that maps to a column or column-like value. | `s.string()`, `s.int()`, `s.dateTime()`, `StringScalar` |
| **Relation** | Association field between models. | `s.toOne(() => user)`, `s.toMany(() => post)` |

`field` is correct when code or docs talk about model keys, selection fields,
foreign-key fields, compound fields, or the public relation `.fields()` API.
Use `scalar` when referring to primitive/value definitions, scalar classes,
scalar validation schemas, scalar factories, or `src/schema/scalars/`.

Do not put scalar implementations under `fields/`, and do not name scalar
classes `StringField`, `IntField`, etc. The concrete classes are
`StringScalar`, `IntScalar`, and so on.

---

## Critical Architectural Rules

### Rule 1: Query Engine / Adapter Separation ⭐ MOST IMPORTANT

**The Golden Rule:** Query engine NEVER generates dialect-specific SQL. ALWAYS delegate to adapter.

```typescript
// ❌ WRONG: Hardcoded PostgreSQL in query-engine
sql`COALESCE(json_agg(...), '[]'::json)`

// ✅ RIGHT: Delegate to adapter
ctx.adapter.json.agg(subquery)
```

**Why this exists:** Early VibORM had PostgreSQL syntax scattered throughout query-engine. Adding MySQL support required touching 50+ files. The adapter pattern fixed this - now adding a database means implementing one interface, not hunting for hardcoded SQL.

**The boundary:** Query engine decides WHAT to query (structure, joins, conditions). Adapter decides HOW to express it (syntax, functions, quotes).

**See:** [query-engine/AGENTS.md](src/query-engine/AGENTS.md), [adapters/AGENTS.md](src/adapters/AGENTS.md)

### Rule 2: Natural Type Inference (No Assertions)

Never use type assertions. Types flow from validation schemas:

```typescript
// ❌ BAD: Type assertion breaks inference chain
const schema = v.object({ name: v.string() }) as SomeType;

// ✅ GOOD: Natural inference
const schema = v.object({ name: v.string() });
type Input = InferInput<typeof schema>;
```

**Why this exists:** Type assertions (`as`) hide mismatches that surface as runtime bugs. The entire type system is designed so you never need `as` - if you do, something is wrong upstream.

### Rule 3: Lazy Evaluation for Circular References

Relations use thunks `() => Model` to break circular dependencies:

```typescript
// User references Post, Post references User
const user = s.model({
  posts: s.toMany(() => post),  // Thunk defers evaluation
});
const post = s.model({
  authorId: s.string(),
  author: s.toOne(() => user).fields("authorId").references("id"),
});
```

**Why this exists:** JavaScript can't reference a variable before it's declared. Thunks defer the resolution until the model is actually used, breaking the circular dependency.

### Rule 4: Immutable State with Chainable API

Every scalar/model modifier returns a NEW instance:

```typescript
// Each call returns new instance, original unchanged
s.string()           // StringScalar<{type: "string"}>
  .nullable()        // StringScalar<{type: "string", nullable: true}>  ← NEW instance
  .default("hello")  // StringScalar<{..., default: "hello"}>           ← NEW instance
```

**Why this exists:** TypeScript tracks the State generic through each transformation. Mutation would break this - the type would show `nullable: true` but the runtime value wouldn't have it.

### Rule 5: Typed Fallback Batches and Proven Result Consumption

Sequential transaction fallback preserves statement semantics: model and safe
`Sql` prepared statements use typed execution, while only internally marked
verbatim raw statements use raw execution. Do not infer rawness from a public
shape or add a public batch discriminant.

Provider transport is borrowed by default. Only the exact stock SQLite3 and
PGlite drivers with their internally created active client and unchanged typed
execution/parser surfaces can become a consumable-result candidate. A supplied
client, subclass, execution override, parser middleware, cache-managed read,
transaction, array batch, raw call, or manual parser entry stays borrowed.

The executor keeps execute → proof → parse lexical: execute the exact typed
entry, recheck the same active producer, then synchronously parse that exact
result.
Do not publish an ownership flag, marker, token, result property, or public API.
The operation shell exposes only the internal result-preparation capability;
the generic executor imports no concrete operation.

The compiled row parser is the sole owner of `identity`, `reusable`, or `copy`.
Every collection result gets a fresh public outer array. An identity row may
pass through unchanged; a reusable row may be updated only under the executor's
lexical proof; a copy-policy row always gets a fresh object. Shape-changing
rows copy. Provider-supplied nested object graphs are never mutated; a native
identity row may pass unchanged, but any row that needs decoding uses the copy
path. A nested relation graph may be updated in place only when the relation
carrier parser created it with `JSON.parse`, completed structural validation of
the fixed or variant carrier and its full row set before mutation, and decodes
it through the existing nested parser.

### Rule 6: One Immutable Six-Capability Extension Chain

`$extends()` compiles one ordered immutable chain. Its exact capabilities are
`request`, `query`, `statement`, `observe`, `client`, and `model`; do not add a
second middleware/plugin registry, priority system, public execution token, or
operation-program surface.

The lazy lifecycle is operation observation → request transforms → default omit
→ core validation/preparation → query interception → physical statement
observation → statement transform → render/provider → parse → query post-work →
operation completion. A query child becomes authoritative once `proceed()`
starts. Ordinary observer failures and returned promises never affect the
application. Statement transforms exclude verbatim unsafe raw, while protected
physical statement observation remains disclosure-limited and still covers it.

Raw Date admission has two non-redundant boundaries. `src/client/raw.ts`
refuses invalid caller input before query handlers run;
`src/drivers/provider-parameter-snapshot.ts` revalidates and detaches raw Date
leaves after the last statement transform and before direct or batch provider
dispatch. Resolving a caller-supplied `Sql` first creates one operation-owned
flat projection: query inspection, transaction preparation, and provider
dispatch read the same statement strings and top-level value slots even when
the caller mutates the original fragment during asynchronous pre-`proceed()`
work. It snapshots every admitted data-descriptor ordinary JSON record and
plain array as one stable own-descriptor view, preserving provider-visible
aliases, cycles, sparse arrays, and property descriptors. Admitted foreign
built-in containers normalize to local built-in prototypes; null-prototype
containers remain null-prototype, so caller-owned prototypes do not survive the
snapshot. Classification does not invoke accessors, iterators, or `toJSON`;
Proxy reflection traps can run while presenting the captured view, so the
captured view rather than the later Proxy reaches dispatch. An array with
custom inherited behavior, an indexed accessor, or custom `toJSON` is refused
because provider array semantics would otherwise bypass Date validation.
Custom-prototype records, record accessor carriers, custom-`toJSON` records,
and provider-native objects remain opaque: VibORM does not interpret or detach
values behind that provider-owned boundary. A queued prepared driver batch
detaches both its admitted public parameter graph and its private prepared-`Sql`
provenance. The finalizer recognizes raw work through
`context.model === "$raw"`;
non-raw statements retain their shallow parameter-copy path because typed input
was validated upstream and statement transforms are trusted.

Generic extension ownership is exact: `src/extensions/definition.ts` owns the
public envelope and hostile-definition boundary; `chain.ts` owns the one
resolved chain and handler lookup; `methods.ts` owns client/model factories and
collisions; `request.ts`, `query.ts`, `statement.ts`, and `observation.ts` each
own their capability contract and single runner; `array-admission.ts` owns only
the extension admission latch; and `index.ts` is the intentional surface. Core
array dispatch and the lifecycle facts known only by client, query-engine,
executor, cache, and driver composition roots remain with those roots.

Official `cache()`, `instrumentation()`, and `defaultOmit()` capabilities are
implemented only in `src/cache/extension.ts`,
`src/instrumentation/extension.ts`, and
`src/client/default-omit-extension.ts`. They are authenticated by identity and
replace their old `createClient()` config keys.
Cached values are detached/fresh and custom keys are canonical-key suffixes;
cached reads bypass callback/array transactions, raw calls, and statement-
transform chains. Omit is presentation, not authorization. The extension
foundation ships no RBAC helper; complete policy still needs graph-wide
semantic ownership.

`cache()` produces a namespace-free DEFINITION; the client composition root
binds it to the concrete driver, deriving one scope from the private snapshot
revision, the cache `version`, the dialect, and `adapter.namespace`. The
derivation is pure, so a re-appended chain retains the scope by value — never
add a registry to hand an old one back.

### Rule 7: One namespace, owned by the adapter

`adapter.namespace` is the ONE representation of a driver's SQL qualification
target — a PostgreSQL schema, a MySQL database, a requested Vitess keyspace
qualifier — resolved once at construction from the public `namespace` driver
option. PostgreSQL defaults to `public`; unbound MySQL/PlanetScale leave it
`undefined`; SQLite adapters carry no such property. Its immutability rides the
INSTALL — own, non-writable, non-configurable — not a ban on copies: models,
relations, query scopes, operation programs, result types, journals, cache
identity, and instrumentation read it or do without it, and the two readers that
deliberately capture it once — the bound migration driver at bind time, and the
`dbAttributes` snapshot a cached read takes at `$withCache` — cannot go stale
because the property they read can never be reassigned.

Every VibORM-generated persistent-object reference goes through
`identifiers.table()` (runtime) or a migration driver's qualifier, both composing
through `src/sql/identifiers.ts`. Statement-local names, raw SQL, and stored
MySQL artifacts are the explicit exceptions. Runtime emits neither
`SET search_path` nor `USE`, there is no second configurable source, no
per-model or per-query namespace, no compatibility alias, and no SQLite
attachment equivalent — `tests/contracts/architecture/database-namespace-census.test.ts`
enforces all of that against shipped source.

MySQL2's `migrationNamespaceAttestation: "non-redirecting"` is an independent
transport assertion, never a target and never inferred from a URL, class, host,
handshake, or server version. `db.namespace` is only the OpenTelemetry
attribute; there is no client-level namespace accessor.

**See:** [docs/content/docs/drivers/namespaces.mdx](docs/content/docs/drivers/namespaces.mdx),
[adapters/AGENTS.md](src/adapters/AGENTS.md)

### Rule 8: One fixed-decimal language

`s.decimal({ precision, scale })` is the sole public decimal declaration.
`src/validation/primitives/decimal-codec.ts` owns the one structural descriptor
shape and the field-aware codec. Each scalar validates hostile input once and
freezes one instance of that shape in scalar state as the field's sole
precision/scale source. The codec owns canonical private text,
logical/coefficient conversion, provider scalar/list crossings, and final fresh
`Decimal` construction. Do not add a zero-argument or native decimal mode, a
client string/number result option, an ORM Decimal wrapper, a partial update
bag, or an adapter-wide exact-decimal refusal.

PostgreSQL stores `NUMERIC(p,s)`, MySQL stores `DECIMAL(p,s)`, and SQLite stores
a checked scaled integer coefficient. Decimal lists use native numeric arrays
on PostgreSQL and coefficient-string JSON containers on MySQL/SQLite. Public
typed leaves are fresh Decimal.js values; cache and identity remain canonical
strings. Raw SQL stays physical and receives no descriptor-aware scaling.

`tests/contracts/architecture/decimal-language-census.test.ts` guards the six
retired language shapes across shipped source. Behavior tests own exact
provider answers; the census owns the absence of a second language.

### Rule 9: One DateTime domain

`src/validation/primitives/datetime-values.ts` is the semantic owner of the
public DateTime domain. A timestamp must name a real proleptic-Gregorian date,
use hours `00` through `23` (with minute and second `00` through `59`), use `Z`
or a signed offset no wider than `±23:59`, and represent a UTC instant in the
inclusive range `0000-01-01T00:00:00.000Z` through
`9999-12-31T23:59:59.999Z`. ISO admission, result parsing, and the SQLite
numeric physical codec consume that one owner; do not copy its calendar,
clock, or epoch-bound rules.

SQLite scalar DateTime storage has three declared physical forms: timestamp
TEXT, epoch-millisecond INTEGER, and Julian-day REAL. Every admitted logical
millisecond can be written to and decoded from the REAL form; binary floating
point is rounded back to the logical millisecond rather than used to reject a
valid public value. Migration SQL mirrors the public timestamp grammar and
imports the exact epoch bounds from `datetime-values.ts`. Raw SQL remains
physical and receives no DateTime conversion.

### Rule 10: One GeoPoint language

`s.point()` and `v.point()` share the one exact `{ longitude, latitude }`
value vocabulary owned by `src/validation/primitives/geo-values.ts`. The
import-free leaf also owns the query-only `GeoBounds`, `GeoPolygon`, and
`GeoArea` shapes. `geo-point-codec.ts` alone interprets point values, while
`geo-area-codec.ts` alone interprets bounds and polygon topology. Do not
add `x`/`y`, `lat`/`lng`, GeoJSON, configurable SRID, native point overrides,
ORM point arrays, generic geometry operations, or a second validator.

`DatabaseAdapter.geoPoint` is the sole physical SQL protocol. Construction
snapshots it as one frozen, non-writable fact; optional polygon/distance member
presence proves the tier. Query code decides equality, bounds, polygon,
distance, and projection structure; the adapter alone spells provider SQL.
PostgreSQL uses fixed EPSG:4326 PostGIS, MySQL uses fixed SRID 4326, and SQLite
uses the checked canonical JSON carrier. Raw SQL remains physical.

Migration drivers alone own the three physical types, legal spatial indexes,
introspection, and PostGIS preflight. PostgreSQL never installs PostGIS. Full
provider claims require executed provider evidence; PlanetScale stays preview
until its hosted DDL/function/migration contract is proven. The shipped-source
GeoPoint census owns absence of retired and duplicate languages.

---

## Type Flow (High-Level)

```
User writes:           s.string().nullable()
                              ↓
Scalar creates State:  StringScalar<{type: "string", nullable: true}>
                              ↓
Scalar state stores:    v.string({nullable: true}) as base schema
                              ↓
SchemaRegistry builds: operation schemas from full model graph context
                              ↓
Type inference:        InferInput<schema> → string | null
                              ↓
Client uses types:     orm.user.findMany({ where: { name: ... }})  // Fully typed!
```

**Key insight:** Types flow DOWN through this chain. If types are wrong at the client level, the bug is upstream in schema or scalar definition.

---

## Navigation: Which Layer Do I Modify?

| I want to... | Start here | Also touch |
|--------------|------------|------------|
| Add new scalar type | [schema/scalars/](src/schema/scalars/AGENTS.md) | Update `Scalar` union in `base.ts` |
| Add query operator (e.g., `contains`) | `src/validation/model/core/` or `src/validation/scalars/` | + query-engine + [adapters/](src/adapters/AGENTS.md) (all 3!) |
| Fix operation input type inference bug | [client/](src/client/AGENTS.md) | Check validation model/scalar schema types upstream |
| Add migration operation | [migrations/](src/migrations/AGENTS.md) | + migration drivers (postgres, mysql, sqlite, libsql) |
| Add storage driver | [migrations/](src/migrations/AGENTS.md) | Extend `MigrationStorageDriver` |
| Add relation feature | [schema/relation/](src/schema/relation/AGENTS.md) | + `src/validation/relations/` if query inputs change |
| Add cache backend | [cache/](src/cache/AGENTS.md) | Export from main index |
| Add cache invalidation option | [cache/](src/cache/AGENTS.md) | Update `schema.ts` |
| Add tracing span/attribute | [instrumentation/](src/instrumentation/AGENTS.md) | Update `spans.ts` |
| Add logging level | [instrumentation/](src/instrumentation/AGENTS.md) | Update `types.ts`, `logger.ts` |

---

## Invisible Knowledge (Things Code Doesn't Show)

### Why `" vibInferred"` uses a space prefix
The branded type key is `" vibInferred"` (with space). This prevents collision with any real property name while remaining a valid string key. Using `Symbol()` was tried first but broke type inference across module boundaries.

### Why operation schemas are registry-cached
Operation schemas need full model graph context, especially for nested relation inputs that omit parent-derived foreign keys. `SchemaRegistry` caches model schemas by `Model` object so circular relation thunks resolve lazily without rebuilding schemas per operation.

### Why we don't use `schema.infer`
Early versions used Zod-style `.infer`. With complex nested schemas, TypeScript took 10+ seconds to resolve types. The branded type approach with explicit `InferInput<T>` is O(1) lookup.

### Why adapters return `Sql` fragments, not strings
Sql fragments carry both the template string AND parameter values separately. This enables proper parameterization (prevents SQL injection) and composition (fragments can be nested).

### Why there's no `src/drivers/AGENTS.md`
The driver layer handles connection management and query execution. While there are many drivers (11: pglite, pg, postgres, neon-http, mysql2, planetscale, sqlite3, libsql, d1, bun-sqlite, bun-sql), they follow a consistent pattern. Most complexity lives in adapters (SQL generation) and query-engine (structure).

When a secondary driver failure occurs while a primary failure is already
propagating, `src/drivers/shared/suppressed-failure.ts` is the one evidence
owner. It preserves the primary value and records ordered secondary failures;
do not add cleanup-specific or provider-specific side channels. Its WeakMap is
canonical. The optional non-enumerable debugger mirror is added only when the
primary does not already own that property name; caller-owned error state is
never overwritten.

The generic disconnect lifecycle discards its last transport handle only after
`closeClient()` succeeds. A rejected close removes that exact transport from
active client/initialization state and quarantines it for a later public
disconnect retry: connect and query work refuse with V1003 until cleanup
succeeds, because a provider may have made its handle unusable before rejecting.
No replacement transport is created while cleanup is unresolved.
Provider-specific listeners and retained failure state follow the same
proven-success boundary.

### Why OTel is dynamically imported
OpenTelemetry is an optional peer dependency. Most users don't need tracing. Dynamic `import()` with catch allows graceful degradation when `@opentelemetry/api` isn't installed.

---

## Common Pitfalls

| Mistake | Why it breaks | Fix |
|---------|---------------|-----|
| Hardcoded SQL in query-engine | Breaks MySQL/SQLite | Use `ctx.adapter.*` methods |
| Type assertions (`as`) | Hides type mismatches | Let types flow naturally |
| Forgot `Scalar` union update | New scalar type invisible to models | Update `src/schema/scalars/base.ts` |
| Module-level mutable state | Breaks serverless (Cloudflare) | Use function-scoped or context state |
| Eager operation schema building | Rebuilds schemas on every operation and loses graph context | Use `SchemaRegistry` and `v.lazy` |
| Direct model reference in relation | ReferenceError at runtime | Use thunk `() => model` |
| Recreating objects in hot paths | Performance degradation | Cache in constructor, reuse instances |
| Spread operator on large arrays | Stack overflow | Use `for...of` loops instead |
| Paginated APIs without cursor loop | Incomplete data (e.g., KV list) | Always loop with cursor until complete |
| Schema/type definition mismatch | Runtime validation differs from types | Keep type definitions and runtime schema in sync |
| Blocking background operations | Slow response times | Move locks/checks inside async callbacks |
| Fire-and-forget without error handling | Silent failures | Add `.catch()` with logging |
| DX claim pinned through an internal type alias | The alias is typed, the call site is not | Probe through the public API (see below) |
| Inferred return on a driver `createClient` wrapper | The language service repeatedly expands the full generic client during query completion | Declare the wrapper's `VibORMClient<C & { driver: D }>` return type explicitly |

---

## Testing a DX Claim: Probe Through the Public Surface

Every claim about what the **editor** does — "this completes", "this key is
checked", "a typo here is caught" — is pinned by probes that enter through the
**public API, spelled exactly as a user spells it**, with a **typo probe at every
nesting level**. A probe that names an internal type alias types the alias, not
the call, and does not count.

```typescript
// ❌ BAD: types the alias. Says nothing about what a caller writes.
type Cfg = ClientOmitConfig<typeof schema>;
expectTypeOf<Cfg>().toMatchTypeOf<{ user: { passwordHash?: true } }>();

// ❌ ALSO BAD: enters the public API, but the typo is ALONE — this is red even
// on a completely unkeyed surface, because of weak-type detection (below).
const _typoAlone = () =>
  defaultOmit<typeof schema>()({
    // @ts-expect-error - "passwordHsh" is not a field of user
    user: { passwordHsh: true },
  });

// ✅ GOOD: public API, and the typo sits beside a key that IS real
const _typoBesideReal = () =>
  defaultOmit<typeof schema>()({
    // @ts-expect-error - "passwordHsh" is refused next to the real one
    user: { passwordHash: true, passwordHsh: true },
  });
```

**Why this exists:** the retired built-in omit configuration shipped this gap
twice. The same evidence now enters through `defaultOmit()`, the current public
owner. Both times the RESULT types were already right; only the type contextual
to the literal being written was wrong, which no result-shape assertion can see.

Three rules follow. The third one invalidated the first version of this section,
which is why it is stated first now.

1. **Put the typo BESIDE A REAL KEY. A typo alone proves nothing.** Every config
   bag and every query clause here is a **weak type** — all properties optional —
   and TypeScript refuses an object that shares *no* property with a weak type.
   So `omit: { user: { passwordHsh: true } }` and `where: { ttitle: "x" }` are
   red on a *completely unkeyed* surface: what rejected them was that rule, not
   this codebase's types. Add one correct key and the rule stops applying. When
   this was measured, `defaultOmit()({ user: { passwordHash: true,
   passwordHsh: true } })` hid one of two secrets and compiled,
   `instrumentation({ tracing: true, loging: true })` started no logger and
   compiled, and `where: { title: "x", ttitle: "x" }`
   returned rows the caller never asked for and compiled — all three while a gate
   full of alone-probes was green. Write both: `…Alone` and `…BesideReal`. Only
   the second is evidence.
2. **A typo probe per nesting level.** `where` refusing a bad key says nothing
   about `where.title.contains`. Probe the operation keys, each clause, the
   operators inside a clause, and the same clauses one relation deeper. Levels
   that cannot be reached get pinned (below), not assumed.
3. **Refuse structurally, not by excess-property checking.** EPC needs a *fresh*
   object literal, so a config or options bag held in a variable sails through
   it; and a generic `O extends Options` is no guard either, because TypeScript
   silently **clamps** `O` to the constraint. Intersect
   `Record<Exclude<keyof Given, keyof Allowed>, never>` into the parameter — see
   `UnknownOmitKeys` / `ExactOptions` (`src/schema/model/model.ts`),
   `NoExtraConfigKeys` / `NoExtraNestedConfigKeys` (`src/client/client.ts`),
   `NoExtraOperationKeys` (`src/client/types.ts`) and `ExactPushOptions`
   (`src/migrations/push/index.ts`). Probe both fresh and non-fresh.

**Pin what you cannot key, with the number that stopped you.** Some levels are
genuinely out of reach, and the gate records each one as a *misspelled call that
compiles* — no `@ts-expect-error`, so the day it becomes reachable the line goes
red and someone deletes the pin. A pin is only honest with its obstacle attached:
guarding every query clause crashes tsc 5.8.3 outright; naming `data` turns six
estate sites into TS2589 and takes the type-check from 34s to 172s; keying
`.references()` through the relation getter was measured at 123 estate errors.
"We could not" is a claim like any other — measure it.

The gate lives in `tests/types/client/contextual-typing-gate.core.types.ts`. It is enforced
by `pnpm test:types`, not by a runtime assertion: a `@ts-expect-error` that stops
being an error is itself an error (TS2578), so a regression that re-opens a
surface turns the type-check red.

## One guard per invariant — redundant defense is BANNED

A check whose only unique coverage is a scenario some other check already fails
loudly on is not safety, it is noise that must be read, maintained, and audited
forever. Maintainer rule (2026-07-29): **do not write it**. Before adding any
guard or assertion, name the failure it alone catches; if you cannot, it does
not go in. This applies to runtime asserts duplicating type-level pins, to
in-engine shape checks duplicating the parse boundary (already a gate), and to
"belt and suspenders" test assertions beside a falsifying pin.

Case studies, both audited out of this codebase: `assertScalarOnlyFilter`
duplicated the validation schema's own rejection and was reachable only by the
test written to reach it (deleted, commit `78f3a0c`); an `Object.keys(ref)`
runtime assertion duplicated the `keyof AnyFieldRef` type pin whose failure
already guards the same invariant (removed before merge, PR #18). The house
discipline is one guard per invariant, in the invariant's single home, with a
falsification proving THAT guard fires — not two guards half-trusted.

Shared representation predicates live in `src/validation/value-guards.ts`.
Reuse `isRecord`, `isString`, `isFunction`, `isNumber`, `isBoolean`, `isBigInt`,
`isDate`, and `isUint8Array` instead of recreating their exact checks. Both are
realm-independent: `isDate` proves `[[DateValue]]` for every object through
`Date.prototype.getTime`, while `isUint8Array` uses the built-in typed
array tag accessor, so foreign-realm natives pass and `Symbol.toStringTag`
spoofs fail. After `isDate` admits a value, read its instant and ISO form only
through the corresponding `Date.prototype` intrinsics; its instance methods
remain caller-overridable. Blob admission reads intrinsic `buffer`,
`byteOffset`, and `byteLength` metadata through `%TypedArray%.prototype` and
re-views foreign-realm, subclassed, caller-owned custom-prototype, or
own-shadowed values. An unshadowed value on the exact local
`Uint8Array.prototype` or captured local Node Buffer prototype is already a
trusted runtime boundary, so it keeps its identity and prototype. Public
metadata agreement is never proof because a stateful prototype can lie on a
later driver read. These predicates belong at ADMISSION boundaries, which
normalize an admitted value to a trustworthy local one (`blob.ts` re-views,
`iso.ts` emits ISO text); past that
boundary every value is local, so an interior `instanceof Date` /
`instanceof Uint8Array` is the intended check, not an unconverted call site. Keep stronger boundary
rules local to their semantic owner, such as hostile diagnostic reads,
plain-prototype checks, finite/integer checks, promise-like values, and JSON
records.

Runtime validation failures use `ValidationError.source` to name their owning
boundary. Operation failures keep V4001 and Prisma P2009. Registry,
schema-builder, and JSON Schema failures use V4002 without a Prisma equivalent.
No raw `Error` may escape `src/validation`; Standard Schema validators return
issues, and `SchemaRegistry` translates thrown external-validator failures.

---

## Build/Test Commands

```bash
# Development
pnpm build               # Complete safe TypeScript shards; compiles nothing
pnpm package:build       # tsdown - actual package build (dist output)
pnpm test:types          # Complete sequential TypeScript shards, including every .core.types.ts project
pnpm test                # Type-check plus the trusted aggregate core
pnpm test:core           # All core runtime projects
pnpm test:all            # Core, extended-local, local providers, optional Bun, local D1, and package checks
pnpm test:coverage       # Sequential subsystem shards, merged global report, and working-tree metadata
pnpm test:coverage:public # Public root surface; 100% in all four metrics
pnpm test:coverage:schema # Whole schema subsystem; 100% in all four metrics
pnpm test:coverage:validation # Validation subsystem; 100% in all four metrics
pnpm test:coverage:sql   # SQL subsystem; 100% in all four metrics
pnpm test:coverage:instrumentation # Instrumentation subsystem; 100% in all four metrics
pnpm test:coverage:extensions # Extension subsystem; 100% in all four metrics
pnpm test:coverage:errors # Error subsystem; 100% in all four metrics
pnpm test:coverage:adapters # Adapter subsystem; 100% in all four metrics
pnpm test:coverage:cli   # CLI subsystem; 100% in all four metrics
pnpm test:coverage:query-engine-core # Query-engine core; 98% in all four metrics
pnpm test:coverage:write-engine # Write engine; 98% in all four metrics
pnpm test:coverage:drivers # Drivers; 98% in all four metrics
pnpm test:coverage:client # Client; 98% in all four metrics
pnpm test:coverage:cache # Cache; 98% in all four metrics
pnpm test:coverage:migrations # Migrations; 98% in all four metrics
pnpm test:coverage:policy # Static ownership and bounded-runner policy tests
pnpm test:package        # Build once and validate every declared export
pnpm test:providers      # Docker and hosted projects only; missing environment values skip visibly
pnpm test:watch          # Core projects only
pnpm test:ui             # Core projects in the Vitest UI

# Fast layer feedback (all 13 enforce one shared 30 second budget)
pnpm test:layer:validation
pnpm test:layer:scalars
pnpm test:layer:operation-schemas
pnpm test:layer:relations
pnpm test:layer:schema-validation
pnpm test:layer:schema-json
pnpm test:layer:query-engine
pnpm test:layer:adapters
pnpm test:layer:drivers
pnpm test:layer:client
pnpm test:layer:cache
pnpm test:layer:instrumentation
pnpm test:layer:migrations

# Operation-pipeline performance evidence
pnpm bench:operation-pipeline
pnpm bench:operation-pipeline:check
pnpm bench:operation-pipeline:describe
pnpm bench:operation-pipeline:diagnostic # Fast directional tuning only; never keep evidence

# Large selections must use the package scripts. Vitest runs one file at a time
# with a 768 MB heap. Every child process group has a 1536 MiB sampled RSS ceiling.
# Coverage orchestration and report merging also use a 768 MB Node heap.
# Complete TypeScript checking is split into sequential 1280 MB heap shards.
# Launchers verify whole-group teardown before they return.
```

Query and write core admission is fail-closed in
`scripts/query-engine-test-manifest.mjs`. Every architecture, query, and write
`.core.test.ts` file appears exactly once; the coverage policy rejects missing
or duplicate assignments. Do not replace this manifest with recursive globs,
because a filename suffix does not prove that a future fixture is provider-free.
Cache coverage admits every cache core file plus its four deterministic public
client contracts and rejects resource-owning provider imports. Migration
coverage uses `scripts/migration-test-manifest.mjs` for deterministic core and
selected local extended contracts; its policy gate rejects omissions and live
PGlite ownership. Client coverage uses `scripts/client-test-manifest.mjs` for
its core and audited deterministic extended contracts. Full write coverage
adds an explicit high-signal subset of the credential-free local estate. The
focused write set is entirely provider-free. Driver coverage uses
`scripts/driver-test-manifest.mjs`, which admits five audited SQLite-backed
contracts and the local SQLite3 and LibSQL suites and gives each of them its own
declared process. No focused subsystem executes against a PGlite database;
`test:all` remains the exhaustive local owner for PGlite behavior. All run
through dedicated coverage projects.
Core layer projects use no network, Docker service, hosted credential, or live
provider process. Keep provider-backed evidence in the extended or provider
estate and use deterministic recording drivers for core contracts.

The coverage runner executes subsystems sequentially. A subsystem with an
explicit curated test list uses one bounded project invocation unless its
manifest declares fixed chunks or explicit groups; all parts run sequentially
and are merged only after each process exits. A multi-project subsystem runs each
project once in sequence and merges its parts. Focused reports are written to
`coverage/<subsystem>/index.html`. The global command replaces
`coverage/index.html` and records `HEAD`, whether the working tree was dirty,
the thresholds, and visible waivers in `coverage/metadata.json`. Waived source
remains in the denominator.

## Release Ownership

[`RELEASING.md`](RELEASING.md) is the one maintainer runbook for npm and GitHub
publication. The `Release` workflow on protected `main` is the sole publication
owner: it builds one tarball, tests those exact bytes, publishes them through
npm OIDC with automatic provenance, verifies registry integrity and that
provenance, and only then creates the matching immutable GitHub tag and release.
Never publish from a worktree, use an
`NPM_TOKEN`, rebuild between testing and publication, or create the version tag
by hand.

For V1, `1.0.0-rc.N` publishes under `next` and stable `1.0.0` publishes under
`latest`; all other prerelease spellings are refused. A release-required
provider that does not execute is a failed gate, not a skip. A preview or
conditional provider can remain non-blocking only when the public support table
states the same limitation.

Operation-pipeline comparisons use explicit clean worktrees at explicit
commits. Declare the exact workload, stage, mode, and target metric before the
run. Collect five alternating samples per side in fresh processes and accept a
target only when its improvement exceeds 2×MAD. Run coordinators sequentially;
do not overlap them with another benchmark, test, or TypeScript process.

Ordinary PGlite contracts use one `usePGliteSchemaFamily` per compatible schema
and substrate. The fixture pushes once, truncates tables between tests, and owns
disconnect. Fresh databases are reserved for DDL, lifecycle, destructive
schema, independently committed concurrency, staleness/race, and
rollback-isolation contracts. Never overlap a Vitest, layer, or TypeScript run;
the launchers enforce a workspace lock. Before taking that lock they inspect
the process table and refuse a stale workspace Vitest, TypeScript, tsdown, or
Vitest worker process. They fail closed when that preflight cannot be completed.
A stale or unreadable lock is never deleted automatically; first prove that no
verification process remains, then remove it explicitly. Bounded verification
fails closed on Windows until process-tree RSS enforcement and teardown can be
verified there.

A witness retained only to execute incidental implementation metadata for a
numeric coverage gate belongs at the bottom of its owning layer file under
`describe("coverage low value")`. It is not evidence for a behavioral contract
and must not be mixed into one.

---

## Code Style Essentials

### Path Aliases
`@schema`, `@client`, `@validation`, `@query-engine`, `@adapters`, `@drivers`, `@sql`, `@cache`, `@instrumentation`

### Naming Conventions
- Scalar factories: lowercase (`string()`, `int()`)
- Scalar classes: PascalCase + Scalar (`StringScalar`, `IntScalar`)
- Types: PascalCase (`ScalarState`, `ModelState`)

### Internal API: `["~"]` Symbol
```typescript
scalar["~"].state         // ScalarState - configuration object
scalar["~"].state.base    // Base scalar schema
schemaRegistry.proxy.user.core.where // Operation schema for this model
relation["~"].state.getter // Thunk to target model
```

---

## Example: Full Type Flow

```typescript
import { s } from "viborm";

// 1. Define schema (L2-L4)
const user = s.model({
  id: s.string().id().ulid(),
  email: s.string().unique(),
  posts: s.toMany(() => post),
});

const post = s.model({
  id: s.string().id().ulid(),
  authorId: s.string(),
  author: s.toOne(() => user).fields("authorId").references("id"),
});

// 2. Query with full type safety (L9 → L6 → L7 → L8)
const users = await orm.user.findMany({
  where: { email: { contains: "@company.com" } },  // ← Typed!
  include: { posts: { where: { published: true } } }  // ← Typed!
});
// users: Array<{ id: string; email: string; posts: Post[] }>  ← Inferred!
```
