# Release unit "triage" — the Docker provider reds

Author: this unit. Worktree `/private/tmp/viborm-triage`, branch `triage`
from `383f830c`. `TMPDIR=/private/tmp/viborm-triage-tmp` exported for every
run. Receipts: `receipts/` beside this file.

## 0. Decision-elimination gate (written before the first production edit)

Two candidate defects were identified from the recorded red sets before any
edit; both are stated here with owner, change, disappearing decision and
falsifier. The remaining families are classified in §3 and are not code.

### R1 — an enum compared against another COLUMN

- **Required behavior.** `status: { equals: ctx => ctx.fields.reviewStatus }`
  answers the same on every dialect
  (`tests/contracts/drivers/behaviors/field-reference-behavior.ts:339-368`,
  the schema comment at `tests/fixtures/field-ref-schema.ts:11-16` states the
  promise and names 42883 as the shape it was fixed for in `22498601a`).
- **Current owner.** `Queries.lowerOperation`
  (`src/query-engine/raptor3/shared/query.ts:1875`). Its `bind()` already casts
  the REFERENCED column to text for an enum scalar (`:1903-1908`); the filtered
  column keeps `exact(column)`, which is the identity on PostgreSQL
  (`postgres-adapter.ts:263`). The emitted comparison is therefore
  `post_status = text`, which PostgreSQL has no operator for (42883), while
  MySQL/SQLite compare the spelling and answer.
- **Smallest change.** Compute the enum-against-a-column fact ONCE and let both
  sides of the comparison read it: the same predicate that casts the operand
  casts the filtered column. No new adapter capability — `expressions.cast` is
  the vocabulary already used one line below.
- **Decisions that disappear.** "Which side of an enum comparison carries the
  text cast" stops being two independent answers. Replacing invariant: *an enum
  compared against another column compares its spelling, on both sides, on every
  dialect* — the same invariant the shipped engine stated in `22498601a`.
- **Falsifier.** Revert the added cast: the four `enum references` cells go red
  again with SQLSTATE 42883 on PostgreSQL and stay green on MySQL/SQLite,
  proving the cast is load-bearing exactly where the dialect needs it.

### R2 — `JsonNull` in a NOT NULL json column

- **Required behavior.** `json-null-sentinel-behavior.ts:225` — creating a row
  with `required: JsonNull` on a NOT NULL `json()` column succeeds and the row
  is found by `{ required: { equals: JsonNull } }`.
- **Current owner.** `Queries.decodeScalar`
  (`src/query-engine/raptor3/shared/query.ts:4383-4390`). The SQL NULL question
  is asked of the RAW value before the provider chain. For SQLite the raw value
  is the text `'null'`, so the question is answerable. `pg` and `mysql2` parse
  the JSON column themselves, so the stored `null` DOCUMENT and the SQL NULL
  arrive as the same JS `null` and the create's RETURNING decode refuses a value
  the column legitimately holds.
- **Smallest change.** Answer the question from the fact that already
  distinguishes them: a NOT NULL json column cannot hold the SQL NULL, so a
  `null` in that position IS the stored JSON null document. One arm at the one
  decode owner, on the leaf the projection already carries.
- **Decisions that disappear.** "Did this provider parse my JSON column for me?"
  disappears from the decoder. Replacing invariant: *the column's own
  nullability answers the null question for a json document; the provider's
  representation does not.*
- **Named consequence.** A provider that returned a SQL NULL for a NOT NULL json
  column is no longer refused — it decodes as the JSON null document. No
  registered test pins that refusal for `json`
  (`parent-held-lookup.test.ts:209` pins the `int` one, which is untouched).
- **Falsifier.** Revert the arm: the cell goes red again on pg AND mysql2 with
  `returned a malformed json scalar … a required scalar is null`, and stays
  green on SQLite, proving the arm is reached only where the driver parses.

---

## 1. Integrator's completion (2026-09-19, D-45)

The author's session ended on the Opus weekly limit after the measurements
below were taken and R1/R2 were written; the integrator (Fable) completes
the note from the receipts. Every number is read from `receipts/`.

## 2. Container state versus code (the two diffs)

| lane | old container (PostGIS-less pg 16.14 / mysql 8.4) | fresh container (PostGIS pg 16.4 / fresh mysql 8.4) | moved |
| --- | ---: | ---: | --- |
| `provider-pg`, before any fix | 25 | 10 | 15 GeoPoint cells green with PostGIS present: ENVIRONMENTAL |
| `provider-mysql2`, before any fix | 165 | 165 | nothing: the MySQL reds are not container state |

Receipts: `receipts/fresh/` (`pg-red.txt`, `mysql-red.txt`, the two project
logs, `mysql-state-before.txt` proving the fresh MySQL started with an empty
`raptor3_g2` and the default `sql_mode`); the old container's sets are the
rulings unit's recorded ones (`g4/rulings/verification/rulings-pg-red.txt`,
`rulings-mysql-red.txt`) and `receipts/after-old-*.txt` after the fixes.

## 3. Families

### 3.1 PostgreSQL (fresh container: 10 red before the fixes)

