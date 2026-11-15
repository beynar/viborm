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
| `schema-links.ts` | Declaration-only flat schema, literal relation links and linked client view | — |
| `schema-introspection.ts` | Public payload-schema access, validation, and TypeScript rendering boundaries | ~200 |
| `typescript-type-renderer.ts` | Runtime model/result metadata to TypeScript source | ~450 |

---

## Core Concepts

### Field Taxonomy in Results

Client result fields are model members. Scalar fields are returned by default;
relation fields are returned when requested through `include` or relation
selection. Keep `field` for result keys and select/include keys; use `scalar`
or `relation` only when the result logic is specific to one concrete field kind.

Fixed-decimal fields accept public `Decimal | string` input after the
schema descriptor has fixed their precision and scale. They return a fresh
public `Decimal` at every selected field or aggregate leaf, including nested
results and cache hits. They never return canonical transport text or a
JavaScript number. Decimal lists preserve that same logical element surface.
Use `Decimal#eq()` in value assertions. Results use the one constructor exported
from `viborm` — VibORM's own `Decimal`, whose 18-member prototype is the whole
public value surface — but semantic decimal equality is still a value
comparison rather than JavaScript object identity or a test framework's
structural comparison. An instance carries NO own property, so a structural
comparison of two of them compares nothing.

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

### Exported cyclic clients

`schema-links.ts` owns the declaration-only schema-key link carrier.
`RelationLinks<S>` resolves relation getters against the exact producer schema;
`FlatSchema<S,L>` materializes the model state while erasing linked target
getters. `Linked<S,L,K>` restores getters through literal schema keys and a
named flat state, allowing recursive type instantiations to reuse that state.
The optional `Links<L>` property is type-only: never install it on runtime
configs, models or relations.

Every per-model client and extension value type reads `ClientSchema<C>`.
Guards that need only model names read `keyof C["schema"]` without constructing
linked models. Scalar-only and open schemas keep their original model state
with `Links<never>` because they have no finite recursive graph to flatten.
`LinkedClientConfig<C,L>` preserves other config facts. Keep schema/config maps
homomorphic: conditions belong inside their values so generic client annotations
and driver covariance retain the original key relationships. Public factories
materialize that config with an anonymous mapped return type; returning the
named helper directly makes the emitter retain its original recursive argument.
Export clients or client
factories from declaration-producing packages without caller annotations.
Plain emitted cyclic models can still contain compiler elisions; a downstream
client cannot recover facts already lost from those model declarations.

Exact structural model comparison resolves declaration links once. It does not
replace the separate shallow omission carrier, whose ambiguity and early
no-omit rules remain unchanged. Keep relation getters unconstrained and flatten
both `shape` and `relations`; helper aliases taking original recursive state
would reintroduce the emitted graph. Export the type names required by inferred
declarations, including nominal extension capability interfaces; their unique
symbol keys remain private and have no runtime representation.

`NoExtraOperationKeys` keys what the caller SPELLED, walking the literal and
never the payload. `NestedClauseGuard` checks WHERE model-field names through
relation and logical filters, and nested write data (create, createMany.data,
connectOrCreate.create, upsert, update/updateMany data) against each target's
fields; declared model fields shadow `AND`, `OR` and `NOT`, matching
`WhereSchema`. `RecursiveProjectionRootGuard` keys a nested `select` (fields), `include`
(relations) and `where` at the key. `OperatorBagGuard` seals root WHERE operator
bags. `GroupByOrderGuard` keeps groupBy `orderBy` inside `by` and the aggregates.
The WHERE walk descends every key of a finite value, optional ones included (a
held filter, a conditional spread), and stops at a `where` object whose type
states every key of its model's WHERE: that is the payload under any spelling,
and only its required keys are walked; an `any` value is not walked. Write
data descends required keys only.
Projection seals refuse unknown keys as `?: undefined`, the type of the refused
member a held node's recursive arm carries. A guard that inspects a type
parameter refuses it, so projection and operator guards keep each leaf's own arm
in a union, and generic leaves stay assignable. Cycle detection uses the exact
caller-value/model pair, never a numeric depth cap. Not claimed: operator bags
below the root WHERE, selectors, relation-verb keys, variant arms, cursor/having.

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

`InferDatabase<S>` from `viborm/client` maps each schema key to `Row`, `Create`,
`Update`, `Where`, and `FindMany`. It composes `OperationResult`,
`ModelCoreInput`, and `OperationPayload`; it owns no second inference rules.
`Row` is the default scalar projection, including schema-level omission, not
a relation-expanded result or a concrete client's extension/default-omit view.

