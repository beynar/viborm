# Recursive Query Implementation

## 1. Overview

This feature enables recursive queries on self-referencing models using SQL's `WITH RECURSIVE` CTE (Common Table Expression). It allows users to traverse hierarchical data (e.g., organizational charts, threaded comments, category trees).

**Feature Category:** Query API extension

---

## 2. User-Facing API

```typescript
// Example: Get a user with full subordinate hierarchy (no depth limit)
const user = await orm.user.findUnique({
  where: { id: "manager-1" },
  include: {
    subordinates: {
      recurse: true,  // Recurse until no more records
      select: { id: true, name: true }
    }
  }
});

// Example: Get hierarchy with depth limit
const user = await orm.user.findUnique({
  where: { id: "manager-1" },
  include: {
    subordinates: {
      recurse: { depth: 5 },  // Max 5 levels deep
      where: { active: true },
      orderBy: { name: "asc" }
    }
  }
});

// Result type includes nested hierarchy
// { id: string, name: string, subordinates: [...recursive subordinates...] }
```

### Self-Referencing Model Definition

```typescript
// User model with self-referencing relation
const user = s.model({
  id: s.string().id().ulid(),
  name: s.string(),
  managerId: s.string().optional(),
  
  // Self-referencing relations
  manager: s.oneToOne(() => user, {
    fields: ["managerId"],
    references: ["id"],
    optional: true,
  }),
  subordinates: s.oneToMany(() => user),
});
```

---

## 3. Layer Impact Analysis

Before diving into implementation phases, here's how recursive queries affect each of VibORM's 12 layers:

| Layer | Location | Affected? | Impact |
|-------|----------|-----------|--------|
| **L1: Validation** | `src/validation/` | ❌ No | Existing primitives (object, union, literal, integer) are sufficient |
| **L2: Fields** | `src/schema/fields/` | ❌ No | Recurse is a query option, not a field type |
| **L3: Query Schemas** | `src/schema/relation/schemas/` | ✅ Yes | Conditionally add `recurse` option to `toManyIncludeFactory` |
| **L4: Relations** | `src/schema/relation/` | ✅ Yes | Add `isSelfReferencing()` helper |
| **L5: Schema Validation** | `src/schema/validation/` | ❌ No | TypeScript prevents invalid usage at compile time |
| **L6: Query Engine** | `src/query-engine/` | ✅ Yes | Build recursive CTE SQL, parse flat results into trees |
| **L7: Adapters** | `src/adapters/` | ❌ No | `cte.recursive()` already implemented for all adapters |
| **L8: Drivers** | `src/drivers/` | ❌ No | No connection-level changes needed |
| **L9: Client** | `src/client/` | ✅ Yes | Add `InferRecursiveResult` type helper |
| **L10: Cache** | `src/cache/` | ✅ Yes | Handle cache key generation for recursive includes |
| **L11: Instrumentation** | `src/instrumentation/` | ✅ Yes | Add span attributes for recursive operations |
| **L12: Migrations** | `src/migrations/` | ❌ No | No schema changes - recurse is query-time only |

**Layers NOT affected:**
- **L1: Validation** - Existing `v.integer()`, `v.literal()`, `v.union()`, `v.object()` are sufficient.
- **L2: Fields** - Recurse is a query-time concept, not a schema/field definition.
- **L5: Schema Validation** - The `recurse` option is conditionally included only for self-referencing relations. TypeScript prevents invalid usage at compile time.
- **L7: Adapters** - The `cte.recursive()` method already exists on all database adapters.
- **L8: Drivers** - Drivers execute raw SQL; no changes needed.
- **L12: Migrations** - Recursive queries don't change the database schema.

---

## 4. Implementation Phases

### Phase 1: Relation Layer (L4)

**Goal:** Detect self-referencing relations.

**File:** `src/schema/relation/relation.ts` (MODIFY)

