# General Polymorphic Relations Plan

> **Superseded relation spellings.** This document is a historical record. Its
> relation declarations use the retired six-factory API, and its diagnostics and
> internal type names may name owners that no longer exist. The shipped language
> is two factories, `s.toOne` and `s.toMany`, whose argument states the target
> domain; pairing, foreign-key ownership, uniqueness, junction topology and slot
> emptiness are all derived by one schema-wide resolver. See
> [`./global-relation-cardinality-plan.md`](./global-relation-cardinality-plan.md) for the unified language and
> the deliberate verdict changes it made. The measured history below is
> deliberately not rewritten into a new-API history.

**Date:** 2026-08-18

**Status:** Decision-complete implementation plan; not implemented

**Starting branch:** `by-polymorphic-relations`

**Starting commit:** `39a0f12e`

## 1. Outcome

Make polymorphism and cardinality independent schema choices.

~~~ts
const subject = s.polymorphic({
  post: () => post,
  video: () => video,
});

const comment = s.model({
  // One target selected from the variant map.
  subject: subject.toOne().optional(),
});

const collection = s.model({
  // Zero or more targets selected from the same variant map.
  items: subject.toMany(),
});
~~~

The public declaration has two axes:

1. the polymorphic variant answers **which target model** a membership uses;
2. `.toOne()` or `.toMany()` answers **how many memberships** the declared
   relation slot can hold.

The inverse slot supplies the other endpoint's cardinality. The familiar four
relationship topologies are derived from those two slot cardinalities; they are
not stored as a second relation-kind enum.

| Declared polymorphic slot | Inverse slot | Derived topology | Delivered state |
|---|---|---|---|
| one | one | one-to-one | Existing capability, made explicit with `.toOne()` |
| one | many | many-to-one | Existing capability, made explicit with `.toOne()` |
| many | one | one-to-many | New capability from `.toMany()` plus a singular inverse |
| many | many | many-to-many | New capability from `.toMany()` plus a plural inverse |

There is deliberately no `.manyToMany()` terminal on `s.polymorphic()`. The
direct declaration can only know its own slot cardinality. Many-to-many is the
derived topology produced by `.toMany()` plus a plural inverse; naming it on one
side would duplicate or contradict the inverse's cardinality fact.

The completed feature includes:

- an explicit cardinality terminal on every polymorphic declaration;
- singular and collection result types;
- direct and inverse reads;
- relation filters, counts, and count ordering;
- a stable variant allow-list plus arm-local projection, filtering, ordering,
  cursor, pagination, and distinct;
- the ordinary to-many nested mutation family, correlated by variant;
- relation-bearing root `createMany`;
- compound and mapped row keys on polymorphic collection targets;
- schema serialization, migration diffing, introspection, and second-push
  stability on every shipped dialect family;
- exact transaction, progressive-batch, retry, cache, and bind-budget behavior.

This is a cardinality lift, not a compatibility exercise. VibORM is unreleased:
all existing declarations must add `.toOne()`. There is no deprecated implicit
default and no dual runtime representation.

## 2. Domain model

### 2.1 Cardinality belongs to a slot

`.toOne()` and `.toMany()` describe the public slot on the model where the
polymorphic relation is declared.

- A `toOne` slot contains exactly one membership unless it is `.optional()`.
- A `toMany` slot contains a collection and may be empty.
- `toMany` does not have an optional state. An empty collection already
  expresses absence.
- VibORM does not promise a required non-empty collection. That invariant cannot
  be preserved by ordinary relational constraints across arbitrary deletes.

The target-side inverse is a separate slot. Its own ordinary relation factory
describes its cardinality from the target's point of view.

### 2.2 Exact topology matrix

The following declarations are canonical.

#### Polymorphic one-to-one

One badge has one subject, and a subject row has at most one badge.

~~~ts
const badge = s.model({
  subject: s
    .polymorphic({ user: () => user, team: () => team })
    .toOne()
    .name("badgedSubject"),
});

const user = s.model({
  badge: s.oneToOne(() => badge).optional().name("badgedSubject"),
});
~~~

#### Polymorphic many-to-one

Each comment has one subject; one subject can have many comments.

~~~ts
const comment = s.model({
  subject: s
    .polymorphic({ post: () => post, video: () => video })
    .toOne()
    .name("comments"),
});

const post = s.model({
  comments: s.oneToMany(() => comment).name("comments"),
});
~~~

#### Polymorphic one-to-many

One collection has many items; each item row can belong to at most one
collection through this named relation.

~~~ts
const collection = s.model({
  items: s
    .polymorphic({ post: () => post, video: () => video })
    .toMany()
    .name("primaryCollection"),
});

const post = s.model({
  collection: s
    .manyToOne(() => collection)
    .optional()
    .name("primaryCollection"),
});
~~~

The fields-less `manyToOne` is intentional. Its membership is stored in the
polymorphic collection's junction table, not in a public post scalar.

#### Polymorphic many-to-many

One collection has many items, and one target row can belong to many
collections.

~~~ts
const collection = s.model({
  items: s
    .polymorphic({ post: () => post, video: () => video })
    .toMany()
    .name("collections"),
});

const post = s.model({
  collections: s.manyToMany(() => collection).name("collections"),
});
~~~

The `manyToMany` inverse is a public view of the polymorphic declaration's
member junction. It does not own or serialize another table. Junction modifiers
on that inverse are invalid because the direct polymorphic declaration already
owns the physical topology.

### 2.3 Variant-local inverse cardinality

For a `toMany` relation, each variant has its own junction table. Its inverse
cardinality is therefore a member fact, not a relation-wide fact.

~~~ts
const shelf = s.model({
  entries: s
    .polymorphic({ uniqueBook: () => book, sharedVideo: () => video })
    .toMany()
    .name("shelfEntries"),
});

const book = s.model({
  shelf: s.manyToOne(() => shelf).optional().name("shelfEntries"),
});

const video = s.model({
  shelves: s.manyToMany(() => shelf).name("shelfEntries"),
});
~~~

The book member is one-to-many and receives a unique target-side junction
constraint. The video member is many-to-many and receives a non-unique reverse
index. No provider-specific partial index is required.

The existing row-held `toOne` representation has one shared discriminator/id
pair. It retains the current relation-wide inverse-cardinality rule: its
variants cannot mix singular and plural inverses. Lifting that identity/storage
restriction is a separate project, not a prerequisite for collection
cardinality.

### 2.4 No inverse

An inverse declaration is optional.

- A `toOne` relation with no inverse keeps its current default plural inverse
  capability: several owners may reference the same target.
- A `toMany` member with no inverse defaults to a shareable target: several
  owners may have that target in their collections.
- Absence of a public inverse does not remove physical foreign keys from a
  `toMany` junction.

## 3. Non-negotiable contracts

1. **One cardinality fact.** The configured polymorphic state stores only
   `"one" | "many"`. Every topology name, result wrapper, operation schema,
   and physical view derives from that fact and the inverse slot.
2. **One membership owner.** Direct `toOne` owns its private row columns.
   Direct `toMany` owns its per-variant junction family. An inverse relation
   never serializes a second membership.
3. **No guessed target.** Every target is selected by an exact public variant
   and a complete target selector or provider-produced row key.
4. **Real integrity where the topology permits it.** Every `toMany` member has
   a real owner foreign key and target foreign key. Compound row keys stay
   complete and ordered.
5. **No guard-to-write gap.** A membership or liveness premise that protects a
   write shares an atomic write segment with that write.
6. **No hidden atomicity change.** Transaction-capable drivers remain
   operation-atomic. Native-batch-only drivers may use the existing documented
   segment-atomic route. Explicit `$transaction([...])` remains indivisible.
7. **Strict results.** Unknown variants, malformed carriers, impossible
   nullability, missing targets, and incomplete tuples fail. They never become
   `null`, `[]`, or a partially parsed row.
8. **Adapter-owned SQL.** Query-engine code describes branch, junction, window,
   and set structure. Adapters continue to own SQL grammar and JSON spelling.
9. **One validation boundary.** Public payloads are variant-correlated in the
   operation schema. Builders consume trusted tagged programs and do not
   revalidate their shape.
10. **No identity narrowing.** `toMany` uses each endpoint's complete row key.
    It does not project a compound key to member zero or require target variants
    to share a scalar representation.
11. **No silent estate compatibility.** Bare `s.polymorphic(...)` is not a
    model field. Every source, test, fixture, and documentation declaration
    must choose a terminal.
12. **One falsifier per invariant.** A new downstream assertion is forbidden
    when an existing type or parse boundary already owns the failure.

## 4. Public schema contract

### 4.1 Unfinished builder and configured terminals

`s.polymorphic()` returns an immutable unfinished builder. The builder exposes
only `.toOne()` and `.toMany()`.

~~~ts
const subject = s.polymorphic({
  post: () => post,
  video: () => video,
});

const requiredSubject = subject.toOne();
const optionalSubject = subject.toOne().optional();
const subjects = subject.toMany();
~~~

The builder can be reused. Calling a terminal does not resolve target getters
and does not mutate the builder.

The configured classes remain separate rather than using inheritance:

- `PolymorphicRelationBuilder` owns cardinality selection;
- `PolymorphicToOneRelation` owns `.name()` and `.optional()`;
- `PolymorphicToManyRelation` owns `.name()` and optional junction mapping.

The implementation may share immutable construction helpers, but the public
classes have different valid methods and different type states. A single class
with methods that return `never` would leave invalid operations visible in
editor completion.

The type and runtime rules are exact:

- the unfinished builder cannot appear in `s.model`;
- cardinality can be selected once;
- `.optional()` exists only after `.toOne()`;
- `.toMany().optional()` is not a public member;
- `.toOne().toMany()` and `.toMany().toOne()` are impossible;
- hostile JavaScript or a forced unfinished carrier reaches definition
  validation and gets one owned schema issue rather than disappearing from
  model extraction.

### 4.2 Targets and stable storage values

The existing factory shape remains:

~~~ts
s.polymorphic(
  {
    article: () => post,
    clip: () => video,
  },
  {
    values: {
      article: "post",
      clip: "video",
    },
  }
);
~~~

The target-map key is the public variant returned as `result.type`. The
corresponding `values` entry is its stable storage identity.

- For `toOne`, the value is stored in the private discriminator column.
- For `toMany`, table identity carries each membership. The value remains in
  snapshot metadata so a public variant rename can be distinguished from a
  removed or retargeted member.

The map remains exact and immutable. Keys and values are unique. Target getters
stay lazy. Two public variants may target the same model and remain distinct
members because each gets a distinct table. If either has a public inverse,
definition validation retains P010: that inverse cannot yet say which
same-model variant it represents.

### 4.3 Optional junction mapping

Default physical names are sufficient for ordinary use. A `toMany` terminal
also supports one exact mapping for users who need stable legacy or constrained
database names:

~~~ts
s.polymorphic({ post: () => post, video: () => video })
  .toMany()
  .through({
    post: {
      table: "collection_posts",
      source: "collection",
      target: "post",
    },
    video: {
      table: "collection_videos",
      source: "collection",
      target: "video",
    },
  });
~~~

The map must contain exactly the public variants. `source` and `target` are the
same single-token scalar-column/compound-prefix concept already owned by
ordinary junction field groups. They are not independent arrays of physical
columns.

The surface deliberately uses directed names rather than `.A()` and `.B()`.
The polymorphic owner and target are not a symmetric pair, so exposing A/B
would make users reconstruct an orientation the declaration already knows.

`toOne` has no `.through()`. Neither cardinality gains `.fields()` or
`.references()`: polymorphic storage remains private and cannot have a second
public scalar spelling.

`toMany` does not expose `.onDelete()` or `.onUpdate()` in this version. Every
member table uses `cascade` for both actions on both FKs. This is not an
arbitrary convenience default: member columns are non-null primary-key members,
so `setNull` is physically invalid, while `restrict` or `noAction` would
contradict the collection's promised owner/target delete and complete-key
transition behavior. Custom junction actions are a separate ordinary-junction
policy project. A hostile forced modifier is rejected before DDL, and a
polymorphic-bound inverse cannot repeat or override the fixed actions.

### 4.4 Creation requiredness

- A required `toOne` relation remains required in ordinary create data.
- An optional `toOne` may be omitted.
- A `toMany` relation may always be omitted and then starts empty.
- Root `createMany` never requires a `toMany` field.
- The current runtime and type-level “all non-optional polymorphic fields are
  required” checks must branch through the cardinality owner, not inline a new
  condition.

## 5. Physical topology

### 5.1 Storage descriptor union

Replace the single assumed `PolymorphicStorage` shape with a discriminated
storage descriptor:

~~~ts
type PolymorphicStorage =
  | PolymorphicToOneStorage
  | PolymorphicToManyStorage;

interface PolymorphicToOneStorage {
  readonly kind: "toOne";
  // Existing relationName, owner, type/id columns, index,
  // relation-wide inverse cardinality and members.
}

interface PolymorphicToManyStorage {
  readonly kind: "toMany";
  readonly relationName: string;
  readonly ownerModel: AnyModel;
  readonly members: ReadonlyMap<string, PolymorphicJunctionMember>;
}

interface PolymorphicJunctionMember {
  readonly publicType: string;
  readonly storageValue: string;
  readonly targetModel: AnyModel;
  readonly inverseCardinality: "one" | "many";
  readonly junction: ResolvedJunctionTopology;
}
~~~

`ResolvedJunctionTopology` is a new schema-layer extraction of a truth that is
currently rebuilt twice. Today the query engine's private
`resolveJunctionTopology()` builds ordered `JunctionSide` members, while the
migration serializer independently repeats row-key expansion, canonical side
ordering, constraint naming, and referential-action resolution. That duplicate
ownership must be removed before polymorphic member junctions are added.

The extracted topology contains only provider-neutral schema facts:

- the resolved table name;
- both endpoint models;
- each side's naming token and complete ordered
  `{ junctionField, referencedField }` members;
- canonical physical side order;
- primary, index, unique, and foreign-key names;
- resolved referential actions.

It contains no `Sql`, migration `ColumnDef`, or provider-native type. The query
engine projects it into its existing `JunctionSide`; the serializer decorates
the referenced fields with migration-driver column types and emits `TableDef`.
`getJunctionFieldGroups()` remains the low-level compound-prefix primitive, not
the full topology owner.

Put this owner in a cohesive schema relation module such as
`src/schema/relation/junction-topology.ts`. It accepts explicit endpoint models
and an already reconciled ordinary-pair or polymorphic-member configuration.
It must not require a synthetic `manyToMany` relation merely to resolve a
polymorphic member. Do not add a polymorphic clone containing scalar
`sourceId`/`targetId` shortcuts.

