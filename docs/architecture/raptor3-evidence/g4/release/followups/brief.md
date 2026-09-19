# Release unit "followups" — the retirement follow-ups F-1..F-6 (brief)

Integrator: Fable. Worktree `/private/tmp/viborm-followups`, branch `followups`
from `383f830c` (commit 10; the rulings units o1/o2 land beside this lane and are merged by the integrator). `TMPDIR=/private/tmp/viborm-followups-tmp`, always
exported. The worktree is the only write target; note, review and receipts
live under `docs/architecture/raptor3-evidence/g4/release/followups/`.

## Read first

- `docs/architecture/raptor3-evidence/g4/pattern-retirement/note.md` §"Follow-ups"
  (F-1 to F-6, lines ~450-501) and its receipts (`reachability-before.json`).
- `docs/architecture/raptor3-evidence/g4/briefs/common.md` (the twelve rules,
  binding); `src/query-engine/raptor3/AGENTS.md`.
- The ledger `docs/architecture/raptor3-evidence/g4.md`: the census
  correction after commit 6 ("Like for like"), F-7, D-32 (raceable is read
  again since the repair round).

## The rulings (Arnaud, 2026-09-18: "retirement follow-ups worth doing before a release")

- **F-1 — the census counts the engine.** `scripts/measure-raptor3-baseline.mjs`
  `classify()` still returns `excluded-experiment` for `src/query-engine/raptor3/`.
  Re-base it so `accounting.charged` is the whole shipped engine (`raptor3/`
  becomes `charged-engine`), keep every other class as it is, and state in
  the note the new charged figure against the frozen baseline (`docs/architecture/raptor3-evidence/baseline.json`,
  charged 49,887 token lines, of which 46,021 under `src/query-engine/`) —
  the ledger's like-for-like numbers are the truth to reproduce (HEAD
  `src/query-engine/**` ≈ 15.5k token lines ≈ 0.336). The tool's report
  wording changes only where the class name does.
- **F-2 — the last boundaries move under `raptor3/`.** `write-engine/parse-boundary.ts`
  (only importer `raptor3/shared/schema.ts`) → `raptor3/shared/`;
  `operations/groupby-fields.ts` (importer `result/result-shape.ts`) →
  the home the note proposes, or say why it stays. Delete the emptied
  directories. Update every import and every doc path that names them
  (grep the whole repo, including `docs/`). No behaviour change.
- **F-3 — the coverage floors.** `test:coverage:query-engine-core`'s branch
  exception cites deleted files; `test:coverage:write-engine`'s floors were
  measured over 18 files and the root holds one. Re-measure each floor on
  this tree (run the coverage script for that scope, receipts kept), set the
  floor to the measured value rounded down to the half-point, remove the
  dead exceptions, keep `scripts/coverage-policy.mjs`'s registration rules
  satisfied (`pnpm test:coverage:policy` green) and `pnpm test:coverage`
  green.
- **F-4 — `meta.raceable`.** It IS read again since the rulings unit
  (`OperationContext.submit`'s gate, D-32). Verify by grep, restate the
  retirement note's F-4 as closed in your note, and fix any comment in
  `raptor3/AGENTS.md` or the code that still says the route "retries
  nothing" or that the bit is never read. No behaviour change.
- **F-5 — the nineteen unreachable files.** Re-derive reachability from the
  entry points on THIS tree (the note's method: a real TypeScript program
  from the package entry points; `reachability-before.json` is the base
  list). Delete every file unreachable from every entry point EXCEPT
  `raptor3/program/{index,program}.ts` if the ledger or a brief names it as
  a retained specimen (check; if retained, say by whom). Delete their tests
  only if the test file's only subject is the deleted file, and say so per
  file. `pnpm test:package`, `pnpm package:lint` and the typecheck green.
- **F-6 — `write-engine/ATOM.md` and `README.md`.** They describe a deleted
  engine and carry a RETIRED header; eleven plans under `docs/architecture/`
  cite ATOM.md. Move both under `docs/architecture/retired/` (or the
  existing home for retired designs if one exists), update the eleven
  citations, delete `src/query-engine/write-engine/` once F-2 has emptied it.

## Rules (binding)

The twelve rules of `common.md`. No patchwork. Never delete, weaken or
`.skip` a test to go green (a test whose only subject was deleted is the
one exception and is listed per file). `npx biome check` on touched files,
fixed by hand.

## Verification (the minimum)

`pnpm test:types` (zero diagnostics); `pnpm test:core` (its one
pre-existing red is the inventory cell of `contract-matrix.core.test.ts`;
do not fix it here, another lane owns it); `pnpm test:coverage:policy`;
`pnpm test:coverage`; `pnpm test:package`; `pnpm package:lint`; the raptor3
modes `g2-baseline` and `g2-contracts`; the census
`node scripts/measure-raptor3-baseline.mjs --output <receipt>` before and
after F-1. Receipts under `docs/architecture/raptor3-evidence/g4/release/followups/receipts/`.

## Deliverables

- Code and docs at their owners; `docs/architecture/raptor3-evidence/g4/release/followups/note.md`
  with one section per follow-up (what moved, hunks, falsifier, receipts,
  the new census figure, per-file deletion list with the reachability proof).
- The reviewer writes `.../release/followups/review.md`.
- Never commit, stage, reset, stash or push; never write outside the
  worktree.

## Integrator note (00:55): F-3 is shared with the unit "coverage"

The coverage floors and the scope DEFINITIONS of `query-engine-core` and
`write-engine` are owned by the parallel release unit "coverage" (measured
on the same base: query-engine-core is at 55 % because the scope's test
list still names the deleted engine, not because the engine is untested).
In this unit, F-3 means: remove the dead exceptions that cite deleted
files, re-measure and REPORT the numbers in your note, and do not set a
floor or change a scope's test list — the integrator reconciles both units
at merge. Everything else in F-3 and in F-1, F-2, F-4, F-5, F-6 stands.
