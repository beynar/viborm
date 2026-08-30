# Schema Relations — the two factories and their declaration state

**Location:** `src/schema/relation/`  
**Parent:** Schema Layer (see [../AGENTS.md](../AGENTS.md))  
**Layer:** L4 - Relations (see [root AGENTS.md](../../../AGENTS.md))

## Purpose

This layer owns **declaration** and nothing else. There are exactly two
factories, `s.toOne` and `s.toMany`. The factory you call states the **slot
cardinality**; its argument states the **target domain** — one model, or a map of
named variants.

That is the whole declaration. Who an edge's partner is, which endpoint owns the
foreign key, whether the pair is one-to-one or many-to-one, whether storage is a
row reference or a junction, whether that storage is unique, and whether a
model-target singular slot may be empty are **derived once per schema** by the
topology owner in
[`../validation/relation-resolution.ts`](../validation/relation-resolution.ts).
Nothing in this directory pairs slots, scans for an inverse, or asks whether a
target is registered.

Cardinality is a property of the SLOT; polymorphism is a property of the TARGETS.
The two are independent axes and always were — which is why there is no
polymorphic factory family, only a second shape of argument.

In schema taxonomy, relations are one concrete kind of model field. The other
concrete kind is scalar. Keep `field` wording when referring to model keys,
foreign-key fields, junction fields, or the public `.fields()` relation API;
use `relation` when referring to relation terminals, relation state, or relation
operation schemas.

## Why This Layer Exists

Relations have two challenges:

1. **Circular references**: User has Posts, Post has Author (User). JavaScript
   can't reference variables before declaration.
2. **TypeScript inference**: We need the target model's type, but can't access
   it until configuration is complete.

The solution: **thunks** `() => Model` defer model resolution, and **chainable
methods** build configuration immutably.

---

## Entry Points

| File | Purpose |
|------|---------|
| `types.ts` | The closed declaration-state union: `RelationState`, `RelationSlot`, `RelationInternal`, `VariantEntry`, `ReferentialAction`, `Getter` |
| `to-one.ts` | `s.toOne` — the singular factory, its model-target terminal, and the transient `ReferencesStage` |
| `to-many.ts` | `s.toMany` — the collection factory and its model-target terminal |
| `polymorphic.ts` | Variant normalization (`normalizeVariantEntries`) plus the two variant terminals |
| `terminal.ts` | Shared immutable-terminal machinery: the construction-time refusal (`refuseRelationInput`), plain-record reads, the source-independent target once-cell |
| `clearability.ts` | The two emptying facts: `slotMayBeEmpty`, `clearableMembership` (+ its boolean projection `membershipCanBeCleared`) |
| `static-membership.ts` | The ONE compile-time projection of the relation graph — nullability, nested omission, clearability — and nothing else |
| `helpers.ts` | Relation physical naming: stored-reference indexes plus junction tables, side tokens, expanded columns, and constraint names |
| `junction-topology.ts` | The one owner of resolved junction physical facts — table, both complete ordered sides, canonical order, pair identity, derived constraint names — for ordinary pairs and for variant members alike. Deliberately NOT re-exported from `index.ts`; consumers deep-import it |
| `index.ts` | The barrel. The four terminal implementations are deliberately absent |

---

## The Declaration Surface

| Declaration | Slot cardinality | Target domain | Storage the resolver derives |
|-------------|------------------|---------------|------------------------------|
| `s.toOne(() => model)` | one | one model | a foreign key, on whichever endpoint declared `.fields(...)` |
| `s.toMany(() => model)` | many | one model | a foreign key on the singular partner, or a junction when the partner is also a collection |
| `s.toOne(map, options?)` | one | named variants | a private `(type, id)` pair on this row |
| `s.toMany(map, options?)` | many | named variants | one fixed-target member junction per variant |

### Model-target singular — `s.toOne(() => model)`

```typescript
s.toOne(() => user)
  .name("author")               // Pairing label; matched EXACTLY on both endpoints
  .fields("authorId")           // FK scalar field-key(s) on this model
  .references("id")             // Referenced scalar field-key(s) on target
  .onDelete("cascade")          // Referential action on delete
  .onUpdate("cascade")          // Referential action on update
```

