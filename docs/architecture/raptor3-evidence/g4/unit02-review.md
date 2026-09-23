# G4-02 independent review — physical/provider envelope (phase 1)

Reviewer: independent (did not author the unit).
Unit: `G4-02 physical/provider envelope (phase 1)`.
Brief: [`briefs/unit02-physical-provider.md`](briefs/unit02-physical-provider.md) r3.
Note: [`unit02/note.md`](unit02/note.md). Patch: [`unit02/production.patch`](unit02/production.patch).

Source identity: the main tree reverse-applies `production.patch` cleanly
(`git apply -R --check` → OK), verified before and after every probe, and again
after the one falsification swap in §F2. `src/query-engine/raptor3/shared/query.ts`
is unedited at the SHA the note records
(`1cd9bcd217bbb1de955cec389b0818c1af29788bc77172524a841f76c093910b`).
Patch SHA-256 `3ce0d4565a21493ea119786a2fbe4526efac136964bbebadb5aeb946e5e9d9bc` matches.

Review probes: `tests/raptor3/g4/review/unit02/` (7 files, 19 cells, kept), run with

```
node scripts/run-vitest-safe.mjs run \
  --workspace=tests/raptor3/g4/review/unit02/review.workspace.ts \
  tests/raptor3/g4/review/unit02/
```

Review receipts: `docs/architecture/raptor3-evidence/g4/unit02-review-receipts/`.

---

## Outcome

**REVISE.**

The unit's core deliverables are real and, where I could measure them, correct:
root `delete` is byte-identical to the shipped engine in value, not-found
identity (class, `V6001`, message and meta) and read-before-removal ordering;
`flat-scalar-update` really is one statement with no envelope; D-2 really is
resolved; the `Object.hasOwn` repair, the named variant-carrier refusal and the
specimen's single read entry all land; cost figures reproduce to the byte; the
native container identity and ports are honest and the PostgreSQL DATE failure
really is a fixture defect.

It does not ship as it stands because one qualified guarantee is broken — an
atomic `$transaction([...])` on a batch-only driver is no longer all-or-nothing
when a folded root `delete`/`update` finds no row (finding 1) — and because
three of the unit's own stated invariants are not what the code does: the
"one envelope rule" is never the operative decision and two shapes violate it
(finding 3), the caller-context threading loses the nested model that the
shipped engine keeps (finding 2), and the withdrawn-work failures §8.4 claims
have no receipts (finding 4).

---

## What I reproduced

| Suite / mode | Author | This review | Receipt |
| --- | --- | --- | --- |
| G4-02 author checks (4 files) | 24 passed, 1 skipped | **24 passed** (native file not run) | — |
| `g4-read-contracts` | 58 / 4 failed | **58 passed / 4 failed**, same four cells | [`g4-read-contracts.log`](unit02-review-receipts/g4-read-contracts.log) |
| `g4-route-transactions` | 10 / 1 failed | **10 / 1 failed**, same cell | [`g4-route-transactions.log`](unit02-review-receipts/g4-route-transactions.log) |
| `g4-route-admission` | 4 / 1 failed | **4 / 1 failed** | [`g4-route-admission.log`](unit02-review-receipts/g4-route-admission.log) |
| `g4-route-cache` / `g4-route-lifecycle` | 6 / 7 passed | **6 / 7 passed** | [receipts](unit02-review-receipts/) |
| `g4-lifecycle-events` | 1 / 2 failed | **1 / 2 failed** | [`g4-lifecycle-events.log`](unit02-review-receipts/g4-lifecycle-events.log) |
| `g4-lifecycle-admission` | 3 / 1 failed | **3 / 1 failed** | [`g4-lifecycle-admission.log`](unit02-review-receipts/g4-lifecycle-admission.log) |
| `g4-generation-selftests` | 6 passed | **6 passed** | [receipt](unit02-review-receipts/g4-generation-selftests.log) |
| `g1-contracts` | 143 passed | **143 passed** | [receipt](unit02-review-receipts/g1-contracts.log) |
| `g3-transaction-array` / `g3-suppression-retry` / `g3-bulk-series` | 4 / 2 / 6 | **4 / 2 / 6 passed** | [receipts](unit02-review-receipts/) |
| `g3p05-contracts` | 21 passed | **21 passed** | [receipt](unit02-review-receipts/g3p05-contracts.log) |
| `g29-result-progress` | 2 passed | **2 passed** | [receipt](unit02-review-receipts/g29-result-progress.log) |
| `prep` (10 files) | 37 passed | **37 passed** (4 native files skip: no provider env) | [`prep.log`](unit02-review-receipts/prep.log) |
| `g4-read-envelope-pg-contracts` (native, port 65504) | 2 passed / 2 failed | **2 passed / 2 failed**, same two | [receipt](unit02-review-receipts/g4-read-envelope-pg-contracts.log) |
| `cs03` extension-campaign selftest | 10 failed / 32 passed, claimed pre-existing | **10 / 32 on the current tree and 10 / 32 on the pre-edit tree** (independent swap, §F2) | [current](unit02-review-receipts/cs03-selftest.log), [pre-edit](unit02-review-receipts/cs03-selftest-pre-edit.log) |
| `node scripts/run-typecheck.mjs` | 2 permitted diagnostics | **2 permitted diagnostics only** (6.75 s, 6,119 MiB) | — |
| `node scripts/credential-free-test-manifest.mjs` | exit 0 | **exit 0** | [receipt](unit02-review-receipts/credential-free-manifest.log) |

