# Parity repair round — independent review

Reviewer: independent review agent, 2026-09-17. Subject: the repair round on
`/private/tmp/viborm-parity-merge` (branch `parity`, `HEAD = 7bb45348a`, five
modified files, nothing committed), described in
`g4/parity/repair-note.md`. Inputs read in full before the first command:
`docs/architecture/raptor3-parity-plan.md`, `g4/briefs/common.md` (the twelve
rules), the merged `src/query-engine/raptor3/AGENTS.md` (both lane sections and
the integration rewrite), `g4/parity/lane-q-note.md`, `lane-x-note.md`,
`integration-note.md`, and the ledger D-17..D-31 in `g4.md`.

## Verdict: **ACCEPT**

Three production changes, two test re-expressions and one guide update. Every
bisection the note claims is reproduced HERE by reverting the named hunk in the
live tree; the three causes are not merely sufficient but **exhaustive** (8 + 2 +
1 = the 11 `g2-baseline` cells). The seven formerly-red modes are green on my own
runs, the MySQL "regression" is disproved by my own base run in the same
container, the whole-estate typecheck is silent, and no test was deleted,
weakened, skipped or re-recorded. Four minor items below are recommendations, not
conditions — none of them changes an answer.

---

## 1. What I ran (all on the merged worktree unless stated, `TMPDIR=/private/tmp/viborm-parity-tmp-merge`, one command at a time)

| target | result |
| --- | --- |
| `g2-baseline` | **216 / 216** |
| `g2-contracts` | **216 / 216** |
| `g3p03-contracts` | **6 / 6** |
| `g3-generated-smoke` | **6 / 6** |
| `g3-generated-transport-smoke` | **1 / 1** |
| `cs01-extension-a` | **6 / 6** |
| `g2-transport` | **16 / 16** |
| spot-check of five more registered modes (`g29-result-progress`, `g29-dependency-boundaries`, `g3-bulk-series`, `g3-suppression-retry`, `cs01-extension-composition`) | **18 / 18** — the progress-record modes are the ones the new parent-presence statement could have moved |
| `node scripts/run-typecheck.mjs` (whole estate, native) | **0 diagnostics, exit 0**, 5.1 GiB peak |
| core lane `--project=layer-*` | **2 failed / 8386 passed / 400 files** — the D-28 cache-SWR cell and the `contract-matrix` inventory cell, the latter failing on `tests/raptor3/candidate-handoff.test.ts`, a file this round never touched |
| `provider-sqlite3` + `provider-libsql` | **764 passed / 0 failed** |
| `tests/providers/local/sqlite3-nested-write.test.ts` + `sqlite3-polymorphic-batch.test.ts` | **234 passed / 1 skipped** (the skip is at `HEAD` too) |
| the five `parity-*.core.test.ts` + `bulk-insert-row-shapes.core.test.ts` | **148 / 148** |
| `lane-x-set-mutations` + `lane-x-route-seam` + `integration-staleness` | **15 / 15** |
| `tests/providers/docker/pg-nested-write-races.test.ts` (pg 55729) | 6 failed / 89 passed — **the same six** (D-29 + the five base `batch primary-key dataflow` cells), no new red from the raceability gate |
| `tests/providers/docker/mysql2.test.ts` (mysql 55730) | 4 failed / 80 passed / 1 skipped — **the same four** namespace-containment cells |
| `tests/providers/docker/mysql2-writes-raw.test.ts` — **merge** | 5 failed / 87 passed |
| `tests/providers/docker/mysql2-writes-raw.test.ts` — **pristine base `356254a2`** (worktree `/private/tmp/viborm-parity-base`, its own TMPDIR, same container, back to back) | **8 failed / 84 passed** |
| `cs01-extension-a` on the **pristine base** | **6 / 6** green with its own `3/3/3` pin |

## 2. The bisections, reproduced (not taken on trust)

Each hunk was reverted in the live file, the mode re-run, and the file restored
from a byte-exact scratchpad copy (`shasum` re-checked after every restore; the
worktree ends with exactly the author's five modified files and no untracked
additions).

