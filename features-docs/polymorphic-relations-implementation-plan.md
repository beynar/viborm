# Bound Polymorphic Membership and Inverse Write Parity

> **Design:** [`polymorphic-relations.md`](./polymorphic-relations.md) is
> normative for public semantics and domain language.
>
> **Plan date:** 2026-08-08
>
> **Status:** implemented and validated on the feature branch. Fixed inverse
> membership is now bound topology. The later singular-inverse phase added
> relation-wide cardinality and reused the ordinary child-held-to-one owners.
>
> **Architecture:** consolidated query engine; no `query-engine-v2`

## 1. Required outcome

Make an inverse polymorphic relation a first-class bound topology whose physical
membership is:

```text
child.type = fixed discriminator
AND
child.identity = parent referenced value
```

Then route the safe ordinary inverse `oneToMany` mutation family through the
existing relation Parts, `CreateOperation`, and `RecordUpdateCompiler`.

This implementation also removes the former inverse-create fragmentation from
read correlation, OwnWrite analysis, fresh-record compilation, and selected
record compilation.

Fixed compatibility boundaries for the inverse-parity phase:

- Direct polymorphic write APIs did not change in that phase. The subsequent
  direct-parity phase added create `connectOrCreate`, selected-owner target
  mutation, and root bulk connect.
- Polymorphic many-to-many remained out of scope. Inverse one-to-one was added
  by the completed singular-inverse phase documented in section 11.
- Root `createMany` now accepts connect-only polymorphic memberships beside
  scalar row data.
- No referential-action emulation is added.
- No adapter change or runtime step kind is added.
- No operation-specific polymorphic Part or strategy framework is added.
- Existing direct reads/writes and existing inverse reads/create preserve SQL,
  parameters, steps, guards, pins, errors, and round trips.

## 2. Final internal contracts

### 2.1 Bound inverse topology

`BoundRelation` includes this exact variant:

```ts
interface PolymorphicChildHeldToMany extends BoundForeignKeyRelation {
  readonly kind: "polymorphicChildHeldToMany";
  readonly foreignFields: readonly [string];
  readonly referencedFields: readonly [string];
  readonly storage: PolymorphicStorage;
  readonly storedType: string;
}
```

Its fields are:

```text
foreignFields     = [storage.idColumn.name]
referencedFields  = [sourceReferencedField]
onUpdate          = undefined
```

`bindRelation()` classifies in this order:

1. `junction`;
2. direct parent-held ordinary FK;
3. resolved polymorphic inverse;
4. ordinary child-held to-one;
5. ordinary child-held to-many.

The variant contains only fixed topology. It does not contain query scopes,
aliases, parent identities, SQL, planning/final sources, transition values,
branch state, or execution policy.

Direct payload-selected facts remain `ResolvedPolymorphicMutation` and
`ResolvedPolymorphicEdge`; their discriminator varies with the payload and does
not belong in the inverse bound relation.

### 2.2 Exact membership scope

`RelationMembershipScope` includes:

```ts
{
  readonly kind: "polymorphicForeignKey";
  readonly holder: Model<any>;
  readonly referenced: Model<any>;
  readonly typeField: string;
  readonly storedType: string;
  readonly identityField: string;
  readonly referencedField: string;
}
```

Scope equality includes `typeField` and `storedType`. Same identity plus a
different discriminator is a different membership.

### 2.3 One predicate owner

```ts
buildPolymorphicMembershipPredicate(
  ctx: QueryScope,
  relation: PolymorphicChildHeldToMany,
  childQualifier: string,
  parentIdentity: Sql
): Sql
```

It emits, in this fixed order:

```sql
child.identity_column = parent_identity
AND child.type_column = stored_discriminator
```

Read correlation, membership probes, guarded writes, set/removal reads, and
bulk mutation predicates consume this function. No mutation verb constructs a
private discriminator predicate independently.

