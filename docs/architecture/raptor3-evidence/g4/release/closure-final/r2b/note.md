# R2b — the exposed behaviour: what a MySQL page keeps, what a container carries, and what a statement count is not

Handoff §4 (R2b). Base `cdd787ac8` on `pattern-engine` with R2a's repairs in
the same worktree `/private/tmp/viborm-r2ab`, branch `closure-r2ab`, MySQL
8.4.11 in the lane's own container. Nothing committed, staged or pushed.

R2a unblocked the 150 cells that never reached their own body; the three
failures they had been hiding are this unit's. The lane is now **751 passed /
4 failed / 1 skipped (756)** — the four are R2c's deadlock cells, run once here
for the record and untouched, and the one skip is a PostgreSQL-only plan
assertion. Every command is in `receipts/runs.md`.

## 1. The three failing witnesses, and what each measured

Each was diagnosed by retaining the SQL the engine emitted and asking MySQL
itself what it does with it, BEFORE any edit (`receipts/probes/`).

**a. `to-many include honors descending orderBy`** —
`expected ['Alpha','Beta','Gamma',…] to deeply equal ['Epsilon','Delta',…]`,
i.e. the rows arrived in the order MySQL stores them, not the order the caller
asked for. The emitted page was
`… FROM (SELECT … WHERE <correlation> ORDER BY `q1`.`pages` DESC) AS `q2``,
with no bound, read by `COALESCE(JSON_ARRAYAGG(…), JSON_ARRAY())`. Measured on
the lane's own server (`probes/ordered-include.json`): that exact aggregate
over that exact derived table answers `["Alpha",…,"Epsilon"]` unbounded and
`["Epsilon",…,"Alpha"]` with `LIMIT 18446744073709551615` — MySQL merges an
unlimited derived table into the query that reads it, and the merge takes the
ORDER BY with it. The two neighbouring cells passed for the same reason they
were not witnesses: `take` emits its own `LIMIT`, and a bare `skip` already
emits the same sentinel because MySQL has no bare OFFSET.

**b. `DateTime membership uses the same values as the stored list`** —
`expected [] to deeply equal ['both']` at the `has` assertion.
`probes/datetime-list.json`: the stored container is
`["2024-01-02T03:04:05.000Z","2024-02-03T04:05:06.000Z"]` in a `json` column,
`equals`/`hasEvery`/`hasSome` bind that same container and matched, and `has`
bound `'2024-02-03 04:05:06.000'` — MySQL's `DATETIME` rendering, correct for a
`datetime(3)` COLUMN and absent from any JSON container. One operator, one
value, the wrong vocabulary.

**c. `four same-shape rows are ONE statement, and the rows come back in input
order`** — `expected [ …(5) ] to have a length of 8 but got 5`. The rows, their
order and the persisted effect were all asserted BEFORE that line and all
passed; only the count failed. `probes/create-many-traffic.json` establishes
what the five are: four INSERTs (one per input row) and ONE refetch SELECT over
all four created identities, `ORDER BY CASE WHEN … THEN 0 …` restoring input
order in SQL. The `{ count }` form is one multi-row INSERT with no refetch; a
one-row call is 1 + 1.

## 2. The facts, their owners, and the second consumer of each

**Fact 1 — an ORDERED page states its bound, because something above it reads
its rows in order.** Owner: the nested page's parts in
`Queries.lowerRelationProjection` (`src/query-engine/raptor3/shared/query.ts`),
the one place that builds the derived table the to-many aggregate reads. It
asks the adapter for the spelling rather than inventing one: the caller's own
window where there is one, and `adapter.noLimitValue` — the dialect's existing
"no limit" value — where there is none. A dialect that keeps a derived order
unbounded declares no such value (PostgreSQL) and emits nothing.
**Second consumer:** that value is already the bare-OFFSET spelling in
`appendLimitOffset` (`adapters/shared/select-assembly.ts`), which is why the
`skip`-only include never failed; and the same `limit` part is what
`assembleDistinctOnEmulation` applies to the OUTER ordered select of a
DISTINCT-emulated page, so a distinct ordered include is bounded by the same
rule and not by a second one.

