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
| `relations/nested-data-projection.ts` | Which target schema a nested payload writes into, per edge | Changing what a nesting context omits |
| `relations/to-one-mutation-schema.ts` | The to-one composition lattice and its `exactlyOne` mode | Changing accepted operation combinations |
| `model/core/` | where/create/update/select/include/orderBy schemas | Changing model-level query inputs |
| `model/args/` | Complete operation arg schemas | Adding/changing ORM operations |
| `builder.ts` | `SchemaRegistry` cache and schema graph builder | Registry contract or lifecycle changes |
| `value-guards.ts` | Shared representation guards for unknown boundary values | Reusing an identical cross-layer narrowing rule |
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

### Pay-Per-Use Schema Materialization

Registry schemas stay lazy through the scalar-variant boundary. Reading a
scalar `filter` must not construct its `create` or `update` schema. Build the
four scalar records with `lazyScalarSchemas`; it uses shared accessor functions
and releases each factory after that variant resolves. General lazy records and
`v.lazy`/`v.lazyRef` also release a successful factory while retaining the
resolved value.

### Nested Relation Data Projection

A nested payload never writes into the target model's own `core.create` /
`core.update`. It writes into the projection of those schemas the ENCLOSING relation
leaves for the caller, and which columns that removes depends on the edge: an
ordinary inverse owns the target's foreign-key SCALARS, a polymorphic inverse owns
the target's direct RELATION KEY. `relations/nested-data-projection.ts` is the one
place that difference is decided — create, update, createMany-data, the createMany
"satisfied membership" argument and both `upsert.update` contexts, at runtime and
at the type level together. One update-root exception is explicit data in that
projection: a to-many selected `upsert.update` may re-enter a polymorphic inverse's
direct relation key because selected-row continuity already owns the exact parent
target. Ordinary update/updateMany, the create arm, and every create-root surface
still omit that key.

Whether that membership can be CLEARED is NOT this module's fact. It is a schema
fact about storage, owned by `@schema/relation/clearability` (`slotMayBeEmpty` and
`membershipCanBeCleared`, the two facts that must stay two), and it is read only by
the update factories — the create surfaces have no removal verb to gate.

The four verb factories (`toOne`/`toMany` × `create`/`update`) consume the projection
without asking which edge they are on. A polymorphic inverse therefore has no verb
surface of its own; it is the same factory with a different projection.

Two invariants live here rather than in the factories:

- **Laziness is a non-termination hazard.** The projection resolves `state.getter()`
  (schema-layer state, cheap) but returns THUNKS for every schema. Call it from
  inside a verb factory — each is reached through `v.lazy` — never from
  `getRelationSchemas`. Resolving a target model's schemas while the enclosing
  model's are still under construction never terminates for a self-referential
  relation, and the pin is `polymorphic.core.test.ts` "inverse topology stays lazy
  until create validation", which counts ZERO getter calls after `core.create` is
  merely read.
- **The create-root `upsert.update` asymmetry is data, not a decision.** An ordinary
  edge keeps the target's BARE `core.update` there because the engine absorbs an
  agreeing owned foreign key (E5-U2); a polymorphic membership has no spellable
  column to agree with and keeps the projection. The factory reads whichever the
  projection carries; flipping either direction is a defect.
- **The update-root selected `upsert.update` exception is equally data.** An
  ordinary inverse keeps its owned-FK omission. A polymorphic inverse exposes the
  target's full update only for this found arm; its selected-parent continuity is
  what makes the direct relation-key re-entry well-defined. Do not widen ordinary
  nested update or create-root upsert with it.

### To-One Composition Modes

`relations/to-one-mutation-schema.ts` owns which COMBINATIONS of active operations a
to-one payload may carry, at both levels, and publishes exactly two rules:

- `lattice` (default) — the accepted set: at most one intent, or one of the ordered
  vacate/supply/modify compositions, gated by the relation DIRECTION;
- `exactlyOne` — no empty payload and no composition. Used by the direct polymorphic
  edge, whose payload writes one atomic `(type, id)` pair and whose engine resolver
  takes one intent per payload, so an empty payload names no target for a membership
  that may be required and two intents would silently drop one.

