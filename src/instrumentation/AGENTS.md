# Instrumentation — Protected Tracing and Logging

**Location:** `src/instrumentation/`
**Layer:** L11

## Purpose

Instrumentation presents OpenTelemetry spans, structured logs, and diagnostic
disclosure from the units core runs, read through the public unit words. It observes application
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
There is no driver/cache setter fallback. Each `instrumentation()` value owns
one immutable `InstrumentationContext`; shared drivers and caches do not share
its tracer, logger, or disclosure.

`instrumentation(config)` is written with public words only:
`extension("viborm.instrumentation", unit(observe), disclosure(diagnostics))`.
With neither `tracing` nor `logging` it is the `disclosure` part alone.

## Owners

| Owner | Responsibility |
|---|---|
| `src/instrumentation/extension.ts` | The factory and the one unit handler over every kind, with its own containment |
| `context.ts` | Config snapshot and instrumentation context |
| `presentation.ts` | Span options, attributes and log events, built from the unit words |
| `tracer.ts` | Active spans through a handed tracer or the auto-detected optional OTel api; the exactly-once containment and span settlement both paths share |
| `logger.ts` | Level selection (`query`, `cache`, `error`), callback containment, pretty presentation, the log metadata vocabulary |
| `src/extensions/observation.ts` | The one generation of unit handlers (`runUnit`), the array barrier (`members`), `work` |
| `src/extensions/unit-words.ts` | The unit words: `text`, `parameters`, `driver`, `failure`, `correlation`, `table`, `statements`, `origin`, `statement`, `run`, `note`, `notes` |
| `src/errors/logged-errors.ts` | The line of successors the package makes from one failure (`origin`) |

Core never names this extension: it builds a unit only where the chain has a
`unit` part (`chain.observation`), and reads the disclosure policy from
`chain.disclosure`.

## Units

A unit starts at its physical boundary. `operation` around the whole call;
`statement` around the one provider call, after rewriting, rendering, the
parameter snapshot and taking the connection: one unit per physical send, a
native batch included (`statements(u)` gives its members); `transaction`,
`savepoint`, `connection` past the queue wait; `batch` around
`$transaction([...])`, which waits until every member's operation unit
reached its child before preparing any member. The cache emits `cache` units
of its own through `work`.

A unit of any other kind is presented from its notes alone
(`presentNoted`, `InstrumentationNote` in `types.ts`): the span its first
note names as it starts, `attributes` noted later set at its end, every
`log` note logged at its level; on the call's `operation` unit, after it
ends, its `cache` logs alone. The instrumentation names no extension's
units: the cache's spans and logs are what the cache notes. Never add a
branch for one extension's kind.

