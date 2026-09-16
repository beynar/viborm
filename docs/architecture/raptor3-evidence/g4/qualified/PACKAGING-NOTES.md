# Packaging notes (qualification attempt 6, performance-pass-2 identity)

- **What this seal contains.** 65 fixed modes (1,751 tests) + `g0` in lane 5;
  12 PostgreSQL and 11 MySQL native modes; 15 campaigns (265,000 cells /
  795,000 exact replays / 0 skips); 7 green replays, 9 stale refusals, 2
  not-a-replay-input entries and 2 byte-identical read-child reproductions;
  the 28-case structural measurement; 1,320 retained corpora
  (53,959,470,288 restored bytes from 1,048,570,233 archive bytes) plus 2
  compact G3P06 children and 9 compressed replay inputs; a 12-file source set
  with an 83,394-byte patch. The index's `gaps` list is empty.
- **Order actually run** (recorded in `support/retention-run.log`):
  `build-frozen-identity-manifest.mjs` (18:52, before the runs finished — it is
  read-only and it proved the live tree still equalled the freeze),
  `package-corpora.mjs` (20:27:20–20:28:29), `retain-corpora.mjs --move`
  (20:28:37–20:28:45), `audit-retained-corpora.mjs` (20:28:49–20:29:44),
  `package-corpora.mjs --reproductions` (20:30:07), then the source package
  (20:30), the index (20:31: derived unpinned, pinned, re-run with the assertion
  live), the prose and the seal. **Free disk was 27 GiB before and 28 GiB
  after** — against 48 GiB at the same point of attempt 5. (It had fallen
  further, to 21 GiB, by the time this seal was written; that is the concurrent
  cutover stage-2d measurement writing its own receipts, not this package, which
  released more than it took.) Nothing was unlinked
  before its restore was proven, and nothing that failed to verify was removed.
- **The two read-child reproductions** were not present when packaging began.
  This unit waited for the cutover timing series marker before any CPU-heavy
  step, and then for the reproductions, which the integrator's waiter ran in the
  main tree right after the series; they landed at 20:27 and
  `REPRODUCTIONS-COMPLETE` is the driver's marker for them. Had they not
  arrived, the index would have recorded each as a
  `pending-read-child-reproduction` gap; they were never assumed.

- **Frozen identity:** `g4/freeze/identity.json` = `support/final-identity.json`
  (production `312cde34…`, harness `1d4d913c…`), base commit `ff5e77ca`.
  Freeze 4 is void and freezes 1–3 and 5 are superseded; a receipt on any other
  identity is not this package's evidence. The freeze file must carry exactly
  `production`, `harness` and `runtime` — see the `capturedAt` incident below.
- **Attempt history.** Attempts 1, 2 and 4 are kept whole, unmodified and
  unrelabelled under `../qualified-attempt-{1,2,4}-stale-identity/`, and none of
  them contributes a count here. Attempts 3 and 5 are the packages this one
  supersedes: both are committed (`0f25637b` and `ff5e77ca`) and the integrator
  moved their files out of the tree, to
  `/private/tmp/viborm-g4-qualified-previous-123127/` and
  `/private/tmp/viborm-g4-qualified-previous-184446/`. Attempt 5's move showed
  as 9,798 evidence deletions when this packaging began; 8 survive as
  deletions now, because this attempt has since written almost all of those
  paths again as modifications.
- **The `capturedAt` incident is the integrator's, and it is in the report.**
  The structural measurement refused at 20:04 because `g4/freeze/identity.json`
  carried a capture timestamp the integrator had added for two concurrent
  agents' freshness check, and `cs02-structure-measure` parses that file with a
  strict schema. The fingerprints never moved. The annotation was removed, the
  group was re-run green at 20:06, and the refused attempt is kept whole as
  `structure-attempt1-red-tooling/`. This unit's `support/final-identity.json`
  was copied before the annotation existed and is byte-identical to the
  corrected freeze; `build-frozen-identity-manifest.mjs` re-derived both
  fingerprints from the live tree and they match.
