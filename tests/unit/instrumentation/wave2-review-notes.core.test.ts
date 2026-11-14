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
import { around, extension, s, work } from "@src/index";
import { instrumentation } from "@src/instrumentation/exports";
import { SPAN_EXECUTE } from "@src/instrumentation/spans";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";
import { type OtelRecorder, withOtelRecorder } from "./_capture";

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
