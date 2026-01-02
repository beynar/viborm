# Recursive Query Implementation

## 1. Overview

This feature enables recursive queries on self-referencing models using SQL's `WITH RECURSIVE` CTE (Common Table Expression). It allows users to traverse hierarchical data (e.g., organizational charts, threaded comments, category trees).

**Feature Category:** Query API extension

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

## 3. Layer Analysis

### Layer 1: User API
**Affected:** No
**Why not:** No new exports needed - recurse is an option within existing find operations.

### Layer 2: Schema Definition
**Affected:** Yes - Minor
**Why:** Need to identify self-referencing relations for validation.
**Changes:**
- Add `isSelfReferencing(state)` helper to detect when a relation points back to its own model

**Files:**
| File | Action | Purpose |
|------|--------|---------|
| `src/schema/relation/relation.ts` | MODIFY | Add `isSelfReferencing()` helper |

### Layer 3: Query Schema
**Affected:** Yes
**Why:** Need to conditionally add `recurse` option only for self-referencing relations.
**Changes:**

```typescript
// The recurse schema definition
const recurseSchema = v.union([
  v.literal(true),  // recurse: true (no depth limit)
  v.object({
    depth: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000)),
  })
]);

// In toManyIncludeFactory - conditionally include recurse
export const toManyIncludeFactory = <S extends RelationState>(state: S) => {
  const isSelfRef = isSelfReferencing(state);
  
  return v.object({
    where: () => getTargetWhereSchema(state)(),
    orderBy: () => getTargetOrderBySchema(state)(),
    take: v.number(),
    skip: v.number(),
    select: () => getTargetSelectSchema(state)(),
    include: () => getTargetIncludeSchema(state)(),
    // Only include recurse option if relation points back to same model
    ...(isSelfRef ? { recurse: recurseSchema } : {}),
  });
};
```

**Key point:** The `recurse` option is NOT available at the type level for non-self-referencing relations. TypeScript will error if you try to use it on `posts` (User -> Post), but allow it on `subordinates` (User -> User).

**Files:**
| File | Action | Purpose |
|------|--------|---------|
| `src/schema/relation/schemas/select-include.ts` | MODIFY | Conditionally add `recurse` option only when relation is self-referencing |

### Layer 4: Validation Library
**Affected:** No
**Why not:** Existing primitives (object, union, literal, number, pipe) are sufficient.

### Layer 5: Schema Validation
**Affected:** No
**Why not:** The `recurse` option is conditionally included in the schema only for self-referencing relations. TypeScript prevents invalid usage at compile time - no runtime validation needed.

### Layer 6: Query Engine
**Affected:** Yes - Major
**Why:** Core of the feature - builds the recursive CTE SQL.
**Changes:**

```typescript
export function buildRecursiveInclude(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  includeValue: Record<string, unknown>,  // { recurse: true|{depth}, where?, select?, ... }
  parentAlias: string
): Sql {
  const { adapter } = ctx;
  const { recurse, where, select, orderBy } = includeValue;
  const depth = typeof recurse === 'object' ? recurse.depth : undefined;
  
  const cteName = ctx.nextAlias() + "_tree";
  
  // Anchor: direct children of parent
  const anchorSelect = buildAnchorSelect(ctx, relationInfo, parentAlias, select);
  
  // Recursive: join CTE to target table on self-reference
  const recursiveSelect = buildRecursiveSelect(ctx, relationInfo, cteName, where, depth);
  
  // Build CTE - returns flat rows with __depth column
  const cte = adapter.cte.recursive(cteName, anchorSelect, recursiveSelect);
  
  // Return query that selects from CTE ordered by depth
  // Tree building happens in result parser, not SQL (for portability)
  return sql`${cte} SELECT * FROM ${sql.identifier(cteName)} ORDER BY __depth`;
}
```

**SQL Output Example:**
```sql
WITH RECURSIVE hierarchy AS (
  -- Anchor: the starting row
  SELECT *, 0 AS __depth FROM "user" WHERE id = $1
  UNION ALL
  -- Recursive: join to self
  SELECT u.*, h.__depth + 1
  FROM "user" u
  INNER JOIN hierarchy h ON u."managerId" = h.id
  WHERE h.__depth < 10  -- depth limit (if specified)
)
SELECT * FROM hierarchy ORDER BY __depth;
```

**Tree building happens in the ORM result parser**, not in SQL. This is because:
1. **Portability:** Building nested JSON trees in SQL varies significantly between databases (PostgreSQL has `jsonb_agg`, MySQL is more limited)
2. **Simplicity:** The flat CTE approach is standard SQL that works on all databases
3. **Performance:** Tree building in JS is O(n) and negligible for reasonable tree sizes

The result parser reconstructs the nested structure using the `__depth` column and parent FK references.

**Files:**
| File | Action | Purpose |
|------|--------|---------|
| `src/query-engine/builders/recurse-builder.ts` | CREATE | Build WITH RECURSIVE CTE SQL |
| `src/query-engine/builders/include-builder.ts` | MODIFY | Detect `recurse` in include options, delegate to recurse-builder |
| `src/query-engine/types.ts` | MODIFY | Add `RecurseOptions` type |
| `src/query-engine/result/index.ts` | MODIFY | Parse flat CTE results into nested tree structure |

