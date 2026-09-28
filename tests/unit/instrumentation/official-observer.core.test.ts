import type { CacheLogEvent } from "@cache/cache-instrumentation";
import { appendResolvedExtension } from "@extensions/chain";
import {
  getOfficialInstrumentationChainCapability,
  type LifecycleUnit,
  runProtectedObservers,
} from "@extensions/observation";
import type {
  ObservationNeed,
  OfficialObservationCapability,
} from "@extensions/official-facts";
import type {
  CacheInstrumentationFacts,
  DriverLifecycleInstrumentationFacts,
  InstrumentationLifecycleFacts,
  OperationInstrumentationFacts,
  SegmentInstrumentationFacts,
  StatementInstrumentationFacts,
} from "@instrumentation/lifecycle-facts";
import {
  ATTR_CACHE_RESULT,
  ATTR_VIBORM_WRITE_COMMIT_OUTCOME,
  SPAN_CACHE_GET,
  SPAN_DISCONNECT,
  SPAN_EXECUTE,
  SPAN_OPERATION,
  SPAN_RECORD_SERIES_SEGMENT,
  SPAN_TRANSACTION,
} from "@instrumentation/spans";
import type { InstrumentationConfig, LogEvent } from "@instrumentation/types";
import {
  instrumentation,
  type OfficialInstrumentationExtension,
} from "@src/instrumentation/extension";
import {
  captureLogs,
  withOtelRecorder,
} from "@tests/unit/instrumentation/_capture";
import { describe, expect, it, vi } from "vitest";

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

async function waitFor(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    if (check()) return;
    await Promise.resolve();
  }
  throw new Error("Expected official observation work to settle");
}

function cacheLogEvent(
  event: CacheLogEvent,
  status?: string
): Omit<LogEvent, "level"> {
  return Object.freeze({
    timestamp: new Date(0),
    operation: "get",
    meta: Object.freeze({ event, status }),
  });
}

