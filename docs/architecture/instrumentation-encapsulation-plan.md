# Instrumentation encapsulation plan

Status: plan, not started. Measured at `cf4ba97a6` (origin/main, 2026-09-28); this commit changes no production
source. Every number is labelled **measured** (a build or count at `cf4ba97a6`), **estimate** (derived from
measurements, method stated) or **judgement** (a reading of the code).

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
| **presentation** | **680** | **leaves core** |
| **carrier** — `engine.instrumentation`, trusted-context `instrumentation` | **42** | **deleted**: derivable from the chain (`query-engine.ts:70-71`) |
| types-only 179 · dead 5 (`segment` unit kind) | 184 | 0 B |

`src/instrumentation/` itself is 1,570 code lines (measured). Nothing imports its `perf-tracker.ts` (199 lines)
except the internal barrel `index.ts:26-34` (judgement, from grep).

**Attribution** (measured; esbuild metafile `bytesInOutput`, pg-representative bundled from `src/`, 0.2% off dist).
Raw bytes removed between E0 and E4, by file:
`driver-instrumentation.ts` 4,028 of 8,103 · `cache-instrumentation.ts` 1,785 (all) · `cache/driver.ts` 1,653
of 6,076 · `observation.ts` 1,284 of 2,800 (privileged rail) · `query-engine/execution-context.ts` 843 of 1,425 ·
`driver-transaction-base.ts` 398 · `chain.ts` 347 · `driver-diagnostics.ts` 258 · `driver-batch-preparation.ts` 234 ·
`pending-operation.ts` 177 · `drivers/execution-context.ts` 111 · six small files 329 · `src/instrumentation/*` 1,163
(spans 432, tracer 337, logger 154, extension 126, logged-errors 114) · **sum 12,653**.

The extension's factory, context, OTel loader and logger are already tree-shaken when it is not installed, so **the
leak is core code**. Cache presentation reaches every pg bundle through `extensions/chain.ts:1-6` →
`@cache/extension`, even when the cache extension is not installed.

**Ceilings** (measured). Method: scratch trees from `git archive HEAD`, stubbed by exact replacements with asserted
match counts, built with tsdown and measured with `scripts/measure-bundle.mjs`; tsc and a better-sqlite3 smoke run
pass in every tree. Baseline pg-representative: 549,118 raw / 161,401 gzip.

| experiment | removed (cumulative) | pg-rep Δ raw / gzip | code lines Δ |
|---|---|---|---|
| census lower bound | presentation *bodies* only; call sites, gates, carrier kept | −5,594 / −1,637 | — |
| E1 | `src/instrumentation/*` bodies | −512 / −199 | (extension) |
| E2 | E1 + core presentation, driver gates, diagnostics disclosure | −10,316 / −3,059 | −1,751 |
| E2b | E2 + carrier | −10,438 / −2,995 | −1,762 |
| E3 | E2b + privileged trusted-observer rail | −12,382 / −3,697 | −2,019 |
| E4 | E3 + orphans | −12,676 / −3,807 | −2,373 (1,295 core) |

What else the ceiling runs show (all measured):

- sqlite3-representative moves by the same raw bytes.
- s-only, ids-only and decimal-only move by −4 B in every experiment. Schema-only bundles carry no instrumentation,
  so this plan cannot move them.
- Installing the extension adds +9,109 raw / +2,784 gzip today (pg-instrumented 558,221).
- Gzip deltas under ±200 B are noise.

**Expected outcome (estimate): about −7.5 KB raw / −2.1 KB gzip (≈ −1.4%) on pg-representative.**

- The method: E2b's −10,438, plus the seam pieces that E2 stubbed but must survive (≈2.9 KB raw, broken down below).
  Gzip is scaled by E2b's measured gzip/raw ratio of 0.29.
- The bracket: between the measured lower bound (−5.6 KB) and E2b (−10.4 KB).
- With the extension installed, the moved bytes reappear in it, so pg-instrumented should stay about neutral
  (judgement).

| seam piece that must survive | raw bytes | label |
|---|---|---|
| deferred handoff, `driver-instrumentation.ts:160-216` | 431 | measured: esbuild-minified HEAD snippet |
| gate builders, `:607-690` | ≤1,206 | measured, same method |
| gate arms, per-file attribution | ≈460 | measured |
| error-policy code | ≈600 | judgement |
| neutral fact producers | ≈250 | judgement |

