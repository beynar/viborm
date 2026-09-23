# R2a — the schema attestation boundary: what MySQL hands back is not what the estate said

Handoff §4 (R2a). Base `cdd787ac8` on `pattern-engine`, worktree
`/private/tmp/viborm-r2ab`, branch `closure-r2ab`, MySQL 8.4.11 in the lane's
own container. Nothing committed, staged or pushed.

The lane's last recorded run was **589 passed / 160 failed / 1 skipped**, and
**150** of those 160 stopped at one sentence — `Push completed its statements
but the final live fingerprint does not match the desired schema` — before their
own body ever ran. This unit reproduced that disagreement on an isolated `r2a_`
schema, retained the exact differing facts before editing anything, and
repaired them at their owners. The lane is now **7 failures**: the three R2b
items and R2c's four deadlock cells.

## 1. The failing witness, and the facts it retained

`receipts/before/*.json` is the retained evidence, one file per pushed schema,
each carrying the desired snapshot, the live snapshot, the catalog rows behind
it and a RAW, pre-normalization field-by-field difference — taken BEFORE any
source edit. Two of those raw differences are in the receipts that pushed CLEAN
as well, and neither one reaches the fingerprint: a type's case
(`desired="VARCHAR(191)" live="varchar(191)"`, in seven of the nine files — a
schema whose columns are all `INT`/`TEXT` has no case to differ), which
`normalizeType` folds (`push-fingerprint.ts:147,198-214`), and the primary
key's name (`desired="r2a_accounts_pkey" live="PRIMARY"`, in eight of the nine
— the ninth is the `generated-defaults` probe, which died at errno 1067 before
its table existed), which the fingerprint spells on PostgreSQL only
(`push-fingerprint.ts:156-158`). Six schemas pushed clean; three did not, and
every difference that actually REACHED the fingerprint is an enum or a
default:

| schema | the exact differing facts (desired vs live) |
| --- | --- |
| `r2a_accounts` (an enum column) | `/tables/0/columns/1/type`: `ENUM('admin', 'member', 'guest')` vs `enum('admin','member','guest')`; `/enums/0/name`: `ENUM('admin', 'member', 'guest')` vs `r2a_accounts$role$enum` |
| `r2a_defaulted` (an enum with a default) | the two above, plus `/tables/0/columns/1/default`: `'member'` vs `member` |
| `r2a_tickets` (`s.string().default("application-default")`) | `/tables/0/columns/1/default`: `'application-default'` vs **null** — the column MySQL holds has no default at all |

`receipts/mysql-default-rules.md` is the second half of the evidence: what MySQL
8.4.11 actually does with each spelling, measured by executing the DDL and
reading `information_schema` back (errno 1101 on a literal TEXT default, the
`_charset\'value\'` deparse of an expression default, the bare value of a
literal one).

The witness is now registered:
`tests/providers/docker/mysql2-schema-attestation.test.ts` — the initial push,
a repeated no-op push (`operations` and `sql` both empty), an actual change
(enum widened, default changed) and its convergence, the snapshot read back in
the estate's own spelling, and a row written by RAW SQL to prove the declared
defaults are the DATABASE's and not admission's. All three cells fail at the
base with the drift sentence (`receipts/falsification-base.log`).

## 2. The facts, their owners, and the second consumer of each

