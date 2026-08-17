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
2. Validation model schemas have branded types for operation inference
3. Client uses recursive proxies to intercept calls
4. Result types adapt based on select/include/omit args

---

## Entry Points

| File | Purpose | Lines |
|------|---------|-------|
| `types.ts` | Operation routing, Payload/Result types | ~230 |
| `client.ts` | ORM client with recursive proxies | ~700 |
| `result-types.ts` | InferSelectInclude, result adaptation | ~375 |

---

## Core Concepts

### Field Taxonomy in Results

Client result fields are model members. Scalar fields are returned by default;
relation fields are returned when requested through `include` or relation
selection. Keep `field` for result keys and select/include keys; use `scalar`
or `relation` only when the result logic is specific to one concrete field kind.

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
Validation model args schema  (VibSchema with branded types)
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

// Query-level omit subtracts after select
await orm.user.findMany({
  select: { id: true, email: true, name: true },
  omit: { name: true },
})
// → { id, email }[]
```

An explicit `select` overrides the client-level omit default, but a query-level
`omit` written beside that select still subtracts from it. The same rule applies
on nested relation nodes and row-returning bulk writes.

---

## Core Rules

### Rule 1: Zero Code Generation
Types are inferred at compile time, never generated. If you're thinking about generating .ts files, you're going the wrong direction.

### Rule 2: Natural Type Inference
Never use type assertions (`as`). If you need `as`, something is wrong upstream in schema or validation.

### Rule 3: Complete Operation Routing
Every operation needs entries in BOTH `OperationPayload` (input) AND `OperationResult` (output) types.

### Rule 4: Result Adaptation
Use `InferSelectInclude` to compute result type. Do not return a fixed model type
when `select`, `include`, or `omit` should change it.

### Rule 5: Keep Nested Client Omit Client-Local
Client-level `omit` reaches nested result types through a minimal, client-only
surface carrier. A model surface contains only its scalar, ordinary-relation,
and polymorphic-relation key sets plus that client's configured omission.

Resolve a unique surface match exactly. When several schema models have the
same surface, widen the candidate omission flags so affected result fields are
optional. Never guess one model identity from an ambiguous structural match.

Do not put client defaults or schema-key brands into `Model`, `ModelState`, or
relation state. Do not compare full model types, inspect relation getters
recursively, or include scalar schema values in the carrier. Those forms reopen
the mutually-recursive `any` collapse and make custom-schema types part of the
completion hot path. A client with no configured omit must take the early
no-carrier path.

### Type-only public client probes

Keep `createClient()` inside an uncalled function when a test only inspects an
inferred return type. Holding many constructed clients in module scope keeps
their schema registries alive for the full Vitest worker and can exhaust the
client layer's memory cap. Runtime contracts should construct and execute a
real client normally.

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

2. **Add args schema** (`src/validation/model/args/`):
   ```typescript
   export function getMyNewOpArgs(state: ModelState) { ... }
   ```

3. **Add to OperationPayload** (`types.ts`):
   ```typescript
   type OperationPayload<Op, M> =
     Op extends "myNewOp" ? ModelOperationInput<M, "myNewOp">
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

## Caching Integration

The client integrates with the cache layer via `$withCache()`:

```typescript
// Basic caching with default TTL (5 minutes)
const users = await orm.$withCache().user.findMany();

// Custom TTL
const posts = await orm.$withCache({ ttl: "1 hour" }).post.findMany();

// Stale-while-revalidate pattern
const data = await orm.$withCache({ 
  ttl: "5 minutes", 
  swr: true           // Returns stale data immediately, revalidates in background
}).user.findMany();

// Custom SWR window
const data = await orm.$withCache({ 
  ttl: "5 minutes", 
  swr: "1 hour"       // Custom stale window instead of default 2x TTL
}).user.findMany();
```

**Cache options:**
- `ttl` - Time to live (number in ms or string like "1 hour")
- `swr` - Enable SWR (boolean or custom TTL)
- `bypass` - Force fresh fetch but still cache result
- `key` - Custom cache key override

**Cache invalidation in mutations:**
```typescript
await orm.user.update({
  where: { id: "1" },
  data: { name: "Alice" },
  cache: { 
    autoInvalidate: true,     // Invalidate all user cache entries
    invalidate: ["user:*"]    // Or specify patterns manually
  }
});
```

**Manual invalidation:**
```typescript
await orm.$invalidate(["user:*", "post:list"]);
```

---

## Transactions

The client supports two transaction modes:

### Callback Mode (Dynamic)

```typescript
const result = await orm.$transaction(async (tx) => {
  const user = await tx.user.create({
    data: { name: "Alice", email: "alice@example.com" }
  });
  
  await tx.post.create({
    data: { title: "First Post", authorId: user.id }
  });
  
  return user;
});
// All operations in single transaction, auto-rollback on error
```

### Batch Mode (Array)

```typescript
const [user, post] = await orm.$transaction([
  orm.user.create({ data: { name: "Bob", email: "bob@example.com" } }),
  orm.post.create({ data: { title: "Hello", authorId: "user-id" } })
]);
// Operations are PendingOperations, executed together in transaction
```

**Transaction options** (Prisma's shape, Prisma's spellings):
```typescript
await orm.$transaction(callback, {
  isolationLevel: "Serializable",  // ReadUncommitted | ReadCommitted | RepeatableRead | Serializable
  timeout: 10_000,                 // ms the callback may run before rollback
  maxWait: 2000,                   // ms to wait for a transaction slot
});

// Array form takes isolationLevel only — no interactive window to bound.
await orm.$transaction([orm.user.findMany()], { isolationLevel: "Serializable" });
```

Every option is honored or refused, never ignored. Each driver declares its
contract in `transactionOptionSupport()`; the resolver in
`src/drivers/shared/transaction-options.ts` turns that into either an executable
plan or a typed refusal — `UnsupportedOperationError` (V8003) for an option this
driver cannot honor, `TransactionError` (V5005) for a malformed options object.
`tests/drivers/transaction-portability.test.ts` pins every driver × option cell.
See [Transactions](../../docs/content/docs/client/transactions.mdx) for the
per-driver table.

---

## Transaction operations

Model operations return `PendingOperation`; raw methods return `RawOperation`.
Both implement the internal transaction-operation protocol and defer execution
until awaited or consumed by `$transaction([...])`:

```typescript
const op = orm.user.findMany();  // Returns PendingOperation (not executed yet)
const users = await op;          // NOW executes

// Enables batch transactions
const [a, b] = await orm.$transaction([
  orm.user.create({ data: {...} }),  // Both are PendingOperations
  orm.post.create({ data: {...} })   // Executed together when array is awaited
]);
```

Raw and model operations can share the same array transaction. Raw operations
remain structurally compatible with `Promise<T>`, but ordinary promises are not
transaction operations and remain invalid array members. Client and scope IDs
are checked for both implementations before dispatch.

---

## Related Layers

| Layer | Relationship |
|-------|--------------|
| **Schema** ([schema/AGENTS.md](../schema/AGENTS.md)) | Provides model definitions and structural state |
| **Validation** ([validation/AGENTS.md](../validation/AGENTS.md)) | Provides branded operation schemas and `SchemaRegistry` |
| **Query Engine** ([query-engine/AGENTS.md](../query-engine/AGENTS.md)) | Executes queries, returns raw results |
| **Cache** ([cache/AGENTS.md](../cache/AGENTS.md)) | Provides caching layer for `$withCache()` |
