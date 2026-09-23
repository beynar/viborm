# D-40 — the adapter-level `parseResult` legs: measure live, delete what is inert (brief)

Integrator: Fable. Worktree `/private/tmp/viborm-o2`, branch `o2` from `383f830c`
(commit 10, the docs commit after D-35). `TMPDIR=/private/tmp/viborm-o2-tmp`,
always exported. The worktree is the only write target; the note, the review
and the receipts live inside it under `docs/architecture/raptor3-evidence/g4/rulings/o2/`.

## Read first

- `docs/architecture/raptor3-evidence/g4/rulings/d35/note.md` (D-35: the
  same ruling for the SQLite drivers, its measurement-first method, its
  release note) and `docs/architecture/raptor3-evidence/g4/rulings/d35/review.md`
  (observation O-2).
- `docs/architecture/raptor3-evidence/g4/rulings/note.md` §D-28 (the result
  chain: driver `parseResult` → adapter `parseResult` → the engine's decoder,
  asked once per operation at `Queries.decodeResult` /
  `OperationContext.publishedTerminal`).
- `docs/architecture/raptor3-evidence/g4/briefs/common.md` (the twelve rules,
  binding) and `src/query-engine/raptor3/AGENTS.md`.
- The ledger `docs/architecture/raptor3-evidence/g4.md`, record "Rulings by
  Arnaud (23:40, 2026-09-17)": D-40.

## The ruling (Arnaud, D-40)

Measure live first, D-35's discipline: on Docker PostgreSQL and MySQL,
probe each adapter-level `parseResult` leg with a counting and recording
wrapper across count, aggregate, exists, findMany, findUnique, create and
update, on the live route and on the prepared `$transaction([…])` route.
Classify each leg: reached and deciding something the decoder consumes;
reached and inert (decides nothing, or decides something nothing reads);
unreached. Delete only a leg that is inert or unreached, whole, with its
release note; a live leg stays and the note says exactly what it decides
and who reads it.

## Facts

- MySQL: `src/adapters/databases/mysql/mysql-adapter.ts:1029-1042`
  (`parseResult`, normalises a count result to the `0viborm_count_result`
  key through `normalizeCountResult`, whose last known reader after D-35 is
  this adapter). raptor3 asks for its own `_count` alias
  (`src/query-engine/raptor3/shared/query.ts` around lines 2938, 2952,
  2967-2970) and reads it back itself.
- PostgreSQL: `src/adapters/databases/postgres/postgres-adapter.ts:656`
  (`parseResult`, a bigint conversion leg; find what it converts and whether
  the codec chain at `parseField` / the scalar codecs already own that
  meaning — rule 11: existing codecs own scalar meanings, so a duplicate
  conversion is a second owner, not a feature).
- The adapter `result.parseResult` contract (`DatabaseAdapter["result"]["parseResult"]`)
  is public and stays; if a leg's deletion leaves an adapter's `parseResult`
  as a pure pass-through, keep the contract's shape and say so.
- Pins to re-express, never weaken: `tests/contracts/adapters/result-parsing.core.test.ts`,
  the MySQL and PostgreSQL adapter contract tests under `tests/contracts/adapters/`,
  `tests/contracts/engine/query/parity-decoding.core.test.ts`; per cell,
  what it pinned before and what it pins now (the decoder's ownership of the
  same fact, the answers unchanged on both providers).

## Required

- Receipts of the live probes per provider and per route BEFORE any deletion
  (the probe source kept as `.txt` beside its receipt, the probe file removed
  from the tree afterwards).
- Deletions whole, at the owner; helpers with no remaining reader deleted
  (re-check `normalizeCountResult` and `0viborm_count_result`'s readers
  across `src/`).
- Release note in `CHANGELOG.md` under `## Unreleased`, one entry per
  provider whose leg is deleted, in the wording discipline of the D-35 entry
  (state only what is measured; the D-35 review struck two sentences that
  claimed a difference that did not exist).
- Falsification per deleted leg: a cell that pins the decoder's answer over
  the measured live raw; reddens when the decoder's own alias is renamed in
  a scratch copy; restored from a scratchpad copy.
- LOC delta (`git diff --numstat 383f830c -- src tests`); the expected direction
  in production is negative.

## Rules (binding)

The twelve rules of `common.md`. No patchwork. Never delete, weaken or
`.skip` a test. Formatting: `npx biome check` on touched files, fixed by hand.

## Verification (the minimum)

One file or one project or one registered mode per call, `TMPDIR` exported,
never two at once. Docker: PostgreSQL `postgresql://postgres@127.0.0.1:55729/raptor3_g2`
(`PG_TEST_CONNECTION_STRING`), MySQL `mysql://root@127.0.0.1:55730/raptor3_g2`
(`MYSQL_TEST_CONNECTION_STRING`), `VIBORM_RAPTOR3_PROVIDER_PORT` per
provider. Run: the adapter contract tests touched; `parity-decoding.core.test.ts`;
`tests/raptor3/g4/parity/driver-result-parser.test.ts`; the `provider-pg`
project and the `provider-mysql2` project — MySQL carries 165 pre-existing
reds and pg 25: compare your red sets against
`docs/architecture/raptor3-evidence/g4/rulings/verification/rulings-mysql-red.txt`
and `rulings-pg-red.txt` and report ZERO regressions, listing any cell that
moved either way; the raptor3 modes `g2-pg-contracts` and
`g2-mysql-contracts`; the whole-estate typecheck at zero. Commands:
`TMPDIR=/private/tmp/viborm-o2-tmp node scripts/run-raptor3.mjs <mode>`;
`TMPDIR=/private/tmp/viborm-o2-tmp node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=<project> <file> --rss-limit-mb=1536 --heap-limit-mb=768`.
Receipts under `docs/architecture/raptor3-evidence/g4/rulings/o2/receipts/`.

## Deliverables

- Code; `CHANGELOG.md`; the guide only if a paragraph names a leg.
- `docs/architecture/raptor3-evidence/g4/rulings/o2/note.md`: the
  measurement table (leg × route × operation: reached? decides? read by?),
  the classification, hunks by file and line, per-cell re-expression table,
  release note text, falsification records, still red, unverified, blockers,
  LOC.
- The reviewer writes `docs/architecture/raptor3-evidence/g4/rulings/o2/review.md`
  with ACCEPT / REVISE (exact minimal resolutions) / BLOCK.
- Never commit, stage, reset, stash or push; never write outside
  `/private/tmp/viborm-o2`; never touch `/Users/arnaud/code/viborm` or
  `/private/tmp/viborm-o1`.
