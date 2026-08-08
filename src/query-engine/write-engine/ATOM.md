# The Write-Engine Atom

This is current doctrine for `src/query-engine/write-engine`, not a migration plan or
an implementation ledger.

The write engine has one small execution vocabulary and three independent
semantic facts:

1. `RelationMutationProgram` says what a parsed relation payload requests.
2. `BoundRelation` says where that relation is stored.
3. A record compiler says how one fresh or selected record is mutated.

Relation owners combine those facts. Child-held and junction owners keep
membership, target selection, branch decisions, guards, and race pins.
Parent-held to-one decisions remain in the record compiler because they choose
columns in that record's root statement.

## 1. Compilation pipeline

```text
untrusted arguments
        │
        ▼
operation schema and relation transforms
        │
        ▼
scalar data + RelationMutationProgram map
        │
        ▼
OwnWrite legality
        │
        ▼
root operation + relation Parts
        │
        ├── planning() ──► PlanningFragment
        │                       │
        │                       ▼
        │                 PlanningKnown
        │                       │
        └── compile(known) ─────┘
                    │
                    ▼
             OperationFragment
                    │
                    ▼
             OperationExecutor
                    │
                    ▼
             adapter + driver
```

Parsing establishes payload meaning. Planning obtains values needed to choose
or materialize the final fragment. Compilation emits only the selected final
effects. Execution does not learn relation semantics.

An **operation shell** is the concrete owner of one public operation family. It
exposes `mode`, planning, compilation, and result parsing. A routed root shell
owns public target and result behavior and selects direct folds.
`CreateOperation` can also serve as a delegated fresh-record compiler inside an
outer shell. `*Operation.ts` files contain these owners;
`../operations/*.ts` files contain operation-specific SQL, plan, identity, and
ordering helpers.

At one relation edge, **parent** is the current source record and **child** is
its target. `parentHeldToOne` means that source record stores the FK; neither
word establishes a global model hierarchy.

## 2. The execution vocabulary

`OperationFragment.ts` owns the runtime vocabulary.

```ts
interface ReadStep extends StatementStepBase {
  readonly kind: "read";
}

interface WriteStep extends StatementStepBase {
  readonly kind: "write";
  readonly racePin?: TargetConstraintPin;
  readonly onUniqueConflict?: "skip";
}

type StatementStep = ReadStep | WriteStep;

interface GuardStep {
  readonly kind: "guard";
  readonly premise: ExistsOrNotExists;
  readonly failure: Failure;
}
```

A statement step has:

- a stable ID;
- one `Sql` statement;
- declared outputs;
- an optional result postcondition.

A read cannot carry a race pin or conflict policy. Those properties affect a
write and therefore exist only on `WriteStep`.

No branch, locate, relation, or mutation kind is a runtime step kind. Those are
compiler concepts that lower to reads, writes, and guards.

An `OperationValueReference` identifies one declared output from an earlier
step. It can appear in `Sql.values` until execution materializes it. References
point backward in their fragment; planning values cross into final compilation
as known values, not references to discarded planning steps.

## 3. Planning fragments

Planning has a smaller type than final compilation:

```ts
interface PlanningFragment {
  readonly steps: readonly StatementStep[];
  readonly outputs: Readonly<Record<string, FragmentOutputSource>>;
}
```

Planning contains no guards. A guard protects a premise of the selected final
fragment, and no final branch has been selected while planning runs.

Planning is not read-only. Skip-duplicate capture performs preparation
writes during root planning. Those writes publish the values required to build
the final fragment. The executor must retain its non-read planning fallback.

Nested `Part.planning()` normally contributes reads. This is a current
implementation fact, not a stronger type invariant than `PlanningFragment`.

Planning output keys use the step ID plus output name. Two sibling probes for
the same model therefore cannot overwrite each other.

Final fragments contain only the selected arm. Atomic-batch execution evaluates
guards before writes while preserving relative order inside both buckets.
Transaction execution checks postconditions before commit. Parts contribute
planning and final steps; the root flattens them with IDs from one `StepScope`.

## 4. Parse once

Validation transforms are not assumed to be idempotent. A schema output can
contain canonical envelopes or transformed scalar values that must not be fed
through the same schema again.

The rule is:

> Parse untrusted input where it becomes trusted domain data. Pass the parsed
> meaning downstream without reparsing it.

`partitionModelData` separates scalar fields from relation payloads. It does
not inspect mutation kinds.

