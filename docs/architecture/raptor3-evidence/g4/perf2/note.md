# G4 performance pass 2 — allocation shape and reuse (G4-02 author)

Brief: [`../briefs/perf-safe-fixes.md` → `../briefs/perf-pass-2.md`](../briefs/perf-pass-2.md)
(Arnaud, 16:55 2026-09-16), with [`../briefs/common.md`](../briefs/common.md)'s
twelve rules re-affirmed word for word. Base: the committed pass-1 tree
`ff5e77ca`; the main tree carries this pass. Scope: **no behaviour change** —
every public answer, refusal sentence, error class and meta, committed state,
statement count, round-trip count and the frozen fast-path counts stay
identical.

Diagnosis this pass applies: [`../cutover/perf-diagnosis.md`](../cutover/perf-diagnosis.md)
§4.2 (cause 2) and §4.3 (cause 3), re-profiled from scratch in §0 because pass 1
moved every number in its §2 table.

---

## 0. Re-profile, before any edit

### 0.1 Instruments and trees

Two scratch copies of the **main tree** (not the perf worktrees, which the
measurement unit owns):
`…/scratchpad/perf2/ab/{before,after}`, each `git archive HEAD`
(`ff5e77ca`) of `src/ benchmarks/ scripts/ package.json pnpm-lock.yaml
tsconfig.json tsdown.config.ts vitest.*`, plus the committed
[`../cutover/phase-adapter.patch`](../cutover/phase-adapter.patch) so the
measured cell is the package seam both engines publish
([`../cutover/protocol.md`](../cutover/protocol.md) §2.1), plus pass 1's A/B
instrument — the package entry re-exports `createCandidateClient` and the
**core** fixture builds the measured client with it when
`VIBORM_BENCH_ENGINE=candidate`
(`benchmarks/operation-pipeline-fixtures.mjs` is byte-identical to pass 1's).
Built with `pnpm package:build` (`tsdown`, 177 files). All five cells used here
are `core` cells (`operation-pipeline-catalog.mjs:367`, `:386`, `:387`, `:406`,
`:449`), which is the only fixture the switch reaches.

Drivers, all re-used from the cutover diagnosis unchanged
(`…/scratchpad/perf-diag/`): `prof-stage.mjs` (CPU profile at 50 µs sampling, or
`HeapProfiler` allocation sampling at **128 B**, started and stopped around the
measured loop only), `gc-stage.mjs` under `--trace-gc`, `analyze-stages.mjs`
(innermost-matching-stage partition, sourcemapped), `analyze-prof.mjs` (self
time), `analyze-alloc.mjs`. Node v24.21.0, darwin/arm64, better-sqlite3, SQLite
`:memory:` only, ambient desktop load.

Iterations: `scalar-find-unique/prepare` 20 000 after 2 000;
`fixed-collection-rowref-1000/prepare` 3 000 after 600;
`bulk-update-returning-100/prepare` 5 000 after 1 000.

Receipts: [`receipts/profile-base/`](receipts/profile-base/).

### 0.2 The three blocking cells, as they stand at `ff5e77ca`

Profiled run (profiler attached, so absolute figures carry its overhead; the
A/B of §5 is the unprofiled measurement):

| Cell | Engine | CPU µs/op | wall µs/op | alloc B/op | scavenges | scavenge ms | steady scavenge ms | steady semi-space |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `scalar-find-unique/prepare` | shipped | 14.75 | 6.89 | 24 642 | 60 | 11.33 | 0.17 | 37.0 MB |
| | **candidate** | 21.25 | 9.78 | **23 995** | 23 | 43.67 | **2.75** | **173.9 MB** |
| `fixed-collection-rowref-1000/prepare` | shipped | 38.72 | 18.57 | 47 712 | 30 | 6.45 | 0.17 | 36.5 MB |
| | **candidate** | 32.74 | 17.56 | **38 699** | 16 | 12.16 | **1.17** | 53.5 MB |
| `bulk-update-returning-100/prepare` | shipped | 31.12 | 21.47 | 64 012 | 48 | 8.55 | 0.12 | 35.2 MB |
| | **candidate** | 39.31 | 24.25 | **55 149** | 22 | 20.61 | **1.12** | 92.0 MB |

**The diagnosis's cause 2 is confirmed and sharpened.** On all three cells the
candidate allocates **fewer** bytes per operation than the shipped engine
(−2.6 %, −18.9 %, −13.8 %) and still pays 2–3× the main-thread GC, because V8
has grown its semi-space 1.5–4.7× and each scavenge evacuates far more
survivors (0.12–0.17 ms shipped against 1.12–2.75 ms candidate). This is object
**shape and lifetime inside one operation**, not volume — exactly §4.2's
reading, now with the "equal bytes" clause corrected to "fewer bytes".

### 0.3 Ranked stage partition (sourcemapped, innermost match, no double count)

`scalar-find-unique/prepare`, µs/op of on-thread profiled wall:

| Stage | shipped | candidate | Δ |
| --- | ---: | ---: | ---: |
| gc / vm | 1.304 | **3.067** | **+1.763** |
| candidate `Queries.read` / projection / selector | — | **2.234** | **+2.234** |
| shipped write-engine + builders + operations + result | 2.228 | 0.040 | −2.188 |
| driver / execution context | 0.790 | 1.032 | +0.242 |
| `Sql` fragments (`src/sql`) | 1.037 | 0.800 | −0.237 |
| admission (`EngineSchema.admit` + `src/validation`) | 0.452 | 0.579 | +0.127 |
| candidate `Commands` (write plan) | — | 0.473 | +0.473 |
| candidate `OperationContext` (package build + ctor) | — | 0.429 | +0.429 |
| node builtins (incl. `crypto.randomUUID`) | 0.221 | 0.277 | +0.056 |
| pending-operation / query-engine glue | 0.373 | 0.269 | −0.104 |
| candidate route glue | — | 0.196 | +0.196 |
| schema model access | 0.181 | 0.085 | −0.096 |
| adapter lowering | 0.131 | 0.129 | −0.002 |
| client proxy | 0.133 | 0.125 | −0.008 |

`fixed-collection-rowref-1000/prepare`: candidate `Queries.read`/projection
**4.025** (no shipped counterpart; the shipped builders+result+write-engine+
operations total 7.789), gc/vm 4.154 against 2.877, admission 3.222 against
2.792, `Sql` 2.083 against 1.779.

`bulk-update-returning-100/prepare`: candidate `Queries.read`/projection/selector
**7.076** (shipped write-engine 4.342 + builders 4.208 = 8.550), `Sql` 5.016
against 5.226, gc/vm 4.335 against 1.892, `OperationContext` **1.601**.

So after pass 1 the candidate's own planning is **already cheaper than the
shipped engine's** on every one of the three cells (2.7 against 2.2, 4.0 against
7.8, 7.1 against 8.6 µs/op). What is left of the regression is, in order:
**GC (cause 2)**, then the candidate's residual per-operation derivation, then
`OperationContext`.

### 0.4 The ranked rows this pass targets

Self time (µs/op) and sampled allocation (B/op), candidate arm:

| # | Row | scalar-find-unique | rowref-1000 | bulk-update-100 | Item |
| --: | --- | --- | --- | --- | --- |
| 1 | `prepareProjection` `query.ts:3008` | 0.652 µs, **1 824 B** | 0.447 µs, 1 237 B | 0.266 µs | 2 |
| 2 | `lowerProjection` `query.ts:3232` | 0.323 µs, **2 021 B** | 0.500 µs, 2 237 B | 0.184 µs, 1 327 B | 2 |
| 3 | `projectedColumn` `query.ts:654` | 0.104 µs, **1 156 B** | — | — | 2 |
| 4 | `scalarValue` `query.ts:544` | — | — | 0.974 µs, **11 356 B** | 4 |
| 5 | `prepareOperand` `query.ts:1287` | — | — | **2.134 µs**, 4 008 B | 4 |
| 6 | `prepareOperation` `query.ts:1234` | — | — | 0.792 µs | 4 |
| 7 | `lowerOperation` `query.ts:1534` | — | — | 0.568 µs, 843 B | 4 |
| 8 | `crypto.randomUUID` (`getBufferedUUID`+`serializeUUID`) | 0.096 µs, **585 B** | — | 0.585 B/op | 1 |
| 9 | `OperationContext` ctor + field block (`:112`, `:214`, `index.ts:191`) | 0.127 µs, **676 B** | 0.530 µs (stage) | 0.200 µs, 956 B | 1 |
| 10 | `WeakSet`/`WeakMap` field allocation | **275 B** | — | 272 B | 1 |
| 11 | `lowerRelationProjection` `query.ts:3324` | — | **2 246 B** | — | 2/3 |

