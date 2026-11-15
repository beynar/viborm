/**
 * Review of the second extension wave (2026-11-14): the instrumentation
 * presents any unit of an unknown kind from its notes (since 33a6e66f3,
 * `presentNoted`). Nothing filters what a note sets on its span: with
 * `includeSql` and `includeParams` off, an extension's note still puts
 * `db.query.text` and `db.query.parameter.*` on a span, under a name of the
 * library's own (`viborm.execute`). The base of the wave (950dbf2a0)
 * presented no span for such a unit.
 *
 * Runs on in-memory SQLite.
 */

import { createClient } from "@drivers/sqlite3";
import { around, extension, note, s, work } from "@src/index";
import {
  type InstrumentationConfig,
  type InstrumentationNote,
  instrumentation,
} from "@src/instrumentation/exports";
import {
  SPAN_CONNECT,
  SPAN_DISCONNECT,
  SPAN_EXECUTE,
  SPAN_OPERATION,
  SPAN_TRANSACTION,
} from "@src/instrumentation/spans";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";
import { captureLogs, type OtelRecorder, withOtelRecorder } from "./_capture";

const post = s.model({ id: s.string().id(), title: s.string() });

let recorder: OtelRecorder | undefined;
afterEach(async () => {
  await recorder?.dispose();
  recorder = undefined;
});

const SQL_TEXT = "db.query.text";
const PARAMETER = /^db\.query\.parameter\./;

describe("a note never discloses what the instrumentation's settings hide", () => {
  test("with includeSql and includeParams off, no span carries SQL text or parameters", async () => {
    recorder = withOtelRecorder();
    const base = createClient({ schema: { post }, dataDir: ":memory:" });
    await syncLiveSchema(base as never);
    const db = base
      .$extends(
        instrumentation({
          tracing: { includeSql: false, includeParams: false },
        })
      )
      .$extends(
        extension(
          "audit",
          around(
            () => (run) =>
              work(
                run,
                {
                  kind: "audit",
                  operation: "record",
                  note: {
                    span: SPAN_EXECUTE,
                    attributes: {
                      [SQL_TEXT]: "SELECT secret FROM post",
                      "db.query.parameter.0": "secret-value",
                    },
                  },
                },
                () => run()
              )
          )
        )
      );
    await db.post.findMany();
    const spans = recorder.spans();
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      const keys = Object.keys(span.attributes);
      expect(keys).not.toContain(SQL_TEXT);
      expect(keys.filter((key) => PARAMETER.test(key))).toEqual([]);
    }
  });
});

/**
 * A client whose `audit` extension emits one unit of its own per call,
 * noted `first` as it starts and `later` before it ends, and notes `onCall`
 * on the call's own operation unit.
 */
async function audited(
  config: InstrumentationConfig,
  first: InstrumentationNote,
  later: InstrumentationNote = {},
  onCall: readonly InstrumentationNote[] = []
) {
  const base = createClient({ schema: { post }, dataDir: ":memory:" });
  await syncLiveSchema(base as never);
  return base.$extends(instrumentation(config)).$extends(
    extension(
      "audit",
      around(() => async (run) => {
        for (const fact of onCall) note(run, fact);
        await work(
          run,
          { kind: "audit", operation: "record", note: first },
          async (own) => {
            note(own, later);
          }
        );
        return run();
      })
    )
  );
}

const STATEMENT_FACTS = {
  [SQL_TEXT]: "SELECT secret FROM post",
  "db.query.summary": "SELECT post",
  "db.query.parameter.0": "secret-value",
  "db.query.parameter.userId": "secret-user",
};

