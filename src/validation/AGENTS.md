# Validation - Standard Schema V1 Primitives

**Location:** `src/validation/`  
**Layer:** L1 - Foundation (see [root AGENTS.md](../../AGENTS.md))

## Purpose

Provides Standard Schema V1-compliant validation primitives (v.*) that serve as the foundation for all schema validation. **Modify this layer rarely!**

## Why This Layer Exists

VibORM needed a validation system that:
1. **Carries type information** - for compile-time inference
2. **Is interoperable** - works with Zod, Valibot, ArkType via Standard Schema
3. **Is fast** - both at runtime and for type checking

The `v.*` primitives solve all three. They implement Standard Schema V1 (interop), use branded types (inference), and use set-theory optimization (performance).

---

## Entry Points

| File | Purpose | Modify When |
|------|---------|-------------|
| `types.ts` | VibSchema interface, InferInput/Output | Rarely |
| `helpers.ts` | Set-theory validator factories | Rarely |
| `schemas/*.ts` | Primitive implementations | Adding new primitive |
| `index.ts` | Public `v` export | Adding new primitive |

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

---

## Core Rules

### Rule 1: String Literal for Branded Types
Use `" vibInferred"` (with space), NOT `Symbol()`. Symbols break cross-module inference.

### Rule 2: Synchronous Validation Only
Standard Schema V1 is synchronous. Never use async/await in validate functions.

### Rule 3: Generic Primitives Only
No domain-specific logic here. `v.email()` or `v.url()` belong in field layer, not validation.

### Rule 4: Immutable Schemas
Schemas are immutable after creation. No methods that modify the schema in place.

---

## Anti-Patterns

### Unique Symbol for Branded Types
Using `Symbol("vibInferred")` instead of string literal. Breaks type inference across module boundaries.

### Async Validation
Adding `async` to validate functions. Standard Schema V1 requires synchronous validation only.

### Domain-Specific Primitives
Creating `v.email()` in validation layer. Field-specific logic belongs in `src/schema/fields/`.

### Throwing Exceptions
Throwing errors instead of returning `{issues: [...]}`. Standard Schema uses result objects.

### Mutable Schema State
Modifying schema after creation. Schemas should be immutable once constructed.

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

1. **Create `schemas/{type}.ts`**:
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

2. **Export from `index.ts`**:
   ```typescript
   export const v = {
     string, number, boolean,
     myPrimitive,  // Add here
   };
   ```

3. **Add tests**

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
| **Schema Fields** ([fields/AGENTS.md](../schema/fields/AGENTS.md)) | Uses v.* primitives in field schemas |
| **Client** ([client/AGENTS.md](../client/AGENTS.md)) | Uses InferInput/InferOutput for types |
| **Query Engine** | Uses schemas for input validation |
