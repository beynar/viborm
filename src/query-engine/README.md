# Query Engine

The query engine turns a client operation into database-agnostic SQL
fragments, executes them atomically through a driver, and parses the declared
result. PostgreSQL, MySQL, SQLite, LibSQL, and PGlite share operation semantics;
dialect syntax remains adapter-owned.

## Ownership

```text
QueryEngine
└── creates PendingOperation
    ├── operation shell → SQL builders → adapter
    ├── PlanningFragment → OperationFragment → OperationExecutor → driver
    └── declared outputs → strict result parsers
```

| Owner | Responsibility |
| --- | --- |
| `QueryEngine` | Driver, schema registry, instrumentation, client identity, and transaction scope |
| `PendingOperation` | Lazy and Promise-like public operation lifecycle |
| `write-engine/routing.ts` | Route-wide operation gates, shared-envelope parsing, and shell construction |
| `write-engine/*Operation.ts` | Public-operation-family owners and their executable fragments |
| `operations/*.ts` | Operation-specific SQL, plan, identity, and ordering helpers |
| relation Parts | Selection, membership, branches, guards, race pins, and edge effects |
| `OperationExecutor` | Generic statement, transaction, and atomic-batch execution |
| `QueryScope` | Adapter, model, aliases, root alias, and SQL-construction target |
| `builders/` | Shared SQL and semantic builders, including payload and topology parsing |
| `result/` | Strict row, relation, aggregate, count, scalar, and shape parsing |

An operation shell is the concrete owner of one public operation family. It
exposes `mode`, `planning()`, `compile(known)`, and `parse(outputs)`. Routing
applies route-wide gates and parses shared envelopes before constructing it.
The routed root shell owns the remaining family- and arm-specific parsing,
public target, result, and direct folds while delegating SQL leaves,
selected-record mutation, and relation-edge policy. `CreateOperation` is also
reused as a delegated fresh-record compiler inside an outer shell.

`QueryEngine` is not a forwarding shell. A transaction-bound engine preserves
the originating client identity, receives a new scope identity, and owns the
driver used to construct and execute operations.

## Operation flow

```text
client call
  → QueryEngine.prepare(...)
  → PendingOperation (lazy)
  → route-wide gates, shell construction, and family/arm parsing
  → PlanningFragment
  → selected OperationFragment
  → OperationExecutor
       ├── direct statement
       ├── interactive transaction
       └── atomic driver batch
  → strict result parser
  → typed public value
```

A simple read or write is one statement. Relation writes, non-returning
emulation, generated keys, branch premises, and deep results use the same small
fragment vocabulary.

## Fragment vocabulary

`write-engine/OperationFragment.ts` defines three runtime step kinds:

- `read` executes adapter-built SQL;
- `write` executes adapter-built SQL and can carry a race pin or
  conflict-skip effect;
- `guard` checks a database premise for the selected final fragment.

Produced values reference declared outputs from earlier steps. The fragment is
not a second SQL AST and contains no relation strategy, payload walker, driver,
or arbitrary context bag.

Planning has its own guard-free `PlanningFragment`. Planning is not necessarily
read-only: skip-duplicate capture performs preparation writes and publishes
their outputs. Final compilation emits only the selected effects.

## Relation writes

Nested writes are a public feature, not a second runtime. Their compiler keeps
three independent facts:

1. `RelationMutationProgram` records schema-transformed payload meaning.
2. `BoundRelation` records where the relation edge is stored.
3. A record compiler emits the mutation of one fresh or selected record.

`RelationMutationProgram` preserves operation order, item order, duplicates,
empty set, filters, and normalized target forms. Execution-specific
deduplication stays with the consumer that owns it.

`BoundRelation` classifies an edge as parent-held to-one, child-held to-one,
child-held to-many, or junction. It carries ordered topology only, not scopes,
identities, value sources, transition state, SQL, or branch policy.

Parent and child are edge-relative roles. Parent is the enclosing source record
whose relation field is being compiled; child is its target. A
`parentHeldToOne` edge means that source record stores the FK.