### 5.2 `toOne` stays row-held

The cardinality lift preserves the current private owner columns:

~~~text
comment.subject_type
comment.subject_id
~~~

This matters for more than compatibility:

- connect remains one owner INSERT or UPDATE when the target is already known;
- the direct createMany connect-only fast path remains one grouped statement;
- no owner row key is required merely to store its membership;
- no additional membership write is introduced;
- a required slot cannot be left between an owner write and a later junction
  write on a segment-atomic substrate.

The existing `toOne` target restriction remains: every target has one compatible
portable scalar primary key. A future exclusive-arc design—one discriminator
plus one nullable complete foreign-key tuple per variant—is the coherent way to
lift that restriction. It is not folded into this cardinality project because
it changes every singular row layout, migration, read, write, and referential
action even when no collection is requested.

An all-junction `toOne` design is explicitly rejected. It would add one write to
every singular connect, break the current bulk fast path, require an owner row
key, and still could not portably enforce that a required owner has a matching
row in one of N tables.

### 5.3 `toMany` uses one junction table per variant

For this declaration:

~~~ts
const collection = s.model({
  id: s.string().id(),
  items: s.polymorphic({ post: () => post, video: () => video }).toMany(),
});
~~~

VibORM generates two ordinary-shaped junction tables:

~~~text
collection_items_post
  collection row-key columns...
  post row-key columns...

collection_items_video
  collection row-key columns...
  video row-key columns...
~~~

Each member table owns:

1. a complete ordered source side referencing the owner's row key;
2. a complete ordered target side referencing that variant's row key;
3. a primary or unique membership constraint over source plus target;
4. a target-side reverse index;
5. a real source foreign key with fixed `ON DELETE CASCADE` and
   `ON UPDATE CASCADE`;
6. a real target foreign key with the same fixed cascade actions;
7. a unique target-side constraint when that member's inverse cardinality is
   one.

Table identity is the discriminator. No `target_type` column is stored in a
membership row.

### 5.4 Why not one heterogeneous junction

One table shaped as `(owner key, target_type, target_id)` looks compact but is
the wrong long-term owner.

| Property | Shared heterogeneous table | Per-variant ordinary tables |
|---|---:|---:|
| Real target foreign key | No | Yes |
| Target delete/key-update integrity | Application only | Database owned |
| Compound target row keys | Requires one shared arity | Native per target |
| Mixed target key types/native spellings | No | Yes |
| Reuse ordinary junction DDL and DML | Partial | Complete |
| Variant-local singular inverse | Provider-specific partial uniqueness | Ordinary unique target side |
| Equal IDs in different target tables | Needs discriminator in every predicate | Naturally isolated |
| Retarget migration | Rewrites tagged rows | Moves/rebuilds one member table explicitly |

The cost is N small junction tables for N target variants. That is the honest
physical expression of N different foreign-key destinations. Hiding them in one
table saves catalog rows by deleting database integrity.

### 5.5 Naming and collision ownership

Default names derive from physical owner table, public relation field, and
public variant through one polymorphic-junction naming owner. That owner
delegates column/prefix expansion and constraint names to the existing junction
field-group and constraint owners.

This is a deliberate readability choice. A public variant rename changes its
default member-table name and is normalized as a structural table rename; the
stable storage value lets history prove that it is the same logical member and
that no membership DML is needed. Users who need a public rename to leave the
physical name byte-identical pin the table through `.through()`. Changing only
the stable storage value does not rename a `toMany` table because no row stores
that value.

It validates all generated and explicit names against:

- model tables and scalar columns;
- ordinary junction tables and constraints;
- other polymorphic member tables;
- private `toOne` columns and indexes;
- provider identifier limits already enforced by schema validation.

The serializer, binder, query engine, and polymorphic validator must consume the
same resolved member topology. None may independently reconstruct a table or
column name.

## 6. Binding and relation classification

### 6.1 Preserve the three relation axes

The query engine already separates:

- **position**: parent-held, child-held, or junction;
- **cardinality**: one or many;
- **membership**: foreign key, polymorphic row storage, or junction.

The missing shape is `position: junction`, `membership: junction`,
`cardinality: one`. Current junction classification assumes every junction is
many because every junction came from `manyToMany`.

Widen the existing bound-relation topology. Do not add names such as
`polymorphicManyToManyBoundRelation` or branch on the public relation factory at
every consumer.

The result must admit:

~~~ts
type JunctionBoundRelation = {
  readonly position: "junction";
  readonly cardinality: "one" | "many";
  readonly membership: {
    readonly kind: "junction";
    readonly table: string;
    readonly source: JunctionSide;
    readonly target: JunctionSide;
  };
  // Existing relationInfo and BoundRelationBase facts.
};
~~~

This widens only the live relation's `cardinality` property. It does not move
`table`, `source`, or `target` out of `BoundJunctionMembership` and does not add
a second junction representation.

Internal scopes and predicates whose semantic name is currently
`manyToMany` must become cardinality-neutral `junction` scopes when the new
singular junction reaches them. The table plus complete source/target sides
still identify the membership. Do not replace that stale name with a new
`polymorphicJunction` cross-product.

### 6.2 Direct and inverse bindings

The direct polymorphic field remains a distinct public relation category. Its
tagged union, operation grammar, and result envelope are not ordinary relation
semantics.

Each `toMany` member also materializes an internal fixed-target junction binding
from the resolved storage descriptor. That binding is what ordinary traversal,
selection, and mutation leaves consume.

An inverse ordinary field binds as follows:

- fields-less optional `manyToOne` may bind a `toMany` member with cardinality
  one;
- `manyToMany` may bind a `toMany` member with cardinality many, but becomes a
  view of the direct member table rather than an independent junction owner;
- the current fields-less optional `oneToOne` and `oneToMany` bindings to
  `toOne` remain unchanged;
- a relation with real `.fields()` remains an ordinary FK candidate and cannot
  be shadowed by a polymorphic name match.

A polymorphic-bound inverse `manyToMany` must not spell `.through()`, `.A()`,
`.B()`, `.onDelete()`, or `.onUpdate()`. Reject those modifiers at definition
validation. Silently ignoring them would create two apparent physical owners.

Classification must resolve the polymorphic binding before the current
unconditional ordinary-`manyToMany` junction branch. The serializer follows the
same resolved verdict so the inverse does not emit a second table.

Pairing precedence remains in the existing inverse resolver: exact `.name()`,
physical ordinary FK ownership, then the convenient unambiguous polymorphic
candidate. The cardinality compatibility check becomes a named projection of
that one resolution; operation schemas and definition validation do not each
invent a candidate rule.

A fields-less `manyToOne` that binds a polymorphic member is non-owning storage
and must be declared optional. Extend the existing non-owning-singular
optionality rule that already covers fields-less `oneToOne`; do not add a
polymorphic-only parser exception. A required spelling is rejected at schema
definition validation. Do not try to encode this target-dependent cross-model
rule into `model()` or the relation carrier: that path has already proved
recursive-inference-hostile. The public type contract instead proves that the
accepted optional spelling infers `Owner | null`, and runtime validation owns
the invalid required declaration.

### 6.3 Clearability

- Optional `toOne` is clearable by nulling its row-held pair.
- Required `toOne` is not clearable.
- Direct `toMany` is always clearable by deleting member rows.
- A fields-less singular inverse over a junction is optional and clearable by
  deleting its one member row.
- A plural inverse is always clearable as an ordinary collection.

Both the runtime and type-level clearability owners must derive these answers
from configured cardinality and bound membership. Do not place another
`state.type` disjunction in operation-schema construction.

## 7. Public read and type contract

### 7.1 Result shapes

The singular result remains exhaustive:

~~~ts
type Subject =
  | { type: "post"; data: Post }
  | { type: "video"; data: Video };

type OptionalSubject = Subject | null;
~~~

Without a variant allow-list, the collection result wraps that same exhaustive
union in a new array:

~~~ts
type Items = Array<
  | { type: "post"; data: Post }
  | { type: "video"; data: Video }
>;
~~~

A `toMany` result is never `null`. The parser returns a fresh public array even
when a driver result is already an array.

`InferPolymorphicResult` derives the wrapper from cardinality once. Variant
selection narrows the element union, and variant projection determines each
remaining `data` member. Client-level omit applies to every visible variant row
before the tagged envelope is returned.

### 7.2 Variant selection, projection, and arm-local list controls

A collection needs an explicit distinction between **which variants are
visible** and **how each visible variant is projected**. Reusing the current
flat `toOne` projection map would leave no collision-free relation-level option:
a user may legitimately name a public variant `only` or `variants`.

`toMany` therefore has its own projection envelope:

~~~ts
const rows = await db.collection.findMany({
  include: {
    items: {
      only: ["post"],
      variants: {
        post: {
          where: { published: true },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: { id: true, title: true },
        },
      },
    },
  },
});
~~~

The exact public shape is:

~~~ts
type PolymorphicCollectionSelection<PublicType, VariantMap> =
  | false
  | true
  | {
      readonly only?: readonly PublicType[];
      readonly variants?: VariantMap;
    };
~~~

- the outer `false` is the shared relation-selection contract: the relation key
  and its SQL are omitted entirely; it is not an empty collection projection;
- `true`, or omission of `only`, means every configured variant is visible;
- `only` is an exact, duplicate-free allow-list of public variant names;
- `only: []` deliberately returns an empty public collection while still
  running relation-integrity checks;
- allow-list order never changes result order; declaration order remains the
  one ordering truth;
- a literal tuple such as `only: ["post"]` narrows the result element union to
  the post envelope; a dynamic `PublicType[]` conservatively retains every
  possible listed variant in its result union;
- an absent, explicitly `undefined`, or maybe-undefined allow-list selects and
  infers the exhaustive union. In particular,
  `readonly ["post"] | undefined` must not narrow: the runtime `undefined` arm
  means every variant. Result inference tests `undefined extends Only` before
  extracting `Only[number]`;
- when `only` is present, a `variants` key outside it is a parse-boundary error
  rather than a silently ignored option;
- an allowed variant omitted from `variants` uses its default projection.
- a maybe-undefined `variants` container or maybe-undefined arm node infers the
  union of its default row shape and configured projection shape, while the
  independently resolved `only` set still controls which variant envelopes can
  appear. Runtime `undefined` is omission, never an empty projection.

This allow-list is intentionally separate from arm `where`. It remains stable
when a new variant is later added to the schema and does not require a fake
impossible target predicate or `take: 0` pagination trick. The existing `toOne`
exact variant map stays unchanged because a singular slot must still return
whichever configured variant it stores.

Each `variants` node accepts the ordinary nested-list controls for its target:

Each arm accepts:

- `where`;
- `orderBy`;
- `cursor`;
- `take`;
- `skip`;
- `distinct`;
- `select`;
- `include`;
- `omit`.

Omitting a `variants` arm keeps the default projection for every variant
selected by `only`. Projection remains distinct from target selection.

The flat array is concatenated in target-map declaration order. Within an arm,
explicit `orderBy` has its ordinary target semantics; without it, VibORM makes
no provider-independent row-order promise.

There is no global heterogeneous `orderBy`, cursor, `take`, or `skip`. Unrelated
models do not share a scalar ordering domain. Pretending that `post.createdAt`
and `video.duration` form one total order would create a provider-dependent API.
A future globally ordered collection needs an explicit shared ordering value on
the membership itself, not a clever `UNION` cast.

### 7.3 Direct relation filters

`toOne` keeps its current tagged `{ type, is }` and `{ type, isNot }` forms plus
null presence for optional slots.

`toMany` wraps a tagged member predicate in ordinary collection quantifiers:

~~~ts
where: {
  items: {
    some: {
      type: "post",
      is: { published: true },
    },
  },
}
~~~

The supported quantifiers are `some`, `every`, and `none`.

The tagged value is one predicate over collection elements:

- `some(post, P)` is true when at least one post membership satisfies `P`;
- `none(post, P)` is true when no post membership satisfies `P`;
- `every(post, P)` is true only when every collection member is a post and
  satisfies `P`; a member of another variant does not satisfy the tagged
  predicate;
- `every` and `none` are vacuously true when the whole collection is empty;
- `some` is false when the selected arm is empty.

“Every post satisfies `P` while other variants are allowed” is expressed as
`none: { type: "post", isNot: P }`. This keeps ordinary quantifier logic intact
and must be pinned with a mixed-variant truth table. It must not emerge
accidentally from `NOT EXISTS` spelling.

Null-presence filters are `toOne` only. A collection has no null state.

### 7.4 Counts and parent ordering

Direct polymorphic collections join the ordinary list-relation count surface.

~~~ts
select: {
  _count: {
    select: {
      items: true,
    },
  },
}

orderBy: {
  items: { _count: "desc" },
}
~~~

The unfiltered count is the sum of all member-table counts. A filtered count
uses one tagged arm predicate and counts that arm. `_count: true` includes
`toMany` polymorphic fields but not `toOne` fields.

No target-scalar root ordering is added for `toOne`. Nonmatching variant and
null placement semantics remain undefined and are outside this lift.

## 8. Read compilation and strict parsing

### 8.1 Direct `toOne`

Keep the current correlated CASE read, tagged carrier, variant projection, and
strict parser. The only planned changes are configured-cardinality dispatch and
estate conversion to `.toOne()`.

### 8.2 Direct `toMany`

Add a polymorphic collection read builder that coordinates existing fixed-target
junction reads.

For each variant in declaration order it:

1. obtains the pre-bound member junction topology;
2. starts from owner-correlated membership rows, not from an inner
   junction-to-target traversal;
3. computes an integrity carrier with an owner-scoped orphan count through a
   membership-first `LEFT JOIN` that ignores user filters and windows;
4. for an allow-listed variant, separately applies that arm's nested target
   scope and read window to its valid target rows; an excluded variant emits no
   visible-row branch;
5. produces an array of linked carriers for those visible target rows;
6. returns every arm's integrity facts and visible rows in one private
   exact-key carrier.

The query may use correlated scalar aggregates or lateral branches according to
the existing include strategy. It does not hand-spell dialect JSON or invent a
query-engine `UNION ALL`; the adapter's existing JSON, join, subquery, and set
operations remain the grammar owners.

The private carrier is shaped for strictness, not public convenience. It records
every configured arm even when excluded or empty. Each arm carries the
validated numeric membership/orphan facts plus its visible target rows. The
result parser:

