# Query-Engine Distinct-Truth Compression Plan

**Date:** 2026-08-11  
**Status:** Proposed follow-up to the completed limitation lift; rebased on the
closing lift commit `7a05d156`. Execute from a clean worktree because unrelated
client/result WIP remains dirty in the shared workspace.  
**Scope:** Internal architecture only; no public query API change

## 1. Executive summary

The next useful compression target is not another mutation verb and not a
smaller spelling of the current code. It is the number of independent places
that claim to know the same domain fact.

The query engine currently has several strong atoms:

- `RelationMutationProgram` owns parsed relation-request meaning.
- `CreateOperation` owns one fresh record subtree.
- `RecordUpdateCompiler` owns one selected-record update.
- `TargetProjection` owns compound-safe capture of an already selected row.
- Demand-driven fresh-field publication owns values requested from a row being
  created.
- `RecordSeriesOperation` owns the data-dependent sequence of ordinary record
  operations that cannot fit one planning fragment.
- `BoundRelation` owns much of write-side relation topology.
- Field-bound planning and final sources own value provenance.

The remaining complexity comes mainly from facts that are reconstructed after
those boundaries:

- Relation position, cardinality, and physical storage are encoded together in
  cross-product `BoundRelation.kind` names.
- Junction topology is rediscovered outside `BoundRelation` by a second binder.
- Primary and addressable model keys are derived independently and sometimes
  flattened into misleading “identity fields”; exact reference legality is a
  separate schema/provider fact that must not be absorbed into that catalog.
- Physical membership is represented separately for topology, OwnWrite, and
  execution.
- Ordinary and direct-polymorphic mutation programs travel through parallel
  collections that consumers must correlate by name.
- Inverse-edge discovery and nested mutation availability are independently
  derived by schema types, runtime schemas, schema validation, and the query
  engine.
- Planning outputs, selection meaning, result transport, and failure
  materialization retain smaller duplicate owners.
- Record-series routing and result aggregation have introduced a few local
  derivations that later phases must either absorb or justify explicitly.

The desired outcome is:

~~~text
one stored fact
        ↓
several deliberately derived views
~~~

not:

~~~text
several modules independently rediscovering the same fact
~~~

This plan should remove approximately 8–15 named carriers, helpers, or
cross-product variants. A net production reduction remains expected, but the
former 500–900 physical-line estimate is no longer a reliable gate. Report
executable token-bearing reduction separately from doctrine/comment cleanup.
The primary gates are fewer semantic owners, fewer topology branches, and fewer
representations that can disagree.

The completed lift delivered Packages A–K, M, N, and O. Both Package L nested
series prototypes were rejected on proof and left no compatibility layer. Its
compound-safe `TargetProjection`, transition provenance, record series,
to-one composition lattice, bulk record shells, and guard-ownership ledger are
prerequisites or evidence for several phases below.

The final committed lift moved the query engine from 39,022 to 42,281 physical
TypeScript lines and from 30,196 to 31,299 token-bearing lines. Of the 3,259
added physical lines, approximately 2,156 are comments or spacing. The semantic
increase is therefore about 1,103 token-bearing lines. In parallel, write-engine
`UnsupportedOperationError` construction sites fell from 31 to 15 and now
express ten distinct write-engine invariants. These are the Phase 0 baseline
figures, not acceptance quotas.

## 2. Method used to reach these recommendations

### 2.1 Start from unavoidable facts

The audit began by naming the facts the engine cannot eliminate:

- A model has ordered keys with different legal uses.
- A relation has public cardinality.
- A relation membership is stored somewhere.
- A stored reference maps ordered storage members to ordered target members.
- A mutation request has an ordered meaning.
- A particular operation binds topology to runtime value sources.
- Execution is either one fixed planning/final fragment or a data-dependent
  transactional series of ordinary record operations.
- A selected record may need fields captured from a read, while a fresh record
  may need database-produced fields published from its write.
- Execution has planning, effects, failures, and published results.

These are requirements. Type names, modules, optional bags, and switch branches
are representations. A representation is justified only when it gives one of
those facts one clear owner or prevents an invalid state.

### 2.2 Trace each fact across trust boundaries

For each fact, the audit followed it through:

~~~text
schema declaration
  → definition validation
  → type-level operation schema
  → runtime operation schema
  → parsed mutation program
  → bound relation topology
  → OwnWrite analysis
  → record compiler / relation Part
  → SQL construction
  → execution and result parsing
~~~

Every place that independently reconstructed the fact was recorded as a
possible second owner. Mere data transport was not counted as ownership.

### 2.3 Look for cross-product names

Names such as:

~~~text
childHeldToOne
childHeldToMany
polymorphicChildHeldToOne
polymorphicChildHeldToMany
~~~

show that independent dimensions have been multiplied into variants. Consumers
then decode those variants with repeated lists. This is a stronger smell than
ordinary duplicated syntax because every new dimension multiplies future
branches.

The current tree contains roughly 58 direct `relation.kind` decisions. Many ask
only one of three questions:

- Who stores the membership?
- Is the public slot singular?
- Which physical representation stores the membership?

Those questions should not require decoding one combined name.

### 2.4 Look for empty owners and second binders

`JunctionRelation` currently carries little junction topology, while
`getManyToManyJoinInfo()` reconstructs it for approximately 16 query-engine call
sites. That is evidence that the nominal topology owner is incomplete and a
second owner has formed around it.

The same test was applied to model keys, membership scopes, inverse resolution,
parsed relation programs, planning outputs, and selection/result traversal.

### 2.5 Distinguish duplication from legitimate projections

Not every repeated-looking type is redundant.

TypeScript type-level validation and runtime validation cannot literally share
one executable implementation in a zero-codegen ORM. The correct target is one
semantic owner with adjacent type-level and runtime projections, proven to
agree through public type probes and runtime validation tests.

Likewise, these distinctions are intentional:

- Planning references are weaker than final references.
- Guards, postconditions, and race pins represent different evidence and timing.
- Direct polymorphic intent is payload-selected; inverse polymorphic intent is
  schema-fixed.
- Scalar bulk execution and per-record transactional fallback have different
  performance and semantics.
- Row keys and membership keys answer different questions.
- `TargetProjection` captures fields from an already selected row; fresh-field
  publication exposes demanded values from a row being created.
- `OperationFragment` and `RecordSeriesOperation` are distinct execution forms:
  one has a fixed planning phase, while the other's member count and member
  planning are known only after capture.

The plan keeps those distinctions.

### 2.6 Apply via negativa

Every proposed abstraction was tested by asking what it deletes:

- Which second constructor disappears?
- Which parallel carrier disappears?
- Which repeated branch list disappears?
- Which guard becomes impossible?
- Which future special case becomes an ordinary member of an ordered structure?

An abstraction that merely moves branches behind a helper, introduces a
strategy table, or adds a generic context bag fails this test.

### 2.7 Use falsifiers, not aesthetic confidence

Each phase below starts with parity witnesses and ends with deletion gates.
Foundation code is retained only when its consumers migrate and the previous
owners disappear. Exact SQL, parameters, step IDs, result shapes, guards, pins,
errors, and round trips remain compatibility facts.

## 3. Audit findings

### 3.1 Relation topology has multiple owners

Physical M2M topology is currently distributed across:

- `JunctionRelation` in `builders/relation-data-builder.ts`.
- `ManyToManyJoinInfo` and `getManyToManyJoinInfo()`.
- `RelationMembershipScope.manyToMany`.
- OwnWrite endpoint orientation.
- `RelationJunctionPart` scalar source/target channels.
- Include, filter, and count builders.

This should become one bound junction topology with two ordered sides.

### 3.2 `BoundRelation.kind` combines independent axes

The current union mixes:

- storage position;
- public cardinality;
- physical membership representation.

The repeated paired checks for ordinary/polymorphic and to-one/to-many are a
direct consequence. These axes should be explicit and orthogonal while the
union still prevents impossible combinations.

### 3.3 Model-key language and ownership are inconsistent

The current engine has several partially overlapping derivations:

- `getPrimaryKeyFields()` returns the primary row key.
- `getCanonicalIdentityFields()` independently rediscovers it for cursors.
- `getTargetIdentityFields()` flattens fields from all addressable unique keys;
  it does not return one identity.
- `getForeignKeyTargetFields()` supplies a wider conservative field view for a
  fold decision; it is not the exact schema/provider FK-legality owner.

