# Witness follow-up — independent review receipts

Every file here is a raw receipt of a command this review ran on the main tree
`/Users/arnaud/code/viborm` on 2026-09-15, between production identity
`c2613acf…` and `b100ea77…` (the tree was being written by the G4-02 phase-2
author throughout). Failed attempts keep their names and stay failed.

| File | Command |
| --- | --- |
| `identity-before-probes.json`, `identity-before-native.json`, `identity-after-chain.json`, `identity-after-chain2.json`, `identity-after-chain4.json` | `captureRaptor3Identity()` around each batch of runs |
| `probes-attempt1.log` | first review-probe run — **refused by the workspace lock**, kept |
| `probes-attempt2.log` | review probes, all four files (3 green / 7 red / 3 skipped) |
| `probes-attempt3.log` | the write-lane probe re-run after its third cell was corrected to build a truthful 1-seed receipt |
| `probe-native-pg-attempt1.log`, `probe-native-mysql-attempt1.log` | the pool-configuration probes against the recorded containers (ports 65504 / 65515) |
| `native-pg-mode-attempt1.log`, `native-mysql-mode-attempt1.log` | `run-raptor3.mjs g4-read-envelope-{pg,mysql}-contracts` |
| `mode-g4-unit01-author-attempt1.log`, `mode-g4-unit01-review-attempt1.log`, `mode-g4-route-transactions-attempt1.log` | the landed and adjacent fixed modes |
| `campaign-receipts-selftest-attempt1.log` | `scripts/raptor3-campaign-receipts.test.mjs` (39/39) |
| `raptor3-cli-selftest-attempt1.log` | `scripts/raptor3-cli.test.mjs` (9/10, no identity drift) |
| `typecheck-attempt1.log` | `scripts/run-typecheck.mjs` |
| `write-child-ambient-count-attempt1.log` + `write-child-ambient-count/` | finding 1: `VIBORM_RAPTOR3_GENERATED_SEED_COUNT=1 … g4-write-seed-batch 75000` and the qualifying 1-seed receipt it produced |
| `write-child-2seed-attempt1.log`, `write-child-2seed-evidence-path.txt`, `write-corpus-gate-replay-attempt1.log` | finding 4: a write child and the ordinary `replay <corpus>` gate accepting its corpus |
| `write-seed-batch-75000-attempt1.log` | full 100-seed SQLite write child, green |
| `write-transport-seed-batch-100000-attempt1.log` + `write-transport-100000-red/` | finding 9: the transport write child, red at cell 54 on a phase-2 physical change |

Probes live in `tests/raptor3/g4/review/witness-followup/` and are run with

```
node scripts/run-vitest-safe.mjs run \
  --workspace=tests/raptor3/g4/review/witness-followup/review.workspace.ts \
  tests/raptor3/g4/review/witness-followup/
```

(the two native cells additionally need `VIBORM_RAPTOR3_PROVIDER=pg|mysql` and
`VIBORM_RAPTOR3_PROVIDER_PORT`). A probe cell that **fails** states a finding;
the green cells are controls and confirmations.