What the disclosure settings promise holds for notes because a note never
carries what they govern: an attribute under `db.query.` is dropped
(`notedAttributes`), whatever `includeSql` and `includeParams` say, and a
note's `error` and `meta` pass the same sanitizers as every log's
(`sanitizeErrorForLogging`, `sanitizeLogMetadata`). A note may not take the
name of a call's own span (`tracesAs`): its unit is then presented without a
span; `viborm.operation` is admitted as a root span, an operation outside
any call (the cache's revalidation). Dropping, never refusing: the
instrumentation never fails the call it observes. Never add a second
sanitizer for notes; never let a note reach a core unit's span.

Every handler is a plain wrapper `(u, next) => …`: the child starts only at
`next()`, the host awaits the handler's promise, `next()` is called once and
must be, the child's failure is authoritative, and what a handler throws
fails the call. That is what keeps the execute span inside the operation span
with no prewarm: a handler waiting for the OTel import delays its child.

The instrumentation contains its own failures (`observe` in `extension.ts`):
`next()` runs exactly once whatever the presentation does, and its returned
promise never rejects. A failure a statement log presented is not presented
again by its operation (`origin`).

## Span rules

- `viborm.operation` owns the complete logical operation.
- `viborm.execute` owns one provider statement dispatch, or the one native
  provider batch presentation.
- `viborm.transaction` (savepoints too), connection, and cache spans
  represent only real lifecycle boundaries; a batch has no span.
- There are no separate validate/build/parse spans.
- `db.namespace` reports `adapter.namespace` and is added in exactly one place,
  `createDriverAttributes` in `presentation.ts`, from the identity
  `readDriverIdentity` (`src/drivers/driver-identity.ts`) reads — the one reader
  of `adapter.namespace` for presentation. When the adapter is unqualified the
  KEY IS ABSENT; never emit `null`, `""`, or the text `undefined`. Do not add the
  attribute to a span that carries no other `db.*` (the cache backend's own
  get/set/delete/clear spans), and do not invent a lifecycle fact kind for it. Immutability rides the non-writable `adapter.namespace`
  install, NOT a ban on copies: `readDriverIdentity` returns a fresh frozen
  record on every call, and the cache revalidation span is built from the
  `database(run)` the read took when it was served, noted as the unit's
  `database` and rendered by `createDriverAttributes`. `driver(u)` reads a fresh identity from the
  unit's driver when it is called; a unit never hands the extension its
  driver itself. No snapshot can go stale, because the property it read cannot be
  reassigned — which is also why no reader may take its namespace from
  anywhere else. `readDriverIdentity` contains its own read: when a custom
  adapter's `namespace` getter throws it returns `undefined`, and the
  operation, execute, lifecycle and cache revalidation spans are presented
  without `db.*` attributes while the operation's facts and error log survive.
- The unobserved native-batch phase must keep calling `readDriverIdentity` zero
  times; it is pinned (`native-batch-attribution.core`, a `vi.mock` spy on
  `@drivers/driver-identity`), and any new identity fact has to preserve that.
- Ignoring a cache span must not write late cache attributes onto its parent.
- Verbatim unsafe raw is never rewritten, but its physical execution remains
  observed without implicit SQL/parameter disclosure.

## Optional OTel

With `tracing: { tracer }` the wrapper starts spans through that tracer's
two-argument `startActiveSpan(name, fn)`, the form an OpenTelemetry `Tracer`
and Cloudflare Workers' `tracing` (from `cloudflare:workers`) both accept; the
Workers runtime throws a TypeError on a second argument that is not a function.
It never imports `@opentelemetry/api`: `tracer` is typed by the structural
`SpanTracer`/`TracingSpan` in `types.ts` (no OTel type reaches the published
d.ts), and the `SpanStatusCode` OK/ERROR values are the api 1.x contract
values declared in `tracer.ts`. Attributes are set with `span.setAttribute`
after the span starts; kind and `root` are not passed (the tracer decides the
parent). `setStatus` and `recordException` are called only when the span has
them (the Workers span has neither on workerd 1.20260801.1). It is enabled at
once. The config snapshot keeps the tracer by
reference only when it has a callable `startActiveSpan`; any other value falls
back to auto-detection.

Without `tracer`, `@opentelemetry/api` is dynamically imported, and the span
kind and status codes are read from that api object, as they always were.
Missing or hostile OTel falls back to application execution. The first span
waits for the import; later spans start synchronously.

Both paths share one containment (`createExecution`): the application callback
runs exactly once whether the tracer or context manager calls back twice,
re-entrantly, late, never, or throws, and every span any callback brings is
settled (status when available, then `end`) with that run's outcome,
including a second or late span a hostile tracer hands over, even from inside
another span's `end()`. `endSpan` ends each span at most once across every
execution (the module's `settledSpans`), so a span handed to two operations or
re-entrantly during settlement is never ended twice. Every span call runs
through `safely`: its throw is consumed, and a thenable it returns is handed a
no-op rejection handler through its own `then`, never awaited; a non-thenable
result allocates nothing. A promise with a replaced `then` or a throwing
`constructor` is out of reach of any handler and is documented as such. Execute
and lifecycle span options read the driver's own metadata only through
`readDriverIdentity`, which cannot throw, so building them cannot leave the
gated child pending.

## Validation

Run focused instrumentation contracts, then the client, driver,
instrumentation, query-engine, and cache layer gates sequentially. The
`pnpm test:coverage:instrumentation` command is the exact 100% subsystem report
and writes `coverage/instrumentation/index.html`. It runs with one 768 MB worker
under the 1536 MiB sampled process-group RSS ceiling and verifies process-group teardown.

Diagnostic provider/callsite disclosure uses the existing `DiagnosticDisclosure`
owner: `includeProviderDetails` and `includeCallsite` are false by default. The
error snapshot retains bounded own-data provider message/detail/hint with
credential redaction; the private operation execution context captures origin
only when opted in. Official logs preserve those selected diagnostics while SQL
and parameters remain channel-owned. Tracer settlement publishes only canonical class/code and
allowlisted SQLSTATE, never provider message/callsite/parameters.
