# Test suite architecture

The suite is organized by the contract a test protects. Database names select
execution providers; they do not own behavior.

## Taxonomy

```text
tests/
  unit/                  # Pure layer-owned behavior
  types/                 # Compile-only public and internal type contracts
  contracts/             # Cross-component behavior owned by one layer
  providers/             # Driver/runtime executors for shared contracts
  package/               # Built-package imports and consumer checks
  fixtures/              # Shared schemas, drivers, and scenario data
```

Runtime core files end in `.core.test.ts`. Compile-only core probes end in
`.core.types.ts`. Extended tests stay beside their core sentinels without the
`.core` marker. A test has one owning layer. Provider files register shared
`ContractDefinition` objects and contain only provider-boundary sentinels that
cannot be expressed without that provider.

When a witness is retained only to execute incidental implementation metadata
for a numeric coverage gate, isolate it at the bottom of its owning layer file
under `describe("coverage low value")`. Such a witness keeps the report honest;
it is not evidence for a behavioral contract and must not be mixed into one.

The matrix in `tests/providers/matrix.ts` records one `run` or explained
`waive` decision for every shared driver contract and provider. The architecture
gate rejects stale IDs, duplicate registrations, missing assignments, empty
waiver reasons, and layers without runtime or type core coverage.

## Commands

```bash
pnpm test                 # Complete type-check, then all core layer projects
pnpm test:core            # All core runtime projects
pnpm test:all             # Credential-free core, extended, local provider, Bun, D1, and package checks
pnpm test:types           # Complete TypeScript check, including compile-only probes
pnpm test:coverage        # Core projects plus the complete local write-engine estate
pnpm test:coverage:instrumentation # One-worker L11 report with a 100% four-metric gate
pnpm test:coverage:scalars # One-worker L2 report with a 100% four-metric gate
pnpm test:coverage:relations # One-worker L4 report with a 100% four-metric gate
pnpm test:coverage:schema # One-worker runtime schema-metadata report with a 100% four-metric gate
pnpm test:coverage:sql   # One-worker SQL-fragment report with a 100% four-metric gate
pnpm test:coverage:schema-validation # One-worker L5 report with a 100% four-metric gate
pnpm test:coverage:validation # One-worker L1/L3 report with a 100% four-metric gate
pnpm test:coverage:write-engine # One-worker full write-engine report and numeric gate
pnpm test:package         # One build, all runtime exports, all type entries, package probes
pnpm test:providers       # Docker and hosted projects; unavailable providers skip by name
pnpm test:watch           # Core projects in watch mode
```

The repository-wide command writes `coverage/index.html`. It includes every
core layer project and the complete credential-free write-engine contract
estate, so the write-engine row measures its behavior suite rather than only
its six core sentinels. The write-engine extension is coverage-only: it does
not enlarge `test`, `test:core`, or the 30-second query-engine layer command.

The dedicated runtime schema-metadata command writes
`coverage/schema/index.html`. It gates `src/schema/field-ref.ts` and
`src/schema/hydration.ts` at 100% in all four metrics. The aggregation runs only
the two L2 owner files; it does not register a second behavior suite.

The dedicated write-engine command writes `coverage/write-engine/index.html`.
It enforces 90% statements and lines, 95% functions, and 85% branches across
`src/query-engine/write-engine/**/*.ts`. It uses one 768 MB Vitest worker, one
coverage-processing worker, and a five-minute wall limit. Docker-only witnesses
skip visibly and do not claim provider coverage.

The two 2026-08-07 full local measurements each contain 2,388 passing tests plus
209 visible provider skips and finish in 223.53–232.92 seconds. Write-engine
coverage is 93.00% statements and lines, 90.12% branches, and 98.90% functions.
Worst observed process-group RSS was 2,465.4 MiB; the 768 MB limit applies to
the JavaScript heap, while PGlite WASM and coverage data also consume native
memory.

## PGlite fixture ownership

`usePGliteSchemaFamily` owns one PGlite database, one forced schema push, and
one disconnect for a compatible suite and schema. Before each ordinary test it
truncates every public table and restarts identities. `useBehaviorDatabase`
selects that policy for PGlite transaction and atomic-batch behavior runners;
provider factories keep isolated lifecycle ownership.

Rules:

- Reuse by schema family, never through a repository-global database.
- The family owns disconnect. A client borrowing its database must not call
  `$disconnect()`.
- Reset explicitly between parity arms inside one test. The normal `beforeEach`
  reset covers separate tests.
- Keep transaction and forced atomic-batch drivers separate even when they use
  the same schema.
- A structural/compiler proof must not boot a database.
- Run focused write files with `--project=coverage-write-engine`; without the
  project selector, workspace overlap can execute one file twice.