Flattening loses compound-key grouping and order. The engine needs one ordered
model-key catalog for row addressing and public unique selection, plus an
explicit conservative overlap view. Validated stored references keep their
ordered target key, while exact referenceability remains with schema/provider
validation.

### 3.4 Physical membership is represented three times

An ordinary or polymorphic association appears as:

1. bound relation topology;
2. an analytical `RelationMembershipScope` for OwnWrite;
3. a source-bound `RelationMembershipBinding` for execution.

The analytical and executable views should be derived from one physical
topology. Runtime sources are added afterward.

### 3.5 Parsed relation programs use parallel collections

`ParsedRecordPrograms` carries ordinary programs and direct polymorphic intent
in separate maps. Record compilers and OwnWrite must correlate them by relation
name. This creates a synchronization obligation and has already required exact
membership overrides.

One ordered parsed-relation collection should retain mutation meaning together
with the minimum payload-resolved intent needed by later topology binding.
`RelationMutationProgram` itself remains topology-free.

### 3.6 Inverse resolution and nested mutation schemas are duplicated

Inverse-edge matching exists in schema relation types, validation schema types,
runtime schema factories, polymorphic validation, and query-engine binding.

Polymorphic inverse operation schemas also reproduce much of the ordinary
to-one/to-many verb surface. The largest clone is in
`src/validation/relations/index.ts`.

One schema-owned inverse resolution fact and one relation-owned nested-data
projection can let existing cardinality factories own verbs once.

### 3.7 Read builders rediscover topology

Include, relation filter, count, and order-by builders still branch on raw
`RelationInfo.type`, `isToOne`, and `isToMany`, while write-side code uses
`BoundRelation`.

They should share one physical traversal description while retaining their
distinct aggregation, lateral join, windowing, negation, and ordering logic.

### 3.8 Planning publication has a redundant owner

Every production planning fragment currently republishes all declared step
outputs through `planningOutputs(steps)` or publishes no outputs. No production
operation selects a custom planning-output subset.

Planning output publication can therefore be derived automatically from steps.
Final operation output publication remains explicit.

### 3.9 Projection meaning is independently traversed

Selection meaning is interpreted by:

- `select-builder.ts` and include builders for SQL;
- `result/result-shape.ts` for result parsing;
- write-engine projection helpers for relation presence and mutation-read
  footprints.

The existing `SelectResult` is a likely seed for one compiled selection fact.
This is a later, high-proof prototype because it crosses read, write-fold, and
result boundaries.

### 3.10 Result and failure transport contain smaller duplicates

- Internal `*ManyAndReturn` pseudo-operation names cause operation/result truth
  tables across routing, validation, D1 handling, parsing, and errors.
- Final fragments publish at most one logical result through stringly `result`
  or `count` output names.
- `Failure → Error` conversion is duplicated between normal execution and batch
  attribution.
- A second test-only pending/batch lifecycle appears to have no production
  consumer.
- The low-level update SQL builder retains a relation interpreter below the
  canonical relation-program and record-compiler boundaries.

These are independent cleanup units. They must not be used to justify a generic
execution AST.

### 3.11 The limitation lift added one necessary execution truth

`RecordSeriesOperation` is the correct second execution form for relation-bearing
bulk work. A fixed `OperationFragment` cannot represent a data-dependent number
of record operations when each record owns its own planning and branch
selection. The compression pass must retain the series form rather than hiding
it inside Parts, callbacks, or a transaction AST.

`CreateManyRecordSeries` and `UpdateManyRecordSeries` are operation shells over
that one execution form. They own different capture, count, and result contracts;
they are not two additional execution concepts and must not be merged through a
generic bulk strategy.

The lift also exposed smaller duplicate derivations:

- `CreateManyRecordSeries` and `UpdateManyRecordSeries` derive row-key
  selections independently.
- Raw `createMany` and `updateMany` routing detect relation-bearing data before
  the selected series later parse the same payload.
- Series result aggregation uses the `createManyAndReturn` and
  `updateManyAndReturn` pseudo-operations.
- PostgreSQL CTE folding independently discovers `OperationValueReference`
  dependencies.
- CTE returning construction adds another interpretation of selected
  polymorphic storage columns.

These are not reasons to remove the series. They are consumers that the model-key,
parsed-program, reference-extraction, selection, and result-transport phases must
include.

The parallel ordinary/polymorphic parsed maps also have a historical correctness
falsifier, not only an aesthetic cost. Before Package K, nested `updateMany`
scalar parsing inspected ordinary relation programs and silently dropped
direct-polymorphic intent. The lift closed the route through one
`relationWriteKeys(parsed)` owner that reads both maps and makes nested bulk fail
closed. Phase 6 must preserve that proof while replacing the synchronization
obligation itself with one parsed collection.

Package L established the execution boundary by falsification: a record series
cannot live inside an `OperationFragment` or relation Part because the fragment
has already spent its single planning phase before a data-dependent nested
capture could construct its members. Do not retry that design through callbacks,
nested executors, lifecycle hooks, or a universal transaction AST. A future
nested-bulk capability needs a deliberate desugaring or a new truthful
operation-level composition, not hidden series nesting.

## 4. Target domain model

### 4.1 Model keys

~~~ts
interface OrderedModelKey {
  readonly kind: "primary" | "unique" | "compoundUnique" | "uniqueIndex";
  readonly name?: string;
  readonly fields: readonly string[];
}

interface ModelKeyCatalog {
  readonly rowKey?: OrderedModelKey;
  readonly addressableKeys: readonly OrderedModelKey[];
  readonly uniqueOverlapFields: readonly string[];
}
~~~

Rules:

- `rowKey` is the complete primary key in schema order.
- `addressableKeys` are exact keys accepted by public unique selectors.
- `uniqueOverlapFields` is a conservative flattened view used only when a
  consumer needs to ask whether two selectors may overlap.
- Compound keys remain grouped and ordered. Never reduce the catalog to one set
  of field names.
- Exact reference legality remains with schema/provider validation. The catalog
  does not claim that every addressable key is a portable FK target.
- Partial/provider-specific unique-index behavior preserves the current schema,
  migration, and conservative fold truths; the query engine does not invent
  portability.

This is the intended identity compression: the catalog says how a row can be
addressed, a validated stored reference chooses one ordered target key, and a
membership may add fixed qualifiers such as a discriminator. It does not force
row identity, reference identity, and relation membership into one universal
tuple.

### 4.2 Bound relation axes

The exact final spelling may adapt to existing names, but the semantic axes are
fixed:

~~~ts
interface BoundRelationBase {
  readonly relationInfo: RelationInfo;
  readonly sourceModel: Model<any>;
  readonly cardinality: "one" | "many";
}

type BoundRelation =
  | (BoundRelationBase & {
      readonly position: "parentHeld";
      readonly cardinality: "one";
      readonly membership: BoundForeignKeyMembership;
    })
  | (BoundRelationBase & {
      readonly position: "childHeld";
      readonly cardinality: "one" | "many";
      readonly membership:
        | BoundForeignKeyMembership
        | BoundPolymorphicMembership;
    })
  | (BoundRelationBase & {
      readonly position: "junction";
      readonly cardinality: "many";
      readonly membership: BoundJunctionMembership;
    });
~~~

This remains a discriminated union. It does not permit parent-held to-many or
junction to-one states.

### 4.3 Physical membership topology

~~~ts
interface BoundForeignKeyMember {
  readonly foreignField: string;
  readonly referencedField: string;
}

interface BoundForeignKeyMembership {
  readonly kind: "foreignKey";
  readonly holder: Model<any>;
  readonly referenced: Model<any>;
  readonly members: readonly BoundForeignKeyMember[];
  readonly onUpdate: ReferentialAction | undefined;
}

interface BoundPolymorphicMembership {
  readonly kind: "polymorphic";
  readonly holder: Model<any>;
  readonly referenced: Model<any>;
  readonly storage: PolymorphicStorage;
  readonly storedType: string;
  readonly referencedField: string;
}

interface JunctionReferenceMember {
  readonly junctionField: string;
  readonly referencedField: string;
}

interface JunctionSide {
  readonly model: Model<any>;
  readonly members: readonly JunctionReferenceMember[];
}

interface BoundJunctionMembership {
  readonly kind: "junction";
  readonly table: string;
  readonly source: JunctionSide;
  readonly target: JunctionSide;
}
~~~

