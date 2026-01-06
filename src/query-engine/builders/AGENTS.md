# Query Engine Builders - SQL Fragment Construction

**Location:** `src/query-engine/builders/`  
**Parent:** Query Engine (see [../AGENTS.md](../AGENTS.md))  
**Layer:** L6 - Query Building (see [root AGENTS.md](../../../AGENTS.md))

## Purpose

Builds database-agnostic SQL fragments by composing adapter methods. Each builder is a pure function that takes QueryContext and returns Sql fragments.

## Why This Layer Exists

Query construction is complex - WHERE clauses, JOINs, nested includes, aggregations. Breaking this into focused builders makes the code:

1. **Testable** - Each builder can be tested in isolation
2. **Composable** - Builders call other builders for nested structures
3. **Maintainable** - Changes to WHERE logic don't affect SELECT logic

All builders follow the same pattern: pure function, context first, returns Sql.

---

## Entry Points

| File | Purpose | Complexity |
|------|---------|------------|
| `where-builder.ts` | WHERE clauses | High (~400 lines) |
| `include-builder.ts` | Relation inclusion | High (~200 lines) |
| `select-builder.ts` | SELECT columns | Low |
| `orderby-builder.ts` | ORDER BY | Low |
| `relation-filter-builder.ts` | some/every/none | Medium |
| `set-builder.ts` | UPDATE SET | Medium |
| `values-builder.ts` | INSERT VALUES | Medium |

---

## The Builder Pattern

Every builder follows this pattern:

```typescript
function buildSomething(
  ctx: QueryContext,  // Always first - provides adapter access
  input: SomeInput,   // Validated input
  alias: string       // Current table alias (t0, t1, etc.)
): Sql {              // Always returns Sql fragment
  // 1. Use adapter for all SQL generation
  const column = ctx.adapter.identifiers.column(alias, "fieldName");
  const condition = ctx.adapter.operators.eq(column, value);
  
  // 2. Compose and return
  return condition;
}
```

**Properties:**
- Pure function (no side effects)
- Context provides adapter (CRITICAL!)
- Returns composable Sql fragment
- Database-agnostic (all SQL via adapter)

---

## Critical Builders

### where-builder.ts (Most Complex)

Handles scalar filters, boolean operators (AND/OR/NOT), and relation filters:

```typescript
// Input
{ name: { contains: "Alice" }, posts: { some: { published: true } } }

// Output (via adapter methods)
WHERE "t0"."name" LIKE '%Alice%'
  AND EXISTS (SELECT 1 FROM "posts" WHERE ...)
```

**Key insight:** Relation filters become EXISTS subqueries. The builder creates child contexts for subqueries.

### include-builder.ts (Most Critical for Multi-DB)

Handles nested relation inclusion via JSON aggregation:

```typescript
// Input
{ include: { posts: { where: { published: true } } } }

// Output varies by database!
// PostgreSQL: COALESCE(json_agg(...), '[]'::json)
// MySQL: COALESCE(JSON_ARRAYAGG(...), JSON_ARRAY())
// SQLite: COALESCE(json_group_array(...), json_array())
```

**Key insight:** This is where database differences matter most. Every JSON operation MUST go through `ctx.adapter.json.*` methods.

---

## Core Rules

### Rule 1: Pure Functions
Builders have no side effects. Same inputs always produce same output. No state mutation.

### Rule 2: Context First
Every builder takes QueryContext as first parameter. This provides adapter access for all nested calls.

### Rule 3: ALL SQL via Adapter
Never write SQL syntax directly. Even quotes, operators, and function names differ between databases.

### Rule 4: Composable Output
Builders return Sql fragments that can be composed into larger fragments via the `sql` template tag.

---

## Anti-Patterns

### Stateful Builder Classes
Using classes with mutable state like `this.conditions.push()`. Builders must be pure functions.

### Hardcoded Quotes
Writing `"${alias}"."${field}"` directly. PostgreSQL/SQLite use `"`, MySQL uses `` ` ``.

### Hardcoded JSON Aggregation
Writing `json_agg()` or `JSON_ARRAYAGG()`. This is the #1 source of cross-database bugs.

### Missing Context Threading
Not passing QueryContext to nested builder calls. Child builders need adapter access too.

### String SQL Templates
Using template literals for SQL without adapter methods. Breaks parameterization and dialect abstraction.

---

## Key Adapter Methods

| Builder | Critical Adapter Methods |
|---------|-------------------------|
| where-builder | `operators.eq/neq/like/in`, `identifiers.column` |
| include-builder | `json.agg`, `json.object` **(CRITICAL!)** |
| select-builder | `identifiers.column`, `identifiers.aliased` |
| orderby-builder | `orderBy.asc/desc`, `orderBy.nullsFirst/Last` |
| relation-filter-builder | `subqueries.exists`, `operators.and/or` |

---

## Debugging Builders

```typescript
// Log generated SQL
const where = buildWhere(ctx, input, "t0");
console.log("SQL:", where.text);
console.log("Values:", where.values);

// Compare across databases
const pgWhere = buildWhere(pgCtx, input, "t0");
const mysqlWhere = buildWhere(mysqlCtx, input, "t0");
console.log("PG:", pgWhere.text);
console.log("MySQL:", mysqlWhere.text);
```

If outputs differ in structure (not just syntax), there's a bug in the builder using hardcoded SQL.

---

## Invisible Knowledge

### Why pure functions matter
Prisma uses a stateful query builder that accumulates clauses. This works but makes testing harder and can have subtle bugs with reused builders. Pure functions eliminate this class of bugs.

### Why context threading
Nested includes create subqueries that need their own aliases (t1, t2...) and still need adapter access. Context carries both through the call tree.

### Why Sql fragments not strings
Sql fragments separate template from values: `{ text: "WHERE $1 = $2", values: [a, b] }`. This prevents SQL injection and enables proper parameterization at any nesting level.

---

## Related Layers

| Layer | Relationship |
|-------|--------------|
| **Operations** ([../AGENTS.md](../AGENTS.md)) | Compose builders into complete queries |
| **Adapters** ([adapters/AGENTS.md](../../adapters/AGENTS.md)) | Provide SQL generation methods **(CRITICAL!)** |
| **Context** | Provides QueryContext to builders |