A fresh database is allowed only when the contract observes DDL or migration
state, connection lifecycle or database isolation, destructive schema behavior,
independently committed concurrency, a staleness/race injection, or rollback
semantics that reuse would invalidate. Do not place concurrency or staleness
tests inside an outer rollback.

The memory-capped launchers share one workspace lock. Never overlap Vitest,
layer runners, or the full TypeScript check. A launcher samples process-group
RSS and terminates the complete group on timeout or interruption.

The dedicated
instrumentation command writes `coverage/instrumentation/index.html`; it does
not overwrite the repository report or present layer-only results as global
coverage.
The dedicated validation command writes `coverage/validation/index.html` with
the same separation. Its scope is `src/validation/**/*.ts`; definition-time
`src/schema/validation` belongs to the schema-validation layer.
The dedicated scalar command writes `coverage/scalars/index.html` and covers
the scalar factories, immutable modifiers, native-type formatters, and runtime
barrels under `src/schema/scalars`.
The dedicated relation command writes `coverage/relations/index.html` and
covers immutable relation builders, lazy targets, source binding, inverse
metadata, junction pairing, and conflicting many-to-many configuration.
Relation create, update, filter, ordering, and projection schemas live under
`tests/unit/operation-schemas/relations`; they belong to L3 even though their
payloads describe relations.
The dedicated SQL command writes `coverage/sql/index.html` and covers the
callable tag, fragment composition, raw splicing, joining, placeholder formats,
statement caching, malformed construction, and structural fragment detection.
The dedicated schema-validation command writes
`coverage/schema-validation/index.html` and covers only definition-time
validation.

Every architectural layer has an explicit fast command:

| Layer | Command |
|---|---|
| Validation | `pnpm test:layer:validation` |
| Scalars | `pnpm test:layer:scalars` |
| Operation schemas | `pnpm test:layer:operation-schemas` |
| Relations | `pnpm test:layer:relations` |
| Schema validation | `pnpm test:layer:schema-validation` |
| Query engine | `pnpm test:layer:query-engine` |
| Adapters | `pnpm test:layer:adapters` |
| Drivers | `pnpm test:layer:drivers` |
| Client | `pnpm test:layer:client` |
| Cache | `pnpm test:layer:cache` |
| Instrumentation | `pnpm test:layer:instrumentation` |
| Migrations | `pnpm test:layer:migrations` |

Each layer command runs its runtime sentinels and compile-only probes
concurrently, measures complete wall time, and fails after 30 seconds. All
Vitest projects run one file at a time. The launchers cap Vitest heaps at
768 MB, layer TypeScript heaps at 1,280 MB, the complete TypeScript heap at
4,096 MB, and the package build heap at 2,048 MB. Runtime selections stop after
five minutes unless their script declares the longer 20-minute provider or
30-minute extended-suite budget. Every launcher terminates the whole process
group on timeout or interruption. Do not bypass these launchers for large
selections.

`src/instrumentation/**/*.ts`, `src/schema/relation/**/*.ts`,
`src/schema/scalars/**/*.ts`, `src/sql/sql.ts`,
`src/schema/validation/**/*.ts`, `src/validation/**/*.ts`, and
`src/query-engine/write-engine/**/*.ts` have targeted numeric coverage gates.
The first six enforce 100% statements, lines, functions, and branches. The
write engine uses the measured thresholds above because its remaining branches
include provider-only and defensive failure paths. The same path gates also
apply when repository coverage is regenerated. Every dedicated command uses a
768 MB heap cap, one Vitest worker, and one coverage-processing worker.

## Provider availability

- PGlite, SQLite3, LibSQL, and local D1 are credential-free.
- D1 runs in the official Cloudflare Workers Vitest pool with local D1 storage.
- Bun probes skip visibly when `bun` is not on `PATH`.
- PostgreSQL projects use `PG_TEST_CONNECTION_STRING` and optional
  `PGVECTOR_TEST_CONNECTION_STRING`.
- MySQL uses `MYSQL_TEST_CONNECTION_STRING`.
- Neon HTTP uses `NEON_TEST_DATABASE_URL`.
- PlanetScale uses `PLANETSCALE_TEST_DATABASE_URL`.

Hosted runs are serialized and never print connection strings. The repository
has a D1 binding driver but no `d1-http` driver or package export; no synthetic
transport contract is claimed for an API that does not exist.

## Adding behavior

1. Put the runtime test or type probe under its single owning layer.
2. Mark only a representative, deterministic sentinel as core.
3. For reusable database behavior, export a stable `ContractDefinition` and
   register it from provider files.
4. Add an explicit matrix decision for every provider. A waiver names the
   missing capability or fixture boundary.
5. Name the unique failure dimension before adding an assertion. Do not add a
   second guard for an invariant already protected at its owning boundary.
