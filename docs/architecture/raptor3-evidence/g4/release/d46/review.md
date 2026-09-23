# D-46 review — an upsert on the array route of a batch-only transport

Reviewer: independent (Sonnet 5), worktree `/private/tmp/viborm-d46` (branch
`d46`, top commit `b99c8c9c0`, base `522c47ed`). Scratch copy used for every
falsification and repro: `/private/tmp/viborm-d46-scratch` (detached worktree
at `b99c8c9c0`, no commits made, restored to a clean match of the delivered
tree before this review ended). `TMPDIR=/private/tmp/viborm-d46-tmp-r` for
every test run in this review, one file/mode per call.

## Verdict: REVISE

The unit's stated defect (the Neon upsert-in-array TransactionError) is fixed
correctly, and `CommandPlanner.rootUpsert` / `OperationContext.upsertOne`
faithfully restate the shipped engine's two upsert paths — every conjunct of
`buildOnConflictFold` is present, the conflict target is the addressed unique
key's columns, the probe-first form reuses `createMany`/`updateMany` with no
second statement builder, `single` is `true` only for the fold, and MySQL
(no `supportsTargetedUpsert`) falls to probe-first. Both required falsifiers
reproduce exactly as the note describes.

The mechanism chosen to unblock the upsert locate — narrowing
`OperationContext.read`'s batch-preparation refusal from "every read" to
"only terminal reads" — is not scoped to the upsert. It is a change to a
single, widely shared method with roughly a dozen other call sites, three of
which (`CommandExecution.runSelection`, its `foundRequirement` read, and its
series/membership scan — `commands/execution.ts:250`, `:452`, `:800`) are the
general nested-write interpreter's own planning reads, reachable from ANY
relation-bearing top-level `create`/`update` (not just `upsert`), because
`Commands.plan()` falls through to that same interpreter for relation-bearing
writes regardless of `ctx.preparesBatch`. I reproduced a concrete case where
this produces a wrong, misleading refusal instead of the honest one the base
commit gives — see finding 1. That is a direct hit on "refusals are
contracts," so I'm not marking this ACCEPT; it needs a scoped fix, not a
redesign, so it isn't BLOCK either.

## Findings

### Finding 1 — HIGH — the `read` narrowing is unscoped; it changes behavior for the general nested-write interpreter, not just upsert

**Location:** `src/query-engine/raptor3/shared/operation-context.ts:889-901`
(`OperationContext.read`), consumed (among others) by
`src/query-engine/raptor3/commands/execution.ts:250` (`runSelection`), `:452`
(`foundRequirement`), `:800` (series/membership scan).

