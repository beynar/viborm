# Polymorphic Relations — Decision-Gated Implementation Plan

> **Design:** [`polymorphic-relations.md`](./polymorphic-relations.md), revision
> 4, is normative for semantics. This document is normative for build order,
> ownership, compatibility gates, and validation.
>
> **Plan date:** 2026-08-08
>
> **Status:** Y0–Y9 are complete on the feature branch. Core, extended-local,
> performance, package, PGlite, SQLite3, libSQL, PostgreSQL, and MySQL2 gates
> are green. Three warm type checks have a 19.22-second median, 0.26% above the
> 19.17-second Y0 baseline. All implementation and validation gates are
> complete.
>
> **Architecture:** current consolidated query engine; no `query-engine-v2`

## 0. Required outcome

Implement the narrow V1 polymorphic-relation surface:

- direct required/optional polymorphic to-one relation;
- direct include/select and type-correlated filters;
- inverse `oneToMany` include, filters, and count;
- strict discriminated result parsing;
- direct `connect`, `create`, and `disconnect`;
- inverse nested `create`;
- generated private `(type, id)` columns and composite index;
- PostgreSQL, MySQL, SQLite, and libSQL parity.

Planning estimate: **1,800–2,800 production lines across roughly 30–45 files**,
plus tests/docs. This is not an acceptance quota. The expected unavoidable new
facts are the public relation, private storage descriptor, direct resolved edge,
resolved inverse binding, resolved mutation companion, atomic storage value,
polymorphic expected result shape/carrier, and migration metadata/change. A
phase that adds a second owner for one of those facts must stop and merge it
back into its semantic owner.

Preserve:

- all existing public behavior for ordinary relations;
- operation validation and error timing;
- normal read LATERAL/correlated strategy selection;
- direct, `RETURNING`, `ON CONFLICT`, CTE, planning-batch, and atomic-batch
  performance paths;
- SQL parameterization and destination casts;
- write planning/final step order, guards, race pins, and retries;
- `RelationMutationProgram`, `BoundRelation`, `CreateOperation`,
  `RecordUpdateCompiler`, `QueryMetadata`, adapter `batchRefs`, and
  `ManyToManyStatements`.

Do not add:

- a runtime step kind;
- an adapter/driver execution change;
- a generic mutation, strategy, lifecycle, locator, or placement framework;
- public shadow scalar fields;
- an `adapter.polymorphic` namespace;
- an extra database statement or client-side N+1 query;
- unsupported inverse mutation verbs;
- inverse `oneToOne`;
- relation-specific checks in the model-blind parse boundary.

### Current phase ledger

“Green” means the phase's source and the named execution proof both passed on
2026-08-08 under the serialized, memory-capped launchers.

| Phase | Source status | Validation status |
|---|---|---|
| Y0 | Approved getter-map API and fixed V1 semantics | Recorded Y0 spike evidence retained below |
| Y1 | Implemented relation state, private storage, and mandatory definition gate | Relations and schema-validation layers green |
| Y2 | Implemented operation schemas, public result/input types, omit traversal, and `createMany` refusal | Operation-schema, client, and type gates green |
| Y3 | Implemented snapshot storage, composite index, metadata-only generation, and history acknowledgement | Migration layer and five provider pushes green |
| Y4 | Implemented direct CASE projection/filter and mutation-result fold plumbing | Query-engine and performance-fold contracts green |
| Y5 | Implemented strict discriminator-aware result parsing through the existing decode hook | Five provider decode contracts green |
| Y6 | Implemented direct connect/create/disconnect through the record compilers | Transaction, atomic-batch, race, and rollback witnesses green |
| Y7 | Implemented exact inverse reads/count and inverse nested create | Query, write-family, and five provider contracts green |
| Y8 | Shared provider contract is wired; cache needed no polymorphic special case; the existing result/instrumentation kind union was extended | PGlite, SQLite3, libSQL, PostgreSQL, and MySQL2 full projects green |
| Y9 | Documentation, performance, architecture, and delivery gates are reconciled | Package build, static gates, zero write-engine cycles, and type median green |

## 1. Fixed internal design

### 1.1 Existing facts remain separate

```ts
interface RelationMutationProgram {
  readonly relationInfo: RelationInfo;
  readonly entries: readonly RelationMutationEntry[];
}
```

The program continues to describe schema-transformed mutation meaning.

```ts
type BoundRelation =
  | ParentHeldToOne
  | ChildHeldToOne
  | ChildHeldToMany
  | JunctionRelation;
```

`BoundRelation` continues to describe topology only.

### 1.2 New schema-owned storage fact

Keep ordinary relation types honest:

```ts
interface PolymorphicRelationState {
  readonly type: "polymorphic";
  readonly targets: Readonly<Record<string, Getter>>;
  readonly values: Readonly<Record<string, string>>;
  readonly name?: string;
  readonly optional?: true;
}
```

The concrete generic state retains the literal target-getter/value-map types,
following the current relation classes. Add `AnyPolymorphicRelation`
separately. Do not add
`"polymorphic"` to `RelationType` and do not add the class to `AnyRelation`.
Add the third model-field category explicitly:

```ts
type AnyModelField = Scalar | AnyRelation | AnyPolymorphicRelation;
type ModelShape = Record<string, AnyModelField>;
```

Add `ModelState.polymorphicRelations`. Keep `ScalarKeys` and ordinary
`RelationKeys` narrow, add `PolymorphicRelationKeys`, and compose broader
projectable-relation keys only at the public consumers that need both.

Do not extend `GetInverseRelationMap`; it owns ordinary public FK-field tuples.
The runtime resolver returns the exact member:

```ts
interface PolymorphicInverseBinding<
  TRelationKey extends string = string,
  TPublicType extends string = string,
  TStoredType extends string = string,
> {
  readonly relationKey: TRelationKey;
  readonly publicType: TPublicType;
  readonly storedType: TStoredType;
}
```

The type-level `GetPolymorphicInverseBinding` returns only the selected
`relationKey`. TypeScript model types are structural, so two separately declared
models with identical shapes cannot identify an exact member truthfully. The
runtime sibling uses registered model identity and returns the exact
`publicType`/`storedType`. Both first select the sole owner relation or the
uniquely named owner relation, then check source membership; P010 owns exact
member uniqueness at the mandatory definition gate.
Neither returns private column names or an ordinary FK tuple.

Add one cached descriptor on the owning model, keyed by the polymorphic field:

```ts
interface PolymorphicStorage {
  readonly relationName: string;
  readonly ownerModel: Model<any>;
  readonly indexName: string;
  readonly typeColumn: {
    readonly name: string;
    readonly scalar: Scalar;
    readonly nullable: boolean;
  };
  readonly idColumn: {
    readonly name: string;
    readonly scalar: Scalar;
    readonly nullable: boolean;
  };
  readonly members: ReadonlyMap<
    string,
    {
      readonly storedType: string;
      readonly targetModel: Model<any>;
      readonly referencedField: string;
    }
  >;
}
```

It must not contain scopes, aliases, SQL, source values, branch state,
`BoundRelation`, or execution policy.

`relationName` is the hydrated model field key, not the `.name()` pairing
label. `src/schema/hydration.ts` calls the polymorphic relation's internal
source-binding seam with both owner model and relation field key; ordinary
relation hydration remains unchanged. The descriptor derives its columns and
index from that field key and the mapped owner-table name.

### 1.3 New resolved compiler facts

After one schema transform, resolve one public discriminator:

```ts
interface ResolvedPolymorphicEdge {
  readonly publicType: string;
  readonly storedType: string;
  readonly targetModel: Model<any>;
  readonly referencedField: string;
  readonly storage: PolymorphicStorage;
  readonly relationInfo: RelationInfo;
}
```

`relationInfo` must be an internally coherent ordinary parent-held to-one view.
Its outer fields and underlying relation state must agree.

That fact is direct-only. An inverse has different topology and uses:

```ts
interface ResolvedPolymorphicInverse {
  readonly relationInfo: RelationInfo;
  readonly childRelationKey: string;
  readonly publicType: string;
  readonly storedType: string;
  readonly sourceReferencedField: string;
  readonly storage: PolymorphicStorage;
}
```