---

## 1. Decision-elimination gate (written before the first production edit)

Plan §7 asks four questions of the diff; §6 answers them against the actual
diff. This section states, per item, the required behaviour, the current owner,
the smallest change, the invariant that makes the removed work unnecessary, and
the falsifier.

### Item 1 — a pure read allocates no write machinery (rule 7)

- **Required behaviour.** An `OperationContext` owns, for the operations that
  need them: one disposable transport attempt (pending statements, insert
  producers, assertion failures, pending members, batch scratch), the set of
  members whose segment committed, each member's attribution path, the
  generated-output continuations, the prepared batch guards, the failures the
  operation has already answered with, and one correlation id that is stable for
  the whole operation.
- **Current owner.** `shared/operation-context.ts:123-192`, eight class fields
  initialised in the block that runs on EVERY `new OperationContext(...)` —
  `attempt = new TransportAttempt()` (itself an object + array + two `Map`s +
  a `Set`), `committedMembers` (`Set`), `memberAttribution` (`WeakMap`),
  `continuations` (array), `preparedGuards` (array), `answeredFailures`
  (`WeakSet`), `correlationId = crypto.randomUUID()` — plus
  `shared/transport-attempt.ts:8-15`.
- **Smallest change.** Each becomes a `undefined`-initialised private field plus
  a private accessor that materialises it once (`??=`), exactly like pass 1's
  two sentinels; every reader that only asks whether the collection is EMPTY
  reads a non-materialising probe instead. No read/write subclass, no policy
  boolean, no second context class (rule 3).
- **Decisions that disappear.** "Has this operation already paid for the write
  machinery it may never use?" — there is nothing to pay until an owner needs
  it. **Mechanism:** field initialiser → first-use accessor. **Consumers:** the
  queue/submit/flush/failure/prepared-batch sites, unchanged in meaning.
  **Replacing invariant:** a collection is materialised by its accessor before
  any writer can observe it, and an absent collection is empty for every reader,
  so no reader can distinguish absent from empty; the correlation id is
  materialised at its first read and `??=` keeps it stable for the operation's
  life. **Falsifier:** the allocation profile of `scalar-find-unique/prepare`
  shows the constructor and field block near the shipped engine's equivalent
  (B/op before and after stated); every read mode byte-identical; the whole
  write estate green, including the registered cells that observe attempt
  identity across a recovery restart.

### Item 2 — immutable schema facts are resolved once (rule 1)

- **Required behaviour.** `Queries.prepareProjection(model, args)` answers one
  immutable alias-free projection description and decoder shape; `scalarShape`
  answers one leaf per (model, field).
- **Current owner.** `shared/query.ts:3008` (`prepareProjection`, which builds
  `Object.fromEntries(scalarFieldNames.filter(…).map(…))` per read when
  `args.select` is absent, then a fresh frozen descriptor and a fresh frozen
  leaf per field per call) and `:699` (`leaf`, which freezes a new object and
  may build a new `Set` of enum values per call).
- **Smallest change.** Memoise, per (adapter, model), the projection
  `prepareProjection` answers when the operation names NEITHER `select` NOR
  `include`, and memoise the leaf per (adapter, model, field). The memo is
  keyed by the adapter because a leaf's `dateTime` representation is the
  adapter's (`query.ts:709`), and by the model object, like
  `EngineSchema.physicalField`. `EngineSchema` owns the store, because it is
  already the factory-lifetime owner of lazy immutable per-model views, and a
  `Queries` instance is per-operation for writes.
- **Why this is safe under rule 5.** The default projection is a pure function
  of the model: `selected` is `model["~"].scalarFieldNames` minus
  `model["~"].state.omit`, and an operation-level `omit` reaches the engine
  already desugared into `args.select` at admission — so an operation that
  names `select`, `include` or `omit` still prepares per operation, as today,
  and only the per-field pieces are shared. The memo holds nothing admitted and
  nothing from a database.
- **Decisions that disappear.** "Which operation prepared this model's default
  projection?" — a projection with no `select` and no `include` is a fact of the
  model and the adapter, not of the operation. **Mechanism:** per-call
  construction → per-(adapter, model) memo. **Consumers:** every
  `prepareProjection` caller, unchanged — they receive the same frozen value.
  **Replacing invariant:** the answer is already deeply frozen and derived from
  schema alone, and no consumer mutates it or compares it by identity (surveyed
  below); the one identity-sensitive structure in the engine is
  `seriesQueries`'s `WeakMap<Sql, Query>`
  (`operation-context.ts:1007`), which keys freshly built STATEMENTS, not
  projections. **Falsifier:** bytes/op of `prepareProjection`/`lowerProjection`
  on the read cells, the `--trace-gc` scavenge profile moving toward the shipped
  engine's, results byte-identical, and a registered cell that two default
  projections of one model are the same value while a selected one is not.

### Item 3 — reuse of the value-independent half of a prepared read

Gated by the brief: taken only if a read cell is still over budget after items
1–2 AND the profile attributes the residual to re-deriving the same structure,
and stopped if it would need a second representation of the predicate, a second
walker of the public syntax, or anything observed in the memo. Decided in §4
against the measurement, not in advance.

### Item 4 — the write cell, profile-driven

- **Required behaviour.** `user.updateMany({ where: { id: { in: ids₁₀₀ } },
  data: { age: { increment: 1 } } })` prepares one predicate mutation statement
  with 100 bound members, publishing the same SQL, the same parameters and the
  same refusals.
- **Current owner.** `shared/query.ts:1234` (`prepareOperation`'s `in`/`notIn`
  arm, which `Object.freeze`s one `PreparedOperand` box per member), `:1287`
  (`prepareOperand`), `:1534` (`lowerOperation`), `:544` (`scalarValue`).
- **Smallest change.** Allocation and derivation trims only, each named with its
  own µs/op: nothing about the update language, no JavaScript arithmetic beside
  SQL (rule 9), no set-oriented work moved into a loop (rule 6), no codec per
  verb (rule 11).
- **Falsifier:** `bulk-update-returning-100/prepare` CPU and B/op before and
  after; the published SQL text and parameter list byte-identical; the write
  estate green.

---

## 2. Item 1 — a pure read allocates no write machinery (rule 7) — TAKEN

### 2.1 The change

`shared/operation-context.ts` and `shared/transport-attempt.ts`. Eight
per-operation fields became `undefined`-initialised private fields plus a
first-use accessor, exactly like pass 1's two sentinels:

| Was | Is |
| --- | --- |
| `private attempt = new TransportAttempt()` | `attemptStore?` + `get attempt()` (`??=`), plus `get queued()` — the empty list for an operation that has queued nothing, so no emptiness reader creates an attempt |
| `readonly committedMembers = new Set<Member>()` | `committedMemberSet?`, created by `submit`'s acknowledgement; `failure` reads `?.size ?? 0` |
| `readonly memberAttribution = new WeakMap<…>()` | `memberAttributionMap?`, created by `prepareMembers`; the two readers use `?.get` |
| `readonly continuations: […][] = []` | `continuationList?` + `get continuationCount()`; `submit` binds `?? NO_CONTINUATIONS` once |
| `readonly preparedGuards: PreparedBatchGuard[] = []` | `preparedGuardList?`, created by `packagedPresence`; `preparedBatch` reads `?.length` |
| `readonly answeredFailures = new WeakSet<object>()` | `answeredFailureSet?`, created by `answered()`; `failure` reads `?.has` |
| `readonly correlationId = crypto.randomUUID()` | `correlationIdValue?` + `get correlationId()` (`??=`) |
| `TransportAttempt`'s `insertProducers`, `assertionFailures`, `pendingMembers` | three private fields with `recordInsertProducer` / `assertPremise` / `recordMember`, one non-materialising probe (`hasAssertedPremises`) and three `drain…()` accessors that replace `submit`'s copy-then-clear |