Rules:

- Ordinary compound FKs are multiple ordered foreign-key members.
- Polymorphic membership keeps the discriminator as a fixed qualifier, not a
  referenced key member.
- Junction membership is two complete ordered references.
- The first migration may bind one-member junction sides only. The shape must
  not encode scalarity.
- Direct and inverse polymorphic intent remain different, but may resolve to the
  same physical membership type.
- Do not create a generic `StorageMember` union spanning model fields, private
  columns, and junction columns. Exact storage variants remain valuable.

### 4.4 Source-bound membership

~~~text
Bound membership topology
  + per-member planning read sources
  + per-member final write sources
  = source-bound membership
~~~

The existing `PlanningReferenceSource`, `FinalReferenceSource`,
`ForeignKeyMember`, and `CorrelatedForeignKeyMember` are the starting point.
The compiler binds sources once. Relation Parts consume the resulting binding
without receiving separate scalar parent IDs or reconstructing transitions.

OwnWrite derives its stable analytical key from bound membership topology. It
does not reconstruct holder, referenced model, field pairing, discriminator, or
junction orientation.

### 4.5 Parsed relation mutations

`RelationMutationProgram` remains the payload-semantic representation.

Replace parallel record maps with one ordered collection similar to:

~~~ts
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
~~~

Binding ordinary topology remains lazy and occurs at the current first topology
decision. Untaken upsert arms remain inert. The collection preserves the
post-lift effective collection order, per-payload array order, and relation
mutation entry order. This refactor does not normalize execution to declaration
order.

The collection must also preserve a to-one mutation's accepted ordered
composition after Package H. A consumer may not restore an
`entries.length === 1` assumption after the public lattice accepts several
ordered operations.

### 4.6 Resolved inverse relation

One schema-layer resolver owns candidate discovery and resolution:

~~~ts
type ResolvedInverseRelation =
  | {
      readonly kind: "ordinary";
      readonly relationKey: string;
      readonly fields: readonly string[];
      readonly references: readonly string[];
      readonly onUpdate: ReferentialAction | undefined;
    }
  | {
      readonly kind: "polymorphic";
      readonly relationKey: string;
      readonly publicType: string;
      readonly storedType: string;
    }
  | { readonly kind: "missing" }
  | {
      readonly kind: "ambiguous";
      readonly candidates: readonly string[];
    };
~~~

The resolver owns matching facts, not errors or execution policy. Definition
validation translates missing/ambiguous results into schema errors. Operation
schemas derive child-data projection. `bindRelation()` derives physical
membership.

### 4.7 Nested relation-data projection

The semantic owner answers:

~~~text
Which child create/update/createMany inputs remain after the enclosing relation
supplies this membership?
~~~

For an ordinary inverse, it omits the owning FK fields. For a polymorphic
inverse, it omits the direct polymorphic relation and records that the enclosing
relation satisfies that required membership.

Type-level and runtime forms remain adjacent projections of this rule. Existing
to-one and to-many factories continue to own verbs, arity, and composition.

### 4.8 Planning and final publication

~~~ts
interface PlanningFragment {
  readonly steps: readonly StatementStep[];
}
~~~

The executor derives every planning output from statement declarations. Final
fragments keep explicit logical result publication.

This rule also applies to `RecordSeriesOperation.capture()`. The series remains a
separate execution form; automatic publication removes only its explicit output
map, not its capture/member/result phases.

### 4.9 Later compiled selection fact

Promote the existing `SelectResult` only if the prototype proves that it can
truthfully carry:

- SQL projection/pairs;
- exact expected result shape;
- whether relations are projected;
- the mutation read footprint needed by fold eligibility.

SQL builders and `ResultParser` consume this compiled fact. It is not a query
AST, renderer strategy, or generic projection DSL.

### 4.10 Fresh publication and selected capture

These remain two owners:

- `TargetProjection` declares fields required from an already selected row.
- Fresh publication declares database-produced fields demanded from a row being
  created.

Both consume ordered model-key and stored-reference metadata. They do not share
a universal identity/value carrier because their timing, availability, and
failure modes differ.

### 4.11 Execution forms

~~~ts
type RoutedExecutableOperation =
  | ExecutableOperation
  | RecordSeriesOperation;
~~~

`ExecutableOperation` retains one fixed planning/final fragment. A
`RecordSeriesOperation` captures a root set, constructs ordinary record
operations, runs them in one interactive transaction, performs final reads, and
aggregates the public result. It adds no runtime step kind.

The series is transaction-only by construction. It does not need a second
`mode: "transaction"` fact once `executionKind: "recordSeries"` selects this
execution form.

A series is operation-level and cannot be nested in an `OperationFragment`,
Part, or another series. The rejected Package L prototypes are the proof for
this boundary. Preserve root `createMany` and `updateMany` series; do not turn
the series into a generic recursive execution tree.

## 5. Compatibility contract

For every currently accepted operation, preserve:

- public input and result types;
- validation and error timing;
- SQL and parameter order;
- planning and final step IDs;
- planning dependencies and outputs;
- execution order;
- guards, postconditions, and race pins;
- error class, message, metadata, and retry classification;
- statement count and round trips;
- direct, `RETURNING`, `ON CONFLICT`, CTE, planning-batch, atomic-batch, and
  scalar bulk fast paths;
- provider-specific destination casts and generated-identity behavior.

For record series, also preserve:

- capture semantics and locked target-set meaning;
- construction of every ordinary record member before its first effect;
- outer transaction and retry ownership;
- per-member planning and branch timing;
- left-to-right `createMany` semantics in which row N observes row N−1 and may
  move a membership that an earlier row wrote;
- one-time `updateMany` capture followed by deterministic selected-record
  updates, with count equal to captured roots rather than affected-row sums;
- final-read ordering and series result aggregation;
- current provider-local ordering of decoded compound row-key members;
- refusal from prepared and atomic-batch execution paths.

This plan does not itself add:

- compound M2M public support;
- nested relation-bearing bulk or nested record series;
- the produced-identity selector channel for child-held `create + update` and
  `connectOrCreate + update`;
- a product contract for `skipDuplicates` plus nested effects;
- a new relation verb;
- a runtime step kind;
- an adapter relation API;
- a mutation DSL;
- a query AST;
- a capability strategy table;
- lifecycle hooks or placement callbacks;
- referential-action emulation;
- a universal identity/value tuple.

`RecordSeriesOperation` is an accepted execution fact, not a runtime step or a
generic transaction language. Fresh-field publication and selected-row capture
also remain distinct facts.

Keep these post-lift guards as named distinct invariants unless their stated
replacement representation lands:

- N greater than one with root child-held `connect`, `connectOrCreate`, or
  non-empty `set` in `updateMany`;
- `skipDuplicates` with relation-bearing root rows;
- nested relation-bearing `updateMany` data;
- compound M2M until bound junction sides become compound-capable;
- a producing to-one supplier followed by selected update until the produced
  target can address `RecordUpdateCompiler`.

## 6. Execution protocol

### 6.1 Precondition

Begin from `7a05d156` or a clean descendant containing no unrelated client,
result-parser, benchmark, or validation WIP. The shared workspace was dirty when
the lift closed and those changes can make layer runners exhaust their heap even
though a clean lift worktree passes at the same cap.

Re-audit live names and counts before editing. Treat the existing D1/workerd
failure caused by `@paralleldrive/cuid2` top-level initialization as a recorded
external baseline failure, not as a passed suite and not as a compression
regression.

### 6.2 Preflight

Record:

~~~bash
git status --short
git rev-parse HEAD
git rev-parse --abbrev-ref HEAD
~~~

Preserve unrelated dirty and untracked files.

Measure:

- query-engine physical and token-bearing LOC;
- `relation.kind` branch count;
- raw `RelationInfo.type`, `isToOne`, and `isToMany` branch count;
- `getManyToManyJoinInfo()` call count;
- inverse resolver implementations;
- ordinary/polymorphic child-dispatch implementations;
- planning-output publication call count;
- record-series row-key, routing, planning-output, and result-parser consumers;
- statement-reference discovery implementations;
- selection interpretations, including CTE returning construction;
- write-engine runtime import cycles;
- three warm `pnpm test:types` timings and median.

Run the green baseline sequentially through repository launchers:

~~~bash
pnpm test:types
pnpm test:layer:query-engine
pnpm package:build
pnpm test
~~~

### 6.3 Change discipline

- Implement phases in order unless a phase is explicitly independent.
- Treat every numbered unit as one reversible commit.
- Use `apply_patch` for edits.
- Never use `git reset` or `git checkout` to remove a failed prototype.
- If one phase fails its keep gate, remove only that phase with `apply_patch`,
  record the reason, and continue independent later phases.
- Do not retain compatibility aliases after all consumers migrate.
- Do not add a guard unless its unique failure is named and falsified.
- Keep type/runtime schema projections adjacent.
- Use memory-capped test launchers sequentially. Never overlap Vitest or
  TypeScript runs.

### 6.4 Per-unit proof

Each unit must include:

- focused parity witnesses before production edits;
- static searches proving old owners disappeared;
- `pnpm test:types` when TypeScript changes;
- the affected `pnpm test:layer:*` scripts when architecture changes;
- the narrowest affected runtime layer.

### 6.5 Dependency map

| Phase | Requires | Exit proof |
|---|---|---|
| 0. Census | Stable limitation lift | Live names, counts, timings, and parity witnesses |
| 1. Model keys | Phase 0 | Grouped row/addressable keys; misleading identity helpers gone |
| 2. Inverse resolution | Phase 0 | One runtime inverse resolver; public type/runtime parity |
| 3. Junction topology | Phases 1–2 | `ManyToManyJoinInfo` second binder gone |
| 4. Relation axes | Phases 2–3 | Cross-product topology variants gone |
| 5. Physical membership | Phase 4 | OwnWrite/execution views derive from bound topology |
| 6. Parsed mutation dispatch | Phase 5 | Parallel relation maps and duplicate child dispatch gone |
| 7. Read traversal | Phases 3–5 | Include/filter/count/order use one physical traversal source |
| 8. Relation capabilities | Phase 2 | Existing verb factories consume one nested-data projection |
| 9. Execution cleanup | Phase 0 | Each independent unit deletes its named second owner; record series remain distinct |
| 10. Compiled selection | Phases 7 and 9 | Five selection interpretations gain one owner or a documented distinct role, or prototype is removed |
| 11. Result transport | Retained Phase 10 | One discriminated result owner replaces old operation sets, including series aggregation |
| 12. Finalization | All retained phases | Static gates, doctrine, census, and full validation |

## 7. Phase-by-phase implementation plan

### Phase 0 — Refresh the live architecture census

#### Unit 0.1 — Pin the post-lift baseline

Actions:

1. Re-run the structural census from the closing lift commit. Expected starting
   values are 118 query-engine files, 42,281 physical lines, 31,299
   token-bearing lines, 1,572 functions, 3,658 branch nodes, one existing
   six-file query-engine runtime cycle, and zero write-engine runtime cycles.
2. Update stale paths and symbol names in this document only where live code
   differs.
3. Record existing fast-path SQL and fragment witnesses for:
   - scalar and compound ordinary FK;
   - direct and inverse polymorphic membership;
   - scalar M2M, including self-relations;
   - selected to-one and to-many updates;
   - include, relation filter, relation count, and relation order;
   - transaction and atomic-batch execution;
   - record-series capture, member order, rollback, and final reads;
   - PostgreSQL dependency CTE folding and portable transactional fallback.
4. Pin one target whose primary row key differs from its compound reference key.
5. Pin the current nested `updateMany` direct-polymorphic behavior at the shared
   `relationWriteKeys(parsed)` owner. It must reject before effects; restoring a
   map-local check that silently omits polymorphic intent is forbidden.
6. Record the final guard baseline: 15 write-engine construction sites,
   expressing ten write-engine invariants, with every survivor linked to the
   guard-ownership ledger and its unique falsifier.

Recorded closing-lift proof, to be reproduced or explicitly superseded:

- `pnpm test`: 215 files and 5,046 tests passed.
- write-engine coverage: 3,098 tests passed.
- PostgreSQL CTE dependency folds reduced measured 3/4/3-statement create trees
  to one statement.
- clean-worktree production type surface regressed 1.08%; the larger
  whole-project increase was attributed to added tests and unrelated dirty WIP.
- live MySQL, pg, postgres, and transaction-option contracts passed by count;
  Neon and PlanetScale were skipped for missing credentials.
- D1 remained red only on the reproduced upstream workerd/cuid2 initialization
  failure.

Keep gate:

- No production change.
- The baseline is green.
- Every later deletion has an owning witness.

Suggested commit:

~~~text
test: pin distinct query engine truths
~~~

### Phase 1 — Give model keys one owner

Post-lift state:

- `TargetProjection.identityFields` now carries the complete ordered selected
  row key, including compound primary keys.
- The scalar `childPrimaryKey` channel is deleted.
- Both `CreateManyRecordSeries` and `UpdateManyRecordSeries` still derive their
  own row-key selections through `getPrimaryKeyFields()`.
- Cursor, selector overlap, conflict fallback, and stored-reference consumers
  still derive related key facts independently.

#### Unit 1.1 — Add ordered key-catalog contracts

Owner:

- schema/model metadata and the existing query-context key helpers.

Actions:

1. Add table-driven tests for:
   - scalar primary key;
   - compound primary key order;
   - scalar unique;
   - named compound unique;
   - partial/provider-specific unique-index overlap behavior;
   - mapped fields;
   - no primary key;
   - multiple independent unique keys.
2. Build `ModelKeyCatalog` once from model metadata.
3. Cache only if the model metadata is immutable and cache ownership is already
   established.
4. Preserve exact constraint names and schema field order.

Do not flatten compound keys.

#### Unit 1.2 — Migrate row-key consumers

Migrate:

1. `getPrimaryKeyFields()` consumers.
2. cursor canonical tie breakers.
3. `TargetProjection.identityFields`.
4. mutation result refetch.
5. unique-conflict primary fallback.
6. `CreateManyRecordSeries.rowKeySelect`,
   `UpdateManyRecordSeries.identityFields`, and record-series target ordering.

Delete `getCanonicalIdentityFields()` after its final consumer migrates.

#### Unit 1.3 — Migrate addressability and conservative overlap

Actions:

1. Replace `getTargetIdentityFields()` with an accurately named derived view of
   `uniqueOverlapFields`.
2. Preserve `TargetConstraint`'s conservative overlap behavior.
3. Make where-unique building consume grouped addressable keys.
4. Leave exact FK legality with its schema/provider validation owner; consume
   an already validated ordered stored reference downstream.
5. Preserve the existing conservative fold behavior for partial/provider-specific
   unique indexes.
6. Add public-client type probes for scalar and grouped compound unique
   selectors: accepted fresh and non-fresh values, unknown members beside a
   real member, and retained compile-success pins at any documented depth
   ceiling. Internal catalog aliases do not count as public-surface proof.

Static gate:

~~~bash
rg -n "getCanonicalIdentityFields|getTargetIdentityFields" src
~~~

No production reference remains.

Keep gate:

- No compound key is flattened before a consumer explicitly requests a field
  set.
- Cursor, selector, conflict, and FK behavior is unchanged.
- Record the warm type-check delta; investigate a reproducible regression above
  5% instead of treating measurement noise as an architectural failure.
- Production concepts decrease; no generic key strategy is introduced.

Suggested commit:

~~~text
refactor: centralize ordered model keys
~~~

### Phase 2 — Give inverse resolution a schema owner

This phase precedes topology migration so `bindRelation()` and read traversal
consume the final inverse fact rather than being migrated around a scanner that
is deleted later.

Post-lift state: `getInverseRelationMap()` and `findInverseRelationState()` now
agree on name disambiguation, but still disagree on empty `.fields()`:
validation treats an existing empty tuple as fields-bearing while the engine
requires `fields.length > 0`. The retained owned-FK guard exists because that
disagreement leaves one trusted bypass. Aligning the filters is the concrete
retirement condition; do not delete the guard first.

#### Unit 2.1 — Pin inverse-resolution parity

Before changing production code, cover:

- named and unnamed inverse;
- missing inverse;
- ambiguous inverse;
- self-relation;
- repeated target model;
- ordinary and polymorphic candidates together;
- fields-bearing and fields-less one-to-one;
- absent, empty, and non-empty `.fields()` tuples;
- compound FK/reference order;
- multiple polymorphic relations on one model;
- lazy/circular model definitions.

