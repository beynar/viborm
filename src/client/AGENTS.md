# Client - Type Inference & ORM Interface

**Location:** `src/client/`  
**Layer:** L9 - Client Interface (see [root AGENTS.md](../../AGENTS.md))

## Purpose

Provides fully-typed ORM client interface with zero code generation via type inference from schema definitions and recursive proxy pattern.

## Why This Layer Exists

Most ORMs require code generation (`prisma generate`). VibORM achieves the same type safety through pure TypeScript inference:

```typescript
// No codegen - types inferred at compile time
const users = await orm.user.findMany({
  where: { email: { contains: "@" } },  // ← Fully typed!
  include: { posts: true }               // ← Result includes posts!
});
// users: Array<{ id: string; email: string; posts: Post[] }>
```

This works because:
1. Schema definitions carry type information via State generics
2. Validation schemas have branded types for inference
3. Client uses recursive proxies to intercept calls
4. Result types adapt based on select/include args

---

## Entry Points

| File | Purpose | Lines |
|------|---------|-------|
| `types.ts` | Operation routing, Payload/Result types | ~200 |
| `client.ts` | ORM client with recursive proxies | ~150 |
| `result-types.ts` | InferSelectInclude, result adaptation | ~150 |

---

## Core Concepts

### Recursive Proxy Pattern

Client uses nested proxies for `orm.model.operation(args)`:

```typescript
orm          // Proxy 1: intercepts model name
  .user      // Proxy 2: intercepts operation name  
  .findMany  // Proxy 3: intercepts function call
  (args)     // → executeOperation("user", "findMany", args)
```

**Why proxies:** We can't know all model names at compile time. Proxies let us intercept any property access and route it correctly.

### Type Inference Chain

```
Model schema definition
        ↓
model["~"].schemas.args.findMany  (VibSchema with branded types)
        ↓
InferInput<typeof schema>  (extracts input type)
        ↓
OperationPayload<"findMany", Model>  (args type for this operation)
        ↓
InferSelectInclude<Model, Args>  (result type based on args)
```

### Select/Include Aware Results

Result shape adapts based on query:

```typescript
// No select/include → all scalar fields
await orm.user.findMany({})
// → { id, email, name }[]

// Select → only selected fields
await orm.user.findMany({ select: { email: true } })
// → { email }[]

// Include → scalars + relations
await orm.user.findMany({ include: { posts: true } })
// → { id, email, name, posts: Post[] }[]
```

---

## Core Rules

### Rule 1: Zero Code Generation
Types are inferred at compile time, never generated. If you're thinking about generating .ts files, you're going the wrong direction.

### Rule 2: Natural Type Inference
Never use type assertions (`as`). If you need `as`, something is wrong upstream in schema or validation.

### Rule 3: Complete Operation Routing
Every operation needs entries in BOTH `OperationPayload` (input) AND `OperationResult` (output) types.

### Rule 4: Result Adaptation
Use `InferSelectInclude` to compute result type. Don't return fixed model type when select/include should narrow it.

---

## Anti-Patterns

### Type Assertions
Using `as User[]` on query results. Types should flow naturally. Assertions hide mismatches that become runtime bugs.

### Manual Interface Definitions
Defining `interface User { id: string }` manually. Always use `InferOutput` from schema. Manual types drift from reality.

### Breaking the Inference Chain
Storing intermediate values with explicit types that don't match inferred types. Let TypeScript infer all the way through.

### Incomplete Operation Routing
Adding operation to `OperationPayload` but forgetting `OperationResult`. Both must be updated together.

### Ignoring Select/Include
Returning full model type when user specified `select`. They expect narrowed type, not everything.

---

## Adding New Operation

1. **Add to operation union** (`types.ts`):
   ```typescript
   type Operation = "findMany" | "create" | "myNewOp";
   ```

2. **Add args schema** (`src/schema/model/schemas/args/`):
   ```typescript
   export function getMyNewOpArgs(state: ModelState) { ... }
   ```

3. **Add to OperationPayload** (`types.ts`):
   ```typescript
   type OperationPayload<Op, M> = 
     Op extends "myNewOp" ? InferInput<M["~"]["schemas"]["args"]["myNewOp"]>
     : ...
   ```

4. **Add to OperationResult** (`types.ts`):
   ```typescript
   type OperationResult<Op, M, Args> =
     Op extends "myNewOp" ? MyNewOpResultType<M, Args>
     : ...
   ```

5. **Implement in query engine**

---

## Invisible Knowledge

### Why branded types instead of `schema.infer`
Early versions used Zod-style `.infer`. With complex schemas, TypeScript took 10+ seconds. Branded types with explicit `InferInput<T>` are O(1) lookup.

### Why `" vibInferred"` has a space
The branded type key uses a space prefix to prevent collision with real property names while remaining a valid string key. `Symbol()` was tried but broke cross-module inference.

### Why three proxies
We need to intercept: (1) model name, (2) operation name, (3) the actual call. Each requires its own proxy layer. Fewer proxies would mean hardcoding model/operation lists.

---

## Related Layers

| Layer | Relationship |
|-------|--------------|
| **Schema** ([schema/AGENTS.md](../schema/AGENTS.md)) | Provides model definitions with typed schemas |
| **Validation** ([validation/AGENTS.md](../validation/AGENTS.md)) | Provides branded VibSchema for inference |
| **Query Engine** ([query-engine/AGENTS.md](../query-engine/AGENTS.md)) | Executes queries, returns raw results |