`relationInfo` is the real ordinary inverse `oneToMany` into
`storage.ownerModel`. This resolved binding carries no scope, alias, parent
identity, SQL, or execution policy. Never coerce it into the direct edge or
coerce the direct edge into to-many cardinality.

### 1.4 Atomic physical assignment

Use exact state, not two optional values:

```ts
type PolymorphicStorageValue<TId> =
  | {
      readonly kind: "linked";
      readonly storage: PolymorphicStorage;
      readonly storedType: string;
      readonly referencedField: string;
      readonly id: TId;
    }
  | {
      readonly kind: "empty";
      readonly storage: PolymorphicStorage;
    };
```

The record compiler holds
`PolymorphicStorageValue<FinalReferenceSource>`. Immediately before SQL
construction it resolves the id with the existing foreign-key source owner and
passes `PolymorphicStorageValue<unknown>` to the neutral builder. This prevents
`values-builder.ts` or `set-builder.ts` from importing the write engine.

The lowerer for INSERT/UPDATE writes both columns together. There is no API that
can update only one member. A record can carry an ordered array of these values;
the array is appended after user scalars and existing ordinary derived FK
assignments, then ordered by owner-model polymorphic declaration order, type
before id. Target branch steps still follow the existing relation-program
iteration.

`referencedField` labels the source. `foreign-key-reference.ts` resolves a
planning/final/transitioned source against that field; the destination cast is
owned separately by `storage.idColumn.scalar`. The polymorphic lowerer builds a
temporary `ForeignKeyMember` from `storage.idColumn.name`, the storage value's
own `referencedField`, and its id source, then calls the unchanged
`foreignKeyWriteValue`/`foreignKeyWriteValueWith`. Its callers pass only the
storage value; no caller supplies a second independent field-name argument.

### 1.5 Parsed relation composition

Do not alter `RelationMutationProgram`. Extend parsed-record output with a
companion map keyed by the same relation name:

```ts
type ResolvedPolymorphicMutation =
  | {
      readonly kind: "targeted";
      readonly edge: ResolvedPolymorphicEdge;
      readonly program: RelationMutationProgram;
    }
  | {
      readonly kind: "disconnect";
      readonly storage: PolymorphicStorage;
    };

interface ParsedRecordPrograms {
  readonly scalarData: Record<string, unknown>;
  readonly relations: Record<string, RelationMutationProgram>;
  readonly polymorphic: Readonly<
    Record<string, ResolvedPolymorphicMutation>
  >;
}
```

Every targeted polymorphic program also appears in `relations`; the companion
map supplies its storage/discriminator fact. Iteration remains over `relations`,
so relation order and step-ID allocation do not change. Disconnect has no
target, program, Part, or step; it exists only in the companion map and becomes
an empty root storage value. Root private assignments are collected separately
and sorted by the model's polymorphic declaration order, so targetless
disconnect cannot perturb target-step order or depend on object-map iteration.

If implementation proves that a smaller composition preserves those invariants,
use it. Do not introduce parallel ordered arrays or a second mutation program.

### 1.6 Result shape

Add a distinct expected shape:

```ts
interface ExpectedPolymorphicResultShape {
  readonly optional: boolean;
  readonly variants: ReadonlyMap<
    string,
    {
      readonly model: Model<any>;
      readonly shape: ExpectedResultShape;
    }
  >;
}
```

`ExpectedResultShape` keeps ordinary relations and gains a separate polymorphic
relation map. It must not coerce a multi-target relation into `AnyRelation`.

## 2. Execution protocol

### 2.1 Preflight

Before production edits:

1. Work from a clean worktree after the current test-estate rebuild is complete.
2. Run `git status --short` and record every dirty/untracked path.
3. Stop if any planned file is already dirty. Do not overwrite concurrent work.
4. Bind the starting commit for every later diff gate:

   ```bash
   export POLYMORPHIC_START_COMMIT="$(git rev-parse HEAD)"
   test -n "$POLYMORPHIC_START_COMMIT"
   ```
5. Record three warm `pnpm test:types` timings and their median.
6. Record the current query-engine structure census.
7. Record the current match set for the historical-vocabulary search in Y9;
   acceptance compares additions to this baseline instead of requiring a false
   repository-wide zero.
8. Run:

```bash
pnpm test:types
pnpm test
pnpm package:build
```

9. Stop if a baseline command fails.

Use the repository's memory-capped launchers. Do not bypass them for a large
Vitest selection.

Y3 and Y4 are internal structural checkpoints only: Y3 can create required
private columns before write lowering exists, and Y4 can emit carriers before
strict parsing exists. Neither phase may be released, committed as a complete
feature, or exposed independently. The branch remains one unreleasable feature
until Y0–Y9 pass together.

### 2.2 Change discipline

- Complete phases in order.
- Use `apply_patch` for edits.
- Preserve unrelated files.
- Do not stage or commit unrelated changes.
- Keep one task-level commit after all gates pass.
- Validate untrusted payloads once, at their operation-schema boundary.
- Do not add a downstream runtime guard for an impossible schema shape.
- Do not reparse a schema-transformed nested payload.
- Do not resolve metadata per returned row.
- Add a concept only if the phase's fixed design requires it.
- If a phase needs a strategy object, generic callback protocol, public shadow
  scalar, or extra statement, stop and revise the design.

## 3. Y0 — Resolve product gates and prove the recursive carrier (complete)

### Goal

Make the three product decisions and prove the recursive TypeScript carrier
before building the feature around them. The physical-storage keep gate belongs
at Y6.0, after schema metadata exists.

### Y0.1 Discriminator durability

Approved: stable stored values are configured separately from public map keys.
There is no short-form or implicit public-key fallback in V1.

The concrete recommendation is the exact-key second argument from the design:

```ts
s.polymorphic({ post: () => post, video: () => video }, {
  values: {
    post: "content.post.v1",
    video: "content.video.v1",
  },
})
```

Every target key must occur exactly once in `values`; there is no implicit
public-key fallback under this option.

The decision must define:

- configuration syntax;
- whether absence is rejected (recommended) or deliberately defaults to the
  public key;
- duplicate stored-value rejection;
- migration-differ behavior for rename/add/remove;
- which string appears in query inputs/results (the public key).

V1 physical storage is fixed to portable text/VARCHAR. Do not add enum or
integer storage modes.

### Y0.2 Orphan contract

Approved V1 behavior:

- optional empty storage → `null`;
- optional known type with missing target → `null`;
- required missing target → existing internal `QueryEngineError` with the exact
  message and metadata fixed in the design;
- unknown stored type or half-null pair → integrity error;
- no `nullOnMissing`/`errorOnMissing` option in V1.

No runtime option changes this behavior in V1.

### Y0.3 Inverse write surface

Approved:

- direct connect/create/disconnect;
- inverse create;
- all other direct/inverse relation mutation verbs absent from V1 schemas.

Broad inverse write parity remains outside this plan.

### Y0.4 Isolated recursive-carrier spike

Create:

```text
tests/types/relations/polymorphic-spike.core.types.ts
```

This is a test-local prototype. Define the smallest local relation carrier,
factory, operation projection, and result mapper with an exact map of lazy
target getters and exact value map. Do not export `s.polymorphic` or add
production code in Y0. The spike must exercise the proposed **two-argument call
itself**, not only a separately named map type.

Use self-recursive and mutually recursive model declarations to prove all of
these together:

- the `values` argument is contextually keyed from the target map without
  resolving target model bodies early;
- a missing value key and an extra value key beside a valid key are rejected
  through the proposed call;
- stored values retain their literal types; duplicate stored values are a Y1
  runtime schema-validation error, not an invented compile-time promise;
- non-fresh `targets`, `values`, and projection objects retain exactness rather
  than relying only on excess-property checking;
- the base result is a literal-key discriminated union and not `any`;
- a per-variant explicit projection produces its exact branch shape;
- a configured variant omitted from the projection object keeps its target's
  default scalar projection;
- nested recursive polymorphic projections compile and retain their literal
  discriminators;
- target-node `select`, `include`, and `omit` keep their existing exclusivity
  and result semantics;
