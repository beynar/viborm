# Prepared Statements Implementation

## 1. Overview

Prepared statements allow users to define queries with typed placeholders that are resolved at execution time. This enables:

- **Reusable queries**: Define once, execute multiple times with different values
- **Type-safe placeholders**: Placeholder names and types inferred from schema
- **Performance optimization**: SQL pre-built, only parameter binding at runtime

## 2. User-Facing API

### Basic Usage

```typescript
// Define a prepared statement with placeholder callback syntax
const findUserById = client.user.findUnique({
  where: { 
    id: ({ $ }) => $("userId")  // placeholder: ({ $ }) => $("name")
  }
}).prepare();

// Execute with typed parameters
const user = await findUserById.run({ userId: "abc123" });
// Type of params: { userId: string } — inferred from field type

// Reuse with different values
const anotherUser = await findUserById.run({ userId: "xyz789" });
```

### Multiple Placeholders

```typescript
const findUsers = client.user.findMany({
  where: {
    AND: [
      { email: { contains: ({ $ }) => $("emailPattern") } },
      { age: { gte: ({ $ }) => $("minAge") } },
      { status: ({ $ }) => $("status") }
    ]
  },
  take: ({ $ }) => $("limit")
}).prepare();

// All placeholder types inferred
const users = await findUsers.run({
  emailPattern: "@company.com",  // string (from email field)
  minAge: 18,                     // number (from age field)
  status: "active",               // string (from status field)
  limit: 10                       // number (from take)
});
```

### Reusing Same Placeholder

```typescript
// Same placeholder can be used multiple times
const findByIdOrEmail = client.user.findFirst({
  where: {
    OR: [
      { id: ({ $ }) => $("identifier") },
      { email: ({ $ }) => $("identifier") }  // same placeholder name
    ]
  }
}).prepare();

// Single param maps to both positions
await findByIdOrEmail.run({ identifier: "abc123" });
```

### Nested Relation Filters

```typescript
const findUsersWithPosts = client.user.findMany({
  where: {
    posts: {
      some: {
        categoryId: ({ $ }) => $("categoryId")
      }
    }
  },
  include: { posts: true }
}).prepare();
```

### Mutations with Placeholders

```typescript
// Create
const createUser = client.user.create({
  data: {
    name: ({ $ }) => $("name"),
    email: ({ $ }) => $("email"),
    age: ({ $ }) => $("age")
  }
}).prepare();

// Update
const updateUserEmail = client.user.update({
  where: { id: ({ $ }) => $("userId") },
  data: { email: ({ $ }) => $("newEmail") }
}).prepare();

// Delete
const deleteUser = client.user.delete({
  where: { id: ({ $ }) => $("userId") }
}).prepare();
```

## 3. Layer Analysis

### Layer 1: User API
**Affected:** Yes  
**Reason:** Need to export prepared statement types for users  
**Changes:**
- Export `PreparedStatement` class
- Export `PlaceholderCallback` type (for advanced typing)

**Files:**
| File | Action | Purpose |
|------|--------|---------|
| `src/index.ts` | MODIFY | Export new types |

---

### Layer 2: Schema Definition
**Affected:** Yes  
**Reason:** Need placeholder types and utilities that integrate with field types  
**Changes:**
- Create placeholder symbol and type guards
- Create `PlaceholderValue` interface
- Create `PlaceholderCallback` type
- Create `createPlaceholderFn` helper

**Files:**
| File | Action | Purpose |
|------|--------|---------|
| `src/schema/fields/placeholder.ts` | CREATE | Placeholder types, symbols, type guards |
| `src/schema/fields/index.ts` | MODIFY | Export placeholder utilities |

**Key types:**
```typescript
// Symbol to identify placeholder values at runtime
export const PLACEHOLDER_SYMBOL = Symbol.for("viborm.placeholder");

// Placeholder value created by $("name") callback
export interface PlaceholderValue<T = unknown> {
  readonly [PLACEHOLDER_SYMBOL]: true;
  readonly name: string;
  readonly _type?: T;  // Phantom type for inference
}

// The $ function signature
export type PlaceholderFn<T> = <N extends string>(name: N) => PlaceholderValue<T> & { _name: N };

// Placeholder callback: ({ $ }) => $("name")
export type PlaceholderCallback<T> = (ctx: { $: PlaceholderFn<T> }) => PlaceholderValue<T>;
```