`restart()` still installs a fresh `TransportAttempt`, so a re-constructed body
sees exactly what it saw before; `restartRejectedInsert` installs the recovery's
attempt the same way.

### 2.2 The invariant

**An absent collection IS empty for every reader, and a materialised one is
created by its accessor before any writer can observe it.** Every reader was
surveyed: the emptiness readers (`.size`, `.length`, `has`, iteration) read a
non-materialising probe or `?.`; every writer materialises with `??=`. The
correlation id is stable because `??=` mints at most one, and the client route
always hands its own trusted execution context down, so a read never mints one
at all.

### 2.3 Falsifiers — measured

- **Cost.** `scalar-find-unique/prepare` candidate **17.36 → 15.40 µs CPU/op
  (−1.96)** and 8.75 → 7.53 wall, while the shipped side moved −0.42
  ([`receipts/ab/ab-item1-summary.json`](receipts/ab/ab-item1-summary.json)).
- **Allocation.** The cell's sampled allocation fell **23 995 → 22 374 B/op**.
  The context's own rows: constructor + field block + `new` **1 536 → 553 B/op**
  (`crypto.randomUUID` 585 → 0, `WeakSet` 138 → 0, `WeakMap` 137 → 0, field
  block `:112` 77 → 0), `Map @ (vm)` 954 → 583, `Set @ (vm)` 456 → 153. GC fell
  from 2.376 to 1.690 µs/op and the steady semi-space from 173.9 to 102.6 MB
  ([`receipts/profile-item1/`](receipts/profile-item1/)).
- **"Absent reads as empty" is load-bearing, and the estate sees it.** Dropping
  the `?? 0` from `committedWriteMembers` (`this.committedMemberSet!.size`)
  turns `uncertain-outcome-meta.test.ts` cell 2 red with
  *"TypeError: Cannot read properties of undefined (reading 'size')"*
  ([`receipts/falsify/item1-absent-is-not-empty.log`](receipts/falsify/item1-absent-is-not-empty.log)):
  a registered cell does reach `failure()` on an operation that committed no
  member. Making `get queued()` blind to a real queue turns **6 files / 13 cells**
  red, across `packaged-array`, `prepared-operation`, `prepared-statement-stability`,
  `malformed-result-cuts`, `key-arithmetic` and `uncertain-outcome-meta`
  ([`receipts/falsify/item1-queued-probe-blind.log`](receipts/falsify/item1-queued-probe-blind.log)).
  Both restored from the scratch copy to
  `bc791617ea8aceea888f5a69fea65c8077edf0a5037fbd86837d6a62cdffc637` and re-run
  green ([`receipts/falsify/after-restore-g4-unit02-author.log`](receipts/falsify/after-restore-g4-unit02-author.log)).
- **The write estate is green**, including every batch, recovery, series and
  progress mode (§6).

## 3. Item 2 — immutable schema facts are resolved once (rule 1) — TAKEN

### 3.1 The change

`shared/schema.ts` gains one named view, `EngineSchema.queryViews(adapter)` —
a factory-lifetime view store per adapter, held weakly — and `shared/query.ts`
reads it for two memos:

```ts
export type QueryViews = {
  readonly leaves: WeakMap<AnyModel, Map<string, Leaf>>;
  readonly defaultProjections: WeakMap<AnyModel, PreparedProjection>;
};
```

- `scalarShape(model, field)` answers one `Leaf` per (adapter, model, field)
  instead of a fresh frozen object — and a fresh enum `Set` — per projection.
- `prepareProjection(model, args)` answers ONE shared projection when
  `args.select === undefined && args.include === undefined`, and prepares per
  operation otherwise, exactly as before.

