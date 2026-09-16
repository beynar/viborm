# The two support re-runs (16:17–16:21, 2026-09-16)

The package sealed at 16:15 with index status
`author-qualification-evidence-incomplete-see-gaps` and two `gaps` entries, both
support checks and neither a candidate failure. Both were re-run on the
**unchanged frozen tree** and both are green, so this seal carries no gap. The
red first attempts are kept beside the new receipts, renamed, not overwritten.

| | first attempt (13:26, red) | re-run (16:17–16:21, green) |
| --- | --- | --- |
| CLI self-test | `cli-selftest.attempt1-red.log` — 9 of 10 | `cli-selftest.log` — **10 of 10** |
| Source cost | `source-cost.attempt1-enobufs.log` — crashed, no JSON | `source-cost.json` + `source-cost.log` — **exit 0** |

`rerun-RUN.log` is the integrator's own record of the two runs with their exit
codes and times; `rerun.sh` is the script that produced them.

## What was re-run, where, when, why

**1. The CLI self-test — in the main tree `/Users/arnaud/code/viborm`, alone, on
the quiet machine. Started 16:17:27, exit 0 at 16:21:28.**

```sh
node scripts/run-node-safe.mjs --rss-limit-mb=1536 768 600000 scripts/raptor3-cli.test.mjs
```

Why: the 13:26 run was 9 of 10. Its one red, "the outer watchdog terminates a
public call awaiting a queued provider reply", is a watchdog race against a real
process reaching its wait, and it ran while all six campaign lanes were live; it
saw only the Vitest banner after 17.99 s. The packaging classified that as
machine load but did **not** re-run it, because the cutover timing series owned
the machine. The series finished at 16:04, so the cell could finally be settled
the only way that settles it: re-running the file alone on an idle machine.

Result: 10 of 10, 239.9 s of test time, 240.41 s wall, 211.0 MiB peak sampled
process-group RSS against the same 1,536 MiB ceiling, teardown verified. The
cell that failed passed in 10.46 s (it had passed in 16.66 s on attempt 3's
quieter machine and failed at 17.99 s under lane load). Every timing in the
re-run is a fraction of the loaded run's — the same file took 460.04 s wall at
13:26 and 240.41 s here — which is the load itself, measured.

**2. The source-cost measurement — in the lane-5 worktree
`/private/tmp/viborm-g4-lane-5`, `TMPDIR=/private/tmp/viborm-g4-lane-tmp-5`.
Started 16:17:27, exit 0 at 16:17:29.**

```sh
cd /private/tmp/viborm-g4-lane-5
TMPDIR=/private/tmp/viborm-g4-lane-tmp-5 \
  node scripts/measure-raptor3-baseline.mjs --output <scratchpad>/source-cost.json
```

Why in a different worktree: gap 2 *was* the main tree. The tool calls
`execFileSync("git", ["status", "--porcelain"])` at
`scripts/measure-raptor3-baseline.mjs:318` with Node's default 1 MiB
`maxBuffer`, and the main tree's status output is over 1.2 MB because the
moved-out attempt-3 package shows as thousands of evidence paths — so the tool
died with `spawnSync git ENOBUFS` before writing anything. Lane 5 is a worktree
of the same repository whose own status output is small. The measurement was
**not** retaken with a patched copy of the tool: the fix to that `maxBuffer`
still belongs to the harness owner, and the number here is the frozen harness's
own unmodified output.

Running it elsewhere is only sound if the bytes it read are the frozen bytes, so
this is checked twice over, and `verify-rerun-receipts.mjs` re-derives both
checks into `rerun-verification.json`:

- **The lane's identity.** `rerun-lane5-identity.json` is
  `captureRaptor3Identity()` taken from lane 5's *own* copy of
  `scripts/raptor3-manifest.mjs` (its `RAPTOR3_ROOT` resolves from the module's
  URL, so the fingerprints are lane 5's files). It equals
  `g4/freeze/identity.json` — production `2e92354b…`, harness `31c2883f…`. The
  integrator had verified the same equality at 16:18.
- **Every file the census actually read.** All **581** files in
  `source-cost.json#files` appear in `frozen-identity-manifest.json` with the
  **identical SHA-256**: 0 outside the identity, 0 differing from the freeze. The
  tool's own attestation (`source.sourceIdentity`, 658 files) likewise matches
  the freeze on all but `biome.jsonc` and `tsdown.config.ts`, which
  `captureRaptor3Identity` does not hash at all.

`source.commit` is `0f25637b` and `source.clean` is `false`, exactly as in the
main tree — and `source.clean` is the only value that failed call fed.

`source-cost.log` is the re-run's own stdout and stderr and is **empty (0
bytes)**: on success the tool writes its JSON to `--output` and prints nothing.
The 23,155-byte `source-cost.attempt1-enobufs.log` is the crash, kept whole.

