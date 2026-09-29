/**
 * Shared test helpers for the instrumentation suite.
 *
 * Two axes of observation, both testing REAL behavior (no mocking the unit
 * under test):
 *
 *  1. LOG capture — `captureLogs()` returns a `LogCallback` plus the array it
 *     fills. Pass the callback as a level handler (e.g. `{ query: cb }`) so the
 *     real `createLogger` emit/sanitize path runs and you assert on the emitted
 *     `LogEvent`s. `invokeDefault` optionally calls the default pretty logger so
 *     you can exercise the "callback also calls log()" branch.
 *
 *  2. SPAN capture — `withOtelRecorder()` registers a REAL OpenTelemetry
 *     `NodeTracerProvider` backed by an `InMemorySpanExporter`. Spans produced
 *     by the real `createTracerWrapper()` are recorded and returned as
 *     `ReadableSpan[]`. This exercises the genuine OTel-present code path
 *     (getTracer, context.with parenting, setStatus, recordException).
 *
 *  3. NORMALIZATION — `normalizeSpans` / `normalizeCorrelation` / `plain`, the
 *     golden transcript's lens, shared with the platform-tracer comparison.
 *
 * All three are intentionally tiny. Do not grow this file beyond what two or
 * more test files share.
 *
 * IMPORTANT (OTel load timing): `createTracerWrapper()` loads `@opentelemetry/api`
 * lazily. `isEnabled()` returns false until the first `startActiveSpan` has
 * awaited the internal load. Use `await primeTracer(tracer)` when a test needs
 * `isEnabled()` to be true without first running a real span, or just call a
 * span first.
 */

import { trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import type { TracerWrapper } from "@src/instrumentation/tracer";
import type { LogCallback, LogEvent } from "@src/instrumentation/types";

// ---------------------------------------------------------------------------
// Log capture
// ---------------------------------------------------------------------------

export interface LogCapture {
  /** All events the logger emitted to this handler, in order. */
  events: LogEvent[];
  /** Pass this as a level handler in a LoggingConfig. */
  callback: LogCallback;
}

/**
 * Create a capturing LogCallback.
 *
 * @param invokeDefault - when true, the callback also calls the provided
 *   default `log()` (the real pretty logger). Use to test the "callback then
 *   log()" branch. Defaults to false (silent capture).
 */
export function captureLogs(invokeDefault = false): LogCapture {
  const events: LogEvent[] = [];
  const callback: LogCallback = (event, log) => {
    events.push(event);
    if (invokeDefault) {
      log();
    }
  };
  return { events, callback };
}

// ---------------------------------------------------------------------------
// Span capture (real OpenTelemetry SDK)
// ---------------------------------------------------------------------------

export interface OtelRecorder {
  /** Finished spans recorded so far, oldest first. */
  spans(): ReadableSpan[];
  /** Look up a single recorded span by its name (first match). */
  find(name: string): ReadableSpan | undefined;
  /** Unregister the global provider and shut it down. Call in afterEach. */
  dispose(): Promise<void>;
}

/**
 * Register a real in-memory OTel provider globally so that
 * `createTracerWrapper()` produces recorded spans.
 *
 * The real tracer wrapper calls `trace.getTracer(...)`, which resolves to this
 * registered provider. Always `await recorder.dispose()` in teardown to avoid
 * leaking the global provider across tests.
 */
export function withOtelRecorder(): OtelRecorder {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();

  return {
    spans: () => exporter.getFinishedSpans(),
    find: (name) => exporter.getFinishedSpans().find((s) => s.name === name),
    async dispose() {
      try {
        await provider.shutdown();
      } finally {
        trace.disable();
        exporter.reset();
      }
    },
  };
}

/**
 * Force a real tracer wrapper to finish its lazy OTel load so `isEnabled()`
 * reflects the loaded state. Runs a throwaway span through an ignored name so
 * no span is recorded.
 */
export async function primeTracer(tracer: TracerWrapper): Promise<void> {
  await tracer.startActiveSpan({ name: "viborm.operation" }, () => undefined);
}

// ---------------------------------------------------------------------------
// Normalization (the golden transcript's; shared with the platform-tracer
// comparison so both read spans through one lens)
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A JSON-plain copy: sorted keys, no `undefined` members, dates as ISO. */
export function plain(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    const json: unknown = JSON.parse(JSON.stringify(value));
    return plain({
      name: value.name,
      message: value.message,
      ...(typeof json === "object" && json !== null ? json : {}),
    });
  }
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const member: unknown = Reflect.get(value, key);
      if (member !== undefined) out[key] = plain(member);
    }
    return out;
  }
  return value;
}

/** Spans with ids and trace ids as ordinals by first appearance. */
export function normalizeSpans(spans: readonly ReadableSpan[]) {
  const spanIds = new Map<string, string>();
  const traceIds = new Map<string, string>();
  for (const span of spans) {
    spanIds.set(span.spanContext().spanId, `span-${spanIds.size + 1}`);
  }
  return spans.map((span) => {
    const traceId = span.spanContext().traceId;
    if (!traceIds.has(traceId)) {
      traceIds.set(traceId, `trace-${traceIds.size + 1}`);
    }
    const parentId = span.parentSpanContext?.spanId;
    return {
      id: spanIds.get(span.spanContext().spanId),
      trace: traceIds.get(traceId),
      parent:
        parentId === undefined ? null : (spanIds.get(parentId) ?? "external"),
      name: span.name,
      kind: span.kind,
      attributes: plain(span.attributes),
      status: plain(span.status),
      events: span.events.map((event) => ({
        name: event.name,
        attributes: plain(event.attributes ?? {}),
      })),
    };
  });
}

/** Correlation UUIDs as ordinals by first appearance. */
export function normalizeCorrelation(
  value: unknown,
  ordinals: Map<string, string>
) {
  if (typeof value === "string" && UUID.test(value)) {
    if (!ordinals.has(value)) {
      ordinals.set(value, `correlation-${ordinals.size + 1}`);
    }
    return ordinals.get(value);
  }
  if (Array.isArray(value)) {
    return value.map((member) => normalizeCorrelation(member, ordinals));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      out[key] = normalizeCorrelation(member, ordinals);
    }
    return out;
  }
  return value;
}
