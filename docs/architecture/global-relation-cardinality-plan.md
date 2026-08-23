# Unified Relation Language Plan

**Status:** final design; implementation pending
**Scope:** public relation declarations, relation topology, validation, derived
type/query views, and the source-estate conversion
**Storage baseline:** the implemented contracts in
[`polymorphic-cardinality-plan.md`](./polymorphic-cardinality-plan.md) remain
authoritative unless this plan explicitly changes them

## 1. Decision

VibORM will expose exactly two relation factories:

```ts
s.toOne(() => user);
s.toMany(() => post);

s.toOne({
  post: () => post,
  video: () => video,
});

s.toMany({
  post: () => post,
  video: () => video,
});
```

Each declaration states two independent facts:

1. The factory states the **slot cardinality**: one or many.
2. The argument states the **target domain**: one model or named variants.

“Polymorphic” is therefore not a third relation family and not another thing a
user must learn. It is the derived observation that the target domain contains
named variants.

The plan adds no inverse-selector API and no atomic foreign-key object.
Prisma-style `.name(...)` remains the one disambiguation mechanism;
`.fields(...).references(...)` remains the one ordinary FK declaration
mechanism. The redesign compresses those existing facts—it does not place a
second spelling beside them.

The following factories are deleted, without aliases or deprecation shims:

- `s.oneToOne`
- `s.manyToOne`
- `s.oneToMany`
- `s.manyToMany`
- `s.polymorphicToOne`
- `s.polymorphicToMany`

The four old ordinary topology names also stop being declaration state.
One-to-one, many-to-one, one-to-many, and many-to-many are derived from the two
paired slots by one schema-wide topology owner.

This is an unreleased-project source break. There is no old-state reader, old
factory export, dual representation, or runtime compatibility branch.

## 2. Goal, constraints, and completion

### 2.1 Goal

Make every relation in VibORM use one small language:

```text
local cardinality × target domain → resolved membership
```

The same declaration algebra must drive:

- public schema authoring;
- definition validation;
- operation input schemas;
- client result types;
- query planning and result parsing;
- write relation binding;
- migration serialization and introspection;
- documentation and diagnostics.

### 2.2 Constraints

1. Follow [`ELEGANCE.md`](../../ELEGANCE.md): store only independent facts,
   derive every view from one owner, and delete parallel representations.
2. Preserve the already implemented physical behavior of variant to-one and
   variant to-many storage.
3. Keep lazy getters so recursive models remain valid and naturally inferred.
4. Keep modifiers that are impossible from local declaration facts unavailable
   through the public type surface. Reject graph-dependent modifier placement at
   the full-schema boundary, where the paired topology is known.
5. Make structural topology invalidity fail before query or migration effects.
6. Keep query-engine decisions dialect-neutral and physical SQL in adapters.
7. Preserve ordinary and polymorphic write semantics, including compound keys,
   singular junction transfer, atomicity, and strict result integrity.
8. Do not claim compatibility for incomplete or ambiguous schemas merely
   because current HEAD accepted them with a warning or precedence fallback.

### 2.3 Done when

The work is complete only when:

- `s.toOne` and `s.toMany` are the only public relation factories;
- a model has one stored relation map;
- a relation stores cardinality and target domain once;
- one full-schema resolver owns pairing, ownership, and physical membership;
- all consumers use its derived index and no consumer rescans for an inverse;
- old declared topology types, mutable source binding, polymorphic carrier
  facades, and parallel variant maps are deleted;
- the canonical DDL corpus is unchanged;
- every accepted new topology and every deliberate refusal has a falsifier;
- all tracked live examples use the new API;
- the validation gates in §12 are green.

## 3. Elegance ledger

This section is the architectural budget. A concept not listed here must prove
that it owns an independent fact before it is added.

### 3.1 Stored declaration facts

| Fact | Sole owner |
|---|---|
| Local slot cardinality | `toOne` or `toMany` |
| Target domain | Factory argument |
| Endpoint relation-name claim | The declaring relation slot |
| Variant singular optionality | `.optional()` on a variant to-one |
| FK stored reference and actions | The complete normalized result of `.fields(...).references(...)` plus action modifiers |
| Ordinary junction overrides | One endpoint's fluent override state |
| Variant discriminator storage value | The corresponding normalized variant entry |
| Variant member-junction override | The corresponding normalized variant entry |

### 3.2 Derived facts

The declaration does **not** store:

- resolved pair identity, which the full-schema topology owner derives from
  structural compatibility and matching optional relation-name claims;
- one-to-one, one-to-many, many-to-one, or many-to-many;
- whether an edge uses a row FK or a junction;
- which endpoint owns the FK;
- whether that FK or target-side junction tuple is unique;
- whether a model-target owner-held singular slot may be empty, which follows
  from the nullability of its complete local FK scalar tuple;
- whether a relation is “ordinary” or “polymorphic” as a family label;
- a second source model pointer on the relation object;
- a second model map for variant relations;
- parallel target, discriminator-value, and through maps.

Those facts are derived once from the full schema graph.

### 3.3 Irreducible capability surfaces

Four derived capability surfaces remain because their legal local facts differ.
They are not four public relation concepts:

| Factory call | Terminal capability |
|---|---|
| `toOne(getter)` | ordinary FK-capable to-one |
| `toMany(getter)` | ordinary junction-capable to-many |
| `toOne(variantMap)` | row-held variant to-one |
| `toMany(variantMap)` | member-junction variant to-many |

Use narrow immutable terminal implementations to expose only locally meaningful
modifiers. They are private implementation shapes, not package exports or
public relation concepts. Do not replace them with a permissive builder whose
methods conditionally fail at runtime, or add a base class, strategy hierarchy,
manager, or context object merely to reduce the implementation count.

### 3.4 Concepts deleted

The final implementation deletes:

- six old public factory names;
- declared four-way `RelationType` state;
- `ManyToManyRelation` as a declared topology class;
- the separate polymorphic relation field category;
- stored `relations` plus `polymorphicRelations` maps;
- standalone pairing-name registries and consumer-side name scans (the two
  endpoint labels remain declaration claims reconciled by the topology owner);
- mutable `RelationState.source` and `setSource()`;
- named-polymorphic, ordinary-first, and sole-polymorphic precedence ladders;
- loose pairing and first-candidate fallbacks;
- ownerless warning-only ordinary edges;
- relation `.unique()` as a second statement of remote cardinality;
- partial FK state admitted as a relation and every ordinary relation
  `.optional()` flag;
- junction `.A()` / `.B()` vocabulary and its source/target translation;
- parallel variant `targets`, `values`, and `through` maps;
- the model-owned `_polymorphicStorage` topology map and its
  `polymorphicStorage`/`getPolymorphicStorage`/`setPolymorphicStorage` accessors;
- the query-scope `polymorphicRelationsByModel` cache,
  `QueryScope.polymorphicRelations`, `PolymorphicRelationInfo*`, and
  `ResolvedPolymorphicEdge` facades;
- synthetic ordinary carrier relations used to enter junction write code;
- the adapter/result-parser argument carrying an old topology name;
- all zero-argument `.fields()` compatibility logic;
- temporary source-conversion tooling after it has rewritten the estate.

This deletion does not rename or remove generated migration-snapshot
`polymorphicStorage` metadata or write-time `PolymorphicStorageValue` payloads.
Those are historical/physical metadata and execution values, not independent
topology owners.

## 4. Exact public contract

### 4.1 Overloads

Each factory has two explicit overload families. Do not implement one vague
getter-or-object generic signature.

```ts
toOne(getter): ModelToOneRelation;
toOne(variants, options?): VariantToOneRelation;

toMany(getter): ModelToManyRelation;
toMany(variants, options?): VariantToManyRelation;
```

The getter form has no second argument. The map form accepts one exact optional
configuration object:

```ts
s.toOne(
  {
    post: () => post,
    video: () => video,
  },
  {
    values: {
      post: "content.post.v1",
      video: "content.video.v1",
    },
  },
);
```

Runtime dispatch examines only the argument representation:

```ts
typeof target === "function" // one-model target
otherwise                     // validate and normalize a variant target
```

Dispatch never invokes a getter. For a non-function input, the factory reads the
target/options snapshot once, validates every structurally knowable fact, and
either constructs the normalized entry map or throws the existing
`ValidationError` with code `V4002` and
`source.kind === "schema-builder"`. Malformed input never enters trusted relation
state. Full-schema resolution later owns only facts that require invoking
getters or seeing other models.

Put the map overload before the broad lazy-getter overload, and preserve the
existing recursion-safe conditional-generic technique. Concrete terminal
classes and constructors are not package exports or user-facing named types.
The factory signatures expose their legal structural capabilities, and all
trusted state originates in the two factories and immutable modifiers.

### 4.2 Variant-map contract

A variant target map obeys these rules:

- a literal map has at least one key;
- a broad TypeScript string-index map is rejected because it has already lost
  the finite key union required for discriminated operations;
- dynamic JavaScript input is still validated at runtime, including emptiness;
- the runtime map and options are plain-prototype records with own enumerable
  string keys; symbol keys and inherited entries are not variant declarations;
- every entry is a lazy model getter;
- a direct model object is rejected with guidance to write `() => model`;
- public variant keys pass the existing schema-identifier rule and are the
  query, mutation, and result discriminators;
- omitted `values` uses each public key as its stored discriminator value;
- explicit `undefined` options are equivalent to omission;
- `{}` is not a valid options object; omit it to use defaults;
- when present, `values` is total and exact over the variant keys;
- missing and extra `values` keys fail for fresh and non-fresh objects;
- unknown sibling option keys fail for fresh and non-fresh objects;
- stored values pass the existing stored-discriminator grammar and are unique
  inside the relation;
- stored values never become public result discriminators;
- normalized state stores runtime discriminator strings but does not carry
  their literal types when no public type consumer uses them;
- construction snapshots the map and options, so later caller mutation cannot
  change schema truth;
- each own property at both map levels is read once during that snapshot;
- every normalized entry and the containing map are frozen;
- a one-key map is valid and has no warning.

A target model may appear under more than one variant key for direct use. If a
public inverse points at that carrier and its source model matches more than one
variant, topology resolution reports ambiguity. The resolver does not guess a
variant and does not forbid the useful direct-only declaration.

### 4.3 Modifier matrix

Only the following modifiers exist:

| Declaration | Available modifiers |
|---|---|
| `toOne(getter)` | `.name(value)`, `.fields(...).references(...)`, then FK actions |
| `toMany(getter)` | `.name(value)`, `.through(table)`, `.source(token)`, `.target(token)`, `.onDelete(action)`, `.onUpdate(action)` |
| `toOne(variants)` | `.name(value)`, `.optional()` |
| `toMany(variants)` | `.name(value)`, `.through(exactVariantConfig)` |

Rules:

- `.optional()` exists only on a variant-target to-one terminal. A model-target
  owner derives emptiness from its complete local FK scalar tuple; its
  non-owning singular view is derived nullable. An empty to-many value is `[]`.
- A model-target `toOne` without a completed `.fields(...).references(...)`
  declaration is a non-owning inverse and
  is nullable by derivation. It does not expose `.optional()`.
- `.fields(...)` starts FK ownership and returns a transient references stage,
  not an `AnyRelation`. Apart from `.name(...)`, that stage
  must eventually receive `.references(...)` before it can be used as a model
  field:

  ```ts
  s.toOne(() => user)
    .name("PostAuthor")
    .fields("authorId")
    .references("id")
    .onDelete("cascade")
    .onUpdate("cascade");
  ```

- Both calls require non-empty tuples. `.references(...)` checks equal arity,
  snapshots both rest-argument arrays, and returns a valid owner terminal whose
  trusted state contains one complete normalized FK value. The transient stage
  is neither exported as a relation terminal nor accepted by `s.model(...)`.
- A completed owner may start another `.fields(...)` stage. Completing that
  stage atomically replaces the prior fields/references while preserving its
  name and FK actions on the newly returned value; the prior owner remains
  unchanged and valid. There is no separate “already configured” terminal.
