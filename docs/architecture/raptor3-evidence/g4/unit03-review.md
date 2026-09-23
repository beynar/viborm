# G4-03 "client route / types" — independent adversarial review

Reviewer: independent (did not author the unit). Reviewed source: main tree
`/Users/arnaud/code/viborm`, branch `pattern-engine`, base commit `0cc61e61`,
working tree already containing the unit (nothing applied by this review).
Date 2026-09-14 / 2026-09-15 (the review ran across midnight).

Inputs read: `g4/briefs/common.md`, `g4/briefs/review.md`,
`g4/briefs/unit03-client-route.md`, `g4/unit03/note.md` (r1 + r2),
`g4/unit03/handoff.md`, `g4/unit03/production.patch`, `g4/unit03/tests.patch`,
every receipt under `g4/unit03/receipts/`, and the actual code paths in
`src/query-engine/raptor3/route/client-route.ts`,
`src/query-engine/pending-operation.ts`, `src/query-engine/query-engine.ts`,
`src/client/client.ts`, `src/query-engine/write-engine/OperationExecutor.ts`,
`src/client/array-transaction*.ts`, `src/query-engine/raptor3/commands/index.ts`
and `src/query-engine/raptor3/shared/operation-context.ts`.

Review receipts: `docs/architecture/raptor3-evidence/g4/unit03-review/`.
Review probes: `tests/raptor3/g4/review/unit03/` (5 files, 12 cases, kept).
They run with
`node scripts/run-vitest-safe.mjs run --workspace=tests/raptor3/g4/review/unit03/review.workspace.ts tests/raptor3/g4/review/unit03/`
— `scripts/credential-free-test-manifest.mjs:237` deliberately excludes
`tests/raptor3/g4/review/` from every registered project, so the probes carry
their own single-project workspace file and are registered nowhere.

---

## Outcome: **REVISE**

The seam itself is good and the strongest claim the unit makes holds: **the
shipped default route is behaviorally unchanged**. I re-ran 46 shipped client /
engine suites (763 tests) and the whole-estate typecheck; all green, only the
two permitted `pattern/pack.ts` TS2345 diagnostics. The 26 unit tests reproduce
exactly. The cost figure that matters (charged token-lines) reproduces exactly.
Public surface is genuinely unchanged: `VibORM` is not exported from
`src/index.ts` (`:41` exports only `createClient`) nor from
`src/client/exports.ts`, so `VibORM.create(config, route?)` is not a public
signature.

REVISE rather than ACCEPT because **two rows the note reports as fully covered
are not**, and in both cases the unit's own oracle cannot see the gap:

- **LX-14** ("operation observer units: exact sequence, identical to the
  shipped route"): inside `$transaction(callback)` the candidate route makes an
  observer see a `savepoint` unit and two extra `statement` units that the
  shipped route never produces (finding 1). The unit's LX-14 oracle asserts the
  candidate emits *zero* non-operation units — true only at the root, which is
  the only place it looks.
- **LX-04** ("array transaction … per-member results and atomicity"): on a
  batch-only driver, any array transaction containing a **read** member is
  refused on the candidate route and succeeds on the shipped route (finding 2).
  The unit's two LX-04 oracles use write-only arrays.

Neither is a shipped-route regression, and neither needs a design change to
resolve — an honest pending row with a self-falsifying pin (the discipline this
unit already applies well to B-1 and B-4) plus a correction to `note.md` §5
would close both. REVISE also covers three note/receipt accuracy items
(findings 3, 7, 8) and two design notes (4, 5, 6).

---

## Findings

### 1. blocking-for-the-row (must-fix) — the route opens a transaction envelope the shipped route does not, and an observer sees it

**Location.** `src/query-engine/raptor3/route/client-route.ts:197–207`
(`runCandidate`, the `engineDriver.withTransaction(..., execution.context)`
arm). Compare `src/query-engine/write-engine/OperationExecutor.ts:328–356`:
the shipped executor runs a *statement-atomic* write with **no** envelope
(`runStatementAtomic`), and only a multi-statement write reaches
`runTransaction` → `runTransactionScope` → `driver.withTransaction`.

The route opens the region for **every** write whose engine is
transaction-bound, and passes `execution.context` — the client's *trusted*
`QueryExecutionContext` (`pending-operation.ts:800–808`,
`src/query-engine/execution-context.ts:46`) — which is exactly the object that
carries the resolved extension chain (`src/drivers/execution-context.ts:162`).
So the region is fully observed, while the candidate's own statements are not
(blocker B-4).

**Probe.**
`tests/raptor3/g4/review/unit03/route-envelope.review.test.ts`
→ *"an observer sees the same non-operation unit kinds inside
$transaction(callback) on both routes"*.

```
node scripts/run-vitest-safe.mjs run \
  --workspace=tests/raptor3/g4/review/unit03/review.workspace.ts \
  tests/raptor3/g4/review/unit03/route-envelope.review.test.ts
```

```
candidate = ["transaction:$transaction(callback)","operation:create",
             "savepoint:create","statement:create","statement:create"]
shipped   = ["transaction:$transaction(callback)","operation:create",
             "statement:create"]
```

(The candidate's two `statement:create` units are the SAVEPOINT/RELEASE control
statements of the route's own region; the candidate's INSERT and SELECT are
unobserved, which is B-4.)

**Why it matters beyond the unit count.** Three separate claims are falsified by
this one probe:

- `note.md` §5, sentence: *"The route never opens a transaction the shipped
  route would not open"* — false for every statement-atomic write inside a
  callback or nested transaction.
- `note.md` §5, table row "Inside `$transaction(callback)` / nested savepoint",
  column "Mirrors shipped" — the shipped cell describes only the
  multi-statement case.
- `note.md` §D, LX-14 "operation observer units, exact sequence, matched
  against the shipped route" and the unit brief's outcome item 4 ("Lifecycle
  observers must receive the same unit kinds … as today").

`note.md` §G.1 does record the extra SAVEPOINT/RELEASE, but only as an
unmeasured *performance* item. It is also (a) an observability divergence with
the real chain attached, and (b) a substrate divergence: a transaction-capable
driver without savepoint support would now fail a single-statement write inside
a transaction that the shipped route runs envelope-free.

**Resolution.** Either open the operation-scoped region only when the operation
is multi-statement (the decision the shipped route takes with
`compileSingleStatementCandidate` / `canExecuteDirectly`, which under B-1 the
route cannot take before admission — in which case say so), **or** record it as
a named divergence in §5/§D with a self-falsifying pin in
`route-transactions.test.ts` (assert today's exact extra unit sequence so it
goes red when the shape changes), move LX-14 from "covered" to "partial", and
correct the two §5 sentences.

---

### 2. must-fix — LX-04 is claimed covered, but an array transaction containing a read is refused on the candidate route

**Location.** Two owners, both in this unit's blast radius:
`src/query-engine/pending-operation.ts:601–605` — `#resolveSinglePlan` now
returns `undefined` for **every** routed operation, so
`pendingOperationTransactionOwner.prepare` (`:362–370`) never answers a single
statement; and `src/query-engine/raptor3/route/client-route.ts:128–130` —
`prepareBatch()` delegates to `createCommandEngine().prepareBatch`, whose
`batch-preparation` context throws `incompletePreparation` for any
`context.read` (`src/query-engine/raptor3/shared/operation-context.ts:314–316`)
and is converted to `undefined` at `commands/index.ts:93–98`. The array owner
then raises `unbatchableArrayError`
(`src/client/array-transaction-legacy.ts:111`, `:221`).

**Probe.** `tests/raptor3/g4/review/unit03/route-array-reads.review.test.ts`
(2 cases, both fail):

```
# read-only array, batch-only driver
shipped   = ok:[[{"email":"read-array@example.test"}]]
candidate = TransactionError: Driver "sqlite3" does not support callback
            transactions and this transaction contains operations that cannot
            be batched atomically.

# mixed read+write array, batch-only driver
shipped   = ok:[{"id":1,...},[{"email":"mixed-write@example.test"}]]
candidate = TransactionError: … cannot be batched atomically.
```

Control (passes): the same read member inside an array on an **interactive**
driver behaves identically on both routes —
`tests/raptor3/g4/review/unit03/route-observer-failures.review.test.ts`
→ *"a read member in an array transaction on an interactive driver …"*. So the
gap is specific to the batch-only substrate the unit's own LX-04 oracle
exercises with a write-only array.

**Resolution.** Move LX-04 to "partial" with the read half named, add a
self-falsifying pin asserting today's refusal, and record the owner (the
candidate's `prepareBatch` cannot package a read — the same family as B-1's
"no prepared read shape"). No shipped file needs to change for the pin.

---

