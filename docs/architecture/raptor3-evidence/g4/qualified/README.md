# G4 qualified evidence

This is the frozen author qualification package for production
`2e92354bafaaccb7cab5f54041992b552664a7865fb69370be70ebccb63a1975`, harness
`31c2883fd742dbea69896430543a85a9eace96719b9f24f9358593b54ff3a66a`, base commit
`0f25637b`, and Node 24.21.0 — the performance-pass identity (freeze 5, 12:47 on
2026-09-16). Its status remains pending independent and root acceptance.

- `qualification-report.md` states the outcome, validation, and claim limits.
- `qualification-index.json` derives every qualifying count from the receipts
  actually present, lists each one under `gaps` when a receipt is red, missing
  or unreadable, and keeps acceptance pending. Its `gaps` list is **empty** and
  its status is
  `author-qualification-evidence-complete-independent-and-root-acceptance-pending`.
  The two support gaps the first seal carried — a red CLI self-test cell and a
  missing support measurement — were re-run green on the unchanged frozen tree
  at 16:17–16:21 and are closed; `support/RERUN.md` is the account and the red
  first attempts are kept whole beside the new receipts. No mode, campaign,
  replay or structural receipt was ever red.
- `source-allowlist.json`, `source.patch`, and
  `support/frozen-identity-manifest.json` identify the exact source and harness.
  The patch carries the tracked diff against `0f25637b` followed by a
  `--no-index` new-file diff for every untracked task file, and it was proved to
  describe this tree by reverse-applying it with `git apply --check -R`.
- `retained-files.json` and `SHA256SUMS` seal the author tree.
- `task-commit-allowlist.json` lists exactly what the integrator's commit stages
  — the task source set plus `g4.md` and the `g4/` evidence tree — and names the
  unrelated dirty work it excludes. The pending qualification-review attestation
  is added separately, outside this sealed tree.
- `reproduction.md` records the commands, the six campaign lanes and their own
  `TMPDIR` locks, the provider ports as recorded, the E-1 stale-world drop step,
  the structural-measurement recipe, and the two support checks that had to be
  re-run.
- `support/RERUN.md` records what was re-run, where, when and why, with the
  lane-5 and main-tree identity receipts; `support/verify-rerun-receipts.mjs`
  re-derives its identity checks into `support/rerun-verification.json`.
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
  with an explicit suffix (`cli-selftest.attempt1-red.log`,
  `source-cost.attempt1-enobufs.log`).
- `structure/` holds the isolated-worktree structural measurement receipt and
  the instrumentation patch with its before/after file hashes. (The previous
  package called the same directory `structural-measurement/`; the index reads
  whichever exists and records the path it read.)

## Reading a corpus

Restore any retained corpus in a new temporary directory and compare its
restored byte count and SHA-256 with the adjacent archive descriptor
(`generated-corpus.archive.json` or `corpus.archive.json`) before using it. Each
descriptor carries its own `restoreCommand` and `replayCommand`.

## The superseded attempts

Four earlier qualification attempts preceded this one. Each is kept whole,
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
  Arnaud then ordered the performance pass, which moved the identity again, so
  attempt 3 is superseded by this package rather than by a red. The integrator
  moved its files out of the tree to
  `/private/tmp/viborm-g4-qualified-previous-123127/`; they remain in commit
  `0f25637b`.
- **Attempt 4** (12:31–12:35, 2026-09-16, at
  `../qualified-attempt-4-stale-identity/`). Aborted at launch, tooling only:
  the six lanes were still checked out at `0cc61e61` after the commit, so the
  delta sync no longer carried the committed G4 files and every campaign parent
  failed within seconds; Docker Desktop was also found stopped. The lane sync
  now checks out the main tree's `HEAD` first and the freeze aborts on any
  identity mismatch. Freeze 4 is void: it never produced a receipt on the frozen
  identity.

Each attempt's receipts remain exactly as its runs wrote them: a stale attempt
is superseded, never relabelled as a pass. `task-commit-allowlist.json` does not
stage the `qualified-attempt-*-stale-identity/` directories — see
`PACKAGING-NOTES.md`.

Independent and root review attestations belong in the parent `g4/` directory,
outside this checksum tree.