- FK actions are available only after that complete reference exists. A name
  may be stated before,
  between, or after the fields/references calls; the transient stage exposes
  only `.references(...)` and `.name(...)`. It never
  exposes FK actions or a relation brand, so a name cannot make an incomplete
  FK into trusted schema state.
- A row-held FK membership is absent when any member of its complete tuple is
  null. The slot is therefore nullable and the membership is disconnectable
  when at least one local member is nullable. Disconnect clears every nullable
  member and retains required context members. Database `setNull` remains legal
  only when every FK member is nullable because the referential action nulls
  the whole tuple. This is the current portable `MATCH SIMPLE` contract;
  VibORM does not silently introduce `MATCH FULL` semantics for compound FKs.
- `.name("PostAuthor")` is the existing Prisma-style rendezvous label. It is
  optional when structural matching yields one pair. On an edge with two public
  endpoints, both must state the same non-empty name; one-sided, mismatched, or
  multiply matched names are definition errors. A valid direct-only variant may
  carry a name without manufacturing an inverse. The topology resolver is the
  sole reconciliation owner—there is no separate name registry or consumer
  fallback.
- A relation name is only a non-empty pairing string, not a SQL identifier. If
  an ordinary junction uses that name to derive its default table, physical
  identifier validation belongs to `junction-topology.ts`. An explicit valid
  `.through(...)` therefore permits pairing labels such as `"Post tags/v2"`
  without pretending that the label itself is a database name.
- There is no relation `.unique()`. The paired slot cardinality owns uniqueness.
- FK actions exist only on the slot that owns an ordinary row FK.
- `.fields(...)` and ordinary junction modifiers are necessarily offered
  before the inverse graph exists. Their local argument shapes are type-checked;
  whether they belong on the resolved physical owner is one full-schema
  topology rule, not a second type-level guess.
- A variant to-one owns private storage and exposes no public FK columns or FK
  action modifiers.
- A variant to-many owns one member junction per variant. Its referential
  actions retain the implemented fixed storage policy; an inverse cannot
  override them.
- Every modifier returns a new immutable value and preserves literal state.
  `.fields(...)` returns the immutable pending references stage;
  `.references(...)` promotes it to a relation terminal.
- Every available setter uses immutable last-call-wins semantics: repeating
  `.name(...)`, an FK action, `.optional()`, `.through(...)`, or a junction
  override changes only the newly returned value. The original value remains
  unchanged. `.name(...)` therefore composes with FK stages and ordinary
  junction configuration without a typestate permutation for every order.

### 4.4 Ordinary junction configuration

The existing fluent overrides remain because they are independent, meaningful
facts rather than stages of one all-or-nothing value:

```ts
s.toMany(() => tag)
  .through("post_tags")
  .source("postId")
  .target("tagId")
  .onDelete("cascade")
  .onUpdate("cascade");
```

Any subset may override the corresponding canonical default. Exactly one
endpoint owns all supplied overrides; the other endpoint supplies none and
consumes the mirrored resolved view. This deletes pair-side reconciliation
without changing useful table-only, side-only, or action-only declarations.
Repeated modifiers replace only their own fact on the newly returned value;
they neither mutate the prior value nor create another configuration owner.

Each modifier validates and snapshots its own identifier/action token before it
enters state. Cross-side expansion, generated-name validity, and collisions stay
with `junction-topology.ts`, the first owner with both complete sides.

Junction actions accept `cascade`, `restrict`, or `noAction`; `setNull` is
absent because every junction side is a non-null membership-key member. Hostile
JavaScript gets the same definition error before DDL.

For a variant to-many relation, the existing exact per-variant map remains, but
each map value is folded into that variant's normalized entry:

```ts
s.toMany({ post: () => post, video: () => video }).through({
  post: { table: "mention_post", source: "mentionId", target: "postId" },
  video: { table: "mention_video", source: "mentionId", target: "videoId" },
});
```

The outer map is exact over all variants. Each inner value is exact. This
terminal exposes no fluent `source`, `target`, or action chain.

Ordinary defaults remain centralized. One unnamed non-self junction keeps the
current sorted-model table name. A named pair keeps the current
`${sortedModels}_${relationName}` convention; multiple pairs between the same
models therefore require distinct matching names. “Model” here means the
hydrated schema model name used by the current generator, not a mapped SQL table
name. Side tokens keep the current model-name defaults except for self edges,
which use their endpoint field keys. The existing physical-name owner validates
the generated identifier and collisions.

For a junction, changing `.name(...)` can therefore rename default storage. A
schema that wants pairing identity to change independently of its table name
spells `.through(...)` explicitly. On an FK edge, the same relation name is only
the pairing label and does not rename columns or constraints.

## 5. Canonical declaration representation

### 5.1 State algebra

The schema layer stores one closed union shaped by the two public facts and the
configuration legal for that exact arm:

```ts
type RelationCardinality = "one" | "many";

type ModelTarget<G = any> = {
  readonly kind: "model";
  readonly getter: G;
};

type VariantEntry<G = any> = {
  readonly getter: G;
  readonly storedValue: string;
};

type VariantOneEntry<G = any> = VariantEntry<G> & {
  readonly junction?: never;
};

type VariantManyEntry<G = any> = VariantEntry<G> & {
  readonly junction?: VariantJunctionOverride;
};

type VariantTarget<
  Entries extends Readonly<Record<string, VariantEntry<any>>>,
> = {
  readonly kind: "variants";
  readonly entries: Entries;
};

type NonEmptyFieldTuple = readonly [string, ...string[]];

type ForeignKeyDeclaration<
  Fields extends NonEmptyFieldTuple = NonEmptyFieldTuple,
  References extends NonEmptyFieldTuple = NonEmptyFieldTuple,
> = {
  readonly fields: Fields;
  readonly references: References;
  readonly onDelete?: ReferentialAction;
  readonly onUpdate?: ReferentialAction;
};

type AtLeastOne<Value> = {
  [Key in keyof Value]-?: Required<Pick<Value, Key>> &
    Partial<Omit<Value, Key>>;
}[keyof Value];

type OrdinaryJunctionOverrides = AtLeastOne<{
  readonly table?: string;
  readonly source?: string;
  readonly target?: string;
  readonly onDelete?: Exclude<ReferentialAction, "setNull">;
  readonly onUpdate?: Exclude<ReferentialAction, "setNull">;
}>;

type ModelToOneState<
  G = any,
  ForeignKey extends ForeignKeyDeclaration | undefined =
    | ForeignKeyDeclaration
    | undefined,
> = {
  readonly kind: "relation";
  readonly cardinality: "one";
  readonly target: ModelTarget<G>;
  readonly name?: string;
  readonly junction?: never;
  readonly optional?: never;
} & (ForeignKey extends ForeignKeyDeclaration
  ? { readonly foreignKey: ForeignKey }
  : { readonly foreignKey?: never });

type ModelToManyState<G = any> = {
  readonly kind: "relation";
  readonly cardinality: "many";
  readonly target: ModelTarget<G>;
  readonly name?: string;
  readonly junction?: OrdinaryJunctionOverrides;
  readonly foreignKey?: never;
  readonly optional?: never;
};

type VariantToOneState<
  Entries extends Readonly<Record<string, VariantOneEntry<any>>> = Readonly<
    Record<string, VariantOneEntry<any>>
  >,
> = {
  readonly kind: "relation";
  readonly cardinality: "one";
  readonly target: VariantTarget<Entries>;
  readonly name?: string;
  readonly optional?: true;
  readonly foreignKey?: never;
  readonly junction?: never;
};

type VariantToManyState<
  Entries extends Readonly<Record<string, VariantManyEntry<any>>> = Readonly<
    Record<string, VariantManyEntry<any>>
  >,
> = {
  readonly kind: "relation";
  readonly cardinality: "many";
  readonly target: VariantTarget<Entries>;
  readonly name?: string;
  readonly foreignKey?: never;
  readonly junction?: never;
  readonly optional?: never;
};

type RelationState =
  | ModelToOneState
  | ModelToManyState
  | VariantToOneState
  | VariantToManyState;
```

Optional state properties use one canonical representation: the property is
absent, or it contains the one normalized value shown above. Trusted state never
stores explicit `undefined`, `false`, an empty override object, or a partial FK.

The value returned by `.fields(...)` is a transient `ReferencesStage`, not a
fifth relation-state arm. It holds the snapped local tuple plus the endpoint's
existing name and FK actions only long enough for `.references(...)` to check
and replace the complete `ForeignKeyDeclaration`. It does not expose those
actions while incomplete. It has no relation brand/internal accessor, so
neither `ModelShape` nor downstream relation consumers can mistake it for
trusted schema state.

The broad state deliberately uses `any`, not `G extends Getter`: constraining a
function-typed member forces TypeScript to resolve recursive getter returns and
is measured to collapse mutually recursive models to `any`. Concrete overload
states retain the exact getter or getter-map generic, and their public parameter
guards require lazy getters. No assertion may erase those concrete types.

Raw getters remain lazy, but each terminal owns a source-independent lazy
once-cell for every target. The first full-schema resolution settles the raw
return or one normalized thrown `Error`; every later consumer and every later
schema graph that reuses that terminal observes that same outcome. The schema resolver decides
whether the settled return is a registered model and adds the current slot path
to any issue, so contextual diagnostics are not cached on the shared terminal.
This is derived cache state, not another
declaration fact. The thunk denotes one declaration-lifetime target, not a
per-schema callback; a resolver-local cache alone would let a stateful getter
give validation, migrations, and the query engine different declaration truth.
The immutable terminal gives this cache a complete ownership and invalidation
story: it settles once and is never mutated.

Variant construction validates structurally knowable facts and normalizes
public maps once:

```ts
{
  target: {
    kind: "variants",
    entries: {
      post: {
        getter: () => post,
        storedValue: "content.post.v1",
      },
      video: {
        getter: () => video,
        storedValue: "content.video.v1",
      },
    },
  },
}
```

There is no separately stored `targets`, `values`, or `through` map to keep in
sync. Explicit `?: never` exclusions make illegal cross-arm configuration fail
under structural assignment too; the state algebra does not rely on excess
property checking or factory etiquette.

### 5.2 One model relation map

`ModelState` owns one canonical `relations` map containing both target kinds.
`AnyRelation` covers all terminal implementations. Extraction uses the
single `state.kind === "relation"` boundary.

Delete the stored `polymorphicRelations` map, its separate extraction, and its
pairing-name registries. A consumer that needs only variant targets obtains a
derived view from `relations`. If measurement later justifies caching that
view, the model owns the cache and invalidation; it is never another declaration
map.

### 5.3 No mutable source binding

A relation object does not store its source model. Delete `state.source` and
`setSource()` from hydration and terminal internals.

Every contextual operation receives a slot reference:

```ts
type RelationSlot = {
  readonly source: AnyModel;
  readonly field: string;
};
```

The source model and field key are the whole identity; the declaration is read
from that model's canonical relation map rather than copied into the identity.
This is required because `.extends()` may reuse one relation object under more
than one model or key. Caching by relation object alone is unsound.

## 6. One schema-wide topology owner

### 6.1 Boundary and API

The mandatory schema-definition pipeline has two ordered phases under existing
owners. Before hydration mutates any name registry, schema registration proves
model-object identity and name stability. After that preflight succeeds, the
complete hydrated graph has enough information to resolve relations and lazy
targets.

Extend the existing full-schema validation boundary with one owner in
`src/schema/validation/relation-resolution.ts`, conceptually:

```ts
type ResolvedVariantRowEdge = Extract<
  ResolvedRelationEdge,
  { readonly kind: "variantRowCarrier" }
>;

type ResolvedVariantJunctionEdge = Extract<
  ResolvedRelationEdge,
  { readonly kind: "variantJunctionCarrier" }
>;

type ResolvedVariantEdge =
  | ResolvedVariantRowEdge
  | ResolvedVariantJunctionEdge;

type ResolvedSlot =
  | {
      readonly slot: RelationSlot;
      readonly edge: Exclude<ResolvedRelationEdge, ResolvedVariantEdge>;
      readonly member?: never;
    }
  | {
      // The public carrier slot spans the edge's complete member collection.
      readonly slot: RelationSlot;
      readonly edge: ResolvedVariantEdge;
      readonly member?: never;
    }
  | {
      // An ordinary inverse is a view of exactly one existing member record.
      readonly slot: RelationSlot;
      readonly edge: ResolvedVariantRowEdge;
      readonly member: ResolvedVariantRowEdge["members"][number];
    }
  | {
      readonly slot: RelationSlot;
      readonly edge: ResolvedVariantJunctionEdge;
      readonly member: ResolvedVariantJunctionEdge["members"][number];
    };

type ResolvedRelationIndex = ReadonlyMap<
  AnyModel,
  ReadonlyMap<string, ResolvedSlot>
>;

type RelationResolution =
  | { readonly ok: true; readonly index: ResolvedRelationIndex }
  | {
      readonly ok: false;
      readonly issues: readonly SchemaValidationIssue[];
      readonly cause?: Error;
    };

resolveSchemaRelations(
  schema: Schema,
  context: ValidationContext,
): RelationResolution;
```

This function is the one mandatory relation-definition gate, not merely a pair
matcher. It consumes the existing named `Schema` and `ValidationContext`; it
does not construct an anonymous second model list. It is scoped to one
schema/client construction, uses no module-global mutable state, consumes each
terminal's lazy resolved-target once-cell, and never invokes a raw getter
independently. It coordinates the existing exact owners for FK
field/reference legality, member nullability, variant-storage compatibility,
and physical junction expansion while the graph owner decides pairing,
ownership, and uniqueness. Those subowners return facts/issues to this gate;
no downstream consumer calls them again.

Before hydration, schema registration proves that one model object is bound to
one stable schema key. Repeating the same established key in another schema
context is idempotent; registering the same object as both `alpha` and `beta`,
whether in one schema or in later contexts, fails before mutation. The existing
model name slot becomes write-once rather than gaining a registration-node
abstraction. Reusing relation terminals across distinct models or
`.extends()`-derived models remains valid. This keeps `(model, field)` a complete
contextual identity and prevents a later client from changing table truth under
an earlier client.

If a lazy target getter throws an `Error`, its once-cell retains that exact
object. If it throws any other value, the terminal normalizes it once into an
honest generic `Error` that says the getter threw a non-Error value. Every
resolver context then observes the same settled thrown outcome and same internal
`Error`. Resolution stops on the first thrown getter in canonical order, emits
the ordinary contextual `SchemaValidationIssue`, and returns that `Error` in
the failure arm above. `SchemaValidationError` keeps its existing public
sanitized-`Error` cause contract; public identity with the unsanitized internal
cause is not promised. Non-thrown definition issues may still aggregate
normally.

`SchemaValidationIssue` remains the only definition-diagnostic representation.
Add optional candidate paths and repair metadata to that existing type when the
topology diagnostics need them; do not introduce a relation-specific issue
type and translation layer.

The composition boundary owns the successful index. Client construction passes
the same instance to `SchemaRegistry`, client-level nested-omit rewriting, and
the query-engine context; a migration serialization call resolves once and
threads that instance through validation and serialization; standalone registry
construction resolves once for its own lifecycle. These roots pass the index
directly rather than wrapping or copying it. Models and relation terminals never
cache this schema-contextual index. A relation terminal may participate in
distinct model slots and `.extends()` contexts; each schema gets its own
resolved index while the model's stable name binding remains idempotent.

Delete the current model-owned resolved polymorphic-storage map and its query
scope projection. They are second topology stores, not useful caches of an
independently expensive representation. Client omit, query, result-shape,
relation data, write, and serializer consumers read the canonical
`ResolvedSlot`/edge; only write-time storage values and migration snapshot
metadata retain the `polymorphicStorage` domain name.

Resolution and issue order follow the existing hydrated schema, model-field,
and normalized variant declaration order so canonical serializer ordering stays
unchanged. Ordering never selects a partner: exact relation-name partitions and
candidate count decide topology, not “first match.”

The nested map is the only stored graph view. Every inverse view points at the
exact member object already owned by its carrier edge; it does not copy target,
storage, uniqueness, or action facts. Migration obtains stable unique edge
enumeration through a derived iterator owned by this same module. Walk named
schema/model/field order and yield an edge only at its canonical anchor: a
foreign key at `edge.owner`, an ordinary junction at its canonically ordered
`edge.endpoints[0]`, and either variant storage family at `edge.carrier`. This
keeps carrier storage in the carrier's historical serializer position even when
an inverse model appears earlier. Do not persist a parallel `edges` array.

Invalid slots or physical references produce structured issues. The gate builds
an internal candidate graph, validates every structural storage fact needed by
its resolved edge forms, and publishes an index only when the whole graph is
trusted. Downstream query and migration consumers can obtain an index only from
the successful arm. An `unresolved` edge or unchecked stored reference is not
part of the trusted topology union.

`skipValidation` may skip advisory/business validation, but it cannot bypass
this structural relation-definition gate. Client construction, registry-only
construction, and migration generation/push all use the same gate before an
index or DDL exists. No query or migration is allowed to guess an edge or trust
an unchecked field name.

### 6.2 Exact pairing graph

Pairing is a graph, not a precedence ladder.

For every ordinary slot and every member of a variant target, first construct
the structurally compatible candidate graph:

1. Resolve its target model.
2. Enumerate target-model slots whose target domain contains the source model.
3. Exclude the asking slot itself. Self-relations require two distinct fields.
4. Permit ordinary-to-ordinary or ordinary-to-variant-member pairing.
5. Never pair two direct variant carriers to each other.
6. Record every compatible candidate. Do not prefer variant, ordinary, first,
   or sole-variant candidates.

Then apply the existing relation-name rule symmetrically:

1. An unnamed slot is compatible only with an unnamed candidate.
2. A slot named `.name("PostAuthor")` is compatible only with a candidate that
   carries the exact same name.
3. A one-sided or mismatched name is `nameMismatch`, not permission to fall back
   to another unnamed or differently named candidate.
4. Candidate count is evaluated after this exact label partition.
5. Names never create a relation between structurally incompatible targets.

For a variant carrier, the endpoint is the selected member, not the whole
carrier field, and every member inherits the carrier's optional relation name.
Different target models may therefore pair with different members of the same
carrier. Repeating one target model under several variant keys is valid for
direct-only reads and writes. An inverse is ambiguous because a carrier-wide
name cannot choose one member of that same carrier, so resolution fails rather
than guessing. The existing repair is to place inverse-bearing variants on
separate carrier fields and disambiguate those fields with matching
`.name(...)` values. No member-selector API is introduced or reserved.

Resolution rules:

- every remaining ordinary slot must resolve to exactly one remaining
  candidate;
- a direct variant member may resolve to zero or one public inverse;
- zero candidates for an ordinary slot is `missingPartner`;
- more than one candidate for either side is `ambiguousPartner`;
- a variant member with zero candidates remains a valid direct-only member;
- both endpoints of an ordinary pair must select each other;
- an ordinary-to-variant-member edge is valid only when the ordinary slot and
  member each have degree one.

The repeated name is a deliberate distributed rendezvous fact, as in Prisma:
there is no central edge declaration in a circular model graph. The topology
owner validates the two claims once and stores only the resolved edge; there is
no secondary name registry, loose-name fallback, or first-candidate answer.

### 6.3 Ordinary topology matrix

The local cardinality of each endpoint means how many rows that slot exposes.

| A slot | B slot | Storage | FK owner | Uniqueness |
|---|---|---|---|---|
| one | one | row FK | exactly one endpoint | unique FK tuple |
| one | many | row FK | A | non-unique FK tuple |
| many | one | row FK | B | non-unique FK tuple |
| many | many | junction | neither endpoint | junction PK only |

Canonical one-to-many spelling:

```ts
const user = s.model({
  id: s.string().id(),
  posts: s.toMany(() => post).name("PostAuthor"),
});

const post = s.model({
  id: s.string().id(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .name("PostAuthor")
    .fields("authorId")
    .references("id"),
});
```

The name may be omitted on both endpoints when these are the only compatible
slots. It is shown because it is the canonical explicit spelling when a model
pair has several relationships. If used, the same name appears on both slots.

General rule:

- if exactly one endpoint is `one`, that endpoint owns the FK;
- if both endpoints are `one`, exactly one endpoint owns the FK;
- an endpoint claims FK ownership only when its `.fields(...)` stage has been
  completed by an equal-arity `.references(...)` call;
- the FK is unique exactly when both endpoints are `one`;
- an already declared scalar or compound unique constraint may satisfy that
  physical uniqueness; serialization deduplicates the derived relation
  constraint instead of emitting a second one;
- relation-derived uniqueness is a physical membership fact, not an unnamed
  public selector. `ModelKeyCatalog.addressableKeys` continues to contain only
  explicitly declared scalar, id, and compound unique keys. A schema that wants
  this FK tuple in `whereUnique` declares the corresponding public unique key;
  the serializer then reuses it instead of emitting another constraint;
- if both endpoints are `many`, neither may own row fields and one junction is
  derived.

Refused shapes:

- an ordinary slot without an inverse;
- two to-one endpoints with zero or two completed FK owners;
- a to-one endpoint without completed fields/references paired with a to-many endpoint
  when the to-one endpoint must own the FK;
- completed fields/references on the wrong side of a one/many pair;
- FK modifiers on a non-owner;
- junction configuration on a non-junction edge;
- junction configuration on both endpoints;
- a physical unique constraint that contradicts a remote to-many declaration.

There are no resolved ownerless ordinary edges. Incomplete topology is a
definition error, not a warning followed by a query-time failure.

### 6.4 Self-relations

Self-relations use the same graph rules:

- one slot never pairs with itself;
- two distinct field keys are required;
- matching `.name(...)` labels distinguish competing self edges; one unique
  unnamed self pair needs no label;
- a lone self to-many declaration is refused;
- an unconfigured paired self-junction binds one physical side to each slot;
  the default side token is `${field}Id` for a scalar row key and `${field}` as
  the positional prefix for a compound row key;
- canonical constraint/index order is derived from stable `(model, field)`
  ordering, while traversal from either slot uses that slot's own side;
- the two directions traverse opposite junction sides;
- `.extends()` creates new contextual slot identities even if it shares a
  relation instance.

Generated tokens still pass the one identifier/collision owner. An explicit
one-endpoint junction override keeps its source/target orientation and the
inverse consumes the mirrored view. There is no special “lone self
many-to-many” topology.

### 6.5 Variant topology matrix

The carrier's cardinality selects the storage family. A bound inverse's
cardinality selects target-side uniqueness.

| Carrier | Bound ordinary inverse | Storage | Target-side uniqueness |
|---|---|---|---|
| `toOne(map)` | `toOne(getter)` | private discriminator/id pair | unique composite index |
| `toOne(map)` | `toMany(getter)` | private discriminator/id pair | non-unique composite index |
| `toMany(map)` | `toOne(getter)` | per-variant member junction | unique target tuple |
| `toMany(map)` | `toMany(getter)` | per-variant member junction | non-unique target tuple |

All four cells are valid.

A variant carrier needs no public inverse. When the whole row-held carrier has
no inverse, its shared storage is non-unique. A member-junction variant without
an inverse has a non-unique target side.

An unbound row-held member does not own an independent uniqueness fact. It
inherits the one carrier-wide answer because every variant shares the same
portable `(type, id)` index.

An ordinary slot bound as a variant inverse is a view over carrier-owned
storage:

- it has no completed fields/references or junction override;
- a bound `toOne(getter)` inverse is nullable by derivation;
- a bound `toMany(getter)` inverse needs no storage modifier; it may use
  the same `.name(...)` as the carrier when candidate inference is ambiguous;
- it never configures carrier storage.

For row-held `toOne(map)`, all bound inverse cardinalities must agree because
one portable composite index serves the whole group:

- none bound: non-unique;
- at least one bound and all bound inverses are many: non-unique for the whole
  carrier, including unbound members;
- at least one bound and all bound inverses are one: unique for the whole
  carrier, including unbound members;
- a mixture of one and many: definition error.

