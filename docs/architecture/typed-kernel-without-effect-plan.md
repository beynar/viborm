# Typed Kernel Without the Runtime — the "cheap 80%" Plan

**Date:** 2026-07-28
**Origin:** the Effect v4 adoption debate (see [effect-query-engine-research-2026-07.md](effect-query-engine-research-2026-07.md)). Verdict: kernel adoption declined for now — costs are fixed (µs-class per-op overhead, 16–30KB gzip on every user, beta runtime under the transaction diagnostics, forced TS 5.9) while most of the proposed value is capturable piecewise. This plan is the capture program: **~500 LOC, zero new dependencies, no compiler upgrade, no paradigm change.**

**Re-evaluation triggers for the declined kernel adoption** (record of decision): Effect v4 reaches stable/LTS with the finalizer-masking default fixed or officially composable; viborm is on TS ≥5.9 for its own reasons; demonstrated user demand for an Effect-native facade that a thin wrapper package (Drizzle-style edge adapter) cannot satisfy.

**What this plan deliberately does NOT capture** (the honest Effect-only residue): subtractive `catchTag` composition mid-pipeline, fiber supervision of transaction-callback children, `Exit`-terminated span structure. Re-price those at the triggers above.

**Unit-of-work convention:** same harness as the parity waves — implementer (commit-first) → contract attacker (independent probes) → theater attacker (falsify-by-mutation) → ≤2 fix rounds. Full estate + `pnpm test:gates` green per phase; docker legs at the end.

---

## Phase T1 — The typed error channel (~300 LOC, the core)

The lived evidence: V8003 — 77 capability-refusal sites surfaced as `INTERNAL_ERROR` for weeks (fixed by audit in `e109946`), then a second lane (W5-U2) built blind to the fix and was caught only by a hand-written runtime tripwire (`tests/errors/prisma-codes.test.ts`). The taxonomy exists; the signatures erase it. This phase gives it a static carrier through the existing Promise API.

| Unit | What | Context / files | Acceptance |
|---|---|---|---|
| T1-U1 | **Literal `code` discrimination** on every concrete error subclass (~24 classes across the 7 files in `src/errors/`): each declares `override readonly code: typeof VibORMErrorCode.<X>` so the instance type carries a literal, reusing the established public discriminant. No `_tag`, no new taxonomy, no runtime change. | `src/errors/{base,constraints,query,validation,transaction,cache,migrations}.ts`. The base class keeps the wide `VibORMErrorCode`; subclasses narrow. Serialization, `prismaCode`, `instanceof` untouched. | Type probes: `if (e.code === VibORMErrorCode.UNIQUE_CONSTRAINT)` narrows `e` to `UniqueConstraintError`; an exhaustive `switch` over a union member's codes compiles with a `never` guard; adding a fake code to one class breaks the guard (falsify locally, revert). Runtime: serialized shape byte-identical (snapshot two errors). |
| T1-U2 | **`normalizeDriverError` returns the union it constructs.** Signature only: `Error` → `DriverFailure = UniqueConstraintError \| ForeignKeyError \| NotNullConstraintError \| CheckConstraintError \| ValueTooLongError \| NestedWriteAssertionError \| TransactionError \| QueryError` (+ the connection variant for `normalizeDriverConnectionError`). Construction logic untouched. | [error-mapping.ts:63](../../src/drivers/error-mapping.ts) — the function builds eight precise classes and erases them at the return. 15 call sites across `driver.ts`, `driver-instrumentation.ts`, `driver-transaction-base.ts`, `execution-context.ts` must still compile unchanged. | `tsc` clean; a type test pins the union's exact members (so adding a class to the mapper without adding it to the union is a compile error); full estate green (behavior identical — types only). |
| T1-U3 | **One `classifyFailure(u: unknown): QueryFailure \| EngineDefect` seam** for the executor/routing catch sites, encoding the semantics audit the Effect doc demanded: `UnsupportedOperationError` (V8003) = *expected refusal* despite extending `QueryEngineError`; bare `QueryEngineError` = *defect*; driver failures = expected; unknown throwables = defect. Retry policy (`isRetryableError`, `isRetryableRace`) switches on literal codes with a `never`-guarded exhaustive switch instead of class sniffing. | [OperationExecutor.ts:96-107](../../src/query-engine-v2/OperationExecutor.ts) (`Promise<T>`, catch unknown), [routing.ts:136-148](../../src/query-engine-v2/routing.ts) (`catch (error)` + runtime classifier). The race-retry once-only policy is UNCHANGED — this types the classification, it does not alter what retries. | The W5-U2 bug class becomes compile-time: remove one code from the classifier's switch → `never` guard fails to compile (falsify, revert). Race-retry conformance suite byte-identical. Zero new runtime branches on the hot path (the classifier replaces existing checks, not adds to them). |
| T1-U4 | **Document public `error.code` narrowing** — users get compiler-checked `if (e.code === "V3001")` today through the Promise API. | `docs/content/docs/client/` errors page + a mention in the compatibility/errors section. | Doc examples compile as written (probe them). |

