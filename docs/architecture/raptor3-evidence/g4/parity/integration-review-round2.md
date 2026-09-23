# Integration unit — independent re-check (round 2)

Reviewer: independent review agent, 2026-09-17. Worktree
`/private/tmp/viborm-parity-merge` (branch `parity`, `HEAD = 395b9dd4`, nothing
committed), `TMPDIR=/private/tmp/viborm-parity-tmp-merge`. Read in full before
the first command: the parity plan, `g4/briefs/common.md` (the twelve rules),
the merged `src/query-engine/raptor3/AGENTS.md`, both lane notes, both lane
reviews and both re-checks, the ledger's D-17..D-29, round 1's
`integration-review.md` and the author's `integration-note.md` including its
round-2 section.

Nothing was committed, staged, reset, stashed or pushed; the main tree and the
lane worktrees were not written to. The one falsification mutation was taken
against a scratchpad backup and restored by copy (`operation-context.ts` md5
`19356c9f84ff2635decb938d531a3694` before and after). The only file this review
wrote is this one. `git status` ends as it arrived: the same nine entries.

## Verdict: **ACCEPT**

The three §A resolutions are applied, exactly and only. Nothing else moved. The
affected target files and the whole-estate typecheck are green, and my own
falsification confirms the fact A.1 relocated is load-bearing at its one
remaining owner. Two things are carried to Arnaud rather than repaired: one
behaviour widening that is correct, disclosed, and has no cell of its own (§4),
and one guide clause that is broader than the code (§5.1). Neither is a defect
of this round's compliance — the second is the review's own round-1 wording.

---

## 1. Applied exactly, and nothing else moved

Three files carry a round-2 mtime; the other six are untouched since before
round 1's exit.

| file | mtime | md5 vs round 1 |
| --- | --- | --- |
| `shared/operation-context.ts` | 14:26:15 | changed (A.1) |
| `raptor3/AGENTS.md` | 14:27:10 | changed (A.1(3), A.2) |
| `tests/raptor3/g4/parity/integration-staleness.test.ts` | 14:18:58 | changed (A.3) |
| `shared/query.ts` | 14:02:41 | `1250f8e9…` — identical to the round-1 exit |
| `commands/execution.ts` | 14:02:54 | `b5a876ce…` — identical |
| `commands/index.ts`, `result-aliases.ts`, `scripts/query-engine-test-manifest.mjs`, `parity-admission.core.test.ts` | 13:10–13:21 | untouched after round 1 |

(round 1 recorded those two digests as md5; verified by recomputation.)

`git diff --numstat` moved only on the two production/guide files
(`operation-context.ts` 103/22 → 106/22, `AGENTS.md` 92/21 → 94/22). The changed
line ranges in `operation-context.ts` are `181-205, 693, 787-803, 837, 843-869,
1072-1081, 1084, 1144, 1200-1206, 1208-1211, 1622-1633` — every one belongs to
piece 1a/1b, piece 2, or this round's A.1. No hunk elsewhere in the file.

**A.1** — `if (this.memberAdmissionStarted) return undefined;` and its four
comment lines are gone from `recoveryRejection`; the paragraph now sits above
`submit`'s attribution arm, beside "Atomic rejection is retryable only with
exact effect attribution". `grep memberAdmissionStarted` returns exactly four
lines: the field (`:206`), the one writer (`prepareMembers`, `:412`), the reset
in `restart()` (`:774`) and the ONE reader left, `submit`'s conjunct (`:1085`).
The classifier's own opening paragraph was rewritten in the same edit — the
resolution asked for that (a comment asserting a split the edit removes is the
same defect), and it is comment text only.

**A.2** — the guide's recovery paragraph is rewritten. I checked each claim
against the code rather than against the note:

- `regionAttempt` (`:827-842`) re-enters `withinRegion(region, body)`;
  `batchAttempt` (`:859-869`) re-enters `body()`; `run`'s deferred arm
  (`:695-702`) runs `body()` and then `regionAttempt(region, body)` — three
  re-plans, because `commands/index.ts:183-203` consumes the first plan once
  (`planned = undefined`) and builds a fresh `Commands(context).plan(…)` for any
  later attempt.
- `CommandExecution.recover` (`commands/execution.ts:181-211`) is the only
  in-place path and refuses unless `context.replaysInPlace`
  (`= !ownRegionOpen`).
