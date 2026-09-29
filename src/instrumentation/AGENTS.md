# Instrumentation — Protected Tracing and Logging

**Location:** `src/instrumentation/`
**Layer:** L11

## Purpose

Instrumentation presents OpenTelemetry spans, structured logs, and diagnostic
disclosure from authenticated core lifecycle facts. It observes application
work; it never chooses SQL, cache policy, query recovery, transaction outcome,
or application error authority.

The sole public configuration is the fixed-name official extension:

```ts
const observed = createClient({ schema, driver }).$extends(
  instrumentation({
    tracing: { includeSql: false, includeParams: false },
    logging: { query: true, cache: true, error: true },
    diagnostics: { includeSql: false, includeParams: false },
  })
);
```

Never restore `instrumentation` to `createClient()` or driver-wrapper config.
There is no driver/cache setter fallback. Each exact chain owns one immutable
`InstrumentationContext`; shared drivers and caches do not share its tracer,
logger, disclosure, or correlation.

## Owners

| Owner | Responsibility |
|---|---|
| `src/instrumentation/extension.ts` | Fixed-name factory, the one trusted protected-observer handler, and the private capability→context map (core holds only the neutral capability) |
| `context.ts` | Hostile-safe config snapshot and instrumentation context |
| `presentation.ts` | Span options, attributes, log events and per-channel disclosure built from core's neutral facts (`src/extensions/official-facts.ts`) |
| `tracer.ts` | Optional OTel loading, active spans, containment, span mutation |
| `logger.ts` | Level selection, callback containment, pretty presentation, and the log metadata vocabulary (`LOG_META_KEYS`) |
| `src/drivers/driver-instrumentation.ts` | Provider-dispatch facts, the statement log decision and de-dup mark, and the deferred handoff (`start()` inside the trusted span); no presentation and no generic extension runner |
| `src/extensions/official-facts.ts` | The neutral fact contract, the fact unions core produces, and `OfficialObservationCapability` (types only, never re-exported) |
| `src/extensions/observation.ts` | Public unit/completion onion, trusted identity registry, the chain→capability map, `selectTrustedObservers`, and the one contained observer runner |
| `src/errors/logged-errors.ts` | The logged-error record: core marks a failure it selected for a log, synchronously, and transfers the mark to package-owned successors |

Core reads only `observesLifecycle`, `prewarm`, `diagnostics`, `wants(need)`
and `warn(notice)` from the capability, and the type enforces it: core holds
an `OfficialObservationCapability`, which carries no tracer, logger or
`InstrumentationContext`, and it imports nothing from this directory, not even
a type. The extension recovers its own context from its private
capability→context map. The extension formats; core selects and marks.

Do not add another event registry, presenter, context manager, public token, or
driver-attached instrumentation state.

## Lifecycle rail

Public units are discriminated as `operation`, `statement`, `batch`,
`transaction`, `savepoint`, `connection`, or `cache`. Core creates
and freezes the exact unit. The official handler identity unlocks private facts
through WeakMaps; a clone, rename, bind, copied context, or ordinary observer
cannot recover them.

Operation observation begins before lazy request transformation and completes
after query-interceptor post-work. Statement observation begins before the
statement transform. The execute presentation starts later at the old provider
dispatch boundary, after transformation, rendering preparation, and client
acquisition. Transaction/savepoint/connection observation begins outside queue
wait, while its late execute span starts at the existing serialized provider
boundary.

Protected completion facts carry the same `kind` discriminant as their start
facts. Producers publish only that kind's completion shape, and the official
observer narrows by the discriminant; property-name probes are not a lifecycle
identity mechanism.

Native arrays emit one batch, N operations, and N statement units but one
provider execute span/query log. They emit no fictional transaction. Fallback
arrays use the real transaction or savepoint. Cache revalidation owns its real
nested set and cleanup facts without exposing marker helpers as public
lifecycle units.