### 3. must-fix — `note.md` §5 and the handoff describe a binding rule the code does not implement

**Location.** `docs/architecture/raptor3-evidence/g4/unit03/note.md` §5 (the
binding table and the sentence quoted in finding 1) and
`handoff.md` §1 "Binding rule (one comparison, five call paths)", which says
the write arm opens "one `withTransaction` on that driver" as the mirror of the
shipped route. The shipped mirror is conditional; this one is not.

Separately, the unit's own summary line — *"the only unconditional edit replaces
three reads of `#resolveOperation().validatedArgs` with one `#preparedInput()`
accessor"* — undercounts. There are **five** unconditional edits in
`pending-operation.ts`: the three `#preparedInput()` sites (`:269`, `:283`,
`:671`) plus `readPendingCacheResultFriend`'s `codec:` (`:234` → `#cacheResultCodec()`)
and `cacheKeyArgs()` (`:836` → `#cacheKeyPayload()`). I verified all five are
behaviour-preserving on the shipped path by reading them and by the 763 green
shipped tests; `note.md` §A.5–7 does list them, so this is a summary/handoff
accuracy item only.

**Resolution.** Correct §5, the §5 table row, and handoff §1 to state the
condition; align the summary sentence with §A.

---

### 4. note — the `parseResult` route guard is unreachable

**Location.** `src/query-engine/pending-operation.ts:380–387`.

Because `#resolveSinglePlan` short-circuits to `undefined` for every routed
operation (`:604`), `owner.prepare` always returns `undefined`, and every array
owner calls `parseResult` only inside its `kind === "single"` branch
(`src/client/array-transaction-legacy.ts:80–88` and `:208–216`,
`src/client/array-transaction-native.ts:73–86`). No path reaches this throw.

This is a guard whose unique coverage cannot be named — the repository's
standing "one guard per invariant" rule. It also costs charged token-lines in a
shipped file.

**Resolution.** Delete it (the `#resolveSinglePlan` short-circuit is the
invariant, and it is already load-bearing), or name the reachable path and add a
test that hits it.

---

### 5. note — `prepareBatch` silently drops the driver the array owner supplies

**Location.** `src/query-engine/pending-operation.ts:371–379` calls
`operation.#resolveRouted().prepareBatch()` with no driver, and
`client-route.ts:128–130` calls `engine.prepareBatch(modelName, operation,
args)`, which constructs its `OperationContext` on the **factory** driver
(`commands/index.ts:85–92`; `operation-context.ts:114`
`this.driver = binding?.driver ?? factoryDriver`).

The shipped branch on the same line passes the supplied driver into
`prepareSharedBatch`. `src/client/array-transaction-legacy.ts:204` supplies the
*transaction-scoped* driver, so candidate statements are `_prepare`d on a
different driver object from the one that executes them. Nothing observable
today (B-4 means no statement transform or observation runs on those
statements), but it becomes observable the moment B-4's seam lands.

**Resolution.** Record it as a divergence with a pin, or thread the driver
through `RoutedCandidateOperation.prepareBatch(driver)`.

---

### 6. note — `buildStatement()` answers `undefined` for every routed operation

**Location.** `src/query-engine/pending-operation.ts:859–863`; consumer
`src/query-engine/query-engine.ts:131–146`.

On a candidate client, `QueryEngine.build(model, "findMany", args)` throws
*"does not compile to one SQL statement"* for an operation that plainly does.
No client surface reaches `build` (`grep -rn "\.build(" src/client` is empty),
so this is internal only, and the code comment says as much — but it is a
behavior divergence that appears in no row and in no divergence list.

**Resolution.** List it in `note.md` §D alongside the other divergences.

---

### 7. note — the `unit-cost.json` receipt is stale for the route module

**Location.** `g4/unit03/receipts/unit-cost.json`.

| file | receipt | measured now | note |
| --- | --- | --- | --- |
| `client-route.ts` | 8,330 B / 219 lines / **143** token-lines | 8,534 B / 222 lines / **143** token-lines | file mtime 23:37 is later than the receipt 23:36 |
| `query-engine.ts` | 430 / 10 / 5 | 430 / 10 / 5 | exact |
| `pending-operation.ts` | 4,168 / 106 / 73 | 4,168 / 106 / 73 | exact |
| `client.ts` | 515 / 22 / 20 | 515 / 22 / 20 | exact |
| **total** | 13,443 / 357 / **241** | 13,647 / 360 / **241** | token-lines reproduce exactly |

