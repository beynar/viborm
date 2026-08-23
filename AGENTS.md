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
| **L1: Validation** | `src/validation/` | v.* primitives, Standard Schema V1, `SchemaRegistry` operation schemas | Scalar logic, domain rules | [validation/AGENTS.md](src/validation/AGENTS.md) |
| **L2: Scalars** | `src/schema/scalars/`, `src/schema/field-ref.ts`, `src/schema/hydration.ts` | Scalar classes, State generics, base scalar schemas, runtime schema metadata | Operation schemas | [schema/scalars/AGENTS.md](src/schema/scalars/AGENTS.md) |
| **L3: Operation Schemas** | `src/validation/model/`, `src/validation/relations/` | where, create, update, args schemas | SQL generation | — |
| **L4: Relations** | `src/schema/relation/` | The two factories, the declaration state, the terminal capability surfaces | Pairing, ownership, query execution | [schema/relation/AGENTS.md](src/schema/relation/AGENTS.md) |
| **L5: Schema Validation** | `src/schema/validation/` | Definition-time validation; the ONE schema-wide relation topology owner (`relation-resolution.ts`) | Runtime validation | — |
| **L6: Query Engine** | `src/query-engine/` | Query structure, logic | **Database SQL** | [query-engine/AGENTS.md](src/query-engine/AGENTS.md) |
| **L7: Adapters** | `src/adapters/` | **Database-specific SQL** | Query logic | [adapters/AGENTS.md](src/adapters/AGENTS.md) |
| **L8: Drivers** | `src/drivers/` | Connection, execution | Query building | — |
| **L9: Client** | `src/client/` | Result types, proxies | Query construction | [client/AGENTS.md](src/client/AGENTS.md) |
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
The driver layer handles connection management and query execution. While there are many drivers (13+: pglite, pg, postgres, neon-http, mysql2, planetscale, sqlite3, libsql, d1, d1-http, bun-sqlite, bun-sql), they follow a consistent pattern. Most complexity lives in adapters (SQL generation) and query-engine (structure).

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
  createClient({
    schema: { user },
    driver,
    // @ts-expect-error - "passwordHsh" is not a field of user
    omit: { user: { passwordHsh: true } },
  });

// ✅ GOOD: public API, and the typo sits beside a key that IS real
const _typoBesideReal = () =>
  createClient({
    schema: { user },
    driver,
    omit: {
      // @ts-expect-error - "passwordHsh" is refused next to the real one
      user: { passwordHash: true, passwordHsh: true },
    },
  });
```

**Why this exists:** `omit` shipped the same gap twice. `f842302` keyed the core
`createClient` config after the contextual type turned out to be an index
signature — results were correct, but the editor had no keys to offer and a
typo'd model name compiled. `2f7bd59` then found the identical hole still open in
all eleven driver-package wrappers, the entry point most apps import. Both times
the RESULT types were already right; only the type contextual to the literal
being written was wrong, which no result-shape assertion can see.

Three rules follow. The third one invalidated the first version of this section,
which is why it is stated first now.

1. **Put the typo BESIDE A REAL KEY. A typo alone proves nothing.** Every config
   bag and every query clause here is a **weak type** — all properties optional —
   and TypeScript refuses an object that shares *no* property with a weak type.
   So `omit: { user: { passwordHsh: true } }` and `where: { ttitle: "x" }` are
   red on a *completely unkeyed* surface: what rejected them was that rule, not
   this codebase's types. Add one correct key and the rule stops applying. When
   this was measured, `omit: { passwordHash: true, passwordHsh: true }` hid one
   of two secrets and compiled, `instrumentation: { tracing: true, loging: true }`
   started no logger and compiled, and `where: { title: "x", ttitle: "x" }`
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
and `isDate` instead of recreating their exact checks. Keep stronger boundary
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
pnpm build               # tsc with noEmit - type-checks only, compiles nothing
pnpm package:build       # tsdown - actual package build (dist output)
pnpm test:types          # Complete TypeScript check, including .core.types.ts
pnpm test                # Type-check plus the trusted aggregate core
pnpm test:core           # All core runtime projects
pnpm test:all            # Every credential-free extended/provider/package check
pnpm test:coverage       # Core layers plus full write-engine V8 coverage
pnpm test:coverage:instrumentation # Memory-capped L11 report; 100% in all four metrics
pnpm test:coverage:scalars # Memory-capped L2 report; 100% in all four metrics
pnpm test:coverage:relations # Memory-capped L4 report; 100% in all four metrics
pnpm test:coverage:schema # Memory-capped runtime schema-metadata report; 100% in all four metrics
pnpm test:coverage:sql   # Memory-capped SQL-fragment report; 100% in all four metrics
pnpm test:coverage:schema-validation # Memory-capped L5 report; 100% in all four metrics
pnpm test:coverage:validation # Memory-capped L1/L3 report; 100% in all four metrics
pnpm test:coverage:write-engine # Memory-capped full write-engine report; numeric gate
pnpm test:package        # Build once and validate every declared export
pnpm test:providers      # Docker and hosted projects; missing services skip visibly
pnpm test:watch          # Core projects only

# Fast layer feedback (all 12 follow this form and enforce a 30 second budget)
pnpm test:layer:validation
pnpm test:layer:query-engine
pnpm test:layer:drivers
pnpm test:layer:client

# Large selections must use the package scripts. Vitest runs one file at a time
# with a 768 MB heap. Full tsc has a measured 4 GB cap. Launchers stop the whole
# process group on timeout or interruption so workers cannot survive.
```

Ordinary PGlite contracts use one `usePGliteSchemaFamily` per compatible schema
and substrate. The fixture pushes once, truncates tables between tests, and owns
disconnect. Fresh databases are reserved for DDL, lifecycle, destructive
schema, independently committed concurrency, staleness/race, and
rollback-isolation contracts. Never overlap a Vitest, layer, or TypeScript run;
the launchers enforce a workspace lock.

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
