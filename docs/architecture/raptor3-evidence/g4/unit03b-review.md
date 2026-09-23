# G4-03b independent review — client route follow-up after G4-02

Reviewer: independent (did not author the unit).
Unit: **G4-03b route follow-up**.
Brief: [`briefs/unit03b-route-followup.md`](briefs/unit03b-route-followup.md),
[`briefs/common.md`](briefs/common.md), [`briefs/review.md`](briefs/review.md).
Unit record: [`unit03/note.md`](unit03/note.md) §"Follow-up after G4-02",
[`unit03/handoff.md`](unit03/handoff.md) r5,
[`unit03/production-followup.patch`](unit03/production-followup.patch).
Source reviewed: main tree at `0cc61e61` + the unit's working-tree diff.
Probes: `tests/raptor3/g4/review/unit03b/` (6 files, 21 cells).
Receipts: [`unit03b-review-receipts/`](unit03b-review-receipts/).

## Outcome: **REVISE**

The unit's four structural claims hold and I reproduced every count it reports.
D-1 is genuinely gone on both branches, admission really is once, the client's
trusted context really reaches candidate statements, the resolved views really
travel by identity, and the cost figures reproduce to the byte. Two findings
stop this from being an ACCEPT, and both are the same kind of defect: an
**observable divergence from the shipped route that the unit neither found nor
recorded**, on an inventory row the unit moved to COVERED.

- Finding 1 — the query interceptor's `input` for **`upsert`** differs between
  the routes. LX-12 is declared covered on the strength of a one-verb cell.
- Finding 2 — on a **batch-only** driver, an array member that is a
  multi-statement write is **refused by the shipped route and executed by the
  candidate**. LX-04 is declared covered; a registered refusal disappears with
  no pin and no blocker record.