`.fields(...)` returns a **`ReferencesStage`**, not a relation. It carries no
relation brand, exposes only `.references(...)` and `.name(...)`, and `s.model()`
refuses it outright — so a half-written foreign key can never become schema
state. `.references(...)` is arity-locked to the field tuple at the type level.
Both tuples are non-empty and reject repeated members at their declaration
calls.
The referential actions appear only on the completed value, because there is no
foreign key to act on before it.

There is **no `.optional()`**. Owner emptiness follows from the foreign-key
scalars under the any-nullable-member rule; non-owner emptiness is derived from
non-ownership. There is **no `.unique()`** anywhere: the paired slot cardinality
is the one statement of remote uniqueness.

### Model-target collection — `s.toMany(() => model)`

```typescript
s.toMany(() => tag)
  .name("tags")                 // Pairing label; matched EXACTLY on both endpoints
  .through("post_tags")         // Junction table name
  .source("postId")             // THIS endpoint's token
  .target("tagId")              // The other endpoint's token
  .onDelete("cascade")          // Junction referential action
  .onUpdate("cascade")
```

The junction overrides are independent, meaningful facts rather than stages of
one all-or-nothing value, so any subset may override its canonical default and
trusted state stores `junction` only when one was declared (never `{}`).

**One physical junction, one configuration owner.** Exactly one endpoint carries
every override; the resolver mirrors it for the other (`mirrorOverrides` swaps
source and target). Two configuring endpoints is `R011`. `.source()` is always
oriented from the endpoint that spells it, which is why moving a configuration
across the pair swaps the two tokens and leaves the table unchanged.

`.source()` and `.target()` always take one string token. For a scalar endpoint
row key the token is the exact junction column name. For a compound row key it is
a prefix expanded positionally as `<prefix>_1`, `<prefix>_2`, … in the model
row-key order. Do not expose an array API or derive suffixes from mapped SQL
column names: the ordered `ResolvedJunctionSide` owns the complete
column-to-referenced-field correspondence.

Generated ordinary junction names use the registered SCHEMA KEYS for the table
and non-self side tokens. They do not use JavaScript variable names or mapped
model table names, so a schema-key rename changes generated junction storage.
The complete `.through().source().target()` configuration pins those three
physical names.

`JunctionReferentialAction` excludes `setNull` at the TYPE level: every junction
side is a non-null membership-key member, so the action would null the column
that carries the membership itself.

### Variant targets — a map instead of a getter

```typescript
s.toOne({
  post: () => post,
  video: () => video,
})
  .name("commentable")
  .optional()
```

The same two factories carry variant targets; only the argument changes. A
variant map needs literal keys and at least one entry — `VariantMapGuard` refuses
a string index signature or an empty map at the TYPE level, `GetterOnly` refuses
"not a map and not a getter", and `normalizeVariantEntries` refuses the runtime
equivalents at construction with a `ValidationError` whose source is
`schema-builder`.

A **variant `s.toOne`** is the one relation shape that keeps `.optional()`,
because that flag IS the nullability of its two private `(type, id)` columns —
there are no foreign-key scalars to read it from. A **variant `s.toMany`** has no
`.optional()` (an empty collection is already the empty case) and instead names
its member junctions through an exact `.through(...)` map keyed by public
variant, `{ table, source, target }` per entry, exact at both levels.

Generated member-junction tables start with the owner's mapped SQL table, while
their owner-side token comes from the owner SCHEMA KEY; the target token comes
from the public variant. One exact `.through(...)` entry pins all three.

The target-map key is the public query/result discriminator; `storedValue` is
the string written to storage, defaulting to the key. They are two facts, so a
renamed public key with a preserved stored value is metadata-only. Pass the exact
`{ values }` options bag when storage needs namespaced or versioned values —
the whole bag is exact, not just `values`, so a sibling key is refused
structurally rather than sailing through excess-property checking.

Each variant has its own getter, so recursive declarations stay lazy without
widening the outer key map. Reading a property's value never invokes a target
thunk.

---

## The Canonical State

`RelationState` is a closed four-arm union in `types.ts`:

```typescript
type RelationState =
  | ModelToOneState      // cardinality "one",  target { kind: "model" }
  | ModelToManyState     // cardinality "many", target { kind: "model" }
  | VariantToOneState    // cardinality "one",  target { kind: "variants" }
  | VariantToManyState;  // cardinality "many", target { kind: "variants" }
```

Rules the union enforces, not by etiquette but structurally:

- **One canonical representation per optional property.** The property is absent,
  or it holds the one normalized value. Trusted state never stores explicit
  `undefined`, `false`, an empty override object, or a partial foreign key.
