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
scalar data + one ordered parsed relation collection
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
its target. `position: "parentHeld"` means that source record stores the FK; neither
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

interface RecordSeriesStep {
  readonly id: string;
  readonly kind: "recordSeries";
  readonly series: RecordSeriesOperation;
  readonly progressive:
    | { readonly kind: "guarded"; readonly guard: GuardStep }
    | { readonly kind: "unsupported"; readonly reason: string };
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
compiler concepts that lower to reads, writes, and guards. `RecordSeriesStep`
is only the nested placement of the existing ordered record-series execution
form; it does not interpret mutation meaning.

An `OperationValueReference` identifies one declared output from an earlier
step. It can appear in `Sql.values` until execution materializes it. References
point backward in their fragment; planning values cross into final compilation
as known values, not references to discarded planning steps.

## 3. Planning fragments

Planning has a smaller type than final compilation:

```ts
interface PlanningFragment {
  readonly steps: readonly StatementStep[];
}
```

Planning contains no guards or record series. A guard protects a premise of the
selected final fragment, and no final branch has been selected while planning
runs.

Planning is not read-only. Skip-duplicate capture performs preparation
writes during root planning. Those writes publish the values required to build
the final fragment. The executor must retain its non-read planning fallback.

Nested `Part.planning()` normally contributes reads. This is a current
implementation fact, not a stronger type invariant than `PlanningFragment`.

Planning publication is DERIVED: the executor exposes every declared statement
output under `planningKey(step.id, name)`, so a producer cannot under-publish
and two sibling probes for the same model cannot overwrite each other. Final
fragments keep explicit output selection.

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
move. It therefore spells its own two passes — every ordinary relation payload
transformed before any polymorphic one — rather than delegating to the general
constructor; the upsert update arm spells the same two. Both produce the one
parsed collection described in §5. Nested record compilers receive transformed
data and do not reopen the public schema.

## 5. Relation mutation programs

The canonical payload representation is:

```ts
interface RelationMutationProgram {
  readonly relationInfo: RelationInfo;
  readonly entries: readonly RelationMutationEntry[];
}
```

It records request meaning, not execution policy.

The operation-schema boundary supplies at most one active entry for a to-one
create or parent-held update. A child-held to-one update may supply one of the
five documented vacate-then-supply pairs; fixed mutation-kind order emits the
vacate before the supplier. To-many payloads may contribute several kinds;
their fixed order is preserved here.

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

One record's parsed `data` is its scalars plus ONE ordered collection:

```ts
type ParsedRelationMutation =
  | {
      readonly kind: "ordinary";
      readonly name: string;
      readonly program: RelationMutationProgram;
    }
  | {
      readonly kind: "polymorphicTarget";
      readonly name: string;
      readonly program: RelationMutationProgram;
      readonly edge: ResolvedPolymorphicEdge;
    }
  | {
      readonly kind: "polymorphicDisconnect";
      readonly name: string;
      readonly storage: PolymorphicStorage;
    };

interface ParsedRecordPrograms {
  readonly scalarData: Record<string, unknown>;
  readonly relations: readonly ParsedRelationMutation[];
}
```

Every relation key the payload writes is one entry. A targetless direct
polymorphic `disconnect` has no program — it is one empty private storage
assignment — and is its own arm rather than a companion map, because a reader
that consulted programs alone dropped it silently (§17).

The collection's ORDER is behavior: every ordinary relation in payload key
order, then every polymorphic relation in payload key order. It decides step-id
allocation and therefore duplicate suffixes, planning and guard order, and
OwnWrite append order. Payload key order is not that order, and this
representation does not normalize execution to model declaration order.

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

ONE STORED TOPOLOGY, SEVERAL DERIVED VIEWS. `bindRelation` turns schema relation
metadata into one topology fact, carrying three ORTHOGONAL axes. Every other
statement about the edge — its arity, whether its slot may empty, whether its
membership can be cleared, how it correlates — is DERIVED from that one fact by
one named owner, and is never stored a second time:

```ts
type BoundRelation =
  | ParentHeldRelation // position "parentHeld", cardinality "one"
  | ChildHeldRelation // position "childHeld", cardinality "one" | "many"
  | JunctionBoundRelation; // position "junction", cardinality "many"

type ChildHeldRelation =
  | OrdinaryChildHeldRelation // membership: BoundForeignKeyMembership
  | PolymorphicChildHeldRelation; // membership: BoundPolymorphicMembership
```

- `position` is which row stores the membership, and decides placement and
  ownership;
- `cardinality` is how many targets the public slot admits, and decides arity;
- `membership.kind` (`foreignKey` / `polymorphic` / `junction`) is how the
  membership is physically stored, and decides lowering.

Each consumer branches on exactly the axis its question names. The union still
forbids the impossible combinations: parent-held is always to-one, junction is
always to-many, and both child-held storages admit either arity.

ONE dispatcher per position, not one per position × membership. A child-held
entry is compiled once for both storages, with the parent's read source, its
write source and each half's placement resolved BEFORE the dispatch; a
parent-held arm names its verb, and which storage it assigns rides as a
root-membership assignment on that arm — everywhere the fresh-record compiler
owns, and for a selected record's create and connect-or-create; the selected
record's polymorphic update, upsert and delete still hold parallel arms until a
parent-held locator union lands (the blocker is stated at those arms). What
stays inside an arm is only a
difference that is real — a fresh child's foreign-key provenance, a guard that
must be rebuilt from a captured row, a discriminator premise on the located row.

Classification is ordered:

1. `manyToMany` is `junction`;
2. a relation whose current model holds the FK is `parentHeld`, cardinality
   `one`;
3. a resolved polymorphic inverse is `childHeld` with polymorphic membership,
   cardinality `one` for a fields-less `oneToOne`, otherwise `many`;
4. the remaining child-held relation carries foreign-key membership, cardinality
   `one` for a to-one relation, otherwise `many`.

A fields-less `manyToOne` is therefore child-held to-one from the current
source position.

A bound relation carries the source model and its `relationInfo`; its membership
carries the physical storage and the two models it spans. A foreign-key membership
carries:

- the holder model and the referenced model (equal on a self-relation);
- ordered foreign fields;
- ordered referenced fields;
- those two lists paired member for member, LAZILY: pairing is where mismatched
  foreign-key metadata is refused, and binding must not move that refusal ahead of
  the relation-key legality error that answers first. That pairing is the ONE
  pairing — a consumer needing both halves of a member reads `members`, never
  `foreignFields[i]` beside `referencedFields[i]`;
- the `onUpdate` action.

A polymorphic membership carries the same holder and referenced models, its
one-member foreign tuple and the SINGLE field it references, plus its private
storage and fixed stored discriminator (and no referential action). Its one
identity field references the parent's single named field. It expresses a
conjunction, not two independent links:

```text
child.privateIdentity = parent.referenced
AND child.privateType = storedDiscriminator
```

The discriminator participates in membership scope equality, OwnWrite
footprints, read correlation, target probes, set departure, and bulk predicates.
A same-id row with another discriminator is a different membership.

Cardinality remains an ordinary relation concern, and an axis of its own: the
singular case selects one member, uses to-one operation arity, and relies on the
relation-wide unique storage index for occupied-slot enforcement. The storage
predicate and value lowering are the membership's, shared across both arities.

A bound relation does not carry:

- query scopes or aliases;
- parent identity values;
- planning or final sources;
- fresh or located state;
- transition values;
- SQL;
- branch or execution policy.

Bind at the first topology decision. Do not bind all relations early: that can
move malformed-metadata errors ahead of schema errors or into an untaken upsert
arm. Lateness protects exactly what is lazy — the paired FK members and the
junction sides. The row-held bind itself resolves the inverse EAGERLY, so a
missing, ambiguous, or storage-less inverse refuses at construction even from
an untaken arm (pinned by the construction-eagerness witnesses); that is the
deliberate boundary, not a leak.

Direct polymorphic mutation intent is not a bound inverse. It chooses a target
variant per payload, and lowers to the parsed collection's polymorphic arms — a
resolved edge beside its program, or a targetless disconnect — plus one atomic
private storage assignment. Its resolution is eager, at program construction, for
every polymorphic payload including an untaken upsert arm. Fresh record
compilation accepts connect, create, and connect-or-create. Selected record compilation also accepts correlated
update and upsert; optional storage accepts disconnect and typed target delete.
The locate exposes private storage columns only for verbs whose branch depends
on current membership.

Root createMany's BULK path accepts connect-only polymorphic memberships per
row. Its bulk preparation groups selectors by relation and stored discriminator,
resolves the private pair once per row, and preserves the existing contiguous
row-shape grouping. Count and returning operations use this same owner.

A row that also names an ordinary relation leaves that path entirely: the whole
operation becomes a record series (§9, §17), and the membership is then owned by
the member's own fresh-record compilation above — a different plan for the same
stored pair, correctly so, because a series member is one row and has nothing to
group across.

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

Field arity is checked when the membership's FIELDS are paired — the one owner —
and that pairing is lazy, so it still lands after the existing legality boundary.
Binding topology does not perform that check early. Attaching VALUES to already
paired members adds no second arity check: a source list is built by mapping the
members themselves, or over a reference list the pairing has already proven at
least member-length, so no member can bind a missing source. (An over-long
reference list — schema-invalid, unreachable through validation — binds its
paired prefix; correlated reads still refuse it.)

## 9. Fresh-record compiler

`CreateOperation` is the compiler for each fresh record subtree, including a
record-series member.

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
- database-produced field capture when requested;
- root insert construction;
- the one focused post-insert read a non-returning substrate needs to publish
  those fields;
- descendant order.

The nested fresh-record Part exposes:

- planning steps;
- compiled record steps;
- the root write ID;
- a referenced root field for consumers such as a junction insert.

It does not own the incoming relation's membership or found/missing decision.
The explicit inline junction-target insert remains local to the junction owner.

Database-produced field publication is demand-driven. A produced value is
requested when a descendant, an incoming edge consumer, a junction, or a terminal
result needs it, and requesting it is the ONLY way it is published: the request is
`rootReferenced(field)` and there is no flag, no source kind, and no second
record-reference abstraction beside it. An unrequested produced value does not
force a different insert shape.

A produced value is an absent `increment` column, which is the whole of what this
schema language leaves to the database — every other `autoGenerate` carries an
application default the parse boundary materializes. The generated primary key is
one such column and keeps its historical output name; any other takes its own
channel, so two produced columns of one record never share a value.

How the value travels is a substrate fact, decided once, at the demand:

- a returning provider in a transaction adds the column to the insert's own
  `RETURNING` list;
- a non-returning provider in a transaction keeps the insert and adds ONE focused
  read of every demanded field of that record, by the created-row selector the
  compiler already owns for its terminal read; the driver's insert id may NAME the
  row for that read and is never substituted for a non-identity value;
- an atomic batch refuses: no statement's rows are addressable and the reference
  scratch carries the generated identity alone.

Which providers can hold a produced NON-primary column is narrower than which
can publish one, and the engine does not decide it: PostgreSQL takes any number
per table, MySQL takes one and requires it to be a key, and the SQLite family
takes none, because its migration driver spells every auto-increment column as
the table's primary key. So the focused post-insert read is MySQL's path alone,
and on MySQL it always addresses its row by that row's own primary key — a
record with a generated key AND another produced column is a table with two auto
columns, which MySQL rejects.

Destination scalar casts are untouched by publication. They belong to the
consuming column, which sees a reference exactly as it saw the generated
identity's.

`createMany` keeps a specialized FAST PATH because row grouping, skip semantics,
and multi-row output folding are not one-record compilation. That path covers a
row whose data is scalars, and a row whose only relation work is a direct
polymorphic `connect` — the shape whose target probes group across rows.

A row carrying a general relation program is not compiled here at all. The whole
operation routes to `CreateManyRecordSeries`, whose members are ordinary
`CreateOperation` instances run left to right in one transaction, so a bulk row's
relation semantics are the single-record ones by construction rather than by a
second implementation. See §17 and plan §5.1.

A fresh parent stores post-insert groups in `CreateOperation`; a selected parent
delegates to `nested-target-parts.ts`; a junction retains target-row and join
ordering in `RelationJunctionPart`.

## 10. Selected-record compiler

`RecordUpdateCompiler` compiles one already-selected record update, including a
record-series member.

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

For a parent-held edge, it does own the inline FK fold and the branch required to
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

For a direct polymorphic mutation, its resolved payload edge overrides the
synthetic ordinary relation's analytical scope. Direct and inverse access then
compare the same exact discriminator-aware physical membership. A targetless
disconnect contributes one scope per configured storage member rather than a
wildcard.

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

Neither value depends on the locator. The old value of every reference-key
member comes from the `where` when it pins that member and from the located row
otherwise; the new value is derived from whichever one arrived, per member, at
compile when it cannot be spelled at construction. A locator that names some
other unique, a compound reference, and a non-primary-key referenced unique are
therefore the same shape as the pinned single member, not a separate surface.

A primary-key transition is not always a scalar write. When a parent-held
relation's foreign key is the selected record's own row key, the arm that
supplies that foreign key moves the record's key, and the payload names no
scalar. That fold is a transition like any other: it enters the same regime
decision, the same occupied guard, the same before/after ordering, and the same
terminal identity. The record compiler therefore answers "does this update move
the record's own key" from both channels — the scalar SET and the fold — and an
arm that resolves a row-key member to no single value is refused instead of
folded.

The read source is a required field of every membership-bearing config, never a
default that falls back to the write source. One construction site can then be
wrong about one edge, instead of every site being silently right only while no
transition reaches it.

Existing memberships the payload does not name are left alone. Where a real
foreign key with `ON UPDATE CASCADE` owns the effect — including both sides of an
implicit junction — the database carries them and the compiler orders the edge
writes before the root UPDATE so it can. Where the action does not cascade, an
occupied old slot is refused before any write rather than stranded. That refusal
belongs to the relation, not to the nested kind: it is the same verdict for a
`create` as for a `connect`, and it is the same verdict whichever unique the
locator named.

Occupancy is asked of a reference tuple that addresses a row. A tuple with a NULL
member addresses none — a foreign key compares under MATCH SIMPLE — so the guard
does not fire for it, and that is decided once rather than per substrate: a
planning probe binds a null pre-value as a parameter and an atomic unit's premise
resolves it to a literal `IS NULL`, and one payload must not get two verdicts for
the substrate it ran on.

## 15. Wrong-row protection

Selectors can include filters or values that the operation itself changes.
Re-evaluating that selector after planning can select a different row.

Therefore `RecordUpdateCompiler`, and every owner that passes it a captured
target:

1. captures the target's row key — every member of its primary key, in schema
   order — in its owner read;
2. carries those captured values through planning outputs;
3. writes, guards, and re-addresses by every captured member;
4. gives descendants and any outer post-write read that same row key.

`TargetProjection.identityFields` is that row key, and within this doctrine's
subject — `RecordUpdateCompiler` and the relation owners it serves — it is the
only source a captured record is addressed by: no such owner is handed one
primary-key field beside a projection, and no parallel row-key field survives
next to one. Two scalar names sit deliberately outside that rule:

- `RelationJunctionPart`'s stored side references (`targetReference`,
  `sourceReference` — the bound junction sides' single members) — the junction's
  stored reference to a target `getRequiredSinglePrimaryKeyField` already refused
  to key on more than one field. The carve-out is documented at
  `junctionSideMember` and both stored-reference declarations, and nothing new
  may read a row key through it.
- The root operations' own `parentPrimaryKeys` (`UpsertOperation`,
  `DeleteOperation`) — the row key of the record their public `where` names, not
  of a captured target handed to a compiler.

