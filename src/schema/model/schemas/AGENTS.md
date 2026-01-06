# Model Schemas - Query Schema Generation

**Location:** `src/schema/model/schemas/`  
**Parent:** Model Layer (see [../AGENTS.md](../AGENTS.md))  
**Layer:** L3 - Query Schemas (see [root AGENTS.md](../../../../AGENTS.md))

## Purpose

Generates validation schemas for all query operations (where, create, update, select, etc.) from model field definitions.

## Why This Layer Exists

Every query needs validation:
- `findMany({ where: { email: { contains: "@" } } })` - is `contains` valid for email field?
- `create({ data: { name: "Alice" } })` - is `name` required? correct type?
- `include: { posts: { where: { ... } } }` - can posts be included? is the nested where valid?

This layer generates those validation schemas dynamically from model definitions, enabling type-safe queries without code generation.

---

## Entry Points

| File | Purpose |
|------|---------|
| `index.ts` | `getModelSchemas()` main function |
| `core/filter.ts` | Scalar and relation filter schemas |
| `core/create.ts` | Create schemas (scalar + relation) |
| `core/select.ts` | Select and include schemas |
| `args/find.ts` | findUnique, findFirst, findMany args |
| `args/mutation.ts` | create, update, delete, upsert args |

---

## Schema Types

### Core Schemas (Building Blocks)

| Schema | Purpose | Example Input |
|--------|---------|---------------|
| `scalarFilter` | Field-level WHERE | `{ eq: "foo", contains: "bar" }` |
| `relationFilter` | Relation WHERE | `{ some: {...}, every: {...} }` |
| `where` | Combined WHERE | `{ email: {...}, posts: {...}, AND: [...] }` |
| `scalarCreate` | Field creation | `{ name: "Alice", email: "..." }` |
| `relationCreate` | Nested creation | `{ posts: { create: [...] } }` |
| `select` | Field selection | `{ name: true, email: true }` |
| `include` | Relation inclusion | `{ posts: true }` |

### Args Schemas (Complete Operation Inputs)

| Schema | Composes |
|--------|----------|
| `findMany` | where + orderBy + select + include + take + skip |
| `create` | scalarCreate + relationCreate |
| `update` | where + scalarUpdate + relationUpdate |

---

## Core Rules

### Rule 1: Lazy Schema Building
Schemas built on first `["~"]` access using `??=`:

```typescript
get ["~"]() {
  return {
    schemas: (this._schemas ??= getModelSchemas(this.state)),
  };
}
```

**Why:** Schemas are expensive to build. Lazy caching avoids repeated construction on every access.

### Rule 2: Dynamic Schema Extraction
Use `v.fromObject(fields, path)` to extract schemas dynamically:

```typescript
// Extracts filter schema from each field
v.fromObject(state.scalars, "~.schemas.filter")
```

**Why:** Field list isn't known statically. Dynamic extraction works for any model.

### Rule 3: Thunks for Recursion
AND/OR/NOT use thunks for self-reference:

```typescript
v.object({
  AND: () => v.array(whereSchema),  // ← Thunk, not direct reference
  OR: () => v.array(whereSchema),
  NOT: () => whereSchema,
})
```

**Why:** Direct reference causes infinite recursion during schema construction.

### Rule 4: Core + Args Separation
Core schemas are reusable fragments. Args schemas compose them:

```typescript
// Args schema composes core schemas
getFindManyArgs(state) {
  return v.object({
    where: () => getWhereSchema(state),      // Core
    orderBy: () => getOrderBySchema(state),  // Core
    select: () => getSelectSchema(state),    // Core
    take: () => v.int({ optional: true }),
    skip: () => v.int({ optional: true }),
  });
}
```

---

## Anti-Patterns

### Eager Schema Building
Calling `getModelSchemas()` without caching. Rebuilds schemas on every `["~"]` access, hurting performance.

### Direct Recursion Without Thunks
Defining `AND: v.array(whereSchema)` directly. Causes infinite loop at construction time.

### Hardcoded Field Enumeration
Listing fields manually like `{name: ..., email: ...}`. Use `v.fromObject()` for dynamic extraction.

### Separate Schema Factories
Creating `getWhereSchema`, `getCreateSchema` as independent functions without sharing core schemas. Leads to inconsistency.

### Missing Lazy Initialization
Not using `??=` for schema caching. Rebuilds schemas on every `["~"]` access.

---

## Key Patterns

### v.fromObject Pattern

Extracts schema at path from each field:

```typescript
// For each field in state.scalars, access field["~"].schemas.filter
const scalarFilters = v.fromObject(state.scalars, "~.schemas.filter");

// Result: { name: StringFilterSchema, email: StringFilterSchema, ... }
```

### Thunk Pattern for Recursion

```typescript
const whereSchema = v.object({
  AND: () => v.optional(v.union([whereSchema, v.array(whereSchema)])),
  OR: () => v.optional(v.array(whereSchema)),
  NOT: () => v.optional(whereSchema),
}).extend(scalarFilters.entries);
```

---

## Adding New Filter Operator

1. **Add to field schema** (`src/schema/fields/{type}/schemas.ts`):
   ```typescript
   filter: v.object({
     eq: ...,
     myNewOp: () => v.string(),  // Add here
   })
   ```

2. **Handle in where-builder** (`src/query-engine/builders/where-builder.ts`)

3. **Add adapter method** if database-specific (`src/adapters/database-adapter.ts`)

4. **Implement in all adapters** (postgres, mysql, sqlite)

---

## Invisible Knowledge

### Why `v.fromObject` instead of iteration
`v.fromObject` is a validation primitive that creates a schema from an object of schemas. It handles the lazy evaluation internally, avoiding the need to manually wrap each field.

### Why thunks in AND/OR/NOT
The where schema references itself. Without thunks, constructing the schema would immediately try to construct itself again, infinitely.

### Why separate core and args
Core schemas are used in multiple places (where appears in findMany, update, delete, nested includes). Separating them avoids duplication and ensures consistency.

---

## Related Layers

| Layer | Relationship |
|-------|--------------|
| **Fields** ([fields/AGENTS.md](../../fields/AGENTS.md)) | Provides `field["~"].schemas.filter` |
| **Query Engine** ([query-engine/AGENTS.md](../../../query-engine/AGENTS.md)) | Validates inputs against these schemas |
| **Client** ([client/AGENTS.md](../../../client/AGENTS.md)) | Infers types from these schemas |
