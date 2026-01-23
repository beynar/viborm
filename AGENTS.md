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
| **L1: Validation** | `src/validation/` | v.* primitives, Standard Schema V1 | Field logic, domain rules | [validation/AGENTS.md](src/validation/AGENTS.md) |
| **L2: Fields** | `src/schema/fields/` | Field classes, State generics | Query schemas | [schema/fields/AGENTS.md](src/schema/fields/AGENTS.md) |
| **L3: Query Schemas** | `src/schema/model/schemas/` | where, create, update, args schemas | SQL generation | [model/schemas/AGENTS.md](src/schema/model/schemas/AGENTS.md) |
| **L4: Relations** | `src/schema/relation/` | Relation types, nested schemas | Query execution | [schema/relation/AGENTS.md](src/schema/relation/AGENTS.md) |
| **L5: Schema Validation** | `src/schema/validation/` | Definition-time validation | Runtime validation | — |
| **L6: Query Engine** | `src/query-engine/` | Query structure, logic | **Database SQL** | [query-engine/AGENTS.md](src/query-engine/AGENTS.md) |
| **L7: Adapters** | `src/adapters/` | **Database-specific SQL** | Query logic | [adapters/AGENTS.md](src/adapters/AGENTS.md) |
| **L8: Drivers** | `src/drivers/` | Connection, execution | Query building | — |
| **L9: Client** | `src/client/` | Result types, proxies | Query construction | [client/AGENTS.md](src/client/AGENTS.md) |
| **L10: Cache** | `src/cache/` | Query caching, invalidation | Query execution | [cache/AGENTS.md](src/cache/AGENTS.md) |
| **L11: Instrumentation** | `src/instrumentation/` | Tracing, logging | Query logic | [instrumentation/AGENTS.md](src/instrumentation/AGENTS.md) |
| **L12: Migrations** | `src/migrations/` | Schema sync, migration files, DDL | Schema definition | [migrations/AGENTS.md](src/migrations/AGENTS.md) |

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
  posts: s.oneToMany(() => post),  // Thunk defers evaluation
});
const post = s.model({
  author: s.manyToOne(() => user),
});
```

**Why this exists:** JavaScript can't reference a variable before it's declared. Thunks defer the resolution until the model is actually used, breaking the circular dependency.

### Rule 4: Immutable State with Chainable API

Every field/model modifier returns a NEW instance:

```typescript
// Each call returns new instance, original unchanged
s.string()           // StringField<{type: "string"}>
  .nullable()        // StringField<{type: "string", nullable: true}>  ← NEW instance
  .default("hello")  // StringField<{..., default: "hello"}>           ← NEW instance
```

**Why this exists:** TypeScript tracks the State generic through each transformation. Mutation would break this - the type would show `nullable: true` but the runtime value wouldn't have it.

---

## Type Flow (High-Level)

```
User writes:           s.string().nullable()
                              ↓
Field creates State:   StringField<{type: "string", nullable: true}>
                              ↓
Schema factory builds: v.string({nullable: true})  (lazy, on first ["~"] access)
                              ↓
Type inference:        InferInput<schema> → string | null
                              ↓
