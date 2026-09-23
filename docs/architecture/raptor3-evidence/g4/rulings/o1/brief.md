# D-39 + D-41 — the canonical-surface check, and the short-window pin (brief)

Integrator: Fable. Worktree `/private/tmp/viborm-o1`, branch `o1` from `383f830c`
(commit 10, the docs commit after D-35). `TMPDIR=/private/tmp/viborm-o1-tmp`,
always exported. The worktree is the only write target; the note, the review
and the receipts live inside it under `docs/architecture/raptor3-evidence/g4/rulings/o1/`.

## Read first

- `docs/architecture/raptor3-evidence/g4/rulings/d35/note.md` and
  `docs/architecture/raptor3-evidence/g4/rulings/d35/review.md` (observation
  O-1) and `review-round2.md`; `docs/architecture/raptor3-evidence/g4/rulings/review-round2.md`
  (the rulings unit's re-check: the short-window probe, receipts
  `r2-probe-shortwindow-*.log`, the recipe near line 81-90 and the table row
  near line 199).
- `docs/architecture/raptor3-evidence/g4/briefs/common.md` (the twelve rules,
  binding) and `src/query-engine/raptor3/AGENTS.md`.
- The ledger `docs/architecture/raptor3-evidence/g4.md`, record "Rulings by
  Arnaud (23:40, 2026-09-17)": D-39 and D-41.

## D-39 — a driver's result surface is stock only when it IS the shipped parser

Facts. `SQLite3Driver.hasCanonicalProducerSurface` (`src/drivers/sqlite3/index.ts:224-232`)
compares `driver.result.parseResult` to `canonicalDriverParseResult` (`:86`,
now `undefined` since D-35 deleted the arm) and the adapter's `parseResult`
to `canonicalAdapterParseResult` (`:103`). Since D-35 the first leg accepts
any middleware that merely lacks a `parseResult`, including a user-installed
`{ parseField }` middleware. `PGliteDriver.hasCanonicalProducerSurface`
(`src/drivers/pglite/index.ts:227-233`) has the same shape. Both feed the
consumable-result mechanism (`src/drivers/consumable-result-candidate.ts`),
which has no caller in `src/` today; its proof test is
`tests/contracts/drivers/consumable-result-proof.core.test.ts`, which D-35
gave a cell that pins the SQLite check discriminating a middleware-carrying
driver. Read why the check exists (root `AGENTS.md` rule 5, quoted in the
D-35 note) before touching it.

Arnaud's ruling: strengthen it now, for the SQLite and PGlite families
together — a driver instance's result surface is stock only when its
`result` is the shipped parser object itself (identity), the adapter leg
kept as it is.

Required. One rule, stated once per family at its owner, no per-arm
comparisons and no policy boolean; if the two drivers can share the
statement without a wrapper-only abstraction, say so and do it, otherwise
say why not. Pins, per family, in `consumable-result-proof.core.test.ts` or
beside it: the stock instance is stock; an instance with a field-only
middleware is not; an instance whose adapter parseResult was replaced is
not. Falsification: weaken the leg back to the per-arm comparison in a
scratch copy (`git worktree add --detach`) and the field-only cell reddens;
restore from a scratchpad copy, never `git checkout --` a dirty file.

## D-41 — the short-window pin

Facts. Since the rulings unit's repair (`Queries.assertExpectedRows`, asked
per window at `OperationContext.publishedTerminal`), a chunked non-RETURNING
terminal read whose second window answers one row short raises createMany's
registered refusal sentence instead of the internal "inconsistent row
counts" invariant. The re-checker measured it (`review-round2.md`, receipts
`r2-probe-shortwindow-repaired.log`, `r2-probe-shortwindow-at-e821cd21a.log`)
and left the recipe: a driver whose second terminal window drops one row,
with `maxBindParametersPerStatement` lowered so createMany with `select`
spans several windows (`RecordingSQLiteDriver` allows it; see cell 5 of
`tests/raptor3/g4/parity/driver-result-parser.test.ts`, the chunked-terminal
cell).

Required. One cell beside cell 5 of `driver-result-parser.test.ts`,
expecting the registered sentence (find it in the estate's error registry,
never invent it) and the registered class; the driver middleware still asked
once. Falsification: in a scratch copy, make `publishedTerminal` ask
`assertExpectedRows` over the concatenation instead of per window (the
pre-repair shape) and the cell reddens with the internal message; restore.

## Rules (binding)

The twelve rules of `common.md`. No patchwork. Never delete, weaken or
`.skip` a test. Formatting: `npx biome check` on touched files, fixed by
hand; never `--write` a whole file.

## Verification (the minimum)

One file or one project or one registered mode per call, `TMPDIR` exported,
never two at once; wait twenty seconds and retry on a lock refusal, never
remove a lock. Run: `consumable-result-proof.core.test.ts`;
`driver-result-parser.test.ts`; the `layer-drivers` project; the
`provider-sqlite3` project; the PGlite driver file(s) that exercise the
surface check — PGlite's Wasm boot exceeds the bounded runner's default
ceiling, so run those with `--rss-limit-mb=2560 --heap-limit-mb=1024` and
say so; the raptor3 modes `g2-baseline` and `g3-execution-review`; the
whole-estate typecheck at zero (`node scripts/run-typecheck.mjs`). Commands:
`TMPDIR=/private/tmp/viborm-o1-tmp node scripts/run-raptor3.mjs <mode>`;
`TMPDIR=/private/tmp/viborm-o1-tmp node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=<project> <file> --rss-limit-mb=1536 --heap-limit-mb=768`.
Receipts under `docs/architecture/raptor3-evidence/g4/rulings/o1/receipts/`.

## Deliverables

- Code at the owners; the guide only if a paragraph names the check.
- `docs/architecture/raptor3-evidence/g4/rulings/o1/note.md` (per ruling:
  truth, owner, hunks by file and line, falsifier and falsification record,
  alternatives rejected, still red, unverified, blockers, LOC
  `git diff --numstat 383f830c -- src tests`).
- The reviewer writes `docs/architecture/raptor3-evidence/g4/rulings/o1/review.md`
  with ACCEPT / REVISE (exact minimal resolutions) / BLOCK.
- Never commit, stage, reset, stash or push; never write outside
  `/private/tmp/viborm-o1`; never touch `/Users/arnaud/code/viborm` or
  `/private/tmp/viborm-o2`.