For `toMany(map)`, each variant has its own junction and derives uniqueness
independently. Mixed inverse cardinalities across variants are valid.

The implemented variant to-one restriction remains: every target uses the
compatible single-scalar identity required by the shared private id column.
Variant to-many continues to support each target's complete native or compound
row key through its own member table.

### 6.6 Trusted topology forms

The index stores physical meaning, not old public factory names:

```ts
type ResolvedVariantRowStorage = {
  readonly typeColumn: PolymorphicStorageColumn;
  readonly idColumn: PolymorphicStorageColumn;
  readonly indexName: string;
};

type ResolvedVariantStorageIdentity = Readonly<
  Pick<VariantEntry, "storedValue">
>;

type ResolvedVariantRowMember = {
  readonly variant: string;
  // Exact normalized entry object, exposed through this narrow trusted view.
  readonly entry: ResolvedVariantStorageIdentity;
  readonly targetModel: AnyModel;
  readonly referencedField: string;
  readonly inverse?: RelationSlot;
};

type ResolvedVariantJunctionMember = {
  readonly variant: string;
  // Exact normalized entry object, exposed through this narrow trusted view.
  readonly entry: ResolvedVariantStorageIdentity;
  readonly inverse?: RelationSlot;
  readonly uniqueTarget: boolean;
  readonly topology: ResolvedJunctionTopology;
};

type ResolvedStoredReference = {
  readonly members: readonly [
    {
      readonly foreignField: string;
      readonly referencedField: string;
    },
    ...{
      readonly foreignField: string;
      readonly referencedField: string;
    }[],
  ];
  readonly onDelete?: ReferentialAction;
  readonly onUpdate?: ReferentialAction;
};

type ResolvedRelationEdge =
  | {
      readonly kind: "foreignKey";
      readonly endpoints: readonly [RelationSlot, RelationSlot];
      readonly owner: RelationSlot;
      // Includes the complete validated fields/references and FK actions.
      readonly reference: ResolvedStoredReference;
      readonly unique: boolean;
    }
  | {
      readonly kind: "junction";
      readonly endpoints: readonly [RelationSlot, RelationSlot];
      readonly topology: ResolvedJunctionTopology;
      readonly onDelete?: Exclude<ReferentialAction, "setNull">;
      readonly onUpdate?: Exclude<ReferentialAction, "setNull">;
    }
  | {
      readonly kind: "variantRowCarrier";
      readonly carrier: RelationSlot;
      readonly members: readonly [
        ResolvedVariantRowMember,
        ...ResolvedVariantRowMember[],
      ];
      readonly uniqueTarget: boolean;
      // Carrier-wide physical columns only; it contains no second member map.
      readonly storage: ResolvedVariantRowStorage;
    }
  | {
      readonly kind: "variantJunctionCarrier";
      readonly carrier: RelationSlot;
      readonly members: readonly [
        ResolvedVariantJunctionMember,
        ...ResolvedVariantJunctionMember[],
      ];
    };
```

`junction-topology.ts` remains the single owner of physical junction table,
ordered sides, expanded key columns, indexes, and constraint names. It receives
an already paired edge and never discovers an inverse itself. The topology
index stores that owner's derived result; it does not reconstruct it or copy
those facts into another descriptor. Referential actions are derived once on
the edge because they are not part of physical side expansion: ordinary
junction actions come from the single endpoint configuration during resolution,
after which that transient provenance is discarded. Variant member junctions
derive cascade from their one fixed storage policy rather than storing two
constant fields per edge. The row-carrier edge has one resolved member
collection, and the junction-carrier edge uses the same carrier-plus-members
shape rather than pretending one public slot is several graph edges. Neither
physical storage value contains a parallel member map. `TableDef` remains the
migration snapshot truth, not a second declaration input.

Ordinary `endpoints` tuples use canonical schema/model/field order. An ordinary
junction's stored topology is oriented from `endpoints[0]` to `endpoints[1]`;
resolution mirrors a sole override owner when necessary before invoking the
physical topology owner. Traversal from the other endpoint derives the reversed
view and never mutates or duplicates the stored topology.

The variant junction topology is oriented from carrier/source to
variant/target. Its member therefore reads the target model from
`member.topology.target.model` instead of copying it. Both storage families
read the stable discriminator from `member.entry.storedValue`; the member holds
the exact normalized entry object through a capability-narrowed view rather
than copying that declaration fact. Its raw getter and unresolved junction
override are absent from the trusted member type. The serializer maps this one
value to the existing snapshot `storedType`.

`ForeignKeyDeclaration` is the immutable user declaration. The mandatory gate
turns it into the one `ResolvedStoredReference` above only after it proves that
every member exists, aligns by position with its counterpart, matches scalar
types, and references a legal target key. Consumers never receive the untrusted
declaration or repeat those checks.

## 7. Validation and failure integrity

### 7.1 One guard per invariant

| Invariant | Sole owner |
|---|---|
| Getter versus variant dispatch, plain/non-empty/exact map, and values | Factory input boundary |
| Non-empty local FK tuple | `.fields(...)` input boundary |
| Non-empty/equal-arity reference tuple and trusted FK normalization | `.references(...)` input boundary |
| Incomplete FK stage cannot become a model field | `s.model(...)` member-classification boundary |
| Non-empty relation name, FK action, and ordinary junction override token shape | Owning immutable modifier |
| Exact variant member-junction map | Variant `.through(...)` input boundary |
| One write-once schema key per model object | Schema registration preflight before hydration |
| Resolved getter is a registered model | Schema relation resolver |
| Exact pairing and ambiguity | Schema relation resolver |
| FK owner and derived uniqueness | Schema relation resolver |
| Modifier placement | Schema relation resolver |
| FK field/reference existence, scalar compatibility, and referenceability | Existing FK validation, invoked by the mandatory relation-definition gate |
| FK member nullability and whole-tuple action legality | Existing FK validation, invoked by the mandatory relation-definition gate |
| Physical junction names and complete key expansion | `junction-topology.ts` |
| Row-held variant inverse-cardinality uniformity | Schema relation resolver |
| Variant identity portability/private-column collisions | Existing variant storage validation, invoked by the mandatory relation-definition gate |
| Slot emptiness versus membership clearability | `clearability.ts` |

Definition validation publishes the gate's `SchemaValidationIssue`s directly.
It does not translate them through a relation-specific vocabulary or rescan the
graph. Query, migration, and write code trust the resolved index and do not add
“defensive” duplicates.

The old “required non-owning inverse must call `.optional()`” guards have no
replacement: non-owner to-one nullability is now derived, so there is no invalid
state for those guards to reject.

### 7.2 Diagnostic requirements

Every graph-topology issue includes:

- source model and field;
- target model or variant key when known;
- relation name when present;
- candidate field paths for ambiguity;
- the violated rule;
- one valid repair that does not imply a false topology.

Construction-time issue classes are:

- malformed target argument;
- empty or non-getter variant map;
- invalid/exactness failure in `values` or `through`;
- empty fields/references, unequal arity, or invalid FK action;
- non-string/empty relation name or malformed ordinary junction override token.

Topology issue classes are:

- one model object registered or later rebound under multiple schema keys;
- target getter did not resolve to a model in the schema;
- missing ordinary inverse;
- ambiguous inverse;
- one-sided, mismatched, or multiply matched relation name;
- missing FK owner;
- multiple FK owners;
- misplaced FK or junction modifier;
- incompatible row-held variant identities;
- mixed row-held inverse cardinalities;
- duplicate physical junction configuration;
- invalid self-edge pairing.

Retain an existing public code when the invariant remains exactly the same.
When old codes overlap after consolidation, choose the code of the surviving
owner and delete the duplicate. Do not emit two diagnostics for one invariant.

### 7.3 Full-schema timing

Structural resolution runs at every boundary that can produce effects:

- client construction;
- migration serialization/generation/push;
- any schema registry construction used without a client.

The successful index is published only after the existing FK, variant-storage,
and junction subowners have accepted every structural fact it contains. Current
client and `skipValidation` wiring must change accordingly: neither path may
expose a partially validated index. Advisory rules may remain optional.

A thrown lazy getter follows the cause-bearing failure arm from §6.1 through
this same boundary. The terminal owns the one non-Error normalization; the
resolver reuses that internal `Error`, and `SchemaValidationError` applies the
existing trusted diagnostic sanitization exactly once. No second relation error
class or raw-cause channel is introduced.

Factories, `.fields(...).references(...)`, relation/junction modifiers, and
variant `.through(...)` own all structurally knowable input validation plus
immutable normalization. They cannot decide getter results or graph topology
before all lazy targets and models exist; the schema relation resolver owns
those later facts.

## 8. Derived consumer views

### 8.1 Type-level projection

The runtime topology index is authoritative. TypeScript cannot execute that
runtime graph, so public types derive only the minimum local projection needed
for editor safety:

```ts
type RelationElement<R> =
  TargetKind<R> extends "model"
    ? ModelOutput<TargetGetter<R>>
    : VariantElementUnion<VariantEntries<R>>;

type SlotMayBeEmpty<SourceModel, FieldKey, R> =
  TargetKind<R> extends "variants"
    ? HasOptionalModifier<R>
    : StaticResolvedMembership<SourceModel, FieldKey, R> extends {
          readonly kind: "foreignKey";
          readonly owner: "asking";
          readonly foreignFields: infer Fields;
        }
      ? AnyNullableMember<SourceModel, Fields>
      : true;

type RelationResult<SourceModel, FieldKey, R> =
  Cardinality<R> extends "many"
    ? RelationElement<R>[]
    : SlotMayBeEmpty<SourceModel, FieldKey, R> extends false
      ? RelationElement<R>
      : RelationElement<R> | null;
```

`src/schema/relation/static-membership.ts` owns
`StaticResolvedMembership<SourceModel, FieldKey, R>` as one compile-time
projection, replacing the type-only residue of `inverse.ts`; it is not stored
topology and exports no runtime resolver. It carries the asking slot identity
and is a closed union over the membership shape it can prove:

```ts
type StaticResolvedMembership =
  | {
      readonly kind: "foreignKey";
      readonly owner: "asking" | "inverse";
      readonly foreignFields: readonly string[];
      readonly nullableForeignFields: readonly string[];
    }
  | { readonly kind: "junction" }
  | {
      readonly kind: "variantInverse";
      readonly carrierField: string;
      readonly membershipCanBeCleared: boolean;
    }
  | { readonly kind: "unknown" };
```

The actual generic form preserves the literal carrier field key. The
foreign-key arm carries the exact ordered FK tuple and nullable subset. The
resolver uses row-versus-junction storage and selected member identity only as
transient proof inputs, then erases them. Consumers receive the exact target
carrier relation field and the one derived fact they need: a row carrier is
clearable from that carrier's `.optional()` state, while a member junction is
clearable by deleting its membership row. `unknown` is the fail-closed result
for a graph the type system cannot prove; it never grants omission or a mutation
verb. A widened `boolean` likewise grants disconnect only when it is statically
proven to be literal `true`.

This is the sole static inverse projection used by nested data projection and
operation clearability. `nested-data-projection.ts` omits `carrierField` for
the variant-inverse arm and omits the appropriate foreign fields for an
inverse-FK arm; it retains the existing selected-upsert-update exception.
`clearability.ts` consumes `membershipCanBeCleared` or the nullable FK subset.
Neither consumer scans target relations, invokes a getter, or reconstructs a
polymorphic binding.

Variant elements retain the implemented discriminated shape:

```ts
| { readonly type: "post"; readonly data: PostProjection }
| { readonly type: "video"; readonly data: VideoProjection }
```

Stored discriminator values never appear in that union.

`AnyNullableMember` inspects the named local scalar states after the source
model is complete: every member proven non-nullable is `false`, at least one
member proven nullable is `true`, and a widened or statically unknown tuple is
`boolean`. The result conditional treats anything except proven `false` as
nullable. A mixed tuple is valid and represents an absent membership whenever
one of its nullable members is null; a broad non-fresh config remains type-safe
instead of being guessed required.

