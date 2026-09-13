# Native IDs, big.js decimals, and automatic ID storage — evidence report

The program's normative contract is
[`native-ids-plan.md`](./native-ids-plan.md); this is what it cost and what
proves it. Every number below is measured, and every one of them is quoted from
an artifact in this repository that the command beside it regenerates.

Branch `native-ids-stage-f`. Measurement artifacts:
[`native-ids-evidence/`](./native-ids-evidence/) — `baseline.json` (stage A,
commit `fc69297b`, never regenerated), `stage-b.json`, `stage-c.json`, and
`final.json`, whose own `commit` field names the tree it was measured on. The
commits after that tree change documentation only, so `dist`, `loc` and every
fixture figure below are this tree's.

Three numbers in an earlier draft of this report were not in `final.json`, and
one table of it came from a run whose scripts were never committed. Both are
fixed at the root rather than in the prose: `scripts/measure-id-storage.mjs` is
committed and named in the block it writes, and the whole block was re-measured
twice. What that re-measurement showed is in **What it costs a database**.

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

Two consequences of compact storage are now refused rather than answered, and
both were found by reviewing this program rather than by writing it:

- A **field reference** between a compactly stored identifier column and a
  column that does not hold its values the same way. `checkRef` compares
  `ScalarType`, and `'string' === 'string'` for an identifier field and an
  ordinary one, so the comparison compiled and asked `bytes = text` — measured
  on in-process SQLite as `[]` in both directions over a row holding the same
  public string in both columns. `assertComparableIdStorage` refuses it at the
  line `assertComparableDecimalDomains` already sits on.
- A **case-folding collation** in the conversion pre-checks. Every identity
  comparison those checks make is now asked of bytes; see the conversion section
  below for what MySQL's default answered before.

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
| `pg-representative` | raw | 873,930 | 856,259 | 848,147 | **845,503** | −28,427 (−3.25%) |
| | gzip | 244,999 | 236,644 | 234,689 | **230,698** | −14,301 (−5.84%) |
| | brotli | 202,950 | 196,221 | 194,712 | **191,119** | −11,831 (−5.83%) |
| `full` | raw | 1,231,900 | 1,214,219 | 1,205,936 | **1,205,941** | −25,959 (−2.11%) |
| | gzip | 346,358 | 337,730 | 335,772 | **333,603** | −12,755 (−3.68%) |
| | brotli | 283,510 | 276,724 | 275,051 | **272,704** | −10,806 (−3.81%) |

The small fixtures are the honest measure of the dependency swap: a consumer who
imports the schema surface alone pays **18,449 fewer gzip bytes**, a third less
than before. The two large fixtures pull in the whole engine, so the same
absolute saving is a smaller fraction of a much larger number — 14,301 gzip
bytes off `pg-representative`, 12,755 off `full`.

Per-fixture dependency composition, which is where the saving actually is:

| Fixture | Baseline dependency bytes | Final dependency bytes |
|---|---|---|
| `ids-only` | `@noble/hashes` 4,600 · `@paralleldrive/cuid2` 1,174 · `bignumber.js` 18,872 · `decimal.js` 32,211 · `layerr` 1,538 · `nanoid` 435 · `ulidx` 1,964 = **60,794** | `@noble/hashes` 4,600 · `big.js` 6,940 = **11,540** |
| `full` | the same seven, **61,089** with the larger `decimal.js` and `bignumber.js` copies | `@noble/hashes` 4,600 · `big.js` 6,971 = **11,571** |

First-party bytes rose where the new code is: `ids-only` first-party went
81,415 → 87,561 (+6,146 raw, minified), which is the codec, the storage owner
and the six generators paying for 49,254 bytes of removed packages.

**Per-library isolation** (each bundled alone; not additive with the above):

