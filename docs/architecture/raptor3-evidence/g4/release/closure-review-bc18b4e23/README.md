# Independent local closure review — executed falsifiers

Reviewed source: `bc18b4e2325a5f7dce1165e05a28482f78a83d72`, 2026-09-21.
Node v24.21.0, installed lockfile dependencies, serial bounded Vitest runs.
Production source and registered test files were not edited. These diagnostic
workspace plugins alter test sources in memory; they do not alter engine code.

## Results

| Run | Result | Observed fact |
| --- | --- | --- |
| [PG control](pg-control.log) | 1 passed, 16 not selected | Existing junction reassignment before premises converges as recorded. |
| [PG membership falsifier](pg-membership-red.log) | 1 failed, 16 not selected | Moving the same reassignment after all premises deletes `m1`; only `m3` survives instead of `m1,m3`. |
| [MySQL FOUND falsifiers](mysql-found-red.log) | 3 failed, 11 not selected | Connected target is `b2`, conditional count is `42`, and a reparented profile has `bio=written-by-o1`. |
| [PG combined-failure falsifiers](pg-outcome-red.log) | 2 failed, 15 not selected | Both UPDATE and DELETE publish the listener error instead of cardinality; public progress is `undefined`. The independent persisted-state assertions pass. |

These are six distinct failing cases, not counts of separate soft assertions.
The outcome cases each fail two soft assertions. They were rerun after correcting
the diagnostic output redactor, which had replaced the ordinary word
`undefined`; `pg-outcome-red.log` is the corrected run. That harness correction
did not change test or production behavior.

PostgreSQL uses the existing `PgWindowedBatchDriver` fixture against native
PostgreSQL: a forced batch/non-RETURNING capability profile, not stock pg routing
or a hosted driver. MySQL uses the real `MySQL2Driver` interactive route and
the existing before-statement scheduling subclass. The temporary test account
was removed after the MySQL run; isolated review databases were left for
inspection. No unrelated database was reset.

## Reproduction

The workspaces must be invoked from the repository root. Their only portability
change from the executed temporary workspaces is replacing that root's absolute
path with `process.cwd()`. Test transformations and witness bodies are retained.
Overlay line numbers in raw Vitest failures are transformed-source positions,
not reliable source-file links.

Use dedicated disposable native fixtures and the existing connection-string
environment variables. **The MySQL fixture resets every table in its configured
test database. Never point it at user data or another task's active fixture.**
The PostgreSQL overlay selects its isolated `albert_closure_review_20260921`
database. Do not print credentials in receipts.

From the repository root, use the following workspace paths with
`node scripts/run-vitest-safe.mjs --wall-limit-ms=180000 run --workspace <path>`:

- PG: `docs/architecture/raptor3-evidence/g4/release/closure-review-bc18b4e23/pg.workspace.mjs`.
  Filter `-t 'a member whose required membership was reassigned'`.
  Set `CLOSURE_REVIEW_LATE=0 CLOSURE_REVIEW_LISTENER=0` for the green control;
  set `CLOSURE_REVIEW_LATE=1 CLOSURE_REVIEW_LISTENER=0` for its red schedule.
- PG combined failures: same workspace; set
  `CLOSURE_REVIEW_LATE=0 CLOSURE_REVIEW_LISTENER=1`, and filter
  `-t 'a captured row that stops matching between the last premise|a root UPDATE in the same window'`.
- MySQL: `docs/architecture/raptor3-evidence/g4/release/closure-review-bc18b4e23/mysql.workspace.mjs`,
  filter `-t 'review:'`. The injected schema and tests are in that workspace and
  [mysql-witness.txt](mysql-witness.txt).

Do not treat these diagnostic assertions as the complete final regression
contract. For example, the current reference-reuse test expects a successful
connection to `b1`; the permanent test must also pin the established requirement
failure when that is the lawful outcome. What this run proves is a successful
connection to the wrong `b2`, which neither outcome permits. Positive confirmation
repairs also require hooks that cooperate with the lock they are proving, rather
than awaiting a concurrent mutation that the repaired code correctly blocks.

## Source identity

The following complete Git trees are identical at the reviewed squash and the
qualified integration source `b5fde8c1eec56992eaadd898c72e462a191151e5`:

| Tree | Git identity |
| --- | --- |
| `src` | `46fd05115fabf717ebd346291f47fbf0509ac1c5` |
| `tests` | `8124d70eb2a462b16d2f12a134cc30ec7a4aa55d` |
| `scripts` | `687dcf6f382314c9a95d1ffe70c3848f68278340` |
| `benchmarks` | `63f383607dadd33c8a87a98e728d5a20b47a8baa` |

SHA256 of unchanged configuration/dependencies:

- `vitest.config.ts`: `a0e536a68dff32def4967d82dca0df1d61afc5f87961fcaab034117a5ed6fd15`
- `vitest.workspace.ts`: `0a6ab889a7e618dde4c67c1512311ae62c6c3c668d65830346ef17f436ca454c`
- `pnpm-lock.yaml`: `c366c9806e268e19970626c34e0c5ea1bb74cc7c24b388fa072d580d7bf9aceb`

The existing source-bound performance and gate receipts remain valid for the
cases they ran. These additional schedules expose missing coverage, not falsified
historical results. The single implementation handoff is
[the repair prompt](../../../../raptor3-local-closure-repair-prompt.md).