## 3. Target design

### 3.1 The seam (named modules)

| module | keeps | loses |
|---|---|---|
| `extensions/observation.ts` | Public units and completions, unchanged. The trusted registry, unit-keyed private facts, prewarm and the downstream-only bridge. **Gains** the chain→capability WeakMap, relocated from `instrumentation/extension.ts:31-74`. | fact types from `@instrumentation/lifecycle-facts` |
| `extensions/official-facts.ts` (new; types only, 0 B, never re-exported) | The neutral fact contract (§3.2) and `OfficialObservationCapability`. | — |
| `extensions/chain.ts` | Fixed-name admission (`:299-311`). Per-chain registration (`:369-372`), now into the core map. The `observesLifecycle` filter (`:205-208`). | `@instrumentation` runtime imports other than the name constant |
| `drivers/driver-instrumentation.ts` | The deferred handoff (`:160-216`), carrying a neutral record instead of `spanOptions`. Gate builders without presentation. `hasTrustedObservers`, deferred transforms, `observeTrusted*`. The parameter snapshot and thrown-error disclosure (`:792-817`, `:950-954`, `:990-996`). | `:7,26-40,50-51,423-444,517,531-532,615-622,636,647-651,683-686,692-755,955-988,998-1016` |
| `drivers/execution-context.ts` | The chain on trusted contexts. | the carrier (19 lines) |
| `cache/driver.ts` | Cache units and failure capture. **Gains** neutral outcome records at the decision points (`:277-402`). | log emission, span names and attributes, the direct tracer path, `getBaseAttributes` |
| `raptor3/shared/operation-context.ts` | The once-per-lineage warning decision and the `console.warn` fallback (`:234-254`). | the logger event shape |

Core reads one capability record with two methods; it is not a hook framework:

```ts
interface OfficialObservationCapability {
  readonly observesLifecycle: boolean;               // exists today
  readonly prewarm?: () => void | Promise<void>;     // exists today
  readonly diagnostics: DiagnosticDisclosure;        // thrown-error SQL/params (error authority input)
  wants(need: "statement" | "transaction" | "savepoint" | "connect" | "disconnect"
            | "cache" | "cache-outcomes" | "parameters"): boolean; // call-time: tracer.isEnabled() is dynamic
  warn(notice: WarningNotice): boolean;              // false → core falls back to console.warn
}
```

`wants` replaces every enablement check core makes today:

- `isTracingEnabled` and `shouldTraceSpan` (`driver-instrumentation.ts:531-532,975-988`)
- the query/error level gate (`:615-622`)
- the log/trace arms of `canDiscloseParameters` (`:955-972`)
- `hasOfficialCacheLogging` and the cache tracing check (`cache-instrumentation.ts:55-64,140-143`)

After this, core never names `InstrumentationContext`, a tracer, a logger, a span name or an attribute key.

### 3.2 Neutral private facts

The facts ride the existing unit-keyed WeakMap, so only the trusted handler identity can read them.

| unit | start facts | completion facts | captured at |
|---|---|---|---|
| operation | requested op (`originalOperation`), resolved op, SQL collection, `DriverIdentity {dialect, driverName, namespace?}`, context, cache-managed flag | raw failure; cache outcome records | the rail, as today (`observation.ts:165,205`) |
| statement | `dispatch: Promise<{driver, context, sql, params, forceErrorContext, startedAt, members?, start()} \| undefined>`. `params` is the one pre-dispatch snapshot or empty; `members` holds `(context, sql, params)` per native-batch member | normalized failure | the existing gate, after transform, render and client acquisition |
| transaction / savepoint / connection | `dispatch: Promise<{driver, context, boundary, start()} \| undefined>`. `boundary` is the discriminant because `unit.operation` is caller-supplied (`$connect`, `client.ts:1133-1136`) | commit certainty (public, unchanged) | the provider boundary, after queue wait |
| cache get / set / invalidate / revalidate | `driverName`; for set, `ttl`; for revalidate, collection, op, `DriverIdentity`, root | get `hit\|miss\|stale`; set failure; revalidate terminal outcome | the `cache/driver.ts` decision points |
| cache outcome | `{event, status?, at, error?}`, never keys or suffixes; recorded only when `wants("cache-outcomes")` | — | one list per execution |

