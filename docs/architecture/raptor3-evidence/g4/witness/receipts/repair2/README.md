# Witness follow-up — repair round 4 (after the round-3 review)

Receipts of the repair that answers
[`../../../witness-followup-review-followup-2.md`](../../../witness-followup-review-followup-2.md)
(verdict **REVISE**: three must-fix, seven notes, none blocking). The prose
lives in `note.md` §17; the §16 corrections the review asked for are landed in
place in §16 itself, and §14.6 and §16.5 carry the two qualifications.

Everything ran through `scripts/run-raptor3.mjs`, `scripts/run-vitest-safe.mjs`
or `scripts/run-node-safe.mjs`, serially, under the workspace lock. Nothing was
committed or staged.

## What this round edited

No production file and no harness file. The one exception is deliberate and
reverted inside the same command: the note-6 falsification deleted one line from
`scripts/credential-free-test-manifest.mjs`, ran the self-test, restored the
file from a scratchpad backup and re-ran it — `shasum -a 256` is `8f4a447c…`
before and after (`note6-restore-verify.log`), and
`witness-harness-vs-0cc61e61.patch` is byte-identical to the one stored under
`../repair/`.

## Identity

| Bracket | Production | Harness | File |
| --- | --- | --- | --- |
| Opening 08:33 | `a830d713…` | `32af4729…` | `identity-before.json` |
| Before the CLI self-test 08:39 | `a830d713…` | `c1dcb19d…` | `identity-before-cli.json` |
| After the CLI self-test 08:43 | `a830d713…` | `eabbb531…` | `identity-after-cli.json` |
| Closing 08:50 | `a830d713…` | `0892edc1…` | `identity-after.json` |
| After the last edit 08:57 | `a830d713…` | `5ef4ad2b…` | `identity-final.json` (identity and delta proof in one process) |

**Production held `a830d713…` end to end and every run receipt carries it** —
`identity-audit.json` is that statement computed rather than asserted, over all
13 `attempt.json` / `verified.json` files here.

The harness half moved at least eleven times (twelve distinct fingerprints,
twice inside one 12-second command), entirely because another stream created,
rewrote and deleted files under `tests/raptor3/g4/review/unit02-phase2/` during
the round — ten files there at the final capture. `harness-delta-proof.json`
(closing bracket), `harness-delta-proof-final.json` (after it) and the
`harnessDelta` block inside `identity-final.json` recompute the fingerprint over
everything `captureRaptor3Identity()` reads (424, then 427, then 430 files) with
that stream's directory excluded, and every one gets `32af4729…` — the opening
harness, exactly — so the other **420** files are byte-unchanged across the
round. The final bracket records that invariant rather than a value that keeps
moving.

## Results