Therefore a model-target owner with an all-non-nullable FK is non-null, an owner
with any nullable FK member is nullable, and a non-owner is always nullable
because no referencing row is guaranteed to exist. No ordinary relation stores
an extra optionality flag.

Where result or operation typing needs inverse knowledge, it uses that one
conservative projection beside the relation domain. The model-to-relation mapped
types must preserve each `FieldKey`; a `GetRelationsSchemas`-style projection
that drops the asking key is not sufficient. If a name or target is statically
dynamic, or the result is ambiguous, the projection does not guess nullability,
clearability, or inverse-derived omission. Runtime topology remains the
definition authority. A parity corpus pins the statically decidable cells.

The projection mirrors only the graph predicate it can prove:

1. retain the exact source-model and asking-field identity;
2. inspect the target model's one relation map and exclude the asking slot
   itself, so self-relations cannot select their own declaration;
3. collect ordinary slots and variant members that target the source model;
4. retain candidates whose literal `name` exactly matches the asking slot's
   literal name, including unnamed-to-unnamed;
5. require exactly one candidate and prove that candidate's reverse candidate
   set contains exactly the asking slot—the same mutual degree-one rule as
   runtime;
6. derive its owner or carrier/member identity, ordered FK fields and nullable
   subset where present, exact nested field omission, and clearability only
   after that proof;
7. otherwise omit nothing, expose no unsafe disconnect form, infer nullable when
   requiredness is uncertain, and let full-schema validation report the invalid
   or ambiguous graph.

There is no ordinary-first or sole-variant type fallback. This is a derived DX
view, not another topology authority. Exact type/runtime parity is required for
statically decidable literal declarations. Accepted widened declarations are
conservatively sound instead: types may retain an FK input that runtime can
derive, or include `null` that runtime topology rules out, but they never omit a
possibly required field, claim non-nullability without proof, or expose an
unsafe mutation verb.

All public DX claims are tested through `s.toOne`, `s.toMany`, and client calls,
not internal aliases. `IsAny` probes use `Expect<...>` so they can fail.

Before production state changes, prototype the four overloads and this derived
projection in an isolated type fixture, then run `pnpm test:types` against the
same baseline revision. The candidate must stay inside the existing 4 GB / 300
second launcher budget, introduce no TS2589/TS2590 diagnostics, keep recursive
models non-`any`, and report baseline-versus-candidate wall time and peak RSS.
Do not “fix” a regression by widening a getter, variant key, or result to `any`.

### 8.2 Operation schemas

Operation-schema dispatch becomes:

```text
cardinality → target kind → resolved membership/clearability
```

It does not switch on old factory names.

- model target + one: one-model relation operations;
- model target + many: collection relation operations;
- variant target + one: discriminated singular operations;
- variant target + many: discriminated collection operations;
- resolved membership decides which mutation verbs are legal;
- `clearability.ts` decides whether disconnect/set-null forms exist.

The existing variant collection projection envelope (`only`, `variants`) stays
because it solves real key collisions and subset narrowing. `false` remains an
outer select/include omission. Optional or maybe-undefined projection values
retain the existing two-world result union.

### 8.3 Query engine and writes

`bindRelation` consumes a resolved slot and returns the existing bound
membership shapes. It never discovers an inverse.

- row FK paths receive the exact FK owner and uniqueness;
- ordinary junction paths receive one physical topology descriptor;
- variant row paths receive the carrier-level storage/uniqueness descriptor and
  the selected member view from the same edge;
- variant junction paths receive the already bound member junction and its
  `one | many` target cardinality.

Query scope carries the canonical index/slot lookup directly. Delete the
model-derived `polymorphicRelationsByModel` cache, its
`PolymorphicRelationInfo*`/`ResolvedPolymorphicEdge` wrappers, and every read of
model-owned resolved storage. These fact-bearing pre-bind facades do not survive
beside `ResolvedSlot`; ordinary bound write-membership values remain execution
artifacts rather than topology stores.

Delete the synthetic ordinary relation constructed only to feed variant member
junctions into ordinary write code. Pass the existing bound junction directly
to `RelationJunctionPart` or `RelationJunctionToOnePart`. This removes the
`polymorphicMemberCarrier` brand, its memo exception, and its validation escape.

This plan does not rewrite the implemented write algorithms. Singular transfer,
duplicate resolution, current-member retry, progressive series, exact complete
keys, and atomic-batch behavior remain owned by their current write parts.

### 8.4 Clearability

Keep two distinct derived facts:

- `slotMayBeEmpty`: whether a singular public slot can return `null`;
- `membershipCanBeCleared`: storage can be removed without deleting either row.

`slotMayBeEmpty` is true for a model-target FK owner when any local tuple member
is nullable, for every model-target non-owner, and for a variant to-one carrier
only when it has `.optional()`. `membershipCanBeCleared` is true for a row FK
under the same any-nullable-member rule. The existing `clearability.ts` owner
must return the exact ordered non-empty subset of nullable FK members, not only
a boolean; every empty-membership write consumes that same subset. Disconnect
clears those members and retains required context members. Clearability is also
true for every ordinary or variant junction and for a variant row member only
when its carrier is optional. The separate referential-action rule permits
database `setNull` only when every row-FK member is nullable.

It does not rescan for partners.

### 8.5 Result parsing and `.extends()`

Result parsing receives the canonical `ResolvedSlot` identity. Parser caches
are keyed by that same contextual identity, never by a shared relation instance
alone. Delete the fact-bearing `RelationInfo`; `getRelationInfo` becomes a
resolved-slot lookup or disappears, and no query object copies target,
cardinality, fields, references, or optionality out of the resolved graph.

Delete the old declared relation-type argument from adapter and driver result
parser hooks. Built-in parsers do not use it, and keeping it would preserve a
false public topology concept. Cardinality and target-domain parsing use their
actual derived fields.

### 8.6 Migrations and storage

Migration serialization consumes the resolved index:

- `foreignKey` emits the current FK and derived unique constraint;
- `junction` emits the edge's already resolved `topology`; it never invokes
  `junction-topology.ts` a second time;
- `variantRowCarrier` emits the current private row-held storage once;
- `variantJunctionCarrier` emits each member's already resolved table.

Edge enumeration does not redefine output order. The serializer preserves its
existing two physical phases: model tables plus variant member tables in
carrier/member order first, then ordinary junction tables in canonical-anchor
order. It may stage edge references from the one derived iterator into those
two local emission buckets; it never stores another topology view or calls the
resolver/physical expander again. A schema mixing an early ordinary junction
with a later variant carrier must retain the complete baseline table/history
order.

`TableDef` remains the structural migration truth. Existing logical variant
storage metadata remains only where it is necessary to relate a member table
or private column family back to its carrier. Do not serialize a second copy of
physical columns, constraints, or actions in relation metadata.

Preserve the current `storageRef` → `TableDef.relationStorage` join and each
history member's `memberJunctionTable` exactly. They are byte-stable snapshot
references used to connect logical history to structural tables, not inputs to
relation resolution. This plan adds no new physical-name copy and does not
redesign those established snapshot joins under the guise of API cleanup.

Snapshot labels such as variant storage `kind: "toOne" | "toMany"` remain
storage-version facts. They are not the deleted public factory names and are not
renamed merely to mimic the source API.

This source-language change introduces no snapshot-version compatibility path
and no data migration. Canonical old declarations and their new equivalents
must serialize to the same physical snapshots.

## 9. Source-estate conversion and compatibility truth

### 9.1 Canonical conversion matrix

| Old declaration | New declaration |
|---|---|
| `oneToOne(() => T)` | `toOne(() => T)` on both endpoints |
| `manyToOne(() => T)` | `toOne(() => T)` |
| `oneToMany(() => T)` | `toMany(() => T)` |
| `manyToMany(() => T)` | `toMany(() => T)` on both endpoints |
| `polymorphicToOne(map, options)` | `toOne(map, options)` |
| `polymorphicToMany(map, options)` | `toMany(map, options)` |

For ordinary edges, both endpoint declarations are converted together. FK
fields, references, and valid actions keep their familiar fluent spelling, but
conversion review ensures every `.fields(...)` reaches `.references(...)`, permits
the existing `.name(...)` between them, and places actions on the completed
owner terminal. Every old
ordinary `.optional()` call is removed: owner emptiness comes from its scalar
tuple under the any-nullable-member rule and non-owner emptiness is derived.
If the old flag disagreed with that physical truth, the conversion manifest
records the public type-shape change for review; it neither preserves a second
optionality fact nor stops the structural conversion. No `.unique()` is
injected: the remote `toOne` declaration is the one source of that fact.

Package A freezes old resolved behavior and physical artifacts before the
cutover. Graph-dependent stops are reviewed against that evidence and then
stated in the new language:

- matching old `.name(...)` values remain on both endpoints;
- an unnamed structurally unique pair stays unnamed;
- if exactly one endpoint carried a valid old name, conversion copies that
  same name to its resolved partner so the final declaration is symmetric;
- an ambiguous edge that old precedence selected without one exact shared name
  stops for manual naming rather than inventing an identity;
- an old pairing that depended on loose-name fallback or precedence and does
  not identify one exact named pair stops for manual repair.

For an old ordinary many-to-many pair, conversion review uses the old physical
junction table, side tokens, and actions before rewriting it. It consolidates
all overrides on one canonical endpoint. Moving side overrides from the other
endpoint swaps source/target orientation; table and actions keep their meaning.
Equal duplicate facts are removed and contradictory facts stop conversion.

Retaining `.name(...)` retains its current named-junction default. If override
consolidation would nevertheless change the resolved table, conversion writes
the old table explicitly with `.through(...)`. On FK edges, the name
remains pairing-only and does not alter columns or constraints.

### 9.2 Temporary repository codemod

The tracked estate contains enough declarations to justify one temporary AST
codemod. It is an implementation tool, not a supported compatibility surface.
Implement `scripts/rewrite-relation-language.mjs` with the repository's
installed TypeScript compiler API. It enumerates tracked TypeScript/JavaScript
through `git ls-files` and supports only `--check` and `--write`. It parses
source; it never imports or executes application/test modules and never embeds
a second pairing or junction resolver.

The script owns syntax-local, semantics-preserving rewrites. Graph-dependent
choices remain with the one new topology resolver plus the frozen Package A
behavior/DDL corpus. Its deterministic report lists every changed node and
every chain it could not prove local. It is emitted to stdout or an ignored,
untracked review file—never committed as another estate manifest. Package F
resolves those stops and every new full-schema diagnostic, then deletes the
script and any local report.

It must:

- rewrite all six factory call shapes;
- preserve lazy getters and exact generic inference;
- preserve variant options without changing public/stored keys; the new factory,
  not the codemod, owns normalized entry construction;
- normalize each old FK chain to non-empty `.fields(...)` and
  `.references(...)` calls (with an optional name between them) followed by
  actions when that complete chain is statically present; otherwise report the
  chain without guessing;
- delete ordinary `.optional()` calls and record each location for Package F's
  scalar-nullability review; the syntax tool does not derive graph facts;
- preserve local `.name(...)`, `.through(...)`, and action calls;
- rewrite local old `.A()` / `.B()` calls to `.source()` / `.target()` without
  changing their endpoint orientation;
- report zero-argument/incomplete FK chains and every syntactically dynamic
  chain it cannot rewrite safely;
- mechanically rewrite existing schema-bearing TypeScript/JavaScript, including
  existing tests, without inventing or updating contract probes;
- be deleted in the same package after the estate is converted.

A bare textual rename is insufficient because fluent chains must remain valid,
but a one-off script that executes arbitrary repository modules or reimplements
the relation graph would be worse. Matching names, one-sided old-name repair,
dual junction-override consolidation, ambiguity, and physical preservation are
resolved exactly once by the new full-schema owner and the explicit conversion
review in §9.1/§9.3.

### 9.3 What is preserved

The preservation promise is deliberately narrow and testable:

For the named canonical corpus of currently valid, unambiguous schemas, the new
declaration emits the same:

- table and column definitions;
- FK fields, references, uniqueness, and actions;
- ordinary junction names, ordered sides, keys, and constraints;
- variant private storage and indexes;
- variant member tables and target-side uniqueness;
- read result shapes and relation mutation state transitions.