- admission is memoised one level above the body: `commands/index.ts:167-168`
  `admitted ??= schema.admit(model, operation, rawArgs)`.
- the allowance has one owner: `OperationContext.spendRecovery` (`:797`), one
  counter (`recoverySpent`), three callers (region, batch, in-place recover).

**A.3** — the `PROBE-setup` try/catch is gone; `createWorld` seeds with a bare
`await client.board.update({ … })`. The file has no `console.`, no `try`/`catch`,
no `.skip`, no `.only`, no `todo(`. Its three cells are unchanged in name and in
substance (one-guard/one-key; two captures with the second excluding both keys;
allowance spent once, exactly two captures, nothing written).

---

## 2. What I ran (bounded runner, one file per call, serial, TMPDIR exported)

| target | project | result |
| --- | --- | --- |
| `tests/raptor3/g4/parity/integration-staleness.test.ts` | `extended-local` | **3/3** |
| `tests/raptor3/transitions/recovery-boundaries-live-commands.test.ts` | `raptor3-live-provider` (pg 55729) | **2/2** |
| `tests/raptor3/g4/parity/lane-x-set-mutations.test.ts` | `extended-local` | **9/9** |
| `tests/raptor3/transitions/unique-races-live-commands.test.ts` | `raptor3-live-provider` (pg 55729) | **3/3** |
| `tests/providers/local/sqlite3-nested-write.test.ts` | `provider-sqlite3` | **85/85** |
| `tests/providers/docker/pg-nested-write-races.test.ts` | `provider-pg` (pg 55729) | 6 failed / 89 passed — **the same six** the author reports (the D-29 staleness cell and the five base `batch-only batch primary-key dataflow` cells); every family-13 race cell green |
| `node scripts/run-typecheck.mjs` | — | **0 diagnostics, exit 0** (6.5 s, 5,162 MiB) |
| `npx biome check` on the two round-2 code files | — | `operation-context.ts` reports the same six as `git show 356254a2:` does (`organizeImports`, `noParameterProperties` ×4, `format`); the format hunks are at lines 3–68, 322, 323, 352, 365, 405, 487, 496, 497, 560, 618, 949, 1016, 1029, 1053, 1271, 1288, 1291 — **none intersects any changed range**. `integration-staleness.test.ts` reports nothing |

`sqlite3-nested-write` and `pg-nested-write-races` are in the set on purpose:
they are where a dynamic member series meets a transaction-capable provider,
which is the intersection A.1's deletion actually changes (§4).

### Falsification (one mutation, restored by copy)

| mutation | result |
| --- | --- |
| `!this.memberAdmissionStarted &&` replaced by `true &&` at `submit`'s attribution arm (`:1085`) — its ONE remaining owner | `recovery-boundaries-live-commands` **1 failed / 1 passed**: `g2-recovery-dynamic-member-admission` fails with `+ 'Error' − 'UniqueConstraintError'`, the author's exact observable |
| restored from the scratchpad copy | md5 identical; 2/2 green again |

So the fact is real and singly owned: the estate reddens when it is removed from
`submit`, and round 1 measured that it stays green when removed from the
classifier. That is the whole claim of A.1, now confirmed from both directions.

---

## 3. Round 1's premise was wrong, and the author is right to say so

Round 1's §A.1 argued the deletion was behaviour-free because `submit` "is the
only place `attempt.rejectedInsert` is ever assigned". It is not. I confirmed
the author's table in the source:

| assignment | route | bound by `memberAdmissionStarted`? | recovery it feeds |
| --- | --- | --- | --- |
| `submit`, `:1095` | `usesBatch` | yes (`:1085`) | `CommandExecution.recover` — in-place REPLAY |
| `insert`, `:2075` | `!usesBatch` | no | `regionAttempt` — a FRESH region running a FRESH plan |

The two routes are exhaustive and disjoint for a standalone operation:
`usesBatch = standalone && !driver.supportsTransactions` (`:342`) and `region()`
returns `undefined` for `usesBatch` (`:585`), so a transaction-capable standalone
operation always has a region (replay impossible: `ownRegionOpen` is true while
the body runs) and a batch-only one never does. The guide's new sentences state
exactly this split.

Two further facts I checked, which the note does not state and which make the
widening safe:

