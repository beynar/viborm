# Schema Relations - Relationship Definitions

**Location:** `src/schema/relation/`  
**Parent:** Schema Layer (see [../AGENTS.md](../AGENTS.md))  
**Layer:** L4 - Relations (see [root AGENTS.md](../../../AGENTS.md))

## Purpose

Defines ordinary single-target relations and polymorphic multi-target carriers
with immutable chainable APIs and lazy target getters. A carrier declares its
own cardinality by the factory it is spelled with — `s.polymorphicToOne` or
`s.polymorphicToMany`. BOTH ARE FULLY IMPLEMENTED, and neither is the special
case: a to-one slot builds a row-held `(type, id)` storage descriptor, a
collection slot builds a complete member-junction descriptor (one fixed-target
junction per variant), and `getPolymorphicRelationsSchemas` builds all six
operation-schema families over either one. Cardinality is a property of the
SLOT; polymorphism is a property of the TARGETS. Nothing in this layer treats
to-one as the default reading.

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
| `cardinality.ts` | The one declared-slot cardinality reading: `relationCardinality`, `polymorphicCardinality` + type twin `PolymorphicCardinalityOf` |
| `to-one.ts` | `ToOneRelation` class + `oneToOne`, `manyToOne` factories |
| `to-many.ts` | `ToManyRelation` class + `oneToMany` factory |
| `many-to-many.ts` | `ManyToManyRelation` class + `manyToMany` factory |
| `polymorphic.ts` | The `polymorphicToOne` / `polymorphicToMany` factories + the `PolymorphicToOneRelation` / `PolymorphicToManyRelation` terminals, private-storage metadata, and inverse binding |
| `inverse.ts` | The one candidate discovery/resolution owner, and which shapes may bind a polymorphic inverse |
| `clearability.ts` | The two emptying facts: `slotMayBeEmpty`, `membershipCanBeCleared` |
| `helpers.ts` | Junction table utilities for many-to-many |
| `junction-topology.ts` | The one owner of resolved junction physical facts — table, both complete ordered sides, canonical order, pair identity, derived constraint names — for ordinary `manyToMany` pairs (`resolveOrdinaryJunctionTopology`) and for polymorphic collection members (`resolvePolymorphicMemberNames`, `resolvePolymorphicMemberJunctionTopology`). Deliberately NOT re-exported from `index.ts`; consumers deep-import it |
| `index.ts` | Re-exports everything |

---

## Relation Types

| Type | FK Location | Use Case | Filter Operators | Chainable Methods |
|------|-------------|----------|------------------|-------------------|
| `oneToOne` | Either side | user ↔ profile | `is`, `isNot` | `.fields()`, `.references()`, `.optional()`, `.onDelete()`, `.onUpdate()` |
| `manyToOne` | This model | post → author | `is`, `isNot` | `.fields()`, `.references()`, `.optional()`, `.onDelete()`, `.onUpdate()` |
| `oneToMany` | Other model | author → posts | `some`, `every`, `none` | `.name()` only (FK is on other side) |
| `manyToMany` | Join table | posts ↔ tags | `some`, `every`, `none` | `.through()`, `.A()`, `.B()`, `.onDelete()`, `.onUpdate()` |
| `polymorphicToOne` | Private `(type, id)` pair on this model | comment → post or video | correlated `type` + `is`/`isNot`; optional fields also accept null-presence forms | `.name()`, `.optional()` |
| `polymorphicToMany` | One fixed-target member junction per variant | shelf → books and videos | `some`/`every`/`none`, each over a correlated `type` + `is`/`isNot` | `.name()`, `.through()` |

`manyToOne` normally owns the FK. The retained fields-less compatibility form
can resolve storage from an inverse edge and binds as child-held singular; full
schema validation warns with `FK004`. Do not use that spelling for new schemas.

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
  .A("postId")                  // Source column or compound-side prefix
  .B("tagId")                   // Target column or compound-side prefix
  .onDelete("cascade")          // Referential action
  .onUpdate("cascade")
  .name("tags")
```

`.A()` and `.B()` always take one string token. For a scalar endpoint row key,
the token is the exact junction column name. For a compound row key, it is a
prefix expanded positionally as `<prefix>_1`, `<prefix>_2`, and so on in the
model row-key order. Do not expose an array API or derive suffixes from mapped
SQL column names: the ordered bound `JunctionSide` owns the complete physical
column-to-referenced-field correspondence.

### Polymorphic Relations

```typescript
s.polymorphicToOne({
  post: () => post,
  video: () => video,
})
  .name("commentable")
  .optional()
