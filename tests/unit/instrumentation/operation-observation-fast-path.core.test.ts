import { createClient } from "@client/client";
import { isVibORMError } from "@errors";
import { createInstrumentationContext } from "@instrumentation/context";
import {
  ATTR_DB_COLLECTION,
  ATTR_DB_OPERATION_NAME,
  ATTR_VIBORM_CORRELATION_ID,
  SPAN_OPERATION,
} from "@instrumentation/spans";
import type { TracerWrapper, VibORMSpanOptions } from "@instrumentation/tracer";
import type { InstrumentationConfig } from "@instrumentation/types";
import { observeTransactionBatchPhase } from "@query-engine/execution-context";
import { PendingOperation } from "@query-engine/pending-operation";
import { QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import { captureLogs } from "@tests/unit/instrumentation/_capture";
import { FakeDriver } from "@tests/unit/instrumentation/_fake-driver";
import { afterEach, describe, expect, it, vi } from "vitest";

const user = s.model({ id: s.int().id() });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("transaction batch phase observation gates", () => {
  it("bypasses observation on success and still normalizes failure", async () => {
    const observation = createObservedPending({}, false);
    const clock = vi.spyOn(Date, "now");
    const baseAttributes = vi.spyOn(observation.driver, "getBaseAttributes");

    await expect(
      observeTransactionBatchPhase(
        observation.pending,
        observation.driver,
        () => "done"
      )
    ).resolves.toBe("done");
    expect(clock).not.toHaveBeenCalled();
    expect(baseAttributes).not.toHaveBeenCalled();
    expect(observation.startedSpans).toHaveLength(0);

    const error = await observeTransactionBatchPhase(
      observation.pending,
      observation.driver,
      () => {
        throw new Error("batch preparation failed");
      }
    ).catch((caught) => caught);

    if (!isVibORMError(error)) throw new Error("expected a VibORM error");
    expect(error.meta).toMatchObject({
      driver: observation.driver.driverName,
      model: "user",
      operation: "findMany",
      correlationId: observation.pending.getExecutionContext().correlationId,
    });
    expect(baseAttributes).not.toHaveBeenCalled();
    expect(observation.startedSpans).toHaveLength(0);
  });

  it("logs a normalized batch failure without invoking logging-only tracing", async () => {
    const logs = captureLogs();
    const observation = createObservedPending(
      { logging: { error: logs.callback } },
      false
    );

    const error = await observeTransactionBatchPhase(
      observation.pending,
      observation.driver,
      () => Promise.reject(new Error("batch parse failed"))
    ).catch((caught) => caught);

    if (!isVibORMError(error)) throw new Error("expected a VibORM error");
    expect(observation.startedSpans).toHaveLength(0);
    expect(logs.events).toContainEqual(
      expect.objectContaining({
        level: "error",
        model: "user",
        operation: "findMany",
        correlationId: observation.pending.getExecutionContext().correlationId,
        duration: expect.any(Number),
      })
    );
    expect(logs.events[0]?.error).toMatchObject({
      code: error.code,
      meta: error.meta,
    });
  });

  it.each([
    false,
    true,
  ])("uses configured tracing when provider enabled is %s", async (enabled) => {
    const observation = createObservedPending({ tracing: true }, enabled);

    await observeTransactionBatchPhase(
      observation.pending,
      observation.driver,
      () => "done"
    );

    expect(observation.startedSpans).toContainEqual({
      name: SPAN_OPERATION,
      attributes: expect.objectContaining({
        [ATTR_DB_COLLECTION]: "user",
        [ATTR_DB_OPERATION_NAME]: "findMany",
        [ATTR_VIBORM_CORRELATION_ID]:
          observation.pending.getExecutionContext().correlationId,
      }),
    });
    expect(observation.isEnabled).not.toHaveBeenCalled();
  });
});

function createPending(instrumentation: InstrumentationConfig) {
  const driver = new FakeDriver();
  const client = createClient({
    schema: { user },
    driver,
    instrumentation,
  });
  return { driver, pending: client.user.findMany() };
}

function createObservedPending(
  config: InstrumentationConfig,
  enabled: boolean
) {
  const seed = createPending({});
  const startedSpans: VibORMSpanOptions[] = [];
  const isEnabled = vi.fn(() => enabled);
  const tracer: TracerWrapper = {
    async startActiveSpan(options, execute) {
      startedSpans.push(options);
      return execute();
    },
    startActiveSpanSync(options, execute) {
      startedSpans.push(options);
      return execute();
    },
    isEnabled,
  };
  const instrumentation = {
    ...createInstrumentationContext(config),
    tracer,
  };
  const engine = new QueryEngine(
    seed.driver,
    seed.pending.engine.registry,
    instrumentation
  );
  const pending = PendingOperation.create<unknown>(
    engine,
    user,
    "findMany",
    {}
  );
  return { driver: seed.driver, isEnabled, pending, startedSpans };
}
