# VibORM Implementation Guide

> **For AI Systems:** This document helps you systematically work on VibORM — whether implementing new features, fixing bugs, or addressing GitHub issues. The key is to understand the architecture and reason about which layers are affected.

---

## What is VibORM?

VibORM is a **fully type-safe ORM** for TypeScript with a Prisma-like query API and no code generation.

### Comparison with Other ORMs

| | Prisma | Drizzle | VibORM |
|---|--------|---------|--------|
| Query syntax | Object-based (`where`, `include`) | SQL-builder | Object-based (`where`, `include`) |
| Type source | Generated from schema | Inferred from builders | Inferred from schema |
| Code generation | Required (`prisma generate`) | None | None |
| Runtime dependencies | WASM query engine | None | None |
| Schema definition | `.prisma` files | TypeScript | TypeScript |

### VibORM Query Example

```typescript
const users = await orm.user.findMany({
  where: { 
    email: { contains: "@company.com" },
    posts: { some: { published: true } }
  },
  include: { 
    posts: { where: { published: true } } 
  }
});
```

This query is fully typed — `where`, `include`, and the result type are all inferred from the schema definition.

### How Types Are Inferred

VibORM uses a **validation-driven type system**:

> **Types are inferred from validation schemas, not generated.**

The approach:
1. User defines schema in TypeScript (`s.model()`, `s.string()`, etc.)
2. Schema definition creates runtime state holding field metadata
3. State is used to build validation schemas for each query type (`where`, `create`, etc.)
4. TypeScript infers input/output types from those validation schemas

This provides full type safety for `where`, `select`, `include`, `create`, `update` without any code generation step.

### The Type System Pipeline

Here's how types flow through VibORM:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    THE VIBORM TYPE SYSTEM                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. User defines schema:     const User = s.model({...})           │
│                                       │                             │
│                                       ▼                             │
│  2. Schema holds state:      User["~"].state (fields, relations)   │
│                                       │                             │
│                                       ▼                             │
│  3. State builds schemas:    User["~"].schemas.where (validation)  │
│                                       │                             │
│                                       ▼                             │
│  4. Schemas infer types:     InferInput<typeof whereSchema>        │
│                                       │                             │
│                                       ▼                             │
│  5. Types flow to client:    orm.user.findMany({ where: {...} })   │
│                              ─────────────────────────────────────  │
│                              Fully typed at compile time!           │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Concepts

| Concept | Description |
|---------|-------------|
| **Schema Definition** | User-facing API (`s.model()`, `s.string()`) that creates runtime state |
| **State** | Internal representation holding metadata (field types, relations, options) |
| **Query Schemas** | Validation schemas (via `v.*`) that validate AND type query inputs |
| **Type Inference** | Types extracted from schemas using `InferInput<S>` / `InferOutput<S>` |

### The Golden Rule: Natural Type Inference

**VibORM relies on natural TypeScript inference. Never use type assertions.**

```typescript
// ❌ BAD: Type assertions break the inference chain
const schema = v.object({ name: v.string() }) as SomeType;
type Input = SomeType; // Manually declared, can drift from reality

// ✅ GOOD: Let TypeScript infer from the schema
const schema = v.object({ name: v.string() });
type Input = InferInput<typeof schema>; // Always correct, auto-updates
```

When implementing changes:
- Use **generic constraints** to preserve type information
- Use **mapped types** to transform object shapes
- Use **conditional types** for type-level branching
- **Never cast** (`as`) unless absolutely required for external library interop

---

## Step 1: Identify Work Type

Before diving into implementation, identify what type of work this is:

| Work Type | Description | Go To |
|-----------|-------------|-------|
| **New Feature** | Adding new capability (field type, relation, query operator) | [Feature Implementation](#feature-implementation) |
| **Bug Fix** | Something doesn't work as expected | [Bug Fix Process](#bug-fix-process) |
| **Refactoring** | Improving code without changing behavior | [Feature Implementation](#feature-implementation) (subset) |


---

## Bug Fix Process

When fixing a bug, follow this process before layer analysis:

### 1. Understand the Symptom

```
Bug Report:
─────────────────────────────────────────────────────────
Symptom: [What is happening?]
Expected: [What should happen?]
Reproduction: [Steps or code to reproduce]
Environment: [TypeScript version, database, etc.]
─────────────────────────────────────────────────────────
```

### 2. Root Cause Analysis

Before fixing, identify WHERE the bug originates:

```
Investigation:
─────────────────────────────────────────────────────────
Hypothesis: [Which layer(s) might be involved?]

Layer 2 (Schema Definition):
  □ Is the schema state being built incorrectly?
  □ Are field/relation options being lost?

Layer 3 (Query Schema):
  □ Is the validation schema accepting invalid input?
  □ Is the validation schema rejecting valid input?
  □ Are types being inferred incorrectly?

Layer 4 (Validation Library):
  □ Is a v.* primitive behaving incorrectly?
  □ Is type inference broken at the validation level?

Layer 6 (Query Engine):
  □ Is SQL being generated incorrectly?
  □ Is the wrong builder being called?
  □ Is context not flowing correctly?

Layer 7 (Adapters):
  □ Is this database-specific?
  □ Is the dialect handling wrong?

Layer 9 (Client):
  □ Is the result being hydrated incorrectly?
  □ Are result types wrong?

Layer 10 (Cache):
  □ Is the cache key being generated correctly?
  □ Is TTL parsing correct?
  □ Is cache invalidation working?
  □ Is SWR pattern behaving correctly?

Root Cause: [Identified layer and specific issue]
─────────────────────────────────────────────────────────
```

### 3. Fix Implementation

Once root cause is identified:
1. Write a failing test that reproduces the bug
2. Make the minimal fix in the identified layer
3. Verify the test passes
4. Check for regressions in related functionality

### 4. Bug Fix Documentation

```markdown
## Bug: [Short description]

### Symptom
[What was happening]

### Root Cause
[Which layer, which file, what was wrong]

### Fix
[What was changed]

### Test
[Test file/name that prevents regression]
```

---

## Feature Implementation

For new features, continue to the layer analysis below.

---

## Core Principle

**Every feature implementation must answer one question for each layer:**

> "Does this feature affect this layer? If yes, why and how?"

Do not assume all layers need changes. Analyze the feature requirements and justify each modification.

---

## VibORM Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER 1: User API                                     src/index.ts  │
│  What the developer writes when defining schemas and queries         │
│  ────────────────────────────────────────────────────────────────── │
│  Examples: s.model(), s.string(), orm.user.findMany()               │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER 2: Schema Definition                              src/schema/ │
│  Classes and types that represent the user's schema at runtime       │
│  ────────────────────────────────────────────────────────────────── │
│  ├── model/      Model class, ModelState, helpers                   │
│  ├── fields/     Field types (string, number, datetime, etc.)       │
│  └── relation/   Relation types (one, many)                         │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER 3: Query Schema                          src/schema/*/schemas │
│  Validation schemas for query inputs (where, create, update, etc.)   │
│  ────────────────────────────────────────────────────────────────── │
│  ├── model/schemas/core/    filter, create, update, select, where   │
│  ├── model/schemas/args/    findMany, create, update, delete args   │
│  └── relation/schemas/      nested relation schemas                 │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER 4: Validation Library                        src/validation/  │
│  The underlying validation primitives (similar to Zod/Valibot)       │
│  ────────────────────────────────────────────────────────────────── │
│  ├── schemas/     v.object(), v.string(), v.union() implementations │
│  ├── types.ts     VibSchema interface, InferInput, InferOutput      │
│  └── index.ts     Main v.* exports                                  │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER 5: Schema Validation                  src/schema/validation/  │
│  Rules that validate the schema itself is correct at definition time │
│  ────────────────────────────────────────────────────────────────── │
│  ├── validator.ts     SchemaValidator class                         │
│  ├── rules/           Validation rule implementations               │
│  └── types.ts         ValidationError, ValidationContext            │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER 6: Query Engine                            src/query-engine/  │
│  Transforms validated query objects into SQL                         │
│  ────────────────────────────────────────────────────────────────── │
│  ├── builders/       SQL builders (select, where, include, etc.)    │
│  ├── operations/     Operation implementations (find, create, etc.) │
│  ├── context/        Query context management                       │
│  └── result/         Result hydration                               │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER 7: Database Adapters                            src/adapters/ │
│  Database-specific SQL generation and dialect handling              │
│  ────────────────────────────────────────────────────────────────── │
│  ├── types.ts             DatabaseAdapter interface                 │
│  └── databases/           postgres.ts, mysql.ts                     │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER 8: Driver Layer                                 src/drivers/  │
│  Low-level database connection and query execution                   │
│  ────────────────────────────────────────────────────────────────── │
│  ├── driver.ts        Base driver interface                        │
│  ├── types.ts         Driver types                                  │
│  └── errors.ts        Connection errors                             │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER 9: Client Layer                                  src/client/  │
│  The ORM client and result type inference                            │
│  ────────────────────────────────────────────────────────────────── │
│  ├── client.ts          Main ORM client class                       │
│  ├── types.ts           Operation argument types                    │
│  └── result-types.ts    Result type inference                       │
└──────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER 10: Cache Layer                                    src/cache/ │
│  Query result caching with multiple backends                         │
│  ────────────────────────────────────────────────────────────────── │
│  ├── driver.ts          Abstract CacheDriver base class             │
│  ├── client.ts          CachedClient proxy                          │
│  ├── key.ts             Cache key generation                        │
│  ├── ttl.ts             TTL parsing                                 │
│  ├── schema.ts          Cache invalidation schema                   │
│  └── drivers/           Backend implementations                     │
└──────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER 11: Instrumentation                       src/instrumentation/│
│  OpenTelemetry tracing and structured logging                        │
│  ────────────────────────────────────────────────────────────────── │
│  ├── context.ts         InstrumentationContext (tracer + logger)    │
│  ├── tracer.ts          TracerWrapper for OTel spans                │
│  ├── logger.ts          Structured logging                          │
│  ├── spans.ts           Span names and attribute constants          │
│  └── types.ts           Configuration interfaces                    │
└──────────────────────────────────────────────────────────────────────┘
```

### Quick Layer Reference

| Layer | Location | Primary Responsibility |
|-------|----------|------------------------|
| 1. User API | `src/index.ts` | Public exports |
| 2. Schema Definition | `src/schema/` | Schema metadata & state |
| 3. Query Schema | `src/schema/*/schemas/` | Query input validation |
| 4. Validation Library | `src/validation/` | v.* primitives |
| 5. Schema Validation | `src/schema/validation/` | Definition-time checks |
| 6. Query Engine | `src/query-engine/` | SQL generation |
| 7. Database Adapters | `src/adapters/` | Dialect differences |
| 8. Driver Layer | `src/drivers/` | Connection & execution |
| 9. Client Layer | `src/client/` | Result types & client |
| 10. Cache Layer | `src/cache/` | Query caching & invalidation |
| 11. Instrumentation | `src/instrumentation/` | Tracing & logging |
| Tests | `tests/` | All test files |

---

## Layer Analysis Framework

For each feature, work through this analysis:

### Step 1: Identify Feature Category

What type of feature is this?

| Category | Examples | Typically Affects |
|----------|----------|-------------------|
| **New primitive** | New field type, new relation type | Layers 2, 3, 5, 6, 7, 9 |
| **New query capability** | New filter operator, new aggregation | Layers 3, 6, 7 |
| **New schema modifier** | New field option, new model option | Layers 2, 3, 5 |
| **Query API extension** | New operation type, new include pattern | Layers 3, 6, 9 |
| **Connection feature** | Transactions, connection pooling | Layers 8, 9 |
| **Cache feature** | New cache backend, invalidation strategy | Layer 10 |
| **Observability feature** | New span type, log level, attributes | Layer 11 |
| **Internal improvement** | Performance, refactoring | Varies |

### Step 2: Layer-by-Layer Analysis

For each layer, answer:

```
┌─────────────────────────────────────────────────────────────────┐
│ LAYER: [Name]                                                    │
├─────────────────────────────────────────────────────────────────┤
│ Does this feature affect this layer?  [ ] Yes  [ ] No          │
│                                                                  │
│ If YES:                                                          │
│ • WHY: [Explain the reason this layer needs changes]            │
│ • WHAT: [List specific changes needed]                          │
│ • FILES: [List files to create or modify]                       │
│                                                                  │
│ If NO:                                                           │
│ • WHY NOT: [Explain why this layer is unaffected]               │
└─────────────────────────────────────────────────────────────────┘
```

---

## Layer Details & Decision Points

### Layer 1: User API

**Location:** `src/index.ts`

**Key files:**
| File | Purpose |
|------|---------|
| `src/index.ts` | Main exports — the `s` object and all public APIs |

**When to modify:**
- Exposing a new factory function (e.g., new field type, new relation type)
- Adding new top-level exports

**Key questions:**
- Does the new feature need to be exported from `s.*`?
- Is this a breaking change to existing exports?

---

### Layer 2: Schema Definition

**Location:** `src/schema/`

**Key files:**
| File/Folder | Purpose |
|-------------|---------|
| `src/schema/model/model.ts` | `Model` class, `ModelState` interface |
| `src/schema/model/helper.ts` | Type helpers, field extractors |
| `src/schema/model/types.ts` | Model-related type definitions |
| `src/schema/fields/` | All field type implementations |
| `src/schema/fields/base.ts` | Base `Field` class |
| `src/schema/fields/string.ts` | String field implementation |
| `src/schema/fields/types.ts` | Field type definitions, `FieldState` |
| `src/schema/relation/` | Relation implementations |
| `src/schema/relation/relation.ts` | `Relation` class, relation factories |
| `src/schema/relation/types.ts` | Relation type definitions |
| `src/schema/index.ts` | Schema layer exports |

**When to modify:**
- Adding a new concept users define (new field type, relation type, model modifier)
- Adding new metadata that needs to be stored at definition time
- Changing how existing definitions work

**Key questions:**
- Does this introduce a new class or modify an existing one?
- Does `ModelState` need new properties to track this feature?
- Are new type definitions needed for proper inference?
- Does this need lazy evaluation (thunks) to handle circular references?

**Common patterns:**
- State interface to hold feature configuration
- Getter methods to resolve lazy references
- Type helpers for inference

---

### Layer 3: Query Schema

**Location:** `src/schema/*/schemas/`

**Key files:**
| File/Folder | Purpose |
|-------------|---------|
| `src/schema/model/schemas/` | Model-level query schema factories |
| `src/schema/model/schemas/index.ts` | Composes all model schemas |
| `src/schema/model/schemas/core/` | Core schema factories |
| `src/schema/model/schemas/core/filter.ts` | Filter/where schema factory |
| `src/schema/model/schemas/core/create.ts` | Create input schema factory |
| `src/schema/model/schemas/core/update.ts` | Update input schema factory |
| `src/schema/model/schemas/core/select.ts` | Select/include schema factory |
| `src/schema/model/schemas/core/where.ts` | Where clause schema factory |
| `src/schema/model/schemas/core/orderby.ts` | OrderBy schema factory |
| `src/schema/model/schemas/args/` | Operation argument schemas |
| `src/schema/model/schemas/args/find.ts` | findMany/findFirst args |
| `src/schema/model/schemas/args/create.ts` | create/createMany args |
| `src/schema/model/schemas/args/update.ts` | update/updateMany args |
| `src/schema/model/schemas/args/delete.ts` | delete/deleteMany args |
| `src/schema/model/schemas/args/aggregate.ts` | aggregate/groupBy args |
| `src/schema/relation/schemas/` | Relation-level query schemas |
| `src/schema/relation/schemas/filter.ts` | Relation filter schemas |
| `src/schema/relation/schemas/create.ts` | Nested create schemas |
| `src/schema/relation/schemas/update.ts` | Nested update schemas |
| `src/schema/relation/schemas/select-include.ts` | Relation select/include |

**When to modify:**
- Feature affects how queries are written (new filter, new input shape)
- Feature introduces new query arguments
- Feature changes validation of existing query inputs

**Key questions:**
- Which query operations are affected? (find, create, update, delete, aggregate)
- Does this need new schema factories?
- How do these schemas compose with existing model schemas?
- What are the input types? Output types?

**Common patterns:**
- Factory functions that take state and return schemas
- Lazy schema resolution for recursive types
- Integration into core schema builders (filter, create, update, select)

---

### Layer 4: Validation Library

**Location:** `src/validation/`

**Key files:**
| File/Folder | Purpose |
|-------------|---------|
| `src/validation/index.ts` | Exports `v.*` helpers |
| `src/validation/types.ts` | Core types: `VibSchema`, `InferInput`, `InferOutput` |
| `src/validation/schemas/` | Schema implementations |
| `src/validation/schemas/object.ts` | `v.object()` implementation |
| `src/validation/schemas/string.ts` | `v.string()` implementation |
| `src/validation/schemas/union.ts` | `v.union()` implementation |
| `src/validation/schemas/array.ts` | `v.array()` implementation |
| `src/validation/schemas/optional.ts` | `v.optional()` implementation |
| `src/validation/schemas/lazy.ts` | `v.lazy()` for recursive schemas |
| `src/validation/helpers.ts` | Utility functions |
| `src/validation/inferred.ts` | Type inference utilities |

**When to modify:**
- Need a new validation primitive that doesn't exist
- Need new type inference capabilities
- Existing helpers need additional generic parameters

**Key questions:**
- Can this be implemented with existing `v.*` helpers?
- If not, what new schema type is needed?
- Does this require changes to `InferInput` or `InferOutput`?

**When NOT to modify:**
- Most features don't need validation library changes
- Prefer composing existing primitives over adding new ones

---

### Layer 5: Schema Validation (Definition-time)

**Location:** `src/schema/validation/`

**Key files:**
| File/Folder | Purpose |
|-------------|---------|
| `src/schema/validation/index.ts` | Exports validator and rules |
| `src/schema/validation/validator.ts` | `SchemaValidator` class |
| `src/schema/validation/types.ts` | `ValidationError`, `ValidationContext` types |
| `src/schema/validation/rules/` | Validation rule implementations |
| `src/schema/validation/rules/field.ts` | Field-specific validation rules |
| `src/schema/validation/rules/relation.ts` | Relation-specific validation rules |
| `src/schema/validation/rules/model.ts` | Model-level validation rules |

**When to modify:**
- Feature can be misconfigured and errors should be caught early
- Feature has constraints that span multiple models
- Existing validation rules need to recognize the new feature

**Key questions:**
- What errors can occur at schema definition time?
- What warnings should be raised?
- Are there cross-model validations needed?

**Common patterns:**
- Rule functions that return `ValidationError[]`
- Error codes with severity levels
- Context objects for cross-model checks

---

### Layer 6: Query Engine

**Location:** `src/query-engine/`

**Key files:**
| File/Folder | Purpose |
|-------------|---------|
| `src/query-engine/query-engine.ts` | Main `QueryEngine` class |
| `src/query-engine/types.ts` | Query engine types |
| `src/query-engine/errors.ts` | Query-related error classes |
| `src/query-engine/builders/` | SQL builder functions |
| `src/query-engine/builders/select-builder.ts` | SELECT clause building |
| `src/query-engine/builders/where-builder.ts` | WHERE clause building |
| `src/query-engine/builders/include-builder.ts` | Include/join building |
| `src/query-engine/builders/create-builder.ts` | INSERT building |
| `src/query-engine/builders/update-builder.ts` | UPDATE building |
| `src/query-engine/builders/delete-builder.ts` | DELETE building |
| `src/query-engine/builders/orderby-builder.ts` | ORDER BY building |
| `src/query-engine/context/` | Query context management |
| `src/query-engine/context/index.ts` | `QueryContext` interface |
| `src/query-engine/operations/` | Operation implementations |
| `src/query-engine/operations/find.ts` | findMany/findFirst |
| `src/query-engine/operations/create.ts` | create/createMany |
| `src/query-engine/operations/update.ts` | update/updateMany |
| `src/query-engine/operations/delete.ts` | delete/deleteMany |
| `src/query-engine/result/` | Result handling |
| `src/query-engine/result/hydrator.ts` | Result hydration |

**When to modify:**
- Feature affects SQL generation
- Feature introduces new query patterns
- Feature changes how results are structured

**Key questions:**
- Does this need a new builder or modify existing ones?
- What SQL patterns does this feature produce?
- What context needs to flow through query building?
- Does this affect result hydration?
- Does this work identically on PostgreSQL, MySQL, and SQLite?
- If using advanced SQL features (CTEs, JSON aggregation, window functions), what's the fallback for less capable databases?
- Should complex logic happen in SQL or in the result parser for portability?

**Common patterns:**
- Builder functions that take context and return SQL fragments
- Context objects that carry state through the build process
- Composition of SQL fragments using the sql template tag
- **Always call `ctx.adapter.*` for any SQL that might differ between databases**

**⚠️ CRITICAL: Database-Agnostic Query Engine**

The query engine must NEVER contain hardcoded SQL or database-specific syntax. All SQL generation must be delegated to the database adapter via `ctx.adapter.*` methods.

```typescript
// ❌ BAD: Hardcoded SQL in query-engine builder
function buildIncludeSubquery(ctx: QueryContext, relation: RelationInfo): Sql {
  // PostgreSQL-specific syntax!
  return sql`COALESCE(json_agg(row_to_json(${alias}.*)), '[]')`;
}

// ❌ BAD: Conditional SQL based on dialect in query-engine
function buildIncludeSubquery(ctx: QueryContext, relation: RelationInfo): Sql {
  if (ctx.adapter.dialect === "postgres") {
    return sql`json_agg(...)`;
  } else if (ctx.adapter.dialect === "mysql") {
    return sql`JSON_ARRAYAGG(...)`;
  }
}

// ✅ GOOD: Delegate to adapter
function buildIncludeSubquery(ctx: QueryContext, relation: RelationInfo): Sql {
  const subquery = buildRelationQuery(ctx, relation);
  return ctx.adapter.jsonAggregate(subquery, { coalesce: true });
}
```

**Why this separation matters:**
- Query engine handles **query logic** (what to query, how to structure)
- Adapters handle **SQL dialect** (how to express it in each database)
- This enables multi-database support from the same query engine code
- Database-specific features (JSON functions, array operators, etc.) belong in adapters

**Decision: SQL vs Application-Side Processing**

When a feature requires data transformation, consider where the logic should live:

| Factor | Prefer SQL | Prefer Application (Result Parser) |
|--------|-----------|-----------------------------------|
| Portability | Low (DB-specific syntax) | High (works on all databases) |
| Complexity | Simple transforms, filtering | Complex tree/graph building |
| Data volume | Large (reduce data transfer) | Small (negligible difference) |
| Examples | Filtering, aggregation, joins | Building nested trees from flat rows |

**Rule of thumb:** If the SQL would differ significantly between PostgreSQL, MySQL, and SQLite, consider doing the transformation in the result parser instead.

---

### Layer 7: Database Adapters

**Location:** `src/adapters/`

**Key files:**
| File/Folder | Purpose |
|-------------|---------|
| `src/adapters/index.ts` | Adapter exports |
| `src/adapters/types.ts` | `DatabaseAdapter` interface |
| `src/adapters/database-adapter.ts` | Base adapter implementation |
| `src/adapters/provider-adapter.ts` | Provider abstraction |
| `src/adapters/databases/` | Database-specific implementations |
| `src/adapters/databases/postgres.ts` | PostgreSQL adapter |
| `src/adapters/databases/mysql.ts` | MySQL adapter |
| `src/adapters/databases/sqlite.ts` | SQLite adapter (if exists) |

**When to modify:**
- Feature has database-specific SQL requirements
- Feature uses functions that differ between databases
- Feature is only supported on certain databases
- **Query engine needs a new SQL operation that varies by database**

**Key questions:**
- Does this work identically on PostgreSQL, MySQL, and SQLite?
- What functions or syntax differ between databases?
- Should unsupported features throw or degrade gracefully?

**⚠️ CRITICAL: This is WHERE SQL Lives**

All database-specific SQL generation belongs here, NOT in the query engine. When adding new SQL capabilities:

1. **Add method to `DatabaseAdapter` interface** (`src/adapters/types.ts`)
2. **Implement in each adapter** (`postgres.ts`, `mysql.ts`, `sqlite.ts`)
3. **Call from query engine** via `ctx.adapter.methodName()`

```typescript
// src/adapters/types.ts
interface DatabaseAdapter {
  // ... existing methods ...
  
  // Add new method for database-specific SQL
  jsonAggregate(subquery: Sql, options?: { coalesce?: boolean }): Sql;
}

// src/adapters/databases/postgres.ts
jsonAggregate(subquery: Sql, options?: { coalesce?: boolean }): Sql {
  const agg = sql`json_agg(${subquery})`;
  return options?.coalesce ? sql`COALESCE(${agg}, '[]')` : agg;
}

// src/adapters/databases/mysql.ts
jsonAggregate(subquery: Sql, options?: { coalesce?: boolean }): Sql {
  const agg = sql`JSON_ARRAYAGG(${subquery})`;
  return options?.coalesce ? sql`COALESCE(${agg}, JSON_ARRAY())` : agg;
}
```

**When NOT to modify:**
- Standard SQL that works on all supported databases
- Features already abstracted by existing adapter methods

---

### Layer 8: Driver Layer (Connection)

**Location:** `src/drivers/`

**Key files:**
| File/Folder | Purpose |
|-------------|---------|
| `src/drivers/driver.ts` | Base driver interface and implementation |
| `src/drivers/types.ts` | Driver type definitions |
| `src/drivers/errors.ts` | Driver-related error classes |
| `src/drivers/index.ts` | Driver exports |

**When to modify:**
- Feature requires new connection capabilities
- Feature needs transaction support changes
- Feature affects how queries are executed at the driver level

**Key questions:**
- Does this feature need raw SQL execution changes?
- Are there connection pooling implications?
- Does this affect transaction handling?

**When NOT to modify:**
- Most features don't touch the driver layer
- Only modify if you need low-level execution changes

---

### Layer 9: Client Layer

**Location:** `src/client/`

**Key files:**
| File/Folder | Purpose |
|-------------|---------|
| `src/client/client.ts` | Main ORM client class |
| `src/client/types.ts` | Operation argument types |
| `src/client/result-types.ts` | Result type inference helpers |

**When to modify:**
- Feature affects the shape of query results
- Feature introduces new operation types
- Feature changes how result types are inferred

**Key questions:**
- How does this affect `InferResult` types?
- Are new type helpers needed?
- Does the client need new methods?

---

### Layer 10: Cache Layer

**Location:** `src/cache/`

**Key files:**
| File/Folder | Purpose |
|-------------|---------|
| `src/cache/driver.ts` | Abstract CacheDriver base class |
| `src/cache/client.ts` | CachedClient proxy for cached queries |
| `src/cache/key.ts` | Cache key generation (deterministic hashing) |
| `src/cache/ttl.ts` | TTL string parsing ("1 hour" → ms) |
| `src/cache/schema.ts` | Cache invalidation options schema |
| `src/cache/types.ts` | TypeScript types for cache options |
| `src/cache/drivers/memory.ts` | In-memory cache implementation |
| `src/cache/drivers/cloudflare-kv.ts` | Cloudflare KV cache implementation |

**When to modify:**
- Adding new cache backend implementations
- Changing cache key generation logic
- Modifying TTL parsing or invalidation patterns
- Adding new cache options or strategies

**Key questions:**
- Does this need a new cache driver?
- How does cache invalidation work for this feature?
- What TTL semantics are needed?
- Does SWR (stale-while-revalidate) apply?

**When NOT to modify:**
- Query execution logic (that's query-engine)
- Database-specific SQL (that's adapters)
- Client result types (that's client layer)

---

### Layer 11: Instrumentation

**Location:** `src/instrumentation/`

**Key files:**
| File/Folder | Purpose |
|-------------|---------|
| `src/instrumentation/context.ts` | `InstrumentationContext` - combines tracer + logger |
| `src/instrumentation/tracer.ts` | `TracerWrapper` - OpenTelemetry span management |
| `src/instrumentation/logger.ts` | `Logger` - structured console/callback logging |
| `src/instrumentation/spans.ts` | Span names and attribute constants |
| `src/instrumentation/types.ts` | Configuration interfaces |

**When to modify:**
- Adding new span types for new operations
- Adding new attributes to existing spans
- Adding new log levels or log event types
- Changing how OTel integration works

**Key questions:**
- Does this operation need its own span?
- What attributes should be recorded?
- Is this a log event that users might want to observe?
- Does this need to work without OTel installed?

**When NOT to modify:**
- Query logic (that's query-engine)
- Cache logic (that's cache layer)
- Just adding instrumentation calls to existing code (use existing span types)

**Key patterns:**
- All mutable state must be instance-scoped (not module-level) for serverless
- OTel is optional - always handle missing dependency gracefully
- Use `context.with()` to ensure proper span parenting

---

## Documentation Template

When implementing a feature, document the following:

```markdown
# [Feature Name] Implementation

## 1. Overview
What this feature does and why it's needed.

## 2. User-Facing API
How developers will use this feature.

## 3. Layer Analysis

### Layer 2: Schema Definition
**Affected:** Yes/No
**Reason:** [Why or why not]
**Changes:** [If yes, what changes]

### Layer 3: Query Schema
**Affected:** Yes/No
**Reason:** [Why or why not]
**Changes:** [If yes, what changes]

### Layer 10: Cache
**Affected:** Yes/No
**Reason:** [Why or why not]
**Changes:** [If yes, what changes]

### Layer 11: Instrumentation
**Affected:** Yes/No
**Reason:** [Why or why not]
**Changes:** [If yes, what changes]

[Continue for each layer...]

## 4. Type System Design
Key types and how inference flows.

## 5. Alternatives Considered
What other approaches were rejected and why.

## 6. Files Summary
| File | Action | Purpose |
|------|--------|---------|
| path/to/file.ts | CREATE/MODIFY | Description |

## 7. Tests Required
- [ ] Type inference tests
- [ ] Runtime validation tests
- [ ] SQL generation tests
- [ ] Integration tests
```

---

## Test Files Reference

**Location:** `tests/`

| Folder/File | Purpose |
|-------------|---------|
| `tests/fields/` | Field type tests (validation, schemas) |
| `tests/model/` | Model-related tests |
| `tests/model/filter/` | Filter/where schema tests |
| `tests/model/create/` | Create schema tests |
| `tests/model/update/` | Update schema tests |
| `tests/model/args/` | Operation args tests |
| `tests/relations/` | Relation tests |
| `tests/query-engine/` | SQL generation tests |
| `tests/validation/` | Validation library tests |
| `tests/client/` | Client layer tests |
| `tests/schema.ts` | Shared test schemas |
| `tests/test-models.ts` | Shared test model definitions |

**Test naming convention:** `[feature].test.ts` or `[feature]-[aspect].test.ts`

**Running tests:** `pnpm vitest run tests/[path]`

---

## Code Examples: Proper Modification Patterns

This section shows **proof patterns** — examples of how to correctly modify VibORM layers while preserving type inference.

### Example 1: Adding a New Field Type

When adding a new field type (e.g., `s.uuid()`):

```typescript
// ─────────────────────────────────────────────────────────────────────
// src/schema/fields/uuid.ts — New file
// ─────────────────────────────────────────────────────────────────────

import { Field, type FieldState } from "./base";
import * as v from "@validation";

// 1. Define state interface — this is what gets stored
export interface UuidFieldState extends FieldState {
  type: "uuid";           // Discriminator for type inference
  version?: 4 | 7;        // Field-specific options
}

// 2. Define class with generic to preserve state type
export class UuidField<S extends UuidFieldState = UuidFieldState> extends Field<S> {
  
  // 3. Chainable methods return NEW instance with UPDATED generic
  version<V extends 4 | 7>(v: V): UuidField<S & { version: V }> {
    return new UuidField({ ...this.state, version: v });
  }
  
  // 4. Build validation schema from state (NOT hardcoded types)
  protected buildSchema() {
    return v.pipe(
      v.string(),
      v.uuid({ version: this.state.version })
    );
  }
}

// 5. Factory function — entry point for users
export const uuid = (): UuidField => new UuidField({ type: "uuid" });
```

```typescript
// ─────────────────────────────────────────────────────────────────────
// src/schema/fields/index.ts — Export the new field
// ─────────────────────────────────────────────────────────────────────

export { uuid, UuidField, type UuidFieldState } from "./uuid";
```

### Example 2: Adding Query Schema Support

When a feature needs query schemas (where, create, etc.):

```typescript
// ─────────────────────────────────────────────────────────────────────
// src/schema/model/schemas/core/filter.ts — Modify existing
// ─────────────────────────────────────────────────────────────────────

// BEFORE: Scalar fields only
const scalarEntries = forEachScalarField(state.fields, (field, name) => ({
  [name]: field["~"].schemas.filter,
}));

// AFTER: Add the new field type
const scalarEntries = forEachScalarField(state.fields, (field, name) => ({
  [name]: field["~"].schemas.filter,
}));

// If new field type needs special handling:
const uuidEntries = forEachFieldOfType(state.fields, "uuid", (field, name) => ({
  [name]: buildUuidFilter(field),  // Custom filter schema
}));

// Merge into final schema
return v.object({
  ...scalarEntries,
  ...uuidEntries,  // Add new entries
  AND: () => v.array(getFilterSchema()),
  OR: () => v.array(getFilterSchema()),
  NOT: () => getFilterSchema(),
});
```

### Example 3: Type-Safe Generic Factories

When building factories that need to preserve types from state:

```typescript
// ─────────────────────────────────────────────────────────────────────
// Pattern: Factory with full type preservation
// ─────────────────────────────────────────────────────────────────────

// ❌ BAD: Loses type information
function buildSchema(state: ModelState) {
  const entries: Record<string, VibSchema> = {};  // Type is lost!
  for (const [k, v] of Object.entries(state.fields)) {
    entries[k] = v["~"].schemas.filter;
  }
  return v.object(entries);  // Returns VibSchema<unknown, unknown>
}

// ✅ GOOD: Preserves exact field types via mapped type
function buildSchema<T extends ModelState>(state: T) {
  type FieldSchemas = {
    [K in keyof T["fields"]]: T["fields"][K]["~"]["schemas"]["filter"]
  };
  
  // Build at runtime
  const entries = {} as FieldSchemas;
  for (const [k, field] of Object.entries(state.fields)) {
    entries[k as keyof FieldSchemas] = field["~"].schemas.filter;
  }
  
  return v.object(entries);  // Returns exact typed schema!
}
```

### Example 4: Adding Validation Rules

When adding schema validation (definition-time checks):

```typescript
// ─────────────────────────────────────────────────────────────────────
// src/schema/validation/rules/uuid.ts — New validation rules
// ─────────────────────────────────────────────────────────────────────

import type { ValidationError, ValidationContext } from "../types";
import type { Model } from "@schema/model";

export function uuidVersionRequired(
  field: UuidField,
  fieldName: string,
  model: Model<any>,
  ctx?: ValidationContext
): ValidationError[] {
  const errors: ValidationError[] = [];
  
  // Check if version is specified when field is used as ID
  if (field.state.isId && !field.state.version) {
    errors.push({
      code: "UUID001",
      severity: "warning",
      message: `UUID field "${fieldName}" is used as ID but has no version specified. Consider using .version(7) for sortable IDs.`,
      path: [model.name, fieldName],
    });
  }
  
  return errors;
}
```

### Example 5: SQL Builder Modifications (Database-Agnostic)

When modifying query engine builders, **always delegate database-specific SQL to adapters**:

```typescript
// ─────────────────────────────────────────────────────────────────────
// src/query-engine/builders/where-builder.ts — Add new operator
// ─────────────────────────────────────────────────────────────────────

// Pattern: Switch on operator, delegate SQL generation to adapter
function buildFieldCondition(
  ctx: QueryContext,
  field: Field,
  operator: string,
  value: unknown,
  alias: string
): Sql {
  const column = ctx.adapter.qualifyColumn(alias, field.columnName);
  
  switch (operator) {
    case "equals":
      return ctx.adapter.equals(column, value);
    case "contains":
      // Delegate to adapter - handles LIKE vs ILIKE, escaping, etc.
      return ctx.adapter.contains(column, value as string);
    case "uuidVersion":
      // Delegate database-specific UUID handling to adapter
      return ctx.adapter.uuidVersionCheck(column, value as number);
    default:
      throw new QueryError(`Unknown operator: ${operator}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// src/adapters/types.ts — Define adapter interface
// ─────────────────────────────────────────────────────────────────────
interface DatabaseAdapter {
  uuidVersionCheck(column: Sql, version: number): Sql;
  // ...
}

// ─────────────────────────────────────────────────────────────────────
// src/adapters/databases/postgres.ts — PostgreSQL implementation
// ─────────────────────────────────────────────────────────────────────
uuidVersionCheck(column: Sql, version: number): Sql {
  return sql`get_byte(${column}::bytea, 6) >> 4 = ${version}`;
}

// ─────────────────────────────────────────────────────────────────────
// src/adapters/databases/mysql.ts — MySQL implementation
// ─────────────────────────────────────────────────────────────────────
uuidVersionCheck(column: Sql, version: number): Sql {
  return sql`SUBSTRING(${column}, 15, 1) = ${version.toString(16)}`;
}
```

**Key principle:** Query engine code should read like pseudocode describing WHAT to do, while adapters contain the actual SQL for HOW to do it on each database.

---

## Common Patterns Reference

### Pattern: Lazy Evaluation (Thunks)
Use when circular references are possible between models.
```typescript
// Wrap in arrow function to defer evaluation
s.relation.one(() => OtherModel)

// In schema factories, return thunks for recursive schemas
return v.object({
  author: () => getAuthorSchema(),  // Lazy — evaluated when needed
  posts: () => v.array(getPostSchema()),
});
```

### Pattern: Schema Path Access
Access nested schemas via the internal symbol `"~"`.
```typescript
// From model
model["~"].schemas.where
model["~"].state.fields

// From field
field["~"].schemas.filter
field["~"].state.type

// From relation
relation["~"].schemas.include
relation["~"].targetModel
```

### Pattern: Type Extraction from Lazy Getters
When dealing with lazy getters, extract types properly.
```typescript
// The getter
type Getter = () => SomeModel;

// Extract the return type
type Model = ReturnType<Getter>;

// Extract model state
type State = Model["~"]["state"];
```

### Pattern: Discriminated Unions
Use for type-safe variant handling.
```typescript
// Define union with discriminator
type Result = 
  | { type: "post"; data: Post }
  | { type: "video"; data: Video };

// TypeScript narrows based on discriminator
function handle(result: Result) {
  if (result.type === "post") {
    result.data.title;  // ✅ TypeScript knows this is Post
  }
}
```

### Pattern: Mapped Types for Object Transformation
Use to transform object shapes while preserving keys.
```typescript
// Transform each field to its filter schema
type FieldFilters<F extends Record<string, Field>> = {
  [K in keyof F]?: InferInput<F[K]["~"]["schemas"]["filter"]>
};
```

### Pattern: Conditional Schema Properties
When a schema property should only be available under certain conditions (e.g., a feature only makes sense for specific field/relation types), conditionally include it at the schema level:
```typescript
// Only include 'recurse' option if relation is self-referencing
export const toManyIncludeFactory = <S extends RelationState>(state: S) => {
  const isSelfRef = isSelfReferencing(state);
  
  return v.object({
    where: () => getTargetWhereSchema(state)(),
    orderBy: () => getTargetOrderBySchema(state)(),
    take: v.number(),
    skip: v.number(),
    // Conditionally include - TypeScript will only allow this property
    // when the condition is true
    ...(isSelfRef ? { recurse: recurseSchema } : {}),
  });
};
```

**Why this matters:** This provides compile-time safety. TypeScript prevents invalid usage (e.g., using `recurse` on a non-self-referencing relation) rather than requiring runtime validation. The invalid option simply doesn't exist in the type.

---

## Checklists

Use the appropriate checklist based on work type.

### Feature Implementation Checklist

```
ANALYSIS
□ Work type identified (feature / refactor)
□ Feature category identified (primitive / query / modifier / extension)
□ Each layer analyzed: affected (why, what files) or not affected (why not)
□ Design decisions documented with alternatives considered

TYPE SYSTEM
□ State interface defined (if new concept)
□ Generic parameters preserve type flow
□ No type assertions (`as`) used — only natural inference
□ InferInput / InferOutput produce correct types

IMPLEMENTATION
□ Layer 2 (Schema Definition): State and class implemented
□ Layer 3 (Query Schema): Schema factories added/modified
□ Layer 5 (Schema Validation): Validation rules added (if needed)
□ Layer 6 (Query Engine): Builders updated for SQL generation
□ Layer 7 (Adapters): Database-specific handling (if needed)
□ Layer 9 (Client): Result types updated (if needed)
□ Layer 10 (Cache): Cache logic updated (if needed)
□ Exports added to index.ts files

TESTING
□ Type tests: expectTypeOf checks for all inferred types
□ Schema tests: Valid inputs accepted, invalid rejected
□ SQL tests: Correct SQL generated for PostgreSQL and MySQL
□ Integration: End-to-end query execution works

DOCUMENTATION
□ Feature document in features-docs/
□ Code comments for complex logic
```

### Bug Fix Checklist

```
INVESTIGATION
□ Symptom clearly understood
□ Reproduction steps confirmed
□ Root cause layer identified
□ Specific file/function identified

FIX
□ Failing test written first
□ Minimal fix applied
□ Test now passes
□ No regressions in related tests

DOCUMENTATION
□ Bug documented (symptom, root cause, fix)
□ Test prevents future regression
```
