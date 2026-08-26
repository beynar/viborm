# Client Extension Plan

**Status:** superseded by
[client-extension-final-plan.md](client-extension-final-plan.md); retained as
historical design research, not current API documentation
**Scope:** the client extension mechanism, the re-expression of client omit,
cache, and instrumentation on it, and the userland RBAC recipe
**Method:** designed against a three-scout survey of main @ `edf22a74`, then
attacked by four independent adversarial reviews (mechanism truth, ELEGANCE
concept count, type budget/DX, semantics/security). Every correction below
cites the finding that forced it. Raw record:
scout + review transcripts in the session workspace.

All API sketches and built-in `createClient` configuration examples below are
historical evidence. The implemented contract has six capabilities and the
official `cache()`, `instrumentation()`, and `defaultOmit()` extensions described
by the final architecture record. This document is intentionally not rewritten,
so the rejected alternatives and review trail remain inspectable.

## 1. The one idea

The client pipeline is already a chain of single-owner derivations, and the
estate has already grown private coordination mechanisms for exactly the
features extensions must host. An extension is **a named value whose members
attach to those joints, made public** — no hook registry, no event emitter,
no plugin manager, no new pipeline. A client with no extensions composes to
today's functions (each seam host checks emptiness once at construction, so
the measured fast-path bypasses survive by construction).

The concept budget, final:

```ts
interface VibExtension {
  readonly name: string;                                   // identity: errors, ordering, ctx.own
  args?: (ctx: ExtensionContext, args: Args) => Args;      // sync, RAW args, pre-validation
  operation?: (ctx: ExtensionContext) =>                   // per-call selector…
    OperationWrapper | undefined;                          // …returning an async around-wrapper
  writesVisible?: (ctx: ExtensionContext) => void | Promise<void>;  // at-least-once durability signal
  client?: Record<`$${string}`, ClientMethod>;             // additive $-methods, explicitly typed
}
type OperationWrapper = (ctx: ExtensionContext, next: () => Promise<unknown>) => Promise<unknown>;

createClient({ schema, driver, omit: {...}, cache: kv, extensions: [rbac(getRole), audit()] })
```

**Five members. One frozen per-call context. Two derived rules. Zero
declarations.** `defineExtension(...)` is the sole factory; it accepts a
construction thunk `(build: { schema, relations }) => members` so an
extension can validate its config against the resolved topology and fail
the client build (the `createClientOmitResolver` precedent; a thrown
non-`VibORMError` is wrapped with `meta.extension = name`).

The per-call context is ONE object, deliberately non-generic in the schema
(the `RelationState.getter: any` collapse forbids typing `ctx.model` as
`C["schema"][K]` — review T, survives-note):

```ts
interface ExtensionContext {
  readonly modelName: string;
  readonly operation: Operations;
  readonly own: Record<string, unknown>;   // this extension's per-call scratchpad
  validatedArgs(): Record<string, unknown>; // read-only; forces resolve; read families only
                                            // (cacheKeyArgs() semantics, incl. its refusal)
}
```

The two derived rules (replacing what draft v1 spelled as declarations —
review E-M1, S-M6 proved all three derivable or deletable):

1. **An operation that carries an `operation` wrapper runs on the
   non-consumable executor.** Only a wrapper can retain rows past the parse
   stack; deriving this makes the driver-owned row-reuse corruption
   unrepresentable and lets `prepareCacheManagedFriend` die. Extensions
   without wrappers keep the zero-copy fast path.
2. **An operation that carries an `operation` wrapper refuses shared-batch
   merging** — through the EXISTING `assertBatchPreparable()` refusal,
   extended to be reached from both the `prepare()` and `prepareBatch()`
   seams (review M-m3: today only one seam consults it). No
   `batchTransparent` opt-out: a semantic wrapper silently skipped on the
   batch path is the Prisma-middleware bug, and it stays unrepresentable.
   Because the wrapper member is a per-call SELECTOR (returns `undefined`
   for calls it does not wrap — review E-M6), the refusal is exact per
   operation, and the shipped built-ins never trigger it.

## 2. The seams, corrected