- **`?: never` exclusions** make illegal cross-arm configuration fail under
  structural assignment too — a `ModelToOneState` cannot carry `junction`, a
  collection cannot carry `optional`.
- **No source model.** `.extends()` may reuse one terminal under more than one
  model or key, so `(model, field)` — `RelationSlot` — is the whole contextual
  identity, and the declaration is read from that model's canonical relation map
  rather than copied into the identity. Nothing binds a source into the state,
  before or after construction.
- **No topology.** No partner, no ownership flag, no `unique`, no derived
  optionality, no four-way family discriminant.
- **`Replace<State, Patch>` is last-call-wins.** Every modifier REPLACES its own
  fact rather than intersecting with the prior one, so repeating `.name(...)`
  keeps the last literal instead of collapsing to `never`.
- **The broad state arms use `any` for the getter, deliberately.** Constraining a
  function-typed member forces TypeScript to resolve recursive getter returns;
  that resolution is circular in mutually recursive schemas and silently
  collapses both model consts to `any`. Concrete factory states retain the exact
  getter or getter-map generic.

Every terminal exposes one internal accessor under `"~"`: `RelationInternal`
with the frozen `state` and `settleTarget`, a source-independent lazy once-cell.
The first caller settles a target's raw getter return OR one normalized `Error`,
and every later consumer — in this schema graph or another one reusing the same
immutable terminal — observes that same outcome. It is derived cache state, not a
declaration fact: the resolver decides whether a settled return is a registered
model and owns the contextual diagnostic, so nothing model-specific is cached
here. `AnyRelation` is matched by that brand, and trusted relation state
originates only in these two factories.

---

## Where the Facts Are Decided

Every structurally knowable fact is judged **at the call the author wrote** —
`refuseRelationInput` throws a `ValidationError` with
`source.kind === "schema-builder"` and the builder label `s.toOne` / `s.toMany` /
`s.model`. Facts that need the schema graph belong to the resolver and surface as
`SchemaValidationIssue`s. Nothing in between.

| Fact | Owner | Failure |
|------|-------|---------|
| target is a getter or a legal variant map | the factory | construction-time refusal (`V4002`) |
| variant keys are identifiers; `values` is exact | `normalizeVariantEntries` | construction-time refusal |
| `.fields(...)` is non-empty and reaches `.references(...)` of equal arity | the terminal + the type | construction-time refusal / compile error |
| an incomplete stage is not a relation | `s.model()` | member classification refusal |
| target model is registered | resolver | `R006` (variant: `P001`) |
| this slot has a partner | resolver | `R002` |
| exactly one partner | resolver | `R009` |
| the claimed name is answered | resolver | `R010` |
| exactly one foreign-key owner | resolver | `CM003` / `FK004` |
| unique storage agrees with the paired cardinality | resolver | `FK009` |
| exactly one junction configuration owner | resolver | `R011` |
| a modifier sits on a slot that may carry it | resolver | `R012` |
| one junction table per pair | resolver | `JT001` |
| a carrier's inverses agree on cardinality | resolver | `P012` |

**Pairing is a graph, not a ladder.** Candidates are collected structurally, then
partitioned by the exact relation-name claim, then counted. No candidate wins by
being ordinary, variant, first, or sole. Unnamed pairs with unnamed; a name pairs
only with the same exact name. A variant member whose post-partition candidate
set is empty is a valid **direct-only** member — the differently-named ordinary
slot that could have been its partner reports its own failure at its own owner.

---

## The Two Emptying Facts

`clearability.ts` owns both, and they are deliberately TWO. Both read the
RESOLVED edge; neither rescans the graph and neither reads a declared
`.optional()` flag on a model-target relation, because that flag no longer
exists.

- **`slotMayBeEmpty(resolved)`** — the PUBLIC shape: may this relation hold
  nothing? It is what makes `delete` spellable. A collection always; a foreign-key
  owner when any local member accepts NULL, because one absent member makes the
  whole membership absent; a non-owner always, because the membership lives on
  the other row and may simply be missing; a row-held variant carrier exactly
  when its private type column is nullable.
- **`clearableMembership(resolved)`** — PHYSICAL storage: HOW is the membership
  cleared while both records survive? That is what makes `disconnect` spellable,
  and it is not a boolean. A junction clears by deleting its membership row
  (`kind: "junctionRow"`); a row reference clears by nulling an exact ordered
  subset of its columns (`kind: "columns"`), so a mixed compound foreign key
  nulls its nullable members and keeps its required context ones; otherwise
  `kind: "none"`.