```

TWO FACTORIES, and the one you call IS the cardinality — there is no
cardinality-less carrier on the public surface any more. Both take a MAP of
named targets: a bare `() => model` is refused at the TYPE level by
`TargetMapOnly`, whose message names `s.oneToOne` / `s.manyToOne` /
`s.oneToMany` / `s.manyToMany`, because a single-getter carrier would silently
build a private `(type, id)` pair where the caller expected a foreign key. A
carrier that carries NO cardinality is only reachable by forging a state past a
terminal's constructor, and definition validation ejects it as P013.
`s.polymorphicToMany` declares a collection slot whose storage is ONE
FIXED-TARGET MEMBER JUNCTION PER VARIANT: definition validation resolves each member's names and complete
topology (`resolvePolymorphicMemberNames` /
`resolvePolymorphicMemberJunctionTopology` in `junction-topology.ts`) into a
`kind: "toMany"` storage descriptor, and `.through()` — an EXACT map keyed by
public variant, `{ table, source, target }` per entry, exact at both levels and
P017 at runtime — overrides a member's names. ONE descriptor, three readers: the
serializer emits it as DDL, the engine binder projects each member into a
`JunctionBoundRelation` (direct leaf, plural inverse view, or singular inverse
slot), and `getPolymorphicRelationsSchemas` builds the collection's six
operation-schema families over it. Only a to-one carrier carries `.optional()` —
an empty collection is already the empty case, and a collection state cannot
carry `optional` at all.

The target-map key is the public query/result discriminator and, by default,
the stored discriminator. Pass the optional exact `{ values }` argument when
storage needs stable namespaced or versioned values. There is no partial
fallback when that argument is present. Each target has its own getter so
recursive declarations stay lazy without widening the outer key map.

An inverse is one of the four FIELDS-LESS shapes, admitted through the one
compatible-binding projection (`getCompatiblePolymorphicInverseBinding` in
`inverse.ts`): each asking shape binds ONLY the group family that owns its
membership storage. The row-held shapes (`oneToMany`, fields-less `oneToOne`)
bind a toOne group, because their membership is the owner's private `(type,
id)` pair; the junction-shaped ones (fields-less `manyToOne`, `manyToMany`)
bind a toMany group, because their membership lives in a member junction.
Incompatible means `undefined`, which is the fallback to the ordinary meaning
(R004/R005 and the junction rules fire exactly as before) — and a row-held shape
over a toMany group is R003-invalid unless a real ordinary inverse carries the
edge. A polymorphic-bound `manyToMany` is a member VIEW: it owns no ordinary
junction (the serializer skips it), so an ordinary `manyToMany` pair partner on
the target would serialize half a pair and is refused as P020. On a toOne group all
inverses share one private `(type, id)` pair and must use the same cardinality:
the validated `PolymorphicToOneStorage.inverseCardinality` is relation-wide and
mixed cardinalities are rejected as P012. On a toMany group each MEMBER keeps
its own `inverseCardinality` ("one" for a bound `manyToOne`, "many" for a bound
`manyToMany`, "many" when unbound), and a member bound by more than one inverse
relation is rejected as P015. A SINGULAR collection inverse must call
`.optional()` or it is rejected as P021: its `disconnect` / `delete` hang on
`slotMayBeEmpty` alone (the clearability owner's `manyToMany` arm is never
consulted for that shape) and `getFkRequirementKeySets` gives a fields-less
inverse no create obligation either, so without the rule the declaration
silently degrades to a slot that can be filled and never emptied. Refusing at
definition validation is what keeps `slotMayBeEmpty` a pure one-owner state read
instead of putting a junction-aware override inside `clearability.ts`. The
inverse cardinality is a separate fact from
the declared slot cardinality: the factory describes the owner's
own slot, while `inverseCardinality` describes the slot on the target side.
A fields-less `oneToOne` is non-owning and must call `.optional()` because no
local FK can require a related row to exist. This slot optionality is distinct
from membership clearability: inverse delete removes the child, while inverse
disconnect preserves it and therefore requires nullable child-side storage.

`cardinality.ts` owns the declared slot cardinality for both kinds of relation:
`relationCardinality(state)` for an ordinary edge, and
`polymorphicCardinality(state)` plus its type twin `PolymorphicCardinalityOf<S>`
for a carrier. Consumers must branch through those readers rather than testing
`state.cardinality` inline. The one exception is
`schema/validation/rules/polymorphic.ts`, whose input is an untrusted carrier
that may not carry a cardinality at all (a forged one) — that site reads raw to
raise P013.

`clearability.ts` owns both readings, runtime and type together:
`slotMayBeEmpty(state)` is the declaration's own optionality, and
`membershipCanBeCleared(state, source)` is the storage question — every inverse
foreign-key scalar nullable on an ordinary edge, the target relation optional on
a polymorphic one, which is the same statement about its private `(type, id)`
pair. They are TWO facts and must stay two: an optional slot whose child-side
foreign key cannot be nulled is a legal schema whose operation surface offers
`delete` without `disconnect`. A rule forcing the two to agree would be
source-breaking and is a separate product decision (compression plan §8.2), so
no consumer may derive one from the other.

The write engine does not read this module. It answers the physical question
from BOUND membership (`query-engine/write-engine/relation-nullability.ts`),
which is the only reading available on a trusted internal program that never
passed the public schema — see the guard-ownership ledger for the coverage that
keeps that guard alive.

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

A configured polymorphic carrier is not an `AnyRelation` and `"polymorphic"` is
not an ordinary `RelationType`. A model stores polymorphic fields separately in
`ModelState.polymorphicRelations`; private storage never enters
`ModelState.scalars` or the public field surface.

A model field must be a CONFIGURED carrier — `PolymorphicToOneRelation` or
`PolymorphicToManyRelation`. Both public factories return one, so there is no
unconfigured shape for `s.model()` to refuse any more; the cardinality-less
carrier that P013 ejects can only be forged past a terminal's constructor.

A shared base class does not conflate the two terminals with each other: they
are held apart by `State["cardinality"]`, and `"one"` is not assignable to
`"many"` whatever the private fields do. The measured reason to keep them
separate is the one recorded further down this file — inheritance was tried and
caused inference problems — not a type hole. Do not invent a stronger reason
than the probe supports.

Client construction hydrates field names and always enforces the non-owning
one-to-one optionality rule. When any polymorphic field exists, it additionally
runs the complete schema definition gate. That gate validates lazy targets,
exact discriminator maps, portable single-column primary keys, generated-name
collisions, inverse pairing, and private storage. Downstream query and migration
code trusts the resulting cached `PolymorphicStorage`.

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

// The two factories - MAP ONLY, and each stamps its own cardinality.
// `Targets` also admits a bare `Getter` so `TargetMapOnly` can refuse it with a
// message naming the four ordinary factories; the conditional return strips it.
function polymorphicToOne<const Targets, const Values>(targets, options?): PolymorphicToOneRelation<{ cardinality: "one"; targets: Targets; values: Values }>
function polymorphicToMany<const Targets, const Values>(targets, options?): PolymorphicToManyRelation<{ cardinality: "many"; targets: Targets; values: Values }>

// PolymorphicToOneRelation - the slot holds at most one membership
class PolymorphicToOneRelation<State extends PolymorphicToOneState> {
  name(name: string): PolymorphicToOneRelation<State & { name: string }>
  optional(): PolymorphicToOneRelation<State & { optional: true }>
  get "~"(): { state: State; targetEntries(): readonly ResolvedPolymorphicTargetEntry[] }
}

// PolymorphicToManyRelation - the slot holds a collection; no optional()
class PolymorphicToManyRelation<State extends PolymorphicToManyState> {
  name(name: string): PolymorphicToManyRelation<State & { name: string }>
  // EXACT map keyed by public variant, both directions, fresh and non-fresh.
  through<const Map extends Record<PublicType, PolymorphicThroughEntry>>(map: Map): PolymorphicToManyRelation<State & { through: Map }>
  get "~"(): { state: State; targetEntries(): readonly ResolvedPolymorphicTargetEntry[] }
}
```

