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

Core layer projects use no network, Docker service, hosted credential, or live
provider process. Use deterministic recording drivers and fakes for core
contracts. Keep embedded, native, hosted, and Docker execution in the extended
or provider estate.

Two core estates hold a named exception, and only those two.
`tests/contracts/drivers` names every core contract that reaches a provider
resource and gives each one its own process. `tests/unit/migrations` names five
core contracts that open an in-process `better-sqlite3` database and nothing
else: `control-bootstrap`, `read-only-tracking`, `v1-apply`, `v1-operators`,
and `v1-push`. Each observes live database state no recording driver can
produce - the authenticated control table, marker arrival, read-only control
presence, and consent staleness. Every database is `:memory:`, and those files
import no second engine and no filesystem, network, or subprocess module. Two
further migration core contracts name a provider module without opening a
database at all: `decimal-provider-limits` and `v1-provider-admission`. Every
other file in `tests/unit/migrations` uses the recording drivers in
`_estate.ts`.

When a witness is retained only to execute incidental implementation metadata
for a numeric coverage gate, isolate it at the bottom of its owning layer file
under `describe("coverage low value")`. Such a witness keeps the report honest;
it is not evidence for a behavioral contract and must not be mixed into one.

The matrix in `tests/providers/matrix.ts` records one `run` or explained
`waive` decision for every shared driver contract and provider. The architecture
gate rejects stale IDs, duplicate registrations, missing assignments, empty
waiver reasons, and layers without runtime or type core coverage.

Query coverage has an additional fail-closed admission list in
`scripts/query-engine-test-manifest.mjs`. It assigns every architecture, query,
and write `.core.test.ts` file exactly once, to `QUERY_ENGINE_CORE_TESTS` (77
files) or `WRITE_ENGINE_CORE_TESTS` (56 files). Both are fast layers:
`layer-query-engine` and `layer-write-engine` execute them, so `pnpm test:core`
and `pnpm test:all` run both halves of the engine. The coverage-only
`coverage-write-engine-core` project re-reads those same 56 write files so the
query-core report can merge them; it is not their only home. A new core file
fails the policy gate until that owner is selected; recursive globs cannot
silently admit a provider-backed test.

Cache coverage admits every cache core file plus four deterministic public
cache contracts and rejects resource-owning imports. Migration coverage uses
`scripts/migration-test-manifest.mjs` for its deterministic core and selected
local extended contracts; its policy check rejects omissions and live PGlite
ownership. Client coverage uses `scripts/client-test-manifest.mjs` for the core
contracts and the audited deterministic extended contracts. Write coverage
measures those 56 provider-free core files plus one audited contract that swaps
the Neon transport for an in-process fake, 57 files in all; `test:all` retains
the exhaustive credential-free estate. All use dedicated coverage projects.

Driver coverage uses `scripts/driver-test-manifest.mjs`. It admits every
`tests/contracts/drivers` core file, five audited SQLite-backed
`.provider.test.ts` contracts, and the local SQLite3 and LibSQL suites, and it
declares the groups that give every provider-owning file its own process. The
seven PGlite files it keeps out of the focused report are pinned by name.
`test:all` selects its extended-local estate through
`scripts/credential-free-test-manifest.mjs`, which takes every non-core
`.test.ts` outside `tests/package/` and `tests/providers/` except the three
Docker suites a provider project already owns.

Only the query and write core admission is a literal list: a new architecture,
query, or write `.core.test.ts` is unowned, and the policy gate fails, until
someone assigns it. Every other manifest reads its core directory, so a new core
file joins its coverage lane automatically, while the extra non-core contracts
each manifest adds stay literal. `scripts/coverage-policy.test.mjs` re-derives
every expected set from the same directory. It refuses a resource-owning import
in each query, write, and cache contract and in each non-core migration
contract, and it requires a driver core contract that reaches a provider
resource to run alone in its own process. It also owns the named migration core
exception above and is its authority: a migration core file that reaches a
provider resource without being named fails, a named file that stops reaching
one fails, and a named in-memory SQLite file that adds a second engine, a
file-backed `dataDir`, or a host resource fails. The client set has no import
audit.

## Commands

