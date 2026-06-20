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

---

## What Lives Here

**Field Types (14 total):**
- **Text:** string
- **Numeric:** int, float, decimal, bigInt
- **Boolean:** boolean
- **Temporal:** dateTime, date, time
- **Complex:** json, enum, blob, vector, point

**Each field directory contains:**
- `field.ts` - Field class with State generic and chainable methods
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

**Why:** Enables type-safe queries without code generation. The State flows into validation registry schemas automatically.

### Rule 2: Immutability
Every modifier returns a NEW instance. Never mutate `this.state`.

**Why:** TypeScript can't track mutations. If you write `this.state.nullable = true`, the type says `nullable: true` but might not match runtime.

### Rule 3: Base Schema in State
The schema layer owns base field schemas as part of field state. Operation schemas (`filter`, `create`, `update`) are built in `src/validation/scalars/` and composed by `SchemaRegistry`.

```typescript
get ["~"]() {
  return {
    state: this.state,
  };
}
```

**Why:** Base validation belongs to the field definition; operation validation needs model graph context from the registry.

### Rule 4: Validation Scalar Factory
Each field type has a matching validation scalar factory that derives operation schemas from field state:

```typescript
function buildStringSchema(state: StringFieldState) {
  return {
    base: state.base,
    filter: buildStringFilter(state),
    create: buildStringCreate(state),
    update: buildStringUpdate(state),
  };
}
```

**Why:** Ensures consistency while keeping operation schemas out of the schema layer.

---

## Anti-Patterns

### Mutating This.state
Modifying `this.state.nullable = true` instead of returning new instance. Breaks immutability contract and type tracking.

### Operation Schemas in Field Classes
Building `filter`, `create`, or `update` schemas inside field classes. Operation schemas belong in `src/validation/scalars/` and are accessed through `SchemaRegistry`.

### Eager Schema Construction
Building operation schemas during field construction. Let `SchemaRegistry` construct and cache them when the ORM needs validation.

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

3. **Create validation scalar support** in `src/validation/scalars/{type}.ts`:
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

### Why field state stores `base`
`base` is the scalar value contract and belongs to the field definition. Query-specific wrappers such as `filter`, `create`, and `update` depend on operation context and live in the validation registry.

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
| **Validation** ([validation/AGENTS.md](../../validation/AGENTS.md)) | Provides v.* primitives and scalar operation schemas |
