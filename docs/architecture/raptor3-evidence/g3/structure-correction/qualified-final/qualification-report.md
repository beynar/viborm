# G3 structural-correction author qualification

## Outcome

The author qualification evidence is complete and frozen on production
`fe544577cbc3c6747806f4b6a178ffe284d52d7ac3b5dd87fcd39adc2c3d54da`,
harness `3d9977876d5b8c0c80aec1ea6902f34b39ea80ab52e07e7242a287312dd2b922`,
and Node 24.21.0. The sealed index status is
`author-qualification-evidence-complete-independent-and-root-acceptance-pending`.
Independent and root acceptance are not part of this author package.

The correction keeps one scalar-update meaning in `Queries.updateValue`, uses
one terminal-result decoder for explicit one/many/value cardinality, and leaves
static-series result and scratch completion at the root. Nested record execution
returns only its count and identities to its enclosing owner. The client route
is unchanged. No G4 feature, public cutover, or new engine language is included.

## Validation

- All 42 fixed modes passed 1,137 tests. The overlapping credential-free
  aggregate passed 65 files and 758 tests. The PGlite selector passed 5 files
  and 11 tests.
- All current native modes passed: PostgreSQL 10 modes / 58 tests and MySQL
  9 modes / 47 tests.
- All nine campaigns passed 61,000 cells, 183,000 exact replays, and zero skips.
  Both G3 profiles covered every seed from 8000 through 17999.
- Seven current corpora replayed. Two historical corpora were refused with the
  required stale-identity error.
- Driver integration passed 2 files / 16 tests. Receipt self-tests passed 34.
  CLI integrity passed 7.
- Typecheck reported only the two historical Pattern TS2345 diagnostics at
  `src/query-engine/pattern/pack.ts:1443` and `:2633`; there was no new
  diagnostic.
- Structural measurement passed 28 cases / 60 same-build replays / zero skips
  in an isolated worktree. Reversing the instrumentation restored both touched
  file hashes and the complete production/harness identity.
- A streaming audit restored and hashed every one of the 300 retained G2/G3
  gzip corpora: 16,111,971,762 original bytes from 320,838,589 archive bytes.
  The 200 mandatory G3 corpora account for 15,412,150,694 original bytes and
  297,206,436 archive bytes.
- Current source cost is 6,927 core token-lines / 43,383 parser tokens /
  230,397 bytes and 11,849 whole token-lines / 72,385 parser tokens /
  499,927 bytes. Both scopes are 28 token-lines, 74 parser tokens, and 1,121
  bytes below unit04. This is source cost only; no runtime or bundle improvement
  is claimed.

The deliberately low bind caps verify correct statement and terminal-query
partitioning. Their cost is more physical chunks. They are correctness evidence,
not a performance claim. The prepared generated-key and multi-terminal result
witness uses a SQLite3-derived batch-only test driver. It is not attributed to
the current native PostgreSQL or MySQL suites; those suites keep their existing
provider claims.

The two G3P06 campaign families retain their parent attempt/verified receipts
and logs. Those manifests bind first seed 7000, 100 seeds, two profiles, and
three replays. Each also retains its required one-batch compact child
`verified.json`, `vitest.json`, and `generated-campaign.json`: 1/1 test,
200 completed cells, 600 replays, and zero skips on the frozen identity. The
full G2 and G3 campaigns separately retain their compressed child receipts as
listed by the index and corpus audit.

The first final-identity transport attempt stopped after 52 verified children
when first seed 13200 hit `ENOSPC`. Its complete and failed evidence remains in
`campaigns/g3-transport-seeds.incomplete/` as a diagnostic. It is not a PASS and
is not used in the current totals. A separate fresh campaign produced the 100
passing children used by this report.

## Risks

- Independent and root review must accept the sealed evidence before the
  structural correction becomes the current G3 accepted checkpoint.
- The source measurements do not establish runtime or bundle improvement.
- Review attestations must remain outside the sealed checksum tree so that they
  do not rewrite the author evidence they assess.
