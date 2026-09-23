# G4-04 qualification plan (opening revision, 2026-09-14)

This plan schedules the closure inventory. It is not evidence. Every run
executes on one frozen identity recorded in `g4/qualified/support/final-identity.json`,
serially, with existing runners and ceilings.

## Order (plan §6.3)

1. Root integrated code/ownership review on the frozen source (before any
   expensive run): combined diff of G4-01/02/03, semantic ownership and
   deletions, witnesses, cost inventory. Findings are repaired and affected
   paths revalidated; then the exact identity is recorded.
2. Short output/reporter check: one fixed mode and one 1-seed batch of each
   G4 campaign family, confirming receipt paths, compact summaries and gzip
   archiving before long runs.
3. Full inventory, serially:
   - Every registered fixed mode (all 42 G3 modes plus every G4 mode),
     `node scripts/run-raptor3.mjs <mode>`; save each receipt directory.
   - PGlite selector (`run-credential-free-tests.mjs --only "raptor3-provider:"`)
     and the credential-free fixed selector (`--only "Raptor 3 fixed"`).
   - Native PostgreSQL and MySQL modes (all G2/G25/G27/G3P/G3 native modes
     plus G4 native modes) — **blocked until a provider answers**; blocked
     runs keep their refusal receipts and cannot be relabeled.
   - Campaigns: `g4-seeds` (seeds 20000–44999, two SQLite profiles, 250
     children) and `g4-transport-seeds` (seeds 50000–74999, two transport
     profiles, 250 children), each child ≤ 100 seeds, ≤ 120 s, three replays,
     per-child gzip archive verified against restored bytes/hash before the
     raw corpus is unlinked; inherited G3 campaigns rerun on the frozen
     identity (`g3-seeds`, `g3-transport-seeds`, `g3p06-*`, `g2-*`, `g1-*`,
     `g0`, `cs03-*`) because source changed.
   - Saved replays: the retained current corpora plus two stale-identity
     refusals.
   - Receipt self-tests, CLI integrity, driver-integration files, structural
     measurement (isolated worktree), typecheck, structure census, source
     cost, bundle fixtures.
   - Performance: `benchmarks/operation-pipeline-compare.mjs` over the 20
     frozen cells (nine workloads), five alternating fresh-process pairs per
     cell, baseline = clean worktree at the last accepted shipped-engine
     commit, candidate = clean isolated worktree at a task-local measurement
     commit with the cutover applied (candidate-only package). Budgets: 5 %
     time, 10 % peak memory, `E = 2 × max(MAD)`; one full repeat for an
     inconclusive cell; unresolved after repeat blocks adoption.
4. Close the same root review against the evidence: identities, counts,
   provider results, raw artifacts, costs, checksums; write the adoption
   recommendation and the shortfall review if any size target is missed.

## Campaign families at closure (revised after the witness review)

The witness review found that the G4 read campaign's four profile names do
not distinguish behavior for reads. The honest closure inventory is therefore:

1. `g4-seeds` / `g4-transport-seeds` — the read/projection/codec generator on
   the profiles the witness repair keeps as genuinely distinct (the repair
   either builds real transport models or halves the lists); 25,000 seeds per
   retained profile, candidate subject only, subject owned and recorded by the
   runner.
2. A **write envelope campaign on new seeds**: the accepted G3 generator
   (C08–C11, actual actor/fault quotas) over a fresh disjoint range on all four
   G3 profiles, registered by the integrator as `g4-write-seeds` /
   `g4-write-transport-seeds` (data-only manifest entries reusing
   `assertG3GeneratedBatchReceipt` with the new campaign constant). The
   candidate's write path consumes the changed selector/projection/codec
   owners, so new seeds through the write generator are required evidence, not
   a rerun of accepted G3 receipts. Proposed range: 75000–99999 (SQLite
   family) and 100000–124999 (transport family).
3. Inherited G3/G2/G1/G0/CS-03 campaigns rerun on the frozen identity.

## Resource estimates (from G3 receipts)

| Item | G3 measurement | G4 projection |
| --- | --- | --- |
| One 100-seed child corpus | 78.7 MB raw → 1.39 MB gzip; parent campaign of 100 children verified in ~15 min | 500 children ≈ 700 MB archives, ~80 MB transient raw at any time, ~75 min per family if per-child cost holds (G4 read recipes may differ; measure the first child) |
| Whole typecheck | 25 s, 4.5 GB RSS | same |
| Fixed modes | 42 modes / 1,137 tests | plus G4 modes |
| Performance series | 40 workers for 4 series in G0 | 200 workers for 20 cells; plus repeats |

Free disk at opening: 21 GiB. Re-check before campaigns and before the
performance series (build artifacts in two worktrees).

## Blockers carried

- Native providers unavailable (Docker Desktop cannot start). Every native
  mode is blocked; the gate cannot PASS without them.
