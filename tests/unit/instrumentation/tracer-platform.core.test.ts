/**
 * A platform-provided tracer (`tracing: { tracer }`), against a fake `Tracer`.
 *
 * The library must never import `@opentelemetry/api` when the application hands
 * it a tracer: on Cloudflare Workers the runtime supplies the tracer and the
 * library's own import is a bundler bet. The api module is mocked to count
 * every import attempt and to fail, so an import would both be counted and
 * turn tracing into the no-op (the last cell proves the counter sees one).
 *
 * The containment is the auto-detected path's: the application callback runs
 * exactly once whatever the tracer does with it (twice, never, re-entrantly,
 * throwing before or after), and the span it received is settled inside that
 * one run.
 */
import { describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ imports: 0 }));
vi.mock("@opentelemetry/api", () => {
  api.imports += 1;
  throw new Error("the library imported @opentelemetry/api");
});

import type { Span, Tracer } from "@opentelemetry/api";
import { createClient, s, sql } from "@src/index";
import { createInstrumentationContext } from "@src/instrumentation/context";
import { instrumentation } from "@src/instrumentation/exports";
import {
  SPAN_CONNECT,
  SPAN_DISCONNECT,
  SPAN_EXECUTE,
  SPAN_OPERATION,
} from "@src/instrumentation/spans";
import {
  createTracerWrapper,
  prewarmTracer,
  shouldTraceSpan,
} from "@src/instrumentation/tracer";
import { StatementDriver } from "./_fake-driver";

type Mode =
  | "normal"
  | "calls-twice"
  | "never-calls"
  | "throws-after"
  | "throws-before"
  | "rejects-after";

interface SpanRecord {
  readonly name: string;
  readonly options: unknown;
  readonly calls: string[];
}

function fakeTracer(mode: Mode = "normal", hostileSpan = false) {
  const spans: SpanRecord[] = [];
  const tracer = {
    startActiveSpan(
      name: string,
      options: unknown,
      fn: (span: Span) => unknown
    ): unknown {
      if (mode === "throws-before") throw new Error("tracer failed before");
      const calls: string[] = [];
      spans.push({ name, options, calls });
      const span = {
        end: () => {
          calls.push("end");
          if (hostileSpan) throw new Error("end failed");
        },
        recordException: (error: unknown) => {
          calls.push(`exception:${String(error)}`);
          if (hostileSpan) throw new Error("recordException failed");
        },
        setStatus: (status: unknown) => {
          calls.push(`status:${JSON.stringify(status)}`);
          if (hostileSpan) throw new Error("setStatus failed");
        },
      };
      if (mode === "never-calls") return undefined;
      const value = fn(span as unknown as Span);
      if (mode === "calls-twice") fn(span as unknown as Span);
      if (mode === "throws-after") throw new Error("tracer failed after");
      if (mode === "rejects-after") {
        return Promise.resolve(value).then(() => {
          throw new Error("tracer post-work failed");
        });
      }
      return value;
    },
  };
  return { spans, tracer: tracer as unknown as Tracer };
}

const EXECUTE_PATTERN = /execute/;
const OK = `status:${JSON.stringify({ code: 1 })}`;
const ERROR = `status:${JSON.stringify({ code: 2, message: "Operation failed" })}`;
const EXCEPTION = "exception:Error: Operation failed";