PGlite lanes and the MySQL native suite were not re-run; they are author-reported.

### Cost

Recomputed with the census function of `scripts/query-engine-structure.mjs`
(`countTokenLines`, JSDoc and EOF excluded) over the unit's seven files, against
the pre-edit content reconstructed by reverse-applying `production.patch`:

| | files | bytes | physical | token-lines |
| --- | --- | --- | --- | --- |
| before | 7 | 116,906 | 3,594 | 3,543 |
| after | 7 | 135,813 | 4,055 | 3,834 |
| increment | 0 | **+18,907** | **+461** | **+291** |

**Exactly the note's §9 table.** The cumulative figures (core 8,928 / complete
13,850 token-lines / 30 files) are not reproducible from the evidence in this
directory — no candidate charged-file manifest is saved beside them — so they
are recorded as unverified, not as wrong.

---

## Findings

### 1. BLOCKING — a packaged root `delete`/`update` that finds no row lets its array siblings commit

**Where.** `src/query-engine/raptor3/shared/operation-context.ts:693-698`
(`published`, the new one-row cardinality owner) reached from the
`batch-preparation` branch of `setMutations`
(`operation-context.ts:835-851`), with the plan gates that fold these two verbs
onto the set-oriented owner at
`src/query-engine/raptor3/commands/commands.ts:1106-1115` (root `delete`) and
`commands.ts:1023-1041` + `:1179` (the root `update` fold).

**What breaks.** When a root single-row write is packaged for
`$transaction([...])`, `published` raises `NotFoundError` from inside
`preparedParser`, i.e. **after** the array's single batch has been submitted and
committed. The shipped engine never does this: because "batch mode has no JS
postcondition available", `DeleteOperation` (`DeleteOperation.ts:207-245`,
`:255-262`) replaces the fold's `expects` postcondition with a **presence guard
statement inside the same batch**, so a missing row aborts the whole atomic
unit. The candidate has no such guard, so every other member of the array
commits.

**Probe.** `tests/raptor3/g4/review/unit02/packaged-cardinality.review.test.ts`
(2 of its 3 cells fail), on the same `BatchOnlyDriver` shape
`tests/raptor3/g4/route-transactions.test.ts:66-78` uses:

```
node scripts/run-vitest-safe.mjs run \
  --workspace=tests/raptor3/g4/review/unit02/review.workspace.ts \
  tests/raptor3/g4/review/unit02/packaged-cardinality.review.test.ts
```