| family | cells | class | owner / what it is |
| --- | ---: | --- | --- |
| `pg field references > enum references` | 4 | (a) engine defect — **R1 repaired** | `Queries.lowerOperation` casts only the referenced column of an enum comparison to text; PostgreSQL has no `enum = text` operator (42883). The filtered column now reads the same cast fact. |
| `pg json null sentinel behavior > writes` | 1 | (a) engine defect — **R2 repaired** | `Queries.decodeScalar` asked the SQL NULL question of the raw value; `pg` and `mysql2` parse JSON themselves, so a stored null document arrived as JS `null` and a NOT NULL json column's RETURNING decode refused it. The column's own nullability now answers. |
| `pg batch-only batch primary-key dataflow` | 5 | (c) registered kept-red contract | `Raptor 3 G1 atomic output requires exact identity scratch or segmented RETURNING` — the batch-only route's generated-key dataflow, registered kept-red at the freeze (`g4.md`, the five `batchPrimaryKeyDataflowContract` cells). A release carries them as a documented limitation of the batch-only transport shape, not a silent gap. |
| `pg GeoPoint *` (behavior 10, spatial-index planning 4, migration lifecycle 1) | 15 on the old container only | (b) environment | the old container has no PostGIS; green on the PostGIS container. |

After R1 and R2 on the old container: 20 red = the 15 GeoPoint cells + the
5 kept-red registration cells (`receipts/after-old-pg-red.txt`); on the
PostGIS container the same five remain (`receipts/after-fresh-pg.log`).

### 3.2 MySQL (165 red on both containers before the fixes)

| family | cells | class | owner / what it is |
| --- | ---: | --- | --- |
| `MigrationError: Push completed its statements but the final live fingerprint does not match the desired schema` | **150** | (b)+(a) ONE pre-existing root cause outside the engine | `src/migrations/push-v1.ts` `attestFinalFingerprint`: after a push, the live introspection's fingerprint differs from the desired schema's on MySQL 8.4, so every test whose schema sync goes through push fails before its first query. Pre-existing since August 2026 (156 red on a clean tree, memory note) and identical on the fresh container; not a Raptor 3 fact. Owner: the migrations layer's MySQL introspection or fingerprinting. A release either fixes it in a migrations unit or ships with the MySQL lane documented as blocked by it. |
| `TransactionError: Transaction deadlock detected` (upsert atomicity 2, nested-write concurrency 2) | 4 | (d) concurrency, measured on both containers and in earlier runs (the parity repair note R8: 3/3 on the pristine base) | MySQL's gap locks under REPEATABLE READ deadlock two writers racing on a missing key; the engine reports the provider's deadlock as `TransactionError`, as the shipped engine did. Not repaired here; a retry-on-deadlock policy is a decision. |
| `MySQL namespace containment` | 4 | (b) migrations/environment, pre-existing | control tables created in the wrong database or missing after an interrupted bootstrap; the same family the parity note recorded; owner: the migrations layer's namespace handling on MySQL. |
| `MySQL interrupted decimal-conversion recovery`, `MySQL decimal-list defaults` | 3 | (b) migrations layer, pre-existing | CHECK-constraint and conversion recovery cells of the migrations estate; not the query engine. |
| `json null sentinel behavior > writes > JsonNull is storable in a NOT NULL json column` | 1 | (a) — **R2 repaired** (the MySQL twin of the pg cell) | green after R2 (`receipts/after-old-mysql-red.txt`: 164). |
| `ordering/array/create behavior > to-many include honors descending orderBy` | 1 | candidate defect, unmeasured | `['Alpha','Beta',…]` returned where `['Epsilon','Delta',…]` expected: a to-many include ignoring a descending `orderBy` on MySQL — reproduce on the fresh container after the fingerprint cause is out of the way; owner likely `Queries.page`/`totalOrder` on the include path. |
| `list/json filter > DateTime membership uses the same …` | 1 | candidate defect, unmeasured | `[]` where `['both']` expected. |
| `createMany select fold > four same-shape rows are ONE statement, and the rows come back` | 1 | candidate defect, unmeasured | length 5 where 8 expected: the MySQL implicit-returning read after a grouped insert. |

The three unmeasured candidates are hidden behind the fingerprint cause in
the same run (their schema sync passed, so they are real candidates); each
needs its own reproduction on the fresh container before an owner is named.

## 4. Repairs in this unit

R1 and R2 as stated in §0, both at `src/query-engine/raptor3/shared/query.ts`,
with their falsifiers in `receipts/falsifiers/`; typecheck after both:
`receipts/typecheck-after-r1r2.log`. Two test files re-expressed
(`tests/providers/docker/mysql2.test.ts`, `tests/unit/migrations/decimal-list-defaults-mysql-docker.test.ts`)
— the integrator re-reads these two hunks at review (they were made before
the author's session ended and the note does not explain them).

## 5. Release statement

- **PostgreSQL:** green on a PostGIS-enabled server except the five
  registered kept-red batch-only primary-key dataflow cells, which the
  release documents as a limitation of the batch-only transport shape. Two
  engine defects (an enum compared against a column; a JSON null document in
  a NOT NULL column) are repaired in this unit.
- **MySQL:** blocked by one pre-existing migrations-layer cause on MySQL
  8.4 (150 of 165 cells), plus four deadlock cells under concurrent writes,
  seven migrations-estate cells, and three engine candidates that cannot be
  measured until the migrations cause is fixed. The query engine itself has
  one repaired MySQL defect (R2) and no measured open one. A release that
  claims MySQL support needs the migrations unit first.

## 6. Open for Arnaud (from the review)

- **D-48 (decision, not a repair):** R2's named consequence — a NOT NULL
  `json` column that a provider answers with a genuine SQL NULL now decodes
  as the JSON null document instead of being refused. By the column's own
  contract that value cannot exist, so the arm is only reachable through a
  provider anomaly; the reviewer asks that the trade-off be either ruled
  and pinned by a registered cell or refused explicitly. Recorded here; no
  code moved.
- The MySQL deadlock family's three-run measurement is the parity repair
  round's (R8), not a fresh one from this unit.