`buildRelationMutationProgram` receives a schema-transformed relation payload.
`buildParsedRelationPrograms` is used only when the complete input tree is
already parsed.

Root update keeps its established one-transform sites so error order does not
move. Nested record compilers receive transformed data and do not reopen the
public schema.

## 5. Relation mutation programs

The canonical payload representation is:

```ts
interface RelationMutationProgram {
  readonly relationInfo: RelationInfo;
  readonly entries: readonly RelationMutationEntry[];
}
```

It records request meaning, not execution policy.

Program construction preserves:

- the fixed mutation-kind order;
- each source-array item;
- duplicate `connectOrCreate` entries;
- an empty `set` array;
- to-one update filters;
- normalized to-one and to-many update targets;
- normalized upsert target shapes;
- schema-transformed scalar values.

Program construction removes only semantic no-ops:

- `disconnect: false`;
- `delete: false`.

It does not deduplicate items. OwnWrite, connect-or-create, and other consumers
keep any deduplication that belongs to their own rule.

Emitters iterate `program.entries`. They do not index an optional per-kind bag,
normalize arrays again, or inspect the original payload.

## 6. Mutation order

Relation entries use one semantic order:

1. named readers: `disconnect`, `delete`, `update`, `upsert`,
   `connectOrCreate`;
2. unbounded writers: `set`, `updateMany`, `deleteMany`;
3. pure adders: `connect`, `create`, `createMany`.

This order makes each planning read precede a write that could invalidate its
decision. It is shared by emission and OwnWrite analysis.

Changing the order is a behavior change even when the final rows look equal.
It can change locks, error attribution, race exposure, and sibling visibility.

## 7. Bound relation position

`bindRelation` turns schema relation metadata into one topology fact:

```ts
type BoundRelation =
  | ParentHeldToOne
  | ChildHeldToOne
  | ChildHeldToMany
  | PolymorphicChildHeldToMany
  | JunctionRelation;
```

Classification is ordered:

1. `manyToMany` is `junction`;
2. a relation whose current model holds the FK is `parentHeldToOne`;
3. a resolved polymorphic inverse is `polymorphicChildHeldToMany`;
4. an ordinary child-held to-one is `childHeldToOne`;
5. the remaining ordinary child-held relation is `childHeldToMany`.

A fields-less `manyToOne` is therefore child-held to-one from the current
source position.

A bound FK relation carries:

- the source model;
- ordered foreign fields;
- ordered referenced fields;
- the `onUpdate` action.

The polymorphic child-held variant additionally carries its private storage and
fixed stored discriminator. Its one identity field references the parent field
at the same index. It expresses a conjunction, not two independent links:

```text
child.privateIdentity = parent.referenced
AND child.privateType = storedDiscriminator
```

The discriminator participates in membership scope equality, OwnWrite
footprints, read correlation, target probes, set departure, and bulk predicates.
A same-id row with another discriminator is a different membership.

It does not carry:

- query scopes or aliases;
- parent identity values;
- planning or final sources;
- fresh or located state;
- transition values;
- junction mapping metadata;
- SQL;
- branch or execution policy.

Bind at the first topology decision. Do not bind all relations early: that can
move malformed-metadata errors ahead of schema errors or into an untaken upsert
arm.

Direct polymorphic mutation intent is not a bound inverse. It chooses a target
variant per payload and lowers to `ResolvedPolymorphicMutation` plus one atomic
private storage assignment. Fresh record compilation accepts connect, create,
and connect-or-create. Selected record compilation also accepts correlated
update and upsert; optional storage accepts disconnect and typed target delete.
The locate exposes private storage columns only for verbs whose branch depends
on current membership.

Root createMany accepts connect-only polymorphic memberships per row. Its bulk
preparation groups selectors by relation and stored discriminator, resolves the
private pair once per row, and preserves the existing contiguous row-shape
grouping. Count and returning operations use this same owner.

## 8. Source-bound relation membership

`relation-membership.ts` owns child-held membership and its value provenance.

```ts
interface ForeignKeyMember {
  readonly foreignField: string;
  readonly referencedField: string;
  readonly writeSource: FinalReferenceSource;
}

interface CorrelatedForeignKeyMember extends ForeignKeyMember {
  readonly readSource: PlanningReferenceSource;
}
```

The member binds a value source to one foreign/referenced field pair. A caller
never passes an external field name when it resolves the source.

