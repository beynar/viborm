# Parity repair round — the seven red raptor3 modes and the MySQL diff

Author: repair agent, 2026-09-17. Worktree `/private/tmp/viborm-parity-merge`
(branch `parity`, `HEAD = 7bb45348a`, nothing committed, staged, stashed or
reset), `TMPDIR=/private/tmp/viborm-parity-tmp-merge`. Receipts:
`docs/architecture/raptor3-evidence/g4/parity/receipts/repair/`.

Read in full before the first edit: `docs/architecture/raptor3-parity-plan.md`,
`g4/briefs/common.md` (the twelve rules), the merged
`src/query-engine/raptor3/AGENTS.md`, `g4/parity/lane-q-note.md`,
`lane-x-note.md`, `integration-note.md`, and the ledger's D-17..D-31.

Bisection worktrees (read-only, never written to): `/private/tmp/viborm-parity-base`
(`356254a2`, commit 5), `/private/tmp/viborm-parity-q` (`6827410d`, lane Q),
`/private/tmp/viborm-parity-x` (`bf6cf224`, lane X).

---

## Result

| | before | after |
| --- | --- | --- |
| raptor3 FIXED group (59 modes) | 52 green / **7 red** | **59 green / 0 red** |
| `g2-baseline` cells | 205/216 (**11** red, not the 3 the ledger named) | **216/216** |
| core lane (`layer-*`) | 2 red / 8386 passed | **2 red / 8386 passed** (the same two) |
| `provider-sqlite3` + `provider-libsql` | 764 passed / 0 red | **764 passed / 0 red** |
| `provider-pg` | 26 red, 0 regressions vs base | **26 red — the same set**, 0 regressions |
| `provider-mysql2` | 165 red, **1 regression** vs base | **165 red — the same set, 0 regressions** (the base re-measured red on the same cell) |
| whole-estate typecheck | 0 | **0 diagnostics, exit 0** |

Three production changes, two test re-expressions, one guide update. No `.skip`,
no `.only`, no deleted or weakened cell, no rewritten recording.

---

## Per red: bisection → class → change → receipt

### R1 — `g2-baseline`: eleven cells, three causes

The ledger named three (`g2-key-junction-modify`, `g2-key-junction-disconnect`,
`g2-upsert-skip-replaced`). The mode was **11 red**, and the base is
**216/216 green**, so every one of them is a parity regression.

**Bisection** (`receipts/repair/bisection/g2-baseline-*.log`):

| tree | red |
| --- | --- |
| `356254a2` (base) | **0** |
| `bf6cf224` (lane X alone) | **0** |
| `6827410d` (lane Q alone) | **8** — the four `keys-legacy`, the two `junctions-legacy`, the two `mixed-key-transitions-legacy` cells |
| merged `parity` | **11** — those 8 plus `g2-upsert-skip-replaced`, `g2-upsert-skip-deleted` and `g2-series-parent-reference-reused` |

Neither lane ran the registered raptor3 modes (both notes verify by provider
file), which is why these surfaced only at the final verification.

#### R1a — the eight lane-Q cells: U4 published the update envelope as a value

**Class (b), engine regression.** Introduced by lane Q's U4 (`6827410d`,
`commands/assignments.ts`): `Assignments` now stores the ADMITTED payload
verbatim, so `values[field]` is `{ set: '333' }` where the shipped storage-time
unwrap had left `'333'`. Two consumers in the physical owner read that payload
as if it were a value:

1. `OperationContext.update`'s batch publication loop tested the payload's
   SHAPE (`typeof value !== "object"`) to decide whether the value has to travel
   through the batch scratch. A `{ set: … }` envelope is an object, so every
   DEMANDED string key was treated as an operation and met the scratch's
   `int`-only refusal — the eight cells fail with
   `UnsupportedOperationError V8003: Cannot publish the updated value of
   'post.id' … the batch scratch reads back as an integer, and 'id' is a string
   field.` (`bisection/g2-baseline-merge-before-repair.log`).
2. the same method RETURNED `written` — the payloads it submitted — and
   `CommandAttempt.bind` makes that the published row, so a dependent reading a
   key would read `{ set: '333' }` instead of `'333'` (the bound row wins over
   `Assignments.stated`, which is the reader that resolves the envelope).

**Change** — `src/query-engine/raptor3/shared/operation-context.ts`, `update()`:

| | |
| --- | --- |
| **Required behaviour** | A DEMANDED field whose payload names a value needs no scratch and no capability refusal; only an operation the provider computes does. What an update publishes to its dependents is what it OBSERVED. |
| **Current owner** | `update()`'s `usesBatch` loop, and its three `return` sites. |
| **Smallest change** | the shape test becomes `if (wholeValue(value)) continue;` — the same owner U4 made the one unwrap rule (`shared/query.ts`), asked as a question rather than re-implemented; and a new `published` map carries the scratch expressions and the `RETURNING` row, which the three returns publish instead of `written`. `written` stays the verbatim assignment source, so `Queries.prepareUpdate` still interprets each payload exactly once. |
| **Invariant** | The payload is the update language, interpreted once; "which value will this field hold?" is the key-reconciliation reader's question, answered by `wholeValue`/`Assignments.stated` — never by a shape test and never by publishing the envelope. |
| **Falsifier** | `g2-baseline` 216/216 and `g2-contracts` 216/216 (both were 205/216); `parity-assignments.core.test.ts` 6/6 (U4's own falsifier, unchanged); `sqlite3-nested-write` 85/85. |

**Receipt.** `bisection/g2-baseline-merge-after-u4-publication.log` — 11 red → 3.

#### R1b — `g2-upsert-skip-replaced` / `g2-upsert-skip-deleted`: the batch re-plan answered a non-raceable premise

**Class (b), engine regression.** Introduced by the integration commit
(`4491892a`, U6.5 under D-25): `batchAttempt` re-plans the whole operation on
any ATTRIBUTED assertion rejection, and `submit` armed
`atomicAssertionRejection` for every attributed failure. A conditional-skip
upsert whose captured row is replaced or deleted fails its **presence** guard,
which the estate declares `raceable: false`
(`operation-context.ts` prepared guard, `write-engine/ATOM.md` "a non-raceable
presence guard proves that the complete selector still names the captured
primary key"). The re-plan then re-read the world, found the NEW row that now
answers `email = 'wanted'`, and applied the update to it (`count: 15` where the
cell owes `999`) or took the create arm (a new row `{42,'wanted',0}`) — exactly
what `transitions/conditional-upsert.ts` forbids: *"Captured-row replacement or
deletion must not permit a retry against another identity."*

**Change** — `operation-context.ts`, `submit()`'s attribution arm: the
allowance is armed only for a premise its own owner marked
`meta.raceable === true`. The mark is the estate's existing rule for this exact
question (`query-engine/batch-error-attribution.ts`: "the `raceable` mark is
what lets the routed retry re-plan and converge"; `errors/base.ts`: "the retry
layer above the executor re-runs the SPECIFIC raceable ones by their own
marking"), and it is fixed per premise class in `query-engine/types.ts`. Stated
at the site that RECORDS the evidence, which is where the integration's own
round-2 resolution A.1 put the INSERT bound. `CommandExecution.recover`'s
conditional arm is unaffected: the skip guard it answers marks itself raceable
(`commands/commands.ts`).

**Falsifier.** The two cells, plus `g2-upsert-setwhere-match-replaced` (the
non-raceable `match` premise) and the three `integration-staleness` cells (the
raceable complement, which must still re-plan).

**Receipt.** `bisection/g2-baseline-merge-after-raceability-gate.log` — 3 red → 1.

#### R1c — `g2-series-parent-reference-reused`: the complement guard preempted its own premise

**Class (b), engine regression.** Introduced by the integration commit
(`4491892a`, `requireNoAddedMember`). The complement rides the batch AHEAD of
the parent premise `executeSeries` queues per member, and it correlates the
membership by VALUE. When the captured parent's reference is taken over by
another row (`hub H1 → H3`, `h-other H2 → H1`), that other parent's members
answer the same correlation, the complement reads them as additions, and the
operation answered `Cannot update relation 'spokes': a member was added after
the plan-time read; retry to converge.` where the shipped engine — and the
registered cell — owe `parent record changed across a committed segment.`

**Change** — `src/query-engine/raptor3/commands/execution.ts`, `captureSeries`:

| | |
| --- | --- |
| **Required behaviour** | The complement's claim is about THIS parent's set, so the premise that says "this parent" is proved in the same batch, ahead of it. |
| **Current owner** | `captureSeries` builds `parentRequirement` (query + sentence) and `executeSeries` asserts it per member; nothing asserted it before the complement. |
| **Smallest change** | `ctx.requirePresent(parentRequirement.query, parentRequirement.failure)` immediately before `requireNoAddedMember`, with the guard now emitted only when that premise exists (it always did — both are conditioned on the same membership). No new query, no new sentence, no second owner. |
| **Invariant** | A captured set's complement rides behind the premise it depends on; a parent reference reused between the capture and the batch refuses with the parent's own sentence. |
| **Unique coverage (Arnaud's "no redundant guard" rule)** | A series that captured ZERO members queues none of the per-member copies, so this is the only parent premise it has; and it is the only one that precedes the complement — the batch's first statement. The per-member copies are the shipped shape and are untouched: each member may follow a committed segment, which is what their sentence says. |
| **Falsifier** | `g2-baseline`/`g2-contracts` `g2-series-*` (4 cells each), `integration-staleness.test.ts` 3/3 (the complement still names the captured keys and still re-plans), `pg-nested-write-races` unchanged at its 6 base reds. |

**Plan change, stated:** a batched relation-bearing series now carries one more
statement — the parent presence assertion — as the batch's first. Measured
against every recording in the FIXED group: no replay, transport script or
statement-count pin moved (59/59 green, `receipts/repair/fixed/RUN.log`).

**Receipt.** `bisection/g2-baseline-merge-after-parent-premise.log` — 216/216.

---

### R2 — `g2-contracts` (`g2-upsert-skip-replaced`, `count: 15` where `999` is owed)

**Bisection.** The same scenarios on the Commands arm; the same three causes as
R1. **Class (b)**, no change of its own. **Receipt.** `receipts/repair/fixed/g2-contracts.log`
— 216/216.

---

### R3 — `g3p03-contracts`: an empty set package versus the restored public refusal

**Bisection.** `tests/raptor3/prep/set-preparation.test.ts` › *keeps an empty set
package complete with a zero-width result window* pinned that a batch-prepared
`createMany { data: [] }` publishes a zero-statement package. The parity program
restored the shipped engine's refusal on that seam (U1.4 / integration piece 1b,
`operation-context.ts` `createMany`: `batch-preparation` raises
`No data to insert for createMany.`, every other ownership keeps Prisma's
`{ count: 0 }`), pinned publicly by
`tests/contracts/engine/query/bulk-insert-row-shapes.core.test.ts`.

**Class (c), contract conflict** — a registered raptor3 pin of candidate-only
behaviour against a restored public refusal. **Arnaud's integrator decision D-31
applied: the public refusal wins and the cell is re-expressed.**

**Change** — the cell keeps its subject (an array whose member submits no row)
and states the new answer: both preparations reject with the registered
sentence; the DIRECT call still answers `{ count: 0 }` and `[]` (the zero-width
result window, where it is still true); and the two-member array rejects during
preparation with `driver.batches.length === 0` and an empty table — the sibling
member that CAN be written never reaches the driver. Renamed to *refuses an
empty set package at preparation, before any batch*; the file keeps its six
cells and the manifest count is unchanged.

**Receipt.** `receipts/repair/fixed/g3p03-contracts.log` — 6/6.

---

### R4 / R5 — `g3-generated-smoke` and `g3-generated-transport-smoke`

**Bisection.** Both are C08–C11 matrix replays over a `book` model whose
`isbn`/`code`/`region` string keys are demanded by dependents — the R1a shape.
`g3-generated-recurrence:final-world` showed the whole seed-8015 operation
writing nothing (the V8003 refusal aborted it), and the transport smoke's
`Unconsumed explicit replies: g3-c11-8015-0` is the same operation never
reaching its scripted statement.

**Class (b) collateral of R1a.** No recording was regenerated and no corpus was
re-expressed: both replays match their recorded physical plan again once the
engine stops refusing.

**Receipts.** `receipts/repair/fixed/g3-generated-smoke.log` (6/6),
`g3-generated-transport-smoke.log` (1/1).

---

### R6 — `cs01-extension-a`: the acknowledged-progress record

**Bisection** (`bisection/cs01-extension-a-lane-x.log`): green at the base,
**red on lane X alone** with the identical numbers (2/2/2 where 3/3/3 was
pinned), so it is lane X's U6.2 — *a nested set mutation is one correlated
statement*. The nested `children: { deleteMany: {} }` is no longer a captured
series with members of its own; it is one correlated `DELETE` inside its parent
member's body. The operation's members are therefore the two root rows.

**Class (a), a pin of the pre-parity physical plan that a unit changed by
design.** Re-expressed, not weakened: the cell now pins `2/2/2` AND the plan
that makes it so, captured live from the merged tree
(`DELETE FROM "cs01_selection_nodes" WHERE ("cs01_selection_nodes"."parentId" = ?` —
one per root member — and no `SELECT` addressing the children). The database
state assertion, which is the durability fact, is unchanged and still passes.

**Receipt.** `receipts/repair/fixed/cs01-extension-a.log` — 6/6.

---

### R7 — `g2-transport` (all sixteen cells, not the four named)

**Bisection.** Every `scripted-returning-weak` and `scripted-returning-ack` cell
publishes a final key through the batch scratch — the R1a shape again.

**Class (b) collateral of R1a.** The recorded transport scripts are untouched.

**Receipt.** `receipts/repair/fixed/g2-transport.log` — 16/16.

---

### R8 — the MySQL diff's one regression: `concurrent nested connectOrCreate of a missing key converges to one row (tx)`

**Bisection — it is not a parity regression.** The cell fails with MySQL's own
`ER_LOCK_DEADLOCK` (1213, `TransactionError: Transaction deadlock detected`),
and it fails that way on the PRISTINE BASE in this session:

| tree | isolated runs | whole-file run | whole-project run |
| --- | --- | --- | --- |
| `356254a2` base | **3/3 red** | **red** (8 red / 84 passed) | **red** (219 red / 521 passed) |
| merged `parity` | **3/3 red** | **red** (5 red / 87 passed — a strict SUBSET of the base's) | **red** (165 red / 575 passed) |

Re-running the base comparison with the same methodology as the original
receipt (whole `provider-mysql2` project, base worktree then merged worktree,
same container, back to back):

```
base  219 red
merge 165 red
REGRESSIONS (red on merge, green at base): 0
```

**Class (d), environmental.** The container has been up for days and four
concurrency cells in that file (`concurrent plain upserts`, `concurrent fallback
upserts`, `concurrent upsert of a missing key`, `concurrent nested
connectOrCreate`) now deadlock on both trees; the receipt's base run caught this
one on a lucky side of the race (its own base run already had the sibling
`concurrent upsert` cell red, and parity had both). The engine's locking
footprint for this shape is unchanged by the parity units — the plan-time
decision read takes `FOR UPDATE` on the missing row on the transaction route at
the base and on parity alike. No change made; reported in "still red".

**Receipts.** `bisection/mysql-connectOrCreate-merge-isolated.log`,
`bisection/mysql2-writes-raw-{base,merge}-wholefile.log`,
`estate/provider-mysql-{base,merge}.log`, `estate/{base,merge}-mysql-red*.txt`.

---

## The guide

`src/query-engine/raptor3/AGENTS.md` states the three invariants this round
restores, at the paragraphs that already own each fact: the one-interpreter
paragraph now says the physical owner asks `wholeValue` and publishes what it
OBSERVED; the recovery paragraph says RACEABLE is read off the premise's own
mark; the captured-set paragraph says the complement rides behind its parent
premise. No sentence is stated twice.

---

## Verification

One file or one mode per call, bounded runner,
`TMPDIR=/private/tmp/viborm-parity-tmp-merge`, never two at once.

| target | result | receipt |
| --- | --- | --- |
| raptor3 FIXED group, all 59 modes | **59 green / 0 red** (was 52/7) | `receipts/repair/fixed/RUN.log`, `FAILURES.log` (empty) |
| `node scripts/run-typecheck.mjs` (whole estate) | **0 diagnostics, exit 0** | `verification/typecheck.log` |
| core lane `--project='layer-*'` | 2 failed / **8386 passed** — the same two the integration recorded (D-28 cache-SWR, the pre-existing `contract-matrix` inventory cell) | `estate/core.log` |
| `provider-sqlite3` + `provider-libsql` | **764 passed / 0 failed** | `estate/provider-local.log` |
| `tests/providers/local/sqlite3-nested-write.test.ts` | **85/85** | `verification/sqlite3-nested-write.log` |
| `tests/providers/local/sqlite3-polymorphic-batch.test.ts` | **149 passed / 1 skipped** | `verification/sqlite3-polymorphic-batch.log` |
| `tests/providers/local/sqlite3-returning-json.test.ts` | **176/176** | `verification/sqlite3-returning-json.log` |
| the five `parity-*.core.test.ts` + `bulk-insert-row-shapes` | **148/148** | `verification/parity-core-falsifiers.log` |
| `lane-x-set-mutations` + `lane-x-route-seam` + `integration-staleness` | **15/15** | `verification/parity-lane-x-and-integration-pins.log` |
| `tests/providers/docker/pg-nested-write-races.test.ts` (pg 55729) | 6 failed / 89 passed — **the same six** (D-29 staleness + the five base `batch primary-key dataflow` cells) | `verification/pg-nested-write-races.log` |
| `tests/providers/docker/mysql2.test.ts` (mysql 55730) | 4 failed / 80 passed / 1 skipped — **the same four** `MySQL namespace containment` cells | `verification/mysql2.log` |
| whole `provider-pg` project | 26 red — **identical to the pre-repair parity run**, 0 regressions vs the recorded base | `estate/provider-pg-merge.log`, `estate/merge-pg-red.txt` |
| whole `provider-mysql2` project, merged vs base back to back | 165 vs 219 — **0 regressions** | `estate/provider-mysql-{merge,base}.log` |
| modes named in the brief: `g2-contracts`, `g2-generated`, `g4-unit02-author`, `g3-bulk-series`, `g29-result-progress` | 216/216, 52/52, 130/130, 6/6, 2/2 | `receipts/repair/fixed/` |

`npx biome check` on the four touched files, compared against the SAME files at
`HEAD` (the pre-repair content, checked the same way): every rule count is equal
or lower — `noMisplacedAssertion` 8 → 8, `useTopLevelRegex` 12 → **11**,
`useImportType` 0 → 0 (the `Sql` import became `import { type Sql, sql }` because
the shape test that used it as a value is gone), and `operation-context.ts`'s one
pre-existing `format` hunk is byte-identical (60 diff lines on both sides, none
of them a line this round wrote). Receipts `verification/biome-base.counts`,
`verification/biome-after-repair.counts`.

---

## Files changed

| file | change |
| --- | --- |
| `src/query-engine/raptor3/shared/operation-context.ts` | R1a (the `wholeValue` question and the `published` row), R1b (the raceability conjunct) |
| `src/query-engine/raptor3/commands/execution.ts` | R1c (the parent premise ahead of the complement) |
| `src/query-engine/raptor3/AGENTS.md` | the three invariants, at the paragraphs that own them |
| `tests/raptor3/prep/set-preparation.test.ts` | R3 — the G3P-03 cell re-expressed under D-31 |
| `tests/raptor3/core-structure/extension-a.contract.test.ts` | R6 — the CS-01 progress pin re-expressed under U6.2, with the new plan pinned |

Nothing was committed, staged, stashed or reset; `/Users/arnaud/code/viborm`,
`/private/tmp/viborm-parity-base`, `-q` and `-x` were never written to (this note
and its receipts are the only files written outside the merged worktree).

---

## Still red, each with its reason

1. `tests/contracts/public-client/official-cache-swr.core.test.ts` › *contains
   provider, snapshot, set, and cleanup failures* — **D-28**, unchanged and not
   touched here: it needs the other half of D-17 (a consumer for
   `DriverResultParser.parseResult`, which has none in `src/`) and a read-path
   invocation of a `json()` field's user schema. Both are decisions for Arnaud.
2. `tests/contracts/architecture/contract-matrix.core.test.ts` › *inventories
   every executable test by owner and boundary* — pre-existing: `tests/inventory.ts`
   classifies no file under `tests/raptor3/`.
3. `tests/providers/docker/pg-nested-write-races.test.ts` › the D-29 staleness
   cell — unchanged: the harness plants its concurrent member before the
   plan-time read on this engine's statement shape. The guard and the recovery
   are pinned deterministically by `integration-staleness.test.ts`.
4. the five pg `batch-only batch primary-key dataflow` cells — red at the
   pre-parity base, named by no unit of the plan.
5. the four `MySQL namespace containment` cells — red at the base,
   environmental (every lane drops and recreates tables in the shared container).
6. `mysql2 nested-write concurrency behavior` › *concurrent nested
   connectOrCreate …* and *concurrent upsert …*, and the two
   `MySQL2 upsert atomicity behavior` concurrency cells — R8 above:
   `ER_LOCK_DEADLOCK` on the shared container, measured red on the pristine base
   in the same session, 0 regressions across the whole project.

## Unverified by this round

- The whole `provider-postgres`, `provider-pglite`, hosted-driver and
  migration projects, `mysql2-relations-ddl` beyond its share of the
  whole-project run, and every campaign/replay outside the FIXED group — not run,
  by the "minimum tests" instruction (the FIXED group, the core lane, both local
  provider lanes and both Docker projects WERE run in full).
- The cost of the extra parent-presence statement against the D-9 budget: one
  additional assertion per batched relation-bearing series; no A/B was taken.
- Whether the MySQL container's deadlock state is recoverable by restarting the
  container — not attempted, because restarting it would destroy the comparison
  basis the base-compare receipts rest on.