Recomputed with the census's own `countTokenLines`
(`scripts/query-engine-structure.mjs:63–89`) against `git show 0cc61e61:<file>`;
script kept at
`/private/tmp/claude-501/-Users-arnaud-code-viborm/c2c775da-2927-4590-8677-3bb0f5d1aa98/scratchpad/review-cost.mjs`.
The charged figure the plan cares about (+241 token-lines) is correct; only the
byte/physical columns for one file are one edit behind. I also confirmed
`production.patch`'s copy of `client-route.ts` is byte-identical to the file
under review, and that the seam hunks in `production.patch` are identical to
`git diff` of the three shipped files.

**Resolution.** Re-run the cost measurement against the final file.

---

### 8. note — B-2 is recorded as a preserved refusal but is unreachable on every substrate this environment can run

**Location.** `note.md` §4 B-2.

`OperationContext.suppressionRefusal()` fires from
`operation-context.ts:738–746` only when
`adapter.mutations.skipDuplicatesStrategy === "recoverableUniqueError"`, which
is **MySQL only** (`src/adapters/databases/mysql/mysql-adapter.ts:851`; SQLite
`:711` and Postgres `:513` both use `"sql"`). My probe
(`route-behavior-divergence.review.test.ts`, case 1) therefore **passes**:
`createMany({ skipDuplicates: true })` inside `$transaction([...])` behaves
identically on both routes on SQLite, because the refusal is never reached.

So B-2's claim — "this unit therefore preserves that refusal in the array
fallback" — is untested, and on MySQL it would be an observable array-transaction
behavior change for a supported verb (shipped succeeds, candidate refuses).
`note.md` §G.4 already says no native provider ran; B-2 is not listed there.

**Resolution.** Add B-2 to §G as native-only/unverified and register a pin for a
MySQL lane.

---

## What I verified and found correct

- **Reproduction.** The unit's four suites: 26/26 passed, matching
  `receipts/route-suites.log`. Receipt:
  `g4/unit03-review/unit-route-suites.log` (4.78 s wall, 666.5 MiB peak).
- **Shipped route unchanged.** 46 files / 763 tests green across
  `pending-operation-contracts`, `extensions-foundation`, `request-transforms`,
  `query-interceptors`, `query-interceptors-array`,
  `statement-transforms-integration`, `client-construction-boundaries`,
  `schema-introspection`, `protected-driver-lifecycle-observers`,
  `nested-transaction-contract.core`, `array-transaction-closure`,
  `array-transaction-legacy-batch-boundaries`,
  `array-transaction-observed-legacy-coverage`, `official-cache-extension.core`,
  `official-cache-instrumentation.core`, `official-cache-swr.core`,
  `protected-cache-observers`, `raw-observation-closure`. Receipts:
  `g4/unit03-review/shipped-client-suites.log` (389 tests),
  `shipped-client-suites-2.log` (374 tests).
- **Typecheck.** `node scripts/run-typecheck.mjs` on the current tree reports
  **only** the two permitted `pattern/pack.ts` TS2345 diagnostics — cleaner than
  the author's `typecheck-final.log` (the in-flight witness-stream diagnostics
  it listed are gone). No diagnostic in any file this unit owns, and none from
  the review probes. Receipt: `g4/unit03-review/typecheck-clean.log`.
- **LX-18 evidence integrity (falsified).** `tests/types/raptor3/route-public-types.core.types.ts`
  is registered in no vitest project, so I falsified its coverage claim: I
  removed the `takee: 1` typo at `:95`, making its `@ts-expect-error` unused, and
  the whole-estate typecheck reported
  `tests/types/raptor3/route-public-types.core.types.ts(94,5): error TS2578:
  Unused '@ts-expect-error' directive.` The file was restored from a scratchpad
  copy (not `git checkout`; it is untracked) and re-verified byte-identical.
  Receipt: `g4/unit03-review/typecheck-falsified.log`. The claim in `note.md` §E
  holds.
- **Admission-once (plan §2.3).** Probe
  `route-admission-count.review.test.ts` wraps the route and counts the
  admitting entries per public call: an array transaction reaches
  `execute` exactly once per member on an interactive driver and `prepareBatch`
  exactly once per member on a batch-only driver. No double admission.
- **Cache invalidation identity (NS-04, invalidation half).** Probe
  `route-behavior-divergence.review.test.ts` case 3 compares the invalidation
  **keys**, not only their count, and they are identical on both routes.