**Payloads are records.** The only function is today's `start()` handoff: the extension must run the provider call
inside its own active span, and timestamps cannot reproduce active-context nesting.

Needs covered without a new fact:

- **Error attribution.** The extension imports core's readers `findUniqueExecutionContextIndex` and
  `readTrustedErrorExecutionContext` (`driver-diagnostics.ts:26-90`).
- **Correlation.** It comes from `context.correlationId`.
- **Duration.** `startedAt` keeps the log `duration` byte-identical.
- **`db.namespace`.** `DriverIdentity`, one frozen getter on `Driver`, becomes the single choke point in place of
  `getBaseAttributes()`. `adapter.namespace` is non-writable, so the staleness argument in
  `src/instrumentation/AGENTS.md` still holds.

### 3.3 What leaves core, and where it lands

Everything lands in **one new module, `src/instrumentation/presentation.ts`**: attributes, span options per boundary,
statement/operation/cache log events, disclosure per channel, statement error attribution and cache log buffering.
The existing handler arms in `extension.ts` call into it. Line counts are from the census (measured).

| area | lines | sites |
|---|---|---|
| drivers | 201 | `driver-instrumentation.ts`: the §3.1 "loses" lines (168). `driver-diagnostics.ts:57-76` (19). `driver-batch-preparation.ts:61-65` (5). `driver-transaction-base.ts:4,453,825,901` (4). `driver.ts:10,79,87,173,181` (5). |
| cache | 338 | `cache-instrumentation.ts`: 160 of 206. The file is deleted, and its 20 gating lines become the outcome recorder. `cache/driver.ts` (178): `:16-27,38-44`, the log calls in `:280-402`, `:442-554,572-596,602,609-642,681-703,736-754,889,926-943`. |
| operation | 141 | `query-engine/execution-context.ts:1,9,11-17,21,66-166,211-214` (106; this is core's only `@instrumentation` barrel import). `pending-operation.ts:23,544-554` (12). `raw.ts:40,599-605` (8). `cache-flow.ts:147-151,236,254` (7). `client.ts:645` (1). `errors/diagnostics.ts:159,239-244` (7; moves to `logger.ts`). |
| carrier | 42 | `drivers/execution-context.ts` (19). `driver-instrumentation.ts:61,944-948`. `query-engine.ts:5,33,70-71`. `query-engine/execution-context.ts:7,35,40,49,60`. `client.ts:796,898,1070,1136,1175`. `raw.ts:455`. `pending-operation.ts:421`. `cache/driver.ts:12`. `operation-context.ts:11`. |

Decisions leaving core (judgement, counted by kind): span naming (11 `SPAN_*` sites), attribute composition
(4 builders), `ignoreSpanTypes` (3), log levels (5), disclosure per channel, log error sanitization (3), log de-dup
marking, cache log buffering, official-vs-legacy cache routing, statement duration, warning event shape. One
`wants(need)` replaces them all.

The legacy cache routing is **dead today** (judgement from reading). The non-official arms at
`cache/driver.ts:394-402,476-482,499-507` call `emitCacheLogEvent`, which returns early when there is no official
capability (`cache-instrumentation.ts:84-93`). So about 25 lines vanish rather than move.

### 3.4 What stays, and why

- **The public rail.** It is public API.
- **Boundary timing and the deferred handoff.** Provider-level OTel must nest under the execute, transaction and
  connect spans.
- **The pre-dispatch parameter snapshot.** One hostile-safe read, shared by thrown errors, logs and spans. Only the
  decision whether to take it moves, to `wants("parameters")`.
- **Error authority.** Correlation ids, native-batch attribution, thrown-error disclosure and commit certainty stay
  in core.
- **Cache outcome facts, deferred statement transforms and the `console.warn` fallback.**
- **Error lineage** (`transferLoggedErrorEvidence`, `driver-error-context.ts:158,192`). It keeps its exact
  copy-at-clone semantics, and its module moves to `src/errors/` (0 B) so that core has no runtime edge into the
  extension.
- **The trusted rail.** Removing it (E3) is worth only 1.9 KB more and would break the protected contract.

Invariants kept (`src/instrumentation/AGENTS.md`): ordinary observers see only a frozen unit and completion; one
`InstrumentationContext` per exact chain; no driver-attached state (`DriverIdentity` is configuration); no second
registry or presenter (the chain map is relocated, not duplicated); the seam stays internal (`public-surface-golden.mjs`
shows no new export).

## 4. Work units (ordered by value/risk)

**After each unit:** tsdown build, `node scripts/measure-bundle.mjs --out <unit>.json` (record pg-representative,
pg-instrumented, s-only/ids-only), `accounting.cjs` line deltas, witnesses by direct vitest, golden-transcript diff.
The golden transcript is captured once from `cf4ba97a6`, before U1, in scratch. It uses
`tests/unit/instrumentation/_capture.ts` under fake timers over the four `official-*` contract scenarios, and records
span names, attributes, parent links, log events, and thrown-error JSON under `diagnostics`. It must stay
byte-identical after every unit.

| unit | changes and deletions | invariant | witnesses | checkpoint (pg-rep) |
|---|---|---|---|---|
| **U1** Driver statement and lifecycle presentation. The most bytes for the least seam change: the gate already builds the neutral record (`published`, `driver-instrumentation.ts:646`). | Add `wants` and `diagnostics`. `deferred.execute(spanOptions)` becomes `execute(record)`. The lifecycle gate takes a `boundary`. The four `gate === undefined ? … : gate.execute(…)` arms (`driver-transaction-base.ts:208,305,733,889`) fold into one call. −201 lines. Owners: the five driver files, `observation.ts`, new `official-facts.ts` and `presentation.ts`, `extension.ts`. Decision D1. | Dispatch starts only inside the trusted span, and the parameter read still precedes dispatch. | `contracts/public-client/official-{statement,driver-lifecycle}-instrumentation.core`; `contracts/drivers/{instrumentation-observed-statements,driver-instrumentation-boundaries,protected-observers,transaction-base-observed-lifecycle}.core`; `unit/instrumentation/{native-batch-attribution,namespace-attribute,provider-context-concurrency,official-observer,official-observer-provider-failures,context-spans}.core`; extended-local `contracts/drivers/error-mapping.provider` | ≥ −2,377 raw / −696 gzip (measured lower bound). Estimate −2.6 KB. |
| **U2** Cache presentation. | Outcome records replace 8 `logExecutionCacheEvent` calls. The dead legacy arms are deleted. `terminalLogEvent` becomes a terminal outcome. `dbAttributes` becomes `DriverIdentity`. `delete`/`clear` use the U1 handoff as a private boundary, replacing core's only direct tracer call (`cache/driver.ts:609-623`), so their spans survive with no new unit for ordinary observers. −338 lines, of which ≈25 vanish. `cache-instrumentation.ts` is deleted. | Keys and suffixes are never recorded. An ignored cache span sets no late parent attributes. | `contracts/public-client/official-cache-instrumentation.core`; `unit/cache/{coverage-low-value,namespace-isolation}.core`; extended-local `unit/cache/cache.test.ts` | ≥ −2,082 / −590 (measured lower bound). Estimate −2.9 KB; per-file ceiling 3,438 (measured). |
| **U3** Operation presentation. | Operation facts become neutral. The error log event and `isErrorLogged` move to the extension. `observeTransactionBatchPhase` (error normalization) reads `diagnostics` from the capability. `LOG_META_KEYS` moves to `logger.ts`. −141 lines. | The operation unit still begins before the lazy request transform (`client.ts:548-556`). | `contracts/public-client/official-instrumentation-extension.core`; `unit/instrumentation/{execution-context,logged-errors,logger}.core`; `contracts/public-client/raw-sql.test.ts`; `contracts/engine/query/operation-program-read-contracts.core` | ≥ −1,034 / −287 (measured lower bound). Estimate −0.9 KB. |
| **U4** Carrier, capability relocation, import hygiene. | Delete the carrier (−42). Move the chain map into `observation.ts`. `warnDroppedSkip` calls `capability.warn`. `logged-errors.ts` moves to `src/errors/`. After this unit, `rg -n 'from "(@instrumentation\|\.\./instrumentation)' src --glob '!src/instrumentation/**'` finds only `import type`. | One capability per exact chain. | U1–U3 witnesses; `raptor3/prep/suppression-replay.test.ts` (routed warning); `contracts/engine/write/create-many-skip-depth.test.ts` (`console.warn` fallback); `types/instrumentation/*.core.types.ts` | −122 raw (measured E2b; inside gzip noise). The value is structural. |
| **U5** Dead extension code (D2, D3). | D3: delete `perf-tracker.ts` and its test (−199 lines, measured). D2: delete the segment rail — `observation.ts:36-40`, `extension.ts:82-98,226-259`, the `lifecycle-facts.ts` segment types, `SPAN_RECORD_SERIES_SEGMENT`, `ATTR_VIBORM_WRITE_*` (≈61 lines + 9 constants) — together with the tests that build it by hand (`namespace-attribute-segment.test.ts`, the segment cases of `official-observer*`, `lifecycle-completion.core.types.ts`, the golden surface). | No producer in `src/` (grep). | `package/public-surface-golden.mjs` updated only as approved | 0 B |
| **U6** Guides and closing. | Update `src/instrumentation/AGENTS.md`: the owner table gains `presentation.ts`; delete the stale "progressive writes emit segments" line; the `db.namespace` choke point becomes `DriverIdentity`. Update `src/query-engine/AGENTS.md`, the cache guide, and the cache rows of `bundle-size-reduction-plan.md`. | — | Layer gates, run sequentially: client, drivers, instrumentation, query-engine, cache. Then `pnpm test:coverage:instrumentation`, which must stay at 100% with `presentation.ts` inside its glob. | final measure |

**Lines** (estimate). Net ≈ −300 production code lines before U5; U5 then takes −199, and ≈ −70 more if D2 is
approved.

- Core loses 722 (measured) and gains ≈60 of neutral producers (judgement).
- The extension gains ≈420 (judgement). The core forms carry threading, interfaces and dead routing that do not
  reappear.

## 5. Non-goals and stop conditions

Non-goals:

- No behaviour change to spans, log events, diagnostics output or thrown errors for an installed extension; the golden
  transcript decides.
- No change to the protected observer contract, and none to the public unit union except D2.
- No generic hook framework, event bus or public token, and the seam never becomes public API.
- Out of scope: the privileged rail (E3), the observed/unobserved duplication in `array-transaction-legacy.ts`
  (seam:public, 234 lines), and the cache capability inversion in `bundle-size-reduction-plan.md`.

Stop and report if any of these happens:

- a unit misses its measured lower bound (the seam grew back)
- the golden transcript diffs
- a witness needs an expectation change that D1/D2 did not approve
- pg-instrumented grows by more than 1,000 B over 558,221 (judgement threshold)
- s-only or ids-only move by more than ±20 B

## 6. Acceptance

**Bundle** (measured at the end):

- pg-representative ≤ 543,524 raw and ≤ 159,764 gzip, the measured lower bound. The target is ≈ 541,600 / 159,300
  (estimate, §2).
- sqlite3-representative drops by the same raw delta.
- s-only, ids-only and decimal-only move by at most ±20 B.
- pg-instrumented grows by at most 1,000 B over 558,221.

**Tests:**

- every U1–U4 witness, plus the byte-identical golden transcript
- `tests/package/{public-surface-golden,otel-absent-smoke}.mjs` and `tests/types/instrumentation/*`
- `tests/unit/instrumentation/**`, including the tracer suites
- the extended-local files named above
- instrumentation coverage at 100%

**Structure:**

- Core has no runtime import from `src/instrumentation`.
- No `SPAN_*`, `ATTR_*`, `LogEvent`, tracer or logger appears outside it.
- Core reads only `observesLifecycle`, `prewarm`, `diagnostics`, `wants` and `warn`.

**Guides:** updated as in U6.

**Open decisions for the owner:**

- **D1.** `Driver.getBaseAttributes()`, `Driver.getContextAttributes()` and `CacheDriver.getBaseAttributes()` are
  public `.d.ts` methods, because `Driver` is a public export. Recommendation: delete them; they are presentation, and
  only tests call them. Keeping them costs ≈200–300 B (judgement).
- **D2.** Delete the dead segment rail. It is part of the public `ObservationUnit` union and the
  `viborm/instrumentation` exports, and nothing in `src/` produces it.
- **D3.** Delete `perf-tracker.ts`. It is internal, and it is already row 3 of
  `loc-reduction-beyond-the-kernel.md`.