Asking the SCHEMA whether a field belongs to a model's key is a third question
again — topological, answered before any probe has published anything — and it
stays with `getPrimaryKeyFields`. A reference key the relation points at is a
different ordered key: it rides in `fields`, and bound relation topology — not
the projection — maps storage members onto it.

The wrong-row decoy tests are not optional detail. They prove that replacement
or selector drift cannot redirect an update. A compound row key needs decoys
that agree on ONE member, or a narrowing to the first member passes them.

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

- `createMany` over rows the bulk path expresses — scalar rows, and rows whose
  only relation work is a direct polymorphic `connect`;
- `updateMany` over data the bulk path expresses — scalar-only data;
- `deleteMany`;
- relation `set`;
- skip-duplicate grouping and capture;
- many-and-return output folds.

Bulk semantics include row grouping, optional zero matches, membership sets,
and output concatenation. A generic record compiler would hide those facts
rather than compress them.

What is NOT specialized is a `createMany` row carrying a general relation
program. Routing sends the whole operation to `CreateManyRecordSeries`, a record
series whose members are ordinary `CreateOperation` instances (plan §4.4, §5.1).
The reason is semantic, not architectural taste: row N may observe what row N-1
wrote in the same execution scope, which is what makes duplicate
`connectOrCreate` targets converge on one row. A pre-planned bulk form cannot
express that, and a second relation compiler for bulk rows would be the thing
this document exists to prevent. The empty payload and the two bulk shapes above
never reach the series, so their plans are unchanged.

