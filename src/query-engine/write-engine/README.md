# Query Engine Write Engine

The write engine compiles validated mutations into a guard-free planning
fragment and one selected final fragment. [ATOM.md](./ATOM.md) is the normative
architecture reference.

## Pipeline

```text
validated input
→ scalar/relation partition
→ RelationMutationProgram map
→ OwnWrite legality
→ root operation + relation Parts
→ PlanningFragment
→ OperationFragment
→ OperationExecutor
```

`OperationExecutor` owns generic execution, reference materialization, guard
attribution, transaction or batch envelopes, and strict result handling. It
does not interpret relations or mutation kinds.

## Execution atom

- `ReadStep` describes a read statement.
- `WriteStep` describes a write and is the only step that can carry `racePin`
  or `onUniqueConflict`.
- `GuardStep` protects a premise of the selected final fragment.
- `RecordSeriesStep` places one existing `RecordSeriesOperation` at an exact
  nested position in a final fragment.
- `PlanningFragment` contains statements and outputs, never guards or record
  series.
- `OperationFragment` contains final statements, guards, and outputs.

Planning is not read-only. Skip-duplicate capture performs preparation
writes and publishes their outputs. Nested Parts currently contribute reads.
Keep the executor's non-read planning fallback.

An operation shell is the concrete owner of one public operation family. It
exposes `mode`, planning, compilation, and result parsing. A routed root shell
owns public target and result behavior and selects direct folds.
`CreateOperation` can also serve as a delegated fresh-record compiler inside an
outer shell. `write-engine/*Operation.ts` contains these owners;
`../operations/*.ts` contains operation-specific SQL, plan, identity, and
ordering helpers.

In relation code, parent means the current source record and child means its
target at that edge. `position: "parentHeld"` means the source stores the FK; it is not
a global model hierarchy.

## Three independent facts

### Requested meaning

`RelationMutationProgram` is the lossless, schema-transformed meaning of one
relation payload. It preserves kind order, source order, duplicates, `set: []`,
and normalized update/upsert targets. It removes only false boolean no-ops.
Execution-specific deduplication stays with the consumer that owns it.

### Relation position

One stored topology, several derived views. `BoundRelation` classifies an edge on
three orthogonal axes — `position` (`parentHeld`/`childHeld`/`junction`),
`cardinality` (`one`/`many`), and `membership.kind`
(`foreignKey`/`polymorphic`/`junction`) — with impossible combinations
unrepresentable, and every downstream view of the edge derived from that one
stored fact rather than stored beside it. It stores topology only: source model and one
membership carrying the holder and referenced models, ordered storage fields,
referenced fields, those fields paired member for member, and the schema-fixed
discriminator needed by a polymorphic membership. It does not store scopes,
runtime identities, value sources, transition state, SQL, or branch policy.
The field pairing is lazy: it owns the mismatched-metadata refusal and must not
move it earlier. It is also the only pairing — consumers read `membership.members`
instead of re-pairing the two field lists by index.

The polymorphic child-held variant means one exact physical membership:
private identity equals the parent referenced value and private type equals the
stored discriminator. Reads, probes, bulk filters, OwnWrite, and set membership
all consume that same bound fact. Direct payload-selected polymorphic edges stay
outside `BoundRelation`.

### Record mutation

`CreateOperation` compiles each fresh record subtree. Nested and series callers
provide parsed data and one optional source-bound membership. The explicit
inline junction-target insert remains local to `RelationJunctionPart`.

`RecordUpdateCompiler` compiles each already-selected record update. It
owns scalar SET data, an optional incoming membership, nested relations,
its `TargetProjection`, primary-key transitions, the root UPDATE, and descendant
order. The projection keeps public model fields and private physical columns in
one captured-row contract. A true no-op returns no compiler before allocating
an ID.