`CreateOperation` compiles non-bulk fresh record subtrees.
`RecordUpdateCompiler` compiles non-bulk updates for an already-selected record.
The record compiler owns scalar assignments, incoming FK values, nested record
effects, required target fields, primary-key transitions, and root-write order.

Relation Parts still own target reads, parent correlation, membership,
found/missing decisions, not-found failures, guards, race pins, junction
effects, and standalone edge effects. A write addresses the captured primary
key, not a selector that can match another row after planning.

Validation transforms are not assumed to be idempotent. Parse untrusted input
once at its trust boundary and pass transformed programs or record data
downstream.

`createMany`, `updateMany`, `deleteMany`, relation `set`, and many-and-return
folds remain specialized because they have set semantics rather than one-record
semantics.

See [write-engine/ATOM.md](write-engine/ATOM.md) for the normative write-engine
doctrine.

## SQL construction

Shared SQL and semantic sub-concerns remain in `builders/`. Operation-specific
SQL, plan, identity, and ordering helpers such as `buildUpdate`, `buildUpsert`,
and `buildCreateManyPlan` remain in `operations/`; they are not executable
operation shells.

| Concern | Primary module |
| --- | --- |
| scalar and logical filters | `where-builder.ts` |
| relation predicates | `relation-filter-builder.ts` |
| selection and recursive includes | `select-builder.ts`, `include-builder.ts` |
| ordering | `orderby-builder.ts`, `relation-orderby-builder.ts` |
| aggregation | `aggregate-utils.ts` and relation counts |
| insert values and row shapes | `values-builder.ts`, `insert-row-shapes.ts` |
| mutation assignments | `set-builder.ts` |
| relation payload meaning | `relation-mutation-parser.ts` |
| relation topology | `relation-data-builder.ts` |
| many-to-many junction SQL | `many-to-many-utils.ts`, `ManyToManyStatements.ts` |

The golden rule is absolute: query-engine code decides what a query means;
adapters decide how that meaning is written in a dialect.

```ts
// Wrong: dialect syntax in the query engine
sql`COALESCE(json_agg(...), '[]'::json)`;

// Right: adapter-owned syntax
scope.adapter.json.agg(expression);
```

SQL-emitting builders return parameterized `Sql` fragments. Query-engine code
does not match provider-specific SQL tokens to recover semantic facts. Provider
error-message and assertion-marker recognition belongs to driver error mapping.

## Results

Result parsing validates every declared source and keeps middleware caches
isolated per driver. Provider middleware order is:

```text
driver parser → adapter parser → default strict parser
```

Absent rows, malformed scalar carriers, unexpected columns, and invalid counts
raise typed errors. Result code never substitutes a plausible empty object,
array, count, or null for malformed provider output.

## Single-statement inspection

`QueryEngine.build()` returns SQL only when an operation is representable as one
statement without executor-only behavior. It rejects guards, unresolved
references, and multi-step semantics instead of pretending that an atomic
operation is one statement.

Use `prepare()` or await the returned `PendingOperation` for general operations.

## Lifecycle compatibility

`PendingOperation` is exported from the package root and `viborm/client`.
`QueryMetadata<T>` remains a deprecated type-only alias during its compatibility
window; no runtime metadata object exists.

Use direct owner imports inside the repository. There is no query-engine barrel
or bare `@query-engine` alias; the scoped `@query-engine/*` path mapping remains.

## Verification

Architecture gates check fragment vocabulary, layer imports, parsing boundaries,
result contracts, and provider-neutral behavior. Run:

```bash
pnpm test:types
pnpm test:layer:query-engine
pnpm package:build
pnpm test
```

Shared driver suites prove portable behavior on PostgreSQL, MySQL, SQLite,
LibSQL, and PGlite.

The local PGlite estate reuses one provisioned database per compatible schema
family. Ordinary cases truncate tables and restart identities; race,
staleness, lifecycle, DDL, destructive-schema, and independently committed
concurrency witnesses retain fresh databases. The family fixture owns
disconnect. The full credential-free write report is
`pnpm test:coverage:write-engine`; the representative sub-30-second gate is
`pnpm test:layer:query-engine`.