`RelationMembershipBinding` then binds those members to an ordinary child-held
relation, or binds one identity source to a polymorphic child-held relation's
fixed storage and discriminator. Its correlated form adds the independent read
source. This one value feeds assignment, clear, planning/final correlation,
projection, and found-row classification; emitters do not branch on physical
storage.

Planning sources are literals or planning fields. Final sources can also be
operation references, transitioned planning fields, or lookup SQL.

The source owner enforces these boundaries:

- a final operation reference cannot enter planning SQL;
- lookup SQL cannot decide a planning branch;
- a transitioned member reads its old value and writes its new value;
- compound members preserve schema field order;
- read and write sources are never inferred from each other.

Field arity is checked when fields and values are paired, after the existing
legality boundary. Binding topology does not perform that check early.

## 9. Fresh-record compiler

`CreateOperation` is the compiler for each non-bulk fresh record subtree.

Nested callers provide:

- already parsed record data;
- one optional `RelationMembershipBinding`;
- an optional race pin for the root insert;
- a shared step scope.

The compiler owns:

- scalar insert data;
- incoming membership assignment;
- parent-held before-writes;
- child-held descendants;
- generated identity capture when requested;
- root insert construction;
- descendant order.

The nested fresh-record Part exposes:

- planning steps;
- compiled record steps;
- the root write ID;
- a referenced root field for consumers such as a junction insert.

It does not own the incoming relation's membership or found/missing decision.
The explicit inline junction-target insert remains local to the junction owner.

Generated identity capture is demand-driven. A generated value is requested
when a descendant, an incoming edge consumer, a junction, or a terminal result
needs it. An unused generated identity does not force a different insert shape.

`createMany` remains specialized because row grouping, skip semantics, and
multi-row output folding are not one-record compilation. A fresh parent stores
post-insert groups in `CreateOperation`; a selected parent delegates to
`nested-target-parts.ts`; a junction retains target-row and join ordering in
`RelationJunctionPart`.

## 10. Selected-record compiler

`RecordUpdateCompiler` compiles one already-selected non-bulk record update.

Its caller supplies target-read and root-write labels. The compiler exposes:

- `targetReadId`;
- `writeId`;
- `targetProjection`, containing required public fields and private physical
  columns;
- planning for descendants;
- final compilation;
- updated primary-key reconstruction from the captured row.

The compiler owns:

- user scalar SET data;
- one optional incoming membership assignment;
- parent-held FK folding;
- child-held nested mutations;
- required target projection;
- primary-key transition calculation;
- read-before/write-after ordering;
- the root UPDATE;
- descendant Parts.

For child-held and junction edges it does not own:

- the target read statement;
- selector or parent correlation;
- relation membership;
- found/missing decisions;
- not-found guards or messages;
- race pins;
- terminal result reads;
- direct top-level returning folds;
- top-level conflict folds;
- enclosing OwnWrite timing.

The caller owns the target read and its batch premise. If the projection contains
private physical columns, that same guard reasserts their captured values before
the compiler's writes. No additional guard step is introduced.

For `parentHeldToOne`, it does own the inline FK fold and the branch required to
construct the root UPDATE. Moving that decision out would require a lifecycle
protocol or an extra statement.

A true no-op returns no compiler before any step ID is allocated. Incoming FK
assignments make the update non-empty. Derived FK parameters follow user scalar
parameters.

The root write always addresses the primary key captured by the caller's read.
It does not reconstruct the target from the original selector.

Root operation shells keep public validation, public target reads, direct
one-statement folds, not-found behavior, terminal results, and result parsing.
`UpsertOperation` also keeps match and skip probes, conditional guards, and
create/update arm selection.

## 11. Relation-owner boundary

A child-held or junction relation owner answers questions about an edge, not a
record's internal SET.

It owns:

- target selection;
- parent correlation;
- membership tests and changes;
- found/missing arm choice;
- target-not-found errors;
- selected-arm guards;
- missing-arm race pins;
- junction attachment;
- first-create-wins behavior;
- standalone edge effects.

It calls the record compiler only after it has the selected target identity and
only when that arm must run.

Ordinary targeted updates build the compiler first, obtain its required target
fields, then build the existing correlated target read. If the compiler is a
no-op, the owner emits no target probe, guard, or write.

Upsert owners keep their decision read even when the found update is empty,
because the missing arm must still create the record.

Required target reads lock where supported, require exactly one row, and expose
non-optional fields. Branch target reads have no postcondition and expose
optional first-row fields because absence selects the missing arm.

## 12. Branch premises and pins

