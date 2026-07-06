# Validation - Primitives and Operation Schemas

**Location:** `src/validation/`  
**Layer:** L1 + L3 - Validation foundation and operation schemas (see [root AGENTS.md](../../AGENTS.md))

## Purpose

Provides Standard Schema V1-compliant validation primitives (`v.*`) and builds all ORM operation schemas through `SchemaRegistry`.

This layer owns:
- primitive schemas (`v.string`, `v.object`, `v.union`, ...)
- scalar operation schemas (`filter`, `create`, `update`)
- relation operation schemas (`filter`, `create`, `update`, select/include)
- model core schemas (`where`, `create`, `update`, select/include, orderBy)
- operation args schemas (`findMany`, `create`, `upsert`, ...)

Terminology follows the schema layer: a model **field** is the umbrella member
and can be either a **scalar** field or a **relation** field. Use scalar/relation
when discussing operation schema factories for one concrete kind; use field for
model keys, selection fields, FK fields, and mixed scalar+relation operation
inputs.

## Why This Layer Exists

VibORM needed a validation system that:
1. **Carries type information** - for compile-time inference
2. **Is interoperable** - works with Zod, Valibot, ArkType via Standard Schema
3. **Is fast** - both at runtime and for type checking
4. **Has full model graph context** - required for nested relation inputs

The `v.*` primitives solve interop, inference, and runtime validation. `SchemaRegistry` composes those primitives with schema scalar/relation state so query validation has enough context to handle nested creates, includes, and relation filters.

---

## Entry Points

| File | Purpose | Modify When |
|------|---------|-------------|
| `types.ts` | VibSchema, InferInput/Output, SchemaRegistry contract | Rarely |
| `primitives/` | Standard Schema V1 primitives (`v.*`) | Adding a primitive |
| `scalars/` | Scalar-state to scalar operation schemas | Adding scalar operation behavior |
| `relations/` | Relation operation schemas with target-model thunks | Changing nested relation inputs |
| `model/core/` | where/create/update/select/include/orderBy schemas | Changing model-level query inputs |
| `model/args/` | Complete operation arg schemas | Adding/changing ORM operations |
| `builder.ts` | `SchemaRegistry` cache and schema graph builder | Registry contract or lifecycle changes |
| `index.ts` | Public validation exports | Export surface changes |

---

## Core Concepts

### Branded Type Inference

VibORM uses a string literal key for type branding:

```typescript
interface VibSchema<TInput, TOutput> {
  [" vibInferred"]: [TInput, TOutput];  // ← Branded carrier
}

type InferInput<S> = S[" vibInferred"][0];
type InferOutput<S> = S[" vibInferred"][1];
```

**Why string literal, not Symbol:** Unique symbols don't work for type inference across module boundaries. The space prefix prevents collision with real properties.

### Set-Theory Validator Optimization

VibORM pre-computes 8 validators based on bit flags:

```typescript
// Flags: nullable=4, optional=2, array=1
const index = (nullable ? 4 : 0) | (optional ? 2 : 0) | (array ? 1 : 0);
const validator = validators[index];  // O(1) lookup
```

**Why 8 validators:** Instead of runtime `if (nullable) ... if (optional) ...` branching, we pre-compute all combinations. This matters when validating thousands of records.

### Standard Schema V1 Compliance

Every VibSchema implements the standard interface:

```typescript
schema["~standard"] = {
  version: 1,
  vendor: "viborm",
  validate: (value) => ({ value } | { issues: [...] }),
}
```

**Why comply:** Interoperability with other validation libraries. Users can mix VibORM with Zod schemas if needed.

### SchemaRegistry

`SchemaRegistry` is created once per client and caches model schemas by `Model` object:

```typescript
const registry = createSchemaRegistry(schema);
const userCreate = registry.getModelSchemas(user).args.create;
```

**Why:** operation schemas need full model graph context. A relation schema must know the source model, target model, and inverse FK fields to validate nested creates correctly.

---

## Core Rules

### Rule 1: String Literal for Branded Types
Use `" vibInferred"` (with space), NOT `Symbol()`. Symbols break cross-module inference.

