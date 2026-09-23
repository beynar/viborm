# R2c — the precise MySQL deadlock policy

Branch `closure-r2c` from `cdd787ac8`, worktree `/private/tmp/viborm-r2c`,
MySQL 8.4.11 (`raptor3_g2`, REPEATABLE READ, `innodb_lock_wait_timeout=50`,
`innodb_deadlock_detect=1`). Receipts: `receipts/`.

## 1. The failing witness

Four recorded cells in `tests/providers/docker/mysql2-writes-raw.test.ts`, all
four reproduced red on the base tree (`receipts/repro-four-cells.log`):

| cell | failure |
| --- | --- |
| `MySQL2 upsert atomicity behavior › concurrent plain upserts of the same missing key both succeed` | `TransactionError: Transaction deadlock detected` / `ER_LOCK_DEADLOCK` 1213 / `40001` |
| `… › concurrent fallback upserts of the same missing key both succeed` | same |
| `mysql2 nested-write concurrency behavior › concurrent upsert of a missing key converges to one row (tx)` | same |
| `… › concurrent nested connectOrCreate of a missing key converges to one row` | same |

## 2. The causal schedule, measured

The statement stream is the server's own general log (`log_output=TABLE`,
prepared statements included, then turned off again):
`receipts/genlog-cell1-all.tsv` (cell 1) and `receipts/genlog-cell4-all.tsv`
(cell 4). Both are the same shape — cell 1 races a UNIQUE secondary key, cell 4
races the PRIMARY key:

```
T63 START TRANSACTION                  T62 START TRANSACTION
T63 SELECT … WHERE name = 'plain-race' … LIMIT 1 FOR UPDATE   -> 0 rows
T62 SELECT … WHERE name = 'plain-race' … LIMIT 1 FOR UPDATE   -> 0 rows
T62 INSERT … ('plain-race-2','plain-race',2)
T63 INSERT … ('plain-race-1','plain-race',1)
T63 ROLLBACK                           (victim)
```

The locks under that schedule, reproduced on an isolated table through
`performance_schema.data_locks` plus the server's own deadlock record
(`receipts/schedule-forupdate.txt`, harness in `receipts/harness/`):

| step | lock |
| --- | --- |
| A's probe (0 rows) | `RECORD X GRANTED idx=<unique key> data=supremum pseudo-record` — a **gap** lock |
| B's probe (0 rows) | the SAME `RECORD X GRANTED … supremum` — gap locks do not exclude each other |
| A's INSERT | `RECORD X,INSERT_INTENTION WAITING … supremum`, blocked by B's gap |
| B's INSERT | the symmetric request → cycle → `ER_LOCK_DEADLOCK`, `*** WE ROLL BACK TRANSACTION (2)` |

The two controls that fix the cause class:

- **without the probe's `FOR UPDATE`** (`receipts/schedule-nolock.txt`): the
  probes take NO lock at all; A's INSERT succeeds, B's waits on the duplicate
  key and, when A commits, is refused with `ER_DUP_ENTRY` 1062 — the eligible
  race, which converges through the update arm.
- **the probe when the row EXISTS** (`receipts/schedule-found.txt`): the locks
  are `X,REC_NOT_GAP` on PRIMARY and on the unique index — record locks, never
  a gap. This receipt measures the BASE tree's probe, and the repair round
  corrected the sentence that stood here: a statement is chosen before its own
  answer is known, so withdrawing the probe's lock withdraws it in BOTH
  outcomes, on every provider. The found arm does NOT keep a lock inherited
  from the probe; §10 names the two reads that hold it instead.

**Cause class: gratuitous locking.** The lock was taken on the *absence* of a
row: it protected no captured row, it did not make the create arm exclusive
(both racers held it simultaneously — measured `GRANTED` on both), and the
create arm's arbiter was already the unique constraint (Pin Rule 2 — no
`notExists` premise precedes the create INSERT). Its only effect was to convert
an eligible 1062 race into a 1213 abort. It is a MySQL-only side effect of a
statement whose intent — visible in the engine's PostgreSQL behavior, where a
miss locks nothing — is "lock the row I found".

