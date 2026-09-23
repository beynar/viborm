# Release unit "perf" — re-measure performance and size on the release tree (brief)

Integrator: Fable. Worktree `/private/tmp/viborm-perf`, branch `release-perf` from
`36c87710a` (commit 30, the D-58 commit; the release tree). `TMPDIR=/private/tmp/viborm-perf-tmp`, always
exported. Note, review and receipts under
`docs/architecture/raptor3-evidence/g4/release/perf/`. This unit MEASURES;
it changes no production code. If a measurement shows a regression beyond
the accepted budget, it is reported with its profile as a blocker, not
repaired here.

## Read first

- `docs/architecture/raptor3-evidence/g4/cutover/protocol.md` (§2.1 the
  package seam both engines publish; the cells; the A/B method with
  `VIBORM_BENCH_ENGINE`), `docs/architecture/raptor3-evidence/g4/perf/note.md`
  and `g4/perf2/note.md` (the instruments: `prof-stage.mjs`, `gc-stage.mjs`,
  `analyze-stages.mjs`, the benchmark catalog `benchmarks/operation-pipeline-catalog.mjs`
  and fixtures), the D-9 record in the ledger (`g4.md`: 1.12× accepted on
  three cells; the plan §7 5 % budget) and the final report's
  "Performance, final" and "Size" paragraphs (`g4/final-report.md`).
- `package.json` `size-limit` budgets; `scripts/measure-raptor3-baseline.mjs`
  (`bundleProtocol`, `evidenceFootprint`).

## Required

1. **Performance A/B, the protocol's cells.** Baseline = the last tree
   where the OLD engine was the shipped one: `5a37bcd7` (commit 3), run
   with its default engine; candidate = this tree (`36c87710a`), where the
   shipped engine is Raptor 3. Same machine, same Node, interleaved runs,
   the protocol's repeat and precision rules; CPU and wall per cell, peak
   memory where the protocol measures it. Report each cell against the D-9
   acceptance (≤ 1.12× on the three accepted cells, ≤ 5 % elsewhere) and
   mark PASS / BLOCK / INCONCLUSIVE exactly as the protocol defines. The
   rulings added a D-26 integrity probe, D-29 premise placement, a schema
   run per JSON value (D-33) and the D-28 seam: name which cells they can
   touch and measure those first.
2. **Bundle size.** `pnpm size` on this tree (receipt), and the protocol's
   fixtures through `measure-raptor3-baseline.mjs`: the public PostgreSQL
   client fixture against the frozen baseline (target ≤ 1.00; commit 5
   measured 0.700) and the engine-only fixture, which the final report says
   still points at the pre-cutover candidate entry — re-point it to the
   shipped engine (a fixture path change only) and measure.
3. **Source size**, like for like: `src/query-engine/**` token lines
   against the old engine's 46,021 (the ledger's method), plus the census
   tool's own numbers.

## Rules (binding)

The twelve rules of `common.md`. No production code change. Scratch
copies for the baseline tree (`git worktree add --detach 5a37bcd7`, its own
`pnpm install` if the lockfile differs; say so).

## Verification

Every number in the note has a receipt file; interleaved runs are
recorded in order; the machine load during the runs is stated (no other
test lane running at the same time — coordinate through the integrator's
TMPDIR lock: run only when `/private/tmp/viborm-*-tmp` holds no other
lock).

## Deliverables

- `docs/architecture/raptor3-evidence/g4/release/perf/note.md` with the
  A/B table, the size table, the verdict per cell, the blockers (if any)
  with profiles.
- The reviewer writes `.../release/perf/review.md`: re-runs at least the
  three D-9 cells and one size fixture.
- Never commit, stage, reset, stash or push; never write outside the worktree.

## Integrator's additions (2026-09-20)

- The baseline worktree ALREADY EXISTS at `/private/tmp/viborm-perf-baseline`
  (detached at `5a37bcd7`, dependencies installed, the better-sqlite3 native
  binding built). Use it; do not create another baseline worktree. Its own
  `TMPDIR` is `/private/tmp/viborm-perf-baseline-tmp`.
- This tree (`36c87710a`) is commit 30: D-53, M1 and D-58 landed after the
  final report was written, so the D-58 boundary read-back (one SELECT more
  per dispatched unit that stored a produced value and is followed by
  another unit) is a candidate-only cost the A/B must name where a cell
  crosses a segment boundary.
- No other test lane is running on this machine during this unit; the
  integrator launches nothing else until the unit returns.