```bash
pnpm test                 # The trusted gate: test:types:fast then test:core, budgeted under five minutes
pnpm test:core            # All core runtime projects
pnpm test:all             # Core, extended-local, local providers, optional Bun, local D1, and package checks
pnpm test:types           # COMPLETE sequential TypeScript shards, including every layer probe project
pnpm test:types:fast      # Representative lane: 10 of the plan's shards; never a substitute for test:types
pnpm test:coverage        # Sequential subsystem shards, merged global report, working-tree metadata
pnpm test:coverage:public # Public root surface; 100% in all four metrics
pnpm test:coverage:schema # Whole schema subsystem; 100% in all four metrics
pnpm test:coverage:validation # Validation subsystem; 100% in all four metrics
pnpm test:coverage:sql   # SQL subsystem; 100% in all four metrics
pnpm test:coverage:instrumentation # Instrumentation subsystem; 100% in all four metrics
pnpm test:coverage:extensions # Extensions subsystem; 100% in all four metrics
pnpm test:coverage:errors # Errors subsystem; 100% in all four metrics
pnpm test:coverage:adapters # Adapters subsystem; 100% in all four metrics
pnpm test:coverage:cli   # CLI subsystem; 100% in all four metrics
# Six approved exceptions. Floors are statements/branches/functions/lines.
pnpm test:coverage:query-engine-core # Query-engine core; 98/97.9/98/98 - two unreachable `if (!row)` arms
pnpm test:coverage:write-engine # Write engine; 82/80.5/92/82 - live-provider suites excluded by design
pnpm test:coverage:drivers # Drivers; 96/92.5/96/96 - per-provider index.ts needs a live connection
pnpm test:coverage:client # Client; 96/94/96/96 - unreachable defensive arms, uncalled functions
pnpm test:coverage:cache # Cache; 98/98/98/98
pnpm test:coverage:migrations # Migrations; 98/97.3/98/98 - 30 unreachable defensive branches
pnpm test:coverage:policy # Static ownership and launcher-policy tests
pnpm test:package         # One build, all runtime exports, all type entries, package probes
pnpm test:providers       # Docker and hosted projects only; missing environment values skip by name
pnpm test:watch           # Core projects in watch mode
pnpm test:ui              # Core projects in the Vitest UI
```

`scripts/coverage-policy.mjs` is the single source ownership manifest. It
assigns every `src/**/*.ts` file to exactly one subsystem. Adding an unowned or
multiply owned source makes every coverage config fail before Vitest starts.
The same manifest derives focused includes and thresholds and validates the
merged global report, so the two report forms cannot drift.

The repository-wide command runs subsystem shards sequentially, writes their
Istanbul JSON under `coverage/.shards/`, merges disjoint source ownership into
`coverage/index.html`, and records `HEAD`, a dirty-working-tree flag, and
visible waivers in `coverage/metadata.json`. A subsystem with an explicit
curated test list passes that list to one bounded Vitest project invocation, or
to declared sequential groups when the local provider estate needs process
isolation. A subsystem that needs more than one project runs each project once
in sequence and merges those parts. It does not start one coverage process per
test file. Provider and runtime waivers explain evidence that is unavailable in the current
environment. Waived source stays in the denominator. There are no coverage
exclusions or ignore pragmas.

Nine subsystems require 100% statements, branches, functions, and lines: public,
schema, validation, SQL, instrumentation, extensions, errors, adapters, and CLI.

The other six are not a uniform 98 and do not share one number. Each floor below
is the number actually enforced, and every departure from 100 is an APPROVED
EXCEPTION whose measured evidence is recorded in `scripts/coverage-policy.mjs`.
`scripts/merge-coverage.mjs` prints every measured metric beside its resolved
floor in the focused merge and applies the identical floors in the aggregate
merge, so the enforced value is always visible rather than inferred.

| Subsystem | St | Br | Fn | Ln | Why it is not 100 |
|---|---|---|---|---|---|
| Query-engine core | 98 | 97.9 | 98 | 98 | The `if (!row)` guards in `result-count-parser.ts` and `result-row-parser.ts` are needed to typecheck and unreachable at runtime |
| Write engine | 82 | 80.5 | 92 | 82 | The live-provider write suites belong to `test:all`; a provider-free lane cannot reach what they reach |
| Drivers | 96 | 92.5 | 96 | 96 | Closing every provider-agnostic line reaches 97.39%; the ten per-provider `index.ts` files need a live connection this lane must not open |
| Client | 96 | 94 | 96 | 96 | `default:` arms over closed unions, and seven functions with no public caller |
| Cache | 98 | 98 | 98 | 98 | Subsystem target is 98 in all four; no per-metric exception on top of it |
| Migrations | 98 | 97.3 | 98 | 98 | 30 unreachable defensive branches: 18 in `serializer.ts`, 12 in `graph.ts` |

