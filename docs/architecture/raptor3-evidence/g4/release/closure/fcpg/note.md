# FCPG — the captured set's consumption-time contract on native PostgreSQL

Unit FCPG of the final closure program, the concurrency half of FC-03. Author:
Fable, worktree `/private/tmp/viborm-fcpg`, branch `fcpg` from `29a7bf9d8`.
**Witness lane: tests and this note, no engine change** (`git diff 29a7bf9d8 --
src/` is empty).

FC-03 records the concern as *unexecuted*: "ordinary EXISTS premises followed by
an ID-only mutation do not alone prove the relevant membership still holds when
the effect executes". It is executed here, on real multi-connection PostgreSQL
16.4, against a contract established from the source **before** any schedule was
run.

---

## 1. The contract, established first

Read off the owners themselves — `OperationContext.requireCapturedSet` /
`captureMutationIdentities` (`shared/operation-context.ts:2493-2560`),
`CommandExecution.requireNoAddedMember` / `captureSeries`
(`commands/execution.ts:924-1066`), and the guide's captured-set and premise
paragraphs (`src/query-engine/raptor3/AGENTS.md:1306-1340`, `:1424-1460`):

| | the claim | its kind |
|---|---|---|
| **R1** | every captured row is **still present and still a member of the selection** — stated as `requirePresent` statements **inside the mutation's own batch, ahead of the write** | REQUIREMENT, at that position |
| **R2** | **no row has joined** the selection — one `requireAbsent` over `selector ∧ key ∉ captured`, claimed **only for an unlimited capture**; a limited capture took one valid slice, so its filter is an OBSERVATION and the complement is not claimed | REQUIREMENT (unlimited) / OBSERVATION (limited) |
| **R3** | on the **interactive route** no premise is stated at all: "an interactive session takes `FOR UPDATE` and the capture is protected by the lock it holds until the mutation" | REQUIREMENT, held by the lock |
| **R4** | the mutation's own row count equals the captured count, else `<verb> selected-row cardinality changed during its locked mutation.` — "the detection it always was" | DETECTION, after the effect |
| **C2** | a captured MEMBER set is an assertion about the rows it does not contain: `connected ∧ filter ∧ key ∉ captured` is EMPTY, one raceable `requireAbsent` in the same batch behind the series' own parent premise, plus each captured member's presence | REQUIREMENT, at that position |

**The decisive reading.** Every one of these sentences places its claim **at a
position** — "inside the atomic unit, ahead of the write" — and none of them says
"at the effect". AGENTS.md is careful about the bound it claims: "a member
committed **between the plan-time read and the atomic unit** aborts that unit
instead of being silently missed". The source comment on `requireCapturedSet`
is the one sentence that reads as a promise about the effect: "every captured
row is STILL PRESENT and STILL A MEMBER of the selection … A stale observation
aborts the atomic unit before anything is written."

So the contract has **two candidate readings**, and which one is binding is the
decision this unit surfaces (§4).

The lasting/observation distinction FC-03 asks to preserve is already visible in
the code and is preserved by every cell below: R2 is a requirement only for an
unlimited capture, and a **limited** capture's filter is an observation (the
`if (limit !== undefined) return;` arm).

---

## 2. The lane, and what is native about it

- Real PostgreSQL **16.4** through `@drivers/pg`, two and three real connections
  per cell, real row locks. Gated by `PG_TEST_CONNECTION_STRING` exactly like its
  `tests/providers/docker/pg*.test.ts` siblings; the value was substituted into
  one command per run and never printed, logged or copied.
- **Its own database.** The cells run in `fcpg_closure`, created once on the same
  server from that connection string. `syncLiveSchema` diffs against live
  introspection, so pushing this file's three models into the shared database
  would plan a **drop for every table that is not one of them** — which would
  destroy a sibling unit's tables. Tables are `fcpg_`-prefixed and dropped by
  name in `beforeEach`; `dropEveryLiveTable` is deliberately not used.