On an interactive driver, `skipDuplicates` beside a general nested effect gives
each member one subtree-scoped savepoint. A unique conflict on the member's
ROOT write skips the complete subtree and never adopts or mutates the existing
row. Descendant conflicts and non-unique failures remain fatal. The skipped
member contributes neither a root count nor a public result row. D1 refuses
this combination before the first user write because its batch error cannot
attribute root versus descendant conflict precisely.

What is also NOT specialized is root `updateMany` whose data carries a general
relation program. Routing sends the whole operation to `UpdateManyRecordSeries`,
a record series that evaluates the public `where` and the provider `limit` ONCE,
locks and captures the complete root row keys, sorts them into a deterministic
engine order, and runs one ordinary `UpdateOperation` per captured root (plan
§4.4, §5.2). The reason is semantic: a parent-held fold belongs inside each
root's own `UPDATE`, a key transition needs that root's old value to address its
descendants and its new value to write them, descendant ordering is decided per
root, and a failure must be attributable to one captured root. One set-based
scalar `UPDATE` followed by relation Parts expresses none of that, which is why
the shape is forbidden here even though the returning bulk arm uses it correctly
for scalar-only data. Scalar-only data never reaches the series, so its plan is
unchanged, and neither does `limit: 0` — a cap of no rows writes nothing, so the
existing owner's empty plan is still the whole answer and it needs no
transaction.