For a parent-held edge, the record compiler owns the inline FK fold and the branch
needed to construct its own INSERT or UPDATE. Child-held and junction relation
owners keep target selection, correlation, membership, found/missing decisions,
guards, race pins, not-found messages, and standalone edge effects. The routed
shell normally owns the public terminal result. A relation-bearing upsert create
arm delegates its result-producing fragment to `CreateOperation`, then the outer
`UpsertOperation` re-exposes and parses it. Direct folds need no terminal read.
Relation owners pass captured targets to the selected-record compiler.

The two record compilers recurse through the type-only `RecordCompilerSeam`
(`createFresh`, `updateSelected`). No runtime import cycle or strategy object is
required.

Polymorphic inverse relation Parts use the same child-held family. The singular
variant reuses the ordinary child-held-to-one mutation composition, including
the fixed vacate-then-supply replacement pairs;
both variants reuse the same exact membership binding. Connect and
connect-or-create adopt globally; fresh-parent upsert does the same. A
selected-parent upsert is correlated to the exact `(type, identity)` pair and
rejects a foreign same-id row. On a to-many inverse, disconnect requires
clearable child membership. Set is always present: optional storage clears both
private columns on departures, while required storage guards that no current
exact member departs. A singular inverse has no set: its slot is always
optional, so delete is available, while disconnect still requires clearable
child storage. Nested createMany applies one shared pair to every grouped row.

Direct polymorphic fields stay with the record compilers because their private
pair is part of the owner record's INSERT or UPDATE — and, for every fresh-owner
verb plus a selected owner's create and connect-or-create, they share the SAME
arms as an ordinary foreign key, carrying a root-membership assignment that names
which storage the arm writes. A selected owner's polymorphic update, upsert and
delete keep parallel arms until the parent-held locator union lands. Fresh owners
support connect, create, and connect-or-create. Selected owners also support correlated
update and upsert; optional storage supports disconnect and typed target delete.
When a selected verb depends on current membership, the locate projects the
private pair as internal columns and the compiler addresses the captured target.
On the batch substrate, the existing target guard also reasserts every projected
private value that affected branch selection.

The grouped root createMany path is one bulk specialization. Each row may carry connect-only
polymorphic memberships. `bulk-polymorphic-connect.ts` groups target probes by
relation and discriminator, resolves one private pair per row, and hands the
rows back to the existing grouped INSERT planner. Count and returning shells
consume the same preparation; neither performs one lookup per input row.

For a singular inverse, the relation-wide unique `(type, identity)` index is
the occupied-slot guard. A concurrent slot occupation is reported as a genuine
unique conflict and is not treated as a retryable missing-target race.

## Record series

`RecordSeriesOperation` is the one data-dependent bulk execution form. It
captures an optional root set, then plans and executes ordinary record members
left to right. Member N can therefore observe member N−1; duplicate
`connectOrCreate` keeps first-create-wins without a bulk-specific relation
compiler.

Root relation-bearing `createMany` uses `CreateManyRecordSeries`. Root
relation-bearing `updateMany` uses `UpdateManyRecordSeries`, which captures the
matching complete row keys once and sorts them before member compilation.
Nested relation-bearing `createMany` and `updateMany` use one
`RecordSeriesStep` at their exact position in the outer fragment. Scalar-only
bulk shapes remain grouped and never enter a series.

On a transaction-capable driver, the root series and all nested series steps
share one operation-wide transaction. On D1, root and exactly guarded nested
series can run progressively: each write batch is atomic and committed, a later
failure reports `meta.recordSeriesProgress`, and no retry replays the committed
prefix. A nested `RecordSeriesStep` carries either its compiler-owned
complete-parent/membership guard or a fail-closed reason. An unguardable
placement refuses before its containing member writes; earlier root members may
already be committed. Relation-bearing `skipDuplicates` and a dynamic series
inside explicit `$transaction([...])` refuse before the first user write.

On interactive drivers, relation-bearing `skipDuplicates` scopes each create
member as one subtree. A root unique conflict skips that complete subtree;
descendant and non-unique failures remain fatal. The skipped member never
adopts or mutates the conflicting existing row.