| Path | Command | Result |
| --- | --- | --- |
| `native/containers.txt` | container identity | same two containers, images `95206741…` / `b3b90af2…`, 0 restarts, ports **65504** / **65515** |
| `native/pg-attempt1.log`, `native/pg-attempt1/` | `g4-read-envelope-pg-contracts` | **5 / 5** (four provider cells + the provider-free adapter pin), 3.87 s, 531.4 MiB |
| `native/mysql-attempt1.log`, `native/mysql-attempt1/` | `g4-read-envelope-mysql-contracts` | **5 / 5**, 3.76 s, 525.7 MiB |
| `mode-g4-unit01-author-attempt1.log` | `g4-unit01-author` | **83 / 83**, gate verified |
| `mode-g4-unit01-review-attempt1.log` | `g4-unit01-review` | **200 / 200** over 29 files, gate verified |
| `write-seed-batch-75000-attempt1.log`, `write-campaign/sqlite-75000/` | `g4-write-seed-batch 75000` | green — 100 seeds / 200 cells / 600 replays, C08–C11 50 each, 40 two-actor, 40 overlap, 40 faults; raw 62,116,444 B, gzip 1,192,711 B |
| `write-campaign/sqlite-75000-archive.log` | `archiveG3GeneratedCorpus` | receipt carries **no `--subject`** |
| `write-seed-batch-75100-attempt1.log`, `write-campaign/sqlite-75100/` | `g4-write-seed-batch 75100` | green; restored sha256 `1e1d4736…` matches the archive receipt |
| `write-seed-batch-75200-attempt1.log` | `g4-write-seed-batch 75200` | green; generated for the replay attempt, its JSON receipt was deleted with its corpus |
| `write-transport-seed-batch-100000-attempt1.log`, `write-transport-100000-red/` | `g4-write-transport-seed-batch 100000` | **red, kept red** — `g3-c11-100027-0:recurrence-0; actual=INSERT; expected=INSERT,SELECT` |
| `g3-transport-smoke-twin-attempt1.log` | `g3-generated-transport-smoke` (G3's own) | **red at `g3-c11-8027-0:recurrence-0`** — offset 27 in both lanes |
| `campaign-receipts-selftest-attempt1.log` | receipts self-test | **39 / 39**, 0.39 s, 67.6 MiB |
| `typecheck-attempt1.log` | `run-typecheck.mjs` | clean apart from the two permitted Pattern TS2345, 6.89 s, 5,881.2 MiB |
| `raptor3-cli-selftest-attempt1.log` | CLI self-test | **kept failed**: 7 pass / 3 fail — two drift, one the `test:all` cell (11 failed / 747 passed, the §15.7 signature). **All three G4 cells green**, 223.54 s, 208.6 MiB |
| `review-probes-round3-attempt{1,3}.log` | round-3 reviewer probes, before and after the repairs | **16 pass / 2 fail** both times — both reds are their finding 1 and assert properties of the historical `followup-verify/` receipts, which cannot be re-taken. `attempt2.log` is **kept failed**: refused at the workspace lock |
| `review-probes-round1-attempt1.log` | round-1 reviewer probes | 5 pass / 5 fail / 3 skipped — unchanged from note §15.8 |
| `review-probes-round1-pool-pg-attempt1.log`, `…-mysql-…` | round-1 pool probes **with a provider** | all three previously-skipped cells **green** |
| `review-probes-round2-attempt1.log` / `attempt2.log` | round-2 reviewer probe | skipped without a provider; **1 / 1 green** with one |
| `write-corpus-gate-replay-attempt{1,3,4}.log` | archive → restore → replay, verbatim | **kept failed** — `Stale Raptor 3 evidence`, harness moved between generation and replay each time (blocker, note §17.8) |
| `write-corpus-gate-replay-attempt2.log` | the same | **kept failed** — refused at the workspace lock another stream held |
| `note6-falsify-walk-skip-attempt1.log` | deleting the credential-free walk skip | `EXTENDED_LOCAL_TESTS` 251 → **321**, G4 files 0 → **70**, self-test **38 / 1** |
| `note6-restore-verify.log` | restoring it | `8f4a447c…` byte-identical, 251 files / 0 G4, self-test **39 / 39** |
| `registration-totals.json` | registration re-derived from the manifest | 55 files / 392 cells, `route-transactions` 11 = 11, unit01 83 + 200, 0 registered-but-absent |
| `witness-harness-vs-0cc61e61.patch`, `patch-verification.txt` | `git diff 0cc61e61` over the ten tracked files | 88,236 B, **byte-identical** to `../repair/`, **0** `src/` files |
| `corpus/` | byte snapshot of the untracked `tests/raptor3/g4/**` | 132 files / 809,721 B at the open, 139 / 845,179 B at the close, delta = **7 files added by another stream, 0 removed, 0 changed**; this stream's 66 files total exactly 438,320 B at both brackets; the 43 landed G4-01 files differ from their source worktree in exactly one file (+96 B) |

## Scripts kept beside their output

`harness-delta.mjs`, `final-bracket.mjs` and `identity-audit.mjs` produce
`harness-delta-proof.json` / `harness-delta-proof-final.json`,
`identity-final.json` and `identity-audit.json`. They live here so the three
arithmetic claims of this round — "the harness delta is entirely another
stream's", "every run receipt carries the closing production identity", "the
landed G4-01 files differ from their worktree in one file" — can be recomputed
rather than believed. They are under `docs/`, so they are outside the harness
fingerprint and outside the charged cost.

## Disk

6.0 GiB free at both brackets and **5.1 GiB** six minutes later at the final
capture, none of that this stream's: four write children were generated here and
their raw corpora deleted after their receipts were read, leaving 2.1 MB
retained. The volume has read 6.4 → 6.2 → 6.0 → 5.1 GiB across the last three
rounds while ≈ 679 MB is projected for the two write families, so re-measure
immediately before any campaign run.

Nothing was committed or staged, and no receipt was relabelled.