- checks exact arm keys before parser reuse;
- checks the integrity fact keys and numeric domains;
- rejects any non-zero orphan count before parsing visible rows;
- requires an array for each arm;
- validates every linked envelope;
- validates every target row against that arm's expected shape;
- invokes the cached target row parser;
- concatenates only allow-listed parsed elements in declaration order;
- never lets nested relation rows enter root exact-field capture.

Real target foreign keys make an orphan exceptional, but a disabled constraint
or hostile raw write must still fail loudly when the relation is read. An inner
join that silently drops the membership is not an acceptable strict carrier.
The separate integrity subquery checks owner-correlated orphan rows before user
target filters or windows, including member tables excluded by `only`; a type
allow-list, filter, cursor, `take`, or `LIMIT` cannot hide malformed stored
membership. This is a deliberate extension of the junction read owner. Reusing
today's inner traversal unchanged cannot satisfy this contract.

### 8.3 Inverse reads

An inverse is fixed to one target variant and one member table. It reuses the
same membership-first integrity leaf and ordinary target projection rather than
the direct polymorphic tagged-union carrier.

- A plural inverse returns an ordinary array.
- A singular inverse returns one row or `null`.
- A singular inverse finding more than one membership is malformed provider
  state even if a missing unique constraint allowed it.
- Inverse filters, projection, cursor, and pagination use ordinary relation
  schemas for their cardinality.

Ordering a parent by a scalar through a singular inverse is also an ordinary
to-one capability. Its lowering now needs two left joins—source to member table,
then member table to owner target—instead of the current single foreign-key
join. Extend the existing relation-order owner with cardinality-neutral junction
traversal; do not special-case a polymorphic inverse in the order builder.

The singular carrier computes the raw target-correlated membership count and
orphan count before target filtering or `LIMIT 1`. Only after both facts are
validated may it return the zero/one projected row. The plural carrier computes
its orphan fact through the same path. This requires junction read leaves to
accept cardinality one or many and to expose integrity facts; it does not
justify a separate polymorphic inverse query builder.

### 8.4 Filter and count SQL

For a tagged arm, direct collection filters correlate the owner side of that
member table and join its complete target side to the target model.

- `some` compiles to correlated existence of a matching member.
- `none` compiles to absence of a matching member.
- `every` compiles to absence of any collection member that does not satisfy
  the complete tagged predicate; every non-selected member is therefore a
  violation.
- unfiltered count sums correlated counts from all member tables;
- filtered count compiles only the selected arm;
- count ordering uses the same summed expression and one parameter order.

Complete compound predicates use `AND` across side members. Empty or missing
arms do not emit `OR()` or `IN ()`.

## 9. Direct `toMany` mutation contract

### 9.1 Variant-correlated payloads

The collection relation uses the ordinary to-many operation names, but every
target-sensitive entry carries a public `type` whose literal selects the target
schema.

Create data supports:

~~~ts
items: {
  create: [
    { type: "post", data: { title: "A" } },
    { type: "video", data: { url: "..." } },
  ],
  connect: [
    { type: "post", where: { id: "p1" } },
  ],
  connectOrCreate: [
    {
      type: "video",
      where: { slug: "intro" },
      create: { slug: "intro", url: "..." },
    },
  ],
  createMany: [
    {
      type: "post",
      data: [{ title: "B" }, { title: "C" }],
      skipDuplicates: true,
    },
  ],
}
~~~

Update data supports:

- `create`;
- `createMany`;
- `connect`;
- `connectOrCreate`;
- `set`;
- `disconnect`;
- `delete`;
- `update`;
- `updateMany`;
- `upsert`;
- `deleteMany`.

Selector-bearing entries use the matching target's `WhereUnique`,
`WhereUniqueExtended`, or `Where` schema exactly where the ordinary operation
does. Data-bearing entries use that same target's create/update schema. A
discriminator and payload for different targets fail at the operation parse
boundary.

Use the ordinary single-or-array convention for verbs that already permit it.
`createMany` remains a group because its `data`, `skipDuplicates`, and compiled
bind-budget plan are target-specific.

A collection operation bag may combine compatible verbs. It does not inherit
the direct `toOne` “exactly one intent” envelope.

### 9.2 Exact verb semantics

- `connect` adds the exact existing target membership. On a member with a
  singular inverse, adding means an atomic target-side transfer from any
  previous owner to this owner.
- `create` creates the target, then adds its exact produced row key.
- `connectOrCreate` adopts the found target or creates and links the missing
  target through the existing race-pinned owner.
- `createMany` applies the ordinary target bulk semantics and links only exact
  rows whose final row keys are known.
- `set` makes the complete mixed-variant collection equal to the supplied
  membership set. `set: []` clears every member table. A supplied target on a
  singular member is transferred from its previous owner; `set` cannot leave
  the same target attached to two owners.
- `disconnect` removes membership only; it never deletes the target.
- `update` and `updateMany` mutate targets currently related to this owner.
- `upsert` scopes the found arm to this owner's membership and links a created
  missing arm.
- `delete` and `deleteMany` delete target rows selected through this owner's
  membership. Real target-FK cascades remove every affected membership, including
  memberships held by other owners, matching ordinary junction delete
  semantics.

Equal target IDs in different variants are different memberships. A repeated
connect of the same owner, variant, and complete target key is idempotent and
cannot create a duplicate row.

`set` is one indivisible membership replacement. Its target-existence premises,
all member-table clears, and every replacement insert share one transaction or
native atomic batch. Bind-budget chunking may create several statements inside
that unit; it may not turn clear and refill into independently committed
segments. A substrate unable to provide that unit refuses before clearing.

### 9.3 Relation-wide coordinator and fixed-target leaves

A direct collection spans several fixed-target junctions. One thin coordinator
is justified, but a second junction DML engine is not.

Extend the existing `ResolvedPolymorphicMutation` / parsed polymorphic-program
owner with a cardinality-discriminated to-many arm containing entries in the
existing mutation-kind and user-item order. Do not add a second parsed-program
map or a parallel relation DSL. Each collection entry already has:

- public variant;
- resolved fixed-target junction binding;
- trusted ordinary relation program or bulk program;
- original attribution path.

The coordinator owns only facts that are genuinely relation-wide:

- direct `set` clears every variant table once before inserting the desired
  member runs;
- deterministic cross-verb ordering;
- cache footprint across all touched variants;
- one owner-row publication shared by all member leaves.

Every fixed-target entry delegates to existing owners:

- `RelationJunctionPart` for plural junction membership;
- record create/update compilers for target row work;
- existing connect-or-create/upsert probe and race-pin owners;
- existing createMany plan and bind-budget chunker;
- existing junction insert/delete statement builders.

One exception is an existing owner's responsibility widened by the singular
junction invariant: every leaf that adds a resolved membership must call the
same target-side transfer primitive described in §9.4 when the bound junction
has cardinality one. Direct `connect`/`set`, a found `connectOrCreate`, an exact
target adopted after `createMany(skipDuplicates)`, and inverse supply paths may
not each improvise their own vacate logic. Freshly created targets still pass
through the same leaf, which cheaply proves the slot empty.

`set` uses that primitive in `reinsertAfterOwnerClear` mode. It captures and
guards every desired singular target's old owner before any relation-wide
clear. After the clear it always inserts every desired row. If the captured old
owner was the desired owner, the clear already removed that exact row, so the
transfer skips a second delete but must not return the normal idempotent no-op.
If another owner was captured, it deletes that exact old row before insertion.

Generalize `ManyToManyStatements` to the semantic name `JunctionStatements` and
let it accept an already-bound `JunctionBoundRelation`. It must not re-resolve a
synthetic public many-to-many relation merely to recover topology the
polymorphic member already owns.

### 9.4 Singular inverse adoption

A `toMany` member with a fields-less `manyToOne` inverse has a unique target
side. Connecting that target to a new owner means reparenting it.

The current ordinary global-adopt path is not sufficient. It deliberately does
not pin the old membership, so two concurrent adopters could both delete and
insert serially and both report success. Reuse its public composition order and
target premise, but add one junction-owned compare-and-reassign primitive.

`transferSingularJunctionMembership(boundJunction, targetKey, desiredOwnerKey,
mode)` owns this exact protocol inside one atomic write segment. `mode` is
`preserveExact` for ordinary membership addition and `reinsertAfterOwnerClear`
for direct `set`:

1. capture the raw target-side membership as either empty or exactly one
   complete previous owner key; more than one row is malformed provider state;
2. guard that captured membership fact inside the atomic write unit: empty uses
   `NOT EXISTS` for every target-side membership; occupied requires the exact
   previous `(owner,target)` row and absence of any different owner;
3. if the desired row is already present, return the idempotent no-op only in
   `preserveExact` mode; in `reinsertAfterOwnerClear` mode remember that the
   relation-wide clear will remove it and continue to insertion;
4. if another owner was captured, delete that exact row;
5. after any relation-wide clear, insert the exact desired `(owner,target)` row;
6. preserve the target row itself.

In `reinsertAfterOwnerClear` mode, the coordinator places its one clear-all
barrier between the captured-fact guards and the per-target delete/insert
effects. The transfer leaf does not emit another clear. Thus all desired facts
are guarded against the same pre-set membership state, every member table is
cleared once for the desired owner, and every desired row is then rebuilt.

The guards, optional clear, conditional deletes, and inserts are one transaction
or native atomic batch. They never cross a progressive committed boundary.
Interactive transaction execution attaches `affectedRows(1)` to a delete of a
captured old row. Native atomic-batch execution deliberately does not: the live
executor refuses write postconditions in a batch. On that route, the in-batch
exact presence/absence assertions plus the membership PK and target-side unique
constraint are the CAS invariant. No general batch-postcondition mechanism is
added for this feature.

Two adopters that captured the same old owner cannot finish with different
owners while both reporting success: after the guarded exact delete, their
target-side inserts collide and one atomic unit rolls back. Two adopters that
captured an empty slot are arbitrated by the same target-side unique constraint.
An exact same-owner insertion race may become an idempotent reconnect; a
different desired owner is not silently followed or retried as success. A
concurrent disconnect that leaves the target empty may be followed by the
transfer insert—ordinary last-writer semantics for the requested connection—
but it cannot redirect the operation to another owner.

This primitive belongs with bound `JunctionStatements` because it is a physical
single-target membership transition. Both direct collection verbs and inverse
to-one composition call it. Do not introduce a second mutation-program DSL or
pretend the existing unpinned global-adopt leaf provides the premise.

This exposes a required correction in the shared junction insert owner.
Ordinary junction insertion currently treats every unique collision as a
duplicate membership. That is safe only when the composite membership PK is the
table's sole unique constraint. On a singular-inverse member, a target-side
unique collision can mean that a different owner occupies the slot.

The exact policy is:

- an existing identical `(owner key, target key)` membership is idempotent;
- a different owner holding the target is not a duplicate; a verb with transfer
  semantics must vacate it through the guarded primitive, while a plain insert
  that bypasses that primitive must surface the native unique failure;
- PostgreSQL/SQLite/D1 target duplicate skipping at the complete membership PK,
  never at every constraint;
- MySQL, which cannot target the conflict in the same way, probes the exact
  membership, then issues a plain insert with a race pin for that membership;
  a target-side occupant does not match the pin and is not retried as an exact
  duplicate.

Apply that rule in the one junction-insert/transfer owner used by connect, set
chunks, create, createMany, connect-or-create, and upsert. A polymorphic-only
patch would leave the same singular-junction invariant inconsistent across
verbs.

Inverse direct writes use ordinary to-one composition:

- `connect`/`create`/`connectOrCreate` supply the owner;
- `update` modifies the supplied or captured owner according to the existing
  composition lattice;
- `disconnect` deletes the junction row;
- `delete` deletes the owner only when ordinary inverse semantics say so;
- found/missing upsert keeps its existing guarded arm behavior.

The only new physical leaf is a singular-cardinality view over the existing
junction statements. A small `RelationJunctionToOnePart` is justified if the
current plural Part cannot express slot replacement without misleading array
semantics. It must reuse the same bound topology and SQL owner, not copy
`RelationJunctionPart`.

### 9.5 Plural inverse writes

A polymorphic-bound `manyToMany` inverse is a fixed-variant ordinary junction
view. It exposes the same mutation grammar as an ordinary `manyToMany` relation
in each create/update context, without a `type` field because its variant is
already fixed by the inverse declaration.

The binder supplies the same `ResolvedJunctionTopology` in reverse orientation:
the variant target row is the relation source and the polymorphic owner model is
the relation target. Existing `RelationJunctionPart` and `JunctionStatements`
then own `connect`, `create`, `connectOrCreate`, `createMany`, `set`,
`disconnect`, `delete`, `update`, `updateMany`, `upsert`, and `deleteMany`
exactly where the ordinary operation schema admits them.

The orientation has observable consequences and must be explicit:

- inverse `set` clears only memberships for the fixed variant target, then
  inserts the selected owner tuples;
- inverse `disconnect` deletes only those member rows;
- inverse `delete`/`deleteMany` delete selected owner rows, whose source FKs
  cascade all of those owners' member rows across variants; they never delete
  the fixed variant target by accident;
- an owner created from the inverse publishes its complete generated row key to
  the member insert;
- direct and inverse programs over the same member table share the same
  orientation-neutral own-write scope and cannot be scheduled as disjoint.

The direct polymorphic coordinator is not invoked for this fixed-target view,
and the inverse never serializes or rebinds another junction. Bind chunking,
target probes, selected-row scoping, skip behavior, and race pins stay with the
ordinary junction owners.

### 9.6 Owner creation, update, and bulk routes

An omitted `toMany` field does no work.

On ordinary create/update:

- owner-key-known links may compile in the same atomic plan;
- generated owner row keys publish through the existing complete field-keyed
  root-row map;
- after-root junction inserts consume that publication;
- parent and target row-key transitions use selected-row continuity and exact
  junction side tuples.

Root `createMany` has two routes:

- rows without collection work keep the maximal grouped scalar INSERT;
- any row containing a polymorphic `toMany` program routes the entire call
  through the existing relation-bearing record-series owner.

Do not extend the current direct-`toOne` connect-only grouped shortcut to
junction work. It stores private owner columns and cannot express later member
inserts.

`skipDuplicates` keeps the settled subtree rule: a skipped owner root suppresses
all target and member work for that row. A fresh sibling can still land.

That success route requires the skippable owner root to be the first write in
its member. If a target create or nested record series must execute before the
owner root, skipping the root would strand that prior effect. The existing
progressive-root preflight must refuse that statically known shape before member
zero; accepting segment-atomicity does not make an orphan target correct.

