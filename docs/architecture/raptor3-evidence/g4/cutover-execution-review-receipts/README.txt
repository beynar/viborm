Independent review receipts — g4-cutover-execution (C-01), 2026-09-16 21:40–22:05.

Every command ran from /Users/arnaud/code/viborm on the pinned runtime, serially,
under the existing workspace lock. No lock was removed. Nothing was committed,
staged, reset or stashed. No production file was left modified: the two
falsification mutations (§F1, §F2 of the review) were restored and verified by
sha256, and captureRaptor3Identity().production after the review is
f42d6facdc5b36b420ca47b929acb629383dc47d3aa55be9c0d68fe2ae3c19d3 — byte-equal to
the author's post-edit production fingerprint.

  test-core-cutover.log            pnpm test:core equivalent on the cutover tree
                                   (--project='layer-*'): 35 failed files /
                                   534 failed tests of 467 / 9,420.
  test-core-base-5a37bcd7.log      the same command on a pristine copy of the base
                                   commit 5a37bcd7: 5 failed / 42 failed of 532 / 11,292.
  test-core-*-failing-files.txt    the two failing-file sets (the difference is
                                   the cutover's cost on this lane).
  layer-query-engine-cutover.log   the single worst layer, run alone.
  coverage-policy-cutover.log      pnpm test:coverage:policy first command — 9/11,
                                   green (11/11) on the base copy.
  cli-selftest-cutover.log         scripts/raptor3-cli.test.mjs — 0/10, reproduced.
  bundles-review.json              measure-raptor3-baseline.mjs --bundle after an
                                   independent pnpm package:build; compared
                                   field-by-field with g4/cutover/bundles-identity4.json:
                                   0 differing fields.
  patch-file-classification.txt    the 239 entries of cutover-identity4.patch,
                                   classified A/M/D, used for the diff equality check.

The base copy is /private/tmp/claude-501/.../scratchpad/basefull (git archive of
5a37bcd7 with node_modules symlinked); it is scratch and not part of the evidence.