- an unknown projection key beside a valid key is rejected;
- ordinary relation inference does not widen to `any`.

The original `() => ({ post, video })` getter-of-map shape did force
`keyof ReturnType<G>` during recursive initialization and collapsed the model
to `any`. The accepted redesign is `{ post: () => post, video: () => video }`:
outer keys are exact immediately, while target model bodies remain lazy. Do not
weaken `values` or projection objects to string index signatures and do not
reintroduce the failed shape in Y2.

If self-reference alone causes the failure, record the exact TypeScript error
and only then introduce P006. If the relation carrier collapses the whole model
to `any`, stop the feature and redesign the carrier.

Delete this spike after Y2's real public call-site probes cover the same
recursive cases. Y0 proves only that the carrier is viable; it does not claim
that a not-yet-exported public API already works.

### Validation

```bash
pnpm test:types
pnpm test:layer:relations
```

### Exit gate

All three decisions are recorded. The exact getter-map two-argument carrier and
its hardest selective recursive result shape pass without `any`, TS2589, or
early getter resolution. Warm type checks were 18.19, 18.48, and 18.73 seconds
(18.48-second median) against the 19.17-second baseline. Y0 is complete.

## 4. Y1 — Schema relation and private storage metadata (complete)

### Goal

Make polymorphism a first-class schema relation while keeping its columns
private.

### Files

| Path | Action |
|---|---|
| `src/schema/relation/polymorphic.ts` | Own the immutable relation/state, `.name()`/`.optional()`, cached target resolution, private-storage types, and inverse binding |
| `src/schema/relation/index.ts` | Export `polymorphic()` |
| `src/schema/index.ts` | Add `polymorphic` to the public `s` factory object |
| `src/schema/model/model.ts` | Store polymorphic relations separately from scalars and ordinary relations |
| `src/schema/model/helper.ts` | Add polymorphic shape/key/map extraction without placing it in `state.scalars` or ordinary `state.relations` |
| `src/schema/hydration.ts` | Hydrate polymorphic field names without resolving targets or registering hidden scalars |
| `src/schema/validation/rules/polymorphic.ts` | Own P001–P005 and P007–P011 at one definition boundary |
| `src/schema/validation/rules/relation.ts` | Reconcile the current R003 inverse rule with a valid polymorphic inverse |
| `src/schema/validation/rules/index.ts`, `model-members.ts`, and `validator.ts` | Register the rules and run the mandatory full definition gate only for schemas containing polymorphism |
| `src/client/client.ts` | After hydration, invoke full definition validation when the schema contains polymorphism |
| `tests/unit/relations/` | Runtime relation-state and inverse-resolution contracts |
| `tests/unit/schema-validation/` | One positive and one falsifying case per rule |

### Rules

- Resolve target thunks lazily.
- Keep hydration pure: register names first, then run full definition validation
  from client construction when the schema contains polymorphism. Ordinary
  schemas keep the current no-op path. Full validation supplies the P rules and
  their prerequisite model invariants from the same `allRules` owner; no guard
  is duplicated in constructors, hydration, migrations, or the query engine.
- Add `AnyModelField = Scalar | AnyRelation | AnyPolymorphicRelation`; update
  every `ModelShape` consumer deliberately. Keep `AnyRelation` and every
  ordinary-relation switch unchanged.
- Keep `ScalarKeys` and ordinary `RelationKeys` narrow. Add
  `PolymorphicRelationKeys`; compose public projectable relation keys from both
  maps only where needed.
- Audit `extractScalarMap` and every equivalent runtime predicate so a
  polymorphic relation cannot fall through a `!isRelation` branch and enter the
  scalar map.
- Snapshot the relation declaration and cache target resolution on that
  immutable declaration. Cache owner-specific storage on the owning model,
  keyed by the polymorphic field. A declaration may therefore be reused by
  `.map()`, `.extends()`, and separate clients without rebinding mutable state.
- Use registered model identity; do not lowercase names.
- Require `targets` and `values` to be plain own-property records with
  `Object.prototype` or null prototypes.
- Require public discriminator keys to pass `isValidSchemaIdentifier`.
- Require stored values to match
  `^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$`; reject duplicates.
- Reject an empty target map; warn, without failing, for exactly one target.
- Require a compatible single-column target primary key. V1 allows only
  `string`, `int`, or `bigint`, rejects arrays, requires the same scalar
  `state.type`, and rejects every native-type override. The first target in
  declaration order supplies `idColumn.scalar`. `s.string().id().uuid()` remains
  valid because auto-generation is not a native override.
- Construct one internal no-native-override `StringScalar` for the type column.
  Existing mapping must produce PostgreSQL/SQLite/libSQL `TEXT` and MySQL
  indexed `VARCHAR(191)`.
- Derive exactly `<relationField>_type`, `<relationField>_id`, and
  `<mappedOwnerTable>_<relationField>_poly_idx`. Validate each with
  `isValidSchemaIdentifier`; reject rather than truncate/hash. Reject every
  collision with declared or generated storage.
- `.name()` remains the existing pairing label, never a model field key. When
  the target owns several polymorphic relations, the inverse label must select
  exactly one of them, even if runtime model identity would leave only one
  source-compatible group. This keeps the public type and runtime rules exact
  when separate model instances have identical structural types. A sole owner
  relation is inferred regardless of a decorative label mismatch.
- An inferred inverse must have exactly one candidate.
- Permit repeated target-model aliases for direct-only use. Reject inverse
  binding if its source model occurs more than once in that target map.
- Teach `relationHasInverse` (R003) that an ordinary inverse `oneToMany` can be
  paired with a polymorphic owner. Do not require a phantom ordinary
  `manyToOne` on the child. `SR001`/`selfRefValidInverse` no longer exist and
  are not part of this implementation.
- Leave `GetInverseRelationMap`/`getInverseRelationMap` unchanged. Add
  `GetPolymorphicInverseBinding` plus a runtime sibling in
  `src/schema/relation/polymorphic.ts`. The type-level result returns the
  selected relation key; the runtime result also returns the exact public and
  stored discriminator values. Neither is an FK tuple.
- Keep that type-level relation-key binding, runtime nested-create omission in
  `src/validation/relations/create.ts`, and schema-rule scan on the same
  owner-group/pairing-label/member semantics.
- Update CM004 so valid generated storage is not reported as a manual pattern.
- Do not add required polymorphic edges to CM002. CM002 models physical-FK
  insert dependencies; a polymorphic OR-edge has no database FK. Self and
  mutual required polymorphism are legal, P006 remains unused, and a concrete
  create graph must terminate through connect or inverse parent injection.

For a string target id on MySQL, both indexed text columns normalize to at most
191 utf8mb4 characters, so the composite key occupies at most 1,528 bytes under
the supported 3,072-byte InnoDB key limit. Add a provider DDL witness; do not
assume this arithmetic without exercising the configured MySQL image.

Boundary tests must include a 191/192-character stored value, an
`Object.prototype` public key, an empty value, duplicate stored values, a native
target-id override, a valid generated 63-byte name, a 64-byte generated name,
and a collision with a mapped scalar column and declared index.

### Keep gates

- No public scalar count/default-select change.
- No module-level mutable registry.
- No eager traversal that breaks circular declarations.
- No new generic base relation class.

### Validation

```bash
pnpm test:layer:relations
pnpm test:layer:schema-validation
pnpm test:types
```

## 5. Y2 — Operation schemas and public typing (complete)

### Goal

Make every public input exact, correlated, and schema-transformed once.

### Files

