## 5. Registered inventory

Derived from vitest.workspace.ts and vitest.d1.config.ts include patterns, expanded by scripts/closure-final-inventory.mjs. A gate stage must run a
project's whole registered list; a hand-written glob over the same directory
is what omitted two `provider-mysql2` files from the previous checkpoint.

**Executions are not cases.** A file registered in two projects executes
twice, so a stage's reported `Tests` total is executed cells across project
executions, not that many distinct declared cases. Both columns are below.

| project | source | files | project needs | declared cells (files declaring) |
| --- | --- | --- | --- | --- |
| `coverage-raptor3` | `vitest.workspace.ts` | 185 | no credentials | 1830 (180 of 185) |
| `raptor3` | `vitest.workspace.ts` | 193 | no credentials | 1832 (182 of 193) |
| `raptor3-provider` | `vitest.workspace.ts` | 8 | no credentials | 0 (0 of 8) |
| `raptor3-live-provider` | `vitest.workspace.ts` | 25 | no credentials | 79 (25 of 25) |
| `layer-validation` | `vitest.workspace.ts` | 38 | no credentials | 0 (0 of 38) |
| `layer-scalars` | `vitest.workspace.ts` | 19 | no credentials | 0 (0 of 19) |
| `layer-operation-schemas` | `vitest.workspace.ts` | 47 | no credentials | 0 (0 of 47) |
| `layer-relations` | `vitest.workspace.ts` | 6 | no credentials | 0 (0 of 6) |
| `layer-schema-validation` | `vitest.workspace.ts` | 22 | no credentials | 0 (0 of 22) |
| `layer-schema-json` | `vitest.workspace.ts` | 6 | no credentials | 0 (0 of 6) |
| `layer-query-engine` | `vitest.workspace.ts` | 32 | no credentials | 0 (0 of 32) |
| `layer-write-engine` | `vitest.workspace.ts` | 4 | no credentials | 0 (0 of 4) |
| `layer-adapters` | `vitest.workspace.ts` | 9 | no credentials | 0 (0 of 9) |
| `layer-drivers` | `vitest.workspace.ts` | 43 | no credentials | 0 (0 of 43) |
| `layer-client` | `vitest.workspace.ts` | 42 | no credentials | 0 (0 of 42) |
| `layer-cache` | `vitest.workspace.ts` | 6 | no credentials | 0 (0 of 6) |
| `layer-instrumentation` | `vitest.workspace.ts` | 16 | no credentials | 0 (0 of 16) |
| `layer-migrations` | `vitest.workspace.ts` | 112 | no credentials | 0 (0 of 112) |
| `coverage-schema` | `vitest.workspace.ts` | 10 | no credentials | 0 (0 of 10) |
| `coverage-public` | `vitest.workspace.ts` | 4 | no credentials | 0 (0 of 4) |
| `coverage-extensions` | `vitest.workspace.ts` | 17 | no credentials | 0 (0 of 17) |
| `coverage-errors` | `vitest.workspace.ts` | 7 | no credentials | 0 (0 of 7) |
| `coverage-cli` | `vitest.workspace.ts` | 4 | no credentials | 0 (0 of 4) |
| `coverage-cache` | `vitest.workspace.ts` | 10 | no credentials | 0 (0 of 10) |
| `coverage-client` | `vitest.workspace.ts` | 41 | no credentials | 0 (0 of 41) |
| `coverage-drivers` | `vitest.workspace.ts` | 59 | no credentials | 0 (0 of 59) |
| `coverage-migrations` | `vitest.workspace.ts` | 120 | no credentials | 0 (0 of 120) |
| `coverage-write-engine-core` | `vitest.workspace.ts` | 4 | no credentials | 0 (0 of 4) |
| `coverage-write-engine` | `vitest.workspace.ts` | 5 | no credentials | 0 (0 of 5) |
| `extended-local` | `vitest.workspace.ts` | 191 | no credentials | 1 (1 of 191) |
| `provider-pglite` | `vitest.workspace.ts` | 6 | no credentials | 0 (0 of 6) |
| `provider-sqlite3` | `vitest.workspace.ts` | 6 | no credentials | 0 (0 of 6) |
| `provider-libsql` | `vitest.workspace.ts` | 6 | no credentials | 0 (0 of 6) |
| `provider-pg` | `vitest.workspace.ts` | 6 | `PG_TEST_CONNECTION_STRING` | 0 (0 of 6) |
| `provider-postgres` | `vitest.workspace.ts` | 4 | `PG_TEST_CONNECTION_STRING` | 0 (0 of 4) |
| `provider-mysql2` | `vitest.workspace.ts` | 13 | `MYSQL_TEST_CONNECTION_STRING` | 0 (0 of 13) |
| `provider-transaction-options` | `vitest.workspace.ts` | 1 | `PG_TEST_CONNECTION_STRING` | 0 (0 of 1) |
| `provider-neon-http` | `vitest.workspace.ts` | 2 | `NEON_TEST_CONNECTION_STRING` | 0 (0 of 2) |
| `provider-planetscale` | `vitest.workspace.ts` | 1 | `PLANETSCALE_TEST_CONNECTION_STRING` | 0 (0 of 1) |
| `provider-bun` | `vitest.workspace.ts` | 2 | no credentials | 0 (0 of 2) |
| `package` | `vitest.workspace.ts` | 1 | no credentials | 0 (0 of 1) |
| `provider-d1` | `vitest.d1.config.ts` | 1 | no credentials | 0 (0 of 1) |

### The gate plan this inventory implies

| stage | kind | files | project executions | declared cells |
| --- | --- | --- | --- | --- |
| `typecheck` | command | — | — | — |
| `fixed` | command | — | — | — |
| `parity` | files | 31 | 55 | 227 (24 of 31) |
| `conformance` | files | 6 | 6 | 0 (0 of 6) |
| `g2-baseline` | runner-mode | — | — | — |
| `g2-contracts` | runner-mode | — | — | — |
| `g1-compare` | runner-mode | — | — | — |
| `transport-smoke` | runner-mode | — | — | — |
| `transaction-array` | runner-mode | — | — | — |
| `pglite-provider` | files | 3 | 3 | 0 (0 of 3) |
| `census` | command | — | — | — |
| `build` | command | — | — | — |
| `campaign-receipts` | command | — | — | — |
| `coverage-policy` | command | — | — | — |
| `native provider-mysql2` | files | 13 | 13 | 0 (0 of 13) |
| `native provider-pg` | files | 6 | 6 | 0 (0 of 6) |

A `runner-mode` stage's files belong to `scripts/run-raptor3.mjs`'s own mode
table, which asserts its declared counts, so none is restated here.
Full lists: `node scripts/closure-final-inventory.mjs plan`.

83 test file(s) in the tree are in no workspace project (listed in `index.json`); a new witness placed outside every include pattern would appear here rather than pass unnoticed.

| list | files |