The adapter is the second key because a leaf carries the adapter's own
`dateTime` representation (`query.ts:732`; the base profile's `:709` row);
`EngineSchema` is the owner because a `Queries` instance is per-operation for
writes and the guide already makes `EngineSchema` the owner of lazy immutable
factory-lifetime per-model views.

**Round 2 — the accessor is named for its one fact (review finding 3, the
reviewer's FIRST resolution).** Round 1 shipped a generic
`adapterScope<T extends object>(adapter: object, create: () => T): T` over a
`WeakMap<object, object>` with an `as T` cast: a second caller asking it for a
different shape under the same adapter would have received the first caller's
object typed as its own, and the cast is what would have hidden it. The store
is now `WeakMap<DatabaseAdapter, QueryViews>` behind
`queryViews(adapter: DatabaseAdapter): QueryViews` — no type parameter, no
cast, one fact — and `QueryViews` with its `createQueryViews` factory moved to
`shared/schema.ts` beside the other views, `shared/query.ts` importing the type
from there.

**It introduces no runtime import cycle**, which is why the first resolution
was takeable. `schema.ts`'s two new imports are both `import type`
(`DatabaseAdapter` from `@adapters/database-adapter`, `Leaf` and
`PreparedProjection` from `./query`), and the census excludes type-only imports
by definition ("Strongly connected components of runtime imports internal to
the measured directory; type-only imports are excluded"). Re-run, it still
reports **2 runtime import-cycle components over 14 files**, the same two as
the base — the shipped `builders/` twelve, and
`raptor3/commands/commands.ts` ↔ `raptor3/commands/execution.ts` — and neither
`shared/schema.ts` nor `shared/query.ts` appears in either. The reviewer's
second resolution (keying the store by `(adapter, create)`) was therefore not
needed.

The change is a rename plus the relocation of one type and one module-level
factory: the constructor still performs exactly one `WeakMap` get per `Queries`,
nothing moved into or out of an operation, so §5.3's A/B and §5.4's allocation
figures stand un-remeasured (unverified claim 10). The item-2 falsifiers were
re-run and stay green (§11), including cell 4, which is the one that fails if
the adapter stops being a key.

### 3.2 The invariant, and what the memo may not hold

`prepareProjection` reads exactly two fields of its argument — verified by
reading every `args.` access in the function: `args.select` and `args.include`.
With both absent its answer is a pure function of the model
(`scalarFieldNames`, `state.omit`, `state.scalars`, `state.relations`) and the
adapter, it contains only `kind: "scalar"` descriptors (a `_count`, a
`_distance` or a relation needs a `select`/`include` to be named), and it is
already deeply frozen. An operation-level `omit` is desugared into `select` at
admission and therefore takes the per-operation path. The memo holds nothing
admitted, nothing a provider answered, and no alias: the test asserts there is
no `Sql` anywhere inside it.

No consumer compares a projection by identity. The one identity-sensitive
structure in the engine is `seriesQueries`'s `WeakMap<Sql, Query>`
(`operation-context.ts:1007`), which keys freshly built STATEMENTS — not
projections — and this item shares no `Sql`.

### 3.3 Falsifiers — measured

- **Cost, cumulative with item 1.** `scalar-find-unique/prepare` **16.84 → 14.49
  µs CPU/op**, `fixed-collection-rowref-20/prepare` 26.18 → 24.58,
  `fixed-collection-rowref-1000/prepare` 31.43 → 29.62, `scalar-find-unique/full`
  **28.27 → 24.23**; shipped moved +0.01…+0.29
  ([`receipts/ab/ab-item2-summary.json`](receipts/ab/ab-item2-summary.json)).
- **The ranked rows it removes.** On `scalar-find-unique/prepare` the
  `prepareProjection` allocation row **disappears** (1 815 → 0 B/op) and total
  allocation falls 22 374 → **19 305 B/op**; `lowerProjection` (2 021 → 2 095)
  and `projectedColumn` (1 156 → 1 156) are unchanged, which is correct —
  LOWERING is per operation and this item does not touch it
  ([`receipts/profile-item2/`](receipts/profile-item2/)).
- **Registered falsifier**, new file
  `tests/raptor3/g4/unit02/prepared-projection-reuse.test.ts`, 4 cells for this
  item, green ([`receipts/prepared-projection-reuse.log`](receipts/prepared-projection-reuse.log)).
  Memoising EVERY projection (`const shared = true`) turns 2 of them red,
  including *"an omit received the default projection"*
  ([`receipts/falsify/item2-memoise-everything.log`](receipts/falsify/item2-memoise-everything.log));
  dropping the adapter key turns the fourth red with *"a second adapter read the
  first one's memo"* ([`receipts/falsify/item2-drop-adapter-key.log`](receipts/falsify/item2-drop-adapter-key.log)).
  Both restored to `902b1ed235464e26f1058c7e545b9510f5fbb9a64cf8f5f4c58684e411d5cc02`.
- **Results byte-identical**: §5.5.
- **The `--trace-gc` profile moves toward the shipped engine's, partly.** See
  §5.4 — the honest reading is that allocation is now BELOW the shipped
  engine's on all three cells and the semi-space has halved on the scalar read,
  while per-scavenge cost is still 6–10× the shipped engine's.

### 3.4 The four item-2 candidates NOT memoised (review finding 4)

The brief's item 2 names six things to memoise. Two were taken (§3.1). Here are
the other four, each with what the base profile measured for it on the
candidate arm
([`receipts/profile-base/attribution.txt`](receipts/profile-base/attribution.txt),
the same ranked partition as §0.4) and the reason it stays per operation. The
profile's **floor** — the smallest row its top-30 self-time and top-30
allocation lists report for that cell — is **0.071 µs/op and 253 B/op** on
`scalar-find-unique/prepare` (20 000 ops), **0.153 µs/op and 433 B/op** on
`fixed-collection-rowref-1000/prepare` (3 000 ops) and **0.142 µs/op and
344 B/op** on `bulk-update-returning-100/prepare` (5 000 ops). "Below the
floor" below means the function appears in NO top-30 list of that cell, not
that it was not looked for.

| Candidate | Measured, candidate arm | Why it stays per operation |
| --- | --- | --- |
| `projectedColumn` (`query.ts:658` today, the profile's `:654` row) | **0.104 µs/op and 1 156 B/op** on `scalar-find-unique/prepare` (§0.4 row 3); below the floor on the other two cells | Its answer is an `Sql` naming the STATEMENT's alias, so it is a fact of the statement, not of the model. The brief offered "(model, field, alias)" as a key, but such a memo would hold a lowered `Sql`, and §4(c)'s hazard applies to it exactly: `seriesQueries` (`operation-context.ts:1007`) keys its chunk statements by `Sql` IDENTITY, so a shared fragment can silently collapse two chunks into one. Cell 3 of the new falsifier pins the opposite property — that what IS shared holds no `Sql` anywhere inside it. Lowering stays per operation, which is also why §3.3 measures `lowerProjection` and `projectedColumn` UNCHANGED across item 2. |
| `table` / `column` (`query.ts:521`, `:524` today; `:517`, `:520` at the base) | **below the floor on all three cells**, although both run on every statement of every cell | The schema half is already resolved once: `columnName` (`:530` today, `:526` at the base) delegates to `physicalField(...)`, i.e. `EngineSchema.physicalField`'s existing per-(model, field) WeakMap view — which is why no row appears. What is left is the adapter's alias-bearing spelling (`adapter.identifiers.column` / `escape` / `table`), an `Sql` naming the statement's alias: the same statement-local fact as `projectedColumn`, with the same `Sql`-identity hazard. The only `column` row in any profile is the ADAPTER's `src/adapters/shared/standard-sql.ts:251` (332 B/op scalar, 1 930 B/op rowref-1000), which this pass does not touch and which the shipped engine pays too. |
| `identityOrder` (`query.ts:2272` today, `:2235` at the base) | **below the floor**, and it IS reached by both `rowref` cells — a `take` makes the read windowed (`query.ts:2200-2203` today) | It answers a `readonly string[]` derived from `getModelKeyCatalog(model)`, which the schema already memoises per model, and it runs at most once per windowed read. A memo would save one `find` over `addressableKeys` and one `Set`-filtered `Object.keys` — under one sampled allocation row — against one more WeakMap and one more invariant to state. Rule 1 is already satisfied: the catalog is the one authority and this reads it. |
| `totalOrder` (`query.ts:2233` today, `:2196` at the base) | **below the floor**, reached by the same two `rowref` cells | Its answer is not a schema fact at all. It folds the OPERATION's requested `orderBy` terms and its `cursor` keys into the model's identity order, and each term it appends carries `this.column(model, field, alias)` — an admitted input and a statement alias in the same value. Memoising it would put an admitted input in a memo, which rule 5 forbids outright. |

So item 2's diff is exactly the two memos of §3.1, and the four rows above are
measured-and-declined, not unexamined.

## 4. Item 3 — NOT TAKEN, and why

The brief gates this item on two conditions. **Neither holds after items 1–2.**

**(a) The cell it names is no longer over budget.**
`fixed-collection-rowref-1000/prepare` measures **0.932 CPU / 1.020 wall**
(final A/B, §5.3): under parity in CPU and 2 % over in wall, inside the 5 %
budget on this instrument. The read cells still over budget are
`scalar-find-unique/prepare` (1.117 / 1.285) and
`fixed-collection-rowref-20/prepare` (1.222 / 1.175).

**(b) The profile does not attribute their residual to re-deriving structure.**
On both cells the candidate's whole `Queries.read`/projection/selector stage is
now CHEAPER than the shipped engine's equivalent, so there is no re-derivation
premium left to amortise:

| Cell | candidate `Queries.read`/projection/selector | shipped write-engine + builders + operations + result | Δ |
| --- | ---: | ---: | ---: |
| `scalar-find-unique/prepare` | 1.671 | 2.321 | **−0.650** |
| `fixed-collection-rowref-20/prepare` | 4.167 | 4.733 | **−0.566** |

What the residual IS, measured on the same profiles
([`receipts/profile-item2/`](receipts/profile-item2/)): main-thread **GC**
(+0.792 and +1.718 µs/op, 69 % and 72 % of each cell's delta), then the
candidate's own layering — `OperationContext` + `Commands` + route glue, +0.888
and +0.914 µs/op, which has no shipped counterpart and which reuse of a prepared
read does not remove — then admission (+0.100, +0.445) and the shared
`query-engine` context owner (+0.366 on the scalar read: `createTrustedExecutionContext`
reached from `pending-operation.ts:418`, the same single call per operation on
both engines, counted — §5.6).

**(c) And it would cross the brief's stop conditions anyway.** A prepared read's
lowered `Sql` binds its predicate's VALUES: `prepareOperation` stores the
admitted value inside the `PreparedPredicate` and `lowerOperation` binds it into
the statement. There is no value-free form of the predicate, so reusing a
lowered read across operations needs a second, value-free representation beside
the prepared predicate — the brief's explicit stop ("a template beside the
prepared predicate"). A second hazard is recorded rather than argued:
`seriesQueries` (`operation-context.ts:1007`) keys its chunk statements by `Sql`
IDENTITY, so a shared statement fragment would silently collapse two chunks into
one.

**Decision-elimination answer for the item not taken.** The decision "which
operation prepared this statement?" is NOT eliminated, because eliminating it
would require a second authority for the predicate — one that knows the shape
without the values — and rule 1's "one fact, one authority" costs more than the
residual is worth. The residual is reported instead (above), and it is GC and
candidate-only layering, not derivation.

## 5. Item 4 — the write cell, profile-driven — TAKEN

### 5.1 The change

`shared/query.ts`: a prepared operand is no longer frozen; the structure that
holds it is. `prepareOperation`'s `in`/`notIn` arm still freezes its operand
LIST and the predicate; `prepareOperand` returns an ordinary box.

**Why, with the measurement.** `Object.freeze` transitions a fresh object's map
on every call. On the 100 members of one `id: { in: ids₁₀₀ }`, isolated
([`receipts/micro-in-list.json`](receipts/micro-in-list.json), 20 000 reps, two
samples): **1.976 / 2.199 µs per operation frozen against 0.278 / 0.245
unfrozen** — which is `prepareOperand`'s entire measured self time on
`bulk-update-returning-100/prepare` (2.134 µs/op, §0.4 row 5). One owner builds
an operand (`Queries.prepareOperations`) and one reads it
(`Queries.lowerOperation`), both inside `shared/query.ts`; a repo-wide search of
`tests/` found **no cell that observes a prepared operand's frozen-ness**, so
the per-member freeze is a guard whose unique coverage cannot be named.

**The de-freeze is shallow, and that is now the invariant (review finding 5).**
`Object.freeze` on the enclosing predicate does not reach a member's `value`, so
a prepared operand's immutability is the predicate's and its operand list's, and
it holds only while the one builder (`Queries.prepareOperations`) and the one
reader (`Queries.lowerOperation`) both stay inside `shared/query.ts` — if a
prepared predicate is ever handed outside that file, either the per-member
freeze returns or the outside reader is read-only by construction.

Nothing else was taken on this cell. `scalarValue`'s 11 357 B/op is 100 `Sql`
fragments (`adapter.literals.value` is `sql\`${v}\``, in `src/adapters` /
`src/sql`, which this pass does not touch and which the shipped engine pays
too — 5 197 B/op at the same site); `L @ validation/primitives/helpers.ts:71` is
4 095 B/op on the candidate against 4 092 on the shipped engine, i.e. the same
admission.

### 5.2 Falsifiers — measured

- **Cost.** `bulk-update-returning-100/prepare` candidate **32.18 → 29.52 µs
  CPU/op (−2.66)** and wall 21.37 → 18.78 (−2.59) in the item-4 run, **33.00 →
  27.55 (−5.46)** and 20.73 → 17.87 in the 5-pair final; shipped −0.15 and +0.13
  ([`receipts/ab/`](receipts/ab/)). `nested-conditional-found/full` also falls
  9.52 µs CPU/op, which is the same boxes on the nested-write path.
- **The published statement and parameters are byte-identical**: §5.5.
- **Registered falsifier**: the fifth cell of
  `prepared-projection-reuse.test.ts` pins that the predicate AND its operand
  list are frozen, that the operands are the admitted list in order, and that
  the same selector lowers twice to the same statement and the same parameters.
  Unfreezing the operand list turns it red
  ([`receipts/falsify/item4-unfreeze-operand-list.log`](receipts/falsify/item4-unfreeze-operand-list.log));
  restored to `902b1ed2…`.

### 5.3 The A/B, cumulative

Instrument, trees and method: §0.1. **5 alternating fresh-process pairs** per
(cell, engine, arm), medians, SQLite (better-sqlite3 12.6.0), Node v24.21.0,
darwin/arm64, ambient desktop load. Raw samples
[`receipts/ab/ab-final.jsonl`](receipts/ab/ab-final.jsonl) (120), summary
[`receipts/ab/ab-final-summary.json`](receipts/ab/ab-final-summary.json).

| Cell | Engine | CPU µs/op before → after | wall µs/op before → after |
| --- | --- | --- | --- |
| `scalar-find-unique/prepare` | shipped | 11.79 → 11.85 (+0.07) | 5.22 → 5.20 |
| | **candidate** | **16.06 → 13.24 (−2.82)** | **8.25 → 6.68 (−1.57)** |
| `fixed-collection-rowref-20/prepare` | shipped | 18.81 → 18.75 (−0.06) | 10.07 → 10.07 |
| | **candidate** | **24.03 → 22.92 (−1.11)** | **12.51 → 11.83 (−0.67)** |
| `fixed-collection-rowref-1000/prepare` | shipped | 28.09 → 27.54 (−0.55) | 13.17 → 13.00 |
| | **candidate** | **28.23 → 25.68 (−2.55)** | **14.07 → 13.26 (−0.81)** |
| `bulk-update-returning-100/prepare` | shipped | 24.42 → 24.55 (+0.13) | 16.91 → 17.03 |
| | **candidate** | **33.00 → 27.55 (−5.46)** | **20.73 → 17.87 (−2.86)** |
| `nested-conditional-found/full` | shipped | 181.34 → 179.90 (−1.44) | 117.43 → 117.94 |
| | **candidate** | **130.90 → 125.45 (−5.45)** | **93.12 → 90.60 (−2.53)** |
| `scalar-find-unique/full` | shipped | 27.55 → 27.80 (+0.25) | 17.64 → 17.74 |
| | **candidate** | **25.74 → 22.01 (−3.73)** | **17.05 → 15.19 (−1.86)** |

Ratios (candidate ÷ shipped), before → after:

| Cell | CPU | wall |
| --- | --- | --- |
| `scalar-find-unique/prepare` | 1.363 → **1.117** | 1.581 → **1.285** |
| `fixed-collection-rowref-20/prepare` | 1.277 → **1.222** | 1.241 → **1.175** |
| `fixed-collection-rowref-1000/prepare` | 1.005 → **0.932** | 1.068 → **1.020** |
| `bulk-update-returning-100/prepare` | 1.351 → **1.122** | 1.226 → **1.050** |
| `nested-conditional-found/full` | 0.722 → **0.697** | 0.793 → **0.768** |
| `scalar-find-unique/full` | 0.934 → **0.792** | 0.967 → **0.856** |

Per item, cumulative, candidate CPU µs/op (each row is its own alternating
schedule, so the `before` column drifts with ambient load; the DELTA is the
measurement):

| Cell | item 1 | items 1+2 | items 1+2+4 | final (5 pairs) |
| --- | ---: | ---: | ---: | ---: |
| `scalar-find-unique/prepare` | −1.96 | −2.36 | −2.43 | −2.82 |
| `fixed-collection-rowref-20/prepare` | −1.01 | −1.60 | −1.59 | −1.11 |
| `fixed-collection-rowref-1000/prepare` | −2.43 | −1.81 | −2.19 | −2.55 |
| `bulk-update-returning-100/prepare` | −0.83 | −0.58 | **−2.66** | **−5.46** |
| `nested-conditional-found/full` | −1.10 | −1.38 | **−9.52** | −5.45 |
| `scalar-find-unique/full` | −0.63 | **−4.04** | −3.86 | −3.73 |

### 5.4 Allocation and GC, base → final (candidate)

| Cell | alloc B/op | GC µs/op | steady semi-space | steady scavenge |
| --- | --- | --- | --- | --- |
| `scalar-find-unique/prepare` | 23 995 → **19 312** (shipped 24 642) | 2.376 → 1.855 / 1.902 (shipped 0.811) | 173.9 → 94.1 / 90.6 MB (shipped 37.0) | 2.75 → 1.92 ms (shipped 0.17) |
| `fixed-collection-rowref-1000/prepare` | 38 699 → **36 821** (shipped 47 712) | 4.707 → 3.79 / 4.19 (shipped 2.413) | 53.5 → 53.0 MB (shipped 36.5) | 1.17 → 0.67 / 0.71 ms (shipped 0.17) |
| `bulk-update-returning-100/prepare` | 55 149 → **53 354** (shipped 64 012) | 4.848 → 4.114 / 4.238 (shipped 1.834) | 92.0 → 92.7 MB (shipped 35.2) | 1.12 → 1.08 / 1.12 ms (shipped 0.12) |

Two `--trace-gc` samples per cell on the final tree, because one run is noisy.
The honest reading: **allocation is now below the shipped engine's on all three
cells** and the scalar read's semi-space has nearly halved, but per-scavenge
cost is still 6–10× the shipped engine's. Cause 2 is reduced, not closed, and
what is left of it is object LIFETIME inside one operation, which neither item
here addresses.

### 5.5 No behaviour change — measured, not asserted

The same instrument, run on BOTH trees and BOTH engines, dumping what each cell
publishes at the package seam (statement text, parameters, and the harness's own
per-operation check value for four operations):

**16 of 16 dumps byte-identical** between `ff5e77ca` and this pass — 8 cells
(`scalar-find-unique/prepare`, `fixed-collection-rowref-20/prepare`,
`fixed-collection-rowref-1000/prepare`, `bulk-update-returning-100/prepare`,
`scalar-find-unique/full`, `nested-conditional-found/full`,
`flat-scalar-update/full`, `relation-series-2/full`) × 2 engines
([`receipts/publish/compare.txt`](receipts/publish/compare.txt), dumps beside
it). The harness's own `assertSemanticDigest` and `observeBenchmarkContract`
ran on every one.

### 5.6 One thing measured and not explained

`createTrustedExecutionContext` (`src/drivers/execution-context.ts:218`) is
0.927 µs/op of self time on the candidate against 0.513 on the shipped engine
for `scalar-find-unique/prepare`, although the caller chain is identical and
outside the candidate (`client.ts` → `query-engine.ts:152` →
`pending-operation.ts:418` → `query-engine/execution-context.ts:46`) and both
engines cross the driver seam **exactly once** per prepared operation — counted
from outside with a driver wrapper, `_prepare: 1, _execute: 0, _executeBatch: 0,
withTransaction: 0` on both engines on all three cells
([`receipts/instruments/count-driver.mjs`](receipts/instruments/count-driver.mjs)).
It is outside this pass's files and is recorded as measured-but-unexplained.

---

## 6. Checks

One mode per Bash call, each through the bounded runner; logs under
[`receipts/`](receipts/). Docker ports read with `docker port`: PostgreSQL
**55729**, MySQL **55730** (`VIBORM_RAPTOR3_PROVIDER` / `…_PROVIDER_PORT`).

| Mode | Result | Wall / peak RSS |
| --- | --- | --- |
| `g4-unit02-author` | **131 passed** (20 files) | 6.15 s / 783.8 MiB |
| `g4-unit02-mysql-contracts` (55730) | **17 passed** (3 files) | 5.21 s / 670.9 MiB |
| `g4-unit02-pg-contracts` (55729) | **1 passed** | 3.60 s / 511.7 MiB |
| `g4-read-contracts` | **62 passed** (8 files) | 4.84 s / 718.2 MiB |
| `g4-route-lifecycle` | **8 passed** | 4.45 s / 532.1 MiB |
| `g4-route-admission` | **7 passed** | 4.26 s / 521.8 MiB |
| `g4-route-cache` | **7 passed** | 3.91 s / 531.5 MiB |
| `g4-route-transactions` | **13 passed** | 3.90 s / 543.3 MiB |
| `g4-lifecycle-events` | **3 passed** | 3.85 s / 543.5 MiB |
| `g4-lifecycle-admission` | **4 passed** | 3.72 s / 519.1 MiB |
| `g3-execution-review` | **6 passed** | 3.70 s / 535.3 MiB |
| `g3-bulk-series` | **6 passed** | 3.71 s / 534.5 MiB |
| `g3-transaction-array` | **4 passed** | 3.73 s / 534.0 MiB |
| `g3-suppression-retry` | **2 passed** | 3.72 s / 525.8 MiB |
| `g2-contracts` | **216 passed** (16 files) | 6.37 s / 834.1 MiB |
| `g2-generated` | **52 passed** (2 files) | 4.43 s / 768.5 MiB |
| `g1-transport` | **44 passed** | 4.13 s / 729.0 MiB |
| `g2-transport` | **16 passed** | 3.96 s / 738.9 MiB |
| `g3-generated-transport-smoke` | **1 passed** | 3.62 s / 573.0 MiB |
| `g29-result-progress` | **2 passed** | 3.46 s / 521.0 MiB |
| `g2-mysql-contracts` (55730) | **13 passed** (4 files) | 4.30 s / 671.5 MiB |
| `g2-mysql-baseline` (55730) | **13 passed** (4 files) | 3.94 s / 646.2 MiB |
| `g2-pg-contracts` (55729) | **18 passed** (6 files) | 4.54 s / 680.5 MiB |
| `node scripts/run-typecheck.mjs` | **RED in round 1** — the two permitted `pattern/pack.ts` TS2345 diagnostics **and a third**: `TS2459` at `tests/raptor3/g4/unit02/prepared-projection-reuse.test.ts:32`, the new test file importing the non-exported `PreparedPredicate`. The row above originally claimed the opposite of its own receipt; review finding 1 caught it. Fixed and re-run green in round 2 (§11). | 6.04 s / 5 796.2 MiB |

Run in addition, because this pass could have moved them:

| Mode / file | Result |
| --- | --- |
| `post-g3-projection-preparation` | **4 passed** (the `q0`/`q1` counter pins and the "no SQL in a prepared projection" cells) |
| `post-g3-selector-preparation` | **4 passed** |
| `post-g3-schema-views` | **1 passed** (the `EngineSchema` view-reuse pins, beside which `queryViews` now lives) |
| `tests/raptor3/g4/unit02/prepared-projection-reuse.test.ts` | **5 passed** (this pass's new falsifier, run directly) |

**Frozen fast-path counts did not move.** They are pinned by
`physical-envelope.test.ts` (10 cells), `root-delete.test.ts` (6),
`root-member-cut-trace.test.ts` (4), `malformed-result-cuts.test.ts` (4),
`lone-statement-transport.test.ts` (7) and `packaged-array.test.ts` (5) — all
inside `g4-unit02-author`, all green, and no statement or transaction count in
them changed. The package-seam dumps of §5.5 carry the same
`statementCount` on both trees for every measured cell.

**Cell counts, for the integrator (no manifest edit was made).**

| Suite / file | Registered count | Actual now |
| --- | --- | --- |
| `g4-unit02-author` | 131 over 20 files | **131 over 20 files — unchanged, green, gate verified** |
| `tests/raptor3/g4/unit02/prepared-projection-reuse.test.ts` | **not registered** | **5** — request: add `"tests/raptor3/g4/unit02/prepared-projection-reuse.test.ts": 5` to `G4_UNIT02_AUTHOR_COUNTS` (`scripts/raptor3-manifest.mjs:589-609`), which moves the lane total to **136 over 21 files**. Until then the lane does not reach it (it runs exactly its registered files) and it was run directly here. |

## 7. Plan §7's four questions, against the actual diff

1. **What decision does this diff eliminate?** Three. *Whether an operation has
   already paid for write machinery it may never use* — it never pays until an
   owner needs it, so a read allocates no attempt, no committed-member set, no
   member attribution, no continuations, no prepared guards, no answered-failure
   set and no correlation id. *Which operation prepared this model's default
   projection, and which operation's leaf this is* — neither is a fact of an
   operation; both are facts of the model and the dialect, resolved once.
   *Whether each prepared operand is independently immutable* — immutability is
   a fact of the prepared predicate and its operand list, stated once per
   predicate instead of once per member.
2. **What replaces it?** One invariant each. An absent collection is empty for
   every reader and a materialised one is created by its accessor before any
   writer can observe it. A projection that names neither `select` nor `include`
   is a pure function of (adapter, model) — admission having desugared `omit`
   into `select` — and is deeply frozen and alias-free, so sharing it is
   indistinguishable from rebuilding it. An operand is built by one owner and
   read by one owner, both in `shared/query.ts`, inside a frozen predicate.
3. **Who else had to change?** Nobody's semantics. One new `EngineSchema`
   accessor (`queryViews`), the `TransportAttempt` record/probe/drain
   accessors, and the readers of the eight lazy fields. No public contract, no
   refusal sentence, no `meta`, no statement text, no parameter, no statement or
   transaction count — measured byte for byte in §5.5.
4. **What would falsify it?** Stated and measured per item in §§2.3, 3.3, 5.2,
   each one run and each one seen to fail when the invariant is broken
   ([`receipts/falsify/`](receipts/falsify/)), and the item NOT taken carries its
   own answer in §4.

## 8. Cost

Candidate core (13 files under `src/query-engine/raptor3/` excluding the
retained `program/` specimen), same `countTokenLines` census as
`scripts/query-engine-structure.mjs`, bytes / physical / token-lines
([`receipts/cost.json`](receipts/cost.json)):

| | before (`ff5e77ca`) | after |
| --- | --- | --- |
| `shared/operation-context.ts` | 85,925 / 2,262 / 1,898 | 87,903 / 2,309 / 1,919 |
| `shared/query.ts` | 141,465 / 3,971 / 3,572 | 143,816 / 4,024 / 3,592 |
| `shared/schema.ts` | 19,845 / 538 / 411 | 22,459 / 595 / 433 |
| `shared/transport-attempt.ts` | 689 / 19 / 16 | 2,789 / 63 / 41 |
| **candidate core (13 files)** | **399,165 / 11,119 / 9,796** | **408,208 / 11,320 / 9,884** |
| core + retained specimen (15) | 419,897 / 11,757 / 10,422 | 428,940 / 11,958 / 10,510 |

**+88 charged token-lines** (+9,043 bytes, +201 physical), re-measured after
round 2. The bytes are mostly docblocks stating the three new invariants; the
largest single row is `transport-attempt.ts` (+25 token-lines) where three eager
collections became three record accessors, one probe and three drains — the
price of rule 7 in that file, paid so that every read stops allocating two
`Map`s and a `Set`. Round 2 added **+6** over round 1's +82: naming the view
accessor (§3.1) moved `QueryViews` and `createQueryViews` from `query.ts`
(−7 token-lines) into `schema.ts` (+13, the two type-only imports and the
un-cast `WeakMap` declaration spread over three lines).

Whole `src/query-engine/**` (`node scripts/query-engine-structure.mjs`, run in a
clean `ff5e77ca` archive and in the main tree): files 181 → 181, physical lines
86,728 → 86,929, token-lines **68,628 → 68,716 (+88)**, functions 3,854 → 3,862,
branch nodes 8,986 → 8,995, runtime import-cycle components 2 → 2, runtime files
in cycles 14 → 14, files over 300 lines 76 → 76, files over 600 lines 33 → 33.
The two cycle components are the base's own — the shipped `builders/` twelve and
`raptor3/commands/commands.ts` ↔ `execution.ts` — and this pass adds no file to
either (§3.1).
Receipts: [`receipts/query-engine-structure-before.json`](receipts/query-engine-structure-before.json),
[`receipts/query-engine-structure-after.json`](receipts/query-engine-structure-after.json).

## 9. Files, patch, identity

**Files this pass edited** — the complete diff over `ff5e77ca` is
[`perf-pass-2.patch`](perf-pass-2.patch)
(`f06538ab85c9ec272d6c8da7da14d5c136c35050565d12477b2c46683da88227`, 996 lines,
**5 files**, each section with a proper `diff --git` header; regenerated after
round 2), verified by `git apply --check`, then `git apply`, onto a fresh
`git archive ff5e77ca` and `cmp`-ing every path: **5 of 5 reproduced
byte-identically**. (Round 1's patch was
`dcbac090337dd306084f609720c2852c11addcf52d379694f469c70ec48a4cd9`, 957 lines.)

| File | Item |
| --- | --- |
| `src/query-engine/raptor3/shared/operation-context.ts` | 1 |
| `src/query-engine/raptor3/shared/transport-attempt.ts` | 1 |
| `src/query-engine/raptor3/shared/schema.ts` | 2 (`queryViews`, `QueryViews`) |
| `src/query-engine/raptor3/shared/query.ts` | 2, 4 |
| `tests/raptor3/g4/unit02/prepared-projection-reuse.test.ts` (new, 5 cells) | 2, 4 |

Nothing else was touched. No commit, no staging, no reset, no stash, no delete;
`benchmarks/**` unchanged; the shipped engine unchanged; the unrelated dirty
files (`CONTEXT.md`, `memory.md`, `tests/pattern/**`, the evidence archives)
untouched.

**Typecheck: `node scripts/run-typecheck.mjs` reports the two permitted
`pattern/pack.ts` TS2345 diagnostics and nothing else**
([`receipts/typecheck.log`](receipts/typecheck.log), 9.24 s / 5 823.0 MiB). This
is the ROUND 2 state; round 1's run of the same command carried a third
diagnostic and this note claimed otherwise — see §6 and §11.

**Biome: no `--write` was run on any file, and no new rule fires.** `biome lint`
over the four production files reports the SAME 19 diagnostics before and after,
re-run after round 2 — 9 `style/noParameterProperties`,
4 `complexity/useSimplifiedLogicExpression`,
3 `correctness/noUnusedFunctionParameters`, 2 `style/useDefaultSwitchClause`,
1 `correctness/noUnusedVariables`, every one of them pre-existing at `ff5e77ca`
(they sit 14 in `query.ts`, 4 in `operation-context.ts` and 1 in `schema.ts` —
the last being the `EngineSchema` constructor's parameter property, which
`ff5e77ca` reports too) — and the new test file reports **none**. The
formatter's "contents aren't fixed" is the standing state of these paths on
both sides (the existing
`prepared-statement-stability.test.ts`, `prepared-operation.test.ts` and
`post-prep/schema-view-reuse.test.ts` report it too).

**Identity after the last edit** (`captureRaptor3Identity`,
[`receipts/identity-after.json`](receipts/identity-after.json), re-captured
after round 2's last source edit):

- production `312cde34932cdb4d70ccad60bb002d0c0a438865bd18e165c38b4a572ebff640`
- harness `0304ea197145bf89796a041d7996e3598befff22eafb5f08481bd27a2340f303`
  — the harness fingerprint covers `tests/raptor3/**`, and the reviewer's
  untracked probes under `tests/raptor3/g4/review/perf2/` are in the tree and
  are counted by it. With those five files excluded the same fingerprint is
  `9b4b52d12692e271a2cb629b7dffdbd95e4a4712cde7c0b6f01b49d83715f8cd`, which is
  built exactly as `perf2-review.md` §3.5's parked-probe capture was. It
  necessarily DIFFERS from the review's `7562c23f…`, because round 2 edits the
  new test file; it is quoted so the two numbers can be compared like for like.
- runtime: node v24.21.0, darwin/arm64, better-sqlite3 12.6.0, vitest 3.1.4

Round 1's identity was production
`3edf66d242d39e1921834360909d2a9c12f31ead9a39bb2f4d85c5cc0762a4cc` and harness
`7562c23fcfd81da87a5e0d70937b2902757313671526797918985a62bd162e54`; both move
because round 2 edits `schema.ts`, `query.ts` and the new test file.

## 10. Blockers and unverified claims

**Blockers: none.** No stop rule was reached; nothing needed a public-contract
change, a legacy fallback or duplicated semantic interpretation. Item 3 is not
taken, which is a decision recorded against the brief's own condition (§4), not
a blocker.

**Unverified claims.**

1. The A/B is attribution, not a verdict: 5 alternating fresh-process pairs per
   arm under ambient desktop load, SQLite only, not the frozen 20-cell protocol
   with its MAD-based `E`. No §7 cell is declared passed or failed here. The
   ratios this instrument reports for the frozen cells are LOWER than the frozen
   identity-3 series' (e.g. `scalar-find-unique/prepare` 1.363 here against
   1.454 there, before any change), so the improvements must be read as deltas,
   not as frozen-series ratios.
2. The candidate arm is `createCandidateClient` over the same fixture, not the
   cutover tree's default route — pass 1's unverified claim 2, unchanged.
3. The item-2 memo is keyed by the adapter OBJECT and the model OBJECT. Two
   clients that share those objects share the memo, which is intended and
   pinned; two clients built from a schema-equal but distinct model do not, and
   that is asserted only for a distinct ADAPTER (cell 4), not for a distinct
   model object.
4. The `--trace-gc` figures are two samples per cell on one machine under
   ambient load; the semi-space and per-scavenge numbers move by 20–40 % between
   samples. The claims drawn from them are the ORDERING and the allocation
   bytes/op, which are stable.
5. Allocation figures are V8 `HeapProfiler` sampling at a 128 B interval, i.e.
   extrapolations — the diagnosis's unverified claim 6, unchanged.
6. `createTrustedExecutionContext`'s 1.8× self time on the candidate (§5.6) is
   measured and NOT explained. Both engines cross the driver seam once per
   prepared operation, counted.
7. The item-4 claim that no consumer mutates a prepared operand is established
   by reading the two owners in `shared/query.ts` and by a repo-wide search that
   found no cell observing a prepared operand's frozen-ness — not by a runtime
   mutation detector.
8. `relation-series-2`'s cross-engine divergence, the two `flat-scalar-update`
   cells recorded as not measurable comparably, and peak RSS were not
   re-examined. This pass changes nothing about them; the `relation-series-2`
   package-seam dump is byte-identical on both trees and both engines (§5.5).
9. PostgreSQL and MySQL were exercised for CONTRACTS (four registered native
   modes, all green); no performance number here is from a native provider.
10. **Round 2 was not re-measured.** Naming the view accessor (§3.1) is a
   rename plus the relocation of one type and one module-level factory; the
   constructor still performs one `WeakMap` get per `Queries` and no
   per-operation work moved, so every A/B, allocation, GC and package-seam
   figure above is round 1's, carried forward by reading the diff rather than
   by re-running the instrument. The claim that round 2 is performance-neutral
   is therefore reasoned, not measured. What WAS re-run in round 2 is the
   typecheck, six registered modes plus the new file run directly, Biome, the
   cost census, the patch verification and the identity capture (§11).
11. Round 2 did not re-run the sixteen package-seam dumps of §5.5, the four
   native provider modes, or the registered modes of §6 outside the six in
   §11.6's table. Nothing in round 2's diff reaches a provider, a statement or
   a published value.

---

## 11. Round 2 — the review's resolutions, applied

Input: [`../perf2-review.md`](../perf2-review.md) (outcome **REVISE**), whose
§6 lists five actions. All five are applied below and nothing else was changed;
no production behaviour moved.

### 11.1 Finding 1 (must-fix) — the whole-estate typecheck was red

The new test file imported a type the owner does not export:

```
tests/raptor3/g4/unit02/prepared-projection-reuse.test.ts(32,8): error TS2459:
  Module '"@query-engine/raptor3/shared/query"' declares 'PreparedPredicate'
  locally, but it is not exported.
```

It was in round 1's own `receipts/typecheck.log` as the third line, and §6 of
this note recorded the opposite. `common.md` permits exactly two diagnostics;
this one was neither fixed nor reported. §6's row now states what that run
actually said.

The reviewer's resolution is applied verbatim, and it touches no production
file: the import became `import { Queries } from "@query-engine/raptor3/shared/query";`
and the type is derived locally, immediately above `findIn`, from the one owner
that publishes it:

```ts
/** The prepared predicate type, read from the one owner that publishes it. */
type PreparedPredicate = NonNullable<
  ReturnType<Queries["prepareSelector"]>["predicate"]
>;
```

`PreparedSelector.predicate` is the one exported surface that names the prepared
predicate, so nothing new is exported and there is no second declaration of the
type. `node scripts/run-typecheck.mjs` now reports **only** the two historical
`src/query-engine/pattern/pack.ts` TS2345 diagnostics
([`receipts/typecheck.log`](receipts/typecheck.log), re-captured as the review
instructs — round 1's red content is quoted verbatim in the review's finding 1).

### 11.2 Finding 2 (note) — `receipts/cost.json` declared the wrong base

`"base"` said `0f25637b`, the commit BEFORE this pass's base, while the figures
were `ff5e77ca`'s. It is now `"base": "ff5e77ca"`, in the receipt and in the
instrument that writes it
([`receipts/instruments/cost.mjs`](receipts/instruments/cost.mjs), whose
`before` column is `git show HEAD:…` and whose HEAD is `ff5e77ca`), so a re-run
reproduces the corrected label. The census was re-run for round 2; §8 carries
the new figures.

### 11.3 Finding 3 (note) — the view accessor is named for its one fact

The reviewer's FIRST resolution was taken. §3.1 records the change, why the
runtime import cycle the alternative would have avoided does not arise (both new
imports in `schema.ts` are `import type`, and the re-run census still reports 2
components over 14 files, neither of them containing `shared/schema.ts` or
`shared/query.ts`), and that the memo's content constraints are unchanged —
`QueryViews` holds the same two WeakMaps, keyed by the same adapter and model
objects, with nothing admitted and nothing observed. The item-2 falsifiers stay
green, including the adapter-key cell.

### 11.4 Finding 4 (note) — the four untaken item-2 candidates

§3.4 is new: `projectedColumn`, `table`/`column`, `identityOrder` and
`totalOrder`, each with its measured µs/op and B/op from
[`receipts/profile-base/`](receipts/profile-base/) — or "below the floor", with
that cell's floor stated — and the reason it is not memoised.

### 11.5 Finding 5 (note) — the shallow de-freeze, written down

Recorded as one sentence in §5.1: a prepared operand's immutability is now the
enclosing predicate's and its operand list's, and it holds only while the one
builder and the one reader both stay inside `shared/query.ts`.

### 11.6 Checks re-run in round 2

One mode per Bash call, through the bounded runners; logs under
[`receipts/`](receipts/).

| Check | Result | Wall / peak RSS |
| --- | --- | --- |
| `node scripts/run-typecheck.mjs` | **only the two permitted `pattern/pack.ts` TS2345 diagnostics** | 9.24 s / 5 823.0 MiB |
| `tests/raptor3/g4/unit02/prepared-projection-reuse.test.ts` (direct) | **5 passed** (1 file) | 3.38 s / 471.1 MiB |
| `g4-unit02-author` | **131 passed** (20 files) — unchanged, gate verified | 6.22 s / 779.4 MiB |
| `post-g3-projection-preparation` | **4 passed** | 3.73 s / 500.5 MiB |
| `g2-contracts` | **216 passed** (16 files) | 7.15 s / 842.9 MiB |
| `g4-route-cache` | **7 passed** | 4.24 s / 543.0 MiB |
| `g4-read-contracts` | **62 passed** (8 files) | 5.15 s / 735.5 MiB |
| `post-g3-schema-views` | **1 passed** — run because round 2 edits `EngineSchema` | 2.99 s / 434.0 MiB |

`g4-unit02-author` still runs exactly its 20 registered files: the new file is
still unregistered and the integrator's single action is unchanged (§6's cell
count table). Also re-run: `biome lint` over the pass's five files (the same 19
pre-existing diagnostics, none in the new test file), the cost census (§8), the
patch (§9, `git apply --check` then `git apply` onto a fresh `ff5e77ca` archive,
5 of 5 paths byte-identical) and the identity capture (§9).

### 11.7 What round 2 did not do

No commit, no staging, no reset, no stash, no delete. `scripts/raptor3-manifest.mjs`,
`benchmarks/**`, the shipped engine and the unrelated dirty files (`CONTEXT.md`,
`memory.md`, `tests/pattern/pack/program-dump.ts`, `g4.md`) were not touched,
and neither were the reviewer's untracked probes under
`tests/raptor3/g4/review/perf2/`. No Biome `--write` was run. No performance
instrument was re-run — see unverified claim 10.
