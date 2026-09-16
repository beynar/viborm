# G4 qualified evidence

This is the frozen author qualification package for production
`fce8ec0cd32c839c5517a383d92f003e090e72cb8110b8ec0e08e1f7664d6904`, harness
`d9b7c1653a76234a000ff49cc79cd530bd752e9adb2f0977d30bbe74d0c8ff56`, base commit
`0cc61e61`, and Node 24.21.0. Its status remains pending independent and root
acceptance.

- `qualification-report.md` states the outcome, validation, and claim limits.
- `qualification-index.json` derives every qualifying count from the receipts
  actually present, lists each one under `gaps` when a receipt is red, missing
  or unreadable, and keeps acceptance pending.
- `source-allowlist.json`, `source.patch`, and
  `support/frozen-identity-manifest.json` identify the exact source and harness.
  The patch carries the tracked diff against `0cc61e61` followed by a
  `--no-index` new-file diff for every untracked task file.
- `retained-files.json` and `SHA256SUMS` seal the author tree.
- `task-commit-allowlist.json` lists exactly what the integrator's commit stages
  — the task source set plus `g4.md` and the whole `g4/` evidence tree — and
  names the unrelated dirty work it excludes. The pending qualification-review
  attestation is added separately, outside this sealed tree.
- `reproduction.md` records the commands, the six campaign lanes and their own
  `TMPDIR` locks, the provider ports as recorded, the E-1 stale-world drop step,
  and the structural-measurement recipe.

## Layout

- `fixed/`, `native-pg/`, `native-mysql/`, `campaigns/`, `replays/` hold one
  `<mode>.receipt` directory per run with `<mode>.log` beside it. Each group's
  `RUN.log` and `FAILURES.log` are the driver's own progress record and are
  retained as written.
- `campaigns/<mode>.receipt/verified.json` is a campaign's parent manifest: it
  binds first seed, seed count, batch size, profiles and replay count, and names
  every child directory the lane produced.
- `campaigns/<mode>/seed-<first-seed>.receipt/` are the durably retained child
  receipts with their compressed corpora.
  `support/campaign-retention.mjs` is the one authority for what each family
  keeps: `all` (every child with its gzip corpus), `compact` (G3P06's one child
  `verified.json` / `vitest.json` / `generated-campaign.json`, no corpus), and
  `parent` (CS-03, whose parent receipt already carries the campaign and corpus).
- `support/` holds the identity, the six packaging scripts, the corpus
  packaging/retention/audit reports, and the driver's support-check logs and
  JSON reporters.
- `structural-measurement/` holds the isolated-worktree measurement receipt and
  the instrumentation patch with its before/after file hashes.

## Reading a corpus

Restore any retained corpus in a new temporary directory and compare its
restored byte count and SHA-256 with the adjacent archive descriptor
(`generated-corpus.archive.json` or `corpus.archive.json`) before using it. Each
descriptor carries its own `restoreCommand` and `replayCommand`.

## The two superseded attempts

Two earlier qualification attempts were stopped by a red they found, repaired,
and thereby made stale. Both are kept whole, unmodified and unrelabelled,
outside this package; neither contributes a count to it.

- **Attempt 1** (20:03–20:49, 2026-09-15; production `e2d5bcb2…` / harness
  `838a1e1b…`, at `../qualified-attempt-1-stale-identity/`). `g2-generated`
  failed one cell — seed 2122, `sqlite-atomic-batch`, fault
  `two-before-dispatch` — that passes 52/52 at baseline `0cc61e61`: a root
  single write's failure carried `recordSeriesProgress` and `statementIndex`
  the shipped engine does not attach. The production repair moved the identity.
- **Attempt 2** (00:55–01:20, 2026-09-16; production `fce8ec0c…` / harness
  `2b5ed066…`, at `../qualified-attempt-2-stale-identity/`).
  `g3-author-execution-regressions` failed "reports a malformed result after
  its atomic batch was acknowledged" with "Missing expected rejection": under
  D-7 that specimen's plan is one statement, so it takes the plain `execute`
  path and the corrupting driver's `executeBatch` cut is never reached. The
  specimen was re-expressed in the harness, which moved the harness identity.

Each attempt's receipts remain exactly as its runs wrote them: a stale attempt
is superseded, never relabelled as a pass.

Independent and root review attestations belong in the parent `g4/` directory,
outside this checksum tree.
