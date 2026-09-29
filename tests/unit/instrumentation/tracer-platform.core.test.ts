/**
 * A handed tracer (`tracing: { tracer }`), against fake tracers.
 *
 * The library must never import `@opentelemetry/api` when the application hands
 * it a tracer: on Cloudflare Workers the runtime supplies the tracer
 * (`tracing` from `cloudflare:workers`) and the library's own import is a
 * bundler bet. The api module is mocked to count every import attempt and to
 * fail, so an import would both be counted and turn tracing into the no-op
 * (the control cell proves the counter sees one).
 *
 * Spans start through the two-argument `startActiveSpan(name, fn)`, the form
 * both an OpenTelemetry `Tracer` and the Workers runtime accept. The runtime
 * refuses a second argument that is not a function and hands a span with only
 * `isTraced`, `setAttribute` and `end` (measured on workerd 1.20260801.1); the
 * `workerdTracer` fake reproduces both.
 *
 * The containment is the auto-detected path's: the application callback runs
 * exactly once whatever the tracer does with it (twice, never, late,
 * re-entrantly, throwing before or after), and every span a callback receives
 * is settled once with that run's outcome.
 */
import { describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ imports: 0 }));
vi.mock("@opentelemetry/api", () => {
  api.imports += 1;
  throw new Error("the library imported @opentelemetry/api");
});

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { isVibORMError } from "@errors";
import { createClient, s, sql } from "@src/index";
import { createInstrumentationContext } from "@src/instrumentation/context";
import { instrumentation } from "@src/instrumentation/exports";
import {
  ATTR_DB_DRIVER,
  ATTR_DB_NAMESPACE,
  ATTR_DB_OPERATION_NAME,
  ATTR_DB_SYSTEM,
  SPAN_CONNECT,
  SPAN_DISCONNECT,
  SPAN_EXECUTE,
  SPAN_OPERATION,
  SPAN_TRANSACTION,
} from "@src/instrumentation/spans";
import {
  createTracerWrapper,
  prewarmTracer,
  shouldTraceSpan,
} from "@src/instrumentation/tracer";
import type {
  LogEvent,
  SpanTracer,
  TracingSpan,
} from "@src/instrumentation/types";
import { StatementDriver } from "./_fake-driver";

type Mode =
  | "normal"
  | "calls-twice"
  | "calls-twice-new-span"
  | "late"
  | "never-calls"
  | "throws-after"
  | "throws-before"
  | "rejects-after";

interface SpanRecord {
  readonly name: string;
  readonly calls: string[];
}

/** An OpenTelemetry-shaped span that records what VibORM does to it. */
function recordingSpan(calls: string[], hostile: boolean): TracingSpan {
  const act = (entry: string) => {
    calls.push(entry);
    if (hostile) throw new Error(`${entry} failed`);
  };
  return {
    setAttribute: (key, value) => act(`attr:${key}=${String(value)}`),
    end: () => act("end"),
    setStatus: (status) => act(`status:${JSON.stringify(status)}`),
    recordException: (error) => act(`exception:${String(error)}`),
  };
}

function fakeTracer(mode: Mode = "normal", hostileSpan = false) {
  const spans: SpanRecord[] = [];
  const arities: number[] = [];
  const late: Promise<unknown>[] = [];
  const open = (name: string): TracingSpan => {
    const calls: string[] = [];
    spans.push({ name, calls });
    return recordingSpan(calls, hostileSpan);
  };
  const tracer: SpanTracer = {
    startActiveSpan<T>(name: string, fn: (span: TracingSpan) => T): T {
      // biome-ignore lint/complexity/noArguments: the call's arity is the witness
      arities.push(arguments.length);
      if (mode === "throws-before") throw new Error("tracer failed before");
      const span = open(name);
      if (mode === "never-calls") return undefined as T;
      if (mode === "late") {
        // After the operation settled: a macrotask, past its microtasks.
        const afterSettled = new Promise((resolve) => setTimeout(resolve, 0));
        late.push(afterSettled.then(() => fn(span)));
        return undefined as T;
      }
      const value = fn(span);
      if (mode === "calls-twice") fn(span);
      if (mode === "calls-twice-new-span") fn(open(name));
      if (mode === "throws-after") throw new Error("tracer failed after");
      if (mode === "rejects-after") {
        return Promise.resolve(value).then(() => {
          throw new Error("tracer post-work failed");
        }) as T;
      }
      return value;
    },
  };
  return { arities, late, spans, tracer };
}