**Phase gate:** `pnpm test:types`, full estate, `test:gates` — and the parse-boundary ratchet must not grow (this phase adds no casts; the classifier is a boundary function).

---

## Phase T2 — Deterministic time (~50–100 LOC)

The flake surface: **nine real sleeps of 40–100ms** in [cache.test.ts](../../tests/cache/cache.test.ts) (lines ~209, 266, 301, 336, 350, 380, 394, 423, 437) and **four** in [transaction-options-behavior.test.ts](../../tests/drivers/transaction-options-behavior.test.ts) (60/100/200/200ms) — ≥1s of pure wall-clock per run and the only timing-dependent tests in the estate. Effect's TestClock fix requires adopting Effect; vitest's fake timers + a seam do not.

| Unit | What | Context | Acceptance |
|---|---|---|---|
| T2-U1 | **Clock seam**: a tiny injectable `{ now(): number; setTimeout/clearTimeout }` used by cache TTL/SWR timing and the transaction-timeout timer. Default = real clock; construction accepts an override (internal, not public API). | Find every `Date.now()` / `setTimeout` in `src/cache/` and the W5-U3 transaction-timeout path; route them through the seam. Do NOT touch driver-internal timers. | Zero behavior change with the default clock: full estate green before any test conversion. |
| T2-U2 | **Convert the 13 sleeps** to virtual time: inject the test clock (or `vi.useFakeTimers` where safe) and `advanceTimersByTimeAsync`. ⚠️ Care: DB driver I/O is real async — never globally fake timers around live PGlite calls; prefer the injected seam so only cache/timeout logic sees virtual time. | The 13 listed sleeps. | The 13 sleeps are gone (grep); the cache + tx-options files' wall-clock drops measurably (record before/after durations); assertions unchanged; 20 consecutive runs, zero flakes (`vitest run --repeat` or a loop). |

---

## Phase T3 — ALS spike (timeboxed, go/no-go — NOT committed by default)

The target: the `driverOverride` cascade (**17 mentions across 4 files**: `pending-operation.ts` → `routing.ts` → `OperationExecutor.ts` → driver) plus `QueryEngine.bind(driver)` cloning an engine per transaction binding — two mechanisms for "which driver is current" — and correlation/attribution threading through the driver layers. `AsyncLocalStorage` can carry both ambiently at ns-class cost.

| Unit | What | Constraints | Go/no-go criteria |
|---|---|---|---|
| T3-U1 | Spike: an ALS store carrying `{ currentDriver?, attribution }`; replace the override threading + correlation params on ONE representative path (single read + callback transaction). | **Doctrine rule** (same rule the Effect doc set for Context): the store carries infrastructure identity ONLY — never models, args, fragments, or planner state. **Workers constraint**: ALS on Cloudflare requires the `nodejs_compat`/`nodejs_als` flag — the D1/Workers story must be verified, not assumed; a dual explicit/ambient code path is an automatic no-go. | GO if: overhead ≤ ~100ns/op on the embedded path (measure); Workers compat is a documented flag requirement viborm can accept for D1 users; the deletion ledger is net-negative (override mentions + `bind()` cloning removed > ALS plumbing added). NO-GO → keep explicit threading; T1's typed seam stands alone; record the measurement in this doc. |

### T3-U1 — **NO-GO.** Explicit threading stays.