`childQualifier` is explicit because SQL qualification and parent-value
provenance are independent facts. A planning read can qualify with an alias;
an UPDATE/DELETE predicate can qualify with the physical table name.

### 2.4 Atomic storage assignment

Inverse create/adopt/disconnect/set lowering uses the existing exact pair:

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

There is no half-write API. Neutral statement builders receive internal storage
values or prebuilt SQL predicates; private column names never enter public
`where` or `data` objects.

### 2.5 Compiler ownership

- `RelationMutationProgram` owns schema-transformed user intent.
- `PolymorphicChildHeldToMany` owns inverse topology.
- Relation Parts own membership, probes, found/missing selection, guards, race
  pins, and standalone edge writes.
- `CreateOperation` owns fresh child subtrees and accepts
  `incomingPolymorphicStorage`.
- `RecordUpdateCompiler` owns selected child updates and uses the captured
  target identity.
- OwnWrite consumes the exact bound membership and does not reconstruct it per
  operation.

Record compilers do not acquire a polymorphic branch mode.

## 3. Public inverse write contract

### 3.1 Create family

An inverse `oneToMany` create payload exposes:

- `create`
- scalar-only nested `createMany`
- `connect`
- `connectOrCreate`
- `upsert`

### 3.2 Update family

An inverse update payload exposes:

- `create`
- scalar-only nested `createMany`
- `connect`
- `connectOrCreate`
- `update`
- `updateMany`
- `delete`
- `deleteMany`
- `upsert`
- `disconnect` only when the owning direct relation is optional
- `set` only when the owning direct relation is optional

All nested create/update data omit the direct polymorphic relation that owns the
inverse. One payload cannot supply the same edge through both sides.

Nested inverse `createMany` satisfies exactly the owning required polymorphic
relation. It remains unavailable if another required polymorphic relation on
the child is unsatisfied.

### 3.3 Behavioral rules

- `connect` globally locates and adopts the target.
- `connectOrCreate` globally locates/adopts or creates; duplicate targets keep
  first-create-wins behavior.
- `upsert` under a fresh parent uses global-adopt semantics.
- `upsert` under a selected parent uses correlated semantics. A target found
  outside the exact `(type, identity)` membership produces V7001 and no effects.
- `update` and `delete` require selector plus exact membership.
- `updateMany` and `deleteMany` always include exact membership.
- `disconnect` clears both columns atomically.
- `set` adopts selected rows and clears both columns on departing rows.
- `set: []` disconnects all current members.
- Every create arm writes both private columns atomically.
- Selected updates address the captured primary key.
- Untaken upsert arms remain inert.

## 4. Implemented workstreams

The following sections record the current architecture. They are not pending
migration phases.

### 4.1 Topology and read correlation — implemented

Completed changes:

- moved inverse topology discovery into the bound relation owner;
- added `PolymorphicChildHeldToMany`;
- made query context/model metadata own primary-key fields needed by correlation;
- changed ordinary/polymorphic read correlation to switch on `BoundRelation`;
- centralized exact `(identity, discriminator)` SQL construction;
- removed the separate query-engine inverse carrier and resolver branches;
- removed the old doctrine that a fixed inverse discriminator could not be
  bound topology.

Compatibility result:

- existing inverse include/filter/count SQL stays on the same one-statement
  paths;
- same-identity wrong-type rows are excluded;
- no adapter or result-shape protocol changes.

### 4.2 OwnWrite exact membership — implemented

Completed changes:

- extended membership scope and equality with discriminator field/value;
- taught endpoint orientation and footprint construction about the bound
  polymorphic child-held relation;
- routed inverse relation programs through ordinary `OwnWriteRelation` and
  `OwnWriteSteps` traversal;
- deleted create-specific inverse OwnWrite recursion and skip branches;
- preserved the absence of ordinary database-FK referential-action guards.

Transition rule:

- membership/removal reads use the pre-transition parent value;
- create/adopt writes use the transitioned value;
- set has distinct departing-read and adoption-write sources;
- untouched memberships are not rewritten.

