# Schema Relations - Relationship Definitions

**Location:** `src/schema/relation/`  
**Parent:** Schema Layer (see [../AGENTS.md](../AGENTS.md))  
**Layer:** L4 - Relations (see [root AGENTS.md](../../../AGENTS.md))

## Purpose

Defines relationships between models (oneToOne, manyToOne, oneToMany, manyToMany) using a chainable API with thunks for circular references.

## Why This Layer Exists

Relations have two challenges:

1. **Circular references**: User has Posts, Post has Author (User). JavaScript can't reference variables before declaration.

2. **TypeScript inference**: We need the target model's type, but can't access it until configuration is complete.

The solution: **thunks** `() => Model` defer model resolution, and **chainable methods** build configuration immutably.

---

## Entry Points

| File | Purpose |
|------|---------|
| `types.ts` | Shared types: `RelationState`, `ReferentialAction`, `Getter` |
| `to-one.ts` | `ToOneRelation` class + `oneToOne`, `manyToOne` factories |
| `to-many.ts` | `ToManyRelation` class + `oneToMany` factory |
| `many-to-many.ts` | `ManyToManyRelation` class + `manyToMany` factory |
| `helpers.ts` | Junction table utilities for many-to-many |
| `schemas/` | Relation query schemas (filter, create, update) |
| `index.ts` | Re-exports everything |

---

## Relation Types

| Type | FK Location | Use Case | Filter Operators | Chainable Methods |
|------|-------------|----------|------------------|-------------------|
| `oneToOne` | Either side | user ↔ profile | `is`, `isNot` | `.fields()`, `.references()`, `.optional()`, `.onDelete()`, `.onUpdate()` |
| `manyToOne` | This model | post → author | `is`, `isNot` | `.fields()`, `.references()`, `.optional()`, `.onDelete()`, `.onUpdate()` |
| `oneToMany` | Other model | author → posts | `some`, `every`, `none` | `.name()` only (FK is on other side) |
| `manyToMany` | Join table | posts ↔ tags | `some`, `every`, `none` | `.through()`, `.A()`, `.B()`, `.onDelete()`, `.onUpdate()` |

---

## Chainable API

### ToOne Relations (oneToOne, manyToOne)

```typescript
s.manyToOne(() => user)
  .fields("authorId")           // FK field(s) on this model
  .references("id")             // Referenced field(s) on target
  .optional()                   // FK can be null
  .onDelete("cascade")          // Referential action on delete
  .onUpdate("cascade")          // Referential action on update
  .name("author")               // Custom relation name
```

### ToMany Relations (oneToMany)

```typescript
s.oneToMany(() => post)         // Minimal config - FK is on the "many" side
  .name("posts")                // Custom relation name (optional)
```

**Note:** `oneToMany` doesn't have `.fields()`, `.references()`, or referential actions because the FK lives on the other model (the `manyToOne` side).

### ManyToMany Relations

```typescript
s.manyToMany(() => tag)
  .through("post_tags")         // Junction table name
  .A("postId")                  // Source field in junction table
  .B("tagId")                   // Target field in junction table
  .onDelete("cascade")          // Referential action
  .onUpdate("cascade")
  .name("tags")
```

---

## Core Rules

### Rule 1: Thunks for Target Models
Always use `() => Model` thunks to defer evaluation:

```typescript
// ✅ Thunk defers evaluation until needed
s.oneToMany(() => post)

// ❌ Direct reference fails (post not yet defined)
s.oneToMany(post)  // ReferenceError!
```

**Why:** JavaScript hoisting doesn't help with `const`. The thunk is called later when both models exist.

### Rule 2: Immutable Chainable Methods
Every method returns a NEW instance with updated state:

```typescript
s.manyToOne(() => user)         // ToOneRelation<{type: "manyToOne", getter: ...}>
  .fields("authorId")           // ToOneRelation<{..., fields: string[]}>
  .references("id")             // ToOneRelation<{..., references: string[]}>
```

**Why:** TypeScript tracks state changes through the generic parameter. Mutation would desync types from runtime.

### Rule 3: FK Ownership
The side WITH the foreign key uses `manyToOne` (or `oneToOne`). The other side uses `oneToMany`:

```typescript
// Post HAS the FK (authorId), so it uses manyToOne
const post = s.model({
  authorId: s.string(),
  author: s.manyToOne(() => user).fields("authorId").references("id"),
});

// User does NOT have the FK, so it uses oneToMany (no fields/references needed)
const user = s.model({
  posts: s.oneToMany(() => post),
});
```

### Rule 4: Foreign Key Field Must Exist
The field referenced in `.fields()` must be an actual field in the model:

```typescript
const post = s.model({
  authorId: s.string(),  // ← FK field must exist
  author: s.manyToOne(() => user).fields("authorId").references("id"),
});
```

---

## Anti-Patterns

### Direct Model Reference
Passing `post` instead of `() => post`. JavaScript can't reference variables before declaration.

