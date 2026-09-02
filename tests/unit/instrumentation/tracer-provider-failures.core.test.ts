import { beforeEach, describe, expect, it, vi } from "vitest";

type ProviderMode =
  | "active-throws"
  | "context-skips"
  | "context-throws-after"
  | "context-throws-before"
  | "context-reenters"
  | "context-twice"
  | "get-tracer-throws"
  | "normal"
  | "set-span-throws"
  | "span-methods-throw"
  | "start-span-throws";

interface ProviderState {
  callbackCalls: number;
  mode: ProviderMode;
  reenter?: (() => void) | undefined;
}

const provider = vi.hoisted<ProviderState>(() => ({
  callbackCalls: 0,
  mode: "normal",
  reenter: undefined,
}));

vi.mock("@opentelemetry/api", () => {
  const span = {
    end() {
      if (provider.mode === "span-methods-throw") throw new Error("end failed");
    },
    recordException() {
      if (provider.mode === "span-methods-throw") {
        throw new Error("recordException failed");
      }
    },
    setStatus() {
      if (provider.mode === "span-methods-throw") {
        throw new Error("setStatus failed");
      }
    },
  };
  const tracer = {
    startSpan() {
      if (provider.mode === "start-span-throws") {
        throw new Error("startSpan failed");
      }
      return span;
    },
  };
  const context = {
    active() {
      if (provider.mode === "active-throws") {
        throw new Error("active failed");
      }
      return {};
    },
    with(_context: unknown, run: () => unknown) {
      if (provider.mode === "context-throws-before") {
        throw new Error("context failed before callback");
      }
      if (provider.mode === "context-skips") return undefined;
      if (provider.mode === "context-reenters") {
        provider.reenter = () => {
          provider.reenter = undefined;
          try {
            Promise.resolve(run()).catch(() => undefined);
          } catch {
            // The hostile provider contains its attempted re-entry.
          }
        };
      }
      const value = run();
      if (provider.mode === "context-twice") run();
      if (provider.mode === "context-throws-after") {
        throw new Error("context failed after callback");
      }
      return value;
    },
  };
  return {
    context,
    ROOT_CONTEXT: {},
    SpanKind: { INTERNAL: 0 },
    SpanStatusCode: { ERROR: 2, OK: 1 },
    trace: {
      getTracer() {
        if (provider.mode === "get-tracer-throws") {
          throw new Error("getTracer failed");
        }
        return tracer;
      },
      setSpan() {
        if (provider.mode === "set-span-throws") {
          throw new Error("setSpan failed");
        }
        return {};
      },
    },
  };
});

import { SPAN_OPERATION } from "@src/instrumentation/spans";
import { createTracerWrapper } from "@src/instrumentation/tracer";

beforeEach(() => {
  provider.callbackCalls = 0;
  provider.mode = "normal";
  provider.reenter = undefined;
});

function runAsync(mode: ProviderMode): Promise<string> {
  provider.mode = mode;
  const tracer = createTracerWrapper();
  return tracer.startActiveSpan({ name: SPAN_OPERATION }, () => {
    provider.callbackCalls += 1;
    provider.reenter?.();
    return "authoritative";
  });
}

describe("OpenTelemetry provider failure boundary", () => {
  it.each([
    "active-throws",
    "context-skips",
    "context-throws-after",
    "context-throws-before",
    "context-reenters",
    "context-twice",
    "get-tracer-throws",
    "set-span-throws",
    "start-span-throws",
  ] satisfies ProviderMode[])("preserves async work when %s", async (mode) => {
    await expect(runAsync(mode)).resolves.toBe("authoritative");
    expect(provider.callbackCalls).toBe(1);
  });

  it("contains span observer failures on success and failure", async () => {
    await expect(runAsync("span-methods-throw")).resolves.toBe("authoritative");
    expect(provider.callbackCalls).toBe(1);

    const failure = new Error("application failure");
    const tracer = createTracerWrapper();
    provider.callbackCalls = 0;
    await expect(
      tracer.startActiveSpan({ name: SPAN_OPERATION }, () => {
        provider.callbackCalls += 1;
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(provider.callbackCalls).toBe(1);
  });

  it.each([
    "active-throws",
    "context-skips",
    "context-throws-after",
    "context-throws-before",
    "context-reenters",
    "context-twice",
  ] satisfies ProviderMode[])("preserves sync work when %s", async (mode) => {
    const tracer = createTracerWrapper();
    await tracer.startActiveSpan({ name: SPAN_OPERATION }, () => undefined);
    provider.mode = mode;

    const value = tracer.startActiveSpanSync({ name: SPAN_OPERATION }, () => {
      provider.callbackCalls += 1;
      provider.reenter?.();
      return "authoritative";
    });

    expect(value).toBe("authoritative");
    expect(provider.callbackCalls).toBe(1);
  });

  it("preserves sync failures when span observers fail", async () => {
    const tracer = createTracerWrapper();
    await tracer.startActiveSpan({ name: SPAN_OPERATION }, () => undefined);
    provider.mode = "span-methods-throw";
    const failure = new Error("sync application failure");

    expect(() =>
      tracer.startActiveSpanSync({ name: SPAN_OPERATION }, () => {
        throw failure;
      })
    ).toThrow(failure);
  });
});
