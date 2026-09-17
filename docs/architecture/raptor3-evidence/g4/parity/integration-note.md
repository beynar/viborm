# Integration unit — the merged parity branch

Author: integration agent, 2026-09-17. Worktree `/private/tmp/viborm-parity-merge`
(branch `parity`, merge commit `395b9dd4` of `parity-q` 6827410d and `parity-x`
bf6cf224 onto `356254a2`), `TMPDIR=/private/tmp/viborm-parity-tmp-merge`.
Receipts: `docs/architecture/raptor3-evidence/g4/parity/receipts/integration/`.

Inputs read in full before the first edit: the parity plan
(`docs/architecture/raptor3-parity-plan.md`), `g4/briefs/common.md` (the twelve
rules), the merged `src/query-engine/raptor3/AGENTS.md`, both lane notes, both
lane reviews and both re-checks, and the ledger's D-17..D-27.

Merge state on arrival: clean (`git status` empty), `HEAD = 395b9dd4`, no
conflict marker, nothing staged. Nothing was resolved by this unit.

---

## Piece 1 — the cross-lane hand-overs

### 1a/1b decision-elimination gate (written before the first edit)

| | |
| --- | --- |
| **Required behaviour** | (1) The nested default-only `createMany { skipDuplicates }` refusal is asked ONCE, at admission, for every spelling of the verb (root, nested in a create, nested in an update, polymorphic collection group). (2) An empty `createMany` refuses on the batch-PREPARATION seam with the registered sentence `No data to insert for createMany.` while the direct call keeps Prisma's `{ count: 0 }`. |
| **Current owner** | (1) `shared/operation-context.ts:1548-1551` still raises `UnsupportedOperationError` for a default-only row under `skipDuplicates`; lane Q moved the same rule to `validation/model/args/mutation.ts` (`refuseDefaultOnlySkipDuplicates`, asked at every `createMany` admission site including the polymorphic group, lane-Q round 2 R7), so the physical copy is a second guard for one invariant. (2) `shared/operation-context.ts:1545` answers `emptyBulkResult` for BOTH ownerships, so the batch-prepared empty `createMany` publishes `{ count: 0 }` where the shipped engine refused (`assertBatchPreparable`, deleted with `cutover.patch:3652-3665`). |
| **Proposed change** | (1) Delete the physical copy; admission owns it. (2) One arm on the existing `rows.length === 0` branch: `batch-preparation` raises `QueryEngineError("No data to insert for createMany.")`, every other ownership keeps the no-op. No new gate, no new seam, no policy boolean. |
| **Invariant** | One guard per invariant: a payload shape is refused where the payload is admitted, and an execution-mode fact is stated by the owner that knows the mode. |
| **Falsifiers** | `tests/contracts/engine/query/bulk-insert-row-shapes.core.test.ts` (both cells), `tests/contracts/engine/query/parity-admission.core.test.ts` (root + nested + the new polymorphic arm), `tests/providers/local/sqlite3-nested-write.test.ts` (`rejects nested default-only duplicate skipping before the parent write`). |

### 1c — the cache-SWR hostile-JSON cell: measured, NOT actionable as handed over

The hand-over says the cell needs "the cache route's own materialization to read
a published hostile member once, before the driver's `parseResult` boundary".
Measured in this worktree, with a temporary probe in the cell (backed up first,
restored byte-for-byte afterwards, `md5 09d15962c8a0e204e063f7f2010f960f`):

- `hostileJsonGetterReads === 0` and `hostileJsonReadsAtCoreBoundary === 0` at
  the assertion — i.e. the hostile member is never read ANYWHERE in the
  operation, not once too few at one seam.
- the field's `StandardSchemaV1.validate` is invoked **zero** times in the whole
  file (probe on the schema itself): the hostile object the cell publishes is
  never constructed, because no read path consults a `json()` field's user
  schema.
- `DriverResultParser.parseResult` — the seam that assigns
  `hostileJsonReadsAtCoreBoundary` — has **no caller in `src/`** (`grep`), on any
  route: D-17 restored `parseField` only (`raptor3/shared/query.ts:596-609`).
  The shipped consumer was `result/ResultParser.ts:604-618`, deleted with the
  result engine.
- the cache route's materialization is a pure structural codec
  (`result/cache-json-codec.ts` `materializeJsonValue`) that rebuilds the value
  from the snapshot and never touches a user schema, so no change there can move
  either counter.

So the cell needs two facts this unit was not asked for and which are decisions,
not repairs: the other half of D-17 (a consumer for the driver/adapter
`parseResult` middleware, which every SQLite driver uses to normalise `count`
results and which would therefore change the read path for every provider), and
a read-path invocation of a `json()` field's user schema. Reported in
`stillRed`, not hidden, and no speculative edit was made.

