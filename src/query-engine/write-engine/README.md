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

Planning is not read-only. E6.9 skip-duplicate capture performs preparation
writes and publishes their outputs. Nested Parts currently contribute reads.
Keep the executor's non-read planning fallback.

## Three independent facts

### Requested meaning

`RelationMutationProgram` is the lossless, schema-transformed meaning of one
relation payload. It preserves kind order, source order, duplicates, `set: []`,
and normalized update/upsert targets. It removes only false boolean no-ops.
Execution-specific deduplication stays with the consumer that owns it.

### Relation position

`BoundRelation` classifies an edge as `parentHeldToOne`, `childHeldToOne`,
`childHeldToMany`, or `junction`. It stores topology only: source model, ordered
FK fields, referenced fields, and update action. It does not store scopes,
identities, value sources, transition state, SQL, or branch policy.

### Record mutation

`CreateOperation` compiles each non-bulk fresh record subtree. Nested callers
provide parsed data and field-bound incoming FK members.

`RecordUpdateCompiler` compiles each already-selected non-bulk record update.
It owns scalar SET data, incoming FK assignments, nested relations, required
target projection, primary-key transitions, the root UPDATE, and descendant
order. A true no-op returns no compiler before allocating an ID.

Relation owners keep target selection, correlation, membership, found/missing
decisions, guards, race pins, not-found messages, junction effects, and terminal
results. They pass the captured target to the record compiler.

## Foreign-key values

`foreign-key-reference.ts` binds every planning or final source to one
foreign/referenced field pair. A transition reads the old value and writes the
new value. Final operation references cannot enter planning SQL, and lookup SQL
cannot select a branch.

Writes address the captured primary key, not a selector that can match a
different row after planning.

## Branch premises

- Batch found arm: captured-row presence guard, `raceable: false`.
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
- Junction create attachment stays target before-writes, target INSERT,
  junction INSERT, target descendants.

## Kept specializations

`createMany`, `updateMany`, `deleteMany`, relation `set`, skip-duplicate capture,
and many-and-return folds remain specialized. `ManyToManyStatements` remains
the junction SQL owner. Keep `QueryMetadata` and adapter `batchRefs`.

Do not add a generic mutation DSL, payload walker, locator, strategy framework,
branch-step IR, lifecycle hook, or shared utility landfill.

## Validation

Run the focused nested-write and race tests for the changed path, then:

```bash
pnpm test:types
pnpm test:gates
pnpm package:build
pnpm test
```

Run PostgreSQL and MySQL parity suites when Docker is available. Report skipped
Docker suites as not run.