An optional slot whose child-side foreign key cannot be nulled is a legal schema
whose operation surface offers `delete` without `disconnect`. No consumer may
derive one fact from the other.

The write engine does not read this module. It answers the physical question from
BOUND membership (`query-engine/write-engine/relation-nullability.ts`), which is
the only reading available on a trusted internal program that never passed the
public schema — see the guard-ownership ledger for the coverage that keeps that
guard alive.

---

## The Compile-Time Projection

`static-membership.ts` is the ONE type-level mirror of the graph, and it mirrors
only the predicate it can PROVE, in seven steps: keep the asking identity; read
the target model's one relation map and exclude the asking slot; collect ordinary
slots and variant members targeting the source model; keep candidates whose
literal `.name(...)` claim exactly matches; require exactly one candidate AND
prove that candidate's own candidate set is exactly the asking slot (the mutual
degree-one rule); derive owner identity, the ordered foreign-key tuple and its
nullable subset, and clearability only after that proof; otherwise answer
`unknown`.

`unknown` means **fail closed**: omit nothing, expose no disconnect form, infer
nullable wherever requiredness is unproven. A widened or dynamic declaration is
conservatively sound rather than guessed — it may retain a foreign-key input the
runtime can derive, or admit a `null` the runtime rules out, but it never omits a
possibly required field, claims non-nullability without proof, or exposes an
unsafe mutation verb. A model reached through `.extends()` is one such case: its
relations' getters name the BASE model, so nothing pairs with the derived model
and every slot answers `unknown`.

The mutual proof addresses its candidate by **key**, never by value: on a self
junction the two halves are type-identical, so a value-keyed exclusion answers
both keys, excludes both, and silently collapses a provable junction to
`unknown`.

---

## Core Rules

### Rule 1: Thunks for Target Models
Always use `() => Model` thunks to defer evaluation:

```typescript
// ✅ Thunk defers evaluation until needed
s.toMany(() => post)

// ❌ Direct reference fails (post not yet defined)
s.toMany(post)  // ReferenceError!
```

**Why:** JavaScript hoisting doesn't help with `const`. The thunk is called later
when both models exist — and only ever once, through `settleTarget`.

### Rule 2: Immutable Chainable Methods
Every method returns a NEW frozen value with updated state:

```typescript
s.toOne(() => user)             // ModelToOneRelation<{ cardinality: "one", … }>
  .fields("authorId")           // ReferencesStage — NOT a relation
  .references("id")             // ModelToOneRelation<{ …, foreignKey: { … } }>
```

**Why:** TypeScript tracks state changes through the generic parameter. Mutation
would desync types from runtime.

### Rule 3: Both Endpoints, One Owner
Every ordinary relation is a PAIR. Declare both slots; give exactly one of them
the foreign key (or the junction configuration):

```typescript
// Post HAS the FK (authorId), so it completes .fields().references()
const post = s.model({
  authorId: s.string(),
  author: s.toOne(() => user).fields("authorId").references("id"),
});

// User does NOT have the FK — but it must still declare its side
const user = s.model({
  posts: s.toMany(() => post),
});
```

### Rule 4: Foreign Key Field Must Exist
The FK scalar field-key passed to `.fields()` must be an actual scalar field in
the model. The resolver's `FK001`/`FK002`/`FK003` own that check, against the
hydrated schema.

### Rule 5: Names Are Claims, Matched Exactly
`.name()` is a pairing label, not a column. Two endpoints of one relationship
must claim the same exact name; a name no candidate answers is `R010`, and
several unnamed candidates between the same two models are `R009`. On an FK edge
the name stays pairing-only and never alters columns or constraints; on a
junction it suffixes the generated table name so several relationships between
the same models never collide.

---

## Anti-Patterns

### Direct Model Reference
Passing `post` instead of `() => post`. JavaScript can't reference variables
before declaration.

### A Lone Slot
Declaring one side and expecting the other to be inferred. Every ordinary
relation needs a complete inverse — including a self relation, whose two slots
live on the same model.

### Configuring Both Endpoints
Repeating `.through()` / `.source()` / `.target()` on both collection slots, or
completing `.fields(...).references(...)` on both singular slots. One physical
fact has one owner.

