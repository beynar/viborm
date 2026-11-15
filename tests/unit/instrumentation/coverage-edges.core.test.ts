/**
 * The instrumentation on what its other suites do not meet: a logging config
 * that names no level, and notes on an extension's own unit that carry an
 * unknown log event, no attributes, or are no instrumentation note at all.
 */

import { around, createClient, extension, note, s, work } from "@src/index";
import { instrumentation } from "@src/instrumentation/exports";
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

describe("the instrumentation's configuration", () => {
  test("a logging config that names no level logs nothing, and the client answers as without it", async () => {
    const client = createClient({
      schema,
      driver: new StatementDriver(),
    }).$extends(
      instrumentation({ logging: { includeSql: true, includeParams: true } })
    );
    expect(await client.record.findMany()).toEqual([
      { id: "record-1", name: "Ada" },
    ]);
  });
});

describe("notes on an extension's own unit", () => {
  test("a log metadata event the library does not know is left out; a note without attributes or no object sets none", async () => {
    const logs = captureLogs();
    recorder = withOtelRecorder();
    const client = createClient({
      schema,
      driver: new StatementDriver(),
    })
      .$extends(
        instrumentation({ tracing: true, logging: { cache: logs.callback } })
      )
      .$extends(
        extension(
          "audit",
          around(() => async (run) => {
            await work(
              run,
              {
                kind: "audit",
                operation: "record",
                note: {
                  span: "audit.record",
                  log: "cache",
                  meta: { event: "invented" },
                },
              },
              async (own) => {
                // Another extension's note for a reader of its own.
                note(own, "not an instrumentation note" as never);
                note(own, { log: "cache", meta: { event: "miss" } });
              }
            );
            return run();
          })
        )
      );
    expect(await client.record.findMany()).toEqual([
      { id: "record-1", name: "Ada" },
    ]);
    expect(logs.events.map((event) => event.meta)).toEqual([
      {},
      { event: "miss" },
    ]);
    const span = recorder.find("audit.record");
    expect(span).toBeDefined();
    expect(Object.keys(span!.attributes)).not.toContain("event");
  });
});
