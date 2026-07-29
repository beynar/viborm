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

## Phase T6 — `await using` support (Scope pillar, standard-library edition)

Deterministic resource disposal via the platform's own protocol — no runtime, no dependency. `await using client = createClient({...})` disposes the client (and its driver) when the block exits, including on throw.

| Unit | What | Context | Acceptance |
|---|---|---|---|
| T6-U1 | Implement `[Symbol.asyncDispose]` on the root client (delegating to `$disconnect()`) and on the driver base class (delegating to its close path). SCOPE: root client + drivers only — the interactive `tx` client is NOT disposable (disposing mid-transaction from a `using` block would fight the transaction lifecycle; the tx driver's ownership stays with `$transaction`). Guard the definition for platforms where the well-known symbol is absent. | `src/client/client.ts` ($disconnect exists), `src/drivers/driver.ts` base. TS: `Symbol.asyncDispose` typing needs the `esnext.disposable` lib (TS ≥5.2 — fine on 5.8.3); check `tsconfig.json` lib and add if missing. | Runtime: an `await using` block disposes → driver closed (probe with a connection-state check); dispose is idempotent with an explicit `$disconnect()` (no double-close throw); disposal on exception paths (throw inside the block → still closed). Type: client assignable to `AsyncDisposable`. **Consumer floor documented**: a minimal-consumer probe establishes the smallest `lib`/`@types/node` configuration under which the published `.d.mts` still compiles for users who never use `await using` — if the symbol member forces a lib requirement on non-users, restructure (e.g. interface merge) until it degrades gracefully, and record the floor in the docs. |

## Phase T7 — The errors-registry gate (house-style insurance for T1)

One structural test making an incompletely-added error class a NAMED test failure instead of a latent gap — the generalization of the `prisma-codes.test.ts` tripwire that caught W5-U2 building blind to V8003.

| Unit | What | Context | Acceptance |
|---|---|---|---|
| T7-U1 | `tests/errors/error-registry-gate.test.ts`: enumerate every concrete error class (single canonical list in the test, pinned by count like the house censuses) and assert each appears in ALL of: (1) the `DriverFailure`/`QueryFailure` unions (type-level probe); (2) `classifyFailure`'s switch — table-driven: construct an instance of each class, assert its classification (expected-failure vs defect) matches the pinned table; (3) the `prismaCode` map — returns the pinned code, or is explicitly listed in the no-Prisma-equivalent allowlist (viborm-only classes); (4) the user-facing errors docs table (`readFileSync` the docs page, assert the code string is present — same source-scan idiom as `architecture-gates`). Failure messages name the class AND the missing surface. Wire into the `test:gates` script list in `package.json`. | Depends on T1 (unions + `classifyFailure` must exist). Subsumes/extends the existing exhaustiveness tripwire in `tests/errors/prisma-codes.test.ts` — merge or reference, don't duplicate. | Falsify each arm: remove one class from the union → named failure; comment one `classifyFailure` case → named failure; drop a docs row → named failure; restore each. `pnpm test:gates` count grows by the new file, deliberately. |

## Ordering and parallelism

```
T1 (errors)  ∥  T2 (clock)  ∥  T4 (expando)  ∥  T6 (asyncDispose)   — disjoint files, 4 parallel lanes
        │                          │
    T7 (registry gate)         T3 spike        — T7 after T1; T3 after T4 (shares execution-context.ts), timeboxed
                    │
   Final gate: full estate, test:gates, docker legs (mysql 3307 / pg 5434), lint-vs-main baseline
```

Rough total: T1 = M, T2 = S, T4 = S, T6 = S, T7 = S, T3 = timeboxed spike. One workflow with four lanes + two followers + review + gate fits the established harness.

## What success looks like

- The W5-U2 bug class (building blind to an error-code change) is a **compile error**, not an audit finding or runtime tripwire.
- `normalizeDriverError`'s union is visible at all 15 call sites; retry classification is exhaustively checked.
- Zero timing sleeps in the estate; the two flaky-by-construction files are deterministic.
- Users can narrow on `error.code` with compiler support, documented.
- Caught errors are no longer mutated by instrumentation.
- `await using client` disposes deterministically, with the consumer type floor documented.
- Adding an error class incompletely (union, classifier, prismaCode, docs) is a named gate failure, not a latent gap.
- The Effect decision + measurements are recorded here, with honest triggers to reopen.