The package root and `viborm/client` expose four schema-bound utilities:

- `getOperationPayloadSchema(schema, model, operation)` returns the canonical
  Standard Schema for that public operation, including `OrThrow` alias routing;
- `validateOperationPayload(schema, model, operation, payload)` delegates to
  `SchemaRegistry` and returns the normalized operation-schema output;
- `renderOperationResultType(schema, model, operation, payload)` validates one
  concrete payload, then renders the result from `buildExpectedResultShape` (a
  recursive relation slot renders as named declarations; see the function's
  JSDoc);
- `renderSchemaType(schema)` renders the complete model graph as one recursive
  `VibORMSchema` declaration.

These are schema-only views. They do not apply extensions, client-level
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
relation state. In the omission carrier, do not compare full model types,
inspect relation getters recursively, or include scalar schema values. Those forms reopen
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
runtime "apply all" owner. `ExtendedClient` takes object-definition tuples;
name a factory's result with `typeof derived`. Statically invalid ordering and
repeated official cache/default-omit capabilities resolve to `never`; name and instrumentation
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

`$extends()` takes one extension value, `extension(name, ...parts)`
(`src/extensions/extension.ts`), and returns an immutable derived client
carrying the resolved chain. Root Rule 6 is the contract: the parts `call`,
`around`, `unit`, `args`, `rule`, `defaults`, `methods`, `fields` and
`disclosure`, and the words that carry the rest. `$extends()` has no other
signature: no object literal, no client factory, no two-step official form.
Do not add another hook registry, priority system, public operation token,
or deferred-operation type.

`ClientTypeState<C, X>` carries inference metadata under a private optional
symbol, so a part can be typed against the client `$extends` is called on
(and `parts<Of>()` can bind a client type) without reverse-inferencing the
entire client surface. Its opaque object alternative preserves structural
client assignability; it is not runtime provenance or an authorization
boundary. The public result helpers require the symbol key and check the
complete client surface before publishing results, so metadata alone cannot
promise methods that the client does not have.

`src/extensions/` owns the chain (`chain.ts`, the one mechanism, which names
no part and no official extension) and every part's code; each part writes
its own state on the chain and that state carries the code that runs it.
This client layer asks the chain (`chain.args.admit`,
`chain.watch.watch`, `chain.observation.run`, …) and imports no builder,
so a client that applies no extension carries none of their code (646 bytes
of `src/extensions` in the PostgreSQL application, measured with
`node scripts/extension-bytes.mjs` on `d26773ec0`:
`transact` and `scopeOf`, how every transaction scope runs, which replaced
the rail branches the client and the array executor held;
`isAppliedExtension`; the `SCOPE` symbol). A part is trusted code made by the builders: there
is no hostile-part read. Call-time admission of an
argument's value stays, as user input (`arguments.ts`): a value its
declaration refuses, a `required` argument the call left out, a `bound` one
a call passes. This client layer still owns candidate authority, request
triggering, substrate selection, provider dispatch, parsing, result order,
and commit publication.

