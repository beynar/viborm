# Query Engine - Database-Agnostic Query Building

**Location:** `src/query-engine/`  
**Layer:** L6 - Query Logic (see [root AGENTS.md](../../AGENTS.md))

## Purpose

Transforms validated query objects into SQL via adapter delegation. Handles query structure (WHAT to query) without touching database syntax (HOW to express it).

## Why This Layer Exists

Early VibORM had SQL generation scattered throughout. Adding MySQL required changing 50+ files, hunting for PostgreSQL-specific syntax. The query-engine/adapter split fixed this:

- **Query engine** owns structure: which tables to join, what conditions to apply, how to nest includes
- **Adapters** own syntax: how to quote identifiers, which JSON functions to use, dialect quirks

This separation means adding a new database = implementing one adapter interface, not auditing the entire codebase.

---

## Entry Points

| File | Purpose | Lines |
|------|---------|-------|
| `query-engine.ts` | Main orchestrator, execute() | ~500 |
| `types.ts` | QueryContext, ModelRegistry, Operation | ~150 |
| `validator.ts` | Input validation against schemas | ~80 |
| `builders/` | SQL fragment builders | See [builders/AGENTS.md](builders/AGENTS.md) |

---

## The Golden Rule ⭐

**Query engine code MUST be database-agnostic. Every SQL operation MUST delegate to `ctx.adapter.*`**

```typescript
// ❌ NEVER: Hardcoded PostgreSQL syntax
sql`"${alias}"."${field}" LIKE ${pattern}`
sql`COALESCE(json_agg(${expr}), '[]'::json)`

// ✅ ALWAYS: Delegate to adapter
const column = ctx.adapter.identifiers.column(alias, field);
ctx.adapter.operators.like(column, pattern);
ctx.adapter.json.agg(expr);
```

**Why this is non-negotiable:** The moment you hardcode syntax, you break another database. PostgreSQL uses `"quotes"`, MySQL uses `` `backticks` ``. PostgreSQL has `json_agg()`, MySQL has `JSON_ARRAYAGG()`, SQLite has `json_group_array()`. There are dozens of these differences.

---

## Core Concepts

### QueryContext

Every builder receives context as first parameter. Context provides:

```typescript
interface QueryContext {
  adapter: DatabaseAdapter;  // SQL generation (CRITICAL!)
  model: Model;              // Current model metadata
  registry: ModelRegistry;   // Access to related models
  nextAlias(): string;       // Generate t0, t1, t2...
}
```

**Why context threading matters:** Child builders (for nested includes, subqueries) need adapter access too. Without context, they can't generate correct SQL.

### Sql Fragments

Builders return `Sql` fragments, not strings. Fragments carry template + values separately:

```typescript
// Fragment preserves parameterization
sql`WHERE ${column} = ${value}`
// → { text: "WHERE $1 = $2", values: [column, value] }
```

**Why not strings:** String concatenation invites SQL injection. Fragments ensure proper parameterization at every level of composition.

---

## Core Rules

### Rule 1: Context Threading
Every builder receives QueryContext as first parameter. Pass it through to all nested calls.

### Rule 2: Adapter Delegation
For ANY operation that might differ between databases, call `ctx.adapter.*`. When in doubt, delegate.

### Rule 3: No Dialect Conditionals
Never write `if (adapter.type === 'postgres')`. If you need database-specific behavior, add an adapter method.

### Rule 4: Pure Builders
Builders are pure functions: same inputs → same output. No side effects, no state mutation.

---

## Anti-Patterns

### Hardcoded Identifier Quotes
Using `"column"` directly. PostgreSQL/SQLite use double quotes, MySQL uses backticks. Always use `ctx.adapter.identifiers.column()`.

### Hardcoded JSON Functions
Writing `json_agg()` directly. Each database has completely different JSON aggregation syntax. This is the #1 source of multi-database bugs.

### Hardcoded Operators
Writing `LIKE` or `ILIKE` directly. PostgreSQL has ILIKE, others need COLLATE workarounds. Use `ctx.adapter.operators.*`.

### Dialect Branching
Writing `if (adapter.type === 'postgres')`. This logic belongs in adapter methods, not query engine.

### String Concatenation for SQL
Building SQL with template strings instead of Sql fragments. Breaks parameterization and composition.

---

## Common Tasks

### Adding New Query Operator

1. **Add to schema** (`src/schema/model/schemas/core/filter.ts`)
2. **Add adapter interface method** (`src/adapters/database-adapter.ts`)
3. **Implement in ALL adapters** (postgres, mysql, sqlite)
4. **Handle in where-builder** (`builders/where-builder.ts`)
5. **Test with all 3 databases**

### Debugging SQL Output

```typescript
const result = buildWhere(ctx, whereInput, "t0");
console.log("SQL:", result.text);
console.log("Values:", result.values);
```

Compare output across adapters to verify database-agnostic behavior.

---

## Data Flow

```
Client calls orm.user.findMany(args)
        ↓
Query engine validates args against model["~"].schemas.args.findMany
        ↓
Builders construct SQL fragments via ctx.adapter.* methods
        ↓
Fragments composed into final query
        ↓
Driver executes query, returns raw results
        ↓
Result parser transforms to typed objects
```

---

## Subdirectories

- `builders/` - SQL fragment builders (see [builders/AGENTS.md](builders/AGENTS.md))
- `operations/` - High-level operation implementations (findMany, create, etc.)
- `context/` - QueryContext factory and alias generation
- `result/` - Result parsing and hydration

---

## Related Layers

| Layer | Relationship |
|-------|--------------|
| **Adapters** ([adapters/AGENTS.md](../adapters/AGENTS.md)) | Query engine calls adapter methods. **CRITICAL BOUNDARY!** |
| **Schemas** ([schema/model/schemas/](../schema/model/schemas/AGENTS.md)) | Provides validation schemas for inputs |
| **Drivers** | Executes final SQL, returns raw results |
| **Client** ([client/AGENTS.md](../client/AGENTS.md)) | Calls query engine, receives typed results |