**Fact 2 — a single value bound against a LIST field is one MEMBER of that
field's container, and a container carries what it was WRITTEN with.** Owner:
`Queries.fieldValue` (through `scalarValue`), the single destination-aware
operand owner, which now names that fact once (`const member`) instead of
letting one arm know it. The two scalars whose COLUMN spelling is physical
consume it: a decimal's exact `DECIMAL(p,s)` operand cast (which already did,
inline) and a datetime's dialect rendering of the instant.
**Second consumer:** `Queries.nativeType` already states the same fact for the
decode side — it refuses to hand a list's native type to a literal or to the
decode leaf — so the operand side and the leaf side now agree instead of
disagreeing by one dialect conversion. THREE other members were measured on the
default arm (`probes/other-members.json`, the retained receipt — these three and
no others): a bigint member binds `"20"` against a container of `["10","20"]`,
a date member `"2024-01-02"` against `["2024-01-02"]`, a string member `"a"`
against `["a"]`. Each already crosses a container exactly as it crosses its
column, so the rule leaves them alone; the scalars the receipt does not name
were reasoned about from the same owner, not measured.

**Fact 3 — result shape, cardinality and order are independent of statement
count (ELEGANCE §7), so a statement count is a witness only of what an owner
actually owns.** The engine owner is `Queries.selectSeries` +
`OperationContext.seriesQueries`: the created identities are read back by ONE
series select per bind-budget window, ordered by input ordinal, with its own
`expectedRows.missing` refusal for a row it cannot find.
**Second consumer:** `updateMany` with `select` reads its final identities back
through the same `selectSeries` (its `operation` argument is the only
difference), so the rule the re-expressed cell now states is the one both bulk
verbs already share.

## 3. The deletion

**No deletion in production.** Fact 1 adds a bound that did not exist; Fact 2
replaces one condition with a named one and changes a second; neither makes an
existing rule unnecessary. What is deleted is in the test tree: the obsolete
physical pin of §4 below — eight statements, and the interleaved
`[true,false,true,false,…]` shape of a path the engine no longer takes.

**Retained cost.** `node scripts/query-engine-structure.mjs`: 38 files,
**16 040 → 16 043 token lines** (+3), 1093 functions unchanged — no function
was added. The three token-bearing lines are `const member`, and the two lines
the ordered page's bound costs over the single line it replaced.
`git diff --numstat` for this unit's files (comments and tests included):

```
7	0	src/adapters/database-adapter.ts
22	0	src/query-engine/raptor3/AGENTS.md
24	3	src/query-engine/raptor3/shared/query.ts
16	12	tests/contracts/drivers/behaviors/create-many-return-fold-behavior.ts
20	0	tests/contracts/drivers/behaviors/list-json-filter-behavior.ts
18	0	tests/contracts/drivers/behaviors/ordering-array-create-behavior.ts
```

`src/adapters/database-adapter.ts` is 7 comment lines and **0** token-bearing
lines (257 before, 257 after): the `noLimitValue` doc now states the second
thing that value spells. No file outside this list is in this unit's diff.

## 4. The one recorded expectation re-expressed, and the two cells added

Never deleted, skipped or weakened.

**Re-expressed** — `create-many-return-fold-behavior.ts`, the non-returning
branch of "four same-shape rows are ONE statement…", naming the decision at the
cell (final-closure handoff §4, R2b: *an old exact statement count is not a
semantic contract by itself; replace only an obsolete physical pin, with a
witness that still catches lost results and per-row regressions*). Two
assertions replace the four, each with coverage the other does not have:
`statements.map(isInsert)` equals `[...rows.map(() => true), false]` — one
INSERT **per input row** (the per-row regression catcher: a fold on a driver
with no RETURNING would drop one, and the shape is derived from the result, not
a constant), every one of them BEFORE the read-back, and nothing else sent —
and `statements.filter(isSelect)` has length 1, which is what says that single
trailing statement is the series read-back rather than something else. The
rows, their input order against three disagreeing storage orders, and the
persisted effect are the cell's own untouched assertions above and below it,
and the engine's `expectedRows.missing` refusal is what catches a row the
series cannot read back. The returning branch is untouched.

**Added** (both are controls, green on every leg before and after):

1. `ordering-array-create-behavior.ts`, "to-many include honors descending
   orderBy under a take" — the limiting control the brief asks for: the bound an
   ordered page states is not a window of its own, so a requested `take: 2`
   still decides which rows come back and from which end of the order.
2. `list-json-filter-behavior.ts`, two assertions inside the DateTime
   membership cell: a moment ONE stored list holds selects that list alone, and
   a moment no list holds selects nothing — so a member bound in the container's
   vocabulary is still compared there, not merely accepted.

## 5. Validation