**Not a normalization defect.** `src/drivers/error-mapping.ts` already keeps the
two apart: 1062/`ER_DUP_ENTRY` → `UniqueConstraintError` (:305), 1213/1205 →
`TransactionError` with `VibORMErrorCode.DEADLOCK` (:349-359). Only the first
can become a recovery: `OperationContext.rejectedProducer` records a producer
solely for a `UniqueConstraintError` (`operation-context.ts:1399`, `:2743`), and
`CommandExecution.recover` additionally requires
`matchesSelectedConstraint` — the violated constraint must be the one the
choose's own selector names. Nothing was added or changed here.

## 3. The fact, its owner, the second consumer

**Fact.** A locking read locks what it finds; where it finds nothing it locks a
gap, and a gap lock excludes no second inserter. So a probe whose own operation
INSERTS the key it is probing for must not ask for the lock — the constraint is
that key's arbiter.

**Owner.** `Selection` (`src/query-engine/raptor3/commands/selection.ts`): the
new `insertsWhenAbsent` states the fact, and the PROBE read consumes it —
`query()` passes it to `rowQuery`'s `unlocked` argument, which decides
`forUpdate: !(ctx.usesBatch || unlocked)`. It reaches that read and no other
(repair round, finding 1: it used to be read off `this` inside `rowQuery`,
which the found arm's membership confirmation shares). The fact is set exactly
where a choose's missing arm exists:

1. `commands.ts` `rootUpsert` — the probe-first scalar arm (D-46);
2. `commands.ts` root `upsert` — the interpreted choose, which is the form
   MySQL always reaches (it has no RETURNING, so `rootUpsert` declines), AND
   that form's `targetWhere` / `setWhere` condition probes, which run before
   either arm is chosen and narrow the locator's own selector (repair round,
   finding 4);
3. `relation-body.ts`, guarded by `if (missing)` — the nested
   `connectOrCreate` / `upsert`, which cell 4 takes.

**Second consumer.** The nested arm (3) is the second consumer of the same
sentence: one rule, stated once in `Selection`, serving the root probe-first
arm, the root interpreted arm and every nested choose. `setTargets`'s `Choose`
has no missing arm and is untouched — it keeps its lock, which is the shape of
the rule rather than an exception to it.

**Deletion: no deletion.** The rule replaces no narrower rule; it withdraws a
lock from ONE read. Nothing became dead: `forUpdate` still serves every read
whose answer is a row this operation will mutate — root update/delete locates,
nested connect/update targets, `requireAbsent`, the captured-set capture in
`operation-context.ts`, and `Selection.inspectMembership`, the found-arm
membership confirmation of a nested `upsert`, which shares this selection's
selector but not its probe (repair round, finding 1: that reader was losing the
lock with the probe, and its answer is a row the operation immediately
UPDATEs). Beside them the repair round ADDED one: the non-RETURNING stored-row
read of `OperationContext.update` — see §10.

## 4. Retained cost

Engine (`node scripts/query-engine-structure.mjs`, `receipts/structure-*.json`):

| | files | lines | token-bearing LOC | functions | branch nodes |
| --- | --- | --- | --- | --- | --- |
| before (`cdd787ac8`) | 38 | 20,446 | **16,040** | 1,093 | 2,564 |
| after (repair round) | 38 | 20,509 | **16,053** | 1,093 | 2,566 |

+13 token-bearing lines: one optional field, the `unlocked` argument and the
call that passes it, the assignments that state the fact at the root arms, the
nested guarded assignment, the condition-probe binding lifted out of its
`probes.push`, and the one `forUpdate: true` in `OperationContext.update`. The
rest of the +63 raw lines are the docblocks that carry the measured
justification. The growth buys the MySQL lane's four cells, removes a
provider-specific abort the engine was manufacturing, and puts the found arm's
protection where it can actually be read; no behavior was moved to a new file
and no wrapper was added.

Non-engine (`git diff --numstat`):