```typescript
import type { RelationState } from "./types";
import type { Model } from "../model";

/**
 * Check if a relation is self-referencing (points back to its own model).
 * 
 * @param state - The relation state
 * @param currentModel - The model containing this relation
 * @returns true if the relation's target is the same as the current model
 */
export function isSelfReferencing<S extends RelationState>(
  state: S,
  currentModel: Model<any>
): boolean {
  const targetModel = state.getter();
  // Compare by identity - both should reference the same model object
  return targetModel === currentModel;
}
```

**Usage in schema factory:**

```typescript
// In toManyIncludeFactory, we need access to the parent model
// This requires threading the model through the schema generation
```

| File | Action | Purpose |
|------|--------|---------|
| `src/schema/relation/relation.ts` | MODIFY | Add `isSelfReferencing()` helper |
| `src/schema/relation/index.ts` | MODIFY | Export `isSelfReferencing` |

---

### Phase 2: Query Schema Layer (L3)

**Goal:** Conditionally add `recurse` option only for self-referencing relations.

**File:** `src/schema/relation/schemas/select-include.ts` (MODIFY)

```typescript
import { isSelfReferencing } from "../relation";

// The recurse schema definition
const recurseSchema = v.union([
  v.literal(true),  // recurse: true (no depth limit)
  v.object({
    depth: v.integer(),  // depth: N (max N levels deep)
  }),
]);

/**
 * To-many include: true or nested { where, orderBy, take, skip, cursor, select, include, recurse? }
 * 
 * The `recurse` option is only available when the relation is self-referencing.
 */
type ToManyInclude<S extends RelationState, IsSelfRef extends boolean> = V.Union<
  readonly [
    BooleanToSelect,
    IncludeToField<
      V.Object<{
        where: () => InferTargetSchema<S, "where">;
        orderBy: () => InferTargetSchema<S, "orderBy">;
        take: V.Number;
        skip: V.Number;
        cursor: V.String;
        select: () => InferTargetSchema<S, "select">;
        include: () => InferTargetSchema<S, "include">;
      } & (IsSelfRef extends true ? { recurse: typeof recurseSchema } : {})>
    >,
  ]
>;

export const toManyIncludeFactory = <S extends RelationState>(
  state: S,
  parentModel?: Model<any>  // Optional: needed to detect self-referencing
): ToManyInclude<S, boolean> => {
  const isSelfRef = parentModel ? isSelfReferencing(state, parentModel) : false;
  
  const baseEntries = {
    where: getTargetWhereSchema(state),
    orderBy: getTargetOrderBySchema(state),
    take: v.number(),
    skip: v.number(),
    cursor: v.string(),
    select: getTargetSelectSchema(state),
    include: getTargetIncludeSchema(state),
  };
  
  // Only include recurse option if relation is self-referencing
  const entries = isSelfRef 
    ? { ...baseEntries, recurse: recurseSchema }
    : baseEntries;
  
  return v.union([
    booleanToSelect(state),
    v.coerce(
      v.object(entries),
      includeToField(state)
    ),
  ]);
};
```

**Key point:** The `recurse` option is NOT available at the type level for non-self-referencing relations. TypeScript will error if you try to use it on `posts` (User -> Post), but allow it on `subordinates` (User -> User).

| File | Action | Purpose |
|------|--------|---------|
| `src/schema/relation/schemas/select-include.ts` | MODIFY | Conditionally add `recurse` option |
| `src/schema/relation/schemas/index.ts` | MODIFY | Update exports if needed |

---

### Phase 3: Query Engine Layer (L6)

**Goal:** Build recursive CTE SQL and parse flat results into nested trees.

#### 3.1 Recurse Builder

**File:** `src/query-engine/builders/recurse-builder.ts` (CREATE)

