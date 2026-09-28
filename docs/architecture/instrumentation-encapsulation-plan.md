# Instrumentation encapsulation plan

Status: plan, not started. Measured at `cf4ba97a6` (origin/main, 2026-09-28); this document changes no production
source. Every number is labelled **measured** (a build or count at `cf4ba97a6` or on a scratch tree derived from it),
**estimate** (derived from measurements, method stated) or **judgement** (a reading of the code). Revised after
review: the seam was re-costed, the headline fell from −7.5 KB to −4.7 KB, and the unit order changed (§2, §4).

## 1. Status and objective

`instrumentation()` is nominally an extension, but core builds its presentation: span names, attributes, log events,
level checks, `ignoreSpanTypes`, SQL/params disclosure per channel, and cache log buffering.
`src/instrumentation/extension.ts` makes no presentation decision. It passes to the tracer and logger the
`facts.spanOptions` and log events built by core (`driver-instrumentation.ts:692-755`,
`query-engine/execution-context.ts:117-166`, `cache-instrumentation.ts:134-228`). Much of that code is class methods
of `Driver` and `CacheDriver`, which tree-shaking never removes, so every client bundle pays for it.

**Objective.** The fixed-name extension owns all presentation. Core keeps one minimal seam (§3.1), and a client
without the extension carries that seam and nothing else. The owner's metric, in order: bundle output
(pg-representative raw, then gzip), then production code lines (comments excluded).

## 2. Measured today

**Census** (measured, `accounting.cjs` scanner rule): 2,631 classified code lines in 23 files outside
`src/instrumentation/`.

| class | lines | fate |
|---|---|---|
| seam:public — the public `observe` rail (`ObserveHandler`) | 1,093 | stays (public API) |
| seam:official — trusted registry, unit-keyed WeakMap facts, prewarm, dispatch gates, fixed-name admission | 473 | stays, reshaped to neutral facts |
| seam:error-policy — pre-dispatch parameter snapshot, thrown-error disclosure | 119 | stays (error authority) |
| seam:chain 27 · seam:lineage 3 · warning-routing 10 | 40 | stays |
| **presentation** | **680** | **leaves core** (≈20 of them, the statement log decision, stay: §3.4) |
| **carrier** — `engine.instrumentation`, trusted-context `instrumentation` | **42** | **deleted**: derivable from the chain (`query-engine.ts:70-71`) |
| types-only 179 · dead 5 (`segment` unit kind) | 184 | 0 B |

`src/instrumentation/` itself is 1,570 code lines (measured). Nothing imports its `perf-tracker.ts` (199 lines)
except the internal barrel `index.ts:26-34` (judgement, from grep).

**Attribution** (measured; esbuild metafile `bytesInOutput`, pg-representative bundled from `src/`; the src bundle is
0.2% larger than the dist bundle, and deltas are scaled by E2b's dist/src ratio 10,438 / 10,586 = 0.986 where a dist
figure is needed). Raw bytes removed between E0 and E2b, by file:
`driver-instrumentation.ts` 4,028 of 8,103 · `cache-instrumentation.ts` 1,785 (all) · `cache/driver.ts` 1,653 of
6,076 · `query-engine/execution-context.ts` 843 of 1,425 · `spans.ts` 432 · `driver-transaction-base.ts` 380 ·
`tracer.ts` 337 · `driver-diagnostics.ts` 216 · `pending-operation.ts` 177 · `logger.ts` 154 · `logged-errors.ts` 114
· `drivers/execution-context.ts` 111 · `extension.ts` 94 · `raw.ts` 71 · `driver.ts` 62 · `errors/diagnostics.ts` 44 ·
`cache-flow.ts` 39 · `client.ts` 22 · `driver-error-context.ts` 16 · `query-engine.ts` 8 · **sum 10,586**.

The extension's factory, context, OTel loader and logger are already tree-shaken when it is not installed, so **the
leak is core code**. Cache presentation reaches every pg bundle through `extensions/chain.ts:1-6` →
`@cache/extension`, even when the cache extension is not installed.

**Ceilings** (measured). Method: scratch trees from `git archive HEAD`, stubbed by exact replacements with asserted
match counts, built with tsdown and measured with `scripts/measure-bundle.mjs`; tsc and a better-sqlite3 smoke run
pass in every tree. Baseline pg-representative: 549,118 raw / 161,401 gzip.

| experiment | removed (cumulative) | pg-rep Δ raw / gzip | code lines Δ |
|---|---|---|---|
| presentation-bodies stub | presentation *bodies* only; call sites, gates, carrier kept | −5,594 / −1,637 (measured on the src bundle, applied as a delta) | — |
| E1 | `src/instrumentation/*` bodies | −512 / −199 | (extension) |
| E2 | E1 + core presentation, driver gates, diagnostics disclosure | −10,316 / −3,059 | −1,751 |
| E2b | E2 + carrier | −10,438 / −2,995 | −1,762 |
| E3 | E2b + privileged trusted-observer rail | −12,382 / −3,697 | −2,019 |
| E4 | E3 + orphans | −12,676 / −3,807 | −2,373 (1,295 core) |

