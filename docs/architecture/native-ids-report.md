# Native IDs, big.js decimals, and automatic ID storage — evidence report

The program's normative contract is
[`native-ids-plan.md`](./native-ids-plan.md); this is what it cost and what
proves it. Every number below is measured, not estimated, and every byte is
exact.

Branch `native-ids-stage-f`. Measurement artifacts:
[`native-ids-evidence/`](./native-ids-evidence/) — `baseline.json` (stage A,
commit `fc69297b`), `stage-b.json`, `stage-c.json`, `final.json`.

---

## Outcome

### What shipped

Four runtime dependencies left the graph and one narrow one joined it.
`@paralleldrive/cuid2`, `nanoid`, `ulidx` and `decimal.js` are gone;
`@noble/hashes` (one subpath, `sha3.js`) and `big.js@7.0.1` are in. VibORM
generates all six string identifier formats itself — UUIDv4, UUIDv7, ULID,
KSUID, NanoID, CUID2 — from `crypto.getRandomValues` alone, with CUID2's output
byte-identical to the package it replaces.

Naming a format is now a **domain declaration**: every value of the field is
admitted and normalized once, and the four compact formats are stored as the
identifier rather than as its text (`uuid` / `bytea` / `BINARY(n)` / `BLOB`),
with a declared prefix kept out of the column entirely. Foreign keys derive that
domain from the key they reference — through self-relations, compound members,
one-to-one chains, junction columns and polymorphic carriers — and never declare
it again.

A bare `.id()` was deliberately left out of that: it declares a KEY, keeps text
storage and admits what a string column admits. The measurement behind that
amendment is in plan §3 — reading `.id()` as a named ULID refused VibORM's own
estate in 723 tests across 77 files, and would have done the same to every
shipped schema.

### What it costs a consumer

`node scripts/measure-bundle.mjs` bundles four frozen fixtures against the built
`dist/`, exactly as a consumer's bundler would. Raw / gzip / brotli, in bytes:

| Fixture | Metric | Baseline (A) | Stage B | Stage C | Final (F) | Δ vs baseline |
|---|---|---|---|---|---|---|
| `ids-only` | raw | 142,234 | 124,625 | 116,530 | **99,126** | −43,108 (−30.31%) |
| | gzip | 48,951 | 40,649 | 38,685 | **30,502** | −18,449 (−37.69%) |
| | brotli | 42,000 | 35,369 | 33,903 | **26,887** | −15,113 (−35.98%) |
| `decimal-only` | raw | 142,079 | 124,470 | 116,375 | **98,971** | −43,108 (−30.34%) |
| | gzip | 48,940 | 40,641 | 38,670 | **30,485** | −18,455 (−37.71%) |
| | brotli | 42,018 | 35,335 | 33,947 | **26,895** | −15,123 (−35.99%) |
| `pg-representative` | raw | 873,930 | 856,259 | 848,147 | **844,860** | −29,070 (−3.33%) |
| | gzip | 244,999 | 236,644 | 234,689 | **230,488** | −14,511 (−5.92%) |
| | brotli | 202,950 | 196,221 | 194,712 | **190,814** | −12,136 (−5.98%) |
| `full` | raw | 1,231,900 | 1,214,219 | 1,205,936 | **1,205,023** | −26,877 (−2.18%) |
| | gzip | 346,358 | 337,730 | 335,772 | **333,353** | −13,005 (−3.75%) |
| | brotli | 283,510 | 276,724 | 275,051 | **272,535** | −10,975 (−3.87%) |

The small fixtures are the honest measure of the dependency swap: a consumer who
imports the schema surface alone pays **18,449 fewer gzip bytes**, a third less
than before. The two large fixtures pull in the whole engine, so the same
absolute saving is a smaller fraction of a much larger number — 14,511 gzip
bytes off `pg-representative`, 13,005 off `full`.

Per-fixture dependency composition, which is where the saving actually is:

| Fixture | Baseline dependency bytes | Final dependency bytes |
|---|---|---|
| `ids-only` | `@noble/hashes` 4,600 · `@paralleldrive/cuid2` 1,174 · `bignumber.js` 18,872 · `decimal.js` 32,211 · `layerr` 1,538 · `nanoid` 435 · `ulidx` 1,964 = **60,794** | `@noble/hashes` 4,600 · `big.js` 6,940 = **11,540** |
| `full` | the same seven, 60,989 with the larger `decimal.js` copy | `@noble/hashes` 4,600 · `big.js` 6,971 = **11,571** |

