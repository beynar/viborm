# Code Organization Refactor Map

**Status:** The splits below for Shared Test Infrastructure, Nested Writes,
Query Engine Orchestration, Migration Push, Driver And Adapter Deduplication
(shared helpers only), and Error Domain are executed in the working tree as of
2026-07-02 (uncommitted). The Client split (`model-proxy.ts`, `cache-client.ts`,
`operation-kind.ts`, `transaction.ts`) and the Driver Base split
(`execution-context.ts`) are not executed — `src/client/client.ts` and
`src/drivers/driver.ts` remain single files. Verify against disk before citing
a specific split as done.

## Purpose

This is the Phase 0 split map for
`docs/architecture/code-organization-cleanup-plan.md`. It fixes the intended
module boundaries before any code moves. Later phases should follow this map
unless implementation proves a boundary impossible or unsafe.

This note is not permission to redesign folders. The existing layer-oriented
architecture stays: validation -> schema -> query-engine -> adapters -> drivers
-> client -> cache -> instrumentation -> migrations.

## Scope Gates

- No public API changes.
- No behavior changes.
- No production code changes in Phase 0.
- Query engine decides what to query; adapters decide dialect-specific SQL.
- Accepted inputs must work correctly or reject before query generation.
- No fake defaults, swallowed errors, or accepted-but-ignored behavior.
- No speculative wrappers, manager objects, or generic contexts.
- No unrelated Prisma-parity work inside cleanup phases.

## Import Direction Rules

These rules apply to every split below.

- Public entry files and barrels may re-export inward; implementation files must
  not import from barrels that can re-export themselves.
- Orchestrators import children. Children do not import orchestrators.
- Domain helpers import narrower domain helpers only. They do not reach sideways
  into unrelated layers.
- Shared helpers move to `shared` only after the common shape is real. For
  adapter and driver deduplication, the threshold is at least three dialects or
  drivers with identical behavior.
- Query-engine operations and builders receive `ctx.adapter` and call adapter
  methods for SQL syntax. They must not hardcode PostgreSQL, MySQL, or SQLite
  syntax.
- Adapter files must not import query-engine operations, model operation schemas,
  or client code.
- Drivers execute statements and own connection/transaction lifecycle. They must
  not build ORM query structure.
- Test fixtures may be imported by tests; fixtures must not import test files.

## No New God Files

Future Prisma-parity work must land in the owning domain instead of enlarging a
central file:

- New validation input shape: add it under `src/validation/model`,
  `src/validation/relations`, or the scalar/relation validation file that owns it.
- New query behavior: add or extend the named operation/builder file in
  `src/query-engine`, not `query-engine.ts`.
- New dialect syntax: add an adapter method or dialect adapter implementation,
  not query-engine SQL.
- New nested write behavior: add or extend the named nested-write concern file,
  not a catch-all nested-write file.
- New migration push behavior: add or extend the push workflow file that owns
  planning, execution, reset, enum removal, or formatting.
- New error class: add it to the error domain file that owns the code family and
  re-export it through the compatibility surface.

If a new file crosses 300 LOC, check whether it contains multiple concerns. If
an implementation file would cross 600 LOC, it needs a written cohesion
justification in this map before shipping.

## Split Map

### Shared Test Infrastructure

Phase: 1.

Target shape:

```text
tests/fixtures/
  user-post-schema.ts
  user-post-seed.ts
  drivers/
    pglite.ts
    sqlite3.ts
    libsql.ts
```

Responsibilities:

- `user-post-schema.ts` owns the common `user` and `post` model pair used by
  driver, client, and query-engine tests.
- `user-post-seed.ts` owns deterministic seed rows and insert helpers for that
  schema.
- `drivers/*.ts` own local in-memory driver construction and teardown only.
- Driver-specific tests keep backend-specific assertions in their own files.

Import direction:

- Tests import fixtures.
- Fixtures import source modules and local driver setup helpers.
- Driver fixtures may import shared schema/seed fixtures.
- Fixtures must not import concrete test files or assertion helpers tied to one
  test suite.

### Nested Writes

Phase: 2.

Target shape:

```text
src/query-engine/operations/nested-writes/
  index.ts
  create.ts
  update.ts
  connect.ts
  connect-or-create.ts
  disconnect.ts
  delete.ts
  set.ts
  fk.ts
  assertions.ts
```

Responsibilities:

- `index.ts` preserves the current exported operation names and contains no
  workflow logic.
- `create.ts` owns `executeNestedCreate`, relation `create`, relation
  `createMany`, and simple nested insert helpers.
- `update.ts` owns `executeNestedUpdate` and mutation routing for nested update
  payloads.
- `connect.ts` owns relation connect execution.
- `connect-or-create.ts` owns the connect-or-create branch only.
- `disconnect.ts` owns relation disconnect execution.
- `delete.ts` owns relation delete execution.
- `set.ts` owns relation set replacement execution.
- `fk.ts` owns FK direction usage, FK match conditions, FK value assignment,
  parent/current record correlation, and FK null assignment builders.
- `assertions.ts` owns relation input shape assertions, FK nullability
  assertions, unique-record existence assertions, and correlated row-count
  assertions.

Import direction:

- `index.ts` re-exports sibling modules only.
- `create.ts` and `update.ts` may import concern modules, `fk.ts`, and
  `assertions.ts`.
- Concern modules may import `fk.ts` and `assertions.ts`; they must not import
  `index.ts`.
- Nested-write files may import query-engine builders and context helpers.
- Nested-write files must not import `QueryEngine`.
- SQL syntax remains adapter-owned through `ctx.adapter`.

### Query Engine Orchestration

Phase: 3.

Target shape:

```text
src/query-engine/
  query-engine.ts
  executor.ts
  cache-flow.ts
  transaction-flow.ts
  result-flow.ts
```

Responsibilities:

- `query-engine.ts` remains the public `QueryEngine` orchestration class plus
  `createModelRegistry` and `createQueryEngine`.
- `executor.ts` owns operation dispatch, operation-specific build branches, and
  prepared operation creation.
- `cache-flow.ts` owns cache lookup, cache write, invalidation, and cache
  execution options.
- `transaction-flow.ts` owns batch execution, transaction execution, nested
  mutation transaction decisions, and transaction-only fallbacks.
- `result-flow.ts` owns result parsing, not-found handling, mutation refetch
  handling, and result hydration decisions.

Import direction:

- `query-engine.ts` imports the flow modules.
- Flow modules import operations, builders, `validator`, `result`, and types as
  needed.
- Operations and builders do not import flow modules or `query-engine.ts`.
- `result-flow.ts` may import `src/query-engine/result` and
  `operations/mutation-returns`; those modules do not import `result-flow.ts`.
- Adapter SQL ownership remains unchanged.

### Migration Push

Phase: 4.

Target shape:

```text
src/migrations/push/
  index.ts
  planner.ts
  executor.ts
  reset.ts
  enum-removals.ts
  format.ts
```

Responsibilities:

- `index.ts` preserves the current public exports: `push`, `introspect`,
  `generateDDL`, `formatOperation`, and `formatOperations`.
- `planner.ts` owns serialization, introspection, diffing, destructive-change
  detection, ambiguous-change detection, resolution application, and operation
  sorting.
- `executor.ts` owns DDL execution and applied-operation result assembly.
- `reset.ts` owns force-reset workflow only.
- `enum-removals.ts` owns enum value removal detection and force enum
  resolutions.
- `format.ts` owns operation and change formatting.

Import direction:

- `index.ts` imports `planner.ts`, `executor.ts`, `reset.ts`, and `format.ts`.
- `planner.ts` may import serializers, migration drivers, differ, resolver
  types, and `enum-removals.ts`.
