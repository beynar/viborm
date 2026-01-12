# VibORM

Type-safe TypeScript ORM with **zero code generation**. Types are inferred from schema definitions at compile time—no `prisma generate` needed.

## Key Features

| Feature | Description |
|---------|-------------|
| **Zero Codegen** | Types flow from schema → query → result via TypeScript inference |
| **Standard Schema V1** | Interoperable with Zod, Valibot, ArkType for validation |
| **Prisma-like API** | Familiar `findMany`, `create`, `update` operations with `where`, `include`, `select` |
| **Multi-Database** | PostgreSQL, MySQL, SQLite from one codebase via adapter pattern |
| **Chainable Schema** | `s.string().nullable().unique()` with immutable state tracking |

```typescript
import { s } from "viborm";
import { createClient } from "viborm/drivers/pglite";

// Schema carries type information
const user = s.model("user", {
  id: s.string().id().ulid(),
  email: s.string().unique(),
  posts: s.oneToMany(() => post),
});

const post = s.model("post", {
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

export const user = s.model("user", {
  id: s.string().id().ulid(),
  name: s.string(),
  email: s.string().unique(),
  createdAt: s.dateTime().now(),
  posts: s.oneToMany(() => post),
});

export const post = s.model("post", {
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

## Repository Structure

VibORM uses a **10-layer architecture**. Each layer has an `AGENTS.md` with detailed documentation.

```
src/
├── validation/        L1  Standard Schema V1 primitives (v.*)
│                          Branded types, set-theory optimization
│
├── schema/            L2-L5  Schema definition
│   ├── fields/              Field types with State generic pattern
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
│   ├── pglite/            PGlite (PostgreSQL in WASM)
│   ├── pg/                node-postgres
│   ├── postgres/          postgres.js
│   └── sqlite3/           better-sqlite3
│
├── client/            L9  Type inference, ORM interface
│                          Recursive proxy pattern, result types
│
└── migrations/        L10 Schema diffing, push
```

### Key Architecture Rules

1. **Query Engine / Adapter Separation**: Query engine decides WHAT to query, adapter decides HOW to express it in SQL. Never hardcode dialect-specific syntax in query-engine.

2. **Natural Type Inference**: Never use type assertions (`as`). Types flow from schema → validation → client.

3. **Immutable State**: Every field modifier returns a NEW instance. `s.string().nullable()` returns a new field, doesn't mutate.

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
| Add new field type | `src/schema/fields/AGENTS.md` |
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
├── fields/           Schema generation per field type
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
| Forgot Field union update | New field type invisible | Update `src/schema/fields/base.ts` |
| Direct model reference in relation | ReferenceError at runtime | Use thunk `() => model` |
| Eager schema building | Performance (rebuilds every access) | Use `??=` lazy pattern |
| Mutation instead of new instance | Type/runtime desync | Return new instance from modifiers |

---

## Current Status

**Core features working:**
- All CRUD operations (create, read, update, delete, upsert)
- Relations (oneToOne, oneToMany, manyToOne, manyToMany)
- Nested writes (connect, disconnect, create, update, delete)
- Select/include with typed results
- All field types (string, int, float, boolean, dateTime, json, enum, etc.)
- PostgreSQL and SQLite adapters

**Known limitations:**
- MySQL migrations not yet implemented
- Query caching not implemented
- GroupBy HAVING needs schema support
- Aggregate field typing is loose (`string[]` instead of actual field names)

**Future features** (documented in `features-docs/`):
- Polymorphic relations
- Recursive queries (WITH RECURSIVE)

See `PENDING_WORK.md` for detailed tracking.

---

## Internal API Convention

All internal state is accessed via `["~"]`:

```typescript
field["~"].state          // FieldState - configuration object
field["~"].schemas        // {base, filter, create, update} - lazy built
model["~"].schemas.where  // Where schema for this model
relation["~"].targetModel // Thunk to target model
```

This keeps the public API clean and signals "internal" to developers.

---

## License

MIT
