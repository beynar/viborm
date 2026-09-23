# N5 wave 1 — the gate's recorded expectations, derived then re-expressed (brief for the four Opus agents)

Read `brief-n5.md` beside this file first: it states the gate, the four classes (A, B ruled, C, D), the rules and the report shape. This wave is TESTS ONLY: you edit the test files your group owns (listed in your prompt) and NOTHING under `src/`. A cell whose honest answer needs a `src/` change (class C) is NOT edited: you derive its answer, measure the current one, name the mechanism and the owner file + function in `src/query-engine/raptor3/`, and leave it red — wave 2 repairs the owners and re-expresses those cells after the repair.

Worktree `/private/tmp/viborm-n5` (branch `n5`, base = the N4 commit). `export TMPDIR=/private/tmp/viborm-n5-<yourgroup>-tmp` (mkdir -p). PGlite contract files run through `node /private/tmp/claude-501/-Users-arnaud-code-viborm/c2c775da-2927-4590-8677-3bb0f5d1aa98/scratchpad/run-shared-family-cwd.mjs <file>` (run it from the worktree directory; one vitest at a time on this machine — on a lock refusal wait 20 s and retry); SQLite-backed files through `node scripts/run-vitest-safe.mjs <file>`. Never `pnpm test:all`. Never touch `/Users/arnaud/code/viborm`; never commit, stage, reset, stash, push, checkout, or run the formatter (a file whose base copy carries a `format` diagnostic is edited by hand; check with `npx biome check` on a `git show <base>:<file>` scratch copy first).

## What to read before deriving

- `docs/architecture/raptor3-evidence/g4/release/gate/note.md` and YOUR family document(s) beside it (`<family>.md`): the triage already classified every cell and states the retired detail or the ruling behind each. Treat it as a hypothesis to verify, not a verdict.
- `docs/architecture/raptor3-nesting-and-refusals-plan.md` — §1 (N1, "1 as landed"), §2 (N2), §3 ("3 as landed"), §4 ("4 as landed"), §5 (N5, the classes and their rulings). The rulings D-51 (any nesting executes; live = statement order, batch = a succession of segments), D-52, D-53, D-54 are Arnaud's and binding.
- `src/query-engine/raptor3/AGENTS.md` (the guide; especially the N1/N2/N3/N4 paragraphs near the end, §7.2 the `q0` root alias, D-15 the CTE fold — only the scalar RETURNING fold is ported, D-46 the array route's unbatchable relation-bearing update, G3P-04 the borrowed skipDuplicates member rollback region) and `DESIGN.md` where the guide cites it.
- The N1 re-expression discipline: `docs/architecture/raptor3-evidence/g4/release/n1/brief-reexpress.md`. Derive the cell's answer from the contract and the rulings BEFORE running it. If the measured answer contradicts the derivation, the cell is a class-C defect (or your derivation is wrong — say which and why), never a new expectation.

## Per cell (every red cell of every file you own — the list is in `red-cells.md` beside this brief)

1. Family and the triage's class.
2. DERIVED: what the shipped engine must answer under the rulings, and which document says so (cite the section).
3. MEASURED: run the file; the cell's current answer verbatim (first message).
4. ACTION:
   - **A / B ruled / D** → re-express the cell to the derived answer, naming the ruling in the cell's title or a one-line comment (`// D-15: …`, `// G3P-04: …`, `// §7.2: …`, `// D-46: …`, `// D-51: …`). Never delete, `.skip` or weaken; an assertion that pinned a retired physical detail becomes the assertion of the shipped detail, not an absence of assertion. A cell that pinned a retired STATEMENT COUNT asserts the shipped count and the shipped statement shape.
   - **C** → no edit. Report: the mechanism, the owner (`src/query-engine/raptor3/<file>:<function>`), the exact shape a pin would need (one paragraph), and whether other cells in the estate share the mechanism.
   - **B open** → no edit; report the ruling needed for Arnaud in one paragraph.
5. After your edits, run every file you touched and report the counts; then run `node scripts/run-typecheck.mjs` (whole estate) and report.

## Report (structured, per the schema in your prompt)

Cells: one entry per red cell. Edits: per file, the cells re-expressed and the ruling named. Owners: the list of (owner file:function → the cells it would close) for wave 2, deduplicated. Runs and Biome per file (before/after diagnostic counts against the base copy). Unverified.
