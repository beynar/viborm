# Lane X — independent review

Reviewer: independent agent, 2026-09-17. Worktree reviewed:
`/private/tmp/viborm-parity-x` (branch `parity-x`, base `356254a2`), TMPDIR
`/private/tmp/viborm-parity-tmp-x`. Inputs read in full: the parity plan
(D-17..D-24), `g4/briefs/common.md` (the twelve rules), the worktree's
`src/query-engine/raptor3/AGENTS.md`, the lane note, and every hunk of
`git diff 356254a2` (8 files, 641+/63-, plus two new test files).

**Verdict: REVISE.** Eleven units are sound, falsifiable and reproduced; one
unit (U6.5) is honestly blocked and correctly not shipped. Two items need a
fix before this lane merges: a MEASURED behaviour change in U6.6 that goes
beyond the unit's own invariant and beyond the shipped engine, and one new
Biome error the lane's edits introduced. Both resolutions are one hunk each,
and I verified both keep every green cell green.

---

## 1. What I reproduced (my own runs, not the author's receipts)

| suite | command scope | result | base |
| --- | --- | --- | --- |
| `tests/raptor3/g4/parity/lane-x-set-mutations.test.ts` | extended-local | 8 passed | new |
| `tests/raptor3/g4/parity/lane-x-route-seam.test.ts` | extended-local | 3 passed | new |
| `select-mode-capability-matrix.core.test.ts` | layer-query-engine | 3 passed | 3 red |
| `query-interceptors-array.core.test.ts` | layer-client | 54 passed | 3 red |
| `query-interceptors-integration.core.test.ts` | layer-client | 48 passed | 2 red |
| `sqlite3-nested-write.test.ts` | provider-sqlite3 | 8 failed / 77 passed | 11 failed |
| `sqlite3.test.ts` | provider-sqlite3 | 39 passed | 39 passed |
| `sqlite3-polymorphic-batch.test.ts` | provider-sqlite3 | 7 failed / 142 passed / 1 skipped | 8 failed |
| whole `provider-sqlite3` lane | project | **56 failed / 699 passed** | 61 failed |
| `pg-nested-write-races.test.ts` | provider-pg (Docker 55729) | **7 failed / 88 passed** | 13 failed |
| `mysql2.test.ts` | provider-mysql2 (Docker 55730) | **11 failed / 73 passed** | 13 failed |
| layer-client + query-engine + write-engine + drivers | 4 projects | **3 failed / 2049 passed** | 11 failed |
| the 12-file raptor3 probe (envelope, dependency, series, suppression) | raptor3 | 69 passed | — |
| `unique-races` + `recovery-boundaries` + `junction-races` + `staleness` (pg live) | raptor3-live-provider | 10 passed | — |
| `provider-libsql` | project | 9 passed / 663 skipped (env-skipped at the base too) | same |
| whole-estate typecheck | `node scripts/run-typecheck.mjs` | **0 diagnostics, exit 0** | — |

**No cell that was green at the base is red now — verified by set difference,
not by counting.** On the sqlite3 lane I diffed the failing-cell NAMES against
the round-3 base (`provider-local-cutover.log`): `comm -13` is empty, and the
five repaired cells are exactly this lane's targets (self-referential m2m,
duplicate connectOrCreate collapse, the two family-5 correlation cells, the
singular createMany transfer). The pg and mysql2 failing sets are strict
subsets of their base sets; the three remaining core-layer failures are all in
the base's eleven (cache SWR = D-17/lane Q, contract-matrix = pre-existing
inventory, empty createMany = lane Q U1.4).

No test was deleted or weakened: the only removed test line in the whole diff
is the replaced sentence in `select-mode-capability-matrix.core.test.ts`, and
that replacement is plan §U8 itself (the deleted engine's `'`-spelling for the
surviving seam's `"`-spelling; `meta.driver`/`meta.operation` assertions and
the "before dispatch" premise are untouched). No `.skip`, no `.only`, no
`todo(`.

## 2. Falsification exercise (seven mechanisms broken, each pin reddened)

Each mutation was applied to a scratch copy of the file (backed up to the
scratchpad first), run, then restored — every file verified byte-for-byte by
MD5 against the backup afterwards, and the worktree left exactly as the author
left it.

| unit | mechanism broken | pin that reddened |
| --- | --- | --- |
| U6.1 | `forward = opposite === edge.endpoints[1]` → `topology.source.model === source` | `self-referential many-to-many round trip` (sqlite3) |
| U6.2 | the `set` branch disabled in `RelationBody` | the two statement-count cells **and** `runs a sibling update before the updateMany that filters on what it wrote` |
| U6.3 | the first-create-wins `continue` disabled | `collapses duplicate connectOrCreate targets to the first entry's row` |
| U6.4 | `usesBatch` restored in `recoveryRejection` | both deterministic recovery pins (`transactionCalls === 2`, one-recovery) |
| U5.5 | the shortfall refusal disabled | `refuses a createMany the driver acknowledged short` |
| U7.1 | `transferPreparedStatement` dropped on the queue copy | `orders native statement onions before transforms and submits nothing on failure` |
| U7.3 | `prepareSingle` forced back to `undefined` | both native-array cells (timeline, five-error aggregate) |

