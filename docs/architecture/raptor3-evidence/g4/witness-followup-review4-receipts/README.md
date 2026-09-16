# Independent review of witness repair round 4 — receipts

Receipts of the review written in
[`../witness-followup-review-followup-3.md`](../witness-followup-review-followup-3.md)
(verdict **ACCEPT**, six notes). Nothing was applied, repaired, committed or
staged; the only files this review created are these receipts and the probe
suite `tests/raptor3/g4/review/witness-followup4/`.

Everything ran serially through `scripts/run-raptor3.mjs`,
`scripts/run-vitest-safe.mjs`, `scripts/run-node-safe.mjs` or
`scripts/run-typecheck.mjs`, under the workspace lock.

## Identity

| Bracket | Production | Harness | File |
| --- | --- | --- | --- |
| Opening 09:03 | `a830d713…` | `7f9fbe2e…` | `identity-before.json` |
| Before the CLI self-test 09:12 | `a830d713…` | `536de647…` | `identity-before-cli.json` |
| After the CLI self-test 09:16 | **`6f2bb1e6…`** | `536de647…` | `identity-after-cli.json` |
| Closing 09:18 | **`9f35360f…`** | `536de647…` | `identity-after.json` |

Production moved twice, both times another stream's `src/` landing, and both
times **after** every identity-sensitive run had finished: each `attempt.json`
and `verified.json` here carries `a830d713…`, the identity the reviewed round
closes at. The harness moved once for my own probe files.

## Kept-failed receipts

`campaign-receipts-selftest-attempt1-wrong-runner-FAILED.log` (the node-test
self-test run through the Vitest runner) and
`…-attempt2-wrong-args-FAILED.log` (a stray `--test` flag) are my own two
mis-invocations. They are kept and labelled rather than deleted.

## What is here

- `mode-g4-unit01-{author,review}-attempt1*`, `native-{pg,mysql}-attempt1*` —
  83/83, 200/200, 5/5, 5/5, with their `attempt.json` / `verified.json`.
- `write-seed-batch-75000-attempt1.log`, `write-campaign/sqlite-75000/` —
  the child whose corpus is 62,116,444 B with C08–C11 50/50/50/50, 40
  two-actor, 40 overlap, 40 faults.
- `write-seed-batch-75300-attempt1.log`, `write-campaign/sqlite-75300/`,
  `write-campaign-archive-attempt1.log`,
  `write-corpus-gate-replay-attempt1.log`,
  `write-corpus-gate-restore-replay-attempt1.log` — a fresh child, its archive,
  and the archive → restore → replay path the reviewed round recorded as a
  blocker, green here twice.
- `write-transport-seed-batch-100000-attempt1.log`,
  `g3-transport-smoke-twin-attempt1.log`,
  `write-lane-boundary-refusals.log` — the two known reds, the seven
  off-boundary refusals, and the transport lane's last legal child (124900),
  red at offset 11.
- `campaign-receipts-selftest-attempt3.log` (39/39),
  `raptor3-cli-selftest-attempt1.log` (8 pass / 2 fail, all three G4 cells
  green), `typecheck-attempt1.log` (the two permitted Pattern TS2345 only).
- `review-probes-round3-attempt1.log` (16/18, unchanged),
  `review-probes-round4-attempt{1,2}.log` (10 pass / 2 fail, the two record
  findings).
- `patch-regenerated.patch` (88,236 B, byte-identical to both stored copies)
  and `blob-ids.txt`.

Raw corpora were deleted after their receipts were read; nothing over 100 KB is
retained here.