### 4.3 Internal predicate and bulk lowering — implemented

Neutral builders now accept internal-only inputs needed by existing relation
owners:

- find/find-unique can receive a prebuilt SQL predicate;
- find probes can select already-aliased private columns;
- updateMany/deleteMany can receive a prebuilt SQL predicate;
- capped bulk rewrites propagate that predicate into their PK subquery;
- updateMany accepts atomic polymorphic storage assignments;
- createMany accepts one shared storage assignment applied to every row after
  public scalar columns, type before identity.

Calls that do not provide these fields preserve their prior SQL.

### 4.4 Existing relation owners — implemented

The child-held configurations have an exact polymorphic branch rather than an
operation-specific Part.

Migration order was:

1. inverse `create` through ordinary child-held dispatch;
2. correlated `update`, `updateMany`, `delete`, and `deleteMany`;
3. `connect` and optional `disconnect`;
4. optional `set`;
5. `connectOrCreate`;
6. `upsert`;
7. grouped nested `createMany`.

The implementation preserves:

- one transform of nested payloads;
- ordinary input/kind order and step-ID allocation;
- existing guard, race-pin, retry, and first-create-wins owners;
- captured-PK updates;
- grouped createMany execution;
- transaction and atomic-batch parity.

### 4.5 Validation and public types — implemented

The operation-schema builders derive dedicated inverse-to-many create/update
schemas from the owning direct polymorphic relation.

Runtime and type-level builders agree on:

- exact inverse relation key;
- owning relation optionality;
- omission of that owner from child create/update data;
- the one required relation satisfied by inverse nested `createMany`;
- refusal when another required polymorphic relation remains unsatisfied;
- no widening of direct polymorphic mutation schemas.

Public type probes enter through real client calls and cover supported keys,
conditional `disconnect`/`set`, owner-key omission, nested levels, misspellings
beside real keys, and root `createMany` refusal.

### 4.6 Contract tests — implemented

Behavior was added to the rebuilt polymorphic suites, not to parallel
legacy-shaped files. The contract surface includes:

- all inverse verbs in transaction and atomic-batch modes;
- same-ID wrong-type decoys;
- found-row replacement races;
- missing-arm unique race and retry;
- first-create-wins duplicate `connectOrCreate`;
- correlated foreign-member upsert V7001 and no effects;
- optional pair clearing and required-schema refusal;
- empty, retained, departing, and wrong-type set cases;
- relation-bearing selected updates;
- inert untaken root-upsert arms;
- referenced non-PK identities and parent identity transitions;
- grouped nested createMany order, casts, and skip-duplicate behavior;
- another-required-polymorphic-relation createMany refusal;
- existing direct and inverse-read/create parity.

## 5. Correctness invariants

### Exact discriminator

Every inverse membership observation includes both private fields. Identity
without discriminator is never sufficient.

### One guard per invariant

Operation schemas own public payload legality. Relation Parts own runtime target
existence/membership races. The query engine does not add a duplicate payload
shape guard after schema transformation.

### One predicate implementation

Mutation verbs may decide when membership applies, but they do not spell the
private discriminator predicate. The shared correlation owner does.

### Atomic pair writes

Create, adopt, disconnect, and set write or clear type and identity together.
There is no internal API for only one private column.

### Old-read/new-write transitions

The parent identity used to observe an existing membership is not automatically
the identity used to write an adoption after a parent key transition. Those
sources remain separate.

### No implicit referential actions

The relation has no database FK. Existing untouched memberships do not cascade
when a parent referenced value changes.

## 6. Performance and compatibility contract

The completed architecture must preserve:

- one-statement polymorphic include paths;
- direct `RETURNING`, `ON CONFLICT`, CTE, planning-batch, and atomic-batch
  optimizations;
- no new statement or round trip beyond an ordinary child-held analogue;
- no N single-record replacement for nested createMany;
- destination scalar casts and parameter order;
- planning/final step IDs and order;
- outputs, guards, expectations, race pins, retries, and exact errors;
- zero write-engine runtime import cycles;
- no adapter method or runtime step kind.