- `executor.ts` may import migration drivers and operation types.
- `format.ts` imports migration operation types only.
- Migration drivers and differ modules must not import `push/index.ts`.

### Client

Phase: unscheduled target from the primary cleanup list.

Target shape:

```text
src/client/
  client.ts
  model-proxy.ts
  operation-kind.ts
  cache-client.ts
  transaction.ts
```

Responsibilities:

- `client.ts` keeps `VibORM`, `VibORMConfig`, `VibORMClient`, and
  `createClient`. It wires schema hydration, instrumentation, driver/cache setup,
  and the final utility-method proxy.
- `model-proxy.ts` owns recursive model operation proxy creation and model
  operation preparation.
- `operation-kind.ts` owns mutation/cacheable operation sets and type guards.
- `cache-client.ts` owns `$withCache`, SWR TTL resolution, cacheable-operation
  rejection, and lazy cached execution.
- `transaction.ts` owns `$transaction` callback mode, batch mode, nested
  transaction clients, pending-operation validation, and batch result parsing.

Import direction:

- `client.ts` imports client helpers and source-layer entry points.
- Client helpers may import `PendingOperation`, client types, `QueryEngine`
  types, cache types, driver types, and `unique-where-guard`.
- Client helpers must not import `createClient` or instantiate `VibORM`.
- Transaction helpers receive callbacks for creating transaction clients instead
  of importing the parent client class.
- Client code may call query-engine and driver public APIs; query-engine and
  drivers must not import client helpers, except for the existing
  `PendingOperation` dependency until Phase 3 changes it deliberately.

### Driver Base

Phase: 5.

Target shape:

```text
src/drivers/
  driver.ts
  execution-context.ts
```

Responsibilities:

- `driver.ts` keeps the public `Driver` base class, `TransactionBoundDriver`,
  `AnyDriver`, connection lifecycle, execution lifecycle, transaction lifecycle,
  batch lifecycle, and statement conversion.
- `execution-context.ts` owns `DriverResultParser` and
  `QueryExecutionContext`.

Import direction:

- Concrete drivers import the base driver surface.
- `driver.ts` may import `execution-context.ts`, error mapping,
  instrumentation, SQL types, and driver types.
- `execution-context.ts` imports only types needed to describe parsing and
  execution context.
- Query-engine code can depend on `AnyDriver` and driver public methods.
- Driver code must not import query-engine operation builders.

Why `TransactionBoundDriver` stays in `driver.ts` for now:

`Driver.withTransaction` constructs `TransactionBoundDriver`, and
`TransactionBoundDriver` must extend `Driver`. Splitting the wrapper directly
creates a runtime import cycle unless the base class is redesigned. That would
be architectural work, not cleanup. Keep both classes together unless a later
phase finds an acyclic split that reduces complexity instead of hiding it.

### Driver And Adapter Deduplication

Phase: 5.

Target shape:

```text
src/adapters/shared/
  result-parsing.ts
  <real-shared-dialect-helper>.ts

src/drivers/shared/
  mysql-utils.ts
  sqlite-utils.ts
  <real-shared-driver-helper>.ts
```

Responsibilities:

- Adapter shared helpers exist only for identical SQL fragment assembly across
  PostgreSQL, MySQL, and SQLite-family adapters.
- Driver shared helpers exist only for repeated lifecycle or result-shape logic
  across at least three concrete drivers.
- Dialect-specific SQL stays in dialect adapter implementations.
- Backend-specific connection details stay in concrete driver files.

Import direction:

- Dialect adapters may import adapter shared helpers.
- Adapter shared helpers must not import dialect adapters.
- Concrete drivers may import driver shared helpers.
- Driver shared helpers must not import concrete drivers.
- Query-engine code imports the adapter interface, not concrete adapters.

### Error Domain

Phase: 6.

Target shape:

```text
src/errors/
  base.ts
  constraints.ts
  query.ts
  validation.ts
  transaction.ts
  migrations.ts
  cache.ts
  index.ts
src/errors.ts
```

Responsibilities:

- `base.ts` owns `VibORMErrorCode`, `VibORMErrorMeta`, `VibORMError`,
  `isVibORMError`, `hasErrorCode`, `isRetryableError`, and `wrapError`.
- `constraints.ts` owns unique, foreign-key, not-null, and check constraint
  errors plus their type guards.
- `query.ts` owns connection/query/not-found/nested-write/unsupported-feature
  errors, pending-operation errors, query-engine errors, and unsupported
  feature constants.
- `validation.ts` owns `ValidationIssue` and `ValidationError`.
- `transaction.ts` owns `TransactionError` and
  `InvalidTransactionInputError`.
- `migrations.ts` owns `MigrationErrorMeta`, `MigrationError`, and
  `isMigrationError`.
- `cache.ts` owns cache TTL, key, and not-cacheable errors.
- `index.ts` re-exports all error domains.
- `src/errors.ts` remains as the compatibility re-export surface if existing
  imports require it.

Import direction:

- Error domain files import `base.ts`.
- `base.ts` imports no error domain file.
- `index.ts` re-exports only.
- Production code imports from the existing public error surface unless a local
  domain import is needed to avoid a cycle.

## Allowed Large Cohesive Files

These files may remain above the 600 LOC gate if their listed cohesion remains
true. Adding a second concern invalidates the exception.

| File or pattern | Cohesion reason |
| --- | --- |
| `src/adapters/database-adapter.ts` | Single adapter capability contract for all dialects. |
| `src/adapters/databases/postgres/postgres-adapter.ts` | One PostgreSQL SQL dialect implementation. |
| `src/adapters/databases/mysql/mysql-adapter.ts` | One MySQL SQL dialect implementation. |
| `src/adapters/databases/sqlite/sqlite-adapter.ts` | One SQLite-family SQL dialect implementation. |
| `src/migrations/types.ts` | Migration operation and storage type contracts, not workflow logic. |
| `src/migrations/drivers/base.ts` | Shared migration driver base contract and DDL behavior. |
| `src/migrations/drivers/postgres/index.ts` | PostgreSQL migration DDL driver. |
| `src/migrations/drivers/mysql/index.ts` | MySQL migration DDL driver. |
| `src/migrations/drivers/sqlite/index.ts` | SQLite-family migration DDL driver. |
| `src/validation/primitives/object.ts` | One validation primitive with its parser and object-shape semantics. |
| `src/query-engine/builders/relation-data-builder.ts` | Relation mutation data classification and FK direction analysis. |
| `src/query-engine/builders/include-builder.ts` | Include query construction for relation result loading. |
| `src/schema/validation/rules/relation.ts` | Relation definition-time validation rules. |
| `src/drivers/driver.ts` | Public driver lifecycle base plus transaction-bound wrapper; see Driver Base. |

Phase 7 residual note:

- `src/client/client.ts` remains above the 600 LOC gate after earlier cleanup
  (674 LOC, down from 740 at HEAD). It is not listed as a cohesive exception
  because it still combines client proxy wiring, utility-method proxying, cache
  entry points, and transaction routing. Splitting it is the unscheduled Client
  target above, so Phase 7 documents the residual instead of starting new
  architecture work.

Large test files may stay large when they are contract matrices for one domain:

- `tests/migrations/ddl-drivers.test.ts`
- `tests/query-engine/sql-generation.test.ts`
- `tests/client/operations.test.ts`
- `tests/client/batch-transaction.test.ts`
- `tests/client/all-field-types.test.ts`
- `tests/scalars/*-scalar-schemas.test.ts`
- `tests/model/args/nested-args.test.ts`
- `tests/relations/*.test.ts`

Phase 1 still extracts repeated schemas, seed rows, and driver setup from large
tests. The exception is for contract assertions, not fixture duplication.