---

### Layer 3: Query Schema
**Affected:** Yes  
**Reason:** All field filter/create/update schemas must accept placeholder callbacks as valid input at leaf positions  
**Changes:**
- Add `withPlaceholder` schema wrapper utility
- Modify field schema builders to accept placeholders
- Ensure nested relation filters accept placeholders

**Files:**
| File | Action | Purpose |
|------|--------|---------|
| `src/schema/fields/common.ts` | MODIFY | Add `withPlaceholder` schema wrapper |
| `src/schema/fields/string/schemas.ts` | MODIFY | Accept placeholders in string filter/create/update |
| `src/schema/fields/int/schemas.ts` | MODIFY | Accept placeholders in int schemas |
| `src/schema/fields/float/schemas.ts` | MODIFY | Accept placeholders in float schemas |
| `src/schema/fields/boolean/schemas.ts` | MODIFY | Accept placeholders in boolean schemas |
| `src/schema/fields/datetime/schemas.ts` | MODIFY | Accept placeholders in datetime schemas |
| `src/schema/fields/json/schemas.ts` | MODIFY | Accept placeholders in json schemas |
| `src/schema/fields/enum/schemas.ts` | MODIFY | Accept placeholders in enum schemas |
| `src/schema/model/schemas/args/*.ts` | MODIFY | Accept placeholders in take/skip/cursor args |

**Pattern for schema modification:**
```typescript
// Before: Only accepts actual value
export type StringFilterSchema<S extends V.Schema> = V.Union<readonly [
  V.ShorthandFilter<S>,
  V.Object<StringFilterBase<S> & { not: ... }>
]>;

// After: Also accepts placeholder callback
export type StringFilterSchema<S extends V.Schema> = V.Union<readonly [
  V.ShorthandFilter<S>,
  V.PlaceholderCallback<InferInput<S>>,  // NEW
  V.Object<StringFilterBase<S> & { not: ... }>
]>;
```

---

### Layer 4: Validation Library
**Affected:** Yes  
**Reason:** Need custom validation schema type for placeholder callbacks  
**Changes:**
- Add `v.placeholderCallback()` schema that accepts functions
- Ensure placeholder callbacks pass validation without being invoked

**Files:**
| File | Action | Purpose |
|------|--------|---------|
| `src/validation/schemas/placeholder.ts` | CREATE | Placeholder callback validation schema |
| `src/validation/index.ts` | MODIFY | Export placeholder schema |

**Implementation:**
```typescript
// Validates that value is a placeholder callback function
export const placeholderCallback = <T>() => 
  v.custom<PlaceholderCallback<T>>((value) => typeof value === "function");
```

---

### Layer 5: Schema Validation (Definition-time)
**Affected:** No  
**Reason:** Prepared statements are a query-time feature, not schema definition validation. No schema definition rules needed.

---

### Layer 6: Query Engine
**Affected:** Yes  
**Reason:** Core of the feature — must extract placeholders, build SQL with markers, and create PreparedStatement  
**Changes:**
- Create placeholder extractor that walks args and collects placeholder metadata
- Modify SQL builders to handle `PlaceholderValue` objects
- Create `PreparedStatement` class for reusable execution
- Add prepare capability to query engine

**Files:**
| File | Action | Purpose |
|------|--------|---------|
| `src/query-engine/builders/placeholder-extractor.ts` | CREATE | Extract placeholders from args |
| `src/query-engine/builders/where-builder.ts` | MODIFY | Handle PlaceholderValue in conditions |
| `src/query-engine/builders/values-builder.ts` | MODIFY | Handle PlaceholderValue in INSERT |
| `src/query-engine/builders/set-builder.ts` | MODIFY | Handle PlaceholderValue in UPDATE SET |
| `src/query-engine/prepared.ts` | CREATE | PreparedStatement class |
| `src/query-engine/types.ts` | MODIFY | Add prepared statement types |