- **The capture route has to be reached.** On PostgreSQL's own RETURNING route a
  selected `deleteMany` never captures (`returningSafeProjection` is true for a
  scalar projection) and `updateMany` never captures at all. The consumer-1 cells
  therefore run a **capability-forced non-RETURNING** pg driver — the MySQL /
  PlanetScale profile, executed against real PostgreSQL so that the concurrency,
  the locks and the statements are real. Consumer 2 needs no such forcing: a
  junction-edge nested `deleteMany` captures a series on the batch route with
  RETURNING intact. (A forced capability is not a native-MySQL receipt; see §7.)
- **The interleavings are ordered, not invented.** `PgWindowedBatchDriver` splits
  ONE atomic batch at the boundary between its last premise and its first write
  and lets connection B commit there — on the same connection, inside the same
  transaction the engine asked for. PostgreSQL READ COMMITTED takes a fresh
  snapshot per statement, so a commit landing between two statements of one
  transaction is ordinary substrate behaviour; the hook only makes the moment
  deterministic. The two lock-held schedules use **no hook at all**: B holds an
  uncommitted row lock, A blocks on it (the cell asserts that it really blocked,
  by polling `pg_locks WHERE NOT granted`), and B commits while A's mutation
  waits.
- The measured statement shape of each atomic unit is asserted, so a cell cannot
  pass against a unit that carries no premises: consumer 1 `[4 statements, 3
  premises ahead of the first write]` (two presence premises + the complement,
  then the ID-only DELETE); consumer 2 `[7, 6]`.

---

## 3. The schedules and their results

`tests/providers/docker/pg-captured-set-concurrency.test.ts`, 10 cells, all
green. A = the operation under test, B = a second real connection.

### Consumer 1 — a root selected bulk mutation with a captured set

Seed: `fcpg_notes` = n1(active), n2(active), n3(inactive). Operation:
`note.deleteMany({ where: { active: true }, select: { id, label } })`.

| # | schedule | observed | reading |
|---|---|---|---|
| 1 | **interactive route**, lock held: B `UPDATE n1 SET active=false` uncommitted → A's capture `SELECT … FOR UPDATE` **blocks** → B commits → A resumes | A captured only n2; published `[n2]`; n1 and n3 remain | **R3 HELD.** The lock is what protects the capture: PostgreSQL re-evaluates the capture's predicate against the row version B committed, so n1 was never captured |
| 2 | **batch route**, the same lock schedule: capture and premises read the OLD committed row and pass; the **ID-only DELETE** blocks; B commits; the DELETE proceeds | published `[n1, n2]`; **n1 deleted although `active=false` when the DELETE executed**; row count matched, so R4 said nothing | R1-positional HELD; R1-at-the-effect VIOLATED |
| 3 | **batch route**, hook: B commits `n1.active=false` **between the unit's last premise and its first write** | same as 2: n1 deleted | idem, with the window made exact |
| 4 | **batch route**, hook: B commits a **new** active row n4 in the same window | n4 not deleted, nothing aborted, n4 still active | R2-positional HELD; a joiner inside the unit is not claimed |
| 5 | **batch route**, hook: B commits `DELETE n1` **before the unit's first premise** | the unit **aborts** with `deleteMany selected-row cardinality changed during its locked mutation.` and writes nothing (n2 survives) | the guard is live at the window it claims |
| 6 | **control**, hook: B renames n3 (never in the selection) in the window | n1, n2 deleted, n3 intact with its new label, no abort | an irrelevant change is irrelevant |

### Consumer 2 — a nested captured deletion under a membership

Seed: `fcpg_teams` t1 with junction members m1(active), m2(active); m3(active,
unconnected). Operation: `team.update({ where: { id: "t1" }, data: { members: {
deleteMany: { active: true } } } })` on the batch route (a junction edge — a
reference-edge nested `deleteMany` is one correlated `SetMutation` with nothing
captured and no window at all).

