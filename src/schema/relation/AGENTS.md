# Schema Relations - Relationship Definitions

**Location:** `src/schema/relation/`  
**Parent:** Schema Layer (see [../AGENTS.md](../AGENTS.md))  
**Layer:** L4 - Relations (see [root AGENTS.md](../../../AGENTS.md))

## Purpose

Defines ordinary single-target relations and polymorphic multi-target to-one
relations with immutable chainable APIs and lazy target getters.

In schema taxonomy, relations are one concrete kind of model field. The other
concrete kind is scalar. Keep `field` wording when referring to model keys,
foreign-key fields, junction fields, or the public `.fields()` relation API;
use `relation` when referring to relation classes, relation state, or relation
operation schemas.

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
| `polymorphic.ts` | `PolymorphicRelation`, private-storage metadata, and inverse binding |
| `helpers.ts` | Junction table utilities for many-to-many |
| `index.ts` | Re-exports everything |

---

## Relation Types

| Type | FK Location | Use Case | Filter Operators | Chainable Methods |
|------|-------------|----------|------------------|-------------------|
| `oneToOne` | Either side | user ↔ profile | `is`, `isNot` | `.fields()`, `.references()`, `.optional()`, `.onDelete()`, `.onUpdate()` |
| `manyToOne` | This model | post → author | `is`, `isNot` | `.fields()`, `.references()`, `.optional()`, `.onDelete()`, `.onUpdate()` |
| `oneToMany` | Other model | author → posts | `some`, `every`, `none` | `.name()` only (FK is on other side) |
| `manyToMany` | Join table | posts ↔ tags | `some`, `every`, `none` | `.through()`, `.A()`, `.B()`, `.onDelete()`, `.onUpdate()` |
| `polymorphic` | Private `(type, id)` pair on this model | comment → post or video | correlated `type` + `is`/`isNot` | `.name()`, `.optional()` |

---

## Chainable API

### ToOne Relations (oneToOne, manyToOne)

```typescript
s.manyToOne(() => user)
  .fields("authorId")           // FK scalar field-key(s) on this model
  .references("id")             // Referenced scalar field-key(s) on target
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
  .A("postId")                  // Source FK column in junction table
  .B("tagId")                   // Target FK column in junction table
  .onDelete("cascade")          // Referential action
  .onUpdate("cascade")
  .name("tags")
```

### Polymorphic Relations

```typescript
s.polymorphic(
  {
    post: () => post,
    video: () => video,
  },
  {
    values: {
      post: "content.post.v1",
      video: "content.video.v1",
    },
  }
)
  .name("commentable")
  .optional()
```

The target-map key is the public query/result discriminator. `values` contains
the stable stored discriminator and is complete and exact. Each target has its
own getter so recursive declarations stay lazy without widening the outer key
map. V1 has no short form that derives stored values from public keys.

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
The FK scalar field-key passed to `.fields()` must be an actual scalar field in the model:

```typescript
const post = s.model({
  authorId: s.string(),  // ← FK scalar field must exist
  author: s.manyToOne(() => user).fields("authorId").references("id"),
});
```

### Rule 5: Polymorphic Relations Are a Third Field Category

`PolymorphicRelation` is not an `AnyRelation` and `"polymorphic"` is not an
ordinary `RelationType`. A model stores polymorphic fields separately in
`ModelState.polymorphicRelations`; private storage never enters
`ModelState.scalars` or the public field surface.

Client construction hydrates field names, then runs the mandatory full schema
definition gate when any polymorphic field exists. That gate validates lazy
targets, exact discriminator maps, portable single-column primary keys,
generated-name collisions, inverse pairing, and private storage. Downstream
query and migration code trusts the resulting cached `PolymorphicStorage`.

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
  get "~"(): { state: State; setSource(source: AnyModel): void }
}

// ToManyRelation - for oneToMany
class ToManyRelation<State extends ToManyRelationState> {
  name(name: string): ToManyRelation<State & { name: string }>
  get "~"(): { state: State; setSource(source: AnyModel): void }
}

// ManyToManyRelation - for manyToMany
class ManyToManyRelation<State extends ManyToManyRelationState> {
  through(tableName: string): ManyToManyRelation<State & { through: string }>
  A(columnName: string): ManyToManyRelation<State & { A: string }>
  B(columnName: string): ManyToManyRelation<State & { B: string }>
  onDelete(action: ReferentialAction): ManyToManyRelation<State & { onDelete: ReferentialAction }>
  onUpdate(action: ReferentialAction): ManyToManyRelation<State & { onUpdate: ReferentialAction }>
  name(name: string): ManyToManyRelation<State & { name: string }>
  get "~"(): { state: State; setSource(source: AnyModel): void }
}

