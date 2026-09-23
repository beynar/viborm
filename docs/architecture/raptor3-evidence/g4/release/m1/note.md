# M1 — the key a provider without RETURNING must already know (unit note)

Ruling D-57 (Arnaud, 2026-09-21, ledger "Rulings D-55 to D-57"): census #26
(`Driver 'X' cannot locate one selected createMany row after insertion.`) and
#33 (`Raptor 3 interactive output requires RETURNING or one generated increment
field`) *share one root — MySQL cannot return the row it inserted, so the engine
must KNOW the new row's key… it does not when the DATABASE generates it (a MySQL
`UUID()` / expression default, or a composite generated key). The key is
OBSERVED before the insert (`SELECT UUID()` and its kin) and inserted as a
LITERAL… both sentences leave the census (23 → 21 public).*

This unit derived the shapes first, as the brief asks, and the derivation does
not survive contact with the tree. It makes **no engine change**, for the reason
the brief itself names — *"if a default expression cannot be observed apart from
the insert, that shape keeps its sentence — say which, with the measurement"* —
and the measurement says the ONE shape that reaches either sentence is exactly
that one. The census is unchanged at **23 public**. §6 states the ruling the
outcome now needs.

Two pins carry the measurement: a credential-free parity pin and a MySQL Docker
pin on the live lane.

---

## 1. Where a create's values come from

**The ORM has no spelling for "let the database compute this."** A scalar's
declared default is `DefaultValue<T> = T | (() => T)`
(`src/schema/scalars/common.ts:205`) — a value or a JavaScript closure. There is
no `sql`-valued default, no `dbGenerated`, no `.dbDefault()`. Every generator
modifier installs a closure and marks it as the generator's own
(`generatorDefault`, `common.ts:100`):

| declaration | `optional` | `default` | who computes the value |
| --- | --- | --- | --- |
| `s.string().id(prefix?)` (`string/scalar.ts:71`) | true | ULID closure | the ORM, at admission |
| `.uuid()` / `.ulid()` / `.nanoid()` / `.cuid()` (`string/scalar.ts:132,144,156,168`) | true | closure | the ORM, at admission |
| `s.dateTime().now()` / `.updatedAt()` (`datetime/scalar.ts:112,124`) | true | closure | the ORM, at admission |
| `.nullable()` (every scalar, e.g. `string/scalar.ts:32`) | true | `null` | the ORM, at admission |
| `.default(v)` (every scalar, e.g. `string/scalar.ts:93`) | true | `v` | the payload's own literal |
| `s.int()/.bigint().increment()` (`int/scalar.ts:106`, `bigint/scalar.ts:106`) | true | **`undefined`** | **the PROVIDER** |
| anything else | false | — | the payload MUST supply it (`validation/model/core/create.ts:290`, `mustBeSuppliedOnCreate`) |

`increment` is the only row in that table whose `default` is `undefined`, and the
create boundary fills a key whenever a default EXISTS (`hasDefault = defaultVal
!== undefined`, `validation/primitives/helpers.ts:185`) — not from the
`hasDefault` flag, which `s.string().id()` never sets. So:

> **A scalar absent from an ADMITTED create payload is an `increment` column and
> nothing else.**

Measured on every create route, not assumed (cells 1–3 of the credential-free
pin): root `create`, a nested `create`, an `upsert`'s create arm, a
`connectOrCreate`, `createMany`, a nested `createMany`, and `createMany` with
`skipDuplicates`. Falsification C below removes `.id()`'s ULID closure and the
first three cells answer with the two sentences under study — the defaults are
what keeps them unreachable, and the cells measure exactly that.

**A provider-side DDL default is written but never used.** The migration drivers
do emit one — PostgreSQL `gen_random_uuid()` and `NOW()`
(`migrations/drivers/postgres/index.ts:421`), MySQL `CURRENT_TIMESTAMP` and a
deliberate `undefined` for `uuid` (`migrations/drivers/mysql/index.ts:312`) — but
admission always spells a value, so the column default is never the value the
row receives. The ruling's "MySQL `UUID()` default" has no way to arise.

## 2. What each sentence's guard actually requires

| # | site | guard | fields it reads |
| --- | --- | --- | --- |
| 33 | `operation-context.ts:2605` | `produced.length && !supportsReturning && insertIdField(model, produced) === undefined` | `produced` = the DEMANDED fields with no value |
| 26 | `operation-context.ts:2056` | `missing.length > 0 && insertIdField(model, missing) === undefined`, inside `createMany`'s non-RETURNING / recoverable-skip arm | `missing` = the ROW KEY fields the row does not spell |
| — | `operation-context.ts:2556` | `insertIdField` answers a field only when there is exactly ONE and its `autoGenerate.kind === "increment"` | — |

`demanded` is the engine's own need (the row key, and what a dependent must
read), not the caller's `select`: a `select` of a non-key generated column is
answered by the terminal read, measured on PGlite while deriving. N4's row 16
already measured the other half — a referenced field that is not the parent's
key is refused earlier by the create's parent-id resolver, and a key field that
is not generated is never absent from an admitted payload — so `produced` and
`missing` both reduce to the same set. With §1:

> **Both sentences are reached by ONE shape: a model with MORE THAN ONE
> `increment` column among the fields the operation must know** — in practice a
> compound key of two generated parts. It is #16's shape on the batch route,
> which D-55 kept.

## 3. Per shape: what the sentence does at the base, and what it does now

| shape | sentence at the base | derived | measured after |
| --- | --- | --- | --- |
| a key the payload spells (`s.string().id()` with an id, both parts of a compound key) | none | none — the engine holds the key | none; `create`, `createMany` and the compound `pair` cells green on SQLite and MySQL |
| a key the ORM generates in JavaScript (`.id()`, `.uuid()`, `.cuid()`, `.nanoid()`, `.now()`) | none | none — admission fills it on every create route | none; cells 1–3 (SQLite) and cell 2 (MySQL) green |
| ONE `increment` column (key or not) | none | none — the provider names it for its own statement (`insertId` / `LAST_INSERT_ID`) | none; cell 4 (SQLite), cell 3 (MySQL) green, including `skipDuplicates` on MySQL's recoverable-unique-error strategy |
| a compound key of one spelled part and one `increment` | none | none — one produced field, so `insertIdField` answers | none; cell 5 (SQLite), cell 4 (MySQL) green |
| **a compound key of two `increment` parts, `create`** | **#33** | **KEEPS its sentence** — an AUTO_INCREMENT is not observable apart from its insert | #33, unchanged, cell 6 (SQLite, capability-forced) |
| **the same shape, `createMany({ select })`** | **#26** | **KEEPS its sentence**, same reason | #26, unchanged, cell 6 (SQLite, capability-forced) |
| the same shape with both parts spelled | none | none — nothing is produced | none; cell 7 green |
| **the same shape on a shipped non-RETURNING provider** | — | **no schema this ORM can PUSH holds it**: MySQL is the only `supportsReturning: false` adapter (`mysql-adapter.ts:935`; PostgreSQL `:565` and SQLite `:792` are `true`) and refuses a second AUTO_INCREMENT column — but the guard reads the declaration and the capability before any statement, so a schema declaring two `.increment()` columns reaches both sentences on mysql2 against a table the ORM did not create (the review's probe: both sentences on an empty database, zero INSERTs) | errno **1075**, SQLSTATE **42000**, MySQL 8.4.11, cell 1 of the MySQL pin; the review's declaration-only probe |

**Why the shape keeps its sentence.** The brief's own condition: a default that
cannot be observed apart from the insert. An AUTO_INCREMENT is the archetype —
`SELECT UUID()` is an ordinary observation and its value is the caller's from
then on (measured: two reads differ), while the catalog's next auto-increment is
a STATISTIC and not a reservation (measured: two reads are handed the same
number, cell 5 of the MySQL pin). Nothing between a read of it and an INSERT
stops another session from taking it, so it is not "the engine's own from then
on" and cannot be inserted as a literal.

**So no mechanism was built.** An adapter seam for "how a default is spelled"
would have zero implementations: the only database-generated value in this ORM
is the auto-increment, the only non-RETURNING provider names one per statement
already, and no schema spelling routes a column to a provider expression. That
is dead surface (ELEGANCE §5, and the maintainer's standing rule against a guard
whose unique coverage cannot be named), so the unit stops at the measurement.

## 4. The pins

**`tests/raptor3/g4/parity/generated-key-reach.test.ts` — 7 cells,
credential-free**, registered in `scripts/raptor3-manifest.mjs`
`G4_PARITY_COUNTS` (so it runs in `raptor3` and `coverage-raptor3`;
registration also removes it from the `extended-local` file walk,
`credential-free-test-manifest.mjs`'s `extendedLocalExclusions`). The transport is `RecordingSQLiteDriver` with
`supportsReturning` forced false and `last_insert_rowid()` reported as
`insertId` — MySQL's profile, credential-free.

1. a create names its row from the key the ORM produced at admission (and no
   RETURNING is spelled on the way)
2. a nested create, an upsert's create arm and a connectOrCreate name theirs the
   same way
3. a selected createMany locates every row it wrote, with and without
   `skipDuplicates`
4. one generated column rides the identity the provider names for its own
   statement (`create` and `createMany`)
5. a compound key of one spelled part and one generated part is named
6. **a compound key of two generated parts is the one shape neither arm can
   name** — #33 for `create`, #26 for `createMany({ select })`, and neither
   refusal wrote anything
7. the same compound key is named as soon as the payload spells both parts

The two compound tables are created verbatim (SQLite spells AUTOINCREMENT only
on a single INTEGER PRIMARY KEY). The DECLARATION is what the engine reads when
it decides whether it can name the row; the physical column is only somewhere to
put it.

**`tests/providers/docker/mysql2-generated-key.test.ts` — 5 cells, gated** on
`MYSQL_TEST_CONNECTION_STRING` (`describe.skip` by name when it is unset,
verified: `5 skipped`). Collected by the existing `provider-mysql2` glob
`tests/providers/docker/mysql2*.test.ts`; no manifest entry needed. It owns four
`m1gk_*` tables, creates them verbatim and drops only those — it never pushes a
schema and never drops anything it did not create, because the database is
shared with the gate-triage runs.

1. **refuses a second generated column** — errno 1075, SQLSTATE 42000
2. names a row by the key the ORM produced at admission (`create`, `createMany`)
3. names a row by the one column it generated, including through
   `skipDuplicates` (MySQL's `recoverableUniqueError` strategy,
   `mysql-adapter.ts:857`, which takes the same member-at-a-time arm)
4. names a compound key whose spelled part and generated part are both known
5. computes a default expression in a read (`SELECT UUID()` twice, different),
   but reserves no auto-increment ahead of an insert (the catalog's next value,
   read twice, identical)

Both pins are GREEN at the base and stay green: there is no engine change, so
there is no pin to be red at the base. They are boundary pins in the sense N4's
row 16 used — the measurement made durable — not witnesses of a repair.

## 5. Falsification record (backup-copy recipe, never `git checkout`)

| what was falsified | how | result |
| --- | --- | --- |
| cell 6 measures the two guards and not a coincidence | `insertIdField`: `produced.length !== 1` → `produced.length < 1`, so a second produced field is answered by the first | cell 6 goes red (neither refusal fires any more); cells 1–5 and 7 stay green |
| cells 4 and 5 measure the `increment` path | `insertIdField`: `autoGenerate?.kind === "increment"` → `=== "uuid"` | cells 4 and 5 go red with #33 / #26; cells 1–3, 6 and 7 stay green |
| cells 1–3 measure the ORM's admission-time default, and the sentences are exactly one default away | `s.string().id()`: the `default: generatorDefault(defaultUlid(prefix))` line removed (`schema/scalars/string/scalar.ts:71`) | cells 1 and 2 answer `Raptor 3 interactive output requires RETURNING or one generated increment field`, cell 3 answers `Driver 'sqlite3' cannot locate one selected createMany row after insertion.`; cells 4–7 stay green |
| the MySQL cell reads the provider's own errno | the pin's `1075` → `1076` | cell 1 goes red; cells 2–5 stay green |

Each mutation was applied to a scratchpad COPY-backed file
(`…/scratchpad/m1/backup/`) and restored by copying the backup back;
`git diff --stat` was re-read after every restore and shows only this unit's
own two files.

## 6. The engine change NOT made — a ruling for Arnaud

> **Ruling received — D-59 (Arnaud, 2026-09-21, 10:35): disposition (a), keep
> both with the map corrected.** The integrator corrected rows 26 and 33 of
> `g4/release/plan/refusals-map.md` in this unit; the census stays 23 public.

D-57 expects the census to go 23 → 21. It cannot, by the mechanism the ruling
names, for the reason in §1–§3: there is no database-generated value in this ORM
except the auto-increment, and an auto-increment cannot be observed apart from
its insert. Three dispositions are available and this unit did not choose one:

**(a) KEEP both, with the reason now recorded.** No code moves. The map rows 26
and 33 (`g4/release/plan/refusals-map.md`) change only their *reachable* column:
from "YES — smallest payload: `createMany({ data, select })` on a non-RETURNING
driver (MySQL) for a model whose generated identity isn't a single trackable
increment field" to **NO schema this ORM can push holds the shape; the declaration alone reaches it on mysql2** — the shape needs a provider
that both lacks RETURNING and admits two generated columns, and no adapter in the
tree is one. Cost: nothing. Census stays 23.

**(b) Tell them apart by construction (N4/D-52's mechanism), census 23 → 21.**
Both sites become `assertInvariant` (`shared/invariant.ts`), which the census
counts as an invariant and not a refusal. This is what would deliver D-57's
stated outcome. The objection to state plainly: an invariant is *"a state the
code cannot be in when it is right, established upstream by a type or by an
earlier owner"*, and half of what establishes this one is a PROVIDER fact
(MySQL's errno 1075), not an owner in this tree. A third-party adapter that
declared `supportsReturning: false` for a provider admitting two generated
columns would see an `EngineInvariantError` where it sees a typed capability
refusal today. That is a real, if remote, downgrade, and it is a ruling, not an
author's call.

**(c) Add the spelling the ruling assumes.** A public builder form for a
database-side default (`s.string().id().dbDefault(sql\`UUID()\`)` or whatever
spelling is chosen) would make the ruling's mechanism real and worth building:
the engine would then observe the provider's expression once per produced field
ahead of the INSERT and insert the literal, one owner, both arms, and the two
sentences would narrow to "a produced field the provider states no observation
for". That is a public-contract change and out of this unit's scope under the
common brief's stop rules.

