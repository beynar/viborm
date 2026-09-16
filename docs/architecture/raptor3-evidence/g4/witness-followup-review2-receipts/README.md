# Independent re-review receipts (repair round 2, 2026-09-15)

Every run below was produced at production
`7475621b28b95516fc380bebc0bb3d13f982f07289d4954dffd83b311c2bf317` — the same
production identity the author's repair receipts carry, unchanged for the whole
review (`identity-before.json`, `identity-after.json`). The harness half is
`ebe1f7e6…` for every run except the last, where adding
`tests/raptor3/g4/review/witness-followup2/` moved it to `7da70665…`.

| File | What it is |
| --- | --- |
| `identity-before.json`, `identity-after.json` | the review's brackets |
| `mustfix1-ambient-count-attempt1.log` | must-fix 1 re-falsified with my round-1 command: `VIBORM_RAPTOR3_GENERATED_SEED_COUNT=1 … g4-write-seed-batch 75000` → `seedCount:100`, 200 cells, corpus 62,116,444 B |
| `falsify-pin-effective-attempt1.log` | must-fix 2: the newly registered count mutated to 2 → runner refuses, `1 !== 2` |
| `falsify-missing-cell-count-attempt1.log` | must-fix 2: the count entry deleted → `No registered cell count for g4-write-seed-batch`. Runner restored from a scratchpad copy; sha `3c4fbcf9…` before and after |
| `mustfix4-archive-attempt1.log` | must-fix 4: `archiveG3GeneratedCorpus(<write child>)` called as the parent does |
| `mustfix4-restore-replay-attempt1.log` | must-fix 4: that receipt's own `restoreCommand` + `replayCommand`, executed verbatim → "Raptor 3 replay contract gate verified" |
| `native-pg-attempt1.log`, `native-mysql-attempt1.log` | `g4-read-envelope-{pg,mysql}-contracts`, 5/5 each, including the new adapter-literal cell |
| `inherited-g2-pg-contracts-attempt1.log` | `g2-pg-contracts` 18/18 on the repaired `live-world.ts` |
| `inherited-g2-mysql-contracts-attempt1.log` | `g2-mysql-contracts` 10/13 — the same three `unique-races-live-commands` cells, unchanged |
| `write-transport-seed-batch-100000-attempt1.log` | the transport write child, **red** at `g3-c11-100027-0:recurrence-0` — kept red |
| `g3-transport-smoke-twin-attempt1.log` | G3's own untouched `g3-generated-transport-smoke`, **red** at `g3-c11-8027-0:recurrence-0` — same offset 27, the independent confirmation that the red is phase 2's `src/` |
| `campaign-receipts-selftest-attempt1.log` | **kept failed**: my own invocation error (wrong `run-node-safe.mjs` argument shape), exit 2 |
| `campaign-receipts-selftest-attempt2.log` | 39/39 |
| `raptor3-cli-selftest-attempt1.log` | 9 pass / 1 fail, no identity drift; the failure's inner `test:all` is 11 failed / 747 passed on another stream's `src/` |
| `typecheck-attempt1.log` | clean apart from the two permitted Pattern TS2345 |
| `review-probes-attempt1.log` | the round-1 probes, unedited: 5 pass / 5 fail / 3 skipped — identical to the author's run |
| `probe-pool-background-failure-attempt1.log` | **new probe, green**: a provoked background pool failure (idle backend terminated from a peer connection) reaches a fixture-shaped `pool.on("error")` subscriber on a driver-built pool |

Probe source (kept): `tests/raptor3/g4/review/witness-followup2/pool-background-failure.review.test.ts`,
`tests/raptor3/g4/review/witness-followup2/review.workspace.ts`.