| Path | Action |
|---|---|
| `src/validation/relations/polymorphic/` | Add filter, create, update, select/include factories |
| `src/validation/builder.ts` | Build and cache a separate multi-target polymorphic schema bundle |
| `src/validation/model/index.ts` | Compose the third bundle into only the approved operation paths |
| `src/validation/relations/index.ts` | Export the factories |
| `src/validation/model/core/create.ts` | Merge required/direct polymorphic create entries and the inverse-owned omission |
| `src/validation/model/core/update.ts` | Merge direct polymorphic update entries |
| `src/validation/model/core/where.ts` and `filter.ts` | Merge correlated polymorphic filters |
| `src/validation/model/core/select.ts` | Merge polymorphic select/include and count entries |
| `src/validation/relations/index.ts` | Detect a polymorphic inverse and replace its create/update bundles with nested create only |
| `src/validation/relations/create.ts` and `update.ts` | Refuse independently built nested scalar-only `createMany` for required polymorphic targets |
| `src/validation/relations/create-many-availability.ts` | Own the shared runtime/type refusal for scalar-only bulk creation |
| `src/validation/model/args/mutation.ts` | Make scalar-only `createMany` unavailable when the target model has a required direct polymorphic relation |
| `src/client/omit.ts` | Apply client-level omit defaults inside every configured polymorphic target |
| `src/client/types.ts` | Carry exact operation args through the public operation call |
| `src/client/result-types.ts` | Infer exhaustive per-variant result unions |
| `tests/unit/relations/` | Parse accept/reject matrix |
| `tests/unit/operation-schemas/` | Whole-operation schema tests |
| `tests/types/relations/polymorphic-*.core.types.ts` and `tests/types/client/polymorphic-result.core.types.ts` | Public carrier, operation-schema, bulk-refusal, and result probes |

### Exact accepted shapes

The registry keeps ordinary and polymorphic schema bundles separate. Operation
builders merge only the approved polymorphic path for that operation. A direct
polymorphic field does not thereby acquire ordinary `_count`, `orderBy`, or
broad relation mutation verbs. This is schema composition, not a claim that
`PolymorphicRelation` is `AnyRelation`.

Extend `getCreateRequirementKeySets` in `core/create.ts` with one
`[[polymorphicRelationName]]` group for each required direct polymorphic field.
Unlike an ordinary parent-held FK, there is no public scalar alternative. For an
inverse nested create, `validation/relations/create.ts` must omit that exact
child relation key from the target's full create schema; it must not pretend a
hidden id column is an omitted scalar FK. Keep the runtime omission and the
type-level key calculation on the same inverse-member resolver introduced in
Y1.

Root and nested `createMany` stay scalar-only. If the target model contains a
required direct polymorphic relation, expose an inferred `never` input at the
public type boundary and a rejecting runtime args/data schema before query
planning. Use this exact message, naming the first required polymorphic field in
model declaration order:

```text
createMany is not available for model '<model>' because required polymorphic relation '<relation>' cannot be supplied by a scalar-only bulk row. Use create instead.
```

Do not require a relation envelope inside a bulk row and do not rely on the
database's `NOT NULL` error. A model whose polymorphic relations are all
optional retains its current scalar-only `createMany`; omitted private columns
store null. Apply the same refusal to the independently built root and nested
create-family/update-family `createMany` row schemas.

Create-family relation value:

```ts
{ connect: { type, where } } | { create: { type, data } }
```

Update-family relation value:

```ts
{ connect: { type, where } } | { disconnect: true }
```

Filter:

```ts
null | { type } | { type, is } | { type, isNot }
```

The `null` member is present only when the relation is optional.

Include/select:

```ts
false | true | { [publicType]?: true | { select?; include?; omit? } }
```

Each target node reuses the ordinary rule that `select` is exclusive with
`include` and `omit`. Omitted configured variants keep their default scalar
projection; the object does not filter target types.

### Required schema tests

- connect and create together;
- two target intents in one payload;
- `type` not in the configured map;
- a post discriminator with a video selector/data/filter;
- flat `{ type, id }` connect;
- `is` or `isNot` without `type`;
- `is` and `isNot` together with a valid `type`;
- `null` filter on a required polymorphic relation;
- update-through, set, upsert, and connectOrCreate;
- disconnect on a required relation;
- reject a required direct polymorphic relation omitted from a direct create;
- accept an omitted optional direct polymorphic relation; CREATE omits both
  private columns and lets nullable storage remain empty rather than emitting
  explicit null assignments;
- accept that same field as omitted inside its own inverse nested create because
  the parent injects it;
- inverse write object exposes `create` but rejects connect, createMany,
  disconnect, delete, update, set, upsert, and connectOrCreate;
- root and unrelated-relation nested `createMany` are type/runtime unavailable
  for a target model with a required polymorphic field, but remain available
  when all polymorphic fields are optional;
- unknown selective include key beside a valid key;
- select/include/omit exclusivity inside one target projection;
- `false` omits the whole relation while omitted keys inside a projection object
  retain their target's default scalar projection;
- equivalent errors through non-fresh variables.

The type suite must now repeat Y0's recursive cases through a real exported
driver/package call. Put each typo beside a valid key and cover a non-fresh
object. Delete `polymorphic-spike.core.types.ts` only after these public probes
pass.

Root upsert reuses the model create/update schemas. Add whole-args tests proving
that its create arm accepts the V1 create intents and its update arm accepts the
V1 update intents. This phase validates both public arms as today. The current
shell may construct arm planning/compiler state eagerly; Y6 preserves that
allocation behavior while proving that legality callbacks and emitted effects
belong only to the taken arm.

Do not add `v.discriminatedUnion()` solely for this feature. Compose existing
validation primitives unless a second independent consumer already needs the
same primitive.

### Validation

```bash
pnpm test:layer:operation-schemas
pnpm test:layer:relations
pnpm test:layer:client
pnpm test:types
```

## 6. Y3 — Migration snapshot and DDL (complete)

### Goal

Serialize relation-owned storage without pretending it is public scalar state.

### Files

| Path | Action |
|---|---|
| `src/migrations/serializer.ts` | Emit the two columns, nullability, composite index, and stored discriminator metadata |
| `src/migrations/types.ts` | Add optional non-SQL polymorphic metadata, `PolymorphicMemberHistoryChange`, its resolver, and `GenerateOptions.polymorphicMemberResolver` |
| `src/migrations/differ.ts` | Keep structural column/index diffing only; do not compare polymorphic history metadata |
| `src/migrations/generate/index.ts` | Invoke the sole history comparator and persist metadata-only snapshots even when `DiffOperation[]` is empty |
| `src/migrations/generate/polymorphic-history.ts` | Sole owner of snapshot member comparison and explicit acknowledge/reject resolution; never produce DML or a `DiffOperation` |
| `src/migrations/push/planner.ts` | Diff live structure only and document that introspection has no discriminator history |
| Existing migration drivers | Receive private columns/indexes through the normal serializer output; no polymorphic DDL operation is added |
| `tests/unit/migrations/` | Serializer, differ, DDL, and recreation cases |
| `tests/types/migrations/` | Public migration typing only if the configuration surface changes |

### Invariants

Use this exact resolution boundary:

```ts
interface PolymorphicSnapshotMember {
  readonly publicType: string;
  readonly storedType: string;
  readonly targetTable: string;
  readonly referencedColumn: string;
}

interface PolymorphicMemberHistoryChange {
  readonly kind:
    | "storedValueChanged"
    | "memberRemoved"
    | "memberRetargeted";
  readonly ownerTable: string;
  readonly relation: string;
  readonly typeColumn: string;
  readonly from: PolymorphicSnapshotMember;
  readonly to: PolymorphicSnapshotMember | undefined;
  readonly description: string;
  acknowledgeMigrated(): "acknowledged";
  reject(): "reject";
}

type PolymorphicMemberResolver = (
  change: PolymorphicMemberHistoryChange
) =>
  | "acknowledged"
  | "reject"
  | undefined
  | void
  | Promise<"acknowledged" | "reject" | undefined | void>;
```

Absence, `undefined`, `void`, or `reject()` is refusal. Only
`acknowledgeMigrated()` advances history. Do not fold this into column-rename or
enum-value mapping: it neither emits a `DiffOperation` nor supplies replacement
DML.

`generate/index.ts` invokes the history comparator only after structural
ambiguous changes have been resolved. It passes the accepted `renameTable` and
`renameColumn` operations. The comparator first normalizes the previous owner
table, private type/id columns, target tables, and referenced columns through
those rename operations; a resolved physical rename is not a member retarget.
It does not discover or resolve structural renames itself. It compares members
only for a storage descriptor present in both snapshots after normalization.
Descriptor pairing uses the normalized owner table plus normalized private type
and id column names, never the public relation key. Thus an accepted relation
field rename accompanied by both accepted private-column renames still reaches
member-history comparison. Adding or dropping the entire storage remains solely
a structural diff and does not trigger a duplicate history acknowledgement.

