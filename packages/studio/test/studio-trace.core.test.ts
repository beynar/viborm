import { expect, test } from "vitest";
import type { StudioSpan } from "../src/api";
import { recordingTracer } from "../src/trace";

test("spans nest under the one active where they start, across awaits", async () => {
  const spans: StudioSpan[] = [];
  const tracer = recordingTracer((span) => spans.push(span));
  await tracer.startActiveSpan("viborm.operation", async (operation) => {
    operation.setAttribute("db.operation.name", "findMany");
    await Promise.resolve();
    await tracer.startActiveSpan("viborm.execute", async (execute) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      execute.setAttribute("db.query.text", "SELECT 1");
      execute.end();
    });
    // A span ended twice is kept once.
    operation.end();
    operation.end();
  });
  // Outside every span: a root again.
  tracer.startActiveSpan("viborm.connect", (span) => span.end());

  expect(spans.map(({ id, parent, name }) => ({ id, parent, name }))).toEqual([
    { id: 2, parent: 1, name: "viborm.execute" },
    { id: 1, parent: undefined, name: "viborm.operation" },
    { id: 3, parent: undefined, name: "viborm.connect" },
  ]);
  const [execute, operation] = spans;
  expect(execute!.attributes).toEqual({ "db.query.text": "SELECT 1" });
  expect(operation!.attributes).toEqual({ "db.operation.name": "findMany" });
  expect(execute!.duration).toBeGreaterThan(1);
  expect(execute!.start).toBeGreaterThanOrEqual(operation!.start);
  expect(operation!.duration).toBeGreaterThanOrEqual(execute!.duration);
  expect("parent" in operation!).toBe(false);
});

test("a span says its error: the exception's message, else its status's", () => {
  const spans: StudioSpan[] = [];
  const tracer = recordingTracer((span) => spans.push(span));
  tracer.startActiveSpan("thrown", (span) => {
    span.setStatus({ code: 2, message: "status message" });
    span.recordException(new Error("refused"));
    span.end();
  });
  tracer.startActiveSpan("status", (span) => {
    span.setStatus({ code: 1 });
    span.setStatus({ code: 2 });
    span.setStatus({ code: 2, message: "later" });
    span.end();
  });
  tracer.startActiveSpan("fine", (span) => {
    span.setStatus({ code: 1 });
    span.end();
  });
  expect(spans.map((span) => span.error)).toEqual([
    "refused",
    "error",
    undefined,
  ]);
  expect("error" in spans[2]!).toBe(false);
});
