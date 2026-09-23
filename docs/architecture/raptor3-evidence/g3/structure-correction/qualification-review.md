# G3 structural-correction independent qualification review

## Outcome

**ACCEPT.** The bounded G3 structural correction is qualified on production
`fe544577cbc3c6747806f4b6a178ffe284d52d7ac3b5dd87fcd39adc2c3d54da`,
harness `3d9977876d5b8c0c80aec1ea6902f34b39ea80ab52e07e7242a287312dd2b922`,
and Node 24.21.0.

This acceptance covers the retained `Queries.updateValue` arithmetic owner, the
shared terminal-result decoder with explicit cardinality, and root-only
static-series result and scratch completion. It does not authorize a public
route change, G4 work, or cutover.

## Validation

- All 2,919 entries in `qualified-final/SHA256SUMS` verify. The retention
  manifest accounts for 2,918 non-self files and 654,183,404 bytes with no
  missing file, extra file, digest mismatch, or byte-count mismatch.
- The 868-file frozen identity manifest matches every current source file.
  Independent recomputation gives the exact production and harness identities
  above. The nine-file source allowlist matches the working tree, and
  `source.patch` reverses cleanly and matches SHA-256
  `22dcec642d0be8fa49951bac5232070fd5ec187835a80f0bf846ef8891b93dcf`.
- The fixed receipts report 42 modes, 228 test suites, and 1,137 passing tests.
  The overlapping credential-free selector reports 65 files and 758 passing
  tests. PGlite reports 5 files and 11 passing tests. PostgreSQL reports 10
  modes and 58 passing tests. MySQL reports 9 modes and 47 passing tests.
- All nine campaign families account for 61,000 cells, 183,000 exact replays,
  and zero skips. The two G3P06 one-batch receipts now retain the required
  `verified.json`, `vitest.json`, and `generated-campaign.json`: each reports
  1/1 passing test, 200 completed cells, 600 replays, zero skips, and the exact
  frozen identity. The full G3 SQLite and transport families retain all 100
  children each. The retained G2 families retain all 50 children each.
- The retained-corpus audit covers all 300 G2/G3 gzip corpora and records
  16,111,971,762 restored bytes from 320,838,589 compressed bytes with restored
  byte and SHA-256 checks. The earlier 52-child G3 transport attempt and its
  `ENOSPC` failure remain diagnostic-only; the separate 100-child transport
  campaign is the passing evidence.
- Seven selected current corpora replay. Two historical corpora correctly
  refuse stale identities. Driver integration reports 16 passing tests,
  receipt self-tests 34, and CLI integrity 7. Typecheck contains only the known
  Pattern TS2345 diagnostics at `pack.ts:1443` and `pack.ts:2633`.
- The isolated structural measurement reports 28 cases, 60 exact replays, and
  zero skips. Its instrumentation patch hash matches the receipt. Reversal
  restores both touched source hashes and the full frozen identity.
- The current cost census matches every charged source hash and totals 6,927
  core token-lines, 43,383 parser tokens, and 230,397 bytes; the 30-file whole
  scope totals 11,849 token-lines, 72,385 parser tokens, and 499,927 bytes.
  Both scopes remove 28 token-lines, 74 parser tokens, and 1,121 bytes from the
  unit04 baseline.
- The exact task commit allowlist contains 4,849 existing unique paths in the
  correction scope. It excludes the named unrelated dirty files and archives.
  No file is staged. This review stays outside the sealed author tree.

The first author seal was not acceptable because it omitted the required
G3P06 child reporter and compact-summary files. The author recovered the exact
current-identity payloads named by the parent manifests, added only the three
required files for each child, updated the claims, and resealed the package.
No test rerun or source change was needed.

## Risks

- The source reduction is not evidence of a runtime or bundle improvement.
- Low bind limits can produce more physical statements and terminal queries.
- The prepared generated-key witness uses a SQLite3-derived batch-only test
  driver. It does not extend the current native PostgreSQL or MySQL claims.