**Placeholder Extractor:**
```typescript
export interface PlaceholderInfo {
  name: string;
  path: string[];           // Path in args where found
  expectedType: string;     // For debugging
}

export interface ExtractionResult {
  resolvedArgs: Record<string, unknown>;  // Args with callbacks invoked
  placeholders: Map<string, PlaceholderInfo>;
  bindingOrder: { name: string; path: string[] }[];  // Order for SQL params
}

export function extractPlaceholders(
  args: Record<string, unknown>,
  fieldTypeResolver?: (path: string[]) => string
): ExtractionResult {
  // Recursively walk args
  // When callback found: invoke it, collect PlaceholderValue
  // Return resolved args + placeholder metadata
}
```

**PreparedStatement class:**
```typescript
export class PreparedStatement<TParams extends Record<string, unknown>, TResult> {
  private readonly sql: Sql;
  private readonly extraction: ExtractionResult;
  private readonly parseResult: (raw: { rows: unknown[]; rowCount: number }) => TResult;
  private readonly driver: AnyDriver;
  
  async run(params: TParams): Promise<TResult> {
    // 1. Build values array from params in binding order
    // 2. Execute SQL with values
    // 3. Parse and return result
  }
}
```

**Where builder modification:**
```typescript
function buildScalarCondition(ctx: QueryContext, value: unknown, column: Sql): Sql {
  // NEW: Handle placeholder values
  if (isPlaceholderValue(value)) {
    // Return placeholder marker — will be replaced at execution time
    return ctx.adapter.literals.placeholder(value.name);
  }
  
  // Existing logic for regular values...
  return ctx.adapter.literals.value(value);
}
```

---

### Layer 7: Database Adapters
**Affected:** Yes  
**Reason:** Need adapter method to generate placeholder markers in SQL that can be replaced at execution time  
**Changes:**
- Add `literals.placeholder(name)` method to adapter interface
- Implement in all adapters (postgres, mysql, sqlite)

**Files:**
| File | Action | Purpose |
|------|--------|---------|
| `src/adapters/types.ts` | MODIFY | Add placeholder to literals interface |
| `src/adapters/database-adapter.ts` | MODIFY | Implement placeholder method |

**Implementation:**
```typescript
// In DatabaseAdapter interface
interface DatabaseAdapter {
  literals: {
    // ... existing ...
    placeholder: (name: string) => Sql;
  };
}

// Base implementation
placeholder(name: string): Sql {
  // Return marker that PreparedStatement will replace
  return new Sql([`__PH:${name}__`], []);
}
```

---

### Layer 8: Driver Layer
**Affected:** No  
**Reason:** Drivers already support parameterized queries via `_executeRaw(sql, params)`. PreparedStatement uses this existing capability.

---

### Layer 9: Client Layer
**Affected:** Yes  
**Reason:** Add `.prepare()` method to PendingOperation  
**Changes:**
- Add `prepare()` method that returns `PreparedStatement`
- Add type definitions for placeholder extraction and prepared operations

**Files:**
| File | Action | Purpose |
|------|--------|---------|
| `src/client/pending-operation.ts` | MODIFY | Add prepare() method |
| `src/client/types.ts` | MODIFY | Add PreparedStatement types |

**PendingOperation modification:**
```typescript
class PendingOperation<T> {
  // ... existing ...
  
  /**
   * Convert to PreparedStatement for reusable execution.
   * SQL is built once; .run() only binds parameters.
   */
  prepare(): PreparedStatement<ExtractPlaceholders<Args>, T> {
    // 1. Extract placeholders from args
    const extraction = extractPlaceholders(this.metadata.args);
    
    // 2. Validate resolved args
    const validated = validate(model, operation, extraction.resolvedArgs);
    
    // 3. Build SQL with placeholder markers
    const sql = buildQuery(validated, ...);
    
    // 4. Return PreparedStatement
    return new PreparedStatement({ sql, extraction, parseResult, ... }, driver);
  }
}
```

---

### Layer 10: Cache Layer
**Affected:** No (initial implementation)  
**Reason:** Prepared statements execute directly, bypassing cache. Future enhancement could cache SQL for repeated `.prepare()` calls.

---

### Layer 11: Instrumentation
**Affected:** Yes  
**Reason:** Should trace prepared statement creation and execution  
**Changes:**
- Add span names for prepare and run operations
- Add attributes for placeholder count

