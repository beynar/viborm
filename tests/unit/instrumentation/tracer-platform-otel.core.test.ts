/**
 * A REAL OpenTelemetry tracer handed over explicitly presents what
 * auto-detection presents.
 *
 * An OpenTelemetry `Tracer` satisfies the handed-tracer contract through its
 * two-argument `startActiveSpan(name, fn)`. Here it comes from a real
 * `NodeTracerProvider`; the golden transcript's `statement/single` scenario
 * runs once per mode and the spans, read through the golden's own
 * normalization, must be equal to each other and to the committed transcript.
 * The one documented difference is `root`: a handed tracer takes no parent, so
 * a span VibORM would start as a new root nests under the active span.
 */
import { readFileSync } from "node:fs";
import { trace } from "@opentelemetry/api";
import { createClient, s, sql } from "@src/index";
import {
  instrumentation,
  type TracingConfig,
} from "@src/instrumentation/exports";
import { SPAN_EXECUTE, SPAN_OPERATION } from "@src/instrumentation/spans";
import {
  createTracerWrapper,
  type TracerWrapper,
} from "@src/instrumentation/tracer";
import { describe, expect, it } from "vitest";
import {
  normalizeCorrelation,
  normalizeSpans,
  withOtelRecorder,
} from "./_capture";
import { StatementDriver } from "./_fake-driver";

const GOLDEN = new URL("./__golden__/transcript.json", import.meta.url);

const record = s.model({ id: s.string().id(), name: s.string() });

async function statementScenario(
  tracing: (tracer: ReturnType<typeof trace.getTracer>) => true | TracingConfig
): Promise<unknown> {
  const recorder = withOtelRecorder();
  const client = createClient({
    schema: { record },
    driver: new StatementDriver(),
  }).$extends(instrumentation({ tracing: tracing(trace.getTracer("app")) }));
  try {
    await client.$queryRaw(sql`SELECT ${7}`);
    await client.record.findMany();
    // The golden records before its clients disconnect, after five turns.
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return normalizeCorrelation(normalizeSpans(recorder.spans()), new Map());
  } finally {
    await client.$disconnect();
    await recorder.dispose();
  }
}

async function rootInsideParent(
  wrapper: (tracer: ReturnType<typeof trace.getTracer>) => TracerWrapper
): Promise<unknown> {
  const recorder = withOtelRecorder();
  try {
    const tracer = wrapper(trace.getTracer("app"));
    await tracer.startActiveSpan({ name: SPAN_OPERATION }, () =>
      tracer.startActiveSpan({ name: SPAN_EXECUTE, root: true }, () => 1)
    );
    await tracer.startActiveSpan({ name: SPAN_OPERATION }, () =>
      tracer.startActiveSpan({ name: SPAN_EXECUTE }, () => 1)
    );
    return normalizeSpans(recorder.spans()).map(
      ({ name, parent, trace: traceId }) => ({ name, parent, trace: traceId })
    );
  } finally {
    await recorder.dispose();
  }
}

describe("tracing.tracer with a real OpenTelemetry tracer", () => {
  it("presents the golden statement scenario exactly as auto-detection does", async () => {
    const autoDetected = await statementScenario(() => true);
    const handed = await statementScenario((tracer) => ({ tracer }));
    const golden: Record<string, { spans: unknown }> = JSON.parse(
      readFileSync(GOLDEN, "utf8")
    );

    expect(handed).toEqual(autoDetected);
    expect(handed).toEqual(golden["statement/single"]?.spans);
  });

  it("keeps a root span out of the caller's trace only when auto-detected", async () => {
    await expect(
      rootInsideParent(() => createTracerWrapper())
    ).resolves.toEqual([
      { name: SPAN_EXECUTE, parent: null, trace: "trace-1" },
      { name: SPAN_OPERATION, parent: null, trace: "trace-2" },
      { name: SPAN_EXECUTE, parent: "span-4", trace: "trace-3" },
      { name: SPAN_OPERATION, parent: null, trace: "trace-3" },
    ]);
    // A handed tracer decides parenthood itself: both nest under the caller.
    await expect(
      rootInsideParent((tracer) => createTracerWrapper({ tracer }))
    ).resolves.toEqual([
      { name: SPAN_EXECUTE, parent: "span-2", trace: "trace-1" },
      { name: SPAN_OPERATION, parent: null, trace: "trace-1" },
      { name: SPAN_EXECUTE, parent: "span-4", trace: "trace-2" },
      { name: SPAN_OPERATION, parent: null, trace: "trace-2" },
    ]);
  });
});