```
75  0  docs/architecture/raptor3-evidence/g4.md
36  0  src/query-engine/raptor3/AGENTS.md          (the guide addendum; markdown, outside the structure tool's count)
13  3  tests/contracts/drivers/behaviors/non-returning-mutation-atomicity-behavior.ts
```

plus the new `tests/providers/docker/mysql2-concurrency-policy.test.ts`
(700 lines, untracked) and this directory.

## 5. The three witness groups

`tests/providers/docker/mysql2-concurrency-policy.test.ts`, gated like its
siblings on `MYSQL_TEST_CONNECTION_STRING`, collected by the existing
`tests/providers/docker/mysql2*.test.ts` glob of the `provider-mysql2` project
(no workspace or manifest edit), and resetting with the siblings' approved
`beforeEach(dropEveryLiveTable)` (repair round, finding 2). The three required
groups are below, and a FOURTH section states the found path's price (§10).
8 cells, green: `receipts/r2-policy-after-sibling.log`, run immediately after a
sibling file so the shared database holds that sibling's tables. Red on the
base tree for 5 of the original 7: `receipts/policy-falsified.log` — the
planted winner's INSERT waits on the loser's gap lock and the cell times out,
which is the repair's falsifier.

1. **Eligible unique-key race** (3 cells). A second client commits the winner on
   its own connection inside the loser's `beforeStatement` hook — a schedule,
   not a timing race. Root upsert converges through the update arm onto the
   winner's row; nested `connectOrCreate` converges through the connect arm;
   both assert exactly ONE admitted create attempt on the wire and that the
   probe carries no `FOR UPDATE`. The third cell is exact producer ownership: a
   create arm refused by a unique key the selector does NOT name never becomes
   a lost race — no update arm is taken, the only committed row is the other
   connection's, and the create attempts stay within the one recovery
   allowance.
2. **A forced native deadlock** (2 cells). Two `$transaction` callbacks take the
   same two ROW locks in opposite order through the public client, latched so
   both hold their first lock. Exactly one victim; the rejection carries exactly
   one `TransactionError` with `VibORMErrorCode.DEADLOCK` and the message
   `Transaction deadlock detected`, and no `UniqueConstraintError` anywhere in
   the composed failure (the client surfaces it inside an `AggregateError`
   together with the two `QueryError`s of the aborted statement and its
   teardown — `receipts/policy-diag.log`). The victim replays nothing: after its
   `ROLLBACK TO SAVEPOINT` it issues only that savepoint's release, and it
   issued exactly one UPDATE in its life. Its first update is NOT committed and
   the survivor's two both are. Beside it, the non-deadlocking control: the same
   two row locks in the SAME order, both transactions succeed.