Pin definition errors and their timing separately from successful resolution.

#### Unit 2.2 — Add the schema-owned resolver

Implement one runtime resolver in `src/schema/relation`. It returns
`ResolvedInverseRelation` and throws no query-engine or operation-schema error.

Migrate:

1. schema definition validation;
2. existing ordinary inverse mapping helpers;
3. polymorphic inverse binding;
4. operation-schema runtime factories;
5. query-engine `bindRelation()`.

Keep the type-level inverse mapping adjacent as the zero-codegen projection of
the same matching rules. Delete independent runtime scanners.

Public-surface proof must include positive and forbidden operations, a typo
beside a real key, fresh and non-fresh objects, and every affected nesting
level. Retain explicit compile-success pins where the known TypeScript depth
ceiling prevents stronger exactness.

Keep gate:

- One runtime inverse resolver remains.
- Existing successful bindings and definition failures are unchanged.
- Lazy/circular model construction remains intact.
- The owned-FK guard is deleted only after public and internal falsifiers prove
  the empty-`.fields()` bypass is unreachable.

Suggested commit:

~~~text
refactor: centralize inverse relation resolution
~~~

### Phase 3 — Move complete junction topology into `BoundRelation`

Post-lift state: compound M2M remains outside the implemented capability, as
intended by Package N2. The live engine refusal currently emerges from
`getRequiredSinglePrimaryKeyField` as V9001/internal defect rather than a clean
capability refusal. That error-class correction is adjacent product work because
it changes observable failure classification. Fix it in an explicit bug unit
before Phase 3 when authorized, or preserve it exactly during this internal
compression; never change it accidentally while deleting the second binder.

#### Unit 3.1 — Bind scalar junctions as ordered sides

Actions:

1. Add `JunctionReferenceMember` and `JunctionSide` beside bound topology.
2. Make `JunctionRelation` carry table, source side, and target side.
3. Populate one member per side for the currently supported scalar-PK case.
4. Preserve source/target orientation for self-relations and relation-name
   disambiguation.
5. Keep schema and migration junction naming unchanged.

This unit does not expose compound M2M publicly.

#### Unit 3.2 — Migrate query-engine junction consumers

Migrate in this order:

1. `RelationJunctionPart`.
2. `ManyToManyStatements` arguments.
3. OwnWrite membership scope and endpoints.
4. include builders.
5. relation filter.
6. relation count.
7. relation order/count paths.

Every consumer iterates `source.members` and `target.members`, even while each
side contains one member.

#### Unit 3.3 — Delete the second junction binder

Delete after all consumers migrate:

- `ManyToManyJoinInfo`.
- `getManyToManyJoinInfo()`.
- scalar `firstField` / `secondField` membership scope members.
- singular `sourcePkField`, `targetPkField`, `sourceFieldName`, and
  `targetFieldName` channels.
- duplicate M2M orientation scans.

Static gate:

~~~bash
rg -n "ManyToManyJoinInfo|getManyToManyJoinInfo|firstField|secondField|sourcePkField|targetPkField" src/query-engine
~~~

Every remaining match must be unrelated or the unit is incomplete.

Keep gate:

- Existing scalar M2M SQL and parameters are byte-identical.
- No new branch distinguishes scalar and future compound junction sides.
- At least one second topology owner is deleted.
- The second junction topology owner is deleted. Record the LOC delta as a
  diagnostic; do not satisfy the gate by hiding branches behind helpers.

Suggested commit:

~~~text
refactor: bind complete junction sides
~~~

### Phase 4 — Orthogonalize relation position, cardinality, and membership

#### Unit 4.1 — Add the exact orthogonal union

Actions:

1. Replace cross-product kind names with the discriminated shape in §4.2.
2. Preserve impossible-state exclusion:
   - parent-held is always to-one;
   - junction is always to-many;
   - polymorphic child-held may be one or many;
   - ordinary child-held may be one or many.
3. Make `bindRelation()` the only constructor.
4. Do not add derived booleans to the bound value.

#### Unit 4.2 — Migrate consumers by the question they ask

Order:

1. OwnWrite position and cardinality decisions.
2. relation membership binding.
3. relation nullability.
4. relation-key legality.
5. create compiler.
6. selected update compiler.
7. relation Parts.
8. read builders.

Rules:

- Branch on `position` only for placement/ownership.
- Branch on `cardinality` only for arity and public slot behavior.
- Branch on `membership.kind` only for physical storage lowering.
- Do not recreate aliases such as `isChildHeldPolymorphicToOne`.

#### Unit 4.3 — Delete cross-product vocabulary

Delete:

- `ChildHeldToOne`.
- `ChildHeldToMany`.
- `PolymorphicChildHeldToOne`.
- `PolymorphicChildHeldToMany`.
- `isPolymorphicChildHeldRelation`.
- redundant `RelationInfo.isToOne` / `isToMany` fields if all consumers can use
  one cardinality fact or derive it from the public relation type.

Static gate:

~~~bash
rg -n "childHeldToOne|childHeldToMany|polymorphicChildHeldToOne|polymorphicChildHeldToMany|isPolymorphicChildHeldRelation" src/query-engine
~~~

No production reference remains.

Keep gate:

- Bound topology still forbids impossible combinations at compile time.
- Record the query-engine topology branch delta. A reduction near 25% is
  expected, but the gate is deletion of the named cross-product owners and
  repeated branch lists, not a numerical quota.
- No configuration carries the new relation plus old component facts.
- No public or SQL behavior changes.

Suggested commit:

~~~text
refactor: separate relation topology axes
~~~

### Phase 5 — Give physical membership one topology owner

Post-lift state: Package D already made transition provenance field-aware and
separated planning reads from final writes. Preserve that owner. What remains is
to derive the analytical OwnWrite scope and executable source binding from one
bound physical topology instead of reconstructing holder, member pairs,
qualifiers, and junction orientation in parallel.

#### Unit 5.1 — Move ordered membership shape into bound topology

Actions:

1. Construct `BoundForeignKeyMembership`, `BoundPolymorphicMembership`, and
   `BoundJunctionMembership` only in the topology binder.
2. Pair ordinary foreign/reference members once.
3. Store polymorphic holder, referenced model, storage, discriminator, and
   referenced field once.
4. Reuse bound junction sides from Phase 3.

#### Unit 5.2 — Attach read/write provenance once

Actions:

1. Make relation compilers attach planning read and final write sources to the
   bound membership.
2. Preserve separate read and write sources for transitions.
3. Remove scalar `parentId` plus optional `membershipReadSource` channels.
4. Pass source-bound membership into relation Parts.
5. Keep planning sources unable to carry final references or lookup SQL.

Delete only after migration:

- `PostTransitionAdopt`.
- `membershipReadSource` option bags.
- junction `parentWriteMember()` and `membershipMember()` reconstruction.
- repeated `referencedFields.map(...)` source construction.

#### Unit 5.3 — Derive OwnWrite membership from topology

Actions:

1. Replace topology reconstruction inside `getRelationMembershipScope()`.
2. Derive a stable analytical key from bound membership.
3. Make equality compare complete ordered members and fixed qualifiers.
4. Preserve discriminator-sensitive polymorphic overlap.
5. Preserve source/target orientation for self-junctions.

Delete:

- the independent polymorphic membership-scope constructor;
- repeated holder/referenced decisions;
- scalar M2M scope fields;
- downstream arity pairing checks whose invalid state the binder excludes.

#### Unit 5.4 — Share direct and inverse polymorphic physical membership

Direct payload intent remains separate. After its type is resolved, construct
the same `BoundPolymorphicMembership` used by an inverse edge.

Prove:

- direct and inverse access to one physical pair produce equal OwnWrite scopes;
- same-ID, wrong-discriminator memberships remain different;
- targetless direct disconnect clears storage without inventing a target edge;
- untaken arms do not resolve payload-selected topology early.

Keep gate:

- Topology is constructed once.
- Execution adds sources without rediscovering storage.
- OwnWrite has no separate physical topology constructor.
- Ordinary, polymorphic, and scalar M2M SQL is unchanged.

Suggested commit:

~~~text
refactor: derive membership views from bound topology
~~~

### Phase 6 — Use one parsed relation collection and one child dispatcher

Post-lift state:

- The ordinary `relations` and direct `polymorphic` maps still travel in
  parallel.
