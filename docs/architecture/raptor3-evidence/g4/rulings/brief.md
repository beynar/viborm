# Rulings unit — D-28, D-29, D-32 (brief)

Integrator: Fable. Worktree `/private/tmp/viborm-rulings`, branch `rulings`
from `5ac39cfd` (commit 7 on `pattern-engine`). `TMPDIR=/private/tmp/viborm-rulings-tmp`,
always exported. The worktree is the only write target; the note, the review
and the receipts live inside it under `docs/architecture/raptor3-evidence/g4/rulings/`.

## Read first

- `docs/architecture/raptor3-parity-plan.md` (units U5 driver seam, U6.5
  recovery; decisions D-17..D-26) and `docs/architecture/raptor3-evidence/g4/briefs/common.md`
  (the twelve rules, binding).
- `src/query-engine/raptor3/AGENTS.md` (the guide: its lane and integration
  sections and the repair round's invariants).
- `docs/architecture/raptor3-evidence/g4/parity/integration-note.md` §1c (the
  D-28 measurement) and §"The pg staleness cell stays red, and why" (D-29).
- `docs/architecture/raptor3-evidence/g4/parity/repair-note.md` R1b and
  `docs/architecture/raptor3-evidence/g4/parity/repair-review.md` finding 3 (D-32).
- The ledger `docs/architecture/raptor3-evidence/g4.md`: the records
  "Rulings by Arnaud" and "D-32" after commit 6, and D-17, D-25, D-30.

## The three rulings (Arnaud, 2026-09-17)

### D-28 — wire the driver-level `parseResult` middleware as a result consumer

Facts. `DriverResultParser.parseResult?(raw, operation, next)`
(`src/drivers/driver-instrumentation.ts:93-98`) is a public driver contract: a
driver may wrap the raw result of an operation once, before decoding. The
shipped consumer was `result/ResultParser.ts:604-618`, deleted with the result
engine at the cutover; D-17 restored only `parseField` (`raptor3/shared/query.ts:596-609`,
the adapter/driver chain at the one row boundary). Today nothing in `src/`
calls a driver's `parseResult`. The `sqlite3` and `bun-sqlite` drivers publish
`result = sqliteResultParser` (`src/drivers/sqlite3/index.ts:82`,
`src/drivers/bun-sqlite/index.ts:122`), which normalises count and exists
results, so wiring it changes what those drivers answer unless raptor3 already
normalises the same fact elsewhere; if it does, rule 1 applies: one owner, the
duplicate deleted at the right side, and the note says which.
`src/drivers/pglite/index.ts:85-101,232` keeps `canonicalAdapterParseResult`
and asks `driver.result?.parseResult === undefined`; read why before touching
it. The red cell: `tests/contracts/public-client/official-cache-swr.core.test.ts:550`
expects `hostileJsonReadsAtCoreBoundary === 1`, the hostile JSON member read
exactly once at the driver `parseResult` boundary on the cache route; the
integration note §1c measured zero reads anywhere and no caller.

Required. One consumer at the one place a terminal window becomes a decoded
result: rule 7 (one decoder for live and prepared execution), rule 11 (adapters
spell SQL, codecs own scalar meanings). The seam sees each operation's raw
result once, not per statement and not per member, on the live route and on
the prepared/batch route, and serves the cache route's materialisation as well;
if the cache route must be exempt, say precisely why and raise it as a
blocker. Falsifiers: the cache-SWR cell; one new registered pin — a driver
`parseResult` middleware observes each operation's raw result exactly once for
findMany, findUnique, count, aggregate, create and update on both routes and
`next` chains to the adapter's parse; the SQLite count/exists normalisation
asserted at its one owner; the existing driver contract tests under
`tests/contracts/drivers/**` for sqlite3, bun-sqlite and pglite green.

### D-29 — a queued premise rides the atomic unit it protects

Facts. The red pg cell: `tests/providers/docker/pg-nested-write-races.test.ts`
› "pg filtered m2m deleteMany staleness › a member added after the plan-time
read aborts the guard, then the retry converges", failing at
`batchErrors.length >= 1`. The complement guard `requireNoAddedMember`
(`commands/execution.ts:717-744`, queued by `captureSeries` at 833-834 after
the parent premise) is emitted and correct; the integration note captured its
SQL live. It is missed because the operation issues a multi-statement planning
batch before its atomic unit; measure where the premise is actually dispatched
and where the window opens, do not assume it. Owners to read:
`OperationContext.queue` (`shared/operation-context.ts:393`), `read(query, true)`,
`submit`, and the place planning reads become batches.

Arnaud's rule (a): a premise queued during planning (`requirePresent`,
`requireAbsent`) is dispatched inside the atomic unit that contains the write
it protects, never in an earlier planning batch.