### 1d — the two D-17 constructor lines survived the merge

`shared/operation-context.ts:320` (`new Queries(schema, this.driver.adapter, this.driver.result)`)
and `commands/index.ts:144-148` (`new Queries(schema, config.driver.adapter, config.driver.result)`).
Both verified in the merged tree; no edit needed.

---

## Piece 4 — the two re-checks' nits and minors

### Gate (written before the first edit)

| | |
| --- | --- |
| **Required behaviour** | (1) The guide states ONE recovery rule: the stale paragraph at `AGENTS.md:587-593` must not survive beside the lane-X section that supersedes it. (2) `CommandExecution.adoptSuppressed`'s kind filter carries no arm whose unique coverage cannot be named. (3) `commands/execution.ts`'s `TransportAttempt` type import sits with the other `../shared/*` imports. (4) The new polymorphic-group refusal of lane Q's round-2 R7 is pinned by a registered cell. (5) `scripts/query-engine-test-manifest.mjs` keeps its array's alphabetical order. |
| **Current owner** | (1) `raptor3/AGENTS.md:587-593` ("it answers `undefined` unless the ownership is standalone AND the route is the physical batch", "Its one caller, `CommandExecution.recover`") — both false since U6.4. (2) `commands/execution.ts:654-662`: the `membership` arm, whose sole construction site (`relation-body.ts:146-150`) places it `"before"`, which the first conjunct already excludes. (3) `commands/execution.ts:12`. (4) nothing pins it (lane-Q re-check §3.1). (5) `scripts/query-engine-test-manifest.mjs:30-34` (lane-Q re-check §3.4). |
| **Proposed change** | Strike the two stale sentences and state the rule the lane-X section states; drop the `membership` arm; move the import; add one arm to the existing `parity-admission` cell; move the five parity entries after `orderby-relation-depth.core.test.ts`. |
| **Invariant** | One owner per fact, in the guide as in the code; a guard whose unique coverage cannot be named is not a guard. |
| **Falsifiers** | `tests/raptor3/g4/parity/lane-x-set-mutations.test.ts` (the suppressed-member cell, both halves), `tests/contracts/engine/query/parity-admission.core.test.ts`, `npx biome check` on the touched files, and the manifest's own consumers (`layer-query-engine` still collects the five parity files). |

---

## Piece 3 — the polymorphic integrity probe (D-26)

### Gate (written before the first edit)