describe("what a note may set on its own unit's span", () => {
  for (const includeSql of [false, true])
    for (const includeParams of [false, true])
      test(`includeSql ${includeSql}, includeParams ${includeParams}: the statement's facts are the library's alone`, async () => {
        recorder = withOtelRecorder();
        const db = await audited(
          { tracing: { includeSql, includeParams } },
          {
            span: "audit.record",
            attributes: { ...STATEMENT_FACTS, "audit.kept": "first" },
          },
          { attributes: { ...STATEMENT_FACTS, "audit.later": "later" } }
        );
        await db.post.findMany();
        const own = recorder.find("audit.record");
        expect(own?.attributes).toMatchObject({
          "audit.kept": "first",
          "audit.later": "later",
        });
        expect(
          Object.keys(own?.attributes ?? {}).filter((key) =>
            key.startsWith("db.query.")
          )
        ).toEqual([]);
        // The library's own statement is disclosed as the settings say.
        const execute = recorder.find(SPAN_EXECUTE);
        expect(execute?.attributes[SQL_TEXT] !== undefined).toBe(includeSql);
      });

  test("a value under an attribute of the extension's own is presented as given: what it holds is its author's to decide", async () => {
    recorder = withOtelRecorder();
    const db = await audited(
      { tracing: { includeSql: false, includeParams: false } },
      { span: "audit.record", attributes: { "audit.user": "secret-user" } }
    );
    await db.post.findMany();
    expect(recorder.find("audit.record")?.attributes["audit.user"]).toBe(
      "secret-user"
    );
  });

  for (const name of [
    SPAN_OPERATION,
    SPAN_EXECUTE,
    SPAN_TRANSACTION,
    SPAN_CONNECT,
    SPAN_DISCONNECT,
  ])
    test(`a note naming ${name} leaves its unit without a span, its logs still presented`, async () => {
      recorder = withOtelRecorder();
      const logs = captureLogs();
      const db = await audited(
        { tracing: true, logging: { cache: logs.callback } },
        {
          span: name,
          attributes: { "audit.kept": "first" },
          log: "cache",
          meta: { event: "hit" },
        }
      );
      await db.post.findMany();
      const spans = recorder.spans();
      expect(spans.filter((span) => span.name === name).length).toBe(
        name === SPAN_OPERATION || name === SPAN_EXECUTE ? 1 : 0
      );
      expect(spans.some((span) => "audit.kept" in span.attributes)).toBe(false);
      expect(logs.events.map((event) => event.meta)).toEqual([
        { event: "hit" },
      ]);
    });

  test("a root note may name viborm.operation: an operation of its own, outside the call's trace", async () => {
    recorder = withOtelRecorder();
    const db = await audited(
      { tracing: true },
      {
        span: SPAN_OPERATION,
        root: true,
        attributes: { "audit.kept": "first" },
      }
    );
    await db.post.findMany();
    const operations = recorder
      .spans()
      .filter((span) => span.name === SPAN_OPERATION);
    expect(operations.length).toBe(2);
    const own = operations.find((span) => "audit.kept" in span.attributes);
    expect(own?.parentSpanContext).toBeUndefined();
  });
});

describe("what a note may log on the call's own operation unit", () => {
  test("a succeeded call gets no error or query log from a note; a cache log is presented", async () => {
    const logs = captureLogs();
    const db = await audited({ logging: { all: logs.callback } }, {}, {}, [
      { log: "error", error: new Error("invented"), meta: { event: "x" } },
      { log: "query", meta: { event: "x" } },
      { log: "cache", meta: { event: "miss" } },
    ]);
    await db.post.findMany();
    expect(logs.events.map((event) => event.level)).toEqual(["query", "cache"]);
    expect(logs.events[1]?.meta).toEqual({ event: "miss" });
  });

  test("on the extension's own unit, an error log is presented, its error sanitized as every log's", async () => {
    const logs = captureLogs();
    const db = await audited(
      { logging: { error: logs.callback } },
      { log: "error", error: new Error("SELECT secret FROM post") }
    );
    await db.post.findMany();
    expect(logs.events.length).toBe(1);
    expect(logs.events[0]?.error?.message).not.toContain("secret");
  });
});
