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
| `schema-introspection.ts` | Public payload-schema access, validation, and TypeScript rendering boundaries | ~200 |
| `typescript-type-renderer.ts` | Runtime model/result metadata to TypeScript source | ~450 |

---

## Core Concepts

### Field Taxonomy in Results

Client result fields are model members. Scalar fields are returned by default;
relation fields are returned when requested through `include` or relation
selection. Keep `field` for result keys and select/include keys; use `scalar`
or `relation` only when the result logic is specific to one concrete field kind.

Fixed-decimal fields accept public `Decimal | string | number` input after the
schema descriptor has fixed their precision and scale. They return a fresh
public `Decimal` at every selected field or aggregate leaf, including nested
results and cache hits. They never return canonical transport text or a
JavaScript number. Decimal lists preserve that same logical element surface.
Use `Decimal#eq()` in value assertions. Results use the one constructor exported
from `viborm`, but semantic decimal equality is still a value comparison rather
than JavaScript object identity or a test framework's structural comparison.

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

An explicit `select` overrides the `defaultOmit()` client default, but a query-level
`omit` written beside that select still subtracts from it. The same rule applies
on nested relation nodes and row-returning bulk writes.

### Schema and operation introspection

The package root and `viborm/client` expose four schema-bound utilities:

- `getOperationPayloadSchema(schema, model, operation)` returns the canonical
  Standard Schema for that public operation, including `OrThrow` alias routing;
- `validateOperationPayload(schema, model, operation, payload)` delegates to
  `SchemaRegistry` and returns the normalized operation-schema output;
- `renderOperationResultType(schema, model, operation, payload)` validates one
  concrete payload, then renders the result from `buildExpectedResultShape`;
- `renderSchemaType(schema)` renders the complete model graph as one recursive
  `VibORMSchema` declaration.

These are schema-only views. They do not apply request extensions, client-level
`defaultOmit()`, cache options, driver capability checks, or deferred upsert-arm
execution. A custom JSON scalar renders as `unknown`: Standard Schema carries
its output only in a TypeScript generic, which does not exist at runtime. Do not
replace that honest boundary with JSON Schema or the TypeScript compiler.
`exist` validates only its optional `where` clause. An empty `count.select`
keeps the scalar `number` result used by execution.

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
surface carrier. A model surface contains only its scalar key set and its ONE
relation key set — a model has one canonical relation map, whatever target
domain each slot names — plus that client's configured omission.

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

`ExtendedClient<Base, Extensions>` is the one public type-only reducer for
naming an immutable extension chain across modules. `Extensions` is a finite
readonly tuple in application order. Its implementation delegates every step
to the same extension admission, client-config, and accumulated-state types as
`$extends()`; do not add a second public extension-state description or a
runtime "apply all" owner. Statically invalid ordering and repeated official
cache/default-omit capabilities resolve to `never`; name and instrumentation
collisions remain runtime-owned.

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

## Extension ownership

`$extends()` creates an immutable derived client carrying a frozen compiled
chain. The public extension language has exactly six capabilities: `request`,
`query`, `statement`, `observe`, `client`, and `model`. Do not add another hook
registry, priority system, public operation token, or deferred-operation type.

`src/extensions/` owns the one normalized definition boundary, immutable chain,
method binding, and one runner per execution capability. A resolved chain keeps
only compiled execution handlers plus the client/model factories that must run
for each concrete view; it never retains a second full extension definition.
`array-admission.ts` owns only the extension query-admission latch. This client
layer still owns candidate authority, request triggering, substrate selection,
provider dispatch, parsing, result order, and commit publication.

| Generic owner | Responsibility |
|---|---|
| `src/extensions/definition.ts` | Public envelope, `defineExtension()`, exact top-level guard, hostile-definition normalization |
| `src/extensions/chain.ts` | The single frozen resolved chain, composition, official capability attachment, compiled handler lookup |
| `src/extensions/methods.ts` | Client/model factory types, collisions, state merging, and concrete-view binding |
| `src/extensions/request.ts` | Synchronous request-transform contract and runner |
| `src/extensions/query.ts` | Query interception, authoritative continuation, and write-outcome rail |
| `src/extensions/statement.ts` | Trusted `Sql` transformation contract and runner |
| `src/extensions/observation.ts` | Public/protected lifecycle units, completion onion, and contained observer runner |
| `src/extensions/array-admission.ts` | Extension-only native/fallback admission latch; never core array dispatch |
| `src/extensions/index.ts` | Intentional public/internal extension exports |