| | |
| --- | --- |
| **Required behaviour** | A membership row whose target row is gone fails the READ with the registered sentence `Polymorphic relation '<slot>' references a missing '<type>' record.`, and no allow-list can hide it: `include: { items: true }`, `include: { items: { only: ["article"] } }` and `include: { items: { only: [] } }` all refuse. |
| **Current owner** | `shared/query.ts` `prepareProjection`'s variants arm builds ONE arm per SELECTED member (`only` filters it), `lowerProjection` lowers each arm as a correlated row window, and the decoder's variants branch (`decodeValue`) refuses only what an ARM's own document can state (`orphanedArm`, Arnaud's D-19). With `only: []` there is no arm at all, so an orphan is unobservable from any arm; the shipped engine answered it with a sibling scalar subquery outside the arm (`builders/include-many-to-many.ts` `guardJunctionIntegrity`, read at `ff5e77ca`). |
| **Proposed change** | One correlated probe per CONFIGURED member of a junction-carried variant slot — `COUNT(*) FROM <member table> j WHERE <source correlation> AND NOT EXISTS (SELECT 1 FROM <target> t WHERE <target correlation>)` — emitted whatever `only` selects, carried in the slot's own document under the estate's already-declared `POLYMORPHIC_COLLECTION_ORPHANS_KEY`, and refused by the ONE decoder arm that already owns the sentence. The key takes this file's collision-proof spelling (`0viborm_orphans`): the deleted engine nested its arms under `arms` so a variant could not collide with a carrier key; this engine keeps arms at the document's top level, and a leading digit is the convention that makes a carrier name unreachable for a validated identifier. No private carrier COLUMN (D-19's rule is about the to-one claim, which is unchanged), no second walker, no new shape kind. |
| **Invariant** | A membership is a fact about the junction, so it is probed on the junction: the probe is a sibling of the arm's row window, outside its `WHERE` and its `LIMIT`, and it exists for every configured member because `only` selects what is READ, never what is TRUE. |
| **Falsifiers** | `tests/providers/local/sqlite3-polymorphic-batch.test.ts` › `an owner-scoped orphan fails the read, even hidden behind only` (three arms: full include, `only: ["article"]`, `only: []`), the same cell on `tests/providers/docker/mysql2.test.ts`, and the rest of both suites unchanged. |

---

## Piece 2 — U6.5 under D-25

### Gate (written before the first edit)

| | |
| --- | --- |
| **Required behaviour** | (1) On a batched selected series with a membership edge, one raceable `requireAbsent` over "connected ∧ filter ∧ key ∉ captured" rides the SAME batch, so a member committed after the plan-time read aborts the atomic unit instead of being silently missed. (2) The recovery gate is the shipped committed-progress rule. (3) A recovery re-plans from the ADMITTED values with a fresh occurrence tree — `Commands` re-expands from the admitted arguments, never the same occurrence twice, and no transform runs again. (4) One recovery per operation: a second consecutive race propagates. |
| **Current owner** | `commands/execution.ts` `captureSeries` emits no complement guard (the absence owner exists: `shared/operation-context.ts` `requireAbsent`, used raceably at `captureMembership`). `recoveryRejection` refused after `memberAdmissionStarted`, which `prepareMembers` sets before any guard could be queued, and both `submit` attribution sites required the same three facts. `run` re-enters only a REGION (`regionAttempt`), so the batch route had no recovery at all above the interpreter's in-place replay, and `commands/index.ts` built ONE plan for every attempt, so a replay of a captured series hit `Commands.expandSeries`'s "already expanded". |
| **Proposed change** | `captureSeries` queues the complement guard for a batched membership series (`requireNoAddedMember`, composed from the owners that exist: `Queries.andSelectors` + `prepareSelector` for "key ∉ captured", `Queries.select` with the membership correlation, `OperationContext.requireAbsent` for the raceable premise). The progress rule is stated ONCE as `OperationContext.committedProgress` and read by `recoveryRejection` and both attribution sites. `run` gains `batchAttempt`, the batch route's twin of `regionAttempt`: on an ATTRIBUTED assertion rejection it spends the one allowance and re-enters the body, and `commands/index.ts`'s body builds a FRESH plan for any attempt after the first. The allowance itself moves to the context (`spendRecovery`), because a re-plan builds a new interpreter. |
| **Invariant** | A captured member set rides its batch with the complement it asserts; the recovery allowance is a progress fact spent once per OPERATION; a recovery that RE-PLANS re-derives its tree from the admitted arguments, and a recovery that REPLAYS may not exist where a member was dynamically admitted. |
| **Falsifier** | `tests/raptor3/g4/parity/integration-staleness.test.ts` (new, `extended-local`, 3 cells on a real SQLite database with a batch-only, provably-atomic transport): the guard rides the batch naming its captured key; a member added after the plan-time read aborts once and the operation converges, with the SECOND capture's complement excluding BOTH keys (the fresh tree over the larger set); a race on every attempt propagates, emits exactly two captures and writes nothing. Plus `tests/providers/docker/pg-nested-write-races.test.ts` and the live pg race harness. |

### What shipped, and the one place the rule had to be split

`memberAdmissionStarted` did NOT disappear. Removing it from both arms reddened a
registered raptor3 pin —
`tests/raptor3/transitions/recovery-boundaries-live-commands.test.ts`
› `g2-recovery-dynamic-member-admission`, "Dynamic admission excludes root
recovery" — and not by asserting the old rule for its own sake: the operation
then failed with a raw `Error` instead of its `UniqueConstraintError`, because
the INSERT recovery REPLAYS the tree that ran and that tree's series occurrence
cannot be expanded twice. So the gate is split by what the recovery DOES, with
each conjunct's unique coverage nameable:

- an atomic ASSERTION is answered by a fresh PLAN, so member admission does not
  bound it — the new tree admits its own members from the state it re-reads;
- a rejected INSERT is answered by a REPLAY, and a dynamically admitted member's
  defaults and transforms already ran once (rule 10), so `memberAdmissionStarted`
  still bounds that arm and the registered pin is green, unchanged.

D-25's sentence is satisfied for the case it was taken for (U6.5's raceable
assertion) and the estate keeps the contract it already had for the other.

### The pg staleness cell stays red, and why — measured, not assumed

`pg filtered m2m deleteMany staleness › a member added after the plan-time read
aborts the guard, then the retry converges` fails on its FIRST assertion,
`batchErrors.length >= 1`. The guard is emitted and correct — captured live from
the run:

```sql
SELECT "q0"."id", "q0"."name", "q0"."featuredPostId" FROM "public"."m2m_tags" AS "q0"
 WHERE (EXISTS (SELECT 1 FROM "public"."m2m_post_tags" AS "q1"
                 WHERE ("q1"."post_ref" = ? AND "q1"."tag_ref" = "q0"."id"))
        AND ("q0"."name" LIKE ? ESCAPE '\' AND NOT (("q0"."id" = ? OR "q0"."id" = ?))))
```