`receipts/runs.md` has every command and its answer. In short: the lane
**751 / 4 / 1** over its eleven files, one invocation each, raw logs in
`receipts/lane-after/`; `receipts/mysql2-after-cells.txt` diffed against M1's
list is **156 rows removed, 0 added** — nothing new fails or skips. Both engine
repairs are red at the base copy of `query.ts` (restored by `cp`, restored back
the same way) at their own assertion lines. The other legs of the three touched
contracts: SQLite 354, PGlite 148 + 307, libSQL skipped by its own
pre-existing `describe.skip`; the owner's pins `read-codecs`/`read-filters` 50,
`read-ordering`/`read-projection`/`read-pagination` 36, `lateral-joins` +
`orderby-relation-depth` 15, `parity-lowering` + `query-inspection` 28.
Typecheck **0 diagnostics**; Biome 0 on five changed files and, on `query.ts`,
the base copy's own 15 errors + 1 info with the diagnostic set unchanged (its
base carries a `format` diagnostic, so the formatter was never run on it). The
census was NOT re-run: this unit adds and removes no refusal sentence and no
error class.

## 6. Unverified, and what this unit did not do

- The DISTINCT-emulated ordered include takes the same bound **by
  construction** — `assembleDistinctOnEmulation` passes `parts.limit` to the
  same `appendLimitOffset` for its outer ordered select — which was read in the
  source, not exercised by a cell here. No registered cell combines `distinct`
  with an ordered to-many include on MySQL.
- On SQLite the same rule now emits that dialect's own `LIMIT -1` on an ordered
  to-many include. The SQLite and PGlite legs are green, but no cell asserts
  that text, and no SQL-text pin in the tree covers it.
- The refetch's **bind-budget windowing** (`seriesQueries` →
  `compileBindBudgetChunks`) is read from the source; a series wide enough to
  window would need more than 21 000 rows through a per-row INSERT path and was
  not measured. The re-expressed cell says "one refetch" of four rows, which is
  one window by construction.
- R2c's four deadlock cells were run once for the record and are **not** this
  unit's: `mysql2-writes-raw.test.ts`'s two upsert-atomicity and two
  nested-write concurrency cells, all `ER_LOCK_DEADLOCK`.
- Reported, not repaired (out of this unit's scope, both R2a's §6 disclosures
  and unchanged here): `escapeValue`'s backslash gap and `s.dateTime().now()`
  on MySQL.
- The §1 decision this unit implements is **D-66** ("Native MySQL is part of
  local release qualification… repair the bounded causes and exercise the
  previously blocked tests"), whose adoption R2a recorded in the ledger on the
  same date and which names R2b as continuing it. This unit implements its
  second half and adds no second adoption record for the same decision; the
  ledger record below points at R2a's.

**Blockers: none.**

## 7. Commit message draft

```
fix(raptor3): an ordered page keeps its order, and a list member keeps its container's

Two facts the native MySQL lane could not state until its schema attestation
stopped hiding them.

An ordered to-many include is a derived table read IN ORDER by the aggregate
above it, and MySQL merges an unlimited derived table into the query that reads
it -- taking the ORDER BY with it, so the rows arrive in storage order
(measured: the same aggregate over the same derived table answers ascending
unbounded and descending with a bound). The page now states that bound: the
caller's own window where it asked for one, and the dialect's existing
`noLimitValue` where it did not -- the same value a bare OFFSET already needs,
which is why the skip-only include never failed. A dialect that keeps a derived
order unbounded declares none and emits nothing. `take` still decides which
rows come back.

A single value bound against a LIST field is one MEMBER of that field's
container, and a container carries what it was WRITTEN with. `fieldValue` names
that fact once, and the two scalars whose COLUMN spelling is physical consume
it: a decimal's exact DECIMAL(p,s) operand cast, which already did, and a
datetime's dialect rendering of the instant -- MySQL's naive DATETIME, which a
JSON container has no column to hold. `has` on a DateTime list therefore
compares the ISO wire the container was written with, exactly as `equals`,
`hasEvery` and `hasSome` already did, with no operator-local converter. Every
other scalar already crossed a container as it crosses its column (measured for
bigint, date and string members).

The createMany statement count on a driver with no RETURNING is re-expressed as
what its owner owns: one INSERT per input row, and ONE series read-back of the
created identities ordered by input ordinal -- not the four interleaved
refetches the pin still described. The rows, their input order and the
persisted effect are the cell's own assertions; `selectSeries`'s missing-row
refusal is what catches a row it cannot read back.

Witnesses: the three lane cells, red before and green after, plus a limiting
control (an ordered include under `take`) and two membership controls (a moment
one list holds, a moment none holds). Native MySQL lane 751 passed / 4 failed /
1 skipped; the four are R2c's deadlock cells and the skip is a PostgreSQL-only
plan assertion. Engine 16,040 -> 16,043 token lines; typecheck 0.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
