# Packaging notes (qualification attempt 5, performance-pass identity)

- **What this seal contains.** 65 fixed modes (1,746 tests) + `g0` in lane 5;
  12 PostgreSQL and 11 MySQL native modes; 15 campaigns (265,000 cells /
  795,000 exact replays / 0 skips); 7 green replays, 9 stale refusals, 2
  not-a-replay-input entries and 2 byte-identical read-child reproductions;
  the 28-case structural measurement; 1,320 retained corpora
  (53,981,235,232 restored bytes from 1,049,645,275 archive bytes) plus 2
  compact G3P06 children and 9 compressed replay inputs; a 20-file source set
  with an 85,771-byte patch. The two support gaps the 16:15 seal carried were
  re-run green at 16:17–16:21 and are closed — see below; the index now has an
  empty `gaps` list.
- **Order actually run** (recorded in `support/retention-run.log`):
  `package-corpora.mjs` (16:04–16:06), `retain-corpora.mjs --move`
  (16:06–16:07), `audit-retained-corpora.mjs` (16:07–16:08),
  `package-corpora.mjs --reproductions` (16:09), then the source package, the
  index, the prose and the seal (16:15). Free disk was 48 GiB before and 50 GiB
  after. The gap closure then ran on the same tree: the integrator's two
  re-runs (16:17–16:21, `support/rerun-RUN.log`), the receipts placed beside the
  kept reds, `verify-rerun-receipts.mjs`, the prose, the index derived unpinned
  and re-pinned, and `seal-author-package.mjs` again for the allowlist,
  `retained-files.json` and `SHA256SUMS`.
- **The two read-child reproductions** were already present at 16:04, run by
  the integrator in the main tree immediately after the cutover timing series
  finished; no polling window was needed.

- **Frozen identity:** `g4/freeze/identity.json` = `support/final-identity.json`
  (production `2e92354b…`, harness `31c2883f…`), base commit `0f25637b`.
  Freeze 4 (12:31) is void and freezes 1–3 are superseded; a receipt on any
  other identity is not this package's evidence.
- **Attempt history.** Attempts 1, 2 and 4 are kept whole, unmodified and
  unrelabelled under `../qualified-attempt-{1,2,4}-stale-identity/`, and none of
  them contributes a count here. Attempt 3 is the package this one replaces: it
  is committed in `0f25637b` and the integrator moved its files out of the tree
  to `/private/tmp/viborm-g4-qualified-previous-123127/`. That move showed as
  9,743 evidence deletions when packaging began — the reason
  `measure-raptor3-baseline.mjs` overflowed its `git status` buffer — and 13
  survive as deletions now, because this attempt has since written almost all of
  those paths again as modifications.
- **Attempt 4 is now in `task-commit-allowlist.json`** — the integrator's
  decision, taken after the 16:15 seal. Its 168 untracked files are the launch
  abort's tooling-only receipts, of runs that never reached the frozen identity,
  and the ledger references them as exactly that; committing them keeps the
  reference resolvable. Attempts 1 and 2 are committed in `0f25637b` and
  unchanged, so `git status` reports nothing for them and the allowlist lists
  nothing for them — the seal script asserts that rather than assuming it, and
  fails if either turns dirty. Every attempt directory stays whole on disk
  either way.
- **Child receipts** of the campaign parents lived under
  `/private/tmp/viborm-g4-lane-tmp-N/` (each parent's `verified.json`
  `batches[].directory`). `retain-corpora.mjs --move` copied each into
  `campaigns/<mode>/seed-<first>.receipt/`, re-hashed the retained archive, and
  only then removed the lane copy. `package-corpora.mjs` had already proved each
  archive restores to its exact recorded bytes and SHA-256, and re-proved the
  archives the runner wrote itself rather than trusting their descriptors.
- **Replays.** `replays/` holds the frozen-identity replays (the first child of
  each seeded family plus the three CS-03 parents) and the nine G3-era inputs as
  expected stale refusals (`*-stale.log`, exit 1). The two
  `*.not-a-replay-input.*` entries are by design — a G4 read corpus carries
  `subject` and the generic `replay` gate rejects unknown keys — and are NOT
  reds; `replays/NOTE.md` is the classification and
  `build-qualification-index.mjs` makes it from the gate's own sentence, not
  from the file name. `replays/FAILURES.log` is the driver's own record and is
  kept exactly as written.
