# Schema Fields - Field Type Definitions

**Location:** `src/schema/fields/`  
**Parent:** Schema Layer (see [../AGENTS.md](../AGENTS.md))

## Purpose

Defines all database field types using the State generic pattern with chainable configuration API.

## Why This Layer Exists

Field types need to carry their configuration through a fluent API while preserving type information:

```typescript
s.string()           // StringField<{type: "string"}>
  .nullable()        // StringField<{type: "string", nullable: true}>
  .default("hello")  // StringField<{type: "string", nullable: true, default: "hello"}>
```

Each method returns a NEW instance with updated State generic. This enables TypeScript to track configuration changes at compile time, giving fully-typed queries without code generation.

---

## Entry Points

| File | Purpose | Update When |
|------|---------|-------------|
| `base.ts` | `Field` union type | **Adding new field type!** |
| `common.ts` | FieldState, UpdateState helpers | Rarely |
| `{type}/field.ts` | Field class implementation | Adding methods to field |
| `{type}/schemas.ts` | Schema factory | Adding filter operators |

---

## What Lives Here

**Field Types:** string, number (int/float/decimal), boolean, datetime, bigint, enum, json, blob, vector, point

**Each field directory contains:**
- `field.ts` - Field class with State generic and chainable methods
- `schemas.ts` - Single factory returning `{base, filter, create, update}`
- `index.ts` - Re-exports

---

## Core Rules

### Rule 1: State Generic Pattern
Every field carries configuration as a type parameter. TypeScript tracks state changes at compile time.

```typescript
class StringField<State extends StringFieldState> {
  constructor(readonly state: State) {}
  
  nullable(): StringField<UpdateState<State, { nullable: true }>> {
    return new StringField({ ...this.state, nullable: true });
  }
}
```

**Why:** Enables type-safe queries without code generation. The State flows through to query schemas automatically.

### Rule 2: Immutability
Every modifier returns a NEW instance. Never mutate `this.state`.

**Why:** TypeScript can't track mutations. If you write `this.state.nullable = true`, the type says `nullable: true` but might not match runtime.

### Rule 3: Lazy Schema Building
Schemas built on first `["~"]` access using `??=` operator.

```typescript
get ["~"]() {
  return {
    schemas: (this._schemas ??= buildStringSchema(this.state)),
  };
}
```

**Why:** Schemas are expensive to build. Lazy caching avoids repeated construction on every access.

### Rule 4: Single Schema Factory
Each field has ONE factory function returning all schemas at once:

```typescript
function buildStringSchema(state: StringFieldState) {
  return {
    base: v.string({ nullable: state.nullable }),
    filter: buildStringFilter(state),
    create: buildStringCreate(state),
    update: buildStringUpdate(state),
  };
}
```

**Why:** Ensures consistency. All four schemas derive from the same state.

---

## Anti-Patterns

### Mutating This.state
Modifying `this.state.nullable = true` instead of returning new instance. Breaks immutability contract and type tracking.

### Multiple Schema Factories
Creating separate functions for base, filter, create, update. Use single factory returning all four for consistency.

### Eager Schema Construction
Building schemas without caching. Wastes performance by rebuilding on every `["~"]` access.

### Forgetting UpdateState Helper
Manually constructing new state type. Use `UpdateState<State, {nullable: true}>` for correct type transformation.

### Non-Chainable Methods
Methods that don't return `this` type or new instance. Breaks the fluent API that users expect.

---

## Adding New Field Type

1. **Create directory** `fields/{type}/`

2. **Create `field.ts`** with State generic:
   ```typescript
   export class MyField<State extends MyFieldState> {
     constructor(readonly state: State) {}
     // Chainable methods returning new instances
   }
   ```

3. **Create `schemas.ts`** with single factory:
   ```typescript
   export function buildMyFieldSchema(state: MyFieldState) {
     return { base, filter, create, update };
   }
   ```

4. **Update `Field` union** in `base.ts` (CRITICAL!):
   ```typescript
   export type Field = StringField<any> | IntField<any> | MyField<any>;
   ```

5. **Add to `s` builder** in `src/schema/index.ts`

6. **Add tests** in `tests/fields/{type}-field-schemas.test.ts`

---

## Invisible Knowledge

### Why `["~"]` instead of a normal property
The tilde symbol visually indicates "internal API". It's a valid property name but unusual enough that users won't accidentally access it. We tried `_internal` but it appeared in autocomplete too prominently.

### Why schemas return `{base, filter, create, update}`
These four cover all use cases: `base` for simple validation, `filter` for WHERE clauses, `create` for INSERT, `update` for UPDATE (often has `increment`, `set`, etc.). Early versions had more, but these four proved sufficient.

### Why UpdateState uses intersection
```typescript
type UpdateState<S, U> = Omit<S, keyof U> & U;
```
This ensures new properties override old ones correctly. Simple `S & U` would create impossible types when properties conflict.

---

## Related Layers

| Layer | Relationship |
|-------|--------------|
| **Model** ([model/AGENTS.md](../model/AGENTS.md)) | Composes fields into models |
| **Query Schemas** ([model/schemas/AGENTS.md](../model/schemas/AGENTS.md)) | Uses field schemas for query validation |
| **Validation** ([validation/AGENTS.md](../../validation/AGENTS.md)) | Provides v.* primitives used in schemas |
