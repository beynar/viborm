# U4 — the two measured MySQL default gaps, closed at their owners

Repair prompt §4 (`docs/architecture/raptor3-local-closure-repair-prompt.md`),
on base `bc18b4e23`. Worktree `/private/tmp/viborm-sm`, container
`viborm-triage-mysql-20260918` (MySQL 8.4.11), table prefix `sm_`. These are
pre-existing MIGRATION defects disclosed by R2a, not engine regressions: the
engine is untouched and its census is unchanged.

## 1. The failing witnesses

The witness is `tests/unit/migrations/mysql-defaults-docker.test.ts` (new,
registered below). Both §4 cells fail on the UNCHANGED production source and
pass after the repair; the production files were swapped back to their base
copies for the red run and restored from a backup copy, never by `git
checkout`.

| cell | red at base | green after |
| --- | --- | --- |
| a backslash, a newline and a CRLF through DDL, catalog and a raw insert | `MigrationError: Manual SQL fragments containing carriage returns are refused` — and with the CR column removed, errno **1064 ER_PARSE_ERROR**: the value `end\` ended its own string literal (`receipts/red-before-backslash-parse.log`) | pass |
| `now()` at the resolved column's precision | errno **1067 ER_INVALID_DEFAULT** — `DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`; the push failed before any assertion about the default could run | pass |

Receipts: `receipts/red-before-final.log`,
`receipts/red-before-backslash-parse.log`, `receipts/green-defaults.log`.

Each production hunk was falsified INDEPENDENTLY on the repaired tree
(`receipts/falsification/`), one mutation at a time, restored by copy:

| falsification | result |
| --- | --- |
| `escapeValue` back to quote-doubling only | red — the CR/backslash cell fails, the `now()` cell still passes |
| the inverse's table back to `'` and `\` only | red — `MIGRATION_DRIFT`: "the final live fingerprint does not match the desired schema" |
| `mysqlNowExpression` pinned to bare `CURRENT_TIMESTAMP` | red — errno 1067, and the string cell still passes |

The behaviour was measured before it was repaired, on this lane's own
container, in tables the probe created and dropped:
`receipts/deparse-measurements.md` (with `probe-deparse.mjs` and
`probe-unicode.mjs` beside it).

## 2. The continuing invariants and their single owners

**(1) A declared string default reaches the column as the DECLARED value, and
comes back in the one spelling the desired side wrote.**

Owner: `mysqlStringLiteral` in `src/migrations/drivers/type-mapping.ts`, beside
`mysqlEnumType` and for the stated reason — ONE spelling, both snapshot
producers. It escapes `\` because MySQL reads a backslash inside a string
literal as an escape introducer (so quote-doubling alone stored a BACKSPACE for
`a\b` and could not spell `end\` at all), and NUL, LF, CR and ctrl-Z because a
generated statement is also the review blob, which is UTF-8/LF with no carriage
returns (`sql-blob.ts`, unchanged). The single table
`MYSQL_LITERAL_ESCAPES` is read forwards by the writer and BACKWARDS by the
catalog inverse (`MYSQL_PRINTED_CHARACTERS` in
`src/migrations/drivers/mysql/introspect.ts`), plus the `\'` MySQL prints but
the DDL doubles. Measured: MySQL's printer writes exactly those six escapes and
prints tab, backspace and `"` raw.