/**
 * The Workers runtime tracer as measured on workerd 1.20260801.1: a second
 * argument that is not a function is a TypeError, and its span has only
 * `isTraced`, `setAttribute` and `end` (no `setStatus`, no `recordException`).
 */
function workerdTracer() {
  const spans: SpanRecord[] = [];
  const tracer = {
    startActiveSpan<T>(name: string, fn: unknown): T {
      if (typeof fn !== "function") {
        throw new TypeError(
          "Failed to execute 'startActiveSpan' on 'Tracing': parameter 2 is not of type 'Function'."
        );
      }
      const calls: string[] = [];
      spans.push({ name, calls });
      return fn({
        isTraced: true,
        setAttribute: (key: string, value: unknown) => {
          calls.push(`attr:${key}=${String(value)}`);
        },
        end: () => {
          calls.push("end");
        },
      });
    },
  };
  return { spans, tracer };
}

const EXECUTE_PATTERN = /execute/;
const OK = `status:${JSON.stringify({ code: 1 })}`;
const ERROR = `status:${JSON.stringify({ code: 2, message: "Operation failed" })}`;
const EXCEPTION = "exception:Error: Operation failed";

describe("tracing.tracer: spans start through the handed tracer", () => {
  it("starts a span by name with the two-argument form and sets its attributes on the span", async () => {
    const { arities, spans, tracer } = fakeTracer();
    const wrapper = createTracerWrapper({ tracer });

    await expect(
      wrapper.startActiveSpan(
        {
          name: SPAN_OPERATION,
          attributes: { "db.collection.name": "user", "server.port": 5432 },
        },
        () => "value"
      )
    ).resolves.toBe("value");
    // Kind and root have no meaning to a handed tracer: never passed.
    await wrapper.startActiveSpan(
      { name: SPAN_CONNECT, kind: 2, root: true },
      () => undefined
    );

    expect(arities).toEqual([2, 2]);
    expect(spans).toEqual([
      {
        name: SPAN_OPERATION,
        calls: [
          "attr:db.collection.name=user",
          "attr:server.port=5432",
          OK,
          "end",
        ],
      },
      { name: SPAN_CONNECT, calls: [OK, "end"] },
    ]);
  });

  it("hands the application callback the span the tracer created", async () => {
    let received: unknown;
    const span = recordingSpan([], false);
    const tracer: SpanTracer = {
      startActiveSpan: (_name, fn) => fn(span),
    };
    await createTracerWrapper({ tracer }).startActiveSpan(
      { name: SPAN_OPERATION },
      (given) => {
        received = given;
      }
    );
    expect(received).toBe(span);
  });

  it("presents spans through the Workers runtime shape: attributes, then end, on success and failure", async () => {
    const { spans, tracer } = workerdTracer();
    const wrapper = createTracerWrapper({ tracer });
    const failure = new Error("application failure");

    await expect(
      wrapper.startActiveSpan(
        { name: SPAN_EXECUTE, attributes: { "db.system.name": "d1" } },
        async () => "rows"
      )
    ).resolves.toBe("rows");
    await expect(
      wrapper.startActiveSpan({ name: SPAN_OPERATION }, async () => {
        throw failure;
      })
    ).rejects.toBe(failure);

    expect(spans).toEqual([
      { name: SPAN_EXECUTE, calls: ["attr:db.system.name=d1", "end"] },
      { name: SPAN_OPERATION, calls: ["end"] },
    ]);
  });

  it("settles OK then ends on success, ERROR + exception then ends on failure", async () => {
    const { spans, tracer } = fakeTracer();
    const wrapper = createTracerWrapper({ tracer });
    const failure = new Error("application failure");

    await wrapper.startActiveSpan({ name: SPAN_OPERATION }, async () => "ok");
    await expect(
      wrapper.startActiveSpan({ name: SPAN_OPERATION }, async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    await expect(
      wrapper.startActiveSpan({ name: SPAN_OPERATION }, () => {
        throw failure;
      })
    ).rejects.toBe(failure);

    expect(spans.map(({ calls }) => calls)).toEqual([
      [OK, "end"],
      [ERROR, EXCEPTION, "end"],
      [ERROR, EXCEPTION, "end"],
    ]);
  });

  it("applies ignoreSpanTypes before the tracer and the disclosure options to attributes", async () => {
    const { spans, tracer } = fakeTracer();
    const ignoring = createTracerWrapper({
      tracer,
      ignoreSpanTypes: [SPAN_CONNECT, EXECUTE_PATTERN],
    });
    const disclosing = createTracerWrapper({
      tracer,
      includeParams: true,
      includeSql: true,
    });
    const withholding = createTracerWrapper({ tracer });
    const sqlFacts = { query: "SELECT $1", params: ["alice"] };

    await expect(
      ignoring.startActiveSpan({ name: SPAN_CONNECT }, () => "ignored")
    ).resolves.toBe("ignored");
    await expect(
      ignoring.startActiveSpan({ name: SPAN_EXECUTE }, () => "ignored")
    ).resolves.toBe("ignored");
    expect(shouldTraceSpan(ignoring, SPAN_EXECUTE)).toBe(false);
    expect(shouldTraceSpan(ignoring, SPAN_OPERATION)).toBe(true);
    expect(spans).toEqual([]);

    await disclosing.startActiveSpan(
      { name: SPAN_EXECUTE, sql: sqlFacts },
      () => undefined
    );
    await withholding.startActiveSpan(
      { name: SPAN_EXECUTE, sql: sqlFacts },
      () => undefined
    );
    expect(spans.map(({ calls }) => calls)).toEqual([
      [
        "attr:db.query.text=SELECT $1",
        "attr:db.query.parameter.0=alice",
        OK,
        "end",
      ],
      [OK, "end"],
    ]);
  });

  it("is enabled at once and has no readiness to prewarm", () => {
    const { tracer } = fakeTracer();
    const wrapper = createTracerWrapper({ tracer });
    const context = createInstrumentationContext({ tracing: { tracer } });

    expect(wrapper.isEnabled()).toBe(true);
    expect(prewarmTracer(wrapper)).toBeUndefined();
    expect(context.tracer.isEnabled()).toBe(true);
    expect(prewarmTracer(context.tracer)).toBeUndefined();
    expect(Object.isFrozen(wrapper)).toBe(true);
  });
});

describe("tracing.tracer: the application callback runs exactly once", () => {
  it.each([
    "calls-twice",
    "calls-twice-new-span",
    "late",
    "never-calls",
    "throws-after",
    "throws-before",
    "rejects-after",
  ] satisfies Mode[])("a tracer that %s cannot repeat, skip, or replace the operation", async (mode) => {
    const { late, tracer } = fakeTracer(mode);
    const wrapper = createTracerWrapper({ tracer });
    let runs = 0;
    const failure = new Error("application failure");

    await expect(
      wrapper.startActiveSpan({ name: SPAN_OPERATION }, async () => {
        runs += 1;
        return "authoritative";
      })
    ).resolves.toBe("authoritative");
    await expect(
      wrapper.startActiveSpan({ name: SPAN_OPERATION }, () => {
        runs += 1;
        throw failure;
      })
    ).rejects.toBe(failure);
    await Promise.allSettled(late);
    expect(runs).toBe(2);
  });

  it("settles a span once when the tracer calls back twice with it", async () => {
    const { spans, tracer } = fakeTracer("calls-twice");

    await createTracerWrapper({ tracer }).startActiveSpan(
      { name: SPAN_OPERATION },
      () => "value"
    );

    expect(spans.map(({ calls }) => calls)).toEqual([[OK, "end"]]);
  });

  it("settles a second span the tracer hands a second callback", async () => {
    const { spans, tracer } = fakeTracer("calls-twice-new-span");
    const wrapper = createTracerWrapper({ tracer });
    const failure = new Error("application failure");

    await wrapper.startActiveSpan({ name: SPAN_OPERATION }, () => "value");
    await expect(
      wrapper.startActiveSpan({ name: SPAN_OPERATION }, async () => {
        throw failure;
      })
    ).rejects.toBe(failure);

    expect(spans.map(({ calls }) => calls)).toEqual([
      [OK, "end"],
      [OK, "end"],
      [ERROR, EXCEPTION, "end"],
      [ERROR, EXCEPTION, "end"],
    ]);
  });

  it("runs unspanned when the tracer calls back after the operation settled, then settles the late span", async () => {
    const { late, spans, tracer } = fakeTracer("late");
    const received: unknown[] = [];

    await expect(
      createTracerWrapper({ tracer }).startActiveSpan(
        { name: SPAN_OPERATION },
        (span) => {
          received.push(span);
          return "value";
        }
      )
    ).resolves.toBe("value");
    await expect(Promise.all(late)).resolves.toEqual(["value"]);

    expect(received).toEqual([undefined]);
    expect(spans.map(({ calls }) => calls)).toEqual([[OK, "end"]]);
  });

  it("runs unspanned when the tracer never calls back", async () => {
    const { spans, tracer } = fakeTracer("never-calls");
    const received: unknown[] = [];

    await createTracerWrapper({ tracer }).startActiveSpan(
      { name: SPAN_OPERATION },
      (span) => {
        received.push(span);
      }
    );

    expect(received).toEqual([undefined]);
    expect(spans.map(({ calls }) => calls)).toEqual([[]]);
  });

  it("refuses a synchronous re-entry while the first run is in flight, and settles its span", async () => {
    const reentries: unknown[] = [];
    const calls: string[] = [];
    let reenter: (() => unknown) | undefined;
    const tracer: SpanTracer = {
      startActiveSpan(_name, fn) {
        reenter = () => fn(recordingSpan(calls, false));
        return fn(recordingSpan([], false));
      },
    };
    let runs = 0;

    await createTracerWrapper({ tracer }).startActiveSpan(
      { name: SPAN_OPERATION },
      () => {
        runs += 1;
        const again = reenter?.();
        reentries.push(again);
        if (again instanceof Promise) again.catch(() => undefined);
      }
    );

    expect(runs).toBe(1);
    await expect(reentries[0]).rejects.toThrow("Operation failed");
    expect(calls).toEqual([OK, "end"]);
  });

  it("contains span methods that throw on success and failure", async () => {
    const { tracer } = fakeTracer("normal", true);
    const wrapper = createTracerWrapper({ tracer });
    const failure = new Error("application failure");

    await expect(
      wrapper.startActiveSpan(
        { name: SPAN_OPERATION, attributes: { "db.collection.name": "user" } },
        () => "value"
      )
    ).resolves.toBe("value");
    await expect(
      wrapper.startActiveSpan({ name: SPAN_OPERATION }, () => {
        throw failure;
      })
    ).rejects.toBe(failure);
  });
});

/** A span whose every method returns a promise that rejects. */
function asyncFailingSpan(calls: string[]): TracingSpan {
  const act = async (entry: string) => {
    calls.push(entry);
    throw new Error(`${entry} rejected`);
  };
  return {
    setAttribute: (key) => act(`attr:${key}`),
    // A foreign thenable over a rejecting promise: its own `then` is the
    // only way to reach that rejection.
    end: () => {
      const rejection = act("end");
      return {
        then: (
          onFulfilled?: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown
        ) => rejection.then(onFulfilled, onRejected),
      };
    },
    setStatus: () => act("status"),
    recordException: () => act("exception"),
  };
}

/** A custom driver whose adapter's `namespace` getter throws when read. */
class ThrowingNamespaceDriver extends StatementDriver {
  override readonly adapter: DatabaseAdapter = Object.create(
    new SQLiteAdapter(),
    {
      namespace: {
        get: () => {
          throw new Error("namespace getter failed");
        },
      },
    }
  );
}

/** Collect the unhandled rejections raised while `body` and a macrotask run. */
async function collectUnhandledRejections(
  body: () => Promise<void>
): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    await body();
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
  return unhandled;
}

describe("tracing.tracer: span and driver failures stay outside the operation", () => {
  it("consumes the rejections of async span methods on success and failure", async () => {
    const calls: string[] = [];
    const tracer: SpanTracer = {
      startActiveSpan: (_name, fn) => fn(asyncFailingSpan(calls)),
    };
    const record = s.model({ id: s.string().id(), name: s.string() });
    const driver = new StatementDriver();
    driver.failAtProviderCall = 2;
    const client = createClient({ schema: { record }, driver }).$extends(
      instrumentation({ tracing: { tracer } })
    );

    const unhandled = await collectUnhandledRejections(async () => {
      await expect(client.$queryRaw(sql`SELECT ${7}`)).resolves.toEqual([
        { id: "record-1", name: "Ada" },
      ]);
      await expect(client.$queryRaw(sql`SELECT ${8}`)).rejects.toThrow();
    });

    expect(unhandled).toEqual([]);
    // Every method was called, and every one rejected.
    expect(new Set(calls.map((call) => call.split(":")[0]))).toEqual(
      new Set(["attr", "status", "exception", "end"])
    );
  });

  it("consumes the rejection of a function-shaped thenable a span method returns", async () => {
    // A function carrying its own `then` is a thenable too; neither its
    // `then` nor the promise behind it is hostile.
    const functionThenable = () => {
      const rejection = Promise.reject(new Error("telemetry failure"));
      return Object.assign(() => undefined, {
        then: rejection.then.bind(rejection),
      });
    };
    const span: TracingSpan = {
      setAttribute: functionThenable,
      end: functionThenable,
    };
    const tracer: SpanTracer = {
      startActiveSpan: (_name, fn) => fn(span),
    };
    const record = s.model({ id: s.string().id(), name: s.string() });
    const client = createClient({
      schema: { record },
      driver: new StatementDriver(),
    }).$extends(instrumentation({ tracing: { tracer } }));

    const unhandled = await collectUnhandledRejections(async () => {
      await expect(client.$queryRaw(sql`SELECT ${7}`)).resolves.toEqual([
        { id: "record-1", name: "Ada" },
      ]);
    });

    expect(unhandled).toEqual([]);
  });

  it("runs the statement and the transaction a throwing adapter namespace cannot present", async () => {
    const { spans, tracer } = fakeTracer();
    const record = s.model({ id: s.string().id(), name: s.string() });
    const driver = new ThrowingNamespaceDriver();
    const logged: unknown[] = [];
    const client = createClient({ schema: { record }, driver }).$extends(
      instrumentation({
        tracing: { tracer },
        logging: {
          query: (event) => {
            logged.push(event.operation);
          },
        },
      })
    );

    await expect(client.$queryRaw(sql`SELECT ${1}`)).resolves.toEqual([
      { id: "record-1", name: "Ada" },
    ]);
    await expect(
      client.$transaction((tx) => tx.$queryRaw(sql`SELECT ${2}`))
    ).resolves.toEqual([{ id: "record-1", name: "Ada" }]);

    expect(driver.providerCalls).toBe(2);
    // Each statement is still observed unspanned: its query log is presented.
    expect(logged).toEqual(["$queryRaw", "$queryRaw"]);
    expect(spans.map(({ name }) => name)).not.toContain(SPAN_EXECUTE);
    expect(spans.map(({ name }) => name)).not.toContain(SPAN_TRANSACTION);
  });

  it("presents the operation span without driver attributes when the adapter namespace throws", async () => {
    const { spans, tracer } = fakeTracer();
    const record = s.model({ id: s.string().id(), name: s.string() });
    const client = createClient({
      schema: { record },
      driver: new ThrowingNamespaceDriver(),
    }).$extends(instrumentation({ tracing: { tracer } }));

    await expect(client.record.findMany()).resolves.toEqual([
      { id: "record-1", name: "Ada" },
    ]);

    const operation = spans.filter(({ name }) => name === SPAN_OPERATION);
    expect(operation).toHaveLength(1);
    expect(operation[0]?.calls).toContain(
      `attr:${ATTR_DB_OPERATION_NAME}=findMany`
    );
    expect(operation[0]?.calls).toContain("end");
    expect(
      operation[0]?.calls.filter(
        (call) =>
          call.startsWith(`attr:${ATTR_DB_SYSTEM}=`) ||
          call.startsWith(`attr:${ATTR_DB_DRIVER}=`) ||
          call.startsWith(`attr:${ATTR_DB_NAMESPACE}=`)
      )
    ).toEqual([]);
  });

  it("logs a pre-statement failure once when the adapter namespace throws", async () => {
    const record = s.model({ id: s.string().id(), name: s.string() });
    const logged: LogEvent[] = [];
    const driver = new ThrowingNamespaceDriver();
    const client = createClient({ schema: { record }, driver })
      .$extends(
        instrumentation({
          logging: {
            error: (event) => {
              logged.push(event);
            },
          },
        })
      )
      .$extends({
        name: "failing-request",
        request() {
          throw new Error("request transform failed");
        },
      });

    const failure = await client.record.findMany().catch((error) => error);

    if (!isVibORMError(failure)) throw new Error("expected a VibORMError");
    expect(driver.providerCalls).toBe(0);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      level: "error",
      model: "record",
      operation: "findMany",
      error: { name: failure.name, code: failure.code },
    });
  });

  it("ends a span a re-entrant end() hands over exactly once", async () => {
    const calls: string[] = [];
    let callback: ((span: TracingSpan) => unknown) | undefined;
    const late: TracingSpan = {
      setAttribute: () => undefined,
      end: () => calls.push("late.end"),
    };
    const first: TracingSpan = {
      setAttribute: () => undefined,
      end: () => {
        calls.push("first.end");
        callback?.(late);
      },
    };
    const tracer: SpanTracer = {
      startActiveSpan(_name, fn) {
        callback = fn;
        return fn(first);
      },
    };

    await expect(
      createTracerWrapper({ tracer }).startActiveSpan(
        { name: SPAN_OPERATION },
        () => "value"
      )
    ).resolves.toBe("value");
    callback?.(late);

    expect(calls).toEqual(["first.end", "late.end"]);
  });

  it("ends a span a tracer hands to two operations once", async () => {
    const calls: string[] = [];
    const shared: TracingSpan = {
      setAttribute: () => undefined,
      end: () => calls.push("shared.end"),
    };
    const tracer: SpanTracer = { startActiveSpan: (_name, fn) => fn(shared) };
    const wrapper = createTracerWrapper({ tracer });

    await expect(
      Promise.all([
        wrapper.startActiveSpan({ name: SPAN_OPERATION }, () => "first"),
        wrapper.startActiveSpan({ name: SPAN_OPERATION }, () => "second"),
      ])
    ).resolves.toEqual(["first", "second"]);

    expect(calls).toEqual(["shared.end"]);
  });
});