- **A possibly-committed region cannot recover.** `withinRegion`'s catch
  (`:634-654`) replaces the error with `attachCommitCertainty(error, certainty)`
  whenever the region reached `ready` or `committed`, and
  `driver-error-context.ts:136-147` **clones** the error. `rejectedProducer`
  (`:1190`) matches by identity (`rejected.error === error`), so the cloned
  error never resolves a producer and `regionAttempt` rethrows. Recovery is
  therefore confined to regions that provably rolled back, independently of
  `committedProgress`.
- **The unbounded producer cannot reach the in-place replay.** `recover` needs
  `replaysInPlace`, which on the non-batch route is true only during `run`'s
  deferred single-statement pass; and it needs a `missingChoices` producer,
  which only a relation-bearing form (`single: false`,
  `commands/commands.ts:1150/1281/1306/1338`) creates. The two cannot co-occur.

---

## 4. The one thing Arnaud should read: a correct widening with no cell of its own

Deleting the conjunct from the classifier is **not** behaviour-free. On the
region route a lost create race that had already admitted a dynamic member used
to propagate `UniqueConstraintError`; it now spends the allowance, re-plans in a
fresh transaction and converges.

That is the right answer, for three independent reasons:

1. It is the shipped rule. `git show e8114ed9d^:src/query-engine/write-engine/routing.ts`
   `executeRoutedOperation` retries once unless
   `hasCommittedRecordSeriesProgress(error) || !isRetryableRace(error)` — no
   member-admission term anywhere in the gate.
2. It is D-25 as the ledger records it ("refused only after COMMITTED
   record-series progress; a recovery re-plans from the ADMITTED values with a
   fresh occurrence tree").
3. Round 1's state was stricter than both, at a site that could not name its own
   coverage.

What it does not have is a witness. `g2-recovery-dynamic-member-admission` — the
cell that pins the bound — runs in an `atomic-batch` world
(`recovery-boundaries-live.ts:259`), i.e. the replay route; no registered cell
exercises "transaction-capable provider + dynamic member admitted + lost create
race". The neighbouring suites are green (§2), and a re-planned attempt re-runs
that member's per-row defaults and transforms, which on the batch route the pin
explicitly forbids. **Recorded for Arnaud, not repaired**: the ruling that the
"runs once" rule is a property of the REPLAY and not of the operation is his to
confirm, and a cell for the region route is a witness-stream follow-up, not a
change to this unit.

---

## 5. Nits (no re-run needed; none blocks acceptance)

1. **The guide's re-plan safety clause is broader than the code.**
   `AGENTS.md`'s "a re-plan is safe because admission is memoised … so no
   default and no transform runs twice" is true of the ADMITTED ARGUMENTS
   (`admitted ??= schema.admit(…)`) and false of a captured member's own
   defaults and transforms: `restart()` clears `memberAdmissionStarted`
   (`:774`), the fresh tree calls `prepareMembers` again, and the paragraph
   three lines above says so ("the new tree admits its own members"). The clause
   is round 1's own wording, applied verbatim, so it is a nit and not a
   compliance defect — scope it (e.g. "no admitted argument is validated or
   transformed a second time") when the guide is next touched.
2. **§B.1 and §B.2 of round 1 were declined**, which was their standing ("take
   or leave"). B.2 — the D-26 carrier decode acts only on an object carrier
   while every arm re-parses a string — remains open for a provider that returns
   the nested document as text; no live provider does (SQLite, PostgreSQL,
   MySQL all verified across the two rounds).
3. The guide still says `usesBatch` "is not an atomicity, lifecycle, recovery,
   or commit-certainty fact" (`:390-392`) while the bound is now stated at the
   two transport-shaped attribution sites. The classifier itself asks no
   transport question, so the sentence survives on its own terms; worth one
   clause if the paragraph is ever revisited.

---

## 6. Unverified by this review

- `physical-envelope.test.ts`, the whole `provider-pg` / `provider-mysql2`
  projects beyond the files named above, `mysql2.test.ts`,
  `mysql2-relations-ddl`, the `raptor3` project's other files, PGlite, and every
  campaign/replay — out of scope under the "minimum tests" instruction. Round 2
  moved no line those exercise (its production change is one deleted conjunct
  plus comments).
- The ordering claim that each round-2 gate was written before its first edit is
  taken on the author's word; only the note's final mtime is observable.
- The D-26 probe's cost against the D-9 budget: still unmeasured, as both the
  author and round 1 disclose.
- The three residuals D-28 (cache-SWR), D-29 (pg staleness) and the five base
  `batchPrimaryKeyDataflow` cells are unchanged and remain Arnaud's decisions.