The presentation-bodies stub is **not a floor for this design**: it carries no neutral fact producers, and this
design adds ≈3.1 KB of them (table below). It is kept as a reference only.

What else the ceiling runs show (all measured):

- sqlite3-representative moves by the same raw bytes.
- s-only, ids-only and decimal-only move by −4 B in every experiment. Schema-only bundles carry no instrumentation,
  so this plan cannot move them.
- Installing the extension adds +9,109 raw / +2,784 gzip today (pg-instrumented 558,221, from the scratch fixture
  script that U0 commits).
- Gzip deltas under ±200 B are noise.

**Seam that must survive** (it was stubbed in E2b, so it is added back to E2b):

| seam piece | raw bytes | label and method |
|---|---|---|
| deferred handoff, `driver-instrumentation.ts:160-216` | 431 | measured: esbuild-minified HEAD snippet |
| gate builders, `:607-690` | ≤1,206 | measured, same method; upper bound, it still holds presentation lines |
| gate arms | ≈460 | measured, per-file attribution |
| error policy: `getErrorDisclosure`, `getDiagnosticParameters`, `getBatchDiagnosticParameters`, capability-based `canDiscloseParameters` | 493 (gzip 120) | measured: restored on an E2b tree, pg-representative bundle delta |
| chain→capability map and the logged-error `WeakSet` | 196 (gzip 74) | measured: restored on that tree, bundle delta |
| statement completion tail: log context, level decision, de-dup mark, `endedAt` (§3.4) | 598 | estimate: esbuild-minified prototype snippet |
| lifecycle record and `readDriverIdentity` | 275 | estimate: prototype snippet |
| cache outcome recorder: one list per execution, `completed` flag, set-failure placement | 685 | estimate: prototype snippet |
| cache unit facts (get/set/invalidate/revalidate) | 347 | estimate: prototype snippet |
| trusted-only selector and the delete/clear call (§3.5) | 418 | estimate: prototype snippet |
| operation facts | 531 | estimate: prototype snippet |
| `wants` call sites (7) | ≈200 | estimate: prototype snippet, ≈30 B per site |
| `warn` call site (replaces the logger route in `operation-context.ts:234-254`) | ≈0 | judgement |
| **total** | **≈5,840** | 2,786 measured + ≈3,050 prototype |

**Expected outcome (estimate): about −4.7 KB raw / −1.3 KB gzip (≈ −0.85%) on pg-representative.**

- Method: the E0→E2b attribution (10,586, measured) minus the seam (≈5,840), scaled to dist by 0.986 = 4,678 raw.
  Gzip is scaled by E2b's measured gzip/raw ratio of 0.287. The sum of the unit estimates in §4 is the same number.
- Bracket, raw: from −3.9 KB ((10,586 − 2,786 − 1.25 × 3,056) × 0.986 = 3,924: prototype rows 25% larger than
  their snippets) to −7.7 KB ((10,586 − 2,786) × 0.986 = 7,691: prototype rows cost nothing). The upper end is close
  to the previous version's headline (−7.5 KB), which omitted the prototype rows.
- With the extension installed, the moved bytes reappear in it, so pg-instrumented and `full` should stay about
  neutral (judgement).

## 3. Target design

### 3.1 The seam (named modules)

| module | keeps | loses |
|---|---|---|
| `extensions/observation.ts` | Public units and completions, unchanged. The trusted registry, unit-keyed private facts, prewarm and the downstream-only bridge. **Gains** the chain→capability WeakMap, relocated from `instrumentation/extension.ts:31-74`, and `selectTrustedObservers` (§3.5). | fact types from `@instrumentation/lifecycle-facts` |
| `extensions/official-facts.ts` (new; types only, 0 B, never re-exported) | The neutral fact contract (§3.2) and `OfficialObservationCapability`. | — |
| `extensions/chain.ts` | Fixed-name admission (`:299-311`). **Gains** `OFFICIAL_INSTRUMENTATION_NAME`, which `instrumentation/extension.ts` then imports from core. Per-chain registration (`:369-372`), now into the core map. The `observesLifecycle` filter (`:205-208`). | every `@instrumentation` runtime import |
| `drivers/driver-instrumentation.ts` | The deferred handoff (`:160-216`), carrying a neutral record instead of `spanOptions`. Gate builders without presentation. `hasTrustedObservers`, deferred transforms, `observeTrusted*`. The parameter snapshot and thrown-error disclosure (`:792-817`, `canDiscloseParameters` `:950-972` re-pointed at `wants`, `getErrorDisclosure` `:990-996`). The statement log decision and de-dup mark (`:713-735`, §3.4). | `:7,26-40,50-51,423-444,517,531-532,615-622,636,647-651,683-686,692-711,736,739-754,944-948,974-988,998-1016` |
| `drivers/driver-identity.ts` (new, not exported by any entry) | `readDriverIdentity(driver)`: a frozen `{dialect, driverName, namespace?}` read from the public readonly fields; the one `adapter.namespace` read. | — |
| `drivers/execution-context.ts` | The chain on trusted contexts. | the carrier (19 lines) |
| `cache/driver.ts` | Cache units and failure capture. **Gains** neutral outcome records at the decision points (`:277-402`). | log emission, span names and attributes, the direct tracer path, `getBaseAttributes` (D1) |
| `raptor3/shared/operation-context.ts` | The once-per-lineage warning decision and the `console.warn` fallback (`:234-254`). | the logger event shape |
| `errors/logged-errors.ts` (moved from `src/instrumentation/`) | `markErrorLogged`, `isErrorLogged`, `transferLoggedErrorEvidence`, unchanged. | — |