```
DELETE shipped   {"rejected":"NotFoundError","stored":[{"email":"present@example.test"}]}
DELETE candidate {"rejected":"NotFoundError","stored":[{"email":"present@example.test"},
                                                      {"email":"sibling@example.test"}]}
UPDATE shipped   {"rejected":"NotFoundError","stored":[{"email":"present@example.test"}]}
UPDATE candidate {"rejected":"NotFoundError","stored":[{"email":"present@example.test"},
                                                      {"email":"sibling@example.test"}]}
```

Both engines raise the same error; only the candidate leaves the sibling
`create` committed. The third cell (`findUniqueOrThrow`) agrees on both routes,
so the defect is specific to the two write verbs this unit folded.

This is a G3 contract the plan freezes ("transaction outcomes are execution
semantics, keep them") and a regression the unit introduced: before this patch
neither verb could be packaged at all (root `delete` did not exist; root
`update` went through `Commands.execute`'s record command, which raises
`incompletePreparation` at `captureMutationIdentities`, so `prepareBatch`
returned `undefined` and the array owner refused).

**Resolution.** Either put the premise inside the unit the way the shipped
engine does — queue the same presence guard ahead of the folded mutation when
`ownership === "batch-preparation"` and a `single` failure is supplied — or make
`published` refuse packaging (`throw this.incompletePreparation`) whenever a
`single` failure exists and the ownership is `batch-preparation`, so the array
owner falls back exactly as it did before. The first preserves D-2's win for
these verbs; the second is one line and restores the qualified outcome. Pin it
with the probe above.

---

### 2. MUST-FIX — B-4 threading drops the nested model the shipped engine keeps, and the note's justification for that is factually wrong

**Where.** `src/query-engine/raptor3/shared/operation-context.ts:176-184`
(`statementContext`), which now returns `this.callerAttribution` verbatim for
**every** statement, whatever model the statement targets.

**What breaks.** The shipped executor does not pass one context to every
statement. `OperationExecutor.executeStatement`
(`src/query-engine/write-engine/OperationExecutor.ts:1969-1980`) calls
`statementExecutionContext` (`src/query-engine/pattern/execute/values.ts:280-287`),
which returns the operation's context only while `step.model === context.model`
and otherwise calls `deriveStatementExecutionContext`
(`src/drivers/execution-context.ts:144-152`) — a **trusted** derived context that
carries the nested model's name *and* re-registers the same resolved extension
chain. Obligation 9's contract is "statement transforms and observers see
candidate statements exactly as they see shipped ones"; they do not.

**Probe.** `tests/raptor3/g4/review/unit02/statement-context.review.test.ts`,
one relation-bearing root update on each engine:

```
CTX shipped   [SELECT author, SELECT post, UPDATE author, UPDATE post, SELECT author]
CTX candidate [SELECT author, UPDATE author, SELECT author, UPDATE author, SELECT author]
```

The note's §4.2 sentence — "the shipped executor likewise passes one context to
every statement" — is the reason the divergence was not noticed, and the unit's
own pin bakes it in: `tests/raptor3/g4/unit02/borrowed-envelope.test.ts:222`
asserts `statement.context?.model === "author"` for *every* statement of exactly
that operation.

**Resolution.** In `statementContext`, when a caller context exists and
`model["~"].names.ts !== callerAttribution.model`, return
`deriveStatementExecutionContext(this.callerAttribution, model["~"].names.ts!)`
— the public helper that keeps the chain — and change
`borrowed-envelope.test.ts:222` from "every statement carries the root model" to
model-parity with the shipped engine (the probe above is the falsifier).
Note the sibling change in the same commit, `statementContext(model, "createMany")`
→ `statementContext(model, this.operation)`, is *correct* and moves toward
shipped parity (the shipped derivation changes only `model`, never `operation`);
keep it.

---

### 3. MUST-FIX — the stated envelope rule is not the operative decision, its recovery path is unreachable, and two shapes violate the rule's own falsifier

**Where.** The rule is stated in `operation-context.ts:361-403` (`run`) and
enforced in `:412-424` (`dispatch`) / `:426-431` (`restart`). The **decision** is
`PhysicalPlan.single`, six per-verb boolean expressions in
`src/query-engine/raptor3/commands/commands.ts:1074`, `:1085-1087`, `:1095`,
`:1098`, `:1110`, `:1179`, `:1206`, `:1211`, `:1230`.

**Three measured consequences**
(`tests/raptor3/g4/review/unit02/envelope-rule-owner.review.test.ts`, which
instruments `OperationContext.prototype.restart` and walks 19 admitted verb
shapes; and `.../delete-and-envelope.review.test.ts` for the shipped column):

1. `RESTARTS = 0`. The `requiresEnvelope` sentinel and `restart()` never run for
   any admitted shape, and by construction cannot: every `single: true` gate in
   `plan()` leads to at most one `dispatch(1, terminal=true, …)`
   (`createMany` with one row is one chunk because `compileBindBudgetChunks`
   short-circuits at `itemCount === 1`, `src/query-engine/bind-budget.ts:33`;
   `lowerMutationLimit` is always one statement, `query.ts:729-760`). So the
   "one rule, one owner" is a comment over dead machinery, `restart()` is dead
   code, and `get statementAtomic()` (`operation-context.ts:433-435`) has no
   consumer in `src/` or `tests/` at all.
2. `createMany` with **two** rows: **1 statement, 1 transaction** — the D-a
   falsifier the note writes for itself ("An operation that issues one statement
   must show **no** BEGIN/COMMIT and one round trip") fails, because
   `commands.ts:1085-1087` decides `single` by *row* count, not statement count.
   The shipped engine runs the same request with 1 statement and 0 transactions.
3. Root `create` (scalar only): candidate **2 statements, 1 transaction** vs
   shipped **1 statement, 0 transactions**. Falsifier 5 of the note ("the
   candidate's single-statement classification must **agree** with the shipped
   `canExecuteDirectly` classification over the qualified verbs") is therefore
   not satisfied, and §12.1's "The classification agrees with the shipped engine
   wherever both were measured" is only true because the create row is absent
   from that table. §8.3 explains *why* the fold was withdrawn and that no
   frozen workload is a root `create` (I confirmed: `RAPTOR3_WORKLOADS`,
   `benchmarks/operation-pipeline-catalog.mjs:464-474`), but the falsifier and
   the table still need to say so.

**Resolution.** Either (a) make `single` mean what the rule says — have
`plan()` answer the constructed **statement count** rather than a per-verb
predicate (the `createMany` gate is the only one that is wrong today), and keep
the sentinel as the enforcement that makes a wrong answer safe, with one probe
that actually drives it; or (b) drop the sentinel, `restart()`, `performed` and
`statementAtomic`, rename `single` to what it is (a per-verb fast-path gate),
and state in `run` that the classification lives in `Commands.plan`. Either way
the note's §5 D-a row and §12.1 table need the `createMany ≥ 2` and root
`create` rows, and falsifier 5 needs an explicit exception for `create` with
§8.3 as its reason.

---

### 4. MUST-FIX — the §8.4 / §12.4 withdrawn-work failures have no receipts, and the receipts cited are passing runs

**Where.** `unit02/note.md` §8.4 table cites
`receipts/final/g3-suppression-retry.log` for "**4** [savepoints] (before the
revert)" and `receipts/native/g3-scope-composition-pg.log` for
"`TransactionError: Transaction scope for driver "pg" cannot be used while its
nested transaction is active` (before the revert)". §12.4 row 3 repeats the
claim with no receipt column at all.

**What is actually there.** Both files are the **post-revert passing** runs:

```
receipts/final/g3-suppression-retry.log   → "Tests 2 passed (2)" … "exit=0"
receipts/native/g3-scope-composition-pg.log → "Tests 2 passed (2)" … "exit=0 (port 65504)"
```

A full-tree grep of `unit02/receipts/` finds no occurrence of
`cannot be used while its nested transaction is active` and no savepoint-count
failure anywhere. This breaks the common brief's "Failed attempts stay failed and
keep their receipts; never relabel" — and it matters, because §8.4 is the entire
justification for leaving brief item 11's borrowed half unimplemented and for the
`operationRegion` extension it proposes for the integrator.

By contrast §8.3's withdrawal **is** properly evidenced:
`receipts/after1/prep.log` really does contain the two
`G2.9 result progress … preserves malformed-result translation` failures it
cites. That is the standard §8.4 must meet.

**Resolution.** Re-run the withdrawn region against `g3-suppression-retry` and
`g3-scope-composition-pg`/`-mysql`, save the failing logs under
`receipts/withdrawn-operation-region/`, and point §8.4 and §12.4 at them; or
mark the claim **unverified** in the note.

---

### 5. MUST-FIX — the published read facts are wrong for `count` and `exist`, and the agreement check that is supposed to pin them does not cover those verbs

**Where.** `src/query-engine/raptor3/shared/schema.ts:80-82`
(`publishesSingleRow`) and `src/query-engine/raptor3/commands/index.ts:129-137`
(`get read()`, which publishes `{ shape: value.query.shape, single }`).

**What breaks.** B-1's purpose is that `{shape, single}` is what the client keys
a cache with and builds `cacheResultCodec` from. Measured
(`tests/raptor3/g4/review/unit02/prepared-and-bulk.review.test.ts`):

| operation | `read.single` | value actually published | `read.shape` |
| --- | --- | --- | --- |
| findUnique / findFirst | true | object | row shape ✔ |
| findMany / groupBy | false | array | row shape ✔ |
| aggregate | true | object | row shape ✔ |
| **count** | **true** | **number** (`3`) | `{_count: int}` — the row, not the value |
| **exist** | **true** | **boolean** (`true`) | `{_count: int}` — the row, not the value |

A codec built from those facts materializes `{_count: 3}` where the read owner
publishes `3`. The unit's own pin,
`tests/raptor3/g4/unit02/prepared-operation.test.ts:96-118` ("the published
cardinality agrees with the read owner's own decision"), only walks
`findUnique`, `findFirst` and `findMany`, so the disagreement is invisible to
it, and §9's answer to gate question 1 ("they are pinned against each other by
an executed check") overstates what that check does.

**Resolution.** Extend the agreement check to every `ReadOperation` and make the
published facts describe the **public** value — either fold cardinality *and*
public shape into the `Read` value now (the note's own §10.11) or have
`get read()` answer `single` from `read.result([])` the way the existing check
does. Falsifier: the table above.

---

### 6. NOTE — obligation 10 (B-3, schema reuse) has no caller, no test, and silently skips name hydration

`EngineConfig.resolved` / `ResolvedSchemaViews`
(`schema.ts:60-68`, `:83-87`, `:141-147`) is read in exactly two places
(`commands/index.ts:79`, `program/index.ts:30`) and **passed by nobody**: a
repo-wide grep finds no `createCommandEngine({… resolved …})` and no test that
constructs `new EngineSchema(schema, resolved)`. The resolved branch also
returns before `hydrateSchemaNames(schema)`, and the candidate dereferences
`model["~"].names.ts!` throughout; it is safe only because the client hydrates
first (`src/client/client.ts:1230`, `:1242`). The obligation is delivered as an
unexercised parameter. Resolution: one check that builds an engine from the
client's `{index, registry}` and asserts identical behaviour plus zero calls to
`validateClientSchemaOrThrow`.

### 7. NOTE — the engine's two public entries still admit twice for one operation

`createCommandEngine.execute` and `.prepareBatch`
(`commands/index.ts:174-193`) each call `prepare(...)` afresh, so the memoized
admission is per *handle*, not per *operation*.
`tests/raptor3/g4/review/unit02/admission-and-projection.review.test.ts` measures
`prepareBatch()` then `execute()` on the same payload: **2 admissions** through
the entries, **1** through one handle. Not observable through today's route for
the case I tried (`route-admission-count.review.test.ts` passes), but it is the
exact shape the array owner uses, and B-1 says admission happens exactly once.
The §11.1 route consumption fixes it; until then the entries should share one
handle per `(model, operation, rawArgs)` call, or the note should scope the
claim to the handle.

### 8. NOTE — §4.4's "latent-bug fix" for `deleteMany` is unfounded

The note says the new `namesRelation(projection)` capture branch
(`operation-context.ts:1134-1139`) "is now also taken by `deleteMany` whenever
the projection names a relation, which is a latent-bug fix". Admission refuses
that input: `deleteMany`/`updateMany` with `select: { <relation>: … }` raises
`ValidationError: … 'select.posts' is not supported on 'deleteMany': a bulk write
projects scalar fields only` (probe: `prepared-and-bulk.review.test.ts`, two
cells). The branch is correct and necessary — for root `delete`, which is the
only verb that can present a relation projection to that owner — but it fixes no
latent bug. Root `delete` with a relation `select`, with `include`, and with
`_count` all take it and all read before the removal
(`["SELECT","SELECT","DELETE"]`, verified in two probes).

### 9. NOTE — two registered G4 modes stay red for witness-owned reasons; both are correctly labelled

- `g4-route-transactions` LX-04 ("DIVERGENCE PIN … an array transaction
  containing a read is refused on a batch-only driver") now fails because the
  candidate returns `ok:[[{"email":"read-array@example.test"}]]`, i.e. **D-2 is
  genuinely resolved** and the pin is stale. The witness stream owns
  `tests/raptor3/g4/route-transactions.test.ts:404-414`.
- `g4-route-admission` "an unsupported verb keeps the candidate's refusal" is
  red on the first entry (`findFirst`, a G4-01 verb); I reproduced the author's
  falsification independently by reading the assertion order
  (`route-admission.test.ts:138-160`). One knock-on the note does not mention:
  now that `delete` is admitted, that witness's
  `world.client.note.delete({ where: { slug: "present" } })` actually removes the
  row, so its later `SELECT slug FROM g4_admission_notes` assertion has become
  unreachable-but-false. Worth flagging to the witness author with the fix.

### 10. NOTE — `prepared.read` is a fresh object on every access

`commands/index.ts:129-137` builds `{shape, single}` inside the getter, so
`prepared.read !== prepared.read`. Harmless today; a cache that keys on identity
would silently miss. One line (`memoize the published facts beside `prepared`)
if the route is going to hold the handle.

### 11. NOTE — verified author claims worth recording as verified

- Root `delete` not-found identity is byte-identical to the shipped engine
  including code and meta: `NotFoundError` / `V6001` /
  `"No author record found for delete"` / `{model:"author",operation:"delete"}`
  (`delete-and-envelope.review.test.ts`).
- A non-unique `delete.where` is refused identically on both engines
  (`ValidationError`), so the fold cannot become a multi-row deletion.
- Adapter identity really is pinned across transaction scoping, so the
  engine-lifetime prepared `Read` is valid for every binding of that lineage:
  `defineImmutableDriverFact(this, "adapter", baseDriver.adapter)`,
  `src/drivers/driver.ts:516-520`, and the pinned session view is
  `Object.create(this)` (`driver.ts:357`).
- The PostgreSQL DATE failure is a fixture defect: the UTC-safe type parser is a
  `PoolConfig["types"]` the driver installs on the pool **it** creates
  (`src/drivers/pg/index.ts:46-60`), while the witness fixture builds its own
  `new PgPool(pgOptions)` (`tests/raptor3/transitions/live-world.ts:363`), and the
  shipped result parser applies the identical UTC-midnight check
  (`src/query-engine/result/scalar-result-parser.ts:364-380`).
- Native container identity and ports match the recorded receipt exactly
  (`7dfda37e8eea…` postgres:16 on 127.0.0.1:65504, `d6da412eec3c…` mysql:8 on
  127.0.0.1:65515, both `Up`, restarts 0).
- `shared/storage.ts` really does raise the registered identity now:
  `Raptor 3 G1 variant carrier membership is not implemented: items` is what
  Q-O04 reports, instead of the bare `TypeError`.

---

## §7 decision-elimination gate, answered against the diff

**1. Necessary decision or representation repair?** Mostly a decision
elimination, with one exception the unit names (`publishesSingleRow`) and one it
does not: the envelope classification is now stated in **two** places — the rule
in `OperationContext.run` and the per-verb predicates in `Commands.plan` — and
only the second is load-bearing (finding 3). That is the reconciliation the gate
forbids, in the same shape ("policy-boolean bag", per-verb) the common brief
names.

**2. Exact deletion and replacement obligation?** D-b, D-c, D-e and D-f are real
and verified: the per-verb read ladder in `program/index.ts` is gone (grep:
`queries.select`/`queries.grouped` no longer appear there), `read()` no longer
refuses in preparation, `"set" in value` is gone repo-wide, and `emptyBulkResult`
/`createMany`/`updateMany`/`deleteMany` now take a `PreparedProjection` so no
second `prepareProjection` call survives in the physical owners. D-a's falsifier
fails (finding 3.2). D-d's falsifier is satisfied only in the weakened form the
unit's own test asserts (finding 2).

**3. One rule across uses?** The read-result owner (`publish`) genuinely is one
rule across live and packaged use. The set-oriented owner genuinely serves
`update`, `updateMany`, `delete`, `deleteMany` with cardinality as the only
difference — root `create` excepted and recorded. The envelope rule does not
(finding 3).

**4. What actually grew?** +291 token-lines / +461 physical / +18,907 bytes over
seven files, reproduced exactly. Of that, `restart()`, `performed`,
`requiresEnvelope` and `statementAtomic` are dead (finding 3.1) and
`ResolvedSchemaViews` is unexercised (finding 6) — roughly 30 token-lines that
buy nothing measurable today.

No second public-syntax walker, no per-verb codec, no recreated lifecycle, no
projection rebuilt for a decoder, no JavaScript arithmetic beside SQL, no legacy
import, no fallback, no cached absence and no public contract change appear in
the diff. `commands/execution.ts`, `relation-body.ts`, `selection.ts`,
`shared/query.ts` and every adapter are untouched, as the note says.

---

## Unverified author claims

1. Cumulative cost (core 8,928 / complete 13,850 token-lines / 30 files) — no
   candidate charged-file manifest is saved with the unit, so the figure cannot
   be recomputed here. The incremental figures are exact.
2. The withdrawn `memberRollback` operation-region failures (§8.4, §12.4) — no
   receipt exists (finding 4).
3. PGlite lane results and the `g4-read-envelope-mysql-contracts` seed failure —
   not re-run in this review; the MySQL receipt's ISO-Z-into-`DATETIME(3)`
   diagnosis is plausible and self-consistent but unverified here.
4. "`flat-scalar-update` … byte-equal to the shipped engine" — verified as
   *value*- and *cost*-equal on SQLite by the unit's own test, which I ran
   green; byte-equality of the emitted SQL was not asserted by anything I ran.
5. The `g0` gate's 10 reds being pre-existing — **now verified independently**
   (§F2 below), not unverified.

---

## Falsifications this review performed

**F1. The atomicity divergence is specific to the two folded verbs.** The same
array on the same driver with `findUniqueOrThrow` as the failing member behaves
identically on both routes, so the cause is `published`'s post-commit throw, not
array packaging in general (`packaged-cardinality.review.test.ts`, third cell
passes).

**F2. The `cs03` extension-campaign selftest red is pre-existing.** The unit's
seven files were swapped for the pre-edit content reconstructed by
reverse-applying `production.patch` into the scratchpad, the selftest re-run
(**10 failed / 32 passed**, identical to the current tree), and the sources
restored from a byte-for-byte scratchpad copy taken first; all seven SHA-256s
re-verified with `shasum -c` and `git apply -R --check` re-run clean afterwards.
Receipts: [`cs03-selftest.log`](unit02-review-receipts/cs03-selftest.log),
[`cs03-selftest-pre-edit.log`](unit02-review-receipts/cs03-selftest-pre-edit.log).

**F3. The envelope sentinel is unreachable.**
`OperationContext.prototype.restart` was instrumented for the duration of one
probe and 19 admitted verb shapes were executed; the counter stayed at **0**
(`envelope-rule-owner.review.test.ts`, `RESTARTS 0`).