One consequence is worth naming, because it looks like an omission and is not:
`support/source-cost.log` is the one file in this package that `SHA256SUMS`
covers and `task-commit-allowlist.json` does not list. Attempt 3's run of the
same tool also succeeded and also printed nothing, so the empty file is
byte-identical to what `0f25637b` already committed at that path
(SHA-256 `e3b0c442…`, the hash of zero bytes); `git status` reports it clean and
the commit has nothing to stage for it. That is the allowlist's rule — dirty or
untracked only — working, not a gap in it.

## What the measurement says

`support/source-cost.json`, status `source-accounted-bundle-pending` — the
source accounting is complete and the bundle half is not attempted, so
`bundles` and `declarationBytes` are `null`. Census owner
`scripts/query-engine-structure.mjs`, census function SHA-256 `15889231…`.

| `accounting` | files | bytes | physical lines | token-lines |
| --- | --- | --- | --- | --- |
| **charged (the shipped perimeter)** | **171** | **2,518,074** | **71,146** | **53,890** |
| navigation subtotal | 147 | 2,201,864 | 62,274 | 47,710 |

This is the **shipped** perimeter — the denominator. The candidate engine's own
files are not in it: `src/query-engine/raptor3/**` is classified
`excluded-experiment` (35 files, 22,522 token-lines) by this accounting, so the
complete-charged-**candidate** number is still root review D's measurement and
was not re-measured here.

Two cross-checks the re-run makes possible:

- **It reproduces attempt 3's census field for field.** `accounting.charged` is
  byte-for-byte the same four numbers attempt 3 measured at `0cc61e61`
  (`/private/tmp/viborm-g4-qualified-previous-123127/support/source-cost.json`),
  which is what must happen when the performance pass touched only
  `excluded-experiment` files.
- **Exactly seven per-file entries differ from attempt 3's**, all of them the
  performance pass's `src/query-engine/raptor3/*.ts` files —
  `commands/commands.ts` 1,225 → 1,226, `commands/execution.ts` 754 → 756,
  `commands/relation-body.ts` 867 → 874, `commands/selection.ts` 162 → 163,
  `shared/operation-context.ts` 1,892 → 1,898, `shared/query.ts` 3,568 → 3,572,
  `shared/schema.ts` 410 → 411 — summing 8,878 → 8,900, **+22 token-lines**.
  That is the same +22 the performance review measured independently on the
  181-file whole-query-engine census
  (`../../perf-review-followup.md` note 6). The eighth changed file,
  `src/query-engine/raptor3/AGENTS.md`, is not TypeScript and carries no census
  entry.

Root review D used **53,787** token-lines / 70,983 physical / 2,511,682 bytes as
its denominator, measured by that review's own walk, and reported the candidate
at 27.3 % / 25.9 % / 26.1 %. Against this tool's own measured perimeter the same
candidate totals (14,680 / 18,378 / 655,283) are **27.2 % / 25.8 % / 26.0 %** —
still inside the ≤ 60 % token and ≤ 70 % physical targets. This package states
its measured denominator and does not attempt to reconcile the 103-token-line
difference between the two walks; the numerator remains D's, measured on the
predecessor tree.

## What this re-run does not change

Nothing in the qualifying evidence. No mode, campaign, replay, structural or
corpus receipt was re-run, re-read or rewritten: the pinned totals in
`build-qualification-index.mjs` are unchanged and still assert. What changed is
the two support entries and, through them, the index status — from
`author-qualification-evidence-incomplete-see-gaps` to a complete index with an
empty `gaps` list. The main tree's identity was re-captured after the re-runs
(`rerun-main-tree-identity.json`) and equals the freeze, so the tree these
receipts describe is still the tree that was frozen.