**Fact 1 — a MySQL enum has ONE spelling, and it is also its identity.** MySQL
has no standalone enum object: the values ARE the column type. The estate had
two spellings of it (`ENUM('a', 'b')` from `getEnumColumnType`, `enum('a','b')`
from the catalog) and two identities (that same text on the desired side, a
derived `table$column$enum` on the live side), so a schema nobody edited could
not attest. Owner: `mysqlEnumType` in `src/migrations/drivers/type-mapping.ts`,
beside the MySQL type table it belongs to. First consumer:
`MySQLMigrationDriver.getEnumColumnType` (the desired snapshot, and through it
`serializer.ts`'s enum registry). **Second consumer:**
`src/migrations/drivers/mysql/introspect.ts` — both `formatColumnType` and the
enum-definition registration, which no longer derive a name of their own.

**Fact 2 — MySQL reports a default in two vocabularies, and neither is the
estate's.** A literal default comes back as the bare VALUE with its quotes
gone; an expression default comes back as MySQL's deparse. Owner:
`cleanDefault` in the MySQL introspector — the one boundary that reads the
catalog — which now translates both into the DDL spelling instead of only the
decimal-list container it used to recognize. Consumers: everything that
compares a live snapshot — `fingerprintLive` (the push attestation) and the
differ (`columnPropertiesEqual`), which is why the same repair ends the drift
AND the every-push churn.

**Fact 3 — MySQL refuses a literal `DEFAULT` on TEXT, BLOB, JSON and GEOMETRY,
and takes an expression default there instead.** The estate knew the first half
and acted on it by DROPPING the clause in `generateColumnDef`, so `push()`
created a column the schema had not declared and then refused its own
fingerprint. Owner: `finalizeMySQLColumn` in
`src/migrations/drivers/mysql/index.ts`, called from `finalizeTable` — already
the one place a MySQL column's spelling is decided (it is where a keyed TEXT
column becomes `VARCHAR(191)`), and the only place that sees the FINAL column
type. **Second consumer:** the JSON decimal-list container, whose
MySQL-only parenthesization lived in `MigrationDriver.formatDecimalListDefault`
and is now the same rule (`receipts/runs.md`: the decimal pins, core and
docker, unchanged and green).

**Fact 4 — the interrupted-decimal-conversion recovery belongs to the locked
MySQL command, not to having statements to run.** A conversion interrupted
after its `MODIFY` leaves the column already carrying the target domain, so the
differ sees no change, `executeLockedPlan` returned `noop` before
`runSequentialProgram`, and the remnant CHECK — which no snapshot vocabulary
describes — survived every later push while refusing values the declared domain
admits (measured: `INSERT JSON_ARRAY('123456')` into a precision-10 column
rejected by a stale precision-5 proof, errno 3819). Owner:
`executeLockedPlan` in `src/migrations/push-v1.ts`. Second consumer: the
collision cell that followed it, which saw TWO reserved proofs — one of them
the remnant this hole left behind — and refused with the wrong sentence. Both
`mysql-strict-mode-docker` cells are green with no change to the recovery
planner, its proofs or its refusals.

**The namespace cell** (`mysql2.test.ts`, "applies into the TARGET's control
tables") needed no ORM change: an ordinary `apply` requires an EMPTY managed
target and says so, and the two push cells declared above it leave `ns_notes`
in alpha for the portability cell at the end to read back. The apply cell now
runs FIRST in its describe, with the precondition named at the cell. No
expectation was changed, relaxed or removed.

## 3. The deletion

Real, not moved:

- `MigrationDriver.formatDecimalListDefault` (`base.ts`) — deleted; its one
  caller now spells the literal and the MySQL parenthesization is the shared
  rule.
- `generateColumnDef`'s 25-line default-suppression block (`mysql/index.ts`) —
  deleted, with its `isTextOrBlob` / `isJson` / `isDecimalList` / `isSpatial`
  case analysis; the emitter writes what the snapshot says.
- the `$`-escaped `table$column$enum` derivation (`mysql/introspect.ts`) —
  deleted.
- `cleanDefault`'s decimal-descriptor round trip (`decodePhysicalDecimalList` +
  `decimalListDefaultText` + the byte-for-byte re-encode check, and both
  imports) — deleted; the general translation reaches the same answers, and a
  container the estate does not own still reads as different (pinned).

