# Reconciliation receipts (G4 harness reconciliation unit)

Written by the harness reconciliation unit; the narrative is
[`g4/witness/note.md`](../../note.md) section 18.

| File | What it is |
| --- | --- |
| `identity-after-edits.json` / `identity-final.json` | Raptor 3 identity after the source edits and at the last edit. |
| `SHA256.files` | SHA-256 of the five files this unit edited, at the end of the round. |
| `reconciliation.patch` | The whole diff of this unit AS REVIEWED (five files, +50 / −19). `grep -c "^+++ b/src/"` is 0. **Superseded for integration by [`repair/reconciliation.patch`](repair/reconciliation.patch)**, which carries the post-review state; kept because the review and the reconstructed baselines reference it. |
| `cut-tapes-baseline-0cc61e61-src.json`, `cut-tapes-current-src.json` | Recorder tapes of the five failing CS-03 recipes plus four controls, once against `0cc61e61`'s `src/` and once against the working tree, same harness. The evidence for the section-18.1 classification. |
| `cs03-selftest-after.log`, `final-cs03-selftest.log` | CS-03 extension-campaign self-test, 42/42. |
| `falsify-cs03-selftest-on-baseline-src.log` | The repaired recognizer, 42/42 against `0cc61e61`'s `src/` — it reads the cut, not one engine's spelling. |
| `cs03-all-seed-sweep-after.json` | **SUPERSEDED — do not cite.** All 300 CS-03 cells (three slices, every seed, one profile), 0 failures, but the file carries no identity (38 bytes, no fingerprint, no slice or seed list, no runner line), so it cannot stand as evidence. Review finding 5. The claim it supported is withdrawn (note section 18.9 R-5); the same 300 recipes are covered on BOTH profiles by the three `cs03-*-seeds` campaign receipts beside it. Kept unmodified rather than deleted. |
| `cs03-extension-*-seeds.log` | The three registered 100-seed campaigns. |
| `g3-generated-transport-smoke.log`, `final-g3-generated-transport-smoke.log`, `g3-generated-smoke.log`, `g3-generated-minimization.log`, `g3-transport-seed-batch-8000.log`, `g4-write-transport-seed-batch-100000.log`, `g4-transport-seed-batch-50000.log` | The transport lanes after the root-`create` fold re-script. |
| `falsify-transport-fold-removed.log` | The fold branch removed: the recorded cell-54 red returns verbatim. |
| `g4-read-contracts.log`, `final-g4-read-contracts.log` | 62/62 after the two witness one-liners. |
| `falsify-witness-oneliners-reverted.log` | Both one-liners reverted: 60/2, the two being SC-13 and RF-16. |
| `g4-route-*.log`, `g4-lifecycle-*.log` | The stale-pin audit of section 18.5. All cells green; the modes exit on the registration counts. |
| `cs02-before.log`, `cs02-after.log`, `cs02-on-0cc61e61-src.log`, `cs02-clean-0cc61e61.log`, `falsify-cs02-on-b0ec55fa-src.log` | The CS-02 measurement red, reproduced at three earlier trees and diagnosed in section 18.3. `cs02-after.log` is the partial repair that was REVERTED. |
| `raptor3-campaign-receipts.log` | Receipts self-test, 39/39. |
| `raptor3-cli-selftest.log`, `-attempt2.log`, `-attempt3.log` | CLI self-test. Attempt 3 is the clean run at the final identity; attempt 2 tripped the identity guard on the concurrent `src/` stream and is kept as it failed. |
| `typecheck.log` | Whole-estate typecheck: only the two permitted Pattern `TS2345`. |

The repair round after the independent review has its own receipts and its own
README in [`repair/`](repair); nothing in this directory was modified by it,
except this line and the superseded row above.