None of these hides untested behaviour. The suites the write-engine and driver
lanes exclude all execute, and pass, in `pnpm test:all`. Every floor is a
ratchet: a real regression in any metric still fails, raising a floor is the
goal, and lowering one needs the same evidence and approval that set it. Every
focused report is written to `coverage/<subsystem>/index.html`.
Scalars, relations, and definition-time schema validation share the schema
subsystem command; no legacy per-area coverage aliases remain.

CLI coverage owns argument parsing, command routing, output, failure
translation, and cleanup. Its migrate and push contracts replace the migration
client and storage factory at their module boundaries. Migration graph,
artifact, DDL, push execution, apply, rollback, reset, and provider behavior
stay in the migration and provider suites; the CLI lane does not boot PGlite to
duplicate those owners.

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
- Run the write core fast with `pnpm test:layer:write-engine`, and the owned
  report with `pnpm test:coverage:write-engine`. The report's literal
  provider-free selection runs as the sequential parts its manifest declares —
  seven core slices plus the isolated mocked-Neon contract — in the
  single-thread `coverage-write-engine` project, each part capped at a 512 MB
  heap and merged only after its process exits. PGlite combinations remain in
  `test:all`.

A fresh database is allowed only when the contract observes DDL or migration
state, connection lifecycle or database isolation, destructive schema behavior,
independently committed concurrency, a staleness/race injection, or rollback
semantics that reuse would invalidate. Do not place concurrency or staleness
tests inside an outer rollback.

The bounded launchers share one workspace lock. Never overlap Vitest, layer
runners, or TypeScript shards. Each child process group has a 1536 MiB RSS
ceiling sampled every 250 ms. Vitest also has one worker and a 768 MB heap
ceiling a coverage subsystem may lower but never raise.
Coverage orchestration and report merging use a separate 768 MB Node heap cap.

There is exactly one allowlisted departure from 1536 MiB: an isolated live-PGlite
provider stage may take 1792 MiB. The measured basis is a single PGlite instance,
which has a 1294 MiB floor and was observed peaking at 1747 MiB. That allowance
belongs to those stages; it is not a knob callers may reach for. Generic tests,
typechecks, coverage, package work, SQLite, LibSQL and non-PGlite benchmarks all
stay at 1536.

On timeout, interruption, or RSS breach, the launcher terminates the complete
group, escalates to SIGKILL, and verifies that no group member remains before
releasing the lock.
On macOS, teardown uses `ps` state rather than `kill(-pgid, 0)` because an
already-empty or zombie-only group can report `EPERM`; a real live member still
makes verification fail closed.
The `--rss-limit-mb` launcher option may lower this ceiling; it cannot raise it.
Before taking the lock, the launcher inspects the process table and refuses a
stale workspace Vitest, TypeScript, tsdown, or Vitest worker process. It fails
closed if it cannot complete that preflight. A stale or unreadable lock requires
explicit removal after the process table proves that no verification remains.
Bounded verification fails closed on Windows until equivalent process-tree RSS
enforcement and teardown verification exist.

Complete TypeScript checking is also sequential: production, runtime-test
estates, and every existing layer type-probe project run as separate shards.
Each TypeScript shard has a 1280 MB heap and the same 1536 MiB process-group RSS
cap. This replaces the unsafe monolithic 4 GiB path without dropping files.

`pnpm test:types` is that complete estate and stays complete — no probe is ever
dropped and no file omitted to buy speed. `pnpm test:types:fast` is a separate,
explicitly representative lane of ten shards (the production shard plus one from
each structurally distinct family), and it is what `pnpm test` runs so that gate
fits under five minutes. The runner prints "REPRESENTATIVE, NOT EXHAUSTIVE" on
every fast run. Never quote a fast-lane pass as complete type coverage.

