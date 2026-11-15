/**
 * The instrumentation on the cases its common configurations do not meet:
 * an ignore list holding something that is no pattern, a tracer that throws
 * when a span starts, a client that logs cache events only, a transaction
 * that fails with a value that is not an `Error`, and a `cache` unit of
 * another extension's making.
 */

import { SpanStatusCode } from "@opentelemetry/api";
import {
  createClient,
  extension,
  s,
  type UnitContext,
  unit,
  work,
} from "@src/index";
import { instrumentation } from "@src/instrumentation/exports";
import { SPAN_TRANSACTION } from "@src/instrumentation/spans";
import { afterEach, describe, expect, test } from "vitest";
import { captureLogs, type OtelRecorder, withOtelRecorder } from "./_capture";
import { StatementDriver } from "./_fake-driver";

const record = s
  .model({ id: s.string().id(), name: s.string() })
  .map("records");
const schema = { record };

let recorder: OtelRecorder | undefined;
afterEach(async () => {
  await recorder?.dispose();
  recorder = undefined;
});

const names = () => recorder?.spans().map((span) => span.name) ?? [];

describe("the instrumentation holds its own failures", () => {
  test("a tracer that throws when a span starts leaves the call's answer alone", async () => {
    const tracer = {
      startActiveSpan() {
        throw new Error("tracer down");
      },
    };
    const client = createClient({
      schema,
      driver: new StatementDriver(),
    }).$extends(instrumentation({ tracing: { tracer } }));
    expect(await client.record.findMany()).toEqual([
      { id: "record-1", name: "Ada" },
    ]);
  });
});

describe("what is presented", () => {
  test("a client that logs cache events only presents no statement", async () => {
    const logs = captureLogs();
    const client = createClient({
      schema,
      driver: new StatementDriver(),
    }).$extends(instrumentation({ logging: { cache: logs.callback } }));
    await client.record.findMany();
    expect(logs.events).toEqual([]);
  });

  test("a transaction that fails with a value that is no Error fails its span without the value", async () => {
    recorder = withOtelRecorder();
    const client = createClient({
      schema,
      driver: new StatementDriver(),
    }).$extends(instrumentation({ tracing: true }));
    const thrown = await client
      .$transaction(() => Promise.reject("secret detail"))
      .catch((error: unknown) => error);
    expect(thrown).toBe("secret detail");
    const span = recorder.find(SPAN_TRANSACTION);
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.status.message ?? "").not.toContain("secret");
    expect(JSON.stringify(span?.events ?? [])).not.toContain("secret");
  });

  test("a cache unit another extension makes has no cache span and no cache log", async () => {
    recorder = withOtelRecorder();
    const logs = captureLogs();
    let origin: object | undefined;
    const client = createClient({ schema, driver: new StatementDriver() })
      .$extends(
        instrumentation({ tracing: true, logging: { cache: logs.callback } })
      )
      .$extends(
        extension(
          "remember",
          unit(
            (u: UnitContext, next) => {
              origin = u;
              return next();
            },
            ["operation"]
          )
        )
      );
    await client.record.findMany();
    const answer = await work(
      origin!,
      { kind: "cache", operation: "get" },
      async () => "from elsewhere"
    );
    expect(answer).toBe("from elsewhere");
    expect(names().filter((name) => name.startsWith("viborm.cache"))).toEqual(
      []
    );
    expect(logs.events).toEqual([]);
  });

  test("a raw statement sent without parameters discloses an empty list", async () => {
    recorder = withOtelRecorder();
    const logs = captureLogs();
    const client = createClient({
      schema,
      driver: new StatementDriver(),
    }).$extends(
      instrumentation({
        tracing: { includeParams: true },
        logging: { includeParams: true, query: logs.callback },
      })
    );
    await client.$queryRawUnsafe("SELECT 1");
    expect(logs.events.map((event) => event.params)).toEqual([[]]);
  });

  test("a statement another unit handler fails with a plain Error is logged with no batch member", async () => {
    const logs = captureLogs();
    const client = createClient({ schema, driver: new StatementDriver() })
      .$extends(instrumentation({ logging: { error: logs.callback } }))
      .$extends(
        extension(
          "refuse",
          unit(() => {
            throw new Error("refused by a handler");
          }, ["statement"])
        )
      );
    await expect(client.record.findMany()).rejects.toThrow();
    expect(logs.events.length).toBeGreaterThan(0);
    expect(logs.events[0]?.model).toBe("record");
  });
});