Neither is a wrong answer inside the candidate; both are compatibility choices
that the common brief reserves for Arnaud ("Refusals are contracts… record it
as a blocker in your note, do not copy or 'fix' legacy behavior"). The remedy
for both is small: measure, pin, and record — not repair.

Everything I attacked beyond those two held: the transferred region across
caller-transaction, nested-transaction and array ownership; write-outcome
publication including a listener that throws and an empty `createMany`;
admission-once from every consumer including the cache key, the array owner, a
double await and three concurrent roots; every derived-value read as an array
member; the statement chain reaching the driver with a REWRITING transform.

---

## What I verified (and how)

### Reproduction — every author count matches

| Claim | Author receipt | My receipt | Result |
| --- | --- | --- | --- |
| 4 route suites + C13 witnesses | `unit03/receipts/followup/final-route-and-witness-suites.log` 39/1 | [`repro-route-suites.log`](unit03b-review-receipts/repro-route-suites.log) | **39 passed / 1 failed** — identical, same cell (`lifecycle-admission` cache-bypass), route-transactions 12, route-lifecycle 7, route-admission 7, route-cache 7 |
| shipped client batch 1 | `shipped-suites-1.log` 519/519 | [`repro-shipped-suites-1.log`](unit03b-review-receipts/repro-shipped-suites-1.log) | **519 passed (17 files)** — identical |
| shipped client batch 2 + G3 contracts | `shipped-suites-2.log` 128/128 | [`repro-shipped-suites-2.log`](unit03b-review-receipts/repro-shipped-suites-2.log) | **128 passed (18 files)** — identical |
| prior reviewer's unit03 probes | `review-unit03-probes.log` 19/19 | [`repro-review-unit03-probes.log`](unit03b-review-receipts/repro-review-unit03-probes.log) | **19 passed (8 files)** — identical |
| G4 read contracts | `g4-read-contracts.log` 60/2 | [`repro-g4-read-contracts.log`](unit03b-review-receipts/repro-g4-read-contracts.log) | **60 passed / 2 failed** — identical cells (SC-13 `read-codecs.test.ts`, RF-16 `read-recursive-fit.test.ts`) |
| whole-estate typecheck | `typecheck-final.log` | [`typecheck-with-probes.log`](unit03b-review-receipts/typecheck-with-probes.log) | **exactly 2 diagnostics**, both the permitted `pattern/pack.ts` TS2345 — with my probe files in the program |

**Patch fidelity.** `production-followup.patch` reconstructs the working tree
byte-for-byte: the three tracked hunks are identical to `git diff` on those
files, and the new-file body is identical to
`src/query-engine/raptor3/route/client-route.ts`.

**Identity.** All eight SHA-256 values in
`unit03/receipts/followup/source-identity.log` match the current tree exactly
(re-hashed; see [`source-identity.log`](unit03b-review-receipts/source-identity.log)).

**Falsification 1, reproduced independently.** I restored the r4 shape of
`runCandidate` (route opens the region for a borrowed write) on a scratchpad
copy and re-ran: **exactly 2 cells failed / 17 passed** — the LX-14 unit
sequence and the LX-02 poisoning cell, nothing else
([`falsify-region-restored.log`](unit03b-review-receipts/falsify-region-restored.log)).
The file was restored from the scratchpad copy to
`82ba9c9e…7490b111` in the same command. The D-1 pins are sensitive and the
region is the mechanism.

**Cost, recomputed.** I re-implemented `countTokenLines` verbatim from
`scripts/query-engine-structure.mjs` and measured the four charged files against
`0cc61e61`. Every figure in `unit-cost.json` reproduces exactly:

| File | token-lines | physical | bytes |
| --- | --- | --- | --- |
| `route/client-route.ts` | +144 | +234 | +9,170 |
| `query-engine.ts` | +5 | +10 | +430 |
| `pending-operation.ts` | +70 | +109 | +4,313 |
| `client/client.ts` | +23 | +27 | +740 |
| **unit total vs `0cc61e61`** | **+242** | **+380** | **+14,653** |

### §7 decision-elimination gate, applied to the diff myself

| Question | My answer |
| --- | --- |
| Second public-syntax walker? | No. The route hands the client-prepared payload straight to `engine.prepare`; `preparedArgs` is a getter over the candidate's one `schema.admit`. |
| Per-verb codec / projection rebuilt for a decoder? | No. The codec is refused rather than re-derived, and I confirmed the stop-rule is real (below). |
| Recreated lifecycle / per-feature interpreter / policy-boolean bag? | No. The route owns no lifecycle. `RoutedOperationExecution.isWrite` is the client's existing classification threaded through, and it is **not** redundant: without it a routed READ under an observer would publish `#observationNotification("committed")` (`pending-operation.ts` `#runExecution`), which the shipped executor suppresses via `atomicPlanHasWrite`. |
| Legacy import or fallback? | None. I traced every remaining `#resolveOperation()` call site in `pending-operation.ts` (`:377`, `:387`, `:571`, `:577`, `:607`, `:774`, `:849`, `:866`) and each is either behind `if (this.#route)` or on a path a routed operation cannot reach (`prepare`/`parseResult` are only entered through the array owner's `kind === "single"` arm, which `#resolveSinglePlan` makes unreachable). The route imports no shipped compiler, lowerer, executor or result engine. |
| Route forwarded on every engine construction? | Yes — `new QueryEngine(...)` occurs exactly twice in `src/` (`client.ts:487`, `query-engine.ts:116` = `bind`), and `bind` passes `this.route`. There is no engine scope (transaction, extension chain, cache-managed) that silently drops the route. |
| Public contract change? | No. `src/index.ts` exports `createClient`, not `VibORM`, so the new third constructor parameter and the new `VibORM.create` parameter are not on the package entry. |
| Cached absence / defensive re-validation / JS arithmetic beside SQL? | None found. |

**The claimed deletions really disappeared.** `runCandidate` no longer wraps
anything: `engineDriver.withTransaction` survives only as the body of the two
grants the candidate may choose not to call, and `execution.isWrite` no longer
appears in `runCandidate` at all. Falsification 1 above is the falsifier.

**B-1c's stop-rule is sound, verified from source.** `Leaf`
(`src/query-engine/raptor3/shared/query.ts:65–78`) carries `type`, `nullable`,
`list`, `decimal`, `widened`, `dateTime`, `enumValues`, `dimension` — and no
`Scalar`, no field name and no model. `ProjectionShape`'s object arm keys by the
PUBLIC name only. `compileScalarCodec(scalar)` in
`src/query-engine/result/cache-value-codecs.ts` addresses a scalar by the
object. There is therefore no way to reach the official codec owner from the
prepared read without re-dispatching on the projected state, which is exactly
the second scalar authority the gate rejects. Declining to write it was correct.

**D-3' and D-4' are correctly characterised.** I confirmed D-3' is unobservable
in this estate for a reason stronger than the note gives: prepared-statement
provenance lives in a module-level `WeakMap`
(`src/drivers/prepared-statement-provenance.ts`), `TransactionBoundDriver`
copies `baseDriver.adapter`, and statement transforms are applied from the
CONTEXT — so a package prepared on the factory driver and executed on the array
owner's is byte-identical. My probe drives the one substrate where the two
driver objects differ at all (an array nested inside `$transaction(callback)` on
a driver that supports both transactions and native batches) and both routes
agree. For D-4', `grep -rn "\.build(" src/client` is empty and no `QueryEngine`
constructed with a route is reachable from the public surface; the divergence is
contained.

---

## Findings

### 1. must-fix — the query interceptor's `input` for `upsert` differs between the routes; LX-12 is declared covered on a one-verb cell

**Location.** `src/query-engine/pending-operation.ts:569–572` (`#preparedInput()`),
consumed at `:300` and `:696` (`snapshotQueryInput(preparedInput)`), against
`src/query-engine/write-engine/routing.ts` `case "upsert"` — which validates the
ENVELOPE only and leaves the `create` / `update` arms raw ("the delegated
sub-ops still parse raw, and … stays deferred to the taken branch").
Claim under test: `unit03/note.md` FU.11.1, LX-12 row — *"covered: both routes
publish the same ADMITTED payload"*.

**Probe.**
`tests/raptor3/g4/review/unit03b/route-upsert-payload.review.test.ts`
(minimised from the all-verb sweep in `route-seams.review.test.ts`).

```
node scripts/run-vitest-safe.mjs run \
  --workspace=tests/raptor3/g4/review/unit03b/review.workspace.ts \
  tests/raptor3/g4/review/unit03b/route-upsert-payload.review.test.ts
```

**Measured.** For `client.note.upsert({ where, create, update })` the two routes
publish different `context.input` to a query interceptor, on both the insert and
the update arm:

```
shipped    create: { slug: "u", title: "created" }             update: { title: "updated" }
candidate  create: { id: undefined, score: 0, slug: "u",       update: { title: { set: "updated" } }
                     title: "created" }
```

The candidate fills scalar defaults into the `create` arm, adds an `id:
undefined` key, and normalizes the `update` arm's assignments to `{ set: … }`.
Public results and committed state are identical on both routes (the cell
asserts that first and it passes); only the published payload differs.

The all-verb sweep (`route-seams.review.test.ts`, cell 2) shows this is the
**only** verb that diverges: `create`, `createMany`, `update`, `updateMany`,
`delete`, `deleteMany` and all nine read verbs publish byte-identical payloads,
and `cacheKeyArgs()` agrees on every read verb (cell 1, green).

**Why it matters.** `context.input` is the documented LX-12 surface. An
extension reading `input.update.title` gets `"updated"` today and
`{ set: "updated" }` on the candidate route; one reading `input.create` sees keys
the caller never wrote. That is a compatibility choice, not a bug in either
engine.

**Resolution.** Either (a) pin the divergence with a self-falsifying cell in
`route-lifecycle.test.ts` and record it in `note.md` FU.6 as a blocker with the
exact requested change, downgrading the LX-12 row from COVERED to PARTIAL; or
(b) obtain Arnaud's decision that the normalized payload is the intended
`upsert` publication and record it as an approved compatibility decision in the
inventory's section G. Do not "fix" it by re-raw-ing the arms in the route —
that would be a second admission.

---

### 2. must-fix — on a batch-only driver the candidate executes an array member the shipped route refuses; a registered refusal disappears unpinned

**Location.** `src/query-engine/pending-operation.ts:601–604`
(`#resolveSinglePlan` returns `undefined` for every routed operation) and
`:371–379` (the routed `prepareBatch` seam), against
`src/query-engine/write-engine/OperationExecutor.ts:1515–1519` —
`TransactionError: query-engine-v2 cannot merge an insertId-scratch operation
into a shared driver batch.`
Claim under test: `unit03/note.md` FU.11.1, LX-04 row — *"covered: the read is
packaged in ONE native batch on both routes with the same rows"*, and the
LX-04 parity cells in `route-transactions.test.ts`, all of which use
single-statement members.

**Probe.**
`tests/raptor3/g4/review/unit03b/route-envelope-array.review.test.ts`,
cell *"an array transaction whose member is MULTI-statement behaves the same on
both routes (batch-only)"*.

```
node scripts/run-vitest-safe.mjs run \
  --workspace=tests/raptor3/g4/review/unit03b/review.workspace.ts \
  tests/raptor3/g4/review/unit03b/route-envelope-array.review.test.ts
```

**Measured.** `client.$transaction([ client.author.create({ data: { email, name,
books: { create: [ … , … ] } } }) ])` on a `supportsBatch && !supportsTransactions`
driver, with and without `select`:

| | shipped | candidate |
| --- | --- | --- |
| outcome | `TransactionError: query-engine-v2 cannot merge an insertId-scratch operation into a shared driver batch.` (both variants) | `ok:[{"email":"barr@example.test"}]` / `ok:[{"id":2,…}]` |
| rows written | none | 2 authors, 4 books |

The same scenario on an **interactive** driver agrees on both routes (adjacent
cell, green), because there both engines fall through to the sequential
`executeWith` arm. The divergence exists only where there is no sequential
fallback.

**Why it matters.** This is a public refusal that the candidate route removes.
The common brief makes refusals contracts and makes a new observable
compatibility choice a decision for Arnaud. The inventory's LX-04 disposition
("candidate provides packageability, never another protocol") suggests the
direction may well be *wanted* — but the unit's own evidence asserts parity for
LX-04 and this case is neither measured nor recorded anywhere in `note.md`.

**Resolution.** Add the cell to `route-transactions.test.ts` as an explicit
recorded divergence (pin today's answer on both routes so it fails the day the
answer changes), and record it in `note.md` FU.6 / FU.11 as a
refusal-removal decision for Arnaud, naming
`OperationExecutor.ts:1515` as the shipped owner. Do not re-introduce the
refusal in the candidate.

---

### 3. note — brief outcome 2 ("`$withCache` works on the candidate route for reads") is not met, and a registered witness cell stays red on this tree

**Location.** `src/query-engine/raptor3/route/client-route.ts:142–147`
(`cacheResultCodec()` throws `UnsupportedOperationError`), reached from
`src/query-engine/pending-operation.ts:234` and `src/client/client.ts:721`.

**Reproduction.** `tests/raptor3/g4/lifecycle-admission.test.ts` →
*"C13 cache-bypass: a cached read inside a transaction never serves the cache"*
fails with that refusal
([`repro-route-suites.log`](unit03b-review-receipts/repro-route-suites.log),
3 passed / 1 failed in that file).

The unit records this correctly and completely as blocker **B-1c** with an exact
one-line requested change to `shared/query.ts` (another stream's file), and pins
today's refusal in `route-cache.test.ts`. I verified the stop-rule reasoning is
sound (see above) and that the refusal predates the follow-up (it is r1's
`UnsupportedOperationError`, with a re-attributed message). So the unit did the
right thing.

What is worth flagging for the integrator rather than the author: LX-07's
store/materialize half, RF-10 and the codec half of NS-04 remain **PENDING**
against a brief that listed them as outcomes, and the registered
`g4-lifecycle-admission` suite is red at 3/4 until the `shared/query.ts` change
lands. The `note.md` phrasing "inherited red, not this unit's file" is accurate
about file ownership and slightly generous about causation — the red is produced
by this unit's refusal.

**Resolution.** Route the `Leaf.scalar` request to the `shared/query.ts` owner
and re-run `g4-lifecycle-admission` + `route-cache.test.ts` (whose B-1c pin is
written to fail the day the seam lands).

---

### 4. note — the registered cell counts are stale, so the `g4-route-*` campaign modes are red on this tree

**Location.** `scripts/raptor3-manifest.mjs:510–532`.

Registered: `route-lifecycle` 7, `route-admission` 5, `route-cache` 6,
`route-transactions` 11. Measured on this tree (my reproduction): 7, **7**,
**7**, **12**. `scripts/run-raptor3.mjs:1025–1036` asserts
`assertionResults.length === expected` per file, so
`node scripts/run-raptor3.mjs g4-route-admission` (and `-cache`,
`-transactions`) fails with *"Missing candidate/profile/scenario cell in …"*.

The unit correctly does not own the manifest and files the request in
`note.md` FU.12 with the right numbers. This is an integrator action item, but
the tree is red for those three modes until it happens, so it should not be
lost between units.

**Resolution.** Manifest owner applies FU.12's three count changes.

---

### 5. note — "incremental core semantic cost is 0" is true only under the unit's own exclusion of its own directory

**Location.** `unit03/note.md` FU.9.

The sentence reads *"Incremental core semantic cost is **0**: no file under
`src/query-engine/raptor3/` outside the route changed."* `client-route.ts` is
itself under `src/query-engine/raptor3/`, and it carries **+144 token-lines /
+9,170 bytes** of the unit's +242 / +14,653. The whole-unit figure is stated
immediately above, so nothing is concealed; the phrase is nonetheless the kind
of definitional carve-out that reads as a zero when skimmed into a milestone
ledger.

**Resolution.** Say "no file under `src/query-engine/raptor3/` **other than the
new route adapter**", or charge the route and state the number.

---

## Probes I ran that the unit passed

Kept under `tests/raptor3/g4/review/unit03b/` (21 cells, 18 green; the 3 red are
findings 1 and 2). Receipt:
[`review-unit03b-probes.log`](unit03b-review-receipts/review-unit03b-probes.log).
`biome check` is clean on all seven files and they add no typecheck diagnostic.

**`route-seams.review.test.ts`** — `cacheKeyArgs()` parity across all eleven
read-verb shapes including bare `count()`, `aggregate`, `groupBy`, both
`OrThrow` verbs and a paged `findMany` with `OR`/`skip`/`take` (green); a
statement transform that REWRITES the SQL (the unit's LX-13 cell only observes)
reaches the driver on **every** statement of both routes (green).

**`route-envelope-array.review.test.ts`** — after a FAILING multi-statement
member, the caller's transaction is still usable and its later write COMMITS
(the unit's LX-02 cell returns from the callback immediately and cannot see a
leaked region); the same one level deeper inside `tx.$transaction(...)`, where
the transferred `operationRegion` opens on a savepoint driver; a multi-statement
array member on an interactive driver; a read beside a multi-statement write in
one array. All green.

**`route-array-verbs.review.test.ts`** — every derived-value read as a
batch-only array member (`count`, `exist`, `aggregate`, `groupBy`, `findUnique`
hit and miss, `findUniqueOrThrow` miss, and a read+write+read mix), plus an
array nested inside a callback transaction on a batch-and-transaction driver
(the only D-3' substrate). All green, with non-vacuity assertions
(`ok:[2]`, `ok:[true]`, `ok:[null]`, `NotFoundError`).

**`route-write-outcome.review.test.ts`** — a write whose cache invalidation
THROWS (identical public outcome, identical invalidation attempts, identical
rows); a write failing on a segmented substrate; a multi-segment `createMany`
(exactly one invalidation on both routes); an **empty `createMany`**, the payload
where the route's verb-level `isWrite` gate and the shipped plan-level
`atomicPlanHasWrite` gate could disagree. All green.

**`route-admission-seam.review.test.ts`** — admission exactly once when the
cache key is read twice and then the operation executes; when the array owner
prepares a member; when one pending operation is awaited twice (one row, one
admission); three concurrent root writes with a collision; an interceptor that
throws before `proceed()` (no SQL, no admission difference). All green.

---

## Unverified author claims (carried forward, correctly labelled by the author)

1. **Falsification 2 did not fire.** Granting `operationRegion` on the array arm
   left the credential-free suites green; the "no grant" on that arm rests on
   G4-02's native `scope-composition-pg/-mysql` measurement. I could not run the
   provider lane either. Still unverified locally.
2. **Performance.** No benchmark; the standalone-root cost was never measured.
3. **D-3'** is source-read, not measured. I independently confirmed it cannot be
   measured in this estate and gave the mechanism (module-level provenance
   WeakMap, shared adapter) — so it is unverifiable rather than unverified.
4. **B-2** (borrowed `createMany skipDuplicates` suppression refusal) remains
   MySQL-only and unreachable here.
5. **The two `g4-read-contracts` reds** are attributed to `unit02/note.md`
   §P.11.1 without re-measuring on a tree without this diff. I confirmed neither
   file imports the route (`grep` for `client-route` / `createCandidateRoute` in
   `read-codecs.test.ts`, `read-recursive-fit.test.ts`, `read-schema.ts`,
   `witness-world.ts` is empty), so the attribution is safe.
6. **`publishFailedWriteOutcome`'s committed-prefix arm** is unexercised by any
   probe I could construct on the credential-free substrate: every failing
   multi-statement write I could reach rolls back whole. Recorded in the probe
   itself.