## 10. Execution, races, capacity, and cache

### 10.1 Transaction-capable drivers

The complete record tree runs in the existing interactive transaction or
savepoint. A failure rolls back owner, target, and every member-table change.

### 10.2 Native-batch-only drivers

Safe relation-bearing series use existing ordered atomic segments.

- normalized awaited success establishes ordering on every native-batch driver;
- an ordered committed callback strengthens pre-decode attribution only;
- every later write rechecks its exact owner liveness and membership premise;
- a malformed or transport-ambiguous dispatched segment reports
  `mayHaveCommittedSegment`, invalidates conservatively once, and dispatches no
  successor;
- a proven rolled-back unique/race failure does not claim the current segment
  may have committed;
- a prior committed prefix is never replayed.

A generated owner or target key may cross a segment only through existing
provider output plus a compiler-owned continuation premise. If a member write
cannot share an atomic segment with its required guard, construction refuses
before effects.

### 10.3 Explicit transaction arrays

`$transaction([...])` remains indivisible.

A member operation is preparable only when all generated values consumed by
other statements have an exact one-batch lowering. The polymorphic collection
coordinator does not segment an explicit array or weaken its rollback promise.

### 10.4 Race behavior

Mandatory race classes are:

- connect-or-create exact-key concurrent creator;
- upsert found/missing transition;
- singular-inverse concurrent adoption;
- exact reconnect versus a different-owner target-side unique collision;
- target moved or replaced between progressive segments;
- owner row-key transition before after-root member insertion;
- alternate-unique `createMany(skipDuplicates)` conflict that must not link a
  guessed primary key.

Race pins stay on the concrete target or owner write. A relation-wide
coordinator must preserve them when it groups variant runs.

Own-write overlap stays with the existing physical membership scope. Direct
and inverse views of one member table normalize orientation and identify the
same table plus both complete sides; they therefore conflict when they can
touch the same membership. Two variants with equal-looking target keys use
different tables and remain disjoint. Do not compare only target model, public
variant text, or member zero, and do not add a polymorphic-only overlap ledger.

### 10.5 Bind budgets

Each variant table is a separate SQL statement shape. Chunking uses compiled
bind counts through the current bind-budget owner.

- target createMany chunks by target shape;
- junction connect/set inserts chunk by member table and complete tuple width;
- a relation-wide set clear plus all insert chunks remain one transaction or
  one safe record-series member according to the active substrate;
- the executor performs the final active-driver capacity check before I/O;
- an indivisible one-row/one-statement over-limit shape refuses pre-I/O;
- an unknown driver limit is provider-owned and can fail after an exact prior
  progressive prefix.

### 10.6 Cache footprint

Preserve the existing cache contract. Automatic mutation invalidation is keyed
by the public operation's root model, not by a dependency graph of every nested
model it touched. A polymorphic collection must not introduce a private
dependency-invalidation system that ordinary relations do not have.

Direct collection reads remain cached under the owner operation key, including
their exact variant projection and list options. Inverse reads remain cached
under their own root model. Nested target mutations have the same documented
manual-prefix responsibility as nested ordinary relation writes.

Definite and ambiguous invalidation timing remains in the shared executor. The
polymorphic coordinator neither invokes cache callbacks nor claims target-model
invalidation the cache layer does not provide. A future dependency-aware cache
is a relation-wide project.

## 11. Migration and schema history

### 11.1 Snapshot representation

Make polymorphic snapshot storage a cardinality-discriminated union.

The `toOne` polymorphic metadata also becomes logical-only. It records owner
table/public relation, `kind: "toOne"`, a structural `storageRef`, and each
member's public variant, stored value, and target table. It does not repeat the
private type/id column, index, or referenced primary-key column.

The owner `TableDef` gains one structural relation-storage registry keyed by
`storageRef`. A `polymorphicToOne` entry assigns the existing physical column
and index names their type/id roles; the actual column definitions, index
definition, and target primary key remain in `TableDef`. This is a reference
map inside the structural owner, not a second set of column definitions.
History resolves it only after table/column rename normalization.

The registry is snapshot annotation, not database DDL. Desired/saved snapshots
carry it; raw provider introspection need not invent logical relation identity.
Physical table equality and dialect DDL ignore it, while polymorphic history
joins the previous saved registry to the desired registry after the ordinary
structural differ has normalized renames. This separation must be pinned so an
annotation-only change never emits `ALTER TABLE` and an absent introspected
registry never creates endless churn.

The `toMany` metadata records:

- owner table and public relation;
- `kind: "toMany"`;
- public variant and stable storage value;
- target table;
- member junction table;
- inverse cardinality.

The ordinary structural snapshot remains the truth for tables, columns, FKs,
indexes, and unique constraints. Polymorphic metadata explains which internal
tables form one public relation and preserves variant history. Do not serialize
the same physical side columns, constraint names, or actions into polymorphic
metadata. History resolves those facts through the referenced member table's
`TableDef` after structural rename normalization. Snapshot validation requires
that each metadata member reference exactly one existing structural table and
that no member table has two logical owners, but it never compares two stored
copies of the topology.

The same coherence rule applies to `toOne`: each logical `storageRef` resolves
to exactly one structural registry entry on the owner table, and every private
polymorphic structural entry has exactly one logical owner. No history code may
fall back to reconstructing columns from naming conventions.

### 11.2 Serialization and introspection

The serializer iterates configured storage by kind.

- `toOne` emits the current private columns and index.
- `toMany` asks the central junction topology owner for one table per member and
  emits the same DDL definition used by ordinary junctions.

Introspection must reconstruct or compare the actual compound foreign keys by
ordered positions. PostgreSQL must keep the corrected referenced-key ordinal
join; a Cartesian compound FK introspection would cause endless drop/add churn.

MySQL, SQLite, libSQL, D1, and PostgreSQL-family serializers must produce stable
constraint and index names. A second forced push against the same schema must
return zero operations.

### 11.3 History changes

History resolution distinguishes:

- public variant rename with the same stable storage value and target;
- stored value change;
- target retarget;
- member addition;
- member removal;
- junction-table or column rename;
- inverse cardinality change;
- direct cardinality change.

Reconciliation is total. The current history comparator indexes row-held
storage by its physical `(owner,typeColumn,idColumn)` descriptor and skips a
previous storage when no desired descriptor matches. That behavior is invalid
once cardinality can change the entire descriptor. After structural rename
normalization, every previous relation storage must resolve to exactly one of:
same relation, renamed relation, cardinality change, or removal. An unmatched
previous storage is never silently ignored.

For `toMany`, a public-key rename with the same stable storage value and target
is one logical member rename. With an explicit unchanged `.through()` table it
is metadata-only. With default naming it also produces one structural table
rename, normalized before member history comparison; it never rewrites
membership rows.

A `toMany` storage-value change with the same public variant, target, and
junction topology is also metadata-only: no membership row stores that value.
The same change on `toOne` remains data-bearing because owner rows contain the
discriminator. History resolution must dispatch by storage kind rather than
treating both changes as metadata-only or routing them through one undifferentiated
handler.

History classifies changes as metadata-only, exactly structural, or
data-bearing. Exactly structural changes use generated DDL. The following are
data-bearing whenever old membership may exist:

- removing a member whose junction table may contain rows;
- retargeting a member to another model;
- changing `.toOne()` to `.toMany()` or the reverse;
- changing a junction mapping in a way that is not recognized as a rename;
- adding singular inverse uniqueness when duplicate target memberships exist.

No migration guesses how one singular `(type,id)` value maps to N member tables,
or which of several collection rows should survive a many-to-one cardinality
change.

An acknowledgement is not an executable migration. A direct cardinality change
needs destination DDL, row-copy DML, and source removal in one deliberate order;
the current `polymorphicMemberResolver` cannot put that work in the up artifact.
Because the project is unreleased, replace acknowledgement-only handling for
data-bearing polymorphic history with one complete manual-artifact seam:

~~~ts
interface GenerateOptions {
  manualMigration?: {
    /** Complete ordered up artifact: structural DDL and data DML. */
    readonly up: readonly string[];
    readonly rollback:
      | { kind: "manual"; sql: readonly string[] }
      | { kind: "irreversible"; reason: string };
  };
}

type MigrationMode = "generated" | "manual";

type MigrationRollback =
  | { kind: "automatic" }
  | { kind: "manual" }
  | { kind: "irreversible"; reason: string };
~~~

`MigrationEntry` and the journal persist `MigrationMode` and
`MigrationRollback`. Manual SQL is written to the ordinary up/down artifacts;
it is not duplicated in the journal. The generator still computes the complete
diff and desired snapshot for history, reporting, dry runs, and the final
snapshot, but in manual mode it emits only the supplied complete up artifact—it
does not append generated structural SQL around it. The caller therefore owns
the exact create-destination → copy/choose rows → remove-source sequence for the
whole migration.

Generation classifies the complete migration:

- topology-preserving renames and reversible constraint/index changes use
  `generated` mode and `automatic` structural inversion;
- adding a member may use automatic down-table removal with the normal explicit
  destructive warning; it does not claim to preserve rows created after up;
- a row-held stored-value rewrite, populated member removal, retarget, direct
  cardinality change, or any transition that copies/chooses membership data
  requires a parsed, non-empty `manualMigration.up` plus either parsed,
  non-empty manual down SQL or an explicit irreversible reason; a whitespace-
  or comment-only array is empty. Without that complete artifact,
  generation refuses before writing migration, down, journal, or snapshot;
- adding reverse-one uniqueness runs forward only after the database proves the
  target side unique; its automatic down removes that constraint;
- a later down that must re-add uniqueness lets the database enforce fit inside
  the rollback transaction. Failure leaves schema and migration tracking
  unchanged.

If automatic unique creation fails because duplicate memberships exist, the
user can regenerate in manual mode with explicit deduplication before the
constraint. VibORM never chooses the surviving owner.

`migrations.down()` parses only caller options before locking. Inside the
migration lock it re-reads journal/applied state, recomputes the exact rollback
group, verifies checksums/policies, and reads every down artifact. Only after
that group-wide preflight does it open the rollback transaction. An
`irreversible` entry raises one typed migration error while the lock is held but
before SQL or tracking effects. Both `automatic` and `manual` entries must have
a readable, parsed, non-empty down artifact; missing, comment-only, or empty
content is the same pre-effect error. This both closes the applied-state TOCTOU
gap and prevents an empty down from advancing tracking without restoring
schema.

The current public `migrations.rollback()` is not a second rollback path. It
only deletes migration-tracking rows today, without executing a down artifact
or acquiring the migration lock; retaining that behavior would let an
`irreversible` migration be marked unapplied while its schema remains live.
Because VibORM is unreleased, remove this tracking-only verb from the public
client and delete its apply-layer route. `migrations.down()` becomes the sole
public rollback operation and the sole owner of rollback policy, locking, SQL,
and tracking changes. Do not rename the unsafe behavior to another convenient
public verb. A future administrative `markUnapplied` escape would require an
explicit dangerous-operation contract and is outside this feature.

`migrations.squash()` is a consumer of the same policy, not an exception. V1
refuses to squash any selected manual or irreversible entry before writing a new
migration or journal. It acquires the migration lock, re-reads journal and
applied state, and refuses pre-effect unless the selected automatic entries are
uniformly applied or uniformly pending. A mixed applied/pending range cannot be
represented by one replacement: marking it applied would skip the pending DDL,
while marking it pending would replay the already-applied DDL. When every source
entry is automatic and has one uniform state, squash reads and validates every
non-empty down artifact, concatenates them in reverse migration order while
preserving statement order inside each file, writes the composed down artifact,
and persists an automatic rollback policy and that uniform applied state on the
squashed entry. It never creates a new entry from up SQL alone. Supporting
policy-bearing manual squashes later requires an explicit user-supplied complete
replacement artifact; silently discarding source rollback semantics is
forbidden.

Do not describe structural inversion as “the same data-fit honesty as up.” The
completion gate checks the exact supported structural inverses and the exact
manual/irreversible forward artifact and rollback preflight for every
data-bearing transition.

Because VibORM is unreleased, implementation changes the snapshot format once.
There is no legacy snapshot reader, dual serializer, or old/new runtime storage
compatibility layer.

### 11.4 Referential actions and key transitions

The source and target sides consume complete ordered row keys. Parent or target
key changes use real FK cascade behavior where the ordinary junction contract
does. The ORM's update compilers still publish final tuples for later work;
database cascade is integrity, not a replacement for execution identity.

Parent delete and target delete must be proven on scalar and compound members.
Self-targeting and mapped-column tables must not reverse source and target sides.

## 12. Implementation packages

### 12.1 Existing owners to extend

| Concern | Existing owner(s) | Planned change |
|---|---|---|
| Public declaration | `src/schema/relation/polymorphic.ts` | Unfinished builder, configured terminals, cardinality state, exact through map |
| Cardinality and inverse legality | `src/schema/relation/cardinality.ts`, `inverse.ts`, `clearability.ts` | One polymorphic cardinality reader; cardinality-aware inverse candidates and clearability |
| Model extraction | `src/schema/model/helper.ts`, `model.ts`, `src/schema/hydration.ts` | Configured carriers only; storage descriptor union; no public scalar fields |
| Definition validation | `src/schema/validation/rules/polymorphic.ts`, `relation.ts` | Dispatch row-held/junction validation, member-local inverse uniqueness, collision ownership |
| Junction topology | new cohesive `src/schema/relation/junction-topology.ts`, existing `src/schema/relation/helpers.ts` | Extract the duplicated schema truth from query binder and serializer; reuse field groups; bind junction cardinality one or many |
| Operation schemas | `src/validation/relations/polymorphic/*`, `src/validation/model/core/create.ts`, `select.ts`, `orderby.ts` | One/many envelopes, exact variant allow-list, tagged list verbs, counts, requiredness |
| Public result types | `src/client/result-types.ts`, `src/client/types.ts`, `src/client/omit.ts` | Array wrapper and allow-list narrowing, collection counts, exact arm options, omit propagation |
| Direct reads | `src/query-engine/builders/polymorphic-read-builder.ts` | Cardinality dispatch and per-variant junction branch composition |
| Junction reads | `include-many-to-many.ts`, `relation-traversal.ts`, relation filter/count/order builders | Cardinality-neutral junction read leaves and direct collection count/filter composition |
| Result parsing | `src/query-engine/result/polymorphic-result-parser.ts`, `src/query-engine/types.ts` | Shared strict element parser plus singular/collection wrappers |
| Mutation parsing | `relation-mutation-parser.ts`, `polymorphic-mutation.ts` | Cardinality-discriminated existing polymorphic program with trusted ordered collection entries |
| Junction mutation | `ManyToManyStatements.ts`, `RelationJunctionPart.ts` | Bound `JunctionStatements`; fixed-target leaves; singular junction slot seam |
| Own-write overlap | `RelationMembership.ts`, `OwnWriteAnalyzer.ts`, `OwnWriteLedger.ts`, `OwnWriteSteps.ts` | Consume the same orientation-neutral table/complete-side scope for direct and inverse member views |
| Record compilation | `CreateOperation.ts`, `RecordUpdateCompiler.ts`, relation write/upsert Parts | Owner/target publication, nested target programs, key transitions, root bulk route |
| Execution | `OperationExecutor.ts`, `routing.ts`, bind-budget owners | Reuse exact segments, retry/progress/invalidation/capacity; add no polymorphic scheduler |
| Migration | `src/migrations/types.ts`, `serializer.ts`, `client.ts`, `generate/polymorphic-history.ts`, `generate/index.ts`, `apply/index.ts`, `apply/down.ts`, `squash.ts`, dialect drivers | Logical snapshot references, reusable junction emission, history by storage kind, one public locked rollback path, explicit rollback/squash policy, introspection parity |