Core reads one capability record with two methods; it is not a hook framework:

```ts
interface OfficialObservationCapability {
  readonly observesLifecycle: boolean;               // exists today
  readonly prewarm?: () => void | Promise<void>;     // exists today
  readonly diagnostics: DiagnosticDisclosure;        // thrown-error SQL/params (error authority input)
  wants(need: "statement" | "transaction" | "savepoint" | "connect" | "disconnect" | "cache"
            | "cache-outcomes" | "parameters" | "query-log" | "error-log"): boolean; // call-time: tracer.isEnabled() is dynamic
  warn(notice: WarningNotice): boolean;              // false → core falls back to console.warn
}
```

`wants` is a closed union of ten needs. It replaces every enablement check core makes today:

- `isTracingEnabled` and `shouldTraceSpan` (`driver-instrumentation.ts:531-532,974-988`)
- the query/error level gates (`:615-622`, `:732`)
- the log/trace arms of `canDiscloseParameters` (`:955-972`)
- `hasOfficialCacheLogging` and the cache tracing check (`cache-instrumentation.ts:55-64,140-143`)
- the operation error-log check (`query-engine/execution-context.ts:144-146`)

After this, core never names `InstrumentationContext`, a tracer, a logger, a span name or an attribute key.

### 3.2 Neutral private facts

The facts ride the existing unit-keyed WeakMap, so only the trusted handler identity can read them.

| unit | start facts | completion facts | captured at |
|---|---|---|---|
| operation | requested op (`originalOperation`), resolved op, SQL collection, `readDriverIdentity(driver)`, context, cache-managed flag | cache outcome records; the failure only when it is not yet logged (`isErrorLogged` stays in core, §3.4) | the rail, as today (`observation.ts:165,205`) |
| statement | `dispatch: Promise<{driver, context, sql, params, forceErrorContext, startedAt, members?, start()} \| undefined>`. `params` is the one pre-dispatch snapshot or empty; `members` holds `(context, sql, params)` per native-batch member | `{endedAt, context, sql, params, failure?}`, present only when core's log decision said yes; `context`/`sql`/`params` are the attributed ones | the existing gate, after transform, render and client acquisition |
| transaction / savepoint / connection | `dispatch: Promise<{driver, context, boundary, start()} \| undefined>`. `boundary` is `"transaction" \| "savepoint" \| "connect" \| "disconnect"`, because `unit.operation` is caller-supplied (`$connect`, `client.ts:1133-1136`) | commit certainty (public, unchanged) | the provider boundary, after queue wait |
| cache get / set / invalidate / revalidate | `driverName`; for set, `ttl`; for revalidate, collection, op, `readDriverIdentity` snapshot taken at `$withCache` (`client.ts:645`), root | get `hit\|miss\|stale`; set failure; revalidate terminal outcome | the `cache/driver.ts` decision points |
| cache backend delete / clear (trusted-only, §3.5) | `{kind: "cache-backend", boundary: "delete" \| "clear", driverName, context}` | — | `cache/driver.ts:921-944` |
| cache outcome | `{event, status?, at, error?}`, never keys or suffixes; recorded only when `wants("cache-outcomes")` | — | one list per execution |

**Payloads are records**, apart from two functions that already exist today and stay in core: the `start()` handoff
(the extension must run the provider call inside its own active span, and timestamps cannot reproduce active-context
nesting), and each unit's `complete(outcome)`, which the rail calls synchronously in `settleCompletion`
(`observation.ts:196-205`) and which produces the completion record. The extension never supplies a function to core
except `wants` and `warn`.

Needs covered without a new fact:

- **Error attribution.** Core's `complete()` already resolves the attributed context with its own readers
  (`findUniqueErrorLogDetails`, `getErrorExecutionContext`). The extension imports `findUniqueExecutionContextIndex`
  and `readTrustedErrorExecutionContext` (`driver-diagnostics.ts:26-90`) for span error attributes.
- **Correlation.** It comes from `context.correlationId`.
- **Duration and timestamp.** `endedAt` is read in core's `complete()`, at the same instant as today
  (`driver-instrumentation.ts:742-743`). The extension computes `timestamp = new Date(endedAt)` and
  `duration = endedAt - startedAt`, so neither moves into its later continuation.
