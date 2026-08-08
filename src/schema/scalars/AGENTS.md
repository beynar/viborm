# Schema Scalars - Scalar Type Definitions

**Location:** `src/schema/scalars/`  
**Parent:** Schema Layer (see [../AGENTS.md](../AGENTS.md))

## Purpose

Defines all database scalar types using the State generic pattern with chainable configuration API.

## Why This Layer Exists

Scalars are the primitive/value kind of model field. They need to carry their configuration through a fluent API while preserving type information:

```typescript
s.string()           // StringScalar<{type: "string"}>
  .nullable()        // StringScalar<{type: "string", nullable: true}>
  .default("hello")  // StringScalar<{type: "string", nullable: true, default: "hello"}>
```

Each method returns a NEW instance with updated State generic. This enables TypeScript to track configuration changes at compile time, giving fully-typed queries without code generation.

---

## Entry Points

| File | Purpose | Update When |
|------|---------|-------------|
| `base.ts` | `Scalar` union type | **Adding new scalar type!** |
| `common.ts` | ScalarState, UpdateState helpers | Rarely |
| `{type}/scalar.ts` | Scalar class implementation | Adding methods to scalar |

---

## What Lives Here

This package contains scalar implementations only. It does not contain relation
fields, model-level field-key helpers, relation `.fields()` logic, or query
selection fields.

**Scalar Types (14 total):**
- **Text:** string
- **Numeric:** int, float, decimal, bigInt
- **Boolean:** boolean
- **Temporal:** dateTime, date, time
- **Complex:** json, enum, blob, vector, point

**Each scalar directory contains:**
- `scalar.ts` - Scalar class with State generic and chainable methods
- `index.ts` - Re-exports

---

## Core Rules

### Rule 1: State Generic Pattern
Every scalar carries configuration as a type parameter. TypeScript tracks state changes at compile time.

```typescript
class StringScalar<State extends ScalarState<"string">> {
  constructor(readonly state: State) {}
  
  nullable(): StringScalar<UpdateState<State, { nullable: true }>> {
    return new StringScalar({ ...this.state, nullable: true });
  }
}
```

**Why:** Enables type-safe queries without code generation. The State flows into validation registry schemas automatically.

### Rule 2: Immutability
Every modifier returns a NEW instance. Never mutate `this.state`.

**Why:** TypeScript can't track mutations. If you write `this.state.nullable = true`, the type says `nullable: true` but might not match runtime.

### Rule 3: Base Schema in State
The schema layer owns base scalar schemas as part of scalar state. Operation schemas (`filter`, `create`, `update`) are built in `src/validation/scalars/` and composed by `SchemaRegistry`.

```typescript
get ["~"]() {
  return {
    state: this.state,
  };
}
```

**Why:** Base validation belongs to the scalar definition; operation validation needs model graph context from the registry.

### Rule 4: Validation Scalar Factory
Each scalar type has a matching validation scalar factory that derives operation schemas from scalar state:

```typescript
function buildStringSchema(state: ScalarState<"string">) {
  return {
    base: state.base,
    filter: buildStringFilter(state),
    create: buildStringCreate(state),
    update: buildStringUpdate(state),
  };
}
```

**Why:** Ensures consistency while keeping operation schemas out of the schema layer.

### Rule 5: Shared Contracts, Concrete Implementations
Modifier behavior is tested through parameterized contracts, but each concrete
scalar continues to rebuild the validation primitive that owns its value type.
`updateState` owns the shared immutable merge. Do not introduce a generic
scalar base class that hides the state type or moves base-schema ownership out
of the concrete scalar.

Use `pnpm test:coverage:scalars` for the memory-capped L2 report. It gates
statements, branches, functions, and lines at 100% and writes
`coverage/scalars/index.html`.

---

## Anti-Patterns

### Mutating This.state
Modifying `this.state.nullable = true` instead of returning new instance. Breaks immutability contract and type tracking.

### Operation Schemas in Scalar Classes
Building `filter`, `create`, or `update` schemas inside scalar classes. Operation schemas belong in `src/validation/scalars/` and are accessed through `SchemaRegistry`.

### Eager Schema Construction
Building operation schemas during scalar construction. Let `SchemaRegistry` construct and cache them when the ORM needs validation.

### Forgetting UpdateState Helper
Manually constructing new state type. Use `UpdateState<State, {nullable: true}>` for correct type transformation.

### Non-Chainable Methods
Methods that don't return `this` type or new instance. Breaks the fluent API that users expect.

---

## Adding New Scalar Type

1. **Create directory** `scalars/{type}/`

2. **Create `scalar.ts`** with State generic:
   ```typescript
   export class MyScalar<State extends ScalarState<"mytype">> {
     constructor(readonly state: State) {}
     // Chainable methods returning new instances
   }
   ```

3. **Create validation scalar support** in `src/validation/scalars/{type}.ts`:
   ```typescript
   export function buildMyScalarSchema(state: ScalarState<"mytype">) {
     return { base, filter, create, update };
   }
   ```

4. **Update `ScalarType` and `Scalar` union** in `common.ts` and `base.ts` (CRITICAL!):
   ```typescript
   export type Scalar = StringScalar<any> | IntScalar<any> | MyScalar<any>;
   ```

5. **Add to `s` builder** in `src/schema/index.ts`

6. **Add tests** in `tests/scalars/{type}-scalar-schemas.test.ts`

---

## Invisible Knowledge

### Why `["~"]` instead of a normal property
The tilde symbol visually indicates "internal API". It's a valid property name but unusual enough that users won't accidentally access it. We tried `_internal` but it appeared in autocomplete too prominently.

### Why scalar state stores `base`
`base` is the scalar value contract and belongs to the scalar definition. Query-specific wrappers such as `filter`, `create`, and `update` depend on operation context and live in the validation registry.

### Why UpdateState uses intersection
```typescript
type UpdateState<S, U> = Omit<S, keyof U> & U;
```
This ensures new properties override old ones correctly. Simple `S & U` would create impossible types when properties conflict.

---

## Related Layers

| Layer | Relationship |
|-------|--------------|
| **Model** (`../model/`) | Uses scalar definitions as value fields in models |
| **Validation** ([validation/AGENTS.md](../../validation/AGENTS.md)) | Provides v.* primitives and scalar operation schemas |