`targetTable` and `referencedColumn` are resolved physical SQL names. They are
never model field keys. Before comparison, apply every accepted structural
`renameTable` and `renameColumn` operation to the previous member. The history
algorithm therefore compares the post-rename physical target.

`polymorphic-history.ts` then owns this exact matching algorithm:

1. For each previous member, first find a desired member with the same
   `storedType`.
2. If found and `targetTable` or `referencedColumn` changed after rename
   normalization, emit
   `memberRetargeted`; a public-key rename alone is safe.
3. If no same-stored-value member exists, find the same `publicType`. If its
   `targetTable` and `referencedColumn` are unchanged, emit
   `storedValueChanged`; otherwise emit `memberRetargeted`.
4. If neither identity exists, emit `memberRemoved`.
5. Every unmatched desired member is a safe addition.

This module compares history once. `differ.ts` continues to compare only
physical tables, columns, indexes, and constraints.

- Generated columns are stable in snapshots.
- Required relation: both columns non-null.
- Optional relation: both nullable; ORM writes remain atomic and strict reads
  reject externally introduced half-null state.
- Do not add a database CHECK in V1. `TableDef`/`DiffOperation` have no portable
  check-constraint primitive, and the strict result boundary owns corruption
  detection.
- Composite index order is `(type, id)`.
- No cross-target foreign key is emitted.
- Adding a target emits no DDL but updates `meta/_snapshot.json` when not dry
  running. It creates no migration file or journal entry and reports a
  metadata-only snapshot update.
- Renaming a public key while retaining its stored value is metadata-only.
- Removing or renaming a stored value, or retargeting an unchanged stored value
  to another table/referenced field, is refused by default. The dedicated
  resolver can advance the snapshot only after the caller explicitly attests
  that separate DML migrated or removed affected rows. V1 generates no DML.
- `push()` can create/drop physical storage but cannot infer historical aliases
  from an introspected text column. It neither claims nor tests such detection;
  push users treat stored member mappings as immutable and migrate data first.
- Target PK width/canonicalization cannot truncate.
- Ordinary schema snapshots are unchanged.

### Validation

```bash
pnpm test:layer:migrations
pnpm test:types
```

Required cases include first create, ordinary no-op, target add with zero SQL,
public-key rename with stable value/member, stored-value rename rejected,
unchanged stored value retargeted to another table rejected, referenced-field
retarget rejected, acknowledged snapshot advance, dry-run no write, and push's
documented history limitation.

## 7. Y4 — Read metadata, include SQL, and direct filters (complete)

### Goal

Compile direct polymorphic reads as one portable statement without touching
ordinary relation fast paths.

### Files

| Path | Action |
|---|---|
| `src/query-engine/types.ts` | Add resolved read metadata, not execution policy |
| `src/query-engine/context/query-scope.ts` and `context/index.ts` | Add cached polymorphic field lookup beside ordinary relation lookup |
| `src/query-engine/builders/polymorphic-relation.ts` | Resolve direct members to `ResolvedPolymorphicEdge` and inverse bindings to `ResolvedPolymorphicInverse`; never coerce one into the other |
| `src/query-engine/builders/select-builder.ts` | Discover polymorphic select/include fields and delegate |
| `src/query-engine/builders/where-builder.ts` | Discover polymorphic filters and delegate |
| `src/query-engine/builders/polymorphic-read-builder.ts` | Own CASE arms and direct target predicates while reusing the existing nested selection/query builders |
| `src/query-engine/write-engine/shared.ts` | Classify polymorphic projections and traverse their target tables for fold legality |
| `src/query-engine/operations/mutation-projection-fold.ts` | Carry required private type/id columns through the mutation CTE |
| `src/adapters/database-adapter.ts`, `shared/standard-sql.ts`, and the PostgreSQL/MySQL/SQLite adapters | Supply generic CASE/JSON-boolean syntax only; no polymorphic semantic namespace |
| `tests/contracts/engine/query/` | SQL/parameter/statement-count contracts |

### Include algorithm

For each configured member in declaration order:

1. allocate a child alias/scope for that target;
2. compile the target-specific nested selection with existing builders;
3. correlate the target primary key to the hidden id column;
4. wrap `{ type: publicType, data: targetJson }`;
5. add a CASE arm guarded by
   `adapter.operators.exactTextEq(typeColumn, storedType)`.

Handle in this order:

- both storage columns null → SQL null;
- exactly one storage column null → a reserved `invalid` carrier;
- known type with existing or absent target → a reserved `linked` carrier with
  public `type` and target `data`;
- unknown storage → a reserved `invalid` carrier containing only the
  diagnostic storage facts required by the strict parser.

Own the reserved carrier tag in the result alias/constants module. The parser
removes it; it never enters the public result type.

Use correlated scalar subqueries for V1. Do not route polymorphic includes
through ordinary LATERAL selection. Confirm that ordinary relations still use
their existing LATERAL capability path.

### Direct filter algorithm

- `{ type }`: exact type predicate.
- `{ type, is }`: exact type AND target EXISTS.
- `{ type, isNot }`: exact type AND target NOT EXISTS.
- `null`: both physical columns null.

Compile nested where under the selected target's `QueryScope`.

### Mutation-result fold rules

- `selectProjectsRelation` returns true for a selected polymorphic field, so it
  cannot enter scalar-only direct `RETURNING`.
- A CTE-folded polymorphic projection appends only its required hidden type/id
  columns after all public scalar columns, in relation declaration order.
- The outer result projection consumes those CTE columns but never exposes them.
- `payloadReachesTable` visits every configured variant for an include/select
  projection, including omitted override keys that use default projection. A
  type-correlated where visits only its selected variant.
- A self-polymorphic reachable target declines the fold; the current terminal
  read fallback remains unchanged.

### Static gates

```bash
rg -n "polymorphic" src/query-engine/write-engine/routing.ts \
  src/query-engine/write-engine/parse-boundary.ts
```

It must return no relation-specific branch.

```bash
rg -n "adapter\\.polymorphic" src
```

It must return no match.

### Validation

```bash
pnpm test:layer:query-engine
pnpm test:layer:adapters
pnpm test:types
```

Required new contracts:

- one statement with one CASE arm per variant;
- stable public/stored discriminator mapping;
- exact-text discriminator comparison on MySQL;
- target-specific nested select/include;
- omitted per-target projection keys fall back to that target's default scalar
  projection and keep the union exhaustive;
- create/update/delete/upsert scalar mutation result plus polymorphic include;
- polymorphic select through the CTE fold with private columns absent publicly;
- self-polymorphic projection declines the fold and returns the unfolded truth;
- orphan and invalid-storage envelope SQL;
- normal ordinary-relation plan snapshots unchanged;
- no extra query or round trip.

## 8. Y5 — Strict polymorphic result shape and parser (complete)

### Goal

Never return unvalidated target JSON and never force one target model through an
ordinary relation parser.

### Files

| Path | Action |
|---|---|
| `src/query-engine/types.ts` | Add `ExpectedPolymorphicResultShape` and a separate map on `ExpectedResultShape` |
| `src/query-engine/result/result-shape.ts` | Build one shape for every configured variant, using its explicit override or default projection |
| `src/query-engine/result/ResultParser.ts` | Build/cache a polymorphic relation decode chain before strict parsing |
| `src/adapters/adapter-result-parser.ts` | Define `RelationResultKind = RelationType \| "polymorphic"` on the existing `parseRelation` hook |
| `src/adapters/databases/postgres/postgres-adapter.ts` | Change the explicit `parseRelation` kind annotation to `RelationResultKind`; keep native-JSON passthrough |
| `src/adapters/databases/mysql/mysql-adapter.ts` | Change the explicit annotation and keep the existing JSON-text decoder byte-identical |
| `src/adapters/databases/sqlite/sqlite-adapter.ts` | Change the explicit annotation and keep passthrough behavior byte-identical |
| `src/drivers/driver-instrumentation.ts` | Carry the same kind through `DriverResultParser.parseRelation` |
| `src/query-engine/result/polymorphic-result-parser.ts` | Parse the internal carrier and dispatch target data to the existing row parser |
| `src/query-engine/result/result-parser-contract.ts` | Add a separate `parsePolymorphic` callback; do not widen `parseRelation(AnyRelation, ...)` |
| `src/query-engine/result/result-row-parser.ts` | Resolve keys against scalar, ordinary-relation, then polymorphic maps without weakening key checks |
| `tests/contracts/engine/query/` | Strict result-parser and architecture contracts |
| `tests/types/query-engine/` | Result type contracts if internal expected shapes are exported |

