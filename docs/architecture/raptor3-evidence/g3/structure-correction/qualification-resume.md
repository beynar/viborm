# G3 structural correction qualification resume

## Status

The bounded structural correction is **IMPLEMENTED** and independently
**REVIEWED**. The interrupted qualification has been resumed on the unchanged
identity. The complete author qualification package is now frozen under
`qualified-final/`; [independent qualification](qualification-review.md) and
[root acceptance](root-acceptance.md) are complete. No validation remains open.
The earlier storage-exhausted attempt remains diagnostic-only.

The frozen qualifying identity is:

- production: `fe544577cbc3c6747806f4b6a178ffe284d52d7ac3b5dd87fcd39adc2c3d54da`
- harness: `3d9977876d5b8c0c80aec1ea6902f34b39ea80ab52e07e7242a287312dd2b922`
- runtime: Node `v24.21.0`

Historical G3 qualification receipts remain accepted evidence only for their
recorded older source identity. They are not final qualification evidence for
this correction and must not be relabeled.

## Completed final-identity stages

The evidence root is
`docs/architecture/raptor3-evidence/g3/structure-correction/qualified-final/`.
The following stages completed on the frozen identity:

- all 42 fixed modes: 1,137 tests;
- credential-free fixed aggregate: 65 files and 758 tests;
- PGlite selector: 5 files and 11 tests;
- PostgreSQL: 10 modes and 58 tests;
- MySQL: 9 modes and 47 tests;
- all seven inherited generated campaigns;
- final `g3-seeds`: all 100 children, with each child retained as a verified
  gzip corpus and adjacent restoration descriptor.

The first `g3-transport-seeds` attempt completed 52 verified children,
covering first-seed batches `8000` through `13100`. The next child,
first-seed `13200`, stopped with `ENOSPC` while writing its evidence. That path
remains preserved as an infrastructure failure, not a candidate/harness result
and not a passing campaign. A new full campaign then passed all 100 children
from `8000` through `17900` without overwriting the failed attempt.

Exact retained paths:

- completed G3 SQLite campaign:
  `qualified-final/campaigns/g3-seeds/`
- completed fresh G3 transport campaign:
  `qualified-final/campaigns/g3-transport-seeds/` and
  `qualified-final/campaigns/g3-transport-seeds.receipt/`
- incomplete G3 transport attempt, 52 verified children, failed child, and
  parent attempt:
  `qualified-final/campaigns/g3-transport-seeds.incomplete/`
- complete inherited G2 parent receipts:
  `qualified-final/campaigns/g2-seeds.receipt/verified.json` and
  `qualified-final/campaigns/g2-transport-seeds.receipt/verified.json`
- verified lossless packaging report for their exact 100 child corpora:
  `qualified-final/support/g2-corpus-packaging.json`
- durable retained G2 children and retention map:
  `qualified-final/campaigns/g2-seeds/`,
  `qualified-final/campaigns/g2-transport-seeds/`, and
  `qualified-final/support/g2-corpus-retention.json`
- compact G3P06 child receipts, one batch per family, each retaining
  `verified.json`, `vitest.json`, and `generated-campaign.json`:
  `qualified-final/campaigns/g3p06-seeds/seed-7000.receipt/` and
  `qualified-final/campaigns/g3p06-transport-seeds/seed-7000.receipt/`
- packaging tool and execution log:
  `qualified-final/support/package-g2-corpora.mjs` and
  `qualified-final/support/package-g2-corpora.log`

The G2 packaging operation selected only the 100 child `corpus.json` paths in
the two named parent manifests. It streamed and verified all 699,821,068
original bytes against SHA-256 and byte count after decompression, retained
23,632,153 compressed bytes, wrote 100 adjacent durable
`corpus.archive.json` descriptors, and only then removed each corresponding
raw file. Every child directory and every other report remains present.

The preserved interruption documents the host-space failure. It is not reused
as current qualification evidence.

## Completed resume boundary

Production, harness, tests, registrations, and campaign definitions remained
frozen. Seven selected current corpora replayed, two historical identities were
refused, driver integration passed 16 tests, receipt self-tests passed 34, CLI
passed 7, and typecheck retained only the two historical Pattern TS2345
diagnostics. Structural measurement passed 28 cases / 60 replays in an isolated
copy; reversing the instrumentation recovered both touched-file hashes and the
complete source/harness identity. Fresh source/token/byte measurements and the
streaming 300-corpus retention audit are in `qualified-final/support/`.

The author package preserves its pre-review status. The independent and root
acceptance attestations live outside its checksum tree. There is no active
validator. Root approves the exact task allowlist plus those two attestations
for one local commit; no push is authorized.