Paths in the table name semantic owners, not a license to edit every file. Each
package starts with a live call-site search and removes obsolete branches when
the existing owner subsumes them.

### Package A — explicit cardinality carrier

**Goal:** Make the current singular feature explicit without changing its
behavior.

1. Split unfinished builder and configured terminal types in
   `src/schema/relation/polymorphic.ts`.
2. Add the one cardinality reader beside `relationCardinality` rather than
   inlining `state.cardinality` tests.
3. Make model typing accept configured carriers only while hostile runtime
   carriers still reach definition validation.
4. Gate `.optional()` to `toOne`.
5. Convert every current declaration, fixture, example, and source doc to
   `.toOne()`.
6. Pin all existing direct/inverse DDL, SQL, result, mutation, and migration
   behavior after the explicit terminal.

**Land gate:** the full existing polymorphic estate is green and a bare builder
is rejected through both public types and hostile runtime validation.

### Package B — per-variant junction topology

**Goal:** Give configured `toMany` declarations one complete physical truth.

1. Extract `ResolvedJunctionTopology` from the query engine's private resolver
   and the serializer's duplicate reconstruction; cut the ordinary junction
   binder, serializer, and post-resolution validator over to that one owner
   before adding polymorphic member tables.
2. Add the storage descriptor union and member junction descriptor.
3. Extend the one runtime inverse resolver and its relation-kind/cardinality
   type projection for all four bindings: fields-less optional `manyToOne` and
   polymorphic-bound `manyToMany` over `toMany`, plus the retained fields-less
   optional `oneToOne` and `oneToMany` bindings over `toOne`. Remove the live
   blanket `manyToMany` rejection only for the resolved member-table view.
4. Widen bound junction cardinality to one or many.
5. Resolve default/explicit member table and side names through the junction
   naming owners.
6. Validate owner and target row keys, name collisions, ambiguous inverses for
   same-model variants, and member-local inverse uniqueness.
7. Serialize member tables, compound FKs, primary/unique constraints, and
   reverse indexes.
8. Extend snapshot metadata and history comparison.
9. Add complete manual-up artifact mode, automatic/manual/irreversible rollback
   policy, generator/journal ownership, lock-protected group-wide down preflight,
   remove the tracking-only public `migrations.rollback()` bypass, and add
   automatic-only squash with reverse-composed down artifacts and an in-lock
   uniform-applied-state premise.

**Land gate:** ordinary scalar/compound junction SQL, DDL, validation order, and
public API remain exact after the topology extraction; no consumer retains a
private reconstruction. All four polymorphic topology declarations then
validate; PG/MySQL/SQLite DDL is exact; real provider second push is empty;
data-bearing topology change cannot advance history without executable manual
up plus an honest rollback policy, and rollback cannot accept an unmarked empty
down; no query or mutation path can mistake an internal member table for an
independent ordinary relation.

### Package C — reads, filters, counts, and result types

**Goal:** Make `toMany` useful as a query relation before adding mutation
complexity.

1. Dispatch operation-schema families by cardinality.
2. Add the stable variant allow-list, arm-local list controls, and tagged
   quantifier filters.
3. Add direct collection result inference and strict private carrier parsing.
4. Compose fixed-target junction branch reads.
5. Reuse junction traversal for singular/plural inverses.
6. Add `_count`, filtered count, and parent count ordering.
7. Extend client omit and expected-result shapes through collection arms.

**Land gate:** direct and inverse reads, nested reads, mixed variant IDs,
compound target keys, filters, count, count order, stable variant subsets, arm
pagination, strict malformed results, and exact narrowed public type probes are
green on one transactional and one native-batch substrate.

### Package D — direct collection mutation family

**Goal:** Add trusted tagged programs and delegate fixed-target work to existing
junction and record compilers.

1. Build the discriminator-correlated create/update schema family.
2. Parse once into the existing resolved polymorphic program's ordered to-many
   entries.
3. Generalize `ManyToManyStatements` into bound `JunctionStatements`.
4. Add the thin relation-wide coordinator.
5. Add the guarded singular-junction compare-and-reassign primitive and route
   every direct membership-adding leaf through it when the member's inverse is
   singular.
6. Implement connect/create/connectOrCreate/set/disconnect first.
7. Add update/updateMany/upsert/delete/deleteMany through existing selected
   target compilers.
8. Add target `createMany`/skip and relation-wide bind-budget chunking.

**Land gate:** every public verb has one success falsifier, one exact scoping or
race falsifier, and one compound/mapped-key control. No new scalar-only junction
shortcut exists. Direct connect/set against a singular member prove exact
same-owner idempotence, guarded transfer from another owner, and a concurrent
transfer loser that cannot delete the winner.

### Package E — inverse-one, bulk, and progressive execution

**Goal:** Close the difficult execution shapes rather than shipping a
transaction-only collection.

1. Reuse Package D's guarded singular-junction transfer in the inverse to-one
   composition lattice; do not reimplement it or fall back to unpinned global
   adoption.
2. Route every polymorphic-bound `manyToMany` inverse verb through the same
   pre-bound member junction in reverse orientation and keep the ordinary
   junction mutation lattice.
3. Route relation-bearing owner `createMany` through the record-series owner.
4. Thread complete owner/target output, continuation, and selected-row premises.
5. Preserve root skip, partial committed-prefix, invalidation, and retry rules.
6. Cover direct and inverse parent/target row-key transitions.
7. Make relation-wide set and variant runs obey active bind capacity.
8. Add explicit-array preparability/refusal tests.

**Land gate:** transactional and capability-false native-batch tests agree on
final state where both succeed; deliberate partial-commit tests report exact
progress; no retry replays an earlier member; root skip emits no target or
junction effect. Every inverse to-one verb has a direct-view state assertion so
orientation, target/owner deletion, and disconnect semantics are proved against
the same physical member table. Every plural-inverse verb has the same
direct-view state control, including reversed `set`, owner deletion, generated
owner publication, and compound orientation.

### Package F — provider, migration, and doctrine completion

**Goal:** Prove the capability across shipped routes and remove stale singular
doctrine.

1. Run the shared behavior on PGlite/PG, MySQL/PlanetScale, SQLite3/Bun,
   libSQL, and D1 routes according to available environments.
2. Pin provider SQL for compound member reads/writes and count ordering.
3. Pin migration push, second push, rename, inverse uniqueness, member
   add/remove, and cascade behavior.
4. Update public schema/query/write docs and the capability matrix.
5. Update `src/schema/relation/AGENTS.md`, query-engine/adapters/migrations
   guides, and current architecture doctrine.
6. Re-run contextual typing, layer, coverage, provider, package, and diff gates.

**Land gate:** the completion criteria in §15 are all evidenced; no document
describes polymorphism as intrinsically to-one.

## 13. Mandatory falsifier matrix

### 13.1 Declaration and types

| Falsifier | Old/wrong behavior it detects |
|---|---|
| Bare builder in `s.model` | Silent implicit `toOne` or ignored hostile carrier |
| Reused builder creates independent one/many terminals | Mutable state or eager getter resolution |
| `.toMany().optional()` missing from completion and rejected if forced | False nullable collection state |
| Optional fields-less `manyToOne` inverse infers `Owner | null` | Non-owning singular storage presented as guaranteed in accepted code |
| `.onDelete()` / `.onUpdate()` absent and hostile forced actions rejected | Invalid `setNull` PK members or actions that break cascade semantics |
| Cardinality cannot be changed twice | Contradictory storage selection |
| Fresh and non-fresh extra target/value/through keys | Excess-property-only exactness |
| Self and mutual recursive targets for both terminals | Eager generic expansion or `any` collapse |
| Literal `only` narrows the element union; dynamic allow-list stays conservative | Runtime filtering with a falsely exhaustive or falsely narrow result type |
| `readonly ["post"] | undefined` stays exhaustive through core and one driver wrapper | Optional/spread allow-list falsely narrows away runtime variants |
| Maybe-undefined `variants` container/arm infers default-or-configured row shape through core and one wrapper | Optional/spread projection chooses one runtime world unsafely |
| Public variants literally named `only` and `variants` work inside `variants` | A flat option/variant namespace collision hidden by ordinary names |
| `select/include: { items: false }` emits no key and no relation SQL | Collection selection accidentally breaks ordinary conditional-projection parity |
| Typo beside a real variant/verb key at every reachable nesting level | Weak-type false confidence |

### 13.2 Definition and DDL

Use a matrix with:

- compound owner row key;
- a scalar string target;
- a mapped compound target;
- an integer target;
- equal logical ID values in two target tables;
- one singular inverse member and one plural inverse member;
- explicit member table/side mappings;
- a self target;
- two named polymorphic fields between the same models.

Pin:

- all four topology cells;
- required fields-less `manyToOne` inverse rejected at definition validation;
- no-inverse defaults;
- `toOne` mixed inverse refusal remains precise;
- `toMany` mixed member inverse cardinality succeeds;
- singular member target-side unique constraint;
- plural member reverse non-unique index;
- complete dual FKs and referential actions;
- all four member-FK actions are exactly cascade and no hostile custom action
  reaches DDL;
- scalar-byte-compatible ordinary junction naming where shapes coincide;
- generated/explicit name collisions before DDL;
- duplicate target model variants accepted without inverses and refused with
  an ambiguous inverse;
- no target key representation compatibility check on `toMany`;
- existing compatibility check retained on `toOne`.

### 13.3 Reads and results

Pin:

- empty collection returns `[]`;
- mixed variants flatten in declaration order;
- a many-owner read remains one provider statement and performs no per-owner or
  per-variant execution loop;
- explicit order and window apply inside one arm only;
- `only: ["post"]` returns no video row, narrows the public element union, and
  remains post-only after a new schema variant is added;
- omitted `only` returns every variant, while an allow-listed arm omitted from
  `variants` still receives its default projection;
- duplicate/unknown `only` values and a `variants` key outside a present
  allow-list fail at the operation parse boundary;
- `only: []` returns a fresh empty array but an orphan in any excluded member
  table still fails the strict integrity carrier;
- positive and negative `take`, cursor, skip, and distinct remain arm-local and
  preserve the ordinary reversed-window restoration contract;
- equal IDs in two target tables return two correctly tagged rows;
- compound/mapped target key joins every member;
- inverse singular returns row/null and plural returns array;
- parent scalar ordering through a singular inverse uses the junction path and
  preserves ordinary null placement;
- singular duplicate provider state fails before `LIMIT`, even when a target
  filter would leave one visible row;
- missing target membership fails rather than disappearing, even when a target
  filter/window would otherwise hide it;
- malformed outer carrier, arm key, element envelope, and row shape fail;
- nested polymorphic and ordinary includes parse without root exact-capture
  leakage;
- `some/every/none` mixed-arm truth table;
- total and filtered counts;
- count ordering with deterministic parameter order;
- client omit on every arm;
- no `null` in inferred collection result.

### 13.4 Writes

For every verb, assert database state rather than statement count alone.

Pin:

- mixed-variant create and connect in one owner create;
- create-generated owner key feeding several member tables;
- generated and compound target keys feeding exact member tuples;
- duplicate connect idempotence;
- relation-wide `set` clears unmentioned variants exactly once;
- singular-member `set` containing the target already owned by the desired
  owner clears then reinserts it; the idempotent-connect shortcut cannot lose
  the desired row;
- `set: []` clears all variants and deletes no target;
- disconnect removes only membership;
- update/updateMany cannot reach an unowned decoy;
- delete/deleteMany are membership-scoped and target deletion cascades shared
  memberships as documented;
- upsert found/missing arms and connect-or-create exact-key race;
- alternate-unique skip conflict does not link a guessed row;
- singular inverse reparent succeeds atomically;
- direct connect/set and inverse connect all use the same reparent transition;
- two concurrent singular inverse adopters that captured the same old owner have
  one winner, and the loser fails its in-batch premise or target-side unique
  insert without deleting the winner;
- two concurrent adopters of an observed-empty slot have one winner through the
  target-side unique constraint;
- inverse `connect`, `create`, and found/missing `connectOrCreate` supply the
  owner in the correct reversed orientation and the direct collection observes
  the same row;
- inverse `update` and found/missing `upsert` mutate only the supplied or
  captured owner selected by the ordinary to-one composition lattice;
- inverse `disconnect` removes only the member row, while inverse `delete`
  deletes the selected owner and lets the source FK cascade remove membership;
  neither operation deletes the fixed polymorphic target;
- inverse vacate/supply/modify compositions preserve their canonical order and
  leave the direct and inverse views in agreement;
- plural inverse `connect`, `create`, `connectOrCreate`, and `createMany`
  publish/link the complete owner tuple in reversed orientation and are visible
  through the direct tagged collection;
- plural inverse `set` replaces only that fixed target's owner memberships;
  another target and another variant are unchanged;
- plural inverse `update`, `updateMany`, and found/missing `upsert` cannot reach
  an unowned owner decoy;
- plural inverse `disconnect` removes only member rows, while
  `delete`/`deleteMany` delete the selected owner rows and cascade their other
  variant memberships without deleting the fixed target;
- exact reconnect is idempotent while a different-owner occupied slot is not
  swallowed on PostgreSQL, SQLite/D1, or MySQL;