Client uses types:     orm.user.findMany({ where: { name: ... }})  // Fully typed!
```

**Key insight:** Types flow DOWN through this chain. If types are wrong at the client level, the bug is upstream in schema or field definition.

---

## Navigation: Which Layer Do I Modify?

| I want to... | Start here | Also touch |
|--------------|------------|------------|
| Add new field type | [schema/fields/](src/schema/fields/AGENTS.md) | Update Field union in `base.ts` |
| Add query operator (e.g., `contains`) | [query-engine/](src/query-engine/AGENTS.md) | + [adapters/](src/adapters/AGENTS.md) (all 3!) |
| Fix type inference bug | [client/](src/client/AGENTS.md) | Check schema factories upstream |
| Add migration operation | [migrations/](src/migrations/AGENTS.md) | + migration drivers (postgres, mysql, sqlite, libsql) |
| Add storage driver | [migrations/](src/migrations/AGENTS.md) | Extend `MigrationStorageDriver` |
| Add relation feature | [schema/relation/](src/schema/relation/AGENTS.md) | + relation schemas |
| Add cache backend | [cache/](src/cache/AGENTS.md) | Export from main index |
| Add cache invalidation option | [cache/](src/cache/AGENTS.md) | Update `schema.ts` |
| Add tracing span/attribute | [instrumentation/](src/instrumentation/AGENTS.md) | Update `spans.ts` |
| Add logging level | [instrumentation/](src/instrumentation/AGENTS.md) | Update `types.ts`, `logger.ts` |

---

## Invisible Knowledge (Things Code Doesn't Show)

### Why `" vibInferred"` uses a space prefix
The branded type key is `" vibInferred"` (with space). This prevents collision with any real property name while remaining a valid string key. Using `Symbol()` was tried first but broke type inference across module boundaries.

### Why schemas are lazy (`??=` pattern)
Schemas are expensive to build. The `??=` pattern ensures they're built once on first access and cached, avoiding repeated construction on every `["~"]` access.

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
| Forgot Field union update | New field type invisible to models | Update `src/schema/fields/base.ts` |
| Module-level mutable state | Breaks serverless (Cloudflare) | Use function-scoped or context state |
| Eager schema building | Rebuilds schemas on every access (perf) | Use `??=` lazy pattern |
| Direct model reference in relation | ReferenceError at runtime | Use thunk `() => model` |
| Recreating objects in hot paths | Performance degradation | Cache in constructor, reuse instances |
| Spread operator on large arrays | Stack overflow | Use `for...of` loops instead |
| Paginated APIs without cursor loop | Incomplete data (e.g., KV list) | Always loop with cursor until complete |
| Schema/type definition mismatch | Runtime validation differs from types | Keep type definitions and runtime schema in sync |
| Blocking background operations | Slow response times | Move locks/checks inside async callbacks |
| Fire-and-forget without error handling | Silent failures | Add `.catch()` with logging |

---

## Build/Test Commands

```bash
# Development
pnpm build              # Compile TypeScript
pnpm type-check         # Type check only (faster)
pnpm test               # Run all tests
pnpm test:watch         # Watch mode

# Single file/pattern
pnpm vitest run tests/validation/string.test.ts
pnpm vitest run -t "validates strings"

# Database tests (requires Docker)
pnpm test:pg            # PostgreSQL
pnpm test:mysql         # MySQL  
pnpm test:sqlite        # SQLite
```

---

## Code Style Essentials

### Path Aliases
`@schema`, `@client`, `@validation`, `@query-engine`, `@adapters`, `@drivers`, `@sql`, `@cache`, `@instrumentation`

### Naming Conventions
- Field factories: lowercase (`string()`, `int()`)
- Field classes: PascalCase + Field (`StringField`, `IntField`)
- Types: PascalCase (`FieldState`, `ModelState`)

### Internal API: `["~"]` Symbol
```typescript
field["~"].state          // FieldState - configuration object
field["~"].schemas        // {base, filter, create, update} - lazy built
model["~"].schemas.where  // Where schema for this model
relation["~"].targetModel // Thunk to target model
```

---

## Example: Full Type Flow

```typescript
import { s } from "viborm";

// 1. Define schema (L2-L4)
const user = s.model({
  id: s.string().id().ulid(),
  email: s.string().unique(),
  posts: s.oneToMany(() => post),
});

const post = s.model({
  id: s.string().id().ulid(),
  authorId: s.string(),
  author: s.manyToOne(() => user).fields("authorId").references("id"),
});

// 2. Query with full type safety (L9 → L6 → L7 → L8)
const users = await orm.user.findMany({
  where: { email: { contains: "@company.com" } },  // ← Typed!
  include: { posts: { where: { published: true } } }  // ← Typed!
});
// users: Array<{ id: string; email: string; posts: Post[] }>  ← Inferred!
```