### Layer 7: Database Adapters
**Affected:** No
**Why not:** `cte.recursive()` already implemented for all adapters:
- `src/adapters/databases/postgres/postgres-adapter.ts:368-380`
- `src/adapters/databases/mysql/mysql-adapter.ts:462-475`
- `src/adapters/databases/sqlite/sqlite-adapter.ts:465-478`

### Layer 8: Driver Layer
**Affected:** No
**Why not:** No connection-level changes needed.

### Layer 9: Client Layer
**Affected:** Yes
**Why:** Result types need to reflect recursive structure.
**Changes:**

```typescript
// When recurse is specified, the relation becomes a recursive tree structure
type InferRecursiveResult<S extends ModelState, Args> = 
  Args extends { include: infer I }
    ? I extends { [K: string]: { recurse: true | { depth: number } } }
      ? // Transform the relation to a recursive tree type
        TransformToRecursiveTree<S, Args>
      : InferSelectInclude<S, Args>
    : InferSelectInclude<S, Args>;

// Recursive tree type - the relation type nested within itself
type RecursiveTree<T> = T extends (infer Item)[]
  ? (Item & { [K in keyof Item]?: RecursiveTree<Item[K]> })[]
  : T & { [K in keyof T]?: RecursiveTree<T[K]> };
```

**Files:**
| File | Action | Purpose |
|------|--------|---------|
| `src/client/result-types.ts` | MODIFY | Add recursive result type inference |

## 4. Type System Design

**Key types:**

```typescript
// Recurse options - what the user provides
type RecurseOption = true | { depth: number };

// Internal recurse info for query building
interface RecurseOptions {
  enabled: boolean;
  depth?: number;  // undefined means no limit (but hard max of 1000)
}

// Result type transformation
type RecursiveTree<T> = T extends (infer Item)[]
  ? (Item & { [K in keyof Item]?: RecursiveTree<Item[K]> })[]
  : T & { [K in keyof T]?: RecursiveTree<T[K]> };
```

**Type flow:**
1. User specifies `recurse: true` or `recurse: { depth: N }` in include
2. Schema validates recurse is only on self-referencing relations
3. Query engine builds CTE with depth tracking
4. Result parser converts flat rows to nested tree
5. Result types infer recursive structure

## 5. Alternatives Considered

| Alternative | Rejected Because |
|-------------|------------------|
| Top-level `recurse` option | Less natural - unclear which relation to recurse on |
| Separate `findRecursive` operation | Breaks consistency with existing API |
| Automatic recursion detection | Too magical - user should opt-in explicitly |
| Client-side recursion (multiple queries) | Inefficient - N+1 problem |

## 6. Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/schema/relation/relation.ts` | MODIFY | Add `isSelfReferencing()` helper |
| `src/schema/relation/schemas/select-include.ts` | MODIFY | Conditionally add `recurse` option for self-ref relations |
| `src/query-engine/types.ts` | MODIFY | Add `RecurseOptions` type |
| `src/query-engine/builders/recurse-builder.ts` | CREATE | Build recursive CTE SQL |
| `src/query-engine/builders/include-builder.ts` | MODIFY | Detect recurse and delegate |
| `src/query-engine/result/index.ts` | MODIFY | Parse flat CTE rows into nested tree |
| `src/client/result-types.ts` | MODIFY | Add recursive result type inference |
| `tests/recurse/recurse.test.ts` | CREATE | Schema, SQL, and type tests |

## 7. Tests Required

- [ ] Type inference tests for recurse args (`expectTypeOf`)
- [ ] Type tests: `recurse` available on self-ref relations only (User.subordinates)
- [ ] Type tests: `recurse` NOT available on non-self-ref relations (User.posts)
- [ ] SQL generation tests for PostgreSQL, MySQL, SQLite
- [ ] Result parsing tests (flat CTE rows -> nested tree)
- [ ] Integration tests using User.subordinates fixture
- [ ] Depth limiting tests (with and without depth)
- [ ] Combined with select/include tests
- [ ] Multiple recursive includes in same query
- [ ] Edge case: empty results at various depths

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

4. **Circular data protection:** Hard limit of 1000 levels even when no depth specified.

5. **Depth semantics:**
   - `recurse: true` or `recurse: {}` -> recurse until no more matching records
   - `recurse: { depth: N }` -> recurse at most N levels deep

## 9. Implementation Checklist

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
[ ] Layer 2: isSelfReferencing helper
[ ] Layer 3: conditionally add recurse schema in select-include (self-ref only)
[ ] Layer 6: recurse-builder with CTE logic
[ ] Layer 6: include-builder integration
[ ] Layer 6: result parsing to nested tree
[ ] Layer 9: result type inference
[ ] Exports added to index files

TESTING
[ ] Type tests with expectTypeOf
[ ] Schema tests: valid/invalid recurse
[ ] SQL tests for PG, MySQL, SQLite
[ ] Integration tests with fixtures
```