```typescript
import type { Sql } from "@sql";
import type { QueryContext, RelationInfo } from "../types";

/**
 * Recurse options parsed from user input
 */
export interface RecurseOptions {
  enabled: boolean;
  depth?: number;  // undefined means no limit (but hard max of 1000)
}

/**
 * Parse recurse option from include value
 */
export function parseRecurseOption(
  recurse: true | { depth: number } | undefined
): RecurseOptions {
  if (!recurse) {
    return { enabled: false };
  }
  
  if (recurse === true) {
    return { enabled: true };  // No depth limit
  }
  
  return {
    enabled: true,
    depth: Math.min(recurse.depth, 1000),  // Hard cap at 1000
  };
}

/**
 * Build recursive CTE for self-referencing relation include.
 * 
 * Returns flat rows with __depth and __parent_id columns.
 * Tree building happens in result parser for database portability.
 */
export function buildRecursiveInclude(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  includeValue: {
    recurse: true | { depth: number };
    where?: Record<string, unknown>;
    select?: Record<string, true>;
    orderBy?: Record<string, "asc" | "desc">;
  },
  parentAlias: string
): Sql {
  const { adapter } = ctx;
  const { recurse, where, select } = includeValue;
  const recurseOpts = parseRecurseOption(recurse);
  
  const cteName = ctx.nextAlias() + "_tree";
  const targetTable = relationInfo.targetModel["~"].state.tableName;
  const fkField = relationInfo.fields?.[0];  // e.g., "managerId"
  const pkField = relationInfo.references?.[0];  // e.g., "id"
  
  if (!fkField || !pkField) {
    throw new Error("Self-referencing relation must have fields and references");
  }
  
  // Build column list from select or all scalars
  const columns = select 
    ? Object.keys(select)
    : Object.keys(relationInfo.targetModel["~"].state.scalars);
  
  const columnsSql = columns.map(c => adapter.identifiers.escape(c));
  const columnsWithMeta = [
    ...columnsSql,
    adapter.raw("0 AS __depth"),
    adapter.identifiers.column(parentAlias, pkField),
    adapter.raw(" AS __root_id"),
  ];
  
  // Anchor query: direct children of parent
  const anchorSelect = adapter.assemble.select({
    columns: sql.join(columnsWithMeta, sql`, `),
    from: adapter.identifiers.table(targetTable, "t"),
    where: adapter.operators.eq(
      adapter.identifiers.column("t", fkField),
      adapter.identifiers.column(parentAlias, pkField)
    ),
  });
  
  // Recursive query: join CTE to table on self-reference
  const depthCheck = recurseOpts.depth
    ? adapter.operators.lt(
        adapter.identifiers.column(cteName, "__depth"),
        adapter.literals.value(recurseOpts.depth - 1)
      )
    : adapter.literals.true();  // No depth limit
  
  const recursiveColumns = [
    ...columnsSql.map(c => adapter.identifiers.column("t", c.toString())),
    adapter.expressions.add(
      adapter.identifiers.column(cteName, "__depth"),
      adapter.literals.value(1)
    ),
    adapter.raw(" AS __depth"),
    adapter.identifiers.column(cteName, "__root_id"),
  ];
  
  const recursiveSelect = adapter.assemble.select({
    columns: sql.join(recursiveColumns, sql`, `),
    from: adapter.identifiers.table(targetTable, "t"),
    joins: [
      adapter.joins.inner(
        adapter.identifiers.escape(cteName),
        adapter.operators.eq(
          adapter.identifiers.column("t", fkField),
          adapter.identifiers.column(cteName, pkField)
        )
      ),
    ],
    where: depthCheck,
  });
  
  // Build CTE
  const cte = adapter.cte.recursive(cteName, anchorSelect, recursiveSelect);
  
  // Final select from CTE
  return sql`${cte} SELECT * FROM ${adapter.identifiers.escape(cteName)} ORDER BY __depth, ${adapter.identifiers.escape(pkField)}`;
}
```

#### 3.2 Include Builder Integration

**File:** `src/query-engine/builders/include-builder.ts` (MODIFY)