A fourth option this unit considered and rejected on its own: folding the two
sentences into one owner (they are two readers of one fact — "which fields will
the provider produce, and can it name them?"). It would take the census to 22,
add nothing public, and improve the ownership — but it changes a registered
public sentence for one of the two arms, which is Arnaud's call, not the
author's, and it does not reach D-57's 21 either.

## 7. Runs

> Integrator's note (after the review): `receipts/census-after.md`'s provenance
> line reads "clean engine tree" because it was taken before the guide
> paragraph was written; a re-run on the unit's tree prints "with 1
> uncommitted engine file(s)" and every count identical (23 public at 30
> sites). The author's report in `receipts/author-results.json` is kept
> verbatim; its shape row "the two-generated-column shape on a shipped
> non-RETURNING provider — cannot exist" is superseded by §3's row above:
> the review measured that the declaration alone reaches both sentences on
> mysql2, so the limit is on what the ORM can push, not on the payload.

Pinned runtime `/Users/arnaud/.vite-plus/js_runtime/node/24.21.0/bin/node`,
`TMPDIR=/private/tmp/viborm-m1-tmp`, one vitest at a time under
`scripts/run-vitest-safe.mjs`.

| run | result | resources |
| --- | --- | --- |
| `generated-key-reach.test.ts` (default projects) | 14 / 14 (collected by `coverage-raptor3` and `raptor3`) | 4.84 s wall, 532.0 MiB peak RSS |
| `generated-key-reach.test.ts` `--project=raptor3` | 7 / 7 | 3.15 s wall, 473.9 MiB |
| the whole `G4_PARITY_TESTS` family, `--project=raptor3` | 17 files, **135 / 135** (128 + this unit's 7) | 4.85 s wall, 680.4 MiB |
| `mysql2-generated-key.test.ts` `--project=provider-mysql2`, gated ON | 5 / 5 | 3.30 s wall, 471.4 MiB |
| the same file with the variable UNSET | 5 skipped, named | 3.38 s wall, 472.1 MiB |
| the whole `provider-mysql2` project, **base** (before this unit's files) | 8 files, 160 failed / 580 passed / 1 skipped | 80.28 s wall, 657.6 MiB |
| the whole `provider-mysql2` project, **after** | 9 files, 160 failed / **585** passed / 1 skipped | 93.27 s wall, 657.4 MiB |
| `scripts/run-typecheck.mjs` (whole estate) | 0 diagnostics | 5.77 s wall, 5254.7 MiB |
| `scripts/raptor3-refusal-census.mjs` | **23 public** refusals at 30 sites (invariant 22/21, internal 11, registered 72) — unchanged | — |
| `scripts/query-engine-structure.mjs` | 38 files, 20 120 charged lines, 15 960 token lines, 1088 functions — unchanged | — |

**The MySQL lane, before and after, by cell identity.** Both runs' non-passing
cells were extracted by `file + fullName` and compared as sets:
`base 161, after 161, NEW [], HEALED []`. The 161 are 160 pre-existing failures
plus one pre-existing skip, in `mysql2-scalars` (124), `mysql2-relations-ddl`
(28), `mysql2-writes-raw` (5), `mysql2.test.ts` (2) and
`mysql-strict-mode-docker` (2) — the push-fingerprint family, an
`ER_LOCK_DEADLOCK`, an "Ordinary apply requires an empty managed target" and a
reserved-proof-mismatch expectation, all red before this unit existed and
untouched by it. The five cells this unit adds are the whole of the +5 passes.
Receipts: `receipts/mysql2-base.json`, `receipts/mysql2-after.json`,
`receipts/mysql2-base-cells.txt`, `receipts/mysql2-after-cells.txt`.

No `_viborm_migration_state` / `_viborm_migration_log` marker refusal was seen
in either lane run.

## 8. LOC, Biome, unverified

**LOC.** Incremental core: **0**. No file under `src/query-engine/` changed;
`scripts/query-engine-structure.mjs` reports the same 38 files / 20 120 charged
lines / 15 960 token lines as the base, and `git diff --stat` for `src/**` is
empty. The unit's whole diff is two new test files (324 and 184 lines), a
3-line `scripts/raptor3-manifest.mjs` edit (one `G4_PARITY_COUNTS` entry and its
comment), a 40-line `src/query-engine/raptor3/AGENTS.md` paragraph, and this
evidence directory.

**Biome, per file against base.** `biome check`:
`tests/raptor3/g4/parity/generated-key-reach.test.ts` 0 diagnostics,
`tests/providers/docker/mysql2-generated-key.test.ts` 0 diagnostics (both
formatted with `biome check --write`, both new files with no base copy).
`scripts/raptor3-manifest.mjs`: 70 diagnostics at the base copy and **70** now,
none of them `format` — the file was not formatted and its pre-existing
`noMisplacedAssertion` / `useTopLevelRegex` noise is unchanged.
`src/query-engine/raptor3/AGENTS.md` is ignored by Biome (Markdown).

**Unverified.**

- That `produced` can never hold a non-`increment` field rests on §1's schema
  derivation plus N4 row 16's parent-id-resolver measurement, which this unit
  read and did not re-run. The create-route half IS measured here (cells 1–3 and
  falsification C).
- The whole `raptor3` / `coverage-raptor3` projects were not re-run: no
  production file changed, and the parity family (the project's own G4 half) is
  green. The other credential-free lanes and the PGlite provider lanes were not
  re-run for the same reason.
- The claim "no shipped non-RETURNING provider admits two generated columns" is
  measured for MySQL 8.4.11 on this Docker lane. PlanetScale's adapter is the
  MySQL one, so the same DDL rule applies, but no PlanetScale run was made.
- `information_schema.TABLES.AUTO_INCREMENT` is shown to be unreserved by two
  identical reads. A concurrent-session race was not staged.
