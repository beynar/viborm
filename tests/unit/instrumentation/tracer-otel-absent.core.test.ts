import { describe, expect, it, vi } from "vitest";

vi.mock("@opentelemetry/api", () => {
  throw new Error("OpenTelemetry is unavailable");
});

import { SPAN_EXECUTE } from "@src/instrumentation/spans";
import { createTracerWrapper } from "@src/instrumentation/tracer";

describe("createTracerWrapper without the optional OTel peer", () => {
  it("executes async success callbacks exactly once", async () => {
    const callback = vi.fn(async () => "success");
    const tracer = createTracerWrapper();

    await expect(
      tracer.startActiveSpan({ name: SPAN_EXECUTE }, callback)
    ).resolves.toBe("success");
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("preserves async callback failures without retrying", async () => {
    const failure = new Error("operation failed");
    const callback = vi.fn(async () => {
      throw failure;
    });
    const tracer = createTracerWrapper();

    await expect(
      tracer.startActiveSpan({ name: SPAN_EXECUTE }, callback)
    ).rejects.toBe(failure);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("executes sync success callbacks exactly once", () => {
    const callback = vi.fn(() => "success");
    const tracer = createTracerWrapper();

    expect(tracer.startActiveSpanSync({ name: SPAN_EXECUTE }, callback)).toBe(
      "success"
    );
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("preserves sync callback failures without retrying", () => {
    const failure = new Error("operation failed");
    const callback = vi.fn(() => {
      throw failure;
    });
    const tracer = createTracerWrapper();

    expect(() =>
      tracer.startActiveSpanSync({ name: SPAN_EXECUTE }, callback)
    ).toThrow(failure);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("keeps late active-span attributes inert without the optional peer", async () => {
    const tracer = createTracerWrapper();
    await tracer.startActiveSpan({ name: SPAN_EXECUTE }, () => undefined);

    expect(() =>
      tracer.setActiveSpanAttributes?.({ "viborm.test.late": "ignored" })
    ).not.toThrow();
  });
});