The public returning arm does not issue one final read per member.
`series-result-read.ts` groups complete row keys into K set reads bounded by the
driver's bind-parameter budget, normally one, then restores source order and
preserves exact missing-row failures.

## Source-bound relation membership

`relation-membership.ts` owns the two physical child-held representations.
Ordinary membership is an ordered set of foreign/referenced members.
Polymorphic membership is fixed storage and discriminator plus one identity
source. Relation Parts and record compilers receive one of these bindings; they
do not receive separate FK arrays, private-storage arrays, or relation names to
reconstruct the same edge. The owner lowers writes, clears, correlations,
projections, and decoded-row membership tests.

A transition reads the old value and writes the new value. Final operation
references cannot enter planning SQL, and lookup SQL cannot select a branch.

`RecordUpdateCompiler` and relation owners that pass it a selected target write
by the captured primary key. Scalar probe-first upsert also writes by that key
in batch mode after guarding that its complete selector and matched conditionals
still name the captured row. Transaction mode keeps the original selector
because its locate locks the row. An eligible `ON CONFLICT` fold skips planning;
a relation-bearing found arm uses the selected-record compiler and its captured
identity.

## Branch premises

- Captured-target batch found arm: captured-row presence guard,
  `raceable: false`.
- Scalar probe-first upsert batch found arm: reassert the original unique and
  conditional selector together with the captured primary key.
- Scalar conditional-skip batch arm: a non-raceable presence guard first proves
  that the selector still names the captured row; a raceable absence guard then
  proves that this row still does not match the conditional. The terminal read
  uses the captured primary key.
- Transaction found arm: locked decision read, no duplicate guard.
- Missing arm that inserts the same unique target: constraint plus root-write
  `racePin`.
- Same-operation duplicate: no found guard and no missing pin.
- Materialized-set or orphan premise: retain its explicit absence guard.

First-create-wins is local to connect-or-create. Do not generalize it to upsert.

## Ordering

- Parse once; transformed payloads are not necessarily idempotent.
- Planning reads precede same-operation writes that could change their answer.
- Primary-key transitions keep independent old-read and new-write sources.
- Atomic-batch guards precede writes while preserving order inside each group.
- Inline junction targets emit target INSERT, junction INSERT, then inline
  descendants.
- Delegated targets compile their complete fresh-record subtree before the
  junction INSERT.

## Kept specializations

`createMany`, `updateMany`, `deleteMany`, relation `set`, skip-duplicate capture,
and many-and-return folds remain specialized OVER THE PAYLOADS THE BULK PATH
EXPRESSES. For the two root bulk writes that is the scalar shape: scalar
`createMany` rows (plus a direct polymorphic `connect`) and scalar `updateMany`
data. A root `createMany` row carrying a general relation program, or root
`updateMany` data carrying one, routes the whole operation to a record series
whose members are ordinary `CreateOperation` / `UpdateOperation` instances —
`CreateManyRecordSeries.ts` and `UpdateManyRecordSeries.ts`, which parse the bulk
envelope, construct ordinary record operations, and shape the public bulk result.
They contain no relation-kind switches and are not record compilers. See ATOM §17
for why the semantics require it. `ManyToManyStatements` remains the junction SQL
owner. Keep adapter `batchRefs` and the type-only `QueryMetadata` compatibility
export; the latter is not a runtime boundary.

Nested scalar-only `createMany` and `updateMany` stay with their set-shaped
owners. Relation-bearing nested `createMany` builds ordinary fresh-record Parts;
relation-bearing nested `updateMany` captures correlated complete row keys and
builds ordinary selected-record compilers. Both run through the same nested
`RecordSeriesStep`; no bulk relation compiler exists.

Do not add a generic mutation DSL, payload walker, locator, strategy framework,
branch-step IR, lifecycle hook, or shared utility landfill.

## Validation

Run the focused nested-write and race tests for the changed path, then:

```bash
pnpm test:types
pnpm test:layer:query-engine
pnpm package:build
pnpm test
```

Run PostgreSQL and MySQL parity suites when Docker is available. Report skipped
Docker suites as not run.
