# Witness follow-up — verification pass (round 3, after ACCEPT)

This directory holds a **re-verification** of the accepted witness follow-up
(`note.md` §14) and its accepted repair (§15). **Nothing was edited in this
round**: no production file, no harness file, no test file. The only writes are
this directory and `note.md` §16. The harness fingerprint is
`7da70665d3c9ea9cb5e7b68620010584868ccd20951db8093d27407ada8e1a3c` at the first
and the last capture of the round, which is the arithmetic proof of that claim.

**Why the round exists — withdrawn and corrected** (round-3 review, must-fix 1;
`note.md` §17.1). This paragraph used to say that §15.7 measured the accepted
claims at production `7475621b…` and that the phase-2 author had landed `src/`
since, so the integrator needed them re-confirmed against a newer tree. The
receipts in this very directory say otherwise: production was **still**
`7475621b…` at the opening bracket and in **every** run receipt here, which is
the same production identity §15.7 already covered. The only identity that had
moved since §15.7 was the harness half, and it moved because the *round-2
reviewer* added a probe file. Production then moved to `a830d713…` at 07:52,
mid-round, and no result below was re-taken after it — so this directory's
numbers belong to `7475621b…` and not to the identity its closing bracket names.
The accepted claim set **at `a830d713…`** is measured in `../repair2/` and,
independently, in `../../../witness-followup-review3-receipts/`. Nothing in this
directory was relabelled or re-run to make that go away.

## Identity

| Bracket | Production | Harness | File |
| --- | --- | --- | --- |
| Opening (07:49) | `7475621b…` | `7da70665…` | `identity-before.json` |
| Before CLI attempt 2 (08:00) | `a830d713…` | `7da70665…` | `identity-before-cli-attempt2.json` |
| Closing (08:05) | `a830d713…` | `7da70665…` | `identity-after.json` |

Production moved once, **inside** CLI attempt 1: the phase-2 author wrote
`src/query-engine/raptor3/shared/operation-context.ts` at 07:52. Every run
below except the two CLI attempts carries production `7475621b…` / harness
`7da70665…` — read from each run's own `attempt.json` / `verified.json`, not
assumed. **Consequence, stated rather than left implicit:** no result below was
measured at `a830d713…`, the identity of the closing bracket. Read the table
below as the numbers at `7475621b…`.

## Results

| Path | Command | Result |
| --- | --- | --- |
| `campaign-receipts-selftest-attempt1.log` | receipts self-test | **kept failed**: refused at the workspace lock another stream held. Not a defect |
| `campaign-receipts-selftest-attempt2.log` | receipts self-test | **39 / 39**, 0.39 s, 67.5 MiB |
| `typecheck-attempt1.log` | `run-typecheck.mjs` | clean apart from the two permitted Pattern TS2345, 6.91 s, 5,841.8 MiB |
| `native/containers.txt` | container identity | same two containers, ports **65504** / **65515**, 0 restarts |
| `native/pg-attempt1.log`, `native/pg-attempt1/` | `g4-read-envelope-pg-contracts` | **5 / 5** — four provider cells and the provider-free adapter pin — 3.92 s, 529.8 MiB |
| `native/mysql-attempt1.log`, `native/mysql-attempt1/` | `g4-read-envelope-mysql-contracts` | **5 / 5** — the same four-plus-one split — 3.74 s, 529.5 MiB |
| `mode-g4-unit01-author-attempt1.log` | `g4-unit01-author` | **83 / 83**, gate verified |
| `mode-g4-unit01-review-attempt1.log` | `g4-unit01-review` | **200 / 200**, gate verified |
| `write-seed-batch-75000-attempt1.log`, `write-campaign/sqlite-75000/` | `g4-write-seed-batch 75000` | green, 100 seeds / 200 cells / 600 replays, 6.69 s, 927.4 MiB |
| `write-campaign/sqlite-75000-archive.log` | `archiveG3GeneratedCorpus` on that child | raw 62,116,444 B → gzip 1,192,711 B; **replay command carries no `--subject`**, which is the repaired branch |
| `write-transport-seed-batch-100000-attempt1.log`, `write-transport-100000-red/` | `g4-write-transport-seed-batch 100000` | **red, kept red** — `g3-c11-100027-0:recurrence-0; actual=INSERT; expected=INSERT,SELECT` |
| `g3-transport-smoke-twin-attempt1.log` | `g3-generated-transport-smoke` (G3's own, untouched) | **red at `g3-c11-8027-0:recurrence-0`** — same recipe offset 27, so the red above is not the campaign constant |
| `raptor3-cli-selftest-attempt1.log` | CLI self-test | **kept failed**: 6 pass / 4 fail; three failures are `Stale Raptor 3 evidence` from the mid-run `src/` write, the fourth is the `test:all` cell below. All three G4 cells green |
| `raptor3-cli-selftest-attempt2.log` | CLI self-test | **9 pass / 1 fail, zero drift** (`grep -c "Stale Raptor 3 evidence"` = 0), 227.04 s, 220.2 MiB |

The single CLI failure is `test:all cannot replace the required lane through
inherited specimen variables`. Its inner `test:all` is **11 failed / 747 passed**
in `core-structure/measurement/extension-campaign.selftest.test.ts` (CS-03 seeds
7133–7313) and `g3/generation/generated-transport-smoke.test.ts` — byte-identical
in shape to the signature §15.7 recorded. Nothing registration-shaped.

## Registration re-confirmed from the files

- `tests/raptor3/g4/route-transactions.test.ts`: registered **11**, file holds
  **11**.
- `G4_UNIT01_AUTHOR_COUNTS` sums to **83** and the mode ran 83/83;
  `g4-unit01-review` ran 200/200 over 29 files.
- No G4 suite leaks into the credential-free estate: filtering
  `EXTENDED_LOCAL_TESTS` for `tests/raptor3/g4/` returns **0** files.

## Disk

6.4 GiB free at the start of the round, 6.3 GiB at the end. Both retained
corpora are compressed (`generated-corpus.json.gz` 1,192,711 B; the transport
lane's `generated-failure-54.json.gz` 373,048 B); no raw corpus is retained.

Nothing here was committed or staged, and no receipt was relabelled.