### Rule 2: Synchronous Validation Only
Standard Schema V1 is synchronous. Never use async/await in validate functions.

### Rule 3: Generic Primitives Only
No domain-specific logic here. `v.email()` or `v.url()` belong in the scalar layer, not validation.

### Rule 4: Immutable Schemas
Schemas are immutable after creation. No methods that modify the schema in place.

### Rule 5: Operation Schemas Need Registry Context
Do not rebuild operation schemas inside scalar definitions, relation definitions, or models. Use `SchemaRegistry` so relation thunks and inverse FK omission are resolved from the full schema graph.

---

## Anti-Patterns

### Unique Symbol for Branded Types
Using `Symbol("vibInferred")` instead of string literal. Breaks type inference across module boundaries.

### Async Validation
Adding `async` to validate functions. Standard Schema V1 requires synchronous validation only.

### Domain-Specific Primitives
Creating `v.email()` in validation layer. Scalar-specific logic belongs in `src/schema/scalars/`.

### Throwing Exceptions
Throwing errors instead of returning `{issues: [...]}`. Standard Schema uses result objects.

### Mutable Schema State
Modifying schema after creation. Schemas should be immutable once constructed.

### Hoisting Operation Schemas Into Schema Layer
Putting `filter`, `create`, `update`, or model args schemas on scalar/relation/model internals loses source-model context and reintroduces the nested-create bug. Keep base scalar schemas in scalar state; keep operation schemas here.

---

## Two "Validations" in VibORM

**Common confusion:** There are two different validation concepts:

| Aspect | Validation (L1) | Schema Validation (L5) |
|--------|-----------------|------------------------|
| Purpose | Runtime input checking | Definition-time schema correctness |
| Location | `src/validation/` | `src/schema/validation/` |
| When | Query execution | Schema definition |
| Example | "foo" is a valid string | Relation references valid model |

---

## Adding New Primitive (Rare!)

This is rare - the existing primitives cover most cases.

1. **Create `primitives/{type}.ts`**:
   ```typescript
   export function myPrimitive(options?: Opts): VibSchema<In, Out> {
     return createVibSchema({
       type: "mytype",
       validate: (value) => {
         if (!isValid(value)) return { issues: [...] };
         return { value };
       },
     });
   }
   ```

2. **Export from `primitives/v.ts` and `index.ts`**:
   ```typescript
   export const v = {
     string, number, boolean,
     myPrimitive,  // Add here
   };
   ```

3. **Add tests**

## Adding Operation Schema Behavior

| Change | Location |
|--------|----------|
| Scalar filter/create/update behavior | `src/validation/scalars/{type}.ts` |
| Relation nested create/update/filter behavior | `src/validation/relations/` |
| Model where/create/update/select/orderBy behavior | `src/validation/model/core/` |
| Operation args (`findMany`, `create`, etc.) | `src/validation/model/args/` |

Always preserve the registry boundary: operation schemas can read schema scalar/relation state, but schema classes must not import operation schema factories.

---

## Invisible Knowledge

### Why the space in `" vibInferred"`
Prevents collision with any user-defined property while remaining a valid object key. We tried `__vibInferred` but TypeScript's `keyof` would include it in unions.

### Why not Zod
Zod's `.infer` causes slow type checking with complex nested schemas (10+ seconds). Our branded approach is O(1) lookup. Also, Zod doesn't support the State generic pattern we need.

### Why set-theory optimization
Validating 10,000 records means 10,000 function calls. Branching inside each call adds up. Pre-computed validators eliminate runtime conditionals.

---

## Related Layers

| Layer | Relationship |
|-------|--------------|
| **Schema Scalars** ([scalars/AGENTS.md](../schema/scalars/AGENTS.md)) | Store scalar state and base schemas consumed by validation scalars |
| **Schema Relations** ([relation/AGENTS.md](../schema/relation/AGENTS.md)) | Store relation state and thunks consumed by validation relations |
| **Client** ([client/AGENTS.md](../client/AGENTS.md)) | Uses validation model schema types for operation payload inference |
| **Query Engine** | Uses `SchemaRegistry` for input validation |