| Library | Version | raw | gzip | brotli | Status |
|---|---|---|---|---|---|
| `decimal.js` | 10.6.0 | 32,071 | 12,852 | 11,199 | removed |
| `@paralleldrive/cuid2` | 3.3.0 | 24,432 | 10,889 | 9,896 | removed (kept as a devDependency for the differential test) |
| `ulidx` | 2.4.1 | 3,455 | 1,558 | 1,386 | removed |
| `nanoid` | 5.1.16 | 439 | 356 | 299 | removed |
| `big.js` | 7.0.1 | 6,916 | 3,004 | 2,750 | added |
| `@noble/hashes` (sha3 subpath) | 2.x | — | — | — | already present at baseline (4,600 raw in every fixture) |

The four removed libraries weigh **60,397 raw / 25,655 gzip** in isolation; the
one added weighs **6,916 raw / 3,004 gzip**. `@paralleldrive/cuid2`'s figure
includes the `bignumber.js` it dragged in (18,625 of its 24,432 raw bytes) —
VibORM's CUID2 uses native `BigInt` instead.

Three of those four rows read `"available": false` in `final.json`, because
`decimal.js`, `nanoid` and `ulidx` are no longer installed at all; their numbers
above are `baseline.json`'s, measured when they were. The
`@paralleldrive/cuid2` row is a full, current measurement: the package is still
a devDependency, because the CUID2 differential test asserts VibORM's digest
against it.

**Built package:** `dist/` is 175 files / 9,006,537 bytes total, of which
**1,267,000 bytes** are runtime `.mjs` (76 files). Baseline was 177 files /
8,789,065 total / 1,242,391 runtime `.mjs` (77 files). The runtime `.mjs` grew
by 24,609 bytes while every consumer bundle shrank: `dist/` holds every entry
point, and the removed libraries were never in it — they were in the consumer's
`node_modules`.

**Production LOC**, `cloc`-style code lines, whole `src/`:

| Directory | Baseline | Final | Δ | Attribution |
|---|---|---|---|---|
| `validation` | 14,243 | 14,874 | +631 | `id-codec.ts`, `id-formats.ts`, `binary-shapes.ts`, the admission chain — minus the decimal exponent-widening and base-1e7 `digitsToString` port |
| `schema` | 10,721 | 11,349 | +628 | the six generators, `id-domain.ts` (`idDomainOfState` + `idStorageOf`), `id-domains.ts` (FK derivation) |
| `query-engine` | 45,973 | 46,369 | +396 | the six engine seams — parameter, projection, decode, aggregate, operators, private columns — plus the field-reference storage check |
| `migrations` | 21,698 | 22,061 | +363 | identifier column mapping, `binary-conversion.ts`, `identifier-conversion.ts` |
| `adapters` | 2,539 | 2,594 | +55 | `literals.id`, `expressions.idCast`, `idRepresentation` per dialect |
| every other directory | — | — | 0 | untouched |
| **total** | **118,726** | **120,799** | **+2,073** | 544 → 552 files |

+2,073 lines of first-party code replaced four packages and added two formats,
domain validation, compact storage on three dialects and a conversion path.

### What it costs a database

200,000 rows per table, one payload column beside the identifier, measured on
the project's containers after `VACUUM ANALYZE` / `ANALYZE TABLE`. The script is
`scripts/measure-id-storage.mjs` and the exact command is inside the block it
writes; the raw numbers are `final.json`'s `databaseStorage.runs`.

It is a LIST of runs on purpose. An earlier draft quoted one unrepeatable run,
and its headline — a MySQL UUID `BINARY(16)` clustered key saving 0.17% — turned
out to be an artifact of InnoDB reporting `DATA_LENGTH` in 1 MiB extents. Two
full runs here disagree with it and with each other by exactly one extent on
that one table. Every other size is byte-identical across the two runs; so
everything below is quoted from run 1, and every cell that MOVED is named.

**PostgreSQL 16** — `pg_total_relation_size` / `pg_relation_size` /
`pg_indexes_size`, bytes:

| Table | Total | Heap | Index | Insert wall |
|---|---|---|---|---|
| ULID as `text` | 25,321,472 | 15,319,040 | 9,961,472 | 650 ms |
| ULID as `bytea` | **21,839,872** | 13,656,064 | 8,142,848 | 587 ms |
| | −3,481,600 (−13.75%) | −1,662,976 | −1,818,624 (−18.26%) | |
| UUID as `text` | 32,800,768 | 16,891,904 | 15,867,904 | 814 ms |
| UUID as `uuid` | **20,537,344** | 12,050,432 | 8,445,952 | 714 ms |
| | −12,263,424 (−37.39%) | −4,841,472 | −7,421,952 (−46.77%) | |

Every cell above is byte-identical in run 2 except the two random-uuid indexes,
whose btree fill is data-dependent: 15,835,136 and 8,675,328 there, −45.21%
instead of −46.77%.

A `uuid` column costs **24 bytes per row** less heap than its text spelling
(4,841,472 over 200,000 rows = 24.21), and the index roughly halves. The UUID
index is the larger saving because random uuids also fragment a btree: the text
index is 15.9 MB where the sortable ULID's is 10.0 MB over the same 200,000
rows. A `bytea` ULID saves 8.31 bytes per row of heap — a 26-character text
value against a 16-byte varlena, most of the difference eaten by alignment.

**MySQL 8 (InnoDB)** — `DATA_LENGTH` / `INDEX_LENGTH`, bytes. InnoDB clusters on
the primary key, so a primary-key identifier has `INDEX_LENGTH` 0 and its cost
is inside `DATA_LENGTH`; the `_sec` rows carry the same identifier as a
secondary `UNIQUE` index beside an ordinary auto-increment key, which is where
the index side shows:

| Table | DATA_LENGTH | INDEX_LENGTH | Total | Insert wall |
|---|---|---|---|---|
| ULID `VARCHAR(191)` PK | 14,221,312 | 0 | 14,221,312 | 835 ms |
| ULID `BINARY(16)` PK | **11,059,200** | 0 | **11,059,200** | 864 ms |
| | | | −3,162,112 (−22.24%) | |
| UUID `VARCHAR(191)` PK | 25,772,032 | 0 | 25,772,032 | 1,006 ms |
| UUID `BINARY(16)` PK | **18,399,232** | 0 | **18,399,232** | 939 ms |
| | | | −7,372,800 (−28.61%) | |
| ULID `VARCHAR(191)` secondary | 15,220,736 | 8,962,048 | 24,182,784 | 977 ms |
| ULID `BINARY(16)` secondary | 13,123,584 | **6,832,128** | **19,955,712** | 867 ms |
| | | −2,129,920 (−23.77%) | −4,227,072 (−17.48%) | |
| UUID `VARCHAR(191)` secondary | 17,350,656 | 18,432,000 | 35,782,656 | 1,127 ms |
| UUID `BINARY(16)` secondary | 13,123,584 | **10,010,624** | **23,134,208** | 988 ms |
| | | −8,421,376 (−45.69%) | −12,648,448 (−35.35%) | |

Run 2 reproduces every MySQL cell above byte for byte except one: the
`VARCHAR(191)` UUID primary key read 24,723,456 rather than 25,772,032, one
extent lower, which makes the clustered-UUID saving **−25.58%** there instead of
−28.61%. Read that pair as "roughly a quarter", and read nothing about a
clustered random key failing to save: it saves on both runs.

Every shape saves on both engines — 13.75% to 37.39% of total size, and up to
46.77% of the index side.

**Insert walls are a direction with a wide band, and one pair flips.** They are
single wall times for a batched load; across the two runs the same table moves
by up to 150 ms. Compact was faster in seven of the eight pairs in run 1; the
eighth — the MySQL ULID primary key — was 29 ms slower there and 25 ms faster in
run 2. Nothing on that column should be read as a benchmark.

### The existing-database path (Stage F's own deliverable)

`identifierConversionChecks({ schema, model, field, dialect })`, public from
`viborm/migrations` alongside the `MigrationCheckInput` type, renders the
questions a text→identifier conversion must answer as `trusted-read` checks: no
row outside the domain; no two rows folding together under the uuid/ulid alias,
asked of the key AND of every referencing column that is a complete key of its
own model; and — per referencing foreign key — that column's own rows plus set
agreement after normalization. PostgreSQL's `text` → `uuid`, the one conversion
a dialect performs, is preceded by a `DO` block that counts the rows the cast
would abort on and names both routes.