Fourteen fast commands cover the estate, one per `layer-*` project in
`vitest.workspace.ts`. That is one more than the thirteen-entry architectural
taxonomy in `tests/contracts/contract.ts`, because the query engine's runtime
core is split into a read half and a write half; the 56 write-core files are a
runnable layer of their own, not a coverage-only registration.

| Layer | Command |
|---|---|
| Validation | `pnpm test:layer:validation` |
| Scalars | `pnpm test:layer:scalars` |
| Operation schemas | `pnpm test:layer:operation-schemas` |
| Relations | `pnpm test:layer:relations` |
| Schema validation | `pnpm test:layer:schema-validation` |
| Schema JSON | `pnpm test:layer:schema-json` |
| Query engine | `pnpm test:layer:query-engine` |
| Write engine | `pnpm test:layer:write-engine` |
| Adapters | `pnpm test:layer:adapters` |
| Drivers | `pnpm test:layer:drivers` |
| Client | `pnpm test:layer:client` |
| Cache | `pnpm test:layer:cache` |
| Instrumentation | `pnpm test:layer:instrumentation` |
| Migrations | `pnpm test:layer:migrations` |

Each layer command runs runtime sentinels first and its compile-only probes
second. Both stages share one wall budget and the same 1536 MiB RSS cap. That
budget is 30 seconds for thirteen of the fourteen layers. `client` is the one
explicit exception at 45 seconds: it is the only layer whose compile-only estate
cannot be a single program at the 1280 MB shard heap, so it runs as three tsc
programs, and three tsc startups plus its runtime stage do not fit in 30 seconds.
`scripts/run-layer-core.mjs` holds the measurement and the chunking. The
exception buys wall time only — the 768 / 1280 / 1536 MiB memory contract is
untouched, which is precisely why time was the right lever. If the client type
estate ever fits in two programs, put it back to 30.

`write-engine` is the one layer with no compile-only stage: no
`tests/types/write-engine/` exists, because the write engine's probes live in
the query-engine type core, and the layer runner says the stage was skipped
rather than passing an empty program. Every other layer runs both stages.

All Vitest projects run one file at a time. Runtime selections stop after five
minutes by default. Coverage parts use ten minutes. `test:all` runs the exact
extended-local manifest as deterministic three-file process shards with five
minutes per shard, then runs each PGlite provider file in its own process with
twenty minutes. Every process must prove teardown before the next shard starts.
Do not bypass these launchers for large selections.

## Provider availability

- PGlite, SQLite3, LibSQL, and local D1 are credential-free.
- D1 runs in the official Cloudflare Workers Vitest pool with local D1 storage.
- Bun probes skip visibly when `bun` is not on `PATH`.
- PostgreSQL projects use `PG_TEST_CONNECTION_STRING` and optional
  `PGVECTOR_TEST_CONNECTION_STRING`.
- MySQL uses `MYSQL_TEST_CONNECTION_STRING`.
- Neon HTTP uses `NEON_TEST_DATABASE_URL`.
- PlanetScale connectivity uses `PLANETSCALE_TEST_DATABASE_URL`. Its read-only
  decimal fixture also needs `PLANETSCALE_TEST_NAMESPACE` and
  `PLANETSCALE_DECIMAL_FIXTURE_TABLE`.

Hosted runs are serialized and never print connection strings. The repository
has a D1 binding driver but no `d1-http` driver or package export; no synthetic
transport contract is claimed for an API that does not exist.

Unavailable optional providers produce named Vitest skips when their runtime,
service, or credential is absent. A committed capability skip must state its
reason in the suite; the LibSQL effectful live-schema group, for example, is
explicitly `DRIVER_NOT_SUPPORTED`. Matrix waivers are separate, explicit
capability decisions with non-empty reasons; they do not erase source from a
coverage denominator. A release-required provider that does not execute is a
failed release gate, not an acceptable skip.

## Adding behavior

1. Put the runtime test or type probe under its single owning layer.
2. Mark only a representative, deterministic sentinel as core.
3. For reusable database behavior, export a stable `ContractDefinition` and
   register it from provider files.
4. Add an explicit matrix decision for every provider. A waiver names the
   missing capability or fixture boundary.
5. Name the unique failure dimension before adding an assertion. Do not add a
   second guard for an invariant already protected at its owning boundary.