A cache backend delete or clear inside an invalidation has no public unit. It
runs through the same runner with only the chain's trusted observer selected
(`selectTrustedObservers` in `src/extensions/observation.ts`): the frozen unit
reuses the public `invalidate` shape so the public union does not grow, and the
private `cache-backend` facts tell the extension which span to present. No
ordinary observer receives it, and it stays a child of the invalidate span.

## Protected observer contract

Ordinary observers receive only a frozen unit and a frozen completion. They do
not receive SQL, parameters, rows, application results, cache keys, raw errors,
driver objects, correlation, or private facts. Their throw, rejection, or
never-settling returned promise cannot delay or change the application.

The official handler has a separate downstream-only application bridge. First
use can await OTel readiness while preserving its declared onion index and
active context. Setup failure is consumed and core still starts the exact child
once. Array coordination prewarms the one trusted capability once before member
observers, preparation, admission, or provider effects; ordinary-only/already-
warm paths return synchronously without a Promise allocation.

## Disclosure and errors

Tracing, logging, and diagnostics snapshot independently approved SQL and
parameter disclosures. Both fields default to false. One hostile parameter
surface is read once before provider mutation and reused by every enabled
channel. Cache keys and custom suffixes are never disclosed.

Provider failures are normalized at the driver boundary. Core owns selected
error logging and exact-error deduplication, including transfer to package-owned
successor errors that add execution context or commit certainty. The extension
formats; core selects and marks: the statement completion marks the failure it
selected synchronously, and the operation completion hands the extension a
failure only when it is not yet marked. Public
completion exposes only a sanitized summary and optional certainty.

Observer, logger, console, OTel import/provider/span, and cache-presentation
failures are contained. They cannot replace the child value/error, prevent an
independent durable-fact consumer from running, alter commit, or cause an
unhandled rejection.

## Span rules

- `viborm.operation` owns the complete logical operation.
- `viborm.execute` owns one provider statement dispatch, or the one native
  provider batch presentation.
- `viborm.transaction`, `viborm.savepoint`, `viborm.batch`, connection, and
  cache spans represent only real lifecycle boundaries.
- There are no separate validate/build/parse spans.
- `db.namespace` reports `adapter.namespace` and is added in exactly one place,
  `createDriverAttributes` in `presentation.ts`, from the identity
  `readDriverIdentity` (`src/drivers/driver-identity.ts`) reads — the one reader
  of `adapter.namespace` for presentation. When the adapter is unqualified the
  KEY IS ABSENT; never emit `null`, `""`, or the text `undefined`. Do not add the
  attribute to a span that carries no other `db.*` (the cache backend's own
  get/set/delete/clear spans), and do not invent a lifecycle fact kind for it. Immutability rides the non-writable `adapter.namespace`
  install, NOT a ban on copies: `readDriverIdentity` returns a fresh frozen
  record on every call, and the cache revalidation span is deliberately built
  from a snapshot of one, taken at `$withCache` and carried as
  `options.driverIdentity`. That snapshot cannot go stale, because the property
  it read cannot be reassigned — which is also why no reader may take its
  namespace from anywhere else.
- The unobserved native-batch phase must keep calling `readDriverIdentity` zero
  times; it is pinned (`native-batch-attribution.core`, a `vi.mock` spy on
  `@drivers/driver-identity`), and any new identity fact has to preserve that.
- Ignoring a cache span must not write late cache attributes onto its parent.
- Verbatim unsafe raw excludes statement transformation, but its physical
  execution remains observed without implicit SQL/parameter disclosure.

## Optional OTel

`@opentelemetry/api` is dynamically imported. Missing or hostile OTel falls
back to application execution. Readiness is one-shot: after it settles,
prewarming returns `undefined` synchronously and does not add a permanent
microtask to traced operations.

## Validation

Run focused instrumentation contracts, then the client, driver,
instrumentation, query-engine, and cache layer gates sequentially. The
`pnpm test:coverage:instrumentation` command is the exact 100% subsystem report
and writes `coverage/instrumentation/index.html`. It runs with one 768 MB worker
under the 1536 MiB sampled process-group RSS ceiling and verifies process-group teardown.
