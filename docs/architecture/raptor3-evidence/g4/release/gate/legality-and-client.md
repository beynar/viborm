# Gate triage — family "legality-and-client"

Read-only classification. Repository `/Users/arnaud/code/viborm`, branch
`pattern-engine`, head `7bc08ebd9`. All six files re-run individually via
`node scripts/run-vitest-safe.mjs --project extended-local <file>` with
`TMPDIR=/private/tmp/viborm-triage-legality-tmp`. Receipts:
`/private/tmp/viborm-triage-legality-tmp/{occupied-to-many,occupied-to-one,referenced-column,transition-arm,batch-transaction,operations}.out`.
12 red cells total, matching the gate-inventory logs
(`/private/tmp/claude-501/-Users-arnaud-code-viborm/c2c775da-2927-4590-8677-3bb0f5d1aa98/scratchpad/gate-inventory/{shared-family-5,6,7,8,imported-pglite-2}.log`).
Nothing in the repository was edited; nothing else in the shared triage
scratchpad was touched.

## Table

| file | cell | class | one-sentence reason | ruling / registration / engine site |
|---|---|---|---|---|
| relation-key-update-legality-occupied-to-many.test.ts | "rejects an occupied setNull TO-MANY UPDATE under a PK transition" | C | the **batch** arm answers unattributed `QueryError`("Query execution failed") where the **live** arm correctly answers `NestedWriteError`; parity check `expect(batch.error).toEqual(live.error)` at fixtures.ts:312 catches the divergence | no registration found; site: `commands/execution.ts:128-136` (`requireAbsent` occupied-guard), assertion attribution in `shared/operation-context.ts:1243-1294`, statement-index resolution `drivers/driver-diagnostics.ts:26-55` |
| relation-key-update-legality-occupied-to-many.test.ts | "rejects an occupied target UPDATE while an occupied sibling is untouched" | C | same batch-arm `QueryError`-vs-`NestedWriteError` divergence, same nested `items: {update:{...}}` shape | same as above |
| relation-key-update-legality-occupied-to-one.test.ts | "rejects an occupied setNull child-held UPDATE under a PK transition" | C | same batch-arm `QueryError` divergence on a to-one child, nested `child: {update:{...}}` | same as above |
| relation-key-update-legality-occupied-to-one.test.ts | "reports not-found for an empty setNull child-held UPDATE under a PK transition" | C | same batch-arm `QueryError` divergence (expected `NestedWriteError` "target record was not found") | same as above |
| relation-key-update-legality-occupied-to-one.test.ts | "allows an empty setNull child-held DELETE under a PK transition" | C | the **live** arm (not batch) wrongly raises `NestedWriteError` "target record was not found for this parent" for `child: {delete:true}` on an already-empty to-one slot, which is an established no-op elsewhere in the estate | no registration found for the PK-transition combination; established no-op precedent: `tests/contracts/engine/write/polymorphic-collection-write-family.test.ts:1648` ("`delete: true` on an EMPTY slot writes nothing"); site: `commands/relation-body.ts:217-267` (`relation()`, delete/disconnect verb, `requireLookup`) |
| relation-key-update-legality-occupied-to-one.test.ts | "rejects an occupied restrict child-held UPDATE under a PK transition" | C | same batch-arm `QueryError` divergence, `onUpdate('restrict')` variant | same as first row |
| relation-key-update-legality-referenced-column.test.ts | "allows literal non-PK referenced transition with cascade" | C | the **batch** arm wrongly raises `NestedWriteError` "target record was not found for this parent" for `members.update` under a CASCADING referenced-column (`organization.code`) transition where live correctly succeeds; requireTransitions skips cascade edges entirely (execution.ts:97-102), so the false rejection must come from the nested to-many update's own membership-correlation premise being evaluated against the pre-cascade `organizationCode` value inside the same batch | no registration found; suspected site: `commands/relation-body.ts` nested `updateMany`/membership-correlation premise construction (~line 600-650, `target record was not found for this parent` at `:645`), ordering vs. cascade in `commands/execution.ts:298-340` |
| relation-key-update-legality-transition-arm.test.ts | "allows primary-key arithmetic transition with cascade upsert" | C | expected total success; **live** instead raises `UniqueConstraintError` (consistent with the child `upsert`'s locate wrongly taking the CREATE arm instead of UPDATE after the parent's cascade already rewrote the child's `parentId`, colliding on the child's unique FK), **batch** raises an unattributed `NestedWriteAssertionError` (the generic floor message, `NESTED_WRITE_ASSERTION_FLOOR_MESSAGE`) instead of any named error | no registration found; suspected site: upsert locate/choose-arm construction in `commands/relation-body.ts` (~line 500-530) and cascade-vs-child-locate ordering in `commands/execution.ts:298-340`; floor message site `errors` (`NESTED_WRITE_ASSERTION_FLOOR_MESSAGE`), attribution logic `shared/operation-context.ts:1243-1294` |
| batch-transaction.test.ts | "batch-only driver batches nested write operations atomically" | B (ruled) | `user.update({data:{name, posts:{create:{...}}}})` inside `$transaction([...])` on a batch-only (pglite) driver is refused with `TransactionError`("...cannot be batched atomically") because `rootUpdate` bails on any relation-bearing `data` and the array route has no other batching path for it | registration: `docs/architecture/raptor3-evidence/g4/release/d46/note.md` §"Named consequences": "`update: {}`, a relation-bearing arm and a conditional filter keep the conditional form and, on this route, the existing unbatchable answer (pinned)."; code: `commands/commands.ts:1077` (`if (ctx.schema.namesRelation(model, args.data)) return undefined;` inside `rootUpdate`); refusal constructor `src/client/array-transaction-native-batch.ts:65-75` |
| batch-transaction.test.ts | "batch-only shared parsing keeps exact partitions with insert ids" | B (ruled) | same shape (`user.update` with nested `posts.create`) inside `$transaction([...])`, same "relation-bearing arm" pinned-unbatchable registration | same as above |
| batch-transaction.test.ts | "batch-only: a premise the rollback does NOT restore is still attributed to its own guard" | B (ruled) | `user.update({data:{posts:{connect:{id:'never-existed'}}}})` as the SOLE member of `$transaction([...])` is refused upfront as unbatchable (same relation-bearing-arm registration) before the test's intended assertion-attribution logic is ever reached | same registration as above |
| operations.test.ts | "refuses a child-held connect across more than one matched row" | C | `updateMany({where: matches 2 rows, data:{posts:{connect:[...]}}})` resolves successfully instead of refusing; the retired engine's documented behavior (child-held `connect`/`connectOrCreate`/`set` refused before the first write when capture found >1 root) has no Raptor 3 equivalent — a full-repo grep for the expected message and for the general "more than one root" concept found nothing under `src/` outside the deleted `write-engine` | retired-engine registration: `docs/architecture/retired/write-engine-ATOM.md:1053-1082`; former site (deleted from `src/`, only referenced in stale `refusals.json` entries): `src/query-engine/write-engine/bulk-polymorphic-connect.ts`; suspected current-owner gap: `commands/commands.ts` `SelectedSeries`/`analyzeSeries` (~lines 162-500, 982-1433), which has no analogous multi-root refusal for `updateMany` + child-held relation part |