3. **Borrowed execution** (2 cells). Inside a transaction the CALLER opened, a
   lost create race is reported to the caller (`UniqueConstraintError`): the
   engine owns no region, so it spends no recovery allowance. One create
   attempt, one pooled connection for every statement of the operation, and the
   only savepoint traffic is the member's own `SAVEPOINT` / `ROLLBACK TO
   SAVEPOINT` / `RELEASE SAVEPOINT` under one name — a member-scoped rollback,
   not a replacement transaction. The second cell shows the other half of
   ownership: the caller catches the rejection inside its own callback, writes
   something else, and COMMITS.

## 6. The four existing cells and the one re-expressed expectation

The four cells are **green as written** — their unconditional success
expectations are unchanged, because with the gratuitous lock gone the race is
the eligible one the engine already converges on
(`receipts/after-four-cells.log`). No `allSettled()` was introduced anywhere.

One recorded expectation was re-expressed, naming the decision at the cell:
`mysql2 atomic non-returning mutation interleavings › competing upserts
identify their branches and refetch their own updates` latched on the second
operation's locking probe (`isItemLock`). That operation's contention point is
now the UPDATE its found arm issues, so the latch waits for that statement
instead. Every assertion of the row is unchanged, and the two rows that latch
on a locking probe — a root update and a root delete, whose locate keeps its
lock — are untouched. Green: `receipts/after-interleavings.log`.

## 7. Runs

One vitest at a time, in this worktree, through the sanctioned runners. This
table is the FIRST round's; the repair round re-ran the affected files and its
own table is in §10 (`r2-*.log`), with the typecheck, census and Biome of the
final tree.

| file | result | receipt |
| --- | --- | --- |
| `mysql2-writes-raw.test.ts` (base, `-t concurrent`) | 4 failed — the four cells, `ER_LOCK_DEADLOCK` | `repro-four-cells.log` |
| `mysql2-writes-raw.test.ts` (`-t concurrent`) | **4 passed** | `after-four-cells.log` |
| `mysql2-writes-raw.test.ts` (whole file) | 91 passed, 1 failed | `after-writes-raw-full2.log` |
| ↳ that failure on the BASE tree | same failure, same message (R2b's `createMany` fold: `expected […(5)] to have a length of 8`) | `base-createmany-fold.log` |
| `mysql2-writes-raw.test.ts` (`-t atomic non-returning …`) | 4 passed | `after-interleavings.log` |
| `mysql2-concurrency-policy.test.ts` (new, first round: 7 cells) | **7 passed** | `policy-final.log` |
| ↳ the same file on the BASE tree | 5 failed / 2 passed | `policy-falsified.log` |
| `mysql2.test.ts` (neighbour family) | 83 passed, 1 skipped, 1 failed | `after-mysql2-main.log` |
| ↳ the same file on the BASE tree | identical: 83 passed, 1 skipped, 1 failed (`MySQL namespace containment › applies into the TARGET's control tables…`) | `base-mysql2-main.log` |
| `engine/query/m8-race-retry.test.ts` | 4 passed | `after-m8-race-retry.log` |
| `engine/write/junction-upsert-arm-probe.test.ts` | 10 passed | `after-junction-upsert-probe.log` |
| `engine/query/nested-write-conformance-to-one.test.ts` | 19 passed | `after-nwc-to-one.log` |
| `engine/write/shared-pk-connect-or-create.test.ts` | 29 passed | `after-shared-pk-coc.log` |
| `providers/local/pglite-nested-writes.test.ts` | 126 passed | `after-pglite-nested-writes.log` |

Typecheck (once, at the end): `node scripts/run-typecheck.mjs` → **0
diagnostics**, exit 0 (`receipts/typecheck.log`).

Census: `node scripts/raptor3-refusal-census.mjs` → 23 candidate sentences at 30
sites, 193 total sites — unchanged from the closure checkpoint
(`receipts/census.log`). It was not required (no sentence and no error class was
touched); it was run to say so with a number.