- parent and target complete-key transitions preserve membership;
- mapped/raw-key result boundaries never reorder tuple members;
- direct and inverse views of one member table produce the same own-write
  membership scope, while equal-looking tuples in different variant tables are
  disjoint;
- nested relation work under target create/update survives delegation;
- owner root skip suppresses target subtree and all member tables;
- fresh sibling after skipped root lands;
- later-segment failure preserves and reports only the exact committed prefix;
- malformed weak-batch result invalidates once and dispatches no successor;
- native-batch singular transfer compiles no write `expects`, while its exact
  membership assertions and target-side unique race still yield one winner;
- explicit transaction array either prepares exactly or refuses before writes;
- forced-low bind budget chunks target and junction statements without changing
  final membership;
- relation-wide set rolls back its clear and earlier insert chunks on later
  failure in a transaction;
- on a native-batch-only driver, a forced-low-budget set with pre-existing mixed
  membership, one clear, and several insert chunks either rolls the whole batch
  back to the exact original membership when the last chunk fails, or refuses
  before the clear if the driver cannot keep that unit atomic.

### 13.5 Migrations

Pin on PostgreSQL, MySQL, and SQLite-family snapshot/SQL owners:

- exact member table, PK, reverse index, unique side, and dual FK DDL;
- compound FK column order after introspection;
- second forced push has zero operations;
- public variant rename with a stable value and explicit unchanged table is
  metadata-only; default naming emits one table rename and no membership DML;
- table and column renames normalize before history comparison;
- member addition creates exactly one table;
- populated member removal requires a complete manual migration artifact;
- retarget requires a complete manual migration artifact;
- many-to-one inverse change refuses/fails on duplicate memberships and succeeds
  when data fits;
- one-to-many inverse widening removes only the target unique constraint;
- direct cardinality conversion does not guess data movement;
- owner/target table mapping changes keep metadata coherent;
- both `toOne.storageRef` and every `toMany` member-table reference resolve to
  exactly one structural owner; snapshots contain no second physical column,
  key, constraint, or action definition;
- storage-registry annotation changes do not emit DDL, and provider
  introspection without logical annotations does not cause second-push churn;
- topology-preserving rename and constraint inverses generate exact structural
  down operations;
- reversing an added member emits the normal explicit destructive-table warning
  and makes no data-preservation claim;
- a member removal, retarget, direct-cardinality change, or other data-copying
  transition refuses generation without a complete non-empty manual up artifact
  and manual rollback or explicit irreversible reason, with no
  migration/journal/snapshot write;
- a manual `toOne→toMany` artifact proves ordered destination-table creation,
  membership copy, and source-column removal; `toMany→toOne` proves the
  one-membership-per-owner choice before populating row-held storage;
- manual rollback SQL round-trips through storage and executes before tracking
  changes; a missing, comment-only, or empty automatic/manual artifact refuses
  the whole rollback group pre-effect;
- an irreversible entry persists its reason and makes a group rollback fail
  after the lock-protected applied-state recomputation but before any earlier
  reversible entry runs or is marked rolled back;
- `migrations.down()` is the only public rollback verb; the former
  tracking-only `migrations.rollback()` surface and apply route are absent, so
  neither manual nor irreversible policy can be bypassed by deleting tracking
  rows while leaving schema live;
- a concurrent migration change between the caller's request and lock
  acquisition is observed by the in-lock group recomputation, not rolled back
  from a stale preflight;
- squashing automatic migrations writes a non-empty down that reverses source
  migrations in reverse order and restores the pre-squash schema;
- squashing a mixed applied/pending range refuses after its in-lock state
  refresh but before migration, journal, snapshot, tracking, or artifact writes;
  all-applied and all-pending controls preserve their respective state;
- squashing a manual or irreversible migration refuses before migration,
  journal, snapshot, or down-artifact writes;
- reverse-one uniqueness removal is structural, while any later re-add proves
  target-side fit again at the database and leaves rollback tracking unchanged
  on failure.

### 13.6 Provider routes

At minimum execute, rather than merely register:

| Provider family | Required evidence |
|---|---|
| PGlite | Complete public direct/inverse behavior, compound keys, transaction rollback |
| PostgreSQL | Real compound FK introspection, second-push no churn, lateral/correlated read SQL |
| MySQL/mysql2 | Junction DDL, JSON result carrier, set/update/delete behavior, rollback |
| PlanetScale | Its configured FK/migration doctrine plus public query/write parity |
| SQLite3 | Compound member SQL, generated IDs, migration recreation, strict results |
| Bun SQLite | int64/driver transport parity for member keys |
| libSQL | Native alter/rebuild routing and query/write parity |
| D1/workerd | Atomic native batch, generated owner/target flow, skip and progress behavior |
| Neon fake/hosted when available | One-request batch preparation, generated-output boundary, strict parsing |

Missing hosted credentials produce visible skips and are never described as
executed evidence.

## 14. Retained boundaries

This plan deliberately retains precise boundaries rather than hiding them under
“full polymorphism.”

1. **Singular target identity:** `toOne` keeps the current one-compatible-scalar
   target-key representation. Exclusive per-variant FK tuples are a separate
   storage lift.
2. **No global heterogeneous ordering:** arm-local order/window is supported;
   a cross-arm total order needs an explicit common membership field.
3. **No required non-empty collection:** `toMany` can be empty.
4. **No inverse for same-model duplicate variants:** the memberships are valid,
   but an inverse cannot yet name which variant it represents.
5. **No physical modifiers on a polymorphic-bound `manyToMany` inverse:** the
   direct polymorphic field is the sole junction owner.
6. **No public `.fields()`/`.references()`:** polymorphic membership storage is
   private.
7. **No automatic direct cardinality migration:** row-held singular membership
   and N member tables require an explicit data decision.
8. **No provider-specific partial topology:** every shipped provider gets the
   same public cardinality and integrity model. Unsupported physical
   customization is refused at schema validation, not emulated with races.
9. **No operation-level atomicity fiction:** native-batch-only progressive paths
   retain their documented committed-prefix behavior.
10. **No effect before a skippable root:** a relation-bearing bulk member whose
    target work must precede a `skipDuplicates` owner root retains the existing
    pre-effect refusal.

Every retained boundary needs a public type, validation, or execution falsifier
at its existing owner. This section is not permission to scatter new refusal
constructors.

## 15. Completion criteria

The feature is complete only when all of the following are true:

1. Every polymorphic declaration in the repository chooses `.toOne()` or
   `.toMany()`; bare declarations are rejected.
2. The four topology cells in §2.2 work through public types, runtime
   validation, reads, writes, migrations, and result parsing.
3. `toOne` regression contracts remain green after explicit cardinality.
4. `toMany` uses one resolved ordinary-shaped junction per target variant, with
   real complete owner and target foreign keys.
5. Direct collection results are strict tagged-union arrays, never nullable,
   and narrow exactly under the stable variant allow-list without weakening
   integrity checks for excluded member tables.
6. Direct filters, variant selection, arm-local list controls, count, filtered
   count, and count ordering have exact public and provider evidence.
7. Every ordinary to-many mutation verb has variant-correlated schema, exact
   owner scoping, and compound-key runtime evidence.
8. Singular inverse adoption is atomic and race-safe; every plural-inverse
   read/write verb uses the same member table in reverse orientation.
9. Root createMany, generated owner/target values, root skip, bind chunking,
   progressive failures, cache invalidation, and explicit transaction arrays
   preserve their existing execution contracts.
10. Schema snapshots and member history distinguish public rename, stored value
    change, retarget, removal, topology rename, inverse-cardinality change, and
    direct-cardinality change without duplicating structural table facts;
    data-bearing transitions require executable manual up artifacts, and
    automatic, manual, and irreversible rollback policies fail safely under the
    migration lock through the sole public `migrations.down()` path; squash
    preserves automatic downs and accepts only a lock-verified uniform applied
    state while refusing policy-bearing sources it cannot compose.
11. Real provider second push is empty for compound member FKs; no introspection
    cross-product churn remains.
12. Contextual typing probes enter through the public core client and at least
    one driver wrapper, with typos beside real keys.
13. Current public docs, architecture guides, capability matrix, and local
    `AGENTS.md` files use the cardinality vocabulary in this plan.
14. Narrow layer/type/coverage/provider/package gates pass, `git diff --check`
    is clean, and skipped hosted routes are reported honestly.
15. No new relation-kind cross-product, duplicate junction DML owner, guessed
    identity carrier, or provider-name branch was introduced.

At that point VibORM has one polymorphic concept with an explicit slot
cardinality, not a special to-one feature plus a separately invented
many-to-many subsystem.

---

## 16. Ratified deviation — the API respell (2026-08-19)

§4.1 above is superseded. The unfinished-builder entry point it specifies was
retired after the whole program (Packages A–E) had landed, and this appendix
records the replacement so a reader of §4.1 finds it. Nothing else in the plan
moved: the engine, migrations, reads, writes, the two terminal classes and their
`"~"` internals are byte-identical in behaviour. This was an entry-SPELLING
change only. (Precedent for recording it here rather than editing the contract:
`limitation-lift-plan.md` §12.)

**What replaced it.** Two direct factories, named after the classes they return:

~~~ts
s.polymorphicToOne(targets, options?)   // -> PolymorphicToOneRelation
s.polymorphicToMany(targets, options?)  // -> PolymorphicToManyRelation
~~~

Same generics and the same overload structure as the retired `polymorphic()`:
const-inferred `Targets`, `DefaultValuesFor<Targets>` when the options bag is
absent or explicitly `undefined`, and the exact values map with `NoExtraKeys`
on BOTH `values` and the options bag itself, fresh and non-fresh.
`PolymorphicRelationBuilder`, `PolymorphicBuilderState` and the `polymorphic`
factory are DELETED — no alias, no re-export (unreleased project: no silent
estate compatibility).

**Why.** The builder's only job was to answer a question — which cardinality? —
that the call site always knew. Two factories answer it in the name, and the
whole class of "declared a carrier and never terminated it" disappears from the
public surface instead of being caught downstream.

**MAP ONLY, and why the constraint is wider than it looks.** Both factories
refuse a bare `() => model` at the TYPE level, with a message naming
`s.oneToOne` / `s.manyToOne` / `s.oneToMany` / `s.manyToMany`. The rationale is
on record: `s.polymorphicToOne(() => user)` reads like an ordinary edge and
would silently produce private `(type, id)` storage where the caller expected a
foreign key. The mechanism is `TargetMapOnly` in
`src/schema/relation/polymorphic.ts`. Its `Targets` constraint deliberately
admits a `Getter`, because a candidate refused BY the constraint is replaced
with the constraint and the diagnostic then names `Record<string, Getter>`
instead of what the caller should have written; the conditional return type
strips the same case, so the carrier a valid map produces is unchanged and the
exact key set survives (`Targets & PolymorphicTargetGetters` would widen `keyof`
to `string` and was rejected on measurement). `TargetMapOnly` is therefore the
ONLY thing refusing a thunk — it is not a second guard over the constraint.

**P013 stays, reworded.** The public path can no longer produce a
cardinality-less carrier, but hostile JavaScript still can: `isPolymorphicRelation`
is deliberately keyed on `state.type` alone, so a forged carrier reaches
definition validation instead of disappearing from model extraction. P013
remains the dispatch's ejection arm in `validatePolymorphicRelations` for a
carrier whose raw cardinality is neither `"one"` nor `"many"`; only its message
changed, to name the two factories. Its unique coverage is unchanged: a forged
carrier gets ONE owned issue instead of a `TypeError` or silence
(`polymorphic-rules.core.test.ts`, both ejection falsifiers).

**What §4.1's exact rules become.** "The unfinished builder cannot appear in
`s.model`" and "cardinality can be selected once" are now vacuous — there is no
builder and no second terminal to call — and their type pins were replaced, not
deleted, by two pins per factory: a callback argument is refused, and the map
spelling beside it compiles. Everything else in that list stands verbatim:
`.optional()` exists only on the to-one carrier, a collection state cannot carry
`optional`, and a forced carrier gets one owned schema issue.

---

## 17. Completion audit, 2026-08-19

APPENDIX. §15 is the contract; this is the verdict against it, criterion by
criterion, on branch `by-polymorphic-relations` after the API respell of §16.
Nothing in §1–§15 was edited to produce it.

Every verdict below rests on a run **executed for this audit** or a census
**counted for this audit**. Where a criterion rests on something that could not
be executed here, the obstacle is named and measured — "we could not" is a claim
like any other. The three reds this branch carries are the recorded allowlist and
are called out where they touch a criterion.

**Gates re-run for this audit, in this order, never overlapping:**

| Gate | Command | Result |
|---|---|---|
| Types | `pnpm test:types` | **EXIT 0** on the final tree, 24.1s wall / 38.1s user |
| Core | `pnpm test:core` | **5564 passed / 1 failed** (237 files, 82.7s) — the single red is allowlist item 1 |
| Diff | `git diff --check` | **EXIT 0**, clean |
| pg (docker) | `PG_TEST_CONNECTION_STRING=… --project=provider-pg -t polymorphic` | **44 passed / 885 skipped** (929) |
| mysql2 (docker) | `MYSQL_TEST_CONNECTION_STRING=… --project=provider-mysql2 -t polymorphic` | **38 passed / 1071 skipped** (1109) |
| sqlite3 | `--project=provider-sqlite3 -t polymorphic` | **36 passed / 1173 skipped** (1209) |
| pglite | `--project=provider-pglite -t polymorphic` | **65 passed / 775 skipped** (840) |
| extended-local (6 polymorphic/junction files) | `--project=extended-local <files>` | **241 passed / 241** |

Core is 5565 total rather than the 5564 of the pre-audit evidence base because
this audit ADDED one test while closing criterion 12 (below).

---

### Verdict table

| # | Criterion | Verdict |
|---|---|---|
| 1 | Every declaration chooses a cardinality; bare rejected | **MET-WITH-DEVIATION** (§16 made it structural) |
| 2 | Four §2.2 topology cells through every layer | **MET** |
| 3 | `toOne` regressions green | **MET** |
| 4 | One ordinary-shaped junction per variant, real complete FKs | **MET** |
| 5 | Strict tagged-union arrays, never nullable, exact narrowing | **MET** |
| 6 | Filters, selection, arm-local controls, counts, count ordering | **MET** |
| 7 | Every to-many verb: correlated schema, owner scoping, compound keys | **MET** |
| 8 | Singular adoption atomic and race-safe; plural inverse reversed | **MET** |
| 9 | Bulk, generated, skip, chunking, progressive, arrays preserved | **MET** |
| 10 | Snapshots, member history, rollback policy machinery | **MET** |
| 11 | Real provider second push empty; no introspection churn | **MET** |
| 12 | Contextual typing: core client AND a driver wrapper, typos beside real keys | **NOT-MET on arrival → CLOSED by this audit → MET** |
| 13 | Docs, guides, capability matrix and `AGENTS.md` use the vocabulary | **MET** |
| 14 | Gates pass, diff clean, hosted skips honest | **MET** |
| 15 | No new cross-product, duplicate DML owner, guessed identity, provider branch | **MET** |