```typescript
import { buildRecursiveInclude, parseRecurseOption } from "./recurse-builder";

// In the include building logic, detect recurse option and delegate
function buildRelationInclude(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  includeValue: Record<string, unknown>,
  parentAlias: string
): Sql {
  // Check for recurse option
  if ("recurse" in includeValue && includeValue.recurse) {
    return buildRecursiveInclude(
      ctx,
      relationInfo,
      includeValue as any,
      parentAlias
    );
  }
  
  // ... existing include logic ...
}
```

#### 3.3 Result Parser - Tree Building

**File:** `src/query-engine/result/index.ts` (MODIFY)

```typescript
/**
 * Build nested tree structure from flat CTE rows.
 * 
 * Input: Flat array with __depth and __parent_id columns
 * Output: Nested tree structure
 */
export function buildTreeFromFlatRows<T extends Record<string, unknown>>(
  rows: T[],
  pkField: string,
  fkField: string
): T[] {
  if (rows.length === 0) return [];
  
  // Index rows by primary key for O(1) parent lookup
  const rowMap = new Map<unknown, T & { children?: T[] }>();
  const roots: (T & { children?: T[] })[] = [];
  
  // First pass: index all rows
  for (const row of rows) {
    const pk = row[pkField];
    rowMap.set(pk, { ...row } as T & { children?: T[] });
  }
  
  // Second pass: build tree
  for (const row of rows) {
    const node = rowMap.get(row[pkField])!;
    const parentId = row[fkField];
    const depth = (row as any).__depth as number;
    
    // Remove metadata columns from final result
    delete (node as any).__depth;
    delete (node as any).__root_id;
    
    if (depth === 0) {
      // Root level - direct children of the queried record
      roots.push(node);
    } else {
      // Find parent and add as child
      const parent = rowMap.get(parentId);
      if (parent) {
        parent.children ??= [];
        parent.children.push(node);
      }
    }
  }
  
  return roots;
}
```

| File | Action | Purpose |
|------|--------|---------|
| `src/query-engine/builders/recurse-builder.ts` | CREATE | Build WITH RECURSIVE CTE SQL |
| `src/query-engine/builders/include-builder.ts` | MODIFY | Detect `recurse` and delegate |
| `src/query-engine/builders/index.ts` | MODIFY | Export recurse builder |
| `src/query-engine/types.ts` | MODIFY | Add `RecurseOptions` type |
| `src/query-engine/result/index.ts` | MODIFY | Add `buildTreeFromFlatRows()` |

---

### Phase 4: Client Layer (L9)

**Goal:** Type-safe result inference for recursive relations.

**File:** `src/client/result-types.ts` (MODIFY)

```typescript
/**
 * Recurse option type - what the user provides
 */
type RecurseOption = true | { depth: number };

/**
 * Transform a relation type to a recursive tree structure.
 * The relation type is nested within itself.
 */
type RecursiveTree<T> = T extends (infer Item)[]
  ? (Item & { [K in keyof Item as Item[K] extends any[] ? K : never]?: RecursiveTree<Item[K]> })[]
  : never;

/**
 * Infer result type when recurse is specified on a relation.
 */
type InferRecursiveResult<
  S extends ModelState,
  RelationKey extends keyof S["relations"],
  Args extends { recurse: RecurseOption }
> = RecursiveTree<InferRelationResult<S, RelationKey, Omit<Args, "recurse">>>;

/**
 * Check if include args have recurse option
 */
type HasRecurse<Args> = Args extends { recurse: RecurseOption } ? true : false;

/**
 * Infer result type, handling recursive relations
 */
type InferIncludeResultWithRecurse<
  S extends ModelState,
  I extends Record<string, any>
> = {
  [K in keyof I]: K extends keyof S["relations"]
    ? HasRecurse<I[K]> extends true
      ? InferRecursiveResult<S, K, I[K]>
      : InferRelationResult<S, K, I[K]>
    : never;
};
```

| File | Action | Purpose |
|------|--------|---------|
| `src/client/result-types.ts` | MODIFY | Add `InferRecursiveResult`, `RecursiveTree` types |

---

### Phase 5: Cache Layer (L10)