### 2.1 `args` — sync raw-args transform at dispatch
Position unchanged from draft v1 (every reviewer confirmed it as the only
correct point): after `assertNonEmptyUniqueWhere` (fires on raw caller args
— contract unchanged), before `engine.prepare`, therefore before routing's
raw-args predicates and before any keying. Extension order = declaration
order. Output flows into the normal validation boundary, so the trust
boundary holds. Contract: return the SAME object when unchanged (cache-key
stability — omit already obeys it). Error rule stated once (review S-m5):
extension refusals throw synchronously at dispatch (the
`assertNonEmptyUniqueWhere` precedent); engine validation stays
async-at-await.

The `cache:` key strip MOVES to after the whole args chain, immediately
before `prepare` (review S-m1): policy extensions can now see and police
caller invalidation payloads, and the special case becomes ordinary.

### 2.2 `operation` — per-call around-wrapper, inside `run()`
The corrected placement (review M-M1/M-M2, adopted wholesale): the chain
composes INSIDE `PendingOperation.run()`, between `observeOperationExecution`
and `executeRoutedOperation`. Consequences, all measured against the draft's
defects:
- `ctx.validatedArgs()` reads `operation.validatedArgs` off the ONE resolved
  instance — no per-layer re-validation, no memo splitting;
- construction/validation errors keep their span and error log;
- retry (`executeRoutedOperation`) sits below `next` — one logical attempt;
- `wrapExecutor`, `DeferredExecution`, and the wrap-identity `WeakMap` are
  DELETED, not generalized.
A wrapper may short-circuit (never call `next`) and may transform the
resolved result. **Ordering hazard, documented as contract** (review S-C3):
a wrapper that memoizes results must be declared LAST — a role-dependent
wrapper running inside a memo boundary is a cross-role data leak the host
cannot detect. The shipped estate has no such conflict (cache reads live on
the `$withCache` path, §4); the contract line exists for userland caches.
Background SWR revalidation runs NO extension wrappers (review S,
speculative finding, answered here): it replays the already-keyed executor
only.

### 2.3 `writesVisible` — the truthful event (was: `committed`)
Draft v1's "exactly-once durable visibility" was false on four of six paths
(reviews M-C1/C2, E-C2, S-C1: interactive-tx array/callback/savepoint fire
pre-commit; progressive series fire per segment and on the failure path).
The corrected contract states what the engine can actually promise:

- **at-least-once**, per durable unit: once per operation on the execute
  path, once per committed segment for progressive series (carrying the
  existing `RecordSeriesProgress` identity), once per operation on the
  shared-batch path AFTER commit and BEFORE parsing (the warm-entry
  invariant);
- inside an interactive transaction it fires when the operation's writes
  become visible TO THE TRANSACTION, which precedes commit — it is a
  cache-coherence signal, NOT a durable-commit event. Outbox/audit patterns
  need a driver-owned commit boundary that is explicitly out of scope
  (recorded as future work with its rightful owner named:
  `driver-transaction-base.withTransaction`);
- handlers must be idempotent; fan-out runs EVERY handler, retains
  failures, and throws one `AggregateError` (review S-C2; the estate's own
  retain-and-merge pattern), and a failure still fails the operation (the
  `CacheConfigurationError` contract, generalized).

This event replaces `mutationInvalidations`, `invalidateCommittedBatch`,
and the `receivedVisibleWrite` suppress-the-tail dance — the host owns
fan-out once.

### 2.4 `client` — additive `$`-methods
Merged into the outer proxy dispatch before the model-proxy fallthrough, in
ALL THREE proxies (root, transaction, `$withCache` — review M-M7), with the
`$` namespace reserved: unknown `$`-props answer `undefined` (one deliberate
behavior change, pinned; `$`-prefixed schema model names become a
construction-time refusal — review T-m5). Contributed methods exist on the
root client only in v1; `TransactionClient` deliberately excludes them
(pinned both ways — review T-M4). Duplicate contribution keys across
extensions are a construction-time error; one claim registry covers `name`,
`client` keys, and the phase-2 observer slot (review S-m2).

### 2.5 What draft v1 had and v2 deletes, with the finding that killed it

