# G3 structural-correction qualified-final evidence

This is the frozen author qualification package for production `fe544577…`,
harness `3d997787…`, and Node 24.21.0. Its status remains pending independent
and root acceptance.

- `qualification-report.md` states the outcome, validation, and claim limits.
- `qualification-index.json` derives the qualifying counts and keeps acceptance
  pending.
- `source-allowlist.json`, `source.patch`, and
  `support/frozen-identity-manifest.json` identify the exact source/harness.
- `retained-files.json` and `SHA256SUMS` seal the author tree.
- `task-commit-allowlist.json` lists every current task file and excludes known
  unrelated dirty work. The pending qualification-review attestation is added
  separately outside this sealed tree.
- `reproduction.md` records the commands and isolation rules.
- `campaigns/g3-transport-seeds.incomplete/` is the preserved ENOSPC diagnostic,
  never a passing campaign.

Independent and root review attestations belong in the parent
`structure-correction/` directory, outside this checksum tree.
