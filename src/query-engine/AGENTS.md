# Query Engine — Database-Agnostic Query Planning

**Location:** `src/query-engine/`  
**Layer:** L6 — query structure and semantics

## Purpose

The query engine validates operation inputs, decides query structure, compiles
ordered SQL fragments, and parses results. It never owns database syntax.
Adapters decide how SQL is expressed; drivers decide how it is executed.

## Golden Rule

Every dialect-dependent SQL choice goes through the adapter. Do not hardcode
identifier quoting, JSON functions, conflict syntax, casts, locking, returning,
or batch-reference syntax in this layer.

## Live Write Architecture

The live nested-write implementation is `write-engine/`. The deleted operation
program and V1 value-carrier vocabulary must not be recreated.

```text
validated operation input
        ↓
canonical relation mutation programs
        ↓
root operation + owned Parts
        ↓
guard-free PlanningFragment
        ↓
selected final OperationFragment
        ↓
OperationExecutor
        ↓
adapter + driver
```

### Execution atom

`OperationFragment.ts` defines the complete step vocabulary:

- `ReadStep` is a statement read.
- `WriteStep` is a statement write and is the only step that can carry
  `racePin` or `onUniqueConflict`.
- `GuardStep` pins a final-fragment premise.
- `PlanningFragment` contains statement steps and outputs, never guards.
- `OperationFragment` contains final statements and guards.

Planning is not read-only. E6.9 skip-duplicate capture performs preparation
writes during root planning. Nested `Part.planning()` currently contributes
reads. Do not remove the executor's non-read planning fallback.

### Relation mutation program

`builders/relation-mutation-parser.ts` parses each transformed relation payload
into one lossless `RelationMutationProgram`:

- entries follow `RELATION_MUTATION_KEYS` order;
- item and duplicate order is preserved;
- `set: []` is preserved;
- boolean `disconnect: false` and `delete: false` are removed;
- to-one update filters and normalized target forms are preserved;
- execution-specific deduplication stays with the consumer that needs it.

Emitters and OwnWrite consume `program.entries`. Do not restore an optional
per-kind mutation bag or reopen schema-transformed payloads downstream.

### Foreign-key provenance

`write-engine/foreign-key-reference.ts` owns planning/final sources and binds
each source to one foreign/referenced field pair.

- `ForeignKeyMember` owns the final write source.
- `CorrelatedForeignKeyMember` additionally owns an independent planning read
  source.
- a transitioned key reads the old field and writes the transformed field;
- final operation references cannot enter planning SQL;
- lookup SQL is a final source and cannot decide a branch.

Callers must not resolve a source by passing an unrelated field name or switch
on source kinds. Source lowering belongs in this file.

### Branch pins

Branch sites explicitly own selected-arm guards and race pins. The `AdoptProbe`
prototype was rejected because covering all four adopt sites required arm
compiler callbacks and a duplicate exception. The older declaration-only
`Probe` was deleted because validation did not prove consumption.

Rules:

- batch found arm: captured-row presence guard, `raceable: false`;
- transaction found arm: the locked read is the premise, no duplicate guard;
- missing arm inserting the same unique target: constraint + write `racePin`;
- same-operation duplicate: no found guard and no missing pin;
- retained `notExists` pins exist only where no same-target insert constraint
  can enforce the premise.

## Main Owners

| Owner | Responsibility |
| --- | --- |
| `query-engine.ts` | public orchestration shell |
| `write-engine/CreateOperation.ts` | create semantics and fragment compilation |
| `write-engine/UpdateOperation.ts` | update semantics and fragment compilation |
| `write-engine/UpsertOperation.ts` | delegated create/update arm selection |
| `write-engine/OperationExecutor.ts` | generic fragment execution and value materialization |
| `write-engine/OperationFragment.ts` | step and fragment vocabulary |
| `builders/relation-mutation-parser.ts` | lossless mutation programs |
| `write-engine/foreign-key-reference.ts` | field-bound FK provenance |
| `ManyToManyStatements.ts` | junction SQL materialization |

Keep `QueryMetadata`, adapter `batchRefs`, and `ManyToManyStatements`. Do not add
a generic mutation DSL, payload walker, strategy framework, or shared utility
landfill.

## Core Rules

1. Adapter owns dialect SQL.
2. Parse once at the schema boundary; do not add duplicate runtime shape guards.
3. Preserve step IDs, SQL order, parameter order, and exact failure ownership.
4. Guards precede writes in a final atomic batch; relative order inside each
   bucket is stable.
5. One guard owns one invariant. Do not add redundant defense.
6. Use direct owner imports. There is no query-engine barrel or alias.

## Validation

Run focused behavior tests for the changed operation, then:

```bash
pnpm test:types
pnpm test:gates
pnpm package:build
```

Use PGlite transaction and atomic-batch witnesses for changed nested-write
paths. Run PostgreSQL and MySQL parity suites when Docker is available.