First-party bytes rose where the new code is: `ids-only` first-party went
81,415 → 87,561 (+6,146 raw, minified), which is the codec, the storage owner
and the six generators paying for 49,254 bytes of removed packages.

**Per-library isolation** (each bundled alone; not additive with the above):

| Library | Version | raw | gzip | brotli | Status |
|---|---|---|---|---|---|
| `decimal.js` | 10.6.0 | 32,071 | 12,852 | 11,199 | removed |
| `@paralleldrive/cuid2` | 3.3.0 | 24,432 | 10,889 | 9,896 | removed (devDependency for the differential test) |
| `ulidx` | 2.4.1 | 3,455 | 1,558 | 1,386 | removed |
| `nanoid` | 5.1.16 | 439 | 356 | 299 | removed |
| `big.js` | 7.0.1 | 6,916 | 3,004 | 2,750 | added |
| `@noble/hashes` (sha3 subpath) | 2.x | — | — | — | already present at baseline (4,600 raw in every fixture) |

The four removed libraries weigh **60,397 raw / 25,655 gzip** in isolation; the
one added weighs **6,916 raw / 3,004 gzip**. `@paralleldrive/cuid2`'s figure
includes the `bignumber.js` it dragged in (18,625 of its 24,432 raw bytes) —
VibORM's CUID2 uses native `BigInt` instead. In `final.json` the removed rows
read `"available": false` because those packages are no longer installed; their
numbers above are `baseline.json`'s, measured when they were.

**Built package:** `dist/` is 175 files / 8,998,203 bytes total, of which
**1,266,076 bytes** are runtime `.mjs` (76 files). Baseline was 177 files /
8,789,065 total / 1,242,391 runtime `.mjs`. The runtime `.mjs` grew by 23,685
bytes while every consumer bundle shrank: `dist/` holds every entry point, and
the removed libraries were never in it — they were in the consumer's
`node_modules`.

**Production LOC**, `cloc`-style code lines, whole `src/`:

| Directory | Baseline | Final | Δ | Attribution |
|---|---|---|---|---|
| `validation` | 14,243 | 14,874 | +631 | `id-codec.ts`, `id-formats.ts`, `binary-shapes.ts`, the admission chain — minus the decimal exponent-widening and base-1e7 `digitsToString` port |
| `schema` | 10,721 | 11,349 | +628 | the six generators, `id-domain.ts` (`idDomainOfState` + `idStorageOf`), `id-domains.ts` (FK derivation) |
| `query-engine` | 45,973 | 46,325 | +352 | the six engine seams: parameter, projection, decode, aggregate, operators, private columns |
| `migrations` | 21,698 | 22,027 | +329 | identifier column mapping, `binary-conversion.ts`, `identifier-conversion.ts` |
| `adapters` | 2,539 | 2,594 | +55 | `literals.id`, `expressions.idCast`, `idRepresentation` per dialect |
| every other directory | — | — | 0 | untouched |
| **total** | **118,726** | **120,721** | **+1,995** | 544 → 552 files |

+1,995 lines of first-party code replaced four packages and added two formats,
domain validation, compact storage on three dialects and a conversion path.

### What it costs a database

200,000 rows per table, one payload column beside the identifier, measured on
the project's containers after `VACUUM ANALYZE` / `ANALYZE TABLE`. Scripts and
raw numbers are in `final.json` under `databaseStorage`.

**PostgreSQL 16** — `pg_total_relation_size` / `pg_relation_size` /
`pg_indexes_size`, bytes:

| Table | Total | Heap | Index | Insert wall |
|---|---|---|---|---|
| ULID as `text` | 25,239,552 | 15,237,120 | 9,961,472 | 783 ms |
| ULID as `bytea` | **20,234,240** | 12,050,432 | 8,142,848 | 428 ms |
| | −5,005,312 (−19.83%) | −3,186,688 | −1,818,624 (−18.26%) | |
| UUID as `text` | 35,127,296 | 16,891,904 | 18,194,432 | 826 ms |
| UUID as `uuid` | **21,602,304** | 12,050,432 | 9,510,912 | 781 ms |
| | −13,524,992 (−38.50%) | −4,841,472 | −8,683,520 (−47.73%) | |

A `uuid` column costs 25 bytes per row less than its text spelling, and the
index halves. The UUID index is the larger saving because random uuids also
fragment a btree: the text index is 18.2 MB where the sortable ULID's is 10.0 MB
over the same 200,000 rows.