// PolymorphicRelation - for a private multi-target to-one edge
class PolymorphicRelation<State extends PolymorphicRelationState> {
  name(name: string): PolymorphicRelation<State & { name: string }>
  optional(): PolymorphicRelation<State & { optional: true }>
  get "~"(): { state: State; targetEntries(): readonly ResolvedPolymorphicTargetEntry[] }
}
```

**Why standalone classes?** Inheritance caused TypeScript inference issues. Each class defines its own methods for cleaner types.

---

## Relation Operation Schemas

Relation operation schemas are built by `SchemaRegistry` in `src/validation/relations/` from relation state and full model graph context.

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

### Polymorphic V1 Inputs

Direct create accepts exactly one of:

```typescript
{ connect: { type: "post", where: { id: "post_1" } } }
{ create: { type: "video", data: { title: "New video" } } }
```

Direct update accepts `connect`, plus `{ disconnect: true }` only when the
relation is optional. A bound inverse `oneToMany` keeps its ordinary read,
filter, count, order, and pagination surface but exposes only nested `create`
for writes.

V1 refuses direct update-through, `set`, `upsert`, and `connectOrCreate`, and it
refuses inverse connect/createMany/disconnect/delete/update/set/upsert/
connectOrCreate. A root or nested scalar-only `createMany` is unavailable when
its target model has a required polymorphic field; optional polymorphic fields
do not block bulk creation.

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

### Public and Stored Discriminators Are Different

Renaming a public target-map key is metadata-only when its stable stored value
and physical target remain unchanged. Changing or removing a stored value, or
retargeting it, requires explicit migration-history acknowledgement after the
caller performs the needed DML.

### Polymorphic Storage Has No Database Foreign Key

The owner table gets private `<relation>_type` and `<relation>_id` columns plus a
composite `(type, id)` index. No portable foreign key can point to several
tables. Optional missing known targets parse as `null`; required missing targets
raise `QueryEngineError`; unknown or half-null storage is malformed provider
data.

### Why standalone classes instead of inheritance
Early versions used a `Relation` base class, but TypeScript struggled with method return types. Standalone classes with explicit method signatures provide cleaner type inference.

### Why oneToMany has minimal API
The FK lives on the "many" side (e.g., `post.authorId`). The `oneToMany` side (`user.posts`) is just the inverse - it doesn't own the FK, so no configuration is needed.

### Why manyToMany needs junction table config
Many-to-many requires a join table. `.through("postTags")` names this table. VibORM creates it automatically in migrations with `.A()` and `.B()` FK column names.

---

## Junction Ownership and Coverage

Junction identity is resolved symmetrically. Configuration may live on either
side of a paired many-to-many relation; the paired side's `.A()` and `.B()` are
read in reverse order. Multiple pairs between the same models use `.name()` as
their identity. A paired self-relation must provide both junction columns
explicitly because no stable default can decide its direction.

Relation instances and hydrated model state are trusted. Junction helpers do
not revalidate required getters or the model's relation map. They still fail
loudly when two public relation declarations disagree on a table or column.

Use `pnpm test:coverage:relations` for the one-worker, memory-capped L4 report.
It gates `src/schema/relation/**/*.ts` at 100% statements, branches, functions,
and lines and writes `coverage/relations/index.html`. The suite is pure and must
not boot a database or require a provider.

L4 tests only relation definitions, immutable builder state, source binding,
inverse metadata, and junction resolution. Relation create, update, filter,
ordering, and projection schemas are L3 operation schemas and live under
`tests/unit/operation-schemas/relations`.

---

## Related Layers

| Layer | Relationship |
|-------|--------------|
| **Scalars** ([scalars/AGENTS.md](../scalars/AGENTS.md)) | FK scalar fields stored alongside relation fields |
| **Model** (`../model/`) | Composes relation fields into models |
| **Migrations** ([migrations/AGENTS.md](../../migrations/AGENTS.md)) | Creates FK constraints and join tables |
| **Validation** ([validation/AGENTS.md](../../validation/AGENTS.md)) | Builds relation filter/create/update schemas through `SchemaRegistry` |
