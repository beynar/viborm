# Query Engine

The query engine turns a client operation into database-agnostic SQL
fragments, executes them atomically through a driver, and parses the declared
result. PostgreSQL, MySQL, SQLite, LibSQL, and PGlite share operation semantics;
dialect syntax remains adapter-owned.

> **Since C-01 (the Raptor 3 cutover, commit `e8114ed9`) every client operation
> is owned by `src/query-engine/raptor3/`**, built unconditionally in `VibORM`'s
> constructor and reached through `PendingOperation`'s single route arm. The V1
> write/read engine was deleted at C-01; the pattern-engine experiment and the
> owners it alone kept alive — `builders/`, `operations/`, `result/`'s parser
> tree and the rest of `write-engine/` — were deleted with it in the pattern
> retirement (D-15), and follow-up F-2 moved the last two survivors to their
> consumers (`raptor3/shared/parse-boundary.ts`, `result/groupby-fields.ts`)
> and deleted both emptied directories. `src/query-engine/raptor3/README.md` and
> `raptor3/AGENTS.md` are the normative documents for the engine that ships.

## Ownership

```text
QueryEngine
└── creates PendingOperation
    └── raptor3 route → command engine → adapter → driver → prepared read/decoder
```

| Owner | Responsibility |
| --- | --- |
| `raptor3/` | Admission, preparation, lowering, execution and decoding — the whole operation |
| `QueryEngine` | Driver, schema registry, instrumentation, client identity, and transaction scope |
| `PendingOperation` | Lazy and Promise-like public operation lifecycle |
| `routed-operations.ts` | The read/write verb vocabulary the cache and interception seams key on |
| `types.ts` | The prepared-operation, prepared-batch and guard shapes the client and the route share |
| `batch-error-attribution.ts` | Attribution of a native-batch assertion failure to the guard that raised it, and the one guard-failure-to-error construction |
| `result/` | The cache codecs (`cache-result-codec.ts`, `cache-value-codecs.ts`, `cache-json-codec.ts`, `cache-snapshot-structure.ts`), the result-shape vocabulary the client's type renderer reads, and `groupby-fields.ts` |
| `raptor3/shared/parse-boundary.ts` | The typed parse boundary: the ONE place a user payload becomes a validated, typed value |
| `context/`, `bind-budget.ts`, `execution-context.ts`, `cache-flow.ts`, `query-inspection.ts`, `result-aliases.ts`, `transaction-operation.ts`, `pending-execution.ts` | Retained boundaries outside either engine |

`QueryEngine` is not a forwarding shell. A transaction-bound engine preserves
the originating client identity, receives a new scope identity, and owns the
driver used to construct and execute operations.

## Operation flow

```text
client call
  → QueryEngine.prepare(...)
  → PendingOperation (lazy)
  → the raptor3 route: admission, prepared selector/projection, command lowering
  → adapter-spelled SQL
  → driver (direct statement, interactive transaction, or atomic driver batch)
  → the prepared read's decoder
  → typed public value
```

`raptor3/AGENTS.md` is normative for that path: the route opens and closes no
scope of its own, and never falls back to a shipped engine — there is no shipped
engine left to fall back to. It is not retry-free: the engine has four bounded
recoveries, and one of them is armed by reading `meta.raceable` off the failure
its own owner marked (`OperationContext.submit`, Arnaud's D-32). See
`raptor3/AGENTS.md` for which recovery REPLAYS and which RE-PLANS.

## SQL construction

The golden rule is absolute: query-engine code decides what a query means;
adapters decide how that meaning is written in a dialect.

```ts
// Wrong: dialect syntax in the query engine
sql`COALESCE(json_agg(...), '[]'::json)`;

// Right: adapter-owned syntax
scope.adapter.json.agg(expression);
```

SQL-emitting code returns parameterized `Sql` fragments. Query-engine code does
not match provider-specific SQL tokens to recover semantic facts. Provider
error-message and assertion-marker recognition belongs to driver error mapping.
Selectors and projections are prepared once per admission scope, and SQL and
dependency meaning consume the same prepared predicate.

## Results

Provider rows are a real trust boundary and are decoded once, at the prepared
read's own decoder. Absent rows, malformed scalar carriers, unexpected columns
and invalid counts raise typed errors; result code never substitutes a
plausible empty object, array, count, or null for malformed provider output.
Middleware caches stay isolated per driver.

## Single-statement inspection

`QueryEngine.build()` asks `PendingOperation.buildStatement()` for the one
statement an operation compiles to. Since C-01 the prepared read publishes its
`Sql` through the route's prepared handle (D-14); an operation that does not
compile to exactly one statement raises "does not compile to one SQL statement".

Use `prepare()` or await the returned `PendingOperation` for general operations.

## Lifecycle compatibility

`PendingOperation` is exported from the package root and `viborm/client`.
Operation metadata stays private to the execution pipeline; no public metadata
carrier or query-engine package entry point exists.

Use direct owner imports inside the repository. There is no query-engine barrel
or bare `@query-engine` alias; the scoped `@query-engine/*` path mapping remains.

## Verification

Run:

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
disconnect.