- `relationWriteKeys(parsed)` is the single bridge that reads both maps for
  relation-bearing bulk legality and closed the former silent-drop defect.
- `sharedKeyMembers` and `sharedKeyFinal` remain the selected compiler's
  two-stage shared-row-key channels.
- The central to-one lattice now admits ordered multi-entry compositions, so
  singular relation programs are not synonymous with one entry.

#### Unit 6.1 — Replace parallel relation maps

Actions:

1. Add the `ParsedRelationMutation` union from §4.5.
2. Pin and preserve the post-lift effective order exactly: current collection
   insertion order, per-payload source-array order, and
   `RELATION_MUTATION_KEYS` entry order. Do not normalize to model declaration
   order in this refactor.
3. Keep ordinary topology unbound until the current first topology decision.
4. Keep direct polymorphic target resolution at its current validation/parse
   boundary.
5. Represent targetless polymorphic disconnect explicitly.
6. Preserve every accepted multi-entry to-one composition and its ordered
   execution; no consumer may assume one entry per singular relation.
7. Add a falsifier for nested `updateMany` data containing direct-polymorphic
   intent. The trusted representation must carry or reject it before any scalar
   leaf can discard it.

Migrate:

1. `CreateOperation`.
2. `UpdateOperation`.
3. `UpsertOperation` arm construction.
4. `OwnWriteAnalyzer`.
5. `RecordUpdateCompiler`.
6. nested create/update recursion.
7. junction delegated record compilation.

Delete:

- `ParsedRecordPrograms.polymorphic`.
- parallel `relations`/`polymorphic` arguments.
- name-based joins between the two maps.
- exact-membership override channels made redundant by the unified entry.

Audit the root `createMany` and `updateMany` routers separately. They currently
answer whether raw data carry general relation programs before
`CreateManyRecordSeries` or `UpdateManyRecordSeries` parse those payloads. Keep
this duplication only if one of these is proven:

- one trusted parse-once routing envelope can preserve current validation and
  transform timing; or
- the raw classifier is a deliberately conservative pre-trust projection whose
  answer agrees with the parser for every valid payload.

Moving the classifier into a helper without deleting one of the answers is not
compression.

#### Unit 6.2 — Collapse child-held mutation dispatch

Prerequisite: Phase 5 is green.

Actions:

1. Resolve position, cardinality, membership topology, and sources before
   dispatch.
2. Iterate `RelationMutationEntry` once.
3. Reuse existing `RelationLinkPart`, `RelationWritePart`,
   `RelationUpsertPart`, and fresh-record compiler.
4. Keep placement and referential-action legality with the record compiler.
5. Keep branch decisions with relation Parts.

Delete:

- `interpretPolymorphicChildHeld`.
- the duplicate junction/ordinary child-entry dispatcher when their emitted
  Parts are identical.
- ordinary/polymorphic operation branches whose only difference was storage
  assignment.
- local child-held cross-product unions.

#### Unit 6.3 — Normalize parent-held assignment without duplicating arms

Create one exact root-membership assignment union:

~~~text
ordinary FK SET data
or
polymorphic private-storage assignment
~~~

Use it inside shared `create`, `connect`, `connectOrCreate`, `update`, `upsert`,
and `delete` arm structures. Do not duplicate each arm as
`polymorphicCreate`, `polymorphicConnectOrCreate`, etc.

Include the lift's `sharedKeyMembers` and `sharedKeyFinal` channels in this
migration. They may collapse into the root-membership assignment only if the new
shape preserves both stages:

1. the prepass discovers which row-key members the relation supplies;
2. selected-arm compilation supplies their final values.

Keep operation ordering, probes, guards, pins, and errors in their current arm
owners.

Static gates:

~~~bash
rg -n "ParsedRecordPrograms.*polymorphic|interpretPolymorphicChildHeld|polymorphic(Create|ConnectOrCreate|Update|Upsert|Delete)" src/query-engine
~~~

Review every survivor.

Keep gate:

- One parsed collection reaches OwnWrite and record compilers.
- One child-held dispatcher handles ordinary and polymorphic storage.
- No strategy table, operation callback, or optional configuration bag appears.
- Production branches and LOC decrease.

Suggested commits:

~~~text
refactor: unify parsed relation mutations
refactor: dispatch child-held mutations once
~~~

### Phase 7 — Centralize read-side physical traversal

#### Unit 7.1 — Build one relation traversal source

Add one narrow builder that consumes bound topology and produces only the
physical target traversal needed by read SQL:

- target `FROM` source;
- junction joins when applicable;
- parent/target correlation predicates;
- tables read for mutation-target hiding.

It does not own:

- selection;
- aggregation;
- lateral strategy;
- windows;
- filter quantifiers;
- negation;
- ordering;
- result parsing.

#### Unit 7.2 — Migrate include, filter, count, and order

Migrate independently:

1. correlated include;
2. lateral include;
3. relation filters;
4. relation count;
5. relation order/count chains.

Each builder retains its semantic operation and consumes the same physical
traversal.

Delete:

- raw M2M topology branches in include/filter/count;
- `buildCorrelation()`'s junction refusal;
- duplicate M2M join-part construction;
- repeated inverse scans in read builders.

Keep gate:

- Serialized SQL and parameters are byte-identical for scalar FK, compound FK,
  polymorphic inverse, M2M, self-relation, lateral, and subquery strategies.
- Query plans in the existing performance contracts do not regress.
- The new builder is not a generic read AST.
- The repeated traversal owners disappear from the affected builders. Record
  their LOC delta separately.

Suggested commit:

~~~text
refactor: centralize relation traversal topology
~~~

### Phase 8 — Give relation capabilities one schema owner

This phase consumes the canonical inverse fact from Phase 2. It does not reopen
inverse matching.

Post-lift state: `toOneMutationSchema` now owns the accepted ordinary and
polymorphic-inverse composition lattice at both runtime and type level. The
remaining work is to make direct polymorphic and cloned nested-data projections
consume this owner, then delete their independent verb/composition surfaces.

#### Unit 8.1 — Introduce the nested relation-data projection

Actions:

1. Give ordinary inverse membership omission one owner.
2. Give polymorphic inverse direct-relation omission and satisfied-membership
   handling the same owner.
3. Produce create, update, and eligible scalar createMany child schemas.
4. Feed those projected schemas into existing to-one/to-many verb factories.
5. Preserve lazy thunks and circular relation behavior.

Delete the cloned polymorphic inverse verb surface after type and runtime
consumers migrate.

#### Unit 8.2 — Centralize membership clearability

Maintain two facts:

- `slotMayBeEmpty` from public cardinality/optionality;
- `membershipCanBeCleared` from physical storage nullability.

Add adjacent type/runtime projections consuming resolved inverse membership.
Use them for operation-schema availability. Let the engine guard consume the
same schema-owned physical fact only when trusted internal programs can bypass
public validation.

Delete duplicate runtime nullability scans.

Do not add a source-breaking rule requiring relation optionality and FK
nullability to agree. That is a separate product decision.

#### Unit 8.3 — Reuse the to-one mutation lattice

Treat the delivered Package-H lattice as an established input. Feed direct
polymorphic and remaining cloned to-one verb entries through that owner, then
delete their independent composition rules. Do not introduce another lattice.

Add an explicit non-empty mode only if direct polymorphic payloads require it
and a falsifier proves the existing empty arm is wrong. Preserve the accepted
ordered vacate/supply/modify compositions and literal `false` as inactive.

Keep gate:

- One to-one/to-many verb owner.
- Type-level and runtime public surfaces agree.
- Public client probes cover positive and forbidden operations, a typo beside a
  real key, fresh and non-fresh objects, and each affected nesting level.
- A reproducible warm type-check regression above 5% is investigated and
  simplified before delivery.
- Expect approximately 150 net production LOC removed from validation relation
  modules, but gate on deletion of the cloned verb owner rather than the number.

Suggested commits:

~~~text
refactor: project nested relation data once
refactor: derive relation clearability once
~~~

### Phase 9 — Remove redundant execution truths

These units are independent after Phase 0 and may proceed if topology phases are
temporarily blocked.

Post-lift state:

- Package O reduced write-engine refusal construction sites from 31 to 15 and
  audited all ten surviving write-engine invariants. The guard-ownership ledger
  is the proof source; this phase must not reopen those decisions casually.