---

### 1. Every declaration chooses a cardinality — MET-WITH-DEVIATION

The deviation is §16's, already ratified: the criterion asked for `.toOne()` /
`.toMany()` terminals and the shipped answer is two factories. The PROPERTY the
criterion protects — no declaration without a cardinality — is now structural
rather than enforced, which is strictly stronger.

**Census, counted for this audit:**

| Search | Hits | Classification |
|---|---|---|
| `s.polymorphic(` in `src/` + `tests/` | **0** | the bare carrier is unspellable |
| `PolymorphicRelationBuilder` / `PolymorphicBuilderState` in `src/` + `tests/` | **0** | deleted, no alias, no re-export |
| `polymorphicToOne` / `polymorphicToMany` sites | **356** across 11 `src/` and 50 `tests/` files | every declaration in the repository |
| `s.polymorphic(` anywhere else | **1** | `guard-ownership-ledger.md:1690`, which RECORDS the replacement |
| `.toOne()` / `.toMany()` outside this plan | **2** | both in the ledger's respell appendix, historical |

`src/schema/index.ts:87-88` exposes exactly two polymorphic entry points on `s`.

**The ejection arm still has teeth.** A forged carrier — `Reflect.construct` on
`PolymorphicToOneRelation` with a state omitting `cardinality`, which is the only
way to build one now — still gets exactly one owned P013 issue. Two falsifiers in
`tests/unit/schema-validation/polymorphic-rules.core.test.ts`: line 140
("attributes P013 to a forged carrier reached through an ordinary inverse",
asserting `["R003", "P013"]`) and line 209 ("ejects a forged carrier before its
content is diagnosed", asserting `["P013"]` alone, where a second code would mean
the ejection `continue` was removed). Both green in the core run.

### 2. The four topology cells — MET

Named end-to-end evidence per cell. Cells are §2.2's, i.e. the two-axis product
of direct cardinality and inverse arity — NOT the four collection configuration
cells in `polymorphic-collection-client.core.test.ts`, whose header calls them
"the four §2.2 topology cells" but which are all `toMany` (see the accuracy notes
below).

| Cell | Declaration | Types | Validation | Reads | Writes | Migrations | Parsing |
|---|---|---|---|---|---|---|---|
| **one-to-one** — `polymorphicToOne` + `oneToOne().optional()` | §2.2 | `polymorphic-operation-schemas.core.types.ts`, `polymorphic-result.core.types.ts` | `polymorphic-rules.core.test.ts`, `relation-cardinality.core.test.ts:33`, `relation-clearability.core.test.ts` | `polymorphic-inverse-read-sql.core.test.ts:59` (`oneToOne(() => singularComment)`) | `polymorphic-write-family.test.ts`, `record-compiler-contract.test.ts` | `polymorphic-serializer.core.test.ts`, `polymorphic-push.core.test.ts` | `polymorphic-result-parser.core.test.ts` |
| **many-to-one** — `polymorphicToOne` + `oneToMany()` | §2.2 | `polymorphic-create-many.core.types.ts`, gate file | `inverse-resolution-parity.core.test.ts`, `inverse-resolution-timing.core.test.ts` | `polymorphic-read-sql.core.test.ts`, `polymorphic-inverse-read-sql.core.test.ts:14` | `polymorphic-write-family.test.ts`, `polymorphic-write-plan.core.test.ts`, `polymorphic-compound-target.test.ts` | same two | same |
| **one-to-many** — `polymorphicToMany` + fields-less `manyToOne().optional()` | §2.3 | `polymorphic-operation-schemas.core.types.ts:1275+`, gate file | `polymorphic-rules.core.test.ts` (P015/P020/P021), `junction-rule-skips.core.test.ts` | `polymorphic-collection-read-behavior.ts` rows 447/474/512, `polymorphic-collection-bind.core.test.ts` | `polymorphic-collection-write-family.test.ts:1041-1432`, `polymorphic-collection-write-behavior.ts` rows 573-667 | `polymorphic-history.core.test.ts:404`, `polymorphic-serializer.core.test.ts`, `manual-migration.core.test.ts` | `polymorphic-result-parser.core.test.ts`, `polymorphic-collection-selection.core.test.ts` |
| **many-to-many** — `polymorphicToMany` + fields-less `manyToMany()` | §2.2 | same type files | same rule files | `polymorphic-collection-read-behavior.ts`, `polymorphic-inverse-read-sql.core.test.ts:91` | `polymorphic-collection-write-family.test.ts:708-944` (five §9.5 consequences) | `polymorphic-push.core.test.ts`, `polymorphic-serializer.core.test.ts` | `polymorphic-collection-omission.core.test.ts` |

`polymorphic-inverse-read-sql.core.test.ts` is the single strongest artifact: one
file carries all four inverse arities (lines 14, 40, 59, 85, 91) through read SQL.
`tests/contracts/drivers/behaviors/polymorphic-member-junction-behavior.ts`
carries a SINGULAR and a PLURAL member in ONE schema and proves the database
enforces the difference — which is the §2.3 claim that inverse cardinality is a
member fact, not a relation-wide one.

### 3. `toOne` regressions green — MET

Package A's estate, executed today:

- **pg**: the six `pg polymorphic relations` rows all ✓ (generated private
  storage pair preserved; inverse create publishes a generated parent identity;
  direct and inverse reads correlate without N+1; target-local `omit`; inverse
  reads use the generated discriminator/id index; empty storage optional but
  orphaned membership invalid).
- **core**: `polymorphic-read-sql`, `polymorphic-inverse-read-sql`,
  `polymorphic-result-parser`, `polymorphic-write-plan`, `polymorphic.core`,
  `polymorphic-client-omit`, `polymorphic-rules`, `polymorphic-relation`,
  `relation-cardinality`, `relation-clearability`, `inverse-resolution-parity`
  — all inside the 5564 passing.
- **extended-local**: `polymorphic-write-family.test.ts` and
  `polymorphic-compound-target.test.ts` (12 tests) inside the 241 passing.

### 4. One junction per variant, real complete FKs — MET

`polymorphic-member-junction-behavior.ts` is the pin, and it is the sharp one
because it writes membership rows with RAW SQL — so what it measures is the
DATABASE, not viborm's builder. Its fixture has a **compound owner row key
`(tenantId, code)`** and a **compound target row key `(region, isbn)`**, so
multi-column FK groups and their ordering are live.

Executed for this audit: **pg ✓** and **mysql2 ✓** (`… polymorphic member
junction storage > creates, enforces and converges the member tables`), plus
sqlite3 inside its 36. Assertions: one table per variant; the singular member's
UNIQUE sits on the COMPLETE TARGET side (line 171's comment names the three
failures it separates — unique on the owner columns, omitted, or the reverse
index flipped); the plural member's target side is NOT unique (the arm that stops
the first assertion passing on a schema that made every side unique); cascade from
the owner AND from the target.

DDL shape per dialect is pinned separately in
`polymorphic-serializer.core.test.ts` (12 rows).

### 5. Strict arrays, never nullable, exact narrowing — MET

Public: `client/result-types.ts` returns `readonly …[]` via
`InferPolymorphicResult`, pinned in `polymorphic-result.core.types.ts`.

Provider, all ✓ on pg today:

- "an empty collection reads as a fresh empty array, never null";
- "mixed variants flatten in DECLARATION order, tagged correctly";
- "equal ids in two target tables return two correctly tagged rows" — the tag is
  the member TABLE, not a value comparison;
- "only narrows the returned variants without reordering";
- **"an owner-scoped orphan fails the read, even hidden behind `only`"** — this
  is the second half of the criterion, the one that is easy to lose: excluding a
  variant from the projection must not exclude it from integrity.

### 6. Filters, selection, arm-local controls, counts, ordering — MET

Public evidence: `polymorphic-collection-filter.core.test.ts` (13 rows),
`polymorphic-collection-selection.core.test.ts` (19), and
`polymorphic-collection-omission.core.test.ts` (11) — all inside the core run.

Provider evidence, ✓ on pg today: "order, window and distinct stay ARM-LOCAL";
"a negative arm take restores the logical order"; "total and filtered counts, and
count ordering"; "some / every / none over a MIXED-VARIANT truth table".

### 7. Every to-many verb, correlated and owner-scoped, on compound keys — MET

