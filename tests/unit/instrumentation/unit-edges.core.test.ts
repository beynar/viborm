/**
 * Units the other instrumentation contracts do not present: a statement unit
 * an extension makes itself (`work`), which sends nothing and so has no
 * parameters, and the shared read of a `findUnique` batch, whose failure its
 * callers recover by each running alone.
 */

import {
  createClient,
  extension,
  s,
  type UnitContext,
  unit,
  work,
} from "@src/index";
import { instrumentation } from "@src/instrumentation/exports";
import { ScriptedDriver } from "@tests/fixtures/drivers/scripted";
import { afterEach, expect, test } from "vitest";
import { captureLogs, type OtelRecorder, withOtelRecorder } from "./_capture";

const record = s.model({ id: s.string().id(), name: s.string() });

let recorder: OtelRecorder | undefined;
afterEach(async () => {
  await recorder?.dispose();
  recorder = undefined;
});

test("a statement unit an extension makes discloses an empty parameter list, and no text", async () => {
  recorder = withOtelRecorder();
  const logs = captureLogs();
  let origin: object | undefined;
  const client = createClient({
    schema: { record },
    driver: new ScriptedDriver("postgresql"),
  })
    .$extends(
      instrumentation({
        tracing: { includeParams: true, includeSql: true },
        logging: { includeParams: true, query: logs.callback },
      })
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
  const before = logs.events.length;
  await expect(
    work(origin!, { kind: "statement", operation: "mine" }, async () => "done")
  ).resolves.toBe("done");
  expect(logs.events.slice(before)).toEqual([
    expect.objectContaining({ level: "query", operation: "mine", params: [] }),
  ]);
  expect(logs.events.at(-1)).not.toHaveProperty("sql", expect.anything());
  const span = recorder.spans().at(-1)!;
  expect(span.name).toBe("viborm.execute");
  expect(span.attributes["db.operation.name"]).toBe("mine");
  expect(span.attributes).not.toHaveProperty("db.query.text");
});

test("the failed shared read of a findUnique batch logs no error: each caller runs alone and is logged", async () => {
  const logs = captureLogs();
  let failed = false;
  const driver = new ScriptedDriver("postgresql", ({ params }) => {
    if (!failed) {
      failed = true;
      throw new Error("shared read failed");
    }
    return [{ id: params[0], name: `name of ${String(params[0])}` }];
  });
  const client = createClient({
    schema: { record },
    driver,
    findUniqueBatching: true,
  }).$extends(
    instrumentation({
      logging: { error: logs.callback, query: logs.callback },
    })
  );
  await expect(
    Promise.all([
      client.record.findUnique({ where: { id: "a" } }),
      client.record.findUnique({ where: { id: "b" } }),
    ])
  ).resolves.toEqual([
    { id: "a", name: "name of a" },
    { id: "b", name: "name of b" },
  ]);
  expect(driver.sent.map(({ params }) => params)).toEqual([
    ['{"a","b"}'],
    ["b"],
    ["a"],
  ]);
  expect(logs.events.map(({ level }) => level)).toEqual(["query", "query"]);
});
