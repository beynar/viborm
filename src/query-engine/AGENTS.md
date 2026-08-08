# Query Engine — Database-Agnostic Query Planning

**Location:** `src/query-engine/`  
**Layer:** L6 — query structure and semantics

## Purpose

The query engine validates operation inputs, decides query structure, compiles
ordered SQL fragments, and parses results. It never owns database syntax.
Adapters express SQL. Drivers execute it.

## Golden rule

Every dialect-dependent SQL choice goes through the adapter. Provider error
recognition belongs to driver error mapping. Do not inspect SQL text in the
query engine to infer a dialect semantic that the compiler already knows.

## Write architecture

```text
validated input
        ↓
RelationMutationProgram map
        ↓
root operation + relation Parts
        ↓
guard-free PlanningFragment
        ↓
selected OperationFragment
        ↓
OperationExecutor
```

See [write-engine/ATOM.md](write-engine/ATOM.md) for the normative doctrine and
[write-engine/README.md](write-engine/README.md) for the short guide.

### Execution atom

`OperationFragment.ts` defines three runtime step kinds:

- `ReadStep`;
- `WriteStep`, the only kind that can carry `racePin` or
  `onUniqueConflict`;
- `GuardStep`.

`PlanningFragment` contains statement steps and outputs, never guards. Planning
is not read-only: skip-duplicate capture performs preparation writes.
Nested `Part.planning()` currently contributes reads. Keep the executor's
non-read planning fallback.

### Local terminology

An **operation shell** is the concrete public-operation-family owner that
exposes `mode`, `planning`, `compile`, and `parse`. `write-engine/routing.ts`
owns route-wide gates and shared-envelope parsing. The routed root shell owns
the remaining family- and arm-specific parsing, target, result, and direct
folds. `CreateOperation` can also be reused as a delegated fresh-record compiler
inside another shell. Files in `write-engine/*Operation.ts` contain these
owners. Files in `operations/*.ts` contain operation-specific SQL, plan,
identity, and ordering helpers; their historical directory name does not make
them operation shells.

Within relation compilation, **parent** means the current source record at that
edge and **child** means its relation target. `parentHeldToOne` says that the
source record stores the FK. It does not claim a global model hierarchy.

### Payload meaning

`builders/relation-mutation-parser.ts` constructs one lossless
`RelationMutationProgram` for each schema-transformed relation payload. Entries
preserve mutation order, array order, duplicates, `set: []`, and normalized
targets. Emitters consume `program.entries`; they do not reparse or recreate an
optional per-kind bag.

Validation transforms are not assumed to be idempotent. Parse untrusted input
once at its trust boundary and pass transformed meaning downstream.

### Relation topology

`bindRelation` classifies an edge as `parentHeldToOne`, `childHeldToOne`,
`childHeldToMany`, or `junction`. `BoundRelation` carries ordered topology only.
It does not carry scopes, identities, value sources, transition state, SQL, or
branch policy. Bind at the first topology decision so error order and untaken
arm behavior do not move.

### Record compilers

`CreateOperation` compiles each non-bulk fresh record subtree except the explicit
inline junction-target insert. `RecordUpdateCompiler` compiles each
already-selected non-bulk record update except the top-level scalar upsert fold,
which stays in its shell to preserve the one-statement path.

The update compiler owns scalar SET data, incoming FK assignments, nested
relations, required target fields, primary-key transitions, the root UPDATE,
and descendant ordering. For a `parentHeldToOne` edge, the record compiler also
owns the inline FK fold and the branch needed to construct its root statement.
For child-held and junction edges, relation owners keep the target read,
correlation, membership, found/missing decision, guards, race pins, not-found
failure, and standalone edge effects. A true no-op allocates no step ID.

Fresh and selected compilers recurse through a type-only `RecordCompilerSeam`
with two functions: `createFresh` and `updateSelected`. It is a dependency
boundary, not a strategy framework. Runtime imports inside `write-engine` must
remain acyclic.

Direct top-level scalar folds and bulk operations remain specialized.

### Foreign-key provenance

`write-engine/foreign-key-reference.ts` binds each value source to one
foreign/referenced field pair. Transitioned keys use distinct old-read and
new-write sources. Final operation references cannot enter planning SQL, and
lookup SQL cannot decide a branch.