## Class A — physical-plan pin

None of the 12 red cells in this family are class A: none of the assertions
pin SQL text, statement count, CTE shape, batch segmentation or an alias —
every failure is an observable-result/error-class divergence caught by
`expectParity`'s `{name, message}` comparison or by a plain
`.rejects.toMatchObject`/`.message` assertion.

## Class B — registered refusal (3 cells, all B-ruled)

All three are the SAME registered shape: a top-level `update` whose `data`
names a relation (`posts: {create:{...}}}` or `posts: {connect:{...}}}`),
submitted as (or as the sole member of) an array-mode `$transaction([...])`
on a driver with no callback-transaction fallback (`pglite`, forced through
`BatchOnlyPGliteDriver`/plain `PGliteDriver` used batch-only in these tests).
`rootUpdate` (`commands/commands.ts:1072-1087`) is the array route's ONE
folding path capable of producing a native-batchable statement; its very
first guard, line 1077, is `if (ctx.schema.namesRelation(model, args.data))
return undefined;` — any relation-bearing update takes the `undefined`
(unbatchable) exit immediately, with no other array-route path to try. D-46's
note (`docs/architecture/raptor3-evidence/g4/release/d46/note.md`, "Named
consequences") registers this in prose: "`update: {}`, a relation-bearing arm
and a conditional filter keep the conditional form and, on this route, the
existing unbatchable answer (**pinned**)." That parenthetical "(pinned)" is
what makes this B-**ruled** rather than B-open — it is stated as an accepted,
deliberate scope limit of D-46 (which widened the array route's upsert
coverage only, explicitly declining to widen update coverage), not as an
oversight. The generic mechanism that produces the observed
`TransactionError` message is also independently pinned by
`tests/contracts/public-client/array-transaction-legacy-batch-boundaries.core.test.ts:88-104`
and `array-transaction-closure.core.test.ts:216-239` (both `.core.test.ts`,
outside this family, exercising the refusal via an artificially-forced
`prepareBatch: () => undefined` rather than a real relation-bearing update,
but confirming the refusal path itself is intentional production behavior,
not a bug).

Caveat (see Unverified): I could not independently confirm that the
*retired* engine actually executed this exact shape atomically as a native
batch member. `commands.ts:1061-1067`'s own comment about `rootUpdate`
attributes the SAME "a relation projection must read other rows, which no
RETURNING can carry" limitation to the shipped engine's own `UpdateOperation
canFold` gate, which suggests the retired engine may have had a structurally
similar limitation on the array route. If so, this is parity rather than "a
refusal replacing executed retired behavior" in the strictest reading of the
class-B definition — but the brief's own alternative phrasing ("or refuses
with another class or sentence") and the explicit, named, "(pinned)"
registration in D-46 still place it in B rather than C: there is a registered
decision on record, and no ruling contradicts it.

## Class C — shipped-engine defect (8 cells)

All eight are various shapes of ONE family of divergence: **a relation-key
PK or referenced-column transition on a parent record, combined with a
nested to-many/to-one write verb on the SAME parent's `update`, executed
through the forced-atomic-batch path, produces a wrongly-classified or
unattributed error** (or, in one case, a wrongly-*raised* error on the live
path for an already-established no-op shape). None of the eight has a
registration, ruling, or note naming this shape anywhere under
`docs/architecture/raptor3-evidence/g4/` (checked: `g4.md`,
`AGENTS.md`, `root-review-C-receipts/{refusals.json,refusal-census.txt}`,
`rulings/{note.md,o1/note.md,o2/note.md}`, and a repo-wide grep for
`occupied`/`setNull` near the relation-key-update-legality suite names).

**Reproduction and suspected owner, by symptom:**

1. **Batch-arm `QueryError` instead of `NestedWriteError`/`RESTRICT` (5
   cells: both occupied-to-many failures, 3 of the 4 occupied-to-one
   failures).** Model: `setNullList`/`setNullItem` or
   `setNullParent`/`setNullChild`/`restrictParent`/`restrictChild`.
   Operation: `update({data: {id: {increment: N}, <relation>: {update:
   {...}}}})` — always with a NESTED **"update"** sub-verb (never
   create/delete/disconnect — those pass). Transport: the forced-batch
   `BatchOnlyPGliteDriver` arm inside `expectParity`. The occupied-guard
   premise (`commands/execution.ts:118-136`, `requireAbsent`) queues a
   division-by-zero assertion trick (`adapters/databases/postgres/postgres-adapter.ts:533-534`)
   in batch mode; the marker/floor-message classification lives in
   `drivers/error-mapping.ts:68-115,232-241`
   (`ASSERTION_MARKER`/`isAssertionFailure`/`NestedWriteAssertionError`), and
   attribution back to the registered `failure` (the `NestedWriteError`)
   happens in `shared/operation-context.ts:1243-1294`, which for an
   un-indexed statement falls back to a live re-probe of each registered
   assertion (`:1250-1261`). I could not, read-only, pin which exact step
   fails when a nested child **update** statement is queued in the same
   batch as the assertion (create/delete siblings do not trigger it); my
   best-supported hypothesis is that the statement-index attribution in
   `drivers/driver-diagnostics.ts:26-55`
   (`findUniqueExecutionContextIndex`, which returns `undefined` for any
   raw, not-yet-VibORM-typed error once the batch has more than one
   statement) interacts differently with an UPDATE statement's own error
   surface than with an INSERT/DELETE's, so the raw provider error the
   nested update path can independently produce never reaches the
   assertion-floor/re-probe branch at all and falls straight to generic
   `QueryError`. Flagged as unverified below — see Blockers for why I could
   not execute a targeted repro.

2. **Live-arm false-positive `NestedWriteError` on an established no-op (1
   cell).** Model: `setNullParent`/`setNullChild`. Operation:
   `update({data: {id: {increment: 1}, child: {delete: true}}})` where NO
   child exists (empty to-one slot). Expected: silent no-op (parent id
   increments, nothing else happens) — matching the general, currently-green
   precedent at `tests/contracts/engine/write/polymorphic-collection-write-family.test.ts:1648`
   ("`delete: true` on an EMPTY slot writes nothing"). Actual: `NestedWriteError`
   "Cannot delete relation 'child': target record was not found for this
   parent." Site: `commands/relation-body.ts:217-267`, the `delete`/`disconnect`
   verb's unconditional `this.requireLookup(outgoing)` at `:240`, which does
   not appear to special-case an empty slot the way the general precedent
   does; suspected interaction with the SAME parent's PK-transition
   `command.transitions` bookkeeping (`relation-body.ts:209-216`) since the
   no-op precedent above has no accompanying PK transition on its parent.

3. **Batch-arm false-positive `NestedWriteError` under a CASCADE (1 cell).**
   Model: `organization`/`member` (referenced-column `code`, `onUpdate:
   'cascade'`). Operation: `organization.update({data: {code: {set: 11},
   members: {update: {where: {id: 1}, data: {...}}}}})`. `requireTransitions`
   explicitly skips cascade edges (`execution.ts:97-102`), so the occupied
   guard is not the cause here; the false "target record was not found for
   this parent" (message site `relation-body.ts:645`) most likely comes from
   the nested `members.update`'s own membership-correlation/`requirePresent`
   premise being captured against the PRE-cascade `organizationCode` value
   (10) and evaluated, inside the same batch, AFTER the cascade's own
   `UPDATE members SET organizationCode = 11 WHERE organizationCode = 10`
   has already run — a stale-correlation/statement-ordering defect distinct
   from (1) and (2) but in the same neighborhood (`commands/relation-body.ts`
   nested-update membership capture, `commands/execution.ts:298-340`
   ordering of `requireTransitions`/before/capture/after children).

4. **Live-arm `UniqueConstraintError` + batch-arm unattributed
   `NestedWriteAssertionError`, both instead of success (1 cell).** Model:
   `cascadeParent`/`cascadeChild` (child-held to-one, cascade, unique FK
   `parentId`). Operation: `cascadeParent.update({data: {id: {increment: 1},
   child: {upsert: {create: {id: 2, ...}, update: {label: 'Updated'}}}}})`
   where the child already exists (id 1, parentId 1) and the upsert should
   resolve to its UPDATE arm. Expected state keeps child id 1 with
   `parentId: 2` (cascaded) and `label: 'Updated'`. The live-arm
   `UniqueConstraintError` is consistent with the upsert's locate read
   finding NO row for `parentId = 1` (because the parent's own cascade
   already rewrote it to 2) and therefore wrongly taking the CREATE arm,
   attempting to insert a second row with `parentId: 2` against the
   existing (already-cascaded) child's unique `parentId` — a collision. The
   batch arm's unattributed `NestedWriteAssertionError` (the generic
   `NESTED_WRITE_ASSERTION_FLOOR_MESSAGE`) is the batch-mode symptom of the
   same underlying ordering problem, compounded by the same
   attribution gap described in (1). Suspected owner: the upsert
   locate/choose-arm construction (`commands/relation-body.ts`, the
   `upsert` verb, roughly lines 500-530) versus cascade-vs-child-locate
   ordering in `commands/execution.ts:298-340`.

5. **Missing multi-root refusal on `updateMany` + child-held `connect` (1
   cell).** Model: `user`/`post` (child-held FK `authorId` on `post`).
   Operation: `user.updateMany({where: {age: {gte: 25}}, data: {posts:
   {connect: [{id: 'post-1'}]}}})` where the `where` matches 2 users.
   Expected: refused before the first write
   ("updateMany matched 2 rows ... 'connect' ... 'posts'"), per the retired
   engine's documented, deliberate behavior
   (`docs/architecture/retired/write-engine-ATOM.md:1053-1063`: "A root
   membership that lives on the TARGET row and NAMES AN EXISTING TARGET —
   child-held `connect`, `connectOrCreate`, `set`... — is refused before the
   first write when the capture found more than one root, naming the
   observed count."). Actual: the call resolves without error and the
   `captureThrown` helper returns `undefined`
   (`operations.test.ts:791`, `TypeError: Cannot read properties of
   undefined (reading 'message')`). A full-text and conceptual grep of
   `src/` (message text, "more than one", "N-greater-than-one", "matched...
   root") found nothing outside the deleted `write-engine` tree; the
   `refusals.json` census entries naming this behavior
   (`src/query-engine/write-engine/bulk-polymorphic-connect.ts:52-231`) are
   stale, pre-deletion references. Raptor 3's `SelectedSeries`/`analyzeSeries`
   machinery (`commands/commands.ts`, ~lines 162-500 and 982-1433) is the
   structural analog of the retired engine's per-root series expansion for
   bulk relation-bearing writes, but I found no code path in it that counts
   captured roots and refuses a child-held relation part above one — this
   looks like a genuine gap (the refusal was not ported), not a deliberate
   omission; no registration says otherwise.

## Class D — retired-internal reached

None. Every red cell in this family reaches real, current Raptor 3
production code (`commands/execution.ts`, `commands/relation-body.ts`,
`commands/commands.ts`, `shared/operation-context.ts`, `shared/query.ts`,
`drivers/error-mapping.ts`, `drivers/driver-diagnostics.ts`,
`client/array-transaction-native-batch.ts`) — nothing lands in a deleted
`write-engine`/`query-engine-v2` internal, an instrumentation attribute of
the retired engine, or a runner-only replay/specimen environment. (The
retired `write-engine-ATOM.md` is cited only as a DOCUMENTATION source for
what the retired engine did, for cell 12's class-C analysis — the cell
itself never reaches retired code, since that code no longer exists in
`src/`.)

## Unverified

- The exact single line responsible for the batch-arm `QueryError`
  vs. `NestedWriteError` divergence (class-C symptom 1, 5 cells) is not
  pinned to a specific statement. I traced the assertion-marker mechanism
  (`error-mapping.ts`), the statement-index resolver
  (`driver-diagnostics.ts:findUniqueExecutionContextIndex`), and the
  attribution/re-probe logic (`operation-context.ts:1243-1294`) and formed a
  hypothesis (nested-UPDATE-specific statement shape breaks attribution
  where nested create/delete do not), but could not execute a targeted,
  instrumented repro to confirm it: the `extended-local` project's `include`
  globs (via `scripts/credential-free-test-manifest.mjs`) are a fixed file
  list under `tests/`, and I could not add a scratch probe test without
  writing into the repository, which the brief forbids. Treat symptom-1's
  "suspected owner" as a well-supported but unconfirmed hypothesis, not a
  measured fact.
- Whether the *retired* write-engine actually executed the class-B shape
  (a relation-bearing `update` as a native batch member on the array route)
  atomically, or had the same structural "no RETURNING can carry a relation
  read" limitation raptor3's `rootUpdate` comment attributes to it. I could
  not run the retired engine (its source, `src/query-engine/write-engine/`,
  no longer exists in this tree) to check empirically. My classification
  (B-ruled) rests on the D-46 note's own "(pinned)" registration rather than
  on an independently observed retired-engine behavior.
- Class-C symptom 3 (cascade false-positive) and symptom 4
  (upsert/cascade ordering + unique collision): I have a concrete,
  falsifiable mechanism hypothesis for each (stale pre-cascade correlation
  value; upsert locate racing the parent's own cascade write) grounded in
  reading `commands/relation-body.ts` and `commands/execution.ts`'s ordering
  comments, but did not instrument or single-step the actual statement
  sequence a live/batch run produces, so the specific line that captures the
  stale correlation is not confirmed.
- I did not check whether any of these 8 class-C cells have live-PostgreSQL
  or live-MySQL siblings elsewhere in the estate that already pin the
  correct (or a different) behavior — only the PGlite-backed suites in this
  family were run, per the brief's scope.

## Blockers

- No file-write mechanism was available to build an isolated, instrumented
  repro for the batch-attribution hypotheses (class-C symptoms 1 and 4)
  without writing into the repository or the shared triage scratchpad,
  both of which the brief forbids. `vitest.config.ts`'s `server.fs.allow`
  does permit serving files from the OS tmpdir, but the `extended-local`
  project's `include` list (`scripts/credential-free-test-manifest.mjs`) is
  a fixed, repository-relative glob that a tmpdir-resident scratch test
  would not match, so this avenue was not usable read-only.
- No other blockers; all six files ran cleanly (one transient RSS-ceiling
  overrun on `batch-transaction.test.ts`'s first attempt, resolved on retry
  per the brief's method, receipt `batch-transaction.out` is the successful
  retry).

## Summary

- **Class A:** 0
- **Class B (all ruled):** 3 — all in `batch-transaction.test.ts`, all the
  same D-46-registered "relation-bearing update arm stays unbatchable on the
  array route (pinned)" decision.
- **Class C:** 8 — all in the `relation-key-update-legality-*` engine
  suites (7) plus `operations.test.ts`'s multi-row connect refusal (1); no
  registration or ruling covers any of them.
- **Class D:** 0

**Three most consequential findings:**
1. Every nested-`update` sub-verb combined with a same-record relation-key
   PK/referenced-column transition, executed via the forced-atomic-batch
   path, currently loses its intended typed error and surfaces either a raw
   `QueryError` or an unattributed `NestedWriteAssertionError` instead of
   the registered `NestedWriteError`/`UniqueConstraintError` — a 5+1-cell
   pattern (symptoms 1 and 4) pointing at the batch assertion-attribution
   machinery (`operation-context.ts:1243-1294`, `driver-diagnostics.ts:26-55`)
   as an unregistered, unpinned gap.
2. A parent PK-arithmetic transition paired with a child-held cascade
   `upsert` can make the live (non-batch) engine pick the wrong upsert arm
   (CREATE instead of UPDATE) and hit a genuine `UniqueConstraintError` on
   data that should update cleanly — the one cell in this family where the
   defect is a correctness bug with a real collision, not just an
   error-class mismatch.
3. The retired engine's documented refusal of a child-held `connect` across
   more than one matched `updateMany` root
   (`docs/architecture/retired/write-engine-ATOM.md:1053-1063`) has no
   surviving implementation anywhere in `src/` — `updateMany` now silently
   lets the last-processed row win a shared unique-owned child, which is
   exactly the data-loss shape the retired engine's own documentation says
   the refusal exists to prevent.

Note path: `/private/tmp/claude-501/-Users-arnaud-code-viborm/c2c775da-2927-4590-8677-3bb0f5d1aa98/scratchpad/triage/legality-and-client.md`