- **Child receipts** of the campaign parents lived under
  `/private/tmp/viborm-g4-lane-tmp-N/` (each parent's `verified.json`
  `batches[].directory`). `retain-corpora.mjs --move` copied each into
  `campaigns/<mode>/seed-<first>.receipt/`, re-hashed the retained archive, and
  only then removed the lane copy. `package-corpora.mjs` had already proved each
  archive restores to its exact recorded bytes and SHA-256, and re-proved the
  1,200 archives the runner wrote itself rather than trusting their descriptors;
  it compressed the remaining 120 (G1 and G2 children).
- **Replays.** `replays/` holds the frozen-identity replays (the first child of
  each seeded family plus the three CS-03 parents) and the nine G3-era inputs as
  expected stale refusals (`*-stale.log`, exit 1). The two
  `*.not-a-replay-input.*` entries are by design — a G4 read corpus carries
  `subject` and the generic `replay` gate rejects unknown keys — and are NOT
  reds; `replays/NOTE.md` is the classification and
  `build-qualification-index.mjs` makes it from the gate's own sentence, not
  from the file name. `replays/FAILURES.log` is the driver's own record and is
  kept exactly as written.
- **Two checks were run twice; both keep both receipts.** The re-run takes the
  plain name the index builder reads, the first attempt keeps its bytes under an
  explicit suffix (`support/cli-selftest.attempt1-red.log`,
  `structure-attempt1-red-tooling/`). Nothing was overwritten. No qualifying
  mode, campaign or replay receipt was re-run, re-read or rewritten.
- **`support/provider-ports.json` is this unit's own capture, not the
  driver's.** The driver did not write it for attempt 6. Rather than repeat the
  previous package's numbers or leave the index with a
  `missing-support-evidence` gap that a real record could close, this unit ran
  `docker inspect` after the native groups and wrote the record with its
  provenance inside it: who captured it, when, and the `State.StartedAt` of both
  containers (2026-09-16T10:58Z, still running) that makes them continuous
  across both native groups. The report and `reproduction.md` say the same. This
  is the one file under `support/` that is not driver output.
- **Source cost was measured in lane 5 by design, not as a repair.** Attempt 5
  met `spawnSync git ENOBUFS` in the main tree and closed it with a re-run; this
  attempt's driver measures in the lane-5 worktree in the first place, and
  writes `support/source-cost-lane5-identity.json` beside the measurement so the
  worktree's identity is part of the evidence. `support/verify-support-receipts.mjs`
  re-derives both checks into `support/support-verification.json`: the lane
  identity equals the freeze, and all 581 files the census read appear in
  `support/frozen-identity-manifest.json` with the identical SHA-256 — 0 outside
  the identity, 0 differing. The tool was **not** patched; the one-option
  `maxBuffer` fix still belongs to the harness owner. There is therefore no
  `source-cost.attempt1-enobufs.log` in this package: no crash was produced.
- **The charged perimeter is this package's own measurement:** 171 files /
  2,518,074 bytes / 71,146 physical lines / **53,890 token-lines**, navigation
  subtotal 147 files / 47,710 token-lines, status
  `source-accounted-bundle-pending` (`bundles` and `declarationBytes` are
  `null`, so no bundle or package-size claim). That is the **shipped**
  perimeter; `src/query-engine/raptor3/**` is `excluded-experiment` in this
  accounting. The `charged` row equals attempt 5's field for field, and exactly
  four per-file entries differ — the four production files pass 2 changed,
  +88 token-lines. The pass-2 author and reviewer measured +82 on their own
  walk; the report states both and reconciles neither.
- **The pin was derived, not inherited.** `build-qualification-index.mjs`
  started this attempt with `PINNED_TOTALS = null`, because attempt 5's numbers
  are a different identity's. The totals were derived with `--derive` once every
  run was complete, written back into the script, and the index was rebuilt with
  the assertion live. One total moved: `fixedTestExecutions` 1,746 → 1,751, the
  five cells of `prepared-projection-reuse.test.ts`.
- **Structural measurement** is under `structure/` (attempt 3 spelled the same
  directory `structural-measurement/`; the index reads whichever exists and
  records the path it read).
