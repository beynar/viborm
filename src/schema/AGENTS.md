# Schema - Type-Safe Schema Definition

**Location:** `src/schema/`  
**Layer:** L2-L5 - Schema Definition (see [root AGENTS.md](../../AGENTS.md))

## Purpose

Defines database schema using type-safe builders (fields, models, relations) that enable fully-typed queries without code generation.

## Why This Layer Exists

VibORM's type safety comes from schema definitions carrying type information through the entire stack:

```typescript
// Schema definition
const user = s.model({
  email: s.string().unique(),
  posts: s.oneToMany(() => post),
});

// Query is fully typed - no codegen needed
await orm.user.findMany({
  where: { email: { contains: "@" } },  // ← TypeScript knows email is string
  include: { posts: true }               // ← TypeScript knows posts exist
});
```

This works because fields use the **State generic pattern** - configuration is tracked as a type parameter, then consumed by validation registry schemas and client types.

---

## Entry Points

| Directory | Purpose | Guide |
|-----------|---------|-------|
| `fields/` | Field type definitions | [fields/AGENTS.md](fields/AGENTS.md) |
| `model/` | Model composition and structural metadata | — |
| `relation/` | Relation types | [relation/AGENTS.md](relation/AGENTS.md) |
| `validation/` | Definition-time validation | — |
| `index.ts` | Public `s` builder API | — |

---

## The Four Subsystems

### 1. Fields (`fields/`)
Field type definitions with State generic pattern. Each field (string, int, boolean, etc.) carries configuration as a type parameter.

### 2. Models (`model/`)
Model class that composes fields and relations. Owns structural metadata; operation schemas are built by the validation registry.

### 3. Relations (`relation/`)
Relation types (oneToOne, manyToOne, oneToMany, manyToMany) using thunks for circular references.

### 4. Schema Validation (`validation/`)
Definition-time validation to catch schema errors before runtime (e.g., relation references non-existent model).

---

## Core Rules

### Rule 1: State Generic Pattern
Every field/model carries configuration as type parameter:

```typescript
s.string()           // StringField<{type: "string"}>
  .nullable()        // StringField<{type: "string", nullable: true}>
```

**Why:** TypeScript tracks changes at compile time, enabling typed queries without codegen.

### Rule 2: Immutability
Every modifier returns NEW instance. Never mutate `this.state`.

```typescript
// ✅ Returns new instance
nullable() {
  return new StringField({ ...this.state, nullable: true });
}
```

**Why:** Mutation would desync runtime state from compile-time type.

### Rule 3: Lazy Evaluation with Thunks
Circular references use `() => Model` thunks:

```typescript
s.oneToMany(() => post)  // Thunk defers evaluation
```

**Why:** JavaScript can't reference variables before declaration.

### Rule 4: `["~"]` for Internals
All internal state exposed via tilde accessor:

```typescript
field["~"].state          // Configuration object
field["~"].state.base     // Base field schema
model["~"].state          // Model structure and metadata
```

**Why:** Keeps public API clean, signals "internal" to users.

### Rule 5: Schema/Validation Boundary
Schema owns structure and base field schemas. The validation registry owns operation schemas (`where`, `create`, `update`, args, relation inputs), and the client/query-engine use that registry for operation validation.

---

## Anti-Patterns

### State Mutation
Modifying `this.state` directly. Breaks type tracking - compile-time type won't match runtime.

### Direct Model References
Passing model directly to relation. JavaScript can't handle forward references.

### Missing Field Union Update
Adding new field type but forgetting to add to Field union in `base.ts`. TypeScript won't recognize it.

### Type Assertions
Using `as` to force types. Breaks natural inference chain from schema to client.

### Eager Evaluation
Building schemas eagerly without caching. Wastes performance rebuilding on every `["~"]` access.

---

## Type Flow

```
User writes:           s.string().nullable()
                              ↓
Field creates State:   StringField<{type: "string", nullable: true}>
                              ↓
Field state stores:    v.string({nullable: true}) as base schema
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
Nested relation inputs need full model graph context, especially to omit parent-derived foreign keys. Keeping operation schemas in `SchemaRegistry` avoids rebuilding that context inside fields or models.

---

## Common Tasks

| Task | Location |
|------|----------|
| Add new field type | [fields/AGENTS.md](fields/AGENTS.md) |
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
