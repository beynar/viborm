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
- **Numeric:** int, number, decimal, bigInt
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

Use `pnpm test:coverage:schema` for the memory-capped schema-subsystem report.
It gates statements, branches, functions, and lines at 100% and writes
`coverage/schema/index.html`. Scalars share that one schema denominator; there
is no separate scalar coverage command.

### Rule 6: Fixed Decimal Has One Descriptor

`s.decimal({ precision, scale })` is the only decimal factory. The structural
`DecimalDescriptor` shape belongs to
`src/validation/primitives/decimal-codec.ts`. The scalar validates hostile input
once, freezes one instance in `ScalarState.decimal`, and every modifier carries
that same object by reference. That instance is the field's sole precision and
scale source for validation, DDL, query lowering, results, lists, cache
identity, and migrations. Do not mint a parallel live descriptor owner or
restore a native-type or zero-argument decimal mode.

The scalar declares the public shape; `src/validation/primitives/decimal-codec.ts`
owns value conversion. A decimal list cannot be an ID, unique field, index or
compound-key member, foreign-key member, or relation identity member. Its
declaration owns `.id()`/`.unique()` refusal; L5 owns index/compound-key and FK
positions.

A literal decimal default is validated and normalized through the current full
field codec at the modifier boundary. That canonical output is the retained
state value and is trusted downstream; a later `.schema()` or arity change
revalidates it once against the newly declared field. Function defaults retain
their closure and validate once per invocation.

### Rule 7: Identifiers Are Generated Here, Represented There

`s.string()` declares six identifier formats — `.uuid()`, `.uuidv7()`,
`.ulid()`, `.ksuid()`, `.nanoid(length?)`, `.cuid()` — plus `.id()`, which is a
KEY declaration that installs a ULID only when no generator was declared and
never overrides one. Every modifier writes the same two facts: the declaration
in `ScalarState.autoGenerate` (`{ kind, prefix?, length? }`) and the closure in
`default`, marked through `generatorDefault`. There is no second registry: a
`generate` kind IS the method name, which is why a new format costs the method,
the type union, and the reader's token table and nothing else.

`string/autogenerate.ts` owns what a GENERATOR adds — the clock it reads, the
ULID sequence the process shares, the CUID2 port, and prefix application.
`@validation/primitives/id-formats` owns what a FORMAT is: widths, alphabets,
byte layouts, the reversible text/bytes conversions, and the one
`crypto.getRandomValues` acquisition. Do not re-derive a width or an alphabet
above that leaf, do not add a `Math.random()` path, and do not draw entropy at
import or declaration time — every generator is lazy so that loading VibORM and
describing a schema draw none.

A NAMED format is also a DOMAIN, and `.id()` alone is not. Naming
`.uuid()`/`.ulid()`/… promises that every value of the field belongs to that
format, which is what lets VibORM admit those values, normalize their aliases
and store them compactly; `.id()` declares a key whose values stay whatever a
string column holds. `AutoGenerate.implicit` is the whole record of that
difference — written only by `.id()`, read only by `idDomainOfState`, and
restated by the schema document so a round trip cannot promote a key into a
domain.

| Question | Owner |
|---|---|
| Which format, prefix and length were declared | `ScalarState.autoGenerate` (`string/scalar.ts`) |
| Is that a DOMAIN, and which one | `string/id-domain.ts` — `idDomainOfState` |
| Which column and which physical form on a dialect | `string/id-domain.ts` — `idStorageOf` |
| Which strings belong to it, and their canonical spelling | `@validation/primitives/id-codec` |
| What a foreign key's domain is | `@schema/validation/id-domains` (L5, derived) |

`idStorageOf` is the ONE storage decision: the migration column type, the
adapter's read promise and the engine's parameter binding all derive from it, so
a column cannot be created as one thing and written as another. A native type
override is interpreted there too, and one the domain cannot live in is refused
at the gate (F013) rather than guessed at.

### Rule 8: GeoPoint Has One Fixed Declaration

`s.point()` takes no argument and exposes only `.nullable()`, `.default()`, and
`.map()`. Its scalar state carries the one `v.point()` value schema; it has no
native type, array, ID, unique, custom-schema, or configurable-SRID mode.
Definition validation owns compound key, foreign-key, and spatial-index roles.
All value normalization stays in the validation GeoPoint codec, not the scalar.

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

6. **Add tests** in `tests/unit/scalars/{type}-scalar-schemas.core.test.ts`

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