**Goal:** Handle cache key generation for recursive includes.

**File:** `src/cache/key.ts` (MODIFY)

Recursive includes need unique cache keys that account for:
1. The `recurse` option presence
2. The depth limit (if specified)
3. Combined with other include options (where, select, etc.)

```typescript
// Cache key must include recurse options
{
  model: "user",
  operation: "findUnique",
  where: { id: "manager-1" },
  include: {
    subordinates: {
      recurse: true,  // or { depth: 5 }
      select: { id: true, name: true },
    }
  }
}
```

**Cache invalidation:** When a user record is updated, all recursive queries that might include that user need invalidation. This is handled by the existing model-level invalidation - no special logic needed for recursive specifically.

| File | Action | Purpose |
|------|--------|---------|
| `src/cache/key.ts` | MODIFY | Include `recurse` in cache key generation |

---

### Phase 6: Instrumentation Layer (L11)

**Goal:** Add observability for recursive operations.

**File:** `src/instrumentation/spans.ts` (MODIFY)

```typescript
// =============================================================================
// Recursive Query Attributes
// =============================================================================

/** Relation name being recursively queried (e.g., "subordinates") */
export const ATTR_RECURSE_RELATION = "viborm.recurse.relation";

/** Whether depth limit is specified */
export const ATTR_RECURSE_HAS_DEPTH_LIMIT = "viborm.recurse.has_depth_limit";

/** Maximum depth requested (if limited) */
export const ATTR_RECURSE_MAX_DEPTH = "viborm.recurse.max_depth";

/** Actual depth reached in results */
export const ATTR_RECURSE_ACTUAL_DEPTH = "viborm.recurse.actual_depth";

/** Number of records in the tree */
export const ATTR_RECURSE_TREE_SIZE = "viborm.recurse.tree_size";
```

These attributes would be recorded on the `SPAN_BUILD` span:

```typescript
// During query building
span.setAttributes({
  [ATTR_RECURSE_RELATION]: "subordinates",
  [ATTR_RECURSE_HAS_DEPTH_LIMIT]: true,
  [ATTR_RECURSE_MAX_DEPTH]: 5,
});

// During result parsing
span.setAttributes({
  [ATTR_RECURSE_ACTUAL_DEPTH]: 3,
  [ATTR_RECURSE_TREE_SIZE]: 47,
});
```

| File | Action | Purpose |
|------|--------|---------|
| `src/instrumentation/spans.ts` | MODIFY | Add `ATTR_RECURSE_*` constants |

---

## 5. Type System Design

**Key types:**

```typescript
// Recurse options - what the user provides
type RecurseOption = true | { depth: number };

// Internal recurse info for query building
interface RecurseOptions {
  enabled: boolean;
  depth?: number;  // undefined means no limit (but hard max of 1000)
}

// Result type transformation - recursive nesting
type RecursiveTree<T> = T extends (infer Item)[]
  ? (Item & { [K in keyof Item as Item[K] extends any[] ? K : never]?: RecursiveTree<Item[K]> })[]
  : never;
```

**Type flow:**
1. User specifies `recurse: true` or `recurse: { depth: N }` in include
2. Schema validates recurse is only on self-referencing relations (compile-time)
3. Query engine builds CTE with depth tracking
4. Result parser converts flat rows to nested tree
5. Result types infer recursive structure

---

## 6. SQL Generation

**SQL Output Example (PostgreSQL):**

```sql
WITH RECURSIVE subordinates_tree AS (
  -- Anchor: direct subordinates of the queried user
  SELECT u.*, 0 AS __depth, $1 AS __root_id
  FROM "user" u
  WHERE u."managerId" = $1
  
  UNION ALL
  
  -- Recursive: subordinates of subordinates
  SELECT u.*, t.__depth + 1, t.__root_id
  FROM "user" u
  INNER JOIN subordinates_tree t ON u."managerId" = t.id
  WHERE t.__depth < 10  -- depth limit (if specified)
)
SELECT * FROM subordinates_tree ORDER BY __depth, id;
```

