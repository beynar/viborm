import { trace } from "@opentelemetry/api";
import { beforeAll, describe, expect, it } from "vitest";
import { SPAN_OPERATION } from "../../src/instrumentation/spans";
import { createTracerWrapper } from "../../src/instrumentation/tracer";
import { primeTracer } from "./_capture";

// The branch where @opentelemetry/api LOADS but no TracerProvider is
// registered: `trace.getTracer()` returns OTel's built-in no-op proxy, so
// every span operation (startSpan / setStatus / recordException / end) must
// execute as a callable no-op and never throw. Distinct from getNoopTracer
// (OTel absent). Kept in its own file with the global provider explicitly
// disabled so no sibling recorder can leak a provider in.
describe("createTracerWrapper (OTel loaded, no provider registered)", () => {
  beforeAll(() => {
    // Reset the global to OTel's built-in no-op proxy — the "importable but no
    // exporter registered" state this test exists to pin.
    trace.disable();
  });

  it("startActiveSpan runs the callback and returns its value; otel is loaded but inert", async () => {
    const tracer = createTracerWrapper();
    await primeTracer(tracer);

    // otel imported successfully...
    expect(tracer.isEnabled()).toBe(true);
    // ...but with no provider, the span is a no-op and the callback still runs.
    const result = await tracer.startActiveSpan(
      { name: SPAN_OPERATION },
      () => "async-value"
    );

    expect(result).toBe("async-value");
  });

  it("startActiveSpanSync runs the callback and returns its value without throwing", () => {
    const tracer = createTracerWrapper();

    const result = tracer.startActiveSpanSync(
      { name: SPAN_OPERATION },
      () => "sync-value"
    );

    expect(result).toBe("sync-value");
  });
});