— note the TWO excluded keys: by the time the plan-time read ran, the concurrent
member was already committed, so the set was never stale and the guard correctly
passed. The harness's `PgBeforeFirstBatchDriver` fires `beforeFirstBatch` on the
operation's first `_executeBatch`, and for this shape that batch is the PLANNING
one — the located-row premise `runSelection` queues plus the membership series'
parent-existence read — dispatched before the member capture. The fixture
documents this hazard about itself
(`tests/fixtures/drivers/batch-forced-pg.ts`: "a planning level holding more than
one INDEPENDENT read is itself dispatched through `_executeBatch`, so its hook
fires before the plan has read anything — harmless for a plan whose planning
reads are all single-step levels, and silently wrong for one whose reads are
not").

Closing it needs the operation to issue no multi-statement planning batch before
its atomic unit — i.e. a queued PREMISE must not be settled by a planning read,
or a lone planning read must not be dispatched as a batch. I implemented the
second half (a lone `flush` dispatching one read as one statement) and REVERTED
it: it does not close the window on its own (the premise is still queued ahead),
and an unpinned change to when statements become batches is a decision about the
batch composition, not a repair. Reported for Arnaud; the facts the cell exists
for are pinned deterministically by `integration-staleness.test.ts`, whose three
cells all redden when the guard is disabled (falsified: 3/3 red with
`requireNoAddedMember` short-circuited, restored by scratchpad copy,
md5 `b5a876ce2c39813b20a54cd7d713a5ff`).

---

## Verification

One file or one project per call, bounded runner, `TMPDIR=/private/tmp/viborm-parity-tmp-merge`,
never two at once. Receipts under `receipts/integration/`.

| target | result | receipt |
| --- | --- | --- |
| `provider-sqlite3` + `provider-libsql` (whole lanes) | **764 passed / 0 failed** (664 env-skipped libsql) | `final-local-providers.txt` |
| `tests/providers/local/sqlite3-nested-write.test.ts` | **85/85** (was 4 red in lane Q, 8 in lane X) | `p1-sqlite3-nested-write.txt` |
| `tests/providers/local/sqlite3-polymorphic-batch.test.ts` | **149 passed / 1 skipped, 0 failed** (the collection orphan is green) | `final-local-providers.txt` |
| `layer-client` + `layer-query-engine` + `layer-drivers` + `layer-write-engine` + `layer-validation` + `layer-operation-schemas` + `layer-relations` | 2 failed / 4397 passed | `final-core-layers.txt` |
| the five lane-Q parity falsifiers + `bulk-insert-row-shapes` | **148/148** | `final-core-falsifiers.txt` |
| `lane-x-set-mutations` + `lane-x-route-seam` + `integration-staleness` | **15/15** | `final-parity-falsifiers.txt` |
| `suppression-replay` + `suppression-retry-contract` + `bulk-series-contract` + `g29-dependency-boundaries` (`raptor3`) | **12/12** | `final-raptor3-probe.txt` |
| `unique-races` + `junction-races` + `recovery-boundaries` (live pg 55729, `VIBORM_RAPTOR3_PROVIDER=pg`) | **8/8** | `final-live-races.txt` |
| `tests/providers/docker/pg-nested-write-races.test.ts` (pg 55729) | 6 failed / 89 passed (was 7 at the merge) | `final-pg-nested-write-races.txt` |
| `tests/providers/docker/mysql2.test.ts` (mysql 55730) | 4 failed / 80 passed / 1 skipped (was 11 in lane X, 8 in lane Q) | `final-mysql2.txt` |
| `tests/contracts/public-client/official-cache-swr.core.test.ts` | 1 failed / 6 passed | `final-official-cache-swr.txt` |
| `node scripts/run-typecheck.mjs` | **0 diagnostics, exit 0** | `final-typecheck.txt` |

`npx biome check` on every touched file: `shared/query.ts` and
`commands/execution.ts` keep exactly the diagnostics the merge base reports
(`execution.ts`: `organizeImports`, `noParameterProperties`,
`useDefaultSwitchClause`, `noCommaOperator` — the four lane X's round 2 left);
`commands/index.ts` keeps its two base format hunks and none of this unit's lines
is in one; `result-aliases.ts`, `parity-admission.core.test.ts`,
`query-engine-test-manifest.mjs` and the new
`integration-staleness.test.ts` report nothing at all.

No `.skip`, no `.only`, no `todo(`, no deleted cell. One witness re-pinned, not
weakened: `parity-admission.core.test.ts`'s "a default-only row cannot be
skipped, at the root or nested" ended its cell by asserting that
`counter.createMany({ data: [{}] })` RESOLVES on the planning fixture driver —
which lane X's U5.5 shortfall refusal (merged from the other lane) now refuses,
because that driver acknowledges no rows. The arm now pins that the refusal
raised is the DRIVER's shortfall and not the admission sentence, which is what
the cell was there to prove. It was red on the merge before this unit touched it.

### Still red, each with its reason

1. `tests/contracts/public-client/official-cache-swr.core.test.ts` › `contains
   provider, snapshot, set, and cleanup failures` — §1c above. Needs D-17's other
   half (a consumer for `DriverResultParser.parseResult`, which has none in
   `src/`) and a read-path invocation of a `json()` field's user schema; both are
   decisions, both measured here, neither attempted.
2. `tests/providers/docker/pg-nested-write-races.test.ts` › `pg filtered m2m
   deleteMany staleness › a member added after the plan-time read aborts the
   guard, then the retry converges` — Piece 2 above: the harness plants its
   concurrent member before the plan-time read on this engine's statement shape.
   The guard and the recovery are shipped and pinned by
   `integration-staleness.test.ts`.
3. `tests/providers/docker/pg-nested-write-races.test.ts` › the five `pg
   batch-only batch primary-key dataflow` cells (`Raptor 3 G1 atomic output
   requires exact identity scratch or segmented RETURNING`) — red at the
   pre-parity base, named by no unit of the plan.
4. `tests/providers/docker/mysql2.test.ts` › the four `MySQL namespace
   containment` cells — red at the base, environmental (both lanes drop and
   recreate tables in the shared container).
5. `tests/contracts/architecture/contract-matrix.core.test.ts` › `inventories
   every executable test by owner and boundary` — pre-existing: `tests/inventory.ts`
   classifies no file under `tests/raptor3/`, and it fails on the same first file
   (`tests/raptor3/candidate-handoff.test.ts`) it failed on before the parity
   program. This unit's new file joins ~100 others in that set.

Not run, and stated as a scope choice rather than a result: the whole
`provider-pg` and `provider-mysql2` projects beyond the two files named above,
`tests/providers/docker/mysql2-relations-ddl.test.ts` (30 concurrent-DDL reds at
the merge, lane Q's receipt), the `raptor3` project's other ~100 files, the
campaigns and replays (Arnaud: campaign re-qualification is not run).

---

## Files changed by this unit

| file | piece |
| --- | --- |
| `src/query-engine/raptor3/shared/operation-context.ts` | 1a, 1b, 2 |
| `src/query-engine/raptor3/shared/query.ts` | 3 |
| `src/query-engine/raptor3/commands/execution.ts` | 2, 4 |
| `src/query-engine/raptor3/commands/index.ts` | 2 |
| `src/query-engine/result-aliases.ts` | 3 |
| `src/query-engine/raptor3/AGENTS.md` | 2, 3, 4 |
| `scripts/query-engine-test-manifest.mjs` | 4 |
| `tests/contracts/engine/query/parity-admission.core.test.ts` | 1a, 4 (+ the merge-interaction re-pin) |
| `tests/raptor3/g4/parity/integration-staleness.test.ts` (new) | 2 |

Nothing was committed, staged, stashed or reset; the lane worktrees and the main
tree's source were not written to (this note and its receipts are the only files
this unit wrote outside `/private/tmp/viborm-parity-merge`).

## Unverified by this unit

- The whole `provider-pg` and `provider-mysql2` projects, `mysql2-relations-ddl`
  (30 concurrent-DDL reds at the merge), the `raptor3` project beyond the seven
  files named above, and every campaign/replay — not run, by the "minimum tests"
  instruction.
- The D-26 probe's COST is not measured against the D-9 budget: a polymorphic
  collection read now carries one correlated `COUNT(*)` per configured member,
  and a singular polymorphic inverse one more. Both are scalar subqueries with no
  window; no A/B was taken.
- The batch re-plan (D-25) is exercised on a real SQLite database with a
  batch-only, provably-atomic transport, and on live PostgreSQL only through the
  race harness's existing cells. No live provider drives the re-plan itself.
- Hosted drivers (`planetscale`, `neon-http`) are untouched and untested here,
  unchanged from lane Q's note.

---

# Round 2 — the independent review's three resolutions

Review: `docs/architecture/raptor3-evidence/g4/parity/integration-review.md`
(verdict REVISE, 2026-09-17). Same worktree `/private/tmp/viborm-parity-merge`
(branch `parity`, `HEAD = 395b9dd4`, nothing committed), same
`TMPDIR=/private/tmp/viborm-parity-tmp-merge`. Arrival state matches the
review's exit state byte for byte: `query.ts` `1250f8e9…`, `execution.ts`
`b5a876ce…`, `operation-context.ts` `feecdc4b…`, the same nine `git status`
entries.

The review's §A carries three resolutions. They are applied exactly and nothing
else is. §B.1 and §B.2 are the review's own "take or leave" nits and are NOT
applied — B.1 would retype `PreparedProjectionField.memberships[].edge`, B.2
would add a representation rule to the D-26 carrier decode; both are changes
the review did not require and the second is a behaviour question on a
representation no live provider produces. They are carried forward for Arnaud
in "Still open" below.

The three gates are written here BEFORE this round's first edit.

## Gate A.1 — the recovery bound has one owner, and it is `submit`

| | |
| --- | --- |
| **Required behaviour** | A rejected INSERT is attributed to its producer only while no dynamic member has been admitted — its defaults and transforms already ran once against a row that attempt read, and admitted values are never produced twice (rule 10). `recoveryRejection` asks about ATTRIBUTION and PROGRESS only. The registered pin `tests/raptor3/transitions/recovery-boundaries-live-commands.test.ts` › `g2-recovery-dynamic-member-admission` keeps its `UniqueConstraintError`. |
| **Current owner** | TWO readers of one fact. `shared/operation-context.ts:1072-1081` (`submit`'s attribution site) already requires `!this.memberAdmissionStarted` before it records `attempt.rejectedInsert` at `:1085`, and `rejectedProducer` (`:1179-1182`) is that field's only reader — so `recoveryRejection`'s insert arm is unreachable with `memberAdmissionStarted === true`. `shared/operation-context.ts:1200-1204` states the same bound a second time at the decision point, where it can never change an answer. The review measured it: removing ONLY those five lines leaves `recovery-boundaries-live-commands` 2/2, `unique-races-live-commands` 3/3, `junction-races-live-commands` 3/3, `suppression-replay` 5/5, `suppression-retry-contract` 2/2, `bulk-series-contract` 6/6, `g29-dependency-boundaries` 4/4, `integration-staleness` 3/3, `sqlite3-nested-write` 85/85 green. |
| **Proposed change** | Delete `:1200-1204` (the four comment lines and `if (this.memberAdmissionStarted) return undefined;`) and move that paragraph onto the `!this.memberAdmissionStarted` conjunct at `:1075`, beside the existing "Atomic rejection is retryable only with exact effect attribution" comment — the owner that actually refuses to record the producer. The classifier's own opening paragraph, whose last sentence asserts the split this deletes ("The two kinds differ in one conjunct…"), states instead what the classifier now does; a comment is a claim, and leaving a false one is the same defect this resolution removes. No behaviour moves: the deleted line is unreachable in the state it tests. |
| **Invariant** | One guard per invariant. A guard whose unique coverage cannot be named is not a guard — the rule this unit itself applied in Piece 4 to `adoptSuppressed`'s `membership` arm. The bound belongs to the site that produces the evidence, not to the site that classifies it. |
| **Falsifiers** | `tests/raptor3/transitions/recovery-boundaries-live-commands.test.ts` (`raptor3-live-provider`, pg 55729) stays 2/2 — the pin that reddens when the bound is removed from `submit` too; `tests/raptor3/g4/parity/integration-staleness.test.ts` (`extended-local`) stays 3/3 — the re-planning arm, which must not gain the bound; `tests/raptor3/g4/parity/lane-x-set-mutations.test.ts` (`extended-local`) stays 9/9 — the two deterministic recovery cells. |

## Gate A.2 — the guide says which recovery replays and which re-plans

| | |
| --- | --- |
| **Required behaviour** | The guide states the ACTUAL route of each recovery. Three of the four re-enter the body and therefore build a fresh plan: the region re-entry (`operation-context.ts:827-842` `regionAttempt` → `withinRegion(region, body)`), the batch re-entry (`:859-869` `batchAttempt` → `body()`) and the envelope restart (`run`'s deferred arm, `:695-702`, which calls `body()` and then `regionAttempt(region, body)`). Exactly one REPLAYS: `CommandExecution.recover` (`commands/execution.ts:181-211`), available only where this operation opened no region (`replaysInPlace`), whose `complete` loop re-runs the SAME occurrence tree. |
| **Current owner** | `src/query-engine/raptor3/AGENTS.md:932-951`. Its second bullet says "a rejected INSERT is answered by a REPLAY of the tree that ran", which is false for the route that HAS a region — the one `pg-nested-write-races`' family-13 cells take — and its lead-in claims a split at `recoveryRejection` that A.1 removes. The envelope restart's re-plan (`commands/index.ts:189-203`, `planned` consumed once) is stated in the code and in `physical-envelope.test.ts` (10/10, `restarts === 1`) but nowhere in the guide. |
| **Proposed change** | Rewrite that paragraph and its two bullets, in the same edit as A.1: the bound stated at `submit`; which recovery replays and which re-plan; and one sentence that a re-plan is safe because `EngineSchema.admit` is memoised in `commands/index.ts` (`admitted ??=`, `:167-168`), so no default and no transform runs twice. Guide text only — no production line moves with it. |
| **Invariant** | The guide is normative for this engine; a sentence that describes a route the code does not take is a defect of the same kind as a second owner. |
| **Falsifiers** | None is a test — this is documentation. It is checked against the code it describes: `regionAttempt`/`batchAttempt`/`run`'s deferred arm all re-enter `body`, `commands/index.ts:197-203` builds a fresh plan for every attempt after the first, `recover` is the only in-place path, and `admitted ??=` is the one admission. The suites that would redden if the described behaviour were changed rather than described are re-run under A.1. |

## Gate A.3 — no debug scaffolding in a shipped test

| | |
| --- | --- |
| **Required behaviour** | `tests/raptor3/g4/parity/integration-staleness.test.ts` contains no `console.*` and no catch that only logs and rethrows — both named by the repo's `CLAUDE.md` ("Remove `console.log` … from production code", "don't catch errors just to rethrow them"). |
| **Current owner** | `tests/raptor3/g4/parity/integration-staleness.test.ts:176-187`: `createWorld`'s seeding `board.update` is wrapped in `try { … } catch { console.error("PROBE-setup", …); throw error; }` — scaffolding from this unit's own U6.5 investigation that shipped by accident. |
| **Proposed change** | Delete the try/catch, keep the bare `await client.board.update({ … })`. No assertion, no cell and no world state changes: the catch rethrows unconditionally. |
| **Invariant** | A shipped test states its facts; a probe that survived the investigation it belonged to is not one of them. |
| **Falsifier** | The file itself: 3/3 in `extended-local`, the same three cells, unchanged. |

## Round 2 — what changed

Three files, no new file, no cell added or removed, no production behaviour
reached by any registered test.

1. `src/query-engine/raptor3/shared/operation-context.ts` — the
   `memberAdmissionStarted` conjunct is deleted from `recoveryRejection`
   (`:1200-1204` at arrival) and its paragraph now sits at the site that records
   the producer, beside the existing "Atomic rejection is retryable only with
   exact effect attribution" comment. The classifier's own opening paragraph
   states what the classifier now does instead of the split it no longer makes.
   Two comment blocks; one deleted `if`.
2. `src/query-engine/raptor3/AGENTS.md` — the recovery paragraph and its two
   bullets are rewritten as A.1(3) and A.2 ask: the bound stated at its owner,
   which recovery REPLAYS and which three RE-PLAN, and the one sentence that a
   re-plan is safe because admission is memoised (`admitted ??=`). The paragraph
   that follows lost the two sentences the new one now owns — stating the routes
   twice would be the same defect this resolution removes.
3. `tests/raptor3/g4/parity/integration-staleness.test.ts` — the `PROBE-setup`
   try/catch is gone; the seeding `board.update` is bare. Eight lines.

Untouched, and verified byte-identical to the state the review left:
`shared/query.ts` (`1250f8e9…`), `commands/execution.ts` (`b5a876ce…`),
`commands/index.ts`, `result-aliases.ts`, `scripts/query-engine-test-manifest.mjs`,
`parity-admission.core.test.ts`. `git status` is the same nine entries,
`HEAD = 395b9dd4`, nothing committed, staged, stashed or reset. `git diff
--numstat` moved only on the two files above (`operation-context.ts` 103/22 →
106/22, `AGENTS.md` 92/21 → 94/22), which accounts for every hunk: +8 comment
lines at the attribution site, −5 at the classifier, and the guide rewrite.

### One correction to the review's premise — recorded, because it changes the argument

The review's §A.1 argues the deletion is behaviour-free because `submit`'s
attribution arm "is the only place `attempt.rejectedInsert` is ever assigned".
It is not. There are **two** assignment sites, and only the first carries the
bound:

| site | route | bound by `memberAdmissionStarted`? | the recovery it feeds |
| --- | --- | --- | --- |
| `submit`, `:1093` | batch (`usesBatch`) | **yes** | `CommandExecution.recover` — an in-place REPLAY, reachable only where no region is open (`replaysInPlace`) |
| `insert`, `:2072` | non-batch (`!usesBatch`) | **no** | `regionAttempt` — a FRESH region running a FRESH plan |

So the conjunct was not dead everywhere. It was dead on the batch route (the
producer is never recorded there after admission, which is why the registered
pin — an `atomic-batch` world, `recovery-boundaries-live.ts:259` — never saw it),
and on the region route it was **refusing a recovery D-25 permits**: that route
re-plans, and D-25 bounds only the recovery that replays. Deleting it therefore
does two things, and both are what the resolution intends: it removes a second
reader of one fact, and it stops the classifier from imposing the replay's bound
on the re-plan. Every registered cell that could observe either is green, below.

The comments this round writes say that, rather than the review's sentence: the
bound belongs to the attribution site of the route whose recovery replays, and
`insert`'s non-batch attribution carries none because the recovery it feeds
re-plans. Recorded here so Arnaud reads the argument that is actually true.

### Falsification — the bound now has exactly one owner, and that owner is load-bearing

`operation-context.ts` was copied to the scratchpad, mutated, run, and restored;
md5 `19356c9f84ff2635decb938d531a3694` before and after, verified.

| mutation | result |
| --- | --- |
| `!this.memberAdmissionStarted` removed from `submit`'s attribution arm (`:1083`) — i.e. from its ONE remaining owner | `recovery-boundaries-live-commands` **1 failed / 1 passed**: `g2-recovery-dynamic-member-admission` fails on `outcome.failure.name`, the author's exact observable (`'UniqueConstraintError'` owed). Receipt `round2-falsification-a1.txt` |
| restored | 2/2 green again (`round2-recovery-boundaries-live.txt`) |

This is the pin the round-1 note said reddens when the rule is removed from both
arms. It now reddens when it is removed from ONE — which is the whole claim of
A.1: the fact is real, load-bearing, and has a single owner.

### Verification

One file per call, bounded runner, `TMPDIR=/private/tmp/viborm-parity-tmp-merge`,
never two at once. Receipts under `receipts/integration/round2-*.txt`.

| target | project | result |
| --- | --- | --- |
| `tests/raptor3/g4/parity/integration-staleness.test.ts` | `extended-local` | **3/3** (A.3's falsifier and A.1's re-planning arm) |
| `tests/raptor3/g4/parity/lane-x-set-mutations.test.ts` | `extended-local` | **9/9** (the two deterministic region-route recovery cells) |
| `tests/raptor3/transitions/recovery-boundaries-live-commands.test.ts` | `raptor3-live-provider` (pg 55729) | **2/2** |
| `tests/raptor3/transitions/unique-races-live-commands.test.ts` | `raptor3-live-provider` (pg) | **3/3** |
| `tests/raptor3/transitions/junction-races-live-commands.test.ts` | `raptor3-live-provider` (pg) | **3/3** |
| `tests/providers/local/sqlite3-nested-write.test.ts` | `provider-sqlite3` | **85/85** |
| `tests/providers/docker/pg-nested-write-races.test.ts` | `provider-pg` (pg 55729) | 6 failed / 89 passed — the SAME six as round 1 (the D-29 staleness cell and the five base `batch-only batch primary-key dataflow` cells); every family-13 race cell green |
| `node scripts/run-typecheck.mjs` | — | **0 diagnostics, exit 0** |
| `npx biome check` on the two checkable touched files | — | `operation-context.ts` reports the SAME four rules plus `format` as `git show 356254a2:` does (`organizeImports`, `noParameterProperties` ×4, `format`), and no format hunk falls between lines 1060 and 1230, where every line this round wrote is; `integration-staleness.test.ts` reports nothing |

`pg-nested-write-races` and `sqlite3-nested-write` were added to the review's
named set on purpose: they are the two files that combine a dynamic member
series with a transaction-capable provider, which is exactly the intersection
the correction above identifies, and neither moved a cell.

No `.skip`, no `.only`, no `todo(`, no deleted or weakened cell; the only test
edit this round REMOVES debug scaffolding and changes no assertion.

### Not applied, and why

- **§B.1** (type `PreparedProjectionField.memberships[].edge` as
  `Extract<Membership, { kind: "junction" }>` and drop the narrowing throw at
  `query.ts:3866-3867`) — the review's own "take or leave". It edits a file this
  round otherwise does not touch and trades a runtime narrowing for a type-level
  one; not required by the verdict.
- **§B.2** (decode the D-26 integrity carrier with the same string rule the arms
  use, or refuse a carrier that is neither absent nor an object) — also "take or
  leave", and it is a behaviour question about a representation no live provider
  in this estate produces (SQLite, PostgreSQL and MySQL all hand the nested
  document back as an object; the review measured pg itself at 60/60). Choosing
  between "decode it" and "refuse it" is a decision about the carrier's
  representation contract, so it goes to Arnaud rather than into a repair round.

### Still open after this round

Unchanged from round 1, none of it touched here: **D-28** (the cache-SWR
hostile-JSON cell — needs D-17's other half), **D-29** (the pg staleness cell —
needs a rule about when a planning read becomes a batch), the five pre-existing
pg `batchPrimaryKeyDataflow` cells, the four MySQL namespace-containment cells,
and the `contract-matrix` inventory cell. New from this round: **§B.1 and §B.2
above**, and the review's §D items (PGlite unverified for D-26 under the runner's
1536 MiB ceiling; the D-26 probe's cost against the D-9 budget, still unmeasured).