### Parser cases

- valid post/video/photo envelopes;
- valid internal linked carrier with its tag stripped from the public result;
- per-variant selected scalar keys;
- per-variant nested ordinary relations;
- nested polymorphic relation;
- unknown discriminator;
- absent outer value;
- malformed envelope;
- non-object data;
- `data: null` for optional/required relations;
- half-null/unknown storage marker;
- malformed or unknown internal carrier tag;
- unexpected or missing target result keys;
- scalar destination parsing for each target.

The adapter/driver middleware extension is a kind-union change to an existing
decode hook. Export/import `RelationResultKind` rather than repeating a local
union. Change the callback and `next` signatures together in
`DriverResultParser`; do not cast the new kind through `RelationType`. It is not
a new method or execution protocol. MySQL and SQLite must decode JSON text
before carrier validation; PostgreSQL passes native JSON through. The strict
parser never sniffs arbitrary strings itself.

`ResultParser` caches the polymorphic decode chain by the concrete
`PolymorphicRelation` object. `RowValueParsers.parseRelation` remains typed to
`AnyRelation`; `parsePolymorphic` is a separate result-layer callback so the
code does not lie that one multi-target relation has one ordinary target model.

Required missing targets use the existing internal `QueryEngineError` with
message `Polymorphic relation '<relation>' references a missing '<type>' record.`
and metadata `{ model, relation, type }`. Unknown type, malformed carrier, and
half-null storage use `malformedResult`; do not add or publicly export a
dedicated orphan-error class.

Use the approved Y0 orphan semantics exactly. Do not return plausible partial
data after a parse failure.

### Validation

```bash
pnpm test:layer:query-engine
pnpm test:types
```

## 9. Y6 — Direct writes through the current record compilers (complete)

### Goal

Lower a validated direct mutation to one concrete target and one atomic private
storage assignment.

### Files

| Path | Action |
|---|---|
| `src/query-engine/builders/relation-mutation-parser.ts` | Recognize polymorphic keys, preserve parse-once semantics, return targeted program or targetless disconnect in the companion map |
| `src/query-engine/builders/polymorphic-mutation.ts` | Resolve discriminator, build coherent concrete `RelationInfo`, and create storage assignment data |
| `src/query-engine/builders/values-builder.ts` | Lower explicit polymorphic storage assignments during INSERT |
| `src/query-engine/builders/set-builder.ts` | Lower explicit polymorphic storage assignments during UPDATE |
| `src/query-engine/write-engine/fragment-builders.ts` | Add a destination-scalar entry point for deferred private values; keep the ordinary model/field API delegating to the same literal/cast owner |
| `src/query-engine/write-engine/CreateOperation.ts` | Interpret resolved direct programs and fold storage into the root insert |
| `src/query-engine/write-engine/RecordUpdateCompiler.ts` | Count polymorphic storage as root work, interpret resolved programs, and fold storage into the selected root update |
| `src/query-engine/write-engine/UpdateOperation.ts` | Build root parsed polymorphic companions at the current transform sites |
| `src/query-engine/write-engine/UpsertOperation.ts` | Feed taken create/update arms through the same lowerers without disturbing shell folds |
| `src/query-engine/write-engine/foreign-key-reference.ts` | Reuse current final-source resolution for the id leg; add no source kind unless unavoidable |
| `src/query-engine/OwnWriteAnalyzer.ts`, `OwnWriteRelation.ts`, and `RelationMembership.ts` | Consume the concrete edge/program; change membership identity only if a falsifying overlap test proves it necessary |
| `tests/contracts/engine/query/relation-mutation-program.core.test.ts` | Lowering order/duplicate/parse-once contracts |
| `tests/contracts/engine/write/` | Transaction and atomic-batch plan contracts |

### Y6.0 Physical-storage keep gate

Before migrating any operation, implement the smallest permanent assignment
channel and compile one INSERT and one UPDATE:

- user scalar fields remain the only public scalars;
- both hidden columns appear in SQL;
- parameter order is user scalars, existing ordinary derived FKs, then each
  polymorphic field's type and id in model declaration order;
- descriptor scalars own canonicalization and destination casts;
- private values use the new scalar-object destination path; no hidden name is
  looked up through `model.state.scalars`;
- `referencedField` resolves the source independently of the destination;
- disconnect sets both columns to null;
- a one-leg assignment is unrepresentable;
- an ordinary INSERT/UPDATE control is byte-identical.

Cover literal, planning-field, final-ref, transitioned-planning-field, and
lookup id sources. A transition reads the old referenced field and writes the
transformed value. The polymorphic lowerer constructs the temporary
`ForeignKeyMember` from its storage value and calls the unchanged resolver;
callers do not pass a second field name. Remove the unit if it requires public
shadow scalars, arbitrary physical keys, a caller-supplied field-name override,
or adapter execution changes.

### Parse-once rule

- `partitionModelData` distinguishes scalar, ordinary relation, and polymorphic
  relation keys without interpreting mutation kinds.
- At each current relation-schema transform site, transform once and immediately
  resolve/build the program.
- `buildParsedRelationPrograms` handles already-parsed fresh subtrees.
- Root Update keeps its current one-transform/error-order sites.
- Do not change `write-engine/routing.ts`.
- Do not change the model-blind `write-engine/parse-boundary.ts`.
- Preserve the shell's existing eager arm planning/compiler construction and
  whole-argument schema-validation timing. Do not run an untaken arm's legality
  callback or emit any of its SQL/effects.

For root upsert, “untaken” applies after existing whole-argument schema
validation and eager compiler construction: do not run OwnWrite legality or
emit SQL/effects for the untaken arm. Keep top-level `ON CONFLICT` and
probe-first optimizations in the operation shell.

Teach the existing arm relation-field detector that a polymorphic field is a
relation-bearing arm. Scalar-only upserts keep their byte-identical
`ON CONFLICT` fold. An arm containing a polymorphic mutation declines that fold
and uses the existing probe-first record-compiler route; do not teach the
one-statement fold to execute nested target work or private lookups.

### Physical-column rule

- The neutral SQL builders receive only resolved
  `PolymorphicStorageValue<unknown>` values.
- A program present in the polymorphic companion is intercepted before ordinary
  `bindRelation`/FK assignment. Its coherent `RelationInfo` is only the
  target-compilation view; hidden storage is never represented as ordinary
  `foreignFields`.
- They resolve column names and scalar casts from `PolymorphicStorage`.
- They never call `getColumnName(ownerModel, hiddenName)` or look in
  `ownerModel["~"].state.scalars` for either hidden column.
- The ordinary nullable-FK scan does not validate a hidden field. Required versus
  optional legality is already owned by the polymorphic schema/storage
  descriptor.
- Bulk `createMany`/`updateMany` builders remain unchanged because V1 exposes no
  polymorphic relation payload in a bulk row. Y2 makes `createMany` unavailable
  before planning when the target model has a required polymorphic relation;
  optional private columns may be omitted and store null.

### Connect

Reuse the current concrete target selector/existence behavior. The final root
record assignment is:

```ts
{
  kind: "linked",
  storage,
  storedType,
  referencedField,
  id: <literal or lookup/ref source>,
}
```

Target-not-found, replacement, guard raceability, and retry behavior remain
owned by the existing branch compiler.

The targeted companion holds the coherent edge and its ordinary connect
program. The same program reference appears in `relations`.

### Create

Compile the target with `CreateOperation`. Request its referenced primary-key
source and link it with the stored discriminator. Generated identity behavior,
root race pins, and descendants remain unchanged.

