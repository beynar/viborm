# Round-3 independent review of the G4 witness follow-up — receipts

Review document:
[`../witness-followup-review-followup-2.md`](../witness-followup-review-followup-2.md).
Verdict **REVISE** (three must-fix, seven notes; none blocking, nothing repaired
here).

Everything was run through `scripts/run-raptor3.mjs`,
`scripts/run-vitest-safe.mjs` or `scripts/run-node-safe.mjs`, serially, under
the workspace lock. Nothing was committed or staged; no file outside
`docs/` and `tests/raptor3/g4/review/witness-followup3/` was written.

## Identity

| Bracket | Production | Harness | File |
| --- | --- | --- | --- |
| Opening 08:06 | `a830d713…` | `7da70665…` | `identity-before.json` |
| Before the CLI self-test 08:20 | `a830d713…` | `62b5f02f…` | `identity-before-cli.json` |
| After the CLI self-test 08:24 | `a830d713…` | `ec0c773c…` | `identity-after-cli.json` |
| Closing 08:25 | `a830d713…` | `32af4729…` | `identity-after.json` |

Production held `a830d713…` end to end — one identity newer than every number
in `note.md` §16. The harness moved three times: twice because I added probe
files, and once because another stream created and then rewrote
`tests/raptor3/g4/unit02/decimal-having-operand.test.ts` at 08:21:48 and
08:25:16, inside the CLI self-test (finding 9).

## Results

| Path | Command | Result |
| --- | --- | --- |
| `mode-g4-unit01-author-attempt1.log` | `g4-unit01-author` | **83 / 83** |
| `mode-g4-unit01-review-attempt1.log` | `g4-unit01-review` | **200 / 200** |
| `native/containers.txt` | container identity | same two containers, images `95206741…` / `b3b90af2…`, 0 restarts, ports 65504 / 65515 |
| `native/pg-attempt1.log`, `native/pg-attempt1/` | `g4-read-envelope-pg-contracts` | **5 / 5** at `a830d713…` |
| `native/mysql-attempt1.log`, `native/mysql-attempt1/` | `g4-read-envelope-mysql-contracts` | **5 / 5** at `a830d713…` |
| `write-seed-batch-75000-attempt1.log`, `write-campaign/sqlite-75000/` | `g4-write-seed-batch 75000` | green, corpus **62,116,444 B** — the author's length exactly |
| `write-seed-batch-99900-attempt1.log`, `write-campaign/sqlite-99900/` | `g4-write-seed-batch 99900` | green — **the last legal batch of the lane, never run before** |
| `write-seed-batch-75100-attempt1.log` | `g4-write-seed-batch 75100` | green — a third never-run child, archived below |
| `write-campaign-archive-attempt1.log` | `archiveG3GeneratedCorpus` on that child | receipt carries **no `--subject`** |
| `write-corpus-gate-replay-attempt1.log` | the receipt's own `restoreCommand` + `replayCommand`, verbatim | restored sha256 matches; **"Raptor 3 replay contract gate verified"** |
| `write-transport-seed-batch-100000-attempt1.log`, `write-transport-100000-red/` | `g4-write-transport-seed-batch 100000` | **red, kept red** — `g3-c11-100027-0:recurrence-0` |
| `g3-transport-smoke-twin-attempt1.log` | `g3-generated-transport-smoke` | **red** at `g3-c11-8027-0:recurrence-0` — offset 27 in both, at `a830d713…` |
| `campaign-receipts-selftest-attempt1.log` | receipts self-test | **39 / 39** |
| `raptor3-cli-selftest-attempt1.log` | CLI self-test | **kept failed**: 8 pass / 2 fail; one drift (finding 9), one the author's own `test:all` cell with the identical 11 / 747 signature. All three G4 cells green |
| `typecheck-attempt1.log` | `run-typecheck.mjs` | **kept failed**: two TS18046 in my own new probe |
| `typecheck-attempt2.log` | `run-typecheck.mjs` | clean apart from the two permitted Pattern TS2345 |
| `review-probes-attempt1.log`, `review-probes-attempt2.log` | `tests/raptor3/g4/review/witness-followup3/` | **16 pass / 2 fail**; both failures are finding 1 |
| `patch-regenerated.patch`, `patch-files.txt` | `git diff 0cc61e61` over the patch's ten files | **byte-identical** to the stored patch, 88,236 B, 0 `src/` files |

The two failed attempts are receipts of **my** mistakes, not the unit's, and are
kept unrelabelled: the typecheck attempt carried an untyped `.mjs` import in a
probe I had just written.

## Disk

6.2 GiB free at the start of the round and 6.2 GiB at the end. Four write-child
corpora (62.1, 55.9 and 56.4 MB raw) were produced and deleted after their
receipts were read; only the small JSON receipts and one gzip are retained.
