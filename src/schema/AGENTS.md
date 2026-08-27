# Schema - Type-Safe Schema Definition

**Location:** `src/schema/`  
**Layer:** L2-L5 - Schema Definition (see [root AGENTS.md](../../AGENTS.md))

## Purpose

Defines database schema using type-safe builders (scalars, models, relations) that enable fully-typed queries without code generation.

## Why This Layer Exists

VibORM's type safety comes from schema definitions carrying type information through the entire stack:

```typescript
// Schema definition
const user = s.model({
  email: s.string().unique(),
  posts: s.toMany(() => post),
});

// Query is fully typed - no codegen needed
await orm.user.findMany({
  where: { email: { contains: "@" } },  // ← TypeScript knows email is string
  include: { posts: true }               // ← TypeScript knows posts exist
});
```

This works because scalars use the **State generic pattern** - configuration is tracked as a type parameter, then consumed by validation registry schemas and client types.

---

## Entry Points

| Directory | Purpose | Guide |
|-----------|---------|-------|
| `scalars/` | Scalar type definitions | [scalars/AGENTS.md](scalars/AGENTS.md) |
| `model/` | Model composition and structural metadata | — |
| `relation/` | Relation types | [relation/AGENTS.md](relation/AGENTS.md) |
| `validation/` | Definition-time validation | — |
| `json/` | JSON-defined schemas — the document format, its parser and its serializer | — |
| `index.ts` | Public `s` builder API | — |

---

## Taxonomy

Use schema terms this way:

| Term | Meaning in schema layer |
|------|-------------------------|
| **Field** | Any named member of a model shape. A field can be a `Scalar` or a `Relation`. |
| **Scalar** | Primitive/value field implementation under `src/schema/scalars/`. |
| **Relation** | Association field implementation under `src/schema/relation/`. |

`fieldName`, `getFieldName`, compound `fields`, index `fields`, and relation
`.fields()` are correct because they refer to model keys or foreign-key fields.
Use `scalar` for scalar classes, scalar state, scalar operation schemas, and
the `scalars/` package.

---

## The Four Subsystems

### 1. Scalars (`scalars/`)
Primitive/value field definitions with the State generic pattern. Each scalar (string, int, boolean, etc.) carries configuration as a type parameter.

### 2. Models (`model/`)
Model class that composes fields: scalar fields and relation fields. Owns structural metadata; operation schemas are built by the validation registry.

### 3. Relations (`relation/`)
Two factories — `s.toOne` and `s.toMany` — using thunks for circular references.
The factory states the slot's cardinality; its argument states the target domain
(one model, or a map of named variants). Pairing, foreign-key ownership,
uniqueness and junction topology are derived by `validation/relation-resolution.ts`.

### 4. Schema Validation (`validation/`)
Definition-time validation to catch schema errors before runtime (e.g., relation references non-existent model).

### 5. JSON Schemas (`json/`)
`parseSchema` is an INTERPRETER over the three subsystems above: it reads a JSON
document and calls `s.model`, `s.string()`, `s.toOne(...)` — the same factories a
human calls — so there is no second schema representation and nothing to keep in
sync. `serializeSchema` is the reverse direction, reading DECLARATION state (not
the resolved topology) without mutating the schema it is given.

Ownership inside the module is exact: `document.ts` is the format, `read.ts`
decides whether a value HAS that shape (and owns the JSON pointer), `interpret.ts`
owns the modifier apply order and the JSON→builder-value conversions, and
`serialize.ts` owns the reverse. Two channels reach a database verbatim and have
one owner each, consulted by BOTH directions: `native-catalog.ts` decides
`native.type` by membership of the declared dialect's closed catalog (derived
from the shipped `PG`/`MYSQL`/`SQLITE` constants — a document may not spell a
type they cannot produce), and `issues.ts` owns every guarded inspection of
caller input, property reads and prototype/key traps alike. Semantics stay with the subsystems: which
modifiers a scalar type has is the class surface, a foreign key's completeness is
the relation factory's, and a graph's topology is `validation/`'s — each is
re-thrown with the document location rather than restated.

---

## Core Rules

### Rule 1: State Generic Pattern
Every scalar/model carries configuration as type parameter:

```typescript
s.string()           // StringScalar<{type: "string"}>
  .nullable()        // StringScalar<{type: "string", nullable: true}>
```

**Why:** TypeScript tracks changes at compile time, enabling typed queries without codegen.

### Rule 2: Immutability
Every modifier returns NEW instance. Never mutate `this.state`.