- **Observer that throws.** Probe `route-observer-failures.review.test.ts`
  case 1: identical public outcome and identical committed state on both routes.
- **Array admission ordering with two invalid members** (the author's unverified
  claim §G.3): probe case 4 — the same error surfaces on both routes. The
  claim's worry does not reproduce for this shape.
- **Public surface.** `VibORM` is not exported by `src/index.ts` or
  `src/client/exports.ts`; `createCandidateClient` is reachable only by deep
  source import. The `QueryEngine` constructor's new 7th parameter is forwarded
  by the only two construction sites (`client.ts:485`, `query-engine.ts:116`
  `bind()`), so a `$extends`-derived or transaction-bound client keeps its route
  — verified by the unit's own extension/interceptor cases diverging from the
  shipped ones.
- **No runtime edge into the candidate from the shipped graph.** All three seam
  files import the route module `import type`-only; the single runtime edge is
  `client-route.ts` → `@client/client`, which the C-01 cutover deletes with
  `createCandidateClient`.
- **Author's falsification of the envelope oracle** (`falsifier-envelope-removed.log`)
  is genuine: exactly one failure, correctly labeled, with the seven other cases
  green.
- **Manifest registration** claimed in `note.md` §E matches
  `scripts/raptor3-manifest.mjs:510/516/522/528` (7 / 5 / 6 / 8 = 26).
- **Patch integrity.** `production.patch`'s seam hunks are byte-identical to
  `git diff` of the three shipped files, and its `client-route.ts` body is
  byte-identical to the file under review.

## §7 decision-elimination gate, answered against the actual diff

1. **Necessary decision or representation repair?** Necessary, with one
   exception. The route holds no state and no payload interpretation; the one
   place it could have grown a second scalar-meaning authority (a cache result
   codec) is refused, correctly. The exception is the unconditional transaction
   envelope of finding 1: that *is* a second, unconditional answer to a question
   the shipped route answers conditionally, and it is the one place the route
   owns lifecycle the brief told it not to own.
2. **Exact deletion and replacement obligation?** No shipped deletion, as the
   plan instructs. The candidate-side deletion ("a candidate operation is
   reached by a test-only direct-driver invocation") is real: I grepped —
   `overrideTransactionOperation` appears nowhere in `tests/raptor3/g4/route-*`,
   and the four suites construct clients only through `createCandidateClient` /
   `VibORM.create`. The falsifier is sensitive (author's receipt, re-read).
3. **One rule across uses?** Yes for the binding comparison
   (`driverOverride` → `engineDriver === factoryDriver` → else), which is the
   single decision across five call paths. No per-verb, per-depth or
   per-substrate branch — but see finding 2: the *consequence* of the rule is
   substrate-dependent in a way no row records.
4. **What actually grew?** +241 charged token-lines (143 route module, 98 seam),
   reproduced exactly. No line added to `commands/` or `shared/`. Two of those
   lines are the unreachable `parseResult` guard (finding 4). No second
   public-syntax walker, no per-verb codec, no duplicated result-shape
   preparation, no projection rebuilt for a decoder, no JS arithmetic beside
   SQL, no defensive re-validation of trusted internal values, no policy-boolean
   bag, no per-feature interpreter, no fixture-named flag, no legacy engine
   import, no fallback to the shipped engine, no cached absence, no public
   contract change.

## Unverified author claims (still unverified after this review)

1. **Performance** (`note.md` §G.1) — no benchmark run by the author or by me.
   Finding 1 shows the extra SAVEPOINT/RELEASE is real and, additionally,
   observable.
2. **Commit-ambiguity publication on the interactive standalone route**
   (`note.md` §G.2) — no witness here either; it rides on the same B-4 seam.
3. **Native providers** (`note.md` §G.4) — nothing ran against PostgreSQL or
   MySQL; Docker is down in this environment too. This review is
   better-sqlite3 only, which is what makes finding 8 (B-2) unverifiable here.
4. **Benchmark reachability protocol** (`note.md` §8) — a written protocol, not
   executed.
5. **Pre-existing red in shared-family shard 6** (`receipts/head-baseline-shard6.log`)
   — I did **not** re-run the PGlite shared-family shards; I accept the author's
   HEAD-worktree baseline as labeled, and it is consistent with the repository's
   recorded pre-existing reds.
