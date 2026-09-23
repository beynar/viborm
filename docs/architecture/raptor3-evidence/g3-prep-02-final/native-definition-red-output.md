# G3P-02 final definition-red output

These are failed pre-fix observations, not qualification receipts. The Raptor 3
runner writes no `verified.json` after a failed gate.

| Provider | Runtime | Command | Result | Resources | JSON |
|---|---|---|---|---|---|
| PostgreSQL | 16.14 (Debian 16.14-1.pgdg13+1), cached image `sha256:95206741a5b214807675e14165369d05b93a9cf692223b616d07cca227e74b0b` | `VIBORM_RAPTOR3_PROVIDER_PORT=<task-owned-loopback-port> node scripts/run-raptor3.mjs g3p02-pg-contracts` | 5 collected; 4 passed; `g3p02-duplicate-selector-definition-refusal-and-distinct-control` failed at `native-constraint-ownership.test.ts:649` because `scalarConstraint` was unset | 3.60 s; 536.6 MiB peak sampled group RSS; teardown verified | [`native-pg-definition-red.vitest.json`](receipts/native-pg-definition-red.vitest.json) |
| MySQL | 8.4.11, cached image `sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb` | `VIBORM_RAPTOR3_PROVIDER_PORT=<task-owned-loopback-port> node scripts/run-raptor3.mjs g3p02-mysql-contracts` | 5 collected; 4 passed; `g3p02-duplicate-selector-definition-refusal-and-distinct-control` failed at `native-constraint-ownership.test.ts:649` because `scalarConstraint` was unset | 4.05 s; 522.4 MiB peak sampled group RSS; teardown verified | [`native-mysql-definition-red.vitest.json`](receipts/native-mysql-definition-red.vitest.json) |

The exact target assertion ran inside `runLiveWorld`: candidate construction did
not throw the required I006 schema error. `runLiveWorld` captured that assertion
as the operation outcome, after which the outer `assert(scalarConstraint)` hid
the inner message in the reported failure. This is a witness-reporting defect;
the JSON files above preserve the actual reported output without rewriting it.

After the witness rethrew `world.terminalFailure` before success-only checks,
the same frozen production produced the unmasked target failure, `Missing
expected exception`, at the candidate-construction assertion on both providers:
[`PostgreSQL JSON`](receipts/native-pg-definition-red-unmasked.vitest.json) and
[`MySQL JSON`](receipts/native-mysql-definition-red-unmasked.vitest.json). Each
rerun again collected five cases, passed the four established constraint cases,
failed only the collision definition case, and had zero pending tests.

Both task-owned containers used loopback-only random ports, tmpfs data, no host
mount, one CPU, and the established 512/768 MiB provider limits. They reported
zero OOM kills and restarts, were stopped with `--rm`, and the final
`viborm.test=raptor3-g3p02-red` census was empty.