| # | schedule | observed | reading |
|---|---|---|---|
| 7 | B connects m3 **before the unit's first premise** | the complement **aborts** the unit raceably and the one recovery re-plans against the larger set and **converges**: all three members deleted, none connected | C2 is live and in this unit — which is what makes cell 8 a genuine miss rather than a missing guard |
| 8 | B connects m3 **between the complement premise and the first write** | m1, m2 deleted; **m3 survives, still connected to t1, still matching the filter**; the operation reports success | C2-positional HELD; C2-at-the-effect VIOLATED |
| 9 | B commits `m1.active=false` in the same window | m1 deleted anyway — the member is located by the key the capture named, so the filter it no longer satisfies is not re-read at the effect | idem |
| 10 | **control**: B renames the unconnected m3 in the window | m1, m2 deleted, m3 intact with its new label, no abort | an irrelevant change is irrelevant |

---

## 4. Verdict per consumer

**Consumer 1, interactive route (the native PostgreSQL default): CONTRACT
HELD.** R3 is exactly true and cell 1 pins it; the falsification below shows the
cell fails the moment `FOR UPDATE` is dropped.

**Consumer 1, batch route: AMBIGUOUS — a decision for Arnaud.**
**Consumer 2 (batch route by construction): AMBIGUOUS — the same ambiguity.**

Both consumers do exactly what their sentences say, at the position their
sentences name, and both leave one window open: **between the unit's last
premise and its first write**, on a route that holds no lock, the effect is
located by identity alone and is not re-tested against the predicate it was
selected by.

The two readings and their costs:

- **Reading A — positional (what the code and the guide actually say).** The
  premise is asserted inside the atomic unit ahead of the write and the engine
  claims no more. Nothing is broken; this unit's cells become the record of the
  bound. **Cost:** a batch-route `deleteMany`/`updateMany` can remove or change a
  row that stopped matching its own `where`, and a nested captured `deleteMany`
  can miss a member that joined, both silently (R4's row count cannot see either:
  the count is right). One sentence has to be corrected to match: the source
  comment on `requireCapturedSet` reads as a promise about the effect ("STILL
  PRESENT and STILL A MEMBER") where the mechanism is positional. AGENTS.md's own
  wording is already correctly bounded ("between the plan-time read and the
  atomic unit") and needs nothing.
- **Reading B — a lasting requirement at the effect.** Then the batch route
  violates it today, on both consumers. **Cost:** the cheapest shape that would
  close it is to let the ID-located mutation carry its own selector — `identity ∧
  selector` in the mutation's WHERE — so the effect re-tests membership at its
  own position; one statement, no new lock, no new protocol, and it stays inside
  the two owners FC-03 already names. But it **changes what R4 means**: a row
  that stopped matching turns a successful operation into `… cardinality changed
  …`, which is a numerical-semantics and public-contract change. For consumer 2
  the complement has no such cheap form at all: no predicate on the delete can
  notice a member that joined after the complement ran. FC-03 forbids the blunt
  instruments (blanket `FOR UPDATE`, serializable isolation, a post-commit count
  check as rollback), and correctly.

Per the common rules this is a public-contract / numerical-semantics question,
so it is reported as a **blocker**: the repair, if any, is a separate
decision-bearing unit. **Candidate owners if reading B is chosen:**
`OperationContext.requireCapturedSet` + `captureMutationIdentities`
(`shared/operation-context.ts:2493-2560`) for consumer 1, and
`CommandExecution.requireNoAddedMember` + `captureSeries`
(`commands/execution.ts:924-1066`) for consumer 2 — the same two owners FC-03's
predicate half already touches.

**Minimized schedules, for the decision:**

```
-- consumer 1, batch route, no hook needed
B: BEGIN; UPDATE fcpg_notes SET active=false WHERE id='n1';      -- held
A: (capture)  SELECT id FROM fcpg_notes WHERE active            -- {n1,n2}
A: (premise)  SELECT 1 … WHERE active AND id='n1' LIMIT 1        -- passes
A: (premise)  SELECT 1 … WHERE active AND id='n2' LIMIT 1        -- passes
A: (premise)  SELECT 1 … WHERE active AND id NOT IN (n1,n2)      -- empty
A: (write)    DELETE FROM fcpg_notes WHERE id='n1' OR id='n2'    -- BLOCKS
B: COMMIT;                                                       -- n1 inactive
A:            … 2 rows deleted, row count matches, success
```

```
-- consumer 2, batch route
A: (capture)  the connected ∧ filter members of t1               -- {m1,m2}
A: (premises) parent premise, each member's presence, and
              connected ∧ filter ∧ key ∉ {m1,m2} is EMPTY        -- passes
B: connect m3 (already active) to t1, COMMIT                     -- in the window
A: (writes)   delete m1, m2 by identity                          -- success
              m3 remains connected and matching
```

---

## 5. Falsification

Each by the backup-copy recipe (`cp` to `$TMPDIR`, mutate, run the one
discriminating cell, restore by `cp`); the engine is byte-identical to
`29a7bf9d8` afterwards.

| mutation (backup copy) | cell | result | receipt |
|---|---|---|---|
| `captureMutationIdentities`: `forUpdate: !this.usesBatch` → `forUpdate: false` | 1 | **fails**: the interactive route now publishes `[n1, n2]` — exactly the batch route's answer. The cell pins the `FOR UPDATE` fact, not a coincidence | `receipts/falsify-forupdate.log` |
| `requireCapturedSet`: the `requirePresent` loop deleted | 5 | **fails**: the unit's shape drops from `[4, 3]` to `[2, 1]`. Honest detail: the cell's *rejection* still happens — R4's row count catches the deleted row after the write — so the **shape assertion**, not the thrown sentence, is what discriminates the premises | `receipts/falsify-premises.log` |
| `captureSeries`: the `requireNoAddedMember` call deleted | 7, 8, 9 | **fails**: cell 7 no longer aborts or converges (m3 survives), and the window cells' shape drops from `[7, 6]` to `[6, 5]` | `receipts/falsify-added-member.log` |

---

## 6. Runs, registration and measures

**Registration.** None to add: `vitest.workspace.ts:215` registers the pg
provider project by glob — `providerProject("pg", ["tests/providers/docker/pg*.test.ts"])`
— so `pg-captured-set-concurrency.test.ts` joins project `provider-pg` by its
name. No `scripts/raptor3-manifest.mjs` change (that file was not edited), and
no credential-free list mentions any `tests/providers/docker/pg*` file: the suite
is provider-gated by `PG_TEST_CONNECTION_STRING` like all of its siblings.

| run | result |
|---|---|
| `tests/providers/docker/pg-captured-set-concurrency.test.ts` (`--project provider-pg`) | **10 / 10 passed**, four consecutive green runs (11.53 s, 20.95 s, 13.29 s, 11.46 s wall; 452–512 MiB peak sampled RSS, teardown verified each time; the last one on the tree restored after the falsifications) — `receipts/run-final.log` |
| the existing pg pin for a captured member set: `pg-nested-write-races.test.ts -t "filtered m2m deleteMany staleness"` | **1 / 1 passed**, 94 skipped — the lane is healthy (`receipts/run-lane.log`) |
| `node scripts/run-typecheck.mjs` (whole estate) | **0 diagnostics** (`receipts/typecheck.log`) |
| `node_modules/.bin/biome check <the new file>` | clean, 0 findings (`receipts/biome.log`). No file that existed at the base was changed, so no base-copy comparison applies |
| `node scripts/query-engine-structure.mjs` | `tokenLines` **16036 before and after** — no engine file touched (`receipts/query-engine-structure.json`) |
| census | not run: no refusal, error class or sentence was touched. Public count is unchanged at 23 by construction |

No wide run, no fixed lane, no `g1-compare` / `g2-baseline`, one vitest at a
time, and nothing was committed, staged, checked out or formatted except the new
file (`biome format --write` on a file that has no base copy).

---

## 7. Unverified

- The consumer-1 cells reach the capture route through a **capability-forced**
  non-RETURNING pg driver. The concurrency, the locks, the statements and the
  provider are native; the capability profile is not. This is not a native MySQL
  or PlanetScale receipt, and the handoff's own caution about forced non-RETURNING
  execution applies.
- The window is executed on a batch route **simulated over PostgreSQL** (no
  interactive transaction, one native atomic batch in one real transaction).
  Whether D1, PlanetScale or Neon expose the same premise→effect window over
  their own batch protocols is not measured here; their batches are atomic and
  each statement answers against its own committed view, so the window is
  expected, not proven.
- The hook splits one atomic batch into two `executeBatch` calls on the same
  connection and transaction. Statement-index attribution for a rejection inside
  a split batch is therefore not the shipped one; no cell asserts an attribution,
  and the one cell that asserts a rejection (5) uses the unsplit
  `before-premises` placement.
- `updateMany`'s captured branch is not separately witnessed: it is the same
  `requireCapturedSet` call with the same arguments, one `UPDATE … WHERE id IN`
  in place of the `DELETE`, and its sentence differs only in the verb.
- A **limited** capture's observation arm (`limit !== undefined`, no complement)
  is read from the source and stated in §1, not executed here: FC-03's predicate
  half owns the limited-capture proofs.

## 8. Blockers

1. **The consumption-time reading of R1 / R2 / C2 is ambiguous and needs
   Arnaud's decision** (§4): positional (nothing is broken, one source comment is
   corrected, the residual is recorded) versus lasting-at-the-effect (both
   consumers violate it today; the cheapest closure changes what R4's row count
   means, and consumer 2's complement has no cheap closure at all). No engine
   change was attempted: the repair, if any, is a separate decision-bearing unit,
   and this unit's ten cells are the executed evidence it needs.

Nothing else. No test was deleted, skipped or weakened; no integrity or
provider-result requirement was removed; no public sentence was added or changed.

---

```
test(raptor3): the captured set's consumption-time contract, executed on native PostgreSQL (FCPG)

FC-03 left the concurrency concern unexecuted: ordinary EXISTS premises
followed by an ID-only mutation do not by themselves prove the membership
still holds when the effect runs. This establishes the contract from its
owners first — requireCapturedSet's premises and requireNoAddedMember's
complement each claim their predicate AT A POSITION, inside the atomic unit
ahead of the write, and the interactive route claims nothing because its
capture took FOR UPDATE — and then measures it with real schedules on real
PostgreSQL 16.4 over two and three connections.

Ten cells in their own database on the same server (syncLiveSchema diffs
against live introspection, so a shared database would plan a drop for every
foreign table), covering both consumers plus controls:

- the interactive route holds: with B's row lock held uncommitted, the
  capture's FOR UPDATE blocks, re-reads the version B committed, and the row
  that stopped matching is never captured and never deleted;
- the batch route leaves one window open, on both consumers: between the
  unit's last premise and its first write, a row that stops matching is still
  mutated by identity and a member that joins is still missed, with the row
  count matching and the operation reporting success;
- the guards are live at the window they claim: a captured row removed before
  the premises aborts the unit with its registered sentence and writes
  nothing, and a member added before the premises aborts the complement
  raceably and the one recovery converges;
- an irrelevant concurrent change is irrelevant, on both consumers.

No engine change: the reading of those premises as a lasting requirement
rather than a positional one is a public-contract decision, recorded as a
blocker with both readings, their costs and the candidate owners.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
