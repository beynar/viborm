# U1 — the shared FOUND-consumption rule

Repair prompt §1 (and §5's first item). Branch `closure-se` from `bc18b4e23`,
worktree `/private/tmp/viborm-se`, MySQL 8 (`raptor3_g2`, REPEATABLE READ,
`innodb_lock_wait_timeout = 50`). Receipts: [`receipts/`](receipts/).

## 1. The failing witness

The review's three MySQL falsifiers, run from its own retained workspace
overlay against the unchanged production source
([`receipts/01-mysql-found-red-at-base.log`](receipts/01-mysql-found-red-at-base.log),
**3 failed / 11 skipped**) — the review's recorded facts reproduced exactly:

| falsifier | red at base |
| --- | --- |
| a found reference cannot silently connect another target after rekey | `expected 'b2' to be 'b1'` |
| a found conditioned upsert cannot write after its condition stops matching | `expected 42 to be 8` |
| a found nested to-one upsert cannot write a reparented record | `expected { id: 'pr1', … } to match { ownerId: 'o2', bio: 'original' }` |

After the repair all three are green as registered cells in
`tests/providers/docker/mysql2-found-consumption.test.ts`, **11 / 11**
([`receipts/02-mysql-found-consumption-green.log`](receipts/02-mysql-found-consumption-green.log)).
The file is **12 cells** on the final tree: the integrated round added the
twelfth, the unique coverage of the confirmation's re-binding of the located
selection ([`../integrated/note.md`](../integrated/note.md)).

The review's own overlay is **not** re-run after the repair, and the README
says why: its hooks wait for a concurrent write that a correct locking repair
blocks (its first hook plants before the statement after the observation — that
one still works; the other two plant in front of the UPDATE, which is now
inside the confirmation's lock). The permanent cells plant in the ONE window
that exists on both trees — immediately before the first statement the
operation sends after its unlocked plan-time read of the table that is not
itself another unlocked read of it. On the reviewed source that statement is
the EFFECT (which is what made these cells red there); with the rule it is the
CONFIRMATION.

## 2. The continuing invariant, and its single owner

**Invariant.** An unlocked positive observation may select an arm; it protects
nothing that arm consumes. Before any effect that depends on it, the located
row is re-taken under lock over the requirements the operation already owns —
its exact identity, the membership it was read through, the conditions it
matched, and the reference values it will spend — and the row that read answers
is the authoritative binding every consumer then spends. A lost requirement
raises the failure that requirement already owns.

**Owner.** One rule, one method: `CommandExecution.confirmFound`
(`src/query-engine/raptor3/commands/execution.ts`), issuing one query owner,
`Selection.confirm` (`commands/selection.ts`). It is called from exactly one
place — `case "choose"`, after the conditions are decided and before either arm
— which is where the narrower membership confirmation it replaces already
stood. There is no second interpreter, no per-verb switch, no parent-held-only
patch and no concurrency manager.

`Selection.confirm` is the membership confirmation the correlated to-many
`upsert` already had, with the two facts that were that arm's own turned into
arguments (the membership it proves, and the condition it proves — this
selection's selector, or the narrowing selector of a probe taken over it). The
three facts that make it a confirmation are fixed: it addresses the located row
by IDENTITY (so it can adopt no replacement record), it keeps `forUpdate` (so
the requirement survives into the effect, under the transaction this operation
is already in), and it returns the whole stored row.

## 3. The hunk

```
 src/query-engine/raptor3/commands/execution.ts      | 101 ++++---   (+89 net)
 src/query-engine/raptor3/commands/selection.ts      |  21 +-        (+14 net)
 src/query-engine/raptor3/commands/relation-body.ts  |  21 +-        (-7  net)
 src/query-engine/raptor3/AGENTS.md                  |  81 +-        (guide addendum)
 tests/providers/docker/mysql2-concurrency-policy.test.ts | 102 +-   (§4 re-expressed)
 tests/providers/docker/mysql2-found-consumption.test.ts  | new
 tests/providers/local/sqlite3-found-consumption.test.ts  | new
```

- `selection.ts`: `inspectMembership(membership)` becomes
  `confirm(membership, condition = this)`. Same `rowQuery`, same `forUpdate`
  rule, same identity addressing; one extra parameter.
- `execution.ts`: `confirmFound(command, requirement, captured)` returns the row
  the operation now holds. It returns `captured` untouched on the batch route
  and for a probe that kept its own lock. Otherwise it confirms, in order: each
  MATCHED condition probe when there is one (whose selector is the locator's
  own narrowed by the condition, so it confirms the row with it — exactly the
  batch route's own decomposition), else the locator itself. A miss throws the
  requirement's own failure; a hit `materialize`s the row into the selection's
  binding, and the returned row is what the two `attempt.bind` calls of the
  choose spend.
- `relation-body.ts`: §5's duplication removed (below), and the surviving rule's
  explanation consolidated into one paragraph that names what still makes it
  necessary.

Route summary — what each substrate does with the same requirement:

| requirement | batch route (unchanged) | interactive route (this unit) |
| --- | --- | --- |
| `connectOrCreate` replacement race | `requirePresent(selection.captured())` in `runSelection` | `confirmFound`, failure `Selection.retained` |
| found membership of a correlated `upsert` | the found record's `requirePresent` | `confirmFound`, failure `foundRequirement.failure` |
| membership of a to-one nested `upsert` | the found record's `requirePresent` | `confirmFound`, failure `NotFoundError(model, "update")` |
| matched conditions of a root `upsert` | one `requirePresent` per condition | `confirmFound`, failure `condition.match` |

## 4. What disappears

1. **`execution.ts`, the `requirement && !premised` branch** (9 lines): the
   eager `inspectMembership` read of a correlated nested `upsert`. Its
   interactive half IS the new rule (same query, same failure). Its batch half
   was a second statement of a requirement the found record command already
   registers as a premise of the unit that consumes it (`case "record"`,
   `requirePresent(located.captured(undefined, requirement.membership, 1),
   requirement.failure())`) — which is strictly stronger, because it aborts the
   unit atomically instead of throwing after the queue is built. The batch route
   therefore loses one round trip.
2. **`selection.ts`, `inspectMembership`**: replaced by `confirm`, not added
   beside it. One read owner, not two.
3. **`relation-body.ts:950–951`** (the repair prompt §5's first item): the key
   demand `if (lookup.insertsWhenAbsent) binding.fields.select(keys(edge.target))`
   made on the binding this branch has just constructed. The broader guard
   below (`target.kind === "choose" && target.found &&
   target.lookup.insertsWhenAbsent && target.foundRequirement === undefined`)
   makes the same demand on the same object: by construction
   `conditionalParentBinding` requires `!premise`, `foundMembership` requires
   `correlated`, and `edge.target === target.model`, so the broader guard's
   three conditions all hold whenever the deleted one did. Its comment is
   consolidated into that rule's, which now also names why the rule survives the
   shared confirmation at all (below). No behaviour changes: the two demands
   were the same idempotent `fields.select`.

**Not deleted, with its unique coverage named.** The key-demand rule at
`relation-body.ts:962–970` and the CURRENT stored-row read in
`OperationContext.update` stay. Their coverage that the confirmation does not
give: SQLite's select assembly OMITS `FOR UPDATE`
(`src/adapters/databases/sqlite/sqlite-adapter.ts:703–705`), so on that
substrate the confirmation takes no lock and the window between it and the
effect is not held. They are the reader of last resort there.

That claim now has its own cell, in that window and on that substrate: "a target
lost AFTER the confirmation is caught by the reader of last resort"
(`sqlite3-found-consumption.test.ts`) plants its delete before the first
MUTATION of the table — after the confirmation has ANSWERED — and pins that the
nested to-ONE upsert fails with `UPDATE RETURNING did not produce the required
record` (SQLite has RETURNING, so the stored-row read is that branch of the same
owner; the `UPDATE did not produce the required record` spelling is the same
check where the provider has none) with nothing committed. Both halves are
falsified: deleting the key demand at `relation-body.ts:962–970` and, separately,
the required-record check in `OperationContext.update` each turn the cell red in
the one way that matters — the operation RESOLVES, returning the renamed parent,
having written nothing
([`receipts/13-last-resort-falsification.log`](receipts/13-last-resort-falsification.log)).

## 5. A second applicable consumer

Beyond the three measured schedules, the same rule is what now answers for:

- the **CHILD-HELD `connectOrCreate`** binding arm, whose replacement-race
  requirement (`Selection.retained`) had an expression on the batch route only
  and none at all on the interactive one. Witness: "a CHILD-HELD found
  connectOrCreate refuses a target replaced under its selector" (new file) and
  the re-expressed §4 row in `mysql2-concurrency-policy.test.ts`.
- the **correlated to-MANY nested `upsert`**, whose membership confirmation the
  rule now issues instead of its own branch, with its sentence unchanged.
  Witness: "a correlated to-MANY nested upsert refuses a member moved to another
  parent".
- a **compound, column-mapped reference key** addressed through a mapped unique
  (no per-column-name fact anywhere in the rule). Witness: "a COMPOUND,
  column-mapped reference is confirmed and spent at its current pair".
- **borrowed execution**, where the confirmation is taken on the caller's own
  connection and its lock is the caller's to release. Witness: "inside a
  borrowed transaction the confirmation is the caller's own lock".

## 6. Capability change

**None.** No valid uncontended operation becomes a refusal: "an uncontended
found consumption commits its ordinary result" (both the native and the
credential-free file) exercises all three shapes with no interference and pins
the ordinary results. Missing-key probes stay unlocked and take no confirmation
at all ("the missing arm still reads unlocked, and the confirmation is the only
locked read"), so R2c's whole deadlock policy is untouched — verified by running
its file, 11 / 11.

What the rule costs on the **interactive FOUND path of an arm whose probe
withdrew its lock** is **one extra round trip per MATCHED condition probe** —
one where the locator is the only requirement, two for an upsert that carries
both `targetWhere` and `setWhere` (`confirmFound` loops over
`command.conditions.probes`, confirming the located row once through each
probe's own narrowed selector; `commands.ts:1796` builds one probe per present
field, and `tests/raptor3/transitions/conditional-upsert.ts:77`, `:83` and
`tests/contracts/engine/query/nested-write-conformance-fk.test.ts:774–775` are
registered cells of the dual-condition shape). Not on a miss, not on the batch
route, and not for an arm whose probe still locks. No error sentence is added,
changed or removed.

## 7. Registrations

| file | cells | project(s) |
| --- | --- | --- |
| `tests/providers/docker/mysql2-found-consumption.test.ts` (new) | 12 (11 at this round, +1 in the integrated round) | `provider-mysql2` (glob `tests/providers/docker/mysql2*.test.ts`; no workspace or manifest edit) |
| `tests/providers/local/sqlite3-found-consumption.test.ts` (new) | 5 | `provider-sqlite3` and `coverage-drivers` — 10 executions |
| `tests/providers/docker/mysql2-concurrency-policy.test.ts` | 11 (unchanged count; 3 re-expressed) | `provider-mysql2` |

`scripts/raptor3-manifest.mjs` is NOT edited: neither new file is in a
manifest-enumerated project.

### The re-expressed cells, and why

The repaired contract changed the answer for the three §4 rows of
`mysql2-concurrency-policy.test.ts` (repair prompt §1, named at each cell). Each
planted its DELETE in front of the found arm's UPDATE. That window is now
inside the confirmation's lock, so the plant would wait on a lock this code
correctly takes (a 50 s `innodb_lock_wait_timeout`, not a failure). Each now
plants in front of the confirmation — the same window, at its new boundary —
and reports the requirement that was lost:

| cell | was | is |
| --- | --- | --- |
| a row deleted before the update arm … | `UPDATE did not produce the required record` | `No tag record found for update` |
| a CHILD-HELD connectOrCreate whose found target moves out … | `UPDATE did not produce the required record` | `Record was replaced by another transaction during nested connectOrCreate` |
| a nested to-ONE upsert whose found target is deleted … | `UPDATE did not produce the required record` | `No profile record found for update` |

Nothing is deleted, skipped or weakened: each cell keeps every other assertion
(nothing committed, no create-arm recovery, no `UniqueConstraintError`, no
deadlock, the probe still unlocked) and gains one — that the arm's own effect
never went out at all.

## 8. Runs

One Vitest at a time; one docker file per invocation; the connection string was
substituted into each command from its file and never printed.

| run | result | receipt |
| --- | --- | --- |
| review falsifiers, unchanged source (native MySQL) | 3 failed / 11 skipped — the three defects | `01-…` |
| `mysql2-found-consumption.test.ts` (native MySQL) | **11 / 11** (**12 / 12** after the integrated round's cell) | `02-…` |
| `mysql2-concurrency-policy.test.ts` (native MySQL) | **11 / 11** | `03-…` |
| `sqlite3-found-consumption.test.ts` (credential-free) | **10 / 10** (5 cells × 2 projects) | `04-…` |
| `raptor3/transport.test.ts` + `transitions/conditional-upsert-commands.test.ts` | 4 files, **110 / 110** | `05-…` |
| `providers/local/sqlite3-nested-write.test.ts` (interactive SQLite conformance) | 2 files, **170 / 170** | `06-…` |
| `providers/local/pglite-nested-writes.test.ts` (batch route) | **126 / 126** | `07-…` |
| write contracts: `shared-pk-connect-or-create`, `upsert-arm-referenced-edge`, `junction-upsert-arm-probe`, `parent-held-lookup` | **29 / 18 / 10 / 56**, all green | `08-…` |

The lock is proved by a schedule, not by a moved hook: "the confirmation's lock
holds the FOUND row through the consuming effect" starts a conflicting
`UPDATE … WHERE id = 'b1'` on a second connection AFTER the confirmation has
answered, observes it still pending 1 s later when the consuming INSERT goes
out, and then observes it commit once this operation does — with the serialized
final state (`badge.id === 'b1'`, the holder's key carried to `M` by the
cascade). An uncontended single-row update on that idle pool finishes in
milliseconds.

## 9. Typecheck, census, Biome

- **Typecheck**: `node scripts/run-typecheck.mjs` — **0 diagnostics, exit 0**
  ([`receipts/09-typecheck.log`](receipts/09-typecheck.log)).
- **Census**: `node scripts/raptor3-refusal-census.mjs`, exit 0, re-taken on the
  FINAL tree in the repair round so its line anchors are the ones the source now
  has ([`receipts/10-refusal-census.md`](receipts/10-refusal-census.md)) —
  **byte-for-byte the closure-final counts**: invariant 22 / 21, internal 11 / 11, inherited
  refusals 75 / 75, candidate refusals 30 sites / 23 distinct, rethrow 55,
  **193 total sites**. No sentence is added, changed or removed: `confirmFound`
  raises through a `DeferredFailure` the requirement already owns, so its
  `throw failure()` is classified as a rethrow exactly as the branch it replaced
  was, and the `NotFoundError` it can build is the fallback the found record
  command already builds.
- **Biome**: per changed file, against the base copies
  ([`receipts/11-biome-check-after.log`](receipts/11-biome-check-after.log),
  [`receipts/12-biome-check-base.log`](receipts/12-biome-check-base.log)). The
  lint result is **identical**: 15 errors and 1 info, the same five rules
  (`noParameterProperties` ×10, `useDefaultSwitchClause`, `noCommaOperator`,
  `organizeImports`, `noUnusedVariables`), all pre-existing, none of them in a
  line this unit wrote. Formatting: `execution.ts` was format-clean at base and
  is format-clean now (it was formatted, which its base copy permits); both new
  files are formatted. `relation-body.ts` and `selection.ts` carry a `format`
  diagnostic in their BASE copies, so the formatter was NOT run on them; the
  lines this unit added to them are written the way Biome wants, and
  `selection.ts`'s diagnostic is two lines SMALLER than at base because the
  rewritten method dropped two of its trailing commas.

## 10. Cost

| perimeter | reference | after | delta |
| --- | --- | --- | --- |
| engine token lines (`scripts/query-engine-structure.mjs`) | 16,098 | **16,139** | **+41** |
| like-for-like | 19,956 | 19,997 (derived) | +41 |
| charged perimeter | 23,891 | 23,932 (derived) | +41 |

The two perimeter rows are DERIVED, not measured: every `src/` file this unit
touches is an engine file inside both perimeters, so the same +41 applies. The
integrator's own reader run on the final tree is the measurement.

`git diff --numstat` (tracked files):

```
68	0	docs/architecture/raptor3-evidence/g4.md
78	3	src/query-engine/raptor3/AGENTS.md
101	12	src/query-engine/raptor3/commands/execution.ts
21	28	src/query-engine/raptor3/commands/relation-body.ts
21	7	src/query-engine/raptor3/commands/selection.ts
102	71	tests/providers/docker/mysql2-concurrency-policy.test.ts
```

plus two new test files and this note. No `src/` file outside the three engine
files this lane owns is touched; `scripts/`, `benchmarks/` and
`vitest.workspace.ts` are untouched.

No negative engine LOC was promised and none is claimed. The +41 is the rule
itself; the three deletions it enables are real but small (the duplicated key
demand, the replaced method, and the branch the rule subsumes). Comment removal
is not counted as compression — `tokenLines` excludes comments by construction.

## 11. Unverified

- **The conditional premise's sentence still says "before the atomic batch".**
  `condition.match` is the existing failure for a matched condition that has
  been lost, and the repair prompt §1.4 says to use the existing failure and
  attribution, so it is reused verbatim — including on the interactive route,
  where "the atomic batch" is not literally what it precedes. Changing it is a
  census change with one pin
  (`tests/raptor3/transitions/conditional-upsert.ts:362`) and no change of
  answer, so it is reported rather than made.
- **The credential-free counterpart is a requirement witness, not a concurrency
  witness.** SQLite has one connection, so its drift rides the operation's own
  transaction and rolls back with it; what those cells pin is that the
  confirmation is issued, discovers the lost requirement and raises the arm's
  own failure with no effect sent — and, in the fifth cell, that where the
  provider gives the confirmation no lock to take, the kept reader behind it
  still refuses. Durable refused state is pinned natively.
- **Not measured here**: the performance cells, the bundle footprint, the full
  native MySQL and PostgreSQL inventories, and every other registered project.
  This unit ran only what discriminates; the frozen gate is the integrator's.
- **The repair prompt itself is absent from the worktree.** It is untracked in
  the main checkout at
  `docs/architecture/raptor3-local-closure-repair-prompt.md` and not in
  `bc18b4e23`, as are the review's retained witnesses under
  `g4/release/closure-review-bc18b4e23/`. Both were read from there read-only.
  The integrator should bring both into the commit.
- **The CURRENT-reference half of the rule is interactive-only on this tree**
  (integrated round, 2026-09-21). `confirmFound` returns the captured bytes
  untouched on the BATCH route (`if (ctx.usesBatch …) return captured`), so
  there a PARENT-held `connectOrCreate` binds through `folded`, which returns
  its argument unchanged for a `connectOrCreate` origin — no found command is
  built for it, because `RelationBody.association`'s
  `conditionalParentBinding` is undefined when the SOURCE owns the reference —
  so the parent's INSERT spends the plan-time probe's literal. What that route
  states as premises is the identity, the membership and the matched condition;
  spending the CURRENT reference binding is not among them, and no registered
  cell measures it, because every cell of
  `tests/providers/docker/mysql2-found-consumption.test.ts` runs on the
  interactive mysql2 driver and the only forced-batch fixture
  (`tests/providers/docker/pg-captured-set-concurrency.test.ts`,
  `PgWindowedBatchDriver`) has no `connectOrCreate` reference-reuse cell. The
  guide's batch sentence is narrowed to those three requirements rather than
  claiming "these same requirements"
  (`src/query-engine/raptor3/AGENTS.md`, the shared FOUND-consumption
  addendum); the batch-route schedule is NOT added here, so §1.3 of the repair
  prompt is closed on the interactive route only.

  **Addendum (2026-09-21, repair prompt 2 §1 / unit `closure-repair-2/t1`):
  CLOSED.** The batch route now re-binds that reference itself, without a read:
  the components the HOLDER's own statement spends are folded into it as a
  scalar sub-select of the located row's CURRENT value
  (`Queries.locatedValue`, `CommandExecution.folded`), read at the CAPTURED
  COMPLETE IDENTITY (`Queries.includeIdentities`) and never at the arm's own
  selector; the selection's retained premise is HELD wherever the probe read
  unlocked, so the row cannot move between that premise and the statement that
  spends it; and the representability requirement the fold can no longer ask of
  a sub-select is stated of the row it will read, as an absence premise, one per
  nullable component. The schedule this entry describes is registered on both
  local forced-batch fixtures
  (`tests/providers/local/sqlite3-batch-reference-reuse.test.ts`, 11 cells) and
  natively on two real PostgreSQL connections
  (`tests/providers/docker/pg-batch-reference-reuse.test.ts`, 6 cells). §1.3 of
  the first repair prompt is closed on both routes.

## 12. Blockers

None.

## 13. Repair round (2026-09-21)

The independent review of this unit returned **five minor findings** and no
blocker. All five are applied; nothing is declined. **No production code
changes in this round** — `git status` lists the same four `src/` entries as
before it and the only one this round touched is the guide (`AGENTS.md`);
`shared/operation-context.ts` is not among them, and the engine measures the
same **16,139** token lines.

1. **The kept guard had no witness.** Re-expressing the three §4 rows of
   `mysql2-concurrency-policy.test.ts` removed the tree's only cells that
   asserted `UPDATE did not produce the required record`, so nothing would have
   failed if the key demand at `relation-body.ts:962–970` or the stored-row read
   in `OperationContext.update` were deleted — while §4 above KEEPS both and
   names their unique coverage. Fixed where the reviewer asked: one cell in
   `tests/providers/local/sqlite3-found-consumption.test.ts`, "a target lost
   AFTER the confirmation is caught by the reader of last resort". Its plant is
   new — `driftBeforeMutation`, which fires before the first MUTATION of the
   table, i.e. after the confirmation has ANSWERED, the one window a substrate
   without `FOR UPDATE` cannot close — and it is the same `plant` the read
   ordinal already used, with the verb as a parameter (one mechanism, not two).
   The nested to-ONE upsert loses its profile in that window and is refused by
   `UPDATE RETURNING did not produce the required record` (SQLite HAS
   `RETURNING`, so the same owner's RETURNING branch spells it; the reviewer's
   sentence is the same check where the provider has none). Falsified BOTH ways
   ([`receipts/13-last-resort-falsification.log`](receipts/13-last-resort-falsification.log)):
   delete the key demand, or delete the required-record check, and this cell —
   and only this cell — goes red, in the way that matters, the operation
   RESOLVING with the renamed parent and nothing written. The file is now 5
   cells / 10 executions (§7, §8, the ledger).
2. **"Never more than one" was false.** `confirmFound` loops over
   `command.conditions.probes` and `commands.ts:1796` builds one probe per
   present field of `["targetWhere", "setWhere"]`, so a root upsert carrying
   both pays TWO confirmations. Corrected at all three places the reviewer named
   — §6 above, `AGENTS.md`'s cost sentence, and the report's `capability_change`
   — and, for consistency, in the ledger record, which carried the same singular
   claim. The registered dual-condition cells are named at §6.
3. **The census receipt was one line stale.** Re-run on the final tree
   (`receipts/10-refusal-census.md`): the counts are unchanged (22/21, 11/11,
   75/75, 30/23, 55, **193 sites**) and every `execution.ts` anchor now matches
   the source. §9 says it was re-taken.
4. **The no-gap-lock sentence was too strong.** A confirmation CAN miss — that
   is the deleted-target family — and a locking read whose exact match finds
   nothing does take the gap in REPEATABLE READ. What preserves R2c is that the
   confirmation never locks the absence the operation is about to INSERT, and
   that a miss raises the arm's own failure immediately and takes no further
   lock, so no cycle can form. Rewritten in `AGENTS.md` and in the commit
   message draft below.
5. **A missing blank line** before the shared-FOUND-consumption addendum in
   `AGENTS.md`, which made it render as a continuation of the paragraph above
   instead of a sibling of the addenda around it. Inserted.

Runs in this round (only the affected file, plus the two falsifications and the
census):

| run | result | receipt |
| --- | --- | --- |
| `sqlite3-found-consumption.test.ts` (credential-free) | **10 / 10** (5 cells × 2 projects) | `04-…` |
| the same file with the key demand deleted | **2 failed / 8 passed** — the new cell only | `13-…` |
| the same file with the required-record check deleted | **2 failed / 8 passed** — the new cell only | `13-…` |
| `node scripts/raptor3-refusal-census.mjs` | exit 0, 193 sites, counts unchanged | `10-…` |
| `node scripts/run-typecheck.mjs` | **0 diagnostics, exit 0** | `09-…` |
| Biome, the unit's six changed and new files | byte-identical to the receipt but for its timing line | `11-…` |

Both falsifications were applied to a backup copy in `$TMPDIR` and restored by
`cp`; `git checkout` was not used, nothing was staged, and
`shared/operation-context.ts` is untouched in the final tree. No MySQL or
PostgreSQL lane was re-run: no production code changed, so no native cell's
answer can have moved.

## 14. Commit message draft

```
fix(raptor3): an unlocked FOUND observation is confirmed under lock before anything consumes it

A probe whose other arm inserts the key it looked for reads without locking
(`Selection.insertsWhenAbsent`), because a lock cannot protect an absence and
asking for one costs the operation its convergence on MySQL. What that
withdrawal also gave up was the POSITIVE answer: the row it found was held for
nothing that followed, and the readers that answered for it all ran AFTER the
effect — where a read proves the row still exists but not that the identity,
the membership, the matched condition or the reference the effect just spent
were still the ones the operation was promised. The local closure review
measured all three losses on unchanged source: a holder connected to `b2`, a
row that acquired the referenced key `G` after the probe read it off `b1`; a
conditional upsert that wrote `42` after the `count: 7` it matched became `8`;
a nested to-one upsert that wrote a profile after it had been reparented.

One rule answers all three, at the owner the narrower membership confirmation
already stood at. `CommandExecution.confirmFound` takes one locked read
(`Selection.confirm`, which is the old `inspectMembership` with the membership
and the condition it proves turned into arguments) between the observation and
every arm: addressed by the located IDENTITY so it can adopt no replacement
record, keeping `forUpdate` so the requirement lasts through the consuming
effect under the transaction the operation is already in, and returning the
whole row — which then replaces the probe's bytes as this row's binding, so a
reference is spent CURRENT and never as a captured key another row acquired. A
lost requirement raises the failure that requirement already owns; nothing
reselects, switches an arm or replays.

Missing-key probes still lock nothing, and the confirmation is issued only
once a probe has FOUND a row and is addressed by that row's identity, so it
never locks the absence the operation is about to INSERT; where the row has
since gone it misses, raises the arm's own failure immediately and takes no
further lock, so R2c's convergence and the no-replay policy are untouched.
The batch route asks for no read here — it states the same requirements as premises of the
atomic unit that consumes them — so the eager membership read it used to take
for a non-dependent correlated upsert is deleted, as is the duplicated key
demand at `RelationBody.association` that the broader guard beside it already
made. The key demands and the CURRENT stored-row read stay behind the
confirmation as the reader of last resort, for a provider whose select assembly
omits `FOR UPDATE`.

Witnesses: `tests/providers/docker/mysql2-found-consumption.test.ts` (12 cells:
the three schedules, a real lock-HELD schedule, parent-held and child-held
consumers, root and nested placements, a compound mapped reference key, a found
arm that writes no column of its own and therefore spends its child's reference
through the located binding, borrowed execution, and the controls) and a
credential-free counterpart on the recording SQLite transport, which also pins
the reader of LAST resort in the window no lock closes there. The three deleted-target rows of
`mysql2-concurrency-policy.test.ts` §4 now plant in front of the confirmation
rather than in front of the effect, because the effect's window is held, and
report the requirement each arm lost. Engine 16,098 → 16,139 token lines.

Repair prompt §1 and §5's first item.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