**MySQL 8 (InnoDB)** — `DATA_LENGTH` / `INDEX_LENGTH`, bytes. InnoDB clusters on
the primary key, so a primary-key identifier has `INDEX_LENGTH` 0 and its cost
is inside `DATA_LENGTH`; the `_sec` rows carry the same identifier as a
secondary `UNIQUE` index instead, which is where the index side shows:

| Table | DATA_LENGTH | INDEX_LENGTH | Total | Insert wall |
|---|---|---|---|---|
| ULID `VARCHAR(191)` PK | 13,172,736 | 0 | 13,172,736 | 857 ms |
| ULID `BINARY(16)` PK | **11,059,200** | 0 | **11,059,200** | 657 ms |
| | | | −2,113,536 (−16.05%) | |
| UUID `VARCHAR(191)` PK | 19,480,576 | 0 | 19,480,576 | 1,100 ms |
| UUID `BINARY(16)` PK | **19,447,808** | 0 | **19,447,808** | 731 ms |
| | | | −32,768 (−0.17%) | |
| ULID `VARCHAR(191)` secondary | 15,220,736 | 8,962,048 | 24,182,784 | 1,074 ms |
| ULID `BINARY(16)` secondary | 13,123,584 | **6,832,128** | **19,955,712** | 799 ms |
| | | −2,129,920 (−23.77%) | −4,227,072 (−17.48%) | |
| UUID `VARCHAR(191)` secondary | 17,350,656 | 19,480,576 | 36,831,232 | 1,226 ms |
| UUID `BINARY(16)` secondary | 13,123,584 | **10,010,624** | **23,134,208** | 873 ms |
| | | −9,469,952 (−48.61%) | −13,697,024 (−37.19%) | |

The one row that does not save is a random UUID as a clustered primary key
(−0.17%): the page splits a random key causes dominate the 20 bytes per row the
narrower column saves. Every other shape saves 16–49%. Inserts were faster in
every compact case — 428 ms against 783 ms for the PostgreSQL ULID, 731 ms
against 1,100 ms for the MySQL UUID — though these are single-run wall times on a
laptop container and should be read as a direction, not a benchmark.

### The existing-database path (Stage F's own deliverable)

`identifierConversionChecks({ schema, model, field, dialect })`, public from
`viborm/migrations` alongside the `MigrationCheckInput` type, renders the
questions a text→identifier conversion must answer as `trusted-read` checks: no
row outside the domain, no two rows folding together under the uuid/ulid alias,
and — per referencing foreign key — that column's own rows plus set agreement
after normalization. PostgreSQL's `text` → `uuid`, the one conversion a dialect
performs, is now preceded by a `DO` block that counts the rows the cast would
abort on and names both routes.

The per-dialect recipes are in
[`docs/content/docs/migration/identifiers.mdx`](../content/docs/migration/identifiers.mdx).
Every statement on that page was executed: see Validation below.

---

## Validation

### Gates

| Gate | Result |
|---|---|
| `pnpm test:types` | (see below) |
| `pnpm test:core` | (see below) |
| `pnpm test:package` | 10 passed (10) — exports smoke, public-surface golden, dependency-types smoke, OTel-absent, TS 5.8 floor |
| `pnpm package:lint` | `publint --strict`: "All good!" · `attw --pack . --profile esm-only`: exit 0, 53 green resolutions, only the ignored `node10`/`node16-cjs` notices |
| `pnpm test:all` | `EXIT=0` — 754 passing test-file lines, zero `FAIL` / `failed` / `ELIFECYCLE` lines in the whole log, ending on `✓ \|package\| tests/package/package.test.ts (10 tests)` |
| `pnpm test:coverage:policy` | pass 11 / pass 16 / pass 6, fail 0 |

### The built package

Grepped over the built `dist/` (`.mjs` and `.d.mts`, excluding source maps):
**zero** occurrences of `decimal.js`, `ulidx`, `@paralleldrive/cuid2` or
`bignumber.js`, and zero imports of `nanoid` — the 20 remaining occurrences of
the word are the format NAME in a string literal or a union
(`["uuid","uuidv7","ulid","ksuid","nanoid","cuid"]`). Both survivors are bare
external specifiers, not inlined copies: `import q from "big.js"` in
`dist/index.mjs` and `dist/datetime-values-*.mjs`, and
`import{sha3_512 as se}from"@noble/hashes/sha3.js"` in
`dist/registration-preflight-*.mjs`.

`src/validation/primitives/id-codec.ts`, `id-formats.ts` and everything under
`src/schema/scalars/string/` import nothing from `big.js`: the identifier
language and the decimal language do not touch.