Fail-closed is unchanged for everything outside that table — an escape MySQL's
printer does not write, and an expression that is not a string literal at all,
keep the catalog's own text, read as a difference, and fail the final
attestation with `MIGRATION_DRIFT`. Both are pinned
(`mysql-provider-free-catalog.core`'s `unowned` and `stamped` columns).

**(2) A `now` default is spelled at the RESOLVED column type's
fractional-seconds precision, or not at all.**

Owner: `MySQLMigrationDriver.getDefaultExpression`, through
`mysqlNowExpression` — the same place that already owns the MySQL default
representation (`DEFAULT NULL` → omitted). The precision is read off the type
`mapScalarType` just produced, so `DATETIME(3)` → `CURRENT_TIMESTAMP(3)`, a
native `DATETIME(6)` → `CURRENT_TIMESTAMP(6)`, a bare `DATETIME`/`TIMESTAMP` →
bare `CURRENT_TIMESTAMP`, and a resolved DATE or TIME → no database default
instead of an expression MySQL refuses. No hardcoded `(3)`, no change to the
DateTime domain, and `MYSQL_TYPE_DEFAULTS.datetime` is untouched.

`.updatedAt()` does NOT share the affected rule: its generator has no native
MySQL spelling, so it declares no database default. That is now asserted rather
than assumed (the `touched` column).

## 3. What disappeared

Two real deletions, no wrappers:

- `MySQLMigrationDriver.getAutoGenerateExpression` — the whole override
  (`case "now": return "CURRENT_TIMESTAMP"`, plus the `uuid` arm that returned
  the base's own answer). MySQL now has NO generator-hook override: the one
  generator it spells natively is spelled where the resolved type is known.
- `quotedLiteral` in `drivers/mysql/introspect.ts` — a second spelling of a
  MySQL string literal, now `mysqlStringLiteral`.

## 4. A second applicable consumer

- `mysqlStringLiteral`: the introspector's re-spelling of a LITERAL default
  (the `VARCHAR(191)` keyed rewrite — pinned live by the `keyed` column, whose
  declared default also carries a backslash), the enum-value replacement
  `UPDATE` statements, the decimal-list `COMMENT` marker, and the MySQL
  advisory-lock name — every MySQL string literal this estate writes.
- `MYSQL_PRINTED_CHARACTERS`: the decimal-list JSON container default reads
  back through the same inverse (`decimal-list-defaults-mysql-docker`, green).
- `mysqlNowExpression`: the native `TIMESTAMP(3)` and `DATETIME(6)`
  declarations, and the DATE/TIME arm that now carries no default.

## 5. Cost

| denominator | before | after |
| --- | --- | --- |
| charged-engine (16,098) | 16,098 | **16,098** (+0) |
| likeForLike (19,956) | 19,956 | **19,956** (+0) |
| charged (23,891) | 23,891 | **23,891** (+0) |

No file this unit touched is inside any charged class: `mysql/index.ts`,
`mysql/introspect.ts` and `drivers/type-mapping.ts` are all
`excluded-shared-boundary` in the closure's own classification
(`closure-final/receipts/source-size-final.json`), which is the classification
§5 of the prompt restates for the MySQL introspector. Their cost, kept visible
separately and measured with the census's OWN token-line function (it
reproduces the receipt's base numbers exactly):

| file | token lines before | after |
| --- | --- | --- |
| `src/migrations/drivers/mysql/index.ts` | 760 | 765 (+5) |
| `src/migrations/drivers/mysql/introspect.ts` | 371 | 385 (+14) |
| `src/migrations/drivers/type-mapping.ts` | 206 | 220 (+14) |
| total | 1,337 | **1,370 (+33)** |

`git diff --numstat` (physical):

```
62	0	src/migrations/AGENTS.md
1	0	scripts/credential-free-test-manifest.mjs
50	18	src/migrations/drivers/mysql/index.ts
34	16	src/migrations/drivers/mysql/introspect.ts
42	0	src/migrations/drivers/type-mapping.ts
35	20	tests/providers/docker/mysql2-schema-attestation.test.ts
30	7	tests/unit/migrations/mysql-provider-free-catalog.core.test.ts
29	0	tests/unit/migrations/mysql-strict-mode-docker.test.ts
20	3	tests/unit/migrations/provider-driver-entrypoints-coverage.core.test.ts
1	0	vitest.workspace.ts
```

plus the new `tests/unit/migrations/mysql-defaults-docker.test.ts` (333 lines)
and this evidence directory.

## 6. Re-expressed cells, and one new measured gap

Nothing was deleted, skipped or weakened. Three recorded expectations were
re-expressed because the repaired contract changed the answer, each naming §4
at the cell:

1. `mysql2-schema-attestation`'s "a default MySQL's DDL does not read back is
   refused, not accepted" → "a backslash in a declared default reaches the
   database intact": the push applies, the second push plans nothing, the
   catalog reads back `('a\\b')`, and a RAW INSERT leaves the declared `a\b`.
   The prompt asks for exactly this replacement.
2. `mysql-provider-free-catalog.core`'s `multiline` column → the round-trip
   `('line1\nline2')`, with three columns ADDED beside it: a two-layer
   backslash, the `\r`/`\0`/`\Z` controls, and an `unowned` body carrying an
   escape MySQL's printer does not write, which still keeps the catalog text.
3. `provider-driver-entrypoints-coverage.core`'s
   `generatedDefault({ kind: "now" })` → `undefined`, beside three new
   assertions on the owner that answers it now
   (`getDefaultExpression`: `CURRENT_TIMESTAMP(3)`, `CURRENT_TIMESTAMP(6)`,
   and `undefined` for a resolved DATE).

One cell was ADDED to the existing strict-mode suite (the prompt's named home
for SQL-mode assumptions): the supported session carries `STRICT_TRANS_TABLES`
and NOT `NO_BACKSLASH_ESCAPES`, and the server reads what `escapeValue` writes
back as the declared value. No server mode the ORM does not support is
promised, and the global SQL mode is not changed by the repair.

**A third gap, measured here and NOT repaired.**
`information_schema.COLUMN_DEFAULT` hands an EXPRESSION default's UTF-8 bytes
back one codepoint per byte (`cafe ☕` arrives as the bytes `e2 98 95` as three
codepoints, measured through this same driver), so a non-ASCII default on TEXT,
BLOB, JSON or GEOMETRY reconstructs into a value that is not the declared one
and the push fails at the final attestation. The same value in a LITERAL
default (`VARCHAR(191)`) round-trips today. Re-decoding those bytes would be a
GUESS on a read path other MySQL transports share — a body that is already
decoded and happens to sit in the Latin-1 range would be corrupted by it — and
it is outside §4's two measured gaps, so this unit measures, pins and reports
it instead of widening its scope: `mysql-defaults-docker`'s "refuses a Unicode
expression default, and keeps the literal one" asserts the fail-closed outcome
and the working literal control, and the guide addendum names it. A backslash
inside a declared ENUM value is the neighbouring gap, also unchanged and now
named — but the repair MOVED where it is refused. `mysqlEnumType` still
spells its values with quote doubling only while the default beside them goes
through `mysqlStringLiteral`, so when such a value is ALSO the column's
default the two spellings disagree and MySQL refuses the CREATE/MODIFY
statement itself with errno 1067
ER_INVALID_DEFAULT — mid-push, as an unattributed driver error, rather than at
the attestation. Only such a value WITHOUT a default still reaches the
attestation as `MIGRATION_DRIFT`, which is where the base refused both.
Measured this round on the lane container, in a table the probe created and
dropped: `ENUM('a\b') NOT NULL DEFAULT 'a\b'` (the base spelling, where
`mysqlEnumType` and `escapeValue` agreed) creates the table — `COLUMN_TYPE`
`enum('a<BS>')`, default `a<BS>` — while `ENUM('a\b') NOT NULL DEFAULT 'a\\b'`
(the repaired spelling) is errno 1067
(`receipts/repair-round/probe-enum-default.log`).

## 7. Runs

One file per invocation, credential-free files in one batch; no wide runs. All
exit 0 on the final source.

| file | project | result |
| --- | --- | --- |
| `tests/unit/migrations/mysql-defaults-docker.test.ts` (new) | provider-mysql2 | 3 passed |
| `tests/providers/docker/mysql2-schema-attestation.test.ts` | provider-mysql2 | 5 passed |
| `tests/unit/migrations/mysql-strict-mode-docker.test.ts` | provider-mysql2 | 9 passed (8 at base + 1) |
| `tests/unit/migrations/decimal-list-defaults-mysql-docker.test.ts` | provider-mysql2 | 1 passed |
| `tests/contracts/engine/query/decimal-wide-arithmetic-docker.test.ts` | provider-mysql2 | 35 passed |
| `tests/providers/docker/mysql2-scalars.test.ts` (neighbour) | provider-mysql2 | 293 passed |
| `tests/providers/docker/mysql2-relations-ddl.test.ts` (neighbour) | provider-mysql2 | 106 passed |
| `mysql-provider-free-catalog.core` + `provider-driver-entrypoints-coverage.core` + `ddl-drivers.core` | layer-migrations + coverage-migrations | 362 executions |
| `mysql-catalog-namespace` / `mysql-namespace-ddl` / `mysql-sequential-program` / `operators-mysql-branch-closure` / `mysql-decimal-conversion-recovery` / `mysql-recovery-and-session-coverage` (all `.core`) | layer-migrations + coverage-migrations | 324 executions |
| `ddl.core` / `format-and-type-mapping.core` / `serializer.core` / `ddl-drivers.core` | layer-migrations + coverage-migrations | 636 executions |
| `migration-v1-census` + `decimal-language-census` | extended-local | 46 passed |

The two files the final gate omitted are green on the repaired tree: 35 + 1 =
**36 cells**, which is the prompt's §5 arithmetic confirmed rather than
assumed. Registered cell count for `provider-mysql2` on this tree: the eleven
previously executed files, plus those two, plus this unit's +3 (new file) and
+1 (strict-mode). The gate's own inventory is the integrator's to report; this
note does not hardcode a total.

**Registrations — TWO halves, because two collectors see this tree.**
`vitest.workspace.ts` → `providerProject("mysql2", [...])` gains ONE explicit
entry, `"tests/unit/migrations/mysql-defaults-docker.test.ts"` (3 cells). That
project globs only `tests/providers/docker/mysql2*.test.ts`; every
`tests/unit/migrations/*-docker.test.ts` sibling is listed explicitly THERE, so
a new one is collected only by being named — as `mysql-strict-mode-docker` and
`decimal-list-defaults-mysql-docker` are. The credential-free stage is the
other half and works the opposite way round: `EXTENDED_LOCAL_TESTS` in
`scripts/credential-free-test-manifest.mjs` is a file WALK of `tests/`, so it
ADOPTS any new file it is not told to skip, and both siblings are named in that
file's `extendedLocalExclusions`. This unit's witness is now named there beside
them, so `provider-mysql2` is its only collector. Without that entry it was
collected TWICE: packed into an ordinary extended-local shard, it would have
added 3 unexplained skipped cells to `pnpm test:all` and repacked the shards
after it — or, with `MYSQL_TEST_CONNECTION_STRING` exported, RUN inside a
credential-free shard against the same container a `provider-mysql2` run uses.
Measured both ways: without the entry the walk returns 192 files, the witness
lands in shard 12 and shards 12-14 repack; with it the walk returns 191, its
base count, the witness is absent, and the 14 shards carry what the base packed
(`receipts/repair-round/extended-local-walk.log`).
`scripts/raptor3-manifest.mjs` is untouched.

## 8. Typecheck, census, Biome

- **Typecheck:** `node scripts/run-typecheck.mjs` — exit 0, 0 diagnostics
  (`receipts/typecheck.log`).
- **Census:** `node scripts/query-engine-structure.mjs` — engine token lines
  **16,098**, unchanged. `node scripts/raptor3-refusal-census.mjs` — exit 0; no
  engine sentence or error class was touched by this unit (no `MigrationError`
  message was added, changed or removed).
- **Biome:** `npx biome check` on all eight changed files plus the new one —
  clean. `vitest.workspace.ts` keeps the `organizeImports` assist diagnostic it
  ALREADY carries at base (verified on the base copy); its import block was not
  reordered. The formatter was run only on files whose base copy is
  format-clean (`mysql/introspect.ts`,
  `mysql-provider-free-catalog.core.test.ts`) and on the new file.

## 9. Unverified

- Hosted MySQL transports (PlanetScale) were not exercised; they share the
  introspection inverse, whose behaviour is unchanged for ASCII bodies.
- **A strict session carrying `NO_BACKSLASH_ESCAPES` is a measured REGRESSION
  of this repair, disclosed rather than guarded.** The session owner ADMITS
  that mode: `checkPinnedMySQLSession` (`src/migrations/pinned-session.ts`)
  refuses only a session with neither `STRICT_TRANS_TABLES` nor
  `STRICT_ALL_TABLES`, and nothing else under `src/migrations/` reads the mode.
  On such a server a declaration that CONVERGED at base now FAILS. Measured on
  a probe's own `SET SESSION sql_mode` (the global mode is never changed): the
  base spelling `'a\b'` stored the declared `a\b`, so the column converged,
  while the repaired spelling `'a\\b'` stores TWO characters, the inverse then
  re-spells the live value as `'a\\\\b'`, and the push fails at the final
  attestation with an unattributed `MIGRATION_DRIFT` AFTER the DDL has
  committed (`receipts/repair-round/probe-no-backslash-escapes.log`). The
  strict-mode cell added in §6 asserts that this lane's container does not
  carry the mode, which is a measurement, not a guard. Refusing the mode at
  that owner was offered and NOT taken: §4 scopes SQL-mode assumptions to that
  suite and this unit to the two measured default gaps, and a new session
  refusal is a public semantic change — every MySQL estate on such a server,
  including schemas with no string default at all — that belongs to whoever
  widens the supported set, not to this repair. The guide addendum states the
  same thing beside the paragraph it corrects.
- The Unicode expression-default gap (§6) is measured and pinned, not repaired.
  A backslash inside a declared ENUM value is measured and unrepaired, and only
  PART of it is pinned: `mysqlEnumType`'s quote-doubling spelling is pinned
  provider-free (`mysql-provider-free-catalog.core`'s `back\slash` member),
  while WHERE the live refusal lands — errno 1067 at the CREATE/MODIFY when
  that value is also the column's default, the attestation otherwise — is
  measured this round (§6) and carried by no cell.
- The full `provider-mysql2` project was not run in one go (no wide runs by a
  unit); the integrator's frozen gate owns that inventory.

## 10. Blockers

None.

## Repair round — 2026-09-21

The independent review returned three findings (1 major, 2 minor); all three
are applied and nothing else changed. NO production source file was touched
this round: the change is ONE entry in the credential-free manifest plus the
three documents that describe this unit, so the engine census is still
**16,098** (re-measured, `receipts/repair-round/census.log`), §5's cost table
stands, and only its numstat rows moved (`src/migrations/AGENTS.md` 39 → 62
lines, plus the new `scripts/credential-free-test-manifest.mjs` 1 / 0).

**(1, major) The witness was collected by TWO projects.**
`extendedLocalExclusions` in `scripts/credential-free-test-manifest.mjs` is the
skip list for a file WALK of `tests/`, and this unit's new file was not in it
— so, unlike BOTH of its `provider-mysql2` siblings
(`decimal-list-defaults-mysql-docker` and `mysql-strict-mode-docker`, named
there since before this unit), the walk
adopted it. Measured before the fix: the walk returned 192 files, packed the
witness into ordinary shard 12, and repacked shards 12-14 — 3 unexplained
skipped cells in `pnpm test:all`, or, with `MYSQL_TEST_CONNECTION_STRING`
exported, 3 cells RUNNING inside a credential-free shard that sets no
`fileParallelism: false`, creating and dropping `sm_default_*` in the lane
container beside a `provider-mysql2` run. One line names it beside its
siblings; measured after: 191 files (the base count), witness absent, the 14
shards carrying what the base packed
(`receipts/repair-round/extended-local-walk.log`, with `walk-probe.mjs`).
`scripts/raptor3-manifest.mjs` — the file the rules protect — is a DIFFERENT
file and stays untouched. The note's **Registrations** paragraph now states
both halves, as does the ledger record; the commit message draft too.

**(2, minor) The enum clause named the wrong refusal point.** The durable rule
in `src/migrations/AGENTS.md` said a backslash inside a declared enum value
"remains refused at the attestation". Measured on the lane container this
round (MySQL 8.4.11, one table created and dropped by the probe,
`receipts/repair-round/probe-enum-default.log` with `probe-enum-default.mjs`):
when that value is ALSO the column's default the refusal has MOVED EARLIER.
`ENUM('a\b') NOT NULL DEFAULT 'a\b'` — the base spelling, where
`mysqlEnumType` and `escapeValue` agreed — still creates the table
(`COLUMN_TYPE` `enum('a<BS>')`, default `a<BS>`) and is refused at the
attestation; `ENUM('a\b') NOT NULL DEFAULT 'a\\b'` — the repaired spelling,
where only the default went through `mysqlStringLiteral` — is refused by MySQL
at CREATE TABLE with errno **1067 ER_INVALID_DEFAULT**, mid-push and as an
unattributed driver error. Only such a value WITHOUT a default still reaches
the attestation as `MIGRATION_DRIFT` (measured: it creates). The guide clause,
§6 of this note and the ledger record now say exactly that. The reviewer's
neighbouring observation — that `generateEnumValueUpdates` now sends the
un-mangled value in its `WHERE`, so a rename would match no rows on such a
member — is recorded here and NOT written into the guide, because it was not
part of the requested change and the rule it would state is the same
unrepaired neighbour.

**(3, minor) §9 understated the `NO_BACKSLASH_ESCAPES` consequence.** It is not
only that a doubled backslash is stored: a declaration that CONVERGED at base
now fails. Measured on a probe's own `SET SESSION sql_mode` — the global mode
is never changed — on this lane's container
(`receipts/repair-round/probe-no-backslash-escapes.log` with
`probe-no-backslash-escapes.mjs`): on a STRICT session carrying the mode, the
base spelling `'a\b'` stored the declared `a\b` (catalog and raw insert both
`61 5c 62`) while the repaired spelling `'a\\b'` stores TWO characters
(`61 5c 5c 62`); the inverse then re-spells the live value as `'a\\\\b'` and
the push fails at the final attestation with an unattributed `MIGRATION_DRIFT`
after the DDL has committed. The session owner ADMITS that mode:
`checkPinnedMySQLSession` (`src/migrations/pinned-session.ts`) refuses only a
session with neither `STRICT_TRANS_TABLES` nor `STRICT_ALL_TABLES`, and within
`src/migrations/` nothing else reads `sql_mode` (grepped; the only other reader
in `src/` is the adapter's STRICT probe). §9, the guide addendum and the ledger
record now state the regression in those terms.

The finding offered a guard at that owner as the alternative, and it was NOT
taken — the reason, not a preference: §4 of the repair prompt scopes SQL-mode
assumptions to the existing strict-mode suite and scopes this unit to the two
measured default gaps, and adding a token test to
`proveExactValueSessionMode` would refuse EVERY MySQL estate on such a server,
including schemas carrying no string default at all. That is a public semantic
change and an untested new branch, which the rules send back rather than let a
unit take on its own. It is disclosed at all three places instead, and named
here as the open choice for whoever widens the supported set.

**Runs (this round only).** One docker file, one invocation; nothing else was
re-run, because no production source changed.

| file | project | result |
| --- | --- | --- |
| `tests/unit/migrations/mysql-defaults-docker.test.ts` | provider-mysql2 | 3 passed, exit 0 (`receipts/repair-round/mysql-defaults-docker.log`) |
| the walk itself, before and after | — | 192 → 191 files, shard 12 → none (`receipts/repair-round/extended-local-walk.log`) |

- **Typecheck:** `node scripts/run-typecheck.mjs` — exit 0, 0 diagnostics
  (`receipts/repair-round/typecheck.log`).
- **Census:** engine token lines **16,098**, unchanged; the refusal census
  exits 0 — no error message, sentence or class was touched this round
  (`receipts/repair-round/census.log`).
- **Biome:** `npx biome check` on the changed files — clean; Biome lints the
  `.mjs` and ignores the two Markdown files
  (`receipts/repair-round/biome.log`). No formatter was run.
- **Blockers:** none.

## Commit message

```
fix(migrations): MySQL carries a declared default's value, and spells now() at the column's precision

The two gaps R2a measured and left open (repair prompt §4), repaired at their
existing MySQL migration owners; the engine is untouched and its census is
unchanged at 16,098 token lines.

A string default now reaches the column as the DECLARED value. MySQL reads a
backslash inside a string literal as an escape introducer, so doubling the
apostrophe alone stored a BACKSPACE for `a\b` and could not spell `end\` at
all — that DDL did not parse. `mysqlStringLiteral` (beside `mysqlEnumType`,
for the same reason: one spelling, both snapshot producers) escapes the
backslash and the four control characters a generated statement cannot carry
raw, because that statement is also the review blob. The catalog inverse reads
the SAME table backwards, so a default carrying any of them round-trips into
the spelling the desired side wrote, and `quotedLiteral` — the second spelling
— is gone. What stays outside the table stays fail-closed: an escape MySQL's
printer does not write, and an expression that is not a string literal, keep
the catalog's text and refuse the push.

`.dateTime().now()` is spelled from the RESOLVED column type. MySQL requires
the expression's fractional-seconds precision to agree with the column's, and
`DATETIME(3) DEFAULT CURRENT_TIMESTAMP` is errno 1067, so a declared `.now()`
could not be pushed at all. `getDefaultExpression` reads the precision off the
type it just mapped; the MySQL `getAutoGenerateExpression` override, which was
handed the declaration only and could not know it, is deleted. A resolved DATE
or TIME carries no database default rather than an expression MySQL refuses.

Witnesses: `tests/unit/migrations/mysql-defaults-docker.test.ts` (new) runs the
initial push, the unchanged repush, a declared change and a RAW INSERT omitting
the column as the oracle. It is registered twice over, because two collectors
see this tree: one explicit `provider-mysql2` entry, and one
`extendedLocalExclusions` entry keeping the credential-free file WALK from
adopting it beside a provider run, exactly as both its siblings are. The
attestation's backslash containment pin becomes the round-trip it was holding
the place for, the provider-free inverse pins gain the newly owned escapes and
an unowned one, and the strict-mode suite states the SQL-mode assumption the
spelling makes. Two neighbours are measured, pinned and reported rather than
repaired behind this scope: the catalog hands an expression default's UTF-8
bytes back one codepoint per byte, so a non-ASCII default on TEXT is refused;
and on a strict session that also carries `NO_BACKSLASH_ESCAPES` — a mode the
session owner admits — this spelling is a regression, storing a doubled
backslash where the base converged and failing at the attestation, which the
guide addendum states beside the paragraph it corrects.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