**Files:**
| File | Action | Purpose |
|------|--------|---------|
| `src/instrumentation/spans.ts` | MODIFY | Add SPAN_PREPARE, SPAN_PREPARED_RUN |

**New constants:**
```typescript
export const SPAN_PREPARE = "viborm.prepare";
export const SPAN_PREPARED_RUN = "viborm.prepared.run";
export const ATTR_PREPARED_PLACEHOLDER_COUNT = "viborm.prepared.placeholder_count";
```

---

## 4. Type System Design

### Placeholder Type Inference

The key challenge is inferring parameter types from placeholder usage:

```typescript
// Goal: Infer { userId: string, minAge: number }
const prepared = client.user.findMany({
  where: {
    id: ({ $ }) => $("userId"),        // userId: string
    age: { gte: ({ $ }) => $("minAge") } // minAge: number
  }
}).prepare();
```

### Type Extraction

```typescript
/**
 * Extract placeholder names and types from args type
 */
type ExtractPlaceholders<T> = T extends PlaceholderCallback<infer ValueType>
  ? ReturnType<T> extends PlaceholderValue<ValueType> & { _name: infer N }
    ? { [K in N & string]: ValueType }
    : never
  : T extends object
    ? UnionToIntersection<{ [K in keyof T]: ExtractPlaceholders<T[K]> }[keyof T]>
    : {};

type UnionToIntersection<U> = 
  (U extends any ? (k: U) => void : never) extends ((k: infer I) => void) ? I : never;

/**
 * PreparedStatement with inferred params
 */
type PrepareResult<Args, Result> = PreparedStatement<ExtractPlaceholders<Args>, Result>;
```

### Fallback Strategy

If full type extraction proves too complex, use explicit generic:

```typescript
// Explicit type parameter
const prepared = client.user.findUnique({
  where: { id: ({ $ }) => $("userId") }
}).prepare<{ userId: string }>();
```

---

## 5. Alternatives Considered

### Alternative 1: Special object syntax `{ $ref: "name" }`
**Rejected:** Conflicts with potential future object syntax, less discoverable, can't carry type information.

### Alternative 2: Template string placeholders
**Rejected:** Can't carry type information through TypeScript's type system.

### Alternative 3: Separate `prepareQuery()` function
**Rejected:** Less ergonomic than chained `.prepare()`, breaks fluent API pattern.

### Alternative 4: Option on existing methods `{ prepare: true }`
**Rejected:** Mixes execution concerns with query definition, less clear intent than separate method.

---

## 6. Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/schema/fields/placeholder.ts` | CREATE | Placeholder types, symbols, type guards |
| `src/schema/fields/index.ts` | MODIFY | Export placeholder utilities |
| `src/schema/fields/common.ts` | MODIFY | Add withPlaceholder schema wrapper |
| `src/schema/fields/string/schemas.ts` | MODIFY | Accept placeholders |
| `src/schema/fields/int/schemas.ts` | MODIFY | Accept placeholders |
| `src/schema/fields/float/schemas.ts` | MODIFY | Accept placeholders |
| `src/schema/fields/boolean/schemas.ts` | MODIFY | Accept placeholders |
| `src/schema/fields/datetime/schemas.ts` | MODIFY | Accept placeholders |
| `src/schema/fields/json/schemas.ts` | MODIFY | Accept placeholders |
| `src/schema/fields/enum/schemas.ts` | MODIFY | Accept placeholders |
| `src/schema/model/schemas/args/find.ts` | MODIFY | Accept placeholders in take/skip |
| `src/validation/schemas/placeholder.ts` | CREATE | Placeholder validation schema |
| `src/validation/index.ts` | MODIFY | Export placeholder schema |
| `src/adapters/types.ts` | MODIFY | Add placeholder to literals |
| `src/adapters/database-adapter.ts` | MODIFY | Implement placeholder method |
| `src/query-engine/builders/placeholder-extractor.ts` | CREATE | Extract placeholders from args |
| `src/query-engine/builders/where-builder.ts` | MODIFY | Handle PlaceholderValue |
| `src/query-engine/builders/values-builder.ts` | MODIFY | Handle PlaceholderValue |
| `src/query-engine/builders/set-builder.ts` | MODIFY | Handle PlaceholderValue |
| `src/query-engine/prepared.ts` | CREATE | PreparedStatement class |
| `src/query-engine/types.ts` | MODIFY | Add prepared statement types |
| `src/client/pending-operation.ts` | MODIFY | Add prepare() method |
| `src/client/types.ts` | MODIFY | Add PreparedStatement types |
| `src/instrumentation/spans.ts` | MODIFY | Add span constants |
| `src/index.ts` | MODIFY | Export new types |

