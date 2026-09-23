Independent review receipts — g4-cutover-execution round 3 (C-01), 2026-09-17 00:05–01:0x.

Every command ran from /Users/arnaud/code/viborm on the pinned runtime, serially,
under the existing workspace lock. No lock was removed. Nothing was committed,
staged, reset or stashed. No production file was modified: captureRaptor3Identity()
.production after the review is
50c0ee97fb1458333c818735da4c92b7bca89daa65929199c00ef551533b7a63 — byte-equal to the
author's post-round-3 fingerprint (identity-after-review3.json).

  core-lane-review3.log            --project='layer-*' before my probe file: 6 failed
                                   files / 11 failed tests of 452 / 8,969.
  core-lane-final.log              the same at the final tree state: identical.
  core-lane-review3-failing.txt    the 11 failing cells.
  contract-matrix-base.log         contract-matrix on the base scratch tree: 2 red
                                   cells (the cutover tree has 1).
  typecheck-before-probe-fix.txt   2 Pattern TS2345 + the 3 TS2322 of note R3.8.
  typecheck-after-probe-fix.txt    exactly the two Pattern TS2345.
  typecheck-final.txt              the same, after my own probe file was added.
  package-build.txt                pnpm package:build, exit 0, 181 files.
  bundles-review3.json             measure-raptor3-baseline.mjs --bundle after an
                                   independent build; all three fixtures byte-equal to
                                   the author's bundles-after.json; charged cost census
                                   identical (139 / 1,423,012 / 42,335 / 31,664).
  g4-read-contracts.log            8 / 62 green.
  g2-contracts.log                 16 / 216 green.
  g4-unit02-author.log             21 / 130 green.
  g0.log                           33 / 33 green (D-11).
  g2-generated.log                 52 / 52 green (D-11).
  g4-unit02-pg-contracts.log       native PostgreSQL (port 55729), 1 / 1 green.
  g4-unit02-mysql-contracts.log    native MySQL (port 55730), 3 files / 17 green.
  g4-seed-batch-20000.log          G4 read child; corpus body sha256 16eab58f…f458,
  g4-transport-seed-batch-50000.log  and c8d9878a…92d6 — both equal to the attempt-6
                                   archives with the identity removed.
  receipts-selftest.log            raptor3-campaign-receipts.test.mjs 39 / 39.
  coverage-policy.log              pnpm test:coverage:policy 11/11, 16/16, 6/6.
  review-probes.log                the two inherited probes after the type fix, 7/7.
  review3-probes-attempt1.log      my probes, first run (4 cells of MINE were wrong).
  review3-probes-attempt2.log      my probes, corrected: 16 / 16 across three files.
  resurrected-deleted-suites.log   three class-A files restored from 5a37bcd7 and run
                                   on the cutover tree: 74/12, 48/6, 18/7 red (finding 4).
                                   The copies were removed afterwards.
  classd-bisect-base-candidate-route.log
                                   the five class-D files on 5a37bcd7 + a two-line
                                   candidate-route default: all ten cells red, observables
                                   byte-identical to the cutover tree.
  provider-local-BASE-legacy.log   provider-sqlite3 + provider-libsql at the base: 0 failed
                                   / 1,253 passed.
  provider-local-cutover.log       the same lanes on the cutover tree: 61 failed / 703
                                   passed in 5 files (finding 1).
  provider-local-BASE-candidate.log  the same lanes on base + candidate route: 71 failed —
                                   the 61 plus 10 in two suites the cutover deletes.
  pg-nested-write-races-BASE-legacy.log     77 / 77 green at the base.
  pg-nested-write-races-cutover.log         13 failed / 82 passed on the cutover tree,
  pg-nested-write-races-cutover-2.log       reproduced.
  pg-nested-write-races-BASE-candidate.log  8 failed at base + candidate route (the 5
                                   batch-primary-key-dataflow reds are round 3's own
                                   re-registration).
  pg-write-update-BASE-legacy.log  167 / 167 green at the base (the file C-01 deletes).
  pg-write-update-BASE-candidate.log  19 failed / 148 passed with the candidate route.
  mysql2-BASE-legacy.log           4 failed (pre-existing) / 80 passed.
  mysql2-BASE-candidate.log        12 failed.
  mysql2-cutover.log               13 failed / 71 passed; mysql2-cutover-2.log reproduces.
                                   The GeoPoint spatial-index cell is red ONLY on the
                                   cutover tree (finding 2).
  identity-after-review3.json      production 50c0ee97…, harness c88f426f… (my probe file
                                   and the three-token type fix are the difference).

The base scratch tree is /private/tmp/claude-501/-Users-arnaud-code-viborm/
c2c775da-2927-4590-8677-3bb0f5d1aa98/scratchpad/r3bisect (git archive of 5a37bcd7,
node_modules symlinked, src/client/client.ts toggled between the base and a two-line
candidate-route default). It was scratch, not evidence, and was deleted after the review; the two-line
default is reproduced from the author's classd-bisect/base-tree-route-default.diff.
