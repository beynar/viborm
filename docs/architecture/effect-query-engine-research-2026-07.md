# Effect v4 for VibORM's V2 Query Engine and Client

**Date:** 2026-07-26<br>
**Testing update:** 2026-07-28<br>
**Status:** architecture research; no adoption decision or implementation<br>
**Primary baseline:** `effect@4.0.0-beta.101`

## Executive conclusion

The main architectural gain for VibORM is **error handling**, not dependency
injection, resources, or observability considered separately.

VibORM already has a serious runtime error model: stable error codes, concrete
constraint and transaction classes, retry classification, sanitized metadata,
driver normalization, and explicit aggregation of operation plus cleanup
failures. The weakness is that this information repeatedly disappears from the
TypeScript contract:

- driver normalization returns `Error`;
- planning, compilation, and parsing throw through signatures that declare no
  failures;
- the executor and client return `Promise<T>`;
- every rejection handler receives `unknown`;
- expected database failures, engine defects, and cancellation share the same
  JavaScript rejection channel.

Effect v4 can carry those distinctions through the whole execution path:

```text
Effect<Result, ExpectedQueryFailure, CurrentDriver>
       │               │                    │
       │               │                    └─ required service
       │               └─ recoverable, inspectable, selectively retryable
       └─ successful result

Cause<ExpectedQueryFailure>
  = typed Fail reasons + Die defects + Interrupt reasons
```

This improves more than ergonomics. The same classification can govern retry,
transaction cleanup, logs, span status, metrics, cancellation, and the final
Promise translation. Today those policies are implemented at several catch and
rethrow seams.

The recommended boundary is deliberately narrow:

```text
existing validation / V2 compiler / OperationFragment / adapters
                              │
                              ▼
                 Effectful execution shell
       OperationExecutor → driver → transaction lifecycle
                              │
             ┌────────────────┴────────────────┐
             ▼                                 ▼
   Promise facade via Exit             Effect-native facade
   current error contract              typed E remains visible
```

Keep the V2 operation algebra, pure SQL compilation, adapters, and validation
system as they are. Prototype Effect around `OperationExecutor`, driver I/O,
transaction/resource ownership, retry, and instrumentation. Use one coarse
driver service to remove execution-time parameter cascades. Do not turn query
inputs, models, adapter methods, fragments, or planner state into services.

Use the matching `@effect/vitest` beta for the prototype. It directly exercises
the typed error channel, scoped resources, Driver Layers, virtual time, and
complete Cause before the Promise facade erases those distinctions. This
improves test isolation and removes harness boilerplate; it does not remove the
semantic driver, transaction, or Promise-compatibility test matrix.

This is worth prototyping, but not yet worth committing to in core. V4 is beta,
requires TypeScript 5.9 or newer while VibORM currently uses 5.8.3, and has a
transaction-finalizer behavior that can regress VibORM's existing cleanup
diagnostics unless handled explicitly.

## Exact v4 baseline and constraints

