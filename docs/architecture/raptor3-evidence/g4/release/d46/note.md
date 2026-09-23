# D-46 — an upsert on the array route of a batch-only transport (author note)

Author: the integrator (Fable), under D-45 (Opus unavailable until 22 Sep).
Worktree `/private/tmp/viborm-d46`, branch `d46` from `522c47ed` (the branch
head after commit 11 and Arnaud's docs commit). `TMPDIR=/private/tmp/viborm-d46-tmp`.
Receipts: `receipts/`.

## 0. The defect, measured

`tests/contracts/engine/write/neon-committed-segments-capability.test.ts` ›
"generated scalar create and upsert return from one native Neon request" was
red at the base (`receipts/neon-before.log` is the coverage lane's
`write-engine-neon-failure.log`): `client.$transaction([upsert, create])` on a
driver with no callback transactions answered
`TransactionError: Driver "neon-http" does not support callback transactions
and this transaction contains operations that cannot be batched atomically`,
because the route's `prepareBatch` answered `undefined` for the upsert. The
cell pins the engine replaced: one DIRECT statement (the upsert's locate
read), then ONE native batch of two `INSERT … RETURNING` statements, and the
two rows back.

Bisected with probes (`receipts/neon-probe*.log`, probes removed): the
conditional form's locate read raised `incompletePreparation` on the
batch-preparation ownership; with that read allowed, the create arm then hit
the registered G1 refusal `Raptor 3 G1 atomic output requires exact identity
scratch or segmented RETURNING` in `OperationContext.insert`, because a
record arm's generated key travels through the identity scratch and the
terminal read-back, which a batch-only transport without segmented RETURNING
cannot carry — the same family as the five registered kept-red pg cells.

## 1. Decision-elimination gate

**Required behaviour.** The engine replaced served a top-level upsert on the
array route with its two paths (`write-engine/UpsertOperation.ts`, retired
`ATOM.md` §15): (1) "an eligible `ON CONFLICT` fold has no planning read" —
one targeted conflict statement under seven conjuncts (`buildOnConflictFold`);
(2) otherwise probe-first — the locate read decides create-versus-update at
planning, and a SCALAR arm stays inline as one statement with RETURNING
("scalar RETURNING fold on either arm shape"), with batch mode pinning the
captured row's identity inside the batch.

**Current owner.** The plan (`CommandPlanner.plan`, the upsert branch) builds
the conditional `Choose` form for every route; `OperationContext.read` refused
every read at preparation; the folded root write owners already exist
(`rootCreate` → `createMany` with RETURNING; `rootUpdate` → `updateMany` with
RETURNING and its packaged presence premise).

**Smallest change, one owner per fact.**

| fact | owner | change |
| --- | --- | --- |
| "this context prepares a package" | `OperationContext.preparesBatch` (a reader of the existing ownership, not a new flag) | added |
| "the one read a preparation may issue" | `OperationContext.planningLocate` — the upsert locate; `read` keeps refusing every read at preparation, terminal or not (the review measured that widening it let a `connect`'s planning read run before the earlier array member inserted its target, a false absence in place of the honest refusal) | added (after the review) |
| the fold's statement | `OperationContext.upsertOne` — INSERT + `mutations.onConflict(target, onConflictUpdate(sets))` + RETURNING, published through `setMutation` like `updateMany` | added |
| the array route's upsert plan: which of the two paths, and the arms as the existing folded root writes | `CommandPlanner.rootUpsert`, hooked at the head of the upsert branch, only when `preparesBatch` | added |

`rootUpsert` restates the shipped fold's conjuncts (a targeted-upsert adapter
with RETURNING; no conditional filter; a `where` naming one constraint and
nothing else; the create spelling every column of that constraint with the
primitive value the `where` names — `ON CONFLICT` arbitrates on the proposed
row, not on the caller's `where`; a set-only update; scalar arms; a non-empty
update naming no key of the model; a RETURNING-safe projection). Outside the
fold it takes probe-first: the locate read at preparation, then
`createMany([values], projection)` or `updateMany(identitySelector, updates,
projection)` — the found arm's presence premise is the one `updateMany`
already packages. The form answers `single: true` only for the fold (a
planning read plus an arm is never one statement; answering `true` made the
deferred envelope re-run the body and issue the read twice — measured,
`receipts/neon-after-3.log`).

**Scope, deliberately.** Both paths apply to the ARRAY route only. The
shipped fold also served the live route (one statement where this engine
issues a locate and an arm); keeping it to the array route leaves every
live-route pin and recorded transport script untouched. Widening the fold to
the live route is a physical-plan decision for Arnaud (D-47 candidate), not a
repair. The five kept-red pg `batch primary-key dataflow` cells are the live
batch route's generated-key dataflow and are not touched by this unit.

**Decisions that disappear.** "Can the array route carry an upsert at all on
a batch-only transport?" — it can, as the engine replaced could, by the two
forms above. "Which read may a preparation issue?" — exactly one, the upsert
locate, stated once at its own owner; every other read keeps the refusal.

**Named consequences.** A planning read issued at preparation cannot see the
writes of earlier members of the same array (they are still in the batch);
the engine replaced had the same limit, and the packaged presence premise
fails the batch when the captured row is gone by the time it runs (pinned).
`update: {}`, a relation-bearing arm and a conditional filter keep the
conditional form and, on this route, the existing unbatchable answer
(pinned).

## 2. Falsifiers

- `tests/contracts/engine/write/neon-committed-segments-capability.test.ts`
  12/12 (`receipts/neon-after-4.log`); red at the base.
- New pin `tests/raptor3/g4/parity/upsert-array-route.test.ts`, 5 cells on a
  real SQLite database with a batch-only recording transport: the create arm
  (one direct SELECT, one batch of two `INSERT … RETURNING`, the rows), the
  found arm (one direct SELECT, an `UPDATE … RETURNING` as the batch's last
  statement, no INSERT), the race (a row deleted between the locate and the
  batch fails the batch, nothing written), the fold (no direct statement, one
  `INSERT … ON CONFLICT … RETURNING`, inserting then updating), and the
  boundary (an empty update keeps the unbatchable answer). 5/5
  (`receipts/pin-3.log`).
- Falsification: routing the locate through `read` again (or removing
  `planningLocate`) returns the Neon cell to its original unbatchable answer
  (the probe-first path cannot start);
  reverting the `rootUpsert` hook alone returns it to the G1 refusal
  (`receipts/neon-probe-5.log` shows that state). Both recorded before the
  repair; the reviewer reproduces them in a scratch copy.

## 3. Verification

- typecheck: 0 diagnostics (`receipts/typecheck-4.log`).
- raptor3 modes on this tree: g2-transport 16/16, g2-baseline 216/216,
  g2-contracts 216/216, g3p03-contracts 6/6, cs01-extension-a 6/6,
  g1-transport 44/44, g2-generated 52/52, g3-execution-review 6/6,
  g3-author-execution-regressions 3/3 (`receipts/MODES.log`);
  g3-transaction-array 4/4, gate verified on a fresh TMPDIR
  (`receipts/mode-g3-transaction-array-2.log`; the first run in the unit's
  TMPDIR had recorded the tree before the last edit and reported it stale).
- layer projects (`receipts/PROJECTS.log`): layer-client 536/536,
  layer-write-engine 50/50, layer-query-engine 646/647 — the one red is the
  pre-existing inventory cell of `contract-matrix.core.test.ts`, fixed on the
  CI branch (this branch is cut from the docs commit before it).
- biome: the two touched production files carry one fewer diagnostic than
  their base each; the new pin is clean.

## 4. Cost

`git diff --numstat 522c47ed -- src tests`: see the integrator's record.
Production: `commands.ts` (+`rootUpsert`, the hook), `operation-context.ts`
(+`preparesBatch`, +`upsertOne`, the `read` narrowing). No policy boolean,
no second reader, no new class; the two forms reuse `createMany`,
`updateMany`, `setMutation` and the adapters' existing conflict vocabulary.

## 5. Open for Arnaud

- **D-47 candidate:** widen the `ON CONFLICT` fold (and the inline scalar
  arms) to the live route, as the engine replaced did — a physical-plan change
  that moves recorded transport scripts and the D-9 perf cells.
- The five kept-red pg `batch primary-key dataflow` cells (the live batch
  route's generated-key dataflow) remain a registered limitation.

## 6. Repair round (after the Sonnet review, REVISE → applied)

The review's one finding (high): the `read` narrowing was not scoped to the
upsert locate — the interpreter's planning reads (`runSelection`, the
found-requirement read, the series scan) also ran at preparation, and a
`connect` to a row an earlier member of the same array inserts answered a
false "target record was not found" instead of the honest unbatchable
refusal. Applied exactly as proposed: `read`'s refusal at preparation is
unconditional again; `OperationContext.planningLocate` is the one sanctioned
direct read, used by `rootUpsert` alone; the review's scenario is now the
pin's sixth cell (the refusal stays, nothing is written). Re-verified
below.

Re-verified after the repair: Neon 12/12 (`receipts/neon-after-5.log`), pin
6/6 (`receipts/pin-4.log`), typecheck 0 (`receipts/typecheck-5.log`), modes
g2-transport 16/16, g3-transaction-array 4/4, g2-baseline 216/216,
g2-contracts 216/216 (`receipts/REPAIR-MODES.log`); lint counts at base.
Re-check: ACCEPT (`review.md`, "Re-check").