- **`db.namespace`.** `readDriverIdentity` is a free, non-exported core function, so it adds no member to `Driver`.
  It becomes the single read of `adapter.namespace` in place of `getBaseAttributes()`. `adapter.namespace` is
  non-writable, so the staleness argument in `src/instrumentation/AGENTS.md` still holds. The key-absent rule (never
  `null`, `""` or `"undefined"`) moves with the attribute builder into `presentation.ts`.

### 3.3 What leaves core, and where it lands

Everything lands in **one new module, `src/instrumentation/presentation.ts`**: attributes, span options per boundary,
statement/operation/cache log events, disclosure per channel, span error attribution and cache log formatting.
The existing handler arms in `extension.ts` call into it. Line counts are from the census (measured).

| area | lines | sites |
|---|---|---|
| drivers | 201 | `driver-instrumentation.ts`: the §3.1 "loses" lines (≈148 after the §3.4 repair keeps ≈20). `driver-diagnostics.ts:57-76` (19). `driver-batch-preparation.ts:61-65` (5). `driver-transaction-base.ts:4,453,825,901` (4). `driver.ts:10,79,87,173,181` (5). |
| cache | 338 | `cache-instrumentation.ts`: 160 of 206. The file is deleted, and its 20 gating lines become the outcome recorder. `cache/driver.ts` (178): `:16-27,38-44`, the log calls in `:280-402`, `:442-554,572-596,602,609-642,681-703,736-754,889,926-943`. |
| operation | 141 | `query-engine/execution-context.ts:1,9,11-17,21,66-166,211-214` (106; this is core's only `@instrumentation` barrel import). `pending-operation.ts:23,544-554` (12). `raw.ts:40,599-605` (8). `cache-flow.ts:147-151,236,254` (7). `client.ts:645` (1). `errors/diagnostics.ts:159,239-244` (7; moves to `logger.ts`). |
| carrier | 42 | `drivers/execution-context.ts` (19). `driver-instrumentation.ts:61,944-948`. `query-engine.ts:5,33,70-71`. `query-engine/execution-context.ts:7,35,40,49,60`. `client.ts:796,898,1070,1136,1175`. `raw.ts:455`. `pending-operation.ts:421`. `cache/driver.ts:12`. `operation-context.ts:11`. |

Decisions leaving core (judgement, counted by kind): span naming (11 `SPAN_*` sites), attribute composition
(4 builders), `ignoreSpanTypes` (3), log levels as event fields (5), disclosure per channel, log error sanitization
(3), cache log buffering and formatting, official-vs-legacy cache routing, warning event shape. `wants(need)` answers
every enablement question core still asks.

The span-name map in `presentation.ts` must keep today's names exactly. In particular savepoints use
`viborm.transaction` (`SPAN_TRANSACTION`, `driver-transaction-base.ts:453` passes it for both kinds); there is no
`SPAN_SAVEPOINT`, and none is introduced.

The legacy cache routing is **dead today** (judgement from reading). The non-official arms at
`cache/driver.ts:394-402,476-482,499-507` call `emitCacheLogEvent`, which returns early when there is no official
capability (`cache-instrumentation.ts:84-93`). So about 25 lines vanish rather than move. The `.catch` on `setScoped`
(`cache/driver.ts:393`) stays as `.catch(() => undefined)`: only its dead body goes, otherwise a background set
failure becomes an unhandled rejection. The official set-failure path (the set unit's completion) is unchanged.

### 3.4 What stays, and why

- **The public rail.** It is public API.
- **Boundary timing and the deferred handoff.** Provider-level OTel must nest under the execute, transaction and
  connect spans.
- **The pre-dispatch parameter snapshot.** One hostile-safe read, shared by thrown errors, logs and spans. Only the
  decision whether to take it moves, to `wants("parameters")`.
- **Error authority.** Correlation ids, native-batch attribution, thrown-error disclosure and commit certainty stay
  in core.
- **Selected error logging and exact-error de-duplication** (`src/instrumentation/AGENTS.md`: "Core owns selected
  error logging and exact-error deduplication"). The statement `complete()` keeps `:713-735`: it resolves the
  attributed log context, asks that context's capability `wants("query-log" | "error-log")`, and calls
  `markErrorLogged(failure)` synchronously, in the same tick the child settles, exactly as today
  (`driver-instrumentation.ts:735`). The operation `complete()` keeps `isErrorLogged` and passes the failure only
  when it is unlogged and `wants("error-log")`. Error lineage copies evidence at clone time only
  (`driver-error-context.ts:158,192`), so a mark made later in the extension's continuation could lose the race with a
  successor clone and log the operation-level error twice. Keeping the mark in core removes that ordering hazard.
- **Cache outcome facts, deferred statement transforms and the `console.warn` fallback.**
- **Error lineage** (`transferLoggedErrorEvidence`). It keeps its exact copy-at-clone semantics, and
  `logged-errors.ts` moves to `src/errors/` (0 B) so that core has no runtime edge into the extension.
- **The trusted rail.** Removing it (E3) is worth only 1.9 KB more and would break the protected contract.

Invariants kept (`src/instrumentation/AGENTS.md`): ordinary observers see only a frozen unit and completion; one
`InstrumentationContext` per exact chain; no driver-attached state (`readDriverIdentity` reads configuration); no
second registry or presenter (the chain map is relocated, not duplicated; §3.5 reuses the one runner); core owns
error logging selection and de-duplication; the seam stays internal (no new export and no new class member; §6).

### 3.5 Cache delete/clear spans: trusted-only dispatch through the one runner

Today `withSpan` opens delete/clear spans with the carrier's tracer (`cache/driver.ts:609-623`). They occur only
inside an invalidation (`:895-896`) and are children of its span (witness
`official-cache-instrumentation.core.test.ts:624-700`). With the carrier gone, core needs a path that reaches only the
trusted handler.

- **Function.** `selectTrustedObservers(observers: readonly ResolvedExtensionHandler[] | undefined):
  readonly ResolvedExtensionHandler[] | undefined`, in `extensions/observation.ts` beside the `trustedObservers`
  WeakMap, never exported by a package entry. It returns the one registered trusted entry of the exact chain (the
  identity `runProtectedObservers` already finds at `observation.ts:169-176`), or `undefined`.
- **Call.** A private `CacheDriver` method replaces the `observedOperation === undefined` arm:
  `runProtectedObservers({kind: "cache", operation: "invalidate"}, trusted, execute, undefined, () => facts)`, with
  the `cache-backend` facts of §3.2. When `trusted` is `undefined` it calls `execute()` directly.
- **Why it is not a second rail.** It uses the same registry, the same runner, the same WeakMap facts, the same
  containment and the same readiness path, already warm inside the enclosing invalidation. The only new code is the
  selector (≈8 lines). Ordinary observers are not in the list, so they see nothing, which is also true today
  (delete/clear have no public unit). The unit object reuses the public `invalidate` shape because the public union
  must not grow. It is frozen and reaches only the trusted handler, which dispatches on the private facts' `kind`.
- **Behaviour.** Delete/clear spans appear when the trusted handler `wants("cache")`, and today they appear whenever
  the carrier has a tracer. The two sets are the same when tracing is configured (judgement); the golden transcript
  decides.

## 4. Work units (in execution order)

**Order.** U0 comes first because the golden transcript must be captured before any change. U1 introduces the
capability that U2–U4 read, and it depends on no owner decision. U2 (cache) comes next: it has the largest estimated
net saving (−2.1 KB), and D1 blocks only its last deletion. U3 (drivers) has the largest gross ceiling (5.2 KB) but
also the largest retained seam and the only timing-critical rewrite (the handoff record and the gate signature). D1
blocks its public-member deletions.

**After each unit:**

1. tsdown build: `node node_modules/tsdown/dist/run.mjs`.
2. `node scripts/measure-bundle.mjs --out <unit>.json`, for pg-representative, ids-only, decimal-only and `full`.
3. `node scripts/measure-instrumentation-bundles.mjs . <unit>-instr.json`, for pg-instrumented, s-only,
   sqlite3-representative and the per-file src attribution.
4. `accounting.cjs` line deltas.
5. The witnesses, by direct vitest.
6. The golden transcript.

**Unit estimates** (raw, dist; method as §2: the unit's share of the measured E0→E2b attribution minus its seam rows,
× 0.986). The shared `spans.ts` constants leave with their last core importer; they are split by constant length:
drivers 154, cache 180, operation 98 (estimate). `tracer.ts` leaves with the drivers and `logger.ts` with the
operation (judgement, from the import graph). Checkpoint = the pessimistic end (prototype rows × 1.25).

| unit | gross (measured attribution) | seam kept | estimate | checkpoint (pg-rep) |
|---|---|---|---|---|
| U1 capability | — | — | ≈0 | within ±150 B raw (judgement) |
| U2 cache | 3,618 | 1,499 (prototype) | −2.1 KB raw / −0.6 KB gzip | ≤ −1.7 KB raw, ≤ −0.45 KB gzip |
| U3 drivers | 5,177 | 3,590 (2,590 measured + 1,000 prototype) | −1.6 KB / −0.45 KB | ≤ −1.3 KB raw, ≤ −0.35 KB gzip |
| U4 operation | 1,448 | 557 (prototype) | −0.9 KB / −0.25 KB (gzip in noise) | ≤ −0.7 KB raw |
| U5 carrier, hygiene | 343 | 196 (measured) | −0.15 KB (−122 measured for the carrier alone) | no growth |
| **sum** | **10,586** | **≈5,840** | **−4.7 KB / −1.3 KB** | **≤ −3.9 KB raw** |

| unit | changes and deletions | invariant | witnesses |
|---|---|---|---|
| **U0** Harness (tests and scripts only; no production change) | Commit `scripts/measure-instrumentation-bundles.mjs`: the scratch `attrib.mjs` verbatim, with its fixtures templated inline (never in `scripts/bundle-fixtures/`). Usage `<repoRoot> <out.json>`; it bundles `dist/` and `src/` with `measure-bundle.mjs`'s esbuild options and emits pg-instrumented, s-only, sqlite3-representative, pg-representative and `full` with per-input `bytesInOutput`. Add a `--members` mode that prints, from `dist/*.d.mts`, one line per member of `DriverInstrumentationBase`, `DriverTransactionBase`, `Driver`, `TransactionBoundDriver` and `CacheDriver`, with comments stripped. Commit the golden transcript (below) and the new de-dup witness, all green at `cf4ba97a6`. | — | the new files pass at `cf4ba97a6` |
| **U1** Capability | The extension builds `OfficialObservationCapability` (`wants`, `diagnostics`, `warn`). Move the chain→capability map into `observation.ts` and `OFFICIAL_INSTRUMENTATION_NAME` into `chain.ts`. Core call sites switch from `official.context.logger?.isLevelEnabled(…)` and `config.tracing` reads to `wants(…)`. There is no handoff change, no fact change and no D1 dependence. Owners: `observation.ts`, `chain.ts`, new `official-facts.ts`, `extension.ts`. | One capability per exact chain. `wants` is called at call time, never cached. | `unit/instrumentation/{official-observer,official-observer-provider-failures,execution-context}.core`; `contracts/public-client/official-instrumentation-extension.core`; `types/instrumentation/*.core.types.ts` |
| **U2** Cache presentation | Outcome records replace the 8 `logExecutionCacheEvent` calls. The dead legacy arms are deleted, keeping the `.catch` (§3.3). `terminalLogEvent` becomes a terminal outcome. `dbAttributes` becomes a `readDriverIdentity` snapshot taken at `$withCache`. Delete/clear go through §3.5. `cache-instrumentation.ts` is deleted. `CacheDriver.getBaseAttributes` is deleted only if D1 approves. −338 lines, of which ≈25 vanish. | Keys and suffixes are never recorded. An ignored cache span sets no late parent attributes. Delete/clear spans stay children of the invalidate span. | `contracts/public-client/official-cache-instrumentation.core` (all eight tests, notably `:461-546` set failure, `:575` ignored attributes, `:624-700` invalidation children, `:701` SWR root); `unit/cache/{coverage-low-value,namespace-isolation}.core`; extended-local `unit/cache/cache.test.ts` |
| **U3** Driver statement and lifecycle presentation | `deferred.execute(spanOptions)` becomes `execute(record)`. The lifecycle gate takes a `boundary`, not a span name. The four `gate === undefined ? … : gate.execute(…)` arms (`driver-transaction-base.ts:208,305,733,889`) fold into one call. The statement `complete()` keeps the log decision and the de-dup mark and returns the §3.2 record. The members listed under D1 are deleted if approved. −201 lines (≈20 of them stay, §3.4). Owners: the five driver files, new `driver-identity.ts`, `presentation.ts`, `extension.ts`. | Dispatch starts only inside the trusted span, and the parameter read still precedes dispatch. `markErrorLogged` runs synchronously in `complete()`. | `contracts/public-client/official-{statement,driver-lifecycle}-instrumentation.core`; `contracts/drivers/{instrumentation-observed-statements,driver-instrumentation-boundaries,protected-observers,transaction-base-observed-lifecycle}.core`; `unit/instrumentation/{native-batch-attribution,namespace-attribute,provider-context-concurrency,official-observer,official-observer-provider-failures,context-spans}.core`; the U0 de-dup witness; extended-local `contracts/drivers/error-mapping.provider` |
| **U4** Operation presentation | Operation facts become neutral. The error log event moves to the extension; `isErrorLogged` stays in core (§3.4). `observeTransactionBatchPhase` (error normalization) reads `diagnostics` from the capability. `LOG_META_KEYS` moves to `logger.ts`. −141 lines. | The operation unit still begins before the lazy request transform (`client.ts:548-556`). One error, one error log. | `contracts/public-client/official-instrumentation-extension.core`; `unit/instrumentation/{execution-context,logged-errors,logger}.core`; `contracts/public-client/raw-sql.test.ts`; `contracts/engine/query/operation-program-read-contracts.core`; the U0 de-dup witness |
| **U5** Carrier and import hygiene | Delete the carrier (−42). `warnDroppedSkip` calls `capability.warn`. `logged-errors.ts` moves to `src/errors/`. Rewrite every remaining `import { type … }` from the extension as `import type`. Exit checks in §6 (Structure). | Core has no runtime edge into `src/instrumentation/`. | U1–U4 witnesses; `raptor3/prep/suppression-replay.test.ts` (routed warning); `contracts/engine/write/create-many-skip-depth.test.ts` (`console.warn` fallback) |
| **U6** Dead extension code (D2, D3) | D3: delete `perf-tracker.ts` and its test (−199 lines, measured). D2: delete the segment rail — `observation.ts:36-40`, `extension.ts:82-98,226-259`, the `lifecycle-facts.ts` segment types, `SPAN_RECORD_SERIES_SEGMENT`, `ATTR_VIBORM_WRITE_*` (≈61 lines + 9 constants) — together with the tests that build it by hand (`namespace-attribute-segment.test.ts`, the segment cases of `official-observer*`, `lifecycle-completion.core.types.ts`, the golden surface). | No producer in `src/` (grep). | `package/public-surface-golden.mjs`, updated only as approved. 0 B. |
| **U7** Guides and closing | See the guide list below. | — | Layer gates, run sequentially: client, drivers, instrumentation, query-engine, cache. Then `pnpm test:coverage:instrumentation`, which must stay at 100% with `presentation.ts` inside its glob. Final measurement. |

**Golden transcript** (U0). `tests/unit/instrumentation/golden-transcript.core.test.ts` asserts with
`toMatchFileSnapshot("__golden__/transcript.json")`. The snapshot is committed, written once at `cf4ba97a6`, and
never regenerated during this plan.

It records, per scenario:

- span names, attributes, status and events, and parent links
- log events by level
- the thrown error's JSON under each `diagnostics` setting
- ordinary-observer units and completions

Scenarios (each a re-run of the named test's setup, through `_capture.ts`'s real `NodeTracerProvider`):

- **Statement:** `official-statement-instrumentation.core` — single statement, failing statement with and without
  diagnostics, native batch, and the single-log de-dup at `:782-840`.
- **Driver lifecycle:** `official-driver-lifecycle-instrumentation.core` `:235`, `:327` (queued savepoint), `:392`
  (commit certainty), `:508` (fallback transaction), `:591` (connection failure).
- **Operation:** `official-instrumentation-extension.core` — operation span and operation error log.
- **Cache:** `official-cache-instrumentation.core` `:461` (cold, fresh, bypass and set failure), `:624`
  (invalidation with delete/clear children), `:701` (SWR revalidation root with nested set and failure).
- **Disclosure:** `includeSql` and `includeParams` on and off for each of tracing, logging and diagnostics, on the
  statement scenario.

Normalization:

- Trace, span and parent ids become ordinals by first appearance in export order; a parent outside the recorder is
  `"external"`.
- `correlationId` values become ordinals.
- Span start and end times are dropped, because OTel reads a high-resolution clock that fake timers do not govern.
- Log `timestamp` and `duration` are kept under `vi.useFakeTimers({ toFake: ["Date"] })`.

One extra real-clock assertion runs outside fake timers: for a successful single statement, the query log's `duration`
is ≤ the operation completion's `durationMs` seen by an ordinary observer, and its `timestamp` is ≤ the time the
operation promise resolves.

**De-dup witness** (U0, new, in `official-statement-instrumentation.core`). Tracing is on, so the extension's
continuation runs inside `startActiveSpan`, and query and error logging are on. A statement fails, and its error is
replaced by a package-owned successor before the operation completes (the `attachExecutionContext` clone,
`driver-error-context.ts:192`, or the commit-certainty clone, `:158`, through a fallback transaction). The witness
asserts exactly one error log event. It must pass at `cf4ba97a6`.

**Lines** (estimate). Net ≈ −225 production code lines before U6; U6 then takes −199, and ≈ −70 more if D2 is
approved. Method: −722 core (measured census: 680 presentation + 42 carrier) + ≈76 new core lines (prototype
snippets counted with the scanner rule: statement tail 9, lifecycle/identity 7, cache outcome recorder 20, cache unit
facts 12, trusted-only selector and call 15, operation facts 13) + ≈420 in the extension (judgement; the core forms
carry threading, interfaces and dead routing that do not reappear) = −226.

**Guides (U7):**

- `src/instrumentation/AGENTS.md`:
  - Owner table: `driver-instrumentation.ts` becomes "provider-dispatch facts and the deferred handoff"; add
    `presentation.ts`; `logged-errors.ts` moves to `src/errors/`.
  - Delete the stale "progressive writes emit segments" sentence (with D2).
  - The `db.namespace` choke point becomes `readDriverIdentity` in `src/drivers/driver-identity.ts`, and the
    key-absent rule lives in `presentation.ts`.
  - Rewrite the native-batch pin as "the unobserved native-batch phase calls `readDriverIdentity` zero times", and
    re-point `native-batch-attribution.core.test.ts:151` from `vi.spyOn(driver, "getBaseAttributes")` to a
    `vi.mock` spy on `@drivers/driver-identity`. If D1 keeps `getBaseAttributes`, the pin and the spy stay as they
    are.
  - Keep the de-dup sentence; it stays true. Add "the extension formats; core selects and marks".
  - Add §3.5 under "Lifecycle rail".
- `src/query-engine/AGENTS.md`, the cache guide, and the cache rows of `bundle-size-reduction-plan.md`.

## 5. Non-goals and stop conditions

Non-goals:

- No behaviour change to spans, log events, diagnostics output or thrown errors for an installed extension; the golden
  transcript decides.
- No change to the protected observer contract, and none to the public unit union except D2.
- No generic hook framework, event bus or public token, and the seam never becomes public API.
- Out of scope: the privileged rail (E3), the observed/unobserved duplication in `array-transaction-legacy.ts`
  (seam:public, 234 lines), and the cache capability inversion in `bundle-size-reduction-plan.md`.

Stop and report if any of these happens:

- a unit misses its checkpoint (§4) — the seam grew beyond its pessimistic estimate
- the golden transcript or the real-clock assertion fails
- a witness needs an expectation change that D1/D2 did not approve
- the `--members` diff shows anything outside the approved D1 list
- pg-instrumented or `full` grows by more than 1,000 B (judgement threshold)
- s-only, ids-only or decimal-only move by more than ±20 B

## 6. Acceptance

**Bundle** (measured at the end, dist mode):

- pg-representative ≤ 545,194 raw and ≤ 160,275 gzip: the pessimistic end of §2's bracket (−3,924 / −1,126,
  estimate). The target is ≈ 544,440 / 160,060 (estimate, §2).
- sqlite3-representative drops by the same raw delta ±10% (U0 script).
- ids-only and decimal-only (`measure-bundle.mjs`) and s-only (U0 script) move by at most ±20 B.
- pg-instrumented (U0 script, 558,221 today) and `full` (`measure-bundle.mjs`, 919,620 today) grow by at most
  1,000 B. `full` is the committed proxy: it re-exports `viborm/instrumentation`.

**Tests:**

- every U1–U5 witness, the golden transcript, the real-clock assertion and the de-dup witness
- `tests/package/{public-surface-golden,otel-absent-smoke}.mjs` and `tests/types/instrumentation/*`
- `tests/unit/instrumentation/**`, including the tracer suites
- the extended-local files named above
- instrumentation coverage at 100%

**Structure:**

- **The metafile check is authoritative.** The U0 script's src-mode pg-representative `inputs` contain no key under
  `src/instrumentation/`; at `cf4ba97a6` they contain `spans.ts`, `tracer.ts`, `logger.ts`, `extension.ts` and
  `logged-errors.ts`.
- `rg -U --pcre2 'import(?!\s+type\b)[^;]*?from\s+"(@instrumentation|(\.\./)+instrumentation)' src -g
  '!src/instrumentation/**'` prints nothing. It spans multi-line imports, and it deliberately flags
  `import { type … }`. It finds 9 files at `cf4ba97a6`.
- No `SPAN_*`, `ATTR_*`, `LogEvent`, tracer or logger appears outside `src/instrumentation/`.
- Core reads only `observesLifecycle`, `prewarm`, `diagnostics`, `wants` and `warn`.
- **Public surface.** `public-surface-golden.mjs` shows no new export name, and `measure-instrumentation-bundles.mjs
  --members` differs from its `cf4ba97a6` output only by the approved D1 list. The export-name golden alone cannot
  see class members.

**Guides:** updated as in U7.

**Open decisions for the owner:**

- **D1. `Driver` and `CacheDriver` members.** Both classes are public exports (`public-surface-golden.mjs:175,195,269,278`),
  and no tsconfig sets `stripInternal`, so every member below is in the emitted `.d.mts` and reachable by custom
  driver subclasses. Recommendation: approve all of it; only tests call the public ones.
  - Deleted, public: `getBaseAttributes()` and `getContextAttributes(context?)` on `DriverInstrumentationBase`
    (therefore on `Driver`), and `CacheDriver.getBaseAttributes()`.
  - Deleted, protected: `getInstrumentation`, `isTracingEnabled`, `getLoggingDisclosure`, `getTracingDisclosure`,
    `getLogger`. `InstrumentationContext` and `VibORMSpanName` then leave these declarations.
  - Changed, protected: `observeTrustedDriverLifecycle(kind, context, spanName, child, …)` takes a `boundary` in
    place of `spanName`. The `OfficialStatementExecutionGate` shape used by `observeTrustedStatement` and
    `observeTrustedBatchStatements` changes: `execute` publishes a record, and there are no span options.
  - Private names that disappear (not callable, but visible in the diff): `createStatementSpanOptions`,
    `createStatementLogEvent`, `CacheDriver.logExecutionCacheEvent`. `CacheDriver.withSpan` is replaced by the §3.5
    method.
  - Kept, protected, with bodies re-pointed at the capability: `canDiscloseParameters`, `getErrorDisclosure` (called
    by `pg/index.ts:236,294` and `driver.ts:108,145`), `getDiagnosticParameters`, `getBatchDiagnosticParameters`.
  - Added: nothing. The earlier `DriverIdentity` getter is dropped for the free function.

  If the public getters are kept, they become thin wrappers over `readDriverIdentity` plus the attribute keys: ≈200–300
  B (judgement), and `ATTR_*` constants stay in core as the one exception to the Structure check.
- **D2.** Delete the dead segment rail. It is part of the public `ObservationUnit` union and the
  `viborm/instrumentation` exports, and nothing in `src/` produces it.
- **D3.** Delete `perf-tracker.ts`. It is internal, and it is already row 3 of
  `loc-reduction-beyond-the-kernel.md`.
- **Plan-level choices you may want to veto:**
  - the §3.5 trusted-only dispatch, which reuses the `invalidate` unit shape for delete/clear
  - moving `logged-errors.ts` into `src/errors/`
  - the +1,000 B growth threshold (judgement)