The spike was built and run, and is **not committed**, per this phase's contract. It carried `{ currentDriver?, attribution }` in one module-scope `AsyncLocalStorage`, replaced the `driverOverride` parameter through all four layers (`pending-operation.ts` → `routing.ts` → `OperationExecutor.ts` → `PendingOperationV2.ts`), and entered the scope at the callback-transaction seams in `client.ts`. It type-checked clean and, once complete, passed the transaction and cache suites (99 + 8 + 197). All three go/no-go criteria were then measured, and **all three fail**. A fourth thing turned up that outranks them.

**The finding that decides it: the store silently converts a named refusal into silent participation.** viborm already refuses to let the *originating* client be used while its single connection is transaction-bound — [driver-transaction-base.ts:67](../../src/drivers/driver-transaction-base.ts), a typed `TransactionError` reading *"cannot use the originating client while its single connection is transaction-bound. Use the transaction client supplied to the callback."* A probe that creates a write on the ROOT client and awaits it lexically inside `client.$transaction(cb)` gets exactly that refusal today. Under the ambient store the identical program **succeeds silently**: the root client's operation reads the transaction's driver out of the air, joins a transaction it was never handed, and rolls back with it. That is not a spike defect — it is what ambient context *means*, and it is unfixable without asking "was this operation lexically enclosed, or merely temporally enclosed?", a question the store cannot answer. The whole estate stayed green through it: no test names that message, so nothing caught the reversal.

The same hazard showed up once more, cheaply. The first spike entered the scope at the outer callback seam but not the nested one; six nested-transaction contracts failed, because operations inside a SAVEPOINT kept reading the *outer* driver ambiently. Under explicit threading a forgotten driver is a parameter the compiler asks for; under the store it is a silent misroute found only if a test happens to cover that nesting depth.

**Criterion 1 — overhead: FAILS, and fails differently on each Node.** Measured on Node v24.18.0. The end-to-end arm the criterion names cannot decide it: on PGlite a `findUnique` costs ~150µs/op and a callback transaction ~276µs/op, so the ±5–15µs run-to-run spread is **50–150× the 100ns threshold**. Both arms were run twice; the between-arm difference was no larger than the same arm's between-run difference, and both differences pointed the wrong way (ALS nominally *faster*). Recorded as unresolvable, not as a pass.

Where the threshold *is* resolvable — an isolated A/B in which both arms allocate a per-iteration scope object and a per-iteration closure, so the only difference is the context entry:

| Node 24 AsyncLocalStorage implementation | explicit call | `als.run` + `getStore` | delta |
|---|---|---|---|
| `AsyncContextFrame` (**the Node 24 default**) | 0.9 ns/op | 160.4 ns/op | **+159.5 ns/op** |
| legacy `async_hooks` (`--no-async-context-frame`; what Node 18/20/22 run) | 0.8 ns/op | 8.0 ns/op | +7.2 ns/op |

`getStore()` itself is cheap either way (~7ns / ~4ns); the cost is entering a scope — 142.6 ns/op for run + 1 read, 168.8 ns/op for run + 6 reads, so an adoption that reads the store more often barely moves it. On the current default runtime the entry alone is **1.6× the whole budget**.

The older implementation is cheap per entry and expensive everywhere else. A control measuring an 8-await promise chain that *never touches any store*, ns/op:

| implementation | no `node:async_hooks` | imported only | **one ALS constructed, never entered** | entered once |
|---|---|---|---|---|
| `AsyncContextFrame` (Node 24 default) | 284.4 | — | 284.0 | 300.7 |
| legacy `async_hooks` (Node 18–22) | 273.5 | 280.8 | **812.5** | 817.7 |

Merely *constructing* an `AsyncLocalStorage` at module scope — which the spike does, in viborm's core import graph — triples the cost of unrelated promise chains on the legacy implementation: **+539 ns per 8-await chain, ~+65 ns per `await`, process-wide**, paid by the host application's own async work whether or not it ever opens a transaction. Replicated three times including reversed run order (285.0/850.0, then 845.6/282.3). Importing the module is free; constructing is what arms it. `package.json` declares `engines: node >= 18`, so today most users are on the arm that pays this. The tradeoff is not "ns-class either way" — it is *pay ~160ns per context entry, or tax every `await` in the consumer's process*, and the plan's premise that ALS "can carry both ambiently at ns-class cost" holds on neither.