The corpus contains every ordinary cardinality cell, self pairs, compound keys,
mapped names, all four variant inverse cells, direct-only variants, `.extends()`,
and default/explicit physical naming.

It also contains the current valid spelling where both old many-to-many
endpoints repeat the same table/action override. Conversion review resolves that
one physical junction, keeps the facts on its canonical configuration owner,
drops the equal duplicate, and proves the converted `TableDef` is identical. A
conflicting old pair remains a stop/error. In the final API, configuring both
endpoints is itself rejected because one physical fact has one owner.

### 9.4 Deliberate verdict changes

Do not claim that every HEAD-valid schema is preserved. Some current schemas are
accepted only because of warnings or fallback precedence. They become errors:

- an ordinary slot without a complete inverse;
- ownerless ordinary relations;
- two FK owners;
- ambiguous ordinary-versus-variant candidates;
- loose or mismatched mirrored names that previously fell through and cannot be
  converted to one exact matching-name pair;
- lone self relations;
- a newly written final-API junction configured on both endpoints (consistent
  old mirrored configuration is canonicalized by §9.3, not lost);
- `setNull` on a junction FK whose membership-key column is non-null;
- physical uniqueness that contradicts the paired cardinality;
- malformed zero-argument FK ownership;
- a variant inverse that could match repeated target-model variants.
- one exact model object registered under multiple schema keys or later rebound
  under a different key.

Two currently accepted shapes intentionally receive more truthful semantics:

- a mixed-nullability compound FK is nullable and disconnectable by clearing
  its nullable members while retaining required context members; database
  `setNull` remains refused unless all members are nullable;
- an ordinary owner's result nullability follows its scalar tuple even when an
  old `.optional()` flag claimed the opposite.

Four current non-success verdicts become simpler valid declarations:

- a one-key variant map no longer emits a warning;
- two paired self `toMany` slots may use the field-derived default side tokens
  instead of being forced to configure them explicitly;
- a non-owning to-one no longer needs a duplicated `.optional()` assertion,
  because the absence of an owning row always makes that view nullable;
- a one-to-one owner no longer needs a separately declared scalar/compound
  unique solely to satisfy the relation rule, because the paired to-one slots
  derive the physical unique constraint. It still needs an explicit model key
  if callers must address that tuple through `whereUnique`.

Each deliberate verdict change gets a named before/after witness. It is not
mixed into the byte-preservation theorem.

### 9.5 Historical documents

[`polymorphic-cardinality-plan.md`](./polymorphic-cardinality-plan.md) remains the
implemented storage and behavior record. Add a banner stating that its public
factory spellings are historical and are superseded here. Do not rewrite its
measured implementation history into a fictional new-API history.

All current public docs, README examples, AGENTS guidance, feature docs, and
tests use the new API. Section 12.4 is the sole authority for the narrow tracked
text allowlist; this section does not establish a second exception list.

## 10. Ordered implementation packages

Packages are semantic ownership slices on one feature branch. A package is
an ordered work unit, not a promise that the middle of the semantic switch is a
publishable commit. Package A can establish the green baseline independently.
Packages B–F are one atomic semantic transition: implementation may move through
temporarily uncompilable local states, but it must not introduce public aliases,
dual stored states, or compatibility readers to make those states look valid.
Their owned checks are run after the dependencies needed to compile that slice
close, and the transition is committed only after Package F and every final gate
are green. No intermediate package is published as a mixed relation language.

### Package A — lock the contract and evidence corpus

**Outcome:** exact red-capable evidence exists before production changes.

Owners:

- public relation type tests;
- schema-validation topology corpus;
- migration derivation/DDL corpus;
- query/result/write parity behaviors;
- this plan and the domain glossary.

Work:

1. Measure the current `pnpm test:types` wall time and peak RSS.
2. Prototype the four overloads and result projection in an isolated fixture;
   reject the design if it causes recursive `any`, TS2589/TS2590, or exceeds the
   existing launcher budget.
3. Capture canonical serialized snapshots/DDL before the switch.
4. Record the complete ordinary and variant topology matrix as named fixtures.
5. Record named-pair, inferred-pair, missing, ambiguous, owner, self, and
   `.extends()` cases.
6. Separate canonical-preservation schemas from deliberate-break schemas.
7. Specify the public overload/modifier probes that land with Package B and the
   topology falsifiers that land with Package C.
8. Add the executable-AST and textual-region scanners from §12.4. Freeze one
   exact baseline manifest and one self-falsifier for each detector; Package F
   switches both to their final allowlisted-zero assertions.
9. Build `scripts/rewrite-relation-language.mjs` and run `node
   scripts/rewrite-relation-language.mjs --check`; capture its deterministic
   changed/stopped-node report from stdout or an ignored untracked file as
   review evidence, not a committed compatibility artifact.

Exit evidence:

- every committed baseline fixture is green on HEAD and stores its exact expected
  physical result, not a digest of undisclosed runtime discovery;
- deliberate-break fixtures document current and intended verdicts separately.

Before changing production, run the Package B/C falsifiers against HEAD in a
throwaway patch and confirm that they fail for the intended missing behavior.
Do not land a permanently red baseline commit.

### Package B — declaration algebra, factories, and model storage

**Outcome:** schemas store cardinality and target domain once.

Primary owners:

- `src/schema/relation/types.ts`
- `src/schema/relation/to-one.ts`
- `src/schema/relation/to-many.ts`
- `src/schema/relation/polymorphic.ts`
- `src/schema/relation/index.ts`
- `src/schema/index.ts`
- `src/schema/exports.ts`
- `src/schema/model/helper.ts`
- `src/schema/model/model.ts`
- `src/schema/hydration.ts`

Work:

1. Execute the reviewed syntax codemod with `node
   scripts/rewrite-relation-language.mjs --write`; retain its untracked report
   during review, then let the new resolver expose every graph-dependent repair
   during the atomic cutover.
2. Implement exact getter and variant-map overloads for `toOne` and `toMany`.
3. Validate structural factory/modifier input and normalize variant
   getter/value/through facts into one entry map.
4. Implement four narrow immutable terminal classes as private factory return
   machinery; do not export their names or constructors from the package.
5. Keep Prisma-style `.name(...)` on every terminal. Implement staged
   `.fields(...).references(...)` on model-target to-one so only the completed
   chain becomes trusted FK state. Keep all other modifiers as ordinary
   immutable last-call-wins setters.
6. Replace declared `state.type` with `cardinality` and normalized target.
7. Merge model relation extraction and delete pairing-name registries.
8. Add source-independent once-cells for lazy target outcomes.
9. Remove mutable source binding from hydration and relation state.
10. Make the existing schema-name hydration boundary preflight every model
    identity before any write, bind a model name once, and treat same-key reuse
    as idempotent. Validation and client composition consume that one guard.
11. Delete old factories/classes/exports and trivial cardinality readers as part
   of the same B–F cutover.
12. Keep recursive getter inference non-`any` through the established lazy
   generic technique.

Exit evidence:

- public overload and modifier probes pass;
- repeated `.name(...)`, actions, `.optional()`, `.through(...)`, and junction
  override calls change only the newly returned value and obey last-call-wins;
- malformed map/options probes pass at type and runtime boundaries;
- non-empty/equal-arity fields/references, incomplete-stage refusal, FK-action
  placement, and relation-name modifier-order probes pass;
- recursive and mutually recursive public models remain non-`any`;
- candidate type-check time and peak RSS are recorded against Package A;
- one model relation map contains both target kinds;
- no old factory or concrete terminal implementation is exported.

### Package C — topology graph and definition validation

**Outcome:** one schema-wide owner resolves every valid edge and rejects every
incomplete graph before effects.

Primary owners:

- new `src/schema/validation/relation-resolution.ts`
- `src/schema/relation/inverse.ts` (surviving projections move, then delete)
- `src/schema/relation/helpers.ts`
- `src/schema/relation/junction-topology.ts`
- `src/schema/relation/clearability.ts`
- `src/schema/validation/validator.ts`
- `src/schema/validation/error.ts`
- `src/schema/validation/rules/relation.ts`
- `src/schema/validation/rules/fk.ts`
- `src/schema/validation/rules/polymorphic.ts`

Work:

1. Preflight model-object identity before hydration. Make model-name binding
   write-once/idempotent, reject duplicate or later different-key registration
   before mutation, then build contextual slot nodes and resolve each lazy target
   once.
2. Preserve a thrown `Error` internally by identity, normalize a non-Error throw
   once at the terminal, and add contextual paths through the existing
   sanitized schema-error boundary.
3. Build the exact candidate graph with no precedence.
4. Derive ordinary ownership and uniqueness from paired cardinalities.
5. Derive variant member bindings and inverse uniqueness.
6. Enforce row-held group uniformity and member-junction independence.
7. Return either a complete trusted index or existing
   `SchemaValidationIssue`s; never return a partial or guessed topology.
8. Make every effect-capable schema boundary run structural resolution.
9. Replace duplicate inverse, uniqueness, requiredness, and modifier checks with
   the topology owner's existing schema issues; add no translation vocabulary.
10. Make FK and junction validators consume resolved ownership.
11. Make `clearability.ts` consume resolved membership and expose the exact
    ordered nullable-member subset for a mixed compound FK.
12. Stop validation rules from populating model-owned polymorphic storage; the
    resolved index is the only successful topology output.
13. Delete obsolete inverse scanners and warning-only ownerless routes.

Exit evidence:

- complete topology matrix passes;
- matching-name/inference/no-precedence/self/ambiguity tests pass;
- one guard emits one diagnostic per invariant;
- invalid graphs return the existing `SchemaValidationIssue` values and no
  partial index; successful graphs store only the contextual slot map and
  derive unique edge enumeration from it;
- duplicate or later different-key model registration leaves prior hydrated
  names untouched and fails before index construction; every
  context reuses the same internal getter failure and exposes it through the
  existing sanitized public cause contract;
- canonical DDL corpus remains identical;
- `.extends()` resolves the same relation instance contextually.

### Package D — public types, operation schemas, and result parsing

**Outcome:** every public view derives from cardinality and target kind.

Primary owners:

- `src/schema/relation/static-membership.ts`
- `src/client/result-types.ts`
- `src/client/types.ts`
- `src/validation/relations/nested-data-projection.ts`
- `src/validation/relations/`
- `src/validation/model/`
- `src/query-engine/result/`
- adapter and driver result-parser contracts

Work:

1. Replace old topology-name conditional types with cardinality/target-domain
   composition.
2. Thread each source relation field key through result and operation mapped
   types. Retarget their one shared static membership projection to exact,
   mutual degree-one pairing with fail-closed ambiguity behavior.
   Its closed union includes ordinary FK/junction and one variant-inverse arm.
   Result, nested-omission, and clearability types import only that owner; no
   consumer keeps a local candidate scan.
3. Build operation grammars from cardinality, target kind, membership, and
   clearability.
4. Preserve all variant discriminated result and projection-envelope behavior.
5. Thread the canonical `ResolvedSlot` into parser construction and caches.
6. Remove old relation-type arguments from adapter and driver parser hooks.
7. Remove all last-write-wins source reads.

Exit evidence:

- public type estate passes through core and every driver wrapper;
- typo-beside-real-key probes cover both target kinds and nested levels;
- required/optional/collection/discriminated results are exact;
- self-pair omission and disconnect surfaces use the asking field identity;
  two named self pairs remain separated through core and driver wrappers;
- every variant-inverse cell omits the exact carrier relation key from nested
  create/update inputs and exposes disconnect only from its proven storage
  clearability;
- optional projection values keep their two-world unions;
- malformed repeated nested rows still fail through the parser boundary;
- no fact-bearing `RelationInfo` remains in the parser or adapter contracts.

### Package E — query, write, and migration consumer cutover

**Outcome:** physical consumers use resolved membership directly.

Primary owners:

- relation-data builders and `bindRelation`;
- query include/filter/order builders;
- `src/client/client.ts`;
- `src/client/omit.ts`;
- `src/schema/model/model.ts`;
- `src/validation/builder.ts`;
- `src/query-engine/query-engine.ts`;
- `src/query-engine/types.ts`;
- `src/query-engine/context/query-scope.ts`;
- query result-shape and relation-data builders;
- relation write parts and record-series routing;
- `src/query-engine/write-engine/relation-nullability.ts`;
- `src/query-engine/write-engine/relation-membership.ts`;
- `src/query-engine/write-engine/RecordUpdateCompiler.ts`;
- `RelationSetPart` in
  `src/query-engine/write-engine/RelationWritePart.ts`;
- relation-to-`TableDef` migration serialization;
- `src/migrations/serializer.ts`;
- schema and query-engine AGENTS doctrine.

Work:

1. Replace every inverse/cardinality scan with a resolved-slot lookup.
2. Pass exact FK or junction topology into read builders.
3. Pass bound variant member junctions directly into existing junction write
   parts.
4. Delete synthetic carrier construction, brand checks, and memo exclusions.
5. Preserve singular member transfer and duplicate coalescing without moving
   their semantic owner.
6. Make migration serialization consume the same resolved edge.
7. Keep differ, introspection, and DDL drivers unchanged; use their existing
   tests as byte-preservation witnesses rather than new edit owners.
8. Delete fact-bearing `RelationInfo` and make every former lookup consume the
   canonical `ResolvedSlot`.
9. Replace every independent all-fields-nullability check and all-members-null
   assignment in the named write owners with the nullable-member subset from
   `clearability.ts`. Direct and inverse disconnect, parent-held delete, and set
   departure must all clear only that subset.
10. At client construction, resolve once and pass the exact same index instance
    into `SchemaRegistry`, client-level nested-omit rewriting,
    model-registry/query-engine construction, and every query scope. A
    standalone registry and a migration composition root each resolve once for
    their own lifecycle. Pass the existing owner directly; do not introduce a
    context wrapper that copies it.
11. Delete `_polymorphicStorage` and its model accessors, query-scope
    `polymorphicRelationsByModel`, `QueryScope.polymorphicRelations`,
    `PolymorphicRelationInfo*`, and `ResolvedPolymorphicEdge`. Cut their current
    result-shape, relation-data, write, and serializer readers over to
    `ResolvedSlot`/its edge.
12. Preserve the current migration serializer's two physical output phases:
    variant member tables in carrier/member order during the model phase, then
    ordinary junctions in canonical-anchor order. Both phases stage references
    to edges from the one index; neither re-resolves topology.
13. Make `src/client/omit.ts` recurse through each canonical `ResolvedSlot` and
    its resolved counterpart/member target. Delete its split ordinary/variant
    map reads, raw ordinary getter call, and terminal `targetEntries()` target
    resolution. Projection grammar remains cardinality-specific, but target
    identity comes only from the settled topology.

Exit evidence:

- read, filter, order, aggregate, and every nested write family pass for all
  four declaration quadrants;
- direct and inverse variant routes remain behaviorally identical;
- transaction and native-batch atomicity witnesses pass;
- mixed compound-FK empty-membership writes retain every required context
  member on both transaction and native-batch routes;
- one resolver invocation supplies one `===`-identical index to registry and
  client omit rewriting and query engine, with no model/query-scope topology
  cache beside it;
- nested ordinary and variant default-omit rewrites reach the exact settled
  target without another getter invocation;
- migration snapshots and second push are exact, with no downstream
  differ/introspection/DDL change required;
- no synthetic carrier or consumer-side inverse scan remains.

### Package F — estate conversion, deletion, and doctrine

**Outcome:** the repository speaks only the final relation language.

Primary owners:

- the temporary AST codemod, including the lifecycle of its untracked local
  review report;
- all schema fixtures, tests, examples, and public docs;
- `AGENTS.md`, nested architectural guides, `CONTEXT.md`;
- package export and construction inventories.

Work:

1. Manually resolve every stopped syntax chain and every graph diagnostic from
   the new resolver, using the frozen old behavior/DDL corpus as the comparison
   truth; never teach the temporary script topology.
2. Verify that completed FK chains, matching relation names, and consolidated
   junction chains preserve the old resolved physical facts.
3. Keep junction overrides on one endpoint without changing their fluent
   public representation.
4. Update public docs, all driver-package examples, source JSDoc/code examples,
   and user-facing repair strings.
5. Mark historical plans, and keep their explicit allowlist narrow.
6. Delete the codemod, any local stop report, old symbols, stale diagnostics,
   tests that only exercise compatibility, and obsolete documentation.
7. Run symbol/call-site censuses from tracked files.

Exit evidence:

- no live tracked old-factory call remains;
- no old symbol is exported or constructible;
- no dual reader or compatibility branch remains;
- no tracked or local codemod report remains;
- docs and AGENTS describe the same final model as code;
- all gates in §12 pass.

## 11. Mandatory falsifier matrix

### 11.1 Public construction and types

1. `toOne(getter)` and `toMany(getter)` infer exact model targets.
2. `toOne(map)` and `toMany(map)` preserve exact variant keys.
3. Empty literal maps and broad string-index maps fail in TypeScript; empty or
   malformed dynamic JavaScript maps fail at construction.
4. A direct model, non-function entry, malformed options, and unknown option
   beside `values` fail.
5. Missing/extra `values` keys fail for fresh and non-fresh objects.
6. Default and explicit stored values round-trip as runtime storage strings but
   never become public discriminators or unnecessary public type parameters.
7. Every modifier in §4.3 is available only in its cell.
8. `.fields(...)` requires a non-empty tuple and returns a non-relation stage
   that exposes equal-arity `.references(...)` plus immutable `.name(...)`;
   zero-argument and unequal chains fail, while both TypeScript and the hostile
   JavaScript `s.model(...)` boundary reject a model-embedded incomplete chain.
   Starting and completing a second fields/references stage replaces that pair
   on the new terminal, preserves name/actions, and leaves the prior terminal
   unchanged.
9. `.name(...)` exists on all four terminals, composes before, between, or after
   FK stages and before or after junction configuration, preserves its literal,
   and follows immutable last-call-wins semantics. Repeating it changes only the
   newly returned relation; the prior relation keeps its prior name. FK actions
   exist only after `.references(...)`.
10. A non-empty relation label such as `"Post tags/v2"` is accepted when an
    explicit valid junction table is supplied; the relation modifier does not
    pretend that pairing labels are SQL identifiers.
11. Concrete terminal class names and constructors are absent from package
    exports; callers see only the capabilities returned by the two factories.
12. Variant through maps are exact at both levels.
13. A typo beside a real variant key fails in select, include, filters, and
    nested writes.
14. Recursive/self-recursive/extended public declarations do not collapse to
    `any`; the test uses `Expect<IsAny<T> extends false ? true : false>`.
15. The candidate type estate stays inside the existing time/memory launcher
    budget and records its delta from the Package A baseline.
16. Factory dispatch invokes no target getter. Reusing one immutable terminal in
    two schema contexts settles each target getter once for the declaration;
    both contexts observe the same return or normalized thrown `Error` while
    diagnostics keep their own model/field paths. An actual thrown `Error` is
    identity-equal inside both resolution failures; a non-Error throw is
    normalized once. Public `SchemaValidationError`s expose safe sanitized Error
    causes without promising raw identity. With two throwing getters, canonical
    slot order deterministically chooses the first failure and later getters are
    not invoked.

### 11.2 Ordinary topology

1. One/one with one owner resolves a unique FK.
2. One/one with zero or two owners fails.
3. One/many and many/one put a non-unique FK on the one endpoint.
4. Many/many emits one junction and no row FK.
5. One/one over an already unique scalar or compound FK still resolves as
   one/one and emits no duplicate unique constraint.
6. A relation-derived unique FK without an explicit model key is absent from
   `whereUnique`; declaring that same scalar/compound key admits the selector
   without duplicating the physical constraint.
7. A lone ordinary slot fails at full-schema construction.
8. Matching relation names pair the intended endpoints; one-sided names,
   mismatches, duplicate same-name candidates, and incompatible targets fail.
9. One ordinary and one variant candidate without distinct matching names are
   ambiguous; neither wins by precedence.
10. A lone self slot fails; two self slots resolve; two distinctly named self
   pairs do not cross.
11. Default self-junction orientation is stable and reverse traversal uses the
    opposite side.
12. A non-owning to-one result is nullable without an `.optional()` modifier,
    while an all-non-nullable FK owner result is non-null.
13. An all-nullable scalar or compound FK is nullable; an all-non-nullable tuple
    is required; a mixed tuple is valid and nullable because any nullable member
    can make the complete membership absent.
14. Disconnecting a mixed tuple clears every nullable member and retains each
    required context member. Database `setNull` is rejected unless every tuple
    member is nullable.
15. A widened non-fresh FK field tuple infers a conservative nullable result,
    while a literal tuple retains exact nullability.
16. A physical unique FK paired with remote to-many fails.
17. `setNull` is unavailable on an ordinary junction and hostile runtime input
    fails before DDL.
18. Equal old table/action overrides on both many-to-many endpoints convert to
    one configuration owner with an identical `TableDef`; a final-API schema
    that configures both endpoints fails before DDL.
19. The trusted index stores one contextual slot map. Its stable derived edge
    iterator enumerates ordinary pairs, self-pairs, row carriers, and member
    junctions exactly once without a synchronized `edges` collection.
20. Changing only one referenced local scalar from required to nullable changes
    result nullability and disconnectability without changing the relation's
    stored declaration state.
21. A self parent/children pair omits the exact parent-owned FK from nested input
    and exposes disconnect only where its resolved nullable subset allows it.
    Two distinctly named self pairs remain separated in public core and every
    driver-wrapper type surface.
22. Registering one exact model object under two schema keys fails at client,
    registry, migration, and `push({ skipValidation: true })` construction before
    hydration, an index, query, or DDL effect exists. After client A binds the
    model as `alpha`, a client-B attempt to bind it as `beta` fails without
    changing the model name, and client A still emits SQL for `alpha`; rebinding
    `alpha` is idempotent.
23. When both endpoints share a `string`-typed dynamic relation name that is
    equal at runtime, construction resolves the edge, while static nested-create
    input conservatively retains the parent-owned FK because equality cannot be
    proved. The widened type never omits a required field or exposes an unsafe
    disconnect; literal names recover the exact omission.

### 11.3 Variant topology

1. All four carrier/inverse cardinality cells produce their expected storage
   and uniqueness.
2. A wholly direct-only row carrier and direct-only member junctions succeed
   with non-unique membership.
3. Row-held bound inverses all-one and all-many succeed; mixed cardinalities
   fail. In a partially bound row carrier, unbound members inherit the one
   carrier-wide unique/non-unique index rather than emitting a member-local
   answer.
4. Member-junction variants may mix inverse cardinalities.
5. Two inverses for one variant fail.
6. Repeated target model keys work for direct reads/writes and fail only when an
   inverse cannot choose a member. Splitting the inverse-bearing variants into
   separate carrier fields with matching `.name(...)` pairs resolves the graph
   without any member-selector API.
7. An ordinary slot with completed fields/references or junction overrides
   cannot bind as a variant inverse.
8. Variant to-one identity compatibility and variant to-many compound/native
   identity support remain pinned.
9. Direct and inverse singular-member writes preserve one-winner CAS behavior,
   exact duplicate no-op behavior, and non-retryable target-unique failures.
10. A malformed FK field/reference or incompatible variant row identity cannot
    reach a client, registry, serializer, or `push({ skipValidation: true })` as
    a trusted edge; the mandatory definition gate returns no partial index and
    causes no DDL.
11. A carrier lookup returns its shared edge with no member view. Every bound
    inverse lookup returns that same edge object and the exact member object
    already present in `edge.members`; a direct-only member creates no inverse
    slot entry.
12. Renaming a public variant key while retaining its mapped stored value makes
    row predicates and member-junction migration history read the same
    normalized `VariantEntry`; neither storage family guesses a rename from the
    public key or copies the stored discriminator.
13. In each of the four carrier/inverse cardinality cells, nested create and
    ordinary nested update through the inverse reject the exact carrier relation
    key beside a real target field; the documented selected-upsert-update arm
    remains the sole re-entry exception. The public type surface and runtime
    schema omit the same key.