### Runtimes

**workerd** (`--project=provider-d1`, the `vitest.d1.config.ts` pool):
`✓ |provider-d1| tests/providers/workers/d1.test.ts (32 tests) 280ms` /
`Test Files 1 passed (1)` / `Tests 32 passed (32)`. That lane generates a CUID2
inside the worker request context — the native generator and its `@noble/hashes`
digest under workerd — and materializes big.js `Decimal` values from D1 rows.

**Bun 1.4.0** (`--project=provider-bun`): `Test Files 2 passed (2)` /
`Tests 2 passed | 2 skipped (4)` (the `bun-sql` legs skip without a PostgreSQL
URL). The `bun:sqlite` probe now proves the identifier path on that runtime too:
a generated ULID matching `^[0-7][0-9A-HJKMNP-TV-Z]{25}$`, a generated prefixed
`mk-<uuid>` beside it, a lowercase spelling addressing the same row, and
`typeof(id) = 'blob'` of 16 bytes for both the key and the foreign key that
derives from it — alongside the existing big.js decimal evidence
(`fixed-decimal evidence passed` / `native identifier evidence passed`).

### Provider lanes

| Lane | Result | Failures |
|---|---|---|
| `provider-pg` (Docker 5434) | `Test Files 1 failed \| 8 passed (9)` / `Tests 15 failed \| 973 passed \| 7 skipped (995)` | 15, all `tests/providers/docker/pg.test.ts` GeoPoint: "PostGIS GeoPoint preflight did not prove the required extension… VibORM never installs PostGIS." The container has no PostGIS. Pre-existing, identical set at the stage baseline |
| `provider-mysql2` (Docker 3307) | `Test Files 4 failed \| 9 passed (13)` / `Tests 156 failed \| 1068 passed \| 1 skipped (1225)` | 156, across `mysql2-scalars`, `mysql2-relations-ddl`, `mysql2.test.ts` namespace containment and `mysql-strict-mode-docker`. Pre-existing: Stage D measured the same 156 at its own baseline |
| `provider-sqlite3` + `provider-libsql` | `Test Files 11 passed \| 8 skipped (19)` / `Tests 1277 passed \| 1153 skipped (2430)` | none (libsql skips without credentials) |
| `provider-pglite` | green inside `test:all` | 858 tests across six files: `pglite-bulk-writes` 147, `pglite-nested-writes` 126, `pglite-reads` 141, `pglite-scalars` 307, `pglite-vector` 7, `pglite.test.ts` 130 (1 skipped). The lane cannot be run as one `--project=provider-pglite` process — every file exceeds the 1536 MiB sampled RSS ceiling there, as it did at the stage baseline — but `test:all` gives each file its own stage with a 2560 MiB ceiling and all six pass (peaks 1,723–1,797 MiB) |

The pre-existing failure counts are unchanged by this program: 15 + 156 = 171,
the same 171 Stage D measured in a throwaway worktree at its own tip. Passing
counts rose by 5 on each Docker lane — the new conversion pre-check tests.

### The conversion path, executed

The pre-check SQL is executed on all three dialects by
`tests/contracts/engine/query/identifier-storage-behavior.ts`, which builds a
legacy text estate (`idp_legacy_users` / `idp_legacy_notes`) seeded with exactly
the rows each check is about — an out-of-domain key, an uppercase alias of a
canonical one, an out-of-domain foreign key and an orphan — runs all four
checks, and asserts `[false, false, false, false]`; then deletes those rows and
asserts `[true, true, true, true]`. Green on `provider-pg` (24 tests),
`provider-mysql2` (24 tests) and `provider-sqlite3` (24 tests).

The per-dialect recipes on the documentation page were executed in throwaway
runs against the same containers and in-process SQLite 3.51.2. What those runs
showed, verbatim:

- PostgreSQL, the guard on a dirty estate:
  `VibORM: 1 row(s) of cvt_users.id are not canonical uuid text, so this
  conversion would abort on them.`
- PostgreSQL, why `DROP DEFAULT` is step 1:
  `default for column "id" cannot be cast automatically to type uuid`.
- PostgreSQL, after the conversion: `information_schema` reports `uuid` on both
  the key and the referencing column, and `B1FFCD88-…` came back `b1ffcd88-…` —
  the `uuid` type folds case on the way in, which is exactly what pre-check 2
  exists to catch.