```typescript
// ✅ Returns new instance
nullable() {
  return new StringScalar({ ...this.state, nullable: true });
}
```

**Why:** Mutation would desync runtime state from compile-time type.

### Rule 3: Lazy Evaluation with Thunks
Circular references use `() => Model` thunks:

```typescript
s.toMany(() => post)  // Thunk defers evaluation
```

**Why:** JavaScript can't reference variables before declaration.

### Rule 4: `["~"]` for Internals
All internal state exposed via tilde accessor:

```typescript
scalar["~"].state         // Configuration object
scalar["~"].state.base    // Base scalar schema
model["~"].state          // Model structure and metadata
```

**Why:** Keeps public API clean, signals "internal" to users.

### Rule 5: Schema/Validation Boundary
Schema owns structure and base scalar schemas. The validation registry owns operation schemas (`where`, `create`, `update`, args, relation inputs), and the client/query-engine use that registry for operation validation.

### Rule 6: Definition Validation Has One Graph Context
`SchemaValidator` builds model and table lookups once and passes a required
`ValidationContext` to every rule. Rules trust that context; they do not scan
the schema again as a fallback. A caller-supplied rule is an external boundary,
so a thrown value becomes a typed `SchemaValidationError` with code `V4002`.

Duplicate names are rejected by `SchemaValidator.register`, before `Map`
replacement can erase the duplicate. Rules report structured
`SchemaValidationIssue` values. Database portability belongs to migration
dialect validation, not to disconnected schema rules.

Use `pnpm test:coverage:schema-validation` for the memory-capped L5 report. It
gates statements, branches, functions, and lines at 100% and writes
`coverage/schema-validation/index.html`.

### Runtime schema metadata

`field-ref.ts` projects a model's scalar keys into a lazy, immutable reference
table. Its JavaScript reflection surface is exact: enumeration, `in`, and own
property descriptors expose scalar keys only. `hydration.ts` binds model-local
TypeScript and SQL names and relation sources once before downstream layers use
the schema. These two root-schema modules are owned by the L2 core; relation
semantics remain in L4.

Use `pnpm test:coverage:schema` for their one-worker, memory-capped report. It
gates statements, branches, functions, and lines at 100% and writes
`coverage/schema/index.html`.

---

## Anti-Patterns

### State Mutation
Modifying `this.state` directly. Breaks type tracking - compile-time type won't match runtime.

### Direct Model References
Passing model directly to relation. JavaScript can't handle forward references.

### Missing Scalar Union Update
Adding new scalar type but forgetting to add to the `Scalar` union in `base.ts`. TypeScript won't recognize it.

### Type Assertions
Using `as` to force types. Breaks natural inference chain from schema to client.

### Eager Evaluation
Building schemas eagerly without caching. Wastes performance rebuilding on every `["~"]` access.

---

## Type Flow

```
User writes:           s.string().nullable()
                              ↓
Scalar creates State:  StringScalar<{type: "string", nullable: true}>
                              ↓
Scalar state stores:    v.string({nullable: true}) as base schema
                              ↓
SchemaRegistry builds: operation schemas from model graph context
                              ↓
Type inference:        InferInput<schema> → string | null
                              ↓
Client uses:           orm.user.findMany({...})  // Fully typed!
```

**Key insight:** Types flow DOWN. If client types are wrong, the bug is upstream.

---

## Invisible Knowledge

### Why `["~"]` and not `_internal`
The tilde is visually distinctive and won't appear in autocomplete prominently. `_internal` was tried but cluttered suggestions.

### Why operation schemas live in the registry
Nested relation inputs need full model graph context, especially to omit parent-derived foreign keys. Keeping operation schemas in `SchemaRegistry` avoids rebuilding that context inside scalars or models.

---

## Common Tasks

| Task | Location |
|------|----------|
| Add new scalar type | [scalars/AGENTS.md](scalars/AGENTS.md) |
| Add query operator | `src/validation/model/core/` + query-engine + adapters |
| Add relation type | [relation/AGENTS.md](relation/AGENTS.md) |
| Fix type inference | Check validation schema factories, then client |

---

## Related Layers

| Layer | Relationship |
|-------|--------------|
| **Validation** ([validation/AGENTS.md](../validation/AGENTS.md)) | Provides v.* primitives and `SchemaRegistry` operation schemas |
| **Query Engine** ([query-engine/AGENTS.md](../query-engine/AGENTS.md)) | Uses registry schemas for operation validation |
| **Client** ([client/AGENTS.md](../client/AGENTS.md)) | Infers operation payload/result types from validation model schemas |
