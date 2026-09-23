# Query Engine — Database-Agnostic Query Planning

**Location:** `src/query-engine/`  
**Layer:** L6 — query structure and semantics

> **Since C-01 (the Raptor 3 cutover, commit `e8114ed9`) and the pattern
> retirement (D-15), the one operation owner of every client operation is
> `src/query-engine/raptor3/`** — its guide, [`raptor3/AGENTS.md`](raptor3/AGENTS.md),
> is normative for everything an operation does. It is built unconditionally in
> `VibORM`'s constructor and reached through `PendingOperation`'s single route
> arm. The V1 write/read engine, the `pattern/` experiment and the owners it
> alone kept alive (`builders/`, `operations/`, `result/`'s parser tree and
> all of `write-engine/`) are gone from disk — follow-up F-2 moved the last two
> survivors to their consumers (`parse-boundary.ts` to `raptor3/shared/`,
> `groupby-fields.ts` to `result/`) and deleted both emptied directories. The
> read/write verb vocabulary that `write-engine/routing.ts` exported lives in
> `routed-operations.ts`. What this guide still owns is below: the scalar
> semantics every layer shares, the extension execution boundary, and the rules
> that outlived both engines.

## Purpose

The query engine validates operation inputs, decides query structure, compiles
ordered SQL fragments, and parses results. It never owns database syntax.
Adapters express SQL. Drivers execute it.

## Golden rule

Every dialect-dependent SQL choice goes through the adapter. Provider error
recognition belongs to driver error mapping. Do not inspect SQL text in the
query engine to infer a dialect semantic that the compiler already knows.

## Fixed-decimal semantics

The query engine carries the schema scalar's immutable `{ precision, scale }`
descriptor. It owns operation structure, never a dialect capability verdict or
a second decimal mode. Decimal comparisons, ordering, arithmetic updates,
aggregates, list predicates, and relation-key expressions are composed through
the adapter's exact-decimal vocabulary. Do not introduce
`supportsExactDecimal`, a query-engine refusal ladder, or numeric coercion.

Validated decimal leaves enter the engine as canonical private logical text.
Scalar defaults and nested writes follow the same path. At the result boundary,
every selected decimal or decimal aggregate leaf becomes a fresh public
`Decimal`; it is never exposed as a string or JavaScript number. Decimal lists
have one logical surface but provider-specific physical carriers, so list
membership and count semantics also stay behind the adapter boundary.

One owner is the whole-list value crossing for ordinary, managed-enum and
decimal lists — `raptor3/shared/query.ts` since the retirement, where
`builders/values-builder.ts` used to be. Assignment, `push` and `unshift` route
the complete list through it, as do `hasEvery` and `hasSome` containment
candidates, which then hand the resulting `Sql` container to the adapter.
Nothing may recreate member conversion or grow one SQL fragment and bind per
member.

## Identifier semantics