`PolymorphicStateOf<Relation>` is the ONE place both terminal classes are named
together. Every type that needs a carrier's state goes through it; matching the
classes ad hoc, or widening the match structurally, collapses
`GetPolymorphicInverseBinding` to `never` with no compile error anywhere.

**Why standalone classes?** Inheritance caused TypeScript inference issues. Each class defines its own methods for cleaner types.

---

## Relation Operation Schemas

Relation operation schemas are built by `SchemaRegistry` in `src/validation/relations/` from relation state and full model graph context.

To-one mutation compatibility belongs to L3 validation. Create payloads and
parent-held updates have at most one active verb. Child-held updates also admit
the fixed vacate-then-supply pairs that the relation owner can execute in
canonical order. `false` remains a no-op for boolean verbs. To-many schemas
remain keyed bags because combining operation kinds is part of their contract.

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
    // Available only when the child-held membership can be cleared.
    disconnect: [{ id: "3" }],
  }
}
```

### Polymorphic Inputs

#### Row-held (`s.polymorphicToOne`)

Direct create accepts exactly one of `connect`, `create`, or
`connectOrCreate`:

```typescript
{ connect: { type: "post", where: { id: "post_1" } } }
{ create: { type: "video", data: { title: "New video" } } }
{ connectOrCreate: { type: "post", where: { id: "post_1" }, create: { id: "post_1", title: "New" } } }
```

Direct selected update accepts `connect`, `create`, `connectOrCreate`,
correlated `update`, and `upsert`. Optional storage also accepts `disconnect`
and typed target `delete`. A bound inverse `oneToMany` keeps its ordinary read,
filter, count, order, and pagination surface and exposes the safe child-held
write family: create/createMany/connect/connectOrCreate/upsert on create, plus
targeted update with full child update data, updateMany with full
relation-bearing child update data (the owning direct polymorphic key omitted),
and delete/deleteMany on update. Clearable child storage
also exposes disconnect.
To-many set is present for optional and required storage; required storage
rejects departing members. A bound inverse `oneToOne` returns one record or `null` and
uses the ordinary singular surface: create/connect/connectOrCreate on create;
create/connect/connectOrCreate/update/upsert on update. Its public slot is
always optional, so delete is available; disconnect is available only when the
child's direct polymorphic storage is optional and can be cleared.

A row-held edge stores one membership, so collection `set` does not apply to it.
Root `createMany` rows accept the ordinary create data shape; the row-held
polymorphic membership itself stays connect-only. Target probes are grouped by relation and discriminator before the
existing grouped INSERT plan. Inverse nested createMany may satisfy its one
owning required polymorphic relation, but remains unavailable when another
required polymorphic relation would be unsatisfied.

#### Junction-held (`s.polymorphicToMany`)

A collection's input is a keyed BAG, not a one-intent union: several verbs may
appear together and an empty bag is inert. Every verb takes one tagged item or an
array of them, and the discriminator sits INSIDE each item — which is what
correlates the `type` literal with that variant's own `where` / `data` schemas.

A fresh owner names four supply verbs — `create`, `createMany`, `connect`,
`connectOrCreate`. A located owner names all ELEVEN: those four plus `set`,
`disconnect`, `delete`, `deleteMany`, `update`, `updateMany`, `upsert`.
`upsert` is deliberately absent from the create bag: its found arm is scoped to
THIS owner's membership and a fresh owner has none, so the only alternatives
would be a silent global adopt or a grammar the engine must refuse.

`disconnect` is UNCONDITIONAL — a member junction row always clears, because the
row goes and no column is nulled — and there is no `disconnect: true` spelling;
`set: []` carries that meaning. `set` clears every configured variant exactly
once, including variants the payload never mentions, then refills.

Root `createMany` is NOT restricted here. A row naming a collection is
relation-bearing, so the whole call routes to the ordered record series and the
row mounts the same four supply verbs any other create context does.

Both inverse arities are ORDINARY. A polymorphic-bound `manyToMany` is a
fixed-variant junction view and takes the ordinary to-many families whole. A
polymorphic-bound fields-less `manyToOne` is a to-one SLOT — one member-junction
row under a UNIQUE over the complete target side — and takes the ordinary to-one
create and update families verbatim, with `disconnect: true` deleting the
junction row and `delete: true` deleting the connected owner row.
`GetRelationSchemas` dispatches on cardinality alone; there is no polymorphic
inverse family.

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
composite `(type, id)` index. The index is unique when inverse cardinality is
`one`; this prevents two owner rows from selecting the same exact target across
all discriminators. No portable foreign key can point to several tables.
Empty optional storage parses as `null`. A non-empty known membership whose
target is missing raises `QueryEngineError` regardless of optionality; unknown
or half-null storage is malformed provider data.

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
