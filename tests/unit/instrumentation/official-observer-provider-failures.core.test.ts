import type { LifecycleUnit } from "@extensions/observation";
import { runProtectedObservers } from "@extensions/observation";
import type {
  CacheUnitFacts,
  LifecycleDispatch,
  LifecycleFacts,
} from "@extensions/official-facts";
import type { InstrumentationLifecycleFacts } from "@instrumentation/lifecycle-facts";
import type { OfficialInstrumentationExtension } from "@src/instrumentation/extension";
import { describe, expect, it, vi } from "vitest";

/** A transaction dispatch record whose `start` releases the gated child. */
function lifecycleDispatch(start: () => void): LifecycleDispatch {
  return Object.freeze({
    boundary: "transaction",
    context: Object.freeze({ operation: "$transaction" }),
    driver: Object.freeze({
      adapter: Object.freeze({}),
      dialect: "sqlite",
      driverName: "lifecycle-test",
    }),
    start,
  });
}

type ProviderMode = "normal" | "set-attributes-throws" | "start-span-throws";

interface ProviderState {
  mode: ProviderMode;
}

const provider = vi.hoisted<ProviderState>(() => ({ mode: "normal" }));

vi.mock("@opentelemetry/api", () => {
  const span = {
    end() {
      // The hostile cases target start and late-attribute mutation only.
    },
    recordException() {
      // The hostile cases target start and late-attribute mutation only.
    },
    setAttributes() {
      if (provider.mode === "set-attributes-throws") {
        throw new Error("setAttributes failed");
      }
    },
    setStatus() {
      // The hostile cases target start and late-attribute mutation only.
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
      return {};
    },
    with(_context: unknown, run: () => unknown) {
      return run();
    },
  };
  return {
    context,
    ROOT_CONTEXT: {},
    SpanKind: { INTERNAL: 0 },
    SpanStatusCode: { ERROR: 2, OK: 1 },
    trace: {
      getSpan() {
        return undefined;
      },
      getTracer() {
        return tracer;
      },
      setSpan() {
        return {};
      },
    },
  };
});

import { instrumentation } from "@src/instrumentation/extension";

function runObserved<Result>(
  extension: OfficialInstrumentationExtension,
  unit: LifecycleUnit,
  facts: InstrumentationLifecycleFacts,
  child: () => Promise<Result>
): Promise<Result> {
  return runProtectedObservers(
    unit,
    [{ extension: extension.name, handler: extension.observe }],
    child,
    undefined,
    () => facts
  );
}

describe("official observer provider failures", () => {
  it.each([
    {
      facts: Object.freeze({
        kind: "cache",
        context: undefined,
        driverName: "memory",
        complete: () => Object.freeze({ kind: "cache", result: "hit" }),
      }) satisfies CacheUnitFacts,
      unit: Object.freeze({
        kind: "cache",
        operation: "get",
      }) satisfies LifecycleUnit,
    },
  ])("contains hostile late span attributes for $unit.kind", async (testCase) => {
    provider.mode = "set-attributes-throws";
    const extension = instrumentation({ tracing: true });
    const childValue = Object.freeze({ source: testCase.unit.kind });

    await expect(
      runObserved(
        extension,
        testCase.unit,
        testCase.facts,
        async () => childValue
      )
    ).resolves.toBe(childValue);
  });

  it("releases a traced driver lifecycle when span creation fails", async () => {
    provider.mode = "start-span-throws";
    const extension = instrumentation({ tracing: true });
    let releaseChild: ((value: string) => void) | undefined;
    const heldChild = new Promise<string>((resolve) => {
      releaseChild = resolve;
    });
    let providerStarts = 0;
    let started = false;
    const startExecution = (): void => {
      if (started) return;
      started = true;
      providerStarts += 1;
      releaseChild?.("released");
    };
    const facts: LifecycleFacts = Object.freeze({
      kind: "driver-lifecycle",
      dispatch: Promise.resolve(lifecycleDispatch(startExecution)),
      complete: () => undefined,
    });

    await expect(
      runObserved(
        extension,
        { kind: "transaction", operation: "$transaction" },
        facts,
        () => heldChild
      )
    ).resolves.toBe("released");
    expect(providerStarts).toBe(1);
  });
});