Biome, per changed file against its base copy: `selection.ts`, `commands.ts`,
`relation-body.ts` — the identical pre-existing diagnostic set (4/1/5
`noParameterProperties`, `noParameterAssign`, `noUnusedVariables`, and
`selection.ts`'s pre-existing `format`), no new diagnostic, and the formatter
was NOT run on any of them. `non-returning-mutation-atomicity-behavior.ts`:
clean before and after. The new
`mysql2-concurrency-policy.test.ts`: clean (a NEW file, so it was formatted).

Registrations: `tests/providers/docker/mysql2-concurrency-policy.test.ts` → 8
cells after the repair round (7 in the first), registered by the existing
`provider-mysql2` glob;
`scripts/raptor3-manifest.mjs` was not edited (it carries no
`tests/providers/docker` entries).

## 8. Observations that are not this unit's repair

- **A bounded second create attempt on a constraint the selector does not
  name.** Measured (`receipts/policy-diag.log`, the `DIAG-OWNERSHIP` stream):
  probe, INSERT, probe, INSERT. The operation's ONE region recovery allowance
  (`regionAttempt` → `recoveryRejection(error)?.kind === "insert"`) is spent on
  any `UniqueConstraintError` that carries a producer, while the
  constraint-attribution check (`matchesSelectedConstraint`) lives only in
  `CommandExecution.recover`. The final answer is correct (the update arm is
  never taken, the error surfaces, nothing extra commits) and the retry is
  bounded to one, but a rejection that was never a race does put a second write
  on the wire. Not repaired here: it does not cause the deadlock, and the
  handoff keeps recovery authority unchanged. The new cell pins the bound.
- **`ER_LOCK_WAIT_TIMEOUT` (1205) is normalized to the message "Transaction
  deadlock detected"** (`error-mapping.ts:349-359`). A lock-wait timeout is not
  a deadlock. Pre-existing, outside this unit's four failures, and changing a
  sentence would move the census — left alone and reported.

## 9. Unverified / blockers

Unverified (and §10's "What the repair round did NOT do"):

- Only the MySQL lane files named above were re-run; the rest of the native
  MySQL inventory (R2a/R2b's scope) and native PostgreSQL were not, per the
  no-wide-runs rule. PGlite's 126 nested-write cells are this unit's live
  PostgreSQL-engine evidence for the unlocked probe.
- The adopted decision's ledger number was provisional when this unit wrote it
  (**D-66**): the handoff's §1 rows carry no identifiers and three other units
  adopt their own rows in parallel. Settled by the integrated repair round —
  R2a's "MySQL" row had taken 66, so this unit's "MySQL deadlocks" adoption is
  **D-67** in the ledger.

Blockers: none. One environment fault was recovered rather than reported:
Docker Desktop's engine was down at the start of this unit (its VM had been
asked to stop at 09:51 and its backend never finished), and the assigned
container `viborm-raptor3-g3-mysql-20260914` publishes an EPHEMERAL host port,
so the port in `/private/tmp/viborm-fc-env/mysql-g3` (53879) was stale after the
restart. The engine was brought back with `open -a Docker`, the container
started, and the unit ran against the port Docker actually assigned (53130),
through a corrected connection file written into this unit's own TMPDIR. No
connection string was printed, and no database or schema this unit did not
create was dropped — the approved fixtures' own setup/teardown did all of it.

## 10. Repair round (2026-09-21) — the independent review's four findings

Four findings, all applied; none declined. The three majors are code, the minor
is code, and the sentences the third one named are re-stated in §2, §3, the
ledger record and the guide addendum rather than only here.

### Finding 1 (major, `selection.ts`) — the withdrawal reached a second reader

`rowQuery` is shared by `query()` (the probe) and `inspectMembership()`, and it
read `insertsWhenAbsent` off `this`, so a nested `upsert`'s found-arm
membership confirmation lost its lock too — a read whose answer is a row the
operation immediately UPDATEs, and one `relation-body.ts` hands the SAME
`Selection` object to (`foundRequirement.selection = lookup`, consumed by
`execution.ts` as `ctx.read(requirement.selection.inspectMembership(…))`
whenever `!ctx.usesBatch`). Applied exactly as requested: `rowQuery` now takes
`unlocked` as its fourth argument, `query()` passes `this.insertsWhenAbsent`,
`inspectMembership()` passes nothing and keeps `forUpdate: !ctx.usesBatch`.
The untouched-readers list in §3 now names it.

### Finding 2 (major, the new file) — its `beforeEach` did not survive a sibling

Confirmed by reproduction: the three-table `DROP TABLE IF EXISTS` loop left
every sibling's table standing, and the `syncLiveSchema` that followed read one
of them as a rename of a table this schema declares
(`MigrationError: Unresolved ambiguous change`). The lane is ONE database with
`fileParallelism: false`, so a sibling's leftovers are the normal state this
file starts in. Replaced with the siblings' approved fixture,
`beforeEach(dropEveryLiveTable)` from `./mysql2-fixtures`, which pushes the
empty schema and drops every live table, followed by this file's own push.
Retained receipt, run in the gate's own order: `receipts/r2-four-cells.log`
(the sibling, which leaves `upsert_atomicity_tags` behind) and then, at once,
`receipts/r2-policy-after-sibling.log` — 8 passed. Falsified in a backup copy
and restored by `cp`: with the loop back, in the same order,
`receipts/r2-fixture-falsified.log` is 8 FAILED, every one
`Unresolved ambiguous change: Table "l102_plan_probes" → "r2c_policy_authors"`;
`receipts/r2-policy-restored.log` is the restored tree run straight after that,
green on exactly the namespace state that failed.

### Finding 3 (major, the docs) — and what measuring it exposed

The finding is right: a statement is chosen before its own answer is known, so
the withdrawal is not confined to a MISS. The probe reads unlocked in BOTH
outcomes, on every provider, and the four sentences that said the found arm was
untouched are corrected in place — §2's control, §3's owner and untouched-reader
lists, §11's commit draft, the `g4.md` record and the `AGENTS.md` addendum —
each now saying which read holds the found arm instead.

Then the requested witness was written — a committed DELETE between an
`upsert`'s probe and its update arm — and it measured something worse than the
finding predicted. Not `NotFoundError`: **success**, returning the probe's own
row with the update NOT applied
(`{ id: "present", count: 0 }`, and `findMany` → `[]`). The cause is not the
missing lock alone. The engine already asks which row its UPDATE wrote — the
non-RETURNING stored-row read in `OperationContext.update`, whose own comment
claimed "the mutation's locked capture remains protected through this
stored-row read" — but that read was a consistent read, and under REPEATABLE
READ a consistent read answers from the snapshot this transaction opened plus
its OWN changes. An UPDATE that affected NO row leaves the snapshot's copy
standing, so the check saw a row that was not there, and the terminal read
returned it.

That is exactly the shape the decided handoff §1 forbids for D-65 ("do not
silently return the original captured rows as a successful complete result
after fewer rows were affected"), so it could not be pinned as the withdrawal's
price. Narrowing the withdrawal to the missing outcome alone is not available —
the lock is requested before the outcome is known, and a second locking read of
a found row is duplicated work this unit is told to remove, not add. So the
protection was moved to the read that already exists for this question and made
CURRENT: `forUpdate: true` on that stored-row read. It is the same lock the
UPDATE itself took on every row it did write, so the ordinary path pays
nothing; it is emitted only by adapters that append it (MySQL — PostgreSQL
never reaches this branch, it has RETURNING; SQLite omits the clause), so the
only SQL that changed is MySQL's; and the comment it replaces becomes true of
this statement instead of a plan-time probe that may no longer hold it.

Witness (the new file's 8th cell, `the unlocked probe when it FINDS the row`):
the operation now fails visibly with the engine's existing sentence
`UPDATE did not produce the required record`, carries no
`UniqueConstraintError` and no `DEADLOCK`, commits nothing, writes no row under
either id, and its probe still carries no `FOR UPDATE`.

Three of the new file's probe assertions were re-aimed for the same reason, and
at the probe rather than at every SELECT: `probeOf(driver, table)` is the FIRST
read of that table, the one whose arm may insert the key it looked for. The
read a write issues of the row it has just written is a different statement and
a different fact, and it now carries `FOR UPDATE` by design.

### Finding 4 (minor, `commands.ts`) — the fourth reader

Correct: the interpreted root `upsert`'s `targetWhere` / `setWhere` condition
probes ran unconditionally before either arm was chosen, on a selector that is
the locator's own narrowed by the condition, and still asked for `FOR UPDATE` —
the same gap on the same unique index, followed by the create arm's INSERT of
that key. They are public arguments and `rootUpsert` declines them, so on MySQL
this was the only spelling of that shape reaching the provider. Applied as
requested: the probe lookup is bound to a local and carries
`insertsWhenAbsent = true`.

**Witness added in the postwave round (2026-09-21).** This repair shipped with
no cell — the independent review said so, and the round's first shape had
removed the only one that reached it. `mysql2-concurrency-policy.test.ts`'s
"the CONDITION probe of a conditioned upsert locks no absence either" supplies
`targetWhere` on a MISSING key, asserts the two plan-time reads (the locator
and the condition probe, distinguished by the condition's own column appearing
in exactly one filter) and that neither carries `FOR UPDATE`. See
`closure-final/postwave/note.md`.

### Repair-round runs

One vitest at a time, in this worktree, through the sanctioned runners.

| file | result | receipt |
| --- | --- | --- |
| `mysql2-writes-raw.test.ts` (`-t concurrent`) | **4 passed** | `r2-four-cells.log` |
| `mysql2-concurrency-policy.test.ts`, immediately after it | **8 passed** | `r2-policy-after-sibling.log` |
| ↳ the same file with the OLD three-table reset (falsified in a backup copy, restored by `cp`) | 8 failed — `Unresolved ambiguous change` | `r2-fixture-falsified.log` |
| ↳ restored, run straight after that | **8 passed** | `r2-policy-restored.log` |
| `mysql2-writes-raw.test.ts` (whole file) | 91 passed, 1 failed — the same pre-existing R2b `createMany` fold, same message as `base-createmany-fold.log` | `r2-writes-raw-full.log` |
| `mysql2.test.ts` (neighbour family) | 83 passed, 1 skipped, 1 failed — identical to `base-mysql2-main.log` | `r2-mysql2-main.log` |
| `mysql2-cascaded-identity.test.ts` (the key-transition path the changed read addresses) | 4 passed | `r2-cascaded-identity.log` |
| `contracts/engine/query/m8-race-retry.test.ts` | 4 passed | `r2-m8-race-retry.log` |
| `contracts/engine/write/junction-upsert-arm-probe.test.ts` | 10 passed | `r2-junction-upsert-probe.log` |
| `contracts/engine/query/nested-write-conformance-to-one.test.ts` | 19 passed | `r2-nwc-to-one.log` |
| `contracts/engine/write/shared-pk-connect-or-create.test.ts` | 29 passed | `r2-shared-pk-coc.log` |
| `providers/local/pglite-nested-writes.test.ts` | 126 passed | `r2-pglite-nested-writes.log` |
| `mysql2-concurrency-policy.test.ts`, once more on the finished tree | **8 passed** | `r2-policy-final.log` |

Typecheck, once, at the end of the round: `node scripts/run-typecheck.mjs` →
0 diagnostics, exit 0 (`receipts/r2-typecheck.log`). Census:
`node scripts/raptor3-refusal-census.mjs` → 23 candidate sentences at 30 sites,
identical to the first round's line for line except the count of uncommitted
engine files, 4 → 5 (`receipts/r2-census.log`); no sentence and no error class
was touched. Biome per changed file against its base copy
(`receipts/r2-biome.log`): the identical diagnostic set for `selection.ts`,
`commands.ts`, `relation-body.ts` and `operation-context.ts` — including the
pre-existing `format` diagnostic that `selection.ts` and `operation-context.ts`
carry, on which the formatter was NOT run — nothing new anywhere, and the new
test file clean. Engine structure after the round:
`receipts/r2-structure-after.json`; the round's whole tracked diff:
`receipts/r2-full-tracked-diff.patch`; the new file as it stands:
`receipts/r2-mysql2-concurrency-policy.test.ts.txt`.

### What the repair round did NOT do

- It did not add a witness for the nested `upsert` found-arm membership
  confirmation (finding 1's shape). The requested change was to make the fact
  reach only the probe, which is a code fact and is stated at
  `Selection.inspectMembership`; no cell in this unit exercises a nested
  `upsert` under a parent update on MySQL, and adding that lane file is R2b's
  perimeter.
- It did not touch the found-arm protection of a shape where
  `OperationContext.update` issues no stored-row read at all — a found arm with
  an EMPTY demanded set, which returns without asking anything. Nothing in this
  unit's four failures reaches it, and the read it would need does not exist
  today. Reported as unverified rather than claimed.

  **Answered in the postwave round (2026-09-21), on the integrated tree.** The
  independent review named the shape this bullet leaves open: a nested
  `connectOrCreate` whose relation is CHILD-HELD. There the connection IS that
  empty-demand UPDATE, and with the probe no longer holding the row it found, a
  target removed in between made the operation report a connection it never
  wrote — measured red
  (`closure-final/postwave/receipts/base-red-child-held-coc.log`). The arm
  whose probe does not lock now demands the target's own keys
  (`RelationBody.association`, guarded by `Selection.insertsWhenAbsent`), which
  is exactly the read this bullet said did not exist: `OperationContext.update`'s
  CURRENT stored-row read, raising the existing
  `UPDATE did not produce the required record`. Witness: this file's 10th cell.
  See `closure-final/postwave/note.md`.

## 11. Commit message draft

```
fix(raptor3): a choose probe does not lock the absence it is about to insert

The four native MySQL concurrency cells failed with ER_LOCK_DEADLOCK (1213)
for one measured reason: the plan-time probe of an upsert / connectOrCreate
asked for FOR UPDATE, and InnoDB answers a miss on a unique index with an X
gap lock over the index supremum. Both racers are GRANTED that same gap lock —
gap locks do not exclude each other — and the X,INSERT_INTENTION each then
requests waits for the other's gap, which is the cycle the server breaks by
aborting one whole transaction. Measured on a controlled schedule through
performance_schema.data_locks and SHOW ENGINE INNODB STATUS, with the
counterfactual beside it: without that lock nothing is locked at all, the
loser's INSERT is refused by the unique constraint (ER_DUP_ENTRY 1062), and
the existing recovery converges through the update arm.

So the lock is gratuitous exactly where it was fatal. It protected no captured
row, it made the create arm exclusive to nobody, and that arm's arbiter was
already the constraint (Pin Rule 2). Selection now carries insertsWhenAbsent,
set where a choose's missing arm exists — the root upsert's probe-first arm,
the root interpreted arm and that arm's targetWhere/setWhere condition probes,
and the nested arm — and the PROBE read, Selection.query, asks for no lock. It
is what the batch route and PostgreSQL already did.

Say plainly what that costs, because a statement is chosen before its own
answer is known: the probe reads unlocked in BOTH outcomes, on every provider,
so the found arm inherits no lock from it either. Two reads hold the found arm
instead, and the withdrawal reaches neither. Selection.inspectMembership — a
nested upsert's found membership confirmation, whose answer IS the row the arm
updates — keeps forUpdate, which is why insertsWhenAbsent is an argument of the
probe's query rather than a field rowQuery reads. And the non-RETURNING
stored-row read of OperationContext.update, the read that asks which row the
UPDATE just wrote, is now a CURRENT read: under REPEATABLE READ a consistent
read answers from this transaction's snapshot plus its own changes, so an
UPDATE that affected no row leaves the snapshot's copy standing — measured,
that schedule returned the probe's row with the update NOT applied as a
SUCCESS. It is the same lock the UPDATE itself took on every row it did write,
so the ordinary path pays nothing, and only MySQL's SQL changes (PostgreSQL has
RETURNING and never reaches the branch; SQLite omits the clause).

Nothing was added to error normalization: 1062 and 1213 were already distinct
classes and only the first can become a recovery. No replay, no isolation
change, no borrowed-work retry. The four cells are green as written.

New witnesses (tests/providers/docker/mysql2-concurrency-policy.test.ts, 8
cells, 5 of them red on the base tree; it resets with the siblings' approved
dropEveryLiveTable, because the lane shares one database and a sibling's tables
are the normal state it starts in): the eligible race converging on the
producer the selector names with one admitted create; a rejection on a
constraint the selector does NOT name refusing to become a lost race; a forced
native deadlock inside $transaction whose victim fails with the normalized
failure, replays nothing and commits nothing, beside its same-order success
control; borrowed execution keeping the caller's ownership — one create
attempt, one pooled connection, the member's own savepoint triple, and a
caller that catches the rejection and still commits; and the found path's own
price — a row DELETED between the unlocked probe and the update arm, which
fails visibly, commits nothing and writes no row under either id.

One recorded expectation re-expressed, naming the decision at the cell: the
latch of "competing upserts identify their branches and refetch their own
updates" waited for the second operation's locking probe; that operation's
contention point is now its UPDATE, so the latch waits for that statement.
Every assertion of the row is unchanged, and the two rows that latch on a
locking probe keep it.

Engine cost 16,040 -> 16,053 token-bearing LOC. Typecheck 0.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
