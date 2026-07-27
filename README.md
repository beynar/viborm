# VibORM

Type-safe TypeScript ORM with **zero code generation**. Types are inferred from schema definitions at compile time—no `prisma generate` needed.

## Key Features

| Feature | Description |
|---------|-------------|
| **Zero Codegen** | Types flow from schema → query → result via TypeScript inference |
| **Standard Schema V1** | Interoperable with Zod, Valibot, ArkType for validation |
| **Prisma-inspired API** | Familiar `findMany`, `create`, `update` operations with `where`, `include`, `select` |
| **Multi-Database** | PostgreSQL, MySQL, SQLite from one codebase via adapter pattern |
| **Chainable Schema** | `s.string().nullable().unique()` with immutable state tracking |

## Prisma Compatibility Snapshot

VibORM is Prisma-inspired, not a full Prisma clone. The matrix below compares the normal Prisma Client relational CRUD/query surface with VibORM's current documented contract. `Supported` means the input works for the documented surface or rejects before query generation; it does not mean every Prisma preview, provider-specific, or unsafe API exists.

Detailed contract: [client compatibility](docs/content/docs/client/compatibility.mdx) and [Prisma parity contract](docs/architecture/prisma-parity-contract.md). Prisma baseline: [CRUD](https://www.prisma.io/docs/orm/prisma-client/queries/crud) and [aggregation/grouping](https://www.prisma.io/docs/orm/prisma-client/queries/aggregation-grouping-summarizing).

Status legend:

| Status | Meaning |
|--------|---------|
| `Supported` | Same core shape as Prisma for the documented relational SQL surface |
| `Subset` | Prisma supports more shapes; VibORM supports a smaller fail-closed subset |
| `Different` | Intentional VibORM API decision |
| `Unsupported` | Not part of the current public contract |

### Basic CRUD

| Area | Prisma Client | VibORM | Status |
|------|---------------|--------|--------|
| Single-record reads | `findUnique`, `findUniqueOrThrow`, `findFirst`, `findFirstOrThrow` with `where`, `orderBy`, `select`, `include` | Same core operations; unique reads require a real unique discriminator (which may be narrowed by non-unique scalar filters and `AND`/`OR`/`NOT`, Prisma ≥4.5) and or-throw variants throw `NotFoundError` | `Supported` |
| Multi-record reads | `findMany` with filters, ordering, pagination, `distinct`, `select`, `include` | Supports scalar/relation filters, scalar and supported relation ordering, cursor/offset pagination, negative `take`, `distinct`, `select`, `include` | `Supported` |
| Create one | `create` with scalar data, nested writes, `select`, `include` | Supports scalar data and documented nested writes; unsupported nested write keys reject before parent mutation | `Supported` |
| Create many | `createMany` returns `{ count }`; `createManyAndReturn` is a separate provider-specific method | `createMany` returns `{ count }`, or the inserted rows when the call carries a `select` (implicit returning — there is no `createManyAndReturn` method); `skipDuplicates` skips duplicate-key conflicts only, and combining it with `select` needs a `RETURNING` dialect | `Different` |
| Update one | `update` by unique selector; returns updated row; supports atomic numeric ops and nested writes | Requires unique `where`; throws on missing row; supports scalar updates, atomic numeric ops, and documented nested writes | `Supported` |
| Update many | `updateMany` returns `{ count }`; `updateManyAndReturn` is a separate provider-specific method | `updateMany` returns `{ count }`, or the updated rows when the call carries a `select` (implicit returning — there is no `updateManyAndReturn` method) | `Different` |
| Upsert | `upsert` with unique `where`, `create`, `update`; returns row | Same core shape; supported nested writes are allowed in covered branches | `Supported` |
| Delete | `delete` by unique selector returns deleted row; `deleteMany` returns `{ count }` | Same core shape; `delete` throws on missing row and non-returning dialects fetch before delete where safe. `deleteMany` additionally returns the deleted rows when the call carries a `select` — a superset Prisma has no form of | `Different` |

### Advanced Queries

| Area | Prisma Client | VibORM | Status |
|------|---------------|--------|--------|
| Scalar filters | `where` with scalar operators and `AND`/`OR`/`NOT` | Supports documented scalar operators and logical filters; unknown/unsupported operators reject before SQL generation | `Supported` |
| Relation filters | To-one `is`/`isNot`; to-many `some`/`every`/`none` | Same documented relation filter surface, including nested relation filters where covered | `Supported` |
| Projection | `select`, `include`, nested selection, relation `_count` | Supports `select`, `include`, nested selection, and relation `_count`; top-level `select` + `include` rejects | `Supported` |
| Sorting | Scalar-field `orderBy`, to-one relation order by scalar fields, to-many relation `_count` order, aggregate/group ordering, provider-specific relevance ordering | Supports scalar-field order, to-one relation order by scalar fields, to-many relation `_count`, and documented aggregate/group ordering; unsupported to-many scalar-field order and `_relevance` reject | `Subset` |
| Pagination | `cursor`, `skip`, `take`, negative `take` on list reads | Supports cursor pagination, `skip`, `take`, negative `take`; cursor uses `whereUnique` | `Supported` |
| `distinct` | `findMany({ distinct })` with Prisma's in-memory distinct semantics | Supports scalar-field `distinct`; relation fields reject; SQL strategy is adapter-owned | `Subset` |
| `count` | Count records and selected non-null fields; supports filters and pagination-style args | Supports `where`, selected count fields, and `orderBy`/`cursor`/`take`/`skip` input-window pagination | `Supported` |
| `aggregate` | `_count`, `_avg`, `_sum`, `_min`, `_max` with `where`, order, pagination | Same documented aggregate selectors and input-window pagination; invalid/empty aggregate selection rejects | `Supported` |
| `groupBy` | `by`, aggregates, `having`, `orderBy`, `skip`, `take`; no `select` | Supports scalar `by`, aggregate selections, `having`, order, `skip`, `take`; invalid group/having shapes reject | `Supported` |
| Nested writes | Broad nested create/connect/update/delete/upsert matrix | Supports `create`, `createMany`, `connect`, `connectOrCreate`, nullable/correlated `disconnect`, `delete`, `set`, `update`, to-many `updateMany`, `upsert`, and to-many `deleteMany`; callback-transaction and atomic-batch paths propagate generated and updated primary keys where the shape is safe; create-branch update/delete-like shapes are excluded | `Subset` |
| Transactions | Callback and array `$transaction` | Callback transactions on transactional drivers; batch mode on transactional or atomic-batch drivers | `Supported` |
| Query-level `omit` | Prisma supports per-query `omit` | VibORM has model-level omit only; query-level Prisma `omit` is not part of this roadmap | `Unsupported` |
| Raw SQL | Prisma tagged `$queryRaw`/`$executeRaw` plus unsafe variants | Tagged `$queryRaw` (returns `T[]`) / `$executeRaw` (returns the affected count) plus `$queryRawUnsafe`/`$executeRawUnsafe`; also on the interactive transaction client. `sql`/`join`/`empty`/`raw` are exported from the package root | `Supported` |
| Existence check | Emulated with `count`/`findFirst` in Prisma | `exist({ where })` is a VibORM extension returning `boolean`; no `exists` alias | `Different` |

```typescript
import { s } from "viborm";
import { createClient } from "viborm/drivers/pglite";

// Schema carries type information
const user = s.model({
  id: s.string().id().ulid(),
  email: s.string().unique(),
  posts: s.oneToMany(() => post),
});

const post = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  authorId: s.string(),
  author: s.manyToOne(() => user).fields("authorId").references("id"),
});

// Fully typed queries - no codegen!
const orm = createClient({ schema: { user, post } });

const users = await orm.user.findMany({
  where: { email: { contains: "@company.com" } },  // ← TypeScript knows email is string
  include: { posts: true }                          // ← Result includes typed posts[]
});
```

---

## Quick Start (PGlite)

PGlite runs PostgreSQL in-process via WebAssembly—no Docker or external database needed. Perfect for development and testing.

### 1. Install

```bash
pnpm add viborm @electric-sql/pglite
```

### 2. Define Schema

```typescript
// schema.ts
import { s } from "viborm";

export const user = s.model({
  id: s.string().id().ulid(),
  name: s.string(),
  email: s.string().unique(),
  createdAt: s.dateTime().now(),
  posts: s.oneToMany(() => post),
});

export const post = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  content: s.string().nullable(),
  authorId: s.string(),
  author: s.manyToOne(() => user).fields("authorId").references("id"),
});

export const schema = { user, post };
```

### 3. Create Client & Push Schema

```typescript
// db.ts
import { createClient } from "viborm/drivers/pglite";
import { push } from "viborm/migrations";
import { schema } from "./schema";

export const orm = createClient({
  schema,
  dataDir: ".pglite", // Persists to filesystem (omit for in-memory)
});

// Push schema to database (creates tables)
await push(orm, schema);
```

### 4. Query

```typescript
// Create
const newUser = await orm.user.create({
  data: { name: "Alice", email: "alice@example.com" }
});

// Read with relations
const usersWithPosts = await orm.user.findMany({
  include: { posts: true }
});

// Filter
const alice = await orm.user.findFirst({
  where: { email: { contains: "alice" } }
});

// Update
await orm.user.update({
  where: { id: newUser.id },
  data: { name: "Alice Smith" }
});

// Delete
await orm.user.delete({
  where: { id: newUser.id }
});
```

---

## Transactions

VibORM supports callback transactions on drivers with real transaction support, and batch mode on drivers with transactions or native atomic batch support.

### Callback Mode (Dynamic)

```typescript
const result = await orm.$transaction(async (tx) => {
  const user = await tx.user.create({
    data: { name: "Alice", email: "alice@example.com" }
  });

  await tx.post.create({
    data: { title: "First Post", authorId: user.id }
  });

  return user;
});
// If any operation fails, all changes are rolled back
```

### Batch Mode (Array)

```typescript
const [user, post] = await orm.$transaction([
  orm.user.create({ data: { name: "Bob", email: "bob@example.com" } }),
  orm.post.create({ data: { title: "Hello", authorId: "user-id" } })
]);
// Executes atomically when the driver supports transactions or native batch
```

---

## Caching

VibORM includes built-in query caching with TTL and stale-while-revalidate (SWR) support.

### Setup

```typescript
import { createClient } from "viborm/drivers/pglite";
import { MemoryCache } from "viborm/cache";

const orm = createClient({
  schema,
  cache: new MemoryCache(),
});
```

### Basic Caching

```typescript
// Cache for 5 minutes (default)
const users = await orm.$withCache().user.findMany();

// Custom TTL
const posts = await orm.$withCache({ ttl: "1 hour" }).post.findMany();

// TTL in milliseconds
const recent = await orm.$withCache({ ttl: 30000 }).user.findMany();
```

### Stale-While-Revalidate (SWR)

SWR returns stale data immediately while revalidating in the background:

```typescript
// Enable SWR with default 2x TTL stale window
const users = await orm.$withCache({ ttl: "5 minutes", swr: true }).user.findMany();

// Custom SWR window
const posts = await orm.$withCache({ ttl: "5 minutes", swr: "1 hour" }).post.findMany();
```

### Cache Invalidation

```typescript
// Auto-invalidate model cache after mutations
await orm.user.create({
  data: { name: "Alice", email: "alice@example.com" },
  cache: { autoInvalidate: true }  // Invalidates all user:* cache keys
});

// Manual prefix invalidation with wildcard patterns
await orm.$invalidate("user:*", "post:findMany:*");
```

### Cache Drivers

| Driver | Use Case |
|--------|----------|
| `MemoryCache` | Development, single-instance deployments |
| `CloudflareKVCache` | Cloudflare Workers with KV |

---

## Instrumentation

VibORM supports OpenTelemetry tracing and structured logging.

### Setup

```typescript
import { createClient } from "viborm/drivers/pglite";

const orm = createClient({
  schema,
  instrumentation: {
    tracing: {
      enabled: true,
      // Optional: customize tracer
    },
    logging: {
      query: true,    // Log SQL queries
      cache: true,    // Log cache hits/misses
      warning: true,  // Log warnings
      error: true,    // Log errors
    }
  }
});
```

### Serverless Support

For serverless environments, provide a `waitUntil` function to ensure background operations complete:

```typescript
// Cloudflare Workers
export default {
  async fetch(request, env, ctx) {
    const orm = createClient({
      schema,
      waitUntil: ctx.waitUntil.bind(ctx),
    });
    // ...
  }
};
```

---

## Scalar Types

| Type | Description | Example |
|------|-------------|---------|
| `string()` | Text scalars | `s.string().unique()` |
| `int()` | 32-bit integers | `s.int().default(0)` |
| `float()` | Floating-point | `s.float()` |
| `decimal()` | High-precision decimals | `s.decimal()` |
| `bigInt()` | 64-bit integers | `s.bigInt()` |
| `boolean()` | Boolean values | `s.boolean().default(false)` |
| `dateTime()` | Date and time | `s.dateTime().now()` |
| `date()` | Date only | `s.date()` |
| `time()` | Time only | `s.time()` |
| `json()` | JSON with schema validation | `s.json(zodSchema)` |
| `enum()` | Enumerated values | `s.enum(["ADMIN", "USER"])` |
| `blob()` | Binary data (Uint8Array) | `s.blob()` |
| `vector()` | Vector embeddings (pgvector) | `s.vector(1536)` |
| `point()` | PostGIS point type | `import { point } from "viborm"` (not exposed on `s`) |

### Auto-generation

```typescript
s.string().id().uuid()      // UUID v4
s.string().id().ulid()      // ULID
s.string().id().nanoid()    // NanoID
s.string().id().cuid()      // CUID
s.int().id().increment()    // Auto-increment
s.dateTime().now()          // Current timestamp on create
s.dateTime().updatedAt()    // Update timestamp on every update
```

---

## Supported Drivers

### PostgreSQL

| Driver | Package | Use Case |
|--------|---------|----------|
| `pglite` | `@electric-sql/pglite` | Development, testing (WASM) |
| `pg` | `pg` | Node.js with node-postgres |
| `postgres` | `postgres` | Node.js with postgres.js |
| `neon-http` | `@neondatabase/serverless` | Neon serverless (HTTP) |

### MySQL

| Driver | Package | Use Case |
|--------|---------|----------|
| `mysql2` | `mysql2` | Node.js with mysql2 |
| `planetscale` | `@planetscale/database` | PlanetScale serverless |

### SQLite

| Driver | Package | Use Case |
|--------|---------|----------|
| `sqlite3` | `better-sqlite3` | Node.js (synchronous) |
| `libsql` | `@libsql/client` | Turso / LibSQL |
| `d1` | Cloudflare binding | Cloudflare D1 (Workers) |
| `bun-sqlite` | Built-in | Bun runtime |

---

## Repository Structure

VibORM uses a **12-layer architecture**. Each layer has an `AGENTS.md` with detailed documentation.

```
src/
├── validation/        L1  Standard Schema V1 primitives (v.*)
│                          Branded types, set-theory optimization
│
├── schema/            L2-L5  Schema definition
│   ├── scalars/             Scalar types with State generic pattern
│   ├── model/               Model composition, query schemas
│   ├── relation/            Relation types (oneToMany, manyToOne, etc.)
│   └── validation/          Definition-time schema validation
│
├── query-engine/      L6  Database-agnostic query building
│                          Decides WHAT to query, delegates HOW to adapters
│
├── adapters/          L7  Database-specific SQL generation
│                          PostgreSQL, MySQL, SQLite dialect implementations
│
├── drivers/           L8  Connection management, query execution
│                          11 drivers: pglite, pg, postgres, neon-http, bun-sql,
│                          mysql2, planetscale, sqlite3, libsql, d1, bun-sqlite
│
├── client/            L9  Type inference, ORM interface
│                          Recursive proxy pattern, result types
│
├── cache/             L10 Query caching, invalidation, stale-while-revalidate
│
├── instrumentation/   L11 Tracing, structured logging, diagnostics
│
└── migrations/        L12 Schema diffing, push, migration files, DDL
```

### Key Architecture Rules

1. **Query Engine / Adapter Separation**: Query engine decides WHAT to query, adapter decides HOW to express it in SQL. Never hardcode dialect-specific syntax in query-engine.

2. **Natural Type Inference**: Never use type assertions (`as`). Types flow from schema → validation → client.

3. **Immutable State**: Every scalar modifier returns a NEW instance. `s.string().nullable()` returns a new scalar, doesn't mutate.

4. **Lazy Evaluation**: Schemas are built on first access (`??=` pattern) and cached.

---

## Development

### Prerequisites

```bash
pnpm install
```

### Testing (Vitest)

We use [Vitest](https://vitest.dev/) for testing. Tests run against PGlite by default—no external database needed.

```bash
pnpm test               # Run all tests
pnpm test:watch         # Watch mode
pnpm test:ui            # ⭐ Interactive UI - great for exploring/debugging tests
```

Run a specific test file:

```bash
pnpm vitest run tests/validation/string.test.ts
pnpm vitest run -t "validates strings"  # Run by test name pattern
```

### Build Commands

```bash
pnpm build              # Compile TypeScript
pnpm type-check         # Type check only (faster)
pnpm package:build      # Build distributable with tsdown
```

### Path Aliases

```typescript
import { ... } from "@schema";        // src/schema/
import { ... } from "@client";        // src/client/
import { ... } from "@validation";    // src/validation/
import { ... } from "@query-engine";  // src/query-engine/
import { ... } from "@adapters";      // src/adapters/
import { ... } from "@drivers";       // src/drivers/
import { ... } from "@sql";           // src/sql/
```

---

## Agent-First Codebase

This codebase is designed for **AI agents to help developers**. Each major directory contains an `AGENTS.md` file—comprehensive architectural documentation that AI assistants can read to understand:

- **Why** the layer exists and what problems it solves
- **Entry points** and key files to modify
- **Core rules** that must never be broken
- **Anti-patterns** to avoid
- **Step-by-step guides** for common tasks

**Key documentation:**
- `AGENTS.md` — Full architectural overview (start here)
- `FEATURE_IMPLEMENTATION_TEMPLATE.md` — Step-by-step guide for implementing features and fixing bugs, with layer-by-layer analysis framework and code patterns

When working with an AI assistant, point it to these files first.

### Navigating the Codebase

| I want to... | Start here |
|--------------|------------|
| Add new scalar type | `src/schema/scalars/AGENTS.md` |
| Add query operator | `src/query-engine/AGENTS.md` + `src/adapters/AGENTS.md` |
| Fix type inference bug | `src/client/AGENTS.md` → check upstream schemas |
| Add migration operation | `src/migrations/AGENTS.md` |
| Add relation feature | `src/schema/relation/AGENTS.md` |
| Understand validation | `src/validation/AGENTS.md` |

---

## Test Structure

Tests mirror the `src/` structure:

```
tests/
├── validation/       28 tests for v.* primitives
├── scalars/          Schema generation per scalar type
├── model/            Query schemas (where, create, update, args)
│   ├── filter/       WHERE clause generation
│   ├── create/       CREATE input schemas
│   ├── update/       UPDATE input schemas
│   └── args/         Operation argument schemas
├── query-engine/     SQL generation tests
├── relations/        Relation CRUD operations
├── client/           End-to-end client operations
├── migrations/       Schema diffing and DDL
└── drivers/          Database-specific driver tests
```

Most tests run against PGlite (in-memory PostgreSQL). Driver tests in `tests/drivers/` require external databases.

---

## Common Pitfalls

| Mistake | Why it breaks | Fix |
|---------|---------------|-----|
| Hardcoded SQL in query-engine | Breaks MySQL/SQLite | Use `ctx.adapter.*` methods |
| Type assertions (`as`) | Hides type mismatches | Let types flow naturally |
| Forgot Scalar union update | New scalar type invisible | Update `src/schema/scalars/base.ts` |
| Direct model reference in relation | ReferenceError at runtime | Use thunk `() => model` |
| Eager schema building | Performance (rebuilds every access) | Use `??=` lazy pattern |
| Mutation instead of new instance | Type/runtime desync | Return new instance from modifiers |

---

## Current Status

**Core features working:**
- All CRUD operations (create, read, update, delete, upsert)
- Relations (oneToOne, oneToMany, manyToOne, manyToMany)
- Supported nested writes (`create`, `createMany`, `connect`, `connectOrCreate`, `disconnect`, `delete`, `set`, `update`, `updateMany`, `upsert`, `deleteMany`) across callback-transaction and atomic-batch paths
- Select/include with typed results
- All scalar types (string, int, float, boolean, dateTime, json, enum, etc.)
- PostgreSQL, MySQL, and SQLite adapters, including `push` migrations for all three
- Query caching with TTL and SWR
- Transactions (callback and batch modes)
- OpenTelemetry instrumentation

**Known limitations:**
- Full Prisma parity is not complete; VibORM is Prisma-inspired.
- Parent `create` and the create branch of parent `upsert` intentionally exclude update/delete-like nested operations.
- Impossible or unsafe primary-key dataflow shapes reject before mutation instead of partially applying nested writes.
- Raw queries are Prisma-shaped tagged templates; the pre-1.0 `$queryRaw(string, params?)` form still runs for one release behind a deprecation notice, and `$transaction([...])` takes model operations only (raw SQL goes in the interactive form).
- Local nested-write conformance is proven on PGlite/Postgres-style and SQLite-family paths; hosted D1 binding and Neon HTTP need external runs before claiming hosted verification.

**Future features** (documented in `features-docs/`):
- Polymorphic relations
- Recursive queries (WITH RECURSIVE)

See `PENDING_WORK.md` for detailed tracking.

---

## Internal API Convention

All internal state is accessed via `["~"]`:

```typescript
scalar["~"].state          // ScalarState - configuration object
scalar["~"].state.base     // Base scalar schema
schemaRegistry.proxy.user.core.where // Operation schema for this model
relation["~"].targetModel // Thunk to target model
```

This keeps the public API clean and signals "internal" to developers.

---

## License

MIT
