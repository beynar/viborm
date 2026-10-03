import { createClient } from "@client/client";
import { resolvePositionalResultDriver } from "@drivers/positional-result";
import { SQLite3Driver } from "@drivers/sqlite3";
import { QueryError } from "@errors";
import { instrumentation } from "@instrumentation/extension";
import { s } from "@schema";
import { sql } from "@sql";
import { captureLogs } from "@tests/unit/instrumentation/_capture";
import { describe, expect, test } from "vitest";

const entry = s.model({ id: s.int().id() }).map("entries");

describe("SQLite positional transport shares the typed statement lifecycle", () => {
  test.each([
    false,
    true,
  ])("normalizes provider failures and preserves statement observation (instrumented: %s)", async (instrumented) => {
    const driver = new SQLite3Driver();
    const base = createClient({ schema: { entry }, driver });
    const logs = captureLogs();
    const client = instrumented
      ? base.$extends(
          instrumentation({
            logging: { query: logs.callback, error: logs.callback },
          })
        )
      : base;
    try {
      await driver._executeRaw(
        'CREATE TABLE "entries" ("id" INTEGER PRIMARY KEY)'
      );
      await driver._executeRaw('INSERT INTO "entries" VALUES (7)');
      expect(resolvePositionalResultDriver(driver)).toBeTypeOf("function");
      await expect(client.entry.findMany()).resolves.toEqual([{ id: 7 }]);
      const failing = client.$extends({
        name: "invalid-physical-projection",
        statement: () => sql`SELECT missing_column FROM entries`,
      });
      await expect(failing.entry.findMany()).rejects.toBeInstanceOf(QueryError);
      expect(
        logs.events.filter((event) => event.level === "query")
      ).toHaveLength(instrumented ? 1 : 0);
      expect(
        logs.events.filter((event) => event.level === "error")
      ).toHaveLength(instrumented ? 1 : 0);
    } finally {
      await driver.disconnect();
    }
  });

  test("falls back to keyed rows when parser eligibility changes during initialization", async () => {
    const driver = new SQLite3Driver();
    const execute = resolvePositionalResultDriver(driver);
    if (!execute) throw new Error("Expected the stock positional capability");
    try {
      const pending = execute(sql`SELECT 7 AS value`, {
        operation: "findMany",
      });
      Object.defineProperty(driver, "result", {
        value: {},
        configurable: true,
      });
      const response = await pending;
      expect(response).toEqual({
        kind: "borrowed",
        result: { rows: [{ value: 7n }], rowCount: 1 },
      });
      expect(resolvePositionalResultDriver(driver)).toBeUndefined();
    } finally {
      await driver.disconnect();
    }
  });
});
