# G4 qualified evidence

This is the frozen author qualification package for production
`312cde34932cdb4d70ccad60bb002d0c0a438865bd18e165c38b4a572ebff640`, harness
`1d4d913c4f686d7aa0871dde7f8af2c6049a674db2595c54a52b7f66491f2f9e`, base commit
`ff5e77ca`, and Node 24.21.0 — the **performance-pass-2 identity** (freeze 6,
18:40 on 2026-09-16). Its status remains pending independent and root
acceptance.

- `qualification-report.md` states the outcome, validation, and claim limits.
- `qualification-index.json` derives every qualifying count from the receipts
  actually present, lists each one under `gaps` when a receipt is red, missing
  or unreadable, and keeps acceptance pending. Its `gaps` list is **empty** and
  its status is
  `author-qualification-evidence-complete-independent-and-root-acceptance-pending`.
  No mode, campaign, replay, structural or corpus receipt was red on the frozen
  identity. Two checks were run twice and both first attempts are kept whole
  beside the counted runs: the CLI self-test (red under six live campaign lanes,
  green alone afterwards) and the structural measurement (red on a tooling
  incident, green on the re-run). Neither was a candidate failure; see
  "The two runs that were taken twice" in the report.
- `source-allowlist.json`, `source.patch`, and
  `support/frozen-identity-manifest.json` identify the exact source and harness.
  The patch carries the tracked diff against `ff5e77ca` followed by a
  `--no-index` new-file diff for every untracked task file, and it was proved to
  describe this tree by reverse-applying it with `git apply --check -R`.
- `retained-files.json` and `SHA256SUMS` seal the author tree.
- `task-commit-allowlist.json` lists exactly what the integrator's commit stages
  — the task source set plus `g4.md` and the `g4/` evidence tree — and names the
  unrelated dirty work it excludes. The pending qualification-review attestation
  is added separately, outside this sealed tree.
- `reproduction.md` records the commands, the six campaign lanes and their own
  `TMPDIR` locks, the provider ports as recorded, the E-1 stale-world drop step,
  the structural-measurement recipe, and the two checks that were run twice.
- `support/support-verification.json` re-derives, from the receipts,
  that the lane-5 source-cost census read the frozen bytes and that the CLI
  self-test's counted run is green;
  `support/verify-support-receipts.mjs` is the script that writes it.
- `PACKAGING-NOTES.md` is the packaging unit's own record of the decisions this
  seal makes.

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
- `support/` holds the identity, the packaging scripts, the corpus
  packaging/retention/audit reports, and the driver's support-check logs and
  JSON reporters. A support check that had to be run twice keeps both receipts:
  the re-run under the plain name the index reads, the first attempt beside it
  with an explicit suffix (`cli-selftest.attempt1-red.log`).
- `structure/` holds the isolated-worktree structural measurement receipt and
  the instrumentation patch with its before/after file hashes.
  `structure-attempt1-red-tooling/` is the first attempt of the same
  measurement, kept whole and unrelabelled; it is not counted anywhere.
- `main-tree.out`, `post.out`, `post.log` and `rerun.log` are the driver's own
  sequencing records for the serial main-tree chain and the post-lane phase.

## Reading a corpus

Restore any retained corpus in a new temporary directory and compare its
restored byte count and SHA-256 with the adjacent archive descriptor
(`generated-corpus.archive.json` or `corpus.archive.json`) before using it. Each
descriptor carries its own `restoreCommand` and `replayCommand`.

## The superseded attempts

Five earlier qualification attempts preceded this one. Each is kept whole,
unmodified and unrelabelled, and none contributes a count here.

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
- **Attempt 3** (01:58–03:47, 2026-09-16; production `fce8ec0c…` / harness
  `d9b7c165…`). It passed and was sealed and committed as part of `0f25637b`.
  Arnaud then ordered performance pass 1, which moved the identity, so attempt 3
  was superseded rather than failed. Its files were moved out of the tree to
  `/private/tmp/viborm-g4-qualified-previous-123127/`.
- **Attempt 4** (12:31–12:35, 2026-09-16, at
  `../qualified-attempt-4-stale-identity/`). Aborted at launch, tooling only:
  the six lanes were still checked out at `0cc61e61` after the commit, so the
  delta sync no longer carried the committed G4 files and every campaign parent
  failed within seconds; Docker Desktop was also found stopped. The lane sync
  now checks out the main tree's `HEAD` first and the freeze aborts on any
  identity mismatch. Freeze 4 is void: it never produced a receipt on the frozen
  identity.
- **Attempt 5** (12:47–14:06, sealed 16:38, 2026-09-16; production `2e92354b…` /
  harness `31c2883f…`, base `0f25637b`). It passed with an empty `gaps` list,
  after two support checks were re-run green on the unchanged frozen tree, and
  was committed as part of `ff5e77ca`. Arnaud then ordered performance pass 2,
  which moved the identity again, so attempt 5 is superseded by this package
  rather than by a red. The integrator moved its files out of the tree to
  `/private/tmp/viborm-g4-qualified-previous-184446/`; they remain in commit
  `ff5e77ca`.

Each attempt's receipts remain exactly as its runs wrote them: a stale attempt
is superseded, never relabelled as a pass. `task-commit-allowlist.json` does not
stage the `qualified-attempt-*-stale-identity/` directories — see
`PACKAGING-NOTES.md`.

Independent and root review attestations belong in the parent `g4/` directory,
outside this checksum tree.
