# R2a — every command run, and what it answered

Worktree `/private/tmp/viborm-r2ab` on `cdd787ac8`, `TMPDIR=/private/tmp/viborm-r2ab-tmp`,
Node 24.21.0, MySQL 8.4.11 in the lane's own container (port 55731, database
`raptor3_g2`). Every docker invocation ran ONE file through
`node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=provider-mysql2 <file>`
with the connection string substituted into that one command.

## The native MySQL lane, file by file

| file | before (integrator's `mysql2.log`, base `cdd787ac8`) | after |
| --- | --- | --- |
| `tests/providers/docker/mysql2.test.ts` | 85 tests, 83 passed, **1 failed**, 1 skipped | **84 passed, 1 skipped, 0 failed** |
| `tests/providers/docker/mysql2-scalars.test.ts` | 293 tests, **124 failed** | **292 passed, 1 failed** (R2b: DateTime list membership) |
| `tests/providers/docker/mysql2-relations-ddl.test.ts` | 105 tests, **28 failed** | **104 passed, 1 failed** (R2b: descending to-many include) |
| `tests/providers/docker/mysql2-writes-raw.test.ts` | 92 tests, **5 failed** | **87 passed, 5 failed** — the SAME five cells, cell for cell (1 R2b createMany statement count + 4 R2c deadlocks); untouched by this unit |
| `tests/providers/docker/mysql2-read-surface.test.ts` | 122 passed | **122 passed** |
| `tests/providers/docker/mysql2-cascaded-identity.test.ts` | 4 passed | **4 passed** |
| `tests/providers/docker/mysql2-generated-key.test.ts` | 5 passed | **5 passed** |
| `tests/unit/migrations/mysql-strict-mode-docker.test.ts` | 6 passed, **2 failed** | **8 passed, 0 failed** |
| `tests/providers/docker/mysql2-schema-attestation.test.ts` (new) | — | **3 passed** |

Lane failures **160 → 7**, and the 7 are exactly the three R2b items and the four
R2c deadlock cells (run once here for the record, untouched by this unit).

## The unit's own witness, falsified

`tests/providers/docker/mysql2-schema-attestation.test.ts`, 3 cells, green
(`mysql2-schema-attestation-after.log`). With the five production files restored
to their base copies (`cp` from the scratch backup, restored the same way), all
three cells fail with `Push completed its statements but the final live
fingerprint does not match the desired schema` — `falsification-base.log`.

## The touched owners' existing pins

| command | answer |
| --- | --- |
| `tests/unit/migrations/ddl-drivers.core.test.ts` | 330 passed (2 cells re-expressed) |
| `tests/unit/migrations/mysql-provider-free-catalog.core.test.ts` | 8 passed (1 cell re-expressed) |
| `mysql-namespace-ddl` + `mysql-catalog-namespace` + `mysql-decimal-conversion-recovery` + `mysql-recovery-and-session-coverage` + `mysql-sequential-program` + `operators-mysql-branch-closure` (.core) | 324 passed |
| `serializer` + `format-and-type-mapping` + `geopoint-ddl` + `relation-ddl-preservation` + `provider-driver-entrypoints-coverage` (.core) | 386 passed |
| `decimal-list-defaults.core` | 14 passed (2 cells re-expressed) |
| `decimal-list-storage-agreement` + `decimal-descriptor-ddl` + `decimal-descriptor-carriers` + `decimal-descriptor-transitions` (.core) | 116 passed |
| `tests/unit/migrations/decimal-list-defaults.test.ts` (PGlite, shared-family runner) | 5 passed |
| `tests/unit/migrations/decimal-list-defaults-mysql-docker.test.ts` | 1 passed |
| `v1-push` + `push-branch-fingerprint-and-interlock` + `pinned-session-boundaries` + `pinned-migration-session` (.core) | 76 passed |
| `v1-operators` + `v1-apply` + `v1-generate` (.core, the `noop` outcome's other readers) | 160 passed |
| `tests/unit/migrations/pinned-session-docker.test.ts` | 5 passed, 4 skipped (non-MySQL legs) |
| `tests/unit/migrations/shared-pool-estates-docker.test.ts` | 3 passed, 3 skipped (non-MySQL legs) |

## Whole-estate checks

| command | answer |
| --- | --- |
| `node scripts/run-typecheck.mjs` | **0 diagnostics** (6.70 s wall, 5147 MiB peak) |
| `node scripts/raptor3-refusal-census.mjs` | **23 candidate sentences at 30 sites**, invariant 22 / 21, internal 11, 193 total sites — unchanged; this unit adds and removes no refusal |
| `node scripts/query-engine-structure.mjs` | 38 files, **16 040 token lines**, 1093 functions — unchanged (no engine file touched) |
| `biome check <each changed file>` | 0 diagnostics on every one, base copies included; the new test file is the only one formatted |

The nine credential-free rows above sum to **1 419** cells
(330 + 8 + 324 + 386 + 14 + 116 + 5 + 76 + 160), each row run once; the three
docker rows are the 1 + 5 + 3 beside them, with seven non-MySQL legs skipped.

## Repair round (2026-09-21) — the review's three findings

Same worktree, same container. The deparse itself was measured first, in two
tables created and dropped by the same script
(`repair-deparse-measurements.md`).

| command | answer |
| --- | --- |
| `node scripts/run-vitest-safe.mjs run tests/unit/migrations/mysql-provider-free-catalog.core.test.ts` | **10 passed** (8 before: one cell added) |
| the same file with `src/migrations/drivers/mysql/introspect.ts` restored from the pre-repair backup copy (`cp`, restored the same way) | **2 failed / 8 passed** — the new cell only, `expected '_utf8mb4\'it\\\'s\'' to be "('it''s')"` |
| `… run tests/unit/migrations/decimal-list-defaults.core.test.ts` | **14 passed**, unchanged |
| `… --project=provider-mysql2 tests/providers/docker/mysql2-schema-attestation.test.ts` | **5 passed** (3 before: two cells added) — `repair-mysql2-schema-attestation-after.log` |
| the same file, introspector restored to the pre-repair copy | **1 failed / 4 passed**: the apostrophe cell, `MigrationError: Push completed its statements but the final live fingerprint does not match the desired schema`; the fail-closed cell stays green — `repair-falsification-pre-repair.log` |
| `… --project=provider-mysql2 tests/unit/migrations/decimal-list-defaults-mysql-docker.test.ts` | **1 passed**, unchanged |
| `… --project=provider-mysql2 tests/unit/migrations/mysql-strict-mode-docker.test.ts` | **8 passed**, unchanged |
| `node scripts/run-typecheck.mjs` | **0 diagnostics**, exit 0 (5.5–6.8 s wall, 5481 MiB peak) |
| `npx biome check` on the three files this round changed (`mysql/introspect.ts`, `mysql2-schema-attestation.test.ts`, `mysql-provider-free-catalog.core.test.ts`) | **0 diagnostics**, no fixes applied |

The census was NOT re-run: this round adds and removes no refusal sentence and
no error class — the new docker cell asserts the EXISTING `MIGRATION_DRIFT`
refusal. Token-bearing lines moved once, in `mysql/introspect.ts`: 419 → 438
(the unit's five production files now net **+20** against the base, not +1).