- PostgreSQL, the ULID leg: `octet_length(id_bin) = 16`,
  `encode(id_bin,'hex') = 01563e3ab5d3d6764c61efb99302bd5b` — the same bytes
  VibORM's codec writes for `01ARZ3NDEKTSV4RRFFQ69G5FAV`.
- MySQL, the blind conversion the migrations layer refuses:
  strict `sql_mode` → `ERROR 1406 (22001): Data too long for column 'id' at row 1`;
  non-strict → succeeds with `Warnings: 2` and stores
  `61306565626339392D396330622D3465` (16 bytes of `"a0eebc99-9c0b-4e"`).
- MySQL, the stepwise recipe: `HEX(id) = A0EEBC999C0B4EF8BB6D6BB9BD380A11`,
  `LENGTH(id) = 16`, `COLUMN_TYPE = binary(16)` on both sides after the swap.
- SQLite, the verbatim rebuild that must not be used: `typeof(id) = 'text'`,
  `length(id) = 40` inside a `BLOB` column, no error.
- SQLite, the rebuild with a client-side decode: `typeof(id) = 'blob'`,
  `length(id) = 16`, `pragma_table_info` reports `BLOB`, and
  `PRAGMA foreign_key_check` is empty only once the child is rebuilt too — it
  reported `{table: cvt_notes, parent: cvt_users}` when only the parent was.

Every measurement table and every conversion table was dropped afterwards; both
containers hold no `sz_%` or `cvt_%` table.

### Compound selectors with derived members

The gap Stage D reported — a compound key member that is a foreign key was not
admitted or alias-normalized inside a compound `whereUnique` — was closed by
Stage D's own fix pass (`ad5f2cf0`), which rebuilt the compound member schemas
from the field's schema instead of the declaration-time snapshot. Stage F
verified it and pinned the case that needs both halves at once: a compound key
whose first member DERIVES `uuid("rm")` from the key it references and whose
second DECLARES `ulid`. Both aliases normalize, either member outside its domain
is a `ValidationError` at the operation boundary, and — the identity proof — two
spellings of one row's key hash to one cache key.

---

## Risks

**The API changes are real and are not shimmed.** `Decimal` is `Big`: 27
prototype members instead of ~130, no NaN, no Infinity, `div(0)` throws, and a
decimal.js instance is not accepted as input. A declared identifier format now
refuses values it used to accept, and `contains` / `startsWith` / `endsWith` /
`mode` are gone from the four compact formats' filter types. Both are in the
CHANGELOG with the migration spelled out; neither is discoverable at runtime
without reading it.

**Existing databases are the sharp edge.** Nothing converts automatically except
PostgreSQL's `text` → `uuid`. Everything else is refused where it is generated,
and the author converts the rows themselves, per row, from their own client. The
guide states this plainly, but a team that upgrades, pushes, and expects the
column to move will meet a refusal rather than a migration.

**The pre-checks are rendered, not run.** Nothing executes them unless the
caller passes them to `generate()` as `originChecks`. They also do not cover a
junction table's own columns or a polymorphic row carrier's id column: those
hold a key's values and convert by the same recipe, but they have no
`(model, field)` to name them by. A conversion that forgets them leaves a
readable parent beside an unreadable child.

**A derived domain narrows at run time only.** `where: { authorId: { contains } }`
typechecks on a foreign key and is refused when it runs. Closing that would need
a type-level relation resolver — a different program — and the asymmetry is
pinned in `tests/types/client/identifier-filter-narrowing.core.types.ts` so it
cannot drift silently.

**The MySQL prefix comparison follows the collation.** On a case-insensitive
collation (MySQL 8's default) the pre-check admits a prefix whose case differs,
which VibORM's own admission refuses. The check is therefore slightly
permissive there, never strict.

**`@types/big.js` is a runtime dependency.** It is correct — the published
`.d.mts` names `"big.js"`, which ships no declarations — but it is unusual
enough that a future dependency audit will want to remove it, and removing it
silently degrades every consumer's `Decimal` to `any` under `skipLibCheck`.

**Two declared dependencies the built package never imports.** `valibot` and
`arktype` are in `dependencies` and appear nowhere in `dist/`. That predates
this program and is out of its scope, but it is now written down (README,
Runtime Dependencies) rather than assumed.

**PGlite only runs one file at a time.** `--project=provider-pglite` as a single
process exceeds the runner's RSS ceiling on load, at this commit and at the
stage baseline alike; the evidence above comes from `test:all`, which isolates
each file. A future change that makes those files heavier has no headroom left
before the 2560 MiB stage ceiling either (they peak at 1,797 MiB).