### Branch pins

- Captured-target batch found arm: guard the captured row, `raceable: false`.
- Scalar probe-first upsert batch found arm: reassert the original unique and
  conditional selector together with the captured primary key.
- Scalar conditional-skip batch arm: first reassert selector plus captured key
  with a non-raceable presence guard; then assert that the same row still does
  not match the conditional with a raceable absence guard. Keep that order.
- Transaction found arm: use the locked read; do not duplicate the guard.
- Missing same-target insert arm: use the constraint and root-write `racePin`.
- Same-operation duplicate: add neither guard nor race pin.
- Keep explicit absence guards only when no same-target constraint enforces the
  premise.

`RecordUpdateCompiler` and relation owners that pass it a selected target write
by the captured primary key. A scalar probe-first upsert does the same in batch
mode after guarding that the complete selector still names that captured row.
Transaction mode keeps the original selector because its locate locks the row.
The eligible `ON CONFLICT` fold has no planning read, while a relation-bearing
found arm uses `RecordUpdateCompiler` and its captured identity.

## Main owners

| Owner | Responsibility |
| --- | --- |
| `query-engine.ts` | client-scoped driver, registry, and engine composition |
| `pending-operation.ts` | lazy public operation lifecycle and routing entry |
| `write-engine/routing.ts` | route-wide operation gates, shared-envelope parsing, and shell construction |
| `operations/*.ts` | operation-specific SQL, plan, identity, and ordering helpers; not shells |
| `write-engine/CreateOperation.ts` | fresh record compilation and create result |
| `write-engine/UpdateOperation.ts` | public update shell and direct folds |
| `write-engine/RecordUpdateCompiler.ts` | one selected record mutation |
| `write-engine/UpsertOperation.ts` | top-level arm selection and terminal result |
| relation Parts | child-held/junction selection, membership, guards, pins, and edge effects |
| `write-engine/OperationExecutor.ts` | generic fragment execution |
| `write-engine/OperationFragment.ts` | step and fragment vocabulary |
| `builders/relation-mutation-parser.ts` | parsed mutation programs |
| `builders/relation-data-builder.ts` | bound relation topology |
| `write-engine/foreign-key-reference.ts` | field-bound FK provenance |
| `ManyToManyStatements.ts` | junction SQL materialization |

Keep the type-only `QueryMetadata` compatibility export, adapter `batchRefs`,
and `ManyToManyStatements`. `QueryMetadata` is not a runtime boundary. Do not
add a generic mutation DSL, payload walker, branch-step IR, locator, strategy,
lifecycle hook, or shared utility landfill.

## Core rules

1. Adapter owns dialect SQL; driver mapping owns provider error recognition.
2. Parse once at each trust boundary.
3. Preserve SQL, parameter order, step IDs, guards, race pins, and exact errors.
4. Planning contains no guards, but can contain skip-duplicate preparation writes.
5. Atomic-batch guards precede writes with stable order inside both groups.
6. Old-read and new-write key-transition values stay distinct.
7. First-create-wins remains local to connect-or-create.
8. One invariant has one guard.
9. Use direct owner imports; do not recreate a query-engine barrel.

## Validation

Run focused behavior tests for the changed operation, then:

```bash
pnpm test:types
pnpm test:layer:query-engine
pnpm package:build
pnpm test
```

Use PGlite transaction and forced atomic-batch witnesses for changed nested
writes. Run PostgreSQL and MySQL parity suites when Docker is available.

Ordinary PGlite behavior uses `usePGliteSchemaFamily`: one database and one
schema push per compatible schema and substrate, with table truncation between
tests. Reset explicitly between parity arms in one test. The fixture owns the
disconnect. Keep a fresh database only for DDL, lifecycle, destructive-schema,
independently committed concurrency, staleness/race, or rollback-isolation
contracts. Structural fragment proofs do not boot PGlite.

`pnpm test:coverage:write-engine` is the authoritative credential-free write
estate. It includes core query/architecture sentinels and every local write
behavior; `pnpm test:layer:query-engine` remains the representative fast gate.