**Retained cost.** Token-bearing lines (non-blank, non-comment), base → after
(the repair round of §7 included): `base.ts` 555 → 551, `mysql/index.ts`
758 → 760, `mysql/introspect.ts` 423 → 438, `type-mapping.ts` 202 → 206,
`push-v1.ts` 462 → 465 — **net +20**, of which the repair round's deparse
inverse is +19 (`mysql/introspect.ts` 419 → 438).
Engine cost is untouched: `scripts/query-engine-structure.mjs` reports 38 files
/ **16 040 token lines** / 1093 functions, the checkpoint's own numbers, and no
file under `src/query-engine/` is in the diff. `git diff --numstat` for the
non-engine files:

```
35	0	src/migrations/AGENTS.md
1	7	src/migrations/drivers/base.ts
55	32	src/migrations/drivers/mysql/index.ts
110	49	src/migrations/drivers/mysql/introspect.ts
18	0	src/migrations/drivers/type-mapping.ts
11	1	src/migrations/push-v1.ts
40	34	tests/providers/docker/mysql2.test.ts
49	39	tests/unit/migrations/ddl-drivers.core.test.ts
39	4	tests/unit/migrations/decimal-list-defaults.core.test.ts
80	1	tests/unit/migrations/mysql-provider-free-catalog.core.test.ts
```

plus one new file, `tests/providers/docker/mysql2-schema-attestation.test.ts`
(246 lines, 5 cells).

## 4. The five recorded expectations that were re-expressed