### Using Old Options API
```typescript
// ❌ OLD - options object no longer supported
s.manyToOne(() => user, { fields: ["authorId"], references: ["id"] })

// ✅ NEW - chainable API
s.manyToOne(() => user).fields("authorId").references("id")
```

### Adding fields/references to oneToMany
```typescript
// ❌ WRONG - oneToMany doesn't own the FK
s.oneToMany(() => post).fields("id").references("authorId")

// ✅ RIGHT - no FK config needed (it's on the post side)
s.oneToMany(() => post)
```

### Wrong Relation Type
Using `oneToMany` when `manyToOne` is correct. The side WITH the FK uses `manyToOne`.

---

## Class Structure

Each relation type is a standalone class (no inheritance):

```typescript
// ToOneRelation - for oneToOne and manyToOne
class ToOneRelation<State extends ToOneRelationState> {
  fields(...fields: string[]): ToOneRelation<State & { fields: string[] }>
  references(...refs: string[]): ToOneRelation<State & { references: string[] }>
  optional(): ToOneRelation<State & { optional: true }>
  onDelete(action: ReferentialAction): ToOneRelation<State & { onDelete: ReferentialAction }>
  onUpdate(action: ReferentialAction): ToOneRelation<State & { onUpdate: ReferentialAction }>
  name(name: string): ToOneRelation<State & { name: string }>
  get "~"(): { state: State; names: SchemaNames; schemas: ... }
}

// ToManyRelation - for oneToMany
class ToManyRelation<State extends ToManyRelationState> {
  name(name: string): ToManyRelation<State & { name: string }>
  get "~"(): { state: State; names: SchemaNames; schemas: ... }
}

// ManyToManyRelation - for manyToMany
class ManyToManyRelation<State extends ManyToManyRelationState> {
  through(tableName: string): ManyToManyRelation<State & { through: string }>
  A(fieldName: string): ManyToManyRelation<State & { A: string }>
  B(fieldName: string): ManyToManyRelation<State & { B: string }>
  onDelete(action: ReferentialAction): ManyToManyRelation<State & { onDelete: ReferentialAction }>
  onUpdate(action: ReferentialAction): ManyToManyRelation<State & { onUpdate: ReferentialAction }>
  name(name: string): ManyToManyRelation<State & { name: string }>
  get "~"(): { state: State; names: SchemaNames; schemas: ... }
}
```

**Why standalone classes?** Inheritance caused TypeScript inference issues. Each class defines its own methods for cleaner types.

---

## Relation Schema Operations

### Filter (WHERE)

```typescript
// To-One: is, isNot
where: { author: { is: { name: "Alice" } } }

// To-Many: some, every, none
where: { posts: { some: { published: true } } }
where: { posts: { every: { authorId: "123" } } }
where: { posts: { none: { deleted: true } } }
```

### Create (Nested)

```typescript
create: {
  posts: {
    create: [{ title: "New Post" }],
    connect: [{ id: "existing-id" }],
    connectOrCreate: { where: { id: "..." }, create: { ... } }
  }
}
```

### Update (Nested)

```typescript
update: {
  posts: {
    create: [{ title: "New" }],
    update: [{ where: { id: "1" }, data: { title: "Updated" } }],
    delete: [{ id: "2" }],
    disconnect: [{ id: "3" }],
  }
}
```

---

## Referential Actions

Available for `ToOne` and `ManyToMany` relations:

| Action | Behavior |
|--------|----------|
| `cascade` | Delete/update child records when parent is deleted/updated |
| `setNull` | Set FK to NULL when parent is deleted/updated |
| `restrict` | Prevent delete/update if child records exist |
| `noAction` | Database default (usually same as restrict) |

```typescript
s.manyToOne(() => user)
  .fields("authorId")
  .references("id")
  .onDelete("cascade")   // Delete posts when user is deleted
  .onUpdate("cascade")   // Update FK when user.id changes
```

---

## Invisible Knowledge

### Why standalone classes instead of inheritance
Early versions used a `Relation` base class, but TypeScript struggled with method return types. Standalone classes with explicit method signatures provide cleaner type inference.

### Why oneToMany has minimal API
The FK lives on the "many" side (e.g., `post.authorId`). The `oneToMany` side (`user.posts`) is just the inverse - it doesn't own the FK, so no configuration is needed.

### Why manyToMany needs junction table config
Many-to-many requires a join table. `.through("postTags")` names this table. VibORM creates it automatically in migrations with `.A()` and `.B()` field names.

---

## Related Layers

| Layer | Relationship |
|-------|--------------|
| **Fields** ([fields/AGENTS.md](../fields/AGENTS.md)) | FK fields stored alongside relations |
| **Model** ([model/AGENTS.md](../model/AGENTS.md)) | Composes relations into models |
| **Migrations** ([migrations/AGENTS.md](../../migrations/AGENTS.md)) | Creates FK constraints and join tables |
| **Query Schemas** ([model/schemas/AGENTS.md](../model/schemas/AGENTS.md)) | Builds relation filter/create/update schemas |