### Restating a Derived Fact
Reaching for an optionality flag, a uniqueness modifier, or a second name
registry. If a fact can be derived from the pair, it is — and the derivation has
exactly one owner.

---

## Referential Actions

| Action | Behavior | Where |
|--------|----------|-------|
| `cascade` | Delete/update child records when parent is deleted/updated | FK + junction |
| `setNull` | Set FK to NULL when parent is deleted/updated | FK only, and only when every member is nullable |
| `restrict` | Prevent delete/update if child records exist | FK + junction |
| `noAction` | Database default (usually same as restrict) | FK + junction |

```typescript
s.toOne(() => user)
  .fields("authorId")
  .references("id")
  .onDelete("cascade")   // Delete posts when user is deleted
  .onUpdate("cascade")   // Update FK when user.id changes
```

---

## Relation Operation Schemas

Relation operation schemas are built by `SchemaRegistry` in
`src/validation/relations/` from the RESOLVED slot and full model graph context.

To-one mutation compatibility belongs to L3 validation. Create payloads and
parent-held updates have at most one active verb. Child-held updates also admit
the fixed vacate-then-supply pairs that the relation owner can execute in
canonical order. `false` remains a no-op for boolean verbs. To-many schemas
remain keyed bags because combining operation kinds is part of their contract.

### Filter (WHERE)

```typescript
// Singular: is, isNot
where: { author: { is: { name: "Alice" } } }

// Collection: some, every, none
where: { posts: { some: { published: true } } }
where: { posts: { every: { authorId: "123" } } }
where: { posts: { none: { deleted: true } } }
```

### Create / Update (Nested)

```typescript
create: {
  posts: {
    create: [{ title: "New Post" }],
    connect: [{ id: "existing-id" }],
    connectOrCreate: { where: { id: "..." }, create: { /* … */ } }
  }
}

update: {
  posts: {
    create: [{ title: "New" }],
    update: [{ where: { id: "1" }, data: { title: "Updated" } }],
    delete: [{ id: "2" }],
    // Available only when the membership can be cleared.
    disconnect: [{ id: "3" }],
  }
}
```

### Variant inputs — row-held (`s.toOne(map)`)

Direct create accepts exactly one of `connect`, `create`, or `connectOrCreate`:

```typescript
{ connect: { type: "post", where: { id: "post_1" } } }
{ create: { type: "video", data: { title: "New video" } } }
{ connectOrCreate: { type: "post", where: { id: "post_1" }, create: { id: "post_1", title: "New" } } }
```

Direct selected update accepts `connect`, `create`, `connectOrCreate`, correlated
`update`, and `upsert`. Optional storage also accepts `disconnect` and typed
target `delete`.

A bound plural inverse keeps its ordinary read, filter, count, order and
pagination surface and exposes the safe child-held write family:
create/createMany/connect/connectOrCreate/upsert on create, plus targeted update
with full child update data, updateMany with full relation-bearing child update
data (the owning direct variant key omitted), and delete/deleteMany on update.
Clearable child storage also exposes disconnect. To-many `set` is present for
optional and required storage; required storage rejects departing members.

A bound singular inverse returns one record or `null` and uses the ordinary
singular surface: create/connect/connectOrCreate on create;
create/connect/connectOrCreate/update/upsert on update. Its public slot is always
optional, so delete is available; disconnect is available only when the child's
direct variant storage is optional and can be cleared.

A row-held edge stores one membership, so collection `set` does not apply to it.
Root `createMany` rows accept the ordinary create data shape; the row-held
membership itself stays connect-only. Target probes are grouped by relation and
discriminator before the existing grouped INSERT plan. Inverse nested createMany
may satisfy its one owning required variant relation, but remains unavailable
when another required variant relation would be unsatisfied.

### Variant inputs — junction-held (`s.toMany(map)`)

A collection's input is a keyed BAG, not a one-intent union: several verbs may
appear together and an empty bag is inert. Every verb takes one tagged item or an
array of them, and the discriminator sits INSIDE each item — which is what
correlates the `type` literal with that variant's own `where` / `data` schemas.

A fresh owner names four supply verbs — `create`, `createMany`, `connect`,
`connectOrCreate`. A located owner names all ELEVEN: those four plus `set`,
`disconnect`, `delete`, `deleteMany`, `update`, `updateMany`, `upsert`. `upsert`
is deliberately absent from the create bag: its found arm is scoped to THIS
owner's membership and a fresh owner has none, so the only alternatives would be
a silent global adopt or a grammar the engine must refuse.

