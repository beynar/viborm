import { beforeEach, describe, expect, it, vi } from "vitest";

type ProviderMode =
  | "active-throws"
  | "context-skips"
  | "context-throws-after"
  | "context-throws-before"
  | "context-reenters"
  | "context-twice"
  | "get-tracer-throws"
  | "kind-throws"
  | "normal"
  | "set-span-throws"
  | "span-methods-throw"
  | "start-span-throws"
  | "status-codes-own";

interface ProviderState {
  callbackCalls: number;
  spanCalls: string[];
  mode: ProviderMode;
  reenter?: (() => void) | undefined;
}

const provider = vi.hoisted<ProviderState>(() => ({
  callbackCalls: 0,
  spanCalls: [],
  mode: "normal",
  reenter: undefined,
}));

vi.mock("@opentelemetry/api", () => {
  // A fresh span per startSpan, as an OpenTelemetry SDK hands out: VibORM
  // ends a span object once, whichever operation settles it first.
  const createSpan = () => ({
    end() {
      if (provider.mode === "span-methods-throw") throw new Error("end failed");
    },
    recordException() {
      if (provider.mode === "span-methods-throw") {
        throw new Error("recordException failed");
      }
    },
    setStatus(status: unknown) {
      provider.spanCalls.push(`status:${JSON.stringify(status)}`);
      if (provider.mode === "span-methods-throw") {
        throw new Error("setStatus failed");
      }
    },
  });
  const tracer = {
    startSpan(_name: string, options: { kind: unknown }) {
      if (provider.mode === "start-span-throws") {
        throw new Error("startSpan failed");
      }
      provider.spanCalls.push(`start:${String(options.kind)}`);
      return createSpan();
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
    // The auto-detected path reads the kind and status codes from the api.
    get SpanKind() {
      if (provider.mode === "kind-throws") throw new Error("SpanKind failed");
      return { INTERNAL: 0 };
    },
    get SpanStatusCode() {
      return provider.mode === "status-codes-own"
        ? { ERROR: 12, OK: 11 }
        : { ERROR: 2, OK: 1 };
    },
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
  provider.spanCalls = [];
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
    "kind-throws",
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

  it("reads the span kind and status codes from the detected api", async () => {
    await expect(runAsync("kind-throws")).resolves.toBe("authoritative");
    // An api whose SpanKind cannot be read starts no span.
    expect(provider.spanCalls).toEqual([]);

    await expect(runAsync("status-codes-own")).resolves.toBe("authoritative");
    const failure = new Error("application failure");
    await expect(
      createTracerWrapper().startActiveSpan({ name: SPAN_OPERATION }, () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(provider.spanCalls).toEqual([
      "start:0",
      `status:${JSON.stringify({ code: 11 })}`,
      "start:0",
      `status:${JSON.stringify({ code: 12, message: "Operation failed" })}`,
    ]);
  });
});
