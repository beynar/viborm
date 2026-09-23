# D-35 — delete the inert count/exists arm of the SQLite drivers' `parseResult` (brief)

Integrator: Fable. Worktree `/private/tmp/viborm-d35`, branch `d35` from `fd441c7f` (commit 8, the rulings unit landed). `TMPDIR=/private/tmp/viborm-d35-tmp`, always exported. The
worktree is the only write target; the note, the review and the receipts live
inside it under `docs/architecture/raptor3-evidence/g4/rulings/d35/`.

## The ruling (Arnaud, 2026-09-17, D-35)

One fact, one authority: the engine's decoder owns the meaning of count and
exists results. The SQLite drivers' driver-level `parseResult` middleware still
carries a count/exists normalisation arm that this engine never reaches
(raptor3 asks for its own `_count` alias; the normaliser recognises only
`0viborm_count_result` / `count(`). Delete the arm in its own commit, with a
release note, because it is a public driver surface.

## Facts

- The arm: `src/drivers/shared/sqlite-utils.ts:47` (`parseResult: (raw,
  operation, next) => { … normalizeCountResult(raw) … }`), exported as
  `sqliteResultParser` and published as `result` by `src/drivers/sqlite3/index.ts:82`,
  `src/drivers/bun-sqlite/index.ts:122` and `src/drivers/d1/index.ts` (check
  libsql too). `normalizeCountResult` is imported at `sqlite-utils.ts:8`; find
  its other readers before deleting it.
- `SQLite3Driver.canonicalDriverParseResult` (`src/drivers/sqlite3/index.ts:77`)
  and `hasCanonicalProducerSurface` (`:211`) compare a driver's `result` and its
  adapter's `parseResult` against the canonical ones; read why that check
  exists (the D-28 note and the D-28 review, `g4/rulings/note.md` §D-28,
  `g4/rulings/review-d28.md`, name it) and keep its meaning with one owner
  after the arm is gone. `PGliteDriver` has the same shape at
  `src/drivers/pglite/index.ts:223-233` and is NOT this ruling's target.
- D-28 gave the driver-level `parseResult` its consumer again
  (`Queries.decodeResult` → `OperationContext.publishedTerminal`), asked once
  per operation; the pin is `tests/raptor3/g4/parity/driver-result-parser.test.ts`.
  Deleting the arm must not change what that pin measures, only what the
  SQLite drivers' middleware does when asked.
- Pins that mention the arm: `tests/contracts/adapters/result-parsing.core.test.ts`,
  `tests/contracts/adapters/internals-and-geo.core.test.ts`,
  `tests/contracts/engine/query/parity-decoding.core.test.ts`. Each cell that
  pinned the driver-level normalisation is re-expressed to pin the decoder's
  ownership of the same fact (the count and exists answers on sqlite3,
  bun-sqlite, d1 and libsql stay what they are today), never deleted or
  weakened; say per cell what it pinned before and what it pins now.

## Required

- The arm and its now-unreferenced helpers deleted; `sqliteResultParser`
  keeps whatever other arms it has (`parseField`, `parseRelation`) unchanged.
- The canonical-surface check on `SQLite3Driver` re-stated over what remains,
  with its reason preserved; no policy boolean, no second reader.
- A release note entry (find the repo's release-notes or changelog file; if
  none exists, say so and put the note at the top of the D-35 note for the
  integrator) stating: driver-level `parseResult` on the SQLite drivers no
  longer normalises count/exists results; the engine's decoder answers them;
  any consumer that wrapped `driver.result.parseResult` for that purpose is
  unaffected in outcome.
- Falsifiers: `layer-drivers`, `provider-sqlite3`, `provider-libsql`,
  `parity-decoding.core.test.ts`, `driver-result-parser.test.ts`, the raptor3
  modes `g2-baseline` and `g2-contracts`, the whole-estate typecheck at zero.
- LOC delta reported (`git diff --numstat <base> -- src tests`); the
  expected direction is negative in production.

## Rules (binding)

The twelve rules of `docs/architecture/raptor3-evidence/g4/briefs/common.md`.
No patchwork. Never delete, weaken or `.skip` a test. Formatting: `npx biome
check` on touched files, fixed by hand. Never commit, stage, reset, stash or
push; never write outside the worktree; never touch `/Users/arnaud/code/viborm`.

## Deliverables

- Code; the guide (`src/query-engine/raptor3/AGENTS.md`) only if a paragraph
  there names the arm.
- `docs/architecture/raptor3-evidence/g4/rulings/d35/note.md` (truth, owner,
  hunks, per-cell re-expression table, release note text, falsification
  record, still red, unverified, blockers, LOC).
- The reviewer writes `docs/architecture/raptor3-evidence/g4/rulings/d35/review.md`
  with ACCEPT / REVISE (exact minimal resolutions) / BLOCK.
