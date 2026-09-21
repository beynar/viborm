# The final local release record

This directory is the checkpoint the closure handoff §6 item 2 asks for: the
retained, source-bound evidence for the LOCAL release verdict of the tree the
units R1–R4 produce. It is not a relabelling of an earlier run. The historical
receipts under `g4/release/closure/`, `g4/release/perf/` and `g4/qualified/`
keep their own identities and their own dates; nothing here rewrites them and
nothing there is counted as a campaign run on this tree.

Each unit owns `‹unit›/note.md` and `‹unit›/receipts/`. The integrator owns
`index.md` / `index.json` at this level, assembled after the frozen gate.

## What the index contains

`scripts/closure-final-index.mjs` assembles it from a directory of gate logs.
It measures nothing itself; every number it prints was produced by an existing
reader and is quoted.

1. **Source identity.** The gate commit, the one-line head, the working tree at
   assembly, and the `calibrationSourceIdentity` hash — the existing calibration
   owner over `src/`, `benchmarks/`, `scripts/`, `package.json`,
   `pnpm-lock.yaml`, `tsconfig.json`, `tsdown.config.ts` and `biome.jsonc`.
   **Addendum (2026-09-21, after the review of `bc18b4e23`).** It also records
   the Git TREE object ids of the commit and of `src`, `tests`, `scripts` and
   `benchmarks`, the sha256 of the config and lockfiles, and the identity of
   each retained review directory beside the checkpoint — the bare
   `closure-review` and any `closure-review-<sha>` a later round leaves. Each
   digest is printed with its own scope AND algorithm: a Git object id is
   SHA-1 over a tree object and a file digest is sha256 over bytes, and
   neither is the other's harness identity. The tree ids are what support "the
   squash carries the same `src`"; the manifest digest of item 2 does not reach
   a native entry file or an imported fixture.
2. **Harness identity.** Every test file any registered manifest names, hashed
   file by file into one digest, plus the sha256 of each manifest module. A
   gate is only as identified as the harness that ran it, and
   `calibrationSourceIdentity` does not reach `tests/`. A path a manifest names
   that is absent from the tree is listed, never silently dropped.
3. **Runtime and dependency identity.** Node and V8, platform and architecture,
   `pnpm --version`, the `packageManager` field, and the sha256 of
   `pnpm-lock.yaml` and `package.json`. The frozen gate runs on Node
   **24.21.0** and the pinned dependencies.
4. **Each gate stage.** Its raw log (copied verbatim into `logs/`, with the
   log's own sha256), its recorded exit code, the vitest `Test Files` / `Tests`
   lines, and the resource/teardown sentence the bounded launchers print. The
   exit codes come from the gate's own `summary.log` (`=== ‹stage›` followed by
   `exit=‹n›`, the stage name being the whole line after `===`, so a multi-word
   stage such as `native mysql2 (docker)` keeps its code); a stage with no
   recorded code is reported as `unrecorded`, never as zero, and a code recorded
   under a name no `‹stage›.log` carries is listed under **summary stages with
   no log** rather than dropped or attached to a neighbour. `summary.log` is
   those codes' owner, not a stage of its own.
5. **The manifests.** Every registered test list with its file count, and every
   declared-cell map with its cell total, read from the manifest modules
   themselves.
   **Addendum (2026-09-21, after the review of `bc18b4e23`).** Section 5 now
   leads with what each VITEST PROJECT registers, derived by
   `scripts/closure-final-inventory.mjs` from `vitest.workspace.ts`'s own
   include patterns, and with the gate plan those lists imply. A manifest list
   counts the paths a manifest names; a project list is what a gate stage must
   run, and the two differ — this gate ran eleven of `provider-mysql2`'s
   thirteen files because it globbed the directory instead of reading the
   project. The same section keeps project EXECUTIONS and declared CELLS in
   separate columns, because a file registered in two projects executes twice
   and its cells are then counted twice in a stage's `Tests` total.
6. **The bundle table.** From `scripts/measure-raptor3-baseline.mjs --bundle`
   run on the final source. The engine and public PostgreSQL fixture ratios of
   the release tree (0.646 and 0.735) are HISTORICAL until a new measurement on
   this tree supports them; source size is reported separately from bundle size.
7. **The LOC table.** From `scripts/closure-final-recount.mjs`, which groups the
   same reader's answer into the charged perimeter and the per-unit diffs.

## Producing it

```sh
# 0. what the gate must run, before it runs: every stage and file, both
#    provider projects' complete registered lists, any test file no project
#    registers, and — per project — which stages cover its registered files.
#    Reads the tree, runs nothing, needs no credentials.
node scripts/closure-final-inventory.mjs plan
node scripts/closure-final-inventory.mjs providers

# 1. source and bundles, on the frozen source
node scripts/run-node-safe.mjs 3072 600000 \
  scripts/measure-raptor3-baseline.mjs --bundle \
  --output docs/architecture/raptor3-evidence/g4/release/closure-final/source-size-final.json

# 2. the public package fixtures
pnpm package:build && pnpm size

# 3. the recount and the per-unit charged-perimeter diffs
node scripts/closure-final-recount.mjs \
  --out docs/architecture/raptor3-evidence/g4/release/closure-final/recount \
  --measurement docs/architecture/raptor3-evidence/g4/release/closure-final/source-size-final.json \
  --unit r1=cdd787ac8..<r1 tip> \
  --unit r2=cdd787ac8..<r2 tip> \
  --unit r3=cdd787ac8..<r3 tip> \
  --unit r4=cdd787ac8..<r4 tip> \
  --unit checkpoint=cdd787ac8..HEAD

# 4. the index over the gate's logs
node scripts/closure-final-index.mjs \
  --gate <the gate log directory> \
  --out docs/architecture/raptor3-evidence/g4/release/closure-final \
  --measurement docs/architecture/raptor3-evidence/g4/release/closure-final/source-size-final.json \
  --recount docs/architecture/raptor3-evidence/g4/release/closure-final/recount/recount.json \
  --label "local closure"
```

Step 3's ratio table divides by the recorded old-engine denominators, which are
quoted rather than recomputed: the revisions they name no longer carry that
engine. The bundle RATIOS of step 1 need the frozen bundle baseline
`docs/architecture/raptor3-evidence/baseline.json` (commit `3a291a59`), which is
UNTRACKED and lives only in the primary worktree; `measure-raptor3-baseline.mjs`
produces the final tree's own bundle bytes without it, and the ratio against the
baseline is computed where that file is readable.

If the source changes after a gate stage runs, that stage's proof is invalid:
rerun it and re-assemble the index before finalising the manifest.