The targeted companion holds the coherent edge and its ordinary create program.

### Disconnect

Emit:

```ts
{ kind: "empty", storage }
```

The root UPDATE sets both physical columns to null. Required relations never
receive this intent because their schema excludes disconnect. Do not create a
synthetic `RelationInfo`, choose an arbitrary member, or read the current
discriminator.

Before allocating its target-read or write IDs, `RecordUpdateCompiler` must use
this complete no-op predicate:

```ts
const isNoop =
  Object.keys(parsed.scalarData).length === 0 &&
  Object.keys(parsed.relations).length === 0 &&
  Object.keys(parsed.polymorphic).length === 0;
```

Only this state returns `undefined`. A disconnect-only companion is root work
even though it has no `RelationMutationProgram` or Part. Preserve the current
zero-step behavior for a genuinely empty update.

### OwnWrite falsification

Before changing membership identity, test:

- two polymorphic fields pointing at the same target model;
- two direct-only discriminator keys mapping to the same target model;
- self-polymorphic nested create;
- sibling writes with the same id but different type.

If the existing holder/field identity distinguishes every accepted V1 case, do
not add discriminator state to OwnWrite. If one accepted case aliases, add the
discriminator at the single membership owner and prove the old shape fails.

### Compatibility witnesses

For transaction and atomic-batch compilation, assert:

- scalar owner create + connect;
- nested owner create + connect;
- create target with explicit id;
- create target with generated id;
- relation-bearing target create;
- owner update connect;
- owner update disconnect;
- disconnect as the only root work, with one UPDATE and unchanged step-ID
  allocation in transaction and atomic-batch modes;
- root upsert with a disconnect-only taken update arm, while the untaken create
  arm remains inert after whole-argument validation;
- a genuinely empty update still allocates no step and emits no SQL;
- root upsert create arm taken and update arm taken;
- root upsert untaken arm has no OwnWrite legality, SQL, or effects; current
  eager compiler construction and step allocation remain unchanged;
- compound unique selector locating a single-column target PK;
- connect target replacement race;
- create race pin;
- parameter order: user scalars, ordinary derived FKs, then polymorphic type/id
  pairs in model declaration order;
- zero extra statements;
- ordinary relation plan snapshots unchanged.

### Static gates

```bash
rg -n "polymorphic" \
  src/query-engine/write-engine/routing.ts \
  src/query-engine/write-engine/parse-boundary.ts
```

No matches.

```bash
rg -n "commentable_(type|id)" src/query-engine
```

No hard-coded example field name. Builders consume descriptors.

### Validation

```bash
pnpm test:layer:query-engine
pnpm test:layer:operation-schemas
pnpm test:types
```

## 10. Y7 — Inverse reads and inverse nested create (complete)

### Goal

Make inverse membership one centrally owned `(type, id)` predicate and support
only the safe V1 write.

### Files

| Path | Action |
|---|---|
| `src/query-engine/builders/correlation-utils.ts` | Compose ordinary id correlation with exact stored discriminator |
| `src/query-engine/builders/include-builder.ts` | Consume the central predicate for inverse include |
| `src/query-engine/builders/relation-filter-builder.ts` | Consume it for `some`/`every`/`none` |
| `src/query-engine/builders/relation-count-builder.ts` | Consume it for inverse count |
| `src/query-engine/builders/polymorphic-relation.ts` | Resolve/cache `ResolvedPolymorphicInverse` and reject repeated-model ambiguity |
| `src/query-engine/write-engine/CreateOperation.ts` | Extend `FreshRecordBuilder` input with `incomingPolymorphicStorage: readonly PolymorphicStorageValue<FinalReferenceSource>[]` and merge it into the child root INSERT |
| `src/query-engine/write-engine/RecordUpdateCompiler.ts` | Pass the same incoming storage into inverse creates below an already selected parent |
| `src/query-engine/write-engine/foreign-key-reference.ts` | Reuse parent id provenance for the id source |
| `src/query-engine/OwnWriteAnalyzer.ts` | Include the inverse child create in the enclosing preflight without reanalyzing a parsed subtree |
| `tests/contracts/engine/query/` | Predicate-presence contracts |
| `tests/contracts/engine/write/` | Inverse create transaction/batch contracts |
| `tests/types/relations/polymorphic.core.types.ts` | Public inverse include/filter/create surface through real client calls |

### Read rules

Every inverse:

- include;
- `some`;
- `every`;
- `none`;
- count;

must contain both:

```text
child.poly_id = parent.pk
child.poly_type = fixed stored value
```

Preserve conjunct order in plan contracts.

### Write rule

Inverse nested create passes one linked assignment into the fresh child:

- the linked storage value's `id` is the parent's existing planning/final
  reference;
- `referencedField` is the source model field fixed by the inverse member;
- `storedType` is fixed by the source variant;
- both columns are emitted in the child root INSERT.

The child create schema must not accept or require its direct polymorphic field
on this path. The parent binding is the sole owner of that edge.

The exact same fresh-child input is used from both record compilers:
`CreateOperation` for a fresh parent and `RecordUpdateCompiler` for an already
selected parent. The latter must not bypass OwnWrite or rebuild the parsed child
tree. This is one inverse-create path with two existing parent identity states,
not two implementations.

V1 exposes inverse `oneToMany` only. Do not infer or synthesize inverse
`oneToOne`; portable uniqueness across heterogeneous target tables is outside
this feature.

Cover all existing `FinalReferenceSource` parent-identity states:

- fresh parent with explicit id;
- fresh parent with generated id;
- already located parent;
- parent primary-key transition, where the child writes the new id while any
  planning correlation still reads the old id.

No inverse update/connect/disconnect/delete/set/upsert path is added. Those keys
must remain absent from the schema, not rejected later in a Part.

### Wrong-row witness

Create two target rows with the same id under different discriminator values.
Prove inverse include/filter/count and nested create observe only the fixed type.

### Validation

```bash
pnpm test:layer:query-engine
pnpm test:layer:operation-schemas
pnpm test:layer:relations
pnpm test:types
```

## 11. Y8 — Provider contract, cache, and instrumentation audit (complete)

### Goal

Prove execution parity through the rebuilt contract estate and change
cross-cutting layers only where the new relation actually enters an existing
contract.

### Provider contract

The shared contract is implemented at:

```text
tests/contracts/drivers/behaviors/polymorphic-relation-behavior.ts
```

It exports `polymorphicRelationContract = defineContract(...)`. Its generated
name/id is registered in `tests/contracts/drivers/contract-ids.ts` and
`tests/providers/matrix.ts`, and the contract is imported by:

- `tests/providers/local/pglite.test.ts`;
- `tests/providers/local/sqlite3.test.ts`;
- `tests/providers/local/libsql.test.ts`;
- `tests/providers/docker/pg.test.ts` or the canonical PostgreSQL fixture named
  by the matrix;
- `tests/providers/docker/mysql2.test.ts`.

Do not hand-create a parallel provider runner. The architecture matrix must see
one contract definition, one ID, and an explicit run or waiver for every
provider. The behavior must cover:

- migration/push of generated storage;
- direct connect/create/disconnect;
- inverse create;
- direct include/filter;
- selective nested include;
- inverse include/filter/count;
- optional empty relation;
- approved orphan behavior;
- wrong-row same-id/different-type decoy;
- generated target identity;
- exact discriminator values;
- no N+1 behavior observable from operation instrumentation.

The PGlite, SQLite3, libSQL, PostgreSQL, and MySQL2 fixtures are wired and their
full provider projects passed on 2026-08-08. D1/hosted/Bun providers carry the
matrix's explicit fixture-capability waiver; they are not silently omitted.

### Cache audit

No polymorphic-specific cache code was added. Query arguments continue to feed
the existing deterministic key hashing, and the feature does not invent a new
cross-model invalidation rule beyond the ordinary relation contract.

- Query arguments already feed deterministic key hashing; add special handling
  only if two distinct polymorphic include shapes collide.
- Do not invent cross-model invalidation solely for polymorphism if ordinary
  relation includes have the same existing limitation.
- If relation metadata is part of a current dependency graph, add polymorphic
  targets at that existing owner and test it there.