A field whose format the caller NAMED — `.uuid()`, `.uuidv7()`, `.ulid()`,
`.ksuid()`, `.nanoid()`, `.cuid()` — carries a DOMAIN, and a foreign key derives
its target's. `builders/id-field.ts` is the one lookup: `idColumnOf(adapter,
model, field, relations)` for a model field (a foreign key needs the index), and
`idColumnOfPrivate(adapter, reference, relations)` for a private column — a
junction side, a polymorphic row carrier's id column — which NAMES the key it
stands in for and resolves it through that same lookup, because that key's own
domain may be derived (the one-to-one child whose primary key is its parent
foreign key) and because derivation is keyed by (model, field), never by a
scalar instance two models may share. Both answer
`{ domain, representation }`, and the REPRESENTATION is the adapter's
(`result.idRepresentation`): `bytea` on PostgreSQL and `BINARY(16)` on MySQL are
the same ULID and the engine is not allowed to know which dialect it is building
for.

These seams touch it, and there is no format switch anywhere else:

| Seam | Owner |
| --- | --- |
| Parameter | `builders/id-field.ts` `idLiteral` — the ONE binding, reached by `builders/values-builder.ts` (`buildScalarSqlValue`, `scalarValueLiteral`) and `write-engine/fragment-builders.ts` (`referenceScalarSql`), through `adapter.literals.id` / `expressions.idCast` |
| Projection | `builders/scalar-transport.ts` — a byte column travels as lowercase hex, flat and inside a JSON carrier alike |
| Aggregate | `builders/aggregate-utils.ts` `aggregateOperandExpression` — what an aggregate runs OVER, for the select list and for `having` alike; `MIN`/`MAX` take the TRANSPORTED value through the same `projectIdBytes`; see below |
| Decode | `result/ResultParser.ts`, one chain per (scalar, column); the generic string arm never sees a physical value. `parseAggregate` takes the same lookup |
| Operators | `builders/scalar-filter-operators.ts` and `builders/where-builder.ts` |
| DDL | `src/migrations` — same `idStorageOf` the adapter's promise comes from |

A DEFERRED identifier — a `Ref` into a step output — is the transport spelling,
because a step output is a row the driver returned. `expressions.idCast` is the
inverse of that transport, not a plain cast: it decodes the lowercase hex a byte
column travels as. The two are one round trip and neither moves alone.

`MIN`/`MAX` aggregate the spelling the column TRAVELS in, not the one it is
stored in, and the answer is the same: every compact format's canonical text is
fixed-width and lowercase, so its text order IS its byte order. Two facts force
it independently — PostgreSQL 16 has no `min(uuid)` and no `max(bytea)`, and
JSON cannot hold binary — and the null guard travels inside the aggregate with
it, because SQLite's `hex(NULL)` is the empty string and would win every `MIN`.

A SUBSTRING is not a value of the domain: `contains`/`startsWith`/`endsWith`
bind their operand through `scalarValueLiteral`'s explicit substring escape
hatch, and only a text-stored domain can reach them at all. A compactly stored
column is never collated or ASCII-folded as text, the identity fast path is off
for every domain field, and a decoded row takes the copy policy. Captured row
keys stay primitive canonical strings — what `fkEquals`, deduplication and the
identity map compare. Raw SQL stays physical.

## DateTime semantics

DateTime planning carries the scalar's declared SQLite physical form; it never
infers a form from a provider number. Typed writes and predicates enter as
validated ISO text and cross the adapter's DateTime literal seam. For REAL
storage, every admitted public millisecond is writable and Julian decoding
rounds back to that millisecond.

The result parser consumes the calendar, clock, and inclusive four-digit UTC
instant domain from `@validation/primitives/datetime-values`. Numeric SQLite
results first cross `datetime-physical-codec`; provider timestamp strings then
cross the result boundary's provider grammar and the same logical-domain
predicates. Both paths return a public `Date`. Do not add another range,
calendar validator, or physical-form guess in a builder. Raw SQL stays physical.

## GeoPoint semantics

Point builders consume already-normalized `GeoPoint`/`GeoArea` values. They
decide equality, bounds/polygon membership, distance comparisons, value
transport, and `_distance` select/order structure, then delegate every physical
spelling to `adapter.geoPoint`. They never rerun the codecs or inspect rendered
SQL.

The generalized distance path is shared with vector projection/result aliases.
A nullable point yields nullable distance and null sorts last in both
directions. Positive upper distance filters may add the GeoArea owner's
conservative bounds under positive polarity only; recursive scalar/relation
negation must keep that polarity exact. SQLite polygon/distance/select/order
refusals occur during compilation before cache lookup or provider execution.

## Result parsing

Provider rows are a real trust boundary and are decoded ONCE, by the prepared
read's own decoder inside `raptor3/`. Absent rows, malformed scalar carriers,
unexpected columns and invalid counts raise typed errors; result code never
substitutes a plausible empty object, array, count or null for malformed
provider output. Middleware caches stay isolated per driver.

What survives in `result/` outside the route is the CACHE boundary —
`cache-result-codec.ts`, `cache-value-codecs.ts`, `cache-json-codec.ts`,
`cache-snapshot-structure.ts` — plus the result-shape vocabulary
(`result-shape.ts`, `result-column.ts`, `result-aggregate-leaf.ts`) that
`client/typescript-type-renderer.ts` reads. `ExpectedResultShape` remains the
one runtime source for public TypeScript result rendering: a selected computed
`_distance` retains its source scalar in that shape, and consumers must not
infer nullability by rescanning the request.

## Write architecture

Nested writes are a public feature, not a second runtime, and `raptor3/`'s
commands own every part of them: admission, the prepared selector and
projection, statement lowering, the atomic unit, and decoding.
[`raptor3/AGENTS.md`](raptor3/AGENTS.md) is normative. The V1 doctrine that
used to live here — the fragment vocabulary, relation Parts, record compilers,
record series, bind-budget partitioning, row keys, to-one composition,
polymorphic relations and collections, source-bound membership and branch pins
— described owners that no longer exist. It is preserved as history in
[`docs/architecture/retired/write-engine-ATOM.md`](../../docs/architecture/retired/write-engine-ATOM.md)
and
[`docs/architecture/retired/write-engine-README.md`](../../docs/architecture/retired/write-engine-README.md),
which the architecture plans under `docs/architecture/` cite; neither describes
code on disk.

## Main owners

| Owner | Responsibility |
| --- | --- |
| `raptor3/` | admission, preparation, lowering, execution and decoding — the whole operation |
| `query-engine.ts` | client-scoped driver, registry and engine composition; it owns no executor since C-01 |
| `pending-operation.ts` | lazy public model-operation entry; its one arm is the Raptor 3 route |
| `pending-execution.ts` | one-shot default/driver-bound execution lifecycle shared by model and raw operations |
| `transaction-operation.ts` | the internal protocol consumed by `$transaction([...])` |
| `routed-operations.ts` | the read/write verb vocabulary the cache and interception seams key on |
| `types.ts` | the prepared-operation, prepared-batch and prepared-guard shapes the client and the route share, including `PreparedGuardFailure` |
| `batch-error-attribution.ts` | attribution of a native-batch assertion failure to the guard that raised it, and the ONE guard-failure-to-error construction |
| `raptor3/shared/parse-boundary.ts` | the typed parse boundary: the one place a user payload becomes a validated, typed value |
| `result/groupby-fields.ts` | the groupBy field vocabulary `result/result-shape.ts` reads |
| `result/cache-*.ts` | the cache boundary's codecs and snapshot structure |
| `result/result-shape.ts`, `result-column.ts`, `result-aggregate-leaf.ts` | the result-shape vocabulary the client's TypeScript renderer reads |
| `context/`, `bind-budget.ts`, `execution-context.ts`, `cache-flow.ts`, `query-inspection.ts`, `result-aliases.ts` | retained boundaries outside either engine |

Do not add a generic mutation DSL, payload walker, branch-step IR, locator,
strategy, lifecycle hook, or shared utility landfill. Do not recreate a second
compiler, lowerer, executor, query builder or result engine beside `raptor3/`.

## Extension execution boundary

The query engine consumes the client chain; it does not own a second middleware
registry. Request transforms run before core validation. Query interceptors run
around the prepared logical operation and must preserve the authoritative child
once `proceed()` starts. Statement transforms run once at the common typed
`Sql` boundary after statement observation and before rendering; verbatim unsafe
raw excludes transforms. Protected observers receive public completion facts
only, while official instrumentation reads private facts keyed by the exact
core-created lifecycle unit.

The capability protocols and their single runners live in
`src/extensions/request.ts`, `query.ts`, `statement.ts`, and `observation.ts`.
The engine consumes the resolved lookups from `src/extensions/chain.ts`; native
and fallback arrays share only the extension admission latch in
`src/extensions/array-admission.ts`. The query engine retains only irreducible
lifecycle triggers and the private facts it can know at execution time; it does
not wrap, copy, or reinterpret an extension handler. Core array dispatch remains
here and in the client rather than moving into the extension module.

Array coordination resolves transaction authority from the private WeakMap in
`transaction-operation.ts`. Client/scope ownership is read from unshadowable
class-private state before reservation or preparation. No operation method,
symbol property, public token, or structural protocol grants execution
authority.

Official cache execution attaches at the prepared operation's inner-core seam,
inside ordinary query interceptors. It snapshots the parsed core result before
outer post-work and remains a borrowed-row path. Callback/array transactions,
raw operations, and statement-transform chains bypass cached reads.

## Core rules

1. Adapter owns dialect SQL; driver mapping owns provider error recognition.
2. Parse once at each trust boundary.
3. Preserve SQL, parameter order, step IDs, guards, race pins, and exact errors.
4. Planning contains no guards, but can contain skip-duplicate preparation writes.
5. Atomic-batch guards precede writes with stable order inside both groups.
6. Old-read and new-write key-transition values stay distinct.
7. First-create-wins remains local to connect-or-create, and across the rows of
   one bulk series it is EXECUTION that answers it: row N observes row N−1.
8. One invariant has one guard. Every `UnsupportedOperationError` construction
   site must name a distinct first-knowable invariant and have one unique
   reachable falsifier. Before adding, moving or deleting one, read
   `docs/architecture/guard-ownership-ledger.md` — it owns the reasoning for
   every surviving site. (The inventory suite that re-resolved every coordinate
   addressed the V1 owners and was deleted with them.) A guard whose unique
   coverage cannot be named does not go in.
9. Use direct owner imports; do not recreate a query-engine barrel.
10. Keep polymorphic private storage outside public scalars. Direct payloads
    write both columns through one storage value; fixed inverse topology binds
    the same pair with its schema-owned discriminator.
11. Every inverse polymorphic predicate includes both id correlation and exact
    discriminator equality.
12. Keep ordinary read and write fast paths unchanged when no polymorphic field
    is selected or mutated.
13. Provider rows are decoded once, at the prepared read's decoder, and a
    collection result always returns a fresh public outer array.

## Validation

Run focused behavior tests for the changed operation, then:

```bash
pnpm test:types
pnpm test:layer:query-engine   # read half: runtime core + the engine type core
pnpm test:layer:write-engine   # write half: runtime core only (no type core of its own)
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