Two things about that module changed in review, and both changed the SQL rather
than the prose:

- **Every identity comparison is asked of BYTES.** MySQL 8's default collation
  is `utf8mb4_0900_ai_ci`, where `=` folds case. Measured on the project's
  container: a `ksuid` foreign key holding `0UJTSyCGVstL8paUaDQwysmNlov`
  against a parent holding `0ujtsYcgvSTl8PAuAdqWYSMnLOv` — a DIFFERENT KSUID,
  same letters — answered `ok = 1`, the estate was certified ready, and
  `ADD CONSTRAINT … FOREIGN KEY` failed after both columns became `BINARY(20)`.
  Each comparison now renders as `CAST(… AS BINARY)` on MySQL: the prefix
  equality, the alias fold's `DISTINCT`, and both sides of the agreement
  correlation. `CAST` rather than `COLLATE utf8mb4_bin`, which raises on a
  `latin1` column. The grammar match is deliberately left uncast — MySQL's
  `REGEXP` refuses a binary operand, and every pattern already spells both
  cases.
- **The fold question reaches a referencing column that is itself a key.** The
  one-to-one child whose primary key IS its foreign key carries its own unique
  constraint through the same fold, and was certified ready before then failed
  its own `ALTER` with a duplicate key. It is asked only where the model key
  catalog says that column is a complete key by itself; a many-side foreign key
  is never asked, because repeats there are the relation.

The per-dialect recipes are in
[`docs/content/docs/migration/identifiers.mdx`](../content/docs/migration/identifiers.mdx).
Every statement on that page was executed: see Validation below.

---

## Validation

### Gates

| Gate | Result |
|---|---|
| `pnpm test:types` | no diagnostics — "TypeScript (whole estate, native): 5.87s wall, 5672.2 MiB peak sampled process-group RSS (sampled ceiling 8192 MiB, whole-estate native typecheck). Teardown verified." |
| `pnpm test:core` | `Test Files 508 passed (508)` / `Tests 10357 passed (10357)` — Stage D's tip was 507 files / 10332 |
| `pnpm test:package` | 10 passed (10) — exports smoke, public-surface golden, dependency-types smoke, OTel-absent, TS 5.8 floor |
| `pnpm package:lint` | `publint --strict`: "All good!" · `attw --pack . --profile esm-only`: exit 0, 53 green resolutions, only the ignored `node10`/`node16-cjs` notices |
| `pnpm test:all` | `EXIT=0` — 754 passing test-file lines, zero `FAIL` / `failed` / `ELIFECYCLE` lines in the whole log, ending on `✓ \|package\| tests/package/package.test.ts (10 tests)` |
| `pnpm test:coverage:policy` | pass 11 / pass 16 / pass 6, fail 0 |

Coverage floors, none lowered:

| Subsystem | statements | branches | functions | lines | floors |
|---|---|---|---|---|---|
| `migrations` | 98.71% | 97.36% | 100% | 98.71% | 98 / 97.3 / 98 / 98 |
| `validation` | 100% | 100% | 100% | 100% | 100 in all four |
| `schema` | 100% | 100% | 100% | 100% | 100 in all four |
| query-engine core | 99% | 97.94% | 100% | 99% | 98 / 97.9 / 98 / 98 |

`src/migrations/identifier-conversion.ts` and `binary-conversion.ts` are both at
100% in all four metrics. Three coverage facts are worth recording rather than
hiding. The conversion walk had three arms nothing exercised (a ksuid key's
unfolded foreign-key agreement, a compound reference whose second member names
another key, and an edge whose owner is its second endpoint beside a junction
edge the walk passes over). The compound-selector test was the first caller of
`registry.validate` in the validation lane's four projects, which left that
boundary's no-field issue and its optional-argument answer newly reachable and
unmeasured. And the field-reference storage check first landed with its evidence
in the provider lanes only, which put query-engine core branches at 97.85%
against a 97.9% floor; its four arms are pinned in
`tests/contracts/engine/query/identifier-storage-sql.core.test.ts` now, and
three spellings of `names.ts ?? "unknown"` in `where-builder.ts` became one.