**Description.** Before this unit, `OperationContext.read` refused *every*
read — terminal or planning — when `ownership === "batch-preparation"`. That
one unconditional refusal was the sole mechanism by which the general
nested-write interpreter (`CommandExecution`, used by any relation-bearing
top-level `create`/`update`, not just `upsert`) was kept out of the array
route: any `Choose`/nested-relation command tree that needed a planning read
during preparation hit `incompletePreparation` at its first read and the
whole operation was reported unbatchable
(`commands/index.ts:277-283`, `prepareBatch`'s catch). D-46 narrows the
refusal to `terminal` reads only. This is correct and necessary for the new
`rootUpsert` probe-first locate, but the narrowing lives in the one shared
`read()` method, so it applies to every other caller too.

I confirmed this is not hypothetical. Reproduction (scratch worktree, schema
`book.shelf: toOne` with a unique `shelf.label`, `BatchOnlyDriver`
— `supportsTransactions=false`, `supportsBatch=true`, same harness pattern as
the delivered pin):

```
await client.$transaction([
  client.shelf.create({ data: { id: "s1", label: "fiction" } }),
  client.book.update({
    where: { id: "b1" },
    data: { shelf: { connect: { label: "fiction" } } },
  }),
]);
```

- **Base (522c47ed, `read` unconditional):** zero direct reads run; the
  transaction fails cleanly with
  `TransactionError: Driver "sqlite3" does not support callback transactions
  and this transaction contains operations that cannot be batched atomically.`
  Nothing is written. Receipt:
  `review-receipts/scope-repro-base-before.log`.
- **Delivered (`b99c8c9c0`):** TWO direct SELECTs run at preparation — the
  `book.update`'s own locate and the nested `connect`'s target locate — before
  either array member's batch runs. The connect's locate cannot see shelf
  `s1` (array member 1 hasn't executed yet; it's still queued), so it
  legitimately finds nothing at that instant, and the operation fails with
  `NestedWriteError: Cannot connect relation 'shelf': target record was not
  found.` That message is **false** — the row exists in the same transaction,
  one array position earlier. Nothing is written either way, so this is not a
  data-corruption bug, but it replaces a correct, honest capability refusal
  with an incorrect data-existence error, and it does so by issuing two real
  reads against the driver that serve no purpose (the operation still cannot
  complete). On a real batch-only network driver (Neon HTTP, the case this
  unit is fixing) those reads are not free. Receipt:
  `review-receipts/scope-repro-delivered-after.log`. Repro script saved at
  `review-receipts/repro-scripts/zzz-review-d46-scope.test.ts`.

I also tried a `connectOrCreate` variant to see whether the same ordering gap
could produce a *silent* duplicate write (decide "missing" because the
locate can't see the earlier member's insert, and create a second row)
rather than just a wrong error. On the delivered tree this shape still ends
up as the same clean `TransactionError` (unbatchable) — some other,
still-active preparation refusal downstream of the two reads catches it —
so I did not reproduce silent duplication. I did not identify which refusal
catches it or whether every nested-write shape is equally protected; see
Unverified. Receipt: `review-receipts/scope-repro2-connectorcreate-delivered.log`,
script at `review-receipts/repro-scripts/zzz-review-d46-scope2.test.ts`.

This also makes one sentence in the note inaccurate: "The plan admits it
only where the conditional form cannot run at all — the array route, which
can issue no planning read (D-46)." The conditional form *can* and, per the
repro above, *does* run a planning read on the array route for non-upsert
operations after this change.

**Resolution (exact, minimal).** Don't change `OperationContext.read`'s
refusal condition at all — revert it to the unconditional
`if (this.ownership === "batch-preparation") throw this.incompletePreparation;`
it had before this unit. Give the one sanctioned direct read (the array
route's upsert locate) its own owner instead of a shared flag on `read`:

```ts
/**
 * The ONE sanctioned direct read at array-route preparation: the array
 * route's upsert locate (D-46; `rootUpsert`'s probe-first path). No other
 * caller may bypass the batch-preparation read refusal — `read()` keeps
 * refusing every read there, terminal or not, exactly as before this unit.
 */
async planningLocate(query: Query, model?: AnyModel): Promise<Input[]> {
  const response = await this.answer(query, false, model);
  return this.queries.decodeQuery(query, response.rows, true);
}
```

and change `rootUpsert`'s probe-first branch
(`commands/commands.ts:1181`) from
`await ctx.read(lookup.query(), true, false, model)` to
`await ctx.planningLocate(lookup.query(), model)`. This keeps "one owner per
fact" (the fact "batch-preparation refuses every read" stays a single,
unconditional statement in `read()`; the fact "the array-route upsert issues
one sanctioned direct locate" gets its own single, narrowly-named owner) and
is a smaller diff than the shipped one. It should not change any observable
behavior of the five new pin cells or the Neon cell — I did not re-verify
this by applying it (out of scope for "do not edit the author's files"; the
author or Arnaud should re-run the pin, the Neon cell, and my two scope
repros against it). Any other fix that achieves the same net effect — every
other reader of `read()` at batch-preparation keeps refusing unconditionally
— satisfies this finding equally well.

Separately from the code fix, the note's scope sentence quoted above should
be corrected once the fix lands, so the decision-elimination record matches
what the code actually does.

### Finding 2 — informational, no action needed — the seven-conjunct restatement is faithful, with two minor, favorable divergences

Verified `CommandPlanner.rootUpsert` (`commands.ts:1195-1298`) and
`OperationContext.upsertOne` (`operation-context.ts:1955-2014`) against
`UpsertOperation.ts`'s `buildOnConflictFold` (retired at `e8114ed9^`,
`:651-672`) and `operations/upsert.ts`'s `buildUpsert` (same commit):

| conjunct (shipped) | candidate |
| --- | --- |
| 1. `canFoldUpdateArm` = `!updateHasRelations && supportsReturning && projectionNamesNoRelation` | `!capabilities.supportsReturning → undefined`; `namesRelation(create) \|\| namesRelation(update) → undefined`; `!returningSafeProjection(projection) → undefined` |
| 2. `supportsTargetedUpsert` | `capabilities.supportsTargetedUpsert` (part of `spelled`) |
| 3. `conditionals.length === 0` | `args.targetWhere \|\| args.setWhere → undefined` |
| 4. `whereFilters === undefined` | implicit: `uniqueKey` (`query.ts:1165`) is only set when `where` has exactly one top-level key, which excludes an extended `where` with extra filter entries |
| 5. `whereNamesOneConstraint` | same `uniqueKey` fact (`keys.length === 1`) |
| 6. `createDataSpellsConflictTarget` (primitive `Object.is`, excludes Date/Decimal/bytes) | `key.fields.every(...)` with the same primitive-only + `Object.is` shape |
| 7. `isPlainSetUpdate` | `fields.every((f) => wholeValue(updates[f]))` |

Conflict target = `key.fields` (the addressed unique key's own columns), same
as the shipped `buildConflictTarget`. Probe-first reuses `ctx.createMany`
and `ctx.updateMany` verbatim — no second statement builder — and
`upsertOne` calls the same private `updateAssignments`/`setMutation` owners
`updateMany` uses (`operation-context.ts:1988`/`2021`, `:1996`/`2072`/`2146`).
`single: true` only on the `spelled` (fold) branch; the probe-first branch
returns `single: false`. MySQL's adapter declares
`supportsTargetedUpsert: false` (`mysql-adapter.ts:943`), confirmed by
reading the adapter file, so it always takes probe-first, matching the
claim.

Two small, favorable divergences, not defects: (a) the candidate checks
`namesRelation(create)`/`namesRelation(update)` explicitly, rather than
relying on the shipped engine's implicit "`createData` is `{}` for a
relation-bearing create" trick that conjunct 6's own comment in the retired
file flags as fragile ("falsification found NOTHING in the estate that could
tell the two apart... anyone who makes `createData` hold the scalar half of
a relation-bearing payload must restore that conjunct in the same edit") —
the candidate's explicit check removes that landmine; (b) `rootUpsert` adds
an explicit "update names no key of the model" guard
(`ctx.schema.keys(model).some(...)`) that isn't one of the seven conjuncts.
It isn't a duplicate fold check — it forces any key-touching update back to
the pre-existing conditional form, which is the ONLY place
`EngineSchema.keyTransitionRefusal` is invoked for upsert
(`commands.ts:1341`). Without this guard, a key-touching update could take
the fast path and skip that refusal entirely, since `rootUpsert` has no
key-transition check of its own. This is the correct way to avoid
re-implementing that legality check a second time.

One near-zero-severity nit: `upsertOne`'s `columns.length === 0` branch
(`insertDefault`) is unreachable from `rootUpsert` — `spelled` requires every
field of the addressed unique key to be present in `values` with a matching
primitive, so `columns` can never be empty for this caller. The shipped
`buildUpsert` throws `"No data to insert"` in that case instead. Dead code,
not a behavioral difference (no other caller of `upsertOne` exists). Not
required to be fixed.

## Reproduced

- Falsifier (a): reverted only the `read` narrowing (scratch copy, restored
  `if (this.ownership === "batch-preparation") throw ...` unconditionally).
  Neon cell drops to 11/12; the one failure is the original unbatchable
  `TransactionError`, matching the note. Receipt:
  `review-receipts/falsifier-a-read-narrowing-reverted.log`.
- Falsifier (b): reverted only the `rootUpsert` hook (commented out the
  `const folded = this.rootUpsert(...)` call in the upsert branch of
  `plan()`, left `read`/`upsertOne`/`preparesBatch` intact). Neon cell drops
  to 11/12; the failure is `QueryError: Query execution failed / Underlying
  error details redacted`, which matches the author's own
  `receipts/neon-probe-5.log` (same redacted message; that receipt's stderr
  probe shows the underlying cause is
  `Raptor 3 G1 atomic output requires exact identity scratch or segmented
  RETURNING` at `OperationContext.insert:2311`, i.e. the G1 refusal the note
  claims). Receipt: `review-receipts/falsifier-b-rootupsert-hook-reverted.log`.
- Delivered tree: Neon cell 12/12
  (`review-receipts/delivered-neon-12of12.log`); new pin
  `tests/raptor3/g4/parity/upsert-array-route.test.ts` 5/5
  (`review-receipts/delivered-pin-5of5.log`). Read every hunk of
  `git diff HEAD~1 -- src tests` and all five pin cells for real assertions:
  each checks the exact statement kind/shape (`SELECT`/`INSERT
  INTO`.../RETURNING/ON CONFLICT via regex on the captured SQL), the batch
  membership (which statements are direct vs. batched, and how many), and
  the resulting rows via a real in-memory SQLite database. The race cell
  (`RacingDriver`, "a row deleted between the locate and the batch") plants
  the delete inside `executeBatch` before the real batch runs, asserts the
  transaction rejects, and asserts the table ends up empty — i.e. the
  packaged presence premise aborts the write and nothing is left half-done,
  which is the behavior the note claims for that cell.
- `rootUpsert`/`upsertOne` vs. `buildOnConflictFold`/`buildUpsert`: read both
  retired sources in full (`git show e8114ed9^:...UpsertOperation.ts` and
  `...operations/upsert.ts`) and mapped every conjunct — see Finding 2.
- `uniqueKey`/`uniqueValues` semantics (`shared/query.ts:1163-1178`) and
  `wholeValue` (`:580-586`) read directly to confirm conjuncts 4/5/7 rather
  than trusting the note's characterization.
- MySQL `supportsTargetedUpsert: false` confirmed by reading
  `mysql-adapter.ts:943` (and `true` for sqlite/postgres at the same field).
- raptor3 modes on the delivered tree, own fresh `TMPDIR` each:
  `g2-transport` 16/16, `g3-transaction-array` 4/4, `g2-baseline` 216/216.
  Receipts: `review-receipts/mode-g2-transport.log`,
  `review-receipts/mode-g3-transaction-array.log`,
  `review-receipts/mode-g2-baseline.log`.
- Whole-estate typecheck: 0 diagnostics, exit 0. Receipt:
  `review-receipts/typecheck-delivered.log`. (The note's own log shows 0 too;
  the "two historical Pattern TS2345 errors" the common brief permits are not
  present in either run, so there's nothing to reconcile.)
- Finding 1's two repros, base vs. delivered, both directions — see Finding
  1 and receipts above.
- Grep of every `.read(`/`ctx.read(`/`this.read(` call site reachable from
  `OperationContext` across `src/query-engine/raptor3` to build the caller
  inventory for task 1. The `program.ts`/`program/index.ts` "G1-01 comparison
  specimen" engine's `scan`/`series` reads are a dead end for this concern:
  `program/index.ts:44` constructs its `OperationContext` with no
  `prepareBatch` argument (defaults to `false`), and `new Program(...)` has
  exactly that one call site (`grep -rn "new Program("`), so that
  interpreter's reads can never run under `ownership === "batch-preparation"`
  regardless of this unit. The live risk is entirely in
  `commands/execution.ts`'s `CommandExecution` (the interpreter
  `Commands.plan()` actually uses), specifically the three sites in Finding
  1.

## Judged

- **Scope decision (task 6).** "Both paths apply to the ARRAY route only" is
  true and verified: `rootUpsert` returns `undefined` immediately unless
  `ctx.preparesBatch` (`commands.ts:1227`), so the live route's upsert plan
  is untouched — it still builds the full `Choose` occurrence exactly as
  before (`commands.ts:1298` onward, unchanged in this diff). I did not find
  any live-route pin or recorded transport script referenced by this diff.
  Leaving the fold's live-route reuse as a D-47 candidate for Arnaud is
  reasonable and doesn't need to be decided in this unit. What the note gets
  wrong is a narrower claim nested inside that scope section — see Finding 1
  — which is about the `read` narrowing's reach, not about the fold's reach.
  The five kept-red pg `batch primary-key dataflow` cells are correctly
  identified as untouched (this unit's diff never touches the live batch
  route's generated-key dataflow).
- **Decision-elimination gate.** The two stated facts ("this context prepares
  a package" → `preparesBatch`; "a planning read may run at preparation, a
  terminal read may not" → the `read` narrowing) are each given one owner in
  the diff, and I found no second reader or policy boolean inside
  `rootUpsert`/`upsertOne` themselves. The second fact's owner is the one
  that needs narrowing per Finding 1 — not because it duplicates a decision,
  but because its actual reach is wider than the fact it was written to
  state.
- **"Refusals are contracts."** Falsifiers (a) and (b) show the two
  *registered* refusals (unbatchable TransactionError, G1 identity-scratch
  refusal) are both still reachable and correctly triggered when either half
  of the fix is missing — good. Finding 1 shows a *third*, previously
  correct refusal (unbatchable, for a relation-bearing array member) gets
  replaced by an incorrect one for at least one nested-write shape. That's
  the part of this rule the unit doesn't currently satisfy.
- **No test skipped, weakened or deleted.** Confirmed by reading every hunk
  of the diff — this unit only adds files/functions; no existing test file
  changed.

## Unverified

- Whether every nested-write shape reachable through `CommandExecution` on
  the array route is protected the way `connectOrCreate` happened to be
  (still refused, just after two wasted reads) or can be tricked into a
  silent wrong write (a duplicate row, a wrongly-skipped disconnect, etc.).
  I tried one shape (`connectOrCreate`) and it stayed safely unbatchable; I
  did not enumerate the rest (nested `disconnect`, `set`, a `series`
  many-relation write, a second-level nested `upsert`) or identify which
  specific downstream refusal caught the `connectOrCreate` case. This is the
  main open question a reader should resolve before trusting Finding 1's
  "no confirmed data corruption" as a general property rather than a
  property of the one shape I checked.
- The broader `raptor3` modes listed in the note but not in my instructions
  (`g2-contracts`, `g3p03-contracts`, `cs01-extension-a`, `g1-transport`,
  `g2-generated`, `g3-execution-review`,
  `g3-author-execution-regressions`) and the three layer projects
  (`layer-client` 536/536, `layer-write-engine` 50/50, `layer-query-engine`
  646/647) — I read the author's `MODES.log`/`PROJECTS.log` receipts and
  they're internally consistent with the note's numbers, but I did not
  independently re-run them (out of the scope I was given for task 5).
- Whether Neon HTTP specifically (as opposed to the SQLite harness I used
  for Finding 1's repro) would surface the same wasted-reads/wrong-error
  behavior identically — I used the same SQLite `BatchOnlyDriver` pattern
  the delivered pin already uses, not the real Neon driver/fake. The
  mechanism (`OperationContext.read`'s narrowed guard) is driver-agnostic,
  so I have no reason to expect Neon HTTP to behave differently, but I did
  not check it directly.
- I did not verify the `cost` section's LOC/token/byte accounting (task 7 of
  the common brief) — out of the scope I was given.

## Re-check: repair round (`2648e938`) — verdict ACCEPT

Re-checked the repair round applied on top of this review, worktree
`/private/tmp/viborm-d46` at top commit `2648e938d` ("wip(d46): repair
round"), against the exact minimal resolution Finding 1 proposed. Scratch
copy reused for verification: `/private/tmp/viborm-d46-scratch`, checked out
to `2648e938d` clean (no local changes before or after this pass — nothing
committed, staged, reset, stashed or pushed). `TMPDIR=/private/tmp/viborm-d46-tmp-r`
for every run, one file/mode per call.

**1. `git diff b99c8c9c..2648e938 -- src tests` is exactly that and nothing
else moved.** Confirmed — three files only:

- `src/query-engine/raptor3/commands/commands.ts`: one line, the
  `rootUpsert` probe-first locate now calls `ctx.planningLocate(lookup.query(),
  model)` instead of `ctx.read(lookup.query(), true, false, model)`.
- `src/query-engine/raptor3/shared/operation-context.ts`: `read`'s refusal at
  batch-preparation is unconditional again (`if (this.ownership ===
  "batch-preparation") { throw this.incompletePreparation; }`, the `&&
  terminal` removed), and a new `planningLocate(query, model)` method is
  added right before it — `grep -rn "planningLocate" src/` shows exactly one
  definition and exactly one caller (`commands.ts:1181`).
- `tests/raptor3/g4/parity/upsert-array-route.test.ts`: adds the `shelf`/
  `book` relation schema and one new cell, "the boundary the review
  measured: a relation-bearing member elsewhere in the array keeps the
  unbatchable refusal, never a false absence" — the exact scenario from
  Finding 1 (`shelf.create` + `book.update` with a nested `connect`),
  asserting the `TransactionError`/"does not support callback transactions"
  message and an empty `d46_shelves` table.

This is precisely the fix proposed in Finding 1 — revert `read()` to
unconditional, give the one sanctioned locate its own narrowly-named owner,
and no other call site changed. Nothing outside these three files moved
under `-- src tests`. (The full diff also carries the note's corrections and
new evidence files under `docs/`, which I read and found accurate — see
below — plus this review's own `review.md`/`review-receipts/` from the prior
pass, evidently carried along when the author committed the worktree.)

**2. The two scope repros, copied into a detached scratch worktree at
`2648e938`, now answer the honest unbatchable refusal.**

- `zzz-review-d46-scope.test.ts` (plain `connect`, book.update depending on
  shelf.create earlier in the same array): `DIRECT (pre-batch) statements:
  []` — zero live reads at preparation, versus two on the pre-repair tree —
  and the outcome is `TransactionError: ... does not support callback
  transactions ...`, matching the base-commit behavior exactly (compare
  `review-receipts/scope-repro-base-before.log` from the original review).
  Receipt: `review-receipts/recheck/scope-repro1-repaired.log`.
- `zzz-review-d46-scope2.test.ts` (`connectOrCreate` variant): same result —
  zero direct reads, same honest `TransactionError`, nothing written.
  Receipt: `review-receipts/recheck/scope-repro2-repaired.log`.

Both repro scripts were removed from the scratch worktree after running
them; the scratch worktree is clean at `2648e938d` with no diff.

**3. Neon file 12/12, the pin 6/6, typecheck zero.** All confirmed
independently:

- `tests/contracts/engine/write/neon-committed-segments-capability.test.ts`
  (project `coverage-write-engine`): 12/12. Receipt:
  `review-receipts/recheck/neon-12of12-repaired.log`.
- `tests/raptor3/g4/parity/upsert-array-route.test.ts` (project
  `extended-local`): 6/6 (the five original cells plus the new boundary
  cell). Receipt: `review-receipts/recheck/pin-6of6-repaired.log`.
- Whole-estate typecheck (`node scripts/run-typecheck.mjs`): 0 diagnostics,
  exit 0. Receipt: `review-receipts/recheck/typecheck-repaired.log`.

As a further check beyond what was asked (cheap, and this is exactly the
area the finding was about), re-ran the three raptor3 modes from the
original review on the repaired tree: `g2-transport` 16/16, `g3-transaction-
array` 4/4, `g2-baseline` 216/216 — identical counts to the pre-repair run,
so the surgical fix (revert `read`, add `planningLocate`, repoint one call
site) introduced no regression in the interpreter paths it touches
(`conditional-upsert-legacy`, `junctions-legacy`, etc. are part of
`g2-baseline`).

**Note corrections.** Read the note's diff (outside the `-- src tests`
scope of check 1, but relevant to judging the repair as a unit): the
"smallest change" table's `read`-narrowing row is replaced with the accurate
"the one read a preparation may issue" / `planningLocate` description, the
"Decisions that disappear" sentence is corrected to "exactly one, the upsert
locate," the falsification bullet now says "routing the locate through
`read` again (or removing `planningLocate`)" instead of the old "reverting
the `read` narrowing," and a new "§6 Repair round" section names the
review's finding and states what was changed. All of this matches what the
diff actually does; I found no remaining trace of the inaccurate "the array
route, which can issue no planning read" framing.

**Verdict: ACCEPT.** The repair is the exact minimal resolution Finding 1
asked for, applied with no scope creep (one call site repointed, one method
added, one refusal reverted, one test cell added), verified by both of my
original repro scripts now landing on the honest refusal, by the delivered
suites (Neon 12/12, pin 6/6, typecheck 0), and by re-running the three
raptor3 modes with no change in outcome. Finding 2 (the faithful
seven-conjunct restatement) was already informational/no-action and is
untouched by this round. I have no further findings.

**Unverified (carried over / new).** Same caveats as the original review's
Unverified section apply unchanged: I did not enumerate every nested-write
shape beyond `connect`/`connectOrCreate` to confirm none of them could reach
a silent wrong write rather than a refusal (moot now in the specific sense
that `planningLocate` closes the read-narrowing's blast radius entirely —
every interpreter planning read, of any shape, is refused at
batch-preparation again, exactly as before D-46 — so this caveat no longer
depends on per-shape behavior); I did not independently re-run the broader
modes/layer-project totals outside the ones listed above; I did not check
Neon HTTP directly (still used the same SQLite `BatchOnlyDriver` harness).