Official implementations stay at `src/cache/extension.ts`,
`src/instrumentation/extension.ts`, and
`src/client/default-omit-extension.ts`. Do not recreate a generic extension
representation or runner in `src/client/`, `src/query-engine/`, or
`src/drivers/`.

- Request transforms run lazily before default omit and core validation.
- Query interceptors run around one prepared logical operation. Once
  `proceed()` starts, its result/error is authoritative.
- Statement transforms run once per materialized typed `Sql`, after statement
  observation and before rendering. Verbatim unsafe raw is excluded.
- Observers see only frozen public lifecycle/completion facts; their returned
  promise never controls the application.
- Client/model factories add typed methods to the derived scope.

The default-omit extension can follow request, statement, observe, a global
polymorphic query function, and official cache/instrumentation. It cannot follow
a schema-mapped query or client/model factory whose result types were fixed
before omission.

## Caching integration

Only an exact client derived with `cache({ driver, version?, waitUntil? })` has
`$withCache()` and `$invalidate()`:

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

Cache options:

- `ttl` - Time to live (number in ms or string like "1 hour")
- `swr` - Enable SWR (boolean or custom TTL)
- `bypass` - Force fresh fetch but still cache result
- `key` - Suffix contribution to the canonical validated-operation key

Mutation invalidation:
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

Manual invalidation:
```typescript
await orm.$invalidate("user:*", "post:list");
```

The official cache snapshots the parsed core value before query post-work and
materializes a fresh detached graph on every hit. It bypasses callback and array
transactions, raw calls, and statement-transform chains. Mutation invalidation
uses the ordered write-outcome rail at the exact commit/savepoint boundary.

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
`tests/contracts/drivers/transaction-portability.core.test.ts` pins every
driver × option cell.
See [Transactions](../../docs/content/docs/client/transactions.mdx) for the
per-driver table.

---

## Transaction operations

Model operations return `PendingOperation`; raw methods return `RawOperation`.
Both register private WeakMap-backed array authority and defer execution
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
are read from unshadowable class-private state and checked for both
implementations before dispatch. No transaction capability property is exposed
on the public object or prototype.

### Shared batch result ownership

Trust each driver-normalized `QueryResult`. A single-statement batch member
consumes the exact result at its index. The shared batch validates normalization
and cardinality once against its full query list; a multi-statement member then
trusts and consumes its exact result slice. Pass every original `QueryResult`,
including `insertId`, to its consumer; never rewrap it or strip its fields.

`array-transaction-native-batch.ts` is the single owner of provider dispatch
attribution, normalized batch cardinality, and native-batch transaction errors.
The legacy, observe-only, and intercepted shells keep their preparation and
result-window loops local: extracting those measured hot loops adds per-member
CPU and per-array allocation. Keep the unextended legacy shell monomorphic and
free of extension slots, outcome collectors, and async helper frames.

## Coverage Gate

`pnpm test:coverage:client` is the exact client-subsystem report. It requires
98% statements, branches, functions, and lines and writes
`coverage/client/index.html`. `scripts/client-test-manifest.mjs` admits every
flat public-client core contract and only audited extended contracts that do not
connect or own provider resources. Provider execution remains in the extended
and provider projects.

---

## Related Layers

| Layer | Relationship |
|-------|--------------|
| **Schema** ([schema/AGENTS.md](../schema/AGENTS.md)) | Provides model definitions and structural state |
| **Validation** ([validation/AGENTS.md](../validation/AGENTS.md)) | Provides branded operation schemas and `SchemaRegistry` |
| **Query Engine** ([query-engine/AGENTS.md](../query-engine/AGENTS.md)) | Executes queries, returns raw results |
| **Cache** ([cache/AGENTS.md](../cache/AGENTS.md)) | Provides caching layer for `$withCache()` |
