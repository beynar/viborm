import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SPAN_EXECUTE,
  SPAN_OPERATION,
  SPAN_VALIDATE,
} from "../../src/instrumentation/spans";
import {
  createTracerWrapper,
  getNoopTracer,
} from "../../src/instrumentation/tracer";
import { type OtelRecorder, primeTracer, withOtelRecorder } from "./_capture";

const VALIDATE_PATTERN = /validate/;

// ---------------------------------------------------------------------------
// OTel PRESENT path — real @opentelemetry/api + in-memory recorder
//
// OTel's global tracer provider can only be registered once per process, and
// `dispose()` (provider.shutdown) does not unregister it — a second
// `withOtelRecorder()` in the same file would be a silent no-op. So we register
// ONE recorder for the whole file and, because the exporter is never reset
// between tests, resolve spans by their LAST occurrence (the current test's
// span, since each test ends its spans before the next begins).
// ---------------------------------------------------------------------------

describe("createTracerWrapper (OTel present)", () => {
  let recorder: OtelRecorder;

  const findLast = (name: string): ReadableSpan | undefined => {
    const all = recorder.spans().filter((s) => s.name === name);
    return all.at(-1);
  };
  // Spans accumulate across tests (one shared exporter, no per-test reset), so
  // "no span recorded" is asserted as a zero delta, not absolute absence.
  const countOf = (name: string): number =>
    recorder.spans().filter((s) => s.name === name).length;

  beforeAll(() => {
    recorder = withOtelRecorder();
  });

  afterAll(async () => {
    await recorder.dispose();
  });

  it("records a real span with the given name and returns the callback value", async () => {
    const tracer = createTracerWrapper();

    const result = await tracer.startActiveSpan(
      { name: SPAN_OPERATION },
      () => 42
    );

    expect(result).toBe(42);
    const span = findLast(SPAN_OPERATION);
    expect(span).toBeDefined();
    expect(span?.name).toBe(SPAN_OPERATION);
  });

  it("isEnabled becomes true after the lazy load; primeTracer forces it", async () => {
    const tracer = createTracerWrapper();

    // Before any span awaits the load, otel is not yet cached.
    expect(tracer.isEnabled()).toBe(false);

    await primeTracer(tracer);

    expect(tracer.isEnabled()).toBe(true);
  });

  it("applies caller attributes to the recorded span", async () => {
    const tracer = createTracerWrapper();

    await tracer.startActiveSpan(
      { name: SPAN_OPERATION, attributes: { "db.collection.name": "user" } },
      () => undefined
    );

    expect(findLast(SPAN_OPERATION)?.attributes["db.collection.name"]).toBe(
      "user"
    );
  });

  it("includeSql default true sets db.query.text; false omits it", async () => {
    const withSql = createTracerWrapper();
    const noSql = createTracerWrapper({ includeSql: false });

    await withSql.startActiveSpan(
      { name: SPAN_EXECUTE, sql: { query: "SELECT 1" } },
      () => undefined
    );
    await noSql.startActiveSpan(
      { name: SPAN_VALIDATE, sql: { query: "SELECT 1" } },
      () => undefined
    );

    expect(findLast(SPAN_EXECUTE)?.attributes["db.query.text"]).toBe(
      "SELECT 1"
    );
    expect(
      findLast(SPAN_VALIDATE)?.attributes["db.query.text"]
    ).toBeUndefined();
  });

  it("includeParams true emits per-index params (raw string, JSON non-string); default false emits none", async () => {
    const withParams = createTracerWrapper({ includeParams: true });
    const noParams = createTracerWrapper();

    await withParams.startActiveSpan(
      {
        name: SPAN_EXECUTE,
        sql: { query: "SELECT $1, $2", params: ["alice", { id: 5 }] },
      },
      () => undefined
    );
    await noParams.startActiveSpan(
      {
        name: SPAN_VALIDATE,
        sql: { query: "SELECT $1", params: ["bob"] },
      },
      () => undefined
    );

    const withAttrs = findLast(SPAN_EXECUTE)?.attributes;
    expect(withAttrs?.["db.query.parameter.0"]).toBe("alice");
    expect(withAttrs?.["db.query.parameter.1"]).toBe(JSON.stringify({ id: 5 }));

    const noAttrs = findLast(SPAN_VALIDATE)?.attributes;
    expect(noAttrs?.["db.query.parameter.0"]).toBeUndefined();
  });

  it("emits no param attributes when includeParams true but sql.params absent", async () => {
    const tracer = createTracerWrapper({ includeParams: true });

    await tracer.startActiveSpan(
      { name: SPAN_EXECUTE, sql: { query: "SELECT 1" } },
      () => undefined
    );

    const attrs = findLast(SPAN_EXECUTE)?.attributes ?? {};
    expect(
      Object.keys(attrs).some((k) => k.startsWith("db.query.parameter"))
    ).toBe(false);
  });

  it("nested spans are parented (child's parent is the outer span)", async () => {
    const tracer = createTracerWrapper();

    await tracer.startActiveSpan({ name: SPAN_OPERATION }, async () => {
      await tracer.startActiveSpan({ name: SPAN_EXECUTE }, () => undefined);
    });

    const parent = findLast(SPAN_OPERATION);
    const child = findLast(SPAN_EXECUTE);
    expect(child?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId);
  });

  it("success path sets span status OK", async () => {
    const tracer = createTracerWrapper();

    await tracer.startActiveSpan({ name: SPAN_OPERATION }, () => undefined);

    expect(findLast(SPAN_OPERATION)?.status.code).toBe(SpanStatusCode.OK);
  });

  it("throwing Error: status ERROR with message, records exception, rethrows", async () => {
    const tracer = createTracerWrapper();

    await expect(
      tracer.startActiveSpan({ name: SPAN_OPERATION }, () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    const span = findLast(SPAN_OPERATION);
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.status.message).toBe("boom");
    expect(span?.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("throwing non-Error: status ERROR 'Unknown error', no exception event, rethrows", async () => {
    const tracer = createTracerWrapper();

    await expect(
      tracer.startActiveSpan({ name: SPAN_OPERATION }, () => {
        // biome-ignore lint/style/useThrowOnlyError: intentionally testing non-Error throw
        throw "just a string";
      })
    ).rejects.toBe("just a string");

    const span = findLast(SPAN_OPERATION);
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.status.message).toBe("Unknown error");
    expect(span?.events.some((e) => e.name === "exception")).toBe(false);
  });

  it("root:true starts a new root span (not parented to the ambient active span)", async () => {
    const tracer = createTracerWrapper();

    await tracer.startActiveSpan({ name: SPAN_OPERATION }, async () => {
      await tracer.startActiveSpan(
        { name: SPAN_EXECUTE, root: true },
        () => undefined
      );
    });

    const outer = findLast(SPAN_OPERATION);
    const rooted = findLast(SPAN_EXECUTE);
    // The rooted span must NOT be a child of the ambient active span.
    expect(rooted?.parentSpanContext?.spanId).not.toBe(
      outer?.spanContext().spanId
    );
    expect(rooted?.parentSpanContext).toBeUndefined();
  });

  it("kind option is honored; defaults to INTERNAL when omitted", async () => {
    const tracer = createTracerWrapper();

    await tracer.startActiveSpan(
      { name: SPAN_OPERATION, kind: SpanKind.CLIENT },
      () => undefined
    );
    await tracer.startActiveSpan({ name: SPAN_EXECUTE }, () => undefined);

    expect(findLast(SPAN_OPERATION)?.kind).toBe(SpanKind.CLIENT);
    expect(findLast(SPAN_EXECUTE)?.kind).toBe(SpanKind.INTERNAL);
  });

  it("span is always ended on success and on error", async () => {
    const tracer = createTracerWrapper();
    const okBefore = countOf(SPAN_OPERATION);
    const errBefore = countOf(SPAN_EXECUTE);

    await tracer.startActiveSpan({ name: SPAN_OPERATION }, () => undefined);
    await expect(
      tracer.startActiveSpan({ name: SPAN_EXECUTE }, () => {
        throw new Error("x");
      })
    ).rejects.toThrow();

    // A finished span only appears in the exporter once end() is called.
    expect(countOf(SPAN_OPERATION)).toBe(okBefore + 1);
    expect(countOf(SPAN_EXECUTE)).toBe(errBefore + 1);
  });

  it("ignoreSpanTypes string match: callback runs but no span recorded", async () => {
    const tracer = createTracerWrapper({ ignoreSpanTypes: [SPAN_VALIDATE] });
    const before = countOf(SPAN_VALIDATE);

    const result = await tracer.startActiveSpan(
      { name: SPAN_VALIDATE },
      () => "ran"
    );

    expect(result).toBe("ran");
    expect(countOf(SPAN_VALIDATE)).toBe(before);
  });

  it("ignoreSpanTypes RegExp: matching name skipped, non-matching recorded", async () => {
    const tracer = createTracerWrapper({
      ignoreSpanTypes: [VALIDATE_PATTERN],
    });
    const skipBefore = countOf(SPAN_VALIDATE);
    const keepBefore = countOf(SPAN_OPERATION);

    await tracer.startActiveSpan({ name: SPAN_VALIDATE }, () => undefined);
    await tracer.startActiveSpan({ name: SPAN_OPERATION }, () => undefined);

    expect(countOf(SPAN_VALIDATE)).toBe(skipBefore);
    expect(countOf(SPAN_OPERATION)).toBe(keepBefore + 1);
  });

  it("startActiveSpanSync (OTel loaded) records a span, returns value, sets OK", async () => {
    const tracer = createTracerWrapper();
    await primeTracer(tracer);

    const result = tracer.startActiveSpanSync(
      { name: SPAN_OPERATION },
      () => "sync"
    );

    expect(result).toBe("sync");
    const span = findLast(SPAN_OPERATION);
    expect(span).toBeDefined();
    expect(span?.status.code).toBe(SpanStatusCode.OK);
  });

  it("startActiveSpanSync throwing: ERROR status + recordException + rethrow", async () => {
    const tracer = createTracerWrapper();
    await primeTracer(tracer);

    expect(() =>
      tracer.startActiveSpanSync({ name: SPAN_EXECUTE }, () => {
        throw new Error("sync-boom");
      })
    ).toThrow("sync-boom");

    const span = findLast(SPAN_EXECUTE);
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.status.message).toBe("sync-boom");
    expect(span?.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("startActiveSpanSync respects ignoreSpanTypes (skipped name → callback runs, no span)", async () => {
    const tracer = createTracerWrapper({ ignoreSpanTypes: [SPAN_VALIDATE] });
    await primeTracer(tracer);
    const before = countOf(SPAN_VALIDATE);

    const result = tracer.startActiveSpanSync(
      { name: SPAN_VALIDATE },
      () => "ran"
    );

    expect(result).toBe("ran");
    expect(countOf(SPAN_VALIDATE)).toBe(before);
  });

  it("startActiveSpanSync before any async span primed OTel falls through to plain fn()", () => {
    const tracer = createTracerWrapper();
    const before = countOf(SPAN_OPERATION);

    // No prior async span: otel is still null, so sync path just runs fn().
    const result = tracer.startActiveSpanSync(
      { name: SPAN_OPERATION },
      () => "no-otel-yet"
    );

    expect(result).toBe("no-otel-yet");
    expect(countOf(SPAN_OPERATION)).toBe(before);
  });

  it("a top-level span with no ambient active span is a root span (no parent)", async () => {
    const tracer = createTracerWrapper();

    // Started outside any other startActiveSpan callback, so the active context
    // is the empty root context: the recorded span must have no parent.
    await tracer.startActiveSpan({ name: SPAN_OPERATION }, () => undefined);

    expect(findLast(SPAN_OPERATION)?.parentSpanContext).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// NOOP path — getNoopTracer, no spans, always inert
// ---------------------------------------------------------------------------

describe("getNoopTracer", () => {
  it("startActiveSpan runs the callback and returns its value; isEnabled false", async () => {
    const tracer = getNoopTracer();

    const result = await tracer.startActiveSpan(
      { name: SPAN_OPERATION },
      () => "value"
    );

    expect(result).toBe("value");
    expect(tracer.isEnabled()).toBe(false);
  });

  it("startActiveSpanSync runs the callback and returns its value", () => {
    const tracer = getNoopTracer();

    const result = tracer.startActiveSpanSync(
      { name: SPAN_OPERATION },
      () => "sync-value"
    );

    expect(result).toBe("sync-value");
  });

  it("returns the shared singleton instance across calls", () => {
    expect(getNoopTracer()).toBe(getNoopTracer());
  });
});