---

## 7. Tests Required

### Unit Tests
- [ ] `tests/prepared/placeholder.test.ts` — Placeholder creation and type guards
- [ ] `tests/prepared/extractor.test.ts` — Placeholder extraction from nested objects
- [ ] `tests/prepared/prepared-statement.test.ts` — PreparedStatement run() behavior

### Schema Tests
- [ ] `tests/prepared/schema-validation.test.ts` — Placeholder callbacks pass validation
- [ ] `tests/prepared/field-schemas.test.ts` — All field types accept placeholders

### SQL Generation Tests
- [ ] `tests/prepared/sql-generation.test.ts` — Correct SQL with placeholder markers
- [ ] `tests/prepared/binding-order.test.ts` — Parameters bound in correct order

### Type Tests
- [ ] `tests/prepared/types.test.ts` — Placeholder name inference
- [ ] `tests/prepared/types.test.ts` — Placeholder type inference from field
- [ ] `tests/prepared/types.test.ts` — Multiple placeholders merged correctly
- [ ] `tests/prepared/types.test.ts` — Duplicate placeholder names handled

### Integration Tests
- [ ] `tests/prepared/integration.test.ts` — findUnique with placeholder
- [ ] `tests/prepared/integration.test.ts` — findMany with multiple placeholders
- [ ] `tests/prepared/integration.test.ts` — Nested relation filter with placeholder
- [ ] `tests/prepared/integration.test.ts` — Create with placeholders
- [ ] `tests/prepared/integration.test.ts` — Update with placeholders
- [ ] `tests/prepared/integration.test.ts` — Delete with placeholder
- [ ] `tests/prepared/integration.test.ts` — Reuse prepared statement multiple times

---

## 8. Implementation Order

### Phase 1: Core Infrastructure
1. Create `src/schema/fields/placeholder.ts`
2. Create `src/validation/schemas/placeholder.ts`
3. Add placeholder to adapter interface

### Phase 2: Schema Support
4. Add `withPlaceholder` wrapper to common.ts
5. Modify field schemas (string, int, float, etc.)
6. Modify args schemas (take, skip, cursor)

### Phase 3: Query Engine
7. Create `src/query-engine/builders/placeholder-extractor.ts`
8. Modify builders (where, values, set)
9. Create `src/query-engine/prepared.ts`

### Phase 4: Client Integration
10. Add `prepare()` to PendingOperation
11. Add type definitions
12. Export from index.ts

### Phase 5: Testing & Polish
13. Unit tests
14. Integration tests
15. Type tests
16. Instrumentation spans

---

## Feature Implementation Checklist

```
ANALYSIS
[x] Work type identified: New Feature
[x] Feature category: Query API extension
[x] Each layer analyzed with justification
[x] Design decisions documented

TYPE SYSTEM
[ ] State interface defined (PlaceholderValue)
[ ] Generic parameters preserve type flow
[ ] No type assertions used
[ ] InferInput / InferOutput produce correct types

IMPLEMENTATION
[ ] Layer 2 (Schema Definition): Placeholder types created
[ ] Layer 3 (Query Schema): withPlaceholder wrapper added
[ ] Layer 4 (Validation): Placeholder schema added
[ ] Layer 6 (Query Engine): Extractor and PreparedStatement created
[ ] Layer 7 (Adapters): placeholder() method added
[ ] Layer 9 (Client): prepare() method added
[ ] Layer 11 (Instrumentation): Span names added
[ ] Exports added to index.ts

TESTING
[ ] Type tests: expectTypeOf for placeholder inference
[ ] Schema tests: Placeholders pass validation
[ ] SQL tests: Correct SQL with markers
[ ] Integration: End-to-end prepared statement execution

DOCUMENTATION
[x] Feature document in features-docs/
[ ] Code comments for complex logic
```
