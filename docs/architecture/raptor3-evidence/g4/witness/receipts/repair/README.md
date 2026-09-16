# Witness repair receipts (round 2, after the follow-up review)

Every **run** receipt in this directory was produced at production
`7475621b28b95516fc380bebc0bb3d13f982f07289d4954dffd83b311c2bf317` / harness
`ebe1f7e656935d50ceec43785dfab447730987861dd516a187eec7297a6aa620`
(`identity-after-repair.json`), which is the identity of the tree at the last
source edit of this round. `identity-before-repair.json` brackets the round at
production `b100ea77…` / harness `b0bcc6cf…`; nothing else carries any other
identity. `note.md` §15.4 is the audit.

| Path | What it is |
| --- | --- |
| `witness-harness-vs-0cc61e61.patch` | cumulative diff of this stream's **ten tracked** harness files against `0cc61e61`; byte-current with `git diff`, 0 files under `src/` |
| `identity-before-repair.json`, `identity-after-repair.json` | the round's brackets |
| `write-child-ambient-count-attempt1.log` + `write-child-ambient-count/` | must-fix 1 falsified with the reviewer's own command: `VIBORM_RAPTOR3_GENERATED_SEED_COUNT=1 … g4-write-seed-batch 75000` now yields a 100-seed / 200-cell / 600-replay receipt |
| `falsify-missing-cell-count-attempt1.log` | must-fix 2's class guard falsified by deleting the `g4-write-seed-batch` count entry (runner restored from a scratchpad copy, sha `3c4fbcf9…` before and after) |
| `write-corpus-archive-attempt1.log`, `write-child-ambient-count/generated-corpus.archive.json` | must-fix 4: the archive receipt the repaired branch writes |
| `write-corpus-gate-replay-attempt1.log` | must-fix 4 falsified: that receipt's own `restoreCommand` + `replayCommand`, executed verbatim → "Raptor 3 replay contract gate verified" |
| `native/containers.txt` | the two containers, ports 65504 / 65515, images and restart counts |
| `native/pg-attempt1.log`, `native/pg-attempt1/` | `g4-read-envelope-pg-contracts` 5/5 |
| `native/mysql-attempt1.log`, `native/mysql-attempt1/` | `g4-read-envelope-mysql-contracts` 5/5 |
| `native/inherited-<mode>.log` (12 files) | the other ten registered PostgreSQL modes and the two MySQL ones, re-run on the repaired `live-world.ts` |
| `write-seed-batch-75000-attempt1.log`, `write-campaign/sqlite-75000/` | the SQLite write child, green |
| `write-transport-seed-batch-100000-attempt1.log`, `write-transport-100000-red/` | the transport write child, **red at cell 54** — kept red |
| `g3-transport-smoke-twin-attempt1.log` | G3's own `g3-generated-transport-smoke`, red at the same recipe offset — the evidence the red is phase 2's `src/`, not the campaign constant |
| `mode-g4-unit01-author-attempt1.log` + `mode-g4-unit01-author/` | 83/83 |
| `mode-g4-unit01-review-attempt1.log` + `mode-g4-unit01-review/` | 200/200 |
| `mode-g4-route-transactions-attempt1.log` + `mode-g4-route-transactions/` | 9/11, both reds `LX` DIVERGENCE PINs for blocker B-1 |
| `campaign-receipts-selftest-attempt1.log`, `…-attempt2.log` | 39/39 mid-round and after the last edit |
| `raptor3-cli-selftest-attempt1.log` | 9 pass / 1 fail, **no identity drift**; the failure is an inner `test:all` of 11 failed / 747 passed on another stream's `src/` |
| `typecheck-attempt1.log` | **kept failed**: the first `watchPool` helper was provider-agnostic and mysql2's `Pool.on` has no `"error"` overload |
| `typecheck-attempt2.log` | clean apart from the two permitted Pattern TS2345 |
| `review-probes-attempt1.log` | the reviewer's 13 probe cells, unedited: 5 pass / 5 fail / 3 skipped, each red explained in `note.md` §15.8 |

The G4 test tree is untracked on this branch, so the three G4 files this round
changed are not in the patch:
`tests/raptor3/g4/generation/write-campaign.test.ts`,
`tests/raptor3/g4/generation/write-transport-campaign.test.ts`,
`tests/raptor3/g4/native/read-envelope-native.test.ts`.

Nothing here was committed or staged, and no receipt was relabelled.
