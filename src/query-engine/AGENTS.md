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
| `query-engine.ts` | Public `QueryEngine` orchestration shell (build/prepare/execute) | ~170 |
| `executor.ts` | Validates + builds SQL for an operation | ~600 |
| `result-flow.ts` | Result parsing/hydration flow | ~340 |
| `transaction-flow.ts` | `$transaction` + the nested-write entry (`executeWithNestedWrites` → race retry → `selectMode` → interpreter) | ~200 |
| `operations/nested-writes/` | The one nested-write interpreter + its two execution modes | See below |
| `cache-flow.ts` | Cache read/write orchestration around operations | ~130 |
| `types.ts` | QueryContext, ModelRegistry, Operation | ~390 |
| `validator.ts` | Input validation through `SchemaRegistry` | ~110 |
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
  schemaRegistry: SchemaRegistryLookup; // Operation validation schemas
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

## Nested-Write Interpreter (`operations/nested-writes/`)

A nested write (`create`/`update`/`upsert` carrying relation mutations) is an
ordered plan over uncertain state — DB-assigned ids a later statement needs,
reads that decide branches (upsert exists?, connectOrCreate found?), and
invariants that must hold at commit — committing atomically on one connection.

There is **one interpreter** that owns every semantic decision, parameterized by
a two-implementation `Mode` capability object. This is the whole architecture:

- **`interpreter.ts`** — owns all semantics once: FK direction, step order,
  correlation, branch decisions, guard attachment, error kinds, result shape.
  Emits ordered `Effect`s over `Expr` values into a mode-owned atomic scope.
- **`mode.ts`** — the `Mode` interface plus **`selectMode`**, the single
  capability fork. `selectMode` is the **only** place a driver's
  `supportsTransactions`/`supportsBatch` are read (a transaction driver →
  `LiveMode`; a batch-only driver → `PlannedMode`; neither → a typed rejection).
- **`live-mode.ts` / `planned-mode.ts`** — the two substrates. `LiveMode`
  executes each effect immediately inside one `withTransaction` and reads live
  (sees its own writes). `PlannedMode` lowers each effect into one ordered
  statement list, defers produced values through a scratch table
  (`batchRefs.store`/`read`), and pins plan-time branch decisions with SQL
  assertions. The store lives entirely inside `planned-mode.ts`.

The single axis of variation is one capability bit — **`canObserveOwnWrites`**:
can a read issued mid-operation see this operation's own uncommitted writes?
Everything else the two modes differ on is a consequence of that bit.

**Load-bearing invariants (grep-gated by
`tests/query-engine/nested-write-architecture-gates.test.ts`):**

1. `supportsTransactions`/`supportsBatch` are read only in the mode files (the
   `selectMode` fork). No capability branch anywhere else in `nested-writes/`.
2. The mode files (`mode.ts`, `live-mode.ts`, `planned-mode.ts`) import **no**
   semantic layer — not `semantic-plan.ts`, `fk.ts`, or `relation-data-builder`.
   A mode may only hold substrate mechanics; any relation/step/branch rule
   belongs in the interpreter.
3. No mutation kind has a second implementation — the old dual engines were
   deleted, and nothing re-imports a deleted engine/scaffolding module.

**The test of the whole design:** a feature request touching nested-write
semantics is implementable without editing either mode file. If a change edits
both mode files *and* encodes a rule about relations, the design is violated.

The shared, substrate-agnostic pieces the interpreter reuses stay beside it:
`semantic-plan.ts` (step/guard planning), `fk.ts` (FK condition builders),
`record-access.ts` (select-one / not-found error), `assertions.ts`,
`effect-lowering.ts`, and the value carrier `BatchValueRef` (defined in
`builders/values-builder.ts`, lowered at `buildScalarSqlValue`).

Full design: `docs/architecture/engine-unification/DESIGN.md`.

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

1. **Add to validation schema** (`src/validation/model/core/filter.ts`)
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
Query engine validates args through SchemaRegistry
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
| **Validation** ([validation/AGENTS.md](../validation/AGENTS.md)) | Provides `SchemaRegistry` operation schemas |
| **Drivers** | Executes final SQL, returns raw results |
| **Client** ([client/AGENTS.md](../client/AGENTS.md)) | Calls query engine, receives typed results |