Never deleted, skipped or weakened; each names the decision at the cell
(final-closure handoff §1, "MySQL": repair the bounded causes, do not lower the
advertised contract — and R2a's "never discard a difference").

1. `ddl-drivers.core.test.ts` "should NOT include DEFAULT for TEXT columns" →
   "carries a TEXT column's default as MySQL's expression default". It now
   asserts `finalizeTable` produces `('default')`, the DDL carries
   `DEFAULT ('default')`, and a BARE literal is still never emitted (the thing
   errno 1101 refuses) — strictly more than the old cell.
2. the same for BLOB.
3. `mysql-provider-free-catalog.core.test.ts` "reconstructs catalog-only type,
   enum, key, and action vocabulary": the enum identity is the inline type, not
   `order$lines$sta$tus$enum`. The cell also gained the column's own type
   assertion and the "a COLUMN_TYPE that parses to no values stays as read"
   case it was already exercising unasserted.
4. `decimal-list-defaults.core.test.ts` "renders coefficient-string JSON on
   MySQL without admitting generic JSON": the emitter now carries a declared
   JSON default, and the cell's actual subject — that no DECLARATION turns into
   a generic JSON column default — is asserted at its real owner, the
   serializer.
5. the same file's "normalizes only MySQL's owned decimal-list catalog
   spelling": the two non-owned containers now read back in the estate's
   spelling, and the cell asserts what it was always about — that neither of
   them equals the container the estate owns.

## 5. Validation

`receipts/runs.md` has every command and its answer. In short: the lane
160 → 7 failures (three R2b items, four R2c deadlock cells, the latter cell for
cell identical to the base); `mysql2.test.ts` and `mysql-strict-mode-docker`
fully green; the new witness 3 / 3 and red at the base; the touched owners'
existing pins are the rows of `receipts/runs.md`'s second table, each run once
and counted once — **1 419** credential-free cells green across its nine
credential-free rows (330 + 8 + 324 + 386 + 14 + 116 + 5 + 76 + 160), and its
three docker rows 1 + 5 + 3 green beside their seven skipped non-MySQL legs;
typecheck **0 diagnostics**; census unchanged at 23 candidate sentences / 30
sites / 193 total; Biome 0 diagnostics on every changed file (only the new test
file was formatted). §7 records what the repair round changed and re-ran, and
the counts it moved (the witness 3 → 5, the provider-free catalog row 8 → 10).

## 6. Unverified, and what this unit did not do

- The lane's **full `provider-mysql2` project in one run** was NOT measured
  here: the brief runs it file by file, and the end-of-lane whole-project
  receipt is R2b's deliverable. The per-file numbers above are each from their
  own invocation.
- **Out of lane scope, reported not repaired:** `s.dateTime().now()` cannot be
  pushed to MySQL at all. `getAutoGenerateExpression` answers
  `CURRENT_TIMESTAMP` with no fractional-seconds precision while
  `MYSQL_TYPE_DEFAULTS.datetime` is `DATETIME(3)`, and MySQL requires the two
  to agree (errno 1067 ER_INVALID_DEFAULT, measured — `receipts/mysql-default-rules.md`
  and the `generated-defaults` probe receipt). No test in the native MySQL
  inventory declares `.now()` or `.updatedAt()` (`grep` over
  `tests/providers/docker/*.test.ts` and `tests/contracts/drivers/behaviors/*.ts`
  matches only this unit's own probe), so repairing it needs the resolved column
  type and is a unit of its own.
- **A pre-existing escaping gap, named where it bites, and what it costs:**
  `escapeValue` doubles `'` and leaves `\` alone, which MySQL's DDL reads as an
  escape introducer (measured, `receipts/repair-deparse-measurements.md`: a
  declared default of `a\b` is stored as `a<BACKSPACE>`). This unit did not change `escapeValue`, and the consequence
  is stated as explicitly as the `.now()` limit above it: **a string default
  whose value carries a backslash cannot be pushed to MySQL at all** — the same
  holds for a value MySQL's own printer escapes, a newline among them. Both
  reach `MIGRATION_DRIFT`, but by TWO different mechanisms, and each has its
  own witness:

  1. **A body carrying an escape the inverse does not own keeps the catalog
     text.** `\n` is the measured case (`repair-deparse-measurements.md`, row
     9): `deparsedStringValue` declines it, so `cleanDefault` returns MySQL's
     own printed backslash sequence, which can never equal what the desired
     side spells. Witness: `mysql-provider-free-catalog.core`'s "undoes both
     layers of MySQL's deparse, and keeps what it cannot" — its `multiline`
     column asserts the catalog text comes back unchanged.
  2. **A body the inverse cannot reconstruct the declared value from refuses
     fail-closed.** A backslash in the DECLARED value never reaches the catalog
     as an escape at all: MySQL's DDL consumed it first, so `DEFAULT ('a\b')`
     stores a BACKSPACE (row 8) and the inverse SUCCEEDS on that body while
     answering a value that is not the declared one. Witness:
     `mysql2-schema-attestation`'s "a default MySQL's DDL does not read back is
     refused, not accepted".

  Either way the column keeps reading as a difference, it is re-planned, and
  the push then FAILS at the final attestation with `MIGRATION_DRIFT` — the
  exact sentence this unit exists to remove, raised on a value nobody proved
  equal rather than a schema silently reported as held. The apostrophe that now
  round-trips is pinned beside (2), in the same file.

  An APOSTROPHE is no longer in this class. The first version of this bullet
  named the wrong trigger and the wrong consequence — it read as though the
  fail-closed branch fired on a backslash in the DECLARED value, when MySQL's
  own deparse introduces the backslashes, so it fired on EVERY apostrophe-bearing
  default on a storage class that takes an expression default (TEXT, BLOB, JSON,
  GEOMETRY), and it said the column was "re-planned" when the re-planned push
  then failed. §7 measured that, repaired it at `cleanDefault`, and pinned it.
- The adopted-decision record below uses **D-66**, the next free number at the
  time of writing. Three other lanes adopt §1 decisions in parallel; if two
  picked the same number, the integrator renumbers at the squash.
- The environment needed repair before any of this could run: Docker Desktop was
  down with two stale `com.docker.backend` processes that made
  `docker desktop restart` hang (the R2c lane's attempt, in this session's logs,
  timed out against them). They were terminated and Docker restarted; the lane's
  own container `viborm-triage-mysql-20260918` was started, never recreated. No
  database, schema or table outside the approved fixtures' own teardown was
  dropped.

**Blockers: none.**

## 7. Repair round (2026-09-21)

Three findings from the independent review of this unit, applied exactly.

**1 (major) — §6's disclosure named the wrong trigger and the wrong
consequence, and nothing pinned the refusal.** Measured first, on the lane's
own MySQL 8.4.11, in two tables I created and dropped
(`receipts/repair-deparse-measurements.md`): `information_schema` escapes an
expression default TWICE — once as MySQL prints the string literal, once as the
catalog prints that expression — so a column declared `DEFAULT ('it''s')` is
reported as the characters `_utf8mb4\'it\\\'s\'`, and it is MySQL's deparse
that introduces the backslashes, not the declared value. The old branch refused
every body carrying one, so `s.string().default("it's")` — an unkeyed string,
i.e. TEXT — pushed a CORRECT column and then failed its own attestation with
`MIGRATION_DRIFT` (falsified, red: `receipts/repair-falsification-pre-repair.log`).

Repaired at the owner the finding names, `cleanDefault`
(`src/migrations/drivers/mysql/introspect.ts`): two passes of one inverse,
`unescapeOneLayer`, each undoing one layer, and only `\'` and `\\`. The two
fail-closed mechanisms §6 separates are unchanged by the repair and are what
still refuses everything else: an escape MySQL's printer emits that the inverse
does not own (`\n` for a newline) keeps the catalog text, witnessed by
`mysql-provider-free-catalog.core`'s `multiline` column; and a backslash in the
declared value, which MySQL's DDL consumed before the catalog saw it, leaves a
body the inverse cannot reconstruct the declared value from, witnessed live by
`mysql2-schema-attestation`'s "a default MySQL's DDL does not read back is
refused, not accepted". Both are now the stated contract rather than an unnamed
accident. The desired
side's spelling is stated once for both branches (`quotedLiteral`), so the
literal and the expression path cannot drift apart.

Registered: `tests/providers/docker/mysql2-schema-attestation.test.ts` gains
"an apostrophe survives MySQL's deparse of an expression default" (push,
no-op re-push, both defaults read back in the estate's spelling, and the values
read back through RAW SQL) and "a default MySQL's DDL does not read back is
refused, not accepted" (`MIGRATION_DRIFT`, the fail-closed side). The
credential-free owner gains `mysql-provider-free-catalog.core`'s "undoes both
layers of MySQL's deparse, and keeps what it cannot" — the measured catalog
text in, the estate's spelling out, and the untranslatable bodies unchanged.
The guide sentence (`src/migrations/AGENTS.md`) and §6 above now state the
trigger (MySQL's deparse, hence any apostrophe on TEXT/BLOB/JSON/GEOMETRY) and
the consequence (the push FAILS with `MIGRATION_DRIFT`).

**2 (minor) — §1 omitted two differences the clean receipts carry too.**
Corrected above: the receipts hold the RAW, pre-normalization diff; the type's
case is in seven of the nine files and the `PRIMARY` name in eight (the
finding said every receipt — the `generated-defaults` probe has no live table
at all, and a schema of `INT`/`TEXT` columns has no case to differ), the clean
pushes carry both, and `normalizeType` and the dialect-conditional primary-key
name are what keep them out of the fingerprint.

**3 (minor) — §5's `840 + 116 + 14 + 8` could not be reconstructed from
`receipts/runs.md` without counting a row twice.** Restated as the table's own
rows, summed once: 1 419 credential-free cells over nine rows, and the three
docker rows beside them.

**What the repair round re-ran** (`receipts/runs.md`, "Repair round"): the two
touched test files and the introspector's other consumers —
`mysql-provider-free-catalog.core` 10 (8 before, red pre-repair),
`decimal-list-defaults.core` 14, `mysql2-schema-attestation` 5 (3 before),
`decimal-list-defaults-mysql-docker` 1, `mysql-strict-mode-docker` 8 — plus one
typecheck (**0 diagnostics**) and Biome per changed file (0 diagnostics). No
test was deleted, skipped or weakened; the two new docker cells and the one new
core cell are additions. The census was not re-run: this round adds and removes
no refusal sentence and no error class (the new cell asserts the EXISTING
`MIGRATION_DRIFT` refusal).

The lane's file-by-file numbers in §5 were NOT re-measured here, and are the
first round's. What this round changes is confined to catalog bodies that
carried a backslash: every one of those previously read as a DIFFERENCE, so no
cell that was green can have turned red — and the three files that do exercise
the introspector against a live catalog (`mysql2-schema-attestation`,
`decimal-list-defaults-mysql-docker`, `mysql-strict-mode-docker`) were re-run
and are green. `receipts/before/generated-defaults.json` already held the
untested case: its desired table carries `quoted` TEXT default `'it''s'`, and
that probe died on the unrelated errno 1067 before the read-back was ever
measured.

**Still not repaired, and still reported:** `escapeValue`'s backslash gap
itself (§6), and `s.dateTime().now()` on MySQL (§6). Both are named limits with
their measurement; the first is now pinned by a cell that goes red the day it
is repaired.

**Blockers: none.**

## 8. Commit message draft

```
fix(migrations): MySQL hands back its own vocabulary, so the estate reads it

The final push attestation compares the schema MySQL now holds with the one
the estate declared, and on MySQL those two snapshots did not speak one
language: an ENUM's values are its type and the catalog prints its own
rendering of them (and a derived identity of its own), a literal default comes
back as the bare value with its quotes gone, and a default on a TEXT, BLOB,
JSON or GEOMETRY column was DROPPED by the emitter because MySQL refuses a
literal one there (errno 1101) — so push created a column the schema had not
declared and then refused its own fingerprint. 150 cells of the native MySQL
inventory never reached their own body.

One spelling for a MySQL enum (`mysqlEnumType`), written by the driver and read
back through the same function by introspection, and that text is the enum's
identity on both sides. One translation for a catalog default (`cleanDefault`),
no longer decimal-list-only. One owner for how a MySQL column is spelled
(`finalizeTable`), which now carries a default the storage class refuses as
MySQL's expression default `DEFAULT ('value')` — the spelling the JSON
decimal-list container already used, so `formatDecimalListDefault` and the
emitter's 25-line suppression block are deleted.

A MySQL push also runs its sequential program when the plan is EMPTY: the
interrupted-decimal-conversion recovery belongs to the locked command, and a
conversion interrupted after its MODIFY leaves nothing for the differ to see,
so the remnant CHECK survived every later push while refusing values the
declared domain admits.

A deparsed default is escaped twice — once by MySQL printing the literal, once
by the catalog printing that expression — so `cleanDefault` undoes two layers,
and undoes only `\'` and `\\`: an apostrophe in a string default now reads back
into the spelling the desired side wrote, and a value the estate's own DDL
escaping cannot carry is still refused by the attestation, by one of two
mechanisms: a body carrying an escape the inverse does not own (a newline)
keeps the catalog text, which can never equal the desired side; a backslash in
the declared value never reaches the catalog as an escape at all (MySQL's DDL
consumed it), so the inverse reconstructs a value that is not the declared one.
Both end at MIGRATION_DRIFT; note §6 names each body's witness.

Witness: tests/providers/docker/mysql2-schema-attestation.test.ts (initial
push, no-op re-push, a real change and its convergence, a row written by raw
SQL to prove the defaults are the database's, the apostrophe that round-trips
and the backslash that is refused). Native MySQL lane
160 -> 7 failures; the seven are the three R2b behaviour items and R2c's four
deadlock cells. Typecheck 0, census unchanged at 23 sentences.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