Structural SQL contracts use the shared
`tests/fixtures/drivers/sql-only.ts` fixture. Keep a local recording driver only
when the contract observes execution behavior that the shared empty-result
fixture does not own.
Provider parity files, including the decimal scalar and list surfaces, stay in
the extended `.test.ts` estate even when they are credential-free; starting an
embedded provider is not a core sentinel.

`pnpm test:coverage:query-engine-core` is THE query-engine ownership report.
Follow-up F-3 merged the former `write-engine` subsystem into it when F-2/F-6
deleted the directory that subsystem owned, so one subsystem now owns
`src/query-engine/` whole and runs four parts: `layer-query-engine`,
`coverage-write-engine-core`, `coverage-write-engine` and `coverage-raptor3`
(the engine's own deterministic test tree, `RAPTOR3_DETERMINISTIC_TESTS` in
`scripts/raptor3-manifest.mjs`). The floors are 87 / 91 / 90 / 87, RE-MEASURED
with that fourth part (87.38 / 91.1 / 90.48 / 87.38, rounded down to the
half-point; follow-up F-3, `g4/release/followups/`).

`scripts/query-engine-test-manifest.mjs` is the fail-closed registration owner
for these projects. It lists every admitted deterministic file literally, and
the coverage policy rejects a missing or duplicate architecture, query, or
write core assignment. Do not replace it with a recursive glob: a core suffix
does not prove that a future fixture is provider-free.

The engine has TWO fast layer commands, one per half.
`pnpm test:layer:query-engine` selects `QUERY_ENGINE_CORE_TESTS`, the 27
architecture and `tests/contracts/engine/query` core contracts it names.
`pnpm test:layer:write-engine` selects `WRITE_ENGINE_CORE_TESTS`, the 4 write
core contracts that outlived the V1 engine — `atomic-unit-batch`,
`dead-symbol-gate` and `parse-boundary-gate` under
`tests/contracts/engine/write`, plus `engine/query/nested-create-many.core.test.ts`,
which the manifest assigns to the write half. `vitest.workspace.ts` declares
both as `layer-*` projects, so `pnpm test:core` and `pnpm test:all` execute both
halves.

The split is a RUNTIME split. There is no `tests/types/write-engine/`: the write
half's compile-only probes live in the query-engine type core, so
`pnpm test:layer:write-engine` runs a runtime stage and prints that its type
stage was skipped, while `pnpm test:layer:query-engine` runs both. Add a write
compile-only probe to `tests/types/query-engine/`, not to a new directory — the
taxonomy census requires every `.core.types.ts` to sit under a declared test
layer, and `write-engine` is not one.
