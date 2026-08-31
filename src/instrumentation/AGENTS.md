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
| `src/instrumentation/extension.ts` | Fixed-name factory and the one trusted protected-observer handler |
| `context.ts` | Hostile-safe config snapshot and instrumentation context |
| `lifecycle-facts.ts` | Private facts keyed by core-created frozen lifecycle units |
| `tracer.ts` | Optional OTel loading, active spans, containment, span mutation |
| `logger.ts` | Level selection, callback containment, pretty presentation |
| `driver-instrumentation.ts` | Provider-dispatch facts and instrumentation presentation only; no generic extension runner |
| `src/extensions/observation.ts` | Public unit/completion onion, trusted identity registry, and the one contained observer runner |

Do not add another event registry, presenter, context manager, public token, or
driver-attached instrumentation state.

## Lifecycle rail

Public units are discriminated as `operation`, `statement`, `batch`,
`transaction`, `savepoint`, `segment`, `connection`, or `cache`. Core creates
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
arrays use the real transaction or savepoint. Progressive writes emit one
segment per submitted attempt. Cache revalidation owns its real nested set and
cleanup facts without exposing marker helpers as public lifecycle units.

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
successor errors that add execution context or commit certainty. Public
completion exposes only a sanitized summary and optional certainty.

Observer, logger, console, OTel import/provider/span, and cache-presentation
failures are contained. They cannot replace the child value/error, prevent an
independent durable-fact consumer from running, alter commit, or cause an
unhandled rejection.

## Span rules

- `viborm.operation` owns the complete logical operation.
- `viborm.execute` owns one provider statement dispatch, or the one native
  provider batch presentation.
- `viborm.transaction`, `viborm.savepoint`, `viborm.batch`, `viborm.segment`,
  connection, and cache spans represent only real lifecycle boundaries.
- There are no separate validate/build/parse spans.
- `db.namespace` reports `adapter.namespace` and is added in exactly one place,
  `Driver.getBaseAttributes()` in `src/drivers/driver-instrumentation.ts` —
  outside this layer's 100% coverage glob, and the single choke point every
  `db.*`-carrying unit already flows through. When the adapter is unqualified the
  KEY IS ABSENT; never emit `null`, `""`, or the text `undefined`. Do not add the
  attribute to a unit that carries no other `db.*` (write segments, the cache
  backend's own get/set spans), and do not invent a lifecycle kind for it — the
  five kinds are fixed. Immutability rides the non-writable `adapter.namespace`
  install, NOT a ban on copies: `getBaseAttributes()` returns a fresh literal on
  every call, and the cache unit's span is deliberately built from a snapshot of
  one, taken at `$withCache` and carried as `options.dbAttributes`. That
  snapshot cannot go stale, because the property it read cannot be reassigned —
  which is also why no reader may take its namespace from anywhere else.
- The unobserved native-batch phase must keep calling `getBaseAttributes` zero
  times; it is pinned, and any new base attribute has to preserve that.
- Ignoring a cache span must not write late cache attributes onto its parent.
- Segment aggregate attributes can update the exact active operation span at
  the existing final boundary.
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
