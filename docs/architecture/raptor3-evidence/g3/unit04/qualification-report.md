# G3-04 qualification report

## Frozen source

The complete qualification used production identity
`5d7a639868789faff0cf0a2a04b11e846a91e4d82001c81277bf312ecb0c74c6`
and harness identity
`03b9f9050193b1cfada53f892f0ac487a5ccc291ec1c97f7b2290c259e935b44`.
The runtime was Node v24.21.0 on Darwin arm64, with the better-sqlite3 package
at 12.6.0 and Vitest 3.1.4. No production, harness, test, runner, or
registration file changed during the qualification window.

## Result

- All 42 fixed modes passed: 1,133 tests.
- The credential-free fixed aggregate passed: 65 files and 754 tests.
- All 19 native modes passed: PostgreSQL 58 tests and MySQL 47 tests.
- All five PGlite files passed: 11 tests.
- Both affected public-client driver files passed: 16 tests.
- All nine campaigns passed: 61,000 cells, 183,000 exact replays, and zero
  skips. Each G3 profile executed every seed ID from 8000 through 17999.
- Seven saved corpora replayed on the frozen source. Two historical corpora
  were correctly refused because their archived source identities were stale.
- The campaign receipt selftests passed 34 tests. The CLI integrity suite
  passed 7 tests, including its 65-file/754-test child aggregate.
- The structural measurement passed 28 cases and 60 same-build replays with
  zero skips. The instrumentation patch was reversed in the isolated copy and
  the frozen production and harness identities were recovered exactly.
- The full restoration audit decoded all 200 G3 gzip archives: 15,412,150,694
  original bytes from 297,206,575 compressed bytes, with zero hash, byte-count,
  descriptor, or corpus mismatches.

The fresh type check reported only the two already recorded Pattern TS2345
diagnostics at `src/query-engine/pattern/pack.ts:1443` and `:2633`. It reported
no new production, Raptor 3, harness, runner, or G3 test diagnostic.

## Evidence boundaries

`qualification-index.json` derives its counts from the accepted receipts and
fails its construction if the totals or frozen identities differ. Fixed,
native, campaign, replay, support, and structural evidence remains in its
named directories.

The credential-free aggregate and PGlite selector use established log-only
launchers. `selector-launch-provenance.json` records their exact frozen launch,
selection, resource result, and log hash. It does not claim that those logs
contain a JSON identity field.

The compact retained tree excludes nonselected raw `corpus.json` files and
campaign progress snapshots. Those files remain on the qualification host as
local-only evidence. Seven selected replay inputs are retained. Every G3 child
corpus is retained in its verified gzip form with its adjacent restoration
descriptor. No tar duplicate was created.

## Decision boundary

The G3 execution evidence is complete. G3 qualification approval remains a
root/user decision after independent review of the evidence and retained-file
manifest. G4 adoption and client cutover are a separate later decision.