A branch read creates a premise that can become stale before final writes.
The branch owner must pin that premise in the final atomic unit.

### Found arm

In batch mode, an existing-row arm emits a captured-primary-key presence guard.
Its failure is not retryable because the row was replaced or removed after the
decision. Top-level scalar probe-first upsert binds its original complete
selector and each matched conditional to that same captured identity; see
`Wrong-row protection`.

In transaction mode, the locked decision read owns the premise. The owner does
not add a duplicate guard.

### Missing arm

When the selected arm inserts the same unique target, the database constraint
is the premise check. The root insert carries `racePin`, which attributes the
matching unique conflict as retryable.

Do not add a `notExists` guard to the same target. The constraint is both
stronger and closer to the write.

An extended selector can mean “a row with the unique key exists but its extra
filter does not match.” Such a missing branch does not get a same-target race
pin because a later unique violation is a real conflict, not proof that the
original filtered premise changed.

### Same-operation duplicate

If an earlier sibling already created the target, connect-or-create applies
first-create-wins locally. The later entry adopts that row. It emits no found
guard and no missing race pin because the producer is inside the same operation.

### Other absence premises

Materialized membership sets and orphan checks retain their explicit
`notExists` guards where no same-target insert constraint can enforce the
premise.

## 13. OwnWrite legality

Planning reads observe committed state before final writes. A read whose answer
depends on an earlier sibling write cannot be made correct by a later guard.

OwnWrite analysis rejects such one-operation feedback with the established
“split these operations” failure.

The analyzer consumes canonical mutation programs and uses bound relation
positions. Execution-specific deduplication remains inside the analyzer.

Legality timing is part of behavior:

- standalone update runs it before planning;
- an enclosing create or update tree analyzes nested ordinary updates once;
- an upsert found arm runs deferred update legality only when found;
- a missing create arm does not analyze the untaken update subtree.

Do not run OwnWrite twice for a subtree already covered by its enclosing tree.

## 14. Primary-key transitions

A primary-key update creates two values with different jobs:

- the old value identifies and correlates the row before the write;
- the new value is assigned to descendants that must follow the transition.

This is why correlated FK members have separate read and write sources.

The compiler determines whether child work must occur before or after the root
UPDATE. Referential actions, especially `onUpdate: cascade`, are part of that
decision.

The ordering rule is not “always parent first” or “always child first.” It is:

> Read membership with the value that exists before the transition. Write the
> edge with the value that must exist after the transition.

A no-op transition keeps the ordinary order. Compound members stay ordered.

## 15. Wrong-row protection

Selectors can include filters or values that the operation itself changes.
Re-evaluating that selector after planning can select a different row.

Therefore `RecordUpdateCompiler`, and every owner that passes it a captured
target:

1. captures the target primary key in its owner read;
2. carries that captured value through planning outputs;
3. writes by the captured primary key;
4. gives descendants and any outer post-write read that same identity.

The wrong-row decoy tests are not optional detail. They prove that replacement
or selector drift cannot redirect an update.

Top-level `UpsertOperation` has three distinct paths:

1. An eligible `ON CONFLICT` fold has no planning read.
2. A relation-bearing found arm uses `RecordUpdateCompiler` and writes by the
   primary key captured by the locate.
3. A scalar probe-first found arm captures the located primary key.

For the third path, transaction mode pins the decision with the locked locate
and can keep the original selector on its write. Batch mode reasserts the
complete selector and each matched conditional together with the captured key,
then writes by that key. The guard fixes the decision at the atomic unit's
entrance; the write keeps row identity afterward.

A conditional-skip batch arm pins two facts, in this order:

1. a non-raceable presence guard proves that the complete selector still names
   the captured primary key;
2. a raceable absence guard proves that this same row still does not satisfy
   the conditional.

The second guard is an absence query, not SQL `NOT (condition)`, so SQL UNKNOWN
remains a no-match. The terminal read addresses the captured primary key. After
an update, the terminal read addresses the reconstructed post-update primary
key. Both guards remain inside the same atomic driver batch, so the extra
statement adds no network round trip. Transaction mode needs neither guard
because its decision read is locked.

## 16. Junction relations

`ManyToManyStatements` owns junction SQL and argument validation.
`RelationJunctionPart` owns membership decisions and join-row effects.

Junction updates use the selected-record compiler for the target record but
keep membership probes and junction writes in the junction owner.

Fresh junction attachment remains explicit. The two live orders are:

```text
inline target:    target INSERT → junction INSERT → inline descendants
delegated target: complete fresh-record subtree → junction INSERT
```

The junction input and allocated plan are discriminated by operation kind, so an
invalid mixture of probes, compilers, fresh targets, or identities is not
representable. Moving the junction insert into a universal fresh-record path
would change the delegated order or require a lifecycle hook or placement flag.

Membership reads during a key transition use the old correlated source. Join
assignments use the final source. Generated target identities flow to the join
through declared record outputs.

## 17. Bulk specializations

The one-record compilers do not absorb set-oriented operations.

These remain specialized:

- `createMany`;
- `updateMany`;
- `deleteMany`;
- relation `set`;
- skip-duplicate grouping and capture;
- many-and-return output folds.

Bulk semantics include row grouping, optional zero matches, membership sets,
and output concatenation. A generic record compiler would hide those facts
rather than compress them.

Skip-duplicate preparation writes remain in planning. Adapter `batchRefs` and executor
`insertId` handling remain because they express real substrate capabilities.

## 18. SQL ownership

The query engine decides what statement is needed. The adapter decides how to
spell it.

The query engine must not recognize or generate provider SQL tokens for:

- quoting;
- JSON access or aggregation;
- returning clauses;
- conflict handling;
- assertion CTEs;
- locks;
- destination casts;
- batch references.

Semantic fold decisions use structured facts from the compiler or adapter
capabilities, not regexes over SQL text.

Driver-owned error mapping recognizes provider messages and assertion markers.
The query engine keeps only generic guard comparison and reprobe behavior.

`Sql` remains the composition and parameterization boundary. Structural empty
fragment checks are not dialect recognition.

Failures stay with their semantic owner. Root operations own public failures;
relation owners own nested and membership failures; the executor owns fragment
contract failures; drivers classify provider errors. One invariant has one
guard. Preserve exact messages and explicit raceability.

## 19. Error-order rules

Error timing is part of the public contract.

For root update, preserve whole-argument validation, portable primary-key
validation, relation-key legality, update-many relation legality, OwnWrite, then
planning and execution, in that order.

Do not bind relation topology or run arm-specific legality early enough to
overtake an earlier error.

For branch operations, established shape parsing can remain eager. Effects and
deferred legality run only for the selected arm. This does not mean every
public shape error is deferred.

## 20. No-op rules

No-op behavior depends on ownership.

- An ordinary empty nested update creates no compiler and emits no target read,
  guard, or write.
- A standalone empty update still locates the public target and returns it or
  raises not found.
- An upsert with an empty found update still performs its branch decision,
  because the missing arm can create.
- Incoming FK assignments make a selected-record update non-empty.
- `set: []` is not erased; it means clear the relation where legal.
- `disconnect: false` and `delete: false` are erased at program construction.

No step ID is allocated before the record compiler proves that its update is
not empty.

## 21. Rejected abstractions

The following shapes were considered and rejected because they add policy or
indirection without deleting an independent semantic responsibility:

- a generic mutation DSL;
- a payload walker shared across root operations;
- a branch-step runtime IR;
- an adopt strategy object;
- a universal locator;
- lifecycle callbacks around record inserts;
- placement booleans for junction attachment;
- a generic operation base class;
- a shared utility landfill.

Reconsider one only with measured evidence that multiple owners implement the
same semantic rule and must change together.

## 22. Proof obligations

For a changed record path, tests must pin as applicable:

- planning step IDs and order;
- planning SQL and parameters;
- planning outputs;
- final step IDs and order;
- final SQL and parameters;
- guards and their raceability;
- postconditions;
- race-pin placement;
- exact errors;
- transaction behavior;
- forced atomic-batch behavior;
- wrong-row decoys;
- same-operation duplicate behavior;
- compound-field order;
- primary-key transitions;
- generated identity provenance.

Run focused tests first, then:

```bash
pnpm test:types
pnpm test:layer:query-engine
pnpm package:build
pnpm test
```

Run PostgreSQL and MySQL parity suites when Docker is available. If they are not
run, report that fact; do not treat a skipped suite as passing.

The retained runtime boundaries are adapter `batchRefs`,
`ManyToManyStatements`, fragment types, mutation programs, bound relations,
field-bound FK sources, the two record compilers, specialized bulk Parts, and
explicit branch pins. `QueryMetadata` remains only as a deprecated type-only
compatibility alias. Everything else can be simplified when evidence shows a
smaller truthful owner.