**Criterion 2 — Workers: technically satisfiable, but only by reversing a standing decision.** Verified against Cloudflare's docs rather than assumed: `node:async_hooks` is not importable without a flag; `nodejs_als` enables AsyncLocalStorage alone, `nodejs_compat` the broader surface, and Cloudflare states it does *"not expect the `nodejs_compat` to become active by default at a future date"*. Workers' ALS also omits `enterWith()` and `disable()` — which the spike does not need, but which constrains any future design. So the D1 story is one documented `compatibility_flags` line, which on its own the criterion permits. It is *not* free here: this repo already decided the other way, in [query-engine-correctness-remediation-plan.md](query-engine-correctness-remediation-plan.md) §5.3 — *"Keep D1's default path free of `nodejs_compat` if the implementation no longer needs it"* — and paid for it, rewriting `src/drivers/shared/sqlite-utils.ts` onto `ArrayBuffer`/`ArrayBufferView` to drop the global `Buffer` read that used to force the flag. A module-scope ALS import in core hands that requirement straight back, and makes it unconditional: without the flag the Worker does not start. The only way to avoid that is a guarded import with an explicit-threading fallback — **the dual explicit/ambient code path this row already declares an automatic no-go.**

**Criterion 3 — deletion ledger: net POSITIVE (the wrong sign).** The spike removed 16 of the 17 `driverOverride` mentions (the 17th is prose in a doc comment) and cost, measured on its own diff: **+46/−43 across five files (net +3 lines), plus a 35-line store module — net +38 lines added.** And the `bind()` half of the claim does not exist. `QueryEngine.bind()` is 12 lines, but it does not only rebind a driver: it mints a fresh `scopeId` symbol, and that symbol identity is the entire mechanism behind `assertOperationOwnership` and the user-facing `OPERATION_SCOPE_MISMATCH` refusal (*"the operation was created outside this transaction scope"*, pinned in `tests/client/nested-transaction-contract.test.ts`). A store cannot supply per-scope identity without a per-scope object — which is `bind()`. Deleting it would leave every operation sharing one `scopeId` and that guard permanently silent. Beyond identity, 29 `engine.driver` reads across 13 files would each need re-auditing for whether they run inside the ambient scope *at the moment they run* — many are construction-time capability reads (`supportsBatch`, `supportsReturning`, dialect) reached through `resolveOperation()`, and some seams (`cacheKeyArgs()`, `prepare()`) are called by the cache flow outside the execution scope entirely. That is a per-callsite temporal question with no compiler assistance, which is the same class of defect the six nested-transaction failures already demonstrated.

**Disposition.** Explicit threading is kept. The `driverOverride` parameter and `bind()` are not two competing mechanisms for one concept, which was the premise: `bind()` carries *scope* identity (and the refusals built on it) and `driverOverride` carries *driver* identity for the one seam that borrows a caller's transaction. T1's typed seam stands alone and depends on none of this. Re-open only if all of: the entry cost on the then-default Node implementation lands under budget, `AsyncContextFrame`'s no-global-penalty property reaches the versions viborm supports so there is one cost story rather than two, and the ambient-capture reversal above has an answer that is not "document it".

---

## Phase T4 — Observability plumbing cleanup (~50 LOC)

| Unit | What | Context | Acceptance |
|---|---|---|---|
| T4-U1 | **Kill the `logged` expando.** Replace the stamp at [driver-instrumentation.ts:316](../../src/drivers/driver-instrumentation.ts) (`Object.defineProperty(error, "logged", …)`) and the probe at [execution-context.ts:179](../../src/query-engine/execution-context.ts) (`Reflect.has(error, "logged")`) with a `WeakSet<Error>` owned by the shared instrumentation context (both layers already resolve the same instrumentation object — find the shared home). | Fixes three defects of the current mechanism: the invisible cross-layer convention, the mutation of user-visible error objects (callers currently receive errors wearing `logged: true`), and the frozen-error double-log hole the code itself documents at `driver-instrumentation.ts:321-322`. | A caught public error has NO `logged` property (new pin); statement+operation double-logging still deduplicated (existing behavior); **frozen errors now dedup too** (new capability — pin it); falsify: remove the `WeakSet.add` → the dedup test fails. |
| T4-U2 (optional) | Collapse the duplicated catch→normalize→log→rethrow blocks in `observeOperationExecution` (:80-103) and `observePendingBatchPhase` (:124-153) into one helper. Pure deduplication; skip if the two paths' differences (normalize-with-forceContext vs isUnloggedError) resist a clean shared shape. | `src/query-engine/execution-context.ts` | Behavior byte-identical (both paths' log events unchanged — snapshot the emitted events). |