### Instrumentation audit

Existing build/execute spans continue to record model, operation, SQL, and
parameters according to configuration. The existing relation-result kind is
widened through the driver parser hook; no polymorphic-specific span attribute
or hot-path per-row tracing was added.

### Validation

```bash
pnpm test:layer:drivers
pnpm test:layer:cache
pnpm test:layer:instrumentation
pnpm test:all
pnpm test:types
```

## 12. Y9 — Performance, architecture, documentation, and final gate (complete)

### Performance contracts

Add or extend current engine/provider contracts to prove:

- polymorphic include is one SQL statement;
- SQL size depends on configured variants, not row count;
- no direct write adds a statement;
- inverse lookup uses `(type, id)` index on PostgreSQL EXPLAIN;
- MySQL discriminator equality is byte/exact;
- normal relation LATERAL plans are unchanged;
- existing direct/RETURNING/ON CONFLICT/CTE/batch performance suites remain
  green.

For PostgreSQL and MySQL, capture plans with three and eight configured
variants. Prove that only the selected CASE arm executes for each row, inverse
lookups use `(type, id)`, metadata is resolved once during compilation rather
than per row, and declining a mutation fold adds no round trip. These plan
witnesses complement statement-count and SQL-size checks; they do not replace
them.

Compare three warm final `pnpm test:types` runs with Y0. Median regression must
not exceed 10%. If it does, simplify recursive or distributive public types
before finalization.

### Architecture gates

Add AST/source contracts that prove:

- no runtime import cycle was introduced in `write-engine`;
- no polymorphic branch exists in `routing.ts` or `parse-boundary.ts`;
- hidden storage is absent from public scalar state;
- unsupported verbs are absent from operation schemas;
- no new runtime step kind;
- no adapter semantic polymorphic namespace;
- no source-kind switch was duplicated outside its current provenance owner;
- normal relation compiler snapshots remain unchanged.

### Documentation

Update:

- root/schema/query-engine/migrations `AGENTS.md` files only where durable
  architecture changed;
- `docs/content/docs/internals/query-engine.mdx`;
- public relation/query documentation;
- both feature documents with final decisions and actual file paths.

Document:

- public discriminator versus stored discriminator;
- private storage and lack of database FK;
- V1 mutation surface;
- orphan behavior;
- exact inverse correlation;
- performance/index requirements;
- migration procedure for discriminator changes.

### Final validation

Run in this order:

```bash
pnpm test:types
pnpm test
pnpm package:build
pnpm test:all
pnpm test:providers
```

`pnpm test:all` must execute the PGlite, SQLite3, and libSQL contract legs.
PostgreSQL and MySQL Docker legs are mandatory before the feature is called
complete or the final commit is created: configure both provider connection
strings and verify the canonical contract actually ran. Hosted Neon,
PlanetScale, D1, and Bun fixture waivers may remain visible. If Docker is
unavailable, stop finalization and report the implementation as locally green
but release-blocked; do not report or commit it as complete.

Run the three warm final type checks after all code and docs are stable.

### Final static gates

The repository already contains deliberate historical vocabulary. Y0 records
the baseline match set; acceptance forbids **added** production/doc lines rather
than pretending the baseline is empty:

```bash
git diff --unified=0 "$POLYMORPHIC_START_COMMIT" -- src docs/content \
  | rg '^\+.*(query-engine-v2|QueryContext|result-flow\.ts|parent-reference\.ts)'
```

That command must return no added match. Use AST/source architecture contracts,
not broad text search, to prove that `routing.ts` and `parse-boundary.ts` gained
no polymorphic branch and that write-engine runtime imports remain acyclic.

These newly forbidden symbols must have zero production definitions/usages:

```bash
rg -n "adapter\.polymorphic|PolymorphicStep|polymorphicStrategy" \
  src/query-engine src/adapters
```

Do not search for the generic word `lifecycle`; it has legitimate existing uses
and proves nothing about this feature.

## 13. Acceptance matrix

Checked execution items below were run on 2026-08-08. A test file's existence
alone is not treated as a passing result.

### Public API

- [x] `s.polymorphic(targets, { values })`, `.name()`, and `.optional()` are public.
- [x] Exact connect/create/update/filter/include schema unions are implemented.
- [x] `{ type, is, isNot }` is refused and omitted variant overrides keep default projection.
- [x] Variant-specific result narrowing is implemented.
- [x] Optionality and orphan behavior are implemented at the schema/result boundary.
- [x] Final type execution confirms recursive autocomplete and public driver-path typo probes, including non-fresh values.

### Storage and migrations

- [x] Hidden columns are not public scalars.
- [x] Type/id are represented by one linked-or-empty storage value.
- [x] Definition validation enforces one compatible target-PK representation.
- [x] Definition validation enforces stored discriminator and generated-name rules.
- [x] Serializer emits the private columns and composite `(type, id)` index.
- [x] Strict result parsing rejects half-null or unknown storage.
- [x] Rename/add/remove/retarget handling is implemented in the sole history owner.
- [x] Metadata-only target additions persist through `generate`; push's history
      limitation is explicit and not presented as detection.
- [x] PostgreSQL/MySQL/SQLite/libSQL DDL parity.
- [x] MySQL composite-index DDL execution.

### Reads

- [x] Direct include/select/filter compilation.
- [x] Per-variant nested projection with default projection for omitted variants.
- [x] Strict result dispatch and parsing.
- [x] Inverse include/some/every/none/count add the discriminator conjunct.
- [x] Direct projection is one CASE-based statement with cached metadata and no client-side per-row query loop.
- [x] Provider execution confirms statement count, exact discriminator semantics, and no N+1.

### Writes

- [x] Direct connect/create/disconnect.
- [x] Disconnect-only update/upsert arms emit their root UPDATE; a true empty
      update remains zero-step.
- [x] Inverse create through `CreateOperation` and `RecordUpdateCompiler`.
- [x] Required-polymorphic models refuse scalar-only root/nested `createMany`
      before planning; optional-polymorphic models keep current bulk behavior.
- [x] Root upsert arms reuse direct lowering; whole-argument validation remains
      eager while untaken-arm legality and effects stay inactive.
- [x] Unsupported verbs are absent from the V1 schemas.
- [x] No runtime step kind was added.
- [x] Generated identity and compound unique selector lookup execute correctly.
- [x] Transaction/atomic-batch parity.
- [x] Target creation rolls back when the owner INSERT/UPDATE fails.
- [x] Target replacement/deletion between lookup and owner write cannot link a
      wrong row.
- [x] Inverse child creation races safely with parent removal.
- [x] Independently committed target deletion produces the approved optional
      and required orphan behavior.
- [x] Guard/race/retry semantics preserved.
- [x] Execution plans verify no added statement or round trip.

### Regression and performance

- [x] Ordinary relation SQL/step snapshots unchanged.
- [x] Existing query performance suites green.
- [x] Normal LATERAL path unchanged.
- [x] Type-check median is 19.22 seconds versus the 19.17-second Y0 baseline
      (0.26% increase).
- [x] No runtime write-engine import cycle.
- [x] PGlite, SQLite3, libSQL, PostgreSQL Docker, and MySQL Docker execute the
      shared provider contract before final commit.

## 14. Stop conditions

Stop implementation and revise the design if any of these occurs:

- the public carrier collapses recursive model types to `any`;
- hidden columns must become public scalars;
- a generic physical-column escape is required;
- a relation-specific shape must enter the model-blind parse boundary;
- an extra read/write statement is required;
- ordinary relation fast paths change;
- broad inverse mutation logic becomes necessary;
- strict result parsing cannot distinguish the approved orphan states;
- a new runtime step, strategy framework, or adapter execution protocol appears.

## 15. Delivery report

The final implementation report must state:

- starting and ending commits;
- approved Y0 decisions;
- new public surface;
- added internal concepts and why each is unavoidable;
- production LOC by layer;
- statement/round-trip result;
- type-check baseline/final medians;
- exact validation commands and results;
- PostgreSQL/MySQL Docker status;
- remaining correctness or performance risk.

Create one final task-level commit after all gates pass:

```text
feat: add polymorphic relations
```