`count` diverges by arm, deliberately. Scalar-only `updateMany` reports the
provider's affected-row total; the series reports the CAPTURED ROOT COUNT,
because members' writes are not one statement and a provider that counts changed
rows rather than matched rows (MySQL, which sets no `CLIENT_FOUND_ROWS`) would
otherwise answer zero for a no-op assignment.

A root membership that lives on the TARGET row and NAMES AN EXISTING TARGET —
child-held `connect`, `connectOrCreate`, `set`, including a supplier composed
with a modifier — is refused before the first write when the capture found more
than one root, naming the observed count. One target holds one parent, so
applying it to N roots in sequence would leave the last root owning the child and
the rest silently not. Junction and parent-held equivalents are meaningful for
every root and execute; so does `create`, which makes one fresh child per root,
and so do the EMPTY spellings of the three verbs (`set: []` means "this root
keeps no targets", a per-root fact with no contention in it). Which shapes
qualify is the relation legality owner's question, not the series shell's; the
shell knows only the count.

The refusal covers the ROOT's own relation keys. A membership move a fresh
DESCENDANT carries — `{ posts: { create: { comments: { connect } } } }` — runs
once per root and leaves the shared target under the last root's fresh child.
That is not refused, because at that depth the series does exactly what the same
payload spelled as N ordinary `update` calls does; refusing it would make the
bulk spelling reject what the single spelling executes. Measured and pinned as
behavior rather than inferred.

Nested bulk follows the same split. Scalar-only nested `createMany` and
`updateMany` remain set-oriented and grouped. A relation-bearing nested
`createMany` lowers each row through `CreateOperation` in input order. A
relation-bearing nested `updateMany` captures its exact correlated target keys
at the operation's ordered position, sorts complete row keys, and invokes
`RecordUpdateCompiler` once per captured target. Both are placed by one
`RecordSeriesStep`; the outer fragment resumes only after the series completes.
The enclosing relation Part still owns membership, target capture, guards, and
placement. The N-greater-than-one named child-held move refusal applies at this
level too.

Both root series' returning arms collect each member's final complete row key,
then `series-result-read.ts` builds K bounded set reads, normally one. It counts
the compiled bind values against the driver-owned parameter budget, indexes
decoded rows by complete key, restores source order, replays duplicate keys,
and strips key fields injected only for correlation. Missing rows keep the
existing exact failure rather than silently shortening the result. On the
create side a later member can move an earlier member's row key. On the update
side later nested effects can also delete a captured root. The `{ count }` arm
of the same payload still answers the completed or captured root count.
Grouping changes result transport only; it does not remove compiler terminal
reads or change member planning.

Execution substrate is separate from series meaning:

- a transaction-capable root series runs in one operation-wide transaction;
- a nested `RecordSeriesStep` reuses that already-open transaction;
- D1 can execute a ROOT dynamic series as ordered committed atomic member
  batches. A later failure keeps the committed prefix and carries exact
  `recordSeriesProgress`; no retry replays a committed segment;
- D1 can execute a nested `RecordSeriesStep` only when the relation placement
  supplies the exact complete-parent or membership guard that is repeated in
  every later write batch. An unguardable placement refuses before its
  containing member writes; earlier progressive root members can already be
  committed and are reported. Relation-bearing `skipDuplicates` and a dynamic
  series inside explicit `$transaction([...])` refuse before member 0 writes;
- D1's official per-statement `meta.last_row_id` enters the existing
  `QueryResult.insertId` channel. It can publish one concrete generated integer
  identity across a segment boundary; it never permits ID-range inference;
- other substrates that cannot provide either interactive execution or the D1
  ordered-commit contract refuse the series.

Nested relation-bearing `updateMany` reparses the retained source update data
once per captured target through the exact projected nested-update schema. It
does not feed transformed output back into validation. An untaken top-level
upsert update arm remains inert because capture and replay occur only after that
arm is selected. Relation `set` is independent of membership clearability:
optional storage emits departures, while required storage guards that the
departing set is empty.

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

Within the relation transforms themselves, preserve the two passes: every
ordinary relation payload is transformed before any polymorphic one, so a mixed
malformed payload reports the same `ValidationError` first. That grouping is
also the parsed collection's order (§5), so one fact serves both.

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
- A targetless direct polymorphic `disconnect` alone makes a selected-record
  update non-empty: it is an entry in the parsed collection, so the emptiness
  gate counts it without consulting a second map.
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
