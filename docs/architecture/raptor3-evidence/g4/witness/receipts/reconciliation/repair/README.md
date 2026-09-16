# Reconciliation repair receipts (round 2, after the independent review)

Written by the harness reconciliation unit while repairing
[`g4/harness-reconciliation-review.md`](../../../../harness-reconciliation-review.md)
(verdict REVISE). The narrative is [`g4/witness/note.md`](../../../note.md)
section 18.9. The first round's receipts are in the parent directory and were
not touched.

| File | What it is |
| --- | --- |
| `identity-final.json` | Raptor 3 identity at this round's last source edit: production `bc26281d…`, harness `49cbc09603…`. |
| `SHA256.files` | SHA-256 of the six files this unit owns, at the end of the round. |
| `reconciliation.patch` | The COMPLETE unit diff after the repair (six files, all under `tests/`; `grep -c "^+++ b/src/"` is 0). The two `g4/read-*.test.ts` files are untracked in git, so their halves are `git diff --no-index` against the pre-unit baseline reconstructed by reverse-applying the first round's patch. Reverse-applies cleanly against the working tree. |
| `repair-delta.patch` | Only this round's change: the reviewed state → the current state, four files, +81 / −35. |
| `folded-fault-census.json` | The folded (depth-0 C11 root `create`) × fault census over the three registered transport ranges and their run children, plus the fixed matrix's depth-0 entries. Computed by importing the REAL `generateG3Recipe`. Carries the identity and the SHA-256 of the three sources it read. Replaces §18.8 unverified claim #4. |
| `cs03-selftest.log` | CS-03 extension-campaign self-test with the narrowed recognizer, 42/42. |
| `cs03-extension-*-seeds.log` | The three registered 100-seed × 2-profile campaigns, green with the narrowed recognizer. |
| `g3-generated-transport-smoke.log` | The representative matrix with the added folded+faulted recipe (seed 8611), gate verified. |
| `g3-generated-smoke.log`, `g3-generated-minimization.log`, `g3-transport-seed-batch-8000.log`, `g4-write-transport-seed-batch-100000.log`, `g4-transport-seed-batch-50000.log` | The adjacent transport lanes, re-run after the recipe was added. |
| `g4-read-contracts.log` | 62/62 with the seeded SC-13 witness, after the R-8 reflow. |
| `g4-route-*.log` | The B-R2 re-measurement: 8 / 7 / 7 / 13, gates verified, all four exit 0. |
| `review-probes.log` | The reviewer's four probes plus the two unregistered §5.4 cut-evidence files, 22/22, re-run after the repair. |
| `falsify-sc13-seed-removed.log` | SC-13 with the seed removed (the first round's world): red at the physical-spelling pin. |
| `falsify-sc13-read-arm-on-empty-table.log` | SC-13 with the seed AND the pin removed: red inside `expectRead` — the vacuity the review found, now a failing assertion. |
| `falsify-folded-fault-recipe.log` | The fold withheld from faulted replies only: the smoke fails naming `g3-c11-8611-0:recurrence-0`, so the new recipe really exercises fold × fault. |
| `raptor3-campaign-receipts.log` | Receipts self-test, 39/39. Two earlier attempts in this round failed on my own malformed invocation (a wrong `--project` filter, then missing bounded-runner arguments) and were overwritten by the retry; no measurement was discarded. |
| `raptor3-cli-selftest.log` | CLI self-test, 10/10, before the R-8 one-line reflow. |
| `raptor3-cli-selftest-final.log` | CLI self-test, 10/10, at the final identity. No identity-guard trip in either. |
| `typecheck.log` | Whole-estate typecheck attempt 1: the two permitted Pattern `TS2345` plus ten `TS2741` in `tests/raptor3/g4/unit02/zz-probe.test.ts`, an untracked scratch file the concurrent G4-02 stream created at 14:05 and deleted before 14:16. Kept as it ran. |
| `typecheck-2.log` | Whole-estate typecheck attempt 2, after that file disappeared: the two permitted Pattern `TS2345` and nothing else. |
