# D-33 reviewer runs (transcript record)

Reviewer, independent of the author. Worktree `/private/tmp/viborm-rulings-d33`,
`TMPDIR=/private/tmp/viborm-rulings-tmp-d33r` exported for every run; one file
or one registered mode per call, never two at once, no lock refusal met, no
lock removed.

Two runs have raw reporter output beside this file (`reviewer-pin.log`,
`reviewer-cache-swr.log`). The rest were observed in the reviewer transcript
and are recorded here by their summary lines; they are reported as such, not as
archived reporter output.

| run | project / mode | result | peak RSS |
| --- | --- | --- | --- |
| `tests/raptor3/g4/parity/json-read-schema.test.ts` | extended-local | 6/6 | 464–470 MiB |
| `tests/contracts/public-client/official-cache-swr.core.test.ts` | layer-client | 7/7 | 455 MiB |
| `tests/contracts/engine/query/parity-decoding.core.test.ts` | layer-query-engine | 9/9 | 453 MiB |
| `tests/raptor3/g4/parity/driver-result-parser.test.ts` | extended-local | 4/4 | 461 MiB |
| `tests/contracts/public-client/select-include-result.test.ts` | extended-local | 20/20 | 1474 MiB |
| `tests/contracts/public-client/official-cache-reads.test.ts` | extended-local | 11/11 | 1506 MiB |
| `tests/unit/cache/brand-token-keys.test.ts` | extended-local | 4/4 | 1470 MiB |
| `tests/contracts/public-client/batch-transaction.test.ts` | extended-local | 67/70 — 3 PRE-EXISTING reds (see below) | 1535 MiB |
| whole project | layer-client | 536/536 (42 files) | 690 MiB |
| whole project | layer-query-engine | 642/643 — the contract-matrix red, failing on `tests/raptor3/candidate-handoff.test.ts` | — |
| `node scripts/run-raptor3.mjs g2-contracts` | raptor3 | 216/216, contract gate verified | 724 MiB |
| `node scripts/run-typecheck.mjs` | whole estate | 0 diagnostics, 5.97 s, 4932 MiB | — |

## Falsification, reproduced by the reviewer

Recipe: `cp` the file to the reviewer scratchpad first, mutate in place, run,
restore from the copy, verify md5 (never `git checkout --` a dirty file). The
author's file was `a82d56b83f5bc44625d74341a057aba5` before the first mutation
and after every restore, byte for byte.

| mutation | pin | matches the author's record |
| --- | --- | --- |
| revert the reader hunk (`case "json": return this.jsonValue(value);`) | RED 6/6 | yes (`falsified-pin-final.log`) |
| ask the schema TWICE per value | RED 4/6 (the two refusal cells stay green) | yes (`falsified-twice-pin.log`) |
| restored | GREEN 6/6 | yes |

## The three pre-existing reds in `batch-transaction.test.ts`

Attributed by the reviewer: `src/query-engine/raptor3/shared/query.ts` was
replaced with `git show e821cd21:…` (md5 `e0f714a0988c54762c6cf163624ef39f`),
the file was re-run, and the SAME three cells failed with the same messages, so
they are pre-existing and untouched by D-33. The author's file was restored and
verified afterwards.

- `$transaction with array (batch mode) › batch-only driver batches nested write operations atomically`
- `$transaction with array (batch mode) › batch-only shared parsing keeps exact partitions with insert ids`
- `$transaction([...]) guard attribution after rollback › batch-only: a premise the rollback does NOT restore is still attributed to its own guard`

All three read `TransactionError: Driver "pglite" does not support callback
transactions and this transaction contains operations that cannot be batched
atomically.` The file is outside D-33's brief minimum; the author did not run it
and did not claim it.

## Formatting

`npx biome check` (2.3.11, the pinned version) on `shared/query.ts` reports the
same 16 entries — 4 `noParameterProperties`, 4 `useSimplifiedLogicExpression`,
3 `noUnusedFunctionParameters`, 2 `useDefaultSwitchClause`, 1
`noUnusedVariables`, 1 `format`, 1 `assist/source/organizeImports` — as
`e821cd21`'s copy of the same file measured under a temporary name in the same
directory (deleted afterwards). `npx biome format` on the changed file emits no
hunk touching any line the ruling added (`jsonSchema`, `schemaValue`,
`StandardSchemaV1`, `custom output schema`, `import { parse }`), so the
file-level `format` and `organizeImports` entries are entirely pre-existing. The
new test file is clean.
