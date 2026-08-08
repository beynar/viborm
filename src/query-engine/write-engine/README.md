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
- `PlanningFragment` contains statements and outputs, never guards.
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
target at that edge. `parentHeldToOne` means the source stores the FK; it is not
a global model hierarchy.

## Three independent facts

### Requested meaning

`RelationMutationProgram` is the lossless, schema-transformed meaning of one
relation payload. It preserves kind order, source order, duplicates, `set: []`,
and normalized update/upsert targets. It removes only false boolean no-ops.
Execution-specific deduplication stays with the consumer that owns it.

### Relation position

`BoundRelation` classifies an edge as `parentHeldToOne`, `childHeldToOne`,
`childHeldToMany`, `polymorphicChildHeldToMany`, or `junction`. It stores
topology only: source model, ordered storage fields, referenced fields, and the
schema-fixed discriminator needed by a polymorphic inverse. It does not store
scopes, runtime identities, value sources, transition state, SQL, or branch
policy.

The polymorphic child-held variant means one exact physical membership:
private identity equals the parent referenced value and private type equals the
stored discriminator. Reads, probes, bulk filters, OwnWrite, and set membership
all consume that same bound fact. Direct payload-selected polymorphic edges stay
outside `BoundRelation`.

### Record mutation

`CreateOperation` compiles each non-bulk fresh record subtree. Nested callers
provide parsed data and field-bound incoming FK members. The explicit inline
junction-target insert remains local to `RelationJunctionPart`.

`RecordUpdateCompiler` compiles each already-selected non-bulk record update.
It owns scalar SET data, incoming FK assignments, nested relations, required
target projection, primary-key transitions, the root UPDATE, and descendant
order. A true no-op returns no compiler before allocating an ID.

For `parentHeldToOne`, the record compiler owns the inline FK fold and the branch
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

Polymorphic inverse relation Parts use the same child-held family. Connect and
connect-or-create adopt globally; fresh-parent upsert does the same. A
selected-parent upsert is correlated to the exact `(type, identity)` pair and
rejects a foreign same-id row. Optional disconnect and set clear both private
columns atomically. Nested createMany applies one shared pair to every grouped
row.

## Foreign-key values

`foreign-key-reference.ts` binds every planning or final source to one
foreign/referenced field pair. A transition reads the old value and writes the
new value. Final operation references cannot enter planning SQL, and lookup SQL
cannot select a branch.

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
and many-and-return folds remain specialized. `ManyToManyStatements` remains
the junction SQL owner. Keep adapter `batchRefs` and the type-only
`QueryMetadata` compatibility export; the latter is not a runtime boundary.

Nested `createMany` stays with the owner of its set-shaped placement: a fresh
parent records post-insert groups in `CreateOperation`; a selected parent uses
the specialized builders in `nested-target-parts.ts`; a junction keeps target
rows and join effects in `RelationJunctionPart`.

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