describe("tracing.tracer: the configured extension", () => {
  it("presents a client's operation and execute spans through the tracer and imports nothing", async () => {
    const { spans, tracer } = fakeTracer();
    const record = s.model({ id: s.string().id(), name: s.string() });
    const client = createClient({
      schema: { record },
      driver: new StatementDriver(),
    }).$extends(instrumentation({ tracing: { includeSql: true, tracer } }));

    await client.$queryRaw(sql`SELECT ${7}`);
    await client.$disconnect();

    expect(spans.map(({ name }) => name)).toEqual([
      SPAN_OPERATION,
      SPAN_EXECUTE,
      SPAN_DISCONNECT,
    ]);
    expect(spans[1]?.calls).toContain("attr:db.query.text=SELECT ?");
    // A dynamic import resolves on a later task: wait for any to settle.
    await vi.dynamicImportSettled();
    expect(api.imports).toBe(0);
  });

  it("keeps the handed tracer by reference", () => {
    const { tracer } = fakeTracer();
    const kept = createInstrumentationContext({ tracing: { tracer } });

    expect(kept.config.tracing).toEqual({
      includeParams: false,
      includeSql: false,
      tracer,
    });
    expect(kept.config.tracing !== true && kept.config.tracing?.tracer).toBe(
      tracer
    );
  });

  // After every handed-tracer cell: they must have imported nothing, and
  // auto-detection is the control that proves the counter sees an import.
  it("imports the api only on the auto-detected path", async () => {
    await vi.dynamicImportSettled();
    expect(api.imports).toBe(0);
    const autoDetected = createTracerWrapper();
    await autoDetected.startActiveSpan({ name: SPAN_OPERATION }, () => 1);

    expect(api.imports).toBeGreaterThan(0);
  });

  // After the control: a refused value auto-detects, which imports.
  it("refuses a value that cannot start spans and auto-detects instead", () => {
    const notATracer: unknown = {};
    const refused = createInstrumentationContext({
      tracing: { tracer: notATracer as SpanTracer, includeSql: true },
    });

    expect(refused.config.tracing).toEqual({
      includeParams: false,
      includeSql: true,
    });
    // Only the auto-detected path has a load to prewarm.
    expect(prewarmTracer(refused.tracer)).toBeInstanceOf(Promise);
  });
});