The APIs in this report were checked against the published
[`effect@4.0.0-beta.101`](https://www.npmjs.com/package/effect/v/4.0.0-beta.101)
at commit
[`4e0be584fbde272d201b4ad24eaa9b0c8e56f25e`](https://github.com/Effect-TS/effect/tree/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e).

| Fact                                                                                                                                   | Consequence for VibORM                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| V4 is still beta; the Effect team recommends v3 for production while v4 stabilizes.                                                    | An engine spike should pin the exact beta. It should not expose unstable v4 types from VibORM's main public entry point yet.   |
| The v4 package requires TypeScript 5.9 or newer.                                                                                       | VibORM must first measure a TypeScript 5.9 upgrade; its current installed and [declared version](../../package.json) is 5.8.3. |
| Core `Effect`, `Cause`, `Exit`, `Context`, `Layer`, `Logger`, `Tracer`, and `Metric` live in `effect`.                                 | The useful prototype does not require replacing VibORM drivers with Effect SQL.                                                |
| Modules under `effect/unstable/*`, including SQL and parts of observability, may change in minor releases.                             | Do not combine the first experiment with `effect/unstable/sql` or an exporter migration.                                       |
| V4 uses `Context.Service`; v3 `Context.Tag` examples are stale for this baseline.                                                      | Any proposed Layer design must use the beta.101 service API, not a v3 tutorial.                                                |
| V4 replaced the old `Runtime<R>` API with `Context<R>` plus `run*With`; `ManagedRuntime` still builds and owns a Layer-backed runtime. | A long-lived VibORM client can own one managed runtime and dispose it at `$disconnect`.                                        |
| `@effect/vitest@4.0.0-beta.101` peers on Effect beta.101 and supports Vitest 3 or 4.                                                   | Pin the matching beta in the prototype. VibORM's current Vitest 3.1.4 is compatible; no test-runner upgrade is required.       |

Sources: [v4 beta announcement](https://effect.website/blog/releases/effect/40-beta/),
[v4 migration guide](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/MIGRATION.md),
[Effect package requirements](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/README.md),
[services migration](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/migration/services.md),
and [runtime migration](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/migration/runtime.md).

## Error handling: the primary gain

### VibORM has error taxonomy, but not an error channel

[`VibORMErrorCode`](../../src/errors/base.ts#L12) already separates connection,
query, constraint, validation, transaction, not-found, nested-write, feature,
cache, migration, pending-operation, and internal failures.
[`VibORMError`](../../src/errors/base.ts#L123) preserves a code, sanitized cause,
metadata, timestamp, serialization, and `instanceof` identity. Its
[`isRetryable()`](../../src/errors/base.ts#L176) classifies deadlocks,
serialization failures, and connection/query timeouts.

That runtime work is valuable and should remain authoritative. Effect should
not introduce a parallel hierarchy of Effect-only errors.

The problem is compile-time amnesia at the boundaries:

| Boundary today                                                                    | Current type                                                 | Information lost                                                                                                                               |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [`normalizeDriverError`](../../src/drivers/error-mapping.ts#L63)                  | `Error`                                                      | The function constructs precise constraint, transaction, nested-write, and query subclasses, but its return type erases the union immediately. |
| V2 [`ExecutableOperation`](../../src/query-engine/write-engine/OperationExecutor.ts#L48)    | `planning()`, `compile()`, and `parse()` declare values only | Validation/user failures and invariant failures are indistinguishable in the signature.                                                        |
| [`OperationExecutor.execute`](../../src/query-engine/write-engine/OperationExecutor.ts#L96) | `Promise<T>`                                                 | Expected provider failure, parser defect, and cancellation all become rejection.                                                               |
| [`executeRoutedOperation`](../../src/query-engine/write-engine/routing.ts#L136)             | `try/catch unknown`                                          | The exact once-only race policy is enforced only by a runtime classifier.                                                                      |
| [`runTransactionLifecycle`](../../src/drivers/shared/transactions.ts#L197)        | `Promise<T>` plus `AggregateError`                           | Multiple failures are retained at runtime but absent from the caller's static contract.                                                        |
| [`PendingOperation<T>`](../../src/query-engine/pending-operation.ts#L48)          | `PromiseLike<T>`                                             | Its `.then` and `.catch` rejection parameter is explicitly `unknown`.                                                                          |
| Public [`$transaction`](../../src/client/client.ts#L186) and query methods        | `Promise<T>` / `PendingOperation<T>`                         | Client types communicate results but no failure set.                                                                                           |

Effect does not create a good error taxonomy for VibORM. It gives the existing
taxonomy a compositional carrier.

### The v4 distinction VibORM should enforce

V4 keeps `Effect<A, E, R>`:

- `A` is success;
- `E` contains **expected, recoverable failures** created with `Effect.fail` or
  mapped by `Effect.try` / `Effect.tryPromise`;
- `R` contains required services;
- defects created by `Effect.die` and interruptions are present in `Cause`, not
  in `E`.

That makes the engine's classification decision explicit:

| VibORM event                                                                         | V4 representation                                                                               | Why                                                                                       |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Invalid query input                                                                  | typed `Fail<ValidationError>`                                                                   | The caller can correct it.                                                                |
| `findUniqueOrThrow` misses                                                           | typed `Fail<NotFoundError>`                                                                     | This is a documented operation outcome.                                                   |
| Unique, foreign-key, not-null, or check violation                                    | typed constraint failure                                                                        | Callers commonly branch on it.                                                            |
| Connection/query provider failure after normalization                                | typed `ConnectionError` or `QueryError`                                                         | It is environmental, not a program bug.                                                   |
| Deadlock or serialization conflict                                                   | typed `TransactionError`                                                                        | It can be selected by a safe retry policy.                                                |
| Unsupported public operation or driver capability                                    | typed feature/unsupported failure                                                               | It is an anticipated compatibility outcome.                                               |
| V2 unresolved reference, impossible validated fragment, or malformed internal output | `Die` defect                                                                                    | These violate engine/driver invariants; callers should not recover as normal domain flow. |
| External abort                                                                       | `Interrupt`                                                                                     | Cancellation is neither a database error nor a bug.                                       |
| Timeout                                                                              | typed v4 timeout failure, translated to the existing VibORM timeout code at the public boundary | It is recoverable policy, while remaining distinct from interruption.                     |
| Logger/exporter failure                                                              | isolated observer defect, never query `E`                                                       | Telemetry must not replace a query result.                                                |

There is one necessary audit before implementation: `QueryEngineError` is used
for genuine invariants, but `UnsupportedOperationError` currently extends it
and represents an expected public refusal. Classification must follow semantics,
not inheritance alone.

### Preserve the current errors; add discrimination only where useful

V4 provides `Data.TaggedError`, and `catchTag` / `catchTags` can eliminate
handled variants from `E`. But `catchTag` only requires a readonly `_tag`;
VibORM does not need to replace its `Error` subclasses.

There is a TypeScript-specific trap: changing `normalizeDriverError` from
`Error` to a union of the current classes is not sufficient by itself. Most
concrete subclasses add only a constructor and a static `diagnosticName`; their
instances are structurally identical to `VibORMError`. Constructors and static
members do not discriminate an instance union.

The prototype must first give the instance types a literal discriminator. Two
coherent options are:

- narrow the existing `code` property to literal code types in concrete
  subclasses, reusing VibORM's established public discriminant; or
- add a readonly class-level `_tag`, which integrates directly with v4
  `catchTag` / `catchTags` while leaving `code` authoritative for users.

An internal tagged wrapper around the existing Error is also possible, but it
adds allocation and unwrap logic at the Promise boundary. It should be chosen
only if adding a public discriminator is unacceptable.

With that prerequisite, the smallest coherent model is:

1. keep the existing classes, codes, diagnostic serialization, and
   `instanceof` contract;
2. make driver normalization return a concrete `DriverFailure` union rather
   than `Error`;
3. introduce one coarse, genuinely discriminated `QueryFailure` union for the
   execution shell;
4. use that same discriminator for recovery, retry, metrics, and boundary
   translation;
5. keep invariant failures out of that union and convert them to defects at one
   reviewed boundary.

Start coarse. A conditional error type for every model operation would create
large declarations and expensive hovers without proving more safety. VibORM's
type-check performance is already an architectural constraint.

### Promise wrapping must classify rejection correctly

In v4:

- `Effect.promise` treats a rejected Promise as a **defect**;
- `Effect.tryPromise` maps rejection into `E`, using `Cause.UnknownError` by
  default or a custom `catch` mapper;
- the callback receives an `AbortSignal`.

Ordinary driver I/O must therefore use `tryPromise` with
`normalizeDriverError`. Using `Effect.promise` would misclassify expected
provider rejection as an engine bug. The signal only produces physical query
cancellation when that driver actually accepts and honors it; otherwise Effect
can interrupt the waiting fiber but cannot cancel the database operation.

Sources: exact beta.101
[`Effect`](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/src/Effect.ts)
and [expected-error documentation](https://effect.website/docs/error-management/expected-errors/).

### Recovery and retry become type-directed

The useful v4 recovery operations are not cosmetic:

- `catch` handles typed failures, not defects or interruption;
- `catchTag` / `catchTags` handle and remove selected `_tag` variants from `E`;
- `catchDefect` is reserved for bug reporting or final boundary translation;
- `catchCause` sees expected failures, defects, and interruption;
- `tapError`, `tapDefect`, and `tapCause` can observe those categories without
  recovering them;
- `retry` retries typed failures only and accepts predicates/refinements plus a
  schedule.

For VibORM, Effect should express retry mechanics, while VibORM remains the
authority on **whether** retry is safe. The once-only race retry in
[`routing.ts`](../../src/query-engine/write-engine/routing.ts#L127) is tied to race pins
and `meta.raceable`; it must not become a generic retry of all constraint or
transaction failures. Retry the complete idempotent read or complete
transaction attempt, never an arbitrary statement after partial mutation.

### V4 `Cause` and `Exit`: useful, but different from v3

V4 flattened `Cause<E>` to:

```text
readonly reasons: ReadonlyArray<Fail<E> | Die | Interrupt>
```

The v3 `Empty`, `Sequential`, and `Parallel` tree nodes are gone. Multiple
reasons remain, but their execution topology is not encoded.
[`Exit<A, E>`](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/src/Exit.ts)
is still either a success or a failure holding the complete `Cause<E>`.

This is valuable for an ORM because one outcome can preserve:

- a typed query failure;
- a rollback/close failure;
- a defect discovered during cleanup;
- an interruption.

But flat reasons do not by themselves say which failure was primary and which
came from rollback. VibORM must preserve those roles in its transaction policy
or existing `AggregateError` translation, not infer them later from a Cause
array.

Sources: [official Cause migration](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/migration/cause.md)
and [exact v4 Cause source](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/src/Cause.ts).

### Critical transaction caveat: a failed release can mask the query failure

VibORM's current transaction lifecycle deliberately keeps both the primary
operation/commit failure and rollback/close failures using `AggregateError`.
That is stronger than a naive `try/finally`.

V4 guarantees finalizer invocation, but not VibORM's desired precedence:

- `acquireRelease`, `addFinalizer`, and scoped finalizers require an
  error-infallible finalizer;
- `acquireUseRelease` allows the release to fail and adds its `E3` to the
  declared error union;
- in beta.101, if the use fails and the release also fails, the release failure
  replaces the original use failure by default.

This was verified against the published beta.101 runtime: `runPromiseExit`
contained only the release failure for that case. Therefore a direct rewrite
of `runTransactionLifecycle` with `acquireUseRelease` would regress diagnostics.

The transaction implementation must explicitly capture both exits and either:

1. combine their Causes while separately preserving primary/cleanup roles; or
2. construct one deliberate composite transaction failure that contains both,
   then translate it back to VibORM's established `AggregateError` contract.

Scope guarantees that rollback/close is attempted. It does not decide which
failure wins or how two failures are presented.

Sources: [resource API](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/src/Effect.ts)
and [beta.101 finalizer implementation](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/src/internal/effect.ts).

### The Promise boundary is necessarily less typed

`runPromise` accepts any `E` and returns `Promise<A>`. TypeScript does not force
a caller to handle errors before running it. Internally, v4 uses
`Cause.squash`, selecting one failure/defect/interruption value and losing
additional reasons.

A local beta.101 probe confirmed two relevant behaviors:

- for one typed failure that is already an `Error`, `runPromise` rejects with
  the same object, preserving `instanceof`;
- for a Cause containing two typed errors, `runPromise` rejects with the first
  and loses the second.

`runPromiseExit` preserves the complete Exit. The existing Promise client should
therefore translate `Exit` once at its imperative edge:

- one expected VibORM error → reject with that exact object;
- composite transaction failure → preserve the current aggregate contract;
- defect → translate/report as the established internal engine failure;
- interruption → translate to VibORM's documented cancellation behavior.

An Effect-native client is the only public API on which `E` remains visible to
the caller. This corrects the claim that Effect automatically “forces callers”
to handle typed errors through an ordinary Promise API.

## Layer-by-layer V2 engine and client assessment

V2 is the production engine. The relevant execution flow is:

```text
typed model proxy
  → lazy one-shot PendingOperation
  → operation construction
  → planning()
  → compile(known)
  → FragmentValidator
  → statement | linear transaction | provider atomic batch
  → normalized driver execution
  → parse result
```

V2's [`OperationFragment`](../../src/query-engine/write-engine/OperationFragment.ts)
already acts as a domain-specific operation algebra: ordered statements,
references, outputs, guards, postconditions, race pins, and unique-conflict
behavior. Effect is a complementary **execution algebra**, not a replacement
for that inspectable IR.

| VibORM layer or seam                        | Error benefit                                                                                                        | Service/Layer benefit                                                                                                                       | Observability/concurrency benefit                                                                                          | Recommendation                                                                                                                                                                                                          |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validation and `SchemaRegistry`             | Existing validation failures can enter `E` as `ValidationError`.                                                     | None. Schemas are stable client-owned data, not ambient execution services.                                                                 | A validation failure can close the operation span consistently.                                                            | Keep the current Standard Schema and branded inference system. Do not adopt Effect Schema as part of this work.                                                                                                         |
| Scalars, models, and relations              | No material gain. Their definition-time errors remain synchronous.                                                   | None.                                                                                                                                       | None.                                                                                                                      | Keep unchanged.                                                                                                                                                                                                         |
| Operation construction                      | Public unsupported/input failures can become typed failures; impossible construction states become defects.          | Driver is unnecessary here. Model, args, and operation kind must remain explicit values.                                                    | An operation span may cover construction if useful, but avoid hot-path log chatter.                                        | Keep synchronous and deterministic; classify thrown failures at the outer boundary.                                                                                                                                     |
| `Part`, `planning()`, and `compile(known)`  | Separates anticipated compile refusal from invariant defect.                                                         | Negative value: hiding scope, model, relation, or known outputs in Context would obscure compiler inputs.                                   | Little.                                                                                                                    | Keep pure functions and ordinary parameters.                                                                                                                                                                            |
| `OperationFragment` and `FragmentValidator` | Validator failures that indicate an impossible engine-produced fragment should be defects.                           | None.                                                                                                                                       | Defect attribution can include operation metadata automatically at execution.                                              | Keep exactly as V2's semantic IR.                                                                                                                                                                                       |
| `OperationExecutor`                         | **High value:** one `Effect<T, QueryFailure, CurrentDriver>` can cover execution and parsing while preserving Cause. | **High value:** resolve the current root/transaction driver once from Context instead of accepting `driverOverride` through the call graph. | Spans, cancellation, timeout, and Cause-aware logging can wrap the whole operation.                                        | Best engine integration boundary. Keep fragment order explicit; do not replace linear execution with `Effect.all`.                                                                                                      |
| Routing and race retry                      | The retryable subset can be a narrowed typed error.                                                                  | It can reuse the current driver service.                                                                                                    | Schedules can record attempt count and delay.                                                                              | Keep `isRetryableRace` and the exact once-only whole-operation policy authoritative.                                                                                                                                    |
| Adapters                                    | No gain: they produce dialect-specific `Sql` fragments, not asynchronous effects.                                    | Do not make adapters services. The selected driver already owns its adapter.                                                                | None.                                                                                                                      | Keep pure and preserve the query-engine/adapter boundary.                                                                                                                                                               |
| Driver execution                            | **Strongest value:** `tryPromise` normalizes provider rejection exactly once into a typed union.                     | Current driver becomes one coarse service. Driver acquisition can be Layer-scoped.                                                          | Statement spans inherit operation context; AbortSignal can reach capable providers; metrics can use normalized error tags. | First implementation target.                                                                                                                                                                                            |
| Transaction lifecycle                       | Expected callback/commit/rollback failures, defects, and interruption remain distinct; full Exit is inspectable.     | A transaction-bound driver can locally override the current driver service for the callback scope.                                          | Child fibers can be supervised and finalizers are guaranteed.                                                              | Strong fit, but only with an explicit primary-plus-cleanup aggregation policy. Preserve callback contract checks, rollback-only poisoning, savepoint ordering, and active-operation draining.                           |
| `PendingOperation`                          | An Effect facade can expose `E`; the current PromiseLike value cannot.                                               | The operation may require `CurrentDriver` at execution without storing an override.                                                         | Effect suspension is lazy.                                                                                                 | Adapter, not blind replacement. A `PendingOperation` is memoized, one-shot, and inspectable; a normal Effect is reusable. An Effect facade should create a fresh pending operation inside `Effect.suspend` on each run. |
| Array `$transaction([...])`                 | One outer Effect can preserve its aggregate failure.                                                                 | Uses the same driver service.                                                                                                               | Little concurrency benefit.                                                                                                | Do not translate to `Effect.all`. VibORM's array path preplans, merges symbolic references and guards, and executes one provider atomic protocol; it is not Promise batching.                                           |
| Callback `$transaction`                     | An Effect-native callback can retain a typed transaction failure channel.                                            | **Major DI gain:** locally provide the transaction-bound driver; nested queries resolve it automatically.                                   | Structured concurrency can ensure child queries do not outlive the transaction.                                            | High-value optional API. Preserve the Promise callback overload for existing users.                                                                                                                                     |
| Cache                                       | Cache failures can be typed separately from query failures.                                                          | A cache backend could be a service only if the Effect-native client owns it; current explicit ownership is already clear.                   | Fibers can supervise local work, but they do not replace Cloudflare `waitUntil`.                                           | Do not replace the persistent cache/invalidation design with Effect Cache or Request without a concrete loader use case.                                                                                                |
| Instrumentation                             | Expected error, defect, and interruption can be logged differently from the same Cause.                              | Logger/tracer/metric implementations are runtime services; privacy policy remains VibORM-owned.                                             | Strong reduction in context propagation and span-finalization plumbing.                                                    | Material benefit; integrate once, with no duplicate current and Effect telemetry.                                                                                                                                       |
| Migrations                                  | Migration failures could gain a typed channel and scoped lock/storage lifecycle.                                     | Storage driver could be a service in a separate migration runtime.                                                                          | Useful spans around lock/apply/rollback.                                                                                   | Valid later use, but outside the query-engine prototype.                                                                                                                                                                |

### What Effect must not replace

Four boundaries are already deeper than generic Effect primitives:

1. `OperationFragment` is inspectable and lowerable before execution; a generic
   Effect program is opaque.
2. Array transactions merge database operations into one atomic provider
   protocol; `Effect.all` is concurrency, not SQL atomicity.
3. Race pins decide whether retry is semantically safe; a Schedule cannot infer
   that.
4. Adapters own database-specific SQL; putting them in Context would not remove
   the dialect boundary.

## Dependency injection with v4 `Context.Service` and `Layer`

### Where constructor injection is already good

[`QueryEngine`](../../src/query-engine/query-engine.ts#L15) already owns the
driver, registry, and instrumentation at client scope. Passing the engine into
operation classes is coherent constructor injection. The numerous relation
records passed during planning are semantic inputs, not infrastructure
dependencies.

Effect should not replace explicit values merely to make signatures shorter.

### Where the parameter cascade is real

The cascade begins at execution:

```text
PendingOperation
  → executeRoutedOperation(driverOverride, QueryExecutionContext)
  → OperationExecutor(..., driverOverride, QueryExecutionContext)
  → driver._execute(..., QueryExecutionContext)
  → normalization / logging / tracing
```

Transaction binding currently creates a new engine through
[`QueryEngine.bind(driver)`](../../src/query-engine/query-engine.ts#L55), while
`PendingOperation` and executor methods also carry optional driver overrides.
The immutable execution context is cloned/threaded because every lower layer
needs attribution.

This is the ceremony Layers can remove.

### The service graph should stay small

The useful v4 service can be as coarse as:

```ts
class CurrentDriver extends Context.Service<CurrentDriver, AnyDriver>()(
  "viborm/CurrentDriver",
) {}

const DriverLive = Layer.succeed(CurrentDriver, driver);
```

This syntax is the current beta.101 `Context.Service` API. Conceptually:

- the root client Layer provides the base driver;
- the operation executor yields the current driver;
- a callback transaction locally provides the transaction-bound driver with
  `Effect.provideService(CurrentDriver, txDriver)`;
- nested operations inherit that override;
- leaving the transaction scope restores the root driver automatically.

That directly removes `driverOverride` propagation and makes “which driver is
current?” a scoped invariant. It also makes swapping PostgreSQL, MySQL, SQLite,
D1, test drivers, and transaction drivers a composition-root decision rather
than a parameter cascade.

One additional VibORM-owned service may be earned: an immutable telemetry and
diagnostic-disclosure policy. Core Logger, Tracer, and Metric services already
exist in Effect; wrapping each in another VibORM service would create two
owners.

### Operation data should not become services

Do **not** put these in Context:

- model or relation metadata;
- operation arguments;
- `OperationFragment`, `Ref`, or known outputs;
- adapter expressions or SQL fragments;
- parser state;
- batch indices and result windows;
- retry pins.

They are explicit semantic data. Hiding them would make the compiler harder to
inspect and could let concurrent operations read the wrong ambient state.

### Context annotations can replace most attribution plumbing

[`OperationExecutionContext`](../../src/query-engine/execution-context.ts#L23)
owns client/scope identity plus an attribution object; the driver-level
[`QueryExecutionContext`](../../src/drivers/types.ts#L13) contains model,
operation, and correlation ID. Instrumentation is resolved beside that
attribution. Do not blindly convert this ownership/context cluster into one
ambient service.

At the execution boundary:

1. keep client/scope ownership on `PendingOperation`, where array-transaction
   validation needs to inspect it;
2. capture model/operation/correlation once;
3. apply them through `annotateLogs` and `annotateSpans`;
4. close over the same immutable values in the driver error mapper;
5. let nested statement effects inherit the annotations automatically.

This removes low-level attribution parameters without making query semantics
ambient.

### Layer lifecycle and client ownership

`Layer<ROut, E, RIn>` declares services provided, construction failure, and
services required. `Layer.succeed` is enough for an already-created driver;
`Layer.effect` or a scoped layer is appropriate when the client runtime owns
connection/pool acquisition and disposal.

`ManagedRuntime` is the likely Promise-client composition root: build the
driver, logging, tracing, and metric Layers once; run many operation Effects;
dispose the scope on `$disconnect`. This must not create one runtime or rebuild
Layers per query.

Sources: exact v4
[`Context`](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/src/Context.ts),
[`Layer`](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/src/Layer.ts),
and [`ManagedRuntime`](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/src/ManagedRuntime.ts).

## Built-in observability and logging

### What VibORM already owns

VibORM's current instrumentation is not trivial boilerplate:

- operation and statement attribution;
- correlation IDs;
- SQL and parameter disclosure/redaction;
- error sanitization;
- dynamic optional OpenTelemetry loading;
- logger and tracer abstractions;
- the rule that observer failure cannot alter query behavior.

For example,
[`observeOperationExecution`](../../src/query-engine/execution-context.ts#L62)
manually starts timing, catches and logs an unlogged failure, marks it, and
rethrows it. Driver instrumentation separately threads context, times calls,
normalizes errors, handles disclosure, and prevents logger failure from
replacing query failure.

Effect must preserve those product contracts.

### What v4 provides in core

V4's core observability primitives align unusually well with the typed failure
model:

- `withSpan` ends a span with the complete `Exit`, not only a caught Error;
- `annotateSpans` and `annotateLogs` propagate model, operation, correlation,
  dialect, and driver context through nested effects and fibers;
- `tapError` observes expected query failures;
- `tapDefect` observes invariant/programming failures;
- `tapCause` observes expected failures, defects, and interruption together;
- Effect logging carries Cause separately from ordinary structured annotations;
- Metric counters, gauges, and histograms can share the same normalized error
  classification.

The payoff is one error classification feeding all policies:

| Cause category                       | Log policy                                                  | Span policy                            | Metric policy                             |
| ------------------------------------ | ----------------------------------------------------------- | -------------------------------------- | ----------------------------------------- |
| Expected validation/not-found        | structured warning or no log, depending on public policy    | error/status with typed tag if desired | outcome counter                           |
| Constraint/query/transaction failure | sanitized error log                                         | failed query/transaction span          | counter by low-cardinality error tag/code |
| Defect                               | internal error log with Cause                               | failed span with exception             | defect counter                            |
| Interruption                         | cancellation event, not database error                      | interrupted/cancelled status           | cancellation counter                      |
| Retry                                | annotation/event per attempt, not duplicate terminal errors | attempt event or child span            | retry counter and delay histogram         |

This can delete much of the manual “catch → sanitize → log → mark logged →
rethrow → close span” flow. It also removes correlation threading through
concurrent child work.

Sources: exact v4
[`Logger`](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/src/Logger.ts),
[`Tracer`](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/src/Tracer.ts),
[`Metric`](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/src/Metric.ts),
and [`Effect`](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/src/Effect.ts).

### What is not free

“Built-in observability” does not mean “zero design or dependencies.”

VibORM still owns:

- span and event names;
- SQL/parameter disclosure defaults;
- error sanitization;
- sampling;
- metric cardinality;
- whether validation/not-found failures should be logged;
- observer-failure isolation;
- Cloudflare export/flush lifecycle.

Core spans and metrics also need an exporter integration. In the v4 line,
parts of OTLP/observability live under semver-unstable modules, and the
OpenTelemetry bridge brings its own dependency and version surface. The first
engine prototype should use a test logger/tracer or bridge into the current
instrumentation, not replace exporting at the same time.

### Recommended telemetry ownership

Use one pipeline, not two:

```text
Effect operation/statement spans and Cause
                    │
                    ▼
      VibORM names + disclosure policy
                    │
                    ▼
       one logger / tracer / metric sink
```

During a prototype, disable equivalent current wrappers for the Effectful path
or bridge Effect events into them. Otherwise every query and failure will be
reported twice.

Metric labels should remain low-cardinality: dialect, driver, operation family,
outcome, and stable error tag/code. Do not label metrics with SQL, parameters,
constraint text, correlation IDs, or arbitrary user-derived metadata.

The v4 OpenTelemetry mapping was checked in the exact source: non-interruption
Cause reasons are recorded as exceptions, while interruption-only completion is
handled separately.
[Exact v4 OTel tracer mapping](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/opentelemetry/src/OtelTracer.ts).

## Testing the Effect kernel with `@effect/vitest`

`@effect/vitest` should be part of the prototype as a **development-only
adapter**, not as an independent reason to adopt Effect. Its value is that the
same Effect program, typed error channel, Scope, Layer graph, clock, and
interruption model used in production can be exercised directly in Vitest.

The matching package for this report is
[`@effect/vitest@4.0.0-beta.101`](https://www.npmjs.com/package/@effect/vitest/v/4.0.0-beta.101).
Its peer range accepts Vitest 3 or 4 and requires Effect beta.101 or newer on
the same 4.0.0 prerelease line. VibORM's current Vitest 3.1.4 therefore needs no
upgrade for the prototype, but the Effect and `@effect/vitest` betas should be
pinned together.

### What the v4 test package actually provides

| Facility                       | Verified beta.101 behavior                                                                                                                                      | Concrete VibORM use                                                                                                                                              | Limit                                                                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `it.effect`                    | Runs the returned Effect with a fresh Scope, `TestClock`, and `TestConsole`. Vitest's abort signal is passed to the Effect runtime.                             | Test `QueryOperation`, driver execution, retry, transaction cleanup, and interruption without hand-written `runPromise` wrappers or cleanup hooks.               | Provider work stops only if its Promise boundary honors cancellation. A fiber interruption cannot manufacture physical SQL cancellation.                                              |
| Failure reporting              | Captures the complete `Exit`, renders every `Cause.prettyErrors` entry, then re-fails the original Cause to Vitest.                                             | A failed query plus failed rollback/close remains visible during diagnosis instead of being reduced immediately to one rejected Promise.                         | Reporting does not define VibORM's aggregation policy. Tests must still assert which reason is primary and which reason is cleanup.                                                   |
| `layer(TestLayer)`             | Builds and memoizes a Layer context for a test block, supports nested Layers, gives each test a child Scope, and closes the shared Layer Scope after the block. | Share a root driver/pool, failure-injection driver, capture logger/tracer/metric sink, or OTel recorder without repeating `beforeAll`/`afterAll` wiring.         | The built Layer and its mutable services are shared. It does not reset tables, captured events, or clock state between tests; those need per-test scope, rollback, or explicit reset. |
| `TestClock`                    | Controls Effect-based sleep, timeout, and schedules by advancing virtual time rather than waiting for wall-clock time.                                          | Make race retry, transaction timeout, cache TTL, and stale-while-revalidate tests fast and deterministic.                                                        | It only affects code using Effect's `Clock`/`sleep`. Current raw `setTimeout` and `Date.now` paths remain real-time until the production seam is effectful.                           |
| `TestConsole`                  | Replaces Effect's Console service with an in-memory implementation and exposes captured log and error lines.                                                    | Assert Effect log behavior without polluting test output. A separate VibORM capture Logger Layer can assert sanitized structured events.                         | It does not automatically understand VibORM's log schema, redaction policy, or OpenTelemetry spans.                                                                                   |
| `Effect.exit` and test helpers | `@effect/vitest/utils` includes assertions for `Exit`, `Cause`, `Result`, and `Option`.                                                                         | Assert typed constraint failure, defect, interruption, and composite transaction failure before the Promise translation boundary.                                | Exact structural Cause assertions can become brittle. Prefer semantic assertions on reason tags, roles, stable error codes, and public translation.                                   |
| `it.effect.prop`               | Runs asynchronous property tests from FastCheck arbitraries or Effect Schemas.                                                                                  | Exercise query normalization, parameter separation, result parsing, cache-key stability, error normalization, and retry-safety invariants over generated inputs. | VibORM's `v.*` schemas are not Effect Schemas. Use focused FastCheck arbitraries; do not adopt Effect Schema merely to generate tests.                                                |
| `it.live`                      | Runs a scoped Effect with live services instead of the test clock/console environment.                                                                          | Real PostgreSQL, MySQL, SQLite, PGlite, D1, and provider conformance tests whose timing and resources must be genuine.                                           | Keep live provider tests separate from deterministic engine tests.                                                                                                                    |
| `flakyTest`                    | Retries a sandboxed Effect repeatedly within a duration.                                                                                                        | At most, tolerate a genuinely eventual external test environment.                                                                                                | Do not use it for the query engine, scheduler, transaction, or cache core. Retrying those tests can hide precisely the races and cleanup defects the suite must expose.               |

The beta.101 package has one documentation trap: its shipped README still lists
`it.scoped` and `it.scopedLive`, but those methods are not present in the v4
public type/source. The actual v4 `it.effect` and `it.live` implementations are
already scoped. For this proposal, the tagged source is authoritative rather
than v3-shaped README examples.

Sources: exact beta.101
[package metadata](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/vitest/package.json),
[public API](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/vitest/src/index.ts),
[runner and Layer implementation](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/vitest/src/internal/internal.ts),
[test assertions](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/vitest/src/utils.ts),
[`TestClock`](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/src/testing/TestClock.ts),
[`TestConsole`](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/src/testing/TestConsole.ts),
and the
[inconsistent beta.101 README](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/vitest/README.md).

### Where it changes VibORM's current tests

The largest immediate gain is less harness machinery, not fewer semantic
tests:

- Driver behavior suites already reuse the same assertions across providers.
  A Driver Layer can replace lifecycle plumbing such as the mutable client,
  `beforeEach`/`afterEach`, and defensive `requireClient` pattern in
  [`optional-relation-parity-behavior.ts`](../../tests/drivers/optional-relation-parity-behavior.ts#L62),
  but it does not remove the behavior matrix.
- Current cache tests wait 40–100 ms for TTL and background revalidation in
  [`cache.test.ts`](../../tests/cache/cache.test.ts#L197). `TestClock` can
  eliminate those waits only after cache timing is expressed through the
  Effect clock.
- Transaction timeout tests use real delayed Promises in
  [`transaction-options-behavior.test.ts`](../../tests/drivers/transaction-options-behavior.test.ts#L183).
  The Effect-native transaction path can test its own timeout deterministically;
  the Promise/provider compatibility test should remain live.
- Primary-plus-cleanup assertions currently catch `unknown` and unpack
  `AggregateError` in
  [`transaction-lifecycle.test.ts`](../../tests/drivers/transaction-lifecycle.test.ts#L190)
  and
  [`savepoint-queue.test.ts`](../../tests/drivers/savepoint-queue.test.ts#L350).
  The internal Effect tests can assert the complete `Exit`/`Cause` first, while
  separate Promise-boundary tests retain the existing public `AggregateError`
  contract.
- The existing OTel recorder in
  [`instrumentation/_capture.ts`](../../tests/instrumentation/_capture.ts#L80)
  can become a scoped capture Layer so provider shutdown is guaranteed.
  Real OTel integration tests and semantic span assertions are still required.

### Recommended test split

| Surface under test                                       | Test style                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Validation, pure planning, fragments, adapters, SQL      | Plain Vitest. No Effect runtime or Layer.                                                                    |
| `QueryOperation`, executor, routing, typed failures      | `it.effect` with small fake/failure Driver Layers.                                                           |
| Retry, timeout, cancellation, cache timing               | `it.effect` plus `TestClock` where the production seam uses Effect time.                                     |
| Transaction lifecycle and simultaneous failures          | `it.effect`, `Effect.exit`, and semantic Cause assertions; then separate Promise translation contract tests. |
| Reusable driver conformance                              | The same behavior contract parameterized by a Driver Layer; `it.live` for real providers.                    |
| Public Promise/PromiseLike client semantics              | Plain Vitest against the real public facade, including one-shot memoization and rejection behavior.          |
| Logs, spans, metrics, disclosure, and observer isolation | Capture service Layers for unit tests; retained real OpenTelemetry integration tests.                        |

This should produce roughly the same or temporarily greater test count during
migration: internal Effect semantics and the public Promise translation are two
different contracts. The expected reduction is duplicated setup, ad-hoc mocks,
wall-clock sleeps, and flaky cleanup—not coverage.

## Resources, cancellation, and structured concurrency

These are secondary benefits, but they reinforce the error model.

### Resources and transactions

Scope can guarantee acquisition/release for reserved connections, prepared
statements that require disposal, cursors, transaction drivers, and the client
runtime. Finalizers receive an Exit, so cleanup can react differently to
success, typed failure, defect, or interruption.

It does not remove VibORM's database semantics:

- provider callbacks must still be invoked exactly once;
- commit/rollback ordering remains explicit;
- nested savepoints remain serialized;
- rollback-only and poisoned-driver state remain domain rules;
- active operations must drain before the transaction closes;
- primary and cleanup failures need the explicit policy described above.

### Cancellation

Structured interruption is materially cleaner than manually coordinating
Promises and `AbortController`, particularly for transaction callbacks that
spawn child work. A transaction scope can supervise child fibers and prevent
them from using a closed transaction-bound driver.

But interruption is not physical SQL cancellation. Each driver needs an honest
capability:

```text
Effect fiber interrupted
  ├─ provider honors AbortSignal → query cancellation attempted
  └─ provider ignores/no signal   → caller stops waiting; DB work may continue
```

The second case affects connection reuse and transaction safety and must be
documented rather than hidden.

### Concurrency and batching

Use structured concurrency only where operations are genuinely independent:
parallel reads, independent metadata work, or supervised background tasks.

Do not use it for:

- ordered steps inside one `OperationFragment`;
- writes whose outputs feed later statements;
- array `$transaction`, which is a provider atomic-batch protocol;
- cache revalidation that must survive a Cloudflare request without
  `waitUntil`.

## Client API options

### Keep the Promise facade

Existing users should retain:

```ts
const users = await db.user.findMany(...)
```

Internally the pending operation may run an Effect, but the boundary should use
`runPromiseExit` and the explicit translation policy above. This preserves
current result inference, `instanceof`, error codes, aggregation, and
PromiseLike behavior.

Typed `E` is still useful internally for retry, telemetry, transaction policy,
and exhaustive engine composition even though the Promise signature erases it
for callers.

### Add an optional Effect-native facade only after the internal model works

An optional entry point can expose conceptual signatures such as:

```ts
Effect.Effect<User[], QueryFailure, CurrentDriver>;
```

It should reuse the same engine and existing error objects. It must not force
Effect into the normal client bundle for Promise-only users.

The facade needs a deliberate repeatability rule. Current
`PendingOperation<T>` memoizes one Promise and prevents execution under
conflicting drivers. A normal Effect can be run repeatedly. The least
surprising facade constructs a fresh `PendingOperation` inside `Effect.suspend`
for every run rather than wrapping one already-created pending object.

### Transaction APIs

- Keep the current Promise callback overload.
- An Effect-native callback transaction can provide `CurrentDriver = txDriver`
  for its dynamic scope and supervise all nested fibers.
- Keep array `$transaction` as an explicit inspectable operation/batch API; an
  array of Effects cannot preserve VibORM's preplanning and symbolic batch
  lowering.

## Assessment of the supplied model answer

| Claim                                                   | Assessment for VibORM v4                                                                                                                                                                      |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typed errors are the largest reliability gain.          | **Correct, and more important than the earlier report allowed.** VibORM's existing taxonomy should become `E`; defects and interruption remain separate in Cause.                             |
| Callers are forced to handle every error.               | **Overstated.** Effect composition exposes `E`, but `runPromise` accepts any `E`. Only an Effect-native API retains typed failures for public callers.                                        |
| Scope automatically preserves all transaction failures. | **Incorrect for beta.101.** Cleanup runs, but a failed release can mask the primary failure unless VibORM combines/translates explicitly.                                                     |
| Layers eliminate driver/context parameter cascades.     | **Correct at the execution boundary.** One current-driver service and scoped transaction override are valuable. Making planner values services would be harmful.                              |
| Observability is free.                                  | **Incorrect.** Context propagation and Cause-aware spans/logs/metrics are built in; exporters, semantic naming, redaction, cardinality, and failure isolation remain VibORM's work.           |
| Every query pipeline stage should be an Effect.         | **Not justified.** Pure planning, fragments, adapters, and parsing helpers should stay plain unless their failure classification requires one outer wrapper.                                  |
| Drizzle validates deep Effect adoption.                 | **Only at execution.** Drizzle's v4 integration makes built queries Effect-evaluable and delegates execution/transactions; it does not turn relational planning into an Effect service graph. |

Drizzle evidence: [official v1.0.0-rc.1 release](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.1),
[query Effect bridge](https://github.com/drizzle-team/drizzle-orm/blob/e2a6f87d2752e7276ecbe7a49fc14ba58b0a46cd/drizzle-orm/src/effect-core/query-effect.ts),
and [Effect PostgreSQL session](https://github.com/drizzle-team/drizzle-orm/blob/e2a6f87d2752e7276ecbe7a49fc14ba58b0a46cd/drizzle-orm/src/effect-postgres/session.ts).

## Recommended v4 prototype

The smallest useful experiment is **error-first**, not a generic
`tryPromise` wrapper and not a full client rewrite.

1. Pin `effect@4.0.0-beta.101` and
   `@effect/vitest@4.0.0-beta.101` in an isolated branch/prototype and upgrade
   that branch to TypeScript 5.9.
2. Define a coarse expected query/driver failure union from the existing error
   classes. Do not redesign the public errors.
3. Change one representative executor-to-driver path into
   `Effect<T, QueryFailure, CurrentDriver>`.
4. Normalize every provider rejection with `tryPromise`; turn reviewed engine
   invariant failures into defects.
5. Provide the root driver through `Layer.succeed`; locally override it with a
   transaction-bound driver inside callback transactions.
6. Port the shared transaction lifecycle only far enough to test success,
   typed callback failure, defect, interruption, commit failure, rollback
   failure, close failure, and simultaneous primary-plus-cleanup failure.
7. Finish through `runPromiseExit` and prove byte-for-byte/public-contract
   parity for error class, code, message, sanitized metadata, cause, and
   aggregation.
8. Test the Effect path with `it.effect`, a failure-injection Driver Layer,
   complete `Exit`/`Cause` assertions, and `TestClock` for Effect-native time.
   Keep public Promise conformance in plain Vitest and real provider contracts
   under `it.live`.
9. Add one operation span, one statement span, structured log annotations, and
   low-cardinality metrics using a scoped capture Layer. Do not migrate
   exporters yet.
10. Benchmark and compare code only after semantic parity.

### Prototype pass/fail cases

The prototype passes only if all of these are true:

1. A unique violation is a typed constraint failure and remains the same public
   error object/class through the Promise facade.
2. A deadlock is selectively retryable; a normal unique constraint is not.
3. The existing race-pin failure retries the complete operation exactly once;
   no broader retry is introduced.
4. An unresolved internal V2 reference appears as a defect, not an expected
   database error.
5. External abort is distinguishable from query failure and always attempts
   required cleanup.
6. Query failure plus rollback/close failure preserves both and identifies
   their roles.
7. A logger, tracer, or exporter failure cannot replace success or query
   failure.
8. Root and transaction-bound drivers cannot be confused, and child work
   cannot outlive the transaction scope.
9. No ordered fragment or atomic batch is accidentally parallelized.
10. Existing V2 conformance behavior is unchanged.
11. Retry and timeout unit tests advance `TestClock` without wall-clock sleeps;
    live provider timing remains in an explicitly separate test group.

### Engineering gates

Even a semantically correct prototype should not enter core until it measures:

- direct-Promise versus Effect hot-path latency on embedded SQLite/PGlite;
- network-driver overhead;
- client cold start on Node and Cloudflare Workers;
- tree-shaken/minified bundle delta for the normal client and optional facade;
- TypeScript 5.9 check time and declaration size with the proposed `E` union;
- runtime/Layer creation count, proving one client runtime rather than one per
  query;
- code removed from transaction, error, execution-context, and instrumentation
  plumbing versus bridge code added.
- test harness code removed, deterministic-test wall-clock duration, and
  whether the Effect path reduces rather than hides timing flakes.

The decision rule is simple: Effect earns a core dependency only if typed error
composition plus scoped execution removes more independent machinery than the
runtime bridge introduces, without weakening current transaction diagnostics.

## Final recommendation

Effect v4 is a strong conceptual fit for VibORM's **execution kernel**:

- `E` gives the existing public error taxonomy compile-time continuity;
- Cause separates expected failure, defect, and interruption;
- Exit gives one honest boundary for transactions, telemetry, and Promise
  translation;
- Context/Layer removes the current driver override cascade;
- log/span annotations remove most execution-attribution threading;
- structured concurrency can supervise transaction-scoped work;
- `@effect/vitest` can test those same Layers, Scopes, clocks, and complete
  Causes directly, with less lifecycle and timing scaffolding.

It is a poor fit for the pure V2 compiler, operation IR, adapters, or schema
inference system.

The largest risk is not learning curve or syntax. It is adopting a generic
resource abstraction and accidentally losing VibORM's existing
primary-plus-cleanup failure semantics. Prove that case first. If the prototype
preserves it, Effect v4 can make the engine's error model substantially more
coherent. If it does not, Layers and observability alone are not enough reason
to put the runtime in core. The test package makes the experiment more honest;
it does not change that adoption threshold.

## Primary sources

- [Effect v4 beta announcement](https://effect.website/blog/releases/effect/40-beta/)
- [`effect@4.0.0-beta.101`](https://www.npmjs.com/package/effect/v/4.0.0-beta.101)
- [`@effect/vitest@4.0.0-beta.101`](https://www.npmjs.com/package/@effect/vitest/v/4.0.0-beta.101)
- [Exact beta.101 repository commit](https://github.com/Effect-TS/effect/tree/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e)
- [V4 migration guide](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/MIGRATION.md)
- [V4 error-handling migration](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/migration/error-handling.md)
- [V4 Cause migration](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/migration/cause.md)
- [V4 services migration](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/migration/services.md)
- [V4 runtime migration](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/migration/runtime.md)
- [Exact Effect source](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/src/Effect.ts)
- [Exact Cause source](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/src/Cause.ts)
- [Exact Exit source](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/src/Exit.ts)
- [Exact Data source](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/src/Data.ts)
- [Exact Context source](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/src/Context.ts)
- [Exact Layer source](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/src/Layer.ts)
- [Exact ManagedRuntime source](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/src/ManagedRuntime.ts)
- [Exact Logger source](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/src/Logger.ts)
- [Exact Tracer source](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/src/Tracer.ts)
- [Exact Metric source](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/src/Metric.ts)
- [Exact `@effect/vitest` package metadata](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/vitest/package.json)
- [Exact `@effect/vitest` public API](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/vitest/src/index.ts)
- [Exact `@effect/vitest` runner and Layer implementation](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/vitest/src/internal/internal.ts)
- [Exact `@effect/vitest` assertion helpers](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/vitest/src/utils.ts)
- [Exact `TestClock` source](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/src/testing/TestClock.ts)
- [Exact `TestConsole` source](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/src/testing/TestConsole.ts)
- [Beta.101 `@effect/vitest` README](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/vitest/README.md)
- [Exact runtime implementation](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/effect/src/internal/effect.ts)
- [Exact v4 OpenTelemetry Cause mapping](https://github.com/Effect-TS/effect/blob/4e0be584fbde272d201b4ad24eaa9b0c8e56f25e/packages/opentelemetry/src/OtelTracer.ts)