`disconnect` is UNCONDITIONAL — a member junction row always clears, because the
row goes and no column is nulled — and there is no `disconnect: true` spelling;
`set: []` carries that meaning. `set` clears every configured variant exactly
once, including variants the payload never mentions, then refills.

Root `createMany` is NOT restricted here. A row naming a collection is
relation-bearing, so the whole call routes to the ordered record series and the
row mounts the same four supply verbs any other create context does.

Both inverse arities are ORDINARY. A plural inverse is a fixed-variant junction
view and takes the ordinary to-many families whole. A singular inverse is a to-one
SLOT — one member-junction row under a UNIQUE over the complete target side — and
takes the ordinary to-one create and update families verbatim, with
`disconnect: true` deleting the junction row and `delete: true` deleting the
connected owner row. `GetRelationSchemas` dispatches on cardinality alone; there
is no variant inverse family.

---

## Invisible Knowledge

### Public and stored discriminators are different

Renaming a public target-map key is metadata-only when its stable stored value
and physical target remain unchanged. Changing or removing a stored value, or
retargeting it, requires explicit migration-history acknowledgement after the
caller performs the needed DML.

### Variant storage has no database foreign key

The owner table gets private `<relation>_type` and `<relation>_id` columns plus a
composite `(type, id)` index. The index is unique when the carrier's inverses are
singular; this prevents two owner rows from selecting the same exact target
across all discriminators. No portable foreign key can point to several tables.
Empty optional storage parses as `null`. A non-empty known membership whose
target is missing raises `QueryEngineError` regardless of optionality; unknown or
half-null storage is malformed provider data.

### Why the terminals are separate values, not one class

Each capability surface is exactly the set of methods its arm may legally carry,
so an illegal modifier is a compile error rather than a runtime refusal. The
concrete implementations stay private: callers see only what `toOne` and `toMany`
return. An earlier shared base class caused TypeScript inference problems; the
measured reason is that, not a type hole.

### Why junction constraint names stay lazy

`ResolvedJunctionTopology` exposes constraint names as memoized METHODS. The gate
asks all four during resolution, so a published edge carries them settled;
laziness is what keeps the equal-token refusal attached to the first ask rather
than to construction.

---

## Junction Ownership and Coverage

Junction identity is resolved by the topology owner, which hands
`junction-topology.ts` an already-paired, already-oriented junction. Nothing in
`helpers.ts` or `junction-topology.ts` reads a relation object or a second
endpoint's declaration. Ordinary pairs and variant member junctions differ only
in where their tokens come from, so they share one derivation and one refusal set
(`expandJunctionFieldGroups` owns row-key emptiness, token validity, expanded
field validity, and the cross-side collision).

The canonical physical side order is `junctionSourceSideIsFirst`: lowercased
model names, and for a self junction the joined field lists as the tiebreak.

Two paired self collection slots may use the field-derived default side tokens
(`<field>Id` for a scalar row key, `<field>` as a compound prefix) instead of
being forced to configure them explicitly.

Use `pnpm test:coverage:relations` for the one-worker, memory-capped L4 report.
It gates `src/schema/relation/**/*.ts` at 100% statements, branches, functions,
and lines and writes `coverage/relations/index.html`. The suite is pure and must
not boot a database or require a provider.

L4 tests only declarations, immutable terminal state, construction-time refusals,
clearability, the static projection, and junction physical naming. Pairing,
ownership and diagnostics are L5 (`tests/schema-validation/`). Relation create,
update, filter, ordering, and projection schemas are L3 operation schemas and
live under `tests/unit/operation-schemas/relations`.

---

## Related Layers

| Layer | Relationship |
|-------|--------------|
| **Scalars** ([scalars/AGENTS.md](../scalars/AGENTS.md)) | FK scalar fields stored alongside relation fields; their nullability IS relation optionality |
| **Model** (`../model/`) | Composes relation fields into models; refuses a transient references stage |
| **Schema Validation** (`../validation/`) | `relation-resolution.ts` — the ONE topology owner; publishes the `ResolvedRelationIndex` every consumer threads |
| **Migrations** ([migrations/AGENTS.md](../../migrations/AGENTS.md)) | Creates FK constraints, junction tables, and variant storage from resolved edges |
| **Validation** ([validation/AGENTS.md](../../validation/AGENTS.md)) | Builds relation filter/create/update schemas through `SchemaRegistry` |
