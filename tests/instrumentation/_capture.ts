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
 * Both APIs are intentionally tiny. Do not grow this file beyond what two or
 * more test files share.
 *
 * IMPORTANT (OTel load timing): `createTracerWrapper()` loads `@opentelemetry/api`
 * lazily. `isEnabled()` returns false until the first `startActiveSpan` has
 * awaited the internal load. Use `await primeTracer(tracer)` when a test needs
 * `isEnabled()` to be true without first running a real span, or just call a
 * span first.
 */

import {
  InMemorySpanExporter,
  NodeTracerProvider,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import type { TracerWrapper } from "../../src/instrumentation/tracer";
import type { LogCallback, LogEvent } from "../../src/instrumentation/types";

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
      await provider.shutdown();
      exporter.reset();
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