| Draft member | Fate | Finding |
|---|---|---|
| `committed` exactly-once | → `writesVisible` at-least-once | M-C1/C2, E-C2, S-C1 |
| `retainsResults` | derived from wrapper presence | E-M1, S-M6 |
| `ownsOperationSpan` | deleted — host ALWAYS owns `SPAN_OPERATION`; extensions contribute attributes to the open span (hit/miss becomes an attribute, and `skipSpan` + `isCacheManagedExecution` die with no successor) | E-M2, S-M2 |
| `batchTransparent` | deleted — refusal unconditional, exact per call | M-C4, E-M1, S-M5 |
| `adapter` decoration | deferred — zero consumers among the four proofs, and decoration silently breaks the `canonicalAdapterParseResult` zero-copy identity check; "change how SQL is built" is served TODAY by supplying a custom adapter at driver construction (documented recipe with the identity caveat) | E-M3 |
| `argKeys` | deleted — `args` + `ctx.own` covers runtime; the `cache:` key keeps its current type owner (`RemoveCacheKey`), and the SEVEN dead schema entries + seven dead type members in `validation/model/args/mutation.ts` are deleted as earned cleanup | E-M5, M-m1, T-m6 |
| `model` methods | deferred — no consumer in any dogfood proof | E table |
| `resultDefaults` | deleted — sole consumer is omit, whose config key is load-bearing (§3); computed fields stay a non-goal | E table, T-C1/C2 |
| `observers` | staged to phase 2 (§5) | E-C1, S-M3/M4 |
| three context types | one `ExtensionContext` | E-m3 |
| the WRAPPERS/LIFECYCLE/CONTRIBUTIONS/DECLARATIONS taxonomy | dropped — vocabulary, not structure | E-m4 |

## 3. Why `omit` and `cache` stay config keys (measured, not taste)

The decisive type finding (review T-C1): the top-level config position is
the ONLY site where the schema type `S` is contextually inferable — the
`createClient` intersection infers `S` from the sibling `schema` property,
which is what makes `omit: { user: { passwordHsh: true } }` refusable and
completable. An `omit({...})` call inside `extensions: [...]` has no
inference path to `S`; its config degrades to `Partial<Record<string,
true>>`, and `passwordHsh` beside `passwordHash` COMPILES and silently
ignores one secret — the exact hole `f842302`/`2f7bd59` closed. Worse, a
loose extensions array flips omit's honest degradation direction from
"optional" to "present and required" (review T-C2).