The pins are real falsifiers, not tautologies, and they are registered: both
new files are picked up by the `extended-local` walk
(`scripts/credential-free-test-manifest.mjs`) — I confirmed by evaluating the
manifest (187 files, both present). No registered raptor3 file gained cells, so
no `scripts/raptor3-manifest.mjs` count moves. Correct.

## 3. Invariants, owners and refusals — verified

- **U6.1** `endpoints = [first.node.slot, second.node.slot]`
  (`relation-resolution.ts:654-659`) and `topology.source/target` built from the
  same two slots (`:797-812`): `opposite === endpoints[1]` is the slot identity,
  one expression, one owner. ✔
- **U6.2** The `set` command composes existing owners only — `Queries.memberWhere`
  (qualified with the target table, so the correlation is explicit),
  `Queries.lowerMutationLimit`, `Queries.updateAssignment` — and adds no walker:
  the payload is read through `EngineSchema.namesRelation`/`scalars`. The write
  footprint is registered in `visitDirectWrites` and `readTarget` treats it as an
  unknown row set (`located = undefined` ⇒ nothing proves a later read disjoint),
  which is the shipped `appendTarget(unknown)`. The `NestedWriteError` sentence is
  the registered one, with `updateMany`/`deleteMany` as the earlier operation. ✔
  I also probed for a NEW refusal (a `set` write followed by a sibling `connect`
  read on the same model): none — the shape still executes. ✔
- **U6.2's reverted part (2)** is the right call and is recorded in the code and
  the guide: a capture flushes, a batch flush commits, so hoisting is what makes
  "prepare all captured members before effects" hold. `g29-dependency-boundaries`
  is green and I re-ran it. ✔
- **U6.3** reuses `PreparedSelector.uniqueValues` + `Assignments.known`, the pair
  `matchesSelectedConstraint` already reads together; the different-target case
  still refuses (own cell). ✔
- **U6.4** The two batch attribution sites already require
  `committedSegments === 0 && !memberAdmissionStarted && !mayHaveCommittedSegment`
  (`submit`, verified at both sites), so stating them in `recoveryRejection`
  changes only the transaction answer, as claimed. One replacement method, spent
  once, installed at construction; in-place replay only where no region is open.
  The live pg harness (`unique-races`, `recovery-boundaries`, `junction-races`)
  is green — those are the `expectedAttempts` pins. ✔