| Owner | Responsibility |
|---|---|
| `src/extensions/extension.ts` | `extension(name, ...parts)` (each part an `ExtensionPart` that joins the chain with its own state), `isAppliedExtension` |
| `src/extensions/chain.ts`, `chain-state.ts` | The one mechanism: each part's phases (`declare`, `join`, `seal`), what two parts of one extension meet through (`Application`: `owner`, `bring`, `shared`), and the resolved chain every part writes on |
| `src/extensions/call.ts`, `call-words.ts`, `targeted.ts`, `request.ts`, `watch-part.ts`, `written.ts` | `call` and `around`, their first and second moments, `inner`; `watch`, `settled`, `again`, `via`; what tells a watch of the rows a write wrote |
| `src/extensions/arguments.ts`, `args.ts` | `args`, `oneOf`, `accepts`, `bound` and the modifiers; placement per (model, operation) and the one admission of a call's arguments |
| `src/extensions/rule.ts`, `rule-words.ts`, `judge-words.ts`, `confine.ts`, `admission.ts`, `call-rows.ts`, `call-values.ts`, `rows.ts`, `row-domain.ts`, `layers.ts`, `entries.ts`, `judge.ts`, `produced.ts`, `projection.ts`, `projected.ts`, `gates.ts`, `kept.ts`, `reads.ts` | `rule` and its words; each entry admitted once per schema, bound once per application; what a call's values are to the rules that read them, brought by the words that read a call (`call-values.ts`); what `only`, `check`, `gate`, `facts`, `keep`, `lazy` and `within` bring |
| `src/extensions/defaults.ts`, `order.ts`, `stamps.ts`, `plain-domain.ts` | `defaults` and `omitted`: default order, default data, default omission, without the filter domain |
| `src/query-engine/raptor3/commands/commands.ts` (`Commands.stamp`) | The engine side of default data: one owner admits a model's stamp per occurrence and attempt and puts it under the occurrence: a field the caller writes, by name or through the relation holding it, stays the caller's; every create and update site calls it (see `src/query-engine/raptor3/AGENTS.md`) |
| `src/extensions/methods-part.ts`, `methods.ts` | `methods(factory)` (client methods) and `modelMethods(factory)` (model methods): one factory per view (eager on the client `$extends` returns, lazy elsewhere), collisions, `scope.$bind`; on a chain that declares create data, the model delegate's five narrowed writes (`ExtensionModelDelegate`) |
| `src/extensions/fields.ts`, `result.ts`, `result-types.ts` | `fields` (computed fields): the per-call plan (needs read, computed names removed from `select`/`omit`) made after default omit, and the finish that copies each row and attaches each field as a lazy memoized getter; applied once per operation by `PendingOperation` and once per member by `executeArrayTransaction` |
| `src/extensions/unit.ts`, `unit-words.ts`, `unit-source.ts`, `observation.ts`, `statement.ts` | `unit`, its words and `work`; the one generation of unit handlers; rewriting units |
| `src/extensions/query.ts`, `coordination.ts`, `array-admission.ts`, `settled.ts` | The authoritative continuation; `transact`, how every transaction scope runs: what a call registers waits in its scope, whose collector the first registration installs by value (`collect`: `settled`, the part that watches writes, `unit` parts), so a transaction where nothing registers runs none of it; the `admit` hook that starts array members' handlers before anything is sent, never core array dispatch |
| `src/extensions/key.ts`, `codec.ts`, `database.ts`, `origin.ts` | `key`, `codec`, `database`; the symbols by which a word finds its call, run or scope |
| `src/extensions/disclosure.ts`, `disclosed.ts` | `disclosure`: what an error thrown by a call of the chain may carry; `disclosed`: the copy of a failure a log or a span may show |
| `src/extensions/on.ts`, `parts.ts`, `contract.ts`, `index.ts` | `target` and the operation sets; `parts<Of>()`; the vocabulary's types; the intentional surface |

The result context a delegate reads (`ClientDefaults`) has one owner per
fact: the config's relation omission (`ClientRelationOmitContext`) and, on a
chain whose rules can hide a model's rows (`read.where`, `root`, `related`
or a `lazy` entry: `RuleFacts` in `contract.ts`), the shallow surfaces of
those models (`ClientRowsContext`, `types.ts`, from the extension state's
`rows` slot,
filled by `RuleFacts` in `contract.ts`). `result-types.ts` alone turns that
into `| null` on a singular slot whose target a relation read can find hidden
(`HiddenTargetNull`): the model delegates, `$withCache()`, the transaction
client, `ExtendedOperationResult` and a typed `around`'s `run()`
(`CallResult`, `contract.ts`) read the same
context through `ContextualOperationResult`. `OperationResult`,
`InferDatabase` and `renderOperationResultType` are schema-only and say so.