describe("tracing.tracer: spans start through the handed tracer", () => {
  it("starts an async span with the name, INTERNAL kind, root flag and attributes", async () => {
    const { spans, tracer } = fakeTracer();
    const wrapper = createTracerWrapper({ tracer });

    await expect(
      wrapper.startActiveSpan(
        { name: SPAN_OPERATION, attributes: { "db.collection.name": "user" } },
        () => "value"
      )
    ).resolves.toBe("value");
    await wrapper.startActiveSpan(
      { name: SPAN_CONNECT, kind: 2, root: true },
      () => undefined
    );

    expect(spans.map(({ name, options }) => ({ name, options }))).toEqual([
      {
        name: SPAN_OPERATION,
        options: {
          attributes: { "db.collection.name": "user" },
          kind: 0,
          root: false,
        },
      },
      { name: SPAN_CONNECT, options: { attributes: {}, kind: 2, root: true } },
    ]);
  });

  it("starts a sync span through the same tracer and options", () => {
    const { spans, tracer } = fakeTracer();
    const wrapper = createTracerWrapper({ tracer });

    expect(
      wrapper.startActiveSpanSync({ name: SPAN_EXECUTE, root: true }, () => 7)
    ).toBe(7);
    expect(spans).toEqual([
      {
        name: SPAN_EXECUTE,
        options: { attributes: {}, kind: 0, root: true },
        calls: [OK, "end"],
      },
    ]);
  });

  it("hands the application callback the span the tracer created", async () => {
    let received: unknown;
    const tracer = {
      startActiveSpan: (
        _name: string,
        _options: unknown,
        fn: (span: unknown) => unknown
      ) => fn("the-platform-span"),
    } as unknown as Tracer;
    await createTracerWrapper({ tracer }).startActiveSpan(
      { name: SPAN_OPERATION },
      (span) => {
        received = span;
      }
    );
    expect(received).toBe("the-platform-span");
  });

  it("settles OK then ends on success, ERROR + exception then ends on failure", async () => {
    const { spans, tracer } = fakeTracer();
    const wrapper = createTracerWrapper({ tracer });
    const asyncFailure = new Error("async application failure");
    const syncFailure = new Error("sync application failure");

    await wrapper.startActiveSpan({ name: SPAN_OPERATION }, async () => "ok");
    await expect(
      wrapper.startActiveSpan({ name: SPAN_OPERATION }, async () => {
        throw asyncFailure;
      })
    ).rejects.toBe(asyncFailure);
    await expect(
      wrapper.startActiveSpan({ name: SPAN_OPERATION }, () => {
        throw asyncFailure;
      })
    ).rejects.toBe(asyncFailure);
    expect(() =>
      wrapper.startActiveSpanSync({ name: SPAN_EXECUTE }, () => {
        throw syncFailure;
      })
    ).toThrow(syncFailure);

    expect(spans.map(({ calls }) => calls)).toEqual([
      [OK, "end"],
      [ERROR, EXCEPTION, "end"],
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
    expect(
      ignoring.startActiveSpanSync({ name: SPAN_EXECUTE }, () => "ignored")
    ).toBe("ignored");
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
    expect(spans.map(({ options }) => options)).toEqual([
      {
        attributes: {
          "db.query.parameter.0": "alice",
          "db.query.text": "SELECT $1",
        },
        kind: 0,
        root: false,
      },
      { attributes: {}, kind: 0, root: false },
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
    "never-calls",
    "throws-after",
    "throws-before",
    "rejects-after",
  ] satisfies Mode[])("async: a tracer that %s cannot repeat, skip, or replace the operation", async (mode) => {
    const { tracer } = fakeTracer(mode);
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
    expect(runs).toBe(2);
  });

  it.each([
    "calls-twice",
    "never-calls",
    "throws-after",
    "throws-before",
  ] satisfies Mode[])("sync: a tracer that %s cannot repeat, skip, or replace the operation", (mode) => {
    const { tracer } = fakeTracer(mode);
    const wrapper = createTracerWrapper({ tracer });
    let runs = 0;
    const failure = new Error("application failure");

    expect(
      wrapper.startActiveSpanSync({ name: SPAN_OPERATION }, () => {
        runs += 1;
        return "authoritative";
      })
    ).toBe("authoritative");
    expect(() =>
      wrapper.startActiveSpanSync({ name: SPAN_OPERATION }, () => {
        runs += 1;
        throw failure;
      })
    ).toThrow(failure);
    expect(runs).toBe(2);
  });

  it("settles the span once when the tracer calls back twice", async () => {
    const { spans, tracer } = fakeTracer("calls-twice");
    const wrapper = createTracerWrapper({ tracer });

    await wrapper.startActiveSpan({ name: SPAN_OPERATION }, () => "value");
    wrapper.startActiveSpanSync({ name: SPAN_EXECUTE }, () => "value");

    expect(spans.map(({ calls }) => calls)).toEqual([
      [OK, "end"],
      [OK, "end"],
    ]);
  });

  it("runs unspanned when the tracer never calls back", async () => {
    const { spans, tracer } = fakeTracer("never-calls");
    const wrapper = createTracerWrapper({ tracer });
    const received: unknown[] = [];

    await wrapper.startActiveSpan({ name: SPAN_OPERATION }, (span) => {
      received.push(span);
    });
    wrapper.startActiveSpanSync({ name: SPAN_EXECUTE }, (span) => {
      received.push(span);
    });

    expect(received).toEqual([undefined, undefined]);
    expect(spans.map(({ calls }) => calls)).toEqual([[], []]);
  });

  it("refuses a synchronous re-entry while the first run is in flight", async () => {
    const reentries: unknown[] = [];
    let reenter: (() => unknown) | undefined;
    const tracer = {
      startActiveSpan(_name: string, _options: unknown, fn: () => unknown) {
        reenter = fn;
        return fn();
      },
    } as unknown as Tracer;
    const wrapper = createTracerWrapper({ tracer });
    let runs = 0;

    await wrapper.startActiveSpan({ name: SPAN_OPERATION }, () => {
      runs += 1;
      const again = reenter?.();
      reentries.push(again);
      if (again instanceof Promise) again.catch(() => undefined);
    });
    expect(() =>
      wrapper.startActiveSpanSync({ name: SPAN_EXECUTE }, () => {
        runs += 1;
        reenter?.();
      })
    ).toThrow("Operation failed");

    expect(runs).toBe(2);
    await expect(reentries[0]).rejects.toThrow("Operation failed");
  });

  it("contains span methods that throw on success and failure", async () => {
    const { tracer } = fakeTracer("normal", true);
    const wrapper = createTracerWrapper({ tracer });
    const failure = new Error("application failure");

    await expect(
      wrapper.startActiveSpan({ name: SPAN_OPERATION }, () => "value")
    ).resolves.toBe("value");
    await expect(
      wrapper.startActiveSpan({ name: SPAN_OPERATION }, () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(
      wrapper.startActiveSpanSync({ name: SPAN_EXECUTE }, () => "value")
    ).toBe("value");
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
    expect(spans[1]?.options).toMatchObject({
      attributes: { "db.query.text": "SELECT ?" },
    });
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
    const refused = createInstrumentationContext({
      tracing: { tracer: {} as unknown as Tracer, includeSql: true },
    });

    expect(refused.config.tracing).toEqual({
      includeParams: false,
      includeSql: true,
    });
    // Only the auto-detected path has a load to prewarm.
    expect(prewarmTracer(refused.tracer)).toBeInstanceOf(Promise);
  });
});