**With depth limit of 5:**

```sql
WITH RECURSIVE subordinates_tree AS (
  SELECT u.*, 0 AS __depth, $1 AS __root_id
  FROM "user" u
  WHERE u."managerId" = $1
  
  UNION ALL
  
  SELECT u.*, t.__depth + 1, t.__root_id
  FROM "user" u
  INNER JOIN subordinates_tree t ON u."managerId" = t.id
  WHERE t.__depth < 4  -- (5 - 1) to get 5 levels total
)
SELECT * FROM subordinates_tree ORDER BY __depth, id;
```

**Why tree building happens in JS, not SQL:**

1. **Portability:** Building nested JSON trees in SQL varies significantly between databases (PostgreSQL has `jsonb_agg`, MySQL is more limited, SQLite has `json_group_array`)
2. **Simplicity:** The flat CTE approach is standard SQL that works on all databases
3. **Performance:** Tree building in JS is O(n) and negligible for reasonable tree sizes
4. **Debugging:** Flat results are easier to debug and log

---

## 7. Alternatives Considered

| Alternative | Rejected Because |
|-------------|------------------|
| Top-level `recurse` option on findMany | Less natural - unclear which relation to recurse on |
| Separate `findRecursive` operation | Breaks consistency with existing API |
| Automatic recursion detection | Too magical - user should opt-in explicitly |
| Client-side recursion (multiple queries) | Inefficient - N+1 problem |
| Build tree in SQL with JSON aggregation | Not portable across databases |

---

## 8. Edge Cases & Behavior

1. **Multiple recursive includes:** Supported - each uses a separate CTE
   ```typescript
   include: {
     subordinates: { recurse: true },
     manager: { recurse: { depth: 5 } }  // Go up the chain
   }
   ```

2. **Recurse with nested include:** The `select`/`include` inside the recursed relation applies to each level
   ```typescript
   include: {
     subordinates: {
       recurse: true,
       select: { id: true, name: true },  // Each level gets id, name
       include: { profile: true }          // Each level includes profile
     }
   }
   ```

3. **Non-self-referencing relation:** The `recurse` option is not available in the TypeScript type for non-self-referencing relations. Attempting to use it will result in a compile-time error, not a runtime error.

4. **Circular data protection:** Hard limit of 1000 levels even when no depth specified. This prevents infinite loops from circular references in data.

5. **Depth semantics:**
   - `recurse: true` → recurse until no more matching records (max 1000)
   - `recurse: { depth: N }` → recurse at most N levels deep

6. **Empty results:** If no children exist at any level, returns empty array for that branch.

7. **Where filter on recursion:** The `where` filter applies to ALL levels of recursion:
   ```typescript
   include: {
     subordinates: {
       recurse: true,
       where: { active: true }  // Only include active subordinates at all levels
     }
   }
   ```

---

## 9. Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/schema/relation/relation.ts` | MODIFY | Add `isSelfReferencing()` helper |
| `src/schema/relation/index.ts` | MODIFY | Export `isSelfReferencing` |
| `src/schema/relation/schemas/select-include.ts` | MODIFY | Conditionally add `recurse` option for self-ref relations |
| `src/query-engine/builders/recurse-builder.ts` | CREATE | Build recursive CTE SQL |
| `src/query-engine/builders/include-builder.ts` | MODIFY | Detect recurse and delegate |
| `src/query-engine/builders/index.ts` | MODIFY | Export recurse builder |
| `src/query-engine/types.ts` | MODIFY | Add `RecurseOptions` type |
| `src/query-engine/result/index.ts` | MODIFY | Parse flat CTE rows into nested tree |
| `src/client/result-types.ts` | MODIFY | Add recursive result type inference |
| `src/cache/key.ts` | MODIFY | Include recurse in cache key generation |
| `src/instrumentation/spans.ts` | MODIFY | Add `ATTR_RECURSE_*` constants |
| `tests/recurse/recurse.test.ts` | CREATE | Schema, SQL, and type tests |