- **The two support gaps of the 16:15 seal, re-run green** (full account in
  `support/RERUN.md`; neither was ever a candidate failure):
  1. `support/cli-selftest.log` — **10 of 10** on the re-run, alone in the main
     tree on the quiet machine after the cutover series released it (240.41 s
     wall, 211.0 MiB peak RSS; the cell that failed took 10.46 s against 17.99 s
     under six live lanes). The 9-of-10 first attempt is kept whole as
     `support/cli-selftest.attempt1-red.log`.
  2. `support/source-cost.json` — **measured**, exit 0, in the lane-5 worktree.
     `measure-raptor3-baseline.mjs` still dies in the main tree with
     `spawnSync git ENOBUFS` (its `git status --porcelain` at line 318 exceeds
     Node's default 1 MiB `maxBuffer`); the tool was **not** patched and the
     one-option fix still belongs to the harness owner. Lane 5's own status
     output is small, and the measurement is proved to be on the frozen bytes
     twice over: lane 5's `captureRaptor3Identity()` equals the freeze
     (`support/rerun-lane5-identity.json`) and all 581 files the census read
     match `support/frozen-identity-manifest.json` by SHA-256, 0 outside the
     identity and 0 differing. The crash log is kept as
     `support/source-cost.attempt1-enobufs.log`;
     `support/verify-rerun-receipts.mjs` re-derives both checks into
     `support/rerun-verification.json`.
- **A support check run twice keeps both receipts.** The re-run takes the plain
  name the index builder reads; the first attempt keeps its bytes under an
  explicit suffix. Nothing was overwritten, and no qualifying receipt was
  re-run, re-read or rewritten — the pinned totals in
  `build-qualification-index.mjs` are unchanged and still assert.
- **The charged perimeter is now this package's own measurement:** 171 files /
  2,518,074 bytes / 71,146 physical lines / **53,890 token-lines**, navigation
  subtotal 147 files / 47,710 token-lines, status
  `source-accounted-bundle-pending` (`bundles` and `declarationBytes` are
  `null`, so no bundle or package-size claim). That is the **shipped**
  perimeter: `src/query-engine/raptor3/**` is `excluded-experiment` in this
  accounting, so the candidate's own 14,680 token-lines is still root review D's
  number, not re-measured here.
- **Structural measurement** is under `structure/` (the previous package spelled
  the same directory `structural-measurement/`; the index reads whichever
  exists and records the path it read).
- **Open decisions for Arnaud**, not blockers of this package: D-7.1, D-8 and
  R-D3-class are decided (see the ledger); nothing in this package waits on
  them.
- **The commit allowlist is re-derived over the final evidence tree**, and it is
  now derived from `git status`, not from a directory walk: the evidence half is
  everything **dirty or untracked** under `docs/architecture/raptor3-evidence/g4.md`
  and `docs/architecture/raptor3-evidence/g4/`, which is exactly what a commit
  can stage. A file under `g4/` that is committed and unchanged is absent by
  construction — a commit has nothing to stage for it — where the 16:15 walk had
  listed about 2,700 such no-op paths.

  **10,341 exact paths = 20 source files + 10,308 evidence paths (9,755
  modified, 553 untracked) + 13 deletions.** The stage-2c work that was still in
  flight at 16:15 is in: `g4/cutover/**` contributes 222 paths, 204 of them the
  `receipts-stage2c/` receipts, alongside the proposal and the note;
  `g4/final-report.md` is in; `g4/qualified-attempt-4-stale-identity/`
  contributes its 168. The 13 deletions are what attempt 3 had and this package
  does not — the `structural-measurement/` directory, which this attempt's driver
  writes as `structure/`. `support/source-cost.json` was a fourteenth deletion at
  16:15 and is now a measured file again. One file inside `qualified/` is sealed
  by `SHA256SUMS` and absent from the allowlist: `support/source-cost.log`, the
  re-run's own empty stdout, is byte-identical to the empty log `0f25637b`
  already committed at that path, so it is clean and there is nothing to stage
  for it.

  The list was checked **in both directions** against
  `git status --porcelain=v1 -uall`: no allowlisted path is clean, and no dirty
  or untracked path under the two pathspecs is missing. The 1,264 dirty paths
  outside the two halves are all excluded and are named in `knownExcludedDirty`:
  `CONTEXT.md`, `memory.md`, two `tests/pattern/` files, `exa-results/`, the
  eight root `transport-*-corpus.json` files,
  `docs/architecture/raptor3-g4-claude-handoff.md`, and the pre-G4 evidence —
  the `g3/` and `g3-prep-*/` trees and the loose archives. The pending review
  attestations still do not exist and are still added separately, outside this
  checksum tree. Everything inside `qualified/` is closed and sealed by
  `SHA256SUMS`.
- **Do not commit or stage.** `task-commit-allowlist.json` is a list for the
  integrator, not an action taken here. Review attestations belong in the parent
  `g4/` directory, outside this checksum tree.