- `RecordSeriesOperation.mode` is still declared and explicitly documented as
  unread.
- Fragment validation, executor dependency handling, and PostgreSQL CTE
  lowering still discover statement references independently.
- Planning output maps, dormant batch lifecycle surfaces, duplicate failure
  materialization, and the low-level relation interpreter remain census items.

#### Unit 9.1 — Derive planning outputs from steps

Actions:

1. Prove every production planning fragment publishes all step outputs.
2. Remove `PlanningFragment.outputs`.
3. Make the executor materialize `planningKey(step.id, output)` for every
   declared statement output.
4. Apply the same rule to `RecordSeriesOperation.capture()` without merging the
   series into `OperationFragment`.
5. Delete `planningOutputs()` and operation-level publication calls.
6. Keep final `OperationFragment` output selection explicit.

Keep gate:

- Planning known-value keys and optional-output behavior are unchanged.
- No planning SQL, ordering, or round trip changes.
- The planning publication owner and its callers are deleted; record the LOC
  delta as a diagnostic.

Suggested commit:

~~~text
refactor: derive planning outputs from statements
~~~

#### Unit 9.2 — Give failure materialization one owner

Share only `Failure → Error` construction and raceable marking between normal
execution and batch attribution. Keep normal and merged-batch attribution
algorithms separate.

Delete copied message constants and duplicate error construction.

Suggested commit:

~~~text
refactor: centralize execution failure materialization
~~~

`racePin` and `onUniqueConflict` remain separate. A live junction write can
carry both retry attribution and skip behavior, so a two-arm union would erase
a real state rather than compress duplicate truth.

#### Unit 9.3 — Delete dormant batch lifecycle surfaces

Falsify production use of:

- `PendingOperationV2`;
- `OperationExecutor.prepareBatch()`;
- `PreparedBatchOperation.setupQueries`;
- `PreparedBatchOperation.cleanupQueries`.

Move tests to the live `PendingOperation` / `prepareSharedBatch()` seam, then
delete test-only production surfaces. Verify published-type compatibility before
removing any exported field.

Retain adapter `batchRefs` and real scratch/insert-ID handling.

#### Unit 9.4 — Delete the lower SQL relation interpreter

Audit every `buildUpdate` caller. If record compilers already pass scalar data
plus lowered membership assignments, delete
`operations/update.ts::processRelationOperations` and make the SQL leaf trust
compiled input.

Do not move its logic elsewhere. If a live caller still relies on it, migrate
that caller through the canonical relation program first.

#### Unit 9.5 — Centralize statement reference extraction

Give the fragment owner one function that returns
`OperationValueReference` dependencies from a statement. Reuse it in:

- fragment validation;
- planning dependency levels;
- single-statement policy;
- statement materialization;
- PostgreSQL dependency CTE eligibility.

Do not create a second dependency graph IR or parse SQL strings. CTE positional
substitution remains local to the CTE lowerer because it rewrites each
consumer's `Sql.values`; only reference discovery and dependency facts are
shared.

#### Unit 9.6 — Delete the redundant record-series mode

`executionKind: "recordSeries"` already selects the transaction-only series
executor, and the executor opens its transaction before any fragment-mode
branch. Delete the unread `mode: "transaction"` property from the series
contract and implementations.

Keep gate:

- Record series remain transaction-only.
- Prepared statement, shared-batch, and atomic-batch paths still refuse the
  series before reaching fragment compilation.
- No general execution-mode or strategy carrier replaces the deleted literal.

Suggested commit:

~~~text
refactor: remove redundant record series mode
~~~

Phase keep gate:

- Every unit deletes a real second owner.
- No runtime step or generic premise abstraction is added.
- Existing batch, skip, retry, and attribution tests remain exact.

### Phase 10 — Prototype one compiled selection fact

This phase is deliberately isolated. Do not keep partial adoption.

#### Unit 10.1 — Pin the five current projection interpretations

Pin these live owners explicitly:

1. select/include SQL construction;
2. expected result shape;
3. relation-free projection detection;
4. mutation read-footprint detection;
5. PostgreSQL CTE `returningEveryColumn()` construction.

Cover:

- scalar select;
- include and nested include;
- polymorphic selection;
- `_count`;
- vector/distance projections;
- relation-free mutation projection CTE eligibility;
- relation-bearing mutation read footprint;
- aliases and omitted/default selections;
- result parser expected shapes.

#### Unit 10.2 — Promote `SelectResult`

Extend the existing select compilation result with:

- exact expected row shape;
- relation-presence fact;
- mutation read footprint.

Evaluate CTE returning construction as a fifth consumer. Derive its required
physical columns from the compiled fact only if mapped fields, polymorphic
private storage, omit behavior, and outer projection remain exact. Otherwise
retain it as explicitly distinct mutation-transport plumbing and record why it
is not another owner of public selection meaning.

Thread the compiled selection to SQL assembly, result parsing, and fold
eligibility.

Delete independent select/include traversal from `result-shape.ts` and
write-engine projection helpers only after all consumers use the compiled fact.

Do not include aggregate, groupBy, or count semantics unless the same shape is
proven. They may retain separate result contracts.

#### Unit 10.3 — Objective keep-or-remove gate

Keep the phase only if:

- SQL and result parsing remain exact;
- mutation CTE eligibility is unchanged;
- production additions are fewer than production deletions;
- no generic query AST, visitor framework, renderer strategy, or context bag is
  introduced;
- type-check median does not regress by more than 5%;
- every duplicate interpretation claimed by the phase disappears for migrated
  operations; any retained CTE transport projection has a documented distinct
  responsibility.

If the gate fails, remove the prototype with `apply_patch` and preserve the
current explicit owners.

Suggested commit when retained:

~~~text
refactor: compile selection meaning once
~~~

### Phase 11 — Normalize result transport only after selection is stable

This phase is conditional on Phase 10 being retained. If compiled selection is
rejected, do not introduce a second selection representation through result
transport.

#### Unit 11.1 — Define operation result contracts

Audit the repeated operation sets and internal pseudo-operation names. Define an
exact discriminated result contract that replaces, rather than parallels, the
existing `ExpectedResultShape` owner. A representative shape is:

~~~ts
type OperationResultContract =
  | { readonly kind: "requiredRow"; readonly selection: CompiledSelection }
  | { readonly kind: "optionalRow"; readonly selection: CompiledSelection }
  | { readonly kind: "rows"; readonly selection: CompiledSelection }
  | { readonly kind: "mutationCount" }
  | { readonly kind: "existence" };
~~~

Adapt the exact variants to live result carriers, but do not encode a Cartesian
product of carrier, cardinality, and selection that permits invalid states.
Name every existing operation set or `ExpectedResultShape` branch that each
variant deletes before adding it.

Keep public operation identity (`createMany`, `updateMany`, `deleteMany`) separate
from how a provider transports its result.

#### Unit 11.2 — Migrate routing and parsing

Migrate:

- operation routing;
- result parser selection;
- D1 row-producing policy;
- mutation identity/refetch policy;
- record-series aggregation and final reads;
- error operation-name mapping;
- repeated model-row/batch/result sets.

Delete internal `*ManyAndReturn` pseudo-operation names only when public errors,
result types, and optimized SQL remain unchanged.

`CreateManyRecordSeries.parseSeries()` and
`UpdateManyRecordSeries.parseSeries()` must consume the resulting public bulk
result contracts directly. Do not force series capture, member results, and
final reads into one fragment-output bag.

#### Unit 11.3 — Consider one final logical output

Production final fragments currently expose at most one logical operation
result. Replace the `{ result/count: source }` bag with one optional logical
output only if the result contract makes this exact and literal empty/count
outputs have a truthful representation.

Do not alter statement-level multi-output publication.

Keep gate:

- Pseudo-operation names and repeated result sets decrease.
- `ExpectedResultShape` is replaced or narrowed; no parallel result owner
  remains.
- No public operation name or error changes.
- Fast-path SQL is identical.
- Production branches and LOC decrease.

Suggested commit:

~~~text
refactor: separate operation names from result transport
~~~

### Phase 12 — Final deletion, doctrine, and census

#### Unit 12.1 — Delete compatibility vocabulary

Run static searches for every deleted type/helper. Remove stale comments and
migration-history narratives. Keep comments explaining:

- ordered key grouping;
- row-key/reference-key distinction;
- fixed polymorphic discriminator qualifiers;
- old-read/new-write transition provenance;
- junction side orientation;
- parse-once behavior;
- fast-path preservation;
- race and wrong-row protection.

The lift added many comments named after Packages A–O and plan-section
milestones. Move proof history to the limitation plan and guard-ownership
ledger, then remove task-history labels from production code after the live
invariant is expressed by code, doctrine, or an owning test. Keep only the
reason a surviving rule exists.

#### Unit 12.2 — Update architecture doctrine

Update:

- root and query-engine `AGENTS.md` files;
- builders doctrine;
- write-engine README and ATOM;
- internal query-engine documentation;
- engine compression audit;
- `CONTEXT.md` glossary where domain terms were accepted.

Document the final rule:

~~~text
one stored topology, several derived views
~~~

#### Unit 12.3 — Final census

Report:

- starting and ending physical/token-bearing production LOC;
- named concepts deleted;
- relation topology branch delta;
- inverse resolver count;
- M2M topology owner count;
- planning publication owner count;
- result/projection traversal count;
- record-series-specific derived owner count;
- statement-reference discovery count;
- write-engine runtime cycles;
- type-check median;
- exact tests and provider skips.

Suggested commit:

~~~text
docs: document query engine truth ownership
~~~

## 8. Validation matrix

### 8.1 Per phase

Run the focused owning suites through `scripts/run-vitest-safe.mjs`, then run the
affected layer scripts sequentially. At minimum:

~~~bash
pnpm test:types
~~~

Add `pnpm test:layer:query-engine` only for query-engine changes, and use the
corresponding relation, schema-validation, operation-schema, client, adapter,
driver, or instrumentation layer for its actual owner.

### 8.2 Major topology phases

After Phases 3–7:

~~~bash
pnpm test:layer:relations
pnpm test:layer:query-engine
pnpm test:layer:adapters
pnpm test:layer:drivers
pnpm package:build
~~~

Run the current contracts for lateral correlation, self-M2M orientation, mapped
columns, mutation-target hiding, filter quantifiers, and nested pagination after
the first phase that changes each path. When provider services are available,
run `pnpm test:providers` after the junction and traversal phases rather than
waiting until finalization.

### 8.3 Validation/schema phase

After Phase 2 and again after Phase 8:

~~~bash
pnpm test:layer:relations
pnpm test:layer:schema-validation
pnpm test:layer:operation-schemas
pnpm test:layer:client
pnpm test:types
~~~

### 8.4 Execution phases

After Phases 9–11, first run:

~~~bash
pnpm test:layer:query-engine
pnpm test:layer:client
pnpm test:layer:instrumentation
~~~

Then include the performance-contract selection:

~~~bash
node scripts/run-vitest-safe.mjs run \
  --workspace vitest.workspace.ts \
  --project=layer-query-engine \
  tests/contracts/engine/write/batch-round-trip-baseline.test.ts \
  tests/contracts/engine/write/upsert-on-conflict-fold.test.ts \
  tests/contracts/engine/write/mutation-projection-cte-fold.test.ts \
  tests/contracts/engine/write/create-many-return-fold.test.ts \
  tests/contracts/engine/write/batch-mode-fold.test.ts \
  tests/contracts/engine/write/record-series-contract.test.ts \
  tests/contracts/engine/write/create-many-relation-series.test.ts \
  tests/contracts/engine/write/update-many-relation-series.test.ts \
  tests/contracts/engine/query/sql-generation.core.test.ts
~~~

Use the memory-capped launcher even for this focused selection. If those paths
move again, locate their current owning contracts and update this list instead
of creating legacy-shaped duplicate suites.

### 8.5 Final validation

Run sequentially through memory-capped launchers:

~~~bash
pnpm test:layer:relations
pnpm test:layer:schema-validation
pnpm test:layer:operation-schemas
pnpm test:layer:query-engine
pnpm test:layer:client
pnpm test:layer:adapters
pnpm test:layer:drivers
pnpm test:layer:instrumentation
pnpm test:types
pnpm package:build
pnpm test
pnpm test:all
pnpm test:coverage:write-engine
~~~

Run provider contracts when services are available. Report exact skips rather
than marking them passed.

Run three warm final type checks. Investigate and simplify a reproducible median
regression above 5%; do not react to a single noisy timing.

## 9. Final acceptance criteria

The completed work must satisfy all applicable requirements:

- One model-key catalog owns ordered row/addressable keys and their conservative
  overlap view; schema/provider validation still owns exact referenceability.
- No misleading `getTargetIdentityFields` or duplicate cursor row-key resolver
  remains.
- `BoundRelation` owns complete junction sides.
- No `ManyToManyJoinInfo` second topology binder remains.
- Relation position, cardinality, and membership storage are explicit facts,
  not cross-product kind names.
- Physical membership topology is constructed once.
- OwnWrite and execution derive their views from that topology.
- Parsed ordinary and polymorphic relation mutations no longer travel in
  parallel maps.
- One child-held dispatcher handles ordinary and polymorphic membership.
- One runtime inverse resolver owns candidate resolution.
- Existing to-one/to-many factories own inverse mutation verbs.
- Membership clearability has one runtime semantic owner and one adjacent
  type-level projection.
- Planning outputs are derived from planning steps.
- `RecordSeriesOperation` remains the explicit transaction-only dynamic
  execution form, without a redundant mode field.
- Fresh-field publication and selected-row capture remain separate owners fed
  by shared ordered key metadata.
- No trusted nested bulk path can silently discard direct-polymorphic intent.
- No `RecordSeriesOperation` is nested in a fragment, Part, or another series.
- `relationWriteKeys(parsed)` disappears only when one parsed relation
  collection makes its two-map synchronization role unnecessary.
- Every surviving refusal retains the guard ledger's distinct invariant,
  first-knowable boundary, and unique falsifier unless a new trusted
  representation makes that invalid state impossible.
- Every retained selection/result prototype removes all duplicate consumers it
  claims to replace.
- No existing SQL, parameter, step, guard, pin, error, statement count, or round
  trip changes.
- No public API, adapter relation API, runtime step, mutation DSL, query AST,
  strategy framework, lifecycle hook, or universal identity tuple is added.
- Record the query-engine branch delta as a diagnostic. Every surviving or new
  branch must belong to a named distinct fact; do not reward hiding branches in
  helpers or reject a correct ownership change on count alone.
- Write-engine runtime import cycles remain zero.
- No reproducible material type-check regression remains; investigate any warm
  median increase above 5%.
- Production LOC is net negative across the complete plan.
- Every surviving duplicate-looking representation has a documented distinct
  responsibility or trust boundary.

## 10. Recommended commit order

~~~text
test: pin distinct query engine truths
refactor: centralize ordered model keys
refactor: centralize inverse relation resolution
refactor: bind complete junction sides
refactor: separate relation topology axes
refactor: derive membership views from bound topology
refactor: unify parsed relation mutations
refactor: dispatch child-held mutations once
refactor: centralize relation traversal topology
refactor: project nested relation data once
refactor: derive relation clearability once
refactor: derive planning outputs from statements
refactor: centralize execution failure materialization
refactor: delete dormant batch lifecycle
refactor: trust compiled update data
refactor: centralize statement reference extraction
refactor: remove redundant record series mode
refactor: compile selection meaning once
refactor: separate operation names from result transport
docs: document query engine truth ownership
~~~

Skip commits for rejected prototypes. Do not retain partial compatibility layers.

## 11. Doctrine

Compression is not the act of replacing many names with one broad name. It is
the act of giving every unavoidable fact one owner and making every other view a
derivation.

For this engine:

- one model-key catalog owns ordered keys;
- one bound topology owns physical membership;
- one parsed program owns requested mutation meaning;
- one source binding owns per-operation provenance;
- one record compiler owns one record mutation;
- one record series owns a data-dependent transaction of ordinary record
  operations;
- one relation Part owns its branch and edge effects;
- one traversal owns physical relation correlation;
- one compiled selection may own projection meaning if the prototype proves it;
- one executor owns planning publication and failure materialization.

Selected capture and fresh publication are deliberately separate views of
record fields. The former reads an existing row; the latter publishes demanded
values from a new row. Sharing the ordered key catalog does not make their
timing or failure semantics identical.

The engine becomes easier to extend when a new feature adds one new fact or one
new member to an ordered structure, rather than adding a new interpretation of
facts that already existed.