Schema half: `polymorphic-collection-mutation.core.test.ts` (17 rows after this
audit's addition) walks the eleven update verbs and the four create verbs, the
free discriminator/payload correlation, `singleOrArray` on every verb including
`createMany`, the absent create-context `upsert`, unconditional `disconnect` with
no `disconnect: true`, and — new — the misspelled-verb refusal.

Runtime half: `polymorphic-collection-write-family.test.ts` (36 rows) with a
fixture whose OWNER key is `(tenantId, code)` and whose target keys are compound
too. Owner scoping is stated negatively where it matters: "update cannot reach an
UNOWNED decoy of the same variant"; "`set` on ONE owner leaves another owner's
memberships alone"; "disconnect removes MEMBERSHIP only, and only this owner's".

Provider half: 18 write rows ✓ on pg today, and the same 18 registered and
passing on sqlite3 and mysql2.

### 8. Singular adoption atomic and race-safe; plural inverse reversed — MET

**The concurrency rows were RUN FOR THIS AUDIT, not inherited.** `nc -z` first:
`viborm-pg-test-2` on 5434 and `viborm-mysql-test` on 3307 both up (9 days).
pg run serially, alone.

`pg singular polymorphic slot transfer under concurrency` — **7/7 ✓**:

| Row | ms |
|---|---|
| two adopters of a held target leave one membership owned by an adopter that succeeded (tx) | 85 |
| two adopters of an empty slot are arbitrated to one membership (tx) | 57 |
| two adopters of a held target … (batch) | 69 |
| two adopters of an empty slot … (batch) | 56 |
| an adopter whose captured owner was replaced fails and leaves the winner's row | 62 |
| two adopters that captured the SAME old owner produce exactly one winner | 56 |
| two adopters that both observed the slot EMPTY produce exactly one winner | 56 |

`mysql2 singular polymorphic slot transfer under concurrency` — **2/2 ✓** (tx
mode only, 144ms + 63ms). The two-row shape is DECLARED, not missing: `mysql2.test.ts:454`
registers `createTxDriver` alone with the reason on the line above it — MySQL's
public adapter is non-returning and cannot roll public parsing back after a batch
commits — so the batch and captured-plan modes are pg's by design.

These are two REAL CONNECTIONS throughout, with an arrival latch that turns
"both racers probably captured the same old owner" into a fact, and every
assertion is about DATABASE STATE after both settle. The deterministic row
carries its own falsification note: removing the in-batch captured-owner premise
AND the vacate's captured-owner scoping reddens both halves at once, while
removing either alone leaves it green — which is the honest shape of the design,
recorded rather than glossed.

Plural inverse in reversed orientation:
`polymorphic-collection-write-family.test.ts:708` ("connect/create/connectOrCreate
supply the OWNER in reversed orientation") plus the five numbered §9.5
consequences at :746, :796, :835, :900 and :944 — the last being that the direct
and inverse views of one member table are ONE own-write scope. Provider half:
"a plural member admits SEVERAL owners for one target" and "a singular inverse
returns one row or null, and a plural one an array", both ✓ on pg.

### 9. Bulk, generated, skip, chunking, progressive, arrays — MET

| Concern | Evidence | State |
|---|---|---|
| Root `createMany` with a collection | `create-many-relation-series-behavior.ts` (19 rows, fixture at :41 carries `polymorphicToMany`); `polymorphic-create-many.core.test.ts`; `parity-j-create-many.test.ts` (19 rows, fixture at :151) | in the 5564 / 241 |
| Generated owner and target values | pg "direct writes preserve the generated private storage pair" + "inverse create publishes a generated parent identity" | ✓ today |
| Root skip | `create-many-relation-series-behavior.ts:608` "skipDuplicates suppresses the complete duplicate subtree", :651 "skipDuplicates on scalar-only rows is untouched" | in the 5564 |
| Bind chunking | `RelationJunctionPart.ts:1622-1646` — every chunk stays in the operation's existing transaction/native batch; :551 records that chunking is the PLURAL path's alone because a singular slot writes one row | reused, not reinvented |
| Progressive failures | `junction-progressive-preflight.test.ts` (12 rows), `parity-j-create-many.test.ts:845` (the verbatim non-returning `select`+`skipDuplicates`+polymorphic refusal) | in the 241 |
| Cache invalidation | `PolymorphicCollectionPart.ts:52-57` — **the collection's cache footprint is EMPTY as a measured fact**: invalidation lives above the engine in `client.ts`'s `withMutationCacheInvalidation`, `$transaction([…])` runs the same closure, and no `Part` in the estate invokes a cache callback. Adding target-model invalidation here would be the private dependency-invalidation system §10.6 forbids | preserved by reuse |
| Explicit transaction arrays | same closure as above; `rawArrayTransactionContract` on pg and mysql2 | ✓ today |

The strongest form of this criterion is "preserved by reuse rather than
re-implemented", and that is what the chunking and cache rows show.

### 10. Snapshots, member history, rollback policy — MET

**Distinguishing the seven transitions** —
`polymorphic-history.core.test.ts` (34 rows) has a named row for each:

| Transition | Row |
|---|---|
| public rename | :190 "treats target additions and public-key renames as safe metadata" |
| stored value change | :207 "refuses a stored discriminator change outright"; :342 "dispatches a stored-value change by kind: toOne refuses, toMany is metadata-only" |
| retarget | :241, :418 |
| removal | :241, :418 |
| topology rename | :489 "rewrites an explicit-values variant rename into renameTable+renameColumn with zero data movement"; :541; :595; :636 |
| inverse-cardinality change | :404 "treats a collection inverse-cardinality change as exactly structural" |
| direct-cardinality change | :327 "refuses a direct cardinality change in both directions" |

**Without duplicating structural table facts:** :159 "keeps member history outside
the structural differ", and the coherence block at :682-768 (six rows) refuses a
snapshot whose logical and physical halves disagree, including a pre-B3 format
rather than reading it.

**Executable manual up artifacts:** `polymorphic-history.core.test.ts:1071-1290`
(five rows plus a parameterized refusal set — all four artifacts written for a
transition with ZERO structural operations; a comment-only down for an
irreversible migration with its reason persisted; nothing written in dry run;
manual mode elected even when not data-bearing; every incomplete artifact refused
before any write). Executed end-to-end in
`manual-migration.core.test.ts` — "toOne -> toMany: creates the destination,
copies membership, drops the source columns" and "toMany -> toOne: chooses one
membership per owner BEFORE populating row-held storage".

**All three rollback policies fail safely under the lock, through one path:**
`apply.core.test.ts` — automatic ("generates up+down, applies, rolls back, and
re-applies"; "rolls back to a specific migration with `to`"), manual ("round-trips
a manual migration's rollback SQL through storage"), irreversible ("refuses a
group containing an irreversible migration, quoting its reason"), fail-safety
("leaves schema AND tracking unchanged when a down statement fails"; "refuses the
WHOLE group when any down artifact is missing, empty or comment-only"; "never
executes a `-- down` marker tail from the up artifact"), and the lock
("recomputes the rollback group from state read under the lock"). **Sole public
path verified structurally:** one implementation in `src/migrations/apply/down.ts`,
exported once at `src/migrations/index.ts:11`, wrapped once at
`src/migrations/client.ts:249`.

**Squash** — `squash.core.test.ts`, four rows: composes a reversible migration
whose down restores the pre-squash schema; refuses a mixed applied/pending range
before any write with both uniform controls succeeding; refuses a manual or
irreversible source before any write; refuses a non-suffix range and a source
with no down artifact.

### 11. Real provider second push empty; no introspection churn — MET

The assertion is `polymorphic-member-junction-behavior.ts:216-217` — quoted here
rather than fenced, because the two lines are an excerpt from inside a test body
and nothing about them is a standalone example: `const secondPush = await
push(client, { force: true });` followed by
`expect(secondPush.operations).toEqual([]);`.

It was executed for this audit on **pg ✓** and **mysql2 ✓**, and inside
sqlite3's 36.
This is the check that fails if the serializer and the introspector disagree on
any spelling, and the fixture makes it maximally demanding: compound primary keys
on BOTH sides, dual FK groups, reverse indexes, and the singular member's unique
side all have to introspect back identically. The surviving membership row is
asserted untouched afterwards, so "empty" is not achieved by dropping and
recreating.

### 12. Contextual typing through core client AND a driver wrapper — NOT-MET on arrival, CLOSED, now MET

**What the audit found.** `contextual-typing-gate.core.types.ts` had polymorphic
probes, but they failed the criterion on BOTH halves:

1. **No driver wrapper.** Every collection probe entered through `createClient`
   from `@client/client`. The wrapper section at :541 covers config keys, `omit`
   and `instrumentation` — not the collection surfaces. That is exactly the gap
   the file's own header exists to prevent: 2f7bd59's finding was that keying the
   core client left eleven wrappers open.
2. **No write probe at all.** Only `include` was probed. The write grammar's type
   half IS pinned — in `polymorphic-operation-schemas.core.types.ts:1150-1290` —
   but every probe there is `satisfies OperationPayload<…>`, an internal alias.
   The gate file's rule 1 exists to exclude precisely that: typing the alias is
   not typing the call.

**What was added, and what it measured.** A `boardWrapperClient` via
`pgliteCreateClient`, then read and write probes through both entry points.
Three measurements came out of it, one of them a finding:

- the read envelope IS keyed through the wrapper: `variantss` beside `only`,
  `imag` beside `note`, and `only: ["note", "nte"]` are all refused;
- the WRITE discriminator IS keyed at both entry points: a `type: "nte"` entry
  beside a real `type: "note"` entry is refused;
- **the verb bag is NOT keyed at compile time, and that is a pre-existing measured
  boundary rather than a collection defect.** `data` / `create` / `update` are on
  `ClauseGuard`'s NOT-GUARDED list in `src/client/types.ts`, with the cost on
  record: reaching for a write clause's key set expands the recursive nested-write
  union, six estate sites turn `TS2589`, and the type-check goes to 172s. So
  `items: { connect: […], connct: […] }` compiles — **and so does
  `books: { connect: […], connct: […] }` on an ordinary `oneToMany`**, which is
  the twin probe added beside it to prove the boundary is general.

Following the file's own idiom for an unguarded level, that boundary is now a
COMPILING PIN with the runtime refusal named — and the runtime refusal, which did
not exist, was added:
`polymorphic-collection-mutation.core.test.ts` → "a misspelled verb is refused by
the bag, in both contexts", asserting `Unknown key: connct` on the update bag and
`Unknown key: creat` on the create bag, each beside a real verb.

**Falsified, then restored.** The two `@ts-expect-error` directives were
falsified by correcting `"nte"` to `"note"`; tsc reported
`contextual-typing-gate.core.types.ts(1753,13): error TS2578: Unused
'@ts-expect-error' directive` and the same at `(1784,13)` — one for the core
client, one for the wrapper — proving both are load-bearing and that the wrapper
half is genuinely independent. Restored from a scratchpad copy, `shasum -a 256`
`b1a745af…c327c` matching byte-for-byte. `pnpm test:types` EXIT 0 after restore;
the new runtime row passes (`layer-operation-schemas`, 1 passed).

Two files changed by this audit, both tests:
`tests/types/client/contextual-typing-gate.core.types.ts` and
`tests/unit/operation-schemas/relations/polymorphic-collection-mutation.core.test.ts`.

### 13. Docs, guides, capability matrix, `AGENTS.md` — MET

Verified independently of the doctrine pass that produced them.

- **Sweep for stale collection claims** across `docs/`, `features-docs/`,
  `README.md`, `CONTEXT.md`, `PENDING_WORK.md` and every `src/**/AGENTS.md`
  (patterns: "polymorphic (many-to-many|collection) … (not yet|not supported|
  cannot|no query grammar|planned|later release)", "(not yet|cannot yet)
  (read|writ|query)"): **0 hits** outside this plan document.
- **Sweep for to-one framing** ("polymorphi* (is|are) (intrinsically|inherently|
  always|by nature) (to-one|singular)", "polymorphism is (to-one|singular)"):
  **0 hits** anywhere, which is Package F's land gate.
- **"six operation-schema families":** the one surviving hit,
  `features-docs/polymorphic-relations.md:99`, is the POSITIVE statement — the
  collection "builds all six".
- **`AGENTS.md` coverage census:** `schema/relation` 56 mentions,
  `query-engine` 44, `query-engine/builders` 34, `migrations` 14,
  `validation` 10, `client` 1 (cardinality-neutral and correct). The four with
  zero — `cache`, `instrumentation`, `adapters`, `scalars` — have no polymorphic
  concern.
- **Capability matrix:** §2.8.1 exists, is framed as a post-snapshot measurement,
  and its NOT RUN cells are traceable. Spot-checked against
  `tests/providers/matrix.ts`'s `PROVIDER_RUNS`, parsed for this audit: pglite has
  read+write but NOT member-junction; libsql has `polymorphicRelationContract`
  only; postgres.js has no polymorphic contract; sqlite3, pg and mysql2 have all
  four; d1, neon-http, planetscale, bun-sql and bun-sqlite have zero contracts.
  Every cell matches. §3.C's C9 no longer lists polymorphic relations as
  unimplemented.
- **Guard ownership ledger** carries the Package D/E addenda (`:1435`, `:1561`
  P021, `:1589` the two deleted refusals) and the respell appendix at `:1685`.
- **Behavior-file test counts** independently recounted with
  `grep -c '^    test('`: read **12**, write **18**, member-junction **1** —
  matching §2.8.1 exactly.

### 14. Gates, diff, honest hosted skips — MET

The gate table at the top of this section is this criterion's evidence.

The one core red is **allowlist item 1** —
`tests/unit/instrumentation/driver-context-concurrency.core.test.ts:400`, "keeps
two clients on one driver bound to their own sinks and disclosure", `Test timed
out in 30000ms`. Verified pre-existing at base `39a0f12e` in a pristine worktree,
5/5 runs, and unrelated to polymorphism (it is a driver execution-context
concurrency test with no relation in it).

**Hosted skips, reported honestly rather than inferred.** These could NOT be
measured here, and §2.8.1 says NOT RUN for each with its obstacle:

| Route | Obstacle | Measured how |
|---|---|---|
| `provider-d1` | Collect-time `Disallowed operation called within global scope` from `@paralleldrive/cuid2/src/index.js:23` under the workerd pool. **Zero tests execute**, so it measures nothing either way. Allowlist item 3, pre-existing and unrelated | run attempted; fails before collection |
| `neon-http` | No credentials on this machine (`availability: "neon-credentials"`) | `PROVIDER_RUNS` is empty for it; nothing to skip dishonestly |
| `planetscale` | No credentials (`availability: "planetscale-credentials"`) | same |
| `bun-sql`, `bun-sqlite` | Platform runtime probes only | same |
| `libsql` | Registers `polymorphicRelationContract` only — the to-one path. A REGISTRATION gap, not a failure | `PROVIDER_RUNS` parsed for this audit |
| `postgres` (postgres.js) | Registers no polymorphic contract at all | same |
| `pglite` | Registers read + write but not member-junction | same |

The three registration gaps are test-authoring decisions, not defects, and
§2.8.1 states them as NOT RUN rather than letting a sibling dialect stand in.
`extended-local` carries allowlist item 2 (`legality-gate.test.ts:258` ×1,
`m8-race-retry.test.ts:172,324` ×2); the six polymorphic/junction files in that
project were run for this audit and are **241/241 green**, so none of the three
touches this feature.

### 15. No new cross-product, duplicate owner, guessed identity, provider branch — MET

Grep census with the plan's own vocabulary (§6.1, §3.3, §10.4).

**No new relation-kind cross-product.** `RelationType` in
`src/schema/relation/types.ts:10-14` is still exactly
`"oneToOne" | "oneToMany" | "manyToOne" | "manyToMany"`; the branch diff of that
file touches only inverse-candidate key filtering. `polymorphicJunction`:
**0 hits in `src/`** — §6.1's named anti-pattern was not introduced.
`BoundJunctionMembership` is one interface
(`relation-data-builder.ts:123`), not two.

The one thing that LOOKS like a cross-product and is not:
`polymorphic-collection-mutation.ts:108-131` builds a synthetic
`manyToMany()` carrier per member so the mutation parser reads the PUBLIC slot's
vocabulary. It reuses the existing kind rather than adding a fifth, it is BRANDED
`polymorphicMemberCarrier: true`, it is in no relation map, and the single route
that could re-resolve it — `classifyRelation` — refuses it by name at
`relation-data-builder.ts:560` with the two silent-wrong-answer failures spelled
out in the guard's comment. That is one guard with nameable unique coverage, and
`RelationInfo.polymorphicMemberCarrier` exists for it and nothing else (three
sites total).

**No duplicate junction DML owner.** `ManyToManyStatements.ts` was RENAMED to
`JunctionStatements.ts` (git shows `D` + `??`, not two files) and generalized to
ten operations. `RelationJunctionPart` and the new `RelationJunctionToOnePart`
both route through it; neither builds junction DML privately.

**No guessed identity carrier.** `junction-topology.ts`'s header states the
contract and the code honors it: the owner "never derives model names or row
keys (callers forward them, possibly empty, so `getJunctionFieldGroups` stays the
single emptiness guard)", and "no synthetic manyToMany state exists anywhere" on
the member path — `resolvePolymorphicMemberJunctionTopology` feeds the shared
derivation with tokens taken directly from `.through()` or from the defaults
`resolvePolymorphicMemberNames` owns. §3.3's "no guessed target" holds: every
target is selected by an exact public variant, and the union itself refuses an
unconfigured one (`polymorphic-collection-mutation.core.test.ts`, "an
unconfigured variant is refused by the union itself").

**No provider-name branch.** Census of
`(provider|driverName|dialect|adapterName) === "…"` across all of `src/`:
**3 hits, all in `src/migrations/utils.ts:36-42`** (`normalizeDialect`), which is
pre-existing — last touched by `f80c2c0d`, and `git diff main...HEAD` on that
file is empty. Zero introduced by this program. The dialect differences §2.8.1
records (MySQL errno 1553, SQLite's undroppable auto-index) live in TEST
falsification strategy, not in `src/`.

---

### Accuracy notes — found during the audit, not blocking any verdict

Three stale claims in TEST-FILE prose. None changes a verdict: every assertion
around them executes and passes. They are recorded because a future reader of the
evidence would be misled by them.

1. `tests/contracts/drivers/behaviors/polymorphic-member-junction-behavior.ts:12-21`
   — "Nothing can read or write those tables through the client yet (the
   operation-schema families are omitted until Package C)" and "testing DDL whose
   client surface does not exist yet". Both were true at B3 and are false now.
   The raw-SQL seeding the paragraph justifies is still the RIGHT choice, but for
   the reason its sibling write-behavior file states in its own header — raw
   seeding cannot be co-broken by a write regression — not for the reason given.
2. `tests/contracts/public-client/polymorphic-collection-client.core.test.ts:24`
   — "These pins walk the four §2.2 topology cells". Its four cells are all
   `toMany` configuration variants (bare single-variant, multi-variant, mixed
   inverses, compound key with `.through()`); §2.2's four cells span both
   cardinalities. The file's content is right; the cross-reference is not.
3. `tests/contracts/drivers/behaviors/polymorphic-collection-read-behavior.ts:196`
   — "the write family lands in Package D", already captured on an existing chip
   together with two stale comments in `relation-data-builder.ts:158-161` and
   `:198-204`.

One formatting inconsistency: `capability-matrix-2026-07.md:622` numbers §2.8.1
as an H2 (`## 2.8.1`) inside §2.8's H2 sibling run, so it reads as a peer of §2.8
rather than a child.

### What this audit changed

| File | Change |
|---|---|
| `tests/types/client/contextual-typing-gate.core.types.ts` | Closed criterion 12: a `pgliteCreateClient` board client, four wrapper read probes, and the write section (both entry points) with the `data`-clause boundary pinned and its ordinary-relation twin |
| `tests/unit/operation-schemas/relations/polymorphic-collection-mutation.core.test.ts` | The runtime refusal that boundary points at: "a misspelled verb is refused by the bag, in both contexts" |
| this file | §17 |

No `src/` file was modified. `git diff --check` clean.