| falsification | result |
| --- | --- |
| **F1** — `update()`'s `wholeValue(value)` question reverted to the shape test (`value === null \|\| typeof value !== "object" \|\| value instanceof Sql`) | `g2-baseline` **8 red**, every one `UnsupportedOperationError V8003 Cannot publish the updated value of 'book.isbn' / 'post.id' …` — exactly the eight cells the note attributes to lane Q's U4 |
| **F2** — the publication reverted (`published` → `written` at the three returns and the scratch assignment) | `g2-baseline` **9 red**, `g2-transport` **12+ red** — so the second half is load-bearing on its own and is not a redundant change |
| **F3** — the `isVibORMError(failure) && failure.meta.raceable === true` conjunct removed | `g2-baseline` **2 red**: `g2-upsert-skip-replaced` and `g2-upsert-skip-deleted`, both `AssertionError: Skipped or stale upsert must not change any row` — the retry-against-another-identity defect, verbatim |
| **F4** — the `ctx.requirePresent(parentRequirement…)` line removed | `g2-baseline` **1 red**: `g2-series-parent-reference-reused` answers `a member was added after the plan-time read; retry to converge.` where `parent record changed across a committed segment.` is owed |

**8 + 2 + 1 = 11.** The three causes account for every red `g2-baseline` cell
with nothing left over, which is the strongest form of the note's claim.

## 3. The changes against the rules

**R1a — `OperationContext.update` (`shared/operation-context.ts`).** One owner,
one question. `wholeValue` is the estate's single answer to "does this payload
name a value?" (`shared/query.ts:569`), already consumed by
`Queries.prepareUpdate` and `Assignments.named`; the physical owner now asks it
instead of re-deriving a shape. No policy boolean, no second walker, no per-verb
codec. The publication half is equally sound and is not new invention:
`OperationContext.create` already publishes only what it observed at `HEAD`, and
`CommandAttempt.read` falls back to `Assignments.stated` for every unobserved
field — `stated` reads `writes`, the same map `values()` submits from
(`contributions()` returns `this.writes`), so the submitted value and the
published value can never disagree. The only consumer of the return is
`execution.ts:304`'s `attempt.bind`; `associate()` and `program.ts:445` discard
it. Verified by reading, then by F1/F2.

**R1b — `submit()`'s attribution arm.** The mark is not invented: `meta.raceable`
is `PreparedGuardFailure.raceable` "fixed by the guard's premise class"
(`query-engine/types.ts:66-75`), materialised by `batch-error-attribution.ts`,
and `errors/base.ts:446` states the estate's rule verbatim — "the retry layer
above the executor re-runs the SPECIFIC raceable ones by their own marking". The
conjunct sits at the **only** site that arms `atomicAssertionRejection`
(`:1163`; `recoveryRejection` only reads it), which is where the integration's
round-2 resolution put the INSERT bound. The conditional-skip arm that must still
converge (`commands.ts:1218` `skip.meta.raceable = true`) does; the presence and
`match` premises that must not, do not. `integration-staleness` 3/3 and the pg
race file at its unchanged six reds confirm the raceable complement still
re-plans.

**R1c — `captureSeries` (`commands/execution.ts`).** `parentRequirement` is
assigned unconditionally inside `if (membership) { … }` (the only other exit is a
throw), so the added `parentRequirement &&` is TypeScript narrowing and **cannot**
silently drop the complement — I checked this specifically, because a dropped
`requireNoAddedMember` would have been a weakened guard hiding behind a green
run. No new query and no new sentence: the same `parentRequirement.query` and
`.failure` `executeSeries` already asserts per member. The unique coverage the
maintainer's rule demands is nameable and I confirm both halves: a zero-member
series queues no per-member copy at all, and F4 shows that even with members the
per-member copies ride *behind* the complement, so the ordering is the coverage.
The premise cannot fire falsely for a series under a freshly created parent: the
capture flushes, so the parent INSERT is committed before this statement is
queued (`g3-bulk-series`, `g29-*`, `cs01-*` all green).

**R3 — G3P-03 under D-31.** The conflict is real and public:
`tests/contracts/engine/query/bulk-insert-row-shapes.core.test.ts:16-27` pins
`$transaction([createMany({ data: [] })])` rejecting with `No data to insert`,
and the owner (`operation-context.ts:1645-1650`) refuses only under
`ownership === "batch-preparation"`. The re-expressed cell states the refusal on
both preparations, keeps the direct-route `{ count: 0 }` / `[]` (the zero-width
window, where it is still true) and adds a fact the old cell did not have — the
writable sibling member never reaches the driver (`driver.batches.length === 0`,
empty table). The file keeps its six cells, the other four still compose real
array batches, and the manifest count is unchanged (the gate verifies it).

