# D-33 — a `json().schema(…)` field's user schema runs on the read path (brief)

Integrator: Fable. Worktree `/private/tmp/viborm-rulings-d33`, branch
`rulings-d33` from `e821cd21` (the rulings unit's wip commit: D-28's result
seam, D-29, D-32 are already in this tree). `TMPDIR=/private/tmp/viborm-rulings-tmp-d33`,
always exported. The worktree is the only write target; the note, the review
and the receipts live inside it under `docs/architecture/raptor3-evidence/g4/rulings/`
(`d33-note.md`, `d33-review.md`, `receipts/d33/`).

## Read first

- `docs/architecture/raptor3-evidence/g4/rulings/brief.md` (the parent unit)
  and `docs/architecture/raptor3-evidence/g4/rulings/note.md` §D-28 (the
  result seam this ruling builds on: `Queries.decodeResult`, consumed at
  `OperationContext.publishedTerminal` and the three set-mutation publications;
  the "other half" blocker at its end).
- `docs/architecture/raptor3-evidence/g4/briefs/common.md` (the twelve rules,
  binding) and `src/query-engine/raptor3/AGENTS.md`.
- `docs/architecture/raptor3-evidence/g4/parity/integration-note.md` §1c.

## The ruling (Arnaud, 2026-09-17, D-33)

Restore read-path validation: a JSON field declared with a user schema
(`s.json().schema(standardSchema)`) has that schema run at the one decode
boundary on every provider, as the engine replaced did. Cost accepted: one
schema run per JSON field per row read.

## Facts

- The engine replaced did it in `result/ResultParser.ts` (deleted at the
  cutover; read it with `git show e8114ed9^:src/query-engine/result/ResultParser.ts`):
  line 721 `const jsonSchema = scalarType === "json" ? state.schema : undefined;`
  handed the field's user schema to the JSON codec's parse (lines 817, 913,
  919 "an uncaptured scalar asks the codec to validate and construct its one
  value"). Find the codec it called and what it threw for a document the
  schema refuses; that class and sentence are the contract to restore, not a
  new one.
- The field: `src/schema/json/index.ts` (`.schema(…)` and where the state
  keeps it), `src/schema/json/interpret.ts`, `src/schema/json/serialize.ts`.
  The write path already runs the schema at admission; the read path does
  not consult it anywhere today (measured: `validate` invoked zero times in
  the whole cache-SWR file).
- The one decode boundary in this engine: `Queries.decodeValue` /
  `parseField` (`src/query-engine/raptor3/shared/query.ts`, D-17: the
  adapter/driver chain at the one row boundary) and D-28's `decodeResult`
  above it. Rule 11: the existing JSON codec owns the scalar meaning; the
  engine passes the field's schema to it, it does not re-implement
  validation. Rule 7: one decoder for the live, the prepared and the batch
  terminal; the cache route materialises from the snapshot and must not run
  the schema a second time (the snapshot holds the decoded value).
- The cell: `tests/contracts/public-client/official-cache-swr.core.test.ts`
  (line 550 expects `hostileJsonReadsAtCoreBoundary === 1`). Its user schema
  builds a hostile object whose getter counts reads; the driver-level
  `parseResult` middleware records how many times the core read the getter
  inside `next`. Green means: the schema ran on read (the object exists) and
  the core read it exactly once inside the parse chain, on the revalidation
  as on the first read.

## Required

- One owner: the field's schema reaches the JSON codec at the one decode
  boundary; no second walker of the projection to find JSON fields (the
  prepared projection already knows each column's scalar; rule 1).
- Live route, prepared route, batch terminal and cache route all decode
  through it exactly once per value.
- A document the schema refuses raises the restored public error class and
  sentence (find them in the deleted parser and its tests in git history,
  `git log -S`), never a raw `Error`.
- Falsifiers: the cache-SWR cell green; one new registered pin in
  `tests/raptor3/g4/parity/` — a `json().schema(…)` field with a transforming
  schema returns the transformed value on `findMany`, `findUnique`, `create`
  with `select`, and the cache revalidation, on the live and the prepared
  route; a refused stored document raises the restored class; the schema is
  invoked exactly once per value (count it). Falsification recorded: revert
  the hunk in a scratch copy (`git worktree add --detach`), the pin reddens;
  restore from a scratchpad copy, never `git checkout --` a dirty file.
- LOC delta reported (`git diff --numstat e821cd21 -- src tests`).

## Rules (binding)

The twelve rules of `common.md`. No patchwork: one owner per fact, no second
reader, no policy boolean, no per-feature interpreter. Refusals are contracts.
Never delete, weaken or `.skip` a test. Formatting: `npx biome check` on
touched files, fixed by hand; never `--write` a whole file.

## Verification (the minimum)

One file or one registered mode per call, `TMPDIR` exported, never two at
once; wait twenty seconds and retry on a lock refusal, never remove a lock.
Run: the cache-SWR cell's file; the new pin; `tests/raptor3/g4/parity/driver-result-parser.test.ts`
and the parity decoding falsifier `tests/contracts/engine/query/parity-decoding.core.test.ts`;
the `layer-query-engine` and `layer-client` projects; the raptor3 modes
`g2-baseline`, `g2-contracts`, `cs01-extension-a`; the whole-estate typecheck
at zero diagnostics. Commands:
`TMPDIR=/private/tmp/viborm-rulings-tmp-d33 node scripts/run-raptor3.mjs <mode>`;
`TMPDIR=/private/tmp/viborm-rulings-tmp-d33 node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=<project> <file> --rss-limit-mb=1536 --heap-limit-mb=768`.
Receipts: one log per run under `docs/architecture/raptor3-evidence/g4/rulings/receipts/d33/`.

## Deliverables

- Code at the owner; the guide paragraph that owns decoding updated.
- `docs/architecture/raptor3-evidence/g4/rulings/d33-note.md`: the truth,
  the owner, the change (hunks by file and line), the falsifier and its
  falsification record, the alternatives rejected under the rules, still red,
  unverified claims, blockers, LOC.
- The reviewer writes `docs/architecture/raptor3-evidence/g4/rulings/d33-review.md`
  with ACCEPT, REVISE (exact minimal resolutions) or BLOCK.
- Never commit, stage, reset, stash or push; never write outside
  `/private/tmp/viborm-rulings-d33`; never touch `/Users/arnaud/code/viborm`
  or `/private/tmp/viborm-rulings`.
