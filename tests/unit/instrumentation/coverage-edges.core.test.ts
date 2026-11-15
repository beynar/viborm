/**
 * The instrumentation on a configuration its other suites do not meet: a
 * logging config that names no level.
 */

import { createClient, s } from "@src/index";
import { instrumentation } from "@src/instrumentation/exports";
import { describe, expect, test } from "vitest";
import { StatementDriver } from "./_fake-driver";

const record = s
  .model({ id: s.string().id(), name: s.string() })
  .map("records");
const schema = { record };

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