The payloads have one owner for what an extension's `data` writes on
create: the extension state's `data` slot (`StampedFields` per model, filled
by `DefaultsFacts` in `contract.ts` from each entry's `create` fields; an
update's fields are optional already, so `update` adds nothing). On a chain
whose slot is not empty, `ExtensionModelDelegate` (`src/extensions/methods.ts`)
swaps a model's five write operations for `StampedOperations` (`types.ts`),
whose payload (`StampedPayload`) rebuilds the call's create rows:
`StampedRow` makes each field written there optional with its own type, so a
field the schema requires may be left out (owner ruling, plan v4 §7.5; the
runtime counts such a field as given, T1) and a value passed is the caller's,
which the runtime keeps over the stamp (owner ruling 2026-10-02, plan v4
§7.1). The relation that holds such a field keeps its own input. The same
row type follows the model's relations, through update rows too, into nested
creates (`StampedRelation`, `StampedVerb`, `StampedArms`), finding a target's
fields by its shallow surface; a relation with variants is not rebuilt.
Mapped types resolve a member only when it is read, so a call pays for the
depth it spells. Keep the payload level a plain mapped type: a conditional
there was measured at +14k instantiations on client-2, on programs that
declare no `data`. A definition whose model names are lost
(`{ [model: string]: ... }`, a recipe called with a plain `string[]`) adds
nothing to the slot: the types cannot say which models it writes, so a
required field stays required. The guide's recipes keep their names (`const`
type parameter). A chain without create `data` the types can name keeps
`Client` exactly; `Client` itself takes no `data` parameter (as one, it cost
the instrumentation type program +14% types and +26% instantiations,
measured at U3). `OperationPayload` stays the schema-only payload, so what
reads it (a typed `around`'s `run.input`, for one) is not narrowed: a required
stamped field is asked for there, and the runtime accepts it left out.

Official implementations stay at `src/cache/extension.ts`,
`src/instrumentation/extension.ts`, `src/client/default-omit-extension.ts`,
`src/soft-delete/index.ts`, `src/permissions/`, `src/on/index.ts` and
`src/ordering/`, each an ordinary `extension(…)` of public parts, importing
public names only, all seven (root Rule 6). Do not
recreate a generic extension representation or runner in `src/client/`,
`src/query-engine/`, or `src/drivers/`.

- First moments (`call`, `around`) run lazily, in chain order, before
  default omit and core validation, after the chain's arguments are taken
  out of the call's.
- An `around`'s second moment runs around one prepared logical operation.
  Once `run()` starts, its result or error is authoritative.
- Rewriting units run once per logical `Sql`, before rendering. Verbatim
  unsafe raw is excluded.
- Unit handlers run around real units; core awaits them, and what they throw
  fails the call.
- `methods` and `modelMethods` add typed client and model methods to the
  derived scope.

`defaultOmit()` (and a `rule` that hides rows) may follow any extension at
runtime: a method runs through the whole chain it is called on. TypeScript
refuses it after a part that declares the `consumer` fact (an `around` that
names one model and one operation, a `methods` or `modelMethods` factory
that takes `scope`),
whose result types were fixed before omission; a factory taking nothing
types its methods' results from their delegate (`DelegateOperationResult`).

## Caching integration

Cached views retain declared row-evidence projections, including their exact
permission names and relation targets, through type-only metadata owned by
`projected-types.ts`. Their methods reuse the same projection argument/result
types with a Promise carrier. They expose only cacheable reads: extension model
methods, mutations, and batchable `PendingOperation` carriers do not propagate.

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

`array-transaction.ts` is the one executor of `$transaction([...])` and the
single owner of provider dispatch attribution, normalized batch cardinality,
and native-batch transaction errors. A member gets a slot (its child, its
handlers' promise) only where the chain may intercept it (`coordination.admit`)
or observes a native batch's units; then its unit is entered, its arguments
admitted and its handlers started before anything is sent. The plain path
allocates no slot, deferred result, outcome collector or admission callback,
and the chain's hooks are optional calls on its state, so an application
without extension carries the executor and nothing of the `around` parts.

## Coverage Gate

`pnpm test:coverage:client` is the exact client-subsystem report. Its enforced
floors are 96% statements, 94% branches, 96% functions and 96% lines, and it
writes `coverage/client/index.html`.

Those floors are an APPROVED EXCEPTION with recorded evidence, not a silent
shortfall from 100 and not some lane-wide 98. The residual is capped by
unreachable defensive code rather than by missing tests: it is dominated by
`default:` arms over closed unions and by functions with no public caller,
and each was verified against its upstream invariant.
`scripts/coverage-policy.mjs` holds that reasoning and enforces the floors, and
`scripts/merge-coverage.mjs` prints every measured metric beside the floor it
enforces. Each floor is a ratchet: a real regression still fails.

`scripts/client-test-manifest.mjs` admits every flat public-client core contract
and only audited extended contracts that do not connect or own provider
resources. Provider execution remains in the extended and provider projects.

`pnpm test:layer:client` is the fast gate, and it is the one layer command with a
45-second wall budget rather than 30. The client compile-only estate cannot be a
single tsc program at the 1280 MB shard heap, so `scripts/run-layer-core.mjs`
chunks it into three, and three tsc startups plus the runtime stage do not fit in
30 seconds. The exception buys wall time only: the 768 / 1280 / 1536 MiB memory
contract is unchanged, which is exactly why time was the lever. Trim the estate
back under two programs and this returns to 30.

---

## Related Layers

| Layer | Relationship |
|-------|--------------|
| **Schema** ([schema/AGENTS.md](../schema/AGENTS.md)) | Provides model definitions and structural state |
| **Validation** ([validation/AGENTS.md](../validation/AGENTS.md)) | Provides branded operation schemas and `SchemaRegistry` |
| **Query Engine** ([query-engine/AGENTS.md](../query-engine/AGENTS.md)) | Executes queries, returns raw results |
| **Cache** ([cache/AGENTS.md](../cache/AGENTS.md)) | Provides caching layer for `$withCache()` |