- **Open decisions for Arnaud**, not blockers of this package: D-9 (the accepted
  preparation cost) and D-10 (the cutover scope) are taken; nothing in this
  package waits on them, and no performance receipt is claimed here.
- **The commit allowlist is re-derived over the final evidence tree**, and it is
  derived from `git status`, not from a directory walk: the evidence half is
  everything **dirty or untracked** under `docs/architecture/raptor3-evidence/g4.md`
  and `docs/architecture/raptor3-evidence/g4/`, which is exactly what a commit
  can stage. A file under `g4/` that is committed and unchanged is absent by
  construction — a commit has nothing to stage for it.

  **10,118 exact paths = 12 source files + 10,098 evidence paths
  (9,763 modified, 335 untracked) + 8 deletions**, as
  `git status` reported the tree at 20:43 on 2026-09-16, when this seal
  was taken. That is a snapshot of a tree two other units were still writing to:
  the cutover stage-2d measurement was appending receipts under `g4/cutover/`
  and the integrator was editing `g4.md`, `g4/final-report.md` and
  `g4/cutover-proposal.md` while this package was being sealed. This unit waited
  until those paths had been unchanged for two and a half minutes before sealing
  and then checked the list in both directions, but a receipt written after
  20:43 is not in it — the integrator re-derives the allowlist with
  `seal-author-package.mjs --allowlist-only` before staging if anything has
  landed since.
  Performance pass 2's own evidence is in: `g4/perf2/**` contributes its note,
  its patch and its receipts, alongside `g4/perf2-review.md` and
  `g4/perf2-review-followup.md`; the cutover stage-2d receipts and the proposal
  under `g4/cutover/` are in; `g4/final-report.md` and the ledger `g4.md` are in.
  The deletions are what attempt 5 had and this package does not — the
  gap-closure apparatus of attempt 5's two support re-runs (`support/RERUN.md`,
  `support/rerun-*.{json,log,sh}`, `support/verify-rerun-receipts.mjs` and
  `support/source-cost.attempt1-enobufs.log`), which attempt 6 does not need
  because it measured in lane 5 up front and re-ran the CLI self-test through
  the sequencer.

  **138 files inside `qualified/` are sealed by `SHA256SUMS` and absent from the
  allowlist**, and that is the allowlist's dirty-or-untracked rule working rather
  than a gap in it: each is byte-identical to what `ff5e77ca` already committed
  at that path, so `git status` reports it clean and the commit has nothing to
  stage for it. They are the deterministic files — the 122 `generated-campaign.json`
  descriptors of the G1, G2 and G3P06 children (a pure function of the seed
  range, batch size and profiles), the four zero-byte markers and empty logs
  (`RUNS-COMPLETE`, `REPRODUCTIONS-COMPLETE`, `post.out`,
  `support/source-cost.log`), `replays/FAILURES.log` (the same two
  by-construction refusals as attempt 5, line for line), the structural
  measurement's patch and case lists, and the five support scripts this unit
  reused from attempt 5 without needing to change them
  (`audit-retained-corpora.mjs`, `build-frozen-identity-manifest.mjs`,
  `campaign-retention.mjs`, `package-corpora.mjs`, `retain-corpora.mjs`).

  The list was checked **in both directions** against
  `git status --porcelain=v1 -uall`: no allowlisted path is clean, and no dirty
  or untracked path under the two pathspecs is missing. The 1,264 dirty
  paths outside the two halves are all excluded and are named in
  `knownExcludedDirty`: `CONTEXT.md`, `memory.md`, the two `tests/pattern/`
  files (`pack/program-dump.ts` modified, `match/decode-malformed.core.test.ts`
  untracked), `exa-results/`, the eight root `transport-*-corpus.json` files,
  `docs/architecture/raptor3-g4-claude-handoff.md`, and the pre-G4 evidence —
  the `g3/` and `g3-prep-*/` trees and the loose archives. The pending review
  attestations still do not exist and are still added separately, outside this
  checksum tree. Everything inside `qualified/` is closed and sealed by
  `SHA256SUMS`.
- **Do not commit or stage.** `task-commit-allowlist.json` is a list for the
  integrator, not an action taken here. Review attestations belong in the parent
  `g4/` directory, outside this checksum tree.