## 7. Final validation roadmap

Finalization uses the rebuilt, memory-capped suite layout. Processes run one at
a time.

Required local gates:

```bash
pnpm test:layer:relations
pnpm test:layer:operation-schemas
pnpm test:layer:query-engine
pnpm test:types
pnpm package:build
pnpm test
pnpm test:all
pnpm test:coverage:write-engine
```

Run Docker PostgreSQL and MySQL provider contracts when the services are
available. If they are unavailable, record them as not run rather than passed.

Run three warm final type checks. Their median must not regress by more than 5%
from the recorded branch baseline.

Adversarial verification must trace:

1. topology and OwnWrite, searching for any identity-only membership decision;
2. emitters, comparing SQL, statements, guards, pins, and transition ordering
   with ordinary child-held analogues;
3. fresh-context public flows for create, connect, set, connectOrCreate, and
   upsert from schema input to emitted SQL.

## 8. Acceptance criteria

Static production searches return no legacy inverse carrier, resolver, or
create-specific inverse interpreter.

Additional acceptance requirements:

- no polymorphic mutation Part, strategy, callback protocol, runtime step, or
  adapter method;
- no private-field public API;
- no verb-local discriminator predicate;
- no same-ID wrong-type match;
- existing inverse read/create and direct behavior retain their plans;
- new verbs add no statement or round trip beyond ordinary child-held forms;
- nested inverse createMany remains grouped;
- write-engine runtime import cycles remain zero;
- write-engine coverage does not regress;
- public type-check timing remains inside the 5% gate.

The implementation report separates executable LOC, test LOC, and
documentation LOC and lists deleted concepts.

Final task-level commit:

```text
feat: expand polymorphic inverse writes
```

## 9. Direct and bulk parity completion

The follow-up phase reused the same private storage value and record compilers:

- direct create gained `connectOrCreate`;
- selected-owner update gained `create`, `connectOrCreate`, correlated
  `update`, typed `delete`, and `upsert`;
- root `createMany` gained per-row connect-only memberships, with one grouped
  planning probe per relation/variant and the existing grouped INSERT plan;
- selected record probes publish the two private storage columns only when a
  direct mutation needs to inspect current membership;
- count and returning bulk operations share one bulk polymorphic connect owner.

No adapter method, runtime step, operation-specific polymorphic Part, or
per-row target query was added.

## 10. Remaining product roadmap

The following work is explicitly separate from this implementation:

- polymorphic many-to-many;
- inverse binding when one target map names the same model more than once;
- compound, mixed-kind, array, or native-override polymorphic identities;
- root createMany verbs beyond connect;
- portable database constraints across target tables;
- optional ORM-emulated referential actions;
- untyped cross-target filters and direct polymorphic order-by.

These features may reuse exact `(type, identity)` membership, but they require
their own product semantics and acceptance gates. They must not be smuggled into
the existing inverse parity work.

## 11. Singular inverse completion

The singular follow-up added two durable facts:

```ts
type PolymorphicInverseCardinality = "one" | "many";

interface PolymorphicChildHeldToOne
  extends BoundPolymorphicChildHeldRelation {
  readonly kind: "polymorphicChildHeldToOne";
}
```

Cardinality is resolved across every inverse sharing one private storage pair.
Mixed cardinalities fail definition validation. The existing composite index
becomes unique for `one`, without changing its name or column order; normal
index differ and DDL owners handle both transition directions. Duplicate live
memberships make a many-to-one migration fail transactionally.

The public singular inverse accepts create/connect/connectOrCreate on parent
create; parent update adds correlated update/upsert and, for optional storage,
disconnect/delete. Reads and writes reuse the central exact membership
predicate, ordinary child-held-to-one Parts, `CreateOperation`, and
`RecordUpdateCompiler`. No mutation Part, runtime step, adapter method, or
additional round trip was added.
