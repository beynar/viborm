# R2b — every command run, and what it answered

Worktree `/private/tmp/viborm-r2ab` on `cdd787ac8` (with R2a's repairs in the
tree), `TMPDIR=/private/tmp/viborm-r2ab-tmp`, Node 24.21.0, MySQL 8.4.11 in the
lane's own container (port 55731, database `raptor3_g2`). Every docker
invocation ran ONE file through
`node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=provider-mysql2 <file>`
with the connection string substituted into that one command.

## The native MySQL lane, file by file — the end-of-lane receipt

Raw logs: `lane-after/<file>.log`, one invocation each.

| file | R2a's answer (its §5 table) | R2b's answer |
| --- | --- | --- |
| `tests/providers/docker/mysql2.test.ts` | 84 passed, 1 skipped | **84 passed, 1 skipped** |
| `tests/providers/docker/mysql2-cascaded-identity.test.ts` | 4 passed | **4 passed** |
| `tests/providers/docker/mysql2-generated-key.test.ts` | 5 passed | **5 passed** |
| `tests/providers/docker/mysql2-schema-attestation.test.ts` | 5 passed | **5 passed** |
| `tests/providers/docker/mysql2-read-surface.test.ts` | 122 passed | **122 passed** |
| `tests/providers/docker/mysql2-relations-ddl.test.ts` | 104 passed, **1 failed** | **106 passed** (the repaired cell, plus this unit's limiting control) |
| `tests/providers/docker/mysql2-scalars.test.ts` | 292 passed, **1 failed** | **293 passed** |
| `tests/providers/docker/mysql2-writes-raw.test.ts` | 87 passed, **5 failed** | **88 passed, 4 failed** — the four are R2c's deadlock cells |
| `tests/contracts/engine/query/decimal-wide-arithmetic-docker.test.ts` | 35 passed | **35 passed** |
| `tests/unit/migrations/mysql-strict-mode-docker.test.ts` | 8 passed | **8 passed** |
| `tests/unit/migrations/decimal-list-defaults-mysql-docker.test.ts` | 1 passed | **1 passed** |

**751 passed / 4 failed / 1 skipped (756)**, against the lane's last recorded
589 / 160 / 1 (750). The four failures are R2c's four `ER_LOCK_DEADLOCK` cells;
the one skip is `test.runIf(options.name === "pg")` — a PostgreSQL-only plan
assertion (`polymorphic-relation-behavior.ts:427`), inapplicable on MySQL and
pre-existing.

`mysql2-after-cells.txt` is the `failed\tfile\ttitle` list;
`lane-after/diff-vs-m1.txt` diffs it against M1's
`g4/release/m1/receipts/mysql2-after-cells.txt`: **156 rows removed, 0 added** —
every failing or skipped cell here is one M1 already recorded, and nothing new
fails or skips.

## The three repairs, falsified

| what | evidence |
| --- | --- |
| descending to-many include ordering | red at the base copy of `query.ts` (restored by `cp`, restored back the same way): `falsification-ordering-base.log`, 1 failed / 3 passed, at `ordering-array-create-behavior.ts:128` |
| DateTime list membership | red at the same base copy: `falsification-member-base.log`, 1 failed, at `list-json-filter-behavior.ts:250` (the `has` assertion) |
| the createMany statement count | red at the base of the behaviour file: the lane's own recorded failure, `expected [ …(5) ] to have a length of 8 but got 5` (`fc/gate-closure/mysql2.log`, cell 153/160) |

## The diagnosis, retained before the repairs

`probes/` holds the temporary probe files (`*.test.ts.txt`, removed from the
tree afterwards) and their measurements:

- `ordered-include.json` — the emitted SQL for the three include windows, and
  MySQL's own answer to the SAME aggregate over the SAME derived table with and
  without a bound: without, `["Alpha","Beta","Gamma","Delta","Epsilon"]`
  (storage order); with `LIMIT 18446744073709551615`,
  `["Epsilon","Delta","Gamma","Beta","Alpha"]`. MySQL 8.4.11.
- `datetime-list.json` — the stored container
  (`["2024-01-02T03:04:05.000Z", …]`, a `json` column) beside the four filter
  operands: `equals`/`hasEvery`/`hasSome` bind the container and matched;
  `has` bound `'2024-02-03 04:05:06.000'` — MySQL's `DATETIME` rendering of the
  COLUMN — and matched nothing.
- `create-many-traffic.json` — the non-returning `createMany` traffic: four
  INSERTs, one refetch SELECT with an ordinal `ORDER BY CASE`, the rows in
  input order; the `{ count }` form one multi-row INSERT and no refetch; a
  one-row call 1 + 1.
- `other-members.json` — the same question asked of every OTHER list member on
  MySQL: a bigint member binds `"20"` against a container of `["10","20"]`, a
  date member `"2024-01-02"` against `["2024-01-02"]`, a string member `"a"`
  against `["a"]` — all three already agree with their containers, which is
  what the repair leaves untouched.
- `repaired-sql.json` — the same statements after the repairs: the ordered page
  carries the sentinel, a page with `take: 2` carries `LIMIT 2`, an UNORDERED
  page carries no bound at all, a ROOT ordered read is untouched, `has` binds
  `'2024-02-03T04:05:06.000Z'` and the scalar `when` still binds
  `'2024-01-02 03:04:05.000'`.

## The touched owners' existing pins, and the other legs of the three contracts

One invocation per row, each counted once.

| command | answer |
| --- | --- |
| `tests/providers/local/sqlite3-returning-json.test.ts` (ordering + list/json + createMany-fold, SQLite) | **354 passed** (177 × 2 projects) |
| `tests/providers/local/pglite-bulk-writes.test.ts` (`--project provider-pglite`, shared-family runner) | **148 passed** |
| `tests/providers/local/pglite-scalars.test.ts` (`--project provider-pglite`, shared-family runner) | **307 passed** |
| `tests/providers/local/libsql-returning-text.test.ts` + `libsql-parity-json.test.ts` | **784 skipped** — the file's own `describe.skip`, "V1 effectful push is not supported by libSQL", unchanged by this unit |
| `tests/raptor3/g4/read-codecs.test.ts` + `read-filters.test.ts` | **50 passed** (25 × 2 projects) — SL-07 is the dateTime-list codec pin |
| `tests/raptor3/g4/read-ordering.test.ts` + `read-projection.test.ts` + `read-pagination.test.ts` | **36 passed** (18 × 2 projects) |
| `tests/contracts/engine/query/lateral-joins.core.test.ts` + `orderby-relation-depth.core.test.ts` | **15 passed** |
| `tests/contracts/engine/query/parity-lowering.core.test.ts` + `query-inspection.core.test.ts` | **28 passed** |

## Whole-estate checks

| command | answer |
| --- | --- |
| `node scripts/run-typecheck.mjs` | **0 diagnostics**, exit 0 (5.77 s wall, 5098 MiB peak) — `typecheck.log` |
| `node scripts/query-engine-structure.mjs` | 38 files, **16 043 token lines**, 1093 functions (the checkpoint's 16 040 + 3) |
| `npx biome check <each changed file>` | 0 diagnostics on five of the six; `query.ts` keeps the base copy's own 15 errors + 1 info, diagnostic set unchanged — `biome-query-ts.md` |
| `node scripts/raptor3-refusal-census.mjs` | NOT re-run: this unit adds and removes no refusal sentence and no error class |