**R6 — CS-01 under U6.2.** Verified as class (a) end to end: the pristine base
runs the SAME cell with its `3/3/3` pin green; the merged engine compiles the
nested `deleteMany` as one correlated statement per root member, which is exactly
what U6.2 of the plan specifies; the re-expressed cell pins `2/2/2` **and** the
plan that makes it so (two `DELETE … WHERE ("cs01_selection_nodes"."parentId" =
?`, no `SELECT` addressing the children — the second assertion is non-vacuous,
since the removed member-capture read would match it). The durability assertion
is untouched and still shows the child row deleted and the parent updated, so the
smaller number is not a lost effect.

**R8 — the MySQL cell.** Disproved by my own run, not by the receipts: on the
**pristine base** the same file is 8 red including
`concurrent nested connectOrCreate of a missing key converges to one row (tx)`
with `ER_LOCK_DEADLOCK (1213, 40001)`, and the merge's 5 reds are a strict subset
of the base's 8 (the three `MySQL2 nested write behavior` cells red at the base
are green on parity). Four different concurrency cells across two describe blocks
deadlock on both trees, including `concurrent plain upserts`, which carries no
nested write at all. Class (d), environmental. Nothing to repair.

## 4. Findings (all minor; none blocks)

1. **Nit, guide formatting.** `src/query-engine/raptor3/AGENTS.md:973` is 105
   characters — the only line over 88 this round added (the file had three, all
   pre-existing). Resolution: re-wrap the sentence ending
   `… and the ENVELOPE restart (`run`'s deferred arm, which runs` at the file's
   ~80-column width.
2. **Nit, formatting claim.** The note says the pre-existing `format` hunk in
   `operation-context.ts` is "byte-identical … none of them a line this round
   wrote". The *count* is equal (60 diff lines at `HEAD` and now, measured by me
   with `biome check` over copies of both revisions) and no new rule was
   triggered — `useTopLevelRegex` even drops 12 → 11 — but the hunk's identity
   moved onto a line the round wrote: the new import specifier `wholeValue`
   inherits the file's missing trailing comma, so Biome now names `wholeValue`
   where it named `returningSafeProjection`. Resolution (optional, one
   character): write `wholeValue,`; it removes two of the 60 lines and is the
   "fix by hand what you touched" reading.
3. **Disclosure to state in the note, R1b's true scope.** The gate delegates to
   the pre-existing `meta.raceable` marks, and only four sites set one. Two
   premises that armed the re-plan before this round no longer do, and neither
   has a registered witness: `captureMembership`'s "the captured membership is
   gone" **present** arm (`operation-context.ts:2461`, whose own sentence says
   "retry to converge" while its sibling `requireAbsent` arm IS marked), and the
   `absent` command's failure (`execution.ts:360`). Nothing reddened anywhere I
   ran, and leaving the first unmarked is defensible on the same identity
   argument that motivates the fix — but it is a new observable, and the note
   should list it beside the upsert premises rather than only naming those.
4. **Disclosure, R1a's true scope.** `wholeValue` calls anything that is not a
   plain-prototype operator record a whole value, so a DEMANDED **list**
   (`tags: ['a','b']`), JSON document or GeoPoint on the batch route no longer
   meets the V8003 refusal that both the pre-repair and the pre-U4 shape test
   raised for it. This is the correct rule — only a value the provider computes
   needs the int-only scratch — and it can publish no wrong answer, since the
   reader resolves the same value the row submits. It is still a narrowing of a
   registered refusal's domain with no cell. Suggested (not required): one arm on
   the V8003 pin — a demanded `{ increment: 1 }` on a string field still refuses,
   a demanded whole value does not.

## 5. Unverified by this review

- The 47 registered modes I did not re-run (I ran 12 of the 59 plus every estate
  lane); `RUN.log` shows 59 × `exit=0` and an empty `FAILURES.log`.
- The *attribution* of R6 to lane X alone: I verified the base is green with the
  old pin, that the merged plan is U6.2's by design, and that the new pin is
  live — I did not re-run the lane-X-only worktree.
- The cost of the extra parent-presence statement against the D-9 budget; no A/B
  was taken by the author and none by me.
- `provider-postgres`, `provider-pglite`, hosted-driver and migration projects,
  and every campaign/replay outside the FIXED group.

## 6. Write discipline

`/Users/arnaud/code/viborm` carries no source change (only the pre-existing dirty
docs and the untracked evidence). The merged worktree ends with exactly the five
files the note lists, no untracked additions, and both production files
byte-identical to the author's (sha1 re-checked after each falsification).
`/private/tmp/viborm-parity-base` was read and run, never written. Nothing was
committed, staged, reset, stashed or pushed. This file is the only thing I wrote.