- **U6.5** genuinely blocked: the restart contract is in the guide itself
  ("Only a proven atomic rejection before committed progress or dynamic member
  admission may restart once", `AGENTS.md:345-347`) and
  `Commands.expandSeries` throws at `commands.ts:986`. The reproducer cell is red
  and was red at the base. Reported, not hidden. ✔
- **U7.2** is a faithful port of `runTransactionScope` (I diffed it against
  `ff5e77ca:write-engine/OperationExecutor.ts:1130-1187`): same
  `bindExecutionTransactionPhases`, same phase→certainty map, same
  `attachCommitCertainty`, same retained listener failure, same success
  notification. `outcome.published` prevents a double publication on the route. ✔
- **U7.4** Both sentences are byte-identical to their owners:
  `Driver "<n>" supports neither transactions nor atomic batch execution.`
  (`drivers/driver-transaction-base.ts:790`, `:979`) and the two
  `assertRoutedAtomicResolution` sentences (`ff5e77ca:write-engine/routing.ts`),
  with the shipped `ATOMIC_RESOLUTION_OPERATIONS` set and one `meta`. ✔
- **U5.5** The shortfall rule (not an inequality) is correct against the estate's
  own window-preservation pin, and `rowCount` is a normalized non-negative
  integer at every in-tree driver. ✔

## 4. REVISE — two items, exact resolutions

### R1 (must fix) — U6.6 replays MORE than the membership it names

`CommandExecution.adoptSuppressed`
(`/private/tmp/viborm-parity-x/src/query-engine/raptor3/commands/execution.ts:633-640`)
runs **every** non-`before` child of a suppressed member, not the membership
writes its own invariant names. Measured, in this worktree:

```
item id 1 exists; client.item.createMany({
  data: [{ id: 1, name: "duplicate", notes: { create: { id: 5, body: "n" } } }],
  skipDuplicates: true })
  →  with the lane:  notes = [{ id: 5, body: "n", itemId: 1 }]
  →  at the lane base (adoptSuppressed disabled): notes = []
```

So a suppressed row's nested RECORD writes are now performed against the
pre-existing row. That is neither the base's behaviour nor the shipped one: the
route this unit cites (`joinWhenTargetExists`) is taken only for a
NON-relation-bearing row — `junction-create-many-routing.ts:76-84` sends a
`relationBearing` row to a series instead — and the shipped series abandoned a
skipped member entirely (`OperationExecutor` `skippedRoot → return true`,
`:894`) under an explicit "a skipped root must strand nothing" rule
(`assertProgressiveRootConflictEligibility`, `:2388-2416`). It also breaks the
idempotence users expect of `skipDuplicates`. No cell covers it, which is why
it is green.

**Resolution (verified):** restrict the replay to the membership children the
invariant names, and pin it.

```ts
    for (const child of record.children)
      if (
        child.placement !== "before" &&
        (child.command.kind === "link" ||
          child.command.kind === "remove" ||
          child.command.kind === "junction" ||
          child.command.kind === "membership")
      )
        await this.run(child, command);
```

I applied exactly this in a scratch copy: `duplicate singular createMany
targets transfer once` stays green on sqlite3 (file unchanged at 7 failed /
142 passed / 1 skipped), `suppression-replay`, `suppression-retry-contract` and
`bulk-series-contract` stay green (13 passed), and the probe above returns
`notes = []` again. Add one cell to `lane-x-set-mutations.test.ts` (or a new
parity file) pinning "a suppressed member writes its membership and NOT its
nested record children", since nothing in the estate states it.

If Arnaud would rather keep the wider replay, it is a NEW observable and a
decision, not a repair — then the AGENTS.md sentence must say what the code
does ("every child the member declared", not "the membership it declared") and
the cell must pin that instead.

### R2 (must fix) — one new Biome error introduced by the lane

`npx biome check` on the nine touched files: 20 errors, of which **19 are
present at the base byte-for-byte** (I ran the same check against
`git show 356254a2:<file>` for each). The one that is new is the lane's:

```
src/query-engine/raptor3/commands/execution.ts:200:7
  lint/complexity/useSimplifiedLogicExpression   FIXABLE
```

introduced by U6.4 removing `this.recovered ||` from the head of that guard.
The brief requires fixing by hand what the edits introduce.

**Resolution (verified):**

```ts
    if (
      !(
        choice &&
        error instanceof UniqueConstraintError &&
        this.matchesSelectedConstraint(choice, error)
      )
    )
      return false;
```

With this, `biome check execution.ts` reports only the four pre-existing
diagnostics and `lane-x-set-mutations.test.ts` stays at 8 passed. The two new
test files and the edited core test are Biome-clean already.

## 5. Notes (no action required, worth recording)

- **N1 — `prepareSingle`'s floating `plan.run()`** (`commands/index.ts:243-245`)
  is safe today *by construction*, not by check: every `single: true` shape
  (both root folds, the relation-free bulk verbs, `delete`) queues its
  statements and publishes its parser inside ONE synchronous
  `setMutations`/`publishPrepared` call, `read()` throws the preparation
  sentinel before any driver contact, and `PendingOperation.#resolveSinglePackage`
  discards a package whose `queries.length !== 1`. If a future `single: true`
  plan ever awaited before publishing its parser, this would publish a package
  for a half-prepared operation and `.catch(() => undefined)` would swallow the
  `incompletePreparation` sentinel that `prepareBatch` turns into `undefined`.
  One sentence in the comment (or an assertion that the run promise settled)
  would close it.
- **N2 — the guide now contradicts itself.** `AGENTS.md:587-592` still says
  `recoveryRejection` "answers `undefined` unless the ownership is standalone
  AND the route is the physical batch" and that "Its one caller,
  `CommandExecution.recover`" — both false after U6.4, which the lane section
  at `:796-809` says it supersedes. The author obeyed "do not rewrite other
  sections"; the merge owner should strike or annotate those two sentences, or
  the next reader will implement the stale rule.
- **N3 — U6.6's gate was written after its edits**, self-reported in the note.
  Honest, and the analysis it records is verifiable; recorded here so the
  program ledger keeps it.
- **N4** — the lane's other follow-ups (U6.3's repeated-selector half, U6.6's
  alternate-key insert-select case, the two hand-overs to lane Q) are correctly
  recorded as unshipped, and none is required by a red cell.

## 6. What must NOT change on revision

The five repaired sqlite3 cells, the six repaired pg cells, the two repaired
mysql2 cells and the eight repaired core-layer cells above are the lane's
receipt; re-run `provider-sqlite3`, `pg-nested-write-races`, `mysql2.test.ts`
and the four core layers after applying R1 and R2, and the typecheck once more
(it is currently exit 0 with zero diagnostics).