---

## 10. Tests Required

- [ ] Type inference tests for recurse args (`expectTypeOf`)
- [ ] Type tests: `recurse` available on self-ref relations only (User.subordinates)
- [ ] Type tests: `recurse` NOT available on non-self-ref relations (User.posts)
- [ ] SQL generation tests for PostgreSQL, MySQL, SQLite
- [ ] Result parsing tests (flat CTE rows → nested tree)
- [ ] Integration tests using User.subordinates fixture
- [ ] Depth limiting tests (with and without depth)
- [ ] Combined with select/include tests
- [ ] Multiple recursive includes in same query
- [ ] Edge case: empty results at various depths
- [ ] Edge case: circular data doesn't cause infinite loop
- [ ] Cache key generation includes recurse options

---

## 11. Implementation Notes

### 11.1 Self-Referencing Detection

The `isSelfReferencing()` helper compares model identity, not names:

```typescript
// This works because both reference the same model object
const user = s.model({
  subordinates: s.oneToMany(() => user),  // Same model reference
});
```

### 11.2 Recursive Relation Goes Both Directions

A self-referencing model typically has two relations:
- **Down the tree:** `subordinates` (oneToMany)
- **Up the tree:** `manager` (oneToOne/manyToOne)

Both can use `recurse`:
```typescript
// Get full org chart below this user
subordinates: { recurse: true }

// Get management chain above this user
manager: { recurse: { depth: 10 } }
```

### 11.3 Performance Considerations

- CTEs are generally well-optimized by databases
- The hard limit of 1000 levels prevents runaway queries
- Consider adding a warning log if depth > 100 is requested
- Tree building in JS is O(n) - not a bottleneck

### 11.4 Adapter CTE Support

All adapters already implement `cte.recursive()`:
- PostgreSQL: `WITH RECURSIVE name AS (anchor UNION ALL recursive)`
- MySQL 8.0+: Same syntax as PostgreSQL
- SQLite: Same syntax as PostgreSQL

No adapter changes needed.

---

## 12. Success Criteria

- [ ] Can use `recurse: true` on self-referencing relations
- [ ] Can use `recurse: { depth: N }` for limited recursion
- [ ] TypeScript error when using `recurse` on non-self-referencing relation
- [ ] SQL generates correct `WITH RECURSIVE` CTE
- [ ] Result parser builds correct nested tree structure
- [ ] Works with PostgreSQL, MySQL, and SQLite
- [ ] Depth limit enforced (max 1000)
- [ ] Can combine recurse with select, where, orderBy
- [ ] Multiple recursive includes in same query work
- [ ] Cache keys correctly differentiate recursive queries
- [ ] Instrumentation spans include recurse attributes
- [ ] All tests pass

---

## 13. Implementation Checklist

```
ANALYSIS
[x] Work type identified: Feature
[x] Feature category identified: Query API extension
[x] Each layer analyzed with affected/not affected and why
[x] Design decisions documented with alternatives

TYPE SYSTEM
[ ] RecurseOptions type defined
[ ] Generic parameters preserve type flow
[ ] No type assertions - natural inference
[ ] InferRecursiveResult produces correct types

IMPLEMENTATION
[ ] Layer 4: isSelfReferencing helper
[ ] Layer 3: conditionally add recurse schema in select-include (self-ref only)
[ ] Layer 6: recurse-builder with CTE logic
[ ] Layer 6: include-builder integration
[ ] Layer 6: result parsing to nested tree
[ ] Layer 9: result type inference
[ ] Layer 10: cache key generation
[ ] Layer 11: instrumentation attributes
[ ] Exports added to index files

TESTING
[ ] Type tests with expectTypeOf
[ ] Schema tests: valid/invalid recurse
[ ] SQL tests for PG, MySQL, SQLite
[ ] Result parsing tests (flat → tree)
[ ] Integration tests with fixtures
[ ] Cache key tests
```