Required. One owner decides when statements become batches; no policy boolean.
`tests/raptor3/g4/parity/integration-staleness.test.ts` (three cells, SQLite
batch-only transport) stays green. Add one deterministic local pin of the rule
(a premise queued before a planning batch is dispatched inside the atomic unit,
observable through a recording driver's statement order) and turn the pg cell
green on Docker pg. Report the round-trip and statement counts before and after
on the `fixed-collection-rowref-20` and `nested-conditional-found` shapes (the
perf protocol under `g4/`): a rule that adds a round trip to a write that had
none is a blocker, not a repair.

### D-32 — mark the never-raceable capture premises raceable, with a witness

Facts. Since the repair round, `submit` arms the batch re-plan only for a
premise whose owner marked `meta.raceable === true`
(`shared/operation-context.ts:1140-1168`). `captureMembership`
(`shared/operation-context.ts:2447-2467`) marks its absent arm raceable but not
its present arm ("the captured membership is gone", line 2461). The repair
review's finding 3 names that arm and "one sibling" as the two premises that
armed the re-plan before the gate and no longer do, with no registered witness.

Required. (1) Enumerate every `requirePresent` and `requireAbsent` premise with
its raceable status and say which ones changed behaviour under the gate: a
table in the note. (2) Mark raceable exactly the premises that state loss after
observation of a captured membership (rule 5: initial absence differs from loss
after observation): the line-2461 arm and its sibling. Do not mark the identity
premises: the captured row's own presence (`commands/execution.ts:264`) and the
parent-presence premise (`commands/execution.ts:833`, whose comment says why);
say why each stays. (3) One registered concurrency witness per marked premise:
a concurrent writer deletes or replaces the captured membership between
capture and write; under the batch transport the operation re-plans once and
converges, or refuses with its registered sentence when the new state forbids
the write. The identity premises' existing pins stay green
(`tests/raptor3/transitions/conditional-upsert*`, the `g2-upsert-skip-replaced`
and `g2-upsert-skip-deleted` modes). Witness pattern:
`tests/raptor3/g4/parity/integration-staleness.test.ts` (SQLite batch-only,
provably atomic transport); extend it or add a sibling file beside it.

## Rules (binding)

The twelve rules of `common.md`, verbatim. In addition: no patchwork, which
means one owner per fact, no second reader of a fact its owner already states,
no policy boolean, no per-feature interpreter, no wrapper-only class. Refusals
are contracts. Never delete or weaken a test to go green; never `.skip`. A
recorded transport script or replay corpus may be regenerated only where the
physical plan changed by design; name the ruling that changed it and pin the
new plan. Every change lands with its falsifier: revert the hunk in a scratch
copy and the pin reddens; record the falsification, restoring files from a
scratchpad copy (never `git checkout --` a dirty file). Local justified
assertions are allowed. Report the LOC delta
(`git diff --numstat 5ac39cfd -- src tests`).

## Verification (the minimum, Arnaud's instruction)

One file or one registered mode per call, `TMPDIR` exported, never two runs at
once; wait twenty seconds and retry on a lock refusal, never remove a lock.
Run: the unit's own falsifiers; the touched files' projects; the parity
falsifiers (`tests/raptor3/g4/parity/*.test.ts`,
`tests/contracts/engine/query/parity-*.core.test.ts`); the raptor3 fixed modes
that touch the changed owners, at least `g2-baseline`, `g2-contracts`,
`g2-transport`, `cs01-extension-a`, `g3p03-contracts` (say which you ran); the
pg Docker file for D-29; the whole-estate typecheck at zero diagnostics
(`node scripts/run-typecheck.mjs`). Commands:
`TMPDIR=/private/tmp/viborm-rulings-tmp node scripts/run-raptor3.mjs <mode>`;
`TMPDIR=/private/tmp/viborm-rulings-tmp node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=<project> <file> --rss-limit-mb=1536 --heap-limit-mb=768`.
Docker: PostgreSQL `postgresql://postgres@127.0.0.1:55729/raptor3_g2`
(`PG_TEST_CONNECTION_STRING`), MySQL `mysql://root@127.0.0.1:55730/raptor3_g2`
(`MYSQL_TEST_CONNECTION_STRING`), `VIBORM_RAPTOR3_PROVIDER_PORT` per provider.
Receipts: one log per run under `docs/architecture/raptor3-evidence/g4/rulings/receipts/`.
The integrator runs the estate lanes and the whole fixed group afterwards.

## Deliverables

- Code at the owners; the guide (`src/query-engine/raptor3/AGENTS.md`) updated
  at the paragraphs that own each invariant.
- `docs/architecture/raptor3-evidence/g4/rulings/note.md`: per ruling the
  truth, the owner, the change (hunks by file and line), the falsifier and its
  falsification record, the alternatives rejected under the rules, the
  still-red list, unverified claims, blockers, the LOC delta.
- The reviewer writes `docs/architecture/raptor3-evidence/g4/rulings/review.md`
  with ACCEPT, REVISE (exact minimal resolutions) or BLOCK.
- Formatting: `npx biome check` on touched files, fixed by hand; never
  `--write` a whole file.
- Never commit, stage, reset, stash or push; never write outside
  `/private/tmp/viborm-rulings`; never touch `/Users/arnaud/code/viborm`.