describe("official protected observer", () => {
  it("keeps the extracted identity inert outside the protected runner", () => {
    const extension = instrumentation({});
    const completion = Object.freeze({ status: "success", durationMs: 0 });
    const proceed = vi.fn(() => Promise.resolve(completion));

    expect(
      extension.observe(
        Object.freeze({ kind: "operation", operation: "findMany" }),
        proceed
      )
    ).toBeUndefined();
    expect(proceed).not.toHaveBeenCalled();
  });

  it("publishes late cache events after a spanless logical operation", async () => {
    const timeline: string[] = [];
    const logs = captureLogs();
    const extension = instrumentation({
      logging: {
        cache(event, log) {
          timeline.push(
            `log:${event.meta?.event}:${event.meta?.status ?? "none"}`
          );
          logs.callback(event, log);
        },
      },
    });
    const facts: OperationInstrumentationFacts = Object.freeze({
      kind: "operation",
      complete: () =>
        Object.freeze({
          kind: "operation",
          readCacheLogEvents: () =>
            Object.freeze([
              cacheLogEvent("hit"),
              cacheLogEvent("hit", "stale"),
            ]),
        }),
    });
    const childValue = Object.freeze({ source: "child" });

    const received = await runObserved(
      extension,
      { kind: "operation", operation: "findMany", model: "record" },
      facts,
      async () => {
        timeline.push("child");
        return childValue;
      }
    );
    await waitFor(() => logs.events.length === 2);

    expect(received).toBe(childValue);
    expect(timeline).toEqual(["child", "log:hit:none", "log:hit:stale"]);
    expect(logs.events.map(({ level }) => level)).toEqual(["cache", "cache"]);
  });

  it("contains a hostile late operation reader and logger", async () => {
    const extension = instrumentation({
      logging: {
        cache() {
          throw new Error("hostile logger");
        },
      },
    });
    const readerFailure = new Error("hostile late reader");
    const facts: OperationInstrumentationFacts = Object.freeze({
      kind: "operation",
      complete: () =>
        Object.freeze({
          kind: "operation",
          readCacheLogEvents() {
            throw readerFailure;
          },
        }),
    });
    const childValue = Object.freeze({ source: "authoritative" });

    await expect(
      runObserved(
        extension,
        { kind: "operation", operation: "findMany" },
        facts,
        async () => childValue
      )
    ).resolves.toBe(childValue);

    const loggerFacts: OperationInstrumentationFacts = Object.freeze({
      kind: "operation",
      complete: () =>
        Object.freeze({
          kind: "operation",
          readCacheLogEvents: () => Object.freeze([cacheLogEvent("hit")]),
        }),
    });
    await expect(
      runObserved(
        extension,
        { kind: "operation", operation: "findMany" },
        loggerFacts,
        async () => childValue
      )
    ).resolves.toBe(childValue);
  });

  it("contains skipped statement and driver-lifecycle completion failures", async () => {
    const extension = instrumentation({ logging: { query: true } });
    const statementFailure = new Error("statement failed before dispatch");
    const statementFacts: StatementInstrumentationFacts = Object.freeze({
      kind: "statement",
      presentation: Promise.resolve(undefined),
      complete: () => undefined,
    });

    await expect(
      runObserved(
        extension,
        { kind: "statement", operation: "findMany", model: "record" },
        statementFacts,
        () => Promise.reject(statementFailure)
      )
    ).rejects.toBe(statementFailure);

    const lifecycleFacts: DriverLifecycleInstrumentationFacts = Object.freeze({
      kind: "driver-lifecycle",
      presentation: Promise.resolve(undefined),
      complete: () => undefined,
    });
    const success = Object.freeze({ phase: "complete" });
    await expect(
      runObserved(
        extension,
        { kind: "transaction", operation: "$transaction" },
        lifecycleFacts,
        async () => success
      )
    ).resolves.toBe(success);

    const lifecycleFailure = new Error("transaction failed before begin");
    await expect(
      runObserved(
        extension,
        { kind: "transaction", operation: "$transaction" },
        lifecycleFacts,
        () => Promise.reject(lifecycleFailure)
      )
    ).rejects.toBe(lifecycleFailure);
  });

  it("releases a spanless driver lifecycle presentation exactly once", async () => {
    const extension = instrumentation({ logging: { query: true } });
    let releaseChild: ((value: string) => void) | undefined;
    const heldChild = new Promise<string>((resolve) => {
      releaseChild = resolve;
    });
    const startExecution = vi.fn(() => releaseChild?.("released"));
    const facts: DriverLifecycleInstrumentationFacts = Object.freeze({
      kind: "driver-lifecycle",
      presentation: Promise.resolve(Object.freeze({ startExecution })),
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
    expect(startExecution).toHaveBeenCalledOnce();
  });

  it("records late segment attributes without changing child authority", async () => {
    const recorder = withOtelRecorder();
    try {
      const extension = instrumentation({ tracing: true });
      const facts: SegmentInstrumentationFacts = Object.freeze({
        kind: "segment",
        spanOptions: Object.freeze({ name: SPAN_RECORD_SERIES_SEGMENT }),
        complete: () =>
          Object.freeze({
            kind: "segment",
            spanAttributes: Object.freeze({
              [ATTR_VIBORM_WRITE_COMMIT_OUTCOME]: "committed",
            }),
          }),
      });
      const childValue = Object.freeze({ segment: 1 });

      await expect(
        runObserved(
          extension,
          { kind: "segment", operation: "createMany", model: "record" },
          facts,
          async () => childValue
        )
      ).resolves.toBe(childValue);
      await waitFor(
        () => recorder.find(SPAN_RECORD_SERIES_SEGMENT) !== undefined
      );

      expect(
        recorder.find(SPAN_RECORD_SERIES_SEGMENT)?.attributes[
          ATTR_VIBORM_WRITE_COMMIT_OUTCOME
        ]
      ).toBe("committed");

      const completionFailure = new Error("late segment facts failed");
      const failingFacts: SegmentInstrumentationFacts = Object.freeze({
        kind: "segment",
        spanOptions: Object.freeze({ name: SPAN_RECORD_SERIES_SEGMENT }),
        complete() {
          throw completionFailure;
        },
      });
      const childFailure = new Error("segment child failed");
      await expect(
        runObserved(
          extension,
          { kind: "segment", operation: "createMany", model: "record" },
          failingFacts,
          () => Promise.reject(childFailure)
        )
      ).rejects.toBe(childFailure);
      await waitFor(
        () =>
          recorder
            .spans()
            .filter(({ name }) => name === SPAN_RECORD_SERIES_SEGMENT)
            .length === 2
      );
    } finally {
      await recorder.dispose();
    }
  });

  it("orders cache logs and records late cache span attributes", async () => {
    const recorder = withOtelRecorder();
    try {
      const timeline: string[] = [];
      const logs = captureLogs();
      const extension = instrumentation({
        tracing: true,
        logging: {
          cache(event, log) {
            timeline.push(
              `log:${event.meta?.event}:${event.meta?.status ?? "none"}`
            );
            logs.callback(event, log);
          },
        },
      });
      const getFacts: CacheInstrumentationFacts = Object.freeze({
        kind: "cache",
        spanOptions: Object.freeze({ name: SPAN_CACHE_GET }),
        complete: () =>
          Object.freeze({
            kind: "cache",
            spanAttributes: Object.freeze({ [ATTR_CACHE_RESULT]: "miss" }),
          }),
      });
      const childValue = Object.freeze({ cache: "authoritative" });

      await expect(
        runObserved(
          extension,
          { kind: "cache", operation: "get" },
          getFacts,
          async () => childValue
        )
      ).resolves.toBe(childValue);

      const revalidationFacts: CacheInstrumentationFacts = Object.freeze({
        kind: "cache",
        spanOptions: Object.freeze({ name: SPAN_OPERATION, root: true }),
        startLogEvents: Object.freeze([cacheLogEvent("revalidate", "start")]),
        complete: () =>
          Object.freeze({
            kind: "cache",
            logEvents: Object.freeze([cacheLogEvent("revalidate", "success")]),
          }),
      });
      await expect(
        runObserved(
          extension,
          { kind: "cache", operation: "revalidate" },
          revalidationFacts,
          async () => {
            timeline.push("child");
            return childValue;
          }
        )
      ).resolves.toBe(childValue);
      await waitFor(
        () =>
          logs.events.length === 2 &&
          recorder.find(SPAN_CACHE_GET) !== undefined &&
          recorder.find(SPAN_OPERATION) !== undefined
      );

      expect(timeline).toEqual([
        "log:revalidate:start",
        "child",
        "log:revalidate:success",
      ]);
      expect(recorder.find(SPAN_CACHE_GET)?.attributes[ATTR_CACHE_RESULT]).toBe(
        "miss"
      );
    } finally {
      await recorder.dispose();
    }
  });

  it("contains spanless cache failures and completion-fact failures", async () => {
    const extension = instrumentation({ logging: { cache: true } });
    const childFailure = new Error("cache child failed");
    const facts: CacheInstrumentationFacts = Object.freeze({
      kind: "cache",
      complete: () => undefined,
    });

    await expect(
      runObserved(extension, { kind: "cache", operation: "get" }, facts, () =>
        Promise.reject(childFailure)
      )
    ).rejects.toBe(childFailure);

    const completionFailure = new Error("cache completion facts failed");
    const hostileFacts: CacheInstrumentationFacts = Object.freeze({
      kind: "cache",
      complete() {
        throw completionFailure;
      },
    });
    const childValue = Object.freeze({ cache: "child" });
    await expect(
      runObserved(
        extension,
        { kind: "cache", operation: "get" },
        hostileFacts,
        async () => childValue
      )
    ).resolves.toBe(childValue);
  });

  it("starts a traced driver lifecycle inside its published presentation", async () => {
    const recorder = withOtelRecorder();
    try {
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
        releaseChild?.("committed");
      };
      const facts: DriverLifecycleInstrumentationFacts = Object.freeze({
        kind: "driver-lifecycle",
        presentation: Promise.resolve(
          Object.freeze({
            spanOptions: Object.freeze({ name: SPAN_TRANSACTION }),
            startExecution,
          })
        ),
        complete: () => undefined,
      });

      await expect(
        runObserved(
          extension,
          { kind: "transaction", operation: "$transaction" },
          facts,
          () => heldChild
        )
      ).resolves.toBe("committed");
      await waitFor(() => recorder.find(SPAN_TRANSACTION) !== undefined);

      expect(providerStarts).toBe(1);
      expect(recorder.find(SPAN_TRANSACTION)).toBeDefined();
    } finally {
      await recorder.dispose();
    }
  });
});

describe("official observation capability", () => {
  function capabilityOf(config: InstrumentationConfig) {
    const chain = appendResolvedExtension(
      undefined,
      instrumentation(config),
      {}
    );
    const capability = getOfficialInstrumentationChainCapability(chain);
    if (capability === undefined) {
      throw new Error("Official instrumentation capability was not registered");
    }
    return capability;
  }

  const NEEDS: readonly ObservationNeed[] = [
    "statement",
    "transaction",
    "savepoint",
    "connect",
    "disconnect",
    "cache",
    "cache-outcomes",
    "parameters",
    "query-log",
    "error-log",
  ];

  function answers(capability: OfficialObservationCapability) {
    return Object.fromEntries(
      NEEDS.map((need) => [need, capability.wants(need)])
    );
  }

  it("answers every need from the exact chain's configuration", () => {
    const quiet = capabilityOf({ diagnostics: { includeParams: true } });
    expect(answers(quiet)).toEqual(
      Object.fromEntries(NEEDS.map((need) => [need, false]))
    );
    expect(quiet.diagnostics).toEqual({
      includeParams: true,
      includeSql: false,
    });

    const logs = captureLogs();
    const traced = capabilityOf({
      logging: { cache: logs.callback, query: logs.callback },
      tracing: { ignoreSpanTypes: [SPAN_DISCONNECT], includeParams: true },
    });
    expect(answers(traced)).toEqual({
      statement: true,
      transaction: true,
      savepoint: true,
      connect: true,
      disconnect: false,
      cache: true,
      "cache-outcomes": true,
      parameters: true,
      "query-log": true,
      "error-log": false,
    });

    const logged = capabilityOf({
      logging: { error: logs.callback, includeParams: true },
    });
    expect([logged.wants("parameters"), logged.wants("error-log")]).toEqual([
      true,
      true,
    ]);
    expect(
      capabilityOf({
        tracing: { ignoreSpanTypes: [SPAN_EXECUTE], includeParams: true },
      }).wants("parameters")
    ).toBe(false);
  });

  it("presents a warning only through an enabled warning level", () => {
    const notice = {
      correlationId: "correlation",
      message: "skip dropped",
      model: "record",
      operation: "createMany",
    };
    const logs = captureLogs();
    expect(
      capabilityOf({ logging: { query: logs.callback } }).warn(notice)
    ).toBe(false);
    expect(
      capabilityOf({ logging: { warning: logs.callback } }).warn(notice)
    ).toBe(true);
    expect(logs.events).toEqual([
      {
        correlationId: "correlation",
        level: "warning",
        meta: { notice: "skip dropped" },
        model: "record",
        operation: "createMany",
        timestamp: expect.any(Date),
      },
    ]);
  });
});