14. Static and runtime clearability agree in all four cells: an inverse of a row
    carrier exposes disconnect exactly when the carrier is optional, while an
    inverse of a member-junction carrier clears by deleting membership for both
    inverse cardinalities. Required row-carrier storage exposes no unsafe
    disconnect.

### 11.4 Consumer behavior

1. Required/optional model-target results have exact nullability.
2. To-many results are arrays for both target kinds.
3. Variant result unions remain correlated by public key.
4. `only`, omitted/maybe-undefined `variants`, arm defaults, and `false`
   projection behavior remain exact.
5. Relation filters, ordering, aggregates, cursor behavior, and counts choose
   cardinality rather than old names.
6. Create, update, upsert, connect, connectOrCreate, disconnect, delete, set,
   createMany, updateMany, deleteMany, and bulk-return projections preserve
   their accepted direct/inverse behavior.
7. `.extends()` resolves and parses one shared relation instance correctly under
   two source models.
8. Ordinary and variant junction paths retain compound keys, mapped names,
   cascades, atomic rollback, and native-batch behavior.
9. For `(tenantId required, parentId nullable)`, direct disconnect, inverse
   disconnect, parent-held delete, and set departure clear only `parentId` and
   preserve `tenantId`; each path is pinned on transaction and native-batch
   execution.
10. Client construction calls the resolver once; `SchemaRegistry` and
    client omit rewriting and `QueryEngine` expose the same index by strict
    object identity. Standalone registry and migration construction each call
    it once for their own lifecycle. No model or query-scope variant-topology
    cache is populated.
11. Nested client defaults traverse ordinary and variant relations through
    their resolved slot/member targets. A stateful getter is invoked only during
    declaration settlement, and the exact settled target receives its configured
    omit in ordinary, row-carrier, and member-junction projections.

### 11.5 Migration and preservation

1. Every canonical conversion pair produces equal `TableDef` values.
2. PostgreSQL, MySQL, SQLite, libSQL, D1, and provider-specific snapshot
   spellings remain exact where their current suites cover them.
3. Second push is empty for every canonical topology.
4. One unnamed non-self pair keeps the current model-pair default; named pairs
   keep the current relation-name suffix, while self sides use stable field-key
   tokens without collisions.
5. Converting an old named junction preserves its relation name and exact table,
   columns, indexes, and constraints; consolidation emits explicit
   `.through(...)` only when needed to keep those bytes.
6. Variant row and member storage metadata round-trips unchanged.
7. Each deliberate break has an exact new diagnostic and no DDL/write effect.
8. No source conversion test infers preservation from a digest alone; the
   expected structural artifact is inspectable in the fixture.
9. Migration serialization emits the `ResolvedJunctionTopology` stored on the
   resolved edge and never invokes physical junction expansion again.
10. Relation resolution adds no copied physical columns, constraints, or
    actions. Existing `storageRef`/`relationStorage` and
    `memberJunctionTable` snapshot joins remain byte-identical and are never
    read as declaration or topology inputs.
11. When an inverse model sorts before its variant carrier, row storage and
    member tables still serialize at the carrier anchor in the same canonical
    order as the baseline snapshot.
12. In one schema with an ordinary junction whose anchor sorts before a later
    variant carrier, the full snapshot/table order remains byte-identical:
    model and variant-member tables retain the first phase, and ordinary
    junction tables retain the second phase.

## 12. Validation gates

The implementation uses the repository's safe package launchers and workspace
lock. Do not invent `test:gates`, `test:extended`, or broad raw Vitest commands.

### 12.1 Package feedback

Run in dependency order, never concurrently:

```bash
pnpm test:layer:relations
pnpm test:layer:schema-validation
pnpm test:layer:validation
pnpm test:layer:operation-schemas
pnpm test:layer:query-engine
pnpm test:layer:adapters
pnpm test:layer:drivers
pnpm test:layer:client
pnpm test:layer:migrations
pnpm test:types
```

### 12.2 Coverage and architecture

```bash
pnpm test:coverage:relations
pnpm test:coverage:schema
pnpm test:coverage:schema-validation
pnpm test:coverage:validation
pnpm test:coverage:write-engine
```

The existing architecture/construction gates run through their owning layer or
coverage script. If a new static gate is needed, register it with an existing
package script; do not leave a comment that claims a command exists.

### 12.3 Final credential-free and provider gates

```bash
pnpm test:all
pnpm test:providers
```

`test:providers` may skip missing hosted/Docker services visibly. Completion
records executed and skipped legs exactly; it does not claim skipped evidence.

### 12.4 Tracked-source census

Use two detectors with disjoint semantic regions. The source AST gate owns
executable TypeScript and JavaScript nodes: exports, relation-state
discriminants, internal construction symbols, public terminal capabilities, and
factory-rooted call chains. The tracked-text gate owns Markdown/MDX and other
non-AST assets plus comments/JSDoc and string/template-literal contents inside
parseable source. It does not rescan executable identifiers. Both enumerate
`git ls-files`; neither relies on `rg docs` or an incomplete directory list.

This subsection is the sole allowlist authority. The text gate permits retired
spellings only in:

- §1's explicit retired-factory list, §3.4's deletion ledger, §§9.1–9.2's
  conversion/codemod specification, the relevant negative falsifiers in §11,
  and this §12.4 gate specification, where retired spellings are the subject;
- historical architecture plans with a superseded-API banner.

It fails on old factory/import/fluent-call spellings in every other textual
region, including root docs, package docs, examples, text fixtures, source
comments/JSDoc examples, and user-facing string/template diagnostics. The
source AST gate owns executable source/test usage, so one semantic region is
never guarded twice. The scanner's own retired-pattern table receives one exact
node/location exemption rather than a file-wide exemption, and each detector
has a self-falsifier.

The source gate checks at least these exact retired identifiers:

```text
oneToOne
manyToOne
oneToMany
manyToMany
polymorphicToOne
polymorphicToMany
ManyToManyRelation
ManyToManyRelationState
PolymorphicToOneRelation
PolymorphicToManyRelation
PolymorphicRelationState
polymorphicRelations
PolymorphicRelationMap
extractPolymorphicRelationMap
RelationType
setSource
polymorphicMemberCarrier
AnyPolymorphicRelation
PolymorphicStateOf
RelationInfo
_polymorphicStorage
getPolymorphicStorage
setPolymorphicStorage
polymorphicRelationsByModel
PolymorphicRelationInfoOf
PolymorphicToOneRelationInfo
PolymorphicToManyRelationInfo
PolymorphicRelationInfo
isPolymorphicToOneRelationInfo
ResolvedPolymorphicEdge
```

It also proves that the trusted relation state has no old four-way topology
discriminant; no public relation terminal exposes `.A()`, `.B()`, ordinary
`.optional()`, or `.unique()`; and an incomplete `.fields(...)` stage is not a
relation. These capability checks use the public type surface plus AST inspection
of relation-factory-rooted chains; they do not ban unrelated methods with the
same spelling.

The architecture type-shape gate separately proves the compressed internal
contract: the successful topology result stores only the contextual slot map;
`ResolvedSlot` is the consumer descriptor; resolved FK edges do not copy
optionality or actions outside `ResolvedStoredReference`; variant edges do not
copy fixed cascade values, target models already present in junction topology,
stored discriminator strings from normalized entries, or parallel member maps;
the capability-narrowed normalized-entry view exposes neither a raw target
getter nor an unresolved junction override;
the row-inverse and junction-inverse `ResolvedSlot` arms accept only their
corresponding member type; both carrier member collections reject `[]` as
structurally impossible; and no relation-specific diagnostic type translates
`SchemaValidationIssue`.

It also pins the one static projection as a closed union: ordinary FK and
junction arms, one `variantInverse` arm with the literal carrier key and derived
clearability, and a fail-closed `unknown` arm. The variant arm exposes no raw
getter, storage-family tag, member identity, or second target map; its two
consumer facts are the only inputs to nested omission and disconnect typing.

The same architecture gate proves that model internals expose no resolved
`ModelInternals.polymorphicStorage` map/accessor and query scope exposes no
fact-bearing polymorphic relation cache or info/edge facade. These checks are
qualified by owner/type shape: they deliberately do not ban migration snapshot
`polymorphicStorage` or write-time `PolymorphicStorageValue` execution payloads.

The tracked-text gate checks prose/code-fence calls to the six deleted `s.*`
factories, their direct imports, current examples of retired fluent relation
spellings, and the same precise patterns in source comments and literal text.
The source gate matches executable identifiers and AST shapes rather than raw
text, so comments cannot make it red and a lookalike cannot make it green. Each
detector has its own self-falsification witness.

The two detectors have explicit lifecycle assertions, not disabled red gates:

1. Package A checks each detector's exact frozen baseline manifest of
   old-surface occurrences and its own self-falsifier.
2. Package F replaces both manifest expectations with their final
   zero-outside-allowlist assertions. No intermediate package claims the estate
   is already converted. The temporary codemod's stdout/ignored stop report is
   never part of either tracked manifest and is deleted with the codemod.

## 13. Retained boundaries and non-goals

This plan does not:

- add compatibility aliases or a legacy schema reader;
- change the fixed-decimal plan;
- redesign transaction-array generated-output behavior;
- add a user-visible relation `.unique()` modifier;
- make ordinary relations unidirectional;
- add per-variant member selectors for repeated target models;
- change variant to-one's compatible single-scalar identity restriction;
- add polymorphic FK action modifiers;
- replace existing singular junction transfer or record-series algorithms;
- redesign migration rollback/squash policy;
- promise that raw SQL cannot corrupt private variant storage;
- make TypeScript the runtime topology authority.

These are deliberate boundaries, not hidden compatibility gaps. A future
feature that changes one must extend the existing owner named in this plan,
not add a parallel relation family.

## 14. Completion criteria

The plan is implemented only when all statements below are true:

1. The public namespace exports only `toOne` and `toMany` for relations.
2. Both factories support getter and non-empty variant-map overloads.
3. Public types and runtime agree exactly for statically decidable declarations;
   accepted widened declarations remain conservatively sound and never claim
   unsafe omission, requiredness, or mutation capability.
4. Relation state stores one cardinality and one normalized target domain.
5. Models store one canonical relation map.
6. One model object has one write-once schema name; duplicate or later
   different-key registration fails before hydration or a model-keyed index,
   while same-key reuse is idempotent.
7. No relation stores a mutable source model.
8. One schema-wide graph owns pairing, FK ownership, uniqueness, and membership.
9. Exact matching relation names and degree rules replace every inverse
   precedence ladder and standalone pairing-name registry.
10. Every ordinary relation has a complete inverse and physical owner.
11. All four variant inverse cardinality cells remain supported.
12. Operation schemas and result types compose target element shape with local
    cardinality once.
13. Client omit, query, write, clearability, result-parser, and migration
    consumers use the resolved index and never rediscover an inverse or invoke
    a raw target getter.
14. The index stores one contextual slot map; edge enumeration is derived, and
    the same instance is threaded through each composition root. No model/query
    polymorphic topology cache, fact-bearing `RelationInfo`, or relation-specific
    diagnostic vocabulary remains.
15. Mixed-nullability compound FKs are valid, nullable, and disconnectable
    without clearing required context members; database `setNull` still requires
    every member to be nullable.
16. Concrete terminal implementations remain private, and repeated ordinary
    modifiers use immutable last-call-wins semantics.
17. Synthetic variant carrier relations and their brand exception are gone.
18. Canonical conversions retain exact physical snapshots, table ordering, and
    behavior.
19. Deliberate breaks are separately enumerated and fail before effects.
20. Old factories, declared topology state, parallel maps, and compatibility
    branches are absent from live tracked code and docs.
21. The temporary codemod and every local stop report are deleted.
22. Every command in §12 that can run in the environment is green; skipped
    provider evidence is reported honestly.

The implementation report must state five things plainly: what concepts were
deleted, what single owner replaced them, which canonical behavior stayed
identical, which previously accepted shapes now fail, and which provider gates
actually ran.