**T4-U1 delivered**, but not where this row predicted. The premise above — "both layers already resolve the same instrumentation object" — was measured before being built on, and it is false: `snapshotExecutionContext` mints a fresh frozen *copy* of the instrumentation on every call, so two snapshots of one client's instrumentation are different objects, and a `WeakSet` owned by that context would be empty on the reading side — every failure logged twice, the opposite of the fix. Only the `logger` itself crosses by reference. The set therefore lives in `src/instrumentation/logged-errors.ts` at module scope; `src/instrumentation/AGENTS.md` Rule 2 carries the carve-out (a `WeakSet` keyed by short-lived errors retains nothing across a request, which is what that rule protects). All three acceptance pins hold, including the new frozen-error capability, in `tests/instrumentation/logged-error-dedup.test.ts` — falsified by dropping the mark, by restoring the expando, and by marking unconditionally.

**T4-U2 skipped**, on the escape clause in its own row. The two blocks share a six-line shape and differ on five axes: which error is logged, which error is *rethrown* (the batch path replaces the caller's error with an attributed clone; the operation path preserves it), whether logging is gated at all, whether the payload is sanitized, and where the logger and the model/operation attribution come from. One helper spanning both needs a transform, a predicate and a payload callback — six parameters for two call sites, and it would hide the single asymmetry that matters, that only one path substitutes the caller's error. The one callback-free extraction available (the emit-and-swallow fragment) saves ~7 lines while adding a third spelling of a pattern `logQuery` also carries with a different event builder. Left as two readable blocks.

---

## Phase T5 (optional, fully independent) — TypeScript 5.9 upgrade on our own schedule

Nothing in T1–T4 requires this. It exists so the compiler bump happens with zero features riding on it — the cheapest and safest it will ever be — and so a future Effect re-evaluation (or any dependency that raises its TS floor) finds the prerequisite already met. It can run before, after, or never, without affecting the other phases.

| Unit | What | Context | Acceptance |
|---|---|---|---|
| T5-U1 | Bump `typescript` and the pinned twin `@ark/attest-ts-default` (both currently 5.8.3, `package.json`) to the same 5.9.x, in an isolated PR with NOTHING else in it. | The type system is the product: the recursive-model `any`-collapse workaround (`RelationState.getter` stays `any`) and the ~31-level instantiation ceiling are compiler-version-sensitive; the published `.d.mts` surface is compiler output. | **All measured, before/after:** (1) `pnpm test:types` wall-clock (check-time budget: no regression >10%); (2) the FULL `expectTypeOf` estate green — especially deep include results on mutually-recursive fixtures still inferring precisely, not `any`; (3) the x1b TS-ceiling test — record where the literal-depth ceiling lands under 5.9 (it may move either direction; a drop below ~30 is a blocker); (4) contextual-typing gate file green (the typo probes); (5) `.d.mts` diff of the published entrypoints reviewed — inference-visible changes enumerated, not assumed benign; (6) full runtime estate (types don't change runtime, but the build does — cheap insurance). |

If any gate fails, the PR closes with the measurement recorded here and 5.8.3 stays — at zero cost to T1–T4.

### T5-U1 — DELIVERED (2026-07-29). All six gates measured, all green; 5.9.3 adopted.

1. **Check-time: 50.8s → 17.9s (−65%).** `tsc --noEmit` wall-clock, two runs each side (5.8.3: 50.98/50.69s; 5.9.3: 18.74/16.96s). The criterion allowed a 10% regression; 5.9 instead nearly tripled check speed on this codebase.
2. **expectTypeOf estate green** — the full typecheck covers every assertion; deep include results on the mutually-recursive fixtures still infer precisely.
3. **Literal-depth ceiling: unchanged at 32-OK / 34-FAIL.** Active probes (generated rich-literal chains in the x1b fixture shape) on both compilers: depth 32 compiles, 34/40/48 fail with TS2321, identically on 5.8.3 and 5.9.3. Correction for the record: the "30 OK / 32 fail" figure in the x1b header was already stale at HEAD *on 5.8.3* — the parity waves' type changes had moved the ceiling to 32/34 before this bump. The ~30 blocker threshold is comfortably met.
4. **Contextual-typing gate green** (typo probes are `@ts-expect-error`, covered by the clean typecheck; runtime file green in the estate).
5. **`.d.mts` diff reviewed and enumerated:** all 25 published entrypoints byte-identical modulo shared-chunk hash renames; two of three shared chunks identical; the third differs by 36 lines that are **member reordering only** (the `InferOutputShape` union-arm order and the `increment`/`onConflict`/`onConflictUpdate` member positions) — no member added, removed, or retyped.
6. **Full runtime estate: 8,220 passed / 0 failed; gates 62/62.**


## Phase T6 — `await using` support (Scope pillar, standard-library edition)

Deterministic resource disposal via the platform's own protocol — no runtime, no dependency. `await using client = createClient({...})` disposes the client (and its driver) when the block exits, including on throw.

**T6-U1 — DELIVERED.** `[Symbol.asyncDispose]` on the root client (→ `$disconnect()`) and on the `Driver` base (→ `disconnect()`), both guarded on the resolved runtime key in [async-dispose.ts](../../src/drivers/async-dispose.ts). `TransactionBoundDriver` inherits the member and is disposal-inert for free — its `disconnect()` override is already a no-op — and the interactive `tx` client never exposes the member at all, so the scope decision holds on both halves. Witnesses: [tests/drivers/async-dispose.test.ts](../../tests/drivers/async-dispose.test.ts) (11).

**Consumer type floor — MEASURED, and it did not move.** A bare `[Symbol.asyncDispose]` computed key in a published `.d.mts` needs `SymbolConstructor.asyncDispose` to be declared before the file will type-check at all, which would tax every consumer including the ones who never write `await using` (isolated probe: bare form → `TS2550`; mapped-key form → clean). So the member is carried by `AsyncDisposeMember`, a mapped type over a conditional key that resolves to `never` — and therefore to `{}` — when the symbol is undeclared.

Measured on the built artifact, before and after, by [scripts/consumer-type-floor.mjs](../../scripts/consumer-type-floor.mjs) (`pnpm test:package:consumer-floor`), three arms each falsified independently:

- **Floor (unchanged):** `lib: ["es2022"]`, `skipLibCheck: true`, no configured `@types/node` — clean before T6 and after. Under `skipLibCheck: false` the published surface carries exactly **one** own-`dist` error both before and after (a pre-existing `StandardSchemaOf` naming fault in `@standard-schema/spec`, unrelated to this phase and left for its own lane).
- **Isolation:** viborm's disposal carrier, lifted verbatim out of the emitted `.d.mts` and compiled with *no* ambient types, type-checks. This is the arm that fires if anyone swaps the mapped key back for a bare one.
- **Capability:** the same carrier still yields a real `AsyncDisposable` where the symbol *is* declared — so "degrade away for everybody" cannot pass as a floor result.

Honest caveat on method: a probe that merely imports the published entrypoints cannot establish this, because viborm's own dependency graph drags `@types/node` in transitively (via `@types/pg`'s `/// <reference types="node" />`), and `@types/node` unconditionally polyfills `SymbolConstructor.asyncDispose` in `compatibility/disposable.d.ts`. The isolation arm exists precisely to answer the question the whole-package probe cannot.

To *use* `await using`: `lib` including `esnext.disposable` (TS ≥5.2) **or** `@types/node` ≥20, plus a runtime with the symbol (Node ≥18.18). Repo `tsconfig.json` gained `esnext.disposable` so the source states its own requirement instead of inheriting it by accident from `@types/node`.

The unit as originally specified:

| Unit | What | Context | Acceptance |
|---|---|---|---|
| T6-U1 | Implement `[Symbol.asyncDispose]` on the root client (delegating to `$disconnect()`) and on the driver base class (delegating to its close path). SCOPE: root client + drivers only — the interactive `tx` client is NOT disposable (disposing mid-transaction from a `using` block would fight the transaction lifecycle; the tx driver's ownership stays with `$transaction`). Guard the definition for platforms where the well-known symbol is absent. | `src/client/client.ts` ($disconnect exists), `src/drivers/driver.ts` base. TS: `Symbol.asyncDispose` typing needs the `esnext.disposable` lib (TS ≥5.2 — fine on 5.8.3); check `tsconfig.json` lib and add if missing. | Runtime: an `await using` block disposes → driver closed (probe with a connection-state check); dispose is idempotent with an explicit `$disconnect()` (no double-close throw); disposal on exception paths (throw inside the block → still closed). Type: client assignable to `AsyncDisposable`. **Consumer floor documented**: a minimal-consumer probe establishes the smallest `lib`/`@types/node` configuration under which the published `.d.mts` still compiles for users who never use `await using` — if the symbol member forces a lib requirement on non-users, restructure (e.g. interface merge) until it degrades gracefully, and record the floor in the docs. |

## Phase T7 — The errors-registry gate (house-style insurance for T1)

One structural test making an incompletely-added error class a NAMED test failure instead of a latent gap — the generalization of the `prisma-codes.test.ts` tripwire that caught W5-U2 building blind to V8003.

| Unit | What | Context | Acceptance |
|---|---|---|---|
| T7-U1 | `tests/errors/error-registry-gate.test.ts`: enumerate every concrete error class (single canonical list in the test, pinned by count like the house censuses) and assert each appears in ALL of: (1) the `DriverFailure`/`QueryFailure` unions (type-level probe); (2) `classifyFailure`'s switch — table-driven: construct an instance of each class, assert its classification (expected-failure vs defect) matches the pinned table; (3) the `prismaCode` map — returns the pinned code, or is explicitly listed in the no-Prisma-equivalent allowlist (viborm-only classes); (4) the user-facing errors docs table (`readFileSync` the docs page, assert the code string is present — same source-scan idiom as `architecture-gates`). Failure messages name the class AND the missing surface. Wire into the `test:gates` script list in `package.json`. | Depends on T1 (unions + `classifyFailure` must exist). Subsumes/extends the existing exhaustiveness tripwire in `tests/errors/prisma-codes.test.ts` — merge or reference, don't duplicate. | Falsify each arm: remove one class from the union → named failure; comment one `classifyFailure` case → named failure; drop a docs row → named failure; restore each. `pnpm test:gates` count grows by the new file, deliberately. |

**T7-U1 DELIVERED** as [tests/errors/error-registry-gate.test.ts](../../tests/errors/error-registry-gate.test.ts) (17 tests), wired into `test:gates`, which grows **43 → 60**.

The registry is 23 rows — every concrete `VibORMError` subclass — and it is not hand-trusted: the gate parses all 403 `.ts` files under `src/`, walks each class's `extends` chain by name, and derives the concrete subclasses from the source. A class declared anywhere in the tree without a row is a named failure, and the resolution is transitive (falsified with a `CacheStampedeError extends CacheConfigurationError`, which the scan found two links from the root). The count is pinned on both sides, registry and source.

Two surfaces did not land the way the row above predicted, and the gate states what is actually there rather than what was planned:

- **`QueryFailure` is not a union of classes.** T1-U3 shipped it as the classification *result* — `{ kind: "failure"; error: VibORMError; retryable }` — so "is the class in the union" has no meaning for it. The arm asks the question that does exist: every registered class is assignable to the carrier (`expectTypeOf<RegisteredError>().toExtend<QueryFailure["error"]>()`), and at runtime `classifyFailure` hands the *identical instance* back on the failure arm. `DriverFailure` is a real union and gets the real treatment: its members are read out of `src/drivers/error-mapping.ts` by AST so a miss can be *named*, and a local census union is pinned to the shipped alias with `toEqualTypeOf` so the source scan cannot drift from what the compiler sees. `error-code-discrimination.test.ts` writes that same union locally to pin narrowing; tying it to the shipped alias is the one thing it does not do, and now something does.
- **The docs arm is three checks, not one.** Per class: a row exists, and that row lists the class's code. Plus the reverse (no docs row names an unregistered class) and the whole-code-space check (every `VibORMErrorCode` appears backticked somewhere on the page — the table rows, or the closing reserved-codes sentence, which is what fires for `V4003`/`V6002`/`V6003`).

No duplication with the neighbours: `prisma-codes.test.ts` keeps the CODE axis (every code claimed or documented unclaimed, plus serialization); this gate takes the CLASS axis (each class's constructed instance publishes its pinned code, or sits on the spelled-out viborm-only allowlist of 14). `failure-classification.test.ts` keeps the retry policy and per-code dispositions; this gate asserts only expected-vs-defect, for every class, by census.

Falsified arm by arm, each restored: drop `ValueTooLongError` from `DriverFailure` → named failure *and* `tsc` red at the mapper; comment `case CACHE_INVALID_TTL` out of `verdictFor` → "CacheInvalidTTLError classifies as a defect; classifyFailure's switch is missing the failure disposition for V10001"; delete the `FeatureNotSupportedError` docs row → named; delete the reserved-codes sentence → three named codes; delete `VALUE_TOO_LONG` from `PRISMA_CODE_BY_VIBORM_CODE` → named with the map's file and symbol.

## Ordering and parallelism

```
T1 (errors)  ∥  T2 (clock)  ∥  T4 (expando)  ∥  T6 (asyncDispose)   — disjoint files, 4 parallel lanes
        │                          │
    T7 (registry gate)         T3 spike        — T7 after T1; T3 after T4 (shares execution-context.ts), timeboxed
                    │
   Final gate: full estate, test:gates, docker legs (mysql 3307 / pg 5434), lint-vs-main baseline
```

Rough total: T1 = M, T2 = S, T4 = S, T6 = S, T7 = S, T3 = timeboxed spike. One workflow with four lanes + two followers + review + gate fits the established harness.

### The four lanes merged — integration record

The first wave (T1, T2, T4, T6) landed on `prisma-parity-v2` by cherry-pick in that order, nine commits, **zero conflicts in code**. The only textual collision was this document, which T4 and T6 both append to in different sections; it auto-merged and both dispositions are intact above.

The one overlap the merge was watching — T1 and T4 both reaching into `src/query-engine/execution-context.ts` — turned out to be orthogonal at the line level and compatible at the type level. T4 replaced the expando probe (the `isErrorLogged` import and `isUnloggedError`); T1 retyped what `normalizeDriverError` hands back at the `attributed` binding in the same file. The narrowed return (`DriverFailure | VibORMError`) flows through T4's rewritten guard without a cast.

Measured on the merged tree, nothing else running:

- `pnpm test:types` — clean.
- Full estate, once, `--minWorkers=1 --maxWorkers=4` — **8198 passed, 0 failed**, 246 files (4 skipped). Baseline at the merge base was 8108.
- `pnpm test:gates` — **43/43**, unchanged. The parse-boundary ratchet is one of those four files, so T1's phase gate ("must not grow") is checked by the count holding, not by assertion.

**The delta is fully accounted for.** The seven new files the lanes contribute carry exactly 90 tests (35 + 14 + 13 + 11 + 6 + 5 + 6), and 8108 + 90 = 8198. That arithmetic is the integration's real witness: it says no pre-existing test was dropped, retargeted, or silently flipped to skipped by four lanes editing in parallel — a thing a green run alone does not prove.

Lint is at its pre-existing baseline, not improved and not worsened. `src/cache/driver.ts` reports three `noNegationElse` findings; all three exist verbatim at the merge base (lines 218/268/575 there, shifted to 226/276/583 by T2's clock insertions). Running Biome against test files by path also emits the repo's standing globals noise — an untouched control file produces 31 of the same errors.

Still open after this wave, carried deliberately: docker legs (mysql 3307 / pg 5434) and benchmarks belong to the final gate, not to the merge; `classifyFailure`, `QueryFailure`, `EngineDefect` and `DriverFailure` are exported from `@errors` but **not** from `src/index.ts`, so making them public API remains a maintainer decision that T7 does not depend on; and T1 filed two pre-existing defects it found but did not fix — `getCloneConstructor` losing class identity for three error classes on re-normalization (which is *why* U2's public signature cannot be the bare union), and `raceableQueryFailure`'s `raceable` flag being dropped on the `query` arm.

## What success looks like

- The W5-U2 bug class (building blind to an error-code change) is a **compile error**, not an audit finding or runtime tripwire.
- `normalizeDriverError`'s union is visible at all 15 call sites; retry classification is exhaustively checked.
- Zero timing sleeps in the estate; the two flaky-by-construction files are deterministic.
- Users can narrow on `error.code` with compiler support, documented.
- Caught errors are no longer mutated by instrumentation.
- `await using client` disposes deterministically, with the consumer type floor documented.
- Adding an error class incompletely (union, classifier, prismaCode, docs) is a named gate failure, not a latent gap.
- The Effect decision + measurements are recorded here, with honest triggers to reopen.