`npx biome check .` over the whole estate reports **49 errors, 3 warnings and 21
infos**, in exactly three files — `wrangler.test.jsonc` (18 diagnostics),
`benchmarks/validation.bench.ts` and `docs/pages/_home/DatabaseIsomorphisms.astro`
— and none of the three is in this program's diff (`git diff --name-only
1de684fb..HEAD` does not name them). The count is the same with and without this
branch's working tree. Every file the program did change is clean.

### The built package

Grepped over the built `dist/` (`.mjs` and `.d.mts`, excluding source maps):
**zero** occurrences of `decimal.js`, `ulidx`, `@paralleldrive/cuid2` or
`bignumber.js`, and zero imports of `nanoid`. The word `nanoid` survives **17
times across four files** — `grep -rio nanoid dist --include='*.mjs'
--include='*.d.mts' | wc -l`, which counts `datetime-values` 4,
`registration-preflight` 5, `schema/json.mjs` 2 and `string-*.d.mts` 6 — every
one of them the format NAME in a string literal or a union
(`["uuid","uuidv7","ulid","ksuid","nanoid","cuid"]`), with
`grep -rE '(import|from)[^\n]*["'"'"']nanoid["'"'"']' dist` returning nothing.

Both survivors are bare external specifiers, not inlined copies:
`import q from"big.js"` in `dist/index.mjs` and `dist/datetime-values-*.mjs`,
and `import{sha3_512 as se}from"@noble/hashes/sha3.js"` in
`dist/registration-preflight-*.mjs`. A third `big.js` hit, in `dist/v-*.mjs`, is
a string literal inside an error message.

`src/validation/primitives/id-codec.ts`, `id-formats.ts` and everything under
`src/schema/scalars/string/` import nothing from `big.js`: the identifier
language and the decimal language do not touch.

### Runtimes

**workerd** (`--project=provider-d1`, the `vitest.d1.config.ts` pool):
`Test Files 1 passed (1)` / `Tests 32 passed (32)`. That lane generates a CUID2
inside the worker request context — the native generator and its `@noble/hashes`
digest under workerd — and materializes big.js `Decimal` values from D1 rows.

**Bun 1.4.0** (`--project=provider-bun`): `Test Files 2 passed (2)` /
`Tests 2 passed | 2 skipped (4)` (the `bun-sql` legs skip without a PostgreSQL
URL). The `bun:sqlite` probe proves the identifier path on that runtime too: a
generated ULID matching `^[0-7][0-9A-HJKMNP-TV-Z]{25}$`, a generated prefixed
`mk-<uuid>` beside it, a lowercase spelling addressing the same row, and
`typeof(id) = 'blob'` of 16 bytes for both the key and the foreign key that
derives from it — alongside the existing big.js decimal evidence
(`fixed-decimal evidence passed` / `native identifier evidence passed`).

### Provider lanes

| Lane | Result | Failures |
|---|---|---|
| `provider-pg` (Docker 5434) | `Test Files 1 failed \| 8 passed (9)` / `Tests 15 failed \| 983 passed \| 7 skipped (1005)` | 15, all `tests/providers/docker/pg.test.ts` GeoPoint: "PostGIS GeoPoint preflight did not prove the required extension… VibORM never installs PostGIS." The container has no PostGIS. Pre-existing, identical set at the stage baseline |
| `provider-mysql2` (Docker 3307) | `Test Files 4 failed \| 9 passed (13)` / `Tests 159 failed \| 1075 passed \| 1 skipped (1235)` | 159 — see below |
| `provider-sqlite3` + `provider-libsql` | `Test Files 11 passed \| 8 skipped (19)` / `Tests 1287 passed \| 1156 skipped (2443)` | none (libsql skips without credentials) |
| `provider-pglite` | green inside `test:all` | 861 tests across six files: `pglite-bulk-writes` 147, `pglite-nested-writes` 126, `pglite-reads` 141, `pglite-scalars` 310, `pglite-vector` 7, `pglite.test.ts` 130 (1 skipped). The lane cannot be run as one `--project=provider-pglite` process — every file exceeds the 1536 MiB sampled RSS ceiling there, as it did at the stage baseline — but `test:all` gives each file its own stage with a 2560 MiB ceiling and all six pass (peaks 1,727–1,810 MiB) |

**The mysql2 count rose from 156 to 159, and all three are this program's own
tests landing inside a pre-existing red.** `tests/providers/docker/mysql2-scalars.test.ts`
fails its whole field-reference block in `beforeEach` with `MigrationError: Push
completed its statements but the final live fingerprint does not match the
desired schema`, and has done since before this branch. Measured both ways in
this worktree, one file, same command: with the stage-F-tip fixture the file is
`123 failed | 170 passed (293)`; with the three new field-reference tests it is
`126 failed | 170 passed (296)`. The three new tests are the whole delta, they
fail for their neighbours' reason, and their evidence therefore comes from
`provider-pg`, `provider-sqlite3` and `provider-libsql`, where the same contract
runs green.

Test counts rose by 10 on each Docker lane and 13 across the SQLite pair, and
here is every one of them, because an earlier draft of this report said "5" and
could not name them:

| Suite | Stage F tip | Now | What was added |
|---|---|---|---|
| `identifier-storage-behavior.ts` (pg, mysql2, sqlite3) | 24 | 31 | the 7-estate isolation matrix replacing 2 combined assertions, plus 2 for the unfolded-format estate |
| `field-reference-behavior.ts` (pg, mysql2, sqlite3, libsql, pglite) | 35 | 38 | same-storage comparison, the refusal both ways, and the text-against-text control |
| `identifier-conversion.core.test.ts` (core) | 11 | 15 | the unique/non-unique fold question, the ksuid case, and the two byte-pin renderings |
| `identifier-storage-sql.core.test.ts` (core) | 39 | 43 | the four arms of the field-reference storage check |

Excluding those additions, the pre-existing failure counts are unchanged by this
program: 15 + 156 = 171, the same 171 Stage D measured in a throwaway worktree
at its own tip.

### The conversion path, executed

The pre-check SQL is executed on all three dialects by
`tests/contracts/engine/query/identifier-storage-behavior.ts`. It no longer
seeds every defect at once: a combined estate cannot show that a check answers
its OWN question, because two checks that tested each other's defect would be
false together and true together. There is one estate per defect now, and the
vector says which check moved:

| Estate | Checks 1–4 |
|---|---|
| clean | `[true, true, true, true]` |
| one key row outside the domain | `[false, true, true, true]` |
| two spellings of one key | `[true, false, true, true]` |
| a foreign key outside the domain | `[true, true, false, false]` |
| a foreign key that names no parent | `[true, true, true, false]` |
| a key whose PREFIX differs in case | `[false, true, true, true]` |
| all four at once | `[false, false, false, false]` |

The foreign-key row is honestly two: a value that is not of the domain also
names no parent, whatever the parent table holds.

A second estate covers the format with no alias fold, where the agreement check
correlates the two columns themselves — the one comparison a collation decides.
Three checks, `[true, true, true]` on a clean estate and `[true, true, false]`
for a KSUID child differing from its parent only in case. **Both of those are
the falsification**: with the MySQL byte pin removed, `provider-mysql2` fails
exactly two tests — the prefix-case estate answering `[true,true,true,true]` and
the KSUID estate answering `[true,true,true]` — and no others, on that dialect
only. Green as shipped on `provider-pg` (31 tests), `provider-mysql2` (31) and
`provider-sqlite3` (31).

The field-reference refusal falsifies the same way: with
`assertComparableIdStorage` removed, `sqlite3-scalar-roundtrip` fails exactly
one test with `promise resolved "[]" instead of rejecting` — which is the bug,
verbatim.

The per-dialect recipes on the documentation page were executed in throwaway
runs against the same containers and in-process SQLite 3.51.2. What those runs
showed:

- PostgreSQL, the guard on a dirty estate — the WHOLE message, as the shipped
  helper emits it for `postgresTextToUuidGuard('"cvt_users"', '"id"')`, with the
  quoted, qualified identifier a generated statement always carries:

  ```text
  VibORM: 1 row(s) of "cvt_users"."id" are not canonical uuid text, so this
  conversion would abort on them. A prefixed identifier is one of the shapes
  that fails here: only the payload is stored, and no generated statement strips
  a prefix. Convert the rows yourself — add the uuid column, write the payloads
  into it, drop the old column and rename — or keep the column as it is with a
  text-family native type, which validates the domain without changing storage.
  ```

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
- MySQL, the collation: `SELECT @@collation_database` → `utf8mb4_0900_ai_ci`;
  the unfolded agreement correlation answered `ok = 1` on a broken estate and
  `ok = 0` once pinned; `substr(id,1,4) = 'usr-'` answered 1 for a stored
  `USR-…` and 0 under the pin.
- SQLite, the verbatim rebuild that must not be used: `typeof(id) = 'text'`,
  `length(id) = 40` inside a `BLOB` column, no error.
- SQLite, the rebuild with a client-side decode: `typeof(id) = 'blob'`,
  `length(id) = 16`, `pragma_table_info` reports `BLOB`, and
  `PRAGMA foreign_key_check` is empty only once the child is rebuilt too — it
  reported `{table: cvt_notes, parent: cvt_users}` when only the parent was.

Every measurement table and every conversion table was dropped afterwards; both
containers hold no `sz_%`, `cvt_%`, `rvf_%` or `idp_legacy_%` table.

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

**A field reference across identifier storage is now refused.** A query that
compared an identifier column with a plain string column used to compile and
return nothing; it now raises before any I/O. That is a behaviour change for a
query that was already answering wrongly, and it is deliberate. Text against
text is untouched in both directions — a `nanoid` column stores exactly the
string it shows.

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

**The fold check covers single-column keys only.** An identifier that is one
member of a COMPOUND unique can still collide with a sibling row that agrees on
the other members, and no portable single statement asks that — SQLite has no
`COUNT(DISTINCT a, b)`. It is written down in the guide's limits paragraph
rather than guessed at.

**A derived domain narrows at run time only.** `where: { authorId: { contains } }`
typechecks on a foreign key and is refused when it runs. Closing that would need
a type-level relation resolver — a different program — and the asymmetry is
pinned in `tests/types/client/identifier-filter-narrowing.core.types.ts` so it
cannot drift silently.

**`@types/big.js` is a runtime dependency.** It is correct — the published
`.d.mts` names `"big.js"`, which ships no declarations — but it is unusual
enough that a future dependency audit will want to remove it, and removing it
silently degrades every consumer's `Decimal` to `any` under `skipLibCheck`.

**Two declared dependencies the built package never imports.** `valibot` and
`arktype` are in `dependencies` and appear nowhere in `dist/`. That predates
this program and is out of its scope, but it is now written down (README,
Runtime Dependencies) rather than assumed.

**`tests/providers/docker/mysql2-scalars.test.ts` is red before this branch and
swallows three of its tests.** The whole field-reference block there dies in
`beforeEach` on a push-fingerprint mismatch that has nothing to do with
identifiers, so the three new field-reference tests have no MySQL evidence of
their own. Their contract is executed green on PostgreSQL, SQLite and LibSQL,
and the MySQL-specific half of the storage question — two compact columns of
different domains both being `BINARY(16)` — is pinned in the core lane against
the MySQL adapter instead.

**PGlite only runs one file at a time.** `--project=provider-pglite` as a single
process exceeds the runner's RSS ceiling on load, at this commit and at the
stage baseline alike; the evidence above comes from `test:all`, which isolates
each file.