Therefore: **`omit` and `cache`/`cacheVersion`/`waitUntil` remain top-level
config keys. At ONE construction site they are normalized into internal
instances of the same extension shape and run on the same pipeline** —
the mechanism is uniform, the typed entry stays where the types can see the
schema. This is a measured constraint, not sugar; the "extensions-only
config" alternative is struck. (A speculative escape — `extensions:
[b => omit(b, {...})]`, putting `S` in a parameter position — must be
probe-measured in the type fixture before anyone claims it.)

`ClientDefaultOmit`/`ClientRelationOmitContext` and the whole omit type
algebra are UNTOUCHED. `RemoveCacheKey` and the `$withCache`/`$invalidate`
conditional members stay owned by core types, re-keyed if needed to "cache
configured" (review T-C3: a `client` contribution cannot type
`CachedClient<C>` before `C` exists — no HKT).

## 4. The dogfood proofs, corrected

| Built-in | As landed on the mechanism | Deletions earned |
|---|---|---|
| client omit | runtime = the normalized internal extension's `args` member (the `applyClientOmit` body moves verbatim); config + types unchanged | the duplicated rewrite call in the `$withCache` dispatch site (both sites consume ONE shared args chain) |
| cache | invalidation = `writesVisible` handler + the `cache:` key consumed via `ctx.own`; `$invalidate` = `client` contribution; `$withCache` READ path stays host-owned in v1 (review M-C3: deleting the shadow proxy requires a per-call read-key channel — a cache-API redesign recorded as open question §7.4) | `cache-flow.ts`'s WeakMap + `invalidateCommittedBatch` + `receivedVisibleWrite`; `prepareCacheManagedFriend` (derived rule 1); `skipSpan`/`isCacheManagedExecution` (§2.5); 7+7 dead `cache:` schema/type entries. `$withCache({key})` changes from key OVERRIDE to key SUFFIX — a caller-supplied key must never bypass the validated-args-derived key (review S-C4: the override defeats any injected `where` at the top level) |
| instrumentation | phase 2 (§5) | dead code harvested NOW, independent of extensions (review E-C1): `perf-tracker.ts` (271 lines, zero callers), both `setInstrumentation` setters, `SPAN_VALIDATE`/`SPAN_BUILD`/`SPAN_PARSE` (exported, produced nowhere) |
| RBAC | userland recipe with a NORMATIVE per-family table (§6) | — |

Each proof lands with falsifiers: remove the extension ⇒ behavior gone;
reorder ⇒ the ordering contract shows (the falsifier is constructed, since
disjoint-key extensions commute — review E, speculative note); batch
refusal ⇒ typed witness; `writesVisible` ⇒ per-segment at-least-once
witness on the progressive path and the pre-parse witness on the batch path.

## 5. Phase 2 — instrumentation as an extension

The mechanism: one `observers` contribution supplying the existing
`InstrumentationContext` interface (tracer, logger, disclosure), threaded
through the trusted `QueryExecutionContext` WeakMap exactly as today. The
deep span sites (operation, statement, transaction, connect, segment,
cache) remain engine/driver-owned semantics. Hard rules from review:
- **one observer provider per client** (review S-M3: disclosure —
  `includeSql`/`includeParams` — is one privilege; N providers cannot
  honestly share it; composition is the user's job inside their provider).
  This also dissolves the error-log dedup question (S-M4);
- the host owns `SPAN_OPERATION` unconditionally (§2.5), so no span
  arbitration exists;
- `viborm/instrumentation` becomes the extension package; the core config
  key is deleted in the same change.
Phase 2 starts only after phase 1's gates are green and is separately
ratified.

## 6. The RBAC recipe (normative table, honest limits)

Headline, stated in the docs verbatim: **the VibORM client is not a
security boundary; database row-level security is.** The recipe covers
convenience scoping, not adversarial isolation. Per operation family
(review S-M1, all measured against the validation schemas):

| Surface | Verdict for args-injection |
|---|---|
| `where` on find/count/aggregate/groupBy/updateMany/deleteMany | inject — works |
| nested relation `where` (to-many include/select, nested update/delete arms) | inject via recursive `data`/projection walk — works, costs the full tree walk incl. the polymorphic arm placement rules |
| **to-one `include`/`select`** | **unscopeable** — the node schema has no `where`; the recipe must REFUSE (strip/deny to-one includes of scoped models) or accept the leak explicitly |
| `connect`/`disconnect`/`set`/`connectOrCreate.where`, `cursor` | whereUnique-shaped: extra filters are REFUSED by schema; the recipe can only ban the keys; `cursor` on a foreign row is an existence oracle |
| `_count: { select }` | must promote `true` → `{ where }` per node |
| upsert | create-arm after a scoped miss can hit a unique violation that discloses foreign-row existence |
| `create`/`createMany` | inject into `data` (different key), or refuse |
| `$queryRaw`/`$executeRaw` | bypass everything — the recipe says so |
| `$withCache({ key })` | with §4's suffix rule, no longer a bypass |

## 7. Open questions for the maintainer

1. §3 as ruled: `omit`/`cache` stay config keys, mechanism underneath is
   the extension pipeline. Confirm (the alternative died to T-C1).
2. `writesVisible` semantics (§2.3): at-least-once, pre-commit inside
   interactive tx, per-segment on progressive series — confirm this is the
   v1 event, with the driver-owned durable-commit event deferred.
3. v1 deferrals: `adapter` decoration, `model` methods, computed-field
   result types, chainable `$extends`, observers/instrumentation (phase 2).
   Confirm the cuts.
4. `$withCache` read-path: stays host-owned in v1. The extensions-era
   alternative (per-call `cache:` key on reads, deleting the shadow proxy
   and the Promise/PendingOperation asymmetry) is a cache-API redesign —
   want it as a follow-up plan?
5. The one-observer rule for phase 2.

## 8. Implementation shape (when ratified)

Package A' (evidence): re-measure the type baseline on tsc 5.9.3 (every
recorded ceiling is 5.8.3-stale — review T); isolated type fixture proving
the C-only-alias carriers (`ExtensionClientMethods<C>` as union projection —
NO tuple walk; review T-M1/M2), the index-signature-absence probes, and the
ten contextual-gate probe classes from review T; behavior corpus pinning
today's invalidation timing on all six execution paths. Package B'
(mechanism): `ExtensionContext`, the chain inside `run()`, the two derived
rules, `writesVisible` host fan-out, the `$` reservation in three proxies,
deletions (`wrapExecutor` et al.). Package C' (dogfood): omit runtime move,
cache invalidation move + key-suffix change + dead-entry deletions, docs +
RBAC recipe page. Package D' (phase 2, separately ratified):
instrumentation. Falsifier matrix and census discipline per house pattern.
Dead-code harvest (E-C1 list) proceeds independently of ratification.
