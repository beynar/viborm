# Query Engine

The query engine turns one validated client operation into a database-agnostic
`OperationProgram`, executes that program atomically through a driver, and
parses its declared result. PostgreSQL, MySQL, SQLite, LibSQL, and PGlite share
the same operation semantics; dialect SQL remains adapter-owned.

## Ownership

```text
QueryEngine
└── creates PendingOperation
    ├── OperationCompiler → OperationProgram → SQL builders → adapter
    ├── OperationRuntime  → OperationProgram → driver
    └── OperationResults  → declared result shape → result parsers
```

| Owner | Responsibility |
| --- | --- |
| `QueryEngine` | Client-scoped driver, model/schema registry, instrumentation, client identity, and transaction-scope identity |
| `PendingOperation` | The sole lazy, Promise-like operation lifecycle |
| `OperationCompiler` | Exhaustive operation dispatch and program compilation |
| `WriteOperations` | Write compilation, including all relation mutations |
| `OperationProgram` | Data-only steps, dependencies, branches, guards, produced values, atomicity, and the declared public result |
| `OperationRuntime` | Select transaction or atomic-batch execution for the same program |
| `OperationBatchRuntime` | Specialize dynamic program branches and lower produced values for atomic batches |
| `OperationResults` | Provider result attribution, affected-row assertions, parsing, pagination reversal, and not-found handling |
| `QueryScope` | SQL-construction state only: adapter, model, aliases, root alias, and optional mutation target |
| `builders/` | Pure, adapter-backed SQL construction by semantic concern |
| `result/` | Strict row, relation, aggregate, count, scalar, and shape parsing |

`QueryEngine` is not a passthrough. Transaction-bound engines preserve the
originating `clientId`, mint a new `scopeId`, and own the driver used to create
and execute operations.

## Operation Flow

```text
client call
  → QueryEngine.prepare(...)
  → PendingOperation (still unvalidated and unexecuted)
  → validation
  → OperationCompiler
  → OperationProgram
  → OperationRuntime
       ├── one statement
       ├── one interactive transaction
       └── one atomic driver batch
  → OperationResults
  → typed public value
```

Every operation compiles to a program. A simple read or write is a one-step
program; relation writes, non-`RETURNING` emulation, deep returns, produced
keys, and dynamic branches use the same step vocabulary.

## Program Vocabulary

`operation-program.ts` defines a deliberately small declarative program, not a
second SQL AST:

- `read` and `write` execute adapter-built `Sql` fragments;
- `guard` asserts a database premise and fails closed when it changes;
- `branch` selects one declared step sequence from a prior read;
- `failure` represents an explicit typed failure;
- produced values reference prior step outputs as data.

Programs contain no callbacks, execution closures, relation objects, adapter
implementations, or driver instances. Relation semantics remain in the
compiler; runtime modules consume only program data.

## SQL Construction

SQL lives in `builders/` because the existing name remains accurate and a
folder rename would add path churn without deleting a concept. Independent
concerns remain separate:

| Concern | Primary module |
| --- | --- |
| scalar/logical where | `where-builder.ts` |
| relation predicates | `relation-filter-builder.ts` |
| selection and recursive includes | `select-builder.ts`, `include-builder.ts`, `include-many-to-many.ts` |
| ordering | `orderby-builder.ts`, `relation-orderby-builder.ts` |
| aggregation | `aggregate-utils.ts`, relation counts |
| insert values and row shapes | `values-builder.ts`, `insert-row-shapes.ts` |
| mutation assignments | `set-builder.ts` |
| many-to-many junction SQL | `many-to-many-utils.ts` |

The golden rule is absolute: query-engine code decides what the query means;
adapters decide how that meaning is written in a dialect.

```ts
// Wrong: dialect syntax in the query engine
sql`COALESCE(json_agg(...), '[]'::json)`;

// Right: adapter-owned syntax
scope.adapter.json.agg(expression);
```

Builders return parameterized `Sql` fragments, never interpolated SQL strings.
Runtime import cycles are forbidden and enforced by architecture gates.

## Relation Mutations

A nested write is a public feature, not a separate engine. `WriteOperations`
owns relation compilation through `RelationMutations` and its cohesive relation
compiler children. The compiler emits ordinary program steps; runtime does not
import relation semantics or select a nested-write interpreter.

The same program must preserve:

- foreign-key direction and compound-key behavior;
- connect, create, update, upsert, set, disconnect, and delete semantics;
- own-write visibility and concurrency guards;
- one-operation atomicity;
- equivalent transaction and atomic-batch outcomes.

## Results

`OperationResults` owns the declared public result. It validates that each
declared source was produced, keeps parser middleware caches isolated per
driver, and delegates strict shape parsing to `result/`.

Provider middleware order remains:

```text
driver parser → adapter parser → default strict parser
```

Absent rows, missing relation values, malformed scalar carriers, unexpected
columns, and invalid counts raise typed errors. Result code never substitutes a
plausible empty object, array, count, or null for malformed provider output.

## Single-Statement Inspection

`QueryEngine.build()` is intentionally a single-statement inspection API. It
returns SQL only when the compiled program contains exactly one executable SQL
step. Multi-step programs throw `QueryEngineError`; they never masquerade as
one statement. Use `prepare()` or execute the returned `PendingOperation` for
general operations.

## Lifecycle Compatibility

`PendingOperation` is the only deferred-operation class and is exported from
the package root and `viborm/client`. The deprecated `QueryMetadata<T>` name is
a type-only alias to `PendingOperation<T>` for the next published compatibility
release. No runtime metadata object or closure bag exists; the alias is planned
for removal after that compatibility window.

The internal `src/query-engine/index.ts` barrel deliberately preserves the
advanced SQL-builder and parser exports used by repository integrations and
tests. These helpers do not create a second lifecycle.

## Verification

The architecture gates assert that:

- the retired nested-write directory and routing do not exist;
- `PendingOperation` is the lifecycle composition root;
- runtime modules cannot import compiler relation semantics;
- compiler modules cannot import concrete runtimes;
- result modules cannot import compiler or runtime implementations;
- `QueryScope` contains only SQL-construction state;
- the query-engine runtime import graph is acyclic.

Behavior is proved by the shared query-engine suite and the same portable driver
contracts on PostgreSQL, MySQL, SQLite, LibSQL, and PGlite.