Active means `value !== undefined && value !== false` in both modes, and the ACTIVE
LIST is built by iterating `Object.keys(entries)` — so the declaration order of every
entries record is baked into the refusal sentences. Do not reorder one.

---

## Core Rules

### Rule 1: String Literal for Branded Types
Use `" vibInferred"` (with space), NOT `Symbol()`. Symbols break cross-module inference.

### Rule 2: Synchronous Validation Only
Standard Schema V1 permits synchronous or asynchronous validators. VibORM
schemas deliberately implement only the synchronous form. Never use
async/await in their validate functions.

External Standard Schema implementations are untrusted at the registry or
composition boundary. Convert their thrown failures and promises there. A
validated VibORM schema is trusted downstream; do not add a second shape or
async check inside object, relation, or operation-schema consumers.

### Rule 3: Generic Primitives Only
No domain-specific logic here. `v.email()` or `v.url()` belong in the scalar layer, not validation.

### Rule 4: Immutable Schemas
Schemas are immutable after creation. No methods that modify the schema in place.

A schema that WRAPS another schema builds its validator **inside its factory**,
before the wrapper object exists, and composes it into a fresh `~standard`
literal. Never construct the inner schema and then redefine a property on it.
The reason is capture, not style: `v.union` reads each option's
`~standard.validate` AT CONSTRUCTION (`primitives/union.ts`) and holds that
function reference for the life of the union. A validator patched onto a schema
after that schema was handed to a union is a validator the union still has the
un-patched version of — the wrapper's extra rule silently does not run on that
path, and nothing about the wrapper looks wrong. Assume any composer may capture;
only building in the factory makes the question moot.

A wrapper's JSON-Schema converter **delegates to the schema it wraps** rather
than rebuilding one. Reach it through a getter so it stays lazy: rebuilding it
eagerly walks a self-referential relation graph at construction time, which is
what the pay-per-use boundary above exists to avoid. If the wrapper's own rule
is not expressible in JSON Schema, say so at the getter — a converter that
silently drops a rule is worse than one that documents the gap.

### Rule 5: Operation Schemas Need Registry Context
Do not rebuild operation schemas inside scalar definitions, relation definitions, or models. Use `SchemaRegistry` so relation thunks and inverse FK omission are resolved from the full schema graph.

### Rule 6: One Owner for Shared Representation Guards
`value-guards.ts` owns shared identity predicates: `isRecord`, `isString`,
`isFunction`, `isNumber`, `isBoolean`, `isBigInt`, and `isDate`. Import them
instead of defining the same representation check in another module. Do not use
them when the boundary needs stronger semantics such as a plain prototype,
finite/integer values, promise-like behavior, safe reads from hostile values,
or recursive JSON validation. Native array identity remains `Array.isArray`.

### Rule 7: One Typed Validation Error Surface
`ValidationError.source` identifies the boundary that refused the value:
`operation`, `registry`, `schema-builder`, or `json-schema`. Operation failures
use V4001 and Prisma P2009. All other runtime-validation sources use V4002 and
have no Prisma equivalent. Primitive schemas return issues. Registry and public
conversion boundaries translate unexpected throws; no raw `Error` leaves this
directory.

---

## Anti-Patterns

### Unique Symbol for Branded Types
Using `Symbol("vibInferred")` instead of string literal. Breaks type inference across module boundaries.

### Async Validation
Adding `async` to VibORM validate functions. It violates the internal
synchronous contract and would force every trusted consumer to branch again.

### Domain-Specific Primitives
Creating `v.email()` in validation layer. Scalar-specific logic belongs in `src/schema/scalars/`.

### Throwing Exceptions
Throwing errors instead of returning `{issues: [...]}`. Standard Schema uses result objects.

Boundary APIs that must throw use `ValidationError`, never a generic `Error`.

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

## Coverage Gate

`pnpm test:coverage:validation` runs the validation, scalar,
operation-schema, and relation core projects in one worker with a 768 MB heap,
one coverage-processing worker, and a 60-second process limit. It writes
`coverage/validation/index.html` and requires 100% statements, lines,
functions, and branches for `src/validation/**/*.ts`. This gate does not include
definition-time `src/schema/validation`.

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
